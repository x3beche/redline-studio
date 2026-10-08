"""The Files tab as a file manager: folders, moving, reading part of a
file, a ZIP of several, what a preview shows, names, and the command line.

The routes run over a small in-memory Mongo (test_links.FakeDb) and a
GridFS stand-in that can seek, as Motor's can.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import urllib.request
import zipfile

import pytest
from fastapi.testclient import TestClient

from backend import access, auth, files, scope
from backend import main as M
from test_links import FakeDb

H = {"x-redline-csrf": "1"}


class GridOut:
    def __init__(self, data: bytes):
        self.data, self.pos, self.length = data, 0, len(data)

    def seek(self, pos):
        self.pos = pos

    async def read(self, n=-1):
        end = self.length if n is None or n < 0 else self.pos + n
        out = self.data[self.pos:end]
        self.pos += len(out)
        return out


class Grid:
    def __init__(self):
        self.blobs: dict = {}

    async def upload_from_stream(self, name, data):
        fid = f"g{len(self.blobs)}"
        self.blobs[fid] = bytes(data)
        return fid

    async def open_download_stream(self, fid):
        return GridOut(self.blobs[fid])

    async def delete(self, fid):
        self.blobs.pop(fid, None)


@pytest.fixture
def env(monkeypatch):
    db = FakeDb()
    grid = Grid()
    monkeypatch.setattr(files, "_bucket", lambda d: grid)
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    return {"db": db, "grid": grid, "web": TestClient(M.app)}


def up(web, name, data, folder="", ctype="application/octet-stream"):
    r = web.post("/api/files", headers=H, data={"folder": folder},
                 files={"upload": (name, data, ctype)})
    assert r.status_code == 200, r.text
    return r.json()[0]


def mk(web, name, parent=""):
    r = web.post("/api/files/folders", headers=H, json={"name": name, "parent": parent})
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------- folders

def test_folders_are_made_renamed_and_listed_with_their_paths(env):
    web = env["web"]
    a = mk(web, "Datasheets")
    b = mk(web, "Power", a["id"])
    assert b["path"] == "Datasheets/Power" and b["parent"] == a["id"]
    # the same name beside it is refused, whatever its case
    assert web.post("/api/files/folders", headers=H, json={"name": "datasheets"}).status_code == 409
    # under a folder that is not there
    assert web.post("/api/files/folders", headers=H, json={"name": "x", "parent": "nope"}).status_code == 404
    r = web.patch(f"/api/files/folders/{a['id']}", headers=H, json={"name": "Sheets"})
    assert r.status_code == 200 and r.json()["path"] == "Sheets"
    paths = {f["id"]: f["path"] for f in web.get("/api/files/folders").json()}
    assert paths[b["id"]] == "Sheets/Power"          # what is under it follows
    # mkdir -p
    r = web.post("/api/files/folders", headers=H, json={"path": "Sheets/Power/LDO"})
    assert r.json()["path"] == "Sheets/Power/LDO" and r.json()["parent"] == b["id"]


def test_files_go_into_a_folder_and_the_old_ones_stay_at_the_top(env):
    web, db = env["web"], env["db"]
    a = mk(web, "A")
    f = up(web, "inside.txt", b"hello", a["id"])
    assert f["folder"] == a["id"]
    # a file from before folders has no `folder`: it is at the top
    db["files"].rows.append({"_id": "old1", "name": "old.csv", "bytes": 3, "kind": "table",
                             "content_type": "text/csv", "context": {}, "by": {}, "note": "",
                             "created_at": "2025-01-01T00:00:00+00:00"})
    top = web.get("/api/files", params={"folder": ""}).json()
    assert [x["id"] for x in top] == ["old1"] and top[0]["folder"] == ""
    assert [x["id"] for x in web.get("/api/files", params={"folder": a["id"]}).json()] == [f["id"]]
    assert web.post("/api/files", headers=H, data={"folder": "nope"},
                    files={"upload": ("x.txt", b"x", "text/plain")}).status_code == 404


def test_folders_belong_to_their_workspace(env):
    db = env["db"]
    db["file_folders"].rows.append({"_id": "theirs", "name": "Secret", "parent": "", "path": "Secret",
                                    "workspace_id": "team2"})
    mine = mk(env["web"], "Mine")
    got = env["web"].get("/api/files/folders").json()
    assert [f["id"] for f in got] == [mine["id"]]
    assert env["web"].patch("/api/files/folders/theirs", headers=H, json={"name": "x"}).status_code == 404
    assert env["web"].delete("/api/files/folders/theirs", headers=H).status_code == 404
    # and a folder made in another workspace is stamped with it
    async def other():
        return await files.make_folder(scope.ScopedDb(db, "team2"), "Theirs too", "", {})
    made = asyncio.run(other())
    row = next(r for r in db["file_folders"].rows if r.get("name") == "Theirs too")
    assert row["workspace_id"] == "team2" and row["_id"] == made["_id"] + "@team2"


def test_moving_files_and_folders_and_never_into_itself(env):
    web = env["web"]
    a, b = mk(web, "A"), mk(web, "B")
    a1 = mk(web, "A1", a["id"])
    f = up(web, "x.txt", b"x")
    r = web.post("/api/files/move", headers=H, json={"files": [f["id"]], "folders": [a["id"]], "to": b["id"]})
    assert r.status_code == 200, r.text
    assert r.json() == {"files": 1, "folders": 1}
    paths = {x["id"]: x["path"] for x in web.get("/api/files/folders").json()}
    assert paths[a["id"]] == "B/A" and paths[a1["id"]] == "B/A/A1"
    assert web.get("/api/files", params={"folder": b["id"]}).json()[0]["id"] == f["id"]
    # into itself, or into a folder inside it
    for into in (a["id"], a1["id"]):
        r = web.post("/api/files/move", headers=H, json={"folders": [a["id"]], "to": into})
        assert r.status_code == 400, r.text
    # a name already taken where it goes
    mk(web, "A1")
    r = web.post("/api/files/move", headers=H, json={"folders": [a1["id"]], "to": ""})
    assert r.status_code == 409
    # back to the top
    r = web.post("/api/files/move", headers=H, json={"files": [f["id"]], "to": ""})
    assert r.status_code == 200 and web.get("/api/files", params={"folder": ""}).json()[0]["folder"] == ""


def test_a_folder_is_deleted_empty_or_with_its_contents_when_asked(env):
    web, grid = env["web"], env["grid"]
    a = mk(web, "A")
    sub = mk(web, "Sub", a["id"])
    up(web, "deep.txt", b"deep", sub["id"])
    r = web.delete(f"/api/files/folders/{a['id']}", headers=H)
    assert r.status_code == 409 and "not empty" in r.json()["detail"]
    r = web.delete(f"/api/files/folders/{a['id']}", headers=H, params={"contents": "true"})
    assert r.status_code == 200 and r.json()["files"] == 1 and r.json()["folders"] == 2
    assert web.get("/api/files/folders").json() == [] and web.get("/api/files").json() == []
    assert grid.blobs == {}                                  # the bytes went too
    empty = mk(web, "Empty")
    assert web.delete(f"/api/files/folders/{empty['id']}", headers=H).status_code == 200


def test_someone_elses_file_keeps_their_folder(env, monkeypatch):
    web, db = env["web"], env["db"]
    a = mk(web, "A")
    f = up(web, "theirs.txt", b"x", a["id"])
    next(r for r in db["files"].rows if r["_id"] == f["id"])["by"] = {"id": "someone-else"}
    monkeypatch.setattr(access, "allowed", lambda role, act: act != "delete")
    r = web.delete(f"/api/files/folders/{a['id']}", headers=H, params={"contents": "true"})
    assert r.status_code == 403
    assert len(web.get("/api/files").json()) == 1
    assert web.post("/api/files/bulk-delete", headers=H, json={"files": [f["id"]]}).status_code == 403


def test_folder_routes_take_the_right_to_draw():
    for m, p in (("POST", "/api/files/folders"), ("PATCH", "/api/files/folders/x"),
                 ("DELETE", "/api/files/folders/x"), ("POST", "/api/files/move"),
                 ("POST", "/api/files/bulk-delete")):
        a = access.action(m, p)
        assert access.allowed("reviewer", a) and not access.allowed("viewer", a), (m, p)
    for p in ("/api/files/folders", "/api/files/zip", "/api/files/f1/thumb", "/api/files/f1/table"):
        assert access.allowed("viewer", access.action("GET", p))


# ---------------------------------------------------------------- ranges

def test_a_range_is_answered_with_206_and_exactly_those_bytes(env):
    web = env["web"]
    data = bytes(range(256)) * 40                    # 10240 bytes
    f = up(web, "clip.mp4", data, ctype="video/mp4")
    url = f"/api/files/{f['id']}?inline=1"
    r = web.get(url)
    assert r.status_code == 200 and r.content == data and r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-type"] == "video/mp4" and r.headers["content-disposition"].startswith("inline")
    r = web.get(url, headers={"Range": "bytes=100-299"})
    assert r.status_code == 206 and r.content == data[100:300]
    assert r.headers["content-range"] == "bytes 100-299/10240" and r.headers["content-length"] == "200"
    r = web.get(url, headers={"Range": "bytes=10000-"})
    assert r.status_code == 206 and r.content == data[10000:]
    r = web.get(url, headers={"Range": "bytes=-16"})
    assert r.status_code == 206 and r.content == data[-16:]
    r = web.get(url, headers={"Range": "bytes=10000-99999"})     # clipped to the end
    assert r.content == data[10000:] and r.headers["content-range"] == "bytes 10000-10239/10240"
    r = web.get(url, headers={"Range": "bytes=10240-"})
    assert r.status_code == 416 and r.headers["content-range"] == "bytes */10240"
    r = web.get(url, headers={"Range": "lines=1-2"})              # not understood: all of it
    assert r.status_code == 200 and r.content == data


def test_parse_range_by_the_rules():
    assert files.parse_range(None, 10) is None
    assert files.parse_range("bytes=0-0", 10) == (0, 0)
    assert files.parse_range("bytes=5-", 10) == (5, 9)
    assert files.parse_range("bytes=-3", 10) == (7, 9)
    assert files.parse_range("bytes=-30", 10) == (0, 9)
    assert files.parse_range("bytes=2-4,6-7", 10) == (2, 4)       # the first of several
    assert files.parse_range("bytes=4-2", 10) is None
    for bad in ("bytes=10-", "bytes=-0"):
        with pytest.raises(ValueError):
            files.parse_range(bad, 10)


def test_what_could_run_is_sandboxed_and_html_is_text(env):
    web = env["web"]
    svg = up(web, "logo.svg", b"<svg xmlns='http://www.w3.org/2000/svg'><script>x()</script></svg>",
             ctype="image/svg+xml")
    r = web.get(f"/api/files/{svg['id']}?inline=1")
    assert r.headers["content-type"] == "image/svg+xml" and "sandbox" in r.headers["content-security-policy"]
    page = up(web, "page.html", b"<script>alert(1)</script>", ctype="text/html")
    r = web.get(f"/api/files/{page['id']}?inline=1")
    assert r.headers["content-type"].startswith("text/plain")
    pdf = up(web, "a.pdf", b"%PDF-1.4", ctype="application/pdf")
    r = web.get(f"/api/files/{pdf['id']}?inline=1")
    assert "content-security-policy" not in r.headers           # the browser's viewer refuses a sandbox


# ---------------------------------------------------------------- zip

def test_several_files_and_a_folder_come_as_one_zip(env):
    web = env["web"]
    a = mk(web, "Board")
    sub = mk(web, "gerbers", a["id"])
    f1 = up(web, "notes.txt", b"one")
    f2 = up(web, "notes.txt", b"two")                # the same name twice
    up(web, "top.gtl", b"G04*", sub["id"])
    up(web, "readme.md", b"# hi", a["id"])
    r = web.get("/api/files/zip", params={"files": f"{f1['id']},{f2['id']}", "folders": a["id"]})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    got = {n: z.read(n) for n in z.namelist()}
    assert got == {"notes.txt": b"one", "notes (2).txt": b"two", "Board/gerbers/top.gtl": b"G04*",
                   "Board/readme.md": b"# hi"}
    r = web.get("/api/files/zip", params={"folders": a["id"]})
    assert 'filename="Board.zip"' in r.headers["content-disposition"]
    assert web.get("/api/files/zip").status_code == 404


def test_bulk_delete_takes_them_all(env):
    web = env["web"]
    ids = [up(web, f"{i}.txt", b"x")["id"] for i in range(3)]
    r = web.post("/api/files/bulk-delete", headers=H, json={"files": ids[:2]})
    assert r.status_code == 200 and sorted(r.json()["deleted"]) == sorted(ids[:2])
    assert [f["id"] for f in web.get("/api/files").json()] == [ids[2]]


# ---------------------------------------------------------------- what a preview shows

@pytest.mark.parametrize("name,kind,ctype,want", [
    ("bench.JPG", "image", "", "image"), ("logo.svg", "image", "", "image"),
    ("clip.mp4", "video", "", "video"), ("take.MOV", "", "", "video"), ("hum.mp3", "audio", "", "audio"),
    ("datasheet.pdf", "pdf", "", "pdf"), ("README.md", "text", "", "markdown"),
    ("bom.csv", "bom", "", "table"), ("pnp.tsv", "pick-place", "", "table"), ("prices.xlsx", "table", "", "table"),
    ("old.xls", "table", "", "none"), ("main.cpp", "text", "", "text"), ("log.log", "text", "", "text"),
    ("top.GTL", "gerber", "", "text"), ("holes.drl", "drill", "", "text"),
    ("gerbers.zip", "archive", "", "archive"), ("src.tar.gz", "archive", "", "archive"),
    ("x.7z", "archive", "", "none"), ("part.stl", "mesh", "", "mesh"), ("part.3mf", "mesh", "", "mesh"),
    ("OLED.stp", "step", "", "step"), ("blob.bin", "other", "", "none"),
    ("noext", "other", "text/plain", "text"), ("cam", "other", "video/webm", "video"),
])
def test_preview_kinds(name, kind, ctype, want):
    assert files.preview_of(name, kind, ctype) == want


def test_video_and_audio_have_kinds_and_old_others_are_read_again(env):
    assert files.kind_of("a.webm") == "video" and files.kind_of("a.flac") == "audio"
    env["db"]["files"].rows.append({"_id": "o1", "name": "take.mp4", "bytes": 1, "kind": "other",
                                    "content_type": "video/mp4", "context": {}, "by": {}, "note": "",
                                    "created_at": "2025-01-01T00:00:00+00:00"})
    got = env["web"].get("/api/files").json()[0]
    assert got["kind"] == "video" and got["preview"] == "video"


def test_tables_and_archives_are_read_for_the_preview(env):
    web = env["web"]
    csv_ = up(web, "bom.csv", "Designator;Comment\nR1;10k\n".encode("utf-16"))
    t = web.get(f"/api/files/{csv_['id']}/table").json()
    assert t["rows"] == [["Designator", "Comment"], ["R1", "10k"]] and not t["truncated"]
    book = io.BytesIO()
    with zipfile.ZipFile(book, "w") as z:
        z.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                   '<sheets><sheet name="Parts" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
                   'relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr("xl/sharedStrings.xml", '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                   '<si><t>Ref</t></si><si><t>U1</t></si></sst>')
        z.writestr("xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/'
                   '2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>3.5</v></c></row>'
                   '<row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>')
    x = up(web, "prices.xlsx", book.getvalue())
    t = web.get(f"/api/files/{x['id']}/table").json()
    assert t["sheets"] == ["Parts"] and t["rows"] == [["Ref", "", "3.5"], ["U1"]]
    z = up(web, "gerbers.zip", book.getvalue())
    e = web.get(f"/api/files/{z['id']}/entries").json()
    assert {x["name"] for x in e["entries"]} >= {"xl/workbook.xml", "xl/worksheets/sheet1.xml"}
    txt = up(web, "a.txt", b"not a zip")
    assert web.get(f"/api/files/{txt['id']}/entries").status_code == 415


def test_an_image_gets_a_small_picture_once(env):
    from PIL import Image
    web, db = env["web"], env["db"]
    buf = io.BytesIO()
    Image.new("RGB", (1600, 900)).save(buf, "PNG")
    f = up(web, "bench.png", buf.getvalue(), ctype="image/png")
    r = web.get(f"/api/files/{f['id']}/thumb")
    assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
    assert max(Image.open(io.BytesIO(r.content)).size) == files.THUMB_PX
    assert next(x for x in db["files"].rows if x["_id"] == f["id"])["thumb"]
    assert "thumb" not in web.get("/api/files").json()[0]           # never in a listing
    t = up(web, "a.txt", b"x")
    assert web.get(f"/api/files/{t['id']}/thumb").status_code == 404


# ---------------------------------------------------------------- names

@pytest.mark.parametrize("bad", ["", "   ", "a/b", "a\\b", "..", ".", "a\x00b", "x" * 181])
def test_a_bad_name_is_refused_not_changed(env, bad):
    f = up(env["web"], "ok.txt", b"x")
    r = env["web"].patch(f"/api/files/{f['id']}", headers=H, json={"name": bad})
    assert r.status_code == 400, (bad, r.text)


def test_rename_keeps_or_changes_the_kind_with_the_suffix(env):
    web = env["web"]
    f = up(web, "export.csv", b"Designator,Comment,Footprint\nU1,x,y\n")
    assert f["kind"] == "bom"
    r = web.patch(f"/api/files/{f['id']}", headers=H, json={"name": " Main BOM.csv "})
    assert r.status_code == 200 and r.json()["name"] == "Main BOM.csv" and r.json()["kind"] == "bom"
    r = web.patch(f"/api/files/{f['id']}", headers=H, json={"name": "Main BOM.txt"})
    assert r.json()["kind"] == "text" and r.json()["preview"] == "text"


def test_sending_keeps_a_history(env, monkeypatch):
    web = env["web"]
    f = up(web, "bom.csv", b"a,b\n")

    async def post(db, text, room=None, **kw):
        return {"id": "m", "text": text}
    monkeypatch.setattr(M.chat, "post", post)
    for room in ("pcb", "cad"):
        assert web.post(f"/api/files/{f['id']}/send", headers=H, json={"room": room}).status_code == 200
    got = web.get("/api/files").json()[0]
    assert [s["room"] for s in got["sent_log"]] == ["pcb", "cad"] and got["sent"]["room"] == "cad"


# ---------------------------------------------------------------- the command line

def test_the_cli_makes_folders_lists_them_and_moves(env, monkeypatch, tmp_path, capsys):
    from tools import revisions
    web = env["web"]

    class Answer(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def urlopen(req, timeout=None):
        path = req.full_url.removeprefix("http://localhost:8000")
        r = web.request(req.get_method(), path, content=req.data,
                        headers={**dict(req.header_items()), **H})
        assert r.status_code < 400, r.text
        return Answer(r.content)
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    monkeypatch.delenv("REDLINE_TOKEN", raising=False)
    monkeypatch.delenv("REDLINE_API", raising=False)

    def run(*argv):
        p = argparse.ArgumentParser()
        p.add_argument("what", nargs="?", default="list")
        p.add_argument("target", nargs="?")
        p.add_argument("dest", nargs="?")
        for o in ("-o", "--board", "--kind", "-q", "--note", "--folder", "--title"):
            p.add_argument(o)
        asyncio.run(revisions.cmd_files(p.parse_args(list(argv))))
        return capsys.readouterr().out

    assert "folder datasheets/power" in run("mkdir", "datasheets/power")
    src = tmp_path / "ldo.pdf"
    src.write_bytes(b"%PDF-1.4 ldo")
    out = run("put", str(src), "--folder", "datasheets/power")
    fid = out.split(" as ")[1].split()[0]
    assert "datasheets/power/ldo.pdf" in run("list", "--folder", "datasheets/power")
    assert "no files" in run("list", "--folder", "/")
    assert "moved 1 file(s)" in run("mv", fid, "/")
    assert fid in run("list", "--folder", "/")
    assert "moved 0 file(s), 1 folder(s)" in run("mv", "datasheets/power", "/")
    assert [f["path"] for f in web.get("/api/files/folders").json()] == ["datasheets", "power"]
    # put makes the folder when it is missing
    run("put", str(src), "--folder", "new/one")
    assert "new/one" in [f["path"] for f in web.get("/api/files/folders").json()]
    # the parser knows the new commands
    assert '"mkdir", "mv"' in open(revisions.__file__).read()
