"""Stock ("Envanter"): how many of each Parts product are on
hand, and where.

What a thing is lives in Parts (backend/manufacturers.py,
and its built-in sources - the LCSC drawer, McMaster-Carr, GrabCAD, Own
items: backend/catalog_builtin.py): its name, maker, part number, price,
specs, pages, datasheet and 3D. A stock line (an "item" here, the
`inventory` collection) is the counting of one of them: `catalog`
{manufacturer, product} names the product, and the line keeps a quantity
in a unit (pcs, m, kg, roll, box... or any short word), where it lies (a
shelf, a bin, a box - free text), an optional minimum (at or below it the
line is low), notes, and who added and changed it. The name, part numbers,
category and maker it also keeps are a copy taken from the product when it
was linked - for searching and for the lines from before - and the page
shows the product's own. A product may have several lines (in two units,
or two places); `stock_of` adds them up.

Every line points at a product. One added without one - "200 M3 nuts on
shelf A" from the Chat, a pasted list, a file - gets one first (`_home`):
the LCSC drawer's part when it names one the drawer holds, else a product
of My Items (backend/catalog_own.py) made from its words, or the one of
the same code or name already there. Lines kept before this rule are given
theirs by `home_unlinked` (tools/inventory_home.py), which changes nothing
else of them. A product deleted takes its lines with it, into Parts'
Deleted (backend/parts_trash.py), and brings them back when it is
restored; a write to a line whose product is not in Parts is refused
(`counted`), so the stock and the catalog never disagree.

Each item keeps a short log of what happened to it: added, each quantity
change (+/- with the reason and who - "used 4 for the fan board"), merges
and edits. The quantity changes only through `adjust` or an add that
merges, so the log adds up.

Adding is careful not to make the same thing twice: an item with the same
MPN or LCSC number - or, when neither is given, the same name in the same
unit - is merged into the one already kept, its quantity raised, and the
caller is told which (`add`). The Chat adds that way too
(backend/chat_tools/inventory_*.py).

Items belong to the workspace (backend/scope.py) like the notes and the
taste palettes; reading them is looking, keeping or changing them is the
right to draw (backend/access.py), and deleting someone else's item needs
the right to delete.

Every item has a type - filament, screws, nuts, an electronic component
(with its kind: resistor, IC...), a module, cable... (backend/inventory_types.py).
A person may set it; else it is worked out from the item's own words each
time it is read, so items kept before types existed have one too. The
catalog's stock view groups by it, and the Chat can search by it.
"""

from __future__ import annotations

import math
import re
import secrets
import unicodedata
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import access, actors, catalog_builtin
from . import inventory_types as kinds

router = APIRouter(prefix="/api/inventory")

COLL = "inventory"
FORMAT = "redline-inventory"
MAX_ITEMS = 5000            # items one workspace keeps
MAX_LOG = 200               # log lines one item keeps (the newest)
MAX_QTY = 1e9
MAX_BULK = 500              # items one add, import or delete takes

# The units offered; any other short word is kept as it was written.
UNITS = ("pcs", "m", "cm", "mm", "kg", "g", "l", "ml", "roll", "reel", "box", "pack", "set", "pair", "sheet", "bag")
_UNIT_ALIASES = {
    "pc": "pcs", "piece": "pcs", "pieces": "pcs", "ea": "pcs", "each": "pcs", "x": "pcs", "adet": "pcs", "ad": "pcs",
    "units": "pcs", "unit": "pcs", "meter": "m", "meters": "m", "metre": "m", "metres": "m", "metre(s)": "m",
    "kgs": "kg", "kilo": "kg", "gr": "g", "gram": "g", "grams": "g", "litre": "l", "liter": "l", "lt": "l",
    "rolls": "roll", "rulo": "roll", "reels": "reel", "makara": "reel", "boxes": "box", "kutu": "box",
    "packs": "pack", "paket": "pack", "sets": "set", "takım": "set", "pairs": "pair", "çift": "pair",
    "sheets": "sheet", "levha": "sheet", "bags": "bag", "torba": "bag", "poşet": "bag",
}
CURRENCIES = ("TRY", "USD", "EUR", "GBP", "CNY")
_CUR_ALIASES = {"TL": "TRY", "₺": "TRY", "$": "USD", "€": "EUR", "£": "GBP", "RMB": "CNY", "¥": "CNY"}
LCSC_RE = re.compile(r"^C\d{1,12}$")

# The fields a person sets, and how long each may be.
TEXT = {"name": 160, "unit": 16, "location": 120, "category": 80, "mpn": 80, "lcsc": 16, "manufacturer": 120,
        "board": 120, "notes": 4000, "currency": 8, "type": 24, "subtype": 24}
FIELDS = (*TEXT, "quantity", "min_stock", "price", "tags", "catalog")
_FOLD = str.maketrans("ıİşŞğĞçÇöÖüÜ", "iissggccoouu")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db():
    from .main import db
    return db()


def fold(text: Any) -> str:
    """Lower case without accents, Turkish letters as their plain ones."""
    t = str(text or "").translate(_FOLD).lower()
    return "".join(c for c in unicodedata.normalize("NFKD", t) if not unicodedata.combining(c))


def _who(by: dict | None) -> dict:
    by = by or actors.current() or {}
    return {"id": by.get("id"), "name": by.get("name"), **({"type": by["type"]} if by.get("type") else {})}


