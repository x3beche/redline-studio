"""Whose data this is: every read and write through one workspace.

The routes do not ask the database directly. `main.db()` hands them a
`ScopedDb` for the workspace of the request, and every collection that
belongs to a workspace comes back wrapped: a find sees only that
workspace's documents, an insert is stamped with it, an aggregation starts
by keeping to it. Collections that belong to the machine or to everyone -
the LCSC parts cache, machine samples, API timings, the stored files -
pass through unchanged.

There is one workspace to start with, "default", and it is today's data:
a document written before workspaces existed has no `workspace_id` and
counts as the default workspace's, so nothing had to be migrated. New
documents are written with one. Another workspace sees only its own.

The workspace of the request is a context variable, set from the session
or the agent's token; in local mode it is "default". Names that must be
unique (a board called `controller`) are unique per workspace - see `Ids`.
"""

from __future__ import annotations

import contextvars
from typing import Any

DEFAULT = "default"

# What belongs to a workspace. Everything else is the machine's, or shared.
SCOPED = frozenset({
    "models", "folders", "uploads", "revisions", "runs", "chat", "questions",
    "activity", "boards", "apps", "settings", "board_runs", "item_history",
    "weekly_reports", "audit", "compute_jobs", "analytics", "scratch", "notes", "releases", "source_blobs",
    "tool_usage", "tool_data",
})

WORKSPACE: contextvars.ContextVar[str] = contextvars.ContextVar("workspace", default=DEFAULT)


def current() -> str:
    return WORKSPACE.get()


def keep_to(ws: str) -> dict:
    """The filter that keeps a query to one workspace."""
    if ws == DEFAULT:
        return {"$or": [{"workspace_id": DEFAULT}, {"workspace_id": {"$exists": False}}]}
    return {"workspace_id": ws}


def within(query: dict | None, ws: str) -> dict:
    query = query or {}
    return {"$and": [query, keep_to(ws)]} if query else keep_to(ws)


def key(base: str, ws: str | None = None) -> str:
    """An id that exists once per workspace - the settings document, a
    room's current run. The default workspace keeps the id it always had."""
    ws = ws or current()
    return base if ws == DEFAULT else f"{base}@{ws}"


class Ids:
    """Names that exist once per workspace.

    Most documents are named by what they are - the board `controller`,
    the model `iot-fan/station` - and a name is unique in the whole
    database. So that two workspaces can both have a `controller`, a
    workspace other than the default one keeps its names with its own
    suffix in the database (`controller@team2`): added here on the way in,
    taken off on the way out, so the code above never sees it. The default
    workspace's names are left exactly as they were. Only text names get
    one; generated ids (ObjectId) are unique already.
    """

    def __init__(self, ws: str):
        self.suffix = None if ws == DEFAULT else "@" + ws

    def inn(self, v: Any) -> Any:
        return v + self.suffix if self.suffix and isinstance(v, str) else v

    def out(self, v: Any) -> Any:
        if self.suffix and isinstance(v, str) and v.endswith(self.suffix):
            return v[:-len(self.suffix)]
        return v

    def query(self, q: Any) -> Any:
        """A filter with its names in the database's form."""
        if not self.suffix or not isinstance(q, dict):
            return q
        out = {}
        for k, v in q.items():
            if k in ("$and", "$or", "$nor") and isinstance(v, list):
                out[k] = [self.query(x) for x in v]
            elif k == "_id":
                if isinstance(v, dict) and any(op.startswith("$") for op in v):
                    out[k] = {op: ([self.inn(x) for x in a] if isinstance(a, (list, tuple)) else self.inn(a))
                              for op, a in v.items()}
                else:
                    out[k] = self.inn(v)
            else:
                out[k] = v
        return out

    def doc_in(self, doc: dict) -> dict:
        if self.suffix and "_id" in doc:
            doc = {**doc, "_id": self.inn(doc["_id"])}
        return doc

    def doc_out(self, doc: Any) -> Any:
        if self.suffix and isinstance(doc, dict) and "_id" in doc:
            doc["_id"] = self.out(doc["_id"])
        return doc

    def pipeline(self, stages: list) -> list:
        return [{**st, "$match": self.query(st["$match"])} if isinstance(st, dict) and "$match" in st else st
                for st in stages] if self.suffix else stages


class _Cursor:
    """A cursor whose documents come back with their names as the code
    knows them."""

    def __init__(self, cur, ids: Ids):
        self._cur, self._ids = cur, ids

    def sort(self, *a, **kw):
        self._cur = self._cur.sort(*a, **kw)
        return self

    def limit(self, *a, **kw):
        self._cur = self._cur.limit(*a, **kw)
        return self

    def skip(self, *a, **kw):
        self._cur = self._cur.skip(*a, **kw)
        return self

    async def to_list(self, *a, **kw):
        return [self._ids.doc_out(d) for d in await self._cur.to_list(*a, **kw)]

    def __aiter__(self):
        async def gen():
            async for d in self._cur:
                yield self._ids.doc_out(d)
        return gen()

    def __getattr__(self, name: str):
        return getattr(self._cur, name)


class _Result:
    """A write's result with the new document's name as the code gave it."""

    def __init__(self, res, ids: Ids):
        self._res, self._ids = res, ids

    @property
    def inserted_id(self):
        return self._ids.out(self._res.inserted_id)

    @property
    def inserted_ids(self):
        return [self._ids.out(i) for i in self._res.inserted_ids]

    @property
    def upserted_id(self):
        return self._ids.out(self._res.upserted_id)

    def __getattr__(self, name: str):
        return getattr(self._res, name)


