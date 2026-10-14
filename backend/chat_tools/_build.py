"""What the build tools share (build_count, shopping_list, stock_consume):
what one build of a board or a 3D assembly takes, set against what is on
hand on the Parts page, and where the missing parts can be bought.

A board's parts are its BOM's lines (backend/bom_cost.py `board_lines`: the
netlist's parts with their LCSC numbers, else the BOM CSV), one line per
part number with how many a board takes. A 3D assembly's bought parts are
the models it imports, through its sub-assemblies, that are Parts products
- a product's 3D model put into a project (product_to_model, McMaster-Carr
or GrabCAD "to model") is named after its maker and product, and a model
in a purchased/ folder is bought by name. The designer's own parts are
made, not bought, and only said. A model's `uses` say which models it
imports, not how many times: each import counts once.

What is on hand is the stock lines (backend/inventory.py) that count the
same thing: the same Parts product, the same LCSC number, the same maker's
part number - or, for a thing known only by its name, the same name. Only
pieces are added up; a line in metres or reels is said, not counted.

Prices: the LCSC drawer's price breaks kept on disk (bom_cost.cached_offer,
nothing asked of LCSC) with the least it sells, the sites' products' own
prices in their currency, a McMaster-Carr part's price as its search
snippet said it ("$12.34 per pack of 100"); all turned into the workspace's
display currency (the Analytics costs' setting) at the app's exchange rates
(backend/fx.py). GrabCAD sells nothing."""

from __future__ import annotations

import math
import re

from .. import bom_cost, fx
from .. import inventory as inv
from . import ToolError
from ._product import every
from ._things import find

MAX_DEPTH = 8                       # sub-assemblies followed
MAX_MODELS = 300                    # models looked at under one assembly
PCS = ("pcs",)


def _key(s) -> str:
    return re.sub(r"[\s\-_./]+", "", inv.fold(s))


# ---- what one build takes -----------------------------------------------------

def need(label: str, qty: float, *, lcsc: str = "", mpn: str = "", product: tuple[str, str] | None = None,
         refs: list[str] | None = None) -> dict:
    return {"label": label or lcsc or mpn or "?", "qty": float(qty), "lcsc": (lcsc or "").upper(), "mpn": mpn or "",
            "product": product, "refs": refs or []}


async def board_needs(db, ref: str) -> tuple[dict, list[dict], list[str]]:
    """(board, its lines as needs, notes)."""
    from .. import ato
    doc = await find(db, ato.BOARDS, ref, ("title", "folder"), "board")
    try:
        lines = await bom_cost.board_lines(db, doc["_id"])
    except KeyError as exc:
        raise ToolError(f"no board {doc['_id']!r}") from exc
    out = []
    for ln in lines:
        mpn = ln.get("bom_mpn") or ""
        label = " ".join(dict.fromkeys(x for x in (ln.get("value"), mpn) if x)) or ln.get("lcsc") or ",".join(ln["refs"])
        out.append(need(label, ln["qty"], lcsc=ln.get("lcsc") or "", mpn=mpn, refs=ln["refs"]))
    return doc, out, []


def _purchased(mid: str) -> bool:
    return "purchased" in mid.split("/")


def product_of_title(title: str, makers: list[dict]) -> tuple[dict, dict] | None:
    """The Parts product a model was made from, by the name it was given:
    "<maker> <product>" (product_to_model), "<source> <key> ..." (a
    McMaster-Carr or GrabCAD part's "to model") or the product's own name."""
    t = inv.fold(title)
    if not t:
        return None
    for m in makers:
        mname = inv.fold(m.get("name") or m["_id"])
        for p in m.get("products") or []:
            pname = inv.fold(p.get("name"))
            if t == f"{mname} {pname}".strip() or (pname and t == pname):
                return m, p
            if m.get("builtin") and t.startswith(f"{mname} {inv.fold(p.get('id'))}"):
                return m, p
    return None


