"""Drawing a board, without KiCad on the machine.

atopile says what the circuit is. KiCad is the thing that can place it,
draw it and export a model of it - and it is a gigabyte of libraries
nobody asked to install. So it lives in a container and is handed one
directory at a time: the netlist and its footprints go in, a layer render
and a 3D model come out. Nothing else crosses.

The placement itself is done by KiCad's own library code, in
`docker/place.py`, rather than by writing the file here. That was the
first attempt: a hand-written .kicad_pcb is rejected whole, with "Failed
to load board" and no line number, and nothing says what a footprint in a
board may carry that the same footprint in a library may not.

What this does not do is route. The board comes out placed, with its nets
attached and the connections showing as a ratsnest - which is what a
board is before somebody lays it out, and all the source alone can say.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

from . import ato, compute, lcsc, rules, store

IMAGE = os.environ.get("X3_KICAD_IMAGE", "redline-kicad")
HERE = Path(__file__).resolve().parent.parent
PLACER = HERE / "docker" / "place.py"
ROUTER = HERE / "docker" / "route.py"
ROUTE_TIMEOUT = 900

# Run in the container: the routed board, without its zones, for a view
# where the tracks can be told apart from the ground around them.
STRIP_ZONES = """
import pcbnew
b = pcbnew.LoadBoard("/work/board.kicad_pcb")
for z in list(b.Zones()):
    b.Remove(z)
