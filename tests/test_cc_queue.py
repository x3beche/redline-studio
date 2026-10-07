"""Lines sent while an answer is being written wait in the conversation's
queue (backend/cc_chat.py) and are sent by themselves when it ends.

What matters: the queue is the server's - a line waits and is sent with no
page open; in order, one at a time, each with its own model and mentions;
a stopped, failed or interrupted answer pauses it (Send now goes on,
Clear drops it); only whoever queued a line, or someone who may delete,
edits or removes it; and every change goes out on the live stream. The
model is never called: llm.stream is stood in for.
"""

import asyncio
import json
from datetime import timedelta

import pytest
from fastapi import HTTPException

from backend import access, cc_chat, ccgen, llm
from tests.test_cc_generation import _seed_running, answers, gen_doc, read, until
from tests.test_cc_mentions_live_search import ME, YOU, env, seed_chat  # noqa: F401 - env is a fixture


def run(coro):
    return asyncio.run(coro)


def gated(monkeypatch, state):
    """A model that answers each question with "re: <question>", each one
    only when the test opens that question's gate (or at once, once
    `state['free']` is set)."""
    gates: dict[str, asyncio.Event] = {}
    state["asked"] = []

    async def stream(messages, *, provider, model, max_tokens=8000, temperature=None):
        q = messages[-1]["content"]
        q = q if isinstance(q, str) else json.dumps(q)
        q = q.split("] ", 1)[-1]                              # "[Me] text" when several people talk
        state["asked"].append((q, model))
        yield {"text": "re: "}
        if not state.get("free"):
            await gates.setdefault(q, asyncio.Event()).wait()
        yield {"text": q}
        yield {"usage": {"prompt_tokens": 1, "completion_tokens": 2, "cost": None}}

    monkeypatch.setattr(llm, "stream", stream)
    return gates


def chat(raw):
    return raw["cc_chats"].rows["c1"]


def lines(raw):
    return [m["content"] for m in chat(raw)["messages"]]


async def started(raw, text):
    """Say `text`, take the first event and let the page go away."""
    resp = await cc_chat.say("c1", cc_chat.SayIn(text=text))
    it = resp.body_iterator.__aiter__()
    await read(it)
    await it.aclose()


def body(resp):
    return json.loads(resp.body)


