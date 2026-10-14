"""datasheet_get: a part's datasheet put in the datasheet library (when it
is not there already) and its contents listed - from LCSC's copy kept with
the drawer (fetched from LCSC the first time), the PDF attached to a Parts
product, or a PDF link (fetched into Files > Parts/Datasheets, the
manufacturers' fetching rules: never McMaster-Carr or GrabCAD).

The datasheet library's fetch tool (what the plan called datasheet_fetch):
the name is the one the tool always had, so people's on/off choice and old
conversations keep it."""

from __future__ import annotations

from .. import datasheets as ds
from . import Ctx, Result, Tool, ToolError, size
from ._datasheets import CITE, ensure, name, notes, ref, ref_vars
from ._rights import need

TOC_SHOWN = 40
SAY = {"library": "Datasheet of {part}: in the library · {pages} pages",
       "indexed": "Datasheet of {part} added to the library · {pages} pages",
       "fetched": "Fetched the datasheet of {part} · {pages} pages · {size}",
       "refreshed": "Datasheet of {part} read again · {pages} pages"}
WHERE = {"library": "already in the datasheet library", "indexed": "put in the datasheet library just now",
         "fetched": "fetched just now and put in the datasheet library",
         "refreshed": "its source changed: read again just now"}


async def run(ctx: Ctx, args: dict) -> Result:
    url = str(args.get("url") or "").strip()
    if url and not str(args.get("part") or args.get("lcsc") or "").strip():
        r = ds.Ref(key=ds.url_key(url), name=url.rsplit("/", 1)[-1][:80])
    else:
        r = await ref(ctx, args)
    need("POST", "/api/datasheets/product/x/y")             # it keeps something: the page's Fetch needs the same
    e, how = await ensure(ctx, r, url=url, refresh=bool(args.get("refresh")))
    who = name(e)
    src = e.get("source") or {}
    origin = {"lcsc": "LCSC", "file": "the product's attached PDF", "url": src.get("url") or "a link"}.get(src.get("kind"), "?")
    toc = e.get("toc") or []
    keyed = [h for h in toc if h.get("k") not in ("other", "legal")]
    shown = (keyed + [h for h in toc if h not in keyed])[:TOC_SHOWN]
    shown.sort(key=lambda h: h["p"])
    heads = "\n".join(f"p. {h['p']}  {h['t']}" for h in shown) or "(no headings found - search it, or read pages by number)"
    v = {"part": who, "lcsc": r.lcsc or who, "pages": e.get("pages") or "?", "size": size(e.get("bytes") or 0),
         "how": how, **ref_vars([(e["_id"], 1, (e.get("part") or {}).get("mpn") or who)])}
    text = (f"The datasheet of {who}: {e.get('pages')} pages, {v['size']}, from {origin}, {WHERE[how]} "
            f"(library id {e['_id']}, fetched {str(e.get('fetched_at') or '')[:10]}). {notes(e)}\n"
            f"Find answers in it with datasheet_search(query, part) and read pages or a section with datasheet_read. "
            f"{CITE}\n\nIts headings:\n{heads}")
    summary = f"{e.get('pages')} pages · {v['size']} · {origin}\n" + "\n".join(
        f"p. {h['p']} {h['t']}" for h in shown if h.get("k") != "other")[:500]
    return Result(text=text, say=SAY[how], vars=v, summary=summary)


TOOL = Tool(
    name="datasheet_get", package="pcb", level="change", order=40,
    about="Puts a part's datasheet in the datasheet library and lists what is in it.",
    label="Get a datasheet",
    description="Put a part's datasheet in the datasheet library when it is not there (from LCSC for an LCSC part, the "
                "PDF attached to a Parts product, or a PDF link given as `url`) and list its pages and headings with "
                "their page numbers. `part` is an LCSC number (C9864), an MPN or a Parts product (maker:product); "
                "`url` alone keeps a datasheet no part names yet. `refresh` asks the source again. Then search it "
                "with datasheet_search and read pages with datasheet_read; cite values as (datasheet p. N).",
    schema={"type": "object", "properties": {
        "part": {"type": "string", "description": "The part: LCSC number (C9864), MPN, or maker:product"},
        "lcsc": {"type": "string", "description": "Or the LCSC part number alone, like C111607"},
        "url": {"type": "string", "description": "Optional: the datasheet PDF's own link (the maker's English one)"},
        "refresh": {"type": "boolean", "description": "Ask the source again even when it is kept"}}},
    running="Getting a datasheet", failed="Could not get the datasheet",
    run=run, undo=False)                         # the library is a cache of what the sources hold: nothing to undo
