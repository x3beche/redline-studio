"""An imported board, written back as atopile source.

An import (backend/imports/) knows what a board *is* - which pad meets
which, where every part sits, the outline - but not what it is *made of*
in a form Redline can change: there is no source, so nothing can be
built, edited or handed to an agent. This writes that source.

What it keeps, and how it proves it:

* **the nets, pad for pad.** Every multi-pad net of the imported netlist
  becomes one net in the source, under its own name (`override_net_name`
  - "3.3V" and "BAT+" stay "3.3V" and "BAT+"), and every pad is wired by
  its number on the footprint. After the build, `equivalence()` compares
  the two netlists as sets of (ref, pad) pairs; that comparison, not the
  writing, is what says the conversion is right.
* **the parts' designators** (`designator = "U2"`), so a note on U2 is
  still about U2, and the placement still fits.
* **where every part sits, and the outline.** The board is marked `hold`:
  the placer puts each footprint where its pads were in the Gerbers'
  netlist instead of packing the board again (docker/place.py).

What it cannot know, and says so: which part was bought. A BOM says it
(`bom` below). Without one, a part is *guessed* - a resistor or capacitor
from backend/passives.json by its size (its value too, when the BOM has
one; a placeholder when not), anything else found by its footprint name or
picked by whoever runs this - and every guess is marked `# GUESSED` in the
source and listed in the report. A guess is checked as far as data can
check it: the part's own EasyEDA footprint has to carry every pad the
netlist uses, and its land pattern is laid over the Gerber's pads and the
worst distance reported.

Nothing about the design is corrected on the way. A net that looks wrong
is kept as it is and listed under findings.
"""

from __future__ import annotations

import io
import json
import math
import re
import zipfile
from collections import defaultdict

from . import lcsc

# EasyEDA's footprint unit: ten mil.
UNIT = 0.254

# A passive by footprint name: R0603, C0402, 0805 ...
PASSIVE_FOOTPRINT = re.compile(r"^(R|C)[_-]?(0402|0603|0805|1206)(?:[_-].*)?$", re.I)
PASSIVE_REF = re.compile(r"^(R|C)\d+$")
# Pad centre to pad centre, per size, as EasyEDA and KiCad draw them.
PITCH = {"0402": (0.85, 1.15), "0603": (1.3, 1.7), "0805": (1.75, 2.2), "1206": (2.8, 3.4)}
# What a resistor or capacitor is when nobody said: a placeholder, marked.
PLACEHOLDER = {"R": "10k", "C": "100n"}

# Words atopile keeps for itself.
KEYWORDS = {"component", "module", "interface", "signal", "pin", "new", "from",
            "import", "assert", "within", "to", "pass", "as", "True", "False"}

# What a block does, from the names of the nets it touches.
FUNCTIONS = [
    ("usb_serial", r"USB|UD[PN]|_D[PN]$|^D[PN]$|UART|TXD|RXD|^XI$|^XO$|DTR|RTS|ESP_RX|ESP_TX"),
    ("power", r"BAT|CHRG|PGOO?D|VBUS|VIN|VOUT|VSYS|^L\d|^\d+(\.\d+)?V|_EN$"),
    ("oled", r"OLED|SCL|SDA|L_RST|RES"),
    ("fan", r"FAN|PWM"),
    ("buttons", r"BTN|ENC|KEY|SW"),
    ("mcu", r"ESP|^IO\d|GPIO|MCU|EN$"),
]


# ---------------- what the import knows ----------------

def pad_table(graph: dict, pads: list[dict] | None) -> dict[str, dict[str, tuple | None]]:
    """ref -> {pad: (x, y) or None}: every pad a part has, from the probe
    file's pad list where there is one and from the netlist in any case.
    Through-hole pads come twice in the probe file (one per side); they
    are one pad."""
    out: dict[str, dict] = defaultdict(dict)
    for p in pads or []:
        out[p["ref"]].setdefault(str(p["pin"]), (float(p["x"]), float(p["y"])))
    for net in graph.get("nets", []):
        for n in net.get("nodes", []):
            out[n["ref"]].setdefault(str(n["pin"]), None)
    for c in graph.get("components", []):
        out.setdefault(c["ref"], {})
    return dict(out)


def net_of(graph: dict) -> dict[tuple[str, str], str]:
    """(ref, pad) -> net name, for the nets that join two pads or more.
    A net of one pad is an unconnected pin, and stays one."""
    out = {}
    for net in graph.get("nets", []):
        nodes = {(n["ref"], str(n["pin"])) for n in net.get("nodes", [])}
        if len(nodes) >= 2:
            for node in nodes:
                out[node] = net["name"]
    return out


