"""An assembled board's STEP as a GLB, with every part named by its ref.

EasyEDA (and most ECAD exporters) write an assembled board as one STEP
assembly: the bare board, its copper and silkscreen as solids of their
own, then one sub-assembly per placed part whose product name is
`U2~WIFIM-SMD_ESP32-WROOM-32-N4~ESP32-WROOM-32~BYvA` - the designator,
the footprint, the 3D model's name, a document tag. The page finds a part
in the 3D view by its designator (SPEC §5: `U2`, `LED3`, `OLED_MODULE`),
so the names are cut back to the part before the first `~` and the board
body is called `Board`.

OpenCascade does all of it - reading the assembly with its names and
colours (XCAF), meshing, writing glTF - so this is a thin script. It is
run as its own process: reading a 35 MB STEP holds the interpreter for
seconds, and a request thread is no place for that.

    python -m backend.imports.step3d in.step out.glb [--deflection 0.1]

prints one JSON line: parts found, their footprints, triangles, seconds.
"""

from __future__ import annotations

import json
import sys
import time

# Linear deflection in millimetres and angular deflection in radians. KiCad's
# own GLB export of a board lands in the same range: fine enough that an
# 0402 is not a box of four triangles, coarse enough that a 35 MB STEP
# comes out a few megabytes.
LINEAR = 0.1
ANGULAR = 0.5

# Layers EasyEDA writes as solids of their own, and what they are called here.
LAYER_NAMES = {"board": "Board"}


def split_product(name: str) -> tuple[str, str | None]:
    """`U2~WIFIM-SMD_ESP32~ESP32~BYvA` -> ("U2", "WIFIM-SMD_ESP32")."""
    bits = (name or "").split("~")
    ref = bits[0].strip()
    foot = bits[1].strip() if len(bits) > 2 and bits[1].strip() else None
    return ref, foot


def convert(src: str, dst: str, linear: float = LINEAR, angular: float = ANGULAR) -> dict:
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Message import Message_ProgressRange
    from OCP.RWGltf import RWGltf_CafWriter
    from OCP.RWMesh import (RWMesh_CoordinateSystem_glTF, RWMesh_CoordinateSystem_Zup,
                            RWMesh_NameFormat_Instance, RWMesh_NameFormat_Product)
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
    from OCP.TColStd import TColStd_IndexedDataMapOfStringString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_Label, TDF_LabelSequence
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFDoc import XCAFDoc_DocumentTool

    t0 = time.monotonic()
    doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)
    reader.SetLayerMode(False)
    if reader.ReadFile(src) != IFSelect_RetDone:
        raise ValueError("not a STEP file OpenCascade can read")
    if not reader.Transfer(doc):
        raise ValueError("the STEP file has no shapes in it")
    read_s = time.monotonic() - t0

    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())

    def name_of(label) -> str:
        attr = TDataStd_Name()
        if label.FindAttribute(TDataStd_Name.GetID_s(), attr):
            return attr.Get().ToExtString()
        return ""

    def rename(label, text: str) -> None:
        TDataStd_Name.Set_s(label, TCollection_ExtendedString(text))

    parts: dict[str, str | None] = {}
    layers: list[str] = []
    seen_products: set = set()

    def walk(label, depth: int) -> None:
        kids = TDF_LabelSequence()
        tool.GetComponents_s(label, kids, False)
        for i in range(1, kids.Length() + 1):
            inst = kids.Value(i)
            product = TDF_Label()
            if not tool.GetReferredShape_s(inst, product):
                continue
            raw = name_of(product)
            ref, foot = split_product(raw)
            if depth == 0 and ref:
                short = LAYER_NAMES.get(ref.lower(), ref)
                # The instance carries the designator; the product may be
                # shared between two parts of the same kind in some
                # exporters, so it is renamed only the first time.
                rename(inst, short)
                if product.Tag() not in seen_products:
                    rename(product, short)
                    seen_products.add(product.Tag())
                if "~" in raw and foot is not None:
                    parts[short] = foot
                else:
                    layers.append(short)
            elif depth > 0:
                rename(inst, f"{walk.owner}.{i}")
            if depth == 0 and ref and "~" in raw:
                walk.owner = short
                walk(product, depth + 1)

    walk.owner = ""
    free = TDF_LabelSequence()
    tool.GetFreeShapes(free)
    for i in range(1, free.Length() + 1):
        top = free.Value(i)
        # The assembly itself; "Board" is the bare board inside it.
        rename(top, "PCB")
        walk(top, 0)

    # Mesh every distinct solid once; instances share the mesh.
    t1 = time.monotonic()
    shapes = TDF_LabelSequence()
    tool.GetShapes(shapes)
    for i in range(1, shapes.Length() + 1):
        label = shapes.Value(i)
        if tool.IsAssembly_s(label):
            continue
        shape = tool.GetShape_s(label)
        BRepMesh_IncrementalMesh(shape, linear, False, angular, True)
    mesh_s = time.monotonic() - t1

    t2 = time.monotonic()
    writer = RWGltf_CafWriter(TCollection_AsciiString(dst), True)
    conv = writer.ChangeCoordinateSystemConverter()
    conv.SetInputLengthUnit(0.001)                 # STEP in mm, glTF in metres
    conv.SetInputCoordinateSystem(RWMesh_CoordinateSystem_Zup)
    conv.SetOutputCoordinateSystem(RWMesh_CoordinateSystem_glTF)
    writer.SetNodeNameFormat(RWMesh_NameFormat_Instance)
    writer.SetMeshNameFormat(RWMesh_NameFormat_Product)
    writer.SetParallel(True)
    meta = TColStd_IndexedDataMapOfStringString()
    if not writer.Perform(doc, meta, Message_ProgressRange()):
        raise RuntimeError("OpenCascade could not write the GLB")
    write_s = time.monotonic() - t2
    return {"parts": parts, "layers": layers,
            "seconds": {"read": round(read_s, 1), "mesh": round(mesh_s, 1),
                        "write": round(write_s, 1)}}


