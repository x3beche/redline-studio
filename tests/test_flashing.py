"""Flashing from the browser: the image the server hands out, and the record of each flash.

The page flashes over Web Serial with esptool-js (rooms/firmware.ts); the
server keeps what a build made - bootloader, partition table, boot_app0
and the app - and says where each goes (backend/flashing.py). A build that
failed, or is older than the code, is not handed out. Each flash is a
record, on the firmware, in Working now and in the audit trail.
"""

from __future__ import annotations

import hashlib
import struct

import pytest
from bson import ObjectId

from backend import access, flashing, fwbuild, scope, store
from test_firmware import FIX, H, api, client  # noqa: F401 - the fixture

ENV = "esp32dev"


def table(*rows) -> bytes:
    """A partition table: (type, subtype, offset, size, label) rows, then the MD5 line."""
    out = b""
    for kind, sub, off, size, label in rows:
        out += b"\xaa\x50" + struct.pack("<BBII", kind, sub, off, size) + label.encode().ljust(16, b"\0") + b"\0" * 4
    return out + b"\xeb\xeb" + b"\xff" * 14 + b"\0" * 16


ARDUINO = table((1, 2, 0x9000, 0x5000, "nvs"), (1, 0, 0xE000, 0x2000, "otadata"),
                (0, 0x10, 0x10000, 0x140000, "app0"), (0, 0x11, 0x150000, 0x140000, "app1"),
                (1, 0x82, 0x290000, 0x160000, "spiffs"))
FILES = {"bootloader.bin": b"\xe9boot" * 100, "partitions.bin": ARDUINO, "boot_app0.bin": b"\xff" * 8192,
         "firmware.bin": b"\xe9app" * 1000, "firmware.elf": b"\x7fELF" * 50}


class Bucket:
    """GridFS, in a dict."""

    def __init__(self):
        self.files: dict[str, bytes] = {}

    async def upload_from_stream(self, name, data):
        oid = ObjectId()
        self.files[str(oid)] = bytes(data)
        return oid

    async def open_download_stream(self, oid):
        data = self.files[str(oid)]

        class S:
            async def read(self):
                return data
        return S()

    async def delete(self, oid):
        self.files.pop(str(oid), None)


@pytest.fixture
def fake_build(api, monkeypatch):  # noqa: F811
    """A build that "compiles" by writing the files PlatformIO would."""
    bucket = Bucket()
    monkeypatch.setattr(store, "bucket", lambda db, name: bucket)

    async def ready():
        return True

    monkeypatch.setattr(fwbuild, "image_ready", ready)
    scripts = []

    def make(fid, ok=True, files=FILES):
        out = fwbuild.project_dir("default", fid) / ".pio" / "build" / ENV

        async def fake_run(argv, lines, timeout):
            scripts.append(argv[-1])
            if "pio run" not in argv[-1]:
                return 0, ""
            text = (FIX / ("pio_ok.txt" if ok else "pio_fail.txt")).read_text()
            out.mkdir(parents=True, exist_ok=True)
            if ok:
                for name, data in files.items():
                    (out / name).write_bytes(data)
            return (0 if ok else 1), text

        async def go(job_id):
            raw = api["db"]
            db = scope.ScopedDb(raw, "default")
            job = {"_id": job_id, "firmware": fid, "workspace": "default", "status": "running",
                   "title": "U2 ESP32", "version": (await raw["firmware"].find_one({"_id": fid}))["version"]}
            await raw[fwbuild.JOBS].insert_one(job)
            return await fwbuild.execute(db, raw, job, run=fake_run)
        return go

    return {"make": make, "bucket": bucket, "scripts": scripts}


async def new_fw(c) -> str:
    return (await c.post("/api/boards/demo/firmware", json={"mcu": "U2"}, headers=H)).json()["id"]


# ---------------------------------------------------------------- the image

def test_the_partition_table_says_where_the_app_and_otadata_go():
    rows = flashing.partition_table(ARDUINO)
    assert [r["label"] for r in rows] == ["nvs", "otadata", "app0", "app1", "spiffs"]
    assert flashing.offsets("ESP32", ARDUINO) == {"bootloader.bin": 0x1000, "partitions.bin": 0x8000,
                                                  "boot_app0.bin": 0xE000, "firmware.bin": 0x10000}
    # a table of its own: the app where it says; a factory app wins over ota_0
    own = table((1, 0, 0xD000, 0x2000, "otadata"), (0, 0x10, 0x20000, 0x100000, "ota_0"),
                (0, 0x00, 0x120000, 0x100000, "factory"))
    at = flashing.offsets("ESP32", own)
    assert at["firmware.bin"] == 0x120000 and at["boot_app0.bin"] == 0xD000
    # S3 and C3 boot from 0x0; no table read is the default one
    assert flashing.offsets("ESP32-S3", None)["bootloader.bin"] == 0
    assert flashing.offsets("ESP32", b"")["firmware.bin"] == 0x10000


