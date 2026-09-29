"""The Device view's backend (backend/embedded/device.py): which ports are
listed and nothing else is accepted, the serial monitor's stream read off a
pty standing in for a board, and a flash job run with a stand-in command."""

from __future__ import annotations

import asyncio
import json
import os
import time

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend.embedded import device


# -- a fake database -----------------------------------------------------------

class _Col:
    def __init__(self, docs):
        self.docs = docs

    async def find_one(self, q, proj=None):
        return next((d for d in self.docs if d["_id"] == q["_id"]), None)

    async def update_one(self, q, upd):
        d = await self.find_one(q)
        if d is not None:
            d.update(upd.get("$set") or {})

    async def insert_one(self, doc):
        self.docs.append(doc)

        class R:
            inserted_id = len(self.docs)
        return R()

    def find(self, *a, **k):
        async def it():
            for d in self.docs:
                yield d
        return it()


class FakeDb(dict):
    def __getitem__(self, k):
        return self.setdefault(k, _Col([]))


APP = {"_id": "fw", "platform": "embedded", "repo": "/r", "cwd": "fw", "target": "esp32",
       "build": "idf.py -C demo -B $BUILD build", "flash": "idf.py -C demo -B $BUILD -p $PORT flash",
       "firmware": {"ok": True, "elf": "demo.elf", "at": "2026-09-29T10:48:21+00:00"}}


def _client(monkeypatch, app=APP):
    db = FakeDb(apps=_Col([dict(app)]))
    monkeypatch.setattr(device, "_db", lambda: db)
    said = []

    async def say(text, level="info"):
        said.append(text)
    monkeypatch.setattr(device, "_say", say)
    api = FastAPI()
    api.include_router(device.router)
    return TestClient(api), db


# -- ports ---------------------------------------------------------------------

def _usb(root, bus, vid, pid, product=None):
    d = root / "devices" / "pci0000:00" / "usb1" / bus
    d.mkdir(parents=True)
    (d / "idVendor").write_text(vid + "\n")
    (d / "idProduct").write_text(pid + "\n")
    if product:
        (d / "product").write_text(product + "\n")
    (root / "bus" / "usb" / "devices").mkdir(parents=True, exist_ok=True)
    (root / "bus" / "usb" / "devices" / bus).symlink_to(d)
    return d


def _fake_sys(tmp_path, monkeypatch):
    root = tmp_path / "sys"
    ch340 = _usb(root, "1-3", "1a86", "7523", "USB Serial")
    iface = ch340 / "1-3:1.0" / "ttyUSB0"
    iface.mkdir(parents=True)
    _usb(root, "1-4", "0483", "3748", "STM32 STLink")
    ttys = root / "class" / "tty"
    (ttys / "ttyUSB0").mkdir(parents=True)
    (ttys / "ttyUSB0" / "device").symlink_to(iface)
    (ttys / "ttyS0").mkdir()          # the machine's own UART: not on USB, not listed
    monkeypatch.setattr(device, "SYS", root)
    monkeypatch.delenv("X3_SERIAL_EXTRA", raising=False)


def test_ports_name_what_is_plugged_in(tmp_path, monkeypatch):
    _fake_sys(tmp_path, monkeypatch)
    got = {p["id"]: p for p in device.list_ports()}
    assert set(got) == {"/dev/ttyUSB0", "usb:1-4"}
    assert got["/dev/ttyUSB0"]["name"] == "CH340" and got["/dev/ttyUSB0"]["usb"] == "1a86:7523"
    assert got["/dev/ttyUSB0"]["kind"] == "serial" and got["/dev/ttyUSB0"]["for"] == "esp32"
    assert got["usb:1-4"]["name"] == "ST-Link/V2" and got["usb:1-4"]["kind"] == "probe"
    assert got["usb:1-4"]["for"] == "stm32"


