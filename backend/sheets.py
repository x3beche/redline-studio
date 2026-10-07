"""Which sheet of a board's schematic each part is drawn on.

A board is drawn as a hierarchy: a root sheet that only holds the boxes of
the others, one sheet per programmable chip (an MCU, a SoC, a wireless
module with a CPU in it) carrying the chip and the parts that serve only
it, a Power sheet, and a sheet for everything else. A board with several
MCUs gets a sheet - and later a firmware - per MCU; the Firmware room
opens on that sheet and reads the MCU's pin map from what is kept here.

A board with no MCU is not split: it stays one sheet, "Overview".

Everything here is decided from the parts' LCSC data (category, title,
maker's part number, pin names) and the netlist, so it is pure and
testable; backend/schematic.py gathers the data and tools/schematic_gen.py
draws what this decides.

What counts as an MCU's own parts ("support"):
  - a part with at most four pins (a resistor, a capacitor, a crystal, a
    button, a transistor, an LED) reached from the MCU through signal
    nets over other such parts, where every net it is on either touches
    the MCU and nothing but small parts, or stays among the MCU's own
    parts - a crystal and its load caps, an EN pull-up and its reset
    button, a status LED and its resistor. A pin shared with a connector,
    another IC or another MCU keeps the part off the sheet;
  - a capacitor straight between one of the MCU's supply rails and ground
    (decoupling) that sits in the MCU's own module - or, on a board drawn
    without modules, a small one (up to 1 uF) on a rail that only this
    MCU uses;
  - a USB-UART bridge (CH340, CP210x, FT232, ...) wired to this MCU's pins
    and no other MCU's, with its own crystal and caps, drawn as the MCU's
    programming circuit.
"""

from __future__ import annotations

import re
from collections import defaultdict

# ---------------------------------------------------------------- recognising

MCU_CATEGORY = re.compile(
    r"microcontroller|\bMCUs?\b|\bMPUs?\b|\bSoCs?\b|wi-?fi\s*modules?|bluetooth\s*modules?|"
    r"wireless\s*modules?|\bBLE\s*modules?|wi-?fi/bluetooth|zigbee\s*modules?", re.I)
MCU_NAME = re.compile(
    r"^(?:ESP32|ESP8266|ESP8285|ESP-?(?:WROOM|WROVER|C3|C6|S2|S3|12|07|01)|RP2040|RP2350|"
    r"STM32|STM8|ATMEGA|ATTINY|ATXMEGA|AT90|ATSAM|SAM[DLECGS]\d|CH32[VFXL]|CH55\d|CH57\d|"
    r"CH58\d|CH59\d|NRF5\d|NRF91|GD32|PIC1[0268]F|PIC24|PIC32|DSPIC|MSP430|EFM8|EFM32|EFR32|"
    r"LPC\d|MKL\d|AT32F|APM32|HC32|N76E|MM32|W80[016]|BL6\d\d|BL70\d|CC13\d\d|CC26\d\d|"
    r"PY32|HT32|TM4C|S32K|MIMXRT|IMXRT|RTL87|W600)", re.I)
# Pins an MCU has and hardly anything else does: GPIO12, IO0, PA3, PB10,
# P0_13, GP5 - with whatever alternate function follows a slash.
GPIO_PIN = re.compile(r"^(?:GPIO_?\d+|IO_?\d+|P[A-K]\d{1,2}|P\d[._]\d{1,2}|PIO\d_?\d+|GP\d+)(?:[/_ (].*)?$", re.I)
NOT_MCU_CATEGORY = re.compile(r"usb|interface|expander|logic|driver|power|memory|flash|eeprom", re.I)

BRIDGE_NAME = re.compile(r"^(?:CH340|CH341|CH342|CH343|CH344|CH9102|CH9340|CP210\d|FT232|FT231|"
                         r"FT230|FT2232|FT4232|PL2303)", re.I)
BRIDGE_CATEGORY = re.compile(r"usb[- ]?(?:to[- ])?uart|usb[- ]?serial", re.I)

POWER_CATEGORY = re.compile(
    r"dc-dc|ldo|voltage regulator|linear regulator|switching regulator|battery management|"
    r"power management|pmic|charger|load switch|power switch|power distribution|"
    r"battery (?:holder|clip|contact)", re.I)
