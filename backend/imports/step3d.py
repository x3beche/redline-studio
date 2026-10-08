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
    python -m backend.imports.step3d in.step out.glb --preview

prints one JSON line: parts found, their footprints, triangles, seconds.
`--preview` is the Files tab's (backend/filemesh.py): any STEP, as it is.
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


def _sequence():
    try:
        from OCP.TDF import TDF_LabelSequence
    except ImportError:                 # OCP 7.8: the sequence is a collection
        from OCP.OCP.collections import Sequence_TDF_Label as TDF_LabelSequence
    return TDF_LabelSequence


def _read(src: str):
    """The STEP as an XCAF document: shapes with their names and colours."""
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDocStd import TDocStd_Document

    doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)
    reader.SetLayerMode(False)
    if reader.ReadFile(src) != IFSelect_RetDone:
        raise ValueError("not a STEP file OpenCascade can read")
    if not reader.Transfer(doc):
        raise ValueError("the STEP file has no shapes in it")
    return doc


def _mesh(tool, linear: float, angular: float) -> int:
    """Mesh every distinct solid once (instances share the mesh); the
    triangles made."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRepTools import BRepTools
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS

    face = getattr(TopoDS, "Face_s", None) or TopoDS.Face     # OCP 8 dropped the _s
    shapes = _sequence()()
    tool.GetShapes(shapes)
    triangles = 0
    for i in range(1, shapes.Length() + 1):
        label = shapes.Value(i)
        if tool.IsAssembly_s(label):
            continue
        shape = tool.GetShape_s(label)
        # A STEP may carry a triangulation of its own; the deflection is
        # silently ignored on a shape that has one (AGENTS.md).
        BRepTools.Clean_s(shape)
        BRepMesh_IncrementalMesh(shape, linear, False, angular, True)
        exp = TopExp_Explorer(shape, TopAbs_FACE)
        while exp.More():
            tri = BRep_Tool.Triangulation_s(face(exp.Current()), TopLoc_Location())
            if tri is not None:
                triangles += tri.NbTriangles()
            exp.Next()
    return triangles


def _write(doc, dst: str, merge: bool = False) -> None:
    from OCP.Message import Message_ProgressRange
    from OCP.RWGltf import RWGltf_CafWriter
    from OCP.RWMesh import (RWMesh_CoordinateSystem_glTF, RWMesh_CoordinateSystem_Zup,
                            RWMesh_NameFormat_Instance, RWMesh_NameFormat_Product)
    from OCP.TCollection import TCollection_AsciiString
    try:
        from OCP.TColStd import TColStd_IndexedDataMapOfStringString as Meta
    except ImportError:                 # OCP 7.8: a collection too
        from OCP.OCP.collections import IndexedDataMap_TCollection_AsciiString_TCollection_AsciiString as Meta

    writer = RWGltf_CafWriter(TCollection_AsciiString(dst), True)
    conv = writer.ChangeCoordinateSystemConverter()
    conv.SetInputLengthUnit(0.001)                 # STEP in mm, glTF in metres
    conv.SetInputCoordinateSystem(RWMesh_CoordinateSystem_Zup)
    conv.SetOutputCoordinateSystem(RWMesh_CoordinateSystem_glTF)
    writer.SetNodeNameFormat(RWMesh_NameFormat_Instance)
    writer.SetMeshNameFormat(RWMesh_NameFormat_Product)
    writer.SetParallel(True)
    # One primitive per part instead of one per face: a few hundred draw
    # calls instead of tens of thousands, which is what makes a big
    # assembly turn smoothly. Faces of another colour stay apart.
    writer.SetMergeFaces(merge)
    if not writer.Perform(doc, Meta(), Message_ProgressRange()):
        raise RuntimeError("OpenCascade could not write the GLB")


def convert(src: str, dst: str, linear: float = LINEAR, angular: float = ANGULAR) -> dict:
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_Label
    from OCP.XCAFDoc import XCAFDoc_DocumentTool

    TDF_LabelSequence = _sequence()
    t0 = time.monotonic()
    doc = _read(src)
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

    t1 = time.monotonic()
    _mesh(tool, linear, angular)
    mesh_s = time.monotonic() - t1

    t2 = time.monotonic()
    _write(doc, dst)
    write_s = time.monotonic() - t2
    return {"parts": parts, "layers": layers,
            "seconds": {"read": round(read_s, 1), "mesh": round(mesh_s, 1),
                        "write": round(write_s, 1)}}


# A STEP from the Files tab, to look at: the deflection follows the part's
# size, so a connector and a machine frame both come out smooth enough to
# read and light enough to turn - about a thousandth of the diagonal, and
# 20 degrees round a curve.
PREVIEW_SHARE = 0.001
PREVIEW_ANGULAR = 0.35


def preview(src: str, dst: str) -> dict:
    """Any STEP as a GLB for the Files tab's viewer: names and colours as
    the file has them, nothing renamed, faces merged per part."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.XCAFDoc import XCAFDoc_DocumentTool

    t0 = time.monotonic()
    doc = _read(src)
    read_s = time.monotonic() - t0
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    free = _sequence()()
    tool.GetFreeShapes(free)
    box = Bnd_Box()
    for i in range(1, free.Length() + 1):
        BRepBndLib.Add_s(tool.GetShape_s(free.Value(i)), box, False)
    if box.IsVoid():
        raise ValueError("the STEP file has no shapes in it")
    lo, hi = box.CornerMin(), box.CornerMax()
    x0, y0, z0, x1, y1, z1 = lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z()
    diag = ((x1 - x0) ** 2 + (y1 - y0) ** 2 + (z1 - z0) ** 2) ** 0.5
    linear = min(max(diag * PREVIEW_SHARE, 0.005), 2.0)

    t1 = time.monotonic()
    triangles = _mesh(tool, linear, PREVIEW_ANGULAR)
    mesh_s = time.monotonic() - t1
    t2 = time.monotonic()
    _write(doc, dst, merge=True)
    write_s = time.monotonic() - t2
    return {"triangles": triangles, "deflection": round(linear, 4),
            "size": [round(x1 - x0, 3), round(y1 - y0, 3), round(z1 - z0, 3)],
            "seconds": {"read": round(read_s, 2), "mesh": round(mesh_s, 2),
                        "write": round(write_s, 2)}}


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
        out = preview(src, dst) if "--preview" in argv else convert(src, dst, linear)
    except Exception as exc:                        # noqa: BLE001
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 1
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
