"""Part models (SPEC section 3): the base class and the six building blocks.

A part gets `spec` = its catalog model merged with its sim.json entry, so
`spec["pins"]` is {role: MCU pin name} and every block option (active,
pull, min, max, max_rpm...) is a plain key. Parts talk to the MCU only
through `emit(msg)`.
"""

from __future__ import annotations

import base64
import importlib
import math
from pathlib import Path

import yaml

CATALOG = Path(__file__).with_name("catalog.yaml")


def load_catalog(path: Path = CATALOG) -> dict:
    return yaml.safe_load(Path(path).read_text())


def reply(msg: dict, data: bytes = b"", ack: bool = True) -> dict:
    """The answer to an i2c/spi transaction: exactly `read` bytes long."""
    want = int(msg.get("read") or 0)
    data = bytes(data[:want]).ljust(want, b"\0")
    return {"type": "reply", "id": msg.get("id"), "data": data.hex(), "ack": ack}


class Part:
    def __init__(self, ref: str, spec: dict, emit):
        self.ref, self.spec, self.emit = ref, spec, emit
        self.pins: dict = dict(spec.get("pins") or {})
        self.pin = next(iter(self.pins.values()), None)   # the one pin of a one-pin part

    def on(self, msg: dict) -> dict | None:
        return None

    def act(self, action: dict) -> None:
        pass

    def tick(self, t_us: int) -> None:
        pass

    def view(self) -> dict:
        return {}


class Light(Part):
    """pin or pwm -> brightness 0..1. Driven on the cathode, or `active: low`, it is lit by a 0."""

    def __init__(self, ref, spec, emit):
        super().__init__(ref, spec, emit)
        self.low = spec.get("active") == "low" or ("K" in self.pins and "A" not in self.pins)
        self.glow = 0.0

    def on(self, msg):
        on = msg["level"] if msg["type"] == "pin" else msg["duty"] if msg["type"] == "pwm" else None
        if on is not None and not self.spec.get("dead"):    # wired to nothing: never lit
            self.glow = float(1 - on if self.low else on)

    def view(self):
        return {"glow": round(self.glow, 4)}


class Press(Part):
    """{"press": bool} -> pin level; released reads 1 with a pull-up, 0 with a pull-down."""

    def __init__(self, ref, spec, emit):
        super().__init__(ref, spec, emit)
        self.pressed = False
        self._send()

    def _send(self):
        up = self.spec.get("pull", "up") == "up"
        self.emit({"type": "pin", "pin": self.pin, "level": int(up != self.pressed)})

    def act(self, action):
        if "press" in action and bool(action["press"]) != self.pressed:
            self.pressed = bool(action["press"])
            self._send()

    def view(self):
        return {"pressed": self.pressed}


class Level(Part):
    """{"value": v} -> adc volts; `volts: [v_at_min, v_at_max]` maps the slider linearly."""

    def __init__(self, ref, spec, emit):
        super().__init__(ref, spec, emit)
        self.lo, self.hi = spec.get("min", 0.0), spec.get("max", 1.0)
        self.value = spec.get("value", self.lo)
        self.act({"value": self.value})

    def volts(self) -> float:
        v0, v1 = self.spec.get("volts", [0.0, 3.3])
        return v0 + (self.value - self.lo) / ((self.hi - self.lo) or 1) * (v1 - v0)

    def act(self, action):
        if "value" in action:
            self.value = min(max(float(action["value"]), self.lo), self.hi)
            self.emit({"type": "adc", "pin": self.pin, "volts": round(self.volts(), 6)})

    def view(self):
        return {"value": self.value, "min": self.lo, "max": self.hi,
                "unit": self.spec.get("unit", ""), "volts": round(self.volts(), 4)}


class Motor(Part):
    """pwm duty -> target rpm = max_rpm*duty, reached with a first-order lag (tau seconds);
    the tach pin gets freq = rpm/60*pulses_per_rev whenever rpm moves by more than 1."""

    def __init__(self, ref, spec, emit):
        super().__init__(ref, spec, emit)
        self.duty = self.rpm = 0.0
        self.sent, self.t = None, None

    def on(self, msg):
        if msg.get("pin") == self.pins.get("pwm"):
            if msg["type"] == "pwm":
                self.duty = float(msg["duty"])
            elif msg["type"] == "pin":
                self.duty = float(msg["level"])

    def tick(self, t_us):
        target = self.spec.get("max_rpm", 3000) * self.duty
        if self.t is not None and t_us > self.t:
            k = 1 - math.exp(-(t_us - self.t) / 1e6 / self.spec.get("tau", 0.5))
            self.rpm += (target - self.rpm) * k
            if abs(target - self.rpm) < 0.5:
                self.rpm = target          # settle, so a stopped fan reports exactly 0
        self.t = t_us
        moved = self.sent is None or abs(self.rpm - self.sent) > 1 \
            or (self.rpm == target and self.rpm != self.sent)
        if "tach" in self.pins and moved:
            self.sent = self.rpm
            self.emit({"type": "freq", "pin": self.pins["tach"],
                       "hz": round(self.rpm / 60 * self.spec.get("pulses_per_rev", 2), 4)})

    def view(self):
        return {"rpm": round(self.rpm), "duty": self.duty}


