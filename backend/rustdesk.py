"""RustDesk: the small remote desktop on this machine (the rustdesk-desktop
container, ~/rustdesk-desktop), turned on and off from the admin panel.

    GET  /api/admin/rustdesk         running or not, since when, and how to connect
    POST /api/admin/rustdesk/start   start the container
    POST /api/admin/rustdesk/stop    stop it (it stays stopped across reboots)

It is reached only over Tailscale: the container publishes its port on the
machine's Tailscale address, and does not register with RustDesk's public
servers, so it has no ID that works from the internet. The page shows that
address and the password - which is why only the owner and the admins see
it (the middleware's "users" rule for /api/admin, and `_me` here).
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import socket
import struct
import subprocess

from fastapi import APIRouter, HTTPException

from .admin import _me

router = APIRouter(prefix="/api/admin/rustdesk")

CONTAINER = "rustdesk-desktop"
PORT = 21118
TAILSCALE_IF = "tailscale0"


def _docker(*args: str, timeout: float = 30) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)


def tailscale_ip(name: str = TAILSCALE_IF) -> str | None:
    """The machine's Tailscale IPv4 (the API runs on the host's network)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            req = struct.pack("256s", name.encode()[:15])
            return socket.inet_ntoa(fcntl.ioctl(s.fileno(), 0x8915, req)[20:24])  # SIOCGIFADDR
    except OSError:
        return None


def describe(info: dict | None, ts: str | None) -> dict:
    """What the page shows, from `docker inspect`'s record of the container."""
    if not info:
        return {"installed": False, "running": False, "tailscale_ip": ts, "port": PORT}
    st = info.get("State") or {}
    env = dict(e.split("=", 1) for e in (info.get("Config") or {}).get("Env") or [] if "=" in e)
    binds = ((info.get("HostConfig") or {}).get("PortBindings") or {}).get(f"{PORT}/tcp") or []
    hosts = sorted({b.get("HostIp") or "0.0.0.0" for b in binds})
    running = bool(st.get("Running"))
    return {
        "installed": True,
        "running": running,
        "status": st.get("Status"),
        "since": st.get("StartedAt") if running else st.get("FinishedAt"),
        "tailscale_ip": ts,
        "port": PORT,
        "password": env.get("RD_PASSWORD") or None,
        "bound_to": hosts,
        # Only over Tailscale: published on that address and nowhere else.
        "tailscale_only": bool(ts) and hosts == [ts],
    }


def _inspect() -> dict | None:
    out = _docker("inspect", CONTAINER)
    if out.returncode != 0:
        return None
    rows = json.loads(out.stdout or "[]")
    return rows[0] if rows else None


async def _state() -> dict:
    info = await asyncio.to_thread(_inspect)
    return describe(info, tailscale_ip())


@router.get("")
async def status():
    _me()
    return await _state()


async def _switch(on: bool) -> dict:
    _me()
    args = ("start", CONTAINER) if on else ("stop", "-t", "5", CONTAINER)
    out = await asyncio.to_thread(_docker, *args, timeout=60)
    if out.returncode != 0:
        why = (out.stderr or out.stdout or "").strip().splitlines()
        raise HTTPException(502, f"docker {args[0]} failed: {why[-1] if why else 'no output'}")
    return await _state()


@router.post("/start")
async def start():
    return await _switch(True)


@router.post("/stop")
async def stop():
    return await _switch(False)
