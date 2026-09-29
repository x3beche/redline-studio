"""What an upload is made of.

A board comes in as whatever the person had: a fab zip of Gerbers and
drills, a zip with a BOM and a pick-and-place file beside them, a design
file from one of half a dozen tools, an assembled STEP, or several of
these at once. This sorts the files into what each one can give - the
drawing, the netlist, the parts, the 3D shape - by looking at them, not
only at their names: a Gerber says which layer it is in its X2
attributes, EasyEDA writes `G04 Layer: TopLayer*`, and the extensions
fill in for the rest (Protel/Altium `.GTL`, KiCad `-F_Cu.gbr`).
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import PurePosixPath

# ---- what a file is ----------------------------------------------------

GERBER = "gerber"
DRILL = "drill"
PROBE = "probe"            # EasyEDA Pro FlyingProbeTesting.json
BOM = "bom"
PNP = "pnp"                # pick-and-place / centroid
STEP = "step"
DESIGN = "design"          # a board design file KiCad can import
IGNORED = "ignored"


@dataclass
class Item:
    name: str               # as it was in the upload (path inside a zip kept)
    data: bytes = field(repr=False)
    kind: str = IGNORED
    layer: str | None = None       # "top copper", "bottom mask", "outline", ...
    plugin: str | None = None      # for a design file: PCB_IO_MGR's name
    note: str | None = None

    @property
    def base(self) -> str:
        return PurePosixPath(self.name).name

    def describe(self) -> dict:
        out = {"file": self.name, "kind": self.kind, "bytes": len(self.data)}
        if self.layer:
            out["layer"] = self.layer
        if self.plugin:
            out["plugin"] = self.plugin
        if self.note:
            out["note"] = self.note
        return out


# ---- unpacking ---------------------------------------------------------

MAX_FILES = 400
MAX_BYTES = 300 * 1024 * 1024


def unpack(uploads: list[tuple[str, bytes]]) -> list[Item]:
    """Every file in the upload, with zips opened (one level of nesting:
    a fab zip inside a project zip is common, deeper is not)."""
    out: list[Item] = []
    total = 0

    def add(name: str, data: bytes, depth: int) -> None:
        nonlocal total
        low = name.lower()
        if low.endswith(".zip") and depth < 2 and zipfile.is_zipfile(io.BytesIO(data)):
            # An EasyEDA Pro project (.epro) is a zip too, but it is a
            # design file and KiCad opens it whole.
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                if _is_odb(z.namelist()):
                    out.append(Item(name, data))
                    return
                for info in z.infolist():
                    if info.is_dir() or info.file_size == 0:
                        continue
                    inner = PurePosixPath(info.filename)
                    if any(p.startswith(("__MACOSX", ".")) for p in inner.parts):
                        continue
                    if len(out) >= MAX_FILES:
                        raise ValueError(f"more than {MAX_FILES} files in the upload")
                    total += info.file_size
                    if total > MAX_BYTES:
                        raise ValueError("the upload unpacks to more than 300 MB")
                    prefix = PurePosixPath(name).stem if depth else ""
                    add(str(PurePosixPath(prefix) / inner) if prefix else str(inner),
                        z.read(info), depth + 1)
            return
        out.append(Item(name, data))

    for name, data in uploads:
        add(PurePosixPath(name.replace("\\", "/")).name, data, 0)
    return out


def _is_odb(names: list[str]) -> bool:
    return any(n.rstrip("/").endswith("matrix/matrix") for n in names)


# ---- gerber layers -----------------------------------------------------

# X2: %TF.FileFunction,<function>,<args>*%
X2_FUNCTION = re.compile(rb"%TF\.FileFunction,([^*]*)\*%")
# EasyEDA (Std and Pro): G04 Layer: TopLayer*
EASYEDA_LAYER = re.compile(rb"G04 Layer:\s*([A-Za-z0-9_ ]+?)\s*\*")
# An Excellon that says what it is: EasyEDA `;TYPE=PLATED`, KiCad's
# `; #@! TF.FileFunction,Plated,1,2,PTH` / `NonPlated`.
EXCELLON_TYPE = re.compile(rb";\s*TYPE=(NON_PLATED|PLATED)", re.I)
EXCELLON_X2 = re.compile(rb"TF\.FileFunction,(NonPlated|Plated)[^\r\n]*", re.I)

EASYEDA_NAMES = {
    "toplayer": "top copper", "bottomlayer": "bottom copper",
    "topsilkscreenlayer": "top silk", "topsilklayer": "top silk",
    "bottomsilkscreenlayer": "bottom silk", "bottomsilklayer": "bottom silk",
    "topsoldermasklayer": "top mask", "bottomsoldermasklayer": "bottom mask",
    "toppastemasklayer": "top paste", "bottompastemasklayer": "bottom paste",
    "boardoutlinelayer": "outline", "boardoutline": "outline",
    "documentlayer": "document", "drilldrawinglayer": "drill drawing",
    "mechanicallayer": "mechanical", "multilayer": "document",
}

# Protel extensions, as Altium, EasyEDA and many others write them.
EXTENSIONS = {
    ".gtl": "top copper", ".gbl": "bottom copper",
    ".gto": "top silk", ".gbo": "bottom silk",
    ".gts": "top mask", ".gbs": "bottom mask",
    ".gtp": "top paste", ".gbp": "bottom paste",
    ".gko": "outline", ".gm1": "outline", ".gml": "outline", ".gm": "outline",
    ".gdl": "document", ".gdd": "drill drawing", ".gd1": "drill drawing",
    ".gg1": "drill drawing", ".gpt": "document", ".gpb": "document",
}

# KiCad's plot names, `board-F_Cu.gbr`, and the older `board-F.Cu.gbr`.
KICAD_NAMES = [
    (r"[-_.]f[._]cu$", "top copper"), (r"[-_.]b[._]cu$", "bottom copper"),
    (r"[-_.]f[._](silks|silkscreen)$", "top silk"), (r"[-_.]b[._](silks|silkscreen)$", "bottom silk"),
    (r"[-_.]f[._]mask$", "top mask"), (r"[-_.]b[._]mask$", "bottom mask"),
    (r"[-_.]f[._]paste$", "top paste"), (r"[-_.]b[._]paste$", "bottom paste"),
    (r"[-_.]edge[._]cuts$", "outline"), (r"[-_.]in(\d+)[._]cu$", "inner copper"),
    (r"[-_.](f|b)[._]fab$", "document"), (r"[-_.](f|b)[._](courtyard|crtyd)$", "document"),
]


def _x2_layer(func: str) -> str | None:
    bits = [b.strip() for b in func.split(",")]
    head = bits[0].lower() if bits else ""
    where = next((b.lower() for b in bits[1:] if b.lower() in ("top", "bot", "bottom", "inr")), "")
    side = "top" if where == "top" else "bottom" if where in ("bot", "bottom") else None
    if head == "copper":
        if side:
            return f"{side} copper"
        return "inner copper"
    table = {"soldermask": "mask", "legend": "silk", "paste": "paste"}
    if head in table and side:
        return f"{side} {table[head]}"
    if head in ("profile",):
        return "outline"
    if head in ("drillmap", "fabricationdrawing", "assemblydrawing", "other", "component"):
        return "document"
    return None


def gerber_layer(name: str, head: bytes) -> str | None:
    """Which layer a Gerber is: its own X2 word first, the EasyEDA header,
    then the name."""
    m = X2_FUNCTION.search(head)
    if m:
        got = _x2_layer(m.group(1).decode(errors="replace"))
        if got:
            return got
    m = EASYEDA_LAYER.search(head)
    if m:
        key = m.group(1).decode(errors="replace").replace(" ", "").lower()
        if key in EASYEDA_NAMES:
            return EASYEDA_NAMES[key]
        if re.match(r"inner\d+", key):
            return "inner copper"
    low = PurePosixPath(name).name.lower()
    suffix = PurePosixPath(low).suffix
    if suffix in EXTENSIONS:
        return EXTENSIONS[suffix]
    if re.fullmatch(r"\.g\d+", suffix) or re.fullmatch(r"\.gp\d+", suffix):
        return "inner copper"
    stem = PurePosixPath(low).stem if suffix in (".gbr", ".ger", ".pho", ".art") else low
    for pattern, layer in KICAD_NAMES:
        if re.search(pattern, stem):
            return layer
    words = re.sub(r"[^a-z]", " ", stem)
    for key, layer in (("outline", "outline"), ("edge", "outline"), ("profile", "outline"),
                       ("top copper", "top copper"), ("bottom copper", "bottom copper"),
                       ("top silk", "top silk"), ("bottom silk", "bottom silk"),
                       ("top mask", "top mask"), ("bottom mask", "bottom mask"),
                       ("top solder", "top mask"), ("bottom solder", "bottom mask"),
                       ("top paste", "top paste"), ("bottom paste", "bottom paste")):
        if key in words:
            return layer
    return None


def looks_gerber(head: bytes) -> bool:
    return (b"%FS" in head or b"%MO" in head or b"%ADD" in head) and b"M48" not in head[:64]


def looks_excellon(head: bytes) -> bool:
    text = head.lstrip()
    return text.startswith(b"M48") or b"\nM48" in head or (
        bool(re.search(rb"^T\d+C[\d.]+", head, re.M)) and b"%FS" not in head)


def drill_kind(name: str, head: bytes) -> str:
    """plated, npth or via - what a drill file holds."""
    low = name.lower()
    m = EXCELLON_TYPE.search(head)
    x2 = EXCELLON_X2.search(head)
    if "via" in low or (x2 and b"via" in x2.group(0).lower()):
        return "via"
    if (m and m.group(1).upper() == b"NON_PLATED") or (x2 and x2.group(1).lower() == b"nonplated"):
        return "npth"
    if "npth" in low or "non-plated" in low or "nonplated" in low or "non_plated" in low:
        return "npth"
    if m or x2 or "pth" in low or "plated" in low:
        return "plated"
    return "mixed"


# ---- the other files ---------------------------------------------------

DESIGN_SUFFIXES = {
    ".kicad_pcb": "KICAD_SEXP",
    ".pcbdoc": "ALTIUM_DESIGNER",
    ".cspcbdoc": "ALTIUM_CIRCUIT_STUDIO",
    ".cmpcbdoc": "ALTIUM_CIRCUIT_MAKER",
    ".epro": "EASYEDAPRO",
    ".cpa": "CADSTAR_PCB_ARCHIVE",
    ".pcb": "PCAD",          # confirmed by content below; gEDA shares it
    ".cvg": "IPC2581",
}

BOM_HEADS = ("designator", "reference", "references", "refdes", "ref des", "part reference")
PNP_HEADS = ("mid x", "center-x(mm)", "posx", "pos x", "center x", "x", "ref x")


def _csv_head(data: bytes) -> list[str]:
    text = _text(data)
    for line in text.splitlines()[:6]:
        if line.count(",") + line.count("\t") + line.count(";") >= 1:
            cells = re.split(r"[,\t;]", line)
            return [c.strip().strip('"').strip().lower() for c in cells]
    return []


def _text(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-16"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def classify(item: Item) -> Item:
    name = item.base
    low = name.lower()
    suffix = PurePosixPath(low).suffix
    head = item.data[:4096]

    if suffix in (".step", ".stp") or head.lstrip().startswith(b"ISO-10303-21"):
        item.kind = STEP
        return item

    if suffix == ".json":
        try:
            doc = json.loads(_text(item.data))
        except ValueError:
            item.note = "not valid JSON"
            return item
        if isinstance(doc, dict) and isinstance(doc.get("components"), dict) \
                and isinstance(doc.get("pins"), dict):
            item.kind = PROBE
            return item
        if isinstance(doc, dict) and (doc.get("head", {}) or {}).get("docType") in ("3", 3):
            item.kind, item.plugin = DESIGN, "EASYEDA"
            return item
        item.note = "a JSON file that is neither EasyEDA flying-probe data nor an EasyEDA board"
        return item

    if suffix in DESIGN_SUFFIXES:
        plugin = DESIGN_SUFFIXES[suffix]
        if suffix == ".kicad_pcb" and not head.lstrip().startswith(b"(kicad_pcb"):
            item.note = "named .kicad_pcb but is not one"
            return item
        if suffix == ".pcb" and b"ACCEL_ASCII" not in head and b"PCAD" not in head.upper():
            item.note = "a .pcb that is not P-CAD"
            return item
        item.kind, item.plugin = DESIGN, plugin
        return item

    if suffix == ".brd":
        if b"<eagle" in head or b"<?xml" in head[:64]:
            item.kind, item.plugin = DESIGN, "EAGLE"
        elif b"(kicad_pcb" in head or b"PCBNEW-BOARD" in head:
            item.kind, item.plugin = DESIGN, "KICAD_SEXP" if b"(kicad_pcb" in head else "LEGACY"
        else:
            item.note = "a .brd KiCad cannot read (binary Eagle or Allegro)"
        return item

    if suffix == ".xml" and b"IPC-2581" in head.upper():
        item.kind, item.plugin = DESIGN, "IPC2581"
        return item

    if suffix == ".tgz" or (suffix == ".zip" and zipfile.is_zipfile(io.BytesIO(item.data))
                            and _is_odb(zipfile.ZipFile(io.BytesIO(item.data)).namelist())):
        item.kind, item.plugin = DESIGN, "ODBPP"
        return item

    if suffix in (".csv", ".tsv", ".txt") and not looks_excellon(head) and not looks_gerber(head):
        cols = _csv_head(item.data)
        if cols and any(c in BOM_HEADS for c in cols):
            if any(c in PNP_HEADS for c in cols) or any("mid x" in c or "center-x" in c for c in cols):
                item.kind = PNP
            elif any(k in c for c in cols for k in ("footprint", "package", "value", "comment",
                                                     "lcsc", "supplier", "manufacturer", "mpn",
                                                     "quantity", "qty")):
                item.kind = BOM
            if item.kind != IGNORED:
                return item

    if suffix in (".xlsx", ".xls"):
        item.note = "a spreadsheet: export the BOM as CSV"
        return item

    if looks_excellon(head) or suffix in (".drl", ".xln", ".exc", ".drd"):
        if looks_excellon(head):
            item.kind = DRILL
            item.layer = drill_kind(name, head)
            return item

    if looks_gerber(head) or suffix in EXTENSIONS or suffix in (".gbr", ".ger", ".pho", ".art"):
        if looks_gerber(head):
            item.kind = GERBER
            item.layer = gerber_layer(name, head) or "unknown"
            return item

    item.note = item.note or "not something a board is read from"
    return item


def sort_upload(uploads: list[tuple[str, bytes]]) -> list[Item]:
    return [classify(i) for i in unpack(uploads)]
