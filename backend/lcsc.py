"""Parts, from LCSC.

A netlist names parts; it does not carry their shape. atopile used to ask
its own service for that and the service is gone, so the shape comes from
where the part is actually bought: EasyEDA publishes the footprint and the
3D model for every LCSC part, and `easyeda2kicad` turns both into KiCad's
own formats.

Fetched once and kept. A part number means the same thing tomorrow as it
did today, so asking twice is just being slow - and a board that is
rebuilt ten times should not hit somebody else's API ten times.

The 3D model matters more than it sounds: without one a board renders as
bare copper with nothing standing on it, which is not what anybody means
by a picture of the board.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

PARTS = "parts"
TIMEOUT = 90

# Lives with atopile, in its own environment.
TOOL = os.environ.get(
    "X3_EASYEDA", str(Path(__file__).resolve().parent.parent.parent.parent
                      / ".venv-ato" / "bin" / "easyeda2kicad"))

LCSC_ID = re.compile(r"^C\d{3,10}$")


def looks_like_a_part(text: str | None) -> bool:
    """LCSC numbers are C followed by digits, and nothing else is."""
    return bool(text and LCSC_ID.match(text.strip()))


async def _run(args: list[str], cwd: Path) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        raise TimeoutError(f"{args[0]} did not answer in {TIMEOUT}s")
    return proc.returncode, out.decode(errors="replace")


async def fetch(db, lcsc: str, force: bool = False) -> dict:
    """The footprint and 3D model for one part, from cache or from LCSC."""
    lcsc = (lcsc or "").strip()
    if not looks_like_a_part(lcsc):
        raise ValueError(f"{lcsc!r} is not an LCSC part number")

    if not force:
        got = await db[PARTS].find_one({"_id": lcsc})
        if got and got.get("footprint"):
            return got

    if not Path(TOOL).exists():
        raise RuntimeError(f"easyeda2kicad is not at {TOOL}")

    tmp = Path(tempfile.mkdtemp(prefix="x3lcsc-"))
    try:
        rc, log = await _run(
            [TOOL, "--lcsc_id", lcsc, "--footprint", "--3d",
             "--output", str(tmp / "lib")], tmp)
        pretty = list((tmp / "lib.pretty").glob("*.kicad_mod")) \
            if (tmp / "lib.pretty").exists() else []
        if rc != 0 or not pretty:
            raise RuntimeError(f"{lcsc}: nothing came back\n{log[-400:]}")

        fp = pretty[0]
        doc = {
            "_id": lcsc,
            "name": fp.stem,
            "footprint": fp.read_text(),
            "at": datetime.now(timezone.utc).isoformat(),
        }
        shapes = tmp / "lib.3dshapes"
        if shapes.exists():
            # STEP for a solid the exporter can use; the WRL is what KiCad
            # shows in its own viewer. Whichever is there.
            for suffix in (".step", ".wrl"):
                hit = next(iter(shapes.glob(f"*{suffix}")), None)
                if hit:
                    doc[f"model{suffix.replace('.', '_')}"] = hit.read_bytes()
                    doc["model_name"] = hit.stem
        await db[PARTS].replace_one({"_id": lcsc}, doc, upsert=True)
        return doc
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


async def fetch_many(db, ids: list[str]) -> tuple[dict, list[str]]:
    """Every part a board needs, and the ones that could not be had.

    One at a time on purpose: this is somebody else's service, and a board
    with thirty parts should not open thirty connections to it.
    """
    out, failed = {}, []
    for lcsc in dict.fromkeys(i for i in ids if looks_like_a_part(i)):
        try:
            out[lcsc] = await fetch(db, lcsc)
        except (ValueError, RuntimeError, TimeoutError, OSError) as exc:
            failed.append(f"{lcsc}: {exc}")
    return out, failed


async def known(db) -> list[dict]:
    """What is in the drawer already."""
    rows = [{"lcsc": p["_id"], "name": p.get("name"),
             "has_3d": bool(p.get("model_step") or p.get("model_wrl")),
             "at": p.get("at")}
            async for p in db[PARTS].find({}, {"footprint": 0, "model_step": 0,
                                               "model_wrl": 0})]
    rows.sort(key=lambda r: r["lcsc"])
    return rows
