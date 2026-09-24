"""What the machine spent, as opposed to what the models cost.

The card already says how many tokens a revision burned. That is only half
the bill: every build boots OpenCascade and booleans solids for minutes, and
every render drives a headless browser. None of that shows up in a token
count.

Three things are measured and one is estimated, and the card says which is
which:

* A build is a process we start and wait for, so the kernel has already
  counted it: the ``getrusage(RUSAGE_CHILDREN)`` delta across the call is
  exact and covers the whole subtree, the memory-cap wrapper and its
  systemd scope included (checked: a 1.50 s burn reports 1.51 s through
  ``tools/capped.sh``). Peak memory is sampled instead - rusage keeps only
  the high-water mark of the largest child ever reaped, which says nothing
  about this build - so the process tree's resident size is read once a
  second and the largest total kept.
* A render is not waited for. The headless browser is told to quit and its
  renderers wander off on their own, so rusage sees none of it - the first
  attempt filed a 92-second render as 0.11 core-seconds. Its tree is polled
  while it works instead, and the highest reading for each process is what
  counts.
* The machine's own busy counter (``/proc/stat``) is read when a run starts
  and when it finishes. That gives the core-seconds the whole box burned in
  that window - the browser, the editor and the desktop included - so it is
  reported separately and never as the revision's own.
* Energy is an estimate. Intel's RAPL counter has been root-only since the
  Platypus side-channel fix, and nvidia-smi reports no power for the card in
  this machine, so there is nothing to read; ``rapl_uj`` is here for a host
  where there is. Failing that, core-seconds times a per-core watt figure is
  the honest substitute, and it carries "assumed" the way the token prices
  do.

Two builds at once would split one rusage delta between them, because the
counter belongs to the server process rather than to either child. They do
not overlap here - the memory ceiling exists precisely so that they don't -
and the total across the revision stays right either way.
"""

from __future__ import annotations

import asyncio
import os
import resource
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import psutil

JOBS = "compute_jobs"

# Jiffies per second, for /proc/stat.
HZ = os.sysconf("SC_CLK_TCK")

# USD per kWh. Unset means the card shows energy and no money, the same way
# an unpriced model shows tokens and no money.
_price = os.environ.get("X3_KWH_PRICE")
KWH_PRICE: float | None = float(_price) if _price else None

# Watts one busy core costs. The default is this machine's package power
# under an all-core load divided by its cores; it is a guess about the
# outside world, like the token rate card, and says so.
WATTS_PER_CORE = float(os.environ.get("X3_WATTS_PER_CORE", 8.0))
WATTS_BASIS = ("measured" if os.environ.get("X3_WATTS_PER_CORE")
               else "assumed")

# Filled on first use: asking the driver costs a subprocess, and a machine
# with no card should not pay it on every roll-up.
_WATTS_GPU: float | None = None

RAPL = Path("/sys/class/powercap/intel-rapl:0/energy_uj")


def rapl_uj() -> int | None:
    """Package energy in microjoules, or None where it cannot be read.

    Root-only on most kernels since 2020. Read anyway: on a host that allows
    it the run window gets a measured figure instead of an assumed one.
    """
    try:
        return int(RAPL.read_text())
    except (OSError, ValueError):
        return None


def machine_cpu() -> dict | None:
    """Core-seconds the whole machine has spent busy and idle, since boot."""
    try:
        parts = Path("/proc/stat").read_text().split("\n", 1)[0].split()
    except OSError:
        return None
    if len(parts) < 5 or parts[0] != "cpu":
        return None
    v = [int(x) for x in parts[1:]]
    # user nice system idle iowait irq softirq steal guest guest_nice
    idle = (v[3] + v[4]) / HZ
    busy = (sum(v[:8]) / HZ) - idle
    return {"busy_s": round(busy, 2), "idle_s": round(idle, 2),
            "cores": psutil.cpu_count(logical=True) or 0,
            "at": datetime.now(timezone.utc).isoformat(),
            "rapl_uj": rapl_uj()}


def _watts_gpu() -> float:
    global _WATTS_GPU
    if _WATTS_GPU is None:
        _WATTS_GPU = _gpu_watts() or 0.0
    return _WATTS_GPU


