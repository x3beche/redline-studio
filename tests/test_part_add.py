"""Adding a part from the page, and where it goes in the drawer.

The page types a C-number into the Parts tab and watches the add happen
(POST /api/parts-add, polled): the steps the fetch takes are told through
lcsc.PROGRESS. The part's place comes from LCSC's own data first
(drawer_place); only where that is unsure (Other, Other ICs) is a model
asked - once, the answer kept on the part, checked against the drawer's
own places. A place chosen by hand wins over both.
"""

from __future__ import annotations

import asyncio
import copy

import pytest

from backend import lcsc, llm


class Parts:
    def __init__(self, docs=None):
        self.docs = docs or {}

    async def find_one(self, q, proj=None):
        d = self.docs.get(q["_id"])
        return copy.deepcopy(d) if d else None

    async def update_one(self, q, upd):
        d = self.docs.setdefault(q["_id"], {"_id": q["_id"]})
        d.update(copy.deepcopy(upd.get("$set", {})))
        for k in upd.get("$unset", {}):
            d.pop(k, None)


def _db(docs=None):
    return {lcsc.PARTS: Parts(docs)}


UNSURE = {"tags": ["Pre-ordered Products"], "prefix": "U?", "mpn": "XYZ123",
          "maker": "Acme", "description": "a 6-axis IMU", "package": "LGA-14"}
SURE = {"tags": ["Chip Resistor - Surface Mount"], "prefix": "R?", "mpn": "0603WAF1002T5E"}


def _llm(monkeypatch, answer: str, calls: list):
    async def complete(messages, **kw):
        calls.append((messages, kw))
        return {"choices": [{"message": {"content": answer}}], "usage": {"prompt_tokens": 50,
                "completion_tokens": 9}, "provider": "commandcode", "model": "Qwen/Qwen3.8-Flash"}
    recorded = []

    async def record(db, **kw):
        recorded.append(kw)
    monkeypatch.setattr(llm, "complete", complete)
    monkeypatch.setattr(llm, "record", record)
    monkeypatch.setattr(llm, "key", lambda provider: "k")
    return recorded


def test_the_job_is_in_settings_on_the_cheap_model():
    assert llm.JOBS[lcsc.CATEGORY_JOB]["label"] == "Part category"
    assert llm.JOBS[lcsc.CATEGORY_JOB]["default"] == llm.CHEAP
    assert llm.job_label("part-category") == "Part category"


def test_unsure_rules_ask_the_model_once_and_keep_the_answer(monkeypatch):
    monkeypatch.setattr(lcsc, "_drawer_facts", lambda _id: UNSURE)
    calls: list = []
    recorded = _llm(monkeypatch, '{"group": "ICs", "branch": "Sensors"}', calls)
    db = _db({"C1": {"_id": "C1", "name": "LGA-14_X"}})
    told = []
    lcsc.PROGRESS.set(lambda step, text: told.append((step, text)))
    try:
        got = asyncio.run(lcsc.categorise(db, "C1"))
    finally:
        lcsc.PROGRESS.set(None)
    assert (got["group"], got["branch"]) == ("ICs", "Sensors")
    assert ("llm", "categorising with Qwen3.8-Flash…") in told
    assert recorded and recorded[0]["kind"] == "part-category"
    # The prompt names the part and only the drawer's own places.
    prompt = calls[0][0][1]["content"]
    assert "XYZ123" in prompt and "Acme" in prompt and "LGA-14" in prompt
    assert lcsc.place_of(db[lcsc.PARTS].docs["C1"], UNSURE) == ("ICs", "Sensors", "llm")
    # Asked once: the second time is the kept answer.
    asyncio.run(lcsc.categorise(db, "C1"))
    assert len(calls) == 1


def test_sure_rules_ask_nobody(monkeypatch):
    monkeypatch.setattr(lcsc, "_drawer_facts", lambda _id: SURE)
    calls: list = []
    _llm(monkeypatch, '{"group": "ICs", "branch": "Sensors"}', calls)
    db = _db({"C2": {"_id": "C2"}})
    assert asyncio.run(lcsc.categorise(db, "C2")) is None
    assert not calls
    assert lcsc.place_of({}, SURE) == ("Passives", "Resistors", "rules")


