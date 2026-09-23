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
import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from . import store

PARTS = "parts"
TIMEOUT = 90
# Their service, so it is asked politely and named honestly.
AGENT = "redline/1.0 (board room; one request per part)"

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


# EasyEDA's own catalogue search, which is LCSC's. The part numbers it
# gives back are the ones `fetch` takes, so a search result is one click
# from a footprint and a 3D model.
SEARCH = "https://easyeda.com/api/eda/product/list"


def _ask(url: str) -> dict:
    """One GET, blocking. Its own function so a test can stand in for it
    rather than calling somebody else's service."""
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode(errors="replace"))


async def search(term: str, limit: int = 20) -> list[dict]:
    """Look for a part by name, package, manufacturer - or by number.

    Returns what a person needs to choose between two capacitors: the
    number to order, what it is, how it is packaged, and whether anybody
    has it in stock. Not the footprint - that is a download, and it
    happens when one is picked.
    """
    import urllib.parse

    term = (term or "").strip()
    if not term:
        return []

    url = (f"{SEARCH}?keyword={urllib.parse.quote(term)}"
           f"&page=1&pageSize={max(1, min(limit, 50))}")
    body = await asyncio.get_running_loop().run_in_executor(None, _ask, url)
    rows = ((body or {}).get("result") or {}).get("productList") or []

    out = []
    for row in rows:
        price = None
        for band in row.get("price") or []:
            # [quantity, price, price with tax] - the first band is one-off.
            if len(band) >= 2:
                try:
                    price = float(band[1])
                except (TypeError, ValueError):
                    price = None
                break
        out.append({
            "lcsc": row.get("number"),
            "mpn": row.get("mpn"),
            "package": row.get("package"),
            "maker": row.get("manufacturer"),
            "stock": row.get("stock"),
            "price": price,
        })
    return [r for r in out if looks_like_a_part(r["lcsc"])]


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
        await db[PARTS].replace_one({"_id": lcsc}, doc, upsert=True)

        # The model goes where every other generated thing goes: gzipped
        # into GridFS, with a copy on disk. An LQFP-48 is a 9.8 MB STEP,
        # and writing that into the document took ninety-nine seconds -
        # a document is for the things you search by, not for megabytes.
        #
        # STEP is what the board exporter can use; the WRL is what KiCad
        # shows in its own viewer. One of them, not both.
        shapes = tmp / "lib.3dshapes"
        if shapes.exists():
            for suffix in (".step", ".wrl"):
                hit = next(iter(shapes.glob(f"*{suffix}")), None)
                if not hit:
                    continue
                await store.put_artifact(db, lcsc, "model", hit.read_bytes(),
                                         collection=PARTS)
                await db[PARTS].update_one(
                    {"_id": lcsc},
                    {"$set": {"model_name": hit.stem,
                              "model_kind": suffix.lstrip(".")}})
                doc["model_name"] = hit.stem
                doc["model_kind"] = suffix.lstrip(".")
                break
        return await db[PARTS].find_one({"_id": lcsc}) or doc

    finally:
        shutil.rmtree(tmp, ignore_errors=True)


async def model_of(db, lcsc: str) -> tuple[bytes, str] | None:
    """The part's 3D model, and which format it is in.

    Parts fetched before the models moved out of the document still carry
    them inline; those are read from where they are rather than being
    migrated, because the next fetch of that part writes it the new way.
    """
    doc = await db[PARTS].find_one({"_id": lcsc})
    if not doc:
        return None
    if (doc.get("artifacts") or {}).get("model"):
        blob = await store.get_artifact(db, lcsc, "model", PARTS)
        return blob, doc.get("model_kind") or "step"
    for field, kind in (("model_step", "step"), ("model_wrl", "wrl")):
        if doc.get(field):
            return bytes(doc[field]), kind
    return None


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
    """What is in the drawer already.

    Asked as an aggregation because the answer must not carry a STEP file
    per part across the wire. Leaving those fields out of a find() left
    `has_3d` reading false for every part that had one - what is not
    fetched cannot be truthy.
    """
    rows = [row async for row in db[PARTS].aggregate([
        {"$project": {
            "name": 1, "at": 1,
            "has_3d": {"$or": [{"$ifNull": ["$artifacts.model", False]},
                               {"$ifNull": ["$model_step", False]},
                               {"$ifNull": ["$model_wrl", False]}]},
        }},
        {"$sort": {"_id": 1}},
    ])]
    return [{"lcsc": r["_id"], "name": r.get("name"),
             "has_3d": bool(r.get("has_3d")), "at": r.get("at")}
            for r in rows]
