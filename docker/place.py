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


CONNECTOR_NAMES = ("CONN", "TYPE-C", "USB", "HDR", "HEADER", "JST", "PH-K", "TERMINAL")


def is_connector(fp) -> bool:
    """Something a cable plugs into, and so belongs on an edge.

    By name first - EasyEDA's connector footprints say what they are - and
    then by having through-hole pads on nets, which in a board of surface
    parts is nearly always a connector or a header.
    """
    name = str(fp.GetFPID().GetLibItemName()).upper()
    if any(k in name for k in CONNECTOR_NAMES):
        return True
    return any(p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH and p.GetNumber()
               for p in fp.Pads())


def mouth(fp) -> tuple[float, float]:
    """Which way a connector opens, as a vector, at its current turn.

    A receptacle's pads are at its back and its body reaches forward to
    the opening, so the opening is the way the body's centre sits from the
    pads' centre. A plain vertical header has no such offset, and no
    preferred way round.
    """
    x0, y0, w, h = extent(fp)
    pads = list(fp.Pads())
    if not pads:
        return (0.0, 0.0)
    px = sum(pd.GetPosition().x for pd in pads) / len(pads) / MM
    py = sum(pd.GetPosition().y for pd in pads) / len(pads) / MM
    return (x0 + w / 2 - px, y0 + h / 2 - py)


def face(fp, direction: tuple[float, float]) -> None:
    """Turn a connector so it opens towards `direction`, trying the four
    right-angle turns and keeping the one that points best. Measured, not
    worked out: which way KiCad counts a turn is not worth being wrong
    about."""
    import math

    best, best_score = 0, -2.0
    for turn in (0, 90, 180, 270):
        fp.SetOrientationDegrees(turn)
        mx, my = mouth(fp)
        length = math.hypot(mx, my)
        if length < 0.5:
            # No opening to point: lie along the edge instead.
            x0, y0, w, h = extent(fp)
            along = w >= h if direction[1] else h >= w
            score = 1.0 if along else 0.0
        else:
            score = (mx * direction[0] + my * direction[1]) / length
        if score > best_score:
            best, best_score = turn, score
    fp.SetOrientationDegrees(best)


