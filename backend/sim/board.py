"""sim.json (SPEC section 4) from a Redline board netlist.

graph: {"components": [{"ref", "value", "footprint", "part", "where"}],
        "nets": [{"name", "code", "nodes": [{"ref", "pin"}]}]}
mcu_pins: {package pin number: MCU pin name}, e.g. {"25": "GPIO0"}.
"""

from __future__ import annotations

import re

LCSC = re.compile(r"\bC\d{3,}\b")
GROUND = re.compile(r"(?i)^(a|d|p)?gnd\w*$|^vss$|^0v$|^ground$")
SUPPLY = re.compile(r"(?i)^(\+?\d+(\.\d+)?v\d*|\d+v\d+|vcc\w*|vdd\w*|v3v3|3v3|vbus|vbat|vin|bat\+)$")
POWER = re.compile(r"(?i)(^|[-_/.+])(gnd|agnd|vcc|vdd|vbus|vin|3v3|5v|12v|hv|lv)($|[-_/.])")  # rails: never followed through a resistor


def _first(items, f):
    return next((y for y in map(f, items) if y), None)


def _text(c: dict) -> str:
    return " ".join(str(c.get(k) or "") for k in ("ref", "value", "footprint", "part"))


def _matches(c: dict, rule: dict) -> bool:
    found = set(LCSC.findall(f"{c.get('part') or ''} {c.get('value') or ''}"))
    return bool(found & set(rule.get("lcsc") or [])) \
        or bool(rule.get("footprint") and re.search(rule["footprint"], c.get("footprint") or "")) \
        or bool(rule.get("text") and re.search(rule["text"], _text(c)))


def describe(graph: dict, mcu_pins: dict, catalog: dict) -> dict:
    comps = {c["ref"]: c for c in graph.get("components", [])}
    net_of, nodes = {}, {}                       # (ref, pad) -> net name; net name -> nodes
    for net in graph.get("nets", []):
        nodes[net["name"]] = net.get("nodes") or []
        for nd in nodes[net["name"]]:
            net_of[(nd["ref"], str(nd["pin"]))] = net["name"]
    pads = {}
    for ref, pad in net_of:
        pads.setdefault(ref, []).append(pad)

    mcu_ref, mcu = next(((c["ref"], m) for c in comps.values() for m in catalog.get("mcus", [])
                         if _matches(c, m["match"])), (None, None))
    if mcu_ref is None:
        raise ValueError("no MCU the simulator knows on this board")
    part = comps[mcu_ref]
    out = {"mcu": {"part": next(iter(LCSC.findall(_text(part))), part.get("part") or part.get("value")),
                   "family": mcu["family"], "emulator": mcu["emulator"]},
           "parts": [], "skipped": []}

    def on_mcu(net):
        if net is None or GROUND.match(net) or SUPPLY.match(net) or POWER.match(net):
            return None                          # the MCU's own supply is no signal
        pad = next((str(n["pin"]) for n in nodes.get(net, []) if n["ref"] == mcu_ref), None)
        return None if pad is None else mcu_pins.get(pad, pad)

    def reach(net, me):
        """The MCU pin a net lands on, directly or through one 2-pad series resistor."""
        if net is None or POWER.match(net):
            return None
        if hit := on_mcu(net):
            return hit
        for n in nodes.get(net, []):
            r = n["ref"]
            if r != me and re.match(catalog.get("series", r"^R\d+$"), r) and len(pads.get(r, [])) == 2:
                other = next(p for p in pads[r] if p != str(n["pin"]))
                if hit := on_mcu(net_of[(r, other)]):
                    return hit
        return None

    buses: dict = {}
    for ref, c in comps.items():
        if ref == mcu_ref:
            continue
        name, model = next(((k, m) for k, m in catalog["models"].items() if _matches(c, m["match"])),
                           (None, None))
        if model is None:
            code = next(iter(LCSC.findall(_text(c))), None) or c.get("value") or c.get("footprint")
            out["skipped"].append({"ref": ref, "why": f"no model for {code}"})
            continue
        mine = {pad: net_of[(ref, pad)] for pad in pads.get(ref, [])}
        pins = {}
        for role, tries in (model.get("roles") or {}).items():
            nets = [mine.get(str(p)) for p in tries]
            if model.get("bus") == "i2c":        # a net named SDA/SCL beats pad numbers
                named = [n for n in mine.values() if role.lower() in (n or "").lower()]
                hit = _first(named + nets, on_mcu)
            else:
                hit = _first(nets, lambda n: reach(n, ref))
            if hit:
                pins[role] = hit
        entry = {"ref": ref, "model": name}
        if model.get("polar") and pins:
            # A LED's ends by what the other one reaches, not by pad
            # numbers - LCSC parts put the anode on pad 1 or pad 2. Other end
            # on ground: the MCU drives the anode; on a supply: the cathode.
            hit = next(iter(pins.values()))
            here = next(p for p, n in mine.items() if reach(n, ref) == hit)
            far = next((n for p, n in mine.items() if p != here), None)
            if far and SUPPLY.match(far):
                pins = {"K": hit}
            else:
                pins = {"A": hit}
                if not (far and GROUND.match(far)):
                    entry["dead"] = (f"its other end is on net {far}, which reaches neither ground "
                                     f"nor a supply - it cannot light on the real board")
                    out.setdefault("warnings", []).append(f"{ref}: {entry['dead']}")
        if model.get("bus") == "i2c":
            if not {"SDA", "SCL"} <= pins.keys():
                out["skipped"].append({"ref": ref, "why": f"{name}: SDA/SCL not wired to the MCU"})
                continue
            key = (pins["SDA"], pins["SCL"])
            entry.update(bus=buses.setdefault(key, f"I2C{len(buses)}"), addr=model["addr"], pins=pins)
        elif pins:
            entry["pins"] = pins
        else:
            out["skipped"].append({"ref": ref, "why": f"{name}: not wired to the MCU"})
            continue
        out["parts"].append(entry)
    return out


async def mcu_pin_names(db, lcsc_id: str) -> dict:
    """{package pin number: pin name} from the part's LCSC symbol - the same read as
    `tools/revisions.py part pins`. ESP32 modules draw GPIOs as IO18; SPEC names them GPIO18.
    `db` is taken for symmetry with the rest of the backend; the symbol cache is lcsc's own."""
    from backend import lcsc
    return {p["number"]: re.sub(r"^IO(\d+)$", r"GPIO\1", p["name"]) for p in await lcsc.pins(lcsc_id)}
