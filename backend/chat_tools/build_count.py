"""build_count: how many of a board or a 3D assembly the parts on hand
make - its BOM (or its bought parts) against the Parts page's stock lines
(chat_tools/_build.py) - which parts stop it, and what is missing for a
number of builds asked for. Nothing is written."""

from __future__ import annotations

from .. import inventory as inv
from . import Ctx, Result, Tool, ToolError, clip
from . import _build as b

MAX_LINES = 120


def _what(ln: dict) -> str:
    bits = [ln["label"]]
    if ln["lcsc"] and ln["lcsc"] not in ln["label"]:
        bits.append(ln["lcsc"])
    if ln["refs"] and not ln["refs"][0].count("/"):
        refs = ",".join(ln["refs"])
        bits.append(f"({refs if len(refs) <= 30 else refs[:27] + '...'})")
    return " ".join(bits)


async def run(ctx: Ctx, args: dict) -> Result:
    try:
        target = int(args.get("builds") or 0)
    except (TypeError, ValueError):
        raise ToolError("builds is a number of boards or assemblies, like 10")
    if not 0 <= target <= 100_000:
        raise ToolError("builds: 0 to 100000")
    kind, what, needs, notes = await b.needs_of(ctx.db, args)
    if not needs:
        why = ("has no parts yet (no netlist and no BOM)" if kind == "board"
               else "imports no bought parts - none of its models is a Parts product or in a purchased/ folder")
        return Result(text=f"{what} {why}." + ("\n" + "\n".join(notes) if notes else ""),
                      say="{what} has no parts to count", vars={"what": what}, summary=why)
    lines = b.on_hand(needs, await inv.everything(ctx.db))
    n = b.buildable(lines)
    limiting = [ln for ln in lines if ln["qty"] > 0 and int(ln["have"] // ln["qty"]) == n]
    out = [f"{what}: {n} build{'s' if n != 1 else ''} can be made from the stock on hand "
           f"({len(lines)} distinct part{'s' if len(lines) != 1 else ''} a build, "
           f"{sum(ln['qty'] for ln in lines):g} pieces)."]
    out.append("Limiting: " + "; ".join(f"{_what(ln)} - {inv.qty(ln['have'])} on hand, {ln['qty']:g} a build"
                                        for ln in limiting[:20]))
    want = target or n + 1
    gap = b.short(lines, want)
    if gap:
        out.append(f"Short for {want} build{'s' if want != 1 else ''} ({len(gap)} part{'s' if len(gap) != 1 else ''}; "
                   "shopping_list prices them):")
        out += [f"- {_what(ln)}: need {ln['want']:g}, have {inv.qty(ln['have'])}, short {ln['short']}"
                + ("" if ln["lines"] else " (none in stock)") for ln in gap[:MAX_LINES]]
    else:
        out.append(f"Nothing is short for {want} builds.")
    odd = [ln for ln in lines if ln["other_units"]]
    if odd:
        out.append("Kept in other units, not counted: " + "; ".join(
            f"{_what(ln)}: {', '.join(ln['other_units'])}" for ln in odd[:20]))
    out.append("Per part (need a build | on hand | stock lines):")
    out += [f"{_what(ln)} | {ln['qty']:g} | {inv.qty(ln['have'])} | "
            + (", ".join(r["_id"] for r in ln["lines"][:4]) or "-") for ln in lines[:MAX_LINES]]
    out += notes
    names = ", ".join(ln["label"] for ln in limiting[:3])
    return Result(text=clip("\n".join(out)), say="{what}: {n} can be built",
                  vars={"what": what, "n": n, "limit": names, "short": len(gap), "builds": want},
                  summary=f"{n} buildable · limited by {names or '-'} · {len(gap)} short for {want}")


TOOL = Tool(
    name="build_count", package="mfr", level="read", order=86, default=True,
    label="How many can I build?",
    about="Sets the BOM of a board or the bought parts of an assembly against the stock: how many builds, and what limits them.",
    description="How many of a board or a 3D assembly can be built from what is on hand (the Parts page's stock "
                "lines): the board's BOM lines (LCSC numbers, MPNs) or the assembly's bought parts (the models it "
                "imports that are Parts products or in a purchased/ folder) against the stock that counts the same "
                "product, LCSC number or MPN. Says the number of whole builds, the parts that limit it, and what is "
                "short for `builds` builds (default one more than can be built). `items` instead counts a list "
                "given in the conversation. Then shopping_list prices what is short.",
    schema={"type": "object", "properties": {
        "board": {"type": "string", "description": "The board's id or title words"},
        "model": {"type": "string", "description": "A 3D assembly's id or title words"},
        "items": {"type": "array", "description": "Or a list of parts for one build",
                  "items": {"type": "object", "properties": {
                      "name": {"type": "string"}, "qty": {"type": "number"}, "lcsc": {"type": "string"},
                      "mpn": {"type": "string"}, "product": {"type": "string", "description": "maker:product ids"}}}},
        "builds": {"type": "integer", "minimum": 0, "description": "How many builds the shortfall is for"}}},
    running="Counting what the stock builds", failed="Could not count the builds",
    run=run)
