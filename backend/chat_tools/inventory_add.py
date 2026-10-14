"""inventory_add: things on hand counted in stock on the Parts page, as
its stock view's Add does (POST /api/inventory/bulk, backend/inventory.py
`add_many`): one or several at once; the same thing already counted - the
same product, MPN or LCSC number, else the same name in the same unit - is
topped up rather than made twice, and the answer says which.

Every line counts a Parts product: the one named in `catalog` (a site's,
the LCSC drawer's, a saved McMaster-Carr or GrabCAD item, a My Items product), the
drawer's part an LCSC number names, or - for a thing with no product yet -
a My Items product made from its words (backend/inventory.py `_home`).
The answer names the product of each line."""

from __future__ import annotations

from .. import inventory as inv
from .. import lcsc as lc
from . import Ctx, Result, Tool, ToolError, clip
from ._inventory import ITEM_PROPS, amount, need, product

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
            lines.append(f"- merged into the stock line already kept {d['_id']} \"{d.get('name')}\": +{inv.qty(q)}, "
                         f"now {amount(d)}{where}")
        else:
            lines.append(f"- added new stock line {d['_id']} \"{d.get('name')}\": {amount(d)}{where}")
        if d.get("catalog"):
            made = (d["catalog"].get("manufacturer") == "own" and not (raw or {}).get("catalog")
                    and not r["merged"])
            lines[-1] += f" - counts the Parts product {product(d)}" + (" (made in My Items)" if made else "")
    if not added and not merged:
        raise ToolError("nothing was added: " + "; ".join(f"{r.get('name') or '?'}: {r['error']}" for r in bad))
    text = (f"Stock: {len(added)} added, {len(merged)} merged into lines already kept"
            + (f", {len(bad)} not added" if bad else "") + ".\n" + "\n".join(lines))
    names = ", ".join(r["item"].get("name") or "" for r in got if "item" in r)
    if len(got) == 1 and merged:
        say, vars_ = "Topped up {name} in stock", {"name": names}
    elif len(got) == 1:
        say, vars_ = "Added {name} to stock", {"name": names}
    else:
        say, vars_ = "Added {n} lines to stock ({m} merged)", {"n": len(added) + len(merged), "m": len(merged)}
    return Result(text=clip(text), say=say, vars={**vars_, "items": names[:300]}, summary="\n".join(lines)[:600])


TOOL = Tool(
    name="inventory_add", package="mfr", level="change", order=82, default=True,
    label="Add to stock",
    about="Counts things on hand in stock on the Parts page; the same thing already counted is topped up, not doubled.",
    description="Count things the person has on hand in stock (the Parts page: every stock line counts one Parts "
                "product) - one or several in `items`, each with a quantity and its unit and, when known, where it is "
                "kept. Say which product each is: `catalog` {manufacturer, product} for a product in Parts - ids from "
                "manufacturer_search (a site's id, or the built-in sources lcsc, mcmaster, grabcad, own) or words of "
                "their names (\"Doğuş\", \"20 mm menteşe\") - or `lcsc` for a part in the LCSC drawer. A thing with "
                "no product in Parts yet (filament, own screws, a cable made up) needs only a `name` (and its "
                "category, part number, maker, price when known): it is made a product of Parts > My Items first, "
                "or counted under the My Items product of that name or code already there. Its type (filament, screw, "
                "electronic...) is worked out from its name - give `type` only when the person says it or the name "
                "would not tell. A product already counted (or the same MPN or LCSC number, or the same name in the "
                "same unit) is topped up: its quantity goes up and the answer says so; it is never doubled. The "
                "answer names the Parts product of each line. Use it when the person says they got, bought or have "
                "something and want it counted. `reason`: what happened, for the log (\"order 1043 arrived\").",
    schema={"type": "object", "properties": {
        "items": {"type": "array", "description": "The things to add", "items": {
            "type": "object", "properties": ITEM_PROPS, "required": ["quantity"]}},
        "reason": {"type": "string", "description": "Why, for the log"}}, "required": ["items"]},
    running="Adding to stock", failed="Could not add to stock",
    run=run)
