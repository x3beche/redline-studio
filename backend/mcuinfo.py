"""The MCU a firmware runs on, and what the firmware makes of it.

For the Embedded Programming room's MCU panel: the chip (core, clock,
memory, package), how full each memory region is, how much computing a
millisecond holds, which peripherals the chip has and which the firmware
uses, what each pin on the board is wired to with the chip's cautions for
it, and - while a simulation of the app runs - what the firmware has
actually done with its pins and buses.

Every number is read, never remembered, and says where it was read:

- ESP32 family: ESP-IDF in the Embedded image. `soc_caps.h` evaluated by
  the compiler (counts of UARTs, I2C, LEDC channels...), the Xtensa core's
  `core-isa.h`, the CPU clock choices in `Kconfig.cpu`, and the GPIO table
  and notes of the IDF's own GPIO documentation (strapping pins, flash
  pins, input-only pins, ADC2 with Wi-Fi). Read once per target and kept
  under .cache/mcu/.
- The project's configuration: the build's `config/sdkconfig.json`, else
  the project's `sdkconfig` / `sdkconfig.defaults` (CPU MHz, FreeRTOS tick,
  flash size).
- STM32: STM32CubeMX's device database (REDLINE_CUBEMX_DB): core, frequency,
  flash, RAM, package, peripheral instances and every pin's signals.
- The build: memory regions and symbols as backend/firmware.py stored
  them, and the ELF's symbol names (nm, in the Embedded image) for which
  drivers are linked.
- The board: the linked board's netlist, as the simulator reads it.
- The simulator: backend/sim/runtime.Seen of a running session.

What cannot be read is listed in `missing`, not guessed.
"""

from __future__ import annotations

import functools
import json
import os
import re
import shlex
import xml.etree.ElementTree as ET
from pathlib import Path

from . import apps, firmware, sandbox, store

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "mcu"
CUBEMX_DB = Path(os.getenv("REDLINE_CUBEMX_DB", str(Path.home() / "STM32CubeMX" / "db")))
IDF = "/opt/esp/idf"
ESP_TARGETS = ("esp32", "esp32s2", "esp32s3", "esp32c2", "esp32c3", "esp32c5", "esp32c6",
               "esp32c61", "esp32h2", "esp32p4")

# ---------------- ESP-IDF, read in the Embedded image ----------------

# soc_caps.h macros worth a number on the panel. Evaluated by the compiler,
# so an expression of other macros (BIT24, a mask) comes out as its value.
CAPS = [
    "SOC_CPU_CORES_NUM", "SOC_CPU_HAS_FPU", "SOC_GPIO_PIN_COUNT", "SOC_GPIO_VALID_GPIO_MASK",
    "SOC_GPIO_VALID_OUTPUT_GPIO_MASK", "SOC_UART_NUM", "SOC_I2C_NUM", "SOC_SPI_PERIPH_NUM",
    "SOC_I2S_NUM", "SOC_LEDC_CHANNEL_NUM", "SOC_LEDC_SUPPORT_HS_MODE", "SOC_LEDC_TIMER_BIT_WIDTH",
    "SOC_MCPWM_GROUPS", "SOC_MCPWM_TIMERS_PER_GROUP", "SOC_PCNT_GROUPS", "SOC_PCNT_UNITS_PER_GROUP",
    "SOC_RMT_GROUPS", "SOC_RMT_CHANNELS_PER_GROUP", "SOC_ADC_PERIPH_NUM", "SOC_ADC_RTC_MAX_BITWIDTH",
    "SOC_ADC_DIGI_MAX_BITWIDTH", "SOC_DAC_CHAN_NUM", "SOC_DAC_RESOLUTION", "SOC_TOUCH_SENSOR_NUM",
    "SOC_TWAI_CONTROLLER_NUM", "SOC_TIMER_GROUP_TOTAL_TIMERS", "SOC_TIMER_GROUP_COUNTER_BIT_WIDTH",
    "SOC_WIFI_SUPPORTED", "SOC_BT_SUPPORTED", "SOC_BLE_SUPPORTED", "SOC_BT_CLASSIC_SUPPORTED",
    "SOC_IEEE802154_SUPPORTED", "SOC_USB_OTG_SUPPORTED", "SOC_USB_SERIAL_JTAG_SUPPORTED",
    "SOC_EMAC_SUPPORTED", "SOC_SDMMC_HOST_SUPPORTED", "SOC_UART_FIFO_LEN", "SOC_UART_BITRATE_MAX",
    "SOC_I2C_FIFO_LEN", "SOC_CPU_INTR_NUM", "SOC_RTCIO_PIN_COUNT",
]
CAPS_FN = {f"SOC_ADC_CHANNEL_NUM({i})": "SOC_ADC_CHANNEL_NUM" for i in range(3)}


def _caps_c() -> str:
    out = ['#include <stdio.h>', '#include "soc/soc_caps.h"', "int main(void) {", 'printf("{");']
    for name in CAPS:
        out += [f"#ifdef {name}",
                f'printf("\\"{name}\\": %llu,", (unsigned long long)({name}));', "#endif"]
    for expr, name in CAPS_FN.items():
        i = int(expr[expr.index("(") + 1:-1])
        out += [f"#ifdef {name}", f"if ({i} < SOC_ADC_PERIPH_NUM)" if "ADC" in name else "",
                f'printf("\\"{expr}\\": %llu,", (unsigned long long)({expr}));', "#endif"]
    out += ['printf("\\"_\\": 0}\\n");', "return 0; }"]
    return "\n".join(out)


def _esp_script(target: str, c_file: str) -> str:
    t = shlex.quote(target)
    return f"""
IDF=${{IDF_PATH:-{IDF}}}; T={t}; H=$IDF/components/soc/$T/include/soc/soc_caps.h
echo "@@version"; cat $IDF/version.txt 2>/dev/null || git -C $IDF describe --tags 2>/dev/null
echo "@@lines"; grep -n '^#define SOC_' $H
echo "@@caps"; gcc -w -I$IDF/components/soc/$T/include -I$IDF/components/soc/include \\
  -I$IDF/components/esp_common/include -include esp_bit_defs.h -o /tmp/caps {shlex.quote(c_file)} && /tmp/caps
echo "@@core"; grep -n 'XCHAL_HW_VERSION_NAME' $IDF/components/xtensa/$T/include/xtensa/config/core-isa.h 2>/dev/null
echo "@@kcpu"; cat $IDF/components/esp_system/port/soc/$T/Kconfig.cpu 2>/dev/null
echo "@@sram"; grep -n 'KB of available SRAM' $IDF/docs/en/api-guides/memory-types.rst 2>/dev/null
echo "@@uartpins"; grep -n 'define U0[TR]XD_GPIO_NUM' $IDF/components/soc/$T/include/soc/uart_pins.h 2>/dev/null
echo "@@alias"; grep -n 'SENSOR_V[PN] (' $IDF/docs/en/hw-reference/$T/get-started-pico-kit.rst 2>/dev/null
echo "@@gpio"; cat $IDF/docs/en/api-reference/peripherals/gpio/$T.inc 2>/dev/null
echo "@@end"
"""


