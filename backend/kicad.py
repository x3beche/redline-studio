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
import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

from . import ato, compute, lcsc, limits, routelive, rules, store

IMAGE = os.environ.get("REDLINE_KICAD_IMAGE", "redline-kicad")
HERE = Path(__file__).resolve().parent.parent
PLACER = HERE / "docker" / "place.py"
ROUTER = HERE / "docker" / "route.py"
ROUTE_TIMEOUT = 900
# TraceMaker (docker/tracemaker.Dockerfile), the other router: its own
# image, since it is built on a newer system than the KiCad one.
TM_IMAGE = os.environ.get("REDLINE_TRACEMAKER_IMAGE", "redline-tracemaker")
LIVE = "live.jsonl"                 # its stream, for the page (backend/routelive.py)


def tm_threads() -> int:
    """As many router threads as the container has CPUs."""
    try:
        return max(1, int(float(limits.box()[1])))
    except (ValueError, IndexError):
        return 4


def tm_summary(log: str) -> str | None:
    """TraceMaker's last word: `routed 235/235 connections, 981 tracks, 178 vias, ...`."""
    for line in reversed((log or "").splitlines()):
        if line.startswith("routed ") and "connections" in line:
            return line.strip()
    return None

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


MARGIN = 20.0            # where a held board's corner goes on KiCad's page, mm


def to_page(box, x: float, y: float) -> list[float]:
    """A point in the Gerbers' frame (mm, y up) on KiCad's page (y down),
    the board's top-left corner at MARGIN, MARGIN."""
    x0, _y0, _x1, y1 = box
    return [round(x - x0 + MARGIN, 5), round(y1 - y + MARGIN, 5)]


async def held_plan(db, board_id: str, hold: dict | None) -> dict | None:
    """What the placer needs to put a board back the way it was: each
    part's pads and centre, and the outline, on KiCad's page.

    A board converted from an import is marked `hold` (backend/convert.py)
    with the Gerbers' outline; where its parts sat is the import's own
    `pads` and `placement`. Anything else - a board Redline designed, or a
    held board someone let go (`hold.placement` false) - is packed as
    usual, and this says None.
    """
    if not hold or not hold.get("placement") or not hold.get("outline"):
        return None
    outline = hold["outline"]
    box = outline["box"]
    pads = json.loads(await store.get_artifact(db, board_id, "pads", ato.BOARDS))
    try:
        placed = json.loads(await store.get_artifact(db, board_id, "placement", ato.BOARDS))
    except KeyError:
        placed = {"parts": []}
    parts: dict[str, dict] = {}
    for p in pads:
        parts.setdefault(p["ref"], {"pads": {}})["pads"].setdefault(
            str(p["pin"]), to_page(box, p["x"], p["y"]))
    for p in placed.get("parts", []):
        entry = parts.setdefault(p["ref"], {"pads": {}})
        # The placement is kept from the board's lower-left corner.
        entry["at"] = to_page(box, p["x"] + box[0], p["y"] + box[1])
        entry["rot"] = p.get("rot") or 0
        entry["side"] = p.get("side") or "top"
    for ref, entry in parts.items():
        if "at" not in entry and entry["pads"]:
            pts = list(entry["pads"].values())
            entry["at"] = [sum(q[0] for q in pts) / len(pts), sum(q[1] for q in pts) / len(pts)]
    loops = [[{k: [to_page(box, *pt) for pt in v] for k, v in piece.items()} for piece in loop]
             for loop in outline["loops"]]
    # The holes no part owns, where the drills had them. A board converted
    # before they were kept has them worked out from its upload now.
    holes = hold.get("holes")
    if holes is None:
        from . import convert
        try:
            sources = await store.get_artifact(db, board_id, "sources", ato.BOARDS)
        except KeyError:
            sources = None
        holes = (await asyncio.to_thread(convert.import_geometry, sources, pads, outline))["holes"]
    return {"parts": parts, "outline": loops,
            "holes": [{"at": to_page(box, h["x"], h["y"]), "d": h["d"],
                       "plated": bool(h.get("plated"))} for h in holes]}


