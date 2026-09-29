"""The simulator's sessions, routes and command line, with a fake emulator."""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.sim import api as simapi
from backend.sim import service
from backend.sim.service import SimError, Sims

ROOT = Path(__file__).resolve().parent.parent

SIM = {"mcu": {"family": "fake", "emulator": "fake"},
       "parts": [{"ref": "J1", "model": "fan", "pins": {"pwm": "GPIO18", "tach": "GPIO19"}},
                 {"ref": "LED1", "model": "led", "pins": {"A": "GPIO2"}},
                 {"ref": "SW1", "model": "button", "pins": {"1": "GPIO0"}}]}


class FakeAdapter:
    name = "fake"
    fail: str | None = None

    def __init__(self):
        self.q: asyncio.Queue = asyncio.Queue()
        self.sent: list[dict] = []
        self.firmware = None
        self.stopped = 0

    async def start(self, firmware, board):
        if self.fail:
            raise RuntimeError(self.fail)
        self.firmware = firmware
        self.q.put_nowait({"type": "uart", "port": "UART0", "data": "ready\n"})

    async def events(self):
        while (m := await self.q.get()) is not None:
            yield m

    async def send(self, msg):
        self.sent.append(msg)
        if msg["type"] == "uart":                       # the firmware answers a line
            self.q.put_nowait({"type": "uart", "port": "UART0", "data": f"ok {msg['data'].strip()}\n"})

    async def stop(self):
        self.stopped += 1
        self.q.put_nowait(None)


async def until(pred, timeout=3.0):
    async def poll():
        while not pred():
            await asyncio.sleep(0.01)
    await asyncio.wait_for(poll(), timeout)


def sims(**kw) -> Sims:
    return Sims(adapters={"fake": FakeAdapter}, **kw)


def test_session_runs_acts_and_stops():
    async def go():
        s = sims()
        sess = await s.launch("app", SIM, Path("/fw"))
        await until(lambda: sess.state == "running")
        adapter = sess.adapter.inner
        assert adapter.firmware == Path("/fw")
        await until(lambda: any(e["data"] == "ready\n" for e in sess.board.uart))
        # the button's released level went out at start; a press drives it low
        s.act("app", "SW1", {"press": True})
        await until(lambda: {"type": "pin", "pin": "GPIO0", "level": 0} in adapter.sent)
        s.uart("app", "UART0", "status\r\n")
        await until(lambda: "ok status" in "".join(e["data"] for e in sess.board.uart))
        adapter.q.put_nowait({"type": "pwm", "t": 1000, "pin": "GPIO2", "duty": 0.5, "hz": 1000})
        await until(lambda: s.snapshot("app")["parts"]["LED1"] == {"glow": 0.5})
        snap = s.snapshot("app")
        assert snap["state"] == "running" and snap["parts"]["SW1"] == {"pressed": True}
        assert [e["dir"] for e in snap["uart"]] == ["out", "in", "out"]
        with pytest.raises(SimError) as e:
            s.act("app", "NOPE", {"press": True})
        assert e.value.status == 404 and "SW1" in str(e.value)
        await s.stop("app")
        assert sess.state == "stopped" and adapter.stopped >= 1 and sess.task.done()
        with pytest.raises(SimError) as e:
            s.uart("app", "UART0", "x")
        assert e.value.status == 409
    asyncio.run(go())


def test_restart_replaces_the_session_and_limits_hold():
    async def go():
        s = sims(max_sessions=1)
        a = await s.launch("app", SIM, Path("/fw"))
        await until(lambda: a.state == "running")
        b = await s.launch("app", SIM, Path("/fw"))       # the same app: the old one goes
        assert a.state == "stopped" and s.get("app") is b
        with pytest.raises(SimError) as e:
            await s.launch("other", SIM, Path("/fw"))
        assert e.value.status == 429 and "app" in str(e.value)
        await s.shutdown()
    asyncio.run(go())


def test_idle_and_runaway_sessions_are_stopped():
    async def go():
        s = sims(idle_s=0.05)
        a = await s.launch("app", SIM, Path("/fw"))
        await until(lambda: a.state == "running")
        await asyncio.sleep(0.1)
        await s.sweep()
        assert a.state == "stopped" and "nobody watched" in a.error
        s2 = sims(max_run_s=0.0)
        b = await s2.launch("app", SIM, Path("/fw"))
        await until(lambda: b.state == "running")
        await s2.sweep()
        assert b.state == "stopped" and "at most" in b.error
    asyncio.run(go())


def test_a_failing_emulator_says_why(monkeypatch):
    monkeypatch.setattr(FakeAdapter, "fail", "firmware build failed: boom")

    async def go():
        s = sims()
        a = await s.launch("app", SIM, Path("/fw"))
        await until(lambda: a.state == "failed")
        assert "boom" in s.snapshot("app")["error"]
    asyncio.run(go())


