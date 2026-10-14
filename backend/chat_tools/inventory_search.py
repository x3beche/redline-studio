"""inventory_search: what is on hand (backend/inventory.py: the stock of
the Parts page) - every stock line, or those matching words, a category, a
place or only the low ones - with their quantities, where they are and the
Parts product each counts."""

from __future__ import annotations

from .. import inventory as inv
from .. import inventory_types as kinds
from . import Ctx, Result, Tool, ToolError, clip
from ._inventory import amount, line

SHOW = 80


async def run(ctx: Ctx, args: dict) -> Result:
    q = str(args.get("query") or "").strip()
    cat = str(args.get("category") or "").strip()
    loc = str(args.get("location") or "").strip()
    low = bool(args.get("low"))
    typ = str(args.get("type") or "").strip()
    if typ:
        try:
            head_, _, tail_ = typ.partition("/")
            typ = kinds.type_id(head_) + (f"/{kinds.subtype_id(tail_)}" if tail_ else "")
        except ValueError as exc:
            raise ToolError(str(exc)) from exc
    try:
        limit = max(1, min(int(args.get("limit") or SHOW), 300))
    except (TypeError, ValueError):
        limit = SHOW
    every = await inv.everything(ctx.db)
    rows = await inv.listing(ctx.db, q, cat, loc, low, typ)
    what = ", ".join(x for x in (f"\"{q}\"" if q else "", f"type {typ}" if typ else "", f"category {cat}" if cat else "",
                                 f"at {loc}" if loc else "", "low only" if low else "") if x)
    if not every:
        return Result(text="Nothing is in stock yet: no product on the Parts page has a stock line.",
                      say="Nothing is in stock yet", summary="empty")
    if not rows:
        st = inv.stats(every)
        text = (f"No stock line of the {len(every)} matches {what}. Try fewer or other words."
                + (f" Types: {', '.join(f'{k} ({n})' for k, n in st['types'].items())}." if st["types"] else "")
                + (f" Categories: {', '.join(st['categories'][:30])}." if st["categories"] else "")
                + (f" Places: {', '.join(st['locations'][:30])}." if st["locations"] else ""))
        return Result(text=text, say="Nothing on hand matches {q}", vars={"q": q or typ or cat or loc or "low"},
                      summary="no match")
    head = (f"{len(rows)} of {len(every)} stock line(s)" + (f" for {what}" if what else "")
            + ". Read one in full (with its log) with inventory_read and its id; [maker:product] is its Parts "
              "product (manufacturer_search, catalog_edit_product):\n")
    text = head + "\n".join(line(d) for d in rows[:limit])
    if len(rows) > limit:
        text += f"\n[... {len(rows) - limit} more - narrow the search]"
    from .inventory_read import _product_of
    return Result(text=clip(text), say="Found {n} items on hand",
                  vars={"n": len(rows), **(_product_of(rows[0]) if len(rows) == 1 else {})},
                  summary="\n".join(f"{d.get('name')} · {amount(d)}" + (f" · {d['location']}" if d.get("location") else "")
                                    for d in rows[:15]))


TOOL = Tool(
    name="inventory_search", package="mfr", level="read", order=80,
    label="Search stock",
    about="Lists or searches what is on hand, with quantities and where each thing is.",
    description="The person's stock (on the Parts page: how many of each Parts product are on hand): each stock "
                "line with its quantity and unit, the product it counts, where it is kept (shelf, bin, box), its type (filament, screw, nut, washer, insert, electronic "
                "with its kind - resistor, ic, connector... -, module, cable, mechanical, tool, consumable, other), "
                "category, part numbers (MPN, LCSC) and maker; an item at or below its minimum is LOW. Without "
                "arguments it lists everything. `query`: words of the name, part numbers, maker, place, notes or tags; "
                "`type`: only that type (\"screw\", or \"electronic/resistor\" for a kind); `category`, `location`: "
                "only those; `low`: only the low ones. "
                "Use it when asked what they have, how many, or where something is - and before adding, to find the "
                "line already kept.",
    schema={"type": "object", "properties": {
        "query": {"type": "string", "description": "Words to look for"},
        "type": {"type": "string", "description": "Only this type: " + ", ".join(kinds.TYPE_IDS)
                 + "; electronic/<kind> for one kind (" + ", ".join(kinds.SUBTYPE_IDS) + ")"},
        "category": {"type": "string", "description": "Only this category"},
        "location": {"type": "string", "description": "Only items whose place holds this"},
        "low": {"type": "boolean", "description": "Only items at or below their minimum"},
        "limit": {"type": "integer", "description": "At most this many (default 80)"}}},
    running="Looking in stock", failed="Could not read the stock",
    run=run)
