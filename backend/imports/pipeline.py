"""From an upload to an imported board.

`analyse()` does everything it can with what it was given and says what
it could not, and with which file it could have:

    design file (KiCad/EasyEDA/Altium/Eagle/...) -> everything, via KiCad
    Gerbers + drills                              -> drawings, outline, size,
                                                     drill table, layer PDF
    EasyEDA FlyingProbeTesting.json               -> netlist + placement
    BOM CSV                                       -> footprint, value, part no.
    pick-and-place CSV                            -> placement (+ footprint)
    assembled STEP                                -> 3D with parts named by ref
                                                     (+ footprints, when no BOM)

`store_board()` writes the result as SPEC §5 says an imported board is:
a `boards` document with `kind: "imported"` and the artifacts a built
board has, so the PCB room shows it unchanged.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

from . import detect, parts

ROOT = Path(__file__).resolve().parent.parent.parent

WHAT = {
    "drawing": "front and back drawings",
    "outline": "board outline and size",
    "drills": "drill table",
    "pdf": "layer PDF",
    "netlist": "netlist (parts and nets)",
    "placement": "placement (x, y, rotation, side)",
    "footprints": "footprint of each part",
    "values": "value of each part",
    "part_numbers": "part numbers",
    "model3d": "3D model with the parts on",
    "schematic": "schematic drawing",
}

NEEDS = {
    "drawing": "the Gerbers (copper, mask, silkscreen, outline) or the design file",
    "outline": "the outline Gerber (.GKO / Edge_Cuts / Profile) or the design file",
    "drills": "the Excellon drill files (.DRL / .drl)",
    "pdf": "the Gerbers (and google-chrome on the server) or the design file",
    "netlist": "EasyEDA Pro's FlyingProbeTesting.json, or the design file "
               "(.kicad_pcb, .epro, EasyEDA .json, .PcbDoc, .brd)",
    "placement": "a pick-and-place CSV, FlyingProbeTesting.json, or the design file",
    "footprints": "a BOM CSV with a Footprint column, or the assembled STEP",
    "values": "a BOM CSV with a Value / Comment column",
    "part_numbers": "a BOM CSV with an LCSC Part / Supplier Part / MPN column",
    "model3d": "the assembled board's STEP (EasyEDA: Export > 3D Model)",
    "schematic": "the schematic itself (not in any fab or 3D export); Redline draws one "
                 "only from an atopile build, where every part has an LCSC number",
}


class Result:
    """What came out: artifacts by name, the document's fields, and the
    account of what was found and what was not."""

    def __init__(self):
        self.artifacts: dict[str, bytes] = {}
        self.fields: dict = {}
        self.found: dict[str, dict] = {}
        self.missing: dict[str, str] = {}
        self.files: list[dict] = []
        self.notes: list[str] = []

    def got(self, key: str, sources: list[str] | str, note: str | None = None) -> None:
        srcs = [sources] if isinstance(sources, str) else list(sources)
        entry = self.found.setdefault(key, {"what": WHAT[key], "from": []})
        for s in srcs:
            if s not in entry["from"]:
                entry["from"].append(s)
        if note:
            entry["note"] = note
        self.missing.pop(key, None)

    def lacks(self, key: str, why: str | None = None) -> None:
        if key not in self.found:
            self.missing[key] = why or NEEDS[key]

    def summary(self) -> dict:
        return {
            "files": self.files,
            "found": [{"key": k, **v} for k, v in self.found.items()],
            "missing": [{"key": k, "what": WHAT[k], "needs": v} for k, v in self.missing.items()],
            "notes": self.notes,
        }


async def _nothing(_: str) -> None:
    return None


# ---- the steps ----------------------------------------------------------

def _gerber_step(items: list[detect.Item], title: str) -> dict:
    """Parse and draw the Gerbers. CPU work: run in a thread."""
    from . import gerbers
    board = gerbers.Board(items)
    try:
        box = board.box()
        out = {
            "box": box,
            "size_mm": [round(box[2] - box[0], 3), round(box[3] - box[1], 3)],
            "has_outline": board.outline_box() is not None,
            "svg": {k: board.svg(k) for k in ("front", "bottom", "tracks")},
            "drills": board.drill_table(),
            "stats": board.copper_stats(),
            "problems": board.problems,
            "layers": {k: board.files.get(k) for k in board.layers},
            "pages": gerbers.layer_pages(board, title),
        }
        return out
    finally:
        board.close()


async def _print_pdf(html: str) -> bytes | None:
    """The printed layer set, by headless Chrome. None when there is no
    Chrome."""
    chrome = shutil.which("google-chrome") or shutil.which("chromium") \
        or shutil.which("chromium-browser")
    if not chrome:
        return None
    work = Path(tempfile.mkdtemp(prefix="x3pdf-"))
    try:
        (work / "layers.html").write_text(html)
        proc = await asyncio.create_subprocess_exec(
            chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-pdf-header-footer",
            f"--user-data-dir={work / 'profile'}", f"--print-to-pdf={work / 'layers.pdf'}",
            (work / "layers.html").as_uri(),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            await asyncio.wait_for(proc.wait(), 120)
        except asyncio.TimeoutError:
            proc.kill()
            return None
        pdf = work / "layers.pdf"
        return pdf.read_bytes() if pdf.exists() and pdf.stat().st_size else None
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def _step_to_glb(data: bytes) -> dict:
    """The STEP converted in a process of its own - reading 35 MB of STEP
    holds an interpreter for seconds, and not the server's."""
    work = Path(tempfile.mkdtemp(prefix="x3step-"))
    try:
        (work / "in.step").write_bytes(data)
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "backend.imports.step3d", str(work / "in.step"),
            str(work / "out.glb"), cwd=str(ROOT),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), 600)
        except asyncio.TimeoutError:
            proc.kill()
            return {"error": "the STEP took more than ten minutes to convert"}
        text = out.decode(errors="replace")
        try:
            got = json.loads(text.strip().splitlines()[-1])
        except (ValueError, IndexError):
            return {"error": "the STEP converter said nothing useful: " + text[-300:]}
        if proc.returncode == 0 and (work / "out.glb").exists():
            got["glb"] = (work / "out.glb").read_bytes()
        return got
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _relative(placement: list[dict], box) -> list[dict]:
    """Coordinates from the board's lower-left corner. EasyEDA's probe and
    pick-and-place files share the Gerbers' origin; if most points do not
    land on the board that way, they are left as the file gave them."""
    if not placement or not box:
        return placement
    x0, y0, x1, y1 = box
    inside = sum(1 for p in placement if x0 - 1 <= p["x"] <= x1 + 1 and y0 - 1 <= p["y"] <= y1 + 1)
    if inside < len(placement) / 2:
        return placement
    return [{**p, "x": round(p["x"] - x0, 4), "y": round(p["y"] - y0, 4)} for p in placement]


