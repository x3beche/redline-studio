"""catalog_read_page: product pages read into the Product Catalog, as its
"Add from a page" does (POST /api/manufacturers/{mid}/read-page, and for a
site no maker is kept for, POST /api/manufacturers with `only`): a page-run
(backend/manufacturers.py `start_job` with `only`, kind "page") reads just
those pages - and with `follow` the product pages they link to - under the
crawler's rules (public http(s) only, robots.txt), and the model adds what
it finds to that maker's catalog; nothing in it is dropped.

The run goes on in the background: the tool hands back its id and the
link to watch it at once, or - `wait`, the default - waits up to WAIT
seconds for a short run and says which products it added."""

from __future__ import annotations

import asyncio

from .. import manufacturers as mf
from . import Ctx, Result, Tool, ToolError, clip
from ._catalog import checked, for_site, line, link, looks_like_url, made_for, maker, need, short

WAIT = 90.0                # seconds the tool waits for a run, at most
POLL = 1.0


async def _maker(ctx: Ctx, args: dict, pages: list[str]) -> tuple[dict, bool]:
    """The maker the pages go to, and whether it was made for them now."""
    ref = str(args.get("manufacturer") or "").strip()
    if ref and not looks_like_url(ref):
        return await maker(ctx.db, ref), False
    site = ref or pages[0]
    if not ref:
        doms = sorted({mf._domain_of(u) for u in pages})
        if len(doms) > 1:
            raise ToolError(f"the pages are on different sites ({', '.join(doms)}): say which manufacturer they go "
                            "to (`manufacturer`), or read each site's pages on their own")
    else:
        site = await checked(site)
    doc = await for_site(ctx.db, site)
    if doc:
        return doc, False
    return await made_for(ctx.db, site, str(args.get("name") or ""), ctx.actor or None), True


async def _until_done(db, jid: str, most: float) -> dict | None:
    loop = asyncio.get_running_loop()
    end = loop.time() + most
    while True:
        d = await mf.job(db, jid)
        if not d or d.get("status") not in mf.ACTIVE or loop.time() >= end:
            return d
        await asyncio.sleep(min(POLL, max(0.0, end - loop.time())))


