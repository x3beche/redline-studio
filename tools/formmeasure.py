#!/usr/bin/env python3
"""What a part's form is made of, measured from its STEP: the numbers a
taste palette's form language is written from (backend/taste.py).

    python3 formmeasure.py <dir of .step files> <out.json>

Runs in the drawing image (docker/draw, build123d's OCP), started by the
server with no network, like tools/techdraw.py. Each STEP is one of the
designer's own parts (bought parts are left out by the caller). For each:

- size: the bounding box, mm;
- fillets: rounded edges, by radius - convex (an outside edge rounded) and
  concave (an inside corner: a pocket's, an opening's), and which convex
  ones round vertical edges (axis along Z: the corners of a box seen from
  above) - cylinders and tori that are less than a whole turn;
- holes: whole cylinders, by diameter;
- chamfers: narrow planar faces at a slant to the part's axes, and cones
  (a hole's countersink), by width;
- walls: how thick the material is under the larger flat faces - a ray
  from each face straight in, to where it comes out;
- steps: flat faces parallel to a larger one and a little in front of it
  (raised: an embossed icon, a lip) or behind it (recessed: a debossed
  label, a button well, an inset panel), by depth;
- colours: the colours the STEP gives its faces, by area.

Everything is rounded (0.1 mm; colours to their hex) and counted, so the
output is small. A part that cannot be read is listed with its error.
Standard library and OCP only.
"""

from __future__ import annotations

import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepGProp import BRepGProp
from OCP.Bnd import Bnd_Box
from OCP.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Plane, GeomAbs_Torus
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.STEPControl import STEPControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.collections import Sequence_TDF_Label as TDF_LabelSequence
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.XCAFDoc import XCAFDoc_ColorGen, XCAFDoc_ColorSurf, XCAFDoc_DocumentTool
from OCP.Quantity import Quantity_Color
from OCP.gp import gp_Lin, gp_Pnt, gp_Vec, gp_Dir
from OCP.BRepClass import BRepClass_FaceClassifier
from OCP.TopAbs import TopAbs_IN
from OCP.gp import gp_Pnt2d

MAX_FACES = 6000          # a part with more is measured on its first this many
WALL_RAYS = 80            # flat faces a ray is cast from, largest first
WALL_MAX = 15.0           # thicker than this is a block, not a wall
STEP_DEPTH = (0.1, 4.0)   # a parallel face this far in front or behind is a step
CHAMFER_MAX = 3.0         # a slanted strip this narrow is a chamfer
FILLET_MAX = 40.0         # a partial cylinder bigger than this is a curved wall, not a fillet


def r1(x: float) -> float:
    return round(x * 10) / 10


def read(path: Path):
    rd = STEPControl_Reader()
    if rd.ReadFile(str(path)) != IFSelect_RetDone:
        raise ValueError("not a readable STEP")
    rd.TransferRoots()
    return rd.OneShape()


def colours(path: Path) -> dict[str, float]:
    """Face or shape colours the STEP carries, by the area they cover, mm²."""
    doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    rd = STEPCAFControl_Reader()
    rd.SetColorMode(True)
    if rd.ReadFile(str(path)) != IFSelect_RetDone or not rd.Transfer(doc):
        return {}
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ctool = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    labels = TDF_LabelSequence()
    tool.GetShapes(labels)
    out: dict[str, float] = defaultdict(float)

    def srgb(v):                                    # Quantity_Color is linear; a person reads sRGB
        return 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055

    def colour_of(shape) -> str | None:
        c = Quantity_Color()
        if not any(ctool.GetColor(shape, t, c) for t in (XCAFDoc_ColorSurf, XCAFDoc_ColorGen)):
            return None
        return "#" + "".join(f"{max(0, min(255, round(srgb(v) * 255))):02x}" for v in (c.Red(), c.Green(), c.Blue()))

    for i in range(1, labels.Length() + 1):
        shape = tool.GetShape_s(labels.Value(i))
        whole = colour_of(shape)
        exp = TopExp_Explorer(shape, TopAbs_FACE)
        while exp.More():
            face = exp.Current()
            exp.Next()
            hexc = colour_of(face) or whole
            if not hexc:
                continue
            p = GProp_GProps()
            BRepGProp.SurfaceProperties_s(face, p)
            out[hexc] += p.Mass()
    return {k: round(v) for k, v in out.items()}


def normal_at(ad: BRepAdaptor_Surface, face, u: float, v: float) -> tuple[gp_Pnt, gp_Vec] | None:
    p, du, dv = gp_Pnt(), gp_Vec(), gp_Vec()
    ad.D1(u, v, p, du, dv)
    n = du.Crossed(dv)
    if n.Magnitude() < 1e-12:
        return None
    n.Normalize()
    if face.Orientation() == TopAbs_REVERSED:
        n.Reverse()
    return p, n