BOARD3D = HERE / "docker" / "board3d.py"


async def library_footprints(db, board_id: str) -> dict[str, str]:
    """Each part's footprint by its library name (`TYPE-C-SMD_...`,
    `HDR-TH_5P-...`), from the build's netlist: the layout names a footprint
    by its LCSC number, which says nothing about what the part is."""
    try:
        graph = json.loads(await store.get_artifact(db, board_id, "graph", ato.BOARDS))
    except (KeyError, ValueError):
        return {}
    return {c["ref"]: str(c.get("footprint") or "").split(":")[-1]
            for c in graph.get("components") or [] if c.get("ref")}


async def component_of(work: Path, board_id: str, glb: bytes | None,
                       library: dict[str, str] | None = None):
    """The board's STEP, named data and STL, from the routed board in
    `work` (its 3D models still in work/3d, where the footprints point).

    STEP options: the board body and every part's own STEP, without the
    copper, mask and silkscreen - a component is for fitting things round,
    and the copper made the file several times larger and slow to open in
    a 3D design. Vias are not cut (thousands of holes nobody fits a screw
    through); `--subst-models` uses a STEP where a footprint names a WRL
    and one of the same name exists. The origin is the outline's
    lower-left corner, the frame backend/board3d.py describes.
    """
    from . import board3d
    shutil.copy(BOARD3D, work / "board3d.py")
    rc, text = await _run(_docker(work, "--entrypoint", "python3", IMAGE,
                                  "/work/board3d.py", "/work/board.kicad_pcb"), work)
    if rc != 0:
        raise RuntimeError("reading the board failed:\n" + text[-600:])
    info = json.loads(text[text.index("{"):text.rindex("}") + 1])
    for fp in info.get("footprints") or []:
        if (library or {}).get(fp["ref"]):
            fp["library"] = library[fp["ref"]]
    x0, _y0, _x1, y1 = info["box"]
    name = f"{board_id.replace('/', '__')}.step"
    rc, log = await _run(
        _docker(work, "-e", "KICAD9_3DMODEL_DIR=/usr/share/kicad/3dmodels", IMAGE,
                "pcb", "export", "step", "--output", name, "--force", "--subst-models",
                "--no-dnp", "--user-origin", f"{x0}x{y1}mm", "board.kicad_pcb"), work)
    if rc != 0 or not (work / name).exists():
        raise RuntimeError("the STEP export failed:\n" + log[-600:])
    step = (work / name).read_bytes()
    frame = board3d.frame_of(info)
    boxes = await asyncio.to_thread(board3d.glb_boxes, glb, frame) if glb else {}
    data = board3d.describe(info, boxes)
    stl = await asyncio.to_thread(board3d.glb_stl, glb, frame) if glb else None
    return step, data, stl, design_digest(work, info, data)


