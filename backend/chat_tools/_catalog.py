"""What the Product Catalog's writing tools share (catalog_read_page,
catalog_add_product, catalog_edit_product, catalog_remove_product,
catalog_add_maker): the makers and their products (backend/manufacturers.py)
named the way a person says them, a maker found or made for a site, the
page's link to a run, and the products as the model reads them back.
Read and written through the asker's workspace (ctx.db), with the rights
the Product Catalog's API routes need (backend/access.py "draw")."""

from __future__ import annotations

import re
import urllib.parse

from .. import manufacturers as mf
from . import ToolError
from ._rights import need  # noqa: F401 - the catalog tools' too

SHOW = 25                  # makers or products a "which one?" names


def _words(ref: str) -> list[str]:
    return [w for w in re.split(r"[\s,;/]+", mf.fold(ref)) if w]


def looks_like_url(ref: str) -> bool:
    ref = str(ref or "").strip()
    return "://" in ref or bool(re.match(r"^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(/|$)", ref, re.I))


def as_url(ref: str) -> str:
    ref = str(ref or "").strip()
    return ref if "://" in ref else "https://" + ref


async def checked(url: str) -> str:
    """The address, if the crawler may fetch it (http(s), a public host:
    manufacturers.check, the same SSRF rules), or a ToolError saying why."""
    url = str(url or "").strip()
    if not url:
        raise ToolError("give the page's address, like https://www.example.com/products/hinge")
    try:
        return await mf.check(as_url(url))
    except mf.Refused as exc:
        raise ToolError(f"{url}: {exc}") from exc


async def maker(db, ref: str) -> dict:
    """The manufacturer `ref` names: its id, or words of its name, site or
    domain ("Doğuş", "robo90.com"). Several or none: a ToolError naming
    them, so the model can ask again with one id."""
    ref = str(ref or "").strip()
    if not ref:
        raise ToolError("say which manufacturer: its id or its name (manufacturer_search lists them)")
    got = await mf.get(db, ref)
    if got:
        return got
    every = await mf.listing(db)
    if looks_like_url(ref):
        one = await for_site(db, as_url(ref))
        if one:
            return one
    w = _words(ref)
    hay = {d["_id"]: mf.fold(f"{d['_id']} {d.get('name')} {d.get('domain')} {d.get('url')}") for d in every}
    hits = [d for d in every if w and all(x in hay[d["_id"]] for x in w)]
    whole = [d for d in hits if mf.fold(d.get("name")) == mf.fold(ref)]
    hits = whole if len(whole) == 1 else hits
    if len(hits) == 1:
        return hits[0]
    names = ", ".join(f"{d['_id']} ({d.get('name')}, {d.get('domain')})" for d in (hits or every)[:SHOW])
    if hits:
        raise ToolError(f"{len(hits)} manufacturers match {ref!r}: {names}. Ask again with one id.")
    if not every:
        raise ToolError(f"there is no manufacturer {ref!r} - there are none in this workspace yet")
    raise ToolError(f"no manufacturer {ref!r} in this workspace. There are: {names}")


async def for_site(db, url: str) -> dict | None:
    """The manufacturer kept for the site `url` is on (the same registrable
    domain; the one on the very same host first), or None."""
    u = mf.normalise(as_url(url))
    if not u:
        return None
    host = urllib.parse.urlsplit(u).hostname or ""
    dom = mf.registrable(host)
    same = [d for d in await mf.listing(db) if d.get("domain") == dom]
    same.sort(key=lambda d: (urllib.parse.urlsplit(d.get("url") or "").hostname != host, d.get("created_at") or ""))
    return same[0] if same else None


async def made_for(db, page: str, name: str = "", by: dict | None = None) -> dict:
    """A new manufacturer for the site `page` is on, as the Product
    Catalog's "Only this page" add makes one (POST /api/manufacturers with
    `only`): its site's root, named from the host unless `name` says, the
    proxy of Settings > Proxy as its choice."""
    proxy = mf.proxy_state()["default"]
    if proxy != "off" and not mf.proxy_state()["configured"]:
        proxy = "off"
    try:
        return await mf.create(db, mf._root_of(page), name, "", proxy, by)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc


def product(doc: dict, ref: str) -> dict:
    """The product of `doc` that `ref` names: its id, or words of its name,
    code or specs (a name or code said whole wins)."""
    ref = str(ref or "").strip()
    prods = doc.get("products") or []
    if not ref:
        raise ToolError("say which product: its id (manufacturer_search gives them) or its name or code")
    p = next((x for x in prods if x.get("id") == ref), None)
    if p:
        return p
    w = _words(ref)
    hits = [x for x in prods if w and all(y in mf._phay(x) for y in w)]
    whole = [x for x in hits if mf.fold(x.get("name")) == mf.fold(ref) or mf.fold(x.get("sku")) == mf.fold(ref)]
    hits = whole if len(whole) == 1 else hits
    if len(hits) == 1:
        return hits[0]
    if hits:
        names = "; ".join(f"{x.get('id')} {x.get('name')}" + (f" ({x['sku']})" if x.get("sku") else "")
                          for x in hits[:SHOW])
        raise ToolError(f"{len(hits)} products of {doc.get('name')} match {ref!r}: {names} - say one by its id")
    raise ToolError(f"no product {ref!r} in the catalog of {doc.get('name')} ({len(prods)} products; "
                    "manufacturer_search with this manufacturer lists them)")


def link(mid: str, rid: str | None = None) -> str:
    """The Product Catalog open at this maker (and run), as the page's own URL keeps it."""
    q = {"ws": "catalog", "m": mid, **({"run": rid} if rid else {})}
    return "/?" + urllib.parse.urlencode(q)


PRICE = re.compile(r"fiyat|price|preis|prix|prezzo|precio|tutar|ücret|ucret", re.I)


def price(p: dict) -> str:
    """A price the page gave, kept among the specs (there is no price field)."""
    return next((f"{k}: {v}" for k, v in (p.get("specs") or {}).items() if PRICE.search(k)), "")


def line(p: dict) -> str:
    """One product for the model: its id, name, code, category, price if any, page."""
    bits = [f"[{p.get('id')}] {p.get('name')}"]
    if p.get("sku"):
        bits.append(f"code {p['sku']}")
    if p.get("category"):
        bits.append(f"category {p['category']}")
    if price(p):
        bits.append(price(p))
    s = "  ".join(bits)
    specs = "; ".join(f"{k}: {v}" for k, v in list((p.get("specs") or {}).items())[:8] if not PRICE.search(k))
    if specs:
        s += f"  ({specs})"
    if p.get("url"):
        s += f"  <{p['url']}>"
    return s


def short(p: dict) -> str:
    """A product in a few words, for the page."""
    bits = [p.get("name") or ""]
    if p.get("sku"):
        bits.append(p["sku"])
    if price(p):
        bits.append(price(p).split(": ", 1)[-1])
    return " · ".join(b for b in bits if b)
