"""Model build: source comes from the database, work happens in a temporary
directory, output goes back to the database. Nothing persists on disk."""

from __future__ import annotations

import asyncio
import json
import os
import collections
import contextvars
import shutil
import time
import sys
import tempfile
from pathlib import Path

from . import compute, store

TIMEOUT = 900

# How often a running build looks up to see whether it has been called off.
# Often enough that stopping means stopping, rarely enough that a
# four-minute boolean is not spending its time on the database.
STOP_EVERY = 2.0

# The build job this is (backend/buildjobs.py sets it in its runner): kept on
# the model while it builds, so a job found lost clears only its own flag.
JOB: contextvars.ContextVar[str | None] = contextvars.ContextVar("build_job", default=None)


async def request_stop(db, model_id: str) -> bool:
    """Ask a running build to stop. Nothing else decides this.

    An urgent message only tells the agent that somebody wants something;
    whether four minutes of booleans are worth abandoning is a judgement
    about the work, so the agent makes it and says so by calling this.
    """
    res = await db.models.update_one(
        {"_id": model_id, "building": True},
        {"$set": {"stop_at": store.now()}})
    return res.modified_count > 0


async def _watch_for_stop(db, model_id: str, proc, since: str) -> str | None:
    """Kill the build if somebody asked it to stop after it started."""
    while True:
        await asyncio.sleep(STOP_EVERY)
        try:
            doc = await db.models.find_one({"_id": model_id}, {"stop_at": 1})
        except Exception:                 # never kill a build over a hiccup
            continue
        asked = (doc or {}).get("stop_at")
        if asked and asked > since:
            proc.kill()
            return asked


