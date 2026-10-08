"""Notes on firmware: filed in the Firmware room, applied by its agent.

A firmware note is anchored to a pin or a net of the MCU, or to lines of
one of the firmware's files - checked when it is filed (backend/fwnotes.py).
The agent reads it (`revisions.py queue/next/show --room firmware`), edits
the files through `fw put` (refused when the firmware moved on since it
read them), builds, and finishes - which is refused until the version that
holds the change has built cleanly, and then keeps the diff, the build's
figures and a picture of the main changed hunk on the card.
"""

from __future__ import annotations

import asyncio
import io

import pytest
from fastapi.testclient import TestClient

from backend import access, auth, fwbuild, fwnotes, questions, store
from backend import main as M
from test_component_pins import Bucket
from test_firmware import board
from test_links import FakeDb
from tools import revisions

H = {"x-redline-csrf": "1"}


@pytest.fixture
def app(monkeypatch, tmp_path):
    raw = FakeDb()
    bucket = Bucket()
    monkeypatch.setattr(store, "bucket", lambda d, name: bucket)
    monkeypatch.setattr(M, "_raw_db", lambda: raw)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    monkeypatch.setattr(fwbuild, "CACHE", tmp_path / "fw")
    monkeypatch.setattr(M, "schedule_note_work", lambda rid: None)
    raw["boards"].rows.append(board())
    blobs = raw["source_blobs"]

    async def insert_many(docs, *a, **kw):           # the in-memory Mongo has no insert_many
        for d in docs:
            await blobs.insert_one(d)

    blobs.insert_many = insert_many

    async def spawn(raw_, job_id):
        return 4242

    monkeypatch.setattr(fwbuild, "spawn", spawn)
    web = TestClient(M.app)

    def call(path, method="GET", body=None, timeout=60):
        r = web.request(method, path, json=body, headers=H)
        if r.status_code >= 400:
            raise revisions.ApiError(f"{method} {path}: {r.status_code} {r.json().get('detail')}")
        return r.json()

    monkeypatch.setattr(revisions, "api_call", call)
    monkeypatch.setattr(revisions, "connect", lambda: raw)
    monkeypatch.setattr(revisions, "_fw_state", lambda fid: tmp_path / f"fw-{fid}.json")
    fid = web.post("/api/boards/demo/firmware", json={"mcu": "U2"}, headers=H).json()["id"]
    return {"raw": raw, "web": web, "fid": fid, "bucket": bucket}


def note(web, fid, anchor=None, comment="blink LED2 twice when the encoder button is pressed"):
    return web.post("/api/revisions", headers=H, json={
        "comment": comment, "image_png": None, "camera": None, "part": None,
        "model": fid, "kind": "firmware", "anchor": anchor})


def built(raw, fid, version, state="ok", flash=322453, ram=22992, errors=0):
    """What a build of `version` leaves on the firmware (backend/fwbuild.py execute)."""
    row = next(r for r in raw["firmware"].rows if r["_id"] == fid)
    row["build"] = {"state": state, "job": f"job{version}", "version": version, "at": store.now(),
                    "error_count": errors, "warning_count": 0, "errors": [], "warnings": [],
                    "flash": {"used": flash, "total": 1310720, "pct": round(flash * 100 / 1310720, 1)},
                    "ram": {"used": ram, "total": 327680, "pct": round(ram * 100 / 327680, 1)}}


# ---------------------------------------------------------------- filing one

def test_a_note_on_a_pin_is_kept_with_the_pin_as_the_board_draws_it(app):
    web, fid = app["web"], app["fid"]
    r = note(web, fid, {"kind": "pin", "pin": "33"})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["kind"] == "firmware" and got["model"] == fid
    a = got["anchor"]
    assert a["kind"] == "pin" and a["net"] == "L_SDA" and a["gpio"] == 21 and a["macro"] == "L_SDA"
    assert "OLED_MODULE" in a["parts"] and a["version"] == 1
    # by the net's name, as a click on the sheet sends it
    by_net = note(web, fid, {"kind": "net", "net": "LED2"}).json()["anchor"]
    assert by_net["pin"] == "11" and by_net["gpio"] == 26
    # a pin the MCU does not have, a net no pin is on
    assert note(web, fid, {"kind": "pin", "pin": "99"}).status_code == 422
    assert "no pin of U2 is on net NOPE" in note(web, fid, {"kind": "net", "net": "NOPE"}).json()["detail"]
    # no anchor: about the firmware as a whole
    assert note(web, fid).json()["anchor"] is None
    listed = [x for x in web.get("/api/revisions").json() if x["kind"] == "firmware"]
    assert len(listed) == 3


