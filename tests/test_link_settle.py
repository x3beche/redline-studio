"""A burst of versions is one rebuild of what uses it (backend/links.py).

An agent iterating on a part saves v56, v57, v58... a minute or two apart
and builds each; every one of them used to rebuild everything that imports
the part, and the machine ran at 90 °C. What has to hold now:

- a change settles DEBOUNCE before its dependents rebuild, a newer version
  of the same component starts the wait again and takes the reason's place
  ("a v5 changed (and 4 earlier)"), never past SETTLE_MAX;
- while the component itself is being built, what uses it waits, and says so;
- a dependent already rebuilding is let finish and rebuilt once more after,
  however many versions came meanwhile; a newer version is tried even when
  the older one broke it;
- a dependent of a dependent waits for its parent;
- builds asked for directly count against PARALLEL.
"""

from __future__ import annotations

import asyncio

import pytest

import test_links as T
from backend import jobs, links, store


@pytest.fixture
def db():
    return T.FakeDb()


def row(db, mid):
    return next(r for r in db["models"].rows if r["_id"] == mid)


async def burst(db, sched, versions=5, gap=0.05, source_builds=0.0, first=1):
    """`versions` saves of p/a, each built for `source_builds` seconds (the
    agent's own build of it), the scheduler ticking all the while."""
    for v in range(first, first + versions):
        await links.changed(db, "model", "p/a", version=v)
        if source_builds:
            row(db, "p/a")["building"] = True
            for _ in range(int(source_builds / 0.02)):
                await sched.tick(db)
                await asyncio.sleep(0.02)
            row(db, "p/a")["building"] = False
        for _ in range(max(1, int(gap / 0.02))):
            await sched.tick(db)
            await asyncio.sleep(0.02)


def test_a_burst_of_five_versions_is_one_rebuild_and_says_so(db, monkeypatch):
    monkeypatch.setattr(links, "DEBOUNCE", 0.3)
    db["models"].rows += [T.model("p/a", "W = 1\n"), T.model("p/b", "import a\n")]

    async def go():
        builds = T.Builds()
        sched = links.Scheduler(builds)
        await burst(db, sched)
        link = row(db, "p/b")["link"]
        assert link["state"] == "queued" and link["because"]["version"] == 5
        assert links.why_text(link["because"]) == "a v5 changed (and 4 earlier)"
        await T.drain(db, sched, rounds=100)
        return builds

    assert run(go()).order == ["p/b"]                  # was five, one per version


def test_while_the_component_builds_its_users_wait_then_build_once_in_order(db, monkeypatch):
    """The cascade in the logs: Enclosure saved and built five times; the lid
    on it and the assembly on the lid used to rebuild after each one."""
    monkeypatch.setattr(links, "DEBOUNCE", 0.15)
    db["models"].rows += [T.model("p/a", "W = 1\n"), T.model("p/b", "import a\n"),
                          T.model("p/c", "import b\n")]

    async def go():
        builds = T.Builds()
        sched = links.Scheduler(builds, parallel=2)
        await links.changed(db, "model", "p/a", version=1)
        row(db, "p/a")["building"] = True
        await asyncio.sleep(0.2)                       # past the debounce, still building
        await sched.tick(db)
        assert builds.order == []
        assert row(db, "p/b")["link"]["wait"] == "after a builds"
        row(db, "p/a")["building"] = False
        await burst(db, sched, versions=4, gap=0.05, source_builds=0.3, first=2)
        assert builds.order == []                      # every gap shorter than the settling
        await T.drain(db, sched, rounds=100)
        return builds

    builds = run(go())
    assert builds.order == ["p/b", "p/c"]              # was ten: two per version
    assert row(db, "p/c")["link"]["state"] == "done"
    assert links.why_text(row(db, "p/c")["link"]["because"]) == "a v5 changed (and 4 earlier)"


def test_a_rebuild_running_when_new_versions_come_finishes_and_runs_once_more(db, monkeypatch):
    monkeypatch.setattr(links, "DEBOUNCE", 0)
    db["models"].rows += [T.model("p/a", "W = 1\n"), T.model("p/b", "import a\n")]

    async def go():
        builds = T.Builds(secs=0.3)
        sched = links.Scheduler(builds)
        await links.changed(db, "model", "p/a", version=1)
        await sched.tick(db)
        for v in (2, 3, 4):
            await asyncio.sleep(0.03)
            await links.changed(db, "model", "p/a", version=v)
        link = row(db, "p/b")["link"]
        assert link["state"] == "building"             # still truthfully building
        assert link["because"]["version"] == 1
        assert links.why_text(link["next"]["because"]) == "a v4 changed (and 2 earlier)"
        await sched.idle()
        link = row(db, "p/b")["link"]
        assert link["state"] == "queued" and link["because"]["version"] == 4
        assert "next" not in link
        await T.drain(db, sched)
        return builds

    assert run(go()).order == ["p/b", "p/b"]           # was four


