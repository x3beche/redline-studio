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
  notes finished and waiting for review, lines read before the restart
  that nobody answered, and answers to an ``ask`` that came after the
  session asking had gone. Shown, not done: nothing here acts on them.

A room's sub-agent runs in its main session (the same Claude Code session
id) under a name of its own (``REDLINE_AGENT="3d room"``), so a session's
heartbeat is kept per agent name as well (``agents``): the note a sub-agent
holds lives by that sub-agent's own commands, not by its main session's
``wait`` - a sub-agent that dies while the session goes on is requeued
after the lease. Waiting (``wait``) says the session is there, not that it
is working on anything.

When is a holder gone (``stale_reason``): its session was superseded since
it took the note, or nothing below is newer than the lease, newest first
from the cheapest:

1. the run itself - taken, picked up again, its progress moved (``beat_at``);
2. its agent's own commands in this session (``agents.<name>``), or, for a
   session recorded before beats were kept per agent, any command of the
   session; for a session that never left a heartbeat at all (started
   before there were any), the newest line in the run's room log;
3. its agent's own lines in the room log;
4. its tool activity: the transcript Claude Code writes as it works - the
   sub-agent's own (``<session>/subagents/agent-<id>.jsonl``, by the id the
   run's start resolved to, or the sub-agent transcripts that name the
   note), the main thread's for the session's own agent;
5. a process still running under the session and agent name (a long build
   writes nothing anywhere until it ends: ``REDLINE_AGENT`` and the session
   id are in its environment), ``revisions.py wait`` not counted;
6. for the session's own agent in tmux, the tmux session's last activity.

4-6 are looked at only when 1-3 are stale. 5 and 6 are only seen from the
machine the agents run on: the page's sweep (the API, in its container)
does not see them, so it gives a note back only after ``BLIND_FACTOR``
times the lease - the command line, which every waiting agent runs every
half minute, decides first.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import runs

SESSIONS = "agent_sessions"
INTERRUPTED = "interrupted"
# How long a session may go without running a command before what it holds
# is given back. `wait` beats every half minute while the agent idles, and
# the room agents run a command every few minutes while they work.
LEASE_MIN = 45
# Lines read before a restart older than this are history, not asks.
CHAT_DAYS = 2
# Where the agents' processes and tmux cannot be seen (the API), a note is
# given back only after this many leases.
BLIND_FACTOR = 3
# An answer the asking `ask` has not taken this long after it came: the
# asker is gone (it looks every 3 s), so the answer is offered to the next.
ANSWER_GRACE = timedelta(minutes=2)


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


def name_key(agent: str | None) -> str:
    """An agent's name as a field name (no dots, no leading $)."""
    return re.sub(r"[.$]", "_", (agent or "agent").strip() or "agent")


async def beat(db, session: str | None, agent: str, at: str | None = None,
               seat: str | None = None, work: bool = True) -> None:
    """This session is alive - and, with `work`, this agent in it (a room's
    sub-agent shares its main session's id). `wait` beats without: waiting
    is not working on a note. Nothing to do without a session id."""
    if not session:
        return
    at = at or runs.now()
    await db[SESSIONS].update_one(
        {"_id": session},
        {"$set": {"last_seen": at, "per_agent": True,
                  **({f"agents.{name_key(agent)}": at} if work else {}),
                  **({"seat": seat} if seat else {})},
         # The session's own agent: the one that registered it (`resume`),
         # else the first that ran a command in it.
         "$setOnInsert": {"agent": agent, "first_seen": at, "superseded_at": None}},
        upsert=True)


