"""What a board and its library add up to, for the board room's Analytics tab.

Everything here is read from what is already known: the build's netlist,
the placement and routing the pipeline wrote down, the checks, the parts
drawer, and LCSC's answers that are already on disk. Nothing asks LCSC -
a summary that spent the request budget would cost more than it said.
"""

from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timedelta, timezone

from . import ato, lcsc, store


def _cached_offer(part: str) -> dict | None:
    """Price and JLCPCB class of a part, from LCSC's answer on disk only."""
    path = lcsc.LOOK / part / "component.json"
    try:
        body = json.loads(path.read_text(errors="replace"))
    except (OSError, ValueError):
        return None
    c = body.get("result") or {}
    para = ((c.get("dataStr") or {}).get("head") or {}).get("c_para") or {}
    shop = c.get("lcsc") or {}
    price = shop.get("price")
    return {"price": float(price) if isinstance(price, (int, float)) else None,
            "jlc": para.get("JLCPCB Part Class")}


def bom(components: list[dict]) -> dict:
    """One board's parts, priced from what is known.

    `lines` is distinct part numbers, `cost_usd` the sum of unit price
    times how many the board uses, over the lines that have a price; the
    rest are counted, not guessed. JLCPCB assembles Basic parts with no
    loading fee and charges a feeder for each Extended one.
    """
    qty = Counter(c.get("part") for c in components if c.get("part"))
    priced = basic = extended = 0
    cost = 0.0
    for part, n in qty.items():
        offer = _cached_offer(part)
        if not offer:
            continue
        if offer["price"] is not None:
            priced += 1
            cost += offer["price"] * n
        jlc = (offer["jlc"] or "").lower()
        if jlc.startswith("basic"):
            basic += 1
        elif jlc.startswith("extended"):
            extended += 1
    return {"lines": len(qty), "priced": priced, "cost_usd": round(cost, 4),
            "basic": basic, "extended": extended,
            "unpartnumbered": sum(1 for c in components if not c.get("part"))}


async def library(db) -> dict:
    """The parts drawer: how many, how many stand on a board in 3D, and
    what they weigh in the database - models are kept inline, so this is
    the number that grows."""
    rows = [r async for r in db[lcsc.PARTS].aggregate([{"$group": {
        "_id": None, "parts": {"$sum": 1},
        "with_3d": {"$sum": {"$cond": [{"$or": [
            {"$ifNull": ["$artifacts.model", False]},
            {"$ifNull": ["$model_step", False]},
            {"$ifNull": ["$model_wrl", False]}]}, 1, 0]}},
        "bytes": {"$sum": {"$bsonSize": "$$ROOT"}},
    }}])]
    r = rows[0] if rows else {}
    return {"parts": r.get("parts", 0), "with_3d": r.get("with_3d", 0),
            "bytes": r.get("bytes", 0)}


def lcsc_usage() -> dict:
    """The last hour of asks, and whether LCSC is being given a rest."""
    rows = lcsc.journal(1000)
    hour_ago = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    recent = [r for r in rows if r.get("at", "") >= hour_ago]
    state = lcsc.state()
    return {"net": sum(r["source"] == "net" for r in recent),
            "disk": sum(r["source"] == "disk" for r in recent),
            "refused": sum(r["source"] == "refused" or r.get("status") in (403, 429)
                           for r in recent),
            "cooling": bool(state.get("refused_until")),
            "used": state.get("used"), "budget": state.get("budget")}


# ---------------- what the board is made of ----------------
# A part's kind, read off its footprint: atopile names every part U<n>, so
# the reference says nothing, while the footprint always says what the
# part is soldered as. First match wins, so the specific come first.
KINDS = [
    ("LEDs", ("LED",)),
    ("resistors", ("R0201", "R0402", "R0603", "R0805", "R1206", "R_")),
    ("capacitors", ("C0201", "C0402", "C0603", "C0805", "C1206", "CAP", "C_")),
    ("inductors", ("L0402", "L0603", "L0805", "IND")),
    ("connectors", ("TYPE-C", "USB", "CONN", "HDR", "PH-", "JST", "SMA")),
    ("switches", ("SW-", "SW_", "BUTTON", "KEY")),
    ("crystals", ("CRYSTAL", "XTAL", "OSC")),
    ("diodes", ("SOD", "DO-", "SMA_", "SMB")),
    ("transistors", ("SOT-23_", "SOT-323", "SOT-523")),
    ("ICs", ("SOT-23-", "SOIC", "SOP", "TSSOP", "ESOP", "QFN", "LQFP", "QFP",
             "DFN", "MSOP", "BGA")),
]


def kind_of(footprint: str | None) -> str:
    name = (footprint or "").split(":")[-1].upper()
    for kind, marks in KINDS:
        if any(m.upper() in name for m in marks):
            return kind
    return "other"


