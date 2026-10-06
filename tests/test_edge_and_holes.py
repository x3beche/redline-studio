"""The board edge rule and the holes no part owns.

* `board.min_edge` is a rule like the others: in the schema the rules form
  is drawn from, checked, defaulted for rules saved before it existed, and
  set on the board by docker/route.py (and docker/place.py).
* an imported board's rules start from how near its own tracks came to its
  edge; its parts at the edge are let be by DRC, not the rule loosened.
* the drill files' holes that no pad owns - mounting holes, a TO-220's tab
  hole - are carried to the placer, to be put in as MountingHole footprints
  where no placed part already has the hole.
"""

from __future__ import annotations

import asyncio
import io
import json
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

from backend import convert, kicad, rules

ROOT = Path(__file__).resolve().parent.parent


# ---- the rule ----

def test_min_edge_is_a_board_rule_with_kicads_default():
    fresh = rules.derive(["gnd", "vbus", "sig"])
    assert fresh["board"]["min_edge"] == rules.EDGE == 0.5
    field = next(f for f in rules.SCHEMA["board"]["fields"] if f["key"] == "min_edge")
    assert field["type"] == "number" and field["unit"] == "mm" and field["min"] == 0
    assert not rules.check(fresh, ["gnd", "vbus", "sig"])


def test_rules_saved_before_the_edge_rule_get_the_old_behaviour():
    old = rules.derive(["gnd"])
    del old["board"]["min_edge"]
    assert rules.normalise(old)["board"]["min_edge"] == 0.5
    assert not rules.check(old, ["gnd"])                       # not "missing"
    assert rules.merge(old, ["gnd"])["board"]["min_edge"] == 0.5
    assert rules.resolved(old, ["gnd"])["board"]["min_edge"] == 0.5


def test_min_edge_is_checked():
    r = rules.derive(["gnd"])
    r["board"]["min_edge"] = -1
    assert any(p.startswith("board.min_edge:") for p in rules.check(r, ["gnd"]))
    r["board"]["min_edge"] = "close"
    assert any(p.startswith("board.min_edge: not a number") for p in rules.check(r, ["gnd"]))
    r["board"]["min_edge"] = 0
    assert not rules.check(r, ["gnd"])


def test_route_py_sets_the_rule_and_lets_held_parts_be():
    text = (ROOT / "docker" / "route.py").read_text()
    assert 'ds.m_CopperEdgeClearance = nm(b.get("min_edge", 0.5))' in text
    assert "def edge_parts(" in text and "(severity ignore)" in text
    place = (ROOT / "docker" / "place.py").read_text()
    assert "m_CopperEdgeClearance" in place


# ---- what the import says about its edge ----

SQUARE = {"loops": [[{"line": [[0, 0], [50, 0]]}, {"line": [[50, 0], [50, 30]]},
                     {"line": [[50, 30], [0, 30]]}, {"line": [[0, 30], [0, 0]]}]]}


def test_the_edge_rule_starts_from_the_imports_own_tracks():
    # A 0.254 mm track whose edge is 0.373 mm from the outline: 0.35.
    track = (5, 0.5, 20, 0.5, 0.254)
    assert convert.edge_clearance([track], SQUARE) == 0.35
    # Never past KiCad's 0.5, never under what a fab routes to.
    assert convert.edge_clearance([(10, 10, 20, 10, 0.254)], SQUARE) == 0.5
    assert convert.edge_clearance([(5, 0.2, 20, 0.2, 0.254)], SQUARE) == convert.EDGE_FLOOR
    assert convert.edge_clearance([], SQUARE) is None
    assert convert.edge_clearance([track], None) is None