@pytest.mark.parametrize("answer", [
    "it is probably a sensor",
    '{"group": "ICs", "branch": "Gyroscopes"}',
    '{"group": "Snacks", "branch": "Crisps"}',
    "[1, 2]",
])
def test_an_answer_outside_the_drawer_is_thrown_away(monkeypatch, answer):
    monkeypatch.setattr(lcsc, "_drawer_facts", lambda _id: UNSURE)
    _llm(monkeypatch, answer, [])
    db = _db({"C3": {"_id": "C3"}})
    assert asyncio.run(lcsc.categorise(db, "C3")) is None
    assert "drawer_llm" not in db[lcsc.PARTS].docs["C3"]
    assert lcsc.place_of(db[lcsc.PARTS].docs["C3"], UNSURE) == ("ICs", "Other ICs", "rules")


def test_a_fenced_answer_is_still_read(monkeypatch):
    assert lcsc._parse_place('```json\n{"group": "Discretes", "branch": "Diodes"}\n```') \
        == ("Discretes", "Diodes")


def test_no_key_means_the_rules_stand(monkeypatch):
    monkeypatch.setattr(lcsc, "_drawer_facts", lambda _id: UNSURE)
    calls: list = []
    _llm(monkeypatch, '{"group": "ICs", "branch": "Sensors"}', calls)
    monkeypatch.setattr(llm, "key", lambda provider: None)
    assert asyncio.run(lcsc.categorise(_db({"C4": {"_id": "C4"}}), "C4")) is None
    assert not calls


def test_a_place_by_hand_wins_and_can_be_taken_back(monkeypatch):
    monkeypatch.setattr(lcsc, "_drawer_facts", lambda _id: UNSURE)
    db = _db({"C5": {"_id": "C5", "drawer_llm": {"group": "ICs", "branch": "Sensors"}}})
    assert asyncio.run(lcsc.set_place(db, "C5", "ICs", "Memory")) == ("ICs", "Memory", "manual")
    with pytest.raises(ValueError):
        asyncio.run(lcsc.set_place(db, "C5", "ICs", "Gyroscopes"))
    assert asyncio.run(lcsc.set_place(db, "C5", None, None)) == ("ICs", "Sensors", "llm")
    # A model's answer never overrides sure rules.
    assert lcsc.place_of({"drawer_llm": {"group": "ICs", "branch": "Sensors"}}, SURE)[2] == "rules"


def test_the_add_job_tells_each_step(monkeypatch):
    from backend import main

    db = _db()
    monkeypatch.setattr(main, "db", lambda: db)

    async def say(*a, **k):
        return {}
    monkeypatch.setattr(main, "say", say)

    async def component(lcsc_id, fresh=False):
        return {}

    async def fetch(db_, lcsc_id, force=False):
        lcsc._tell("download", "downloading footprint, symbol and 3D model…")
        lcsc._tell("seat", "seating the model on its pads…")
        db_[lcsc.PARTS].docs[lcsc_id] = {"_id": lcsc_id, "name": "C0603", "model_step": True}
        return db_[lcsc.PARTS].docs[lcsc_id]

    async def categorise(db_, lcsc_id):
        return None
    monkeypatch.setattr(lcsc, "_component", component)
    monkeypatch.setattr(lcsc, "fetch", fetch)
    monkeypatch.setattr(lcsc, "categorise", categorise)
    monkeypatch.setattr(lcsc, "_drawer_facts", lambda _id: {"tags": ["Multilayer Ceramic Capacitors MLCC"]})

    job = {"id": "j", "lcsc": "C14663", "state": "running", "steps": [], "step": "", "text": "",
           "error": None, "place": None, "already": False}
    asyncio.run(main._run_add(job))
    assert job["state"] == "done" and job["has_3d"]
    assert [s["step"] for s in job["steps"]] == ["ask", "download", "seat", "done"]
    assert job["text"] == "placed in Passives › Capacitors"


def test_a_refusal_is_said_plainly(monkeypatch):
    from backend import main

    monkeypatch.setattr(main, "db", lambda: _db())

    async def component(lcsc_id, fresh=False):
        raise lcsc.Refused("25 asks in 5 minutes is all EasyEDA is asked for; the next one can go in 40 s")
    monkeypatch.setattr(lcsc, "_component", component)
    job = {"id": "j", "lcsc": "C1", "state": "running", "steps": [], "step": "", "text": "",
           "error": None, "place": None, "already": False}
    asyncio.run(main._run_add(job))
    assert job["state"] == "error" and "40 s" in job["error"]


def test_not_a_number_is_refused_before_anything_is_asked():
    from fastapi import HTTPException

    from backend import main
    with pytest.raises(HTTPException) as e:
        asyncio.run(main.part_add_start(main.PartAddIn(lcsc="100nF 0603")))
    assert e.value.status_code == 400 and "not an LCSC number" in e.value.detail
