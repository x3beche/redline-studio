"""Gerbers and drills, drawn the way the room draws a board.

The parsing is gerbonara's (Apache-2.0): it reads RS-274X with its
macros and polarities, and Excellon in every dialect a board house sees.
The drawing is ours, in the colours KiCad's own SVG export uses, so an
imported board sits in the PCB room looking like one Redline laid out -
front copper C83434, back 4D7FC4, mask openings D864FF / 02FFEE at 40 %,
silkscreen F2EDA1, holes white, the edge D0D2CD - and the light theme's
ink swap (main.LIGHT_INKS) applies to it unchanged.

Each layer is painted through an SVG mask built from its own objects,
white for dark polarity and black for clear, so a pour with clearances
cut into it comes out right on any background.
"""

from __future__ import annotations

import math
import re
import tempfile
import warnings
from pathlib import Path

from .detect import Item

# KiCad's default board colours, as its SVG export writes them.
INK = {
    "top copper": "#C83434", "bottom copper": "#4D7FC4",
    "top mask": "#D864FF", "bottom mask": "#02FFEE",
    "top silk": "#F2EDA1", "bottom silk": "#E8B2A7",
    "top paste": "#B4B4B4", "bottom paste": "#00C2C2",
    "outline": "#D0D2CD", "hole": "#FFFFFF",
}
MASK_ALPHA = 0.4

# What each view is made of, bottom of the stack first.
VIEWS = {
    "front": ["top copper", "top mask", "top silk"],
    "bottom": ["bottom copper", "bottom mask", "bottom silk"],
    # Both coppers and the front silk, without the mask: the tracks to follow.
    "tracks": ["bottom copper", "top copper", "top silk"],
}


def _quiet():
    ctx = warnings.catch_warnings()
    ctx.__enter__()
    warnings.simplefilter("ignore")
    return ctx


