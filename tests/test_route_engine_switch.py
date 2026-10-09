"""The switch beside Build: only the router changes, whatever else the rules hold."""
import asyncio

import pytest
from fastapi import HTTPException

from backend import main


class Coll:
    def __init__(self, doc):
        self.doc, self.sets = doc, []

    async def find_one(self, q, proj=None):
        return dict(self.doc) if self.doc and q["_id"] == self.doc["_id"] else None

    async def update_one(self, q, u):
        self.sets.append(u["$set"])


class DB(dict):
    def __getitem__(self, k):
        return dict.__getitem__(self, "boards")


def run(doc, engine, monkeypatch):
    c = Coll(doc)
    monkeypatch.setattr(main, "db", lambda: DB(boards=c))

    async def nets(_bid):
        return ["GND", "VCC"]

    async def said(*a, **kw):
        return None
    monkeypatch.setattr(main, "_board_nets", nets)
    monkeypatch.setattr(main, "say", said)
    got = asyncio.run(main.save_board_engine("b1", main.EngineIn(engine=engine)))
    return got, c.sets


def test_kept_rules_change_only_the_engine(monkeypatch):
    got, sets = run({"_id": "b1", "rules": {"classes": [{"name": "Power", "track": 9}]}}, "tracemaker", monkeypatch)
    assert got == {"engine": "tracemaker"}
    assert sets == [{"rules.route.engine": "tracemaker"}]        # the odd class left as it is


def test_no_rules_yet_keeps_the_rooms_with_the_engine(monkeypatch):
    _, sets = run({"_id": "b1"}, "tracemaker", monkeypatch)
    kept = sets[0]["rules"]
    assert kept["route"]["engine"] == "tracemaker" and any(c["name"] == "Default" for c in kept["classes"])


def test_an_unknown_engine_is_refused(monkeypatch):
    with pytest.raises(HTTPException) as e:
        run({"_id": "b1", "rules": {}}, "magic", monkeypatch)
    assert e.value.status_code == 400
