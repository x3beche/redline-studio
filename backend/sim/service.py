"""The simulator's sessions: one running virtual board per app (SPEC §5).

An embedded app names its board (`apps.board`); the board's netlist gives
sim.json through `board.describe()`, the app's own `sim` corrections win
over it, the MCU's emulator picks the adapter, and the firmware project
is the one the Embedded room builds (the app's checkout, its `cwd`, and
the `-C <dir>` of its build command). `runtime.Board.run` then pumps the
emulator in a background task until it is stopped.

Limits, so a forgotten or runaway session cannot eat the machine: a few
sessions at once, each stopped after IDLE_S without anyone looking and
after MAX_RUN_S whatever happens, and a UART transcript kept to a tail.

The page and `tools/revisions.py sim` both go through `Sims`; the page
through backend/sim/api.py, the command line with its own instance.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import os
import shlex
import time
from pathlib import Path

from . import board as simboard
from .adapters import ADAPTERS
from .parts import load_catalog
from .runtime import Board

log = logging.getLogger(__name__)

MAX_SESSIONS = int(os.getenv("SIM_MAX_SESSIONS", "3"))
IDLE_S = float(os.getenv("SIM_IDLE_S", "600"))          # nobody watching for this long: stop
MAX_RUN_S = float(os.getenv("SIM_MAX_RUN_S", "3600"))   # one session, at most
KEEP_S = 3600                                           # a stopped session's last state, kept to read
UART_KEEP = 400                                         # transcript entries kept in the board
UART_SHOWN = 200                                        # ... and shown, coalesced
UART_CHARS = 16_000
UART_IN_MAX = 1024                                      # one line typed in
LIVE = ("starting", "building", "running")


class SimError(Exception):
    """Something the person can fix; `status` is the HTTP code it maps to."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ---------------- sim.json for an app ----------------

def firmware_dir(app: dict) -> Path:
    """Where the firmware project is: the Embedded room's workdir
    (repo/cwd, backend/apps.workdir), then the build command's `-C <dir>`
    (`idf.py -C esp32 -B $BUILD build`, `make -C fw`), or `sim_firmware`."""
    base = Path(app["repo"]) / (app.get("cwd") or "")
    if app.get("sim_firmware"):
        return base / app["sim_firmware"]
    try:
        args = shlex.split(app.get("build") or "")
    except ValueError:
        args = []
    for i, a in enumerate(args):
        if a in ("-C", "--project-dir", "--directory") and i + 1 < len(args):
            return base / args[i + 1]
        for flag in ("--project-dir=", "--directory="):
            if a.startswith(flag):
                return base / a[len(flag):]
    return base


def merge(found: dict | None, over: dict | None) -> dict:
    """describe()'s sim.json with the app's hand corrections on top.

    over: {"replace": bool, "mcu": {...}, "parts": [{"ref", ...}], ...}.
    A part entry with a ref already found is merged into it; one with
    `"skip": true` takes the part out; a new ref is added. `replace`
    ignores what describe() found.
    """
    over = over or {}
    base = {"mcu": {}, "parts": [], "skipped": []} if (found is None or over.get("replace")) \
        else copy.deepcopy(found)
    base.setdefault("parts", [])
    base.setdefault("skipped", [])
    if over.get("mcu"):
        base["mcu"] = {**(base.get("mcu") or {}), **over["mcu"]}
    by_ref = {p["ref"]: i for i, p in enumerate(base["parts"])}
    for entry in over.get("parts") or []:
        ref = entry.get("ref")
        if not ref:
            continue
        if entry.get("skip"):
            if ref in by_ref:
                base["parts"][by_ref[ref]] = None
            base["skipped"].append({"ref": ref, "why": "left out by hand"})
            continue
        clean = {k: v for k, v in entry.items() if k != "skip"}
        if ref in by_ref and base["parts"][by_ref[ref]] is not None:
            base["parts"][by_ref[ref]] = {**base["parts"][by_ref[ref]], **clean}
        else:
            by_ref[ref] = len(base["parts"])
            base["parts"].append(clean)
    base["parts"] = [p for p in base["parts"] if p]
    for key, value in over.items():
        if key not in ("replace", "mcu", "parts", "skipped"):
            base[key] = value
    return base


def _mcu_component(graph: dict, catalog: dict) -> dict | None:
    for c in graph.get("components", []):
        for m in catalog.get("mcus", []):
            if simboard._matches(c, m["match"]):
                return c
    return None


