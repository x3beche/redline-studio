"""Scheduled tasks (backend/sched): the loop's lease, one run per slot
however many look, missed slots, retries, time limits, the kill switch, how
many at once, the cost caps, rights at making and at running time, each task
type with its sources faked, where results go (the Telegram send queue, the
notification centre, Files), the routes and the chat tools. The database and
the bot are test_telegram's fakes; a run's runner is a task in this process."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from backend import access, actors, app_links, auth, scope
from backend.sched import api, core, cron, deliver, kinds, runner
from backend.tgbot import core as tg
from test_telegram import configured, drain, env, linked, run  # noqa: F401 - env is a fixture

UTC = timezone.utc
T0 = datetime(2026, 10, 19, 6, 0, 30, tzinfo=UTC)          # Monday 09:00:30 in Istanbul


@pytest.fixture
def sch(env, monkeypatch):
    """The scheduler on the fake database; runners run here, settings need no loading."""
    monkeypatch.setattr(api, "_raw", lambda: env.db)
    started = []

    async def spawn(raw, rid):
        started.append(rid)
        task = asyncio.ensure_future(runner.execute(raw, rid, load=_noload))
        _TASKS.add(task)
        return 0
    monkeypatch.setattr(core, "spawn", spawn)
    env.started = started
    tokens = access.ROLE.set("owner")
    yield env
    access.ROLE.reset(tokens)


_TASKS: set = set()


async def _noload(db):
    return None


def settle():
    async def go():
        for _ in range(50):
            await asyncio.sleep(0)
        while _TASKS:
            t = _TASKS.pop()
            await t
    run(go())


def echo_kind(monkeypatch, **kw):
    """A type of the test's own: says what it was given."""
    calls = []

    async def go(ctx, p):
        calls.append(p)
        if kw.get("boom"):
            raise RuntimeError(kw["boom"])
        if kw.get("sleep"):
            await asyncio.sleep(kw["sleep"])
        ctx.spent += kw.get("cost", 0)
        return kinds.Outcome(f"echo {p['n']}", f"**echo** {p['n']}\n\n| a | b |\n|---|---|\n| 1 | 2 |", {"n": p["n"]},
                             csv="a,b\n1,2\n", cost_usd=kw.get("cost"))
    k = kinds.Kind("echo", "Echo", "says what it was given", [kinds.Param("n", "int", "N", 1, 0, 100)], go,
                   right=kw.get("right", "draw"), llm=kw.get("llm", False), rerun_safe=kw.get("rerun_safe", True),
                   exclusive=kw.get("exclusive", ""), timeout_s=60, table=True)
    monkeypatch.setitem(kinds.KINDS, "echo", k)
    return calls


def make(db, tid="t1", type_="echo", schedule=None, enabled=True, next_run=None, **extra):
    t = core.clean({"type": type_, "name": extra.pop("name", "Echo task"), "params": extra.pop("params", {}),
                    "schedule": schedule or {"kind": "weekly", "days": [1], "at": "09:00"},
                    "deliver": extra.pop("deliver", {"inapp": False}), **{k: extra.pop(k) for k in list(extra)
                                                                       if k in ("timeout_s", "retries", "grace_min", "month_usd")}})
    doc = {"_id": tid, **t, "enabled": enabled, "owner": {"id": "local", "name": "you"}, "workspace": scope.DEFAULT,
           "next_run": next_run, "last": None, "fails": 0, **extra}
    db[core.TASKS].docs[tid] = doc
    return doc


def runs(db, task=None):
    return sorted([r for r in db[core.RUNS].docs.values() if task is None or r["task"] == task], key=lambda r: r["at"])


# ---------------------------------------------------------------- the lease

def test_one_loop_holds_the_lease_and_a_dead_holder_is_taken_over(sch, monkeypatch):
    a = {"host": "h", "pid": 11, "boot": "A", "ns": "ns1"}
    b = {"host": "h", "pid": 12, "boot": "B", "ns": "ns1"}
    monkeypatch.setattr(core, "_alive", lambda pid: True)
    assert run(core.hold_lease(sch.db, T0, a)) is True
    assert run(core.hold_lease(sch.db, T0, b)) is False
    assert run(core.hold_lease(sch.db, T0 + timedelta(seconds=10), a)) is True          # renewed
    assert run(core.hold_lease(sch.db, T0 + timedelta(seconds=10 + core.LEASE_S + 1), b)) is True   # ran out
    # A reload: the holder's process is gone in this namespace - taken at once.
    monkeypatch.setattr(core, "_alive", lambda pid: pid != 12)
    c = {"host": "h", "pid": 13, "boot": "C", "ns": "ns1"}
    assert run(core.hold_lease(sch.db, T0 + timedelta(seconds=60), c)) is True


# ---------------------------------------------------------------- one slot, one run

