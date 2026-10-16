"""The drawings a part makes (backend/pdfparts.py).

A part that can draw, draws: a bit lane for a register, a proportional bar for a
memory map or a budget, a ladder for interrupt priorities, a chain for the
network's hops, a card for a calculation. Inline SVG, no dependency and nothing
fetched - Chromium in the PDF's own container prints it, and the theme's
colours come through as CSS variables, so a drawing is the document's own.

Everything here is given rows (the values the model supplied) and returns the
body of a figure; `pdfparts` wraps it with the part's caption and note.
"""

from __future__ import annotations
import re

import html

# A small, fixed palette: the first is the part's own, the rest mark the
# others. Nothing here is a literal document colour - the theme's variables are.
SERIES = ("var(--accent)", "#7a5cc4", "#0f8a7a", "#c07a12", "#3f6ea8", "#8a4f7d", "#5d7a2f", "var(--ink-faint)")
_OK, _WARN, _BAD = "var(--ok)", "var(--warn)", "var(--danger)"


def _e(v) -> str:
    return html.escape("" if v is None else str(v), quote=True)


def _s(v, n: int = 200) -> str:
    return " ".join(str(v if v is not None else "").split())[:n]


def _num(v) -> float | None:
    try:
        return float("".join(c for c in _s(v, 40).replace(",", ".") if c in "0123456789.-+eE"))
    except ValueError:
        return None


# A figure is drawn to be read on paper: it fills its page rather than sitting
# at the top of it. `fill` spreads the rows over the height a printed page has.
PAGE = 1280.0


def fill(rows: int, base: float, top: float = 60.0) -> float:
    """The height a row gets so `rows` of them reach the page's height."""
    return max(base, (PAGE - top) / max(1, rows))


# The drawings are authored in a space 1000 units wide and printed into a text
# column of ~482pt, so everything lands at ~0.48x: a 10.6 unit label comes out
# at 5pt and a hairline at a third of a point. TYPE pays that back - the type,
# and the strokes with it - and PAGE is the height a figure reaches when it is
# given the page, which is what a printed drawing is for.
TYPE = 2.05
_STROKE = re.compile(r'stroke-width="([0-9.]+)"')


def _thicker(body: str) -> str:
    return _STROKE.sub(lambda m: f'stroke-width="{float(m.group(1)) * TYPE:g}"', body)


def svg(w: float, h: float, body: str, cls: str = "") -> str:
    """One drawing: a viewBox that scales to the page's width."""
    return (f'<svg class="p-svg {cls}" viewBox="0 0 {w:g} {h:g}" width="100%" height="{h:g}" '
            f'preserveAspectRatio="xMidYMin meet" role="img">{_thicker(body)}</svg>')


def _text(x: float, y: float, s: str, size: float = 7.4, anchor: str = "start", fill: str = "var(--ink)",
          weight: int = 400, mono: bool = False) -> str:
    extra = ' class="mono"' if mono else ""
    return (f'<text{extra} x="{x:g}" y="{y:g}" font-size="{size * TYPE:g}" text-anchor="{anchor}" '
            f'font-weight="{weight}" fill="{fill}">{_e(s)}</text>')


# ---------------------------------------------------------------- bit lanes

def bits(value_range: str, width: int = 16) -> tuple[int, int] | None:
    """A field's bit range as (low, high): "7:4", "3", "15:0"."""
    t = _s(value_range, 20).replace(" ", "")
    if not t:
        return None
    if ":" in t:
        a, _, b = t.partition(":")
        hi, lo = _num(a), _num(b)
        if hi is None or lo is None:
            return None
        return (int(min(hi, lo)), int(max(hi, lo)))
    n = _num(t)
    return (int(n), int(n)) if n is not None else None


def lanes(blocks: list[tuple[str, list[tuple[int, int, str, str]]]], width: int = 16) -> str:
    """Bit lanes: one row per register, its fields as segments over a bit ruler,
    the field's name and how it is reached written in the segment - the drawing
    a bitfield tool shows, kept as SVG so it prints."""
    row_h = fill(len(blocks), 78.0, 20.0)
    lane_h = row_h * 0.68
    w = 1000.0
    h = 16 + len(blocks) * row_h
    out = []
    for i, (name, fields) in enumerate(blocks):
        y = 14 + i * row_h
        out.append(_text(0, y, _s(name, 40), 11.0, weight=700))
        out.append(_text(w, y, f"0x{0:0{max(4, width // 4)}X} .. {hex((1 << width) - 1)}", 9.0, "end",
                         "var(--ink-faint)", mono=True))
        ly = y + 8
        out.append(f'<rect x="0" y="{ly:g}" width="{w:g}" height="{lane_h:g}" rx="3" fill="var(--wash)" '
                   f'stroke="var(--line)" stroke-width="0.8"/>')
        for j, (low, high, label, extra) in enumerate(fields):
            x0, x1 = w * low / width, w * (high + 1) / width
            colour = SERIES[j % len(SERIES)]
            out.append(f'<rect x="{x0:g}" y="{ly:g}" width="{max(1.0, x1 - x0):g}" height="{lane_h:g}" rx="2" '
                       f'fill="{colour}" opacity="0.30"/>')
            out.append(f'<line x1="{x0:g}" y1="{ly:g}" x2="{x0:g}" y2="{ly + lane_h:g}" stroke="{colour}" '
                       f'stroke-width="1.1"/>')
            out.append(f'<line x1="{x1:g}" y1="{ly:g}" x2="{x1:g}" y2="{ly + lane_h:g}" stroke="{colour}" '
                       f'stroke-width="1.1"/>')
            mid = (x0 + x1) / 2
            bits_txt = str(low) if low == high else f"{high}:{low}"
            out.append(_text(mid, ly + 17, bits_txt, 10.0, "middle", colour, 700, mono=True))
            out.append(_text(mid, ly + 30, _s(label, 22), 10.5, "middle", "var(--ink)", 600))
            out.append(_text(mid, ly + 43, _s(extra, 34), 8.6, "middle", "var(--ink-dim)"))
        for b in range(width + 1):
            x = w * b / width
            tall = b % 4 == 0
            out.append(f'<line x1="{x:g}" y1="{ly + lane_h:g}" x2="{x:g}" y2="{ly + lane_h + (7 if tall else 4):g}" '
                       f'stroke="var(--line-faint, var(--line))" stroke-width="0.7"/>')
            if tall:
                out.append(_text(x, ly + lane_h + 18, str(b), 8.6, "middle", "var(--ink-faint)", mono=True))
    return svg(1000, h, "".join(out))


