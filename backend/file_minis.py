"""The small picture at the start of a row in the Files lists.

A picture's own (made smaller), a PDF's first page (PDFium, pdftext.py),
and an STL's, a GLB's or a STEP's model from the 3D view's iso corner
(backend/minirender.py, on the CPU in a process of its own; a STEP through
the GLB filemesh.py makes of it for the preview). Made the first time a
page shows the row, kept by the file's content in its workspace
(collection `file_minis`), and served after that from there - and from the
browser's cache, as its address carries the content.

Bounded: at most SLOTS are made at once, and no more than QUEUE_MAX are
waiting or being made; past that the answer is "busy" and the page asks
again later, so a folder of 200 files never starts 200 renders. A file too
large, of a kind with no picture, or that cannot be read keeps its icon; a
failure is kept too, so it is not tried again on every view. The route
waits a moment and otherwise answers "making" (202): the list never waits.

Reached only through a file the asker can read (files_api.py finds it in
their workspace first: My files, In the app, or Deleted files).

A picture is also made at a few larger sizes for a preview (PREVIEW_PX,
`preview` below - the mobile app's viewer), kept in the same collection by
content and size, and dropped with the row pictures.
"""

from __future__ import annotations

import asyncio
import gzip
import io
import json
import os
import shutil
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from . import filemesh, files, files_virtual, pdftext

COLL = "file_minis"
PX = 160
# Bumped when they are drawn differently, so older ones are made again.
VERSION = 1
SLOTS = 2
QUEUE_MAX = 48
TIMEOUT = float(os.getenv("REDLINE_MINI_TIMEOUT", "60"))
# The renderer process's address space; past it the mesh keeps its icon.
MEMORY = 3 * 2 ** 30
MB = 2 ** 20
# Larger than this is not read for a picture.
MAX_BYTES = {"image": 60 * MB, "pdf": pdftext.MAX_BYTES, "stl": 80 * MB, "glb": 60 * MB, "step": 40 * MB}
ROOT = Path(__file__).resolve().parent.parent

_running: dict[str, asyncio.Task] = {}
_slots: tuple | None = None


def kind_of(doc: dict) -> str | None:
    """What a picture is made from, or None for a file that keeps its icon."""
    name = doc.get("name") or ""
    ext = PurePosixPath(name.lower()).suffix.lstrip(".")
    preview = files.preview_of(name, doc.get("kind", ""), doc.get("content_type", ""))
    if preview == "image" and ext != "svg":
        return "image"
    if preview == "pdf":
        return "pdf"
    if preview == "step":
        return "step"
    if preview == "mesh" and ext in ("stl", "glb"):
        return ext
    return None


def key_of(doc: dict, size: str = str(PX)) -> str:
    """The content the picture is of: its hash, or (a room's file without
    one) the entry, its size and when it was made."""
    sha = doc.get("sha256")
    what = sha or f"{doc['_id']}.{doc.get('bytes') or 0}.{doc.get('at') or doc.get('created_at') or ''}"
    return f"{what}:{size}:v{VERSION}"


def _slot() -> asyncio.Semaphore:
    global _slots
    loop = asyncio.get_running_loop()
    if _slots is None or _slots[0] is not loop:
        _slots = (loop, asyncio.Semaphore(SLOTS))
    return _slots[1]


async def mini(db, doc: dict, wait: float = 1.5) -> tuple[str, bytes | str | None]:
    """("ready", the WebP), ("making"|"busy", None) - ask again - or
    ("none", why) for a file that keeps its icon."""
    kind = kind_of(doc)
    if kind is None:
        return "none", "no picture is made of this kind of file"
    if int(doc.get("bytes") or 0) > MAX_BYTES[kind]:
        return "none", f"larger than {MAX_BYTES[kind] // MB} MB - no picture is made of it"
    key = key_of(doc)
    if (hit := await db[COLL].find_one({"_id": key})) is not None:
        return ("ready", bytes(hit["data"])) if hit.get("data") else ("none", hit.get("none") or "")
    task = _running.get(key)
    if task is None or task.get_loop() is not asyncio.get_running_loop():
        if len(_running) >= QUEUE_MAX:
            return "busy", None
        task = asyncio.get_running_loop().create_task(_make(db, doc, kind, key))
        _running[key] = task
        task.add_done_callback(lambda t: _forget(key, t))
    try:
        return await asyncio.wait_for(asyncio.shield(task), max(wait, 0.0))
    except asyncio.TimeoutError:
        return "making", None


def _forget(key: str, task: asyncio.Task) -> None:
    if _running.get(key) is task:
        _running.pop(key, None)
    if not task.cancelled():
        task.exception()                # retrieved: a failure is kept, not an unhandled error


