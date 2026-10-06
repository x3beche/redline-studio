"""The Command Code room: deleting, pinning, editing, answering again.

What matters: nobody drops someone else's lines (or conversation) without
the right to delete, an edit or a regenerated answer never cuts away a line
that arrived meanwhile, old conversations whose lines have no ids still
work, and a conversation is named once - never over a name someone gave it.
"""

import asyncio
import json

import pytest
from fastapi import HTTPException

from backend import access, actors, cc_chat, llm

ME = {"id": "u-me", "name": "Me", "type": "person"}
YOU = {"id": "u-you", "name": "You", "type": "person"}


class Res:
    def __init__(self, n):
        self.matched_count = n
        self.modified_count = n


class FakeColl:
    def __init__(self):
        self.rows: dict[str, dict] = {}

    def _match(self, row, query):
        for k, v in query.items():
            if k == "messages" and isinstance(v, dict) and "$size" in v:
                if len(row.get("messages") or []) != v["$size"]:
                    return False
            elif isinstance(v, dict) and "$in" in v:
                if row.get(k) not in v["$in"]:
                    return False
            elif row.get(k) != v:
                return False
        return True

    async def insert_one(self, doc):
        self.rows[doc["_id"]] = json.loads(json.dumps(doc))

    async def find_one(self, query, projection=None):
        row = self.rows.get(query["_id"])
        return json.loads(json.dumps(row)) if row and self._match(row, query) else None

    async def update_one(self, query, update):
        row = self.rows.get(query["_id"])
        if not row or not self._match(row, query):
            return Res(0)
        for k, v in (update.get("$set") or {}).items():
            row[k] = json.loads(json.dumps(v))
        for k, v in (update.get("$push") or {}).items():
            row.setdefault(k, []).append(json.loads(json.dumps(v)))
        for k, cond in (update.get("$pull") or {}).items():
            row[k] = [m for m in row.get(k, []) if not all(m.get(a) == b for a, b in cond.items())]
        return Res(1)

    async def delete_one(self, query):
        return Res(1 if self.rows.pop(query["_id"], None) else 0)


class FakeDb:
    def __init__(self):
        self.coll = FakeColl()

    def __getitem__(self, name):
        assert name == cc_chat.COLL
        return self.coll


@pytest.fixture
def env(monkeypatch):
    db = FakeDb()
    state = {"who": ME, "role": "reviewer", "answer": ["Hello", " there"], "title": "Board power budget",
             "title_calls": 0, "audit": [], "recorded": []}
    monkeypatch.setattr(cc_chat, "_db", lambda: db)
    monkeypatch.setattr(actors, "current", lambda: state["who"])
    monkeypatch.setattr(access, "current", lambda: state["role"])
    monkeypatch.setattr(llm, "key", lambda p: "k")

    async def stream(messages, *, provider, model, max_tokens=8000, temperature=None):
        state["sent"] = messages
        for piece in state["answer"]:
            yield {"text": piece}
        yield {"usage": {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0.001}}

    async def complete(messages, **kw):
        state["title_calls"] += 1
        if isinstance(state["title"], Exception):
            raise state["title"]
        return {"choices": [{"message": {"content": state["title"]}}], "usage": {"prompt_tokens": 3},
                "provider": "openrouter", "model": "cheap"}

    async def record(db, **kw):
        state["recorded"].append(kw["kind"])

    async def audit(db, action, target, detail=None, actor=None):
        state["audit"].append((action, target))

    monkeypatch.setattr(llm, "stream", stream)
    monkeypatch.setattr(llm, "complete", complete)
    monkeypatch.setattr(llm, "record", record)
    monkeypatch.setattr(actors, "audit", audit)
    return db, state


def run(coro):
    return asyncio.run(coro)


def events(resp) -> list[dict]:
    async def go():
        out = []
        async for chunk in resp.body_iterator:
            for line in (chunk.decode() if isinstance(chunk, bytes) else chunk).split("\n"):
                if line.startswith("data:"):
                    out.append(json.loads(line[5:]))
        return out
    return run(go())


def msg(mid, role, text, by=ME):
    m = {"role": role, "content": text, "at": "2026-10-01T10:00:00+00:00"}
    if mid:
        m["id"] = mid
    if role == "user":
        m["by"] = dict(by)
    return m


