"""The Command Code room, second round: @-mentions, answers watched as they
are written, and search through every line.

What matters: a mention is read through the asker's workspace and role -
another workspace's board, or a person who may not look, gets nothing -
and its block is bounded (per thing and per line) and says where it came
from; pictures go only to a model that reads them. Everyone watching a
conversation gets the same pieces as the one who asked, and a page that
goes away is let go. Search goes through the text index, keeps to the
trash and archive filters, and says where in the line the words are.
"""

import asyncio
import copy
import json
import re

import pytest
from fastapi import HTTPException

from backend import access, actors, cc_chat, cc_context, llm, scope

ME = {"id": "u-me", "name": "Me", "type": "person"}
YOU = {"id": "u-you", "name": "You", "type": "person"}


def run(coro):
    return asyncio.run(coro)


# ---- enough of Mongo, for several collections and workspaces ------------------

def _get(row, path):
    cur = row
    for part in path.split("."):
        if isinstance(cur, list):
            return [x.get(part) for x in cur if isinstance(x, dict)]
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _ok(row, k, v):
    if k == "$and":
        return all(match(row, q) for q in v)
    if k == "$or":
        return any(match(row, q) for q in v)
    if k == "$text":
        words = cc_chat.terms(v["$search"])
        hay = " ".join([row.get("title") or ""] + [m.get("content") or "" for m in row.get("messages") or []]).lower()
        return any(re.search(r"\b" + re.escape(w) + r"\b", hay) for w in words)
    got = _get(row, k)
    if isinstance(v, dict) and any(op.startswith("$") for op in v):
        for op, a in v.items():
            if op == "$exists" and (got is not None) != a:
                return False
            if op == "$ne" and got == a:
                return False
            if op == "$in" and got not in a:
                return False
            if op == "$regex":
                hay = got if isinstance(got, list) else [got or ""]
                if not any(re.search(a, h or "", re.I) for h in hay):
                    return False
            if op == "$size" and len(got or []) != a:
                return False
        return True
    return got == v


def match(row, query):
    return all(_ok(row, k, v) for k, v in (query or {}).items())


class Cur:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, keys, direction=None):
        if isinstance(keys, str):
            keys = [(keys, direction or 1)]
        for k, d in reversed(keys):
            if isinstance(d, dict):                         # {"$meta": "textScore"}
                self.rows.sort(key=lambda r: r.get("score") or 0, reverse=True)
            else:
                self.rows.sort(key=lambda r, k=k: (r.get(k) is not None, r.get(k) or 0), reverse=d < 0)
        return self

    def limit(self, n):
        self.rows = self.rows[:n]
        return self

    def __aiter__(self):
        async def gen():
            for r in self.rows:
                yield r
        return gen()


class Res:
    def __init__(self, n):
        self.matched_count = self.modified_count = self.deleted_count = n


class Coll:
    def __init__(self):
        self.rows: dict[str, dict] = {}
        self.queries: list[dict] = []
        self.text_index = True

    async def insert_one(self, doc):
        self.rows[doc["_id"]] = copy.deepcopy(doc)

    async def find_one(self, query, projection=None):
        for r in self.rows.values():
            if match(r, query):
                return copy.deepcopy(r)
        return None

    def find(self, query=None, projection=None):
        self.queries.append(query or {})
        if "$text" in json.dumps(query, default=str) and not self.text_index:
            err = Exception("text index required for $text query")
            err.code = 27
            raise err
        rows = []
        for r in self.rows.values():
            if match(r, query or {}):
                r = copy.deepcopy(r)
                if projection and "score" in projection:
                    r["score"] = 1.0 + len(r.get("title") or "") / 100
                rows.append(r)
        return Cur(rows)

    def aggregate(self, pipeline):
        return Cur([{"_id": r["_id"], "n": len(r.get("messages") or [])} for r in self.rows.values()
                    if match(r, (pipeline[0].get("$match") or {}))])

    async def update_one(self, query, update, **kw):
        for r in self.rows.values():
            if match(r, query):
                for k, v in (update.get("$set") or {}).items():
                    r[k] = copy.deepcopy(v)
                for k, v in (update.get("$push") or {}).items():
                    r.setdefault(k, []).append(copy.deepcopy(v))
                for k in (update.get("$unset") or {}):
                    r.pop(k, None)
                return Res(1)
        return Res(0)


