"""Scheduled tasks: what they are in the database, and the loop that runs them.

A task (`sched_tasks`) is a built-in job (backend/sched/kinds.py) with its
inputs, a schedule (backend/sched/cron.py), where its result goes and its
limits. It is its owner's, in the owner's space, and runs as the owner with
the role they have when it runs. Each run - and each slot the scheduler
could not run - is a row of `sched_runs`, kept KEEP_DAYS.

The scheduler is one loop in the API process (`loop`), holding a lease in
`sched_lease` so that only one process schedules at a time. Everything it
knows is in the database: uvicorn --reload restarts the API on every save of
a backend file, and the next process carries on from the rows.

Every tick (TICK seconds):

1. recover - a run whose runner went quiet for LOST seconds, or whose
   process is gone, is "interrupted" (and run again if its type allows and
   attempts are left); one past its time limit is stopped as "failed".
2. claim the due slots - a task whose next_run has come is moved on to its
   next time in ONE conditional write (only while next_run is still the
   slot it read), so two processes, or a tick after a reload, never take
   the same slot; the run's id is the task and the slot, so even a second
   writer could not write it twice. A slot older than the task's grace
   (the API was down) is recorded "missed" rather than run late; the
   latest of them is still run when it is within the grace.
3. start what is queued - at most max_parallel at once, never two of one
   task, never a price refresh beside a manufacturer job - each in a
   runner process of its own (backend/sched/runner.py), so a reload does
   not stop it.

The kill switch (sched_settings.enabled, or REDLINE_SCHED=off) stops
anything from starting: the slots that come meanwhile are "skipped".
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import signal
import socket
import subprocess
import sys
import threading
from datetime import datetime, timedelta, timezone

from . import cron, kinds

log = logging.getLogger("redline.sched")

TASKS = "sched_tasks"
RUNS = "sched_runs"
SETTINGS = "sched_settings"
LEASE = "sched_lease"

TICK = 15.0                 # seconds between two looks
LEASE_S = 45.0              # the loop's lease; renewed every tick
LOST = 60.0                 # a runner not heard from this long is gone
BEAT = 5.0                  # how often a runner says it is alive
KEEP_DAYS = 90              # runs kept this long (TTL on `at`)
BACKOFF = (60, 300, 900)    # seconds before retry 1, 2, 3
MAX_TASKS = 200             # per person
MAX_MISSED_COUNT = 500      # slots counted when saying how many were missed
ENV = "REDLINE_SCHED_RUN"
ACTIVE = ("starting", "running")
OPEN = ("queued", "starting", "running")
FINAL = ("done", "failed", "missed", "skipped", "interrupted", "cancelled")
DEFAULTS = {"enabled": True, "max_parallel": 2, "user_month_usd": 5.0}
LIMITS = {"max_parallel": (1, 6), "user_month_usd": (0.0, 500.0)}
WORKER = {"host": socket.gethostname(), "pid": os.getpid(), "boot": secrets.token_hex(6)}


def now() -> datetime:
    return datetime.now(timezone.utc)


def aware(t) -> datetime | None:
    if isinstance(t, str):
        try:
            t = datetime.fromisoformat(t)
        except ValueError:
            return None
    if not isinstance(t, datetime):
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def raw_of(db):
    """The database itself, from a space's view of it or the database
    (a database answers any attribute with a collection: not asked so)."""
    from .. import scope
    return db.raw if isinstance(db, scope.ScopedDb) else db


def env_off() -> bool:
    return os.environ.get("REDLINE_SCHED", "").strip().lower() in ("off", "0", "false", "no")


async def ensure_indexes(raw) -> None:
    await raw[TASKS].create_index([("workspace", 1), ("owner.id", 1)])
    await raw[TASKS].create_index([("enabled", 1), ("next_run", 1)])
    await raw[RUNS].create_index([("task", 1), ("at", -1)])
    await raw[RUNS].create_index([("status", 1), ("at", 1)])
    await raw[RUNS].create_index("at", expireAfterSeconds=KEEP_DAYS * 86400)


# ---------------------------------------------------------------- settings

async def settings(raw) -> dict:
    doc = await raw_of(raw)[SETTINGS].find_one({"_id": "global"}) or {}
    out = {**DEFAULTS, **{k: doc[k] for k in DEFAULTS if k in doc}}
    out["env_off"] = env_off()
    out["on"] = bool(out["enabled"]) and not out["env_off"]
    return out


async def put_settings(raw, patch: dict, who: dict) -> dict:
    sets: dict = {}
    if "enabled" in patch and patch["enabled"] is not None:
        sets["enabled"] = bool(patch["enabled"])
    for k, (lo, hi) in LIMITS.items():
        if patch.get(k) is not None:
            v = float(patch[k])
            if not lo <= v <= hi:
                raise kinds.Bad(f"{k}: from {lo:g} to {hi:g}")
            sets[k] = int(v) if k == "max_parallel" else round(v, 2)
    if sets:
        await raw_of(raw)[SETTINGS].update_one({"_id": "global"}, {"$set": {**sets, "updated_at": now(), "by": who}},
                                               upsert=True)
    return await settings(raw)


# ---------------------------------------------------------------- a task, checked

DELIVER_DEFAULT = {"inapp": True, "telegram": False, "file": False, "format": "md"}
FORMATS = ("md", "csv")


def clean(body: dict, have: dict | None = None) -> dict:
    """What a task may hold, checked (kinds.Bad / cron.Bad say what is wrong).
    `have`: the task as it is - a change keeps what it does not name."""
    have = have or {}
    b = {**have, **{k: v for k, v in (body or {}).items() if v is not None}}
    kind = kinds.get(str(b.get("type") or ""))
    name = " ".join(str(b.get("name") or "").split())[:80] or kind.label
    params = kind.check(b.get("params") if "params" in (body or {}) or not have else have.get("params"))
    sched = cron.clean(b.get("schedule"))
    tz = cron.zone(b.get("tz") or cron.DEFAULT_TZ).key
    d = {**DELIVER_DEFAULT, **(have.get("deliver") or {}), **(b.get("deliver") if isinstance(b.get("deliver"), dict) else {})}
    deliver = {"inapp": bool(d.get("inapp")), "telegram": bool(d.get("telegram")), "file": bool(d.get("file")),
               "format": d.get("format") if d.get("format") in FORMATS else "md"}
    if deliver["format"] == "csv" and not kind.table:
        deliver["format"] = "md"

    def num(key, default, lo, hi, cast=int):
        v = b.get(key, default)
        try:
            v = cast(v)
        except (TypeError, ValueError):
            raise kinds.Bad(f"{key}: a number") from None
        if not lo <= v <= hi:
            raise kinds.Bad(f"{key}: from {lo:g} to {hi:g}")
        return v
    out = {"name": name, "type": kind.id, "params": params, "schedule": sched, "cron": cron.to_cron(sched), "tz": tz,
           "deliver": deliver, "timeout_s": num("timeout_s", kind.timeout_s, 30, 7200),
           "retries": num("retries", 0 if not kind.rerun_safe else 1, 0, 3),
           "grace_min": num("grace_min", 60, 0, 1440)}
    if kind.llm:
        out["month_usd"] = num("month_usd", 1.0, 0.01, 100.0, float)
    return out


def next_run(task: dict, after: datetime | None = None) -> datetime:
    return cron.next_after(task["cron"], task.get("tz"), after or now(), 1)[0]


def slot_id(task_id: str, slot: datetime) -> str:
    return f"{task_id}@{slot.astimezone(timezone.utc).strftime('%Y%m%dT%H%MZ')}"


def words(task: dict) -> str:
    return cron.words(task["schedule"])


# ---------------------------------------------------------------- runs

def new_run(task: dict, trigger: str, *, slot: datetime | None = None, status: str = "queued",
            attempt: int = 1, rid: str | None = None, t: datetime | None = None, **extra) -> dict:
    t = t or now()
    return {"_id": rid or f"{task['_id']}~{secrets.token_hex(5)}", "task": task["_id"], "workspace": task["workspace"],
            "owner": task["owner"], "type": task["type"], "name": task["name"], "trigger": trigger,
            "slot": slot, "status": status, "attempt": attempt, "at": t, "not_before": t,
            "summary": None, "output": None, "data": None, "cost_usd": None, "error": None, **extra}


async def insert_run(raw, run: dict) -> bool:
    """False when a row with its id is there already (the slot was written)."""
    from pymongo.errors import DuplicateKeyError
    try:
        await raw_of(raw)[RUNS].insert_one(run)
        return True
    except DuplicateKeyError:
        return False


async def open_run(raw, task_id: str) -> dict | None:
    return await raw_of(raw)[RUNS].find_one({"task": task_id, "status": {"$in": list(OPEN)}})


async def finish_task(raw, task_id: str, run: dict) -> None:
    """The task remembers its last run (what the list shows)."""
    last = {"run": run["_id"], "status": run["status"], "at": run.get("finished_at") or now(),
            "summary": run.get("summary") or run.get("error")}
    ok = run["status"] in ("done", "skipped", "missed")
    t = await raw_of(raw)[TASKS].find_one({"_id": task_id}, {"fails": 1})
    fails = 0 if ok else int((t or {}).get("fails") or 0) + (1 if run["status"] in ("failed", "interrupted") else 0)
    await raw_of(raw)[TASKS].update_one({"_id": task_id}, {"$set": {"last": last, "fails": fails}})


async def end_run(raw, run: dict, status: str, **sets) -> dict | None:
    """A run ended (only while it is still open: whoever ends it first wins)."""
    t = now()
    started = aware(run.get("started_at"))
    patch = {"status": status, "finished_at": t, **({"ms": round((t - started).total_seconds() * 1000)} if started else {}),
             **sets}
    res = await raw_of(raw)[RUNS].update_one({"_id": run["_id"], "status": {"$in": list(OPEN)}}, {"$set": patch})
    if not getattr(res, "matched_count", 1):
        return None
    done = {**run, **patch}
    await finish_task(raw, run["task"], done)
    return done


async def retry_later(raw, task: dict, run: dict, why: str) -> dict | None:
    """Another try of a run that did not finish, after a pause - when its type
    may run again and attempts are left."""
    kind = kinds.KINDS.get(task.get("type"))
    if not kind or not kind.rerun_safe or not task.get("enabled", True) and run.get("trigger") != "manual":
        return None
    attempt = int(run.get("attempt") or 1)
    if attempt > int(task.get("retries") or 0):
        return None
    wait = BACKOFF[min(attempt - 1, len(BACKOFF) - 1)]
    nxt = new_run(task, "retry", slot=run.get("slot"), attempt=attempt + 1, retry_of=run["_id"], why=why[:200])
    nxt["not_before"] = now() + timedelta(seconds=wait)
    await insert_run(raw, nxt)
    return nxt


# ---------------------------------------------------------------- the runner process

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def runner_argv(rid: str) -> list[str]:
    return [sys.executable, "-m", "backend.sched.runner", rid]


def _popen(rid: str) -> int:
    """Its own session, so a reload's signal does not reach it."""
    from .. import jobs
    jobs.LOGS.mkdir(parents=True, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in rid)
    with open(jobs.LOGS / f"sched-{safe}.log", "ab") as out:
        proc = subprocess.Popen(runner_argv(rid), cwd=ROOT, stdin=subprocess.DEVNULL, stdout=out,
                                stderr=subprocess.STDOUT, start_new_session=True, env={**os.environ, ENV: rid})
    threading.Thread(target=proc.wait, daemon=True).start()
    return proc.pid


