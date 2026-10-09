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

The component frame - the one rule for a body drawn here
    A part can have bodies of our own besides LCSC's (backend/bodies.py):
    build123d models in the 3D room, bound to the part. Every one of them
    is drawn in this frame, and this is the only place it is written down:

    - millimetres;
    - the origin is the footprint's origin - the point KiCad puts at the
      part's position, (0, 0) of the .kicad_mod;
    - +Z up, out of the board's top surface; z = 0 is that surface (a
      through-hole part's leads go below 0, into and through the board);
    - +X is the footprint's +X;
    - +Y is the footprint's **-Y**: a .kicad_mod has +Y down the page, the
      frame is right-handed with +Z up. A pad at (x, y) in the .kicad_mod
      is at (x, -y, 0) here (`to_component`).

    That is KiCad's own 3D-model frame, so a drawn body is used as-is: its
    `(model ...)` block is offset 0, rotate 0, scale 1 (`with_body`), and
    KiCad turns it with the footprint and flips it with it onto the
    bottom, as it does any model. Nobody works out a seat or a pose for it,
    and a board's pose override (backend/poses.py) is not applied to a
    part that uses one - those numbers were measured for another body.
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


# ---- a WRL the board exporter cannot read ----------------------------------
#
# KiCad's STEP and GLB exports build the board in OpenCascade and take a
# part's model only as STEP (or IGES); a WRL is for its own 3D viewer and is
# left out without a word. Some LCSC parts come with nothing but the WRL
# easyeda2kicad makes from EasyEDA's mesh - the demo board's Q3, a SOT-23 -
# and were simply missing from the board's 3D model. A STEP made of the
# WRL's triangles was 47 MB for that SOT-23, so the WRL goes into the
# exported GLB instead, as the mesh it is: under the part's ref, placed the
# way KiCad places a model (checked against kicad-cli's own GLB for STEP
# parts at 0, 90 and 180 degrees, to the hundredth of a millimetre).

_SHAPE = re.compile(r"Shape\s*\{")
_COLOUR = re.compile(r"diffuseColor\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)")
_INDEX = re.compile(r"coordIndex\s*\[([^\]]*)\]")


def wrl_meshes(text: str) -> list[dict]:
    """Each Shape of a WRL: its points (mm), its triangles, its colour."""
    out = []
    starts = [m.start() for m in _SHAPE.finditer(text)] + [len(text)]
    for a, b in zip(starts, starts[1:]):
        chunk = text[a:b]
        pts_m, idx_m = _WRL_POINTS.search(chunk), _INDEX.search(chunk)
        if not pts_m or not idx_m:
            continue
        pts = []
        for triple in pts_m.group(1).split(","):
            v = triple.split()
            if len(v) == 3:
                pts.append(tuple(_num(x) * WRL_UNIT for x in v))
        tris, face = [], []
        for tok in idx_m.group(1).replace(",", " ").split():
            i = int(_num(tok, -1))
            if i < 0:
                # A polygon, fanned into triangles.
                tris += [(face[0], face[k], face[k + 1]) for k in range(1, len(face) - 1)]
                face = []
            else:
                face.append(i)
        if len(face) >= 3:
            tris += [(face[0], face[k], face[k + 1]) for k in range(1, len(face) - 1)]
        tris = [t for t in tris if max(t) < len(pts)]
        if not tris:
            continue
        colour = _COLOUR.search(chunk)
        out.append({"points": pts, "triangles": tris,
                    "colour": tuple(float(c) for c in colour.groups()) if colour else None})
    return out


_FP = re.compile(r'\n\t\(footprint "([^"]*)"')
_AT = re.compile(r"\(at\s+" + _NUM + r"\s+" + _NUM + r"(?:\s+" + _NUM + r")?\s*\)")


def board_footprints(pcb: str) -> list[dict]:
    """Every footprint of a .kicad_pcb: name, ref, where, which way, which
    side, and its model block's path, offset and rotation."""
    out = []
    starts = [m.start() for m in _FP.finditer(pcb)] + [len(pcb)]
    for a, b in zip(starts, starts[1:]):
        block = pcb[a:b]
        name = _FP.match(block).group(1)
        ref = re.search(r'\(property "Reference" "([^"]*)"', block)
        at_ = _AT.search(block)
        span = _model_span(block)
        model = re.match(r'\(model\s+"?([^"\s)]*)', block[span[0]:span[1]]).group(1) if span else None
        out.append({"name": name, "ref": ref.group(1) if ref else "",
                    "x": float(at_.group(1)), "y": float(at_.group(2)),
                    "angle": float(at_.group(3) or 0),
                    "flipped": '(layer "B.Cu")' in block[:400],
                    "model": model, "offset": offset_of(block), "rotation": rotation_of(block)})
    return out


