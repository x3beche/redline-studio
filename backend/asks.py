"""Asks that outlive the agent session they were sent to.

What people ask the agents for is already kept in the database: a note is a
revision (``queued``), what is being done about it a run (``running``, then
``done`` / ``failed``, backend/runs.py), and a line in a room's thread a chat
message (unread until ``chat`` marks it ``seen_at``, answered by the
agent's next line in that room). What was not kept is *which session* had
it in hand, and whether that session is still there. A Claude Code session
in tmux gets restarted; the notes its room agents had started stayed
``running`` for ever - shown "in progress", and skipped by ``wait`` and
``next`` as work already in hand - and the lines it had read but not yet
answered were simply forgotten.

So:

- every session that runs the command line leaves a heartbeat here
  (``agent_sessions``: its id, the agent's name, ``last_seen``);
- a session starting up says so (``revisions.py resume``): the earlier
  sessions in the same seat are marked ``superseded``. The seat is the tmux
  session it runs in (``redline-cagsak``) - a restart is a new Claude Code
  session in the same one - or ``REDLINE_SEAT``, or else the agent's name;
  another Claude working in the repository from its own terminal is in
  another seat and supersedes nobody;
- ``sweep`` looks at every open run: one whose holder's session was
  superseded since it took the note, or has not been heard from for
  ``LEASE_MIN`` minutes, is closed as ``interrupted``. The note is still
  ``queued``, so it is back in the queue - ``wait`` and ``next`` offer it
  again, and the card says "interrupted, requeued" and why;
- ``unfinished`` is what a session starting up is shown: notes interrupted,
  notes finished and waiting for review, and lines read before the restart
  that nobody answered. Shown, not done: nothing here acts on them.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

from . import runs

SESSIONS = "agent_sessions"
INTERRUPTED = "interrupted"
# How long a session may go without running a command before what it holds
# is given back. `wait` beats every half minute while the agent idles, and
# the room agents run a command every few minutes while they work.
LEASE_MIN = 45
# Lines read before a restart older than this are history, not asks.
CHAT_DAYS = 2


def seat_from_env(agent: str, env=None) -> str:
    """Where this session runs, so the next session there replaces it."""
    import subprocess
    env = os.environ if env is None else env
    if (env.get("REDLINE_SEAT") or "").strip():
        return env["REDLINE_SEAT"].strip()
    if env.get("TMUX"):
        try:
            cmd = ["tmux", "display-message", "-p"] + (["-t", env["TMUX_PANE"]] if env.get("TMUX_PANE") else []) + ["#S"]
            name = subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout.strip()
            if name:
                return "tmux:" + name
        except (OSError, subprocess.SubprocessError):
            pass
    return "agent:" + agent


def lease_minutes() -> float:
    try:
        return float(os.environ.get("REDLINE_LEASE_MINUTES") or LEASE_MIN)
    except ValueError:
        return float(LEASE_MIN)


def _dt(v) -> datetime | None:
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


async def beat(db, session: str | None, agent: str, at: str | None = None,
               seat: str | None = None) -> None:
    """This session is alive. Nothing to do without a session id."""
    if not session:
        return
    at = at or runs.now()
    await db[SESSIONS].update_one(
        {"_id": session},
        {"$set": {"agent": agent, "last_seen": at, **({"seat": seat} if seat else {})},
         "$setOnInsert": {"first_seen": at, "superseded_at": None}},
        upsert=True)


async def register(db, session: str | None, agent: str, seat: str | None = None) -> list[dict]:
    """A session starting up in `seat`: the earlier ones there are over.
    Returns them (the ones not marked before)."""
    at = runs.now()
    seat = seat or "agent:" + agent
    await beat(db, session, agent, at, seat)
    if not session:
        return []
    old = [s async for s in db[SESSIONS].find({"seat": seat, "superseded_at": None})
           if s["_id"] != session]
    for s in old:
        await db[SESSIONS].update_one({"_id": s["_id"]},
                                      {"$set": {"superseded_at": at, "superseded_by": session}})
    return old


async def _last_line(db, room: str | None, since: str | None) -> str | None:
    """The newest log line in the run's room: how a run whose session left
    no heartbeat (started before there were any) shows it is alive."""
    newest = None
    async for a in db.activity.find({"room": room or "cad"}, {"at": 1}).sort("at", -1).limit(1):
        newest = a.get("at")
    return newest if newest and (not since or str(newest) > str(since)) else None


async def stale_reason(db, run: dict, now: datetime | None = None,
                       lease: float | None = None) -> str | None:
    """Why this open run's holder is gone, or None while it is not."""
    now = now or datetime.now(timezone.utc)
    lease = lease_minutes() if lease is None else lease
    held = runs.holders_of(run)
    holder = held[-1] if held else {}
    since = holder.get("since") or run.get("started_at")
    seen = [run.get("beat_at"), since, run.get("started_at")]
    s = await db[SESSIONS].find_one({"_id": holder["session"]}) if holder.get("session") else None
    if s:
        if s.get("superseded_at") and str(s["superseded_at"]) > str(since or ""):
            return "the session working on it restarted"
        seen.append(s.get("last_seen"))
    else:
        seen.append(await _last_line(db, run.get("room"), since))
    last = max((d for d in map(_dt, seen) if d), default=None)
    if last is None or now - last > timedelta(minutes=lease):
        return f"no sign of the session working on it for {int(lease)} min"
    return None