def _sections(text: str) -> dict[str, str]:
    out, name = {}, None
    for line in text.splitlines():
        if line.startswith("@@"):
            name = line[2:].strip()
            out[name] = []
        elif name:
            out[name].append(line)
    return {k: "\n".join(v) for k, v in out.items()}


def parse_gpio_doc(text: str) -> dict:
    """The IDF's GPIO page for one chip: its table (pin, analog function,
    RTC GPIO, comments) and the notes under it, keyed by what the comment
    says ("Strapping pin", "SPI0/1", "GPI", "JTAG", "TXD", "ADC2"...)."""
    rows: dict[str, dict] = {}
    cells: list[str] = []
    in_table = False

    def flush():
        if len(cells) >= 4 and re.fullmatch(r"GPIO\d+", cells[0]):
            rows[cells[0]] = {"analog": cells[1] or None, "rtc": cells[2] or None,
                              "comments": [c.strip() for c in cells[3].split(";") if c.strip()]}

    for line in text.splitlines():
        if ".. list-table::" in line:
            in_table = True
            continue
        if in_table and line.startswith(".. "):
            flush()
            cells = []
            in_table = False
        if not in_table:
            continue
        m = re.match(r"^\s*\*\s+-\s?(.*)$", line)
        if m:
            flush()
            cells = [m.group(1).strip()]
            continue
        m = re.match(r"^\s+-\s?(.*)$", line)
        if m:
            cells.append(m.group(1).strip())
    flush()
    notes = {}
    body = text.split(".. note::", 1)[1] if ".. note::" in text else ""
    for m in re.finditer(r"^\s*-\s+([A-Za-z0-9/ &]+?):\s+(.+)$", body, re.M):
        text_ = re.sub(r"`([^`<]+?)\s*<[^>]+>`_+", r"\1", m.group(2))
        text_ = re.sub(r":ref:`([^`<]+?)\s*<[^>]+>`", r"\1", text_)
        notes[m.group(1).strip()] = text_.replace("{IDF_TARGET_NAME}", "").strip()
    return {"pins": rows, "notes": notes}


def parse_esp(target: str, dump: str) -> dict:
    s = _sections(dump)
    lines = {}
    for ln in (s.get("lines") or "").splitlines():
        m = re.match(r"^(\d+):#define\s+(SOC_\w+)", ln)
        if m:
            lines.setdefault(m.group(2), int(m.group(1)))
    caps_text = (s.get("caps") or "").strip()
    caps = json.loads(caps_text[caps_text.index("{"):]) if "{" in caps_text else {}
    caps.pop("_", None)
    core = None
    m = re.search(r'^(\d+):.*XCHAL_HW_VERSION_NAME\s+"([^"]+)"', s.get("core") or "", re.M)
    if m:
        core = {"name": m.group(2), "line": int(m.group(1))}
    kcpu = s.get("kcpu") or ""
    mhz_opts = []
    klines = kcpu.splitlines()
    for i, ln in enumerate(klines):
        m = re.search(r'bool "(\d+) MHz"', ln)
        if m and not (i + 1 < len(klines) and klines[i + 1].strip().startswith("depends on")):
            mhz_opts.append(int(m.group(1)))
    sram = None
    m = re.search(r"^(\d+):.*There is (\d+) KB of available SRAM.*? on the (ESP32[\w-]*)",
                  s.get("sram") or "", re.M)
    if m and m.group(3).lower() == target:
        sram = {"kb": int(m.group(2)), "line": int(m.group(1))}
    alias = {}
    for m in re.finditer(r"^(\d+):#define\s+U0([TR])XD_GPIO_NUM\s+\(?(\d+)\)?", s.get("uartpins") or "", re.M):
        alias[f"{m.group(2)}XD0"] = {"gpio": f"GPIO{m.group(3)}", "src": f"soc/{target}/include/soc/uart_pins.h:{m.group(1)}"}
    for m in re.finditer(r"^(\d+):.*?(SENSOR_V[PN]) \(\w+\).*?\|\s*(GPIO\d+)", s.get("alias") or "", re.M):
        alias[m.group(2)] = {"gpio": m.group(3), "src": f"docs/en/hw-reference/{target}/get-started-pico-kit.rst:{m.group(1)}"}
    return {"target": target, "idf": (s.get("version") or "").strip() or None, "caps": caps,
            "caps_line": lines, "core": core, "mhz_options": sorted(mhz_opts), "sram": sram,
            "alias": alias, "gpio": parse_gpio_doc(s.get("gpio") or "")}


async def esp_facts(target: str) -> dict | None:
    """soc_caps and the rest for one ESP target, read once in the Embedded
    image and kept under .cache/mcu/."""
    if target not in ESP_TARGETS:
        return None
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / f"esp-{target}.json"
    if cached.exists():
        try:
            return json.loads(cached.read_text())
        except ValueError:
            pass
    c_file = CACHE / f"caps-{target}.c"
    c_file.write_text(_caps_c())
    rc, out, _ = await sandbox.run("embedded", ["bash", "-c", _esp_script(target, str(c_file))],
                                   timeout=180)
    facts = parse_esp(target, out)
    if not facts["caps"]:
        raise RuntimeError(f"soc_caps.h for {target} could not be read: {out[-400:]}")
    cached.write_text(json.dumps(facts, indent=1))
    return facts


# ---------------- sdkconfig ----------------

def read_sdkconfig(project: Path, build: Path | None, repo: str) -> tuple[dict, dict]:
    """{KEY: value} without the CONFIG_ prefix, and {KEY: where it was read}.
    The build's own config wins; then the project's sdkconfig, then its
    sdkconfig.defaults for what neither says."""
    values: dict = {}
    where: dict = {}

    def rel(p: Path) -> str:
        try:
            return str(p.relative_to(repo))
        except ValueError:
            return str(p)

    if build and (build / "config" / "sdkconfig.json").is_file():
        p = build / "config" / "sdkconfig.json"
        try:
            for k, v in json.loads(p.read_text()).items():
                values[k] = v
                where[k] = f"build config/sdkconfig.json ({k})"
        except ValueError:
            pass
    for name in ("sdkconfig", "sdkconfig.defaults"):
        p = project / name
        if not p.is_file():
            continue
        for i, line in enumerate(p.read_text(errors="replace").splitlines(), 1):
            m = re.match(r"^CONFIG_(\w+)=(.*)$", line.strip())
            if not m or m.group(1) in values:
                continue
            v = m.group(2).strip().strip('"')
            values[m.group(1)] = int(v) if re.fullmatch(r"-?\d+", v) else v
            where[m.group(1)] = f"{rel(p)}:{i}"
    return values, where


