"""Firmware builds: PlatformIO in a container, as a job of its own.

Like a model build (backend/buildjobs.py) a firmware build is a process of
its own (`python -m backend.fwbuild <job>`, its own session), so a reload
of the API does not cut it. The API writes the job down in
`firmware_jobs` (the machine's collection; each job holds its workspace),
starts the runner and answers at once. The runner says it is alive every
BEAT seconds, writes the compiler's lines into the job as they come (the
room's log band reads them), and at the end the result: ok or not, the
errors and warnings as file:line, flash and RAM used, and firmware.bin and
firmware.elf in GridFS (`firmware_builds`).

The container (docker/firmware, image `redline-firmware`):

    docker run --rm --network none <limits.box()> --user <uid>
        -v <project>:/project -w /project redline-firmware pio run -e <env>

The project is written to `.cache/firmware/<space>/<id>/` in the checkout
(the API container sees the checkout at the host's path, so the host's
Docker can mount it) and kept there with its `.pio`: the next build only
compiles what changed. Only files whose text changed are rewritten, so
their times stay put. Libraries come from the image's pool (/opt/libpool):
on the first build of a firmware, and whenever its platformio.ini changes,
`pio pkg install` runs offline against what the pool put in .pio/libdeps;
only if that fails (a library the image does not have) does it run once
more with the network on - for that step alone; the compile never has it.

One build per firmware at a time: a second is refused (409).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import socket
import subprocess
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

from . import firmware, jobs, limits, store
from .jobs import BEAT, alive, now  # one clock for every kind of job

JOBS = "firmware_jobs"
IMAGE = os.environ.get("REDLINE_FIRMWARE_IMAGE", "redline-firmware")
ROOT = jobs.ROOT
CACHE = ROOT / ".cache" / "firmware"
LOGS = jobs.LOGS
TIMEOUT = float(os.environ.get("REDLINE_FIRMWARE_TIMEOUT", "900"))
MAX_LINES = 4000
FLUSH = 0.7


class Busy(RuntimeError):
    def __init__(self, job: dict):
        self.job = job
        super().__init__(f"{job.get('firmware')}: a build is already running (job {job.get('_id')})")


# ---------------------------------------------------------------- reading PlatformIO

_DIAG = re.compile(r"^(?P<file>[^\s:][^:]*?):(?P<line>\d+):(?:(?P<col>\d+):)?\s*"
                   r"(?P<sev>fatal error|error|warning|note):\s*(?P<text>.*)$")
_SIZE = re.compile(r"^(?P<what>RAM|Flash):\s*\[[^\]]*\]\s*(?P<pct>[\d.]+)%\s*\(used (?P<used>\d+) bytes "
                   r"from (?P<total>\d+) bytes\)")
_LINK = re.compile(r"(?:undefined reference to|multiple definition of|region `[^']+' overflowed)")


def level_of(line: str) -> str:
    """How the room's log colours one line of PlatformIO's output."""
    low = line.lower()
    if "[success]" in low:
        return "done"
    if "[failed]" in low or ": error:" in low or ": fatal error:" in low or "*** [" in line \
            or _LINK.search(line):
        return "error"
    if ": warning:" in low:
        return "warn"
    if line.startswith(("Compiling", "Linking", "Building", "Archiving", "Indexing")):
        return "work"
    return "info"


def parse(text: str) -> dict:
    """PlatformIO's output, as what the Status tab shows: errors and
    warnings (file, line, column, message; each once), flash and RAM."""
    errors, warnings, seen = [], [], set()
    sizes: dict[str, dict] = {}
    ok = None
    for raw in (text or "").splitlines():
        line = raw.rstrip()
        m = _DIAG.match(line)
        if m and m.group("sev") != "note":
            item = {"file": m.group("file"), "line": int(m.group("line")),
                    "col": int(m.group("col")) if m.group("col") else None, "text": m.group("text").strip()}
            key = (item["file"], item["line"], item["col"], item["text"], m.group("sev"))
            if key in seen:
                continue
            seen.add(key)
            (warnings if m.group("sev") == "warning" else errors).append(item)
            continue
        if _LINK.search(line) and not m:
            key = ("link", line.strip())
            if key not in seen:
                seen.add(key)
                fm = re.match(r"^(?P<file>[^:]+):(?:\(.*?\)|\d+)?:?\s*(?P<text>.*)$", line.strip())
                errors.append({"file": fm.group("file") if fm else "", "line": None, "col": None,
                               "text": (fm.group("text") if fm else line).strip()})
            continue
        s = _SIZE.match(line.strip())
        if s:
            sizes[s.group("what").lower()] = {"used": int(s.group("used")), "total": int(s.group("total")),
                                               "pct": float(s.group("pct"))}
            continue
        if "[SUCCESS]" in line:
            ok = True
        elif "[FAILED]" in line or "[ERROR]" in line:
            ok = False
    if ok is None:
        ok = not errors and bool(sizes)
    return {"ok": bool(ok) and not errors, "errors": errors[:200], "warnings": warnings[:200],
            "error_count": len(errors), "warning_count": len(warnings),
            "flash": sizes.get("flash"), "ram": sizes.get("ram")}


# ---------------------------------------------------------------- the jobs

def view(job: dict, lines: bool = False) -> dict:
    out = {"job": job["_id"], "kind": "firmware", "firmware": job.get("firmware"),
           "title": job.get("title"), "status": job.get("status"), "why": job.get("why"),
           "version": job.get("version"), "started_at": job.get("started_at"),
           "finished_at": job.get("finished_at"), "seconds": job.get("seconds"),
           "result": job.get("result"), "detail": job.get("detail")}
    if lines:
        out["lines"] = job.get("lines") or []
    return out


def runner_argv(job_id: str) -> list[str]:
    return [sys.executable, "-m", "backend.fwbuild", job_id]


def _popen(job_id: str) -> int:
    LOGS.mkdir(parents=True, exist_ok=True)
    with open(LOGS / f"firmware-{job_id}.log", "ab") as log:
        proc = subprocess.Popen(runner_argv(job_id), cwd=str(ROOT), stdin=subprocess.DEVNULL,
                                stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                env=os.environ.copy())
    threading.Thread(target=proc.wait, daemon=True).start()
    return proc.pid


async def spawn(raw, job_id: str) -> int:
    """Start the runner. Its own function so a test can stand in."""
    return await asyncio.to_thread(_popen, job_id)


async def _lose(raw, job: dict, why: str) -> dict:
    patch = {"status": "lost", "finished_at": now(), "detail": why}
    await raw[JOBS].update_one({"_id": job["_id"], "status": "running"}, {"$set": patch})
    from . import scope
    fws = scope.ScopedDb(raw, job.get("workspace") or scope.DEFAULT)[firmware.COLL]
    fw = await fws.find_one({"_id": job.get("firmware")})
    if fw and (fw.get("build") or {}).get("job") == job["_id"]:
        await fws.update_one({"_id": fw["_id"]}, {"$set": {"build": {
            **fw["build"], "state": "lost", "at": store.now(), "detail": why}}})
    return {**job, **patch}


GONE = "its runner stopped answering (the API container restarted?)"


async def start(db, fid: str, *, by: dict | None = None, why: str | None = None) -> dict:
    """Write the build down and start its runner. `db` is the workspace's
    view; the job goes in the machine's collection with the workspace on it."""
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    ws = getattr(db, "workspace", None) or "default"
    fw = await firmware.get(db, fid)
    old = await raw[JOBS].find_one({"firmware": fid, "workspace": ws, "status": "running"})
    if old:
        if alive(old):
            raise Busy(old)
        await _lose(raw, old, GONE)
    t = now()
    job = {"_id": uuid.uuid4().hex[:16], "kind": "firmware", "firmware": fid, "workspace": ws,
           "title": fw.get("title"), "board": fw.get("board"), "env": fw.get("env"),
           "version": fw.get("version") or 0, "by": by, "why": why, "status": "running",
           "started_at": t, "beat": t, "host": socket.gethostname(), "lines": []}
    await raw[JOBS].insert_one(job)
    # The last build's figures stay on screen while this one runs.
    prev = fw.get("build") or {}
    await db[firmware.COLL].update_one({"_id": fid}, {"$set": {"build": {
        **prev, "state": "running", "job": job["_id"], "started_at": store.now(), "why": why,
        "last": prev.get("state") if prev.get("state") != "running" else prev.get("last")}}})
    try:
        pid = await spawn(raw, job["_id"])
    except OSError as exc:
        await raw[JOBS].update_one({"_id": job["_id"]}, {"$set": {
            "status": "failed", "finished_at": now(), "detail": f"the build could not be started: {exc}"}})
        await db[firmware.COLL].update_one({"_id": fid}, {"$set": {"build": {**prev, "state": "failed"}}})
        raise
    await raw[JOBS].update_one({"_id": job["_id"]}, {"$set": {"pid": pid}})
    return {**job, "pid": pid}