POWER_NAME = re.compile(r"^(?:AMS1117|LM1117|AP2112|AP2125|XC6206|XC6210|ME6211|RT9013|RT9193|MCP1700|"
                        r"MCP1702|HT7[0-9]{3}|LM78|L78|TPS6|TPS7|TPS5|MT3608|TP4056|TP4054|BQ2|LM2596|"
                        r"SY8|MP1584|MP2|AP3|ETA|RT8|XL\d|IP5|LP29|LP59|NCP1117|SPX3819|TLV7)", re.I)
POWER_MODULE = re.compile(r"(?:^|[_\-.])(?:power|pwr|rails?|supply|supplies|psu|charger|charging|"
                          r"battery|batt|regulators?|ldo|buck|boost|vreg|pmic)(?:$|[_\-.\d])", re.I)
CONNECTOR_CATEGORY = re.compile(r"connector|header|socket|terminal|usb[- ]?c?\s*receptacle", re.I)
CONNECTOR_REF = re.compile(r"^(?:J|CN|CON|P|USB|HDR|JP)\d*$", re.I)

GROUND = re.compile(r"^(?:[ADPS]?GND[A-Z0-9_]*|GND|VSS[A-Z0-9_]*|0V|EARTH|CHASSIS|COM)$", re.I)
SUPPLY = re.compile(
    r"^(?:\+?\d+(?:\.\d+)?V\d*|\+?\d+V\d+|[+-]\d+(?:\.\d+)?V?|"
    r"\+?V(?:CC|DD|BUS|BAT|BATT|SYS|IN|MAIN|REG|PP|OUT|SUPPLY|USB|CHG|DC|EE|LED|MOT|M)(?:[_.]?[A-Z0-9]*)?|"
    r"\+?\d+(?:\.\d+)?V_?(?:IN|OUT|SYS|BAT|USB|A|D|MAIN|REG|AUX)|"
    r"BAT\+?|BATT\+?|BAT_?(?:IN|OUT|P|POS)|AVDD|DVDD|IOVDD|VDDA|VDDIO|VREF|V\+|V-)$", re.I)
NOT_RAIL = re.compile(r"_(?:EN|PG|OK|SENSE|SNS|FB|DET|ADC|MEAS|CTRL|ON|STAT)$", re.I)
SUPPLY_PIN = re.compile(r"^(?:GND\w*|AGND|DGND|PGND|VSS\w*|VCC\w*|VDD\w*|AVDD|DVDD|3V3|3\.3V|5V|VBUS|VBAT)$", re.I)
POWER_IC_PIN = re.compile(r"^(?:IN|OUT|VIN\d*|VOUT\d*|BAT|VBAT|SYS|VSYS|VBUS|VCC|VDD|SW|OUT\d)$", re.I)

SMALL = 4                         # a part with up to this many pins can be an MCU's support part
DECOUPLING_MAX_F = 1e-6           # on a board without modules, a decoupling cap is at most this


def _text(p: dict) -> str:
    return " ".join(str(p.get(k) or "") for k in ("title", "mpn", "name"))


def _names(p: dict) -> list[str]:
    return [n for n in (p.get("title"), p.get("mpn"), p.get("name")) if n]


def is_mcu(p: dict) -> bool:
    """A programmable chip: by LCSC's category, by the part's name, or -
    when neither says - by having GPIO pins the way only an MCU does."""
    cat = p.get("category") or ""
    if any(MCU_NAME.match(n.strip()) for n in _names(p)):
        return True
    if cat and MCU_CATEGORY.search(cat):
        return True
    if cat and NOT_MCU_CATEGORY.search(cat):
        return False
    if is_bridge(p) or is_power(p):
        return False
    pins = p.get("pins") or []
    gpio = sum(1 for pin in pins if GPIO_PIN.match((pin.get("name") or "").strip()))
    return len(pins) >= 16 and gpio >= 8


def is_bridge(p: dict) -> bool:
    return any(BRIDGE_NAME.match(n.strip()) for n in _names(p)) or \
        bool(BRIDGE_CATEGORY.search(p.get("category") or ""))


def is_power(p: dict) -> bool:
    return any(POWER_NAME.match(n.strip()) for n in _names(p)) or \
        bool(POWER_CATEGORY.search(p.get("category") or ""))