def flat_board(width_mm: float, height_mm: float, thick_mm: float = 1.6) -> bytes:
    """A bare board as a GLB when there is no STEP: a green slab the size
    of the outline's box, one node called `Board`, in metres like the
    rest (glTF is Y-up; the board lies in X-Z with its top at +Y)."""
    import struct

    w, d, t = width_mm / 1000, height_mm / 1000, thick_mm / 1000
    x = (0, w)
    y = (-t, 0)
    z = (-d, 0)
    # 24 vertices (4 per face) so each face is flat without normals.
    faces = [
        [(x[0], y[1], z[0]), (x[0], y[1], z[1]), (x[1], y[1], z[1]), (x[1], y[1], z[0])],  # top
        [(x[0], y[0], z[0]), (x[1], y[0], z[0]), (x[1], y[0], z[1]), (x[0], y[0], z[1])],  # bottom
        [(x[0], y[0], z[1]), (x[1], y[0], z[1]), (x[1], y[1], z[1]), (x[0], y[1], z[1])],  # front
        [(x[0], y[0], z[0]), (x[0], y[1], z[0]), (x[1], y[1], z[0]), (x[1], y[0], z[0])],  # back
        [(x[0], y[0], z[0]), (x[0], y[0], z[1]), (x[0], y[1], z[1]), (x[0], y[1], z[0])],  # left
        [(x[1], y[0], z[0]), (x[1], y[1], z[0]), (x[1], y[1], z[1]), (x[1], y[0], z[1])],  # right
    ]
    pos = [c for f in faces for p in f for c in p]
    idx = [i for k in range(6) for i in (4 * k, 4 * k + 1, 4 * k + 2, 4 * k, 4 * k + 2, 4 * k + 3)]
    vb = struct.pack(f"<{len(pos)}f", *pos)
    ib = struct.pack(f"<{len(idx)}H", *idx)
    blob = vb + ib
    doc = {
        "asset": {"version": "2.0", "generator": "redline imports"},
        "scene": 0, "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "Board", "mesh": 0}],
        "meshes": [{"name": "Board", "primitives": [{"attributes": {"POSITION": 0}, "indices": 1,
                                                     "material": 0}]}],
        "materials": [{"name": "soldermask", "pbrMetallicRoughness": {
            "baseColorFactor": [0.05, 0.3, 0.12, 1.0], "metallicFactor": 0.0,
            "roughnessFactor": 0.6}}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(pos) // 3, "type": "VEC3",
             "min": [x[0], y[0], z[0]], "max": [x[1], y[1], z[1]]},
            {"bufferView": 1, "componentType": 5123, "count": len(idx), "type": "SCALAR"}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(vb), "target": 34962},
                        {"buffer": 0, "byteOffset": len(vb), "byteLength": len(ib), "target": 34963}],
        "buffers": [{"byteLength": len(blob) + (-len(blob) % 4)}],
    }
    blob += b"\0" * (-len(blob) % 4)
    head = json.dumps(doc, separators=(",", ":")).encode()
    head += b" " * (-len(head) % 4)
    return b"".join([
        struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(head) + 8 + len(blob)),
        struct.pack("<II", len(head), 0x4E4F534A), head,
        struct.pack("<II", len(blob), 0x004E4942), blob])


def main(argv: list[str]) -> int:
    src, dst = argv[0], argv[1]
    linear = float(argv[argv.index("--deflection") + 1]) if "--deflection" in argv else LINEAR
    try:
        out = convert(src, dst, linear)
    except Exception as exc:                        # noqa: BLE001
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 1
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
