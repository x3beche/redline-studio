"""Model builds are jobs of their own and outlive a reload of the API.

A build used to run as a child of the uvicorn worker: every save of a
backend file restarted the worker, cut the build's request and left its
export_model.py running as an orphan nobody read. Now a build is a
process of its own (backend/buildjobs.py) that writes its result to
`build_jobs`; the route waits for it (or answers 202 with `detach=1`), the
link scheduler waits for its rebuilds the same way and, after a restart,
sees through the ones still running instead of starting them again.

The runner is a task in this process here (conftest `_builds_in_process`),
except where a real process is the point.
"""

from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

import pytest

from backend import auth, build, buildjobs, links
from backend import main as M
from test_links import Builds, FakeDb, client, drain, model, run

H = {"x-redline-csrf": "1"}


@pytest.fixture
def api(monkeypatch):
    db = FakeDb()
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    db["models"].rows.append(model("p/part", "W = 1\nPARTS = []\n", ready=True))
    seen = {"secs": 0.3, "fail": None, "calls": 0}

    async def fake_build(d, mid, script):
        seen["calls"] += 1
        seen["job"] = build.JOB.get()
        await asyncio.sleep(seen["secs"])
        if seen["fail"]:
            raise seen["fail"]
        return {"model": mid, "artifacts": {"viewer": 12}, "log": "ok"}

    monkeypatch.setattr(build, "build", fake_build)
    return {"db": db, "seen": seen}


@pytest.mark.asyncio
async def test_a_waiting_request_gets_what_the_build_answered(api):
    async with client() as c:
        r = await c.post("/api/models/p/part/build", headers=H)
    assert r.status_code == 200, r.text
    assert r.json() == {"model": "p/part", "artifacts": {"viewer": 12}, "log": "ok"}
    job = api["db"]["build_jobs"].rows[0]
    assert job["status"] == "done" and job["by"] == "request"
    assert api["seen"]["job"] == job["_id"]              # build() knows its job


@pytest.mark.asyncio
async def test_detach_answers_202_and_the_job_has_the_result(api):
    async with client() as c:
        t0 = time.perf_counter()
        r = await c.post("/api/models/p/part/build?detach=1", headers=H)
        assert r.status_code == 202 and time.perf_counter() - t0 < 0.25
        job = r.json()
        assert job["status"] == "running" and job["model"] == "p/part"
        # One build per model: a second is refused while it runs.
        again = await c.post("/api/models/p/part/build?detach=1", headers=H)
        assert again.status_code == 409 and again.json()["detail"]["job"] == job["job"]
        for _ in range(100):
            got = (await c.get(f"/api/build-jobs/{job['job']}")).json()
            if got["status"] != "running":
                break
            await asyncio.sleep(0.02)
        assert got["status"] == "done" and got["result"]["artifacts"] == {"viewer": 12}
        listed = (await c.get("/api/build-jobs", params={"model": "p/part"})).json()
        assert listed[0]["job"] == job["job"] and "result" not in listed[0]
        assert (await c.get("/api/build-jobs/nope")).status_code == 404
    assert api["seen"]["calls"] == 1


@pytest.mark.asyncio
async def test_a_failed_build_answers_as_the_route_used_to(api):
    api["seen"].update(secs=0.01, fail=MemoryError("p/part: build exceeded the memory ceiling"))
    async with client() as c:
        r = await c.post("/api/models/p/part/build", headers=H)
        assert r.status_code == 500 and "memory ceiling" in r.json()["detail"]
        r = await c.post("/api/models/p/nothing/build", headers=H)
        assert r.status_code == 404
    assert api["db"]["build_jobs"].rows[0]["status"] == "failed"


