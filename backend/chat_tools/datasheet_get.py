"""datasheet_get: a part's datasheet - the copy kept with the drawer, or
fetched from LCSC now and kept (what the datasheet button does)."""

from __future__ import annotations

import asyncio

from .. import lcsc, pdftext
from . import Ctx, Result, Tool, ToolError, size
from ._parts import code, why


async def run(ctx: Ctx, args: dict) -> Result:
    c = code(args)
    try:
        got = await lcsc.datasheet(c)
    except (ValueError, LookupError, OSError, TimeoutError) as exc:
        raise ToolError(why(exc)) from exc
    blob = got["pdf"]
    try:
        pages = await asyncio.to_thread(pdftext.page_count, blob)
    except pdftext.PdfError:
        pages = lcsc.pdf_pages(blob)
    mpn = got.get("mpn") or ""
    v = {"lcsc": c, "mpn": mpn, "pages": pages or "?", "size": size(len(blob))}
    where = "kept with the drawer" if got.get("cached") else "fetched from LCSC just now and kept"
    text = (f"The datasheet of {c}{' (' + mpn + ')' if mpn else ''}: {pages or '?'} pages, {v['size']}, {where}. "
            "Read it with datasheet_read.")
    summary = f"{mpn + ' · ' if mpn else ''}{pages or '?'} pages · {v['size']}" + (f"\n{got['url']}" if got.get("url") else "")
    if got.get("cached"):
        return Result(text=text, say="Datasheet: from the drawer · {pages} pages", vars=v, summary=summary)
    return Result(text=text, say="Fetched datasheet from LCSC · {size}", vars=v, summary=summary)


TOOL = Tool(
    name="datasheet_get", level="change", order=40,
    about="Takes a part's datasheet from the drawer, or fetches it from LCSC and keeps it.",
    label="Get a datasheet",
    description="Get a part's datasheet PDF by LCSC number: the copy already kept, or fetched from LCSC "
                "and kept. Returns its page count and size; read it with datasheet_read.",
    schema={"type": "object", "properties": {
        "lcsc": {"type": "string", "description": "The LCSC part number, like C111607"}},
        "required": ["lcsc"]},
    running="Getting the datasheet of {lcsc}", failed="Could not get the datasheet of {lcsc}",
    run=run)
