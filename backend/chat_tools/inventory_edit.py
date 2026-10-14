"""inventory_edit: a stock line's counting fields changed - its unit,
place, minimum, type, notes, tags, what it is for, or the Parts product it
counts - as the stock section of a product on the Parts page does (PATCH
/api/inventory/{id}, backend/inventory.py `patch`). The quantity is
inventory_adjust's: it keeps a reason. What the thing is - its name, part
numbers, maker, category, price - is its product's: catalog_edit_product."""

from __future__ import annotations

from .. import inventory as inv
from . import Ctx, Result, Tool, ToolError
from ._inventory import ITEM_PROPS, need, one

# What a stock line keeps of its own; the rest is its product's.
EDITABLE = ["unit", "location", "min_stock", "type", "subtype", "board", "notes", "tags", "catalog"]
PRODUCTS = ("name", "mpn", "lcsc", "manufacturer", "category", "price", "currency")


async def run(ctx: Ctx, args: dict) -> Result:
    d = await one(ctx.db, args.get("item"))
    need("PATCH", f"/api/inventory/{d['_id']}")
    change = args.get("set")
    if not isinstance(change, dict) or not change:
        raise ToolError("give `set`: the fields to change and their new values")
    if "quantity" in change:
        raise ToolError("the quantity is changed with inventory_adjust, with a reason")
    theirs = [k for k in change if k in PRODUCTS]
    if theirs:
        raise ToolError(f"{', '.join(theirs)} belong to the Parts product this line counts "
                        f"({(d.get('catalog') or {}).get('manufacturer')}:{(d.get('catalog') or {}).get('product')}) - "
                        "change them with catalog_edit_product")
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
    name="inventory_edit", package="mfr", level="change", order=84, default=False,
    label="Edit a stock line",
    about="Changes the unit, place, minimum, type, notes or tags of a stock line, or the Parts product it counts.",
    description="Change the counting fields of a stock line on the Parts page: `set` holds the fields and their new "
                "values (unit, location, min_stock, type, subtype, board, notes, tags; an empty value clears one - an "
                "empty type goes back to the one worked out; `catalog` {manufacturer, product} moves the line to "
                "another Parts product). Not the quantity - that is inventory_adjust, with a reason - and not what "
                "the thing is (its name, part numbers, maker, category, price): those are its product's, changed "
                "with catalog_edit_product. `item`: its id (inventory_search) or its product's name. Use it only "
                "when asked to change a stock line.",
    schema={"type": "object", "properties": {
        "item": {"type": "string", "description": "The stock line's id or its product's name"},
        "set": {"type": "object", "description": "The fields to change", "properties":
                {k: v for k, v in ITEM_PROPS.items() if k in EDITABLE}}},
        "required": ["item", "set"]},
    running="Editing a stock line", failed="Could not edit the stock line",
    run=run)
