"""One run of a scheduled task, in a process of its own.

`python -m backend.sched.runner <run id>` - started by the scheduler
(backend/sched/core.py launch) in its own session, as backend/ccgen.py is
for a Chat answer, so a reload of the API (every save of a backend file)
does not stop it. It writes a beat on the run every few seconds; the
scheduler takes a run that stops beating for gone.

What it does, in order: read the run and its task; load the settings the
work may need (the LLM keys, Jina, the proxy and its routes, the exchange
rates) - one that cannot be read fails the run loudly rather than using a
default; take on the owner (their space, their name with `via: schedule`,
their role as it is now: a disabled account's task does not run, a role
that no longer has the type's right fails it); check the kill switch and
the cost caps; run the type under its time limit; keep the result, deliver
it, and when it failed and may run again, queue the retry.
"""

from __future__ import annotations

import asyncio
import os
import sys
import traceback
from datetime import datetime, timezone

from . import core, deliver, kinds

OUT_MAX = 20_000


def month_start(t: datetime) -> datetime:
    return t.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def spent(raw, q: dict, since: datetime) -> float:
    total = 0.0
    async for r in core.raw_of(raw)[core.RUNS].find({**q, "at": {"$gte": since}}):
        total += float(r.get("cost_usd") or 0)
    return total


async def cap_reason(raw, task: dict, kind: kinds.Kind, t: datetime | None = None) -> str | None:
    """Why an LLM task must not run now (a cap is reached), or None."""
    if not kind.llm:
        return None
    t = t or core.now()
    since = month_start(t)
    st = await core.settings(raw)
    mine = await spent(raw, {"task": task["_id"]}, since)
    if mine >= float(task.get("month_usd") or 1.0):
        return f"this task's monthly cost cap is reached (${mine:.2f} of ${float(task.get('month_usd') or 1):.2f})"
    person = await spent(raw, {"owner.id": task["owner"]["id"]}, since)
    if person >= float(st["user_month_usd"]):
        return f"your scheduled tasks' monthly cost cap is reached (${person:.2f} of ${float(st['user_month_usd']):.2f})"
    return None


async def role_now(raw, task: dict) -> str | None:
    """The owner's role now - None when the account is disabled, gone, or no
    longer works in the task's space. Local mode: the owner."""
    from .. import auth
    if not auth.enabled():
        return "owner"
    u = await core.raw_of(raw)[auth.USERS].find_one({"_id": task["owner"]["id"]}, {"pw": 0, "avatar": 0})
    if not u or u.get("disabled") or auth.space_of(u) != task["workspace"]:
        return None
    return auth.role_of(u)


async def load_settings(db) -> None:
    from .. import fx, jina, llm, netproxy
    for mod in (llm, jina, netproxy):
        await mod.load(db)
    try:
        await fx.load(db)
    except Exception:                                            # noqa: BLE001 - rates are only for the value lines
        pass