def bytelanes(rows: list[dict]) -> str:
    """A frame, byte by byte: each field a box over a byte ruler."""
    total = max(8, len(rows) + 2)
    w, box_h, gap = 1000.0, 34.0, 30.0
    h = 40 + box_h + 24
    out, x = [], 0.0
    step = w / total
    out.append(_text(0, 10, "byte", 7.0, weight=600))
    for r in rows:
        span = _s(r.get("bytes"), 12)
        parts = span.split("-") if "-" in span else [span, span]
        try:
            a, b = int(float(parts[0])), int(float(parts[-1]))
        except ValueError:
            a = b = 0
        n = max(1, b - a + 1)
        x0, x1 = a * step, (a + n) * step
        out.append(f'<rect x="{x0:g}" y="18" width="{max(6, x1 - x0 - 2):g}" height="{box_h:g}" rx="2" '
                   f'fill="{SERIES[0]}" opacity="0.12" stroke="{SERIES[0]}" stroke-width="0.6"/>')
        out.append(_text((x0 + x1) / 2, 32, _s(r.get("field"), 22), 6.8, "middle", "var(--ink)", 600))
        out.append(_text((x0 + x1) / 2, 42, _s(r.get("bits") or "", 12), 6.2, "middle", "var(--ink-dim)", mono=True))
        out.append(_text((x0 + x1) / 2, 56, _s(r.get("values"), 30), 6.0, "middle", "var(--ink-faint)"))
    for b in range(total + 1):
        xb = b * step
        out.append(f'<line x1="{xb:g}" y1="18" x2="{xb:g}" y2="{18 + box_h + 14:g}" stroke="var(--line)" stroke-width="0.5"/>')
        if b % 4 == 0:
            out.append(_text(xb, 18 + box_h + 24, str(b), 6.2, "middle", "var(--ink-faint)", mono=True))
    return svg(1000, h, "".join(out))


# ---------------------------------------------------------------- bars

def regions(rows: list[dict], key_from: str, key_size: str, key_label: str, unit: str = "") -> str:
    """A memory, a flash, an address space: one bar, each row's share of it,
    with the shares under it as a legend and the total at the end."""
    total = sum((_num(r.get(key_size)) or 0) for r in rows) or 1
    legend = fill(len(rows), 26.0, 110.0)
    w, bar_h = 1000.0, max(58.0, legend * 1.6)
    h = 10 + bar_h + 34 + len(rows) * legend
    out, x = [], 0.0
    for i, r in enumerate(rows):
        share = (_num(r.get(key_size)) or 0) / total
        colour = SERIES[i % len(SERIES)]
        out.append(f'<rect x="{x * w:g}" y="8" width="{max(0.8, share * w):g}" height="{bar_h:g}" '
                   f'fill="{colour}" opacity="0.28" stroke="{colour}" stroke-width="0.7"/>')
        if share > 0.08:
            out.append(_text(x * w + share * w / 2, 10 + bar_h / 2 + 4, f"{share * 100:.0f}%", 13.0, "middle",
                             "var(--ink)", 700, mono=True))
        x += share
    out.append(_text(0, 8 + bar_h + 14, _s(rows[0].get(key_from) or "", 24), 8.0, mono=True))
    out.append(_text(w, 8 + bar_h + 14, f"total {total:g} {unit}".strip(), 8.0, "end", "var(--ink-dim)", mono=True))
    y = 8 + bar_h + 34
    for i, r in enumerate(rows):
        colour = SERIES[i % len(SERIES)]
        share = (_num(r.get(key_size)) or 0) / total
        out.append(f'<rect x="0" y="{y - 8:g}" width="9" height="9" fill="{colour}" opacity="0.7"/>')
        out.append(_text(16, y, _s(r.get(key_label), 34), 11.5, weight=700))
        out.append(_text(360, y, f"{_s(r.get(key_size), 12)} {unit}".strip(), 11.0, mono=True))
        out.append(_text(480, y, f"{share * 100:.1f} %", 11.0, "start", "var(--ink-dim)", mono=True))
        out.append(_text(580, y, _s(r.get("what") or r.get("use") or r.get("type") or r.get("note") or "", 70), 10.5,
                         "start", "var(--ink-dim)"))
        y += legend
    return svg(1000, y, "".join(out))


