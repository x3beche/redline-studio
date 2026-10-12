"""chat_archive: this conversation (ctx.chat) archived - as the list's
Archive does (PATCH /api/cc/chats/{id} with archived): kept whole, out of
the list until Archived is shown."""

from __future__ import annotations

from . import Ctx, Result, Tool, ToolError
from ._rights import need


async def run(ctx: Ctx, args: dict) -> Result:
    from .. import cc_chat
    if not ctx.chat:
        raise ToolError("there is no conversation to archive here")
    need("PATCH", f"/api/cc/chats/{ctx.chat}")
    res = await ctx.db[cc_chat.COLL].update_one({"_id": ctx.chat, **cc_chat.LIVE}, {"$set": {"archived": True}})
    if not getattr(res, "matched_count", 1):
        raise ToolError("this conversation is gone (deleted or in the trash)")
    return Result(text="This conversation is archived: kept whole, shown under Archived in the list.",
                  say="Archived this chat", summary="archived")


TOOL = Tool(
    name="chat_archive", package="commandcode", level="change", order=30, default=False,
    label="Archive this chat",
    about="Archives this conversation, when asked.",
    description="Archive this conversation, as the list's Archive does: it is kept whole and shown under Archived. "
                "Use it only when asked to archive this chat.",
    schema={"type": "object", "properties": {}},
    running="Archiving this chat", failed="Could not archive this chat",
    run=run)