def test_a_due_slot_is_claimed_once_however_many_look(sch, monkeypatch):
    echo_kind(monkeypatch)
    make(sch.db, next_run=datetime(2026, 10, 19, 6, 0, tzinfo=UTC))

    async def both():
        return await asyncio.gather(core.claim_due(sch.db, T0), core.claim_due(sch.db, T0))
    a, b = run(both())
    assert len(a) + len(b) == 1
    rows = runs(sch.db)
    assert [r["_id"] for r in rows] == ["t1@20261019T0600Z"] and rows[0]["status"] == "queued"
    # moved on to next Monday
    assert sch.db[core.TASKS].docs["t1"]["next_run"] == datetime(2026, 10, 26, 6, 0, tzinfo=UTC)
    # A tick after a reload that read the old next_run claims nothing; nor does writing the slot twice.
    assert run(core.claim_due(sch.db, T0)) == []
    assert run(core.insert_run(sch.db, {**rows[0]})) is False


def test_a_tick_runs_it_and_the_task_remembers_its_last(sch, monkeypatch):
    calls = echo_kind(monkeypatch)
    make(sch.db, next_run=datetime(2026, 10, 19, 6, 0, tzinfo=UTC), params={"n": 7})
    got = run(core.tick(sch.db, T0))
    settle()
    assert got["started"] == ["t1@20261019T0600Z"] and calls == [{"n": 7}]
    r = runs(sch.db)[0]
    assert r["status"] == "done" and r["summary"] == "echo 7" and "**echo** 7" in r["output"]
    t = sch.db[core.TASKS].docs["t1"]
    assert t["last"]["status"] == "done" and t["last"]["summary"] == "echo 7" and t["fails"] == 0


# ---------------------------------------------------------------- missed slots

def test_a_slot_missed_within_the_grace_runs_once_older_ones_are_recorded_missed(sch, monkeypatch):
    echo_kind(monkeypatch)
    # Hourly; the API was down from 01:00 to 05:40 UTC; grace 60 minutes.
    make(sch.db, schedule={"kind": "hours", "every": 1, "minute": 0}, next_run=datetime(2026, 10, 19, 1, 0, tzinfo=UTC),
         grace_min=60)
    made = run(core.claim_due(sch.db, datetime(2026, 10, 19, 5, 40, tzinfo=UTC)))
    st = {r["status"]: r for r in made}
    assert set(st) == {"missed", "queued"}
    assert st["missed"]["missed"] == 4 and st["missed"]["summary"].startswith("4 runs missed")
    assert st["queued"]["slot"] == datetime(2026, 10, 19, 5, 0, tzinfo=UTC)
    assert sch.db[core.TASKS].docs["t1"]["next_run"] == datetime(2026, 10, 19, 6, 0, tzinfo=UTC)


def test_beyond_the_grace_nothing_runs_late(sch, monkeypatch):
    echo_kind(monkeypatch)
    make(sch.db, next_run=datetime(2026, 10, 19, 6, 0, tzinfo=UTC), grace_min=30)
    made = run(core.claim_due(sch.db, datetime(2026, 10, 19, 9, 0, tzinfo=UTC)))
    assert [r["status"] for r in made] == ["missed"] and made[0]["missed"] == 1
    assert sch.db[core.TASKS].docs["t1"]["last"]["status"] == "missed"


# ---------------------------------------------------------------- retries, losses, time limits

def test_a_failure_is_tried_again_after_a_pause_then_given_up(sch, monkeypatch):
    calls = echo_kind(monkeypatch, boom="the site said 503")
    make(sch.db, next_run=datetime(2026, 10, 19, 6, 0, tzinfo=UTC), retries=1)
    run(core.tick(sch.db, T0))
    settle()
    first, retry = sorted(runs(sch.db), key=lambda r: r["attempt"])
    assert first["status"] == "failed" and "503" in first["error"]
    assert retry["status"] == "queued" and retry["trigger"] == "retry" and retry["attempt"] == 2
    assert retry["not_before"] > core.now() + timedelta(seconds=core.BACKOFF[0] - 5)
    # Not before its time; then it runs, fails again, and no third try (retries = 1).
    assert run(core.start_queued(sch.db, core.now())) == []
    later = retry["not_before"] + timedelta(seconds=1)
    assert run(core.start_queued(sch.db, later)) == [retry["_id"]]
    settle()
    assert [r["status"] for r in runs(sch.db)] == ["failed", "failed"] and len(calls) == 2
    assert len(runs(sch.db)) == 2                                            # no third try
    assert sch.db[core.TASKS].docs["t1"]["fails"] == 2


def test_a_runner_gone_quiet_is_interrupted_and_run_again_only_when_safe(sch, monkeypatch):
    echo_kind(monkeypatch, rerun_safe=False)
    make(sch.db, retries=2)
    r = core.new_run(sch.db[core.TASKS].docs["t1"], "schedule", status="running")
    r.update(started_at=T0, beat=T0)
    sch.db[core.RUNS].docs[r["_id"]] = r
    assert run(core.recover(sch.db, T0 + timedelta(seconds=30))) == []
    assert run(core.recover(sch.db, T0 + timedelta(seconds=core.LOST + 5))) == [r["_id"]]
    assert [x["status"] for x in runs(sch.db)] == ["interrupted"]                    # not re-run: it costs money
    echo_kind(monkeypatch, rerun_safe=True)
    r2 = core.new_run(sch.db[core.TASKS].docs["t1"], "schedule", status="running")
    r2.update(started_at=T0, beat=T0)
    sch.db[core.RUNS].docs[r2["_id"]] = r2
    run(core.recover(sch.db, T0 + timedelta(seconds=core.LOST + 5)))
    assert [x["status"] for x in runs(sch.db, "t1")][-1] == "queued"


