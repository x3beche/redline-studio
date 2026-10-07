"""A board's schematic, drawn by KiCad from what atopile built.

The source is atopile; the netlist it builds says which pin meets which.
This turns that into a KiCad schematic - every part with its real symbol,
grouped by the module it sits in, each pin joined to its net by a labelled
stub - then has KiCad draw it on black and run ERC over it. The
schematic follows the source: it is drawn again on every build, never
edited by hand, so there is nothing in it for a build to overwrite.

The writing happens in the atopile environment (tools/schematic_gen.py,
where kiutils and easyeda2kicad live); the drawing and the check in the
KiCad container.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

from . import ato, kicad, lcsc, limits, store

HERE = Path(__file__).resolve().parent.parent
GENERATOR = HERE / "tools" / "schematic_gen.py"
THEME = HERE / "docker" / "redline-dark.json"
PYTHON = os.environ.get("REDLINE_ATO_PYTHON", str(HERE.parent.parent / ".venv-ato" / "bin" / "python"))
DEVICE = HERE / ".cache" / "kicad" / "Device.kicad_sym"

# ERC findings that are about the project's set-up rather than the design:
# a generated project has no symbol or footprint library tables, and KiCad
# says so once per part. Kept apart so they do not bury a real finding.
SETUP = {"footprint_link_issues", "lib_symbol_issues", "lib_symbol_mismatch"}


async def _device_library() -> Path:
    """KiCad's own resistor and capacitor symbols, copied out once."""
    if not DEVICE.exists():
        DEVICE.parent.mkdir(parents=True, exist_ok=True)
        proc = await asyncio.create_subprocess_exec(
            "docker", "run", "--rm", "--entrypoint", "cat", kicad.IMAGE,
            "/usr/share/kicad/symbols/Device.kicad_sym",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError("could not read KiCad's Device library: "
                               + err.decode(errors="replace")[-300:])
        DEVICE.write_bytes(out)
    return DEVICE


# Two-pin passives by EasyEDA's designator prefix: drawn with KiCad's own
# symbols, whose pins are passive. EasyEDA's are often typed "input", and
# two inputs on a net with nothing driving it is an ERC error per pin.
PASSIVE_PREFIX = {"R": "R", "C": "C", "L": "L", "FB": "FerriteBead"}
PASSIVE_REF = re.compile(r"^(R|C|L|FB)\d+$")
UNIT = {"R": "Ω", "C": "F", "L": "H", "FerriteBead": ""}


def passive_entry(data: dict, pins: list[dict], ref: str) -> str | None:
    """Which Device symbol a part is drawn with - R, C, L, FerriteBead or
    C_Polarized - or None to keep its own. Only a part with exactly the two
    pins 1 and 2: anything else (a resistor array, a three-terminal filter)
    keeps its maker's symbol."""
    numbers = sorted(p.get("number") for p in pins)
    if numbers != ["1", "2"]:
        return None
    para = ((data.get("dataStr") or {}).get("head") or {}).get("c_para") or {}
    pre = (para.get("pre") or "").strip().rstrip("?").upper()
    entry = PASSIVE_PREFIX.get(pre)
    if entry is None and not pre:
        m = PASSIVE_REF.match(ref or "")
        entry = PASSIVE_PREFIX.get(m.group(1)) if m else None
    if entry is None:
        return None
    if entry == "C":
        names = {p.get("number"): (p.get("name") or "").strip() for p in pins}
        if "+" in names.values() or "-" in names.values():
            # A polarised capacitor: KiCad's has + on pin 1. The other way
            # round it keeps its own symbol rather than be drawn reversed.
            return "C_Polarized" if names.get("1") == "+" else None
    return entry


# Parts whose pins have no direction: a connector, a switch, a battery
# holder, an LED or diode, a crystal. KiCad's own libraries type every pin
# of these "passive"; EasyEDA's symbols often say "input" - a header's
# sixteen pins, an LED's cathode - and ERC then reports each one as an
# input nothing drives, which is the symbol's typing and not the circuit.
# Known by the designator prefix the symbol gives (`pre`, else the
# board's ref) or by LCSC's category.
PASSIVE_PIN_PREFIX = {"J", "CN", "CON", "P", "X", "Y", "H", "HDR", "UART", "USB", "BT",
                      "SW", "S", "K", "LED", "D", "F", "FUSE", "TP"}
PASSIVE_PIN_CATEGORY = re.compile(
    r"connector|header|socket|terminal|battery (?:holder|clip|contact)|switch|button|light emitting|\bleds?\b|"
    r"diode|crystal|resonator|oscillator|fuse|relay|test point", re.I)


def _prefix(text: str) -> str:
    m = re.match(r"^([A-Za-z]+)", (text or "").strip().rstrip("?"))
    return m.group(1).upper() if m else ""


def passive_pins(data: dict, ref: str) -> bool:
    """Is this a part whose every pin is drawn passive (above)?"""
    tags = " ".join(data.get("tags") or [])
    if tags and PASSIVE_PIN_CATEGORY.search(tags):
        return True
    para = ((data.get("dataStr") or {}).get("head") or {}).get("c_para") or {}
    pre = _prefix(para.get("pre") or "")
    if pre:
        return pre in PASSIVE_PIN_PREFIX
    # No prefix in the symbol: the board's designator, whole letters only -
    # "PGOD" is not a "P".
    m = re.match(r"^([A-Za-z]+)\d+$", ref or "")
    return bool(m) and m.group(1).upper() in PASSIVE_PIN_PREFIX


async def plan_for(graph: dict, title: str) -> dict:
    """What the generator needs: each part, its module, its symbol's source.

    Every two-pin resistor, capacitor, inductor and ferrite bead is drawn
    with KiCad's Device symbol, whether or not it is one of
    backend/passives.json's; the rest with the part's own EasyEDA symbol."""
    table = json.loads(lcsc.PASSIVES.read_text()).get("parts", {})
    passive = {row["lcsc"]: key for key, row in table.items()}
    device = await _device_library()

    def kicad_symbol(entry: str) -> dict:
        return {"kind": "kicad", "lib": str(device), "entry": entry, "key": f"Device_{entry}"}

    comps = []
    for c in graph.get("components", []):
        part = c.get("part")
        if part in passive:
            kind, value, _size = passive[part].split(" ")
            entry = "R" if kind == "R" else "C"
            symbol = kicad_symbol(entry)
            shown = value + ("Ω" if kind == "R" else "F")
        else:
            # The part's EasyEDA data, from disk if it has been looked at -
            # asking LCSC politely if not.
            data = await lcsc._component(part)
            entry = passive_entry(data, await lcsc.pins(part), c.get("ref") or "")
            para = ((data.get("dataStr") or {}).get("head") or {}).get("c_para") or {}
            if entry:
                symbol = kicad_symbol(entry)
                kind = "C" if entry.startswith("C") else "L" if entry == "L" else "R"
                value = lcsc.value_of(kind, para.get("Value") or c.get("value") or "") \
                    if entry != "FerriteBead" else None
                shown = (value + UNIT[entry if entry in UNIT else "C"]) if value \
                    else (para.get("Value") or data.get("title") or part)
            else:
                symbol = {"kind": "easyeda",
                          "json": str((lcsc.LOOK / part / "component.json").resolve()),
                          # tools/schematic_gen.py: every pin passive, or
                          # only the ones EasyEDA could not type.
                          "pins": "passive" if passive_pins(data, c.get("ref") or "")
                          else "as_typed"}
                shown = data.get("title") or part
        comps.append({"ref": c["ref"], "part": part, "group": kicad.module_of(c),
                      "value": shown, "footprint": c.get("footprint"),
                      "symbol": symbol})
    return {"project": "board", "title": title, "components": comps,
            "nets": graph.get("nets", [])}


def summarise_erc(report: dict) -> dict:
    """ERC as counts: errors, warnings, and set-up notes kept apart."""
    errors, warnings, setup, examples = {}, {}, {}, []
    for sheet in report.get("sheets", []):
        for v in sheet.get("violations", []):
            kind = v.get("type", "?")
            if kind in SETUP:
                setup[kind] = setup.get(kind, 0) + 1
                continue
            bucket = errors if v.get("severity") == "error" else warnings
            bucket[kind] = bucket.get(kind, 0) + 1
            if v.get("severity") == "error" and len(examples) < 8:
                examples.append(v.get("description", "") + " - " + "; ".join(
                    i.get("description", "")[:60] for i in v.get("items", [])))
    return {"errors": errors, "warnings": warnings, "setup": setup,
            "error_count": sum(errors.values()),
            "warning_count": sum(warnings.values()), "examples": examples}


async def draw(db, board_id: str) -> dict:
    """Write, draw and check the schematic of a board's last build."""
    doc = await db[ato.BOARDS].find_one({"_id": board_id}, {"title": 1})
    graph = json.loads(await store.get_artifact(db, board_id, "graph", ato.BOARDS))
    plan = await plan_for(graph, (doc or {}).get("title") or board_id)

    work = Path(tempfile.mkdtemp(prefix="redline-sch-"))
    try:
        plan["out"] = str(work / "board.kicad_sch")
        # The atopile environment's Python, wherever this runs (backend/atoenv.py).
        from . import atoenv
        try:
            py, py_env = atoenv.python("kiutils")
        except atoenv.AtoEnvMissing as exc:
            raise RuntimeError(str(exc)) from exc
        proc = await asyncio.create_subprocess_exec(
            *py, str(GENERATOR), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            env={**os.environ, **py_env})
        out, _ = await asyncio.wait_for(proc.communicate(json.dumps(plan).encode()), 300)
        text = out.decode(errors="replace")
        if proc.returncode != 0:
            raise RuntimeError("writing the schematic failed:\n" + text[-800:])
        made = json.loads(text[text.index("{"):text.rindex("}") + 1])

        # Drawn on black with the theme the page uses; KiCad reads a colour
        # theme from its user settings, so that is where it is mounted.
        os.chmod(work, 0o777)
        theme = ["-v", f"{THEME}:/home/board/.config/kicad/9.0/colors/redline-dark.json:ro"]
        rc, log = await kicad._run(
            ["docker", "run", "--rm", *limits.box(), "-v", f"{work}:/work", "-w", "/work", *theme,
             kicad.IMAGE, "sch", "export", "svg", "--exclude-drawing-sheet",
             "--theme", "redline-dark", "--output", "/work/svg", "board.kicad_sch"], work)
        svg = work / "svg" / "board.svg"
        if rc != 0 or not svg.exists():
            raise RuntimeError("drawing the schematic failed:\n" + log[-600:])

        rc, _ = await kicad._run(
            ["docker", "run", "--rm", *limits.box(), "-v", f"{work}:/work", "-w", "/work",
             kicad.IMAGE, "sch", "erc", "--format", "json", "--severity-all",
             "--output", "/work/erc.json", "board.kicad_sch"], work)
        try:
            erc = summarise_erc(json.loads((work / "erc.json").read_text()))
        except (OSError, ValueError):
            erc = {"error": "ERC produced no report"}

        await store.put_artifact(db, board_id, "schematic",
                                 (work / "board.kicad_sch").read_bytes(),
                                 collection=ato.BOARDS)
        await store.put_artifact(db, board_id, "schematic_svg", svg.read_bytes(),
                                 collection=ato.BOARDS)
        summary = {**made, "erc": erc, "at": store.now()}
        await db[ato.BOARDS].update_one({"_id": board_id},
                                        {"$set": {"schematic": summary}})
        return summary
    finally:
        shutil.rmtree(work, ignore_errors=True)
