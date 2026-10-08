"""A task written in a chat, sent to the queue with one click.

When the person asks a room's agent (or an AI conversation) to write a note
for the queue, the answer used to be text to copy into the note form. Now
the writer puts it in a fence of its own:

    ```task
    title: Move the screen above the wheel
    target: iot-fan/assemblies/base
    The note itself, as plain text or Markdown.
    ```

`title:` and `target:` are optional header lines; everything after them is
the note. The page draws each fence as a box with a "Send to queue" button
(frontend markdown.ts splitTasks - the same rules as `parse` here, so the
n-th box on screen is the n-th block here). The button posts the block's
index; the text is read from the stored message, never from the page, and
filed through the note form's own route (main.create_revision), queued.

Which block of which message became which note is kept on the message
(`tasks: {"<index>": {note_id, at, by, room, target}}` - on the line for a
room's thread, on the conversation for an AI chat), claimed with one
conditional update, so a second click - or a second person - gets 409.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, ValidationError

from . import actors

router = APIRouter()

ROOMS = ("cad", "pcb", "firmware")
OPEN = re.compile(r"^\s*```\s*task\s*$", re.I)
FENCE = re.compile(r"^\s*```")
CLOSE = re.compile(r"^\s*```\s*$")          # a fence is closed by a bare one
HEADER = re.compile(r"^\s*(title|target)\s*:\s*(.*?)\s*$", re.I)
# A claim that never got its note (the server died between the two writes)
# is free again after this long.
STALE = timedelta(minutes=2)
WHERE = {"cad": "models", "pcb": "boards", "firmware": "firmware"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _block(lines: list[str], index: int, closed: bool) -> dict:
    head: dict[str, str] = {}
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    while i < len(lines):
        m = HEADER.match(lines[i])
        if not m or m.group(1).lower() in head:
            break
        head[m.group(1).lower()] = m.group(2)
        i += 1
    body = "\n".join(lines[i:]).strip("\n").rstrip()
    return {"index": index, "title": head.get("title") or None, "target": head.get("target") or None,
            "body": body.strip(), "closed": closed}


def parse(text: str) -> list[dict]:
    """Every ```task fence in a message, in order. Other code fences are
    passed over whole (a ```task line inside one is code, not a task); a
    task fence left open at the end runs to the end."""
    out: list[dict] = []
    other = False
    task: list[str] | None = None
    for line in (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if task is not None:
            if CLOSE.match(line):
                out.append(_block(task, len(out), True))
                task = None
            else:
                task.append(line)
            continue
        if other:
            if CLOSE.match(line):
                other = False
            continue
        if OPEN.match(line):
            task = []
        elif FENCE.match(line):
            other = True
    if task is not None:
        out.append(_block(task, len(out), False))
    return out


def note_text(block: dict) -> str:
    return f"{block['title']}\n\n{block['body']}".strip() if block.get("title") else block["body"]


# ---- what a task can be about ----------------------------------------------

async def exists(db, room: str, target: str | None) -> bool:
    if not target or room not in WHERE:
        return False
    return bool(await db[WHERE[room]].find_one({"_id": target}, {"_id": 1}))


async def room_of_target(db, target: str | None) -> str | None:
    for room in ROOMS:
        if await exists(db, room, target):
            return room
    return None


async def targets(db, room: str | None = None) -> list[dict]:
    """What a task in `room` (or any room) could be filed against, for the
    picker the button opens when there is nothing to attach it to."""
    out = []
    for r in ([room] if room else ROOMS):
        if r not in WHERE:
            continue
        rows = [d async for d in db[WHERE[r]].find({}, {"_id": 1, "title": 1, "name": 1})]
        for d in sorted(rows, key=lambda d: str(d["_id"])):
            out.append({"room": r, "id": d["_id"], "label": d.get("title") or d.get("name") or d["_id"]})
    return out


# ---- filing ------------------------------------------------------------------

class QueueIn(BaseModel):
    # What the page has open in that room, or what the picker chose. Only
    # used when the block names no target of its own (or one that is gone),
    # and only if it exists.
    target: str | None = Field(default=None, max_length=300)
    # An AI conversation belongs to no room: the picker says which.
    room: str | None = Field(default=None, pattern="^(cad|pcb|firmware)$")


def _need_target(room: str | None, why: str) -> HTTPException:
    return HTTPException(422, {"need_target": True, "room": room, "message": why})


async def _resolve(db, room: str | None, block: dict, body: QueueIn) -> tuple[str, str]:
    """The room and the thing the note is about: the block's own target if
    it is real, else the page's, else the person has to pick."""
    for cand in (block.get("target"), body.target):
        if not cand:
            continue
        if room:
            if await exists(db, room, cand):
                return room, cand
        else:
            if body.room and await exists(db, body.room, cand):
                return body.room, cand
            found = await room_of_target(db, cand)
            if found:
                return found, cand
    return "", ""


