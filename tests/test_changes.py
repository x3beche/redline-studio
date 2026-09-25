"""What a note changed is kept: the sources when the agent started, and
when it finished."""
import asyncio

from backend import changes
from tests.test_scope import Coll, world  # noqa: F401  (the small stand-in database)


class DB(dict):
    def __getattr__(self, k):
        return self[k]


class Blobs(Coll):
    async def distinct(self, key, q=None, **k):
        return [r[key] for r in self.rows if not q or r["_id"] in q["_id"]["$in"]]

    async def insert_many(self, docs, *a, **k):
        self.rows += [dict(d) for d in docs]


class Models(Coll):
    def find(self, q=None, *a, **k):
        import re
        pat = (q or {}).get("_id", {}).get("$regex")
        from tests.test_scope import Cursor
        return Cursor([dict(r) for r in self.rows if not pat or re.match(pat, r["_id"])])


class Revs(Coll):
    async def update_one(self, q, update, upsert=False, **k):
        for r in self.rows:
            if r["_id"] == q["_id"]:
                r.update(update["$set"])


def run(c):
    return asyncio.run(c)


def test_a_note_keeps_what_it_changed():
    db = DB(models=Models([{"_id": "fan/stand", "source": "a = 1\nb = 2\n"},
                           {"_id": "fan/base", "source": "x = 1\n"},
                           {"_id": "other/thing", "source": "untouched\n"}]),
            boards=Models([]), source_blobs=Blobs([]),
            revisions=Revs([{"_id": "r1", "model": "fan/stand", "kind": "cad"}]))
    run(changes.started(db, "r1"))
    assert set(db.revisions.rows[0]["changes_base"]) == {"model:fan/stand", "model:fan/base"}   # its project only
    db.models.rows[0]["source"] = "a = 1\nb = 3\nc = 4\n"                                          # the agent's work
    got = run(changes.finished(db, "r1"))
    assert [(c["id"], c["added"], c["removed"]) for c in got] == [("fan/stand", 2, 1)]
    blobs = {r["_id"] for r in db.source_blobs.rows}
    assert got[0]["before"] in blobs and got[0]["after"] in blobs                                  # both texts kept


def test_counting_lines():
    assert changes._counts("a\nb\n", "a\nc\nd\n") == (2, 1)
    assert changes._counts("same\n", "same\n") == (0, 0)