async def resolve(db, app_id: str, board: str | None = None, sim: dict | None = None,
                  catalog: dict | None = None) -> dict:
    """Everything a session needs, read from the database.

    board/sim: this run's own link and corrections, over the app's.
    Returns {app, board, sim, firmware, warnings, glb}; raises SimError
    saying what is missing and how to fix it.
    """
    from backend import ato, apps, store

    catalog = catalog or load_catalog()
    app = await db[apps.APPS].find_one({"_id": app_id})
    if not app:
        raise SimError(f"no app {app_id!r}", 404)
    if (app.get("platform") or "web") != "embedded":
        raise SimError(f"{app_id} is a {app.get('platform')} app; only firmware runs on a virtual board")
    over = sim if sim is not None else app.get("sim")
    bid = board or app.get("board")
    warnings: list[str] = []
    found = None
    glb = False
    if not bid and not (over and over.get("replace")):
        ids = [d["_id"] async for d in db[ato.BOARDS].find({}, {"_id": 1})]
        raise SimError(
            f"{app_id} is not linked to a board yet - pick the board it runs on "
            f"(tools/revisions.py sim link {app_id} <board>)"
            + (f"; boards: {', '.join(ids)}" if ids else ""), 409)
    if bid:
        doc = await db[ato.BOARDS].find_one({"_id": bid}, {"artifacts": 1})
        if not doc:
            raise SimError(f"{app_id} is linked to board {bid!r}, which does not exist - link another", 409)
        glb = "model3d" in (doc.get("artifacts") or {})
        try:
            import json
            graph = json.loads(await store.get_artifact(db, bid, "graph", ato.BOARDS))
        except KeyError:
            graph = None
            if not (over and over.get("replace")):
                raise SimError(f"board {bid} has no netlist yet - build it in the PCB room", 409) from None
        if graph is not None and not (over and over.get("replace")):
            mcu = _mcu_component(graph, catalog)
            pins: dict = {}
            code = next(iter(simboard.LCSC.findall(simboard._text(mcu))), None) if mcu else None
            if mcu and not code:
                # No part number on the board (an import without a BOM): the
                # catalog names a symbol for the family's shared pinout.
                entry = next((m for m in catalog.get("mcus", []) if simboard._matches(mcu, m["match"])), {})
                code = entry.get("symbol")
                if code:
                    warnings.append(f"{mcu['ref']} has no part number; its pin names are {code}'s")
            if code:
                try:
                    pins = await simboard.mcu_pin_names(db, code)
                except Exception as exc:                       # noqa: BLE001
                    warnings.append(f"the MCU's pin names ({code}) could not be read: {exc}")
            try:
                found = simboard.describe(graph, pins, catalog)
            except ValueError as exc:
                if not (over and over.get("mcu") and over.get("parts") is not None):
                    raise SimError(f"board {bid}: {exc}. Correct it on the app: "
                                   f"POST /api/sim/{app_id}/link {{\"sim\": {{\"mcu\": ..., \"parts\": [...]}}}}",
                                   409) from None
                warnings.append(f"board {bid}: {exc}; running the app's own sim.json")
    out = merge(found, over)
    for p in list(out["parts"]):
        if p.get("model") not in catalog["models"]:
            out["parts"].remove(p)
            out["skipped"].append({"ref": p.get("ref"), "why": f"no model {p.get('model')!r} in the catalog"})
    return {"app": app, "board": bid, "sim": out, "firmware": firmware_dir(app),
            "warnings": warnings, "glb": glb}


def models_of(sim: dict, catalog: dict) -> dict:
    """What the page needs to draw each part: its model, block and view hints."""
    out = {}
    for p in sim.get("parts", []):
        m = catalog["models"].get(p.get("model"), {})
        out[p["ref"]] = {"model": p.get("model"), "block": m.get("block") or "code",
                         "view": m.get("view") or {}}
    return out


# ---------------- sessions ----------------

class _Watched:
    """The adapter, with the session told when it has booted and deaf once stopped."""

    def __init__(self, inner, session: "Session"):
        self.inner, self.session, self.name = inner, session, getattr(inner, "name", "?")
        self.closed = False
        self._lock = asyncio.Lock()

    async def start(self, firmware, board):
        self.session.state = "building"
        await self.inner.start(firmware, board)
        if self.session.state == "building":
            self.session.state = "running"
            self.session.booted = time.time()

    def events(self):
        return self.inner.events()

    async def send(self, msg):
        if not self.closed:
            await self.inner.send(msg)

    async def stop(self):
        async with self._lock:
            if self.closed:
                return
            self.closed = True
            await self.inner.stop()


