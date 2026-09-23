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
# Their service, so it is asked politely and named honestly. The
# "compatible" prefix is for their image host, which holds a request
# without a browser-shaped agent open until it times out - ninety seconds
# for a 35 kB photo - while the same request with it takes one.
AGENT = "Mozilla/5.0 (compatible; redline/1.0; board room)"

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


# ---- a look before buying ------------------------------------------------
#
# Everything a person needs to decide on a part - what it is, its
# footprint, its symbol, its 3D shape, a photo - is public on EasyEDA and
# none of it has to be kept to be looked at. So it is fetched on click,
# through here rather than from the browser, and kept on disk: a part
# number means the same thing tomorrow, and this is a preview, not a part
# of anything, so it has no business in the database.

COMPONENT = "https://easyeda.com/api/products/{}/components?version=6.4.19.5"
SVGS = "https://easyeda.com/api/products/{}/svgs"
OBJ = "https://modules.easyeda.com/3dmodel/{}"

LOOK = Path(os.environ.get(
    "X3_LCSC_CACHE",
    Path(__file__).resolve().parent.parent / ".cache" / "lcsc"))

# EasyEDA's own numbering for the two drawings it keeps per part.
SYMBOL, FOOTPRINT = 2, 4


def _get_bytes(url: str) -> bytes:
    import urllib.request

    if url.startswith("//"):
        url = "https:" + url
    req = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


async def _kept(lcsc: str, name: str, url: str) -> bytes:
    """One file about a part: from disk if it has been looked at before."""
    if not looks_like_a_part(lcsc):
        raise ValueError(f"{lcsc!r} is not an LCSC part number")
    path = LOOK / lcsc.strip() / name
    try:
        if path.exists():
            return path.read_bytes()
    except OSError:
        pass
    blob = await asyncio.get_running_loop().run_in_executor(None, _get_bytes, url)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(blob)
        tmp.replace(path)
    except OSError:
        pass
    return blob


async def _component(lcsc: str) -> dict:
    raw = await _kept(lcsc, "component.json", COMPONENT.format(lcsc))
    body = json.loads(raw.decode(errors="replace"))
    if not body.get("success") or not body.get("result"):
        raise LookupError(f"{lcsc}: EasyEDA does not know this part")
    return body["result"]


def _model_of(component: dict) -> tuple[str | None, str | None]:
    """The 3D model's id and name, from inside the footprint.

    EasyEDA keeps it as one node among the footprint's shapes - a JSON
    blob after `SVGNODE~`, tagged `outline3D`.
    """
    shapes = ((component.get("packageDetail") or {}).get("dataStr") or {}) \
        .get("shape") or []
    for shape in shapes:
        if not shape.startswith("SVGNODE~"):
            continue
        try:
            attrs = json.loads(shape[len("SVGNODE~"):]).get("attrs") or {}
        except ValueError:
            continue
        if attrs.get("c_etype") == "outline3D" and attrs.get("uuid"):
            return attrs["uuid"], attrs.get("title")
    return None, None


async def preview(lcsc: str) -> dict:
    """What a part is, for somebody choosing one.

    The drawings, the model and the photo are separate requests so the
    page can show the facts at once and let the 3.8 MB model arrive when
    it arrives.
    """
    c = await _component(lcsc)
    para = ((c.get("dataStr") or {}).get("head") or {}).get("c_para") or {}
    shop = c.get("lcsc") or {}
    photo = (c.get("szlcsc") or {}).get("image")
    model_id, model_name = _model_of(c)
    return {
        "lcsc": lcsc,
        "name": c.get("title") or para.get("name"),
        "description": c.get("description") or "",
        "maker": para.get("Manufacturer"),
        "mpn": para.get("Manufacturer Part"),
        "package": para.get("package")
                   or (c.get("packageDetail") or {}).get("title"),
        # JLCPCB assembles "Basic" parts without a loading fee; an
        # "Extended" one costs a feeder per board run. It decides between
        # two otherwise equal parts more often than price does.
        "jlc_class": para.get("JLCPCB Part Class"),
        "price": shop.get("price"),
        "stock": shop.get("stock"),
        "min": shop.get("min"),
        "url": shop.get("url"),
        "has_photo": bool(photo),
        "has_model": bool(model_id),
        "model_name": model_name,
    }


async def drawing(lcsc: str, which: int) -> bytes:
    """The symbol or the footprint, as the SVG EasyEDA draws it."""
    raw = await _kept(lcsc, "svgs.json", SVGS.format(lcsc))
    body = json.loads(raw.decode(errors="replace"))
    for row in body.get("result") or []:
        if row.get("docType") == which and row.get("svg"):
            return row["svg"].encode()
    raise LookupError(f"{lcsc}: no drawing of that kind")


async def model_obj(lcsc: str) -> bytes:
    """The 3D shape, as the OBJ EasyEDA keeps it - materials inline."""
    model_id, _ = _model_of(await _component(lcsc))
    if not model_id:
        raise LookupError(f"{lcsc}: no 3D model")
    return await _kept(lcsc, "model.obj", OBJ.format(model_id))


async def model_glb(lcsc: str) -> bytes:
    """The 3D shape as a GLB the page can open without parsing text.

    Converted once and kept beside the OBJ it came from. In the browser the
    OBJ froze the whole application for seconds; here it takes 0.15.
    """
    from . import objglb

    path = LOOK / lcsc.strip() / "model.glb"
    try:
        if path.exists():
            return path.read_bytes()
    except OSError:
        pass
    obj = await model_obj(lcsc)
    glb = await asyncio.get_running_loop().run_in_executor(
        None, objglb.convert, obj.decode(errors="replace"))
    try:
        tmp = path.with_suffix(".glb.part")
        tmp.write_bytes(glb)
        tmp.replace(path)
    except OSError:
        pass
    return glb


async def photo(lcsc: str) -> bytes:
    """The product photo, where there is one to be had.

    Older parts point at EasyEDA's image host, which answers. Newer ones
    point at LCSC's own, which turns away anything that is not a browser;
    that is their call, so those parts simply have no photo here.
    """
    import urllib.error

    url = ((await _component(lcsc)).get("szlcsc") or {}).get("image")
    if not url:
        raise LookupError(f"{lcsc}: no photo")
    try:
        return await _kept(lcsc, "photo.jpg", url)
    except urllib.error.HTTPError as exc:
        raise LookupError(f"{lcsc}: the photo host said {exc.code}") from exc


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