def is_connector(p: dict) -> bool:
    if CONNECTOR_CATEGORY.search(p.get("category") or ""):
        return True
    return bool(CONNECTOR_REF.match(p.get("ref") or ""))


def rail_name(name: str) -> bool:
    """Is this a ground or supply net, by its name? `power.3V3` is."""
    last = (name or "").rsplit(".", 1)[-1].strip()
    if not last or NOT_RAIL.search(last):
        return False
    return bool(GROUND.match(last) or SUPPLY.match(last))


def ground_name(name: str) -> bool:
    last = (name or "").rsplit(".", 1)[-1].strip()
    return bool(GROUND.match(last))


def farads(text: str | None) -> float | None:
    """100nF, 0.1u, 4u7, 10uF -> farads; None when it is not a capacitance."""
    t = (text or "").strip().replace("µ", "u").replace("μ", "u")
    m = re.match(r"^(\d+(?:\.\d+)?)\s*([pnum])\s*(\d*)\s*F?$", t, re.I) or \
        re.match(r"^(\d+(?:\.\d+)?)\s*()\s*()F$", t, re.I)
    if not m:
        return None
    whole = m.group(1) + ("." + m.group(3) if m.group(3) else "")
    scale = {"p": 1e-12, "n": 1e-9, "u": 1e-6, "m": 1e-3, "": 1.0}[m.group(2).lower()]
    return float(whole) * scale


def is_capacitor(p: dict) -> bool:
    return bool(re.match(r"^C\d+$", p.get("ref") or "")) or (p.get("kind") == "C")


# ---------------------------------------------------------------- the board as a graph

class Board:
    def __init__(self, parts: list[dict], nets: list[dict]):
        self.parts = {p["ref"]: p for p in parts}
        self.nets = {}                      # name -> [(ref, pin)]
        for net in nets:
            nodes = [(n["ref"], str(n["pin"])) for n in net.get("nodes", []) if n.get("ref") in self.parts]
            if net.get("name") and len(nodes) >= 2:
                self.nets[net["name"]] = nodes
        self.of = defaultdict(set)          # ref -> net names
        self.at = defaultdict(set)          # net -> refs
        for name, nodes in self.nets.items():
            for ref, _pin in nodes:
                self.of[ref].add(name)
                self.at[name].add(ref)
        self.rails = {n for n in self.nets if self._rail(n)}

    def _rail(self, name: str) -> bool:
        if rail_name(name):
            return True
        for ref, pin in self.nets[name]:
            p = self.parts[ref]
            pname = next((x.get("name") or "" for x in p.get("pins") or [] if str(x.get("number")) == pin), "")
            if SUPPLY_PIN.match(pname.strip()):
                return True
            if is_power(p) and POWER_IC_PIN.match(pname.strip()) and pname.strip().upper() != "SW":
                return True
        return False

    def signals(self, ref: str) -> set[str]:
        return {n for n in self.of[ref] if n not in self.rails}

    def pin_count(self, ref: str) -> int:
        p = self.parts[ref]
        pins = p.get("pins") or []
        if pins:
            return len({str(x.get("number")) for x in pins})
        return len({pin for n in self.of[ref] for r, pin in self.nets[n] if r == ref}) or 2

    def small(self, ref: str, mcus: set[str]) -> bool:
        p = self.parts[ref]
        return (ref not in mcus and not is_connector(p) and not is_power(p) and not is_bridge(p)
                and self.pin_count(ref) <= SMALL)


def _cluster(board: Board, core: set[str], mcus: set[str], taken: set[str]) -> set[str]:
    """The small parts that serve `core` and nothing else (module docstring)."""
    small = {r for r in board.parts if r not in taken and r not in core and board.small(r, mcus)}
    found, todo = set(), [n for c in core for n in board.signals(c)]
    seen_nets = set()
    while todo:
        net = todo.pop()
        if net in seen_nets:
            continue
        seen_nets.add(net)
        for ref in board.at[net]:
            if ref in small and ref not in found:
                found.add(ref)
                todo.extend(board.signals(ref))
    while True:
        keep = set()
        for ref in found:
            ok = True
            for net in board.signals(ref):
                others = board.at[net] - {ref}
                if others & core:
                    ok = all(o in core or o in small for o in others)
                else:
                    ok = others <= (found | core)
                if not ok:
                    break
            if ok:
                keep.add(ref)
        if keep == found:
            return found
        found = keep


