"""A STEP in the Files tab opened in 3D: the server meshes it once, keeps the
GLB by the file's content, and answers "preparing" while it works.

The routes run over the in-memory Mongo and GridFS stand-ins of
test_files_folders; one test reads a real STEP with OpenCascade.
"""

from __future__ import annotations

import asyncio
import json
import struct
import time

import pytest
from fastapi.testclient import TestClient

from backend import access, auth, filemesh, files
from backend import main as M
from test_files_folders import H, Grid, up
from test_links import FakeDb


@pytest.fixture
def env(monkeypatch):
    db = FakeDb()
    grid, meshes = Grid(), Grid()
    monkeypatch.setattr(files, "_bucket", lambda d: grid)
    monkeypatch.setattr(filemesh, "_bucket", lambda d: meshes)
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    # One client for the whole test, so a conversion outlives the request
    # that started it; without the database the start-up hooks do nothing
    # (they would look for builds to recover on this machine).
    monkeypatch.setattr(M, "MONGODB_URI", "")
    with TestClient(M.app) as web:
        yield {"db": db, "meshes": meshes, "web": web}


def fake_convert(monkeypatch, delay=0.0, error=None):
    """step3d stood in for: a GLB that says which call made it."""
    calls = []

    async def convert(src, dst):
        calls.append(src.read_bytes())
        await asyncio.sleep(delay)
        if error:
            return {"error": error}
        dst.write_bytes(b"glTF" + str(len(calls)).encode())
        return {"triangles": 12, "size": [10, 20, 30], "deflection": 0.04}
    monkeypatch.setattr(filemesh, "_convert", convert)
    return calls


def test_a_real_step_comes_back_as_a_glb_and_is_kept(env, tmp_path):
    pytest.importorskip("build123d")
    from build123d import Box, Color, export_step
    part = Box(10, 20, 30)
    part.color = Color(0.8, 0.1, 0.1)
    export_step(part, str(tmp_path / "box.step"))
    f = up(env["web"], "box.step", (tmp_path / "box.step").read_bytes())
    assert f["preview"] == "step"

    t0 = time.monotonic()
    r = env["web"].get(f"/api/files/{f['id']}/mesh", params={"wait": 25})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "model/gltf-binary" and r.headers["x-mesh-cached"] == "0"
    glb = r.content
    assert glb[:4] == b"glTF"
    head = json.loads(glb[20:20 + struct.unpack("<I", glb[12:16])[0]])
    # the part's colour came through, and the box is 10 x 20 x 30 mm (in metres)
    colours = [m["pbrMetallicRoughness"]["baseColorFactor"][:3] for m in head["materials"]]
    assert any(c[0] > 0.5 and c[1] < 0.2 for c in colours), colours
    lo, hi = head["accessors"][0]["min"], head["accessors"][0]["max"]
    assert sorted(round(b - a, 4) for a, b in zip(lo, hi)) == [0.01, 0.02, 0.03]
    first = time.monotonic() - t0

    t1 = time.monotonic()
    again = env["web"].get(f"/api/files/{f['id']}/mesh")
    assert again.status_code == 200 and again.headers["x-mesh-cached"] == "1"
    assert again.content == glb
    assert time.monotonic() - t1 < first


def test_the_second_open_and_the_same_bytes_elsewhere_are_not_meshed_again(env, monkeypatch):
    calls = fake_convert(monkeypatch)
    a = up(env["web"], "a.stp", b"ISO-10303-21; one")
    b = up(env["web"], "copy of a.step", b"ISO-10303-21; one")
    for fid in (a["id"], a["id"], b["id"]):
        r = env["web"].get(f"/api/files/{fid}/mesh")
        assert r.status_code == 200 and r.content == b"glTF1"
    assert len(calls) == 1
    rec = next(iter(env["db"]["file_meshes"].rows))
    assert rec["_id"].startswith(a["sha256"]) and rec["triangles"] == 12
    assert "workspace_id" not in rec                 # by content: no workspace's


def test_preparing_while_it_is_made_then_the_model(env, monkeypatch):
    calls = fake_convert(monkeypatch, delay=0.6)
    f = up(env["web"], "slow.step", b"ISO-10303-21; slow")
    r = env["web"].get(f"/api/files/{f['id']}/mesh", params={"wait": 0})
    assert r.status_code == 202 and r.json()["state"] == "preparing"
    assert r.headers["cache-control"] == "no-store"
    # a second asker joins the same conversion
    r = env["web"].get(f"/api/files/{f['id']}/mesh", params={"wait": 0})
    assert r.status_code == 202
    r = env["web"].get(f"/api/files/{f['id']}/mesh", params={"wait": 5})
    assert r.status_code == 200 and r.content == b"glTF1"
    assert len(calls) == 1


def test_an_unreadable_step_is_refused_and_remembered(env, monkeypatch):
    calls = fake_convert(monkeypatch, error="not a STEP file OpenCascade can read")
    f = up(env["web"], "broken.step", b"not really")
    for _ in range(2):
        r = env["web"].get(f"/api/files/{f['id']}/mesh")
        assert r.status_code == 422 and "OpenCascade" in r.json()["detail"]
    assert len(calls) == 1


def test_only_a_step_is_meshed(env, monkeypatch):
    calls = fake_convert(monkeypatch)
    for name in ("part.stl", "notes.txt", "photo.png"):
        f = up(env["web"], name, b"solid x")
        r = env["web"].get(f"/api/files/{f['id']}/mesh")
        assert r.status_code == 415, name
    assert env["web"].get("/api/files/nope/mesh").status_code == 404
    assert calls == []


def test_another_workspaces_step_cannot_be_read(env, monkeypatch):
    calls = fake_convert(monkeypatch)
    mine = up(env["web"], "mine.step", b"ISO-10303-21; shared bytes")
    assert env["web"].get(f"/api/files/{mine['id']}/mesh").status_code == 200
    # theirs has the very same bytes - so the same kept mesh - and still is not ours to open
    env["db"]["files"].rows.append({**{k: v for k, v in env["db"]["files"].rows[0].items() if k != "_id"},
                                    "_id": "theirs@team2", "workspace_id": "team2", "name": "theirs.step"})
    env["db"]["files"].rows.append({"_id": "other", "workspace_id": "team2", "name": "other.step",
                                    "sha256": "f" * 64, "bytes": 4, "gridfs_id": "g0", "kind": "step"})
    for fid in ("theirs", "theirs@team2", "other"):
        assert env["web"].get(f"/api/files/{fid}/mesh").status_code == 404, fid
    assert len(calls) == 1


def test_the_mesh_is_looking_not_changing():
    assert access.action("GET", "/api/files/abc123/mesh") == "view"
    assert access.allowed("viewer", access.action("GET", "/api/files/abc123/mesh"))
