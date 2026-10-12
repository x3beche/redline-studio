"""Releases: a project, packed as it stands, under a tag, to make.

One press takes everything a project is at this moment and puts it in one
zip, kept under a tag ("v1.2") that is never overwritten, to download
exactly as it was later:

- each board: Gerbers and drill files (zipped, as a fab takes them), the
  BOM and the pick-and-place file in JLCPCB's columns, a BOM with LCSC
  prices, stock and part class, the schematic and assembly as PDF, the
  board as STEP, and its DRC and ERC as they were;
- each model: STEP and STL, and a dimensioned technical drawing (PDF);
- the sources of every model and board, as they were;
- README.md and manifest.json: what is in it, and what could not be made.

The KiCad outputs are made in the KiCad container and the drawings in
their own (docker/draw) - nothing for this runs on the machine itself.
A release is made in the background; the page follows its log.
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import re
import secrets
import shutil
import tempfile
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from . import ato, drawlayout, kicad, lcsc, limits, store

COLL = "releases"
BUCKET = "releases"
TAG = re.compile(r"^[\w][\w.\-]{0,31}$")
ROOT = Path(__file__).resolve().parent.parent
DRAW_IMAGE = os.environ.get("REDLINE_DRAW_IMAGE", "redline-draw")
DRAW_TIMEOUT = 300
DRAWINGS = ROOT / ".cache" / "drawings"
# Bumped when tools/techdraw.py draws differently, so kept drawings are made again.
# 4: each kept drawing has a small PNG of its sheet beside it (the 3D room's
# preview) and a JSON of what the sheet holds.
DRAW_VERSION = 4
# The zips on disk as well as in the database: the database is far away,
# and thirty megabytes from it is minutes; from disk it is at once.
ZIPS = ROOT / ".cache" / "releases"
# Drawings made side by side: a large assembly takes minutes on one core.
DRAW_AT_ONCE = int(os.environ.get("REDLINE_DRAW_AT_ONCE", "3"))

_RUNNING: dict[str, asyncio.Task] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------- drawings

_PROGRESS_LINE = re.compile(r"^@progress (\d+) (.*)$")


async def drawing(step: bytes, out: Path, *, title: str, project: str, tag: str, ident: str, sha: str,
                  preview: bool = False, on_progress=None, spec: dict | None = None) -> str | None:
    """A technical drawing of a STEP, in the drawing container. None if it
    was made; otherwise why not. With `preview`, a small PNG of the sheet
    and a JSON of what it holds beside `out` too (a release has no use for
    them). `on_progress(pct, stage)` hears how far tools/techdraw.py is.
    `spec`: the model's layout (backend/drawlayout.py for_drawing), else
    the sheet is laid out by itself."""
    work = Path(tempfile.mkdtemp(prefix="redline-draw-"))
    try:
        os.chmod(work, 0o777)
        (work / "model.step").write_bytes(step)
        if spec:
            (work / "spec.json").write_text(json.dumps(spec))
        argv = ["docker", "run", "--rm", *limits.box(), "--network", "none",
                "--user", f"{os.getuid()}:{os.getgid()}",
                "-v", f"{work}:/work", "-v", f"{ROOT / 'tools'}:/tools:ro", DRAW_IMAGE,
                "/work/model.step", "/work/drawing.pdf", "--title", title, "--project", project,
                "--tag", tag, "--id", ident, "--sha", sha, *(["--png", "/work/drawing.png", "--info", "/work/drawing.json"] if preview else []),
                *(["--spec", "/work/spec.json"] if spec else [])]
        proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT, limit=1 << 20)
        text: list[str] = []

        async def follow() -> None:
            async for raw in proc.stdout:
                line = raw.decode(errors="replace").rstrip()
                step_ = _PROGRESS_LINE.match(line)
                if not step_:
                    if line:
                        text.append(line)
                elif on_progress:
                    on_progress(int(step_[1]), step_[2])
            await proc.wait()
        try:
            await asyncio.wait_for(follow(), DRAW_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            return f"the drawing took longer than {DRAW_TIMEOUT} s"
        pdf = work / "drawing.pdf"
        if proc.returncode != 0 or not pdf.exists():
            if any("Unable to find image" in t or "pull access denied" in t for t in text):
                return "the drawing image is not built: docker build -t redline-draw -f docker/draw/Dockerfile docker/draw"
            if text:
                return text[-1][:300]
            # Nothing said: killed from outside - 137 is what running out of memory looks like.
            rc = proc.returncode
            return (f"the drawing was stopped (exit {rc}: out of memory - try again when the machine is less busy)"
                    if rc == 137 else f"the drawing crashed (exit {rc})" if rc == 139
                    else f"the drawing stopped with exit {rc} and said nothing")
        # The preview first: the PDF on disk is what says the drawing is made.
        for suffix in (".png", ".json") if preview else ():
            if (work / f"drawing{suffix}").exists():
                out.with_suffix(suffix).write_bytes((work / f"drawing{suffix}").read_bytes())
        out.write_bytes(pdf.read_bytes())
        return None
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _key(meta: dict, layout: str = "") -> str:
    """A kept drawing's name: its STEP's fingerprint, and its layout's when
    it has one of its own (drawlayout.digest) - a changed layout is a new
    drawing, the automatic one's is still there."""
    return f"{meta['sha256'][:24]}-v{DRAW_VERSION}" + (f"-l{layout}" if layout else "")


