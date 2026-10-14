"""Files' read-only folders (backend/files_virtual.py): the Projects tree
with the rooms' own files, the Chat's and Parts' references, nothing of
them renamed, moved or deleted from Files; a file deleted from Files said
to be gone on the Chat line and the product that used it; and how much
there is, counted once.

The routes run over a small in-memory Mongo that reads into arrays as
Mongo does (`messages.mentions.id`) and writes by position
(`messages.0.mentions.1.gone`).
"""

from __future__ import annotations

import asyncio
import copy
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from backend import auth, cc_chat, files, files_virtual as fv, scope, store
from backend import main as M
from test_files_folders import Grid
from test_links import Coll, Cursor, FakeDb, Res

H = {"x-redline-csrf": "1"}
NOW = datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------- a Mongo that reads into arrays

def _vals(doc, key: str) -> list:
    """Every value a dotted key reaches, through lists as Mongo goes."""
    out = [doc]
    for part in key.split("."):
        nxt = []
        for d in out:
            if isinstance(d, dict) and part in d:
                nxt.append(d[part])
            elif isinstance(d, list):
                if part.isdigit() and int(part) < len(d):
                    nxt.append(d[int(part)])
                else:
                    nxt += [x[part] for x in d if isinstance(x, dict) and part in x]
        out = nxt
    flat = []
    for v in out:
        flat += v if isinstance(v, list) else [v]
    return flat if flat or out else []


def match(doc, q) -> bool:
    for k, v in (q or {}).items():
        if k == "$and":
            if not all(match(doc, x) for x in v):
                return False
            continue
        if k == "$or":
            if not any(match(doc, x) for x in v):
                return False
            continue
        got = _vals(doc, k)
        if isinstance(v, dict) and any(op.startswith("$") for op in v):
            for op, a in v.items():
                if op == "$exists" and bool(got) != bool(a):
                    return False
                if op == "$in" and not any(g in a for g in got):
                    return False
                if op == "$ne" and (a in got or (a is None and not got)):
                    return False
                if op == "$lt" and not any(g is not None and g < a for g in got):
                    return False
                if op == "$gte" and not any(g is not None and g >= a for g in got):
                    return False
        elif v is None:
            if got and None not in got:
                return False
        elif v not in got:
            return False
    return True


def put(doc, key: str, value) -> None:
    *head, last = key.split(".")
    for part in head:
        doc = doc[int(part)] if isinstance(doc, list) else doc.setdefault(part, {})
    if isinstance(doc, list):
        doc[int(last)] = copy.deepcopy(value)
    else:
        doc[last] = copy.deepcopy(value)


class ArrColl(Coll):
    def _one(self, q):
        return next((r for r in self.rows if match(r, q)), None)

    def find(self, q=None, projection=None, *a, **kw):
        return Cursor([copy.deepcopy(r) for r in self.rows if match(r, q)])

    async def update_one(self, q, update, upsert=False, *a, **kw):
        row = self._one(q)
        if row is None:
            return Res(0)
        for k, v in (update.get("$set") or {}).items():
            put(row, k, v)
        for k, cond in (update.get("$pull") or {}).items():
            row[k] = [x for x in row.get(k) or [] if not (isinstance(x, dict) and match(x, cond))]
        for k in (update.get("$unset") or {}):
            *head, last = k.split(".")
            at = row
            for part in head:
                at = at[int(part)] if isinstance(at, list) else at.get(part, {})
            if isinstance(at, dict):
                at.pop(last, None)
        return Res(1)

    async def replace_one(self, q, doc, upsert=False, *a, **kw):
        row = self._one(q)
        if row is None:
            if upsert:
                self.rows.append(copy.deepcopy(doc))
            return Res(0)
        row.clear()
        row.update(copy.deepcopy(doc))
        return Res(1)

    async def count_documents(self, q=None, **kw):
        return sum(1 for r in self.rows if match(r, q))

    async def delete_one(self, q, *a, **kw):
        row = self._one(q)
        if row is None:
            return Res(0)
        self.rows.remove(row)
        return Res(1)

    async def delete_many(self, q, *a, **kw):
        keep = [r for r in self.rows if not match(r, q)]
        n = len(self.rows) - len(keep)
        self.rows[:] = keep
        return Res(n)


class ArrDb(FakeDb):
    def __getitem__(self, name):
        return self.colls.setdefault(name, ArrColl())


# ---------------------------------------------------------------- a workspace with a project

