"""datasheet_read: a part's datasheet as text, a few pages at a time - or
the pages where a phrase is - and a page as a picture for a model that
reads images."""

from __future__ import annotations

import asyncio
import re

from .. import lcsc, pdftext
from . import Ctx, Result, Tool, ToolError, clip
from ._parts import code, why

MAX_PAGES = 4                         # pages of text in one call
FIND_PAGES = 3                        # pages a query brings back


def span(ns: list[int]) -> str:
    """[1, 2, 3, 5] -> "1–3, 5"."""
    out, i = [], 0
    while i < len(ns):
        j = i
        while j + 1 < len(ns) and ns[j + 1] == ns[j] + 1:
            j += 1
        out.append(str(ns[i]) if i == j else f"{ns[i]}–{ns[j]}")
        i = j + 1
    return ", ".join(out)


def _compact(text: str) -> str:
    """Letters and digits only: "R DS(on)" and "RDS(on)" are the same words."""
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def best(pages: list[dict], query: str) -> list[int]:
    """The pages where the query's words are, most hits first."""
    words = [w for w in (_compact(w) for w in re.split(r"[\s,;]+", query)) if len(w) > 1]
    scored = []
    for p in pages:
        low = _compact(p["text"])
        hits = sum(low.count(w) for w in words)
        if hits:
            scored.append((hits + 100 * sum(w in low for w in words), p["n"]))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return sorted(n for _, n in scored[:FIND_PAGES])


def thin(p: dict) -> bool:
    """A page with next to no text: most likely a picture of one (a scan)."""
    return len(re.sub(r"\s+", "", p.get("text") or "")) < 80


async def run(ctx: Ctx, args: dict) -> Result:
    c = code(args)
    spec = str(args.get("pages") or "").strip()
    query = str(args.get("query") or "").strip()
    image = args.get("image_page")
    try:
        got = await lcsc.datasheet(c)
    except (ValueError, LookupError, OSError, TimeoutError) as exc:
        raise ToolError(why(exc)) from exc
    blob = got["pdf"]
    try:
        if image is not None:
            n = int(image)
            if not ctx.vision:
                raise ToolError("this model does not read images - read the page's text instead")
            png, meta = await asyncio.to_thread(pdftext.render_png, blob, n, 110)
            return Result(text=f"Page {n} of {meta['count']} of the datasheet of {c}, as a picture (attached).",
                          say="Looked at datasheet page {page}", vars={"lcsc": c, "page": n},
                          summary=f"{meta['width']}×{meta['height']} px", image=png)
        if query and not spec:
            whole = await asyncio.to_thread(pdftext.text, blob, "1-")
            ns = best(whole["pages"], query)
            if not ns:
                scans = sum(thin(p) for p in whole["pages"])
                hint = (f" {scans} of its pages have next to no text - they are pictures (a scan): look at them "
                        "with image_page." if scans else "")
                return Result(text=f"{query!r} is not in the text of the datasheet of {c} ({whole['count']} pages). "
                                   "Try other words, or read pages by number." + hint,
                              say="Searched the datasheet for “{query}” · not found", vars={"lcsc": c, "query": query},
                              summary="not found")
            got_pages, count = [p for p in whole["pages"] if p["n"] in ns], whole["count"]
        else:
            out = await asyncio.to_thread(pdftext.text, blob, spec or "1-3")
            got_pages, count = out["pages"][:MAX_PAGES], out["count"]
    except (pdftext.PdfError, ValueError) as exc:
        raise ToolError(str(exc)) from exc
    ns = [p["n"] for p in got_pages]
    body = "\n\n".join(f"--- page {p['n']} of {count} ---\n{p['text'] or p.get('error') or ''}"
                       + ("\n(next to no text on this page: it is a picture - look at it with image_page)"
                          if thin(p) else "") for p in got_pages)
    mpn = got.get("mpn") or ""
    text = clip(f"Datasheet of {c}{' (' + mpn + ')' if mpn else ''}, {count} pages. Cite pages as (datasheet p. N).\n\n"
                + body)
    v = {"lcsc": c, "pages": span(ns), "count": count, "query": query}
    first = (got_pages[0]["text"] if got_pages else "")[:300]
    if query and not spec:
        return Result(text=text, say="Searched the datasheet for “{query}” · pages {pages}", vars=v, summary=first)
    if len(ns) == 1:
        return Result(text=text, say="Read datasheet page {pages}", vars=v, summary=first)
    return Result(text=text, say="Read datasheet pages {pages}", vars=v, summary=first)


TOOL = Tool(
    name="datasheet_read", level="read", order=50,
    about="Reads datasheet pages as text, finds a phrase in it, or looks at a page.",
    label="Read a datasheet",
    description="Read a part's datasheet (by LCSC number) as text: `pages` like '1-3' or '2,5' (at most 4 "
                "pages a call; the first 3 when neither is given), or `query` to get the pages where words "
                "like 'RDS(on)' or 'absolute maximum' appear. `image_page` returns one page as a picture, "
                "for a model that reads images (drawings, graphs). Fetches the datasheet first if it never was.",
    schema={"type": "object", "properties": {
        "lcsc": {"type": "string", "description": "The LCSC part number, like C111607"},
        "pages": {"type": "string", "description": "Page numbers, like '1-3' or '2,5'"},
        "query": {"type": "string", "description": "Words to find, like 'RDS(on)'"},
        "image_page": {"type": "integer", "description": "One page number, as a picture"}},
        "required": ["lcsc"]},
    running="Reading the datasheet of {lcsc}", failed="Could not read the datasheet of {lcsc}",
    run=run)
