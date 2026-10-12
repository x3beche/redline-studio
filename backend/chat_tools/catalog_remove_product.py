"""catalog_remove_product: products taken out of a maker's catalog, as the
Product Catalog's Delete does (POST /api/manufacturers/{mid}/products/delete,
backend/manufacturers.py `delete_products`) - a delete-level tool, so the
person is asked first."""

from __future__ import annotations

from .. import manufacturers as mf
from . import Ctx, Result, Tool, ToolError
from ._catalog import link, maker, need, product

MOST = 100


async def run(ctx: Ctx, args: dict) -> Result:
    refs = args.get("products")
    if isinstance(refs, str):
        refs = [refs]
    if not isinstance(refs, list) or not refs:
        raise ToolError("give `products`: the ids, names or codes of the products to remove")
    if len(refs) > MOST:
        raise ToolError(f"at most {MOST} products at once")
    doc = await maker(ctx.db, args.get("manufacturer"))
    mid, name = doc["_id"], doc.get("name") or doc["_id"]
    gone: list[dict] = []
    for r in refs:
        p = product(doc, r)
        if p["id"] not in {x["id"] for x in gone}:
            gone.append(p)
    for p in gone:
        need("DELETE", f"/api/manufacturers/{mid}/products/{p['id']}")
    try:
        n = await mf.delete_products(ctx.db, mid, [p["id"] for p in gone])
    except LookupError as exc:
        raise ToolError(str(exc).strip("'\"")) from exc
    names = ", ".join(p.get("name") or p["id"] for p in gone)
    return Result(text=f"Removed {n} product(s) from the catalog of \"{name}\" ({mid}): "
                       + "; ".join(f"[{p['id']}] {p.get('name')}" for p in gone),
                  say="Removed {products} from the catalog of {name}",
                  vars={"products": names[:300], "n": n, "name": name, "m": mid, "link": link(mid)},
                  summary=names[:600])


TOOL = Tool(
    name="catalog_remove_product", package="mfr", level="delete", order=73, default=True,
    label="Remove from the catalog",
    about="Deletes products from a maker's catalog - asks you first.",
    description="Delete products from a maker's catalog in the Product Catalog. The person is asked to allow it "
                "before it runs. `manufacturer`: the maker's id or name; `products`: the products' ids "
                "(manufacturer_search gives them), names or codes. Use it only when asked to remove or delete "
                "products from the catalog.",
    schema={"type": "object", "properties": {
        "manufacturer": {"type": "string", "description": "The maker's id or name"},
        "products": {"type": "array", "items": {"type": "string"}, "description": "The products' ids, names or codes"}},
        "required": ["manufacturer", "products"]},
    running="Removing from the catalog", failed="Could not remove from the catalog",
    run=run)