async def get(raw, job_id: str) -> dict | None:
    doc = await raw[JOBS].find_one({"_id": job_id})
    if doc and doc.get("status") == "running" and not alive(doc):
        doc = await _lose(raw, doc, GONE)
    return doc


async def latest(raw, fid: str, ws: str, limit: int = 10) -> list[dict]:
    rows = [d async for d in raw[JOBS].find({"firmware": fid, "workspace": ws})
            .sort("started_at", -1).limit(limit)]
    return [view(d) for d in rows]


async def running(raw) -> list[dict]:
    return [d async for d in raw[JOBS].find({"status": "running"})]


# ---------------------------------------------------------------- the runner

def project_dir(ws: str, fid: str) -> Path:
    return CACHE / re.sub(r"[^A-Za-z0-9_.-]", "_", ws) / re.sub(r"[^A-Za-z0-9_.-]", "_", fid)


def write_project(where: Path, files: dict[str, str]) -> list[str]:
    """The firmware's files on disk, as they are in the database: what
    changed is written, what is gone is removed; .pio is left alone."""
    where.mkdir(parents=True, exist_ok=True)
    changed = []
    for path, text in files.items():
        target = where / path
        target.parent.mkdir(parents=True, exist_ok=True)
        raw = text.encode()
        if not target.exists() or target.read_bytes() != raw:
            target.write_bytes(raw)
            changed.append(path)
    for p in sorted(where.rglob("*"), reverse=True):
        rel = p.relative_to(where).as_posix()
        if rel.startswith(".pio") or rel.startswith(".redline"):
            continue
        if p.is_file() and rel not in files:
            p.unlink()
            changed.append(rel)
        elif p.is_dir() and not any(p.iterdir()):
            p.rmdir()
    return changed


