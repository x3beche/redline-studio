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


@pytest.fixture(autouse=True)
def _builds_in_process(monkeypatch):
    """A model build is a process of its own (backend/buildjobs.py). In a
    test its runner is a task in this process, so the build.build a test
    stands in is the one that runs, and nothing is started for real."""
    import asyncio

    from backend import buildjobs

    async def spawn(raw, job_id):
        asyncio.create_task(buildjobs.run(raw, job_id))
        return 0

    monkeypatch.setattr(buildjobs, "spawn", spawn)
    monkeypatch.setattr(buildjobs, "POLL", 0.02)