async def build(db, model_id: str, script: Path) -> dict:
    doc = await db.models.find_one({"_id": model_id})
    if not doc:
        raise KeyError(model_id)
    if not doc.get("ready"):
        raise ValueError(f"{model_id}: PARTS is not defined")

    # A build takes minutes and can be started from the CLI, where the browser
    # has no way of knowing. The flag lives on the model so the page can say
    # "building" wherever the build came from.
    started = time.monotonic()
    started_at = store.now()
    # stop_at is cleared here: a stop asked for during the last build must
    # not end this one before it has drawn a breath.
    await db.models.update_one(
        {"_id": model_id},
        {"$set": {"building": True, "build_started": started_at, "build_job": JOB.get()},
         "$unset": {"stop_at": ""}})

    tmp = Path(tempfile.mkdtemp(prefix="redline-build-"))
    try:
        models_dir = tmp / "models"
        models_dir.mkdir()
        # A model id may contain folders; a flat name is enough in the temp dir.
        flat = model_id.replace("/", "__")
        # Every model is written, not just the target: an assembly imports the
        # parts it is made of, and it can only do that if they are on the path.
        others = [m async for m in db.models.find({}, {"source": 1, "name": 1})]
        bare = collections.Counter(m.get("name") or str(m["_id"]) for m in others)
        for other in others:
            if not other.get("source"):
                continue
            (models_dir / f"{str(other['_id']).replace('/', '__')}.py").write_text(
                other["source"])
            # Also under the bare name while it is unambiguous: an assembly says
            # `import stand`, and moving that model into a folder must not break
            # the import just because the id gained a path.
            short = other.get("name") or str(other["_id"])
            if bare[short] == 1 and "/" in str(other["_id"]):
                (models_dir / f"{short}.py").write_text(other["source"])
        (models_dir / f"{flat}.py").write_text(doc["source"])
        assets_dir = tmp / "assets"
        # Models tend to write STEP/STL under <root>/exports; we create the
        # directory so model code does not have to.
        (tmp / "exports").mkdir()
        assets_dir.mkdir()

        # Uploaded CAD files land in the build root, which is what a model
        # module calls ROOT - so `import_step(ROOT / "bracket.step")` resolves
        # the same way `ROOT / "exports"` does on the way out.
        #
        # Only the ones something here names. Every build used to lay down
        # every upload: 36 MB of STEP for a model that does not mention
        # either of them, which on this link is six minutes before any
        # geometry runs. A name that is not in any source cannot be opened
        # by one.
        # The components it uses, by its imports (backend/links.py): boards
        # as generated modules with their STEP, pinned parts at their pin.
        from . import links
        linked = await links.prepare(db, model_id, models_dir, tmp)
        reachable = [doc["source"], *linked["sources"]]
        async for up in db.uploads.find({}):
            name = str(up["_id"])
            if not any(name in src for src in reachable):
                continue
            (tmp / name).write_bytes(await store.get_upload(db, name))

        # Under a memory ceiling: a model that imports a large STEP and
        # booleans against it can grow until the machine swaps and the desktop
        # freezes. With the ceiling the kernel kills the build instead.
        capped = Path(__file__).resolve().parent.parent / "tools" / "capped.sh"
        argv = [sys.executable, str(script), flat,
                "--models-dir", str(models_dir), "--assets-dir", str(assets_dir)]
        if capped.exists():
            argv = [str(capped), *argv]

        # What this costs the machine, as opposed to what it costs in tokens:
        # the card shows both. Started before the spawn, stopped after the
        # child has been waited for, which is when its usage is final.
        meter = compute.Meter()
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=str(tmp),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        meter.watch(proc.pid)
        stop = asyncio.create_task(_watch_for_stop(db, model_id, proc, started_at))
        called_off = None
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            raise TimeoutError(f"{model_id}: build did not finish within {TIMEOUT}s")
        finally:
            if stop.done() and not stop.cancelled():
                try:
                    called_off = stop.result()
                except Exception:               # the watcher itself failed
                    called_off = None
            stop.cancel()
            # Recorded however it ended: a build that ran for four minutes and
            # then blew the memory ceiling spent those four minutes.
            job = meter.stop()
            try:
                await compute.record(
                    db, "build", await compute.current_revision(db),
                    model=model_id, rc=proc.returncode, **job)
            except Exception:                    # never fail a build over this
                pass

        # Before the return code is read: a killed build looks like a failed
        # one, and why it stopped is the interesting part.
        if called_off:
            raise InterruptedError(f"{model_id}: build stopped on request")

        log = out.decode(errors="replace").strip().splitlines()
        if proc.returncode in (-9, 137):
            raise MemoryError(
                f"{model_id}: build exceeded the memory ceiling "
                f"({os.environ.get('REDLINE_BUILD_MEM', '10G')}) and was killed. "
                "Simplify the model, or raise REDLINE_BUILD_MEM for this server.")
        if proc.returncode != 0:
            raise RuntimeError("\n".join(log[-8:]) or "build failed")

        stored = {}
        viewer = assets_dir / f"{flat}.json"
        if not viewer.exists():
            raise RuntimeError("viewer payload was not produced")
        stored["viewer"] = await store.put_artifact(
            db, model_id, "viewer", viewer.read_bytes())

        # If the model wrote its own STEP/STL, keep those too.
        for path in sorted((tmp / "exports").glob("*")) if (tmp / "exports").exists() else []:
            label = path.suffix.lstrip(".").lower()
            if label in ("step", "stl", "3mf"):
                stored[label] = await store.put_artifact(
                    db, model_id, label, path.read_bytes())

        # What it was built against, so the page can say "built against
        # demoboard v12" - and tell when that is no longer the latest.
        # And who asked: the link scheduler (with the change it was for) or
        # somebody directly - a build asked for by hand is not "a rebuild
        # because board v4", however recent that rebuild's reason is.
        link = doc.get("link") or {}
        by_link = link.get("state") == "building"
        patch = {"built": {"at": store.now(), "version": doc.get("version") or 1,
                           "against": linked["against"],
                           "hash": linked["hash"],
                           "by": "link" if by_link else "request",
                           "because": link.get("because") if by_link else None,
                           "notes": linked.get("notes") or []}}
        if (doc.get("link") or {}).get("state") in ("failed", "blocked"):
            patch["link.state"] = "done"
        await db.models.update_one({"_id": model_id}, {"$set": patch})
        # Which of the models it imports came from the component cache and
        # which ran (export_model.py, backend/buildcache.py).
        report = assets_dir / f"{flat}.cache.json"
        try:
            components = json.loads(report.read_text()) if report.exists() else None
        except ValueError:
            components = None
        return {"model": model_id, "built_against": linked["hash"],
                "artifacts": {k: v["bytes"] for k, v in stored.items()},
                "components": components,
                # Anything staged older than the latest - a pin, or a board
                # that moved on mid-build - said rather than done silently.
                "notes": linked.get("notes") or [],
                "log": "\n".join([*(f"note: {n}" for n in linked.get("notes") or []), *log[-4:]])}
    finally:
        # Cleared however it ends: a crashed build that left the flag set
        # would show a bar that never stops. The duration is kept so the next
        # build can say how far along it is - the model script reports no
        # progress of its own, so the only honest estimate is how long this
        # same model took last time.
        took = round(time.monotonic() - started, 1)
        patch = {"building": False}
        if took > 1:
            patch["build_secs"] = took
        await db.models.update_one(
            {"_id": model_id},
            {"$set": patch, "$unset": {"build_started": "", "build_job": ""}})
        shutil.rmtree(tmp, ignore_errors=True)
