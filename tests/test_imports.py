"""Board import (backend/imports): what each file is, what it says, and
the whole pipeline on the real EasyEDA export when it is on this machine."""

from __future__ import annotations

import asyncio
import io
import json
import shutil
import struct
import subprocess
import zipfile
from pathlib import Path

import pytest

from backend.imports import detect, parts
from backend.imports.api import title_from
from backend.imports.step3d import flat_board, split_product

HERE = Path(__file__).resolve().parent
ZIP = Path("/home/user/Downloads/Gerber_PCB_DemoBoard_0_254_routed_2026-09-29.zip")
STEP = Path("/home/user/Downloads/3D_PCB_DemoBoard_0_254_routed_2026-09-21.step")
KICAD = HERE / "fixtures" / "imports" / "controller.kicad_pcb"


# ---- EasyEDA flying-probe data ----------------------------------------

PROBE = {
    "lengthUnit": "mil",
    "components": {
        "fields": ["COMPONENT_NO", "COMPONENT_NAME", "LAYER", "X_COORDINATE", "Y_COORDINATE", "ANGLE"],
        "rows": [[1, "U2", "T", 1000, 2000, 90], [2, "OLED_MODULE", "B", 500, 100, 180],
                 [3, "PAD1", "T", 10, 10, 0], [4, "PAD1", "T", 10, 10, 0], [5, "R1", "T", 0, 0, 0]]},
    "pins": {
        "fields": ["PIN_NO", "PIN_NAME", "PIN_X", "PIN_Y", "LAYER", "PIN_TYPE", "NET_NAME", "NET_TYPE",
                   "PAD_SHAPE", "PAD_SIZEX", "PAD_SIZEY", "HOLE_SIZE", "HOLE_LEN", "PAD_ANGLE"],
        "rows": [
            [1, "U2_8", 1000, 2000, "T", "SMD", "ENC_A", "", "R", 1, 1, 0, 0, 0],
            [2, "U2_1", 1000, 2050, "T", "SMD", "GND", "GND", "R", 1, 1, 0, 0, 0],
            [3, "OLED_MODULE_1", 500, 100, "B", "DIP", "GND", "GND", "O", 1, 1, 1, 1, 0],
            [4, "OLED_MODULE_1", 500, 100, "B", "DIP", "GND", "GND", "O", 1, 1, 1, 1, 0],
            [5, "OLED_MODULE_3", 600, 100, "B", "DIP", "L_SDA", "", "O", 1, 1, 1, 1, 0],
            [6, "PAD1_1", 10, 10, "T", "DIP", "GND", "GND", "O", 1, 1, 1, 1, 0],
            [7, "R1_2", 0, 0, "T", "SMD", "", "", "R", 1, 1, 0, 0, 0],
        ]},
}


def test_split_pin_keeps_underscores_in_the_ref():
    assert parts.split_pin("U2_8") == ("U2", "8")
    assert parts.split_pin("OLED_MODULE_3") == ("OLED_MODULE", "3")
    assert parts.split_pin("BT_A") == ("BT", "A")
    assert parts.split_pin("nounderscore") is None


def test_probe_gives_spec_graph_and_placement():
    got = parts.parse_probe(json.dumps(PROBE).encode())
    g = got["graph"]
    assert [c["ref"] for c in g["components"]] == ["U2", "OLED_MODULE", "R1"]
    assert set(g["components"][0]) == {"ref", "value", "footprint", "part", "where"}
    assert got["free_pads"] == 2
    nets = {n["name"]: n for n in g["nets"]}
    # GND first, pins as strings, no free pad, no duplicate node
    assert g["nets"][0]["name"] == "GND"
    assert nets["GND"]["nodes"] == [{"ref": "U2", "pin": "1"}, {"ref": "OLED_MODULE", "pin": "1"}]
    assert nets["ENC_A"]["nodes"] == [{"ref": "U2", "pin": "8"}]
    assert nets["L_SDA"]["nodes"] == [{"ref": "OLED_MODULE", "pin": "3"}]
    assert "" not in nets
    assert all(isinstance(n["code"], str) for n in g["nets"])
    u2 = next(p for p in got["placement"] if p["ref"] == "U2")
    assert u2 == {"ref": "U2", "x": 25.4, "y": 50.8, "rot": 90.0, "side": "top"}
    assert next(p for p in got["placement"] if p["ref"] == "OLED_MODULE")["side"] == "bottom"


