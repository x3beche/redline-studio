"""The agents' way in: their database work, through the API.

`tools/revisions.py` with `REDLINE_TRANSPORT=api` (tools/remote_db.py) sends
each database operation here instead of to MongoDB. Every one runs on the
request's scoped database (backend/scope.py) - so an agent sees and writes
only its workspace - as the agent the token names (backend/actors.py), and
deletes go into the audit trail. Only the agents' own collections and the
operations the command line uses are allowed; the accounts, sessions and
tokens are not reachable at all.

A person's session cannot use this: it is for agents - a token in
`Authorization: Bearer`, or, in local mode, the X-Redline-Actor header.
"""

from __future__ import annotations

from bson import ObjectId, json_util
from fastapi import APIRouter, HTTPException, Request, Response

from . import access, actors, scope

router = APIRouter(prefix="/api/agent")

# What the command line reads and writes: the workspace's own collections,
# the LCSC parts cache, and the LLM-call log it fills from transcripts.
COLLECTIONS = frozenset(scope.SCOPED | {"parts", "llm_calls", "meta"}) - {"audit"}
# The LLM-call log and its cursor are the machine's, filled from the
# owner's transcripts: only the default space's agents reach them.
OWNER_ONLY = frozenset({"llm_calls", "meta"})
READ_ONLY = frozenset({"audit"})
OPS = frozenset({"find", "find_one", "count_documents", "distinct", "aggregate", "insert_one",
                 "insert_many", "update_one", "update_many", "replace_one", "delete_one",
                 "delete_many", "find_one_and_update"})
READS = frozenset({"find", "find_one", "count_documents", "distinct", "aggregate"})
COMMANDS = frozenset({"ping", "dbstats", "collstats"})
BUCKETS = frozenset({"shots", "model_files", "cad_files"})
# Operators that reach another collection, write somewhere else, or run
# code on the database server. The command line uses none of them.
FORBIDDEN = frozenset({"$lookup", "$graphLookup", "$unionWith", "$out", "$merge", "$where",
                       "$function", "$accumulator"})


def _forbidden(value) -> str | None:
    """The first forbidden operator anywhere in a filter, update or pipeline."""
    if isinstance(value, dict):
        for k, v in value.items():
            if k in FORBIDDEN:
                return k
            if (hit := _forbidden(v)):
                return hit
    elif isinstance(value, list):
        for v in value:
            if (hit := _forbidden(v)):
                return hit
    return None


def _db():
    from .main import db
    return db()


def _agent_only():
    if actors.current()["type"] != "agent":
        raise HTTPException(403, "this is the agents' way in; the page uses the other routes")


def _json(value) -> Response:
    return Response(json_util.dumps({"result": value}), media_type="application/json")


@router.post("/db")
async def agent_db(request: Request):
    _agent_only()
    from pymongo.errors import PyMongoError
    try:
        body = json_util.loads(await request.body())
        return await _run(body)
    except (ValueError, TypeError, KeyError, PyMongoError) as exc:
        # A malformed request, or one MongoDB refused (a duplicate id, an
        # empty update): the agent's mistake, said plainly.
        raise HTTPException(400, f"{type(exc).__name__}: {str(exc)[:300]}") from exc


async def _run(body: dict):
    coll, op, a = body.get("coll", ""), body.get("op", ""), body.get("args") or {}
    d = _db()
    if op == "command":
        name = a.get("name")
        if name not in COMMANDS:
            raise HTTPException(403, f"command {name!r} is not open to agents")
        return _json(await d.command(name, a["arg"]) if a.get("arg") is not None else await d.command(name))
    if op == "list_collection_names":
        return _json(sorted(set(await d.list_collection_names()) & (COLLECTIONS | READ_ONLY)))
    if op not in OPS:
        raise HTTPException(403, f"operation {op!r} is not open to agents")
    if coll not in COLLECTIONS and not (coll in READ_ONLY and op in READS):
        raise HTTPException(403, f"collection {coll!r} is not open to agents")
    if (bad := _forbidden(a)):
        raise HTTPException(403, f"{bad} is not open to agents")
    ws = scope.current()
    if coll in OWNER_ONLY and ws != scope.DEFAULT:
        raise HTTPException(403, f"collection {coll!r} is not open to this space's agents")
    # The token's role (backend/access.py): a reviewer's or viewer's token
    # reads; writing needs an editor's.
    need = "view" if op in READS else "delete" if op.startswith("delete") else "run"
    if not access.allowed(access.current(), need):
        raise HTTPException(403, access.refusal(access.current() or "nobody", need))
    c = _Parts(d[coll], ws) if coll == "parts" else d[coll]
    if coll == "parts" and op not in READS and ws != scope.DEFAULT:
        # The cache is everyone's: another space fetches through the
        # server (POST /api/parts/{code}), which keeps to its drawer.
        raise HTTPException(403, "the parts cache is written through POST /api/parts/{code} from this space")
    if coll in _PRODUCTS and op in ("delete_one", "delete_many"):
        return _json({"deleted_count": await _parts_delete(d, coll, op, a["filter"])})
    if coll == "inventory" and op not in READS:
        await _counts_a_product(d, op, a)
    before = [x async for x in c.find(a["filter"])] if coll == "manufacturers" and op not in READS and "filter" in a else []
    res = await _do(c, d, coll, op, a)
    from . import parts_trash
    for x in before:
        # products a write took out of a catalog go to Parts' Deleted with their stock and files
        await parts_trash.dropped(d, x["_id"], x.get("products") or [], how="agent")
    return res


