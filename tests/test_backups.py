"""Settings > Backups (backend/backups.py): what the page reads from a backup
folder and the backup container's record - with a folder of fake archives
and a fake `docker inspect` - and who may do what."""

from __future__ import annotations

import asyncio
import os
import re
import time
from pathlib import Path

import pytest
from fastapi import HTTPException

from backend import access, actors, backups, secretbox

NOW = 1791979200.0                 # 2026-10-14 12:00 UTC, 15:00 in Istanbul
DAY = 86400

CMD = ("dump() {\n  f=/backups/redline-$(date +%Y-%m-%d_%H%M).archive.gz\n ...\n}\n"
       "while true; do\n  now=$(date +%s); next=$(date -d \"$(date +%Y-%m-%d) 03:30\" +%s)\n"
       "  sleep $((next - now)); dump\ndone\n")
WIRED = CMD.replace("dump\ndone", "dump\n  [ \"$(date +%u)\" = 7 ] && bash /restore-check.sh >/dev/null 2>&1\ndone")


def info(cmd=CMD, script=False, running=True):
    mounts = [{"Source": "/home/x3/backups/mongodb", "Destination": "/backups"}]
    if script:
        mounts.append({"Source": "/repo/docker/deploy/mongo-restore-check.sh", "Destination": "/restore-check.sh"})
    return {"State": {"Running": running, "Status": "running" if running else "exited"},
            "Config": {"Env": ["MONGO_USER=root", "MONGO_PASS=hunter2", "KEEP_DAYS=7", "TZ=Europe/Istanbul"],
                       "Cmd": [cmd]},
            "Mounts": mounts}


LOG = """\
2026-10-12T03:30:11+03:00 ok /backups/redline-2026-10-12_0330.archive.gz 508M
2026-10-13T03:30:13+03:00 FAILED
2026-10-14T03:30:14+03:00 ok /backups/redline-2026-10-14_0330.archive.gz 566M
2026-10-14T15:06:43+03:00 restore-check FAILED /backups/redline-2026-10-14_0330.archive.gz product_files missing; 7 secret(s) not enc1: | users=4/4 cc_chats=58/64 secrets=0/7 enc1 collections=98/100 not-in-dump=agent_sessions,product_files (18s)
2026-10-14T15:08:11+03:00 restore-check FAILED /backups/redline-2026-10-14_0330.archive.gz 7 secret(s) not enc1: | users=4/4 cc_chats=58/64 product_files=new-since-dump secrets enc1 dump=0/7 live=7/7 collections=98/100 not-in-dump=agent_sessions,product_files (15s)
"""
PROM = """\
# HELP redline_restore_check_success 1 if the last restore check of the newest backup passed.
redline_restore_check_success 0
redline_restore_check_last_run_timestamp_seconds 1791979691
redline_restore_check_last_success_timestamp_seconds 0
redline_restore_check_documents 227059
redline_restore_check_duration_seconds 15
"""


@pytest.fixture
def folder(tmp_path, monkeypatch):
    """A backup folder: three nightly archives, one kept by hand, the log and the metrics."""
    d = tmp_path / "mongodb"
    (d / "metrics").mkdir(parents=True)
    files = {"redline-2026-10-07_0330.archive.gz": NOW - 7 * DAY - 11.5 * 3600,
             "redline-2026-10-12_0330.archive.gz": NOW - 2 * DAY - 9 * 3600,
             "redline-2026-10-14_0330.archive.gz": NOW - 9 * 3600,
             "keep-before-sheets-20261007_1956.archive.gz": NOW - 6 * DAY}
    for name, mt in files.items():
        (d / name).write_bytes(b"x" * 1000)
        os.utime(d / name, (mt, mt))
    (d / "backup.log").write_text(LOG)
    (d / "metrics" / "restore_check.prom").write_text(PROM)
    monkeypatch.setenv("BACKUP_DIR", str(d))
    monkeypatch.delenv(secretbox.KEY_ENV, raising=False)
    key = tmp_path / "secret.key"
    key.write_text("k" * 44)
    os.utime(key, (NOW - 4 * 3600, NOW - 4 * 3600))   # made after the 03:30 dump
    monkeypatch.setenv(secretbox.KEY_FILE_ENV, str(key))
    monkeypatch.setattr(backups, "RUNS", tmp_path / "runs")
    return d


def run(c):
    return asyncio.run(c)


def read(inf=None):
    inf = inf if inf is not None else info()
    snap, why, where = backups.snapshot(inf)
    return backups.describe(inf, snap, why, where, now=NOW)


