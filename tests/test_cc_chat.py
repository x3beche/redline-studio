"""The Command Code room: deleting, pinning, editing, answering again.

What matters: nobody drops someone else's lines (or conversation) without
the right to delete, an edit or a regenerated answer never cuts away a line
that arrived meanwhile, old conversations whose lines have no ids still
work, and a conversation is named once - never over a name someone gave it.
A deleted conversation goes to the trash: out of sight everywhere else,
back with Restore, gone for good with "Delete forever", "Empty trash" or,
after 30 days, the database's own TTL index.
"""

import asyncio
import copy
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from backend import access, actors, cc_chat, llm

ME = {"id": "u-me", "name": "Me", "type": "person"}
YOU = {"id": "u-you", "name": "You", "type": "person"}


class Res:
    def __init__(self, n):
        self.matched_count = n
        self.modified_count = n
        self.deleted_count = n


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, keys):
        for k, d in reversed(keys):
            self.rows.sort(key=lambda r: (r.get(k) is not None, r.get(k) or 0), reverse=d < 0)
        return self

    def limit(self, n):
        self.rows = self.rows[:n]
        return self

    def __aiter__(self):
        async def gen():
            for r in self.rows:
                yield r
        return gen()


class FakeColl:
    """Enough of Mongo for the routes: equality (None matching a missing
    field, as Mongo does), $ne, $in, $size, $regex in an $or."""

    def __init__(self):
        self.rows: dict[str, dict] = {}
        self.indexes: list[tuple] = []

    def _one(self, row, k, v):
        got = row.get(k)
        if isinstance(v, dict) and any(op.startswith("$") for op in v):
            for op, a in v.items():
                if op == "$size" and len(got or []) != a:
                    return False
                if op == "$in" and got not in a:
                    return False
                if op == "$ne" and got == a:
                    return False
                if op == "$regex":
                    import re
                    hay = [m.get("content") or "" for m in row.get("messages") or []] if k == "messages.content" \
                        else [got or ""]
                    if not any(re.search(a, h, re.I) for h in hay):
                        return False
            return True
        return got == v

    def _match(self, row, query):
        for k, v in query.items():
            if k == "$or":
                if not any(self._match(row, q) for q in v):
                    return False
            elif not self._one(row, k, v):
                return False
        return True

    async def insert_one(self, doc):
        self.rows[doc["_id"]] = copy.deepcopy(doc)

    async def find_one(self, query, projection=None):
        row = self.rows.get(query["_id"])
        return copy.deepcopy(row) if row and self._match(row, query) else None

    def find(self, query, projection=None):
        return Cursor([copy.deepcopy(r) for r in self.rows.values() if self._match(r, query)])

    def aggregate(self, pipeline):
        return Cursor([{"_id": r["_id"], "n": len(r.get("messages") or [])} for r in self.rows.values()])

    async def update_one(self, query, update):
        row = self.rows.get(query["_id"])
        if not row or not self._match(row, query):
            return Res(0)
        for k, v in (update.get("$set") or {}).items():
            row[k] = copy.deepcopy(v)
        for k in (update.get("$unset") or {}):
            row.pop(k, None)
        for k, v in (update.get("$push") or {}).items():
            row.setdefault(k, []).append(copy.deepcopy(v))
        for k, cond in (update.get("$pull") or {}).items():
            row[k] = [m for m in row.get(k, []) if not all(m.get(a) == b for a, b in cond.items())]
        return Res(1)

    async def delete_one(self, query):
        row = self.rows.get(query["_id"])
        if not row or not self._match(row, query):
            return Res(0)
        return Res(1 if self.rows.pop(query["_id"], None) else 0)

    async def delete_many(self, query):
        gone = [k for k, r in self.rows.items() if self._match(r, query)]
        for k in gone:
            del self.rows[k]
        return Res(len(gone))


class FakeDb:
    def __init__(self):
        self.coll = FakeColl()
        self.colls = {cc_chat.COLL: self.coll}

    def __getitem__(self, name):
        # The conversations, and the answers being written (backend/ccgen.py).
        assert name in (cc_chat.COLL, "cc_gens")
        return self.colls.setdefault(name, FakeColl())


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
        state.setdefault("details", []).append(detail)

    monkeypatch.setattr(llm, "stream", stream)
    monkeypatch.setattr(llm, "complete", complete)
    monkeypatch.setattr(llm, "record", record)
    monkeypatch.setattr(actors, "audit", audit)
    return db, state


def run(coro):
    return asyncio.run(coro)


