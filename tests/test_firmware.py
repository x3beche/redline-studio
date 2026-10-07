"""Firmware: made from a board's MCU, pins.h from its schematic, built by PlatformIO.

A firmware belongs to a board and one of its MCUs (backend/firmware.py).
Its files are versioned; include/pins.h is generated from the MCU's sheet
and written again when the board's schematic moves a pin. A build is a
job of its own (backend/fwbuild.py) whose output is read into errors,
warnings and flash/RAM - tested here on PlatformIO's real output, without
Docker.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest

from backend import access, auth, firmware, fwbuild, scope
from backend import main as M
from test_links import FakeDb, client

H = {"x-redline-csrf": "1"}
FIX = Path(__file__).resolve().parent / "fixtures" / "firmware"

GND_PARTS = ["C1", "J3", "U1"]


def pin(number, name, net, parts=()):
    return {"number": str(number), "name": name, "net": net, "parts": list(parts)}


def esp32_mcu(**moved) -> dict:
    """U2 of the demoboard, as /mcus gives it (a few of its pins)."""
    nets = {"ENC_A": "IO32", "LED2": "IO26", **moved}
    by_name = {v: k for k, v in nets.items()}
    pins = [pin(1, "GND", "GND", GND_PARTS), pin(2, "3V3", "3.3V", ["C3"]), pin(3, "EN", "ESP_EN", ["R10"]),
            pin(4, "SENSOR_VP", "IO_SVP", ["J3"]), pin(5, "SENSOR_VN", "IO_SVN", ["J3"]),
            pin(8, "IO32", by_name.get("IO32"), ["C20", "U1"] if by_name.get("IO32") else []),
            pin(10, "IO25", by_name.get("IO25"), ["SW3"] if by_name.get("IO25") else []),
            pin(11, "IO26", by_name.get("IO26"), ["R19"] if by_name.get("IO26") else []),
            pin(15, "GND", "GND", GND_PARTS), pin(16, "IO13", "12V_EN", ["C22", "U7"]),
            pin(17, "SHD/SD2", None), pin(20, "SCK/CLK", None),
            pin(27, "IO16", "RX2", ["J3", "UART2"]), pin(28, "IO17", "TX2", ["J3", "UART2"]),
            pin(32, "NC", None),
            pin(33, "IO21", "L_SDA", ["I2C", "OLED_MODULE", "R13", "U6"]),
            pin(34, "RXD0", "ESP_RX", ["U5"]), pin(35, "TXD0", "ESP_TX", ["U5"])]
    return {"ref": "U2", "part": "C82899", "title": "ESP32-WROOM-32", "sheet": "U2 · ESP32-WROOM-32",
            "key": "mcu-u2", "file": "mcu-u2.kicad_sch", "svg": "/api/boards/demo/sheets/mcu-u2.svg",
            "pins": pins}


def board(mcu=None, version=5) -> dict:
    return {"_id": "demo", "title": "board", "folder": "iot-fan/electronics",
            "component": {"version": version}, "schematic": {"mcus": [mcu or esp32_mcu()]}}


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------- pins.h

def test_esp32_pin_names_give_their_gpio():
    assert firmware.gpio_of("IO21") == 21
    assert firmware.gpio_of("IO0") == 0
    assert firmware.gpio_of("GPIO4") == 4
    assert firmware.gpio_of("IO2/HSPIWP") == 2
    assert firmware.gpio_of("SENSOR_VP") == 36
    assert firmware.gpio_of("SENSOR_VN") == 39
    assert firmware.gpio_of("RXD0") == 3 and firmware.gpio_of("TXD0") == 1
    assert firmware.gpio_of("MTDI") == 12
    for not_gpio in ("EN", "3V3", "GND", "NC", "", "SCK/CLK", "SDO/SD0", "SHD/SD2"):
        assert firmware.gpio_of(not_gpio) is None, not_gpio


def test_net_names_become_macros_the_core_does_not_have():
    assert firmware.macro_of("L_SDA") == "L_SDA"
    assert firmware.macro_of("12V_EN") == "PIN_12V_EN"      # a digit cannot start a name
    assert firmware.macro_of("TX2") == "PIN_TX2"            # the Arduino core has TX2
    assert firmware.macro_of("SDA") == "PIN_SDA"
    assert firmware.macro_of("net-4") == "NET_4"
    assert firmware.macro_of("power.fan_en") == "FAN_EN"


def test_pins_h_defines_signal_nets_and_skips_power_ground_and_flash():
    rows = firmware.pin_rows(esp32_mcu())
    kinds = {r["number"]: r["kind"] for r in rows}
    assert kinds["1"] == "ground" and kinds["2"] == "power" and kinds["3"] == "other"
    assert kinds["17"] == "flash" and kinds["32"] == "nc"
    text = firmware.pins_header("demo", esp32_mcu(), rows)
    assert "GENERATED" in text and "#pragma once" in text
    assert firmware.defined(rows) == {"IO_SVP": 36, "IO_SVN": 39, "ENC_A": 32, "LED2": 26, "PIN_12V_EN": 13,
                                      "PIN_RX2": 16, "PIN_TX2": 17, "L_SDA": 21, "ESP_RX": 3, "ESP_TX": 1}
    line = next(l for l in text.splitlines() if l.startswith("#define L_SDA"))
    assert line.split()[2] == "21" and "I2C, OLED_MODULE, R13, U6" in line
    assert "input only" in next(l for l in text.splitlines() if "IO_SVP" in l)
    for absent in ("GND ", "3.3V", "ESP_EN", "SD2", "#define NC"):
        assert not any(l.startswith("#define") and absent in l for l in text.splitlines()), absent


def test_a_moved_pin_is_said_and_the_digest_changes():
    old = firmware.pin_rows(esp32_mcu())
    new = firmware.pin_rows(esp32_mcu(ENC_A="IO25"))
    diff = firmware.diff_pins(firmware.defined(old), firmware.defined(new))
    assert diff == {"moved": [{"net": "ENC_A", "from": 32, "to": 25}], "added": [], "removed": []}
    assert firmware.change_text(diff) == "1 pin moved"
    assert firmware.pins_digest(old) != firmware.pins_digest(new)
    assert firmware.pins_digest(old) == firmware.pins_digest(firmware.pin_rows(esp32_mcu()))


def test_used_in_reads_code_not_comments_strings_or_pins_h():
    files = {"include/pins.h": "#define LED2 26\n#define ENC_A 32\n",
             "src/main.cpp": '// LED2 blinks\nconst char *s = "ENC_A";\nvoid f() { pinMode(L_SDA, OUTPUT); }\n',
             "src/leds.cpp": "/* ENC_A */ digitalWrite(LED2, HIGH);",
             "platformio.ini": "LED2"}
    got = firmware.used_in(files, ["LED2", "ENC_A", "L_SDA", "LED"])
    assert got == {"LED2": ["src/leds.cpp"], "ENC_A": [], "L_SDA": ["src/main.cpp"], "LED": []}


def test_the_chip_says_which_platformio_board():
    assert firmware.target_of({"title": "ESP32-WROOM-32"})["board"] == "esp32dev"
    assert firmware.target_of({"title": "ESP32-C3-MINI-1"})["board"] == "esp32-c3-devkitm-1"
    with pytest.raises(firmware.Refused):
        firmware.target_of({"ref": "U4", "title": "STM32F042"})


# ---------------------------------------------------------------- the API

@pytest.fixture
def api(monkeypatch, tmp_path):
    db = FakeDb()
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    monkeypatch.setattr(fwbuild, "CACHE", tmp_path / "fw")
    db["boards"].rows.append(board())
    db["folders"].rows += [{"_id": "iot-fan", "name": "iot-fan", "parent": ""},
                           {"_id": "iot-fan/electronics", "name": "electronics", "parent": "iot-fan"}]
    started = []

    async def spawn(raw, job_id):
        started.append(job_id)
        return 4242

    monkeypatch.setattr(fwbuild, "spawn", spawn)
    return {"db": db, "started": started}


@pytest.mark.asyncio
async def test_a_firmware_is_made_from_an_mcu_and_seeded(api):
    async with client() as c:
        r = await c.post("/api/boards/demo/firmware", json={"mcu": "U2"}, headers=H)
        assert r.status_code == 201, r.text
        fw = r.json()
        assert fw["title"] == "U2 ESP32" and fw["board_version"] == 5 and fw["env"] == "esp32dev"
        assert fw["platform"] == firmware.PLATFORM and fw["version"] == 1
        # one per MCU: asking again answers the one there is
        again = await c.post("/api/boards/demo/firmware", json={"mcu": "U2"}, headers=H)
        assert again.status_code == 200 and again.json()["id"] == fw["id"]
        assert (await c.post("/api/boards/demo/firmware", json={"mcu": "U9"}, headers=H)).status_code == 404
        fid = fw["id"]
        tree = (await c.get(f"/api/firmware/{fid}/files")).json()
        assert [f["path"] for f in tree] == ["include/pins.h", "src/main.cpp", "platformio.ini"]
        assert [f["generated"] for f in tree] == [True, False, False]
        ini = (await c.get(f"/api/firmware/{fid}/files/platformio.ini")).json()["content"]
        assert "board = esp32dev" in ini and "framework = arduino" in ini
        pins_h = (await c.get(f"/api/firmware/{fid}/files/include/pins.h")).json()["content"]
        assert "#define L_SDA" in pins_h
        assert (await c.get(f"/api/firmware/{fid}/files/nope.c")).status_code == 404
        listed = (await c.get("/api/firmware")).json()
        assert [f["id"] for f in listed] == [fid]
        assert [f["id"] for f in (await c.get("/api/boards/demo/firmware")).json()] == [fid]
        one = (await c.get(f"/api/firmware/{fid}")).json()
        assert one["matches"] and one["board_now"] == 5
        assert next(p for p in one["pins"] if p["macro"] == "L_SDA")["used_in"] == []
        # the catalog puts it under its board's folder
        tree = (await c.get("/api/catalog")).json()
        def find(n):
            if n["path"] == "iot-fan/electronics":
                return n
            for f in n["folders"]:
                got = find(f)
                if got:
                    return got
        node = find(tree)
        assert node["firmware"][0]["title"] == "U2 ESP32" and node["firmware"][0]["board_version"] == 5


@pytest.mark.asyncio
async def test_each_save_is_a_version_and_pins_h_is_not_written_by_hand(api):
    async with client() as c:
        fid = (await c.post("/api/boards/demo/firmware", json={"mcu": "U2"}, headers=H)).json()["id"]
        body = {"files": {"src/main.cpp": "#include \"pins.h\"\nvoid setup(){pinMode(LED2,OUTPUT);}\nvoid loop(){}\n",
                          "src/leds.h": "#pragma once\n"}, "note": "blink", "base": 1}
        r = await c.post(f"/api/firmware/{fid}/files", json=body, headers=H)
        assert r.status_code == 200 and r.json() == {"version": 2, "changed": ["src/leds.h", "src/main.cpp"]}
        # the same text again is no new version
        body["base"] = 2
        assert (await c.post(f"/api/firmware/{fid}/files", json=body, headers=H)).json()["version"] == 2
        # an old base is refused rather than laid over
        stale = {"files": {"src/main.cpp": "x"}, "base": 1}
        assert (await c.post(f"/api/firmware/{fid}/files", json=stale, headers=H)).status_code == 409
        hand = {"files": {"include/pins.h": "#define LED2 5\n"}}
        r = await c.post(f"/api/firmware/{fid}/files", json=hand, headers=H)
        assert r.status_code == 422 and "generated" in r.json()["detail"]
        bad = {"files": {"../etc/passwd": "x"}}
        assert (await c.post(f"/api/firmware/{fid}/files", json=bad, headers=H)).status_code == 422
        # a delete is a version too
        r = await c.post(f"/api/firmware/{fid}/files", json={"files": {"src/leds.h": None}}, headers=H)
        assert r.json()["version"] == 3
        paths = [f["path"] for f in (await c.get(f"/api/firmware/{fid}/files")).json()]
        assert "src/leds.h" not in paths
        old = [f["path"] for f in (await c.get(f"/api/firmware/{fid}/files", params={"version": 2})).json()]
        assert "src/leds.h" in old
        first = (await c.get(f"/api/firmware/{fid}/files/src/main.cpp", params={"version": 1})).json()
        assert first["version"] == 1 and "pinMode(LED2" not in first["content"]
        versions = (await c.get(f"/api/firmware/{fid}/versions")).json()
        assert [v["version"] for v in versions] == [3, 2, 1]
        assert versions[1]["note"] == "blink"
        assert {f["path"] for f in versions[1]["files"]} == {"src/main.cpp", "src/leds.h"}
        # what the code uses is counted from the files
        one = (await c.get(f"/api/firmware/{fid}")).json()
        assert next(p for p in one["pins"] if p["macro"] == "LED2")["used_in"] == ["src/main.cpp"]


def test_another_space_does_not_see_it():
    raw = FakeDb()
    raw["boards"].rows.append(board())
    mine = scope.ScopedDb(raw, scope.DEFAULT)
    fw, _ = run(firmware.create(mine, "demo", "U2"))
    theirs = scope.ScopedDb(raw, "u-other")
    assert run(firmware.listing(theirs)) == []
    with pytest.raises(KeyError):
        run(firmware.get(theirs, fw["_id"]))
    assert run(firmware.tree(theirs, fw["_id"])) == []
    assert [f["id"] for f in run(firmware.listing(mine))] == [fw["_id"]]
    assert {"firmware", "firmware_files"} <= scope.SCOPED


def test_a_board_change_writes_pins_h_again_and_builds():
    raw = FakeDb()
    raw["boards"].rows.append(board())
    db = scope.ScopedDb(raw, scope.DEFAULT)
    fw, _ = run(firmware.create(db, "demo", "U2"))
    asked = []

    async def build(fid, why):
        asked.append((fid, why))

    # drawn again with nothing moved: nothing written, nothing built
    assert run(firmware.board_changed(db, "demo", start_build=build)) == []
    assert run(firmware.get(db, fw["_id"]))["version"] == 1
    # ENC_A moves to IO25 and the board is at v6
    raw["boards"].rows[0] = board(esp32_mcu(ENC_A="IO25"), version=6)
    got = run(firmware.board_changed(db, "demo", start_build=build))
    assert len(got) == 1 and got[0]["moved"] == [{"net": "ENC_A", "from": 32, "to": 25}]
    after = run(firmware.get(db, fw["_id"]))
    assert after["version"] == 2 and after["board_version"] == 6 and after["pins"]["ENC_A"] == 25
    assert after["board_change"]["text"] == "board v6 changed, pins regenerated: 1 pin moved"
    pins_h = run(firmware.read(db, fw["_id"], firmware.PINS))
    assert pins_h["generated"] and "#define ENC_A      25" in pins_h["content"]
    assert asked == [(fw["_id"], after["board_change"]["text"])]
    # the MCU gone from the schematic: said, not guessed
    raw["boards"].rows[0] = {**board(), "schematic": {"mcus": []}}
    run(firmware.board_changed(db, "demo", start_build=build))
    assert run(firmware.get(db, fw["_id"]))["board_change"]["missing"]


def test_drawing_the_schematic_ends_with_the_firmware_following(monkeypatch):
    """backend/schematic.py draw() calls firmware_follows; a failure there
    never fails the drawing."""
    from backend import schematic

    async def boom(db, board_id, start_build=None):
        raise RuntimeError("nope")

    monkeypatch.setattr(firmware, "board_changed", boom)
    assert run(schematic.firmware_follows(FakeDb(), "demo")) == []


# ---------------------------------------------------------------- reading PlatformIO

def test_a_good_build_reads_as_sizes_and_its_warnings_once():
    got = fwbuild.parse((FIX / "pio_ok.txt").read_text())
    assert got["ok"] and got["error_count"] == 0
    assert got["warning_count"] == 2                      # the repeated one counted once
    assert got["warnings"][0] == {"file": "src/ui.cpp", "line": 88, "col": 9,
                                  "text": "unused variable 'spare' [-Wunused-variable]"}
    assert got["flash"] == {"used": 313861, "total": 1310720, "pct": 23.9}
    assert got["ram"] == {"used": 22800, "total": 327680, "pct": 7.0}


def test_a_failed_build_reads_as_errors_with_file_and_line():
    got = fwbuild.parse((FIX / "pio_fail.txt").read_text())
    assert not got["ok"] and got["error_count"] == 2 and got["warning_count"] == 1
    assert got["errors"][0] == {"file": "src/main.cpp", "line": 5, "col": 14,
                                "text": "'undefined_fn' was not declared in this scope"}
    assert got["errors"][1]["file"] == "include/config.h" and got["errors"][1]["line"] == 12
    assert got["flash"] is None


def test_a_link_error_is_an_error_too():
    got = fwbuild.parse((FIX / "pio_link.txt").read_text())
    assert not got["ok"] and got["error_count"] == 1
    assert "undefined reference to `fan_begin()'" in got["errors"][0]["text"]


def test_lines_are_coloured_for_the_log_band():
    assert fwbuild.level_of("src/a.cpp:1:2: error: x") == "error"
    assert fwbuild.level_of("src/a.cpp:1:2: warning: x") == "warn"
    assert fwbuild.level_of("Compiling .pio/build/x.o") == "work"
    assert fwbuild.level_of("=== [SUCCESS] Took 3 s ===") == "done"
    assert fwbuild.level_of("esptool.py v4.11.0") == "info"


# ---------------------------------------------------------------- the build job

def test_the_project_on_disk_follows_the_database_and_keeps_its_cache(tmp_path):
    where = tmp_path / "p"
    files = {"platformio.ini": "[env:x]\n", "src/main.cpp": "int a;\n", "src/old.cpp": "x"}
    assert sorted(fwbuild.write_project(where, files)) == sorted(files)
    (where / ".pio" / "build").mkdir(parents=True)
    (where / ".pio" / "build" / "keep.o").write_text("o")
    stamp = (where / "src/main.cpp").stat().st_mtime_ns
    time.sleep(0.01)
    del files["src/old.cpp"]
    changed = fwbuild.write_project(where, {**files, "include/pins.h": "#pragma once\n"})
    assert sorted(changed) == ["include/pins.h", "src/old.cpp"]
    assert (where / "src/main.cpp").stat().st_mtime_ns == stamp      # untouched: not rebuilt
    assert not (where / "src/old.cpp").exists()
    assert (where / ".pio" / "build" / "keep.o").exists()


def test_the_container_has_no_network_for_the_compile(tmp_path):
    argv = fwbuild.docker_argv(tmp_path, "exec pio run -e esp32dev")
    assert argv[:3] == ["docker", "run", "--rm"] and "--network" in argv
    assert argv[argv.index("--network") + 1] == "none"
    assert "--memory" in argv and fwbuild.IMAGE in argv
    assert f"{tmp_path}:/project" in argv
    assert "--network" not in fwbuild.docker_argv(tmp_path, "pio pkg install", network=True)


def test_a_build_runs_writes_its_lines_and_its_result(tmp_path, monkeypatch):
    monkeypatch.setattr(fwbuild, "CACHE", tmp_path / "fw")

    async def ready():
        return True

    monkeypatch.setattr(fwbuild, "image_ready", ready)
    raw = FakeDb()
    raw["boards"].rows.append(board())
    db = scope.ScopedDb(raw, scope.DEFAULT)
    fw, _ = run(firmware.create(db, "demo", "U2"))
    seen = []

    async def fake_run(argv, lines, timeout):
        seen.append(argv[-1])
        text = (FIX / "pio_ok.txt").read_text() if "pio run" in argv[-1] else "Library Manager: ok"
        for line in text.splitlines():
            await lines.add(line)
        return 0, text

    async def go():
        job = {"_id": "j1", "firmware": fw["_id"], "workspace": "default", "status": "running",
               "title": fw["title"], "version": 1, "why": "asked for"}
        await raw[fwbuild.JOBS].insert_one(job)
        return await fwbuild.execute(db, raw, job, run=fake_run)

    done = run(go())
    assert done["status"] == "done" and done["result"]["ok"]
    assert seen[0].endswith("pio pkg install -e esp32dev") and seen[-1] == "exec pio run -e esp32dev"
    job = raw[fwbuild.JOBS].rows[0]
    assert job["lines"][-1]["text"].startswith("U2 ESP32: built · flash 23.9%")
    assert job["lines"][-1]["level"] == "done"
    after = run(firmware.get(db, fw["_id"]))
    b = after["build"]
    assert b["state"] == "ok" and b["warning_count"] == 2 and b["flash"]["pct"] == 23.9 and b["version"] == 1
    # the libraries are fetched once per platformio.ini
    seen.clear()
    run(fwbuild.execute(db, raw, {**job, "_id": "j2"}, run=fake_run))
    assert seen == ["exec pio run -e esp32dev"]


@pytest.mark.asyncio
async def test_build_answers_202_and_one_runs_at_a_time(api):
    async with client() as c:
        fid = (await c.post("/api/boards/demo/firmware", json={"mcu": "U2"}, headers=H)).json()["id"]
        r = await c.post(f"/api/firmware/{fid}/build", headers=H)
        assert r.status_code == 202 and r.json()["status"] == "running"
        assert api["started"] == [r.json()["job"]]
        again = await c.post(f"/api/firmware/{fid}/build", headers=H)
        assert again.status_code == 409
        assert (await c.get(f"/api/firmware/{fid}")).json()["build"]["state"] == "running"
        builds = (await c.get(f"/api/firmware/{fid}/builds")).json()
        assert builds[0]["job"] == r.json()["job"]
        assert (await c.get(f"/api/firmware/{fid}/log")).json() == []
        assert (await c.get(f"/api/firmware/{fid}/download/firmware.bin")).status_code == 404
        assert (await c.post("/api/firmware/nope/build", headers=H)).status_code == 404


# ---------------------------------------------------------------- who may

def test_building_is_running_and_making_is_editing():
    build = access.action("POST", "/api/firmware/abc/build")
    pins = access.action("POST", "/api/firmware/abc/pins")
    assert build == pins == "run"
    assert access.allowed("editor", build) and not access.allowed("reviewer", build)
    for m, p in (("POST", "/api/boards/demo/firmware"), ("POST", "/api/firmware/abc/files")):
        a = access.action(m, p)
        assert a == "edit" and access.allowed("editor", a) and not access.allowed("reviewer", a)
    assert access.action("DELETE", "/api/firmware/abc") == "delete"
    for path in ("/api/firmware", "/api/firmware/abc", "/api/firmware/abc/files/src/main.cpp",
                 "/api/firmware/abc/log", "/api/firmware/abc/download/firmware.bin"):
        assert access.allowed("viewer", access.action("GET", path))
        assert access.page_allowed("GET", path)
    assert not access.page_allowed("POST", "/api/firmware/abc/build")


def test_without_the_image_the_build_says_how_to_make_it(tmp_path, monkeypatch):
    monkeypatch.setattr(fwbuild, "CACHE", tmp_path / "fw")

    async def missing():
        return False

    monkeypatch.setattr(fwbuild, "image_ready", missing)
    raw = FakeDb()
    raw["boards"].rows.append(board())
    db = scope.ScopedDb(raw, scope.DEFAULT)
    fw, _ = run(firmware.create(db, "demo", "U2"))
    job = {"_id": "j1", "firmware": fw["_id"], "workspace": "default", "status": "running", "title": "U2 ESP32"}
    raw[fwbuild.JOBS].rows.append(dict(job))
    done = run(fwbuild.execute(db, raw, job))
    assert done["status"] == "failed" and "docker build -t redline-firmware docker/firmware" in done["detail"]
    assert run(firmware.get(db, fw["_id"]))["build"]["state"] == "failed"