class Regs(Part):
    """An I2C register map. The first written byte is the register pointer, the rest are
    written into the registers from there; reads walk forward from the pointer.

    regs: {0: {from: temperature, scale: 0.0625, offset: 0, bits: 12, shift: 4,
               signed: true, bytes: 2, endian: big}, 1: {value: 0x60A0, bytes: 2}}
    sliders: {temperature: {min: -40, max: 125, value: 25, unit: C}}
    """

    def __init__(self, ref, spec, emit):
        super().__init__(ref, spec, emit)
        self.regs = {int(k, 0) if isinstance(k, str) else int(k): r
                     for k, r in (spec.get("regs") or {}).items()}
        self.sliders = {k: dict(v) for k, v in (spec.get("sliders") or {}).items()}
        self.written: dict[int, bytes] = {}
        self.ptr = 0

    def _size(self, r: dict) -> int:
        return r.get("bytes") or math.ceil((r.get("bits", 8) + r.get("shift", 0)) / 8)

    def read_reg(self, addr: int) -> bytes:
        r = self.regs.get(addr)
        if r is None:
            return b"\0"
        n = self._size(r)
        if addr in self.written:
            return self.written[addr][:n].ljust(n, b"\0")
        if "from" in r:
            bits = r.get("bits", 8)
            raw = round((self.sliders[r["from"]].get("value", 0) - r.get("offset", 0)) / r.get("scale", 1))
            lo, hi = (-(1 << bits - 1), (1 << bits - 1) - 1) if r.get("signed") else (0, (1 << bits) - 1)
            raw = (min(max(raw, lo), hi) & ((1 << bits) - 1)) << r.get("shift", 0)
        else:
            raw = int(r.get("value", 0))
        return raw.to_bytes(n, r.get("endian", "big"))

    def on(self, msg):
        if msg["type"] not in ("i2c", "spi"):
            return None
        data = bytes.fromhex(msg.get("write") or "")
        if data:
            self.ptr, rest = data[0], data[1:]
            at = self.ptr
            while rest:
                n = self._size(self.regs[at]) if at in self.regs else 1
                self.written[at], rest, at = rest[:n], rest[n:], at + 1
        out, at = b"", self.ptr
        while len(out) < int(msg.get("read") or 0):
            out += self.read_reg(at)
            at = (at + 1) & 0xFF
        return reply(msg, out)

    def act(self, action):
        for key, value in action.items():
            name = next(iter(self.sliders), None) if key == "value" else key
            if name in self.sliders:
                s = self.sliders[name]
                s["value"] = min(max(float(value), s.get("min", -math.inf)), s.get("max", math.inf))

    def view(self):
        return {"sliders": self.sliders}


class Screen(Part):
    """A 1-bit frame buffer. view(): rows packed MSB first (leftmost pixel = bit 7), base64."""

    def __init__(self, ref, spec, emit):
        super().__init__(ref, spec, emit)
        self.w, self.h = int(spec.get("width", 128)), int(spec.get("height", 64))
        self.px = bytearray(self.w * self.h)

    def set(self, x: int, y: int, on) -> None:
        self.px[y * self.w + x] = 1 if on else 0

    def get(self, x: int, y: int) -> int:
        return self.px[y * self.w + x]

    def view(self):
        stride, out = (self.w + 7) // 8, bytearray()
        for y in range(self.h):
            row = bytearray(stride)
            for x in range(self.w):
                if self.px[y * self.w + x]:
                    row[x >> 3] |= 0x80 >> (x & 7)
            out += row
        return {"screen": {"w": self.w, "h": self.h, "bits": base64.b64encode(bytes(out)).decode()}}


class Quad(Part):
    """A quadrature encoder: {"turn": n} steps it n detents (negative the
    other way), {"press": bool} is its push switch. Pins A and B idle high
    (pull-ups); clockwise, A falls first, and a detent is one whole cycle
    of four states, one every `step_us` of virtual time."""

    CW = [(0, 1), (0, 0), (1, 0), (1, 1)]
    CCW = [(1, 0), (0, 0), (0, 1), (1, 1)]

    def __init__(self, ref, spec, emit):
        super().__init__(ref, spec, emit)
        self.position, self.pressed, self.queue, self.next_t, self.t = 0, False, [], 0, 0
        for role in ("A", "B", "S"):
            if role in self.pins:
                self.emit({"type": "pin", "pin": self.pins[role], "level": 1})

    def act(self, action):
        if "turn" in action:
            n = int(action["turn"])
            self.queue += (self.CW if n > 0 else self.CCW) * abs(n)
            self.position += n
        if "press" in action and "S" in self.pins and bool(action["press"]) != self.pressed:
            self.pressed = bool(action["press"])
            self.emit({"type": "pin", "pin": self.pins["S"], "level": int(not self.pressed)})

    def tick(self, t_us):
        self.t = t_us
        if self.queue and t_us >= self.next_t:
            a, b = self.queue.pop(0)
            self.emit({"type": "pin", "pin": self.pins["A"], "level": a})
            self.emit({"type": "pin", "pin": self.pins["B"], "level": b})
            self.next_t = t_us + int(self.spec.get("step_us", 3000))

    def view(self):
        return {"position": self.position, "pressed": self.pressed}


BLOCKS = {"light": Light, "press": Press, "level": Level, "motor": Motor, "regs": Regs, "screen": Screen,
          "quad": Quad}


def make_part(ref: str, spec: dict, emit) -> Part:
    """A block from the catalog, or `code: package.module.Class` where there is real behaviour."""
    if spec.get("code"):
        module, _, name = spec["code"].rpartition(".")
        return getattr(importlib.import_module(module), name)(ref, spec, emit)
    return BLOCKS[spec["block"]](ref, spec, emit)
