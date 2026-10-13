"""drawer_search: the parts already in the drawer, by MPN, LCSC number or words."""

from __future__ import annotations

from .. import lcsc, part_usage
from . import Ctx, Result, Tool
from ._parts import kept

LIMIT = 10


def _hay(row: dict, facts: dict) -> str:
    return " ".join(str(x or "") for x in (
        row.get("lcsc"), row.get("name"), row.get("mpn"), row.get("value"), row.get("maker"),
        row.get("category"), row.get("group"), row.get("branch"), facts.get("description"),
        facts.get("package"))).lower()


def _boards(rows: list[dict]) -> str:
    if not rows:
        return "used on no board"
    on = ", ".join(f"{r['name']} ({', '.join(r['refs'])})" if r["refs"] else f"{r['name']} (not built yet)"
                   for r in rows)
    return f"used on {len(rows)} board{'s' if len(rows) != 1 else ''}: {on}"


async def run(ctx: Ctx, args: dict) -> Result:
    q = str(args.get("query") or "").strip()
    words = [w for w in q.lower().split() if w]
    rows = await lcsc.known(ctx.db)
    hits = []
    for r in rows:
        facts = lcsc._drawer_facts(r["lcsc"])
        hay = _hay(r, facts)
        if words and all(w in hay for w in words):
            hits.append({"lcsc": r["lcsc"], "mpn": r.get("mpn") or r.get("name"), "maker": r.get("maker"),
                         "value": r.get("value"), "package": facts.get("package"),
                         "drawer": f"{r.get('group')} › {r.get('branch')}",
                         "description": (facts.get("description") or "")[:160], "datasheet_kept": kept(r["lcsc"])})
    hits.sort(key=lambda h: (str(h["mpn"] or "").lower() != q.lower(), h["lcsc"]))
    shown = hits[:LIMIT]
    try:                                                # which boards use each (backend/part_usage.py)
        used = await part_usage.index(ctx.db) if shown else {}
    except Exception:                                   # noqa: BLE001 - the boards are a nicety here
        used = None
    for h in shown:
        h["boards"] = None if used is None else used.get(h["lcsc"]) or []
    if not shown:
        return Result(text=f"Nothing in the drawer matches {q!r} ({len(rows)} parts in it). "
                           "Try lcsc_search to find it on LCSC.",
                      say="Nothing in the drawer for “{query}”", vars={"query": q}, summary="no match")
    lines = [f"{h['lcsc']}  {h['mpn'] or '?'}  {h['maker'] or ''}  {h['package'] or ''}  [{h['drawer']}]"
             f"  datasheet {'kept' if h['datasheet_kept'] else 'not fetched yet'}"
             + (f"\n    {h['description']}" if h["description"] else "")
             + (f"\n    {_boards(h['boards'])}" if h["boards"] is not None else "") for h in shown]
    more = f"\n... and {len(hits) - LIMIT} more" if len(hits) > LIMIT else ""
    text = f"In the drawer, matching {q!r}:\n" + "\n".join(lines) + more
    summary = "\n".join(f"{h['lcsc']} {h['mpn'] or ''}" for h in shown) + more
    if len(hits) == 1:
        h = hits[0]
        return Result(text=text, say="Found {mpn} in the drawer ({lcsc})",
                      vars={"mpn": h["mpn"] or h["lcsc"], "lcsc": h["lcsc"], "query": q}, summary=summary)
    return Result(text=text, say="Found {n} parts in the drawer for “{query}”",
                  vars={"n": len(hits), "query": q}, summary=summary)


TOOL = Tool(
    name="drawer_search", package="pcb", level="read", order=10,
    about="Finds parts already in the drawer by MPN, LCSC number or words.",
    label="Search the drawer",
    description="Find parts already kept in this workspace's parts drawer, by manufacturer part number "
                "(MPN), LCSC number (C...) or words from the description. Says for each whether its "
                "datasheet is already kept and which boards use it (with their references).",
    schema={"type": "object", "properties": {
        "query": {"type": "string", "description": "An MPN like IRL540N, an LCSC number like C111607, or words"}},
        "required": ["query"]},
    running="Looking in the drawer for “{query}”", failed="Could not search the drawer",
    run=run)