class ScopedCollection:
    """A collection seen from one workspace."""

    def __init__(self, coll, ws: str):
        self._c, self._ws = coll, ws
        self._ids = Ids(ws)

    def _q(self, filter: dict | None) -> dict:
        return within(self._ids.query(filter), self._ws)

    def _wrap(self, res):
        return _Result(res, self._ids) if self._ids.suffix else res

    # reads
    def find(self, filter: dict | None = None, *args, **kw):
        cur = self._c.find(self._q(filter), *args, **kw)
        return _Cursor(cur, self._ids) if self._ids.suffix else cur

    async def find_one(self, filter: dict | None = None, *args, **kw):
        return self._ids.doc_out(await self._c.find_one(self._q(filter), *args, **kw))

    async def count_documents(self, filter: dict | None = None, **kw):
        return await self._c.count_documents(self._q(filter), **kw)

    async def distinct(self, key: str, filter: dict | None = None, **kw):
        got = await self._c.distinct(key, self._q(filter), **kw)
        return [self._ids.out(v) for v in got] if key == "_id" and self._ids.suffix else got

    def aggregate(self, pipeline: list, *args, **kw):
        cur = self._c.aggregate([{"$match": keep_to(self._ws)}, *self._ids.pipeline(pipeline)], *args, **kw)
        return _Cursor(cur, self._ids) if self._ids.suffix else cur

    # writes
    def _stamp(self, doc: dict) -> dict:
        # Always this workspace's: a document cannot be written into another.
        doc["workspace_id"] = self._ws
        return doc

    async def insert_one(self, doc: dict, *args, **kw):
        if not self._ids.suffix:
            return await self._c.insert_one(self._stamp(doc), *args, **kw)
        stored = self._stamp(self._ids.doc_in(dict(doc)))
        res = await self._c.insert_one(stored, *args, **kw)
        doc.setdefault("_id", self._ids.out(stored["_id"]))
        doc["workspace_id"] = self._ws
        return self._wrap(res)

    async def insert_many(self, docs, *args, **kw):
        if not self._ids.suffix:
            return await self._c.insert_many([self._stamp(d) for d in docs], *args, **kw)
        docs = list(docs)
        stored = [self._stamp(self._ids.doc_in(dict(d))) for d in docs]
        res = await self._c.insert_many(stored, *args, **kw)
        for d, s in zip(docs, stored):
            d.setdefault("_id", self._ids.out(s["_id"]))
        return self._wrap(res)

    def _upsert(self, update: Any, kw: dict) -> Any:
        """An update cannot move a document to another workspace; one that
        inserts (upsert) stamps it with this one."""
        if isinstance(update, list):
            # An update pipeline: whatever it does, it ends in this workspace.
            return [*update, {"$set": {"workspace_id": self._ws}}]
        if not isinstance(update, dict) or not any(k.startswith("$") for k in update):
            return update
        update = {op: ({k: v for k, v in fields.items()
                        if k != "workspace_id" and not (op == "$rename" and v == "workspace_id")}
                       if isinstance(fields, dict) else fields)
                  for op, fields in update.items()}
        if kw.get("upsert"):
            update["$setOnInsert"] = {**(update.get("$setOnInsert") or {}), "workspace_id": self._ws}
        return {op: fields for op, fields in update.items() if fields != {} or op == "$setOnInsert"}

    async def update_one(self, filter: dict, update, *args, **kw):
        return self._wrap(await self._c.update_one(self._q(filter), self._upsert(update, kw), *args, **kw))

    async def update_many(self, filter: dict, update, *args, **kw):
        return self._wrap(await self._c.update_many(self._q(filter), self._upsert(update, kw), *args, **kw))

    async def replace_one(self, filter: dict, doc: dict, *args, **kw):
        return self._wrap(await self._c.replace_one(self._q(filter), self._stamp(self._ids.doc_in(dict(doc))),
                                                    *args, **kw))

    async def find_one_and_update(self, filter: dict, update, *args, **kw):
        return self._ids.doc_out(await self._c.find_one_and_update(self._q(filter),
                                                                   self._upsert(update, kw), *args, **kw))

    async def find_one_and_replace(self, filter: dict, doc: dict, *args, **kw):
        return self._ids.doc_out(await self._c.find_one_and_replace(
            self._q(filter), self._stamp(self._ids.doc_in(dict(doc))), *args, **kw))

    async def find_one_and_delete(self, filter: dict, *args, **kw):
        return self._ids.doc_out(await self._c.find_one_and_delete(self._q(filter), *args, **kw))

    async def delete_one(self, filter: dict, *args, **kw):
        return await self._c.delete_one(self._q(filter), *args, **kw)

    async def delete_many(self, filter: dict, *args, **kw):
        return await self._c.delete_many(self._q(filter), *args, **kw)

    def __getattr__(self, name: str):
        # Indexes, options and anything else that is not a read or a write.
        return getattr(self._c, name)


class ScopedDb:
    """A database seen from one workspace; `raw` is the database itself,
    for what must see all of it (stored files, and nothing in a route)."""

    SCOPED = True        # store.bucket() asks this of the class

    def __init__(self, raw, ws: str):
        self.raw, self.workspace = raw, ws

    def __getitem__(self, name: str):
        c = self.raw[name]
        return ScopedCollection(c, self.workspace) if name in SCOPED else c

    def __getattr__(self, name: str):
        if name in SCOPED:
            return ScopedCollection(self.raw[name], self.workspace)
        return getattr(self.raw, name)
