"""No module refers to a name that is not there. A cleanup removed
STATUSES from main.py with a route still using it, and every "queue" press
answered 500 until somebody tried it."""
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def test_backend_and_tools_have_no_undefined_names():
    pytest.importorskip("pyflakes")
    out = subprocess.run([sys.executable, "-m", "pyflakes", "backend", "tools"],
                         cwd=ROOT, capture_output=True, text=True).stdout
    bad = [line for line in out.splitlines() if "undefined name" in line]
    assert not bad, "\n".join(bad)