def test_a_run_past_its_time_limit_is_stopped(sch, monkeypatch):
    echo_kind(monkeypatch)
    make(sch.db, timeout_s=60)
    killed = []
    monkeypatch.setattr(core, "_kill", lambda r: killed.append(r["_id"]))
    r = core.new_run(sch.db[core.TASKS].docs["t1"], "manual", status="running")
    r.update(started_at=T0, beat=T0 + timedelta(seconds=100))
    sch.db[core.RUNS].docs[r["_id"]] = r
    run(core.recover(sch.db, T0 + timedelta(seconds=101)))
    assert killed == [r["_id"]] and sch.db[core.RUNS].docs[r["_id"]]["status"] == "failed"
    assert "timed out" in sch.db[core.RUNS].docs[r["_id"]]["error"]


def test_the_runner_keeps_its_own_time_limit(sch, monkeypatch):
    echo_kind(monkeypatch, sleep=5)
    make(sch.db, timeout_s=30)
    sch.db[core.TASKS].docs["t1"]["timeout_s"] = 0.05
    r = core.new_run(sch.db[core.TASKS].docs["t1"], "manual", status="starting")
    sch.db[core.RUNS].docs[r["_id"]] = r
    done = run(runner.execute(sch.db, r["_id"], load=_noload))
    assert done["status"] == "failed" and "timed out" in done["error"]


# ---------------------------------------------------------------- the switch, how many at once, waiting its turn

def test_the_kill_switch_starts_nothing_and_skips_the_slots(sch, monkeypatch):
    echo_kind(monkeypatch)
    make(sch.db, next_run=datetime(2026, 10, 19, 6, 0, tzinfo=UTC))
    run(core.put_settings(sch.db, {"enabled": False}, {"id": "local"}))
    got = run(core.tick(sch.db, T0))
    assert got["started"] == [] and [r["status"] for r in runs(sch.db)] == ["skipped"]
    monkeypatch.setenv("REDLINE_SCHED", "off")
    run(core.put_settings(sch.db, {"enabled": True}, {"id": "local"}))
    assert run(core.settings(sch.db))["on"] is False


def test_at_most_max_parallel_and_never_two_of_one_task(sch, monkeypatch):
    echo_kind(monkeypatch)
    for i in range(4):
        t = make(sch.db, tid=f"t{i}")
        run(core.insert_run(sch.db, core.new_run(t, "manual")))
    run(core.insert_run(sch.db, core.new_run(sch.db[core.TASKS].docs["t0"], "manual")))   # a second of t0
    monkeypatch.setattr(core, "spawn", lambda raw, rid: asyncio.sleep(0, result=0))
    started = run(core.start_queued(sch.db))
    assert len(started) == 2 and len({sch.db[core.RUNS].docs[x]["task"] for x in started}) == 2
    assert run(core.start_queued(sch.db)) == []                                 # full


def test_a_price_refresh_waits_while_a_maker_is_explored(sch, monkeypatch):
    from backend import manufacturers as mf
    t = make(sch.db, type_="price_refresh", params={})
    r = core.new_run(t, "manual")
    run(core.insert_run(sch.db, r))
    sch.db[mf.JOBS].docs["j1"] = {"_id": "j1", "status": "crawling", "manufacturer": {"name": "empa.com"}}
    monkeypatch.setattr(core, "spawn", lambda raw, rid: asyncio.sleep(0, result=0))
    assert run(core.start_queued(sch.db)) == []
    assert "empa.com is being explored" in sch.db[core.RUNS].docs[r["_id"]]["waiting"]
    sch.db[mf.JOBS].docs["j1"]["status"] = "done"
    assert run(core.start_queued(sch.db)) == [r["_id"]]


# ---------------------------------------------------------------- money

def test_cost_caps_per_task_and_per_person(sch, monkeypatch):
    echo_kind(monkeypatch, llm=True, cost=0.4)
    t = make(sch.db, month_usd=1.0)
    for i in range(3):
        r = core.new_run(t, "manual", status="starting")
        sch.db[core.RUNS].docs[r["_id"]] = r
        done = run(runner.execute(sch.db, r["_id"], load=_noload))
    # 0.4 + 0.4 = 0.8 < 1.0 runs; then 1.2 >= 1.0: the third ran too (the cap is checked before), a fourth does not.
    r = core.new_run(t, "manual", status="starting")
    sch.db[core.RUNS].docs[r["_id"]] = r
    done = run(runner.execute(sch.db, r["_id"], load=_noload))
    assert done["status"] == "skipped" and "monthly cost cap" in done["summary"]
    # The person's cap counts all their tasks.
    t2 = make(sch.db, tid="t2", month_usd=50)
    run(core.put_settings(sch.db, {"user_month_usd": 1.0}, {"id": "local"}))
    r = core.new_run(t2, "manual", status="starting")
    sch.db[core.RUNS].docs[r["_id"]] = r
    done = run(runner.execute(sch.db, r["_id"], load=_noload))
    assert done["status"] == "skipped" and "your scheduled tasks" in done["summary"]


