"""The circuit of an imported board: its parts, its nets, where each sits.

Three sources, best first for each question:

* **nets** - a design file (through KiCad), else EasyEDA Pro's
  flying-probe file, which lists every pad with its net;
* **placement** - the design file, else the flying-probe file's
  component rows, else a pick-and-place CSV;
* **what each part is** (footprint, value, part number) - a BOM, else
  the pick-and-place file, else the footprint in an assembled STEP's
  product names (`U2~WIFIM-SMD_ESP32-WROOM-32-N4~...`). A part number is
  never guessed: `part` stays empty unless a BOM says it.

The graph is SPEC §5's: components `{ref, value, footprint, part, where}`
and nets `{name, code, nodes: [{ref, pin}]}` with `pin` the pad number as
a string.
"""

from __future__ import annotations

import csv
import io
import json
import re

MIL = 0.0254
INCH = 25.4

# EasyEDA writes free pads, vias and test points as components named
# PAD<n>. They are copper, not parts: they are drawn from the Gerbers but
# are neither components nor net nodes.
FREE_PAD = re.compile(r"^PAD\d+$", re.I)


def _text(data: bytes) -> str:
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return data.decode("utf-16")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("latin-1")


def _unit(length_unit: str | None) -> float:
    u = (length_unit or "mil").strip().lower()
    return {"mil": MIL, "mm": 1.0, "inch": INCH, "in": INCH, "um": 0.001}.get(u, MIL)


def split_pin(name: str) -> tuple[str, str] | None:
    """`U2_8` -> ("U2", "8"); `OLED_MODULE_3` -> ("OLED_MODULE", "3").
    Designators have underscores in them, pad names do not, so the split
    is on the last one."""
    if "_" not in name:
        return None
    ref, _, pin = name.rpartition("_")
    return (ref, pin) if ref and pin else None


def counts(graph: dict) -> dict:
    return {"components": len(graph["components"]), "nets": len(graph["nets"]),
            "joins": sum(len(n["nodes"]) for n in graph["nets"])}


# ---- EasyEDA Pro flying-probe data ------------------------------------

def _rows(section: dict) -> list[dict]:
    fields = [f.upper() for f in section.get("fields", [])]
    return [dict(zip(fields, r)) for r in section.get("rows", []) if isinstance(r, list)]


def parse_probe(data: bytes) -> dict:
    """The flying-probe file as a graph and a placement (absolute mm, in
    the Gerbers' own frame: the two share an origin)."""
    doc = json.loads(_text(data))
    k = _unit(doc.get("lengthUnit"))
    comps, placement, seen = [], [], set()
    free_pads = 0
    for row in _rows(doc.get("components") or {}):
        ref = str(row.get("COMPONENT_NAME") or "").strip()
        if not ref:
            continue
        if FREE_PAD.match(ref):
            free_pads += 1
            continue
        if ref in seen:
            continue
        seen.add(ref)
        comps.append({"ref": ref, "value": None, "footprint": None, "part": None, "where": None})
        placement.append({
            "ref": ref,
            "x": round(float(row.get("X_COORDINATE") or 0) * k, 4),
            "y": round(float(row.get("Y_COORDINATE") or 0) * k, 4),
            "rot": float(row.get("ANGLE") or 0),
            "side": "bottom" if str(row.get("LAYER", "T")).upper().startswith("B") else "top",
        })

    nets: dict[str, dict] = {}
    pads = []
    unknown_refs = set()
    for row in _rows(doc.get("pins") or {}):
        got = split_pin(str(row.get("PIN_NAME") or ""))
        if not got:
            continue
        ref, pin = got
        if FREE_PAD.match(ref):
            continue
        if ref not in seen:
            unknown_refs.add(ref)
            continue
        pads.append({"ref": ref, "pin": pin,
                     "x": round(float(row.get("PIN_X") or 0) * k, 4),
                     "y": round(float(row.get("PIN_Y") or 0) * k, 4),
                     "type": row.get("PIN_TYPE")})
        name = str(row.get("NET_NAME") or "").strip()
        if not name:
            continue
        net = nets.setdefault(name, {"name": name, "code": None, "nodes": []})
        node = {"ref": ref, "pin": pin}
        if node not in net["nodes"]:
            net["nodes"].append(node)
    ordered = sorted(nets.values(), key=lambda n: (n["name"] != "GND", n["name"]))
    for i, n in enumerate(ordered, 1):
        n["code"] = str(i)
    graph = {"components": comps, "nets": ordered}
    return {"graph": graph, "placement": placement, "pads": pads,
            "free_pads": free_pads, "unknown_refs": sorted(unknown_refs)}