async def spawn(raw, rid: str) -> int:
    """Start the runner. Its own function so a test can stand in."""
    return await asyncio.to_thread(_popen, rid)


def _pid_ns() -> str | None:
    from ..buildjobs import _pid_ns as ns
    return ns()


async def launch(raw, run: dict) -> bool:
    """queued -> starting, then the runner; False when someone else started it."""
    from ..buildjobs import _pid_ns as ns
    t = now()
    got = await raw_of(raw)[RUNS].find_one_and_update(
        {"_id": run["_id"], "status": "queued"},
        {"$set": {"status": "starting", "starting_at": t, "beat": t, "host": WORKER["host"], "ns": ns()}})
    if not got:
        return False
    try:
        pid = await spawn(raw, run["_id"])
    except OSError as exc:
        await end_run(raw, {**got, "status": "starting"}, "failed", error=f"the runner could not be started: {exc}")
        return False
    if pid:
        await raw_of(raw)[RUNS].update_one({"_id": run["_id"], "status": {"$in": list(ACTIVE)}}, {"$set": {"pid": pid}})
    return True


# ---------------------------------------------------------------- the loop's steps

def _gone(run: dict) -> bool:
    from ..buildjobs import _dead_here
    return run.get("pid") is not None and _dead_here(run)


def _kill(run: dict) -> None:
    """Stop a runner that ran past its time (its whole session)."""
    pid = run.get("pid")
    if not pid or run.get("ns") != _pid_ns():
        return
    try:
        os.killpg(pid, signal.SIGTERM)
    except (OSError, ProcessLookupError):
        pass


