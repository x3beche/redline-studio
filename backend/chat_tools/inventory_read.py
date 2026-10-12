"""inventory_read: one inventory item in full (backend/inventory.py) - its
fields, links and the log of what happened to it."""

from __future__ import annotations

from . import Ctx, Result, Tool, clip
from ._inventory import amount, block, one


async def run(ctx: Ctx, args: dict) -> Result:
    d = await one(ctx.db, args.get("item"))
    return Result(text=clip(block(d, 60)), say="Read {name} from the inventory",
                  vars={"name": d.get("name") or d["_id"], "item": d["_id"]},
                  summary=amount(d) + (f" · {d['location']}" if d.get("location") else ""))


TOOL = Tool(
    name="inventory_read", package="inventory", level="read", order=12,
    label="Read an inventory item",
    about="Reads one item on hand in full: where it is, its part numbers, links and its log.",
    description="One item of the inventory in full: quantity, place, category, part numbers, maker, the Product "
                "Catalog product or LCSC part it is linked to, price, notes, and its log - every quantity change with "
                "who and why. `item`: its id (from inventory_search) or words of its name.",
    schema={"type": "object", "properties": {
        "item": {"type": "string", "description": "The item's id or name"}}, "required": ["item"]},
    running="Reading an inventory item", failed="Could not read the inventory item",
    run=run)