async def execute(raw, rid: str, *, load=None) -> dict | None:
    """The run's work, in whatever process runs it. Returns the run as it ended."""
    from .. import access, actors, scope
    raw = core.raw_of(raw)
    runs = raw[core.RUNS]
    run = await runs.find_one({"_id": rid})
    if not run or run.get("status") != "starting":
        return None
    t0 = core.now()
    got = await runs.find_one_and_update({"_id": rid, "status": "starting"}, {"$set": {
        "status": "running", "started_at": t0, "beat": t0, "pid": os.getpid(), "ns": core._pid_ns(),
        "host": core.WORKER["host"]}})
    if not got:
        return None
    run = {**got, "status": "running", "started_at": t0}
    task = await raw[core.TASKS].find_one({"_id": run["task"]})
    if not task:
        return await core.end_run(raw, run, "cancelled", summary="the task was deleted")
    kind = kinds.KINDS.get(task["type"])
    if not kind:
        return await core.end_run(raw, run, "failed", error=f"no task type {task['type']}")
    st = await core.settings(raw)
    if not st["on"]:
        return await core.end_run(raw, run, "skipped", summary="skipped - the scheduler is switched off")
    role = await role_now(raw, task)
    if role is None:
        return await core.end_run(raw, run, "skipped", summary="skipped - its owner's account is disabled or gone")
    need = kinds.right_of(task["type"], task.get("params"))
    if not access.allowed(role, need):
        return await core.end_run(raw, run, "failed", error="not allowed: " + access.refusal(role, need))
    why = await cap_reason(raw, task, kind)
    if why:
        return await core.end_run(raw, run, "skipped", summary="skipped - " + why)

    ws = task["workspace"]
    scope.WORKSPACE.set(ws)
    actors.CURRENT.set({**task["owner"], "type": "user", "via": "schedule"})
    access.ROLE.set(role)
    db = scope.ScopedDb(raw, ws)
    try:
        await (load or load_settings)(db)
    except Exception as exc:                                     # noqa: BLE001 - loudly, not with defaults
        return await core.end_run(raw, run, "failed", error=f"settings could not be read: {str(exc)[:300]}")

    state = {"say": None}

    async def beat(what: str | None = None) -> None:
        if what:
            state["say"] = what[:200]

    async def beating():
        while True:
            await asyncio.sleep(core.BEAT)
            await runs.update_one({"_id": rid, "status": "running"},
                                  {"$set": {"beat": core.now(), **({"doing": state["say"]} if state["say"] else {})}})

    ctx = kinds.Ctx(db=db, raw=raw, owner=task["owner"], role=role, task=task, run=run, beat=beat)
    pulse = asyncio.create_task(beating())
    outcome, error, retry = None, None, False
    try:
        outcome = await asyncio.wait_for(kind.run(ctx, kind.check(task.get("params"))), float(task.get("timeout_s") or kind.timeout_s))
    except asyncio.TimeoutError:
        error = f"timed out after {int(task.get('timeout_s') or kind.timeout_s)} s"
    except kinds.Busy as exc:
        error, retry = f"busy: {exc}", True
    except kinds.Bad as exc:
        error = str(exc)
    except Exception as exc:                                     # noqa: BLE001 - kept on the run
        error, retry = (str(exc)[:500] or type(exc).__name__), True
        print(traceback.format_exc()[-2000:], file=sys.stderr)
    finally:
        pulse.cancel()
    cost = round(ctx.spent, 6) if kind.llm else None
    if outcome is not None:
        status = "done" if outcome.ok else "failed"
        sets = {"summary": (outcome.summary or "")[:300], "output": (outcome.markdown or "")[:OUT_MAX],
                "data": outcome.data, "cost_usd": outcome.cost_usd if outcome.cost_usd is not None else cost}
        if not outcome.ok:
            sets["error"] = outcome.summary
    else:
        status = "failed"
        sets = {"error": error, "summary": error[:300] if error else None, "cost_usd": cost}
    done = await core.end_run(raw, run, status, **sets)
    if done is None:                                             # ended meanwhile (cancelled, timed out by the loop)
        return await runs.find_one({"_id": rid})
    try:
        got = await deliver.deliver(raw, task, done, outcome.csv if outcome else None)
        await runs.update_one({"_id": rid}, {"$set": {"delivered": got}})
        done["delivered"] = got
    except Exception as exc:                                     # noqa: BLE001 - the run stays done
        print(f"sched {rid}: not delivered: {exc}", file=sys.stderr)
    if status == "failed" and retry:
        await core.retry_later(raw, task, done, error or "failed")
    return done


async def _main(rid: str) -> int:
    from .. import main
    raw = main.db().raw
    print(f"sched {rid}: pid {os.getpid()} at {datetime.now(timezone.utc).isoformat()}", flush=True)
    done = await execute(raw, rid)
    print(f"sched {rid}: {(done or {}).get('status')}", flush=True)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("python -m backend.sched.runner <run id>")
    sys.exit(asyncio.run(_main(sys.argv[1])))
