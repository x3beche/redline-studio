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

With --svg it also writes the same sheet as an SVG, a light preview the
3D room shows before the PDF is opened (the PDF stays the drawing).
"""

from __future__ import annotations

import argparse
import math
import sys
from contextlib import contextmanager
from datetime import date
from html import escape

from fpdf import FPDF

SHEET_W, SHEET_H, MARGIN = 420.0, 297.0, 10.0
TITLE_H = 36.0
SCALES = [(10, 1), (5, 1), (2, 1), (1, 1), (1, 2), (1, 5), (1, 10), (1, 20), (1, 50), (1, 100)]


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
    """The PDF, and the same strokes and words kept as SVG elements on the
    way: only what draw() uses (lines, polylines, polygons, rectangles,
    text, a rotation), on the sheet's own millimetres."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.svg: list[str] = []
        self._ink = "#000"
        self._width = 0.2
        self._dash = ""
        self._font = (False, 8.0)
        self._turn: list[str] = []

    @staticmethod
    def _n(v: float) -> str:
        return f"{v:.1f}".rstrip("0").rstrip(".")

    def _stroke(self) -> str:
        dash = f' stroke-dasharray="{self._dash}"' if self._dash else ""
        return f'stroke="{self._ink}" stroke-width="{self._width:.2f}"{dash}'

    def set_draw_color(self, r, g=-1, b=-1):
        super().set_draw_color(r, g, b)
        g, b = (r, r) if g == -1 else (g, b)
        self._ink = "#000" if (r, g, b) == (0, 0, 0) else f"#{int(r):02x}{int(g):02x}{int(b):02x}"

    def set_line_width(self, width):
        super().set_line_width(width)
        self._width = width

    def set_dash_pattern(self, dash=0, gap=0, phase=0):
        super().set_dash_pattern(dash, gap, phase)
        self._dash = f"{self._n(dash)} {self._n(gap)}" if dash else ""

    def set_font(self, family=None, style="", size=0):
        super().set_font(family, style, size)
        self._font = ("B" in (style or "").upper(), size or self._font[1])

    def line(self, x1, y1, x2, y2):
        super().line(x1, y1, x2, y2)
        n = self._n
        self.svg.append(f'<line x1="{n(x1)}" y1="{n(y1)}" x2="{n(x2)}" y2="{n(y2)}" {self._stroke()}/>')

    def rect(self, x, y, w, h, style=None, *args, **kwargs):
        super().rect(x, y, w, h, style, *args, **kwargs)
        n = self._n
        self.svg.append(f'<rect x="{n(x)}" y="{n(y)}" width="{n(w)}" height="{n(h)}" fill="none" {self._stroke()}/>')

    def polyline(self, point_list, fill=False, polygon=False, style=None):
        super().polyline(point_list, fill=fill, polygon=polygon, style=style)
        pts = " ".join(f"{self._n(x)},{self._n(y)}" for x, y in point_list)
        if str(style or "").upper().endswith("F"):
            self.svg.append(f'<polygon points="{pts}" fill="#000"/>')
        else:
            self.svg.append(f'<{"polygon" if polygon else "polyline"} points="{pts}" fill="none" {self._stroke()}/>')

    def text(self, x, y, text=""):
        super().text(x, y, text)
        bold, size = self._font
        weight = ' font-weight="bold"' if bold else ""
        turn = f' transform="{" ".join(self._turn)}"' if self._turn else ""
        self.svg.append(f'<text x="{self._n(x)}" y="{self._n(y)}" font-size="{size * 0.3528:.2f}"'
                        f'{weight}{turn}>{escape(str(text))}</text>')

    @contextmanager
    def rotation(self, angle, x=None, y=None):
        # The PDF turns counter-clockwise; on the SVG's downward y that is minus.
        self._turn.append(f"rotate({self._n(-angle)} {self._n(x)} {self._n(y)})")
        try:
            with super().rotation(angle, x, y):
                yield
        finally:
            self._turn.pop()

    def svg_text(self) -> str:
        return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 297" width="420mm" height="297mm" '
                'font-family="Helvetica, Arial, sans-serif" stroke-linecap="round" stroke-linejoin="round">'
                '<rect width="420" height="297" fill="#fff"/>' + "".join(self.svg) + "</svg>\n")


