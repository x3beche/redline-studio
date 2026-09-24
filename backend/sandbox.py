"""The programming tabs' machines: one Docker image each.

Nothing a project needs is installed on the host. A web page is
photographed by the Chrome in `redline-code-web`, firmware is built by the
cross compiler in `redline-code-embedded`, and a phone is the emulator in
`redline-code-mobile`. The project's checkout is mounted at the path it
has on the host - so the paths a build prints, and a virtualenv made on
the host, mean the same thing inside - with the host's network, so a dev
server on 127.0.0.1 is the one the person is looking at.

A container is nobody's child, so rusage cannot see it. Its cgroup can:
cpu.stat and memory.peak are read while it runs, and the last reading is
what the job cost. The board room's KiCad runs report the clock alone;
these report the CPU as well.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"

IMAGES = {
    "web": os.environ.get("X3_WEB_IMAGE", "redline-code-web"),
    "embedded": os.environ.get("X3_EMBEDDED_IMAGE", "redline-code-embedded"),
    "mobile": os.environ.get("X3_MOBILE_IMAGE", "redline-code-mobile"),
}
DOCKERFILES = {k: f"docker/code/{k}.Dockerfile" for k in IMAGES}


class NoImage(RuntimeError):
    """The tab's image is not built. Said with the command that builds it."""


def image_of(platform: str) -> str:
    return IMAGES.get(platform, IMAGES["web"])


def build_hint(platform: str) -> str:
    return (f"docker build -f {DOCKERFILES.get(platform, DOCKERFILES['web'])} "
            f"-t {image_of(platform)} docker/code")


def have_image(platform: str) -> bool:
    try:
        return subprocess.run(["docker", "image", "inspect", image_of(platform)],
                              capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def argv(platform: str, cmd: list[str], *, repo: str | None = None,
         workdir: str | None = None, mounts: list[tuple[str, str, str]] = (),
         env: dict[str, str] | None = None, name: str | None = None,
         extra: list[str] = ()) -> list[str]:
    """The `docker run` line for one command in a tab's image.

    As the person's own user, so what a build writes can be deleted by
    them, and with HOME somewhere writable for tools that want one.
    """
    run = ["docker", "run", "--rm", "--network", "host",
           "--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp"]
    if name:
        run += ["--name", name]
    if repo:
        run += ["-v", f"{repo}:{repo}"]
    CACHE.mkdir(parents=True, exist_ok=True)
    run += ["-v", f"{CACHE}:{CACHE}"]
    for src, dst, mode in mounts:
        run += ["-v", f"{src}:{dst}:{mode}"]
    for k, v in (env or {}).items():
        run += ["-e", f"{k}={v}"]
    if workdir:
        run += ["-w", workdir]
    return [*run, *extra, image_of(platform), *cmd]


class CgroupMeter:
    """CPU and memory of one container, from its cgroup, polled."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.cpu_s = 0.0
        self.peak_mb = 0.0
        self.t0 = time.monotonic()
        self._task: asyncio.Task | None = None

    def _scope(self) -> Path | None:
        try:
            cid = subprocess.run(["docker", "inspect", "-f", "{{.Id}}", self.name],
                                 capture_output=True, text=True, timeout=5).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            return None
        p = Path(f"/sys/fs/cgroup/system.slice/docker-{cid}.scope")
        return p if cid and p.exists() else None

    async def _poll(self) -> None:
        scope = None
        while True:
            if scope is None:
                scope = await asyncio.to_thread(self._scope)
            if scope is not None:
                try:
                    for line in (scope / "cpu.stat").read_text().splitlines():
                        if line.startswith("usage_usec"):
                            self.cpu_s = int(line.split()[1]) / 1e6
                    peak = scope / "memory.peak"
                    if peak.exists():
                        self.peak_mb = max(self.peak_mb,
                                           int(peak.read_text()) / 2 ** 20)
                except (OSError, ValueError):
                    pass              # it ended between two readings
            await asyncio.sleep(0.5)

    def start(self) -> None:
        self._task = asyncio.create_task(self._poll())

    def stop(self) -> dict:
        if self._task:
            self._task.cancel()
        wall = time.monotonic() - self.t0
        return {"wall_s": round(wall, 2), "cpu_s": round(self.cpu_s, 2),
                "cores_used": round(self.cpu_s / wall, 2) if wall > 0.1 else None,
                "peak_rss_mb": round(self.peak_mb, 1) or None,
                "where": "container"}


async def run(platform: str, cmd: list[str], *, timeout: float = 600,
              **kw) -> tuple[int, str, dict]:
    """Run one command in the tab's image. Returns exit code, output, and
    what it cost. Raises NoImage when the image is not there."""
    if not await asyncio.to_thread(have_image, platform):
        raise NoImage(f"the {platform} image ({image_of(platform)}) is not built: "
                      f"{build_hint(platform)}")
    name = f"redline-{platform}-{uuid.uuid4().hex[:8]}"
    meter = CgroupMeter(name)
    proc = await asyncio.create_subprocess_exec(
        *argv(platform, cmd, name=name, **kw),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    meter.start()
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        rc = proc.returncode
    except asyncio.TimeoutError:
        subprocess.run(["docker", "kill", name], capture_output=True)
        await proc.wait()
        out, rc = f"\n(stopped after {timeout:.0f}s)".encode(), -9
    return rc, out.decode(errors="replace"), meter.stop()