def events(resp) -> list[dict]:
    """The events a route streams. Given the route's coroutine, it is run in
    the same loop: the answer's runner is a task there (tests/conftest.py)."""
    async def go():
        nonlocal resp
        if asyncio.iscoroutine(resp):
            resp = await resp
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
    assert set(db.coll.rows) == {"a", "b"}            # "a" is in the trash, not gone
    assert db.coll.rows["a"]["deleted_at"] and "deleted_at" not in db.coll.rows["b"]
    assert state["audit"] == [("delete", "/api/cc/chats/a")]
    assert state["details"][0]["trash"] is True
    state["role"] = "editor"                          # may delete
    assert run(cc_chat.bulk_delete(cc_chat.BulkIn(ids=["b"])))["deleted"] == ["b"]
    # Already in the trash: not deleted again.
    assert run(cc_chat.bulk_delete(cc_chat.BulkIn(ids=["a"])))["missing"] == ["a"]


# ---- the trash --------------------------------------------------------------------

def trashed(db, cid, days_ago=0.0, by=ME):
    db.coll.rows[cid]["deleted_at"] = datetime.now(timezone.utc) - timedelta(days=days_ago)
    db.coll.rows[cid]["deleted_by"] = dict(by)


def test_a_delete_goes_to_the_trash(env):
    db, state = env
    seed(db, messages=[msg("a", "user", "q"), msg("b", "assistant", "x")])
    db.coll.rows["c1"]["pinned"] = True
    got = run(cc_chat.delete_chat("c1"))
    assert got == {"deleted": "c1", "trash": True, "days": 30}
    row = db.coll.rows["c1"]
    assert isinstance(row["deleted_at"], datetime)    # a date, which the TTL index needs
    assert row["deleted_by"] == {"id": "u-me", "name": "Me", "type": "person"}
    assert len(row["messages"]) == 2 and row["pinned"] is True   # nothing else touched
    with pytest.raises(HTTPException) as e:           # not twice
        run(cc_chat.delete_chat("c1"))
    assert e.value.status_code == 404


def test_someone_elses_needs_the_right_to_delete(env):
    db, state = env
    seed(db, by=YOU)
    with pytest.raises(HTTPException) as e:
        run(cc_chat.delete_chat("c1"))
    assert e.value.status_code == 403 and "deleted_at" not in db.coll.rows["c1"]
    state["role"] = "editor"
    run(cc_chat.delete_chat("c1"))
    assert db.coll.rows["c1"]["deleted_by"]["id"] == "u-me"


def test_a_trashed_conversation_is_out_of_everything_else(env):
    db, state = env
    seed(db, "live", title="Fan board power", messages=[msg("a", "user", "power budget")])
    seed(db, "gone", title="Fan board power too", messages=[msg("a", "user", "power budget")])
    seed(db, "arch", title="Old")
    db.coll.rows["arch"]["archived"] = True
    run(cc_chat.delete_chat("gone"))
    assert [c["id"] for c in run(cc_chat.list_chats())] == ["live"]
    assert [c["id"] for c in run(cc_chat.list_chats(q="power"))] == ["live"]
    assert {c["id"] for c in run(cc_chat.list_chats(archived="all"))} == {"live", "arch"}
    assert [c["id"] for c in run(cc_chat.list_chats(archived="1"))] == ["arch"]
    for call in (lambda: cc_chat.get_chat("gone"),
                 lambda: cc_chat.patch_chat("gone", cc_chat.ChatPatch(title="x")),
                 lambda: cc_chat.delete_message("gone", "a"),
                 lambda: cc_chat.say("gone", cc_chat.SayIn(text="hi")),
                 lambda: cc_chat.regenerate("gone", None)):
        with pytest.raises(HTTPException) as e:
            run(call())
        assert e.value.status_code == 404
    assert db.coll.rows["gone"]["title"] == "Fan board power too"


def test_the_trash_lists_who_deleted_and_when_it_goes(env):
    db, state = env
    seed(db, "a")
    seed(db, "b", by=YOU)
    seed(db, "old")
    seed(db, "live")
    trashed(db, "a", days_ago=2)
    trashed(db, "b", days_ago=0.1, by=YOU)
    trashed(db, "old", days_ago=31)                   # past its day: the TTL has not run yet
    db.coll.rows["b"]["archived"] = True              # archived or not, it is in the trash
    rows = run(cc_chat.list_chats(trash="1"))
    assert [c["id"] for c in rows] == ["b", "a"]       # newest deleted first
    assert rows[0]["deleted_by"]["name"] == "You" and rows[0]["days_left"] == 30
    assert rows[1]["days_left"] == 28
    assert rows[1]["purge_at"].startswith((datetime.now(timezone.utc) + timedelta(days=28)).date().isoformat())
    assert "deleted_at" not in run(cc_chat.list_chats())[0]
    assert [c["id"] for c in run(cc_chat.list_chats(trash="1", q="nothing like it"))] == []


