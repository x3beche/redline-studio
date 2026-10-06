"""The long board steps run as jobs, and the API answers while they do.

What froze the API during a board run (2026-10-06) was not the event loop:
a reload waited for the run's open request to finish, and nothing was
accepted on the port meanwhile. So a run, a conversion and a layout are
jobs of their own (backend/jobs.py): the request that starts one is
answered at once, the work happens in a process of its own, and a request
that chooses to wait for it waits without holding anybody else up.

Here the runner process is stood in for by a task in this process doing a
"step" that takes real time - a subprocess that sleeps, as KiCad and
Freerouting are subprocesses - while other requests are timed.
"""

from __future__ import annotations

import asyncio
import copy
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi import HTTPException

from backend import auth, jobs, kicad
from backend import main as M


# ---------------------------------------------------------------- a small Mongo

def _get(doc, key):
    for part in key.split("."):
        if not isinstance(doc, dict) or part not in doc:
            return None, False
        doc = doc[part]
    return doc, True


def _match(doc, q) -> bool:
    for k, v in (q or {}).items():
        if k == "$and":
            if not all(_match(doc, x) for x in v):
                return False
            continue
        if k == "$or":
            if not any(_match(doc, x) for x in v):
                return False
            continue
        got, has = _get(doc, k)
        if isinstance(v, dict) and any(op.startswith("$") for op in v):
            for op, a in v.items():
                if op == "$exists" and has != bool(a):
                    return False
                if op == "$ne" and got == a:
                    return False
                if op == "$in" and got not in a:
                    return False
        elif got != v:
            return False
    return True


class Res:
    def __init__(self, n=1):
        self.matched_count = self.modified_count = self.deleted_count = n
        self.inserted_id = None
        self.upserted_id = None


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, key, direction=1):
        self.rows.sort(key=lambda r: r.get(key) or 0, reverse=direction < 0)
        return self

    def limit(self, n):
        self.rows = self.rows[:n]
        return self

    def __aiter__(self):
        async def gen():
            for r in self.rows:
                yield r
        return gen()


class Coll:
    def __init__(self):
        self.rows: list[dict] = []

    async def insert_one(self, doc, *a, **kw):
        self.rows.append(copy.deepcopy(doc))
        return Res()

    async def find_one(self, q=None, projection=None, *a, **kw):
        row = next((r for r in self.rows if _match(r, q)), None)
        return copy.deepcopy(row) if row else None

    def find(self, q=None, projection=None, *a, **kw):
        return Cursor([copy.deepcopy(r) for r in self.rows if _match(r, q)])

    async def update_one(self, q, update, *a, **kw):
        row = next((r for r in self.rows if _match(r, q)), None)
        if row is None:
            return Res(0)
        for k, v in (update.get("$set") or {}).items():
            row[k] = copy.deepcopy(v)
        return Res(1)

    async def count_documents(self, q=None, **kw):
        return sum(1 for r in self.rows if _match(r, q))


class FakeDb:
    def __init__(self):
        self.colls: dict[str, Coll] = {}

    def __getitem__(self, name):
        return self.colls.setdefault(name, Coll())

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]

    async def command(self, *a, **kw):
        return {"ok": 1}


# ---------------------------------------------------------------- the app, faked

@pytest.fixture
def app(monkeypatch):
    raw = FakeDb()
    raw["boards"].rows.append({"_id": "demo"})
    monkeypatch.setattr(M, "_raw_db", lambda: raw)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    monkeypatch.setattr(jobs, "POLL", 0.05)
    seen = {"steps": [], "tasks": []}

    async def step(kind, board, body):
        # A long KiCad/Freerouting step: real time spent in a subprocess.
        seen["steps"].append((kind, board))
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-c", f"import time; time.sleep({seen.get('long', 1.5)})")
        await proc.wait()
        if seen.get("fail"):
            raise HTTPException(400, "the routing rules do not fit this board: x")
        return {"board": board, "kind": kind, "unrouted": 0}

    async def spawn(db, job_id):
        job = await db[jobs.JOBS].find_one({"_id": job_id})
        seen["tasks"].append(asyncio.create_task(jobs.execute(db, job, step)))
        return 4242

    monkeypatch.setattr(jobs, "spawn", spawn)
    return {"raw": raw, "seen": seen, "app": M.app}


def client(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app["app"]),
                             base_url="http://test")


async def timed(c, path):
    t0 = time.perf_counter()
    r = await c.get(path)
    return r.status_code, time.perf_counter() - t0


@pytest.mark.asyncio
async def test_a_detached_run_answers_at_once_and_the_api_keeps_answering(app):
    async with client(app) as c:
        t0 = time.perf_counter()
        r = await c.post("/api/boards/demo/run?detach=1", json={})
        assert r.status_code == 202, r.text
        assert time.perf_counter() - t0 < 0.5
        job = r.json()
        assert job["status"] == "running" and job["kind"] == "run"

        # While the step runs, everything else answers - fast.
        for _ in range(5):
            code, took = await timed(c, "/api/health")
            assert code == 200 and took < 0.3, took
            got = (await c.get(f"/api/boards/demo/jobs/{job['job']}")).json()
            assert got["status"] == "running"
            await asyncio.sleep(0.1)

        await asyncio.gather(*app["seen"]["tasks"])
        got = (await c.get(f"/api/boards/demo/jobs/{job['job']}")).json()
        assert got["status"] == "done"
        assert got["result"] == {"board": "demo", "kind": "run", "unrouted": 0}
        listed = (await c.get("/api/boards/demo/jobs")).json()
        assert listed[0]["job"] == job["job"] and "result" not in listed[0]