def _flash_bytes(v) -> int | None:
    m = re.fullmatch(r"(\d+)\s*([KM])B", str(v or "").upper())
    if not m:
        return None
    return int(m.group(1)) * (1024 if m.group(2) == "K" else 1024 * 1024)


# ---------------- STM32CubeMX ----------------

NS = "{http://mcd.rou.st.com/modules.php?name=mcu}"
PART = re.compile(r"STM32[A-Z]\d{3}[A-Z0-9]{2,6}")


def cubemx_file(part: str, db: Path | None = None) -> Path | None:
    """The CubeMX description of a part number: STM32F042F6P6 is in
    STM32F042F6Px.xml; STM32F042K6T6 in STM32F042K(4-6)Tx.xml."""
    base = (db or CUBEMX_DB) / "mcu"
    if not base.is_dir():
        return None
    best, best_len = None, 0
    for f in base.glob("STM32*.xml"):
        # "(4-6)" lists the choices, 4 or 6; "x" is any one character.
        pat = re.sub(r"\(([^)]*)\)", lambda g: "(?:" + "|".join(map(re.escape, g.group(1).split("-"))) + ")",
                     f.stem.replace("x", "\0"))
        pat = pat.replace("\0", ".")
        m = re.match(pat, part)
        if m and m.end() >= len(part) - 1 and len(f.stem) > best_len:
            best, best_len = f, len(f.stem)
    return best


@functools.lru_cache(maxsize=16)
def cubemx(path: str) -> dict:
    root = ET.parse(path).getroot()

    def text(tag):
        el = root.find(NS + tag)
        return el.text if el is not None else None

    ips = [{"instance": ip.get("InstanceName"), "name": ip.get("Name")} for ip in root.findall(NS + "IP")]
    pins = []
    for p in root.findall(NS + "Pin"):
        pins.append({"name": p.get("Name"), "position": p.get("Position"), "type": p.get("Type"),
                     "signals": [s.get("Name") for s in p.findall(NS + "Signal") if s.get("Name") != "GPIO"]})
    volt = root.find(NS + "Voltage")
    return {"ref": root.get("RefName"), "package": root.get("Package"), "family": root.get("Family"),
            "line": root.get("Line"), "core": text("Core"), "mhz": int(text("Frequency") or 0) or None,
            "ram_kb": int(text("Ram") or 0) or None, "flash_kb": int(text("Flash") or 0) or None,
            "io": int(text("IONb") or 0) or None,
            "volts": [float(volt.get("Min")), float(volt.get("Max"))] if volt is not None else None,
            "ips": ips, "pins": pins}


STM_KINDS = [
    ("GPIO", None), ("USART", r"^US?ART\d+$"), ("I2C", r"^I2C\d+$"), ("SPI", r"^SPI\d+$"),
    ("I2S", r"^I2S\d+$"), ("Timers", r"^(LP)?TIM\d+$"), ("ADC", r"^ADC\d*$"), ("DAC", r"^DAC\d*$"),
    ("CAN", r"^(FD)?CAN\d*$"), ("USB", r"^USB(_OTG_\w+)?$"), ("RTC", r"^RTC$"), ("Touch (TSC)", r"^TSC$"),
    ("CEC", r"^HDMI_CEC$"), ("Comparators", r"^COMP\d+$"), ("Ethernet", r"^ETH$"),
    ("SD/MMC", r"^(SDIO|SDMMC\d*)$"),
]
HAL_KINDS = {"UART": "USART", "USART": "USART", "I2C": "I2C", "SPI": "SPI", "I2S": "I2S",
             "TIM": "Timers", "ADC": "ADC", "DAC": "DAC", "CAN": "CAN", "FDCAN": "CAN",
             "PCD": "USB", "RTC": "RTC", "TSC": "Touch (TSC)", "CEC": "CEC", "COMP": "Comparators",
             "GPIO": "GPIO"}


# ---------------- which drivers the ESP32 firmware links ----------------

ESP_DRIVERS = [
    ("GPIO", r"^gpio_(config|set_level|get_level|set_direction)$"),
    ("UART", r"^uart_(driver_install|write_bytes|read_bytes|param_config|set_pin)$"),
    ("I2C", r"^(i2c_master_\w+|i2c_new_master_bus|i2c_driver_install|i2c_param_config)$"),
    ("SPI", r"^(spi_bus_initialize|spi_bus_add_device|spi_device_\w+)$"),
    ("I2S", r"^i2s_(new_channel|driver_install)$"),
    ("LEDC PWM", r"^ledc_(timer_config|channel_config|set_duty|update_duty|set_freq)$"),
    ("MCPWM", r"^mcpwm_new_\w+$"),
    ("PCNT", r"^(pcnt_new_unit|pcnt_unit_\w+)$"),
    ("RMT", r"^(rmt_new_\w+|rmt_config)$"),
    ("ADC", r"^(adc_oneshot_\w+|adc_continuous_\w+|adc1_get_raw|adc2_get_raw)$"),
    ("DAC", r"^(dac_oneshot_\w+|dac_output_voltage)$"),
    ("Touch", r"^touch_pad_(init|read\w*|config)$"),
    ("TWAI (CAN)", r"^twai_driver_install\w*$"),
    ("Timers", r"^gptimer_new_timer$"),
    ("Wi-Fi", r"^esp_wifi_init$"),
    ("Bluetooth", r"^esp_bt_controller_init$"),
    ("USB", r"^(tinyusb_driver_install|usb_serial_jtag_driver_install)$"),
    ("Ethernet", r"^esp_eth_driver_install$"),
]


def _build_dirs(app: dict) -> list[Path]:
    """Where the last build went: Redline's cache for the app, then the
    directory the build command named (-B / -C / --build)."""
    out = [firmware.build_dir(app["_id"])]
    cmd = (app.get("firmware") or {}).get("command") or ""
    try:
        args = shlex.split(cmd)
    except ValueError:
        args = []
    for i, a in enumerate(args):
        if a in ("-B", "-C", "--build") and i + 1 < len(args):
            out.append(Path(args[i + 1]))
    return out


def find_elf(app: dict) -> Path | None:
    name = (app.get("firmware") or {}).get("elf")
    if not name:
        return None
    for d in _build_dirs(app):
        if (d / name).is_file():
            return d / name
    return None


async def elf_names(app: dict, elf: Path) -> list[str] | None:
    """Every defined symbol's name in the ELF, read by the image's nm and
    kept beside it by the ELF's size and time."""
    st = elf.stat()
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / f"nm-{app['_id']}.json"
    key = {"elf": str(elf), "size": st.st_size, "mtime": st.st_mtime}
    if cached.exists():
        try:
            data = json.loads(cached.read_text())
            if data.get("key") == key:
                return data["names"]
        except ValueError:
            pass
    arch = firmware.machine(elf) or "arm"
    mounts = []
    if not str(elf).startswith(str(ROOT / ".cache")) and not str(elf).startswith(app["repo"]):
        mounts = [(str(elf.parent), str(elf.parent), "ro")]
    rc, out, _ = await sandbox.run(
        "embedded", ["bash", "-c", f'{firmware.NM_FOR[arch]} --defined-only "{elf}"'],
        repo=app["repo"], mounts=mounts, timeout=120)
    if rc != 0:
        return None
    names = sorted({ln.split()[-1] for ln in out.splitlines() if len(ln.split()) == 3})
    cached.write_text(json.dumps({"key": key, "names": names}))
    return names