class Raw:
    def __init__(self):
        self.colls: dict[str, Coll] = {}

    def __getitem__(self, name):
        return self.colls.setdefault(name, Coll())


@pytest.fixture
def env(monkeypatch):
    raw = Raw()
    state = {"who": ME, "role": "reviewer", "ws": "default", "answer": ["Hello", " there"], "vision": False,
             "recorded": []}
    monkeypatch.setattr(cc_chat, "_db", lambda: scope.ScopedDb(raw, state["ws"]))
    monkeypatch.setattr(scope, "current", lambda: state["ws"])
    monkeypatch.setattr(actors, "current", lambda: state["who"])
    monkeypatch.setattr(access, "current", lambda: state["role"])
    monkeypatch.setattr(llm, "key", lambda p: "k")

    async def stream(messages, *, provider, model, max_tokens=8000, temperature=None):
        state["sent"] = messages
        for piece in state["answer"]:
            if callable(piece):
                piece()
                continue
            yield {"text": piece}
        yield {"usage": {"prompt_tokens": 10, "completion_tokens": 5, "cost": None}}

    async def models(provider):
        return [{"id": "m1", "name": "M1", "context": 1000, "vision": state["vision"]}]

    async def record(db, **kw):
        state["recorded"].append(kw["kind"])

    async def complete(messages, **kw):
        return {"choices": [{"message": {"content": "A title"}}], "usage": {}}

    monkeypatch.setattr(llm, "stream", stream)
    monkeypatch.setattr(llm, "models", models)
    monkeypatch.setattr(llm, "record", record)
    monkeypatch.setattr(llm, "complete", complete)
    return raw, state


def seed_chat(raw, cid="c1", messages=(), ws="default", title="Chat", **extra):
    raw["cc_chats"].rows[cid] = {"_id": cid, "workspace_id": ws, "title": title, "provider": "openrouter",
                                 "model": "m1", "by": dict(ME), "created_at": "2026-10-01T10:00:00+00:00",
                                 "updated_at": "2026-10-01T10:00:00+00:00", "messages": [dict(m) for m in messages],
                                 **extra}


def line(mid, role, text, by=ME, at="2026-10-01T10:00:00+00:00"):
    m = {"id": mid, "role": role, "content": text, "at": at}
    if role == "user":
        m["by"] = dict(by)
    return m


def events(resp) -> list[dict]:
    """The events a route streams; given the route's coroutine, it is run in
    the same loop as the answer's runner (tests/conftest.py)."""
    async def go():
        nonlocal resp
        if asyncio.iscoroutine(resp):
            resp = await resp
        out = []
        async for chunk in resp.body_iterator:
            for ln in (chunk.decode() if isinstance(chunk, bytes) else chunk).split("\n"):
                if ln.startswith("data:"):
                    out.append(json.loads(ln[5:]))
        return out
    return run(go())


# ---- @-mentions ---------------------------------------------------------------------

def test_a_mention_is_read_through_the_workspace(env):
    raw, state = env
    raw["boards"].rows["ctrl"] = {"_id": "ctrl", "workspace_id": "default", "title": "Controller",
                                  "component": {"version": 3}, "drc": {"error_count": 0, "warning_count": 2},
                                  "rules": {"board": {"layers": 2}}}
    raw["boards"].rows["ctrl@team2"] = {"_id": "ctrl@team2", "workspace_id": "team2", "title": "Theirs"}
    raw["boards"].rows["secret@team2"] = {"_id": "secret@team2", "workspace_id": "team2", "title": "Secret"}
    db = cc_chat._db()
    ctx, chips, pics = run(cc_context.expand(db, [{"kind": "board", "id": "ctrl"}], vision=False))
    assert '<context kind="board" id="ctrl" version="3" label="Controller">' in ctx
    assert "DRC" in ctx and "Design rules" in ctx and "No netlist yet" in ctx
    assert chips == [{"kind": "board", "id": "ctrl", "label": "Controller", "version": 3,
                      "chars": chips[0]["chars"], "truncated": False, "images": 0}]
    # Another workspace's board is not there for this one, by any name.
    with pytest.raises(HTTPException) as e:
        run(cc_context.expand(db, [{"kind": "board", "id": "secret"}], vision=False))
    assert e.value.status_code == 404
    # The picker offers this workspace's only.
    rows = run(cc_chat.mentions(q="", kind="board"))
    assert [r["id"] for r in rows] == ["ctrl"]


