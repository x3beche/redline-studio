"""Workspaces: one cannot see, change or delete another's data, the data from
before workspaces is the default one's, and no route reaches around it."""
import asyncio
import re
from pathlib import Path

from backend import scope

ROOT = Path(__file__).resolve().parent.parent


# ---- a small stand-in for a collection, enough for the filters scope writes

def matches(doc: dict, q: dict) -> bool:
    for k, v in q.items():
        if k == "$and":
            if not all(matches(doc, x) for x in v):
                return False
        elif k == "$or":
            if not any(matches(doc, x) for x in v):
                return False
        elif isinstance(v, dict) and "$exists" in v:
            if (k in doc) != v["$exists"]:
                return False
        elif isinstance(v, dict) and "$ne" in v:
            if doc.get(k) == v["$ne"]:
                return False
        elif doc.get(k) != v:
            return False
    return True


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def __aiter__(self):
        async def gen():
            for r in self.rows:
                yield r
        return gen()


class Coll:
    def __init__(self, rows=None):
        self.rows = [dict(r) for r in rows or []]

    def find(self, q=None, *a, **k):
        return Cursor([r for r in self.rows if matches(r, q or {})])

    async def find_one(self, q=None, *a, **k):
        return next((r for r in self.rows if matches(r, q or {})), None)

    async def count_documents(self, q=None, **k):
        return sum(1 for r in self.rows if matches(r, q or {}))

    async def insert_one(self, doc, *a, **k):
        self.rows.append(dict(doc))

    async def update_one(self, q, update, upsert=False, **k):
        for r in self.rows:
            if matches(r, q):
                r.update(update.get("$set", {}))
                return 1
        if upsert:
            # As MongoDB does: the equality fields of the query, including
            # those inside an $and, seed the new document.
            def equalities(x):
                out = {k: v for k, v in x.items() if not k.startswith("$") and not isinstance(v, dict)}
                for part in x.get("$and", []):
                    out.update(equalities(part))
                return out
            new = equalities(q)
            new.update(update.get("$set", {}))
            new.update(update.get("$setOnInsert", {}))
            self.rows.append(new)
        return 0

    async def delete_many(self, q, *a, **k):
        before = len(self.rows)
        self.rows = [r for r in self.rows if not matches(r, q)]
        return before - len(self.rows)

    def aggregate(self, pipeline, *a, **k):
        rows = self.rows
        for stage in pipeline:
            if "$match" in stage:
                rows = [r for r in rows if matches(r, stage["$match"])]
        return Cursor(rows)


def run(coro):
    return asyncio.run(coro)


def rows(cursor):
    async def go():
        return [r async for r in cursor]
    return run(go())


def world():
    raw = {"revisions": Coll([
        {"_id": "old", "comment": "from before workspaces"},
        {"_id": "a1", "comment": "a's note", "workspace_id": "a"},
        {"_id": "b1", "comment": "b's note", "workspace_id": "b"},
    ]), "parts": Coll([{"_id": "C1", "name": "shared part"}])}
    return raw


def test_the_data_from_before_workspaces_is_the_default_workspace_s():
    raw = world()
    d = scope.ScopedDb(raw, scope.DEFAULT)
    assert [r["_id"] for r in rows(d.revisions.find({}))] == ["old"]


def test_one_workspace_cannot_see_change_or_delete_another_s():
    raw = world()
    a = scope.ScopedDb(raw, "a")
    assert [r["_id"] for r in rows(a.revisions.find({}))] == ["a1"]
    assert run(a.revisions.find_one({"_id": "b1"})) is None                 # read
    assert run(a.revisions.count_documents({})) == 1
    assert [r["_id"] for r in rows(a.revisions.aggregate([]))] == ["a1"]    # aggregate
    run(a.revisions.update_one({"_id": "b1"}, {"$set": {"comment": "mine now"}}))
    assert next(r for r in raw["revisions"].rows if r["_id"] == "b1")["comment"] == "b's note"
    run(a.revisions.delete_many({}))                                        # delete all
    assert {r["_id"] for r in raw["revisions"].rows} == {"old", "b1"}


def test_what_a_workspace_writes_is_stamped_with_it():
    raw = world()
    b = scope.ScopedDb(raw, "b")
    run(b.revisions.insert_one({"_id": "b2"}))
    run(b.revisions.update_one({"_id": "b3"}, {"$set": {"comment": "upserted"}}, upsert=True))
    got = {r["_id"]: r.get("workspace_id") for r in raw["revisions"].rows}
    assert got["b2"] == "b" and got["b3"] == "b"


def test_what_belongs_to_everyone_passes_through():
    raw = world()
    a = scope.ScopedDb(raw, "a")
    assert a["parts"] is raw["parts"]
    assert run(a["parts"].count_documents({})) == 1


def test_ids_that_exist_once_per_workspace():
    assert scope.key("app", scope.DEFAULT) == "app"
    assert scope.key("current:pcb", "team2") == "current:pcb@team2"


# ---- no route reaches around the scope

ROUTE_MODULES = ["backend/main.py", "backend/code_api.py", "backend/tools_api.py"]


def test_no_route_module_reaches_the_database_around_the_scope():
    for rel in ROUTE_MODULES:
        text = (ROOT / rel).read_text()
        body = re.sub(r"def _raw_db\(\):.*?\n\n\n", "", text, flags=re.S)
        body = re.sub(r"def db\(\):.*?\n\n\n", "", body, flags=re.S)
        assert "_raw_db(" not in body, f"{rel} calls _raw_db() outside db()"
        assert "AsyncIOMotorClient(" not in body, f"{rel} opens its own client"
        assert "_client[" not in body, f"{rel} indexes the client directly"


def test_stored_files_reach_the_real_database_from_every_kind_of_db():
    """store.bucket() must get the database itself from a workspace view,
    and must not mistake a plain Motor database's attribute for one: on
    Motor, db.raw or db.gridfs is just a collection with that name."""
    from backend import store
    from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorGridFSBucket

    async def check():
        plain = AsyncIOMotorClient("mongodb://localhost:1", connect=False)["x"]
        assert isinstance(store.bucket(plain, "shots"), AsyncIOMotorGridFSBucket)
        assert isinstance(store.bucket(scope.ScopedDb(plain, "a"), "shots"), AsyncIOMotorGridFSBucket)
    asyncio.run(check())
