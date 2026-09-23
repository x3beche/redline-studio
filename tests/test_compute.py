"""The machine's half of the bill.

The trap here is the opposite of the token one. Tokens get over-counted by
counting lines instead of requests; CPU gets over-counted by claiming the
whole machine's busy time as the revision's own. The two figures are kept
apart, and an estimate is never allowed to look like a reading.
"""

import asyncio
import resource
import sys
import time

import pytest

from backend import compute


def job(kind="build", cpu=60.0, wall=90.0, rss=1024.0, rev=None):
    return {"_id": f"{kind}-{cpu}-{wall}", "kind": kind, "cpu_s": cpu,
            "wall_s": wall, "peak_rss_mb": rss, "read_mb": 1.0,
            "write_mb": 2.0, "revision": rev}


# ---------------- what was measured ----------------
def test_machine_counter_is_a_real_reading():
    a = compute.machine_cpu()
    assert a and a["busy_s"] > 0 and a["idle_s"] > 0
    # Monotonic: it is a counter since boot, not a sample.
    time.sleep(0.05)
    b = compute.machine_cpu()
    assert b["busy_s"] >= a["busy_s"]
    assert b["idle_s"] >= a["idle_s"]


def test_meter_reports_the_cpu_a_child_actually_burned():
    """The number that the whole panel rests on: a busy child is counted."""
    burn = ("import time\n"
            "t = time.time()\n"
            "while time.time() - t < 0.6: pass\n")

    async def go():
        meter = compute.Meter()
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-c", burn,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL)
        meter.watch(proc.pid, every=0.05)
        await proc.communicate()
        return meter.stop()

    got = asyncio.run(go())
    assert 0.4 <= got["cpu_s"] <= 1.2, got
    assert got["wall_s"] >= 0.5
    # One thread, so about one core.
    assert 0.7 <= got["cores_used"] <= 1.3, got
    # Sampled while it lived, so a python process' worth of memory.
    assert got["peak_rss_mb"] and got["peak_rss_mb"] > 3


def test_an_idle_child_is_not_charged_for_the_wall_clock():
    async def go():
        meter = compute.Meter()
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-c", "import time; time.sleep(0.5)",
            stdout=asyncio.subprocess.DEVNULL)
        meter.watch(proc.pid, every=0.05)
        await proc.communicate()
        return meter.stop()

    got = asyncio.run(go())
    assert got["wall_s"] >= 0.5
    assert got["cpu_s"] < 0.25, got          # slept, did not compute
    assert got["cores_used"] < 0.4


def test_whole_process_counts_this_process_and_its_children():
    t0 = time.monotonic() - 1.0
    got = compute.whole_process(t0)
    r = resource.getrusage(resource.RUSAGE_SELF)
    assert got["cpu_s"] >= r.ru_utime + r.ru_stime - 0.01
    assert got["wall_s"] >= 1.0


# ---------------- what was estimated ----------------
def test_energy_says_it_is_assumed_and_shows_its_rate():
    e = compute.energy(3600.0)               # one core-hour
    assert e["basis"] == "assumed"
    assert e["watts_per_core"] == compute.WATTS_PER_CORE
    assert e["wh"] == pytest.approx(compute.WATTS_PER_CORE, abs=0.01)


def test_a_measured_reading_is_never_relabelled_as_an_estimate():
    e = compute.energy(3600.0, measured_wh=12.5)
    assert e["basis"] == "measured"
    assert e["wh"] == 12.5
    # No rate is quoted for a reading: nothing was assumed.
    assert e["watts_per_core"] is None


def test_no_electricity_price_means_no_money_rather_than_a_made_up_one(monkeypatch):
    monkeypatch.setattr(compute, "KWH_PRICE", None)
    assert compute.energy(3600.0)["cost_usd"] is None
    monkeypatch.setattr(compute, "KWH_PRICE", 0.20)
    got = compute.energy(3600.0)
    assert got["cost_usd"] == pytest.approx(compute.WATTS_PER_CORE / 1000 * 0.20,
                                            rel=1e-3)


# ---------------- the roll-up ----------------
def test_jobs_add_up_and_peak_memory_is_a_maximum_not_a_sum():
    got = compute.summarise([job(cpu=60, rss=1000), job(cpu=30, rss=1800)], None)
    t = got["totals"]
    assert t["jobs"] == 2
    assert t["cpu_s"] == 90.0
    assert t["core_min"] == 1.5
    # Two builds that each peaked at 1.8 GB never needed 2.8 GB at once.
    assert t["peak_rss_mb"] == 1800.0


def test_kinds_are_split_so_a_render_is_not_read_as_a_build():
    got = compute.summarise([job("build", cpu=120), job("render", cpu=20)], None)
    kinds = {k["kind"]: k for k in got["kinds"]}
    assert kinds["build"]["cpu_s"] == 120.0
    assert kinds["render"]["cpu_s"] == 20.0
    # Heaviest first, so the card leads with what dominated.
    assert got["kinds"][0]["kind"] == "build"


