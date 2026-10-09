"""Warming: while a model others use is built, a second process imports it
the way they do (backend/build.py, export_model.py --warm).

What has to hold:

- what is warmed is how the models using it import it - the module name
  and the REDLINE_IMPORT_ONLY they set - and nothing for a pinned use, a
  model nobody uses, or with REDLINE_BUILD_WARM=off;
- a warmed import is the cache entry the user's build looks for: that
  build does not run it again, and gets what it would have got;
- the warming process works in a copy of the build directory, so nothing
  it writes is seen by the build;
- when the build made it, warming is seen to the end; when it did not,
  it is stopped.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from backend import build, buildcache, links

REPO = Path(__file__).resolve().parent.parent
pytest.importorskip("build123d")

import test_buildcache as C  # noqa: E402


def _graph(sources: dict[str, str], pins=None) -> links.Graph:
    models = [{"_id": mid, "name": mid.rpartition("/")[2], "source": src}
              for mid, src in sources.items()]
    g = links.Graph()
    g.table = links.module_table(models, [])
    for m in models:
        uses = links.resolve(m["source"], g.table, m["_id"])
        g.add(links.key("model", m["_id"]), {"kind": "model", "id": m["_id"],
                                             "source": m["source"], "version": 1},
              [links.key(u["kind"], u["id"]) for u in uses], (pins or {}).get(m["_id"]))
    return g


def test_what_is_warmed_is_how_its_users_import_it(monkeypatch):
    monkeypatch.delenv("REDLINE_BUILD_WARM", raising=False)
    g = _graph({
        "p/enc": "W = 1\n",
        "p/lid": "import os\nos.environ['REDLINE_IMPORT_ONLY'] = '1'\nimport enc\n",
        "p/base": 'import os\nos.environ["REDLINE_IMPORT_ONLY"] = "1"\nimport enc as E\nimport lid\n',
        "p/plain": "import p__enc\n",
        "p/alone": "X = 2\n"})
    # One model is one module in a build, however it is named in the import.
    assert build.warm_imports(g, "p/enc") == [("p__enc", "1"), ("p__enc", None)]
    assert build.warm_imports(g, "p/lid") == [("p__lid", "1")]
    assert build.warm_imports(g, "p/alone") == []
    monkeypatch.setenv("REDLINE_BUILD_WARM", "off")
    assert build.warm_imports(g, "p/enc") == []


def test_a_pinned_use_is_not_warmed(monkeypatch):
    monkeypatch.delenv("REDLINE_BUILD_WARM", raising=False)
    g = _graph({"p/enc": "W = 1\n", "p/lid": "import enc\n"},
               pins={"p/lid": {"model:p/enc": 3}})
    assert build.warm_imports(g, "p/enc") == []


def _warm(root: Path, name: str, cache: Path, flag: str | None, where: Path):
    """What build.build does: a copy of the build directory, export_model.py
    --warm in it."""
    build._lay_out(root, where)
    env = {**os.environ, "REDLINE_BUILD_CACHE": str(cache)}
    env.pop("REDLINE_IMPORT_ONLY", None)
    out = subprocess.run(
        [sys.executable, str(REPO / "export_model.py"), name, "--models-dir", str(where / "models"),
         "--assets-dir", str(where / "assets"), "--warm", *(["--flag", flag] if flag else [])],
        cwd=where, env=env, capture_output=True, text=True, timeout=300)
    assert out.returncode == 0, out.stdout + out.stderr
    return out.stdout


def test_a_warmed_import_is_what_the_users_build_finds(tmp_path):
    root, models = C.layout(tmp_path)
    C.write(models, "a", C.part_a(tmp_path))
    C.write(models, "t", C.target_using_a())
    (root / "bracket.step").write_text("named by nobody")
    cache = tmp_path / "cache"

    said = _warm(root, "a", cache, "1", tmp_path / "warm")
    assert "warm: a (1)" in said
    assert C.runs(tmp_path, "a") == 1
    out, stats, view = C.export(root, "t", cache)
    assert C.runs(tmp_path, "a") == 1                        # not run again
    assert [h[0] for h in stats["hit"]] == ["a"] and not stats["miss"]

    # The same as a build that ran it itself.
    cold = tmp_path / "cold"
    out2, stats2, view2 = C.export(root, "t", cold)
    assert [m[0] for m in stats2["miss"]] == ["a"]
    assert out == out2 and view == view2


def test_warmed_with_another_flag_is_another_entry(tmp_path):
    root, models = C.layout(tmp_path)
    C.write(models, "a", C.part_a(tmp_path))
    C.write(models, "t", C.target_using_a())
    cache = tmp_path / "cache"
    _warm(root, "a", cache, None, tmp_path / "warm")         # as standalone
    _, stats, _ = C.export(root, "t", cache)                 # t imports it with "1"
    assert [m[0] for m in stats["miss"]] == ["a"]


def test_warming_works_in_a_copy_of_the_build_directory(tmp_path):
    root, models = C.layout(tmp_path)
    C.write(models, "a", "N = 1\n")
    (root / "bracket.step").write_bytes(b"x" * 10)
    (root / "_boards").mkdir()
    (root / "_boards" / "pcb.step").write_bytes(b"y" * 10)
    before = buildcache._files(root)
    where = tmp_path / "warm"
    build._lay_out(root, where)
    (where / "exports" / "w.txt").write_text("written while warming")
    assert buildcache._files(root) == before
    assert (where / "models" / "a.py").read_text() == "N = 1\n"
    assert (where / "bracket.step").read_bytes() == b"x" * 10
    assert (where / "_boards" / "pcb.step").read_bytes() == b"y" * 10
    # The same keys as the build directory's.
    assert buildcache.module_keys(where / "models", where) == buildcache.module_keys(models, root)


def test_warming_is_seen_to_the_end_or_stopped():
    async def go():
        async def sleeper(secs):
            return await asyncio.create_subprocess_exec(sys.executable, "-c",
                                                        f"import time; time.sleep({secs})")
        done = await sleeper(0.3)
        t0 = time.monotonic()
        await build._settle([done], True, time.monotonic() + 30)
        waited = time.monotonic() - t0
        assert done.returncode == 0 and waited >= 0.2

        stopped = await sleeper(30)
        t0 = time.monotonic()
        await build._settle([stopped], False, time.monotonic() + 30)
        assert stopped.returncode not in (None, 0) and time.monotonic() - t0 < 5

        late = await sleeper(30)                              # past the build's deadline
        await build._settle([late], True, time.monotonic() + 0.2)
        assert late.returncode not in (None, 0)
    asyncio.run(go())
