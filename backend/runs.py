"""Who holds a note's run, and starting one without stealing it.

A note's run is kept twice: under the room's key (``runs/current``,
``runs/current:pcb``) for the progress bar, and under the revision id, which
is what the card's cost is measured over. Both are written here, for the
command line (tools/revisions.py) and the API (POST /api/run/start) alike,
so the two give the same answers and the same refusals.

Every run carries ``holders``: who worked on the note and from when to
when. A holder is the agent's name (REDLINE_AGENT, or the token's) and its
transcript identity - the Claude Code session it runs in
(``CLAUDE_CODE_SESSION_ID``) and, for a sub-agent, its ``agentId``. The
session is known the moment ``start`` runs; the sub-agent id is not exposed
to the process, so it is read later from the transcript line whose tool call
ran ``start`` (backend/usage.py, ``resolve``). That identity is what the
card's cost is attributed by - not the clock alone, which also caught every
other agent working at the same time.

A second agent's ``start`` on a note that is running under somebody else
is refused. ``take_over`` hands it over on purpose: the first holder's
stretch is closed, the new one appended, and ``taken_over`` records who
took it from whom and when.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

SESSION_ENV = ("CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID")


class Busy(Exception):
    """The run cannot be started; the message says why and what to do."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def session_from_env(env=None) -> str | None:
    """The Claude Code session this process runs in, when it says."""
    env = os.environ if env is None else env
    for k in SESSION_ENV:
        v = (env.get(k) or "").strip()
        if v:
            return v
    return None


def holders_of(run: dict | None) -> list[dict]:
    """Who held the run, oldest first. A run started before holders were
    kept has one, made from its `by` and `started_at`, with no identity."""
    if not run:
        return []
    if run.get("holders"):
        return [dict(h) for h in run["holders"]]
    return [{"by": run.get("by"), "session": run.get("session"), "agent": None,
             "since": run.get("started_at"), "until": None, "resolved": False}]


def _name(h: dict | None) -> str:
    return ((h or {}).get("by") or {}).get("name") or "agent"


def same_agent(a: dict, b: dict) -> bool:
    """Whether two holders are the same agent: the same name, and nothing in
    their transcript identities that tells them apart."""
    if _name(a) != _name(b):
        return False
    if a.get("session") and b.get("session") and a["session"] != b["session"]:
        return False
    if a.get("resolved") and b.get("resolved") and a.get("agent") != b.get("agent"):
        return False
    return True


async def start(db, rid: str, title: str, room: str, by: dict, *,
                session: str | None = None, model: str | None = None,
                take_over: bool = False, force: bool = False,
                extra: dict | None = None) -> tuple[dict, str]:
    """Open (or hand over) the run of one note.

    Returns the run and what happened: "started", "resumed" (the same agent
    ran start again on its own running note - nothing is reset) or
    "taken-over". Raises Busy when the room runs another note (unless
    `force`) or this note runs under another agent (unless `take_over`).
    """
    from . import compute

    key = compute.run_key(room)
    at = now()
    cur = await db.runs.find_one({"_id": key}) or {}
    mine = await db.runs.find_one({"_id": rid}) or (
        cur if cur.get("revision") == rid else {})
    me = {"by": by, "session": session, "agent": None, "since": at,
          "until": None, "resolved": False}

    # One note per room: re-pointing the room's run while somebody else's is
    # open lets their `finish` close yours.
    if (cur.get("status") == "running" and cur.get("revision")
            and cur["revision"] != rid and not force):
        raise Busy(f"another run is open in this room: {cur['revision']} "
                   f"({cur.get('title')}) by {_name(cur)}, started "
                   f"{str(cur.get('started_at'))[:19]}. Wait for it, or "
                   "--force if it is abandoned.")

    if mine.get("status") == "running":
        held = holders_of(mine)
        last = held[-1] if held else me
        if same_agent(last, me):
            # Start run twice by the agent that holds it: keep the window
            # and what was recorded at the start, take the new title.
            doc = {**mine, "title": title or mine.get("title")}
            await _write(db, key, rid, doc)
            return doc, "resumed"
        if not take_over:
            raise Busy(f"{rid} is already running under '{_name(last)}' "
                       f"(started {str(mine.get('started_at'))[:19]}, "
                       f"\"{mine.get('title')}\"). It is not yours to start. "
                       "If that agent is gone, take it over on purpose with "
                       "--take-over; the hand-over is recorded.")
        last["until"] = at
        held[-1] = last
        held.append(me)
        doc = {**mine, "title": title or mine.get("title"), "by": by,
               "room": mine.get("room") or room, "holders": held,
               "taken_over": list(mine.get("taken_over") or []) + [{
                   "at": at, "from": last.get("by"), "to": by,
                   "from_session": last.get("session"),
                   "from_agent": last.get("agent"), "to_session": session}]}
        await _write(db, key, rid, doc)
        return doc, "taken-over"

    if not (title or "").strip():
        raise Busy("say what you are doing: start <id> \"title\"")
    doc = {"title": title, "revision": rid, "model": model, "percent": 0.0,
           "status": "running", "room": room, "started_at": at,
           "finished_at": None, "by": by, "session": session,
           "holders": [me], **(extra or {})}
    await _write(db, key, rid, doc)
    return {**doc, "_id": rid}, "started"


async def _write(db, key: str, rid: str, doc: dict) -> None:
    # A second copy keyed by the revision: "current" is overwritten by the
    # next run, and the window and holders this one was worked under are
    # what its cost is measured over.
    body = {k: v for k, v in doc.items() if k != "_id"}
    body["revision"] = rid
    await db.runs.replace_one({"_id": key}, {**body, "_id": key}, upsert=True)
    await db.runs.replace_one({"_id": rid}, {**body, "_id": rid}, upsert=True)
