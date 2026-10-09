"""Nothing of one account's reaches another's: the shared logs, the
machine's job lists and the stored files are each kept to the asking
space, and rows from before spaces were written down are the default
space's."""
import asyncio

import pytest
from fastapi import HTTPException

from backend import agent_api, bom_cost, insights, lcsc, scope, usage


def get(doc, path):
    for p in path.split("."):
        if not isinstance(doc, dict) or p not in doc:
            return None, False
        doc = doc[p]
    return doc, True


def test_op(val, have, op, arg):
    if op == "$exists":
        return have == bool(arg)
    if op == "$ne":
        return not eq(val, arg)
    if op == "$in":
        return any(eq(val, a) for a in arg)
    if op == "$gte":
        return have and val >= arg
    if op == "$lt":
        return have and val < arg
    if op == "$lte":
        return have and val <= arg
    if op == "$regex":
        import re
        return have and isinstance(val, str) and re.search(arg, val) is not None
    if op == "$not":
        return not all(test_op(val, have, o, a) for o, a in arg.items())
    if op == "$elemMatch":
        return isinstance(val, list) and any(all(test_op(x, True, o, a) for o, a in arg.items()) for x in val)
    raise NotImplementedError(op)


test_op.__test__ = False


def eq(val, want):
    return want in val if isinstance(val, list) and not isinstance(want, list) else val == want


def matches(doc, q):
    for k, v in (q or {}).items():
        if k == "$and":
            if not all(matches(doc, x) for x in v):
                return False
        elif k == "$or":
            if not any(matches(doc, x) for x in v):
                return False
        elif k == "$expr":
            return False
        else:
            val, have = get(doc, k)
            if isinstance(v, dict) and any(o.startswith("$") for o in v):
                if not all(test_op(val, have, o, a) for o, a in v.items()):
                    return False
            elif not (have and eq(val, v)):
                return False
    return True


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, key, direction=1):
        if isinstance(key, list):
            key, direction = key[0]
        self.rows.sort(key=lambda d: str(get(d, key)[0]), reverse=direction == -1)
        return self

    def limit(self, n):
        self.rows = self.rows[:n] if n else self.rows
        return self

    async def to_list(self, n=None):
        return list(self.rows)

    def __aiter__(self):
        async def gen():
            for r in self.rows:
                yield r
        return gen()


class Coll:
    def __init__(self, rows=()):
        self.rows = [dict(r) for r in rows]
        self.calls = []

    def find(self, q=None, projection=None, **kw):
        self.calls.append(("find", q))
        return Cursor([dict(r) for r in self.rows if matches(r, q)])

    async def find_one(self, q=None, projection=None, **kw):
        self.calls.append(("find_one", q))
        return next((dict(r) for r in self.rows if matches(r, q)), None)

    async def count_documents(self, q=None, **kw):
        return sum(matches(r, q) for r in self.rows)

    async def update_one(self, q, update, upsert=False, **kw):
        self.calls.append(("update_one", q))
        for r in self.rows:
            if matches(r, q):
                for k, v in (update.get("$set") or {}).items():
                    r[k] = v
                for k, v in (update.get("$setOnInsert") or {}).items():
                    pass
                return
        if upsert:
            self.rows.append({**(update.get("$setOnInsert") or {}), **(update.get("$set") or {})})

    async def insert_one(self, doc, **kw):
        self.rows.append(dict(doc))

    async def delete_one(self, q, **kw):
        self.calls.append(("delete_one", q))
        for r in self.rows:
            if matches(r, q):
                self.rows.remove(r)
                return type("R", (), {"deleted_count": 1})()
        return type("R", (), {"deleted_count": 0})()


class Raw(dict):
    def __missing__(self, name):
        self[name] = Coll()
        return self[name]

    def __getattr__(self, name):
        return self[name]


def run(c):
    return asyncio.run(c)


def in_space(ws, coro_fn):
    async def go():
        scope.WORKSPACE.set(ws)
        return await coro_fn()
    return run(go())


# ---- Working now: another space's board jobs are not listed

def test_working_now_lists_only_this_spaces_board_jobs(monkeypatch):
    from backend import flashing, jobs, worknow
    raw = Raw()
    raw[jobs.JOBS] = Coll([{"_id": "1", "board": "mine", "workspace": "u1", "status": "running"},
                           {"_id": "2", "board": "theirs", "workspace": "default", "status": "running"}])

    async def working(db, t):
        return [], []
    monkeypatch.setattr(flashing, "working", working)
    monkeypatch.setattr(worknow, "_db", lambda: scope.ScopedDb(raw, "u1"))
    got = in_space("u1", worknow.now)
    assert [i["id"] for i in got["items"] if i["kind"] == "board"] == ["mine"]