def bars(rows: list[dict], what_key: str, value_key: str, unit: str = "", limit_key: str | None = None,
         total: float | None = None, ref: float | None = None) -> str:
    """Bars against a scale, with the scale drawn: a budget, a stack, a
    measurement with its limit. The bar is the value, the dashed line the limit
    or what was allocated, and what is left of it is written beside - the
    reader can hold the number against the axis rather than trust a length."""
    values = [abs(_num(r.get(value_key)) or 0) for r in rows]
    if limit_key:
        values += [abs(_num(r.get(limit_key)) or 0) for r in rows]
    scale = max(values + [abs(_num(total) or 0), abs(_num(ref) or 0), 1.0])
    x0, x1, name_w = 170.0, 850.0, 158.0          # the plot, and the name column
    row_h = fill(len(rows), 46.0, 60.0)
    bar_h = row_h * 0.5
    h = 46 + len(rows) * row_h + 8
    out = []
    # the axis: four gridlines, their values, the unit at the left
    for i in range(5):
        x = x0 + (x1 - x0) * i / 4
        out.append(f'<line x1="{x:g}" y1="24" x2="{x:g}" y2="{24 + len(rows) * row_h:g}" '
                   f'stroke="var(--line)" stroke-width="0.4" stroke-dasharray="{2 if i else 0} {2 if i else 0}"/>')
        out.append(_text(x, 17, f"{scale * i / 4:g}", 8.0, "middle", "var(--ink-faint)", mono=True))
    out.append(_text(x1, 17, _s(unit, 10), 8.0, "start", "var(--ink-dim)"))
    for i, r in enumerate(rows):
        v = _num(r.get(value_key))
        y = 26 + i * row_h
        out.append(_text(name_w, y + bar_h - 6, _s(r.get(what_key), 26), 11.0, weight=600))
        out.append(f'<rect x="{x0:g}" y="{y:g}" width="{x1 - x0:g}" height="{bar_h:g}" fill="var(--wash)"/>')
        if v is not None:
            frac = min(1.0, abs(v) / scale) if scale else 0
            colour = SERIES[i % len(SERIES)]
            lim = _num(r.get(limit_key)) if limit_key else None
            if lim is not None and abs(v) > abs(lim):
                colour = _BAD
            bar_w = (x1 - x0) * frac
            out.append(f'<rect x="{x0:g}" y="{y:g}" width="{bar_w:g}" height="{bar_h:g}" fill="{colour}" opacity="0.45"/>')
            # the value at the bar's end, inside it when it fits
            label = f"{_s(r.get(value_key), 12)} {unit}".strip()
            if bar_w > 90:
                out.append(_text(x0 + bar_w - 8, y + bar_h - 7, label, 10.5, "end", "var(--ink)", 700, mono=True))
            else:
                out.append(_text(x0 + bar_w + 8, y + bar_h - 7, label, 10.5, "start", "var(--ink)", 700, mono=True))
        if limit_key:
            lim = _num(r.get(limit_key))
            if lim is not None:
                lx = x0 + (x1 - x0) * min(1.0, abs(lim) / scale)
                out.append(f'<line x1="{lx:g}" y1="{y - 3:g}" x2="{lx:g}" y2="{y + bar_h + 3:g}" '
                           f'stroke="var(--ink-faint)" stroke-width="0.8" stroke-dasharray="3 2"/>')
                out.append(_text(lx, y + bar_h + 10, f"limit {_s(r.get(limit_key), 10)}", 7.2, "middle",
                                 "var(--ink-faint)", mono=True))
                if v is not None:
                    margin = abs(lim) - abs(v)
                    out.append(_text(1000, y + bar_h - 7, f"{margin:+.3g}".rstrip("0").rstrip("."), 10.5, "end",
                                     _OK if margin >= 0 else _BAD, 700, mono=True))
        else:
            out.append(_text(880, y + bar_h - 7, _s(r.get("share") or "", 8), 10.0, "start", "var(--ink-dim)", mono=True))
            out.append(_text(1000, y + bar_h - 7, _s(r.get("note") or "", 30), 9.0, "end", "var(--ink-faint)"))
    if total is not None:
        x = x0 + (x1 - x0) * min(1.0, abs(_num(total) or 0) / scale)
        out.append(f'<line x1="{x:g}" y1="24" x2="{x:g}" y2="{24 + len(rows) * row_h:g}" stroke="var(--ink)" '
                   f'stroke-width="1" stroke-dasharray="4 2"/>')
        out.append(_text(x + 4, 36, f"total {_s(total, 12)} {unit}".strip(), 8.0, "start", "var(--ink)", 600, mono=True))
    if ref is not None:
        x = x0 + (x1 - x0) * min(1.0, abs(_num(ref) or 0) / scale)
        out.append(f'<line x1="{x:g}" y1="24" x2="{x:g}" y2="{24 + len(rows) * row_h:g}" stroke="{_WARN}" '
                   f'stroke-width="1"/>')
        out.append(_text(x + 4, 48, f"over {_s(ref, 8)}", 8.0, "start", _WARN, 600, mono=True))
    return svg(1000, h, "".join(out))


def ladder(rows: list[dict], key_irq: str, key_pri: str, key_rate: str = "", key_what: str = "") -> str:
    """Interrupts as a ladder: the number on the left, the priority as how high
    the rung sits, the handler on the line."""
    pris = [(i, _num(r.get(key_pri))) for i, r in enumerate(rows)]
    vals = [p for _, p in pris if p is not None] or [1]
    lo, hi = min(vals), max(vals)
    span = (hi - lo) or 1
    row_h = fill(len(rows), 34.0, 24.0)
    w = 1000.0
    h = 16 + len(rows) * row_h
    out = []
    out.append(f'<line x1="44" y1="6" x2="44" y2="{h - 6:g}" stroke="var(--line)" stroke-width="0.8"/>')
    out.append(_text(38, 8, "soon", 6.2, "end", "var(--ink-faint)"))
    out.append(_text(38, h - 4, "later", 6.2, "end", "var(--ink-faint)"))
    for i, r in enumerate(rows):
        p = _num(r.get(key_pri)) or 0
        y = 12 + i * row_h
        frac = 1 - (p - lo) / span if hi != lo else 0.5
        colour = SERIES[int(p) % len(SERIES)] if p else SERIES[0]
        out.append(f'<rect x="34" y="{y - 7:g}" width="20" height="{row_h - 8:g}" rx="2" fill="{colour}" opacity="0.18" '
                   f'stroke="{colour}" stroke-width="0.6"/>')
        out.append(_text(44, y + 3, _s(r.get(key_pri), 6), 7.0, "middle", "var(--ink)", 600, mono=True))
        out.append(f'<line x1="58" y1="{y - 1:g}" x2="{58 - 0:g}" y2="{y - 1:g}" stroke="{colour}" stroke-width="0.6"/>')
        out.append(f'<line x1="46" y1="{4 + frac * (h - 30):g}" x2="58" y2="{y - 1:g}" stroke="{colour}" '
                   f'stroke-width="0.5" opacity="0.6"/>')
        out.append(_text(64, y + 3, _s(r.get(key_irq), 34), 7.0, weight=600))
        out.append(_text(360, y + 3, _s(r.get("handler") or r.get("vector") or "", 40), 6.8, mono=True))
        out.append(_text(560, y + 3, _s(r.get("source") or "", 30), 6.6, "start", "var(--ink-dim)"))
        out.append(_text(680, y + 3, _s(r.get(key_rate) if key_rate else r.get("rate") or "", 30), 6.6, "start",
                         "var(--ink-dim)"))
        out.append(_text(820, y + 3, _s(r.get(key_what) if key_what else r.get("what") or "", 44), 6.6, "start",
                         "var(--ink-dim)"))
    return svg(1000, h, "".join(out))