# The collections a Parts product lives in: a delete through here goes to
# Parts' Deleted with the product's stock lines and files (backend/parts_trash.py).
_PRODUCTS = frozenset({"manufacturers", "own_items", "linked_parts"})


async def _parts_delete(d, coll: str, op: str, flt: dict) -> int:
    from . import parts_trash
    docs = [x async for x in d[coll].find(flt)]
    for x in docs[:1] if op == "delete_one" else docs:
        if coll == "manufacturers":
            await parts_trash.trash_maker(d, x["_id"], how="agent")
        elif coll == "own_items":
            await parts_trash.trash_products(d, "own", [x["_id"]], how="agent")
        else:
            await parts_trash.trash_products(d, x["source"], [x["key"]], how="agent")
    n = len(docs[:1] if op == "delete_one" else docs)
    if n:
        await actors.audit(d, "delete", coll, {"op": op, "count": n, "filter": json_util.dumps(flt)[:300],
                                               "to": "parts_trash"})
    return n


async def _counts_a_product(d, op: str, a: dict) -> None:
    """A stock line written through here counts a product that is in Parts, or is refused."""
    from . import inventory
    docs = [a["doc"]] if "doc" in a else list(a.get("docs") or [])
    upd = a.get("update") or {}
    docs += [x for x in (upd.get("$set") or {}, upd.get("$setOnInsert") or {}) if "catalog" in x]
    for x in docs:
        if x.get("catalog"):
            try:
                await inventory.link_catalog(d, inventory._catalog_ref(x["catalog"]))
            except ValueError as exc:
                raise HTTPException(400, f"a stock line counts a product in Parts: {exc}") from exc


async def _do(c, d, coll: str, op: str, a: dict):
    if op == "find":
        cur = c.find(a.get("filter") or {}, a.get("projection"))
        if a.get("sort"):
            cur = cur.sort([tuple(s) for s in a["sort"]])
        if a.get("skip"):
            cur = cur.skip(a["skip"])
        if a.get("limit"):
            cur = cur.limit(a["limit"])
        return _json(await cur.to_list(None))
    if op == "find_one":
        kw = {"sort": [tuple(s) for s in a["sort"]]} if a.get("sort") else {}
        return _json(await c.find_one(a.get("filter") or {}, a.get("projection"), **kw))
    if op == "count_documents":
        return _json(await c.count_documents(a.get("filter") or {}))
    if op == "distinct":
        return _json(await c.distinct(a["key"], a.get("filter") or {}))
    if op == "aggregate":
        return _json(await c.aggregate(a.get("pipeline") or []).to_list(None))
    if op == "insert_one":
        res = await c.insert_one(a["doc"])
        return _json({"inserted_id": res.inserted_id})
    if op == "insert_many":
        res = await c.insert_many(a["docs"])
        return _json({"inserted_ids": res.inserted_ids})
    if op in ("update_one", "update_many"):
        res = await getattr(c, op)(a["filter"], a["update"], upsert=bool(a.get("upsert")))
        return _json({"matched_count": res.matched_count, "modified_count": res.modified_count,
                      "upserted_id": res.upserted_id})
    if op == "replace_one":
        res = await c.replace_one(a["filter"], a["doc"], upsert=bool(a.get("upsert")))
        return _json({"matched_count": res.matched_count, "modified_count": res.modified_count,
                      "upserted_id": res.upserted_id})
    if op in ("delete_one", "delete_many"):
        res = await getattr(c, op)(a["filter"])
        if res.deleted_count:
            await actors.audit(d, "delete", f"{coll}", {"op": op, "count": res.deleted_count,
                                                         "filter": json_util.dumps(a["filter"])[:300]})
        return _json({"deleted_count": res.deleted_count})
    if op == "find_one_and_update":
        from pymongo import ReturnDocument
        return _json(await c.find_one_and_update(
            a["filter"], a["update"], upsert=bool(a.get("upsert")), projection=a.get("projection"),
            return_document=ReturnDocument.AFTER if a.get("after") else ReturnDocument.BEFORE))
    raise HTTPException(400, op)


