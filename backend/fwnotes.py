"""Notes on firmware: filed in the Firmware room, applied by its agent.

A firmware note is a revision like any other (`revisions`, kind
"firmware", `model` = the firmware's id) with an anchor saying what it is
about:

    {"kind": "pin",  "pin": "33", "name": "IO21", "net": "L_SDA", "macro": "L_SDA",
     "gpio": 21, "parts": [...]}                       a pin of the MCU (a row of Pins)
    {"kind": "net",  ...the same, found by the net}    a net label on the sheet
    {"kind": "code", "file": "src/main.cpp", "lines": [12, 18], "excerpt": "..."}
    every anchor also says the firmware version it was written against.

The anchor is checked when the note is filed: the pin has to be on the
MCU as the board draws it now, the file has to be in the project, the
lines inside the file.

The agent edits the files (a new version each save, refused when the
firmware moved on - `base`), builds, and finishes. Finishing a firmware
note is refused until the version holding the change has built cleanly
(`result`). What it stores on the note in place of a 3D "after" render:
the diff between the version the work started from and the built one,
the build's figures (errors, warnings, flash and RAM before and after),
and a picture of the main changed hunk, drawn here with Pillow.
"""

from __future__ import annotations

import difflib
import io
import re
from pathlib import Path

from . import firmware, store

KIND = "firmware"
MAX_EXCERPT = 60
MAX_DIFF_LINES = 400


class Refused(ValueError):
    """The note cannot be finished, or the anchor is not one: why, in words."""


# ---------------------------------------------------------------- anchors

def _pin_out(r: dict, kind: str) -> dict:
    return {"kind": kind, "pin": str(r["number"]), "name": r.get("name"), "net": r.get("net"),
            "macro": r.get("macro") or None, "gpio": r.get("gpio"), "parts": list(r.get("parts") or [])}


async def check_anchor(db, fid: str, anchor: dict | None) -> dict | None:
    """The anchor as it is kept, or Refused with what is wrong with it."""
    try:
        fw = await firmware.get(db, fid)
    except KeyError:
        raise Refused(f"no firmware {fid}")
    if not anchor:
        return None
    kind = (anchor.get("kind") or "").strip()
    version = fw.get("version") or 0
    if kind in ("pin", "net"):
        board = await db["boards"].find_one({"_id": fw["board"]})
        mcu = firmware.mcu_of(board, fw["mcu"])
        if not mcu:
            raise Refused(f"{fw['mcu']} is not on the board's schematic - no pin to anchor to")
        rows = firmware.pin_rows(mcu)
        hit = None
        if kind == "pin":
            want = str(anchor.get("pin") or "").strip()
            name = str(anchor.get("name") or "").strip().upper()
            gpio = anchor.get("gpio")
            for r in rows:
                if (want and r["number"] == want) or (not want and name and r["name"].upper() == name) \
                        or (not want and not name and gpio is not None and r["gpio"] == gpio):
                    hit = r
                    break
            if not hit:
                said = want or name or (f"GPIO{gpio}" if gpio is not None else "?")
                raise Refused(f"{fw['mcu']} has no pin {said}")
        else:
            net = str(anchor.get("net") or anchor.get("macro") or "").strip()
            if not net:
                raise Refused("a net anchor needs the net's name")
            for r in rows:
                if r.get("net") == net or (r.get("macro") and r["macro"] == net) or \
                        (r.get("net") and firmware.macro_of(r["net"]) == net):
                    hit = r
                    break
            if not hit:
                raise Refused(f"no pin of {fw['mcu']} is on net {net}")
        return {**_pin_out(hit, kind), "version": version}
    if kind == "code":
        path = anchor.get("file") or ""
        try:
            got = await firmware.read(db, fid, path)
        except firmware.Refused as exc:
            raise Refused(str(exc))
        except KeyError:
            raise Refused(f"{fw['title']} has no file {path}")
        count = len(got["content"].splitlines()) or 1
        lines = anchor.get("lines") or []
        try:
            a, b = (int(lines[0]), int(lines[-1])) if lines else (1, count)
        except (TypeError, ValueError):
            raise Refused("lines: two line numbers, first and last")
        if a > b:
            a, b = b, a
        if a < 1 or b > count:
            raise Refused(f"{got['path']} has {count} lines - {a}-{b} is outside it")
        text = got["content"].splitlines()[a - 1:b]
        return {"kind": "code", "file": got["path"], "lines": [a, b], "version": version,
                "excerpt": "\n".join(text[:MAX_EXCERPT])}
    raise Refused("anchor kind: pin, net or code")