# ---- BOM and pick-and-place ---------------------------------------------

def test_bom_jlc_csv_groups_designators():
    csv = ('Comment,Designator,Footprint,LCSC Part #\n'
           '100nF,"C1,C2, C3",C0603,C14663\n'
           'ESP32-WROOM-32-N4,U2,WIFIM-SMD_ESP32-WROOM-32-N4,C82899\n').encode()
    got = parts.parse_bom(csv)
    assert got["C2"] == {"footprint": "C0603", "value": "100nF", "part": "C14663"}
    assert got["U2"]["part"] == "C82899"


def test_bom_easyeda_utf16_tabs():
    text = ("ID\tName\tDesignator\tFootprint\tQuantity\tManufacturer Part\tSupplier Part\n"
            "1\t10k\tR1 R2\tR0603\t2\tRC0603FR-0710KL\tC98220\n")
    got = parts.parse_bom(text.encode("utf-16"))
    assert got["R2"] == {"footprint": "R0603", "value": "10k", "part": "C98220"}


def test_apply_identity_fills_only_what_is_missing():
    comps = [{"ref": "U2", "value": None, "footprint": "KEEP", "part": None, "where": None}]
    n = parts.apply_identity(comps, {"U2": {"footprint": "X", "value": "ESP32", "part": "C1"}}, "bom")
    assert n == 1 and comps[0] == {"ref": "U2", "value": "ESP32", "footprint": "KEEP", "part": "C1",
                                   "where": None}


def test_pick_and_place_units():
    csv = ('Designator,Footprint,Mid X,Mid Y,Layer,Rotation,Comment\n'
           'U2,ESP32,61.2mm,70mm,T,90,ESP32\nR1,R0603,100mil,200mil,B,180,10k\n').encode()
    got = parts.parse_pnp(csv)
    assert got["placement"][0] == {"ref": "U2", "x": 61.2, "y": 70.0, "rot": 90.0, "side": "top"}
    assert got["placement"][1]["x"] == pytest.approx(2.54) and got["placement"][1]["side"] == "bottom"
    assert got["info"]["R1"]["footprint"] == "R0603"


# ---- telling files apart --------------------------------------------------

GERBER_BODY = b"%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.1*%\nD10*\nX0Y0D02*\nX10000000Y0D01*\nM02*\n"


@pytest.mark.parametrize("name,head,layer", [
    ("anything.gbr", b"%TF.FileFunction,Copper,L1,Top*%\n", "top copper"),
    ("anything.gbr", b"%TF.FileFunction,Soldermask,Bot*%\n", "bottom mask"),
    ("anything.gbr", b"%TF.FileFunction,Legend,Top*%\n", "top silk"),
    ("anything.gbr", b"%TF.FileFunction,Profile,NP*%\n", "outline"),
    ("x.GTL", b"G04 Layer: BottomLayer*\n", "bottom copper"),       # header beats extension
    ("x.txt", b"G04 Layer: BoardOutlineLayer*\n", "outline"),
    ("Gerber_TopSilkscreenLayer.GTO", b"", "top silk"),
    ("board.GKO", b"", "outline"),
    ("board-F_Cu.gbr", b"", "top copper"),
    ("board-B_Mask.gbr", b"", "bottom mask"),
    ("board-Edge_Cuts.gbr", b"", "outline"),
    ("board-In1_Cu.gbr", b"", "inner copper"),
    ("board.G2", b"", "inner copper"),
])
def test_gerber_layers(name, head, layer):
    item = detect.classify(detect.Item(name, head + GERBER_BODY))
    assert item.kind == detect.GERBER
    assert item.layer == layer


@pytest.mark.parametrize("name,head,kind", [
    ("Drill_PTH_Through.DRL", b";TYPE=PLATED\nM48\nMETRIC\nT01C0.3\n%\n", "plated"),
    ("Drill_NPTH_Through.DRL", b";TYPE=NON_PLATED\nM48\nMETRIC\nT01C0.3\n%\n", "npth"),
    ("Drill_PTH_Through_Via.DRL", b";TYPE=PLATED\nM48\nMETRIC\nT01C0.3\n%\n", "via"),
    ("board-NPTH.drl", b"M48\nMETRIC\nT1C3.2\n%\n", "npth"),
    ("board.drl", b"M48\n; #@! TF.FileFunction,NonPlated,1,2,NPTH\nMETRIC\n%\n", "npth"),
    ("board.xln", b"M48\nINCH\nT1C0.02\n%\n", "mixed"),
])
def test_drills(name, head, kind):
    item = detect.classify(detect.Item(name, head))
    assert item.kind == detect.DRILL and item.layer == kind


