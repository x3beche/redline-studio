"""Bare model imports resolve by the importer's project (backend/modnames.py).

What has to hold:

- `import lid` in a model of top folder P is P's one `lid`, else the
  workspace's one `lid`; otherwise the build stops naming the candidates
  and the line that imports one explicitly (`import iot_fan__parts__lid`);
- per importing module, not per build: iot-fan's dock imported by the
  80 mm station still gets iot-fan's lid; nothing is left in
  sys.modules under the bare name; `from lid import X` and
  `importlib.import_module("lid")` follow the same rule;
- the component cache keys say which model each import resolved to;
- the links graph (uses, used by, the code view's table) is the build's
  answer; a workspace whose names are unique is as it was.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from backend import buildcache, links, modnames

REPO = Path(__file__).resolve().parent.parent

LID_A = "W = 1\nPARTS = []\n"
LID_B = "W = 2\nPARTS = []\n"
DOCK = "import lid\nDW = lid.W\nPARTS = []\n"
OLED = "H = 7\nPARTS = []\n"
STATION = textwrap.dedent("""
    import importlib
    import sys
    import lid
    import dock
    import oled
    from lid import W as LW
    from build123d import Box
    again = importlib.import_module("lid")
    print("got", lid.W, dock.DW, oled.H, LW, again.W, "lid" in sys.modules, dock.lid.W)
    PARTS = [Box(1, 1, 1)]
    """).lstrip()

WORKSPACE = {
    "iot-fan/parts/lid": LID_A,
    "iot-fan/parts/dock": DOCK,
    "iot-fan/purchased/oled": OLED,
    "iot-fan-80mm/parts/lid": LID_B,
    "iot-fan-80mm/assemblies/station": STATION,
}


def lay_out(tmp_path: Path, sources: dict[str, str], target: str) -> Path:
    """What backend/build.py writes: every model under its whole-id module,
    the manifest, the target under its flat name."""
    root = tmp_path / "build"
    models = root / "models"
    models.mkdir(parents=True)
    (root / "assets").mkdir()
    (root / "exports").mkdir()
    names = modnames.Names(list(sources))
    for mid, src in sources.items():
        (models / f"{names.module[mid]}.py").write_text(src)
    (models / modnames.MANIFEST).write_text(names.manifest())
    (models / f"{target.replace('/', '__')}.py").write_text(sources[target])
    return root


def export(root: Path, target: str, cache: Path | str = "off"):
    env = {**os.environ, "REDLINE_BUILD_CACHE": str(cache)}
    env.pop("REDLINE_IMPORT_ONLY", None)
    return subprocess.run(
        [sys.executable, str(REPO / "export_model.py"), target.replace("/", "__"),
         "--models-dir", str(root / "models"), "--assets-dir", str(root / "assets")],
        cwd=root, env=env, capture_output=True, text=True, timeout=300)


# ---------------------------------------------------------------- the rule

def test_the_rule():
    n = modnames.Names(["iot-fan/parts/lid", "iot-fan/purchased/oled", "iot-fan-80mm/parts/lid",
                        "p/a/lid", "p/b/lid", "stand"])
    assert n.module["iot-fan-80mm/parts/lid"] == "iot_fan_80mm__parts__lid"
    assert n.resolve("lid", "iot-fan/assemblies/station") == "iot-fan/parts/lid"
    assert n.resolve("lid", "iot-fan-80mm/assemblies/station") == "iot-fan-80mm/parts/lid"
    assert n.resolve("oled", "iot-fan-80mm/assemblies/station") == "iot-fan/purchased/oled"
    assert n.resolve("stand", "iot-fan/x") == "stand"
    assert n.resolve("iot_fan__parts__lid", "p/x") == "iot-fan/parts/lid"     # the whole id
    assert n.resolve("os", "p/x") is None
    with pytest.raises(modnames.Ambiguous) as e:
        n.resolve("lid", "p/asm")                    # two in p
    assert e.value.candidates == ["p/a/lid", "p/b/lid"]
    assert "`import p__a__lid as lid`" in str(e.value) and "2 models in p/" in str(e.value)
    with pytest.raises(modnames.Ambiguous) as e:
        n.resolve("lid", "elsewhere/asm")            # none in its project, four in all
    assert len(e.value.candidates) == 4


def test_whole_id_names_are_identifiers_and_unique():
    n = modnames.Names(["a-b/x", "a_b/x", "3d/part"])
    assert all(q.isidentifier() for q in n.module.values())
    assert len(set(n.module.values())) == 3
    assert n.module["3d/part"] == "_3d__part"


# ---------------------------------------------------------------- the build

def test_two_projects_with_the_same_names_each_get_their_own(tmp_path):
    root = lay_out(tmp_path, WORKSPACE, "iot-fan-80mm/assemblies/station")
    out = export(root, "iot-fan-80mm/assemblies/station")
    assert out.returncode == 0, out.stdout + out.stderr
    # Its own lid (2); iot-fan's dock with iot-fan's lid (1) - per importing
    # module; iot-fan's unique oled; from-import and import_module the
    # same; no "lid" left in sys.modules.
    assert "got 2 1 7 2 2 False 1" in out.stdout


def test_an_ambiguous_name_stops_the_build_and_says_what_to_write(tmp_path):
    src = {"p/a/lid": LID_A, "p/b/lid": LID_B,
           "p/asm": "import lid\nfrom build123d import Box\nPARTS = [Box(1, 1, 1)]\n"}
    out = export(lay_out(tmp_path, src, "p/asm"), "p/asm")
    assert out.returncode != 0
    text = out.stdout + out.stderr
    assert "`import lid` in p/asm is ambiguous" in text
    assert "p/a/lid" in text and "`import p__b__lid as lid`" in text


def test_the_explicit_name_always_works(tmp_path):
    src = {"p/a/lid": LID_A, "p/b/lid": LID_B,
           "p/asm": "import p__b__lid as lid\nfrom build123d import Box\nprint('w', lid.W)\n"
                    "PARTS = [Box(1, 1, 1)]\n"}
    out = export(lay_out(tmp_path, src, "p/asm"), "p/asm")
    assert out.returncode == 0, out.stdout + out.stderr
    assert "w 2" in out.stdout


def test_cached_builds_keep_the_projects_apart(tmp_path):
    root = lay_out(tmp_path, WORKSPACE, "iot-fan-80mm/assemblies/station")
    cache = tmp_path / "cache"
    first = export(root, "iot-fan-80mm/assemblies/station", cache)
    assert first.returncode == 0, first.stdout + first.stderr
    stats = json.loads((root / "assets" / "iot-fan-80mm__assemblies__station.cache.json").read_text())
    assert {m[0] for m in stats["miss"]} == {"iot_fan__parts__lid", "iot_fan_80mm__parts__lid",
                                            "iot_fan__parts__dock", "iot_fan__purchased__oled"}
    again = export(root, "iot-fan-80mm/assemblies/station", cache)
    assert again.returncode == 0, again.stdout + again.stderr
    assert "got 2 1 7 2 2 False 1" in again.stdout
    stats = json.loads((root / "assets" / "iot-fan-80mm__assemblies__station.cache.json").read_text())
    assert not stats["miss"]


def test_cache_keys_name_the_model_each_import_resolved_to(tmp_path):
    root = lay_out(tmp_path, WORKSPACE, "iot-fan-80mm/assemblies/station")
    models = root / "models"
    k1 = buildcache.module_keys(models, root)
    assert k1["iot_fan__parts__lid"] != k1["iot_fan_80mm__parts__lid"]
    # The 80 mm lid changes: the dock (iot-fan's lid) keeps its key.
    (models / "iot_fan_80mm__parts__lid.py").write_text("W = 3\nPARTS = []\n")
    k2 = buildcache.module_keys(models, root)
    assert k2["iot_fan__parts__dock"] == k1["iot_fan__parts__dock"]
    assert k2["iot_fan_80mm__assemblies__station"] != k1["iot_fan_80mm__assemblies__station"]
    # iot-fan's lid changes: the dock follows.
    (models / "iot_fan__parts__lid.py").write_text("W = 4\nPARTS = []\n")
    k3 = buildcache.module_keys(models, root)
    assert k3["iot_fan__parts__dock"] != k2["iot_fan__parts__dock"]


# ---------------------------------------------------------------- links

def _graph(sources: dict[str, str], boards=()) -> links.Graph:
    models = [{"_id": mid, "name": mid.rpartition("/")[2], "source": src}
              for mid, src in sources.items()]
    g = links.Graph()
    g.table = links.module_table(models, list(boards))
    for m in models:
        uses = links.resolve(m["source"], g.table, m["_id"])
        g.add(links.key("model", m["_id"]), {"kind": "model", "id": m["_id"], "title": m["_id"],
                                             "source": m["source"], "version": 1},
              [links.key(u["kind"], u["id"]) for u in uses])
    return g


def test_the_graph_is_the_builds_answer():
    g = _graph(WORKSPACE)
    station = "model:iot-fan-80mm/assemblies/station"
    assert sorted(g.uses[station]) == ["model:iot-fan-80mm/parts/lid", "model:iot-fan/parts/dock",
                                       "model:iot-fan/purchased/oled"]
    assert g.uses["model:iot-fan/parts/dock"] == ["model:iot-fan/parts/lid"]
    assert g.used_by("model:iot-fan-80mm/parts/lid") == [station]
    assert g.dependents("model:iot-fan/parts/lid") == sorted(["model:iot-fan/parts/dock", station])

    rows = links.table_rows(g)
    assert rows["lid"]["id"] is None and rows["lid"]["in"]["iot-fan"]["id"] == "iot-fan/parts/lid"
    assert rows["lid"]["in"]["iot-fan-80mm"]["id"] == "iot-fan-80mm/parts/lid"
    assert rows["oled"]["id"] == "iot-fan/purchased/oled"
    assert rows["iot_fan__parts__lid"]["id"] == "iot-fan/parts/lid"

    t = g.table
    assert links.module_for("model", "iot-fan/parts/lid", t) == "iot_fan__parts__lid"
    assert links.module_for("model", "iot-fan/parts/lid", t, "iot-fan/x") == "lid"
    assert links.module_for("model", "iot-fan/parts/lid", t, "iot-fan-80mm/x") == "iot_fan__parts__lid"
    assert links.module_for("model", "iot-fan/purchased/oled", t) == "oled"

    from backend import build
    assert build.warm_imports(g, "iot-fan/parts/lid") == [("iot_fan__parts__lid", None)]


def test_an_ambiguous_import_is_no_edge_and_is_said():
    src = {"p/a/lid": LID_A, "p/b/lid": LID_B, "p/asm": "import lid\n"}
    g = _graph(src)
    assert g.uses["model:p/asm"] == []
    amb = links.ambiguous(src["p/asm"], g.table, "p/asm")
    assert [a["module"] for a in amb] == ["lid"] and amb[0]["use"] == ["p__a__lid", "p__b__lid"]


def test_unique_names_are_as_they_were():
    src = {"iot-fan/parts/stand": "W = 1\n", "iot-fan/assemblies/asm": "import stand\n",
           "root": "import stand\n"}
    g = _graph(src, [{"_id": "demo-board"}, {"_id": "stand"}])
    assert g.table["stand"] == ("model", "iot-fan/parts/stand")
    assert g.table["demo_board"] == ("board", "demo-board")
    assert g.table["pcb_stand"] == ("board", "stand")           # the model keeps the plain name
    assert g.uses["model:iot-fan/assemblies/asm"] == ["model:iot-fan/parts/stand"]
    assert g.uses["model:root"] == ["model:iot-fan/parts/stand"]
    assert links.module_for("model", "iot-fan/parts/stand", g.table) == "stand"
    assert links.table_rows(g)["stand"] == {"kind": "model", "id": "iot-fan/parts/stand",
                                            "title": "iot-fan/parts/stand"}


def test_a_warmed_component_is_what_the_build_of_another_project_uses(tmp_path):
    root = lay_out(tmp_path, WORKSPACE, "iot-fan-80mm/assemblies/station")
    cache = tmp_path / "cache"
    env = {**os.environ, "REDLINE_BUILD_CACHE": str(cache)}
    env.pop("REDLINE_IMPORT_ONLY", None)
    warm = subprocess.run(
        [sys.executable, str(REPO / "export_model.py"), "iot_fan__parts__dock",
         "--models-dir", str(root / "models"), "--assets-dir", str(root / "assets"), "--warm"],
        cwd=root, env=env, capture_output=True, text=True, timeout=300)
    assert warm.returncode == 0, warm.stdout + warm.stderr
    out = export(root, "iot-fan-80mm/assemblies/station", cache)
    assert out.returncode == 0, out.stdout + out.stderr
    assert "got 2 1 7 2 2 False 1" in out.stdout
    stats = json.loads((root / "assets" / "iot-fan-80mm__assemblies__station.cache.json").read_text())
    assert "iot_fan__parts__dock" in [h[0] for h in stats["hit"]]
    assert "iot_fan__parts__dock" not in [m[0] for m in stats["miss"]]
