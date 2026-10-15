"""The small pictures at the start of a row in the Files lists
(backend/file_minis.py, backend/minirender.py): made once on first view,
kept by the file's content in its workspace, bounded in how many are made at
once, and a file of another kind - or one that cannot be read - keeps its
icon.

The routes run over the in-memory Mongo and GridFS stand-ins of
test_files_folders.
"""

from __future__ import annotations

import asyncio
import gzip
import io
import json
import struct

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend import access, auth, file_minis, filemesh, files, files_virtual, minirender
from backend import main as M
from test_files_folders import H, Grid, up
from test_links import FakeDb


@pytest.fixture
def env(monkeypatch):
    db = FakeDb()
    grid = Grid()
    monkeypatch.setattr(files, "_bucket", lambda d: grid)
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    monkeypatch.setattr(file_minis, "_running", {})
    return {"db": db, "web": TestClient(M.app)}


def png(size=(640, 480)) -> bytes:
    from PIL import Image
    im = Image.new("RGB", size, (30, 120, 200))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def pdf() -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (595, 842), (255, 255, 255)).save(buf, "PDF")
    return buf.getvalue()


def cube_tris() -> np.ndarray:
    v = np.array([[x, y, z] for x in (0, 10) for y in (0, 10) for z in (0, 10)], np.float32)
    faces = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1),
             (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
    return v[np.array(faces)]


def stl(tris=None) -> bytes:
    tris = cube_tris() if tris is None else tris
    out = bytearray(b"\0" * 80 + struct.pack("<I", len(tris)))
    for t in tris:
        out += struct.pack("<3f", 0, 0, 0) + t.astype("<f4").tobytes() + b"\0\0"
    return bytes(out)


def glb(tris: np.ndarray, matrix=None) -> bytes:
    pos = tris.reshape(-1, 3).astype("<f4").tobytes()
    node = {"mesh": 0, **({"matrix": matrix} if matrix else {})}
    doc = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [node],
           "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
           "accessors": [{"bufferView": 0, "componentType": 5126, "count": len(tris) * 3, "type": "VEC3"}],
           "bufferViews": [{"buffer": 0, "byteLength": len(pos)}], "buffers": [{"byteLength": len(pos)}]}
    js = json.dumps(doc).encode()
    js += b" " * (-len(js) % 4)
    body = struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(pos), 0x004E4942) + pos
    return b"glTF" + struct.pack("<II", 2, 12 + len(body)) + body


def mini(web, fid, **kw):
    return web.get(f"/api/files/{fid}/mini", params=kw)


def picture(r):
    from PIL import Image
    return Image.open(io.BytesIO(r.content))


# ---------------------------------------------------------------- made once, kept by content