def test_the_machine_window_is_kept_apart_from_our_own_jobs():
    """The whole box's busy time is not this revision's bill."""
    run = {"cpu_start": {"busy_s": 1000.0, "idle_s": 9000.0, "cores": 20},
           "cpu_end": {"busy_s": 1600.0, "idle_s": 18400.0, "cores": 20}}
    got = compute.summarise([job(cpu=300.0)], run)
    assert got["totals"]["cpu_s"] == 300.0       # ours
    m = got["machine"]
    assert m["busy_core_s"] == 600.0             # everything, ours included
    assert m["ours_pct"] == 50.0
    # 10000 core-seconds over 20 cores is a 500 s window, 600 busy in it.
    assert m["avg_cores_busy"] == pytest.approx(1.2, abs=0.01)
    assert m["energy"]["basis"] == "assumed"


def test_a_readable_rapl_counter_makes_the_window_energy_measured():
    run = {"cpu_start": {"busy_s": 100.0, "idle_s": 900.0, "cores": 8,
                         "rapl_uj": 1_000_000_000},
           "cpu_end": {"busy_s": 200.0, "idle_s": 1700.0, "cores": 8,
                       "rapl_uj": 1_360_000_000}}
    m = compute.summarise([], run)["machine"]
    assert m["energy"]["basis"] == "measured"
    assert m["energy"]["wh"] == pytest.approx(0.1, abs=1e-6)   # 360 J


def test_a_run_with_no_counters_reports_nothing_rather_than_zero():
    """Revisions applied before this existed must not claim 0 Wh."""
    assert compute.summarise([job()], {})["machine"] is None
    assert compute.summarise([job()], None)["machine"] is None


def test_a_finished_run_missing_its_end_counter_is_not_charged_for_today():
    """Reading the counter now would count every hour since it ended."""
    run = {"status": "done", "cpu_start": {"busy_s": 1.0, "idle_s": 1.0,
                                           "cores": 8}}
    assert compute.summarise([job()], run)["machine"] is None


def test_a_running_revision_gets_a_live_machine_figure():
    run = {"status": "running", "cpu_start": compute.machine_cpu()}
    m = compute.summarise([job()], run)["machine"]
    assert m is not None and m["busy_core_s"] >= 0.0


def test_a_tree_that_is_killed_rather_than_reaped_is_still_counted():
    """The render bug: chrome is terminated, so rusage never sees its time.

    A 92-second render was filed as 0.11 core-seconds before this existed.
    """
    import subprocess

    burn = ("import subprocess, sys, time\n"
            "kid = subprocess.Popen([sys.executable, '-c',\n"
            "  'import time\\nt=time.time()\\nwhile time.time()-t < 2: pass'])\n"
            "time.sleep(2)\n")
    proc = subprocess.Popen([sys.executable, "-c", burn])
    meter = compute.ProcMeter(proc.pid, every=0.1)
    time.sleep(1.2)
    got = meter.stop()
    proc.kill()                              # killed, never waited for
    proc.wait()

    # The grandchild is the one burning: a tree walk finds it, rusage does not.
    assert got["procs"] >= 2, got
    assert got["cpu_s"] >= 0.7, got
    assert got["peak_rss_mb"] and got["peak_rss_mb"] > 6


def test_what_a_meter_watched_separately_is_added_to_the_job():
    t0 = time.monotonic() - 10.0
    alone = compute.whole_process(t0)
    both = compute.whole_process(t0, {"cpu_s": 40.0, "peak_rss_mb": 8000.0})
    assert both["cpu_s"] == pytest.approx(alone["cpu_s"] + 40.0, abs=0.05)
    assert both["peak_rss_mb"] == 8000.0     # the tree, not the biggest child
    assert both["cores_used"] == pytest.approx(both["cpu_s"] / 10.0, abs=0.05)


# ---------------- the GPU ----------------
def test_gpu_seconds_add_up_and_reach_the_energy():
    """A render is drawn by the card; counting only its CPU left the
    expensive half out."""
    rows = [job("render", cpu=20.0), dict(job("render", cpu=4.0),
                                          _id="r2", gpu_s=6.0)]
    rows[0]["gpu_s"] = 4.0
    got = compute.summarise(rows, None)
    assert got["totals"]["gpu_s"] == 10.0
    assert got["kinds"][0]["gpu_s"] == 10.0
    # and the energy is the two rates, not one
    cpu_only = compute.energy(24.0)["wh"]
    both = compute.energy(24.0, gpu_s=10.0)["wh"]
    assert both > cpu_only


def test_a_job_with_no_gpu_figure_is_counted_as_none_not_as_zero_energy():
    got = compute.summarise([job("build", cpu=60.0)], None)
    assert got["totals"]["gpu_s"] == 0.0
    assert got["energy"]["wh"] == pytest.approx(
        compute.energy(60.0)["wh"], rel=1e-9)


def test_the_gpu_rate_is_named_so_the_figure_can_be_argued_with():
    e = compute.energy(10.0, gpu_s=10.0)
    assert e["basis"] == "assumed"
    if e["watts_gpu"]:
        assert e["wh"] > compute.energy(10.0)["wh"]


def test_a_machine_with_no_card_reports_no_gpu_time_rather_than_zero():
    """`stop` returns an empty dict there, so the key never appears and
    nothing claims the render used none."""
    meter = compute.GpuMeter(set())
    meter.proc = None
    assert meter.stop() == {}
