"""The next question, suggested after an answer (backend/suggest.py).

What matters: nothing is asked while the feature is off (the default), and
nothing that would cost a call goes out then; on, the job's own provider
and model are asked, with a bounded piece of the conversation; one call
per finished answer, however often the page asks; the call is in the
usage log like every other job's; and the switch and the wait are kept
with the job's route, the wait only within its bounds. No real model is
called here.
"""

import asyncio
import copy

import pytest
from fastapi import HTTPException

from backend import cc_chat, chat, llm, suggest, usage


class Dup(Exception):
    pass


class Coll:
    def __init__(self):
        self.rows: dict[str, dict] = {}
        self.indexes: list = []

    def _match(self, row, q):
        return all(row.get(k) == v for k, v in q.items())

    async def find_one(self, q, *a, **kw):
        for r in self.rows.values():
            if self._match(r, q):
                return copy.deepcopy(r)
        return None

    def find(self, q=None, *a, **kw):
        rows = [copy.deepcopy(r) for r in self.rows.values() if self._match(r, q or {})]

        class Cur:
            def __aiter__(self_inner):
                async def gen():
                    for r in rows:
                        yield r
                return gen()
        return Cur()

    async def insert_one(self, doc):
        if doc["_id"] in self.rows:
            raise Dup(doc["_id"])
        self.rows[doc["_id"]] = copy.deepcopy(doc)

    async def update_one(self, q, update, upsert=False):
        row = self.rows.get(q.get("_id"))
        if row is None:
            if not upsert:
                return
            row = self.rows[q["_id"]] = {"_id": q["_id"], **(update.get("$setOnInsert") or {})}
        for k, v in (update.get("$set") or {}).items():
            *path, last = k.split(".")
            at = row
            for p in path:
                at = at.setdefault(p, {})
            at[last] = copy.deepcopy(v)

    async def create_index(self, *a, **kw):
        self.indexes.append((a, kw))


class Db:
    def __init__(self):
        self.colls: dict[str, Coll] = {}

    def __getitem__(self, name):
        return self.colls.setdefault(name, Coll())


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setattr(llm, "_conf", {"keys": {"commandcode": "k", "openrouter": "k"}, "jobs": {}})
    monkeypatch.setattr(suggest, "_indexed", False)
    calls = []

    async def complete(messages, **kw):
        calls.append({"messages": messages, **kw})
        prov, model = llm.route(kw["job"])
        return {"choices": [{"message": {"content": '"Peki bunu nasıl test ederim?"\nextra line'}}],
                "usage": {"prompt_tokens": 120, "completion_tokens": 9, "cost": 0.00002},
                "provider": prov, "model": model}

    monkeypatch.setattr(llm, "complete", complete)
    db = Db()
    return db, calls


def convo(db, n=20, last="assistant", gen=None, cid="c1"):
    msgs = []
    for i in range(n):
        role = "user" if i % 2 == 0 else "assistant"
        msgs.append({"id": f"m{i}", "role": role, "content": "x" * 3000 + f" <{i}>"})
    msgs[-1]["role"] = last
    db[cc_chat.COLL].rows[cid] = {"_id": cid, "messages": msgs, "deleted_at": None, **({"gen": gen} if gen else {})}


def turn_on(**extra):
    llm._conf["jobs"]["suggest"] = {"provider": "openrouter", "model": "some/small-model", "on": True, **extra}


def test_off_by_default_and_then_nothing_is_asked(env):
    db, calls = env
    convo(db)
    assert suggest.settings() == {"on": False, "delay": 60}
    assert llm.public()["jobs"]["suggest"]["on"] is False
    assert run(suggest.suggest(db, "cc", "c1")) is None
    # A route chosen but the switch left off: still nothing.
    llm._conf["jobs"]["suggest"] = {"provider": "openrouter", "model": "some/small-model"}
    assert run(suggest.suggest(db, "cc", "c1")) is None
    assert calls == [] and not db[usage.CALLS].rows and not db[suggest.COLL].rows


def test_on_asks_the_jobs_model_with_a_bounded_context(env):
    db, calls = env
    convo(db)
    turn_on()
    got = run(suggest.suggest(db, "cc", "c1"))
    assert got == "Peki bunu nasıl test ederim?"          # one line, no quotes
    assert len(calls) == 1
    c = calls[0]
    assert c["job"] == "suggest" and c["max_tokens"] <= 100
    assert llm.route("suggest") == ("openrouter", "some/small-model")
    sent = c["messages"][1]["content"]
    assert sent.count("Person:") + sent.count("Assistant:") == suggest.TURNS
    assert "<19>" in sent and "<14>" in sent and "<13>" not in sent
    assert len(sent) < suggest.TURNS * (suggest.TURN_CHARS + 20)
    assert "language" in c["messages"][0]["content"]


