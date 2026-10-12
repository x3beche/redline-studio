"""A new project is a folder laid out the same way every time: parts/ for
3D parts, electronics/ for boards (backend/store.py create_project). And
what is made inside one lands in a folder that is listed: a model saved
to a path whose folders are not there makes them, a CAD file can go
straight into parts/, a new board into electronics/.

The routes run over the small in-memory Mongo of test_links."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from backend import auth, store
from backend import main as M
from test_links import FakeDb

H = {"x-redline-csrf": "1"}


def run(c):
    return asyncio.run(c)


@pytest.fixture
def env(monkeypatch):
    db = FakeDb()
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    return {"db": db, "web": TestClient(M.app)}


def folders(db) -> set[str]:
    return {f["_id"] for f in db["folders"].rows}


def test_a_project_is_its_folder_and_the_kinds_it_holds(env):
    web, db = env["web"], env["db"]
    r = web.post("/api/catalog/projects", headers=H, json={"name": "lamp", "kinds": ["parts", "electronics"]})
    assert r.status_code == 200, r.text
    assert r.json() == {"path": "lamp", "folders": ["lamp", "lamp/parts", "lamp/electronics"]}
    r = web.post("/api/catalog/projects", headers=H, json={"name": "case", "kinds": ["parts"]})
    assert r.json()["folders"] == ["case", "case/parts"]
    r = web.post("/api/catalog/projects", headers=H, json={"name": "probe", "kinds": ["electronics"]})
    assert r.json()["folders"] == ["probe", "probe/electronics"]
    # The tree shows them as folders under the project.
    tree = web.get("/api/catalog").json()
    lamp = next(f for f in tree["folders"] if f["path"] == "lamp")
    assert [f["name"] for f in lamp["folders"]] == ["electronics", "parts"]


def test_a_project_is_refused_whole(env):
    web, db = env["web"], env["db"]
    post = lambda body: web.post("/api/catalog/projects", headers=H, json=body)
    assert post({"name": "lamp", "kinds": []}).status_code == 400            # neither kind
    assert post({"name": "lamp", "kinds": ["firmware"]}).status_code == 400  # not a kind
    assert post({"name": "my lamp", "kinds": ["parts"]}).status_code == 400  # not a folder name
    assert post({"name": "../x", "kinds": ["parts"]}).status_code == 400
    assert folders(db) == set()
    assert post({"name": "lamp", "kinds": ["parts"]}).status_code == 200
    assert post({"name": "lamp", "kinds": ["electronics"]}).status_code == 409   # there already
    assert folders(db) == {"lamp", "lamp/parts"}


def test_a_failure_halfway_takes_back_what_was_made(env, monkeypatch):
    db = env["db"]
    real = store.create_folder

    async def flaky(d, parent, name):
        if name == "electronics":
            raise RuntimeError("database went away")
        return await real(d, parent, name)

    monkeypatch.setattr(store, "create_folder", flaky)
    with pytest.raises(RuntimeError):
        run(store.create_project(db, "lamp", ["parts", "electronics"]))
    assert folders(db) == set()


def test_a_model_saved_into_a_new_path_makes_its_folders(env):
    db = env["db"]
    run(store.save_model(db, "lamp/assemblies/stand", "W = 1.0\nPARTS = []\n"))
    assert folders(db) == {"lamp", "lamp/assemblies"}
    run(store.save_model(db, "lamp/parts/arm", "W = 1.0\nPARTS = []\n"))
    assert folders(db) == {"lamp", "lamp/assemblies", "lamp/parts"}
    # at the top: no folder
    run(store.save_model(db, "loose", "W = 1.0\nPARTS = []\n"))
    assert folders(db) == {"lamp", "lamp/assemblies", "lamp/parts"}
    # a folder name that cannot be one is refused, and nothing is saved
    with pytest.raises(ValueError):
        run(store.save_model(db, "my lamp/arm", "W = 1.0\nPARTS = []\n"))
    assert not run(db.models.find_one({"_id": "my lamp/arm"}))


def test_a_cad_file_goes_into_the_folder_asked_for(env, monkeypatch):
    web = env["web"]

    async def put_upload(d, name, data):
        return {"name": name, "bytes": len(data), "at": "now"}

    monkeypatch.setattr(store, "put_upload", put_upload)
    r = web.post("/api/uploads", headers=H, params={"folder": "lamp/parts"},
                 files={"file": ("bracket.step", b"ISO-10303-21;", "application/octet-stream")})
    assert r.status_code == 200, r.text
    assert r.json()["model"] == "lamp/parts/bracket"
    assert {"lamp", "lamp/parts"} <= folders(env["db"])
    r = web.post("/api/uploads", headers=H, params={"folder": "a b"},
                 files={"file": ("x.step", b"x", "application/octet-stream")})
    assert r.status_code == 400


def test_a_new_board_is_listed_in_the_folder_given_once(env):
    web, db = env["web"], env["db"]
    src = "module App:\n    pass\n"
    sent = []
    real = db.boards.update_one

    async def update_one(q, update, *a, **kw):
        sent.append(update)
        return await real(q, update, *a, **kw)

    db.boards.update_one = update_one
    r = web.put("/api/boards/driver", headers=H, json={"source": src, "folder": "lamp/electronics"})
    assert r.status_code == 200, r.text
    # Set on insert only. (The in-memory Mongo cannot tell an insert from a
    # scoped filter, so what was asked of it is what is read.)
    assert sent[-1]["$setOnInsert"]["folder"] == "lamp/electronics"
    assert {"lamp", "lamp/electronics"} <= folders(db)
    # A later save does not move one that is there: that is /move.
    db.boards.rows[:] = [{"_id": "old", "folder": "lamp/electronics", "source": src}]
    web.put("/api/boards/old", headers=H, json={"source": src, "folder": "other/electronics"})
    assert db.boards.rows[0]["folder"] == "lamp/electronics"
    assert "other" not in folders(db)
    assert web.put("/api/boards/x", headers=H, json={"source": src, "folder": "a b"}).status_code == 400