def test_the_archives_newest_first_with_kind_and_expiry(folder):
    d = read()
    names = [a["name"] for a in d["archives"]]
    assert names[0] == "redline-2026-10-14_0330.archive.gz" and d["archives"][0]["newest"]
    assert sum(a["newest"] for a in d["archives"]) == 1
    kept = next(a for a in d["archives"] if a["name"].startswith("keep-"))
    assert kept["kind"] == "manual" and kept["expires"] is None
    # The oldest nightly one is pruned at the next 03:30 Istanbul time (00:30 UTC), tomorrow.
    old = next(a for a in d["archives"] if a["name"] == "redline-2026-10-07_0330.archive.gz")
    assert old["expires"] == NOW + 12.5 * 3600
    assert all(a["size"] == 1000 for a in d["archives"])


def test_plaintext_from_the_check_or_from_the_key_s_age(folder):
    by = {a["name"]: a for a in read()["archives"]}
    newest = by["redline-2026-10-14_0330.archive.gz"]
    assert newest["plaintext"] is True and newest["plaintext_by"] == "check"
    assert newest["check"] == {"ok": False, "at": "2026-10-14T15:08:11+03:00"}
    assert by["redline-2026-10-12_0330.archive.gz"]["plaintext_by"] == "key-age"
    assert by["keep-before-sheets-20261007_1956.archive.gz"]["plaintext"] is True


def test_an_archive_written_after_the_key_is_sealed(folder):
    f = folder / "redline-2026-10-15_0330.archive.gz"
    f.write_bytes(b"y")
    os.utime(f, (NOW - 60, NOW - 60))
    a = read()["archives"][0]
    assert a["name"] == f.name and a["plaintext"] is False and a["newest"]


def test_the_log_dumps_and_checks(folder):
    d = read()
    assert [x["ok"] for x in d["dumps"]] == [True, False, True]
    assert d["dumps"][0]["size"] == "566M"
    c = d["checks"][0]
    assert not c["ok"] and c["duration_s"] == 15 and c["archive"] == "redline-2026-10-14_0330.archive.gz"
    assert c["reasons"] == ["7 secret(s) not enc1:"]
    assert c["secrets"] == {"dump_sealed": 0, "dump": 7, "live_sealed": 7, "live": 7}
    assert {"name": "cc_chats", "dump": 58, "live": 64, "new": False, "bad": False} in c["counts"]
    assert any(x["name"] == "product_files" and x["new"] for x in c["counts"])
    assert c["collections"] == {"dump": 98, "live": 100}
    assert c["not_in_dump"] == ["agent_sessions", "product_files"]
    # The first runs' way of writing the secrets.
    old = d["checks"][1]
    assert old["secrets"]["dump"] == 7 and old["secrets"]["live"] is None
    assert old["reasons"] == ["product_files missing", "7 secret(s) not enc1:"]


def test_a_passing_check_has_no_reasons():
    c = backups.check_details("users=4/4 secrets enc1 dump=7/7 live=7/7 collections=100/100")
    assert c["reasons"] == [] and c["secrets"]["dump_sealed"] == 7


def test_a_check_that_did_not_run_says_why():
    c = backups.check_details("MONGO_USER/MONGO_PASS not set")
    assert c["reasons"] == ["MONGO_USER/MONGO_PASS not set"] and c["counts"] == []


def test_the_metrics_disk_and_health(folder):
    d = read()
    assert d["prom"] == {"success": False, "last_run": 1791979691, "last_success": None,
                         "documents": 227059, "duration_s": 15}
    assert d["disk"]["archives"] == 4000 and d["disk"]["nightly"] == 3000
    assert d["disk"]["size"] > 0 and d["disk"]["free"] > 0
    h = d["health"]
    assert h["fresh"] and h["dump_ok"] and h["check_ok"] is False and h["plaintext"] == 4


def test_the_schedule_from_the_container_and_never_the_password(folder):
    d = read()
    assert d["schedule"] == {"at": "03:30", "keep_days": 7, "tz": "Europe/Istanbul",
                             "weekly_check": None, "source": "container"}
    assert d["container"]["host_dir"] == "/home/x3/backups/mongodb"
    assert not d["container"]["wired"]
    assert "hunter2" not in repr(d)


def test_wired_when_the_script_is_mounted_and_run():
    c = backups.container(info(WIRED, script=True))
    assert c["wired"] and c["schedule"]["weekly_check"] == 7
    assert not backups.container(info(WIRED, script=False))["wired"]
    assert not backups.container(info(CMD, script=True))["wired"]


