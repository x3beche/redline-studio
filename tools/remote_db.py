"""The database, reached through the API instead of directly.

`tools/revisions.py` and the backend code it calls talk to what they think
is a Motor database: `db.revisions.find_one(...)`, `db["runs"].update_one`,
cursors with `.sort()` and `async for`, GridFS buckets through
`store.bucket()`. With `X3_TRANSPORT=api` they get this instead - the same
surface, but every operation is one request to the server's
`/api/agent/db` (and `/api/agent/files/...` for stored files), carrying the
agent's token (`X3_TOKEN`).

So an agent needs no MongoDB connection string: the server holds it, and
applies the workspace, the agent's name and the audit trail to everything
the agent does. Values cross as MongoDB extended JSON, so dates and ids
arrive as they left.
"""

from __future__ import annotations

import os
from types import SimpleNamespace
from typing import Any

import httpx
from bson import json_util


class Remote:
    def __init__(self, base: str, token: str | None):
        self.base = base.rstrip("/")
        headers = {"content-type": "application/json", "X-Redline-CSRF": "1"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        # The command line is always an agent - named by X3_AGENT, or plain
        # "agent". With a token the server takes the name from the token.
        name = os.environ.get("X3_AGENT", "").strip() or "agent"
        headers["X-Redline-Actor"] = f"agent:{name}"
        self.client = httpx.AsyncClient(base_url=self.base, headers=headers, timeout=600)

    async def call(self, coll: str, op: str, **args) -> Any:
        body = json_util.dumps({"coll": coll, "op": op, "args": args})
        r = await self.client.post("/api/agent/db", content=body)
        if r.status_code == 401:
            raise SystemExit(f"{self.base} wants an agent token: set X3_TOKEN to one made under "
                             "your name in the app (user menu > Agent tokens)")
        if r.status_code >= 400:
            raise RuntimeError(f"{op} on {coll}: {r.status_code} {r.text[:300]}")
        return json_util.loads(r.text)["result"]


class Cursor:
    """A find or an aggregation, run when it is read."""

    def __init__(self, remote: Remote, coll: str, op: str, args: dict):
        self._r, self._coll, self._op, self._args = remote, coll, op, args

    def sort(self, key, direction: int = 1):
        self._args["sort"] = key if isinstance(key, list) else [[key, direction]]
        return self

    def limit(self, n: int):
        self._args["limit"] = n
        return self

    def skip(self, n: int):
        self._args["skip"] = n
        return self

    async def to_list(self, length: int | None = None):
        rows = await self._r.call(self._coll, self._op, **self._args)
        return rows if length is None else rows[:length]

    def __aiter__(self):
        async def gen():
            for row in await self.to_list(None):
                yield row
        return gen()


def _result(d: dict) -> SimpleNamespace:
    return SimpleNamespace(**d)


class Collection:
    def __init__(self, remote: Remote, name: str):
        self._r, self.name = remote, name

    def find(self, filter: dict | None = None, projection: dict | None = None, **kw):
        return Cursor(self._r, self.name, "find", {"filter": filter or {}, "projection": projection,
                                                   **{k: v for k, v in kw.items() if k in ("sort", "limit", "skip")}})

    def aggregate(self, pipeline: list, **kw):
        return Cursor(self._r, self.name, "aggregate", {"pipeline": pipeline})

    async def find_one(self, filter: dict | None = None, projection: dict | None = None, **kw):
        return await self._r.call(self.name, "find_one", filter=filter or {}, projection=projection,
                                  sort=kw.get("sort"))

    async def count_documents(self, filter: dict | None = None, **kw):
        return await self._r.call(self.name, "count_documents", filter=filter or {})

    async def distinct(self, key: str, filter: dict | None = None, **kw):
        return await self._r.call(self.name, "distinct", key=key, filter=filter or {})

    async def insert_one(self, doc: dict, **kw):
        got = await self._r.call(self.name, "insert_one", doc=doc)
        doc.setdefault("_id", got["inserted_id"])
        return _result(got)

    async def insert_many(self, docs: list, **kw):
        return _result(await self._r.call(self.name, "insert_many", docs=list(docs)))

    async def update_one(self, filter: dict, update: dict, upsert: bool = False, **kw):
        return _result(await self._r.call(self.name, "update_one", filter=filter, update=update, upsert=upsert))

    async def update_many(self, filter: dict, update: dict, upsert: bool = False, **kw):
        return _result(await self._r.call(self.name, "update_many", filter=filter, update=update, upsert=upsert))

    async def replace_one(self, filter: dict, doc: dict, upsert: bool = False, **kw):
        return _result(await self._r.call(self.name, "replace_one", filter=filter, doc=doc, upsert=upsert))

    async def delete_one(self, filter: dict, **kw):
        return _result(await self._r.call(self.name, "delete_one", filter=filter))

    async def delete_many(self, filter: dict, **kw):
        return _result(await self._r.call(self.name, "delete_many", filter=filter))

    async def find_one_and_update(self, filter: dict, update: dict, upsert: bool = False,
                                  return_document: Any = False, projection: dict | None = None, **kw):
        return await self._r.call(self.name, "find_one_and_update", filter=filter, update=update,
                                  upsert=upsert, after=bool(return_document), projection=projection)

    async def create_index(self, *a, **kw):
        return None          # the server keeps its own indexes


class Bucket:
    """GridFS, as store.bucket() uses it: put, get, delete."""

    def __init__(self, remote: Remote, name: str):
        self._r, self.name = remote, name

    async def upload_from_stream(self, filename: str, data: bytes, **kw):
        r = await self._r.client.post(f"/api/agent/files/{self.name}", params={"filename": filename},
                                      content=data, headers={"content-type": "application/octet-stream"})
        if r.status_code >= 400:
            raise RuntimeError(f"upload to {self.name}: {r.status_code} {r.text[:300]}")
        return json_util.loads(r.text)["id"]

    async def open_download_stream(self, file_id):
        r = await self._r.client.get(f"/api/agent/files/{self.name}/{file_id}")
        if r.status_code >= 400:
            raise RuntimeError(f"download from {self.name}: {r.status_code}")
        data = r.content

        class Stream:
            async def read(self, size: int = -1):
                return data
        return Stream()

    async def delete(self, file_id):
        r = await self._r.client.delete(f"/api/agent/files/{self.name}/{file_id}")
        if r.status_code >= 400 and r.status_code != 404:
            raise RuntimeError(f"delete from {self.name}: {r.status_code}")


class RemoteDb:
    """What connect() returns with X3_TRANSPORT=api."""

    REMOTE = True        # store.bucket() asks this of the class

    def __init__(self, base: str, token: str | None):
        self._r = Remote(base, token)
        self.name = "remote"

    def __getitem__(self, name: str) -> Collection:
        return Collection(self._r, name)

    def __getattr__(self, name: str) -> Collection:
        if name.startswith("_"):
            raise AttributeError(name)
        return Collection(self._r, name)

    def gridfs(self, bucket: str) -> Bucket:
        return Bucket(self._r, bucket)

    async def command(self, name: str, *args, **kw):
        return await self._r.call("", "command", name=name, arg=args[0] if args else None)

    async def list_collection_names(self):
        return await self._r.call("", "list_collection_names")