def block_of(where: str | None) -> str:
    """The circuit block a part is declared in: `...:Controller::power.r_cc1`
    is in `power`."""
    path = (where or "").split("::", 1)[-1] if "::" in (where or "") else ""
    return path.split(".", 1)[0] if "." in path else (path or "top")


def ranked(counter: Counter, top: int = 8) -> list[dict]:
    """Largest first; past `top`, the rest fold into one row."""
    rows = counter.most_common()
    out = [{"label": k, "value": v} for k, v in rows[:top]]
    rest = sum(v for _, v in rows[top:])
    if rest:
        out.append({"label": "the rest", "value": rest})
    return out


def fanout(nets: list[dict]) -> list[dict]:
    """Nets by how many pins they join. A one-pin net goes nowhere - a pin
    left unconnected on purpose, or not."""
    bins = [("1", 1, 1), ("2", 2, 2), ("3-4", 3, 4), ("5-9", 5, 9), ("10+", 10, 10 ** 9)]
    sizes = [len(n.get("nodes") or []) for n in nets]
    return [{"label": b, "value": sum(lo <= n <= hi for n in sizes)} for b, lo, hi in bins]


def bom_top(components: list[dict], top: int = 5) -> list[dict]:
    """The part numbers that cost the most on one board, from disk only."""
    qty = Counter(c.get("part") for c in components if c.get("part"))
    rows = []
    for part, n in qty.items():
        offer = _cached_offer(part)
        if offer and offer["price"] is not None:
            rows.append({"label": part, "value": round(offer["price"] * n, 4), "qty": n})
    rows.sort(key=lambda r: -r["value"])
    return rows[:top]


# ---------------- how it got here ----------------
HISTORY = "board_history"
HISTORY_KEEP = 80
TRACKED = ("area_cm2", "components", "tracks", "vias", "unrouted",
           "drc_errors", "drc_warnings")


async def remember(db, bid: str, point: dict) -> list[dict]:
    """Keep this reading if it differs from the last one, and return the
    board's readings, oldest first. There is no history before the first
    time anybody looked: nothing is made up backwards."""
    col = db[HISTORY]
    last = await col.find_one({"board": bid}, sort=[("at", -1)])
    if not last or any(last.get(k) != point.get(k) for k in TRACKED):
        await col.insert_one({"board": bid, "at": store.now(), **point})
        old = [d["_id"] async for d in col.find({"board": bid}, {"_id": 1})
               .sort("at", -1).skip(HISTORY_KEEP)]
        if old:
            await col.delete_many({"_id": {"$in": old}})
    return [{k: d.get(k) for k in ("at", *TRACKED)}
            async for d in col.find({"board": bid}).sort("at", 1)]


async def summary(db, bid: str) -> dict:
    doc = await db[ato.BOARDS].find_one({"_id": bid}, {"source": 0})
    if not doc:
        raise KeyError(bid)
    try:
        graph = json.loads(await store.get_artifact(db, bid, "graph", ato.BOARDS))
    except KeyError:
        graph = None
    comps = (graph or {}).get("components") or []
    counts = (graph or {}).get("counts") or {}
    size = (doc.get("layout") or {}).get("size_mm")
    area = round(size[0] * size[1] / 100, 2) if size and size[0] and size[1] else None
    route = doc.get("route") or {}
    drc = doc.get("drc") or {}
    erc = ((doc.get("schematic") or {}).get("erc")) or {}
    drc_types = Counter()
    for sev in ("errors", "warnings"):
        for k, v in (drc.get(sev) or {}).items():
            drc_types[k.replace("_", " ")] += int(v or 0)
    point = {"area_cm2": area, "components": len(comps) or None,
             "tracks": route.get("tracks"), "vias": route.get("vias"),
             "unrouted": route.get("unrouted"),
             "drc_errors": drc.get("error_count"), "drc_warnings": drc.get("warning_count")}
    history = await remember(db, bid, point) if comps else []
    return {
        "board": bid,
        "kinds": ranked(Counter(kind_of(c.get("footprint")) for c in comps)),
        "blocks": ranked(Counter(block_of(c.get("where")) for c in comps)),
        "fanout": fanout((graph or {}).get("nets") or []),
        "drc_types": ranked(drc_types, 5),
        "bom_top": bom_top(comps) if comps else [],
        "history": history,
        "parts": {"components": counts.get("components", len(comps)),
                  "nets": counts.get("nets"), "joins": counts.get("joins")},
        "size": {"mm": size, "area_cm2": area,
                 "density": round(len(comps) / area, 2) if area and comps else None},
        "route": {k: route.get(k) for k in ("tracks", "vias", "length_mm", "unrouted")}
                 if route else None,
        "checks": {"drc_errors": drc.get("error_count"),
                   "drc_warnings": drc.get("warning_count"),
                   "unconnected": drc.get("unconnected"),
                   "erc_errors": erc.get("error_count")} if (drc or erc) else None,
        "bom": bom(comps) if comps else None,
        "library": await library(db),
        "lcsc": lcsc_usage(),
    }