def test_restore_brings_it_back_as_it_was(env):
    db, state = env
    seed(db, messages=[msg("a", "user", "q")])
    db.coll.rows["c1"]["archived"] = True
    run(cc_chat.delete_chat("c1"))
    got = run(cc_chat.restore_chat("c1"))
    assert got["id"] == "c1" and got["archived"] is True and len(got["messages"]) == 1
    assert "deleted_at" not in db.coll.rows["c1"] and "deleted_by" not in db.coll.rows["c1"]
    assert ("restore", "/api/cc/chats/c1") in state["audit"]
    with pytest.raises(HTTPException) as e:           # not in the trash (any more)
        run(cc_chat.restore_chat("c1"))
    assert e.value.status_code == 404


def test_restoring_someone_elses_needs_the_right_to_delete(env):
    db, state = env
    seed(db, "a", by=YOU)
    seed(db, "b", by=ME)
    trashed(db, "a", by=YOU)
    trashed(db, "b", by=YOU)                          # an editor threw mine away: I may bring it back
    with pytest.raises(HTTPException) as e:
        run(cc_chat.restore_chat("a"))
    assert e.value.status_code == 403
    got = run(cc_chat.bulk_restore(cc_chat.BulkIn(ids=["a", "b", "zz"])))
    assert got == {"restored": ["b"], "refused": ["a"], "missing": ["zz"]}
    state["role"] = "editor"
    run(cc_chat.restore_chat("a"))
    assert "deleted_at" not in db.coll.rows["a"]


def test_delete_forever(env):
    db, state = env
    seed(db, "a")
    seed(db, "b", by=YOU)
    seed(db, "c")
    trashed(db, "a")
    trashed(db, "b", by=YOU)
    trashed(db, "c")
    assert run(cc_chat.delete_chat("a", forever="1")) == {"deleted": "a", "forever": True}
    assert "a" not in db.coll.rows
    with pytest.raises(HTTPException) as e:           # someone else's
        run(cc_chat.delete_chat("b", forever="1"))
    assert e.value.status_code == 403 and "b" in db.coll.rows
    got = run(cc_chat.bulk_delete(cc_chat.BulkIn(ids=["b", "c"], forever=True)))
    assert got == {"deleted": ["c"], "refused": ["b"], "missing": []}
    assert set(db.coll.rows) == {"b"}
    assert state["details"][-1]["forever"] is True
    state["role"] = "editor"
    run(cc_chat.delete_chat("b", forever="1"))
    assert not db.coll.rows


def test_empty_trash(env):
    db, state = env
    for cid, by in (("a", ME), ("b", YOU), ("c", ME), ("live", ME)):
        seed(db, cid, by=by)
    for cid in ("a", "b", "c"):
        trashed(db, cid)
    assert run(cc_chat.empty_trash()) == {"deleted": 2, "kept": 1}     # someone else's stays
    assert set(db.coll.rows) == {"b", "live"}
    assert state["audit"][-1] == ("delete", "/api/cc/chats/empty-trash")
    state["role"] = "editor"
    assert run(cc_chat.empty_trash()) == {"deleted": 1, "kept": 0}
    assert set(db.coll.rows) == {"live"}                                # the live one is never touched
    n = len(state["audit"])
    assert run(cc_chat.empty_trash()) == {"deleted": 0, "kept": 0}
    assert len(state["audit"]) == n                                     # nothing to say


class IdxColl:
    def __init__(self, have=None):
        self.have = dict(have or {})
        self.calls: list = []

    async def create_index(self, keys, **kw):
        self.calls.append(("create", keys, kw))
        old = self.have.get(kw["name"])
        if old is not None and old != (keys, kw):
            err = Exception("IndexOptionsConflict")
            err.code = 85
            raise err
        self.have[kw["name"]] = (keys, kw)

    async def drop_index(self, name):
        self.calls.append(("drop", name))
        if not isinstance(name, str) or name not in self.have:
            err = Exception("index not found")
            err.code = 27
            raise err
        del self.have[name]


def test_the_ttl_index_is_made_once_and_holds_only_the_trash():
    coll = IdxColl()
    raw = {cc_chat.COLL: coll}
    run(cc_chat.ensure_indexes(raw))
    run(cc_chat.ensure_indexes(raw))                  # again at the next start: no harm
    keys, kw = coll.have[cc_chat.TRASH_TTL]
    assert keys == [("deleted_at", 1)]
    assert kw["expireAfterSeconds"] == 30 * 86400
    # Partial: only a conversation with a deleted_at date is in it, so a
    # live one can never expire, whatever its other fields.
    assert kw["partialFilterExpression"] == {"deleted_at": {"$type": "date"}}
    assert [c[0] for c in coll.calls] == ["create", "create"]


