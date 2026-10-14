"""stock_consume: the parts of a number of builds of a board or a 3D
assembly taken out of stock - each stock line that counts one of them
lowered, the largest first, with "used 4 for fan-board x2" in its log
(backend/inventory.py `adjust`, as inventory_adjust and the Parts page do).
All or nothing: when anything is short, nothing is taken and the shortfall
is said. Asks first: it changes many lines at once."""

from __future__ import annotations

from .. import inventory as inv
from . import Ctx, Result, Tool, ToolError, clip
from . import _build as b
from ._inventory import need


async def run(ctx: Ctx, args: dict) -> Result:
    try:
        builds = int(args.get("builds") or 0)
    except (TypeError, ValueError):
        raise ToolError("builds is a number, like 2")
    if not 1 <= builds <= 10_000:
        raise ToolError("say how many builds were made: `builds`, 1 to 10000")
    if not (args.get("board") or args.get("model")):
        raise ToolError("say which board or 3D model was built")
    _, what, needs, _ = await b.needs_of(ctx.db, {k: args.get(k) for k in ("board", "model")})
    if not needs:
        raise ToolError(f"{what} has no parts that stock counts")
    lines = b.on_hand(needs, await inv.everything(ctx.db))
    gap = b.short(lines, builds)
    if gap:
        raise ToolError(f"not enough on hand for {builds} build(s) of {what}, nothing was taken - short: " + "; ".join(
            f"{ln['label']} (need {ln['want']:g}, have {inv.qty(ln['have'])})" for ln in gap[:20]))
    reason = f"used {{n}} for {what} x{builds}" + (f" - {str(args['note']).strip()[:200]}" if args.get("note") else "")
    plan = []
    for ln in lines:
        left = ln["qty"] * builds
        for row in ln["lines"]:
            if left <= 0:
                break
            take = min(left, float(row.get("quantity") or 0))
            if take > 0:
                plan.append((row, take))
                left -= take
    for row, _ in plan:
        need("POST", f"/api/inventory/{row['_id']}/adjust")
    done = []
    for row, take in plan:
        try:
            got = await inv.adjust(ctx.db, row["_id"], -take, reason.format(n=inv.qty(take)), ctx.actor or None)
        except ValueError as exc:
            raise ToolError(f"{row.get('name')}: {exc} (taken before it: {len(done)} line(s))") from exc
        done.append((row, take, got))
    text = [f"Took the parts of {builds} build(s) of {what} out of stock: {len(done)} stock line(s)."]
    text += [f"- {row['_id']} \"{row.get('name')}\": -{inv.qty(take)}, now {inv.qty(got['quantity'])} "
             f"{got.get('unit') or 'pcs'}" + (" (LOW)" if inv.is_low(got) else "") for row, take, got in done]
    low = sum(1 for *_, got in done if inv.is_low(got))
    return Result(text=clip("\n".join(text)), say="Took {n} lines out of stock for {what}",
                  vars={"what": f"{what} x{builds}", "n": len(done), "low": low},
                  summary=f"{len(done)} lines lowered" + (f" · {low} now low" if low else ""))


TOOL = Tool(
    name="stock_consume", package="mfr", level="delete", order=88, default=True,
    label="Use stock for builds",
    about="Takes the parts of a number of builds out of stock, with the reason in the log of each line. Asks first.",
    description="When the person says they built some boards or assemblies, take their parts out of stock: every "
                "stock line that counts one of the BOM's (or the assembly's bought) parts is lowered by what "
                "`builds` builds take, the reason \"used N for <board> xB\" in its log. All or nothing - when "
                "anything is short nothing is taken (build_count shows it first). Asks the person before it runs.",
    schema={"type": "object", "properties": {
        "board": {"type": "string", "description": "The board's id or title words"},
        "model": {"type": "string", "description": "A 3D assembly's id or title words"},
        "builds": {"type": "integer", "minimum": 1, "description": "How many were built"},
        "note": {"type": "string", "description": "Added to the log's reason (an order, a customer)"}},
        "required": ["builds"]},
    running="Taking the parts out of stock", failed="Could not take the parts out of stock",
    run=run)