async def _keep(db, doc: dict, key: str, kind: str, data: bytes | None, why: str = "",
                took: float = 0.0) -> tuple[str, bytes | str]:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rec = {"_id": key, "sha256": doc.get("sha256") or "", "kind": kind, "made_at": now, "ms": round(took * 1000)}
    rec.update({"data": data, "bytes": len(data)} if data else {"none": why[:300]})
    await db[COLL].replace_one({"_id": key}, rec, upsert=True)
    return ("ready", data) if data else ("none", why[:300])


async def _whole(db, doc: dict) -> dict:
    """A read-only folders' entry with its bytes (or where they are kept)."""
    if files_virtual.is_virtual(doc["_id"]) and "_data" not in doc and "_grid" not in doc:
        return await files_virtual.doc(db, doc["_id"])
    return doc


async def _read(db, doc: dict) -> bytes:
    doc = await _whole(db, doc)
    grid = await files.open_stream(db, doc)
    size = int(doc.get("bytes") or 0)
    out = bytearray()
    async for piece in files.stream(grid, 0, size - 1, 1 << 20):
        out += piece
    return bytes(out)


async def _make(db, doc: dict, kind: str, key: str) -> tuple[str, bytes | str | None]:
    glb = None
    if kind in ("step", "stl", "glb") and doc.get("sha256"):
        # A page drew this model for the grid already: that one, made smaller.
        drawn = await db[files.SOLID_THUMBS].find_one({"_id": files.solid_key(doc["sha256"])})
        if drawn and drawn.get("data"):
            t0 = time.monotonic()
            try:
                pic = await asyncio.to_thread(shrink, bytes(drawn["data"]), True)
                return await _keep(db, doc, key, kind, pic, took=time.monotonic() - t0)
            except Exception:                       # noqa: BLE001 - drawn anew below
                pass
    if kind == "step":
        # The STEP's triangles are the preview's GLB, made once (filemesh.py).
        try:
            hit = await filemesh.cached(db, doc)
        except filemesh.Unreadable as exc:
            return await _keep(db, doc, key, kind, None, str(exc))
        if hit is None:
            await filemesh.mesh(db, await _whole(db, doc), 0)   # started (or going): its own turns, asked again later
            return "making", None
        glb = await asyncio.to_thread(gzip.decompress, hit[1])
    async with _slot():
        if (hit := await db[COLL].find_one({"_id": key})) is not None:
            return ("ready", bytes(hit["data"])) if hit.get("data") else ("none", hit.get("none") or "")
        t0 = time.monotonic()
        try:
            data = glb if glb is not None else await _read(db, doc)
        except Exception as exc:                    # noqa: BLE001 - the bytes are not there
            return "none", f"the file could not be read ({type(exc).__name__})"
        try:
            if kind == "image":
                pic = await asyncio.to_thread(shrink, data)
            elif kind == "pdf":
                pic = await asyncio.to_thread(pdf_page, data)
            else:
                pic = await draw(data, "glb" if kind == "step" else kind)
        except ValueError as exc:
            return await _keep(db, doc, key, kind, None, str(exc), time.monotonic() - t0)
        except Exception as exc:                    # noqa: BLE001 - anything Pillow or PDFium cannot read
            return await _keep(db, doc, key, kind, None, f"no picture could be made ({type(exc).__name__})",
                               time.monotonic() - t0)
        finally:
            del data
        return await _keep(db, doc, key, kind, pic, took=time.monotonic() - t0)


def shrink(data: bytes, crop: bool = False) -> bytes:
    """A picture made at most PX a side, as WebP; `crop` cuts a transparent
    margin away first (a model drawn by the page)."""
    from PIL import Image, ImageOps
    with Image.open(io.BytesIO(data)) as im:
        im.draft("RGB", (PX * 2, PX * 2))
        im = ImageOps.exif_transpose(im)
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if "A" in im.getbands() or im.mode in ("P", "LA") else "RGB")
        if crop and im.mode == "RGBA" and (box := im.getchannel("A").getbbox()):
            im = im.crop(box)
        im.thumbnail((PX, PX), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        im.save(out, "WEBP", quality=82, method=4)
        return out.getvalue()


def pdf_page(data: bytes) -> bytes:
    """A PDF's first page, at most PX a side, as WebP. PdfError (a
    ValueError) says why there is none."""
    from PIL import Image
    png, _ = pdftext.render_png(data, 1, 48)
    with Image.open(io.BytesIO(png)) as im:
        im = im.convert("RGB")
        im.thumbnail((PX, PX), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        im.save(out, "WEBP", quality=80, method=4)
        return out.getvalue()


def _limits() -> None:
    os.nice(10)
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY, MEMORY))
    except (ImportError, ValueError, OSError):
        pass


