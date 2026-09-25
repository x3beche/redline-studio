"""Notes: what a person jots down while working, without a form.

A note is text and nothing else to fill in. What would be fields elsewhere
is read out of the text: the first line is its title, `#words` are its
tags, `@names` point at models and boards, and `- [ ]` lines are to-dos.
Where it was written - the room, and the model, board or app open there -
comes along on its own. A note can be handed to a room's agent, which
then gets it as a message in that room's thread.

Notes belong to the workspace (backend/scope.py) and say who wrote them.
"""

from __future__ import annotations

import re
import secrets
from datetime import datetime, timezone

COLL = "notes"

TAG = re.compile(r"(?<![\w#&/])#([^\W\d_][\w\-]*)", re.UNICODE)
MENTION = re.compile(r"(?<![\w@])@([\w][\w\-./]*)", re.UNICODE)
TODO = re.compile(r"^\s*[-*] \[( |x|X)\]\s", re.MULTILINE)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def title_of(text: str) -> str:
    """The first line with words in it, without its markdown."""
    for line in text.splitlines():
        t = re.sub(r"^\s*(#{1,6}\s+|[-*]\s+\[[ xX]\]\s+|[-*+]\s+|>\s*)", "", line).strip()
        # Tags at the end of the line are labels, not words of the title;
        # one in the middle of a sentence is a word ("the #pwm curve").
        t = re.sub(r"(\s+#[^\W\d_][\w\-]*)+\s*$", "", t, flags=re.UNICODE)
        t = TAG.sub(lambda m: m.group(1), t).strip()
        if t:
            return t[:120]
    return ""


def read(text: str) -> dict:
    """What the text says about itself."""
    todos = TODO.findall(text)
    # A heading ("# Title") is not a tag: the pattern wants a word right
    # after the #, and a heading has a space there.
    # Nor is a colour (#ff0000): hex with a digit in it.
    tags = sorted({t.lower() for t in TAG.findall(text)
                   if not (re.fullmatch(r"[0-9a-fA-F]{3,8}", t) and re.search(r"\d", t))})
    mentions = sorted(set(MENTION.findall(text)))
    return {"title": title_of(text), "tags": tags, "mentions": mentions,
            "todo": {"open": sum(1 for t in todos if t == " "), "done": sum(1 for t in todos if t != " ")}}


async def create(db, text: str, context: dict | None, by: dict) -> dict:
    now = _now()
    doc = {"_id": secrets.token_hex(6), "text": text, **read(text),
           "context": context or {}, "pinned": False, "by": by,
           "created_at": now, "updated_at": now}
    await db[COLL].insert_one(doc)
    return doc


async def listing(db, q: str = "", tag: str = "", only: str = "", me: str = "", limit: int = 300) -> list[dict]:
    query: dict = {}
    if q:
        query["text"] = {"$regex": re.escape(q), "$options": "i"}
    if tag:
        query["tags"] = tag.lower().lstrip("#")
    if only == "pinned":
        query["pinned"] = True
    elif only == "todo":
        query["todo.open"] = {"$gt": 0}
    elif only == "mine" and me:
        query["by.id"] = me
    cur = db[COLL].find(query).sort([("pinned", -1), ("updated_at", -1)]).limit(min(limit, 1000))
    return [d async for d in cur]


async def tags(db) -> list[dict]:
    rows = [r async for r in db[COLL].aggregate([
        {"$unwind": "$tags"}, {"$group": {"_id": "$tags", "n": {"$sum": 1}}}, {"$sort": {"n": -1}}])]
    return [{"tag": r["_id"], "n": r["n"]} for r in rows]


async def update(db, nid: str, text: str | None = None, pinned: bool | None = None) -> dict | None:
    patch: dict = {}
    if text is not None:
        patch.update({"text": text, **read(text), "updated_at": _now()})
    if pinned is not None:
        patch["pinned"] = pinned
    if not patch:
        return await db[COLL].find_one({"_id": nid})
    from pymongo import ReturnDocument
    return await db[COLL].find_one_and_update({"_id": nid}, {"$set": patch}, return_document=ReturnDocument.AFTER)


async def remove(db, nid: str) -> bool:
    return bool((await db[COLL].delete_one({"_id": nid})).deleted_count)


def as_message(doc: dict) -> str:
    """A note, as the agent gets it in a room's thread."""
    ctx = doc.get("context") or {}
    where = ", ".join(f"{k} {v}" for k, v in ctx.items() if k != "room" and v)
    head = "From a note" + (f" (written with {where} open)" if where else "") + ":"
    return f"{head}\n\n{doc['text']}"