def test_only_listed_ports_are_accepted(tmp_path, monkeypatch):
    _fake_sys(tmp_path, monkeypatch)
    assert device.port_named("/dev/ttyUSB0", "serial")["name"] == "CH340"
    for bad, kind in (("/etc/passwd", None), ("/dev/ttyS0", "serial"), ("../ttyUSB0", None),
                      ("usb:1-4", "serial"), ("/dev/ttyUSB0 ; rm -rf /", None)):
        with pytest.raises(HTTPException) as e:
            device.port_named(bad, kind)
        assert e.value.status_code == 400
    c, _ = _client(monkeypatch)
    r = c.post("/api/embedded/fw/serial/write", json={"port": "/dev/tty", "text": "x"})
    assert r.status_code == 400 and "plugged in" in r.json()["detail"]
    r = c.get("/api/embedded/fw/serial/stream", params={"port": "/etc/shadow"})
    assert r.status_code == 400
    r = c.get("/api/embedded/fw/serial/stream", params={"port": "/dev/ttyUSB0", "baud": 123})
    assert r.status_code == 400
    r = c.post("/api/embedded/fw/flash", json={"port": "/dev/sda"})
    assert r.status_code == 400


def test_extra_ports_come_from_the_environment(tmp_path, monkeypatch):
    _fake_sys(tmp_path, monkeypatch)
    f = tmp_path / "pty"
    f.write_text("")
    monkeypatch.setenv("X3_SERIAL_EXTRA", f"{f},/does/not/exist")
    ids = [p["id"] for p in device.list_ports()]
    assert str(f) in ids and "/does/not/exist" not in ids


# -- the monitor ---------------------------------------------------------------

def _events(chunks: list[str]) -> list[tuple[str, dict]]:
    out = []
    for c in chunks:
        if c.startswith(":"):
            continue
        assert c.endswith("\n\n") and c.count("\n") == 3, c
        ev, data = c.strip("\n").split("\n")
        assert ev.startswith("event: ") and data.startswith("data: ")
        out.append((ev[7:], json.loads(data[6:])))
    return out


def test_frame_keeps_newlines_out():
    text = device.frame("line", {"text": "a\nb\r\n"})
    assert text.count("\n") == 3 and json.loads(text.split("\n")[1][6:])["text"] == "a\nb\r\n"


def test_monitor_streams_and_writes_through_a_pty(monkeypatch):
    master, slave = os.openpty()
    path = os.ttyname(slave)

    async def go():
        hub = device.Hub(idle_s=0.2)
        mon = hub.get(path, 115200)
        q = mon.subscribe()
        chunks: list[str] = []

        async def read():
            async for c in device.sse(mon, q, None, limit=4):
                chunks.append(c)
        reader = asyncio.create_task(read())
        for _ in range(100):
            if mon.state == "open":
                break
            await asyncio.sleep(0.02)
        assert mon.state == "open" and mon.where == "host"
        os.write(master, b"I (1216) heap_init: ok\r\nready - type ")
        await asyncio.sleep(0.05)
        os.write(master, b"help\n> ")       # the prompt has no newline: shown after a quiet spell
        await asyncio.sleep(0.5)
        await mon.write("status\r\n")
        got = b""
        for _ in range(50):
            try:
                got += os.read(master, 100)
            except BlockingIOError:
                pass
            if got.endswith(b"\r\n"):
                break
            await asyncio.sleep(0.02)
        assert got == b"status\r\n"
        await asyncio.wait_for(reader, 3)
        # the last viewer went: the port is let go after idle_s
        await asyncio.sleep(0.8)
        assert path not in hub.monitors and mon.state == "closed"
        return chunks

    os.set_blocking(master, False)
    try:
        chunks = asyncio.run(go())
    finally:
        os.close(master)
        os.close(slave)
    ev = _events(chunks)
    assert ev[0][0] == "hello" and ev[0][1]["baud"] == 115200
    lines = [(d["dir"], d["text"]) for e, d in ev if e == "line"]
    assert lines == [("rx", "I (1216) heap_init: ok"), ("rx", "ready - type help"), ("rx", "> "),
                     ("tx", "status")]
    ns = [d["n"] for e, d in ev if e == "line"]
    assert ns == sorted(ns)