def anchor_text(anchor: dict | None) -> str:
    """One line: what the note is anchored to."""
    if not anchor:
        return "the firmware as a whole"
    if anchor.get("kind") == "code":
        a, b = anchor.get("lines") or [0, 0]
        return f"{anchor.get('file')}:{a}" + (f"-{b}" if b != a else "")
    gpio = anchor.get("gpio")
    parts = ", ".join(anchor.get("parts") or []) or "nothing else on it"
    return (f"{anchor.get('name')} (pin {anchor.get('pin')}"
            + (f", GPIO{gpio}" if gpio is not None else "") + f") - net {anchor.get('macro') or anchor.get('net')}"
            + f" - {parts}")


# ---------------------------------------------------------------- versions

def _udiff(path: str, before: str | None, after: str | None, va: int, vb: int, n: int = 3) -> dict:
    a = (before or "").splitlines()
    b = (after or "").splitlines()
    lines = list(difflib.unified_diff(a, b, f"a/{path} (v{va})", f"b/{path} (v{vb})", lineterm="", n=n))
    added = sum(1 for x in lines if x.startswith("+") and not x.startswith("+++"))
    removed = sum(1 for x in lines if x.startswith("-") and not x.startswith("---"))
    status = "added" if before is None else "deleted" if after is None else "modified"
    cut = len(lines) > MAX_DIFF_LINES
    text = "\n".join(lines[:MAX_DIFF_LINES]) + ("\n... (cut)" if cut else "")
    return {"path": path, "status": status, "added": added, "removed": removed, "diff": text,
            "generated": path in firmware.GENERATED}


async def diff(db, fid: str, a: int | None = None, b: int | None = None) -> dict:
    """What changed between two versions of a firmware (default: the one
    before the latest, and the latest), file by file, as unified diffs."""
    fw = await firmware.get(db, fid)
    latest = fw.get("version") or 0
    b = latest if b is None else int(b)
    a = max(b - 1, 0) if a is None else int(a)
    if not (0 <= a <= latest and 0 <= b <= latest):
        raise Refused(f"versions go from 0 to {latest}")
    va = await firmware.contents(db, fid, a) if a else {}
    vb = await firmware.contents(db, fid, b) if b else {}
    files = [_udiff(p, va.get(p), vb.get(p), a, b) for p in sorted(set(va) | set(vb)) if va.get(p) != vb.get(p)]
    return {"firmware": fid, "a": a, "b": b, "files": files,
            "added": sum(f["added"] for f in files), "removed": sum(f["removed"] for f in files)}


# ---------------------------------------------------------------- the run

async def base_of(db, rev: dict) -> dict:
    """What the work started from: kept on the note when its run started,
    else the version the note was filed against."""
    if rev.get("fw_base"):
        return rev["fw_base"]
    v = ((rev.get("anchor") or {}).get("version"))
    return {"version": v if v is not None else None, "build": None}


async def started(db, rev: dict) -> None:
    """The firmware as the run starts: its version and its last build."""
    try:
        fw = await firmware.get(db, rev.get("model") or "")
    except KeyError:
        return
    b = fw.get("build") or {}
    build = ({k: b.get(k) for k in ("state", "version", "flash", "ram", "error_count", "warning_count")}
             if b.get("state") and b.get("state") != "running" else None)
    await db.revisions.update_one({"_id": rev["_id"]}, {"$set": {"fw_base": {
        "version": fw.get("version") or 0, "build": build, "at": store.now()}}})


def _size(s: dict | None) -> dict | None:
    return {"used": s["used"], "total": s["total"], "pct": s["pct"]} if s else None