def chain(rows: list[dict], key_label: str, key_sub: str = "", key_what: str = "") -> str:
    """Hops, links, drives: a row of boxes with arrows between them."""
    w, box_w, h = 1000.0, 0.0, 62.0
    n = max(1, len(rows))
    gap = 26.0
    box_w = (w - gap * (n - 1)) / n
    out = []
    for i, r in enumerate(rows):
        x = i * (box_w + gap)
        colour = SERIES[i % len(SERIES)]
        out.append(f'<rect x="{x:g}" y="8" width="{box_w:g}" height="30" rx="3" fill="{colour}" opacity="0.12" '
                   f'stroke="{colour}" stroke-width="0.6"/>')
        out.append(_text(x + box_w / 2, 22, _s(r.get(key_label), 30), 7.2, "middle", "var(--ink)", 600))
        out.append(_text(x + box_w / 2, 32, _s(r.get(key_sub), 34), 6.4, "middle", "var(--ink-dim)", mono=True))
        out.append(_text(x + box_w / 2, 48, _s(r.get(key_what), 34), 6.2, "middle", "var(--ink-faint)"))
        if i:
            out.append(f'<line x1="{x - gap + 2:g}" y1="23" x2="{x - 2:g}" y2="23" stroke="var(--ink-faint)" '
                       f'stroke-width="0.8"/>')
            out.append(f'<path d="M{x - 6:g} 20 L{x - 1:g} 23 L{x - 6:g} 26" fill="var(--ink-faint)"/>')
    return svg(1000, h, "".join(out))


def strip(rows: list[dict]) -> str:
    """Channels side by side: what each moves, which way, what triggers it."""
    step = min(fill(len(rows), 44.0, 24.0), 112.0)
    w, h = 1000.0, 20 + len(rows) * step
    out = []
    for i, r in enumerate(rows):
        y = 6 + i * step
        colour = SERIES[i % len(SERIES)]
        dirn = "mem -> periph" if "mem->periph" in _s(r.get("direction")) else "periph -> mem"
        out.append(f'<rect x="0" y="{y:g}" width="150" height="20" rx="3" fill="{colour}" opacity="0.14" '
                   f'stroke="{colour}" stroke-width="0.6"/>')
        out.append(_text(8, y + 13, _s(r.get("channel"), 20), 7.2, weight=600))
        out.append(_text(160, y + 13, _s(r.get("peripheral"), 20), 7.0, mono=True))
        fwd = "mem->periph" in _s(r.get("direction"))
        x0, x1 = (300.0, 560.0) if fwd else (560.0, 300.0)
        out.append(f'<line x1="{x0:g}" y1="{y + 10:g}" x2="{x1:g}" y2="{y + 10:g}" stroke="{colour}" stroke-width="1"/>')
        tip = x1 + (7 if fwd else -7)
        out.append(f'<path d="M{tip:g} {y + 6:g} L{x1:g} {y + 10:g} L{tip:g} {y + 14:g} Z" fill="{colour}"/>')
        out.append(_text(580, y + 13, dirn, 6.6, "start", "var(--ink-dim)"))
        out.append(_text(760, y + 13, _s(r.get("trigger"), 34), 6.6, "start", "var(--ink-dim)", mono=True))
        out.append(_text(880, y + 13, _s(r.get("what"), 24), 6.4, "start", "var(--ink-faint)"))
    return svg(1000, h, "".join(out))


def tree(rows: list[dict], key_node: str = "node", key_from: str = "from", key_rate: str = "rate") -> str:
    """A clock tree: what comes from where, indented by its place in the chain."""
    step = min(fill(len(rows), 26.0, 20.0), 112.0)
    h = 12 + len(rows) * step
    out = []
    for i, r in enumerate(rows):
        y = 6 + i * step
        indent = 0 if i == 0 else (12 if "internal" in _s(r.get(key_from)) or "crystal" in _s(r.get(key_from)) else 30)
        colour = SERIES[0] if indent < 20 else SERIES[2]
        out.append(f'<line x1="{indent:g}" y1="{y:g}" x2="{indent:g}" y2="{y + 11:g}" stroke="{colour}" '
                   f'stroke-width="{1.4 if indent < 20 else 0.7}"/>' if i else "")
        out.append(_text(indent + 6, y + 9, _s(r.get(key_node), 22), 7.2, weight=600))
        out.append(_text(220, y + 9, _s(r.get(key_from), 40), 6.8, "start", "var(--ink-dim)", mono=True))
        out.append(_text(430, y + 9, _s(r.get(key_rate), 14), 7.0, "start", "var(--ink)", 600, mono=True))
        out.append(_text(540, y + 9, _s(r.get("what"), 60), 6.6, "start", "var(--ink-dim)"))
    return svg(1000, h, "".join(out))