def test_a_note_on_code_must_name_a_file_and_lines_inside_it(app):
    web, fid = app["web"], app["fid"]
    r = note(web, fid, {"kind": "code", "file": "src/main.cpp", "lines": [5, 3]})
    assert r.status_code == 200, r.text
    a = r.json()["anchor"]
    assert a["file"] == "src/main.cpp" and a["lines"] == [3, 5]
    assert a["excerpt"].splitlines()[0] == '#include "pins.h"'
    assert note(web, fid, {"kind": "code", "file": "src/nope.cpp", "lines": [1, 1]}).status_code == 422
    out = note(web, fid, {"kind": "code", "file": "src/main.cpp", "lines": [10, 400]})
    assert out.status_code == 422 and "outside it" in out.json()["detail"]
    assert note(web, fid, {"kind": "code", "file": "../etc/passwd", "lines": [1, 1]}).status_code == 422
    assert note(web, fid, {"kind": "weird"}).status_code == 422
    assert note(web, "nofw", {"kind": "pin", "pin": "33"}).status_code == 404


# ---------------------------------------------------------------- the agent's side

def test_queue_and_next_give_the_firmware_room_its_notes(app, capsys):
    web, fid = app["web"], app["fid"]
    rid = note(web, fid, {"kind": "code", "file": "src/main.cpp", "lines": [5, 6]}).json()["id"]
    cad = web.post("/api/revisions", headers=H, json={
        "comment": "fillet the lid", "image_png": None, "camera": None, "part": None,
        "model": "p/box"}).json()["id"]
    for x in (rid, cad):
        assert web.patch(f"/api/revisions/{x}?status=queued", headers=H).status_code == 200
    asyncio.run(revisions.cmd_queue(revisions.argparse.Namespace(room="firmware")))
    out = capsys.readouterr().out
    assert rid in out and "[FIRMWARE]" in out and "src/main.cpp:5-6" in out and cad not in out
    asyncio.run(revisions.cmd_next(revisions.argparse.Namespace(room="firmware", out=None)))
    out = capsys.readouterr().out
    assert f"next    : {rid}" in out and "[FIRMWARE NOTE]" in out
    assert ">    5" in out and "build   : never built" in out and f"fw files {fid}" in out
    with pytest.raises(SystemExit):
        asyncio.run(revisions.cmd_next(revisions.argparse.Namespace(room="pcb", out=None)))


def fw_args(what, fid, *rest, **kw):
    return revisions.argparse.Namespace(what=what, fw=fid, rest=list(rest), out=kw.get("out"),
                                        version=None, base=kw.get("base"), note=kw.get("note"),
                                        wait=False)


def test_fw_put_is_refused_when_the_firmware_moved_on(app, tmp_path, capsys):
    web, fid = app["web"], app["fid"]
    revisions.cmd_fw(fw_args("files", fid))
    assert "src/main.cpp" in capsys.readouterr().out
    mine = tmp_path / "main.cpp"
    revisions.cmd_fw(fw_args("get", fid, "src/main.cpp", out=str(mine)))
    mine.write_text(mine.read_text() + "// mine\n")
    # somebody else saves first
    assert web.post(f"/api/firmware/{fid}/files", headers=H,
                    json={"files": {"src/extra.cpp": "int x;\n"}, "base": 1}).status_code == 200
    with pytest.raises(revisions.ApiError) as no:
        revisions.cmd_fw(fw_args("put", fid, "src/main.cpp", str(mine)))
    assert "409" in str(no.value) and "read it again" in str(no.value)
    # read again, then it goes in on top of theirs
    revisions.cmd_fw(fw_args("files", fid))
    revisions.cmd_fw(fw_args("put", fid, "src/main.cpp", str(mine), note="mine"))
    assert "saved v3 (on v2)" in capsys.readouterr().out
    # pins.h is the schematic's
    with pytest.raises(revisions.ApiError):
        revisions.cmd_fw(fw_args("put", fid, "include/pins.h", str(mine)))
    revisions.cmd_fw(fw_args("diff", fid))
    out = capsys.readouterr().out
    assert "v2 -> v3" in out and "+// mine" in out


