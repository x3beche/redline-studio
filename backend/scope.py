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

The workspace of the request is a context variable; until sign-in exists
(docs/USERS-PLAN.md, phase 3) it is always "default".
"""

from __future__ import annotations

import contextvars
from typing import Any

DEFAULT = "default"

# What belongs to a workspace. Everything else is the machine's, or shared.
SCOPED = frozenset({
    "models", "folders", "uploads", "revisions", "runs", "chat", "questions",
    "activity", "boards", "apps", "settings", "board_runs", "item_history",
    "weekly_reports", "audit", "compute_jobs", "analytics", "scratch",
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


class ScopedCollection:
    """A collection seen from one workspace."""

    def __init__(self, coll, ws: str):
        self._c, self._ws = coll, ws

    # reads
    def find(self, filter: dict | None = None, *args, **kw):
        return self._c.find(within(filter, self._ws), *args, **kw)

    async def find_one(self, filter: dict | None = None, *args, **kw):
        return await self._c.find_one(within(filter, self._ws), *args, **kw)

    async def count_documents(self, filter: dict | None = None, **kw):
        return await self._c.count_documents(within(filter, self._ws), **kw)

    async def distinct(self, key: str, filter: dict | None = None, **kw):
        return await self._c.distinct(key, within(filter, self._ws), **kw)

    def aggregate(self, pipeline: list, *args, **kw):
        return self._c.aggregate([{"$match": keep_to(self._ws)}, *pipeline], *args, **kw)

    # writes
    def _stamp(self, doc: dict) -> dict:
        # Always this workspace's: a document cannot be written into another.
        doc["workspace_id"] = self._ws
        return doc

    async def insert_one(self, doc: dict, *args, **kw):
        return await self._c.insert_one(self._stamp(doc), *args, **kw)

    async def insert_many(self, docs, *args, **kw):
        return await self._c.insert_many([self._stamp(d) for d in docs], *args, **kw)

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
        return await self._c.update_one(within(filter, self._ws), self._upsert(update, kw), *args, **kw)

    async def update_many(self, filter: dict, update, *args, **kw):
        return await self._c.update_many(within(filter, self._ws), self._upsert(update, kw), *args, **kw)

    async def replace_one(self, filter: dict, doc: dict, *args, **kw):
        return await self._c.replace_one(within(filter, self._ws), self._stamp(dict(doc)), *args, **kw)

    async def find_one_and_update(self, filter: dict, update, *args, **kw):
        return await self._c.find_one_and_update(within(filter, self._ws),
                                                 self._upsert(update, kw), *args, **kw)

    async def find_one_and_replace(self, filter: dict, doc: dict, *args, **kw):
        return await self._c.find_one_and_replace(within(filter, self._ws), self._stamp(dict(doc)),
                                                  *args, **kw)

    async def find_one_and_delete(self, filter: dict, *args, **kw):
        return await self._c.find_one_and_delete(within(filter, self._ws), *args, **kw)

    async def delete_one(self, filter: dict, *args, **kw):
        return await self._c.delete_one(within(filter, self._ws), *args, **kw)

    async def delete_many(self, filter: dict, *args, **kw):
        return await self._c.delete_many(within(filter, self._ws), *args, **kw)

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
