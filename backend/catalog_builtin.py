"""The Product Catalog's built-in sources: sellers every workspace has from
the start, read by the system rather than explored from a site.

A built-in source is registered here once - its id, name, site, how its
products are read and which view the page shows them in - and the catalog
(backend/manufacturers.py) lists it above the workspace's own sites, opens
it by its id and leaves it out of the overview. It is never in the
`manufacturers` collection, so the catalog's writes (rename, explore,
delete) find nothing under its id and say 404; its products change where
they come from.

LCSC is the first: the parts drawer (backend/catalog_lcsc.py). JLCMC and
other component sources are added the same way: a module that calls
`register` at import, and its name in `_MODULES`.
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


SOURCES: dict[str, Source] = {}


def register(src: Source) -> Source:
    SOURCES[src.id] = src
    return src


def is_builtin(mid: str) -> bool:
    return mid in SOURCES


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


# The modules that register a source.
_MODULES = ("catalog_lcsc",)
for _m in _MODULES:
    import_module(f"{__package__}.{_m}")
