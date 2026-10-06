"""Finding the atopile environment's Python and easyeda2kicad, wherever this runs.

`.venv-ato` is made inside the API container (docker/dev), so its
`bin/python` is a link to the container's /usr/local/bin/python and every
script in it starts `#!.../.venv-ato/bin/python`. On the host that link
points at nothing: `revisions.py part keep` failed with "No such file or
directory" for an easyeda2kicad that was right there. The packages
themselves are plain files and run under any CPython of the same minor
version, so when the venv's own interpreter is missing, one that matches
runs them with the venv's site-packages on its path.

In order, for easyeda2kicad:

1. REDLINE_EASYEDA (old name X3_EASYEDA), if it can actually start: a
   binary, or a script whose `#!` interpreter exists;
2. the atopile environment's Python, `-m easyeda2kicad`: REDLINE_ATO_PYTHON
   if it exists, else the venv's own `bin/python`, else a same-version
   CPython (this one, the venv's `home`, python3.X on PATH, uv's) with the
   venv's site-packages added;
3. an easyeda2kicad on PATH that can start.

None of them: AtoEnvMissing, saying what was tried and what to set.
"""

from __future__ import annotations

import glob
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class AtoEnvMissing(RuntimeError):
    """No working interpreter or tool; the message says what was tried."""


def _venvs() -> list[Path]:
    """Where the atopile environment may be: beside REDLINE_ATO_PYTHON or
    REDLINE_EASYEDA or REDLINE_ATO, then the checkout's, then the old
    place two levels up."""
    out = []
    for name in ("REDLINE_ATO_PYTHON", "REDLINE_EASYEDA", "REDLINE_ATO"):
        v = os.environ.get(name, "").strip()
        if v:
            out.append(Path(v).parent.parent)          # .../.venv-ato/bin/x -> .venv-ato
    out += [ROOT / ".venv-ato", ROOT.parent.parent / ".venv-ato"]
    seen, uniq = set(), []
    for p in out:
        if p not in seen and (p / "pyvenv.cfg").exists():
            seen.add(p)
            uniq.append(p)
    return uniq


def _runs(path: str | Path) -> bool:
    """Whether a file can be started: it exists (links followed) and is
    executable, and a script's `#!` interpreter can be started too."""
    p = Path(path)
    try:
        if not p.exists() or not os.access(p, os.X_OK):
            return False
        with open(p, "rb") as f:
            head = f.readline(512)
    except OSError:
        return False
    if head.startswith(b"#!"):
        parts = head[2:].decode(errors="replace").strip().split()
        if not parts:
            return False
        interp = parts[0]
        if Path(interp).name == "env" and len(parts) > 1:
            return shutil.which(parts[1]) is not None
        return Path(interp).exists() and os.access(interp, os.X_OK)
    return True


def _version(venv: Path) -> tuple[int, int] | None:
    try:
        for line in (venv / "pyvenv.cfg").read_text().splitlines():
            key, _, value = line.partition("=")
            if key.strip() in ("version", "version_info"):
                nums = value.strip().split(".")
                return int(nums[0]), int(nums[1])
    except (OSError, ValueError, IndexError):
        pass
    return None


def _home(venv: Path) -> str | None:
    try:
        for line in (venv / "pyvenv.cfg").read_text().splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "home":
                return value.strip()
    except OSError:
        pass
    return None


def _site(venv: Path, ver: tuple[int, int]) -> Path | None:
    site = venv / "lib" / f"python{ver[0]}.{ver[1]}" / "site-packages"
    return site if site.is_dir() else None


def _same_version_pythons(venv: Path, ver: tuple[int, int]) -> list[str]:
    name = f"python{ver[0]}.{ver[1]}"
    out = []
    if sys.version_info[:2] == ver:
        out.append(sys.executable)
        base = getattr(sys, "_base_executable", None)
        if base:
            out.append(base)
    home = _home(venv)
    if home:
        out.append(str(Path(home) / name))
    found = shutil.which(name)
    if found:
        out.append(found)
    out += sorted(glob.glob(str(Path.home() / ".local/share/uv/python"
                                / f"cpython-{ver[0]}.{ver[1]}*" / "bin" / name)))
    return [p for p in dict.fromkeys(out) if _runs(p)]


def python(module: str | None = None) -> tuple[list[str], dict[str, str]]:
    """The atopile environment's Python as (argv, extra environment).
    `module`, when given, must be importable there (its package directory
    is in the venv)."""
    tried = []
    told = os.environ.get("REDLINE_ATO_PYTHON", "").strip()
    if told:
        if _runs(told):
            return [told], {}
        tried.append(f"REDLINE_ATO_PYTHON={told} (cannot be started)")
    for venv in _venvs():
        own = venv / "bin" / "python"
        if _runs(own):
            return [str(own)], {}
        tried.append(f"{own} (its interpreter, {os.path.realpath(own)}, is not on this machine)")
        ver = _version(venv)
        site = _site(venv, ver) if ver else None
        if not site:
            continue
        if module and not (site / module.split(".")[0]).exists():
            tried.append(f"{site} has no {module}")
            continue
        for interp in _same_version_pythons(venv, ver):
            old = os.environ.get("PYTHONPATH", "")
            return [interp, "-s"], {"PYTHONPATH": str(site) + (os.pathsep + old if old else "")}
        tried.append(f"no Python {ver[0]}.{ver[1]} here to run {site} with")
    if not tried:
        tried.append(f"no .venv-ato in {ROOT} or {ROOT.parent.parent}")
    raise AtoEnvMissing(
        "no working Python for the atopile environment - tried: " + "; ".join(tried)
        + ". Set REDLINE_ATO_PYTHON to a Python that has atopile and easyeda2kicad, "
        "or make .venv-ato on this machine (python3.12 -m venv .venv-ato && "
        ".venv-ato/bin/pip install atopile easyeda2kicad).")


def easyeda() -> tuple[list[str], dict[str, str]]:
    """easyeda2kicad as (argv, extra environment)."""
    tried = []
    told = os.environ.get("REDLINE_EASYEDA", "").strip()
    if told:
        if _runs(told):
            return [told], {}
        tried.append(f"REDLINE_EASYEDA={told} (cannot be started here: "
                     + ("missing" if not Path(told).exists() else "its interpreter is missing") + ")")
    try:
        argv, env = python("easyeda2kicad")
        return [*argv, "-m", "easyeda2kicad"], env
    except AtoEnvMissing as exc:
        tried.append(str(exc).split(" - tried: ", 1)[-1].split(". Set ", 1)[0])
    found = shutil.which("easyeda2kicad")
    if found and _runs(found):
        return [found], {}
    raise AtoEnvMissing(
        "easyeda2kicad cannot be started on this machine - tried: " + "; ".join(tried)
        + ". Set REDLINE_EASYEDA to a working easyeda2kicad, or REDLINE_ATO_PYTHON to a "
        "Python that has it (pip install easyeda2kicad).")
