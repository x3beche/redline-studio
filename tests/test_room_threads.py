"""The rooms' agent threads as the Chat tab lists them.

The old "ask the agent" box under the queue is gone; each room's thread is
a pinned entry at the top of the Chat tab instead. What the list needs from
the server is one call that says, for every room, how long the thread is,
its last line, what the person said that the agent has not picked up, and
when the agent wrote - so the page can count what is unread - and the
questions tagged with the room whose thread they belong in.
"""

import asyncio

from backend import chat, questions
from tests.test_chat import FakeDb


def run(coro):
    return asyncio.run(coro)


def test_every_room_is_listed_even_with_an_empty_thread():
    rows = run(chat.rooms(FakeDb()))
    assert [r["room"] for r in rows] == list(chat.ROOMS)
    assert all(r["count"] == 0 and r["last"] is None and r["agent_at"] == [] for r in rows)


def test_a_room_says_its_last_line_what_waits_and_when_the_agent_wrote():
    db = FakeDb()
    a = run(chat.post(db, "rename the bracket", room="cad"))
    b = run(chat.post(db, "done", role=chat.AGENT, room="cad"))
    c = run(chat.post(db, "stop the build", urgent=True, room="cad"))
    run(chat.post(db, "route the USB pair", room="pcb"))
    for m, at in ((a, "01"), (b, "02"), (c, "03")):
        db.col.rows[m["_id"]]["at"] = f"2026-01-01T00:00:{at}+00:00"
    run(chat.mark_seen(db, [a["_id"]]))
    cad, pcb, fw = run(chat.rooms(db))
    assert fw["room"] == "firmware" and fw["count"] == 0
    assert cad["count"] == 3 and pcb["count"] == 1
    assert cad["last"]["text"] == "stop the build" and cad["last"]["role"] == chat.USER
    assert cad["waiting"] == 1 and cad["urgent"] == 1
    assert cad["agent_at"] == ["2026-01-01T00:00:02+00:00"]
    assert pcb["waiting"] == 1 and pcb["agent_at"] == []


def test_a_line_from_before_rooms_is_the_3d_rooms():
    db = FakeDb()
    m = run(chat.post(db, "old line"))
    del db.col.rows[m["_id"]]["room"]
    cad, pcb, fw = run(chat.rooms(db))
    assert fw["room"] == "firmware" and fw["count"] == 0
    assert cad["count"] == 1 and pcb["count"] == 0


class _Revs:
    def __init__(self, kinds):
        self.kinds = kinds

    async def find_one(self, query, _proj=None):
        k = self.kinds.get(query["_id"])
        return {"_id": query["_id"], "kind": k} if k else None


class _Db:
    def __init__(self, kinds):
        self.revs = _Revs(kinds)

    def __getitem__(self, name):
        assert name == "revisions"
        return self.revs


def test_a_question_goes_in_the_thread_of_the_room_its_note_is_in():
    rows = [{"_id": "q1", "revision": "r-board"}, {"_id": "q2", "revision": "r-model"},
            {"_id": "q3", "revision": None}, {"_id": "q4", "revision": "gone"}]
    out = run(questions.with_rooms(_Db({"r-board": "pcb", "r-model": "cad"}), rows))
    assert [q["room"] for q in out] == ["pcb", "cad", "cad", "cad"]
