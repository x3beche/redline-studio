"""dm_send: a line written to a person in the DM tab, as its composer sends
one (backend/dm.py: POST /api/dm/chats to open the conversation with
them - one per pair, made the first time - then POST
/api/dm/chats/{id}/messages): kept, and on the other person's pages at
once. No model is asked; nothing else is sent along.

It asks first, every time: the step waits with the exact text and the
person it goes to (the Chat's card shows both), and nothing is sent
without a yes. Only someone signed in as a person writes (dm.me(write)).
A line sent is not taken back by the Chat's undo: the person deletes it in
the conversation, as any of their own lines."""

from __future__ import annotations

from fastapi import HTTPException

from .. import dm
from .. import manufacturers as mf
from . import Ctx, Result, Tool, ToolError
from . import _dm
from ._rights import need


async def run(ctx: Ctx, args: dict) -> Result:
    text = str(args.get("text") or "").strip()
    if not text:
        raise ToolError("say what to send: the exact text")
    if len(text) > dm.MAX_TEXT:
        raise ToolError(f"the text is too long: at most {dm.MAX_TEXT} characters")
    who = _dm.me(write=True)
    ref = str(args.get("person") or "").strip()
    if not ref:
        raise ToolError("say who it goes to: a person's name (or a conversation's id)")
    doc, other = await _dm.thread(who["id"], ref)
    if other is None:
        raise ToolError("that conversation's other person is not on this server any more")
    # What the person allowed is the exact recipient: their whole name (or id, or the conversation's id), never
    # a part of it that happened to fit.
    if not ref.startswith("dm-") and ref != other["_id"] and mf.fold(ref) != mf.fold(other.get("name")):
        raise ToolError(f"say the person's whole name as it is written - {other.get('name')} - so the one asked "
                        "about is the one it goes to; nothing was sent")
    if other.get("disabled"):
        raise ToolError(f"{other.get('name')}'s account is disabled: nothing can be sent to them")
    try:
        if doc is None:
            need("POST", "/api/dm/chats")
            doc = {"_id": (await dm.open_chat(dm.ChatIn(people=[other["_id"]])))["id"]}
        need("POST", f"/api/dm/chats/{doc['_id']}/messages")
        line = await dm.say(doc["_id"], dm.SayIn(text=text))
    except HTTPException as exc:
        raise ToolError(str(exc.detail)) from None
    name = other.get("name") or other["_id"]
    return Result(text=f"Sent to {name} in their direct conversation {doc['_id']} ({len(text)} characters): it is on "
                       f"their pages now. Open it: /dm/{doc['_id']}",
                  say="Sent a message to {name}", vars={"name": name, "thread": doc["_id"], "line": line.get("id")},
                  summary=f"sent to {name}")


TOOL = Tool(
    name="dm_send", package="commandcode", level="change", order=41, default=False,
    label="Send a direct message",
    about="Writes a line to a person in the DM tab, after the person allows the exact text.",
    description="Send a direct message to another person of this server - as the DM tab's composer sends one: "
                "`text` exactly as it should arrive, to `person` (their name, or a conversation's id; dm_read lists the "
                "conversations). Only when the person asks to message someone; write what they "
                "asked, in their words and language. It always asks them first, showing the exact text and who it "
                "goes to; nothing is sent without their yes. It cannot be taken back from the Chat.",
    schema={"type": "object", "properties": {
        "person": {"type": "string", "description": "Who it goes to: their name, or the conversation's id (dm-...)"},
        "text": {"type": "string", "description": "The exact text to send"}},
        "required": ["person", "text"]},
    running="Sending a message to {person}", failed="Could not send the message",
    asks=lambda args: True,
    run=run, undo="a message sent is not taken back here - delete it in the conversation")
