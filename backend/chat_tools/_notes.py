"""What the Notes tools share (notes_search, note_read, note_write,
note_todo, note_edit): the Notes tab's own notes (backend/notes.py), read
and written through the asker's workspace (ctx.db), with the rights the
Notes API's routes need (backend/access.py) - a tool does nothing its
person could not do on the tab."""

from __future__ import annotations

import re

from .. import notes
from . import ToolError
from ._rights import need  # noqa: F401 - the notes tools' too
from ._things import find

ROOM = {"cad": "3D", "pcb": "PCB", "firmware": "Firmware", "notes": "Notes", "taste": "Taste", "mfr": "Manufacturers",
        "files": "Files", "tools": "Basic Tools", "commandcode": "Chat"}
# How a note the Chat writes should read: as a page, not a dump (the Notes
# tab shows it as one - title, tag chips, headed sections, ticked boxes).
NOTE_STYLE = ("Write it as a short, well-set Markdown page: a clear title line first (a few words), the #tags on the "
              "line under it, then a one- or two-sentence summary; sections under '## ' headings; to-dos as '- [ ] ' "
              "items; a table for comparisons and parts lists, with units in the header or the cells; no filler.")
TODO_LINE = re.compile(r"^(\s*[-*] \[)( |x|X)(\]\s)(.*)$")


async def one(db, ref: str) -> dict:
    """The note `ref` names: its id, or words of its title or text."""
    if not str(ref or "").strip():
        raise ToolError("say which note: its id (notes_search lists them)")
    return await find(db, notes.COLL, ref, ("title", "text"), "note")


def day(at) -> str:
    return str(at or "")[:16].replace("T", " ")


def todo_count(d: dict) -> str:
    t = d.get("todo") or {}
    if not (t.get("open") or t.get("done")):
        return ""
    return f"to-dos {t.get('open') or 0} open, {t.get('done') or 0} done"


def where(d: dict) -> str:
    c = d.get("context") or {}
    room = ROOM.get(c.get("room") or "", c.get("room") or "")
    thing = c.get("model") or c.get("board") or ""
    return " ".join(x for x in (room, thing) if x)


def head(d: dict) -> str:
    """One line about a note: id, title, when, who, tags, to-dos, where."""
    bits = [f"{d['_id']}  \"{d.get('title') or '(untitled)'}\"", f"updated {day(d.get('updated_at'))}"]
    if (d.get("by") or {}).get("name"):
        bits.append(f"by {d['by']['name']}")
    if d.get("tags"):
        bits.append(" ".join("#" + t for t in d["tags"]))
    if todo_count(d):
        bits.append(todo_count(d))
    if d.get("pinned"):
        bits.append("pinned")
    if where(d):
        bits.append(f"written in {where(d)}")
    if d.get("sent"):
        bits.append(f"sent to the {ROOM.get(d['sent'].get('room'), d['sent'].get('room'))} agent")
    return "  · ".join(bits)


def todos(text: str) -> list[dict]:
    """The note's to-do lines, numbered from 1: line index, done, words."""
    out = []
    for i, line in enumerate(text.split("\n")):
        m = TODO_LINE.match(line)
        if m:
            out.append({"n": len(out) + 1, "line": i, "done": m.group(2) != " ", "text": m.group(4).strip()})
    return out
