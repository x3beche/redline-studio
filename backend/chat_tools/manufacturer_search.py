"""manufacturer_search: the workspace's manufacturers (backend/manufacturers.py)
- the makers whose sites were explored, with their catalogs - listed, one
read whole, or their products searched by words and category, across all
of them or within one."""

from __future__ import annotations

from .. import inventory as inv
from .. import manufacturers as mf
from . import Ctx, Result, Tool, ToolError, clip
from ._things import find

SHOW = 40                  # products a search names


def _line(d: dict) -> str:
    n = len(d.get("products") or [])
    bits = [f"{d['_id']}  \"{d.get('name') or d['_id']}\"  {d.get('url')}  {n} products"]
    if d.get("explored_at"):
        bits.append(f"explored {d['explored_at'][:10]}")
    else:
        bits.append("not explored yet")
    line = "  ".join(bits)
    if d.get("notes"):
        line += f"\n    notes: {d['notes'][:300]}"
    if d.get("categories"):
        line += "\n    categories: " + ", ".join(d["categories"][:20])
    return line


async def _listing(ctx: Ctx) -> Result:
    found = await mf.listing(ctx.db)
    if not found:
        return Result(text="There are no manufacturers in this workspace. The person adds one by its website in "
                           "the Manufacturers tab.", say="No manufacturers here", summary="none")
    text = (f"{len(found)} manufacturer(s) in this workspace. Read one's catalog with `manufacturer`, or search "
            "products with `query` (and `category`):\n" + "\n".join(_line(d) for d in found))
    return Result(text=clip(text), say="Listed {n} manufacturers", vars={"n": len(found)},
                  summary="\n".join(f"{d.get('name')} · {len(d.get('products') or [])} products" for d in found[:20]))


async def run(ctx: Ctx, args: dict) -> Result:
    ref = str(args.get("manufacturer") or "").strip()
    q = str(args.get("query") or "").strip()
    cat = str(args.get("category") or "").strip()
    if not ref and not q and not cat:
        return await _listing(ctx)
    one = await find(ctx.db, mf.COLL, ref, ("name", "domain", "url"), "manufacturer") if ref else None
    stock = await inv.stock_of(ctx.db)
    if one and not q and not cat:
        text = mf.block(one, 22_000, stock.get(one["_id"], {}))
        text += ("\nEach product's [id] is how inventory_add links it; [in stock: ...] is what the inventory holds "
                 "of it.")
        return Result(text=clip(text), say="Read the catalog of {name}", vars={"name": one.get("name") or one["_id"]},
                      summary=f"{len(one.get('products') or [])} products · {', '.join((one.get('categories') or [])[:6])}")
    docs = [one] if one else await mf.listing(ctx.db)
    if not docs:
        raise ToolError("there are no manufacturers in this workspace - the person adds one in the Manufacturers tab")
    try:
        limit = max(1, min(int(args.get("limit") or SHOW), 100))
    except (TypeError, ValueError):
        limit = SHOW
    hits = mf.search(docs, q, cat, limit)
    where = f"\"{one.get('name')}\"" if one else f"{len(docs)} manufacturer(s)"
    what = " ".join(x for x in (f"\"{q}\"" if q else "", f"in category \"{cat}\"" if cat else "") if x)
    if not hits:
        cats = sorted({c for d in docs for c in d.get("categories") or []})[:40]
        text = (f"No product of {where} matches {what}. Catalogs are written in the site's own language - "
                "try the word in that language (Turkish: menteşe for hinge, rulman for bearing, vida for screw), "
                "a synonym, or fewer words." + (f" Categories there: {', '.join(cats)}." if cats else ""))
        return Result(text=text, say="Nothing found for {q}", vars={"q": q or cat}, summary="no match")
    lines = []
    for d, p, _ in hits:
        lines.append(f"- {d.get('name')} ({d['_id']}): " + mf.product_line(p, 10, stock.get(d["_id"], {}))
                     + (f" [image {p['image']}]" if p.get("image") else ""))
    text = (f"{len(hits)} product(s) of {where} for {what}, best matches first. The manufacturer's (id) and the "
            "product's [id] are how inventory_add links one; [in stock: ...] is what the inventory holds of it:\n"
            + "\n".join(lines))
    return Result(text=clip(text), say="Found {n} products for {q}", vars={"n": len(hits), "q": q or cat},
                  summary="\n".join(f"{d.get('name')} · {p['name']}" for d, p, _ in hits[:15]))


TOOL = Tool(
    name="manufacturer_search", package="mfr", level="read", order=69,
    label="Search the manufacturers",
    about="Lists the saved manufacturers, reads one's catalog, or searches their products by words and category.",
    description="The manufacturers this workspace keeps (the Manufacturers tab): makers whose websites were explored, "
                "each with a summary, the person's notes on when to use them, categories and a product catalog "
                "(name, category, description, specs such as dimensions and materials, code, product page, and - when "
                "its page showed them - its price with currency and VAT, the seller's stock and the site it is sold on, "
                "with the date they were read). "
                "Without arguments it lists them. With `manufacturer` (an id or words of its name) it reads that "
                "one's whole catalog. With `query` (words) and/or `category` it searches the products - across "
                "all manufacturers, or only that one's when `manufacturer` is given too. Catalogs keep the site's "
                "language (often Turkish): search with words in that language as well, and try again with a "
                "synonym or fewer words when nothing matches. Use it when the person needs a part or product from "
                "a maker, or says to look at a manufacturer; quote the product page links it returns.",
    schema={"type": "object", "properties": {
        "manufacturer": {"type": "string", "description": "The manufacturer's id or name; leave out for all of them"},
        "query": {"type": "string", "description": "Words to find in the products: name, code, specs (e.g. \"menteşe 20 mm\")"},
        "category": {"type": "string", "description": "Only products in a category whose name holds this"},
        "limit": {"type": "integer", "description": "At most this many products (default 40, at most 100)"}}},
    running="Looking in the manufacturers' catalogs", failed="Could not read the manufacturers",
    run=run)
