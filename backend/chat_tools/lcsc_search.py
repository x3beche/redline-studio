"""lcsc_search: LCSC's catalogue, by MPN or words - candidates to choose from."""

from __future__ import annotations

from .. import lcsc
from . import Ctx, Result, Tool, ToolError
from ._parts import in_drawer, why

LIMIT = 8


async def run(ctx: Ctx, args: dict) -> Result:
    q = str(args.get("query") or "").strip()
    if not q:
        raise ToolError("say what to look for")
    try:
        rows = await lcsc.search(q, LIMIT)
    except (OSError, ValueError) as exc:
        raise ToolError(why(exc)) from exc
    have = {r["lcsc"] for r in rows if await in_drawer(ctx.db, r["lcsc"])}
    if not rows:
        return Result(text=f"LCSC has nothing for {q!r}.", say="Searched LCSC for “{query}” · nothing found",
                      vars={"query": q, "n": 0}, summary="no results")
    lines = []
    for r in rows:
        price = f"${r['price']:.4g}" if isinstance(r.get("price"), (int, float)) else "no price"
        lines.append(f"{r['lcsc']}  {r.get('mpn') or '?'}  {r.get('maker') or ''}  {r.get('package') or ''}"
                     f"  stock {r.get('stock') if r.get('stock') is not None else '?'}  {price}"
                     + ("  (in the drawer)" if r["lcsc"] in have else ""))
    text = f"LCSC, for {q!r}:\n" + "\n".join(lines)
    return Result(text=text, say="Searched LCSC for “{query}” · {n} results", vars={"query": q, "n": len(rows)},
                  summary="\n".join(lines))


TOOL = Tool(
    name="lcsc_search", level="read", order=20,
    about="Searches LCSC's catalogue: candidates with maker, package, stock and price.",
    label="Search LCSC",
    description="Search LCSC's catalogue for a part by MPN or words. Returns candidates with their LCSC "
                "number, manufacturer, package, stock and one-off price, and whether each is already in "
                "the drawer. Nothing is downloaded.",
    schema={"type": "object", "properties": {
        "query": {"type": "string", "description": "An MPN like IRL540N, or words like 'n-channel mosfet TO-220'"}},
        "required": ["query"]},
    running="Searching LCSC for “{query}”", failed="Could not search LCSC",
    run=run)
