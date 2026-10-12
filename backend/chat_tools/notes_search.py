"""notes_search: the Notes tab's notes (backend/notes.py), newest first -
all of them, or those holding some words, a #tag, open or finished
to-dos, the pinned ones, or the asker's own; as GET /api/notes lists them,
in the asker's workspace."""

from __future__ import annotations

from .. import actors, notes
from . import Ctx, Result, Tool, clip
from ._notes import head

SHOW = 30
MOST = 100


def _snippet(d: dict) -> str:
    rest = (d.get("text") or "").split("\n", 1)[1:] or [""]
    words = " ".join(rest[0].split())
    return words[:200] + ("…" if len(words) > 200 else "")


async def run(ctx: Ctx, args: dict) -> Result:
    words = [w.lower() for w in str(args.get("query") or "").split() if w]
    tag = str(args.get("tag") or "").strip().lstrip("#").lower()
    todo = str(args.get("todo") or "").strip().lower()
    me = (ctx.actor or {}).get("id") or (actors.current() or {}).get("id") or ""
    mine = bool(args.get("mine")) and bool(me)
    try:
        limit = max(1, min(MOST, int(args.get("limit") or SHOW)))
    except (TypeError, ValueError):
        limit = SHOW
    rows = await notes.listing(ctx.db, only="mine" if mine else "", me=me, limit=1000)
    if tag:
        rows = [d for d in rows if tag in (d.get("tags") or [])]
    if words:
        rows = [d for d in rows if all(w in (d.get("text") or "").lower() for w in words)]
    if todo == "open":
        rows = [d for d in rows if ((d.get("todo") or {}).get("open") or 0) > 0]
    elif todo == "done":
        rows = [d for d in rows if ((d.get("todo") or {}).get("done") or 0) > 0
                and not (d.get("todo") or {}).get("open")]
    if args.get("pinned"):
        rows = [d for d in rows if d.get("pinned")]
    if mine:
        rows = [d for d in rows if (d.get("by") or {}).get("id") == me]
    rows.sort(key=lambda d: str(d.get("updated_at") or d.get("created_at") or ""), reverse=True)
    asked = ", ".join(x for x in (f"words \"{' '.join(words)}\"" if words else "", f"#{tag}" if tag else "",
                                   f"{todo} to-dos" if todo in ("open", "done") else "",
                                   "pinned" if args.get("pinned") else "", "the asker's own" if mine else "") if x)
    if not rows:
        return Result(text="No note" + (f" matches {asked}." if asked else " in this workspace yet."),
                      say="No notes like that", summary="none")
    shown = rows[:limit]
    lines = [head(d) + (f"\n    {_snippet(d)}" if _snippet(d) else "") for d in shown]
    text = (f"{len(rows)} note(s)" + (f" ({asked})" if asked else "") + ", newest first"
            + (f"; the first {len(shown)}" if len(rows) > len(shown) else "")
            + ". Read one whole with note_read and its id:\n" + "\n".join(lines))
    return Result(text=clip(text), say="Listed {n} notes", vars={"n": len(rows)},
                  summary="\n".join(f"{d.get('title') or d['_id']}" for d in shown[:20]))


TOOL = Tool(
    name="notes_search", package="notes", level="read", order=10,
    label="Search the notes",
    about="Lists the notes from the Notes tab, newest first: by words, #tag, to-dos, pinned or your own.",
    description="List or search the notes people jotted down in the Notes tab (not the notes queued in a room - "
                "that is queue_list), newest first. Each note's first line is its title, #words are its tags, "
                "@names point at models and boards, '- [ ]' lines are to-dos. Filter by `query` (every word "
                "must be in the note), `tag`, `todo` (open: has unticked to-dos; done: all ticked), `pinned`, "
                "`mine` (the asker's own). Gives each note's id, title, date, author, tags, to-do counts and "
                "first words; read one whole with note_read.",
    schema={"type": "object", "properties": {
        "query": {"type": "string", "description": "Words the note holds"},
        "tag": {"type": "string", "description": "A tag, with or without #"},
        "todo": {"type": "string", "enum": ["open", "done"], "description": "Only notes with open to-dos, or with all done"},
        "pinned": {"type": "boolean", "description": "Only pinned notes"},
        "mine": {"type": "boolean", "description": "Only the asker's own notes"},
        "limit": {"type": "integer", "description": f"How many to show (default {SHOW}, at most {MOST})"}}},
    running="Looking through the notes", failed="Could not look through the notes",
    run=run)
