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
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

CHAT = "chat"
USER, AGENT = "user", "agent"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def post(db, text: str, role: str = USER) -> dict:
    """Add one message. An empty one is not a message."""
    text = (text or "").strip()
    if not text:
        raise ValueError("nothing to say")
    doc = {"_id": uuid.uuid4().hex[:12], "at": _now(),
           "role": AGENT if role == AGENT else USER,
           "text": text,
           # The agent's own words are read the moment they are written;
           # only the person's wait to be picked up.
           "seen_at": _now() if role == AGENT else None}
    await db[CHAT].insert_one(doc)
    return doc


async def history(db, limit: int = 200) -> list[dict]:
    rows = [d async for d in db[CHAT].find({})]
    rows.sort(key=lambda d: d["at"])
    return rows[-limit:]


async def unread(db) -> list[dict]:
    """What the person said that the agent has not picked up yet."""
    rows = [d async for d in db[CHAT].find({"role": USER, "seen_at": None})]
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


async def clear(db) -> int:
    res = await db[CHAT].delete_many({})
    return res.deleted_count