async def register(db, session: str | None, agent: str, seat: str | None = None) -> list[dict]:
    """A session starting up in `seat`: the earlier ones there are over.
    Returns them (the ones not marked before)."""
    at = runs.now()
    seat = seat or "agent:" + agent
    await beat(db, session, agent, at, seat)
    if not session:
        return []
    await db[SESSIONS].update_one({"_id": session}, {"$set": {"agent": agent}})
    old = [s async for s in db[SESSIONS].find({"seat": seat, "superseded_at": None})
           if s["_id"] != session]
    for s in old:
        await db[SESSIONS].update_one({"_id": s["_id"]},
                                      {"$set": {"superseded_at": at, "superseded_by": session}})
    return old


async def _last_line(db, room: str | None, since: str | None, by: str | None = None) -> str | None:
    """The newest log line in the run's room after `since` - anybody's, or
    only those written by the agent named `by`."""
    newest = None
    q = db.activity.find({"room": room or "cad"}, {"at": 1, "by": 1}).sort("at", -1)
    async for a in q.limit(1 if by is None else 200):
        if by is None or ((a.get("by") or {}).get("name") == by):
            newest = a.get("at")
            break
    return newest if newest and (not since or str(newest) > str(since)) else None


def _mtime(p: Path) -> datetime | None:
    try:
        return datetime.fromtimestamp(p.stat().st_mtime, timezone.utc)
    except OSError:
        return None


_NAMES: dict[tuple, bool] = {}


def _names(p: Path, rid: str) -> bool:
    """Whether a sub-agent's transcript mentions the note (cached by size)."""
    try:
        k = (str(p), p.stat().st_size, rid)
    except OSError:
        return False
    if k not in _NAMES:
        try:
            _NAMES[k] = rid.encode() in p.read_bytes()
        except OSError:
            _NAMES[k] = False
    return _NAMES[k]


def transcript_seen(session: str | None, holder: dict, rid: str, main: bool,
                    since: datetime | None = None) -> datetime | None:
    """When the holder's transcript was last written: its tool activity.
    A sub-agent's own; the main thread's only for the session's own agent."""
    from . import usage
    if not session:
        return None
    root = Path(usage.CLAUDE_HOME) / "projects"
    if not root.is_dir():
        return None
    if holder.get("resolved"):
        if holder.get("agent"):
            files = list(root.glob(f"*/{session}/subagents/agent-{holder['agent']}.jsonl"))
        else:
            files = list(root.glob(f"*/{session}.jsonl"))
    else:
        files = [p for p in root.glob(f"*/{session}/subagents/agent-*.jsonl")
                 if (since is None or (_mtime(p) or since) >= since) and _names(p, rid)]
        if not files and main:
            files = list(root.glob(f"*/{session}.jsonl"))
    return max((t for t in map(_mtime, files) if t), default=None)


def processes() -> list[dict]:
    """The processes this user runs under a Claude Code session: its id,
    the agent name and the command line. Empty where they cannot be seen."""
    out = []
    for d in Path("/proc").glob("[0-9]*"):
        try:
            env = dict(kv.split("=", 1) for kv in (d / "environ").read_bytes()
                       .decode("utf-8", "replace").split("\0") if "=" in kv)
            sess = runs.session_from_env(env)
            if not sess:
                continue
            cmd = (d / "cmdline").read_bytes().decode("utf-8", "replace").replace("\0", " ")
        except (OSError, ValueError):
            continue
        out.append({"session": sess, "agent": (env.get("REDLINE_AGENT") or "agent").strip() or "agent",
                    "cmd": cmd})
    return out


def _working(p: dict) -> bool:
    # A waiting watcher (perhaps left behind by a sub-agent that ended) is
    # not work on a note.
    return not re.search(r"revisions\.py\s+wait\b", p["cmd"])


def process_seen(session: str | None, agent: str, now: datetime) -> datetime | None:
    """Now, while a process runs under this session and agent name."""
    if not session:
        return None
    try:
        ps = processes()
    except Exception:                       # noqa: BLE001 - a signal, not a must
        return None
    return now if any(p["session"] == session and p["agent"] == agent and _working(p)
                      for p in ps) else None