def seed(db) -> None:
    db["folders"].rows += [{"_id": "lamp", "name": "lamp", "parent": ""},
                           {"_id": "lamp/parts", "name": "parts", "parent": "lamp"},
                           {"_id": "lamp/electronics", "name": "electronics", "parent": "lamp"}]
    db["models"].rows.append({"_id": "lamp/parts/arm", "name": "arm", "title": "Arm", "folder": "lamp/parts",
                              "source": "PARTS = []\n", "sha256": "s1", "updated_at": NOW, "artifacts": {
                                  "step": {"gridfs_id": "x", "bytes": 5000, "stored_bytes": 900, "sha256": "a" * 64,
                                           "at": NOW},
                                  "viewer": {"gridfs_id": "y", "bytes": 8000, "stored_bytes": 1000, "sha256": "b" * 64,
                                             "at": NOW}}})
    db["boards"].rows.append({"_id": "ctrl", "title": "Controller", "folder": "lamp/electronics",
                              "source": "module App:\n", "saved_at": NOW, "artifacts": {
                                  "routed": {"bytes": 300, "stored_bytes": 100, "sha256": "c", "at": NOW},
                                  "graph": {"bytes": 50, "stored_bytes": 20, "sha256": "d", "at": NOW}}})
    db["firmware"].rows.append({"_id": "fw1", "title": "U2 ESP32", "board": "ctrl", "folder": "lamp/electronics",
                                "updated_at": NOW, "build": {"at": NOW, "artifacts": {
                                    "firmware.bin": {"gridfs_id": "6ac753ca4b4fed6ad9e5d6c0", "bytes": 4096}}}})
    db["firmware_files"].rows += [
        {"_id": "f1", "firmware": "fw1", "path": "src/main.cpp", "version": 1, "content": "old", "bytes": 3, "at": NOW},
        {"_id": "f2", "firmware": "fw1", "path": "src/main.cpp", "version": 2, "content": "void loop(){}",
         "bytes": 13, "at": NOW}]
    db["releases"].rows.append({"_id": "r1", "project": "lamp", "tag": "v1", "status": "ready", "bytes": 777,
                                "zip_id": "z", "created_at": NOW})


@pytest.fixture
def env(monkeypatch):
    db = ArrDb()
    grid = Grid()
    monkeypatch.setattr(files, "_bucket", lambda d: grid)
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)

    async def artifact(d, mid, label, coll="models"):
        return f"{coll}:{mid}:{label}".encode() * 10
    monkeypatch.setattr(store, "get_artifact", artifact)
    seed(db)
    return {"db": db, "web": TestClient(M.app), "sdb": scope.ScopedDb(db, scope.DEFAULT)}


def up(web, name, data=b"hello", folder=""):
    r = web.post("/api/files", headers=H, data={"folder": folder}, files={"upload": (name, data, "text/plain")})
    assert r.status_code == 200, r.text
    return r.json()[0]


def by_name(rows, name):
    return next(r for r in rows if r["name"] == name)


# ---------------------------------------------------------------- ids

def test_an_entry_id_holds_slashes_safely_and_refuses_anything_else():
    v = fv.vid("ma", "lamp/parts/arm", "step")
    assert "/" not in v and v.startswith("v:ma:") and fv.is_virtual(v)
    assert fv.unvid(v) == ("ma", ["lamp/parts/arm", "step"])
    for bad in ("v:ma:!!!", "v:nope", "v:ma:" + "e30"):           # e30 = {} - not a list
        with pytest.raises(KeyError):
            fv.unvid(bad)
    assert not fv.is_virtual("abc123") and not fv.is_virtual("")


# ---------------------------------------------------------------- the tree

def test_projects_mirror_the_project_tree_with_each_rooms_files(env):
    t = env["web"].get("/api/files/virtual").json()
    dirs, rows = t["folders"], t["files"]
    roots = [d for d in dirs if d.get("root")]
    assert [d["name"] for d in roots] == ["Projects", "Chat", "Parts", "Agents", "Taste"] and all(d["ro"] for d in dirs)
    lamp = by_name(dirs, "lamp")
    parts = by_name(dirs, "parts")
    assert lamp["parent"] == fv.PROJECTS and parts["parent"] == lamp["id"]
    arm = by_name(dirs, "arm.3d")
    assert arm["parent"] == parts["id"] and arm["open"] == {"room": "cad", "model": "lamp/parts/arm"}
    # the source and the STEP in the model's folder; the 3D view's mesh apart, as the build's own data
    assert by_name(rows, "arm.py")["folder"] == arm["id"] and by_name(rows, "arm.py")["bytes"] == len(b"PARTS = []\n")
    step = by_name(rows, "arm.step")
    assert step["folder"] == arm["id"] and step["bytes"] == 5000 and step["stored"] == 900 and step["preview"] == "step"
    viewer = by_name(rows, "arm.viewer.json")
    assert by_name(dirs, "Build data")["id"] == viewer["folder"] and viewer["preview"] == "none"
    # a board, its source and KiCad file; its firmware under it, at its newest version; the project's releases
    board = by_name(dirs, "Controller.pcb")
    assert board["parent"] == by_name(dirs, "electronics")["id"]
    assert by_name(rows, "ctrl.ato")["folder"] == board["id"] and by_name(rows, "ctrl.kicad_pcb")["folder"] == board["id"]
    fw = by_name(dirs, "U2 ESP32")
    assert fw["parent"] == board["id"]
    assert by_name(rows, "src/main.cpp")["bytes"] == 13 and by_name(rows, "firmware.bin")["folder"] == fw["id"]
    rel = by_name(dirs, "Releases")
    assert rel["parent"] == lamp["id"] and by_name(rows, "lamp-v1.zip")["folder"] == rel["id"]