def test_finish_waits_for_a_clean_build_of_the_change_then_keeps_it_on_the_card(app, tmp_path, capsys):
    raw, web, fid = app["raw"], app["web"], app["fid"]
    rid = note(web, fid, {"kind": "pin", "pin": "11"}).json()["id"]
    web.patch(f"/api/revisions/{rid}?status=queued", headers=H)
    built(raw, fid, 1, flash=300000)
    r = web.post("/api/run/start", headers=H, json={"title": "blink LED2", "revision": rid, "room": "firmware"})
    assert r.status_code == 200, r.text
    rev = next(x for x in raw["revisions"].rows if x["_id"] == rid)
    assert rev["fw_base"]["version"] == 1 and rev["fw_base"]["build"]["flash"]["used"] == 300000

    def refused():
        r = web.post(f"/api/revisions/{rid}/firmware-result", headers=H)
        assert r.status_code == 409, r.text
        return r.json()["detail"]

    assert "still at v1" in refused()
    main = web.get(f"/api/firmware/{fid}/files/src/main.cpp").json()["content"]
    new = main.replace("void loop() {", "void loop() {\n  digitalWrite(LED2, HIGH);")
    assert web.post(f"/api/firmware/{fid}/files", headers=H,
                    json={"files": {"src/main.cpp": new}, "base": 1, "note": "LED2"}).status_code == 200
    assert "v2 has not been built" in refused()
    # the room's own finish is refused too, and the run stays open
    r = web.post("/api/run/finish?room=firmware", headers=H)
    assert r.status_code == 409 and "not finished" in r.json()["detail"]
    with pytest.raises(SystemExit) as no:
        asyncio.run(revisions.cmd_finish(revisions.argparse.Namespace(
            id=rid, failed=False, room="cad", no_shot=False)))
    assert "not finished" in str(no.value)
    assert web.get("/api/run?room=firmware").json()["status"] == "running"
    built(raw, fid, 2, state="errors", errors=3)
    assert "the build of v2 failed: 3 error(s)" in refused()
    built(raw, fid, 2, flash=300512)
    asyncio.run(revisions.cmd_finish(revisions.argparse.Namespace(
        id=rid, failed=False, room="cad", no_shot=False)))
    out = capsys.readouterr().out
    assert "firmware: 1 file(s), +1 -0, main change src/main.cpp" in out and "ready to flash" in out
    assert web.get("/api/run?room=firmware").json()["status"] == "done"
    card = web.get(f"/api/revisions/{rid}").json()
    fr = card["fw_result"]
    assert fr["from_version"] == 1 and fr["version"] == 2 and fr["added"] == 1 and fr["removed"] == 0
    assert [f["path"] for f in fr["files"]] == ["src/main.cpp"]
    assert "+  digitalWrite(LED2, HIGH);" in fr["files"][0]["diff"]
    assert fr["build"]["errors"] == 0 and fr["build"]["flash"]["before"]["used"] == 300000
    assert fr["build"]["flash"]["after"]["used"] == 300512
    assert fr["main"]["file"] == "src/main.cpp" and fr["main"]["line"] == new.splitlines().index(
        "  digitalWrite(LED2, HIGH);") + 1
    # the after picture is the changed hunk, a PNG
    assert card["image_after_bytes"] > 1000
    png = web.get(f"/api/revisions/{rid}/image?which=after").content
    from PIL import Image
    assert Image.open(io.BytesIO(png)).size == (1280, 720)
    # what changed, for the side-by-side view, by file
    ch = web.get(f"/api/revisions/{rid}/changes").json()
    assert [(f["kind"], f["id"]) for f in ch["files"]] == [("firmware", f"{fid}/src/main.cpp")]
    assert ch["files"][0]["after_text"] == new


def test_the_main_hunk_is_never_pins_h_when_code_changed():
    files = [{"path": "include/pins.h", "generated": True, "added": 9, "removed": 9,
              "diff": "@@ -1,2 +1,2 @@\n-a\n+b\n-c\n+d\n"},
             {"path": "src/ui.cpp", "generated": False, "added": 1, "removed": 0,
              "diff": "@@ -10,3 +10,4 @@\n x\n y\n+z\n w\n"}]
    m = fwnotes.main_hunk(files)
    assert m["file"] == "src/ui.cpp" and m["line"] == 12


# ---------------------------------------------------------------- who may, and where it is asked

def test_filing_is_drawing_finishing_is_running():
    a = access.action("POST", "/api/revisions")
    assert a == "draw" and access.allowed("reviewer", a) and not access.allowed("viewer", a)
    f = access.action("POST", "/api/revisions/20261008-x/firmware-result")
    assert f == "run" and access.allowed("editor", f) and not access.allowed("reviewer", f)
    assert access.allowed("viewer", access.action("GET", "/api/firmware/abc/diff"))
    assert not access.page_allowed("POST", "/api/revisions/20261008-x/firmware-result")


def test_a_question_about_a_firmware_note_is_the_firmware_rooms(app):
    raw, web, fid = app["raw"], app["web"], app["fid"]
    rid = note(web, fid, {"kind": "pin", "pin": "11"}).json()["id"]

    async def go():
        q1 = await questions.ask(raw, "Blink how fast?", ["2 Hz", "5 Hz"], revision=rid)
        q2 = await questions.ask(raw, "Which LED?", room="firmware")
        return await questions.with_rooms(raw, [q1, q2])
    got = asyncio.run(go())
    assert [q["room"] for q in got] == ["firmware", "firmware"]