def tmux_seen(seat: str | None) -> datetime | None:
    """When the tmux session's windows last printed anything, for a seat
    that is one: Claude Code redraws its spinner and timer while it works,
    a long foreground command included, and prints nothing while idle."""
    import shutil
    import subprocess
    if not seat or not seat.startswith("tmux:") or not shutil.which("tmux"):
        return None
    try:
        got = subprocess.run(["tmux", "list-windows", "-t", seat[5:], "-F", "#{window_activity}"],
                             capture_output=True, text=True, timeout=5)
        ts = [int(x) for x in got.stdout.split() if x.isdigit()] if got.returncode == 0 else []
        return datetime.fromtimestamp(max(ts), timezone.utc) if ts else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


async def stale_reason(db, run: dict, now: datetime | None = None,
                       lease: float | None = None) -> str | None:
    """Why this open run's holder is gone, or None while it is not. The
    signs of life, cheapest first, are in this module's docstring."""
    now = now or datetime.now(timezone.utc)
    lease = lease_minutes() if lease is None else lease
    cut = now - timedelta(minutes=lease)
    held = runs.holders_of(run)
    holder = held[-1] if held else {}
    name = ((holder.get("by") or run.get("by") or {}).get("name")) or "agent"
    session = holder.get("session")
    since = holder.get("since") or run.get("started_at")
    s = await db[SESSIONS].find_one({"_id": session}) if session else None
    if s and s.get("superseded_at") and str(s["superseded_at"]) > str(since or ""):
        return "the session working on it restarted"

    def fresh(*vals) -> bool:
        return any((d := _dt(v)) and d > cut for v in vals)

    if fresh(run.get("beat_at"), since, run.get("started_at")):
        return None
    if s and s.get("per_agent"):
        own = (s.get("agents") or {}).get(name_key(name))
    elif s:
        own = s.get("last_seen")            # recorded before beats were per agent
    else:
        own = await _last_line(db, run.get("room"), since)   # before heartbeats
    if fresh(own, await _last_line(db, run.get("room"), since, by=name)):
        return None
    main = not s or name == s.get("agent")
    if (fresh(transcript_seen(session, holder, run.get("_id") or run.get("revision") or "",
                              main, _dt(since)))
            or fresh(process_seen(session, name, now))
            or (main and s and fresh(tmux_seen(s.get("seat"))))):
        return None
    return f"no sign of the session working on it for {int(lease)} min"


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
    from . import chat, questions

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
    answers = [q for q in await questions.undelivered(db, ANSWER_GRACE.total_seconds())
               if str(q.get("answered_at") or "") >= since]
    return {"interrupted": interrupted, "review": review, "unanswered": unanswered,
            "answers": answers, "unread": len(await chat.unread(db))}


async def lost_reads(db, rows: list[dict], now: datetime | None = None,
                     lease: float | None = None) -> set[str]:
    """Of these thread lines, the person's that an agent session read and
    then went away without answering (superseded, or not heard from for the
    lease): the thread marks them until an agent line in the room answers."""
    from . import chat

    now = now or datetime.now(timezone.utc)
    lease = lease_minutes() if lease is None else lease
    last_agent: dict[str, str] = {}
    for d in rows:
        if d.get("role") == chat.AGENT:
            room = chat.room_of(d)
            last_agent[room] = max(last_agent.get(room, ""), str(d.get("at") or ""))
    cand = [d for d in rows if d.get("role") == chat.USER and d.get("seen_at")
            and d.get("seen_session") and str(d.get("at")) > last_agent.get(chat.room_of(d), "")]
    gone: dict[str, bool] = {}
    for sid in {d["seen_session"] for d in cand}:
        s = await db[SESSIONS].find_one({"_id": sid}) or {}
        seen = _dt(s.get("last_seen"))
        gone[sid] = bool(s.get("superseded_at")) or not seen or now - seen > timedelta(minutes=lease)
    return {d["_id"] for d in cand if gone[d["seen_session"]]}
