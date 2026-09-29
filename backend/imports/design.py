"""A design file, opened by KiCad in its container.

KiCad reads its own boards and, through pcbnew's IO plugins, EasyEDA
Std/Pro, Altium, Eagle, CADSTAR, P-CAD, Fabmaster (and IPC-2581/ODB++
where the KiCad in the image can read them). `pcbnew_load.py` - our
script, run in the container - loads the file with the right plugin and
saves it as a .kicad_pcb; kicad-cli then draws it exactly the way a board
laid out in Redline is drawn (backend/kicad.py), so everything a built
board has comes out of the same tools.

KiCad is GPL and stays a tool here: nothing of its source is in this
repository, the container is only run.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

from .. import kicad

HERE = Path(__file__).resolve().parent
LOADER = HERE / "pcbnew_load.py"
PDF_LAYERS = "F.Cu,B.Cu,F.Mask,B.Mask,F.SilkS,B.SilkS,F.Paste,B.Paste,Edge.Cuts"


class DesignError(RuntimeError):
    pass


async def open_design(name: str, data: bytes, plugin: str | None,
                      progress=None) -> dict:
    """Load one design file and draw it. Returns graph, placement, size,
    drills, route counts and the drawings/model/PDF/.kicad_pcb as bytes."""
    if not await kicad.available():
        raise DesignError(f"the KiCad container ({kicad.IMAGE}) is not built, so design "
                          f"files cannot be opened")
    work = Path(tempfile.mkdtemp(prefix="x3imp-"))
    try:
        os.chmod(work, 0o777)
        (work / "in").mkdir()
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", Path(name).name) or "board"
        src = work / "in" / safe
        src.write_bytes(data)
        shutil.copy(LOADER, work / "load.py")
        for p in work.rglob("*"):
            os.chmod(p, 0o777 if p.is_dir() else 0o666)

        if progress:
            await progress("opening the design in KiCad")
        proc = await asyncio.create_subprocess_exec(
            *kicad._docker(work, "--entrypoint", "python3", kicad.IMAGE, "/work/load.py",
                           stdin=True),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT)
        job = {"input": f"/work/in/{safe}", "plugin": plugin, "out": "/work/board.kicad_pcb"}
        out, _ = await asyncio.wait_for(proc.communicate(json.dumps(job).encode()), kicad.TIMEOUT)
        text = out.decode(errors="replace")
        try:
            got = json.loads(text[text.index("{"):text.rindex("}") + 1])
        except ValueError:
            raise DesignError("KiCad could not open the file:\n" + text[-600:])
        if got.get("error"):
            raise DesignError(got["error"])
        if not (work / "board.kicad_pcb").exists():
            raise DesignError("KiCad opened the file but wrote no board")

        if progress:
            await progress("drawing the design with kicad-cli")
        svg = {}
        for key, layers, extra in (("layout", kicad.LAYERS, []),
                                   ("bottom", kicad.BOTTOM_LAYERS, ["--mirror"])):
            rc, log = await kicad._run(kicad._docker(
                work, kicad.IMAGE, "pcb", "export", "svg", "--output", f"{key}.svg",
                "--layers", layers, *extra, "--exclude-drawing-sheet", "--page-size-mode", "2",
                "board.kicad_pcb"), work)
            if rc == 0 and (work / f"{key}.svg").exists():
                svg[key] = (work / f"{key}.svg").read_bytes()
        # The tracks view: the same board without its pours.
        (work / "strip.py").write_text(kicad.STRIP_ZONES)
        rc, _ = await kicad._run(kicad._docker(work, "--entrypoint", "python3", kicad.IMAGE,
                                               "/work/strip.py"), work)
        if rc == 0 and (work / "tracks.kicad_pcb").exists():
            rc, _ = await kicad._run(kicad._docker(
                work, kicad.IMAGE, "pcb", "export", "svg", "--output", "tracks.svg",
                "--layers", "F.Cu,B.Cu,F.SilkS,Edge.Cuts", "--exclude-drawing-sheet",
                "--page-size-mode", "2", "tracks.kicad_pcb"), work)
            if rc == 0 and (work / "tracks.svg").exists():
                svg["tracks"] = (work / "tracks.svg").read_bytes()

        if progress:
            await progress("exporting the 3D model and the layer PDF")
        rc, _ = await kicad._run(kicad._docker(
            work, "-e", "KICAD9_3DMODEL_DIR=/usr/share/kicad/3dmodels", kicad.IMAGE,
            "pcb", "export", "glb", "--output", "board.glb", "--include-tracks",
            "--include-pads", "--include-zones", "--include-soldermask",
            "--include-silkscreen", "board.kicad_pcb"), work)
        glb = (work / "board.glb").read_bytes() if rc == 0 and (work / "board.glb").exists() else None
        rc, _ = await kicad._run(kicad._docker(
            work, kicad.IMAGE, "pcb", "export", "pdf", "--output", "layers.pdf",
            "--layers", PDF_LAYERS, "--mode-multipage", "--black-and-white",
            "board.kicad_pcb"), work)
        # In multipage mode kicad-cli takes --output as a directory.
        out_pdf = work / "layers.pdf"
        found = sorted(out_pdf.glob("*.pdf")) if out_pdf.is_dir() else [out_pdf] if out_pdf.exists() else []
        pdf = found[0].read_bytes() if rc == 0 and found else None
        return {**got, "svg": svg, "glb": glb, "pdf": pdf,
                "kicad_pcb": (work / "board.kicad_pcb").read_bytes()}
    finally:
        shutil.rmtree(work, ignore_errors=True)
