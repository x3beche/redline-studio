"""inventory_read: one stock line in full (backend/inventory.py) - the
Parts product it counts, its quantity, place and the log of what happened
to it."""

from __future__ import annotations

from . import Ctx, Result, Tool, clip
from ._inventory import amount, block, one


async def run(ctx: Ctx, args: dict) -> Result:
    d = await one(ctx.db, args.get("item"))
    return Result(text=clip(block(d, 60)), say="Read the stock of {name}",
                  vars={"name": d.get("name") or d["_id"], "item": d["_id"]},
                  summary=amount(d) + (f" · {d['location']}" if d.get("location") else ""))


TOOL = Tool(
    name="inventory_read", package="mfr", level="read", order=81,
    label="Read a stock line",
    about="Reads one stock line in full: its product, where it is, its minimum and its log.",
    description="One stock line in full: the Parts product it counts (maker, name, page, its id), quantity, place, "
                "minimum, category, part numbers, notes, and its log - every quantity change with who and why. "
                "`item`: its id (from inventory_search) or words of its product's name.",
    schema={"type": "object", "properties": {
        "item": {"type": "string", "description": "The stock line's id or its product's name"}}, "required": ["item"]},
    running="Reading a stock line", failed="Could not read the stock line",
    run=run)