def formula(expr: str, result: str, unit: str, inputs: list[dict], refused: str = "") -> str:
    """A calculation: the expression, what went into it, and the result - with
    the arithmetic checked, so a refusal says which number is wrong."""
    h = 34 + len(inputs) * 15
    out = [f'<rect x="0" y="0" width="1000" height="{h:g}" rx="3" fill="var(--wash)" stroke="var(--line)" stroke-width="0.6"/>']
    out.append(_text(12, 16, expr, 9.0, weight=600, mono=True))
    out.append(_text(988, 16, f"{result} {unit}".strip(), 11.0, "end",
                     _BAD if refused else _OK, 700, mono=True))
    if refused:
        out.append(_text(12, 28, refused, 6.8, "start", _BAD))
    y = 42
    for r in inputs:
        out.append(_text(16, y, _s(r.get("what") or r.get("label"), 30), 6.8))
        out.append(_text(300, y, f"{_s(r.get('value'), 12)} {_s(r.get('unit'), 8)}".strip(), 6.8, mono=True))
        out.append(_text(460, y, _s(r.get("note"), 70), 6.4, "start", "var(--ink-dim)"))
        y += 15
    return svg(1000, y, "".join(out))


def scores(rows: list[dict], key_what: str, key_value: str, key_note: str = "") -> str:
    """A weighted or scored list: the weight as the bar, the favoured option as
    the ink, so the row that decided it is visible at a glance."""
    vals = [abs(_num(r.get(key_value)) or 0) for r in rows] or [1]
    top = max(vals)
    step = min(fill(len(rows), 26.0, 20.0), 112.0)
    h = 10 + len(rows) * step
    out = []
    for i, r in enumerate(rows):
        v = abs(_num(r.get(key_value)) or 0)
        y = 4 + i * step
        out.append(_text(0, y + 9, _s(r.get(key_what), 30), 7.0))
        out.append(f'<rect x="200" y="{y + 2:g}" width="{560:g}" height="9" fill="var(--wash)"/>')
        out.append(f'<rect x="200" y="{y + 2:g}" width="{560 * (v / top if top else 0):g}" height="9" '
                   f'fill="{SERIES[i % len(SERIES)]}" opacity="0.5"/>')
        note = _s(r.get("option") or r.get("note") or r.get(key_note) or "", 40)
        out.append(_text(770, y + 10, note, 7.0, weight=600))
        out.append(_text(1000, y + 10, _s(r.get(key_value), 12), 6.8, "end", "var(--ink-dim)", mono=True))
    return svg(1000, h, "".join(out))


def stack_chart(rows: list[dict]) -> str:
    """Stacks as they really are: one bar per task, the whole bar its size, the
    used part filled, the peak marked on it and what is left of it named - a
    bar with no room left is the one that overflows."""
    step = min(fill(len(rows), 62.0, 40.0), 112.0)
    x0, x1 = 170.0, 900.0
    h = 30 + len(rows) * step
    out = [_text(x0, 14, "bytes", 9.5, "start", "var(--ink-dim)"),
           _text(1000, 14, "free", 9.5, "end", "var(--ink-dim)")]
    for i, r in enumerate(rows):
        size = _num(r.get("stack")) or 0
        used, peak = _num(r.get("used")) or 0, _num(r.get("peak")) or 0
        free = _num(r.get("free"))
        if free is None and size:
            free = max(0.0, size - max(used, peak))
        scale = max(1.0, size, peak, used)
        y = 22 + i * step
        bh = min(30.0, step * 0.42)
        out.append(_text(x0 - 14, y + bh - 7, _s(r.get("task") or r.get("what"), 22), 11.5, "end", weight=700))
        out.append(f'<rect x="{x0:g}" y="{y:g}" width="{x1 - x0:g}" height="{bh:g}" fill="var(--wash)" '
                   f'stroke="var(--line)" stroke-width="0.6"/>')
        for value, colour, opacity in ((used, SERIES[i % len(SERIES)], 0.55), (peak, SERIES[i % len(SERIES)], 0.25)):
            if value:
                out.append(f'<rect x="{x0:g}" y="{y:g}" width="{(x1 - x0) * min(1.0, value / scale):g}" '
                           f'height="{bh:g}" fill="{colour}" opacity="{opacity}"/>')
        if peak:
            px = x0 + (x1 - x0) * min(1.0, peak / scale)
            out.append(f'<line x1="{px:g}" y1="{y - 4:g}" x2="{px:g}" y2="{y + bh + 4:g}" stroke="var(--ink)" '
                       f'stroke-width="1.1"/>')
            out.append(_text(px + 5, y - 1, f"peak {peak:g}", 9.0, "start", "var(--ink)", 600, mono=True))
        room = (size - max(used, peak)) if size else (free or 0)
        colour = _BAD if room <= 0 else (_WARN if size and room < size * 0.15 else _OK)
        out.append(_text(1000, y + bh - 7, f"{room:g} free of {size:g}".strip(), 10.5, "end", colour, 600, mono=True))
        out.append(_text(x0, y + bh + 12, f"used {used:g}", 9.0, "start", "var(--ink-dim)", mono=True))
    return svg(1000, h, "".join(out))