def _kept(meta: dict, suffix: str = ".pdf", layout: str = "") -> Path:
    """Where a model's drawing is kept."""
    return DRAWINGS / f"{_key(meta, layout)}{suffix}"


# What each model's drawing is doing, for the 3D room's Model tab: being
# made (how far, which step), waiting its turn, or the last failure - per
# model, and only for the STEP it was about. In memory, like draw_later's
# waits: a restart forgets it, and the files on disk still say what is made.
_STATE: dict[str, dict] = {}
# When draw_later makes each model's drawing.
_DUE: dict[str, str] = {}
# One making of a kept drawing at a time: a click while the background
# makes the same one waits for it rather than making it twice.
_MAKING: dict[str, asyncio.Lock] = {}
# Drawings asked for with POST, running in the background.
_STARTED: set[asyncio.Task] = set()


async def model_drawing(db, model_id: str, tag: str = "", *, again: bool = False) -> bytes:
    """A model's technical drawing on its own, for the 3D room: made once
    per STEP (kept by the STEP's fingerprint), with its PNG preview.
    `again` makes it anew even if it is kept. With the model's layout, if
    it has one (backend/drawlayout.py) - kept apart by it."""
    asked = time.time()
    doc = await db.models.find_one({"_id": model_id}, {"artifacts": 1, "title": 1, "sha256": 1, "drawing_layout": 1})
    if not doc:
        raise KeyError(model_id)
    meta = (doc.get("artifacts") or {}).get("step")
    if not meta:
        raise LookupError("this model has no STEP to draw from - its script does not export one")
    DRAWINGS.mkdir(parents=True, exist_ok=True)
    spec = drawlayout.for_drawing(doc.get("drawing_layout"))
    kept = _kept(meta, layout=drawlayout.digest((doc.get("drawing_layout") or {}).get("spec")))
    if kept.exists() and not again:
        return kept.read_bytes()
    async with _MAKING.setdefault(kept.name, asyncio.Lock()):
        # Made while this waited (by the background, or another click).
        if kept.exists() and (not again or kept.stat().st_mtime >= asked):
            return kept.read_bytes()
        sha = meta["sha256"]
        live = {"sha": sha, "state": "making", "pct": 0, "stage": "starting", "started_at": _now()}
        _STATE[model_id] = live
        _DUE.pop(model_id, None)

        def heard(pct: int, stage: str) -> None:
            live.update(pct=pct, stage=stage)
        try:
            step = await store.get_artifact(db, model_id, "step")
            # A crash in the projection (exit 139) now and then does not
            # happen again on the next go: once more before giving up.
            for _ in range(2):
                why = await drawing(step, kept, title=doc.get("title") or model_id.split("/")[-1],
                                    project=model_id.split("/")[0], tag=tag, ident=model_id,
                                    sha=doc.get("sha256") or "", preview=True, on_progress=heard, spec=spec)
                if not (why and "exit 139" in why):
                    break
        except Exception as exc:                    # noqa: BLE001 - said on the tab, then raised
            why = str(exc) or type(exc).__name__
        if why:
            _STATE[model_id] = {"sha": sha, "state": "failed", "error": why, "failed_at": _now()}
            raise RuntimeError(why)
        if _STATE.get(model_id) is live:
            _STATE.pop(model_id, None)
        return kept.read_bytes()