def test_a_newer_version_is_tried_after_an_older_one_broke_it(db, monkeypatch):
    monkeypatch.setattr(links, "DEBOUNCE", 0)
    db["models"].rows += [T.model("p/a", "W = 1\n"), T.model("p/b", "import a\n"),
                          T.model("p/c", "import b\n")]

    async def go():
        builds = T.Builds(fail={"p/b"}, secs=0.2)
        sched = links.Scheduler(builds)
        await links.changed(db, "model", "p/a", version=1)
        await sched.tick(db)
        await asyncio.sleep(0.05)
        await links.changed(db, "model", "p/a", version=2)
        await sched.idle()
        assert row(db, "p/b")["link"]["state"] == "queued"
        assert row(db, "p/c")["link"]["state"] == "queued"     # not blocked by the old failure
        builds.fail.clear()
        await T.drain(db, sched)
        return builds

    assert run(go()).order == ["p/b", "p/b", "p/c"]


def test_settling_never_waits_past_its_ceiling(db, monkeypatch):
    monkeypatch.setattr(links, "DEBOUNCE", 60)
    monkeypatch.setattr(links, "SETTLE_MAX", 0.2)
    db["models"].rows += [T.model("p/a", "W = 1\n"), T.model("p/b", "import a\n")]

    async def go():
        builds = T.Builds()
        sched = links.Scheduler(builds)
        await links.changed(db, "model", "p/a", version=1)
        await asyncio.sleep(0.25)
        await links.changed(db, "model", "p/a", version=2)     # would push it out a minute
        assert row(db, "p/b")["link"]["due"] <= store.now()
        await T.drain(db, sched)
        return builds

    assert run(go()).order == ["p/b"]


def test_builds_asked_for_directly_count_against_the_limit(db, monkeypatch):
    monkeypatch.setattr(links, "DEBOUNCE", 0)
    db.raw = T.FakeDb()
    db.raw["build_jobs"].rows.append({"_id": "j1", "model": "p/x", "by": "request",
                                      "status": "running", "started_at": jobs.now(),
                                      "beat": jobs.now()})
    db["models"].rows += [T.model("p/a", "W = 1\n"), T.model("p/b", "import a\n"),
                          T.model("p/c", "import a\n")]

    async def go():
        builds = T.Builds(secs=0.1)
        sched = links.Scheduler(builds, parallel=2)
        await links.changed(db, "model", "p/a")
        assert len(await sched.tick(db)) == 1          # one slot left beside the agent's build
        waiting = [r for r in db["models"].rows if (r.get("link") or {}).get("state") == "queued"]
        assert [r["link"]["wait"] for r in waiting] == ["2 builds running"]
        db.raw["build_jobs"].rows[0]["status"] = "done"
        await T.drain(db, sched)
        return builds

    builds = run(go())
    assert sorted(builds.order) == ["p/b", "p/c"]


def test_after_a_restart_the_change_waiting_behind_a_rebuild_is_the_reason(db):
    db["models"].rows.append(T.model("p/b", "import a\n", building=True, link={
        "state": "building", "token": "t", "because": {"kind": "model", "id": "p/a", "version": 1},
        "next": {"token": "u", "because": {"kind": "model", "id": "p/a", "version": 3, "earlier": 1}}}))
    assert run(links.recover(db)) == 1
    link = db["models"].rows[0]["link"]
    assert link["state"] == "queued" and link["token"] == "u" and link["because"]["version"] == 3
    assert "next" not in link


def test_reasons_merge_and_read_well():
    a = {"kind": "model", "id": "p/enc", "title": "Enclosure"}
    lid = {"kind": "model", "id": "p/lid", "title": "Lid"}
    b = links.merge_because({**a, "version": 56}, {**a, "version": 57})
    b = links.merge_because(b, {**lid, "version": 3})
    b = links.merge_because(b, {**a, "version": 58})
    assert links.why_text(b) == "Enclosure v58 changed (and 2 earlier); also Lid v3"
    pin = links.merge_because(b, {**a, "version": 50, "pin": "pinned"})
    assert links.why_text(pin) == "Enclosure v50 was pinned"


def run(coro):
    return asyncio.run(coro)


@pytest.mark.asyncio
async def test_working_now_says_what_a_rebuild_waits_for(monkeypatch):
    raw = T.FakeDb()
    monkeypatch.setattr(T.M, "_raw_db", lambda: raw)
    monkeypatch.setattr(T.auth, "enabled", lambda: False)
    enc = {"kind": "model", "id": "p/enc", "title": "Enclosure", "version": 60, "earlier": 2}
    raw["models"].rows += [
        T.model("p/lid", "import enc\n", link={"state": "queued", "because": enc, "due": links._later(18)}),
        T.model("p/asm", "import lid\n", link={"state": "queued", "because": enc, "due": store.now(),
                                               "wait": "after lid"}),
        T.model("p/base", "import enc\n", building=True, build_started=store.now(), link={
            "state": "building", "because": {**enc, "version": 58, "earlier": 0},
            "next": {"because": enc}})]
    async with T.client() as c:
        items = {i["id"]: i for i in (await c.get("/api/work/now")).json()["items"]}
    assert items["p/lid"]["state"] == "queued"
    assert items["p/lid"]["why"] == "Enclosure v60 changed (and 2 earlier)"
    assert items["p/lid"]["wait"] in ("settling, 17s", "settling, 18s")
    assert items["p/asm"]["wait"] == "after lid"
    assert items["p/base"]["state"] == "building" and items["p/base"]["why"] == "Enclosure v58 changed"
    assert items["p/base"]["wait"] == "then again · Enclosure v60 changed (and 2 earlier)"
