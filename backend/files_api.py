"""The Files tab's routes: files in folders, read in place.

The bytes live in GridFS (backend/files.py); these routes list them, take
them in, hand them back - whole, or a range of them so a video can be
scrubbed and a PDF read a page at a time - and keep the folders. Sending a
file to an agent and making a model of one stay in main.py beside the
rooms they reach.
"""

from __future__ import annotations

import json
import re
import tempfile
from datetime import datetime, timezone
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from pymongo.errors import DuplicateKeyError

from . import access, actors, filemesh, files

router = APIRouter()

ZIP_MAX = 2 * 1024 * 1024 * 1024


def _db():
    from .main import db              # late: main imports the routers
    return db()


def file_out(d: dict) -> dict:
    out = {k: v for k, v in d.items() if k not in ("_id", "workspace_id", "gridfs_id", "thumb")}
    # Files kept before video and audio had kinds of their own were "other".
    if out.get("kind") == "other":
        out["kind"] = files.kind_of(out.get("name", ""))
    out["folder"] = out.get("folder") or ""
    out["preview"] = files.preview_of(out.get("name", ""), out.get("kind", ""), out.get("content_type", ""))
    out["id"] = d["_id"]
    return out


def folder_out(d: dict) -> dict:
    return {"id": d["_id"], "name": d["name"], "parent": d.get("parent") or "", "path": d.get("path") or d["name"],
            "by": d.get("by") or {}, "created_at": d.get("created_at")}


def _may_remove(doc: dict) -> bool:
    """Your own, always; someone else's, only if you may delete (as notes)."""
    return (doc.get("by") or {}).get("id") == actors.current().get("id") or \
        access.allowed(access.current(), "delete")


def _refused() -> HTTPException:
    return HTTPException(403, access.refusal(access.current() or "nobody", "delete"))


def _disposition(how: str, name: str) -> str:
    ascii_name = re.sub(r'[^A-Za-z0-9._-]', "_", name)
    return f"{how}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"


# ---------------------------------------------------------------- folders

@router.get("/api/files/folders")
async def folders_list():
    return [folder_out(f) for f in await files.all_folders(_db())]