def unit_of(raw: Any) -> str:
    """A unit as it is kept: one of UNITS when it is one by another name,
    else the word as written (short), "pcs" when there is none."""
    u = re.sub(r"\s+", " ", str(raw or "").strip())[:TEXT["unit"]]
    if not u:
        return "pcs"
    low = u.lower().rstrip(".")
    if low in UNITS:
        return low
    return _UNIT_ALIASES.get(low, u)


def currency_of(raw: Any) -> str:
    c = str(raw or "").strip()
    if not c:
        return ""
    c = _CUR_ALIASES.get(c, _CUR_ALIASES.get(c.upper(), c.upper()))
    if not re.fullmatch(r"[A-Z]{3}", c):
        raise ValueError(f"{raw!r} is not a currency (TRY, USD, EUR...)")
    return c


def number(raw: Any, what: str, *, allow_none: bool = False, negative: bool = False) -> float | None:
    """A number from what was sent: 4, "4", "2,5" (a decimal comma)."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        if allow_none:
            return None
        raise ValueError(f"{what} is missing")
    if isinstance(raw, bool):
        raise ValueError(f"{what} must be a number")
    try:
        v = float(str(raw).strip().replace(",", ".")) if isinstance(raw, str) else float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{what} must be a number, not {raw!r}") from None
    if not math.isfinite(v) or abs(v) > MAX_QTY:
        raise ValueError(f"{what} is out of range")
    if v < 0 and not negative:
        raise ValueError(f"{what} cannot be below zero")
    return round(v, 6)


def tags_of(raw: Any) -> list[str]:
    if isinstance(raw, str):
        raw = re.split(r"[,\s]+", raw)
    out: list[str] = []
    for t in raw or []:
        t = str(t or "").strip().lstrip("#")[:40]
        if t and t.lower() not in (x.lower() for x in out):
            out.append(t)
    return out[:20]


def lcsc_of(raw: Any) -> str:
    c = str(raw or "").strip().upper()
    if c and not LCSC_RE.match(c):
        raise ValueError(f"{raw!r} is not an LCSC part number (they look like C25744)")
    return c


def clean(raw: dict, partial: bool = False) -> dict:
    """The fields of an item as they are kept, from what a person, a file or
    the Chat sent; a ValueError says what is wrong. `partial`: only the
    fields given (a change), else a whole new item."""
    if not isinstance(raw, dict):
        raise ValueError("an item is a set of fields")
    out: dict[str, Any] = {}
    for k, n in TEXT.items():
        if k in raw or not partial:
            v = raw.get(k)
            if k == "unit":
                out[k] = unit_of(v)
            elif k == "currency":
                out[k] = currency_of(v)
            elif k == "lcsc":
                out[k] = lcsc_of(v)
            elif k == "type":
                out[k] = kinds.type_id(v)
            elif k == "subtype":
                out[k] = kinds.subtype_id(v)
            elif k == "notes":
                out[k] = str(v or "").strip()[:n]
            else:
                out[k] = re.sub(r"\s+", " ", str(v or "").strip())[:n]
    if "name" in out and not out["name"] and not (raw.get("catalog") and not partial):
        raise ValueError("an item needs a name")
    if "quantity" in raw or not partial:
        out["quantity"] = number(raw.get("quantity", 0) if not partial else raw.get("quantity"), "the quantity")
    for k, what in (("min_stock", "the minimum"), ("price", "the price")):
        if k in raw or not partial:
            out[k] = number(raw.get(k), what, allow_none=True)
    if "tags" in raw or not partial:
        out["tags"] = tags_of(raw.get("tags"))
    if "catalog" in raw or not partial:
        out["catalog"] = _catalog_ref(raw.get("catalog"))
    return out


def _catalog_ref(raw: Any) -> dict | None:
    """A Parts product named by its manufacturer's id and its own
    (checked against the catalog by `link_catalog`)."""
    if not raw:
        return None
    if not isinstance(raw, dict):
        raise ValueError("a catalog link is a manufacturer id and a product id")
    mid = str(raw.get("manufacturer") or raw.get("manufacturer_id") or "").strip()[:80]
    pid = str(raw.get("product") or raw.get("product_id") or "").strip()[:80]
    if not mid:
        return None
    if not pid:
        raise ValueError("a stock line counts one catalog product: say the product, not only its maker")
    keep = {"manufacturer": mid, "product": pid}
    for k in ("manufacturer_name", "product_name", "url", "sku"):
        if raw.get(k):
            keep[k] = str(raw[k]).strip()[:300]
    return keep


async def link_catalog(db, ref: dict | None) -> dict | None:
    """The catalog link with the names it points at, read from the Product
    Catalog of this workspace - a site's or a built-in source's product; a
    ValueError when there is no such product."""
    if not ref:
        return None
    m = await catalog_builtin.maker_doc(db, ref["manufacturer"])
    if not m:
        raise ValueError(f"there is no manufacturer {ref['manufacturer']!r} in Parts")
    p = next((x for x in m.get("products") or [] if str(x.get("id")) == ref["product"]), None)
    if not p:
        raise ValueError(f"{m.get('name') or m['_id']} has no product {ref['product']!r} in its catalog")
    out = {"manufacturer": m["_id"], "manufacturer_name": m.get("name") or m["_id"], "product": str(p["id"]),
           "product_name": p.get("name") or "", "url": p.get("url") or "", "sku": p.get("sku") or "",
           "category": p.get("category") or ""}
    return {k: v for k, v in out.items() if v not in (None, "")} | {"product": out["product"]}


async def counted(db, d: dict) -> None:
    """A line written to counts a product that is in Parts: one whose
    product went - deleted products take their lines to Parts' Deleted
    (backend/parts_trash.py), so this is a line written around that - is
    refused rather than counted on (a ValueError)."""
    link = linked_to(d)
    if link and not await catalog_builtin.find_product(db, *link):
        c = d.get("catalog") or {}
        raise ValueError(f"{d.get('name') or 'this stock line'} counts {c.get('product_name') or link[1]} of "
                         f"{c.get('manufacturer_name') or link[0]}, which is not in Parts any more - "
                         "restore it from Parts' Deleted, or link the line to another product")


def is_low(d: dict) -> bool:
    lo = d.get("min_stock")
    return lo is not None and float(d.get("quantity") or 0) <= float(lo)


def qty(v: Any) -> str:
    """4, 2.5 - a quantity without a needless .0."""
    try:
        f = float(v or 0)
    except (TypeError, ValueError):
        return str(v)
    return str(int(f)) if f == int(f) else f"{f:g}"


def _line(at: str, by: dict, kind: str, **kw) -> dict:
    return {"id": secrets.token_hex(4), "at": at, "by": {"id": by.get("id"), "name": by.get("name")}, "kind": kind,
            **{k: v for k, v in kw.items() if v not in (None, "")}}


def _log(doc: dict, line: dict) -> list[dict]:
    return [*(doc.get("log") or []), line][-MAX_LOG:]


# ---- reading -------------------------------------------------------------------

def kind_of(d: dict) -> tuple[str, str, bool]:
    """(type, subtype, worked out) - see backend/inventory_types.py."""
    return kinds.type_of(d, kinds.lcsc_info(d.get("lcsc") or ""))


def _hay(d: dict) -> str:
    cat = d.get("catalog") or {}
    t, s, _ = kind_of(d)
    return fold(" ".join(str(x or "") for x in (
        d.get("name"), d.get("mpn"), d.get("lcsc"), d.get("manufacturer"), d.get("category"), d.get("location"),
        d.get("board"), d.get("notes"), " ".join(d.get("tags") or []), cat.get("manufacturer_name"),
        cat.get("product_name"), cat.get("sku"), t, kinds.LABEL.get(t), s, kinds.SUBLABEL.get(s))))


def matches(d: dict, q: str = "", category: str = "", location: str = "", low: bool = False,
            type: str = "") -> bool:  # noqa: A002 - the API's word
    if low and not is_low(d):
        return False
    if type:
        want = type.split("/", 1)
        t, s, _ = kind_of(d)
        if t != kinds.type_id(want[0]) or (len(want) > 1 and want[1] and s != kinds.subtype_id(want[1])):
            return False
    if category and fold(d.get("category")) != fold(category):
        return False
    if location and fold(location) not in fold(d.get("location")):
        return False
    words = fold(q).split()
    if words:
        hay = _hay(d)
        return all(w in hay for w in words)
    return True


async def everything(db) -> list[dict]:
    return [d async for d in db[COLL].find({}).sort("name", 1)]


async def listing(db, q: str = "", category: str = "", location: str = "", low: bool = False,
                  type: str = "") -> list[dict]:  # noqa: A002
    """The items that match, by name. `type`: a type, or "electronic/resistor"."""
    rows = [d for d in await everything(db) if matches(d, q, category, location, low, type)]
    rows.sort(key=lambda d: fold(d.get("name")))
    return rows


async def get(db, iid: str) -> dict | None:
    return await db[COLL].find_one({"_id": iid})


def same(a: dict, b: dict) -> bool:
    """Whether two items are the same thing: the same MPN or LCSC number;
    with neither on both, the same name in the same unit."""
    for k in ("mpn", "lcsc"):
        x, y = fold(a.get(k)).replace(" ", ""), fold(b.get(k)).replace(" ", "")
        if x and y:
            return x == y
    if fold(a.get("name")) != fold(b.get("name")):
        return False
    return unit_of(a.get("unit")) == unit_of(b.get("unit"))


async def find_same(db, item: dict, rows: list[dict] | None = None) -> dict | None:
    """The item already kept that `item` is (`same`), in the same unit -
    four metres are not four pieces."""
    rows = rows if rows is not None else await everything(db)
    link = linked_to(item)
    if link:
        hit = next((d for d in rows if linked_to(d) == link), None)
        if hit:
            return hit
    unit = unit_of(item.get("unit"))
    rows = [d for d in rows if unit_of(d.get("unit")) == unit]
    # The part numbers first: they name a thing better than its name.
    for k in ("mpn", "lcsc"):
        key = fold(item.get(k)).replace(" ", "")
        if key:
            hit = next((d for d in rows if fold(d.get(k)).replace(" ", "") == key), None)
            if hit:
                return hit
    return next((d for d in rows if same(d, item)), None)


def linked_to(d: dict) -> tuple[str, str] | None:
    """The catalog product an item is: (manufacturer id, product id)."""
    c = d.get("catalog") or {}
    return (c["manufacturer"], c["product"]) if c.get("manufacturer") and c.get("product") else None


async def stock_of(db, manufacturer: str = "") -> dict[str, dict[str, dict]]:
    """What is on hand of each catalog product, in one read:
    {manufacturer id: {product id: {quantity, unit, items: [ids]}}} - one
    manufacturer's, or every one's. Items in several units of one product
    say the first one's unit and add up only that unit."""
    out: dict[str, dict[str, dict]] = {}
    for d in await everything(db):
        link = linked_to(d)
        if not link or (manufacturer and link[0] != manufacturer):
            continue
        got = out.setdefault(link[0], {}).setdefault(link[1], {"quantity": 0.0, "unit": d.get("unit") or "pcs",
                                                                "items": [], "low": False})
        if (d.get("unit") or "pcs") == got["unit"]:
            got["quantity"] = round(got["quantity"] + float(d.get("quantity") or 0), 6)
        got["items"].append(d["_id"])
        got["low"] = got["low"] or is_low(d)
    return out


