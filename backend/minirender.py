"""A 3D file's small picture for the Files lists, drawn without a GPU.

The page draws a model's picture for the grid with WebGL (rooms/mesh-thumb.ts)
when someone opens the grid; the lists want one too, for every STL and STEP,
whether a page has drawn it or not. So this draws one on the CPU, with numpy
alone: the triangles are projected from the 3D view's iso corner, each is
covered with points closer together than a pixel (as many as its area asks,
never fewer than its corners), the nearest point wins each pixel, and the
pixel is shaded by its triangle's normal under the same light the page uses
- grey shading on transparent, tinted by the page with the theme's model
colour (styles.css `.tcv-fm-solid`). Where the surface turns sharply a
darker line is drawn, like the page's feature edges.

Run as a process of its own (backend/file_minis.py), niced and timed, so a
huge mesh never holds the API:

    python -m backend.minirender stl|glb in out.webp [px]

It prints one JSON line: {"triangles", "w", "h"} or {"error"}.
"""

from __future__ import annotations

import json
import re
import struct
import sys

import numpy as np

# From the target to the eye, Z up: the 3D view's iso (mesh-view.ts, mesh-thumb.ts).
ISO = (1.0, -1.0, 0.8)
# The page's light: flat, from above, a little to the front and the left.
SUN = (0.25, -0.55, 1.0)
AMBIENT, DIFFUSE = 0.12, 1.05
# Points on a triangle are at most this far apart, in pixels of the drawing.
STEP_PX = 0.7
# Drawn this many times larger than asked, then made smaller: smooth edges.
SUPER = 2
# More triangles than this are not drawn: the file keeps its icon.
MAX_TRIANGLES = 4_000_000
# Points worked out at once; a larger mesh is drawn in pieces.
CHUNK_POINTS = 3_000_000
MARGIN = 0.06


class Unreadable(ValueError):
    """The file is not a mesh this reads; the message says why."""


# ---------------------------------------------------------------- reading

def read_stl(data: bytes) -> np.ndarray:
    """An STL's triangles as an (n, 3, 3) float32 array: binary or ASCII."""
    if len(data) >= 84:
        n = struct.unpack_from("<I", data, 80)[0]
        if 84 + 50 * n == len(data) and n:
            if n > MAX_TRIANGLES:
                raise Unreadable(f"{n} triangles - more than a picture is drawn of")
            rec = np.frombuffer(data, dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]),
                                count=n, offset=84)
            return np.ascontiguousarray(rec["v"], dtype=np.float32)
    head = data[:512].lstrip().lower()
    if not head.startswith(b"solid"):
        raise Unreadable("not an STL")
    nums = re.findall(rb"vertex\s+(\S+)\s+(\S+)\s+(\S+)", data)
    if not nums or len(nums) % 3:
        raise Unreadable("an ASCII STL without whole triangles")
    if len(nums) // 3 > MAX_TRIANGLES:
        raise Unreadable(f"{len(nums) // 3} triangles - more than a picture is drawn of")
    try:
        v = np.array(nums, dtype=np.float64).astype(np.float32)
    except ValueError as exc:
        raise Unreadable("an ASCII STL with a number it cannot read") from exc
    return v.reshape(-1, 3, 3)


_COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
_TYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}