def seed(db, cid="c1", messages=(), by=ME, title="Chat"):
    db.coll.rows[cid] = {"_id": cid, "title": title, "provider": "openrouter", "model": "m1", "by": dict(by),
                         "created_at": "2026-10-01T10:00:00+00:00", "updated_at": "2026-10-01T10:00:00+00:00",
                         "messages": [dict(m) for m in messages]}


# ---- the pure parts -----------------------------------------------------------

def test_lines_are_found_by_id_and_old_ones_by_place():
    msgs = [msg(None, "user", "a"), msg("12345", "assistant", "b"), msg("x9", "user", "c")]
    assert cc_chat.find(msgs, "x9") == 2
    assert cc_chat.find(msgs, "12345") == 1          # an id of digits is an id, not a place
    assert cc_chat.find(msgs, "0") == 0              # no id: by place
    assert cc_chat.find(msgs, "1") == -1             # that one has an id, a place does not name it
    assert cc_chat.find(msgs, "7") == -1
    assert cc_chat.find(msgs, "nope") == -1


def test_an_answer_belongs_to_whoever_asked():
    msgs = [msg("a", "user", "q1", ME), msg("b", "assistant", "a1"), msg("c", "user", "q2", YOU),
            msg("d", "assistant", "a2")]
    assert cc_chat.owners(msgs) == ["u-me", "u-me", "u-you", "u-you"]
    assert cc_chat.may_drop(msgs, [0, 1], "u-me", False)
    assert not cc_chat.may_drop(msgs, [1, 2], "u-me", False)
    assert cc_chat.may_drop(msgs, [3], "u-me", True)


def test_ids_are_given_to_old_lines_only():
    msgs = [msg(None, "user", "a"), msg("keep", "assistant", "b")]
    out, changed = cc_chat.with_ids(msgs)
    assert changed and out[0]["id"] and out[1]["id"] == "keep"
    assert "id" not in msgs[0]                       # the input is left alone
    assert cc_chat.with_ids(out) == (out, False)


def test_regenerate_cuts_after_the_last_question():
    assert cc_chat.regen_cut([]) == -1
    assert cc_chat.regen_cut([msg("a", "user", "q")]) == 1
    assert cc_chat.regen_cut([msg("a", "user", "q"), msg("b", "assistant", "x"), msg("c", "assistant", "y")]) == 1


@pytest.mark.parametrize("raw,want", [
    ('"Power Budget for the Fan Board."', "Power Budget for the Fan Board"),
    ("Title: STM32 clock tree setup\nmore", "STM32 clock tree setup"),
    ("**One two three four five six seven eight**", "One two three four five six"),
    ("Başlık: Fan kartı güç bütçesi", "Fan kartı güç bütçesi"),
    ("  \n", ""),
])
def test_titles_are_cleaned(raw, want):
    assert cc_chat.clean_title(raw) == want


def test_the_fallback_title_is_the_first_line_cut_short():
    assert cc_chat.fallback_title("  how   do I\nroute USB? ") == "how do I route USB?"
    assert len(cc_chat.fallback_title("x" * 500)) == cc_chat.TITLE_CHARS
    assert cc_chat.fallback_title("") == cc_chat.DEFAULT_TITLE


# ---- conversations --------------------------------------------------------------

def test_pin_and_archive_are_kept_and_shown(env):
    db, _ = env
    seed(db)
    got = run(cc_chat.patch_chat("c1", cc_chat.ChatPatch(pinned=True)))
    assert got["pinned"] is True and got["archived"] is False
    got = run(cc_chat.patch_chat("c1", cc_chat.ChatPatch(archived=True, pinned=False)))
    assert got["pinned"] is False and got["archived"] is True
    assert db.coll.rows["c1"]["title"] == "Chat"     # nothing else touched
    with pytest.raises(HTTPException) as e:
        run(cc_chat.patch_chat("nope", cc_chat.ChatPatch(pinned=True)))
    assert e.value.status_code == 404


def test_old_lines_get_ids_when_read(env):
    db, _ = env
    seed(db, messages=[msg(None, "user", "a"), msg(None, "assistant", "b")])
    got = run(cc_chat.get_chat("c1"))
    ids = [m["id"] for m in got["messages"]]
    assert all(ids) and len(set(ids)) == 2
    assert [m["id"] for m in db.coll.rows["c1"]["messages"]] == ids


