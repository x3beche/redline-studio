"""The Firmware room's API (backend/firmware.py, backend/fwbuild.py).

    GET    /api/firmware                       every firmware (?board=)
    POST   /api/boards/{bid}/firmware          {mcu: "U2"} -> made from that MCU (201), or the one there is
    GET    /api/boards/{bid}/firmware          the board's firmwares
    GET    /api/firmware/{fid}                 the record, its pins now, its last build
    DELETE /api/firmware/{fid}
    GET    /api/firmware/{fid}/files           the tree (?version=)
    GET    /api/firmware/{fid}/files/{path}    one file's text (?version=)
    POST   /api/firmware/{fid}/files           {files: {path: text | null}, note} -> a new version
    GET    /api/firmware/{fid}/versions
    GET    /api/firmware/{fid}/diff            ?a=&b= two versions (default: the last two), file by file
    POST   /api/firmware/{fid}/pins            pins.h from the board again, now
    POST   /api/firmware/{fid}/build           start a build (202); 409 while one runs
    GET    /api/firmware/{fid}/builds          the last builds
    GET    /api/firmware/{fid}/log             the last build's lines, as the room's log band reads them
    GET    /api/firmware/{fid}/builds/{job}    one build, with its lines
    GET    /api/firmware/{fid}/download/{name} firmware.bin / .elf, bootloader.bin, partitions.bin,
                                               boot_app0.bin of the last good build (?build= that build's job)
    GET    /api/firmware/{fid}/flash-manifest  what flashing writes: [{name, offset, url, size, sha256, md5}];
                                               409 {reason, detail} if the last build is not one to flash
    GET    /api/firmware/{fid}/flashes         the last flashes
    POST   /api/firmware/{fid}/flashes         {build_job, chip, mac, ok, secs}: a flash (ok null: it started)
    POST   /api/firmware/{fid}/flashes/{id}    {ok, chip, mac, secs, error}: how a started flash ended
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from . import actors, firmware, flashing, fwbuild, store

router = APIRouter()


def _db():
    from .main import db
    return db()


def _who() -> dict | None:
    try:
        return actors.current()
    except Exception:                                            # noqa: BLE001 - nobody in particular
        return None


async def _fw(fid: str) -> dict:
    try:
        return await firmware.get(_db(), fid)
    except KeyError:
        raise HTTPException(404, f"no firmware {fid}")


class NewFirmware(BaseModel):
    mcu: str = Field(min_length=1, max_length=40)


class Save(BaseModel):
    files: dict[str, str | None]
    note: str = ""
    # The version the change was written against: refused if it moved on.
    base: int | None = None


@router.get("/api/firmware")
async def list_firmware(board: str | None = None):
    return await firmware.listing(_db(), board)


@router.get("/api/boards/{bid}/firmware")
async def board_firmware(bid: str):
    return await firmware.listing(_db(), bid)


@router.post("/api/boards/{bid}/firmware")
async def make_firmware(bid: str, body: NewFirmware, response: Response):
    try:
        fw, made = await firmware.create(_db(), bid, body.mcu.strip(), by=_who())
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'\""))
    except firmware.Refused as exc:
        raise HTTPException(422, str(exc))
    response.status_code = 201 if made else 200
    return {**firmware.view(fw), "made": made}


@router.get("/api/firmware/{fid}")
async def one_firmware(fid: str):
    fw = await _fw(fid)
    pins = await firmware.pins_now(_db(), fw)
    return {**firmware.view(fw), **{k: v for k, v in pins.items() if k != "board_version"},
            "board_now": pins["board_version"]}


@router.delete("/api/firmware/{fid}")
async def drop_firmware(fid: str):
    if not await firmware.remove(_db(), fid):
        raise HTTPException(404, f"no firmware {fid}")
    return {"deleted": fid}


@router.get("/api/firmware/{fid}/files")
async def firmware_files(fid: str, version: int | None = None):
    await _fw(fid)
    return await firmware.tree(_db(), fid, version)


@router.get("/api/firmware/{fid}/files/{path:path}")
async def firmware_file(fid: str, path: str, version: int | None = None):
    await _fw(fid)
    try:
        return await firmware.read(_db(), fid, path, version)
    except firmware.Refused as exc:
        raise HTTPException(422, str(exc))
    except KeyError:
        raise HTTPException(404, f"no file {path}")


@router.post("/api/firmware/{fid}/files")
async def save_files(fid: str, body: Save):
    fw = await _fw(fid)
    if body.base is not None and body.base != (fw.get("version") or 0):
        raise HTTPException(409, f"the firmware is at v{fw.get('version')}, not v{body.base} - read it again")
    try:
        return await firmware.save(_db(), fid, body.files, note=body.note, by=_who())
    except firmware.Refused as exc:
        raise HTTPException(422 if "generated" in str(exc) or "path" in str(exc) else 409, str(exc))


@router.get("/api/firmware/{fid}/versions")
async def firmware_versions(fid: str):
    await _fw(fid)
    return await firmware.versions(_db(), fid)


@router.get("/api/firmware/{fid}/diff")
async def firmware_diff(fid: str, a: int | None = None, b: int | None = None):
    """What changed between two versions, as unified diffs (backend/fwnotes.py)."""
    from . import fwnotes
    await _fw(fid)
    try:
        return await fwnotes.diff(_db(), fid, a, b)
    except fwnotes.Refused as exc:
        raise HTTPException(422, str(exc))


async def _start(fid: str, why: str | None) -> dict:
    try:
        job = await fwbuild.start(_db(), fid, by=_who(), why=why)
    except fwbuild.Busy as exc:
        raise HTTPException(409, {"detail": str(exc), "job": exc.job.get("_id")})
    except KeyError:
        raise HTTPException(404, f"no firmware {fid}")
    return fwbuild.view(job)


@router.post("/api/firmware/{fid}/pins")
async def regenerate_pins(fid: str, build: bool = True):
    fw = await _fw(fid)

    async def go(f, why):
        await _start(f, why)

    change = await firmware.regenerate(_db(), fw, start_build=go if build else None)
    return {"changed": bool(change), "change": change}


@router.post("/api/firmware/{fid}/build", status_code=202)
async def build_firmware(fid: str):
    await _fw(fid)
    return await _start(fid, "asked for")


@router.get("/api/firmware/{fid}/builds")
async def firmware_builds(fid: str, limit: int = 10):
    d = _db()
    return await fwbuild.latest(d.raw, fid, d.workspace, min(limit, 50))


async def _job(fid: str, job_id: str) -> dict:
    d = _db()
    job = await fwbuild.get(d.raw, job_id)
    if not job or job.get("firmware") != fid or job.get("workspace") != d.workspace:
        raise HTTPException(404, f"no build {job_id}")
    return job


@router.get("/api/firmware/{fid}/builds/{job_id}")
async def firmware_build(fid: str, job_id: str):
    return fwbuild.view(await _job(fid, job_id), lines=True)


@router.get("/api/firmware/{fid}/log")
async def firmware_log(fid: str):
    fw = await _fw(fid)
    jid = (fw.get("build") or {}).get("job")
    if not jid:
        return []
    d = _db()
    job = await fwbuild.get(d.raw, jid)
    if not job or job.get("workspace") != d.workspace:
        return []
    return job.get("lines") or []


@router.get("/api/firmware/{fid}/download/{name}")
async def download(fid: str, name: str, build: str | None = None):
    if name not in fwbuild.KEPT:
        raise HTTPException(404, name)
    fw = await _fw(fid)
    meta = ((fw.get("build") or {}).get("artifacts") or {}).get(name)
    if not meta:
        raise HTTPException(404, f"no {name} yet - build it first")
    # Flashing asks for one build's files: never half of one and half of the next.
    if build and build != (fw.get("build") or {}).get("job"):
        raise HTTPException(409, f"{name}: build {build} is no longer the last one - read the manifest again")
    from bson import ObjectId
    stream = await store.bucket(_db(), firmware.BUCKET).open_download_stream(ObjectId(meta["gridfs_id"]))
    data = await stream.read()
    stem = f"{fw.get('board')}-{fw.get('mcu')}-v{(fw.get('build') or {}).get('artifacts_version', '')}"
    return Response(data, media_type="application/octet-stream", headers={
        "Content-Disposition": f'attachment; filename="{stem}-{name}"'})


# ---------------------------------------------------------------- flashing (backend/flashing.py)

class Flash(BaseModel):
    build_job: str | None = Field(default=None, max_length=64)
    chip: str | None = Field(default=None, max_length=80)
    # The page sends the last three bytes (or a hash); anything longer is cut.
    mac: str | None = Field(default=None, max_length=80)
    ok: bool | None = None
    secs: float | None = None
    baud: int | None = None
    error: str | None = Field(default=None, max_length=2000)


@router.get("/api/firmware/{fid}/flash-manifest")
async def flash_manifest(fid: str):
    fw = await _fw(fid)
    try:
        return flashing.manifest(fw, await firmware.contents(_db(), fid))
    except flashing.NotReady as exc:
        raise HTTPException(409, {"reason": exc.reason, "detail": exc.text})


@router.get("/api/firmware/{fid}/flashes")
async def firmware_flashes(fid: str, limit: int = 20):
    await _fw(fid)
    return await flashing.listing(_db(), fid, min(max(limit, 1), 100))


@router.post("/api/firmware/{fid}/flashes", status_code=201)
async def record_flash(fid: str, body: Flash):
    fw = await _fw(fid)
    data = body.model_dump()
    try:
        if body.ok is None:
            return await flashing.start(_db(), fw, data, _who())
        return await flashing.finish(_db(), fw, None, data, _who())
    except KeyError:
        raise HTTPException(422, f"no build {body.build_job} of {fid}")


@router.post("/api/firmware/{fid}/flashes/{flash_id}")
async def end_flash(fid: str, flash_id: str, body: Flash):
    fw = await _fw(fid)
    if body.ok is None:
        raise HTTPException(422, "say how it ended: ok true or false")
    try:
        return await flashing.finish(_db(), fw, flash_id, body.model_dump(), _who())
    except KeyError:
        raise HTTPException(404, f"no flash {flash_id}")
