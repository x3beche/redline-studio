"""A mesh's size: the box an STL, OBJ or 3MF fills.

The STEP measurer (stepmeasure.py) reads a B-rep with OpenCascade; a mesh
is only triangles, so its box is read here, in this process, with numpy:
the smallest and largest corner over every vertex. An STL and an OBJ carry
no unit - CAD tools write them in millimetres, so that is assumed and said;
a 3MF names its unit (`<model unit="inch">`) and is turned into millimetres.

A GLB is not read (a scene of nodes with their own transforms): it says so.
Nothing here is a screw - a mesh is its box.

    measure("part.stl", data) -> {"size": [x, y, z], "unit": "assumed mm" | "mm",
                                  "vertices": n} or raises ValueError
"""

from __future__ import annotations

import io
import re
import struct
import zipfile
from pathlib import PurePosixPath

# How a 3MF's unit becomes millimetres (3MF Core Specification, "unit").
UNITS = {"micron": 0.001, "millimeter": 1.0, "centimeter": 10.0, "inch": 25.4, "foot": 304.8, "meter": 1000.0}
_FLOAT = rb"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"


def _box(pts) -> list[float]:
    import numpy as np
    a = np.asarray(pts, dtype=float).reshape(-1, 3)
    if not len(a) or not np.isfinite(a).all():
        raise ValueError("the mesh has no vertices in it")
    return [round(float(x), 2) for x in a.max(axis=0) - a.min(axis=0)]


def _stl(data: bytes):
    import numpy as np
    if len(data) >= 84:
        n = struct.unpack_from("<I", data, 80)[0]
        if 84 + n * 50 == len(data):                      # binary: the size says so, whatever the header says
            rec = np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
            return np.frombuffer(data, dtype=rec, count=n, offset=84)["v"].reshape(-1, 3), n * 3
    pts = re.findall(rb"vertex\s+(" + _FLOAT + rb")\s+(" + _FLOAT + rb")\s+(" + _FLOAT + rb")", data)
    if not pts:
        raise ValueError("not an STL: no binary triangles and no ASCII vertices")
    return [[float(x) for x in p] for p in pts], len(pts)


def _obj(data: bytes):
    pts = re.findall(rb"(?m)^\s*v\s+(" + _FLOAT + rb")\s+(" + _FLOAT + rb")\s+(" + _FLOAT + rb")", data)
    if not pts:
        raise ValueError("not an OBJ: no vertices (v x y z) in it")
    return [[float(x) for x in p] for p in pts], len(pts)


def _3mf(data: bytes):
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ValueError("not a 3MF: it is not a ZIP package") from exc
    models = [n for n in z.namelist() if n.lower().endswith(".model")]
    if not models:
        raise ValueError("not a 3MF: there is no 3D model part in it")
    pts, scale = [], 1.0
    for n in models:
        xml = z.read(n)
        if m := re.search(rb"<model\b[^>]*\bunit=\"(\w+)\"", xml):
            scale = UNITS.get(m.group(1).decode().lower(), 1.0)
        for v in re.finditer(rb"<vertex\b([^>]*)/?>", xml):
            a = dict(re.findall(rb"\b([xyz])=\"(" + _FLOAT + rb")\"", v.group(1)))
            if len(a) == 3:
                pts.append([float(a[b"x"]) * scale, float(a[b"y"]) * scale, float(a[b"z"]) * scale])
    if not pts:
        raise ValueError("the 3MF has no vertices in it")
    return pts, len(pts)


def measure(name: str, data: bytes) -> dict:
    sfx = PurePosixPath(name.lower()).suffix
    if sfx == ".stl":
        pts, n = _stl(data)
        unit = "assumed mm"
    elif sfx == ".obj":
        pts, n = _obj(data)
        unit = "assumed mm"
    elif sfx == ".3mf":
        pts, n = _3mf(data)
        unit = "mm"
    else:
        raise ValueError(f"a {sfx.lstrip('.').upper() or 'file'} mesh is not measured - only STL, OBJ and 3MF")
    return {"size": _box(pts), "unit": unit, "vertices": n}