def test_bulk_delete_takes_mine_and_names_the_rest(env):
    db, state = env
    seed(db, "a", by=ME)
    seed(db, "b", by=YOU)
    got = run(cc_chat.bulk_delete(cc_chat.BulkIn(ids=["a", "b", "zz", "a"])))
    assert got == {"deleted": ["a"], "refused": ["b"], "missing": ["zz"]}
    assert set(db.coll.rows) == {"b"}
    assert state["audit"] == [("delete", "/api/cc/chats/a")]
    state["role"] = "editor"                          # may delete
    assert run(cc_chat.bulk_delete(cc_chat.BulkIn(ids=["b"])))["deleted"] == ["b"]


# ---- lines ------------------------------------------------------------------------

def test_deleting_a_line(env):
    db, state = env
    seed(db, messages=[msg("a", "user", "q", ME), msg("b", "assistant", "x"),
                       msg("c", "user", "q2", YOU), msg("d", "assistant", "y")])
    got = run(cc_chat.delete_message("c1", "b"))      # the answer to my question
    assert [m["id"] for m in got["messages"]] == ["a", "c", "d"]
    with pytest.raises(HTTPException) as e:           # yours, without the right to delete
        run(cc_chat.delete_message("c1", "c"))
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        run(cc_chat.delete_message("c1", "zz"))
    assert e.value.status_code == 404
    state["role"] = "editor"
    got = run(cc_chat.delete_message("c1", "d"))
    assert [m["id"] for m in got["messages"]] == ["a", "c"]


def test_deleting_an_old_line_by_its_place(env):
    db, _ = env
    seed(db, messages=[msg(None, "user", "q"), msg(None, "assistant", "x")])
    run(cc_chat.delete_message("c1", "1"))
    assert [m["content"] for m in db.coll.rows["c1"]["messages"]] == ["q"]


# ---- talking ------------------------------------------------------------------------

def test_a_line_and_its_answer_are_kept_and_the_chat_is_named(env):
    db, state = env
    seed(db, title=cc_chat.DEFAULT_TITLE)
    ev = events(run(cc_chat.say("c1", cc_chat.SayIn(text="power budget for the fan board?"))))
    assert [e["type"] for e in ev] == ["user", "text", "text", "done", "title"]
    assert ev[0]["keep"] == 0 and ev[-1]["title"] == "Board power budget"
    row = db.coll.rows["c1"]
    assert [m["role"] for m in row["messages"]] == ["user", "assistant"]
    assert row["messages"][1]["content"] == "Hello there"
    assert row["messages"][1]["usage"]["completion_tokens"] == 5
    assert row["title"] == "Board power budget"
    assert sorted(state["recorded"]) == ["cc-chat", "cc-title"]
    # Named once: the next line does not ask again.
    ev = events(run(cc_chat.say("c1", cc_chat.SayIn(text="and the LEDs?"))))
    assert "title" not in [e["type"] for e in ev] and state["title_calls"] == 1


def test_a_title_falls_back_and_never_overwrites_a_rename(env):
    db, state = env
    seed(db, title=cc_chat.DEFAULT_TITLE)
    state["title"] = RuntimeError("no model")
    ev = events(run(cc_chat.say("c1", cc_chat.SayIn(text="How do I flash   an ESP32-S3?"))))
    assert ev[-1] == {"type": "title", "title": "How do I flash an ESP32-S3?"}
    seed(db, "c2", title="Mine")
    ev = events(run(cc_chat.say("c2", cc_chat.SayIn(text="hi"))))
    assert "title" not in [e["type"] for e in ev] and db.coll.rows["c2"]["title"] == "Mine"


def test_editing_my_last_line_drops_what_followed(env):
    db, state = env
    seed(db, messages=[msg("a", "user", "q1"), msg("b", "assistant", "x"),
                       msg("c", "user", "typo"), msg("d", "assistant", "y")])
    ev = events(run(cc_chat.say("c1", cc_chat.SayIn(text="fixed", edit="c"))))
    assert ev[0]["keep"] == 2 and ev[0]["message"]["content"] == "fixed"
    row = db.coll.rows["c1"]["messages"]
    assert [m["content"] for m in row] == ["q1", "x", "fixed", "Hello there"]
    assert row[2]["edited_at"]
    assert state["sent"][-1] == {"role": "user", "content": "fixed"}