async def model_needs(db, ref: str) -> tuple[dict, list[dict], list[str]]:
    """(model, its bought parts as needs, notes) - through its sub-assemblies."""
    doc = await find(db, "models", ref, ("title", "name"), "3D model")
    makers = await every(db)
    count: dict[str, int] = {}
    seen: dict[str, dict] = {}
    todo = [(doc["_id"], 1, 0)]
    while todo and len(seen) < MAX_MODELS:
        mid, mult, depth = todo.pop()
        m = seen.get(mid) or await db["models"].find_one({"_id": mid}, {"uses": 1, "title": 1, "name": 1})
        if not m:
            continue
        seen[mid] = m
        if mid != doc["_id"]:
            count[mid] = count.get(mid, 0) + mult
            if product_of_title(m.get("title") or "", makers) or _purchased(mid):
                continue                                   # bought: what it imports is the seller's
        if depth >= MAX_DEPTH:
            continue
        for u in m.get("uses") or []:
            if u.get("kind") == "model" and u.get("id"):
                todo.append((u["id"], mult, depth + 1))
    needs, own, subs = [], [], []
    for mid, n in sorted(count.items()):
        m = seen[mid]
        title = m.get("title") or m.get("name") or mid
        hit = product_of_title(title, makers)
        if hit:
            mk, p = hit
            needs.append(need(p.get("name") or title, n, product=(mk["_id"], str(p["id"])),
                              lcsc=str(p["id"]) if mk["_id"] == "lcsc" else "",
                              mpn=str(p.get("sku") or "") if mk["_id"] != "lcsc" else "", refs=[mid]))
        elif _purchased(mid):
            needs.append(need(title, n, refs=[mid]))
        elif m.get("uses"):
            subs.append(mid)
        else:
            own.append(title)
    notes = []
    if own:
        notes.append(f"Taken as made, not bought - not a Parts product's model nor in a purchased/ folder, so not "
                     f"counted: {', '.join(own[:30])}" + (f" and {len(own) - 30} more" if len(own) > 30 else "")
                     + ". When some are bought, count them with `items`.")
    if subs:
        notes.append(f"Sub-assemblies followed: {', '.join(subs[:20])}")
    notes.append("An assembly says which models it imports, not how many times: each import counts once.")
    return doc, needs, notes


def given_needs(items) -> list[dict]:
    """A list the person or the model gives: [{name, qty, lcsc, mpn, product}]."""
    if not isinstance(items, list) or not items:
        raise ToolError("give `items`: a list of {name, qty, lcsc, mpn, product}")
    out = []
    for it in items[:300]:
        if not isinstance(it, dict):
            continue
        try:
            q = float(it.get("qty") if it.get("qty") not in (None, "") else 1)
        except (TypeError, ValueError):
            raise ToolError(f"qty of {it.get('name') or it} is not a number")
        prod = None
        if isinstance(it.get("product"), str) and ":" in it["product"]:
            a, b = it["product"].split(":", 1)
            prod = (a.strip(), b.strip())
        lc = str(it.get("lcsc") or "").strip().upper()
        if prod and prod[0] == "lcsc" and not lc:
            lc = prod[1].upper()
        out.append(need(str(it.get("name") or "").strip(), q, lcsc=lc, mpn=str(it.get("mpn") or "").strip(),
                        product=prod))
    if not out:
        raise ToolError("none of `items` reads as a part")
    return out


async def needs_of(db, args: dict) -> tuple[str, str, list[dict], list[str]]:
    """(kind, what, needs, notes) from `board`, `model` or `items`."""
    if args.get("board"):
        d, n, notes = await board_needs(db, str(args["board"]))
        return "board", d["_id"], n, notes
    if args.get("model"):
        d, n, notes = await model_needs(db, str(args["model"]))
        return "model", d["_id"], n, notes
    if args.get("items"):
        return "list", "the list", given_needs(args["items"]), []
    raise ToolError("say which board or 3D model (or give `items`): board_read and model_read list them")


# ---- what is on hand ------------------------------------------------------------

