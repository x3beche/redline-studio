"""inventory_edit: an inventory item's other fields changed - its name,
place, category, part numbers, links, minimum, price, notes, tags - as the
item page's fields are (PATCH /api/inventory/{id}, backend/inventory.py
`patch`). The quantity is inventory_adjust's: it keeps a reason."""

from __future__ import annotations

from .. import inventory as inv
from . import Ctx, Result, Tool, ToolError
from ._inventory import ITEM_PROPS, need, one

EDITABLE = [k for k in ITEM_PROPS if k != "quantity"]


async def run(ctx: Ctx, args: dict) -> Result:
    d = await one(ctx.db, args.get("item"))
    need("PATCH", f"/api/inventory/{d['_id']}")
    change = args.get("set")
    if not isinstance(change, dict) or not change:
        raise ToolError("give `set`: the fields to change and their new values")
    if "quantity" in change:
        raise ToolError("the quantity is changed with inventory_adjust, with a reason")
    unknown = [k for k in change if k not in EDITABLE]
    if unknown:
        raise ToolError(f"no field {unknown[0]!r}; the fields are {', '.join(EDITABLE)}")
    try:
        got = await inv.patch(ctx.db, d["_id"], change, ctx.actor or None)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc
    fields = ", ".join(sorted(change))
    return Result(text=f"Changed {fields} of {got['_id']} \"{got.get('name')}\".",
                  say="Changed {fields} of {name}", vars={"fields": fields, "name": got.get("name") or got["_id"],
                                                         "item": got["_id"]},
                  summary=fields)


TOOL = Tool(
    name="inventory_edit", package="inventory", level="change", order=24, default=False,
    label="Edit an inventory item",
    about="Changes an item's name, place, category, part numbers, links, minimum, price, notes or tags.",
    description="Change fields of an inventory item: `set` holds the fields and their new values (name, unit, "
                "location, category, mpn, lcsc, manufacturer, board, catalog, min_stock, price, currency, notes, "
                "tags; an empty value clears one). Not the quantity - that is inventory_adjust, with a reason. "
                "`item`: its id (inventory_search) or name. Use it only when asked to change an item.",
    schema={"type": "object", "properties": {
        "item": {"type": "string", "description": "The item's id or name"},
        "set": {"type": "object", "description": "The fields to change", "properties":
                {k: v for k, v in ITEM_PROPS.items() if k != "quantity"}}},
        "required": ["item", "set"]},
    running="Editing an inventory item", failed="Could not edit the inventory item",
    run=run)
