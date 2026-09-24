"""The line to the agent.

What matters is that nothing said is lost and nothing is picked up twice:
the agent's idle wait returns on an unread line, so a line that stays
unread for ever would wake it in a loop, and one marked read too early
would never wake it at all.
"""

import asyncio

from backend import chat


class FakeCollection:
    def __init__(self):
        self.rows: dict[str, dict] = {}

    async def insert_one(self, doc):
        self.rows[doc["_id"]] = dict(doc)

    def find(self, query):
        def match(r):
            return all(r.get(k) == v for k, v in query.items())
        rows = [dict(r) for r in self.rows.values() if match(r)]

        class Cursor:
            def __aiter__(self):
                async def gen():
                    for r in rows:
                        yield r
                return gen()

        return Cursor()

    async def update_many(self, query, update):
        ids = query["_id"]["$in"]
        rest = {k: v for k, v in query.items() if k != "_id"}
        n = 0
        for i in ids:
            row = self.rows.get(i)
            if row and all(row.get(k) == v for k, v in rest.items()):
                row.update(update["$set"])
                n += 1

        class Res:
            modified_count = n

        return Res()

    async def delete_one(self, query):
        row = self.rows.get(query["_id"])
        ok = row is not None and all(row.get(k) == v for k, v in query.items()
                                     if k != "_id")
        if ok:
            del self.rows[query["_id"]]

        class Res:
            deleted_count = 1 if ok else 0

        return Res()

    async def delete_many(self, _query):
        n = len(self.rows)
        self.rows.clear()

        class Res:
            deleted_count = n

        return Res()


class FakeDb:
    def __init__(self):
        self.col = FakeCollection()

    def __getitem__(self, name):
        assert name == chat.CHAT
        return self.col


def run(coro):
    return asyncio.run(coro)


def test_what_the_person_says_waits_to_be_picked_up():
    db = FakeDb()
    said = run(chat.post(db, "  tidy the Fan folder  "))
    assert said["role"] == chat.USER
    assert said["text"] == "tidy the Fan folder"        # trimmed
    assert said["seen_at"] is None
    assert [r["_id"] for r in run(chat.unread(db))] == [said["_id"]]


def test_the_agent_reading_it_stops_it_waking_the_agent_again():
    """The idle wait returns on an unread line; one that stays unread for
    ever would bring it back in a loop."""
    db = FakeDb()
    said = run(chat.post(db, "tidy the Fan folder"))
    assert run(chat.mark_seen(db, [said["_id"]])) == 1
    assert run(chat.unread(db)) == []
    # Marking it again changes nothing, so a second read is harmless.
    assert run(chat.mark_seen(db, [said["_id"]])) == 0


def test_the_agents_own_words_never_wake_it():
    db = FakeDb()
    run(chat.post(db, "done, assembly moved out", role=chat.AGENT))
    assert run(chat.unread(db)) == []


def test_an_empty_line_is_not_a_message():
    db = FakeDb()
    for blank in ("", "   ", "\n\t"):
        try:
            run(chat.post(db, blank))
        except ValueError:
            continue
        raise AssertionError(f"{blank!r} was accepted")
    assert run(chat.history(db)) == []


def test_the_thread_reads_oldest_first_whatever_order_it_was_written_in():
    db = FakeDb()
    a = run(chat.post(db, "first"))
    b = run(chat.post(db, "second", role=chat.AGENT))
    db.col.rows[a["_id"]]["at"] = "2026-01-02T00:00:00+00:00"
    db.col.rows[b["_id"]]["at"] = "2026-01-01T00:00:00+00:00"
    assert [m["text"] for m in run(chat.history(db))] == ["second", "first"]


def test_a_long_thread_comes_back_ending_at_the_newest():
    """The card shows the end of the conversation, not the start of it."""
    db = FakeDb()
    for i in range(12):
        m = run(chat.post(db, f"line {i}"))
        db.col.rows[m["_id"]]["at"] = f"2026-01-01T00:00:{i:02d}+00:00"
    tail = run(chat.history(db, limit=5))
    assert [m["text"] for m in tail] == [f"line {i}" for i in range(7, 12)]


