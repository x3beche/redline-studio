"""The component result cache (backend/buildcache.py).

What has to hold:

- a model's key changes when its source, anything it imports (at any
  depth), a file it names or REDLINE_IMPORT_ONLY changes - and only then;
- a model imported from the cache is not run, and what the importer
  gets is the same: numbers, shapes (volume, box, labels, colours,
  children), its functions, what it printed and set in os.environ;
- a name the cache could not keep runs the real source on first use;
- a pinned version is its own entry: going back to it is a hit;
- two builds that need the same entry compute it once;
- a large STEP is parsed once per content;
- link rebuilds run a few at a time, in dependency order.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from backend import buildcache

REPO = Path(__file__).resolve().parent.parent
pytest.importorskip("build123d")


def write(models: Path, name: str, src: str) -> None:
    (models / f"{name}.py").write_text(textwrap.dedent(src).lstrip())


def layout(tmp_path: Path) -> tuple[Path, Path]:
    root = tmp_path / "build"
    models = root / "models"
    models.mkdir(parents=True)
    (root / "assets").mkdir()
    (root / "exports").mkdir()
    return root, models


def export(root: Path, target: str, cache: Path, extra_env: dict | None = None):
    env = {**os.environ, "REDLINE_BUILD_CACHE": str(cache), **(extra_env or {})}
    env.pop("REDLINE_IMPORT_ONLY", None)
    out = subprocess.run(
        [sys.executable, str(REPO / "export_model.py"), target,
         "--models-dir", str(root / "models"), "--assets-dir", str(root / "assets")],
        cwd=root, env=env, capture_output=True, text=True, timeout=300)
    assert out.returncode == 0, out.stdout + out.stderr
    stats = json.loads((root / "assets" / f"{target}.cache.json").read_text())
    viewer = json.loads((root / "assets" / f"{target}.json").read_text())
    return out.stdout, stats, viewer


def runs(tmp_path: Path, name: str) -> int:
    p = tmp_path / f"runs-{name}"
    return len(p.read_text()) if p.exists() else 0


COUNT = """
import os
with open({path!r}, "a") as _f:
    _f.write("x")