def test_monitor_lets_go_while_paused():
    master, slave = os.openpty()
    path = os.ttyname(slave)

    async def go():
        hub = device.Hub(idle_s=5)
        mon = hub.get(path, 115200)
        mon.subscribe()
        for _ in range(100):
            if mon.state == "open":
                break
            await asyncio.sleep(0.02)
        hub.pause(path, "flashing")
        await asyncio.sleep(0.1)
        assert mon.state == "paused" and mon.link is None
        with pytest.raises(HTTPException) as e:
            await mon.write("x")
        assert e.value.status_code == 409
        hub.resume(path)
        for _ in range(100):
            if mon.state == "open":
                break
            await asyncio.sleep(0.02)
        assert mon.state == "open"
        await mon.stop()

    try:
        asyncio.run(go())
    finally:
        os.close(master)
        os.close(slave)


def test_stream_route_over_a_pty(monkeypatch):
    master, slave = os.openpty()
    path = os.ttyname(slave)
    monkeypatch.setenv("X3_SERIAL_EXTRA", path)
    monkeypatch.setattr(device, "SYS", device.Path("/nonexistent"))
    monkeypatch.setattr(device, "HUB", device.Hub(idle_s=0.1))
    import threading

    def board():
        time.sleep(0.4)
        os.write(master, b"boot\nhello\n")
    threading.Thread(target=board, daemon=True).start()
    c, _ = _client(monkeypatch)
    try:
        with c:
            with c.stream("GET", "/api/embedded/fw/serial/stream",
                          params={"port": path, "baud": 9600, "limit": 2}) as r:
                assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
                body = "".join(r.iter_text())
    finally:
        os.close(master)
        os.close(slave)
    parts = [p + "\n\n" for p in body.split("\n\n") if p]
    ev = _events(parts)
    assert [e for e, _ in ev if e == "line"] == ["line", "line"]
    assert [d["text"] for e, d in ev if e == "line"] == ["boot", "hello"]


# -- flashing ------------------------------------------------------------------

FAKE = ("echo 'Connecting....'; printf 'Writing at 0x00010000... (50 %%)\\r"
        "Writing at 0x00020000... (100 %%)\\n'; sleep 0.3; echo 'Hard resetting via RTS pin...'")


def _fake_port(monkeypatch, path="/dev/ttyUSB0"):
    port = {"id": path, "kind": "serial", "path": path, "name": "CH340", "usb": "1a86:7523"}
    monkeypatch.setattr(device, "list_ports", lambda: [port])
    return port


def _wait(c, until=lambda j: j and j["state"] != "running"):
    for _ in range(200):
        j = c.get("/api/embedded/fw/flash").json()
        if until(j):
            return j
        time.sleep(0.02)
    raise AssertionError(j)


def test_flash_job_reports_progress(monkeypatch):
    _fake_port(monkeypatch)
    seen = {}

    def argv(app, cmd, devices, name):
        seen.update(cmd=cmd, devices=devices)
        return ["bash", "-c", FAKE]
    monkeypatch.setattr(device, "flash_argv", argv)
    monkeypatch.setattr(device, "HUB", device.Hub())
    c, db = _client(monkeypatch)
    with c:
        r = c.post("/api/embedded/fw/flash", json={"port": "/dev/ttyUSB0", "erase": True})
        assert r.status_code == 200 and r.json()["state"] == "running"
        assert c.post("/api/embedded/fw/flash", json={"port": "/dev/ttyUSB0"}).status_code == 409
        mid = _wait(c, lambda j: j and j["pct"] == 100)
        if mid["state"] == "running":        # the monitor on that port lets go meanwhile
            assert device.HUB.paused.get("/dev/ttyUSB0") == "flashing"
        j = _wait(c)
    assert seen["cmd"].endswith("-p /dev/ttyUSB0 erase-flash flash")
    assert seen["devices"] == ["--device", "/dev/ttyUSB0"]
    assert j["state"] == "done" and j["rc"] == 0 and j["pct"] == 100 and j["stage"] == "resetting"
    assert "Writing at 0x00010000... (50 %)" in j["lines"]
    assert "/dev/ttyUSB0" not in device.HUB.paused
    flashed = db["apps"].docs[0]["flashed"]
    assert flashed["ok"] and flashed["port"] == "/dev/ttyUSB0"
    tail = c.get("/api/embedded/fw/flash", params={"since": j["n"] - 1}).json()["lines"]
    assert tail == ["Hard resetting via RTS pin..."]


