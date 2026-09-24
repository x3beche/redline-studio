"""Workspaces: one cannot see, change or delete another's data, the data from
before workspaces is the default one's, and no route reaches around it."""
import asyncio
import re
import types
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
        elif isinstance(v, dict) and "$in" in v:
            if doc.get(k) not in v["$in"]:
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

    # Copies, as a database hands out: what the caller does to a document
    # it read does not change what is stored.
    def find(self, q=None, *a, **k):
        return Cursor([dict(r) for r in self.rows if matches(r, q or {})])

    async def find_one(self, q=None, *a, **k):
        return next((dict(r) for r in self.rows if matches(r, q or {})), None)

    async def count_documents(self, q=None, **k):
        return sum(1 for r in self.rows if matches(r, q or {}))

    async def insert_one(self, doc, *a, **k):
        self.rows.append(dict(doc))
        return types.SimpleNamespace(inserted_id=doc.get("_id"))

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
        # Stored as the database keeps them: a workspace's own names carry
        # its suffix (scope.Ids); the default workspace's do not.
        {"_id": "a1@a", "comment": "a's note", "workspace_id": "a"},
        {"_id": "b1@b", "comment": "b's note", "workspace_id": "b"},
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
    assert next(r for r in raw["revisions"].rows if r["_id"] == "b1@b")["comment"] == "b's note"
    run(a.revisions.delete_many({}))                                        # delete all
    assert {r["_id"] for r in raw["revisions"].rows} == {"old", "b1@b"}


def test_what_a_workspace_writes_is_stamped_with_it():
    raw = world()
    b = scope.ScopedDb(raw, "b")
    run(b.revisions.insert_one({"_id": "b2"}))
    run(b.revisions.update_one({"_id": "b3"}, {"$set": {"comment": "upserted"}}, upsert=True))
    got = {r["_id"]: r.get("workspace_id") for r in raw["revisions"].rows}
    assert got["b2@b"] == "b" and got["b3@b"] == "b"


def test_what_belongs_to_everyone_passes_through():
    raw = world()
    a = scope.ScopedDb(raw, "a")
    assert a["parts"] is raw["parts"]
    assert run(a["parts"].count_documents({})) == 1


def test_ids_that_exist_once_per_workspace():
    assert scope.key("app", scope.DEFAULT) == "app"
    assert scope.key("current:pcb", "team2") == "current:pcb@team2"


# ---- no route reaches around the scope

ROUTE_MODULES = ["backend/main.py", "backend/code_api.py", "backend/tools_api.py",
                 "backend/agent_api.py"]


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


def test_agents_cannot_reach_around_their_collections():
    """The agents' database way in refuses operators that read another
    collection, write elsewhere, or run code on the server."""
    from backend import agent_api
    assert agent_api._forbidden({"x": 1}) is None
    assert agent_api._forbidden({"pipeline": [{"$match": {}}, {"$lookup": {"from": "users"}}]}) == "$lookup"
    assert agent_api._forbidden({"pipeline": [{"$unionWith": "agent_tokens"}]}) == "$unionWith"
    assert agent_api._forbidden({"pipeline": [{"$merge": {"into": "users"}}]}) == "$merge"
    assert agent_api._forbidden({"filter": {"$and": [{"$where": "1"}]}}) == "$where"
    assert not {"users", "sessions", "agent_tokens", "memberships", "workspaces"} & agent_api.COLLECTIONS


def test_a_workspace_cannot_write_into_another():
    """Naming another workspace in the document or the update does nothing:
    what a workspace writes stays its own."""
    raw = world()
    b = scope.ScopedDb(raw, "b")
    run(b.revisions.insert_one({"_id": "planted", "workspace_id": "a"}))
    run(b.revisions.update_one({"_id": "b1"}, {"$set": {"workspace_id": "a", "comment": "moved?"}}))
    run(b.revisions.update_one({"_id": "b4"}, {"$set": {"workspace_id": "a"}, "$setOnInsert": {"workspace_id": "a"}},
                               upsert=True))
    got = {r["_id"]: r.get("workspace_id") for r in raw["revisions"].rows}
    assert got["planted@b"] == "b" and got["b1@b"] == "b" and got["b4@b"] == "b"
    assert next(r for r in raw["revisions"].rows if r["_id"] == "b1@b")["comment"] == "moved?"
    assert b.revisions._upsert({"$rename": {"x": "workspace_id"}}, {}) == {}
    assert b.revisions._upsert([{"$set": {"workspace_id": "a"}}], {})[-1] == {"$set": {"workspace_id": "b"}}


def test_two_workspaces_can_use_the_same_name():
    """A board called `controller` in each: two documents, each workspace
    sees its own under the plain name, and the default one's is untouched."""
    raw = {"boards": Coll([{"_id": "controller", "title": "default's"}])}
    t2 = scope.ScopedDb(raw, "team2")
    doc = {"_id": "controller", "title": "team2's"}
    res = run(t2.boards.insert_one(doc))
    assert res.inserted_id == "controller" and doc["_id"] == "controller"
    assert sorted(r["_id"] for r in raw["boards"].rows) == ["controller", "controller@team2"]
    got = run(t2.boards.find_one({"_id": "controller"}))
    assert got["_id"] == "controller" and got["title"] == "team2's"
    assert [r["_id"] for r in rows(t2.boards.find({"_id": {"$in": ["controller", "x"]}}))] == ["controller"]
    assert run(scope.ScopedDb(raw, scope.DEFAULT).boards.find_one({"_id": "controller"}))["title"] == "default's"
    run(t2.boards.update_one({"_id": "controller"}, {"$set": {"title": "changed"}}))
    assert next(r for r in raw["boards"].rows if r["_id"] == "controller")["title"] == "default's"
    run(t2.boards.delete_many({"_id": "controller"}))
    assert [r["_id"] for r in raw["boards"].rows] == ["controller"]


def test_the_default_workspace_s_names_are_untouched():
    ids = scope.Ids(scope.DEFAULT)
    q = {"_id": {"$in": ["a", "b"]}}
    assert ids.query(q) is q and ids.inn("a") == "a"
    t = scope.Ids("t")
    assert t.query({"$or": [{"_id": "a"}, {"x": 1}]}) == {"$or": [{"_id": "a@t"}, {"x": 1}]}
    assert t.pipeline([{"$match": {"_id": {"$nin": ["a"]}}}, {"$group": {"_id": "$m"}}]) == \
        [{"$match": {"_id": {"$nin": ["a@t"]}}}, {"$group": {"_id": "$m"}}]
    assert t.out("a@t") == "a" and t.out("a") == "a"