async def _file(db, room: str, target: str, text: str, source: dict) -> dict:
    """Through the note form's own route, then queued as its button does."""
    from . import main, store
    try:
        body = main.RevisionIn(comment=text, model=target, kind=room)
    except ValidationError as exc:
        msg = exc.errors()[0].get("msg", "invalid")
        raise HTTPException(400, f"cannot file this as a {room} note: {msg}") from exc
    note = await main.create_revision(body)
    await store.set_status(db, note["id"], "queued")
    await db.revisions.update_one({"_id": note["id"]}, {"$set": {
        "status_by": actors.current(), "from_chat": source}})
    return note


async def queue_block(db, coll: str, doc_id: str, field: str, text: str, index: int,
                      room: str | None, body: QueueIn, source: dict) -> dict:
    """Claim block `index` (`field` is where the claims live on the
    document), file it, and record which note it became."""
    blocks = parse(text)
    if index < 0 or index >= len(blocks):
        raise HTTPException(404, f"no task {index} in this message")
    block = blocks[index]
    if not block["body"]:
        raise HTTPException(400, "this task is empty")
    if len(note_text(block)) > 4000:
        raise HTTPException(400, "this task is longer than a note may be (4000 characters)")
    key = f"{field}.{index}"
    doc = await db[coll].find_one({"_id": doc_id}, {field.split(".")[0]: 1})
    if doc is None:
        raise HTTPException(404, doc_id)
    done = _get(doc, key)
    if done and not _stale(done):
        raise HTTPException(409, {"message": "already queued", "task": done})
    where, target = await _resolve(db, room, block, body)
    if not target:
        raise _need_target(room or body.room, "pick what this task is about")
    room = where
    who = actors.current()
    claim = {"pending": True, "at": _now(), "by": {k: who.get(k) for k in ("id", "name", "type")}}
    free = {"$or": [{key: {"$exists": False}}, {key: None},
                    {f"{key}.pending": True, f"{key}.at": {"$lt": (datetime.now(timezone.utc) - STALE).isoformat()}}]}
    got = await db[coll].update_one({"$and": [{"_id": doc_id}, free]}, {"$set": {key: claim}})
    if not getattr(got, "matched_count", 0):
        now = _get(await db[coll].find_one({"_id": doc_id}) or {}, key)
        raise HTTPException(409, {"message": "already queued", "task": now})
    try:
        note = await _file(db, room, target, note_text(block),
                           {**source, "index": index, "title": block.get("title")})
    except BaseException:
        await db[coll].update_one({"_id": doc_id}, {"$unset": {key: ""}})
        raise
    done = {"note_id": note["id"], "at": claim["at"], "by": claim["by"], "room": room, "target": target}
    await db[coll].update_one({"_id": doc_id}, {"$set": {key: done}})
    await actors.audit(db, "queue-task", note["id"], {"from": source, "index": index})
    return {"task": done, "note": note["id"], "room": room, "target": target}


def _get(doc: dict, path: str):
    for part in path.split("."):
        if not isinstance(doc, dict):
            return None
        doc = doc.get(part)
    return doc


def _stale(claim: dict) -> bool:
    if not claim.get("pending"):
        return False
    try:
        at = datetime.fromisoformat(claim["at"])
    except (KeyError, TypeError, ValueError):
        return True
    return datetime.now(timezone.utc) - at > STALE


def _db():
    from .main import db
    return db()


# ---- routes ----------------------------------------------------------------
# Queueing a note is "run" (backend/access.py), whichever way it is done.

@router.get("/api/chat/task-targets")
async def task_targets(room: str | None = None):
    if room is not None and room not in ROOMS:
        raise HTTPException(400, f"no room {room!r}")
    return await targets(_db(), room)


@router.post("/api/chat/{mid}/task/{index}/queue")
async def queue_from_thread(mid: str, index: int, body: QueueIn | None = None):
    """A task block in a room's agent thread, into that room's queue."""
    from . import chat
    db = _db()
    msg = await db[chat.CHAT].find_one({"_id": mid})
    if not msg:
        raise HTTPException(404, mid)
    room = chat.room_of(msg)
    return await queue_block(db, chat.CHAT, mid, "tasks", msg.get("text") or "", index, room,
                             body or QueueIn(), {"kind": "thread", "room": room, "message": mid})


@router.post("/api/cc/chats/{cid}/messages/{ref}/task/{index}/queue")
async def queue_from_ai_chat(cid: str, ref: str, index: int, body: QueueIn | None = None):
    """A task block in an AI conversation's answer. The conversation has no
    room: the block's target says which, or the picker does."""
    from . import cc_chat
    db = _db()
    doc = await db[cc_chat.COLL].find_one({"_id": cid, **cc_chat.LIVE})
    if not doc:
        raise HTTPException(404, cid)
    msgs = doc.get("messages") or []
    i = cc_chat.find(msgs, ref)
    if i < 0 or not msgs[i].get("id"):
        raise HTTPException(404, f"no line {ref!r} in this conversation")
    m = msgs[i]
    if m.get("role") != "assistant":
        raise HTTPException(400, "only an answer's task blocks are queued from here")
    return await queue_block(db, cc_chat.COLL, cid, f"tasks.{m['id']}", m.get("content") or "", index, None,
                             body or QueueIn(),
                             {"kind": "ai", "chat": cid, "message": m["id"], "title_chat": doc.get("title")})
