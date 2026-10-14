"""The order in which Workbench's outside lookups try their ways out
(Settings > Proxy & Data > Route order).

A route is one way out:

- `local`  - directly from this machine;
- `proxy`  - through the proxy of Settings > Proxy & Data (netproxy.py);
- `jina`   - through Jina Reader (jina.py), which reads a web page in a
             browser on Jina's side. Web pages only: a JSON API is not a
             page, so a consumer of those does not offer it at all.

A consumer is one kind of lookup, and it says which routes it can take:
the Parts page's crawler (manufacturers.py) takes all three, the
Drawer's LCSC / EasyEDA part lookups (lcsc.py) local and the proxy. Each
keeps an ordered list of the routes that are on: a request tries the first,
and on a refusal (403 / 429 / 503), a network failure or - for a web page
and a later Jina - a page empty without its script, the next.

A route that is on but not set up (no proxy host, no Jina key) is passed
over when a request goes out; an order with nothing left is refused.

Kept machine-wide in `server_settings` ("routes"), like the proxy itself,
and read with it (netproxy.load). A process that never read them - or
whose read failed - is told so when it asks (llm.NotLoaded), rather than
handed the default order: a lookup would go a way the saved order does
not. A read that found nothing saved is the default order.
Before this there were modes - Off / When refused / Always for the part
lookups, and those plus Jina Reader / Jina when refused for the catalog -
and they still load (`LEGACY`).
"""

from __future__ import annotations

from fastapi import HTTPException

COLL = "server_settings"
DOC_ID = "routes"

ROUTES = ("local", "proxy", "jina")
# Which routes each consumer can take, in the order the page shows them.
CONSUMERS: dict[str, tuple[str, ...]] = {
    "catalog": ("local", "proxy", "jina"),     # the Parts page's crawler: web pages
    "parts": ("local", "proxy"),               # the Drawer's LCSC / EasyEDA lookups: JSON APIs, no Jina
}
DEFAULTS: dict[str, list[str]] = {"catalog": ["local", "proxy"], "parts": ["local", "proxy"]}

# The modes there were before the order, as orders.
LEGACY: dict[str, list[str]] = {
    "off": ["local"],
    "fallback": ["local", "proxy"],
    "always": ["proxy", "local"],
    "jina": ["jina"],
    "jina_fallback": ["local", "jina", "proxy"],
}

_orders: dict[str, list[str]] = {}
_loaded = False
_load_error: str | None = None


class NoRoute(Exception):
    """Nothing in an order can carry a request now."""


def clean(consumer: str, value) -> list[str] | None:
    """An order as a consumer can take it: its routes, each once, in the
    order given - from a list, or from one of the old mode names. None when
    nothing usable is left (or the value is not an order at all)."""
    allowed = CONSUMERS[consumer]
    if isinstance(value, str):
        value = LEGACY.get(value)
    if not isinstance(value, (list, tuple)):
        return None
    out: list[str] = []
    for r in value:
        if r in allowed and r not in out:
            out.append(r)
    return out or None


def _ready() -> None:
    if _loaded:
        return
    from .llm import NotLoaded
    why = f"reading them failed ({_load_error})" if _load_error else "they were never read in this process"
    raise NotLoaded(f"Route orders not loaded: which way a lookup goes out is not known because {why} - "
                    "the process must await netproxy.load(db) first; the default order is not used in its place")


def loaded() -> bool:
    """Whether this process has read the route orders."""
    return _loaded


def order(consumer: str) -> list[str]:
    """The consumer's default order, as saved."""
    _ready()
    return list(_orders.get(consumer) or DEFAULTS[consumer])


def why_not(route: str) -> str | None:
    """Why a route cannot carry a request now, or None when it can."""
    if route == "proxy":
        from . import netproxy
        return None if netproxy.url() else "the proxy is not set up (Settings > Proxy & Data)"
    if route == "jina":
        from . import jina
        return None if jina.configured() else "Jina has no API key (Settings > Proxy & Data)"
    return None


def plan(consumer: str, wanted: list[str] | None = None) -> list[str]:
    """The routes a request will try, in order: the order given (else the
    consumer's own), without the ones not set up. NoRoute when none is left."""
    routes = clean(consumer, wanted) if wanted is not None else order(consumer)
    if not routes:
        raise NoRoute("no route is on - turn one on in the route order")
    got = [r for r in routes if why_not(r) is None]
    if not got:
        raise NoRoute("; ".join(dict.fromkeys(why_not(r) or "" for r in routes)))
    return got


def uses(route: str) -> bool:
    """Whether any consumer's default order has the route on."""
    return any(route in order(c) for c in CONSUMERS)


def label(routes: list[str] | None) -> str:
    """An order as a line: "local > proxy"."""
    return " > ".join(routes or []) or "-"


def public() -> dict:
    return {"routes": {r: {"ready": why_not(r) is None, "why": why_not(r)} for r in ROUTES},
            "consumers": {c: {"routes": list(rs), "order": order(c), "default": list(DEFAULTS[c])}
                          for c, rs in CONSUMERS.items()}}


def _from_proxy(conf: dict) -> dict[str, list[str]]:
    """The orders the old proxy mode meant, for a server that never saved one:
    the part lookups' mode was the catalog's default too."""
    mode = "off" if not conf.get("enabled") else (conf.get("mode") if conf.get("mode") in ("always", "fallback") else "fallback")
    return {c: clean(c, mode) or list(DEFAULTS[c]) for c in CONSUMERS}


async def load(db, proxy_conf: dict | None = None) -> dict[str, list[str]]:
    """Read the orders (netproxy.load does, with the proxy's settings). A
    failed read is kept and said by whatever asks next; orders read before
    it stay as they were."""
    global _orders, _loaded, _load_error
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    try:
        doc = await raw[COLL].find_one({"_id": DOC_ID})
    except Exception as exc:
        if not _loaded:
            _load_error = f"{type(exc).__name__}: {str(exc)[:200]}"
        raise
    if doc is None:
        # Kept at once, so a later change to the proxy does not move them.
        _orders = _from_proxy(proxy_conf or {})
        await raw[COLL].update_one({"_id": DOC_ID}, {"$setOnInsert": dict(_orders)}, upsert=True)
    else:
        _orders = {c: clean(c, doc.get(c)) or list(DEFAULTS[c]) for c in CONSUMERS}
    _loaded, _load_error = True, None
    return _orders


async def save(db, consumer: str, value: list[str]) -> list[str]:
    """Keep a consumer's default order. 400 for one it cannot take."""
    global _orders
    if consumer not in CONSUMERS:
        raise HTTPException(404, f"no such lookup: {consumer}")
    bad = [r for r in value if r not in CONSUMERS[consumer]]
    if bad:
        raise HTTPException(400, f"{consumer} cannot go through {', '.join(bad)}")
    got = clean(consumer, value)
    if not got:
        raise HTTPException(400, "keep at least one route on")
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    _orders = {**{c: order(c) for c in CONSUMERS}, consumer: got}
    await raw[COLL].update_one({"_id": DOC_ID}, {"$set": dict(_orders)}, upsert=True)
    return got
