"""memory_read: the workspace's pinned memory (backend/cc_memory.py), with
each item's id, who pinned it and when - the ids memory_write takes."""

from __future__ import annotations

from .. import cc_memory
from . import Ctx, Result, Tool


async def run(ctx: Ctx, args: dict) -> Result:
    rows = await cc_memory.items(ctx.db)
    if not rows:
        return Result(text="The workspace memory is empty.", say="Read the workspace memory: empty", summary="empty")
    used = sum(len(r["text"]) for r in rows)
    text = (f"Workspace memory, {len(rows)} items ({used} of {cc_memory.MAX_TOTAL} characters):\n"
            + "\n".join(cc_memory.line(r) for r in rows))
    return Result(text=text, say="Read the workspace memory: {count} items", vars={"count": len(rows)},
                  summary="\n".join(r["text"] for r in rows)[:600])


TOOL = Tool(
    name="memory_read", package="commandcode", level="read", order=60,
    label="Read the workspace memory",
    about="Reads what is pinned in the workspace's memory, with who pinned each and when.",
    description="The workspace's pinned memory - printer settings, preferred parts, projects, conventions - with "
                "each item's id, who pinned it and when. It is already in your instructions; read it again for "
                "the ids memory_write needs, or after changing it.",
    schema={"type": "object", "properties": {}},
    running="Reading the workspace memory", failed="Could not read the workspace memory",
    run=run)
