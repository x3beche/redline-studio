"""web_search: a web search through Jina Search (backend/jina.py) - the
top results' titles, addresses and snippets, not the pages themselves."""

from __future__ import annotations

import re

from .. import jina
from . import Ctx, Result, Tool, ToolError

NOT_SET = ("Web search is not set up: it goes through Jina, and no Jina API key is saved "
           "(Settings > Proxy & Data). Say so to the person; an owner or admin can paste one there.")


async def run(ctx: Ctx, args: dict) -> Result:
    q = re.sub(r"\s+", " ", str(args.get("query") or "")).strip()[:300]
    site = str(args.get("site") or "").strip().lower()
    site = re.sub(r"^https?://", "", site).split("/")[0][:120]
    if not q:
        raise ToolError("say what to search for")
    if site and not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", site):
        raise ToolError("site is a domain only, like example.com")
    if not jina.configured():
        raise ToolError(NOT_SET)
    n = args.get("count") or 5
    try:
        n = max(1, min(int(n), jina.SEARCH_MAX))
    except (TypeError, ValueError):
        n = 5
    got = await jina.search(q, site=site, num=n, who="chat")
    if not got["ok"]:
        raise ToolError(f"the web search failed: {got['error']}")
    res = got["results"]
    v = {"query": q, "n": len(res), "site": site}
    if not res:
        return Result(text=f"Jina Search found nothing for {q!r}" + (f" on {site}" if site else "") + ".",
                      say="Searched the web for “{query}” · nothing found", vars=v, summary="no results")
    lines = [f"{i}. {r['title'] or r['url']}\n   {r['url']}\n   {r['description']}".rstrip()
             for i, r in enumerate(res, 1)]
    text = (f"Web search (Jina Search) for {q!r}" + (f", only {site}" if site else "") + ":\n\n" + "\n".join(lines)
            + "\n\nThese are snippets; read a page with web_read before quoting it, and link the pages you use.")
    return Result(text=text, say="Searched the web for “{query}” · {n} results", vars=v,
                  summary="\n".join(f"{r['title'] or r['url']} - {r['url']}" for r in res))


TOOL = Tool(
    name="web_search", package="general", level="read", order=60,
    label="Search the web",
    about="Searches the web through Jina Search: the top results' titles, addresses and snippets.",
    description="Search the web (Jina Search). Returns the top results' title, URL and a short snippet - not the "
                "pages; read one with web_read. Use it for what is not in this workspace: a maker's site, a "
                "product page, a standard, news. `site` keeps the search to one domain.",
    schema={"type": "object", "properties": {
        "query": {"type": "string", "description": "What to search for, as you would type it into a search engine"},
        "site": {"type": "string", "description": "Optional: only results from this domain, e.g. misumi.com.tr"},
        "count": {"type": "integer", "minimum": 1, "maximum": 10, "description": "How many results (default 5)"}},
        "required": ["query"]},
    running="Searching the web for “{query}”", failed="Could not search the web",
    run=run)
