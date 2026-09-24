"""Place a netlist onto a board, using KiCad's own writer.

Runs inside the KiCad container, never on the machine. It is given a plan
on stdin - components with a footprint file each, and the nets between
them - and it writes a .kicad_pcb with KiCad's own library code, which is
the only thing that agrees with KiCad about the format.

Hand-writing that file was the first attempt and it is a bad idea: the
board is rejected whole, with "Failed to load board" and no line number,
and the difference between a footprint in a library and the same
footprint in a board is not written down anywhere obvious.

    plan = {
      "out": "/work/board.kicad_pcb",
      "gap": 1.5, "margin": 3.0,
      "components": [{"ref": "R1", "footprint": "/work/fp/R0402.kicad_mod",
                      "value": "10k"}],
      "nets": [{"name": "vcc", "nodes": [{"ref": "R1", "pin": "1"}]}]
    }
"""

import json
import sys
from pathlib import Path

import pcbnew

MM = 1_000_000                      # KiCad works in nanometres


def at(x_mm: float, y_mm: float):
    return pcbnew.VECTOR2I(int(x_mm * MM), int(y_mm * MM))


def extent(fp) -> tuple[float, float, float, float]:
    """A footprint's extent in mm, relative to its origin: x, y, w, h.

    The courtyard where it has one - that is what the footprint says it
    needs - and the pads and outline otherwise.
    """
    box = None
    try:
        court = fp.GetCourtyard(pcbnew.F_CrtYd)
        if court.OutlineCount():
            box = court.BBox()
    except Exception:
        box = None
    if box is None:
        try:
            box = fp.GetBoundingBox(False, False)
        except TypeError:
            box = fp.GetBoundingBox(False)
    return (box.GetX() / MM, box.GetY() / MM, box.GetWidth() / MM, box.GetHeight() / MM)


def cluster(loaded, nets):
    """Order the parts so each small one follows the chip it serves.

    A decoupling capacitor belongs beside the pin it decouples, and a
    crystal's load capacitors beside the crystal. Parts with five pads or
    more are anchors, biggest first; every smaller part goes after the
    anchor it shares the most nets with. Nets that touch more than six
    parts - ground, the rails - are left out of that count: they share
    everything with everything and would put every part beside the MCU.
    """
    parts = {comp.get("ref"): (comp, fp, box) for comp, fp, box in loaded}
    touches = {}
    for net in nets:
        refs = {n["ref"] for n in net.get("nodes", []) if n.get("ref") in parts}
        if 2 <= len(refs) <= 6:
            for r in refs:
                touches.setdefault(r, set()).add(net.get("name"))

    def pads(ref):
        return len(list(parts[ref][1].Pads()))

    anchors = sorted((r for r in parts if pads(r) >= 5),
                     key=lambda r: (-pads(r), r))
    followers = {a: [] for a in anchors}
    loose = []
    for ref in sorted(r for r in parts if r not in followers):
        mine = touches.get(ref, set())
        best = max(anchors, key=lambda a: len(mine & touches.get(a, set())),
                   default=None)
        if best is not None and mine & touches.get(best, set()):
            followers[best].append(ref)
        else:
            loose.append(ref)

    order = []
    for a in anchors:
        order += [a] + followers[a]
    return [parts[r] for r in order + loose]


def shelves(boxes, gap):
    """Pack extents left to right in rows, the rows about as wide as the
    whole lot is tall - a board, not a strip."""
    import math

    area = sum((w + gap) * (h + gap) for _, _, w, h in boxes)
    widest = max((w for _, _, w, _ in boxes), default=0)
    row_w = max(widest, math.sqrt(area) * 1.15)
    spots, x, y, row_h = [], 0.0, 0.0, 0.0
    for _, _, w, h in boxes:
        if x > 0 and x + w > row_w:
            x, y, row_h = 0.0, y + row_h + gap, 0.0
        spots.append((20.0 + x, 20.0 + y))
        x += w + gap
        row_h = max(row_h, h)
    return spots


def main() -> int:
    plan = json.load(sys.stdin)
    board = pcbnew.BOARD()

    # Nets first: a pad can only be put on a net the board already knows.
    nets = {}
    for net in plan.get("nets", []):
        name = net.get("name") or ""
        if not name or name in nets:
            continue
        item = pcbnew.NETINFO_ITEM(board, name)
        board.Add(item)
        nets[name] = item
    where = {(n["ref"], str(n["pin"])): net["name"]
             for net in plan.get("nets", [])
             for n in net.get("nodes", []) if net.get("name")}

    placed, missing, xs, ys = 0, [], [], []
    gap = plan.get("gap", 1.5)                 # between two parts' extents
    margin = plan.get("margin", 3.0)           # from the outermost part to the edge

    comps = plan.get("components", [])
    loaded = []
    for i, comp in enumerate(comps):
        path = Path(comp["footprint"])
        fp = pcbnew.FootprintLoad(str(path.parent), path.stem)
        if fp is None:
            missing.append(f"{comp.get('ref')} ({path.stem})")
            continue
        fp.SetPosition(at(0, 0))
        box = extent(fp)
        loaded.append((comp, fp, box))

    ordered = cluster(loaded, plan.get("nets", []))
    spots = shelves([box for _, _, box in ordered], gap)

    for (comp, fp, box), (x, y) in zip(ordered, spots):
        # The shelf gives where the part's extent starts; the footprint is
        # positioned by its own origin, which sits somewhere inside that.
        fp.SetPosition(at(x - box[0], y - box[1]))
        fp.SetReference(comp.get("ref") or f"U{placed}")
        # A plated hole with no net and no copper ring round it is a
        # locating peg, which is an unplated hole. EasyEDA draws the pegs
        # of its USB-C footprints this way, and KiCad reads them as pads
        # with negative annular width that crowd their neighbours.
        for pad in fp.Pads():
            if pad.GetAttribute() != pcbnew.PAD_ATTRIB_PTH or pad.GetNumber():
                continue
            drill = pad.GetDrillSize()
            size = pad.GetSize()
            if min(size.x, size.y) <= min(drill.x, drill.y):
                pad.SetAttribute(pcbnew.PAD_ATTRIB_NPTH)
                pad.SetSize(drill)
        if comp.get("value"):
            fp.SetValue(str(comp["value"]))
        for pad in fp.Pads():
            name = where.get((comp.get("ref"), pad.GetNumber()))
            if name and name in nets:
                pad.SetNet(nets[name])
        board.Add(fp)
        placed += 1
        xs += [x, x + box[2]]
        ys += [y, y + box[3]]

    # The outline. Without one there is no board, only parts in space, and
    # the 3D export comes out empty.
    if not xs:
        xs, ys = [20.0], [20.0]
    x0, x1 = min(xs) - margin, max(xs) + margin
    y0, y1 = min(ys) - margin, max(ys) + margin
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    for j, (ax, ay) in enumerate(corners):
        bx, by = corners[(j + 1) % 4]
        line = pcbnew.PCB_SHAPE(board)
        line.SetShape(pcbnew.SHAPE_T_SEGMENT)
        line.SetStart(at(ax, ay))
        line.SetEnd(at(bx, by))
        line.SetLayer(pcbnew.Edge_Cuts)
        line.SetWidth(int(0.1 * MM))
        board.Add(line)

    out = plan.get("out", "/work/board.kicad_pcb")
    pcbnew.SaveBoard(out, board)
    json.dump({"placed": placed, "missing": missing,
               "size_mm": [round(x1 - x0, 2), round(y1 - y0, 2)],
               "nets": len(nets), "out": out}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
