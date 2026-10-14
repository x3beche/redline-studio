"""task_create: a new scheduled task, as the Tasks tab's New makes one
(POST /api/scheduled) - asked first: the step waits for the person's Allow,
since a task acts on its own afterwards. "Every Monday send me the stock
report on Telegram" is a stock_report, weekly on day 1 at 09:00, delivered
to Telegram. A type that spends money on a model is made paused."""

from __future__ import annotations

from fastapi import HTTPException

from .. import app_links
from . import Ctx, Result, Tool, ToolError
from ._rights import need
from ._tasks import line, refused

TYPES = ["stock_report", "price_refresh", "build_refresh", "backup_check", "llm_usage", "cc_usage", "ask_chat", "digest"]


async def run(ctx: Ctx, args: dict) -> Result:
    from ..sched import api
    need("POST", "/api/scheduled")
    if args.get("type") not in TYPES:
        raise ToolError("type: one of " + ", ".join(TYPES))
    sched = args.get("schedule")
    if not isinstance(sched, dict):
        raise ToolError("schedule: an object, like {\"kind\": \"weekly\", \"days\": [1], \"at\": \"09:00\"}")
    deliver = args.get("deliver") if isinstance(args.get("deliver"), dict) else {}
    body = api.TaskIn(type=args["type"], name=args.get("name") or None, params=args.get("params") or {},
                      schedule=sched, tz=args.get("tz") or None,
                      deliver={"inapp": deliver.get("inapp", True), "telegram": bool(deliver.get("telegram")),
                               "file": bool(deliver.get("file")), "format": deliver.get("format") or "md"})
    try:
        t = await api.create(body)
    except HTTPException as exc:
        raise refused(exc) from None
    link = app_links.task(t["id"])
    note = " It spends money on a model, so it was made paused: the person starts it in the Tasks tab." if t["llm"] else ""
    return Result(text=f"Made the scheduled task:\n{line(t)}\nIts page: {link}.{note}",
                  say="Scheduled {name}: {when}", vars={"name": t["name"], "when": t.get("words") or "", "task": t["id"]},
                  summary=f"{t['name']}: {t.get('words')}")


TOOL = Tool(
    name="task_create", package="tasks", level="change", order=20,
    label="Schedule a task",
    about="Makes a scheduled task, after you allow it.",
    description="Make a scheduled task (the Tasks tab): a built-in job that runs on a schedule and sends its result. "
                "Use it when the person asks for something recurring ('every Monday send the stock report to Telegram', "
                "'refresh the prices every night'). Call task_list with types=true first if unsure of a type's inputs. "
                "type: stock_report (low stock, what to reorder, value), price_refresh (makers' pages re-read, LCSC "
                "offers of boards), build_refresh (rebuild models; params.models), backup_check, llm_usage (LLM costs), "
                "cc_usage (Command Code windows), ask_chat (a saved question answered by a model - costs money each "
                "run: say so; it is made paused), digest (params.parts: several reports in one). schedule: "
                "{kind: daily|weekdays, at: 'HH:MM'} | {kind: weekly, days: [1..7, Monday 1], at} | "
                "{kind: monthly, day: 1..31 or -1 for the last, at} | {kind: hours, every: N, minute} | "
                "{kind: cron, cron: '0 9 * * 1'}. tz: an IANA zone (default the app's, Europe/Istanbul). deliver: "
                "{inapp, telegram, file}. The person is asked to allow it before it is made; say what it will do.",
    schema={"type": "object", "properties": {
        "type": {"type": "string", "enum": TYPES},
        "name": {"type": "string", "description": "A short name; default the type's"},
        "params": {"type": "object", "description": "The type's inputs (task_list types=true lists them); omit for defaults"},
        "schedule": {"type": "object", "description": "When: {kind, at, days, day, every, minute, cron}"},
        "tz": {"type": "string", "description": "IANA time zone, e.g. Europe/Istanbul"},
        "deliver": {"type": "object", "properties": {
            "inapp": {"type": "boolean"}, "telegram": {"type": "boolean"}, "file": {"type": "boolean"},
            "format": {"type": "string", "enum": ["md", "csv"]}}}},
        "required": ["type", "schedule"]},
    running="Scheduling a task", failed="Could not schedule the task",
    asks=lambda args: True,
    run=run, undo="a scheduled task is kept on its own - delete it in the Tasks tab")
