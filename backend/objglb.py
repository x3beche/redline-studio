"""EasyEDA's 3D shapes, turned into something a browser can open at once.

LCSC keeps a part's model as an OBJ with its materials written inline -
`newmtl 2`, a `Kd` line, `endmtl` - where an OBJ normally points at a
separate file. Parsed in the page, an LQFP-48 is 146,000 lines of text and
the whole application froze for seconds on the click that asked for it.

So it is parsed once, here, and written as a GLB: binary buffers the page
hands straight to the GPU, with the colours already on it. Z-up becomes
Y-up on the way, so a part sits the way it does on a board.

No normals are written. glTF asks a viewer to shade a mesh without them
flat, which is the honest look for a CAD tessellation: averaging normals
across a box edge smears it into a pillow.
"""

from __future__ import annotations

import json
import struct

import numpy as np

GREY = (0.6, 0.6, 0.6)


def _parse(text: str) -> tuple[np.ndarray, dict[str, tuple], dict[str, list]]:
    """Vertices, the colour of each material, and each material's faces."""
    verts: list[str] = []
    colours: dict[str, tuple] = {}
    faces: dict[str, list] = {}
    current = ""
    defining: str | None = None

    for line in text.splitlines():
        head = line[:2]
        if head == "v ":
            verts.append(line[2:])
        elif head == "f ":
            # `f 1// 2// 3//`: one-based, positions only.
            faces.setdefault(current, []).append(
                [int(tok.split("/", 1)[0]) for tok in line[2:].split()])
        elif line.startswith("usemtl "):
            current = line[7:].strip()
        elif line.startswith("newmtl "):
            defining = line[7:].strip()
        elif defining is not None and line.startswith("Kd "):
            colours[defining] = tuple(float(x) for x in line[3:].split()[:3])
        elif line.startswith("endmtl"):
            defining = None

    pos = np.array(" ".join(verts).split(), dtype=np.float32).reshape(-1, 3)
    return pos, colours, faces


def _triangles(polys: list) -> np.ndarray:
    """Zero-based triangles; anything with more corners is fanned."""
    out = []
    for poly in polys:
        for k in range(1, len(poly) - 1):
            out.append((poly[0] - 1, poly[k] - 1, poly[k + 1] - 1))
    return np.array(out, dtype=np.int64).reshape(-1, 3)


def convert(text: str) -> bytes:
    """An EasyEDA OBJ as a GLB, one primitive per material."""
    pos, colours, faces = _parse(text)
    if not len(pos) or not faces:
        raise ValueError("the model has no geometry")

    # Z-up to Y-up: (x, y, z) -> (x, z, -y).
    pos = np.stack([pos[:, 0], pos[:, 2], -pos[:, 1]], axis=1).astype(np.float32)

    blob = bytearray()
    views, accessors, primitives, materials = [], [], [], []

    def add(data: bytes, target: int) -> int:
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": len(blob),
                      "byteLength": len(data), "target": target})
        blob.extend(data)
        return len(views) - 1

    for name, polys in faces.items():
        tris = _triangles(polys)
        if not len(tris):
            continue
        # Each primitive carries only the vertices it uses, numbered from
        # zero - which usually keeps the indices under 65,536 and so half
        # the size.
        used, local = np.unique(tris.ravel(), return_inverse=True)
        points = pos[used]
        index = local.astype(np.uint16 if len(used) < 65536 else np.uint32)

        v_pos = add(points.tobytes(), 34962)            # ARRAY_BUFFER
        accessors.append({
            "bufferView": v_pos, "componentType": 5126, "count": len(points),
            "type": "VEC3",
            "min": points.min(axis=0).tolist(), "max": points.max(axis=0).tolist()})
        a_pos = len(accessors) - 1

        v_idx = add(index.tobytes(), 34963)             # ELEMENT_ARRAY_BUFFER
        accessors.append({
            "bufferView": v_idx,
            "componentType": 5123 if index.dtype == np.uint16 else 5125,
            "count": len(index), "type": "SCALAR"})
        a_idx = len(accessors) - 1

        r, g, b = colours.get(name, GREY)
        materials.append({
            "name": name,
            "pbrMetallicRoughness": {"baseColorFactor": [r, g, b, 1.0],
                                     "metallicFactor": 0.15,
                                     "roughnessFactor": 0.6},
            "doubleSided": True})
        primitives.append({"attributes": {"POSITION": a_pos},
                           "indices": a_idx, "material": len(materials) - 1})

    while len(blob) % 4:
        blob.append(0)

    doc = {
        "asset": {"version": "2.0", "generator": "redline objglb"},
        "scene": 0, "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": primitives}],
        "materials": materials, "accessors": accessors,
        "bufferViews": views, "buffers": [{"byteLength": len(blob)}],
    }
    head = json.dumps(doc, separators=(",", ":")).encode()
    head += b" " * (-len(head) % 4)

    return b"".join([
        struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(head) + 8 + len(blob)),
        struct.pack("<II", len(head), 0x4E4F534A), head,      # JSON
        struct.pack("<II", len(blob), 0x004E4942), bytes(blob),  # BIN
    ])
