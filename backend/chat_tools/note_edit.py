"""note_edit: a note's text changed - as editing it on the Notes tab
(PATCH /api/notes/{id}, backend/notes.py `update`): the new text is the
whole note, its title, tags and to-dos read out of it again."""

from __future__ import annotations

from .. import notes
from . import Ctx, Result, Tool, ToolError
from ._notes import NOTE_STYLE, head, need, one
from .note_write import MAX


async def run(ctx: Ctx, args: dict) -> Result:
    d = await one(ctx.db, str(args.get("note") or ""))
    need("PATCH", f"/api/notes/{d['_id']}")
    text = str(args.get("text") or "").strip()
    if not text:
        raise ToolError("give the note's whole new text (to delete a note, the person does it on the Notes tab)")
    if len(text) > MAX:
        raise ToolError(f"a note is at most {MAX} characters - make it shorter")
    before = d.get("text") or ""
    if text != before:
        d = await notes.update(ctx.db, d["_id"], text) or d
    return Result(text=f"Note {d['_id']} " + ("saved" if text != before else "unchanged (the same text)")
                       + f": {head(d)}",
                  say="Edited note {title}", vars={"title": d.get("title") or d["_id"], "note": d["_id"]},
                  summary=head(d))


TOOL = Tool(
    name="note_edit", package="notes", level="change", order=18, default=False,
    label="Edit a note",
    about="Changes a note's text in the Notes tab.",
    description="Change a note in the Notes tab: `text` is its whole new text (read it with note_read first and "
                "keep what should stay - its title line, #tags, to-dos). Use it only when asked to change a note; "
                "to tick a to-do use note_todo. " + NOTE_STYLE,
    schema={"type": "object", "properties": {
        "note": {"type": "string", "description": "The note's id, or words of its title"},
        "text": {"type": "string", "description": "The note's whole new text"}}, "required": ["note", "text"]},
    running="Editing a note", failed="Could not edit the note",
    run=run)
