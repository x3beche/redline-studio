"""catalog_edit_product: one product of a maker's catalog changed, as the
Parts page's product editor does (PATCH /api/manufacturers/{mid}/products/{pid},
backend/manufacturers.py `edit_product`): only the fields given; a changed
product is kept through the next full exploration."""

from __future__ import annotations

from .. import manufacturers as mf
from . import Ctx, Result, Tool, ToolError
from ._catalog import edit_product, line, link, maker, need, product
from .catalog_add_product import PRODUCT_PROPS, fields


async def run(ctx: Ctx, args: dict) -> Result:
    need("PATCH", "/api/manufacturers/x/products/x")
    doc = await maker(ctx.db, args.get("manufacturer"))
    p = product(doc, args.get("product"))
    sets = args.get("set")
    if not isinstance(sets, dict) or not sets:
        raise ToolError("give `set`: the fields to change, e.g. {\"sku\": \"PLA-175-GR\"}")
    need("PATCH", f"/api/manufacturers/{doc['_id']}/products/{p['id']}")
    try:
        f = fields(sets, patch=True)
        if "specs" in f and isinstance(f["specs"], dict) and not args.get("replace_specs"):
            # The specs as they are kept where the product lives: a saved McMaster-Carr / GrabCAD part is shown
            # with the catalog's own list of specs beside its own (its title, its licence, what its CAD measured).
            was = (p.get("linked") or {}).get("specs") or p.get("specs") or {}
            f["specs"] = {**was, **f["specs"]}
        got = await edit_product(ctx.db, doc["_id"], p["id"], f, ctx.actor or None)
    except (mf.Clash, ValueError, LookupError) as exc:
        raise ToolError(str(exc).strip("'\"")) from exc
    changed = ", ".join(k for k in f) or "nothing"
    name = doc.get("name") or doc["_id"]
    return Result(text=f"Changed {changed} of a product of \"{name}\" ({doc['_id']}): {line(got)}",
                  say="Changed {fields} of {product} in the catalog",
                  vars={"fields": changed, "product": got["name"], "name": name, "m": doc["_id"], "link": link(doc["_id"])},
                  summary=line(got)[:600])


TOOL = Tool(
    name="catalog_edit_product", package="mfr", level="change", order=72, default=False,
    label="Edit a catalog product",
    about="Changes a product in a maker's catalog: its name, code, category, description, specs, price, stock, page or picture.",
    description="Change one product in Parts. `manufacturer`: the maker's id or name; `product`: the "
                "product's id (manufacturer_search gives them) or its name or code; `set`: only the fields to "
                "change (name, category, sku, description, specs, url, image, price, currency, vat, list_price, "
                "stock, stock_qty - a new price is remembered in the product's price history; price \"\" takes it "
                "away). `specs` given are added to the "
                "product's specs (a spec of the same name replaced) unless `replace_specs` is true. A part saved "
                "from GrabCAD or McMaster-Carr is changed the same way, by its maker's id and the id product_find "
                "gives it (\"grabcad:<model>\"): its name and its specs are that part's own title and specs, and a "
                "field it has not - a code, a price, a stock - is refused. An LCSC drawer part is not changed here; "
                "a copy of it kept as My Items (product_to_my_items) is. Use it only "
                "when the person asks to correct or change a product.",
    schema={"type": "object", "properties": {
        "manufacturer": {"type": "string", "description": "The maker's id or name"},
        "product": {"type": "string", "description": "The product's id, name or code"},
        "set": {"type": "object", "properties": PRODUCT_PROPS, "description": "The fields to change"},
        "replace_specs": {"type": "boolean", "description": "Replace the specs instead of adding to them"}},
        "required": ["manufacturer", "product", "set"]},
    running="Editing a catalog product", failed="Could not edit the catalog product",
    run=run)