def test_a_projects_file_is_read_in_place_whole_or_in_part(env):
    web = env["web"]
    rows = web.get("/api/files/virtual").json()["files"]
    src = by_name(rows, "arm.py")
    r = web.get(f"/api/files/{src['id']}?inline=1")
    assert r.status_code == 200 and r.content == b"PARTS = []\n"
    r = web.get(f"/api/files/{src['id']}", headers={"Range": "bytes=0-4"})
    assert r.status_code == 206 and r.content == b"PARTS"
    step = by_name(rows, "arm.step")
    assert web.get(f"/api/files/{step['id']}").content.startswith(b"models:lamp/parts/arm:step")
    main = by_name(rows, "src/main.cpp")
    assert web.get(f"/api/files/{main['id']}").content == b"void loop(){}"
    info = web.get(f"/api/files/{step['id']}/info").json()
    assert info["folder_path"] == "Projects/lamp/parts/arm.3d" and info["ro"] is True
    # an id that names nothing here
    assert web.get(f"/api/files/{fv.vid('ma', 'nope', 'step')}").status_code == 404


def test_nothing_read_only_is_renamed_moved_or_deleted(env):
    web = env["web"]
    t = web.get("/api/files/virtual").json()
    f = by_name(t["files"], "arm.py")["id"]
    d = by_name(t["folders"], "arm.3d")["id"]
    mine = up(web, "notes.txt")
    tries = [
        web.patch(f"/api/files/{f}", headers=H, json={"name": "x.py"}),
        web.delete(f"/api/files/{f}", headers=H),
        web.post("/api/files/bulk-delete", headers=H, json={"files": [mine["id"], f]}),
        web.post("/api/files/move", headers=H, json={"files": [f], "to": ""}),
        web.post("/api/files/move", headers=H, json={"files": [mine["id"]], "to": d}),
        web.patch(f"/api/files/folders/{d}", headers=H, json={"name": "y"}),
        web.delete(f"/api/files/folders/{d}?contents=true", headers=H),
        web.post("/api/files/folders", headers=H, json={"name": "z", "parent": d}),
        web.post("/api/files", headers=H, data={"folder": d}, files={"upload": ("a.txt", b"a", "text/plain")}),
    ]
    for r in tries:
        assert r.status_code == 403 and "read-only" in r.json()["detail"], r.text
    assert "3D Drawing room" in tries[0].json()["detail"]
    # and the upload refused with the rest was not deleted either
    assert web.get(f"/api/files/{mine['id']}").status_code == 200


def test_a_read_only_folder_downloads_as_a_zip(env):
    import io
    import zipfile
    web = env["web"]
    arm = by_name(web.get("/api/files/virtual").json()["folders"], "arm.3d")["id"]
    r = web.get(f"/api/files/zip?folders={arm}")
    assert r.status_code == 200
    names = sorted(zipfile.ZipFile(io.BytesIO(r.content)).namelist())
    assert names == ["arm.3d/Build data/arm.viewer.json", "arm.3d/arm.py", "arm.3d/arm.step"]


# ---------------------------------------------------------------- Chat and Parts, and a file deleted

def chat_with(db, fid, name, context="<context kind=\"file\">...</context>"):
    db["cc_chats"].rows.append({"_id": "c1", "title": "BOM check", "updated_at": NOW, "messages": [
        {"id": "m1", "role": "user", "content": "look at this", "context": context,
         "mentions": [{"kind": "note", "id": "n1", "label": "n"}, {"kind": "file", "id": fid, "label": name}]},
        {"id": "m2", "role": "assistant", "content": "It is a BOM."}]})


