"""inventory_remove: stock lines taken off for good, as the stock view's
Delete on the Parts page does (DELETE /api/inventory/{id},
backend/inventory.py) - a delete-level tool, so the person is asked first.
Someone else's line needs the right to delete, as on the page. The Parts
product a line counted stays (catalog_remove_product removes that)."""

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
        raise ToolError("give `items`: the ids or product names of the stock lines to remove")
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
    return Result(text="Removed from stock (their Parts products stay): " + "; ".join(f"{d['_id']} \"{d.get('name')}\" ({amount(d)})"
                                                                for d in docs),
                  say="Removed {names} from stock", vars={"names": names[:300], "n": len(docs)},
                  summary=names[:600])


TOOL = Tool(
    name="inventory_remove", package="mfr", level="delete", order=85, default=True,
    label="Remove from stock",
    about="Deletes stock lines - asks you first. Their Parts products stay.",
    description="Delete stock lines for good (their log goes with them; the Parts product each counted stays). The "
                "person is asked to allow it before it runs. `items`: their ids (inventory_search) or product names. "
                "Use it only when asked to stop counting something - not when some were used up (that is "
                "inventory_adjust to zero, which keeps the line and its log).",
    schema={"type": "object", "properties": {
        "items": {"type": "array", "items": {"type": "string"}, "description": "The stock lines' ids or product names"}},
        "required": ["items"]},
    running="Removing from stock", failed="Could not remove from stock",
    run=run)
