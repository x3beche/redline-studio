"""LCSC as a seller in the Product Catalog: the parts drawer, shown as a maker.

A built-in source (backend/catalog_builtin.py). The drawer (backend/lcsc.py,
`/api/parts`) stays the one place the parts are kept. The catalog lists them as the products of a maker that is not in
the `manufacturers` collection - "LCSC" (lcsc.com), id `lcsc` - built on
each ask from the drawer and from what the cached EasyEDA record of each
part says (read from disk, nothing asked of LCSC): its price and stock as
last seen, its pins; its picture is its footprint, drawn by the page. The drawer's groups are its categories
(the branch: Capacitors, Resistors, Microcontrollers ...).

Nothing about it is written through the catalog's routes: a part is added
and dropped as before (`/api/parts-add`, `DELETE /api/parts/{C}`).
`manufacturers.listing` - which Chat's manufacturer_search reads - leaves
it out; the drawer has its own tools. Each workspace sees its own drawer.
"""

from __future__ import annotations

import json
import re

from . import lcsc
from .catalog_builtin import Source, register

MID = "lcsc"
SITE = "https://www.lcsc.com"


def _record(part: str) -> dict:
    try:
        raw = json.loads((lcsc.LOOK / part / "component.json").read_text(errors="replace"))
    except (OSError, ValueError):
        return {}
    return raw.get("result", raw) if isinstance(raw, dict) else {}


# ---- the footprint, one layer at a time, for a thumbnail drawn in the page's colours ----
#
# Every kept part has a footprint (a photo only some), so the catalog shows
# that for each, the same way: the page paints the copper and the silkscreen
# in its own theme through these two drawings used as masks (CSS mask-image)
# - only their shapes count. Read from EasyEDA's SVG (only ever parsed, its
# markup never passed on): the copper of the pads (top, bottom, through) with
# the drill holes cut out, or the top silkscreen's lines.

_SHAPES = {"polygon", "polyline", "path", "circle", "ellipse", "rect", "line"}
_KEEP = ("points", "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2",
         "width", "height", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill", "transform")
_COPPER, _SILK = {"1", "2", "11"}, {"3"}


def footprint_layer(svg: bytes, layer: str) -> bytes:
    """EasyEDA's footprint as a mask of one layer: 'pads' or 'silk'."""
    import xml.etree.ElementTree as ET
    from xml.sax.saxutils import quoteattr

    root = ET.fromstring(svg)
    tag = lambda e: e.tag.rsplit("}", 1)[-1]
    want = _COPPER if layer == "pads" else _SILK
    shapes, holes = [], []

    def walk(e, inherited: str | None, top: bool):
        lay = e.get("layerid", inherited)
        for c in e:
            t = tag(c)
            if t == "g":
                walk(c, c.get("layerid", lay), False)
                continue
            if t not in _SHAPES or (top and t == "rect"):
                continue   # the black background
            attrs = " ".join(f"{k}={quoteattr(c.get(k))}" for k in _KEEP if c.get(k) is not None)
            if c.get("c_padhole"):
                holes.append(f"<{t} {attrs}/>")
            elif c.get("layerid", lay) in want:
                shapes.append(f"<{t} {attrs}/>")
    walk(root, None, True)
    box = re.sub(r"[^0-9.\s-]", "", root.get("viewBox") or "0 0 1 1")
    if layer == "pads" and holes:
        x, y, w, h = (box.split() + ["0", "0", "1", "1"])[:4]
        cut = (f'<mask id="h"><rect x="{x}" y="{y}" width="{w}" height="{h}" fill="#fff"/>'
               f'<g fill="#000" stroke="#000">{"".join(holes)}</g></mask>')
        body = f'{cut}<g mask="url(#h)">{"".join(shapes)}</g>'
    else:
        body = "".join(shapes)
    paint = 'fill="#000" stroke="#000"' if layer == "pads" else 'fill="none" stroke="#000"'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{box}" preserveAspectRatio="xMidYMid meet" {paint}>'
            f'{body}</svg>').encode()


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
        # One look for every part: its footprint (the page draws it from footprint.svg?layer=);
        # the photo stays in the part card.
        "image": f"/api/parts/{c}/footprint.svg", "images": [],
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


async def products(db) -> list[dict]:
    """The asking workspace's drawer (lcsc.held_by), as catalog products."""
    return [product(r) for r in await lcsc.known(db)]


register(Source(
    id=MID, name="LCSC", domain="lcsc.com", url=SITE, view="drawer", products=products,
    summary="The parts drawer: electronic parts kept from LCSC, with their footprint, "
            "symbol and 3D model on the server, where a board can reach them."))
