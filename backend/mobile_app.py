"""The Android app, served by the server itself (Settings > Mobile app).

The Workbench mobile app (github.com/x3beche/workbench-mobile) is open
source and holds no secret: it asks for a server's address on its first
start and signs in like the web page. So the APK is handed out to anyone
who asks, without a session - a phone that scans the QR code in Settings is
not signed in anywhere yet:

    GET  /api/public/m/app.apk     the latest build, as workbench-<version>.apk
    GET  /api/public/m/app.json    what it is: version, versionCode, size, sha256, dates, min Android
    POST /api/mobile/apk           a new build (multipart: file, and version / version_code
                                   when the APK's manifest cannot be read) - "settings":
                                   the owner and the admins

The public routes live under auth.OPEN_PREFIX `/api/public/` (access
"none", like shared links) because the site's proxies pass only /api on to
the API. They answer these two names and nothing else: no listing, no other
file of the folder, rate-limited per address.

The builds are files, not database documents: a folder (REDLINE_MOBILE_DIR,
default `<repo>/.mobile`, git-ignored) holding `workbench-<version>.apk`
and `latest.json`. Both are written to a temporary name and renamed, so a
download never sees half a file or a latest.json naming a missing APK. The
last KEEP builds stay; older ones are removed. From a shell:

    python -m backend.mobile_app publish path/to/workbench-1.2.0.apk [--version 1.2.0 --version-code 4]

An upload is checked: a zip, with AndroidManifest.xml and classes.dex, at
most MAX_BYTES. The version, versionCode and minSdkVersion are read from the
binary manifest (a small AXML reader below), the CPU from lib/<abi>/.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import struct
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

from . import ratelimit, shares

ROOT = Path(__file__).resolve().parent.parent
MIME = "application/vnd.android.package-archive"
MAX_BYTES = 150 * 1024 * 1024
KEEP = 3                                  # builds kept on disk, the latest among them
LATEST = "latest.json"
VERSION_RE = re.compile(r"^\d{1,4}(\.\d{1,4}){0,3}([-+][A-Za-z0-9.]{1,20})?$")
NAME_RE = re.compile(r"^workbench-(.+)\.apk$")
# The public answers: as shared links', and a build kept by browsers only
# while it is still the latest (revalidated with its ETag).
PUBLIC = {**shares.PUBLIC, "Cache-Control": "no-cache"}

# Per address: the description is cheap; the APK is ~40 MB, so fewer.
# Counted in the database (backend/ratelimit.py), like shared links'.
JSON_HITS = ratelimit.Window("apk-json", 120, 60)
APK_HITS = ratelimit.Window("apk-file", 20, 600)

# minSdkVersion -> the Android release it is.
ANDROID = {21: "5.0", 22: "5.1", 23: "6.0", 24: "7.0", 25: "7.1", 26: "8.0", 27: "8.1", 28: "9",
           29: "10", 30: "11", 31: "12", 32: "12L", 33: "13", 34: "14", 35: "15", 36: "16"}

router = APIRouter()


def folder() -> Path:
    return Path(os.environ.get("REDLINE_MOBILE_DIR") or ROOT / ".mobile")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# ---------------------------------------------------------------- reading the APK

def _strings(buf: bytes, at: int) -> list[str]:
    """The string pool chunk at `at` of a binary XML."""
    _, head, _size, count, _styles, flags, start, _ = struct.unpack_from("<HHIIIIII", buf, at)
    utf8 = bool(flags & 0x100)
    offs = struct.unpack_from(f"<{count}I", buf, at + head)
    out = []
    for o in offs:
        p = at + start + o
        if utf8:
            n = buf[p]                                          # UTF-16 length, then UTF-8 length
            p += 2 if n & 0x80 else 1
            n = buf[p]
            if n & 0x80:
                n = ((n & 0x7F) << 8) | buf[p + 1]
                p += 2
            else:
                p += 1
            out.append(buf[p:p + n].decode("utf-8", "replace"))
        else:
            n = struct.unpack_from("<H", buf, p)[0]
            p += 2
            if n & 0x8000:
                n = ((n & 0x7FFF) << 16) | struct.unpack_from("<H", buf, p)[0]
                p += 2
            out.append(buf[p:p + 2 * n].decode("utf-16-le", "replace"))
    return out


# The android: attributes by resource id, for a manifest whose names were stripped.
_IDS = {0x0101021B: "versionCode", 0x0101021C: "versionName", 0x0101020C: "minSdkVersion",
        0x01010270: "targetSdkVersion"}


def read_manifest(buf: bytes) -> dict:
    """versionName, versionCode, minSdkVersion and package from a compiled
    AndroidManifest.xml. Whatever cannot be read is left out."""
    out: dict = {}
    if len(buf) < 8 or struct.unpack_from("<H", buf, 0)[0] != 0x0003:
        return out
    strings: list[str] = []
    ids: list[int] = []
    p = struct.unpack_from("<H", buf, 2)[0]
    end = min(len(buf), struct.unpack_from("<I", buf, 4)[0])
    while p + 8 <= end:
        kind, head, size = struct.unpack_from("<HHI", buf, p)
        if size < 8:
            break
        if kind == 0x0001:
            strings = _strings(buf, p)
        elif kind == 0x0180:
            ids = list(struct.unpack_from(f"<{(size - head) // 4}I", buf, p + head))
        elif kind == 0x0102:                                       # an element starts
            name_i = struct.unpack_from("<I", buf, p + 20)[0]
            a_start, a_size, a_count = struct.unpack_from("<HHH", buf, p + 24)
            tag = strings[name_i] if name_i < len(strings) else ""
            if tag in ("manifest", "uses-sdk"):
                for i in range(a_count):
                    q = p + 16 + a_start + i * a_size
                    _ns, an, raw, _vs, _r, vtype, data = struct.unpack_from("<IIIHBBI", buf, q)
                    aname = (strings[an] if an < len(strings) else "") or _IDS.get(ids[an] if an < len(ids) else 0, "")
                    if aname not in ("versionName", "versionCode", "minSdkVersion", "package"):
                        continue
                    if vtype == 0x03 or (raw != 0xFFFFFFFF and raw < len(strings)):
                        val: object = strings[raw] if raw < len(strings) else None
                    elif vtype in (0x10, 0x11):
                        val = data
                    else:
                        continue
                    if val is not None:
                        out[aname] = val
        p += size
    if "versionCode" in out:
        try:
            out["versionCode"] = int(out["versionCode"])
        except (TypeError, ValueError):
            out.pop("versionCode")
    if "minSdkVersion" in out:
        try:
            out["minSdkVersion"] = int(out["minSdkVersion"])
        except (TypeError, ValueError):
            out.pop("minSdkVersion")
    return out


def inspect(path: Path) -> dict:
    """What an APK is, or ValueError saying why it is not one."""
    if not zipfile.is_zipfile(path):
        raise ValueError("that is not an APK (not a zip file)")
    try:
        with zipfile.ZipFile(path) as z:
            names = set(z.namelist())
            if "AndroidManifest.xml" not in names or not any(re.match(r"^classes\d*\.dex$", n) for n in names):
                raise ValueError("that is not an APK (no AndroidManifest.xml and classes.dex)")
            man = read_manifest(z.read("AndroidManifest.xml"))
    except (zipfile.BadZipFile, OSError, struct.error, IndexError) as exc:
        raise ValueError(f"the APK could not be read: {exc}") from exc
    abis = sorted({n.split("/")[1] for n in names if n.startswith("lib/") and n.count("/") >= 2})
    return {"version": man.get("versionName"), "version_code": man.get("versionCode"),
            "min_sdk": man.get("minSdkVersion"), "package": man.get("package"), "abis": abis}


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# ---------------------------------------------------------------- the folder

def latest() -> dict | None:
    """latest.json, when it names an APK that is there."""
    try:
        info = json.loads((folder() / LATEST).read_text())
    except (OSError, ValueError):
        return None
    name = info.get("file") if isinstance(info, dict) else None
    if not isinstance(name, str) or not NAME_RE.match(name) or "/" in name or not (folder() / name).is_file():
        return None
    return info


def _write_json(path: Path, data: dict) -> None:
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    os.replace(tmp, path)


def publish(src: Path, *, version: str | None = None, version_code: int | None = None,
            built_at: str | None = None, move: bool = False) -> dict:
    """Make `src` the latest build: checked, copied (or moved) to
    workbench-<version>.apk, then latest.json; older builds past KEEP go.
    ValueError when the file is not a usable APK."""
    size = src.stat().st_size
    if size > MAX_BYTES:
        raise ValueError(f"at most {MAX_BYTES // (1024 * 1024)} MB")
    got = inspect(src)
    ver = got["version"] or (version or "").strip() or None
    code = got["version_code"] if got["version_code"] is not None else version_code
    if version and got["version"] and version.strip() != got["version"]:
        raise ValueError(f"the APK says it is version {got['version']}, not {version.strip()}")
    if not ver:
        raise ValueError("the APK does not say its version: give it in the form")
    if not VERSION_RE.match(ver):
        raise ValueError(f"{ver!r} is not a version like 1.2.0")
    if code is not None and (not isinstance(code, int) or code < 0):
        raise ValueError("versionCode is a whole number")
    d = folder()
    d.mkdir(parents=True, exist_ok=True)
    name = f"workbench-{ver}.apk"
    tmp = d / f".{name}.{secrets.token_hex(4)}"
    try:
        if move:
            os.replace(src, tmp)
        else:
            with open(src, "rb") as a, open(tmp, "wb") as b:
                for block in iter(lambda: a.read(1 << 20), b""):
                    b.write(block)
        digest = sha256_of(tmp)
        os.replace(tmp, d / name)
    finally:
        tmp.unlink(missing_ok=True)
    sdk = got["min_sdk"]
    info = {"version": ver, "versionCode": code, "file": name, "size": size, "sha256": digest,
            "built_at": built_at or now_iso(), "published_at": now_iso(),
            "min_sdk": sdk, "min_android": ANDROID.get(sdk) if sdk else None,
            "abis": got["abis"], "package": got["package"]}
    _write_json(d / LATEST, info)
    # The oldest go, the one just published never.
    kept = sorted((p for p in d.glob("workbench-*.apk") if p.name != name), key=lambda p: p.stat().st_mtime,
                  reverse=True)
    for old in kept[KEEP - 1:]:
        old.unlink(missing_ok=True)
    return info


# ---------------------------------------------------------------- the public routes

async def _limit(window: ratelimit.Window, request: Request) -> None:
    ok, wait = await window.hit(shares._db(), shares.client(request))
    if not ok:
        raise HTTPException(429, "too many requests - wait a few minutes",
                            headers={**PUBLIC, "Retry-After": str(wait)})


def _none() -> HTTPException:
    return HTTPException(404, "no Android build is published on this server", headers=PUBLIC)


def public_info(info: dict) -> dict:
    return {**{k: info.get(k) for k in ("version", "versionCode", "size", "sha256", "built_at", "published_at",
                                        "min_sdk", "min_android", "abis", "file")},
            "url": "/api/public/m/app.apk"}


@router.get("/api/public/m/app.json")
async def app_json(request: Request):
    """What the latest build is; 404 when none was published."""
    await _limit(JSON_HITS, request)
    info = latest()
    if not info:
        raise _none()
    return JSONResponse(public_info(info), headers=PUBLIC)


@router.api_route("/api/public/m/app.apk", methods=["GET", "HEAD"])
async def app_apk(request: Request):
    """The latest build, to install: an attachment named by its version."""
    await _limit(APK_HITS, request)
    info = latest()
    if not info:
        raise _none()
    etag = f'"{info["sha256"]}"'
    if etag in [t.strip() for t in request.headers.get("if-none-match", "").split(",")]:
        return Response(status_code=304, headers={**PUBLIC, "ETag": etag})
    name = info["file"]
    return FileResponse(folder() / name, media_type=MIME, filename=name,
                        headers={**PUBLIC, "ETag": etag})


# ---------------------------------------------------------------- uploading a build

@router.post("/api/mobile/apk")
async def upload_apk(request: Request, file: UploadFile = File(...), version: str = Form(""),
                     version_code: str = Form("")):
    """A new build from Settings: checked, then the latest. The owner and the
    admins ("settings", backend/access.py)."""
    if int(request.headers.get("content-length") or 0) > MAX_BYTES + (1 << 20):
        raise HTTPException(413, f"at most {MAX_BYTES // (1024 * 1024)} MB")
    code = None
    if version_code.strip():
        if not version_code.strip().isdigit():
            raise HTTPException(400, "versionCode is a whole number")
        code = int(version_code.strip())
    d = folder()
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / f".upload-{secrets.token_hex(6)}"
    size = 0
    try:
        with open(tmp, "wb") as out:
            while block := await file.read(1 << 20):
                size += len(block)
                if size > MAX_BYTES:
                    raise HTTPException(413, f"at most {MAX_BYTES // (1024 * 1024)} MB")
                out.write(block)
        if not size:
            raise HTTPException(400, "the file is empty")
        try:
            info = publish(tmp, version=version.strip() or None, version_code=code, move=True)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    finally:
        tmp.unlink(missing_ok=True)
    from .admin import _audit
    await _audit("mobile-apk", info["file"], {"version": info["version"], "versionCode": info["versionCode"],
                                              "size": info["size"], "sha256": info["sha256"]})
    return public_info(info)


# ---------------------------------------------------------------- from a shell

def main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="python -m backend.mobile_app")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("publish", help="make an APK the latest build")
    p.add_argument("apk", type=Path)
    p.add_argument("--version")
    p.add_argument("--version-code", type=int)
    sub.add_parser("show", help="print latest.json")
    a = ap.parse_args(argv)
    if a.cmd == "show":
        print(json.dumps(latest(), indent=2))
        return 0
    built = datetime.fromtimestamp(a.apk.stat().st_mtime, timezone.utc).replace(microsecond=0).isoformat()
    try:
        info = publish(a.apk, version=a.version, version_code=a.version_code, built_at=built)
    except ValueError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(info, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