def bom_from(sources: bytes | None, extra: bytes | None) -> tuple[dict, str | None]:
    """ref -> {footprint, value, part} from a BOM CSV: the one given now,
    else one that came with the upload. Says which file it was."""
    from .imports import detect, parts

    if extra:
        return parts.parse_bom(extra), "bom.csv (added to the board)"
    if not sources:
        return {}, None
    try:
        with zipfile.ZipFile(io.BytesIO(sources)) as z:
            files = [(n, z.read(n)) for n in z.namelist() if not n.endswith("/")]
    except zipfile.BadZipFile:
        return {}, None
    for item in detect.sort_upload(files):
        if item.kind == detect.BOM:
            got = parts.parse_bom(item.data)
            if got:
                return got, item.name
    return {}, None


# ---------------- land patterns ----------------

def footprint_pads(component: dict) -> tuple[str, dict[str, list[tuple]]]:
    """An EasyEDA part's footprint: its title, and pad number -> centres in
    mm (y up, as the Gerbers have it). A number can name several pads - a
    connector's shell - so each number keeps a list."""
    pkg = component.get("packageDetail") or {}
    out: dict[str, list] = defaultdict(list)
    for shape in (pkg.get("dataStr") or {}).get("shape") or []:
        if not shape.startswith("PAD~"):
            continue
        f = shape.split("~")
        try:
            x, y, number = float(f[2]), float(f[3]), f[8].strip()
        except (IndexError, ValueError):
            continue
        if number:
            out[number].append((x * UNIT, -y * UNIT))
    return pkg.get("title") or "", dict(out)


def _rigid(src: list[tuple], dst: list[tuple]) -> tuple[float, tuple, tuple]:
    """The turn (radians) and shift that lay `src` over `dst` best, least
    squares: the 2-D Kabsch. Returns (angle, src centre, dst centre)."""
    n = len(src)
    sx = sum(p[0] for p in src) / n
    sy = sum(p[1] for p in src) / n
    dx = sum(p[0] for p in dst) / n
    dy = sum(p[1] for p in dst) / n
    a = b = 0.0
    for (x0, y0), (x1, y1) in zip(src, dst):
        x0, y0, x1, y1 = x0 - sx, y0 - sy, x1 - dx, y1 - dy
        a += x0 * x1 + y0 * y1
        b += x0 * y1 - y0 * x1
    return math.atan2(b, a), (sx, sy), (dx, dy)


def land_fit(fp: dict[str, list[tuple]], board: dict[str, tuple | None],
             mirror: bool = False) -> dict:
    """Lay a footprint's pads over the board's, by pad number.

    The turn and shift come from the pads whose number is unique on both
    sides; then every board pad is measured against the nearest footprint
    pad of its number. `worst_mm` is the answer: 0.05 mm is the same land
    pattern, a millimetre is not.
    """
    where = {k: v for k, v in board.items() if v is not None}
    if mirror:
        fp = {k: [(-x, y) for x, y in v] for k, v in fp.items()}
    missing = sorted(k for k in board if k not in fp)
    extra = sorted(k for k in fp if k not in board)
    pairs = [(fp[k][0], where[k]) for k in where if k in fp and len(fp[k]) == 1]
    if len(pairs) < 2:
        return {"matched": len(pairs), "of": len(board), "worst_mm": None,
                "angle": None, "missing": missing, "extra": extra}
    angle, (sx, sy), (dx, dy) = _rigid([p for p, _ in pairs], [q for _, q in pairs])
    c, s = math.cos(angle), math.sin(angle)

    def put(p):
        x, y = p[0] - sx, p[1] - sy
        return (x * c - y * s + dx, x * s + y * c + dy)

    worst, matched = 0.0, 0
    for k, q in where.items():
        if k not in fp:
            continue
        worst = max(worst, min(math.dist(put(p), q) for p in fp[k]))
        matched += 1
    return {"matched": matched, "of": len(board), "worst_mm": round(worst, 3),
            "angle": round(math.degrees(angle) % 360, 1), "missing": missing, "extra": extra}


def pitch_size(board: dict[str, tuple | None]) -> str | None:
    """A two-pad SMD part's size, from how far apart its pads are."""
    pts = [p for p in board.values() if p is not None]
    if len(board) != 2 or len(pts) != 2:
        return None
    d = math.dist(*pts)
    return next((size for size, (lo, hi) in PITCH.items() if lo <= d <= hi), None)


# ---------------- which part each one is ----------------

class Part:
    """What one designator is decided to be, and on what evidence."""

    def __init__(self, ref: str):
        self.ref = ref
        self.lcsc: str | None = None
        self.how = ""                 # bom | bom-value | pick | placeholder | search | table
        self.guessed = True
        self.why = ""
        self.name = ""                # the component block it uses
        self.footprint = ""
        self.passive: tuple | None = None    # (kind, value, size) from the table
        self.pins: list[dict] = []    # [{number, name}]
        self.land: dict | None = None
        self.added_pins: list[str] = []
        self.problems: list[str] = []
        self.notes: list[str] = []

    def report(self) -> dict:
        return {"ref": self.ref, "lcsc": self.lcsc, "how": self.how, "guessed": self.guessed,
                "why": self.why, "component": self.name, "footprint": self.footprint,
                "land": self.land, "added_pins": self.added_pins, "problems": self.problems,
                "notes": self.notes}


