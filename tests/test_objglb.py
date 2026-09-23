"""EasyEDA OBJ to GLB, checked on the bytes that come out.

The converter is what stands between somebody else's file and the page:
if it drops a colour, flips the part on its side or writes a buffer three
cannot read, the preview is wrong in a way nobody would think to check.
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import objglb

# A unit cube's top face in two materials, the way EasyEDA writes it:
# materials inline, faces as `f a// b// c//`, Z up.
OBJ = """\
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 2
v 1 0 2
v 1 1 2
newmtl 1
Ka 0.1 0.1 0.1
Kd 0.25 0.25 0.25
Ks 0.5 0.5 0.5
d 0.0
endmtl
newmtl 2
Kd 0.8 0.7 0.1
endmtl
usemtl 1
f 1// 2// 3//
f 1// 3// 4//
usemtl 2
f 1// 2// 6// 5//
"""


def _read(glb: bytes) -> tuple[dict, bytes]:
    magic, version, total = struct.unpack_from("<III", glb, 0)
    assert magic == 0x46546C67, "not a GLB"
    assert version == 2
    assert total == len(glb), "the header's length is the file's length"
    jlen, jtype = struct.unpack_from("<II", glb, 12)
    assert jtype == 0x4E4F534A
    doc = json.loads(glb[20:20 + jlen])
    blen, btype = struct.unpack_from("<II", glb, 20 + jlen)
    assert btype == 0x004E4942
    assert jlen % 4 == 0 and blen % 4 == 0, "chunks are 4-byte aligned"
    return doc, glb[28 + jlen:28 + jlen + blen]


def _array(doc: dict, blob: bytes, accessor: int) -> np.ndarray:
    acc = doc["accessors"][accessor]
    view = doc["bufferViews"][acc["bufferView"]]
    dtype = {5126: np.float32, 5123: np.uint16, 5125: np.uint32}[acc["componentType"]]
    width = {"VEC3": 3, "SCALAR": 1}[acc["type"]]
    data = np.frombuffer(blob, dtype=dtype, count=acc["count"] * width,
                         offset=view["byteOffset"])
    return data.reshape(-1, width) if width > 1 else data


def test_it_is_a_glb_three_can_open():
    doc, blob = _read(objglb.convert(OBJ))
    assert doc["asset"]["version"] == "2.0"
    assert doc["buffers"][0]["byteLength"] == len(blob)


def test_one_primitive_per_material_with_its_colour():
    doc, _ = _read(objglb.convert(OBJ))
    colours = {m["name"]: m["pbrMetallicRoughness"]["baseColorFactor"][:3]
               for m in doc["materials"]}
    assert colours == {"1": [0.25, 0.25, 0.25], "2": [0.8, 0.7, 0.1]}
    assert len(doc["meshes"][0]["primitives"]) == 2


def test_z_up_becomes_y_up():
    # The cube is 2 tall in Z. On a board it has to be 2 tall in Y, or the
    # part in the preview is lying on its side.
    doc, _ = _read(objglb.convert(OBJ))
    lo = np.min([doc["accessors"][p["attributes"]["POSITION"]]["min"]
                 for p in doc["meshes"][0]["primitives"]], axis=0)
    hi = np.max([doc["accessors"][p["attributes"]["POSITION"]]["max"]
                 for p in doc["meshes"][0]["primitives"]], axis=0)
    assert (hi - lo)[1] == pytest.approx(2.0)


def test_a_quad_is_two_triangles():
    doc, blob = _read(objglb.convert(OBJ))
    quad = doc["meshes"][0]["primitives"][1]
    assert doc["accessors"][quad["indices"]]["count"] == 6


def test_indices_point_at_the_primitives_own_vertices():
    doc, blob = _read(objglb.convert(OBJ))
    for prim in doc["meshes"][0]["primitives"]:
        points = _array(doc, blob, prim["attributes"]["POSITION"])
        index = _array(doc, blob, prim["indices"])
        assert index.max() < len(points)
        # small parts stay in 16-bit indices, half the size
        assert doc["accessors"][prim["indices"]]["componentType"] == 5123


def test_min_and_max_match_the_positions():
    # glTF requires them on POSITION, and a viewer frames the model by them.
    doc, blob = _read(objglb.convert(OBJ))
    for prim in doc["meshes"][0]["primitives"]:
        acc = prim["attributes"]["POSITION"]
        points = _array(doc, blob, acc)
        assert points.min(axis=0).tolist() == pytest.approx(doc["accessors"][acc]["min"])
        assert points.max(axis=0).tolist() == pytest.approx(doc["accessors"][acc]["max"])


def test_a_material_that_was_never_defined_is_grey():
    doc, _ = _read(objglb.convert("v 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl 9\nf 1// 2// 3//\n"))
    assert doc["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"][:3] == \
        list(objglb.GREY)


def test_an_empty_model_says_so():
    with pytest.raises(ValueError):
        objglb.convert("# nothing here\n")
