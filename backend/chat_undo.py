"""Undo for what the Chat's tools changed.

Every call of a writing tool (level change or delete, backend/chat_tools)
runs with its database seen through a `Recorder`: each write it makes -
an insert, an update, a delete, through any helper it calls - is read
before and after, and what changed is kept as one *change* of the
conversation (`cc_changes`, one document a step): the conversation and the
step of the answer, the tool, who asked, when, the rights its handler
checked (chat_tools/_rights.py `need`), and per document touched either
the whole document (made or deleted) or only the fields that changed, a
list of products or files by their ids, a log by the lines it gained.

Undo applies the inverse - the document deleted again, put back, its
fields set back - only where the target is still as the tool left it;
anything changed since is a conflict, said field by field, and nothing of
that change is undone. Undo needs the rights the change needed, and is
itself a change (`of`), so it can be undone in its turn (redo).

A tool chooses how it is undone with its `undo` (chat_tools `Tool`):
  None      - the generic inverse above (most tools);
  False     - not recorded at all (a cache, nothing the person sees);
  "words"   - recorded, shown, not undoable: the words say why;
  a function `async (ctx, change, apply: bool)` - its own inverse: raise
            Conflict when it cannot, do nothing when `apply` is False.
Collections can have hooks after an undo (`AFTER`) and fields that change
by themselves (`VOLATILE_IN`), see README.md in chat_tools.

Deleted things stay restorable for KEEP_DAYS (REDLINE_CC_UNDO_DAYS): a
Files file removed by a tool, or by an undo, keeps its bytes until then
(files.py `HOLD`); after that the change is kept as a line of history,
without its snapshots, and can no longer be undone.
"""

from __future__ import annotations

import copy
import dataclasses
import os
import secrets
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import access, actors

router = APIRouter(prefix="/api/cc")

COLL = "cc_changes"
KEEP_DAYS = max(1, int(os.environ.get("REDLINE_CC_UNDO_DAYS", "30") or 30))
MOST_DOCS = 200                       # documents one write may touch and still be undoable
MOST_BYTES = 12 * 1024 * 1024         # a change bigger than this keeps no snapshots (Mongo's limit is 16 MB)
SWEEP_EVERY = 3600.0                  # seconds between sweeps of expired changes
SHOW = 160                            # characters of a value a conflict shows

# Written by the tools' helpers but not what they change: trails, timings,
# the answer being written, the change log itself.
SKIP = frozenset({COLL, "audit", "activity", "analytics", "tool_usage", "api_timings", "cc_gens", "item_history",
                  "llm_usage", "machine_samples"})
# Fields that change by themselves on any write; never a conflict, never set back.
VOLATILE = frozenset({"_id", "workspace_id", "updated_at", "updated_by"})
# ... and per collection: what a background job writes after the tool is done.
VOLATILE_IN: dict[str, frozenset[str]] = {
    "product_files": frozenset({"measured", "measuring"}),
    "linked_parts": frozenset({"measured", "measuring"}),
    "cc_chats": frozenset({"messages", "gen", "queue", "queue_paused", "title_auto", "naming"}),
    "models": frozenset({"built", "build", "build_job", "artifacts", "version"}),
}
KEYS = ("id", "file", "_id", "key")   # what tells the members of a list of dicts apart

# What a target is called on the page (English keys of i18n.ts).
KIND = {"inventory": "stock line", "manufacturers": "catalog", "own_items": "My Items product",
        "product_files": "product files", "linked_parts": "saved part", "notes": "note", "cc_chats": "chat",
        "files": "file", "revisions": "queued note", "models": "model", "lcsc_parts": "drawer"}


class Conflict(Exception):
    """The target changed since the tool changed it: `rows` say how."""

    def __init__(self, why: str, rows: list[dict] | None = None):
        super().__init__(why)
        self.rows = rows or []


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t: datetime | None = None) -> str:
    return (t or _now()).isoformat()


# ---------------------------------------------------------------- recording

class _Missing:
    def __repr__(self) -> str:
        return "<missing>"


MISSING = _Missing()