def placed_points(points, fp: dict, thickness: float):
    """A model's points (mm, its own frame) where KiCad puts them on the
    board, in the GLB's frame: metres, X along the page, Y up, Z down the
    page. The model is turned by its `rotate`, moved by its `offset`,
    turned over for the bottom, turned with the footprint and put at it."""
    import numpy as np
    v = np.asarray(points, dtype=float) @ np.array(rotation_matrix(*fp["rotation"])).T
    v = v + np.array(fp["offset"])
    if fp["flipped"]:
        v = v * np.array([1.0, -1.0, -1.0])          # over about the footprint's X
    a = math.radians(fp["angle"])
    c, s = math.cos(a), math.sin(a)
    x = v[:, 0] * c - v[:, 1] * s
    y = v[:, 0] * s + v[:, 1] * c
    z = v[:, 2] + (0.0 if fp["flipped"] else thickness)
    page_x, page_y = x + fp["x"], -y + fp["y"]
    return np.stack([page_x, z, page_y], axis=1) / 1000.0


def add_meshes(glb: bytes, pcb: str, meshes: dict[str, str]) -> tuple[bytes, list[str]]:
    """The board's GLB with every WRL-only model put in: `meshes` is
    footprint name (the LCSC number) -> its WRL. Returns the GLB and the
    refs added. A part that already has a node of its own (KiCad exported
    a STEP for it) is left alone."""
    import json as _json
    import struct

    import numpy as np

    if len(glb) < 20 or glb[:4] != b"glTF":
        return glb, []
    length = struct.unpack_from("<I", glb, 8)[0]
    pos, doc, bin_ = 12, None, b""
    while pos < length:
        size, kind = struct.unpack_from("<II", glb, pos)
        data = glb[pos + 8:pos + 8 + size]
        if kind == 0x4E4F534A:
            doc = _json.loads(data)
        elif kind == 0x004E4942:
            bin_ = bytes(data)
        pos += 8 + size
    if doc is None:
        return glb, []
    m = re.search(r"\(thickness\s+" + _NUM, pcb)
    thickness = float(m.group(1)) if m else 1.6
    have = {n.get("name") for n in doc.get("nodes", [])}
    buf = bytearray(bin_)
    for key in ("bufferViews", "accessors", "meshes", "materials", "nodes"):
        doc.setdefault(key, [])
    scene = doc["scenes"][doc.get("scene", 0)]
    added = []

    def view(data: bytes, target: int) -> int:
        while len(buf) % 4:
            buf.append(0)
        doc["bufferViews"].append({"buffer": 0, "byteOffset": len(buf),
                                   "byteLength": len(data), "target": target})
        buf.extend(data)
        return len(doc["bufferViews"]) - 1

    for fp in board_footprints(pcb):
        text = meshes.get(fp["name"])
        if not text or fp["ref"] in have or not (fp["model"] or "").lower().endswith(".wrl"):
            continue
        prims = []
        for shape in wrl_meshes(text):
            pts = placed_points(shape["points"], fp, thickness).astype(np.float32)
            idx = np.asarray(shape["triangles"], dtype=np.uint32).reshape(-1)
            if fp["flipped"]:
                idx = idx.reshape(-1, 3)[:, ::-1].reshape(-1)    # keep the faces facing out
            pv = view(pts.tobytes(), 34962)
            iv = view(idx.tobytes(), 34963)
            doc["accessors"].append({"bufferView": pv, "componentType": 5126,
                                     "count": len(pts), "type": "VEC3",
                                     "min": pts.min(0).tolist(), "max": pts.max(0).tolist()})
            doc["accessors"].append({"bufferView": iv, "componentType": 5125,
                                     "count": int(idx.size), "type": "SCALAR"})
            colour = list(shape["colour"] or (0.6, 0.6, 0.6))
            doc["materials"].append({"pbrMetallicRoughness": {
                "baseColorFactor": colour + [1.0], "metallicFactor": 0.0,
                "roughnessFactor": 0.6}, "doubleSided": True})
            prims.append({"attributes": {"POSITION": len(doc["accessors"]) - 2},
                          "indices": len(doc["accessors"]) - 1,
                          "material": len(doc["materials"]) - 1})
        if not prims:
            continue
        doc["meshes"].append({"name": fp["ref"], "primitives": prims})
        doc["nodes"].append({"name": fp["ref"], "mesh": len(doc["meshes"]) - 1})
        scene.setdefault("nodes", []).append(len(doc["nodes"]) - 1)
        added.append(fp["ref"])
    if not added:
        return glb, []
    while len(buf) % 4:
        buf.append(0)
    doc.setdefault("buffers", [{}])
    doc["buffers"][0]["byteLength"] = len(buf)
    js = _json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    out = (struct.pack("<II", len(js), 0x4E4F534A) + js
           + struct.pack("<II", len(buf), 0x004E4942) + bytes(buf))
    return struct.pack("<III", 0x46546C67, 2, 12 + len(out)) + out, added