async def model_drawing_preview(db, model_id: str) -> bytes | None:
    """The PNG preview of a model's drawing if it is already made, else
    None - never made here: the preview only shows what is there."""
    doc = await db.models.find_one({"_id": model_id}, {"artifacts.step": 1, "drawing_layout.spec": 1})
    if not doc:
        raise KeyError(model_id)
    meta = (doc.get("artifacts") or {}).get("step")
    if not meta:
        return None
    lay = _layout_key(doc)
    png = _kept(meta, ".png", lay)
    return png.read_bytes() if png.exists() and _kept(meta, layout=lay).exists() else None


def _layout_key(doc: dict) -> str:
    return drawlayout.digest((doc.get("drawing_layout") or {}).get("spec"))


def _sheet(info: Path) -> dict:
    """What a kept sheet holds - its size, scale and views (techdraw.py
    --info)."""
    try:
        got = json.loads(info.read_text())
    except (OSError, ValueError):
        return {}
    return {k: got.get(k) for k in ("sheet", "scale", "views", "layout", "boxes", "parts", "unmatched", "extents",
                                    "size_mm")
            if k in got}


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat()


async def drawing_status(db, model_id: str) -> dict:
    """Where a model's drawing is, for the 3D room's Model tab - never
    making one. state: no_step, none, scheduled (draw_later's time in
    scheduled_at), queued, making (pct, stage), ready, failed; with what
    is made (when, its size, the sheet) and the last failure, if any, for
    the model's current STEP only."""
    doc = await db.models.find_one({"_id": model_id}, {"artifacts.step": 1, "built": 1, "drawing_layout": 1})
    if not doc:
        raise KeyError(model_id)
    built = doc.get("built") or {}
    out: dict = {"id": model_id, "auto_after_s": DRAW_AFTER_BUILD_S, "scheduled_at": _DUE.get(model_id),
                 "built": {"version": built.get("version"), "at": built.get("at")}}
    meta = (doc.get("artifacts") or {}).get("step")
    if not meta:
        out["state"] = "no_step"
        return out
    sha = meta["sha256"]
    out["step"] = {"sha": sha[:12], "bytes": meta.get("bytes")}
    lay = _layout_key(doc)
    layout = doc.get("drawing_layout") or {}
    out["layout"] = {"custom": bool(lay), "version": layout.get("version", 0), "key": lay}
    kept, png = _kept(meta, layout=lay), _kept(meta, ".png", lay)
    # Its preview's address changes with the drawing, so it is kept for good.
    out["key"] = _key(meta, lay)
    if kept.exists():
        st = kept.stat()
        out["made"] = {"at": _iso(st.st_mtime), "pdf_bytes": st.st_size, "preview": png.exists(),
                       **_sheet(_kept(meta, ".json", lay))}
    live = _STATE.get(model_id)
    if live and live.get("sha") in (None, sha):
        if live["state"] == "failed":
            out["failed"] = {"reason": live.get("error"), "at": live.get("failed_at")}
        else:
            out.update(state=live["state"], pct=live.get("pct"), stage=live.get("stage"),
                       started_at=live.get("started_at"))
    if "state" not in out:
        out["state"] = ("ready" if "made" in out else "failed" if "failed" in out
                        else "scheduled" if out["scheduled_at"] else "none")
    return out


async def start_drawing(db, model_id: str, again: bool = False) -> dict:
    """Make a model's drawing in the background (anew with `again`); its
    progress is drawing_status's. Nothing new is started while one is
    being made."""
    now = await drawing_status(db, model_id)
    if now["state"] == "no_step":
        raise LookupError("this model has no STEP to draw from - its script does not export one")
    # Waiting its turn behind the background's drawings is not made to wait.
    if now["state"] == "making" or (now["state"] == "ready" and not again):
        return now

    async def go() -> None:
        try:
            await model_drawing(db, model_id, again=again)
        except Exception as exc:                    # noqa: BLE001 - kept in _STATE for the tab
            print(f"drawing {model_id}: {exc}", flush=True)
    task = asyncio.get_running_loop().create_task(go())
    _STARTED.add(task)
    task.add_done_callback(_STARTED.discard)
    await asyncio.sleep(0)                          # under way before the answer
    return await drawing_status(db, model_id)


