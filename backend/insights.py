"""Everything the app has used, over time: the Analytics room's figures.

Each card already knows what its own note cost. This reads across all of
them, and across what no card owns - the machine itself, the database, the
catalog, the part supplier - for one time range, bucketed so it can be
drawn:

* LLMs      - every call: tokens by type, money, by model, provider,
              surface, room and project (``llm_calls``)
* compute   - every job the machine ran for a note: wall and CPU time,
              memory, disk (``compute_jobs``), and the energy that implies
* machine   - CPU, memory, GPU and estimated power, sampled once a minute
              by ``sampler()`` into ``metrics``; energy and its cost follow
* work      - notes written, queued and done per room; runs and how long
              they took; the thread and the questions
* storage   - the database, each collection, each file bucket, the disk
              caches, and the free space on the disk
* catalog   - projects (top-level folders) and what is in each
* LCSC      - every request made of the part supplier, and how it was
              answered (the journal on disk)

Energy is an estimate unless the host lets us read the CPU's RAPL counter
(root-only on most kernels): busy core-seconds times watts per core, plus
the GPU at its power limit while busy. The room says which it is.
"""

from __future__ import annotations

import asyncio
import json
import re
import os
import shutil
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psutil

from . import compute, lcsc, scope, store, sysinfo, usage

METRICS = "metrics"
TIMINGS = "api_timings"
BOARD_RUNS = "board_runs"
EVENTS = "server_events"
HISTORY = "item_history"
WEEKLY = "weekly_reports"
SAMPLE_EVERY = 60          # seconds
KEEP_DAYS = 120            # machine samples are dropped after this

ROOT = Path(__file__).resolve().parent.parent

# Buckets a range is drawn in: short ranges fine, long ones coarse, so a
# chart has a few dozen to a couple of hundred points whatever the range.
BUCKETS = [(6 * 3600, 5 * 60), (2 * 86400, 3600), (62 * 86400, 86400)]
WEEK = 7 * 86400


def _dt(s) -> datetime | None:
    if isinstance(s, datetime):
        return s if s.tzinfo else s.replace(tzinfo=timezone.utc)
    if not s:
        return None
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def bucket_for(seconds: float) -> int:
    for upto, size in BUCKETS:
        if seconds <= upto:
            return size
    return WEEK


