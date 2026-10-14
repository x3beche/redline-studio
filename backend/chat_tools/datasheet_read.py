"""datasheet_read: a part's datasheet as text from the library - pages by
number, one section by its heading, or the pages that answer a query - and
a page as a picture for a model that reads images. Tables come as rows
(cells " | "); the datasheet is put in the library first when it is not."""

from __future__ import annotations

import asyncio
import re

from .. import datasheets as ds
from .. import pdftext
from . import Ctx, Result, Tool, ToolError, clip
from ._datasheets import CITE, ensure, name, notes, ref, ref_vars

MAX_PAGES = 4                         # pages of text in one call
FIND_PAGES = 3                        # pages a query brings back (file_read's too)
PAGE_MOST = 6000                      # characters of one page given back
SECTION_MOST = 6000                   # characters of one section given back


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
    """The pages where the query's words are, most hits first (file_read's way for any PDF)."""
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


def _page(p: dict, count: int) -> str:
    text = p.get("text") or ""
    if len(text) > PAGE_MOST:
        text = text[:PAGE_MOST] + "\n[... the rest of this page is cut - ask for a section instead]"
    return (f"--- page {p['n']} of {count} ---\n{text}"
            + ("\n(next to no text on this page: it is a picture - look at it with image_page)" if thin(p) else ""))


async def run(ctx: Ctx, args: dict) -> Result:
    r = await ref(ctx, args)
    spec = str(args.get("pages") or "").strip()
    section = str(args.get("section") or "").strip()
    query = str(args.get("query") or "").strip()
    image = args.get("image_page")
    e, _ = await ensure(ctx, r)
    who, count, did = name(e), e.get("pages") or 0, e["_id"]
    label = (e.get("part") or {}).get("mpn") or who
    v = {"lcsc": r.lcsc or who, "part": who, "count": count, "query": query, "section": section}
    if image is not None:
        try:
            n = int(image)
        except (TypeError, ValueError) as exc:
            raise ToolError("image_page is one page number") from exc
        if not ctx.vision:
            raise ToolError("this model does not read images - read the page's text instead")
        try:
            png, meta = await asyncio.to_thread(pdftext.render_png, await ds.pdf_of(ctx.db, e), n, 110)
        except (pdftext.PdfError, LookupError) as exc:
            raise ToolError(str(exc)) from exc
        return Result(text=f"Page {n} of {meta['count']} of the datasheet of {who}, as a picture (attached). {CITE}",
                      say="Looked at datasheet page {page}", vars={**v, "page": n, **ref_vars([(did, n, label)])},
                      summary=f"{meta['width']}×{meta['height']} px", image=png)
    if section and not spec:
        title, parts = await ds.section_of(ctx.db, e, section, SECTION_MOST)
        if not parts:
            heads = "; ".join(f"p. {h['p']} {h['t']}" for h in (e.get("toc") or [])[:30])
            return Result(text=f"No section {section!r} in the datasheet of {who}. Its headings: {heads or 'none found'}.",
                          say="No section “{section}” in the datasheet", vars=v, summary="not found")
        ns = sorted({p["page"] for p in parts})
        body = "\n\n".join(f"--- p. {p['page']} ---\n{p['text']}" for p in parts)
        v.update({"pages": span(ns), "section": title[:80], **ref_vars([(did, n, label) for n in ns])})
        return Result(text=clip(f"Datasheet of {who}, section {title!r} (pages {span(ns)}). {CITE}\n\n{body}"),
                      say="Read “{section}” of the datasheet · p. {pages}", vars=v, summary=body[:300])
    if query and not spec:
        got = await ds.search(ctx.db, query, [e["key"]], 8)
        ns = []
        for h in got["hits"]:
            if h["page"] not in ns:
                ns.append(h["page"])
        ns = ns[:2]
        if not ns:
            extra = notes(e)
            return Result(text=f"{query!r} is not in the text of the datasheet of {who} ({count} pages). "
                               "Try other words, or read pages by number. " + extra,
                          say="Searched the datasheet for “{query}” · not found", vars=v, summary="not found")
        pages = await ds.pages_of(ctx.db, e, ns)
        pages.sort(key=lambda p: ns.index(p["n"]))
    else:
        try:
            want = pdftext.parse_pages(spec or "1-3", count or 1, MAX_PAGES)
        except pdftext.PdfError as exc:
            raise ToolError(str(exc)) from exc
        pages = await ds.pages_of(ctx.db, e, want)
        if not pages:
            raise ToolError(f"no page {spec} in the library's copy of the datasheet of {who} - it has {count} pages"
                            + (f", the first {e.get('indexed')} read" if (e.get("indexed") or 0) < count else ""))
    ns = [p["n"] for p in pages]
    body = "\n\n".join(_page(p, count) for p in pages)
    extra = notes(e)
    text = clip(f"Datasheet of {who}, {count} pages. {CITE} {extra}\n\n" + body)
    v.update({"pages": span(sorted(ns)), **ref_vars([(did, n, label) for n in ns])})
    first = (pages[0].get("text") if pages else "")[:300]
    if query and not spec:
        return Result(text=text, say="Searched the datasheet for “{query}” · pages {pages}", vars=v, summary=first)
    if len(ns) == 1:
        return Result(text=text, say="Read datasheet page {pages}", vars=v, summary=first)
    return Result(text=text, say="Read datasheet pages {pages}", vars=v, summary=first)


TOOL = Tool(
    name="datasheet_read", package="pcb", level="read", order=50,
    about="Reads datasheet pages or one section as text, or looks at a page.",
    label="Read a datasheet",
    description="Read a part's datasheet from the library as text (tables as rows, cells split by ' | '): `pages` like "
                "'4' or '4-5' (at most 4 a call; the first 3 when nothing else is given), `section` for one section by "
                "its heading ('Absolute Maximum Ratings', 'Recommended Operating Conditions', 'Pin Configuration'), or "
                "`query` for the 2 pages that answer it best. `image_page` returns one page as a picture for a model "
                "that reads images (drawings, graphs, scanned pages). `part` is an LCSC number, MPN or Parts product; "
                "the datasheet is put in the library first when it is not. Prefer datasheet_search first and read "
                "only the pages it points to. Cite every value as (datasheet p. N).",
    schema={"type": "object", "properties": {
        "part": {"type": "string", "description": "The part: LCSC number (C9864), MPN, or maker:product"},
        "lcsc": {"type": "string", "description": "Or the LCSC part number alone, like C111607"},
        "pages": {"type": "string", "description": "Page numbers, like '4' or '4-5'"},
        "section": {"type": "string", "description": "A section's heading, like 'Absolute Maximum Ratings'"},
        "query": {"type": "string", "description": "Words to find, like 'RDS(on)'"},
        "image_page": {"type": "integer", "description": "One page number, as a picture"}}},
    running="Reading a datasheet", failed="Could not read the datasheet",
    run=run)