def _passive_part(p: Part, kind: str, value: str | None, size: str, how: str,
                  guessed: bool, why: str) -> bool:
    row = lcsc.passive(kind, value or PLACEHOLDER[kind], size)
    if not row and value is None:
        return False
    if not row:
        # A value the table does not hold: the placeholder, and say so.
        row = lcsc.passive(kind, PLACEHOLDER[kind], size)
        if not row:
            return False
        why += f"; {value} is not in backend/passives.json - a placeholder stands in"
        guessed = True
        how = "placeholder"
    _, v, s = row["key"].split(" ")
    p.lcsc, p.passive, p.how, p.guessed = row["lcsc"], (kind, v, s), how, guessed
    p.why = why
    p.footprint = f"{kind}{s}"
    p.name = f"{kind}_{re.sub(r'[^A-Za-z0-9]', '_', v)}_{s}" + (
        "_GUESSED" if guessed and value is None else "")
    p.pins = [{"number": "1", "name": "p1"}, {"number": "2", "name": "p2"}]
    return True


async def _patient(fn, *args):
    """An LCSC ask that rides out the network dropping for a moment. A
    refusal is not that: it stops the asking, as everywhere else."""
    import asyncio
    for attempt in range(4):
        try:
            return await fn(*args)
        except lcsc.Refused:
            raise
        except OSError:
            if attempt == 3:
                raise
            await asyncio.sleep(5 * (attempt + 1))


async def _lcsc_part(p: Part, code: str, board_pads: dict, want_title: str | None) -> dict:
    """Look at one candidate part: its symbol's pins, its footprint, how its
    land pattern lies over the board's pads. Nothing is decided here."""
    comp = await _patient(lcsc._component, code)
    title, fp = footprint_pads(comp)
    pins = await lcsc.pins(code)
    fit = land_fit(fp, board_pads)
    para = ((comp.get("dataStr") or {}).get("head") or {}).get("c_para") or {}
    return {"code": code, "title": title, "fp": fp, "pins": pins, "fit": fit,
            "mpn": para.get("Manufacturer Part") or comp.get("title") or code,
            "maker": para.get("Manufacturer") or "?",
            "same_footprint": bool(want_title) and title == want_title}


def _take(p: Part, look: dict, how: str, guessed: bool, why: str) -> None:
    p.lcsc, p.how, p.guessed, p.why = look["code"], how, guessed, why
    p.footprint = look["title"]
    p.name = _ident(look["mpn"])
    p.land = look["fit"]
    numbers = {pin["number"] for pin in look["pins"]}
    p.pins = list(look["pins"])
    # A pad the footprint has and the symbol does not - an exposed pad, a
    # shell - is still a pad the netlist can put on a net. It is added under
    # its number, and said.
    for pad in sorted(look["fp"]):
        if pad not in numbers:
            p.pins.append({"number": pad, "name": f"PAD{pad}"})
            p.added_pins.append(pad)
    wired = look.get("wired") or set()
    lost = [x for x in look["fit"]["missing"] if x in wired]
    spare = [x for x in look["fit"]["missing"] if x not in wired]
    if lost:
        p.problems.append("pads on a net that this part's footprint does not have: "
                          + ", ".join(lost))
    if spare:
        p.notes.append("pads on no net that this part's footprint does not have: "
                       + ", ".join(spare))
    worst = look["fit"].get("worst_mm")
    if worst is not None and worst > 0.3:
        p.problems.append(f"its land pattern is {worst} mm off the board's pads - "
                          "probably not the same footprint")


DIMENSION = re.compile(r"^(L|W|P|LS|H|D)\d|^\d+[XxPp](\d|-|$)|^[A-Z]+$|^\d+$")


def _search_term(footprint: str) -> str | None:
    """What to look a footprint's part up by. EasyEDA names a footprint
    family_size_part: `IND-SMD_L4.0-W4.0_XAL4040-103`. An LCSC number in
    the name wins; then the longest piece after the family that is not a
    size (`L4.0-W4.0`, `1X4`, `2P-P2.50`) or a colour (`RED`). A name that
    is only sizes names no part."""
    m = re.search(r"\b(C\d{3,10})\b", footprint.replace("_", " "))
    if m:
        return m.group(1)
    pieces = [x for x in footprint.split("_")[1:] if x and not DIMENSION.match(x)]
    return max(pieces, key=len) if pieces else None