class Recorder:
    """What one tool call wrote, document by document: the first state it
    saw and the last. `complete` is False when a write touched more than
    MOST_DOCS documents or wrote in a way that cannot be followed."""

    def __init__(self) -> None:
        self.on = True
        self.complete = True
        self.seen: dict[tuple[str, Any], dict] = {}

    def wrap(self, db):
        return _proxy(db, self)

    def note(self, coll: str, did: Any, before: dict | None, after: dict | None) -> None:
        k = (coll, repr(did))
        if k not in self.seen:
            self.seen[k] = {"coll": coll, "id": did, "b": copy.deepcopy(before)}
        self.seen[k]["a"] = copy.deepcopy(after)

    def changes(self) -> list[dict]:
        out = []
        for x in self.seen.values():
            d = diff(x["coll"], x["id"], x["b"], x.get("a"))
            if d:
                out.append(d)
        return out


class _Coll:
    """A collection whose writes are recorded; reads pass through."""

    def __init__(self, c, name: str, rec: Recorder):
        self._c, self._name, self._rec = c, name, rec

    def __getattr__(self, n: str):
        return getattr(self._c, n)

    @property
    def _on(self) -> bool:
        return self._rec.on and self._name not in SKIP

    async def _rows(self, q) -> list[dict] | None:
        rows = []
        async for d in self._c.find(q or {}):
            rows.append(d)
            if len(rows) > MOST_DOCS:
                self._rec.complete = False
                return None
        return rows

    async def _one(self, did):
        return await self._c.find_one({"_id": did})

    async def _write(self, q, call, upsert: bool = False):
        if not self._on:
            return await call()
        before = await self._rows(q)
        res = await call()
        if before is None:
            return res
        for d in before:
            self._rec.note(self._name, d["_id"], d, await self._one(d["_id"]))
        if upsert and not before:
            new = getattr(res, "upserted_id", None)
            got = [await self._one(new)] if new is not None else (await self._rows(q) or [])
            for d in got:
                if d:
                    self._rec.note(self._name, d["_id"], None, d)
        return res

    async def insert_one(self, doc, *a, **kw):
        res = await self._c.insert_one(doc, *a, **kw)
        if self._on:
            did = doc.get("_id", getattr(res, "inserted_id", None))
            self._rec.note(self._name, did, None, await self._one(did))
        return res

    async def insert_many(self, docs, *a, **kw):
        docs = list(docs)
        res = await self._c.insert_many(docs, *a, **kw)
        if self._on:
            for d in docs:
                self._rec.note(self._name, d.get("_id"), None, await self._one(d.get("_id")))
        return res

    async def update_one(self, q, update, *a, **kw):
        return await self._write(q, lambda: self._c.update_one(q, update, *a, **kw), bool(kw.get("upsert")))

    async def update_many(self, q, update, *a, **kw):
        return await self._write(q, lambda: self._c.update_many(q, update, *a, **kw), bool(kw.get("upsert")))

    async def replace_one(self, q, doc, *a, **kw):
        return await self._write(q, lambda: self._c.replace_one(q, doc, *a, **kw), bool(kw.get("upsert")))

    async def find_one_and_update(self, q, update, *a, **kw):
        return await self._write(q, lambda: self._c.find_one_and_update(q, update, *a, **kw), bool(kw.get("upsert")))

    async def find_one_and_replace(self, q, doc, *a, **kw):
        return await self._write(q, lambda: self._c.find_one_and_replace(q, doc, *a, **kw), bool(kw.get("upsert")))

    async def find_one_and_delete(self, q, *a, **kw):
        return await self._write(q, lambda: self._c.find_one_and_delete(q, *a, **kw))

    async def delete_one(self, q, *a, **kw):
        return await self._write(q, lambda: self._c.delete_one(q, *a, **kw))

    async def delete_many(self, q, *a, **kw):
        return await self._write(q, lambda: self._c.delete_many(q, *a, **kw))

    async def bulk_write(self, *a, **kw):
        if self._on:
            self._rec.complete = False
        return await self._c.bulk_write(*a, **kw)


class _Db:
    """A database (a workspace's view, scope.ScopedDb) whose collections
    record their writes. Stored files (GridFS, through `raw`) pass through."""

    def __init__(self, db, rec: Recorder):
        self._db, self._rec = db, rec

    def __getitem__(self, name: str):
        return _Coll(self._db[name], name, self._rec)

    def __getattr__(self, name: str):
        if name.startswith("_"):
            raise AttributeError(name)
        v = getattr(self._db, name)
        if name in ("raw", "workspace") or (callable(v) and not hasattr(type(v), "find_one")):
            return v
        return _Coll(v, name, self._rec)


