"""What every test gets, whether it asks or not."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture(autouse=True)
def _lcsc_elsewhere(tmp_path, monkeypatch):
    """No test reads or writes the real LCSC cache, turn-taking or journal.

    The journal is what the page shows as "what the agents did to LCSC";
    a test run once wrote rows into it that nobody had asked for, and a
    real cool-off made unrelated tests fail. Each test gets its own.
    """
    from backend import lcsc

    look = tmp_path / "lcsc"
    look.mkdir()
    monkeypatch.setattr(lcsc, "LOOK", look)
    monkeypatch.setattr(lcsc, "GAP", 0.0)