def _words(ref: str) -> list[str]:
    return [w for w in re.split(r"[\s,;/]+", fold(ref)) if w]


async def resolve_catalog(db, maker: str, product: str) -> tuple[dict, dict]:
    """A Parts product named the way a person says it: the
    manufacturer by its id or words of its name or site, the product by its
    id or words of its name, code or specs. A ValueError names the
    candidates when the words fit several or none."""
    from .manufacturers import _phay
    maker, product = str(maker or "").strip(), str(product or "").strip()
    if not maker or not product:
        raise ValueError("say the manufacturer and the product")
    m = await catalog_builtin.maker_doc(db, maker)
    if not m:
        every = [*await catalog_builtin.makers(db), *[d async for d in db["manufacturers"].find({})]]
        w = _words(maker)
        hits = [d for d in every if w and all(x in fold(f"{d['_id']} {d.get('name')} {d.get('domain')} {d.get('url')}")
                                              for x in w)]
        if len(hits) != 1:
            names = ", ".join(f"{d['_id']} ({d.get('name')})" for d in (hits or every)[:20])
            raise ValueError(f"{len(hits) or 'no'} manufacturer(s) match {maker!r}" + (f": {names}" if names else ""))
        m = hits[0]
    prods = m.get("products") or []
    p = next((x for x in prods if str(x.get("id")) == product), None)
    if not p:
        w = _words(product)
        hits = [x for x in prods if w and all(y in _phay(x) for y in w)]
        whole = [x for x in hits if fold(x.get("name")) == fold(product) or fold(x.get("sku")) == fold(product)]
        hits = whole if len(whole) == 1 else hits
        if len(hits) != 1:
            names = "; ".join(f"{x.get('id')} {x.get('name')}" + (f" ({x['sku']})" if x.get("sku") else "")
                              for x in hits[:25])
            raise ValueError(f"{len(hits) or 'no'} product(s) of {m.get('name')} match {product!r}"
                             + (f": {names} - say one by its id" if hits else ""))
        p = hits[0]
    return m, p


