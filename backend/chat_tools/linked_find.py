"""mcmaster_find, grabcad_find: a search-and-link source's parts or models
for a description, from a web search of its site (Jina Search, as
web_search) - never the site itself (backend/linked.py, mcmaster.py,
grabcad.py). One tool per source, made from the same code."""

from __future__ import annotations

import re

from .. import catalog_builtin, jina, linked  # noqa: F401 - catalog_builtin registers the sources
from . import Ctx, Result, Tool, ToolError
from .web_search import NOT_SET


def _runner(src: str, extras: tuple[str, ...]):
    async def run(ctx: Ctx, args: dict) -> Result:
        k = linked.KINDS[src]
        q = re.sub(r"\s+", " ", str(args.get("query") or "")).strip()[:200]
        if not q:
            raise ToolError(f"say what {k.noun} to look for")
        if not jina.configured():
            raise ToolError(NOT_SET)
        words = " ".join([q, *(str(args.get(x) or "").strip() for x in extras if args.get(x))])
        try:
            n = max(1, min(int(args.get("count") or 8), 15))
        except (TypeError, ValueError):
            n = 8
        got = await linked.find(k, words, count=n, who="chat")
        if got["error"] and not got["results"]:
            raise ToolError(f"the search failed: {got['error']}")
        res = got["results"]
        v = {"query": words, "n": len(res)}
        if not res:
            return Result(text=f"No {k.name} {k.noun}s came up for {words!r} (searched: " + "; ".join(got["queries"])
                               + "). Try other words: " + HINTS[src],
                          say=SAYS[src][0], vars=v, summary="nothing found")
        saved = set()
        if ctx.db is not None:
            saved = {d["key"] async for d in ctx.db[linked.COLL].find({"source": src}, {"key": 1})}
        lines = []
        for i, r in enumerate(res, 1):
            facts = " · ".join(f"{a} {b}" for a, b in r["specs"].items())
            lines.append(f"{i}. {r['key']} - {r['title']}" + (f" (by {r['author']})" if r.get("author") else "")
                         + (" [saved]" if r["key"] in saved else "") + f"\n   {r['url']}  ({k.how})"
                         + (f"\n   {facts}" if facts else ""))
        text = (f"{k.name} {k.noun}s for {words!r}, read from web search results of {k.domain} (not from the site "
                f"itself - check each on its page):\n\n" + "\n".join(lines)
                + f"\n\nEach link is the {k.noun}'s own page; to get its CAD file: {k.how}, then drop it on the "
                f"saved {k.noun} in Catalog > {k.name}. Give the person the links with that hint."
                + (f" Say also: {k.caution}" if k.caution else "")
                + f" Save the ones they want with {src}_save.")
        return Result(text=text, say=SAYS[src][1], vars=v,
                      summary="\n".join(f"{r['key']} - {r['title']} - {r['url']}" for r in res))
    return run


HINTS = {
    "mcmaster": "the part's kind first, then size and material as McMaster writes them (\"socket head screw 18-8 "
                "stainless M3 x 0.5 mm 10 mm long\"), or a bearing's trade number (\"608 ball bearing\").",
    "grabcad": "what the thing is, plainly (\"NEMA 17 stepper motor\", \"608 bearing\"), maybe with a maker's part "
               "number.",
}
SAYS = {
    "mcmaster": ("Looked on McMaster-Carr for “{query}” · nothing found", "Looked on McMaster-Carr for “{query}” · {n} parts"),
    "grabcad": ("Looked on GrabCAD for “{query}” · nothing found", "Looked on GrabCAD for “{query}” · {n} models"),
}
COUNT = {"type": "integer", "minimum": 1, "maximum": 15, "description": "How many at most (default 8)"}

TOOLS = [
    Tool(
        name="mcmaster_find", package="commandcode", level="read", order=62,
        label="Find on McMaster-Carr",
        about="Finds McMaster-Carr part numbers through a web search of mcmaster.com.",
        description="Find McMaster-Carr parts for a description (\"M3x10 stainless socket head cap screw\", \"608 "
                    "bearing\"): a web search of mcmaster.com's indexed pages (McMaster's own site is never read), "
                    "returning part numbers with their title, link (https://www.mcmaster.com/<part>/) and the specs "
                    "the snippet shows. Give the links; the STEP is downloaded on the part's page "
                    "(CAD → 3-D STEP → Save).",
        schema={"type": "object", "properties": {
            "query": {"type": "string", "description": "The part as you would describe it to McMaster: kind, size, material"},
            "material": {"type": "string", "description": "Optional: e.g. 18-8 stainless steel, brass, nylon"},
            "thread": {"type": "string", "description": "Optional: e.g. M3 x 0.5 mm, 1/4\"-20"},
            "length": {"type": "string", "description": "Optional: e.g. 10 mm long"},
            "count": COUNT}, "required": ["query"]},
        running="Looking on McMaster-Carr for “{query}”", failed="Could not look on McMaster-Carr",
        run=_runner("mcmaster", ("material", "thread", "length"))),
    Tool(
        name="grabcad_find", package="commandcode", level="read", order=63,
        label="Find on GrabCAD",
        about="Finds CAD models in GrabCAD's library through a web search.",
        description="Find CAD models in GrabCAD's library for a description (\"NEMA 17 stepper motor\"): a web search "
                    "of grabcad.com's indexed pages (GrabCAD itself is never read, no login), returning each model's "
                    "title, uploader, page (https://grabcad.com/library/<slug>) and what the snippet says (formats, "
                    "likes, downloads). Give the links; the files are downloaded on the page (Download files, with a "
                    "free GrabCAD login). Always say to check the model's licence before using it in a product.",
        schema={"type": "object", "properties": {
            "query": {"type": "string", "description": "What the model is: a part, a product, a maker's part number"},
            "format": {"type": "string", "description": "Optional: a file format wanted, e.g. STEP"},
            "count": COUNT}, "required": ["query"]},
        running="Looking on GrabCAD for “{query}”", failed="Could not look on GrabCAD",
        run=_runner("grabcad", ("format",))),
]