def test_a_ttl_index_with_other_options_is_replaced():
    coll = IdxColl({cc_chat.TRASH_TTL: ([("deleted_at", 1)], {"name": cc_chat.TRASH_TTL, "expireAfterSeconds": 60})})
    run(cc_chat.ensure_indexes({cc_chat.COLL: coll}))
    assert coll.have[cc_chat.TRASH_TTL][1]["expireAfterSeconds"] == 30 * 86400


def test_other_index_failures_are_not_swallowed():
    class Down(IdxColl):
        async def create_index(self, keys, **kw):
            raise RuntimeError("no database")
    with pytest.raises(RuntimeError):
        run(cc_chat.ensure_indexes({cc_chat.COLL: Down()}))


def test_the_index_is_made_at_startup():
    import inspect

    from backend import main
    src = inspect.getsource(main._start_sampler)
    assert "cc_chat.ensure_indexes(db().raw)" in src   # the database itself: one index for every workspace


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
    ev = events(cc_chat.say("c1", cc_chat.SayIn(text="power budget for the fan board?")))
    # The pieces come as the runner wrote them down: joined, or one by one.
    kinds = [e["type"] for e in ev]
    assert kinds[0] == "user" and set(kinds[1:-2]) == {"text"} and kinds[-2:] == ["done", "title"]
    assert "".join(e["text"] for e in ev if e["type"] == "text") == "Hello there"
    assert ev[0]["keep"] == 0 and ev[0]["gen"] and ev[-1]["title"] == "Board power budget"
    row = db.coll.rows["c1"]
    assert [m["role"] for m in row["messages"]] == ["user", "assistant"]
    assert row["messages"][1]["content"] == "Hello there"
    assert row["messages"][1]["usage"]["completion_tokens"] == 5
    assert row["title"] == "Board power budget"
    assert sorted(state["recorded"]) == ["cc-chat", "cc-title"]
    # Named once: the next line does not ask again.
    ev = events(cc_chat.say("c1", cc_chat.SayIn(text="and the LEDs?")))
    assert "title" not in [e["type"] for e in ev] and state["title_calls"] == 1


def test_a_title_falls_back_and_never_overwrites_a_rename(env):
    db, state = env
    seed(db, title=cc_chat.DEFAULT_TITLE)
    state["title"] = RuntimeError("no model")
    ev = events(cc_chat.say("c1", cc_chat.SayIn(text="How do I flash   an ESP32-S3?")))
    assert ev[-1] == {"type": "title", "title": "How do I flash an ESP32-S3?"}
    seed(db, "c2", title="Mine")
    ev = events(cc_chat.say("c2", cc_chat.SayIn(text="hi")))
    assert "title" not in [e["type"] for e in ev] and db.coll.rows["c2"]["title"] == "Mine"


def test_editing_my_last_line_drops_what_followed(env):
    db, state = env
    seed(db, messages=[msg("a", "user", "q1"), msg("b", "assistant", "x"),
                       msg("c", "user", "typo"), msg("d", "assistant", "y")])
    ev = events(cc_chat.say("c1", cc_chat.SayIn(text="fixed", edit="c")))
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
    ev = events(cc_chat.regenerate("c1", cc_chat.RegenIn(model="m2")))
    assert ev[0] == {"type": "user", "message": None, "keep": 1, "gen": ev[0]["gen"]}
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
    events(cc_chat.regenerate("c2", None))
    assert [m["content"] for m in db.coll.rows["c2"]["messages"]] == ["q", "Hello there"]


def test_the_new_routes_are_a_reviewers_like_talking():
    r = "reviewer"
    for method, path in (("POST", "/api/cc/chats/bulk-delete"), ("POST", "/api/cc/chats/c1/regenerate"),
                         ("POST", "/api/cc/chats/c1/restore"), ("POST", "/api/cc/chats/bulk-restore"),
                         ("POST", "/api/cc/chats/empty-trash"),
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
    events(cc_chat.say("c1", cc_chat.SayIn(text="go on")))
    # The empty line was not sent; the two questions went as one.
    assert state["sent"][1:] == [{"role": "user", "content": "q\n\ngo on"}]
    last = db.coll.rows["c1"]["messages"][-1]
    assert last["content"] == "Half" and last["stopped"] is True and "error" not in last

    async def nothing(messages, **kw):
        raise asyncio.CancelledError
        yield {}

    monkeypatch.setattr(llm, "stream", nothing)
    events(cc_chat.say("c1", cc_chat.SayIn(text="again")))
    last = db.coll.rows["c1"]["messages"][-1]
    assert last["content"] == "" and last["stopped"] and last["error"] == "stopped before the answer began"