def counts(n: dict, row: dict) -> bool:
    """Whether a stock line counts what `n` needs."""
    link = inv.linked_to(row)
    if n["product"] and link == tuple(n["product"]):
        return True
    if n["lcsc"] and (_key(row.get("lcsc")) == _key(n["lcsc"]) or link == ("lcsc", n["lcsc"])):
        return True
    if n["mpn"] and len(_key(n["mpn"])) >= 3:
        cat = row.get("catalog") or {}
        if _key(n["mpn"]) in (_key(row.get("mpn")), _key(cat.get("sku"))):
            return True
    if not (n["product"] or n["lcsc"] or n["mpn"]):
        cat = row.get("catalog") or {}
        return inv.fold(n["label"]) in (inv.fold(row.get("name")), inv.fold(cat.get("product_name")))
    return False


def on_hand(needs: list[dict], rows: list[dict]) -> list[dict]:
    """Each need with what is on hand of it: have (pieces), lines, other units."""
    out = []
    for n in needs:
        mine = [r for r in rows if counts(n, r)]
        pcs = [r for r in mine if (r.get("unit") or "pcs") in PCS]
        other = [f"{inv.qty(r.get('quantity'))} {r.get('unit')}" for r in mine if r not in pcs]
        out.append({**n, "have": round(sum(float(r.get("quantity") or 0) for r in pcs), 6),
                    "lines": sorted(pcs, key=lambda r: -float(r.get("quantity") or 0)), "other_units": other})
    return out


def buildable(lines: list[dict]) -> int:
    """How many whole builds the stock makes."""
    per = [math.floor(ln["have"] / ln["qty"] + 1e-9) for ln in lines if ln["qty"] > 0]
    return min(per) if per else 0


def short(lines: list[dict], builds: int) -> list[dict]:
    """The lines short for `builds` builds, with how many are missing."""
    out = []
    for ln in lines:
        miss = math.ceil(ln["qty"] * builds - ln["have"] - 1e-9)
        if miss > 0:
            out.append({**ln, "short": miss, "want": ln["qty"] * builds})
    return out


# ---- what it costs --------------------------------------------------------------

async def display_currency(db) -> str:
    """The workspace's display currency (Analytics > costs), read only."""
    try:
        from .. import costs
        doc = await db.settings.find_one({"_id": costs._id()}, {"display_currency": 1}) or {}
        cur = str(doc.get("display_currency") or "USD").upper()
    except Exception:                                  # noqa: BLE001 - no setting: dollars
        cur = "USD"
    return cur if fx.known(cur) else "USD"


def convert(amount: float | None, cur: str, to: str) -> float | None:
    if amount is None:
        return None
    if (cur or "USD").upper() == to:
        return amount
    try:
        return fx.from_usd(fx.to_usd(amount, cur), to)
    except ValueError:
        return None


_MC = re.compile(r"\$\s?(\d{1,5}(?:,\d{3})*(?:\.\d+)?)(?:\s*(?:per|/)\s*(?:pack(?:\s+of\s+(\d+))?|each))?", re.I)


def mcmaster_price(text: str) -> tuple[float, int] | None:
    """"$12.34 per pack of 100" -> (12.34, 100); "$3.10 each" -> (3.10, 1)."""
    m = _MC.search(text or "")
    if not m:
        return None
    return float(m.group(1).replace(",", "")), int(m.group(2) or 1)


def _best_lcsc(breaks: list, want: int, moq: int) -> tuple[int, float, int] | None:
    """(pieces to buy, unit price, the break) cheapest in total for at least
    `want` pieces: a larger break can cost less than the pieces wanted."""
    if not breaks:
        return None
    start = max(want, moq, 1)
    best = None
    for q in [start, *[int(b[0]) for b in breaks if b[0] > start]]:
        unit, at = bom_cost.unit_price(breaks, q)
        if unit is None:
            continue
        if best is None or q * unit < best[0] * best[1] - 1e-12:
            best = (q, unit, at)
    return best