# ---- the agents' way in

def agent_run(monkeypatch, ws, raw, body):
    monkeypatch.setattr(agent_api, "_db", lambda: scope.ScopedDb(raw, ws))
    return in_space(ws, lambda: agent_api._run(body))


def test_another_spaces_agents_cannot_reach_the_llm_log_or_its_cursor(monkeypatch):
    for coll in ("llm_calls", "meta"):
        with pytest.raises(HTTPException) as e:
            agent_run(monkeypatch, "u1", Raw(), {"coll": coll, "op": "find", "args": {}})
        assert e.value.status_code == 403
    # The owner's still do.
    raw = Raw(llm_calls=Coll([{"_id": "c1"}]))
    assert b"c1" in agent_run(monkeypatch, scope.DEFAULT, raw,
                              {"coll": "llm_calls", "op": "find", "args": {}}).body


def test_agents_read_only_their_drawer_and_another_space_cannot_write_the_cache(monkeypatch):
    raw = Raw(parts=Coll([{"_id": "C1", "spaces": ["u1"]}, {"_id": "C2"}, {"_id": "C3", "spaces": ["u2"]}]))
    got = agent_run(monkeypatch, "u1", raw, {"coll": "parts", "op": "find", "args": {}}).body
    assert b"C1" in got and b"C2" not in got and b"C3" not in got
    got = agent_run(monkeypatch, scope.DEFAULT, raw, {"coll": "parts", "op": "find", "args": {}}).body
    assert b"C2" in got and b"C1" not in got and b"C3" not in got
    for op, args in (("delete_one", {"filter": {"_id": "C1"}}),
                     ("update_one", {"filter": {"_id": "C1"}, "update": {"$set": {"x": 1}}}),
                     ("insert_one", {"doc": {"_id": "C9"}})):
        with pytest.raises(HTTPException) as e:
            agent_run(monkeypatch, "u1", raw, {"coll": "parts", "op": op, "args": args})
        assert e.value.status_code == 403
    assert len(raw["parts"].rows) == 3


def test_the_owners_agents_cannot_drop_a_part_another_drawer_holds(monkeypatch):
    raw = Raw(parts=Coll([{"_id": "C1", "spaces": ["default", "u1"]}, {"_id": "C2"}]))
    agent_run(monkeypatch, scope.DEFAULT, raw, {"coll": "parts", "op": "delete_one", "args": {"filter": {"_id": "C1"}}})
    agent_run(monkeypatch, scope.DEFAULT, raw, {"coll": "parts", "op": "delete_one", "args": {"filter": {"_id": "C2"}}})
    assert [r["_id"] for r in raw["parts"].rows] == ["C1"]


def owned(monkeypatch, ws, raw, bucket, fid):
    monkeypatch.setattr(agent_api, "_db", lambda: scope.ScopedDb(raw, ws))
    return in_space(ws, lambda: agent_api._owned(bucket, fid))


def test_a_stored_file_is_reached_only_from_its_own_space(monkeypatch):
    raw = Raw()
    raw["shots.files"] = Coll([{"_id": "f-u1", "metadata": {"workspace_id": "u1"}},
                               {"_id": "f-def", "metadata": {"workspace_id": "default"}},
                               {"_id": "f-old"}, {"_id": "f-old-u1"}])
    raw["revisions"] = Coll([{"_id": "r@u1", "workspace_id": "u1", "image": {"gridfs_id": "f-old-u1"}}])
    assert owned(monkeypatch, "u1", raw, "shots", "f-u1")
    assert not owned(monkeypatch, "u1", raw, "shots", "f-def")
    assert not owned(monkeypatch, "u1", raw, "shots", "f-old")            # from before: the default space's
    assert owned(monkeypatch, "u1", raw, "shots", "f-old-u1")             # ... unless its own note points at it
    assert owned(monkeypatch, scope.DEFAULT, raw, "shots", "f-old")
    assert owned(monkeypatch, scope.DEFAULT, raw, "shots", "f-def")
    assert not owned(monkeypatch, scope.DEFAULT, raw, "shots", "f-u1")
    assert not owned(monkeypatch, scope.DEFAULT, raw, "shots", "nope")


def test_a_spaces_bucket_stamps_its_new_files():
    from backend import store

    class Bucket:
        async def upload_from_stream(self, name, data, metadata=None):
            self.metadata = metadata
            return "id"
    b = Bucket()
    run(store._Stamped(b, "u1").upload_from_stream("x.png", b"", metadata={"k": 1}))
    assert b.metadata == {"k": 1, "workspace_id": "u1"}


# ---- the LLM-call log

