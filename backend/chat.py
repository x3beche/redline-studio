"""A line to the agent, for everything that is not a revision.

A revision is a mark on a model: it says "this corner, 2 mm". Plenty of
what a person wants to say is not that - move these models into a folder,
rename that one, why is this build so slow, what is in the queue. Those
have had nowhere to go but a terminal the person is not looking at.

So: a thread. The page posts, the agent reads and answers, both sides see
the same rows. It is deliberately not the revision queue - nothing here
changes a model by itself, and nothing here is work until the agent says
what it did.

`seen_at` is what makes the agent's idle wait work: a message nobody has
read yet is what brings it back, the same way a queued revision does.

Each room has its own thread - `room` is cad, pcb, web, embedded or mobile.
What is said about a board is not something to scroll past in the 3D room,
and a room's agent reads its own. Rows from before rooms were the 3D room's.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from . import actors

CHAT = "chat"
USER, AGENT = "user", "agent"
ROOMS = ("cad", "pcb", "web", "embedded", "mobile")


def room_of(doc: dict) -> str:
    return doc.get("room") or "cad"


def _in(rows: list[dict], room: str | None) -> list[dict]:
    return rows if room is None else [d for d in rows if room_of(d) == room]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def post(db, text: str, role: str = USER,
               urgent: bool = False, room: str = "cad") -> dict:
    """Add one message. An empty one is not a message.

    `urgent` is the difference between "when you get a moment" and "stop".
    An ordinary line waits until the agent next looks up; an urgent one is
    reported by every command the agent runs, and a build that is running
    when it arrives is killed. Which is what the person meant, if they
    took the trouble to mark it.
    """
    text = (text or "").strip()
    if not text:
        raise ValueError("nothing to say")
    if room not in ROOMS:
        raise ValueError(f"no room {room!r}")
    doc = {"_id": uuid.uuid4().hex[:12], "at": _now(),
           "role": AGENT if role == AGENT else USER,
           "text": text,
           "urgent": bool(urgent) and role != AGENT,
           "room": room,
           # Who wrote it. An agent's line is an agent's even when the
           # command line did not say which one.
           "by": (actors.current() if role != AGENT or actors.current()["type"] == "agent"
                  else actors.agent()),
           # The agent's own words are read the moment they are written;
           # only the person's wait to be picked up.
           "seen_at": _now() if role == AGENT else None}
    await db[CHAT].insert_one(doc)
    return doc


async def interrupts(db, room: str | None = None) -> list[dict]:
    """Unread urgent messages - the reason to stop whatever is running."""
    rows = _in([d async for d in db[CHAT].find(
        {"role": USER, "seen_at": None, "urgent": True})], room)
    rows.sort(key=lambda d: d["at"])
    return rows


async def history(db, limit: int = 200, room: str | None = None) -> list[dict]:
    """The thread, oldest first: one room's, or every room's."""
    rows = _in([d async for d in db[CHAT].find({})], room)
    rows.sort(key=lambda d: d["at"])
    return rows[-limit:]


async def unread(db, room: str | None = None) -> list[dict]:
    """What the person said that the agent has not picked up yet."""
    rows = _in([d async for d in db[CHAT].find({"role": USER, "seen_at": None})], room)
    rows.sort(key=lambda d: d["at"])
    return rows


async def mark_seen(db, ids: list[str]) -> int:
    if not ids:
        return 0
    res = await db[CHAT].update_many(
        {"_id": {"$in": ids}, "seen_at": None}, {"$set": {"seen_at": _now()}})
    return res.modified_count


async def retract(db, mid: str) -> bool:
    """Take a message back, while nobody has picked it up.

    Only the person's own lines, and only while `seen_at` is still empty:
    once the agent has read it the thing may already be half done, and a
    message that vanishes after it was acted on leaves the answer talking
    to nothing.
    """
    res = await db[CHAT].delete_one({"_id": mid, "role": USER,
                                     "seen_at": None})
    return res.deleted_count > 0


async def clear(db, room: str | None = None) -> int:
    if room is None:
        return (await db[CHAT].delete_many({})).deleted_count
    ids = [d["_id"] for d in await history(db, 10 ** 9, room)]
    return (await db[CHAT].delete_many({"_id": {"$in": ids}})).deleted_count


async def last_room(db) -> str:
    """Where the person last said something - where an answer belongs."""
    rows = [d async for d in db[CHAT].find({"role": USER})]
    return room_of(max(rows, key=lambda d: d["at"])) if rows else "cad"
