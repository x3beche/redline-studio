"""What a board costs to buy, and which of its parts cannot be bought.

The Analytics tab's `board_stats.bom` adds up one price per part from the
component record on disk. That price is a one-off price: a hundred boards
do not pay it. LCSC sells in price breaks - 1, 10, 100, 1000 pieces at
falling prices - and the right break is the one for the number of pieces
an order actually takes: parts per board times boards.

The breaks and the stock come from EasyEDA's catalogue search (the
endpoint `/api/parts/search` uses), asked once per part number and kept
beside the part's other files as `offer.json`, with the time it was
asked. Reading a board's cost asks nothing. A refresh asks only for the
parts whose offer is missing or older than a day, one at a time through
lcsc's polite budget (and its proxy), and waits for the budget rather
than failing at the twenty-sixth part.

A part never searched still has the one price and the stock of its
component record (`component.json`), when that is on disk; it is used
as a single break and said to be that.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import urllib.parse
from collections import defaultdict
from datetime import datetime, timezone

from . import lcsc, scope, store

OFFER = "offer.json"
ALTS = "alternatives.json"
MAX_AGE = 24 * 3600            # an offer older than this is refreshed when asked
MIN_AGE = 600                  # never asked again sooner than this, even on demand
QUANTITIES = (1, 10, 50, 100, 500, 1000)
LOW_STOCK = 500                # fewer than this on the shelf: low
LOW_FACTOR = 2                 # or fewer than twice what the order takes
# JLCPCB's assembly charges a one-off loading fee per order for each
# distinct Extended part (Basic parts sit on the machines already).
EXTENDED_FEE_USD = 3.0


# ---------------- price breaks ----------------

def parse_breaks(raw) -> list[list[float]]:
    """EasyEDA's price bands - [quantity, price, price with tax] - as
    [[quantity, price]] sorted by quantity; bands that do not read as
    numbers are dropped."""
    out = []
    for band in raw or []:
        if not isinstance(band, (list, tuple)) or len(band) < 2:
            continue
        try:
            q, p = int(float(band[0])), float(band[1])
        except (TypeError, ValueError):
            continue
        if q > 0 and p >= 0:
            out.append([q, p])
    out.sort(key=lambda b: b[0])
    return out


def unit_price(breaks: list, need: int) -> tuple[float | None, int | None]:
    """The unit price for buying `need` pieces, and the break it comes
    from: the largest break at or below `need`. Below the smallest break
    the smallest break's price - that is what the least one can buy costs."""
    if not breaks:
        return None, None
    pick = breaks[0]
    for b in breaks:
        if b[0] <= need:
            pick = b
        else:
            break
    return float(pick[1]), int(pick[0])


def stock_state(stock, need: int, low: int = LOW_STOCK) -> str:
    """out, short (fewer than the order takes), low, ok - or unknown."""
    if not isinstance(stock, (int, float)):
        return "unknown"
    if stock <= 0:
        return "out"
    if stock < need:
        return "short"
    if stock < max(low, need * LOW_FACTOR):
        return "low"
    return "ok"


# ---------------- offers on disk ----------------

def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


def _component_facts(part: str) -> dict:
    """The JLCPCB class, the name and the package from the component record."""
    try:
        body = json.loads((lcsc.LOOK / part / "component.json").read_text(errors="replace"))
    except (OSError, ValueError):
        return {}
    c = body.get("result") or {}
    para = ((c.get("dataStr") or {}).get("head") or {}).get("c_para") or {}
    return {"jlc_class": para.get("JLCPCB Part Class"),
            "mpn": para.get("Manufacturer Part") or para.get("name"),
            "package": para.get("package"), "maker": para.get("Manufacturer"),
            "shop": c.get("lcsc") or {}}


def _from_component(part: str) -> dict | None:
    path = lcsc.LOOK / part / "component.json"
    facts = _component_facts(part)
    if not facts:
        return None
    shop = facts.pop("shop")
    price = shop.get("price")
    breaks = [[int(shop.get("min") or 1), float(price)]] if isinstance(price, (int, float)) else []
    try:
        ts = path.stat().st_mtime
    except OSError:
        ts = 0
    return {"lcsc": part, **facts, "stock": shop.get("stock"), "breaks": breaks,
            "ts": ts, "at": _iso(ts), "source": "component"}


