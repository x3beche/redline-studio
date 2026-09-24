"""The agents' way in: their database work, through the API.

`tools/revisions.py` with `X3_TRANSPORT=api` (tools/remote_db.py) sends
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
    # The token's role (backend/access.py): a reviewer's or viewer's token
    # reads; writing needs an editor's.
    need = "view" if op in READS else "delete" if op.startswith("delete") else "run"
    if not access.allowed(access.current(), need):
        raise HTTPException(403, access.refusal(access.current() or "nobody", need))
    c = d[coll]
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


def _bucket(name: str):
    from . import store
    if name not in BUCKETS:
        raise HTTPException(403, f"file store {name!r} is not open to agents")
    return store.bucket(_db(), name)


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
    try:
        stream = await _bucket(bucket).open_download_stream(ObjectId(fid) if ObjectId.is_valid(fid) else fid)
    except Exception as exc:
        raise HTTPException(404, "no such file") from exc
    return Response(await stream.read(), media_type="application/octet-stream")


@router.delete("/files/{bucket}/{fid}")
async def agent_file_delete(bucket: str, fid: str):
    _agent_only()
    if not access.allowed(access.current(), "delete"):
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    try:
        await _bucket(bucket).delete(ObjectId(fid) if ObjectId.is_valid(fid) else fid)
    except Exception as exc:
        raise HTTPException(404, "no such file") from exc
    return {"deleted": fid}