async def from_catalog(db, maker: str, product: str, quantity: Any = 1, unit: str = "", location: str = "",
                       note: str = "", by: dict | None = None, rows: list[dict] | None = None) -> tuple[dict, bool]:
    """A catalog product taken into stock: an item linked to it (its name,
    code, category, maker and page copied), or - when an item already
    links to it - that item topped up. Says which."""
    m, p = await resolve_catalog(db, maker, product)
    raw = {"name": p.get("name") or p.get("id"), "quantity": quantity, "unit": unit, "location": location,
           "catalog": {"manufacturer": m["_id"], "product": p["id"]}, "notes": note}
    return await add(db, raw, by, note or "taken from Parts", rows=rows)


def stats(rows: list[dict]) -> dict:
    """The overview's figures: how many items, how many low or out, the
    units, and the value of the priced ones per currency."""
    value: dict[str, float] = {}
    for d in rows:
        if d.get("price") is not None:
            cur = d.get("currency") or "?"
            value[cur] = round(value.get(cur, 0) + float(d["price"]) * float(d.get("quantity") or 0), 2)
    units: dict[str, float] = {}
    for d in rows:
        units[d.get("unit") or "pcs"] = units.get(d.get("unit") or "pcs", 0) + float(d.get("quantity") or 0)
    types: dict[str, int] = {}
    for d in rows:
        t = kind_of(d)[0]
        types[t] = types.get(t, 0) + 1
    return {"items": len(rows), "low": sum(1 for d in rows if is_low(d)),
            "types": {k: types[k] for k in kinds.TYPE_IDS if k in types},
            "out": sum(1 for d in rows if float(d.get("quantity") or 0) <= 0),
            "units": {k: round(v, 6) for k, v in units.items()}, "value": value,
            "categories": sorted({d["category"] for d in rows if d.get("category")}, key=fold),
            "locations": sorted({d["location"] for d in rows if d.get("location")}, key=fold)}


# ---- writing -------------------------------------------------------------------

