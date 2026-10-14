"""datasheet_search: the passages of the datasheet library that answer a
question, each with its part, page number and section - across every
datasheet kept, or one part's (put in the library first when it is not)."""

from __future__ import annotations

from .. import datasheets as ds
from . import Ctx, Result, Tool, ToolError
from ._datasheets import CITE, ensure, name, notes, ref, ref_vars

LIMIT, MOST = 6, 10


async def run(ctx: Ctx, args: dict) -> Result:
    query = str(args.get("query") or "").strip()
    if not query:
        raise ToolError("say what to look for, like 'maximum output current' or 'absolute maximum ratings'")
    try:
        limit = max(1, min(MOST, int(args.get("limit") or LIMIT)))
    except (TypeError, ValueError):
        limit = LIMIT
    keys, head, extra = None, "the datasheet library", ""
    one = None
    if str(args.get("part") or args.get("lcsc") or "").strip():
        r = await ref(ctx, args)
        one, _ = await ensure(ctx, r)
        keys, head, extra = [one["key"]], f"the datasheet of {name(one)} ({one.get('pages')} pages)", notes(one)
    try:
        got = await ds.search(ctx.db, query, keys, limit)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc
    v = {"query": query, "n": len(got["hits"]), "part": name(one) if one else "", "sheets": got["sheets"]}
    if not got["sheets"]:
        return Result(text="The datasheet library is empty. Name the part: datasheet_search(query, part=...) or "
                           "datasheet_get(part) puts its datasheet in the library first.",
                      say="The datasheet library is empty", vars=v, summary="no datasheets kept yet")
    if not got["hits"]:
        return Result(text=f"Nothing in {head} matches {query!r}. Try other words (the datasheet's own: "
                           "'output current', 'VIN', 'IOUT'), or read its contents with datasheet_get. " + extra,
                      say="No datasheet passage for “{query}”", vars=v, summary="no match")
    lines = []
    for i, h in enumerate(got["hits"], 1):
        sec = f", {h['section']}" if h["section"] else ""
        part = h["label"] + (f" ({h['lcsc']})" if h["lcsc"] and h["lcsc"] != h["label"] else "")
        body = "\n".join("    " + ln for ln in h["snippet"].split("\n"))
        lines.append(f"[{i}] {part} p. {h['page']}{sec}:\n{body}")
    text = (f"Passages of {head} for {query!r}, best first. {CITE} When a table row is cut or a value needs its "
            "conditions, read the page with datasheet_read(part, pages) or the section with "
            "datasheet_read(part, section). " + extra + "\n\n" + "\n".join(lines))
    v.update(ref_vars([(h["id"], h["page"], h["label"]) for h in got["hits"]]))
    pages = ", ".join(f"{h['label']} p. {h['page']}" for h in got["hits"][:4])
    v["pages"] = pages[:80]
    summary = "\n".join(f"p. {h['page']} {h['label']} · {h['section'] or '-'}" for h in got["hits"])
    say = "Searched the datasheet of {part} for “{query}” · {n} passages" if one else \
        "Searched the datasheets for “{query}” · {n} passages"
    return Result(text=text, say=say, vars=v, summary=summary)


TOOL = Tool(
    name="datasheet_search", package="pcb", level="read", order=45,
    about="Finds the passages of the kept datasheets that answer a question, with their page numbers.",
    label="Search datasheets",
    description="Search the datasheet library - every datasheet fetched before, or one part's - for the passages that "
                "answer a question ('maximum output current', 'absolute maximum ratings', 'pinout', 'RDS(on)'). "
                "Returns the best passages with part, page number, section and a short snippet (no whole pages). "
                "Questions about limits rank Absolute Maximum Ratings, Recommended Operating Conditions and "
                "Electrical Characteristics first; about pins the pin tables. Give `part` (LCSC number, MPN or a "
                "Parts product) to search one part - its datasheet is put in the library first when it is not "
                "there. Answer from the passages yourself and cite each value as (datasheet p. N); read the page "
                "with datasheet_read when a snippet cuts a table.",
    schema={"type": "object", "properties": {
        "query": {"type": "string", "description": "What to find, in the datasheet's words, like 'output current maximum'"},
        "part": {"type": "string", "description": "Optional: one part - LCSC number (C9864), MPN, or maker:product"},
        "limit": {"type": "integer", "description": f"Passages, at most {MOST} (default {LIMIT})"}},
        "required": ["query"]},
    running="Searching the datasheets for “{query}”", failed="Could not search the datasheets for “{query}”",
    run=run)