def test_no_container_falls_back_to_the_stack_s_schedule(monkeypatch):
    monkeypatch.delenv("BACKUP_DIR", raising=False)
    snap, why, _ = backups.snapshot(None)
    assert snap is None and "not on this machine" in why
    d = backups.describe(None, None, why, "")
    assert d["schedule"]["source"] == "default" and d["schedule"]["at"] == "03:30"
    assert d["archives"] == [] and d["error"]


def test_read_through_docker_exec_when_not_mounted(folder, monkeypatch):
    monkeypatch.delenv("BACKUP_DIR")
    seen = {}
    real = backups.subprocess.run

    def fake(argv, **kw):
        seen["argv"] = argv
        # The container's /backups is the folder here.
        return real(["sh", "-c", argv[5], "sh", str(folder)], **kw)

    monkeypatch.setattr(backups.subprocess, "run", fake)
    snap, why, where = backups.snapshot(info())
    assert why is None and where == "mongo-backup:/backups"
    assert seen["argv"][:3] == ["docker", "exec", "mongo-backup"] and seen["argv"][-1] == "/backups"
    assert "##files" in snap


def test_a_stopped_container_cannot_be_read(monkeypatch):
    monkeypatch.delenv("BACKUP_DIR", raising=False)
    snap, why, _ = backups.snapshot(info(running=False))
    assert snap is None and "not running" in why


def test_the_key_is_described_never_shown(folder):
    k = read()["key"]
    assert k["source"] == "file" and k["exists"] and k["created"] == NOW - 4 * 3600
    assert re.fullmatch(r"[0-9a-f]{12}", k["fingerprint"])
    assert "k" * 44 not in repr(k)


def test_the_key_from_the_environment(monkeypatch):
    monkeypatch.setenv(secretbox.KEY_ENV, "a passphrase")
    k = backups.key_state()
    assert k["source"] == "env" and k["created"] is None and "passphrase" not in repr(k)


def test_the_setup_lines_come_from_the_stack_file():
    s = backups.setup_lines()
    assert s["volume"].startswith("- ") and s["volume"].endswith(":/restore-check.sh:ro")
    assert "bash /restore-check.sh" in s["loop"]
    assert s["service"].startswith("services:")


def test_expiry_follows_find_mtime():
    tz = backups._tz("Europe/Istanbul")
    made = 1791333004.0                 # 2026-10-07 03:30:04 Istanbul
    # find -mtime +7 takes it once it is 8 whole days old: at the 03:30 run of 15 Oct.
    assert backups.expires(made, 7, "03:30", tz) == made - 4 + 8 * DAY


# ------------------------------------------------------------ the check run


def test_one_check_at_a_time(folder, monkeypatch):
    runs = backups.RUNS
    runs.mkdir()
    (runs / "check.json").write_text(f'{{"id": "a", "pid": {os.getpid()}, "started": {time.time()}}}')
    r = backups.run_state()
    assert r["running"] and r["rc"] is None
    (runs / "a.rc").write_text("1\n")
    (runs / "a.log").write_text("restore-check FAILED: 7 secret(s) not enc1:\n")
    r = backups.run_state(tail=10)
    assert not r["running"] and r["rc"] == 1 and r["lines"] == ["restore-check FAILED: 7 secret(s) not enc1:"]


def test_a_check_whose_process_died_is_lost(folder):
    backups.RUNS.mkdir()
    (backups.RUNS / "check.json").write_text(f'{{"id": "b", "pid": 999999999, "started": {time.time()}}}')
    r = backups.run_state()
    assert not r["running"] and r["lost"]


def test_start_refuses_while_one_runs(folder, monkeypatch):
    monkeypatch.setattr(actors, "current", lambda: {"type": "user", "id": "o", "name": "Owner"})
    monkeypatch.setattr(access, "current", lambda: "admin")
    monkeypatch.setattr(backups, "run_state", lambda tail=0: {"running": True})
    with pytest.raises(HTTPException) as e:
        run(backups.start_check())
    assert e.value.status_code == 409


def test_start_spawns_the_script_with_the_host_folder(folder, monkeypatch):
    monkeypatch.setattr(actors, "current", lambda: {"type": "user", "id": "o", "name": "Owner"})
    monkeypatch.setattr(access, "current", lambda: "admin")
    monkeypatch.setattr(backups, "_others_running", lambda: False)
    monkeypatch.setattr(backups, "inspect", lambda: info())
    seen = {}

    def spawn(cid, host):
        seen["host"] = host
        backups.RUNS.mkdir(parents=True, exist_ok=True)
        return os.getpid()

    async def audit(*a, **k):
        seen["audit"] = a

    monkeypatch.setattr(backups, "_spawn", spawn)
    monkeypatch.setattr(backups, "_audit", audit)
    r = run(backups.start_check())
    assert r["running"] and r["by"] == "Owner"
    assert seen["host"] == "/home/x3/backups/mongodb" and seen["audit"][0] == "backup-restore-check"