async def _fields(db, raw: dict, partial: bool = False) -> dict:
    f = clean(raw, partial)
    if f.get("catalog"):
        f["catalog"] = await link_catalog(db, f["catalog"])
        cat = f["catalog"]
        pcat = cat.pop("category", "")
        # A product from the catalog lends what the item does not say.
        if not partial:
            f["manufacturer"] = f.get("manufacturer") or (cat.get("manufacturer_name") if cat["manufacturer"] not in
                                                          ("own", "lcsc") else "") or ""
            f["mpn"] = f.get("mpn") or (cat.get("sku") if cat["manufacturer"] != "lcsc" else "") or ""
            f["lcsc"] = f.get("lcsc") or (cat["product"] if cat["manufacturer"] == "lcsc" else "")
            f["category"] = f.get("category") or pcat or ""
            f["name"] = f.get("name") or cat.get("product_name") or cat["product"]
    return f


def own_fields(f: dict) -> dict:
    """What an item says of what it is, as a My Items product's fields."""
    specs = {k: v for k, v in (("Maker", f.get("manufacturer")), ("MPN", f.get("mpn")), ("LCSC", f.get("lcsc"))) if v}
    out = {"name": f.get("name") or "", "category": f.get("category") or "", "sku": f.get("mpn") or f.get("lcsc") or "",
           "specs": specs}
    if f.get("price") is not None:
        out.update(price=f["price"], currency=f.get("currency") or "")
    return out


async def _home(db, f: dict, by: dict | None) -> dict:
    """`f` with a catalog product to count, when it names none: the LCSC
    drawer's part it names, else a My Items product made from its words
    (or the one of the same code or name) - see the module's words."""
    if linked_to(f):
        return f
    from . import catalog_own, lcsc
    link = None
    if f.get("lcsc"):
        try:
            if await lcsc.holds(db, f["lcsc"]):
                link = await link_catalog(db, {"manufacturer": "lcsc", "product": f["lcsc"]})
        except Exception:                               # noqa: BLE001 - the drawer is only one place to look
            link = None
    if not link:
        from .manufacturers import Clash
        try:
            p = await catalog_own.ensure(db, own_fields(f), _who(by))
        except Clash as exc:                            # the code is there under another name: that one
            raise ValueError(str(exc)) from exc
        link = await link_catalog(db, {"manufacturer": catalog_own.MID, "product": p["id"]})
    f = dict(f)
    f["catalog"] = link
    f["catalog"].pop("category", None)
    return f


async def create(db, raw: dict, by: dict | None = None, reason: str = "") -> dict:
    """A new item, as it was given (no merging - see `add`)."""
    return await _insert(db, await _home(db, await _fields(db, raw), by), by, reason)


async def _insert(db, f: dict, by: dict | None, reason: str) -> dict:
    if await db[COLL].count_documents({}) >= MAX_ITEMS:
        raise ValueError(f"the inventory holds at most {MAX_ITEMS} items")
    who, now = _who(by), _now()
    doc = {"_id": "i" + secrets.token_hex(5), **f, "by": who, "created_at": now, "updated_by": who, "updated_at": now,
           "log": [_line(now, who, "added", delta=f["quantity"], after=f["quantity"], reason=str(reason or "")[:300])]}
    await db[COLL].insert_one(doc)
    return doc


async def add(db, raw: dict, by: dict | None = None, reason: str = "", merge: bool = True,
              rows: list[dict] | None = None) -> tuple[dict, bool]:
    """An item kept: merged into the same one already there (its quantity
    raised by this one's, its empty fields filled) or new. Says which."""
    f = await _fields(db, raw)
    have = await find_same(db, f, rows) if merge else None
    if not have:
        return await _insert(db, await _home(db, f, by), by, reason), False
    if not f.get("catalog"):
        await counted(db, have)
    who, now = _who(by), _now()
    after = round(float(have.get("quantity") or 0) + f["quantity"], 6)
    if after > MAX_QTY:
        raise ValueError("the quantity is out of range")
    fill = {k: f[k] for k in ("location", "category", "mpn", "lcsc", "manufacturer", "board", "currency", "catalog",
                              "min_stock", "price", "type", "subtype") if f.get(k) not in (None, "", []) and have.get(k) in (None, "", [])}
    tags = tags_of([*(have.get("tags") or []), *(f.get("tags") or [])])
    line = _line(now, who, "merged", delta=f["quantity"], after=after,
                 reason=str(reason or "")[:300] or "added again", filled=sorted(fill) or None)
    sets = {**fill, "tags": tags, "quantity": after, "updated_by": who, "updated_at": now, "log": _log(have, line)}
    await db[COLL].update_one({"_id": have["_id"]}, {"$set": sets})
    return {**have, **sets}, True


async def add_many(db, items: list[dict], by: dict | None = None, reason: str = "",
                   merge: bool = True) -> list[dict]:
    """Several at once, each merged or added; one that cannot be read is
    said, not fatal: [{item, merged} | {error, name}]."""
    if len(items) > MAX_BULK:
        raise ValueError(f"at most {MAX_BULK} items at once")
    rows = await everything(db)
    out = []
    for raw in items:
        try:
            doc, merged = await add(db, raw, by, reason, merge, rows)
        except ValueError as exc:
            out.append({"error": str(exc), "name": str((raw or {}).get("name") or "") if isinstance(raw, dict) else ""})
            continue
        rows = [d for d in rows if d["_id"] != doc["_id"]] + [doc]
        out.append({"item": doc, "merged": merged})
    return out


