"""A STEP from the Files tab becomes a model in a project folder - a copy:
the model keeps its own CAD file, so deleting the file from Files later
does not break it, and an upload of the same name is never overwritten."""

from __future__ import annotations

import asyncio

import pytest

from backend import access, auth, build, files, store
from backend import main as M
from test_links import FakeDb, client

H = {"x-redline-csrf": "1"}
STEP = b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"


@pytest.fixture
def api(monkeypatch):
    db = FakeDb()
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    db["folders"].rows.append({"_id": "iot-fan/purchased", "name": "purchased", "parent": "iot-fan"})
    kept = {}

    async def fake_get(d, fid):
        if fid != "f1":
            raise KeyError(fid)
        return {"_id": "f1", "name": "OLED 0.91_128x32.stp", "kind": "step"}, STEP

    async def fake_put_upload(d, name, data):
        kept[name] = data
        await d.uploads.replace_one({"_id": name}, {"_id": name, "bytes": len(data)}, upsert=True)
        return {"name": name, "bytes": len(data), "at": "now"}

    async def fake_build(d, mid, script):
        await asyncio.sleep(0)
        return {"model": mid, "artifacts": {}, "log": "ok"}

    monkeypatch.setattr(files, "get", fake_get)
    monkeypatch.setattr(store, "put_upload", fake_put_upload)
    monkeypatch.setattr(build, "build", fake_build)
    return {"db": db, "kept": kept}


@pytest.mark.asyncio
async def test_a_step_from_files_becomes_a_model_in_the_folder(api):
    async with client() as c:
        r = await c.post("/api/files/f1/to-model", headers=H,
                         json={"folder": "iot-fan/purchased", "title": "OLED 0.91 inch module"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["model"] == "iot-fan/purchased/oled_0_91_128x32"
    assert out["upload"] == "OLED_0_91_128x32.stp" and api["kept"]["OLED_0_91_128x32.stp"] == STEP
    m = next(x for x in api["db"]["models"].rows if x["_id"] == out["model"])
    assert m["title"] == "OLED 0.91 inch module" and m["folder"] == "iot-fan/purchased"
    assert 'SRC = ROOT / "OLED_0_91_128x32.stp"' in m["source"]


@pytest.mark.asyncio
async def test_an_upload_of_the_same_name_is_not_overwritten(api):
    api["db"]["uploads"].rows.append({"_id": "OLED_0_91_128x32.stp", "bytes": 1})
    async with client() as c:
        r = await c.post("/api/files/f1/to-model", headers=H, json={"folder": "iot-fan/purchased"})
    assert r.status_code == 200, r.text
    assert r.json()["upload"] == "OLED_0_91_128x32_2.stp"
    assert "OLED_0_91_128x32.stp" not in api["kept"]


@pytest.mark.asyncio
async def test_only_cad_files_and_real_folders(api, monkeypatch):
    async with client() as c:
        r = await c.post("/api/files/f1/to-model", headers=H, json={"folder": "nowhere"})
        assert r.status_code == 404

        async def a_pdf(d, fid):
            return {"_id": fid, "name": "datasheet.pdf", "kind": "pdf"}, b"%PDF"
        monkeypatch.setattr(files, "get", a_pdf)
        r = await c.post("/api/files/f1/to-model", headers=H, json={"folder": "iot-fan/purchased"})
        assert r.status_code == 400


def test_making_a_model_takes_the_edit_right():
    a = access.action("POST", "/api/files/f1/to-model")
    assert access.allowed("editor", a) and not access.allowed("viewer", a)