def copper_reach(fp, box, edge: str) -> float:
    """How far inside the part's outline its copper starts, on one side.

    Measured at the part's current turn, with it at the origin: the gap
    between the outline's edge and the nearest pad's edge, on the side that
    will sit on the board's edge.
    """
    x0, y0, w, h = box
    left, top, right, bottom = [], [], [], []
    for pad in fp.Pads():
        b = pad.GetBoundingBox()
        left.append(b.GetX() / MM)
        top.append(b.GetY() / MM)
        right.append(b.GetRight() / MM)
        bottom.append(b.GetBottom() / MM)
    if not left:
        return 99.0
    return {"top": min(top) - y0, "bottom": (y0 + h) - max(bottom),
            "left": min(left) - x0, "right": (x0 + w) - max(right)}[edge]


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

    def put(fp, comp, x, y, box):
        """One part down: its extent's corner at (x, y), its reference and
        value, its pads on their nets, and peg holes made unplated."""
        fp.SetPosition(at(x - box[0], y - box[1]))
        fp.SetReference(comp.get("ref") or "U?")
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

    placed, missing, xs, ys = 0, [], [], []
    gap = plan.get("gap", 1.5)                 # between two parts' extents
    margin = plan.get("margin", 1.5)           # from the outermost part to the edge

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

    # The parts of each module packed as a block of their own, the way a
    # person lays a board out: power in one corner, the USB bridge in
    # another, the MCU in the middle. Connectors are not in any block -
    # they go on the edges, facing out, once the blocks are down.
    groups: dict[str, list] = {}
    connectors = []
    for item in loaded:
        comp, fp, _ = item
        if is_connector(fp):
            connectors.append(item)
        else:
            groups.setdefault(comp.get("group") or "", []).append(item)

    blocks = []                                # (name, parts, spots, w, h)
    for name in sorted(groups, key=lambda g: -len(groups[g])):
        ordered = cluster(groups[name], plan.get("nets", []))
        spots = shelves([box for _, _, box in ordered], gap)
        spots = [(x - 20.0, y - 20.0) for x, y in spots]
        w = max((x + box[2] for (_, _, box), (x, _) in zip(ordered, spots)), default=0)
        h = max((y + box[3] for (_, _, box), (_, y) in zip(ordered, spots)), default=0)
        blocks.append((name, ordered, spots, w, h))

    corners = shelves([(0, 0, w, h) for *_, w, h in blocks], plan.get("block_gap", 3.0))
    centre = {}
    for (name, ordered, spots, w, h), (bx, by) in zip(blocks, corners):
        for (comp, fp, box), (x, y) in zip(ordered, spots):
            put(fp, comp, bx + x, by + y, box)
            xs += [bx + x, bx + x + box[2]]
            ys += [by + y, by + y + box[3]]
            placed += 1
        centre[name] = (bx + w / 2, by + h / 2)

    if not xs:
        xs, ys = [20.0], [20.0]
    ix0, ix1 = min(xs) - margin, max(xs) + margin
    iy0, iy1 = min(ys) - margin, max(ys) + margin

    # Each connector to the edge nearest its own module, opening outwards,
    # its opening flush with the edge. Along the edge they queue up rather
    # than overlap.
    edges = {"top": (0, -1), "bottom": (0, 1), "left": (-1, 0), "right": (1, 0)}
    # KiCad's default copper-to-edge clearance, and a little over.
    edge_gap = plan.get("edge_clearance", 0.5) + 0.05
    taken = {e: [] for e in edges}
    flush = {}
    for comp, fp, _ in connectors:
        cx, cy = centre.get(comp.get("group") or "", ((ix0 + ix1) / 2, (iy0 + iy1) / 2))
        dist = {"top": cy - iy0, "bottom": iy1 - cy, "left": cx - ix0, "right": ix1 - cx}
        edge = min(dist, key=dist.get)
        face(fp, edges[edge])
        fp.SetPosition(at(0, 0))
        box = extent(fp)
        along = cx if edge in ("top", "bottom") else cy
        size = box[2] if edge in ("top", "bottom") else box[3]
        start = along - size / 2
        for a, b in sorted(taken[edge]):
            if start < b + gap and start + size > a - gap:
                start = b + gap
        taken[edge].append((start, start + size))
        # Flush means the part's outline on the edge - but copper still has
        # to keep its distance from a cut edge. A receptacle's body reaches
        # well past its pads, so flush is fine; a pin header's outline is a
        # hair outside its pads, and flush put them 0.465 mm from the edge
        # where 0.5 is the rule. So measure the copper, and step in by
        # whatever it is short.
        inset = max(0.0, edge_gap - copper_reach(fp, box, edge))
        if edge == "top":
            x, y = start, iy0 - box[3]
        elif edge == "bottom":
            x, y = start, iy1
        elif edge == "left":
            x, y = ix0 - box[2], start
        else:
            x, y = ix1, start
        # The edge is where the flush outline would be; only the part steps
        # in. Drawn around the stepped-in part, the edge came in with it and
        # the gap was the same 0.465 mm as before.
        xs += [x, x + box[2]]
        ys += [y, y + box[3]]
        dx, dy = {"top": (0, inset), "bottom": (0, -inset),
                  "left": (inset, 0), "right": (-inset, 0)}[edge]
        put(fp, comp, x + dx, y + dy, box)
        flush[edge] = True
        placed += 1

    # The outline: the parts plus a margin, except where a connector sits
    # on the edge - there the edge is the connector's front, so a plug
    # goes all the way in.
    x0 = min(xs) - (0 if flush.get("left") else margin)
    x1 = max(xs) + (0 if flush.get("right") else margin)
    y0 = min(ys) - (0 if flush.get("top") else margin)
    y1 = max(ys) + (0 if flush.get("bottom") else margin)
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