_CLASSES: dict[type, type] = {}


def _proxy(db, rec: Recorder):
    # store.bucket() asks the class whether it is a workspace's view (or the
    # agents' remote one): the recording view answers as the one it wraps.
    t = type(db)
    if t not in _CLASSES:
        _CLASSES[t] = type("Recording" + t.__name__, (_Db,), {"SCOPED": getattr(t, "SCOPED", False),
                                                              "REMOTE": getattr(t, "REMOTE", False)})
    return _CLASSES[t](db, rec)


def inner(db):
    """The database a recording view wraps (or `db` itself)."""
    return db._db if isinstance(db, _Db) else db


# ---------------------------------------------------------------- what changed

def _key(*lists) -> str | None:
    """The key the dicts of these lists are told apart by, if every one has
    it, once."""
    items = [x for lst in lists for x in lst]
    if not items or not all(isinstance(x, dict) for x in items):
        return None
    for k in KEYS:
        if all(k in x for x in items) and all(len({repr(x[k]) for x in lst}) == len(lst) for lst in lists):
            return k
    return None


def _volatile(coll: str) -> frozenset[str]:
    return VOLATILE | VOLATILE_IN.get(coll, frozenset())


def diff(coll: str, did: Any, b: dict | None, a: dict | None) -> dict | None:
    """One document's change, or None when nothing of it changed."""
    if b is None and a is None:
        return None
    if b is None:
        return {"coll": coll, "id": did, "op": "insert", "a": a}
    if a is None:
        return {"coll": coll, "id": did, "op": "delete", "b": b}
    ops: list[dict] = []
    for f in sorted(set(b) | set(a), key=str):
        if f in _volatile(coll):
            continue
        bv, av = b.get(f, MISSING), a.get(f, MISSING)
        if bv == av:
            continue
        if isinstance(bv, list) and isinstance(av, list):
            k = _key(bv, av)
            if k:
                bm, am = {repr(x[k]): x for x in bv}, {repr(x[k]): x for x in av}
                at = {repr(x[k]): i for i, x in enumerate(bv)}
                for r in [*bm, *(x for x in am if x not in bm)]:
                    if bm.get(r) != am.get(r):
                        el = bm.get(r) or am.get(r)
                        ops.append({"f": f, "key": k, "id": el[k], "had": r in bm, "b": bm.get(r),
                                    "has": r in am, "a": am.get(r), "at": at.get(r, len(bv))})
                continue
            if all(isinstance(x, dict) for x in [*bv, *av]):
                added = [x for x in av if x not in bv]
                dropped = [x for x in bv if x not in av]
                if [x for x in bv if x not in dropped] + added == av:
                    ops.append({"f": f, "list": True, "add": added, "drop": dropped})
                    continue
        ops.append({"f": f, "had": bv is not MISSING, "b": None if bv is MISSING else bv,
                    "has": av is not MISSING, "a": None if av is MISSING else av})
    if not ops:
        return None
    return {"coll": coll, "id": did, "op": "update", "fields": ops, "name": _name(a)}


def _name(d: dict | None) -> str:
    d = d or {}
    v = d.get("name") or d.get("title") or d.get("product_name") or d.get("comment") or d.get("text") or d.get("_id")
    return str(v or "")[:80]


def things(change: dict) -> list[dict]:
    """What a change touched, a row each, for the page: {kind, name}."""
    out = []
    for x in change.get("docs") or []:
        kind = KIND.get(x["coll"], x["coll"])
        if x["op"] != "update":
            out.append({"kind": kind, "name": _name(x.get("a") or x.get("b")),
                        "op": "added" if x["op"] == "insert" else "removed"})
            continue
        els = [o for o in x["fields"] if "key" in o]
        for o in els:
            el = o.get("a") or o.get("b") or {}
            out.append({"kind": "product" if x["coll"] == "manufacturers" else kind, "name": _name(el),
                        "op": "added" if not o["had"] else "removed" if not o["has"] else "changed"})
        if len(els) < len(x["fields"]):
            fs = sorted({o["f"] for o in x["fields"] if "key" not in o})
            out.append({"kind": kind, "name": x.get("name") or "", "op": "changed", "fields": fs})
    return out


