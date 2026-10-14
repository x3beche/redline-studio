"""task_run: a scheduled task run now (POST /api/scheduled/{id}/run), asked
first - it may take a while, read sites or spend money. The result comes as
the task delivers it, and in its history."""

from __future__ import annotations

from fastapi import HTTPException

from .. import app_links
from . import Ctx, Result, Tool
from ._rights import need
from ._tasks import find, refused


async def run(ctx: Ctx, args: dict) -> Result:
    from ..sched import api
    need("POST", "/api/scheduled/x/run")
    t = await find(str(args.get("task") or ""))
    try:
        r = await api.run_now(t["id"])
    except HTTPException as exc:
        raise refused(exc) from None
    return Result(text=f"Started {t['name']} now (run {r['id']}, {r['status']}); its result goes where the task "
                       f"delivers, and to its history: {app_links.task(t['id'])}.",
                  say="Ran {name} now", vars={"name": t["name"], "task": t["id"]}, summary=r["status"])


TOOL = Tool(
    name="task_run", package="tasks", level="change", order=30,
    label="Run a scheduled task now",
    about="Runs a scheduled task now, after you allow it.",
    description="Run one scheduled task now, outside its schedule, when the person asks ('run the stock report now'). "
                "task: its id or words of its name (task_list lists them). The result arrives as the task delivers it.",
    schema={"type": "object", "properties": {"task": {"type": "string", "description": "The task's id or name"}},
            "required": ["task"]},
    running="Running {task}", failed="Could not run {task}",
    asks=lambda args: True,
    run=run, undo="a run goes on its own - see it in the Tasks tab")
