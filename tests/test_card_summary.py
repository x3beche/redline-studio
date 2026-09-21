"""The rule that matters most: generation never overwrites a sentence the
user wrote by hand. Exercised against main._make_summary with a stub
database - no Mongo, no network.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import main as M


class FakeCollection:
    def __init__(self, doc):
        self.doc = doc
        self.writes = []

    async def find_one(self, query):
        return self.doc if query.get("_id") == self.doc["_id"] else None

    async def update_one(self, query, patch):
        self.writes.append(patch["$set"])
        self.doc.update(patch["$set"])


class FakeDB:
    def __init__(self, doc):
        self.revisions = FakeCollection(doc)


def card(**kw):
    base = {"_id": "r1", "comment": "bu yazinin fontunu dusurelim",
            "image": None, "summary": None, "summary_manual": False}
    base.update(kw)
    return base


@pytest.mark.asyncio
async def test_generated_summary_is_written(monkeypatch):
    fake = FakeDB(card())
    monkeypatch.setattr(M, "db", lambda: fake)

    async def fake_summarise(comment, png=None):
        assert comment == "bu yazinin fontunu dusurelim"
        return "Yazinin fontunu kucult", {"cost": 0.0002}

    monkeypatch.setattr(M.summarise, "summarise", fake_summarise)
    await M._make_summary("r1")
    assert fake.revisions.doc["summary"] == "Yazinin fontunu kucult"
    assert fake.revisions.doc["summary_manual"] is False


@pytest.mark.asyncio
async def test_hand_written_summary_is_left_alone(monkeypatch):
    fake = FakeDB(card(summary="Elle yazilmis ozet", summary_manual=True))
    monkeypatch.setattr(M, "db", lambda: fake)

    async def boom(*a, **k):
        raise AssertionError("the model must not be called for a manual summary")

    monkeypatch.setattr(M.summarise, "summarise", boom)
    await M._make_summary("r1")
    assert fake.revisions.doc["summary"] == "Elle yazilmis ozet"
    assert fake.revisions.writes == []


@pytest.mark.asyncio
async def test_failure_leaves_the_card_untouched(monkeypatch):
    fake = FakeDB(card(summary="onceki ozet"))
    monkeypatch.setattr(M, "db", lambda: fake)

    async def fails(*a, **k):
        raise RuntimeError("openrouter is down")

    monkeypatch.setattr(M.summarise, "summarise", fails)
    await M._make_summary("r1")            # yutulmali, patlamamali
    assert fake.revisions.doc["summary"] == "onceki ozet"
    assert fake.revisions.writes == []


@pytest.mark.asyncio
async def test_empty_answer_is_not_written(monkeypatch):
    fake = FakeDB(card(summary="onceki ozet"))
    monkeypatch.setattr(M, "db", lambda: fake)

    async def blank(*a, **k):
        return "", {}

    monkeypatch.setattr(M.summarise, "summarise", blank)
    await M._make_summary("r1")
    assert fake.revisions.doc["summary"] == "onceki ozet"


@pytest.mark.asyncio
async def test_missing_card_is_not_an_error(monkeypatch):
    fake = FakeDB(card())
    monkeypatch.setattr(M, "db", lambda: fake)
    await M._make_summary("does-not-exist")
    assert fake.revisions.writes == []


@pytest.mark.asyncio
async def test_unreadable_drawing_does_not_stop_the_summary(monkeypatch):
    fake = FakeDB(card(image={"gridfs_id": "missing"}))
    monkeypatch.setattr(M, "db", lambda: fake)

    async def no_shot(*a, **k):
        raise RuntimeError("gone")

    seen = {}

    async def fake_summarise(comment, png=None):
        seen["png"] = png
        return "Yuvayi kucult", {}

    monkeypatch.setattr(M.store, "get_shot", no_shot)
    monkeypatch.setattr(M.summarise, "summarise", fake_summarise)
    await M._make_summary("r1")
    assert seen["png"] is None                       # resimsiz devam etti
    assert fake.revisions.doc["summary"] == "Yuvayi kucult"