# ---------------------------------------------------------------- rights

def test_the_middleware_keeps_viewers_out_and_the_switch_for_admins():
    assert access.action("POST", "/api/scheduled") == "draw"
    assert access.action("PATCH", "/api/scheduled/abc") == "draw"
    assert access.action("POST", "/api/scheduled/abc/run") == "draw"
    assert access.action("DELETE", "/api/scheduled/abc") == "delete"
    assert access.action("GET", "/api/scheduled/preview") == "view"
    assert access.action("PUT", "/api/scheduled/settings") == "settings"
    assert not access.allowed("viewer", "draw") and not access.allowed("user", "settings")


def test_a_user_cannot_make_a_backup_check_but_an_admin_can(sch):
    access.ROLE.set("user")
    body = api.TaskIn(type="backup_check", schedule={"kind": "daily", "at": "08:30"})
    with pytest.raises(HTTPException) as e:
        run(api.create(body))
    assert e.value.status_code == 403
    access.ROLE.set("admin")
    assert run(api.create(body))["type"] == "backup_check"


def test_a_role_lost_or_an_account_disabled_by_run_time(sch, monkeypatch):
    echo_kind(monkeypatch, right="run")
    monkeypatch.setattr(auth, "enabled", lambda: True)
    t = make(sch.db)
    t["owner"] = {"id": "u9", "name": "Deniz"}
    sch.db[auth.USERS].docs["u9"] = {"_id": "u9", "name": "Deniz", "role": "user", "space": scope.DEFAULT}
    monkeypatch.setattr(auth, "space_of", lambda u: u.get("space"))
    monkeypatch.setattr(auth, "role_of", lambda u: u.get("role"))
    r = core.new_run(t, "manual", status="starting")
    sch.db[core.RUNS].docs[r["_id"]] = r
    assert run(runner.execute(sch.db, r["_id"], load=_noload))["status"] == "done"     # a user may run
    sch.db[auth.USERS].docs["u9"]["role"] = "reviewer"
    r = core.new_run(t, "manual", status="starting")
    sch.db[core.RUNS].docs[r["_id"]] = r
    done = run(runner.execute(sch.db, r["_id"], load=_noload))
    assert done["status"] == "failed" and "not allowed" in done["error"]
    sch.db[auth.USERS].docs["u9"]["disabled"] = True
    r = core.new_run(t, "manual", status="starting")
    sch.db[core.RUNS].docs[r["_id"]] = r
    assert run(runner.execute(sch.db, r["_id"], load=_noload))["status"] == "skipped"


def test_no_type_changes_or_deletes_what_the_person_keeps():
    for k in kinds.KINDS.values():
        assert k.writes in ("none", "refresh"), k.id
        assert k.right in ("draw", "run", "settings"), k.id
    assert kinds.KINDS["ask_chat"].llm and not kinds.KINDS["ask_chat"].rerun_safe
    assert kinds.right_of("digest", {"parts": ["stock_report", "backup_check"]}) == "settings"


def test_inputs_are_checked_on_the_server():
    k = kinds.KINDS["stock_report"]
    assert k.check({}) == {"scope": "low", "target": 2, "value": True, "limit": 50}
    for bad in ({"target": 9}, {"scope": "some"}, {"limit": "x"}, {"nope": 1}, {"value": "maybe"}):
        with pytest.raises(kinds.Bad):
            k.check(bad)
    with pytest.raises(kinds.Bad):
        kinds.KINDS["build_refresh"].check({"models": []})
    with pytest.raises(kinds.Bad):
        kinds.KINDS["digest"].check({"parts": ["ask_chat"]})


# ---------------------------------------------------------------- each type, its sources faked

def ctx_for(db, task_type="x", **params):
    t = {"_id": "t", "workspace": scope.DEFAULT, "owner": {"id": "local", "name": "you"}, "type": task_type, "name": "n"}
    return kinds.Ctx(db=scope.ScopedDb(db, scope.DEFAULT), raw=db, owner=t["owner"], role="owner", task=t, run={},
                     now=T0)


