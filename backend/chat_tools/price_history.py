"""price_history: a Parts product's price and stock as they were read -
the readings behind the product box's "Price and stock, as read" chart
(backend/manufacturers.py `remember`: a new row when the price or the
stock changed, else the last row seen again; the last HISTORY rows) -
with a one-line trend: the lowest, the highest, the last and the change
from the first reading to the last.

The product is named as the other product tools take it (_product.py):
its maker:product ids, or words of its name or code across every source;
with the right the Parts page's GET needs, in the asker's workspace."""

from __future__ import annotations

from .. import app_links
from .. import manufacturers as mf
from . import Ctx, Result, Tool, clip
from ._product import ids, resolve
from ._rights import need

SPARK = 10                           # readings the step's card draws (the product keeps mf.HISTORY)


def _num(x: float) -> str:
    return f"{x:,.2f}" if abs(x) < 1000 else f"{x:,.0f}"


def _stock(h: dict) -> str:
    if h.get("stock") == "in":
        return "in stock" + (f" ({h['qty']})" if h.get("qty") is not None else "")
    if h.get("stock") == "out":
        return "out of stock"
    return "-"


def trend(rows: list[dict]) -> dict:
    """{min, max, last, first, change (%), currency, n} of the priced rows in
    the last row's currency - a reading in another currency is not
    compared with it."""
    cur = next((h.get("currency") or "" for h in reversed(rows) if h.get("amount") is not None), "")
    xs = [float(h["amount"]) for h in rows if h.get("amount") is not None and (h.get("currency") or "") == cur]
    if not xs:
        return {"n": 0, "currency": cur}
    change = (xs[-1] - xs[0]) / xs[0] * 100 if xs[0] else None
    return {"n": len(xs), "currency": cur, "min": min(xs), "max": max(xs), "first": xs[0], "last": xs[-1],
            "change": None if change is None else round(change, 1)}


def spark(rows: list[dict], cur: str) -> str:
    """The last SPARK prices, each 0-99 between the lowest and the highest,
    for the card's line (a step's vars are short strings)."""
    xs = [float(h["amount"]) for h in rows if h.get("amount") is not None and (h.get("currency") or "") == cur][-SPARK:]
    if len(xs) < 2:
        return ""
    lo, hi = min(xs), max(xs)
    return " ".join(str(round(99 * (x - lo) / (hi - lo)) if hi > lo else 50) for x in xs)


async def run(ctx: Ctx, args: dict) -> Result:
    need("GET", "/api/manufacturers/products")
    m, p = await resolve(ctx, args.get("product") or "", args.get("manufacturer") or "")
    name = p.get("name") or p.get("id")
    rows = mf._history(p.get("history"))
    link = f"{app_links.parts(m['_id'])}/{app_links.seg(str(p['id']))}"
    where = (p.get("seller") or {}).get("domain") or m.get("domain") or m.get("name") or m["_id"]
    src = (p.get("price") or {}).get("source") or ""
    head = f"{name} ({ids(m, p)}) from {m.get('name') or m['_id']}" + (f", read from {p['url']}" if p.get("url") else "")
    vars_ = {"name": name, "m": m["_id"], "pid": str(p["id"]), "link": link, "n": len(rows)}
    if not rows:
        now = mf.cf.price_label(p["price"]) if (p.get("price") or {}).get("amount") is not None else "no price"
        text = (f"{head}.\nNo price or stock readings are kept for it: its page was never read with a price or a stock"
                f" (now: {now}; {_stock({'stock': p.get('stock'), 'qty': p.get('stock_qty')})}). Open it: {link}")
        return Result(text=text, say="No price readings for {name}", vars=vars_, summary="no readings")
    t = trend(rows)
    lines = ["date (UTC) | price | currency | VAT | stock | last seen the same"]
    for h in rows:
        price = _num(float(h["amount"])) if h.get("amount") is not None else "-"
        vat = {"incl": "incl.", "excl": "excl."}.get(h.get("vat") or "", "-")
        lines.append(f"{h['at'][:16].replace('T', ' ')} | {price} | {h.get('currency') or '-'} | {vat} | {_stock(h)} | "
                     + (h["seen"][:16].replace("T", " ") if h.get("seen") else "-"))
    if t["n"]:
        ch = "" if t.get("change") is None else f", {'+' if t['change'] >= 0 else ''}{t['change']}% from the first reading"
        line = (f"Trend ({t['n']} priced readings, {t['currency'] or 'no currency'}): lowest {_num(t['min'])}, highest "
                f"{_num(t['max'])}, last {_num(t['last'])}{ch}.")
        vars_.update(last=_num(t["last"]), cur=t["currency"], low=_num(t["min"]), high=_num(t["max"]),
                     change="" if t.get("change") is None else f"{'+' if t['change'] >= 0 else ''}{t['change']}%",
                     spark=spark(rows, t["currency"]))
    else:
        line = "No reading has a price - only the stock was read."
    text = "\n".join([f"{head}.", f"Price and stock as read, oldest first (source: {where}"
                      + (f", price read from the page's {src}" if src else "") + "; a row is kept when the price or "
                      "the stock changed, at most the last " + str(mf.HISTORY) + "):", *lines, line,
                      f"Open it in Parts: {link}"])
    summary = line if t["n"] else f"{len(rows)} readings, stock only"
    return Result(text=clip(text, 6_000), say="Price history of {name}", vars=vars_, summary=summary)


TOOL = Tool(
    name="price_history", package="mfr", level="read", order=77,
    label="Price history",
    about="Reads a Parts product's price and stock as they were read, with the trend.",
    description="A Parts product's price and stock readings over time - the very rows the product box's "
                "\"Price and stock, as read\" chart draws: each date with the price, currency, VAT, the stock the "
                "seller's site said and when the same was last seen - and a one-line trend (lowest, highest, last, "
                "change % from the first reading). Name the product by its ids (maker:product, from product_find or "
                "manufacturer_search) or by words of its name or code; several match: ask which one. Only what Parts "
                "kept is read: nothing is fetched.",
    schema={"type": "object", "properties": {
        "product": {"type": "string", "description": "maker:product ids, or words of its name or code"},
        "manufacturer": {"type": "string", "description": "Its maker or source, when the product is named apart"}},
        "required": ["product"]},
    running="Reading the price history of {product}", failed="Could not read the price history",
    run=run)