# ---- the whole of it ----------------------------------------------------

async def analyse(uploads: list[tuple[str, bytes]], title: str, progress=None) -> Result:
    say = progress or _nothing
    res = Result()
    t0 = time.monotonic()

    await say("unpacking")
    items = await asyncio.to_thread(detect.sort_upload, uploads)
    res.files = [i.describe() for i in items]
    by_kind: dict[str, list[detect.Item]] = {}
    for it in items:
        by_kind.setdefault(it.kind, []).append(it)

    graph = None
    placement: list[dict] = []
    box = None
    size = None
    route = None
    drills: list[dict] = []
    source = None

    # 1. A design file: KiCad reads it and everything comes from there.
    for it in by_kind.get(detect.DESIGN, []):
        from . import design
        try:
            got = await design.open_design(it.name, it.data, it.plugin, say)
        except Exception as exc:                                  # noqa: BLE001
            res.notes.append(f"{it.name}: {str(exc).splitlines()[0][:240]}")
            continue
        source = f"{it.name} (KiCad {got.get('plugin')})"
        graph = got["graph"]
        placement = got["placement"]
        size = got["size_mm"]
        drills = got["drills"]
        route = got["route"]
        for key, label in (("layout", "layout"), ("bottom", "bottom"), ("tracks", "tracks")):
            if got["svg"].get(key):
                res.artifacts[label] = got["svg"][key]
        res.artifacts["pcb"] = got["kicad_pcb"]
        if res.artifacts.get("layout"):
            res.got("drawing", it.name)
        res.got("outline", it.name)
        if drills:
            res.got("drills", it.name)
        if got.get("pdf"):
            res.artifacts["layers_pdf"] = got["pdf"]
            res.got("pdf", it.name)
        if got.get("glb"):
            res.artifacts["model3d"] = got["glb"]
            res.got("model3d", it.name, "KiCad's 3D export, parts from its library")
        res.got("netlist", it.name)
        res.got("placement", it.name)
        if any(c.get("footprint") for c in graph["components"]):
            res.got("footprints", it.name)
        if any(c.get("value") and c["value"] not in ("?", "~") for c in graph["components"]):
            res.got("values", it.name)
        if any(c.get("part") for c in graph["components"]):
            res.got("part_numbers", it.name,
                    f"{sum(1 for c in graph['components'] if c.get('part'))} of "
                    f"{len(graph['components'])} parts carry a number")
        break

    # 2. Gerbers and drills.
    gerber_items = by_kind.get(detect.GERBER, []) + by_kind.get(detect.DRILL, [])
    if gerber_items:
        await say("reading the Gerbers")
        g = await asyncio.to_thread(_gerber_step, gerber_items, title)
        res.notes += g["problems"]
        # The files the drawings are actually made of: copper, mask,
        # silkscreen, paste and the edge - not a fab or drill drawing.
        names = [f for k, f in g["layers"].items() if f and k != "document"
                 and k != "drill drawing"]
        drill_names = [i.name for i in by_kind.get(detect.DRILL, [])]
        box = g["box"]
        if not source:
            size = g["size_mm"]
            for key, label in (("front", "layout"), ("bottom", "bottom"), ("tracks", "tracks")):
                if g["svg"].get(key):
                    res.artifacts[label] = g["svg"][key].encode()
            if res.artifacts.get("layout"):
                res.got("drawing", names)
            if g["has_outline"]:
                res.got("outline", g["layers"].get("outline") or names)
            else:
                res.notes.append("no outline layer: the board's size is the extent of its copper")
            if g["drills"]:
                drills = g["drills"]
                res.got("drills", drill_names)
            await say("printing the layer PDF")
            pdf = await _print_pdf(g["pages"])
            if pdf:
                res.artifacts["layers_pdf"] = pdf
                res.got("pdf", names + drill_names)
            else:
                res.lacks("pdf", "google-chrome is not installed on the server, so the layers "
                                 "could not be printed")
            route = {**g["stats"], "zones": None}
        else:
            res.notes.append("Gerbers were not drawn: the design file drew the board")
        missing_layers = [l for l in ("top copper", "bottom copper", "top mask", "top silk", "outline")
                          if l not in g["layers"]]
        if missing_layers and not source:
            res.notes.append("no Gerber for: " + ", ".join(missing_layers))

    # 3. EasyEDA's flying-probe file: the netlist and where each part sits.
    probe_items = by_kind.get(detect.PROBE, [])
    pads = []
    if probe_items and graph is None:
        await say("reading the flying-probe netlist")
        it = probe_items[0]
        got = parts.parse_probe(it.data)
        graph = got["graph"]
        placement = _relative(got["placement"], box)
        pads = got["pads"]
        res.got("netlist", it.name, f"{got['free_pads']} free pads / vias (PAD<n>) left out")
        res.got("placement", it.name)
        if got["unknown_refs"]:
            res.notes.append("pins of parts the file does not list: " + ", ".join(got["unknown_refs"][:10]))

    # 4. Pick-and-place.
    pnp_items = by_kind.get(detect.PNP, [])
    pnp_info: dict = {}
    for it in pnp_items:
        got = parts.parse_pnp(it.data)
        pnp_info.update(got["info"])
        if not placement and got["placement"]:
            placement = _relative(got["placement"], box)
            res.got("placement", it.name)
        if graph is None and got["placement"]:
            graph = parts.graph_from_pads_only(got["placement"])
            res.notes.append(f"{it.name}: the parts are known from the pick-and-place file, "
                             f"but not what connects to what")

    # 5. What each part is: BOM, then pick-and-place, then STEP names.
    bom_rows = []
    if graph is not None:
        comps = graph["components"]
        for it in by_kind.get(detect.BOM, []):
            by_ref = parts.parse_bom(it.data)
            bom_rows += [{"designator": r, **v} for r, v in by_ref.items()]
            n = parts.apply_identity(comps, by_ref, it.name)
            if n:
                if any(v.get("footprint") for v in by_ref.values()):
                    res.got("footprints", it.name)
                if any(v.get("value") for v in by_ref.values()):
                    res.got("values", it.name)
                if any(v.get("part") for v in by_ref.values()):
                    res.got("part_numbers", it.name,
                            f"{sum(1 for c in comps if c.get('part'))} of {len(comps)} parts")
            unmatched = [r for r in by_ref if r not in {c['ref'] for c in comps}]
            if unmatched:
                res.notes.append(f"{it.name}: {len(unmatched)} designators not on the board "
                                 f"({', '.join(unmatched[:6])})")
        if pnp_info and parts.apply_identity(comps, pnp_info, "pnp", ("footprint", "value")):
            if any(v.get("footprint") for v in pnp_info.values()):
                res.got("footprints", [i.name for i in pnp_items])

    # 6. The assembled STEP.
    step_items = by_kind.get(detect.STEP, [])
    if step_items and "model3d" not in res.artifacts:
        it = step_items[0]
        await say(f"converting {it.base} to 3D ({len(it.data) // 1_000_000} MB)")
        got = await _step_to_glb(it.data)
        if got.get("glb"):
            res.artifacts["model3d"] = got["glb"]
            res.got("model3d", it.name, f"{len(got.get('parts') or {})} parts named by designator")
            if graph is not None:
                foot = {r: {"footprint": f} for r, f in (got.get("parts") or {}).items() if f}
                if parts.apply_identity(graph["components"], foot, it.name, ("footprint",)):
                    res.got("footprints", it.name, "from the STEP's product names")
                refs = {c["ref"] for c in graph["components"]}
                extra = sorted(set(got.get("parts") or {}) - refs)
                absent = sorted(refs - set(got.get("parts") or {}))
                if extra:
                    res.notes.append("in the STEP but not in the netlist: " + ", ".join(extra[:10]))
                if absent:
                    res.notes.append(f"{len(absent)} parts have no 3D body in the STEP: "
                                     + ", ".join(absent[:12]))
        else:
            res.notes.append(f"{it.name}: {got.get('error', 'could not be converted')}")
    if "model3d" not in res.artifacts and size:
        from .step3d import flat_board
        res.artifacts["model3d"] = flat_board(size[0], size[1])
        res.notes.append("3D: a bare board the size of the outline, no parts on it")
        res.lacks("model3d")

    # 7. The graph, as SPEC §5 has it.
    if graph is not None:
        graph["counts"] = parts.counts(graph)
        graph["bom"] = bom_rows
        graph["built_at"] = _now()
        res.artifacts["graph"] = json.dumps(graph).encode()
        if placement:
            res.artifacts["placement"] = json.dumps({
                "frame": "mm from the board's lower-left corner, x right, y up, seen from the top",
                "parts": placement}).encode()
        if pads:
            res.artifacts["pads"] = json.dumps(pads).encode()

    # The files as they came (all but the STEP, which is the big one and
    # lives on as model3d): a fab zip is the thing to send a board house.
    kept = [i for i in items if i.kind not in (detect.STEP,)]
    if kept:
        import io
        import zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for i in kept:
                z.writestr(i.name, i.data)
        res.artifacts["sources"] = buf.getvalue()

    for key in WHAT:
        res.lacks(key)

    res.fields = {
        "size_mm": size, "route": route, "drills": drills, "source": source or (
            "Gerbers" if gerber_items else None),
        "placed": len(placement) if placement else (len(graph["components"]) if graph else None),
        "seconds": round(time.monotonic() - t0, 1),
    }
    return res