def test_a_picture_is_made_small_once_and_copies_share_it(env):
    web, db = env["web"], env["db"]
    a = up(web, "a.png", png())
    b = up(web, "b.png", png())
    r = mini(web, a["id"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
    assert "immutable" in r.headers["cache-control"] and r.headers["etag"]
    with picture(r) as im:
        assert max(im.size) == file_minis.PX and im.size == (160, 120)
    assert mini(web, b["id"]).content == r.content
    assert len(db[file_minis.COLL].rows) == 1                     # one per content, not per file
    assert mini(web, a["id"], ).status_code == 200
    assert web.get(f"/api/files/{a['id']}/mini", headers={"if-none-match": r.headers["etag"]}).status_code == 304


def test_a_cached_one_is_not_made_again(env, monkeypatch):
    web = env["web"]
    f = up(web, "a.png", png())
    assert mini(web, f["id"]).status_code == 200
    monkeypatch.setattr(file_minis, "shrink", lambda *a: pytest.fail("made again"))
    assert mini(web, f["id"]).status_code == 200


def test_a_pdf_shows_its_first_page(env):
    web = env["web"]
    f = up(web, "sheet.pdf", pdf(), ctype="application/pdf")
    r = mini(web, f["id"])
    assert r.status_code == 200
    with picture(r) as im:
        assert im.height == file_minis.PX and im.width < im.height        # a portrait page
        assert im.convert("L").getextrema()[0] > 200                      # white paper


def test_an_stl_is_drawn_on_transparent(env):
    web, db = env["web"], env["db"]
    f = up(web, "cube.stl", stl())
    r = mini(web, f["id"], wait=30)
    assert r.status_code == 200, r.text
    with picture(r) as im:
        assert im.mode == "RGBA" and max(im.size) <= file_minis.PX
        alpha = np.asarray(im.getchannel("A"))
        assert alpha.max() == 255 and alpha[0, 0] == 0                   # the model, and around it nothing
    assert db[file_minis.COLL].rows[0]["kind"] == "stl"


def test_a_model_a_page_drew_already_is_made_smaller_not_drawn_again(env, monkeypatch):
    from PIL import Image
    web, db = env["web"], env["db"]
    f = up(web, "cube.stl", stl())
    im = Image.new("RGBA", (640, 480), (0, 0, 0, 0))
    im.paste((220, 220, 220, 255), (200, 100, 440, 380))
    buf = io.BytesIO()
    im.save(buf, "WEBP")
    asyncio.run(_insert(db, files.solid_key(f["sha256"]), buf.getvalue(), f["sha256"]))

    async def no(*a):
        pytest.fail("drawn again")
    monkeypatch.setattr(file_minis, "draw", no)
    r = mini(web, f["id"])
    assert r.status_code == 200
    with picture(r) as got:
        assert got.size == (137, 160)                                     # cropped to the model, then fitted


async def _insert(db, key, data, sha):
    from backend import scope
    await scope.ScopedDb(db, scope.DEFAULT)[files.SOLID_THUMBS].insert_one({"_id": key, "data": data, "sha256": sha})


# ---------------------------------------------------------------- a STEP, through its preview mesh

def test_a_step_waits_for_its_mesh_then_is_drawn_from_it(env, monkeypatch):
    web = env["web"]
    f = up(web, "part.step", b"ISO-10303-21; a part")
    started = []
    kept: dict = {}

    async def cached(db, doc):
        return kept.get("hit")

    async def mesh(db, doc, wait):
        started.append(doc["_id"])
        return None
    monkeypatch.setattr(filemesh, "cached", cached)
    monkeypatch.setattr(filemesh, "mesh", mesh)
    r = mini(web, f["id"])
    assert r.status_code == 202 and r.json() == {"state": "making"} and int(r.headers["retry-after"]) >= 2
    assert started == [f["id"]]
    kept["hit"] = ({}, gzip.compress(glb(cube_tris())))
    r = mini(web, f["id"], wait=30)
    assert r.status_code == 200, r.text
    with picture(r) as im:
        assert im.mode == "RGBA"


def test_a_step_opencascade_cannot_read_keeps_its_icon(env, monkeypatch):
    web = env["web"]
    f = up(web, "bad.step", b"ISO-10303-21; broken")

    async def cached(db, doc):
        raise filemesh.Unreadable("the STEP could not be read")
    monkeypatch.setattr(filemesh, "cached", cached)
    r = mini(web, f["id"])
    assert r.status_code == 404 and "could not be read" in r.json()["detail"]


# ---------------------------------------------------------------- fallbacks

@pytest.mark.parametrize("name,data", [("notes.txt", b"hello"), ("logo.svg", b"<svg/>"), ("a.zip", b"PK\x03\x04"),
                                       ("part.obj", b"v 0 0 0\n")])
def test_no_picture_for_a_kind_without_one(env, name, data):
    web, db = env["web"], env["db"]
    f = up(web, name, data)
    r = mini(web, f["id"])
    assert r.status_code == 404
    assert db[file_minis.COLL].rows == []


def test_a_file_too_large_keeps_its_icon(env, monkeypatch):
    web = env["web"]
    monkeypatch.setitem(file_minis.MAX_BYTES, "image", 100)
    f = up(web, "a.png", png())
    r = mini(web, f["id"])
    assert r.status_code == 404 and "larger than" in r.json()["detail"]


def test_an_unreadable_file_keeps_its_icon_and_is_not_tried_again(env, monkeypatch):
    web, db = env["web"], env["db"]
    f = up(web, "broken.stl", b"solid x\n vertex 1 2\nendsolid\n")
    g = up(web, "broken.png", b"\x89PNG\r\n\x1a\nnot really")
    h = up(web, "broken.pdf", b"%PDF-1.4 nothing", ctype="application/pdf")
    for x in (f, g, h):
        assert mini(web, x["id"], wait=30).status_code == 404
    assert len(db[file_minis.COLL].rows) == 3 and all(r.get("none") for r in db[file_minis.COLL].rows)

    async def no(*a):
        pytest.fail("tried again")
    monkeypatch.setattr(file_minis, "draw", no)
    assert mini(web, f["id"]).status_code == 404


def test_a_drawing_that_takes_too_long_is_stopped(env, monkeypatch):
    web = env["web"]
    monkeypatch.setattr(file_minis, "TIMEOUT", 0.001)
    f = up(web, "cube.stl", stl())
    r = mini(web, f["id"], wait=30)
    assert r.status_code == 404 and "took more than" in r.json()["detail"]


# ---------------------------------------------------------------- limits

def test_no_more_than_slots_are_made_at_once(monkeypatch):
    monkeypatch.setattr(file_minis, "_running", {})
    db = FakeDb()
    busy, most = [0], [0]

    async def slow(data, kind):
        busy[0] += 1
        most[0] = max(most[0], busy[0])
        await asyncio.sleep(0.02)
        busy[0] -= 1
        return b"RIFFxxxxWEBP"

    async def read(db, doc):
        return b"x"
    monkeypatch.setattr(file_minis, "draw", slow)
    monkeypatch.setattr(file_minis, "_read", read)

    async def go():
        docs = [{"_id": f"f{i}", "name": f"{i}.stl", "kind": "mesh", "sha256": f"s{i}", "bytes": 10} for i in range(12)]
        got = await asyncio.gather(*(file_minis.mini(db, d, 5) for d in docs))
        return got
    got = asyncio.run(go())
    assert all(s == "ready" for s, _ in got)
    assert most[0] == file_minis.SLOTS


def test_past_the_queue_the_answer_is_busy_and_nothing_starts(env, monkeypatch):
    web, db = env["web"], env["db"]
    monkeypatch.setattr(file_minis, "QUEUE_MAX", 0)
    f = up(web, "a.png", png())
    r = mini(web, f["id"])
    assert r.status_code == 202 and r.json() == {"state": "busy"} and r.headers["retry-after"]
    assert db[file_minis.COLL].rows == []


def test_the_list_never_waits_a_slow_one_is_making(env, monkeypatch):
    web = env["web"]

    async def slow(data, kind):
        await asyncio.sleep(1)
        return b""
    monkeypatch.setattr(file_minis, "draw", slow)
    f = up(web, "cube.stl", stl())
    r = mini(web, f["id"], wait=0)
    assert r.status_code == 202 and r.json() == {"state": "making"}


# ---------------------------------------------------------------- rights and places

def test_another_workspace_gets_nothing(env):
    web, db = env["web"], env["db"]
    f = up(web, "a.png", png())
    row = next(r for r in db["files"].rows if r["_id"] == f["id"])
    row["workspace_id"] = "team2"                                  # now it is not ours
    assert mini(web, f["id"]).status_code == 404
    assert db[file_minis.COLL].rows == []
    assert mini(web, "nope").status_code == 404


def test_reading_one_is_looking_and_a_page_session_may():
    assert access.action("GET", "/api/files/abc/mini") == "view"
    assert access.page_allowed("GET", "/api/files/abc/mini")


def test_a_deleted_file_keeps_its_picture_until_it_is_purged(env, monkeypatch):
    from test_files_virtual import ArrDb
    db = ArrDb()
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    web = env["web"]
    f = up(web, "a.png", png())
    assert web.delete(f"/api/files/{f['id']}", headers=H).status_code == 200
    assert mini(web, f["id"]).status_code == 200                   # Deleted files show it too
    assert len(db[file_minis.COLL].rows) == 1
    r = web.post("/api/files/trash/purge", headers=H, json={"files": [f["id"]]})
    assert r.status_code == 200
    assert db[file_minis.COLL].rows == []
    assert mini(web, f["id"]).status_code == 404


def test_a_read_only_folders_file_has_one_too(env, monkeypatch):
    web = env["web"]
    data = png()

    async def doc(db, v, data_=True, **kw):
        if v != "v:ma:x":
            raise KeyError(v)
        out = {"_id": v, "id": v, "name": "render.png", "kind": "image", "bytes": len(data), "sha256": "", "ro": True}
        if kw.get("data", data_):
            out["_data"] = data
        return out
    monkeypatch.setattr(files_virtual, "doc", doc)
    r = mini(web, "v:ma:x")
    assert r.status_code == 200
    with picture(r) as im:
        assert max(im.size) == file_minis.PX
    assert mini(web, "v:ma:y").status_code == 404


# ---------------------------------------------------------------- the CPU renderer

def test_stl_ascii_and_binary_read_the_same():
    tris = cube_tris()
    text = "solid c\n" + "".join(
        "facet normal 0 0 0\n outer loop\n" + "".join(f"  vertex {x} {y} {z}\n" for x, y, z in t) + " endloop\nendfacet\n"
        for t in tris) + "endsolid c\n"
    assert np.allclose(minirender.read_stl(text.encode()), minirender.read_stl(stl(tris)))
    with pytest.raises(minirender.Unreadable):
        minirender.read_stl(b"PK\x03\x04 not a mesh")


def test_a_glb_node_transform_is_applied_and_y_up_becomes_z_up():
    tris = cube_tris()
    moved = minirender.read_glb(glb(tris, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1]))
    assert np.isclose(moved[..., 0].min(), 100)                  # moved along X
    flat = minirender.read_glb(glb(np.array([[[0, 0, 0], [1, 0, 0], [0, 5, 0]]], np.float32)))
    assert np.isclose(flat[..., 2].max(), 5)                     # glTF's Y is the view's Z


def test_the_drawing_is_shaded_three_faces_told_apart():
    im = minirender.render(cube_tris(), 160)
    a = np.asarray(im)
    shades = {int(v) // 8 for v in a[..., 0][a[..., 3] == 255]}
    assert len(shades) >= 3 and im.mode == "RGBA" and max(im.size) == 160
