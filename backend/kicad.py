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

from . import ato, compute, lcsc, store

IMAGE = os.environ.get("X3_KICAD_IMAGE", "redline-kicad")
HERE = Path(__file__).resolve().parent.parent
PLACER = HERE / "docker" / "place.py"
TIMEOUT = 600

# The front of the board, as a render: copper, what is printed on it, the
# soldermask openings, and the outline that says where it ends.
LAYERS = "F.Cu,F.SilkS,F.Mask,Edge.Cuts"


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


async def render(db, board_id: str) -> dict:
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
    parts, part_trouble = await lcsc.fetch_many(
        db, [c.get("part") for c in graph.get("components", [])])
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
            """The part number if we have it, the library name otherwise."""
            if c.get("part") in parts:
                return f"/work/fp/{c['part']}.kicad_mod"
            name = (c.get("footprint") or "").split(":")[-1]
            return f"/work/fp/{name}.kicad_mod"

        plan = {
            "out": "/work/board.kicad_pcb",
            "components": [
                {"ref": c.get("ref"), "value": c.get("value"),
                 "footprint": shape_for(c)}
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

        rc, svg_log = await _run(
            _docker(work, IMAGE, "pcb", "export", "svg", "--output",
                    "layout.svg", "--layers", LAYERS,
                    "--exclude-drawing-sheet", "--page-size-mode", "2",
                    "board.kicad_pcb"), work)
        if rc != 0 or not (work / "layout.svg").exists():
            raise RuntimeError("drawing the board failed:\n" + svg_log[-800:])

        # The model is best effort: a footprint with no 3D shape attached
        # still draws, it just has nothing to show in three dimensions.
        glb = None
        rc, glb_log = await _run(
            _docker(work, IMAGE, "pcb", "export", "glb", "--output",
                    "board.glb", "board.kicad_pcb"), work)
        if rc == 0 and (work / "board.glb").exists():
            glb = (work / "board.glb").read_bytes()

        job = meter.stop()
        try:
            await compute.record(db, "layout",
                                 await compute.current_revision(db),
                                 model=board_id, rc=0, **job)
        except Exception:
            pass

        svg = (work / "layout.svg").read_bytes()
        await store.put_artifact(db, board_id, "layout", svg,
                                 collection=ato.BOARDS)
        if glb:
            await store.put_artifact(db, board_id, "model3d", glb,
                                     collection=ato.BOARDS)
        await db[ato.BOARDS].update_one(
            {"_id": board_id},
            {"$set": {"layout": {"placed": placed.get("placed"),
                                 "missing": placed.get("missing") or [],
                                 "size_mm": placed.get("size_mm"),
                                 "at": store.now()}}})
        return {"board": board_id, "svg_bytes": len(svg),
                "glb_bytes": len(glb) if glb else 0,
                "parts_from_lcsc": len(parts), "part_trouble": part_trouble,
                **placed}
    finally:
        shutil.rmtree(work, ignore_errors=True)
