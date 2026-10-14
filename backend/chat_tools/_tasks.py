"""Scheduled tasks for the Chat's tools (backend/sched): a task named by its
id or by words of its name, and a task as the model reads it."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException

from . import ToolError


def refused(exc: HTTPException) -> ToolError:
    d = exc.detail
    return ToolError(d if isinstance(d, str) else str(d))


def when(iso: str | None, tz: str | None) -> str:
    if not iso:
        return "-"
    from ..sched import cron
    try:
        t = datetime.fromisoformat(iso)
    except ValueError:
        return iso
    t = t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    return t.astimezone(cron.zone(tz)).strftime("%a %d %b %H:%M")


def line(t: dict) -> str:
    last = t.get("last") or {}
    return (f"- {t['name']} (id {t['id']}, {t['type_label']}): {t.get('words')} ({t.get('tz')}), "
            f"{'on' if t.get('enabled') else 'paused'}, next {when(t.get('next_run'), t.get('tz'))}, "
            f"last {last.get('status') or 'never run'}"
            + (f" - {last.get('summary')}" if last.get("summary") else "")
            + (f"; delivers to {', '.join(k for k in ('inapp', 'telegram', 'file') if (t.get('deliver') or {}).get(k))}"
               if t.get("deliver") else ""))


async def find(ref: str) -> dict:
    """A task of this space by its id, or the one whose name has these words."""
    from ..sched import api
    ref = (ref or "").strip()
    if not ref:
        raise ToolError("say which task (its id or its name)")
    rows = (await api.listing())["tasks"]
    hit = [t for t in rows if t["id"] == ref]
    if not hit:
        words = ref.lower().split()
        hit = [t for t in rows if all(w in (t.get("name") or "").lower() for w in words)]
    if len(hit) != 1:
        names = "; ".join(f"{t['name']} ({t['id']})" for t in (hit or rows)[:20]) or "none yet"
        raise ToolError(("several tasks match" if hit else "no task matches") + f" '{ref}': {names}")
    return hit[0]