def test_other_files():
    c = lambda n, d: detect.classify(detect.Item(n, d))          # noqa: E731
    assert c("FlyingProbeTesting.json", json.dumps(PROBE).encode()).kind == detect.PROBE
    assert c("BOM.csv", b"Designator,Footprint,Comment\nR1,R0603,10k\n").kind == detect.BOM
    assert c("PickAndPlace.csv", b"Designator,Mid X,Mid Y,Layer,Rotation\nR1,1,2,T,0\n").kind == detect.PNP
    assert c("a.step", b"ISO-10303-21;\n").kind == detect.STEP
    k = c("board.kicad_pcb", b"(kicad_pcb (version 2024))")
    assert (k.kind, k.plugin) == (detect.DESIGN, "KICAD_SEXP")
    assert c("x.PcbDoc", b"\xd0\xcf\x11\xe0").plugin == "ALTIUM_DESIGNER"
    assert c("x.epro", b"PK\x03\x04").plugin == "EASYEDAPRO"
    assert c("x.brd", b'<?xml version="1.0"?>\n<eagle version="9">').plugin == "EAGLE"
    assert c("How-to-order-PCB.txt", b"How to Order PCB\n").kind == detect.IGNORED
    assert c("x.json", b'{"head": {"docType": "3"}}').plugin == "EASYEDA"


def test_zips_are_opened_nested_once():
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as z:
        z.writestr("Gerber_TopLayer.GTL", b"G04 Layer: TopLayer*\n" + GERBER_BODY)
    outer = io.BytesIO()
    with zipfile.ZipFile(outer, "w") as z:
        z.writestr("fab.zip", inner.getvalue())
        z.writestr("__MACOSX/._junk", b"x")
        z.writestr("BOM.csv", b"Designator,Footprint\nR1,R0603\n")
    items = detect.sort_upload([("project.zip", outer.getvalue())])
    kinds = sorted((i.base, i.kind, i.layer) for i in items)
    assert kinds == [("BOM.csv", "bom", None), ("Gerber_TopLayer.GTL", "gerber", "top copper")]


def test_title_from_upload_names():
    assert title_from(["Gerber_PCB_DemoBoard_0_254_routed_2026-09-29.zip"]) == "DemoBoard 0 254 routed"
    assert title_from(["3D_PCB_DemoBoard_2026-09-21.step"]) == "DemoBoard"
    assert title_from(["controller.kicad_pcb"]) == "controller"


# ---- drawing and 3D --------------------------------------------------------

def test_gerbers_draw_and_measure():
    from backend.imports import gerbers
    outline = (b"%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.2*%\nD10*\nX0Y0D02*\nX50000000Y0D01*\n"
               b"X50000000Y30000000D01*\nX0Y30000000D01*\nX0Y0D01*\nM02*\n")
    copper = b"%FSLAX46Y46*%\n%MOMM*%\n%ADD11R,2X1*%\nD11*\nX10000000Y10000000D03*\nM02*\n"
    drill = b"M48\nMETRIC\nT01C0.8\n%\nG90\nT01\nX10.0Y10.0\nX20.0Y10.0\nM30\n"
    items = [detect.classify(detect.Item("b.GKO", outline)),
             detect.classify(detect.Item("b.GTL", copper)),
             detect.classify(detect.Item("b-PTH.drl", drill))]
    board = gerbers.Board(items)
    try:
        x0, y0, x1, y1 = board.box()
        assert (round(x1 - x0, 3), round(y1 - y0, 3)) == (50.0, 30.0)   # stroke centre, not its edge
        svg = board.svg("front")
        assert "#C83434" in svg and "#D0D2CD" in svg and 'width="52.0000mm"' in svg
        assert board.svg("bottom").count("scale(-1 -1)") >= 1
        table = board.drill_table()
        assert table == [{"diameter_mm": 0.8, "plated": True, "via": False, "holes": 2, "slots": 0,
                          "file": "b-PTH.drl"}]
    finally:
        board.close()