def _now() -> str:
    from ..store import now
    return now()


# ---- storing it ---------------------------------------------------------

SAFE = re.compile(r"[^A-Za-z0-9_-]+")


def slug(text: str) -> str:
    s = SAFE.sub("-", (text or "").strip()).strip("-_").lower()
    return (s or "board")[:48]


async def ensure_folder(db, path: str) -> str:
    """The folder, made if it is not there (each level)."""
    from .. import store
    path = "/".join(p for p in (path or "").split("/") if p)
    if not path:
        return ""
    parent = ""
    for name in path.split("/"):
        here = f"{parent}/{name}" if parent else name
        if not await db.folders.find_one({"_id": here}):
            await store.create_folder(db, parent, name)
        parent = here
    return path


async def free_id(db, base: str) -> str:
    from ..ato import BOARDS
    bid, n = base, 1
    while await db[BOARDS].find_one({"_id": bid}, {"_id": 1}):
        n += 1
        bid = f"{base}-{n}"
    return bid


async def store_board(db, res: Result, title: str, folder: str) -> str:
    """Write the imported board: the document, then its artifacts."""
    from .. import store
    from ..ato import BOARDS

    bid = await free_id(db, slug(title))
    now = store.now()
    size = res.fields.get("size_mm")
    doc = {
        "_id": bid, "title": title, "folder": folder, "kind": "imported",
        "saved_at": now, "stale": False,
        "layout": {"placed": res.fields.get("placed"), "missing": [],
                   "size_mm": [round(size[0], 2), round(size[1], 2)] if size else None,
                   "at": now} if "layout" in res.artifacts else None,
        # What the copper holds, as far as the files say. There was no
        # routing run here: the board came routed.
        "route": ({"tracks": res.fields["route"].get("tracks"),
                   "vias": res.fields["route"].get("vias"),
                   "length_mm": res.fields["route"].get("length_mm") or 0,
                   "zones": res.fields["route"].get("zones"),
                   "unrouted": None, "route_s": None, "passes": None, "attempts": None}
                  if res.fields.get("route") and "layout" in res.artifacts else None),
        "drc": None,
        "imported": {**res.summary(), "at": now, "source": res.fields.get("source"),
                     "drills": res.fields.get("drills") or [],
                     "seconds": res.fields.get("seconds")},
    }
    await db[BOARDS].insert_one(doc)
    for label, data in res.artifacts.items():
        await store.put_artifact(db, bid, label, data, collection=BOARDS)
    return bid
