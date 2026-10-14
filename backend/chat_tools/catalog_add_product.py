"""catalog_add_product: products added to a maker's catalog by hand, as the
Parts page's "Add a product" does (POST /api/manufacturers/{mid}/products,
backend/manufacturers.py `add_product`): one or several, `source: "manual"`,
kept through a full exploration; one with the same code (or, without one,
the same name) as a product already there is refused, as the page refuses
it, and the answer says which."""

from __future__ import annotations

from pydantic import ValidationError

from .. import manufacturers as mf
from . import Ctx, Result, Tool, ToolError, clip
from ._catalog import add_product, checked, for_site, line, link, looks_like_url, made_for, maker, need

MOST = 50

PRODUCT_PROPS = {
    "name": {"type": "string", "description": "The product's name, as the maker or shop gives it"},
    "category": {"type": "string", "description": "e.g. Filament, Hinges, Bearings"},
    "sku": {"type": "string", "description": "Its code / SKU / part number"},
    "description": {"type": "string", "description": "A short description (up to 600 characters)"},
    "specs": {"type": "object", "description": "Specs as {name: value}, e.g. {\"Diameter\": \"1.75 mm\", "
                                              "\"Weight\": \"1 kg\", \"Price\": \"499 TRY\"}",
              "additionalProperties": {"type": "string"}},
    "url": {"type": "string", "description": "Its page (http(s))"},
    "image": {"type": "string", "description": "Its picture's address (http(s))"},
    "price": {"type": "string", "description": "Its price: a number (362.60), or as the seller writes it "
                                                           "(\"362,60 TL + KDV\"); \"\" takes it away"},
    "currency": {"type": "string", "description": "The price's currency: TRY, USD, EUR... (TL is TRY)"},
    "vat": {"type": "string", "enum": ["incl", "excl", ""], "description": "Whether the price includes VAT (KDV dahil: "
                                                                           "incl; + KDV / KDV hariç: excl)"},
    "list_price": {"type": "string", "description": "The price before a discount, when there is one"},
    "stock": {"type": "string", "description": "The seller's stock: \"in\", \"out\", or its words (\"Son 3 adet\")"},
    "stock_qty": {"type": "integer", "description": "How many the seller has, when it says"},
}


def fields(raw: dict, patch: bool = False) -> dict:
    """A product's fields as the API takes them (ProductIn / ProductPatch):
    `code` is its sku, spec values are text; a ValueError says what is wrong."""
    if not isinstance(raw, dict):
        raise ValueError("a product is an object with at least a name")
    f = {k: raw[k] for k in PRODUCT_PROPS if k in raw and raw[k] is not None}
    if raw.get("code") is not None and "sku" not in f:
        f["sku"] = raw["code"]
    for k in ("name", "category", "sku", "description", "url", "image", "currency", "vat"):
        if k in f and not isinstance(f[k], str):
            f[k] = str(f[k])
    if isinstance(f.get("price"), str) and not f["price"].strip() and not patch:
        f.pop("price")
    if isinstance(f.get("specs"), dict):
        f["specs"] = {str(k): (", ".join(map(str, v)) if isinstance(v, list) else str(v))
                      for k, v in f["specs"].items() if v is not None}
    try:
        got = (mf.ProductPatch if patch else mf.ProductIn).model_validate(f)
    except ValidationError as exc:
        e = exc.errors()[0]
        raise ValueError(f"{'.'.join(map(str, e.get('loc') or ())) or 'product'}: {e.get('msg')}") from None
    return got.model_dump(exclude_unset=patch)


async def _maker(ctx: Ctx, args: dict, items: list) -> tuple[dict, bool]:
    ref = str(args.get("manufacturer") or "").strip()
    site = str(args.get("site") or "").strip()
    if ref and not looks_like_url(ref):
        return await maker(ctx.db, ref), False
    site = site or ref
    if site:
        site = await checked(site)
        doc = await for_site(ctx.db, site)
        if doc:
            return doc, False
        return await made_for(ctx.db, site, str(args.get("maker_name") or ""), ctx.actor or None), True
    # No maker named: the one kept for the products' own pages' site.
    pages = [str(x.get("url") or "") for x in items if isinstance(x, dict) and x.get("url")]
    found = {d["_id"]: d for d in [await for_site(ctx.db, u) for u in pages] if d}
    if len(found) == 1:
        return next(iter(found.values())), False
    raise ToolError("say which manufacturer the products go to: `manufacturer` (its id or name - "
                    "manufacturer_search lists them), or `site` (its website: the maker kept for it, or a new one "
                    "made for it)")


