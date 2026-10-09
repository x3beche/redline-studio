"""A board being routed by TraceMaker, as it happens - for the layout view.

TraceMaker streams its routing (docs/13-viewer-protocol.md in its source):
the board, every track and via it adds and rips up, the connections still
open, the paths it is trying, where it failed, its progress. In its
container, docker/tm_relay.py writes that stream to `live.jsonl` in the
run's work folder, one message a line; the board's document says where
(`route_live`, set by backend/kicad.py while the router runs).

The page asks for what is new since the byte it last read, a few times a
second, and draws it in Redline's own board view. A poll and not a socket:
it is what every other long job here does, and a reload of the API in the
middle of a run loses nothing - the file is still there.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/boards")
CHUNK = 768 * 1024                  # the most one answer hands over, bytes


def _db():
    from .main import db
    return db()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# A run lives through phases: `routing` while the router runs, `finishing`
# while the rest of the run pours, checks and draws the board (minutes, with
# nothing new in the stream), then `done`. The page keeps the view up - and
# a reload brings it back, from the start of the stream - until `done`.
STALE_S = 3 * 3600                  # a run not closed after this died with its job


async def begin(db, board_id: str, path: str, engine: str, attempt: int) -> None:
    from . import ato
    await db[ato.BOARDS].update_one({"_id": board_id}, {"$set": {"route_live": {
        "path": path, "engine": engine, "attempt": attempt, "started_at": _now(),
        "active": True, "phase": "routing"}}})


async def end(db, board_id: str) -> None:
    """The router is done; the run goes on (pour, DRC, drawings)."""
    from . import ato
    await db[ato.BOARDS].update_one({"_id": board_id, "route_live.active": True},
                                    {"$set": {"route_live.phase": "finishing", "route_live.routed_at": _now()}})


async def close(db, board_id: str) -> None:
    """The whole run is over, however it ended."""
    from . import ato
    await db[ato.BOARDS].update_one({"_id": board_id, "route_live.active": True},
                                    {"$set": {"route_live.active": False, "route_live.phase": "done",
                                              "route_live.ended_at": _now()}})


def _stale(rl: dict) -> bool:
    try:
        started = datetime.fromisoformat(rl["started_at"])
    except (KeyError, TypeError, ValueError):
        return True
    return (datetime.now(timezone.utc) - started).total_seconds() > STALE_S


def read_from(path: str, at: int, limit: int = CHUNK) -> tuple[list[dict], int, int]:
    """The whole lines written after byte `at`, parsed, and where the next
    read starts. A line still being written is left for the next read. A
    file shorter than `at` was started again (the next layout try): read
    from its start."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return [], 0, 0
    if at > size:
        at = 0
    with open(path, "rb") as f:
        f.seek(at)
        raw = f.read(limit)
    end = raw.rfind(b"\n")
    if end < 0:
        return [], at, size
    out = []
    for line in raw[:end].split(b"\n"):
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out, at + end + 1, size


@router.get("/{bid}/route/live")
async def live(bid: str, at: int = 0) -> dict:
    from . import ato
    doc = await _db()[ato.BOARDS].find_one({"_id": bid}, {"route_live": 1})
    if doc is None:
        raise HTTPException(404, f"no board {bid}")
    rl = dict(doc.get("route_live") or {})
    if rl.get("active") and _stale(rl):
        rl["active"], rl["phase"] = False, "done"
    if not rl.get("path"):
        return {"active": False, "engine": None, "events": [], "at": 0}
    if not rl.get("active") and at <= 0:
        # Nothing is routing and the page was not following: a finished
        # run's stream is not handed out again.
        return {"active": False, "engine": rl.get("engine"), "attempt": rl.get("attempt", 0),
                "events": [], "at": 0}
    events, nxt, size = read_from(rl["path"], max(0, at))
    return {"active": bool(rl.get("active")), "engine": rl.get("engine"),
            "phase": rl.get("phase") or ("routing" if rl.get("active") else "done"),
            "attempt": rl.get("attempt", 0), "started_at": rl.get("started_at"),
            "routed_at": rl.get("routed_at"),
            "events": events, "at": nxt, "size": size, "more": nxt < size}
