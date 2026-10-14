"""manufacturer_search: the workspace's manufacturers (backend/manufacturers.py)
- the makers whose sites were explored, with their catalogs - listed, one
read whole, or their products searched by words and category, across all
of them or within one."""

from __future__ import annotations

from .. import catalog_builtin as builtin
from .. import inventory as inv
from .. import manufacturers as mf
from . import Ctx, Result, Tool, ToolError, clip
from ._things import find

SHOW = 40                  # products a search names


def _line(d: dict) -> str:
    n = len(d.get("products") or [])
    bits = [f"{d['_id']}  \"{d.get('name') or d['_id']}\"  {d.get('url')}  {n} products"]
    if builtin.is_builtin(str(d["_id"])):
        bits.append("built-in source: the parts saved here")
    elif d.get("explored_at"):
        bits.append(f"explored {d['explored_at'][:10]}")
    else:
        bits.append("not explored yet")
    line = "  ".join(bits)
    if d.get("notes"):
        line += f"\n    notes: {d['notes'][:300]}"
    if d.get("categories"):
        line += "\n    categories: " + ", ".join(d["categories"][:20])
    return line


def _files(h: dict | None) -> str:
    """What files a product holds (backend/product_files.py), for its line: [files: 3D model STEP 6 × 6 × 27 mm, 1 datasheet]."""
    if not h:
        return ""
    bits = []
    if h.get("cad"):
        box = " × ".join(f"{x:g}" for x in h["box"]) + " mm" if h.get("box") else ""
        bits.append(f"3D model {h['cad'].upper() if h['cad'] == 'step' else 'mesh'}" + (f" {box}" if box else ""))
    for r, n in (h.get("roles") or {}).items():
        if r != "model":
            bits.append(f"{n} {r}")
    return f" [files: {', '.join(bits)}; product_files_read reads them]" if bits else ""


async def _builtins(ctx: Ctx) -> list[dict]:
    """The built-in sources (LCSC's drawer, the McMaster-Carr parts and GrabCAD
    models saved here, My Items) as makers with products - only those holding some."""
    try:
        return [d for d in await builtin.makers(ctx.db) if d.get("products")]
    except Exception:                                   # noqa: BLE001 - a source that cannot be read is left out
        return []


async def _all(ctx: Ctx) -> list[dict]:
    return [*await mf.listing(ctx.db), *await _builtins(ctx)]


def _pick(docs: list[dict], ref: str) -> dict | None:
    """A built-in source by its id or name ("lcsc", "McMaster-Carr")."""
    r = ref.strip().lower()
    return next((d for d in docs if r in (str(d["_id"]).lower(), str(d.get("name") or "").lower(),
                                         str(d.get("domain") or "").lower())), None)


async def _listing(ctx: Ctx) -> Result:
    found = await _all(ctx)
    if not found:
        return Result(text="There are no manufacturers in this workspace. The person adds one by its website on "
                           "the Parts page.", say="No manufacturers here", summary="none")
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
    one = None
    if ref:
        one = _pick(await _builtins(ctx), ref)
        if one is None:
            one = await find(ctx.db, mf.COLL, ref, ("name", "domain", "url"), "manufacturer")
    stock = await inv.stock_of(ctx.db)
    if one and not q and not cat:
        text = mf.block(one, 22_000, stock.get(one["_id"], {}))
        text += ("\nEach product's [id] is how inventory_add counts it in stock; [in stock: ...] is what is on hand "
                 "of it.")
        return Result(text=clip(text), say="Read the catalog of {name}", vars={"name": one.get("name") or one["_id"]},
                      summary=f"{len(one.get('products') or [])} products · {', '.join((one.get('categories') or [])[:6])}")
    docs = [one] if one else await _all(ctx)
    if not docs:
        raise ToolError("there are no manufacturers in this workspace - the person adds one on the Parts page")
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
                "a synonym, or fewer words. Parts not saved here can be looked up on McMaster-Carr with "
                "mcmaster_find (models on GrabCAD with grabcad_find)." + (f" Categories there: {', '.join(cats)}." if cats else ""))
        return Result(text=text, say="Nothing found for {q}", vars={"q": q or cat}, summary="no match")
    from .. import product_files as pf
    held = (await pf.summary(ctx.db))["products"]
    lines = []
    for d, p, _ in hits:
        lines.append(f"- {d.get('name')} ({d['_id']}): " + mf.product_line(p, 10, stock.get(d["_id"], {}))
                     + (f" [image {p['image']}]" if p.get("image") else "") + _files(held.get(f"{d['_id']}:{p['id']}")))
    text = (f"{len(hits)} product(s) of {where} for {what}, best matches first. The manufacturer's (id) and the "
            "product's [id] are how inventory_add counts one in stock; [in stock: ...] is what is on hand of it:\n"
            + "\n".join(lines))
    # One product found: "this product" for the product tools (backend/chat_tools/_product.py).
    one_hit = {"m": hits[0][0]["_id"], "pid": str(hits[0][1]["id"])} if len(hits) == 1 else {}
    return Result(text=clip(text), say="Found {n} products for {q}", vars={"n": len(hits), "q": q or cat, **one_hit},
                  summary="\n".join(f"{d.get('name')} · {p['name']}" for d, p, _ in hits[:15]))


TOOL = Tool(
    name="manufacturer_search", package="mfr", level="read", order=69,
    label="Search the manufacturers",
    about="Lists the saved manufacturers, reads one's catalog, or searches their products by words and category.",
    description="The manufacturers this workspace keeps (Parts): makers whose websites were explored, "
                "and the built-in sources' parts saved here - LCSC (the parts drawer), McMaster-Carr parts and GrabCAD "
                "models, and My Items (things no site sells, typed in by hand, id own) - searched with them; "
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