async def patch(db, iid: str, raw: dict, by: dict | None = None, reason: str = "") -> dict | None:
    """Fields changed. A quantity given here is a change to it like any
    other, kept in the log with its difference."""
    have = await get(db, iid)
    if not have:
        return None
    f = await _fields(db, raw, partial=True)
    if "catalog" in f and not f["catalog"]:
        raise ValueError("a stock line stays a catalog product's: link it to another product rather than to none")
    if "catalog" not in f:
        await counted(db, have)
    changed = {k: v for k, v in f.items() if have.get(k) != v}
    if not changed:
        return have
    who, now = _who(by), _now()
    lines = []
    if "quantity" in changed:
        delta = round(changed["quantity"] - float(have.get("quantity") or 0), 6)
        lines.append(_line(now, who, "adjusted", delta=delta, after=changed["quantity"],
                           reason=str(reason or "")[:300] or "set by hand"))
    rest = sorted(k for k in changed if k != "quantity")
    if rest:
        lines.append(_line(now, who, "edited", fields=rest,
                           changes={k: [_short(have.get(k)), _short(changed[k])] for k in rest if k != "notes"}))
    log = have.get("log") or []
    for ln in lines:
        log = _log({"log": log}, ln)
    sets = {**changed, "updated_by": who, "updated_at": now, "log": log}
    await db[COLL].update_one({"_id": iid}, {"$set": sets})
    return {**have, **sets}


def _short(v: Any) -> Any:
    if isinstance(v, dict):
        return v.get("product_name") or v.get("manufacturer_name") or ""
    if isinstance(v, list):
        return ", ".join(map(str, v))[:80]
    return v if v is None or isinstance(v, (int, float)) else str(v)[:80]


async def adjust(db, iid: str, delta: Any, reason: str = "", by: dict | None = None) -> dict | None:
    """The quantity raised or lowered by `delta`, with why; it cannot go
    below zero."""
    have = await get(db, iid)
    if not have:
        return None
    d = number(delta, "the change", negative=True)
    if not d:
        raise ValueError("the change is zero")
    await counted(db, have)
    after = round(float(have.get("quantity") or 0) + d, 6)
    if after < 0:
        raise ValueError(f"only {qty(have.get('quantity'))} {have.get('unit') or 'pcs'} on hand - cannot take {qty(-d)}")
    if after > MAX_QTY:
        raise ValueError("the quantity is out of range")
    who, now = _who(by), _now()
    line = _line(now, who, "adjusted", delta=d, after=after, reason=str(reason or "").strip()[:300])
    sets = {"quantity": after, "updated_by": who, "updated_at": now, "log": _log(have, line)}
    await db[COLL].update_one({"_id": iid}, {"$set": sets})
    return {**have, **sets}


async def home_unlinked(db, by: dict | None = None) -> list[dict]:
    """Every line that counts no catalog product given one (`_home`), its
    quantity, place and log kept, a line in its log saying so; lines that
    have one are left as they are, so running it again changes nothing.
    What was done: [{id, name, catalog}]."""
    who, done = by or {"id": "system", "name": "Workbench"}, []
    for d in await everything(db):
        if linked_to(d):
            continue
        f = await _home(db, {k: d.get(k) for k in (*TEXT, "price", "currency") if k in d} | {"catalog": None}, who)
        now = _now()
        line = _line(now, who, "edited", fields=["catalog"], reason="linked to its catalog product",
                     changes={"catalog": [_short(d.get("catalog")), _short(f["catalog"])]})
        await db[COLL].update_one({"_id": d["_id"]}, {"$set": {"catalog": f["catalog"], "log": _log(d, line)}})
        done.append({"id": d["_id"], "name": d.get("name"), "catalog": f["catalog"]})
    return done


def may_delete(doc: dict) -> bool:
    """One's own item, or anyone's with the right to delete."""
    return (doc.get("by") or {}).get("id") == actors.current().get("id") or access.allowed(access.current(), "delete")


async def remove(db, iid: str) -> bool:
    res = await db[COLL].delete_one({"_id": iid})
    return bool(getattr(res, "deleted_count", 0))


# ---- sharing: the inventory as a file --------------------------------------------

KEEP = ("name", "quantity", "unit", "location", "category", "mpn", "lcsc", "manufacturer", "board", "min_stock",
        "price", "currency", "notes", "tags", "catalog", "type", "subtype")


def export_doc(rows: list[dict]) -> dict:
    """Items as a file: their fields, not their logs nor who kept them."""
    return {"format": FORMAT, "version": 1, "exported_at": _now(),
            "items": [{k: d[k] for k in KEEP if d.get(k) not in (None, "", [])} for d in rows]}


async def import_doc(db, data: dict, by: dict | None = None) -> dict:
    """A file's items kept here, each as an add is: the same thing already
    kept gets its quantity raised. A catalog link that does not point at a
    product here is dropped rather than refusing the item."""
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise ValueError("this is not a Workbench inventory file")
    if int(data.get("version") or 0) > 1:
        raise ValueError("this inventory file is from a newer Workbench")
    items = data.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("the file has no items")
    clean_items = []
    for x in items:
        if not isinstance(x, dict):
            continue
        x = dict(x)
        if x.get("catalog"):
            try:
                await link_catalog(db, _catalog_ref(x["catalog"]))
            except ValueError:
                x.pop("catalog")
        clean_items.append(x)
    got = await add_many(db, clean_items, by, "imported from a file")
    return {"added": sum(1 for r in got if "item" in r and not r["merged"]),
            "merged": sum(1 for r in got if r.get("merged")),
            "skipped": [{"name": r.get("name"), "error": r["error"]} for r in got if "error" in r],
            "items": [out(r["item"], full=False) for r in got if "item" in r]}