# ---------------------------------------------------------------- the runner's side

async def recorded(tool, run: Callable[[Any, dict], Awaitable[Any]], ctx, args: dict):
    """A writing tool's call, recorded (chat_tools `Tool` wraps its handler
    in this while a step runs it)."""
    from . import files
    from .chat_tools import _rights

    rec = Recorder()
    sub = dataclasses.replace(ctx, db=rec.wrap(ctx.db))
    checked: list = []
    held: list = []
    t1, t2 = _rights.CHECKED.set(checked), files.HOLD.set(held)
    res = None
    try:
        res = await run(sub, args)
        return res
    finally:
        rec.on = False
        _rights.CHECKED.reset(t1)
        files.HOLD.reset(t2)
        try:
            await keep(ctx, tool, args, res, rec, checked, held)
        except Exception:                                        # noqa: BLE001 - the log never takes the answer down
            print("cc undo: change not kept\n" + traceback.format_exc()[-1500:], file=sys.stderr)


def _short_args(args: dict) -> dict:
    return {k: (v if isinstance(v, (int, float, bool)) or v is None else str(v)[:300]) for k, v in (args or {}).items()}


async def keep(ctx, tool, args, res, rec: Recorder, checked: list, held: list) -> dict | None:
    """The change kept, when the call changed anything (or holds a file)."""
    docs = rec.changes()
    if not docs and not held:
        return None
    now = _now()
    entry = {"_id": secrets.token_hex(6), "kind": "tool", "chat": ctx.chat, "step": getattr(ctx, "step", ""),
             "tool": tool.name, "level": tool.level, "by": ctx.actor or actors.current() or {},
             "at": _iso(now), "expires": _iso(now + timedelta(days=KEEP_DAYS)),
             "say": res.say if res is not None else tool.failed, "vars": dict(res.vars) if res is not None else {},
             "failed": res is None, "args": _short_args(args), "docs": docs, "rights": checked, "held": held,
             "complete": rec.complete}
    if isinstance(tool.undo, str):
        entry["never"] = tool.undo
    elif callable(tool.undo):
        entry["custom"] = True
    _fit(entry)
    await ctx.db[COLL].insert_one(entry)
    await sweep(ctx.db)
    return entry


def _fit(entry: dict) -> None:
    """A change too big to keep whole keeps no snapshots (and no undo)."""
    try:
        import bson
        if len(bson.encode(entry)) <= MOST_BYTES:
            return
    except Exception:                                            # noqa: BLE001 - unencodable: as too big
        pass
    entry["docs"] = [{"coll": x["coll"], "id": x["id"], "op": x["op"], "name": _name(x.get("a") or x.get("b"))}
                     for x in entry["docs"]]
    entry["complete"] = False
    entry["never"] = "too big to keep for undo"


# ---------------------------------------------------------------- undoing

def _show(v) -> str:
    s = "(none)" if v is None or v is MISSING else str(v)
    return s if len(s) <= SHOW else s[:SHOW] + "..."


def _same(cur: dict, want: dict, coll: str) -> list[str]:
    """The fields of `want` that `cur` no longer has as they were."""
    vol = _volatile(coll)
    return [f for f in sorted(set(want) | set(cur), key=str)
            if f not in vol and cur.get(f, MISSING) != want.get(f, MISSING)]