def read_glb(data: bytes) -> np.ndarray:
    """A binary glTF's triangles, every node's transform applied, Z up (as the
    3D view turns glTF's Y up), as an (n, 3, 3) float32 array."""
    if len(data) < 20 or data[:4] != b"glTF":
        raise Unreadable("not a GLB")
    _, _, total = struct.unpack_from("<III", data, 0)
    at, doc, blob = 12, None, b""
    while at + 8 <= min(total, len(data)):
        size, kind = struct.unpack_from("<II", data, at)
        chunk = data[at + 8: at + 8 + size]
        if kind == 0x4E4F534A:
            doc = json.loads(chunk.decode("utf-8"))
        elif kind == 0x004E4942:
            blob = chunk
        at += 8 + size + (-size % 4)
    if doc is None:
        raise Unreadable("a GLB without its JSON")
    if doc.get("extensionsRequired"):
        raise Unreadable("a GLB that needs " + ", ".join(doc["extensionsRequired"]))
    views, accs = doc.get("bufferViews", []), doc.get("accessors", [])

    def accessor(i: int) -> np.ndarray:
        a = accs[i]
        comp, dt = _COMPONENTS[a["type"]], np.dtype(_TYPES[a["componentType"]])
        if "bufferView" not in a:
            return np.zeros((a["count"], comp), dt)
        v = views[a["bufferView"]]
        if v.get("buffer", 0) != 0:
            raise Unreadable("a GLB with an outside buffer")
        start = v.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = v.get("byteStride") or comp * dt.itemsize
        if stride == comp * dt.itemsize:
            out = np.frombuffer(blob, dt, a["count"] * comp, start).reshape(-1, comp)
        else:
            rows = np.frombuffer(blob, np.uint8, (a["count"] - 1) * stride + comp * dt.itemsize, start)
            out = np.lib.stride_tricks.as_strided(rows, (a["count"], comp * dt.itemsize), (stride, 1))
            out = np.ascontiguousarray(out).view(dt).reshape(-1, comp)
        return out

    def matrix(node: dict) -> np.ndarray:
        if "matrix" in node:
            return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
        m = np.eye(4)
        x, y, z, w = node.get("rotation", (0, 0, 0, 1))
        m[:3, :3] = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
        m[:3, :3] *= np.array(node.get("scale", (1, 1, 1)))[None, :]
        m[:3, 3] = node.get("translation", (0, 0, 0))
        return m

    nodes, meshes, parts, count = doc.get("nodes", []), doc.get("meshes", []), [], 0
    scene = (doc.get("scenes") or [{}])[doc.get("scene", 0)] if doc.get("scenes") else {"nodes": list(range(len(nodes)))}
    todo = [(i, np.eye(4)) for i in scene.get("nodes", [])]
    seen = 0
    while todo:
        i, parent = todo.pop()
        seen += 1
        if seen > 200_000:
            raise Unreadable("a GLB whose nodes do not end")
        node = nodes[i]
        m = parent @ matrix(node)
        for prim in (meshes[node["mesh"]]["primitives"] if "mesh" in node else []):
            if prim.get("mode", 4) != 4 or "POSITION" not in prim.get("attributes", {}):
                continue
            pos = accessor(prim["attributes"]["POSITION"]).astype(np.float64)
            idx = accessor(prim["indices"]).reshape(-1).astype(np.int64) if "indices" in prim \
                else np.arange(len(pos))
            idx = idx[: len(idx) - len(idx) % 3]
            count += len(idx) // 3
            if count > MAX_TRIANGLES:
                raise Unreadable(f"more than {MAX_TRIANGLES} triangles - more than a picture is drawn of")
            world = pos @ m[:3, :3].T + m[:3, 3]
            parts.append(world[idx].reshape(-1, 3, 3))
        todo += [(c, m) for c in node.get("children", [])]
    if not parts:
        raise Unreadable("a GLB without triangles")
    tris = np.concatenate(parts)
    # glTF's Y up -> the 3D view's Z up (as mesh-thumb.ts turns it)
    return np.stack([tris[..., 0], -tris[..., 2], tris[..., 1]], axis=-1).astype(np.float32)


# ---------------------------------------------------------------- drawing

def _unit(v) -> np.ndarray:
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


