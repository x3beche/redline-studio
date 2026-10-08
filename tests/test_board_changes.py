"""A converted board changed on purpose (PUT /api/boards/{id}/changes,
`revisions.py board changes`): the comparison with the import keeps every
difference, and marks the ones a note meant."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from backend import auth, store
from backend import main as M
from test_component_pins import Bucket
from test_links import FakeDb, run

IMPORTED = {"components": [{"ref": "LED2"}, {"ref": "R19"}, {"ref": "U2"}],
            "nets": [{"name": "GND", "nodes": [{"ref": "U2", "pin": "1"}, {"ref": "U2", "pin": "15"}]},
                     {"name": "LED2_2", "nodes": [{"ref": "LED2", "pin": "2"}]},
                     {"name": "LED2_1", "nodes": [{"ref": "LED2", "pin": "1"}, {"ref": "R19", "pin": "1"}]}]}
BUILT = {"components": [*IMPORTED["components"], {"ref": "R23"}],
         "nets": [{"name": "GND", "nodes": [{"ref": "U2", "pin": "1"}, {"ref": "U2", "pin": "15"},
                                            {"ref": "LED2", "pin": "2"}, {"ref": "R23", "pin": "2"}]},
                  IMPORTED["nets"][2]]}


@pytest.fixture
def web(monkeypatch, tmp_path):
    db = FakeDb()
    bucket = Bucket()
    monkeypatch.setattr(store, "bucket", lambda d, name: bucket)
    monkeypatch.setattr(store, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)

    async def seed():
        db["boards"].rows.append({"_id": "b", "title": "B", "convert": {"status": "converted"}})
        await store.put_artifact(M.db(), "b", "imported_graph", json.dumps(IMPORTED).encode(),
                                 collection="boards")
        await store.put_artifact(M.db(), "b", "graph", json.dumps(BUILT).encode(),
                                 collection="boards")
    run(seed())
    return TestClient(M.app), db


def put(client, body):
    return client.put("/api/boards/b/changes", json=body, headers={"x-redline-csrf": "1"})


def test_changes_said_mark_the_differences_they_explain(web):
    client, db = web
    r = put(client, {"nets": ["GND", "LED2_2"], "parts": ["R23"], "why": "cathode to ground"})
    assert r.status_code == 200, r.text
    eq = r.json()["equivalence"]
    assert not eq["equivalent"] and eq["explained"]
    assert all(d["intended"] == "cathode to ground" for d in eq["differences"])
    row = db["boards"].rows[0]
    assert row["convert"]["changes"][0]["parts"] == ["R23"]
    assert row["convert"]["equivalence"]["explained"]


def test_a_part_left_unsaid_is_not_explained_and_clear_forgets(web):
    client, db = web
    eq = put(client, {"nets": ["GND"], "why": "cathode"}).json()["equivalence"]
    assert not eq["explained"]                       # R23 was added and nobody said so
    out = put(client, {"clear": True}).json()
    assert out["changes"] == [] and not out["equivalence"]["intended"]


def test_a_change_needs_a_reason_and_a_converted_board(web):
    client, db = web
    assert put(client, {"nets": ["GND"]}).status_code == 400
    assert put(client, {"why": "x"}).status_code == 400
    db["boards"].rows[0].pop("convert")
    assert put(client, {"nets": ["GND"], "why": "x"}).status_code == 404