def record_stock(part: str):
    """The stock in the part's component record on disk, if any."""
    shop = _component_facts(part).get("shop") or {}
    st = shop.get("stock")
    return st if isinstance(st, (int, float)) else None


def cached_offer(part: str) -> dict | None:
    """What is known about buying a part, from disk only."""
    if not lcsc.looks_like_a_part(part):
        return None
    try:
        return json.loads((lcsc.LOOK / part / OFFER).read_text())
    except (OSError, ValueError):
        return _from_component(part)


def age(offer: dict | None, now: float | None = None) -> float | None:
    if not offer or offer.get("source") == "component":
        return None
    return (now or time.time()) - (offer.get("ts") or 0)


def needs_asking(offer: dict | None, now: float | None = None, max_age: float = MAX_AGE) -> bool:
    """No searched offer, or one older than `max_age`."""
    a = age(offer, now)
    return a is None or a > max_age


def _keep(part: str, name: str, data: dict) -> None:
    path = lcsc.LOOK / part / name
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    tmp.replace(path)


def offer_from_row(part: str, row: dict | None, now: float) -> dict:
    facts = _component_facts(part)
    facts.pop("shop", None)
    if not row:
        return {"lcsc": part, **facts, "stock": None, "breaks": [], "ts": now,
                "at": _iso(now), "source": "search", "missing": True}
    return {"lcsc": part, "mpn": row.get("mpn") or facts.get("mpn"),
            "package": row.get("package") or facts.get("package"),
            "maker": row.get("manufacturer") or facts.get("maker"),
            "jlc_class": facts.get("jlc_class"),
            "stock": row.get("stock") if isinstance(row.get("stock"), (int, float)) else None,
            "breaks": parse_breaks(row.get("price")),
            "ts": now, "at": _iso(now), "source": "search"}


async def _search_raw(term: str, size: int = 5) -> list[dict]:
    """EasyEDA's catalogue, rows as it sends them (price bands kept),
    through lcsc's turn-taking and proxy."""
    url = f"{lcsc.SEARCH}?keyword={urllib.parse.quote(term)}&page=1&pageSize={size}"
    body = await lcsc._polite("search", term, url, lcsc._ask, url)
    return ((body or {}).get("result") or {}).get("productList") or []


async def fetch_offer(part: str) -> dict:
    """One ask: the part's price breaks and stock, kept with the time."""
    rows = await _search_raw(part, 5)
    row = next((r for r in rows if (r.get("number") or "").strip() == part), None)
    offer = offer_from_row(part, row, time.time())
    try:
        _keep(part, OFFER, offer)
    except OSError:
        pass
    return offer


# ---------------- the board's lines ----------------

def _natural(ref: str):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", ref or "")]


def _bom_rows(raw: bytes | None) -> dict[str, dict]:
    """ref -> {value, mpn, footprint, part} from the board's BOM CSV."""
    if not raw:
        return {}
    from .imports import parts
    out = {}
    for row in parts._table(raw):
        info = {"value": parts._pick(row, "comment", "value", "val", "name"),
                "mpn": parts._pick(row, "manufacturer part", "mpn", "manufacturer part number", "mfr. part #"),
                "footprint": parts._pick(row, *parts.FOOT_COLS),
                "part": parts._pick(row, *parts.PART_COLS)}
        for ref in parts._refs(parts._pick(row, *parts.REF_COLS)):
            out[ref] = info
    return out