async def run(ctx: Ctx, args: dict) -> Result:
    need("POST", "/api/manufacturers")
    urls = args.get("urls") if args.get("urls") is not None else args.get("url")
    if isinstance(urls, str):
        urls = [urls]
    if not isinstance(urls, list) or not [u for u in urls if str(u or "").strip()]:
        raise ToolError("give `urls`: the address of the product page (or a list or category page), like "
                        "https://www.example.com/urun/x")
    if len(urls) > mf.ONLY_MAX:
        raise ToolError(f"at most {mf.ONLY_MAX} pages at once")
    pages: list[str] = []
    for u in urls:
        if str(u or "").strip():
            u = await checked(u)
            if u not in pages:
                pages.append(u)
    follow = bool(args.get("follow"))
    wait = args.get("wait") is not False
    doc, made = await _maker(ctx, args, pages)
    mid, name = doc["_id"], doc.get("name") or doc["_id"]
    need("POST", f"/api/manufacturers/{mid}/read-page")
    before = {mf.product_key(p): p for p in doc.get("products") or []}
    try:
        jd, started = await mf.start_job(ctx.db, mid, None, ctx.actor or None, only=pages, follow=follow)
    except (LookupError, ValueError) as exc:
        raise ToolError(str(exc).strip("'\"")) from exc
    jid = jd["_id"]
    url = link(mid, jid)
    vars_ = {"name": name, "m": mid, "run": jid, "link": url}
    madeline = (f"A new manufacturer was made for the site: {mid} \"{name}\" ({doc.get('url')}).\n" if made else "")
    if not started:
        text = (f"{madeline}A run of \"{name}\" ({mid}) is already going (run {jid}, {jd.get('status')}); one maker "
                f"runs one at a time, so these pages were not read. Watch it: {url} - and ask again when it is done.")
        return Result(text=text, say="A run of {name} is already going", vars=vars_, summary=f"run {jid} already going")
    what = f"{len(pages)} page(s)" + (" and the product pages they link to" if follow else "")
    if not wait:
        text = (f"{madeline}Started reading {what} into the catalog of \"{name}\" ({mid}): run {jid}, through "
                f"the proxy choice \"{jd.get('proxy')}\". It runs in the background (a page takes a minute or so); "
                f"the person can watch it here: {url}")
        return Result(text=text, say="Reading the page into {name}", vars=vars_, summary=f"run {jid} started")
    d = await _until_done(ctx.db, jid, WAIT) or jd
    status = d.get("status")
    if status in mf.ACTIVE:
        text = (f"{madeline}Reading {what} into the catalog of \"{name}\" ({mid}) is still going after "
                f"{int(WAIT)} s (run {jid}, {status}). It goes on in the background; watch it here: {url} - "
                "manufacturer_search reads the catalog once it is done.")
        return Result(text=text, say="Reading the page into {name}", vars=vars_, summary=f"run {jid} still {status}")
    if status != "done":
        why = d.get("error") or status
        raise ToolError(f"the page run {jid} {('was ' + status) if status == 'cancelled' else 'failed'}: {why}. "
                        + (f"The manufacturer {mid} \"{name}\" was made for the site and is kept, empty. "
                           if made else "") + f"Its steps: {url}")
    after = (await mf.get(ctx.db, mid)) or doc
    prods = after.get("products") or []
    new = [p for p in prods if mf.product_key(p) not in before]
    filled = [p for p in prods if mf.product_key(p) in before and p != before[mf.product_key(p)]]
    found = d.get("products_found") or 0
    rows = [f"- added {line(p)}" for p in new] + [f"- already in the catalog, filled in: {line(p)}" for p in filled]
    text = (f"{madeline}Read {what} into the catalog of \"{name}\" ({mid}), run {jid}: {found} product(s) found, "
            f"{len(new)} added, {len(filled)} already there; the catalog holds {len(prods)} now. The [id]s are how "
            f"inventory_add links them. Run: {url}\n" + "\n".join(rows))
    if len(new) == 1:
        say, v = "Added {product} to the catalog of {name}", {"product": new[0].get("name")}
    else:
        say, v = "Added {n} products to the catalog of {name}", {"n": len(new)}
    return Result(text=clip(text), say=say, vars={**vars_, **v, "found": found},
                  summary="\n".join(short(p) for p in new + filled)[:600] or f"{found} found, none new")


TOOL = Tool(
    name="catalog_read_page", package="mfr", level="change", order=70, default=True,
    label="Read a page into the catalog",
    about="Reads a product or shop page and adds the products on it to a maker's catalog.",
    description="Add the products on one or more web pages to the Product Catalog - a product page on a maker's "
                "or a shop's site, or a list or category page (every product on it). `urls`: 1-10 public http(s) "
                "addresses. `follow`: also read the product pages they link to (same site, one link deep, up to "
                "30) - for a list page. `manufacturer`: the maker's id or words of its name; leave it out and the "
                "maker kept for the page's site is used, or a new one is made for that site (named from the host "
                "unless `name` says). A run reads the pages (robots.txt obeyed) and the model adds what it finds; "
                "nothing already in the catalog is dropped, the same product is merged, not doubled. It runs in "
                "the background: with `wait` (default true) the tool waits up to 90 s and says the products added "
                "(their ids, names, codes, prices if the page gave them); otherwise, or when it takes longer, it "
                "returns the run's id and a link the person can watch it on - give them that link. Use it when the "
                "person gives a product or shop page, or asks to add something from a site to the catalog; then "
                "inventory_add can stock what it added.",
    schema={"type": "object", "properties": {
        "urls": {"type": "array", "items": {"type": "string"}, "description": "The pages' addresses (1-10)"},
        "follow": {"type": "boolean", "description": "Also read the product pages they link to (for a list page)"},
        "manufacturer": {"type": "string", "description": "The maker's id or name; leave out to use or make the one "
                                                         "for the page's site"},
        "name": {"type": "string", "description": "A name for the maker when one is made for the site"},
        "wait": {"type": "boolean", "description": "Wait (up to 90 s) and report the products added (default true)"}},
        "required": ["urls"]},
    running="Reading the page into the catalog", failed="Could not read the page into the catalog",
    run=run)