class Buckets:
    """Sums per (bucket, series), for drawing."""

    def __init__(self, since: datetime, until: datetime, size: int):
        self.t0, self.size = since.timestamp(), size
        self.n = max(1, int((until.timestamp() - self.t0) // size) + 1)
        self.data: dict[str, list[float]] = {}

    def add(self, series: str, at: datetime, value: float):
        i = int((at.timestamp() - self.t0) // self.size)
        if 0 <= i < self.n:
            self.data.setdefault(series, [0.0] * self.n)[i] += value

    def out(self, top: int | None = None) -> dict:
        items = sorted(self.data.items(), key=lambda kv: -sum(kv[1]))
        if top and len(items) > top:
            rest = [sum(col) for col in zip(*(v for _, v in items[top:]))]
            items = items[:top] + [("other", rest)]
        return {"t0": self.t0, "step": self.size, "n": self.n,
                "series": [{"name": k, "values": [round(x, 6) for x in v]}
                           for k, v in items]}


TOKEN_KINDS = ("input", "output", "cache_read", "cache_write", "thinking")


async def _llm_sums(db, lo: str, hi: str, since: datetime, size: int) -> dict:
    """Every LLM figure the room shows for a range, in one aggregation.

    The agents' calls are not tagged with the note they were for, so a call
    is put down to the run that was open when it was made - each run has
    its room, its note and its start and finish. A call made with no run
    open stays "(no run)"."""
    toks = {k: {"$sum": {"$ifNull": [f"${k}", 0]}} for k in TOKEN_KINDS}
    all_toks = {"$sum": {"$add": [{"$ifNull": [f"${k}", 0]} for k in TOKEN_KINDS]}}
    cost = {"$sum": {"$ifNull": ["$cost_usd", 0]}}
    group = lambda key: [{"$group": {"_id": key, "calls": {"$sum": 1}, "cost": cost,  # noqa: E731
                                      "tokens": all_toks}}]
    t0_ms = int(since.timestamp() * 1000)
    runs = [r async for r in db.runs.find(
        {"started_at": {"$lte": hi}, "$or": [{"finished_at": {"$gte": lo}}, {"finished_at": None}]},
        {"started_at": 1, "finished_at": 1, "revision": 1, "room": 1, "_id": 1})]
    runs.sort(key=lambda r: r.get("started_at") or "", reverse=True)   # latest wins
    now = datetime.now(timezone.utc).isoformat()
    branches = [{"case": {"$and": [{"$gte": ["$at", r["started_at"]]},
                                   {"$lte": ["$at", r.get("finished_at") or now]}]},
                 "then": {"rev": r.get("revision"), "room": r.get("room") or "cad",
                          "run": str(r["_id"])}}
                for r in runs if r.get("started_at")]
    owner_expr = ({"$switch": {"branches": branches,
                               "default": {"rev": None, "room": None, "run": None}}}
                  if branches else {"rev": None, "room": None, "run": None})
    pipeline = [
        {"$match": {"at": {"$gte": lo, "$lte": hi}}},
        {"$addFields": {"_run": owner_expr}},
        {"$addFields": {"_rev": {"$ifNull": ["$revision", "$_run.rev"]},
                        "_room": "$_run.room"}},
        # The LLM-call log is the machine's. A workspace other than the
        # default one counts only the calls made during its own runs; a call
        # with no run open is the default workspace's.
        *([] if getattr(db, "workspace", scope.DEFAULT) == scope.DEFAULT
          else [{"$match": {"_run.run": {"$ne": None}}}]),
        {"$addFields": {"_b": {"$floor": {"$divide": [
            {"$subtract": [{"$toLong": {"$toDate": "$at"}}, t0_ms]}, size * 1000]}}}},
        {"$facet": {
            "total": [{"$group": {"_id": None, "calls": {"$sum": 1}, "cost": cost,
                                  "unpriced": {"$sum": {"$cond": [{"$eq": [{"$ifNull": ["$cost_usd", None]}, None]}, 1, 0]}},
                                  **toks}}],
            "buckets": [{"$group": {"_id": {"b": "$_b", "provider": "$provider", "model": "$model"},
                                    "cost": cost, **toks}}],
            # Per token type as well: cache savings are worked out per model.
            "model": [{"$group": {"_id": "$model", "calls": {"$sum": 1}, "cost": cost,
                                  "tokens": all_toks, **toks}}],
            "provider": group("$provider"),
            "kind": group({"$ifNull": ["$kind", "$surface"]}),
            "revision": group({"rev": "$_rev", "room": "$_room"}),
            # Per run, for re-runs of the same note; per note per bucket, so
            # one project's spend can be drawn on its own.
            "run": group("$_run.run"),
            "bucket_rev": [{"$group": {"_id": {"b": "$_b", "rev": "$_rev"}, "cost": cost,
                                       "tokens": all_toks}}],
        }},
    ]
    got = [d async for d in db[usage.CALLS].aggregate(pipeline)]
    return got[0] if got else {k: [] for k in ("total", "buckets", "model", "provider", "kind",
                                               "revision", "run", "bucket_rev")}


def _median(xs: list[float]) -> float | None:
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    m = len(xs) // 2
    return round(xs[m] if len(xs) % 2 else (xs[m - 1] + xs[m]) / 2, 4)


def _rank(d: dict[str, dict], key: str, top: int = 12) -> list[dict]:
    rows = [{"name": k, **v} for k, v in d.items()]
    rows.sort(key=lambda r: -(r.get(key) or 0))
    return rows[:top]


# ---------------------------------------------------------------- API timings

# Every request the server answers, summed per minute per route in memory
# and written once a minute: writing each request to a database this far
# away would itself be the slowest thing the server does.
LATENCY_EDGES = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]   # ms
_timing: dict[tuple, dict] = {}


def record_request(method: str, route: str, status: int, ms: float) -> None:
    minute = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    key = (minute, method, route)
    t = _timing.get(key)
    if t is None:
        t = _timing[key] = {"count": 0, "ms": 0.0, "max_ms": 0.0, "errors": 0,
                            "hist": [0] * (len(LATENCY_EDGES) + 1)}
    t["count"] += 1
    t["ms"] += ms
    t["max_ms"] = max(t["max_ms"], ms)
    t["errors"] += 1 if status >= 500 else 0
    t["hist"][next((i for i, e in enumerate(LATENCY_EDGES) if ms <= e), len(LATENCY_EDGES))] += 1


async def flush_timings(db) -> None:
    """The finished minutes, into the database."""
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    done = [k for k in _timing if k[0] < now]
    if not done:
        return
    rows = [{"at": k[0], "method": k[1], "route": k[2], **_timing.pop(k)} for k in done]
    await db[TIMINGS].insert_many(rows)


def p95(hist: list[int]) -> float | None:
    """The 95th percentile from a histogram, as the bucket's upper edge."""
    total = sum(hist)
    if not total:
        return None
    seen = 0
    for i, n in enumerate(hist):
        seen += n
        if seen >= 0.95 * total:
            return float(LATENCY_EDGES[i]) if i < len(LATENCY_EDGES) else float(LATENCY_EDGES[-1] * 2)
    return None


# ---------------------------------------------------------------- board runs

async def record_board_run(db, board: str, out: dict) -> None:
    """One board pipeline run: how well the board came out, kept so its
    quality can be followed over time."""
    lay = out.get("layout") or {}
    route = lay.get("route") or {}
    drc = lay.get("drc") or {}
    erc = (out.get("schematic") or {}).get("erc") or {}
    size = lay.get("size_mm") or [None, None]
    await db[BOARD_RUNS].insert_one({
        "at": datetime.now(timezone.utc), "board": board, "seconds": out.get("seconds"),
        "unrouted": route.get("unrouted"), "tracks": route.get("tracks"),
        "vias": route.get("vias"), "length_mm": route.get("length_mm"),
        "drc_errors": drc.get("error_count"), "drc_warnings": drc.get("warning_count"),
        "erc_errors": erc.get("error_count"), "erc_warnings": erc.get("warning_count"),
        "parts": lay.get("placed"), "width_mm": size[0], "height_mm": size[1],
        "area_cm2": round(size[0] * size[1] / 100, 2) if size[0] and size[1] else None,
    })


# ---------------------------------------------------------------- sampler

_last: dict | None = None


def _gpu_now() -> dict | None:
    try:
        g = sysinfo._gpu()
    except Exception:
        return None
    return g or None


def sample_row() -> dict:
    """One minute of the machine: load, memory, GPU, and the energy spent
    since the last sample."""
    global _last
    now = datetime.now(timezone.utc)
    cpu = compute.machine_cpu() or {}
    mem = psutil.virtual_memory()
    gpu = _gpu_now()
    row = {"at": now, "cpu_pct": psutil.cpu_percent(interval=None),
           "ram_used": mem.used, "ram_total": mem.total,
           "gpu_pct": (gpu or {}).get("util"), "gpu_temp": (gpu or {}).get("temp_c")}
    if _last and cpu.get("busy_s") is not None:
        dt = (now - _last["at"]).total_seconds()
        busy = max(0.0, cpu["busy_s"] - _last["busy_s"])
        gpu_s = dt * (row["gpu_pct"] or 0) / 100.0
        rapl0, rapl1 = _last.get("rapl_uj"), cpu.get("rapl_uj")
        measured = ((rapl1 - rapl0) / 3.6e9) if (rapl0 is not None and rapl1 is not None
                                                 and rapl1 >= rapl0) else None
        e = compute.energy(busy, measured_wh=measured, gpu_s=gpu_s)
        row.update(seconds=round(dt, 1), busy_core_s=round(busy, 2), wh=e["wh"],
                   watts=round(e["wh"] * 3600.0 / dt, 1) if dt else None,
                   basis=e["basis"])
    _last = {"at": now, "busy_s": cpu.get("busy_s"), "rapl_uj": cpu.get("rapl_uj")}
    return row


async def sampler(get_db) -> None:
    """Once a minute, for as long as the server runs. Samples older than
    KEEP_DAYS are dropped by the database itself."""
    psutil.cpu_percent(interval=None)          # prime the running average
    try:
        await get_db()[METRICS].create_index("at", expireAfterSeconds=KEEP_DAYS * 86400)
        await get_db()[TIMINGS].create_index("at", expireAfterSeconds=KEEP_DAYS * 86400)
    except Exception:
        pass
    try:
        await get_db()[HISTORY].create_index([("item", 1), ("kind", 1), ("at", 1)], unique=True)
        await get_db()[EVENTS].insert_one({"at": datetime.now(timezone.utc), "kind": "start",
                                           "server": _ME})
    except Exception:
        pass
    tick = 0
    while True:
        try:
            # One machine, one set of samples: more than one server can run
            # against this database (a worktree's, say), and each sampling
            # would count the machine's energy twice.
            if await _hold_lease(get_db()):
                row = sample_row()
                row["db_ms"] = await _db_round_trip(get_db())
                if tick % 10 == 0:
                    row.update(await _sizes(get_db()))
                    await snapshot_items(get_db())
                if tick % 60 == 0:
                    await weekly_if_due(get_db())
                # New lines from the agents' transcripts into llm_calls.
                try:
                    await usage.ingest(get_db(), force=False)
                except Exception:
                    pass
                await get_db()[METRICS].insert_one(row)
                tick += 1
            await flush_timings(get_db())
        except Exception:
            pass
        await asyncio.sleep(SAMPLE_EVERY)


async def _db_round_trip(db) -> float:
    """How long the database takes to answer the smallest question, in ms."""
    import time
    t0 = time.perf_counter()
    await db.command("ping")
    return round((time.perf_counter() - t0) * 1000, 1)


async def _sizes(db) -> dict:
    """The database and the disk, for storage growth over time."""
    st = await db.command("dbstats")
    disk = shutil.disk_usage(ROOT)
    return {"db_bytes": st.get("dataSize", 0), "db_storage": st.get("storageSize", 0),
            "disk_used": disk.used, "disk_total": disk.total}


async def snapshot_items(db) -> None:
    """History for what only keeps its latest value: each model's built size
    and build time, each app's firmware size and last test. A row is written
    when the value's own time stamp is new, so nothing repeats."""
    from pymongo.errors import DuplicateKeyError
    rows = []
    async for m in db.models.find({}, {"artifacts.viewer.bytes": 1, "artifacts.viewer.at": 1,
                                       "build_secs": 1}):
        v = (m.get("artifacts") or {}).get("viewer") or {}
        if v.get("at"):
            rows.append({"item": m["_id"], "kind": "model_build", "at": v["at"],
                         "bytes": v.get("bytes"), "build_secs": m.get("build_secs")})
    async for a in db.apps.find({}, {"firmware": 1, "last_test": 1}):
        fw = a.get("firmware") or {}
        if fw.get("at") and fw.get("summary"):
            rows.append({"item": a["_id"], "kind": "firmware", "at": fw["at"],
                         "flash_bytes": fw["summary"].get("flash_bytes"),
                         "ram_bytes": fw["summary"].get("ram_bytes"), "ok": fw.get("ok")})
        t = a.get("last_test") or {}
        if t.get("at"):
            counts = t.get("counts") or {}
            rows.append({"item": a["_id"], "kind": "test", "at": t["at"], "ok": t.get("ok"),
                         "passed": counts.get("passed", 0), "failed": counts.get("failed", 0),
                         "wall_s": t.get("wall_s")})
    for r in rows:
        try:
            await db[HISTORY].insert_one(r)
        except DuplicateKeyError:
            pass


_ME = f"{os.uname().nodename}:{os.getpid()}"
LEASE_S = 90
# Raised when the sampler records something new: a server with newer
# sampler code takes the lease from one with older, so a worktree left on
# yesterday's code does not keep today's fields from being recorded.
SAMPLER_VERSION = 2


async def _hold_lease(db) -> bool:
    """Whether this server is the one that samples the machine. It holds a
    lease that it renews every sample; if it stops, another takes over once
    the lease runs out."""
    from pymongo import ReturnDocument
    from pymongo.errors import DuplicateKeyError
    now = datetime.now(timezone.utc)
    try:
        got = await db[METRICS + "_lease"].find_one_and_update(
            {"_id": "sampler", "$or": [{"owner": _ME}, {"until": {"$lt": now}},
                                       {"version": {"$lt": SAMPLER_VERSION}},
                                       {"version": {"$exists": False}}]},
            {"$set": {"owner": _ME, "until": now + timedelta(seconds=LEASE_S),
                      "version": SAMPLER_VERSION}},
            upsert=True, return_document=ReturnDocument.AFTER)
    except DuplicateKeyError:
        return False            # held by another server, and not yet run out
    return bool(got and got.get("owner") == _ME)


# ---------------------------------------------------------------- the read

async def _projects(db) -> tuple[dict, dict]:
    """Folder id -> top-level project name, and every item id -> project."""
    folders = {f["_id"]: f async for f in db.folders.find({}, {"name": 1, "parent": 1})}

    def top(fid):
        seen = set()
        while fid and fid in folders and folders[fid].get("parent") and fid not in seen:
            seen.add(fid)
            fid = folders[fid]["parent"]
        return (folders.get(fid) or {}).get("name") or (fid or "(no project)")

    owner: dict[str, str] = {}
    kinds: dict[str, str] = {}

    async def items(coll):
        return coll, [d async for d in db[coll].find({}, {"folder": 1})]
    for coll, docs in await asyncio.gather(items("models"), items("boards"), items("apps")):
        for d in docs:
            owner[d["_id"]] = top(d.get("folder")) if d.get("folder") else "(no project)"
            kinds[d["_id"]] = coll[:-1]
    return owner, kinds


def _dir_bytes(p: Path) -> int:
    total = 0
    if p.exists():
        for f in p.rglob("*"):
            try:
                if f.is_file():
                    total += f.stat().st_size
            except OSError:
                pass
    return total


# ---------------------------------------------------------------- helpers

QUOTA_BYTES = float(os.getenv("STORAGE_QUOTA_MB", "512")) * 1e6


def api_routes_err(timing_rows: list[dict]) -> list[dict]:
    got: dict[str, int] = defaultdict(int)
    for t in timing_rows:
        if t.get("errors"):
            got[f"{t['method']} {t['route']}"] += t["errors"]
    return [{"route": k, "errors": v} for k, v in sorted(got.items(), key=lambda kv: -kv[1])]


def _mean_of(b: "Buckets", counts: "Buckets") -> dict:
    """Averages per bucket, from sums, over the buckets that were sampled."""
    n = counts.data.get("n", [0.0] * counts.n)
    out = b.out()
    for x in out["series"]:
        x["values"] = [round(v / c, 2) if c else None for v, c in zip(x["values"], n)]
    return out


async def _grid_files(db) -> list[dict]:
    """Every stored file's size and upload time - the database's growth,
    back to the first file, with no sampling needed."""
    async def one(bucket):
        return [{"bucket": bucket, "at": d.get("uploadDate"), "bytes": d.get("length") or 0}
                async for d in db[f"{bucket}.files"].find({}, {"uploadDate": 1, "length": 1})]
    got = await asyncio.gather(*(one(b) for b in ("model_files", "cad_files", "shots")))
    return [r for rs in got for r in rs]


def _growth(grid_rows, metric_rows, since, until, size) -> dict:
    """Stored files over time, and when the quota and the disk run out at
    the pace of the last fortnight."""
    now = datetime.now(timezone.utc)
    files = sorted((_dt(r["at"]), r["bytes"], r["bucket"]) for r in grid_rows if _dt(r["at"]))
    added = Buckets(since, until, size)
    for at, n, bucket in files:
        added.add(bucket, at, n)
    recent = now - timedelta(days=14)
    per_day = sum(n for at, n, _ in files if at >= recent) / 14.0
    sized = [m for m in metric_rows if m.get("db_storage")]
    last = sized[-1] if sized else None
    out = {"added": added.out(), "per_day_bytes": round(per_day),
           "files": len(files), "files_bytes": sum(n for _, n, _ in files),
           "quota_bytes": QUOTA_BYTES}
    if last:
        out["db_storage"] = last["db_storage"]
        left = QUOTA_BYTES - last["db_storage"]
        out["quota_days"] = round(left / per_day, 1) if per_day > 0 and left > 0 else None
        disk_rows = [(_dt(m["at"]), m["disk_used"]) for m in sized if m.get("disk_used")]
        if len(disk_rows) >= 2 and (disk_rows[-1][0] - disk_rows[0][0]).total_seconds() > 6 * 3600:
            (t0, u0), (t1, u1) = disk_rows[0], disk_rows[-1]
            rate = (u1 - u0) / ((t1 - t0).total_seconds() / 86400)
            out["disk_per_day_bytes"] = round(rate)
            free = last["disk_total"] - last["disk_used"]
            out["disk_days"] = round(free / rate, 1) if rate > 0 else None
        out["disk_free"] = last["disk_total"] - last["disk_used"]
    return out


def _anomalies(spend: list[float], by_note: dict, revs: dict, job_rows: list, since, size) -> dict:
    """What stands far above the usual: buckets of spend, notes, jobs.
    'Far' is three times the median, and more than the median plus five
    times the typical spread - rare enough to be worth a look."""
    out = {"buckets": [], "items": []}

    def high(vals: list[float], v: float) -> float | None:
        vals = [x for x in vals if x]
        if len(vals) < 4:
            return None
        med = _median(vals) or 0
        mad = _median([abs(x - med) for x in vals]) or 0
        limit = max(3 * med, med + 5 * mad)
        return med if v > limit and v > 0 else None

    for i, v in enumerate(spend):
        med = high(spend, v)
        if med is not None:
            out["buckets"].append(i)
            out["items"].append({"kind": "spend", "what": datetime.fromtimestamp(
                since.timestamp() + i * size, timezone.utc).isoformat(), "value": round(v, 2),
                "typical": round(med, 2), "unit": "usd"})
    costs = [v["cost_usd"] for v in by_note.values()]
    for rid, v in by_note.items():
        med = high(costs, v["cost_usd"])
        if med is not None:
            r = revs.get(rid) or {}
            out["items"].append({"kind": "note", "what": r.get("summary") or (r.get("comment") or rid)[:90],
                                 "id": rid, "value": round(v["cost_usd"], 2), "typical": round(med, 2),
                                 "unit": "usd"})
    by_kind: dict[str, list] = defaultdict(list)
    for j in job_rows:
        by_kind[j.get("kind") or "?"].append(j)
    for kind, js in by_kind.items():
        walls = [float(j.get("wall_s") or 0) for j in js]
        for j in js:
            med = high(walls, float(j.get("wall_s") or 0))
            if med is not None:
                out["items"].append({"kind": f"{kind} job", "what": j.get("model") or j.get("revision") or "?",
                                     "at": j.get("at"), "value": round(float(j["wall_s"]), 1),
                                     "typical": round(med, 1), "unit": "s"})
    out["items"].sort(key=lambda x: -(x["value"] / x["typical"] if x["typical"] else 0))
    out["items"] = out["items"][:20]
    return out


async def _previous(db, since: datetime, until: datetime) -> dict:
    """The same totals for the period before, for the change on each tile."""
    lo, hi = since.isoformat(), until.isoformat()
    toks = {"$add": [{"$ifNull": [f"${k}", 0]} for k in TOKEN_KINDS]}
    llm, jobs, notes, runs, wh = await asyncio.gather(
        db[usage.CALLS].aggregate([{"$match": {"at": {"$gte": lo, "$lt": hi}}},
                                   {"$group": {"_id": None, "usd": {"$sum": {"$ifNull": ["$cost_usd", 0]}},
                                               "calls": {"$sum": 1}, "tokens": {"$sum": toks}}}]).to_list(1),
        db[compute.JOBS].aggregate([{"$match": {"at": {"$gte": lo, "$lt": hi}}},
                                    {"$group": {"_id": None, "cpu_s": {"$sum": {"$ifNull": ["$cpu_s", 0]}},
                                                "jobs": {"$sum": 1},
                                                "failed": {"$sum": {"$cond": [{"$ne": [{"$ifNull": ["$rc", 0]}, 0]}, 1, 0]}}}}]).to_list(1),
        db.revisions.count_documents({"created_at": {"$gte": lo, "$lt": hi}}),
        db.runs.count_documents({"started_at": {"$gte": lo, "$lt": hi}}),
        db[METRICS].aggregate([{"$match": {"at": {"$gte": since, "$lt": until}}},
                               {"$group": {"_id": None, "wh": {"$sum": {"$ifNull": ["$wh", 0]}}}}]).to_list(1))
    a, j = (llm or [{}])[0], (jobs or [{}])[0]
    return {"llm_usd": a.get("usd", 0.0), "llm_calls": a.get("calls", 0), "tokens": a.get("tokens", 0),
            "cpu_s": j.get("cpu_s", 0.0), "jobs": j.get("jobs", 0), "failed": j.get("failed", 0),
            "wh": ((wh or [{}])[0]).get("wh", 0.0), "notes": notes, "runs": runs}


_DOCKER: tuple[float, dict] | None = None


async def docker_usage() -> dict:
    """What Docker holds: images, containers, volumes, build cache - the
    sandboxes and the KiCad image. Asked at most every ten minutes."""
    import subprocess
    import time
    global _DOCKER
    if _DOCKER and time.time() - _DOCKER[0] < 600:
        return _DOCKER[1]

    def run(*args):
        try:
            r = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=60)
            return [json.loads(line) for line in r.stdout.splitlines() if line.strip()] if r.returncode == 0 else None
        except (OSError, ValueError, subprocess.SubprocessError):
            return None
    df, images, ps = await asyncio.gather(
        asyncio.to_thread(run, "system", "df", "--format", "{{json .}}"),
        asyncio.to_thread(run, "images", "--format", "{{json .}}"),
        asyncio.to_thread(run, "ps", "-a", "--format", "{{json .}}"))
    if df is None:
        out = {"available": False}
    else:
        out = {"available": True,
               "summary": [{"type": d.get("Type"), "total": d.get("TotalCount"), "active": d.get("Active"),
                            "size": d.get("Size"), "reclaimable": d.get("Reclaimable")} for d in df],
               "images": sorted(({"name": f"{i.get('Repository')}:{i.get('Tag')}", "size": i.get("Size"),
                                  "created": i.get("CreatedSince"),
                                  "redline": (i.get("Repository") or "").startswith("redline")}
                                 for i in images or []), key=lambda i: (not i["redline"], i["name"]))[:40],
               "containers": [{"name": c.get("Names"), "image": c.get("Image"), "state": c.get("State"),
                               "status": c.get("Status"), "size": c.get("Size")} for c in ps or []]}
    _DOCKER = (time.time(), out)
    return out


def _project_detail(owner, kinds, revs, by_note, runs_of, job_rows, board_rows, history_rows,
                    model_docs, board_docs, app_docs, agg, question_log, lead_rows, since, size, B) -> dict:
    """Each project on its own: its models, boards and apps matched by id,
    each with a picture, its notes, what they cost, its builds, and what it
    keeps a history of - so one project is never read off a merged total."""
    docs = {**{d["_id"]: ("model", d) for d in model_docs}, **{d["_id"]: ("board", d) for d in board_docs},
            **{d["_id"]: ("app", d) for d in app_docs}}
    notes_of: dict[str, list[str]] = defaultdict(list)
    for rid, r in revs.items():
        if r.get("model"):
            notes_of[r["model"]].append(rid)
    projects: dict[str, dict] = {}
    for item, pr in owner.items():
        kind, d = docs.get(item, (kinds.get(item), {}))
        rids = sorted(notes_of.get(item, []))
        pictured = [rid for rid in rids if revs[rid].get("image")]
        picture = (f"/api/boards/{item}/layout.svg?v={((d.get('artifacts') or {}).get('layout') or {}).get('at', '')}"
                   if kind == "board" else
                   f"/api/revisions/{pictured[-1]}/image" if pictured else None)
        spend = sum(by_note.get(rid, {}).get("cost_usd", 0) for rid in rids)
        runs = [r for rid in rids for r in runs_of.get(rid, [])]
        secs = [(_dt(r["finished_at"]) - _dt(r["started_at"])).total_seconds()
                for r in runs if r.get("finished_at") and r.get("started_at")]
        jobs = [j for j in job_rows if j.get("model") == item]
        builds = [j for j in jobs if j.get("kind") in ("build", "render", "board", "layout", "test", "flash")]
        hist = sorted((h for h in history_rows if h.get("item") == item), key=lambda h: str(h.get("at")))
        entry = {"id": item, "kind": kind, "title": d.get("title") or item, "picture": picture,
                 "notes": len(rids), "applied": sum(1 for rid in rids if revs[rid].get("status") == "applied"),
                 "spend_usd": round(spend, 2), "runs": len(runs),
                 "run_median_s": _median(secs), "jobs": len(builds),
                 "failed": sum(1 for j in builds if j.get("rc")),
                 "job_median_s": _median([float(j.get("wall_s") or 0) for j in builds]),
                 "history": [{k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in h.items()
                              if k not in ("_id", "item")} for h in hist][-60:]}
        if kind == "model":
            v = (d.get("artifacts") or {}).get("viewer") or {}
            entry.update(size_bytes=v.get("bytes"), build_secs=d.get("build_secs"),
                         build_walls=[{"at": j.get("at"), "wall_s": j.get("wall_s"), "ok": not j.get("rc")}
                                      for j in sorted(jobs, key=lambda j: j.get("at") or "")
                                      if j.get("kind") == "build"][-40:])
        elif kind == "board":
            entry.update(unrouted=(d.get("route") or {}).get("unrouted"),
                         drc_errors=(d.get("drc") or {}).get("error_count"),
                         size_mm=(d.get("layout") or {}).get("size_mm"),
                         board_runs=[{k: (v.isoformat() if isinstance(v, datetime) else v)
                                      for k, v in r.items() if k != "_id"}
                                     for r in board_rows if r.get("board") == item])
        elif kind == "app":
            t = d.get("last_test") or {}
            tests = [j for j in jobs if j.get("kind") == "test"]
            entry.update(platform=d.get("platform"), last_test_ok=t.get("ok"),
                         last_test_counts=t.get("counts"),
                         test_pass_rate=round(sum(1 for j in tests if not j.get("rc")) / len(tests), 3) if tests else None,
                         tests=len(tests), firmware=(d.get("firmware") or {}).get("summary"))
        p = projects.setdefault(pr, {"name": pr, "items": [], "spend_usd": 0.0, "notes": 0,
                                     "runs": 0, "jobs": 0, "failed": 0})
        p["items"].append(entry)
        for k in ("spend_usd", "notes", "runs", "jobs", "failed"):
            p[k] += entry[k]
    # Spend over time, per item, from the per-note-per-bucket sums.
    item_of = {rid: r.get("model") for rid, r in revs.items()}
    series: dict[str, "Buckets"] = {}
    for row in agg.get("bucket_rev", []):
        rid = (row["_id"] or {}).get("rev")
        item = item_of.get(rid)
        if not item or item not in owner:
            continue
        b = series.setdefault(owner[item], B())
        b.add(docs.get(item, (None, {}))[1].get("title") or item,
              datetime.fromtimestamp(since.timestamp() + row["_id"]["b"] * size + 1, timezone.utc), row["cost"])
    rev_item = {rid: r.get("model") for rid, r in revs.items()}
    for name, p in projects.items():
        ids = {i["id"] for i in p["items"]}
        p["spend_usd"] = round(p["spend_usd"], 2)
        p["items"].sort(key=lambda i: (-i["spend_usd"], i["title"]))
        p["spend_series"] = series[name].out(top=8) if name in series else None
        p["lead"] = [r for r in lead_rows if rev_item.get(r["id"]) in ids][:15]
        p["questions"] = [q for q in question_log if q.get("item") in ids][:20]
    return projects


# ---------------------------------------------------------------- weekly

def week_of(d: datetime) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def weekly_text(d: dict) -> str:
    """A week in a few lines of Markdown, from the 7-day answer."""
    ch = d.get("change") or {}
    arrow = lambda k: "" if ch.get(k) is None else f" ({'+' if ch[k] >= 0 else ''}{ch[k]:.0f}% on the week before)"  # noqa: E731
    llm, sub, cache, nc = d["llm"], d["subscription"], d["cache"], d["note_costs"]
    lines = [f"**LLM work: ${llm['cost_usd']:,.0f}** at API list prices, {llm['calls']:,} calls{arrow('llm_usd')}."]
    if sub.get("plan_usd") is not None:
        lines.append(f"The subscription cost **${sub['plan_usd']:,.0f}** for the week - "
                     f"**${sub.get('saved_usd', 0):,.0f}** less than the same work on the API.")
    if cache.get("hit_ratio") is not None:
        lines.append(f"{cache['hit_ratio'] * 100:.1f}% of prompts came from the cache, saving "
                     f"${cache['saved_usd']:,.0f}.")
    notes = sum((d["work"]["status"] or {}).values())
    lines.append(f"**{notes} notes** written{arrow('notes')}; a finished note cost "
                 f"{'$%.0f' % nc['median'] if nc.get('median') is not None else '–'} (median).")
    top = (llm.get("top_notes") or [None])[0]
    if top:
        lines.append(f"Most expensive: *{top['title'] or top['id']}* - ${top['cost_usd']:,.0f}.")
    w = d.get("waste") or {}
    if w.get("usd") or w.get("failed_jobs"):
        lines.append(f"Waste: ${w.get('usd', 0):,.0f} on re-runs of the same note, "
                     f"{w.get('failed_jobs', 0)} failed jobs.")
    an = (d.get("anomalies") or {}).get("items") or []
    if an:
        a = an[0]
        show = (lambda v: f"${v:,.2f}") if a["unit"] == "usd" else (lambda v: f"{v:,.1f} s")
        lines.append(f"Unusual: {a['kind']} *{a['what']}* - {show(a['value'])} against a usual "
                     f"{show(a['typical'])}.")
    e = d.get("energy") or {}
    if e.get("machine_kwh"):
        lines.append(f"The machine used about {e['machine_kwh']:.2f} kWh ({e.get('basis')}).")
    return "\n\n".join(lines)


async def weekly_if_due(db) -> None:
    """Once a week, on Monday, the week before is written up and kept."""
    now = datetime.now(timezone.utc)
    if now.weekday() != 0:
        return
    last_week = week_of(now - timedelta(days=7))
    if await db[WEEKLY].find_one({"week": last_week}, {"_id": 1}):
        return
    until = now.replace(hour=0, minute=0, second=0, microsecond=0)
    data = await overview(db, until - timedelta(days=7), until)
    await db[WEEKLY].insert_one({"at": now, "week": last_week, "text": weekly_text(data)})


# The last answer for each range, kept in memory and on disk, and given
# straight away: opening the room should be instant, and whatever is newer
# can arrive a moment later. Older than FRESH_S, it is worked out again in
# the background while the old one is served, marked stale.
FRESH_S = 20
CACHE_DIR = ROOT / ".cache" / "insights"
_CACHE: dict[str, tuple[float, dict]] = {}
_WORKING: dict[str, asyncio.Task] = {}


def _disk(key: str) -> Path:
    return CACHE_DIR / f"{key.replace('/', '_')}.json"


def _remember(key: str, data: dict) -> None:
    import time
    _CACHE[key] = (time.time(), data)
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = _disk(key).with_suffix(".tmp")
        tmp.write_text(json.dumps({"at": time.time(), "data": data}))
        tmp.replace(_disk(key))
    except OSError:
        pass


def _recall(key: str) -> tuple[float, dict] | None:
    if key in _CACHE:
        return _CACHE[key]
    try:
        got = json.loads(_disk(key).read_text())
        _CACHE[key] = (got["at"], got["data"])
        return _CACHE[key]
    except (OSError, ValueError, KeyError):
        return None


async def _work_out(db, key: str, span) -> dict:
    # The agents' transcripts are read into llm_calls by the sampler, once a
    # minute, in the background - never in front of a request.
    import time
    t0 = time.perf_counter()
    since, until = await span()
    data = await overview(db, since, until)
    data["computed_at"] = datetime.now(timezone.utc).isoformat()
    # How long working the figures out took: shown beside "updated".
    data["took_ms"] = round((time.perf_counter() - t0) * 1000)
    data["shape"] = SHAPE
    _remember(key, data)
    return data


def _refresh(db, key: str, span) -> None:
    task = _WORKING.get(key)
    if task and not task.done():
        return
    _WORKING[key] = asyncio.create_task(_work_out(db, key, span))


# Bumped whenever the shape of the answer changes, so an answer kept in the
# old shape is never served to a page that expects the new one.
SHAPE = 3


async def overview_cached(db, key: str, span) -> dict:
    """The last answer for this range at once; a fresh one on its way if it
    is older than FRESH_S. Only the very first ask of a range waits."""
    import time
    # One cache per workspace: each sees its own figures.
    ws = getattr(db, "workspace", scope.DEFAULT)
    key = f"v{SHAPE}-{key}" if ws == scope.DEFAULT else f"v{SHAPE}-{ws}-{key}"
    hit = _recall(key)
    if hit is None:
        return {**await _work_out(db, key, span), "stale": False}
    age = time.time() - hit[0]
    if age > FRESH_S:
        _refresh(db, key, span)
    return {**hit[1], "stale": age > FRESH_S, "age_s": round(age, 1)}


async def overview(db, since: datetime, until: datetime) -> dict:
    span = (until - since).total_seconds()
    size = bucket_for(span)
    B = lambda: Buckets(since, until, size)  # noqa: E731
    lo, hi = since.isoformat(), until.isoformat()
    # Everything the figures are made of, asked for at once: the database is
    # far away, and one round trip after another was most of the wait.
    def rows(coll, query, fields=None, sort=None):
        async def go():
            cur = db[coll].find(query, fields)
            if sort:
                cur = cur.sort(sort, 1)
            return [d async for d in cur]
        return go()

    async def count(coll):
        return await db[coll].count_documents({})

    (projects_map, rev_rows, agg, job_rows, metric_rows, all_runs, chat_rows,
     question_rows, prefs, dbst, coll_names, n_folders, n_models, n_boards, n_apps,
     n_parts, timing_rows, board_rows, event_rows, history_rows, grid_rows, previous,
     docker, weekly_rows, model_docs, board_docs, app_docs) = await asyncio.gather(
        _projects(db),
        rows("revisions", {}, {"kind": 1, "model": 1, "status": 1, "created_at": 1,
                               "queued_at": 1, "summary": 1, "comment": 1, "image": 1}),
        _llm_sums(db, lo, hi, since, size),
        rows(compute.JOBS, {"at": {"$gte": lo, "$lte": hi}}),
        rows(METRICS, {"at": {"$gte": since, "$lte": until}}, sort="at"),
        # Every run: a note written in the range may have been done after it.
        rows("runs", {}, {"started_at": 1, "finished_at": 1, "room": 1, "status": 1,
                          "title": 1, "revision": 1}),
        rows("chat", {"at": {"$gte": lo, "$lte": hi}}, {"at": 1, "room": 1, "role": 1}),
        rows("questions", {"at": {"$gte": lo, "$lte": hi}},
             {"at": 1, "answered_at": 1, "text": 1, "answer": 1, "revision": 1, "status": 1}),
        settings(db), db.command("dbstats"), db.list_collection_names(),
        count("folders"), count("models"), count("boards"), count("apps"), count(lcsc.PARTS),
        rows(TIMINGS, {"at": {"$gte": since, "$lte": until}}),
        rows(BOARD_RUNS, {"at": {"$gte": since, "$lte": until}}, sort="at"),
        rows(EVENTS, {"at": {"$gte": since, "$lte": until}}),
        rows(HISTORY, {}),
        _grid_files(db),
        _previous(db, since - (until - since), since),
        docker_usage(),
        rows(WEEKLY, {}, {"at": 1, "week": 1, "text": 1}, sort="at"),
        rows("models", {}, {"title": 1, "folder": 1, "artifacts.viewer.bytes": 1,
                            "artifacts.viewer.at": 1, "build_secs": 1}),
        rows("boards", {}, {"title": 1, "folder": 1, "route": 1, "drc": 1,
                            "layout.size_mm": 1, "artifacts.layout.at": 1}),
        rows("apps", {}, {"title": 1, "folder": 1, "platform": 1, "last_test": 1,
                          "firmware.summary": 1, "firmware.at": 1}))
    price = prefs.get("kwh_price")
    owner, kinds = projects_map

    # Notes: which room and which project each belongs to.
    revs = {r["_id"]: r for r in rev_rows}
    room_of = lambda rid: compute.room_of((revs.get(rid) or {}).get("kind"))  # noqa: E731
    proj_of = lambda rid: owner.get((revs.get(rid) or {}).get("model") or "", "(no project)")  # noqa: E731

    # ---- LLMs
    # Added up inside the database: the link to it is slow and every row
    # pulled across costs, while the sums are a few kilobytes.
    llm = {"calls": 0, "cost_usd": 0.0, "unpriced_calls": 0,
           "tokens": {k: 0 for k in TOKEN_KINDS}}
    cost_by_provider, cost_by_model, tokens_by_type = B(), B(), B()
    by_model: dict[str, dict] = {}
    by_provider: dict[str, dict] = {}
    by_surface: dict[str, dict] = {}
    by_room: dict[str, dict] = defaultdict(lambda: {"calls": 0, "cost_usd": 0.0})
    by_project: dict[str, dict] = defaultdict(lambda: {"calls": 0, "cost_usd": 0.0})
    by_note: dict[str, dict] = {}
    for r in agg["buckets"]:
        at = datetime.fromtimestamp(since.timestamp() + r["_id"]["b"] * size + 1, timezone.utc)
        cost_by_provider.add(r["_id"]["provider"] or "?", at, r["cost"])
        cost_by_model.add(r["_id"]["model"] or "?", at, r["cost"])
        for k in TOKEN_KINDS:
            tokens_by_type.add(k, at, r[k])
    for r in agg["total"]:
        llm["calls"], llm["cost_usd"], llm["unpriced_calls"] = r["calls"], r["cost"], r["unpriced"]
        llm["tokens"] = {k: r[k] for k in TOKEN_KINDS}
    for key, into in (("model", by_model), ("provider", by_provider), ("kind", by_surface)):
        for r in agg[key]:
            into[r["_id"] or "?"] = {"calls": r["calls"], "cost_usd": r["cost"], "tokens": r["tokens"]}
    for r in agg["revision"]:
        rid, run_room = (r["_id"] or {}).get("rev"), (r["_id"] or {}).get("room")
        room = run_room or (room_of(rid) if rid else "(no run)")
        pr = proj_of(rid) if rid else "(no run)"
        for d, k in ((by_room, room), (by_project, pr)):
            d[k]["calls"] += r["calls"]; d[k]["cost_usd"] += r["cost"]
        if rid:
            n = by_note.setdefault(rid, {"calls": 0, "cost_usd": 0.0, "tokens": 0})
            n["calls"] += r["calls"]; n["cost_usd"] += r["cost"]; n["tokens"] += r["tokens"]

    # ---- compute jobs
    jobs = {"count": 0, "wall_s": 0.0, "cpu_s": 0.0, "wh": 0.0, "failed": 0}
    cpu_by_kind = B()
    by_kind: dict[str, dict] = defaultdict(lambda: {"jobs": 0, "wall_s": 0.0, "cpu_s": 0.0, "wh": 0.0,
                                                   "peak_rss_mb": 0.0})
    for j in job_rows:
        at = _dt(j.get("at"))
        if not at:
            continue
        cpu_s = float(j.get("cpu_s") or 0)
        wh = compute.energy(cpu_s, gpu_s=float(j.get("gpu_s") or 0))["wh"]
        k = j.get("kind") or "?"
        jobs["count"] += 1; jobs["wall_s"] += float(j.get("wall_s") or 0)
        jobs["cpu_s"] += cpu_s; jobs["wh"] += wh
        jobs["failed"] += 1 if j.get("rc") else 0
        cpu_by_kind.add(k, at, cpu_s / 3600.0)
        r = by_kind[k]
        r["jobs"] += 1; r["wall_s"] += float(j.get("wall_s") or 0); r["cpu_s"] += cpu_s; r["wh"] += wh
        r["peak_rss_mb"] = max(r["peak_rss_mb"], float(j.get("peak_rss_mb") or 0))

    # ---- the machine, from the sampler
    m_cpu, m_ram, m_gpu, m_watts, m_energy = B(), B(), B(), B(), B()
    counts = B()
    machine = {"wh": 0.0, "samples": 0, "basis": None, "first": None}
    for s in metric_rows:
        at = _dt(s["at"])
        machine["samples"] += 1
        machine["first"] = machine["first"] or at.isoformat()
        counts.add("n", at, 1)
        m_cpu.add("cpu %", at, s.get("cpu_pct") or 0)
        if s.get("ram_total"):
            m_ram.add("memory %", at, 100.0 * s["ram_used"] / s["ram_total"])
        if s.get("gpu_pct") is not None:
            m_gpu.add("gpu %", at, s["gpu_pct"])
        if s.get("watts") is not None:
            m_watts.add("watts", at, s["watts"])
        if s.get("wh"):
            machine["wh"] += s["wh"]
            m_energy.add("Wh", at, s["wh"])
            machine["basis"] = s.get("basis")

    def mean(b: Buckets) -> dict:
        n = counts.data.get("n", [0.0] * counts.n)
        out = b.out()
        for s in out["series"]:
            s["values"] = [round(v / c, 2) if c else None for v, c in zip(s["values"], n)]
        return out

    energy = {"machine_kwh": round(machine["wh"] / 1000, 4), "jobs_kwh": round(jobs["wh"] / 1000, 4),
              "basis": machine["basis"] or compute.WATTS_BASIS, "kwh_price": price,
              "machine_cost": round(machine["wh"] / 1000 * price, 4) if price is not None else None,
              "samples": machine["samples"], "sampled_since": machine["first"],
              "watts_per_core": compute.WATTS_PER_CORE}

    # ---- work: notes, runs, the thread, questions
    notes_by_room, done_by_room = B(), B()
    status_counts: dict[str, int] = defaultdict(int)
    for r in revs.values():
        at = _dt(r.get("created_at"))
        if at and since <= at <= until:
            notes_by_room.add(compute.room_of(r.get("kind")), at, 1)
            status_counts[r.get("status") or "?"] += 1
    run_rows = []
    run_rows_raw = [r for r in all_runs if lo <= (r.get("started_at") or "") <= hi]
    for r in run_rows_raw:
        s, f = _dt(r.get("started_at")), _dt(r.get("finished_at"))
        dur = (f - s).total_seconds() if s and f else None
        room = r.get("room") or "cad"
        if f:
            done_by_room.add(room, f, 1)
        run_rows.append({"room": room, "status": r.get("status"), "seconds": dur,
                         "title": r.get("title"), "revision": r.get("revision")})
    runs_by_room: dict[str, dict] = defaultdict(lambda: {"runs": 0, "done": 0, "seconds": 0.0})
    for r in run_rows:
        g = runs_by_room[r["room"]]
        g["runs"] += 1
        if r["seconds"] is not None:
            g["done"] += 1; g["seconds"] += r["seconds"]
    for g in runs_by_room.values():
        g["avg_s"] = round(g["seconds"] / g["done"], 1) if g["done"] else None
    chat_by_room = B()
    for m in chat_rows:
        at = _dt(m.get("at"))
        if at:
            chat_by_room.add(f"{m.get('room') or 'cad'} · {m.get('role')}", at, 1)
    q = {"asked": 0, "answered": 0, "wait_s": 0.0}
    for d in question_rows:
        q["asked"] += 1
        a, b = _dt(d.get("at")), _dt(d.get("answered_at"))
        if a and b:
            q["answered"] += 1; q["wait_s"] += (b - a).total_seconds()
    q["avg_wait_s"] = round(q["wait_s"] / q["answered"], 1) if q["answered"] else None

    # ---- note lead times: writing it, waiting for the agent, the agent's work
    runs_of: dict[str, list[dict]] = defaultdict(list)
    for r in all_runs:
        if r.get("revision"):
            runs_of[r["revision"]].append(r)
    leads, lead_rows = defaultdict(lambda: {"writing": [], "waiting": [], "working": [], "total": []}), []
    for rid, r in revs.items():
        made = _dt(r.get("created_at"))
        if not made or not (since <= made <= until):
            continue
        queued = _dt(r.get("queued_at"))
        rs = sorted(runs_of.get(rid, []), key=lambda x: x.get("started_at") or "")
        start = _dt(rs[0].get("started_at")) if rs else None
        done = max((_dt(x.get("finished_at")) for x in rs if x.get("finished_at")), default=None)
        stage = {
            "writing": (queued - made).total_seconds() if queued else None,
            "waiting": (start - queued).total_seconds() if start and queued else None,
            "working": (done - start).total_seconds() if done and start else None,
            "total": (done - made).total_seconds() if done else None,
        }
        room = compute.room_of(r.get("kind"))
        for k, v in stage.items():
            if v is not None and v >= 0:
                leads[room][k].append(v)
        lead_rows.append({"id": rid, "room": room,
                          "title": r.get("summary") or (r.get("comment") or "")[:90],
                          **{k: (round(v, 1) if v is not None and v >= 0 else None) for k, v in stage.items()}})
    lead_rows.sort(key=lambda x: -(x["total"] or 0))
    lead_times = {"by_room": [{"room": room, "notes": len(v["total"]) or len(v["writing"]),
                               **{k: _median(v[k]) for k in ("writing", "waiting", "working", "total")}}
                              for room, v in leads.items()],
                  "slowest": lead_rows[:10]}

    # ---- the agents' questions, in full
    question_log = []
    for d in sorted(question_rows, key=lambda d: d.get("at") or "", reverse=True):
        a, b = _dt(d.get("at")), _dt(d.get("answered_at"))
        text = (d.get("text") or "").strip()
        first = next((ln.strip("#*> -") for ln in text.splitlines() if ln.strip()), "")
        first = re.sub(r"[*_`]{1,3}", "", first)            # the line, not its Markdown
        question_log.append({
            "at": d.get("at"), "question": first[:200], "text": text[:4000],
            "answer": (d.get("answer") or "")[:1000], "status": d.get("status"),
            "wait_s": round((b - a).total_seconds(), 1) if a and b else None,
            "room": room_of(d["revision"]) if d.get("revision") else None,
            "item": (revs.get(d.get("revision")) or {}).get("model")})

    # ---- the cache: how much of what was read came from it, and what it saved
    cache = {"read": llm["tokens"]["cache_read"], "write": llm["tokens"]["cache_write"],
             "fresh": llm["tokens"]["input"], "saved_usd": 0.0, "by_model": []}
    looked = cache["read"] + cache["write"] + cache["fresh"]
    cache["hit_ratio"] = round(cache["read"] / looked, 4) if looked else None
    for r in agg["model"]:
        rates = usage._rates(r["_id"] or "")
        saved = None
        if rates:
            saved = r["cache_read"] * (rates["input"] - rates["cache_read"]) / 1e6
            cache["saved_usd"] += saved
        seen = r["cache_read"] + r["cache_write"] + r["input"]
        cache["by_model"].append({"name": r["_id"] or "?", "cache_read": r["cache_read"],
                                  "cache_write": r["cache_write"], "input": r["input"],
                                  "hit_ratio": round(r["cache_read"] / seen, 4) if seen else None,
                                  "saved_usd": round(saved, 4) if saved is not None else None})
    cache["by_model"].sort(key=lambda m: -(m["saved_usd"] or 0))
    hit_series = B()
    tok = {k: {x["name"]: x["values"] for x in tokens_by_type.out()["series"]}.get(k) for k in TOKEN_KINDS}
    for i in range(hit_series.n):
        rd = (tok["cache_read"] or [0] * hit_series.n)[i]
        tot = rd + (tok["cache_write"] or [0] * hit_series.n)[i] + (tok["input"] or [0] * hit_series.n)[i]
        if tot:
            hit_series.data.setdefault("hit %", [0.0] * hit_series.n)[i] = 100.0 * rd / tot
    cache["hit_series"] = hit_series.out()

    # ---- the subscription against what the same work lists at
    plan = prefs.get("plan_usd_month")
    months = span / (30.44 * 86400)
    subscription = {"plan_usd_month": plan, "plan_name": prefs.get("plan_name"),
                    "months": round(months, 3), "list_usd": round(llm["cost_usd"], 2),
                    "plan_usd": round(plan * months, 2) if plan is not None else None}
    if plan is not None:
        subscription["saved_usd"] = round(llm["cost_usd"] - plan * months, 2)
        subscription["ratio"] = round(llm["cost_usd"] / (plan * months), 2) if plan * months else None

    # ---- build health: failures per kind, and how long builds take per model
    health: dict[str, dict] = defaultdict(lambda: {"jobs": 0, "failed": 0, "wall": []})
    per_model: dict[str, list] = defaultdict(list)
    for j in job_rows:
        k = j.get("kind") or "?"
        health[k]["jobs"] += 1
        health[k]["failed"] += 1 if j.get("rc") else 0
        health[k]["wall"].append(float(j.get("wall_s") or 0))
        if k in ("build", "render") and j.get("model") and not j.get("rc"):
            per_model[j["model"]].append((_dt(j.get("at")), float(j.get("wall_s") or 0)))
    builds = {"by_kind": [{"name": k, "jobs": v["jobs"], "failed": v["failed"],
                           "fail_rate": round(v["failed"] / v["jobs"], 4) if v["jobs"] else None,
                           "median_s": _median(v["wall"]), "max_s": round(max(v["wall"]), 1) if v["wall"] else None}
                          for k, v in sorted(health.items(), key=lambda kv: -kv[1]["jobs"])]}
    slowest_models = sorted(per_model.items(), key=lambda kv: -(_median([w for _, w in kv[1]]) or 0))[:6]
    b_sum, b_n = B(), B()
    for model, pts in slowest_models:
        for at, w in pts:
            if at:
                b_sum.add(model, at, w); b_n.add(model, at, 1)
    trend = b_sum.out()
    counts_by = {x["name"]: x["values"] for x in b_n.out()["series"]}
    for x in trend["series"]:
        x["values"] = [round(v / c, 1) if c else None for v, c in zip(x["values"], counts_by[x["name"]])]
    builds["model_trend"] = trend
    builds["by_model"] = [{"name": m, "builds": len(p), "median_s": _median([w for _, w in p]),
                           "max_s": round(max(w for _, w in p), 1)} for m, p in slowest_models]

    # ---- what a finished note costs, over time
    done_at = {rid: max((_dt(x.get("finished_at")) for x in rs if x.get("finished_at")), default=None)
               for rid, rs in runs_of.items()}
    per_bucket: dict[int, list[float]] = defaultdict(list)
    for rid, v in by_note.items():
        at = done_at.get(rid)
        if at and since <= at <= until and v["cost_usd"] > 0:
            per_bucket[int((at.timestamp() - since.timestamp()) // size)].append(v["cost_usd"])
    note_cost = B()
    for i, costs in per_bucket.items():
        if 0 <= i < note_cost.n:
            note_cost.data.setdefault("median", [None] * note_cost.n)[i] = _median(costs)
            note_cost.data.setdefault("mean", [None] * note_cost.n)[i] = round(sum(costs) / len(costs), 4)
    finished_costs = [c for cs in per_bucket.values() for c in cs]
    note_costs = {"series": {"t0": note_cost.t0, "step": size, "n": note_cost.n,
                             "series": [{"name": k, "values": v} for k, v in note_cost.data.items()]},
                  "notes": len(finished_costs), "median": _median(finished_costs),
                  "mean": round(sum(finished_costs) / len(finished_costs), 4) if finished_costs else None}

    # ---- the API: which routes are slow
    routes: dict[str, dict] = defaultdict(lambda: {"count": 0, "ms": 0.0, "max_ms": 0.0, "errors": 0,
                                                  "hist": [0] * (len(LATENCY_EDGES) + 1)})
    api_count, api_avg_sum = B(), B()
    for t in timing_rows:
        key = f"{t['method']} {t['route']}"
        g = routes[key]
        g["count"] += t["count"]; g["ms"] += t["ms"]; g["errors"] += t.get("errors", 0)
        g["max_ms"] = max(g["max_ms"], t["max_ms"])
        g["hist"] = [a + b for a, b in zip(g["hist"], t["hist"])]
        at = _dt(t["at"])
        api_count.add("requests", at, t["count"])
        api_avg_sum.add("ms", at, t["ms"])
    latency = api_avg_sum.out()
    cnt = (api_count.data.get("requests") or [0] * api_count.n)
    for x in latency["series"]:
        x["name"] = "average ms"
        x["values"] = [round(v / c, 1) if c else None for v, c in zip(x["values"], cnt)]
    api = {"requests": sum(g["count"] for g in routes.values()),
           "errors": sum(g["errors"] for g in routes.values()),
           "per_bucket": api_count.out(), "latency": latency,
           "routes": sorted(({"route": k, "count": g["count"], "avg_ms": round(g["ms"] / g["count"], 1),
                              "p95_ms": p95(g["hist"]), "max_ms": round(g["max_ms"], 1),
                              "errors": g["errors"]} for k, g in routes.items()),
                            key=lambda r: -r["avg_ms"])[:25]}

    # ---- board quality, run by run
    boards_q: dict[str, list] = defaultdict(list)
    for r in board_rows:
        boards_q[r["board"]].append({k: (r.get(k) if not isinstance(r.get(k), datetime)
                                         else r[k].isoformat())
                                     for k in ("at", "unrouted", "drc_errors", "drc_warnings",
                                               "erc_errors", "area_cm2", "tracks", "vias",
                                               "length_mm", "parts", "seconds")})
    board_quality = [{"board": b, "runs": rs, "first": rs[0], "last": rs[-1]}
                     for b, rs in boards_q.items()]

    # ---- retries and loops: the same job run over and over for one note
    per_note_kind: dict[tuple, dict] = defaultdict(lambda: {"runs": 0, "failed": 0, "wall_s": 0.0})
    for j in job_rows:
        if j.get("revision"):
            g = per_note_kind[(j["revision"], j.get("kind") or "?")]
            g["runs"] += 1; g["failed"] += 1 if j.get("rc") else 0
            g["wall_s"] += float(j.get("wall_s") or 0)
    loops = []
    for (rid, kind), g in per_note_kind.items():
        if g["runs"] >= 5 or g["failed"] >= 2:
            r = revs.get(rid) or {}
            loops.append({"id": rid, "kind": kind, **{k: round(v, 1) for k, v in g.items()},
                          "title": r.get("summary") or (r.get("comment") or "")[:90],
                          "room": compute.room_of(r.get("kind")), "project": proj_of(rid)})
    loops.sort(key=lambda x: -x["runs"])
    reruns = [{"id": rid, "runs": len(rs), "title": (revs.get(rid) or {}).get("summary")
               or ((revs.get(rid) or {}).get("comment") or "")[:90]}
              for rid, rs in runs_of.items() if len(rs) > 1 and rid in revs]

    # ---- waste: work that produced nothing kept
    run_cost = {r["_id"]: r["cost"] for r in agg.get("run", []) if r["_id"]}
    rerun_usd, rerun_runs = 0.0, 0
    for rid, rs in runs_of.items():
        ordered = sorted(rs, key=lambda x: x.get("started_at") or "")
        for r in ordered[:-1]:                       # every run but the last
            c = run_cost.get(str(r["_id"]))
            if c:
                rerun_usd += c; rerun_runs += 1
    rejected_usd = sum(v["cost_usd"] for rid, v in by_note.items()
                       if (revs.get(rid) or {}).get("status") == "rejected")
    failed_jobs = [j for j in job_rows if j.get("rc")]
    failed_cpu = sum(float(j.get("cpu_s") or 0) for j in failed_jobs)
    waste = {"rerun_usd": round(rerun_usd, 2), "rerun_runs": rerun_runs,
             "rejected_usd": round(rejected_usd, 2),
             "rejected_notes": sum(1 for r in revs.values() if r.get("status") == "rejected"),
             "failed_jobs": len(failed_jobs), "failed_cpu_h": round(failed_cpu / 3600, 3),
             "failed_wh": round(compute.energy(failed_cpu)["wh"], 2),
             "failed_by_kind": dict(sorted(((k, sum(1 for j in failed_jobs if (j.get("kind") or "?") == k))
                                            for k in {j.get("kind") or "?" for j in failed_jobs}),
                                           key=lambda kv: -kv[1])),
             "usd": round(rerun_usd + rejected_usd, 2)}

    # ---- uptime: server starts, and the minutes nobody was sampling
    samples = sorted(_dt(m["at"]) for m in metric_rows)
    gaps, down_s = [], 0.0
    for a, b in zip(samples, samples[1:]):
        g = (b - a).total_seconds()
        if g > 3 * SAMPLE_EVERY:
            gaps.append({"from": a.isoformat(), "to": b.isoformat(), "minutes": round(g / 60, 1)})
            down_s += g - SAMPLE_EVERY
    watched = (samples[-1] - samples[0]).total_seconds() if len(samples) > 1 else 0
    uptime = {"starts": [{"at": _dt(e["at"]).isoformat(), "server": e.get("server")}
                         for e in sorted(event_rows, key=lambda e: _dt(e["at"]))],
              "gaps": gaps[-20:], "down_minutes": round(down_s / 60, 1),
              "watched_hours": round(watched / 3600, 2),
              "up_pct": round(100 * (1 - down_s / watched), 2) if watched else None,
              "errors_5xx": sum(t.get("errors", 0) for t in timing_rows),
              "error_routes": [r for r in api_routes_err(timing_rows)][:10]}

    # ---- the database's answer time, as the sampler measured it
    db_lat = B()
    db_vals = []
    for m in metric_rows:
        if m.get("db_ms") is not None:
            db_lat.add("round trip ms", _dt(m["at"]), m["db_ms"]); db_vals.append(m["db_ms"])
    db_latency = {"series": _mean_of(db_lat, counts), "median_ms": _median(db_vals),
                  "p95_ms": round(sorted(db_vals)[int(0.95 * (len(db_vals) - 1))], 1) if db_vals else None,
                  "samples": len(db_vals)}

    # ---- storage growth and when it runs out
    growth = _growth(grid_rows, metric_rows, since, until, size)

    # ---- anomalies: buckets and notes far above the usual
    spend = [sum(col) for col in zip(*(x["values"] for x in cost_by_provider.out()["series"]))] \
        if cost_by_provider.data else []
    anomalies = _anomalies(spend, by_note, revs, job_rows, since, size)

    # ---- change against the period before, of the same length
    now_tot = {"llm_usd": llm["cost_usd"], "llm_calls": llm["calls"],
               "tokens": sum(llm["tokens"].values()), "cpu_s": jobs["cpu_s"], "jobs": jobs["count"],
               "failed": jobs["failed"], "wh": machine["wh"] or jobs["wh"],
               "notes": sum(status_counts.values()), "runs": len(run_rows)}
    change = {k: (round((now_tot[k] - previous.get(k, 0)) / previous[k] * 100, 1)
                  if previous.get(k) else None) for k in now_tot}

    # ---- per project: every model, board and app, matched by id
    project_detail = _project_detail(owner, kinds, revs, by_note, runs_of, job_rows, board_rows,
                                     history_rows, model_docs, board_docs, app_docs, agg,
                                     question_log, lead_rows, since, size, B)

    # ---- storage
    st = dbst
    async def one(name):
        try:
            c = await db.command("collstats", name)
        except Exception:
            return None
        return {"name": name, "docs": c.get("count", 0), "bytes": c.get("size", 0),
                "storage": c.get("storageSize", 0)}
    # Side by side, not one after another: each is a round trip.
    colls = [c for c in await asyncio.gather(*(one(n) for n in coll_names)) if c]
    colls.sort(key=lambda c: -c["bytes"])
    caches = [{"name": n, "bytes": _dir_bytes(ROOT / ".cache" / n)}
              for n in ("artifacts", "lcsc", "kicad", "uploads")]
    caches = [c for c in caches if c["bytes"]]
    disk = shutil.disk_usage(ROOT)
    storage = {"db_bytes": st.get("dataSize", 0), "db_storage": st.get("storageSize", 0),
               "index_bytes": st.get("indexSize", 0), "objects": st.get("objects", 0),
               "collections": colls, "caches": caches,
               "disk": {"total": disk.total, "used": disk.used, "free": disk.free}}

    # ---- catalog, by project
    projects: dict[str, dict] = defaultdict(lambda: {"models": 0, "boards": 0, "apps": 0,
                                                     "notes": 0, "cost_usd": 0.0})
    for item, pr in owner.items():
        projects[pr][kinds[item] + "s"] += 1
    for r in revs.values():
        projects[owner.get(r.get("model") or "", "(no project)")]["notes"] += 1
    for pr, v in by_project.items():
        if pr in projects:
            projects[pr]["cost_usd"] += v["cost_usd"]
    catalog = {"folders": n_folders, "models": n_models, "boards": n_boards,
               "apps": n_apps, "parts": n_parts,
               "notes": len(revs)}

    # ---- LCSC, from the journal
    lcsc_by_source = B()
    lcsc_tot: dict[str, int] = defaultdict(int)
    journal = lcsc.LOOK / "requests.jsonl"
    if journal.exists():
        for line in journal.read_text(errors="replace").splitlines()[-20000:]:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            at = _dt(row.get("at")) or (datetime.fromtimestamp(row["t"], timezone.utc)
                                        if isinstance(row.get("t"), (int, float)) else None)
            if at and since <= at <= until:
                src = row.get("source") or "?"
                lcsc_by_source.add(src, at, 1)
                lcsc_tot[src] += 1
                lcsc_tot["total"] += 1

    # ---- top notes by LLM cost, named
    top_notes = []
    for rid, v in sorted(by_note.items(), key=lambda kv: -kv[1]["cost_usd"])[:10]:
        r = revs.get(rid) or {}
        top_notes.append({"id": rid, **{k: round(x, 4) if isinstance(x, float) else x for k, x in v.items()},
                          "room": compute.room_of(r.get("kind")), "project": proj_of(rid)})
    note_titles = {rid: (revs[rid].get("summary") or (revs[rid].get("comment") or "")[:90])
                   for rid in by_note if rid in revs}
    for t in top_notes:
        t["title"] = note_titles.get(t["id"], "")

    rnd = lambda d: {k: (round(v, 4) if isinstance(v, float) else v) for k, v in d.items()}  # noqa: E731
    return {
        "range": {"since": lo, "until": hi, "step": size},
        "llm": {**rnd(llm), "tokens": llm["tokens"],
                "cost_by_provider": cost_by_provider.out(),
                "cost_by_model": cost_by_model.out(top=6),
                "tokens_by_type": tokens_by_type.out(),
                "by_model": [rnd(r) for r in _rank(by_model, "cost_usd")],
                "by_provider": [rnd(r) for r in _rank(by_provider, "cost_usd")],
                "by_surface": [rnd(r) for r in _rank(by_surface, "cost_usd")],
                "by_room": [rnd(r) for r in _rank(by_room, "cost_usd")],
                "by_project": [rnd(r) for r in _rank(by_project, "cost_usd")],
                "top_notes": top_notes},
        "compute": {**rnd(jobs), "cpu_hours_by_kind": cpu_by_kind.out(top=8),
                    "by_kind": [rnd(r) for r in _rank(by_kind, "cpu_s")]},
        "machine": {"cpu": mean(m_cpu), "ram": mean(m_ram), "gpu": mean(m_gpu),
                    "watts": mean(m_watts), "energy_wh": m_energy.out(),
                    "now": sysinfo.snapshot()},
        "energy": energy,
        "work": {"notes_by_room": notes_by_room.out(), "runs_done_by_room": done_by_room.out(),
                 "status": dict(status_counts),
                 "runs_by_room": [rnd({"room": k, **v}) for k, v in runs_by_room.items()],
                 "chat": chat_by_room.out(), "questions": rnd(q)},
        "storage": storage,
        "catalog": {**catalog, "projects": [rnd({"name": k, **v}) for k, v in
                                            sorted(projects.items(), key=lambda kv: -kv[1]["cost_usd"])]},
        "lcsc": {"by_source": lcsc_by_source.out(), "totals": dict(lcsc_tot)},
        "lead_times": lead_times, "questions": question_log, "cache": rnd(cache) | {
            "by_model": cache["by_model"], "hit_series": cache["hit_series"]},
        "subscription": subscription, "builds": builds, "note_costs": note_costs,
        "api": api, "board_quality": board_quality,
        "loops": {"jobs": loops[:15], "reruns": sorted(reruns, key=lambda x: -x["runs"])[:15]},
        "waste": waste, "uptime": uptime, "db_latency": db_latency, "growth": growth,
        "docker": docker, "anomalies": anomalies,
        "previous": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in previous.items()},
        "change": change, "now_totals": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in now_tot.items()},
        "weekly": [{"at": _dt(w["at"]).isoformat(), "week": w.get("week"), "text": w.get("text")}
                   for w in weekly_rows[-8:]][::-1],
        "project_detail": project_detail,
    }


# ---------------------------------------------------------------- settings

async def set_kwh_price(db, price: float | None) -> None:
    await db.settings.update_one({"_id": scope.key(store.SETTINGS_ID)},
                                 {"$set": {"kwh_price": price}}, upsert=True)
    forget()


def forget() -> None:
    """Drop every kept answer: a setting they were worked out with changed."""
    _CACHE.clear()
    for f in CACHE_DIR.glob("*.json") if CACHE_DIR.exists() else []:
        try:
            f.unlink()
        except OSError:
            pass


async def first_use(db) -> datetime | None:
    """When anything was first recorded - where 'all' starts."""
    got = []
    for coll, field in ((usage.CALLS, "at"), (compute.JOBS, "at"), ("revisions", "created_at")):
        d = await db[coll].find_one({field: {"$exists": True}}, sort=[(field, 1)])
        if d and _dt(d.get(field)):
            got.append(_dt(d[field]))
    return min(got) if got else None


SETTING_KEYS = ("kwh_price", "plan_usd_month", "plan_name")


async def settings(db) -> dict:
    """The room's own settings: electricity price and the subscription."""
    s = await db.settings.find_one({"_id": scope.key(store.SETTINGS_ID)}, dict.fromkeys(SETTING_KEYS, 1)) or {}
    out = {k: s.get(k) for k in SETTING_KEYS}
    if out["kwh_price"] is None:
        out["kwh_price"] = compute.KWH_PRICE
    return out


async def set_settings(db, patch: dict) -> None:
    await db.settings.update_one({"_id": scope.key(store.SETTINGS_ID)}, {"$set": patch}, upsert=True)
    forget()


async def kwh_price(db) -> float | None:
    """What a kilowatt-hour costs: set in the room, else the environment."""
    s = await db.settings.find_one({"_id": scope.key(store.SETTINGS_ID)}, {"kwh_price": 1}) or {}
    v = s.get("kwh_price")
    return float(v) if v is not None else compute.KWH_PRICE


def parse_range(rng: str, now: datetime | None = None) -> tuple[datetime, datetime]:
    """'1h', '24h', '7d', '30d', 'all' -> (since, until)."""
    now = now or datetime.now(timezone.utc)
    if rng == "all":
        return now - timedelta(days=3650), now
    unit = rng[-1:]
    try:
        n = float(rng[:-1])
    except ValueError:
        n, unit = 24, "h"
    secs = n * {"m": 60, "h": 3600, "d": 86400, "w": 604800}.get(unit, 3600)
    return now - timedelta(seconds=secs), now