def test_a_call_is_written_down_with_its_space():
    raw = Raw()
    in_space("u1", lambda: usage.record_call(raw, _id="x", provider="openrouter"))
    assert raw[usage.CALLS].rows[0]["workspace_id"] == "u1"


def test_each_space_counts_its_own_calls():
    rows = [{"_id": 1}, {"_id": 2, "workspace_id": "default"}, {"_id": 3, "workspace_id": "u1"},
            {"_id": 4, "at": "b"}]
    mine = lambda q: sorted(r["_id"] for r in rows if matches(r, q))  # noqa: E731
    assert mine(usage.of_space(scope.DEFAULT)) == [1, 2, 4]
    assert mine(usage.of_space("u1")) == [3]
    assert mine(insights._ws_match(scope.ScopedDb(Raw(), scope.DEFAULT), None)) == [1, 2, 4]
    assert mine(insights._ws_match(scope.ScopedDb(Raw(), "u1"), None)) == [3]
    # Unstamped calls made during one of the space's own runs are its too.
    assert mine(insights._ws_match(scope.ScopedDb(Raw(), "u1"), {"at": "b"})) == [3, 4]


def test_llm_usage_page_keeps_to_the_space(monkeypatch):
    from backend import llm_api
    raw = Raw()
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    raw[usage.CALLS] = Coll([{"provider": "openrouter", "at": now, "workspace_id": "u1", "kind": "summary"},
                             {"provider": "openrouter", "at": now, "kind": "summary"}])
    monkeypatch.setattr(llm_api, "_db", lambda: scope.ScopedDb(raw, "u1"))
    got = in_space("u1", lambda: llm_api.usage("openrouter", 30))
    assert got["totals"]["calls"] == 1


# ---- the LCSC journal and the proxy log

def test_the_lcsc_journal_is_read_per_space(monkeypatch, tmp_path):
    monkeypatch.setattr(lcsc, "_files", lambda: (None, tmp_path / "lock", tmp_path / "journal"))
    in_space("u1", lambda: asyncio.sleep(0, lcsc._record("search", "C1", "net")))
    scope.WORKSPACE.set(scope.DEFAULT)
    lcsc._record("search", "C2", "net")
    (tmp_path / "journal").write_text((tmp_path / "journal").read_text()
                                      + '{"at": "x", "kind": "search", "target": "C0", "source": "net"}\n')
    assert [r["target"] for r in lcsc.journal_of(10, "u1")] == ["C1"]
    assert [r["target"] for r in lcsc.journal_of(10, scope.DEFAULT)] == ["C0", "C2"]


# ---- the BOM's price refresh

def test_a_boms_refresh_is_kept_per_space(monkeypatch):
    monkeypatch.setattr(bom_cost, "to_refresh", lambda parts, force=False: [])
    in_space("u1", lambda: asyncio.sleep(0, bom_cost.start_refresh("controller", ["C1"])))
    assert in_space("u1", lambda: asyncio.sleep(0, bom_cost.job("controller")))
    assert in_space(scope.DEFAULT, lambda: asyncio.sleep(0, bom_cost.job("controller"))) is None


# ---- names: a pattern is not a name

def test_a_pattern_on_the_id_finds_the_spaces_documents():
    ids = scope.Ids("u1")
    assert ids.query({"_id": {"$regex": "^proj/"}}) == {"_id": {"$regex": "^proj/"}}
    assert ids.query({"_id": {"$in": ["a"]}}) == {"_id": {"$in": ["a@u1"]}}
    raw = Raw(models=Coll([{"_id": "proj/a@u1", "workspace_id": "u1"}, {"_id": "proj/b"}]))
    got = run(scope.ScopedDb(raw, "u1").models.find({"_id": {"$regex": "^proj/"}}).to_list(None))
    assert [d["_id"] for d in got] == ["proj/a"]


def test_the_proxy_page_counts_this_spaces_asks(monkeypatch):
    from datetime import datetime, timezone

    from backend import netproxy
    at = datetime.now(timezone.utc).isoformat()
    rows = [{"at": at, "kind": "search", "target": "C1", "source": "net", "status": 200, "ws": "u1"},
            {"at": at, "kind": "search", "target": "C2", "source": "net", "status": 200},
            {"at": at, "kind": "part", "target": "C3", "source": "net", "status": 200, "ws": "u2"}]
    monkeypatch.setattr(lcsc, "journal", lambda limit=200: rows)
    monkeypatch.setattr(netproxy, "_db_getter", None)
    got = in_space("u1", lambda: netproxy.usage(7))
    assert got["totals"]["lookups"] == 1 and [r["target"] for r in got["recent"]] == ["C1"]
    got = in_space(scope.DEFAULT, lambda: netproxy.usage(7))
    assert [r["target"] for r in got["recent"]] == ["C2"]