# ---------------- the board ----------------

async def board_view(db, app: dict) -> dict:
    """What the linked board wires to the MCU: every MCU pin on a signal
    net with the parts on it, and the simulator's reading of which part
    does what on which pin."""
    from . import ato
    from .sim import board as simboard, service
    from .sim.parts import load_catalog

    bid = app.get("board")
    if not bid:
        return {"board": None, "why": "not linked to a board"}
    catalog = load_catalog()
    out: dict = {"board": bid, "nets": [], "sim": None, "mcu": None, "warnings": []}
    try:
        got = await service.resolve(db, app["_id"], catalog=catalog)
        out["sim"], out["warnings"] = got["sim"], got["warnings"]
    except service.SimError as exc:
        out["warnings"].append(str(exc))
    try:
        graph = json.loads(await store.get_artifact(db, bid, "graph", ato.BOARDS))
    except KeyError:
        out["why"] = f"board {bid} has no netlist yet"
        return out
    mcu = service._mcu_component(graph, catalog)
    if not mcu:
        # An STM32 the simulator has no entry for is still an MCU here.
        mcu = next((c for c in graph.get("components", []) if PART.search(simboard._text(c))), None)
    if not mcu:
        out["why"] = f"no MCU found on board {bid}"
        return out
    code = next(iter(simboard.LCSC.findall(simboard._text(mcu))), None)
    if not code:
        entry = next((m for m in catalog.get("mcus", []) if simboard._matches(mcu, m["match"])), {})
        code = entry.get("symbol")
    names: dict = {}
    if code:
        try:
            names = await simboard.mcu_pin_names(db, code)
        except Exception as exc:                          # noqa: BLE001
            out["warnings"].append(f"the MCU's pin names ({code}) could not be read: {exc}")
    out["mcu"] = {"ref": mcu["ref"], "value": mcu.get("value"), "footprint": mcu.get("footprint"),
                  "part": mcu.get("part"), "symbol": code}
    for net in graph.get("nets", []):
        nodes = net.get("nodes") or []
        mine = [str(n["pin"]) for n in nodes if n["ref"] == mcu["ref"]]
        others = sorted({n["ref"] for n in nodes if n["ref"] != mcu["ref"]})
        name = net.get("name") or ""
        if not mine or not others:
            continue
        if simboard.GROUND.match(name) or simboard.SUPPLY.match(name) or simboard.POWER.match(name):
            continue
        for pad in mine:
            out["nets"].append({"pad": pad, "pin": names.get(pad, pad), "net": name, "parts": others})
    return out


# ---------------- assembling the panel ----------------

def memory(fw: dict | None, data: dict | None, target: str) -> tuple[list, list]:
    regions = (data or {}).get("regions") or ((fw or {}).get("summary") or {}).get("regions") or []
    tool = "idf.py size --format json2" if target == "esp32" else "ld --print-memory-usage"
    at = str((data or {}).get("at") or (fw or {}).get("at") or "")[:16].replace("T", " ")
    out = [{"name": r["name"], "used": r["used"], "total": r["size"], "free": r["size"] - r["used"],
            "pct": r["pct"], "src": f"{tool}, build {at}"} for r in regions]
    top = [{"name": s["name"], "size": s["size"], "where": s["where"], "file": s.get("file"),
            "line": s.get("line")} for s in ((data or {}).get("symbols") or [])[:10]]
    return out, top


def _count(v) -> int:
    return int(v or 0)