async def identify(graph: dict, pads: dict[str, dict], bom: dict, picks: dict,
                   footprints: dict[str, str | None]) -> tuple[list[Part], list[str]]:
    """Each designator's part, in order: the BOM's LCSC number; a pick
    (`picks`: ref -> C-number, from whoever ran the conversion); the
    passives table by size and the BOM's value; a search by footprint
    name. What none of them settles is returned as unresolved."""
    found: list[Part] = []
    unresolved: list[str] = []
    looked: dict[str, dict] = {}
    searched: dict[str, list] = {}

    async def look(code: str, ref: str) -> dict:
        key = f"{code}:{ref}"
        if key not in looked:
            looked[key] = await _lcsc_part(Part(ref), code, pads.get(ref, {}), footprints.get(ref))
            looked[key]["wired"] = wired_pads[ref]
        return looked[key]

    wired_pads: dict[str, set] = defaultdict(set)
    for ref, pad in net_of(graph):
        wired_pads[ref].add(pad)

    for comp in graph.get("components", []):
        ref = comp["ref"]
        p = Part(ref)
        fp_name = footprints.get(ref) or ""
        row = bom.get(ref) or {}
        board_pads = pads.get(ref, {})
        bom_part = row.get("part") if lcsc.looks_like_a_part(row.get("part")) else None
        pick = picks.get(ref)
        m = PASSIVE_FOOTPRINT.match(fp_name) or PASSIVE_FOOTPRINT.match(row.get("footprint") or "")
        kind = m.group(1).upper() if m else None
        size = m.group(2) if m else None
        if not m and PASSIVE_REF.match(ref) and pitch_size(board_pads):
            kind, size = ref[0].upper(), pitch_size(board_pads)

        if bom_part:
            got = await look(bom_part, ref)
            _take(p, got, "bom", False, "LCSC number from the BOM")
        elif pick:
            got = await look(pick["lcsc"], ref)
            _take(p, got, "pick", True, pick.get("why") or "picked by hand, not from a BOM")
        elif kind and size:
            value = row.get("value")
            how = "bom-value" if value else "placeholder"
            why = (f"{kind} {size}: value {value} from the BOM, part from backend/passives.json"
                   if value else
                   f"{kind} {size} from the footprint; the value is not known (no BOM) - "
                   f"{PLACEHOLDER[kind]} is a placeholder")
            if not _passive_part(p, kind, value, size, how, not value, why):
                unresolved.append(f"{ref}: a {kind} {size} the passives table has no row for")
                continue
            if not fp_name:
                p.why += f" (size from the pads' pitch)"
        elif fp_name and _search_term(fp_name):
            term = _search_term(fp_name)
            chosen = None
            try:
                if lcsc.looks_like_a_part(term):
                    rows = [{"lcsc": term}]
                else:
                    if term not in searched:
                        searched[term] = sorted(await _patient(lcsc.search, term, 10),
                                                key=lambda r: -(r.get("stock") or 0))
                    rows = searched[term]
                for r in rows[:4]:
                    got = await look(r["lcsc"], ref)
                    if got["same_footprint"] and not set(got["fit"]["missing"]) & wired_pads[ref]:
                        chosen = got
                        break
            except (LookupError, ValueError) as exc:
                p.problems.append(str(exc))
            if not chosen:
                unresolved.append(f"{ref}: nothing on LCSC under '{term}' has the footprint "
                                  f"{fp_name} - pick one (--part {ref}=C...)")
                continue
            _take(p, chosen, "search", True,
                  f"found by the footprint's name ('{term}'); the part on LCSC that uses "
                  f"exactly {fp_name}")
        else:
            unresolved.append(f"{ref}: " + (f"footprint {fp_name} names no part"
                                            if fp_name else "no footprint, value or part number")
                              + f" - pick one (--part {ref}=C...)")
            continue
        found.append(p)
    return found, unresolved


# ---------------- the source ----------------

def _ident(text: str) -> str:
    """A name as an atopile identifier. Signs are spelled out, as
    lcsc._ident does it: BAT+ -> BAT_P, FAN- -> FAN_N, 3.3V -> n3_3V."""
    text = (text or "").strip()
    text = re.sub(r"\+$", "_P", text)
    text = re.sub(r"-$", "_N", text)
    text = text.replace("+", "P")
    out = re.sub(r"[^A-Za-z0-9_]", "_", text).strip("_")
    out = re.sub(r"_+", "_", out) or "x"
    if out[0].isdigit():
        out = "n" + out
    return out + "_" if out in KEYWORDS else out


class Names:
    """Identifiers, unique within one scope."""

    def __init__(self):
        self.used: set[str] = set(KEYWORDS)

    def take(self, want: str) -> str:
        name, n = want, 2
        while name in self.used:
            name = f"{want}_{n}"
            n += 1
        self.used.add(name)
        return name