def _talks_to(board: Board, a: str, b: str) -> bool:
    """Are two parts wired to each other directly, or through one two-pin part?"""
    sa, sb = board.signals(a), board.signals(b)
    if sa & sb:
        return True
    for net in sa:
        for mid in board.at[net] - {a, b}:
            if board.pin_count(mid) == 2 and board.signals(mid) & sb:
                return True
    return False


def _decoupling(board: Board, mcu: str, others: list[str], taken: set[str], grouped: bool) -> set[str]:
    """Capacitors straight between this MCU's supply and ground."""
    m = board.parts[mcu]
    supply = {n for n in board.of[mcu] if n in board.rails and not ground_name(n)}
    out = set()
    for ref, p in board.parts.items():
        if ref in taken or ref == mcu or not is_capacitor(p) or board.pin_count(ref) != 2:
            continue
        nets = board.of[ref]
        if len(nets) != 2 or not all(n in board.rails for n in nets):
            continue
        if not any(ground_name(n) for n in nets) or not (nets & supply):
            continue
        if grouped:
            if p.get("group") and p.get("group") == m.get("group"):
                out.add(ref)
        else:
            rail = next(iter(nets & supply))
            sharing = [o for o in others if rail in board.of[o]]
            f = farads(p.get("value"))
            if not sharing and f is not None and f <= DECOUPLING_MAX_F:
                out.add(ref)
    return out


# ---------------------------------------------------------------- the split

def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-") or "sheet"


def sheet_title(p: dict) -> str:
    """`U1 · ESP32-WROOM-32E`: the ref and what the part is."""
    what = (p.get("title") or p.get("mpn") or p.get("part") or "").strip()
    return f"{p['ref']} · {what}" if what else p["ref"]


