"""What the stock tools share (inventory_search, inventory_read,
inventory_add, inventory_adjust, inventory_edit, inventory_remove): the
stock lines of the Parts page (backend/inventory.py) - how many of each
Parts product are on hand, and where - read and written through the
asker's workspace (ctx.db), with the rights the stock API's routes need
(backend/access.py): a tool does nothing its person could not do on the
page. What a thing is - its name, maker, part number, price - is its
Parts product's (catalog_edit_product changes it); a stock line counts it."""

from __future__ import annotations

from .. import inventory as inv
from .. import inventory_types as kinds
from . import ToolError
from ._rights import need  # noqa: F401 - the inventory tools' too
from ._things import find

FIELDS = ("name", "mpn", "lcsc", "location", "category", "manufacturer")

# What an item takes, for the tools' schemas (inventory_add, inventory_edit).
ITEM_PROPS = {
    "name": {"type": "string", "description": "What it is, e.g. \"M3x8 hex socket screw\" or \"IRL540N MOSFET\" - "
                                              "for a thing not in Parts yet: it is made a product of Parts > Own "
                                              "items (or the one of that name or code there is counted)"},
    "quantity": {"type": "number", "description": "How many (in `unit`)"},
    "unit": {"type": "string", "description": "pcs (default), m, cm, mm, kg, g, l, ml, roll, reel, box, pack, set, pair, "
                                              "sheet, bag - or another short word"},
    "location": {"type": "string", "description": "Where it is kept: shelf, bin, box (free text)"},
    "category": {"type": "string", "description": "e.g. Fasteners, MOSFETs, Connectors, Filament"},
    "type": {"type": "string", "enum": ["", *kinds.TYPE_IDS],
             "description": "What kind of thing it is; leave it out (or \"\") and it is worked out from the name, "
                            "category and part number - set it only when the person says or it would come out wrong"},
    "subtype": {"type": "string", "enum": ["", *kinds.SUBTYPE_IDS],
                "description": "For an electronic component: its kind (resistor, capacitor, ic, connector...)"},
    "mpn": {"type": "string", "description": "The maker's part number (a new Own items product's code)"},
    "lcsc": {"type": "string", "description": "The LCSC part number, like C25744: the drawer's part is counted "
                                              "when the drawer holds it"},
    "manufacturer": {"type": "string", "description": "Who makes it (said on a new Own items product)"},
    "board": {"type": "string", "description": "The board or model it is for, if any"},
    "catalog": {"type": "object", "description": "The Parts product it counts: the maker or source (a site's id, "
                                                "or lcsc, mcmaster, grabcad, own) and the product, each by id "
                                                "(manufacturer_search) or by words of its name",
                "properties": {"manufacturer": {"type": "string"}, "product": {"type": "string"}}},
    "min_stock": {"type": "number", "description": "At or below this many it is low"},
    "price": {"type": "number", "description": "Price of one unit (a new Own items product's price)"},
    "currency": {"type": "string", "description": "TRY, USD, EUR..."},
    "notes": {"type": "string"},
    "tags": {"type": "array", "items": {"type": "string"}},
}


async def one(db, ref) -> dict:
    """The item `ref` names: its id, or words of its name, part numbers or place."""
    ref = str(ref or "").strip()
    if not ref:
        raise ToolError("say which stock line: its id or its product's name (inventory_search lists them)")
    got = await db[inv.COLL].find_one({"_id": ref})
    if got:
        return got
    # Words as the tab's search takes them: "mentese" finds "Menteşe"; a
    # name said whole wins over the items that merely hold it.
    every = await inv.everything(db)
    hits = [d for d in every if inv.matches(d, ref)]
    whole = [d for d in hits if inv.fold(d.get("name")) == inv.fold(ref)]
    if len(whole) == 1 or len(hits) == 1:
        return (whole or hits)[0]
    return await find(db, inv.COLL, ref, FIELDS, "stock line")


def amount(d: dict) -> str:
    return f"{inv.qty(d.get('quantity'))} {d.get('unit') or 'pcs'}"


def line(d: dict) -> str:
    """One item in a line, for the model."""
    bits = [f"{d['_id']}  \"{d.get('name')}\"  {amount(d)}"]
    if d.get("location"):
        bits.append(f"at {d['location']}")
    if inv.is_low(d):
        bits.append(f"LOW (minimum {inv.qty(d.get('min_stock'))})")
    for k, label in (("category", "category"), ("mpn", "MPN"), ("lcsc", "LCSC"), ("manufacturer", "maker")):
        if d.get(k):
            bits.append(f"{label} {d[k]}")
    t, sub, _ = inv.kind_of(d)
    bits.append(f"type {t}" + (f"/{sub}" if sub else ""))
    if inv.linked_to(d):
        bits.append(f"product {product(d)}")
    return "  ".join(bits)


def product(d: dict) -> str:
    """The Parts product a line counts: "Maker / name [maker:product]"."""
    c = d.get("catalog") or {}
    return (f"{c.get('manufacturer_name') or c.get('manufacturer')} / {c.get('product_name') or c.get('product')}"
            f" [{c.get('manufacturer')}:{c.get('product')}]")


def block(d: dict, log: int = 30) -> str:
    """One item in full, with its latest log lines."""
    rows = [line(d)]
    cat = d.get("catalog") or {}
    if cat:
        rows.append(f"Parts product: {cat.get('manufacturer_name') or cat.get('manufacturer')}"
                    + (f" / {cat.get('product_name') or cat.get('product')}" if cat.get("product") else "")
                    + (f"  {cat['url']}" if cat.get("url") else "")
                    + (f"  (id {cat.get('manufacturer')}:{cat.get('product')})" if cat.get("product") else ""))
    if d.get("lcsc"):
        rows.append(f"LCSC: https://www.lcsc.com/product-detail/{d['lcsc']}.html")
    if d.get("board"):
        rows.append(f"For: {d['board']}")
    if d.get("price") is not None:
        rows.append(f"Unit price: {inv.qty(d['price'])} {d.get('currency') or ''}".rstrip())
    if d.get("tags"):
        rows.append("Tags: " + ", ".join(d["tags"]))
    if d.get("notes"):
        rows.append("Notes: " + d["notes"])
    rows.append(f"Added by {(d.get('by') or {}).get('name') or '?'} {str(d.get('created_at') or '')[:16]}; "
                f"changed by {(d.get('updated_by') or {}).get('name') or '?'} {str(d.get('updated_at') or '')[:16]}")
    lines = list(reversed(d.get("log") or []))[:log]
    if lines:
        rows.append("Log (newest first):")
        for x in lines:
            delta = x.get("delta")
            ch = (f" {'+' if delta > 0 else ''}{inv.qty(delta)} -> {inv.qty(x.get('after'))}"
                  if isinstance(delta, (int, float)) else "")
            what = f" fields {', '.join(x['fields'])}" if x.get("fields") else ""
            rows.append(f"- {str(x.get('at') or '')[:16].replace('T', ' ')} {x.get('kind')}{ch}{what}"
                        f" by {(x.get('by') or {}).get('name') or '?'}" + (f": {x['reason']}" if x.get("reason") else ""))
    return "\n".join(rows)