pcbnew.SaveBoard("/work/tracks.kicad_pcb", b)
"""
TIMEOUT = 600

# The front of the board, as a render: copper, what is printed on it, the
# soldermask openings, and the outline that says where it ends.
LAYERS = "F.Cu,F.SilkS,F.Mask,Edge.Cuts"
# And the back, once it has copper on it.
BOTTOM_LAYERS = "B.Cu,B.SilkS,B.Mask,Edge.Cuts"


# Resistors and capacitors do not come from LCSC. An 0402 is the same
# shape whoever made it, KiCad's own library in the container has it with
# a 3D model, and downloading one per value cost three asks of LCSC's
# budget each - ten of a board's twenty-three downloads, for shapes that
# were already here. So a part from backend/passives.json is drawn from
# the library; everything else is fetched by its number.
LIBRARY = "/usr/share/kicad/footprints"
PASSIVE_SHAPES = {
    ("R", "0402"): f"{LIBRARY}/Resistor_SMD.pretty/R_0402_1005Metric.kicad_mod",
    ("R", "0603"): f"{LIBRARY}/Resistor_SMD.pretty/R_0603_1608Metric.kicad_mod",
    ("C", "0402"): f"{LIBRARY}/Capacitor_SMD.pretty/C_0402_1005Metric.kicad_mod",
    ("C", "0603"): f"{LIBRARY}/Capacitor_SMD.pretty/C_0603_1608Metric.kicad_mod",
    ("C", "0805"): f"{LIBRARY}/Capacitor_SMD.pretty/C_0805_2012Metric.kicad_mod",
}


def library_shapes() -> dict[str, str]:
    """LCSC number -> KiCad library footprint, for every known passive."""
    try:
        table = json.loads(lcsc.PASSIVES.read_text()).get("parts", {})
    except (OSError, ValueError):
        return {}
    out = {}
    for key, row in table.items():
        kind, _value, size = key.split(" ")
        shape = PASSIVE_SHAPES.get((kind, size))
        if shape:
            out[row["lcsc"]] = shape
    return out


def module_of(component: dict) -> str:
    """Which module a part is in, from where the source puts it:
    `main.ato:Controller::power.charger` is in `power`. The placer lays
    each module out as a block of its own."""
    where = component.get("where") or ""
    inner = where.split("::", 1)[1] if "::" in where else ""
    return inner.split(".", 1)[0] if "." in inner else ""


class NoDocker(RuntimeError):
    """Raised when the container is not there, with what to do about it."""


async def _run(args: list[str], cwd: Path) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        raise TimeoutError("the container did not finish in time")
    return proc.returncode, out.decode(errors="replace")


def _docker(work: Path, *args: str, stdin: bool = False) -> list[str]:
    run = ["docker", "run", "--rm"]
    if stdin:
        run.append("-i")
    return [*run, "-v", f"{work}:/work", "-w", "/work", *args]


async def available() -> bool:
    try:
        rc, _ = await _run(["docker", "image", "inspect", IMAGE], HERE)
        return rc == 0
    except (OSError, TimeoutError):
        return False


async def drc(work: Path, name: str) -> dict:
    """KiCad's DRC over a board, as counts a person can act on.

    Errors are kept apart from warnings, and a finding that sits wholly
    inside one part's footprint - the USB-C's locating pegs a fraction of a
    millimetre from its own pads - apart from both: that is the maker's
    land pattern, not something the layout did.
    """
    rc, log = await _run(
        _docker(work, IMAGE, "pcb", "drc", "--format", "json", "--severity-all",
                "--output", "drc.json", name), work)
    try:
        report = json.loads((work / "drc.json").read_text())
    except (OSError, ValueError):
        return {"error": log[-400:]}

    def owner(item: dict) -> str | None:
        m = re.search(r" of (\S+)", item.get("description", ""))
        return m.group(1) if m else None

    errors, warnings, inside = {}, {}, {}
    examples = []
    for v in report.get("violations", []):
        items = v.get("items", [])
        owners = {owner(i) for i in items}
        own = len(items) > 1 and len(owners) == 1 and None not in owners
        bucket = inside if own else errors if v.get("severity") == "error" else warnings
        bucket[v["type"]] = bucket.get(v["type"], 0) + 1
        if not own and v.get("severity") == "error" and len(examples) < 8:
            examples.append(v.get("description", "") + " - "
                            + " / ".join(i.get("description", "")[:60] for i in items))
    unconnected = report.get("unconnected_items", [])
    return {
        "errors": errors, "warnings": warnings, "in_footprints": inside,
        "error_count": sum(errors.values()),
        "warning_count": sum(warnings.values()),
        "unconnected": len(unconnected),
        "unconnected_examples": [" <-> ".join(i.get("description", "")[:50]
                                               for i in u.get("items", []))
                                 for u in unconnected[:6]],
        "examples": examples,
        "at": store.now(),
    }


async def render(db, board_id: str, route: bool = True) -> dict:
    """Place the board, draw it, and export a model of it.

    Everything comes from the last build: the netlist for what connects to
    what, and the footprints that build used. Laying out against whatever
    a library holds today would draw a different board from the one that
    was built.
    """
    if not await available():
        raise NoDocker(
            f"the KiCad container ({IMAGE}) is not built. "
            f"docker build -f docker/kicad.Dockerfile -t {IMAGE} .")

    graph = json.loads(await store.get_artifact(db, board_id, "graph",
                                                ato.BOARDS))

    # Where the shapes come from, in order of preference:
    #
    # 1. LCSC, by the part number the netlist carries. That is the part
    #    that will actually be bought, and it brings a 3D model with it;
    # 2. whatever the atopile build copied, for a component that came out
    #    of a library rather than a part number.
    #
    # A board drawn from a library footprint when a part number was given
    # is a picture of something nobody ordered.
    stock = library_shapes()
    parts, part_trouble = await lcsc.fetch_many(
        db, [c.get("part") for c in graph.get("components", [])
             if c.get("part") not in stock])
    try:
        shapes = json.loads(await store.get_artifact(db, board_id,
                                                    "footprints", ato.BOARDS))
    except KeyError:
        shapes = {}

    work = Path(tempfile.mkdtemp(prefix="x3pcb-"))
    try:
        pretty = work / "fp"
        pretty.mkdir()
        models = work / "3d"
        models.mkdir()
        for name, text in shapes.items():
            (pretty / f"{name}.kicad_mod").write_text(text)

        # An LCSC footprint points at its 3D model through an environment
        # variable that means nothing here, so the path is rewritten to
        # where the container will find it.
        for lcsc_id, part in parts.items():
            text = part["footprint"]
            got = await lcsc.model_of(db, lcsc_id)
            if got:
                blob, kind = got
                (models / f"{lcsc_id}.{kind}").write_bytes(blob)
                text = re.sub(r'\(model\s+"[^"]*"',
                              f'(model "/work/3d/{lcsc_id}.{kind}"', text)
            (pretty / f"{lcsc_id}.kicad_mod").write_text(text)

        shutil.copy(PLACER, work / "place.py")

        def shape_for(c: dict) -> str:
            """KiCad's own for a passive, the part number's if we have it,
            the library name otherwise."""
            if c.get("part") in stock:
                return stock[c["part"]]
            if c.get("part") in parts:
                return f"/work/fp/{c['part']}.kicad_mod"
            name = (c.get("footprint") or "").split(":")[-1]
            return f"/work/fp/{name}.kicad_mod"

        plan = {
            "out": "/work/board.kicad_pcb",
            "components": [
                {"ref": c.get("ref"), "value": c.get("value"),
                 "footprint": shape_for(c), "group": module_of(c)}
                for c in graph.get("components", [])],
            "nets": graph.get("nets", []),
        }

        meter = compute.Meter()
        proc = await asyncio.create_subprocess_exec(
            *_docker(work, "--entrypoint", "python3", IMAGE, "/work/place.py",
                     stdin=True),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        meter.watch(proc.pid)
        out, _ = await proc.communicate(json.dumps(plan).encode())
        text = out.decode(errors="replace")
        if proc.returncode != 0:
            meter.stop()
            raise RuntimeError("placing the board failed:\n" + text[-800:])
        try:
            placed = json.loads(text[text.index("{"):text.rindex("}") + 1])
        except ValueError:
            placed = {"placed": None, "missing": [], "note": text[-300:]}

        # The placed board is kept as it came out of the placer, before any
        # copper: what a person opens to place by hand and route again.
        placed_pcb = (work / "board.kicad_pcb").read_bytes()

        # Route: the rules on as net classes, out to Freerouting, back, and
        # the ground poured. Then KiCad's own DRC says what came of it.
        route_report, drc_report = None, None
        if route:
            nets = sorted({n.get("name") for n in graph.get("nets", []) if n.get("name")})
            board_doc = await db[ato.BOARDS].find_one({"_id": board_id},
                                                      {"rules": 1, "pads": 1}) or {}
            the_rules = rules.merge(board_doc.get("rules"), nets)
            await db[ato.BOARDS].update_one({"_id": board_id},
                                            {"$set": {"rules": the_rules}})
            problems = rules.check(the_rules, nets, board_doc.get("pads"))
            if problems:
                raise RuntimeError("the routing rules do not hold together: "
                                   + "; ".join(problems))
            shutil.copy(ROUTER, work / "route.py")
            plan = {"board": "/work/board.kicad_pcb", "out": "/work/board.kicad_pcb",
                    "rules": rules.resolved(the_rules, nets), "timeout": ROUTE_TIMEOUT}
            proc = await asyncio.create_subprocess_exec(
                *_docker(work, "--entrypoint", "python3", IMAGE, "/work/route.py",
                         stdin=True),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            meter.watch(proc.pid)
            out, _ = await asyncio.wait_for(
                proc.communicate(json.dumps(plan).encode()), ROUTE_TIMEOUT + 60)
            text = out.decode(errors="replace")
            try:
                route_report = json.loads(text[text.index("{"):text.rindex("}") + 1])
            except ValueError:
                raise RuntimeError("routing failed:\n" + text[-800:])
            if route_report.get("pads"):
                # Kept for the rules form: what each net's narrowest pad is.
                await db[ato.BOARDS].update_one(
                    {"_id": board_id}, {"$set": {"pads": route_report["pads"]}})
            if route_report.get("geometry"):
                # What the page hit-tests under the mouse: tracks, vias and
                # pads with their nets, in the drawing's own millimetres.
                await store.put_artifact(
                    db, board_id, "geometry",
                    json.dumps(route_report.pop("geometry")).encode(),
                    collection=ato.BOARDS)
            if route_report.get("error") == "rules":
                raise RuntimeError("the routing rules do not fit this board: "
                                   + "; ".join(route_report["problems"]))
            if route_report.get("error"):
                raise RuntimeError(f"routing failed: {route_report['error']}\n"
                                   + (route_report.get("log") or "")[-600:])
            drc_report = await drc(work, "board.kicad_pcb")

        rc, svg_log = await _run(
            _docker(work, IMAGE, "pcb", "export", "svg", "--output",
                    "layout.svg", "--layers", LAYERS,
                    "--exclude-drawing-sheet", "--page-size-mode", "2",
                    "board.kicad_pcb"), work)
        if rc != 0 or not (work / "layout.svg").exists():
            raise RuntimeError("drawing the board failed:\n" + svg_log[-800:])
        # The same front without the pour. A filled ground plane is most of
        # the board's copper, and drawn in the same red it hides the
        # tracks: you see the gaps round them, not them.
        tracks = None
        if route:
            (work / "strip.py").write_text(STRIP_ZONES)
            rc, _ = await _run(_docker(work, "--entrypoint", "python3", IMAGE,
                                       "/work/strip.py"), work)
            if rc == 0 and (work / "tracks.kicad_pcb").exists():
                rc, _ = await _run(
                    _docker(work, IMAGE, "pcb", "export", "svg", "--output",
                            "tracks.svg", "--layers", "F.Cu,B.Cu,F.SilkS,Edge.Cuts",
                            "--exclude-drawing-sheet", "--page-size-mode", "2",
                            "tracks.kicad_pcb"), work)
                if rc == 0 and (work / "tracks.svg").exists():
                    tracks = (work / "tracks.svg").read_bytes()

        # The bottom as well, once there is copper on it - seen from below,
        # the way you hold a board to look at its back.
        bottom = None
        if route:
            rc, _ = await _run(
                _docker(work, IMAGE, "pcb", "export", "svg", "--output",
                        "bottom.svg", "--layers", BOTTOM_LAYERS, "--mirror",
                        "--exclude-drawing-sheet", "--page-size-mode", "2",
                        "board.kicad_pcb"), work)
            if rc == 0 and (work / "bottom.svg").exists():
                bottom = (work / "bottom.svg").read_bytes()

        # The model is best effort: a footprint with no 3D shape attached
        # still draws, it just has nothing to show in three dimensions.
        glb = None
        # The library's models are addressed through KICAD9_3DMODEL_DIR;
        # said outright so the export finds them whatever the image sets.
        # And the copper, the mask and the silkscreen: without asking,
        # KiCad exports the parts on a bare green slab, and a routed board
        # looked exactly like an unrouted one.
        rc, glb_log = await _run(
            _docker(work, "-e", "KICAD9_3DMODEL_DIR=/usr/share/kicad/3dmodels",
                    IMAGE, "pcb", "export", "glb", "--output",
                    "board.glb", "--include-tracks", "--include-pads",
                    "--include-zones", "--include-soldermask",
                    "--include-silkscreen", "board.kicad_pcb"), work)
        if rc == 0 and (work / "board.glb").exists():
            glb = (work / "board.glb").read_bytes()

        job = meter.stop()
        try:
            await compute.record(db, "layout",
                                 await compute.current_revision(db, "pcb"),
                                 model=board_id, rc=0, **job)
        except Exception:
            pass

        svg = (work / "layout.svg").read_bytes()
        await store.put_artifact(db, board_id, "layout", svg,
                                 collection=ato.BOARDS)
        # The board files: placed only, and routed. Either opens in KiCad
        # for anybody who wants to take it further by hand.
        await store.put_artifact(db, board_id, "pcb", placed_pcb,
                                 collection=ato.BOARDS)
        if route:
            await store.put_artifact(db, board_id, "routed",
                                     (work / "board.kicad_pcb").read_bytes(),
                                     collection=ato.BOARDS)
        if bottom:
            await store.put_artifact(db, board_id, "bottom", bottom,
                                     collection=ato.BOARDS)
        if tracks:
            await store.put_artifact(db, board_id, "tracks", tracks,
                                     collection=ato.BOARDS)
        if glb:
            await store.put_artifact(db, board_id, "model3d", glb,
                                     collection=ato.BOARDS)
        routed = None
        if route_report:
            routed = {k: route_report.get(k) for k in
                      ("tracks", "vias", "length_mm", "zones", "unrouted",
                       "route_s", "passes")}
        await db[ato.BOARDS].update_one(
            {"_id": board_id},
            {"$set": {"layout": {"placed": placed.get("placed"),
                                 "missing": placed.get("missing") or [],
                                 "size_mm": placed.get("size_mm"),
                                 "at": store.now()},
                      "route": routed, "drc": drc_report}})
        return {"board": board_id, "svg_bytes": len(svg),
                "glb_bytes": len(glb) if glb else 0,
                "parts_from_lcsc": len(parts), "part_trouble": part_trouble,
                **placed, "route": routed, "drc": drc_report}
    finally:
        shutil.rmtree(work, ignore_errors=True)
