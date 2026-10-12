"""note_write: a new note in the Notes tab, as POST /api/notes keeps one
(backend/notes.py `create`): the text is the note, its first line the
title, #words its tags, '- [ ]' lines its to-dos; written by the asker,
from the Chat, with the model or board it is about if one is named."""

from __future__ import annotations

from .. import actors, notes
from . import Ctx, Result, Tool, ToolError
from ._notes import NOTE_STYLE, head, need

MAX = 20_000                                     # as the API's NoteIn


async def run(ctx: Ctx, args: dict) -> Result:
    need("POST", "/api/notes")
    text = str(args.get("text") or "").strip()
    if not text:
        raise ToolError("the note has no text")
    if len(text) > MAX:
        raise ToolError(f"a note is at most {MAX} characters - make it shorter")
    context = {"room": "commandcode",
               **{k: str(args[k]).strip()[:200] for k in ("model", "board") if str(args.get(k) or "").strip()}}
    by = ctx.actor or actors.current() or {}
    d = await notes.create(ctx.db, text, context, by)
    return Result(text=f"Kept note {d['_id']}: {head(d)}", say="Wrote note {title}",
                  vars={"title": d.get("title") or d["_id"], "note": d["_id"]}, summary=head(d))


TOOL = Tool(
    name="note_write", package="notes", level="change", order=14, default=False,
    label="Write a note",
    about="Writes a new note in the Notes tab.",
    description="Write a new note in the Notes tab, as the person would jot it down: the first line is its title, "
                "#words are tags, @names point at models and boards, '- [ ] ' lines are to-dos. Use it only when "
                "asked to write or keep a note (not for a task for a room's agent - that is room_note). `model` or "
                "`board`: the id it is about, if any. " + NOTE_STYLE,
    schema={"type": "object", "properties": {
        "text": {"type": "string", "description": "The note: a title line, then the rest (Markdown)"},
        "model": {"type": "string", "description": "A 3D model's id it is about"},
        "board": {"type": "string", "description": "A board's id it is about"}}, "required": ["text"]},
    running="Writing a note", failed="Could not write the note",
    run=run)
