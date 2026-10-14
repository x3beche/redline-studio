"""stock_low: the Stock tab's low lines (backend/inventory.py `is_low`: at
or below their minimum, the tab's "Low" filter) - or, with `threshold`,
also the lines at or below that many - each with how many to reorder,
grouped by who sells them (the line's Parts product's maker or source).

A reorder quantity is worked out only from what the line keeps: its
minimum, and what its log says was used (the "adjusted" lines that took
some out, over USE_DAYS). With neither, the line says what is missing
instead of a guessed number.

`add` puts them on a shopping list - shopping_list's own path
(chat_tools/shopping_list.py): priced across the sellers Parts knows and
kept as a file in Files > In the app > Chat/Documents - and asks first."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from .. import inventory as inv
from . import Ctx, Result, Tool, ToolError, clip
from ._rights import need

USE_DAYS = 90                        # how far back the log is read for what was used
SHOW = 80                            # lines the answer names
NO_SELLER = "no seller known"


def used(d: dict, now: datetime | None = None) -> tuple[float, int] | None:
    """(taken out over the last USE_DAYS, days the log covers of them) -
    None when the log took nothing out in that time."""
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=USE_DAYS)
    took, first = 0.0, None
    for ln in d.get("log") or []:
        try:
            at = datetime.fromisoformat(str(ln.get("at")).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            continue
        at = at if at.tzinfo else at.replace(tzinfo=timezone.utc)
        if at < since:
            continue
        first = at if first is None or at < first else first
        if ln.get("kind") == "adjusted" and isinstance(ln.get("delta"), (int, float)) and ln["delta"] < 0:
            took += -float(ln["delta"])
    if not took or first is None:
        return None
    return took, max(7, min(USE_DAYS, (now - first).days or 1))


def suggest(d: dict, now: datetime | None = None) -> dict:
    """{qty, why} - or {missing} when nothing kept says how many."""
    have = float(d.get("quantity") or 0)
    lo = d.get("min_stock")
    lo = float(lo) if lo is not None else None
    use = used(d, now)
    month = None if use is None else use[0] * 30 / use[1]
    if month and lo:
        target, why = max(2 * lo, lo + month), f"up to {inv.qty(max(2 * lo, lo + month))}: the minimum {inv.qty(lo)} " \
                                               f"plus a month's use (~{inv.qty(round(month, 1))})"
    elif month:
        target, why = month, f"a month's use (~{inv.qty(round(month, 1))}, from the last {use[1]} days of its log)"
    elif lo:
        target, why = 2 * lo, f"up to twice the minimum ({inv.qty(lo)}); no use is logged to go by"
    else:
        return {"missing": ("a minimum (inventory_edit sets min_stock)" if lo is None else "a minimum above 0")
                           + f" or use in its log (nothing was taken out in the last {USE_DAYS} days)"}
    q = max(1, math.ceil(target - have))
    return {"qty": q, "why": why}


def seller_of(d: dict) -> str:
    c = d.get("catalog") or {}
    return str(c.get("manufacturer_name") or d.get("manufacturer") or NO_SELLER)


async def run(ctx: Ctx, args: dict) -> Result:
    need("GET", "/api/inventory")
    th = args.get("threshold")
    try:
        th = None if th in (None, "") else float(th)
    except (TypeError, ValueError):
        raise ToolError("threshold is a number: lines at or below it count as low too")
    if th is not None and th < 0:
        raise ToolError("threshold cannot be below zero")
    rows = [d for d in await inv.listing(ctx.db)
            if inv.is_low(d) or (th is not None and float(d.get("quantity") or 0) <= th)]
    what = "low" + (f" or at most {inv.qty(th)}" if th is not None else "")
    if not rows:
        return Result(text=f"No stock line is {what}." + ("" if th is not None else
                      " A line is low at or below its minimum; lines without a minimum never are."),
                      say="Nothing is low in stock", vars={"n": 0, "sellers": 0}, summary="none low")
    now = datetime.now(timezone.utc)
    groups: dict[str, list[tuple[dict, dict]]] = {}
    for d in rows:
        groups.setdefault(seller_of(d), []).append((d, suggest(d, now)))
    order = sorted(groups, key=lambda s: (s == NO_SELLER, s.lower()))
    out, items, missing = [], [], 0
    shown = 0
    for s in order:
        out.append(f"{s}:")
        for d, sg in groups[s]:
            unit = d.get("unit") or "pcs"
            lo = d.get("min_stock")
            c = d.get("catalog") or {}
            head = (f"  {d['_id']}  {d.get('name')}: {inv.qty(d.get('quantity'))} {unit} on hand"
                    + (f", minimum {inv.qty(lo)}" if lo is not None else "") + (f", at {d['location']}" if d.get("location") else ""))
            if sg.get("qty"):
                tail = f" -> reorder {inv.qty(sg['qty'])} {unit} ({sg['why']})"
                prod = f"{c['manufacturer']}:{c['product']}" if c.get("manufacturer") and c.get("product") else ""
                items.append({"name": d.get("name") or "", "qty": sg["qty"], "lcsc": d.get("lcsc") or "",
                              "mpn": d.get("mpn") or "", **({"product": prod} if prod else {})})
            else:
                tail = f" -> no reorder quantity: missing {sg['missing']}"
                missing += 1
            if shown < SHOW:
                out.append(head + tail)
            shown += 1
    if shown > SHOW:
        out.append(f"... and {shown - SHOW} more lines.")
    head = (f"{len(rows)} stock line(s) {what}, by seller ({len(order)}): {len(items)} with a reorder quantity"
            + (f", {missing} without (what is missing is said)" if missing else "") + ".")
    v = {"n": len(rows), "sellers": len(order), "reorder": len(items), "missing": missing}
    say = "{n} low in stock, {sellers} sellers"
    text = "\n".join([head, *out])
    if args.get("add"):
        if not items:
            raise ToolError("none of the low lines has a reorder quantity to put on a shopping list - " + head)
        export = str(args.get("export") or "md").strip().lower()
        from . import shopping_list
        got = await shopping_list.run(ctx, {"items": items, "export": export if export in ("csv", "md", "pdf") else "md"})
        text += "\n\nPut on a shopping list:\n" + got.text
        v.update({k: got.vars[k] for k in ("file", "name", "total") if k in got.vars})
        say = "{n} low in stock; shopping list {total}"
    else:
        text += ("\n\nAsk before putting them on a shopping list (call again with add): it is priced across the "
                 "sellers Parts knows and kept as a file in Files.") if items else ""
    return Result(text=clip(text, 12_000), say=say, vars=v,
                  summary=f"{len(rows)} low · {len(order)} seller(s) · {len(items)} to reorder"
                          + (f" · {missing} missing a rule" if missing else ""))


TOOL = Tool(
    name="stock_low", package="mfr", level="change", order=86,
    label="Low stock",
    about="Lists the Stock tab's low lines with reorder quantities, by seller; can put them on a shopping list.",
    description="The stock lines that are low - as the Stock tab's Low filter: at or below their minimum - or, with "
                "`threshold`, also those at or below that many; grouped by who sells them (the line's Parts "
                "product's maker or source), each with a reorder quantity worked out from its minimum and what its "
                "log says was used lately (a line with neither says what is missing instead of a number). Reading "
                "writes nothing. `add`: put the ones with a quantity on a shopping list (shopping_list's own: "
                "priced across the sellers Parts knows, kept as a file in Files) - only when the person asks; it "
                "asks them first.",
    schema={"type": "object", "properties": {
        "threshold": {"type": "number", "minimum": 0,
                      "description": "Also count lines at or below this many as low (e.g. 0 for what ran out)"},
        "add": {"type": "boolean", "description": "Put them on a shopping list (asks the person first)"},
        "export": {"type": "string", "enum": ["md", "csv", "pdf"],
                   "description": "With add: the shopping list's file (default md)"}}},
    running="Looking for low stock", failed="Could not read the low stock",
    asks=lambda args: bool((args or {}).get("add")),
    run=run)