def energy(core_s: float, measured_wh: float | None = None,
           gpu_s: float = 0.0) -> dict:
    """Watt-hours for a number of busy core-seconds, and GPU-seconds.

    The GPU's rate is the card's own power limit: nvidia-smi reports no
    live draw here, so what is left is an upper bound on what it was
    pulling while it was busy. An upper bound that says so beats a middle
    figure that was invented.
    """
    if measured_wh is not None:
        wh, basis = measured_wh, "measured"
    else:
        wh = core_s * WATTS_PER_CORE / 3600.0
        if gpu_s and _watts_gpu():
            wh += gpu_s * _watts_gpu() / 3600.0
        basis = WATTS_BASIS
    out = {"wh": round(wh, 4), "basis": basis,
           "watts_per_core": WATTS_PER_CORE if measured_wh is None else None,
           "watts_gpu": (_watts_gpu() or None) if measured_wh is None else None}
    if KWH_PRICE:
        out["cost_usd"] = round(wh / 1000.0 * KWH_PRICE, 6)
        out["kwh_price"] = KWH_PRICE
    else:
        out["cost_usd"] = None
    return out


# The card's rated draw. nvidia-smi reports power.draw as N/A on this card,
# so the limit is what there is: an upper bound on what it was pulling
# while it was busy, which is honest as long as it says so.
def _gpu_watts() -> float | None:
    told = os.environ.get("X3_WATTS_GPU")
    if told:
        return float(told)
    out = _nvidia("--query-gpu=power.limit", "--format=csv,noheader,nounits")
    try:
        return float(out.splitlines()[0])
    except (AttributeError, IndexError, ValueError):
        return None


def _nvidia(*args: str) -> str | None:
    if not shutil.which("nvidia-smi"):
        return None
    try:
        r = subprocess.run(["nvidia-smi", *args], capture_output=True,
                           text=True, timeout=6)
        return r.stdout if r.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