def test_stock_report(sch, monkeypatch):
    from backend import fx, inventory
    rows = [{"_id": "a", "name": "M3 screw", "quantity": 10, "min_stock": 50, "unit": "pcs", "price": 0.5, "currency": "TRY",
             "location": "Box 1"},
            {"_id": "b", "name": "PLA black", "quantity": 0, "unit": "roll", "price": 20, "currency": "USD"},
            {"_id": "c", "name": "ESP32", "quantity": 30, "min_stock": 5, "unit": "pcs", "price": 4, "currency": "USD"}]

    async def everything(db):
        return rows
    monkeypatch.setattr(inventory, "everything", everything)
    monkeypatch.setattr(fx, "to_usd", lambda a, c: None if a is None else a / 40 if c == "TRY" else a)
    k = kinds.KINDS["stock_report"]
    o = run(k.run(ctx_for(sch.db), k.check({})))
    assert o.data["low"] == 2 and o.data["out"] == 1 and o.data["items"] == 3
    assert "M3 screw" in o.markdown and "90 pcs" in o.markdown            # up to 2 x 50, from 10
    assert "set a minimum" in o.markdown and "ESP32" not in o.markdown
    assert o.data["reorder_usd"] == pytest.approx(90 * 0.5 / 40, abs=0.01)
    assert o.csv.startswith("Item,")


def test_price_refresh_reads_the_makers_and_lcsc_and_lists_changes(sch, monkeypatch):
    from backend import bom_cost, inventory, manufacturers as mf
    rep = {"counts": {"pages": 3, "read": 3, "price": 1, "stock": 0, "saved": 1, "failed": 0},
           "rows": [{"maker": {"id": "m1", "name": "Empa"}, "id": "p1", "name": "Motor",
                     "price": [{"amount": 100, "currency": "TRY"}, {"amount": 120, "currency": "TRY"}]}]}

    async def recheck(db, dry=False, progress=None, **kw):
        assert dry is False
        await progress(3, 3, None, rep)
        return rep
    monkeypatch.setattr(mf, "recheck", recheck)
    offers = {"C1": {"breaks": [[1, 0.10]]}}

    async def board_lines(db, bid):
        return [{"lcsc": "C1"}, {"lcsc": None}]

    async def fetch_offer(part):
        offers[part] = {"breaks": [[1, 0.12]]}
        return offers[part]
    monkeypatch.setattr(bom_cost, "board_lines", board_lines)
    monkeypatch.setattr(bom_cost, "cached_offer", lambda p: offers.get(p))
    monkeypatch.setattr(bom_cost, "to_refresh", lambda parts, **kw: parts)
    monkeypatch.setattr(bom_cost, "fetch_offer", fetch_offer)

    async def everything(db):
        return []
    monkeypatch.setattr(inventory, "everything", everything)
    k = kinds.KINDS["price_refresh"]
    o = run(k.run(ctx_for(sch.db), k.check({"boards": ["ctl"]})))
    assert o.data["changes"] == 2 and "+20.0%" in o.markdown and "C1" in o.markdown
    checks = list(sch.db[mf.CHECKS].docs.values())
    assert len(checks) == 1 and checks[0]["status"] == "done" and checks[0]["by"]["via"] == "schedule"
    # Never beside an exploration.
    sch.db[mf.JOBS].docs["j"] = {"_id": "j", "status": "asking", "manufacturer": {"name": "x"}}
    with pytest.raises(kinds.Busy):
        run(k.run(ctx_for(sch.db), k.check({})))


def test_build_refresh(sch, monkeypatch):
    from backend import buildjobs, store
    sch.db["models"].docs["box"] = {"_id": "box"}
    starts = []

    async def start(raw, mid, **kw):
        starts.append((mid, kw["by"]))
        return {"_id": "j-" + mid}

    async def get(raw, jid):
        return {"_id": jid, "status": "done"}

    async def version(db, mid):
        return 3
    monkeypatch.setattr(buildjobs, "start", start)
    monkeypatch.setattr(buildjobs, "get", get)
    monkeypatch.setattr(store, "current_version", version)
    k = kinds.KINDS["build_refresh"]
    o = run(k.run(ctx_for(sch.db), k.check({"models": ["box", "gone"]})))
    assert starts == [("box", "schedule")] and not o.ok and "not found" in o.markdown


def test_backup_check(sch, monkeypatch):
    from backend import backups
    now = 1_800_000_000.0

    async def state():
        return {"now": now, "archives": [{"name": "redline-2026.archive.gz", "newest": True, "mtime": now - 3600, "size": 5e6}],
                "dumps": [{"ok": True, "at": "x"}], "checks": [{"ok": True, "at": "y"}],
                "health": {"dump_ok": True, "fresh": True, "check_ok": True, "plaintext": 2},
                "disk": {"free": 50e9, "size": 100e9}, "next_dump": now + 3600, "error": None}
    monkeypatch.setattr(backups, "state", state)
    k = kinds.KINDS["backup_check"]
    o = run(k.run(ctx_for(sch.db), {}))
    assert o.summary.startswith("fine") and "2 archives hold" in o.markdown and "1.0 h ago" in o.markdown