async def _check_doc(db, x: dict) -> list[dict]:
    """Why this document cannot be set back (nothing: it can)."""
    cur = await db[x["coll"]].find_one({"_id": x["id"]})
    name = _name(cur or x.get("a") or x.get("b"))
    kind = KIND.get(x["coll"], x["coll"])
    if x["op"] == "insert":
        if cur is None:
            return []                                            # gone already: nothing to undo
        return [{"kind": kind, "name": name, "field": f, "then": _show(x["a"].get(f, MISSING)),
                 "now": _show(cur.get(f, MISSING)), "why": "changed since"} for f in _same(cur, x["a"], x["coll"])]
    if x["op"] == "delete":
        return [] if cur is None else [{"kind": kind, "name": name, "why": "made again since"}]
    if cur is None:
        return [{"kind": kind, "name": name, "why": "deleted since"}]
    rows = []
    for o in x["fields"]:
        now = cur.get(o["f"], MISSING)
        if "key" in o:
            lst = now if isinstance(now, list) else []
            el = next((e for e in lst if isinstance(e, dict) and e.get(o["key"]) == o["id"]), None)
            want = o["a"] if o["has"] else None
            back = o["b"] if o["had"] else None
            if el != want and el != back:
                rows.append({"kind": "product" if x["coll"] == "manufacturers" else kind,
                             "name": _name(el or o.get("a") or o.get("b")), "field": o["f"],
                             "then": _show(_name(want) if want else None), "now": _show(_name(el) if el else None),
                             "why": "changed since" if el and want else "deleted since" if want else "made again since"})
        elif o.get("list"):
            lst = now if isinstance(now, list) else []
            if not all(e in lst for e in o["add"]):
                rows.append({"kind": kind, "name": name, "field": o["f"], "why": "changed since"})
        else:
            want = o["a"] if o["has"] else MISSING
            back = o["b"] if o["had"] else MISSING
            if now != want and now != back:
                rows.append({"kind": kind, "name": name, "field": o["f"], "then": _show(want), "now": _show(now),
                             "why": "changed since"})
    return rows


async def _apply_doc(db, x: dict, held: list) -> None:
    """One document set back as it was before the change."""
    from . import files
    c = db[x["coll"]]
    if x["op"] == "insert":
        cur = await c.find_one({"_id": x["id"]})
        if cur is None:
            return
        if x["coll"] == files.COLL and cur.get("gridfs_id") is not None:
            held.append(cur["gridfs_id"])                        # its bytes stay for the window: a redo needs them
        await c.delete_one({"_id": x["id"]})
        return
    if x["op"] == "delete":
        await c.insert_one(copy.deepcopy(x["b"]))
        return
    cur = await c.find_one({"_id": x["id"]})
    if cur is None:
        return
    sets, unset = {}, {}
    for o in x["fields"]:
        f = o["f"]
        if "key" in o:
            lst = list(sets.get(f, cur.get(f)) or [])
            i = next((j for j, e in enumerate(lst) if isinstance(e, dict) and e.get(o["key"]) == o["id"]), None)
            if o["had"] and i is not None:
                lst[i] = o["b"]
            elif o["had"]:
                lst.insert(min(o.get("at", len(lst)), len(lst)), o["b"])
            elif i is not None:
                lst.pop(i)
            sets[f] = lst
        elif o.get("list"):
            lst = list(sets.get(f, cur.get(f)) or [])
            for e in o["add"]:
                if e in lst:
                    lst.remove(e)
            sets[f] = [*o["drop"], *lst]
        elif o["had"]:
            sets[f] = o["b"]
        else:
            unset[f] = ""
    upd = {**({"$set": sets} if sets else {}), **({"$unset": unset} if unset else {})}
    if upd:
        await c.update_one({"_id": x["id"]}, upd)


async def _after_cc_chats(db, x: dict) -> None:
    from . import cc_chat
    if any(o["f"] == "title" for o in x.get("fields") or []):
        d = await db[x["coll"]].find_one({"_id": x["id"]}, {"title": 1})
        if d:
            cc_chat.HUB.publish(cc_chat.live_key(x["id"]), {"type": "title", "gen": None, "title": d.get("title")})


async def _after_measured(db, x: dict) -> None:
    from . import linked_measure
    if not any(o["f"] == "cad" for o in x.get("fields") or []):
        return
    d = await db[x["coll"]].find_one({"_id": x["id"]})
    if d and linked_measure.stale(d):
        try:
            linked_measure.start(inner(db), x["id"], x["coll"])
        except Exception:                                        # noqa: BLE001 - measured later, by the page
            pass


# After an undo, per collection: what the page or a job must hear of it.
async def _after_files(db, x: dict) -> None:
    """A file a tool deleted, back: the Chat lines and products that said it was gone no longer do."""
    from . import files, files_virtual
    if x["op"] == "delete" and await db[files.COLL].find_one({"_id": x["id"]}, {"_id": 1}):
        await files_virtual.mark_back(db, x["id"])


AFTER: dict[str, Callable[[Any, dict], Awaitable[None]]] = {
    "files": _after_files,
    "cc_chats": _after_cc_chats,
    "product_files": _after_measured,
    "linked_parts": _after_measured,
}


def _ctx(db, cid: str):
    from .chat_tools import Ctx
    return Ctx(db=db, actor=actors.current() or {}, chat=cid)