def test_unknown_emulator_is_a_clear_error():
    with pytest.raises(SimError) as e:
        sims().adapter_for({"mcu": {"family": "stm32f0", "emulator": "renode"}})
    assert "renode" in str(e.value) and "fake" in str(e.value)


def test_uart_transcript_is_coalesced_and_cut():
    entries = [{"t": i, "port": "UART0", "dir": "out", "data": "x" * 100} for i in range(300)]
    entries.append({"t": 301, "port": "UART0", "dir": "in", "data": "hi"})
    out = service.coalesce(entries)
    assert [e["dir"] for e in out] == ["out", "in"]
    assert sum(len(e["data"]) for e in out) <= service.UART_CHARS


# -- sim.json for an app -------------------------------------------------------

def test_firmware_dir_follows_the_build_command():
    app = {"repo": "/r", "cwd": "firmware", "build": "idf.py -C esp32 -B $BUILD build"}
    assert service.firmware_dir(app) == Path("/r/firmware/esp32")
    assert service.firmware_dir({"repo": "/r", "build": "make -j4"}) == Path("/r")
    assert service.firmware_dir({**app, "sim_firmware": "other"}) == Path("/r/firmware/other")
    # cmake names the source with -S; `ninja -C $BUILD` is the output directory.
    stm = {"repo": "/r", "cwd": "firmware",
           "build": "cmake -S stm32 -B $BUILD -G Ninja && ninja -C $BUILD"}
    assert service.firmware_dir(stm) == Path("/r/firmware/stm32")


def test_merge_keeps_hand_corrections():
    found = {"mcu": {"family": "esp32", "emulator": "qemu-esp32"},
             "parts": [{"ref": "LED1", "model": "led", "pins": {"A": "GPIO2"}},
                       {"ref": "SW1", "model": "button", "pins": {"1": "GPIO0"}}], "skipped": []}
    got = service.merge(found, {"parts": [{"ref": "LED1", "pins": {"K": "GPIO4"}}, {"ref": "SW1", "skip": True},
                                          {"ref": "J1", "model": "fan", "pins": {"pwm": "GPIO18"}}]})
    assert [p["ref"] for p in got["parts"]] == ["LED1", "J1"]
    assert got["parts"][0] == {"ref": "LED1", "model": "led", "pins": {"K": "GPIO4"}}
    assert {"ref": "SW1", "why": "left out by hand"} in got["skipped"]
    assert found["parts"][0]["pins"] == {"A": "GPIO2"}                  # not changed in place
    assert service.merge(found, {"replace": True, "mcu": {"emulator": "x"}})["parts"] == []


class _Col:
    def __init__(self, docs):
        self.docs = docs

    async def find_one(self, q, proj=None):
        return next((d for d in self.docs if d["_id"] == q["_id"]), None)

    def find(self, *a, **k):
        async def it():
            for d in self.docs:
                yield d
        return it()


class FakeDb(dict):
    def __getitem__(self, k):
        return self.setdefault(k, _Col([]))


GRAPH = {"components": [{"ref": "U1", "value": "ESP32-WROOM-32", "footprint": "", "part": "C82899"},
                        {"ref": "LED1", "value": "red", "footprint": "LED0603", "part": "C2286"}],
         "nets": [{"name": "led", "code": 1, "nodes": [{"ref": "U1", "pin": "24"}, {"ref": "LED1", "pin": "2"}]}]}


def _fake_db(monkeypatch, app: dict, graph=GRAPH):
    from backend import store
    from backend.sim import board as simboard
    db = FakeDb(apps=_Col([app]), boards=_Col([{"_id": "b1", "artifacts": {"graph": {}, "model3d": {}}}]))

    async def get_artifact(db_, bid, label, collection="models"):
        if graph is None:
            raise KeyError(label)
        return json.dumps(graph).encode()

    async def pins(db_, code):
        return {"24": "GPIO2"}
    monkeypatch.setattr(store, "get_artifact", get_artifact)
    monkeypatch.setattr(simboard, "mcu_pin_names", pins)
    return db


APP = {"_id": "fw", "platform": "embedded", "repo": "/r", "cwd": "fw", "build": "idf.py -C esp32 build"}


def test_resolve_asks_for_a_board_link(monkeypatch):
    db = _fake_db(monkeypatch, APP)
    with pytest.raises(SimError) as e:
        asyncio.run(service.resolve(db, "fw"))
    assert e.value.status == 409 and "link" in str(e.value) and "b1" in str(e.value)
    with pytest.raises(SimError) as e:
        asyncio.run(service.resolve(db, "nope"))
    assert e.value.status == 404


