"""A board as a mechanical component.

A `.pcb` is not only a circuit: it is a slab with holes in it and parts
standing on it, and the enclosure round it has to fit that. Fusion's way -
and now this one - is that the board *is* the component. There is no
second "3D model of the board" document to export, keep in step and
forget: every layout of the board (backend/kicad.py) also writes

- `step`    the board with its parts, from `kicad-cli pcb export step`,
            in the board's own frame (below);
- `board3d` the named data a 3D design reads: outline, thickness,
            mounting holes, connectors and edge parts, every body's box,
            a height map - JSON;
- `stl`     the GLB's triangles in the same frame, for a slicer.

and a 3D model uses it by importing it, as it imports any other part:

    import demoboard_gerber_zip as B     # the board's module, generated
    B.part        # the STEP, imported on first use
    B.HOLES       # [Hole(x, y, d, ref), ...]
    B.THICKNESS   # 1.6

backend/links.py writes that module into the build directory and rebuilds
whatever imports the board when a new layout changes it.

The frame
    Millimetres. The origin is the lower-left corner of the outline's
    bounding box, +X right, +Y up (KiCad's page has y down), +Z out of the
    top copper; the board's bottom face is z = 0, its top z = THICKNESS.
    The STEP is exported with that origin (`--user-origin`), the GLB's
    bodies and the STL are moved into it here, so all three agree.

The STEP has what the GLB has, seated the same way: both are KiCad's
export of the same .kicad_pcb, and the seating (backend/modelseat.py) is
in the footprints' model offsets, which both read. A part whose only model
is a WRL is the exception: KiCad cannot put a mesh into a STEP, and the GLB
has it only because modelseat merges it in afterwards. Those parts are in
`BODIES` with `kind="wrl"`, and the module stands a box of their size in
for them, so a cut-out for a part never misses one.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import struct

# Bumped when the named data changes shape: a module built against an
# older one is regenerated, never read with the wrong field names.
DATA_VERSION = 2          # 2: holes say how much room is above and below them

# A connector by its reference: J1, P2, CN1, USB1, UART2, HDR3.
CONNECTOR_REF = re.compile(r"^(J|P|CN|CON|CONN|USB|UART|HDR|JP)\d+$", re.I)
CONNECTOR_WORDS = ("conn", "usb", "header", "pinheader", "jst", "terminal", "socket")
# How close to the edge a part's body has to come to be an edge part, mm.
EDGE_NEAR = 1.5
# The height map's cell, mm.
CELL = 2.0
# A mounting hole: KiCad's MountingHole footprints (and the free holes the
# placer turns into them), or a lone hole on an H-reference.
MOUNTING_REF = re.compile(r"^(H|MH)\d+$", re.I)


# ---------------------------------------------------------------- the GLB

def _glb_parts(glb: bytes) -> tuple[dict | None, bytes]:
    if len(glb) < 20 or glb[:4] != b"glTF":
        return None, b""
    length = struct.unpack_from("<I", glb, 8)[0]
    pos, doc, bin_ = 12, None, b""
    while pos < length:
        size, kind = struct.unpack_from("<II", glb, pos)
        data = glb[pos + 8:pos + 8 + size]
        if kind == 0x4E4F534A:
            doc = json.loads(data)
        elif kind == 0x004E4942:
            bin_ = bytes(data)
        pos += 8 + size
    return doc, bin_


def _local(node: dict):
    import numpy as np
    if "matrix" in node:
        return np.array(node["matrix"], dtype=float).reshape(4, 4).T
    m = np.eye(4)
    x, y, z, w = node.get("rotation") or (0.0, 0.0, 0.0, 1.0)
    rot = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    s = node.get("scale") or (1.0, 1.0, 1.0)
    m[:3, :3] = rot * np.array(s)
    m[:3, 3] = node.get("translation") or (0.0, 0.0, 0.0)
    return m


def _walk(doc: dict):
    """Every node with a mesh, its world matrix, and the name of the
    top-level node it hangs under (KiCad names a part's node by its ref)."""
    import numpy as np
    nodes = doc.get("nodes") or []
    scene = (doc.get("scenes") or [{}])[doc.get("scene", 0)]

    def go(i, parent, owner):
        node = nodes[i]
        world = parent @ _local(node)
        name = owner or node.get("name")
        if "mesh" in node:
            yield node["mesh"], world, name
        for c in node.get("children") or []:
            # A nameless root (KiCad's) hands each child its own name.
            yield from go(c, world, name)

    for i in scene.get("nodes") or []:
        yield from go(i, np.eye(4), None)


def _accessor(doc: dict, bin_: bytes, idx: int):
    import numpy as np
    acc = doc["accessors"][idx]
    view = doc["bufferViews"][acc["bufferView"]]
    kinds = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}
    width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc["type"]]
    dtype = np.dtype(kinds[acc["componentType"]])
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = view.get("byteStride")
    count = acc["count"]
    if stride and stride != width * dtype.itemsize:
        raw = np.frombuffer(bin_, dtype=np.uint8, count=stride * count, offset=start)
        rows = raw.reshape(count, stride)[:, :width * dtype.itemsize]
        return np.frombuffer(rows.tobytes(), dtype=dtype).reshape(count, width)
    return np.frombuffer(bin_, dtype=dtype, count=count * width, offset=start).reshape(count, width)