def modules(parts: list[Part], graph: dict, pads: dict) -> dict[str, list[str]]:
    """Which parts go together, as a person would draw the blocks.

    Every part with five pads or more is the heart of a block - a chip, a
    connector. Each smaller part joins the nearest heart through nets that
    join a few parts, not the rails: ground reaches everything and says
    nothing about who belongs with whom. The block is named for what its
    nets are called (power, usb_serial, oled...) and its heart's ref, so
    the name is a hint and never a claim.
    """
    refs = [p.ref for p in parts]
    local: dict[str, set] = defaultdict(set)         # ref -> nets that are local
    members: dict[str, set] = {}
    for net in graph.get("nets", []):
        on = {n["ref"] for n in net.get("nodes", []) if n["ref"] in refs}
        if 2 <= len(on) <= 6:
            members[net["name"]] = on
            for r in on:
                local[r].add(net["name"])
    hearts = sorted((r for r in refs if len(pads.get(r, {})) >= 5),
                    key=lambda r: (-len(pads.get(r, {})), r))
    owner = {h: h for h in hearts}
    frontier = list(hearts)
    while frontier:
        nxt = []
        for r in frontier:
            for net in sorted(local[r]):
                for other in sorted(members[net]):
                    if other not in owner:
                        owner[other] = owner[r]
                        nxt.append(other)
        frontier = nxt
    groups: dict[str, list[str]] = defaultdict(list)
    for r in refs:
        groups[owner.get(r, "")].append(r)

    named: dict[str, list[str]] = {}
    for heart, rs in sorted(groups.items(), key=lambda kv: (kv[0] == "", kv[0])):
        if not heart:
            named["loose"] = rs
            continue
        nets = {n for r in rs for n in local[r]}
        score = {name: sum(1 for n in nets if re.search(rx, n, re.I)) for name, rx in FUNCTIONS}
        best = max(score, key=lambda k: score[k]) if any(score.values()) else "block"
        named[f"{best}_{heart.lower()}"] = rs
    return named


SUPPLY = re.compile(r"^(GND|AGND|PGND|VCC|VDD|VIN|VBUS|VBAT|VSYS|BAT[+_P]?|\+?\d+(\.\d+)?V\d*)$", re.I)


def findings(graph: dict, pads: dict, through_hole: set | None = None) -> list[str]:
    """What looks wrong in the design as imported - listed, not changed.

    A net that joins three or more two-pad parts and nothing else - no
    chip, no connector (a through-hole part: a cable plugs into it), and
    not a rail by name - has nowhere for current to come from or go to:
    the demo board's three LED cathodes on LED2_2 are one."""
    out = []
    through_hole = through_hole or set()
    for net in graph.get("nets", []):
        refs = {n["ref"] for n in net.get("nodes", [])}
        if SUPPLY.match(net.get("name") or "") or refs & through_hole:
            continue
        if len(refs) >= 3 and all(len(pads.get(r, {})) == 2 for r in refs):
            nodes = ", ".join(f"{n['ref']}.{n['pin']}" for n in net["nodes"])
            out.append(f"net {net['name']} joins only two-pad parts ({nodes}) and reaches "
                       f"no chip, connector, ground or supply - kept as imported")
    return out