def design_digest(work: Path, info: dict, data: dict) -> str:
    """What the STEP is made of, as one hash: every footprint where it is
    and which way, its 3D model's file, offset and turn, the outline and
    the named data. Not the STEP's own bytes - KiCad writes the same board
    with its entities in a different order each time, and a dependent
    would be rebuilt after every layout for nothing."""
    from . import modelseat
    pcb = (work / "board.kicad_pcb").read_text(errors="replace")
    seats = {f["ref"]: [f["model"], f["offset"], f["rotation"]]
             for f in modelseat.board_footprints(pcb)}
    files = {}
    for path in sorted((work / "3d").glob("*")) if (work / "3d").is_dir() else []:
        files[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    feet = sorted([f["ref"], f["footprint"], f["x"], f["y"], f.get("angle"), f.get("side"),
                   seats.get(f["ref"])] for f in info.get("footprints") or [])
    blob = json.dumps({"feet": feet, "files": files, "outline": info.get("outline"),
                       "thickness": info.get("thickness"), "data": data}, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()


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
    run = ["docker", "run", "--rm", *limits.box()]     # backend/limits.py
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

    work = Path(tempfile.mkdtemp(prefix="redline-pcb-"))
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
        wrl_only: dict[str, str] = {}      # LCSC number -> a model KiCad cannot export
        for lcsc_id, part in parts.items():
            text = part["footprint"]
            got = await lcsc.model_of(db, lcsc_id)
            if got:
                blob, kind = got
                if kind == "wrl":
                    wrl_only[lcsc_id] = blob.decode("utf-8", errors="replace")
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
        # A board converted from an import keeps the layout its maker gave
        # it: the placer puts every part back instead of packing it again.
        held = await held_plan(db, board_id, ((await db[ato.BOARDS].find_one(
            {"_id": board_id}, {"hold": 1})) or {}).get("hold"))
        if held:
            plan["hold"] = held
        # The copper-to-edge rule on the placed board as well, so the board
        # opened by hand is checked against the same edge as the routed one.
        board_rules = (await db[ato.BOARDS].find_one({"_id": board_id}, {"rules": 1}) or {}).get("rules")
        plan["min_edge"] = (rules.normalise(board_rules).get("board") or {}).get("min_edge", rules.EDGE) \
            if board_rules else rules.EDGE
        plan["edge_clearance"] = plan["min_edge"]        # where the packer seats a connector

        meter = compute.Meter()

        async def place_once(attempt: int) -> dict:
            """One layout. `attempt` 0 is the tightest packing the placer
            found; each one after it is the next-tightest."""
            proc = await asyncio.create_subprocess_exec(
                *_docker(work, "--entrypoint", "python3", IMAGE, "/work/place.py",
                         stdin=True),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            meter.watch(proc.pid)
            out, _ = await proc.communicate(
                json.dumps({**plan, "attempt": attempt}).encode())
            text = out.decode(errors="replace")
            if proc.returncode != 0:
                meter.stop()
                raise RuntimeError("placing the board failed:\n" + text[-800:])
            try:
                return json.loads(text[text.index("{"):text.rindex("}") + 1])
            except ValueError:
                return {"placed": None, "missing": [], "note": text[-300:]}

        async def boxed(image: str, script: str, payload: dict, timeout: float) -> dict:
            """A script in a container, a plan on its stdin, its answer the
            last JSON object it prints."""
            proc = await asyncio.create_subprocess_exec(
                *_docker(work, "--entrypoint", "python3", image, script, stdin=True),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            meter.watch(proc.pid)
            out, _ = await asyncio.wait_for(proc.communicate(json.dumps(payload).encode()), timeout)
            text = out.decode(errors="replace")
            try:
                return json.loads(text[text.index("{"):text.rindex("}") + 1])
            except ValueError:
                raise RuntimeError("routing failed:\n" + text[-800:])

        attempts = {"n": 0}

        async def route_tracemaker(payload: dict) -> dict:
            """board -> net classes on, no pour (route.py prepare) ->
            TraceMaker, its stream kept for the page (docker/tm_relay.py)
            -> pour, count, report (route.py finish)."""
            rc, _ = await _run(["docker", "image", "inspect", TM_IMAGE], work)
            if rc != 0:
                return {"error": f"the TraceMaker container ({TM_IMAGE}) is not built. docker build "
                                 f"-f docker/tracemaker.Dockerfile -t {TM_IMAGE} . - or route with Freerouting"}
            got = await boxed(IMAGE, "/work/route.py",
                              {**payload, "stage": "prepare", "pre": "/work/pre.kicad_pcb"}, ROUTE_TIMEOUT)
            if got.get("error"):
                return got
            seconds = int(payload["rules"].get("route", {}).get("seconds", 120))
            args = ["--time", str(seconds), "--threads", str(tm_threads())]
            if payload["rules"].get("pairs"):
                args.append("--diff-pairs")
            attempts["n"] += 1
            (work / LIVE).unlink(missing_ok=True)
            await routelive.begin(db, board_id, str(work / LIVE), "tracemaker", attempts["n"])
            try:
                tm = await boxed(TM_IMAGE, "/opt/tm_relay.py",
                                 {"board": "/work/pre.kicad_pcb", "out": "/work/routed.kicad_pcb",
                                  "args": args, "live": f"/work/{LIVE}", "timeout": seconds + 60},
                                 seconds + 180)
            finally:
                await routelive.end(db, board_id)
            if not (work / "routed.kicad_pcb").exists():
                return {"error": f"TraceMaker wrote no board (exit {tm.get('rc')})", "log": tm.get("log")}
            got = await boxed(IMAGE, "/work/route.py",
                              {**payload, "stage": "finish", "routed": "/work/routed.kicad_pcb",
                               "route_s": tm.get("seconds"), "log": tm.get("log") or ""}, ROUTE_TIMEOUT)
            got["tracemaker"] = {"summary": tm_summary(tm.get("log") or ""), "seconds": tm.get("seconds"),
                                 "args": args}
            return got

        async def route_once(payload: dict) -> dict:
            if payload["rules"].get("route", {}).get("engine") == "tracemaker":
                got = await route_tracemaker(payload)
            else:
                # The board, then a round of what it left over: those
                # alone, and the board round them (docker/route.py
                # leftovers_first) - each Freerouting run its own timeout.
                got = await boxed(IMAGE, "/work/route.py", payload, 4 * ROUTE_TIMEOUT + 60)
            if got.get("error") == "rules":
                raise RuntimeError("the routing rules do not fit this board: "
                                   + "; ".join(got["problems"]))
            if got.get("error"):
                raise RuntimeError(f"routing failed: {got['error']}\n"
                                   + (got.get("log") or "")[-600:])
            return got

        # Route: the rules on as net classes, out to Freerouting, back, and
        # the ground poured. Then KiCad's own DRC says what came of it.
        route_report, drc_report = None, None
        if not route:
            placed = await place_once(0)
            # The placed board is kept as it came out of the placer, before
            # any copper: what a person opens to place by hand and route
            # again.
            placed_pcb = (work / "board.kicad_pcb").read_bytes()
        else:
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
            payload = {"board": "/work/board.kicad_pcb",
                       "out": "/work/board.kicad_pcb",
                       "rules": rules.resolved(the_rules, nets),
                       "timeout": ROUTE_TIMEOUT,
                       # Kept as imported: its parts at the edge are the design.
                       "held": bool(held)}

            # `route.tries` in the rules: how many layouts to try before
            # settling. Routing the same board again is pointless -
            # Freerouting gives the same answer on the same DSN, every
            # time - so a try that comes up a connection short is laid out
            # again one packing looser, which is a different board and a
            # different problem. The tightest that routes clean wins; if
            # none does, the one that came closest is kept, smallest first.
            tries = max(1, int(the_rules.get("route", {}).get("tries", 1)))
            best, used = None, 0
            for attempt in range(tries):
                used = attempt + 1
                got = await place_once(attempt)
                pcb = (work / "board.kicad_pcb").read_bytes()
                report = await route_once(payload)
                size = got.get("size_mm") or [0, 0]
                rank = (report.get("unrouted") if report.get("unrouted") is not None
                        else 1 << 30, round(size[0] * size[1], 2))
                if best is None or rank < best[0]:
                    shutil.copy(work / "board.kicad_pcb", work / "best.kicad_pcb")
                    best = (rank, got, pcb, report)
                if rank[0] == 0:
                    break
            _, placed, placed_pcb, route_report = best
            shutil.copy(work / "best.kicad_pcb", work / "board.kicad_pcb")
            route_report["attempts"] = used
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
            drc_report = await drc(work, "board.kicad_pcb")
            if route_report.get("edge_exempt"):
                # Said, so a clean edge is not mistaken for a looser rule.
                drc_report["edge_exempt"] = route_report["edge_exempt"]

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
            if wrl_only:
                # KiCad leaves a WRL-only part out of the GLB; its mesh goes
                # in where KiCad would have put it (backend/modelseat.py).
                from . import modelseat
                glb, _added = await asyncio.to_thread(
                    modelseat.add_meshes, glb, (work / "board.kicad_pcb").read_text(), wrl_only)

        # The board as a component (backend/board3d.py): a STEP of it with
        # its parts, its named data and an STL, in the board's own frame.
        # Best effort like the GLB - a board that will not export still
        # has its layout.
        component = None
        try:
            component = await component_of(work, board_id, glb,
                                            await library_footprints(db, board_id))
        except Exception as exc:                            # noqa: BLE001 - said, not fatal
            part_trouble = [*part_trouble, f"3D component not made: {str(exc)[:300]}"]
            # Kept on the board, so `component show` and the card can say why.
            await db[ato.BOARDS].update_one({"_id": board_id}, {"$set": {"component_error": {
                "at": _now_iso(), "error": str(exc)[-1500:]}}})

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
        linked = None
        if component:
            from . import links
            step, data, stl, digest = component
            try:
                linked = await links.board_component(
                    db, board_id, step, data, stl, digest=digest,
                    glb_digest=hashlib.sha256(glb).hexdigest() if glb else "")
            except Exception as exc:                        # noqa: BLE001 - the layout stands
                part_trouble = [*part_trouble, f"3D component not stored: {str(exc)[:300]}"]
        routed = None
        if route_report:
            routed = {k: route_report.get(k) for k in
                      ("tracks", "vias", "length_mm", "zones", "unrouted",
                       "route_s", "passes", "attempts", "edge_exempt", "leftovers")}
        await db[ato.BOARDS].update_one(
            {"_id": board_id},
            {"$set": {"layout": {"placed": placed.get("placed"),
                                 "missing": placed.get("missing") or [],
                                 "size_mm": placed.get("size_mm"),
                                 "at": store.now(),
                                 # A held board: how close every part came
                                 # to where the import had it.
                                 **{k: placed[k] for k in ("held", "held_worst_mm",
                                                           "held_off", "held_by_centre",
                                                           "holes", "placed_new")
                                    if k in placed}},
                      "route": routed, "drc": drc_report}})
        return {"board": board_id, "svg_bytes": len(svg),
                "glb_bytes": len(glb) if glb else 0,
                "parts_from_lcsc": len(parts), "part_trouble": part_trouble,
                "component": {k: linked[k] for k in ("version", "changed", "queued")
                              if k in linked} if linked else None,
                **placed, "route": routed, "drc": drc_report}
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def refresh_component(db, board_id: str) -> dict:
    """The board's 3D component from the board as it is - the routed
    layout, or the placed one - without placing or routing it again: for a
    board laid out before boards were components, or after the export
    itself changed. The same export a layout ends with."""
    if not await available():
        raise NoDocker(f"the KiCad container ({IMAGE}) is not built")
    pcb = None
    for name in ("routed", "pcb"):
        try:
            pcb = await store.get_artifact(db, board_id, name, ato.BOARDS)
            break
        except KeyError:
            continue
    if pcb is None:
        doc = await db[ato.BOARDS].find_one({"_id": board_id},
                                            {"kind": 1, "hold": 1, "layout": 1, "imported": 1})
        if doc and doc.get("kind") == "imported":
            # Brought in from Gerbers and a STEP, never laid out here: the
            # component comes from what the import kept.
            return await imported_component(db, board_id, doc)
        raise KeyError(f"{board_id} has no layout yet")
    try:
        glb = await store.get_artifact(db, board_id, "model3d", ato.BOARDS)
    except KeyError:
        glb = None
    work = Path(tempfile.mkdtemp(prefix="redline-pcb-"))
    try:
        (work / "3d").mkdir()
        text = pcb.decode("utf-8", errors="replace")
        (work / "board.kicad_pcb").write_text(text)
        # The layout pointed every LCSC part at /work/3d/<number>.<kind>;
        # the same files go back where it looked.
        for lcsc_id, kind in sorted(set(re.findall(r'\(model "/work/3d/(C\d+)\.(\w+)"', text))):
            got = await lcsc.model_of(db, lcsc_id)
            if got:
                (work / "3d" / f"{lcsc_id}.{got[1]}").write_bytes(got[0])
                if got[1] != kind:
                    # Fetched again since the layout (`part keep --refresh`) and
                    # now a STEP where it was a WRL: pointed at what is stored,
                    # so the part is a body in the STEP, not a box.
                    text = text.replace(f'(model "/work/3d/{lcsc_id}.{kind}"',
                                        f'(model "/work/3d/{lcsc_id}.{got[1]}"')
        (work / "board.kicad_pcb").write_text(text)
        step, data, stl, digest = await component_of(work, board_id, glb,
                                                     await library_footprints(db, board_id))
        from . import links
        out = await links.board_component(
            db, board_id, step, data, stl, digest=digest,
            glb_digest=hashlib.sha256(glb).hexdigest() if glb else "")
        return {"board": board_id, "step_bytes": len(step), **out}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


async def imported_component(db, board_id: str, doc: dict) -> dict:
    """An imported board's 3D component, from what the import kept: the
    Gerbers' outline and drills, the parts' placement and pads, and the
    GLB made from the uploaded STEP (its parts named by designator).

    There is no .kicad_pcb to export a STEP from, and the uploaded STEP is
    not kept, so the STEP here is the bare board - outline, cutouts, every
    hole - and every part stands in `B.part` as the box of its body in the
    GLB (all listed in `B.APPROXIMATE`). The named data - size, holes,
    connectors, keepout, height map - is as exact as the import."""
    from . import board3d, convert, links
    try:
        glb = await store.get_artifact(db, board_id, "model3d", ato.BOARDS)
    except KeyError:
        glb = None

    async def art(name):
        try:
            return await store.get_artifact(db, board_id, name, ato.BOARDS)
        except KeyError:
            return None

    pads = json.loads(await art("pads") or b"[]")
    placement = json.loads(await art("placement") or b"{}").get("parts") or []
    graph = json.loads(await art("imported_graph") or await art("graph") or b"{}") or {}
    sources = await art("sources")
    outline = (doc.get("hold") or {}).get("outline")
    hits = await asyncio.to_thread(_drill_hits, sources)
    info = board3d.imported_info(outline, (doc.get("layout") or {}).get("size_mm"),
                                 pads, placement, graph.get("components") or [], hits)
    # The assembled STEP it came with, if the uploads still have it.
    step_src = None
    for f in (doc.get("imported") or {}).get("files") or []:
        if f.get("kind") == "step":
            try:
                step_src = await store.get_upload(db, f["file"])
                break
            except KeyError:
                continue
    step, data, stl = await asyncio.to_thread(board3d.imported_component, info, glb, step_src)
    digest = hashlib.sha256((board3d.data_digest(data)
                             + (hashlib.sha256(glb).hexdigest() if glb else "")).encode()).hexdigest()
    out = await links.board_component(db, board_id, step, data, stl, digest=digest,
                                      glb_digest=hashlib.sha256(glb).hexdigest() if glb else "")
    return {"board": board_id, "step_bytes": len(step), "from": "import",
            "step_from": data.get("step_from"), **out}


def _drill_hits(sources: bytes | None) -> list[dict]:
    """Every drilled hole the upload's drill files have (not vias), mm in
    the Gerbers' frame."""
    import io
    import zipfile
    from .imports import detect, gerbers
    if not sources:
        return []
    try:
        with zipfile.ZipFile(io.BytesIO(sources)) as z:
            files = [(n, z.read(n)) for n in z.namelist() if not n.endswith("/")]
    except zipfile.BadZipFile:
        return []
    items = [i for i in detect.sort_upload(files) if i.kind in (detect.GERBER, detect.DRILL)]
    if not items:
        return []
    board = gerbers.Board(items)
    try:
        return board.drill_hits()
    finally:
        board.close()