def test_the_compile_copies_boot_app0_and_keeps_pios_exit_code():
    s = fwbuild.compile_script("esp32dev")
    assert s.startswith("pio run -e esp32dev; rc=$?;")
    assert "framework-arduinoespressif32/tools/partitions/boot_app0.bin" in s
    assert ".pio/build/esp32dev/boot_app0.bin" in s and s.endswith("exit $rc")


@pytest.mark.asyncio
async def test_a_build_keeps_bootloader_partitions_and_boot_app0(api, fake_build):  # noqa: F811
    async with client() as c:
        fid = await new_fw(c)
        await fake_build["make"](fid)("j1")
        assert fake_build["scripts"][-1] == fwbuild.compile_script(ENV)
        b = (await c.get(f"/api/firmware/{fid}")).json()["build"]
        assert b["state"] == "ok"
        assert set(b["artifacts"]) == set(fwbuild.KEPT)
        for name, data in FILES.items():
            meta = b["artifacts"][name]
            assert meta["bytes"] == len(data) and meta["sha256"] == hashlib.sha256(data).hexdigest()
            assert meta["md5"] == hashlib.md5(data).hexdigest()
        assert b["artifacts"]["firmware.bin"]["offset"] == 0x10000
        assert b["artifacts"]["bootloader.bin"]["offset"] == 0x1000
        for name in ("bootloader.bin", "partitions.bin", "boot_app0.bin"):
            r = await c.get(f"/api/firmware/{fid}/download/{name}")
            assert r.status_code == 200 and r.content == FILES[name]
        assert (await c.get(f"/api/firmware/{fid}/download/secrets.txt")).status_code == 404


# ---------------------------------------------------------------- the manifest

@pytest.mark.asyncio
async def test_the_manifest_lists_every_file_at_its_offset_with_its_hash(api, fake_build):  # noqa: F811
    async with client() as c:
        fid = await new_fw(c)
        await fake_build["make"](fid)("j1")
        r = await c.get(f"/api/firmware/{fid}/flash-manifest")
        assert r.status_code == 200, r.text
        m = r.json()
        assert m["chip"] == "ESP32" and m["build_job"] == "j1" and m["version"] == 1
        assert m["baud"] == 921600 and m["fallback_baud"] == 115200 and m["monitor_baud"] == 115200
        assert [(f["name"], f["offset"]) for f in m["files"]] == [
            ("bootloader.bin", 0x1000), ("partitions.bin", 0x8000), ("boot_app0.bin", 0xE000),
            ("firmware.bin", 0x10000)]
        for f in m["files"]:
            data = FILES[f["name"]]
            assert f["size"] == len(data) and f["sha256"] == hashlib.sha256(data).hexdigest()
            assert f["md5"] == hashlib.md5(data).hexdigest()
            got = await c.get(f["url"])
            assert got.status_code == 200 and hashlib.sha256(got.content).hexdigest() == f["sha256"]
        # a file of another build than the manifest's is refused, not mixed in
        stale = m["files"][0]["url"].replace("build=j1", "build=old")
        assert (await c.get(stale)).status_code == 409


@pytest.mark.asyncio
async def test_no_manifest_for_a_build_that_failed_is_old_or_never_was(api, fake_build):  # noqa: F811
    async with client() as c:
        fid = await new_fw(c)
        r = await c.get(f"/api/firmware/{fid}/flash-manifest")
        assert r.status_code == 409 and r.json()["detail"]["reason"] == "never"
        await fake_build["make"](fid)("j1")
        assert (await c.get(f"/api/firmware/{fid}/flash-manifest")).status_code == 200
        # the code moves on: the build is older than the sources
        await c.post(f"/api/firmware/{fid}/files", json={"files": {"src/x.cpp": "int x;\n"}}, headers=H)
        r = await c.get(f"/api/firmware/{fid}/flash-manifest")
        assert r.status_code == 409 and r.json()["detail"]["reason"] == "stale"
        assert "build first" in r.json()["detail"]["detail"]
        # built again, and that build fails: the last good files are kept, but not flashed
        await fake_build["make"](fid, ok=False)("j2")
        fw = (await c.get(f"/api/firmware/{fid}")).json()
        assert fw["build"]["state"] == "errors" and "firmware.bin" in fw["build"]["artifacts"]
        r = await c.get(f"/api/firmware/{fid}/flash-manifest")
        assert r.status_code == 409 and r.json()["detail"]["reason"] == "failed"
        # a build from before flashing kept only the app
        await fake_build["make"](fid)("j3")
        row = next(r for r in api["db"]["firmware"].rows if r["_id"] == fid)
        row["build"]["artifacts"] = {k: v for k, v in row["build"]["artifacts"].items()
                                     if k in ("firmware.bin", "firmware.elf")}
        r = await c.get(f"/api/firmware/{fid}/flash-manifest")
        assert r.status_code == 409 and r.json()["detail"]["reason"] == "missing"
        # while one runs
        await c.post(f"/api/firmware/{fid}/build", headers=H)
        r = await c.get(f"/api/firmware/{fid}/flash-manifest")
        assert r.status_code == 409 and r.json()["detail"]["reason"] == "running"