def test_llm_usage_counts_this_space_only(sch):
    from backend import usage
    at = (T0 - timedelta(days=1)).isoformat()
    for i, (ws, kind_, model, cost) in enumerate([("default", "cc-chat", "haiku", 0.5), ("default", "summary", "qwen", 0.01),
                                                  ("other", "cc-chat", "opus", 9.0)]):
        sch.db[usage.CALLS].docs[f"c{i}"] = {"_id": f"c{i}", "at": at, "workspace_id": ws, "kind": kind_, "model": model,
                                            "cost_usd": cost, "input": 100, "output": 10}
    sch.db[usage.CALLS].docs["old"] = {"_id": "old", "at": (T0 - timedelta(days=30)).isoformat(), "workspace_id": "default",
                                      "cost_usd": 5.0}
    k = kinds.KINDS["llm_usage"]
    o = run(k.run(ctx_for(sch.db), k.check({})))
    assert o.data == {"usd": 0.51, "calls": 2, "tokens": 220} and "haiku" in o.markdown and "opus" not in o.markdown


def test_cc_usage(sch, monkeypatch):
    from backend import llm

    async def acct(db=None, force=False, now=None):
        return {"set": True, "plan": {"name": "Pro"},
                "windows": {"five_hour": {"used": 3, "cap": 10, "pct": 30.0}, "weekly": {"used": 9, "cap": 10, "pct": 90.0},
                            "monthly": None}}
    monkeypatch.setattr(llm, "cc_account", acct)
    o = run(kinds.KINDS["cc_usage"].run(ctx_for(sch.db), {}))
    assert o.data["worst_pct"] == 90.0 and "Weekly window: **90%**" in o.markdown


def test_ask_chat_uses_only_read_tools_and_stops_at_its_cost_cap(sch, monkeypatch):
    from backend import chat_tools, llm
    seen = []

    async def ran(ctx, args):
        seen.append(args)
        return chat_tools.Result("3 notes", "Read")
    read = chat_tools.Tool("notes_find", "d", {"type": "object"}, "read", ran, "r", "f")
    write = chat_tools.Tool("note_write", "d", {"type": "object"}, "change", ran, "r", "f")

    async def enabled(db, uid):
        return [read, write]
    monkeypatch.setattr(chat_tools, "enabled", enabled)
    sent = []
    rounds = iter([[{"calls": [{"id": "1", "name": "notes_find", "arguments": "{\"q\": \"x\"}"}]}, {"usage": {"cost": 0.03}}],
                   [{"text": "## Weekly notes\nAll fine."}, {"usage": {"cost": 0.03}}]])

    async def stream(msgs, **kw):
        sent.append(kw.get("tools"))
        for piece in next(rounds):
            yield piece

    async def record(*a, **kw):
        return None
    monkeypatch.setattr(llm, "stream", stream)
    monkeypatch.setattr(llm, "record", record)
    k = kinds.KINDS["ask_chat"]
    p = k.check({"prompt": "what did I note?", "provider": "commandcode", "model": "m", "tools": ["notes_find", "note_write"],
                 "max_usd": 0.05, "accept_cost": True})
    c = ctx_for(sch.db)
    o = run(k.run(c, p))
    assert [t["function"]["name"] if "function" in t else t.get("name") for t in sent[0]] == ["notes_find"] or len(sent[0]) == 1
    assert seen == [{"q": "x"}] and o.summary == "Weekly notes" and o.cost_usd == pytest.approx(0.06)
    assert "note_write" in o.markdown                                       # said not used
    with pytest.raises(kinds.Bad):
        run(k.run(ctx_for(sch.db), {**p, "accept_cost": False}))


def test_digest_runs_its_parts(sch, monkeypatch):
    calls = echo_kind(monkeypatch)
    monkeypatch.setattr(kinds, "DIGEST_PARTS", ("echo",))
    o = run(kinds.digest(ctx_for(sch.db), {"parts": ["echo"]}))
    assert calls == [{"n": 1}] and o.markdown.startswith("## Echo")


# ---------------------------------------------------------------- where results go

def test_results_go_to_telegram_the_bell_and_files(sch, monkeypatch):
    from backend import files
    echo_kind(monkeypatch)
    configured(sch.db)
    linked(sch.db, user="local", chat=7007)
    kept = []

    async def put(db, name, data, ctype, context, by, note="", folder=""):
        kept.append((name, data, by["name"]))
        return {"_id": "f1"}
    monkeypatch.setattr(files, "put", put)
    make(sch.db, next_run=datetime(2026, 10, 19, 6, 0, tzinfo=UTC), params={"n": 3},
         deliver={"inapp": True, "telegram": True, "file": True, "format": "csv"})
    run(core.tick(sch.db, T0))
    settle()
    r = runs(sch.db)[0]
    assert r["delivered"]["telegram"] and r["delivered"]["file"] == "f1"
    out = list(sch.db[tg.OUTBOX].docs.values())
    assert len(out) == 1 and out[0]["chat"] == 7007 and out[0]["kind"] == "task"
    assert "<b>Echo task</b>" in out[0]["text"] and "<b>echo</b> 3" in out[0]["text"] and "a · b" in out[0]["text"]
    assert "https://redline.example.com/tasks/t1" in out[0]["text"]
    drain(sch.db)
    assert [c for c in sch.bot.calls if c[0] == "send_message"][-1][1]["chat_id"] == 7007
    assert kept == [("Echo task " + r["started_at"].strftime("%Y-%m-%d %H%M") + ".csv", b"a,b\n1,2\n", "Scheduled tasks")]
    try:
        from backend import notifications as nc
    except ImportError:
        return
    bell = list(sch.db[nc.COLL].docs.values())
    assert len(bell) == 1 and bell[0]["user"] == "local" and bell[0]["kind"] == "task" and bell[0]["link"] == "/tasks/t1"