class Session:
    def __init__(self, app_id: str, sim: dict, firmware: Path, adapter, board_id: str | None = None,
                 warnings: list | None = None, catalog: dict | None = None):
        self.app, self.sim, self.firmware, self.board_id = app_id, sim, Path(firmware), board_id
        self.catalog = catalog or load_catalog()
        self.board = Board(sim, self.catalog)
        self.adapter = _Watched(adapter, self)
        self.state = "starting"
        self.error: str | None = None
        self.warnings = list(warnings or [])
        self.started = time.time()
        self.booted: float | None = None
        self.ended: float | None = None
        self.seen = time.monotonic()
        self.stopping = False
        self.task: asyncio.Task | None = None
        self.uart_keep = UART_KEEP

    def touch(self) -> None:
        self.seen = time.monotonic()

    @property
    def live(self) -> bool:
        return self.state in LIVE

    async def _run(self) -> None:
        try:
            await self.board.run(self.adapter, self.firmware)
            if not self.stopping:
                self.error = self.error or "the emulator stopped by itself"
                self.state = "failed"
        except asyncio.CancelledError:
            pass
        except Exception as exc:                               # noqa: BLE001
            log.warning("sim %s: %s", self.app, exc)
            self.error = str(exc)[-3000:]
            self.state = "failed"
        finally:
            if self.state in LIVE:
                self.state = "stopped"
            self.ended = time.time()
            try:
                await self.adapter.stop()
            except Exception:                                  # noqa: BLE001
                log.exception("sim %s: stopping the adapter", self.app)

    def launch(self) -> None:
        self.task = asyncio.create_task(self._run(), name=f"sim:{self.app}")

    async def stop(self, why: str | None = None) -> None:
        self.stopping = True
        if why and not self.error:
            self.error = why
        if self.state == "running":
            # A clean end: the adapter's events stop, Board.run winds down.
            try:
                await asyncio.wait_for(self.adapter.stop(), 60)
            except Exception:                                  # noqa: BLE001
                log.exception("sim %s: stop", self.app)
        if self.task and not self.task.done():
            try:
                if self.state != "running":
                    raise asyncio.TimeoutError     # still building or booting: nothing to wind down
                await asyncio.wait_for(asyncio.shield(self.task), 10)
            except (asyncio.TimeoutError, Exception):          # noqa: BLE001
                self.task.cancel()
                try:
                    await self.task
                except BaseException:                          # noqa: BLE001
                    pass
        if self.state in LIVE:
            self.state = "stopped"

    def act(self, ref: str, action: dict) -> None:
        if ref not in self.board.parts:
            raise SimError(f"no part {ref!r} on this board (there are {', '.join(self.board.parts) or 'none'})", 404)
        if not isinstance(action, dict) or not action:
            raise SimError('an action is an object: {"press": true}, {"value": 23.5}')
        self.board.act(ref, action)

    def uart(self, port: str, text: str) -> None:
        if len(text) > UART_IN_MAX:
            raise SimError(f"at most {UART_IN_MAX} characters at a time")
        self.board.write_uart(port or "UART0", text)

    def trim(self) -> None:
        if len(self.board.uart) > self.uart_keep:
            del self.board.uart[:-self.uart_keep]

    def snapshot(self) -> dict:
        snap = self.board.snapshot()
        return {"state": self.state, "error": self.error, "t": snap["t"], "parts": snap["parts"],
                "uart": coalesce(snap["uart"]), "started": self.started, "booted": self.booted}


def coalesce(entries: list[dict]) -> list[dict]:
    """The transcript as the page shows it: runs from one side of one port
    joined into one entry, the tail only."""
    out: list[dict] = []
    for e in entries:
        if out and out[-1]["port"] == e["port"] and out[-1]["dir"] == e["dir"]:
            out[-1] = {**out[-1], "data": out[-1]["data"] + e["data"]}
        else:
            out.append(dict(e))
    out = out[-UART_SHOWN:]
    total = 0
    for i in range(len(out) - 1, -1, -1):
        total += len(out[i]["data"])
        if total > UART_CHARS:
            out[i] = {**out[i], "data": out[i]["data"][-(UART_CHARS - (total - len(out[i]["data"]))):]}
            out = out[i:]
            break
    return out