def docker_argv(where: Path, script: str, *, network: bool = False) -> list[str]:
    uid = f"{os.getuid()}:{os.getgid()}" if hasattr(os, "getuid") else "1000:1000"
    return ["docker", "run", "--rm", *limits.box(), *([] if network else ["--network", "none"]),
            "--user", uid, "-v", f"{where}:/project", "-w", "/project", IMAGE, "sh", "-c", script]


class Lines:
    """The compiler's lines, kept on the job and flushed every FLUSH s."""

    def __init__(self, raw, job_id: str):
        self.raw, self.job_id = raw, job_id
        self.rows: list[dict] = []
        self.text: list[str] = []
        self.last = 0.0
        self.n = 0

    async def add(self, text: str, level: str | None = None, force: bool = False) -> None:
        self.n += 1
        self.text.append(text)
        self.rows.append({"_id": f"{self.job_id}-{self.n}", "at": store.now(), "text": text[:2000],
                          "level": level or level_of(text)})
        if len(self.rows) > MAX_LINES:
            self.rows = self.rows[:50] + [{"_id": f"{self.job_id}-cut", "at": store.now(),
                                           "text": "… (earlier lines left out)", "level": "info"}] \
                + self.rows[-(MAX_LINES - 60):]
        if force or time.monotonic() - self.last > FLUSH:
            await self.flush()

    async def flush(self) -> None:
        self.last = time.monotonic()
        try:
            await self.raw[JOBS].update_one({"_id": self.job_id}, {"$set": {"lines": self.rows}})
        except Exception:                                        # noqa: BLE001 - next flush
            pass


