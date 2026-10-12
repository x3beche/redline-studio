"""queue_list: the notes queued in the rooms (3D, PCB, Firmware) - the
revisions each room's card list shows (GET /api/revisions), with what is
being worked on now (the rooms' runs, as the "Working now" panel reads
them, backend/worknow.py), by room, newest first.

These are the rooms' notes - drawn on a model, a board or a firmware and
handed to that room's agent - not the Notes tab's jotted notes
(backend/notes.py), so the tool is General's: it spans the rooms."""

from __future__ import annotations

from .. import compute
from . import Ctx, Result, Tool, clip

ROOMS = ("cad", "pcb", "firmware")
NAME = {"cad": "3D", "pcb": "PCB", "firmware": "Firmware"}
THING = {"cad": "model", "pcb": "board", "firmware": "firmware"}
STATES = ("draft", "queued", "working", "review", "failed", "applied", "rejected")
SAID = {"review": "done, waiting for review", "working": "working now"}
SHOW = 40
MOST = 150


def room_of(d: dict) -> str:
    return compute.room_of(d.get("kind"))


def state(d: dict, run: dict | None) -> str:
    """draft, queued, working (its run is open), review (its run is done and
    nobody marked it applied yet), failed (its run failed), applied or
    rejected - as the room's card shows it."""
    status = d.get("status") or "draft"
    if status != "queued":
        return status
    rs = (run or {}).get("status")
    return {"running": "working", "done": "review", "failed": "failed"}.get(rs, "queued")


def first_line(d: dict, n: int = 160) -> str:
    text = d.get("summary") or next((ln for ln in (d.get("comment") or "").splitlines() if ln.strip()), "")
    text = " ".join(text.split())
    return text[:n] + ("…" if len(text) > n else "")


def who(x) -> str:
    return (x or {}).get("name") or (x or {}).get("id") or ""


async def runs_of(db, ids: list[str]) -> dict:
    if not ids:
        return {}
    return {r["_id"]: r async for r in db.runs.find({"_id": {"$in": ids}})}


async def working(db) -> list[dict]:
    """The notes being worked on now, once each (a run is kept twice: as its
    room's current run and under the note's id)."""
    seen, out = set(), []
    async for r in db.runs.find({"status": "running"}):
        if not r.get("revision") or r["revision"] in seen:
            continue
        seen.add(r["revision"])
        out.append(r)
    return out


def _run_line(r: dict) -> str:
    pct = r.get("percent")
    return (f"{r.get('revision')}  {NAME.get(r.get('room') or 'cad', r.get('room'))} room  \"{r.get('title') or ''}\""
            + (f"  {round(pct)}%" if isinstance(pct, (int, float)) else "")
            + (f"  by {who(r.get('by'))}" if who(r.get("by")) else "")
            + f"  since {str(r.get('started_at') or '')[:16].replace('T', ' ')}")


async def run(ctx: Ctx, args: dict) -> Result:
    room = str(args.get("room") or "").strip().lower()
    room = {"3d": "cad", "model": "cad", "board": "pcb"}.get(room, room)
    want = str(args.get("status") or "").strip().lower()
    words = [w.lower() for w in str(args.get("query") or "").split()]
    try:
        limit = max(1, min(MOST, int(args.get("limit") or SHOW)))
    except (TypeError, ValueError):
        limit = SHOW
    query: dict = {"archived": True if args.get("archived") else {"$ne": True}}
    rows = [d async for d in ctx.db.revisions.find(query)]
    if room in ROOMS:
        rows = [d for d in rows if room_of(d) == room]
    if words:
        rows = [d for d in rows if all(w in " ".join(str(d.get(k) or "") for k in ("comment", "summary", "model", "part"))
                                       .lower() for w in words)]
    runs = await runs_of(ctx.db, [d["_id"] for d in rows if d.get("status") == "queued"])
    for d in rows:
        d["_state"] = state(d, runs.get(d["_id"]))
    if want in STATES:
        rows = [d for d in rows if d["_state"] == want]
    rows.sort(key=lambda d: str(d.get("created_at") or ""), reverse=True)

    now = [r for r in await working(ctx.db) if room not in ROOMS or (r.get("room") or "cad") == room]
    parts = ["Working now: " + ("\n  " + "\n  ".join(_run_line(r) for r in now) if now else "nothing.")]
    shown = rows[:limit]
    for r in ROOMS:
        mine = [d for d in shown if room_of(d) == r]
        if not mine:
            continue
        counts = {}
        for d in rows:
            if room_of(d) == r:
                counts[d["_state"]] = counts.get(d["_state"], 0) + 1
        parts.append(f"\n{NAME[r]} room - " + ", ".join(f"{n} {SAID.get(s, s)}" for s, n in counts.items()) + ":")
        for d in mine:
            parts.append(f"  {d['_id']}  [{SAID.get(d['_state'], d['_state'])}]  {THING[r]} {d.get('model') or '-'}"
                         + (f" (part {d['part']})" if d.get("part") else "")
                         + f"  · written {str(d.get('created_at') or '')[:16].replace('T', ' ')}"
                         + (f" by {who(d.get('created_by'))}" if who(d.get("created_by")) else "")
                         + f"\n      {first_line(d)}")
    if not rows:
        parts.append("\nNo note in the rooms' queues" + (" matches." if (want or words or room in ROOMS) else " yet."))
    elif len(rows) > len(shown):
        parts.append(f"\n(the newest {len(shown)} of {len(rows)} shown)")
    text = "\n".join(parts) + ("\n\nRead one whole with queue_read and its id." if rows else "")
    summary = "\n".join([f"working: {r.get('revision')} {r.get('title') or ''}" for r in now]
                        + [f"{d['_id']} · {SAID.get(d['_state'], d['_state'])} · {first_line(d, 60)}" for d in shown[:15]])
    return Result(text=clip(text), say="Listed {n} queued notes · {working} working now",
                  vars={"n": len(rows), "working": len(now)}, summary=summary or "none")


TOOL = Tool(
    name="queue_list", package="general", level="read", order=70,
    label="Read the rooms' queues",
    about="Lists the notes queued in the 3D, PCB and Firmware rooms, their status, and what is being worked on now.",
    description="List the notes (tasks) in the 3D, PCB and Firmware rooms' queues - the notes drawn on a model, "
                "board or firmware for that room's agent, not the Notes tab's notes - newest first, by room, each "
                "with its status: draft, queued, working (its agent works on it now), review (the work is done and "
                "waits for someone to mark it applied), failed, applied or rejected; and first, what is being "
                "worked on now. Filter by `room`, `status`, `query` (words of the note) or `archived`. Read one "
                "whole with queue_read.",
    schema={"type": "object", "properties": {
        "room": {"type": "string", "enum": list(ROOMS), "description": "Only this room's queue"},
        "status": {"type": "string", "enum": list(STATES), "description": "Only notes in this state"},
        "query": {"type": "string", "description": "Words the note holds"},
        "archived": {"type": "boolean", "description": "The archived notes instead"},
        "limit": {"type": "integer", "description": f"How many to show (default {SHOW}, at most {MOST})"}}},
    running="Reading the rooms' queues", failed="Could not read the rooms' queues",
    run=run)
