#!/usr/bin/env python
"""Write a board's schematic as a real KiCad schematic.

Runs in the atopile environment (.venv-ato), where kiutils and
easyeda2kicad live, the way `ato` itself does:

    .venv-ato/bin/python tools/schematic_gen.py < plan.json

The plan is the board's parts and nets. Each part is drawn with its own
symbol - the LCSC part's EasyEDA symbol, converted, or KiCad's standard
resistor and capacitor - and grouped with the rest of its module. Pins are
joined by name, not by drawn wires: a short stub from each pin and a label
with the net's name on it, which is how KiCad connects two points that are
nowhere near each other, and how a generated schematic stays readable
without a wire router. A pin on nothing gets a no-connect flag, so ERC can
tell a pin left open on purpose from one that was forgotten.
"""

from __future__ import annotations

import copy
import json
import math
import re
import sys
import tempfile
import uuid
from pathlib import Path

from kiutils.items.common import (ColorRGBA, Effects, Font, Justify, PageSettings,
                                  Position, Property, Stroke, TitleBlock)
from kiutils.items.schitems import (Connection, GlobalLabel, HierarchicalSheet,
                                    HierarchicalSheetProjectInstance,
                                    HierarchicalSheetProjectPath, LocalLabel, NoConnect,
                                    SchematicSymbol, SymbolProjectInstance,
                                    SymbolProjectPath, Text)
from kiutils.schematic import Schematic
from kiutils.symbol import SymbolLib

GRID = 1.27                      # KiCad's schematic grid: pins land on it
STUB = 2.54                      # the wire from a pin to its label
CHAR = 1.0                       # a label's width per character, roughly
GAP = 7.62                       # between two parts' extents
GROUP_GAP = 20.32                # between two modules


def snap(v: float) -> float:
    return round(v / GRID) * GRID


def _uid() -> str:
    return str(uuid.uuid4())


def font(size: float = 1.27, hide: bool = False, justify: str | None = None) -> Effects:
    e = Effects(font=Font(height=size, width=size), hide=hide)
    if justify:
        e.justify = Justify(horizontally=justify)
    return e


# ---------------- symbols ----------------

def easyeda_symbol(component_json: str, name: str):
    """An LCSC part's symbol, from the EasyEDA data already on disk."""
    from easyeda2kicad.easyeda.easyeda_importer import EasyedaSymbolImporter
    from easyeda2kicad.kicad.export_kicad_symbol import ExporterSymbolKicad

    data = json.loads(Path(component_json).read_text())["result"]
    symbol = EasyedaSymbolImporter(data).get_symbol()
    try:
        # The released easyeda2kicad (0.6 to 1.0) takes kicad_version=...
        from easyeda2kicad.kicad.parameters_kicad_symbol import KicadVersion
        exporter = ExporterSymbolKicad(symbol, kicad_version=KicadVersion.v6)
    except (ImportError, TypeError):
        # ... a build from its repository took version=6.
        exporter = ExporterSymbolKicad(symbol, version=6)
    text = exporter.export("lcsc")
    with tempfile.NamedTemporaryFile("w", suffix=".kicad_sym", delete=False) as f:
        f.write(f"(kicad_symbol_lib (version 20211014) (generator redline)\n{text}\n)")
    sym = SymbolLib.from_file(f.name).symbols[0]
    Path(f.name).unlink(missing_ok=True)
    return rename(sym, "lcsc", name)


_device: dict = {}


def kicad_symbol(lib: str, entry: str):
    """One of KiCad's own symbols - a resistor, a capacitor."""
    if lib not in _device:
        _device[lib] = {s.entryName: s for s in SymbolLib.from_file(lib).symbols}
    return rename(copy.deepcopy(_device[lib][entry]), "Device", entry)


def rename(sym, nickname: str, entry: str):
    sym.libraryNickname = nickname
    sym.entryName = entry
    for unit in sym.units:
        unit.entryName = entry
    return sym


