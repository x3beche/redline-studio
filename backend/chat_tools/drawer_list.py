"""drawer_list: what the drawer holds, a page at a time - all of it, one
category, or only the parts whose datasheet is kept."""

from __future__ import annotations

from .. import lcsc
from . import Ctx, Result, Tool
from ._parts import kept

PER_PAGE = 30
MAX_PER_PAGE = 60


def _place(r: dict) -> str:
    return f"{r.get('group') or '?'} › {r.get('branch') or '?'}"


def _in(r: dict, cat: str) -> bool:
    return cat in " ".join(str(r.get(k) or "") for k in ("group", "branch", "category")).lower()


async def run(ctx: Ctx, args: dict) -> Result:
    cat = str(args.get("category") or "").strip()
    only_ds = bool(args.get("with_datasheet"))
    try:
        per = max(1, min(int(args.get("per_page") or PER_PAGE), MAX_PER_PAGE))
        page = max(1, int(args.get("page") or 1))
    except (TypeError, ValueError):
        per, page = PER_PAGE, 1
    rows = await lcsc.known(ctx.db)
    hits = [r for r in rows if not cat or _in(r, cat.lower())]
    for r in hits:
        r["_ds"] = kept(r["lcsc"])
    if only_ds:
        hits = [r for r in hits if r["_ds"]]
    hits.sort(key=lambda r: (_place(r).lower(), str(r.get("mpn") or r.get("name") or "").lower(), r["lcsc"]))
    pages = max(1, -(-len(hits) // per))
    shown = hits[(page - 1) * per: page * per]
    what = ("parts with a datasheet kept" if only_ds else "parts") + (f" in {cat!r}" if cat else "")
    v = {"n": len(hits), "category": cat, "page": page, "pages": pages}
    if not hits:
        return Result(text=f"The drawer has no {what} ({len(rows)} parts in it in all).",
                      say="No parts in the drawer like that", vars=v, summary="none")
    if not shown:
        return Result(text=f"Page {page} is past the end: {len(hits)} {what}, {pages} page(s) of {per}.",
                      say="No parts in the drawer like that", vars=v, summary="past the end")
    lines = [f"{r['lcsc']}  {r.get('mpn') or r.get('name') or '?'}  {r.get('maker') or ''}"
             f"{'  ' + str(r['value']) if r.get('value') else ''}  [{_place(r)}]"
             f"  datasheet {'kept' if r['_ds'] else 'not fetched yet'}" for r in shown]
    more = f"\nPage {page} of {pages}; ask for page {page + 1} for more." if page < pages else ""
    text = (f"The drawer: {len(hits)} {what} ({len(rows)} parts in it in all). "
            f"Page {page} of {pages}, {per} a page:\n" + "\n".join(lines) + more)
    summary = "\n".join(f"{r['lcsc']} {r.get('mpn') or r.get('name') or ''}" for r in shown) + \
        (f"\n… page {page} of {pages}" if pages > 1 else "")
    if only_ds:
        say = "Listed {n} drawer parts with a datasheet"
    elif cat:
        say = "Listed {n} drawer parts in “{category}”"
    else:
        say = "Listed {n} drawer parts"
    return Result(text=text, say=say, vars=v, summary=summary)


TOOL = Tool(
    name="drawer_list", level="read", order=12,
    label="List the drawer",
    about="Lists the parts in the drawer, by category or only those with a datasheet.",
    description="List the parts kept in this workspace's parts drawer, a page at a time, with each "
                "part's LCSC number, MPN, maker, place in the drawer (category) and whether its "
                "datasheet is kept. Use it for questions like 'which datasheets do you have?' or "
                "'what MOSFETs are in the drawer?'. Filter by category words (matched against the "
                "drawer's group and branch, e.g. 'Transistors', 'Capacitors') and/or with_datasheet.",
    schema={"type": "object", "properties": {
        "category": {"type": "string", "description": "Words of a drawer group or branch, e.g. Transistors"},
        "with_datasheet": {"type": "boolean", "description": "Only parts whose datasheet is kept"},
        "page": {"type": "integer", "description": "Page number, from 1", "minimum": 1},
        "per_page": {"type": "integer", "description": f"Parts a page (default {PER_PAGE}, at most {MAX_PER_PAGE})",
                     "minimum": 1, "maximum": MAX_PER_PAGE}}},
    running="Listing the drawer", failed="Could not list the drawer",
    run=run)