def esp_peripherals(caps: dict, line: dict, names: list[str] | None, names_src: str) -> list[dict]:
    def src(*keys):
        return ", ".join(f"soc_caps.h:{line.get(k, '?')} {k}" for k in keys if k in caps)

    rows = []

    def add(kind, have, keys, detail=None):
        if have:
            rows.append({"kind": kind, "have": have, "have_src": src(*keys), "detail": [detail] if detail else []})

    valid = _count(caps.get("SOC_GPIO_VALID_GPIO_MASK"))
    outs = _count(caps.get("SOC_GPIO_VALID_OUTPUT_GPIO_MASK"))
    n_in_only = bin(valid & ~outs).count("1")
    add("GPIO", bin(valid).count("1"), ["SOC_GPIO_VALID_GPIO_MASK", "SOC_GPIO_VALID_OUTPUT_GPIO_MASK"],
        f"{bin(valid).count('1')} usable of {caps.get('SOC_GPIO_PIN_COUNT')} numbers, {n_in_only} input-only")
    add("UART", _count(caps.get("SOC_UART_NUM")), ["SOC_UART_NUM"],
        f"{caps['SOC_UART_FIFO_LEN']} B FIFO, up to {caps['SOC_UART_BITRATE_MAX'] // 1000} kbit/s"
        if caps.get("SOC_UART_FIFO_LEN") and caps.get("SOC_UART_BITRATE_MAX") else None)
    add("I2C", _count(caps.get("SOC_I2C_NUM")), ["SOC_I2C_NUM"])
    add("SPI", _count(caps.get("SOC_SPI_PERIPH_NUM")), ["SOC_SPI_PERIPH_NUM"])
    add("I2S", _count(caps.get("SOC_I2S_NUM")), ["SOC_I2S_NUM"])
    ledc = _count(caps.get("SOC_LEDC_CHANNEL_NUM"))
    modes = 2 if caps.get("SOC_LEDC_SUPPORT_HS_MODE") else 1
    add("LEDC PWM", ledc * modes, ["SOC_LEDC_CHANNEL_NUM", "SOC_LEDC_SUPPORT_HS_MODE", "SOC_LEDC_TIMER_BIT_WIDTH"],
        f"{ledc} channels × {modes} speed modes, up to {caps.get('SOC_LEDC_TIMER_BIT_WIDTH')}-bit duty"
        if modes == 2 else f"up to {caps.get('SOC_LEDC_TIMER_BIT_WIDTH')}-bit duty")
    add("MCPWM", _count(caps.get("SOC_MCPWM_GROUPS")) * _count(caps.get("SOC_MCPWM_TIMERS_PER_GROUP")),
        ["SOC_MCPWM_GROUPS", "SOC_MCPWM_TIMERS_PER_GROUP"], "timers")
    add("PCNT", _count(caps.get("SOC_PCNT_GROUPS")) * _count(caps.get("SOC_PCNT_UNITS_PER_GROUP")),
        ["SOC_PCNT_GROUPS", "SOC_PCNT_UNITS_PER_GROUP"], "pulse counter units")
    add("RMT", _count(caps.get("SOC_RMT_GROUPS")) * _count(caps.get("SOC_RMT_CHANNELS_PER_GROUP")),
        ["SOC_RMT_GROUPS", "SOC_RMT_CHANNELS_PER_GROUP"], "channels")
    units = _count(caps.get("SOC_ADC_PERIPH_NUM"))
    per = [_count(caps.get(f"SOC_ADC_CHANNEL_NUM({i})")) for i in range(units)]
    rows_adc = {"kind": "ADC", "have": sum(per), "detail": [
        ", ".join(f"ADC{i + 1} {n} ch" for i, n in enumerate(per))
        + (f", {caps['SOC_ADC_RTC_MAX_BITWIDTH']}-bit" if caps.get("SOC_ADC_RTC_MAX_BITWIDTH") else "")],
        "have_src": src("SOC_ADC_PERIPH_NUM", "SOC_ADC_RTC_MAX_BITWIDTH")
        + f", soc_caps.h:{line.get('SOC_ADC_CHANNEL_NUM', '?')} SOC_ADC_CHANNEL_NUM(n)"}
    if units:
        rows.append(rows_adc)
    add("DAC", _count(caps.get("SOC_DAC_CHAN_NUM")), ["SOC_DAC_CHAN_NUM", "SOC_DAC_RESOLUTION"],
        f"{caps['SOC_DAC_RESOLUTION']}-bit" if caps.get("SOC_DAC_RESOLUTION") else None)
    add("Touch", _count(caps.get("SOC_TOUCH_SENSOR_NUM")), ["SOC_TOUCH_SENSOR_NUM"])
    add("TWAI (CAN)", _count(caps.get("SOC_TWAI_CONTROLLER_NUM")), ["SOC_TWAI_CONTROLLER_NUM"])
    add("Timers", _count(caps.get("SOC_TIMER_GROUP_TOTAL_TIMERS")),
        ["SOC_TIMER_GROUP_TOTAL_TIMERS", "SOC_TIMER_GROUP_COUNTER_BIT_WIDTH"],
        f"{caps.get('SOC_TIMER_GROUP_COUNTER_BIT_WIDTH')}-bit general-purpose")
    add("Wi-Fi", _count(caps.get("SOC_WIFI_SUPPORTED")), ["SOC_WIFI_SUPPORTED"])
    bt = [n for k, n in (("SOC_BT_CLASSIC_SUPPORTED", "Classic"), ("SOC_BLE_SUPPORTED", "LE")) if caps.get(k)]
    add("Bluetooth", _count(caps.get("SOC_BT_SUPPORTED")), ["SOC_BT_SUPPORTED", "SOC_BT_CLASSIC_SUPPORTED",
                                                            "SOC_BLE_SUPPORTED"], " + ".join(bt) or None)
    add("USB", _count(caps.get("SOC_USB_OTG_SUPPORTED")) + _count(caps.get("SOC_USB_SERIAL_JTAG_SUPPORTED")),
        ["SOC_USB_OTG_SUPPORTED", "SOC_USB_SERIAL_JTAG_SUPPORTED"])
    add("Ethernet", _count(caps.get("SOC_EMAC_SUPPORTED")), ["SOC_EMAC_SUPPORTED"], "MAC")
    for r in rows:
        pat = dict(ESP_DRIVERS).get(r["kind"])
        if names is None or not pat:
            r["linked"], r["linked_src"] = None, None
            continue
        hit = [n for n in names if re.match(pat, n)]
        r["linked"] = bool(hit)
        r["linked_src"] = f"{names_src}: {', '.join(hit[:4])}{'…' if len(hit) > 4 else ''}" if hit else names_src
    return rows


def stm_peripherals(chip: dict, xml_src: str, symbols: list[dict], sources: list[Path],
                    repo: str) -> list[dict]:
    rows = []
    insts = [ip["instance"] for ip in chip["ips"]]
    adc_ch = sorted({s for p in chip["pins"] for s in p["signals"] if re.fullmatch(r"ADC\d?_IN\d+", s)},
                    key=lambda s: int(re.sub(r"\D", "", s.split("IN")[-1]) or 0))
    io = [p for p in chip["pins"] if p["type"] == "I/O"]
    for kind, pat in STM_KINDS:
        if kind == "GPIO":
            rows.append({"kind": kind, "have": chip.get("io") or len(io), "instances": ["GPIO"],
                         "have_src": f"{xml_src} <IONb>", "detail": [
                             f"{len(io)} pins of type I/O on the package"]})
            continue
        mine = [i for i in insts if re.match(pat, i)]
        if not mine:
            continue
        detail = [", ".join(mine)]
        have = len(mine)
        if kind == "ADC" and adc_ch:
            detail = [f"{', '.join(mine)}: {len(adc_ch)} channels on pins"]
        rows.append({"kind": kind, "have": have, "instances": mine,
                     "have_src": f"{xml_src} <IP InstanceName>", "detail": detail})
    # HAL / LL functions in the image say which drivers are linked.
    by_kind: dict[str, list[str]] = {}
    for s in symbols:
        m = re.match(r"^(?:HAL|LL)_([A-Z0-9]+)_", s["name"])
        if m and m.group(1) in HAL_KINDS:
            by_kind.setdefault(HAL_KINDS[m.group(1)], []).append(s["name"])
    # A register-level firmware names the instances it touches: TIM3_CCR1,
    # USART1->BRR. Looked for in the source files the image was built from.
    used_in_src: dict[str, str] = {}
    for f in sources:
        try:
            lines = _code_lines(f)
        except OSError:
            continue
        for i, code in enumerate(lines, 1):
            m = re.search(r"\b(GPIO[A-K])(?=_[A-Z]|->)", code)
            if m and "GPIO" not in used_in_src:
                used_in_src["GPIO"] = f"{os.path.relpath(f, repo)}:{i} {m.group(1)}"
            for inst in insts:
                if inst not in used_in_src and re.search(rf"\b{re.escape(inst)}(?=_[A-Z]|->|\b)", code):
                    used_in_src[inst] = f"{os.path.relpath(f, repo)}:{i}"
    for r in rows:
        hal = by_kind.get(r["kind"], [])
        src_hits = [(i, used_in_src[i]) for i in r.get("instances", []) if i in used_in_src]
        if r["kind"] == "GPIO" and src_hits:            # the port: GPIOA
            where, port = src_hits[0][1].rsplit(" ", 1)
            src_hits = [(port, where)]
        r["linked"] = bool(hal or src_hits) if (symbols or sources) else None
        bits = []
        if hal:
            bits.append("HAL: " + ", ".join(hal[:3]))
        if src_hits:
            bits.append("source: " + ", ".join(f"{i} at {w}" for i, w in src_hits))
        r["linked_src"] = "; ".join(bits) or None
        r["used_instances"] = [i for i, _ in src_hits]
    return rows


