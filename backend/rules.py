"""Routing rules for a board: what the autorouter is told.

Net classes (how wide a track, how far from its neighbours, what via),
differential pairs, the board's minimums, and copper pours. A board
starts with rules worked out from its net names - `vbus`, `gnd` and `v3v3`
are power and get wide tracks, `dp` and `dn` are a pair - and anything a
person changes in the panel is theirs from then on: a rebuild that adds a
net classifies the new net and leaves the rest alone.

The numbers default to what JLCPCB makes on a two-layer board without
charging extra, with a margin: 0.15 mm track and gap where they allow
0.127, 0.6/0.3 mm vias where they allow 0.45/0.2.

Everything is editable - classes, pairs and pours added, changed and
removed - by a person in the board room's Rules tab or by an agent through
`revisions.py board rules`. Both work from SCHEMA, and both are held to
`check`, which names the field each problem is in.
"""

from __future__ import annotations

import copy
import fnmatch
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

    classes = [dict(DEFAULT, nets=[], patterns=[]),
               dict(POWER_CLASS, nets=sorted(power), patterns=[])]
    diff = []
    for p, n in pairs:
        # USB full speed, and most pairs on a two-layer hobby board, are
        # not impedance-critical: 0.25 mm tracks 0.15 mm apart, routed
        # together. The width follows the class so the router uses it.
        name = _pair_name(p)
        classes.append({"name": name, "track": 0.25, "clearance": 0.2,
                        "via": 0.6, "drill": 0.3, "nets": [p, n], "patterns": []})
        diff.append({"name": name, "p": p, "n": n, "width": 0.25, "gap": 0.15})

    return {
        "classes": classes,
        "pairs": diff,
        "board": {"layers": 2, "min_track": 0.15, "min_clearance": 0.15,
                  "min_via": 0.6, "min_drill": 0.3},
        "pours": [{"net": ground, "layers": ["F.Cu", "B.Cu"], "clearance": 0.3,
                   "connection": "solid"}] if ground else [],
        "route": {"passes": 40},
        "edited": False,
    }


def _pair_name(p: str) -> str:
    base = re.sub(r"(_p|_pos|\+|p)$", "", p, flags=re.I) or p
    return "USB" if base.lower() in ("d", "ud", "usb_d", "usb") else base.upper()


# What every field is, for the form in the board room and for an agent
# editing the JSON: the page draws its form from this, and
# `revisions.py board rules schema` prints it. A field added here shows up
# in both without either being taught about it.
LAYERS = ["F.Cu", "B.Cu"]
SCHEMA = {
    "classes": {
        "label": "Net classes", "list": True, "fixed": ["Default"],
        "help": "How wide a track, how far from its neighbours and what via, "
                "for a group of nets. Default holds every net no other class "
                "takes. A net goes in by name, or by a pattern such as usb_* "
                "that catches it on any board.",
        "new": {"name": "", "track": 0.25, "clearance": 0.2, "via": 0.6,
                "drill": 0.3, "nets": [], "patterns": []},
        "fields": [
            {"key": "name", "label": "Name", "type": "text"},
            {"key": "track", "label": "Track", "type": "number", "unit": "mm",
             "min": 0.1, "max": 5, "step": 0.01, "help": "track width"},
            {"key": "clearance", "label": "Gap", "type": "number", "unit": "mm",
             "min": 0.1, "max": 5, "step": 0.01,
             "help": "clearance to any other copper"},
            {"key": "via", "label": "Via", "type": "number", "unit": "mm",
             "min": 0.3, "max": 3, "step": 0.05, "help": "via pad diameter"},
            {"key": "drill", "label": "Drill", "type": "number", "unit": "mm",
             "min": 0.15, "max": 2, "step": 0.05, "help": "via hole diameter"},
            {"key": "nets", "label": "Nets", "type": "nets",
             "help": "nets in this class, by name"},
            {"key": "patterns", "label": "Patterns", "type": "patterns",
             "help": "shell-style name patterns (usb_*, v*v*); a net named "
                     "in a class stays there, the rest go to the first "
                     "class whose pattern matches"},
        ],
    },
    "pairs": {
        "label": "Differential pairs", "list": True,
        "help": "Two nets routed side by side at a set width and gap. "
                "Freerouting keeps the width and gap; it does not couple "
                "or length-match them - fine for USB full speed, not for "
                "anything fast.",
        "new": {"name": "", "p": "", "n": "", "width": 0.25, "gap": 0.15},
        "fields": [
            {"key": "name", "label": "Name", "type": "text"},
            {"key": "p", "label": "+", "type": "net", "help": "positive half"},
            {"key": "n", "label": "−", "type": "net", "help": "negative half"},
            {"key": "width", "label": "Width", "type": "number", "unit": "mm",
             "min": 0.1, "max": 2, "step": 0.01},
            {"key": "gap", "label": "Gap", "type": "number", "unit": "mm",
             "min": 0.1, "max": 2, "step": 0.01},
        ],
    },
    "pours": {
        "label": "Copper pours", "list": True,
        "help": "A net flooded over the whole board on the chosen layers, "
                "after routing. The first in the list wins where two meet.",
        "new": {"net": "", "layers": ["F.Cu", "B.Cu"], "clearance": 0.3,
                "connection": "solid"},
        "fields": [
            {"key": "net", "label": "Net", "type": "net"},
            {"key": "layers", "label": "Layers", "type": "layers",
             "options": LAYERS},
            {"key": "clearance", "label": "Gap", "type": "number", "unit": "mm",
             "min": 0.1, "max": 3, "step": 0.05},
            {"key": "connection", "label": "Pads", "type": "choice",
             "options": ["solid", "thermal"],
             "help": "solid: straight into the pour, what reflow wants; "
                     "thermal: spokes, easier to hand-solder"},
        ],
    },
    "board": {
        "label": "What the board house can make", "list": False,
        "help": "The smallest a feature may be. Every class is checked "
                "against these before the router runs.",
        "fields": [
            {"key": "min_track", "label": "Narrowest track", "type": "number",
             "unit": "mm", "min": 0.09, "max": 1, "step": 0.01},
            {"key": "min_clearance", "label": "Smallest gap", "type": "number",
             "unit": "mm", "min": 0.09, "max": 1, "step": 0.01},
            {"key": "min_via", "label": "Smallest via", "type": "number",
             "unit": "mm", "min": 0.25, "max": 2, "step": 0.05},
            {"key": "min_drill", "label": "Smallest drill", "type": "number",
             "unit": "mm", "min": 0.15, "max": 1.5, "step": 0.05},
        ],
    },
    "route": {
        "label": "Router", "list": False,
        "help": "How hard Freerouting tries.",
        "fields": [
            {"key": "passes", "label": "Passes", "type": "integer",
             "min": 1, "max": 500, "step": 1,
             "help": "optimisation passes; more is shorter copper and a longer run"},
        ],
    },
}


