"""A board's schematic, drawn by KiCad from what atopile built.

The source is atopile; the netlist it builds says which pin meets which.
This turns that into a KiCad schematic - every part with its real symbol,
grouped by the module it sits in, each pin joined to its net by a labelled
stub - then has KiCad draw it on black and run ERC over it. The
schematic follows the source: it is drawn again on every build, never
edited by hand, so there is nothing in it for a build to overwrite.

A board with an MCU is drawn in sheets (backend/sheets.py): a root with
a box per sheet, a sheet per MCU with the parts that serve only it, Power,
and Connectors & peripherals; nets on two sheets meet by global labels.
Each MCU's sheet and pin map are kept on the board (`schematic.mcus`,
GET /api/boards/{id}/mcus) for the Firmware room. A board without an MCU
stays one sheet.

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

from . import ato, kicad, lcsc, limits, sheets, store

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

    comps, info = [], []
    for c in graph.get("components", []):
        part = c.get("part")
        about = {"ref": c["ref"], "part": part, "group": kicad.module_of(c),
                 "title": "", "mpn": "", "category": "", "pins": []}
        if part in passive:
            kind, value, _size = passive[part].split(" ")
            entry = "R" if kind == "R" else "C"
            symbol = kicad_symbol(entry)
            shown = value + ("Ω" if kind == "R" else "F")
            about.update(kind=kind, pins=[{"number": "1", "name": ""}, {"number": "2", "name": ""}])
        else:
            # The part's EasyEDA data, from disk if it has been looked at -
            # asking LCSC politely if not.
            data = await lcsc._component(part)
            pins = await lcsc.pins(part)
            entry = passive_entry(data, pins, c.get("ref") or "")
            para = ((data.get("dataStr") or {}).get("head") or {}).get("c_para") or {}
            about.update(title=data.get("title") or "", mpn=para.get("Manufacturer Part") or "",
                         category=" ".join(data.get("tags") or []),
                         pins=[{"number": p.get("number"), "name": p.get("name") or ""} for p in pins])
            if entry:
                symbol = kicad_symbol(entry)
                kind = "C" if entry.startswith("C") else "L" if entry == "L" else "R"
                value = lcsc.value_of(kind, para.get("Value") or c.get("value") or "") \
                    if entry != "FerriteBead" else None
                shown = (value + UNIT[entry if entry in UNIT else "C"]) if value \
                    else (para.get("Value") or data.get("title") or part)
                about["kind"] = kind
            else:
                symbol = {"kind": "easyeda",
                          "json": str((lcsc.LOOK / part / "component.json").resolve()),
                          # tools/schematic_gen.py: every pin passive, or
                          # only the ones EasyEDA could not type.
                          "pins": "passive" if passive_pins(data, c.get("ref") or "")
                          else "as_typed"}
                shown = data.get("title") or part
        about["value"] = shown
        info.append(about)
        comps.append({"ref": c["ref"], "part": part, "group": kicad.module_of(c),
                      "value": shown, "footprint": c.get("footprint"),
                      "symbol": symbol})

    # Which sheet each part goes on (backend/sheets.py): one per MCU, Power,
    # the rest - or the one Overview sheet when there is no MCU.
    split = sheets.split(info, graph.get("nets", []))
    for comp in comps:
        comp["sheet"] = split["assign"].get(comp["ref"])
        comp["group"] = split["groups"].get(comp["ref"], comp["group"])
    return {"project": "board", "title": title, "components": comps,
            "nets": graph.get("nets", []),
            "sheets": [{k: v for k, v in s.items() if k != "refs"} for s in split["sheets"]]
            if len(split["sheets"]) > 1 else [],
            "global_nets": split["global_nets"],
            "split": split}


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


async def render(plan: dict, work: Path) -> dict:
    """Write the schematic into `work`, have KiCad draw every sheet and run
    ERC over the whole of it. Nothing is stored; `draw` does that.

    Returns {"made": the generator's account, "erc": ERC as counts,
    "files": {name: bytes} every .kicad_sch, "svgs": {sheet key or "root":
    bytes}}."""
    plan = {k: v for k, v in plan.items() if k != "split"}
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
    # theme from its user settings, so that is where it is mounted. KiCad
    # draws every sheet of a hierarchy, a file each.
    os.chmod(work, 0o777)
    theme = ["-v", f"{THEME}:/home/board/.config/kicad/9.0/colors/redline-dark.json:ro"]
    rc, log = await kicad._run(
        ["docker", "run", "--rm", *limits.box(), "-v", f"{work}:/work", "-w", "/work", *theme,
         kicad.IMAGE, "sch", "export", "svg", "--exclude-drawing-sheet",
         "--theme", "redline-dark", "--output", "/work/svg", "board.kicad_sch"], work)
    drawn = sorted((work / "svg").glob("*.svg")) if (work / "svg").exists() else []
    if rc != 0 or not drawn:
        raise RuntimeError("drawing the schematic failed:\n" + log[-600:])
    svgs = svgs_by_sheet(drawn, made.get("sheets") or [])
    if "root" not in svgs:
        raise RuntimeError("drawing the schematic failed: no drawing of the root sheet in "
                           + ", ".join(p.name for p in drawn))

    rc, _ = await kicad._run(
        ["docker", "run", "--rm", *limits.box(), "-v", f"{work}:/work", "-w", "/work",
         kicad.IMAGE, "sch", "erc", "--format", "json", "--severity-all",
         "--output", "/work/erc.json", "board.kicad_sch"], work)
    try:
        erc = summarise_erc(json.loads((work / "erc.json").read_text()))
    except (OSError, ValueError):
        erc = {"error": "ERC produced no report"}
    files = {p.name: p.read_bytes() for p in sorted(work.glob("*.kicad_sch"))}
    return {"made": made, "erc": erc, "files": files, "svgs": svgs}


def svgs_by_sheet(drawn: list[Path], sheets: list[dict]) -> dict[str, bytes]:
    """KiCad names the drawing of the root `board.svg` and each sub-sheet's
    `board-<sheet name>.svg` (with the characters a file name cannot have
    replaced). Which is which, by sheet key."""
    out: dict[str, bytes] = {}
    rest = []
    for p in drawn:
        if p.stem == "board":
            out["root"] = p.read_bytes()
        else:
            rest.append(p)

    def norm(text: str) -> str:
        return re.sub(r"[^0-9a-z]+", "", text.lower())

    for sheet in sheets:
        want = [norm("board-" + sheet["name"]), norm("board-" + sheet["file"].rsplit(".", 1)[0])]
        hit = next((p for p in rest if norm(p.stem) in want), None)
        if hit is None:
            hit = next((p for p in rest if norm(sheet["name"]) and norm(sheet["name"]) in norm(p.stem)), None)
        if hit is not None:
            out[sheet["key"]] = hit.read_bytes()
            rest.remove(hit)
    if not sheets and "root" not in out and drawn:
        out["root"] = drawn[0].read_bytes()
    return out


def sheet_svg_label(key: str) -> str:
    return f"schematic_sheet_{key}"


def sheet_url(board_id: str, key: str) -> str:
    return f"/api/boards/{board_id}/sheets/{key}.svg"


async def draw(db, board_id: str) -> dict:
    """Write, draw and check the schematic of a board's last build - split
    into sheets (backend/sheets.py) - and keep it, every sheet and the
    MCUs' pin maps on the board."""
    doc = await db[ato.BOARDS].find_one({"_id": board_id}, {"title": 1, "artifacts": 1})
    graph = json.loads(await store.get_artifact(db, board_id, "graph", ato.BOARDS))
    plan = await plan_for(graph, (doc or {}).get("title") or board_id)

    work = Path(tempfile.mkdtemp(prefix="redline-sch-"))
    try:
        got = await render(plan, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    made, erc, svgs = got["made"], got["erc"], got["svgs"]

    await store.put_artifact(db, board_id, "schematic", got["files"]["board.kicad_sch"],
                             collection=ato.BOARDS)
    await store.put_artifact(db, board_id, "schematic_svg", svgs["root"], collection=ato.BOARDS)
    # Every sheet's file, for the download and the release's PDF (a
    # hierarchy is no use without its sub-sheets).
    await store.put_artifact(db, board_id, "schematic_files", json.dumps(
        {name: raw.decode("utf-8", errors="replace") for name, raw in got["files"].items()}).encode(),
        collection=ato.BOARDS)
    split = plan["split"]
    by_key = {s["key"]: s for s in made.get("sheets") or []}
    sheets_out = []
    for s in split["sheets"] if plan.get("sheets") else []:
        drawn = s["key"] in svgs
        if drawn:
            await store.put_artifact(db, board_id, sheet_svg_label(s["key"]), svgs[s["key"]],
                                     collection=ato.BOARDS)
        stats = by_key.get(s["key"], {})
        sheets_out.append({"key": s["key"], "name": s["name"], "file": s["file"], "kind": s["kind"],
                           "mcu": s.get("mcu"), "refs": s["refs"], "parts": len(s["refs"]),
                           "global_labels": stats.get("global_labels", 0),
                           "svg": sheet_url(board_id, s["key"]) if drawn else None})
    # Sheets of an earlier drawing that this one no longer has.
    keep = {sheet_svg_label(s["key"]) for s in sheets_out}
    await _drop_artifacts(db, board_id, [k for k in ((doc or {}).get("artifacts") or {})
                                         if k.startswith("schematic_sheet_") and k not in keep])
    mcus = []
    for m in split["mcus"]:
        mcus.append({**m, "svg": sheet_url(board_id, m["key"]) if m["key"] in svgs else None})
    summary = {**{k: v for k, v in made.items() if k not in ("sheets", "global_nets")},
               "erc": erc, "at": store.now(), "sheets": sheets_out, "mcus": mcus}
    await db[ato.BOARDS].update_one({"_id": board_id}, {"$set": {"schematic": summary}})
    return summary


async def _drop_artifacts(db, board_id: str, labels: list[str]) -> None:
    if not labels:
        return
    doc = await db[ato.BOARDS].find_one({"_id": board_id}, {"artifacts": 1}) or {}
    files = store.bucket(db, "model_files")
    for label in labels:
        meta = (doc.get("artifacts") or {}).get(label)
        await db[ato.BOARDS].update_one({"_id": board_id}, {"$unset": {f"artifacts.{label}": ""}})
        if meta and meta.get("gridfs_id") is not None:
            try:
                await files.delete(meta["gridfs_id"])
            except Exception:                                   # noqa: BLE001 - already gone
                pass


def mcus_of(doc: dict) -> list[dict]:
    """GET /api/boards/{id}/mcus: each MCU of the board's drawn schematic
    - ref, part, sheet (its name), the sheet's file and drawing, and every
    pin with its net and the parts that share it."""
    out = []
    for m in ((doc or {}).get("schematic") or {}).get("mcus") or []:
        out.append({"ref": m.get("ref"), "part": m.get("part"), "title": m.get("title") or "",
                    "sheet": m.get("sheet"), "key": m.get("key"), "file": m.get("file"),
                    "svg": m.get("svg"),
                    "pins": [{"number": p.get("number"), "name": p.get("name") or "",
                              "net": p.get("net"), "parts": list(p.get("parts") or [])}
                             for p in m.get("pins") or []]})
    return out