def test_no_bot_or_no_link_means_no_telegram(sch):
    t = make(sch.db, type_="stock_report", deliver={"telegram": True})
    r = {**core.new_run(t, "manual"), "status": "done", "output": "x"}
    assert run(deliver.telegram(sch.db, t, r)) is None                     # no bot
    configured(sch.db)
    assert run(deliver.telegram(sch.db, t, r)) is None                     # not linked
    linked(sch.db, user="local", blocked=True)
    assert run(deliver.telegram(sch.db, t, r)) is None                     # blocked


def test_telegram_text_is_escaped_and_short():
    t = {"_id": "t1", "name": "<b>x</b> & y"}
    r = {"status": "failed", "output": "**bold** <script>\n" + "line\n" * 2000}
    m = deliver.message(t, r, None)
    assert "&lt;b&gt;x&lt;/b&gt; &amp; y" in m and "<b>bold</b> &lt;script&gt;" in m and len(m) <= deliver.TG_MAX + 10


# ---------------------------------------------------------------- the routes

def test_make_change_pause_resume_run_and_delete(sch, monkeypatch):
    echo_kind(monkeypatch)
    body = api.TaskIn(type="echo", name="Echo me", params={"n": 2}, schedule={"kind": "daily", "at": "07:00"})
    t = run(api.create(body))
    tid = t["id"]
    assert t["enabled"] and t["words"] == "Every day 07:00" and t["next_run"]
    assert run(api.listing())["tasks"][0]["id"] == tid
    t = run(api.patch(tid, api.TaskIn(schedule={"kind": "weekly", "days": [1, 3], "at": "09:00"}, params={"n": 5})))
    assert t["words"] == "Mon, Wed 09:00" and t["params"] == {"n": 5}
    with pytest.raises(HTTPException):
        run(api.patch(tid, api.TaskIn(type="stock_report")))
    assert run(api.pause(tid))["enabled"] is False and sch.db[core.TASKS].docs[tid]["next_run"] is None
    assert run(api.resume(tid))["enabled"] is True
    got = run(api.run_now(tid))
    assert got["trigger"] == "manual"
    settle()
    assert run(api.runs(tid))[0]["status"] == "done"
    rid = run(api.runs(tid))[0]["id"]
    assert run(api.get_run(rid))["output"].startswith("**echo** 5")
    audit = [d["action"] for d in sch.db[actors.AUDIT].docs.values()]
    assert {"create", "change", "pause", "resume", "run"} <= set(audit)
    assert run(api.delete(tid)) == {"deleted": tid}
    assert tid not in sch.db[core.TASKS].docs and not runs(sch.db, tid)


def test_run_now_refused_while_one_is_open_or_switched_off(sch, monkeypatch):
    echo_kind(monkeypatch)
    monkeypatch.setattr(core, "spawn", lambda raw, rid: asyncio.sleep(0, result=0))
    tid = run(api.create(api.TaskIn(type="echo", schedule={"kind": "daily", "at": "07:00"})))["id"]
    run(api.run_now(tid))
    with pytest.raises(HTTPException) as e:
        run(api.run_now(tid))
    assert e.value.status_code == 409
    run(core.put_settings(sch.db, {"enabled": False}, {}))
    with pytest.raises(HTTPException):
        run(api.run_now(tid))


def test_an_llm_task_is_made_paused_and_needs_the_cost_accepted(sch):
    body = api.TaskIn(type="ask_chat", params={"prompt": "hi", "accept_cost": False}, schedule={"kind": "daily", "at": "07:00"})
    t = run(api.create(body))
    assert t["enabled"] is False and t["llm"] and t["month_usd"] == 1.0
    with pytest.raises(HTTPException):
        run(api.resume(t["id"]))
    run(api.patch(t["id"], api.TaskIn(params={"prompt": "hi", "accept_cost": True})))
    assert run(api.resume(t["id"]))["enabled"] is True
    with pytest.raises(HTTPException):
        run(api.create(api.TaskIn(type="ask_chat", params={"prompt": "x", "tools": ["note_write"]},
                                  schedule={"kind": "daily", "at": "07:00"})))