def undoable(e: dict) -> str:
    """Why this change cannot be undone ("" - it can)."""
    if e.get("undone"):
        return "undone already"
    if e.get("never"):
        return e["never"]
    if not e.get("complete", True):
        return "it changed more than can be kept"
    if e.get("expired") or (e.get("expires") or "") < _iso():
        return f"older than {KEEP_DAYS} days"
    return ""


def may(e: dict, role: str | None = None) -> bool:
    """Whether `role` (the request's) has every right the change needed."""
    role = role if role is not None else access.current()
    acts = [access.action(m, p) for m, p in (e.get("rights") or [])] or \
        ["delete" if e.get("level") == "delete" else "draw"]
    return all(access.allowed(role, a) for a in acts)


async def conflicts(db, e: dict) -> list[dict]:
    if e.get("custom"):
        from . import chat_tools
        t = chat_tools.tools().get(e["tool"])
        try:
            await t.undo(_ctx(db, e.get("chat") or ""), e, False)
        except Conflict as exc:
            return exc.rows or [{"kind": e["tool"], "name": "", "why": str(exc)}]
        return []
    rows = []
    for x in e.get("docs") or []:
        rows += await _check_doc(db, x)
    return rows


async def undo(db, e: dict) -> dict:
    """`e` undone: checked, applied through a recorder, and kept as a change
    of its own (`of`), which `e` points at. Conflict when it cannot."""
    why = undoable(e)
    if why:
        raise Conflict(why)
    if not may(e):
        raise PermissionError(access.refusal(access.current() or "nobody", "delete" if e.get("level") == "delete" else "draw"))
    if e.get("custom"):
        from . import chat_tools
        await chat_tools.tools()[e["tool"]].undo(_ctx(db, e.get("chat") or ""), e, False)
    else:
        rows = await conflicts(db, e)
        if rows:
            raise Conflict("changed since", rows)
    from . import files
    rec = Recorder()
    rdb = rec.wrap(db)
    held: list = []
    tok = files.HOLD.set(held)
    try:
        if e.get("custom"):
            from . import chat_tools
            await chat_tools.tools()[e["tool"]].undo(_ctx(rdb, e.get("chat") or ""), e, True)
        else:
            for x in reversed(e.get("docs") or []):
                await _apply_doc(rdb, x, held)
    finally:
        rec.on = False
        files.HOLD.reset(tok)
    for x in e.get("docs") or []:
        hook = AFTER.get(x["coll"])
        if hook:
            try:
                await hook(db, x)
            except Exception:                                    # noqa: BLE001 - a nicety after the fact
                print("cc undo: after-hook\n" + traceback.format_exc()[-800:], file=sys.stderr)
    now = _now()
    who = actors.current() or {}
    u = {"_id": secrets.token_hex(6), "kind": "undo", "of": e["_id"], "chat": e.get("chat"), "step": e.get("step"),
         "tool": e["tool"], "level": e.get("level"), "by": who, "at": _iso(now),
         "expires": e.get("expires") or _iso(now + timedelta(days=KEEP_DAYS)),
         "say": e.get("say"), "vars": e.get("vars") or {}, "docs": rec.changes(), "rights": e.get("rights") or [],
         "held": held, "complete": rec.complete, **({"custom": True} if e.get("custom") else {})}
    if e.get("custom"):
        u["never"] = "a tool's own undo is not redone - ask the Chat again"
    _fit(u)
    await db[COLL].insert_one(u)
    await db[COLL].update_one({"_id": e["_id"]}, {"$set": {"undone": {"at": u["at"], "by": who, "entry": u["_id"]}}})
    if e.get("kind") == "undo" and e.get("of"):
        # Undoing an undo is a redo: the change it undid is in effect again.
        await db[COLL].update_one({"_id": e["of"]}, {"$set": {"undone": None, "redone": {"at": u["at"], "by": who}}})
    await actors.audit(db, "chat-undo", f"{e.get('chat')}:{e.get('step')}",
                       {"change": e["_id"], "tool": e["tool"], "redo": e.get("kind") == "undo"})
    return u