def test_a_line_sent_meanwhile_waits_and_goes_by_itself_with_no_page_open(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    gates = gated(monkeypatch, state)

    async def go():
        await started(raw, "one")
        await until(lambda: (gen_doc(raw) or {}).get("text") == "re: ")
        a = await cc_chat.say("c1", cc_chat.SayIn(text="two"))
        b = await cc_chat.say("c1", cc_chat.SayIn(text="three", model="m2"))
        assert a.status_code == b.status_code == 202
        got = body(b)
        assert got["queued"]["content"] == "three" and got["queued"]["model"] == "m2"
        assert [x["content"] for x in got["queue"]] == ["two", "three"] and got["paused"] is False
        # What the page gets of a waiting line: not the context read for it, nor who may do what.
        assert set(got["queued"]) <= {"id", "content", "mentions", "by", "at", "provider", "model"}
        assert lines(raw) == ["one"]                           # waiting, not in the conversation yet
        # No page is open. The answer ends: the next line goes, then the one after.
        for q in ("one", "two", "three"):
            gates.setdefault(q, asyncio.Event()).set()
            await until(lambda q=q: f"re: {q}" in lines(raw))
        await until(lambda: gen_doc(raw)["status"] == "done" and not chat(raw).get("gen"))
    run(go())
    assert lines(raw) == ["one", "re: one", "two", "re: two", "three", "re: three"]
    assert [q for q, _ in state["asked"]] == ["one", "two", "three"]
    assert state["asked"][2][1] == "m2"                        # each with its own model
    assert chat(raw)["queue"] == [] and chat(raw)["model"] == "m2"
    by = [m["by"]["id"] for m in chat(raw)["messages"] if m["role"] == "user"]
    assert by == [ME["id"]] * 3
    # Sent by whoever queued it, on their role.
    gens = list(raw[ccgen.GENS].rows.values())
    assert [g["by"]["id"] for g in gens] == [ME["id"]] * 3 and gens[-1]["role"] == "reviewer"


def test_a_queued_line_keeps_its_mentions(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    raw["notes"].rows["n1"] = {"_id": "n1", "workspace_id": "default", "title": "Fan notes", "text": "fan is 40 mm"}
    gates = gated(monkeypatch, state)

    async def go():
        await started(raw, "one")
        await until(lambda: (gen_doc(raw) or {}).get("text") == "re: ")
        r = await cc_chat.say("c1", cc_chat.SayIn(text="two", mentions=[{"kind": "note", "id": "n1"}]))
        assert body(r)["queued"]["mentions"][0]["id"] == "n1"
        state["free"] = True
        gates.setdefault("one", asyncio.Event()).set()
        await until(lambda: len(answers(raw)) == 2 and not chat(raw).get("gen"))
    run(go())
    sent = [m for m in chat(raw)["messages"] if m["content"] == "two"][0]
    assert sent["mentions"][0]["id"] == "n1" and "fan is 40 mm" in sent["context"]


def test_a_waiting_line_can_be_edited_or_removed_by_whoever_queued_it(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    gates = gated(monkeypatch, state)

    async def go():
        await started(raw, "one")
        await until(lambda: (gen_doc(raw) or {}).get("text") == "re: ")
        a = body(await cc_chat.say("c1", cc_chat.SayIn(text="two")))["queued"]
        b = body(await cc_chat.say("c1", cc_chat.SayIn(text="three")))["queued"]
        # Someone else, who may not delete: neither edit nor remove.
        state["who"], state["role"] = YOU, "reviewer"
        for call in (cc_chat.queue_edit("c1", a["id"], cc_chat.QueueEdit(text="hijack")),
                     cc_chat.queue_remove("c1", a["id"])):
            with pytest.raises(HTTPException) as e:
                await call
            assert e.value.status_code == 403
        # Clear leaves what is not theirs.
        assert [x["content"] for x in (await cc_chat.queue_clear("c1"))["queue"]] == ["two", "three"]
        state["who"] = ME
        ev = await cc_chat.queue_edit("c1", a["id"], cc_chat.QueueEdit(text="two, better"))
        assert ev["type"] == "queue" and [x["content"] for x in ev["queue"]] == ["two, better", "three"]
        ev = await cc_chat.queue_remove("c1", b["id"])
        assert [x["content"] for x in ev["queue"]] == ["two, better"]
        with pytest.raises(HTTPException) as e:
            await cc_chat.queue_remove("c1", b["id"])
        assert e.value.status_code == 404
        state["free"] = True
        gates.setdefault("one", asyncio.Event()).set()
        await until(lambda: "re: two, better" in lines(raw))
    run(go())
    assert lines(raw) == ["one", "re: one", "two, better", "re: two, better"]


def test_someone_who_may_delete_can_remove_anyone_s_waiting_line(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    gated(monkeypatch, state)

    async def go():
        await started(raw, "one")
        await until(lambda: (gen_doc(raw) or {}).get("text") == "re: ")
        a = body(await cc_chat.say("c1", cc_chat.SayIn(text="two")))["queued"]
        state["who"], state["role"] = YOU, "editor"
        assert (await cc_chat.queue_remove("c1", a["id"]))["queue"] == []
        state["who"], state["role"] = ME, "reviewer"
        await cc_chat.stop("c1")
        await until(lambda: not chat(raw).get("gen"))
    run(go())


def test_stopping_the_answer_pauses_the_queue_until_send_now(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    gates = gated(monkeypatch, state)

    async def go():
        await started(raw, "one")
        await until(lambda: (gen_doc(raw) or {}).get("text") == "re: ")
        await cc_chat.say("c1", cc_chat.SayIn(text="two"))
        await cc_chat.stop("c1")
        await until(lambda: gen_doc(raw)["status"] == "stopped")
        await asyncio.sleep(0.05)
        assert lines(raw) == ["one", "re: "]                   # nothing sent after a stop
        assert chat(raw)["queue_paused"] is True and chat(raw)["queue_why"] == "stopped"
        got = await cc_chat.get_chat("c1")
        assert got["queue_paused"] is True and [x["content"] for x in got["queue"]] == ["two"]
        # A paused queue does not refuse a line either: it waits behind it.
        state["free"] = True
        ev = await cc_chat.queue_resume("c1")
        assert ev["sent"] is True and ev["queue"] == [] and ev["paused"] is False
        await until(lambda: "re: two" in lines(raw))
    run(go())
    assert lines(raw) == ["one", "re: ", "two", "re: two"]


def test_clear_drops_a_paused_queue(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    gated(monkeypatch, state)

    async def go():
        await started(raw, "one")
        await until(lambda: (gen_doc(raw) or {}).get("text") == "re: ")
        await cc_chat.say("c1", cc_chat.SayIn(text="two"))
        await cc_chat.stop("c1")
        await until(lambda: chat(raw).get("queue_paused"))
        ev = await cc_chat.queue_clear("c1")
        assert ev["queue"] == [] and ev["paused"] is False
    run(go())
    assert not chat(raw)["queue_paused"]


def test_an_interrupted_answer_pauses_the_queue(env, monkeypatch):
    raw, state = env
    _seed_running(raw, beat=ccgen.now() - timedelta(seconds=ccgen.LOST + 5))
    chat(raw)["queue"] = [{"id": "w1", "role": "user", "content": "later", "by": dict(ME), "at": "x",
                           "provider": "openrouter", "model": "m1"}]
    chat(raw)["queue_rev"] = 1
    run(ccgen.recover(raw))
    assert answers(raw)[-1]["interrupted"] is True
    assert chat(raw)["queue_paused"] is True and chat(raw)["queue_why"] == "interrupted"
    assert lines(raw) == ["q", "Half an ans"]                  # waiting, not sent


def test_a_failed_answer_pauses_the_queue(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    gate = asyncio.Event

    async def stream(messages, *, provider, model, max_tokens=8000, temperature=None):
        yield {"text": "half"}
        await state["gate"].wait()
        raise RuntimeError("the provider fell over")

    monkeypatch.setattr(llm, "stream", stream)

    async def go():
        state["gate"] = gate()
        await started(raw, "one")
        await until(lambda: (gen_doc(raw) or {}).get("text") == "half")
        await cc_chat.say("c1", cc_chat.SayIn(text="two"))
        state["gate"].set()
        await until(lambda: gen_doc(raw)["status"] == "failed")
    run(go())
    assert chat(raw)["queue_paused"] is True and lines(raw)[-1] == "half"


def test_the_queue_has_a_limit_and_an_edit_meanwhile_is_still_refused(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    gated(monkeypatch, state)

    async def go():
        await started(raw, "one")
        await until(lambda: (gen_doc(raw) or {}).get("text") == "re: ")
        for i in range(cc_chat.MAX_QUEUE):
            assert (await cc_chat.say("c1", cc_chat.SayIn(text=f"q{i}"))).status_code == 202
        with pytest.raises(HTTPException) as e:
            await cc_chat.say("c1", cc_chat.SayIn(text="one too many"))
        assert e.value.status_code == 409
        q0 = chat(raw)["messages"][0]["id"]
        with pytest.raises(HTTPException) as e:
            await cc_chat.say("c1", cc_chat.SayIn(text="edited", edit=q0))
        assert e.value.status_code == 409
        await cc_chat.queue_clear("c1")
        await cc_chat.stop("c1")
        await until(lambda: not chat(raw).get("gen"))
    run(go())


def test_watchers_hear_of_the_queue(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    gates = gated(monkeypatch, state)

    class Req:
        async def is_disconnected(self):
            return False

    async def go():
        await started(raw, "one")
        await until(lambda: (gen_doc(raw) or {}).get("text") == "re: ")
        await cc_chat.say("c1", cc_chat.SayIn(text="two"))
        live = await cc_chat.live("c1", Req())
        lit = live.body_iterator.__aiter__()
        hello = await read(lit)
        assert [x["content"] for x in hello["queue"]["queue"]] == ["two"]
        await cc_chat.say("c1", cc_chat.SayIn(text="three"))
        seen = []

        async def upto(content):
            while True:
                ev = await asyncio.wait_for(read(lit), 3)
                seen.append(ev)
                if ev["type"] == "start" and (ev.get("message") or {}).get("content") == content:
                    return
        gates.setdefault("one", asyncio.Event()).set()
        await upto("two")
        gates.setdefault("two", asyncio.Event()).set()
        await upto("three")
        gates.setdefault("three", asyncio.Event()).set()
        await until(lambda: not chat(raw).get("gen"))
        await lit.aclose()
        return seen
    seen = run(go())
    queues = [[x["content"] for x in e["queue"]] for e in seen if e["type"] == "queue"]
    assert ["two", "three"] in queues and ["three"] in queues and [] in queues
    # The waiting line's answer starts on the stream like anyone's, with its line.
    starts = [e["message"]["content"] for e in seen if e["type"] == "start"]
    assert starts[:2] == ["two", "three"]


def test_the_queue_routes_are_a_reviewers():
    for m, p in (("POST", "/api/cc/chats/c1/queue/resume"), ("POST", "/api/cc/chats/c1/queue/clear"),
                 ("PATCH", "/api/cc/chats/c1/queue/w1"), ("DELETE", "/api/cc/chats/c1/queue/w1")):
        assert access.action(m, p) == "draw", (m, p)
