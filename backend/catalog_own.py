"""My Items as a seller in Parts: the workspace's things that
no maker's site sells - filament bought over a counter, its own screws, a
cable made up on the bench - typed in by hand.

A built-in source (backend/catalog_builtin.py), id `own`, that takes
writes: its products are added, changed and dropped through the catalog's
own product routes (`/api/manufacturers/own/products...`), in the same
shape and with the same checks as a product added by hand to a site's
catalog (manufacturers.manual_product). Each product is a document of its
own in `own_items` (the workspace's - backend/scope.py).

The inventory keeps no thing of its own: every stock line is a catalog
product's (backend/inventory.py). A line added with nothing in the catalog
to point at - "200 M3 nuts on shelf A" - gets a product here first
(`ensure`: the one of the same code or name, or a new one).
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone

from . import actors
from .catalog_builtin import Source, register

MID = "own"
NAME = "My Items"
COLL = "own_items"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def product_of(d: dict) -> dict:
    """A kept document as a catalog product."""
    p = {k: v for k, v in d.items() if k not in ("_id", "workspace_id")}
    p["id"] = d["_id"]
    p.setdefault("source", "manual")
    return p


async def products(db) -> list[dict]:
    return [product_of(d) async for d in db[COLL].find({}).sort("added_at", 1)]


async def _all(db) -> list[dict]:
    return await products(db)


async def add(db, fields: dict, by: dict | None = None) -> dict:
    """A new product, as a site's added by hand; manufacturers.Clash when
    one of the same code (or, without one, the same name) is here."""
    from . import manufacturers as mf
    have = await _all(db)
    p = mf.new_product(fields, have, by)
    await db[COLL].insert_one({**{k: v for k, v in p.items() if k != "id"}, "_id": p["id"]})
    return p


async def edit(db, pid: str, fields: dict, by: dict | None = None) -> dict:
    from . import manufacturers as mf
    have = await _all(db)
    old = next((x for x in have if x["id"] == pid), None)
    if not old:
        raise LookupError(f"no product {pid}")
    p = mf.revised_product(old, have, fields, by)
    await db[COLL].replace_one({"_id": pid}, {**{k: v for k, v in p.items() if k != "id"}, "_id": pid})
    return p


async def delete(db, ids: list[str]) -> int:
    n = 0
    for pid in dict.fromkeys(ids):
        res = await db[COLL].delete_one({"_id": pid})
        n += int(getattr(res, "deleted_count", 0) or 0)
    return n


async def ensure(db, fields: dict, by: dict | None = None) -> dict:
    """The product of these fields: the one already here of the same code
    (or, without one, the same name), else a new one."""
    from . import manufacturers as mf
    want = mf.manual_product(fields)
    key = mf.product_key(want)
    hit = next((p for p in await _all(db) if mf.product_key(p) == key), None)
    if hit:
        return hit
    return await add(db, fields, by or actors.current())


register(Source(
    id=MID, name=NAME, domain="", url="", view="own", products=products, add=add, edit=edit, delete=delete,
    summary="Things no site sells - filament, your own screws, a cable you made - typed in by hand, "
            "so they can be counted in stock like any product."))
