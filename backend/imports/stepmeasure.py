"""A part's real size, measured from its STEP.

A saved McMaster-Carr or GrabCAD item (backend/linked.py) says what it is
in words - "M3 x 30 mm Pan Head" - and the STEP dropped on it is the part
itself. This reads the STEP and says how big it is: the box it fills, in
millimetres along the file's own x, y and z (OpenCascade converts an inch
file to millimetres on reading), tight to the faces rather than to the
control points.

For a part that is shaped like a screw - round, one long axis, a wider
head at one end and a shank the rest of the way - it also says the head's
height, the length under the head (the length a screw is sold by) and the
shank's diameter. The part is sliced across its long axis (its mesh, cut
by 400 planes) and each slice's width read: the head is the run of wide
slices at one end, the shank the narrow rest. A countersunk head widens
gradually instead of in one step; such a screw is sold by its overall
length, so that is the length said. Anything else - a nut, a fan, a
standoff whose body is as wide as a head - gets the box alone: whether a
long round part is a screw is left to the caller, who has its name.

Run as a process of its own, like backend/imports/step3d.py: reading a
STEP holds the interpreter for a second or more.

    python -m backend.imports.stepmeasure in.step

prints one JSON line: {"size": [x, y, z], "axis": "z", "screw": {...} or
null, "solids": n, "seconds": s}, or {"error": "..."} with exit status 1.
An assembly - more than one solid - is its overall box and how many solids
it holds; it is never read as a screw (a screw with its nut is not one).
"""

from __future__ import annotations

import json
import sys
import time

SLICES = 400
# A head is at least this much wider than the shank, and the slices of a
# shank stay within SHANK_SPREAD of its median width (a thread's run-out
# and the fillet under the head included).
HEAD_RATIO = 1.35
SHANK_SPREAD = 1.2
# The two widths across the axis may differ this much and the part still
# count as round (a hex head's box is 1.155 to 1).
ROUND = 0.2


def _shape(src: str):
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_Reader
    reader = STEPControl_Reader()
    if reader.ReadFile(src) != IFSelect_RetDone:
        raise ValueError("not a STEP file OpenCascade can read")
    reader.TransferRoots()
    shape = reader.OneShape()
    if shape is None or shape.IsNull():
        raise ValueError("the STEP file has no shapes in it")
    return shape


def _box(shape):
    """The tight box: lower and upper corner."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    box = Bnd_Box()
    optimal = getattr(BRepBndLib, "AddOptimal_s", None) or BRepBndLib.AddOptimal
    optimal(shape, box, False, False)
    if box.IsVoid():
        raise ValueError("the STEP file has no shapes in it")
    lo, hi = box.CornerMin(), box.CornerMax()
    return [lo.X(), lo.Y(), lo.Z()], [hi.X(), hi.Y(), hi.Z()]


def _solids(shape) -> int:
    """How many solids the file holds: one for a part, more for an assembly."""
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    n, exp = 0, TopExp_Explorer(shape, TopAbs_SOLID)
    while exp.More():
        n += 1
        exp.Next()
    return n


def _triangles(shape, deflection: float):
    """Every triangle of the shape's mesh, as an (n, 3, 3) array."""
    import numpy as np
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRepTools import BRepTools
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS

    face = getattr(TopoDS, "Face_s", None) or TopoDS.Face     # OCP 8 dropped the _s
    triangulation = getattr(BRep_Tool, "Triangulation_s", None) or BRep_Tool.Triangulation
    BRepTools.Clean_s(shape)            # a triangulation the file brought would be used as is
    BRepMesh_IncrementalMesh(shape, deflection, False, 0.3, True)
    out = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        loc = TopLoc_Location()
        tri = triangulation(face(exp.Current()), loc)
        if tri is not None and tri.NbTriangles():
            tr = loc.Transformation()
            pts = []
            for i in range(1, tri.NbNodes() + 1):
                p = tri.Node(i).Transformed(tr)
                pts.append((p.X(), p.Y(), p.Z()))
            idx = np.array([tri.Triangle(i).Get() for i in range(1, tri.NbTriangles() + 1)]) - 1
            out.append(np.array(pts)[idx])
        exp.Next()
    return np.concatenate(out) if out else np.zeros((0, 3, 3))


