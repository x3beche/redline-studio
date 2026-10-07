"""Command Code answers written apart from the request (backend/ccgen.py).

What matters: an answer goes on when the page that asked goes away; a page
that comes back (a refresh, another tab) gets the answer as far as it got
and then the rest; stop is a request of its own, for whoever asked or
anyone who may delete, and keeps what was written; one answer at a time
in a conversation; the thinking is kept whole; and an answer whose runner
died with the server is kept as far as it got, marked, and lets go of the
conversation. The model is never called: llm.stream is stood in for.
"""

import asyncio
import json
from datetime import timedelta

import pytest
from fastapi import HTTPException

from backend import access, cc_chat, ccgen, llm
from tests.test_cc_mentions_live_search import ME, YOU, env, seed_chat  # noqa: F401 - env is a fixture


def run(coro):
    return asyncio.run(coro)


def gate_stream(monkeypatch, state, before=("Part one. ",), after=("Part two.",), thinking=()):
    """A model that writes `before` (after its `thinking`), waits for the
    test to open the gate, then writes `after`."""
    gate: dict = {}

    async def stream(messages, *, provider, model, max_tokens=8000, temperature=None):
        state["sent"] = messages
        for t in thinking:
            yield {"thinking": t}
        for t in before:
            yield {"text": t}
        await gate["open"].wait()
        for t in after:
            yield {"text": t}
        yield {"usage": {"prompt_tokens": 7, "completion_tokens": 3, "cost": 0.0001}}

    monkeypatch.setattr(llm, "stream", stream)
    return gate


async def until(check, seconds=5.0):
    for _ in range(int(seconds / 0.005)):
        got = check()
        if got:
            return got
        await asyncio.sleep(0.005)
    raise AssertionError("waited in vain")


def gen_doc(raw):
    rows = list(raw[ccgen.GENS].rows.values())
    return rows[-1] if rows else None


def answers(raw, cid="c1"):
    return [m for m in raw["cc_chats"].rows[cid]["messages"] if m["role"] == "assistant"]


async def read(it):
    while True:
        chunk = await it.__anext__()
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        if text.startswith("data:"):
            return json.loads(text[5:])


