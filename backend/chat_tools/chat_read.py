"""chat_read: one of the Chat's conversations, its lines a page at a time -
as opening it does (GET /api/cc/chats/{id}: this workspace's, and not in
the trash), with who wrote each line and when, and the tools an answer
used."""

from __future__ import annotations

from . import Ctx, Result, Tool, ToolError, clip
from ._things import find

PAGE = 20                      # lines a page
LINE = 4_000                   # characters of one line


async def run(ctx: Ctx, args: dict) -> Result:
    from .. import cc_chat
    ref = str(args.get("chat") or "").strip() or ctx.chat
    if not ref:
        raise ToolError("say which conversation: its id (chat_list lists them)")
    doc = await ctx.db[cc_chat.COLL].find_one({"_id": ref, **cc_chat.LIVE})
    if doc is None:
        hit = await find(ctx.db, cc_chat.COLL, ref, ("title",), "conversation")
        doc = await ctx.db[cc_chat.COLL].find_one({"_id": hit["_id"], **cc_chat.LIVE})
        if doc is None:
            raise ToolError(f"conversation {hit['_id']} is in the trash")
    msgs = doc.get("messages") or []
    pages = max(1, -(-len(msgs) // PAGE))
    try:
        page = int(args.get("page") or 0)
    except (TypeError, ValueError):
        page = 0
    page = pages if page <= 0 else min(page, pages)          # the last page unless asked
    part = msgs[(page - 1) * PAGE: page * PAGE]
    out = []
    for i, m in enumerate(part, (page - 1) * PAGE + 1):
        who = (m.get("by") or {}).get("name") if m.get("role") == "user" else (m.get("model") or "the model")
        body = m.get("content") or ("(error: " + m["error"] + ")" if m.get("error") else "")
        if len(body) > LINE:
            body = body[:LINE] + f" [... {len(m['content']) - LINE} more characters]"
        tools = ", ".join(str(s.get("tool")) for s in m.get("steps") or [])
        out.append(f"[{i}] {m.get('role')}" + (f" ({who})" if who else "") + f" {str(m.get('at') or '')[:16].replace('T', ' ')}"
                   + (f" - used {tools}" if tools else "") + f":\n{body}")
    title = doc.get("title") or cc_chat.DEFAULT_TITLE
    text = (f"Conversation {doc['_id']} \"{title}\"" + (" (this conversation)" if doc["_id"] == ctx.chat else "")
            + f": {len(msgs)} lines, page {page} of {pages} (lines {(page - 1) * PAGE + 1}-{(page - 1) * PAGE + len(part)})"
            + (". Earlier lines: page " + str(page - 1) if page > 1 else "") + ".\n\n" + "\n\n".join(out))
    return Result(text=clip(text), say="Read the conversation {title} · page {page} of {pages}",
                  vars={"title": title, "page": page, "pages": pages, "chat": doc["_id"]},
                  summary=f"{title} · {len(msgs)} lines")


TOOL = Tool(
    name="chat_read", package="commandcode", level="read", order=22,
    label="Read a conversation",
    about="Reads one of the Chat's conversations, a page of lines at a time.",
    description=f"Read one of the Chat's conversations (this workspace's, not in the trash): its lines, {PAGE} a "
                "page, each with who wrote it, when, and the tools an answer used. `chat` is its id (chat_list lists "
                "them) or words of its title; this conversation when left out. `page`: 1 is the first; the last "
                "page when left out.",
    schema={"type": "object", "properties": {
        "chat": {"type": "string", "description": "The conversation's id, or words of its title"},
        "page": {"type": "integer", "description": "Which page of lines (1 = the first; default the last)"}}},
    running="Reading a conversation", failed="Could not read the conversation",
    run=run)