class GpuMeter:
    """GPU time for a set of processes, from nvidia-smi's own sampler.

    A render is drawn by the GPU, so counting only its CPU said a
    fifteen-second render cost seven core-seconds and left the expensive
    half out. `nvidia-smi pmon` prints one line per process per second
    with the share of the GPU each had; summing our own processes' share
    over the seconds they ran gives GPU-seconds, counted the same way
    core-seconds are.

    It runs as its own long-lived sampler rather than one call per tick:
    a `pmon -c 1` takes a second to produce its sample, so polling it
    would have seen half the timeline at best.
    """

    def __init__(self, pids: set[int]) -> None:
        import threading

        self.pids = pids                  # updated by the process sampler
        self.gpu_s = 0.0
        self.samples = 0
        self.proc = None
        if not shutil.which("nvidia-smi"):
            return
        try:
            self.proc = subprocess.Popen(
                ["nvidia-smi", "pmon", "-d", "1", "-c", "100000"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        except OSError:
            return
        self._thread = threading.Thread(target=self._read, daemon=True)
        self._thread.start()

    def _read(self) -> None:
        for line in self.proc.stdout:            # one line per process-second
            if line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) < 4:
                continue
            try:
                pid, sm = int(parts[1]), parts[3]
            except ValueError:
                continue
            if pid not in self.pids or not sm.isdigit():
                continue
            self.gpu_s += int(sm) / 100.0        # -d 1: one second a sample
            self.samples += 1

    def stop(self) -> dict:
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.SubprocessError:
                self.proc.kill()
        return {"gpu_s": round(self.gpu_s, 2)} if self.proc else {}


class Meter:
    """CPU, memory and disk for one child process tree.

    Start it before spawning, hand it the pid, stop it once the process has
    been waited for - the rusage delta is only complete after the child has
    been reaped.
    """

    def __init__(self) -> None:
        self.t0 = time.monotonic()
        self.r0 = resource.getrusage(resource.RUSAGE_CHILDREN)
        self.peak_rss = 0
        self.samples = 0
        self._task: asyncio.Task | None = None

    def watch(self, pid: int, every: float = 1.0) -> None:
        self._task = asyncio.create_task(self._sample(pid, every))

    async def _sample(self, pid: int, every: float) -> None:
        try:
            root = psutil.Process(pid)
        except psutil.Error:
            return
        while True:
            try:
                rss = 0
                for p in (root, *root.children(recursive=True)):
                    try:
                        rss += p.memory_info().rss
                    except psutil.Error:      # exited between the two calls
                        pass
                self.peak_rss = max(self.peak_rss, rss)
                self.samples += 1
            except psutil.Error:
                return
            await asyncio.sleep(every)

    def stop(self) -> dict:
        if self._task:
            self._task.cancel()
            self._task = None
        r1 = resource.getrusage(resource.RUSAGE_CHILDREN)
        cpu = ((r1.ru_utime - self.r0.ru_utime) +
               (r1.ru_stime - self.r0.ru_stime))
        wall = time.monotonic() - self.t0
        return {
            "wall_s": round(wall, 2),
            "cpu_s": round(max(cpu, 0.0), 2),
            # How many cores it managed to keep busy: 1.0 is a single-threaded
            # build, and OpenCascade's booleans are single-threaded.
            "cores_used": round(cpu / wall, 2) if wall > 0.1 else None,
            "peak_rss_mb": round(self.peak_rss / 2 ** 20, 1) or None,
            "read_mb": round((r1.ru_inblock - self.r0.ru_inblock) * 512
                             / 2 ** 20, 1),
            "write_mb": round((r1.ru_oublock - self.r0.ru_oublock) * 512
                              / 2 ** 20, 1),
        }


class ProcMeter:
    """CPU and memory for a process tree that cannot be waited for.

    Polls in a thread, so it works in a command-line tool with no event
    loop. The highest reading for each process is kept rather than the last:
    a browser tab that exits half way through the render would otherwise
    take its time with it. Each process is counted only by its own clock -
    the parent's ``children_user`` would count an exited child twice.
    """

    def __init__(self, pid: int, every: float = 0.5) -> None:
        import threading

        self.pid = pid
        self.every = every
        self.cpu: dict[int, float] = {}
        self.peak_rss = 0
        # Shared with the GPU sampler, which has only a pid to go on and
        # no way of telling our browser from anybody else's.
        self.pids: set[int] = {pid}
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        self.gpu = GpuMeter(self.pids)

    def _scan(self) -> None:
        try:
            root = psutil.Process(self.pid)
            tree = [root, *root.children(recursive=True)]
        except psutil.Error:
            return
        rss = 0
        for p in tree:
            try:
                t = p.cpu_times()
                self.cpu[p.pid] = max(self.cpu.get(p.pid, 0.0),
                                      t.user + t.system)
                rss += p.memory_info().rss
                self.pids.add(p.pid)
            except psutil.Error:             # exited between the two calls
                pass
        self.peak_rss = max(self.peak_rss, rss)

    def _run(self) -> None:
        while not self._stop.wait(self.every):
            self._scan()

    def stop(self) -> dict:
        self._scan()          # one last reading, before anything is told to go
        self._stop.set()
        return {"cpu_s": round(sum(self.cpu.values()), 2),
                "peak_rss_mb": round(self.peak_rss / 2 ** 20, 1) or None,
                "procs": len(self.cpu),
                **self.gpu.stop()}


def whole_process(t0: float, plus: dict | None = None) -> dict:
    """CPU for a command-line tool that exists only to do this one job.

    Its own time and every child it waited for. `plus` carries what a meter
    watched separately - a browser that was killed rather than reaped, whose
    time is in nobody's rusage.
    """
    a = resource.getrusage(resource.RUSAGE_SELF)
    b = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu = a.ru_utime + a.ru_stime + b.ru_utime + b.ru_stime
    cpu += (plus or {}).get("cpu_s") or 0.0
    gpu = (plus or {}).get("gpu_s")
    wall = time.monotonic() - t0
    # rusage keeps the largest single process; the meter sums a whole tree.
    rss_mb = max(max(a.ru_maxrss, b.ru_maxrss) / 1024,
                 (plus or {}).get("peak_rss_mb") or 0.0)
    out = {
        "wall_s": round(wall, 2),
        "cpu_s": round(cpu, 2),
        "cores_used": round(cpu / wall, 2) if wall > 0.1 else None,
        "peak_rss_mb": round(rss_mb, 1) or None,
        "read_mb": round((a.ru_inblock + b.ru_inblock) * 512 / 2 ** 20, 1),
        "write_mb": round((a.ru_oublock + b.ru_oublock) * 512 / 2 ** 20, 1),
    }
    # Absent rather than zero where there is no card to ask: a render on a
    # machine without one did not use no GPU, we just cannot say.
    if gpu is not None:
        out["gpu_s"] = gpu
    return out


def record_sync(root, kind: str, **row) -> None:
    """Log a job from a command-line tool, which has no event loop or db.

    Best effort throughout: a render that cannot reach the database has
    still produced its picture, and saying so is not worth failing over.
    """
    try:
        import os as _os

        from dotenv import load_dotenv
        from motor.motor_asyncio import AsyncIOMotorClient

        load_dotenv(Path(root) / ".env")
        uri = _os.getenv("MONGODB_URI", "").strip()
        if not uri:
            return

        async def go():
            db = AsyncIOMotorClient(uri)[_os.getenv("MONGODB_DB", "assets_3d")]
            await record(db, kind, await current_revision(db), **row)

        asyncio.run(go())
    except Exception:                                # noqa: BLE001
        pass


async def record(db, kind: str, revision: str | None = None, **row) -> dict:
    """Log one job. `kind` is build or render."""
    doc = {"kind": kind, "revision": revision,
           "at": datetime.now(timezone.utc).isoformat(), **row}
    res = await db[JOBS].insert_one(doc)
    doc["_id"] = res.inserted_id
    return doc


# One run per room. The 3D room's is "current", as it always was; the others
# have their own, because a tab's agent works in parallel with the others
# and a single shared run let one agent's `finish` close another's.
ROOMS = ("cad", "pcb", "web", "embedded", "mobile")


def run_key(room: str | None) -> str:
    return "current" if room in (None, "", "cad") else f"current:{room}"


def room_of(kind: str | None) -> str:
    """The room a revision of this kind is worked in."""
    return kind if kind in ROOMS else "cad"


async def current_revision(db, room: str | None = None) -> str | None:
    """The revision being worked on, so a build can be filed under it.

    The environment wins: the "after" picture is taken once the run has been
    closed, so there is no current run to read, and the only thing that knows
    which revision that render belongs to is the command that started it.
    """
    told = os.environ.get("X3_REVISION")
    if told:
        return told
    run = await db.runs.find_one({"_id": run_key(room)})
    if run and run.get("status") == "running":
        return run.get("revision")
    return None


def summarise(jobs: list[dict], run: dict | None) -> dict:
    """Roll up the jobs of one revision, plus the machine's own window."""
    tot = {"jobs": 0, "wall_s": 0.0, "cpu_s": 0.0, "gpu_s": 0.0,
           "read_mb": 0.0, "write_mb": 0.0}
    peak = 0.0
    kinds: dict[str, dict] = {}
    for j in jobs:
        tot["jobs"] += 1
        for k in ("wall_s", "cpu_s", "gpu_s", "read_mb", "write_mb"):
            tot[k] += j.get(k) or 0.0
        peak = max(peak, j.get("peak_rss_mb") or 0.0)
        k = kinds.setdefault(j.get("kind") or "build",
                             {"jobs": 0, "wall_s": 0.0, "cpu_s": 0.0,
                              "gpu_s": 0.0, "peak_rss_mb": 0.0})
        k["jobs"] += 1
        k["wall_s"] += j.get("wall_s") or 0.0
        k["cpu_s"] += j.get("cpu_s") or 0.0
        k["gpu_s"] += j.get("gpu_s") or 0.0
        k["peak_rss_mb"] = max(k["peak_rss_mb"], j.get("peak_rss_mb") or 0.0)

    out = {
        "totals": {**{k: round(v, 2) for k, v in tot.items()},
                   "core_min": round(tot["cpu_s"] / 60, 2),
                   "peak_rss_mb": round(peak, 1) or None},
        "energy": energy(tot["cpu_s"], gpu_s=tot["gpu_s"]),
        "kinds": [{"kind": k, **{n: round(v, 2) for n, v in d.items()}}
                  for k, d in sorted(kinds.items(),
                                     key=lambda kv: -kv[1]["cpu_s"])],
        "machine": None,
    }

    # The whole machine over the same window. Ours is a part of this, not a
    # separate bill - the agent's own editor and browser are in here too,
    # which is why it is kept apart from the figures above.
    a, b = (run or {}).get("cpu_start"), (run or {}).get("cpu_end")
    # Still going: read the counter now, so the live card's machine figure
    # grows with the work instead of appearing only at the end. Never for a
    # run that is already over - reading it now would count every hour since.
    if a and not b and (run or {}).get("status") == "running":
        b = machine_cpu()
    if a and b and b.get("busy_s") is not None:
        busy = round(b["busy_s"] - a["busy_s"], 1)
        window = round(b["idle_s"] + b["busy_s"] - a["idle_s"] - a["busy_s"], 1)
        cores = b.get("cores") or a.get("cores") or 0
        wh = None
        if a.get("rapl_uj") and b.get("rapl_uj") and b["rapl_uj"] > a["rapl_uj"]:
            wh = (b["rapl_uj"] - a["rapl_uj"]) / 1e6 / 3600.0
        out["machine"] = {
            "busy_core_s": busy,
            "busy_core_min": round(busy / 60, 2),
            "cores": cores,
            # Averaged over the window: 1.0 means one core was busy the whole
            # time, not that the machine was at 100%.
            "avg_cores_busy": round(busy / (window / cores), 2)
            if cores and window else None,
            "ours_pct": round(tot["cpu_s"] / busy * 100, 1) if busy else None,
            "energy": energy(busy, wh),
        }
    return out


async def for_revision(db, rid: str, started: str | None,
                       finished: str | None, run: dict | None = None) -> dict:
    """Every job that belongs to one revision.

    Filed the same way the LLM calls are: by the run's window, or by the
    revision id written on the row when the job knew which revision it was
    for.
    """
    query: dict = {"revision": rid}
    if started:
        window = {"at": {"$gte": started}}
        if finished:
            window["at"]["$lte"] = finished
        query = {"$or": [window, {"revision": rid}]}
    rows = [r async for r in db[JOBS].find(query)]
    rows = list({str(r["_id"]): r for r in rows}.values())
    return summarise(rows, run)