# ---- the API --------------------------------------------------------------------

def out(d: dict, full: bool = True, pictures: dict | None = None) -> dict:
    """An item as the API gives it: its fields, its type (the person's or
    worked out - `type_auto`; `type_set` is the person's own, "" for none),
    what its type's card shows (`facts`), its catalog product as it is now
    (`product`: its name, maker, code, page and price; the item's `name`
    is the product's), the pictures it can be shown with - its catalog
    product's (`images`) and whether the LCSC part's photo is on disk
    (`photo`) or can be fetched (`photo_known`) - and, `full`, its log,
    newest first. `pictures`: what `pictures` read for these items."""
    o = {k: v for k, v in d.items() if k not in ("_id", "workspace_id", "log")}
    o["id"] = d["_id"]
    info = kinds.lcsc_info(d.get("lcsc") or "")
    t, s, auto = kinds.type_of(d, info)
    o["type"], o["subtype"], o["type_auto"] = t, s, auto
    o["type_set"] = d.get("type") or ""
    o["facts"] = kinds.facts(d, t, s, info)
    link = linked_to(d)
    got = (pictures or {}).get(link) if link else None
    o["images"] = (got or {}).get("images", [])
    o["product"] = (got or {}).get("product")
    if o["product"] and o["product"].get("name"):
        o["name"] = o["product"]["name"]
    o["photo"] = bool(info and info.get("photo"))
    o["photo_known"] = bool(info and (info.get("photo") or info.get("has_photo")))
    o["low"] = is_low(d)
    o["value"] = round(float(d["price"]) * float(d.get("quantity") or 0), 2) if d.get("price") is not None else None
    log = d.get("log") or []
    o["last"] = log[-1] if log else None
    if full:
        o["log"] = list(reversed(log))
    return o


class ItemIn(BaseModel):
    name: str = Field("", max_length=160)          # may be left out for a line of a catalog product: its name
    quantity: float | str = 0
    unit: str = "pcs"
    location: str = ""
    category: str = ""
    mpn: str = ""
    lcsc: str = ""
    manufacturer: str = ""
    board: str = ""
    min_stock: float | str | None = None
    price: float | str | None = None
    currency: str = ""
    notes: str = ""
    tags: list[str] | str = []
    catalog: dict | None = None
    type: str = ""
    subtype: str = ""
    reason: str = ""
    merge: bool = True


class ItemPatch(BaseModel):
    name: str | None = None
    quantity: float | str | None = None
    unit: str | None = None
    location: str | None = None
    category: str | None = None
    mpn: str | None = None
    lcsc: str | None = None
    manufacturer: str | None = None
    board: str | None = None
    min_stock: float | str | None = None
    price: float | str | None = None
    currency: str | None = None
    notes: str | None = None
    tags: list[str] | str | None = None
    catalog: dict | None = None
    type: str | None = None
    subtype: str | None = None
    reason: str = ""


class AdjustIn(BaseModel):
    delta: float | str
    reason: str = Field("", max_length=300)


class BulkIn(BaseModel):
    items: list[dict] = Field(max_length=MAX_BULK)
    reason: str = ""
    merge: bool = True


class FromCatalogIn(BaseModel):
    manufacturer: str = Field(min_length=1, max_length=200)
    product: str = Field(min_length=1, max_length=300)
    quantity: float | str = 1
    unit: str = ""
    location: str = ""
    note: str = Field("", max_length=300)


class FromCatalogManyIn(BaseModel):
    manufacturer: str = Field(min_length=1, max_length=200)
    products: list[str] = Field(min_length=1, max_length=MAX_BULK)
    quantity: float | str = 1
    unit: str = ""
    location: str = ""
    note: str = Field("", max_length=300)


class IdsIn(BaseModel):
    ids: list[str] = Field(max_length=MAX_BULK)


def _404(iid: str):
    raise HTTPException(404, f"no inventory item {iid}")


def _400(exc: ValueError):
    raise HTTPException(400, str(exc)) from exc


def product_brief(m: dict, p: dict) -> dict:
    """A catalog product as a stock line shows it."""
    return {k: v for k, v in (("name", p.get("name")), ("maker", m.get("name") or m.get("_id")), ("sku", p.get("sku")),
                               ("category", p.get("category")), ("url", p.get("url")), ("price", p.get("price")),
                               ("builtin", bool(m.get("builtin")))) if v not in (None, "")}


async def pictures(db, rows: list[dict]) -> dict[tuple[str, str], dict]:
    """The catalog products these items count, in one read of each maker
    they name: {(maker, product): {product, images}} - the pictures the
    page can show (an LCSC part's footprint is a mask, not a picture)."""
    want: dict[str, set[str]] = {}
    for d in rows:
        link = linked_to(d)
        if link:
            want.setdefault(link[0], set()).add(link[1])
    got: dict[tuple[str, str], dict] = {}
    for mid, pids in want.items():
        try:
            m = await catalog_builtin.maker_doc(db, mid)
        except Exception:                               # noqa: BLE001 - a maker that cannot be read shows no product
            m = None
        for p in (m or {}).get("products") or []:
            if str(p.get("id")) in pids:
                urls = [u for u in dict.fromkeys([p.get("image"), *(p.get("images") or [])])
                        if u and not str(u).endswith("footprint.svg")]
                got[(mid, str(p["id"]))] = {"product": product_brief(m, p), "images": urls[:12]}
    return got