# EasyEDA has five pin types - undefined, input, output, bidirectional,
# power - and easyeda2kicad writes undefined as "unspecified" and power as
# "power_in". Neither is something the symbol said: "unspecified" makes
# KiCad warn on every wire that touches it, and with no way to say "power
# out" no rail drawn from EasyEDA symbols can ever be driven - a
# regulator's OUT is a power input too. Both become passive, which is
# what KiCad calls a pin whose direction is not known; input, output and
# bidirectional are kept as the maker typed them.
UNTYPED = {"unspecified", "power_in"}


def retype(sym, mode: str) -> int:
    """Pin types for ERC: every pin passive (`mode` "passive": a
    connector, a switch, an LED - backend/schematic.py passive_pins), or
    only those EasyEDA left untyped. Returns how many pins were changed."""
    changed = 0
    for pin in pins_of(sym):
        if mode == "passive" or pin.electricalType in UNTYPED:
            if pin.electricalType != "passive":
                pin.electricalType = "passive"
                changed += 1
    return changed


def pins_of(sym) -> list:
    return [p for unit in sym.units for p in unit.pins]


def outward(angle: float) -> tuple[float, float]:
    """The way out of a pin, in schematic coordinates (y down).

    A pin's angle is the way it runs from its connection point into the
    body, in the library's y-up coordinates; out is the other way, with y
    turned over.
    """
    a = math.radians(angle)
    return (round(-math.cos(a)), round(math.sin(a)))


