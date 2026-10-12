"""queue_read: one note of a room's queue, whole (GET /api/revisions/{id}):
its text, the summary, what it is about, its status and who moved it,
its run (who works on it, how far, since when), where it came from and
what the work changed."""

from __future__ import annotations

from .. import fwnotes
from . import Ctx, Result, Tool, ToolError, clip
from ._things import find
from .queue_list import NAME, SAID, THING, room_of, runs_of, state, who


def _at(v) -> str:
    return str(v or "")[:16].replace("T", " ")


async def run(ctx: Ctx, args: dict) -> Result:
    ref = str(args.get("note") or "").strip()
    if not ref:
        raise ToolError("say which note: its id (queue_list lists them)")
    d = await find(ctx.db, "revisions", ref, ("comment", "summary"), "queued note")
    run_ = (await runs_of(ctx.db, [d["_id"]])).get(d["_id"])
    r = room_of(d)
    st = state(d, run_)
    lines = [f"Note {d['_id']} in the {NAME[r]} room's queue: {SAID.get(st, st)}"
             + (" (archived)" if d.get("archived") else ""),
             f"About {THING[r]} {d.get('model') or '-'}" + (f", part {d['part']}" if d.get("part") else "")
             + (f", at {fwnotes.anchor_text(d.get('anchor'))}" if d.get("kind") == fwnotes.KIND else ""),
             f"Written {_at(d.get('created_at'))}" + (f" by {who(d.get('created_by'))}" if who(d.get("created_by")) else "")
             + (f"; edited {_at(d['edited_at'])}" if d.get("edited_at") else "")
             + (f"; queued {_at(d['queued_at'])}" if d.get("queued_at") else "")
             + (f"; applied {_at(d['applied_at'])}" if d.get("applied_at") else "")
             + (f"; status set by {who(d.get('status_by'))}" if who(d.get("status_by")) else "")]
    src = d.get("from_chat") or {}
    if src:
        lines.append("Filed from " + ("a Chat conversation" if src.get("kind") == "ai" else f"the {src.get('room')} room's thread")
                     + (f" ({src.get('chat')})" if src.get("chat") else "")
                     + (f" by the {src['tool']} tool" if src.get("tool") else ""))
    if run_:
        held = ", ".join(who(h.get("by")) for h in run_.get("holders") or [] if who(h.get("by")))
        pct = run_.get("percent")
        lines.append(f"Run: {run_.get('status')} \"{run_.get('title') or ''}\""
                     + (f", {round(pct)}%" if isinstance(pct, (int, float)) else "")
                     + f", started {_at(run_.get('started_at'))}"
                     + (f", finished {_at(run_['finished_at'])}" if run_.get("finished_at") else "")
                     + (f", worked on by {held}" if held else ""))
    if d.get("changes"):
        lines.append("Changed: " + ", ".join(f"{c.get('kind')} {c.get('id')} +{c.get('added') or 0}/-{c.get('removed') or 0}"
                                              for c in d["changes"]))
    if (d.get("image") or {}).get("bytes"):
        lines.append("It has a drawing (the view it was marked on)" + (" and an after picture" if (d.get("image_after") or {}).get("bytes") else "") + ".")
    if d.get("summary"):
        lines.append(f"Summary: {d['summary']}")
    lines.append("\n--- the note ---\n" + (d.get("comment") or ""))
    if d.get("comment_original") and d["comment_original"] != d.get("comment"):
        lines.append("\n--- as it was typed ---\n" + d["comment_original"])
    title = " ".join((d.get("summary") or (d.get("comment") or "").strip().split("\n")[0]).split())[:80]
    return Result(text=clip("\n".join(lines)), say="Read queued note {title}",
                  vars={"title": title or d["_id"], "state": SAID.get(st, st), "note": d["_id"], "room": r},
                  summary=f"{d['_id']} · {NAME[r]} · {SAID.get(st, st)}")


TOOL = Tool(
    name="queue_read", package="general", level="read", order=72,
    label="Read a queued note",
    about="Reads one note of a room's queue in full: its text, status, run and what it changed.",
    description="Read one note of the 3D, PCB or Firmware room's queue in full: its text (and as it was typed, "
                "if translated), summary, the model, board or firmware it is about, its status and dates, who wrote "
                "it, its run (who works on it, how far, since when), where it was filed from and what the work "
                "changed. `note` is its id (queue_list lists them) or words of it.",
    schema={"type": "object", "properties": {
        "note": {"type": "string", "description": "The queued note's id, or words of it"}}, "required": ["note"]},
    running="Reading a queued note", failed="Could not read the queued note",
    run=run)
