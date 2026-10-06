"""What a board is, mechanically - read with KiCad's own library.

Runs inside the KiCad container, never on the machine:

    python3 /work/board3d.py /work/board.kicad_pcb  ->  JSON on stdout

The outline and its cutouts, the thickness, every drilled hole and every
footprint (where, which side, which way, its pads' extent). Millimetres on
KiCad's page (y down); backend/board3d.py moves it into the board's own
frame and adds the 3D bodies from the GLB.
"""

import json
import sys

import pcbnew

MM = 1_000_000


def mm(v) -> float:
    return round(v / MM, 4)


def chain(poly) -> list[list[float]]:
    return [[mm(poly.CPoint(i).x), mm(poly.CPoint(i).y)] for i in range(poly.PointCount())]


def main(path: str) -> dict:
    board = pcbnew.LoadBoard(path)
    outlines = pcbnew.SHAPE_POLY_SET()
    ok = board.GetBoardPolygonOutlines(outlines)
    loops = []
    for i in range(outlines.OutlineCount()):
        loops.append({"outer": chain(outlines.Outline(i)),
                      "holes": [chain(outlines.Hole(i, j)) for j in range(outlines.HoleCount(i))]})
    xs = [p[0] for lp in loops for p in lp["outer"]]
    ys = [p[1] for lp in loops for p in lp["outer"]]
    if not xs:
        box = board.GetBoardEdgesBoundingBox()
        xs, ys = [mm(box.GetX()), mm(box.GetRight())], [mm(box.GetY()), mm(box.GetBottom())]

    feet, holes = [], []
    for fp in board.GetFootprints():
        name = str(fp.GetFPID().GetLibItemName())
        pos = fp.GetPosition()
        pads = []
        for pad in fp.Pads():
            p = pad.GetPosition()
            size = pad.GetSize()
            drill = pad.GetDrillSize()
            entry = {"x": mm(p.x), "y": mm(p.y), "w": mm(size.x), "h": mm(size.y)}
            if drill.x > 0:
                entry["drill"] = mm(min(drill.x, drill.y))
                npth = pad.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH
                holes.append({"x": mm(p.x), "y": mm(p.y), "d": mm(min(drill.x, drill.y)),
                              "plated": not npth, "ref": fp.GetReference(),
                              "footprint": name, "net": pad.GetNetname() or "",
                              "mounting": npth or "mountinghole" in name.lower()})
            pads.append(entry)
        try:
            bb = fp.GetBoundingBox(False, False)
        except TypeError:
            bb = fp.GetBoundingBox(False)
        feet.append({"ref": fp.GetReference(), "value": fp.GetValue(), "footprint": name,
                     "x": mm(pos.x), "y": mm(pos.y), "angle": fp.GetOrientationDegrees(),
                     "side": "bottom" if fp.IsFlipped() else "top",
                     "box": [mm(bb.GetX()), mm(bb.GetY()), mm(bb.GetRight()), mm(bb.GetBottom())],
                     "models": [str(m.m_Filename) for m in fp.Models()],
                     "pads": len(pads)})
    return {"ok": bool(ok), "outline": loops,
            "box": [min(xs), min(ys), max(xs), max(ys)],
            "thickness": mm(board.GetDesignSettings().GetBoardThickness()),
            "footprints": feet, "holes": holes}


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1] if len(sys.argv) > 1 else "/work/board.kicad_pcb")))