def test_chat_and_parts_folders_refer_to_the_files_they_used(env):
    web, db = env["web"], env["db"]
    a = up(web, "pic.png")
    b = up(web, "datasheet.pdf")
    up(web, "mine.txt")
    chat_with(db, a["id"], "pic.png")
    db["product_files"].rows.append({"_id": "p1", "mid": "m9", "pid": "77", "name": "Fan 40 mm",
                                     "files": [{"file": b["id"], "name": "datasheet.pdf"}]})
    db["manufacturers"].rows.append({"_id": "m9", "name": "Noctua"})
    t = web.get("/api/files/virtual").json()
    conv = by_name(t["folders"], "BOM check")
    assert conv["parent"] == fv.CHAT
    maker = by_name(t["folders"], "Noctua")
    prod = by_name(t["folders"], "Fan 40 mm")
    assert maker["parent"] == fv.PARTS and prod["parent"] == maker["id"]
    assert {"folder": conv["id"], "file": a["id"]} in t["links"]
    assert {"folder": prod["id"], "file": b["id"]} in t["links"]
    # a conversation in the Chat's trash is not listed
    db["cc_chats"].rows[0]["deleted_at"] = NOW
    assert "BOM check" not in [d["name"] for d in web.get("/api/files/virtual").json()["folders"]]


def test_a_deleted_file_is_said_to_be_gone_on_the_line_and_the_product(env):
    web, db = env["web"], env["db"]
    f = up(web, "bom.csv")
    chat_with(db, f["id"], "bom.csv")
    db["product_files"].rows.append({"_id": "p1", "mid": "m9", "pid": "77", "name": "Fan",
                                     "files": [{"file": f["id"], "name": "bom.csv"}], "cad": {"file": f["id"]}})
    used = web.get(f"/api/files/uses?ids={f['id']}").json()[f["id"]]
    assert used["chats"] == ["BOM check"] and used["products"] == ["Fan"]
    assert web.delete(f"/api/files/{f['id']}", headers=H).status_code == 200
    m = db["cc_chats"].rows[0]["messages"][0]
    gone = m["mentions"][1]["gone"]
    assert gone["at"] and "by" in gone and "gone" not in m["mentions"][0]
    assert "was deleted from Files" in m["context"] and f["id"] in m["context"]
    # the page gets the mark with the chip; the model reads it in the line's context
    assert cc_chat.public(m)["mentions"][1]["gone"] == gone
    sent = cc_chat.history(db["cc_chats"].rows[0]["messages"])
    assert any("bom.csv" in x["content"] and "was deleted" in x["content"] for x in sent if x["role"] == "user")
    p = db["product_files"].rows[0]
    assert p["files"][0]["gone"] == gone and p["cad"]["gone"] == gone
    # marked once: deleting again finds nothing, and a second mark is not added
    assert web.delete(f"/api/files/{f['id']}", headers=H).status_code == 404
    assert m["context"].count("was deleted from Files") == 1


def test_mark_gone_leaves_a_line_alone_when_it_moved(env):
    db, sdb = env["db"], env["sdb"]
    chat_with(db, "f1", "a.png")
    got = asyncio.run(fv.mark_gone(sdb, {"_id": "f1", "name": "a.png"}, {"id": "u", "name": "Ada"}))
    assert got == {"chats": 1, "products": 0}
    assert "by Ada" in db["cc_chats"].rows[0]["messages"][0]["context"]


# ---------------------------------------------------------------- how much there is

