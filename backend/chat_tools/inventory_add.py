"""inventory_add: things on hand kept in the inventory, as the Inventory
tab's Add does (POST /api/inventory/bulk, backend/inventory.py `add_many`):
one or several at once; the same thing already kept - the same MPN or LCSC
number, else the same name in the same unit - is topped up rather than
made twice, and the answer says which. An item may name a Product Catalog
product or an LCSC part, and takes its name and part number from there
when it does not say them."""

from __future__ import annotations

from .. import inventory as inv
from .. import lcsc as lc
from . import Ctx, Result, Tool, ToolError, clip
from ._inventory import ITEM_PROPS, amount, need

MOST = 100


async def _named(ctx: Ctx, raw: dict) -> dict:
    """An item as it is kept: its catalog product found (by ids, or by words
    as the person says them), and with no name, the product's name or the
    drawer's part's. A ValueError when the product cannot be told."""
    raw = dict(raw)
    cat = raw.get("catalog")
    if isinstance(cat, dict) and (cat.get("manufacturer") or cat.get("product")):
        m, p = await inv.resolve_catalog(ctx.db, cat.get("manufacturer"), cat.get("product"))
        raw["catalog"] = {"manufacturer": m["_id"], "product": p["id"]}
        if not str(raw.get("name") or "").strip():
            raw["name"] = p.get("name") or p["id"]
    if str(raw.get("name") or "").strip():
        return raw
    c = str(raw.get("lcsc") or "").strip().upper()
    if c and lc.looks_like_a_part(c):
        try:
            part = await lc.holds(ctx.db, c)
        except Exception:                                  # noqa: BLE001 - the drawer is only a name's source
            part = None
        raw["name"] = (part or {}).get("name") or raw.get("mpn") or c
    return raw


async def run(ctx: Ctx, args: dict) -> Result:
    need("POST", "/api/inventory/bulk")
    items = args.get("items")
    if isinstance(items, dict):
        items = [items]
    if not isinstance(items, list) or not items:
        raise ToolError("give `items`: a list of things to add, each with a name and a quantity")
    if len(items) > MOST:
        raise ToolError(f"at most {MOST} items at once")
    reason = str(args.get("reason") or "").strip()[:300] or "added in the Chat"
    raws, unread = [], {}
    for i, x in enumerate(items):
        try:
            raws.append(await _named(ctx, x) if isinstance(x, dict) else x)
        except ValueError as exc:
            unread[i] = {"error": str(exc), "name": str(x.get("name") or (x.get("catalog") or {}).get("product") or "")}
            raws.append(None)
    done = iter(await inv.add_many(ctx.db, [r for r in raws if r is not None], ctx.actor or None, reason))
    got = [unread[i] if r is None else next(done) for i, r in enumerate(raws)]
    added = [r for r in got if "item" in r and not r["merged"]]
    merged = [r for r in got if r.get("merged")]
    bad = [r for r in got if "error" in r]
    lines = []
    for raw, r in zip(raws, got):
        if "error" in r:
            lines.append(f"- NOT added \"{r.get('name') or '?'}\": {r['error']}")
            continue
        d = r["item"]
        where = f" at {d['location']}" if d.get("location") else ""
        if r["merged"]:
            q = inv.number((raw or {}).get("quantity", 0), "the quantity") if isinstance(raw, dict) else 0
            lines.append(f"- merged into the item already kept {d['_id']} \"{d.get('name')}\": +{inv.qty(q)}, now "
                         f"{amount(d)}{where}")
        else:
            lines.append(f"- added new item {d['_id']} \"{d.get('name')}\": {amount(d)}{where}")
        if d.get("catalog"):
            c = d["catalog"]
            lines[-1] += f" (linked to {c.get('manufacturer_name')} / {c.get('product_name') or c.get('product')})"
    if not added and not merged:
        raise ToolError("nothing was added: " + "; ".join(f"{r.get('name') or '?'}: {r['error']}" for r in bad))
    text = (f"Inventory: {len(added)} added, {len(merged)} merged into items already kept"
            + (f", {len(bad)} not added" if bad else "") + ".\n" + "\n".join(lines))
    names = ", ".join(r["item"].get("name") or "" for r in got if "item" in r)
    if len(got) == 1 and merged:
        say, vars_ = "Topped up {name} in the inventory", {"name": names}
    elif len(got) == 1:
        say, vars_ = "Added {name} to the inventory", {"name": names}
    else:
        say, vars_ = "Added {n} items to the inventory ({m} merged)", {"n": len(added) + len(merged), "m": len(merged)}
    return Result(text=clip(text), say=say, vars={**vars_, "items": names[:300]}, summary="\n".join(lines)[:600])


TOOL = Tool(
    name="inventory_add", package="inventory", level="change", order=20, default=True,
    label="Add to the inventory",
    about="Adds things on hand to the inventory; the same thing already kept is topped up, not doubled.",
    description="Add things the person has on hand to their inventory (the Inventory tab) - one or several in "
                "`items`. Each needs a name (or a Product Catalog product / LCSC part to take it from) and a "
                "quantity with its unit; give where it is kept, its category, part numbers and maker when known. "
                "An item that is already kept - the same MPN or LCSC number, or the same name in the same unit - "
                "is merged: its quantity goes up by this one's and the answer says so; it is never doubled. When "
                "the thing came from the Product Catalog (manufacturer_search) or LCSC (lcsc_search, drawer_*), "
                "link it: `catalog` {manufacturer, product} - their ids from manufacturer_search, or words of their "
                "names (\"Doğuş\", \"20 mm menteşe\"); the item then takes the product's name, code and category, "
                "and an item already linked to that product is topped up - or `lcsc`. Use it when the person says they got, "
                "bought or have something and want it kept. `reason`: what happened, for the log (\"order 1043 "
                "arrived\").",
    schema={"type": "object", "properties": {
        "items": {"type": "array", "description": "The things to add", "items": {
            "type": "object", "properties": ITEM_PROPS, "required": ["quantity"]}},
        "reason": {"type": "string", "description": "Why, for the log"}}, "required": ["items"]},
    running="Adding to the inventory", failed="Could not add to the inventory",
    run=run)