def normalise(rules: dict) -> dict:
    """Rules in today's shape: one `pour` became a list of `pours`, and a
    class without patterns has an empty list of them."""
    out = copy.deepcopy(rules)
    if "pours" not in out:
        old = out.pop("pour", None)
        out["pours"] = [old] if old else []
    out.pop("pour", None)
    for cls in out.setdefault("classes", []):
        cls.setdefault("nets", [])
        cls.setdefault("patterns", [])
    out.setdefault("pairs", [])
    return out


def members(rules: dict, nets: list[str]) -> dict[str, list[str]]:
    """Which nets each class holds once patterns are applied: named nets
    where they are named, then each remaining net to the first class with
    a pattern that matches it. Default gets nothing listed - it is the
    rest."""
    named = {n for c in rules.get("classes", []) for n in c.get("nets", [])}
    out = {c["name"]: list(c.get("nets", [])) for c in rules.get("classes", [])}
    for net in nets:
        if not net or net in named:
            continue
        for cls in rules.get("classes", []):
            if any(fnmatch.fnmatch(net.lower(), p.lower())
                   for p in cls.get("patterns", []) if p):
                out[cls["name"]].append(net)
                break
    return out


def resolved(rules: dict, nets: list[str]) -> dict:
    """What the router is handed: patterns turned into the nets they catch
    on this board, so the router only ever sees names."""
    out = normalise(rules)
    got = members(out, nets)
    for cls in out["classes"]:
        cls["nets"] = got.get(cls["name"], cls["nets"])
    # A pair takes its width from the class its nets are in. Left in
    # Default, it would widen every loose net on the board; so a pair
    # nobody put in a class gets one of its own, at the pair's width.
    held = {n for c in out["classes"] if c["name"] != "Default" for n in c["nets"]}
    default = next((c for c in out["classes"] if c["name"] == "Default"), DEFAULT)
    for pair in out["pairs"]:
        loose = [n for n in (pair["p"], pair["n"]) if n not in held]
        if loose:
            taken = {c["name"] for c in out["classes"]}
            out["classes"].append({
                "name": pair["name"] if pair["name"] not in taken else pair["name"] + " pair",
                "track": pair["width"],
                "clearance": max(pair["gap"], default.get("clearance", 0.2)),
                "via": default.get("via", 0.6), "drill": default.get("drill", 0.3),
                "nets": loose, "patterns": []})
            held |= set(loose)
    return out


def merge(saved: dict | None, nets: list[str]) -> dict:
    """The saved rules, brought up to date with the board's nets.

    Nets that are gone are dropped from their classes; nets that are new
    go where their names say. Everything a person set - widths, which net
    is in which class, the pairs - stays as they set it.
    """
    fresh = derive(nets)
    if not saved:
        return fresh
    out = normalise(saved)
    present = set(n for n in nets if n)
    classes = out.setdefault("classes", [])
    placed = set()
    for cls in classes:
        cls["nets"] = [n for n in cls.get("nets", []) if n in present]
        placed |= set(cls["nets"])

    # A net a person's pattern already catches is theirs, not the guess's.
    placed |= {n for got in members(out, list(present)).values() for n in got}
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
    kept = [p for p in out["pours"] if p.get("net") in present]
    # A board whose poured net has gone keeps a pour, on the new ground.
    out["pours"] = kept if kept or not out["pours"] else fresh["pours"]
    out.setdefault("board", fresh["board"])
    out.setdefault("route", fresh["route"])
    return out


