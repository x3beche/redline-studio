"""shopping_list: what is short for a number of builds of a board or a 3D
assembly (build_count's shortfall) - or a list given - as a purchase list
across the sellers Parts knows: the LCSC drawer's price breaks and least
quantities, the sites' products' prices, McMaster-Carr's snippet prices;
cheapest first per line in the display currency, with the alternatives,
and the totals per seller (chat_tools/_build.py). Optionally kept in Files
> Documents as CSV, Markdown or a PDF (pdf_make)."""

from __future__ import annotations

import csv
import io

from .. import actors, files
from .. import inventory as inv
from . import Ctx, Result, Tool, ToolError, clip, size
from . import _build as b
from ._rights import need

FOLDER = "Chat/Documents"            # the Chat's own (Files > In the app > Chat); copied to My files on asking
ALTS = 3                            # alternatives written per line


def _rows(lines: list[dict]) -> list[dict]:
    """One row per line: its pick (the cheapest) and the rest."""
    return [{"line": ln, "pick": (ln["offers"] or [None])[0], "alts": ln["offers"][1:1 + ALTS]} for ln in lines]


def markdown(rows: list[dict], sellers: dict, cur: str, unpriced: int, rates_at: str) -> str:
    out = [f"Cheapest seller per line, in {cur}" + (f" (exchange rates of {rates_at})" if rates_at else "") + ".", "",
           f"| Part | Short | Buy | Seller | Code | Unit ({cur}) | Line ({cur}) | Note |",
           "|---|---:|---:|---|---|---:|---:|---|"]
    for r in rows:
        ln, p = r["line"], r["pick"]
        if not p:
            out.append(f"| {ln['label']} | {ln['short']} | - | no seller known | {ln['lcsc'] or ln['mpn'] or '-'} | - | - | |")
            continue
        code = f"[{p['code']}]({p['url']})" if p["url"] else p["code"]
        alt = "; ".join(f"{a['seller']} {b.money(a['total'], cur)}" for a in r["alts"] if a["total"] is not None)
        note = ", ".join(x for x in (p["note"], f"else {alt}" if alt else "") if x)
        out.append(f"| {ln['label']} | {ln['short']} | {p['buy']} | {p['seller']} | {code} | "
                   f"{b.money(p['unit'], '').strip()} | {b.money(p['total'], '').strip()} | {note} |")
    out += ["", "| Seller | Lines | Total |", "|---|---:|---:|"]
    out += [f"| {s} | {v['lines']} | {b.money(v['total'], cur)} |" for s, v in sellers.items()]
    out.append(f"| **All** | {sum(v['lines'] for v in sellers.values())} | "
               f"**{b.money(sum(v['total'] for v in sellers.values()), cur)}** |")
    if unpriced:
        out += ["", f"{unpriced} line(s) have no price known: not in the totals."]
    return "\n".join(out)


def to_csv(rows: list[dict], cur: str) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["part", "lcsc", "mpn", "short", "buy", "seller", "code", "url", f"unit_{cur}", f"line_{cur}",
                "source_price", "note"])
    for r in rows:
        ln, p = r["line"], r["pick"] or {}
        w.writerow([ln["label"], ln["lcsc"], ln["mpn"], ln["short"], p.get("buy", ""), p.get("seller", ""),
                    p.get("code", ""), p.get("url", ""),
                    "" if p.get("unit") is None else f"{p['unit']:.6g}",
                    "" if p.get("total") is None else f"{p['total']:.2f}", p.get("src", ""), p.get("note", "")])
    return buf.getvalue()


async def _keep(ctx: Ctx, name: str, data: bytes, mime: str) -> dict:
    need("POST", "/api/files")
    by = ctx.actor or actors.current() or {}
    folder = await files.make_path(ctx.db, FOLDER, by)
    stem, ext = name.rsplit(".", 1)
    cand, n = name, 1
    while await ctx.db[files.COLL].find_one({"folder": folder["_id"], "name": cand}, {"_id": 1}) and n < 200:
        n += 1
        cand = f"{stem} ({n}).{ext}"
    context = {"room": "commandcode", **({"chat": ctx.chat} if ctx.chat else {})}
    return await files.put(ctx.db, cand, data, mime, context, by, note="Shopping list", folder=folder["_id"])


