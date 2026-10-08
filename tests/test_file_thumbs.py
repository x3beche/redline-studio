"""A 3D file's picture in the Files grid: drawn by the page (the server has
no GPU), sent once, kept by the file's content in its workspace and served
to everyone after that.

The routes run over the in-memory Mongo and GridFS stand-ins of
test_files_folders.
"""

from __future__ import annotations

import asyncio
import io

import pytest
from fastapi.testclient import TestClient

from backend import access, auth, files, scope
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
    return {"db": db, "web": TestClient(M.app)}


def picture(size=(640, 480), fmt="PNG") -> bytes:
    from PIL import Image
    im = Image.new("RGBA", size, (0, 0, 0, 0))
    im.paste((200, 200, 200, 255), (100, 100, 300, 300))
    buf = io.BytesIO()
    im.save(buf, fmt)
    return buf.getvalue()


def put(web, fid, data, ctype="image/png"):
    return web.put(f"/api/files/{fid}/thumb", headers={**H, "content-type": ctype}, content=data)


SOLID = b"solid cube\nendsolid cube\n"


def test_a_model_has_no_picture_until_a_page_sends_one_then_it_is_served(env):
    from PIL import Image
    web = env["web"]
    f = up(web, "cube.stl", SOLID)
    assert "has_thumb" not in web.get("/api/files").json()[0]
    assert web.get(f"/api/files/{f['id']}/thumb").status_code == 404
    r = put(web, f["id"], picture())
    assert r.status_code == 200 and r.json() == {"kept": False}
    r = web.get(f"/api/files/{f['id']}/thumb")
    assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
    assert "max-age" in r.headers["cache-control"] and r.headers["etag"]
    assert web.get(f"/api/files/{f['id']}/thumb", headers={"if-none-match": r.headers["etag"]}).status_code == 304
    with Image.open(io.BytesIO(r.content)) as im:
        assert im.size == (640, 480) and im.mode == "RGBA"          # its transparency is kept
    assert web.get("/api/files").json()[0]["has_thumb"] == f"{f['sha256'][:12]}.{files.SOLID_VERSION}"
    # the first one stays
    assert put(web, f["id"], picture(fmt="WEBP"), "image/webp").json() == {"kept": True}


def test_copies_of_the_same_bytes_share_one_picture_and_it_goes_with_the_last(env):
    web, db = env["web"], env["db"]
    a = up(web, "a.step", b"ISO-10303-21; a part")
    b = up(web, "b.stp", b"ISO-10303-21; a part")
    assert put(web, a["id"], picture()).status_code == 200
    assert all(f["has_thumb"] for f in web.get("/api/files").json())
    assert web.get(f"/api/files/{b['id']}/thumb").status_code == 200
    assert web.delete(f"/api/files/{a['id']}", headers=H).status_code == 200
    assert len(db["file_thumbs"].rows) == 1                       # b still has those bytes
    assert web.delete(f"/api/files/{b['id']}", headers=H).status_code == 200
    assert db["file_thumbs"].rows == []


@pytest.mark.parametrize("data,ctype,code", [
    (b"\x89PNG\r\n\x1a\n not really", "image/png", 400),
    (b"GIF89a", "image/png", 400),
    (b"<svg/>", "image/svg+xml", 415),
    ("big", "image/png", 413),
    ("huge", "image/png", 400),
    ("tiny", "image/png", 400),
])
def test_only_a_sane_png_or_webp_is_taken(env, data, ctype, code):
    web = env["web"]
    f = up(web, "cube.stl", SOLID)
    if data == "big":
        data = picture() + b"\0" * files.SOLID_MAX_BYTES
    elif data == "huge":
        data = picture((2000, 1500))
    elif data == "tiny":
        data = picture((8, 6))
    assert put(web, f["id"], data, ctype).status_code == code
    assert env["db"]["file_thumbs"].rows == []


def test_only_a_3d_file_takes_one_and_an_image_keeps_its_own(env):
    web = env["web"]
    t = up(web, "a.txt", b"x")
    assert put(web, t["id"], picture()).status_code == 415
    assert put(web, "nope", picture()).status_code == 404


def test_another_workspace_neither_sees_nor_sends_one(env):
    web, db = env["web"], env["db"]
    f = up(web, "cube.stl", SOLID)
    assert put(web, f["id"], picture()).status_code == 200
    # the same bytes in another workspace: its own file, and no picture of ours
    async def theirs():
        sdb = scope.ScopedDb(db, "team2")
        return await sdb[files.SOLID_THUMBS].find_one({"_id": files.solid_key(f["sha256"])})
    assert asyncio.run(theirs()) is None
    row = next(r for r in db["files"].rows if r["_id"] == f["id"])
    row["workspace_id"] = "team2"                                  # now it is not ours
    assert web.get(f"/api/files/{f['id']}/thumb").status_code == 404
    assert put(web, f["id"], picture()).status_code == 404


def test_sending_one_takes_the_right_to_draw():
    assert access.action("PUT", "/api/files/abc/thumb") == "draw"
    assert access.action("GET", "/api/files/abc/thumb") == "view"
    assert not access.allowed("viewer", "draw") and access.allowed("reviewer", "draw")
    assert not access.page_allowed("PUT", "/api/files/abc/thumb")