@router.get("")
async def api_list(q: str = "", category: str = "", location: str = "", low: bool = False,
                   type: str = ""):  # noqa: A002 - the address's word
    db = _db()
    rows = await listing(db, q, category, location, low, type)
    pics = await pictures(db, rows)
    return [out(d, full=False, pictures=pics) for d in rows]


@router.get("/types")
async def api_types():
    """The types and an electronic component's kinds, in their order."""
    return {"types": [{"id": k, "label": v} for k, v in kinds.TYPES],
            "subtypes": [{"id": k, "label": v} for k, v in kinds.SUBTYPES]}


@router.get("/stats")
async def api_stats():
    return stats(await everything(_db()))


@router.get("/export")
async def api_export(ids: str = ""):
    rows = await listing(_db())
    want = {x for x in ids.split(",") if x}
    return export_doc([d for d in rows if d["_id"] in want] if want else rows)


@router.post("/import")
async def api_import(body: dict):
    try:
        return await import_doc(_db(), body, actors.current())
    except ValueError as exc:
        _400(exc)


@router.post("")
async def api_create(body: ItemIn):
    raw = body.model_dump(exclude={"reason", "merge"})
    try:
        doc, merged = await add(_db(), raw, actors.current(), body.reason, body.merge)
    except ValueError as exc:
        _400(exc)
    return {"item": out(doc, pictures=await pictures(_db(), [doc])), "merged": merged}


@router.post("/bulk")
async def api_bulk(body: BulkIn):
    try:
        got = await add_many(_db(), body.items, actors.current(), body.reason, body.merge)
    except ValueError as exc:
        _400(exc)
    return {"results": [{"item": out(r["item"], full=False), "merged": r["merged"]} if "item" in r else r for r in got]}


@router.get("/product/{mid}/{pid}")
async def api_of_product(mid: str, pid: str):
    """The stock lines of one catalog product, each in full with its log -
    the product's stock section in the catalog."""
    db = _db()
    rows = [d for d in await everything(db) if linked_to(d) == (mid, pid)]
    pics = await pictures(db, rows)
    return [out(d, pictures=pics) for d in rows]


@router.get("/stock")
async def api_stock(manufacturer: str = ""):
    """What is on hand of each catalog product - the Parts page's
    table asks once for a whole catalog."""
    got = await stock_of(_db(), manufacturer)
    return got.get(manufacturer, {}) if manufacturer else got


@router.post("/from-catalog")
async def api_from_catalog(body: FromCatalogIn):
    try:
        doc, merged = await from_catalog(_db(), body.manufacturer, body.product, body.quantity, body.unit,
                                         body.location, body.note, actors.current())
    except ValueError as exc:
        _400(exc)
    return {"item": out(doc, pictures=await pictures(_db(), [doc])), "merged": merged}


@router.post("/from-catalog/bulk")
async def api_from_catalog_many(body: FromCatalogManyIn):
    db = _db()
    rows = await everything(db)
    results = []
    for pid in dict.fromkeys(body.products):
        try:
            doc, merged = await from_catalog(db, body.manufacturer, pid, body.quantity, body.unit, body.location,
                                             body.note, actors.current(), rows)
        except ValueError as exc:
            results.append({"product": pid, "error": str(exc)})
            continue
        rows = [d for d in rows if d["_id"] != doc["_id"]] + [doc]
        results.append({"product": pid, "item": out(doc, full=False), "merged": merged})
    return {"results": results}


@router.post("/bulk-delete")
async def api_bulk_delete(body: IdsIn):
    db = _db()
    docs = [d for d in [await get(db, i) for i in dict.fromkeys(body.ids)] if d]
    if any(not may_delete(d) for d in docs):
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    gone = [d["_id"] for d in docs if await remove(db, d["_id"])]
    return {"deleted": gone}


@router.get("/{iid}")
async def api_get(iid: str):
    db = _db()
    d = await get(db, iid)
    if not d:
        _404(iid)
    return out(d, pictures=await pictures(db, [d]))


@router.patch("/{iid}")
async def api_patch(iid: str, body: ItemPatch):
    raw = {k: v for k, v in body.model_dump(exclude={"reason"}).items() if v is not None or k in body.model_fields_set}
    try:
        d = await patch(_db(), iid, raw, actors.current(), body.reason)
    except ValueError as exc:
        _400(exc)
    if not d:
        _404(iid)
    return out(d, pictures=await pictures(_db(), [d]))


@router.post("/{iid}/adjust")
async def api_adjust(iid: str, body: AdjustIn):
    try:
        d = await adjust(_db(), iid, body.delta, body.reason, actors.current())
    except ValueError as exc:
        _400(exc)
    if not d:
        _404(iid)
    return out(d, pictures=await pictures(_db(), [d]))


@router.delete("/{iid}")
async def api_delete(iid: str):
    db = _db()
    d = await get(db, iid)
    if not d:
        _404(iid)
    if not may_delete(d):
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    await remove(db, iid)
    return {"deleted": iid}