def to_board(points, frame: dict):
    """GLB points (metres, X page-x, Y up, Z page-y) in the board frame."""
    import numpy as np
    p = np.asarray(points, dtype=float) * 1000.0
    return np.stack([p[:, 0] - frame["x0"], frame["y1"] - p[:, 2], p[:, 1]], axis=1)


def glb_boxes(glb: bytes, frame: dict) -> dict[str, list[float]]:
    """Each named node's box in the board frame: [x0, y0, z0, x1, y1, z1].

    From the vertices, not the accessors' min/max: a turned part's own box
    turned is a box round a box, and an ESP32 module set at an angle came
    out 2.5 mm past where its STEP really ends."""
    import numpy as np
    doc, bin_ = _glb_parts(glb)
    if not doc:
        return {}
    out: dict[str, list[float]] = {}
    for mesh, world, name in _walk(doc):
        for prim in doc["meshes"][mesh].get("primitives") or []:
            pts = _accessor(doc, bin_, prim["attributes"]["POSITION"]).astype(float)
            if not len(pts):
                continue
            pts = to_board((np.c_[pts, np.ones(len(pts))] @ world.T)[:, :3], frame)
            box = [*pts.min(0).tolist(), *pts.max(0).tolist()]
            key = name or "?"
            if key in out:
                old = out[key]
                box = [min(old[i], box[i]) for i in range(3)] + [max(old[i], box[i]) for i in range(3, 6)]
            out[key] = box
    return {k: [round(v, 3) for v in b] for k, b in out.items()}


def glb_stl(glb: bytes, frame: dict) -> bytes:
    """The GLB's triangles as a binary STL, in the board frame."""
    import numpy as np
    doc, bin_ = _glb_parts(glb)
    if not doc:
        return b""
    tris = []
    for mesh, world, _name in _walk(doc):
        for prim in doc["meshes"][mesh].get("primitives") or []:
            if prim.get("mode", 4) != 4:
                continue
            pts = _accessor(doc, bin_, prim["attributes"]["POSITION"]).astype(float)
            pts = np.c_[pts, np.ones(len(pts))] @ world.T
            pts = to_board(pts[:, :3], frame)
            if "indices" in prim:
                idx = _accessor(doc, bin_, prim["indices"]).reshape(-1).astype(np.int64)
            else:
                idx = np.arange(len(pts))
            idx = idx[: len(idx) // 3 * 3].reshape(-1, 3)
            if np.linalg.det(world[:3, :3]) < 0:
                idx = idx[:, ::-1]
            tris.append(pts[idx])
    if not tris:
        return b""
    t = np.concatenate(tris).astype(np.float32)
    n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    length = np.linalg.norm(n, axis=1, keepdims=True)
    n = np.where(length > 0, n / np.where(length > 0, length, 1), 0).astype(np.float32)
    rec = np.zeros(len(t), dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
    rec["n"], rec["v"] = n, t
    head = b"Redline board, mm, board frame".ljust(80, b" ")
    return head + struct.pack("<I", len(t)) + rec.tobytes()


# ---------------------------------------------------------------- the data

def frame_of(info: dict) -> dict:
    x0, y0, x1, y1 = info["box"]
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1}


def _pt(frame: dict, x: float, y: float) -> list[float]:
    return [round(x - frame["x0"], 4), round(frame["y1"] - y, 4)]


def _ccw(loop: list[list[float]]) -> list[list[float]]:
    area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(loop, loop[1:] + loop[:1]))
    return loop if area >= 0 else loop[::-1]


