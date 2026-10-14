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

from . import access, actors, filemesh, files, files_virtual, pdftext

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


def _read_only(*ids: str) -> None:
    """A read-only folders' entry (backend/files_virtual.py) is not renamed,
    moved or deleted here: 403, with where it is changed."""
    for i in ids:
        if files_virtual.is_virtual(i):
            raise HTTPException(403, files_virtual.refusal(i))


async def _not_parts(files_: list[str] = (), folders: list[str] = ()) -> None:
    """The Parts page's own uploads and folders are changed there (or by the
    Chat's product tools, which check their own rights), the Chat's own in the
    Chat - never from Files: 403."""
    tops = await files_virtual.folder_tops(_db())
    for f in folders:
        if f and tops.get(f, "") in files_virtual.PART_FOLDERS:
            raise HTTPException(403, files_virtual.PARTS_REFUSAL)
        if f and tops.get(f, "") in files_virtual.CHAT_FOLDERS:
            raise HTTPException(403, files_virtual.CHAT_REFUSAL)
    ids = [i for i in files_ if i and not files_virtual.is_virtual(i)]
    if ids:
        async for d in _db()[files.COLL].find({"_id": {"$in": ids}}, {"context": 1, "folder": 1}):
            if files_virtual.parts_owned(d, tops):
                raise HTTPException(403, files_virtual.PARTS_REFUSAL)
            if files_virtual.chat_owned(d, tops):
                raise HTTPException(403, files_virtual.CHAT_REFUSAL)


def _owner_of(d: dict, tops: dict) -> dict:
    """Whose an upload is, for the page: the Parts page's, the Chat's, or one's own (nothing)."""
    if files_virtual.parts_owned(d, tops):
        return {"ro": True, "where": "parts"}
    if files_virtual.chat_owned(d, tops):
        return {"ro": True, "where": "chat"}
    return {}


def _disposition(how: str, name: str) -> str:
    ascii_name = re.sub(r'[^A-Za-z0-9._-]', "_", name)
    return f"{how}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"


# ---------------------------------------------------------------- folders

@router.get("/api/files/folders")
async def folders_list():
    tops = await files_virtual.folder_tops(_db())
    area = {**{k: "parts" for k in files_virtual.PART_FOLDERS}, **{k: "chat" for k in files_virtual.CHAT_FOLDERS}}
    return [{**folder_out(f), **({"ro": True, "where": area[tops[f["_id"]]]} if tops.get(f["_id"]) in area else {})}
            for f in await files.all_folders(_db())]


# ---------------------------------------------------------------- the read-only folders, and how much there is

@router.get("/api/files/virtual")
async def files_virtual_tree():
    """Projects, Chat and Parts as read-only folders (backend/files_virtual.py):
    {folders, files, links} - the Projects' files themselves, and which of
    Files the Chat's and Parts' folders refer to."""
    return await files_virtual.tree(_db())


@router.get("/api/files/usage")
async def files_usage(range: str = "auto"):  # noqa: A002 - the query's name, as Analytics' own
    """How many files and how much data, per area, the largest, and what
    was added in the range: 7d, 30d, 90d, all, or auto (the shortest that
    holds what was added lately)."""
    return await files_virtual.usage(_db(), range if range in ("7d", "30d", "90d", "all") else "auto")


@router.get("/api/files/uses")
async def files_uses(ids: str = ""):
    """What uses each of these files - conversations, products, a model -
    for the delete dialog (at most 500 ids, comma-separated)."""
    want = [i for i in ids.split(",") if i and not files_virtual.is_virtual(i)][:500]
    return await files_virtual.uses(_db(), want) if want else {}


# ---------------------------------------------------------------- the trash

def _trash_out(d: dict) -> dict:
    out = file_out(d)
    for k in ("deleted_at", "deleted_by", "purge_at", "folder_path"):
        out[k] = d.get(k)
    try:
        left = datetime.fromisoformat(d["purge_at"]) - datetime.now(timezone.utc)
        out["days_left"] = max(0, left.days + (1 if left.seconds else 0))
    except (KeyError, TypeError, ValueError):
        out["days_left"] = None
    return out