STM_CAUTIONS = [
    (r"^SYS_SW(DIO|CLK)$", "SWD", "the debugger's pin: taken for anything else, the probe cannot attach"),
    (r"^RCC_OSC(32)?_(IN|OUT)$", "oscillator", "a crystal's pin when the clock runs from one"),
    (r"^USB_D[MP]$", "USB", "USB data line"),
    (r"^SYS_WKUP\d+$", "wake-up", "can wake the chip from standby"),
]


def stm_cautions(pin: dict | None, xml_src: str) -> list[dict]:
    """What CubeMX lists on a pin that an engineer wants to know before
    using it for something else."""
    out = []
    for pat, text, why in STM_CAUTIONS:
        hit = [s for s in (pin or {}).get("signals", []) if re.match(pat, s)]
        if hit:
            out.append({"level": "warn" if text == "SWD" else "info", "text": text,
                        "why": f"{why} ({', '.join(hit)})", "src": xml_src})
    return out


# roles by what the catalog's block does with the pin
def _role_kind(block: str | None, role: str, bus: str | None) -> str:
    if bus:
        return "I2C"
    if block == "motor" and role == "pwm":
        return "PWM"
    if block == "motor" and role == "tach":
        return "counter"
    if block == "level":
        return "ADC"
    if block == "light":
        return "GPIO/PWM"
    return "GPIO"


def esp_cautions(pin: str, gpio: dict, caps: dict, kinds: set[str], wifi: bool,
                 idf_doc: str) -> tuple[list[dict], list[str]]:
    """The IDF's comments on this GPIO as cautions, and its analog / RTC
    functions as signals."""
    row = (gpio.get("pins") or {}).get(pin)
    notes = gpio.get("notes") or {}
    out, signals = [], []
    m = re.fullmatch(r"GPIO(\d+)", pin)
    if not m:
        return out, signals
    n = int(m.group(1))
    if row:
        signals = [s for s in (row["analog"], row["rtc"]) if s]
        for c in row["comments"]:
            key = {"Strapping pin": "Strapping pin", "SPI0/1": "SPI0/1", "JTAG": "JTAG", "GPI": "GPI",
                   "TXD": "TXD & RXD", "RXD": "TXD & RXD"}.get(c, c)
            level = "warn" if key in ("Strapping pin", "SPI0/1") else "info"
            out.append({"level": level, "text": c, "why": notes.get(key) or c, "src": idf_doc})
        if row["analog"] and row["analog"].startswith("ADC2") and ("ADC" in kinds or not kinds):
            out.append({"level": "warn" if wifi and "ADC" in kinds else "info", "text": "ADC2",
                        "why": notes.get("ADC2") or "ADC2 and Wi-Fi", "src": idf_doc})
    outs = _count(caps.get("SOC_GPIO_VALID_OUTPUT_GPIO_MASK"))
    if outs and not (outs >> n) & 1:
        drives = kinds & {"PWM", "GPIO/PWM"}
        out.append({"level": "warn" if drives else "info", "text": "input only",
                    "why": "not in SOC_GPIO_VALID_OUTPUT_GPIO_MASK" + (" - but a part here is driven by it"
                                                                        if drives else ""),
                    "src": "soc_caps.h SOC_GPIO_VALID_OUTPUT_GPIO_MASK"})
    return out, signals


def has_psram(module: str | None) -> bool:
    """From Espressif's module ordering code: WROVER modules carry PSRAM, and
    so does any code with R<size> after the flash size (WROOM-32E-N4R2).
    Unknown modules are taken to have it, so the IDF's caution stands."""
    if not module:
        return True
    m = module.upper()
    return "WROVER" in m or bool(re.search(r"-N\d+R\d", m)) or "WROOM" not in m


