"""Parts, from LCSC.

A netlist names parts; it does not carry their shape. atopile used to ask
its own service for that and the service is gone, so the shape comes from
where the part is actually bought: EasyEDA publishes the footprint and the
3D model for every LCSC part, and `easyeda2kicad` turns both into KiCad's
own formats.

Fetched once and kept. A part number means the same thing tomorrow as it
did today, so asking twice is just being slow - and a board that is
rebuilt ten times should not hit somebody else's API ten times.

The 3D model matters more than it sounds: without one a board renders as
bare copper with nothing standing on it, which is not what anybody means
by a picture of the board.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from . import store

PARTS = "parts"
TIMEOUT = 90
# Their service, so it is asked politely and named honestly. The
# "compatible" prefix is for their image host, which holds a request
# without a browser-shaped agent open until it times out - ninety seconds
# for a 35 kB photo - while the same request with it takes one.
AGENT = "Mozilla/5.0 (compatible; redline/1.0; board room)"

# Lives with atopile, in its own environment.
# Where easyeda2kicad was looked for before backend/atoenv.py; kept for
# anything that still reads it. The download finds it with atoenv.easyeda().
TOOL = os.environ.get(
    "REDLINE_EASYEDA", str(Path(__file__).resolve().parent.parent.parent.parent
                      / ".venv-ato" / "bin" / "easyeda2kicad"))

LCSC_ID = re.compile(r"^C\d{3,10}$")


def looks_like_a_part(text: str | None) -> bool:
    """LCSC numbers are C followed by digits, and nothing else is."""
    return bool(text and LCSC_ID.match(text.strip()))


async def _run(args: list[str], cwd: Path) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        raise TimeoutError(f"{args[0]} did not answer in {TIMEOUT}s")
    return proc.returncode, out.decode(errors="replace")


# EasyEDA's own catalogue search, which is LCSC's. The part numbers it
# gives back are the ones `fetch` takes, so a search result is one click
# from a footprint and a 3D model.
SEARCH = "https://easyeda.com/api/eda/product/list"


# ---- asking politely, and writing down every ask ---------------------------
#
# These are EasyEDA's own endpoints, public but not a promised API, and a
# burst of them gets turned away: ten previews in a few seconds and the
# component endpoint answered 403 for minutes; thirty-three searches at
# one a second and the search endpoint did too. So every request waits
# its turn, and a 403 or 429 stops all of them for a while rather than
# retrying into it. Anything already looked at is on disk and asks nothing.
#
# The page's server and an agent's command line are two processes asking
# the same service, so the turn-taking and the refusal live in a file both
# of them lock - kept apart in memory, each would go on asking after the
# other had been told to stop. And every ask is written to a journal the
# page shows, so what the agents are doing to LCSC is something you can
# watch rather than infer.

import contextvars
import fcntl
import sys
import time as _time

GAP = float(os.environ.get("REDLINE_LCSC_GAP", "2.5"))        # seconds between asks
COOL_OFF = 600                                           # after being refused
# Spacing alone does not keep EasyEDA happy. The journal's two refusals:
# 42 searches in 71 s, and 35 asks spread over 220 s - one every 6 s. So
# it is a count, not a rate, and asks are budgeted: this many in any
# window this long, across every process, then nothing is sent until the
# window moves on.
BUDGET = int(os.environ.get("REDLINE_LCSC_BUDGET", "25"))
WINDOW = 300
KEEP_LINES = 1000                                        # journal length

# Who is asking: the page (through the server), an agent (the command line
# or curl), or the passives builder. The server sets it per request.
_DEFAULT_WHO = {"revisions.py": "agent", "passives.py": "passives"}.get(
    Path(sys.argv[0]).name if sys.argv else "", "page")
WHO: contextvars.ContextVar[str] = contextvars.ContextVar("who", default=_DEFAULT_WHO)
# Whether a spent budget means "wait for it" or "say so now". The page
# answers someone looking at it, so it says so. An agent fetching twenty
# parts for a board would rather wait twelve minutes than get eight.
PATIENT: contextvars.ContextVar[bool] = contextvars.ContextVar("patient", default=False)


class Refused(OSError):
    """EasyEDA turned requests away; say when to try again, do not retry."""


def _files() -> tuple[Path, Path, Path]:
    LOOK.mkdir(parents=True, exist_ok=True)
    return LOOK / "_state.json", LOOK / "_state.lock", LOOK / "requests.jsonl"


def _locked(fn):
    """Run fn(state) with the shared state file held; returns fn's result."""
    state_path, lock_path, _ = _files()
    with open(lock_path, "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            state = json.loads(state_path.read_text()) if state_path.exists() else {}
        except (OSError, ValueError):
            state = {}
        out = fn(state)
        state_path.write_text(json.dumps(state))
        return out


def state() -> dict:
    """The turn-taking as it stands: for the page's status line."""
    now = _time.time()
    s = _locked(lambda st: dict(st))
    until = s.get("refused_until") or 0
    recent = [t for t in s.get("asks", []) if t > now - WINDOW]
    return {"gap_s": GAP, "cool_off_s": COOL_OFF, "now": now,
            "refused_until": until if until > now else None,
            "refused_why": s.get("refused_why") if until > now else None,
            "last_ask": s.get("last"),
            "budget": BUDGET, "window_s": WINDOW, "used": len(recent)}


def _record(kind: str, target: str, source: str, *, url: str = "",
            status: int | None = None, ms: float = 0, size: int = 0,
            error: str | None = None, via: str | None = None) -> None:
    """One line in the journal. Never fails the request it describes.
    `via`: "direct" or "proxy" for an ask that went out (netproxy.py)."""
    row = {"at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
           "who": WHO.get(), "kind": kind, "target": target, "source": source,
           "url": url, "status": status, "ms": round(ms), "bytes": size,
           "error": error}
    if via:
        row["via"] = via
    try:
        _, lock_path, journal = _files()
        with open(lock_path, "a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with open(journal, "a") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
            if journal.stat().st_size > KEEP_LINES * 600:
                lines = journal.read_text().splitlines()[-KEEP_LINES:]
                journal.write_text("\n".join(lines) + "\n")
    except OSError:
        pass


def journal(limit: int = 200) -> list[dict]:
    """The most recent asks, newest first."""
    _, _, path = _files()
    try:
        lines = path.read_text().splitlines()[-limit:]
    except OSError:
        return []
    out = []
    for line in reversed(lines):
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


# Whether the request on this thread goes through the proxy (netproxy.py).
# A thread-local, because the requests run in the executor's threads and a
# context variable does not follow them there.
import threading as _threading
_NET = _threading.local()


def _via() -> bool:
    return bool(getattr(_NET, "via", False))


def _session() -> str | None:
    return getattr(_NET, "session", None)


def _through(via: bool, fn, *args):
    """Run one request on this thread, directly or through the proxy. Through
    the proxy it gets a session of its own - a new exit address, held for
    this lookup - and, when asked, that address is looked up afterwards.
    Returns (result, meta); an exception carries its meta as `.net_meta`."""
    from . import netproxy
    meta: dict = {}
    _NET.via = via
    _NET.session = netproxy.new_session() if via else None
    meta["session"] = _NET.session
    try:
        out = fn(*args)
    except Exception as exc:
        meta["exit"] = netproxy.exit_info(_NET.session) if via else None
        exc.net_meta = meta
        raise
    else:
        meta["exit"] = netproxy.exit_info(_NET.session) if via else None
        return out, meta
    finally:
        _NET.via = False
        _NET.session = None


def _open(req, timeout: float):
    from . import netproxy
    return netproxy.opener(_via(), _session()).open(req, timeout=timeout)


async def _polite(kind: str, target: str, url: str, fn, *args, weight: int = 1):
    """One request: its turn, the request, and a line in the journal."""
    import urllib.error

    def claim(st: dict):
        now = _time.time()
        if now < (st.get("refused_until") or 0):
            return ("refused", st["refused_until"] - now)
        recent = [t for t in st.get("asks", []) if t > now - WINDOW]
        if len(recent) + weight > BUDGET:
            st["asks"] = recent
            return ("budget", recent[0] + WINDOW - now)
        wait = max(0.0, (st.get("last") or 0) + GAP - now)
        # A heavy ask (a download that is several requests inside) takes
        # its weight in slots from the budget and pushes the next ask back.
        st["last"] = now + wait + GAP * (weight - 1)
        st["asks"] = recent + [now + wait] * weight
        return ("go", wait)

    verdict, wait = await asyncio.get_running_loop().run_in_executor(None, _locked, claim)
    waited = 0.0
    while verdict == "budget" and PATIENT.get():
        if not waited:
            _record(kind, target, "wait", url=url,
                    error=f"budget spent - waiting {int(wait) + 1} s for it")
        await asyncio.sleep(min(wait + 0.5, 30))
        waited += min(wait + 0.5, 30)
        verdict, wait = await asyncio.get_running_loop().run_in_executor(None, _locked, claim)
    if verdict == "refused":
        _record(kind, target, "refused", url=url,
                error=f"cooling off, {int(wait // 60) + 1} min left")
        raise Refused(f"EasyEDA is turning requests away; parts already looked "
                      f"at still work, new ones in {int(wait // 60) + 1} min")
    if verdict == "budget":
        _record(kind, target, "refused", url=url,
                error=f"budget: {BUDGET} asks per {WINDOW // 60} min spent, "
                      f"next in {int(wait) + 1} s")
        raise Refused(f"{BUDGET} asks in {WINDOW // 60} minutes is all EasyEDA is "
                      f"asked for; the next one can go in {int(wait) + 1} s")
    if wait:
        await asyncio.sleep(wait)

    from . import netproxy

    loop = asyncio.get_running_loop()
    always = netproxy.mode() == "always"

    def note(via: str, t0: float, *, status=None, size=0, error=None, meta=None, attempt="first"):
        """The ask in the journal (the page's list) and in the proxy log (Settings > Proxy)."""
        ms = (_time.monotonic() - t0) * 1000
        _record(kind, target, "net", url=url, via=via, status=status, ms=ms, size=size, error=error)
        netproxy.log({"kind": kind, "target": target, "via": via, "status": status, "ms": round(ms),
                      "bytes": size, "error": error, "attempt": attempt, "who": WHO.get(),
                      "session": (meta or {}).get("session"), "exit": (meta or {}).get("exit")})

    async def attempt(via_proxy: bool):
        return await loop.run_in_executor(None, _through, via_proxy, fn, *args)

    via = "proxy" if always else "direct"
    how = "first"
    t0 = _time.monotonic()
    try:
        try:
            out, meta = await attempt(always)
        except urllib.error.HTTPError as first:
            # Turned away at this address: with a fallback proxy set, the
            # same ask goes once more through it before anyone cools off.
            if first.code not in (403, 429) or always or netproxy.mode() != "fallback":
                raise
            note("direct", t0, status=first.code, error="refused here - asking through the proxy",
                 meta=getattr(first, "net_meta", None))
            via, how = "proxy", "fallback"
            t0 = _time.monotonic()
            out, meta = await attempt(True)
    except urllib.error.HTTPError as exc:
        meta = getattr(exc, "net_meta", None)
        if exc.code in (403, 429):
            why = f"EasyEDA said {exc.code} to {kind} {target}"

            def refuse(st: dict):
                st["refused_until"] = _time.time() + COOL_OFF
                st["refused_why"] = why
            await asyncio.get_running_loop().run_in_executor(None, _locked, refuse)
            note(via, t0, status=exc.code, meta=meta, attempt=how,
                 error=f"refused - nobody asks again for {COOL_OFF // 60} min")
            raise Refused(f"{why}; not asking again for {COOL_OFF // 60} minutes") from exc
        note(via, t0, status=exc.code, error=str(exc), meta=meta, attempt=how)
        raise
    except Exception as exc:
        note(via, t0, error=f"{type(exc).__name__}: {exc}"[:200], meta=getattr(exc, "net_meta", None), attempt=how)
        raise
    if isinstance(out, tuple):
        # A download reports (return code, log): a failed one is written
        # down as failed, not as a 200 it never got.
        rc, log = out
        note(via, t0, status=200 if rc == 0 else None, meta=meta, attempt=how,
             error=None if rc == 0 else log.strip()[-200:])
        return out
    size = len(out) if isinstance(out, (bytes, bytearray)) else \
        len(json.dumps(out)) if out is not None else 0
    note(via, t0, status=200, size=size, meta=meta, attempt=how)
    return out


def _ask(url: str) -> dict:
    """One GET, blocking. Its own function so a test can stand in for it
    rather than calling somebody else's service."""
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with _open(req, TIMEOUT) as r:
        return json.loads(r.read().decode(errors="replace"))


async def search(term: str, limit: int = 20) -> list[dict]:
    """Look for a part by name, package, manufacturer - or by number.

    Returns what a person needs to choose between two capacitors: the
    number to order, what it is, how it is packaged, and whether anybody
    has it in stock. Not the footprint - that is a download, and it
    happens when one is picked.
    """
    import urllib.parse

    term = (term or "").strip()
    if not term:
        return []

    url = (f"{SEARCH}?keyword={urllib.parse.quote(term)}"
           f"&page=1&pageSize={max(1, min(limit, 50))}")
    body = await _polite("search", term, url, _ask, url)
    rows = ((body or {}).get("result") or {}).get("productList") or []

    out = []
    for row in rows:
        price = None
        for band in row.get("price") or []:
            # [quantity, price, price with tax] - the first band is one-off.
            if len(band) >= 2:
                try:
                    price = float(band[1])
                except (TypeError, ValueError):
                    price = None
                break
        out.append({
            "lcsc": row.get("number"),
            "mpn": row.get("mpn"),
            "package": row.get("package"),
            "maker": row.get("manufacturer"),
            "stock": row.get("stock"),
            "price": price,
        })
    return [r for r in out if looks_like_a_part(r["lcsc"])]


# ---- a look before buying ------------------------------------------------
#
# Everything a person needs to decide on a part - what it is, its
# footprint, its symbol, its 3D shape, a photo - is public on EasyEDA and
# none of it has to be kept to be looked at. So it is fetched on click,
# through here rather than from the browser, and kept on disk: a part
# number means the same thing tomorrow, and this is a preview, not a part
# of anything, so it has no business in the database.

COMPONENT = "https://easyeda.com/api/products/{}/components?version=6.4.19.5"
SVGS = "https://easyeda.com/api/products/{}/svgs"
OBJ = "https://modules.easyeda.com/3dmodel/{}"

LOOK = Path(os.environ.get(
    "REDLINE_LCSC_CACHE",
    Path(__file__).resolve().parent.parent / ".cache" / "lcsc"))

# EasyEDA's own numbering for the two drawings it keeps per part.
SYMBOL, FOOTPRINT = 2, 4


def _get_bytes(url: str) -> bytes:
    import urllib.request

    if url.startswith("//"):
        url = "https:" + url
    req = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with _open(req, TIMEOUT) as r:
        return r.read()


_KINDS = {"component.json": "component", "svgs.json": "drawings",
          "model.obj": "3d model", "photo.jpg": "photo"}


async def _kept(lcsc: str, name: str, url: str, fresh: bool = False) -> bytes:
    """One file about a part: from disk if it has been looked at before
    (`fresh`: asked again, and the copy on disk replaced)."""
    if not looks_like_a_part(lcsc):
        raise ValueError(f"{lcsc!r} is not an LCSC part number")
    path = LOOK / lcsc.strip() / name
    kind = _KINDS.get(name, name)
    try:
        if path.exists() and not fresh:
            blob = path.read_bytes()
            _record(kind, lcsc.strip(), "disk", size=len(blob))
            return blob
    except OSError:
        pass
    blob = await _polite(kind, lcsc.strip(), url, _get_bytes, url)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(blob)
        tmp.replace(path)
    except OSError:
        pass
    return blob


async def _component(lcsc: str, fresh: bool = False) -> dict:
    raw = await _kept(lcsc, "component.json", COMPONENT.format(lcsc), fresh)
    body = json.loads(raw.decode(errors="replace"))
    if not body.get("success") or not body.get("result"):
        raise LookupError(f"{lcsc}: EasyEDA does not know this part")
    return body["result"]


def _model_of(component: dict) -> tuple[str | None, str | None]:
    """The 3D model's id and name, from inside the footprint.

    EasyEDA keeps it as one node among the footprint's shapes - a JSON
    blob after `SVGNODE~`, tagged `outline3D`.
    """
    shapes = ((component.get("packageDetail") or {}).get("dataStr") or {}) \
        .get("shape") or []
    for shape in shapes:
        if not shape.startswith("SVGNODE~"):
            continue
        try:
            attrs = json.loads(shape[len("SVGNODE~"):]).get("attrs") or {}
        except ValueError:
            continue
        if attrs.get("c_etype") == "outline3D" and attrs.get("uuid"):
            return attrs["uuid"], attrs.get("title")
    return None, None


async def preview(lcsc: str) -> dict:
    """What a part is, for somebody choosing one.

    The drawings, the model and the photo are separate requests so the
    page can show the facts at once and let the 3.8 MB model arrive when
    it arrives.
    """
    c = await _component(lcsc)
    para = ((c.get("dataStr") or {}).get("head") or {}).get("c_para") or {}
    shop = c.get("lcsc") or {}
    photo = (c.get("szlcsc") or {}).get("image")
    model_id, model_name = _model_of(c)
    return {
        "lcsc": lcsc,
        "name": c.get("title") or para.get("name"),
        "description": c.get("description") or "",
        "maker": para.get("Manufacturer"),
        "mpn": para.get("Manufacturer Part"),
        "package": para.get("package")
                   or (c.get("packageDetail") or {}).get("title"),
        # JLCPCB assembles "Basic" parts without a loading fee; an
        # "Extended" one costs a feeder per board run. It decides between
        # two otherwise equal parts more often than price does.
        "jlc_class": para.get("JLCPCB Part Class"),
        "price": shop.get("price"),
        "stock": shop.get("stock"),
        "min": shop.get("min"),
        "url": shop.get("url"),
        "has_photo": bool(photo),
        "has_model": bool(model_id),
        "model_name": model_name,
    }


async def drawing(lcsc: str, which: int) -> bytes:
    """The symbol or the footprint, as the SVG EasyEDA draws it."""
    raw = await _kept(lcsc, "svgs.json", SVGS.format(lcsc))
    body = json.loads(raw.decode(errors="replace"))
    for row in body.get("result") or []:
        if row.get("docType") == which and row.get("svg"):
            return row["svg"].encode()
    raise LookupError(f"{lcsc}: no drawing of that kind")


async def model_obj(lcsc: str) -> bytes:
    """The 3D shape, as the OBJ EasyEDA keeps it - materials inline."""
    model_id, _ = _model_of(await _component(lcsc))
    if not model_id:
        raise LookupError(f"{lcsc}: no 3D model")
    return await _kept(lcsc, "model.obj", OBJ.format(model_id))


# ---- a part, as a board's source needs it --------------------------------
#
# A board is written in atopile, and every pin is a line: `signal PA9 ~
# pin 17`. Written from memory that is a guess per pin, and the guesses
# are wrong in the way that costs a board spin. The pin list is already
# in the part's EasyEDA symbol - numbers and names both - so it is read
# from there, and the component block is written from it.


def _symbol_pins(shapes: list[str]) -> list[dict]:
    """Pins out of an EasyEDA symbol.

    A pin is one `P~...` string of `^^`-separated segments: the first holds
    the electrical type, the fourth its name as drawn, the fifth its
    number as drawn - the pad it lands on.
    """
    out = []
    for shape in shapes:
        if not shape.startswith("P~"):
            continue
        parts = shape.split("^^")
        head = parts[0].split("~")
        try:
            name = parts[3].split("~")[4]
            number = parts[4].split("~")[4]
        except IndexError:
            continue
        out.append({"number": number.strip(), "name": name.strip(),
                    "electric": head[2] if len(head) > 2 else ""})
    return out


async def pins(lcsc: str) -> list[dict]:
    """Every pin of a part, by the number it has on the footprint.

    Parts drawn as several symbols (a dual op-amp, a relay) carry the
    others as subparts; they are all read, and a pin that appears twice
    is listed once.
    """
    c = await _component(lcsc)
    shapes = list((c.get("dataStr") or {}).get("shape") or [])
    for sub in c.get("subparts") or []:
        shapes += (sub.get("dataStr") or {}).get("shape") or []
    seen, out = set(), []
    for pin in _symbol_pins(shapes):
        if pin["number"] in seen:
            continue
        seen.add(pin["number"])
        out.append(pin)

    def order(p: dict):
        n = p["number"]
        return (0, int(n), "") if n.isdigit() else (1, 0, n)
    return sorted(out, key=order)


def _ident(text: str, fallback: str) -> str:
    """A pin or part name as an atopile identifier: PB8-BOOT0 -> PB8_BOOT0.

    The signs carry meaning and are spelled out before anything is
    stripped: UD+ and UD- are the two halves of a USB pair, and reduced to
    "UD" they became one signal - D+ shorted to D-.
    """
    text = (text or "").strip()
    text = re.sub(r"\+$", "P", text)            # UD+   -> UDP
    text = re.sub(r"-$", "N", text)              # UD-   -> UDN
    text = text.replace("+", "P")               # VBAT+ -> VBATP
    text = re.sub(r"^[~/!]", "n", text)          # ~RST  -> nRST
    text = re.sub(r"#$", "_N", text)             # RST#  -> RST_N
    out = re.sub(r"[^A-Za-z0-9_]", "_", text).strip("_")
    out = re.sub(r"_+", "_", out)
    if not out:
        out = fallback
    return out if not out[0].isdigit() else f"p{out}"


async def ato_component(lcsc: str) -> str:
    """The part as an atopile component block, ready to paste.

    Pins that share a name - three GNDs, two VDDs - become one signal on
    several pins, which is what they are.
    """
    c = await _component(lcsc)
    para = ((c.get("dataStr") or {}).get("head") or {}).get("c_para") or {}
    package = (c.get("packageDetail") or {}).get("title") or para.get("package") or ""
    name = _ident(para.get("Manufacturer Part") or c.get("title") or lcsc, lcsc)

    lines = [f"component {name}:",
             f"    # {lcsc} · {para.get('Manufacturer') or '?'} · "
             f"{para.get('JLCPCB Part Class') or 'class unknown'}",
             f'    footprint = "{package}"',
             f'    mpn = "{lcsc}"']
    # Only pins with the same name share a signal - three GNDs are one
    # net. Two different names that come out as the same identifier are
    # two signals, and each gets its pin number to tell them apart.
    by_raw: dict[str, str] = {}
    taken: dict[str, str] = {}
    for pin in await pins(lcsc):
        raw = pin["name"].strip()
        sig = _ident(raw, f"p{pin['number']}")
        # A pin named NC is not connected to anything - and several of
        # them are not connected to each other either.
        if sig.upper() in ("NC", "N_C", "DNC"):
            lines.append(f"    signal NC_{pin['number']} ~ pin {pin['number']}")
            continue
        if raw in by_raw:
            lines.append(f"    {by_raw[raw]} ~ pin {pin['number']}")
            continue
        if sig in taken and taken[sig] != raw:
            sig = f"{sig}_{_ident(pin['number'], 'x')}"
        by_raw[raw] = sig
        taken[sig] = raw
        lines.append(f"    signal {sig} ~ pin {pin['number']}")
    return "\n".join(lines) + "\n"


PASSIVES = Path(__file__).resolve().parent / "passives.json"


# A value as people write it: 0.1u, 100n, 100nF, 0u1, 4k7, 4.7K, 2R2, 18pf,
# 22uF/6.3V, 10 kΩ. The number, a multiplier (or one in place of the
# decimal point, as in 4k7), the rest of the number, then a unit and
# anything after it (a voltage, a tolerance), which says nothing about the
# value.
_VALUE = re.compile(r"^\s*(\d+(?:[.,]\d+)?|[.,]\d+)\s*(meg|[pnuµμmkKMRrΩ])?(\d+)?\s*"
                    r"(?:[FfHh]|ohms?|Ω)?(?![A-Za-z0-9])")
_MULT = {"p": 1e-12, "n": 1e-9, "u": 1e-6, "µ": 1e-6, "μ": 1e-6, "m": 1e-3, "": 1.0,
         "r": 1.0, "R": 1.0, "Ω": 1.0, "k": 1e3, "K": 1e3, "M": 1e6, "meg": 1e6}
# The steps a value is written in, per kind: a capacitor in p, n and u, a
# resistor in ohms, k and M.
_STEPS = {"C": [(1e-6, "u"), (1e-9, "n"), (1e-12, "p")],
          "L": [(1e-3, "m"), (1e-6, "u"), (1e-9, "n")],
          "R": [(1e6, "M"), (1e3, "k"), (1.0, "")]}


def _number(x: float) -> str:
    return f"{round(x, 6):.4g}"


def value_of(kind: str, text: str | None) -> str | None:
    """A resistor's, capacitor's or inductor's value in the table's own
    spelling - 0.1u, 100nF and 0u1 are all `100n`, 4k7 and 4.7K `4.7k`,
    2R2 `2.2`, 18pf `18p` - or None when it cannot be read as one. A bare
    number is ohms for a resistor; for a capacitor or an inductor it says
    nothing (pF? µF?) and is not guessed at."""
    k = (kind or "").strip().upper()[:1]
    m = _VALUE.match((text or "").replace("\u2126", "Ω"))       # the ohm sign, as Ω
    if not m or k not in _STEPS:
        return None
    whole, unit, frac = m.group(1).replace(",", "."), m.group(2) or "", m.group(3)
    if frac:
        if "." in whole or not unit:
            return None
        whole = f"{whole}.{frac}"
    if k == "R":
        if unit in ("p", "n", "u", "µ", "μ"):
            return None
    elif unit in ("", "r", "R", "Ω", "k", "K", "M", "meg"):
        return None
    v = float(whole) * _MULT[unit]
    if v == 0:
        return "0" if k == "R" else None
    for step, name in _STEPS[k]:
        if v >= step * 0.9995 or step == _STEPS[k][-1][0]:
            return _number(v / step) + name
    return None


def passive(kind: str, value: str, size: str) -> dict | None:
    """A resistor or capacitor by value and size, from the checked table.

    No request at all: tools/passives.py confirmed every row against LCSC
    by exact part number. The value is read the way people write it
    (`value_of`): 10k, 10K and 10kΩ are the same resistor; 100n, 100nF,
    0.1u and 0u1 the same capacitor. A value the table does not hold is
    None - never the nearest one.
    """
    try:
        table = json.loads(PASSIVES.read_text()).get("parts", {})
    except (OSError, ValueError):
        return None
    k = kind.strip().upper()[:1]
    v = value_of(k, value)
    s = size.strip()
    if v is None:
        return None
    for key, row in table.items():
        tk, tv, ts = key.split(" ")
        if tk == k and ts == s and value_of(tk, tv) == v:
            return {"key": key, **row}
    return None


# Resistors outside the table are UNI-ROYAL's thick-film series too, and its
# part number spells the value (tools/passives.py): so a value the table
# does not have can still be looked up by exact number - one ask - and
# taken only when LCSC has exactly that part.
RESISTOR_SERIES = {"0402": "0402WGF{}TCE", "0603": "0603WAF{}T5E", "0805": "0805W8F{}T5E"}


def resistor_code(value: str) -> str | None:
    """UNI-ROYAL's four-character value code: three digits and a power of
    ten (6190 is 619 Ω, 4222 is 42.2 kΩ), J for a tenth below 100 Ω (100J
    is 10 Ω), 0000 for a jumper. None for what it cannot spell."""
    v = value_of("R", value)
    if v is None:
        return None
    ohms = float(v[:-1]) * _MULT[v[-1]] if v[-1] in "kM" else float(v)
    if ohms == 0:
        return "0000"
    if 10 <= ohms < 100:
        tenth = round(ohms * 10)
        return f"{tenth}J" if abs(tenth - ohms * 10) < 1e-6 and 100 <= tenth <= 999 else None
    for exp in range(0, 7):
        digits = ohms / 10 ** exp
        if 100 <= round(digits, 6) <= 999 and abs(digits - round(digits)) < 1e-6:
            return f"{round(digits)}{exp}"
    return None


def _found_file() -> Path:
    LOOK.mkdir(parents=True, exist_ok=True)
    return LOOK / "passives_found.json"


async def find_passive(kind: str, value: str, size: str) -> dict | None:
    """A passive the table does not hold, found on LCSC by the exact part
    number its value spells (resistors only, for now). What is found is
    kept beside the cache, so it is asked once. None when nothing exactly
    that comes back - the caller then says so rather than substituting."""
    k = kind.strip().upper()[:1]
    v = value_of(k, value)
    if k != "R" or v is None or size not in RESISTOR_SERIES:
        return None
    key = f"R {v} {size}"
    try:
        kept = json.loads(_found_file().read_text())
    except (OSError, ValueError):
        kept = {}
    if key in kept:
        return {"key": key, **kept[key]} if kept[key] else None
    code = resistor_code(v)
    if not code:
        return None
    mpn = RESISTOR_SERIES[size].format(code)
    rows = await search(mpn, 5)
    row = next((r for r in rows if (r.get("mpn") or "").upper() == mpn.upper()), None)
    kept[key] = ({"lcsc": row["lcsc"], "mpn": row["mpn"], "package": row.get("package"),
                  "stock": row.get("stock"), "found": "LCSC, by exact part number"}
                 if row else None)
    try:
        _found_file().write_text(json.dumps(kept, indent=1, ensure_ascii=False))
    except OSError:
        pass
    return {"key": key, **kept[key]} if kept[key] else None


def passive_values() -> list[str]:
    try:
        return sorted(json.loads(PASSIVES.read_text()).get("parts", {}))
    except (OSError, ValueError):
        return []


ASK_PER_PICK = 2


async def pick(term: str, limit: int = 6) -> list[dict]:
    """Search, then put first what can actually be bought and assembled.

    LCSC lists by its own relevance, which put an out-of-stock TP4056
    first. Here: in stock before out of it, JLCPCB Basic before Extended
    (no feeder fee), then the most stock.
    """
    rows = await search(term, max(limit * 2, 10))
    # The class needs a lookup per part. Only the few with the most stock
    # are asked about - the rest could not be bought in quantity anyway -
    # and a refusal ends the asking rather than failing the search.
    rows.sort(key=lambda r: -(r.get("stock") or 0))
    out, asked = [], 0
    for row in rows:
        row["jlc_class"], row["has_model"] = None, None
        if asked < ASK_PER_PICK:
            try:
                look = await preview(row["lcsc"])
                row["jlc_class"] = look.get("jlc_class")
                row["has_model"] = look.get("has_model")
            except Refused:
                asked = ASK_PER_PICK
            except (LookupError, OSError, ValueError, TimeoutError):
                pass
            asked += 1
        out.append(row)

    def rank(r: dict):
        basic = (r.get("jlc_class") or "").lower().startswith("basic")
        return (not (r.get("stock") or 0) > 0, not basic, -(r.get("stock") or 0))
    return sorted(out, key=rank)[:limit]


async def model_glb(lcsc: str) -> bytes:
    """The 3D shape as a GLB the page can open without parsing text.

    Converted once and kept beside the OBJ it came from. In the browser the
    OBJ froze the whole application for seconds; here it takes 0.15.
    """
    from . import objglb

    path = LOOK / lcsc.strip() / "model.glb"
    try:
        if path.exists():
            return path.read_bytes()
    except OSError:
        pass
    obj = await model_obj(lcsc)
    glb = await asyncio.get_running_loop().run_in_executor(
        None, objglb.convert, obj.decode(errors="replace"))
    try:
        tmp = path.with_suffix(".glb.part")
        tmp.write_bytes(glb)
        tmp.replace(path)
    except OSError:
        pass
    return glb


async def photo(lcsc: str) -> bytes:
    """The product photo, where there is one to be had.

    Older parts point at EasyEDA's image host, which answers. Newer ones
    point at LCSC's own, which turns away anything that is not a browser;
    that is their call, so those parts simply have no photo here.
    """
    import urllib.error

    url = ((await _component(lcsc)).get("szlcsc") or {}).get("image")
    if not url:
        raise LookupError(f"{lcsc}: no photo")
    try:
        return await _kept(lcsc, "photo.jpg", url)
    except urllib.error.HTTPError as exc:
        raise LookupError(f"{lcsc}: the photo host said {exc.code}") from exc


async def fetch(db, lcsc: str, force: bool = False) -> dict:
    """The footprint and 3D model for one part, from cache or from LCSC."""
    lcsc = (lcsc or "").strip()
    if not looks_like_a_part(lcsc):
        raise ValueError(f"{lcsc!r} is not an LCSC part number")

    if not force:
        got = await db[PARTS].find_one({"_id": lcsc})
        if got and got.get("footprint") and not _model_worth_asking_again(got):
            return got

    # easyeda2kicad as it can be started here - the venv's own script in the
    # container, its packages under a same-version Python on the host
    # (backend/atoenv.py) - or a message that says what to set.
    from . import atoenv
    try:
        tool, tool_env = atoenv.easyeda()
    except atoenv.AtoEnvMissing as exc:
        raise RuntimeError(str(exc)) from exc

    tmp = Path(tempfile.mkdtemp(prefix="redline-lcsc-"))
    try:
        # easyeda2kicad asks EasyEDA itself - the component, then the 3D
        # model twice over - so it takes its turn like any other ask, is
        # written down, and counts as three against the budget. Unthrottled,
        # laying out a twenty-part board was sixty requests nobody saw.
        def download(argv, cwd):
            import subprocess
            from . import netproxy
            done = subprocess.run(argv, cwd=str(cwd), capture_output=True, text=True, timeout=TIMEOUT,
                                  env={**netproxy.env(_via(), _session()), **tool_env})
            if done.returncode != 0 and "403" in (done.stdout + done.stderr):
                import urllib.error
                raise urllib.error.HTTPError("easyeda2kicad", 403, "refused",
                                             {}, None)
            return done.returncode, (done.stdout + done.stderr)

        # With --use-cache easyeda2kicad keeps the component it read in
        # .easyeda_cache/ - which is where the 3D model's placement is, and
        # what seat_model() needs later. One already on disk from a
        # preview is handed to it, so it is the same data either way.
        ee_cache = tmp / ".easyeda_cache"
        ee_cache.mkdir()
        seen = LOOK / lcsc / "component.json"
        try:
            if seen.exists():
                shutil.copy(seen, ee_cache / f"{lcsc}.json")
        except OSError:
            pass
        rc, log = await _polite(
            "download", lcsc, f"easyeda2kicad --lcsc_id {lcsc} --footprint --3d",
            download, [*tool, "--lcsc_id", lcsc, "--footprint", "--3d",
                       "--use-cache",
                       "--output", str(tmp / "lib")], tmp, weight=3)
        pretty = list((tmp / "lib.pretty").glob("*.kicad_mod")) \
            if (tmp / "lib.pretty").exists() else []
        if rc != 0 or not pretty:
            raise RuntimeError(f"{lcsc}: nothing came back\n{log[-400:]}")

        fp = pretty[0]
        doc = {
            "_id": lcsc,
            "name": fp.stem,
            "footprint": fp.read_text(),
            "at": datetime.now(timezone.utc).isoformat(),
        }
        # Fetched again (force) and the model's download fails this time:
        # the model kept from before stays, rather than the part losing
        # its body to a bad minute. A new model below replaces it.
        before = await db[PARTS].find_one({"_id": lcsc}) if force else None
        kept_model = {k: before[k] for k in ("artifacts", "model_name", "model_kind",
                                             "model_step", "model_wrl")
                      if before and before.get(k)} \
            if before and modelseat_has_model(doc["footprint"]) else {}
        await db[PARTS].replace_one({"_id": lcsc}, {**doc, **kept_model}, upsert=True)

        # The model goes where every other generated thing goes: gzipped
        # into GridFS, with a copy on disk. An LQFP-48 is a 9.8 MB STEP,
        # and writing that into the document took ninety-nine seconds -
        # a document is for the things you search by, not for megabytes.
        #
        # STEP is what the board exporter can use; the WRL is what KiCad
        # shows in its own viewer. One of them, not both.
        shapes = tmp / "lib.3dshapes"
        if shapes.exists():
            for suffix in (".step", ".wrl"):
                hit = next(iter(shapes.glob(f"*{suffix}")), None)
                if not hit:
                    continue
                await store.put_artifact(db, lcsc, "model", hit.read_bytes(),
                                         collection=PARTS)
                await db[PARTS].update_one(
                    {"_id": lcsc},
                    {"$set": {"model_name": hit.stem,
                              "model_kind": suffix.lstrip(".")}})
                doc["model_name"] = hit.stem
                doc["model_kind"] = suffix.lstrip(".")
                break

        component = None
        try:
            raw = (ee_cache / f"{lcsc}.json").read_bytes()
            component = json.loads(raw.decode(errors="replace")).get("result")
            if component and not seen.exists():
                _keep_file(lcsc, "component.json", raw)
        except (OSError, ValueError, AttributeError):
            pass
        if not doc.get("model_kind") and kept_model.get("model_kind"):
            doc["model_kind"] = kept_model["model_kind"]
            doc["model_kept"] = True
            await db[PARTS].update_one({"_id": lcsc}, {"$set": {"model_kept_at": doc["at"]}})
        if not doc.get("model_kind"):
            # Said on the part, so the next board does not ask again at once
            # (_model_worth_asking_again).
            await db[PARTS].update_one({"_id": lcsc},
                                       {"$set": {"model_missing_at": doc["at"]}})
        if doc.get("model_kind"):
            try:
                await seat_model(db, lcsc, component)
            except (LookupError, ValueError, OSError, RuntimeError):
                pass                 # unseated is how it was; not a failed fetch
        return await db[PARTS].find_one({"_id": lcsc}) or doc

    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def modelseat_has_model(footprint: str) -> bool:
    from . import modelseat
    return modelseat.has_model(footprint or "")


async def refresh(db, lcsc: str) -> dict:
    """A part kept in the drawer fetched again: EasyEDA's record of it asked
    afresh (not the copy on disk), then the footprint and the 3D model
    downloaded (fetch, force) and the model seated on its pads.

    For a part kept without its body - a download that failed once, a
    model EasyEDA added later - which `part keep` passes over ("already in
    the drawer") and `part seat` cannot help ("no model stored"). Every
    ask takes its turn in the budget and goes through the proxy as set.

    Says what it found: {"lcsc", "name", "upstream_model", "model_name",
    "model_kind", "seat", "said"}; `upstream_model` None is EasyEDA having
    no 3D model for the part at all.
    """
    lcsc = (lcsc or "").strip()
    if not looks_like_a_part(lcsc):
        raise ValueError(f"{lcsc!r} is not an LCSC part number")
    component = await _component(lcsc, fresh=True)
    upstream, upstream_name = _model_of(component)
    # The preview's model files belong to the record they came from.
    for name in ("model.obj", "model.glb"):
        try:
            (LOOK / lcsc / name).unlink()
        except OSError:
            pass
    doc = await fetch(db, lcsc, force=True)
    has = bool((doc.get("artifacts") or {}).get("model")
               or doc.get("model_step") or doc.get("model_wrl"))
    out = {"lcsc": lcsc, "name": doc.get("name"), "upstream_model": upstream,
           "upstream_name": upstream_name,
           "model_name": doc.get("model_name") if has else None,
           "model_kind": doc.get("model_kind") if has else None,
           "kept_from_before": bool(doc.get("model_kept_at")) and doc.get("model_kept_at") == doc.get("at"),
           "seat": None}
    if has:
        try:
            out["seat"] = (await seat_model(db, lcsc, component))["status"]
        except Refused:
            raise
        except (LookupError, ValueError, OSError, RuntimeError) as exc:
            out["seat"] = f"not seated - {exc}"
    if not upstream:
        out["said"] = ("LCSC/EasyEDA has no 3D model for this part - footprint only"
                       + (" (the model kept from before stays)" if has else ""))
    elif not has:
        out["said"] = (f"EasyEDA names a 3D model ({upstream_name or upstream}) but the "
                       "download brought none - try again later")
    elif out["kept_from_before"]:
        out["said"] = (f"the model's download failed; the {out['model_kind']} kept from "
                       "before stays")
    else:
        out["said"] = f"{out['model_kind']} model {out['model_name']}, {out['seat']}"
    return out


# A part fetched with its footprint but without the 3D model the footprint
# names - the model's download failed that once - was kept like that for
# good: the demo board's U1 (C2925423) had no body in any board's 3D view,
# and asked again it came at once. So such a part is fetched again, at most
# once a day: EasyEDA may simply have no model for it.
MODEL_RETRY_S = 24 * 3600


def _model_worth_asking_again(doc: dict) -> bool:
    if (doc.get("artifacts") or {}).get("model") or doc.get("model_step") or doc.get("model_wrl"):
        return False
    from . import modelseat
    if not modelseat.has_model(doc.get("footprint") or ""):
        return False                 # the footprint names no model: none to miss
    last = doc.get("model_missing_at")
    if not last:
        return True
    try:
        then = datetime.fromisoformat(last)
    except (TypeError, ValueError):
        return True
    return (datetime.now(timezone.utc) - then).total_seconds() > MODEL_RETRY_S


def _keep_file(lcsc: str, name: str, blob: bytes) -> None:
    try:
        path = LOOK / lcsc.strip() / name
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(blob)
        tmp.replace(path)
    except OSError:
        pass


# ---- seating the 3D model on its pads --------------------------------------
#
# easyeda2kicad writes every footprint's model offset as 0,0,0 and bakes
# the real placement into the WRL only; the board is drawn from the STEP,
# so bodies stood millimetres off their pads (backend/modelseat.py). The
# offset is worked out from the stored model and EasyEDA's own placement
# and written into the stored footprint, once per part.

async def seat_model(db, lcsc: str, component: dict | None = None) -> dict:
    """Set the stored footprint's model offset so the body sits on its pads.

    `component` is EasyEDA's record of the part; without it the one on disk
    is used, and only when that is missing is EasyEDA asked - politely, and
    through the proxy when the proxy is set to always (`_component`).
    Nothing is downloaded again: the model is the one already stored.
    Says what it did: {"lcsc", "status", "offset", "was"}.
    """
    from . import modelseat

    doc = await db[PARTS].find_one({"_id": lcsc}, {"footprint": 1})
    text = (doc or {}).get("footprint") or ""
    out = {"lcsc": lcsc, "status": "", "offset": None,
           "was": modelseat.offset_of(text)}
    if not text:
        out["status"] = "not in the drawer"
        return out
    if not modelseat.has_model(text):
        out["status"] = "footprint names no model"
        return out
    got = await model_of(db, lcsc)
    if not got:
        out["status"] = "no model stored"
        return out
    if component is None:
        component = await _component(lcsc)
    blob, kind = got
    loop = asyncio.get_running_loop()
    # OpenCascade reading a STEP is seconds of CPU: off the event loop.
    done = await loop.run_in_executor(None, modelseat.seated, text, blob,
                                      kind, component)
    if not done:
        out["status"] = "no placement to go on"
        return out
    new_text, offset = done
    out["offset"] = offset
    await db[PARTS].update_one(
        {"_id": lcsc},
        {"$set": {"footprint": new_text, "model_offset": list(offset),
                  "model_seated": modelseat.VERSION}})
    out["status"] = "seated" if new_text != text else "already seated"
    return out


async def seat_all(db, ids: list[str] | None = None, progress=None) -> list[dict]:
    """seat_model() for the given parts, or every part in the drawer."""
    if not ids:
        ids = [d["_id"] async for d in db[PARTS].find({}, {"_id": 1})]
    rows = []
    for i, lcsc in enumerate(ids, 1):
        try:
            row = await seat_model(db, lcsc)
        except Refused:
            raise
        except (LookupError, ValueError, OSError, RuntimeError) as exc:
            row = {"lcsc": lcsc, "status": f"left as it was - {exc}",
                   "offset": None, "was": None}
        rows.append(row)
        if progress:
            progress(i, len(ids), row)
    return rows


async def model_of(db, lcsc: str) -> tuple[bytes, str] | None:
    """The part's 3D model, and which format it is in.

    Parts fetched before the models moved out of the document still carry
    them inline; those are read from where they are rather than being
    migrated, because the next fetch of that part writes it the new way.
    """
    doc = await db[PARTS].find_one({"_id": lcsc})
    if not doc:
        return None
    if (doc.get("artifacts") or {}).get("model"):
        blob = await store.get_artifact(db, lcsc, "model", PARTS)
        return blob, doc.get("model_kind") or "step"
    for field, kind in (("model_step", "step"), ("model_wrl", "wrl")):
        if doc.get(field):
            return bytes(doc[field]), kind
    return None


async def fetch_many(db, ids: list[str]) -> tuple[dict, list[str]]:
    """Every part a board needs, and the ones that could not be had.

    One at a time on purpose: this is somebody else's service, and a board
    with thirty parts should not open thirty connections to it.
    """
    out, failed = {}, []
    for lcsc in dict.fromkeys(i for i in ids if looks_like_a_part(i)):
        try:
            out[lcsc] = await fetch(db, lcsc)
        except (ValueError, RuntimeError, TimeoutError, OSError) as exc:
            failed.append(f"{lcsc}: {exc}")
    return out, failed


# ---------------- the drawer, sorted like one ----------------
# A part's place in the drawer: a group and a branch in it, read from the
# category LCSC files it under (the EasyEDA record's tags), else from its
# designator prefix. First match wins; the order matters (an "ESD
# Protection Device" is a diode, not "Protection" ICs).
DRAWER: tuple[tuple[str, str, str], ...] = (
    # (pattern on the tag, group, branch)
    (r"capacitor|mlcc", "Passives", "Capacitors"),
    (r"resistor", "Passives", "Resistors"),
    (r"inductor|coil|ferrite|bead", "Passives", "Inductors"),
    (r"light emitting|\bled\b", "Discretes", "LEDs"),
    (r"diode|schottky|zener|\btvs\b|esd protection|rectifier", "Discretes", "Diodes"),
    (r"mosfet|transistor|\bbjt\b|igbt", "Discretes", "Transistors"),
    (r"crystal|oscillator|resonator", "Frequency", "Crystals & oscillators"),
    (r"oled|lcd|display", "Displays", "Displays"),
    (r"battery connector|battery holder", "Electromechanical", "Battery holders"),
    (r"usb connector|pin header|female header|wire to board|connector|terminal", "Electromechanical", "Connectors"),
    (r"switch|encoder|button", "Electromechanical", "Switches"),
    (r"dc-dc|ldo|regulator|battery management|power management|charger|voltage reference|load switch|pmic", "ICs", "Power"),
    (r"microcontroller|processor|\bmcu|wifi module|bluetooth|wireless|rf module", "ICs", "Microcontrollers & modules"),
    (r"usb ic|uart|interface|can transceiver|rs-?485|level shift|bridge", "ICs", "Interface"),
    (r"sensor", "ICs", "Sensors"),
    (r"memory|eeprom|flash", "ICs", "Memory"),
)
# When the tag says nothing useful ("Pre-ordered Products", a brand name).
PREFIX_DRAWER = {
    "R": ("Passives", "Resistors"), "C": ("Passives", "Capacitors"), "L": ("Passives", "Inductors"),
    "FB": ("Passives", "Inductors"), "LED": ("Discretes", "LEDs"), "D": ("Discretes", "Diodes"),
    "Q": ("Discretes", "Transistors"), "X": ("Frequency", "Crystals & oscillators"),
    "Y": ("Frequency", "Crystals & oscillators"), "SW": ("Electromechanical", "Switches"),
    "J": ("Electromechanical", "Connectors"), "P": ("Electromechanical", "Connectors"),
    "H": ("Electromechanical", "Connectors"), "CN": ("Electromechanical", "Connectors"),
    "USB": ("Electromechanical", "Connectors"), "BT": ("Electromechanical", "Battery holders"),
    "OLED": ("Displays", "Displays"), "LDO": ("ICs", "Power"), "U": ("ICs", "Other ICs"),
}
_MCU = re.compile(r"^(STM32|ESP32|ESP8266|ATMEGA|ATTINY|RP2040|CH32|GD32|NRF5|PIC\d)", re.I)
# Parts LCSC files under nothing telling: OLED glass, rotary encoders.
_BY_MPN_DISPLAY = re.compile(r"OLED|SSD1306|SH1106|X0\d{2}-\d{4}", re.I)
_BY_MPN_ENCODER = re.compile(r"^(EC1[12]|SIQ-|PEC1\d|EVQ)", re.I)
DRAWER_ORDER = ("ICs", "Passives", "Discretes", "Electromechanical", "Frequency", "Displays", "Other")


def drawer_place(tags: list[str] | None, prefix: str | None, mpn: str | None = None) -> tuple[str, str]:
    """(group, branch) for a part in the drawer."""
    text = " ".join(tags or []).lower()
    if mpn and _MCU.match(mpn):
        return "ICs", "Microcontrollers & modules"
    if mpn and _BY_MPN_DISPLAY.search(mpn):
        return "Displays", "Displays"
    if mpn and _BY_MPN_ENCODER.match(mpn):
        return "Electromechanical", "Switches"
    for pattern, group, branch in DRAWER:
        if text and re.search(pattern, text):
            return group, branch
    pre = re.sub(r"[^A-Za-z]", "", prefix or "").upper()
    for n in (len(pre), 3, 2, 1):
        if pre[:n] in PREFIX_DRAWER:
            return PREFIX_DRAWER[pre[:n]]
    return "Other", "Other"


def _drawer_facts(lcsc: str) -> dict:
    """What the cached EasyEDA record says about a part: its category, its
    designator prefix, value and manufacturer part number. Read from disk,
    nothing asked."""
    try:
        raw = json.loads((LOOK / lcsc / "component.json").read_text())
    except (OSError, ValueError):
        return {}
    rec = raw.get("result", raw) if isinstance(raw, dict) else {}
    para = ((rec.get("dataStr") or {}).get("head") or {}).get("c_para") or {}
    return {"tags": rec.get("tags") or [], "prefix": para.get("pre"),
            "value": para.get("Value") or para.get("value"),
            "mpn": para.get("Manufacturer Part"), "maker": para.get("Manufacturer")}


async def known(db) -> list[dict]:
    """What is in the drawer already.

    Asked as an aggregation because the answer must not carry a STEP file
    per part across the wire. Leaving those fields out of a find() left
    `has_3d` reading false for every part that had one - what is not
    fetched cannot be truthy.
    """
    rows = [row async for row in db[PARTS].aggregate([
        {"$project": {
            "name": 1, "at": 1,
            "has_3d": {"$or": [{"$ifNull": ["$artifacts.model", False]},
                               {"$ifNull": ["$model_step", False]},
                               {"$ifNull": ["$model_wrl", False]}]},
        }},
        {"$sort": {"_id": 1}},
    ])]
    out = []
    for r in rows:
        facts = _drawer_facts(r["_id"])
        group, branch = drawer_place(facts.get("tags"), facts.get("prefix"), facts.get("mpn"))
        out.append({"lcsc": r["_id"], "name": r.get("name"),
                    "has_3d": bool(r.get("has_3d")), "at": r.get("at"),
                    "group": group, "branch": branch, "category": (facts.get("tags") or [None])[0],
                    "value": facts.get("value"), "mpn": facts.get("mpn"), "maker": facts.get("maker")})
    return out
