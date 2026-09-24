"""How much of the machine one container may take.

Builds, board runs and the coding rooms' commands each run in a Docker
container. Without a limit, one runaway build - a compiler that forks
without end, a test that eats memory - takes the whole machine, the app
with it. Each container gets at most half the cores, a share of the
memory and a cap on processes. `.env` can change them:

    X3_BOX_CPUS=8        cores (fractions allowed, 1.5)
    X3_BOX_MEMORY=12g    memory, Docker's units (512m, 12g)
    X3_BOX_PIDS=4096     processes and threads

The phone emulator is not limited here: it is one long-running machine of
its own, sized in backend/phone.py.
"""

from __future__ import annotations

import os


def _default_cpus() -> str:
    return str(max(1, (os.cpu_count() or 2) // 2))


def _default_memory() -> str:
    # Up to 12 GB, and never more than 40 % of the machine.
    try:
        total = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        return f"{max(1, min(12, int(total * 0.4 / 2**30)))}g"
    except (ValueError, OSError, AttributeError):
        return "4g"


def box() -> list[str]:
    """The `docker run` options that keep one container to its share."""
    return ["--cpus", os.environ.get("X3_BOX_CPUS", "").strip() or _default_cpus(),
            "--memory", os.environ.get("X3_BOX_MEMORY", "").strip() or _default_memory(),
            "--pids-limit", os.environ.get("X3_BOX_PIDS", "").strip() or "4096"]
