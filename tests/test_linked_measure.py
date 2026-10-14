"""A saved part's real size, measured from its STEP (backend/linked_measure.py,
backend/imports/stepmeasure.py): the box, a screw's length under the head,
and a mismatch where the words say otherwise.

tests/fixtures/step holds two screws made with OpenCascade: an M3 pan head
25 mm under a 6 x 2.4 mm head, and an M3 countersunk 20 mm with a 1.7 mm
cone head (21.7 mm overall)."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from backend import linked_measure as lm
from backend import mcmaster
from test_files_folders import Grid
from test_linked import STEP
from test_users_admin import db, person  # noqa: F401 - db is a fixture

FIX = Path(__file__).resolve().parent / "fixtures" / "step"
PAN = FIX / "pan_m3x25.step"
CSK = FIX / "csk_m3x20.step"


def run(c):
    return asyncio.run(c)


@pytest.fixture
def grid(monkeypatch):
    from backend import files
    g = Grid()
    monkeypatch.setattr(files, "_bucket", lambda d: g)
    return g


def test_a_pan_head_screw_is_measured_under_its_head():
    pytest.importorskip("OCP")
    from backend.imports import stepmeasure
    got = stepmeasure.measure(str(PAN))
    assert got["size"] == [6.0, 6.0, 27.4] and got["axis"] == "z"
    s = got["screw"]
    assert s["countersunk"] is False and s["length"] == pytest.approx(25.0, abs=0.1)
    assert s["head"] == pytest.approx(2.4, abs=0.1) and s["head_d"] == pytest.approx(6.0, abs=0.05)
    assert s["shank"] == pytest.approx(3.0, abs=0.05)


def test_a_countersunk_screw_is_sold_by_its_overall_length():
    pytest.importorskip("OCP")
    got = run(lm.run(CSK))                                 # as the server runs it: a process of its own
    s = got["screw"]
    assert got["size"] == [6.0, 6.0, 21.7]
    assert s["countersunk"] is True and s["length"] == pytest.approx(21.7, abs=0.05)
    assert s["head"] == pytest.approx(1.7, abs=0.15) and s["shank"] == pytest.approx(3.0, abs=0.05)


def test_a_file_that_is_not_a_step_says_so(tmp_path):
    pytest.importorskip("OCP")
    bad = tmp_path / "x.step"
    bad.write_bytes(b"not a step at all")
    assert "error" in run(lm.run(bad))


def _item(title="Pan Head Phillips Screw", specs=None, measured=None, tags=None):
    cad = {"file": "f1", "kind": "step", "sha256": "abc"}
    m = measured if measured is not None else {
        "v": lm.VERSION, "sha256": "abc", "size": [6.0, 6.0, 27.45], "axis": "z",
        "screw": {"head": 2.47, "head_d": 5.99, "shank": 3.0, "length": 24.98, "under_head": 24.98,
                  "overall": 27.45, "countersunk": False}}
    return {"title": title, "specs": specs or {}, "tags": tags or [], "cad": cad, "measured": m}


def test_the_measured_rows_and_a_title_that_says_otherwise():
    v = lm.view(_item(specs={"Thread size": "M3", "Length": "30 mm"}))
    assert v["rows"] == [["Size", "6 × 6 × 27.45 mm"], ["Length", "24.98 mm under the head"],
                         ["Head", "Ø5.99 × 2.47 mm"], ["Shank", "Ø3 mm"]]
    assert v["mismatch"] == [{"what": "Length", "said": "30 mm", "measured": "24.98 mm"}]
    # what the title says counts when the specs say nothing
    v = lm.view(_item(title="M4 x 0.7 mm Thread, 25 mm Long Pan Head Screw"), mcmaster.specs_of)
    assert [b["what"] for b in v["mismatch"]] == ["Thread"]
    # 25 mm said, 24.98 measured: no mismatch; inches are read too
    assert lm.view(_item(specs={"Length": "25 mm", "Thread": "M3 x 0.5 mm"}))["mismatch"] == []
    assert lm.view(_item(specs={"Length": '1"'}))["mismatch"] == []                 # 25.4 mm
    assert lm.view(_item(specs={"Length": '1-1/2"'}))["mismatch"][0]["said"] == '1-1/2"'
    s = lm.specs(lm.view(_item(specs={"Length": "30 mm"})))
    assert s["Size (measured from STEP)"] == "6 × 6 × 27.45 mm"
    assert s["Length (measured from STEP)"] == "24.98 mm under the head - not 30 mm as said"


def test_only_a_screw_by_name_gets_a_length_under_the_head():
    v = lm.view(_item(title="Male-Female Threaded Hex Standoff", specs={"Length": "30 mm"}))
    assert v["rows"] == [["Size", "6 × 6 × 27.45 mm"]] and v["mismatch"] == [] and not v["screw"]
    assert lm.view(_item(title="Fan", measured={}))["pending"] is True          # not measured yet
    assert lm.view({**_item(), "cad": {"kind": "mesh", "sha256": "x"}}) is None   # no STEP: nothing to say
    gone = lm.view(_item(measured={"v": lm.VERSION, "sha256": "abc", "error": "unreadable"}))
    assert gone["error"] == "unreadable" and gone["rows"] == []
    assert lm._mm_of("1-1/4\"") == pytest.approx(31.75) and lm._mm_of("0.5 in") == pytest.approx(12.7)
    assert lm._thread_of("1/4\"-20") == pytest.approx(6.35) and lm._thread_of("#4-40") is None


def test_a_dropped_step_is_measured_after_the_answer(db, grid):  # noqa: F811
    pytest.importorskip("OCP")
    a = person(db, "a")
    key = "cat:phillips-pan-head-machine-screws+system-of-measurement~metric+length~30-mm+thread-size~m3"
    it = a.post("/api/linked/mcmaster/parts", json={"key": key, "title": "Phillips Pan Head Machine Screws",
                                                     "specs": {"Thread size": "M3", "Length": "30 mm"}}).json()["part"]
    assert it["measured"] is None                                 # no STEP yet
    r = a.post(f"/api/linked/mcmaster/parts/{it['id']}/files",
               files={"upload": ("92000A130_Pan Head Phillips Screws.STEP", PAN.read_bytes())}).json()
    assert r["measured"]["pending"] is True                       # the answer does not wait for it
    got = a.get("/api/linked/mcmaster/parts/92000A130").json()
    m = got["measured"]
    assert m["rows"][0] == ["Size", "6 × 6 × 27.4 mm"] and m["rows"][1] == ["Length", "25 mm under the head"]
    assert m["mismatch"] == [{"what": "Length", "said": "30 mm", "measured": "25 mm"}]
    assert got["specs"] == {"Thread size": "M3", "Length": "30 mm"}             # what was said stays
    p = a.get("/api/manufacturers/mcmaster").json()["products"][0]
    assert p["specs"]["Length (measured from STEP)"] == "25 mm under the head - not 30 mm as said"
    assert p["specs"]["Length"] == "30 mm"
    # a STEP with nothing in it is kept as unmeasurable, without a reader started
    it2 = a.post("/api/linked/mcmaster/parts", json={"key": "91290A115"}).json()["part"]
    a.post(f"/api/linked/mcmaster/parts/{it2['id']}/files", files={"upload": ("91290A115.STEP", STEP)})
    assert a.get("/api/linked/mcmaster/parts/91290A115").json()["measured"]["error"] == "the STEP has no geometry in it"
    assert a.get("/api/linked/mcmaster/parts/nothing-here").status_code == 404


def test_a_step_the_mcmaster_api_fetches_is_measured_as_a_dropped_one(db, grid, monkeypatch):  # noqa: F811
    pytest.importorskip("OCP")
    from backend import linked, scope

    async def conf(_db):
        return {"username": "u", "password": "p", "cert": {"data": "x"}, "auto_step": True}

    async def download_step(self, part):
        return f"{part}_Pan Head Phillips Screws.STEP", PAN.read_bytes()
    monkeypatch.setattr(mcmaster, "conf", conf)
    monkeypatch.setattr(mcmaster.Api, "download_step", download_step)
    d = scope.ScopedDb(db, scope.DEFAULT)

    async def go():
        doc, _ = await linked.save(d, mcmaster.KIND, {"key": "92000A130", "specs": {"Length": "30 mm"}})
        have = await d[linked.COLL].find_one({"_id": doc["_id"]})
        assert have["cad"]["kind"] == "step" and lm.running(d, doc["_id"])   # measuring, the save answered
        await asyncio.gather(*lm._tasks)
        return await d[linked.COLL].find_one({"_id": doc["_id"]})
    got = run(go())
    v = lm.view(got)
    assert v["rows"][1] == ["Length", "25 mm under the head"] and v["mismatch"][0]["said"] == "30 mm"
    assert "measuring" not in got and not lm._running


def test_a_measurement_a_reload_cut_off_finishes_by_itself(db, grid):  # noqa: F811
    pytest.importorskip("OCP")
    from datetime import datetime, timedelta, timezone

    from backend import files, linked, scope
    d = scope.ScopedDb(db, scope.DEFAULT)
    long_ago = (datetime.now(timezone.utc) - timedelta(seconds=lm.STALE_AFTER + 5)).isoformat(timespec="seconds")

    async def item(key, at):
        f = await files.put(d, f"{key}.step", PAN.read_bytes(), None, {}, {"name": "o"})
        cad = {"file": f["_id"], "name": f["name"], "kind": "step", "sha256": f["sha256"]}
        await d[linked.COLL].insert_one({"_id": key, "source": "mcmaster", "key": key, "title": "Pan Head Screw",
                                         "cad": cad, "files": [cad], "measuring": {"file": f["_id"], "at": at}})
        return await d[linked.COLL].find_one({"_id": key})

    async def go():
        # the API stopped while each was measured: the one it starts with measures them
        a = await item("a1", lm._now())
        assert lm.view(a)["pending"] and not lm.cut_off(a)      # a start just now: maybe still running elsewhere
        assert await lm.recover(db) == 1 and lm.running(d, "a1")
        assert await lm.recover(db) == 0                       # not twice
        await asyncio.gather(*lm._tasks)
        a = await d[linked.COLL].find_one({"_id": "a1"})
        assert lm.view(a)["rows"][1] == ["Length", "25 mm under the head"] and "measuring" not in a
        # read while waiting, its start older than the time limit and nothing measuring it: measured again
        b = await item("b1", long_ago)
        assert lm.cut_off(b) and lm.resume(d, b) and not lm.resume(d, b)
        await asyncio.gather(*lm._tasks)
        b = await d[linked.COLL].find_one({"_id": "b1"})
        assert lm.view(b)["rows"] and not lm.resume(d, b)       # measured: nothing to do
        c = await item("c1", lm._now())
        assert not lm.resume(d, c)                              # a start within the limit is left to finish
    run(go())