async def result(db, rid: str) -> dict:
    """Check a firmware note can be finished and keep what the work did on
    it: the diff, the build, the picture. Refused (with why) when nothing
    was saved since the work started, or the version holding the change
    has not built cleanly."""
    rev = await db.revisions.find_one({"_id": rid})
    if not rev:
        raise KeyError(rid)
    if rev.get("kind") != KIND:
        raise Refused(f"{rid} is not a firmware note")
    try:
        fw = await firmware.get(db, rev.get("model") or "")
    except KeyError:
        raise Refused(f"the note's firmware {rev.get('model')} is gone")
    base = await base_of(db, rev)
    now_v = fw.get("version") or 0
    from_v = base.get("version")
    if from_v is None:
        raise Refused("the note does not say which version it started from - start its run first")
    if now_v <= from_v:
        raise Refused(f"{fw['title']} is still at v{now_v}, where the work started - "
                      "save the change first (revisions.py fw put)")
    b = fw.get("build") or {}
    tell = f"revisions.py fw build {fw['_id']} --wait"
    if b.get("state") == "running":
        raise Refused(f"a build is running - wait for it ({tell})")
    if b.get("version") != now_v:
        raise Refused(f"v{now_v} has not been built (the last build is of v{b.get('version')}) - {tell}")
    if b.get("state") != "ok":
        raise Refused(f"the build of v{now_v} failed: {b.get('error_count', 0)} error(s) - "
                      "fix them, save, build again")
    got = await diff(db, fw["_id"], from_v, now_v)
    before = base.get("build") or {}
    same = before.get("version") == from_v and before.get("state") == "ok"
    build = {"job": b.get("job"), "version": now_v, "at": b.get("at"), "seconds": b.get("seconds"),
             "errors": b.get("error_count", 0), "warnings": b.get("warning_count", 0),
             "warning_list": (b.get("warnings") or [])[:10],
             "flash": {"before": _size(before.get("flash")) if same else None, "after": _size(b.get("flash"))},
             "ram": {"before": _size(before.get("ram")) if same else None, "after": _size(b.get("ram"))}}
    main = main_hunk(got["files"])
    out = {"firmware": fw["_id"], "title": fw.get("title"), "from_version": from_v, "version": now_v,
           "files": [{k: f[k] for k in ("path", "status", "added", "removed", "diff", "generated")}
                     for f in got["files"]],
           "added": got["added"], "removed": got["removed"], "build": build,
           "main": {"file": main["file"], "line": main["line"]} if main else None,
           "at": store.now()}
    png = render_png(out, main)
    shot = await store.put_shot(db, png)
    await db.revisions.update_one({"_id": rid}, {"$set": {"fw_result": out, "image_after": shot}})
    old = (rev.get("image_after") or {}).get("gridfs_id")
    if old:                                      # finished again: the last picture is not kept
        try:
            await store.bucket(db, "shots").delete(old)
        except Exception:                        # noqa: BLE001 - gone already
            pass
    return out


def result_line(r: dict | None) -> str:
    """The build half of a finished note, as one line."""
    if not r:
        return ""
    b = r["build"]

    def pair(x):
        a, z = x.get("before"), x.get("after")
        if not z:
            return "-"
        return (f"{a['pct']}% -> " if a else "") + f"{z['pct']}% ({z['used'] // 1024} KB" \
            + (f", {_delta(a, z)}" if a else "") + ")"
    return (f"built v{r['version']} (from v{r['from_version']}): {b['errors']} errors, {b['warnings']} warnings · "
            f"flash {pair(b['flash'])} · RAM {pair(b['ram'])} · ready to flash")


def _delta(a: dict, z: dict) -> str:
    """How many bytes a change added (or took off) flash or RAM."""
    d = z["used"] - a["used"]
    return f"{'+' if d >= 0 else '-'}{abs(d)} B"


# ---------------------------------------------------------------- the picture

_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def hunks(text: str) -> list[dict]:
    """A unified diff's hunks: where each starts and its lines."""
    out: list[dict] = []
    for line in text.splitlines():
        m = _HUNK.match(line)
        if m:
            out.append({"old": int(m.group(1)), "new": int(m.group(3)), "lines": []})
        elif out and not line.startswith(("+++", "---")):
            out[-1]["lines"].append(line)
    return out


