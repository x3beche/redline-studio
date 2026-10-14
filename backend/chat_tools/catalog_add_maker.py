"""catalog_add_maker: a manufacturer added to Parts by its
site, as its "Add a manufacturer" does (POST /api/manufacturers,
backend/manufacturers.py `create`), and - only when asked - its whole site
explored (`start_job`): up to MAX_PAGES pages read and handed to the
"manufacturer" job's model, which costs that model's tokens. The run goes
on in the background; the tool hands back its id and the link to watch it."""

from __future__ import annotations

from .. import manufacturers as mf
from . import Ctx, Result, Tool, ToolError
from ._catalog import checked, for_site, link, need


async def run(ctx: Ctx, args: dict) -> Result:
    need("POST", "/api/manufacturers")
    url = await checked(args.get("url"))
    have = await for_site(ctx.db, url)
    if have and not args.get("again"):
        name = have.get("name") or have["_id"]
        return Result(text=f"\"{name}\" ({have['_id']}, {have.get('url')}) is already kept for that site, with "
                           f"{len(have.get('products') or [])} products - nothing was added. Read pages into it with "
                           f"catalog_read_page, or say `again` to add a second maker for the same site. {link(have['_id'])}",
                      say="{name} is already in the catalog", vars={"name": name, "m": have["_id"], "link": link(have["_id"])},
                      summary="already kept")
    try:                                               # the Parts page's default order of routes
        doc = await mf.create(ctx.db, url, str(args.get("name") or ""), str(args.get("notes") or ""), None,
                              ctx.actor or None)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc
    mid, name = doc["_id"], doc.get("name") or doc["_id"]
    text = f"Added the manufacturer {mid} \"{name}\" for {doc['url']} to Parts."
    vars_ = {"name": name, "m": mid, "link": link(mid)}
    if not args.get("explore"):
        return Result(text=text + f" Its catalog is empty: read product pages into it with catalog_read_page, or "
                                  f"explore its whole site when the person asks. {link(mid)}",
                      say="Added {name} to Parts", vars=vars_, summary=doc["url"])
    need("POST", f"/api/manufacturers/{mid}/explore")
    try:
        jd, _ = await mf.start_job(ctx.db, mid, None, ctx.actor or None)
    except (LookupError, ValueError) as exc:
        raise ToolError(f"{text} Its exploration could not start: {str(exc).strip(chr(39) + chr(34))}") from exc
    url_ = link(mid, jd["_id"])
    return Result(text=text + f" Exploring its whole site started (run {jd['_id']}): up to {mf.MAX_PAGES} pages are "
                              f"read and handed to the model, which takes some minutes and costs LLM tokens. The "
                              f"person can watch it here: {url_}",
                  say="Added {name} and started exploring its site", vars={**vars_, "run": jd["_id"], "link": url_},
                  summary=f"run {jd['_id']} started")


TOOL = Tool(
    name="catalog_add_maker", package="mfr", level="change", order=74, default=False,
    label="Add a manufacturer",
    about="Adds a manufacturer to Parts by its website, and explores the site if asked.",
    description="Add a manufacturer (a maker or a shop) to Parts by its website `url`, with an "
                "optional `name` and `notes` (when to use them). A site already kept is not added twice unless "
                "`again`. `explore`: also explore the whole site now - it reads up to 100 pages in the background "
                "for several minutes and the model reading them costs LLM tokens, so do it only when the person "
                "asks for the whole catalog; it returns the run's link to watch. For one product or a few pages, "
                "use catalog_read_page instead (it makes the maker for the site by itself).",
    schema={"type": "object", "properties": {
        "url": {"type": "string", "description": "The maker's website, like https://www.example.com"},
        "name": {"type": "string", "description": "Its name (else taken from the site)"},
        "notes": {"type": "string", "description": "The person's notes: what they use this maker for"},
        "explore": {"type": "boolean", "description": "Explore the whole site now (up to 100 pages, costs tokens)"},
        "again": {"type": "boolean", "description": "Add it even though a maker is kept for that site"}},
        "required": ["url"]},
    running="Adding a manufacturer", failed="Could not add the manufacturer",
    run=run)
