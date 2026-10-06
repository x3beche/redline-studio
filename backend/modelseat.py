"""Where an LCSC part's 3D body sits on its pads.

EasyEDA places a part's 3D model with a node in the footprint: `c_origin`
(where the model goes, in canvas units), `z` (how far down it starts) and
an outline of the model drawn in footprint coordinates. easyeda2kicad
1.0.1 bakes that placement into the WRL's vertices - centred in XY, bottom
at z=0, then moved by the EasyEDA translation - but writes the footprint's
`(offset (xyz 0 0 0))` and copies the STEP as it came. The board exporter
uses the STEP, so every LCSC body stood wherever its STEP's own origin
happened to be: a header 8.9 mm off its pins, chip resistors half sunk
into the board.

So the offset is worked out here, from the model the board will actually
use: its own bounding box, turned the way KiCad will turn it, moved so its
centre lands on EasyEDA's placement and its bottom at EasyEDA's z. That is
the same thing the WRL baking does, done for whichever file is used - and
for a WRL that is already baked it comes out as (nearly) nothing, so the
placement is never applied twice.

KiCad's conventions, checked against kicad-cli's own STEP export:

- the offset is in mm in the 3D frame, +Y up (the footprint's -Y);
- the model is rotated first, then moved by the offset;
- `(rotate (xyz rx ry rz))` turns by -rz about Z, then -ry about Y, then
  -rx about X (glm::rotate with the negated angles).
"""

from __future__ import annotations

import json
import math
import os
import re
import tempfile

# Written beside a seated part, so a later change to the arithmetic can
# find the parts seated the old way.
VERSION = 1
# One EasyEDA canvas unit is 10 mil.
CANVAS = 0.254
# easyeda2kicad's outline correction: when the outline's centre is more
# than this far from c_origin, the outline wins.
OUTLINE_FIX = 0.1
# A WRL from easyeda2kicad is in KiCad's VRML unit, 0.1 inch.
WRL_UNIT = 2.54

Box = tuple[tuple[float, float, float], tuple[float, float, float]]


def _num(text, default: float = 0.0) -> float:
    try:
        return float(text)
    except (TypeError, ValueError):
        return default


def _model_node(component: dict) -> dict | None:
    """The footprint's 3D node: the one tagged outline3D, else the first
    SVGNODE (which is what easyeda2kicad reads)."""
    shapes = ((component.get("packageDetail") or {}).get("dataStr") or {}) \
        .get("shape") or []
    first = None
    for shape in shapes:
        if not isinstance(shape, str) or not shape.startswith("SVGNODE~"):
            continue
        try:
            node = json.loads(shape.split("~", 1)[1])
        except (ValueError, IndexError):
            continue
        if not isinstance(node, dict):
            continue
        if (node.get("attrs") or {}).get("c_etype") == "outline3D":
            return node
        first = first or node
    return first


def placement(component: dict) -> tuple[float, float, float] | None:
    """EasyEDA's placement of the model, in mm, KiCad's 3D frame (+Y up):
    where the body's XY centre goes and where its bottom goes.

    The same arithmetic as easyeda2kicad's `parse_3d_model_info`, so a WRL
    it baked and a STEP seated here end up in the same place. None when
    the part has no 3D node.
    """
    node = _model_node(component)
    if not node:
        return None
    attrs = node.get("attrs") or {}
    head = ((component.get("packageDetail") or {}).get("dataStr") or {}) \
        .get("head") or {}
    ox, oy = _num(head.get("x")), _num(head.get("y"))
    co = (attrs.get("c_origin") or "0,0").split(",")
    tx = (_num(co[0] if co else 0) - ox) * CANVAS
    ty = -(_num(co[1] if len(co) > 1 else 0) - oy) * CANVAS
    tz = _num(attrs.get("z")) * CANVAS

    xs, ys = [], []
    for child in node.get("childNodes") or []:
        pts = ((child or {}).get("attrs") or {}).get("points", "").split()
        for i in range(0, len(pts) - 1, 2):
            xs.append((_num(pts[i]) - ox) * CANVAS)
            ys.append(-(_num(pts[i + 1]) - oy) * CANVAS)
    if xs:
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        if abs(cx - tx) > OUTLINE_FIX or abs(cy - ty) > OUTLINE_FIX:
            tx, ty = cx, cy
    return tx, ty, tz