class Board:
    """The parsed Gerber set: layers by name, drills by kind."""

    def __init__(self, items: list[Item]):
        from gerbonara import ExcellonFile, GerberFile

        self.layers: dict[str, object] = {}
        self.files: dict[str, str] = {}
        self.inner: list[object] = []
        self.drills: list[tuple[str, object, str]] = []    # (kind, file, name)
        self.problems: list[str] = []
        self.tmp = tempfile.TemporaryDirectory(prefix="x3imp-")
        ctx = _quiet()
        try:
            for it in items:
                path = Path(self.tmp.name) / re.sub(r"[^A-Za-z0-9_.-]", "_", it.base)
                path.write_bytes(it.data)
                try:
                    if it.kind == "gerber":
                        g = GerberFile.open(path)
                        if it.layer == "inner copper":
                            self.inner.append(g)
                        elif it.layer and it.layer not in self.layers:
                            self.layers[it.layer] = g
                            self.files[it.layer] = it.name
                    elif it.kind == "drill":
                        plated = {"plated": True, "via": True, "npth": False}.get(it.layer or "")
                        self.drills.append((it.layer or "mixed", ExcellonFile.open(path, plated=plated),
                                            it.name))
                except Exception as exc:                    # noqa: BLE001
                    self.problems.append(f"{it.name}: could not be read ({type(exc).__name__}: {exc})"[:200])
        finally:
            ctx.__exit__(None, None, None)

    # ---- the board's extent ----

    def outline_box(self) -> tuple[float, float, float, float] | None:
        """(x0, y0, x1, y1) in mm of the board edge, along the centre of
        the outline's strokes - a 0.254 mm pen does not make the board
        a quarter of a millimetre bigger."""
        from gerbonara import graphic_objects as go
        from gerbonara.utils import MM

        layer = self.layers.get("outline")
        if layer is None:
            return None
        xs, ys = [], []
        for obj in layer.objects:
            if isinstance(obj, (go.Line, go.Arc)):
                (bx0, by0), (bx1, by1) = obj.bounding_box(MM)
                try:
                    half = obj.aperture.equivalent_width(MM) / 2
                except Exception:                            # noqa: BLE001
                    half = 0.0
                xs += [bx0 + half, bx1 - half]
                ys += [by0 + half, by1 - half]
            elif isinstance(obj, go.Region):
                (bx0, by0), (bx1, by1) = obj.bounding_box(MM)
                xs += [bx0, bx1]
                ys += [by0, by1]
        if not xs:
            return None
        return min(xs), min(ys), max(xs), max(ys)

    def box(self) -> tuple[float, float, float, float]:
        got = self.outline_box()
        if got:
            return got
        from gerbonara.utils import MM, sum_bounds
        bounds = sum_bounds([l.bounding_box(MM, default=None) for l in self.layers.values()
                             if l is not None and l.objects], default=((0, 0), (0, 0)))
        (x0, y0), (x1, y1) = bounds
        return x0, y0, x1, y1

    # ---- drawing ----

    def _objects(self, layer, fg: str, bg: str) -> str:
        from gerbonara.utils import MM
        return "\n".join(str(t) for t in layer.svg_objects(svg_unit=MM, fg=fg, bg=bg))

    def svg(self, view: str, margin: float = 1.0) -> str | None:
        """One view of the board as SVG in millimetres, y down like KiCad's,
        the back mirrored as you see it from below."""
        names = [n for n in VIEWS[view] if n in self.layers]
        if not names and "outline" not in self.layers:
            return None
        x0, y0, x1, y1 = self.box()
        w, h = x1 - x0 + 2 * margin, y1 - y0 + 2 * margin
        vx, vy = x0 - margin, -(y1 + margin)
        # Gerber y is up; SVG's is down. The flip happens once, here.
        flip = "scale(1 -1)"
        if view == "bottom":
            flip = f"translate({2 * vx + w:.4f} 0) scale(-1 -1)"
        defs, body = [], []
        for name in names:
            mid = "m-" + name.replace(" ", "-")
            objs = self._objects(self.layers[name], "white", "black")
            defs.append(f'<mask id="{mid}" maskUnits="userSpaceOnUse" x="{vx:.4f}" y="{vy:.4f}" '
                        f'width="{w:.4f}" height="{h:.4f}"><g transform="{flip}" fill="white" '
                        f'stroke-linecap="round" stroke-linejoin="round">{objs}</g></mask>')
            # A mask layer's dark is where the mask is not - the openings,
            # drawn over the copper at KiCad's 40 %.
            alpha = f' fill-opacity="{MASK_ALPHA}"' if name.endswith("mask") else ""
            body.append(f'<rect x="{vx:.4f}" y="{vy:.4f}" width="{w:.4f}" height="{h:.4f}" '
                        f'fill="{INK[name]}"{alpha} mask="url(#{mid})"/>')
        holes = self.hole_marks()
        if holes:
            body.append(f'<g transform="{flip}" fill="{INK["hole"]}">{holes}</g>')
        if "outline" in self.layers:
            # The edge as it was drawn, stroke for stroke. Chaining it into
            # one closed path is guesswork on a real board's outline (a
            # tangent arc, a stray short segment) and a wrong guess draws a
            # line across the board.
            objs = self._objects(self.layers["outline"], INK["outline"], "none")
            body.append(f'<g transform="{flip}" fill="none" stroke-linecap="round">{objs}</g>')
        return (f'<?xml version="1.0" encoding="utf-8"?>\n'
                f'<svg xmlns="http://www.w3.org/2000/svg" version="1.1" '
                f'width="{w:.4f}mm" height="{h:.4f}mm" viewBox="{vx:.4f} {vy:.4f} {w:.4f} {h:.4f}">\n'
                f'<title>{view}</title>\n<defs>{"".join(defs)}</defs>\n' + "\n".join(body) + "\n</svg>\n")

    def hole_marks(self) -> str:
        from gerbonara import graphic_objects as go
        from gerbonara.utils import MM
        out = []
        for _kind, f, _name in self.drills:
            for obj in f.objects:
                try:
                    d = obj.tool.equivalent_width(MM)
                except Exception:                            # noqa: BLE001
                    continue
                if isinstance(obj, go.Flash):
                    x, y = MM(obj.x, obj.unit), MM(obj.y, obj.unit)
                    out.append(f'<circle cx="{x:.4f}" cy="{y:.4f}" r="{d / 2:.4f}"/>')
                elif isinstance(obj, go.Line):
                    x1, y1 = MM(obj.x1, obj.unit), MM(obj.y1, obj.unit)
                    x2, y2 = MM(obj.x2, obj.unit), MM(obj.y2, obj.unit)
                    out.append(f'<path d="M{x1:.4f} {y1:.4f}L{x2:.4f} {y2:.4f}" fill="none" '
                               f'stroke="{INK["hole"]}" stroke-width="{d:.4f}" stroke-linecap="round"/>')
        return "".join(out)

    def layer_svg(self, name: str, margin: float = 2.0) -> str | None:
        """One layer on its own, dark on white, for the printed set."""
        layer = self.layers.get(name)
        if layer is None:
            return None
        x0, y0, x1, y1 = self.box()
        w, h = x1 - x0 + 2 * margin, y1 - y0 + 2 * margin
        vx, vy = x0 - margin, -(y1 + margin)
        objs = self._objects(layer, "black", "white")
        edge = ""
        if name != "outline" and "outline" in self.layers:
            edge = f'<g fill="none">{self._objects(self.layers["outline"], "grey", "none")}</g>'
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vx:.4f} {vy:.4f} {w:.4f} {h:.4f}" '
                f'width="100%" height="100%"><rect x="{vx:.4f}" y="{vy:.4f}" width="{w:.4f}" '
                f'height="{h:.4f}" fill="white"/><g transform="scale(1 -1)" stroke-linecap="round" '
                f'stroke-linejoin="round">{edge}{objs}</g></svg>')

    def drills_svg(self, margin: float = 2.0) -> str | None:
        if not self.drills:
            return None
        x0, y0, x1, y1 = self.box()
        w, h = x1 - x0 + 2 * margin, y1 - y0 + 2 * margin
        vx, vy = x0 - margin, -(y1 + margin)
        edge = (f'<g fill="none">{self._objects(self.layers["outline"], "grey", "none")}</g>'
                if "outline" in self.layers else "")
        holes = self.hole_marks().replace(INK["hole"], "black")
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vx:.4f} {vy:.4f} {w:.4f} {h:.4f}" '
                f'width="100%" height="100%"><rect x="{vx:.4f}" y="{vy:.4f}" width="{w:.4f}" '
                f'height="{h:.4f}" fill="white"/><g transform="scale(1 -1)" fill="black">{edge}{holes}</g></svg>')

    # ---- figures ----

    @staticmethod
    def _spot(obj) -> tuple:
        from gerbonara.utils import MM
        return (round(MM(obj.x, obj.unit), 3), round(MM(obj.y, obj.unit), 3))

    def _via_spots(self) -> set:
        from gerbonara import graphic_objects as go
        return {self._spot(o) for kind, f, _ in self.drills if kind == "via"
                for o in f.objects if isinstance(o, go.Flash)}

    def drill_table(self) -> list[dict]:
        """One row per tool: size, plated or not, holes and slots, file."""
        from gerbonara import graphic_objects as go
        from gerbonara.utils import MM
        rows: dict[tuple, dict] = {}
        vias = self._via_spots()
        for kind, f, name in self.drills:
            for obj in f.objects:
                if kind != "via" and isinstance(obj, go.Flash) and self._spot(obj) in vias:
                    continue          # EasyEDA lists each via in the PTH file as well
                try:
                    d = round(obj.tool.equivalent_width(MM), 3)
                except Exception:                            # noqa: BLE001
                    continue
                plated = obj.tool.plated if obj.tool.plated is not None else kind != "npth"
                key = (d, bool(plated), kind == "via", name)
                row = rows.setdefault(key, {"diameter_mm": d, "plated": bool(plated),
                                            "via": kind == "via", "holes": 0, "slots": 0,
                                            "file": name})
                if isinstance(obj, go.Flash):
                    row["holes"] += 1
                else:
                    row["slots"] += 1
        return sorted(rows.values(), key=lambda r: (not r["plated"], r["via"], r["diameter_mm"]))

    def copper_stats(self) -> dict:
        """Tracks, vias and copper length, as far as Gerbers say: a track
        is a stroked line on a copper layer, a via a hole in a via file."""
        from gerbonara import graphic_objects as go
        from gerbonara.utils import MM
        tracks, length = 0, 0.0
        for name in ("top copper", "bottom copper"):
            layer = self.layers.get(name)
            if layer is None:
                continue
            for obj in layer.objects:
                if isinstance(obj, go.Line) and obj.polarity_dark:
                    tracks += 1
                    length += math.dist((MM(obj.x1, obj.unit), MM(obj.y1, obj.unit)),
                                        (MM(obj.x2, obj.unit), MM(obj.y2, obj.unit)))
                elif isinstance(obj, go.Arc) and obj.polarity_dark:
                    tracks += 1
                    try:
                        length += obj.as_primitive(MM).length if hasattr(obj.as_primitive(MM), "length") else 0
                    except Exception:                        # noqa: BLE001
                        pass
        vias = sum(1 for kind, f, _ in self.drills if kind == "via"
                   for o in f.objects if isinstance(o, go.Flash))
        return {"tracks": tracks, "vias": vias if any(k == "via" for k, _, _ in self.drills) else None,
                "length_mm": round(length, 1)}

    def close(self) -> None:
        self.tmp.cleanup()


