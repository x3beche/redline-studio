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

from . import compute, lcsc, store, sysinfo, usage

METRICS = "metrics"
TIMINGS = "api_timings"
BOARD_RUNS = "board_runs"
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
        {"started_at": 1, "finished_at": 1, "revision": 1, "room": 1})]
    runs.sort(key=lambda r: r.get("started_at") or "", reverse=True)   # latest wins
    now = datetime.now(timezone.utc).isoformat()
    branches = [{"case": {"$and": [{"$gte": ["$at", r["started_at"]]},
                                   {"$lte": ["$at", r.get("finished_at") or now]}]},
                 "then": {"rev": r.get("revision"), "room": r.get("room") or "cad"}}
                for r in runs if r.get("started_at")]
    owner_expr = ({"$switch": {"branches": branches, "default": {"rev": None, "room": None}}}
                  if branches else {"rev": None, "room": None})
    pipeline = [
        {"$match": {"at": {"$gte": lo, "$lte": hi}}},
        {"$addFields": {"_run": owner_expr}},
        {"$addFields": {"_rev": {"$ifNull": ["$revision", "$_run.rev"]},
                        "_room": "$_run.room"}},
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
        }},
    ]
    got = [d async for d in db[usage.CALLS].aggregate(pipeline)]
    return got[0] if got else {k: [] for k in ("total", "buckets", "model", "provider", "kind", "revision")}


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
    while True:
        try:
            await get_db()[METRICS].insert_one(sample_row())
            await flush_timings(get_db())
        except Exception:
            pass
        await asyncio.sleep(SAMPLE_EVERY)


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
    # The agents' transcripts into llm_calls first - the slow part, and the
    # reason this runs behind the page rather than in front of it.
    try:
        await usage.ingest(db, force=False)
    except Exception:
        pass
    since, until = await span()
    data = await overview(db, since, until)
    data["computed_at"] = datetime.now(timezone.utc).isoformat()
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
SHAPE = 2


async def overview_cached(db, key: str, span) -> dict:
    """The last answer for this range at once; a fresh one on its way if it
    is older than FRESH_S. Only the very first ask of a range waits."""
    import time
    key = f"v{SHAPE}-{key}"
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
     n_parts, timing_rows, board_rows) = await asyncio.gather(
        _projects(db),
        rows("revisions", {}, {"kind": 1, "model": 1, "status": 1, "created_at": 1,
                               "queued_at": 1, "summary": 1, "comment": 1}),
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
        rows(BOARD_RUNS, {"at": {"$gte": since, "$lte": until}}, sort="at"))
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
            "room": room_of(d["revision"]) if d.get("revision") else None})

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
    }


# ---------------------------------------------------------------- settings

async def set_kwh_price(db, price: float | None) -> None:
    await db.settings.update_one({"_id": store.SETTINGS_ID},
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
    s = await db.settings.find_one({"_id": store.SETTINGS_ID}, dict.fromkeys(SETTING_KEYS, 1)) or {}
    out = {k: s.get(k) for k in SETTING_KEYS}
    if out["kwh_price"] is None:
        out["kwh_price"] = compute.KWH_PRICE
    return out


async def set_settings(db, patch: dict) -> None:
    await db.settings.update_one({"_id": store.SETTINGS_ID}, {"$set": patch}, upsert=True)
    forget()


async def kwh_price(db) -> float | None:
    """What a kilowatt-hour costs: set in the room, else the environment."""
    s = await db.settings.find_one({"_id": store.SETTINGS_ID}, {"kwh_price": 1}) or {}
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