def lines_of(components: list[dict], bom: dict[str, dict]) -> list[dict]:
    """One line per part number (a part without one is a line of its own):
    the refs, how many a board takes, and what the BOM calls it."""
    groups: dict[str, list[dict]] = defaultdict(list)
    for c in components:
        part = (c.get("part") or "").strip()
        if not lcsc.looks_like_a_part(part):
            part = ""
        groups[part or f"?{c.get('ref')}"].append(c)
    out = []
    for key, cs in groups.items():
        refs = sorted((c.get("ref") or "?" for c in cs), key=_natural)
        b = next((bom[r] for r in refs if r in bom), {})
        value = b.get("value") or next((c.get("value") for c in cs if c.get("value") not in (None, "", "?")), None)
        out.append({"lcsc": None if key.startswith("?") else key, "refs": refs,
                    "qty": len(cs), "value": value, "bom_mpn": b.get("mpn"),
                    "footprint": (cs[0].get("footprint") or b.get("footprint") or "").split(":")[-1] or None})
    out.sort(key=lambda l: _natural(l["refs"][0]))
    return out


async def board_lines(db, bid: str) -> list[dict]:
    """The board's parts from its build (the netlist names every part's
    number, the BOM's picks included), else from its BOM CSV alone."""
    from .ato import BOARDS
    doc = await db[BOARDS].find_one({"_id": bid}, {"_id": 1})
    if not doc:
        raise KeyError(bid)

    async def artifact(label):
        try:
            return await store.get_artifact(db, bid, label, BOARDS)
        except KeyError:
            return None
    bom = _bom_rows(await artifact("bom_csv"))
    graph_raw = await artifact("graph")
    comps = (json.loads(graph_raw) or {}).get("components") if graph_raw else None
    if not comps:
        comps = [{"ref": ref, "part": r.get("part"), "value": r.get("value"),
                  "footprint": r.get("footprint")} for ref, r in bom.items()]
    return lines_of(comps, bom)


# ---------------- what it costs ----------------

def _passive_kind(footprint: str | None) -> tuple[str, str] | None:
    """R0603 -> ("R", "0603"); C0402 -> ("C", "0402")."""
    m = re.match(r"^(R|C)_?(0201|0402|0603|0805|1206)\b", (footprint or "").upper())
    return (m.group(1), m.group(2)) if m else None


def passive_alternative(line: dict, need: int) -> dict | None:
    """The checked passives table's part for the same value and size, when
    it is another part number and it has enough on the shelf. No request."""
    kind = _passive_kind(line.get("footprint")) or _passive_kind(line.get("package"))
    if not kind or not line.get("value"):
        return None
    row = lcsc.passive(kind[0], line["value"], kind[1])
    if not row or row.get("lcsc") == line.get("lcsc"):
        return None
    if (row.get("stock") or 0) < need:
        return None
    return {"lcsc": row["lcsc"], "mpn": row.get("mpn"), "package": row.get("package"),
            "stock": row.get("stock"), "why": f"same value and size ({row['key']}), from the checked passives table"}


def kept_alternatives(part: str) -> dict | None:
    try:
        return json.loads((lcsc.LOOK / part / ALTS).read_text())
    except (OSError, ValueError):
        return None


