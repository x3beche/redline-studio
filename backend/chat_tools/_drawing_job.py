"""A 3D model's technical drawing made by a process of its own, for the
Chat's drawing_get "Make now" and drawing_layout's make
(chat_tools/drawing_get.py, drawing_layout.py).

The Chat's tools run in the answer's runner (backend/ccgen.py), which ends
with the answer - and a drawing takes minutes (release.draw_timeout). So
the drawing is made the way builds are kept alive (backend/buildjobs.py):
a process of its own session, `python -m backend.chat_tools._drawing_job
<workspace> <model> [again]`, running release.model_drawing - the very
work the 3D room's Make now starts. What it is doing is release's job row
in the database (release.JOBS): queued (by "chat", with this process's
pid) as soon as it is started, then claimed and beaten while it is made -
so the room shows it being made, and neither the room nor the Chat starts
the same drawing a second time meanwhile."""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


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
    """Start the process. Its own function so a test can stand in."""
    return await asyncio.to_thread(_popen, workspace, model_id, again)


async def start(db, model_id: str, again: bool) -> int:
    """Start the drawing in a process of its own and say at once that it is
    waiting to be made (its row, by "chat"), before the process is up."""
    from .. import release
    pid = await spawn(getattr(db, "workspace", "default"), model_id, again)
    await release.queue(db, model_id, "chat", pid=pid)
    return pid


async def _main(workspace: str, model_id: str, again: bool) -> int:
    from .. import main, release, scope
    scope.WORKSPACE.set(workspace)
    db = scope.ScopedDb(main.db().raw, workspace)
    try:
        await release.model_drawing(db, model_id, again=again, by="chat")
        print(f"drawing {model_id}: made", flush=True)
        return 0
    except Exception as exc:                        # noqa: BLE001 - in the job row (drawing_status), and the log
        print(f"drawing {model_id}: {str(exc)[:300] or type(exc).__name__}", flush=True)
        return 1


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit("python -m backend.chat_tools._drawing_job <workspace> <model> [again]")
    sys.exit(asyncio.run(_main(sys.argv[1], sys.argv[2], len(sys.argv) == 4)))