# ---- a drawn body, in the component frame (above) ----------------------------

def to_component(x: float, y: float) -> tuple[float, float]:
    """A point of the .kicad_mod (mm, +Y down the page) in the component
    frame (+Y the footprint's -Y)."""
    return (x + 0.0, -y + 0.0)


def body_block(path: str) -> str:
    """The `(model ...)` block for a body drawn in the component frame:
    nothing to seat, nothing to turn."""
    return (f'(model "{path}"\n\t\t(offset (xyz 0 0 0))\n\t\t(scale (xyz 1 1 1))'
            f'\n\t\t(rotate (xyz 0 0 0))\n\t)')


def _model_spans(text: str) -> list[tuple[int, int]]:
    out, at = [], 0
    while True:
        span = _model_span(text[at:])
        if not span:
            return out
        out.append((at + span[0], at + span[1]))
        at += span[1]


def with_model_block(footprint: str, block: str) -> str:
    """The footprint with `block` as its only 3D model: the first
    `(model ...)` replaced, any others dropped, or - when it names none -
    added before its closing bracket."""
    spans = _model_spans(footprint)
    if not spans:
        end = footprint.rstrip().rfind(")")
        if end < 0:
            return footprint
        return footprint[:end].rstrip() + "\n\t" + block + "\n" + footprint[end:]
    out, cursor = [], 0
    for i, (a, b) in enumerate(spans):
        out.append(footprint[cursor:a])
        if i == 0:
            out.append(block)
        else:
            # The whitespace before a dropped block goes with it.
            out[-1] = out[-1].rstrip(" \t\n")
        cursor = b
    out.append(footprint[cursor:])
    return "".join(out)


def with_body(footprint: str, path: str) -> str:
    """The footprint wearing a drawn body at `path` instead of its own."""
    return with_model_block(footprint, body_block(path))


def model_path_of(text: str) -> str | None:
    """The file the first `(model ...)` block names."""
    span = _model_span(text or "")
    if not span:
        return None
    m = re.match(r'\(model\s+"?([^"\s)]*)', text[span[0]:span[1]])
    return m.group(1) if m else None


def footprint_spans(pcb: str) -> dict[str, tuple[int, int]]:
    """Each footprint of a .kicad_pcb by its reference: where its block
    starts and ends."""
    out = {}
    starts = [m.start() for m in _FP.finditer(pcb)] + [len(pcb)]
    for a, b in zip(starts, starts[1:]):
        ref = re.search(r'\(property "Reference" "([^"]*)"', pcb[a:b])
        if ref:
            out[ref.group(1)] = (a, b)
    return out


def with_ref_model(pcb: str, ref: str, block: str) -> str:
    """A .kicad_pcb with one footprint's 3D model replaced by `block`."""
    span = footprint_spans(pcb).get(ref)
    if not span:
        return pcb
    a, b = span
    return pcb[:a] + with_model_block(pcb[a:b], block) + pcb[b:]


def model_block_of(text: str) -> str | None:
    """The first `(model ...)` block, as written."""
    span = _model_span(text or "")
    return text[span[0]:span[1]] if span else None


def placed_box(box: Box, rotation: tuple[float, float, float],
               offset: tuple[float, float, float]) -> Box:
    """A model's box (its own frame) where its block puts it: turned, then
    moved - in KiCad's 3D frame, which is the component frame."""
    (x0, y0, z0), (x1, y1, z1) = turned_box(box, rotation)
    ox, oy, oz = offset
    return (x0 + ox, y0 + oy, z0 + oz), (x1 + ox, y1 + oy, z1 + oz)


def with_turn(block: str, rotate=None, offset=None) -> str:
    """A `(model ...)` block with its rotation and/or offset replaced
    (None: that one as it is) - a board's pose (backend/poses.py)."""
    fmt = lambda v: " ".join(f"{float(x):g}" for x in v)
    if offset is not None:
        block = with_offset(block, tuple(float(x) for x in offset))
    if rotate is not None:
        rot = f"(rotate (xyz {fmt(rotate)}))"
        if _ROTATE.search(block):
            block = _ROTATE.sub(lambda _: rot, block, count=1)
        else:
            block = block.rstrip()[:-1].rstrip() + "\n\t\t" + rot + "\n\t)"
    return block
