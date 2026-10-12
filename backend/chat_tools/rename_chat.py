"""rename_chat: this conversation (ctx.chat) given a new title - as
renaming it in the list does (PATCH /api/cc/chats/{id}, backend/cc_chat.py
`rename`), so every open tab's list shows it."""

from __future__ import annotations

from . import Ctx, Result, Tool, ToolError
from ._rights import need

MAX = 120                                    # as the API's ChatPatch


async def run(ctx: Ctx, args: dict) -> Result:
    from .. import cc_chat
    if not ctx.chat:
        raise ToolError("there is no conversation to rename here")
    need("PATCH", f"/api/cc/chats/{ctx.chat}")
    title = " ".join(str(args.get("title") or "").split()).strip("\"'“”‘’ ")
    if not title:
        raise ToolError("say the new title")
    title = title[:MAX]
    got = await cc_chat.rename(ctx.db, ctx.chat, title)
    if got is None:
        raise ToolError("this conversation is gone (deleted or in the trash)")
    return Result(text=f"This conversation is now titled \"{got}\".", say="Renamed this chat to “{title}”",
                  vars={"title": got}, summary=got)


TOOL = Tool(
    name="rename_chat", package="commandcode", level="change", order=10,
    label="Rename this chat",
    about="Gives this conversation a new title, when asked.",
    description="Give this conversation a new title (at most 120 characters), as renaming it in the list does. "
                "Use it only when asked to rename or retitle the chat, with the title asked for (or a short one "
                "that says what the conversation is about, if asked for a better title).",
    schema={"type": "object", "properties": {
        "title": {"type": "string", "description": "The new title"}}, "required": ["title"]},
    running="Renaming this chat", failed="Could not rename this chat",
    run=run)
