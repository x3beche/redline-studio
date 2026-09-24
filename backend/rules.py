"""Routing rules for a board: what the autorouter is told.

Net classes (how wide a track, how far from its neighbours, what via),
differential pairs, the board's minimums, and the ground pour. A board
starts with rules worked out from its net names - `vbus`, `gnd` and `v3v3`
are power and get wide tracks, `dp` and `dn` are a pair - and anything a
person changes in the panel is theirs from then on: a rebuild that adds a
net classifies the new net and leaves the rest alone.

The numbers default to what JLCPCB makes on a two-layer board without
charging extra, with a margin: 0.15 mm track and gap where they allow
0.127, 0.6/0.3 mm vias where they allow 0.45/0.2.
"""

from __future__ import annotations

import copy
import re

# Rails and returns. A net is power by name; the names are the ones people
# actually give them, which is the only thing a netlist says about a net.
POWER = re.compile(
    r"^(gnd|agnd|dgnd|pgnd|vss|vssa|vdd|vdda|vcc|vin|vbus|vbat|vsys|vout|"
    r"v?\d+v\d*|v\d+|\d+v|v3v3|v1v8|v5v)$", re.I)
GROUND = re.compile(r"^(gnd|agnd|dgnd|pgnd|vss)$", re.I)

# The two halves of a pair, by the suffixes people use: dp/dn, udp/udn,
# usb_p/usb_n, d+/d-, clk_pos/clk_neg.
PAIR_ENDS = [("_pos", "_neg"), ("_p", "_n"), ("+", "-"), ("p", "n")]

DEFAULT = {"name": "Default", "track": 0.25, "clearance": 0.2,
           "via": 0.6, "drill": 0.3}
POWER_CLASS = {"name": "Power", "track": 0.5, "clearance": 0.2,
               "via": 0.8, "drill": 0.4}


def pairs_in(nets: list[str]) -> list[tuple[str, str]]:
    """Differential pairs among these nets: a name ending in a positive
    suffix whose negative twin is also a net."""
    names = set(nets)
    found, used = [], set()
    for net in sorted(names):
        if net in used:
            continue
        for p_end, n_end in PAIR_ENDS:
            if len(net) <= len(p_end) or not net.lower().endswith(p_end):
                continue
            twin = net[: -len(p_end)] + n_end
            if twin in names and twin not in used:
                found.append((net, twin))
                used |= {net, twin}
                break
    return found


def derive(nets: list[str]) -> dict:
    """Rules worked out from the net names alone."""
    nets = [n for n in nets if n]
    pairs = pairs_in(nets)
    in_pair = {n for pair in pairs for n in pair}
    power = [n for n in nets if POWER.match(n) and n not in in_pair]
    ground = next((n for n in nets if GROUND.match(n)), None)

    classes = [dict(DEFAULT, nets=[]),
               dict(POWER_CLASS, nets=sorted(power))]
    diff = []
    for p, n in pairs:
        # USB full speed, and most pairs on a two-layer hobby board, are
        # not impedance-critical: 0.25 mm tracks 0.15 mm apart, routed
        # together. The width follows the class so the router uses it.
        name = _pair_name(p)
        classes.append({"name": name, "track": 0.25, "clearance": 0.2,
                        "via": 0.6, "drill": 0.3, "nets": [p, n]})
        diff.append({"name": name, "p": p, "n": n, "width": 0.25, "gap": 0.15})

    return {
        "classes": classes,
        "pairs": diff,
        "board": {"layers": 2, "min_track": 0.15, "min_clearance": 0.15,
                  "min_via": 0.6, "min_drill": 0.3},
        "pour": {"net": ground, "layers": ["F.Cu", "B.Cu"], "clearance": 0.3,
                 "connection": "solid"}
                if ground else None,
        "route": {"passes": 40},
        "edited": False,
    }


def _pair_name(p: str) -> str:
    base = re.sub(r"(_p|_pos|\+|p)$", "", p, flags=re.I) or p
    return "USB" if base.lower() in ("d", "ud", "usb_d", "usb") else base.upper()


def merge(saved: dict | None, nets: list[str]) -> dict:
    """The saved rules, brought up to date with the board's nets.

    Nets that are gone are dropped from their classes; nets that are new
    go where their names say. Everything a person set - widths, which net
    is in which class, the pairs - stays as they set it.
    """
    fresh = derive(nets)
    if not saved:
        return fresh
    out = copy.deepcopy(saved)
    present = set(n for n in nets if n)
    classes = out.setdefault("classes", [])
    placed = set()
    for cls in classes:
        cls["nets"] = [n for n in cls.get("nets", []) if n in present]
        placed |= set(cls["nets"])

    by_name = {c["name"]: c for c in classes}
    for cls in fresh["classes"]:
        new = [n for n in cls["nets"] if n not in placed]
        if not new:
            continue
        if cls["name"] in by_name:
            by_name[cls["name"]]["nets"] += new
        else:
            classes.append(dict(cls, nets=new))
        placed |= set(new)

    out["pairs"] = [p for p in out.get("pairs", [])
                    if p.get("p") in present and p.get("n") in present]
    known = {(p["p"], p["n"]) for p in out["pairs"]}
    out["pairs"] += [p for p in fresh["pairs"] if (p["p"], p["n"]) not in known]
    if out.get("pour") and out["pour"].get("net") not in present:
        out["pour"] = fresh["pour"]
    out.setdefault("board", fresh["board"])
    out.setdefault("route", fresh["route"])
    return out


def check(rules: dict) -> list[str]:
    """What is wrong with a set of rules before a router is given them."""
    out = []
    b = rules.get("board", {})
    for cls in rules.get("classes", []):
        name = cls.get("name", "?")
        if cls.get("track", 0) < b.get("min_track", 0):
            out.append(f"{name}: track {cls['track']} mm is under the board's "
                       f"minimum {b['min_track']} mm")
        if cls.get("clearance", 0) < b.get("min_clearance", 0):
            out.append(f"{name}: clearance {cls['clearance']} mm is under the "
                       f"minimum {b['min_clearance']} mm")
        if cls.get("drill", 0) >= cls.get("via", 1):
            out.append(f"{name}: a {cls['drill']} mm drill in a {cls['via']} mm "
                       "via leaves no copper")
    seen: dict[str, str] = {}
    for cls in rules.get("classes", []):
        for net in cls.get("nets", []):
            if net in seen:
                out.append(f"{net} is in both {seen[net]} and {cls['name']}")
            seen[net] = cls["name"]
    for pair in rules.get("pairs", []):
        if pair.get("gap", 0) < b.get("min_clearance", 0):
            out.append(f"pair {pair['name']}: gap {pair['gap']} mm is under the "
                       f"minimum clearance {b['min_clearance']} mm")
    return out