def write(title: str, parts: list[Part], graph: dict, pads: dict, origin: str,
          bom_name: str | None) -> tuple[str, dict]:
    """The atopile source, and how it came out (modules, nets, pins left
    open)."""
    by_ref = {p.ref: p for p in parts}
    wired = net_of(graph)
    lines = [
        f"# {title} - converted from an imported board ({origin}).",
        "#",
        "# Written by Redline's converter (backend/convert.py). The nets are the",
        "# imported netlist's, pad for pad and under their own names; every",
        "# designator is the original. After each build the netlist is compared",
        "# with the imported one, (ref, pad) by (ref, pad).",
        "#",
        f"# Parts: {'the BOM (' + bom_name + ')' if bom_name else 'no BOM was given'}. "
        "Every part marked GUESSED",
        "# was chosen without one - its footprint and pads checked against the",
        "# board, its value and exact type not. A BOM added later replaces them:",
        "#   revisions.py board convert <board> --bom bom.csv",
        "",
    ]

    # One component block per part number. Pins that share a name share a
    # signal only where the board puts them on one net: otherwise they are
    # kept apart, so writing the block cannot join two nets.
    blocks: dict[str, list[Part]] = defaultdict(list)
    for p in parts:
        blocks[p.lcsc].append(p)
    names = Names()
    signal_of: dict[tuple[str, str], str] = {}        # (ref, pad) -> signal in its block
    guessed_n = 0
    lines.append("# ---------------- parts ----------------")
    for code, group in blocks.items():
        head = group[0]
        block = names.take(head.name or _ident(code))
        for p in group:
            p.name = block
        pin_names: dict[str, list[str]] = defaultdict(list)
        for pin in head.pins:
            pin_names[pin["name"].strip()].append(pin["number"])
        sig_for: dict[str, str] = {}
        taken = Names()
        body = []
        for pin in head.pins:
            raw, num = pin["name"].strip(), pin["number"]
            ident = _ident(lcsc._ident(raw, f"p{num}")) if raw else f"p{num}"
            same = pin_names[raw]
            one_net = len(same) > 1 and all(
                len({wired.get((p.ref, n)) for n in same}) == 1
                and wired.get((p.ref, same[0])) is not None for p in group)
            if ident.upper() in ("NC", "N_C", "DNC") or (len(same) > 1 and not one_net):
                sig = taken.take(f"{ident}_{re.sub(r'[^A-Za-z0-9]', '_', num)}")
            elif raw in sig_for:
                sig = sig_for[raw]
                body.append(f"    {sig} ~ pin {num}")
                for p in group:
                    signal_of[(p.ref, num)] = sig
                continue
            else:
                sig = taken.take(ident)
                sig_for[raw] = sig
            note = "   # on the footprint, not in the symbol" if num in head.added_pins else ""
            body.append(f"    signal {sig} ~ pin {num}{note}")
            for p in group:
                signal_of[(p.ref, num)] = sig
        lines.append(f"component {block}:")
        refs = ", ".join(p.ref for p in group)
        lines.append(f"    # {code} · {refs}")
        for p in group:
            if p.guessed:
                guessed_n += 1
        if head.guessed:
            lines.append(f"    # GUESSED ({head.how}): {head.why}")
        else:
            lines.append(f"    # {head.why}")
        if head.land and head.land.get("worst_mm") is not None:
            lines.append(f"    # land pattern over the board's pads: worst {head.land['worst_mm']} mm")
        lines.append(f'    footprint = "{head.footprint}"')
        lines.append(f'    mpn = "{code}"')
        lines += body
        lines.append("")

    # The nets: one identifier each, the original name kept exactly.
    net_names = sorted({n for n in wired.values()}, key=lambda n: (n != "GND", n))
    top = Names()
    net_ident = {n: top.take(_ident(n)) for n in net_names}

    groups = modules(parts, graph, pads)
    mod_names = {g: top.take(_ident(g)) for g in groups}
    mod_types = {g: names.take(_ident(g).title().replace("_", "")) for g in groups}
    home: dict[str, set] = defaultdict(set)          # net -> modules it reaches
    for g, refs in groups.items():
        for r in refs:
            for (ref, _pad), n in wired.items():
                if ref == r:
                    home[n].add(g)

    lines.append("# ---------------- the circuit ----------------")
    lines.append("")
    open_pins = []
    for g, refs in groups.items():
        mod = mod_names[g]
        mine = sorted({wired[(r, pad)] for r in refs for pad in pads.get(r, {})
                       if (r, pad) in wired}, key=lambda n: (n != "GND", n))
        lines.append(f"module {mod_types[g]}:")
        lines.append(f"    # {', '.join(refs)}")
        # A module's signal for a net is called what the net is called at
        # the top; the parts inside take what names are left.
        local = Names()
        inner = {}
        for n in mine:
            inner[n] = local.take(net_ident[n])
            lines.append(f"    signal {inner[n]}")
            if len(home[n]) == 1:
                lines.append(f'    {inner[n]}.override_net_name = "{n}"')
        lines.append("")
        for r in refs:
            p = by_ref[r]
            inst = local.take(_ident(r.lower()))
            tag = "   # GUESSED" if p.guessed else ""
            lines.append(f"    {inst} = new {p.name}{tag}")
            lines.append(f'    {inst}.designator = "{r}"')
            # Pins that share a signal are one connection: atopile refuses
            # the same one made twice.
            said = set()
            for pad in sorted(pads.get(r, {}), key=_pad_order):
                sig = signal_of.get((r, pad))
                n = wired.get((r, pad))
                if n is None:
                    open_pins.append(f"{r}.{pad}")
                    continue
                if sig is None:
                    lines.append(f"    # {r} pad {pad} ({n}): the part has no such pin")
                    continue
                if (sig, n) not in said:
                    said.add((sig, n))
                    lines.append(f"    {inst}.{sig} ~ {inner[n]}")
            lines.append("")
    lines.append("module App:")
    lines.append(f"    # {title}: {len(parts)} parts, {len(net_names)} nets")
    shared = [n for n in net_names if len(home[n]) > 1]
    for n in shared:
        lines.append(f"    signal {net_ident[n]}")
        lines.append(f'    {net_ident[n]}.override_net_name = "{n}"')
    lines.append("")
    for g in groups:
        lines.append(f"    {mod_names[g]} = new {mod_types[g]}")
    lines.append("")
    for g in groups:
        for n in shared:
            if g in home[n]:
                lines.append(f"    {mod_names[g]}.{net_ident[n]} ~ {net_ident[n]}")
    source = "\n".join(lines) + "\n"
    return source, {"modules": {mod_names[g]: refs for g, refs in groups.items()},
                    "nets": len(net_names), "open_pins": open_pins, "guessed": guessed_n}


def _pad_order(pad: str):
    return (0, int(pad), "") if pad.isdigit() else (1, 0, pad)


# ---------------- the proof ----------------

