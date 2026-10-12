"""note_read: one note of the Notes tab, whole - its text, tags, @mentions,
its to-dos numbered (as note_todo takes them), where it was written and
whether it went to an agent."""

from __future__ import annotations

from . import Ctx, Result, Tool, clip
from ._notes import day, head, one, todos, where


async def run(ctx: Ctx, args: dict) -> Result:
    d = await one(ctx.db, str(args.get("note") or ""))
    text = d.get("text") or ""
    parts = [head(d), f"written {day(d.get('created_at'))}" + (f" in {where(d)}" if where(d) else "")]
    if d.get("mentions"):
        parts.append("mentions: " + ", ".join("@" + m for m in d["mentions"]))
    items = todos(text)
    if items:
        parts.append("to-dos (note_todo takes the number):\n" + "\n".join(
            f"  {t['n']}. [{'x' if t['done'] else ' '}] {t['text']}" for t in items))
    out = "\n".join(parts) + "\n\n--- the note ---\n" + text
    return Result(text=clip(out), say="Read note {title}", vars={"title": d.get("title") or d["_id"], "note": d["_id"]},
                  summary=head(d))


TOOL = Tool(
    name="note_read", package="notes", level="read", order=12,
    label="Read a note",
    about="Reads one note from the Notes tab in full, with its to-dos numbered.",
    description="Read one note of the Notes tab in full: its text, tags, @mentions, author, dates, where it was "
                "written, and its to-dos numbered (the numbers note_todo takes). `note` is its id (notes_search "
                "lists them) or words of its title.",
    schema={"type": "object", "properties": {
        "note": {"type": "string", "description": "The note's id, or words of its title"}}, "required": ["note"]},
    running="Reading a note", failed="Could not read the note",
    run=run)
