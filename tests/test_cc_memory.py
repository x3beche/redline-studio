"""The workspace's pinned memory (backend/cc_memory.py): kept per space,
each item with who and when, bounded, never a secret; sent with every
conversation's system line; read and changed by the chat tools memory_read
and memory_write (removing asks first) and by the Chat's panel routes."""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from backend import cc_chat, cc_memory, ccgen, chat_tools, scope
from tests.test_cc_generation import answers, gen_doc, until
from tests.test_cc_mentions_live_search import env, events, seed_chat  # noqa: F401 - env is a fixture
from tests.test_chat_tools import tool_model


def run(coro):
    return asyncio.run(coro)


class Coll:
    def __init__(self):
        self.docs: dict = {}

    async def find_one(self, q, *a):
        d = self.docs.get(q["_id"])
        return dict(d) if d else None

    async def update_one(self, q, upd, upsert=False):
        if q["_id"] in self.docs or upsert:
            self.docs.setdefault(q["_id"], {"_id": q["_id"]}).update(upd["$set"])


class Db(dict):
    def __missing__(self, name):
        self[name] = Coll()
        return self[name]


@pytest.fixture
def mem(monkeypatch):
    db = Db()
    who = {"id": "u1", "name": "Emir"}
    monkeypatch.setattr(cc_memory.actors, "current", lambda: who)
    monkeypatch.setattr(cc_memory, "_db", lambda: db)
    return db, who


def test_items_say_who_and_when_and_each_space_has_its_own(mem, monkeypatch):
    db, who = mem
    a = run(cc_memory.add(db, "Printer: Bambu X1C, PETG at 245 °C, 0.2 mm layers"))
    assert a["by"] == {"id": "u1", "name": "Emir"} and a["at"] and len(a["id"]) == 8
    who["name"] = "Ayşe"
    e = run(cc_memory.edit(db, a["id"], "Printer: Bambu X1C, PETG at 250 °C"))
    assert e["by"]["name"] == "Emir" and e["edited_by"]["name"] == "Ayşe" and "250" in e["text"]
    assert "(Ayşe, " in cc_memory.line(e) and f"[{a['id']}]" in cc_memory.line(e)
    monkeypatch.setattr(scope, "current", lambda: "u9")             # another space: its own memory
    assert run(cc_memory.items(db)) == []
    run(cc_memory.add(db, "M3x8 hex screws are preferred"))
    monkeypatch.setattr(scope, "current", lambda: scope.DEFAULT)
    assert [r["text"] for r in run(cc_memory.items(db))] == ["Printer: Bambu X1C, PETG at 250 °C"]
    run(cc_memory.remove(db, a["id"]))
    assert run(cc_memory.items(db)) == []


@pytest.mark.parametrize("text", [
    "OpenRouter key sk-or-v1-0123456789abcdef0123456789",
    "the wifi password: hunter22",
    "WiFi şifresi: kirmizi-elma",
    "şifre şu Ab12cd",
    "api key = 9f8e7d6c5b4a",
    "token ghp_abcdefghijklmnopqrstuvwx1234",
    "use Bearer abcdefghijklmnop.qrstu",
    "AKIAABCDEFGHIJKLMNOP",
    "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3x",
])
def test_secrets_are_refused(mem, text):
    db, _ = mem
    with pytest.raises(cc_memory.Refused, match="never keeps secrets"):
        run(cc_memory.add(db, text))


@pytest.mark.parametrize("text", [
    "Şifre sıfırlama sayfası Ayarlar'da",
    "Prefer M3x8 DIN 912 screws; heat-set inserts M3x5.7",
    "Projects: lamp, iot-fan, station - parts in each project's parts/ folder",
    "Do not use 0402 parts: hand soldering",
])
def test_ordinary_facts_are_kept(mem, text):
    db, _ = mem
    assert run(cc_memory.add(db, text))["text"] == text


def test_the_memory_is_bounded(mem, monkeypatch):
    db, _ = mem
    with pytest.raises(cc_memory.Refused, match="at most 300"):
        run(cc_memory.add(db, "x " * 200))
    run(cc_memory.add(db, "one fact"))
    with pytest.raises(cc_memory.Refused, match="already"):
        run(cc_memory.add(db, "One fact"))
    monkeypatch.setattr(cc_memory, "MAX_ITEMS", 2)
    run(cc_memory.add(db, "two facts"))
    with pytest.raises(cc_memory.Refused, match="at most 2 items"):
        run(cc_memory.add(db, "three facts"))
    monkeypatch.setattr(cc_memory, "MAX_ITEMS", 40)
    monkeypatch.setattr(cc_memory, "MAX_TOTAL", 20)
    with pytest.raises(cc_memory.Refused, match="characters in all"):
        run(cc_memory.add(db, "a fact too many"))


