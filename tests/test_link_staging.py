"""Staging a build and the link queue: what was used is the latest unless
said otherwise, and a rebuild that would make the same thing is not run.

- a pin anywhere in the chain is honoured by staging *and* by "built
  against", and the build says so;
- a board is staged from the kept copy of its current version, so its
  number and its geometry are one version's;
- a queued rebuild whose inputs a build since has already used is marked
  done (coalesced), not run again;
- a card's after shot does not wait for rebuilds.
"""

from __future__ import annotations

import asyncio
import copy
import json
import sys
from pathlib import Path

import pytest

import test_links as T
from backend import board3d, links, store

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import render  # noqa: E402


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------- coalescing

def test_a_rebuild_with_nothing_new_to_build_is_coalesced(monkeypatch):
    monkeypatch.setattr(links, "DEBOUNCE", 0)
    db = T.FakeDb()
    db["models"].rows += [T.model("p/a", "W = 1\n"), T.model("p/b", "import a\n"),
                          T.model("p/c", "import a\n")]

    async def go():
        g = await links.load(db)
        # b was built (by hand, say) against exactly what there is now.
        b = next(r for r in db["models"].rows if r["_id"] == "p/b")
        b["built"] = {"version": 1, "hash": links.against(g, links.key("model", "p/b"))["hash"]}
        await links.changed(db, "model", "p/a")
        builds = T.Builds()
        await T.drain(db, links.Scheduler(builds, parallel=3))
        return builds

    builds = run(go())
    rows = {r["_id"]: r for r in db["models"].rows}
    assert builds.order == ["p/c"]                       # c had never been built
    assert rows["p/b"]["link"]["state"] == "done" and rows["p/b"]["link"]["coalesced"]
    assert rows["p/c"]["link"]["state"] == "done" and "coalesced" not in rows["p/c"]["link"]


def test_a_build_against_older_versions_is_not_coalesced(monkeypatch):
    monkeypatch.setattr(links, "DEBOUNCE", 0)
    db = T.FakeDb()
    db["models"].rows += [T.model("p/a", "W = 1\n"),
                          T.model("p/b", "import a\n", built={"version": 1, "hash": "old"})]

    async def go():
        await links.changed(db, "model", "p/a")
        builds = T.Builds()
        await T.drain(db, links.Scheduler(builds))
        return builds

    assert run(go()).order == ["p/b"]


# ---------------------------------------------------------------- pins in staging

def test_a_pin_upstream_is_staged_said_and_counted_in_built_against(tmp_path):
    db = T.FakeDb()
    db["models"].rows += [T.model("p/a", "W = 2\n", version=2),
                          T.model("p/part", "import a\n", pins={"model:p/a": 1}),
                          T.model("p/asm", "import part\n")]
    db["component_versions"].rows.append(
        {"_id": "model:p/a:v1", "kind": "model", "component": "p/a", "version": 1,
         "source": "W = 1\n"})
    models = tmp_path / "models"
    models.mkdir()
    (models / "p__a.py").write_text("W = 2\n")

    got = run(links.prepare(db, "p/asm", models, tmp_path))
    assert (models / "p__a.py").read_text() == "W = 1\n"    # what the part pinned
    assert got["notes"] == ["a is used at v1, pinned by p/part (latest v2)"]
    row = got["against"]["model:p/a"]
    assert row["version"] == 1 and row["pinned"]


def test_a_pinned_version_that_is_gone_is_said(tmp_path):
    db = T.FakeDb()
    db["models"].rows += [T.model("p/a", "W = 2\n", version=2),
                          T.model("p/b", "import a\n", pins={"model:p/a": 1})]
    (tmp_path / "models").mkdir()
    got = run(links.prepare(db, "p/b", tmp_path / "models", tmp_path))
    assert any("no longer kept" in n for n in got["notes"])


# ---------------------------------------------------------------- boards

class Bucket:
    files: dict = {}

    async def upload_from_stream(self, name, data):
        fid = f"f{len(self.files)}"
        self.files[fid] = data
        return fid

    async def delete(self, fid):
        self.files.pop(fid, None)

    async def open_download_stream(self, fid):
        files = self.files

        class S:
            async def read(_):
                return files[fid]
        return S()


def test_a_board_is_staged_from_its_kept_version_not_a_half_replaced_artifact(tmp_path, monkeypatch):
    import gzip
    db = T.FakeDb()
    d4 = board3d.describe(T.INFO, T.BOXES)
    newer = copy.deepcopy(d4)
    newer["thickness"] = 9.99                          # the next layout, landing right now
    db["boards"].rows.append({"_id": "demo-board", "title": "Demo",
                              "component": {"version": 4, "digest": "d4" * 20}})
    monkeypatch.setattr(store, "bucket", lambda db, name: Bucket())
    monkeypatch.setattr(store, "CACHE", tmp_path / "cache")

    async def go():
        await store.put_artifact(db, "demo-board", "board3d", json.dumps(newer).encode(),
                                 collection="boards")
        await store.put_artifact(db, "demo-board", "step", b"ISO-10303-21;NEWER", collection="boards")
        fid = await Bucket().upload_from_stream("v4", gzip.compress(b"ISO-10303-21;V4"))
        db["component_versions"].rows.append(
            {"_id": "board:demo-board:v4", "kind": "board", "component": "demo-board", "version": 4,
             "digest": "d4" * 20, "data": d4, "step": {"gridfs_id": fid}})
        table = links.module_table([], db["boards"].rows)
        (tmp_path / "models").mkdir()
        return await links.write_board(db, tmp_path / "models", tmp_path, "demo-board", table)

    got = run(go())
    text = (tmp_path / "models" / "demo_board.py").read_text()
    assert got["version"] == 4 and "VERSION = 4" in text
    assert f"THICKNESS = {d4['thickness']!r}" in text and "9.99" not in text
    assert (tmp_path / "_boards" / "demo-board.step").read_bytes() == b"ISO-10303-21;V4"


# ---------------------------------------------------------------- after shots

def test_an_after_shot_does_not_wait_for_rebuilds(monkeypatch):
    entry = {"id": "p/b", "_id": "p/b", "data": True, "built_at": "t1",
             "link": {"state": "queued", "because": {"id": "p/a"}}}
    calls = []

    def fetch():
        calls.append(1)
        return {}

    def find(_cat, _model):
        return entry

    def never(_s):
        raise AssertionError("waited")

    monkeypatch.setenv("REDLINE_REVISION", "r1")
    got = render.wait_built(fetch, "p/b", 1200, find=find, sleep=never)
    assert got is entry and len(calls) == 1

    monkeypatch.delenv("REDLINE_REVISION")
    clock = iter([0, 0, 2000])
    with pytest.raises(SystemExit, match="still queued"):
        render.wait_built(fetch, "p/b", 1200, find=find, sleep=lambda s: None,
                          clock=lambda: next(clock))
