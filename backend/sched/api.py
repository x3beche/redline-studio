"""The Tasks tab's routes (prefix /api/scheduled).

    GET    ''                    the space's tasks, each with its schedule in words, next and last run
    GET    /types                the task types with their inputs, and which the asker may make
    GET    /templates            tasks to start from
    GET    /preview              ?schedule=<json>&tz= -> cron, words, the next five times
    GET    /settings             the scheduler: on/off, how many at once, the monthly cost cap per person
    PUT    /settings             the same (the server's settings right)
    POST   ''                    a new task
    GET    /{id}                 one task
    PATCH  /{id}                 change it
    DELETE /{id}                 delete it (its finished runs with it)
    POST   /{id}/run             run it now
    POST   /{id}/pause           stop its schedule
    POST   /{id}/resume          start it again (from now: nothing is caught up)
    GET    /{id}/runs            its history, newest first (?limit= &before=)
    GET    /runs/{rid}           one run with its whole report
    POST   /runs/{rid}/cancel    a run that is waiting, or running

Rights: backend/access.py keeps viewers to GET (and the preview), and
writes to `draw`; here a type's own right is checked for the person making
or changing the task, and a task is changed by its owner or by the space's
owner/admins. Every change is a line in the audit trail.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import access, actors, scope
from . import core, cron, kinds, runner

router = APIRouter(prefix="/api/scheduled")

TEMPLATES = [
    {"id": "stock-monday", "name": "Monday stock report", "type": "stock_report",
     "params": {"scope": "low", "target": 2, "value": True, "limit": 50},
     "schedule": {"kind": "weekly", "days": [1], "at": "09:00"},
     "deliver": {"inapp": True, "telegram": True, "file": False, "format": "md"},
     "about": "Every Monday at 09:00: what is low or out, what to reorder, to Telegram and here."},
    {"id": "prices-nightly", "name": "Nightly price refresh", "type": "price_refresh",
     "params": {"makers": True, "boards": [], "only_stocked": False, "min_change_pct": 0},
     "schedule": {"kind": "daily", "at": "02:30"},
     "deliver": {"inapp": True, "telegram": False, "file": False, "format": "md"},
     "about": "Every night at 02:30: the makers' product pages read again, the prices that changed."},
    {"id": "llm-weekly", "name": "Weekly LLM cost summary", "type": "llm_usage",
     "params": {"days": 7, "top": 8},
     "schedule": {"kind": "weekly", "days": [1], "at": "09:00"},
     "deliver": {"inapp": True, "telegram": True, "file": False, "format": "md"},
     "about": "Every Monday at 09:00: what the models cost last week, by job and by model."},
    {"id": "backup-daily", "name": "Daily backup check", "type": "backup_check", "params": {},
     "schedule": {"kind": "daily", "at": "08:30"},
     "deliver": {"inapp": True, "telegram": False, "file": False, "format": "md"},
     "about": "Every morning at 08:30: the last nightly dump, its age and the restore check."},
]


def _raw():
    from .. import main
    return main.db().raw


def _iso(v):
    if isinstance(v, datetime):
        return (v if v.tzinfo else v.replace(tzinfo=timezone.utc)).isoformat()
    return v


def _clean_dt(d):
    if isinstance(d, dict):
        return {k: _clean_dt(v) for k, v in d.items()}
    if isinstance(d, list):
        return [_clean_dt(v) for v in d]
    return _iso(d)


def run_out(r: dict, full: bool = False) -> dict:
    keep = ("task", "type", "name", "trigger", "slot", "status", "attempt", "at", "not_before", "started_at",
            "finished_at", "ms", "summary", "data", "cost_usd", "error", "delivered", "waiting", "doing",
            "missed", "missed_until", "retry_of")
    o = {"id": r["_id"], **{k: r.get(k) for k in keep if k in r}}
    o["has_output"] = bool(r.get("output"))
    if full:
        o["output"] = r.get("output")
    return _clean_dt(o)


def task_out(t: dict, open_run: dict | None = None) -> dict:
    o = {k: v for k, v in t.items() if k != "_id"}
    o["id"] = t["_id"]
    try:
        o["words"] = cron.words(t["schedule"])
    except (cron.Bad, KeyError):
        o["words"] = t.get("cron")
    kind = kinds.KINDS.get(t.get("type"))
    o["type_label"] = kind.label if kind else t.get("type")
    o["llm"] = bool(kind and kind.llm)
    o["open"] = run_out(open_run) if open_run else None
    return _clean_dt(o)


def _who() -> dict:
    """The person asking; a task belongs to a person."""
    who = actors.current()
    if who.get("type") != "user":
        raise HTTPException(400, "a scheduled task belongs to a person - not an agent")
    if who.get("page"):
        raise HTTPException(403, "a page session only looks")
    return who


def _role() -> str:
    return access.current() or "owner"


def _may(right: str) -> None:
    role = _role()
    if not access.allowed(role, right):
        raise HTTPException(403, access.refusal(role, right))


async def _task(tid: str) -> dict:
    t = await _raw()[core.TASKS].find_one({"_id": tid, "workspace": scope.current()})
    if not t:
        raise HTTPException(404, f"no task {tid}")
    return t


def _may_change(t: dict) -> None:
    who = _who()
    if t["owner"]["id"] != who.get("id") and _role() not in ("owner", "admin"):
        raise HTTPException(403, "only its owner (or an admin) changes a task")


def _bad(exc: Exception):
    raise HTTPException(400, str(exc))


def _check_tools(params: dict) -> None:
    """ask_chat: the tools named must exist and only read."""
    from .. import chat_tools
    every = chat_tools.tools()
    for n in params.get("tools") or []:
        t = every.get(n)
        if not t:
            raise kinds.Bad(f"no chat tool {n}")
        if t.level != "read":
            raise kinds.Bad(f"{n} changes things - a scheduled question may use read-only tools only")


class TaskIn(BaseModel):
    name: str | None = None
    type: str | None = None
    params: dict | None = None
    schedule: dict | None = None
    tz: str | None = None
    deliver: dict | None = None
    timeout_s: int | None = None
    retries: int | None = None
    grace_min: int | None = None
    month_usd: float | None = None
    enabled: bool | None = None


class SettingsIn(BaseModel):
    enabled: bool | None = None
    max_parallel: int | None = None
    user_month_usd: float | None = None


async def _open_runs(raw, ids: list[str]) -> dict[str, dict]:
    out = {}
    async for r in raw[core.RUNS].find({"task": {"$in": ids}, "status": {"$in": list(core.OPEN)}}):
        out.setdefault(r["task"], r)
    return out


@router.get("")
async def listing():
    raw = _raw()
    rows = [t async for t in raw[core.TASKS].find({"workspace": scope.current()})]
    rows.sort(key=lambda t: (not t.get("enabled"), (t.get("name") or "").lower()))
    opens = await _open_runs(raw, [t["_id"] for t in rows])
    st = await core.settings(raw)
    return {"tasks": [task_out(t, opens.get(t["_id"])) for t in rows], "settings": st,
            "now": core.now().isoformat(), "tz": cron.DEFAULT_TZ}


@router.get("/types")
async def types():
    from .. import chat_tools
    role = _role()
    who = actors.current()
    out = []
    for k in kinds.KINDS.values():
        d = k.public()
        d["allowed"] = access.allowed(role, k.right)
        out.append(d)
    tools = []
    try:
        mine = kinds.ask_tools(await chat_tools.enabled(scope.ScopedDb(_raw(), scope.current()), who.get("id")))
        tools = [{"name": t.name, "label": t.label or t.name, "package": t.package} for t in mine.values()]
    except Exception:                                            # noqa: BLE001 - the form only lists fewer
        pass
    linked = False
    try:
        from ..tgbot import core as tg, links
        link = await links.of_user(_raw(), who.get("id"))
        linked = bool(link and not link.get("blocked") and tg.token_of(await tg.settings(_raw())))
    except Exception:                                            # noqa: BLE001
        pass
    return {"types": out, "tools": tools, "telegram": linked, "tz": cron.DEFAULT_TZ,
            "digest_parts": list(kinds.DIGEST_PARTS)}


@router.get("/templates")
async def templates():
    role = _role()
    return [{**t, "allowed": access.allowed(role, kinds.right_of(t["type"], t["params"]))} for t in TEMPLATES]


@router.get("/preview")
async def preview(schedule: str, tz: str = ""):
    """`schedule`: the friendly schedule as JSON. A GET, so whoever may look sees the next times."""
    import json
    try:
        s = json.loads(schedule)
    except ValueError:
        raise HTTPException(400, "schedule: JSON") from None
    if not isinstance(s, dict):
        raise HTTPException(400, "schedule: an object")
    try:
        return cron.describe(s, tz or None)
    except cron.Bad as exc:
        _bad(exc)


@router.get("/settings")
async def get_settings():
    raw = _raw()
    st = await core.settings(raw)
    st["can_change"] = access.allowed(_role(), "settings")
    st["running"] = await raw[core.RUNS].count_documents({"status": {"$in": list(core.ACTIVE)}})
    st["queued"] = await raw[core.RUNS].count_documents({"status": "queued"})
    return st


@router.put("/settings")
async def put_settings(body: SettingsIn):
    _may("settings")
    who = _who()
    try:
        st = await core.put_settings(_raw(), body.model_dump(), who)
    except kinds.Bad as exc:
        _bad(exc)
    await actors.audit(scope.ScopedDb(_raw(), scope.current()), "settings", "scheduled tasks",
                       {k: v for k, v in body.model_dump().items() if v is not None})
    return st


@router.post("")
async def create(body: TaskIn):
    who = _who()
    raw = _raw()
    ws = scope.current()
    try:
        t = core.clean(body.model_dump())
        if t["type"] == "ask_chat":
            _check_tools(t["params"])
    except (kinds.Bad, cron.Bad) as exc:
        _bad(exc)
    _may(kinds.right_of(t["type"], t["params"]))
    if await raw[core.TASKS].count_documents({"owner.id": who["id"]}) >= core.MAX_TASKS:
        raise HTTPException(409, f"at most {core.MAX_TASKS} tasks a person")
    import secrets
    kind = kinds.KINDS[t["type"]]
    enabled = bool(body.enabled if body.enabled is not None else True)
    if kind.llm:
        enabled = False                                          # spends money: started by hand, after the warning
    n = core.now()
    doc = {"_id": secrets.token_hex(5), **t, "enabled": enabled, "owner": {"id": who["id"], "name": who.get("name")},
           "workspace": ws, "created_at": n, "updated_at": n, "created_by": {"id": who["id"], "name": who.get("name")},
           "next_run": core.next_run(t) if enabled else None, "last": None, "fails": 0}
    await raw[core.TASKS].insert_one(doc)
    await actors.audit(scope.ScopedDb(raw, ws), "create", f"scheduled task {doc['name']}", {"id": doc["_id"], "type": t["type"]})
    return task_out(doc)


@router.get("/runs/{rid}")
async def get_run(rid: str):
    r = await _raw()[core.RUNS].find_one({"_id": rid, "workspace": scope.current()})
    if not r:
        raise HTTPException(404, f"no run {rid}")
    return run_out(r, full=True)


@router.post("/runs/{rid}/cancel")
async def cancel_run(rid: str):
    raw = _raw()
    r = await raw[core.RUNS].find_one({"_id": rid, "workspace": scope.current()})
    if not r:
        raise HTTPException(404, f"no run {rid}")
    _may_change(await _task(r["task"]))
    if r["status"] not in core.OPEN:
        raise HTTPException(409, f"the run is {r['status']} already")
    if r["status"] in core.ACTIVE:
        core._kill(r)
    done = await core.end_run(raw, r, "cancelled", summary=f"cancelled by {_who().get('name') or 'someone'}")
    return run_out(done or await raw[core.RUNS].find_one({"_id": rid}))


@router.get("/{tid}")
async def get_task(tid: str):
    t = await _task(tid)
    opens = await _open_runs(_raw(), [tid])
    return task_out(t, opens.get(tid))


@router.patch("/{tid}")
async def patch(tid: str, body: TaskIn):
    raw = _raw()
    have = await _task(tid)
    _may_change(have)
    change = body.model_dump()
    if change.get("type") and change["type"] != have["type"]:
        raise HTTPException(400, "a task's type does not change - make a new one")
    try:
        t = core.clean(change, have)
        if t["type"] == "ask_chat":
            _check_tools(t["params"])
    except (kinds.Bad, cron.Bad) as exc:
        _bad(exc)
    _may(kinds.right_of(t["type"], t["params"]))
    enabled = have.get("enabled") if body.enabled is None else bool(body.enabled)
    if enabled and kinds.KINDS[t["type"]].llm and not t["params"].get("accept_cost"):
        raise HTTPException(400, "this task spends money on a model: accept the cost first")
    sets = {**t, "enabled": enabled, "updated_at": core.now()}
    timing = (t["cron"], t["tz"]) != (have.get("cron"), have.get("tz")) or enabled != have.get("enabled")
    if timing:
        sets["next_run"] = core.next_run(t) if enabled else None
    await raw[core.TASKS].update_one({"_id": tid}, {"$set": sets})
    await actors.audit(scope.ScopedDb(raw, scope.current()), "change", f"scheduled task {t['name']}",
                       {"id": tid, "fields": sorted(k for k, v in change.items() if v is not None)})
    return await get_task(tid)


@router.delete("/{tid}")
async def delete(tid: str):
    raw = _raw()
    t = await _task(tid)
    _may_change(t)
    async for r in raw[core.RUNS].find({"task": tid, "status": "queued"}):
        await core.end_run(raw, r, "cancelled", summary="the task was deleted")
    await raw[core.RUNS].delete_many({"task": tid, "status": {"$nin": list(core.ACTIVE)}})
    await raw[core.TASKS].delete_one({"_id": tid})
    await actors.audit(scope.ScopedDb(raw, scope.current()), "delete", f"scheduled task {t['name']}", {"id": tid})
    return {"deleted": tid}


@router.post("/{tid}/run")
async def run_now(tid: str):
    raw = _raw()
    t = await _task(tid)
    _may_change(t)
    _may(kinds.right_of(t["type"], t.get("params")))
    st = await core.settings(raw)
    if not st["on"]:
        raise HTTPException(409, "the scheduler is switched off")
    if await core.open_run(raw, tid):
        raise HTTPException(409, "a run of this task is waiting or going already")
    kind = kinds.KINDS[t["type"]]
    if kind.llm and not (t.get("params") or {}).get("accept_cost"):
        raise HTTPException(400, "this task spends money on a model: accept the cost first")
    why = await runner.cap_reason(raw, t, kind)
    if why:
        raise HTTPException(409, why)
    run = core.new_run(t, "manual", by={"id": _who()["id"], "name": _who().get("name")})
    await core.insert_run(raw, run)
    await actors.audit(scope.ScopedDb(raw, scope.current()), "run", f"scheduled task {t['name']}", {"id": tid, "run": run["_id"]})
    try:
        await core.start_queued(raw)
    except Exception:                                            # noqa: BLE001 - the loop starts it then
        pass
    return run_out(await raw[core.RUNS].find_one({"_id": run["_id"]}) or run)


@router.post("/{tid}/pause")
async def pause(tid: str):
    raw = _raw()
    t = await _task(tid)
    _may_change(t)
    await raw[core.TASKS].update_one({"_id": tid}, {"$set": {"enabled": False, "next_run": None, "updated_at": core.now()}})
    await actors.audit(scope.ScopedDb(raw, scope.current()), "pause", f"scheduled task {t['name']}", {"id": tid})
    return await get_task(tid)


@router.post("/{tid}/resume")
async def resume(tid: str):
    raw = _raw()
    t = await _task(tid)
    _may_change(t)
    _may(kinds.right_of(t["type"], t.get("params")))
    if kinds.KINDS[t["type"]].llm and not (t.get("params") or {}).get("accept_cost"):
        raise HTTPException(400, "this task spends money on a model: accept the cost first")
    try:
        nxt = core.next_run(t)
    except cron.Bad as exc:
        _bad(exc)
    await raw[core.TASKS].update_one({"_id": tid}, {"$set": {"enabled": True, "next_run": nxt, "updated_at": core.now()},
                                                   "$unset": {"paused_why": ""}})
    await actors.audit(scope.ScopedDb(raw, scope.current()), "resume", f"scheduled task {t['name']}", {"id": tid})
    return await get_task(tid)


@router.get("/{tid}/runs")
async def runs(tid: str, limit: int = 50, before: str = ""):
    await _task(tid)
    q: dict = {"task": tid}
    if before:
        b = core.aware(before)
        if b:
            q["at"] = {"$lt": b}
    rows = [r async for r in _raw()[core.RUNS].find(q).sort("at", -1).limit(max(1, min(limit, 200)))]
    return [run_out(r) for r in rows]