def measurement_chart(rows: list[dict]) -> str:
    """Measurements as they are read: a track over the scale, the acceptable
    band drawn in green, the value a mark on it - inside the band it is in,
    outside it is red, and a row with no method has no mark at all, only the
    words. A reader sees the margin, not just the number."""
    step = min(fill(len(rows), 54.0, 40.0), 112.0)
    x0, x1 = 170.0, 880.0
    h = 34 + len(rows) * step
    out = [_text(x0, 14, "scale", 9.5, "start", "var(--ink-dim)"),
           _text(1000, 14, "verdict", 9.5, "end", "var(--ink-dim)")]
    for i, r in enumerate(rows):
        v, lim = _num(r.get("value")), _num(r.get("limit"))
        tol = _num(r.get("tol"))
        method = _s(r.get("method"), 40)
        scale = max(abs(v or 0), abs(lim or 0) * (1 + (abs(tol) / abs(lim) if lim and tol else 0.15)), 1.0)
        y = 26 + i * step
        bh = min(22.0, step * 0.3)
        out.append(_text(x0 - 14, y + bh - 6, _s(r.get("what"), 24), 11.5, "end", weight=700))
        out.append(f'<rect x="{x0:g}" y="{y:g}" width="{x1 - x0:g}" height="{bh:g}" fill="var(--wash)" '
                   f'stroke="var(--line)" stroke-width="0.6"/>')
        if lim is not None:
            lo = (abs(lim) - abs(tol)) if tol else 0.0
            hi = (abs(lim) + abs(tol)) if tol else abs(lim)
            bx0, bx1 = x0 + (x1 - x0) * min(1.0, lo / scale), x0 + (x1 - x0) * min(1.0, hi / scale)
            out.append(f'<rect x="{bx0:g}" y="{y:g}" width="{max(1.0, bx1 - bx0):g}" height="{bh:g}" '
                       f'fill="{_OK}" opacity="0.16"/>')
            out.append(f'<line x1="{bx1:g}" y1="{y - 3:g}" x2="{bx1:g}" y2="{y + bh + 3:g}" stroke="{_OK}" '
                       f'stroke-width="0.9"/>')
            out.append(_text(bx1 + 4, y - 1, f"limit {_s(r.get('limit'), 10)}".strip(), 8.8, "start", _OK, mono=True))
        if not method:
            out.append(_text(x0 + (x1 - x0) / 2, y + bh - 6, "not recorded - no method", 10.5, "middle",
                             "var(--ink-faint)"))
            out.append(_text(1000, y + bh - 6, "no method", 10.5, "end", "var(--ink-faint)"))
        elif v is not None:
            vx = x0 + (x1 - x0) * min(1.0, abs(v) / scale)
            inband = True if lim is None else (abs(v) <= abs(lim) + abs(tol or 0) if not tol
                                     else abs(lim) - abs(tol) <= abs(v) <= abs(lim) + abs(tol))
            colour = _OK if inband else _BAD
            out.append(f'<line x1="{vx:g}" y1="{y - 5:g}" x2="{vx:g}" y2="{y + bh + 5:g}" stroke="{colour}" '
                       f'stroke-width="1.6"/>')
            out.append(_text(vx, y + bh + 12, f"{_s(r.get('value'), 10)} {_s(r.get('unit'), 6)}".strip(), 9.6,
                             "middle", colour, 700, mono=True))
            out.append(_text(1000, y + bh - 6, "in" if inband else "out", 10.5, "end", colour, 700))
        out.append(_text(x0, y + bh + 12, method or "", 9.0, "start", "var(--ink-dim)"))
    return svg(1000, h, "".join(out))


def thermal_chart(rows: list[dict], ambient: float | None = None) -> str:
    """Heat on a scale: each spot a bar over a colour ramp (cool to hot), the
    temperature a mark on it, the limit a tick, and the headroom at the end -
    green while there is room, amber under a fifth of it, red past the limit.
    A reader sees how close the design runs, not just what it read."""
    step = min(fill(len(rows), 52.0, 46.0), 112.0)
    x0, x1 = 170.0, 880.0
    lims = [abs(_num(r.get("limit")) or 0) for r in rows if r.get("limit")]
    vals = [abs(_num(r.get("temperature")) or 0) for r in rows]
    scale = max(lims + vals + [60.0]) * 1.12
    h = 40 + len(rows) * step
    out = [f'<defs><linearGradient id="pheat" x1="0" x2="1" y1="0" y2="0">'
           f'<stop offset="0" stop-color="#2f6fb8" stop-opacity="0.35"/>'
           f'<stop offset="0.55" stop-color="#0f8a7a" stop-opacity="0.35"/>'
           f'<stop offset="0.8" stop-color="#c07a12" stop-opacity="0.45"/>'
           f'<stop offset="1" stop-color="#b52a2a" stop-opacity="0.5"/></linearGradient></defs>']
    out.append(_text(x0, 14, f"0", 9.0, "start", "var(--ink-dim)", mono=True))
    out.append(_text(x1, 14, f"{scale:g} C", 9.0, "end", "var(--ink-dim)", mono=True))
    out.append(_text(1000, 14, "headroom", 9.5, "end", "var(--ink-dim)"))
    for i, r in enumerate(rows):
        t, lim = _num(r.get("temperature")), _num(r.get("limit"))
        y = 28 + i * step
        bh = min(20.0, step * 0.3)
        out.append(_text(x0 - 14, y + bh - 5, _s(r.get("spot") or r.get("what"), 22), 11.5, "end", weight=700))
        out.append(f'<rect x="{x0:g}" y="{y:g}" width="{x1 - x0:g}" height="{bh:g}" fill="url(#pheat)" '
                   f'stroke="var(--line)" stroke-width="0.6"/>')
        if lim is not None:
            lx = x0 + (x1 - x0) * min(1.0, abs(lim) / scale)
            out.append(f'<line x1="{lx:g}" y1="{y - 5:g}" x2="{lx:g}" y2="{y + bh + 5:g}" stroke="var(--ink)" '
                       f'stroke-width="1.2"/>')
            out.append(_text(lx, y - 2, f"{lim:g}", 8.6, "middle", "var(--ink)", mono=True))
        if t is not None:
            tx = x0 + (x1 - x0) * min(1.0, abs(t) / scale)
            frac = (abs(lim) - abs(t)) / abs(lim) if lim else 1.0
            colour = _OK if frac > 0.2 else (_WARN if frac > 0 else _BAD)
            out.append(f'<circle cx="{tx:g}" cy="{y + bh / 2:g}" r="{bh / 2 + 1:g}" fill="var(--surface)" '
                       f'stroke="{colour}" stroke-width="1.6"/>')
            out.append(_text(tx, y + bh + 12, f"{_s(r.get('temperature'), 8)} C".strip(), 9.6, "middle", colour, 700,
                             mono=True))
            if lim is not None:
                out.append(_text(1000, y + bh - 5, f"{lim - t:+g} C", 10.5, "end", colour, 600, mono=True))
        out.append(_text(x0, y + bh + 12, _s(r.get("note"), 60), 8.8, "start", "var(--ink-dim)"))
    return svg(1000, h, "".join(out))