def rotation_matrix(rx: float, ry: float, rz: float) -> list[list[float]]:
    """What KiCad does with `(rotate (xyz rx ry rz))`: Rz(-rz)·Ry(-ry)·Rx(-rx)."""
    def rot(axis: int, deg: float):
        a = math.radians(-deg)
        c, s = math.cos(a), math.sin(a)
        # Snap so 90° turns stay exact and a bbox does not grow by 1e-16.
        c, s = round(c, 12), round(s, 12)
        if axis == 0:
            return [[1, 0, 0], [0, c, -s], [0, s, c]]
        if axis == 1:
            return [[c, 0, s], [0, 1, 0], [-s, 0, c]]
        return [[c, -s, 0], [s, c, 0], [0, 0, 1]]

    def mul(a, b):
        return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)]
                for i in range(3)]

    return mul(mul(rot(2, rz), rot(1, ry)), rot(0, rx))


def turned_box(box: Box, rotation: tuple[float, float, float]) -> Box:
    """The axis-aligned box around `box` once KiCad has turned it.

    Exact for turns in steps of 90° (all of LCSC's), a slight overestimate
    otherwise.
    """
    m = rotation_matrix(*rotation)
    (x0, y0, z0), (x1, y1, z1) = box
    pts = [[sum(m[i][k] * p[k] for k in range(3)) for i in range(3)]
           for p in ((x, y, z) for x in (x0, x1) for y in (y0, y1)
                     for z in (z0, z1))]
    lo = tuple(min(p[i] for p in pts) for i in range(3))
    hi = tuple(max(p[i] for p in pts) for i in range(3))
    return lo, hi


def seat(box: Box, rotation: tuple[float, float, float],
         place: tuple[float, float, float]) -> tuple[float, float, float]:
    """The `(offset (xyz ...))` that puts a model with bounding box `box`
    (its own coordinates, mm) where EasyEDA placed it: the turned box's XY
    centre on `place`'s XY, its bottom at `place`'s Z."""
    (x0, y0, z0), (x1, y1, _) = turned_box(box, rotation)
    tx, ty, tz = place
    out = (tx - (x0 + x1) / 2, ty - (y0 + y1) / 2, tz - z0)
    return tuple(0.0 if abs(v) < 5e-4 else round(v, 3) for v in out)


# ---- the model's own box -----------------------------------------------------

_POINT = re.compile(
    r"CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*([-+\d.eE]+)\s*,\s*"
    r"([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\s*\)")


def _points_box(pts) -> Box | None:
    pts = list(pts)
    if not pts:
        return None
    return (tuple(min(p[i] for p in pts) for i in range(3)),
            tuple(max(p[i] for p in pts) for i in range(3)))


def step_box_by_points(blob: bytes) -> Box | None:
    """A STEP's box from its CARTESIAN_POINTs - no CAD kernel needed, but
    rough: it misses the round side of a cylinder and takes in b-spline
    control points. Only for when OpenCascade is not there."""
    text = blob.decode("latin-1", errors="replace")
    return _points_box((float(a), float(b), float(c))
                       for a, b, c in _POINT.findall(text))


