"""The empty Chat's example questions (backend/chat_ideas.py).

What matters: the questions come from the person's own workspace (names
and states, nothing else); they are kept per workspace, person and
language and served at once, written again only when older than the
interval or written under other settings; the refresh button waits for a
new set; off, failing or without a key, the page gets nothing written and
shows its hand-written examples; the settings are checked; every call is
in the usage log. No real model is called here.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest

from backend import actors, chat_ideas, llm, scope
from test_users_admin import db, person  # noqa: F401  (the fixture)


def run(c):
    return asyncio.run(c)


ANSWER = json.dumps({"questions": [
    {"kind": "PCB", "text": "Is the USB-C input on motor-driver protected against reverse polarity?"},
    {"kind": "firmware", "text": "Why does fan-ctl miss the tach interrupt above 3000 rpm?"},
    {"kind": "3D", "text": "How thick should the iot-fan case lid be for a snap fit?"},
    {"kind": "manufacturer", "text": "Which of my manufacturers makes 12 V blowers?"},
    {"kind": "weird", "text": "What should I work on next?"},
    {"kind": "notes", "text": "Summarise the queued notes on iot-fan."},
    {"kind": "taste", "text": "Does motor-driver follow my PCB palette?"},
]})


@pytest.fixture
def fake(monkeypatch, db):  # noqa: F811
    """A key, the job's own route, and a model that answers ANSWER and
    remembers what it was asked."""
    monkeypatch.setattr(llm, "_conf", {"keys": {"commandcode": "k", "openrouter": "k"},
                                       "jobs": {"chat_suggestions": {"provider": "openrouter", "model": "a/small"}}})
    calls: list[dict] = []
    state = {"answer": ANSWER, "fail": False}

    async def complete(messages, **kw):
        calls.append({"messages": messages, **kw})
        if state["fail"]:
            raise RuntimeError("provider down")
        return {"choices": [{"message": {"content": state["answer"]}}],
                "usage": {"prompt_tokens": 400, "completion_tokens": 120, "cost": 0.0002},
                "provider": "openrouter", "model": "a/small"}
    recorded: list[dict] = []

    async def record(db_, **kw):
        recorded.append(kw)
    monkeypatch.setattr(llm, "complete", complete)
    monkeypatch.setattr(llm, "record", record)
    chat_ideas._tasks.clear()
    yield {"db": db, "calls": calls, "state": state, "recorded": recorded}
    chat_ideas._tasks.clear()


def _work(fake_db, ws: str = scope.DEFAULT):
    """A workspace with a bit of everything, and a key it must never send."""
    async def go():
        sd = scope.ScopedDb(fake_db, ws)
        await sd["models"].insert_one({"_id": "iot-fan", "title": "IoT fan case", "updated_at": "2026-10-10"})
        await sd["boards"].insert_one({"_id": "motor-driver", "title": "Motor driver", "folder": "fan"})
        await sd["firmware"].insert_one({"_id": "f1", "title": "fan-ctl", "board_title": "Motor driver",
                                         "mcu_part": "STM32G031", "secret_token": "sk-NEVER"})
        await sd["revisions"].insert_one({"_id": "r1", "summary": "Thicker lid", "model": "iot-fan", "status": "queued"})
        await sd["revisions"].insert_one({"_id": "r2", "summary": "Old applied one", "model": "iot-fan", "status": "applied"})
        await sd["notes"].insert_one({"_id": "n1", "title": "Tach wiring", "text": "long text"})
        await sd["taste_palettes"].insert_one({"_id": "p1", "name": "PCB palette", "items": [{"text": "x"}]})
        await sd["manufacturers"].insert_one({"_id": "m1", "name": "Delta", "categories": ["fans"]})
        await sd["cc_chats"].insert_one({"_id": "c1", "title": "Fan PWM frequency", "by": {"id": "local"},
                                         "deleted_at": None, "messages": []})
        await sd["cc_chats"].insert_one({"_id": "c2", "title": "Someone else's", "by": {"id": "other"},
                                         "deleted_at": None, "messages": []})
    run(go())


def _db():
    from backend import main
    return main.db()


# ---------------------------------------------------------------- parsing

def test_parse_json_kinds_and_the_count():
    got = chat_ideas.parse(ANSWER, 6)
    assert [g["kind"] for g in got] == ["pcb", "firmware", "cad", "manufacturers", "general", "notes"]
    assert got[0]["text"].startswith("Is the USB-C")


def test_parse_fenced_bare_list_strings_and_lines():
    fenced = "```json\n" + json.dumps([{"kind": "board", "text": "A?"}, "B?", {"question": "A?"}]) + "\n```"
    assert chat_ideas.parse(fenced, 6) == [{"kind": "pcb", "text": "A?"}, {"kind": "general", "text": "B?"}]
    lines = "Here you go\n1. [Firmware]: Why is it slow?\n- CAD: Fillet size?\n"
    got = chat_ideas.parse(lines, 6)
    assert {"kind": "firmware", "text": "Why is it slow?"} in got
    assert {"kind": "cad", "text": "Fillet size?"} in got
    assert chat_ideas.parse("", 6) == []
    long = chat_ideas.parse(json.dumps({"questions": [{"kind": "pcb", "text": "word " * 100}]}), 3)
    assert len(long[0]["text"]) <= chat_ideas.MAX_CHARS + 1 and long[0]["text"].endswith("…")


# ---------------------------------------------------------------- what is read

def test_the_summary_is_names_and_states_only(fake):
    _work(fake["db"])
    text = run(chat_ideas.workspace_summary(_db(), chats=True))
    for want in ("IoT fan case", "Motor driver", "fan-ctl", "STM32G031", "Thicker lid", "Tach wiring",
                 "PCB palette", "Delta", "Fan PWM frequency"):
        assert want in text
    assert "sk-NEVER" not in text and "Old applied one" not in text and "Someone else's" not in text
    assert "Fan PWM frequency" not in run(chat_ideas.workspace_summary(_db(), chats=False))


# ---------------------------------------------------------------- kept, and written again

def test_written_once_kept_and_served(fake):
    _work(fake["db"])
    first = run(chat_ideas.ideas(_db(), "en"))
    # Never waited for: the first look has nothing written yet, and asks.
    assert first["source"] == "default" and first["items"] == [] and first["refreshing"]
    assert first["start"] == {"provider": "commandcode", "model": llm.CHEAP[1]}
    out = run(chat_ideas.refresh(_db(), "en"))
    assert out["source"] == "llm" and len(out["items"]) == 6
    n = len(fake["calls"])
    assert fake["calls"][-1]["job"] == "chat_suggestions"
    assert "English" in fake["calls"][-1]["messages"][0]["content"]
    assert "6 questions" in fake["calls"][-1]["messages"][0]["content"]
    again = run(chat_ideas.ideas(_db(), "en"))
    assert again["items"] == out["items"] and not again["refreshing"] and len(fake["calls"]) == n
    assert fake["recorded"][-1]["kind"] == "chat-suggestions"
    assert llm.KINDS["chat-suggestions"] == "chat_suggestions"
    assert llm.job_label("chat-suggestions") == "Chat example questions"


def test_written_again_after_the_interval_or_other_settings(fake):
    _work(fake["db"])
    run(chat_ideas.refresh(_db(), "en"))
    conf = chat_ideas.settings()
    doc = run(fake["db"][chat_ideas.COLL].find_one({}))
    now = doc["at"].timestamp()
    assert not chat_ideas.stale(doc, conf, now + conf["every"] - 5)
    assert chat_ideas.stale(doc, conf, now + conf["every"] + 5)
    assert chat_ideas.stale(doc, {**conf, "count": 4}, now)          # written under another count
    assert chat_ideas.stale(None, conf, now)

    # Old: the old set is served at once and a new one asked for behind it.
    old = datetime.now(timezone.utc) - timedelta(days=2)
    run(fake["db"][chat_ideas.COLL].update_one({"_id": doc["_id"]}, {"$set": {"at": old}}))
    n = len(fake["calls"])

    async def look_then_settle():
        got = await chat_ideas.ideas(_db(), "en")
        assert got["source"] == "llm" and got["refreshing"]
        await asyncio.gather(*chat_ideas._tasks.values())
    run(look_then_settle())
    assert len(fake["calls"]) == n + 1
    assert run(fake["db"][chat_ideas.COLL].find_one({}))["at"] > old


def test_turkish_is_asked_in_turkish_and_kept_apart(fake):
    _work(fake["db"])
    run(chat_ideas.refresh(_db(), "tr"))
    assert "Turkish" in fake["calls"][-1]["messages"][0]["content"]
    assert run(chat_ideas.ideas(_db(), "en"))["source"] == "default"


def test_per_account(fake):
    """One person's set is theirs: another account (its own space) neither
    sees it nor has its workspace read into it."""
    _work(fake["db"])
    run(chat_ideas.refresh(_db(), "en"))
    a = person(fake["db"], "a")
    r = a.get("/api/cc/ideas?lang=en")
    assert r.status_code == 200 and r.json()["source"] == "default"
    r = a.post("/api/cc/ideas/refresh?lang=en")
    # a's space is empty: nothing to write from, nothing asked
    assert r.status_code == 200 and r.json()["source"] == "default"
    assert "IoT fan case" not in json.dumps([c["messages"] for c in fake["calls"]][1:])
    keys = {d["_id"] for d in fake["db"][chat_ideas.COLL].docs.values()}
    assert any(k.startswith(f"{scope.DEFAULT}:local:") for k in keys)
    assert not any(k.startswith(f"{scope.DEFAULT}:a:") for k in keys)


def test_two_people_in_one_space_are_kept_apart(fake):
    _work(fake["db"])
    run(chat_ideas.refresh(_db(), "en"))
    tok = actors.CURRENT.set({"type": "user", "id": "other", "name": "O"})
    try:
        assert run(chat_ideas.ideas(_db(), "en"))["source"] == "default"
        run(chat_ideas.refresh(_db(), "en"))
        assert "Someone else's" in fake["calls"][-1]["messages"][1]["content"]
        assert "Fan PWM frequency" not in fake["calls"][-1]["messages"][1]["content"]
    finally:
        actors.CURRENT.reset(tok)


# ---------------------------------------------------------------- off, failing

def test_off_no_call_and_the_hand_written_ones(fake):
    _work(fake["db"])
    run(chat_ideas.refresh(_db(), "en"))
    llm._conf["jobs"]["chat_suggestions"]["on"] = False
    n = len(fake["calls"])
    got = run(chat_ideas.ideas(_db(), "en"))
    assert got == {**got, "on": False, "source": "default", "items": [], "refreshing": False}
    assert len(fake["calls"]) == n
    a = person(fake["db"], "a")
    assert a.post("/api/cc/ideas/refresh").status_code == 409


def test_no_key_no_call(fake):
    _work(fake["db"])
    llm._conf["keys"] = {}
    got = run(chat_ideas.ideas(_db(), "en"))
    assert got["source"] == "default" and not got["refreshing"] and fake["calls"] == []
    r = person(fake["db"], "a").post("/api/cc/ideas/refresh")
    assert r.status_code == 409 and "Settings > LLM settings" in r.json()["detail"]


def test_a_failure_keeps_the_last_set_and_waits(fake):
    _work(fake["db"])
    good = run(chat_ideas.refresh(_db(), "en"))["items"]
    fake["state"]["fail"] = True
    out = run(chat_ideas.refresh(_db(), "en"))
    assert out["items"] == good and "provider down" in out["error"]
    # and an answer with no questions in it fails the same way
    fake["state"].update(fail=False, answer="sorry, no")
    assert run(chat_ideas.refresh(_db(), "en"))["items"] == good
    # an automatic look after a failure does not ask again at once
    doc = run(fake["db"][chat_ideas.COLL].find_one({}))
    run(fake["db"][chat_ideas.COLL].update_one({"_id": doc["_id"]}, {"$set": {"at": datetime(2020, 1, 1, tzinfo=timezone.utc)}}))
    n = len(fake["calls"])
    assert not run(chat_ideas.ideas(_db(), "en"))["refreshing"] and len(fake["calls"]) == n


def test_a_viewer_never_causes_a_call(fake, monkeypatch):
    from backend import access
    _work(fake["db"])
    tok = access.ROLE.set("viewer")
    try:
        got = run(chat_ideas.ideas(_db(), "en"))
    finally:
        access.ROLE.reset(tok)
    assert not got["refreshing"] and fake["calls"] == []


# ---------------------------------------------------------------- the settings

def test_settings_defaults_saved_and_checked(fake):
    assert chat_ideas.settings() == {"on": True, "every": 86400, "count": 6, "chats": True}
    pub = llm.public()["jobs"]["chat_suggestions"]
    assert pub["ideas"] and pub["every_options"] == [3600, 21600, 86400, 604800] and pub["count_range"] == [3, 12]
    run(llm.save(fake["db"], jobs={"chat_suggestions": {"provider": "openrouter", "model": "a/b", "every": 3600, "count": 9}}))
    assert chat_ideas.settings() == {"on": True, "every": 3600, "count": 9, "chats": True}
    # a change that leaves fields out keeps them
    run(llm.save(fake["db"], jobs={"chat_suggestions": {"provider": "openrouter", "model": "a/c", "chats": False}}))
    assert chat_ideas.settings() == {"on": True, "every": 3600, "count": 9, "chats": False}
    for bad in ({"every": 60}, {"every": True}, {"count": 2}, {"count": 13}, {"count": "6"}, {"on": "yes"}):
        with pytest.raises(ValueError):
            run(llm.save(fake["db"], jobs={"chat_suggestions": {"provider": "openrouter", "model": "a/b", **bad}}))
    assert chat_ideas.settings()["count"] == 9


def test_settings_through_the_api(fake):
    o = person(fake["db"], "o")
    r = o.put("/api/llm/settings", json={"jobs": {"chat_suggestions": {"provider": "openrouter", "model": "a/b",
                                                                      "on": False, "every": 604800, "count": 3}}})
    assert r.status_code == 200
    job = r.json()["jobs"]["chat_suggestions"]
    assert (job["on"], job["every"], job["count"], job["model"]) == (False, 604800, 3, "a/b")
    r = o.put("/api/llm/settings", json={"jobs": {"chat_suggestions": {"provider": "openrouter", "model": "a/b", "count": 40}}})
    assert r.status_code == 400
    # a person who is not an admin may not change it
    r = person(fake["db"], "a").put("/api/llm/settings", json={"jobs": {"chat_suggestions": {"provider": "openrouter", "model": "a/b"}}})
    assert r.status_code == 403