async def info(db, app: dict) -> dict:
    """The panel's data for one embedded app."""
    from .sim import service

    target = firmware.target_of(app)
    fw = app.get("firmware") or None
    missing: list[str] = []
    sources: list[str] = []
    try:
        data = json.loads(await store.get_artifact(db, app["_id"], "firmware", apps.APPS))
    except KeyError:
        data = None
    project = service.firmware_dir(app)
    repo = app["repo"]
    build = next((d for d in _build_dirs(app) if d.is_dir()), None)
    board = await board_view(db, app)
    sim_parts = ((board.get("sim") or {}).get("parts") or [])
    from .sim.parts import load_catalog
    catalog = load_catalog()

    # which pins do what, as the simulator reads the board
    roles: dict[str, list[dict]] = {}
    for p in sim_parts:
        block = (catalog["models"].get(p.get("model")) or {}).get("block")
        for role, pin in (p.get("pins") or {}).items():
            roles.setdefault(pin, []).append({"part": p["ref"], "model": p.get("model"), "role": role,
                                              "kind": _role_kind(block, role, p.get("bus")),
                                              "bus": p.get("bus"), "addr": p.get("addr")})

    mem, top = memory(fw, data, target)
    if not mem:
        missing.append("memory: build once to see memory")
    else:
        sources.append(mem[0]["src"])

    chip: dict = {"name": None, "core": None, "cores": None, "mhz": None, "max_mhz": None,
                  "flash_bytes": None, "ram_bytes": None, "package": None, "source": {}}
    time_: dict = {"mhz": None, "cycles_per_ms": None, "tick_hz": None, "tick_ms": None, "source": {}}
    peripherals: list[dict] = []
    pins: list[dict] = []
    elf = find_elf(app) if fw and fw.get("ok") else None
    names: list[str] | None = None
    names_src = ""
    if elf:
        try:
            names = await elf_names(app, elf)
            names_src = f"nm {elf.name}"
        except (sandbox.NoImage, OSError) as exc:
            missing.append(f"drivers: nm could not read the ELF ({exc})")
    if names is None and data and data.get("symbols"):
        names = [s["name"] for s in data["symbols"]]
        names_src = "the build's 600 largest symbols"
        missing.append("drivers: read from the largest symbols only - the ELF is not on this machine")

    if target == "esp32":
        esp_t = "esp32"
        sdk, sdk_where = read_sdkconfig(project, build, repo)
        if isinstance(sdk.get("IDF_TARGET"), str):
            esp_t = sdk["IDF_TARGET"]
        try:
            facts = await esp_facts(esp_t)
        except (sandbox.NoImage, RuntimeError) as exc:
            facts = None
            missing.append(f"chip: ESP-IDF could not be read ({exc})")
        caps = (facts or {}).get("caps") or {}
        cline = (facts or {}).get("caps_line") or {}
        idf = f"ESP-IDF {(facts or {}).get('idf') or ''}".strip()
        soc = f"{idf} components/soc/{esp_t}/include/soc/soc_caps.h"
        mod = (board.get("mcu") or {})
        chip["name"] = esp_t.upper().replace("ESP32", "ESP32", 1)
        chip["source"]["name"] = f"{sdk_where.get('IDF_TARGET', 'the app target')}"
        if mod.get("footprint") or mod.get("value"):
            chip["package"] = re.sub(r"^.*?:", "", mod.get("value") or mod.get("footprint"))
            chip["source"]["package"] = f"board {board['board']}: {mod['ref']} footprint"
        if facts and facts.get("core"):
            chip["core"] = f"Xtensa {facts['core']['name']}"
            chip["source"]["core"] = f"{idf} components/xtensa/{esp_t}/include/xtensa/config/core-isa.h:{facts['core']['line']}"
        elif elf:
            chip["core"] = (firmware.machine(elf) or "").upper() or None
            chip["source"]["core"] = f"ELF e_machine of {elf.name}"
        if caps.get("SOC_CPU_CORES_NUM"):
            chip["cores"] = caps["SOC_CPU_CORES_NUM"]
            chip["fpu"] = bool(caps.get("SOC_CPU_HAS_FPU"))
            chip["source"]["cores"] = f"{soc}:{cline.get('SOC_CPU_CORES_NUM')} SOC_CPU_CORES_NUM, SOC_CPU_HAS_FPU"
        mhz = sdk.get("ESP_DEFAULT_CPU_FREQ_MHZ") or sdk.get("ESP32_DEFAULT_CPU_FREQ_MHZ")
        if mhz:
            chip["mhz"] = int(mhz)
            chip["source"]["mhz"] = sdk_where.get("ESP_DEFAULT_CPU_FREQ_MHZ") or sdk_where.get("ESP32_DEFAULT_CPU_FREQ_MHZ")
        else:
            missing.append("CPU clock: no sdkconfig yet - build once")
        if facts and facts.get("mhz_options"):
            chip["max_mhz"] = max(facts["mhz_options"])
            chip["source"]["max_mhz"] = f"{idf} components/esp_system/port/soc/{esp_t}/Kconfig.cpu (choices {', '.join(map(str, facts['mhz_options']))} MHz)"
        fl = _flash_bytes(sdk.get("ESPTOOLPY_FLASHSIZE"))
        if fl:
            chip["flash_bytes"] = fl
            chip["source"]["flash_bytes"] = sdk_where.get("ESPTOOLPY_FLASHSIZE")
        else:
            missing.append("flash size: not in sdkconfig")
        if facts and facts.get("sram"):
            chip["ram_bytes"] = facts["sram"]["kb"] * 1024
            chip["source"]["ram_bytes"] = f"{idf} docs/en/api-guides/memory-types.rst:{facts['sram']['line']}"
        tick = sdk.get("FREERTOS_HZ")
        if tick:
            time_["tick_hz"] = int(tick)
            time_["source"]["tick_hz"] = sdk_where.get("FREERTOS_HZ")
        else:
            missing.append("FreeRTOS tick: not in sdkconfig - build once")
        if facts:
            peripherals = esp_peripherals(caps, cline, names, names_src)
            sources.append(soc)
        # pins
        gpio = (facts or {}).get("gpio") or {}
        alias = (facts or {}).get("alias") or {}
        idf_doc = f"{idf} docs/en/api-reference/peripherals/gpio/{esp_t}.inc"
        wifi = bool(names and any(n == "esp_wifi_init" for n in names))
        for n in board.get("nets") or []:
            name = n["pin"]
            gp = alias.get(name, {}).get("gpio") or name
            rs = roles.get(name, []) or roles.get(gp, [])
            kinds = {r["kind"] for r in rs}
            cautions, signals = esp_cautions(gp, gpio, caps, kinds, wifi, idf_doc)
            if gp in ("GPIO16", "GPIO17") and not has_psram(chip.get("package")):
                # The IDF says "usually": 16/17 go to the PSRAM, and only a
                # module with PSRAM has one - WROVER, or an R in Espressif's
                # ordering code (N4R2). A WROOM-32-N4 leaves them free.
                for c in cautions:
                    if c["text"] == "SPI0/1":
                        c.update(level="info", why=c["why"] + f" This module ({chip['package']}) has no "
                                 "PSRAM, so GPIO16 and GPIO17 are free here.")
            row = {"pin": gp, "pad": n["pad"], "net": n["net"], "parts": n["parts"],
                   "roles": rs, "cautions": cautions, "signals": signals}
            if gp != name:
                row["alias"] = name
                row["alias_src"] = alias[name]["src"]
            pins.append(row)
        if gpio.get("pins"):
            sources.append(idf_doc)
    else:
        # ---- STM32 ----
        part, part_src = _stm_part(app, board, project, data)
        xml = cubemx_file(part) if part else None
        if not CUBEMX_DB.is_dir():
            missing.append(f"chip: STM32CubeMX database not found at {CUBEMX_DB} (set REDLINE_CUBEMX_DB)")
        elif not part:
            missing.append("chip: no STM32 part number found (board, project files or title)")
        elif not xml:
            missing.append(f"chip: {part} is not in the CubeMX database")
        c = cubemx(str(xml)) if xml else None
        xml_src = f"STM32CubeMX db/mcu/{xml.name}" if xml else ""
        symbols = (data or {}).get("symbols") or []
        src_files = sorted({(Path(repo) / s["file"]) for s in symbols
                            if s.get("file") and s["file"].endswith((".c", ".cpp", ".s", ".S"))})
        if c:
            chip.update(name=part, core=c["core"], max_mhz=c["mhz"], flash_bytes=(c["flash_kb"] or 0) * 1024,
                        ram_bytes=(c["ram_kb"] or 0) * 1024, package=c["package"], cores=1)
            chip["cubemx"] = c["ref"]
            chip["volts"] = c["volts"]
            for k in ("core", "max_mhz", "flash_bytes", "ram_bytes", "package", "cores"):
                chip["source"][k] = xml_src
            chip["source"]["name"] = part_src
            sources.append(xml_src)
            peripherals = stm_peripherals(c, xml_src, symbols, src_files, repo)
        clock, clock_src = _source_clock(src_files, repo)
        if clock:
            chip["mhz"] = clock / 1e6
            chip["source"]["mhz"] = clock_src
        elif c:
            chip["mhz"] = c["mhz"]
            chip["source"]["mhz"] = f"{xml_src} (the chip's maximum; the firmware's own clock was not found)"
            missing.append("CPU clock: the firmware's clock setting was not found - the maximum is shown")
        tick, tick_src = _source_tick(src_files, repo)
        if tick:
            time_["tick_hz"], time_["source"]["tick_hz"] = tick, tick_src
        else:
            missing.append("tick: no SysTick / RTOS tick setting found in the sources")
        # pins: the board's nets, with each pin's signals from CubeMX
        by_name = {}
        for p in (c or {}).get("pins", []):
            by_name[p["name"].split("-")[0]] = p
        if board.get("nets"):
            for n in board["nets"]:
                p = by_name.get(n["pin"])
                rs = roles.get(n["pin"], [])
                pins.append({"pin": n["pin"], "pad": n["pad"], "net": n["net"], "parts": n["parts"],
                             "roles": rs, "cautions": stm_cautions(p, xml_src),
                             "signals": (p or {}).get("signals", [])})
        elif c:
            for p in c["pins"]:
                if p["type"] == "I/O":
                    pins.append({"pin": p["name"], "pad": p["position"], "net": None, "parts": [],
                                 "roles": [], "cautions": stm_cautions(p, xml_src), "signals": p["signals"]})

    if chip["mhz"]:
        time_["mhz"] = chip["mhz"]
        time_["cycles_per_ms"] = int(round(chip["mhz"] * 1000))
        time_["source"]["mhz"] = chip["source"].get("mhz")
    if time_["tick_hz"]:
        time_["tick_ms"] = 1000 / time_["tick_hz"]
        if chip["mhz"]:
            time_["cycles_per_tick"] = int(round(chip["mhz"] * 1e6 / time_["tick_hz"]))

    # board usage on the peripheral rows
    for r in peripherals:
        used = []
        for pin, rs in roles.items():
            for x in rs:
                if target == "esp32" and r["kind"] == "GPIO" and not pin.startswith("GPIO"):
                    continue                       # EN is the chip's reset, not a GPIO
                if _fits(r["kind"], x["kind"], target):
                    used.append(f"{pin} {x['part']}" + (f" {x['role']}" if x["role"] not in ("1",) else "")
                                + (f" {x['bus']} 0x{int(x['addr']):02X}" if x.get("addr") is not None else ""))
        r["used"] = len(used) if board.get("sim") else None
        r["board"] = sorted(set(used))

    if not app.get("board"):
        missing.append("pins: link the app to a board to see what each pin drives")
    elif board.get("why"):
        missing.append(f"pins: {board['why']}")
    if board.get("board"):
        sources.append(f"board {board['board']} netlist"
                       + (f", pin names from LCSC {board['mcu']['symbol']}" if (board.get("mcu") or {}).get("symbol") else ""))

    seen = None
    s = service.SIMS.get(app["_id"])
    if s and s.live:
        seen = {"state": s.state, "t": s.board.t, **s.board.seen.view()}
        sources.append("simulator session (backend/sim/runtime.Seen)")

    return {"app": app["_id"], "target": target, "chip": chip, "memory": mem, "top": top,
            "time": time_, "peripherals": peripherals, "pins": pins, "seen": seen,
            "board": board.get("board"), "warnings": board.get("warnings") or [],
            "sources": list(dict.fromkeys(x for x in sources if x)), "missing": missing}


