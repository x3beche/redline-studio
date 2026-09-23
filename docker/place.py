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
      "pitch": 12.0, "margin": 8.0, "per_row": 5,
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

    pitch = plan.get("pitch", 12.0)
    margin = plan.get("margin", 8.0)
    per_row = plan.get("per_row", 5)

    placed, missing, xs, ys = 0, [], [], []
    for i, comp in enumerate(plan.get("components", [])):
        path = Path(comp["footprint"])
        fp = pcbnew.FootprintLoad(str(path.parent), path.stem)
        if fp is None:
            missing.append(f"{comp.get('ref')} ({path.stem})")
            continue
        x = 20.0 + (i % per_row) * pitch
        y = 20.0 + (i // per_row) * pitch
        fp.SetPosition(at(x, y))
        fp.SetReference(comp.get("ref") or f"U{i}")
        if comp.get("value"):
            fp.SetValue(str(comp["value"]))
        for pad in fp.Pads():
            name = where.get((comp.get("ref"), pad.GetNumber()))
            if name and name in nets:
                pad.SetNet(nets[name])
        board.Add(fp)
        placed += 1
        xs.append(x)
        ys.append(y)

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