def step_box(blob: bytes) -> Box | None:
    """A STEP's bounding box in mm, as OpenCascade reads it."""
    try:
        from OCP.Bnd import Bnd_Box
        from OCP.BRepBndLib import BRepBndLib
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.STEPControl import STEPControl_Reader
    except ImportError:
        return step_box_by_points(blob)
    fd, path = tempfile.mkstemp(suffix=".step")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(blob)
        reader = STEPControl_Reader()
        if reader.ReadFile(path) != IFSelect_RetDone:
            return step_box_by_points(blob)
        reader.TransferRoots()
        shape = reader.OneShape()
        if shape.IsNull():
            return step_box_by_points(blob)
        bb = Bnd_Box()
        BRepBndLib.AddOptimal_s(shape, bb, False, False)
        if bb.IsVoid():
            return step_box_by_points(blob)
        lo, hi = bb.CornerMin(), bb.CornerMax()
        return (lo.X(), lo.Y(), lo.Z()), (hi.X(), hi.Y(), hi.Z())
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


_WRL_POINTS = re.compile(r"point\s*\[([^\]]*)\]")


def wrl_box(text: str) -> Box | None:
    """A WRL's box in mm (its points are in 0.1 inch)."""
    def pts():
        for block in _WRL_POINTS.findall(text):
            for triple in block.split(","):
                v = triple.split()
                if len(v) == 3:
                    yield tuple(_num(x) * WRL_UNIT for x in v)
    return _points_box(pts())


def model_box(blob: bytes, kind: str) -> Box | None:
    if kind == "wrl":
        return wrl_box(blob.decode("utf-8", errors="replace"))
    return step_box(blob)


# ---- the footprint's model block ---------------------------------------------

_MODEL = re.compile(r"\(model\s+")
_NUM = r"([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)"
_XYZ = r"\(xyz\s+" + _NUM + r"\s+" + _NUM + r"\s+" + _NUM + r"\s*\)"
_OFFSET = re.compile(r"\(offset\s*" + _XYZ + r"\s*\)")
_ROTATE = re.compile(r"\(rotate\s*" + _XYZ + r"\s*\)")


def _model_span(text: str) -> tuple[int, int] | None:
    """Start and end of the first `(model ...)` block, brackets balanced."""
    m = _MODEL.search(text)
    if not m:
        return None
    depth, i, quoted = 0, m.start(), False
    while i < len(text):
        ch = text[i]
        if ch == '"' and text[i - 1] != "\\":
            quoted = not quoted
        elif not quoted:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    return m.start(), i + 1
        i += 1
    return None


def has_model(text: str) -> bool:
    return _model_span(text or "") is not None


def rotation_of(text: str) -> tuple[float, float, float]:
    span = _model_span(text or "")
    m = _ROTATE.search(text[span[0]:span[1]]) if span else None
    return tuple(float(v) for v in m.groups()) if m else (0.0, 0.0, 0.0)


def offset_of(text: str) -> tuple[float, float, float]:
    span = _model_span(text or "")
    m = _OFFSET.search(text[span[0]:span[1]]) if span else None
    return tuple(float(v) for v in m.groups()) if m else (0.0, 0.0, 0.0)


def with_offset(text: str, offset: tuple[float, float, float]) -> str:
    """The footprint with its model's offset set to `offset`."""
    span = _model_span(text)
    if not span:
        return text
    block = text[span[0]:span[1]]
    xyz = "(offset (xyz {:.3f} {:.3f} {:.3f}))".format(*offset)
    if _OFFSET.search(block):
        block = _OFFSET.sub(lambda _: xyz, block, count=1)
    else:
        # Right after the path: `(model "x.step"` + the offset.
        head = re.match(r'\(model\s+("(?:[^"\\]|\\.)*"|\S+)', block)
        cut = head.end() if head else len("(model")
        block = block[:cut] + " " + xyz + block[cut:]
    return text[:span[0]] + block + text[span[1]:]


def seated(footprint: str, blob: bytes, kind: str,
           component: dict) -> tuple[str, tuple[float, float, float]] | None:
    """The footprint with its model seated on its pads, and the offset.
    None when there is nothing to go on: no model block, no EasyEDA 3D
    node, or a model whose box cannot be read."""
    if not has_model(footprint):
        return None
    place = placement(component)
    if place is None:
        return None
    box = model_box(blob, kind)
    if box is None:
        return None
    off = seat(box, rotation_of(footprint), place)
    return with_offset(footprint, off), off