# A model's drawing made by itself a while after it is built, so the 3D
# room's Technical drawing opens at once. Not right away: a model is often
# built several times in a row, and its imports' builds bring it round
# again - each build starts the wait over, and only the last one is drawn.
# One at a time, in the background; lost on a restart, when the drawing is
# simply made on the next click as before.
DRAW_AFTER_BUILD_S = int(os.environ.get("REDLINE_DRAW_AFTER_S", "600"))
_DRAW_LATER: dict[str, asyncio.Task] = {}
_DRAW_ONE = asyncio.Semaphore(1)


def draw_later(db, model_id: str) -> None:
    """Make `model_id`'s drawing DRAW_AFTER_BUILD_S after its latest build."""
    old = _DRAW_LATER.pop(model_id, None)
    if old:
        old.cancel()
    _DUE[model_id] = _iso(time.time() + DRAW_AFTER_BUILD_S)

    async def go() -> None:
        try:
            await asyncio.sleep(DRAW_AFTER_BUILD_S)
            _DUE.pop(model_id, None)
            if model_id not in _STATE or _STATE[model_id].get("state") == "failed":
                _STATE[model_id] = {"sha": None, "state": "queued"}
            async with _DRAW_ONE:
                await model_drawing(db, model_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:                    # noqa: BLE001 - a click makes it again
            print(f"drawing after build {model_id}: {exc}", flush=True)
        finally:
            if _STATE.get(model_id, {}).get("state") == "queued":
                _STATE.pop(model_id, None)
            if _DRAW_LATER.get(model_id) is task:
                _DRAW_LATER.pop(model_id, None)
                _DUE.pop(model_id, None)

    task = asyncio.get_running_loop().create_task(go())
    _DRAW_LATER[model_id] = task


# ---------------------------------------------------------------- boards

def _copper_layers(pcb: str) -> list[str]:
    layers = re.findall(r'\(\d+ "([^"]+\.Cu)" signal', pcb)
    return layers or ["F.Cu", "B.Cu"]


def _cpl(pos_csv: str) -> str:
    """KiCad's position file, in the columns JLCPCB asks for."""
    rows = list(csv.DictReader(io.StringIO(pos_csv)))
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
    for r in rows:
        side = (r.get("Side") or "top").lower()
        w.writerow([r.get("Ref"), f"{float(r.get('PosX') or 0):.4f}mm", f"{float(r.get('PosY') or 0):.4f}mm",
                    "Top" if side.startswith("top") else "Bottom", f"{float(r.get('Rot') or 0):.1f}"])
    return out.getvalue()


PRICES = ROOT / ".cache" / "lcsc-prices"
PRICE_DAYS = 1


async def _price(part: str) -> dict:
    """A part's single-piece price and stock at LCSC, from its shop search -
    the EasyEDA record has neither. Kept for a day, so releasing again does
    not ask again: LCSC's patience is shared (backend/lcsc.py)."""
    PRICES.mkdir(parents=True, exist_ok=True)
    kept = PRICES / f"{part}.json"
    if kept.exists() and time.time() - kept.stat().st_mtime < PRICE_DAYS * 86400:
        return json.loads(kept.read_text())
    hit = next((r for r in await lcsc.search(part, limit=3) if r.get("lcsc") == part), None) or {}
    got = {"price": hit.get("price"), "stock": hit.get("stock"), "mpn": hit.get("mpn"), "maker": hit.get("maker")}
    kept.write_text(json.dumps(got))
    return got


async def _bom(graph: dict, log) -> tuple[str, str, dict]:
    """The BOM twice - in JLCPCB's columns, and with LCSC's prices - and
    its totals. Prices come from LCSC through the polite, cached path; a
    part it cannot price now is left blank and said so."""
    groups: dict[str, dict] = {}
    for c in graph.get("components") or []:
        part = c.get("part") or ""
        g = groups.setdefault(part or f"(none:{c.get('footprint')})",
                              {"part": part, "refs": [], "footprint": (c.get("footprint") or "").split(":")[-1],
                               "value": c.get("value") if c.get("value") not in (None, "?") else ""})
        g["refs"].append(c.get("ref"))
    jlc, priced = io.StringIO(), io.StringIO()
    wj, wp = csv.writer(jlc), csv.writer(priced)
    wj.writerow(["Comment", "Designator", "Footprint", "LCSC Part #"])
    wp.writerow(["LCSC Part #", "Qty", "Designators", "Footprint", "MPN", "Manufacturer", "Description",
                 "Class", "Unit price (USD)", "Line total (USD)", "Stock"])
    total, unpriced, extended = 0.0, [], 0
    for key in sorted(groups, key=lambda k: -len(groups[k]["refs"])):
        g = groups[key]
        refs = sorted(g["refs"], key=lambda r: (re.sub(r"\d", "", r), int(re.sub(r"\D", "", r) or 0)))
        info: dict = {}
        if g["part"]:
            try:
                info = await lcsc.preview(g["part"])          # what it is (kept on disk)
            except Exception:
                info = {}
            try:
                shop = await _price(g["part"])                # what it costs, and how many there are
                info = {**info, **{k: v for k, v in shop.items() if v is not None}}
            except Exception as exc:              # rate limit, offline: the BOM still goes out
                log(f"  price for {g['part']} not read now ({type(exc).__name__})")
        try:
            unit = float(info["price"]) if info.get("price") not in (None, "") else None
        except (TypeError, ValueError):
            unit = None
        qty = len(refs)
        line = unit * qty if unit is not None else None
        if line is not None:
            total += line
        elif g["part"]:
            unpriced.append(g["part"])
        if (info.get("jlc_class") or "").lower().startswith("extended"):
            extended += 1
        comment = g["value"] or info.get("mpn") or g["part"]
        wj.writerow([comment, ",".join(refs), g["footprint"], g["part"]])
        wp.writerow([g["part"], qty, " ".join(refs), g["footprint"], info.get("mpn") or "",
                     info.get("maker") or "", (info.get("description") or info.get("name") or "")[:120],
                     info.get("jlc_class") or "", f"{unit:.4f}" if unit is not None else "",
                     f"{line:.4f}" if line is not None else "", info.get("stock") if info.get("stock") is not None else ""])
    return jlc.getvalue(), priced.getvalue(), {
        "lines": len(groups), "parts": sum(len(g["refs"]) for g in groups.values()),
        "total_usd": round(total, 4), "unpriced": unpriced, "extended": extended}


async def _board(db, bid: str, out: Path, log) -> dict:
    doc = await db[ato.BOARDS].find_one({"_id": bid}, {"source": 1, "title": 1, "drc": 1, "schematic": 1,
                                                        "route": 1, "stale": 1, "artifacts": 1})
    info: dict = {"id": bid, "title": doc.get("title") or bid, "files": [], "problems": []}
    arts = doc.get("artifacts") or {}
    pcb_label = "routed" if "routed" in arts else "pcb" if "pcb" in arts else None
    if not pcb_label:
        info["problems"].append("no board file yet - build it first")
        return info
    if doc.get("stale"):
        info["problems"].append("the source changed since the last build: this is the last built board")
    if pcb_label == "pcb":
        info["problems"].append("not routed: the placed board, without tracks")
    work = Path(tempfile.mkdtemp(prefix="redline-rel-"))
    try:
        os.chmod(work, 0o777)
        pcb = await store.get_artifact(db, bid, pcb_label, ato.BOARDS)
        (work / "board.kicad_pcb").write_bytes(pcb)
        has_sch = "schematic" in arts
        if has_sch:
            (work / "board.kicad_sch").write_bytes(await store.get_artifact(db, bid, "schematic", ato.BOARDS))
            # A schematic drawn in sheets: the root needs its sub-sheets beside it.
            if "schematic_files" in arts:
                for name, text in json.loads(await store.get_artifact(
                        db, bid, "schematic_files", ato.BOARDS)).items():
                    if name != "board.kicad_sch" and re.match(r"^[\w.-]+\.kicad_sch$", name):
                        (work / name).write_text(text)
        (work / "gerbers").mkdir()
        os.chmod(work / "gerbers", 0o777)
        layers = ",".join([*_copper_layers(pcb.decode(errors="replace")), "F.Paste", "B.Paste", "F.Silkscreen",
                           "B.Silkscreen", "F.Mask", "B.Mask", "Edge.Cuts"])
        steps = [
            ("Gerbers", ["pcb", "export", "gerbers", "--output", "/work/gerbers/", "--layers", layers,
                         "--subtract-soldermask", "board.kicad_pcb"]),
            ("drill files", ["pcb", "export", "drill", "--output", "/work/gerbers/", "--format", "excellon",
                             "--excellon-separate-th", "--generate-map", "--map-format", "gerberx2",
                             "board.kicad_pcb"]),
            ("pick and place", ["pcb", "export", "pos", "--output", "/work/pos.csv", "--format", "csv",
                                "--units", "mm", "--side", "both", "board.kicad_pcb"]),
            ("assembly drawing", ["pcb", "export", "pdf", "--output", "/work/assembly.pdf", "--layers",
                                  "F.Fab,F.Silkscreen,Edge.Cuts", "--mode-single", "--include-border-title",
                                  "board.kicad_pcb"]),
            ("board STEP", ["pcb", "export", "step", "--output", "/work/board.step", "--force", "--subst-models",
                            "board.kicad_pcb"]),
        ]
        if has_sch:
            steps.append(("schematic PDF", ["sch", "export", "pdf", "--output", "/work/schematic.pdf",
                                            "board.kicad_sch"]))
        for what, args in steps:
            rc, text = await kicad._run(kicad._docker(work, kicad.IMAGE, *args), work)
            if rc != 0:
                info["problems"].append(f"{what} could not be made: {text.strip().splitlines()[-1:] or ['?']}")
                log(f"  {bid}: {what} failed")
            else:
                log(f"  {bid}: {what}")
        dest = out / "boards" / bid
        dest.mkdir(parents=True)
        fab = list((work / "gerbers").glob("*"))
        if fab:
            with zipfile.ZipFile(dest / f"{bid}-gerbers.zip", "w", zipfile.ZIP_DEFLATED) as z:
                for f in sorted(fab):
                    z.write(f, f.name)
        if (work / "pos.csv").exists():
            (dest / f"{bid}-cpl.csv").write_text(_cpl((work / "pos.csv").read_text()))
        for src, name in (("assembly.pdf", "assembly.pdf"), ("schematic.pdf", "schematic.pdf"),
                          ("board.step", "board.step")):
            if (work / src).exists():
                shutil.copy(work / src, dest / f"{bid}-{name}")
        (dest / f"{bid}.kicad_pcb").write_bytes(pcb)
        if has_sch:
            shutil.copy(work / "board.kicad_sch", dest / f"{bid}.kicad_sch")
        try:
            graph = json.loads(await store.get_artifact(db, bid, "graph", ato.BOARDS))
            jlc, priced, totals = await _bom(graph, log)
            (dest / f"{bid}-bom-jlcpcb.csv").write_text(jlc)
            (dest / f"{bid}-bom-priced.csv").write_text(priced)
            info["bom"] = totals
            log(f"  {bid}: BOM, {totals['parts']} parts, ${totals['total_usd']:.2f} a board")
        except KeyError:
            info["problems"].append("no parts list (graph) - build the board first")
        (dest / f"{bid}-checks.json").write_text(json.dumps(
            {"drc": doc.get("drc"), "erc": (doc.get("schematic") or {}).get("erc"), "route": doc.get("route")},
            indent=2, default=str))
        info["drc"] = doc.get("drc")
        info["files"] = sorted(str(p.relative_to(out)) for p in dest.rglob("*") if p.is_file())
        return info
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------- models

async def _model(db, mid: str, out: Path, tag: str, project: str, log) -> dict:
    doc = await db.models.find_one({"_id": mid}, {"artifacts": 1, "title": 1, "sha256": 1, "stale": 1,
                                                  "drawing_layout": 1})
    name = mid.split("/")[-1]
    info: dict = {"id": mid, "title": doc.get("title") or name, "files": [], "problems": []}
    arts = doc.get("artifacts") or {}
    dest = out / "models" / name
    dest.mkdir(parents=True, exist_ok=True)
    if doc.get("stale"):
        info["problems"].append("the source changed since the last build: these are the last built files")
    step = None
    for label in ("step", "stl", "3mf"):
        if label in arts:
            data = await store.get_artifact(db, mid, label)
            (dest / f"{name}.{label}").write_bytes(data)
            if label == "step":
                step = data
    if not step:
        info["problems"].append("no STEP: the model's script does not export one (export_step in the script adds it)")
    else:
        why = await drawing(step, dest / f"{name}-drawing.pdf", title=info["title"], project=project, tag=tag,
                            ident=mid, sha=doc.get("sha256") or "",
                            spec=drawlayout.for_drawing(doc.get("drawing_layout")))
        if why:
            info["problems"].append(f"technical drawing: {why}")
        log(f"  {mid}: {'STEP, drawing' if not why else 'STEP (no drawing)'}")
    info["files"] = sorted(str(p.relative_to(out)) for p in dest.rglob("*") if p.is_file())
    return info


# ---------------------------------------------------------------- the release

def _readme(rel: dict, manifest: dict) -> str:
    lines = [f"# {rel['project']} {rel['tag']}", "",
             f"Released {rel['created_at'][:16].replace('T', ' ')} UTC by {rel['by'].get('name', '?')}.", ""]
    if rel.get("notes"):
        lines += [rel["notes"], ""]
    for b in manifest["boards"]:
        lines += [f"## Board: {b['title']}", ""]
        if b.get("bom"):
            t = b["bom"]
            lines.append(f"- {t['parts']} parts on {t['lines']} lines; ${t['total_usd']:.2f} of parts a board "
                         f"at LCSC single-piece prices" + (f" ({len(t['unpriced'])} not priced)" if t["unpriced"] else ""))
            if t.get("extended"):
                lines.append(f"- {t['extended']} JLCPCB Extended parts: each adds a loading fee to an assembled order")
        drc = b.get("drc") or {}
        if drc:
            lines.append(f"- DRC: {drc.get('error_count', '?')} errors, {drc.get('warning_count', '?')} warnings, "
                         f"{drc.get('unconnected', '?')} unconnected")
        lines += [f"- `{f}`" for f in b["files"]] + [f"- **Not made:** {p}" for p in b["problems"]] + [""]
    for m in manifest["models"]:
        lines += [f"## Model: {m['title']}", ""] + [f"- `{f}`" for f in m["files"]] \
            + [f"- **Not made:** {p}" for p in m["problems"]] + [""]
    lines += ["## Sources", "", "Every model and board source as it was, under `sources/`.", ""]
    return "\n".join(lines)


async def _run(db, rid: str) -> None:
    rel = await db[COLL].find_one({"_id": rid})
    project, tag = rel["project"], rel["tag"]
    lines: list[str] = []
    t0 = time.monotonic()

    def log(text: str) -> None:
        lines.append(text)

    async def flush(**extra):
        await db[COLL].update_one({"_id": rid}, {"$set": {"log": lines[-200:], **extra}})

    out = Path(tempfile.mkdtemp(prefix="redline-release-"))
    try:
        prefix = re.escape(project) + "(/|$)"
        boards = [b async for b in db[ato.BOARDS].find({"folder": {"$regex": "^" + prefix}}, {"_id": 1, "source": 1})]
        models = [m async for m in db.models.find({"_id": {"$regex": "^" + re.escape(project) + "/"}},
                                                  {"_id": 1, "source": 1})]
        log(f"{project} {tag}: {len(boards)} boards, {len(models)} models")
        await flush()
        manifest = {"project": project, "tag": tag, "boards": [], "models": []}
        for b in boards:
            manifest["boards"].append(await _board(db, b["_id"], out, log))
            await flush()
        gate = asyncio.Semaphore(DRAW_AT_ONCE)

        async def one(mid: str) -> dict:
            async with gate:
                got = await _model(db, mid, out, tag, project, log)
                await flush()
                return got
        manifest["models"] = list(await asyncio.gather(*(one(m["_id"]) for m in models)))
        src = out / "sources"
        for m in models:
            if m.get("source"):
                p = src / "models" / f"{m['_id']}.py"
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(m["source"])
        for b in boards:
            if b.get("source"):
                p = src / "boards" / f"{b['_id']}.ato"
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(b["source"])
        rel = await db[COLL].find_one({"_id": rid})
        (out / "README.md").write_text(_readme(rel, manifest))
        (out / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str))
        buf = io.BytesIO()
        root = f"{project}-{tag}"
        files = []
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for p in sorted(out.rglob("*")):
                if p.is_file():
                    rel_path = str(p.relative_to(out))
                    z.write(p, f"{root}/{rel_path}")
                    files.append({"path": rel_path, "bytes": p.stat().st_size})
        data = buf.getvalue()
        ZIPS.mkdir(parents=True, exist_ok=True)
        (ZIPS / f"{rid}.zip").write_bytes(data)
        fid = await store.bucket(db, BUCKET).upload_from_stream(f"{root}.zip", data)
        problems = [f"{x['id']}: {p}" for x in manifest["boards"] + manifest["models"] for p in x["problems"]]
        log(f"done: {len(files)} files, {len(data) // 1024} KB, {round(time.monotonic() - t0)} s")
        await flush(status="ready", zip_id=fid, bytes=len(data), files=files, problems=problems,
                    summary={"boards": [{"id": b["id"], "bom": b.get("bom")} for b in manifest["boards"]],
                             "models": len(manifest["models"])},
                    took_s=round(time.monotonic() - t0, 1), done_at=_now())
    except Exception as exc:
        log(f"failed: {type(exc).__name__}: {exc}")
        await flush(status="failed", done_at=_now())
    finally:
        shutil.rmtree(out, ignore_errors=True)
        _RUNNING.pop(rid, None)