def test_an_agent_owns_no_task_and_someone_elses_task_is_theirs(sch, monkeypatch):
    echo_kind(monkeypatch)
    tid = run(api.create(api.TaskIn(type="echo", schedule={"kind": "daily", "at": "07:00"})))["id"]
    actors.CURRENT.set({"type": "agent", "id": "pcb room", "name": "pcb room"})
    with pytest.raises(HTTPException):
        run(api.create(api.TaskIn(type="echo", schedule={"kind": "daily", "at": "07:00"})))
    actors.CURRENT.set({"type": "user", "id": "someone", "name": "S"})
    access.ROLE.set("user")
    with pytest.raises(HTTPException) as e:
        run(api.pause(tid))
    assert e.value.status_code == 403
    access.ROLE.set("admin")
    assert run(api.pause(tid))["enabled"] is False


def test_preview_types_templates_and_settings(sch):
    p = run(api.preview('{"kind": "weekly", "days": [1], "at": "09:00"}', ""))
    assert p["words"] == "Every Monday 09:00" and len(p["next"]) == 5
    with pytest.raises(HTTPException):
        run(api.preview('{"kind": "weekly"}', ""))
    ty = run(api.types())
    assert {t["id"] for t in ty["types"]} >= {"stock_report", "price_refresh", "build_refresh", "backup_check",
                                               "llm_usage", "cc_usage", "ask_chat", "digest"}
    access.ROLE.set("user")
    tpl = {t["id"]: t["allowed"] for t in run(api.templates())}
    assert tpl == {"stock-monday": True, "prices-nightly": True, "llm-weekly": True, "backup-daily": False}
    with pytest.raises(HTTPException):
        run(api.put_settings(api.SettingsIn(enabled=False)))
    access.ROLE.set("owner")
    assert run(api.put_settings(api.SettingsIn(enabled=False, max_parallel=3)))["on"] is False
    with pytest.raises(HTTPException):
        run(api.put_settings(api.SettingsIn(max_parallel=40)))


def test_links_into_the_tab():
    assert app_links.task("ab12") == "/tasks/ab12" and app_links.task() == "/tasks" and app_links.room("tasks") == "/tasks"


# ---------------------------------------------------------------- the Chat's tools

def test_chat_tools_make_list_and_run_a_task_after_the_persons_allow(sch, monkeypatch):
    from backend import chat_tools
    from backend.chat_tools import ToolError
    every = chat_tools.tools()
    make_, list_, run_ = every["task_create"], every["task_list"], every["task_run"]
    assert make_.package == list_.package == run_.package == "tasks"
    assert list_.level == "read" and make_.asks({}) and run_.asks({})           # Allow first
    ctx = chat_tools.Ctx(db=scope.ScopedDb(sch.db, scope.DEFAULT), actor=actors.local_user())
    got = run(make_.run(ctx, {"type": "stock_report", "name": "Monday stock",
                              "schedule": {"kind": "weekly", "days": [1], "at": "09:00"},
                              "deliver": {"telegram": True}}))
    assert "Every Monday 09:00" in got.text and "/tasks/" in got.text and got.vars["when"] == "Every Monday 09:00"
    t = next(iter(sch.db[core.TASKS].docs.values()))
    assert t["deliver"]["telegram"] and t["deliver"]["inapp"] and t["enabled"]
    listed = run(list_.run(ctx, {"types": True}))
    assert "Monday stock" in listed.text and "stock_report:" in listed.text and "COSTS MONEY" in listed.text
    with pytest.raises(ToolError):
        run(make_.run(ctx, {"type": "rm_rf", "schedule": {}}))
    with pytest.raises(ToolError):
        run(make_.run(ctx, {"type": "stock_report", "schedule": {"kind": "weekly", "days": []}}))
    monkeypatch.setattr(core, "spawn", lambda raw, rid: asyncio.sleep(0, result=0))
    ran = run(run_.run(ctx, {"task": "monday"}))
    assert ran.vars["task"] == t["_id"]
    with pytest.raises(ToolError):
        run(run_.run(ctx, {"task": "nothing like it"}))
    access.ROLE.set("viewer")
    with pytest.raises(ToolError):
        run(make_.run(ctx, {"type": "stock_report", "schedule": {"kind": "daily", "at": "09:00"}}))


def test_the_page_says_it_all_in_turkish_too():
    from backend import chat_tools
    tr = open("frontend/src/app/i18n.ts", encoding="utf-8").read()
    icons = open("frontend/src/app/rooms/cc-tools.ts", encoding="utf-8").read()

    def has(s):
        return f"'{s}':" in tr or ("'" + s.replace("'", "\\'") + "':") in tr or f'"{s}":' in tr
    for n in ("task_list", "task_create", "task_run"):
        t = chat_tools.tools()[n]
        for s in (t.label, t.about, t.running, t.failed, t.undo if isinstance(t.undo, str) else t.label):
            assert has(s), (n, s)
        assert f"{n}:" in icons, n
    for s in ("Listed {n} scheduled tasks", "Scheduled {name}: {when}", "Ran {name} now", *deliver.TITLES.values()):
        assert has(s), s
    for k in kinds.KINDS.values():
        assert has(k.label) and has(k.about), k.id
        for p in k.params:
            assert has(p.label) and (not p.about or has(p.about)), (k.id, p.name)
    for t in api.TEMPLATES:
        assert has(t["name"]) and has(t["about"]), t["id"]
