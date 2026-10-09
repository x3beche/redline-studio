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

Each room has its own thread - `room` is cad or pcb.
What is said about a board is not something to scroll past in the 3D room,
and a room's agent reads its own. Rows from before rooms were the 3D room's.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from . import actors

CHAT = "chat"
USER, AGENT = "user", "agent"
ROOMS = ("cad", "pcb", "firmware")


def room_of(doc: dict) -> str:
    return doc.get("room") or "cad"


def _in(rows: list[dict], room: str | None) -> list[dict]:
    return rows if room is None else [d for d in rows if room_of(d) == room]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def post(db, text: str, role: str = USER,
               urgent: bool = False, room: str = "cad", mentions: list[dict] | None = None) -> dict:
    """Add one message. An empty one is not a message - a line with only
    pictures (or other files) attached is one.

    `mentions` are files from the Files tab carried by the line - pasted,
    dropped or attached in the composer - as chips (file_chips below).

    `urgent` is the difference between "when you get a moment" and "stop".
    An ordinary line waits until the agent next looks up; an urgent one is
    reported by every command the agent runs, and a build that is running
    when it arrives is killed. Which is what the person meant, if they
    took the trouble to mark it.
    """
    text = (text or "").strip()
    mentions = list(mentions or [])
    if not text and not mentions:
        raise ValueError("nothing to say")
    if room not in ROOMS:
        raise ValueError(f"no room {room!r}")
    doc = {"_id": uuid.uuid4().hex[:12], "at": _now(),
           "role": AGENT if role == AGENT else USER,
           "text": text,
           "urgent": bool(urgent) and role != AGENT,
           "room": room,
           **({"mentions": mentions} if mentions else {}),
           # Who wrote it. An agent's line is an agent's even when the
           # command line did not say which one.
           "by": (actors.current() if role != AGENT or actors.current()["type"] == "agent"
                  else actors.agent()),
           # The agent's own words are read the moment they are written;
           # only the person's wait to be picked up.
           "seen_at": _now() if role == AGENT else None}
    await db[CHAT].insert_one(doc)
    return doc


IMAGE_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif", ".tif", ".tiff", ".heic")


async def file_chips(db, ids: list[str]) -> list[dict]:
    """Files of the Files tab, as the chips a line keeps: the same shape as
    an @-mention in a conversation (backend/cc_context.py). KeyError for one
    that is not there - nothing is posted half-checked."""
    from . import files
    out, seen = [], set()
    for fid in ids:
        if fid in seen:
            continue
        seen.add(fid)
        d = await db[files.COLL].find_one({"_id": fid}, {"name": 1, "kind": 1, "bytes": 1, "content_type": 1})
        if not d:
            raise KeyError(fid)
        out.append({"kind": "file", "id": fid, "label": d.get("name") or fid,
                    "sub": f"{d.get('kind') or 'file'} · {(d.get('bytes') or 0) // 1024} kB",
                    "image": d.get("kind") == "image", "bytes": d.get("bytes") or 0})
    return out


def _is_image(m: dict) -> bool:
    return bool(m.get("image")) or str(m.get("label") or "").lower().endswith(IMAGE_EXT)


def attachment_lines(doc: dict) -> list[str]:
    """A line's attached files, as the room's agent reads them: the file id
    and the command that puts it on disk, where the Read tool can look at a
    picture."""
    out = []
    for m in doc.get("mentions") or []:
        if m.get("kind") != "file":
            continue
        name = str(m.get("label") or m["id"])
        safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in name) or m["id"]
        what = "image" if _is_image(m) else "file"
        out.append(f"[attached {what}: {name}, file id {m['id']} - fetch: "
                   f".venv/bin/python tools/revisions.py files get {m['id']} -o /tmp/{safe}"
                   + (", then open it with the Read tool to see it]" if what == "image" else "]"))
    return out


def agent_text(doc: dict) -> str:
    """A line as the agent's CLI prints it: its words, then what it carries."""
    return "\n".join([x for x in [doc.get("text") or "", *attachment_lines(doc)] if x])


def preview(doc: dict) -> str:
    """A line in a few words, for lists: its text, or what it carries."""
    if doc.get("text"):
        return doc["text"]
    names = [str(m.get("label") or "") for m in doc.get("mentions") or []]
    return ", ".join(n for n in names if n)


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


async def rooms(db, agent_tail: int = 99) -> list[dict]:
    """Every room's thread in a few lines, in ROOMS order - what the Chat
    tab's pinned "Rooms" list shows: how long, the last line, the person's
    lines still waiting to be picked up, and when the agent last wrote
    (its last `agent_tail` times), so a page can count what it has not
    read since it last looked without fetching the threads themselves."""
    rows = [d async for d in db[CHAT].find({})]
    out = []
    for room in ROOMS:
        mine = sorted((d for d in rows if room_of(d) == room), key=lambda d: d["at"])
        agent = [d["at"] for d in mine if d.get("role") == AGENT]
        waiting = [d for d in mine if d.get("role") == USER and not d.get("seen_at")]
        last = mine[-1] if mine else None
        out.append({
            "room": room, "count": len(mine),
            "last": ({"role": last.get("role"), "text": preview(last)[:200], "at": last["at"],
                      "by": (last.get("by") or {}).get("name")} if last else None),
            "waiting": len(waiting), "urgent": sum(1 for d in waiting if d.get("urgent")),
            "agent_at": agent[-agent_tail:] if agent_tail else [],
        })
    return out
