"""A STEP from the Files tab, turned into something the page can turn.

A browser cannot read a STEP: it is a B-rep, and only a CAD kernel makes
triangles of it. So the server does it once - OpenCascade reads the file
with its names and colours, meshes it to a deflection that follows the
part's size and writes a GLB (backend/imports/step3d.py `--preview`) - and
keeps the result, gzipped, by the file's content hash. The second open,
and anyone else's open of the same bytes, is a read from GridFS.

The conversion runs in a process of its own, niced, with a time limit: a
50 MB assembly holds an interpreter for seconds and the API must keep
answering meanwhile. It is not tied to the request that started it - the
route waits a while and otherwise answers "preparing", and the page asks
again - so a proxy's own time limit never cuts a long one short, and two
people opening the same file share one conversion.

The cache (`file_meshes`, and a GridFS bucket of the same name) belongs to
no workspace: it is keyed by content, and reached only through a file the
asker can already read (files_api.py looks the file up in their workspace
first). A STEP OpenCascade cannot read is remembered as such, so it is not
read again on every open.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import os
import shutil
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from . import files

COLL = "file_meshes"
BUCKET = "file_meshes"
# Bumped when the tessellation changes, so older results are made again.
VERSION = 1
TIMEOUT = float(os.getenv("REDLINE_STEP_MESH_TIMEOUT", "600"))
# Conversions at once; the rest wait their turn.
SLOTS = 2
ROOT = Path(__file__).resolve().parent.parent

_running: dict[str, asyncio.Task] = {}
_since: dict[str, float] = {}
_slots: tuple | None = None


class Unreadable(Exception):
    """The STEP could not be made into a mesh; the reason is the message."""


def key_of(doc: dict) -> str:
    return f"{doc.get('sha256') or doc['_id']}:v{VERSION}"


def _bucket(db):
    from .store import bucket
    return bucket(db, BUCKET)


def _slot() -> asyncio.Semaphore:
    global _slots
    loop = asyncio.get_running_loop()
    if _slots is None or _slots[0] is not loop:
        _slots = (loop, asyncio.Semaphore(SLOTS))
    return _slots[1]


async def cached(db, doc: dict) -> tuple[dict, bytes] | None:
    """The kept result for this file's bytes: (its record, the gzipped
    GLB), or None. Raises Unreadable for a file already found unreadable."""
    hit = await db[COLL].find_one({"_id": key_of(doc)})
    if not hit:
        return None
    if hit.get("error"):
        raise Unreadable(hit["error"])
    grid = await _bucket(db).open_download_stream(hit["gridfs_id"])
    return hit, await grid.read()


async def _convert(src: Path, dst: Path) -> dict:
    """step3d --preview in a process of its own; its JSON line."""
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "backend.imports.step3d", str(src), str(dst), "--preview",
        cwd=str(ROOT), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        preexec_fn=lambda: os.nice(10))
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return {"error": f"the STEP took more than {round(TIMEOUT / 60)} minutes to read"}
    text = out.decode(errors="replace").strip()
    try:
        got = json.loads(text.splitlines()[-1])
    except (ValueError, IndexError):
        return {"error": "the STEP reader stopped without a result" + (f": {text[-200:]}" if text else "")}
    if proc.returncode != 0 or not dst.exists():
        got.setdefault("error", "the STEP could not be read")
    return got


async def _make(db, doc: dict) -> tuple[dict, bytes]:
    key = key_of(doc)
    async with _slot():
        # Someone else's request may have finished it while this one waited.
        if (hit := await cached(db, doc)) is not None:
            return hit
        work = Path(tempfile.mkdtemp(prefix="redline-mesh-"))
        try:
            src = work / "in.step"
            grid = await files.open_stream(db, doc)
            with src.open("wb") as fh:
                async for piece in files.stream(grid, 0, int(doc.get("bytes") or 0) - 1, 1 << 20):
                    fh.write(piece)
            t0 = time.monotonic()
            got = await _convert(src, work / "out.glb")
            took = round(time.monotonic() - t0, 2)
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            if got.get("error"):
                await db[COLL].replace_one({"_id": key}, {"_id": key, "error": str(got["error"])[:400],
                                                          "made_at": now}, upsert=True)
                raise Unreadable(str(got["error"])[:400])
            # Off the event loop: a big GLB takes a second or two to pack.
            packed = await asyncio.to_thread(lambda: gzip.compress((work / "out.glb").read_bytes(), 6))
            gid = await _bucket(db).upload_from_stream(f"{key}.glb.gz", packed)
            rec = {"_id": key, "gridfs_id": gid, "bytes": (work / "out.glb").stat().st_size,
                   "packed": len(packed), "triangles": got.get("triangles"), "size": got.get("size"),
                   "deflection": got.get("deflection"), "seconds": took, "made_at": now}
            await db[COLL].replace_one({"_id": key}, rec, upsert=True)
            return rec, packed
        finally:
            shutil.rmtree(work, ignore_errors=True)


async def mesh(db, doc: dict, wait: float) -> tuple[dict, bytes] | None:
    """The gzipped GLB of a stored STEP, made if it is not kept yet. Waits
    up to `wait` seconds for a conversion; None if it is still going (it
    carries on, and the next call picks it up)."""
    if (hit := await cached(db, doc)) is not None:
        return hit
    key = key_of(doc)
    task = _running.get(key)
    if task is None or task.done() and task.get_loop() is not asyncio.get_running_loop():
        task = asyncio.get_running_loop().create_task(_make(db, doc))
        _running[key], _since[key] = task, time.monotonic()
        task.add_done_callback(lambda t: _forget(key, t))
    try:
        return await asyncio.wait_for(asyncio.shield(task), wait)
    except asyncio.TimeoutError:
        return None


def _forget(key: str, task: asyncio.Task) -> None:
    if _running.get(key) is task:
        _running.pop(key, None)
        _since.pop(key, None)
    if not task.cancelled():
        task.exception()                # retrieved: an unreadable STEP is not an unhandled error


def elapsed(doc: dict) -> float:
    """Seconds this file's conversion has been going, 0 if it is not."""
    t0 = _since.get(key_of(doc))
    return round(time.monotonic() - t0, 1) if t0 else 0.0