# ---------------------------------------------------------------- the records

def test_only_the_last_three_bytes_of_the_mac_are_kept():
    assert flashing.mac_tail("24:6F:28:AA:BB:CC") == "aa:bb:cc"
    assert flashing.mac_tail("24-6f-28-aa-bb-cc") == "aa:bb:cc"
    assert flashing.mac_tail("aa:bb:cc") == "aa:bb:cc"
    assert flashing.mac_tail("0123456789abcdef0123") == "0123456789abcdef"
    assert flashing.mac_tail("not a mac") is None and flashing.mac_tail(None) is None


@pytest.mark.asyncio
async def test_a_flash_is_recorded_on_the_firmware_in_working_now_and_the_audit(api, fake_build):  # noqa: F811
    async with client() as c:
        fid = await new_fw(c)
        await fake_build["make"](fid)("j1")
        r = await c.post(f"/api/firmware/{fid}/flashes", json={"build_job": "j1", "chip": "ESP32-D0WD-V3"},
                         headers=H)
        assert r.status_code == 201, r.text
        started = r.json()
        assert started["state"] == "running" and started["ok"] is None and started["version"] == 1
        now = (await c.get("/api/work/now")).json()
        assert any(i["kind"] == "firmware" and i.get("job") == "flash" and i["id"] == fid for i in now["items"])
        r = await c.post(f"/api/firmware/{fid}/flashes/{started['id']}",
                         json={"ok": True, "secs": 12.34, "mac": "24:6F:28:AA:BB:CC", "chip": "ESP32-D0WD-V3"},
                         headers=H)
        assert r.status_code == 200, r.text
        done = r.json()
        assert done["state"] == "done" and done["ok"] is True and done["mac"] == "aa:bb:cc" and done["secs"] == 12.3
        fw = (await c.get(f"/api/firmware/{fid}")).json()
        last = fw["last_flash"]
        assert last["ok"] and last["build_job"] == "j1" and last["build_at"] == fw["build"]["at"]
        assert last["mac"] == "aa:bb:cc"
        now = (await c.get("/api/work/now")).json()
        assert not any(i.get("job") == "flash" for i in now["items"])
        assert any(r["kind"] == "flash" and r["ok"] for r in now["recent"])
        rows = (await c.get(f"/api/firmware/{fid}/flashes")).json()
        assert [x["id"] for x in rows] == [started["id"]]
        audit = [a for a in api["db"]["audit"].rows if a["action"] == "flash"]
        assert len(audit) == 1 and audit[0]["target"] == f"/api/firmware/{fid}"
        assert audit[0]["detail"]["ok"] is True and audit[0]["detail"]["mac"] == "aa:bb:cc"
        assert "24:6f:28" not in str(api["db"].colls).lower()
        # a failed flash, all at once
        r = await c.post(f"/api/firmware/{fid}/flashes",
                         json={"build_job": "j1", "ok": False, "error": "chip is ESP32-S3"}, headers=H)
        assert r.status_code == 201 and r.json()["state"] == "failed"
        assert (await c.get(f"/api/firmware/{fid}")).json()["last_flash"]["ok"] is False
        # a build that is not this firmware's, a flash that is not there, no ending
        assert (await c.post(f"/api/firmware/{fid}/flashes", json={"build_job": "nope", "ok": True},
                             headers=H)).status_code == 422
        assert (await c.post(f"/api/firmware/{fid}/flashes/nope", json={"ok": True}, headers=H)).status_code == 404
        assert (await c.post(f"/api/firmware/{fid}/flashes/{started['id']}", json={},
                             headers=H)).status_code == 422


def test_recording_a_flash_is_running_and_reading_the_manifest_is_looking():
    for p in ("/api/firmware/abc/flashes", "/api/firmware/abc/flashes/f1"):
        a = access.action("POST", p)
        assert a == "run" and access.allowed("editor", a) and not access.allowed("reviewer", a)
        assert not access.page_allowed("POST", p)
    for p in ("/api/firmware/abc/flash-manifest", "/api/firmware/abc/flashes",
              "/api/firmware/abc/download/bootloader.bin"):
        assert access.allowed("viewer", access.action("GET", p)) and access.page_allowed("GET", p)
    assert "firmware_flashes" in scope.SCOPED