def turned(x: float, y: float, rot: int) -> tuple[float, float]:
    """A point from the library's y-up coordinates onto the sheet (y down),
    with the symbol turned `rot` degrees the way KiCad turns one."""
    sx, sy = x, -y
    for _ in range((rot // 90) % 4):
        sx, sy = sy, -sx
    return sx, sy


def pin_points(sym, rot: int) -> list:
    """(number, x, y, way out) for every pin, on the sheet, relative to the
    symbol's origin."""
    out = []
    for pin in pins_of(sym):
        x, y = turned(pin.position.X, pin.position.Y, rot)
        dx, dy = outward(pin.position.angle)
        for _ in range((rot // 90) % 4):
            dx, dy = dy, -dx
        out.append((pin.number, x, y, (dx, dy)))
    return out


def turn_for(sym) -> int:
    """Two-pin parts drawn standing up are laid on their side. Standing,
    their labels run down the page, and one long net name made a resistor
    as tall as a chip - and every part in its row that tall with it.

    Only those drawn standing: KiCad's resistor and capacitor are, but an
    LCSC LED or diode is usually drawn lying down already, and turning it
    stood it up."""
    pins = pin_points(sym, 0)
    if len(pins) == 2 and all(d[0] == 0 for *_, d in pins):
        return 90
    return 0


def extent(sym, labels: dict, rot: int = 0) -> tuple[float, float, float, float]:
    """A symbol's extent with its labels, relative to its origin (y down).

    The body is judged from the pins and the drawn rectangles; each pin's
    label reaches out beyond it by the stub and the length of the net's
    name, which is what decides how close the next part can sit.
    """
    xs, ys = [0.0], [0.0]
    for unit in sym.units:
        for g in getattr(unit, "graphicItems", []):
            for attr in ("start", "end", "center"):
                pt = getattr(g, attr, None)
                if pt is not None and hasattr(pt, "X"):
                    gx, gy = turned(pt.X, pt.Y, rot)
                    xs.append(gx)
                    ys.append(gy)
    for number, px, py, (dx, dy) in pin_points(sym, rot):
        reach = STUB + CHAR * len(labels.get(number, "")) + 1.0
        xs += [px, px + dx * reach]
        ys += [py, py + dy * reach]
    return (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))


def shortened(names: list[str]) -> dict[str, str]:
    """Each net's name without the module it was made in, where that is
    safe: `power.led_done-a` reads `led_done-a`.

    Only where safe, because on a schematic two labels with the same text
    are the same net. `power.x` and `uart.x` both cut to `x` would be
    joined by the drawing, so a name keeps its prefix unless the short form
    is used by no other net.
    """
    # Only a module's name is cut, never a number's point: `3.3V` stays.
    cut = {n: n.split(".", 1)[1] for n in names
           if re.match(r"^[A-Za-z_][A-Za-z0-9_]*\.[^.]", n)}
    counts: dict[str, int] = {}
    for n in names:
        s = cut.get(n, n)
        counts[s] = counts.get(s, 0) + 1
    return {n: (cut[n] if n in cut and counts[cut[n]] == 1 else n) for n in names}


# ---------------- the sheet ----------------

def draw_sheet(comps: list[dict], nets_at: dict, global_nets: set, title: str,
               project: str, path=None):
    """One sheet: these parts, each pin to its net by a stub and a label.

    A net that is drawn on another sheet as well gets a global label - the
    name joins it across sheets; one that stays on this sheet a local label.
    `path(sch)` is the sheet's instance path, which every symbol on it
    carries: "/<root>" on a flat schematic, "/<root>/<sheet>" on a sub-sheet.
    """
    sch = Schematic.create_new()
    sch.version = 20231120
    sch.generator = "redline"
    sch.uuid = _uid()
    sch.titleBlock = TitleBlock(title=title)
    instance_path = path(sch) if path else f"/{sch.uuid}"

    parts, lib_seen, retyped = [], {}, 0
    for comp in comps:
        src = comp["symbol"]
        key = src.get("key") or comp["part"]
        if src["kind"] == "easyeda" and src.get("pins") == "passive":
            key = f"{key}_passive"
        if key not in lib_seen:
            if src["kind"] == "easyeda":
                sym = easyeda_symbol(src["json"], key)
                retyped += retype(sym, src.get("pins") or "as_typed")
            else:
                sym = kicad_symbol(src["lib"], src["entry"])
            lib_seen[key] = sym
            sch.libSymbols.append(sym)
        sym = lib_seen[key]
        labels = {p.number: nets_at.get((comp["ref"], p.number), "")
                  for p in pins_of(sym)}
        rot = turn_for(sym)
        parts.append((comp, sym, labels, rot, extent(sym, labels, rot)))

    # Modules left to right; within one, the big parts first down a column
    # and the small ones after them in rows - each part beside the ones it
    # shares a module with, which is the reading order a person expects.
    groups: dict[str, list] = {}
    for item in parts:
        groups.setdefault(item[0].get("group") or "", []).append(item)

    # Each module packed into a block about as wide as it is tall, the
    # blocks then packed the same way - a sheet, not a strip.
    order = {"mcu": 0, "usb-uart": 1}
    blocks = []
    for name in sorted(groups, key=lambda g: (order.get(g, 2), g == "", g)):
        items = sorted(groups[name], key=lambda it: (-len(pins_of(it[1])), it[0]["ref"]))
        area = sum((e[2] + GAP) * (e[3] + GAP) for *_, e in items)
        cap = max(max(e[2] for *_, e in items), math.sqrt(area) * 1.2)
        x, y, row_h, width, spots = 0.0, 0.0, 0.0, 0.0, []
        for item in items:
            ew, eh = item[4][2], item[4][3]
            if x > 0 and x + ew > cap:
                x, y, row_h = 0.0, y + row_h + GAP, 0.0
            spots.append((x, y))
            x += ew + GAP
            row_h = max(row_h, eh)
            width = max(width, x - GAP)
        blocks.append((name, items, spots, width, y + row_h))

    total = sum((w + GROUP_GAP) * (h + GROUP_GAP) for *_, w, h in blocks)
    sheet_cap = max([w for *_, w, _ in blocks] + [math.sqrt(total) * 1.5])
    placed, bx, by, row_h = [], 0.0, 0.0, 0.0
    for name, items, spots, w, h in blocks:
        if bx > 0 and bx + w > sheet_cap:
            bx, by, row_h = 0.0, by + row_h + GROUP_GAP, 0.0
        top = 25.4 + by
        if name:
            sch.texts.append(Text(text=name.upper(),
                                  position=Position(snap(12.7 + bx), snap(top - 7.62), 0),
                                  effects=font(2.54, justify="left"), uuid=_uid()))
        for (comp, sym, labels, rot, e), (x, y) in zip(items, spots):
            ox = snap(12.7 + bx + x - e[0])
            oy = snap(top + y - e[1])
            placed.append((comp, sym, labels, rot, ox, oy, e))
        bx += w + GROUP_GAP
        row_h = max(row_h, h)

    right = max(ox + e[0] + e[2] for *_, ox, oy, e in placed)
    bottom = max(oy + e[1] + e[3] for *_, ox, oy, e in placed)
    sch.paper = PageSettings(paperSize="User", width=math.ceil(right + 25.4),
                             height=math.ceil(bottom + 25.4))

    wires = labels_made = globals_made = open_pins = 0
    for comp, sym, labels, rot, ox, oy, (ex, ey, ew, eh) in placed:
        ref = comp["ref"]
        inst = SchematicSymbol(
            libraryNickname=sym.libraryNickname, entryName=sym.entryName,
            position=Position(ox, oy, rot), unit=1, inBom=True, onBoard=True,
            uuid=_uid())
        # A field turns with its part, so a turned part's text is given the
        # same turn back to read level - left as it was, "100nF" ran down
        # through the middle of the capacitor.
        inst.properties = [
            Property(key="Reference", value=ref, id=0,
                     position=Position(snap(ox + ex + ew / 2), snap(oy + ey) - 1.27, rot),
                     effects=font()),
            Property(key="Value", value=comp.get("value") or comp.get("name") or "",
                     id=1, position=Position(snap(ox + ex + ew / 2), snap(oy + ey + eh) + 1.27, rot),
                     effects=font()),
            Property(key="Footprint", value=comp.get("footprint") or "", id=2,
                     position=Position(ox, oy, 0), effects=font(hide=True)),
            Property(key="LCSC", value=comp.get("part") or "", id=4,
                     position=Position(ox, oy, 0), effects=font(hide=True)),
        ]
        inst.pins = {p.number: _uid() for p in pins_of(sym)}
        inst.instances = [SymbolProjectInstance(
            name=project, paths=[SymbolProjectPath(
                sheetInstancePath=instance_path, reference=ref, unit=1)])]
        sch.schematicSymbols.append(inst)

        for number, rx, ry, (dx, dy) in pin_points(sym, rot):
            px, py = ox + rx, oy + ry
            net = labels.get(number, "")
            if not net:
                sch.noConnects.append(NoConnect(position=Position(px, py), uuid=_uid()))
                open_pins += 1
                continue
            ex_, ey_ = px + dx * STUB, py + dy * STUB
            sch.graphicalItems.append(Connection(
                type="wire", points=[Position(px, py), Position(ex_, ey_)],
                stroke=Stroke(width=0), uuid=_uid()))
            wires += 1
            angle = {(1, 0): 0, (0, -1): 90, (-1, 0): 180, (0, 1): 270}[(dx, dy)]
            effects = font(justify="left" if angle in (0, 90) else "right")
            if net in global_nets:
                sch.globalLabels.append(GlobalLabel(
                    text=net, shape="passive", position=Position(ex_, ey_, angle),
                    effects=effects, uuid=_uid()))
                globals_made += 1
            else:
                sch.labels.append(LocalLabel(
                    text=net, position=Position(ex_, ey_, angle), effects=effects,
                    uuid=_uid()))
            labels_made += 1

    stats = {"parts": len(placed), "wires": wires, "labels": labels_made,
             "global_labels": globals_made, "no_connects": open_pins,
             "symbols": len(lib_seen), "pins_made_passive": retyped,
             "size_mm": [sch.paper.width, sch.paper.height]}
    return sch, stats


SHEET_W, SHEET_H = 76.2, 25.4             # a sheet's box on the root


def main() -> int:
    plan = json.load(sys.stdin)
    project = plan.get("project", "board")
    names = shortened([net["name"] for net in plan["nets"] if net.get("name")])
    nets_at = {}                                  # (ref, pin) -> net name
    for net in plan["nets"]:
        nodes = net.get("nodes", [])
        if len(nodes) >= 2:
            for n in nodes:
                nets_at[(n["ref"], str(n["pin"]))] = names.get(net["name"], net["name"])
    out = Path(plan["out"])
    title = plan.get("title", project)
    sheets = plan.get("sheets") or []

    if not sheets:
        sch, stats = draw_sheet(plan["components"], nets_at, set(), title, project)
        sch.to_file(str(out))
        print(json.dumps({**stats, "sheets": []}))
        return 0

    # Hierarchical: a root holding a box per sheet. Nets on more than one
    # sheet are joined by global labels; the boxes need no pins.
    # Which those are is the plan's (backend/sheets.py), by the netlist's
    # names; worked out here from where the parts are when it does not say.
    if "global_nets" in plan:
        global_nets = {names.get(n, n) for n in plan["global_nets"]}
    else:
        sheet_of = {c["ref"]: c.get("sheet") for c in plan["components"]}
        on = {}                                    # net -> sheets it is drawn on
        for (ref, _pin), net in nets_at.items():
            on.setdefault(net, set()).add(sheet_of.get(ref))
        global_nets = {n for n, s in on.items() if len(s) > 1}

    root = Schematic.create_new()
    root.version = 20231120
    root.generator = "redline"
    root.uuid = _uid()
    root.titleBlock = TitleBlock(title=title)

    totals = {"parts": 0, "wires": 0, "labels": 0, "global_labels": 0, "no_connects": 0,
              "symbols": 0, "pins_made_passive": 0}
    made, cols = [], 3
    for i, sheet in enumerate(sheets):
        comps = [c for c in plan["components"] if c.get("sheet") == sheet["key"]]
        sheet_uuid = _uid()
        sub, stats = draw_sheet(comps, nets_at, global_nets, sheet["name"], project,
                                path=lambda _s, u=sheet_uuid: f"/{root.uuid}/{u}")
        sub.sheetInstances = []
        sub.to_file(str(out.parent / sheet["file"]))
        for k in totals:
            totals[k] += stats[k]

        col, row = i % cols, i // cols
        x = snap(25.4 + col * (SHEET_W + 25.4))
        y = snap(25.4 + row * (SHEET_H + 25.4))
        box = HierarchicalSheet(
            position=Position(x, y), width=SHEET_W, height=SHEET_H,
            stroke=Stroke(width=0.1524, type="solid"), fill=ColorRGBA(0, 0, 0, 0),
            uuid=sheet_uuid,
            sheetName=Property(key="Sheetname", value=sheet["name"], id=0,
                               position=Position(x, snap(y - 0.762), 0),
                               effects=font(1.778, justify="left")),
            fileName=Property(key="Sheetfile", value=sheet["file"], id=1,
                              position=Position(x, y + SHEET_H + 0.635, 0),
                              effects=font(1.27, justify="left")))
        box.instances = [HierarchicalSheetProjectInstance(
            name=project, paths=[HierarchicalSheetProjectPath(
                sheetInstancePath=f"/{root.uuid}", page=str(i + 2))])]
        root.sheets.append(box)
        root.texts.append(Text(text=f"{len(comps)} parts",
                               position=Position(snap(x + 2.54), snap(y + SHEET_H / 2), 0),
                               effects=font(1.778, justify="left"), uuid=_uid()))
        made.append({**{k: v for k, v in sheet.items()}, **stats})

    rows = (len(sheets) + cols - 1) // cols
    root.paper = PageSettings(paperSize="User",
                              width=math.ceil(25.4 + min(cols, len(sheets)) * (SHEET_W + 25.4)),
                              height=math.ceil(25.4 + rows * (SHEET_H + 25.4) + 12.7))
    root.to_file(str(out))
    totals["symbols"] = len({c["symbol"].get("key") or c["part"] for c in plan["components"]})
    print(json.dumps({**totals, "size_mm": [root.paper.width, root.paper.height],
                      "sheets": made, "global_nets": sorted(global_nets)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
