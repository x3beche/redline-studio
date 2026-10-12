"""inventory_adjust: an item's quantity changed by +/- with a reason, as
the item page's buttons do (POST /api/inventory/{id}/adjust,
backend/inventory.py `adjust`) - kept in its log: "used 4 for the fan
board"."""

from __future__ import annotations

from .. import inventory as inv
from . import Ctx, Result, Tool, ToolError
from ._inventory import amount, need, one


async def run(ctx: Ctx, args: dict) -> Result:
    d = await one(ctx.db, args.get("item"))
    need("POST", f"/api/inventory/{d['_id']}/adjust")
    reason = str(args.get("reason") or "").strip()[:300]
    if not reason:
        raise ToolError("give `reason`: what happened (used for a board, found more, counted again...)")
    try:
        got = await inv.adjust(ctx.db, d["_id"], args.get("change"), reason, ctx.actor or None)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc
    delta = got["quantity"] - float(d.get("quantity") or 0)
    sign = "+" if delta > 0 else ""
    return Result(text=f"{got['_id']} \"{got.get('name')}\": {sign}{inv.qty(delta)}, was {amount(d)}, now {amount(got)}"
                       + (" - LOW, at or below its minimum." if inv.is_low(got) else "."),
                  say="{name}: {change}, now {now}",
                  vars={"name": got.get("name") or got["_id"], "change": f"{sign}{inv.qty(delta)}", "now": amount(got),
                        "item": got["_id"]},
                  summary=f"{amount(d)} -> {amount(got)} · {reason}")


TOOL = Tool(
    name="inventory_adjust", package="inventory", level="change", order=22, default=True,
    label="Change a quantity",
    about="Raises or lowers how many of an item are on hand, with the reason kept in its log.",
    description="Change how many of an inventory item are on hand by `change` (negative to take some: -4 for four "
                "used), with `reason` kept in the item's log (\"used 4 for the fan board\"). It cannot go below zero. "
                "`item`: its id (inventory_search) or name. Use it when the person says they used, lost, found or "
                "counted something already kept; for something new use inventory_add.",
    schema={"type": "object", "properties": {
        "item": {"type": "string", "description": "The item's id or name"},
        "change": {"type": "number", "description": "How many to add (positive) or take (negative)"},
        "reason": {"type": "string", "description": "What happened, for the log"}},
        "required": ["item", "change", "reason"]},
    running="Changing a quantity in the inventory", failed="Could not change the quantity",
    run=run)