class Sims:
    """The sessions of one process, keyed by app id."""

    def __init__(self, adapters: dict | None = None, max_sessions: int = MAX_SESSIONS,
                 idle_s: float = IDLE_S, max_run_s: float = MAX_RUN_S, uart_keep: int = UART_KEEP):
        self.uart_keep = uart_keep
        self.adapters = adapters if adapters is not None else ADAPTERS
        self.max_sessions, self.idle_s, self.max_run_s = max_sessions, idle_s, max_run_s
        self.sessions: dict[str, Session] = {}
        self._watchdog: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    def get(self, app_id: str) -> Session | None:
        return self.sessions.get(app_id)

    def adapter_for(self, sim: dict):
        emulator = (sim.get("mcu") or {}).get("emulator")
        if emulator not in self.adapters:
            family = (sim.get("mcu") or {}).get("family") or "?"
            raise SimError(f"no simulator for {emulator or 'this MCU'} yet (MCU family {family}); "
                           f"there is one for: {', '.join(self.adapters) or 'nothing'}", 409)
        return self.adapters[emulator]()

    async def start(self, db, app_id: str, board: str | None = None, sim: dict | None = None) -> Session:
        got = await resolve(db, app_id, board, sim)
        return await self.launch(app_id, got["sim"], got["firmware"], board_id=got["board"],
                                 warnings=got["warnings"])

    async def launch(self, app_id: str, sim: dict, firmware: Path, board_id: str | None = None,
                     warnings: list | None = None) -> Session:
        """A session for this sim.json and firmware; the old one of this app goes first."""
        adapter = self.adapter_for(sim)
        async with self._lock:
            old = self.sessions.get(app_id)
            if old and old.live:
                await old.stop("restarted")
            running = [s.app for s in self.sessions.values() if s.live]
            if len(running) >= self.max_sessions:
                raise SimError(f"{len(running)} simulations are already running ({', '.join(running)}); "
                               "stop one first", 429)
            s = Session(app_id, sim, firmware, adapter, board_id, warnings)
            s.uart_keep = self.uart_keep
            self.sessions[app_id] = s
            s.launch()
        self._ensure_watchdog()
        return s

    async def stop(self, app_id: str) -> Session | None:
        s = self.sessions.get(app_id)
        if s:
            await s.stop()
        return s

    def live(self, app_id: str) -> Session:
        s = self.sessions.get(app_id)
        if not s or not s.live:
            raise SimError(f"{app_id} is not running - start it first", 409)
        s.touch()
        return s

    def act(self, app_id: str, ref: str, action: dict) -> None:
        self.live(app_id).act(ref, action)

    def uart(self, app_id: str, port: str, text: str) -> None:
        self.live(app_id).uart(port, text)

    def snapshot(self, app_id: str, touch: bool = True) -> dict:
        s = self.sessions.get(app_id)
        if not s:
            return {"state": "idle", "error": None, "t": 0, "parts": {}, "uart": []}
        if touch:
            s.touch()
        return s.snapshot()

    async def sweep(self) -> None:
        """One round of the limits: idle sessions, sessions run too long, old ones."""
        now = time.monotonic()
        for app_id, s in list(self.sessions.items()):
            s.trim()
            if s.live and now - s.seen > self.idle_s:
                await s.stop(f"stopped: nobody watched it for {self.idle_s / 60:.0f} min")
            elif s.live and time.time() - s.started > self.max_run_s:
                await s.stop(f"stopped: a session runs at most {self.max_run_s / 60:.0f} min")
            elif not s.live and s.ended and time.time() - s.ended > KEEP_S:
                self.sessions.pop(app_id, None)

    def _ensure_watchdog(self) -> None:
        if self._watchdog and not self._watchdog.done():
            return

        async def loop():
            while any(s.live for s in self.sessions.values()):
                await asyncio.sleep(5)
                try:
                    await self.sweep()
                except Exception:                              # noqa: BLE001
                    log.exception("sim watchdog")

        self._watchdog = asyncio.create_task(loop(), name="sim:watchdog")

    async def shutdown(self) -> None:
        for s in list(self.sessions.values()):
            if s.live:
                await s.stop("the server stopped")


SIMS = Sims()


# ---------------- pictures ----------------

def screen_png(view: dict, scale: int = 4, on=(143, 211, 255), off=(0, 0, 0)) -> bytes:
    """A part's `screen` view ({w, h, bits: base64, rows MSB first}) as a PNG."""
    import base64
    import struct
    import zlib

    scr = view.get("screen") if "screen" in view else view
    w, h = int(scr["w"]), int(scr["h"])
    bits, stride = base64.b64decode(scr["bits"]), (int(scr["w"]) + 7) // 8
    rows = bytearray()
    for y in range(h):
        line = bytearray()
        for x in range(w):
            lit = bits[y * stride + (x >> 3)] & (0x80 >> (x & 7))
            line += bytes(on if lit else off) * scale
        rows += (b"\0" + bytes(line)) * scale

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w * scale, h * scale, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 6)) + chunk(b"IEND", b""))


def describe_view(view: dict) -> str:
    """One part's view as a line of text."""
    if "screen" in view:
        import base64
        scr = view["screen"]
        lit = sum(bin(b).count("1") for b in base64.b64decode(scr["bits"]))
        return f"screen {scr['w']}x{scr['h']}, {lit} pixels lit"
    if "sliders" in view:
        return ", ".join(f"{k} {v.get('value')}{v.get('unit', '')}" for k, v in view["sliders"].items())
    return "  ".join(f"{k} {v}" for k, v in view.items())
