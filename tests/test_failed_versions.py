"""A save that cannot build does not become a version anyone uses.

What went wrong: iot-fan/parts/enclosure was saved with source whose build
then failed, and that save was kept as v5 in the version history all the
same - a version a pin could point at and "latest" pointed at. Nothing
looked at the source at save time; the failure only showed at `build`.

What has to hold:

- a save is compiled (never run) and a syntax error is refused with its
  line, by the API and by the CLI's store call alike; nothing is written;
- a version whose own build failed is marked failed on its kept copy, and
  a later build of that version that works clears the mark;
- the history lists it as failed; a pin cannot point at it; "latest" (the
  versions route, "update them all", a model following the latest) skips
  it for the newest version that builds.
"""

from __future__ import annotations

import pytest

from backend import auth, build, links, store
from backend import main as M
from test_component_pins import H, Bucket
from test_links import FakeDb, client, model, run


@pytest.fixture
def db(monkeypatch, tmp_path):
    bucket = Bucket()
    monkeypatch.setattr(store, "bucket", lambda db, name: bucket)
    monkeypatch.setattr(store, "CACHE", tmp_path / "cache")
    return FakeDb()


@pytest.fixture
def api(monkeypatch, db):
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    return db


BROKEN = "W = 3\nPARTS = [\n    box(W,\n]\n"


# ---------------------------------------------------------------- the check at save

def test_a_syntax_error_is_refused_with_its_line_and_nothing_runs(tmp_path):
    with pytest.raises(store.SourceError) as got:
        store.check_source(BROKEN, "enclosure.py")
    assert got.value.line in (3, 4) and f"line {got.value.line}" in str(got.value)
    assert isinstance(got.value, ValueError)          # the route's 400 path
    with pytest.raises(store.SourceError) as got:
        store.check_source("def f():\nreturn 1\n")
    assert got.value.line == 2
    # Compiled, never run: source with side effects passes untouched.
    marker = tmp_path / "ran"
    store.check_source(f"open({str(marker)!r}, 'w').write('x')\nraise SystemExit(3)\n")
    assert not marker.exists()
    # A good source, and a name error (a build's problem, not a syntax one).
    store.check_source("W = 3\nPARTS = [box(W, W, W)]\n")


def test_a_save_that_does_not_compile_is_no_version(db):
    run(store.save_model(db, "p/part", "W = 1\nPARTS = []\n"))
    with pytest.raises(store.SourceError):
        run(store.save_model(db, "p/part", BROKEN))
    row = {r["_id"]: r for r in db["models"].rows}["p/part"]
    assert row["source"] == "W = 1\nPARTS = []\n" and row["version"] == 1
    assert [r["version"] for r in db["component_versions"].rows] == [1]


@pytest.mark.asyncio
async def test_the_save_route_answers_400_with_the_line(api):
    async with client() as c:
        r = await c.put("/api/models/p/part", json={"source": "W = 1\nPARTS = []\n"}, headers=H)
        assert r.status_code == 200, r.text
        r = await c.put("/api/models/p/part", json={"source": BROKEN}, headers=H)
        assert r.status_code == 400 and "syntax error on line" in r.json()["detail"], r.text
    assert {r["_id"]: r for r in api["models"].rows}["p/part"]["version"] == 1


# ---------------------------------------------------------------- failed versions

async def three_versions(db):
    db["models"].rows += [model("p/part", "W = 3\nPARTS = []\n", version=3),
                          model("p/tray", "import part\nPARTS = []\n", pins={"model:p/part": 1})]
    for v in (1, 2, 3):
        await links.archive(db, "model", "p/part", v, {"source": f"W = {v}\nPARTS = []\n"})


def test_a_failed_build_marks_its_version_and_a_good_one_clears_it(db):
    run(three_versions(db))
    assert run(store.version_built(db, "p/part", 3, "RuntimeError: boom")) is True
    assert run(store.failed_versions(db, "model", "p/part")) == {3}
    rows = run(links.versions(db, "model", "p/part"))
    assert [(r["version"], r["failed"]) for r in rows] == [(3, True), (2, False), (1, False)]
    assert rows[0]["error"] == "RuntimeError: boom"
    assert run(store.latest_good(db, "model", "p/part", 3)) == 2
    # Built again, and it worked: no longer failed.
    run(store.version_built(db, "p/part", 3))
    assert run(store.failed_versions(db, "model", "p/part")) == set()
    assert run(store.latest_good(db, "model", "p/part", 3)) == 3
    # A version that is not kept is not invented.
    assert run(store.version_built(db, "p/part", 9, "x")) is False
    assert run(store.version_built(db, "p/part", None, "x")) is False


def test_pins_and_latest_skip_a_failed_version(db):
    run(three_versions(db))
    run(store.version_built(db, "p/part", 3, "boom"))
    with pytest.raises(links.PinError, match="failed to build"):
        run(links.set_pin(db, "p/tray", "model:p/part", 3))
    # "Update them all" moves the pin to the newest version that builds.
    moved = run(links.update_pins(db, "model", "p/part"))
    assert [(m["model"], m["from"], m["to"]) for m in moved] == [("p/tray", 1, 2)]
    assert {r["_id"]: r for r in db["models"].rows}["p/tray"]["pins"] == {"model:p/part": 2}
    # Already there: nothing more to move.
    assert run(links.update_pins(db, "model", "p/part")) == []


def test_a_model_following_the_latest_is_built_with_the_latest_that_builds(db, tmp_path):
    db["models"].rows += [model("p/part", "W = 3\nPARTS = [\n", version=3),
                          model("p/tray", "import part\nPARTS = []\n")]
    for v in (2, 3):
        run(links.archive(db, "model", "p/part", v, {"source": f"W = {v}\nPARTS = []\n"}))
    got = run(links.prepare(db, "p/tray", tmp_path, tmp_path))
    assert not (tmp_path / "p__part.py").exists()              # v3 is fine so far: untouched
    run(store.version_built(db, "p/part", 3, "boom"))
    got = run(links.prepare(db, "p/tray", tmp_path, tmp_path))
    assert (tmp_path / "p__part.py").read_text() == "W = 2\nPARTS = []\n"
    assert any("v3 failed to build" in n and "v2" in n for n in got["notes"])


@pytest.mark.asyncio
async def test_a_builds_outcome_marks_the_version_and_the_history_says_so(api):
    """main.build_outcome is what the build runner records once a build
    has ended (backend/buildjobs.py): the version it was of, and how."""
    await three_versions(api)
    await M.build_outcome(api, {"model": "p/part", "version": 3, "by": "request"},
                          "RuntimeError: SyntaxError: nope")
    async with client() as c:
        got = (await c.get("/api/components/model/p/part/versions")).json()
        assert got["latest"] == 2 and got["newest"] == 3
        assert got["versions"][0]["version"] == 3 and got["versions"][0]["failed"] is True
        r = await c.post("/api/models/p/tray/pins",
                         json={"component": "model:p/part", "version": 3}, headers=H)
        assert r.status_code == 400 and "failed to build" in r.json()["detail"]

        # A rebuild a change elsewhere set off that breaks is not this
        # version's save breaking it: v2 stays good.
        await M.build_outcome(api, {"model": "p/part", "version": 2, "by": "link"}, "boom")
        assert (await c.get("/api/components/model/p/part/versions")).json()["latest"] == 2

        # Built again and it worked: the mark goes.
        await M.build_outcome(api, {"model": "p/part", "version": 3, "by": "request"}, None)
        got = (await c.get("/api/components/model/p/part/versions")).json()
        assert got["latest"] == 3 and got["versions"][0]["failed"] is False
