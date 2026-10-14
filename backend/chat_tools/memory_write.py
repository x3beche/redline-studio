"""memory_write: add to, change or remove from the workspace's pinned
memory (backend/cc_memory.py). Adding and changing run; removing asks the
person first (`asks`). Never a secret: cc_memory refuses anything that
looks like a key, a token or a password."""

from __future__ import annotations

from .. import access, cc_memory
from . import Ctx, Result, Tool, ToolError


def _strings(v) -> list[str]:
    if isinstance(v, str):
        v = [v]
    return [str(x) for x in (v or []) if str(x).strip()]


async def run(ctx: Ctx, args: dict) -> Result:
    if not access.allowed(access.current(), "edit"):
        raise ToolError("changing the workspace memory needs the right to edit - ask someone who may")
    add, rm = _strings(args.get("add")), _strings(args.get("remove"))
    edits = [e for e in (args.get("edit") or []) if isinstance(e, dict) and e.get("id")]
    if not (add or rm or edits):
        raise ToolError("say what to add, edit or remove")
    done, refused = [], []
    for text in add:
        try:
            item = await cc_memory.add(ctx.db, text)
            done.append(f"added [{item['id']}] {item['text']}")
        except cc_memory.Refused as exc:
            refused.append(f"not added ({exc}): {text[:80]}")
    for e in edits:
        try:
            item = await cc_memory.edit(ctx.db, str(e["id"]), str(e.get("text") or ""))
            done.append(f"changed [{item['id']}] to: {item['text']}")
        except cc_memory.Refused as exc:
            refused.append(f"not changed [{e['id']}]: {exc}")
    for iid in rm:
        try:
            item = await cc_memory.remove(ctx.db, iid)
            done.append(f"removed [{iid}] {item['text']}")
        except cc_memory.Refused as exc:
            refused.append(f"not removed: {exc}")
    if not done:
        raise ToolError("; ".join(refused))
    text = "\n".join(done + refused)
    return Result(text=text, say="Changed the workspace memory: {count} changes", vars={"count": len(done)},
                  summary=text[:600])


TOOL = Tool(
    name="memory_write", package="commandcode", level="change", order=61,
    label="Change the workspace memory",
    about="Adds to the workspace's memory, changes an item, or removes one (asking first).",
    description="Pin what this workspace should always know - a printer's settings, the screws they prefer, a "
                "project's name, a convention - in its memory, which goes with every conversation here. Use it "
                "when the person asks you to remember something, or to correct an item; one short fact per item "
                f"(at most {cc_memory.MAX_CHARS} characters). Removing an item asks the person first. Never save "
                "keys, tokens or passwords: they are refused.",
    schema={"type": "object", "properties": {
        "add": {"type": "array", "items": {"type": "string"}, "description": "new items, one fact each"},
        "edit": {"type": "array", "items": {"type": "object", "properties": {
            "id": {"type": "string"}, "text": {"type": "string"}}, "required": ["id", "text"]},
            "description": "items to reword, by id (memory_read gives the ids)"},
        "remove": {"type": "array", "items": {"type": "string"}, "description": "ids of items to remove (asks first)"}}},
    running="Changing the workspace memory", failed="Could not change the workspace memory",
    asks=lambda args: bool(_strings((args or {}).get("remove"))),
    run=run)