def test_resolve_describes_the_linked_board(monkeypatch):
    db = _fake_db(monkeypatch, {**APP, "board": "b1",
                                "sim": {"parts": [{"ref": "J9", "model": "fan", "pins": {"pwm": "GPIO18"}}]}})
    got = asyncio.run(service.resolve(db, "fw"))
    assert got["board"] == "b1" and got["glb"] and got["firmware"] == Path("/r/fw/esp32")
    assert got["sim"]["mcu"]["emulator"] == "qemu-esp32"
    assert [(p["ref"], p["pins"]) for p in got["sim"]["parts"]] == [("LED1", {"A": "GPIO2"}),
                                                                    ("J9", {"pwm": "GPIO18"})]
    models = service.models_of(got["sim"], service.load_catalog())
    assert models["LED1"]["block"] == "light" and models["LED1"]["view"]["glow"]


def test_resolve_without_a_netlist(monkeypatch):
    db = _fake_db(monkeypatch, {**APP, "board": "b1"}, graph=None)
    with pytest.raises(SimError) as e:
        asyncio.run(service.resolve(db, "fw"))
    assert "netlist" in str(e.value)


def test_screen_png():
    import base64
    view = {"screen": {"w": 8, "h": 2, "bits": base64.b64encode(b"\x80\x01").decode()}}
    png = service.screen_png(view, scale=2)
    assert png.startswith(b"\x89PNG") and b"IHDR" in png
    assert service.describe_view(view) == "screen 8x2, 2 pixels lit"


# -- the routes ----------------------------------------------------------------

def _client(monkeypatch, s: Sims) -> TestClient:
    app = FastAPI()
    app.include_router(simapi.router)
    monkeypatch.setattr(simapi, "SIMS", s)
    monkeypatch.setattr(simapi, "EVERY_S", 0.001)
    return TestClient(app)


def _events(text: str) -> list[dict]:
    return [json.loads(block.split("data: ", 1)[1]) for block in text.split("\n\n")
            if block.startswith("event: snapshot")]


def test_events_stream_snapshots_only_on_change(monkeypatch):
    s = sims()
    frames = iter([{"state": "running", "n": 1}, {"state": "running", "n": 1},
                   {"state": "running", "n": 1}, {"state": "running", "n": 2}])
    calls = []

    def snapshot(app, touch=True):
        calls.append(app)
        return next(frames)
    monkeypatch.setattr(s, "snapshot", snapshot)
    r = _client(monkeypatch, s).get("/api/sim/fw/events?limit=2")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    assert [e["n"] for e in _events(r.text)] == [1, 2] and len(calls) == 4


def test_events_of_a_session(monkeypatch):
    s = sims()
    sess = service.Session("fw", SIM, Path("/fw"), FakeAdapter())
    sess.state = "running"
    s.sessions["fw"] = sess
    got = _events(_client(monkeypatch, s).get("/api/sim/fw/events?limit=1").text)
    assert got[0]["state"] == "running" and set(got[0]["parts"]) == {"J1", "LED1", "SW1"}


def test_routes_refuse_what_is_not_running(monkeypatch):
    c = _client(monkeypatch, sims())
    r = c.post("/api/sim/fw/act", json={"ref": "SW1", "action": {"press": True}})
    assert r.status_code == 409 and "not running" in r.json()["detail"]
    assert c.post("/api/sim/fw/stop").json() == {"ok": True, "state": "idle"}


# -- the command line ------------------------------------------------------------

def _revisions():
    spec = importlib.util.spec_from_file_location("revisions_cli", ROOT / "tools" / "revisions.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_sim_run_arguments():
    rev = _revisions()
    args = argparse.Namespace(press=["SW1@2", "SW2"], uart=["speed 60", "status@3.5", "a@b"],
                              set=["RV1=30@1", "U3.temperature=40"], shot=["OLED=o.png"], for_s=5.0)
    plan = rev.sim_plan(args)
    assert plan == sorted(plan, key=lambda x: x[0])
    assert (2.0, "act", ("SW1", {"press": True})) in plan and (2.2, "act", ("SW1", {"press": False})) in plan
    assert (1.0, "act", ("SW2", {"press": True})) in plan
    assert (3.5, "uart", "status\r\n") in plan and (0.5, "uart", "speed 60\r\n") in plan
    assert (0.5, "uart", "a@b\r\n") in plan
    assert (1.0, "act", ("RV1", {"value": 30.0})) in plan
    assert (0.0, "act", ("U3", {"temperature": 40.0})) in plan
    for bad in (dict(set=["RV1"]), dict(set=["RV1=x"]), dict(shot=["o.png"]), dict(press=["SW1@9"])):
        with pytest.raises(ValueError):
            rev.sim_plan(argparse.Namespace(**{"press": None, "uart": None, "set": None, "shot": None,
                                               "for_s": 5.0, **bad}))
