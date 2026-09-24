"""The Tools tab's checks: what a tool wrote, tried for real.

Every check runs in the one tools image (docker/tools/tools.Dockerfile),
offline - `--network none` - as the host's user, with a memory cap, and is
thrown away afterwards. The image does the work (`check.py` in it); this is
only the door to it. The tool pages call it when they are shown inside the
app; opened on their own, they do without.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/tools")

IMAGE = os.environ.get("X3_TOOLS_IMAGE", "redline-tools")
KINDS = ("sql", "prisma", "ts", "openapi", "mermaid", "regex", "cron")
BUILD = "docker build -f docker/tools/tools.Dockerfile -t redline-tools docker/tools"
LIMIT = 400_000                  # characters: a check is for a tool's output, not a dump
TIMEOUT = 180
# Two at a time: a check starts a database or a browser, and a person
# pressing Check twice should not start four.
_slots = asyncio.Semaphore(2)


def have_image() -> bool:
    try:
        return subprocess.run(["docker", "image", "inspect", IMAGE],
                              capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


@router.get("/status")
def status() -> dict:
    return {"image": IMAGE, "ready": have_image(), "kinds": list(KINDS),
            "build": BUILD}


class CheckIn(BaseModel):
    kind: str
    input: str = ""
    # Kind-specific extras: regex {pattern, text, flags, python, pcre},
    # cron {tz, start, count}, ts {files}, mermaid {theme}.
    extra: dict = Field(default_factory=dict)


@router.post("/check")
async def check(body: CheckIn) -> dict:
    if body.kind not in KINDS:
        raise HTTPException(400, f"unknown check {body.kind!r}; one of {', '.join(KINDS)}")
    req = {**body.extra, "kind": body.kind, "input": body.input}
    payload = json.dumps(req)
    if len(payload) > LIMIT:
        raise HTTPException(413, f"too large to check ({len(payload)} characters, "
                                 f"the limit is {LIMIT})")
    if not have_image():
        raise HTTPException(503, f"the tools image is not built: {BUILD}")
    argv = ["docker", "run", "--rm", "-i", "--network", "none",
            "--user", f"{os.getuid()}:{os.getgid()}", "--memory", "2g", "--cpus", "2",
            "--pids-limit", "512", IMAGE]
    async with _slots:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(payload.encode()), TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            raise HTTPException(504, f"the check took longer than {TIMEOUT}s")
    try:
        return json.loads(out.decode() or "{}")
    except ValueError:
        raise HTTPException(500, "the check said nothing readable: "
                                 + (err.decode(errors="replace")[-400:] or "no output"))