def offers(line: dict, makers: list[dict], cur: str) -> list[dict]:
    """Where `line["short"]` pieces can be bought, cheapest first in `cur`;
    the ones with no price known last."""
    want = int(line["short"])
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def add(seller, name, code, url, unit, src_cur, buy, moq, note="", stock=None, mid="", pid=""):
        u = convert(unit, src_cur, cur) if unit is not None else None
        out.append({"seller": seller, "name": name, "code": code, "url": url, "buy": buy, "moq": moq,
                    "unit": u, "total": None if u is None else u * buy, "note": note, "stock": stock,
                    "src": f"{unit:g} {src_cur}" if unit is not None else "", "m": mid, "pid": pid})
        seen.add((mid, pid))

    if line["lcsc"]:
        off = bom_cost.cached_offer(line["lcsc"]) or {}
        breaks = off.get("breaks") or []
        drawer = next((p for m in makers if m["_id"] == "lcsc" for p in m.get("products") or []
                       if str(p.get("id")) == line["lcsc"]), None)
        moq = max(int((((drawer or {}).get("part") or {}).get("min")) or 1), int(breaks[0][0]) if breaks else 1)
        best = _best_lcsc(breaks, want, moq)
        url = f"https://www.lcsc.com/product-detail/{line['lcsc']}.html"
        name = off.get("mpn") or (drawer or {}).get("name") or line["label"]
        if best:
            q, unit, at = best
            note = f"price break {at}+" + (f", buy {q} (cheaper than {max(want, moq)})" if q > max(want, moq) else "")
            add("LCSC", name, line["lcsc"], url, unit, "USD", q, moq, note, off.get("stock"), "lcsc", line["lcsc"])
        elif drawer and (drawer.get("price") or {}).get("amount") is not None:
            add("LCSC", name, line["lcsc"], url, float(drawer["price"]["amount"]), "USD", max(want, moq), moq,
                "drawer price, no price breaks kept", drawer.get("stock_qty"), "lcsc", line["lcsc"])
        else:
            add("LCSC", name, line["lcsc"], url, None, "USD", max(want, moq), moq,
                "no price kept - the BOM Cost view asks LCSC", None, "lcsc", line["lcsc"])
    keys = {_key(x) for x in (line["mpn"], line["lcsc"]) if x and len(_key(x)) >= 3}
    for m in makers:
        if m["_id"] in ("lcsc", "grabcad"):
            continue
        for p in m.get("products") or []:
            pid = str(p.get("id"))
            if (m["_id"], pid) in seen:
                continue
            mine = line["product"] and tuple(line["product"]) == (m["_id"], pid)
            spec_mpn = (p.get("specs") or {}).get("MPN") or (p.get("specs") or {}).get("Part number")
            if not mine and not (keys & {_key(p.get("sku")), _key(spec_mpn), _key(pid)} - {""}):
                continue
            seller = m.get("name") or m["_id"]
            if m["_id"] == "mcmaster":
                got = mcmaster_price((p.get("specs") or {}).get("Price") or "")
                if got:
                    pack_price, pack = got
                    packs = max(1, math.ceil(want / pack))
                    add(seller, p.get("name") or pid, pid, p.get("url") or "", pack_price / pack, "USD", packs * pack,
                        pack, f"{packs} pack{'s' if packs != 1 else ''} of {pack}" if pack > 1 else "", None,
                        m["_id"], pid)
                else:
                    add(seller, p.get("name") or pid, pid, p.get("url") or "", None, "USD", want, 1,
                        "no price seen - check its page", None, m["_id"], pid)
                continue
            pr = p.get("price") or {}
            amount = pr.get("amount")
            vat = {"incl": "VAT incl.", "excl": "VAT excl."}.get(pr.get("vat") or "", "")
            add(seller, p.get("name") or pid, p.get("sku") or pid, p.get("url") or "",
                float(amount) if amount is not None else None, pr.get("currency") or "USD", want, 1,
                vat if amount is not None else "no price read", p.get("stock_qty"), m["_id"], pid)
    out.sort(key=lambda o: (o["total"] is None, o["total"] or 0))
    return out


def money(x: float | None, cur: str) -> str:
    if x is None:
        return "-"
    return f"{x:,.4f} {cur}".replace(".0000 ", " ") if x < 1 else f"{x:,.2f} {cur}"