@router.get("/api/files/trash")
async def files_trash():
    """Files deleted from Files, kept TRASH_DAYS before they are deleted for good."""
    return {"days": files.TRASH_DAYS, "files": [_trash_out(d) for d in await files.trash(_db())]}


class TrashIn(BaseModel):
    files: list[str] = Field(default_factory=list, max_length=5000)


async def _trashed(ids: list[str]) -> list[dict]:
    docs = [d async for d in _db()[files.TRASH].find({"_id": {"$in": ids}}, {"by": 1, "name": 1})]
    if any(not _may_remove(d) for d in docs):
        raise _refused()
    return docs


@router.post("/api/files/trash/restore")
async def files_trash_restore(body: TrashIn):
    """Files back from the trash, into their folders. Yours, or anyone's with the right to delete."""
    back, refused = [], []
    for d in await _trashed(body.files):
        try:
            back.append(file_out(await files.restore(_db(), d["_id"])))
        except (KeyError, files.Clash) as exc:
            refused.append({"id": d["_id"], "name": d.get("name"), "why": str(exc)})
    if back:
        await actors.audit(_db(), "restore", f"{len(back)} file(s): " + ", ".join(f["name"] for f in back)[:300],
                           {"ids": [f["id"] for f in back]})
    return {"restored": back, "refused": refused}


@router.post("/api/files/trash/purge")
async def files_trash_purge(body: TrashIn):
    """Files in the trash, deleted for good now."""
    docs = await _trashed(body.files)
    for d in docs:
        await files.purge(_db(), d["_id"])
    if docs:
        await actors.audit(_db(), "purge", f"{len(docs)} file(s) for good: " + ", ".join(d.get("name") or "" for d in docs)[:300],
                           {"ids": [d["_id"] for d in docs]})
    return {"purged": [d["_id"] for d in docs]}


