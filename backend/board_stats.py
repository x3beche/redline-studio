"""What a board adds up to, for the board room's Analytics tab.

Everything here is read from what is already known: the build's netlist,
the placement and routing the pipeline wrote down, the checks, and LCSC's
answers that are already on disk. Nothing asks LCSC - a summary that
spent the request budget would cost more than it said.
"""

from __future__ import annotations

import json
from collections import Counter

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
    return {
        "board": bid,
        "blocks": ranked(Counter(block_of(c.get("where")) for c in comps)),
        "fanout": fanout((graph or {}).get("nets") or []),
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
    }