def test_mentioning_needs_the_right_to_look(env):
    raw, state = env
    raw["notes"].rows["n1"] = {"_id": "n1", "workspace_id": "default", "text": "hello", "title": "hello"}
    state["role"] = None                                     # signed in, but no role here
    with pytest.raises(HTTPException) as e:
        run(cc_context.expand(cc_chat._db(), [{"kind": "note", "id": "n1"}], vision=False))
    assert e.value.status_code == 403
    with pytest.raises(HTTPException):
        run(cc_chat.mentions(q="hello"))
    state["role"] = "viewer"                                 # a viewer may look, so may mention
    ctx, chips, _ = run(cc_context.expand(cc_chat._db(), [{"kind": "note", "id": "n1"}], vision=False))
    assert chips[0]["id"] == "n1" and "hello" in ctx


def test_an_unknown_kind_is_refused(env):
    with pytest.raises(HTTPException) as e:
        run(cc_context.expand(cc_chat._db(), [{"kind": "users", "id": "x"}], vision=False))
    assert e.value.status_code == 404


def test_one_thing_is_cut_at_30k_and_says_so(env):
    raw, state = env
    raw["notes"].rows["big"] = {"_id": "big", "workspace_id": "default", "title": "Big", "text": "x" * 50_000,
                                "updated_at": "2026-10-02"}
    ctx, chips, _ = run(cc_context.expand(cc_chat._db(), [{"kind": "note", "id": "big"}], vision=False))
    body = ctx.split('label="Big">\n', 1)[1].split("\n</context>")[0]
    assert len(body) <= cc_context.PER_ITEM + 120
    assert "truncated:" in body and "of this note were left out" in body
    assert chips[0]["truncated"] is True and chips[0]["version"] == "2026-10-02"


def test_a_line_s_mentions_stay_under_100k(env):
    raw, state = env
    for i in range(6):
        raw["notes"].rows[f"n{i}"] = {"_id": f"n{i}", "workspace_id": "default", "title": f"N{i}",
                                      "text": "y" * 29_000}
    refs = [{"kind": "note", "id": f"n{i}"} for i in range(6)]
    ctx, chips, _ = run(cc_context.expand(cc_chat._db(), refs, vision=False))
    assert sum(c["chars"] for c in chips) <= cc_context.PER_MESSAGE
    assert [c["truncated"] for c in chips][:3] == [False, False, False]
    assert chips[3]["truncated"] and "limit for one message" in ctx
    # A mention twice is read once.
    _, chips, _ = run(cc_context.expand(cc_chat._db(), refs[:1] * 3, vision=False))
    assert len(chips) == 1


def test_pictures_only_for_a_model_that_reads_them(env):
    raw, state = env
    raw["revisions"].rows["r1"] = {"_id": "r1", "workspace_id": "default", "model": "box", "comment": "round it",
                                   "status": "applied", "image": {"gridfs_id": "g1"}, "image_after": {"gridfs_id": "g2"}}
    db = cc_chat._db()
    ctx, chips, pics = run(cc_context.expand(db, [{"kind": "revision", "id": "r1"}], vision=True))
    assert [p["which"] for p in pics] == ["before", "after"] and chips[0]["images"] == 2
    assert "[Image attached after this message" in ctx
    assert chips[0]["open"]["model"] == "box"
    ctx, chips, pics = run(cc_context.expand(db, [{"kind": "revision", "id": "r1"}], vision=False))
    assert pics == [] and chips[0]["images"] == 0
    assert "not attached (the chosen model does not read images)" in ctx and "after picture" in ctx