class _Parts:
    """The LCSC parts cache as one space's agent sees it: its reads keep to
    the space's drawer (lcsc.held_by). Writes are the default space's only
    (refused above) and still cannot take a part out of another drawer: an
    update or a delete keeps to this drawer - a delete to a part no other
    drawer holds - and a fetched part replaced keeps the drawers it was in,
    and goes into this one."""

    def __init__(self, c, ws: str):
        self._c, self._ws = c, ws

    def _q(self, filter: dict | None) -> dict:
        from . import lcsc
        return {"$and": [filter or {}, lcsc.held_by(self._ws)]}

    def find(self, filter=None, *a, **kw):
        return self._c.find(self._q(filter), *a, **kw)

    async def find_one(self, filter=None, *a, **kw):
        return await self._c.find_one(self._q(filter), *a, **kw)

    async def count_documents(self, filter=None, **kw):
        return await self._c.count_documents(self._q(filter), **kw)

    async def distinct(self, key: str, filter=None, **kw):
        return await self._c.distinct(key, self._q(filter), **kw)

    def aggregate(self, pipeline: list, *a, **kw):
        from . import lcsc
        return self._c.aggregate([{"$match": lcsc.held_by(self._ws)}, *pipeline], *a, **kw)

    async def update_one(self, filter, update, upsert=False, **kw):
        return await self._c.update_one(self._q(filter), update, **kw)

    async def update_many(self, filter, update, upsert=False, **kw):
        return await self._c.update_many(self._q(filter), update, **kw)

    async def find_one_and_update(self, filter, update, upsert=False, **kw):
        return await self._c.find_one_and_update(self._q(filter), update, **kw)

    def _alone(self, filter) -> dict:
        # Held here and in no other drawer.
        return {"$and": [self._q(filter), {"spaces": {"$not": {"$elemMatch": {"$ne": self._ws}}}}]}

    async def delete_one(self, filter, **kw):
        return await self._c.delete_one(self._alone(filter), **kw)

    async def delete_many(self, filter, **kw):
        return await self._c.delete_many(self._alone(filter), **kw)

    async def insert_one(self, doc: dict, **kw):
        return await self._c.insert_one({**doc, "spaces": [self._ws]}, **kw)

    async def insert_many(self, docs, **kw):
        return await self._c.insert_many([{**d, "spaces": [self._ws]} for d in docs], **kw)

    async def replace_one(self, filter, doc: dict, upsert=False, **kw):
        # A part fetched again (lcsc._fetch): the cache refreshed, the
        # drawers it is in kept as they are, this one added.
        from . import lcsc
        if not isinstance(filter, dict) or set(filter) != {"_id"} or not isinstance(filter["_id"], str):
            raise HTTPException(403, "a part is replaced by its code alone")
        had = await self._c.find_one({"_id": filter["_id"]}, {"spaces": 1, "held": 1, "held_last": 1})
        body = {k: v for k, v in doc.items() if k not in ("spaces", "held", "held_last")}
        body.update({k: had[k] for k in ("spaces", "held", "held_last") if had and k in had})
        res = await self._c.replace_one(filter, body, upsert=upsert, **kw)
        await lcsc.hold(_db(), filter["_id"], self._ws)
        return res


def _bucket(name: str):
    from . import store
    if name not in BUCKETS:
        raise HTTPException(403, f"file store {name!r} is not open to agents")
    return store.bucket(_db(), name)


# Where a space's documents point at a stored file, bucket by bucket: what
# lets a space reach its files from before they carried their space.
_POINTERS = {
    "model_files": [("models", None), ("boards", None), ("component_versions", "step.gridfs_id")],
    "shots": [("revisions", "image.gridfs_id"), ("revisions", "image_after.gridfs_id")],
    "cad_files": [("uploads", "gridfs_id")],
}


def _in_artifacts(fid) -> dict:
    # artifacts.<label>.gridfs_id, whatever the label.
    return {"$expr": {"$in": [fid, {"$map": {"input": {"$objectToArray": {"$ifNull": ["$artifacts", {}]}},
                                             "in": "$$this.v.gridfs_id"}}]}}