def test_usage_counts_every_file_once_per_area(env):
    web, db = env["web"], env["db"]
    a = up(web, "pic.png", b"x" * 100)
    b = up(web, "datasheet.pdf", b"y" * 200)
    up(web, "mine.txt", b"z" * 40)
    chat_with(db, a["id"], "pic.png")
    db["product_files"].rows.append({"_id": "p1", "mid": "m9", "pid": "77", "name": "Fan",
                                     "files": [{"file": b["id"], "name": "datasheet.pdf"}]})
    u = web.get("/api/files/usage").json()
    ar = u["areas"]
    # one's own files a conversation and a product only refer to stay one's own, said shared there
    assert ar["chat"] == {"files": 0, "bytes": 0, "stored": 0, "shared": {"files": 1, "bytes": 100}}
    assert ar["parts"]["files"] == 0 and ar["parts"]["shared"] == {"files": 1, "bytes": 200}
    assert ar["own"]["files"] == 3 and ar["own"]["bytes"] == 340
    projects = web.get("/api/files/virtual").json()["files"]
    assert ar["projects"]["files"] == len(projects) and ar["projects"]["bytes"] == sum(f["bytes"] for f in projects)
    assert u["total"]["files"] == sum(x["files"] for x in ar.values())
    assert u["total"]["bytes"] == sum(x["bytes"] for x in ar.values())
    sizes = [r["bytes"] for r in u["largest"]]
    assert sizes == sorted(sizes, reverse=True) and u["largest"][0]["name"] == "arm.viewer.json"
    # the 3D view's mesh is a build output, not "text"
    assert u["kinds"]["build"]["bytes"] >= 8000 and by_name(u["files"], "arm.viewer.json")["kind"] == "build"
    # everything was added today: the range picked is the shortest, and the chart holds it all
    assert u["range"] == "7d" and u["chart"]["n"] == 7 and u["chart"]["step"] == 86400
    assert [x["name"] for x in u["chart"]["series"]] == ["projects", "chat", "parts", "agents", "taste", "own"]
    assert sum(sum(x["values"]) for x in u["chart"]["series"]) == u["added"]["bytes"] == u["total"]["bytes"]
    every = web.get("/api/files/usage?range=all").json()
    assert every["range"] == "all" and every["total"] == u["total"]
    # this week: three uploads, and one deleted
    web.delete(f"/api/files/{a['id']}", headers=H)
    week = web.get("/api/files/usage").json()["week"]
    assert len(week) == 7 and week[-1]["added"] == 2 and week[-1]["deleted"] == 1


def test_a_file_two_areas_use_is_counted_once_and_shown_shared(env):
    web, db = env["web"], env["db"]
    # sent in the Chat: the Chat's own upload (its composer keeps it in the Chat folder)
    f = {"id": asyncio.run(files.put(env["sdb"], "UB0228.STEP", b"s" * 300, None, {"room": "chat"}, {"id": "u1"}))["_id"]}
    db["product_files"].rows.append({"_id": "p1", "mid": "m9", "pid": "77", "name": "Adapter",
                                     "files": [{"file": f["id"], "name": "UB0228.STEP"}]})
    ar = web.get("/api/files/usage").json()["areas"]
    assert ar["chat"]["files"] == 1 and ar["chat"]["bytes"] == 300
    assert ar["parts"]["files"] == 0 and ar["parts"]["shared"] == {"files": 1, "bytes": 300}


# ---------------------------------------------------------------- the trash

def test_a_deleted_file_waits_in_the_trash_and_comes_back_whole(env):
    web, db = env["web"], env["db"]
    folder = web.post("/api/files/folders", headers=H, json={"name": "Docs"}).json()
    f = up(web, "bom.csv", b"a,b\n", folder=folder["id"])
    chat_with(db, f["id"], "bom.csv")
    db["product_files"].rows.append({"_id": "p1", "mid": "m9", "pid": "77", "name": "Fan",
                                     "files": [{"file": f["id"], "name": "bom.csv"}]})
    assert web.delete(f"/api/files/{f['id']}", headers=H).status_code == 200
    assert web.get(f"/api/files/{f['id']}").status_code == 404
    t = web.get("/api/files/trash").json()
    row = by_name(t["files"], "bom.csv")
    assert t["days"] == files.TRASH_DAYS and row["days_left"] == files.TRASH_DAYS and row["folder_path"] == "Docs"
    assert web.get("/api/files/usage").json()["trash"]["files"] == 1
    # its folder went meanwhile: it is made again from its path
    db["file_folders"].rows.clear()
    r = web.post("/api/files/trash/restore", headers=H, json={"files": [f["id"]]})
    assert r.status_code == 200 and [x["name"] for x in r.json()["restored"]] == ["bom.csv"]
    assert web.get(f"/api/files/{f['id']}").content == b"a,b\n"
    back = web.get(f"/api/files/{f['id']}/info").json()
    assert back["folder_path"] == "Docs" and web.get("/api/files/trash").json()["files"] == []
    # the chat line and the product no longer say it is gone; the model is no longer told so
    m = db["cc_chats"].rows[0]["messages"][0]
    assert "gone" not in m["mentions"][1] and "was deleted" not in m["context"]
    assert "gone" not in db["product_files"].rows[0]["files"][0]