async def recover(raw, t: datetime | None = None) -> list[str]:
    """Runs whose runner is gone or quiet are interrupted (retried when they
    may be); runs past their time limit are stopped."""
    t = t or now()
    raw = raw_of(raw)
    out = []
    async for run in raw[RUNS].find({"status": {"$in": list(ACTIVE)}}):
        task = await raw[TASKS].find_one({"_id": run["task"]}) or {}
        beat = aware(run.get("beat") or run.get("starting_at") or run.get("at"))
        quiet = (t - beat).total_seconds() if beat else LOST + 1
        started = aware(run.get("started_at"))
        limit = float(task.get("timeout_s") or 600) + 30
        if started and (t - started).total_seconds() > limit:
            _kill(run)
            if await end_run(raw, run, "failed", error=f"timed out after {int(limit - 30)} s"):
                out.append(run["_id"])
            continue
        if _gone(run) or quiet > LOST:
            why = "the runner stopped (the server restarted)" if _gone(run) else f"the runner went quiet for {int(quiet)} s"
            if await end_run(raw, run, "interrupted", error=why):
                out.append(run["_id"])
                if task:
                    await retry_later(raw, task, run, why)
    return out


def _slots(task: dict, first: datetime, t: datetime) -> list[datetime]:
    """Every slot of the task from `first` up to `t` (at most a few hundred)."""
    out = [first]
    cur = first
    while len(out) < MAX_MISSED_COUNT:
        nxt = cron.next_after(task["cron"], task.get("tz"), cur, 1)[0]
        if nxt > t:
            break
        out.append(nxt)
        cur = nxt
    return out