def equivalence(imported: dict, built: dict) -> dict:
    """Is the built netlist the imported one?

    Same parts, and the same connections: each netlist is read as groups
    of (ref, pad) pairs - one group per net of two pads or more - and the
    groups must be identical. Net names are compared too, but a renamed
    net is reported, not counted as a difference: the circuit is the pads.
    """
    def groups(g):
        out = {}
        for net in g.get("nets", []):
            nodes = frozenset((n["ref"], str(n["pin"])) for n in net.get("nodes", []))
            if len(nodes) >= 2:
                out[nodes] = net.get("name")
        return out

    a_parts = {c["ref"] for c in imported.get("components", [])}
    b_parts = {c["ref"] for c in built.get("components", [])}
    a, b = groups(imported), groups(built)
    only_a = [a[k] for k in a if k not in b]
    only_b = [b[k] for k in b if k not in a]
    where_b = {node: name for k, name in b.items() for node in k}
    differences = []
    for k in a:
        if k in b:
            continue
        went = sorted({where_b.get(node, "(open)") for node in k})
        differences.append({"net": a[k], "pads": sorted(f"{r}.{p}" for r, p in k),
                            "built_as": went})
    where_a = {node: name for k, name in a.items() for node in k}
    for k in b:
        if k in a:
            continue
        came = sorted({where_a.get(node, "(open)") for node in k})
        differences.append({"built_net": b[k], "pads": sorted(f"{r}.{p}" for r, p in k),
                            "imported_as": came})
    renamed = sorted(f"{a[k]} -> {b[k]}" for k in a if k in b and a[k] != b[k])
    same = not only_a and not only_b and a_parts == b_parts
    return {
        "equivalent": same,
        "parts": {"imported": len(a_parts), "built": len(b_parts),
                  "missing": sorted(a_parts - b_parts), "extra": sorted(b_parts - a_parts)},
        "nets": {"imported": len(a), "built": len(b), "same": len(set(a) & set(b)),
                 "only_imported": len(only_a), "only_built": len(only_b)},
        "pads_joined": {"imported": sum(len(k) for k in a), "built": sum(len(k) for k in b)},
        "renamed": renamed,
        "differences": differences[:40],
    }


# ---------------- the whole of it, on a stored board ----------------

# What the pipeline will draw over, kept under `imported_<label>` the first
# time: the import's netlist is the reference every build is checked
# against, and its drawings are what the board looked like when it came.
KEEP = ("graph", "layout", "bottom", "tracks", "model3d")


def outline_from(sources: bytes | None) -> dict | None:
    """The Gerber outline, as closed loops, from the files the import kept."""
    from .imports import detect, gerbers

    if not sources:
        return None
    try:
        with zipfile.ZipFile(io.BytesIO(sources)) as z:
            files = [(n, z.read(n)) for n in z.namelist() if not n.endswith("/")]
    except zipfile.BadZipFile:
        return None
    items = [i for i in detect.sort_upload(files) if i.kind == detect.GERBER and i.layer == "outline"]
    if not items:
        return None
    board = gerbers.Board(items)
    try:
        return board.outline_path()
    finally:
        board.close()