def test_flat_board_is_a_glb():
    glb = flat_board(95.5, 58.7)
    magic, version, length = struct.unpack("<III", glb[:12])
    assert (magic, version, length) == (0x46546C67, 2, len(glb))
    n = struct.unpack("<I", glb[12:16])[0]
    doc = json.loads(glb[20:20 + n])
    assert doc["nodes"][0]["name"] == "Board"


def test_step_product_names():
    assert split_product("U2~WIFIM-SMD_ESP32-WROOM-32-N4~ESP32~BYvA") == ("U2", "WIFIM-SMD_ESP32-WROOM-32-N4")
    assert split_product("OLED_MODULE~HDR-F-2.54_1X4~X~BYvA") == ("OLED_MODULE", "HDR-F-2.54_1X4")
    assert split_product("Board~BYvA") == ("Board", None)


# ---- the real thing ----------------------------------------------------------

@pytest.mark.skipif(not ZIP.exists(), reason="the EasyEDA export is not on this machine")
def test_real_easyeda_zip():
    from backend.imports import pipeline
    res = asyncio.run(pipeline.analyse([(ZIP.name, ZIP.read_bytes())], "DemoBoard"))
    graph = json.loads(res.artifacts["graph"])
    assert graph["counts"]["components"] == 86 and graph["counts"]["nets"] == 108
    assert not any(c["ref"].startswith("PAD") for c in graph["components"])
    u2 = {n["ref"] + "." + n["pin"]: net["name"] for net in graph["nets"] for n in net["nodes"]}
    assert (u2["U2.8"], u2["U2.30"], u2["U2.33"], u2["U2.36"]) == ("ENC_A", "IO18", "L_SDA", "L_SCL")
    w, h = res.fields["size_mm"]
    assert w == pytest.approx(95.5, abs=0.2) and h == pytest.approx(58.67, abs=0.2)
    assert {"layout", "bottom", "tracks", "model3d", "placement"} <= set(res.artifacts)
    placed = json.loads(res.artifacts["placement"])["parts"]
    assert all(-1 < p["x"] < w + 1 and -1 < p["y"] < h + 1 for p in placed)
    assert {f["key"] for f in res.summary()["found"]} >= {"drawing", "outline", "drills", "netlist",
                                                           "placement"}
    assert "model3d" in {m["key"] for m in res.summary()["missing"]}


@pytest.mark.skipif(not STEP.exists(), reason="the assembled STEP is not on this machine")
def test_real_step_names_parts_by_ref(tmp_path):
    out = tmp_path / "b.glb"
    got = subprocess.run([str(Path(__import__("sys").executable)), "-m", "backend.imports.step3d",
                          str(STEP), str(out)], cwd=HERE.parent, capture_output=True, text=True,
                         timeout=300)
    info = json.loads(got.stdout.strip().splitlines()[-1])
    assert info["parts"]["U2"] == "WIFIM-SMD_ESP32-WROOM-32-N4"
    raw = out.read_bytes()
    n = struct.unpack("<I", raw[12:16])[0]
    names = {x.get("name") for x in json.loads(raw[20:20 + n])["nodes"]}
    assert {"Board", "U2", "LED2", "OLED_MODULE"} <= names


def _kicad_image() -> bool:
    if not shutil.which("docker"):
        return False
    return subprocess.run(["docker", "image", "inspect", "redline-kicad"],
                          capture_output=True).returncode == 0


@pytest.mark.skipif(not _kicad_image(), reason="the redline-kicad image is not built")
def test_kicad_design_file():
    from backend.imports import pipeline
    res = asyncio.run(pipeline.analyse([(KICAD.name, KICAD.read_bytes())], "controller"))
    graph = json.loads(res.artifacts["graph"])
    assert graph["counts"]["components"] == 33 and graph["counts"]["nets"] > 20
    assert all(isinstance(n["pin"], str) for net in graph["nets"] for n in net["nodes"])
    assert any(c["part"] == "C2286" for c in graph["components"])
    assert res.fields["size_mm"] == pytest.approx([50.46, 37.3], abs=0.05)
    assert {"layout", "bottom", "model3d", "pcb"} <= set(res.artifacts)
    assert res.fields["source"].startswith("controller.kicad_pcb")
