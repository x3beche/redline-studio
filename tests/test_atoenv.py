"""Finding a Python and an easyeda2kicad that start, on the host as in the
container (backend/atoenv.py).

The atopile venv is made in the container, so on the host its bin/python is
a link to a /usr/local/bin/python that is not there, and every script in it
fails with "No such file or directory". Here a venv like that is built in a
temporary directory.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from backend import atoenv

VER = f"{sys.version_info[0]}.{sys.version_info[1]}"


def venv(tmp_path: Path, python_works: bool, packages=("easyeda2kicad", "kiutils")) -> Path:
    v = tmp_path / ".venv-ato"
    (v / "bin").mkdir(parents=True)
    site = v / "lib" / f"python{VER}" / "site-packages"
    site.mkdir(parents=True)
    for pkg in packages:
        (site / pkg).mkdir()
        (site / pkg / "__init__.py").write_text("")
        (site / pkg / "__main__.py").write_text("import sys; print('ran', sys.argv[1:])\n")
    target = sys.executable if python_works else "/nonexistent/usr/local/bin/python"
    (v / "bin" / "python").symlink_to(target)
    (v / "pyvenv.cfg").write_text(f"home = /nonexistent/usr/local/bin\nversion = {VER}.0\n")
    script = v / "bin" / "easyeda2kicad"
    script.write_text(f"#!{v / 'bin' / 'python'}\nimport sys\n")
    script.chmod(0o755)
    return v


@pytest.fixture
def env(monkeypatch, tmp_path):
    for name in ("REDLINE_ATO_PYTHON", "REDLINE_EASYEDA", "REDLINE_ATO", "PYTHONPATH"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(atoenv, "ROOT", tmp_path / "nowhere" / "checkout")
    return monkeypatch


def test_in_the_container_the_venv_is_used_as_it_is(env, tmp_path):
    v = venv(tmp_path, python_works=True)
    env.setenv("REDLINE_EASYEDA", str(v / "bin" / "easyeda2kicad"))
    env.setenv("REDLINE_ATO_PYTHON", str(v / "bin" / "python"))
    assert atoenv.easyeda() == ([str(v / "bin" / "easyeda2kicad")], {})
    assert atoenv.python() == ([str(v / "bin" / "python")], {})


def test_on_the_host_a_same_version_python_runs_the_venvs_packages(env, tmp_path):
    v = venv(tmp_path, python_works=False)
    env.setenv("REDLINE_EASYEDA", str(v / "bin" / "easyeda2kicad"))
    env.setenv("REDLINE_ATO_PYTHON", str(v / "bin" / "python"))
    argv, extra = atoenv.easyeda()
    assert argv[-2:] == ["-m", "easyeda2kicad"]
    assert extra["PYTHONPATH"].startswith(str(v / "lib" / f"python{VER}" / "site-packages"))
    # And it really starts.
    out = subprocess.run([*argv, "--lcsc_id", "C1"], capture_output=True, text=True,
                         env={**os.environ, **extra}, timeout=30)
    assert out.returncode == 0 and "ran ['--lcsc_id', 'C1']" in out.stdout
    py, extra = atoenv.python("kiutils")
    assert subprocess.run([*py, "-c", "import kiutils"], env={**os.environ, **extra},
                          timeout=30).returncode == 0


def test_the_venv_is_found_beside_the_checkout_without_any_setting(env, tmp_path):
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    env.setattr(atoenv, "ROOT", checkout)
    v = venv(checkout, python_works=False)
    argv, extra = atoenv.easyeda()
    assert argv[-1] == "easyeda2kicad" and str(v) in extra["PYTHONPATH"]


def test_none_that_works_says_what_was_tried_and_what_to_set(env, tmp_path, monkeypatch):
    v = venv(tmp_path, python_works=False, packages=())
    env.setenv("REDLINE_EASYEDA", str(v / "bin" / "easyeda2kicad"))
    monkeypatch.setattr(atoenv.shutil, "which", lambda name: None)
    with pytest.raises(atoenv.AtoEnvMissing) as got:
        atoenv.easyeda()
    msg = str(got.value)
    assert "REDLINE_EASYEDA" in msg and "REDLINE_ATO_PYTHON" in msg
    assert "its interpreter is missing" in msg


def test_a_script_whose_interpreter_is_gone_does_not_count_as_there(tmp_path):
    s = tmp_path / "tool"
    s.write_text("#!/nonexistent/python\n")
    s.chmod(0o755)
    assert not atoenv._runs(s)
    s.write_text(f"#!{sys.executable}\n")
    assert atoenv._runs(s)
    s.write_text("#!/usr/bin/env definitely-not-a-program-xyz\n")
    assert not atoenv._runs(s)


def test_lcsc_fetch_says_the_resolvers_message(env, tmp_path, monkeypatch):
    import asyncio
    from backend import lcsc

    def missing():
        raise atoenv.AtoEnvMissing("easyeda2kicad cannot be started on this machine - tried: x")
    monkeypatch.setattr(atoenv, "easyeda", missing)

    class Parts:
        async def find_one(self, *a, **kw):
            return None
    with pytest.raises(RuntimeError, match="cannot be started on this machine"):
        asyncio.run(lcsc.fetch({lcsc.PARTS: Parts()}, "C1525"))