def test_a_line_keeps_its_mentions_and_the_model_reads_them(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    raw["notes"].rows["n1"] = {"_id": "n1", "workspace_id": "default", "title": "Fan curve", "text": "PWM 25 kHz"}
    raw["revisions"].rows["r1"] = {"_id": "r1", "workspace_id": "default", "model": "box", "comment": "c",
                                   "image_after": {"gridfs_id": "g2"}}

    async def get_shot(db, gid):
        return b"\x89PNG fake"
    from backend import store
    monkeypatch.setattr(store, "get_shot", get_shot)
    state["vision"] = True
    body = cc_chat.SayIn(text="what does the note say?", client="tab1",
                         mentions=[cc_chat.MentionIn(kind="note", id="n1"), cc_chat.MentionIn(kind="revision", id="r1")])
    ev = events(cc_chat.say("c1", body))
    first = ev[0]
    # The page gets the chips, never the block.
    assert [m["id"] for m in first["message"]["mentions"]] == ["n1", "r1"]
    assert "context" not in first["message"] and first["message"]["context_chars"] > 0
    kept = raw["cc_chats"].rows["c1"]["messages"][0]
    assert "PWM 25 kHz" in kept["context"] and kept["mentions"][0]["label"] == "Fan curve"
    # The model got the block before the line, and the picture with it.
    last = state["sent"][-1]
    assert isinstance(last["content"], list)
    assert "PWM 25 kHz" in last["content"][0]["text"] and last["content"][0]["text"].endswith("what does the note say?")
    assert last["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")
    # Read back: chips, no block.
    got = run(cc_chat.get_chat("c1"))
    assert "context" not in got["messages"][0] and got["messages"][0]["mentions"][1]["id"] == "r1"
    # A later line still has the block in the history; the picture went once.
    ev = events(cc_chat.say("c1", cc_chat.SayIn(text="and then?")))
    assert isinstance(state["sent"][-1]["content"], str)
    assert any("PWM 25 kHz" in (m["content"] if isinstance(m["content"], str) else "") for m in state["sent"])


def test_a_mention_nobody_may_see_stops_the_line(env):
    raw, state = env
    seed_chat(raw)
    raw["notes"].rows["n9@team2"] = {"_id": "n9@team2", "workspace_id": "team2", "text": "theirs"}
    with pytest.raises(HTTPException) as e:
        run(cc_chat.say("c1", cc_chat.SayIn(text="hm", mentions=[cc_chat.MentionIn(kind="note", id="n9")])))
    assert e.value.status_code == 404
    assert raw["cc_chats"].rows["c1"]["messages"] == []      # nothing was kept


def test_the_picker_matches_every_word(env, monkeypatch):
    raw, state = env
    raw["models"].rows["fan/base"] = {"_id": "fan/base", "workspace_id": "default", "title": "Base plate", "version": 2}
    raw["models"].rows["fan/lid"] = {"_id": "fan/lid", "workspace_id": "default", "title": "Lid", "version": 1}
    raw["files"].rows["f1"] = {"_id": "f1", "workspace_id": "default", "name": "base.csv", "kind": "bom", "bytes": 10}
    from backend import lcsc

    async def known(db):
        return [{"lcsc": "C1", "mpn": "BASE-1", "name": "x", "value": None, "maker": None, "branch": "ICs"}]
    monkeypatch.setattr(lcsc, "known", known)
    rows = run(cc_chat.mentions(q="base"))
    assert {(r["kind"], r["id"]) for r in rows} == {("model", "fan/base"), ("file", "f1"), ("part", "C1")}
    assert [r["id"] for r in run(cc_chat.mentions(q="base plate"))] == ["fan/base"]


def test_model_sizes_come_from_the_build():
    viewer = {"data": {"shapes": {"bb": {"xmin": -1, "xmax": 1, "ymin": 0, "ymax": 4, "zmin": 0, "zmax": 2.5},
                                  "parts": [{"name": "lid", "bb": {"xmin": 0, "xmax": 1, "ymin": 0, "ymax": 1,
                                                                   "zmin": 0, "zmax": 1}},
                                            {"name": "board", "parts": [{"name": "U1"}]}]}}}
    got = cc_context._measure(viewer)
    assert got["overall"]["size_mm"] == [2, 4, 2.5]
    assert got["parts"] == [{"part": "lid", "size_mm": [1, 1, 1]}, {"part": "board"}, {"part": "board/U1"}]


def test_the_vision_flag():
    assert llm.vision({"id": "x", "architecture": {"input_modalities": ["text", "image"]}})
    assert not llm.vision({"id": "claude-x", "architecture": {"input_modalities": ["text"]}})
    assert llm.vision({"id": "claude-sonnet-5"}) and not llm.vision({"id": "Qwen/Qwen3.8-Flash"})


# ---- watching an answer -------------------------------------------------------------

def test_every_watcher_gets_the_answer_as_it_is_written(env):
    raw, state = env
    seed_chat(raw)
    key = cc_chat.live_key("c1")
    a, b = cc_chat.HUB.subscribe(key), cc_chat.HUB.subscribe(key)
    state["answer"] = ["Hel", "lo"]
    state["who"] = YOU
    ev = events(cc_chat.say("c1", cc_chat.SayIn(text="hi", client="tabY")))
    got = []
    for q in (a, b):
        rows = []
        while not q.empty():
            rows.append(q.get_nowait())
        got.append(rows)
    assert got[0] == got[1]
    kinds = [e["type"] for e in got[0]]
    assert kinds[0] == "start" and set(kinds[1:-3]) <= {"text"} and kinds[-3:] == ["done", "end", "named"]
    start = got[0][0]
    assert start["client"] == "tabY" and start["by"]["name"] == "You" and start["message"]["content"] == "hi"
    assert len({e.get("gen") for e in got[0]}) == 1 and ev[0]["type"] == "user" and ev[0]["gen"] == start["gen"]
    # The pieces, the start's included (written before the follower looked), are the answer.
    assert start.get("text", "") + "".join(e["text"] for e in got[0] if e["type"] == "text") == "Hello"
    assert got[0][-3]["message"]["content"] == "Hello"
    # Done: nothing is under way any more.
    assert cc_chat.HUB.snapshot(key) == [] and not cc_chat.HUB.busy(key)
    cc_chat.HUB.unsubscribe(key, a)
    cc_chat.HUB.unsubscribe(key, b)
    assert cc_chat.HUB.watchers(key) == 0 and key not in cc_chat.HUB.subs


def test_the_live_stream_says_hello_and_lets_go(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    key = cc_chat.live_key("c1")
    cc_chat.HUB.live.pop(key, None)

    class Req:
        async def is_disconnected(self):
            return False

    async def go():
        resp = await cc_chat.live("c1", Req())
        it = resp.body_iterator.__aiter__()
        hello = json.loads((await it.__anext__()).decode()[5:])
        assert hello["type"] == "hello" and hello["live"] == [] and cc_chat.HUB.watchers(key) == 1
        cc_chat.HUB.publish(key, {"type": "text", "gen": "g", "text": "x"})
        nxt = json.loads((await it.__anext__()).decode()[5:])
        assert nxt == {"type": "text", "gen": "g", "text": "x"}
        await it.aclose()                                     # the page went away
        assert cc_chat.HUB.watchers(key) == 0
    run(go())


def test_a_trashed_or_foreign_conversation_cannot_be_watched(env):
    raw, state = env
    seed_chat(raw, "c2", ws="team2")
    seed_chat(raw, "c3", deleted_at="2026-10-01")
    for cid in ("c2", "c3", "nope"):
        with pytest.raises(HTTPException) as e:
            run(cc_chat.live(cid, None))
        assert e.value.status_code == 404


def test_a_watcher_that_falls_behind_is_let_go():
    hub = cc_chat.Hub()
    hub.QUEUE = 3
    q = hub.subscribe("k")
    for i in range(5):
        hub.publish("k", {"type": "text", "text": str(i)})
    assert hub.watchers("k") == 0
    rows = [q.get_nowait() for _ in range(q.qsize())]
    assert rows[-1] is None                                   # told to go, and reconnect


def test_the_live_route_is_a_viewers():
    assert access.action("GET", "/api/cc/chats/c1/live") == "view"
    assert access.action("GET", "/api/cc/search") == "view"
    assert access.action("GET", "/api/cc/mentions") == "view"


# ---- search -------------------------------------------------------------------------

def test_search_finds_lines_through_the_index(env):
    raw, state = env
    seed_chat(raw, "c1", title="Power", messages=[line("a", "user", "How wide is a 2 A trace?"),
                                                 line("b", "assistant", "For 2 A on 1 oz copper, about 0.8 mm. " * 3)])
    seed_chat(raw, "c2", title="Firmware", messages=[line("c", "user", "debounce four buttons")])
    seed_chat(raw, "c3", title="Old", archived=True, messages=[line("d", "user", "copper pour on the bottom")])
    seed_chat(raw, "c4", title="Gone", deleted_at="2026-10-02", messages=[line("e", "user", "copper everywhere")])
    seed_chat(raw, "c5", title="Theirs", ws="team2", messages=[line("f", "user", "copper too")])
    got = run(cc_chat.search(q="copper"))
    assert got["how"] == "index"
    assert [(r["chat_id"], r["message_id"]) for r in got["results"]] == [("c1", "b")]
    r = got["results"][0]
    assert r["at"] and r["role"] == "assistant" and r["title"] == "Power"
    s, e = r["hits"][0]
    assert r["snippet"][s:e].lower() == "copper"
    # The query went through the index, kept to the workspace, the live and the unarchived.
    q = raw["cc_chats"].queries[-1]
    assert "$text" in json.dumps(q) and "workspace_id" in json.dumps(q) and "deleted_at" in json.dumps(q)
    # Archived, with the toggle.
    got = run(cc_chat.search(q="copper", archived="all"))
    assert {r["chat_id"] for r in got["results"]} == {"c1", "c3"}
    # The trash, from the trash.
    got = run(cc_chat.search(q="copper", trash="1"))
    assert [r["chat_id"] for r in got["results"]] == ["c4"]


def test_search_a_title_and_the_words_of_a_phrase(env):
    raw, state = env
    seed_chat(raw, "c1", title="Fan board power", messages=[line("a", "user", "hello")])
    got = run(cc_chat.search(q="fan"))
    assert got["results"][0]["message_id"] is None and got["results"][0]["snippet"] == "Fan board power"
    assert cc_chat.terms('"snap fit" lid -box') == ["snap fit", "lid"]
    assert run(cc_chat.search(q="   "))["results"] == []


def test_search_reads_them_all_without_the_index(env):
    raw, state = env
    raw["cc_chats"].text_index = False
    seed_chat(raw, "c1", messages=[line("a", "user", "ESP32 deep sleep")])
    got = run(cc_chat.search(q="esp32"))
    assert got["how"] == "scan" and got["results"][0]["message_id"] == "a"


def test_snippets_are_cut_around_the_first_word():
    text = "word " * 100 + "TARGET here " + "more " * 100
    snip, hits = cc_chat.snippet(text, ["target"])
    assert snip.startswith("…") and snip.endswith("…") and len(snip) <= cc_chat.SNIPPET + 2
    assert [snip[s:e] for s, e in hits] == ["TARGET"]
    assert cc_chat.snippet("nothing", ["x"]) is None


class IdxColl:
    def __init__(self, have=None):
        self.have = dict(have or {})
        self.calls = []

    async def create_index(self, keys, **kw):
        self.calls.append(("create", kw["name"]))
        for name, (k, o) in self.have.items():
            if any(t == "text" for _, t in k) and (name != kw["name"] or (k, o) != (keys, kw)):
                err = Exception("IndexOptionsConflict")
                err.code = 85
                raise err
        self.have[kw["name"]] = (keys, kw)

    async def index_information(self):
        return {n: {"key": [("_fts", "text"), ("_ftsx", 1)] if any(t == "text" for _, t in k) else k}
                for n, (k, o) in self.have.items()}

    async def drop_index(self, name):
        self.calls.append(("drop", name))
        del self.have[name]


def test_the_search_index_is_made_once_and_replaces_another():
    coll = IdxColl()
    run(cc_chat.ensure_search_index({cc_chat.COLL: coll}))
    run(cc_chat.ensure_search_index({cc_chat.COLL: coll}))
    keys, kw = coll.have[cc_chat.SEARCH_INDEX]
    assert keys == [("title", "text"), ("messages.content", "text")]
    assert kw["default_language"] == "none" and kw["weights"]["title"] > kw["weights"]["messages.content"]
    assert [c[0] for c in coll.calls] == ["create", "create"]
    old = IdxColl({"title_text": ([("title", "text")], {"name": "title_text"})})
    run(cc_chat.ensure_search_index({cc_chat.COLL: old}))
    assert set(old.have) == {cc_chat.SEARCH_INDEX} and ("drop", "title_text") in old.calls


def test_the_search_index_is_made_at_startup():
    import inspect

    from backend import main
    assert "cc_chat.ensure_search_index(db().raw)" in inspect.getsource(main._start_sampler)