def draw(step: str, out: str, title: str, project_name: str, tag: str, ident: str, sha: str,
         svg: str = "") -> None:
    from build123d import import_step
    shape = import_step(step)
    bb = shape.bounding_box()
    sx, sy, sz = bb.size.X, bb.size.Y, bb.size.Z

    views = {
        "FRONT": project(shape, (0, -1, 0), (0, 0, 1)),
        "TOP": project(shape, (0, 0, 1), (0, 1, 0)),
        "RIGHT": project(shape, (1, 0, 0), (0, 0, 1)),
        "ISOMETRIC": project(shape, (1, -1, 1), (0, 0, 1)),
    }
    ext = {k: bounds(v[0] + v[1]) for k, v in views.items()}
    size = {k: (b[2] - b[0], b[3] - b[1]) for k, b in ext.items()}

    # The drawing area, and a 2x2 grid of cells: FRONT | RIGHT over TOP | ISO.
    area_w = SHEET_W - 2 * MARGIN
    area_h = SHEET_H - 2 * MARGIN - TITLE_H
    cell_w, cell_h = area_w / 2 - 20, area_h / 2 - 22       # room for dimensions and labels
    need = max(max(size[k][0] for k in size) / cell_w, max(size[k][1] for k in size) / cell_h, 1e-9)
    num, den = next(((a, b) for a, b in SCALES if (a / b) <= 1 / need), SCALES[-1])
    scale = num / den

    pdf = Sheet(orientation="L", unit="mm", format="A3")
    pdf.set_auto_page_break(False)
    pdf.add_page()
    pdf.set_draw_color(0)
    pdf.set_line_width(0.5)
    pdf.rect(MARGIN, MARGIN, SHEET_W - 2 * MARGIN, SHEET_H - 2 * MARGIN)

    cells = {"FRONT": (0, 0), "RIGHT": (1, 0), "TOP": (0, 1), "ISOMETRIC": (1, 1)}
    placed = {}
    for name, (cx, cy) in cells.items():
        x0 = MARGIN + cx * area_w / 2
        y0 = MARGIN + cy * area_h / 2
        mid_x, mid_y = x0 + area_w / 4, y0 + area_h / 4 + 2
        b = ext[name]
        ox = mid_x - (b[0] + b[2]) / 2 * scale
        oy = mid_y + (b[1] + b[3]) / 2 * scale                # the sheet's y runs down
        to = (lambda ox_, oy_: (lambda x, y: (ox_ + x * scale, oy_ - y * scale)))(ox, oy)
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
        pdf.set_font("Helvetica", "B", 8)
        pdf.text(x0 + 6, y0 + 8, name)

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
        pdf.set_font("Helvetica", "", 8)
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
        pdf.set_font("Helvetica", "", 8)
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

    # The title block, along the foot of the sheet.
    y = SHEET_H - MARGIN - TITLE_H
    pdf.set_line_width(0.5)
    pdf.line(MARGIN, y, SHEET_W - MARGIN, y)
    cols = [("TITLE", title, 120), ("PROJECT", project_name, 70), ("RELEASE", tag or "-", 40),
            ("SCALE", f"{num}:{den}", 30), ("UNITS", "mm", 25), ("DATE", date.today().isoformat(), 40),
            ("SHEET", "1 / 1", 25)]
    x = MARGIN
    for label, value, w in cols:
        pdf.set_line_width(0.25)
        pdf.line(x, y, x, SHEET_H - MARGIN)
        pdf.set_font("Helvetica", "", 6.5)
        pdf.text(x + 2, y + 5, label)
        pdf.set_font("Helvetica", "B", 12 if label == "TITLE" else 10)
        pdf.text(x + 2, y + 15, str(value)[:48])
        x += w
    pdf.set_font("Helvetica", "", 7)
    notes = [f"Overall {sx:.1f} x {sy:.1f} x {sz:.1f} mm.  General tolerances ISO 2768-m unless stated.",
             f"Model {ident}  ·  source {sha[:12] or '-'}  ·  views projected from the model (Workbench)."]
    for i, line in enumerate(notes):
        pdf.text(MARGIN + 2, y + 25 + i * 5, line)
    pdf.output(out)
    if svg:
        with open(svg, "w", encoding="utf-8") as f:
            f.write(pdf.svg_text())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step")
    ap.add_argument("out")
    ap.add_argument("--title", default="")
    ap.add_argument("--project", default="")
    ap.add_argument("--tag", default="")
    ap.add_argument("--id", default="")
    ap.add_argument("--sha", default="")
    ap.add_argument("--svg", default="", help="also write the sheet as SVG here (a preview)")
    a = ap.parse_args()
    try:
        draw(a.step, a.out, a.title or a.id, a.project, a.tag, a.id, a.sha, a.svg)
    except Exception as exc:                     # said plainly, for the release log
        sys.exit(f"drawing failed: {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