async def run(ctx: Ctx, args: dict) -> Result:
    need("POST", "/api/manufacturers")
    items = args.get("products")
    if isinstance(items, dict):
        items = [items]
    if not isinstance(items, list) or not items:
        raise ToolError("give `products`: a list of products, each with at least a name")
    if len(items) > MOST:
        raise ToolError(f"at most {MOST} products at once")
    doc, made = await _maker(ctx, args, items)
    mid, name = doc["_id"], doc.get("name") or doc["_id"]
    need("POST", f"/api/manufacturers/{mid}/products")
    added, lines = [], []
    for x in items:
        label = str((x or {}).get("name") or "?") if isinstance(x, dict) else "?"
        try:
            p = await add_product(ctx.db, mid, fields(x), ctx.actor or None)
        except mf.Clash as exc:
            lines.append(f"- NOT added \"{label}\": {exc} - edit that one (catalog_edit_product) instead")
            continue
        except (ValueError, LookupError) as exc:
            lines.append(f"- NOT added \"{label}\": {str(exc).strip(chr(39) + chr(34))}")
            continue
        added.append(p)
        lines.append(f"- added {line(p)}")
    madeline = f"A new manufacturer was made for the site: {mid} \"{name}\" ({doc.get('url')}).\n" if made else ""
    if not added:
        raise ToolError(madeline + "nothing was added:\n" + "\n".join(lines))
    text = (f"{madeline}The catalog of \"{name}\" ({mid}): {len(added)} product(s) added by hand"
            + (f", {len(items) - len(added)} not" if len(added) < len(items) else "")
            + f". The [id]s are how inventory_add counts them in stock. Open it: {link(mid)}\n" + "\n".join(lines))
    if len(items) == 1:
        say, v = "Added {product} to the catalog of {name}", {"product": added[0]["name"]}
    else:
        say, v = "Added {n} products to the catalog of {name}", {"n": len(added)}
    return Result(text=clip(text), say=say, vars={"name": name, "m": mid, "link": link(mid), **v},
                  summary="\n".join(lines)[:600])


TOOL = Tool(
    name="catalog_add_product", package="mfr", level="change", order=71, default=True,
    label="Add a product to the catalog",
    about="Adds products to a maker's catalog by hand: name, code, category, specs, page, picture.",
    description="Add one or several products to a maker's catalog in Parts by hand, from details "
                "the person gives (or that you read). `manufacturer`: the maker's id or words of its name "
                "(manufacturer_search lists them); or `site`: the maker's website - the maker kept for that site "
                "is used, or a new one is made for it (named `maker_name`, else from the host). Each product needs "
                "a name; give its code/SKU, category, a short description, specs as {name: value}, its price "
                "(`price` with `currency` and `vat`: incl or excl - \"+ KDV\" is excl), the seller's stock, its page "
                "and picture when known. A "
                "product with the same code (or, without one, the same name) as one already in the catalog is not "
                "added again - the answer says so; change that one with catalog_edit_product. To read a product "
                "page from the web instead, use catalog_read_page.",
    schema={"type": "object", "properties": {
        "manufacturer": {"type": "string", "description": "The maker's id or name"},
        "site": {"type": "string", "description": "Or the maker's website: its maker is used, or made"},
        "maker_name": {"type": "string", "description": "The name of a maker made for `site`"},
        "products": {"type": "array", "description": "The products to add",
                     "items": {"type": "object", "properties": PRODUCT_PROPS, "required": ["name"]}}},
        "required": ["products"]},
    running="Adding to the catalog", failed="Could not add to the catalog",
    run=run)