def test_the_answer_goes_on_when_the_page_goes_away(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    gate = gate_stream(monkeypatch, state)

    async def go():
        gate["open"] = asyncio.Event()
        resp = await cc_chat.say("c1", cc_chat.SayIn(text="tell me", client="tab1"))
        it = resp.body_iterator.__aiter__()
        first = await read(it)
        assert first["type"] == "user" and first["gen"]
        await until(lambda: (gen_doc(raw) or {}).get("text") == "Part one. ")
        await it.aclose()                              # the tab closed
        assert raw["cc_chats"].rows["c1"].get("gen") == first["gen"]
        gate["open"].set()
        await until(lambda: answers(raw))
        await until(lambda: gen_doc(raw)["status"] == "done")
    run(go())
    last = answers(raw)[-1]
    assert last["content"] == "Part one. Part two." and not last.get("stopped")
    assert last["usage"]["completion_tokens"] == 3
    assert "gen" not in raw["cc_chats"].rows["c1"]          # the conversation is free again
    assert "cc-chat" in state["recorded"]


def test_a_page_that_comes_back_gets_the_answer_so_far_then_the_rest(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    gate = gate_stream(monkeypatch, state, thinking=("Let me think. ",))

    class Req:
        async def is_disconnected(self):
            return False

    async def go():
        gate["open"] = asyncio.Event()
        resp = await cc_chat.say("c1", cc_chat.SayIn(text="tell me", client="tab1"))
        it = resp.body_iterator.__aiter__()
        first = await read(it)
        await until(lambda: (gen_doc(raw) or {}).get("text") == "Part one. ")
        await it.aclose()
        # The page refreshed: it watches the conversation anew.
        await until(lambda: (cc_chat.HUB.snapshot(cc_chat.live_key("c1")) or [{}])[0].get("text") == "Part one. ")
        live = await cc_chat.live("c1", Req())
        lit = live.body_iterator.__aiter__()
        hello = await read(lit)
        assert hello["type"] == "hello"
        (w,) = hello["live"]
        assert w["gen"] == first["gen"] and w["client"] == "tab1" and w["by"]["id"] == ME["id"]
        assert w["text"] == "Part one. " and w["thinking"] == "Let me think. "
        assert w["message"]["content"] == "tell me" and w["keep"] == 0
        gate["open"].set()
        rest = []
        while True:
            ev = await read(lit)
            rest.append(ev)
            if ev["type"] == "end":
                break
        await lit.aclose()
        return rest
    rest = run(go())
    assert "".join(e["text"] for e in rest if e["type"] == "text") == "Part two."
    done = next(e for e in rest if e["type"] == "done")
    assert done["message"]["content"] == "Part one. Part two." and done["message"]["thinking"] == "Let me think. "


def test_a_page_that_comes_after_a_reload_gets_the_start_with_the_answer_so_far(env, monkeypatch):
    """A new API process (a reload) knows nothing of the answer: the live
    stream's first look at it hands over the answer so far in its start."""
    raw, state = env
    seed_chat(raw)
    gate = gate_stream(monkeypatch, state)

    class Req:
        async def is_disconnected(self):
            return False

    async def go():
        gate["open"] = asyncio.Event()
        resp = await cc_chat.say("c1", cc_chat.SayIn(text="tell me"))
        it = resp.body_iterator.__aiter__()
        await read(it)
        await until(lambda: (gen_doc(raw) or {}).get("text") == "Part one. ")
        await it.aclose()
        # What a restart leaves of this process: nothing.
        key = cc_chat.live_key("c1")
        cc_chat.HUB.tails.pop(key).cancel()
        cc_chat.HUB.live.clear()
        live = await cc_chat.live("c1", Req())
        lit = live.body_iterator.__aiter__()
        hello = await read(lit)
        start = await read(lit)
        gate["open"].set()
        rest = []
        while (ev := await read(lit))["type"] != "end":
            rest.append(ev)
        await lit.aclose()
        return hello, start, rest
    hello, start, rest = run(go())
    assert hello["live"] == [] and start["type"] == "start" and start["text"] == "Part one. "
    assert start["text"] + "".join(e["text"] for e in rest if e["type"] == "text") == "Part one. Part two."


def test_stop_is_a_request_of_its_own_and_keeps_what_was_written(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    gate = gate_stream(monkeypatch, state)

    async def go():
        gate["open"] = asyncio.Event()
        resp = await cc_chat.say("c1", cc_chat.SayIn(text="tell me"))
        it = resp.body_iterator.__aiter__()
        await read(it)
        await until(lambda: (gen_doc(raw) or {}).get("text") == "Part one. ")
        # Someone else, who may not delete: refused.
        state["who"], state["role"] = YOU, "reviewer"
        with pytest.raises(HTTPException) as e:
            await cc_chat.stop("c1")
        assert e.value.status_code == 403
        state["who"] = ME
        got = await cc_chat.stop("c1")
        assert got["stopped"] is True
        evs = []
        while True:
            try:
                evs.append(await read(it))
            except StopAsyncIteration:
                break
        return evs
    evs = run(go())
    done = next(e for e in evs if e["type"] == "done")
    assert done["message"]["content"] == "Part one. " and done["message"]["stopped"] is True
    last = answers(raw)[-1]
    assert last["content"] == "Part one. " and last["stopped"] is True and "error" not in last
    assert gen_doc(raw)["status"] == "stopped" and gen_doc(raw)["stop"]["by"]["id"] == ME["id"]
    assert "gen" not in raw["cc_chats"].rows["c1"]
    # Nothing under way: nothing to stop.
    assert run(cc_chat.stop("c1")) == {"stopped": False, "running": False}


def test_someone_who_may_delete_can_stop_anyone_s_answer(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    gate = gate_stream(monkeypatch, state)

    async def go():
        gate["open"] = asyncio.Event()
        resp = await cc_chat.say("c1", cc_chat.SayIn(text="tell me"))
        it = resp.body_iterator.__aiter__()
        await read(it)
        await until(lambda: (gen_doc(raw) or {}).get("text") == "Part one. ")
        state["who"], state["role"] = YOU, "editor"
        assert (await cc_chat.stop("c1"))["stopped"]
        await until(lambda: answers(raw))
        await it.aclose()
    run(go())
    assert answers(raw)[-1]["stopped"] is True


def test_the_stop_route_is_a_reviewers():
    assert access.action("POST", "/api/cc/chats/c1/stop") == "draw"
    assert access.allowed("reviewer", "draw") and not access.allowed("viewer", "draw")


def test_one_answer_at_a_time(env, monkeypatch):
    raw, state = env
    seed_chat(raw, messages=[{"id": "q0", "role": "user", "content": "q", "at": "2026-10-01T10:00:00+00:00",
                              "by": dict(ME)},
                             {"id": "a0", "role": "assistant", "content": "a", "at": "2026-10-01T10:00:00+00:00"}])
    gate = gate_stream(monkeypatch, state)

    async def go():
        gate["open"] = asyncio.Event()
        resp = await cc_chat.say("c1", cc_chat.SayIn(text="first"))
        it = resp.body_iterator.__aiter__()
        await read(it)
        await until(lambda: (gen_doc(raw) or {}).get("text"))
        for second in (cc_chat.say("c1", cc_chat.SayIn(text="second")),
                       cc_chat.regenerate("c1", None),
                       cc_chat.say("c1", cc_chat.SayIn(text="edit", edit="q0"))):
            with pytest.raises(HTTPException) as e:
                await second
            assert e.value.status_code == 409
        # Nothing was added or cut by the ones refused.
        assert [m["content"] for m in raw["cc_chats"].rows["c1"]["messages"]] == ["q", "a", "first"]
        gate["open"].set()
        while True:
            try:
                await read(it)
            except StopAsyncIteration:
                break
        # Free again: the next one is answered.
        resp = await cc_chat.say("c1", cc_chat.SayIn(text="second"))
        async for _ in resp.body_iterator:
            pass
    run(go())
    assert [m["content"] for m in raw["cc_chats"].rows["c1"]["messages"]][-4:] == \
        ["first", "Part one. Part two.", "second", "Part one. Part two."]
    # Refused before anything was written down.
    assert [g["status"] for g in raw[ccgen.GENS].rows.values()] == ["done", "done"]


def test_the_thinking_is_kept_whole(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    pieces = [f"step {i}: " + "x" * 1000 + "\n" for i in range(60)]     # 60 000 characters and more
    gate = gate_stream(monkeypatch, state, thinking=pieces, before=("Answer.",), after=())

    async def go():
        gate["open"] = asyncio.Event()
        gate["open"].set()
        resp = await cc_chat.say("c1", cc_chat.SayIn(text="think hard"))
        evs = []
        async for chunk in resp.body_iterator:
            for ln in (chunk.decode() if isinstance(chunk, bytes) else chunk).split("\n"):
                if ln.startswith("data:"):
                    evs.append(json.loads(ln[5:]))
        return evs
    evs = run(go())
    whole = "".join(pieces)
    assert len(whole) > 60_000
    assert "".join(e["text"] for e in evs if e["type"] == "thinking") == whole
    assert next(e for e in evs if e["type"] == "done")["message"]["thinking"] == whole
    kept = answers(raw)[-1]
    assert kept["thinking"] == whole and kept["content"] == "Answer." and kept["thinking_ms"] >= 0
    assert gen_doc(raw)["thinking"] == whole
    # The page gets it whole when it reads the conversation.
    got = run(cc_chat.get_chat("c1"))
    assert got["messages"][-1]["thinking"] == whole
    # The hub never cuts it either.
    hub = cc_chat.Hub()
    hub.begin("k", {"gen": "g", "text": "", "thinking": ""})
    for p in pieces:
        hub.piece("k", "g", "thinking", p)
    assert hub.snapshot("k")[0]["thinking"] == whole


def _seed_running(raw, gid="g1", text="Half an ans", thinking="hmm", **gen):
    seed_chat(raw, messages=[{"id": "q", "role": "user", "content": "q", "at": "2026-10-01T10:00:00+00:00",
                              "by": dict(ME)}], gen=gid)
    doc = {"_id": gid, "chat": "c1", "workspace": "default", "status": "running", "by": {"id": ME["id"]},
           "provider": "openrouter", "model": "m1", "text": text, "thinking": thinking, "keep": 0,
           "at": "2026-10-01T10:00:00+00:00", "started_at": ccgen.now(), "beat": ccgen.now(), **gen}
    raw[ccgen.GENS].rows[gid] = doc
    return doc


def test_at_startup_an_answer_whose_runner_died_is_kept_and_marked(env):
    raw, state = env
    _seed_running(raw, beat=ccgen.now() - timedelta(seconds=ccgen.LOST + 5))
    got = run(ccgen.recover(raw))
    assert got == ["g1"]
    last = answers(raw)[-1]
    assert last["content"] == "Half an ans" and last["thinking"] == "hmm" and last["interrupted"] is True
    assert "error" not in last
    assert "gen" not in raw["cc_chats"].rows["c1"] and raw[ccgen.GENS].rows["g1"]["status"] == "interrupted"
    # Once: a second look changes nothing.
    assert run(ccgen.recover(raw)) == [] and len(answers(raw)) == 1


def test_at_startup_a_runner_known_gone_is_not_waited_for(env, monkeypatch):
    raw, state = env
    # Its process is not there in this namespace: no need to wait for the beat.
    _seed_running(raw, text="", pid=999_999_999, ns=ccgen._pid_ns(), host="elsewhere")
    assert run(ccgen.recover(raw)) == ["g1"]
    last = answers(raw)[-1]
    assert last["content"] == "" and last["interrupted"] and last["error"] == ccgen.GONE


def test_at_startup_a_runner_still_writing_is_left_alone(env):
    """A reload, not a restart: the runner carries on, and is followed."""
    raw, state = env
    _seed_running(raw)
    assert run(ccgen.recover(raw)) == []
    assert raw["cc_chats"].rows["c1"]["gen"] == "g1" and raw[ccgen.GENS].rows["g1"]["status"] == "running"


def test_a_dead_runner_does_not_hold_the_conversation(env):
    raw, state = env
    _seed_running(raw, beat=ccgen.now() - timedelta(seconds=ccgen.LOST + 5))
    ev = []

    async def go():
        resp = await cc_chat.say("c1", cc_chat.SayIn(text="again"))
        async for chunk in resp.body_iterator:
            ev.append(chunk)
    run(go())
    contents = [m["content"] for m in raw["cc_chats"].rows["c1"]["messages"]]
    assert contents == ["q", "Half an ans", "again", "Hello there"]
    assert raw["cc_chats"].rows["c1"]["messages"][1]["interrupted"] is True