def test_a_lost_build_clears_only_its_own_flag():
    db = FakeDb()
    old = datetime.now(timezone.utc) - timedelta(seconds=buildjobs.LOST + 5)
    db["build_jobs"].rows += [
        {"_id": "j1", "model": "p/a", "workspace": "default", "status": "running",
         "started_at": old, "beat": old},
        {"_id": "j2", "model": "p/b", "workspace": "default", "status": "running",
         "started_at": old, "beat": old}]
    db["models"].rows += [model("p/a", "", building=True, build_job="j1", build_started="t"),
                          model("p/b", "", building=True, build_job="j9", build_started="t")]
    assert sorted(run(buildjobs.recover(db))) == ["j1", "j2"]
    rows = {r["_id"]: r for r in db["models"].rows}
    assert rows["p/a"]["building"] is False and "build_job" not in rows["p/a"]
    assert rows["p/b"]["building"] is True               # another build's flag
    assert all(j["status"] == "lost" for j in db["build_jobs"].rows)


def test_a_runner_gone_from_this_namespace_is_lost_at_once():
    """Not LOST seconds later: its pid is not a runner of this job."""
    db = FakeDb()
    t = datetime.now(timezone.utc)
    me = buildjobs._pid_ns()
    db["build_jobs"].rows += [
        # pid 1 is not `backend.buildjobs gone`
        {"_id": "gone", "model": "p/a", "workspace": "default", "status": "running",
         "started_at": t, "beat": t, "pid": 1, "ns": me},
        # another namespace's pid says nothing here: its beat decides
        {"_id": "there", "model": "p/b", "workspace": "default", "status": "running",
         "started_at": t, "beat": t, "pid": 1, "ns": "pid:[1]"}]
    assert run(buildjobs.recover(db)) == ["gone"]


def test_reap_kills_builds_nobody_will_read_and_leaves_the_rest():
    db = FakeDb()
    t = datetime.now(timezone.utc)
    db["build_jobs"].rows += [
        {"_id": "live", "model": "p/a", "workspace": "default", "status": "running",
         "started_at": t, "beat": t},
        {"_id": "over", "model": "p/b", "workspace": "default", "status": "done"}]
    procs = [{"pid": 101, "ppid": 50, "job": "live"},      # its job runs: kept
             {"pid": 102, "ppid": 50, "job": "over"},      # its job is done: killed
             {"pid": 103, "ppid": 1, "job": "nojob"},      # its job is unknown: killed
             {"pid": 104, "ppid": 1, "job": None},         # from the worker, orphaned: killed
             {"pid": 105, "ppid": 77, "job": None}]        # the CLI's, its parent alive: kept
    killed = []
    got = run(buildjobs.reap_orphans(db, procs, kill=lambda pid, sig: killed.append(pid)))
    assert killed == [102, 103, 104] == [p["pid"] for p in got]


def test_an_orphaned_export_model_process_is_found_and_killed(tmp_path):
    """For real: a process running a script called export_model.py, with
    the job it belongs to in its environment, the way the runner starts it."""
    script = tmp_path / "export_model.py"
    script.write_text("import time\ntime.sleep(60)\n")
    proc = subprocess.Popen([sys.executable, str(script), "x"],
                            env={**os.environ, buildjobs.ENV: "j-over"})
    try:
        for _ in range(100):
            found = [p for p in buildjobs._builds() if p["pid"] == proc.pid]
            if found:
                break
            time.sleep(0.02)
        assert found and found[0]["job"] == "j-over" and found[0]["ppid"] == os.getpid()
        db = FakeDb()
        db["build_jobs"].rows.append({"_id": "j-over", "status": "lost"})
        mine = [p for p in buildjobs._builds() if p["pid"] == proc.pid]
        got = run(buildjobs.reap_orphans(db, mine))
        assert [p["pid"] for p in got] == [proc.pid]
        assert proc.wait(timeout=5) == -signal.SIGKILL
    finally:
        if proc.poll() is None:
            proc.kill()


