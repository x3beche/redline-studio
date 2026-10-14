"""The Parts page's built-in sources: sellers every workspace has from
the start, read by the system rather than explored from a site.

A built-in source is registered here once - its id, name, site, how its
products are read and which view the page shows them in - and the catalog
(backend/manufacturers.py) lists it above the workspace's own sites, opens
it by its id and leaves it out of the overview. It is never in the
`manufacturers` collection, so the catalog's writes (rename, explore,
delete) find nothing under its id and say 404; its products change where
they come from.

LCSC is the first: the parts drawer (backend/catalog_lcsc.py). McMaster-Carr
and GrabCAD are search-and-link sources (backend/linked.py: found through a
web search, saved by the person with the CAD files they downloaded; view
"linked"). Own items (backend/catalog_own.py) is the workspace's own
things that no site sells - filament, its own screws - typed in by hand: a
source that takes writes (`add`, `edit`, `delete`), so the catalog's
product routes reach it. JLCMC and other component sources are added the
same way: a module that calls `register` at import, and its name in
`_MODULES`.

`find_product` is the one way to a product by its maker's id and its own,
whichever kind of maker it is: what the inventory links each stock line to
(backend/inventory.py) and what a card sent in Chat reads (backend/dm.py).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from importlib import import_module
from typing import Awaitable, Callable

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Source:
    id: str
    name: str
    domain: str
    url: str
    summary: str
    # How the page shows its products ("drawer": the parts drawer's cabinet and part card).
    view: str
    # Its products as catalog products, for the asking workspace.
    products: Callable[[object], Awaitable[list[dict]]]
    # A source a person writes to (Own items): a product added, changed, dropped - as a site's by hand.
    add: Callable[..., Awaitable[dict]] | None = None
    edit: Callable[..., Awaitable[dict]] | None = None
    delete: Callable[..., Awaitable[int]] | None = None


SOURCES: dict[str, Source] = {}


def register(src: Source) -> Source:
    SOURCES[src.id] = src
    return src


def is_builtin(mid: str) -> bool:
    return mid in SOURCES


def writable(mid: str) -> Source | None:
    """The source a person adds products to by hand, else None."""
    src = SOURCES.get(mid)
    return src if src and src.add else None


async def maker(db, mid: str) -> dict:
    """One source as a manufacturers document (manufacturers.out shapes it).
    Shown even with nothing in it: a source that cannot be read is empty."""
    src = SOURCES[mid]
    try:
        products = await src.products(db)
    except Exception:
        log.exception("built-in source %s could not be read", mid)
        products = []
    added = [p.get("added_at") or "" for p in products]
    return {"_id": src.id, "name": src.name, "url": src.url, "domain": src.domain, "builtin": True, "view": src.view,
            "notes": "", "summary": src.summary, "categories": sorted({p["category"] for p in products if p.get("category")}),
            "docs": [], "products": products, "by": {"name": src.name},
            "created_at": min(added, default="") or None, "updated_at": max(added, default="") or None, "explored_at": None}


async def makers(db) -> list[dict]:
    return [await maker(db, mid) for mid in SOURCES]


async def maker_doc(db, mid: str) -> dict | None:
    """A maker with its products, by its id: a built-in source or one of the workspace's sites."""
    if mid in SOURCES:
        return await maker(db, mid)
    return await db["manufacturers"].find_one({"_id": mid})


async def find_product(db, mid: str, pid: str) -> tuple[dict, dict] | None:
    """(maker, product) by their ids, or None."""
    if not mid or not pid:
        return None
    m = await maker_doc(db, mid)
    p = next((x for x in (m or {}).get("products") or [] if str(x.get("id")) == str(pid)), None)
    return (m, p) if p else None


# The modules that register a source.
_MODULES = ("catalog_lcsc", "mcmaster", "grabcad", "catalog_own")
for _m in _MODULES:
    import_module(f"{__package__}.{_m}")