def timeline(rows: list[dict], at_key: str, label_key: str, group_key: str | None = None,
             level_key: str | None = None, unit: str = "") -> str:
    """Events on a time axis. One lane per group (a source, a task, an IRQ) or a
    single lane, a mark where each event falls, coloured by level, with the line
    beside it - the way a boot log or an interrupt trace is actually read."""
    times = [_num(r.get(at_key)) for r in rows]
    known = [t for t in times if t is not None]
    lo, hi = (min(known), max(known)) if known else (0.0, 1.0)
    span = (hi - lo) or 1.0
    groups: list[str] = []
    for r in rows:
        g = _s(r.get(group_key) if group_key else "", 22) or "events"
        if g not in groups:
            groups.append(g)
    x0, x1 = 170.0, 980.0
    lane_h = min(fill(len(groups) + 1, 34.0, 40.0), 150.0)
    h = 20 + len(groups) * lane_h + 34
    out = []
    for i, g in enumerate(groups):
        y = 20 + i * lane_h
        out.append(_text(x0 - 12, y + 9, g, 10.5, "end", weight=700))
        out.append(f'<line x1="{x0:g}" y1="{y + 5:g}" x2="{x1:g}" y2="{y + 5:g}" stroke="var(--line)" '
                   f'stroke-width="0.7"/>')
    for r, t in zip(rows, times):
        g = _s(r.get(group_key) if group_key else "", 22) or "events"
        y = 20 + groups.index(g) * lane_h + 5
        level = _s(r.get(level_key) if level_key else "", 10).lower()
        colour = _BAD if any(k in level for k in ("err", "fail", "panic", "overflow")) else (
            _WARN if any(k in level for k in ("warn", "crit")) else SERIES[len(out) % len(SERIES)])
        if t is None:
            out.append(_text(x0 + 4, y - 4, f"no time - {_s(r.get(label_key), 60)}", 9.4, "start",
                             "var(--ink-faint)"))
            continue
        x = x0 + (x1 - x0) * ((t - lo) / span)
        out.append(f'<line x1="{x:g}" y1="{y - 7:g}" x2="{x:g}" y2="{y + 7:g}" stroke="{colour}" stroke-width="1.3"/>')
        out.append(f'<circle cx="{x:g}" cy="{y:g}" r="2.6" fill="{colour}"/>')
        out.append(_text(x + 5, y - 9, f"{_s(r.get(at_key), 10)}{unit}".strip(), 8.6, "start", colour, mono=True))
        out.append(_text(x + 5, y + 14, _s(r.get(label_key), 62), 9.0, "start", "var(--ink-dim)"))
    for i in range(5):
        x = x0 + (x1 - x0) * i / 4
        out.append(f'<line x1="{x:g}" y1="{20 + len(groups) * lane_h + 6:g}" x2="{x:g}" '
                   f'y2="{20 + len(groups) * lane_h + 12:g}" stroke="var(--line)" stroke-width="0.7"/>')
        out.append(_text(x, 20 + len(groups) * lane_h + 24, f"{lo + span * i / 4:g}{unit}", 8.6, "middle",
                         "var(--ink-faint)", mono=True))
    return svg(1000, h, "".join(out))


def _g(v) -> str:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return _s(v, 12)
    return f"{f:,.1f}".rstrip("0").rstrip(".") if abs(f) < 1e6 else f"{f:g}"


def allocation(rows: list[dict], total=None, unit: str = "", over=None) -> str:
    """One bar made of its contributors, against the budget: the dashed line is
    the total, an over budget runs past it in red, and each segment carries what
    it is and how much - the way a power or flash budget is read."""
    vals = [abs(_num(r.get("value")) or 0) for r in rows]
    summed = sum(vals)
    top = max(abs(_num(total) or 0), summed, abs(_num(over) or 0), 1.0)
    x0, x1 = 40.0, 960.0
    w = x1 - x0
    h = 132
    out = []
    x = x0
    for i, r in enumerate(rows):
        v = abs(_num(r.get("value")) or 0)
        seg = w * v / top
        colour = SERIES[i % len(SERIES)]
        out.append(f'<rect x="{x:g}" y="30" width="{max(1.0, seg):g}" height="40" fill="{colour}" opacity="0.42"/>')
        out.append(f'<rect x="{x:g}" y="30" width="{max(1.0, seg):g}" height="40" fill="none" '
                   f'stroke="{colour}" stroke-width="0.8"/>')
        if seg > 66:
            out.append(_text(x + seg / 2, 48, _s(r.get("what"), 16), 9.6, "middle", "var(--ink)", 600))
            out.append(_text(x + seg / 2, 62, _g(v), 9.2, "middle", "var(--ink-dim)", 400, mono=True))
        else:
            out.append(_text(x + seg / 2, 84, _s(r.get("what"), 16), 8.4, "middle", "var(--ink-dim)"))
        x += seg
    if total is not None:
        tx = x0 + w * min(1.0, abs(_num(total) or 0) / top)
        out.append(f'<line x1="{tx:g}" y1="18" x2="{tx:g}" y2="78" stroke="var(--ink)" stroke-width="1.3" '
                   f'stroke-dasharray="5 2"/>')
        out.append(_text(min(tx + 6, x1), 14, f"total {_g(total)}{unit and ' ' + unit}".strip(), 9.6,
                         "start" if tx + 6 < x1 else "end", "var(--ink)", 700, mono=True))
    if over is not None:
        ox = x0 + w * min(1.0, abs(_num(over) or 0) / top)
        out.append(f'<line x1="{ox:g}" y1="18" x2="{ox:g}" y2="78" stroke="{_BAD}" stroke-width="1.1"/>')
        out.append(_text(min(ox + 6, x1), 98, f"limit {_g(over)}{unit and ' ' + unit}".strip(), 9.2, "start",
                         _BAD, 600, mono=True))
    if summed > top * 1.0001:
        out.append(_text(x1, 118, f"the contributors add up to {_g(summed)} - past the bar", 9.6, "end", _BAD, 700))
    else:
        out.append(_text(x1, 118, f"{_g(summed)} of {_g(top)}{unit and ' ' + unit} used - "
                                  f"{_g(top - summed)} left", 9.6, "end", "var(--ink-dim)"))
    return svg(1000, h, "".join(out))