async def interrupt(db, rid: str, reason: str, at: str | None = None) -> dict | None:
    """Close one note's open run as interrupted; the note stays queued, so
    it is back in the queue. Returns the run, or None if it was not open."""
    from . import compute

    at = at or runs.now()
    run = await db.runs.find_one({"_id": rid})
    if not run or run.get("status") != "running":
        return None
    held = runs.holders_of(run)
    last = held[-1] if held else {}
    if held:
        held[-1] = {**last, "until": at}
    entry = {"at": at, "reason": reason, "by": last.get("by"), "session": last.get("session")}
    patch = {"status": INTERRUPTED, "holders": held,
             "interrupted": list(run.get("interrupted") or []) + [entry]}
    got = await db.runs.update_one({"_id": rid, "status": "running"}, {"$set": patch})
    if getattr(got, "matched_count", 1) == 0:
        return None                     # finished meanwhile
    room = run.get("room") or "cad"
    key = compute.run_key(room)
    cur = await db.runs.find_one({"_id": key}) or {}
    if cur.get("revision") == rid and cur.get("status") == "running":
        await db.runs.update_one({"_id": key, "status": "running"}, {"$set": patch})
    import uuid
    await db.activity.insert_one({
        "_id": uuid.uuid4().hex[:12], "at": at, "level": "warn", "room": room,
        "text": f"interrupted, requeued: {run.get('title') or rid} ({reason})",
        "by": {"type": "system", "id": "lease", "name": "lease"}})
    return {**run, **patch}


async def sweep(db, now: datetime | None = None, lease: float | None = None) -> list[dict]:
    """Give back every note whose run's holder is gone. Returns
    [{revision, title, reason}] for the ones given back now."""
    groups: dict[str, list[dict]] = {}
    async for r in db.runs.find({"status": "running"}):
        if r.get("revision"):
            groups.setdefault(r["revision"], []).append(r)
    out = []
    for rid, rows in groups.items():
        run = next((r for r in rows if r["_id"] == rid), None) or await db.runs.find_one({"_id": rid})
        if not run or run.get("status") != "running":
            continue                    # only the room's copy is open: an old run, left alone
        reason = await stale_reason(db, run, now, lease)
        if reason and await interrupt(db, rid, reason):
            out.append({"revision": rid, "title": run.get("title"), "reason": reason})
    return out


def last_interruption(run: dict | None) -> dict | None:
    """The run's last interruption while it is still the latest word on it."""
    if not run or run.get("status") != INTERRUPTED:
        return None
    got = run.get("interrupted") or []
    return got[-1] if got else None


async def unfinished(db, session: str | None = None, now: datetime | None = None) -> dict:
    """What a session starting up should pick up: notes given back,
    notes finished and waiting for review, and lines read but not answered
    by a session that is not this one."""
    from . import chat

    now = now or datetime.now(timezone.utc)
    queued = [d async for d in db.revisions.find({"status": "queued"}) if not d.get("archived")]
    ids = [d["_id"] for d in queued]
    rs = {r["_id"]: r async for r in db.runs.find({"_id": {"$in": ids}})} if ids else {}
    interrupted, review = [], []
    for d in sorted(queued, key=lambda d: d.get("queued_at") or d.get("created_at") or ""):
        r = rs.get(d["_id"])
        if last_interruption(r):
            interrupted.append({"revision": d["_id"], "comment": d.get("comment") or "",
                                "kind": d.get("kind") or "cad", "title": (r or {}).get("title"),
                                **last_interruption(r)})
        elif r and r.get("status") in ("done", "failed"):
            review.append({"revision": d["_id"], "comment": d.get("comment") or "",
                           "status": r["status"], "title": r.get("title")})
    since = (now - timedelta(days=CHAT_DAYS)).isoformat()
    lines = [d async for d in db[chat.CHAT].find({})]
    last_agent: dict[str, str] = {}
    for d in lines:
        if d.get("role") == chat.AGENT:
            room = chat.room_of(d)
            last_agent[room] = max(last_agent.get(room, ""), str(d.get("at") or ""))
    unanswered = sorted((
        d for d in lines
        if d.get("role") == chat.USER and d.get("seen_at") and str(d.get("at") or "") >= since
        and (not session or d.get("seen_session") != session)
        and str(d.get("at")) > last_agent.get(chat.room_of(d), "")), key=lambda d: d["at"])
    return {"interrupted": interrupted, "review": review, "unanswered": unanswered,
            "unread": len(await chat.unread(db))}