async def claim_due(raw, t: datetime | None = None, switched_on: bool = True) -> list[dict]:
    """The due slots of every enabled task, claimed and written as runs."""
    t = t or now()
    raw = raw_of(raw)
    made = []
    async for task in raw[TASKS].find({"enabled": True, "next_run": {"$lte": t}}):
        slot = aware(task.get("next_run"))
        if slot is None:
            continue
        try:
            nxt = next_run(task, t)
        except cron.Bad as exc:
            await raw[TASKS].update_one({"_id": task["_id"]}, {"$set": {"enabled": False, "paused_why": str(exc)}})
            continue
        got = await raw[TASKS].find_one_and_update({"_id": task["_id"], "enabled": True, "next_run": task["next_run"]},
                                                   {"$set": {"next_run": nxt}})
        if not got:
            continue                                  # someone else took it
        slots = _slots(task, slot, t)
        latest = slots[-1]
        grace = timedelta(minutes=int(task.get("grace_min") or 0))
        run_latest = t - latest <= max(grace, timedelta(seconds=TICK * 2))
        missed = slots[:-1] if run_latest else slots
        if missed:
            row = new_run(task, "schedule", slot=missed[0], status="missed", t=t,
                          rid=slot_id(task["_id"], missed[0]) + "~missed", finished_at=t,
                          missed=len(missed), missed_until=missed[-1],
                          summary=(f"{len(missed)} runs missed" if len(missed) > 1 else "missed")
                          + " - the server was not running then")
            if await insert_run(raw, row):
                await finish_task(raw, task["_id"], row)
                made.append(row)
        if run_latest:
            if not switched_on:
                row = new_run(task, "schedule", slot=latest, status="skipped", rid=slot_id(task["_id"], latest), t=t,
                              finished_at=t, summary="skipped - the scheduler is switched off")
            else:
                row = new_run(task, "schedule", slot=latest, rid=slot_id(task["_id"], latest), t=t)
            if await insert_run(raw, row):
                if row["status"] == "skipped":
                    await finish_task(raw, task["_id"], row)
                made.append(row)
    return made