def test_flash_job_failure(monkeypatch):
    _fake_port(monkeypatch)
    monkeypatch.setattr(device, "flash_argv", lambda *a: ["bash", "-c", "echo 'Failed to connect'; exit 2"])
    c, db = _client(monkeypatch)
    with c:
        c.post("/api/embedded/fw/flash", json={"port": "/dev/ttyUSB0"})
        j = _wait(c)
    assert j["state"] == "failed" and j["rc"] == 2 and "Failed to connect" in j["lines"]
    assert db["apps"].docs[0]["flashed"]["ok"] is False


def test_flash_needs_a_build(monkeypatch):
    _fake_port(monkeypatch)
    c, _ = _client(monkeypatch, {**APP, "firmware": {"ok": False}})
    r = c.post("/api/embedded/fw/flash", json={"port": "/dev/ttyUSB0"})
    assert r.status_code == 400 and "build" in r.json()["detail"]


def test_stm32_flash_goes_through_the_probe():
    app = {**APP, "target": "stm32", "flash": None}
    probe = {"id": "usb:1-4", "kind": "probe", "path": None}
    cmd, devices = device.flash_command(app, "stm32", probe, erase=True)
    assert cmd.startswith("st-flash --connect-under-reset erase && openocd")
    assert devices == ["--device", "/dev/bus/usb"]


# -- what the board's netlist says ---------------------------------------------

def test_board_note_reads_the_auto_program_circuit(monkeypatch):
    from backend import store
    from backend.sim import board as simboard
    n = lambda name, *nodes: {"name": name, "nodes": [{"ref": r, "pin": p} for r, p in nodes]}
    graph = {"components": [{"ref": "U2", "value": "ESP32-WROOM-32", "footprint": "WIFIM-SMD_ESP32-WROOM-32-N4",
                             "part": "C82899"},
                            {"ref": "USB1", "footprint": "USB-C-SMD_TYPE-C16PIN"},
                            *({"ref": r} for r in ("Q1", "Q2", "R5", "R7", "U5"))],
             "nets": [n("DTR", ("Q1", "2"), ("R7", "1"), ("U5", "13")),
                      n("RTS", ("Q2", "2"), ("R5", "1"), ("U5", "14")),
                      n("ESP_EN", ("Q2", "3"), ("U2", "3")), n("ESP_IO0", ("Q1", "3"), ("U2", "25")),
                      n("Q1_1", ("Q1", "1"), ("R5", "2")), n("Q2_1", ("Q2", "1"), ("R7", "2"))]}

    async def get_artifact(db_, bid, label, collection="models"):
        return json.dumps(graph).encode()

    async def pins(db_, code):
        return {"3": "EN", "25": "GPIO0"}
    monkeypatch.setattr(store, "get_artifact", get_artifact)
    monkeypatch.setattr(simboard, "mcu_pin_names", pins)
    db = FakeDb(boards=_Col([{"_id": "b1", "title": "DemoBoard"}]))
    note = asyncio.run(device.board_note(db, {**APP, "board": "b1"}))
    assert note["title"] == "DemoBoard" and note["usb"] == "USB-C"
    assert note["auto"] == {"en": "Q2", "io0": "Q1", "en_net": "ESP_EN", "io0_net": "ESP_IO0",
                            "bridge": "U5", "lines": ["DTR", "RTS"]}
    # without the transistors there is nothing to say about it
    graph["nets"] = graph["nets"][:2] + [n("ESP_EN", ("U2", "3")), n("ESP_IO0", ("U2", "25"))]
    assert asyncio.run(device.board_note(db, {**APP, "board": "b1"}))["auto"] is None
    assert asyncio.run(device.board_note(db, APP)) is None