def test_the_trash_is_emptied_for_good_by_hand_and_when_its_days_are_up(env):
    web, db = env["web"], env["db"]
    a = up(web, "a.txt", b"aa")
    b = up(web, "b.txt", b"bb")
    web.post("/api/files/bulk-delete", headers=H, json={"files": [a["id"], b["id"]]})
    assert {x["name"] for x in web.get("/api/files/trash").json()["files"]} == {"a.txt", "b.txt"}
    assert web.post("/api/files/trash/purge", headers=H, json={"files": [a["id"]]}).json()["purged"] == [a["id"]]
    # past its days, the sweep takes it
    db["file_trash"].rows[0]["purge_at"] = "2000-01-01T00:00:00+00:00"
    assert web.get("/api/files/trash").json()["files"] == []
    assert web.post("/api/files/trash/restore", headers=H, json={"files": [b["id"]]}).json()["restored"] == []


# ---------------------------------------------------------------- the Parts page's own uploads

def test_the_parts_pages_uploads_are_read_only_in_files_and_still_change_on_the_parts_page(env, monkeypatch):
    from backend import access, product_files
    web, db = env["web"], env["db"]
    parts = web.post("/api/files/folders", headers=H, json={"path": "Parts/Noctua"}).json()
    top = next(f for f in db["file_folders"].rows if f["path"] == "Parts")
    f = up(web, "fan.step", b"ISO-10303-21;", folder="")
    db["files"].rows[-1]["context"] = {"room": "catalog", "product": "m9:77"}
    mine = up(web, "notes.txt")
    listed = {x["id"]: x for x in web.get("/api/files").json()}
    assert listed[f["id"]]["ro"] is True and listed[f["id"]]["where"] == "parts" and "ro" not in listed[mine["id"]]
    assert {x["id"]: x for x in web.get("/api/files/folders").json()}[top["_id"]]["ro"] is True
    refused = [
        web.patch(f"/api/files/{f['id']}", headers=H, json={"name": "x.step"}),
        web.delete(f"/api/files/{f['id']}", headers=H),
        web.post("/api/files/bulk-delete", headers=H, json={"files": [f["id"]]}),
        web.post("/api/files/move", headers=H, json={"files": [mine["id"]], "to": parts["id"]}),
        web.post("/api/files/move", headers=H, json={"files": [f["id"]], "to": ""}),
        web.patch(f"/api/files/folders/{top['_id']}", headers=H, json={"name": "P"}),
        web.delete(f"/api/files/folders/{top['_id']}?contents=true", headers=H),
        web.post("/api/files", headers=H, data={"folder": parts["id"]}, files={"upload": ("a.txt", b"a", "text/plain")}),
    ]
    for r in refused:
        assert r.status_code == 403 and "Parts page" in r.json()["detail"], r.text
    # one's own file a product only refers to stays one's own
    db["product_files"].rows.append({"_id": "p1", "mid": "m9", "pid": "77", "name": "Fan", "files": [{"file": mine["id"]}]})
    assert web.patch(f"/api/files/{mine['id']}", headers=H, json={"note": "x"}).status_code == 200
    # the Parts page's own way still removes it (product_files.detach -> files.remove)
    assert asyncio.run(files.remove(env["sdb"], f["id"])) is True


@pytest.mark.parametrize("role,page,ok", [("owner", False, True), ("editor", False, True), ("viewer", False, False),
                                          ("owner", True, False)])
def test_files_writes_follow_the_role_and_a_page_session_only_looks(env, monkeypatch, role, page, ok):
    web = env["web"]
    f = up(web, "a.txt")

    async def session(db, cookie):
        return {"user": {"type": "user", "id": "u1", "name": "One"}, "workspace": scope.DEFAULT, "role": role, "page": page}
    monkeypatch.setattr(auth, "enabled", lambda: True)
    monkeypatch.setattr(auth, "session_user", session)
    monkeypatch.setattr(auth, "csrf_ok", lambda *a: True)
    tries = [web.patch(f"/api/files/{f['id']}", headers=H, json={"note": "n"}),
             web.post("/api/files/trash/restore", headers=H, json={"files": []}),
             web.post(f"/api/files/{f['id']}/copy", headers=H, json={})]
    for r in tries:
        assert (r.status_code == 200) == ok, (role, page, r.status_code, r.text)
    # reading is everyone's
    assert web.get("/api/files/virtual").status_code == 200 and web.get("/api/files/trash").status_code == 200


# ---------------------------------------------------------------- the Chat's own uploads

def chat_upload(env, name, data=b"png", **ctx):
    return asyncio.run(files.put(env["sdb"], name, data, None, {"room": "chat", **ctx}, {"id": "u1", "name": "One"}))["_id"]


