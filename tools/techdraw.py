"""A dimensioned technical drawing of a model, as a PDF for the workshop.

    python tools/techdraw.py model.step out.pdf --title "Fan Stand" \
        --project iot-fan --tag v1.2 --id iot-fan/parts/stand --sha 1a2b3c

An A3 landscape sheet: front, top and right views with hidden edges
dashed, an isometric view, the overall sizes dimensioned in millimetres,
the scale picked from the standard ones so the views fit, and a title
block (name, project, release, date, scale, units, general tolerance).
The views are the model's own edges projected (build123d's hidden-line
removal), not a picture of the screen.

Run in its own container (docker/draw, image redline-draw - nothing is
installed on the machine): projecting a large assembly takes memory and
time, and a release must not fall over because one drawing did.

With --png it also writes a small picture of the sheet (PyMuPDF, about
480 px wide), the preview the 3D room shows before the PDF is opened, and
with --info what the sheet holds (its size, scale and views) as JSON.

With --spec a layout chosen for the model (backend/drawlayout.py, the 3D
room's layout editor): the sheet (A4/A3 or picked, either way round), the
views as boxes on it - each one's view, scale, hidden lines and dimensions
- and parts of an assembly left out or drawn heavier. Without one the
views are laid out as above, by themselves.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import date

from fpdf import FPDF

# Landscape sheets, smallest first: the smallest one the part fits at 1:1 or
# larger is taken, else A3.
SHEETS = {"A4": (297.0, 210.0), "A3": (420.0, 297.0)}
MARGIN = 10.0
TITLE_H = 36.0
# Room around each view: its vertical dimension on the left, its name over
# it, its horizontal dimension under it.
PAD_L, PAD_R, PAD_T, PAD_B = 13.0, 4.0, 8.0, 12.0
# The isometric view's cell is never smaller than this.
ISO_MIN = 45.0
# mm a view may overrun its box and still fit: an automatic drawing's boxes
# are exactly what their views need, and the layout editor keeps them rounded.
FIT_SLACK = 0.5
# A Unicode font, for names in Turkish and the like (fonts-dejavu-core in
# docker/draw); Helvetica where it is not installed.
DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans{}.ttf"
PREVIEW_W = 480                                   # px, the preview's width
SCALES = [(10, 1), (5, 1), (2, 1), (1, 1), (1, 2), (1, 5), (1, 10), (1, 20), (1, 50), (1, 100)]


def progress(pct: int, stage: str) -> None:
    """A line the caller follows (backend/release.py): how far, and the
    step now under way."""
    print(f"@progress {pct} {stage}", flush=True)


# The views a layout may hold: the direction each is seen from, and which
# way is up in it; and the name it has on the sheet.
VIEWS = {"front": ((0, -1, 0), (0, 0, 1)), "back": ((0, 1, 0), (0, 0, 1)),
         "top": ((0, 0, 1), (0, 1, 0)), "bottom": ((0, 0, -1), (0, 1, 0)),
         "right": ((1, 0, 0), (0, 0, 1)), "left": ((-1, 0, 0), (0, 0, 1)),
         "iso": ((1, -1, 1), (0, 0, 1))}
LABELS = {"front": "FRONT", "back": "BACK", "top": "TOP", "bottom": "BOTTOM", "right": "RIGHT", "left": "LEFT",
          "iso": "ISOMETRIC"}
# What a STEP calls a node it was given no name for.
UNNAMED = {"", "COMPOUND", "SOLID", "SHELL", "COMPSOLID", "FACE", "WIRE", "EDGE", "VERTEX"}


def project(shape, direction, up, around=None):
    """Visible and hidden edges of `shape` seen along -direction, as 2D
    polylines in the view's own coordinates - those of `around`'s view
    when given, so a part drawn over the whole lands where it is in it."""
    from build123d import Vector
    bb = (around or shape).bounding_box()
    centre = bb.center()
    far = max(bb.size.X, bb.size.Y, bb.size.Z) * 10 + 100
    d = Vector(*direction).normalized()
    origin = centre + d * far
    visible, hidden = shape.project_to_viewport(tuple(origin), tuple(up), tuple(centre))

    def lines(edges):
        out = []
        for e in edges:
            try:
                # Only a true line is two points. A projected curve often comes
                # back as a B-spline ("BSPLINE", "GeomType.BSPLINE" - which also
                # ends in "LINE"), and drawn as one chord it broke rounded
                # openings into straight stubs; curves get points by length.
                kind = getattr(e.geom_type, "name", str(e.geom_type)).split(".")[-1]
                n = 2 if kind == "LINE" else max(24, min(240, int(e.length / 0.4)))
                pts = [e @ (i / (n - 1)) for i in range(n)]
                out.append([(p.X, p.Y) for p in pts])
            except Exception:
                continue
        return out
    return lines(visible), lines(hidden)


def bounds(polys):
    xs = [x for p in polys for x, _ in p]
    ys = [y for p in polys for _, y in p]
    if not xs:
        return 0, 0, 0, 0
    return min(xs), min(ys), max(xs), max(ys)


class Sheet(FPDF):
    pass


def norm(name) -> str:
    """A part's name as the STEP keeps it and as the model tree shows it,
    made one: the STEP writes "Pins x2" as "Pins_x2"."""
    return re.sub(r"[^0-9a-z]+", "_", str(name).lower()).strip("_")


def leaves(shape, names=()):
    """The parts of an assembly, each with the names on the way to it
    (its groups', then its own). A flat model's STEP names no part: then
    the model's NAMES, in order, if there are as many."""
    out = []

    def walk(node, path):
        label = str(getattr(node, "label", "") or "")
        if label.upper() in UNNAMED:
            label = ""
        here = path + [label] if label else path
        kids = list(getattr(node, "children", None) or ())
        if not kids:
            out.append((here, node, bool(label)))
        for kid in kids:
            walk(kid, here)
    walk(shape, [])
    if names and len(out) == len(names) and len(out) > 1 and not any(named for _, _, named in out):
        return [(p + [str(n)], node) for (p, node, _), n in zip(out, names)]
    return [(p, node) for p, node, _ in out]


def select(shape, hide=(), highlight=(), names=()):
    """The model with the parts named in `hide` left out (a group's name
    takes all of it), the parts named in `highlight` on their own (None if
    none), every name there is to choose from, and the asked-for names
    that are no part's."""
    parts = leaves(shape, names)
    # Every name there is to choose from, but the model's own (the root's).
    root = str(getattr(shape, "label", "") or "")
    root = root if root.upper() not in UNNAMED and len(parts) > 1 else None
    known = list(dict.fromkeys(n for p, _ in parts for n in (p[1:] if root and p and p[0] == root else p)))
    out_, lit_ = {norm(n) for n in hide} - {""}, {norm(n) for n in highlight} - {""}
    have = {norm(n) for p, _ in parts for n in p}
    unmatched = [n for n in [*hide, *highlight] if norm(n) not in have]
    if not out_ and not lit_:
        return shape, None, known, unmatched

    def placed(node):
        try:
            return node.located(node.global_location)
        except Exception:                             # not in a tree: where it is
            return node
    from build123d import Compound
    keep = [(p, node) for p, node in parts if not out_ & {norm(n) for n in p}]
    if not keep:
        raise ValueError("every part is hidden - leave at least one on the sheet")
    drawn = shape if len(keep) == len(parts) else Compound(children=[placed(n) for _, n in keep])
    lit = [placed(n) for p, n in keep if lit_ & {norm(x) for x in p}]
    return drawn, (Compound(children=lit) if lit else None), known, unmatched


def ratio(text: str):
    """"1:2" as (1, 2); None for "auto" or anything else."""
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*", str(text or ""))
    if not m or float(m[1]) <= 0 or float(m[2]) <= 0:
        return None
    a, b = float(m[1]), float(m[2])
    return (int(a) if a.is_integer() else a, int(b) if b.is_integer() else b)



def fill_ratio(k: float):
    """The largest ratio written to a tenth that is at most `k`: 1.74 -> (1.7, 1),
    0.42 -> (1, 2.4); never 0."""
    if k >= 1:
        a = max(1.0, int(k * 10 + 1e-9) / 10)
        return (int(a) if a.is_integer() else a, 1)
    d = int((1 / max(k, 1e-6)) * 10 + 0.999999) / 10          # 1/k rounded up to a tenth
    d = max(d, 1.1)
    return (1, int(d) if d.is_integer() else d)


def pads(dims: bool):
    """Room around a view in a box: its dimensions' too when it has them."""
    return (PAD_L, PAD_R, PAD_T, PAD_B) if dims else (4.0, PAD_R, PAD_T, 4.0)


def frame(sw: float, sh: float):
    """Where views may go: inside the border, above the title block."""
    return MARGIN, MARGIN, sw - MARGIN, sh - MARGIN - TITLE_H


def spec_cells(spec: dict, size: dict, sheet: str, landscape: bool):
    """A layout's boxes on `sheet` in mm, kept inside the frame, and the one
    scale its "auto" boxes share: the largest standard one at which each of
    their views fits its box. ([(box, x, y, w, h)], (num, den) or None)."""
    sw, sh = SHEETS[sheet] if landscape else SHEETS[sheet][::-1]
    fx0, fy0, fx1, fy1 = frame(sw, sh)
    boxes = []
    for b in spec.get("views") or []:
        if b.get("view") not in VIEWS:
            continue
        x, y = max(fx0, float(b["x"]) * sw), max(fy0, float(b["y"]) * sh)
        w, h = min(fx1, float(b["x"] + b["w"]) * sw) - x, min(fy1, float(b["y"] + b["h"]) * sh) - y
        if w > 4 and h > 4:
            boxes.append((b, x, y, w, h))
    auto = [(b, w, h) for b, _, _, w, h in boxes
            if b["view"] != "iso" and (b.get("scale") or "auto") == "auto"]
    if not auto:
        return boxes, None
    for num, den in SCALES:
        k = num / den
        ok = True
        for b, w, h in auto:
            vw, vh = size[b["view"]]
            pl, pr, pt, pb = pads(b.get("dims", True))
            if vw * k + pl + pr > w + FIT_SLACK or vh * k + pt + pb > h + FIT_SLACK:
                ok = False
                break
        if ok:
            return boxes, (num, den)
    return boxes, SCALES[-1]


def layout(size: dict, sheet: str):
    """The largest standard scale at which the views fit `sheet` in the
    usual arrangement - FRONT with RIGHT beside it, TOP under FRONT, the
    isometric view in the corner left - each column as wide and each row as
    tall as its views (and their dimensions) need. (num, den, cells) or
    None if it fits at no scale."""
    sw, sh = SHEETS[sheet]
    aw, ah = sw - 2 * MARGIN, sh - 2 * MARGIN - TITLE_H
    (wf, hf), (wt, ht), (wr, hr) = size["front"], size["top"], size["right"]
    for num, den in SCALES:
        k = num / den
        c1 = max(wf, wt) * k + PAD_L + PAD_R
        c2 = max(wr * k + PAD_L + PAD_R, ISO_MIN)
        r1 = max(hf, hr) * k + PAD_T + PAD_B
        r2 = max(ht * k + PAD_T + PAD_B, ISO_MIN)
        if c1 + c2 <= aw and r1 + r2 <= ah:
            return num, den, (aw, ah, c1, c2, r1, r2)
    return None


def pick(size: dict):
    """The sheet and scale: A4 when the part goes on it at 1:1 or larger,
    else A3 at the largest scale that fits (its smallest if none does)."""
    small = layout(size, "A4")
    if small and small[0] >= small[1]:
        return "A4", small
    big = layout(size, "A3")
    if big:
        return "A3", big
    sw, sh = SHEETS["A3"]
    aw, ah = sw - 2 * MARGIN, sh - 2 * MARGIN - TITLE_H
    return "A3", (*SCALES[-1], (aw, ah, aw / 2, aw / 2, ah / 2, ah / 2))


def draw(step: str, out: str, title: str, project_name: str, tag: str, ident: str, sha: str,
         png: str = "", info: str = "", spec: dict | None = None) -> None:
    spec = spec or {}
    custom = bool(spec.get("views"))
    progress(2, "reading the STEP")
    from build123d import import_step
    whole = import_step(step)
    parts = spec.get("parts") or {}
    shape, lit, known, unmatched = select(whole, parts.get("hide") or (), parts.get("highlight") or (),
                                          parts.get("names") or ())
    bb = shape.bounding_box()
    sx, sy, sz = bb.size.X, bb.size.Y, bb.size.Z

    # Projecting is nearly all of the time; the isometric view, with every
    # edge seen at a slant, the longest.
    if custom:
        wanted = list(dict.fromkeys(b["view"] for b in spec["views"] if b.get("view") in VIEWS))
        if not wanted:
            raise ValueError("the layout has no view to draw")
        steps = [(v, 10 + round(75 * i / len(wanted))) for i, v in enumerate(wanted)]
    else:
        steps = [("front", 10), ("top", 30), ("right", 48), ("iso", 64)]
    views, lit_views = {}, {}
    for key, at in steps:
        progress(at, f"projecting the {'isometric' if key == 'iso' else key} view")
        direction, up = VIEWS[key]
        views[key] = project(shape, direction, up)
        if lit is not None:
            lit_views[key] = project(lit, direction, up, around=shape)
    progress(90, "laying out the sheet")
    ext = {k: bounds(v[0] + v[1]) for k, v in views.items()}
    size = {k: (b[2] - b[0], b[3] - b[1]) for k, b in ext.items()}

    # A cell each view is drawn in: where (mm), at what scale (None: as large
    # as fits, not to scale), with hidden lines or not, its dimensions
    # (("h"|"v", value)), and whether it is clipped to its box.
    paper = spec.get("sheet") or {}
    landscape = paper.get("orientation", "landscape") != "portrait"
    if custom:
        sheet = paper.get("size") if paper.get("size") in SHEETS else None
        if sheet is None:                         # A4 when it goes on it at 1:1 or larger
            _, common = spec_cells(spec, size, "A4", landscape)
            sheet = "A4" if common is None or common[0] >= common[1] else "A3"
        boxes, common = spec_cells(spec, size, sheet, landscape)
        if not boxes:
            raise ValueError("no view box of the layout is on the sheet")
        first = next((ratio(b.get("scale")) for b, *_ in boxes if b["view"] != "iso" and ratio(b.get("scale"))), None)
        num, den = common or first or (1, 1)
        cells = []
        for b, x, y, w, h in boxes:
            key = b["view"]
            mode = str(b.get("scale") or "auto")
            fixed = ratio(mode)
            dims = []
            if b.get("dims", key != "iso") and key != "iso":
                dims = [("h", size[key][0]), ("v", size[key][1])]
            pl, pr, pt, pb = pads(bool(dims))
            vw, vh = size[key]
            if mode == "fit" and key != "iso":
                # The largest standard scale at which this view fits its own box.
                fixed = next(((a, d) for a, d in SCALES
                              if vw * a / d + pl + pr <= w + FIT_SLACK and vh * a / d + pt + pb <= h + FIT_SLACK), SCALES[-1])
            k = fixed[0] / fixed[1] if fixed else (None if key == "iso" else num / den)
            if mode == "fill" and key != "iso":
                # The box filled at a scale still worth writing: the largest
                # ratio to a tenth at which the view fits ("1.7:1", "1:2.4").
                fixed = fill_ratio(min((w - pl - pr) / max(vw, 1e-9), (h - pt - pb) / max(vh, 1e-9)))
                k = fixed[0] / fixed[1]
            label = LABELS[key]
            if k is not None and abs(k - num / den) > 1e-9:
                label += f" ({fixed[0]}:{fixed[1]})" if fixed else ""
            cells.append({"view": key, "at": (x, y, w, h), "k": k, "label": label, "dims": dims,
                          "hidden": bool(b.get("hidden_lines", key != "iso")), "pads": pads(bool(dims)),
                          "clip": True, "scale": mode if fixed else "auto",
                          "ratio": None if key == "iso" else (fixed or (num, den))})
        # The title block's scale: the one every scaled view shares, "AS SHOWN"
        # when they differ (each view then says its own), "NTS" with none.
        shown = {c["ratio"] for c in cells if c.get("ratio")}
        scale_text = (f"{next(iter(shown))[0]}:{next(iter(shown))[1]}" if len(shown) == 1
                      else "AS SHOWN" if shown else "NTS")
        if len(shown) == 1:
            num, den = next(iter(shown))
            for c in cells:                       # one scale for all: the title block says it once
                if c.get("ratio"):
                    c["label"] = LABELS[c["view"]]
    else:
        sheet, (num, den, (aw, ah, c1, c2, r1, r2)) = pick(size)
        # What the columns and rows leave over: a little between them (views
        # in projection stay close), the rest evenly around.
        sx_, sy_ = max(0.0, aw - c1 - c2), max(0.0, ah - r1 - r2)
        bx, by = min(sx_ / 3, 12.0), min(sy_ / 3, 8.0)
        x1, y1 = MARGIN + (sx_ - bx) / 2, MARGIN + (sy_ - by) / 2
        x2, y2 = x1 + c1 + bx, y1 + r1 + by
        k = num / den
        cells = [{"view": "front", "at": (x1, y1, c1, r1), "k": k, "dims": [("h", sx), ("v", sz)]},
                 {"view": "right", "at": (x2, y1, c2, r1), "k": k, "dims": [("h", sy)]},
                 {"view": "top", "at": (x1, y2, c1, r2), "k": k, "dims": [("v", sy)]},
                 # the isometric view: the rest of the sheet, to its own scale
                 {"view": "iso", "at": (x2, y2, MARGIN + aw - x2, MARGIN + ah - y2), "k": None, "dims": []}]
        for c in cells:
            c.update(label=LABELS[c["view"]], hidden=c["view"] != "iso", pads=(PAD_L, PAD_R, PAD_T, PAD_B),
                     clip=False, scale="auto")
        scale_text = f"{num}:{den}"
    scale = num / den
    sheet_w, sheet_h = SHEETS[sheet] if landscape else SHEETS[sheet][::-1]
    aw = sheet_w - 2 * MARGIN

    pdf = Sheet(orientation="L" if landscape else "P", unit="mm", format=sheet)
    font = "Helvetica"
    try:
        pdf.add_font("DejaVu", "", DEJAVU.format(""))
        pdf.add_font("DejaVu", "B", DEJAVU.format("-Bold"))
        font = "DejaVu"
    except (OSError, RuntimeError, FileNotFoundError):
        pass
    pdf.set_auto_page_break(False)
    pdf.add_page()
    pdf.set_draw_color(0)
    pdf.set_line_width(0.5)
    pdf.rect(MARGIN, MARGIN, sheet_w - 2 * MARGIN, sheet_h - 2 * MARGIN)

    def dim_h(to, b, value, below=True):
        """A horizontal overall dimension under (or over) a view."""
        (x1, y1), (x2, _) = to(b[0], b[1]), to(b[2], b[1])
        y = y1 + 7 if below else to(b[0], b[3])[1] - 7
        pdf.set_line_width(0.13)
        pdf.line(x1, y1 + (1 if below else -1), x1, y + (1.5 if below else -1.5))
        pdf.line(x2, y1 + (1 if below else -1), x2, y + (1.5 if below else -1.5))
        pdf.line(x1, y, x2, y)
        for xa, s in ((x1, 1), (x2, -1)):
            pdf.polygon([(xa, y), (xa + 2.2 * s, y - 0.7), (xa + 2.2 * s, y + 0.7)], style="F")
        txt = f"{value:.1f}".rstrip("0").rstrip(".")
        pdf.set_font(font, "", 8)
        w = pdf.get_string_width(txt)
        pdf.text((x1 + x2) / 2 - w / 2, y - 1.2, txt)

    def dim_v(to, b, value):
        """A vertical overall dimension to the left of a view."""
        (x1, y1), (_, y2) = to(b[0], b[1]), to(b[0], b[3])
        x = x1 - 7
        pdf.set_line_width(0.13)
        pdf.line(x1 - 1, y1, x - 1.5, y1)
        pdf.line(x1 - 1, y2, x - 1.5, y2)
        pdf.line(x, y1, x, y2)
        for ya, s in ((y1, -1), (y2, 1)):
            pdf.polygon([(x, ya), (x - 0.7, ya + 2.2 * s), (x + 0.7, ya + 2.2 * s)], style="F")
        txt = f"{value:.1f}".rstrip("0").rstrip(".")
        pdf.set_font(font, "", 8)
        with pdf.rotation(90, x - 1.2, (y1 + y2) / 2):
            w = pdf.get_string_width(txt)
            pdf.text(x - 1.2 - w / 2, (y1 + y2) / 2, txt)

    def view(cell) -> None:
        name = cell["view"]
        cx, cy, cw, ch = cell["at"]
        pl, pr, pt, pb = cell["pads"]
        b = ext[name]
        w, h = size[name]
        k = cell["k"]
        label = cell["label"]
        if name == "iso":
            if k is None:
                k = min((cw - 8) / max(w, 1e-9), (ch - PAD_T - 4) / max(h, 1e-9))
                if abs(k - scale) > 1e-9:
                    label = "ISOMETRIC (NOT TO SCALE)"
            mid_x, mid_y = cx + cw / 2, cy + PAD_T + (ch - PAD_T - 4) / 2
        else:
            mid_x = cx + pl + (cw - pl - pr) / 2
            mid_y = cy + pt + (ch - pt - pb) / 2
        ox = mid_x - (b[0] + b[2]) / 2 * k
        oy = mid_y + (b[1] + b[3]) / 2 * k                    # the sheet's y runs down
        to = (lambda ox_, oy_, k_: (lambda x, y: (ox_ + x * k_, oy_ - y * k_)))(ox, oy, k)
        vis, hid = views[name]
        if not cell["hidden"]:
            hid = []                                  # the isometric view: hidden lines only clutter it
        pdf.set_line_width(0.13)
        pdf.set_draw_color(120)
        pdf.set_dash_pattern(dash=1.2, gap=0.8)
        for poly in hid:
            pdf.polyline([to(x, y) for x, y in poly])
        pdf.set_dash_pattern()
        pdf.set_draw_color(0)
        pdf.set_line_width(0.35)
        for poly in vis:
            pdf.polyline([to(x, y) for x, y in poly])
        # The highlighted parts over it, heavier.
        if name in lit_views:
            pdf.set_line_width(0.8)
            for poly in lit_views[name][0]:
                pdf.polyline([to(x, y) for x, y in poly])
        pdf.set_font(font, "B", 7)
        left, top = to(b[0], b[3])
        pdf.text(max(left, cx + 1) if cell["clip"] else left, max(top - 3.5, cy + 3) if cell["clip"] else top - 3.5,
                 label)
        for kind, value in cell["dims"]:
            (dim_h if kind == "h" else dim_v)(to, b, value)

    for cell in cells:
        if cell["clip"]:
            # In a state of its own: what fpdf2 thinks is set (the font, the
            # line width) is what the PDF has again after the clip.
            with pdf.local_context(), pdf.rect_clip(*cell["at"]):
                view(cell)
        else:
            view(cell)

    def fit(text: str, width: float) -> str:
        """`text`, cut with an ellipsis to fit `width` in the font set."""
        text = str(text)
        if pdf.get_string_width(text) <= width:
            return text
        while text and pdf.get_string_width(text + "…") > width:
            text = text[:-1]
        return text + "…"

    # The title block, along the foot of the sheet; its columns in the
    # proportions of A3's, across the sheet's width.
    y = sheet_h - MARGIN - TITLE_H
    pdf.set_line_width(0.5)
    pdf.line(MARGIN, y, sheet_w - MARGIN, y)
    cols = [("TITLE", spec.get("title") or title, 120), ("PROJECT", project_name, 70), ("RELEASE", tag or "-", 40),
            ("SCALE", scale_text, 30), ("UNITS", "mm", 25), ("DATE", date.today().isoformat(), 40),
            ("SHEET", "1 / 1", 75)]
    x = MARGIN
    # The columns over a row of notes across the whole width.
    split = y + 19
    for label, value, w in cols:
        w = w * aw / 400
        pdf.set_line_width(0.25)
        if x > MARGIN:
            pdf.line(x, y, x, split)
        pdf.set_font(font, "", 6.5)
        pdf.text(x + 2, y + 5, label)
        pdf.set_font(font, "B", (12 if label == "TITLE" else 10) * (1 if aw >= 400 else 0.85 if aw >= 270 else 0.7))
        pdf.text(x + 2, y + 15, fit(value, w - 4))
        x += w
    pdf.set_line_width(0.25)
    pdf.line(MARGIN, split, MARGIN + aw, split)
    pdf.set_font(font, "", 7)
    notes = [spec.get("notes") or
             f"Overall {sx:.1f} x {sy:.1f} x {sz:.1f} mm.  General tolerances ISO 2768-m unless stated.",
             f"Model {ident}  ·  source {sha[:12] or '-'}  ·  views projected from the model (Workbench)."]
    for i, line in enumerate(notes):
        pdf.text(MARGIN + 2, split + 6.5 + i * 5, fit(line, aw - 4))
    progress(95, "writing the PDF")
    pdf.output(out)
    if info:
        # The boxes as the layout editor takes them: fractions of the sheet.
        boxes = [{"view": c["view"], "x": round(c["at"][0] / sheet_w, 4), "y": round(c["at"][1] / sheet_h, 4),
                  "w": round(c["at"][2] / sheet_w, 4), "h": round(c["at"][3] / sheet_h, 4),
                  "scale": c["scale"]}
                 for c in cells]
        with open(info, "w", encoding="utf-8") as f:
            json.dump({"sheet": f"{sheet} {'landscape' if landscape else 'portrait'}", "scale": scale_text,
                       "views": [LABELS[c["view"]].title() for c in cells],
                       "size_mm": [round(sx, 2), round(sy, 2), round(sz, 2)],
                       "layout": "custom" if custom else "auto", "boxes": boxes,
                       # each view's own size at 1:1, for the layout editor's scale
                       "extents": {k: [round(w, 2), round(h, 2)] for k, (w, h) in size.items()},
                       "parts": known[:500], "unmatched": unmatched}, f)
    if png:
        progress(98, "drawing the preview")
        import fitz                                   # PyMuPDF
        with fitz.open(out) as doc:
            page = doc[0]
            pix = page.get_pixmap(matrix=fitz.Matrix(PREVIEW_W / page.rect.width, PREVIEW_W / page.rect.width),
                                  colorspace=fitz.csGRAY, alpha=False)
            pix.save(png)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step")
    ap.add_argument("out")
    ap.add_argument("--title", default="")
    ap.add_argument("--project", default="")
    ap.add_argument("--tag", default="")
    ap.add_argument("--id", default="")
    ap.add_argument("--sha", default="")
    ap.add_argument("--png", default="", help="also write a small picture of the sheet here (a preview)")
    ap.add_argument("--info", default="", help="and what the sheet holds, as JSON, here")
    ap.add_argument("--spec", default="", help="a layout for the sheet, as JSON (backend/drawlayout.py)")
    a = ap.parse_args()
    try:
        spec = None
        if a.spec:
            with open(a.spec, encoding="utf-8") as f:
                spec = json.load(f)
        draw(a.step, a.out, a.title or a.id, a.project, a.tag, a.id, a.sha, a.png, a.info, spec)
    except Exception as exc:                     # said plainly, for the release log
        sys.exit(f"drawing failed: {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
