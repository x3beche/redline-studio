"""inventory_search: what is on hand (backend/inventory.py) - every item,
or those matching words, a category, a place or only the low ones - with
their quantities and where they are."""

from __future__ import annotations

from .. import inventory as inv
from . import Ctx, Result, Tool, clip
from ._inventory import amount, line

SHOW = 80


async def run(ctx: Ctx, args: dict) -> Result:
    q = str(args.get("query") or "").strip()
    cat = str(args.get("category") or "").strip()
    loc = str(args.get("location") or "").strip()
    low = bool(args.get("low"))
    try:
        limit = max(1, min(int(args.get("limit") or SHOW), 300))
    except (TypeError, ValueError):
        limit = SHOW
    every = await inv.everything(ctx.db)
    rows = await inv.listing(ctx.db, q, cat, loc, low)
    what = ", ".join(x for x in (f"\"{q}\"" if q else "", f"category {cat}" if cat else "",
                                 f"at {loc}" if loc else "", "low only" if low else "") if x)
    if not every:
        return Result(text="The inventory is empty: nothing has been added in the Inventory tab yet.",
                      say="The inventory is empty", summary="empty")
    if not rows:
        st = inv.stats(every)
        text = (f"No item of the {len(every)} in the inventory matches {what}. Try fewer or other words."
                + (f" Categories: {', '.join(st['categories'][:30])}." if st["categories"] else "")
                + (f" Places: {', '.join(st['locations'][:30])}." if st["locations"] else ""))
        return Result(text=text, say="Nothing on hand matches {q}", vars={"q": q or cat or loc or "low"}, summary="no match")
    head = (f"{len(rows)} of {len(every)} item(s)" + (f" for {what}" if what else "")
            + ". Read one in full (with its log) with inventory_read and its id:\n")
    text = head + "\n".join(line(d) for d in rows[:limit])
    if len(rows) > limit:
        text += f"\n[... {len(rows) - limit} more - narrow the search]"
    return Result(text=clip(text), say="Found {n} items on hand", vars={"n": len(rows)},
                  summary="\n".join(f"{d.get('name')} · {amount(d)}" + (f" · {d['location']}" if d.get("location") else "")
                                    for d in rows[:15]))


TOOL = Tool(
    name="inventory_search", package="inventory", level="read", order=10,
    label="Search the inventory",
    about="Lists or searches what is on hand, with quantities and where each thing is.",
    description="The person's inventory (the Inventory tab): the things they have on hand, each with its quantity and "
                "unit, where it is kept (shelf, bin, box), category, part numbers (MPN, LCSC) and maker; an item at or "
                "below its minimum is LOW. Without arguments it lists everything. `query`: words of the name, part "
                "numbers, maker, place, notes or tags; `category`, `location`: only those; `low`: only the low ones. "
                "Use it when asked what they have, how many, or where something is - and before adding, to find the "
                "item already kept.",
    schema={"type": "object", "properties": {
        "query": {"type": "string", "description": "Words to look for"},
        "category": {"type": "string", "description": "Only this category"},
        "location": {"type": "string", "description": "Only items whose place holds this"},
        "low": {"type": "boolean", "description": "Only items at or below their minimum"},
        "limit": {"type": "integer", "description": "At most this many (default 80)"}}},
    running="Looking in the inventory", failed="Could not read the inventory",
    run=run)