def cost(lines: list[dict], offers: dict[str, dict | None], qty: int,
         quantities=QUANTITIES, now: float | None = None) -> dict:
    """The board at `qty` boards, line by line, and the totals at each of
    `quantities`. Everything in US dollars, as LCSC prices it."""
    now = now or time.time()
    qty = max(1, int(qty))
    rows, ext = [], 0
    totals = {q: {"per_board": 0.0, "order": 0.0, "min_order": 0.0} for q in sorted(set(quantities) | {qty})}
    priced = 0
    for line in lines:
        part = line.get("lcsc")
        offer = offers.get(part) if part else None
        breaks = (offer or {}).get("breaks") or []
        stock = (offer or {}).get("stock")
        jlc = (offer or {}).get("jlc_class")
        if (jlc or "").lower().startswith("extended"):
            ext += 1
        if breaks:
            priced += 1
        for q, t in totals.items():
            need = line["qty"] * q
            price, _ = unit_price(breaks, need)
            if price is not None:
                t["per_board"] += price * line["qty"]
                t["order"] += price * need
                # LCSC sells no fewer than its smallest break.
                t["min_order"] += price * max(need, int(breaks[0][0]))
        need = line["qty"] * qty
        price, brk = unit_price(breaks, need)
        state = "no_part" if not part else stock_state(stock, need)
        # The search and the part's own record are two LCSC listings and
        # do not always agree: the search can say 0 where the record (a day
        # older at most) shows thousands. Then it is "unsure", not "out" -
        # a false alarm is worse than a question.
        other = record_stock(part) if part and (offer or {}).get("source") == "search" else None
        if state in ("out", "short") and isinstance(other, (int, float)) and other >= need:
            state = "unsure"
        flags = []
        if not part:
            flags.append("no LCSC number")
        elif not breaks:
            flags.append("no price")
        if offer and offer.get("missing"):
            flags.append("LCSC does not list it")
        alts = []
        if state in ("out", "short", "low", "unsure", "unknown") or not part:
            alt = passive_alternative({**line, "package": (offer or {}).get("package")}, need)
            if alt:
                alts.append(alt)
            kept = kept_alternatives(part) if part else None
            for a in (kept or {}).get("rows") or []:
                if (a.get("stock") or 0) >= need and all(a["lcsc"] != x["lcsc"] for x in alts):
                    alts.append(a)
        rows.append({
            **line,
            "mpn": (offer or {}).get("mpn") or line.get("bom_mpn"),
            "package": (offer or {}).get("package"),
            "maker": (offer or {}).get("maker"),
            "jlc_class": jlc,
            "stock": stock, "stock_record": other, "state": state, "need": need,
            "unit_usd": price, "break_qty": brk,
            "line_usd": round(price * line["qty"], 6) if price is not None else None,
            "breaks": breaks,
            "source": (offer or {}).get("source"),
            "checked_at": (offer or {}).get("at"),
            "stale": bool(part) and needs_asking(offer, now),
            "flags": flags,
            "alternatives": alts,
            "alternatives_at": ((kept_alternatives(part) or {}).get("at") if part else None),
        })
    counts = defaultdict(int)
    for r in rows:
        counts[r["state"]] += 1
    problems = [r for r in rows if r["state"] in ("out", "short")]
    return {
        "qty": qty,
        "lines": rows,
        "parts": sum(l["qty"] for l in lines),
        "distinct": len(lines),
        "priced": priced,
        "unpriced": [r["refs"] for r in rows if r["unit_usd"] is None],
        "per_board_usd": round(totals[qty]["per_board"], 4),
        "total_usd": round(totals[qty]["order"], 4),
        "min_order_usd": round(totals[qty]["min_order"], 4),
        "quantities": [{"qty": q, "per_board_usd": round(t["per_board"], 4),
                        "total_usd": round(t["order"], 4),
                        "min_order_usd": round(t["min_order"], 4)}
                       for q, t in totals.items() if q in quantities],
        "extended": ext,
        "extended_fee_usd": ext * EXTENDED_FEE_USD,
        "extended_fee_note": f"JLCPCB assembly: about ${EXTENDED_FEE_USD:g} loading fee per Extended part, once per order",
        "stock": {"out": counts["out"], "short": counts["short"], "low": counts["low"],
                  "unknown": counts["unknown"], "unsure": counts["unsure"], "no_part": counts["no_part"], "ok": counts["ok"]},
        "problems": [{"refs": r["refs"], "lcsc": r["lcsc"], "state": r["state"],
                      "stock": r["stock"], "need": r["need"],
                      "has_alternatives": bool(r["alternatives"])} for r in problems],
        "stale": sum(1 for r in rows if r["stale"]),
        "oldest_at": min((r["checked_at"] for r in rows if r["checked_at"]), default=None),
    }


# ---------------- refreshing, in the background ----------------

# board, per space (scope.key: two spaces can each have a `controller`) ->
# {"running", "done", "total", "asked", "failed", "error", "started", "finished"}
JOBS: dict[str, dict] = {}


def job(bid: str) -> dict | None:
    return JOBS.get(scope.key(bid))


def to_refresh(parts: list[str], now: float | None = None, force: bool = False) -> list[str]:
    """The parts a refresh asks about: missing or older than a day - or,
    `force`d, anything older than ten minutes."""
    now = now or time.time()
    limit = MIN_AGE if force else MAX_AGE
    return [p for p in parts if needs_asking(cached_offer(p), now, limit)]


