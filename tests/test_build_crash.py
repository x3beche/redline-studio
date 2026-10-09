"""A build process that dies natively (2026-10-09: station_80's link rebuild
aborted in glibc, "double free or corruption (out)", and the eight lines
kept said nothing about where).

What has to hold:

- a build killed by a signal says so, with the last 4 KB of its output -
  the Python stack faulthandler wrote included - and one line at the end
  saying how it ended;
- export_model.py dumps the Python stack on a fatal signal, and what the
  model printed before it is not lost in a buffer;
- a component cache entry whose shapes file is cut short or gone is an
  unreadable entry (a miss), never a half-read shape;
- fastgeom's answers can be dropped at once (export_model.py does when
  the model has run);
- a finished build leaves without the interpreter's teardown and loses
  none of its output on the way;
- a build process that dies on a signal of its own (not the memory
  ceiling's kill) is run again once, from empty exports/ and assets/, and
  the crash it got past is kept in the result; one that crashes every time
  fails with the crash.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

from backend import build

REPO = Path(__file__).resolve().parent.parent


def test_a_crash_keeps_the_last_4_kb_and_says_how_it_ended():
    out = (b"x" * 10000) + b"\nFatal Python error: Aborted\n  File \"/m/station.py\", line 7 in <module>\n"
    msg = build.crash_report("a/station", -signal.SIGABRT, out)
    lines = msg.splitlines()
    assert "SIGABRT" in lines[-1] and "a/station" in lines[-1]
    assert 'File "/m/station.py", line 7' in msg
    assert len(msg) < build.CRASH_TAIL + 200
    assert "x" * 5000 not in msg


def test_an_unknown_signal_is_named_by_number():
    assert "signal 99" in build.crash_report("m", -99, b"")


def test_export_model_dumps_the_python_stack_on_a_native_crash(tmp_path):
    models = tmp_path / "models"
    models.mkdir()
    (tmp_path / "assets").mkdir()
    (models / "crashy.py").write_text(
        "print('checked the fit')\n"
        "import os\n"
        "def deep():\n"
        "    os.abort()\n"
        "deep()\n")
    env = {**os.environ, "REDLINE_BUILD_CACHE": "off"}
    proc = subprocess.run(
        [sys.executable, str(REPO / "export_model.py"), "crashy",
         "--models-dir", str(models), "--assets-dir", str(tmp_path / "assets")],
        cwd=tmp_path, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
    assert proc.returncode == -signal.SIGABRT
    text = proc.stdout.decode(errors="replace")
    # Printed before the crash, and before the stack: not lost in a buffer.
    assert "checked the fit" in text
    assert text.index("checked the fit") < text.index("Fatal Python error")
    assert "crashy.py\", line 4 in deep" in text
    msg = build.crash_report("crashy", proc.returncode, proc.stdout)
    assert "line 4 in deep" in msg and msg.splitlines()[-1].endswith("4 KB")


def test_a_cut_short_shapes_file_is_a_miss_not_a_shape(tmp_path):
    pytest.importorskip("build123d")
    from build123d import Box
    from backend import buildcache

    meta, enc = buildcache.encode_value(Box(1, 2, 3))
    whole = tmp_path / "shapes.bin"
    enc.write_shapes(whole)
    assert buildcache.Decoder(meta["objects"], whole).dec(meta["value"]).volume == pytest.approx(6)
    cut = tmp_path / "cut.bin"
    cut.write_bytes(whole.read_bytes()[: whole.stat().st_size // 3])
    with pytest.raises(Exception):
        buildcache.Decoder(meta["objects"], cut)
    with pytest.raises(Exception):
        buildcache.Decoder(meta["objects"], tmp_path / "gone.bin").dec(meta["value"])


def test_fastgeom_drops_what_it_kept(monkeypatch):
    pytest.importorskip("build123d")
    from build123d import Box
    from build123d.topology.shape_core import Shape
    from build123d.topology.three_d import Mixin3D
    from backend import fastgeom

    monkeypatch.setattr(Mixin3D, "is_inside", Mixin3D.is_inside)
    monkeypatch.setattr(Shape, "bounding_box", Shape.bounding_box)
    monkeypatch.setattr(fastgeom, "_INSTALLED", False)
    monkeypatch.setattr(fastgeom, "_KEPT", {})
    monkeypatch.delenv("REDLINE_FASTGEOM", raising=False)
    fastgeom.install()
    box = Box(10, 10, 10)
    assert box.is_inside((0, 0, 0))
    box.bounding_box()
    assert len(fastgeom._KEPT) == 1
    fastgeom.clear()
    assert fastgeom._KEPT == {}
    # Still answers, from scratch, after.
    assert box.is_inside((0, 0, 0)) and not box.is_inside((20, 0, 0))
    del box


def test_the_build_drops_them_when_the_model_has_run():
    src = (REPO / "export_model.py").read_text()
    assert "fastgeom.clear()" in src


def test_a_finished_build_leaves_without_teardown_and_loses_no_output(tmp_path):
    pytest.importorskip("build123d")
    models = tmp_path / "models"
    models.mkdir()
    (tmp_path / "assets").mkdir()
    (tmp_path / "exports").mkdir()
    (models / "cube.py").write_text(
        "from build123d import Box\nprint('cube made')\nPARTS = [Box(1, 1, 1)]\n")
    env = {**os.environ, "REDLINE_BUILD_CACHE": "off"}
    env.pop("REDLINE_BUILD_TEARDOWN", None)
    proc = subprocess.run(
        [sys.executable, str(REPO / "export_model.py"), "cube",
         "--models-dir", str(models), "--assets-dir", str(tmp_path / "assets")],
        cwd=tmp_path, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=300)
    text = proc.stdout.decode(errors="replace")
    assert proc.returncode == 0, text
    # The last lines, written just before os._exit, made it out.
    assert "cube made" in text and "timing: load" in text and "cube.json" in text
    assert (tmp_path / "assets" / "cube.json").stat().st_size > 0
    assert list((tmp_path / "exports").glob("*.step"))


# ---------------------------------------------------------------- run again

def test_which_endings_are_crashes():
    assert build.crashed(-signal.SIGSEGV) and build.crashed(-signal.SIGABRT)
    # Killed from outside: the memory ceiling, a stop, a timeout.
    assert not build.crashed(-signal.SIGKILL) and not build.crashed(-signal.SIGTERM)
    assert not build.crashed(0) and not build.crashed(1) and not build.crashed(None)


FAKE_EXPORT = r'''
import os, sys
from pathlib import Path
flat, assets = sys.argv[1], Path(sys.argv[sys.argv.index("--assets-dir") + 1])
count = Path(os.environ["CRASH_COUNT"])
n = int(count.read_text()) if count.exists() else 0
count.write_text(str(n + 1))
if n < int(os.environ["CRASH_TIMES"]):
    Path("exports/half.step").write_text("ISO-10303-21; cut short")
    print(f"attempt {n + 1} about to crash", flush=True)
    os.abort()
assert not list(Path("exports").iterdir()), "exports/ was not emptied"
(assets / f"{flat}.json").write_text("{}")
Path("exports/whole.step").write_text("ISO-10303-21; whole")
print("timing: load 0.1s")
'''


def _build_with(monkeypatch, tmp_path, crash_times: int):
    import asyncio
    import test_links as T
    from backend import bodies, compute, links, store

    script = tmp_path / "fake_export.py"
    script.write_text(FAKE_EXPORT)
    monkeypatch.setenv("CRASH_COUNT", str(tmp_path / "count"))
    monkeypatch.setenv("CRASH_TIMES", str(crash_times))
    monkeypatch.setenv("REDLINE_BUILD_WARM", "off")
    db = T.FakeDb()
    db["models"].rows.append(T.model("p/thing", "PARTS = []\n", ready=True))

    async def prepare(db, model_id, models_dir, root):
        return {"sources": [], "graph": None, "against": {}, "hash": "h", "notes": []}

    stored = {}

    async def put_artifact(db, model_id, label, data):
        stored[label] = data
        return {"bytes": len(data)}

    async def nothing(*a, **kw):
        return None

    async def no_bodies(db, model_id):
        return []

    monkeypatch.setattr(links, "prepare", prepare)
    monkeypatch.setattr(store, "put_artifact", put_artifact)
    monkeypatch.setattr(compute, "record", nothing)
    monkeypatch.setattr(compute, "current_revision", nothing)
    monkeypatch.setattr(bodies, "model_built", no_bodies)
    return asyncio.run(build.build(db, "p/thing", script)), stored


def test_a_build_that_crashed_once_is_run_again_from_a_clean_directory(monkeypatch, tmp_path):
    out, stored = _build_with(monkeypatch, tmp_path, crash_times=1)
    assert (tmp_path / "count").read_text() == "2"
    # The STEP is the second attempt's, not the half one the crash left.
    assert stored["step"] == b"ISO-10303-21; whole"
    (report,) = out["crashes"]
    assert "attempt 1 about to crash" in report and "SIGABRT" in report.splitlines()[-1]
    assert "SIGABRT" in out["log"] and "run again" in out["log"]


def test_a_build_that_crashes_every_time_fails_with_the_crash(monkeypatch, tmp_path):
    with pytest.raises(RuntimeError) as err:
        _build_with(monkeypatch, tmp_path, crash_times=5)
    assert (tmp_path / "count").read_text() == str(1 + build.CRASH_RETRIES)
    msg = str(err.value)
    assert "about to crash" in msg and "SIGABRT" in msg and "crashed every time" in msg