PRINTED = [("top copper", "Top copper"), ("bottom copper", "Bottom copper"),
           ("top mask", "Top solder mask"), ("bottom mask", "Bottom solder mask"),
           ("top silk", "Top silkscreen"), ("bottom silk", "Bottom silkscreen"),
           ("top paste", "Top paste"), ("bottom paste", "Bottom paste"),
           ("outline", "Board outline")]


def layer_pages(board: Board, title: str) -> str:
    """The printed set as one HTML document, a layer to a page - Chrome
    prints it to the layer PDF."""
    x0, y0, x1, y1 = board.box()
    pages = []
    for key, label in PRINTED:
        svg = board.layer_svg(key)
        if svg:
            pages.append((label, board.files.get(key, ""), svg))
    drills = board.drills_svg()
    if drills:
        pages.append(("Drills", ", ".join(n for _, _, n in board.drills), drills))
    esc = lambda s: (s or "").replace("&", "&amp;").replace("<", "&lt;")  # noqa: E731
    body = "".join(
        f'<section><header><b>{esc(label)}</b><span>{esc(title)} &middot; {esc(src)} &middot; '
        f'{x1 - x0:.2f} &times; {y1 - y0:.2f} mm</span></header><div class="fig">{svg}</div></section>'
        for label, src, svg in pages)
    return ("<!doctype html><html><head><meta charset='utf-8'><style>"
            "@page{size:A4 landscape;margin:10mm}body{margin:0;font:11px sans-serif;color:#222}"
            "section{page-break-after:always;height:185mm;display:flex;flex-direction:column}"
            "header{display:flex;justify-content:space-between;border-bottom:1px solid #999;"
            "padding-bottom:2mm;margin-bottom:3mm}.fig{flex:1;min-height:0}"
            "svg{width:100%;height:100%}</style></head><body>" + body + "</body></html>")