def test_an_arc_in_the_outline_is_followed():
    # A rounded corner: centre (5, 5), radius 5, from (0, 5) to (5, 0).
    outline = {"loops": [[{"arc": [[0, 5], [5 - 5 * 0.7071068, 5 - 5 * 0.7071068], [5, 0]]}]]}
    pts = convert._arc_points(*outline["loops"][0][0]["arc"])
    assert all(abs(((x - 5) ** 2 + (y - 5) ** 2) ** 0.5 - 5) < 1e-6 for x, y in pts)
    assert max(x for x, _ in pts) <= 5 + 1e-9 and min(x for x, _ in pts) >= -1e-9
    # A track 1 mm inside the arc's middle is 1 mm away.
    mx, my = 5 - 4 * 0.7071068, 5 - 4 * 0.7071068
    got = min(convert._seg_dist((mx, my), (mx, my), a, b) for a, b in convert.outline_segments(outline))
    assert got == pytest.approx(1.0, abs=0.02)


# ---- the holes ----

PADS = [{"ref": "Q5", "pin": "1", "x": 95.377, "y": 64.389, "type": "DIP"},
        {"ref": "R1", "pin": "1", "x": 20.0, "y": 20.0, "type": "SMD"}]


def test_a_hole_no_pad_owns_is_free_and_a_pads_is_not():
    hits = [{"x": 10.795, "y": 48.26, "d": 2.032, "plated": False},       # a mounting hole
            {"x": 97.917, "y": 81.915, "d": 3.302, "plated": False},      # Q5's tab
            {"x": 95.377, "y": 64.389, "d": 1.0, "plated": True},         # Q5 pin 1's hole
            {"x": 10.80, "y": 48.26, "d": 2.032, "plated": False}]        # the same hole again
    got = convert.free_holes(hits, PADS)
    assert [(h["x"], h["d"]) for h in got] == [(10.795, 2.032), (97.917, 3.302)]


def _drill(tools: dict[str, float], hits: list[tuple[str, float, float]]) -> bytes:
    head = "M48\nMETRIC,TZ\n" + "".join(f"{t}C{d:.3f}\n" for t, d in tools.items()) + "%\n"
    body = "".join(f"{t}\nX{x}Y{y}\n" for t, x, y in hits)
    return (head + body + "M30\n").encode()


