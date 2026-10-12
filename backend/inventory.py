"""Inventory ("Envanter"): what is on hand - each thing kept, how many,
and where it is.

An item is a name, a quantity in a unit (pcs, m, kg, roll, box... or any
short word), where it lies (a shelf, a bin, a box - free text), a
category, its part numbers (the maker's MPN, an LCSC number like C25744),
its maker, links to what the app already knows - a Product Catalog
product (backend/manufacturers.py: a manufacturer's id and the product's
id), the LCSC part (the PCB room's parts drawer), the board or model it
is for - an optional minimum (below it the item is low), an optional unit
price, notes and tags, who added it and who changed it last.

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

from . import access, actors

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
        "board": 120, "notes": 4000, "currency": 8}
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
            elif k == "notes":
                out[k] = str(v or "").strip()[:n]
            else:
                out[k] = re.sub(r"\s+", " ", str(v or "").strip())[:n]
    if "name" in out and not out["name"]:
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
    """A Product Catalog product named by its manufacturer's id and its own
    (checked against the catalog by `link_catalog`)."""
    if not raw:
        return None
    if not isinstance(raw, dict):
        raise ValueError("a catalog link is a manufacturer id and a product id")
    mid = str(raw.get("manufacturer") or raw.get("manufacturer_id") or "").strip()[:80]
    pid = str(raw.get("product") or raw.get("product_id") or "").strip()[:80]
    if not mid:
        return None
    keep = {"manufacturer": mid, "product": pid}
    for k in ("manufacturer_name", "product_name", "url", "sku"):
        if raw.get(k):
            keep[k] = str(raw[k]).strip()[:300]
    return keep


async def link_catalog(db, ref: dict | None) -> dict | None:
    """The catalog link with the names it points at, read from the Product
    Catalog of this workspace; a ValueError when there is no such product."""
    if not ref:
        return None
    m = await db["manufacturers"].find_one({"_id": ref["manufacturer"]})
    if not m:
        raise ValueError(f"there is no manufacturer {ref['manufacturer']!r} in the Product Catalog")
    out = {"manufacturer": m["_id"], "manufacturer_name": m.get("name") or m["_id"], "product": ref.get("product") or ""}
    if out["product"]:
        p = next((x for x in m.get("products") or [] if x.get("id") == out["product"]), None)
        if not p:
            raise ValueError(f"{m.get('name') or m['_id']} has no product {out['product']!r} in its catalog")
        out.update(product_name=p.get("name") or "", url=p.get("url") or "", sku=p.get("sku") or "",
                   category=p.get("category") or "")
    else:
        out["url"] = m.get("url") or ""
    return {k: v for k, v in out.items() if v not in (None, "")} | {"product": out["product"]}


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

def _hay(d: dict) -> str:
    cat = d.get("catalog") or {}
    return fold(" ".join(str(x or "") for x in (
        d.get("name"), d.get("mpn"), d.get("lcsc"), d.get("manufacturer"), d.get("category"), d.get("location"),
        d.get("board"), d.get("notes"), " ".join(d.get("tags") or []), cat.get("manufacturer_name"),
        cat.get("product_name"), cat.get("sku"))))


def matches(d: dict, q: str = "", category: str = "", location: str = "", low: bool = False) -> bool:
    if low and not is_low(d):
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


async def listing(db, q: str = "", category: str = "", location: str = "", low: bool = False) -> list[dict]:
    """The items that match, by name."""
    rows = [d for d in await everything(db) if matches(d, q, category, location, low)]
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
    """A Product Catalog product named the way a person says it: the
    manufacturer by its id or words of its name or site, the product by its
    id or words of its name, code or specs. A ValueError names the
    candidates when the words fit several or none."""
    from .manufacturers import _phay
    maker, product = str(maker or "").strip(), str(product or "").strip()
    if not maker or not product:
        raise ValueError("say the manufacturer and the product")
    m = await db["manufacturers"].find_one({"_id": maker})
    if not m:
        every = [d async for d in db["manufacturers"].find({})]
        w = _words(maker)
        hits = [d for d in every if w and all(x in fold(f"{d['_id']} {d.get('name')} {d.get('domain')} {d.get('url')}")
                                              for x in w)]
        if len(hits) != 1:
            names = ", ".join(f"{d['_id']} ({d.get('name')})" for d in (hits or every)[:20])
            raise ValueError(f"{len(hits) or 'no'} manufacturer(s) match {maker!r}" + (f": {names}" if names else ""))
        m = hits[0]
    prods = m.get("products") or []
    p = next((x for x in prods if x.get("id") == product), None)
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
    return await add(db, raw, by, note or "taken from the Product Catalog", rows=rows)


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
    return {"items": len(rows), "low": sum(1 for d in rows if is_low(d)),
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
            f["manufacturer"] = f.get("manufacturer") or cat.get("manufacturer_name") or ""
            f["mpn"] = f.get("mpn") or cat.get("sku") or ""
            f["category"] = f.get("category") or pcat or ""
    return f


async def create(db, raw: dict, by: dict | None = None, reason: str = "") -> dict:
    """A new item, as it was given (no merging - see `add`)."""
    return await _insert(db, await _fields(db, raw), by, reason)


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
        return await _insert(db, f, by, reason), False
    who, now = _who(by), _now()
    after = round(float(have.get("quantity") or 0) + f["quantity"], 6)
    if after > MAX_QTY:
        raise ValueError("the quantity is out of range")
    fill = {k: f[k] for k in ("location", "category", "mpn", "lcsc", "manufacturer", "board", "currency", "catalog",
                              "min_stock", "price") if f.get(k) not in (None, "", []) and have.get(k) in (None, "", [])}
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


def may_delete(doc: dict) -> bool:
    """One's own item, or anyone's with the right to delete."""
    return (doc.get("by") or {}).get("id") == actors.current().get("id") or access.allowed(access.current(), "delete")


async def remove(db, iid: str) -> bool:
    res = await db[COLL].delete_one({"_id": iid})
    return bool(getattr(res, "deleted_count", 0))


# ---- sharing: the inventory as a file --------------------------------------------

KEEP = ("name", "quantity", "unit", "location", "category", "mpn", "lcsc", "manufacturer", "board", "min_stock",
        "price", "currency", "notes", "tags", "catalog")


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

def out(d: dict, full: bool = True) -> dict:
    o = {k: v for k, v in d.items() if k not in ("_id", "workspace_id", "log")}
    o["id"] = d["_id"]
    o["low"] = is_low(d)
    o["value"] = round(float(d["price"]) * float(d.get("quantity") or 0), 2) if d.get("price") is not None else None
    log = d.get("log") or []
    o["last"] = log[-1] if log else None
    if full:
        o["log"] = list(reversed(log))
    return o


class ItemIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
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


@router.get("")
async def api_list(q: str = "", category: str = "", location: str = "", low: bool = False):
    return [out(d, full=False) for d in await listing(_db(), q, category, location, low)]


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
    return {"item": out(doc), "merged": merged}


@router.post("/bulk")
async def api_bulk(body: BulkIn):
    try:
        got = await add_many(_db(), body.items, actors.current(), body.reason, body.merge)
    except ValueError as exc:
        _400(exc)
    return {"results": [{"item": out(r["item"], full=False), "merged": r["merged"]} if "item" in r else r for r in got]}


@router.get("/stock")
async def api_stock(manufacturer: str = ""):
    """What is on hand of each catalog product - the Product Catalog's
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
    return {"item": out(doc), "merged": merged}


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
    d = await get(_db(), iid)
    if not d:
        _404(iid)
    return out(d)


@router.patch("/{iid}")
async def api_patch(iid: str, body: ItemPatch):
    raw = {k: v for k, v in body.model_dump(exclude={"reason"}).items() if v is not None or k in body.model_fields_set}
    try:
        d = await patch(_db(), iid, raw, actors.current(), body.reason)
    except ValueError as exc:
        _400(exc)
    if not d:
        _404(iid)
    return out(d)


@router.post("/{iid}/adjust")
async def api_adjust(iid: str, body: AdjustIn):
    try:
        d = await adjust(_db(), iid, body.delta, body.reason, actors.current())
    except ValueError as exc:
        _400(exc)
    if not d:
        _404(iid)
    return out(d)


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
