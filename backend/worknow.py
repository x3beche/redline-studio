"""What the machine is doing right now, in one answer - for the "Working
now" panel under the catalog.

Builds are spread over several places: a model being built carries
`building`; a rebuild a change elsewhere set off waits in `models.link`
(backend/links.py); a board's run, convert or layout is a job in
`board_jobs` (backend/jobs.py); a note being worked on is a run. Each said
so only on its own row, so with nothing open nobody could tell that
anything was happening. This puts them in one list, with what finished in
the last few minutes, so a build that just ended does not simply vanish.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter

from . import compute, jobs, links

router = APIRouter(prefix="/api/work")
RECENT_MIN = 10


def _db():
    from .main import db
    return db()


def _dt(v) -> datetime | None:
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _secs(since, now: datetime) -> float | None:
    t = _dt(since)
    return round((now - t).total_seconds(), 1) if t else None


@router.get("/now")
async def now() -> dict:
    d = _db()
    t = datetime.now(timezone.utc)
    items: list[dict] = []

    # Models: building now, or waiting for a rebuild a change set off.
    async for m in d.models.find(
            {"$or": [{"building": True}, {"link.state": {"$in": list(links.UPDATING)}}]},
            {"title": 1, "building": 1, "build_started": 1, "build_secs": 1, "link": 1}):
        link = m.get("link") or {}
        because = link.get("because") or {}
        building = bool(m.get("building")) or link.get("state") == "building"
        items.append({
            "kind": "model", "id": str(m["_id"]), "title": m.get("title") or str(m["_id"]),
            "state": "building" if building else "queued",
            "secs": _secs(m.get("build_started"), t) if building else None,
            "expected_secs": m.get("build_secs"),
            "why": (f"{because.get('title')}" + (f" v{because['version']}" if because.get("version") else "")
                    + " changed") if because.get("title") else None,
        })

    # Boards: a run, convert or layout in its own process.
    raw = d.raw if getattr(type(d), "SCOPED", False) else d
    async for j in raw[jobs.JOBS].find({"status": "running"}):
        items.append({"kind": "board", "id": j.get("board"), "title": j.get("board"),
                      "state": "building", "job": j.get("kind"),
                      "secs": _secs(j.get("started_at"), t), "expected_secs": None, "why": None})

    # Notes being worked on, any room.
    async for r in d.runs.find({"status": "running"}, {"title": 1, "revision": 1, "room": 1,
                                                        "percent": 1, "started_at": 1, "by": 1}):
        items.append({"kind": "note", "id": r.get("revision"), "title": r.get("title") or r.get("revision"),
                      "state": "running", "room": r.get("room"), "percent": r.get("percent"),
                      "secs": _secs(r.get("started_at"), t), "by": (r.get("by") or {}).get("id"),
                      "expected_secs": None, "why": None})

    # What finished lately, so it does not just disappear.
    since = t - timedelta(minutes=RECENT_MIN)
    recent = []
    async for j in d[compute.JOBS].find({"kind": {"$in": ["build", "layout", "run", "convert"]}},
                                        {"kind": 1, "model": 1, "board": 1, "at": 1, "wall_s": 1, "rc": 1}
                                        ).sort("at", -1).limit(30):
        at = _dt(j.get("at"))
        if not at or at < since:
            break
        recent.append({"kind": j.get("kind"), "id": j.get("model") or j.get("board"),
                       "ok": not j.get("rc"), "secs": j.get("wall_s"), "ago": _secs(at, t)})

    order = {"building": 0, "running": 0, "queued": 1}
    items.sort(key=lambda x: (order.get(x["state"], 2), -(x.get("secs") or 0)))
    return {"items": items, "recent": recent[:8], "at": t.isoformat()}