async def make(db, project: str, tag: str, notes: str, by: dict) -> dict:
    project, tag = project.strip().strip("/"), tag.strip()
    if not project or "/" in project:
        raise ValueError("a release is of a project - a folder at the top of the catalog")
    if not TAG.match(tag):
        raise ValueError("a tag is letters, digits, dots and dashes, e.g. v1.2")
    if await db[COLL].find_one({"project": project, "tag": tag}, {"_id": 1}):
        raise ValueError(f"{project} {tag} exists already - a release is never overwritten; pick another tag")
    doc = {"_id": secrets.token_hex(6), "project": project, "tag": tag, "notes": (notes or "").strip()[:4000],
           "by": by, "created_at": _now(), "status": "building", "log": []}
    await db[COLL].insert_one(doc)
    _RUNNING[doc["_id"]] = asyncio.create_task(_run(db, doc["_id"]))
    return doc


async def listing(db, project: str | None = None) -> list[dict]:
    q = {"project": project} if project else {}
    return [d async for d in db[COLL].find(q, {"log": 0}).sort("created_at", -1)]


async def download(db, rid: str) -> tuple[str, bytes]:
    doc = await db[COLL].find_one({"_id": rid})
    if not doc or doc.get("status") != "ready":
        raise KeyError(rid)
    name = f"{doc['project']}-{doc['tag']}.zip"
    kept = ZIPS / f"{rid}.zip"
    if kept.exists():
        return name, kept.read_bytes()
    stream = await store.bucket(db, BUCKET).open_download_stream(doc["zip_id"])
    data = await stream.read()
    ZIPS.mkdir(parents=True, exist_ok=True)
    kept.write_bytes(data)
    return name, data


async def remove(db, rid: str) -> bool:
    doc = await db[COLL].find_one({"_id": rid})
    if not doc:
        return False
    if doc.get("zip_id"):
        try:
            await store.bucket(db, BUCKET).delete(doc["zip_id"])
        except Exception:
            pass
    await db[COLL].delete_one({"_id": rid})
    (ZIPS / f"{rid}.zip").unlink(missing_ok=True)
    return True


async def abandoned(db) -> int:
    """At start-up: a release that was being made when the server stopped
    will never finish - say so, rather than showing it packing forever."""
    # An hour: a release takes minutes, and a second server on the same
    # database may be making one right now.
    from datetime import timedelta
    before = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    res = await db[COLL].update_many({"status": "building", "created_at": {"$lt": before}},
                                     {"$set": {"status": "failed", "done_at": _now()},
                                      "$push": {"log": "the server stopped while this was being made - make it again"}})
    return res.modified_count
