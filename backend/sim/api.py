"""The simulator's HTTP routes (SPEC §5): /api/sim/<app>/...

    POST /api/sim/{app}/start   {board?, sim?}   run the firmware on the app's board
    POST /api/sim/{app}/stop
    POST /api/sim/{app}/reset   {board?, sim?}   stop, then start again
    POST /api/sim/{app}/act     {ref, action}    {"press": true}, {"value": 23.5}
    POST /api/sim/{app}/uart    {port, data}     type into the MCU's serial port
    POST /api/sim/{app}/link    {board?, sim?}   which board the app runs on, and corrections
    GET  /api/sim/{app}                          state, sim.json, the models, errors
    GET  /api/sim/{app}/events                   Server-Sent Events: `snapshot`, on change, <= 20/s
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import service
from .parts import load_catalog

router = APIRouter()


@router.on_event("startup")
async def _clear_orphans() -> None:
    """Sessions live in this process, so any emulator container left from
    before it started (a reload, a restart) belongs to nobody - and keeps a
    core and half a gigabyte busy. Both adapters name theirs redline-sim-*."""
    import asyncio
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", "ps", "-q", "--filter", "name=^redline-sim-",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(proc.communicate(), 10)
        ids = out.decode().split()
        if ids:
            rm = await asyncio.create_subprocess_exec(
                "docker", "rm", "-f", *ids,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            await asyncio.wait_for(rm.wait(), 30)
    except (OSError, asyncio.TimeoutError):
        pass                                 # no Docker: nothing was left running either
SIMS = service.SIMS
EVERY_S = 0.05                     # at most 20 snapshots a second
KEEPALIVE_S = 15


def _db():
    # Late, as code_api does: main imports this module and owns the connection.
    from backend.main import db
    return db()


def _fail(exc: service.SimError):
    raise HTTPException(exc.status, str(exc))


class StartIn(BaseModel):
    board: str | None = None
    sim: dict | None = None


class ActIn(BaseModel):
    ref: str
    action: dict


class UartIn(BaseModel):
    port: str = "UART0"
    data: str = Field(max_length=service.UART_IN_MAX)


class LinkIn(BaseModel):
    board: str | None = None
    sim: dict | None = None
    unlink: bool = False


@router.get("/api/sim/{app}")
async def state(app: str):
    """What the page draws before and while it runs."""
    catalog = load_catalog()
    s = SIMS.get(app)
    out = {"app": app, "board": None, "glb": False, "sim": None, "models": {},
           "errors": [], "warnings": [], "snapshot": SIMS.snapshot(app)}
    try:
        got = await service.resolve(_db(), app, catalog=catalog)
        out.update(board=got["board"], glb=got["glb"], sim=got["sim"], warnings=got["warnings"],
                   firmware=str(got["firmware"]))
    except service.SimError as exc:
        if exc.status == 404:
            _fail(exc)
        out["errors"].append(str(exc))
    if s:                      # a run started with its own board or sim.json shows that one
        if s.board_id and s.board_id != out["board"]:
            out["glb"] = await _has_glb(s.board_id)
        out["sim"], out["board"] = s.sim, s.board_id or out["board"]
        out["warnings"] = list(dict.fromkeys(out["warnings"] + s.warnings))
        out["errors"] = []     # it runs: what the app's own link lacks does not matter now
    if out["sim"]:
        out["models"] = service.models_of(out["sim"], catalog)
    return out


async def _has_glb(bid: str) -> bool:
    from backend import ato
    doc = await _db()[ato.BOARDS].find_one({"_id": bid}, {"artifacts": 1})
    return "model3d" in ((doc or {}).get("artifacts") or {})


@router.post("/api/sim/{app}/start")
async def start(app: str, body: StartIn | None = None):
    body = body or StartIn()
    try:
        s = await SIMS.start(_db(), app, body.board, body.sim)
    except service.SimError as exc:
        _fail(exc)
    return {"ok": True, "state": s.state, "board": s.board_id, "warnings": s.warnings}


@router.post("/api/sim/{app}/reset")
async def reset(app: str, body: StartIn | None = None):
    old = SIMS.get(app)
    body = body or StartIn()
    if old and body.board is None and body.sim is None:
        body = StartIn(board=old.board_id, sim={**old.sim, "replace": True})
    return await start(app, body)


@router.post("/api/sim/{app}/stop")
async def stop(app: str):
    s = await SIMS.stop(app)
    return {"ok": True, "state": s.state if s else "idle"}


@router.post("/api/sim/{app}/act")
async def act(app: str, body: ActIn):
    try:
        SIMS.act(app, body.ref, body.action)
    except service.SimError as exc:
        _fail(exc)
    return {"ok": True}


@router.post("/api/sim/{app}/uart")
async def uart(app: str, body: UartIn):
    try:
        SIMS.uart(app, body.port, body.data)
    except service.SimError as exc:
        _fail(exc)
    return {"ok": True}


@router.post("/api/sim/{app}/link")
async def link(app: str, body: LinkIn):
    """Which board this firmware runs on (apps.board), and hand corrections (apps.sim)."""
    from backend import apps, ato
    db = _db()
    doc = await db[apps.APPS].find_one({"_id": app}, {"platform": 1})
    if not doc:
        raise HTTPException(404, f"no app {app!r}")
    if body.unlink:
        await db[apps.APPS].update_one({"_id": app}, {"$unset": {"board": "", "sim": ""}})
        return {"ok": True, "board": None}
    if body.board and not await db[ato.BOARDS].find_one({"_id": body.board}, {"_id": 1}):
        raise HTTPException(404, f"no board {body.board!r}")
    change = {k: v for k, v in (("board", body.board), ("sim", body.sim)) if v is not None}
    if not change:
        raise HTTPException(400, "nothing to link: give board and/or sim")
    await db[apps.APPS].update_one({"_id": app}, {"$set": change})
    return {"ok": True, **change}


@router.get("/api/sim/{app}/events")
async def events(app: str, request: Request, limit: int = 0):
    """`snapshot` events whenever something changed, at most every EVERY_S.
    `limit` ends the stream after that many (for tests and agents)."""

    async def stream():
        last, sent, quiet = None, 0, 0.0
        while True:
            if await request.is_disconnected():
                return
            text = json.dumps(SIMS.snapshot(app), separators=(",", ":"))
            if text != last:
                last, quiet = text, 0.0
                sent += 1
                yield f"event: snapshot\ndata: {text}\n\n"
                if limit and sent >= limit:
                    return
            else:
                quiet += EVERY_S
                if quiet >= KEEPALIVE_S:
                    quiet = 0.0
                    yield ": still here\n\n"
            await asyncio.sleep(EVERY_S)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