def test_one_call_per_finished_answer_and_it_is_recorded(env):
    db, calls = env
    convo(db)
    turn_on()
    first = run(suggest.suggest(db, "cc", "c1"))
    again = [run(suggest.suggest(db, "cc", "c1")) for _ in range(3)]
    assert again == [first] * 3 and len(calls) == 1
    rows = list(db[usage.CALLS].rows.values())
    assert len(rows) == 1
    r = rows[0]
    assert (r["provider"], r["model"], r["kind"], r["input"], r["output"]) == \
        ("openrouter", "some/small-model", "suggest", 120, 9)
    assert r["cost_usd"] == 0.00002
    assert llm.job_label("suggest") == "Next-question suggestion"
    # The next answer is a new one: one more call.
    db[cc_chat.COLL].rows["c1"]["messages"] += [{"id": "m20", "role": "user", "content": "ok"},
                                                {"id": "m21", "role": "assistant", "content": "done"}]
    run(suggest.suggest(db, "cc", "c1"))
    assert len(calls) == 2


def test_a_failed_call_is_not_tried_again_for_the_same_answer(env, monkeypatch):
    db, _ = env
    convo(db)
    turn_on()
    n = []

    async def boom(messages, **kw):
        n.append(1)
        raise RuntimeError("down")

    monkeypatch.setattr(llm, "complete", boom)
    assert run(suggest.suggest(db, "cc", "c1")) is None
    assert run(suggest.suggest(db, "cc", "c1")) is None
    assert n == [1]


def test_nothing_while_an_answer_is_written_or_the_last_line_is_the_persons(env):
    db, calls = env
    turn_on()
    convo(db, gen="g1")
    assert run(suggest.suggest(db, "cc", "c1")) is None
    convo(db, last="user")
    assert run(suggest.suggest(db, "cc", "c1")) is None
    llm._conf["keys"] = {}                                # no key: no call, no error
    convo(db)
    assert run(suggest.suggest(db, "cc", "c1")) is None
    assert calls == []
    with pytest.raises(HTTPException):
        run(suggest.suggest(db, "cc", "nope"))


def test_a_room_thread_follows_the_agents_last_line(env):
    db, calls = env
    turn_on()
    room = db[chat.CHAT]
    room.rows["a"] = {"_id": "a", "at": "2026-01-01T00:00:01", "role": "user", "text": "kartı yönlendir", "room": "pcb"}
    assert run(suggest.suggest(db, "room", "pcb")) is None
    room.rows["b"] = {"_id": "b", "at": "2026-01-01T00:00:02", "role": "agent", "text": "yönlendirdim", "room": "pcb"}
    assert run(suggest.suggest(db, "room", "pcb")) == "Peki bunu nasıl test ederim?"
    assert "Person: kartı yönlendir" in calls[0]["messages"][1]["content"]
    run(suggest.suggest(db, "room", "pcb"))
    assert len(calls) == 1
    with pytest.raises(HTTPException):
        run(suggest.suggest(db, "room", "kitchen"))


def test_clean_keeps_one_short_line():
    assert suggest.clean("Öneri: «Bunu nasıl yaparım?»") == "Bunu nasıl yaparım?"
    assert suggest.clean("- what next") == "what next"
    long = suggest.clean("word " * 100)
    assert len(long) <= suggest.MAX_CHARS + 1 and long.endswith("…")


def test_the_switch_and_the_wait_are_kept_with_the_route(monkeypatch):
    monkeypatch.setattr(llm, "_conf", {"keys": {}, "jobs": {}})
    db = Db()
    run(llm.save(db, jobs={"suggest": {"provider": "openrouter", "model": "a/b", "on": True, "delay": 30}}))
    assert llm._conf["jobs"]["suggest"] == {"provider": "openrouter", "model": "a/b", "on": True, "delay": 30}
    assert suggest.settings() == {"on": True, "delay": 30}
    # A model change leaves the switch and the wait as they were.
    run(llm.save(db, jobs={"suggest": {"provider": "commandcode", "model": "Qwen/Qwen3.8-Flash"}}))
    assert suggest.settings() == {"on": True, "delay": 30}
    shown = llm.public()["jobs"]["suggest"]
    assert shown["switch"] and shown["delay_range"] == [llm.DELAY_MIN, llm.DELAY_MAX]
    run(llm.save(db, jobs={"suggest": {"provider": "commandcode", "model": "Qwen/Qwen3.8-Flash", "on": False}}))
    assert suggest.settings() == {"on": False, "delay": 30}
    for bad in (4, 601, True, "30"):
        with pytest.raises(ValueError):
            run(llm.save(db, jobs={"suggest": {"provider": "openrouter", "model": "a/b", "delay": bad}}))
    assert suggest.settings()["delay"] == 30
    # Other jobs take no switch.
    run(llm.save(db, jobs={"summary": {"provider": "openrouter", "model": "a/b", "on": True}}))
    assert llm._conf["jobs"]["summary"] == {"provider": "openrouter", "model": "a/b"}


def test_the_route_needs_the_right_to_write():
    from backend import access
    assert access.action("POST", "/api/suggest") == "draw"
    assert access.action("GET", "/api/suggest") == "view"
    assert not access.allowed("viewer", "draw")
