"""taste_read: the workspace's taste palettes (backend/taste.py) - the
person's design rules, MUST / PREFER / AVOID by domain - listed, or one of
them read whole, as an @-mention of it gives it (backend/cc_context.py)."""

from __future__ import annotations

from .. import taste
from . import Ctx, Result, Tool, clip
from ._things import find


def _counts(d: dict) -> str:
    items = d.get("items") or []
    doms = ", ".join(f"{taste.DOMAIN_NAMES[k]} {n}" for k, n in taste.counts(items).items() if n)
    strs = ", ".join(f"{n} {k}" for k in taste.STRENGTHS
                     if (n := sum(1 for i in items if (i.get("strength") or "prefer") == k)))
    return f"{len(items)} items" + (f" ({doms}; {strs})" if doms else "")


def _attached(d: dict) -> str:
    on = [f"{a.get('kind')} {a.get('id')}" for a in d.get("attached") or []]
    return "attached to " + ", ".join(on) if on else "not attached"


async def _listing(ctx: Ctx, q: str) -> Result:
    found = await taste.listing(ctx.db, q)
    if not found:
        none = f"No taste palette here matches \"{q}\"." if q else "There are no taste palettes in this workspace."
        return Result(text=none, say="No taste palettes here", summary="none")
    lines = [f"{d['_id']}  \"{d.get('name') or d['_id']}\"" + ("  (pinned)" if d.get("pinned") else "")
             + f"  {_counts(d)}  {_attached(d)}"
             + (f"\n    {d['description']}" if d.get("description") else "")
             for d in found]
    text = (f"{len(found)} taste palette(s) in this workspace. Read one with taste_read and its id:\n"
            + "\n".join(lines))
    return Result(text=clip(text), say="Listed {n} taste palettes", vars={"n": len(found)},
                  summary="\n".join(f"{d.get('name') or d['_id']} · {_counts(d)}" for d in found[:20]))


async def run(ctx: Ctx, args: dict) -> Result:
    ref = str(args.get("palette") or "").strip()
    if not ref:
        return await _listing(ctx, str(args.get("query") or "").strip())
    d = await find(ctx.db, taste.COLL, ref, ("name", "description"), "taste palette")
    text = (taste.block(d) + f"\n\nIt is {_attached(d)}. Follow MUST items; follow PREFER items unless told "
            "otherwise; never do AVOID items.")
    return Result(text=clip(text), say="Read taste palette {name}", vars={"name": d.get("name") or d["_id"]},
                  summary=f"{_counts(d)} · {_attached(d)}")


TOOL = Tool(
    name="taste_read", package="taste", level="read", order=68,
    label="Read a taste palette",
    about="Lists the taste palettes, or reads one: its MUST, PREFER and AVOID rules by domain.",
    description="Read this workspace's taste palettes: the person's own design rules, each MUST, PREFER or "
                "AVOID, grouped by domain (mechanical, PCB, firmware, general), with why, and the projects "
                "a palette is attached to. Without `palette` it lists them (optionally only those matching "
                "`query`). Use it when asked about their taste, their rules or their palettes, and before "
                "advising on a design they have a palette for. A palette may be named by its id or by words "
                "of its name.",
    schema={"type": "object", "properties": {
        "palette": {"type": "string", "description": "The palette's id or name; leave out to list"},
        "query": {"type": "string", "description": "When listing: only palettes holding these words"}}},
    running="Reading the taste palettes", failed="Could not read the taste palettes",
    run=run)