async def _stream(argv: list[str], lines: Lines, timeout: float) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.STDOUT)
    out: list[str] = []

    async def pump():
        assert proc.stdout is not None
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            text = raw.decode(errors="replace").rstrip("\n")
            out.append(text)
            if text.strip():
                await lines.add(text)
        await proc.wait()

    try:
        await asyncio.wait_for(pump(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await lines.add(f"stopped: the build took longer than {int(timeout)} s", "error", force=True)
        return 124, "\n".join(out)
    return proc.returncode or 0, "\n".join(out)


async def image_ready() -> bool:
    try:
        proc = await asyncio.create_subprocess_exec("docker", "image", "inspect", IMAGE,
                                                    stdout=asyncio.subprocess.DEVNULL,
                                                    stderr=asyncio.subprocess.DEVNULL)
        return await asyncio.wait_for(proc.wait(), 30) == 0
    except (OSError, asyncio.TimeoutError):
        return False


def _ini_hash(files: dict[str, str]) -> str:
    return hashlib.sha256((files.get("platformio.ini") or "").encode()).hexdigest()[:16]


async def build(db, fw: dict, lines: Lines, *, run=_stream) -> dict:
    """Write the project out, fetch what it needs, compile it; the result."""
    ws = getattr(db, "workspace", None) or "default"
    if not await image_ready():
        raise RuntimeError(f"the firmware image is not built - on the host: "
                           f"docker build -t {IMAGE} docker/firmware")
    files = await firmware.contents(db, fw["_id"])
    env = fw.get("env") or "esp32dev"
    where = project_dir(ws, fw["_id"])
    changed = write_project(where, files)
    await lines.add(f"{fw.get('title')}: building v{fw.get('version')} for {fw.get('pio_board')} "
                    f"({fw.get('framework')}) - {len(changed)} file(s) changed since the last build", "work",
                    force=True)
    marker = where / ".pio" / ".redline-deps"
    want = _ini_hash(files)
    have = marker.read_text().strip() if marker.exists() else ""
    if have != want:
        pool = (f"mkdir -p .pio/libdeps/{env} && cp -rn /opt/libpool/. .pio/libdeps/{env}/ 2>/dev/null; "
                f"pio pkg install -e {env}")
        await lines.add("libraries: from the image's pool, offline", "work")
        rc, _ = await run(docker_argv(where, pool), lines, TIMEOUT)
        if rc != 0:
            await lines.add("libraries: not all in the image - fetching them, network on for this step only",
                            "warn")
            rc, _ = await run(docker_argv(where, f"pio pkg install -e {env}", network=True), lines, TIMEOUT)
        if rc == 0:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(want)
    t0 = time.monotonic()
    rc, text = await run(docker_argv(where, f"exec pio run -e {env}"), lines, TIMEOUT)
    got = parse(text)
    got["ok"] = got["ok"] and rc == 0
    got["rc"] = rc
    got["compile_seconds"] = round(time.monotonic() - t0, 1)
    got["changed"] = changed
    got["version"] = fw.get("version") or 0
    got["artifacts"] = {}
    if got["ok"]:
        for name in ("firmware.bin", "firmware.elf"):
            p = where / ".pio" / "build" / env / name
            if p.exists():
                data = p.read_bytes()
                gid = await store.bucket(db, firmware.BUCKET).upload_from_stream(
                    f"{fw['_id']}-v{got['version']}-{name}", data)
                got["artifacts"][name] = {"gridfs_id": str(gid), "bytes": len(data),
                                          "sha256": hashlib.sha256(data).hexdigest()}
    return got


async def _drop_old(db, fw: dict, keep: dict) -> None:
    """The previous build's files, once a newer one has its own."""
    old = ((fw.get("build") or {}).get("artifacts") or {})
    if not old or not keep:
        return
    from bson import ObjectId
    bucket = store.bucket(db, firmware.BUCKET)
    for meta in old.values():
        try:
            await bucket.delete(ObjectId(meta["gridfs_id"]))
        except Exception:                                        # noqa: BLE001 - gone already
            pass


async def _beat(raw, job_id: str) -> None:
    while True:
        await asyncio.sleep(BEAT)
        try:
            await raw[JOBS].update_one({"_id": job_id, "status": "running"}, {"$set": {"beat": now()}})
        except Exception:                                        # noqa: BLE001 - next beat
            pass


async def execute(db, raw, job: dict, *, run=_stream) -> dict:
    """The runner's work: the build, how it ended on the job, the result
    on the firmware."""
    beat = asyncio.create_task(_beat(raw, job["_id"]))
    lines = Lines(raw, job["_id"])
    t0 = time.monotonic()
    fw = None
    try:
        fw = await firmware.get(db, job["firmware"])
        got = await build(db, fw, lines, run=run)
        status = "done"
        tail = (f"built · flash {got['flash']['pct']}% ({got['flash']['used'] // 1024} KB) · "
                f"RAM {got['ram']['pct']}% · {got['warning_count']} warning(s)"
                if got["ok"] and got.get("flash") and got.get("ram") else
                f"build failed: {got['error_count']} error(s), {got['warning_count']} warning(s)")
        await lines.add(f"{fw.get('title')}: {tail}", "done" if got["ok"] else "error")
        patch = {"status": status, "result": {k: v for k, v in got.items() if k != "artifacts"} |
                 {"artifacts": {k: {"bytes": v["bytes"]} for k, v in got["artifacts"].items()}}}
    except Exception as exc:                                     # noqa: BLE001 - said, not lost
        got = None
        await lines.add(f"the build did not run: {type(exc).__name__}: {exc}"[:500], "error")
        patch = {"status": "failed", "detail": f"{type(exc).__name__}: {exc}"[:2000],
                 "trace": traceback.format_exc()[-4000:]}
    finally:
        beat.cancel()
    seconds = round(time.monotonic() - t0, 1)
    patch.update(finished_at=now(), seconds=seconds)
    await lines.flush()
    await raw[JOBS].update_one({"_id": job["_id"]}, {"$set": patch})
    if fw is not None:
        state = "ok" if got and got["ok"] else ("errors" if got else "failed")
        summary = {"state": state, "job": job["_id"], "at": store.now(), "seconds": seconds,
                   "version": (got or {}).get("version", job.get("version")), "why": job.get("why"),
                   "error_count": (got or {}).get("error_count", 0),
                   "warning_count": (got or {}).get("warning_count", 0),
                   "errors": (got or {}).get("errors", [])[:30],
                   "warnings": (got or {}).get("warnings", [])[:30],
                   "flash": (got or {}).get("flash"), "ram": (got or {}).get("ram"),
                   "detail": patch.get("detail")}
        if got and got["ok"] and got["artifacts"]:
            summary["artifacts"] = got["artifacts"]
            fresh = await firmware.get(db, fw["_id"])
            await _drop_old(db, fresh, got["artifacts"])
        else:
            # A failed build leaves the last good one's files downloadable.
            prev = ((await firmware.get(db, fw["_id"])).get("build") or {})
            if prev.get("artifacts"):
                summary["artifacts"] = prev["artifacts"]
                summary["artifacts_version"] = prev.get("artifacts_version", prev.get("version"))
        if summary.get("artifacts") and "artifacts_version" not in summary:
            summary["artifacts_version"] = summary["version"]
        await db[firmware.COLL].update_one({"_id": fw["_id"]}, {"$set": {"build": summary}})
        await _record(db, job, seconds, state)
    return {**job, **patch}


async def _record(db, job: dict, seconds: float, state: str) -> None:
    """Into the machine's job list, so Working now's "finished lately" and
    Analytics see firmware builds too (backend/compute.py)."""
    try:
        from . import compute
        await compute.record(db, "firmware", None, model=job.get("title"), board=job.get("board"),
                             firmware=job.get("firmware"), wall_s=seconds, rc=0 if state == "ok" else 1)
    except Exception:                                            # noqa: BLE001 - only a figure
        pass


async def run(raw, job_id: str) -> dict | None:
    from . import scope

    job = await raw[JOBS].find_one({"_id": job_id})
    if not job or job.get("status") != "running":
        return None
    ws = job.get("workspace") or scope.DEFAULT
    scope.WORKSPACE.set(ws)
    return await execute(scope.ScopedDb(raw, ws), raw, job)


async def _main(job_id: str) -> int:
    from . import main

    print(f"firmware build {job_id}: pid {os.getpid()}", flush=True)
    done = await run(main.db().raw, job_id)
    if done is None:
        print(f"firmware build {job_id}: not waiting to run", file=sys.stderr)
        return 1
    print(f"firmware build {job_id}: {done['status']} in {done.get('seconds')} s", flush=True)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("python -m backend.fwbuild <job id>")
    sys.exit(asyncio.run(_main(sys.argv[1])))