def split(parts: list[dict], nets: list[dict]) -> dict:
    """Decide the sheets.

    `parts`: [{ref, part, group, title, mpn, category, value, pins:
    [{number, name}]}]; `nets`: the netlist's [{name, nodes: [{ref, pin}]}].

    Returns {"sheets": [{key, name, file, kind, refs, mcu?}], "assign":
    {ref: sheet key}, "groups": {ref: group shown on its sheet},
    "mcus": [{ref, part, title, sheet, pins}]}. One sheet, "Overview",
    when the board has no MCU.
    """
    board = Board(parts, nets)
    mcus = [r for r, p in board.parts.items() if is_mcu(p)]
    mcus.sort(key=_ref_order)
    if not mcus:
        return {"sheets": [{"key": "overview", "name": "Overview", "file": "board.kicad_sch",
                            "kind": "overview", "refs": sorted(board.parts, key=_ref_order)}],
                "assign": {r: "overview" for r in board.parts},
                "groups": {r: p.get("group") or "" for r, p in board.parts.items()},
                "global_nets": [], "mcus": []}

    mcu_set = set(mcus)
    grouped = any(p.get("group") for p in board.parts.values())
    claims: dict[str, set[str]] = defaultdict(set)      # part -> MCUs claiming it
    role: dict[tuple[str, str], str] = {}

    for m in mcus:
        own = _cluster(board, {m}, mcu_set, set())
        own |= _decoupling(board, m, [o for o in mcus if o != m], set(), grouped)
        for r in own:
            claims[r].add(m)
            role[(m, r)] = "mcu"
        bridges = [r for r, p in board.parts.items()
                   if is_bridge(p) and r not in mcu_set and _talks_to(board, r, m)
                   and not any(_talks_to(board, r, o) for o in mcus if o != m)]
        if bridges:
            prog = _cluster(board, {m, *bridges}, mcu_set, set()) - own
            for r in [*bridges, *prog]:
                claims[r].add(m)
                role.setdefault((m, r), "usb-uart")

    assign: dict[str, str] = {}
    groups: dict[str, str] = {}
    keys = {}
    for m in mcus:
        keys[m] = "mcu-" + _slug(m)
        assign[m] = keys[m]
        groups[m] = "mcu"
    for r, who in claims.items():
        if len(who) == 1 and r not in mcu_set:
            m = next(iter(who))
            assign[r] = keys[m]
            groups[r] = role[(m, r)]

    # Power: the power modules, the power ICs and the small parts that
    # serve only them, anything wired to nothing but rails, power inputs.
    left = [r for r in board.parts if r not in assign]
    power = set()
    for r in left:
        p = board.parts[r]
        if (p.get("group") and POWER_MODULE.search(p["group"])) or is_power(p):
            power.add(r)
    power_ics = {r for r in power if is_power(board.parts[r])}
    if power_ics:
        power |= _cluster(board, power_ics, mcu_set, set(assign))
    # A part in a module of its own (an OLED's caps) stays with that
    # module; one in none goes by its wiring.
    free = [r for r in left if r not in power and not board.parts[r].get("group")]
    for r in free:
        sig = board.signals(r)
        if board.of[r] and not sig:
            power.add(r)                 # every pin on a rail: bulk caps, a fuse, a power jack
    # Small parts wired only among themselves and to rails: a power LED and its resistor.
    loose = {r for r in free if r not in power and board.small(r, mcu_set)}
    for r in loose:
        if all(board.at[n] <= loose | power for n in board.signals(r)) and \
                any(n in board.rails for n in board.of[r]):
            power.add(r)

    for r in left:
        if r in power:
            assign[r] = "power"
        else:
            assign[r] = "periph"
        groups[r] = board.parts[r].get("group") or ""

    sheets = []
    for m in mcus:
        p = board.parts[m]
        sheets.append({"key": keys[m], "name": sheet_title(p), "file": f"{keys[m]}.kicad_sch",
                       "kind": "mcu", "mcu": m,
                       "refs": sorted([r for r, k in assign.items() if k == keys[m]], key=_ref_order)})
    for key, name, kind in (("power", "Power", "power"),
                            ("periph", "Connectors & peripherals", "peripherals")):
        refs = sorted([r for r, k in assign.items() if k == key], key=_ref_order)
        if refs:
            sheets.append({"key": key, "name": name, "file": f"{key}.kicad_sch", "kind": kind,
                           "refs": refs})
    _unique_names(sheets)

    return {"sheets": sheets, "assign": assign, "groups": groups,
            "global_nets": crossing(board, assign),
            "mcus": [mcu_record(board, m, keys[m], next(s["name"] for s in sheets if s["key"] == keys[m]))
                     for m in mcus]}


def crossing(board: Board, assign: dict[str, str]) -> list[str]:
    """The nets drawn on more than one sheet: these get global labels, the
    rest local ones."""
    return sorted(n for n, refs in board.at.items() if len({assign.get(r) for r in refs}) > 1)


def _unique_names(sheets: list[dict]) -> None:
    seen: dict[str, int] = {}
    for s in sheets:
        n = seen.get(s["name"], 0)
        seen[s["name"]] = n + 1
        if n:
            s["name"] = f"{s['name']} ({n + 1})"


def _ref_order(ref: str):
    m = re.match(r"^([A-Za-z_]*)(\d*)(.*)$", ref or "")
    return (m.group(1), int(m.group(2)) if m.group(2) else -1, m.group(3))


def mcu_record(board: Board, ref: str, key: str, name: str) -> dict:
    """What a Firmware room needs of one MCU: which pin is on which net
    and what else is on it."""
    p = board.parts[ref]
    by_pin = {}
    for net in board.of[ref]:
        for r, pin in board.nets[net]:
            if r == ref:
                by_pin[pin] = net
    pins = []
    listed = p.get("pins") or [{"number": n, "name": ""} for n in sorted(by_pin)]
    for pin in sorted(listed, key=lambda x: _pin_order(str(x.get("number")))):
        number = str(pin.get("number"))
        net = by_pin.get(number)
        pins.append({"number": number, "name": pin.get("name") or "", "net": net,
                     "parts": sorted(board.at[net] - {ref}, key=_ref_order) if net else []})
    return {"ref": ref, "part": p.get("part"), "title": p.get("title") or p.get("mpn") or "",
            "sheet": name, "key": key, "file": f"{key}.kicad_sch", "pins": pins}


def _pin_order(n: str):
    return (0, int(n), "") if n.isdigit() else (1, 0, n)
