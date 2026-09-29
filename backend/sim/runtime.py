"""The board: parts from sim.json + catalog, messages routed between them and the MCU.

Messages from the MCU go in through handle(); everything for the MCU
(part emits and transaction replies) collects in the outbox, which the
adapter drains. Time moves with the `t` on the MCU's messages, and between
them with the wall clock (run()).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict

from .messages import validate
from .parts import load_catalog, make_part, reply

log = logging.getLogger(__name__)

TICK_S = 0.05                        # how often time moves between the MCU's messages


class Board:
    def __init__(self, sim: dict, catalog: dict | None = None):
        self.sim, self.catalog = sim, catalog or load_catalog()
        self.outbox: list[dict] = []
        self.uart: list[dict] = []           # transcript: {"t", "port", "dir": "out"|"in", "data"}
        self.t = 0
        self._kick: asyncio.Event | None = None
        self.parts, self.by_pin, self.by_addr = {}, defaultdict(list), {}
        for entry in sim.get("parts", []):
            spec = {**self.catalog["models"][entry["model"]], **entry}
            part = self.parts[entry["ref"]] = make_part(entry["ref"], spec, self._emit)
            if "addr" in entry:
                self.by_addr[("i2c", entry.get("bus", "I2C0"), int(entry["addr"]))] = part
            elif "cs" in entry:
                self.by_addr[("spi", entry.get("bus", "SPI0"), entry["cs"])] = part
            for pin in (entry.get("pins") or {}).values():
                self.by_pin[pin].append(part)

    def _emit(self, msg: dict) -> None:
        self.outbox.append(msg)
        if self._kick:
            self._kick.set()

    def handle(self, msg: dict) -> None:
        """One message from the MCU."""
        errors = validate(msg)
        if errors:
            log.warning("sim: dropped %s: %s", msg, "; ".join(errors))
            return
        if "t" in msg:
            self.tick(msg["t"])
        kind = msg["type"]
        if kind in ("pin", "pwm"):
            for part in self.by_pin.get(msg["pin"], []):
                part.on(msg)
        elif kind in ("i2c", "spi"):
            part = self.by_addr.get((kind, msg["bus"], msg["addr" if kind == "i2c" else "cs"]))
            if part is None:                 # nobody at the address: NACK; the lines read high
                self._emit(reply(msg, b"\xff" * int(msg["read"]), ack=False))
            else:
                self._emit(part.on(msg) or reply(msg))
        elif kind == "uart":
            self.uart.append({"t": self.t, "port": msg["port"], "dir": "out", "data": msg["data"]})

    def write_uart(self, port: str, text: str) -> None:
        """Type into the MCU's serial port."""
        self.uart.append({"t": self.t, "port": port, "dir": "in", "data": text})
        self._emit({"type": "uart", "port": port, "data": text})

    def act(self, ref: str, action: dict) -> None:
        self.parts[ref].act(action)

    def tick(self, t_us: int) -> None:
        self.t = max(self.t, int(t_us))
        for part in self.parts.values():
            part.tick(self.t)

    def drain(self) -> list[dict]:
        out, self.outbox = self.outbox, []
        return out

    def snapshot(self) -> dict:
        return {"t": self.t, "parts": {ref: p.view() for ref, p in self.parts.items()},
                "uart": list(self.uart)}

    async def run(self, adapter, firmware) -> None:
        """Pump the adapter's events into the board and the board's outbox into the adapter."""
        self._kick = asyncio.Event()

        async def pump():
            while True:
                await self._kick.wait()
                self._kick.clear()
                for msg in self.drain():
                    await adapter.send(msg)

        # Time moves while the firmware is quiet too: a fan spinning up after
        # one PWM write must not stop until the next message. The emulators
        # run close to real time, so between messages the clock is the last
        # message's time plus the wall time since it.
        seen = {"t": self.t, "at": time.monotonic()}

        async def clock():
            while True:
                await asyncio.sleep(TICK_S)
                self.tick(seen["t"] + int((time.monotonic() - seen["at"]) * 1e6))

        await adapter.start(firmware, self.sim)
        sender = asyncio.create_task(pump())
        ticker = asyncio.create_task(clock())
        self._kick.set()                     # what the parts said at start (a button's level)
        try:
            async for msg in adapter.events():
                if "t" in msg:
                    seen["t"], seen["at"] = int(msg["t"]), time.monotonic()
                self.handle(msg)
                await asyncio.sleep(0)       # let the reply go out before the next event
        finally:
            ticker.cancel()
            sender.cancel()
            for msg in self.drain():
                await adapter.send(msg)
            self._kick = None
            await adapter.stop()