async def start_queued(raw, t: datetime | None = None, st: dict | None = None) -> list[str]:
    """Start queued runs while there is room, oldest first."""
    t = t or now()
    raw = raw_of(raw)
    st = st or await settings(raw)
    queued = [r async for r in raw[RUNS].find({"status": "queued"})]
    queued.sort(key=lambda r: aware(r.get("at")) or t)
    if not st["on"]:
        for r in queued:
            await end_run(raw, r, "skipped", summary="skipped - the scheduler is switched off")
        return []
    active = [r async for r in raw[RUNS].find({"status": {"$in": list(ACTIVE)}})]
    busy_tasks = {r["task"] for r in active}
    room = int(st["max_parallel"]) - len(active)
    started = []
    for r in queued:
        task = await raw[TASKS].find_one({"_id": r["task"]})
        if not task:
            await end_run(raw, r, "cancelled", summary="the task was deleted")
            continue
        kind = kinds.KINDS.get(r["type"])
        wait_for = timedelta(seconds=float(task.get("timeout_s") or 600) + 3600)
        if t - (aware(r.get("at")) or t) > wait_for:
            await end_run(raw, r, "skipped", summary="skipped - it waited too long to start")
            continue
        if (aware(r.get("not_before")) or t) > t:
            continue
        if room <= 0:
            continue
        why = None
        if r["task"] in busy_tasks:
            why = "another run of this task is going"
        elif kind and kind.exclusive:
            if any(kinds.KINDS.get(a["type"]) and kinds.KINDS[a["type"]].exclusive == kind.exclusive for a in active):
                why = "another run of its kind is going"
            else:
                why = await kinds.busy_reason(kind, raw)
        if why:
            if r.get("waiting") != why:
                await raw[RUNS].update_one({"_id": r["_id"], "status": "queued"}, {"$set": {"waiting": why}})
            continue
        if await launch(raw, r):
            started.append(r["_id"])
            busy_tasks.add(r["task"])
            active.append(r)
            room -= 1
    return started


async def tick(raw, t: datetime | None = None) -> dict:
    t = t or now()
    st = await settings(raw)
    rec = await recover(raw, t)
    made = await claim_due(raw, t, st["on"])
    started = await start_queued(raw, t, st)
    return {"recovered": rec, "made": [r["_id"] for r in made], "started": started}


# ---------------------------------------------------------------- one loop at a time

async def hold_lease(raw, t: datetime | None = None, me: dict | None = None) -> bool:
    """This process schedules while it holds the lease, renewed every tick.
    A holder in this pid namespace whose process is gone (a reload) is
    taken over at once rather than after its lease runs out."""
    from pymongo.errors import DuplicateKeyError
    t = t or now()
    me = me or {**WORKER, "ns": _pid_ns()}
    coll = raw_of(raw)[LEASE]
    doc = await coll.find_one({"_id": "loop"})
    if doc is None:
        try:
            await coll.insert_one({"_id": "loop", "holder": me, "until": t + timedelta(seconds=LEASE_S)})
            return True
        except DuplicateKeyError:
            doc = await coll.find_one({"_id": "loop"}) or {}
    h = doc.get("holder") or {}
    mine = h.get("boot") == me["boot"]
    stale = (aware(doc.get("until")) or t) <= t
    dead = h.get("ns") and h.get("ns") == me.get("ns") and h.get("pid") and not _alive(h["pid"])
    if not (mine or stale or dead):
        return False
    got = await coll.find_one_and_update({"_id": "loop", "holder.boot": h.get("boot")},
                                         {"$set": {"holder": me, "until": t + timedelta(seconds=LEASE_S)}})
    return bool(got)


def _alive(pid: int) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError):
        return False


async def loop(raw_getter, every: float = TICK) -> None:
    """The scheduler, for as long as the API runs (main.py starts it)."""
    try:
        await ensure_indexes(raw_getter())
    except Exception as exc:                                     # noqa: BLE001 - it still runs
        log.warning("scheduled tasks: indexes not made: %s", exc)
    while True:
        try:
            raw = raw_getter()
            if await hold_lease(raw):
                await tick(raw)
        except asyncio.CancelledError:
            raise
        except Exception:                                        # noqa: BLE001 - the next tick tries again
            log.exception("scheduled tasks: tick failed")
        await asyncio.sleep(every)
