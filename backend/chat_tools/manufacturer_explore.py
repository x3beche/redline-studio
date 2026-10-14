"""manufacturer_explore: a manufacturer's whole site explored, as the
Manufacturers page's "Explore" does (POST /api/manufacturers/{id}/explore
- or, for a site not kept yet, "Add a manufacturer" with explore on,
POST /api/manufacturers): manufacturers.start_job, the same run - the same
robots.txt, pause between requests, page and depth limits, the maker's own
order of routes (direct, proxy, Jina) - in the background; the tool hands
back the run's id, status and the link to watch it.

Never two at once: while any exploration on this server is queued,
crawling, asking or merging, it says so and starts nothing. McMaster-Carr
and GrabCAD are never crawled (they are search-and-link sources:
backend/linked.py). It asks the person first: a run reads up to MAX_PAGES
pages and the model reading them costs tokens."""

from __future__ import annotations

import urllib.parse

from .. import manufacturers as mf
from . import Ctx, Result, Tool, ToolError
from ._catalog import as_url, checked, for_site, link, looks_like_url, maker, need

NEVER = ("mcmaster.com", "grabcad.com")          # search-and-link only (linked.py): their sites are never crawled


def forbidden(ref: str) -> str | None:
    """The site's domain when it is one never crawled."""
    host = urllib.parse.urlsplit(as_url(ref)).hostname or ""
    dom = mf.registrable(host)
    return dom if dom in NEVER else None


async def busy(db) -> tuple[dict | None, int]:
    """(this workspace's run going on now, how many go on elsewhere on the server)."""
    mine = next((d for d in await mf.jobs(db, mf.KEEP_JOBS + 10) if d and d.get("status") in mf.ACTIVE), None)
    raw = getattr(db, "raw", None)
    others = 0
    if raw is not None:
        async for d in raw[mf.JOBS].find({"status": {"$in": list(mf.ACTIVE)}}):
            if (not mine or d["_id"] != mine["_id"]) and not mf.orphaned(d):
                others += 1
    return mine, others


async def run(ctx: Ctx, args: dict) -> Result:
    ref = str(args.get("manufacturer") or args.get("url") or "").strip()
    if not ref:
        raise ToolError("say which manufacturer (its id or name) or give its website")
    # McMaster-Carr and GrabCAD: never crawled, whatever is asked.
    for r in (ref, str(args.get("url") or "")):
        if r and looks_like_url(r) and (dom := forbidden(r)):
            raise ToolError(f"{dom} is never crawled: McMaster-Carr and GrabCAD are found by web search and linked "
                            "(mcmaster_find, grabcad_find), not explored")
    doc = None
    url = str(args.get("url") or "").strip()
    if args.get("manufacturer"):
        doc = await maker(ctx.db, str(args["manufacturer"]))
    elif looks_like_url(ref):
        doc = await for_site(ctx.db, ref)
    if doc and (dom := forbidden(doc.get("url") or doc.get("domain") or "")):
        raise ToolError(f"{dom} is never crawled: McMaster-Carr and GrabCAD are search-and-link sources")
    if doc and str(doc["_id"]) in ("lcsc", "mcmaster", "grabcad", "own"):
        raise ToolError(f"{doc.get('name') or doc['_id']} is a built-in source of Parts, not a site to explore")
    mine, others = await busy(ctx.db)
    if mine:
        m = mine.get("manufacturer") or {}
        raise ToolError(f"an exploration is going on already: {m.get('name') or m.get('id')} is {mine.get('status')} "
                        f"(run {mine['_id']}, {link(m.get('id') or '', mine['_id'])}) - one at a time; wait for it to end")
    if others:
        raise ToolError("an exploration is going on already on this server (another workspace's) - one at a time; "
                        "try again when it has ended")
    made = False
    if doc is None:
        if not looks_like_url(url or ref):
            await maker(ctx.db, ref)                     # says which makers there are
        need("POST", "/api/manufacturers")
        page = await checked(url or ref)
        try:
            doc = await mf.create(ctx.db, page, str(args.get("name") or ""), "", None, ctx.actor or None)
        except ValueError as exc:
            raise ToolError(str(exc)) from exc
        made = True
    need("POST", f"/api/manufacturers/{doc['_id']}/explore")
    try:
        jd, started = await mf.start_job(ctx.db, doc["_id"], None, ctx.actor or None)
    except (LookupError, ValueError) as exc:
        raise ToolError(f"the exploration of {doc.get('name') or doc['_id']} could not start: "
                        f"{str(exc).strip(chr(39) + chr(34))}") from exc
    name = doc.get("name") or doc["_id"]
    url_ = link(doc["_id"], jd["_id"])
    status = jd.get("status") or "queued"
    if status == "failed":
        raise ToolError(f"the exploration of {name} did not start: {jd.get('error') or 'it failed at once'} ({url_})")
    text = ((f"Added the manufacturer {doc['_id']} \"{name}\" for {doc.get('url')} and started" if made else
             f"Started" if started else "Already running:") + f" exploring its site (run {jd['_id']}, {status}): up to "
            f"{mf.MAX_PAGES} pages, {mf.MAX_DEPTH} links deep, robots.txt obeyed, read by the model of the "
            f"manufacturer job - some minutes, and it costs LLM tokens; its catalog is replaced by what is found "
            f"(products changed by hand or holding files or stock stay). The person can watch it here: {url_}")
    return Result(text=text, say="Exploring {name}: {status}",
                  vars={"name": name, "m": doc["_id"], "run": jd["_id"], "status": status, "link": url_},
                  summary=f"run {jd['_id']} {status}")


TOOL = Tool(
    name="manufacturer_explore", package="mfr", level="change", order=75, default=False,
    label="Explore a manufacturer",
    about="Explores a manufacturer's whole site as the Manufacturers page does; one at a time, asks first.",
    description="Explore a manufacturer's whole website into its Parts catalog - as the Manufacturers page's "
                "Explore does: up to 100 pages read politely in the background (robots.txt, a pause between "
                "requests, the maker's own routes) and handed to the model, which takes minutes and costs LLM "
                "tokens; the catalog is replaced by what is found. Name a kept `manufacturer` (id or name), or give "
                "a site's `url` (a maker kept for that site is explored; else one is added first). Only one "
                "exploration runs at a time: while one is queued, crawling, asking or merging it says so and starts "
                "nothing. mcmaster.com and grabcad.com are never explored. Use it only when the person asks for a "
                "whole site; it asks them first and returns the run's id, status and link. For a few pages use "
                "catalog_read_page.",
    schema={"type": "object", "properties": {
        "manufacturer": {"type": "string", "description": "A kept manufacturer: its id or name"},
        "url": {"type": "string", "description": "Or the site's address"},
        "name": {"type": "string", "description": "With a new site: the maker's name (else taken from the site)"}}},
    running="Starting a manufacturer's exploration", failed="Could not start the exploration",
    asks=lambda args: True,
    run=run, undo="an exploration runs on its own - cancel it or remove the maker on the Parts page")