@pytest.mark.asyncio
async def test_a_request_that_waits_for_its_run_holds_nobody_else_up(app):
    async with client(app) as c:
        run = asyncio.create_task(c.post("/api/boards/demo/run", json={}))
        await asyncio.sleep(0.2)
        assert not run.done()
        lags = []
        while not run.done():
            code, took = await timed(c, "/api/health")
            assert code == 200
            lags.append(took)
            await asyncio.sleep(0.05)
        r = await run
        # The waiting request answers as the step itself would have.
        assert r.status_code == 200 and r.json()["unrouted"] == 0
        assert len(lags) >= 5 and max(lags) < 0.3, lags


@pytest.mark.asyncio
async def test_a_failed_step_answers_with_its_own_status_and_detail(app):
    app["seen"]["fail"] = True
    app["seen"]["long"] = 0.1
    async with client(app) as c:
        r = await c.post("/api/boards/demo/run", json={})
        assert r.status_code == 400
        assert "do not fit" in r.json()["detail"]


@pytest.mark.asyncio
async def test_one_job_per_board_at_a_time(app):
    async with client(app) as c:
        first = (await c.post("/api/boards/demo/run?detach=1", json={})).json()
        again = await c.post("/api/boards/demo/convert?detach=1", json={"bom": None})
        assert again.status_code == 409
        assert again.json()["detail"]["job"] == first["job"]
        await asyncio.gather(*app["seen"]["tasks"])
        # Done, a new one may start.
        assert (await c.post("/api/boards/demo/layout?detach=1", json={})).status_code == 202
        await asyncio.gather(*app["seen"]["tasks"])


@pytest.mark.asyncio
async def test_unknown_board_and_unknown_job(app):
    async with client(app) as c:
        assert (await c.post("/api/boards/nope/run?detach=1", json={})).status_code == 404
        assert (await c.get("/api/boards/demo/jobs/abc")).status_code == 404
    assert app["seen"]["steps"] == []


@pytest.mark.asyncio
async def test_a_runner_that_stopped_answering_is_lost_not_running_forever():
    db = FakeDb()
    old = datetime.now(timezone.utc) - timedelta(seconds=jobs.LOST + 5)
    db[jobs.JOBS].rows.append({"_id": "j1", "kind": "run", "board": "b", "workspace": "default",
                               "status": "running", "started_at": old, "beat": old})
    got = await jobs.get(db, "j1")
    assert got["status"] == "lost"
    view = jobs.view(got)
    assert view["code"] == 500 and "stopped answering" in view["detail"]


@pytest.mark.asyncio
async def test_a_lost_job_does_not_keep_the_board_busy(monkeypatch):
    db = FakeDb()
    old = datetime.now(timezone.utc) - timedelta(seconds=jobs.LOST + 5)
    db[jobs.JOBS].rows.append({"_id": "j1", "kind": "run", "board": "b", "workspace": "default",
                               "status": "running", "started_at": old, "beat": old})

    async def spawn(db, job_id):
        return 1
    monkeypatch.setattr(jobs, "spawn", spawn)
    job = await jobs.start(db, "run", "b", {}, workspace="default")
    assert job["status"] == "running"
    assert (await jobs.get(db, "j1"))["status"] == "lost"


def test_the_runner_starts_in_a_session_of_its_own(tmp_path, monkeypatch):
    """So a reload's signal to the API's process group never reaches it."""
    out = tmp_path / "sid"
    monkeypatch.setattr(jobs, "LOGS", tmp_path / "logs")
    monkeypatch.setattr(jobs, "runner_argv", lambda job_id: [
        sys.executable, "-c", f"import os; open({str(out)!r}, 'w').write(str(os.getsid(0)))"])
    pid = jobs._popen("t1")
    for _ in range(100):
        if out.exists() and out.read_text():
            break
        time.sleep(0.05)
    assert int(out.read_text()) == pid != os.getsid(0)


@pytest.mark.asyncio
async def test_a_container_step_does_not_stall_the_event_loop(tmp_path):
    """kicad._run - how every KiCad container step is started - waits on
    its process without blocking: a ticker keeps ticking meanwhile."""
    ticks = []

    async def ticker():
        while True:
            ticks.append(time.perf_counter())
            await asyncio.sleep(0.05)

    t = asyncio.create_task(ticker())
    rc, _ = await kicad._run([sys.executable, "-c", "import time; time.sleep(1)"], tmp_path)
    t.cancel()
    assert rc == 0
    gaps = [b - a for a, b in zip(ticks, ticks[1:])]
    assert len(ticks) >= 12 and max(gaps) < 0.3, max(gaps)
