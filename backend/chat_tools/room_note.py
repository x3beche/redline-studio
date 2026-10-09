"""room_note: a note (a task) into the 3D, PCB or Firmware room's queue -
what a ```task block's "Send to queue" does (backend/tasks.py `_file`:
the note form's own route, then queued), about one model, board or
firmware of the workspace."""

from __future__ import annotations

from .. import access, actors, tasks
from . import Ctx, Result, Tool, ToolError

ROOMS = {"cad": "cad", "3d": "cad", "model": "cad", "pcb": "pcb", "board": "pcb", "firmware": "firmware"}
NAME = {"cad": "3D", "pcb": "PCB", "firmware": "Firmware"}
THING = {"cad": "model", "pcb": "board", "firmware": "firmware"}
SAY = {r: f"Queued a note for the {n} room: {{title}}" for r, n in NAME.items()}


async def run(ctx: Ctx, args: dict) -> Result:
    # The same right the "Send to queue" button needs (backend/access.py).
    who = access.current()
    if not access.allowed(who, "run"):
        raise ToolError(access.refusal(who or "nobody", "run"))
    room = ROOMS.get(str(args.get("room") or "").strip().lower())
    if not room:
        raise ToolError("room is one of cad (3D), pcb or firmware")
    target = str(args.get("target") or "").strip()
    title = " ".join(str(args.get("title") or "").split())[:200]
    body = str(args.get("body") or "").strip()
    if not body:
        raise ToolError("the note has no body: say what is to be done")
    if not await tasks.exists(ctx.db, room, target):
        there = [t["id"] for t in await tasks.targets(ctx.db, room)]
        raise ToolError(f"no {THING[room]} {target!r} in this workspace for the {NAME[room]} room"
                        + (f"; there are: {', '.join(there[:40])}" if there else ""))
    text = tasks.note_text({"title": title or None, "body": body})
    if len(text) > 4000:
        raise ToolError("a note is at most 4000 characters - make it shorter")
    source = {"kind": "ai", "chat": ctx.chat, "message": "", "index": -1, "title": title or None,
              "tool": "room_note"}
    note = await tasks._file(ctx.db, room, target, text, source)
    await actors.audit(ctx.db, "queue-task", note["id"], {"from": source})
    shown = title or body.splitlines()[0][:80]
    return Result(text=f"Queued note {note['id']} for the {NAME[room]} room, about {target}: {shown!r}. "
                       "Its agent picks it up from the queue.",
                  say=SAY[room], vars={"title": shown, "room": room, "target": target, "note": note["id"]},
                  summary=f"{note['id']} · {target}")


TOOL = Tool(
    name="room_note", level="change", order=80, default=False,
    label="Leave a note in a room",
    about="Leaves a note in the 3D, PCB or Firmware room's queue, for its agent.",
    description="Leave a note (a task) in the queue of the 3D room (cad: a model), the PCB room (pcb: a board) "
                "or the Firmware room (firmware), about one model, board or firmware - as sending a task "
                "block to the queue does; that room's agent picks it up. Use it only when the person asks "
                "for a note or task to be queued, once per task. `target` is the id (model_read, board_read "
                "or firmware_build list them).",
    schema={"type": "object", "properties": {
        "room": {"type": "string", "enum": ["cad", "pcb", "firmware"], "description": "Which room's queue"},
        "target": {"type": "string", "description": "The model, board or firmware id it is about"},
        "title": {"type": "string", "description": "One line: what is to be done"},
        "body": {"type": "string", "description": "The note itself, plain text or Markdown"}},
        "required": ["room", "target", "body"]},
    running="Queueing a note", failed="Could not queue the note",
    run=run)
