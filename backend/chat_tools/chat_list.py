"""chat_list: the Chat's conversations, as its list shows them
(GET /api/cc/chats, backend/cc_chat.py): newest first, each with its title,
when it was last written in and how many lines it has - all of them, or
those whose title or lines hold some words. Archived ones and the trash
are left out unless asked for, as on the list. The asker's workspace's
own (ctx.db), which is whose the Chat API shows."""

from __future__ import annotations

import re

from . import Ctx, Result, Tool, clip

SHOW = 30
MOST = 100


def _when(v) -> str:
    return str(v or "")[:16].replace("T", " ")


async def run(ctx: Ctx, args: dict) -> Result:
    from .. import cc_chat
    words = cc_chat.terms(str(args.get("query") or "")[:200])
    trash = bool(args.get("trash"))
    archived = str(args.get("archived") or "").strip().lower()
    try:
        limit = max(1, min(MOST, int(args.get("limit") or SHOW)))
    except (TypeError, ValueError):
        limit = SHOW
    query: dict = dict(cc_chat.TRASHED if trash else cc_chat.LIVE)
    if not trash and archived == "only":
        query["archived"] = True
    elif not trash and archived != "also":
        query["archived"] = {"$ne": True}
    if words:
        query["$and"] = [{"$or": [{"title": {"$regex": re.escape(w), "$options": "i"}},
                                  {"messages.content": {"$regex": re.escape(w), "$options": "i"}}]} for w in words]
    rows = [d async for d in ctx.db[cc_chat.COLL].find(
        query, {"title": 1, "updated_at": 1, "created_at": 1, "pinned": 1, "archived": 1, "by": 1,
                "deleted_at": 1, "messages.content": 1, "messages.role": 1})]
    if words:
        rows = [d for d in rows if all(w in " ".join([d.get("title") or ""] + [m.get("content") or "" for m in
                                                                               d.get("messages") or []]).lower()
                                       for w in words)]
    rows.sort(key=lambda d: str(d.get("updated_at") or d.get("created_at") or ""), reverse=True)
    where = "in the trash" if trash else {"only": "archived", "also": ""}.get(archived, "")
    asked = " ".join(x for x in (where, f"holding \"{' '.join(words)}\"" if words else "") if x)
    if not rows:
        return Result(text="No conversation" + (f" {asked}." if asked else " here yet."),
                      say="No conversations like that", summary="none")
    shown = rows[:limit]
    lines = []
    for d in shown:
        msgs = d.get("messages") or []
        asks = sum(1 for m in msgs if m.get("role") == "user")
        lines.append(f"{d['_id']}  \"{d.get('title') or cc_chat.DEFAULT_TITLE}\"  · last {_when(d.get('updated_at'))}"
                     + f"  · {len(msgs)} lines ({asks} asked)"
                     + ("  · pinned" if d.get("pinned") else "") + ("  · archived" if d.get("archived") else "")
                     + (f"  · deleted {_when(d.get('deleted_at'))}" if d.get("deleted_at") else "")
                     + ("  · this conversation" if d["_id"] == ctx.chat else ""))
    text = (f"{len(rows)} conversation(s)" + (f" {asked}" if asked else "") + ", newest first"
            + (f"; the first {len(shown)}" if len(rows) > len(shown) else "")
            + ". Read one with chat_read and its id:\n" + "\n".join(lines))
    return Result(text=clip(text), say="Listed {n} conversations", vars={"n": len(rows)},
                  summary="\n".join(f"{d.get('title') or d['_id']}" for d in shown[:20]))


TOOL = Tool(
    name="chat_list", package="commandcode", level="read", order=20,
    label="List the conversations",
    about="Lists the Chat's conversations, newest first, or finds them by words in their titles and lines.",
    description="List the Chat's conversations (this workspace's, as the Chat's own list shows them), newest first: "
                "each one's id, title, when it was last written in and how many lines it has. `query`: only those "
                "whose title or lines hold every word. Archived ones are left out unless `archived` is also (with "
                "them) or only; `trash`: the trash instead. Read one with chat_read.",
    schema={"type": "object", "properties": {
        "query": {"type": "string", "description": "Words in the title or the lines"},
        "archived": {"type": "string", "enum": ["also", "only"], "description": "Take the archived ones too, or only them"},
        "trash": {"type": "boolean", "description": "The trash instead"},
        "limit": {"type": "integer", "description": f"How many to show (default {SHOW}, at most {MOST})"}}},
    running="Looking through the conversations", failed="Could not look through the conversations",
    run=run)