"""


def part_a(tmp_path, w=10.0):
    return COUNT.format(path=str(tmp_path / "runs-a")) + textwrap.dedent(f"""
        os.environ["A_RAN"] = "yes"
        from build123d import Box, Pos, Color, Compound, Location, Plane, Vector, Axis
        W = {w}
        SIZES = {{"w": W, "list": [1, 2.5, None, True, "s"], "t": (1, 2)}}
        body = Box(W, 4, 2)
        body.label = "body"
        body.color = Color(0.2, 0.4, 0.6)
        lug = Pos(W, 0, 0) * Box(1, 1, 1)
        lug.label = "lug"
        asm = Compound(label="asm", children=[body, lug])
        PLACE = Location((1, 2, 3), (10, 20, 30))
        PLANE = Plane(origin=(1, 2, 3), z_dir=(0, 1, 1))
        V = Vector(1, 2, 3)
        AX = Axis.Z
        top = body.faces().sort_by(Axis.Z)[-1]

        def grow(k):
            return Box(W * k, 4, 2)

        class Spec:
            size = 3

        twice = lambda x: 2 * x
        print("a: W =", W)
        """)


def target_using_a(extra: str = "") -> str:
    return textwrap.dedent("""
        import os
        os.environ["REDLINE_IMPORT_ONLY"] = "1"
        import a
        from build123d import Pos
        g = a.grow(2)
        PARTS = [a.asm, Pos(0, 0, 10) * g]
        NAMES = ["asm", "grown"]
        print("t:", a.W, a.SIZES, a.body.volume, a.top.area, a.PLACE.position, a.PLANE.z_dir,
              a.V, a.AX.direction, a.Spec.size, os.environ.get("A_RAN"),
              [c.label for c in a.asm.children], a.body.color, a.asm.children[0] is a.body)
        """) + textwrap.dedent(extra)


# ---------------------------------------------------------------- keys

def test_a_key_follows_source_imports_and_named_files(tmp_path):
    root, models = layout(tmp_path)
    write(models, "a", "W = 1\n")
    write(models, "b", "import a\n")
    write(models, "c", "import b\n")
    write(models, "d", "X = open('bracket.step')\n")
    write(models, "loop1", "import loop2\n")
    write(models, "loop2", "import loop1\n")
    (root / "bracket.step").write_text("one")
    k1 = buildcache.module_keys(models, root)
    assert "loop1" not in k1 and "loop2" not in k1          # a cycle has no key

    write(models, "a", "W = 2\n")
    k2 = buildcache.module_keys(models, root)
    assert k2["a"] != k1["a"] and k2["b"] != k1["b"] and k2["c"] != k1["c"]
    assert k2["d"] == k1["d"]

    (root / "bracket.step").write_text("two")
    k3 = buildcache.module_keys(models, root)
    assert k3["d"] != k2["d"] and k3["c"] == k2["c"]

    write(models, "a", "W = 1\n")                            # back to the first source
    (root / "bracket.step").write_text("one")
    assert buildcache.module_keys(models, root) == k1

    assert buildcache.variant(k1["a"], "1") != buildcache.variant(k1["a"], None)


def test_the_key_reading_of_imports_matches_links():
    from backend import links
    src = textwrap.dedent("""
        import os, a.b as x
        from c import d
        from . import rel
        import importlib
        m = importlib.import_module("e")
        n = __import__("f")
        """)
    assert set(buildcache.imported_names(src)) == set(links.imported_names(src))


# ---------------------------------------------------------------- loading

def test_an_import_comes_from_the_cache_and_is_the_same(tmp_path):
    root, models = layout(tmp_path)
    write(models, "a", part_a(tmp_path))
    write(models, "t", target_using_a())
    cache = tmp_path / "cache"

    out1, stats1, view1 = export(root, "t", cache)
    assert runs(tmp_path, "a") == 1 and [m[0] for m in stats1["miss"]] == ["a"]

    out2, stats2, view2 = export(root, "t", cache)
    assert runs(tmp_path, "a") == 1                          # not run again
    assert [h[0] for h in stats2["hit"]] == ["a"] and not stats2["fallback"]
    assert out2 == out1                                      # prints, values, labels, colours
    assert "a: W = 10.0" in out2 and "yes" in out2
    assert view2 == view1                                    # the viewer payload, exactly


def test_a_name_the_cache_could_not_keep_runs_the_source(tmp_path):
    root, models = layout(tmp_path)
    write(models, "a", part_a(tmp_path))
    write(models, "t", target_using_a("print('lambda:', a.twice(21))\n"))
    cache = tmp_path / "cache"
    out1, _, view1 = export(root, "t", cache)
    out2, stats, view2 = export(root, "t", cache)
    assert stats["fallback"] == ["a"]
    assert runs(tmp_path, "a") == 2                          # the source, on first use
    assert "lambda: 42" in out2 and view2 == view1


def entry(cache: Path, module: str) -> dict:
    metas = [json.loads(p.read_text()) for p in cache.glob("m/*/*/meta.json")]
    return next(m for m in metas if m["module"] == module)


def test_what_a_star_import_binds_is_kept_as_a_reference(tmp_path):
    root, models = layout(tmp_path)
    write(models, "s", """
        from build123d import *
        W = 3
        def plate(k):
            return extrude(Rectangle(W * k, 2), 1).edges().filter_by(Axis.Z)
        later = lambda: 1
        """)
    write(models, "t", """
        import os
        os.environ["REDLINE_IMPORT_ONLY"] = "1"
        import s
        PARTS = [s.Box(s.W, 1, 1)]
        print(len(s.plate(2)), s.Align.MIN, s.import_step.__name__)
        """)
    cache = tmp_path / "cache"
    out1, _, _ = export(root, "t", cache)
    out2, stats, _ = export(root, "t", cache)
    assert out1 == out2 and not stats["fallback"]
    assert entry(cache, "s")["unkept"] == ["later"]


def test_functions_keep_their_def_time_defaults_and_other_models_tuples(tmp_path):
    root, models = layout(tmp_path)
    write(models, "kinds", """
        from typing import NamedTuple
        class Hole(NamedTuple):
            x: float
            d: float = 3.0
        """)
    write(models, "user", """
        import kinds
        HOLES = [kinds.Hole(1.5), kinds.Hole(4, 2.5)]
        G = 2
        def scaled(x, k=G, *, by=G + 1):
            return x * k * by
        G = 5
        bad = lambda: 0             # not kept; the parameter below is not it
        def shadow(bad):
            return bad + G
        """)
    write(models, "t", """
        import os
        os.environ["REDLINE_IMPORT_ONLY"] = "1"
        import user, kinds
        from build123d import Box
        PARTS = [Box(1, 1, 1)]
        print(user.scaled(1), user.shadow(1), user.HOLES, isinstance(user.HOLES[0], kinds.Hole))
        """)
    cache = tmp_path / "cache"
    out1, _, _ = export(root, "t", cache)
    out2, stats, _ = export(root, "t", cache)
    assert "6 6 [Hole(x=1.5, d=3.0), Hole(x=4, d=2.5)] True" in out1
    assert out2 == out1 and not stats["fallback"]
    assert sorted(h[0] for h in stats["hit"]) == ["kinds", "user"]
    assert entry(cache, "user")["unkept"] == ["bad"]


def test_a_missing_name_is_an_attribute_error_without_running_anything(tmp_path):
    root, models = layout(tmp_path)
    write(models, "a", part_a(tmp_path))
    write(models, "t", target_using_a("assert not hasattr(a, 'NOPE')\n"
                                      "assert getattr(a, 'NOPE', 7) == 7\n"))
    cache = tmp_path / "cache"
    export(root, "t", cache)
    _, stats, _ = export(root, "t", cache)
    assert runs(tmp_path, "a") == 1 and not stats["fallback"]


def test_a_changed_component_is_run_again_and_what_uses_it_follows(tmp_path):
    root, models = layout(tmp_path)
    write(models, "a", part_a(tmp_path))
    write(models, "b", """
        import os
        os.environ["REDLINE_IMPORT_ONLY"] = "1"
        import a
        WIDE = a.W * 2
        """)
    write(models, "c", "Z = 5\n")
    write(models, "t", """
        import os
        os.environ["REDLINE_IMPORT_ONLY"] = "1"
        import b, c
        from build123d import Box
        PARTS = [Box(b.WIDE, 1, c.Z)]
        print("wide", b.WIDE)
        """)
    cache = tmp_path / "cache"
    out1, s1, _ = export(root, "t", cache)
    assert "wide 20.0" in out1 and sorted(m[0] for m in s1["miss"]) == ["a", "b", "c"]
    _, s2, _ = export(root, "t", cache)
    assert sorted(h[0] for h in s2["hit"]) == ["b", "c"]     # b's result: a is not even read

    write(models, "a", part_a(tmp_path, w=12.5))             # the component changes
    out3, s3, _ = export(root, "t", cache)
    assert "wide 25.0" in out3                               # not the stale 20
    assert sorted(m[0] for m in s3["miss"]) == ["a", "b"]
    assert [h[0] for h in s3["hit"]] == ["c"]


def test_a_pinned_version_has_its_own_entry(tmp_path):
    root, models = layout(tmp_path)
    write(models, "t", target_using_a())
    cache = tmp_path / "cache"
    write(models, "a", part_a(tmp_path, w=10.0))             # v1
    out_v1, _, _ = export(root, "t", cache)
    write(models, "a", part_a(tmp_path, w=11.0))             # v2
    out_v2, _, _ = export(root, "t", cache)
    assert runs(tmp_path, "a") == 2 and out_v1 != out_v2
    write(models, "a", part_a(tmp_path, w=10.0))             # pinned back at v1
    out_pin, stats, _ = export(root, "t", cache)
    assert runs(tmp_path, "a") == 2 and [h[0] for h in stats["hit"]] == ["a"]
    assert out_pin == out_v1


def test_standalone_and_imported_are_different_entries(tmp_path):
    root, models = layout(tmp_path)
    write(models, "p", """
        import os
        STANDALONE = os.environ.get("REDLINE_IMPORT_ONLY") != "1"
        MODE = "alone" if STANDALONE else "imported"
        """)
    write(models, "t1", "import p\nfrom build123d import Box\nPARTS = [Box(1, 1, 1)]\nprint(p.MODE)\n")
    write(models, "t2", "import os\nos.environ['REDLINE_IMPORT_ONLY'] = '1'\nimport p\n"
                        "from build123d import Box\nPARTS = [Box(1, 1, 1)]\nprint(p.MODE)\n")
    cache = tmp_path / "cache"
    assert "alone" in export(root, "t1", cache)[0]
    assert "imported" in export(root, "t2", cache)[0]
    out, stats, _ = export(root, "t1", cache)
    assert "alone" in out and [h[0] for h in stats["hit"]] == ["p"]


def test_a_module_that_writes_files_when_imported_is_not_kept(tmp_path):
    root, models = layout(tmp_path)
    write(models, "w", "open('exports/w.txt', 'w').write('x')\nN = 1\n")
    write(models, "t", "import w\nfrom build123d import Box\nPARTS = [Box(1, 1, 1)]\n")
    cache = tmp_path / "cache"
    _, stats, _ = export(root, "t", cache)
    assert "w" in stats["unkept"]
    _, stats, _ = export(root, "t", cache)
    assert not stats["hit"]


def test_two_builds_needing_the_same_entry_compute_it_once(tmp_path):
    cache = tmp_path / "cache"
    procs = []
    for i in range(2):
        root, models = layout(tmp_path / f"b{i}")
        write(models, "slow", COUNT.format(path=str(tmp_path / "runs-slow"))
              + "import time\ntime.sleep(2)\nN = 3\n")
        write(models, "t", "import slow\nfrom build123d import Box\nPARTS = [Box(slow.N, 1, 1)]\n")
        env = {**os.environ, "REDLINE_BUILD_CACHE": str(cache)}
        procs.append(subprocess.Popen(
            [sys.executable, str(REPO / "export_model.py"), "t", "--models-dir", str(models),
             "--assets-dir", str(root / "assets")], cwd=root, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT))
    for p in procs:
        assert p.wait(timeout=300) == 0, p.stdout.read()
    assert runs(tmp_path, "slow") == 1


def test_off_means_off(tmp_path, monkeypatch):
    monkeypatch.setenv("REDLINE_BUILD_CACHE", "off")
    assert buildcache.directory() is None
    root, models = layout(tmp_path)
    assert buildcache.install(models, root) is None


# ---------------------------------------------------------------- values

def test_shapes_and_values_survive_the_round_trip(tmp_path):
    from build123d import Box, Color, Compound, Location, Plane, Pos, Vector, Axis, ShapeList, Align
    body = Box(3, 4, 5)
    body.label, body.color = "body", Color(0.1, 0.2, 0.3, 0.5)
    lug = Pos(5, 0, 0) * Box(1, 1, 1)
    lug.label = "lug"
    asm = Compound(label="asm", children=[body, lug])
    value = {"asm": asm, "body": body, "both": [body, body], "loc": Location((1, 2, 3), (4, 5, 6)),
             "plane": Plane(origin=(1, 2, 3), x_dir=(1, 0, 0), z_dir=(0, -1, 0)),
             "v": Vector(1.5, -2, 3), "axis": Axis.X, "faces": body.faces(), "align": Align.MIN,
             "n": [1, 2.25, float("inf"), None, "x", (1, (2, 3))], "k": {(1, 2): "tuple key"},
             "box": lug.bounding_box(optimal=False)}
    meta, enc = buildcache.encode_value(value)
    store = buildcache.Store(tmp_path)
    store.write("step", "k" * 64, meta, enc)
    got_meta, shapes = store.read("step", "k" * 64)
    got = buildcache.Decoder(got_meta["objects"], shapes).dec(got_meta["value"])

    assert got["n"] == value["n"] and got["k"] == value["k"] and got["align"] is Align.MIN
    assert got["both"][0] is got["both"][1] is got["body"]
    assert got["asm"].children[0] is got["body"] and got["body"].parent is got["asm"]
    assert [c.label for c in got["asm"].children] == ["body", "lug"]
    assert tuple(got["body"].color) == tuple(body.color)
    assert abs(got["asm"].volume - asm.volume) < 1e-9
    bb, bb0 = got["asm"].bounding_box(), asm.bounding_box()
    assert (tuple(bb.min), tuple(bb.max)) == (tuple(bb0.min), tuple(bb0.max))
    # OCCT re-orthogonalises a rotation when it reads one back (BinTools,
    # BRep and STEP alike): the last bit of a rotated placement may move.
    assert tuple(got["loc"].position) == tuple(value["loc"].position)
    assert tuple(got["loc"].orientation) == pytest.approx(tuple(value["loc"].orientation), abs=1e-12)
    assert got["plane"] == value["plane"] and got["v"] == value["v"]
    assert isinstance(got["faces"], ShapeList) and len(got["faces"]) == 6
    assert got["body"].wrapped.IsSame(got["asm"].children[0].wrapped)
    box = got["box"]
    assert (tuple(box.min), tuple(box.max)) == (tuple(value["box"].min), tuple(value["box"].max))
    assert box.wrapped.GetGap() == value["box"].wrapped.GetGap()
    assert tuple(box.add((9, 9, 9)).max) == tuple(value["box"].add((9, 9, 9)).max)


def test_a_large_step_is_parsed_once(tmp_path, monkeypatch):
    from build123d import Box, Color, Compound, Pos, export_step
    import build123d
    import build123d.importers as importers
    kids = []
    for i in range(3):
        b = Pos(i * 3, 0, 0) * Box(1, 2, 3)
        b.label, b.color = f"part{i}", Color(0.1 * i, 0.5, 0.5)
        kids.append(b)
    step = tmp_path / "board.step"
    export_step(Compound(label="board", children=kids), str(step))
    original = importers.import_step
    monkeypatch.setattr(buildcache, "STEP_MIN", 0)
    calls = []

    def counting(path, *a, **kw):
        calls.append(path)
        return original(path, *a, **kw)

    monkeypatch.setattr(importers, "import_step", counting)
    monkeypatch.setattr(build123d, "import_step", counting)
    stats = {}
    buildcache.wrap_import_step(buildcache.Store(tmp_path / "cache"), stats)
    first = build123d.import_step(step)
    second = build123d.import_step(step)
    assert len(calls) == 1 and stats == {"step_miss": 1, "step_hit": 1}
    assert [c.label for c in second.children] == [c.label for c in first.children]
    assert [tuple(c.color) for c in second.children] == [tuple(c.color) for c in first.children]
    assert abs(second.volume - first.volume) < 1e-9


# ---------------------------------------------------------------- rebuilds at once

def test_link_rebuilds_default_to_a_few_at_once():
    assert 1 <= buildcache.default_parallel() <= 3


def test_rebuilds_three_at_once_keep_dependency_order(monkeypatch):
    """A wide graph: three independent parts rebuild together, never more,
    and an assembly only after every part it uses is done."""
    import asyncio
    import test_links as T
    from backend import links

    assert links.PARALLEL == int(os.environ.get("REDLINE_LINK_BUILDS") or buildcache.default_parallel())
    monkeypatch.setattr(links, "DEBOUNCE", 0)
    db = T.FakeDb()
    db["models"].rows += [T.model("p/base", "W = 1\n"),
                          *[T.model(f"p/part{i}", "import base\n") for i in range(5)],
                          T.model("p/asm", "import part0\nimport part1\nimport part4\n"),
                          T.model("p/top", "import asm\nimport part2\n")]

    async def go():
        await links.changed(db, "model", "p/base")
        builds = T.Builds(secs=0.1)
        await T.drain(db, links.Scheduler(builds, parallel=3), rounds=200)
        return builds

    builds = asyncio.run(go())
    order = builds.order
    assert builds.most == 3
    assert sorted(order[:5]) == [f"p/part{i}" for i in range(5)]
    assert order[5:] == ["p/asm", "p/top"]
