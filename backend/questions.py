"""Questions the agent needs answered before it can carry on.

An agent applying a revision sometimes hits a fork it has no business
choosing: which print process the part is for, whether a shaft is bought or
printed. Asked in a terminal, the question only reaches whoever is looking
at that terminal - and the person who drew the revision is looking at the
model in a browser.

So a question is a row in the database, the same as a revision. The agent
writes it and blocks; the page shows it, notifies, and writes the answer
back; the agent wakes up with the answer in hand. Nothing is asked twice
and nothing is lost when a terminal scrolls.

Options are a convenience, not a constraint: the form always takes free
text, because the answer to "which process?" is often "neither, and here is
why".
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

QUESTIONS = "questions"

OPEN, ANSWERED, DROPPED = "open", "answered", "dropped"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def ask(db, text: str, options: list[str] | None = None,
              revision: str | None = None, context: str | None = None,
              multi: bool = False) -> dict:
    """Write one question and return it. The agent then waits for an answer."""
    doc = {
        "_id": uuid.uuid4().hex[:12],
        "at": _now(),
        "text": text.strip(),
        # What the agent already knows, so the person is not made to
        # reconstruct the situation from one line.
        "context": (context or "").strip() or None,
        "options": [o.strip() for o in (options or []) if o.strip()],
        "multi": bool(multi),
        "revision": revision,
        "status": OPEN,
        "answer": None,
        "answered_at": None,
    }
    await db[QUESTIONS].insert_one(doc)
    return doc


async def open_questions(db) -> list[dict]:
    rows = [d async for d in db[QUESTIONS].find({"status": OPEN})]
    rows.sort(key=lambda d: d["at"])
    return rows


async def answer(db, qid: str, text: str) -> dict | None:
    """Record the answer. An empty answer is not an answer."""
    text = (text or "").strip()
    if not text:
        return None
    patch = {"answer": text, "status": ANSWERED, "answered_at": _now()}
    res = await db[QUESTIONS].find_one_and_update(
        {"_id": qid, "status": OPEN}, {"$set": patch},
        return_document=True)
    return res


async def drop(db, qid: str) -> bool:
    """Withdraw a question - the agent gave up waiting, or answered itself."""
    res = await db[QUESTIONS].update_one(
        {"_id": qid, "status": OPEN},
        {"$set": {"status": DROPPED, "answered_at": _now()}})
    return res.modified_count > 0


async def get(db, qid: str) -> dict | None:
    return await db[QUESTIONS].find_one({"_id": qid})