def describe(info: dict, boxes: dict[str, list[float]]) -> dict:
    """The named data a 3D design reads, from what the container read of
    the board (docker/board3d.py) and the bodies' boxes from the GLB."""
    frame = frame_of(info)
    w = round(frame["x1"] - frame["x0"], 4)
    h = round(frame["y1"] - frame["y0"], 4)
    t = float(info.get("thickness") or 1.6)
    loops = info.get("outline") or []
    outline = _ccw([_pt(frame, *p) for p in loops[0]["outer"]]) if loops else \
        [[0, 0], [w, 0], [w, h], [0, h]]
    cutouts = [_ccw([_pt(frame, *p) for p in hole]) for lp in loops for hole in lp.get("holes") or []]
    cutouts += [_ccw([_pt(frame, *p) for p in lp["outer"]]) for lp in loops[1:]]

    feet = {f["ref"]: f for f in info.get("footprints") or []}
    holes, drills = [], []
    for hole in info.get("holes") or []:
        x, y = _pt(frame, hole["x"], hole["y"])
        row = {"x": x, "y": y, "d": hole["d"], "plated": bool(hole.get("plated")),
               "ref": hole.get("ref") or ""}
        fp = feet.get(hole.get("ref") or "") or {}
        mounting = "mountinghole" in (hole.get("footprint") or "").lower() \
            or (MOUNTING_REF.match(row["ref"]) and (fp.get("pads") or 0) <= 1)
        (holes if mounting else drills).append(row)

    bodies, connectors, edge_parts = [], [], []
    for ref, fp in sorted(feet.items()):
        models = [m.lower() for m in fp.get("models") or []]
        box = boxes.get(ref)
        kind = ("step" if any(m.endswith((".step", ".stp")) for m in models)
                else "wrl" if any(m.endswith(".wrl") for m in models) else None)
        cx, cy = _pt(frame, fp["x"], fp["y"])
        if box:
            bodies.append({"ref": ref, "box": box, "kind": kind or "mesh", "side": fp.get("side")})
        # The extent: the body where there is one, the pads otherwise.
        if box:
            ext = box
        else:
            bx0, by0, bx1, by1 = fp.get("box") or [fp["x"], fp["y"], fp["x"], fp["y"]]
            (ex0, ey1), (ex1, ey0) = _pt(frame, bx0, by0), _pt(frame, bx1, by1)
            ext = [ex0, ey0, t if fp.get("side") == "top" else 0, ex1, ey1, t]
        gaps = {"left": ext[0], "right": w - ext[3], "bottom": ext[1], "top": h - ext[4]}
        edge = min(gaps, key=gaps.get)
        near = gaps[edge] <= EDGE_NEAR
        is_conn = bool(CONNECTOR_REF.match(ref)) or any(
            word in (fp.get("footprint", "") + " " + fp.get("value", "")).lower()
            for word in CONNECTOR_WORDS)
        if not (near or is_conn):
            continue
        row = {"ref": ref, "value": fp.get("value") or "", "footprint": fp.get("footprint") or "",
               "side": fp.get("side"), "x": cx, "y": cy,
               "edge": edge if near else None,
               # Where along that edge its middle is: x for bottom/top, y for left/right.
               "along": round((ext[0] + ext[3]) / 2 if edge in ("bottom", "top")
                              else (ext[1] + ext[4]) / 2, 3) if near else None,
               # How far past the edge it sticks out (negative: inside it).
               "overhang": round(-gaps[edge], 3) if near else None,
               "width": round(ext[3] - ext[0] if edge in ("bottom", "top") else ext[4] - ext[1], 3),
               "height": round(ext[5] - t, 3) if fp.get("side") == "top" else round(-ext[2], 3),
               "box": [round(v, 3) for v in ext]}
        if is_conn:
            connectors.append(row)
        if near:
            edge_parts.append(row)

    # How much room a screw head or a nut has at each hole: the tallest
    # body (other than the hole's own footprint) within a hole's width of
    # its edge, above the top and below the bottom.
    def headroom(hole: dict) -> None:
        reach = hole["d"] / 2 + hole["d"]
        up = down = None
        for b in bodies:
            if b["ref"] == hole["ref"]:
                continue
            x0, y0, z0, x1, y1, z1 = b["box"]
            dx = max(x0 - hole["x"], 0, hole["x"] - x1)
            dy = max(y0 - hole["y"], 0, hole["y"] - y1)
            if math.hypot(dx, dy) > reach:
                continue
            if z1 > t:
                up = max(up or 0.0, z1 - t)
            if z0 < 0:
                down = max(down or 0.0, -z0)
        hole["above"] = round(up, 3) if up is not None else None
        hole["below"] = round(down, 3) if down is not None else None

    for hole in holes + drills:
        headroom(hole)

    top = [b for b in bodies if b["box"][5] > t]
    bottom = [b for b in bodies if b["box"][2] < 0]
    everything = [b["box"] for b in bodies] + [[0, 0, 0, w, h, t]]
    bounds = [round(min(b[i] for b in everything), 3) for i in range(3)] + \
             [round(max(b[i] for b in everything), 3) for i in range(3, 6)]

    nx, ny = max(1, math.ceil(w / CELL)), max(1, math.ceil(h / CELL))
    grid = [[0.0] * nx for _ in range(ny)]
    for b in top:
        i0, i1 = max(0, int(b["box"][0] // CELL)), min(nx - 1, int(b["box"][3] // CELL))
        j0, j1 = max(0, int(b["box"][1] // CELL)), min(ny - 1, int(b["box"][4] // CELL))
        for j in range(j0, j1 + 1):
            for i in range(i0, i1 + 1):
                grid[j][i] = max(grid[j][i], round(b["box"][5] - t, 2))

    return {
        "data_version": DATA_VERSION,
        "size": [w, h], "thickness": t,
        "outline": outline, "cutouts": cutouts,
        "holes": holes, "drills": drills,
        "connectors": connectors, "edge_parts": edge_parts,
        "bodies": bodies,
        "keepout": {
            "top": round(max((b["box"][5] for b in top), default=t) - t, 3),
            "bottom": round(-min((b["box"][2] for b in bottom), default=0.0), 3),
            "bounds": bounds,
        },
        "height_map": {"cell": CELL, "nx": nx, "ny": ny, "top": grid},
        "approximate": [b["ref"] for b in bodies if b["kind"] == "wrl"],
    }


def step_digest(step: bytes) -> str:
    """The STEP's fingerprint without its header, which carries the time
    of export: the same board exported twice is the same geometry."""
    at = step.find(b"DATA;")
    return hashlib.sha256(step[at if at >= 0 else 0:]).hexdigest()


def data_digest(data: dict) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


# ---------------------------------------------------------------- the module

def module_name(board_id: str) -> str:
    """The name a model imports a board by: `demoboard-gerber-zip` is
    `demoboard_gerber_zip`."""
    name = re.sub(r"\W", "_", board_id.rpartition("@")[0] or board_id)
    return ("_" + name) if name[:1].isdigit() else name


MODULE = '''"""{title} - the .pcb board, as a component. Generated by Redline; do not edit.

Board {board!r}, version {version} ({digest}). Rebuilt by the server whenever
the board's layout changes, and so is every model that imports it.

    import {module} as B
    B.part          # the board with its parts (STEP), imported on first use
    B.simple        # the board slab with holes and a box per part: fast
    B.HOLES         # mounting holes: Hole(x, y, d, plated, ref, above, below)
    B.OUTLINE       # the outline, [(x, y), ...], counter-clockwise
    B.THICKNESS, B.SIZE, B.CONNECTORS, B.EDGE_PARTS, B.BODIES, B.KEEPOUT

Frame: mm, origin at the outline's lower-left corner, +Z out of the top,
board bottom at z = 0. Read the numbers from here; never copy them.
"""

import os
from pathlib import Path
from typing import NamedTuple

STANDALONE = os.environ.get("REDLINE_IMPORT_ONLY") != "1"
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "_boards" / {step_name!r}

BOARD = {board!r}
TITLE = {title!r}
VERSION = {version}
DIGEST = {digest!r}


class Hole(NamedTuple):
    x: float
    y: float
    d: float
    plated: bool = False
    ref: str = ""
    above: float | None = None      # the tallest part near it, above the top (None: clear)
    below: float | None = None      # and below the bottom


class Edge(NamedTuple):
    ref: str
    value: str
    footprint: str
    side: str
    x: float
    y: float
    edge: str | None
    along: float | None
    overhang: float | None
    width: float
    height: float
    box: tuple


class Body(NamedTuple):
    ref: str
    box: tuple
    kind: str
    side: str


SIZE = {size!r}
THICKNESS = {thickness!r}
OUTLINE = {outline!r}
CUTOUTS = {cutouts!r}
HOLES = [Hole(**h) for h in {holes!r}]
DRILLS = [Hole(**h) for h in {drills!r}]
CONNECTORS = [Edge(**c) for c in {connectors!r}]
EDGE_PARTS = [Edge(**c) for c in {edge_parts!r}]
BODIES = [Body(**{{**b, "box": tuple(b["box"])}}) for b in {bodies!r}]
KEEPOUT = {keepout!r}
HEIGHT_MAP = {height_map!r}
APPROXIMATE = {approximate!r}   # parts with a mesh only: a box stands in for them in `part`


def _slab():
    from build123d import Circle, Locations, Plane, Polygon, extrude, Pos
    sk = Polygon(*OUTLINE, align=None)
    for c in CUTOUTS:
        sk -= Polygon(*c, align=None)
    for h in HOLES + DRILLS:
        sk -= Pos(h.x, h.y) * Circle(h.d / 2)
    return extrude(sk, THICKNESS)


def _box(b):
    from build123d import Box, Pos, Align
    x0, y0, z0, x1, y1, z1 = b.box
    return Pos(x0, y0, z0) * Box(max(x1 - x0, 0.01), max(y1 - y0, 0.01), max(z1 - z0, 0.01),
                                 align=(Align.MIN, Align.MIN, Align.MIN))


def keepout(clearance: float = 0.0, side: str = "top"):
    """Every part's box on one side, grown by `clearance`: what an
    enclosure must leave room for."""
    from build123d import Box, Pos, Align, Compound
    out = []
    for b in BODIES:
        if b.side != side:
            continue
        x0, y0, z0, x1, y1, z1 = b.box
        c = clearance
        out.append(Pos(x0 - c, y0 - c, z0 - c) * Box(x1 - x0 + 2 * c, y1 - y0 + 2 * c, z1 - z0 + 2 * c,
                                                      align=(Align.MIN, Align.MIN, Align.MIN)))
    return Compound(children=out)


_cache = {{}}


def __getattr__(name):
    # The STEP is tens of megabytes and seconds to read: only when used.
    if name in ("part", "PARTS", "NAMES"):
        if "part" not in _cache:
            from build123d import Compound, Color, import_step
            whole = import_step(SRC)
            kids = list(whole.children) if whole.children else [whole]
            for b in BODIES:
                if b.ref in APPROXIMATE:
                    stand_in = _box(b)
                    stand_in.label, stand_in.color = b.ref + " (box)", Color(0.35, 0.35, 0.38)
                    kids.append(stand_in)
            part = Compound(label=BOARD, children=kids)
            _cache["part"] = part
        part = _cache["part"]
        if name == "part":
            return part
        return [part] if name == "PARTS" else [BOARD]
    if name == "simple":
        if "simple" not in _cache:
            from build123d import Color, Compound
            slab = _slab()
            slab.label, slab.color = "board", Color(0.1, 0.35, 0.2)
            boxes = []
            for b in BODIES:
                one = _box(b)
                one.label, one.color = b.ref, Color(0.3, 0.3, 0.32)
                boxes.append(one)
            _cache["simple"] = Compound(label=BOARD + " (simple)", children=[slab, *boxes])
        return _cache["simple"]
    raise AttributeError(name)
'''


def module_source(board_id: str, title: str, data: dict, version: int, digest: str,
                  step_name: str) -> str:
    def tup(rows):
        return [tuple(p) for p in rows]

    return MODULE.format(
        title=title or board_id, board=board_id, module=module_name(board_id),
        version=int(version), digest=digest[:12], step_name=step_name,
        size=tuple(data["size"]), thickness=data["thickness"],
        outline=tup(data["outline"]), cutouts=[tup(c) for c in data["cutouts"]],
        holes=data["holes"], drills=data["drills"],
        connectors=[{**c, "box": tuple(c["box"])} for c in data["connectors"]],
        edge_parts=[{**c, "box": tuple(c["box"])} for c in data["edge_parts"]],
        bodies=data["bodies"], keepout=data["keepout"], height_map=data["height_map"],
        approximate=data["approximate"])