def measure(path: Path) -> dict:
    shape = read(path)
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    lo, hi = box.CornerMin(), box.CornerMax()
    x0, y0, z0, x1, y1, z1 = lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z()
    out: dict = {"size": [r1(x1 - x0), r1(y1 - y0), r1(z1 - z0)]}
    convex, concave, vertical, holes, chamfers = Counter(), Counter(), Counter(), Counter(), Counter()
    planes: list[tuple[float, gp_Vec, float, object, gp_Pnt]] = []   # area, normal, offset, face, point
    n_faces = 0
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More() and n_faces < MAX_FACES:
        face = TopoDS.Face(exp.Current())
        exp.Next()
        n_faces += 1
        ad = BRepAdaptor_Surface(face, True)
        kind = ad.GetType()
        u0, u1, v0, v1 = ad.FirstUParameter(), ad.LastUParameter(), ad.FirstVParameter(), ad.LastVParameter()
        if not all(math.isfinite(t) for t in (u0, u1, v0, v1)):
            continue
        um, vm = (u0 + u1) / 2, (v0 + v1) / 2
        got = normal_at(ad, face, um, vm)
        if not got:
            continue
        p, n = got
        props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(face, props)
        area = props.Mass()
        if kind == GeomAbs_Plane:
            o = gp_Vec(p.X(), p.Y(), p.Z()).Dot(n)
            planes.append((area, n, o, face, p))
            # A slanted strip: a chamfer, by its width.
            axis_aligned = max(abs(n.X()), abs(n.Y()), abs(n.Z())) > 0.995
            if not axis_aligned:
                longest = max(u1 - u0, v1 - v0)
                width = area / longest if longest > 0 else 0
                if 0.05 < width <= CHAMFER_MAX:
                    chamfers[r1(width)] += 1
        elif kind == GeomAbs_Cylinder:
            cyl = ad.Cylinder()
            r = cyl.Radius()
            ax = cyl.Axis()
            span = u1 - u0
            a = ax.Location()
            d = gp_Vec(ax.Direction())
            ap = gp_Vec(a, p)
            radial = ap - d.Multiplied(ap.Dot(d))
            out_side = radial.Dot(n) > 0
            if span >= 2 * math.pi - 1e-3:
                if not out_side:
                    holes[r1(2 * r)] += 1
                continue
            if span > math.pi + 0.2 and not out_side:
                holes[r1(2 * r)] += 1            # a hole split in two faces: counted per half
                continue
            if r > FILLET_MAX:
                continue
            if out_side:
                convex[r1(r)] += 1
                if abs(d.Z()) > 0.995:
                    vertical[r1(r)] += 1
            else:
                concave[r1(r)] += 1
        elif kind == GeomAbs_Torus:
            t = ad.Torus()
            r = t.MinorRadius()
            c = t.Location()
            zd = gp_Vec(t.Axis().Direction())
            cp = gp_Vec(c, p)
            inplane = cp - zd.Multiplied(cp.Dot(zd))
            if inplane.Magnitude() < 1e-9:
                continue
            ring = gp_Pnt(c.X(), c.Y(), c.Z()).Translated(inplane.Normalized().Multiplied(t.MajorRadius()))
            radial = gp_Vec(ring, p)
            (convex if radial.Dot(n) > 0 else concave)[r1(r)] += 1
        elif kind == GeomAbs_Cone:
            slant = v1 - v0
            if 0.05 < slant <= CHAMFER_MAX:
                chamfers[r1(slant)] += 1
    # Walls: from each larger flat face straight in, to where the material ends.
    walls = Counter()
    hit = IntCurvesFace_ShapeIntersector()
    hit.Load(shape, 1e-6)
    for area, n, o, face, p in sorted(planes, key=lambda x: -x[0])[:WALL_RAYS]:
        if area < 20:
            break
        ad = BRepAdaptor_Surface(face, True)
        uv = gp_Pnt2d((ad.FirstUParameter() + ad.LastUParameter()) / 2,
                      (ad.FirstVParameter() + ad.LastVParameter()) / 2)
        if BRepClass_FaceClassifier(face, uv, 1e-6).State() != TopAbs_IN:
            continue                                  # the middle of its box is not on it (an L, a ring)
        start = p.Translated(n.Multiplied(-0.001))
        hit.Perform(gp_Lin(start, gp_Dir(n.Reversed())), 0.0, WALL_MAX + 1)
        best = min((hit.WParameter(i) for i in range(1, hit.NbPnt() + 1)
                    if hit.WParameter(i) > 0.05), default=None)
        if best is not None and best <= WALL_MAX:
            walls[r1(best)] += 1
    # Steps: a face parallel to a larger one with the same facing, a little
    # in front of it (raised) or behind it (recessed).
    groups: dict[tuple, list] = defaultdict(list)
    for area, n, o, face, p in planes:
        groups[(round(n.X(), 2), round(n.Y(), 2), round(n.Z(), 2))].append((area, o))
    raised, recessed = Counter(), Counter()
    for rows in groups.values():
        rows.sort(key=lambda x: -x[0])
        a0, o0 = rows[0]
        for area, o in rows[1:]:
            dz = o - o0
            if STEP_DEPTH[0] <= abs(dz) <= STEP_DEPTH[1] and area < 0.5 * a0:
                (raised if dz > 0 else recessed)[r1(abs(dz))] += 1
    def top(c: Counter, k: int = 8) -> list:
        return [[v, n] for v, n in c.most_common(k)]
    out.update(faces=n_faces, fillets_convex=top(convex), fillets_concave=top(concave),
               vertical_corners=top(vertical), holes=top(holes), chamfers=top(chamfers),
               walls=top(walls, 6), raised=top(raised, 6), recessed=top(recessed, 6))
    try:
        out["colours"] = colours(path)
    except Exception as exc:                          # noqa: BLE001 - colours are a nicety
        out["colours_error"] = str(exc)[:200]
    return out


def main() -> None:
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    result = {}
    for f in sorted(src.glob("*.step")):
        try:
            result[f.stem] = measure(f)
        except Exception as exc:                      # noqa: BLE001 - one part's failure is said, not fatal
            result[f.stem] = {"error": f"{type(exc).__name__}: {str(exc)[:200]}"}
        print(f"@measured {f.stem}", flush=True)
    dst.write_text(json.dumps(result))


if __name__ == "__main__":
    main()