async def refresh(bid: str, parts: list[str]) -> dict:
    """Ask for each part's offer, one at a time, waiting for the budget.
    A refusal (EasyEDA cooling off) ends the run; what was fetched stays."""
    state = JOBS[scope.key(bid)]
    lcsc.PATIENT.set(True)
    try:
        for part in parts:
            state["current"] = part
            try:
                await fetch_offer(part)
                state["asked"] += 1
            except lcsc.Refused as exc:
                state["error"] = str(exc)
                break
            except (OSError, ValueError, TimeoutError) as exc:
                state["failed"].append(part)
                state["last_error"] = f"{part}: {exc}"[:200]
            state["done"] += 1
    finally:
        state["running"] = False
        state["current"] = None
        state["finished"] = store.now()
    return state


def start_refresh(bid: str, parts: list[str], force: bool = False) -> dict:
    """Start (or report) the board's refresh. Only one per board at a time."""
    have = job(bid)
    if have and have.get("running"):
        return have
    todo = to_refresh(parts, force=force)
    state = {"running": bool(todo), "done": 0, "total": len(todo), "asked": 0,
             "failed": [], "error": None, "current": None,
             "started": store.now(), "finished": None if todo else store.now()}
    JOBS[scope.key(bid)] = state
    if todo:
        state["task"] = asyncio.get_running_loop().create_task(refresh(bid, todo))
    return state


def public(state: dict | None) -> dict | None:
    return {k: v for k, v in state.items() if k != "task"} if state else None


# ---------------- alternatives, asked for one part ----------------

async def find_alternatives(line: dict, need: int, limit: int = 5) -> dict:
    """Parts like this one that can be bought now: one search by its MPN
    (else its value and package), kept for a day. Suggestions only."""
    part = line["lcsc"]
    kept = kept_alternatives(part)
    if kept and time.time() - (kept.get("ts") or 0) < MAX_AGE:
        return kept
    pkg = (line.get("package") or "").strip(" -")
    term = search_term(line)
    if not term:
        return {"rows": [], "term": None}
    rows = await _search_raw(term, 20)
    out = []
    for r in rows:
        number = (r.get("number") or "").strip()
        stock = r.get("stock") if isinstance(r.get("stock"), (int, float)) else 0
        if not lcsc.looks_like_a_part(number) or number == part or stock <= 0:
            continue
        if pkg and r.get("package") and _pkg_key(r["package"]) != _pkg_key(pkg):
            continue
        breaks = parse_breaks(r.get("price"))
        out.append({"lcsc": number, "mpn": r.get("mpn"), "package": r.get("package"),
                    "maker": r.get("manufacturer"), "stock": stock,
                    "unit_usd": unit_price(breaks, need)[0],
                    "why": f"LCSC search for “{term}”, same package"})
    out.sort(key=lambda r: -(r["stock"] or 0))
    now = time.time()
    data = {"rows": out[:limit], "term": term, "ts": now, "at": _iso(now)}
    try:
        _keep(part, ALTS, data)
    except OSError:
        pass
    return data


def search_term(line: dict) -> str | None:
    """What to search for parts like this one. A value that is not the
    part number - 1uH, 11.0592MHz, 10k - with the package finds other
    makers' parts; an IC is its part number (other packagings, other
    makers' copies)."""
    value, mpn = (line.get("value") or "").strip(), (line.get("mpn") or "").strip()
    pkg = (line.get("package") or "").strip(" -")
    if value and value.upper() != mpn.upper() and re.search(r"\d", value) and len(value) <= 16:
        # A resistor's value alone also finds varistors and ferrites.
        kind = _passive_kind(line.get("footprint"))
        word = {"R": "resistor", "C": "capacitor"}.get(kind[0]) if kind else None
        return " ".join(x for x in (value, pkg, word) if x)
    return mpn or (" ".join(x for x in (value, pkg) if x)) or None


def _pkg_key(pkg: str) -> str:
    """Packages compare by their leading name: SOT-23-3_L2.9-W1.3... is SOT-23-3."""
    return re.split(r"[_ ]", pkg.strip().upper())[0]