async def _owned(bucket: str, fid) -> bool:
    """Whether the asking space may have this stored file: one it stored
    (metadata.workspace_id), one its documents point at, or - for the
    default space - one from before files carried their space."""
    d, ws = _db(), scope.current()
    raw = d.raw if getattr(type(d), "SCOPED", False) else d
    doc = await raw[f"{bucket}.files"].find_one({"_id": fid}, {"metadata": 1})
    if not doc:
        return False
    owner = (doc.get("metadata") or {}).get("workspace_id")
    if owner == ws or (owner is None and ws == scope.DEFAULT):
        return True
    for coll, field in _POINTERS.get(bucket, []):
        if await d[coll].find_one(_in_artifacts(fid) if field is None else {field: fid}, {"_id": 1}):
            return True
    if bucket == "model_files":
        # A part's 3D model, while the part is in this space's drawer.
        from . import lcsc
        if await raw[lcsc.PARTS].find_one({"$and": [_in_artifacts(fid), lcsc.held_by(ws)]}, {"_id": 1}):
            return True
    return False


def _fid(fid: str):
    return ObjectId(fid) if ObjectId.is_valid(fid) else fid


@router.post("/files/{bucket}")
async def agent_file_put(bucket: str, request: Request, filename: str = "file"):
    _agent_only()
    if not access.allowed(access.current(), "run"):
        raise HTTPException(403, access.refusal(access.current() or "nobody", "run"))
    fid = await _bucket(bucket).upload_from_stream(filename, await request.body())
    return Response(json_util.dumps({"id": fid}), media_type="application/json")


@router.get("/files/{bucket}/{fid}")
async def agent_file_get(bucket: str, fid: str):
    _agent_only()
    b = _bucket(bucket)
    # Another space's file is no file at all, as if it were not there.
    if not await _owned(bucket, _fid(fid)):
        raise HTTPException(404, "no such file")
    try:
        stream = await b.open_download_stream(_fid(fid))
    except Exception as exc:
        raise HTTPException(404, "no such file") from exc
    return Response(await stream.read(), media_type="application/octet-stream")


@router.delete("/files/{bucket}/{fid}")
async def agent_file_delete(bucket: str, fid: str):
    _agent_only()
    if not access.allowed(access.current(), "delete"):
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    b = _bucket(bucket)
    if not await _owned(bucket, _fid(fid)):
        raise HTTPException(404, "no such file")
    try:
        await b.delete(_fid(fid))
    except Exception as exc:
        raise HTTPException(404, "no such file") from exc
    return {"deleted": fid}


# ---------------------------------------------------------------- the agent kit
#
# An agent on someone's own computer runs from the seed (a start script, no
# source): each start fetches the kit - the command line and the agents'
# instructions (backend/agent_kit.py) - with the agent's token.

def _kit_holder():
    from . import auth
    who = actors.current()
    if who["type"] != "agent" or (auth.enabled() and not who.get("token")):
        raise HTTPException(403, "the agent kit is for agents: send an agent token "
                                 "(Authorization: Bearer rlat_...) - make one under Agent tokens")


@router.get("/kit/version")
async def agent_kit_version():
    """The kit's version: the seed fetches the kit only when it changed. Also
    how the seed checks its token before it starts the agent."""
    import asyncio

    from . import agent_kit
    _kit_holder()
    version, blob = await asyncio.to_thread(agent_kit.build)
    return {"version": version, "bytes": len(blob), "python": "3.12"}


@router.get("/kit")
async def agent_kit_download(request: Request):
    """The kit, as a tar.gz under redline-agent-kit/."""
    import asyncio

    from . import agent_kit
    _kit_holder()
    version, blob = await asyncio.to_thread(agent_kit.build)
    etag = f'"{version}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return Response(blob, media_type="application/gzip", headers={
        "ETag": etag, "X-Redline-Kit-Version": version,
        "Content-Disposition": f'attachment; filename="redline-agent-kit-{version}.tar.gz"'})


@router.get("/status")
async def agent_status():
    """Whether this space has an agent at work: its working tokens, the last
    time one was used, connected or not (backend/agent_kit.py status). For
    the first-run guide and the token page - anyone who may look sees it;
    `can_make` says whether they may also make a token."""
    from . import agent_kit
    who = actors.current()
    out = await agent_kit.status(_db(), scope.current())
    out["can_make"] = who["type"] == "user" and access.allowed(access.current(), "tokens")
    return out