async def run(db, bid: str, bom: bytes | None = None, picks: dict | None = None,
              say=None) -> dict:
    """Convert a stored imported board, build it, and check the build.

    `bom`: a BOM CSV to use from now on (kept on the board as `bom_csv`).
    `picks`: ref -> {"lcsc", "why"} for parts nothing else settles; kept
    on the board, so running this again - with a BOM, say - keeps them
    where the BOM does not speak.

    Runs again on a board it already converted: the reference is still the
    import's netlist, and a BOM given now replaces the guesses.
    """
    from . import ato, store
    from .ato import BOARDS

    async def tell(text, level="info"):
        if say:
            await say(text, level)

    # A conversion looks up tens of parts: it waits for LCSC's budget, as
    # `part keep` does, rather than failing at the twenty-sixth.
    lcsc.PATIENT.set(True)

    doc = await db[BOARDS].find_one({"_id": bid})
    if not doc:
        raise KeyError(bid)
    if doc.get("kind") != "imported" and not doc.get("convert"):
        raise ValueError(f"{bid} is not an imported board - it has its own source")
    arts = doc.get("artifacts") or {}

    async def artifact(label):
        try:
            return await store.get_artifact(db, bid, label, BOARDS)
        except KeyError:
            return None

    graph = json.loads(await artifact("imported_graph" if "imported_graph" in arts else "graph")
                       or b"null") or None
    if not graph or not graph.get("nets"):
        raise ValueError(f"{bid}: the import has no netlist to convert - it needs "
                         "FlyingProbeTesting.json or a design file")
    pads_raw = await artifact("pads")
    pads = json.loads(pads_raw) if pads_raw else []
    sources = await artifact("sources")
    if bom:
        await store.put_artifact(db, bid, "bom_csv", bom, collection=BOARDS)
    else:
        bom = await artifact("bom_csv")
    bom_rows, bom_name = bom_from(sources, bom)

    kept = dict((doc.get("convert") or {}).get("picks") or {})
    for ref, pick in (picks or {}).items():
        kept[ref] = pick if isinstance(pick, dict) else {"lcsc": pick}
    table = pad_table(graph, pads)
    footprints = {c["ref"]: c.get("footprint") or (bom_rows.get(c["ref"]) or {}).get("footprint")
                  for c in graph["components"]}

    await tell(f"{bid}: converting - {len(graph['components'])} parts, "
               f"{'BOM ' + bom_name if bom_name else 'no BOM'}", "work")
    parts, unresolved = await identify(graph, table, bom_rows, kept, footprints)
    report = {"at": store.now(), "bom": bom_name, "picks": kept,
              "parts": [p.report() for p in parts], "unresolved": unresolved,
              "guessed": sorted(p.ref for p in parts if p.guessed),
              "findings": findings(graph, table,
                                   {p["ref"] for p in pads if (p.get("type") or "SMD") != "SMD"})}
    if unresolved:
        report["status"] = "needs parts"
        await db[BOARDS].update_one({"_id": bid}, {"$set": {"convert": report}})
        await tell(f"{bid}: {len(unresolved)} parts could not be settled - "
                   + "; ".join(unresolved[:3]), "warn")
        return report

    outline = outline_from(sources)
    origin = (doc.get("imported") or {}).get("source") or "an import"
    source, info = write(doc.get("title") or bid, parts, graph, table, origin, bom_name)
    report.update(info)
    report["outline"] = ({k: v for k, v in outline.items() if k != "loops"}
                         if outline else None)
    problems = [f"{p.ref}: {x}" for p in parts for x in p.problems]
    report["problems"] = problems

    # The import, kept before anything draws over it.
    for label in KEEP:
        if label in arts and f"imported_{label}" not in arts:
            data = await artifact(label)
            if data is not None:
                await store.put_artifact(db, bid, f"imported_{label}", data, collection=BOARDS)
    hold = {"placement": bool(outline and outline.get("closed") and pads),
            "outline": outline} if outline else None
    if hold and not hold["placement"]:
        report["problems"].append("the outline or the pads could not be read - the placer "
                                  "will pack the board instead of keeping its layout")
    await db[BOARDS].update_one({"_id": bid}, {"$set": {
        "source": source, "entry": "App", "stale": True, "saved_at": store.now(),
        "hold": hold, "convert": {**report, "status": "building"}}})

    await tell(f"{bid}: source written ({len(parts)} parts, {len(report['guessed'])} guessed) "
               "- building it", "work")
    try:
        built = await ato.build(db, bid)
    except Exception as exc:                                    # noqa: BLE001
        # The import's netlist goes back where the room reads it.
        await store.put_artifact(db, bid, "graph", await artifact("imported_graph"),
                                 collection=BOARDS)
        report["status"] = "build failed"
        report["build_error"] = str(exc)[-1500:]
        await db[BOARDS].update_one({"_id": bid}, {"$set": {"convert": report}})
        await tell(f"{bid}: the converted source did not build - "
                   f"{str(exc).splitlines()[-1][:160] if str(exc) else exc}", "error")
        return report
    new = json.loads(await artifact("graph"))
    eq = equivalence(graph, new)
    report["build"] = {k: built.get(k) for k in ("components", "nets", "joins")}
    report["equivalence"] = eq
    if eq["equivalent"]:
        report["status"] = "converted"
        await db[BOARDS].update_one({"_id": bid}, {"$set": {"convert": report},
                                                   "$unset": {"kind": ""}})
        await tell(f"{bid}: converted - the build's netlist is the import's: "
                   f"{eq['parts']['built']} parts, {eq['nets']['same']} nets, "
                   f"{eq['pads_joined']['built']} pads joined. Guessed parts: "
                   f"{len(report['guessed'])}", "done")
    else:
        await store.put_artifact(db, bid, "graph", await artifact("imported_graph"),
                                 collection=BOARDS)
        report["status"] = "not equivalent"
        await db[BOARDS].update_one({"_id": bid}, {"$set": {"convert": report}})
        await tell(f"{bid}: built, but not the imported netlist - "
                   f"{eq['nets']['only_imported']} nets differ; the board stays imported",
                   "error")
    return report


async def check(db, bid: str) -> dict | None:
    """After a build of a converted board: is it still the imported
    circuit? None for a board that was never converted. A change someone
    asked for shows up here as a difference - which is right: it is one."""
    from . import store
    from .ato import BOARDS

    doc = await db[BOARDS].find_one({"_id": bid}, {"convert": 1})
    if not (doc or {}).get("convert"):
        return None
    try:
        a = json.loads(await store.get_artifact(db, bid, "imported_graph", BOARDS))
        b = json.loads(await store.get_artifact(db, bid, "graph", BOARDS))
    except KeyError:
        return None
    eq = equivalence(a, b)
    await db[BOARDS].update_one({"_id": bid}, {"$set": {"convert.equivalence": eq}})
    return eq
