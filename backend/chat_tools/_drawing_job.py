"""A 3D model's technical drawing made by a process of its own, for the
Chat's drawing_get "Make now" (chat_tools/drawing_get.py).

The Chat's tools run in the answer's runner (backend/ccgen.py), which ends
with the answer - and a drawing takes minutes (release.draw_timeout). So
the drawing is made the way builds are kept alive (backend/buildjobs.py):
a process of its own session, `python -m backend.chat_tools._drawing_job
<workspace> <model> [again]`, running release.model_drawing - the very
work the 3D room's Make now starts. While it runs, a marker beside the
kept drawings (`<key>.chat`) says so; drawing_get reads it, so a second
Make now from the Chat is not started meanwhile."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def marker(key: str) -> Path:
    from .. import release
    return release.DRAWINGS / f"{key}.chat"


def failed(key: str) -> dict | None:
    """How the Chat's last drawing of this key failed ({reason, at}), while no drawing is made."""
    try:
        return json.loads(marker(key).with_suffix(".chat-failed").read_text())
    except (OSError, ValueError):
        return None


def running(key: str) -> dict | None:
    """The Chat's drawing of this key under way: {pid, model, started_at}, or None."""
    path = marker(key)
    try:
        got = json.loads(path.read_text())
        os.kill(int(got["pid"]), 0)
        return got
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _popen(workspace: str, model_id: str, again: bool) -> int:
    from .. import jobs
    jobs.LOGS.mkdir(parents=True, exist_ok=True)
    with open(jobs.LOGS / "chat-drawings.log", "ab") as log:
        proc = subprocess.Popen([sys.executable, "-m", "backend.chat_tools._drawing_job", workspace, model_id,
                                 *(["again"] if again else [])],
                                cwd=str(ROOT), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=True, env=os.environ.copy())
    threading.Thread(target=proc.wait, daemon=True).start()
    return proc.pid


async def spawn(workspace: str, model_id: str, again: bool) -> int:
    """Start it. Its own function so a test can stand in."""
    return await asyncio.to_thread(_popen, workspace, model_id, again)


async def _main(workspace: str, model_id: str, again: bool) -> int:
    from .. import main, release, scope
    scope.WORKSPACE.set(workspace)
    db = scope.ScopedDb(main.db().raw, workspace)
    now = await release.drawing_status(db, model_id)
    path = marker(now.get("key") or model_id.replace("/", "_"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.with_suffix(".chat-failed").unlink(missing_ok=True)
    path.write_text(json.dumps({"pid": os.getpid(), "model": model_id,
                                "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}))
    try:
        await release.model_drawing(db, model_id, again=again)
        print(f"drawing {model_id}: made", flush=True)
        return 0
    except Exception as exc:                        # noqa: BLE001 - said by drawing_get, kept in the log
        why = str(exc)[:300] or type(exc).__name__
        path.with_suffix(".chat-failed").write_text(json.dumps({"reason": why, "at": time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime())}))
        print(f"drawing {model_id}: {why}", flush=True)
        return 1
    finally:
        path.unlink(missing_ok=True)


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit("python -m backend.chat_tools._drawing_job <workspace> <model> [again]")
    sys.exit(asyncio.run(_main(sys.argv[1], sys.argv[2], len(sys.argv) == 4)))
