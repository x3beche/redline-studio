"""What to tell someone whose work image (KiCad, the drawings, PlatformIO,
the tools' checks, TraceMaker) is not there.

From a checkout it is the `docker build` that makes it, with the name the
API looks for (REDLINE_*_IMAGE). In the compose deployment (docker-compose.yml
sets REDLINE_DEPLOY=compose) nobody builds by hand: the image comes with its
compose profile, so that is what is said.
"""

from __future__ import annotations

import os


def deployed() -> bool:
    return (os.environ.get("REDLINE_DEPLOY") or "").strip().lower() == "compose"


def build_hint(image: str, build: str, profile: str | None = None) -> str:
    """`build` is the dev checkout's command, already naming `image`;
    `profile` the compose profile that brings it (None: built by default)."""
    if not deployed():
        return build
    if profile:
        return (f"add {profile} to COMPOSE_PROFILES and run docker compose up -d --build "
                f"(or redeploy the stack) - it makes {image}")
    return f"run docker compose up -d --build (or redeploy the stack) - it makes {image}"
