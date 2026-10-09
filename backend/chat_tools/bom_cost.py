"""bom_cost: what a board's parts cost at a number of boards, line by line,
with the stock of each, the lines out of stock or short and the ones with
no LCSC number - the BOM Cost view's figures (backend/bom_cost.py), read
from the offers on disk; nothing is asked of LCSC."""

from __future__ import annotations

from .. import ato, bom_cost
from . import Ctx, Result, Tool, ToolError, clip
from ._things import find

MAX_LINES = 120                     # BOM lines written out


def _money(x) -> str:
    return "-" if x is None else f"${x:,.4f}".rstrip("0").rstrip(".") if x < 1 else f"${x:,.2f}"


async def run(ctx: Ctx, args: dict) -> Result:
    ref = str(args.get("board") or "").strip()
    if not ref:
        raise ToolError("say which board (board_read without a board lists them)")
    try:
        qty = int(10 if args.get("qty") in (None, "") else args["qty"])
    except (TypeError, ValueError):
        raise ToolError("qty is a number of boards, like 100")
    if not 1 <= qty <= 1_000_000:
        raise ToolError("qty: 1 to 1000000 boards")
    doc = await find(ctx.db, ato.BOARDS, ref, ("title", "folder"), "board")
    bid = doc["_id"]
    try:
        lines = await bom_cost.board_lines(ctx.db, bid)
    except KeyError:
        raise ToolError(f"no board {bid!r}")
    if not lines:
        return Result(text=f"Board {bid} has no parts yet (no netlist and no BOM).",
                      say="Board {board} has no parts yet", vars={"board": bid, "qty": qty}, summary="no parts")
    offers = {l["lcsc"]: bom_cost.cached_offer(l["lcsc"]) for l in lines if l["lcsc"]}
    c = bom_cost.cost(lines, offers, qty)
    st = c["stock"]
    out = [f"BOM cost of board {bid} for {qty} boards (US dollars, LCSC price breaks, from offers kept on disk"
           + (f"; the oldest checked {c['oldest_at']}" if c.get("oldest_at") else "")
           + (f"; {c['stale']} line(s) older than a day - the BOM Cost tab's refresh asks LCSC again" if c["stale"] else "")
           + "):",
           f"Per board {_money(c['per_board_usd'])}; order of {qty} boards {_money(c['total_usd'])}"
           f" ({_money(c['min_order_usd'])} with LCSC's minimum quantities); {c['parts']} parts a board, "
           f"{c['distinct']} distinct, {c['priced']} priced.",
           f"JLCPCB Extended parts: {c['extended']} (about {_money(c['extended_fee_usd'])} loading fees an order).",
           "At other quantities: " + "; ".join(f"{q['qty']}: {_money(q['per_board_usd'])}/board, "
                                              f"{_money(q['total_usd'])} total" for q in c["quantities"]),
           f"Stock at {qty} boards: {st['ok']} ok, {st['low']} low, {st['short']} short, {st['out']} out, "
           f"{st['unsure']} unsure, {st['unknown']} unknown, {st['no_part']} without an LCSC number."]
    if c["problems"]:
        out.append("OUT OF STOCK OR SHORT: " + "; ".join(
            f"{','.join(p['refs'])} {p['lcsc']} ({p['state']}: stock {p['stock']}, need {p['need']}"
            + (", alternatives known" if p["has_alternatives"] else "") + ")" for p in c["problems"]))
    missing = [r for r in c["lines"] if not r["lcsc"]]
    if missing:
        out.append("NO LCSC NUMBER: " + "; ".join(f"{','.join(r['refs'])} {r.get('value') or ''}".strip()
                                                  for r in missing))
    unpriced = [r for r in c["lines"] if r["lcsc"] and r["unit_usd"] is None]
    if unpriced:
        out.append("NO PRICE KNOWN: " + "; ".join(f"{','.join(r['refs'])} {r['lcsc']}" for r in unpriced))
    out.append("Lines (refs | LCSC | MPN | value | qty/board | unit price at this order | line per board | "
               "stock | state):")
    for r in c["lines"][:MAX_LINES]:
        refs = ",".join(r["refs"])
        out.append(f"{refs if len(refs) <= 40 else refs[:37] + '...'} | {r['lcsc'] or '-'} | {r.get('mpn') or '-'} | "
                   f"{r.get('value') or '-'} | {r['qty']} | {_money(r['unit_usd'])} | {_money(r['line_usd'])} | "
                   f"{r['stock'] if r['stock'] is not None else '?'} | {r['state']}"
                   + (f" ({', '.join(r['flags'])})" if r["flags"] else ""))
    if len(c["lines"]) > MAX_LINES:
        out.append(f"... and {len(c['lines']) - MAX_LINES} more lines")
    v = {"board": bid, "qty": qty, "per_board": _money(c["per_board_usd"]), "total": _money(c["total_usd"]),
         "out": st["out"] + st["short"], "missing": st["no_part"]}
    summary = (f"{qty} boards: {_money(c['per_board_usd'])}/board, {_money(c['total_usd'])} total · "
               f"{st['out'] + st['short']} out/short · {st['no_part']} without LCSC")
    return Result(text=clip("\n".join(out)), say="BOM cost of {board} for {qty} boards: {total}", vars=v,
                  summary=summary)


TOOL = Tool(
    name="bom_cost", level="read", order=64,
    label="BOM cost",
    about="Prices a board's BOM at a quantity, with stock and the lines that cannot be bought.",
    description="What one board's parts cost at LCSC for `qty` boards (default 10): per board and for the "
                "order, at the price break that order takes, also at 1/10/50/100/500/1000 boards; each "
                "line's unit price, stock and state; the lines out of stock or short, the ones with no "
                "LCSC number and the ones with no known price; JLCPCB Extended parts. Read from the "
                "prices kept on the server (it says how old they are). Name the board by id or title words.",
    schema={"type": "object", "properties": {
        "board": {"type": "string", "description": "The board's id, like demoboard-gerber-zip"},
        "qty": {"type": "integer", "minimum": 1, "description": "How many boards (default 10)"}},
        "required": ["board"]},
    running="Pricing the BOM", failed="Could not price the BOM",
    run=run)
