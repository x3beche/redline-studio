"""Who did it: the person or an agent, and the trail of deletes and changes."""
import asyncio

from backend import actors, chat, questions


def test_the_header_names_the_agent_and_anything_else_is_the_person(monkeypatch):
    monkeypatch.setenv("X3_LOCAL_USER", "Emir")
    assert actors.from_header("agent:pcb") == {"type": "agent", "id": "pcb", "name": "pcb"}
    assert actors.from_header(None) == {"type": "user", "id": "local", "name": "Emir"}
    assert actors.from_header("someone")["type"] == "user"


def test_the_command_line_says_which_agent(monkeypatch):
    monkeypatch.setenv("X3_AGENT", "pcb room")
    assert actors.header_for_agent() == {"X-Redline-Actor": "agent:pcb room"}


def test_which_requests_go_in_the_trail():
    assert actors.audited("DELETE", "/api/boards/x") == "delete"
    assert actors.audited("PATCH", "/api/revisions/r?status=queued") == "change"
    assert actors.audited("PUT", "/api/settings") == "settings"
    assert actors.audited("PUT", "/api/boards/x/rules") == "settings"
    assert actors.audited("GET", "/api/boards") is None
    assert actors.audited("POST", "/api/revisions") is None
    assert actors.audited("DELETE", "/assets/x") is None


class Coll:
    def __init__(self):
        self.rows = []

    async def insert_one(self, doc):
        self.rows.append(dict(doc))

    async def find_one_and_update(self, query, update, return_document=True):
        return {**query, **update["$set"]}


class Db(dict):
    def __missing__(self, key):
        self[key] = Coll()
        return self[key]


def test_a_person_s_thread_line_and_an_agent_s_carry_who_wrote_them():
    db = Db()
    token = actors.CURRENT.set(actors.local_user())
    try:
        mine = asyncio.run(chat.post(db, "tidy the fan folder", room="cad"))
        theirs = asyncio.run(chat.post(db, "done", role=chat.AGENT, room="cad"))
    finally:
        actors.CURRENT.reset(token)
    assert mine["by"]["type"] == "user"
    assert theirs["by"]["type"] == "agent"


def test_questions_say_who_asked_and_who_answered():
    db = Db()
    token = actors.CURRENT.set(actors.agent("cad room"))
    try:
        q = asyncio.run(questions.ask(db, "which way?", ["a", "b"]))
    finally:
        actors.CURRENT.reset(token)
    assert q["asked_by"]["name"] == "cad room"
    token = actors.CURRENT.set(actors.local_user())
    try:
        got = asyncio.run(questions.answer(db, q["_id"], "a"))
    finally:
        actors.CURRENT.reset(token)
    assert got["answered_by"]["type"] == "user"


def test_the_trail_records_and_never_raises():
    db = Db()
    asyncio.run(actors.audit(db, "delete", "/api/boards/x", {"method": "DELETE"},
                             actor=actors.local_user()))
    row = db[actors.AUDIT].rows[0]
    assert row["action"] == "delete" and row["actor"]["id"] == "local"

    class Broken:
        def __getitem__(self, k):
            raise RuntimeError("down")
    asyncio.run(actors.audit(Broken(), "delete", "/api/x"))          # no exception