async def draw(data: bytes, kind: str) -> bytes:
    """An STL's or a GLB's model drawn by backend/minirender.py in a process
    of its own, niced, with a time and a memory limit. ValueError: why not."""
    work = Path(tempfile.mkdtemp(prefix="redline-mini-"))
    try:
        src, dst = work / f"in.{kind}", work / "out.webp"
        await asyncio.to_thread(src.write_bytes, data)
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "backend.minirender", kind, str(src), str(dst), str(PX),
            cwd=str(ROOT), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, preexec_fn=_limits)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise ValueError(f"drawing it took more than {round(TIMEOUT)} s") from None
        try:
            got = json.loads(out.decode(errors="replace").strip().splitlines()[-1])
        except (ValueError, IndexError):
            got = {"error": "the drawing stopped without a result"}
        if got.get("error") or proc.returncode != 0 or not dst.exists():
            raise ValueError(str(got.get("error") or "the model could not be drawn"))
        return dst.read_bytes()
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------- a picture at a size, for a preview

# The sizes a picture is shown at (GET /api/files/{id}/thumb?px=): a phone's
# preview asks for one of these rather than the original, so a 12 MB photo
# is not fetched whole to be shown on a small screen. Few sizes, so few are
# kept; any other asked for is the next one up.
PREVIEW_PX = (320, 800, 1600)
PREVIEW_TYPES = {"webp": "image/webp", "jpeg": "image/jpeg"}


def preview_px(px: int) -> int:
    """The kept size a wish for `px` gets: the smallest at least as large, or the largest."""
    return next((p for p in PREVIEW_PX if p >= px), PREVIEW_PX[-1])


def preview_key(doc: dict, px: int, fmt: str) -> str:
    return key_of(doc, f"p{px}.{fmt}")


async def preview(db, doc: dict, px: int, fmt: str = "webp") -> bytes:
    """A picture made at most `px` (one of PREVIEW_PX) a side, as WebP or
    JPEG; made once and kept by content beside the row pictures, and
    dropped with them. ValueError: why there is none (not a picture, too
    large, unreadable)."""
    if kind_of(doc) != "image":
        raise ValueError("no picture is made of this kind of file")
    if int(doc.get("bytes") or 0) > MAX_BYTES["image"]:
        raise ValueError(f"larger than {MAX_BYTES['image'] // MB} MB - no picture is made of it")
    key = preview_key(doc, px, fmt)
    if (hit := await db[COLL].find_one({"_id": key})) is not None and hit.get("data"):
        return bytes(hit["data"])
    async with _slot():
        if (hit := await db[COLL].find_one({"_id": key})) is not None and hit.get("data"):
            return bytes(hit["data"])
        t0 = time.monotonic()
        try:
            data = await _read(db, doc)
        except Exception as exc:                    # noqa: BLE001 - the bytes are not there
            raise ValueError(f"the file could not be read ({type(exc).__name__})") from exc
        try:
            pic = await asyncio.to_thread(sized, data, px, fmt)
        except Exception as exc:                    # noqa: BLE001 - anything Pillow cannot read
            raise ValueError(f"the picture could not be read ({type(exc).__name__})") from exc
        finally:
            del data
        await _keep(db, doc, key, f"preview-{px}", pic, took=time.monotonic() - t0)
        return pic


def sized(data: bytes, px: int, fmt: str = "webp") -> bytes:
    """A picture made at most `px` a side (never larger than it is), turned
    upright, without its metadata (a photo's place is not passed on)."""
    from PIL import Image, ImageOps
    with Image.open(io.BytesIO(data)) as im:
        im.draft("RGB", (px, px))
        im = ImageOps.exif_transpose(im)
        alpha = "A" in im.getbands() or im.mode in ("P", "LA")
        if fmt == "jpeg":
            if alpha:
                im = im.convert("RGBA")
                flat = Image.new("RGB", im.size, (255, 255, 255))
                flat.paste(im, mask=im.getchannel("A"))
                im = flat
            elif im.mode != "RGB":
                im = im.convert("RGB")
        elif im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if alpha else "RGB")
        im.thumbnail((px, px), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        if fmt == "jpeg":
            im.save(out, "JPEG", quality=84, optimize=True, progressive=True)
        else:
            im.save(out, "WEBP", quality=82, method=4)
        return out.getvalue()


async def drop(db, sha: str | None) -> None:
    """The pictures of these bytes, with the last copy of them (files.py)."""
    if sha:
        await db[COLL].delete_many({"sha256": sha})