async def sweep(db, force: bool = False) -> int:
    """Changes past the window: their files' held bytes let go (when no
    file points at them again), their snapshots dropped. At most once an
    hour unless `force`."""
    global _SWEPT
    if not force and time.monotonic() - _SWEPT < SWEEP_EVERY:
        return 0
    _SWEPT = time.monotonic()
    from . import files
    n, now = 0, _iso()
    old = [d async for d in db[COLL].find({"expires": {"$lt": now}, "expired": {"$ne": True}})
           if (d.get("expires") or "") < now and not d.get("expired")]
    for e in old:
        for gid in e.get("held") or []:
            try:
                if not await db[files.COLL].count_documents({"gridfs_id": gid}):
                    await files._bucket(db).delete(gid)
            except Exception:                                    # noqa: BLE001 - gone already
                pass
        await db[COLL].update_one({"_id": e["_id"]}, {"$set": {"expired": True, "held": []},
                                                      "$unset": {"docs": ""}})
        n += 1
    return n


_SWEPT = -SWEEP_EVERY


# ---------------------------------------------------------------- the API

def _db():
    from .main import db
    return db()


def public(e: dict, role: str | None = None) -> dict:
    """A change as the page shows it."""
    ts = things(e) if e.get("docs") else []
    why = undoable(e)
    return {"id": e["_id"], "step": e.get("step") or "", "tool": e.get("tool"), "level": e.get("level"),
            "say": e.get("say") or "", "vars": e.get("vars") or {}, "by": e.get("by") or {}, "at": e.get("at"),
            "failed": bool(e.get("failed")), "things": ts[:40], "n": len(ts) or len(e.get("docs") or []),
            "undone": e.get("undone") or None, "redone": e.get("redone") or None,
            "why": why if not e.get("undone") else "", "may": may(e, role)}


async def _chat(db, cid: str) -> dict:
    from . import cc_chat
    doc = await db[cc_chat.COLL].find_one({"_id": cid, **cc_chat.LIVE}, {"_id": 1})
    if not doc:
        raise HTTPException(404, "no such conversation")
    return doc


@router.get("/chats/{cid}/changes")
async def list_changes(cid: str) -> dict:
    """What the tools changed in this conversation, oldest first; undos are
    on the changes they undid."""
    db = _db()
    await _chat(db, cid)
    rows = [d async for d in db[COLL].find({"chat": cid, "kind": "tool"})]
    rows.sort(key=lambda d: d.get("at") or "")
    role = access.current()
    return {"changes": [public(d, role) for d in rows], "days": KEEP_DAYS}


class UndoIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=200)


@router.post("/chats/{cid}/changes/undo")
async def undo_changes(cid: str, body: UndoIn) -> dict:
    """Undo these changes, newest first; at the first that cannot be, stop
    and say why (`conflict`: its rows, for the page's "Show")."""
    db = _db()
    await _chat(db, cid)
    rows = [d async for d in db[COLL].find({"chat": cid, "_id": {"$in": body.ids}, "kind": "tool"})]
    rows.sort(key=lambda d: d.get("at") or "", reverse=True)
    done: list[str] = []
    for e in rows:
        if e.get("undone"):
            continue
        try:
            await undo(db, e)
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except Conflict as exc:
            return {"done": done, "conflict": {"id": e["_id"], "why": str(exc), "rows": exc.rows[:40]},
                    **(await list_changes(cid))}
        done.append(e["_id"])
    return {"done": done, "conflict": None, **(await list_changes(cid))}


@router.post("/chats/{cid}/changes/{eid}/redo")
async def redo_change(cid: str, eid: str) -> dict:
    """A change undone, done again: its undo undone."""
    db = _db()
    await _chat(db, cid)
    e = await db[COLL].find_one({"_id": eid, "chat": cid})
    u_id = ((e or {}).get("undone") or {}).get("entry")
    u = await db[COLL].find_one({"_id": u_id}) if u_id else None
    if not u:
        raise HTTPException(404, "this change is not undone")
    try:
        await undo(db, u)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except Conflict as exc:
        return {"done": [], "conflict": {"id": eid, "why": str(exc), "rows": exc.rows[:40]}, **(await list_changes(cid))}
    return {"done": [eid], "conflict": None, **(await list_changes(cid))}


async def ensure_indexes(db) -> None:
    try:
        await db[COLL].create_index([("chat", 1), ("at", 1)])
        await db[COLL].create_index("expires")
    except Exception:                                            # noqa: BLE001 - only speed
        pass

