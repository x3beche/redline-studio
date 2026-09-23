"""A question is the agent standing still, so the rules are about not losing it.

No database here: the collection is a dict with the four methods the module
actually calls. What is worth testing is the state machine - a question is
answered once, an empty answer is not an answer, and a question that was
withdrawn cannot be answered afterwards.
"""

import asyncio

from backend import questions


class FakeCollection:
    """The handful of motor methods questions.py uses, over a dict."""

    def __init__(self):
        self.rows: dict[str, dict] = {}

    async def insert_one(self, doc):
        self.rows[doc["_id"]] = dict(doc)

    def find(self, query):
        want = query.get("status")
        rows = [dict(r) for r in self.rows.values()
                if want is None or r.get("status") == want]

        class Cursor:
            def __aiter__(self):
                async def gen():
                    for r in rows:
                        yield r
                return gen()

        return Cursor()

    async def find_one(self, query):
        row = self.rows.get(query["_id"])
        return dict(row) if row else None

    async def find_one_and_update(self, query, update, return_document=True):
        row = self.rows.get(query["_id"])
        if not row or any(row.get(k) != v for k, v in query.items()
                          if k != "_id"):
            return None
        row.update(update["$set"])
        return dict(row)

    async def update_one(self, query, update):
        row = self.rows.get(query["_id"])
        ok = row is not None and all(row.get(k) == v for k, v in query.items()
                                     if k != "_id")
        if ok:
            row.update(update["$set"])

        class Res:
            modified_count = 1 if ok else 0

        return Res()


class FakeDb:
    def __init__(self):
        self.col = FakeCollection()

    def __getitem__(self, name):
        assert name == questions.QUESTIONS
        return self.col


def run(coro):
    return asyncio.run(coro)


def test_a_question_starts_open_and_carries_what_was_asked():
    db = FakeDb()
    q = run(questions.ask(db, "  Which process?  ",
                          options=["FDM", " ", "SLA"],
                          context=" five fits are too tight ",
                          revision="rev1"))
    assert q["status"] == questions.OPEN
    assert q["text"] == "Which process?"          # trimmed
    assert q["options"] == ["FDM", "SLA"]         # the blank one is dropped
    assert q["context"] == "five fits are too tight"
    assert q["revision"] == "rev1"
    assert q["answer"] is None


def test_open_questions_come_back_oldest_first():
    db = FakeDb()
    a = run(questions.ask(db, "first"))
    b = run(questions.ask(db, "second"))
    db.col.rows[a["_id"]]["at"] = "2026-01-01T00:00:00+00:00"
    db.col.rows[b["_id"]]["at"] = "2026-01-02T00:00:00+00:00"
    rows = run(questions.open_questions(db))
    assert [r["text"] for r in rows] == ["first", "second"]


def test_answering_closes_it_and_it_leaves_the_open_list():
    db = FakeDb()
    q = run(questions.ask(db, "Which process?"))
    got = run(questions.answer(db, q["_id"], " FDM, 0.4 mm nozzle "))
    assert got["answer"] == "FDM, 0.4 mm nozzle"
    assert got["status"] == questions.ANSWERED
    assert got["answered_at"]
    assert run(questions.open_questions(db)) == []


def test_an_empty_answer_is_not_an_answer():
    """Otherwise a stray click unblocks the agent with nothing to go on."""
    db = FakeDb()
    q = run(questions.ask(db, "Which process?"))
    assert run(questions.answer(db, q["_id"], "   ")) is None
    assert run(questions.get(db, q["_id"]))["status"] == questions.OPEN


def test_a_question_cannot_be_answered_twice():
    db = FakeDb()
    q = run(questions.ask(db, "Which process?"))
    assert run(questions.answer(db, q["_id"], "FDM"))
    assert run(questions.answer(db, q["_id"], "SLA")) is None
    assert run(questions.get(db, q["_id"]))["answer"] == "FDM"


def test_a_withdrawn_question_disappears_and_stays_unanswerable():
    """The agent gave up waiting; an answer typed afterwards goes nowhere."""
    db = FakeDb()
    q = run(questions.ask(db, "Which process?"))
    assert run(questions.drop(db, q["_id"])) is True
    assert run(questions.open_questions(db)) == []
    assert run(questions.answer(db, q["_id"], "FDM")) is None
    assert run(questions.drop(db, q["_id"])) is False


def test_answering_something_that_was_never_asked_fails_quietly():
    db = FakeDb()
    assert run(questions.answer(db, "nope", "FDM")) is None
    assert run(questions.get(db, "nope")) is None