def _fits(kind: str, role_kind: str, target: str) -> bool:
    return {"I2C": role_kind == "I2C",
            "LEDC PWM": role_kind == "PWM", "MCPWM": False,
            "Timers": target == "stm32" and role_kind in ("PWM", "counter"),
            "PCNT": role_kind == "counter", "ADC": role_kind == "ADC",
            "GPIO": role_kind in ("GPIO", "GPIO/PWM")}.get(kind, False)


def _stm_part(app: dict, board: dict, project: Path, data: dict | None) -> tuple[str | None, str]:
    """The STM32 part number: the board's MCU, then the project's files,
    then the app's title."""
    mcu = board.get("mcu") or {}
    for k in ("value", "part", "footprint"):
        m = PART.search(str(mcu.get(k) or ""))
        if m:
            return m.group(0), f"board {board['board']}: {mcu['ref']} {k}"
    dirs = {project}
    for s in (data or {}).get("symbols") or []:
        if s.get("file"):
            dirs.add((Path(app["repo"]) / s["file"]).parent.parent)
    for d in sorted(dirs):
        for f in [*d.glob("*.ioc"), *d.glob("CMakeLists.txt"), *d.glob("Makefile"), *d.rglob("*.ld")]:
            try:
                for i, line in enumerate(f.read_text(errors="replace").splitlines(), 1):
                    m = PART.search(line.upper())
                    if m:
                        return m.group(0), f"{f.relative_to(app['repo'])}:{i}"
            except (OSError, ValueError):
                continue
    m = PART.search((app.get("title") or "").upper())
    return (m.group(0), "the app's title") if m else (None, "")


def _code_lines(f: Path) -> list[str]:
    """A C file's lines with its comments blanked, line numbers kept."""
    text = f.read_text(errors="replace")
    text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)
    return [ln.split("//")[0] for ln in text.splitlines()]


def _grep(files: list[Path], repo: str, pattern: str):
    for f in files:
        try:
            lines = _code_lines(f)
        except OSError:
            continue
        for i, line in enumerate(lines, 1):
            m = re.search(pattern, line)
            if m:
                yield m, f"{os.path.relpath(f, repo)}:{i}", lines


def _source_clock(files: list[Path], repo: str) -> tuple[float | None, str]:
    """The clock a register-level STM32 firmware says it runs on: a
    `#define SYSCLK_HZ 48000000` or `HSI_HZ 8000000u` in its sources and
    their local headers. A HAL project sets it at run time; none found then."""
    heads = sorted({h for f in files for h in f.parent.glob("*.h")})
    best = None
    for m, where, _ in _grep(files + heads, repo,
                             r"#define\s+(\w*(SYSCLK|HCLK|CPU|CORE|F_CPU|HSI|HSE)\w*?(_HZ|_FREQ)?)\s+\(?(\d{6,9})[uUlL]*\)?"):
        rank = 0 if m.group(2) in ("SYSCLK", "HCLK", "CPU", "CORE", "F_CPU") else 1
        if best is None or rank < best[0]:
            best = (rank, int(m.group(4)), f"{where} {m.group(1)}")
    return (best[1], best[2]) if best else (None, "")


def _source_tick(files: list[Path], repo: str) -> tuple[int | None, str]:
    heads = sorted({h for f in files for h in f.parent.glob("*.h")})
    for m, where, _ in _grep(files + heads, repo, r"configTICK_RATE_HZ\s+\(?\(?\w*\)?\s*(\d+)"):
        return int(m.group(1)), f"{where} configTICK_RATE_HZ"
    for m, where, _ in _grep(files, repo,
                             r"(SysTick_Config\s*\(|SYST_RVR\s*=|SysTick->LOAD\s*=)\s*\(?\s*\w+\s*/\s*(\d+)"):
        return int(m.group(2)), f"{where} SysTick reload = clock / {m.group(2)}"
    return None, ""


async def info_for(db, aid: str) -> dict:
    app = await db[apps.APPS].find_one({"_id": aid})
    if not app:
        raise KeyError(aid)
    if (app.get("platform") or "web") != "embedded":
        raise ValueError(f"{aid} is not firmware")
    return await info(db, app)


__all__ = ["info", "info_for", "esp_facts", "cubemx", "cubemx_file", "parse_gpio_doc", "parse_esp",
           "read_sdkconfig"]