class FolderIn(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    parent: str = Field(default="", max_length=64)
    # or a whole path, made as far as it is missing (`revisions.py files mkdir`)
    path: str | None = Field(default=None, max_length=1000)


@router.post("/api/files/folders")
async def folders_make(body: FolderIn):
    try:
        if body.path:
            doc = await files.make_path(_db(), body.path, actors.current())
        else:
            doc = await files.make_folder(_db(), body.name or "", body.parent, actors.current())
    except files.Clash as exc:
        raise HTTPException(409, str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(404, f"no folder {exc.args[0]!r}") from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return folder_out(doc)


class FolderPatch(BaseModel):
    name: str = Field(max_length=200)


@router.patch("/api/files/folders/{fid}")
async def folders_rename(fid: str, body: FolderPatch):
    try:
        doc = await files.rename_folder(_db(), fid, body.name)
    except files.Clash as exc:
        raise HTTPException(409, str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(404, fid) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return folder_out(doc)


@router.delete("/api/files/folders/{fid}")
async def folders_delete(fid: str, contents: bool = False):
    """An empty folder; one with something in it only with `contents=true`
    (the page asks first), and only if every file in it is yours to delete."""
    doc = await _db()[files.FOLDERS].find_one({"_id": fid}, {"name": 1, "path": 1})
    if not doc:
        raise HTTPException(404, fid)
    try:
        got = await files.remove_folder(_db(), fid, contents, _may_remove)
    except files.Clash as exc:
        raise HTTPException(409, str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(403, f"{access.refusal(access.current() or 'nobody', 'delete')} ({exc})") from exc
    await actors.audit(_db(), "delete", f"folder {doc.get('path')}", {"id": fid, **got})
    return {"deleted": fid, **got}


class MoveIn(BaseModel):
    files: list[str] = Field(default_factory=list, max_length=5000)
    folders: list[str] = Field(default_factory=list, max_length=1000)
    to: str = Field(default="", max_length=64)


@router.post("/api/files/move")
async def files_move(body: MoveIn):
    try:
        return await files.move(_db(), body.files, body.folders, body.to)
    except files.Clash as exc:
        raise HTTPException(409, str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(404, f"no folder {exc.args[0]!r}") from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


class BulkDelete(BaseModel):
    files: list[str] = Field(default_factory=list, max_length=5000)


@router.post("/api/files/bulk-delete")
async def files_bulk_delete(body: BulkDelete):
    """Several files at once. Any of them not yours to delete, and none is."""
    docs = [d async for d in _db()[files.COLL].find({"_id": {"$in": body.files}}, {"by": 1, "name": 1})]
    if any(not _may_remove(d) for d in docs):
        raise _refused()
    for d in docs:
        await files.remove(_db(), d["_id"])
    if docs:
        await actors.audit(_db(), "delete", f"{len(docs)} file(s): " + ", ".join(d["name"] for d in docs)[:300],
                           {"ids": [d["_id"] for d in docs]})
    return {"deleted": [d["_id"] for d in docs]}


@router.get("/api/files/zip")
async def files_zip(request: Request, folders: str = ""):
    """Files and folders as one ZIP; a folder keeps its folders inside."""
    db = _db()
    ids = [x for x in (request.query_params.get("files") or "").split(",") if x]
    fids = [x for x in folders.split(",") if x]
    entries: list[tuple[str, dict]] = []
    if ids:
        async for d in db[files.COLL].find({"_id": {"$in": ids}}):
            entries.append((d["name"], d))
    by_id: dict = {}
    if fids:
        every = await files.all_folders(db)
        by_id = {f["_id"]: f for f in every}
        for fid in fids:
            top = by_id.get(fid)
            if not top:
                raise HTTPException(404, f"no folder {fid!r}")
            cut = len(top["path"]) - len(top["name"])
            under = files._subtree(every, fid)
            async for d in db[files.COLL].find({"folder": {"$in": list(under)}}):
                entries.append((f"{by_id[d['folder']]['path'][cut:]}/{d['name']}", d))
    if not entries:
        raise HTTPException(404, "nothing to download")
    if sum(d.get("bytes", 0) for _, d in entries) > ZIP_MAX:
        raise HTTPException(413, f"more than {ZIP_MAX // 2 ** 30} GB - download fewer at a time")
    fh = tempfile.SpooledTemporaryFile(max_size=64 * 1024 * 1024)
    await files.write_zip(db, entries, fh)
    size = fh.tell()
    fh.seek(0)
    name = (by_id[fids[0]]["name"] if len(fids) == 1 and not ids else
            f"files-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M')}") + ".zip"

    def body():
        try:
            while piece := fh.read(1 << 20):
                yield piece
        finally:
            fh.close()
    return StreamingResponse(body(), media_type="application/zip",
                             headers={"Content-Disposition": _disposition("attachment", name),
                                      "Content-Length": str(size)})


# ---------------------------------------------------------------- the files

@router.get("/api/files")
async def files_list(q: str = "", kind: str = "", board: str = "", folder: str | None = None):
    out = [file_out(d) for d in await files.listing(_db(), q=q, kind=kind, board=board, folder=folder)]
    # Which 3D files have a picture already, so the grid asks only for those.
    want = {files.solid_key(f["sha256"]) for f in out if _solid(f) and f.get("sha256")}
    if want:
        have = {d["_id"] async for d in _db()[files.SOLID_THUMBS].find({"_id": {"$in": list(want)}}, {"_id": 1})}
        for f in out:
            if _solid(f) and f.get("sha256") and files.solid_key(f["sha256"]) in have:
                # a tag for its address: a new picture of it is a new address
                f["has_thumb"] = f"{f['sha256'][:12]}.{files.SOLID_VERSION}"
    return out


def _solid(f: dict) -> bool:
    """A file the page draws a 3D picture of: a STEP, or a mesh it reads."""
    return f.get("preview") in ("step", "mesh")


@router.post("/api/files")
async def files_upload(upload: list[UploadFile] = File(...), context: str = Form(""), note: str = Form(""),
                       folder: str = Form("")):
    """One or more files, kept as they came. `context` is JSON - the room and
    the board or model open there - and comes along with each; `folder` is
    where they go ("" the top)."""
    from .main import ActivityIn, push_activity
    try:
        raw = json.loads(context) if context else {}
    except ValueError:
        raw = {}
    ctx = {k: str(v)[:200] for k, v in (raw if isinstance(raw, dict) else {}).items()
           if k in ("room", "model", "board") and v}
    if folder and not await _db()[files.FOLDERS].find_one({"_id": folder}, {"_id": 1}):
        raise HTTPException(404, f"no folder {folder!r}")
    out = []
    for f in upload:
        # Read it in pieces, so a file over the limit is refused before all
        # of it sits in memory.
        chunks, size = [], 0
        while chunk := await f.read(1 << 20):
            size += len(chunk)
            if size > files.MAX_BYTES:
                raise HTTPException(413, f"{f.filename}: larger than {files.MAX_BYTES // (1024 * 1024)} MB")
            chunks.append(chunk)
        try:
            doc = await files.put(_db(), f.filename or "file", b"".join(chunks), f.content_type,
                                  ctx, actors.current(), note, folder=folder)
        except ValueError as exc:
            raise HTTPException(400, f"{f.filename}: {exc}") from exc
        out.append(file_out(doc))
    names = ", ".join(d["name"] for d in out)
    await push_activity(ActivityIn(text=f"uploaded {names}"[:500], level="done",
                                   room=ctx.get("room") if ctx.get("room") in ("cad", "pcb") else "cad"))
    return out


async def _doc(fid: str) -> dict:
    doc = await _db()[files.COLL].find_one({"_id": fid}, {"thumb": 0})
    if not doc:
        raise HTTPException(404, fid)
    return doc


@router.get("/api/files/{fid}")
async def files_download(fid: str, request: Request, inline: bool = False):
    """The file: whole, or the range asked for (206) - a video is scrubbed
    and a PDF read a page at a time without fetching all of it first."""
    doc = await _doc(fid)
    size = int(doc.get("bytes") or 0)
    headers = {"Content-Disposition": _disposition("inline" if inline else "attachment", doc["name"]),
               "Cache-Control": "private, max-age=3600", "Accept-Ranges": "bytes",
               "X-Content-Type-Options": "nosniff",
               "ETag": f"\"{doc.get('sha256', '')[:32]}\""}
    media = files.inline_type(doc) if inline else files.type_of(doc["name"], doc.get("content_type"))
    if media.split(";")[0] in files.ACTIVE_TYPES or not inline:
        # Nothing it holds may run, and nothing may be fetched from it.
        headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"
    try:
        want = files.parse_range(request.headers.get("range"), size)
    except ValueError:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"})
    first, last = want or (0, size - 1)
    status = 206 if want else 200
    if want:
        headers["Content-Range"] = f"bytes {first}-{last}/{size}"
    headers["Content-Length"] = str(last - first + 1)
    grid = await files.open_stream(_db(), doc)
    return StreamingResponse(files.stream(grid, first, last), status_code=status, media_type=media,
                             headers=headers)


@router.get("/api/files/{fid}/thumb")
async def files_thumb(fid: str, request: Request):
    """A small picture of an image, for the grid; made once and kept. A 3D
    file's is the one a page drew and sent (PUT below), if one has."""
    raw = await _db()[files.COLL].find_one({"_id": fid}, {"thumb": 1, "kind": 1, "name": 1, "bytes": 1,
                                                          "sha256": 1, "content_type": 1})
    if not raw:
        raise HTTPException(404, fid)
    if _solid({"preview": files.preview_of(raw.get("name", ""), raw.get("kind", ""), raw.get("content_type", ""))}):
        key = files.solid_key(raw.get("sha256") or fid)
        tag = f"\"{key}\""
        cache = {"Cache-Control": "private, max-age=604800", "ETag": tag}
        if request.headers.get("if-none-match") == tag:
            return Response(status_code=304, headers=cache)
        pic = await _db()[files.SOLID_THUMBS].find_one({"_id": key})
        if not pic:
            raise HTTPException(404, "no picture of this model yet")
        return Response(bytes(pic["data"]), media_type="image/webp", headers=cache)
    thumb = raw.get("thumb")
    if not thumb:
        if raw.get("kind") != "image" or raw["name"].lower().endswith(".svg") or raw.get("bytes", 0) > 60 * 2 ** 20:
            raise HTTPException(404, "no picture for this file")
        _, data = await files.get(_db(), fid)
        try:
            thumb = files.thumb_of(data)
        except Exception as exc:                       # noqa: BLE001 - any picture Pillow cannot read
            raise HTTPException(415, "the picture could not be read") from exc
        await _db()[files.COLL].update_one({"_id": fid}, {"$set": {"thumb": thumb}})
    return Response(bytes(thumb), media_type="image/webp",
                    headers={"Cache-Control": "private, max-age=86400"})


@router.put("/api/files/{fid}/thumb")
async def files_thumb_put(fid: str, request: Request):
    """A 3D file's picture, drawn by the page that first showed it (the
    server has no GPU to draw one) and kept for everyone after that. The
    first one sent stays: another is answered with the one kept."""
    raw = await _db()[files.COLL].find_one({"_id": fid}, {"name": 1, "kind": 1, "sha256": 1, "content_type": 1})
    if not raw:
        raise HTTPException(404, fid)
    if not _solid({"preview": files.preview_of(raw.get("name", ""), raw.get("kind", ""), raw.get("content_type", ""))}):
        raise HTTPException(415, "only a STEP or a 3D mesh has its picture sent")
    if request.headers.get("content-type", "").split(";")[0].strip() not in ("image/png", "image/webp"):
        raise HTTPException(415, "a PNG or a WebP")
    if int(request.headers.get("content-length") or 0) > files.SOLID_MAX_BYTES:
        raise HTTPException(413, f"larger than {files.SOLID_MAX_BYTES // 1024} kB")
    data = b""
    async for piece in request.stream():
        data += piece
        if len(data) > files.SOLID_MAX_BYTES:
            raise HTTPException(413, f"larger than {files.SOLID_MAX_BYTES // 1024} kB")
    try:
        pic = files.solid_thumb_of(data)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    key = files.solid_key(raw.get("sha256") or fid)
    if await _db()[files.SOLID_THUMBS].find_one({"_id": key}, {"_id": 1}):
        return {"kept": True}
    try:
        await _db()[files.SOLID_THUMBS].insert_one(
            {"_id": key, "data": pic, "sha256": raw.get("sha256") or "", "bytes": len(pic),
             "by": actors.current().get("name") or "",
             "made_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    except DuplicateKeyError:
        return {"kept": True}                       # two pages drew it at once
    return {"kept": False}


@router.get("/api/files/{fid}/table")
async def files_table(fid: str, sheet: int = 0):
    """A CSV, TSV or XLSX as rows of text, for the preview."""
    doc = await _doc(fid)
    if doc.get("bytes", 0) > 50 * 2 ** 20:
        raise HTTPException(413, "too large to show as a table - download it")
    _, data = await files.get(_db(), fid)
    try:
        return files.table_of(doc["name"], data, sheet)
    except ValueError as exc:
        raise HTTPException(415, str(exc)) from exc


@router.get("/api/files/{fid}/entries")
async def files_entries(fid: str):
    """What is inside a ZIP or TAR, without unpacking it."""
    doc = await _doc(fid)
    _, data = await files.get(_db(), fid)
    try:
        return files.entries_of(doc["name"], data)
    except ValueError as exc:
        raise HTTPException(415, str(exc)) from exc


@router.get("/api/files/{fid}/mesh")
async def files_mesh(fid: str, wait: float = 20):
    """A STEP as a GLB, for the 3D preview (backend/filemesh.py). Made the
    first time and kept by content; while it is being made the answer is
    202 with how long it has taken so far, and the page asks again."""
    doc = await _doc(fid)
    if files.preview_of(doc.get("name", ""), doc.get("kind", "")) != "step":
        raise HTTPException(415, "only a STEP is turned into a 3D mesh here")
    try:
        hit = await filemesh.cached(_db(), doc)
        got = hit or await filemesh.mesh(_db(), doc, max(0.0, min(wait, 25.0)))
    except filemesh.Unreadable as exc:
        raise HTTPException(422, str(exc)) from exc
    if got is None:
        return JSONResponse({"state": "preparing", "seconds": filemesh.elapsed(doc)}, status_code=202,
                            headers={"Cache-Control": "no-store"})
    rec, packed = got
    return Response(packed, media_type="model/gltf-binary",
                    headers={"Content-Encoding": "gzip", "Cache-Control": "private, max-age=86400",
                             "X-Mesh-Triangles": str(rec.get("triangles") or ""),
                             "X-Mesh-Seconds": str(rec.get("seconds") or ""),
                             "X-Mesh-Cached": "1" if hit else "0"})


class FilePatch(BaseModel):
    note: str | None = Field(default=None, max_length=2000)
    board: str | None = Field(default=None, max_length=200)
    name: str | None = Field(default=None, max_length=400)


@router.patch("/api/files/{fid}")
async def files_update(fid: str, body: FilePatch):
    try:
        doc = await files.update(_db(), fid, body.note, body.board, body.name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not doc:
        raise HTTPException(404, fid)
    return file_out(doc)


@router.delete("/api/files/{fid}")
async def files_delete(fid: str):
    doc = await _db()[files.COLL].find_one({"_id": fid}, {"by": 1, "name": 1})
    if not doc:
        raise HTTPException(404, fid)
    if not _may_remove(doc):
        raise _refused()
    await files.remove(_db(), fid)
    await actors.audit(_db(), "delete", f"file {doc.get('name')}", {"id": fid})
    return {"deleted": fid}