def test_the_panel_routes(mem):
    db, _ = mem
    got = run(cc_memory.add_item(cc_memory.ItemIn(text="PETG at 245 °C")))
    assert [r["text"] for r in got["items"]] == ["PETG at 245 °C"] and got["max_items"] == cc_memory.MAX_ITEMS
    iid = got["items"][0]["id"]
    got = run(cc_memory.edit_item(iid, cc_memory.ItemIn(text="PETG at 250 °C")))
    assert got["items"][0]["text"] == "PETG at 250 °C" and got["used"] == len("PETG at 250 °C")
    with pytest.raises(HTTPException) as e:
        run(cc_memory.add_item(cc_memory.ItemIn(text="password: x9y8z7")))
    assert e.value.status_code == 400
    assert run(cc_memory.remove_item(iid))["items"] == []
    assert run(cc_memory.get_memory())["items"] == []
    # under /api/cc, through the Chat's router
    assert any(getattr(r, "path", "") == "/api/cc/memory/{iid}" for r in cc_chat.router.routes)


def seed_memory(raw):
    """The stand-in database has no upsert: the memory's document is there, empty."""
    raw[cc_memory.COLL].rows[cc_memory.DOC] = {"_id": cc_memory.DOC, "items": []}


def test_every_conversation_is_sent_the_memory(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    seed_memory(raw)
    run(cc_memory.add(raw, "Printer: Bambu X1C, PETG at 245 °C"))
    tool_model(monkeypatch, state, [("Ok.", [])])
    events(cc_chat.say("c1", cc_chat.SayIn(text="hi", client="tab1")))
    system = state["rounds"][0]["messages"][0]["content"]
    assert "Workspace memory" in system and "PETG at 245 °C" in system and "(Ayşe" not in system
    assert {"memory_read", "memory_write"} <= {t["name"] for t in state["rounds"][0]["tools"]}


def test_the_model_adds_freely_but_removing_asks_first(env, monkeypatch):
    raw, state = env
    state["role"] = "owner"
    seed_chat(raw)
    seed_memory(raw)
    tool_model(monkeypatch, state, [("", [("memory_write", {"add": ["M3x8 screws preferred"]})]), ("Saved.", [])])
    events(cc_chat.say("c1", cc_chat.SayIn(text="remember: M3x8 screws preferred", client="tab1")))
    (step,) = answers(raw)[-1]["steps"]
    assert step["status"] == "done" and step["level"] == "change"
    (item,) = run(cc_memory.items(raw))
    assert item["text"] == "M3x8 screws preferred" and item["by"]["name"]

    tool_model(monkeypatch, state, [("", [("memory_write", {"remove": [item["id"]]})]), ("Removed.", [])])

    async def go():
        resp = await cc_chat.say("c1", cc_chat.SayIn(text="forget the screws", client="tab1"))
        st = await until(lambda: next((s for s in (gen_doc(raw) or {}).get("steps") or [] if s["status"] == "ask"), None))
        assert len(await cc_memory.items(raw)) == 1                  # not yet
        raw[ccgen.GENS].rows[gen_doc(raw)["_id"]]["answers"] = {st["id"]: True}
        await until(lambda: len(answers(raw)) == 2)
        async for _ in resp.body_iterator:
            pass
    run(go())
    assert answers(raw)[-1]["steps"][0]["status"] == "done" and run(cc_memory.items(raw)) == []


def test_someone_who_may_not_edit_cannot_change_it(env, monkeypatch):
    raw, state = env                                                 # a reviewer
    seed_chat(raw)
    tool_model(monkeypatch, state, [("", [("memory_write", {"add": ["x"]})]), ("Sorry.", [])])
    events(cc_chat.say("c1", cc_chat.SayIn(text="remember x", client="tab1")))
    (step,) = answers(raw)[-1]["steps"]
    assert step["status"] == "error" and "right to edit" in step["error"]


def test_memory_read_lists_the_ids():
    db = Db()
    run(cc_memory.add(db, "PETG at 245 °C"))
    res = run(chat_tools.tools()["memory_read"].run(chat_tools.Ctx(db=db), {}))
    assert "[" in res.text and "PETG at 245 °C" in res.text and res.vars["count"] == 1
