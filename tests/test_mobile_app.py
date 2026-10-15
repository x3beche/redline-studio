"""The Android app, served by the server (backend/mobile_app.py).

Sign-in is on; the database is test_telegram's fake, the builds folder a
temporary one. What is checked: the two public routes answer without a
session and name nothing else, their headers, 404 with no build; who may
upload one, what is refused, that latest.json and the APK change together,
the audit line; and the manifest reader on a made-up and on the real APK."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import struct
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import actors, auth, mobile_app, scope
from test_telegram import FakeDb

REAL = Path("/home/x3/projects/workbench-mobile/build-out/workbench-1.1.0.apk")


def run(c):
    return asyncio.run(c)


# ---------------------------------------------------------------- a made-up APK

def axml(version_name: str | None, version_code: int, min_sdk: int = 24, strip_names: bool = False) -> bytes:
    """A compiled AndroidManifest.xml: <manifest versionCode versionName
    package><uses-sdk minSdkVersion/></manifest>, with UTF-16 strings and a
    resource map; `strip_names` blanks the attribute names (as shrinkers
    do), leaving only their resource ids."""
    names = ["versionCode", "versionName", "minSdkVersion", "package", "manifest", "uses-sdk",
             version_name or "", "dev.workbench.mobile"]
    if strip_names:
        names[0] = names[1] = names[2] = ""
    pool = b""
    offs = []
    for s in names:
        offs.append(len(pool))
        pool += struct.pack("<H", len(s)) + s.encode("utf-16-le") + b"\x00\x00"
    pool += b"\x00" * (-len(pool) % 4)
    head = 28
    start = head + 4 * len(names)
    sp = struct.pack("<HHIIIIII", 0x0001, head, start + len(pool), len(names), 0, 0, start, 0) \
        + struct.pack(f"<{len(names)}I", *offs) + pool
    ids = [0x0101021B, 0x0101021C, 0x0101020C]
    rm = struct.pack("<HHI", 0x0180, 8, 8 + 4 * len(ids)) + struct.pack(f"<{len(ids)}I", *ids)

    def attr(name, raw, vtype, data):
        return struct.pack("<IIIHBBI", 0xFFFFFFFF, name, raw, 8, 0, vtype, data)

    def element(tag, attrs):
        body = struct.pack("<IIHHHHHH", 0xFFFFFFFF, tag, 20, 20, len(attrs), 0, 0, 0) + b"".join(attrs)
        return struct.pack("<HHIII", 0x0102, 16, 16 + len(body), 1, 0xFFFFFFFF) + body

    def end(tag):
        return struct.pack("<HHIIIII", 0x0103, 16, 24, 1, 0xFFFFFFFF, 0xFFFFFFFF, tag)
    man_attrs = [attr(0, 0xFFFFFFFF, 0x10, version_code), attr(3, 7, 0x03, 7)]
    if version_name is not None:
        man_attrs.insert(1, attr(1, 6, 0x03, 6))
    nodes = element(4, man_attrs) + element(5, [attr(2, 0xFFFFFFFF, 0x10, min_sdk)]) + end(5) + end(4)
    body = sp + rm + nodes
    return struct.pack("<HHI", 0x0003, 8, 8 + len(body)) + body


def apk(version_name: str | None = "1.2.0", version_code: int = 4, **kw) -> bytes:
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("AndroidManifest.xml", axml(version_name, version_code, **kw))
        z.writestr("classes.dex", b"dex\n035\x00" + b"\x00" * 64)
        z.writestr("lib/arm64-v8a/libapp.so", b"\x7fELF")
    return b.getvalue()


def test_the_manifest_reader_reads_version_code_and_min_sdk():
    got = mobile_app.read_manifest(axml("1.2.0", 4, 26))
    assert got == {"versionCode": 4, "versionName": "1.2.0", "minSdkVersion": 26, "package": "dev.workbench.mobile"}
    # Names stripped: the resource ids say which attribute is which.
    got = mobile_app.read_manifest(axml("1.2.0", 4, 26, strip_names=True))
    assert got["versionCode"] == 4 and got["versionName"] == "1.2.0" and got["minSdkVersion"] == 26
    assert mobile_app.read_manifest(b"not a manifest") == {}


@pytest.mark.skipif(not REAL.is_file(), reason="the mobile app's build is not on this machine")
def test_the_real_apk_reads():
    got = mobile_app.inspect(REAL)
    assert got == {"version": "1.1.0", "version_code": 3, "min_sdk": 24, "package": "dev.workbench.mobile",
                   "abis": ["arm64-v8a"]}


# ---------------------------------------------------------------- the server

@pytest.fixture
def db(monkeypatch, tmp_path):
    from backend import main
    fake = FakeDb()
    monkeypatch.setattr(main, "db", lambda: scope.ScopedDb(fake, scope.current()))
    monkeypatch.setattr(auth, "enabled", lambda: True)
    monkeypatch.setenv("REDLINE_MOBILE_DIR", str(tmp_path / "mobile"))
    for c in (auth._CACHE, auth._TOKEN_CACHE, auth._USAGE):
        c.clear()
    mobile_app.JSON_HITS.clear()
    mobile_app.APK_HITS.clear()
    now = datetime.now(timezone.utc)
    for uid, role in (("u-own", "owner"), ("u-adm", "admin"), ("u-other", "user")):
        run(fake["users"].insert_one({"_id": uid, "email": f"{uid}@example.com", "name": uid, "role": role,
                                      "pw": "x", "created_at": now, **({"space": "default"} if role != "user" else {})}))
    tokens = (actors.CURRENT.set(actors.local_user()), scope.WORKSPACE.set(scope.DEFAULT))
    yield fake
    actors.CURRENT.reset(tokens[0])
    scope.WORKSPACE.reset(tokens[1])
    for c in (auth._CACHE, auth._TOKEN_CACHE, auth._USAGE):
        c.clear()


def app():
    return __import__("backend.main", fromlist=["app"]).app


def person(fake, uid: str) -> TestClient:
    c = TestClient(app())
    c.cookies.set(auth.COOKIE, run(auth.create_session(fake, {"_id": uid}, "default", "Mozilla/5.0")))
    c.headers[auth.CSRF_HEADER] = "1"
    return c


def visitor(ip: str = "203.0.113.9") -> TestClient:
    c = TestClient(app())
    c.headers["X-Forwarded-For"] = ip
    return c


def upload(c: TestClient, data: bytes, name: str = "app.apk", **form):
    return c.post("/api/mobile/apk", files={"file": (name, data, mobile_app.MIME)}, data=form)


def test_nothing_published_is_404(db):
    v = visitor()
    for path in ("/api/public/m/app.apk", "/api/public/m/app.json"):
        r = v.get(path)
        assert r.status_code == 404 and r.headers["x-robots-tag"] == "noindex, nofollow"


def test_an_upload_is_served_to_anyone_and_nothing_else_is(db):
    data = apk()
    r = upload(person(db, "u-own"), data)
    assert r.status_code == 200, r.text
    assert r.json()["version"] == "1.2.0" and r.json()["versionCode"] == 4
    v = visitor()
    meta = v.get("/api/public/m/app.json")
    assert meta.status_code == 200
    info = meta.json()
    assert info["sha256"] == hashlib.sha256(data).hexdigest() and info["size"] == len(data)
    assert info["min_android"] == "7.0" and info["abis"] == ["arm64-v8a"] and info["url"] == "/api/public/m/app.apk"
    got = v.get("/api/public/m/app.apk")
    assert got.status_code == 200 and got.content == data
    h = got.headers
    assert h["content-type"] == mobile_app.MIME
    assert h["content-disposition"] == 'attachment; filename="workbench-1.2.0.apk"'
    assert h["etag"] == f'"{info["sha256"]}"' and int(h["content-length"]) == len(data)
    assert h["x-content-type-options"] == "nosniff"
    assert v.get("/api/public/m/app.apk", headers={"If-None-Match": h["etag"]}).status_code == 304
    assert v.head("/api/public/m/app.apk").status_code == 200
    # Only those two names: no other file of the folder, no listing.
    for path in ("/api/public/m/latest.json", "/api/public/m/workbench-1.2.0.apk", "/api/public/m/",
                 "/api/public/m/..%2Flatest.json", "/api/public/m/app.apk/../latest.json", "/api/mobile/apk"):
        assert v.get(path).status_code in (401, 404, 405), path
    # The rest of the app still wants a sign-in.
    assert v.get("/api/catalog").status_code == 401


def test_the_downloads_are_rate_limited(db):
    upload(person(db, "u-own"), apk())
    v = visitor("198.51.100.7")
    codes = [v.get("/api/public/m/app.apk").status_code for _ in range(mobile_app.APK_HITS.limit + 1)]
    assert codes[-1] == 429 and set(codes[:-1]) == {200}
    assert 1 <= int(v.get("/api/public/m/app.apk").headers["retry-after"]) <= 600
    # Counted in the database: an API reload (fresh limits in memory) does not start it afresh.
    mobile_app.APK_HITS.clear()
    assert v.get("/api/public/m/app.apk").status_code == 429
    assert visitor("198.51.100.8").get("/api/public/m/app.apk").status_code == 200


def test_only_the_owner_and_admins_upload(db):
    assert upload(person(db, "u-other"), apk()).status_code == 403
    assert upload(visitor(), apk()).status_code in (401, 403)
    raw, _ = run(auth.create_agent_token(db, "bot", "default", None,
                                         {"type": "user", "id": "u-own", "name": "O"}, "editor"))
    c = TestClient(app())
    c.headers["Authorization"] = "Bearer " + raw
    assert upload(c, apk()).status_code == 403
    assert visitor().get("/api/public/m/app.json").status_code == 404
    assert upload(person(db, "u-adm"), apk()).status_code == 200
    trail = [a for a in db["audit"].docs.values() if a["action"] == "mobile-apk"]
    assert trail and trail[0]["target"] == "workbench-1.2.0.apk" and trail[0]["detail"]["versionCode"] == 4


def test_a_bad_file_is_refused_and_the_latest_stays(db, tmp_path):
    own = person(db, "u-own")
    good = apk("1.2.0", 4)
    assert upload(own, good).status_code == 200
    before = (tmp_path / "mobile" / "latest.json").read_text()
    no_manifest = io.BytesIO()
    with zipfile.ZipFile(no_manifest, "w") as z:
        z.writestr("classes.dex", b"dex")
    for data in (b"plain text, not a zip", no_manifest.getvalue(), b""):
        r = upload(own, data)
        assert r.status_code == 400, r.text
    # The APK says one version, the form another.
    assert upload(own, apk("1.3.0", 5), version="1.4.0").status_code == 400
    # No version in the manifest and none in the form; then given in the form.
    assert upload(own, apk(None, 5)).status_code == 400
    assert (tmp_path / "mobile" / "latest.json").read_text() == before
    r = upload(own, apk(None, 5), version="1.3.0")
    assert r.status_code == 200 and r.json()["version"] == "1.3.0"
    assert upload(own, apk(None, 6), version="../../x").status_code == 400
    # No half-written file is left behind.
    left = sorted(p.name for p in (tmp_path / "mobile").iterdir())
    assert left == ["latest.json", "workbench-1.2.0.apk", "workbench-1.3.0.apk"]


def test_too_large_is_refused(db, monkeypatch):
    monkeypatch.setattr(mobile_app, "MAX_BYTES", 1000)
    r = upload(person(db, "u-own"), apk() + b"\x00" * 2000)
    assert r.status_code == 413


def test_latest_json_moves_with_the_apk_and_old_builds_go(db, tmp_path):
    own = person(db, "u-own")
    for i in range(5):
        assert upload(own, apk(f"1.{i}.0", i + 1)).status_code == 200
        info = json.loads((tmp_path / "mobile" / "latest.json").read_text())
        assert info["version"] == f"1.{i}.0"
        assert hashlib.sha256((tmp_path / "mobile" / info["file"]).read_bytes()).hexdigest() == info["sha256"]
    apks = sorted(p.name for p in (tmp_path / "mobile").glob("*.apk"))
    assert len(apks) == mobile_app.KEEP and "workbench-1.4.0.apk" in apks
    # latest.json naming a file that is not there is no build.
    (tmp_path / "mobile" / "workbench-1.4.0.apk").unlink()
    assert visitor().get("/api/public/m/app.apk").status_code == 404


def test_the_rules_say_who(db):
    from backend import access
    assert access.action("POST", "/api/mobile/apk") == "settings"
    assert access.action("GET", "/api/public/m/app.apk") == access.NONE
