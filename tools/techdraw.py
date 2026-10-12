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
"""

from __future__ import annotations

import argparse
import json
import math
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
# A Unicode font, for names in Turkish and the like (fonts-dejavu-core in
# docker/draw); Helvetica where it is not installed.
DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans{}.ttf"
PREVIEW_W = 480                                   # px, the preview's width
SCALES = [(10, 1), (5, 1), (2, 1), (1, 1), (1, 2), (1, 5), (1, 10), (1, 20), (1, 50), (1, 100)]


def progress(pct: int, stage: str) -> None:
    """A line the caller follows (backend/release.py): how far, and the
    step now under way."""
    print(f"@progress {pct} {stage}", flush=True)


def project(shape, direction, up):
    """Visible and hidden edges of `shape` seen along -direction, as 2D
    polylines in the view's own coordinates."""
    from build123d import Vector
    bb = shape.bounding_box()
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


def layout(size: dict, sheet: str):
    """The largest standard scale at which the views fit `sheet` in the
    usual arrangement - FRONT with RIGHT beside it, TOP under FRONT, the
    isometric view in the corner left - each column as wide and each row as
    tall as its views (and their dimensions) need. (num, den, cells) or
    None if it fits at no scale."""
    sw, sh = SHEETS[sheet]
    aw, ah = sw - 2 * MARGIN, sh - 2 * MARGIN - TITLE_H
    (wf, hf), (wt, ht), (wr, hr) = size["FRONT"], size["TOP"], size["RIGHT"]
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
         png: str = "", info: str = "") -> None:
    progress(2, "reading the STEP")
    from build123d import import_step
    shape = import_step(step)
    bb = shape.bounding_box()
    sx, sy, sz = bb.size.X, bb.size.Y, bb.size.Z

    # Projecting is nearly all of the time; the isometric view, with every
    # edge seen at a slant, the longest.
    views = {}
    for name, at, direction, up in (("FRONT", 10, (0, -1, 0), (0, 0, 1)), ("TOP", 30, (0, 0, 1), (0, 1, 0)),
                                    ("RIGHT", 48, (1, 0, 0), (0, 0, 1)), ("ISOMETRIC", 64, (1, -1, 1), (0, 0, 1))):
        progress(at, f"projecting the {name.lower()} view")
        views[name] = project(shape, direction, up)
    progress(90, "laying out the sheet")
    ext = {k: bounds(v[0] + v[1]) for k, v in views.items()}
    size = {k: (b[2] - b[0], b[3] - b[1]) for k, b in ext.items()}

    sheet, (num, den, (aw, ah, c1, c2, r1, r2)) = pick(size)
    scale = num / den
    sheet_w, sheet_h = SHEETS[sheet]
    # What the columns and rows leave over: a little between them (views in
    # projection stay close), the rest evenly around.
    sx_, sy_ = max(0.0, aw - c1 - c2), max(0.0, ah - r1 - r2)
    bx, by = min(sx_ / 3, 12.0), min(sy_ / 3, 8.0)
    x1, y1 = MARGIN + (sx_ - bx) / 2, MARGIN + (sy_ - by) / 2
    x2, y2 = x1 + c1 + bx, y1 + r1 + by
    cells = {"FRONT": (x1, y1, c1, r1), "RIGHT": (x2, y1, c2, r1), "TOP": (x1, y2, c1, r2),
             # the isometric view: the rest of the sheet, to its own scale
             "ISOMETRIC": (x2, y2, MARGIN + aw - x2, MARGIN + ah - y2)}

    pdf = Sheet(orientation="L", unit="mm", format=sheet)
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

    placed = {}
    for name, (cx, cy, cw, ch) in cells.items():
        b = ext[name]
        w, h = size[name]
        k = scale
        label = name
        if name == "ISOMETRIC":
            k = min((cw - 8) / max(w, 1e-9), (ch - PAD_T - 4) / max(h, 1e-9))
            if abs(k - scale) > 1e-9:
                label = "ISOMETRIC (NOT TO SCALE)"
            mid_x, mid_y = cx + cw / 2, cy + PAD_T + (ch - PAD_T - 4) / 2
        else:
            mid_x = cx + PAD_L + (cw - PAD_L - PAD_R) / 2
            mid_y = cy + PAD_T + (ch - PAD_T - PAD_B) / 2
        ox = mid_x - (b[0] + b[2]) / 2 * k
        oy = mid_y + (b[1] + b[3]) / 2 * k                    # the sheet's y runs down
        to = (lambda ox_, oy_, k_: (lambda x, y: (ox_ + x * k_, oy_ - y * k_)))(ox, oy, k)
        placed[name] = (to, b)
        vis, hid = views[name]
        if name == "ISOMETRIC":
            hid = []                                  # a picture of the whole: hidden lines only clutter it
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
        pdf.set_font(font, "B", 7)
        left, top = to(b[0], b[3])
        pdf.text(left, top - 3.5, label)

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

    to, b = placed["FRONT"]
    dim_h(to, b, sx)
    dim_v(to, b, sz)
    to, b = placed["RIGHT"]
    dim_h(to, b, sy)
    to, b = placed["TOP"]
    dim_v(to, b, sy)

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
    cols = [("TITLE", title, 120), ("PROJECT", project_name, 70), ("RELEASE", tag or "-", 40),
            ("SCALE", f"{num}:{den}", 30), ("UNITS", "mm", 25), ("DATE", date.today().isoformat(), 40),
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
        pdf.set_font(font, "B", (12 if label == "TITLE" else 10) * (1 if sheet == "A3" else 0.85))
        pdf.text(x + 2, y + 15, fit(value, w - 4))
        x += w
    pdf.set_line_width(0.25)
    pdf.line(MARGIN, split, MARGIN + aw, split)
    pdf.set_font(font, "", 7)
    notes = [f"Overall {sx:.1f} x {sy:.1f} x {sz:.1f} mm.  General tolerances ISO 2768-m unless stated.",
             f"Model {ident}  ·  source {sha[:12] or '-'}  ·  views projected from the model (Workbench)."]
    for i, line in enumerate(notes):
        pdf.text(MARGIN + 2, split + 6.5 + i * 5, fit(line, aw - 4))
    progress(95, "writing the PDF")
    pdf.output(out)
    if info:
        with open(info, "w", encoding="utf-8") as f:
            json.dump({"sheet": f"{sheet} landscape", "scale": f"{num}:{den}", "views": [v.title() for v in cells],
                       "size_mm": [round(sx, 2), round(sy, 2), round(sz, 2)]}, f)
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
    a = ap.parse_args()
    try:
        draw(a.step, a.out, a.title or a.id, a.project, a.tag, a.id, a.sha, a.png, a.info)
    except Exception as exc:                     # said plainly, for the release log
        sys.exit(f"drawing failed: {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