def diff(rows: list[dict], label_key: str = "what", was_key: str = "was", now_key: str = "now") -> str:
    """Was, an arrow, now, and the size of the move: a change you cannot see the
    amount of is not a change. Non-numeric ends are still written, without a
    delta."""
    step = min(fill(len(rows), 36.0, 20.0), 112.0)
    h = 26 + len(rows) * step
    out = [_text(300, 14, "was", 8.8, "end", "var(--ink-faint)"), _text(356, 14, "now", 8.8, "start",
           "var(--ink-faint)"), _text(1000, 14, "change", 8.8, "end", "var(--ink-faint)")]
    for i, r in enumerate(rows):
        y = 22 + i * step
        was, now = _num(r.get(was_key)), _num(r.get(now_key))
        out.append(_text(0, y + 13, _s(r.get(label_key), 30), 11.0, weight=700))
        out.append(_text(300, y + 13, _s(r.get(was_key), 16), 10.6, "end", "var(--ink-faint)", 400, mono=True))
        out.append(f'<path d="M312 {y + 9:g} L344 {y + 9:g} M338 {y + 5:g} L344 {y + 9:g} L338 {y + 13:g}" '
                   f'stroke="var(--ink-dim)" stroke-width="1" fill="none"/>')
        out.append(_text(356, y + 13, _s(r.get(now_key), 16), 10.6, "start", "var(--ink)", 600, mono=True))
        if was is not None and now is not None:
            d = now - was
            colour = _OK if d > 0 else (_BAD if d < 0 else "var(--ink-dim)")
            out.append(_text(1000, y + 13, f"{d:+g}", 11.0, "end", colour, 700, mono=True))
        else:
            out.append(_text(1000, y + 13, "-", 10.0, "end", "var(--ink-faint)"))
        out.append(_text(560, y + 13, _s(r.get("why") or r.get("note") or r.get("register") or "", 54),
                         9.6, "start", "var(--ink-dim)"))
        out.append(f'<line x1="0" y1="{y + step - 9:g}" x2="1000" y2="{y + step - 9:g}" stroke="var(--line)" '
                   f'stroke-width="0.4"/>')
    return svg(1000, h, "".join(out))


def connector(rows: list[dict], housing: str = "") -> str:
    """The housing as a body with its pins down the near side, the wire out to
    its name, and what it carries written against it."""
    step = min(fill(len(rows), 28.0, 42.0), 112.0)
    h = 46 + len(rows) * step
    out = [f'<rect x="118" y="30" width="84" height="{max(10.0, len(rows) * step - 8):g}" rx="5" '
           f'fill="var(--wash)" stroke="var(--ink)" stroke-width="1.1"/>']
    if housing:
        out.append(_text(160, 22, _s(housing, 30), 10.0, "middle", "var(--ink-dim)", 600))
    for i, r in enumerate(rows):
        y = 30 + i * step + step / 2
        out.append(f'<circle cx="118" cy="{y:g}" r="3.6" fill="var(--surface)" stroke="var(--ink)" '
                   f'stroke-width="0.9"/>')
        out.append(_text(106, y + 3.6, _s(r.get("pin"), 8), 9.6, "end", "var(--ink)", 600, mono=True))
        out.append(f'<line x1="202" y1="{y:g}" x2="318" y2="{y:g}" stroke="var(--ink-dim)" stroke-width="0.9"/>')
        out.append(_text(324, y + 3.6, _s(r.get("name"), 22), 10.6, weight=600))
        out.append(_text(520, y + 3.6, _s(r.get("signal"), 22), 10.0, "start", "var(--ink-dim)", 400, mono=True))
        out.append(_text(700, y + 3.6, _s(r.get("wire"), 16), 9.6, "start", "var(--ink-dim)"))
        out.append(_text(1000, y + 3.6, _s(r.get("note"), 40), 9.4, "end", "var(--ink-faint)"))
    return svg(1000, h, "".join(out))


def nets(rows: list[dict]) -> str:
    """The net in the middle with its endpoints drawn to it: what a netlist
    actually says, without reading every row."""
    step = min(fill(len(rows), 36.0, 30.0), 112.0)
    h = 24 + len(rows) * step
    out = [_text(250, 14, "from", 8.8, "end", "var(--ink-faint)"), _text(500, 14, "net", 8.8, "middle",
           "var(--ink-faint)"), _text(750, 14, "to", 8.8, "start", "var(--ink-faint)")]
    for i, r in enumerate(rows):
        y = 24 + i * step + step / 2
        colour = SERIES[i % len(SERIES)]
        out.append(f'<line x1="250" y1="{y:g}" x2="432" y2="{y:g}" stroke="{colour}" stroke-width="1.1"/>')
        out.append(f'<line x1="568" y1="{y:g}" x2="750" y2="{y:g}" stroke="{colour}" stroke-width="1.1"/>')
        out.append(f'<rect x="432" y="{y - 11:g}" width="136" height="22" rx="3" fill="{colour}" '
                   f'opacity="0.2" stroke="{colour}" stroke-width="0.8"/>')
        out.append(_text(500, y + 4, _s(r.get("net"), 16), 10.0, "middle", "var(--ink)", 700, mono=True))
        out.append(_text(244, y + 4, _s(r.get("from"), 22), 9.8, "end", "var(--ink-dim)", 400, mono=True))
        out.append(_text(756, y + 4, _s(r.get("to"), 22), 9.8, "start", "var(--ink-dim)", 400, mono=True))
        out.append(_text(1000, y + 4, _s(r.get("what"), 30), 9.2, "end", "var(--ink-faint)"))
    return svg(1000, h, "".join(out))