def test_the_chats_uploads_are_the_chats_and_read_only_in_files(env):
    web, db = env["web"], env["db"]
    pic = chat_upload(env, "pasted.png")
    mine = up(web, "bom.csv")["id"]                 # one's own, later mentioned in a chat
    chat_with(db, mine, "bom.csv")
    db["cc_chats"].rows[0]["messages"][0]["mentions"].append({"kind": "file", "id": pic, "label": "pasted.png"})
    listed = {x["id"]: x for x in web.get("/api/files").json()}
    assert listed[pic]["ro"] is True and listed[pic]["where"] == "chat" and "ro" not in listed[mine]
    for r in (web.patch(f"/api/files/{pic}", headers=H, json={"name": "x.png"}), web.delete(f"/api/files/{pic}", headers=H),
              web.post("/api/files/bulk-delete", headers=H, json={"files": [pic]})):
        assert r.status_code == 403 and "Chat" in r.json()["detail"]
    assert web.patch(f"/api/files/{mine}", headers=H, json={"note": "n"}).status_code == 200
    t = web.get("/api/files/virtual").json()
    conv = by_name(t["folders"], "BOM check")
    assert {"folder": conv["id"], "file": pic} in t["links"] and {"folder": conv["id"], "file": mine} in t["links"]
    # one no conversation holds is in a folder of its own
    loose = chat_upload(env, "never-sent.png")
    t = web.get("/api/files/virtual").json()
    assert {"folder": by_name(t["folders"], "Not in a conversation")["id"], "file": loose} in t["links"]


def test_a_chat_line_or_conversation_deleted_takes_its_own_uploads_to_the_trash(env):
    web, db = env["web"], env["db"]
    pic = chat_upload(env, "pasted.png")
    pdf = chat_upload(env, "made.pdf", chat="c1")
    mine = up(web, "bom.csv")["id"]
    chat_with(db, mine, "bom.csv")
    db["cc_chats"].rows[0]["messages"][0]["mentions"].append({"kind": "file", "id": pic, "label": "pasted.png"})
    db["cc_chats"].rows.append({"_id": "c2", "title": "Other", "messages": [
        {"id": "x1", "role": "user", "content": "again", "mentions": [{"kind": "file", "id": pic, "label": "pasted.png"}]}]})
    # the line goes; the picture is still another conversation's, one's own file stays one's own
    assert web.delete("/api/cc/chats/c1/messages/m1", headers=H).status_code == 200
    assert web.get(f"/api/files/{pic}").status_code == 200 and web.get(f"/api/files/{mine}").status_code == 200
    # the other conversation deleted for good: the picture goes to Files' trash; the PDF made for c1 too once c1 goes
    assert web.delete("/api/cc/chats/c2?forever=1", headers=H).status_code == 200
    assert web.get(f"/api/files/{pic}").status_code == 404
    assert web.delete("/api/cc/chats/c1?forever=1", headers=H).status_code == 200
    gone = {x["id"] for x in web.get("/api/files/trash").json()["files"]}
    assert gone == {pic, pdf} and web.get(f"/api/files/{mine}").status_code == 200


def test_the_chat_undo_putting_a_file_back_clears_its_deleted_mark(env):
    from backend import chat_undo
    web, db, sdb = env["web"], env["db"], env["sdb"]
    f = up(web, "bom.csv")
    chat_with(db, f["id"], "bom.csv")
    doc = copy.deepcopy(next(r for r in db["files"].rows if r["_id"] == f["id"]))
    asyncio.run(files.remove(sdb, f["id"], forever=True))
    assert db["cc_chats"].rows[0]["messages"][0]["mentions"][1].get("gone")
    db["files"].rows.append(doc)                      # what the undo's own inverse does (chat_undo._apply_doc)
    asyncio.run(chat_undo.AFTER["files"](sdb, {"op": "delete", "coll": "files", "id": f["id"]}))
    m = db["cc_chats"].rows[0]["messages"][0]
    assert "gone" not in m["mentions"][1] and "was deleted" not in m["context"]


def test_the_trash_is_swept_on_a_timer_too(env):
    db = env["db"]
    a = up(env["web"], "a.txt")
    env["web"].delete(f"/api/files/{a['id']}", headers=H)
    db["file_trash"].rows[0]["purge_at"] = "2000-01-01T00:00:00+00:00"

    async def once():
        task = asyncio.create_task(files.trash_loop(db, every=3600))
        await asyncio.sleep(0.05)
        task.cancel()
    asyncio.run(once())
    assert db["file_trash"].rows == []


# ---------------------------------------------------------------- generated files reach My files only as a copy

