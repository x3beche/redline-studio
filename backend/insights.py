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
import os
import shutil
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psutil

from . import compute, lcsc, store, sysinfo, usage

METRICS = "metrics"
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
            "model": group("$model"), "provider": group("$provider"),
            "kind": group({"$ifNull": ["$kind", "$surface"]}),
            "revision": group({"rev": "$_rev", "room": "$_room"}),
        }},
    ]
    got = [d async for d in db[usage.CALLS].aggregate(pipeline)]
    return got[0] if got else {k: [] for k in ("total", "buckets", "model", "provider", "kind", "revision")}


def _rank(d: dict[str, dict], key: str, top: int = 12) -> list[dict]:
    rows = [{"name": k, **v} for k, v in d.items()]
    rows.sort(key=lambda r: -(r.get(key) or 0))
    return rows[:top]


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
    except Exception:
        pass
    while True:
        try:
            await get_db()[METRICS].insert_one(sample_row())
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
    _remember(key, data)
    return data


def _refresh(db, key: str, span) -> None:
    task = _WORKING.get(key)
    if task and not task.done():
        return
    _WORKING[key] = asyncio.create_task(_work_out(db, key, span))


async def overview_cached(db, key: str, span) -> dict:
    """The last answer for this range at once; a fresh one on its way if it
    is older than FRESH_S. Only the very first ask of a range waits."""
    import time
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

    (projects_map, rev_rows, agg, job_rows, metric_rows, run_rows_raw, chat_rows,
     question_rows, price, dbst, coll_names, n_folders, n_models, n_boards, n_apps,
     n_parts) = await asyncio.gather(
        _projects(db),
        rows("revisions", {}, {"kind": 1, "model": 1, "status": 1, "created_at": 1,
                               "queued_at": 1, "summary": 1, "comment": 1}),
        _llm_sums(db, lo, hi, since, size),
        rows(compute.JOBS, {"at": {"$gte": lo, "$lte": hi}}),
        rows(METRICS, {"at": {"$gte": since, "$lte": until}}, sort="at"),
        rows("runs", {"started_at": {"$gte": lo, "$lte": hi}}),
        rows("chat", {"at": {"$gte": lo, "$lte": hi}}, {"at": 1, "room": 1, "role": 1}),
        rows("questions", {"at": {"$gte": lo, "$lte": hi}}, {"at": 1, "answered_at": 1}),
        kwh_price(db), db.command("dbstats"), db.list_collection_names(),
        count("folders"), count("models"), count("boards"), count("apps"), count(lcsc.PARTS))
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