async def run(ctx: Ctx, args: dict) -> Result:
    export = str(args.get("export") or "").strip().lower()
    if export not in ("", "csv", "md", "markdown", "pdf"):
        raise ToolError("export is csv, md or pdf")
    if args.get("items") and not (args.get("board") or args.get("model")):
        what = "the list"
        lines = [{**n, "short": int(-(-n["qty"] // 1))} for n in b.given_needs(args["items"])]
    else:
        try:
            builds = int(args.get("builds") or 1)
        except (TypeError, ValueError):
            raise ToolError("builds is a number, like 10")
        if not 1 <= builds <= 100_000:
            raise ToolError("builds: 1 to 100000")
        _, what, needs, _ = await b.needs_of(ctx.db, args)
        have = b.on_hand(needs, await inv.everything(ctx.db))
        lines = b.short(have, builds)
        what = f"{what} x{builds}"
        if not lines:
            return Result(text=f"Nothing is short for {what}: the stock on hand covers it.",
                          say="Nothing to buy for {what}", vars={"what": what, "n": 0}, summary="nothing short")
    cur = await b.display_currency(ctx.db)
    makers = await b.every(ctx.db)
    for ln in lines:
        ln["offers"] = b.offers(ln, makers, cur)
    rows = _rows(lines)
    sellers: dict[str, dict] = {}
    unpriced = 0
    for r in rows:
        p = r["pick"]
        if not p or p["total"] is None:
            unpriced += 1
            continue
        s = sellers.setdefault(p["seller"], {"lines": 0, "total": 0.0})
        s["lines"] += 1
        s["total"] += p["total"]
    total = sum(v["total"] for v in sellers.values())
    from .. import fx
    rates_at = str(fx.public().get("date") or "") if cur != "USD" else ""
    md = markdown(rows, sellers, cur, unpriced, rates_at)
    out = [f"Shopping list for {what}: {len(rows)} line(s), {b.money(total, cur)} in all"
           + (f", {unpriced} without a price" if unpriced else "") + ".", md]
    more = [r for r in rows if len(r["line"]["offers"]) > 1]
    if more:
        out.append("Every seller found per line (cheapest first): " + " / ".join(
            f"{r['line']['label']}: " + ", ".join(
                f"{o['seller']} {b.money(o['total'], cur)}" + (f" ({o['src']})" if o["src"] else "")
                for o in r["line"]["offers"][:6]) for r in more[:30]))
    v = {"what": what, "n": len(rows), "total": b.money(total, cur), "sellers": len(sellers)}
    title = f"Shopping list - {what}"
    if export in ("csv", "md", "markdown"):
        ext = "csv" if export == "csv" else "md"
        data = (to_csv(rows, cur) if ext == "csv" else f"# {title}\n\n{md}\n").encode()
        try:
            d = await _keep(ctx, f"{title.replace('/', '-')[:110]}.{ext}", data,
                            "text/csv" if ext == "csv" else "text/markdown")
        except ValueError as exc:
            raise ToolError(str(exc)) from exc
        out.append(f"Kept as {d['name']} in Files > {FOLDER} ({size(len(data))}): link it as "
                   f"[{d['name']}](/api/files/{d['_id']}).")
        v.update({"file": d["_id"], "name": d["name"]})
    elif export == "pdf":
        from . import pdf_make
        got = await pdf_make.run(ctx, {"title": title, "purpose": f"What to buy for {what}, cheapest seller per line",
                                       "body": f"**{len(rows)} lines, {b.money(total, cur)} in all.**\n\n{md}",
                                       "filename": title.replace("/", "-")})
        out.append(got.text)
        v.update({"file": got.vars["file"], "name": got.vars["name"]})
    return Result(text=clip("\n\n".join(out)), say="Shopping list for {what}: {total}", vars=v,
                  summary=f"{len(rows)} lines · {b.money(total, cur)} · {len(sellers)} seller(s)"
                          + (f" · {unpriced} unpriced" if unpriced else ""))


TOOL = Tool(
    name="shopping_list", package="mfr", level="change", order=87, default=True,
    label="Shopping list",
    about="Turns what is short for a number of builds into a purchase list, cheapest seller per line.",
    description="A purchase list for what is short to build `builds` of a board or a 3D assembly (build_count's "
                "shortfall), or for a list given (`items`, each qty to buy): per line the cheapest seller Parts "
                "knows - the LCSC drawer's price breaks and least quantities (a larger break is taken when it "
                "costs less), the saved sites' products' prices, McMaster-Carr's snippet prices - in the "
                "workspace's display currency at today's exchange rates, with the alternatives, and the totals "
                "per seller. Prices are the ones kept, not asked again. `export` csv, md or pdf keeps it in "
                "Files > Documents; link the file it returns. Writes nothing else.",
    schema={"type": "object", "properties": {
        "board": {"type": "string", "description": "The board's id or title words"},
        "model": {"type": "string", "description": "A 3D assembly's id or title words"},
        "builds": {"type": "integer", "minimum": 1, "description": "How many builds (default 1)"},
        "items": {"type": "array", "description": "Or a list of what to buy",
                  "items": {"type": "object", "properties": {
                      "name": {"type": "string"}, "qty": {"type": "number"}, "lcsc": {"type": "string"},
                      "mpn": {"type": "string"}, "product": {"type": "string", "description": "maker:product ids"}}}},
        "export": {"type": "string", "enum": ["", "csv", "md", "pdf"],
                   "description": "Keep it as a file too (only when asked)"}}},
    running="Making a shopping list", failed="Could not make the shopping list",
    run=run)
