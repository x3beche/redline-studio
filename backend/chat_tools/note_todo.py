"""note_todo: one to-do of a note ticked or unticked - the box on the
Notes tab, which saves the note's text with that line changed
(PATCH /api/notes/{id}, backend/notes.py `update`)."""

from __future__ import annotations

from .. import notes
from . import Ctx, Result, Tool, ToolError
from ._notes import TODO_LINE, need, one, todos


def _pick(items: list[dict], which: str) -> dict:
    which = which.strip()
    if which.isdigit():
        hit = [t for t in items if t["n"] == int(which)]
    else:
        words = which.lower().split()
        hit = [t for t in items if words and all(w in t["text"].lower() for w in words)]
    if len(hit) == 1:
        return hit[0]
    listed = "; ".join(f"{t['n']}. [{'x' if t['done'] else ' '}] {t['text']}" for t in items)
    raise ToolError(("several to-dos match" if hit else f"no to-do {which!r} in this note") + f". Its to-dos: {listed}")


async def run(ctx: Ctx, args: dict) -> Result:
    d = await one(ctx.db, str(args.get("note") or ""))
    need("PATCH", f"/api/notes/{d['_id']}")
    text = d.get("text") or ""
    items = todos(text)
    if not items:
        raise ToolError("this note has no to-dos")
    t = _pick(items, str(args.get("todo") or ""))
    done = args.get("done", True) is not False
    lines = text.split("\n")
    lines[t["line"]] = TODO_LINE.sub(lambda m: m.group(1) + ("x" if done else " ") + m.group(3) + m.group(4),
                                     lines[t["line"]])
    if t["done"] != done:
        d = await notes.update(ctx.db, d["_id"], "\n".join(lines)) or d
    o = d.get("todo") or {}
    v = {"todo": t["text"][:80], "title": d.get("title") or d["_id"], "note": d["_id"]}
    return Result(text=f"To-do {t['n']} \"{t['text']}\" of note {d['_id']} is "
                       + ("ticked" if done else "not ticked") + (" (it already was)" if t["done"] == done else "")
                       + f". The note has {o.get('open') or 0} open and {o.get('done') or 0} done to-dos.",
                  say="Ticked “{todo}”" if done else "Unticked “{todo}”", vars=v,
                  summary=f"{d.get('title') or d['_id']} · {o.get('open') or 0} open")


TOOL = Tool(
    name="note_todo", package="notes", level="change", order=16, default=False,
    label="Tick a to-do",
    about="Ticks or unticks a to-do in a note.",
    description="Tick (done: true, the default) or untick (done: false) one to-do of a note in the Notes tab. "
                "`note` is the note's id or words of its title; `todo` is the to-do's number (note_read numbers "
                "them) or words of it. Use it only when asked to mark a to-do done or not done.",
    schema={"type": "object", "properties": {
        "note": {"type": "string", "description": "The note's id, or words of its title"},
        "todo": {"type": "string", "description": "The to-do's number, or words of it"},
        "done": {"type": "boolean", "description": "true ticks it (default), false unticks it"}},
        "required": ["note", "todo"]},
    running="Ticking a to-do", failed="Could not tick the to-do",
    run=run)
