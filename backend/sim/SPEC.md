# The virtual board - contract

A board's firmware runs in an emulator; the parts on the board - an OLED, a
LED, a button, a fan - are models that never know which emulator or which
MCU they are talking to. Between the two is one small signal language.
This file is that contract. Everything under `backend/sim/` keeps to it.

```
 firmware ─ emulator ─ ADAPTER ─┐                ┌─ part models (catalog)
                                ├─ messages ─ RUNTIME
 (QEMU for ESP32, Renode for    │   (this file)  └─ view state → page, agents
  STM32; one adapter each)      ┘
```

Principles: as little code as possible; configuration before code; one
language; the board's parts and wiring come from the PCB room's netlist,
never typed again; SI units; the MCU's own pin names (`GPIO18`, `PA6`).

## 1. Messages

A message is a JSON object; on a stream, one per line (JSON Lines). `t` is
the emulator's virtual time in microseconds, on everything the MCU emits.

| type   | direction          | fields                                                        |
|--------|--------------------|---------------------------------------------------------------|
| `pin`  | both               | `pin`, `level` (0/1). MCU→: an output changed. →MCU: drive an input |
| `pwm`  | MCU → parts        | `pin`, `duty` (0..1), `hz`                                    |
| `adc`  | parts → MCU        | `pin`, `volts`                                                |
| `freq` | parts → MCU        | `pin`, `hz` - a pulse train on an input (a fan's tachometer)  |
| `i2c`  | MCU → parts, reply | `id`, `bus`, `addr` (7-bit int), `write` (hex), `read` (bytes wanted) |
| `spi`  | MCU → parts, reply | `id`, `bus`, `cs` (pin), `write` (hex), `read` (bytes wanted)  |
| `uart` | both               | `port` (`UART0`, `USART1`...), `data` (text)                  |
| `reply`| parts → MCU        | `id`, `data` (hex, `read` bytes long), `ack` (bool)           |

Examples:

```json
{"type":"pwm","t":120400,"pin":"GPIO18","duty":0.6,"hz":25000}
{"type":"pin","pin":"GPIO0","level":0}
{"type":"i2c","t":130000,"id":7,"bus":"I2C0","addr":60,"write":"00af","read":0}
{"type":"reply","id":7,"data":"","ack":true}
{"type":"freq","pin":"GPIO19","hz":40}
```

Rules:
- `i2c` and `spi` are transactions: the adapter holds the MCU (virtual time
  stops) until the matching `reply` comes back. No part at the address:
  the runtime answers `ack: false`.
- `pin` from the MCU is sent only on a change; `pwm` only when duty or
  frequency changes.
- Unknown fields are ignored; unknown types are dropped and logged. The
  schema is `backend/sim/messages.schema.json`.

## 2. Adapter (one per emulator)

```python
class Adapter(Protocol):
    name: str                                   # "qemu-esp32", "renode"
    async def start(self, firmware: Path, board: dict) -> None
    def events(self) -> AsyncIterator[dict]     # messages from the MCU, in order
    async def send(self, msg: dict) -> None     # pin/adc/freq/uart inputs, replies
    async def stop(self) -> None
```

An adapter knows the emulator and the MCU family. It knows nothing about
parts. Heavy things run in Docker (Redline's images), never on the host.

## 3. Part model

```python
class Part:
    def __init__(self, ref: str, spec: dict, emit): ...   # emit(msg) sends to the MCU
    def on(self, msg: dict) -> dict | None                # a message for this part; return a reply if it is a transaction
    def act(self, action: dict) -> None                   # from the page or an agent: {"press": true}, {"value": 23.5}
    def tick(self, t_us: int) -> None                     # optional: time-driven behaviour
    def view(self) -> dict                                # what the page draws: {"glow": 0.6}, {"screen": {...}}, {"rpm": 1200}
```

Most parts are no code at all: six building blocks, configured in the
catalog (`backend/sim/catalog.yaml`):

| block    | does                                        | e.g.                         |
|----------|---------------------------------------------|------------------------------|
| `light`  | pin or pwm → brightness                     | LED                          |
| `press`  | click → pin level (pull-up or pull-down)    | button, switch               |
| `level`  | slider → adc volts                          | potentiometer, LDR           |
| `motor`  | pwm → rpm → `freq` on the tach pin          | fan, DC motor                |
| `regs`   | an I2C register map fed from sliders        | TMP102 and most I2C sensors  |
| `screen` | a frame buffer, for parts that draw         | used by display models       |

Code only where there is real behaviour (a display controller: `ssd1306`).

## 4. Board description (`sim.json`)

Generated from the PCB room's netlist; can be corrected by hand.

```json
{ "mcu": {"part": "C701342", "family": "esp32", "emulator": "qemu-esp32"},
  "parts": [
    {"ref": "LED2", "model": "led",     "pins": {"A": "GPIO2"}},
    {"ref": "SW1",  "model": "button",  "pins": {"1": "GPIO0"}},
    {"ref": "OLED", "model": "ssd1306", "bus": "I2C0", "addr": 60},
    {"ref": "J1",   "model": "fan",     "pins": {"pwm": "GPIO18", "tach": "GPIO19"}}],
  "skipped": [{"ref": "U4", "why": "no model for C12345"}] }
```

The MCU's pin names come from its LCSC symbol (the numbers in the netlist
are package pins). Which part is which model comes from the catalog's
`match` (LCSC number or footprint pattern).
