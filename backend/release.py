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

from . import ato, kicad, lcsc, limits, store

COLL = "releases"
BUCKET = "releases"
TAG = re.compile(r"^[\w][\w.\-]{0,31}$")
ROOT = Path(__file__).resolve().parent.parent
DRAW_IMAGE = os.environ.get("X3_DRAW_IMAGE", "redline-draw")
DRAW_TIMEOUT = 300
DRAWINGS = ROOT / ".cache" / "drawings"
# The zips on disk as well as in the database: the database is far away,
# and thirty megabytes from it is minutes; from disk it is at once.
ZIPS = ROOT / ".cache" / "releases"
# Drawings made side by side: a large assembly takes minutes on one core.
DRAW_AT_ONCE = int(os.environ.get("X3_DRAW_AT_ONCE", "3"))

_RUNNING: dict[str, asyncio.Task] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------- drawings

async def drawing(step: bytes, out: Path, *, title: str, project: str, tag: str, ident: str, sha: str) -> str | None:
    """A technical drawing of a STEP, in the drawing container. None if it
    was made; otherwise why not."""
    work = Path(tempfile.mkdtemp(prefix="x3draw-"))
    try:
        os.chmod(work, 0o777)
        (work / "model.step").write_bytes(step)
        argv = ["docker", "run", "--rm", *limits.box(), "--network", "none",
                "--user", f"{os.getuid()}:{os.getgid()}",
                "-v", f"{work}:/work", "-v", f"{ROOT / 'tools'}:/tools:ro", DRAW_IMAGE,
                "/work/model.step", "/work/drawing.pdf", "--title", title, "--project", project,
                "--tag", tag, "--id", ident, "--sha", sha]
        proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT)
        try:
            log, _ = await asyncio.wait_for(proc.communicate(), DRAW_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            return f"the drawing took longer than {DRAW_TIMEOUT} s"
        pdf = work / "drawing.pdf"
        if proc.returncode != 0 or not pdf.exists():
            text = log.decode(errors="replace").strip().splitlines()
            if any("Unable to find image" in t or "pull access denied" in t for t in text):
                return "the drawing image is not built: docker build -t redline-draw -f docker/draw/Dockerfile docker/draw"
            return (text[-1] if text else "the drawing failed")[:300]
        out.write_bytes(pdf.read_bytes())
        return None
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def model_drawing(db, model_id: str, tag: str = "") -> bytes:
    """A model's technical drawing on its own, for the 3D room: made once
    per STEP (kept by the STEP's fingerprint)."""
    doc = await db.models.find_one({"_id": model_id}, {"artifacts": 1, "title": 1, "sha256": 1})
    if not doc:
        raise KeyError(model_id)
    meta = (doc.get("artifacts") or {}).get("step")
    if not meta:
        raise LookupError("this model has no STEP to draw from - its script does not export one")
    DRAWINGS.mkdir(parents=True, exist_ok=True)
    kept = DRAWINGS / f"{meta['sha256'][:24]}.pdf"
    if kept.exists():
        return kept.read_bytes()
    step = await store.get_artifact(db, model_id, "step")
    why = await drawing(step, kept, title=doc.get("title") or model_id.split("/")[-1],
                        project=model_id.split("/")[0], tag=tag, ident=model_id, sha=doc.get("sha256") or "")
    if why:
        raise RuntimeError(why)
    return kept.read_bytes()


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
    work = Path(tempfile.mkdtemp(prefix="x3rel-"))
    try:
        os.chmod(work, 0o777)
        pcb = await store.get_artifact(db, bid, pcb_label, ato.BOARDS)
        (work / "board.kicad_pcb").write_bytes(pcb)
        has_sch = "schematic" in arts
        if has_sch:
            (work / "board.kicad_sch").write_bytes(await store.get_artifact(db, bid, "schematic", ato.BOARDS))
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
    doc = await db.models.find_one({"_id": mid}, {"artifacts": 1, "title": 1, "sha256": 1, "stale": 1})
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
                            ident=mid, sha=doc.get("sha256") or "")
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

    out = Path(tempfile.mkdtemp(prefix="x3release-"))
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
