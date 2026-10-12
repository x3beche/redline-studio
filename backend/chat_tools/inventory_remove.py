"""inventory_remove: items taken out of the inventory for good, as the
Inventory tab's Delete does (DELETE /api/inventory/{id}, backend/inventory.py)
- a delete-level tool, so the person is asked first. Someone else's item
needs the right to delete, as on the tab."""

from __future__ import annotations

from .. import access
from .. import inventory as inv
from . import Ctx, Result, Tool, ToolError
from ._inventory import amount, need, one

MOST = 50


async def run(ctx: Ctx, args: dict) -> Result:
    refs = args.get("items")
    if isinstance(refs, str):
        refs = [refs]
    if not isinstance(refs, list) or not refs:
        raise ToolError("give `items`: the ids or names of the items to remove")
    if len(refs) > MOST:
        raise ToolError(f"at most {MOST} items at once")
    docs = []
    for r in refs:
        d = await one(ctx.db, r)
        if d["_id"] not in {x["_id"] for x in docs}:
            docs.append(d)
    for d in docs:
        need("DELETE", f"/api/inventory/{d['_id']}")
        if not inv.may_delete(d):
            raise ToolError(f"\"{d.get('name')}\" was added by {(d.get('by') or {}).get('name') or 'someone else'}: "
                            + access.refusal(access.current() or "nobody", "delete"))
    for d in docs:
        await inv.remove(ctx.db, d["_id"])
    names = ", ".join(d.get("name") or d["_id"] for d in docs)
    return Result(text="Removed from the inventory: " + "; ".join(f"{d['_id']} \"{d.get('name')}\" ({amount(d)})"
                                                                for d in docs),
                  say="Removed {names} from the inventory", vars={"names": names[:300], "n": len(docs)},
                  summary=names[:600])


TOOL = Tool(
    name="inventory_remove", package="inventory", level="delete", order=30, default=True,
    label="Remove from the inventory",
    about="Deletes items from the inventory - asks you first.",
    description="Delete inventory items for good (their log goes with them). The person is asked to allow it "
                "before it runs. `items`: their ids (inventory_search) or names. Use it only when asked to remove "
                "or delete an item - not when some were used up (that is inventory_adjust to zero, which keeps "
                "the item and its log).",
    schema={"type": "object", "properties": {
        "items": {"type": "array", "items": {"type": "string"}, "description": "The items' ids or names"}},
        "required": ["items"]},
    running="Removing from the inventory", failed="Could not remove from the inventory",
    run=run)