def _zip(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


SOURCES = {
    "Drill_NPTH_Through.DRL": _drill({"T01": 2.032, "T02": 3.302},
                                     [("T01", 10.795, 48.26), ("T01", 40.0, 20.0), ("T02", 97.917, 81.915)]),
    "Drill_PTH_Through.DRL": _drill({"T01": 0.305, "T02": 1.0},
                                    [("T01", 7.0, 7.0), ("T02", 95.377, 64.389)]),
    "Drill_PTH_Through_Via.DRL": _drill({"T01": 0.305}, [("T01", 7.0, 7.0)]),
}


def test_the_drills_holes_come_out_of_an_upload_vias_and_pads_left_out():
    got = convert.import_geometry(_zip(SOURCES), PADS, SQUARE)
    assert sorted((h["x"], h["y"], h["d"], h["plated"]) for h in got["holes"]) == [
        (10.795, 48.26, 2.032, False), (40.0, 20.0, 2.032, False), (97.917, 81.915, 3.302, False)]
    assert got["min_edge"] is None                         # no copper layers in it
    assert convert.import_geometry(None, PADS, SQUARE) == {"holes": [], "min_edge": None}


def test_a_held_plan_carries_the_holes_onto_kicads_page(monkeypatch):
    box = [0, 0, 100, 110]
    hold = {"placement": True, "outline": {"box": box, "loops": SQUARE["loops"]},
            "holes": [{"x": 10.795, "y": 48.26, "d": 2.032, "plated": False}]}

    async def artifact(db, bid, name, coll):
        if name == "pads":
            return json.dumps(PADS).encode()
        raise KeyError(name)
    monkeypatch.setattr(kicad.store, "get_artifact", artifact)
    plan = asyncio.run(kicad.held_plan(None, "b", hold))
    assert plan["holes"] == [{"at": kicad.to_page(box, 10.795, 48.26), "d": 2.032, "plated": False}]
    # The holes are not parts: nothing for the netlist to compare.
    assert set(plan["parts"]) == {"Q5", "R1"}


def test_a_board_converted_before_holes_were_kept_works_them_out(monkeypatch):
    box = [0, 0, 100, 110]
    hold = {"placement": True, "outline": {"box": box, "loops": SQUARE["loops"]}}

    async def artifact(db, bid, name, coll):
        if name == "pads":
            return json.dumps(PADS).encode()
        if name == "sources":
            return _zip(SOURCES)
        raise KeyError(name)
    monkeypatch.setattr(kicad.store, "get_artifact", artifact)
    plan = asyncio.run(kicad.held_plan(None, "b", hold))
    assert sorted(h["d"] for h in plan["holes"]) == [2.032, 2.032, 3.302]


# ---- in KiCad itself, where the container is here ----

def _have_kicad() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        return subprocess.run(["docker", "image", "inspect", kicad.IMAGE],
                              capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


KICAD_CHECK = r'''
import json, sys
sys.path.insert(0, "/work")
import pcbnew, place, route
MM = 1000000
b = pcbnew.BOARD()
for (x0, y0, x1, y1) in [(0, 0, 20, 0), (20, 0, 20, 10), (20, 10, 0, 10), (0, 10, 0, 0)]:
    s = pcbnew.PCB_SHAPE(b); s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetStart(pcbnew.VECTOR2I(x0 * MM, y0 * MM)); s.SetEnd(pcbnew.VECTOR2I(x1 * MM, y1 * MM))
    s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(int(0.1 * MM)); b.Add(s)
for ref, x in (("SW2", 0.3), ("R1", 5)):
    fp = pcbnew.FOOTPRINT(b); fp.SetReference(ref); fp.SetPosition(pcbnew.VECTOR2I(int(x * MM), 5 * MM))
    p = pcbnew.PAD(fp); p.SetShape(pcbnew.PAD_SHAPE_RECTANGLE); p.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
    p.SetLayerSet(p.SMDMask()); p.SetSize(pcbnew.VECTOR2I(int(0.6 * MM), int(0.6 * MM)))
    p.SetNumber("1"); p.SetPosition(pcbnew.VECTOR2I(int(x * MM), 5 * MM)); fp.Add(p); b.Add(fp)
t = pcbnew.PCB_TRACK(b); t.SetStart(pcbnew.VECTOR2I(5 * MM, int(0.2 * MM)))
t.SetEnd(pcbnew.VECTOR2I(15 * MM, int(0.2 * MM))); t.SetWidth(int(0.2 * MM)); t.SetLayer(pcbnew.F_Cu); b.Add(t)
holes = place.free_holes(b, [{"at": [10, 5], "d": 2.032}, {"at": [10.05, 5], "d": 2.032},
                             {"at": [15, 5], "d": 3.302, "plated": True}])
place.edge_rule(b, {"min_edge": 0.3})
pcbnew.SaveBoard("/work/board.kicad_pcb", b)
exempt = route.edge_parts(b, 0.3)
open("/work/board.kicad_dru", "w").write(route.edge_rules(exempt))
b2 = pcbnew.LoadBoard("/work/board.kicad_pcb")
fps = {f.GetReference(): [(int(p.GetAttribute()), p.GetDrillSize().x / MM) for p in f.Pads()]
       for f in b2.GetFootprints()}
print(json.dumps({"holes": holes, "exempt": exempt, "fps": fps,
                  "edge": b2.GetDesignSettings().m_CopperEdgeClearance / MM}))
'''


@pytest.mark.skipif(not _have_kicad(), reason="no KiCad container here")
def test_holes_and_the_edge_in_kicad(tmp_path):
    work = tmp_path / "w"
    work.mkdir()
    for name in ("place.py", "route.py"):
        shutil.copy(ROOT / "docker" / name, work / name)
    (work / "check.py").write_text(KICAD_CHECK)
    work.chmod(0o777)
    run = subprocess.run(["docker", "run", "--rm", "-v", f"{work}:/work", "-w", "/work",
                          "--entrypoint", "python3", kicad.IMAGE, "/work/check.py"],
                         capture_output=True, text=True, timeout=120)
    got = json.loads(run.stdout[run.stdout.index("{"):])
    # One hole, not two: the second is the first again; the plated one has a ring.
    assert [h["ref"] for h in got["holes"]] == ["H1", "H2"]
    assert got["fps"]["H1"] == [[3, 2.032]]                     # NPTH, 2.032 mm
    assert got["fps"]["H2"][0][1] == 3.302
    assert got["edge"] == 0.3
    assert got["exempt"] == ["SW2"]
    for f in work.iterdir():
        f.chmod(0o777)
    subprocess.run(["docker", "run", "--rm", "-v", f"{work}:/work", "-w", "/work", kicad.IMAGE,
                    "pcb", "drc", "--format", "json", "--severity-all", "--output", "drc.json",
                    "board.kicad_pcb"], capture_output=True, timeout=120)
    drc = json.loads((work / "drc.json").read_text())
    edge = [v for v in drc["violations"] if v["type"] == "copper_edge_clearance"]
    # The track is held to 0.3 mm; SW2, at the edge by design, is not flagged.
    assert len(edge) == 1 and "0.3000 mm" in edge[0]["description"]
    assert "Track" in edge[0]["items"][1]["description"]


R0603 = "/usr/share/kicad/footprints/Resistor_SMD.pretty/R_0603_1608Metric.kicad_mod"


def _place(work: Path, plan: dict) -> dict:
    shutil.copy(ROOT / "docker" / "place.py", work / "place.py")
    work.chmod(0o777)
    run = subprocess.run(["docker", "run", "--rm", "-i", "-v", f"{work}:/work", "-w", "/work",
                          "--entrypoint", "python3", kicad.IMAGE, "/work/place.py"],
                         input=json.dumps(plan), capture_output=True, text=True, timeout=180)
    assert run.returncode == 0, run.stdout[-1500:] + run.stderr[-1500:]
    return json.loads(run.stdout[run.stdout.index("{"):run.stdout.rindex("}") + 1])


@pytest.mark.skipif(not _have_kicad(), reason="no KiCad container here")
def test_the_placer_puts_the_free_holes_on_a_held_board_and_packs_as_before(tmp_path):
    comps = [{"ref": "R1", "value": "10k", "footprint": R0603},
             {"ref": "R2", "value": "10k", "footprint": R0603}]
    nets = [{"name": "A", "nodes": [{"ref": "R1", "pin": "1"}, {"ref": "R2", "pin": "1"}]},
            {"name": "B", "nodes": [{"ref": "R1", "pin": "2"}, {"ref": "R2", "pin": "2"}]}]
    held = tmp_path / "held"
    held.mkdir()
    loop = [{"line": [[20, 20], [50, 20]]}, {"line": [[50, 20], [50, 40]]},
            {"line": [[50, 40], [20, 40]]}, {"line": [[20, 40], [20, 20]]}]
    got = _place(held, {"out": "/work/board.kicad_pcb", "components": comps, "nets": nets,
                        "min_edge": 0.25,
                        "hold": {"parts": {"R1": {"pads": {"1": [30.0, 30.0], "2": [31.65, 30.0]}},
                                           "R2": {"pads": {"1": [30.0, 34.0], "2": [31.65, 34.0]}}},
                                 "outline": [loop],
                                 "holes": [{"at": [23, 23], "d": 2.032, "plated": False},
                                           {"at": [47, 37], "d": 3.302, "plated": False}]}})
    assert got["held"] and got["placed"] == 2 and got["held_worst_mm"] < 0.01
    assert [(h["ref"], h["d"]) for h in got["holes"]] == [("H1", 2.032), ("H2", 3.302)]
    text = (held / "board.kicad_pcb").read_text()
    assert text.count('(pad "" np_thru_hole circle') == 2
    assert "(drill 2.032)" in text and "(drill 3.302)" in text
    assert "board_only" in text and "exclude_from_bom" in text
    packed = tmp_path / "packed"
    packed.mkdir()
    got = _place(packed, {"out": "/work/board.kicad_pcb", "components": comps, "nets": nets,
                          "min_edge": 0.3, "edge_clearance": 0.3})
    assert got["placed"] == 2 and "holes" not in got


# ---- a hole that is a part's own: a lying TO-220's tab ----

TO220_UPRIGHT = "/usr/share/kicad/footprints/Package_TO_SOT_THT.pretty/TO-220-3_Vertical.kicad_mod"


def _body_hole_owner():
    """place.py's body_hole_owner, without pcbnew: its source run alone."""
    import ast
    import math
    src = (ROOT / "docker" / "place.py").read_text()
    tree = ast.parse(src)
    keep = [n for n in tree.body
            if (isinstance(n, ast.FunctionDef) and n.name == "body_hole_owner")
            or (isinstance(n, ast.Assign) and any(getattr(t, "id", "") in ("BODY_REACH", "BODY_SIDE")
                                                  for t in n.targets))]
    space = {"math": math}
    exec(compile(ast.Module(body=keep, type_ignores=[]), "place.py", "exec"), space)
    return space["body_hole_owner"]


# The demo board's Q5 on KiCad's page: three pads in a row, the import's
# centroid 6.35 mm off them toward the body, the tab hole 17.5 mm out; H2,
# a mounting hole, 3 mm behind the pads and to the side.
Q5 = {"pads": {"1": [106.741, 60.259], "2": [109.281, 60.259], "3": [111.821, 60.259]},
      "at": [109.281, 53.909]}
R1 = {"pads": {"1": [30.0, 30.0], "2": [31.65, 30.0]}, "at": [30.825, 30.0]}


def test_the_tab_hole_is_the_lying_parts_and_a_mounting_hole_nobodys():
    owner = _body_hole_owner()
    parts = {"Q5": Q5, "R1": R1}
    assert owner({"at": [109.281, 42.733]}, parts) == "Q5"          # the tab hole
    assert owner({"at": [113.472, 63.307]}, parts) is None          # H2, behind the pads
    assert owner({"at": [109.281, 20.0]}, parts) is None            # far beyond the body
    assert owner({"at": [125.0, 42.733]}, parts) is None            # off to the side
    # A part whose centroid is over its pads owns no far hole.
    assert owner({"at": [30.825, 20.0]}, parts) is None


@pytest.mark.skipif(not _have_kicad(), reason="no KiCad container here")
def test_a_lying_parts_tab_hole_goes_in_the_part_and_its_courtyard_lies_with_it(tmp_path):
    comps = [{"ref": "Q5", "value": "IRL540N", "footprint": TO220_UPRIGHT}]
    nets = [{"name": "G", "nodes": [{"ref": "Q5", "pin": "1"}]}]
    loop = [{"line": [[95, 35], [125, 35]]}, {"line": [[125, 35], [125, 70]]},
            {"line": [[125, 70], [95, 70]]}, {"line": [[95, 70], [95, 35]]}]
    work = tmp_path / "w"
    work.mkdir()
    got = _place(work, {"out": "/work/board.kicad_pcb", "components": comps, "nets": nets,
                        "hold": {"parts": {"Q5": Q5}, "outline": [loop],
                                 "holes": [{"at": [109.281, 42.733], "d": 3.302},
                                           {"at": [113.472, 63.307], "d": 2.032}]}})
    assert [h.get("ref") or ("part", h.get("part")) for h in got["holes"]] == [("part", "Q5"), "H1"]
    for f in work.iterdir():
        f.chmod(0o777)
    subprocess.run(["docker", "run", "--rm", "-v", f"{work}:/work", "-w", "/work", kicad.IMAGE,
                    "pcb", "drc", "--format", "json", "--severity-all", "--output", "drc.json",
                    "board.kicad_pcb"], capture_output=True, timeout=120)
    drc = json.loads((work / "drc.json").read_text())
    kinds = {v["type"] for v in drc["violations"]}
    # The upright body's courtyard reached over H2; the lying one's does not.
    assert "courtyards_overlap" not in kinds and "malformed_courtyard" not in kinds
    text = (work / "board.kicad_pcb").read_text()
    q5 = text[text.index('(footprint "TO-220-3_Vertical"'):]
    q5 = q5[:q5.index('\n\t(footprint ') if '\n\t(footprint ' in q5 else len(q5)]
    assert '(pad "" np_thru_hole circle' in q5 and "(drill 3.302)" in q5


# ---- what a first routing pass leaves over, routed first ----

ROUTE_CHECK = r'''
import json, sys
sys.path.insert(0, "/work")
import pcbnew, route
MM = 1000000
b = pcbnew.BOARD()
for (x0, y0, x1, y1) in [(0, 0, 30, 0), (30, 0, 30, 15), (30, 15, 0, 15), (0, 15, 0, 0)]:
    s = pcbnew.PCB_SHAPE(b); s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetStart(pcbnew.VECTOR2I(x0 * MM, y0 * MM)); s.SetEnd(pcbnew.VECTOR2I(x1 * MM, y1 * MM))
    s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(int(0.1 * MM)); b.Add(s)
nets = {}
for name in ("A", "B"):
    n = pcbnew.NETINFO_ITEM(b, name); b.Add(n); nets[name] = n
for ref, x, y, net in (("A1", 5, 5, "A"), ("A2", 25, 10, "A"), ("B1", 5, 10, "B"), ("B2", 25, 5, "B")):
    fp = pcbnew.FOOTPRINT(b); fp.SetReference(ref); fp.SetPosition(pcbnew.VECTOR2I(x * MM, y * MM))
    fp.SetFPID(pcbnew.LIB_ID("", "TP")); fp.SetValue("TP")
    p = pcbnew.PAD(fp); p.SetShape(pcbnew.PAD_SHAPE_CIRCLE); p.SetAttribute(pcbnew.PAD_ATTRIB_PTH)
    p.SetLayerSet(p.PTHMask()); p.SetSize(pcbnew.VECTOR2I(int(1.6 * MM), int(1.6 * MM)))
    p.SetDrillSize(pcbnew.VECTOR2I(int(0.8 * MM), int(0.8 * MM)))
    p.SetNumber("1"); p.SetPosition(pcbnew.VECTOR2I(x * MM, y * MM)); p.SetNet(nets[net])
    fp.Add(p); b.Add(fp)
pcbnew.SaveBoard("/work/board.kicad_pcb", b)
rules = {"classes": [{"name": "Default", "track": 0.25, "clearance": 0.2, "via": 0.6,
                      "drill": 0.3, "nets": []}], "board": {"min_edge": 0.3}}
done, got = route.leftovers_first("/work/board.kicad_pcb", rules, ["A"], 5, 120)
if done is None:
    print("FAILED", {k: v for k, v in got.items() if k != "log"}, (got.get("log") or "")[-800:])
    sys.exit(1)
left = route.left_unrouted("  Net 'L_SCL' (1 unrouted connection):\n  Net 'p4' (3 unrouted connections):")
by = {}
for t in done.GetTracks():
    by.setdefault(t.GetNetname(), 0); by[t.GetNetname()] += 1
print(json.dumps({"tracks": by, "unrouted": route.unrouted_count(done), "parsed": left}))
'''


@pytest.mark.skipif(not _have_kicad(), reason="no KiCad container here")
def test_the_leftovers_are_routed_first_and_kept_through_the_second_pass(tmp_path):
    work = tmp_path / "w"
    work.mkdir()
    shutil.copy(ROOT / "docker" / "route.py", work / "route.py")
    (work / "check.py").write_text(ROUTE_CHECK)
    work.chmod(0o777)
    run = subprocess.run(["docker", "run", "--rm", "-v", f"{work}:/work", "-w", "/work",
                          "--entrypoint", "python3", kicad.IMAGE, "/work/check.py"],
                         capture_output=True, text=True, timeout=400)
    assert "{" in run.stdout, run.stdout[-1500:] + run.stderr[-1500:]
    got = json.loads(run.stdout[run.stdout.index("{"):])
    assert got["parsed"] == ["L_SCL", "p4"]
    # A's tracks, routed alone, survive the second pass's session (which
    # does not carry a locked wire), and B is routed round them.
    assert got["tracks"].get("A") and got["tracks"].get("B")
    assert got["unrouted"] == 0