def test_marking_nothing_is_not_an_error():
    assert run(chat.mark_seen(FakeDb(), [])) == 0


# ---------------- taking it back ----------------
def test_an_unread_message_can_be_taken_back():
    db = FakeDb()
    said = run(chat.post(db, "tidy the Fan folder"))
    assert run(chat.retract(db, said["_id"])) is True
    assert run(chat.history(db)) == []


def test_once_the_agent_has_it_it_cannot_be_taken_back():
    """By then the work may be half done, and an answer would be talking
    to a message that is no longer there."""
    db = FakeDb()
    said = run(chat.post(db, "tidy the Fan folder"))
    run(chat.mark_seen(db, [said["_id"]]))
    assert run(chat.retract(db, said["_id"])) is False
    assert len(run(chat.history(db))) == 1


def test_the_agents_own_words_cannot_be_taken_back_from_the_page():
    db = FakeDb()
    mine = run(chat.post(db, "done", role=chat.AGENT))
    assert run(chat.retract(db, mine["_id"])) is False


def test_taking_back_something_that_is_not_there():
    assert run(chat.retract(FakeDb(), "nope")) is False


# ---------------- urgent ----------------
def test_urgent_is_a_kind_of_message_not_a_different_channel():
    db = FakeDb()
    said = run(chat.post(db, "wrong model", urgent=True))
    assert said["urgent"] is True
    assert [m["_id"] for m in run(chat.interrupts(db))] == [said["_id"]]
    # and it is still an ordinary unread line, so the idle wait sees it too
    assert [m["_id"] for m in run(chat.unread(db))] == [said["_id"]]


def test_an_ordinary_line_is_not_urgent():
    db = FakeDb()
    run(chat.post(db, "when you get a moment"))
    assert run(chat.interrupts(db)) == []


def test_reading_the_thread_quiets_an_urgent_line():
    """It is printed by every command until somebody has read it; one that
    stayed loud after being read would drown out the next one."""
    db = FakeDb()
    said = run(chat.post(db, "wrong model", urgent=True))
    run(chat.mark_seen(db, [said["_id"]]))
    assert run(chat.interrupts(db)) == []


def test_the_agent_cannot_mark_its_own_words_urgent():
    db = FakeDb()
    mine = run(chat.post(db, "on it", role=chat.AGENT, urgent=True))
    assert mine["urgent"] is False
    assert run(chat.interrupts(db)) == []


def test_each_room_has_its_own_thread():
    db = FakeDb()
    run(chat.post(db, "about the fan", room="cad"))
    run(chat.post(db, "about the board", room="pcb"))
    run(chat.post(db, "on it", role=chat.AGENT, room="pcb"))
    assert [m["text"] for m in run(chat.history(db, room="pcb"))] == ["about the board", "on it"]
    assert [m["text"] for m in run(chat.history(db, room="cad"))] == ["about the fan"]
    assert len(run(chat.history(db))) == 3
    assert [m["text"] for m in run(chat.unread(db, "pcb"))] == ["about the board"]


def test_rows_from_before_rooms_are_the_3d_rooms():
    db = FakeDb()
    run(db[chat.CHAT].insert_one({"_id": "old", "at": "2026-01-01", "role": "user",
                                  "text": "old line", "seen_at": None}))
    assert [m["_id"] for m in run(chat.history(db, room="cad"))] == ["old"]
    assert run(chat.history(db, room="pcb")) == []


def test_an_answer_goes_where_the_person_last_spoke():
    db = FakeDb()
    run(chat.post(db, "about the fan", room="cad"))
    run(chat.post(db, "about the board", room="pcb"))
    assert run(chat.last_room(db)) == "pcb"


def test_no_such_room():
    import pytest
    with pytest.raises(ValueError):
        run(chat.post(FakeDb(), "hi", room="kitchen"))
