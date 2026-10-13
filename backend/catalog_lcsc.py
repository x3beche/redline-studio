"""LCSC as a seller in the Product Catalog: the parts drawer, shown as a maker.

The drawer (backend/lcsc.py, `/api/parts`) stays the one place the parts
are kept. The catalog lists them as the products of a maker that is not in
the `manufacturers` collection - "LCSC" (lcsc.com), id `lcsc` - built on
each ask from the drawer and from what the cached EasyEDA record of each
part says (read from disk, nothing asked of LCSC): its price and stock as
last seen, its pictures, its pins. The drawer's groups are its categories
(the branch: Capacitors, Resistors, Microcontrollers ...).

Nothing about it is written through the catalog's routes: a part is added
and dropped as before (`/api/parts-add`, `DELETE /api/parts/{C}`), and the
maker's own writes (explore, edit, delete) find no manufacturer `lcsc` and
say 404. `manufacturers.listing` - which Chat's manufacturer_search reads -
leaves it out; the drawer has its own tools.
"""

from __future__ import annotations

import json
import logging

from . import lcsc

log = logging.getLogger(__name__)

MID = "lcsc"
SITE = "https://www.lcsc.com"


def _record(part: str) -> dict:
    try:
        raw = json.loads((lcsc.LOOK / part / "component.json").read_text(errors="replace"))
    except (OSError, ValueError):
        return {}
    return raw.get("result", raw) if isinstance(raw, dict) else {}


def _pictures(part: str, rec: dict) -> list[str]:
    """The part's pictures, best first: the photo the server keeps (EasyEDA's
    image host answers it), LCSC's own (it answers a browser, not the
    server), EasyEDA's copy by number, and the footprint, which every kept
    part has - the page drops what does not load."""
    shot = ((rec.get("szlcsc") or {}).get("image") or "").strip()
    url = "https:" + shot if shot.startswith("//") else shot
    out = []
    if (lcsc.LOOK / part / "photo.jpg").exists() or "lceda.cn" in url:
        out.append(f"/api/parts/{part}/photo.jpg")
    elif url:
        out += [url.replace("/96x96/", "/224x224/"), url]
    out += [f"https://image.lceda.cn/szlcsc/{part}.jpg", f"/api/parts/{part}/footprint.svg"]
    return list(dict.fromkeys(out))


def _pin_count(rec: dict) -> int | None:
    shapes = list((rec.get("dataStr") or {}).get("shape") or [])
    for sub in rec.get("subparts") or []:
        shapes += (sub.get("dataStr") or {}).get("shape") or []
    if not shapes:
        return None
    try:
        return len({p["number"] for p in lcsc._symbol_pins(shapes)})
    except Exception:  # an odd symbol: no count rather than no catalog
        return None


def product(row: dict) -> dict:
    """One kept part (a row of lcsc.known) as a catalog product, with what
    only a part has under `part`."""
    c = row["lcsc"]
    rec = _record(c)
    para = ((rec.get("dataStr") or {}).get("head") or {}).get("c_para") or {}
    shop = rec.get("lcsc") or {}
    value, mpn = row.get("value"), row.get("mpn")
    package = para.get("package") or (row.get("name") or "").split("_")[0] or None
    pins = _pin_count(rec)
    pics = _pictures(c, rec)
    price = shop.get("price")
    stock = shop.get("stock")
    specs = {k: v for k, v in (("Value", value), ("Package", package), ("Manufacturer", row.get("maker")),
                               ("LCSC", c), ("Pins", str(pins) if pins else None),
                               ("JLCPCB", para.get("JLCPCB Part Class")),
                               ("Drawer", f"{row.get('group')} › {row.get('branch')}"),
                               ("3D model", "yes" if row.get("has_3d") else "footprint only")) if v}
    name = mpn or row.get("name") or c
    if value and value not in name:
        name = f"{value} · {name}"
    return {
        "id": c, "name": name, "category": row.get("branch") or row.get("group") or "Other",
        "description": rec.get("description") or rec.get("title") or "", "specs": specs,
        "sku": c, "url": shop.get("url") or f"{SITE}/product-detail/{c}.html",
        "image": pics[0], "images": pics[1:],
        **({"price": {"amount": float(price), "currency": "USD", "vat": None}}
           if isinstance(price, (int, float)) else {}),
        **({"stock": "in" if stock > 0 else "out", "stock_qty": int(stock)}
           if isinstance(stock, (int, float)) else {}),
        "seller": {"domain": "lcsc.com", "host": "www.lcsc.com", "name": "LCSC"},
        "added_at": row.get("at"),
        "part": {"lcsc": c, "value": value, "mpn": mpn, "maker": row.get("maker"), "package": package,
                 "group": row.get("group"), "branch": row.get("branch"), "has_3d": bool(row.get("has_3d")),
                 "pins": pins, "jlc_class": para.get("JLCPCB Part Class"), "min": shop.get("min"),
                 "place_by": row.get("place_by")},
    }


async def maker(db, always: bool = False) -> dict | None:
    """The drawer as a manufacturers document (manufacturers.out shapes it);
    None while the drawer is empty, unless asked for by its id (`always`).
    A drawer that cannot be read leaves the catalog as it is."""
    try:
        rows = await lcsc.known(db)
    except Exception:
        log.exception("the parts drawer could not be read for the catalog")
        rows = []
    if not rows and not always:
        return None
    products = [product(r) for r in rows]
    cats = sorted({p["category"] for p in products})
    first = min((r.get("at") or "" for r in rows), default="") or None
    return {"_id": MID, "name": "LCSC", "url": SITE, "domain": "lcsc.com", "virtual": "drawer",
            "notes": "", "summary": "The parts drawer: electronic parts kept from LCSC, with their footprint, "
                                   "symbol and 3D model on the server, where a board can reach them.",
            "categories": cats, "docs": [], "products": products, "by": {"name": "LCSC"},
            "created_at": first, "updated_at": max((r.get("at") or "" for r in rows), default="") or None,
            "explored_at": None}
