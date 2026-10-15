"""What the mobile app asks of Files and the Chat's trash, made smaller for a
phone: only one's own uploads (`GET /api/files?area=own`), one read-only
folder at a time (`GET /api/files/virtual?under=`), a picture at a size
for a preview instead of the original (`GET /api/files/{id}/thumb?px=`,
backend/file_minis.py), and how long the conversation trash keeps one
(`X-Trash-Days`).

The routes run over the in-memory Mongo and GridFS stand-ins of
test_files_folders and test_files_virtual.
"""

from __future__ import annotations

import asyncio
import io

import pytest
from fastapi import FastAPI, Response
from fastapi.testclient import TestClient

from backend import access, cc_chat, file_minis
from backend import files_virtual as fv
from test_cc_chat import env as chat_env  # noqa: F401 - the fixture, by its name below
from test_cc_chat import seed as chat_seed
from test_cc_chat import trashed
from test_file_minis import png
from test_files_folders import H
from test_files_folders import up as up_bytes
from test_files_virtual import by_name, chat_upload, chat_with, env, up  # noqa: F401 - env is a fixture


def picture(r):
    from PIL import Image
    return Image.open(io.BytesIO(r.content))


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    monkeypatch.setattr(file_minis, "_running", {})


# ---------------------------------------------------------------- only one's own uploads

def test_area_own_leaves_the_apps_uploads_out_and_says_the_preview_sizes(env):
    web, db = env["web"], env["db"]
    mine = up(web, "bom.csv")["id"]
    pic = chat_upload(env, "pasted.png")
    every = web.get("/api/files")
    assert {mine, pic} <= {f["id"] for f in every.json()}
    own = web.get("/api/files", params={"area": "own"})
    assert own.status_code == 200 and [f["id"] for f in own.json()] == [mine]
    assert own.headers["x-thumb-sizes"] == "320,800,1600" == every.headers["x-thumb-sizes"]
    # anything else is every upload, as before
    assert {f["id"] for f in web.get("/api/files", params={"area": "x"}).json()} == {f["id"] for f in every.json()}


# ---------------------------------------------------------------- one read-only folder at a time

def test_under_nothing_is_the_whole_tree_as_before(env):
    whole = env["web"].get("/api/files/virtual").json()
    assert set(whole) == {"folders", "files", "links"}


def test_under_the_top_is_the_roots_with_what_each_holds(env):
    web, db = env["web"], env["db"]
    pic = up(web, "pic.png")
    chat_with(db, pic["id"], "pic.png")
    got = web.get("/api/files/virtual", params={"under": ""}).json()
    assert got["under"] == "" and got["trail"] == [] and got["files"] == [] and got["links"] == []
    assert {f["id"] for f in got["folders"]} == set(fv.ROOTS)
    assert all(f["root"] for f in got["folders"])
    assert by_name(got["folders"], "Chat")["count"] == {"folders": 1, "files": 0}
    assert by_name(got["folders"], "Projects")["count"]["folders"] >= 1


def test_under_a_conversation_are_its_files_with_their_rows_and_the_way_there(env):
    web, db = env["web"], env["db"]
    pic = up(web, "pic.png")
    other = up(web, "other.txt")
    chat_with(db, pic["id"], "pic.png")
    whole = web.get("/api/files/virtual").json()
    conv = by_name(whole["folders"], "BOM check")
    got = web.get("/api/files/virtual", params={"under": conv["id"]}).json()
    assert got["trail"] == [{"id": fv.CHAT, "name": "Chat"}, {"id": conv["id"], "name": "BOM check"}]
    assert got["folders"] == [] and got["links"] == [{"folder": conv["id"], "file": pic["id"]}]
    assert [f["id"] for f in got["linked"]] == [pic["id"]]
    assert got["linked"][0]["name"] == "pic.png" and other["id"] not in {f["id"] for f in got["linked"]}
    # the Chat folder lists the conversation, with its count
    chat = web.get("/api/files/virtual", params={"under": fv.CHAT}).json()
    assert by_name(chat["folders"], "BOM check")["count"] == {"folders": 0, "files": 1}
    assert chat["linked"] == []


def test_under_a_projects_folder_are_its_own_files(env):
    web = env["web"]
    whole = web.get("/api/files/virtual").json()
    holder = next(f["folder"] for f in whole["files"])
    got = web.get("/api/files/virtual", params={"under": holder}).json()
    assert got["files"] and all(f["folder"] == holder for f in got["files"])
    assert {f["id"] for f in got["files"]} == {f["id"] for f in whole["files"] if f["folder"] == holder}
    assert got["trail"][0]["id"] == fv.PROJECTS and got["trail"][-1]["id"] == holder


def test_under_a_folder_that_is_not_there_is_empty(env):
    got = env["web"].get("/api/files/virtual", params={"under": "v:nope"}).json()
    assert got == {"under": "v:nope", "trail": [], "folders": [], "files": [], "links": [], "linked": []}


# ---------------------------------------------------------------- a picture at a size

def thumb(web, fid, **kw):
    return web.get(f"/api/files/{fid}/thumb", params=kw)