def test_the_runner_is_in_its_own_session_with_its_job_in_the_environment(tmp_path, monkeypatch):
    out = tmp_path / "seen"
    monkeypatch.setattr(buildjobs, "LOGS", tmp_path / "logs")
    monkeypatch.setattr(buildjobs, "runner_argv", lambda job_id: [
        sys.executable, "-c",
        f"import os; open({str(out)!r}, 'w').write(f'{{os.getsid(0)}} {{os.environ[{buildjobs.ENV!r}]}}')"])
    pid = buildjobs._popen("t1")
    for _ in range(100):
        if out.exists() and out.read_text():
            break
        time.sleep(0.05)
    sid, job = out.read_text().split()
    assert int(sid) == pid != os.getsid(0) and job == "t1"


# ---------------------------------------------------------------- the link queue

def test_after_a_restart_a_rebuild_still_running_is_seen_through_not_redone(monkeypatch):
    db = FakeDb()
    monkeypatch.setattr(links, "DEBOUNCE", 0)
    db["models"].rows += [
        model("p/a", "W = 1\n"),
        model("p/b", "import a\n", link={"state": "building", "token": "t1"}),
        model("p/c", "import a\n", link={"state": "building", "token": "t2"})]

    async def lookup(d, mid, token):            # p/b's job outlived the reload; p/c's did not
        return {"_id": "job-b"} if mid == "p/b" else None

    adopt: list = []
    assert run(links.recover(db, lookup, adopt)) == 1
    assert adopt == [("p/b", "t1", "job-b")]
    rows = {r["_id"]: r for r in db["models"].rows}
    assert rows["p/c"]["link"]["state"] == "queued"
    assert rows["p/b"]["link"]["state"] == "building"

    seen = []

    async def builder(d, mid, job=None):
        seen.append((mid, job))
        return {}

    async def go():
        sched = links.Scheduler(builder)
        g = await links.load(db, write_back=False)
        sched.adopt(db, "default", "p/b", "t1", "job-b", g)
        await sched.idle()

    run(go())
    assert seen == [("p/b", "job-b")]
    assert {r["_id"]: r for r in db["models"].rows}["p/b"]["link"]["state"] == "done"


def test_a_rebuild_of_a_model_being_built_waits_its_turn(monkeypatch):
    """Somebody is building it by hand: the rebuild is queued again behind
    that build, not marked failed."""
    db = FakeDb()
    monkeypatch.setattr(links, "DEBOUNCE", 0)
    db["models"].rows += [model("p/a", "W = 1\n"), model("p/b", "import a\n")]

    class Busy(Builds):
        async def __call__(self, d, mid):
            raise buildjobs.Busy({"_id": "j", "model": mid})

    async def go():
        await links.changed(db, "model", "p/a")
        sched = links.Scheduler(Busy())
        await sched.tick(db)
        await sched.idle()

    run(go())
    link = {r["_id"]: r for r in db["models"].rows}["p/b"]["link"]
    assert link["state"] == "queued" and link["due"] > datetime.now(timezone.utc).isoformat()
    assert "error" not in link


@pytest.mark.asyncio
async def test_a_link_rebuild_is_a_build_job_and_its_result_reaches_the_queue(api, monkeypatch):
    db = api["db"]
    db["models"].rows.append(model("p/tray", "import part\nPARTS = []\n", ready=True,
                                   link={"state": "building", "token": "tok",
                                         "because": {"id": "p/part", "version": 2}}))

    async def quiet(*a, **kw):
        return {}
    monkeypatch.setattr(M, "say", quiet)
    out = await M._link_build(M.db(), "p/tray")
    assert out["model"] == "p/tray"
    job = next(j for j in db["build_jobs"].rows if j["model"] == "p/tray")
    assert job["by"] == "link" and job["link_token"] == "tok" and job["status"] == "done"
    # And after a restart, the queue finds it by its token.
    assert (await M._link_job(M.db(), "p/tray", "tok"))["_id"] == job["_id"]
    assert await M._link_job(M.db(), "p/tray", "other") is None