def main_hunk(files: list[dict]) -> dict | None:
    """The hunk worth a picture: in the file the change is mostly in
    (never pins.h when anything else changed), the one with most changed
    lines."""
    real = [f for f in files if not f.get("generated")] or files
    best = None
    for f in sorted(real, key=lambda f: -(f["added"] + f["removed"])):
        for h in hunks(f.get("diff") or ""):
            n = sum(1 for x in h["lines"] if x[:1] in "+-")
            if best is None or n > best["n"]:
                first = next((i for i, x in enumerate(h["lines"]) if x[:1] in "+-"), 0)
                new_line = h["new"] + sum(1 for x in h["lines"][:first] if not x.startswith("-"))
                best = {"file": f["path"], "line": new_line, "hunk": h, "n": n,
                        "added": f["added"], "removed": f["removed"]}
        if best:
            break
    return best


def _font(size: int, bold: bool = False):
    from PIL import ImageFont
    names = (["DejaVuSansMono-Bold.ttf"] if bold else []) + ["DejaVuSansMono.ttf"]
    for d in ("/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu", "/usr/share/fonts/TTF"):
        for n in names:
            p = Path(d) / n
            if p.exists():
                return ImageFont.truetype(str(p), size)
    return ImageFont.load_default()


def render_png(r: dict, main: dict | None, width: int = 1280, height: int = 720) -> bytes:
    """The card's "after": the main changed hunk as a code view - line
    numbers, removed lines red, added green - under a strip that says the
    file, the counts and the build."""
    from PIL import Image, ImageDraw

    bg, fg, dim = (30, 31, 34), (220, 220, 214), (128, 131, 138)
    add_bg, del_bg = (31, 64, 40), (76, 34, 36)
    add_fg, del_fg, ok = (140, 220, 150), (240, 150, 150), (110, 200, 120)
    img = Image.new("RGB", (width, height), bg)
    d = ImageDraw.Draw(img)
    f, fb, small = _font(17), _font(18, bold=True), _font(15)
    # the strip
    d.rectangle([0, 0, width, 74], fill=(42, 44, 48))
    head = f"{main['file']}" if main else (r.get("title") or "firmware")
    d.text((18, 12), head, font=fb, fill=fg)
    stats = f"+{r['added']} -{r['removed']} in {len(r['files'])} file{'s' if len(r['files']) != 1 else ''}"
    d.text((18 + d.textlength(head, font=fb) + 18, 13), stats, font=f, fill=dim)
    b = r["build"]
    line2 = (f"v{r['from_version']} -> v{r['version']} · built: {b['errors']} errors, {b['warnings']} warnings"
             + "".join(f" · {name} {x['after']['pct']}%" + (f" ({_delta(x['before'], x['after'])})" if x.get("before") else "")
                       for name, x in (("flash", b["flash"]), ("RAM", b["ram"])) if x.get("after")))
    d.text((18, 44), line2, font=small, fill=ok if not b["errors"] else del_fg)
    y, lh = 86, 24
    rows = (height - y - 8) // lh
    if not main:
        d.text((18, y), "no source line changed", font=f, fill=dim)
    else:
        h = main["hunk"]
        lines = h["lines"]
        first = next((i for i, x in enumerate(lines) if x[:1] in "+-"), 0)
        start = max(0, min(first - 3, len(lines) - rows))
        old, new = h["old"], h["new"]
        for x in lines[:start]:
            if not x.startswith("+"):
                old += 1
            if not x.startswith("-"):
                new += 1
        num_w = 120
        for x in lines[start:start + rows]:
            sign, body = (x[:1], x[1:]) if x[:1] in "+- " else (" ", x)
            if sign == "+":
                d.rectangle([0, y - 2, width, y + lh - 3], fill=add_bg)
                nums, col = f"{'':>4} {new:>4}", add_fg
                new += 1
            elif sign == "-":
                d.rectangle([0, y - 2, width, y + lh - 3], fill=del_bg)
                nums, col = f"{old:>4} {'':>4}", del_fg
                old += 1
            else:
                nums, col = f"{old:>4} {new:>4}", fg
                old += 1
                new += 1
            d.text((10, y), nums, font=small, fill=dim)
            d.text((num_w, y), sign if sign != " " else "", font=f, fill=col)
            d.text((num_w + 18, y), body.replace("\t", "    ")[:110], font=f, fill=col)
            y += lh
        more = len(lines) - (start + rows)
        if more > 0:
            d.text((num_w + 18, height - 26), f"... {more} more line(s) in this hunk", font=small, fill=dim)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()
