"""Machine status: CPU, RAM, GPU.

nvidia-smi is called for the GPU; if missing or unresponsive the field is
omitted.
"""

from __future__ import annotations

import platform
import re
import shutil
import subprocess
from pathlib import Path

import psutil

_CPU_NAME: str | None = None


def _cpu_name() -> str:
    global _CPU_NAME
    if _CPU_NAME is None:
        _CPU_NAME = platform.processor() or "unknown"
        try:
            for line in Path("/proc/cpuinfo").read_text().splitlines():
                if line.startswith("model name"):
                    _CPU_NAME = line.split(":", 1)[1].strip()
                    break
        except OSError:
            pass
        _CPU_NAME = re.sub(r"\s+", " ", _CPU_NAME)
    return _CPU_NAME


def _gpu() -> dict | None:
    if not shutil.which("nvidia-smi"):
        return None
    try:
        out = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3)
        if out.returncode != 0 or not out.stdout.strip():
            return None
        name, util, used, total, temp = [
            v.strip() for v in out.stdout.strip().splitlines()[0].split(",")]
        return {"name": name, "util": float(util),
                "mem_used_mb": float(used), "mem_total_mb": float(total),
                "temp_c": float(temp)}
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def snapshot() -> dict:
    """Local disk is deliberately absent: no project data is stored on disk."""
    mem = psutil.virtual_memory()
    return {
        "host": platform.node(),
        "os": f"{platform.system()} {platform.release()}",
        "cpu": {
            "name": _cpu_name(),
            "cores": psutil.cpu_count(logical=False) or 0,
            "threads": psutil.cpu_count(logical=True) or 0,
            # interval=None: average since the last call, non-blocking
            "load": psutil.cpu_percent(interval=None),
            "freq_mhz": round(psutil.cpu_freq().current) if psutil.cpu_freq() else None,
        },
        "ram": {"used_bytes": mem.used, "total_bytes": mem.total, "percent": mem.percent},
        "gpu": _gpu(),
    }