# ---- BOM and pick-and-place CSVs --------------------------------------

def _table(data: bytes) -> list[dict]:
    text = _text(data)
    lines = [l for l in text.splitlines() if l.strip()]
    if not lines:
        return []
    # The header is the first line that names a designator column; some
    # exporters put a title or a blank line above it.
    start = next((i for i, l in enumerate(lines[:10])
                  if re.search(r"designator|reference|refdes|\bref\b", l, re.I)), 0)
    body = "\n".join(lines[start:])
    try:
        dialect = csv.Sniffer().sniff(lines[start], delimiters=",\t;")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.reader(io.StringIO(body), dialect))
    head = [h.strip().strip('"').lower() for h in rows[0]]
    return [dict(zip(head, [c.strip() for c in r])) for r in rows[1:] if any(c.strip() for c in r)]


def _pick(row: dict, *names: str) -> str | None:
    for n in names:
        v = row.get(n)
        if v and v.strip() and v.strip() not in ("-", "~", "N/A", "n/a"):
            return v.strip()
    return None


def _refs(cell: str | None) -> list[str]:
    return [r for r in re.split(r"[,\s;]+", cell or "") if r]


REF_COLS = ("designator", "reference", "references", "refdes", "ref des", "ref", "part reference")
FOOT_COLS = ("footprint", "package", "footprint name", "pcb footprint", "case/package")
VALUE_COLS = ("value", "comment", "name", "val", "part", "description")
PART_COLS = ("lcsc part", "lcsc", "lcsc part #", "lcsc part number", "jlcpcb part #",
             "jlcpcb part", "supplier part", "supplier part number", "manufacturer part",
             "manufacturer part number", "mpn", "mfr. part #")


def parse_bom(data: bytes) -> dict[str, dict]:
    """ref -> {footprint, value, part} from an EasyEDA/JLC/KiCad BOM CSV.
    A row names several designators when it groups identical parts."""
    out: dict[str, dict] = {}
    for row in _table(data):
        info = {"footprint": _pick(row, *FOOT_COLS),
                "value": _pick(row, *VALUE_COLS),
                "part": _pick(row, *PART_COLS)}
        for ref in _refs(_pick(row, *REF_COLS)):
            out[ref] = info
    return out


def _length(cell: str | None, default_unit: float) -> float | None:
    if not cell:
        return None
    m = re.match(r"\s*(-?[\d.]+)\s*(mm|mil|in|inch)?", cell, re.I)
    if not m:
        return None
    unit = (m.group(2) or "").lower()
    k = 1.0 if unit == "mm" else MIL if unit == "mil" else INCH if unit in ("in", "inch") else default_unit
    return float(m.group(1)) * k


def parse_pnp(data: bytes) -> dict:
    """A pick-and-place (centroid) file: placement, and the footprint and
    value when it carries them. Units: a cell's own (`61.2mm`), else mm."""
    placement, info = [], {}
    for row in _table(data):
        ref = _pick(row, *REF_COLS)
        if not ref:
            continue
        x = _length(_pick(row, "mid x", "center-x(mm)", "posx", "pos x", "center x", "x", "ref x"), 1.0)
        y = _length(_pick(row, "mid y", "center-y(mm)", "posy", "pos y", "center y", "y", "ref y"), 1.0)
        if x is None or y is None:
            continue
        layer = (_pick(row, "layer", "side", "tb") or "top").lower()
        rot = _length(_pick(row, "rotation", "rot", "angle"), 1.0) or 0.0
        placement.append({"ref": ref, "x": round(x, 4), "y": round(y, 4), "rot": rot,
                          "side": "bottom" if layer.startswith(("b", "bot")) else "top"})
        info[ref] = {"footprint": _pick(row, *FOOT_COLS), "value": _pick(row, "comment", "val", "value"),
                     "part": None}
    return {"placement": placement, "info": info}


def apply_identity(components: list[dict], by_ref: dict[str, dict], source: str,
                   fields=("footprint", "value", "part")) -> int:
    """Fill what a component lacks from `by_ref`; returns how many gained
    something. What a component already has is kept: a design file's own
    footprint beats a BOM's paraphrase of it."""
    n = 0
    for c in components:
        got = by_ref.get(c["ref"])
        if not got:
            continue
        changed = False
        for f in fields:
            if got.get(f) and not c.get(f):
                c[f] = got[f]
                changed = True
        if changed:
            n += 1
    return n


def graph_from_pads_only(placement: list[dict]) -> dict:
    """A graph with the parts and no nets: what a pick-and-place file
    alone can say."""
    return {"components": [{"ref": p["ref"], "value": None, "footprint": None, "part": None,
                            "where": None} for p in placement], "nets": []}