def check(rules: dict, nets: list[str] | None = None) -> list[str]:
    """What is wrong with a set of rules before a router is given them.
    Each problem starts with where it is - `classes.Power.track:` - so a
    form can put it by the field and an agent can find it in the JSON."""
    rules = normalise(rules)
    out: list[str] = []
    known = set(nets) if nets is not None else None

    def number(where: str, section: str, key: str, value) -> None:
        field = next((f for f in SCHEMA[section]["fields"] if f["key"] == key), None)
        if field is None:
            return
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            out.append(f"{where}.{key}: not a number")
            return
        if field["type"] == "integer" and int(value) != value:
            out.append(f"{where}.{key}: a whole number")
        if value < field.get("min", float("-inf")) or value > field.get("max", float("inf")):
            out.append(f"{where}.{key}: {value} is outside "
                       f"{field['min']}-{field['max']} {field.get('unit', '')}".rstrip())

    def numbers(where: str, section: str, row: dict) -> None:
        for f in SCHEMA[section]["fields"]:
            if f["type"] in ("number", "integer") and f["key"] in row:
                number(where, section, f["key"], row[f["key"]])
            elif f["type"] in ("number", "integer"):
                out.append(f"{where}.{f['key']}: missing")

    b = rules.get("board", {})
    numbers("board", "board", b)
    numbers("route", "route", rules.get("route", {}))

    names = [c.get("name", "").strip() for c in rules["classes"]]
    if "Default" not in names:
        out.append("classes: there has to be a Default class")
    for i, cls in enumerate(rules["classes"]):
        name = cls.get("name", "").strip()
        where = f"classes.{name or '#' + str(i + 1)}"
        if not name:
            out.append(f"{where}.name: a class needs a name")
        elif names.count(name) > 1:
            out.append(f"{where}.name: two classes are called {name}")
        numbers(where, "classes", cls)
        if cls.get("track", 0) < b.get("min_track", 0):
            out.append(f"{where}.track: {cls['track']} mm is under the board's "
                       f"minimum {b['min_track']} mm")
        if cls.get("clearance", 0) < b.get("min_clearance", 0):
            out.append(f"{where}.clearance: {cls['clearance']} mm is under the "
                       f"minimum {b['min_clearance']} mm")
        if cls.get("via", 1) < b.get("min_via", 0):
            out.append(f"{where}.via: {cls['via']} mm is under the smallest via "
                       f"{b['min_via']} mm")
        if cls.get("drill", 1) < b.get("min_drill", 0):
            out.append(f"{where}.drill: {cls['drill']} mm is under the smallest "
                       f"drill {b['min_drill']} mm")
        if cls.get("drill", 0) >= cls.get("via", 1):
            out.append(f"{where}.drill: a {cls.get('drill')} mm drill in a "
                       f"{cls.get('via')} mm via leaves no copper")
        if known is not None:
            for net in cls.get("nets", []):
                if net not in known:
                    out.append(f"{where}.nets: {net} is not a net on this board")

    seen: dict[str, str] = {}
    for cls in rules["classes"]:
        for net in cls.get("nets", []):
            if net in seen:
                out.append(f"classes.{cls['name']}.nets: {net} is in both "
                           f"{seen[net]} and {cls['name']}")
            seen[net] = cls["name"]

    pair_names = [p.get("name", "").strip() for p in rules["pairs"]]
    for i, pair in enumerate(rules["pairs"]):
        name = pair.get("name", "").strip()
        where = f"pairs.{name or '#' + str(i + 1)}"
        if not name:
            out.append(f"{where}.name: a pair needs a name")
        elif pair_names.count(name) > 1:
            out.append(f"{where}.name: two pairs are called {name}")
        numbers(where, "pairs", pair)
        if not pair.get("p") or not pair.get("n"):
            out.append(f"{where}: pick both nets")
        elif pair["p"] == pair["n"]:
            out.append(f"{where}: the two halves are the same net")
        elif known is not None:
            for half in ("p", "n"):
                if pair[half] not in known:
                    out.append(f"{where}.{half}: {pair[half]} is not a net on this board")
        if pair.get("gap", 0) < b.get("min_clearance", 0):
            out.append(f"{where}.gap: {pair.get('gap')} mm is under the "
                       f"minimum clearance {b.get('min_clearance')} mm")

    for i, pour in enumerate(rules["pours"]):
        where = f"pours.{pour.get('net') or '#' + str(i + 1)}"
        if not pour.get("net"):
            out.append(f"{where}.net: pick the net to pour")
        elif known is not None and pour["net"] not in known:
            out.append(f"{where}.net: {pour['net']} is not a net on this board")
        layers = pour.get("layers", [])
        if not layers:
            out.append(f"{where}.layers: pour on at least one layer")
        for layer in layers:
            if layer not in LAYERS:
                out.append(f"{where}.layers: {layer} is not a layer here")
        if pour.get("connection", "solid") not in ("solid", "thermal"):
            out.append(f"{where}.connection: solid or thermal")
        numbers(where, "pours", pour)
    return out
