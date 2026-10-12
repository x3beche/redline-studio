"""The Chat's live streams, when something goes wrong in the middle.

What matters: a page that opens the live stream while an answer is being
written gets the answer so far once and every piece after it once - no
piece twice, none missing - and each piece says where in the answer it goes
(`at`), so a page that has some of it already skips what it has. An idle
stream says something every LIVE_PING seconds (the page's watchdog counts
on it). The task following an answer does not die on one failed look at
the database: the pages watching would hear keep-alives for ever and never
the answer.
"""

import asyncio
import json

from backend import cc_chat, ccgen

from test_cc_mentions_live_search import YOU, env, run, seed_chat  # noqa: F401  (fixture)


class Req:
    async def is_disconnected(self):
        return False


def _data(chunk) -> dict | None:
    text = chunk.decode() if isinstance(chunk, bytes) else chunk
    return json.loads(text[5:]) if text.startswith("data:") else None


def test_pieces_say_where_they_go():
    hub = cc_chat.Hub()
    q = hub.subscribe("k")
    hub.begin("k", {"gen": "g", "text": "Hel", "thinking": ""})
    hub.piece("k", "g", "text", "lo")
    hub.piece("k", "g", "thinking", "hm")
    hub.piece("k", "g", "text", "!")
    rows = [q.get_nowait() for _ in range(q.qsize())]
    assert [(e["type"], e.get("at"), e.get("text")) for e in rows[1:]] == [
        ("text", 3, "lo"), ("thinking", 0, "hm"), ("text", 5, "!")]
    assert hub.snapshot("k")[0]["text"] == "Hello!"


def test_a_late_page_gets_the_answer_once(env, monkeypatch):
    """The hello's snapshot is taken with the queue opened: a piece written
    while the response is on its way is in the queue only - not in the
    hello too, which once showed it twice."""
    raw, state = env
    seed_chat(raw)
    monkeypatch.setattr(cc_chat, "follow", lambda cid: None)  # no runner here: the hub alone
    key = cc_chat.live_key("c1")
    cc_chat.HUB.live.pop(key, None)
    cc_chat.HUB.begin(key, {"gen": "g1", "text": "Hel", "thinking": ""})

    async def go():
        resp = await cc_chat.live("c1", Req())
        cc_chat.HUB.piece(key, "g1", "text", "lo")           # before the page has read a byte
        it = resp.body_iterator.__aiter__()
        hello = _data(await it.__anext__())
        nxt = _data(await it.__anext__())
        await it.aclose()
        return hello, nxt

    try:
        hello, nxt = run(go())
    finally:
        cc_chat.HUB.live.pop(key, None)
    so_far = hello["live"][0]["text"]
    assert so_far == "Hel" and hello["ping"] == cc_chat.LIVE_PING
    assert nxt["type"] == "text" and nxt["at"] == len(so_far)
    assert so_far + nxt["text"] == "Hello"


def test_a_page_that_has_some_of_it_skips_what_it_has():
    """What the page does with `at` (rooms/commandcode.ts, `fit`): the same
    sum in Python - a piece it has already adds nothing, one past what it
    has is a gap (read again)."""
    def fit(have: str, text: str, at):
        if at is None or at == len(have):
            return have + text
        if at > len(have):
            return None
        return have + text[len(have) - at:]

    assert fit("Hel", "lo", 3) == "Hello"
    assert fit("Hello", "lo", 3) == "Hello"                  # twice: once
    assert fit("Hell", "lo", 3) == "Hello"                   # in part: the rest
    assert fit("He", "lo", 3) is None                        # a gap
    hub = cc_chat.Hub()
    q = hub.subscribe("k")
    hub.begin("k", {"gen": "g", "text": "", "thinking": ""})
    for p in ("a", "bc", "def"):
        hub.piece("k", "g", "text", p)
    rows = [q.get_nowait() for _ in range(q.qsize())][1:]
    have = ""
    for e in rows + rows:                                     # every piece twice, as after a reconnect
        have = fit(have, e["text"], e["at"])
    assert have == "abcdef"


def test_an_idle_stream_says_it_is_alive(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    monkeypatch.setattr(cc_chat, "LIVE_PING", 0.01)
    key = cc_chat.live_key("c1")
    cc_chat.HUB.live.pop(key, None)

    async def go():
        resp = await cc_chat.live("c1", Req())
        it = resp.body_iterator.__aiter__()
        hello = _data(await it.__anext__())
        pings = [await asyncio.wait_for(it.__anext__(), 1.0) for _ in range(2)]
        await it.aclose()
        return hello, pings

    hello, pings = run(go())
    assert hello["type"] == "hello" and pings == [b": ping\n\n", b": ping\n\n"]
    assert cc_chat.HUB.watchers(key) == 0


def test_the_answer_comes_after_a_failed_look(env, monkeypatch):
    """One look at the database fails while the answer is written: the
    follower looks again, and the answer reaches the page all the same."""
    raw, state = env
    seed_chat(raw)
    state["who"] = YOU
    state["answer"] = ["Hel", "lo"]
    real = ccgen.get
    seen = {"n": 0}

    async def flaky(db, gid):
        seen["n"] += 1
        if seen["n"] == 2:
            raise RuntimeError("a hiccup")
        return await real(db, gid)

    monkeypatch.setattr(ccgen, "get", flaky)
    monkeypatch.setattr(asyncio, "sleep", _quick(asyncio.sleep))
    ev = _events_within(cc_chat.say("c1", cc_chat.SayIn(text="hi", client="tabY")), 5.0)
    kinds = [e["type"] for e in ev]
    assert seen["n"] >= 3 and "done" in kinds
    done = next(e for e in ev if e["type"] == "done")
    assert done["message"]["content"] == "Hello"
    # The pieces the page got make the answer, each where it says it goes.
    text = ""
    for e in ev:
        if e["type"] == "text":
            assert e.get("at", len(text)) == len(text)
            text += e["text"]
    assert text in ("", "Hello")


def _events_within(resp, limit: float) -> list[dict]:
    """The events a route streams, given up after `limit` seconds: a
    follower that died left the stream open on keep-alives alone, for ever -
    the stall itself."""
    async def go():
        r = await resp
        out = []

        async def read():
            async for chunk in r.body_iterator:
                d = _data(chunk)
                if d:
                    out.append(d)
        await asyncio.wait_for(read(), limit)
        return out
    return run(go())


def _quick(sleep):
    """The follower's second's wait after a failed look, shorter."""
    async def go(s, *a, **kw):
        return await sleep(min(s, 0.01), *a, **kw)
    return go