class FolderIn(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    parent: str = Field(default="", max_length=64)
    # or a whole path, made as far as it is missing (`revisions.py files mkdir`)
    path: str | None = Field(default=None, max_length=1000)


@router.post("/api/files/folders")
async def folders_make(body: FolderIn):
    _read_only(body.parent)
    await _not_parts(folders=[body.parent])
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
    _read_only(fid)
    await _not_parts(folders=[fid])
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
    _read_only(fid)
    await _not_parts(folders=[fid])
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
    _read_only(*body.files, *body.folders, body.to)
    await _not_parts(body.files, [*body.folders, body.to])
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
    _read_only(*body.files)
    await _not_parts(body.files)
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
    for v in [x for x in ids if files_virtual.is_virtual(x)]:
        try:
            d = await files_virtual.doc(db, v)
        except KeyError as exc:
            raise HTTPException(404, f"no file {v!r}") from exc
        entries.append((d["name"], d))
    vfolders = [x for x in fids if files_virtual.is_virtual(x)]
    fids = [x for x in fids if not files_virtual.is_virtual(x)]
    if vfolders:
        entries += await _virtual_entries(db, vfolders)
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
    name = (by_id[fids[0]]["name"] if len(fids) == 1 and not ids and not vfolders else
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


async def _virtual_entries(db, roots: list[str]) -> list[tuple[str, dict]]:
    """A read-only folder's files for a ZIP, by their path under it: the
    Projects' own (read where they are kept) and the uploads the Chat's and
    Parts' folders refer to."""
    t = await files_virtual.tree(db)
    by_id = {d["id"]: d for d in t["folders"]}
    kids: dict[str, list[str]] = {}
    for d in t["folders"]:
        kids.setdefault(d["parent"], []).append(d["id"])
    out: list[tuple[str, dict]] = []
    for root in roots:
        if root not in by_id:
            raise HTTPException(404, f"no folder {root!r}")
        rel: dict[str, str] = {root: by_id[root]["name"]}
        todo = [root]
        while todo:
            at = todo.pop()
            for k in kids.get(at, []):
                if k not in rel:
                    rel[k] = f"{rel[at]}/{by_id[k]['name']}"
                    todo.append(k)
        for f in t["files"]:
            if f["folder"] in rel:
                out.append((f"{rel[f['folder']]}/{f['name']}", await files_virtual.doc(db, f["id"])))
        linked = [x for x in t["links"] if x["folder"] in rel]
        docs = {d["_id"]: d async for d in db[files.COLL].find({"_id": {"$in": [x["file"] for x in linked]}})}
        out += [(f"{rel[x['folder']]}/{docs[x['file']]['name']}", docs[x["file"]]) for x in linked if x["file"] in docs]
    return out


# ---------------------------------------------------------------- the files

@router.get("/api/files")
async def files_list(q: str = "", kind: str = "", board: str = "", folder: str | None = None):
    tops = await files_virtual.folder_tops(_db())
    out = [{**file_out(d), **_owner_of(d, tops)} for d in await files.listing(_db(), q=q, kind=kind, board=board, folder=folder)]
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
                       folder: str = Form(""), folder_path: str = Form("")):
    """One or more files, kept as they came. `context` is JSON - the room and
    the board or model open there - and comes along with each; `folder` is
    where they go ("" the top). `folder_path` names it by its path instead,
    made if missing - the Chat composer's pictures go to "Chat"."""
    from .main import ActivityIn, push_activity
    try:
        raw = json.loads(context) if context else {}
    except ValueError:
        raw = {}
    ctx = {k: str(v)[:200] for k, v in (raw if isinstance(raw, dict) else {}).items()
           if k in ("room", "model", "board") and v}
    if folder_path and not folder:
        try:
            folder = (await files.make_path(_db(), folder_path, actors.current()))["_id"]
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    _read_only(folder)
    # The Chat's composer puts what is sent in a line into the Chat folder: that stays open.
    if (await files_virtual.folder_tops(_db())).get(folder, "") in files_virtual.PART_FOLDERS:
        raise HTTPException(403, files_virtual.PARTS_REFUSAL)
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
    if files_virtual.is_virtual(fid):
        try:
            return await files_virtual.doc(_db(), fid)
        except KeyError as exc:
            raise HTTPException(404, fid) from exc
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


@router.get("/api/files/{fid}/info")
async def files_info(fid: str):
    """One file's details without its bytes, with its folder's path - what
    the Chat's file viewer shows above a file it opens (rooms/file-modal.ts)."""
    out = file_out(await _doc(fid))
    if files_virtual.is_virtual(fid):
        dirs, _ = await files_virtual.projects(_db())
        by_id = {d["id"]: d for d in dirs}
        names, at = [], by_id.get(out["folder"])
        while at and len(names) < 40:
            names.insert(0, at["name"])
            at = by_id.get(at["parent"])
        out["folder_path"] = "/".join(["Projects", *names])
        return out
    folder = await _db()[files.FOLDERS].find_one({"_id": out["folder"]}) if out["folder"] else None
    out["folder_path"] = (folder or {}).get("path") or ""
    return out


@router.get("/api/files/{fid}/thumb")
async def files_thumb(fid: str, request: Request):
    """A small picture of an image, for the grid; made once and kept. A 3D
    file's is the one a page drew and sent (PUT below), if one has."""
    raw = await _row(fid, {"thumb": 1, "kind": 1, "name": 1, "bytes": 1, "sha256": 1, "content_type": 1})
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
    if not thumb and files_virtual.is_virtual(fid):
        raise HTTPException(404, "no picture for this file")
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


async def _row(fid: str, fields: dict) -> dict:
    """A file's record without its bytes - an upload's, or a read-only folders' file's."""
    if files_virtual.is_virtual(fid):
        try:
            return await files_virtual.doc(_db(), fid, data=False)
        except KeyError as exc:
            raise HTTPException(404, fid) from exc
    raw = await _db()[files.COLL].find_one({"_id": fid}, fields)
    if not raw:
        raise HTTPException(404, fid)
    return raw


@router.put("/api/files/{fid}/thumb")
async def files_thumb_put(fid: str, request: Request):
    """A 3D file's picture, drawn by the page that first showed it (the
    server has no GPU to draw one) and kept for everyone after that. The
    first one sent stays: another is answered with the one kept."""
    raw = await _row(fid, {"name": 1, "kind": 1, "sha256": 1, "content_type": 1})
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


async def _pdf_of(fid: str) -> tuple[dict, bytes]:
    """A Files upload's bytes, when it is a PDF (backend/pdftext.py)."""
    doc = await _doc(fid)
    if int(doc.get("bytes") or 0) > pdftext.MAX_BYTES:
        raise HTTPException(413, f"over {pdftext.MAX_BYTES // 2 ** 20} MB - too large to read here")
    _, data = await files.get(_db(), fid)
    if not pdftext.is_pdf(data):
        raise HTTPException(415, f"{doc.get('name', fid)} is not a PDF")
    return doc, data


async def pdf_text_response(data: bytes, pages: str | None) -> dict:
    """{count, pages: [{n, text}]} for a PDF's bytes; 422 when it cannot be read."""
    import asyncio
    try:
        return await asyncio.to_thread(pdftext.text, data, pages)
    except pdftext.PdfError as exc:
        raise HTTPException(422, str(exc)) from exc


async def pdf_page_response(data: bytes, n: int, dpi: float, name: str) -> Response:
    """One page of a PDF as a PNG; 404 for a page it does not have."""
    import asyncio
    try:
        png, meta = await asyncio.to_thread(pdftext.render_png, data, n, dpi)
    except pdftext.PdfError as exc:
        raise HTTPException(404 if str(exc).startswith("no page") else 422, str(exc)) from exc
    stem = re.sub(r"\.pdf$", "", name, flags=re.I)
    return Response(png, media_type="image/png", headers={
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": _disposition("inline", f"{stem}-p{n}.png"),
        "X-Pdf-Pages": str(meta["count"]), "X-Pdf-Dpi": str(meta["dpi"]),
        "X-Pdf-Size": f"{meta['width']}x{meta['height']}"})


@router.get("/api/files/{fid}/pdf")
async def files_pdf_text(fid: str, pages: str | None = None):
    """A PDF's text a page at a time - `pages` like 1-3, 2 or 1,4,7-9
    (default: from the first, at most pdftext.MAX_PAGES). For agents
    reading a datasheet someone uploaded; a drawing or a table wants the
    page as a picture (below)."""
    doc, data = await _pdf_of(fid)
    out = await pdf_text_response(data, pages)
    return {"id": fid, "name": doc.get("name"), **out}


@router.get("/api/files/{fid}/pdf/page/{n}.png")
async def files_pdf_page(fid: str, n: int, dpi: float = 150):
    """Page n (from 1) of a PDF as a PNG, at `dpi` (36-300; smaller when the
    longer side would pass 4000 px)."""
    doc, data = await _pdf_of(fid)
    return await pdf_page_response(data, n, dpi, doc.get("name") or fid)


class FilePatch(BaseModel):
    note: str | None = Field(default=None, max_length=2000)
    board: str | None = Field(default=None, max_length=200)
    name: str | None = Field(default=None, max_length=400)


@router.patch("/api/files/{fid}")
async def files_update(fid: str, body: FilePatch):
    _read_only(fid)
    await _not_parts([fid])
    try:
        doc = await files.update(_db(), fid, body.note, body.board, body.name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not doc:
        raise HTTPException(404, fid)
    return file_out(doc)


@router.delete("/api/files/{fid}")
async def files_delete(fid: str):
    _read_only(fid)
    await _not_parts([fid])
    doc = await _db()[files.COLL].find_one({"_id": fid}, {"by": 1, "name": 1})
    if not doc:
        raise HTTPException(404, fid)
    if not _may_remove(doc):
        raise _refused()
    await files.remove(_db(), fid)
    await actors.audit(_db(), "delete", f"file {doc.get('name')}", {"id": fid})
    return {"deleted": fid}