def test_start_needs_the_backup_container(folder, monkeypatch):
    monkeypatch.setattr(actors, "current", lambda: {"type": "user", "id": "o", "name": "Owner"})
    monkeypatch.setattr(access, "current", lambda: "owner")
    monkeypatch.setattr(backups, "_others_running", lambda: False)
    monkeypatch.setattr(backups, "inspect", lambda: None)
    with pytest.raises(HTTPException) as e:
        run(backups.start_check())
    assert e.value.status_code == 409


# ------------------------------------------------------------ rights, download, delete


def test_the_path_is_behind_the_admin_rule():
    src = open(access.__file__).read()
    pat = re.search(r'\("\*", "(/api/admin[^"]*)", "users"\)', src).group(1)
    assert re.fullmatch(pat, "/api/admin/backups") and re.fullmatch(pat, "/api/admin/backups/archives/x.archive.gz")


@pytest.mark.parametrize("role", ["user", "editor", "viewer"])
def test_others_are_refused(monkeypatch, role):
    monkeypatch.setattr(actors, "current", lambda: {"type": "user", "id": "u1", "name": "U"})
    monkeypatch.setattr(access, "current", lambda: role)
    with pytest.raises(HTTPException) as e:
        backups._me()
    assert e.value.status_code == 403


def test_an_admin_may_not_download_or_delete(monkeypatch):
    monkeypatch.setattr(actors, "current", lambda: {"type": "user", "id": "a", "name": "A"})
    monkeypatch.setattr(access, "current", lambda: "admin")
    with pytest.raises(HTTPException) as e:
        backups._owner()
    assert e.value.status_code == 403


def test_a_page_session_is_refused_even_as_owner(monkeypatch):
    monkeypatch.setattr(actors, "current", lambda: {"type": "user", "id": "o", "page": True})
    monkeypatch.setattr(access, "current", lambda: "owner")
    with pytest.raises(HTTPException):
        backups._owner()


@pytest.fixture
def owner(monkeypatch):
    monkeypatch.setattr(actors, "current", lambda: {"type": "user", "id": "o", "name": "Owner"})
    monkeypatch.setattr(access, "current", lambda: "owner")
    monkeypatch.setattr(backups, "inspect", lambda: info())
    trail = []

    async def audit(*a, **k):
        trail.append(a)

    monkeypatch.setattr(backups, "_audit", audit)
    return trail


def test_delete_an_old_archive(folder, owner):
    d = run(backups.delete("redline-2026-10-12_0330.archive.gz"))
    assert not (folder / "redline-2026-10-12_0330.archive.gz").exists()
    assert "redline-2026-10-12_0330.archive.gz" not in [a["name"] for a in d["archives"]]
    assert owner[0][:2] == ("backup-delete", "redline-2026-10-12_0330.archive.gz")


def test_the_newest_nightly_is_never_deleted(folder, owner):
    with pytest.raises(HTTPException) as e:
        run(backups.delete("redline-2026-10-14_0330.archive.gz"))
    assert e.value.status_code == 409 and (folder / "redline-2026-10-14_0330.archive.gz").exists()


@pytest.mark.parametrize("name", ["../secret.key", "backup.log", "x.archive.gz/../../a.archive.gz"])
def test_only_archives_by_name(folder, owner, name):
    with pytest.raises(HTTPException) as e:
        run(backups.delete(name))
    assert e.value.status_code in (400, 404)


def test_download_streams_and_is_audited(folder, owner):
    async def go():
        r = await backups.download("redline-2026-10-12_0330.archive.gz")
        return r, b"".join([c async for c in r.body_iterator])

    r, body = run(go())
    assert body == b"x" * 1000
    assert r.headers["content-length"] == "1000"
    assert 'filename="redline-2026-10-12_0330.archive.gz"' in r.headers["content-disposition"]
    assert owner[0][0] == "backup-download" and owner[0][2]["plaintext_secrets"] is True


def test_download_of_an_unknown_archive(folder, owner):
    with pytest.raises(HTTPException) as e:
        run(backups.download("redline-2026-01-01_0330.archive.gz"))
    assert e.value.status_code == 404


def test_the_tab_is_in_the_admin_settings():
    room = "".join(Path(f"frontend/src/app/{f}").read_text() for f in ("settings-room.ts", "preferences.ts")
                   if Path(f"frontend/src/app/{f}").exists())
    assert "<app-backups-settings />" in room and "id: 'backups'" in room
    assert "'backups'" in Path("frontend/src/app/preferences.ts").read_text()