def render(tris: np.ndarray, px: int = 160):
    """The triangles from the iso corner, fitted into px x px: an RGBA Pillow
    picture cropped to the model, grey shading on transparent."""
    from PIL import Image

    tris = tris[np.isfinite(tris).all(axis=(1, 2))]
    if not len(tris):
        raise Unreadable("no triangles to draw")
    back = _unit(ISO)
    side = _unit(np.cross((0.0, 0.0, 1.0), back))
    up = np.cross(back, side)
    basis = np.stack([side, up, back]).astype(np.float32)          # rows: screen x, screen y, toward the eye
    p = tris @ basis.T                                              # (n, 3, 3)
    lo, hi = p.reshape(-1, 3).min(axis=0), p.reshape(-1, 3).max(axis=0)
    size = px * SUPER
    span = max(float(hi[0] - lo[0]), float(hi[1] - lo[1]), 1e-9)
    scale = size * (1 - 2 * MARGIN) / span
    off_x = (size - (hi[0] - lo[0]) * scale) / 2 - lo[0] * scale
    off_y = (size - (hi[1] - lo[1]) * scale) / 2 - lo[1] * scale
    sx = p[..., 0] * scale + off_x
    sy = size - (p[..., 1] * scale + off_y)                          # rows go down
    sz = p[..., 2]                                                   # larger is nearer

    # a normal per triangle, turned toward the eye (both sides are drawn)
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]).astype(np.float64)
    length = np.linalg.norm(n, axis=1)
    keep = length > 0
    n[keep] /= length[keep, None]
    n[n @ back < 0] *= -1

    depth = np.full(size * size, -np.inf, dtype=np.float32)
    owner = np.full(size * size, -1, dtype=np.int64)
    # Each triangle as a grid of points: along its longest edge (B to C),
    # and from that edge up to the opposite corner A, spaced under STEP_PX.
    e = np.stack([np.hypot(sx[:, 1] - sx[:, 2], sy[:, 1] - sy[:, 2]),
                  np.hypot(sx[:, 2] - sx[:, 0], sy[:, 2] - sy[:, 0]),
                  np.hypot(sx[:, 0] - sx[:, 1], sy[:, 0] - sy[:, 1])], axis=1)
    a_at = e.argmax(axis=1)                                          # the corner opposite the longest edge
    order = np.stack([a_at, (a_at + 1) % 3, (a_at + 2) % 3], axis=1)
    rows = np.arange(len(tris))[:, None]
    X, Y, Z = sx[rows, order], sy[rows, order], sz[rows, order]
    longest = e.max(axis=1)
    area2 = np.abs((X[:, 1] - X[:, 0]) * (Y[:, 2] - Y[:, 0]) - (X[:, 2] - X[:, 0]) * (Y[:, 1] - Y[:, 0]))
    height = np.where(longest > 0, area2 / np.maximum(longest, 1e-12), 0)
    k1 = np.clip(np.ceil(longest / STEP_PX), 1, 4 * size).astype(np.int64)
    k2 = np.clip(np.ceil(height / STEP_PX), 1, 4 * size).astype(np.int64)
    counts = (k1 + 1) * (k2 + 1)
    # nothing wholly off the picture is worked out
    vis = (X.max(1) >= 0) & (X.min(1) < size) & (Y.max(1) >= 0) & (Y.min(1) < size)
    todo = np.flatnonzero(vis)
    start = 0
    ends = np.cumsum(counts[todo])
    while start < len(todo):
        base = ends[start - 1] if start else 0
        stop = int(np.searchsorted(ends, base + CHUNK_POINTS, side="right"))
        stop = max(stop, start + 1)
        ids = todo[start:stop]
        start = stop
        c = counts[ids]
        tri = np.repeat(np.arange(len(ids)), c)
        first = np.repeat(np.cumsum(c) - c, c)
        j = np.arange(len(tri)) - first
        kk1, kk2 = k1[ids][tri], k2[ids][tri]
        t = (j % (kk1 + 1)) / kk1
        s = (j // (kk1 + 1)) / kk2
        g = ids[tri]
        def at(V):
            edge = V[g, 1] + t * (V[g, 2] - V[g, 1])
            return edge + s * (V[g, 0] - edge)
        qx, qy, qz = at(X), at(Y), at(Z).astype(np.float32)
        ix, iy = qx.astype(np.int64), qy.astype(np.int64)
        inside = (qx >= 0) & (qy >= 0) & (ix < size) & (iy < size)
        pix = (iy * size + ix)[inside]
        qz, g = qz[inside], g[inside]
        if not len(pix):
            continue
        # the nearest point per pixel, then only where it is nearer than what is there
        o = np.lexsort((-qz, pix))
        pix, qz, g = pix[o], qz[o], g[o]
        head = np.ones(len(pix), bool)
        head[1:] = pix[1:] != pix[:-1]
        pix, qz, g = pix[head], qz[head], g[head]
        nearer = qz > depth[pix]
        depth[pix[nearer]] = qz[nearer]
        owner[pix[nearer]] = g[nearer]

    covered = owner >= 0
    if not covered.any():
        raise Unreadable("nothing of it is in the picture")
    normal = np.zeros((size * size, 3))
    normal[covered] = n[owner[covered]]
    light = np.clip(AMBIENT + DIFFUSE * np.clip(normal @ _unit(SUN), 0, None), 0, 1)
    # linear light to the screen's sRGB, as three.js writes it out
    shade = np.where(light <= 0.0031308, light * 12.92, 1.055 * np.power(light, 1 / 2.4) - 0.055)
    # feature edges: where the surface beside turns sharply, or steps away
    nm, dm, cm = normal.reshape(size, size, 3), depth.reshape(size, size), covered.reshape(size, size)
    edge = np.zeros((size, size), bool)
    gap = max(float(sz.max() - sz.min()), 1e-9) * 0.02
    for dy, dx in ((0, 1), (1, 0)):
        a = (slice(0, size - dy), slice(0, size - dx))
        b = (slice(dy, size), slice(dx, size))
        both = cm[a] & cm[b]
        turn = (nm[a] * nm[b]).sum(-1) < 0.82
        with np.errstate(invalid="ignore"):          # -inf where nothing is drawn
            step = np.abs(dm[a] - dm[b]) > gap
        hit = both & (turn | step)
        edge[a] |= hit
    shade = shade.reshape(size, size)
    shade[edge] *= 0.68
    rgba = np.zeros((size, size, 4), np.uint8)
    rgba[..., :3] = (np.clip(shade, 0, 1) * 255 + 0.5).astype(np.uint8)[..., None]
    rgba[..., 3] = np.where(cm, 255, 0)
    im = Image.fromarray(rgba, "RGBA")
    im = im.crop(im.getbbox())
    im.thumbnail((px, px), Image.Resampling.LANCZOS)
    return im


def main(argv: list[str]) -> int:
    if len(argv) < 3 or argv[0] not in ("stl", "glb"):
        print(json.dumps({"error": "usage: minirender stl|glb in out.webp [px]"}))
        return 2
    kind, src, dst = argv[0], argv[1], argv[2]
    px = int(argv[3]) if len(argv) > 3 else 160
    try:
        with open(src, "rb") as fh:
            data = fh.read()
        tris = read_stl(data) if kind == "stl" else read_glb(data)
        del data
        im = render(tris, px)
        im.save(dst, "WEBP", quality=88, method=4)
    except Unreadable as exc:
        print(json.dumps({"error": str(exc)}))
        return 1
    except (MemoryError, ValueError, KeyError, IndexError, struct.error) as exc:
        print(json.dumps({"error": f"the mesh could not be drawn ({type(exc).__name__})"}))
        return 1
    print(json.dumps({"triangles": int(len(tris)), "w": im.width, "h": im.height}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
