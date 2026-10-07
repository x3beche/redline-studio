"""docker/route.py run by hand in the KiCad container, outside the pipeline.

An imported board comes with its maker's pours. route.py takes them off
before routing, and it did so with `board.Remove()`, which hands each zone
to its Python wrapper; once Python collected one, KiCad 9's bindings had
lost their types and the next call came back a bare SwigPyObject -
`board.GetTracks()`: "'SwigPyObject' object is not iterable", and with a
pour asked for, `GetBoardEdgesBoundingBox().GetX` missing. The pipeline's
placed boards have no zones, so only a board routed by hand met it.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from backend import kicad

ROOT = Path(__file__).resolve().parent.parent


def test_nothing_is_taken_off_a_board_with_remove():
    # Remove() leaves the item to Python, which is what broke the bindings;
    # discard() (Delete) lets KiCad free it.
    for name in ("route.py", "place.py"):
        text = (ROOT / "docker" / name).read_text()
        assert not re.search(r"\.Remove\(", text), name
        assert "def discard(" in text and "container.Delete(item)" in text


def _have_kicad() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        return subprocess.run(["docker", "image", "inspect", kicad.IMAGE],
                              capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


# A throwaway board as an import leaves it: an outline, two nets to route,
# ground on two pads, and two ground pours - the tracks already taken off.
MAKE = r'''
import pcbnew
MM = 1000000
b = pcbnew.BOARD()
for (x0, y0, x1, y1) in [(0, 0, 30, 0), (30, 0, 30, 15), (30, 15, 0, 15), (0, 15, 0, 0)]:
    s = pcbnew.PCB_SHAPE(b); s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetStart(pcbnew.VECTOR2I(x0 * MM, y0 * MM)); s.SetEnd(pcbnew.VECTOR2I(x1 * MM, y1 * MM))
    s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(int(0.1 * MM)); b.Add(s)
nets = {}
for name in ("A", "B", "GND"):
    n = pcbnew.NETINFO_ITEM(b, name); b.Add(n); nets[name] = n
for ref, x, y, net in (("A1", 5, 4, "A"), ("A2", 25, 11, "A"), ("B1", 5, 11, "B"),
                       ("B2", 25, 4, "B"), ("G1", 15, 3, "GND"), ("G2", 15, 12, "GND")):
    fp = pcbnew.FOOTPRINT(b); fp.SetReference(ref); fp.SetPosition(pcbnew.VECTOR2I(x * MM, y * MM))
    fp.SetFPID(pcbnew.LIB_ID("", "TP")); fp.SetValue("TP")
    p = pcbnew.PAD(fp); p.SetShape(pcbnew.PAD_SHAPE_CIRCLE); p.SetAttribute(pcbnew.PAD_ATTRIB_PTH)
    p.SetLayerSet(p.PTHMask()); p.SetSize(pcbnew.VECTOR2I(int(1.6 * MM), int(1.6 * MM)))
    p.SetDrillSize(pcbnew.VECTOR2I(int(0.8 * MM), int(0.8 * MM)))
    p.SetNumber("1"); p.SetPosition(pcbnew.VECTOR2I(x * MM, y * MM)); p.SetNet(nets[net])
    fp.Add(p); b.Add(fp)
for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
    z = pcbnew.ZONE(b); z.SetLayer(layer); z.SetNetCode(nets["GND"].GetNetCode())
    o = z.Outline(); o.NewOutline()
    for x, y in ((1, 1), (29, 1), (29, 14), (1, 14)):
        o.Append(x * MM, y * MM)
    b.Add(z)
t = pcbnew.PCB_TRACK(b); t.SetStart(pcbnew.VECTOR2I(5 * MM, 4 * MM))
t.SetEnd(pcbnew.VECTOR2I(25 * MM, 4 * MM)); t.SetWidth(int(0.25 * MM)); t.SetLayer(pcbnew.F_Cu)
t.SetNet(nets["A"]); b.Add(t)
for t in list(b.GetTracks()):          # as the board was stripped of its tracks by hand
    b.Delete(t)
pcbnew.SaveBoard("/work/board.kicad_pcb", b)
print("zones", len(list(b.Zones())))
'''

RULES = {"classes": [{"name": "Default", "track": 0.25, "clearance": 0.2, "via": 0.6,
                      "drill": 0.3, "nets": []}],
         "board": {"min_edge": 0.3}, "route": {"passes": 5}}


def _docker(work: Path, script: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", "run", "--rm", "-i", "-v", f"{work}:/work", "-w", "/work",
                           "--entrypoint", "python3", kicad.IMAGE, script],
                          input=stdin, capture_output=True, text=True, timeout=400)


@pytest.mark.skipif(not _have_kicad(), reason="no KiCad container here")
@pytest.mark.parametrize("pour", [False, True])
def test_route_py_runs_by_hand_on_a_board_with_its_pours(tmp_path, pour):
    work = tmp_path / "w"
    work.mkdir()
    shutil.copy(ROOT / "docker" / "route.py", work / "route.py")
    (work / "make.py").write_text(MAKE)
    work.chmod(0o777)
    made = _docker(work, "/work/make.py")
    assert "zones 2" in made.stdout, made.stdout[-800:] + made.stderr[-800:]
    for f in work.iterdir():
        f.chmod(0o777)
    rules = {**RULES, **({"pour": {"net": "GND", "layers": ["F.Cu", "B.Cu"]}} if pour else {})}
    plan = {"board": "/work/board.kicad_pcb", "out": "/work/routed.kicad_pcb",
            "rules": rules, "timeout": 300}
    run = _docker(work, "/work/route.py", json.dumps(plan))
    assert "SwigPyObject" not in run.stderr, run.stderr[-1500:]
    assert run.returncode == 0, run.stdout[-1500:] + run.stderr[-1500:]
    got = json.loads(run.stdout[run.stdout.index("{"):])
    assert got["tracks"] > 0 and got["unrouted"] == 0
    assert got["zones"] == (2 if pour else 0)
    assert (work / "routed.kicad_pcb").exists()