def test_an_edit_does_not_touch_someone_elses(env):
    db, state = env
    seed(db, messages=[msg("a", "user", "mine", ME), msg("b", "assistant", "x"),
                       msg("c", "user", "theirs", YOU)])
    with pytest.raises(HTTPException) as e:           # not my line
        run(cc_chat.say("c1", cc_chat.SayIn(text="no", edit="c")))
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:           # mine, but theirs follows
        run(cc_chat.say("c1", cc_chat.SayIn(text="no", edit="a")))
    assert e.value.status_code == 403
    assert len(db.coll.rows["c1"]["messages"]) == 3


def test_an_edit_loses_to_a_line_that_arrived_meanwhile(env, monkeypatch):
    db, _ = env
    seed(db, messages=[msg("a", "user", "q"), msg("b", "assistant", "x")])
    real = db.coll.find_one

    async def stale(query, projection=None):          # read before someone added a line
        got = await real(query, projection)
        db.coll.rows["c1"]["messages"].append(msg("z", "user", "late", YOU))
        return got
    monkeypatch.setattr(db.coll, "find_one", stale)
    with pytest.raises(HTTPException) as e:
        run(cc_chat.say("c1", cc_chat.SayIn(text="edit", edit="a")))
    assert e.value.status_code == 409
    assert [m["id"] for m in db.coll.rows["c1"]["messages"]] == ["a", "b", "z"]


def test_regenerate_with_another_model(env):
    db, state = env
    seed(db, messages=[msg("a", "user", "q"), msg("b", "assistant", "old")])
    state["answer"] = ["new"]
    ev = events(run(cc_chat.regenerate("c1", cc_chat.RegenIn(model="m2"))))
    assert ev[0] == {"type": "user", "message": None, "keep": 1}
    row = db.coll.rows["c1"]
    assert [m["content"] for m in row["messages"]] == ["q", "new"]
    assert row["messages"][1]["model"] == "m2" and row["model"] == "m2"
    assert state["sent"][-1] == {"role": "user", "content": "q"}


def test_regenerate_needs_a_question_and_the_right_to_drop(env):
    db, state = env
    seed(db)
    with pytest.raises(HTTPException) as e:
        run(cc_chat.regenerate("c1", None))
    assert e.value.status_code == 400
    seed(db, "c2", messages=[msg("a", "user", "q", YOU), msg("b", "assistant", "x")])
    with pytest.raises(HTTPException) as e:
        run(cc_chat.regenerate("c2", None))
    assert e.value.status_code == 403
    state["role"] = "editor"
    events(run(cc_chat.regenerate("c2", None)))
    assert [m["content"] for m in db.coll.rows["c2"]["messages"]] == ["q", "Hello there"]


def test_the_new_routes_are_a_reviewers_like_talking():
    r = "reviewer"
    for method, path in (("POST", "/api/cc/chats/bulk-delete"), ("POST", "/api/cc/chats/c1/regenerate"),
                         ("DELETE", "/api/cc/chats/c1/messages/m1"), ("POST", "/api/cc/chats/c1/messages"),
                         ("PATCH", "/api/cc/chats/c1"), ("DELETE", "/api/cc/chats/c1")):
        assert access.action(method, path) == "draw", (method, path)
        assert access.allowed(r, access.action(method, path))
        assert not access.allowed("viewer", access.action(method, path))


def test_a_stopped_answer_is_kept_and_marked(env, monkeypatch):
    db, state = env
    seed(db, messages=[msg("a", "user", "q"), msg("b", "assistant", "")])   # an old empty one

    async def stopped(messages, **kw):
        state["sent"] = messages
        yield {"text": "Half"}
        raise asyncio.CancelledError

    monkeypatch.setattr(llm, "stream", stopped)
    with pytest.raises(asyncio.CancelledError):
        events(run(cc_chat.say("c1", cc_chat.SayIn(text="go on"))))
    # The empty line was not sent; the two questions went as one.
    assert state["sent"][1:] == [{"role": "user", "content": "q\n\ngo on"}]
    last = db.coll.rows["c1"]["messages"][-1]
    assert last["content"] == "Half" and last["stopped"] is True and "error" not in last

    async def nothing(messages, **kw):
        raise asyncio.CancelledError
        yield {}

    monkeypatch.setattr(llm, "stream", nothing)
    with pytest.raises(asyncio.CancelledError):
        events(run(cc_chat.say("c1", cc_chat.SayIn(text="again"))))
    last = db.coll.rows["c1"]["messages"][-1]
    assert last["content"] == "" and last["stopped"] and last["error"] == "stopped before the answer began"
