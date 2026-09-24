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
import shutil
import tempfile
from pathlib import Path

from . import ato, kicad, lcsc, limits, store

HERE = Path(__file__).resolve().parent.parent
GENERATOR = HERE / "tools" / "schematic_gen.py"
THEME = HERE / "docker" / "redline-dark.json"
PYTHON = os.environ.get("X3_ATO_PYTHON", str(HERE.parent.parent / ".venv-ato" / "bin" / "python"))
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


async def plan_for(graph: dict, title: str) -> dict:
    """What the generator needs: each part, its module, its symbol's source."""
    table = json.loads(lcsc.PASSIVES.read_text()).get("parts", {})
    passive = {row["lcsc"]: key for key, row in table.items()}
    device = await _device_library()

    comps = []
    for c in graph.get("components", []):
        part = c.get("part")
        if part in passive:
            kind, value, _size = passive[part].split(" ")
            entry = "R" if kind == "R" else "C"
            symbol = {"kind": "kicad", "lib": str(device), "entry": entry,
                      "key": f"Device_{entry}"}
            shown = value + ("Ω" if kind == "R" else "F")
        else:
            # The part's EasyEDA data, from disk if it has been looked at -
            # asking LCSC politely if not.
            data = await lcsc._component(part)
            symbol = {"kind": "easyeda",
                      "json": str((lcsc.LOOK / part / "component.json").resolve())}
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

    work = Path(tempfile.mkdtemp(prefix="x3sch-"))
    try:
        plan["out"] = str(work / "board.kicad_sch")
        proc = await asyncio.create_subprocess_exec(
            PYTHON, str(GENERATOR), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
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