def test_an_agents_file_is_the_agents_and_reaches_my_files_only_as_a_copy(env):
    web, db, sdb = env["web"], env["db"], env["sdb"]
    agent = {"type": "agent", "id": "pcb room", "name": "pcb room"}
    fid = asyncio.run(files.put(sdb, "bom-out.csv", b"a,b\n", None, {"room": "pcb"}, agent))["_id"]
    listed = {x["id"]: x for x in web.get("/api/files").json()}
    assert listed[fid]["ro"] is True and listed[fid]["where"] == "agents"
    t = web.get("/api/files/virtual").json()
    assert {"folder": by_name(t["folders"], "pcb room")["id"], "file": fid} in t["links"]
    r = web.delete(f"/api/files/{fid}", headers=H)
    assert r.status_code == 403 and "agent made it" in r.json()["detail"]
    # a copy: one's own, its own bytes; deleting it leaves the agent's alone
    mine = web.post(f"/api/files/{fid}/copy", headers=H, json={"folder_path": "Reports/2026", "name": "bom v2.csv"}).json()
    assert mine["name"] == "bom v2.csv" and "ro" not in {x["id"]: x for x in web.get("/api/files").json()}[mine["id"]]
    assert web.get(f"/api/files/{mine['id']}").content == b"a,b\n"
    assert web.delete(f"/api/files/{mine['id']}", headers=H).status_code == 200
    assert web.get(f"/api/files/{fid}").content == b"a,b\n"
    # a room's own file copies the same way; never into the Chat's or the Parts page's folders
    src = by_name(t["files"], "arm.py")["id"]
    assert web.post(f"/api/files/{src}/copy", headers=H, json={}).json()["name"] == "arm.py"
    assert web.post(f"/api/files/{src}/copy", headers=H, json={"folder_path": "Chat/x"}).status_code == 403
    assert web.post("/api/files/nope/copy", headers=H, json={}).status_code == 404


def test_the_chats_save_to_my_files_tool_copies_the_last_file_it_made(env, monkeypatch):
    from backend import access, chat_tools
    from backend.chat_tools import Ctx, ToolError
    web, db, sdb = env["web"], env["db"], env["sdb"]
    pdf = chat_upload(env, "Parts and Stock Report.pdf", b"%PDF-1.4 r", chat="c1")
    tool = chat_tools.tools()["file_save_to_my_files"]
    assert tool.level == "change" and "dosyalarıma kaydet" in tool.description
    got = asyncio.run(tool.run(Ctx(db=sdb, actor={"id": "u1", "name": "One"}, chat="c1"), {"file": "last", "folder": "Reports"}))
    new = got.vars["file"]
    row = {x["id"]: x for x in web.get("/api/files").json()}[new]
    assert row["name"] == "Parts and Stock Report.pdf" and "ro" not in row and new != pdf
    assert web.get(f"/api/files/{new}/info").json()["folder_path"] == "Reports"
    # the Chat's original stays, the Chat's
    assert {x["id"]: x for x in web.get("/api/files").json()}[pdf]["where"] == "chat"
    monkeypatch.setattr(access, "current", lambda: "viewer")
    with pytest.raises(ToolError):
        asyncio.run(tool.run(Ctx(db=sdb, actor={"id": "u1"}, chat="c1"), {"file": pdf}))


def test_the_agents_save_mine_command_copies_through_the_api(env, monkeypatch, capsys):
    import argparse
    import io
    import urllib.request
    from tools import revisions
    web = env["web"]
    agent = {"type": "agent", "id": "3d room", "name": "3d room"}
    fid = asyncio.run(files.put(env["sdb"], "render.png", b"png", None, {"room": "cad"}, agent))["_id"]

    class Answer(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def urlopen(req, timeout=None):
        r = web.request(req.get_method(), req.full_url.removeprefix("http://localhost:8000"), content=req.data,
                        headers={**dict(req.header_items()), **H})
        assert r.status_code < 400, r.text
        return Answer(r.content)
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    monkeypatch.delenv("REDLINE_TOKEN", raising=False)
    monkeypatch.delenv("REDLINE_API", raising=False)
    p = argparse.ArgumentParser()
    p.add_argument("what")
    p.add_argument("target")
    p.add_argument("dest", nargs="?")
    for o in ("-o", "--board", "--kind", "-q", "--note", "--folder", "--title", "--name"):
        p.add_argument(o)
    asyncio.run(revisions.cmd_files(p.parse_args(["save-mine", fid, "--folder", "Renders", "--name", "lid.png"])))
    out = capsys.readouterr().out
    assert "saved a copy to My files/Renders: lid.png" in out
    copy = next(x for x in web.get("/api/files").json() if x["name"] == "lid.png")
    assert "ro" not in copy and web.get(f"/api/files/{copy['id']}").content == b"png"