def profile(tris, axis: int, lo: float, length: float, centre: tuple[float, float], n: int = SLICES):
    """Across n planes along `axis`: each slice's width (the larger of its
    two extents) and its reach from the axis through `centre`."""
    import numpy as np
    o = [i for i in range(3) if i != axis]
    a = tris[:, [0, 1, 2], :].reshape(-1, 3)
    b = tris[:, [1, 2, 0], :].reshape(-1, 3)
    ta, tb = a[:, axis], b[:, axis]
    widths, reach = [], []
    for i in range(n):
        t = lo + length * (i + 0.5) / n
        m = ((ta - t) * (tb - t) <= 0) & (ta != tb)
        if not m.any():
            widths.append(0.0)
            reach.append(0.0)
            continue
        k = ((t - ta[m]) / (tb[m] - ta[m]))[:, None]
        p = a[m] + k * (b[m] - a[m])
        u, v = p[:, o[0]], p[:, o[1]]
        widths.append(float(max(u.max() - u.min(), v.max() - v.min())))
        reach.append(float(np.hypot(u - centre[0], v - centre[1]).max()))
    return widths, reach


def screw(widths: list[float], reach: list[float], length: float) -> dict | None:
    """A head at one end and a shank the rest of the way, read off the
    slices; None when the profile is not that."""
    import statistics
    n = len(widths)
    if n < 20 or min(widths) <= 0:
        return None
    step = length / n
    d = statistics.median(widths)
    big = max(widths)
    if big < d * HEAD_RATIO:
        return None
    mid = (d + big) / 2
    wide = [i for i, w in enumerate(widths) if w > mid]
    # One run of wide slices, nearer one end than the middle.
    if wide[-1] - wide[0] + 1 - len(wide) > 2:
        return None
    first, last = wide[0], wide[-1]
    head_at_end = (n - 1 - last) < first          # the head is at the far end
    if head_at_end:
        head = range(first, n)
        shank = range(0, first)
        bottom = first
    else:
        head = range(0, last + 1)
        shank = range(last + 1, n)
        bottom = last + 1
    if len(shank) < n * 0.3:
        return None
    # The far side of the head (its domed top) may narrow again, but never
    # to the shank's width; the shank never reaches the head's.
    if any(widths[i] > d * SHANK_SPREAD for i in shank if abs(i - bottom) > n * 0.05):
        return None
    if any(widths[i] < d * SHANK_SPREAD for i in head if abs(i - bottom) > n * 0.05 and
           abs(i - (n - 1 if head_at_end else 0)) > n * 0.03):
        return None
    # A countersunk head widens over its height; a pan, cheese, socket or
    # hex head stands on the shank in one step, where the width crosses
    # half way. A cone's foot is where its taper meets the shank's width.
    toward = list(head) if head_at_end else list(reversed(head))
    full = next((j for j, i in enumerate(toward) if widths[i] >= big * 0.95), 0)
    countersunk = full > len(toward) * 0.5
    if countersunk:
        cone = [(j, widths[i]) for j, i in enumerate(toward) if d * SHANK_SPREAD < widths[i] < big * 0.9]
        if len(cone) < 3:
            return None
        slope = (cone[-1][1] - cone[0][1]) / (cone[-1][0] - cone[0][0])
        foot = cone[0][0] - (cone[0][1] - d) / slope if slope > 0 else 0
        head_h = (len(toward) - foot) * step
    else:
        head_h = len(head) * step
    shank_d = 2 * max(reach[i] for i in shank if abs(i - bottom) > n * 0.05)
    return {"head": round(head_h, 2), "head_d": round(big, 2), "shank": round(shank_d, 2),
            "under_head": round(length - head_h, 2), "overall": round(length, 2),
            "countersunk": countersunk, "length": round(length if countersunk else length - head_h, 2)}


def measure(src: str) -> dict:
    t0 = time.monotonic()
    shape = _shape(src)
    lo, hi = _box(shape)
    size = [hi[i] - lo[i] for i in range(3)]
    axis = max(range(3), key=lambda i: size[i])
    o = [i for i in range(3) if i != axis]
    solids = _solids(shape)
    out = {"size": [round(x, 2) for x in size], "axis": "xyz"[axis], "screw": None, "solids": solids}
    across = sorted(size[i] for i in o)
    # Only a round, long part is sliced: a fan or a bracket is its box, an assembly its overall box.
    if solids <= 1 and across[0] > 0 and (across[1] - across[0]) <= ROUND * across[1] \
            and size[axis] >= 1.25 * across[1]:
        diag = sum(x * x for x in size) ** 0.5
        tris = _triangles(shape, max(diag * 0.002, 0.002))
        if len(tris):
            centre = ((lo[o[0]] + hi[o[0]]) / 2, (lo[o[1]] + hi[o[1]]) / 2)
            widths, reach = profile(tris, axis, lo[axis], size[axis], centre)
            out["screw"] = screw(widths, reach, size[axis])
    out["seconds"] = round(time.monotonic() - t0, 2)
    return out


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: python -m backend.imports.stepmeasure in.step", file=sys.stderr)
        return 2
    try:
        print(json.dumps(measure(argv[0])))
    except Exception as exc:        # noqa: BLE001 - the caller reads the reason
        print(json.dumps({"error": str(exc)[:300] or type(exc).__name__}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
