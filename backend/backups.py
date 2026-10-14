"""Settings > Backups: the nightly MongoDB dumps, read from where they are.

    GET    /api/admin/backups                      the archives, the schedule, the log, the restore
                                                   checks, the disk, the secret key, the setup state
    POST   /api/admin/backups/check                run the restore check now (one at a time)
    GET    /api/admin/backups/check                the running (or last) check: its output so far
    GET    /api/admin/backups/archives/{name}      download an archive (the owner only)
    DELETE /api/admin/backups/archives/{name}      delete one (the owner only; never the newest nightly)

The dumps are the "mongodb" Portainer stack's mongo-backup service's: every
night at 03:30 it writes /backups/redline-<date>_<time>.archive.gz (the
host's ~/backups/mongodb), a line in backup.log, and deletes the nightly
archives older than KEEP_DAYS. docker/deploy/mongo-restore-check.sh restores
the newest into a throwaway mongod and compares it with the live database;
its result is a line in the same log and metrics/restore_check.prom.

The API does not mount that folder: it reads it through the docker socket it
already has, with `docker exec mongo-backup sh -c ...` - or straight from a
folder when BACKUP_DIR names one this process can read (and in the tests).
What the backup container is told comes from `docker inspect`, and of its
environment only KEEP_DAYS and TZ are ever read: the database password
stays where it is.

The middleware lets only the owner and the admins in ("users",
backend/access.py); downloading and deleting an archive is the owner's.
An archive written before the secret key was made holds the saved secrets
(API keys, the bot token...) in plaintext - the page says so on each one,
and a download says it again.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import subprocess
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from . import access, secretbox
from .admin import _audit, _me

router = APIRouter(prefix="/api/admin/backups")

ROOT = Path(__file__).resolve().parent.parent
CONTAINER = "mongo-backup"
INNER = "/backups"                                  # the folder, inside the backup container
SCRIPT = ROOT / "docker" / "deploy" / "mongo-restore-check.sh"
STACK = ROOT / "docker" / "deploy" / "mongo-backup.stack.yml"
RUNS = Path(os.environ.get("BACKUP_RUNS_DIR") or "/tmp/redline-backups")   # the restore checks run from here
NIGHTLY = re.compile(r"^redline-(\d{4}-\d\d-\d\d)_(\d{4})\.archive\.gz$")
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.archive\.gz$")
# What the stack runs when nothing can be read from the container.
DEFAULTS = {"at": "03:30", "keep_days": 7, "tz": "Europe/Istanbul"}
CHECK_LIMIT = 15 * 60                               # a check not done after this long has died, s
LOG_LINES = 400

# One shell run in the folder: everything the page needs, in sections.
SNAP = r"""
d=$1
echo '##files'
for f in "$d"/*.archive.gz "$d"/*.part; do [ -f "$f" ] && stat -c '%s %Y %n' "$f"; done
echo '##log'
tail -n LINES "$d/backup.log" 2>/dev/null
echo '##prom'
cat "$d/metrics/restore_check.prom" 2>/dev/null
echo '##df'
df -P -B1 "$d" 2>/dev/null | tail -n 1
echo '##du'
du -sb "$d" 2>/dev/null | cut -f1
echo '##now'
date +%s
""".replace("LINES", str(LOG_LINES))


# ------------------------------------------------------------ where it is


def _docker(*args: str, timeout: float = 30) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)


def local_dir() -> Path | None:
    """BACKUP_DIR, when this process can read it."""
    p = os.environ.get("BACKUP_DIR")
    return Path(p) if p and Path(p).is_dir() and os.access(p, os.R_OK | os.X_OK) else None


def inspect() -> dict | None:
    """The backup container as `docker inspect` has it, or None."""
    try:
        out = _docker("inspect", CONTAINER, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    rows = json.loads(out.stdout or "[]")
    return rows[0] if rows else None


def snapshot(info: dict | None) -> tuple[str | None, str | None, str]:
    """(SNAP's output, why not, where it was read)."""
    here = local_dir()
    if here:
        argv, where = ["sh", "-c", SNAP, "sh", str(here)], str(here)
    elif info and (info.get("State") or {}).get("Running"):
        argv, where = ["docker", "exec", CONTAINER, "sh", "-c", SNAP, "sh", INNER], f"{CONTAINER}:{INNER}"
    else:
        why = "the mongo-backup container is not running" if info else "the mongo-backup container is not on this machine"
        return None, why, ""
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, f"the backup folder could not be read: {exc}", where
    if "##now" not in out.stdout:
        return None, f"the backup folder could not be read: {(out.stderr or '').strip()[-200:] or 'no output'}", where
    return out.stdout, None, where


def sections(text: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    cur = None
    for line in text.splitlines():
        if line.startswith("##"):
            cur = line[2:].strip()
            out[cur] = []
        elif cur is not None and line.strip():
            out[cur].append(line)
    return out


# ------------------------------------------------------------ the container


def container(info: dict | None) -> dict:
    """The schedule and the setup, from the backup container's own record.
    Of its environment, KEEP_DAYS and TZ only."""
    if not info:
        return {"found": False, "running": False, "schedule": {**DEFAULTS, "weekly_check": None, "source": "default"},
                "host_dir": None, "wired": False, "script_mounted": False}
    st = info.get("State") or {}
    env = {}
    for e in (info.get("Config") or {}).get("Env") or []:
        k, _, v = e.partition("=")
        if k in ("KEEP_DAYS", "TZ"):
            env[k] = v
    cmd = "\n".join((info.get("Config") or {}).get("Cmd") or [])
    at = re.search(r'\$\(date \+%Y-%m-%d\) (\d\d?:\d\d)"', cmd)
    day = re.search(r'date \+%u\)"? = (\d)', cmd)
    mounts = info.get("Mounts") or []
    host_dir = next((m.get("Source") for m in mounts if m.get("Destination") == INNER), None)
    script_mounted = any(m.get("Destination") == "/restore-check.sh" for m in mounts)
    wired = script_mounted and "restore-check.sh" in cmd
    try:
        keep = int(env.get("KEEP_DAYS") or DEFAULTS["keep_days"])
    except ValueError:
        keep = DEFAULTS["keep_days"]
    return {
        "found": True, "running": bool(st.get("Running")), "status": st.get("Status"),
        "started_at": st.get("StartedAt"),
        "schedule": {"at": at.group(1) if at else DEFAULTS["at"], "keep_days": keep,
                     "tz": env.get("TZ") or DEFAULTS["tz"],
                     # ISO day of the week the restore check runs after the dump (7 = Sunday)
                     "weekly_check": int(day.group(1)) if (wired and day) else None,
                     "source": "container" if at else "default"},
        "host_dir": host_dir, "script_mounted": script_mounted, "wired": wired,
    }


def _tz(name: str):
    try:
        return ZoneInfo(name)
    except Exception:
        return timezone.utc


def next_run(now: float, at: str, tz) -> float:
    """The next time the clock in `tz` says `at`, after `now`."""
    h, m = (int(x) for x in at.split(":"))
    local = datetime.fromtimestamp(now, tz)
    t = local.replace(hour=h, minute=m, second=0, microsecond=0)
    if t.timestamp() <= now:
        t = (local + timedelta(days=1)).replace(hour=h, minute=m, second=0, microsecond=0)
    return t.timestamp()


def expires(mtime: float, keep_days: int, at: str, tz) -> float:
    """When the nightly prune takes a nightly archive: `find -mtime +KEEP`
    matches once it is KEEP+1 whole days old, and runs after each dump."""
    # (The dump that night ends about when this one did: a minute's slack.)
    return next_run(mtime + (keep_days + 1) * 86400 - 120, at, tz)


# ------------------------------------------------------------ the log


LOG_DUMP = re.compile(r"^(\S+) ok (\S+) (\S+)$")
LOG_FAIL = re.compile(r"^(\S+) FAILED$")
LOG_CHECK = re.compile(r"^(\S+) restore-check (ok|FAILED) (\S+) (.*?)(?: \((\d+)s\))?$")


def _ts(iso: str) -> float | None:
    try:
        return datetime.fromisoformat(iso).timestamp()
    except ValueError:
        return None


def check_details(msg: str) -> dict:
    """A restore check's message: its reasons (a failure's, before " | "),
    and what it compared - per collection restored/live, the secrets, the
    collections."""
    reasons: list[str] = []
    body = msg
    if " | " in msg:
        head, body = msg.split(" | ", 1)
        reasons = [r.strip() for r in head.split(";") if r.strip()]
    elif "=" not in msg:
        reasons, body = [msg.strip()], ""
    counts, secrets, extra = [], None, {}
    m = re.search(r"secrets enc1 dump=(\d+)/(\d+) live=(\d+)/(\d+)", body)
    if m:
        secrets = {"dump_sealed": int(m[1]), "dump": int(m[2]), "live_sealed": int(m[3]), "live": int(m[4])}
        body = body.replace(m[0], " ")
    m = re.search(r"secrets=(\d+)/(\d+) enc1", body)        # the first runs' way of saying it
    if m:
        secrets = secrets or {"dump_sealed": int(m[1]), "dump": int(m[2]), "live_sealed": None, "live": None}
        body = body.replace(m[0], " ")
    for tok in body.split():
        k, _, v = tok.partition("=")
        if not v:
            continue
        if k == "collections":
            a, _, b = v.partition("/")
            extra["collections"] = {"dump": int(a), "live": int(b)} if a.isdigit() and b.isdigit() else None
        elif k == "not-in-dump":
            extra["not_in_dump"] = [x for x in v.split(",") if x]
        elif v == "new-since-dump":
            counts.append({"name": k, "dump": None, "live": None, "new": True})
        else:
            a, _, b = v.partition("/")
            if a.isdigit() and b.isdigit():
                counts.append({"name": k, "dump": int(a), "live": int(b), "new": False})
    for c in counts:
        c["bad"] = any(r.split()[0] == c["name"] for r in reasons if r)
    return {"reasons": reasons, "counts": counts, "secrets": secrets,
            "collections": extra.get("collections"), "not_in_dump": extra.get("not_in_dump", [])}


def parse_log(lines: list[str]) -> tuple[list[dict], list[dict]]:
    """(the dumps, the restore checks), newest first."""
    dumps, checks = [], []
    for line in lines:
        line = line.strip()
        m = LOG_CHECK.match(line)
        if m:
            checks.append({"at": m[1], "ts": _ts(m[1]), "ok": m[2] == "ok", "archive": os.path.basename(m[3]),
                           "message": m[4], "duration_s": int(m[5]) if m[5] else None, **check_details(m[4])})
            continue
        m = LOG_DUMP.match(line)
        if m:
            dumps.append({"at": m[1], "ts": _ts(m[1]), "ok": True, "archive": os.path.basename(m[2]), "size": m[3]})
            continue
        m = LOG_FAIL.match(line)
        if m:
            dumps.append({"at": m[1], "ts": _ts(m[1]), "ok": False, "archive": None, "size": None})
    return dumps[::-1], checks[::-1]


def parse_prom(lines: list[str]) -> dict:
    out = {}
    for line in lines:
        m = re.match(r"^redline_restore_check_(\w+) (\S+)$", line.strip())
        if m:
            try:
                out[m[1]] = float(m[2])
            except ValueError:
                pass
    if not out:
        return {}
    return {"success": out.get("success") == 1, "last_run": out.get("last_run_timestamp_seconds") or None,
            "last_success": out.get("last_success_timestamp_seconds") or None,
            "documents": int(out.get("documents") or 0), "duration_s": out.get("duration_seconds")}


# ------------------------------------------------------------ the secret key


def key_state() -> dict:
    """Where the key that seals the saved secrets is, and since when - never
    the key itself. Its fingerprint (the first 12 hex of the file's SHA-256)
    lets a kept copy be checked: `sha256sum secret.key`."""
    if (os.environ.get(secretbox.KEY_ENV) or "").strip():
        return {"source": "env", "env": secretbox.KEY_ENV, "path": None, "exists": True,
                "created": None, "fingerprint": None, "mode": None}
    path = secretbox._key_file()
    try:
        st = path.stat()
    except OSError:
        return {"source": "file", "env": secretbox.KEY_ENV, "path": str(path), "exists": False,
                "created": None, "fingerprint": None, "mode": None}
    try:
        fp = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
    except OSError:
        fp = None
    try:
        rel = str(path.relative_to(ROOT))
    except ValueError:
        rel = str(path)
    return {"source": "file", "env": secretbox.KEY_ENV, "path": str(path), "rel": rel, "exists": True,
            "created": st.st_mtime, "fingerprint": fp, "mode": oct(st.st_mode & 0o777)}


# ------------------------------------------------------------ the setup


def setup_lines() -> dict:
    """The two changes to the mongo-backup service, from the stack file."""
    try:
        text = STACK.read_text()
    except OSError:
        return {"volume": None, "loop": None, "service": None}
    vol = next((ln.split("#")[0].rstrip() for ln in text.splitlines() if ":/restore-check.sh" in ln), None)
    loop = [ln for ln in text.splitlines() if "bash /restore-check.sh" in ln]
    service = text[text.find("services:"):] if "services:" in text else text
    return {"volume": vol.strip() if vol else None,
            "loop": loop[0].strip() if loop else None,
            "service": service.rstrip() + "\n"}


# ------------------------------------------------------------ the whole state


def describe(info: dict | None, snap: str | None, why: str | None, where: str, now: float | None = None) -> dict:
    """What the page shows, from the container's record and the folder's snapshot."""
    c = container(info)
    sch = c["schedule"]
    tz = _tz(sch["tz"])
    key = key_state()
    out = {"container": {k: c[k] for k in ("found", "running", "host_dir", "wired", "script_mounted")}
           | {"status": c.get("status"), "started_at": c.get("started_at")},
           "schedule": sch, "key": key, "setup": setup_lines(), "where": where, "error": why,
           "archives": [], "dumps": [], "checks": [], "prom": {}, "disk": None, "writing": []}
    if snap is None:
        return out
    s = sections(snap)
    now = now if now is not None else float((s.get("now") or [time.time()])[0])
    out["now"] = now
    dumps, checks = parse_log(s.get("log", []))
    out["dumps"], out["checks"] = dumps[:60], checks[:30]
    out["prom"] = parse_prom(s.get("prom", []))
    files = []
    for line in s.get("files", []):
        size, mt, path = line.split(" ", 2)
        name = os.path.basename(path)
        if name.endswith(".part"):
            out["writing"].append({"name": name, "size": int(size), "mtime": float(mt)})
            continue
        files.append({"name": name, "size": int(size), "mtime": float(mt)})
    nightly = [f for f in files if NIGHTLY.match(f["name"])]
    newest = max(nightly, key=lambda f: f["mtime"])["name"] if nightly else None
    last_check = {}
    for ch in checks[::-1]:                         # oldest first: the newest check of each archive wins
        last_check[ch["archive"]] = ch
    key_made = key.get("created") if key.get("source") == "file" else None
    for f in sorted(files, key=lambda f: -f["mtime"]):
        is_n = bool(NIGHTLY.match(f["name"]))
        ch = last_check.get(f["name"])
        sec = (ch or {}).get("secrets")
        # Plaintext secrets: what its restore check found, or else its age against the key's.
        if sec and sec.get("dump"):
            plain, plain_by = sec["dump_sealed"] < sec["dump"], "check"
        elif key_made:
            plain, plain_by = f["mtime"] < key_made, "key-age"
        else:
            plain, plain_by = None, None
        out["archives"].append({
            **f, "kind": "nightly" if is_n else "manual", "newest": f["name"] == newest,
            "age_s": max(0, now - f["mtime"]),
            "expires": expires(f["mtime"], sch["keep_days"], sch["at"], tz) if is_n else None,
            "plaintext": plain, "plaintext_by": plain_by,
            "check": {"ok": ch["ok"], "at": ch["at"]} if ch else None,
        })
    total = sum(f["size"] for f in files)
    df = (s.get("df") or [""])[0].split()
    du = (s.get("du") or [""])[0].strip()
    disk = {"archives": total, "nightly": sum(f["size"] for f in nightly), "dir": int(du) if du.isdigit() else total}
    if len(df) >= 4 and df[1].isdigit():
        disk |= {"size": int(df[1]), "used": int(df[2]), "free": int(df[3]), "mount": df[-1]}
    out["disk"] = disk
    out["next_dump"] = next_run(now, sch["at"], tz)
    nd = sorted(nightly, key=lambda f: f["mtime"])
    # What the folder will settle at: about one archive a day, the size of the newest.
    out["disk"]["steady"] = (nd[-1]["size"] * (sch["keep_days"] + 1)) if nd else None
    last_dump = dumps[0] if dumps else None
    age = (now - nd[-1]["mtime"]) if nd else None
    out["health"] = {
        "dump_ok": bool(last_dump and last_dump["ok"]),
        "newest_age_s": age,
        "fresh": age is not None and age < 26 * 3600,
        "check_ok": checks[0]["ok"] if checks else None,
        "plaintext": sum(1 for a in out["archives"] if a["plaintext"]),
    }
    return out


async def state() -> dict:
    info = await asyncio.to_thread(inspect)
    snap, why, where = await asyncio.to_thread(snapshot, info)
    d = describe(info, snap, why, where)
    d["run"] = run_state()
    d["owner"] = access.current() == "owner"
    return d


@router.get("")
async def status():
    _me()
    return await state()


# ------------------------------------------------------------ the restore check, now


_lock = asyncio.Lock()


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except (OSError, ValueError):
        return False
    try:                                           # a zombie is not running
        return Path(f"/proc/{pid}/stat").read_text().split(") ")[-1][:1] != "Z"
    except OSError:
        return True


def _read_run() -> dict | None:
    try:
        return json.loads((RUNS / "check.json").read_text())
    except (OSError, ValueError):
        return None


def run_state(tail: int = 0) -> dict | None:
    """The last restore check started from here: running or not, its exit
    code and, with `tail`, its last lines of output."""
    r = _read_run()
    if not r:
        return None
    rc_file = RUNS / f"{r['id']}.rc"
    rc = None
    if rc_file.exists():
        try:
            rc = int(rc_file.read_text().strip() or "1")
        except ValueError:
            rc = 1
    running = rc is None and _alive(int(r.get("pid") or 0)) and time.time() - r["started"] < CHECK_LIMIT
    out = {"id": r["id"], "started": r["started"], "by": r.get("by"), "running": running, "rc": rc,
           "lost": rc is None and not running,
           "finished": rc_file.stat().st_mtime if rc is not None else None}
    if tail:
        try:
            text = (RUNS / f"{r['id']}.log").read_text(errors="replace")
        except OSError:
            text = ""
        out["lines"] = text.splitlines()[-tail:]
    return out


def _others_running() -> bool:
    """A check started by hand (mongo-restore-check.sh --docker) is running."""
    try:
        out = _docker("ps", "-q", "--filter", "name=mongo-restore-check-", timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return bool(out.stdout.strip())


def _spawn(cid: str, host_dir: str) -> int:
    """Runs the script in a session of its own, so an API reload does not stop it."""
    RUNS.mkdir(parents=True, exist_ok=True)
    log, rc = RUNS / f"{cid}.log", RUNS / f"{cid}.rc"
    wrap = ('echo "$(date +%T) restore check of the newest archive: starting a throwaway mongo:7.0"; '
            '"$0" --docker; c=$?; echo "$(date +%T) done, exit $c"; echo $c > "$1"')
    env = {**os.environ, "BACKUP_HOST_DIR": host_dir}
    with open(log, "wb") as fh:
        p = subprocess.Popen(["bash", "-c", wrap, str(SCRIPT), str(rc)], stdout=fh, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, env=env, cwd=str(ROOT), start_new_session=True)
    threading.Thread(target=p.wait, daemon=True).start()        # reaped, no zombie
    return p.pid


@router.post("/check")
async def start_check():
    who, _role = _me()
    async with _lock:
        cur = run_state()
        if cur and cur["running"]:
            raise HTTPException(409, "a restore check is running already")
        if await asyncio.to_thread(_others_running):
            raise HTTPException(409, "a restore check started by hand is running")
        info = await asyncio.to_thread(inspect)
        c = container(info)
        if not c["running"]:
            raise HTTPException(409, "the mongo-backup container is not running: the check takes the "
                                     "database credentials from it")
        host = c["host_dir"] or os.path.expanduser("~/backups/mongodb")
        cid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
        pid = await asyncio.to_thread(_spawn, cid, host)
        (RUNS / "check.json").write_text(json.dumps({"id": cid, "pid": pid, "started": time.time(),
                                                     "by": who.get("name") or who.get("id")}))
    await _audit("backup-restore-check", cid)
    return run_state(tail=200)


@router.get("/check")
async def check_now():
    _me()
    return run_state(tail=200) or {"running": False, "lines": []}


# ------------------------------------------------------------ one archive


def _owner() -> dict:
    who, role = _me()
    if role != "owner":
        raise HTTPException(403, "only the owner downloads and deletes the backups")
    return who


async def _archive(name: str) -> dict:
    if not NAME.match(name):
        raise HTTPException(400, "not a backup archive's name")
    d = await state()
    a = next((x for x in d["archives"] if x["name"] == name), None)
    if not a:
        raise HTTPException(404, "no such archive")
    return a


@router.get("/archives/{name}")
async def download(name: str):
    _owner()
    a = await _archive(name)
    here = local_dir()
    argv = ["cat", "--", str(here / name)] if here else ["docker", "exec", CONTAINER, "cat", "--", f"{INNER}/{name}"]
    await _audit("backup-download", name, {"bytes": a["size"], "plaintext_secrets": a["plaintext"]})

    async def body():
        p = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                 stderr=asyncio.subprocess.DEVNULL)
        try:
            while chunk := await p.stdout.read(1 << 20):
                yield chunk
        finally:
            if p.returncode is None:
                p.kill()
            await p.wait()

    return StreamingResponse(body(), media_type="application/gzip", headers={
        "Content-Disposition": f'attachment; filename="{name}"', "Content-Length": str(a["size"])})


@router.delete("/archives/{name}")
async def delete(name: str):
    _owner()
    a = await _archive(name)
    if a["newest"]:
        raise HTTPException(409, "the newest nightly archive is the one a restore would use - it stays")
    r = run_state()
    if r and r["running"]:
        raise HTTPException(409, "a restore check is running - delete when it is done")
    here = local_dir()
    argv = ["rm", "-f", "--", str(here / name)] if here else ["docker", "exec", CONTAINER, "rm", "-f", "--", f"{INNER}/{name}"]
    out = await asyncio.to_thread(subprocess.run, argv, capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise HTTPException(502, f"could not delete it: {(out.stderr or '').strip()[-200:] or 'no output'}")
    await _audit("backup-delete", name, {"bytes": a["size"], "kind": a["kind"]})
    return await state()