def test_a_preview_is_made_at_the_next_kept_size_once_and_kept_by_content(env, monkeypatch):
    web, db = env["web"], env["db"]
    a = up_bytes(web, "a.png", png((3000, 2000)))
    b = up_bytes(web, "b.png", png((3000, 2000)))
    r = thumb(web, a["id"], px=1000)
    assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
    assert r.headers["x-thumb-px"] == "1600" and r.headers["etag"]
    with picture(r) as im:
        assert im.size == (1600, 1067)
    assert thumb(web, b["id"], px=1600).content == r.content          # copies share it
    kept = [x for x in db[file_minis.COLL].rows if ":p1600.webp:" in x["_id"]]
    assert len(kept) == 1 and kept[0]["sha256"] == a["sha256"]
    monkeypatch.setattr(file_minis, "sized", lambda *a: pytest.fail("made again"))
    assert thumb(web, a["id"], px=1600).status_code == 200
    again = web.get(f"/api/files/{a['id']}/thumb", params={"px": 1600}, headers={"if-none-match": r.headers["etag"]})
    assert again.status_code == 304


@pytest.mark.parametrize("px,want", [(16, 320), (320, 320), (321, 800), (800, 800), (4096, 1600)])
def test_the_sizes_are_bounded(px, want):
    assert file_minis.preview_px(px) == want


def test_a_preview_is_never_larger_than_the_picture(env):
    web = env["web"]
    f = up_bytes(web, "small.png", png((500, 300)))
    with picture(thumb(web, f["id"], px=1600)) as im:
        assert im.size == (500, 300)
    with picture(thumb(web, f["id"], px=320)) as im:
        assert im.size == (320, 192)


def test_jpeg_on_request_flat_on_white(env):
    from PIL import Image
    web = env["web"]
    buf = io.BytesIO()
    Image.new("RGBA", (900, 900), (0, 0, 0, 0)).save(buf, "PNG")
    f = up_bytes(web, "clear.png", buf.getvalue())
    r = thumb(web, f["id"], px=800, fmt="jpeg")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    with picture(r) as im:
        assert im.format == "JPEG" and im.size == (800, 800) and im.getpixel((5, 5))[0] > 240
    assert thumb(web, f["id"], px=800, fmt="gif").status_code == 400


def test_a_photos_place_is_not_passed_on():
    from PIL import Image
    im = Image.new("RGB", (1000, 500), (10, 10, 10))
    exif = Image.Exif()
    exif[0x0112] = 6                                   # turned: shown upright
    exif[0x8825] = {2: (41.0, 0.0, 0.0)}               # GPS
    buf = io.BytesIO()
    im.save(buf, "JPEG", exif=exif)
    for fmt in ("webp", "jpeg"):
        with Image.open(io.BytesIO(file_minis.sized(buf.getvalue(), 320, fmt))) as out:
            assert out.size == (160, 320)
            assert not out.getexif()


def test_no_preview_of_what_is_not_a_picture_and_bounds_on_px(env):
    web = env["web"]
    t = up(web, "notes.txt")
    svg = up(web, "logo.svg", b"<svg xmlns='http://www.w3.org/2000/svg'/>")
    assert thumb(web, t["id"], px=800).status_code == 404
    assert thumb(web, svg["id"], px=800).status_code == 404
    assert thumb(web, "nope", px=800).status_code == 404
    pic = up_bytes(web, "a.png", png())
    assert thumb(web, pic["id"], px=0).status_code == 422
    assert thumb(web, pic["id"], px=99999).status_code == 422
    # without px it is the grid's small picture, as before
    r = thumb(web, pic["id"])
    assert r.status_code == 200 and "x-thumb-px" not in r.headers


def test_a_preview_of_another_workspaces_picture_is_not_found(env):
    web, db = env["web"], env["db"]
    f = up_bytes(web, "a.png", png())
    next(r for r in db["files"].rows if r["_id"] == f["id"])["workspace_id"] = "team2"
    assert thumb(web, f["id"], px=800).status_code == 404
    assert db[file_minis.COLL].rows == []


def test_a_deleted_picture_has_a_preview_until_it_is_purged(env):
    web, db = env["web"], env["db"]
    f = up_bytes(web, "a.png", png())
    assert web.delete(f"/api/files/{f['id']}", headers=H).status_code == 200
    assert thumb(web, f["id"], px=800).status_code == 200
    assert web.post("/api/files/trash/purge", headers=H, json={"files": [f["id"]]}).status_code == 200
    assert db[file_minis.COLL].rows == []
    assert thumb(web, f["id"], px=800).status_code == 404


def test_reading_a_preview_is_looking_and_a_page_session_may():
    assert access.action("GET", "/api/files/abc/thumb") == "view"
    assert access.page_allowed("GET", "/api/files/abc/thumb")


# ---------------------------------------------------------------- the conversation trash's days

def test_the_trash_says_how_long_it_keeps_one(chat_env):  # noqa: F811
    db, _ = chat_env
    chat_seed(db, "a")
    chat_seed(db, "live")
    trashed(db, "a", days_ago=2)
    out = Response()
    rows = asyncio.run(cc_chat.list_chats(trash="1", response=out))
    assert [c["id"] for c in rows] == ["a"] and out.headers["x-trash-days"] == str(cc_chat.TRASH_DAYS) == "30"
    live = Response()
    asyncio.run(cc_chat.list_chats(response=live))
    assert "x-trash-days" not in live.headers
    # through the route, FastAPI hands it the response
    app = FastAPI()
    app.include_router(cc_chat.router)
    r = TestClient(app).get("/api/cc/chats", params={"trash": 1})
    assert r.status_code == 200 and r.headers["x-trash-days"] == "30" and [c["id"] for c in r.json()] == ["a"]
