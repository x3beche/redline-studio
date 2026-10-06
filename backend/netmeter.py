"""Counting every byte that goes through the proxy, the way the proxy's
owner counts them (Settings > Proxy).

A residential proxy bills by traffic: every byte through its gateway, both
ways - the CONNECT, the TLS handshake, the headers, the body. What the app
can see of a request (the decoded answer) is a fraction of that, and the
tools that ask EasyEDA themselves (easyeda2kicad) see nothing at all.

So nothing talks to the proxy directly. Every proxied connection goes to a
small forwarder on 127.0.0.1 first, which hands it on to the proxy byte for
byte and counts both directions on the socket: what the provider meters.
Each connection is put down to its session (read from the Proxy-
Authorization username, `...-session-<id>`) and its destination (the
CONNECT line), and added to an hourly total in the database, so the bill
can be checked against the provider's dashboard to the kilobyte.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import re
import time
from datetime import datetime, timezone

log = logging.getLogger("x3.netmeter")

TRAFFIC = "proxy_traffic"          # hourly totals: _id "YYYY-MM-DDTHH", up, down, conns, hosts.{host}.{up,down,conns}
HEAD_MAX = 64 * 1024

_server: asyncio.base_events.Server | None = None
_port: int | None = None
_upstream: tuple[str, int, bool] | None = None        # host, port, tls
_db_getter = None
# session -> host -> {up, down, conns, ms}; read by netproxy.log a moment after a lookup
_sessions: dict[str, dict[str, dict]] = {}
_session_seen: dict[str, float] = {}
SESSION_TTL = 900


def port() -> int | None:
    return _port


def bind(db_getter) -> None:
    global _db_getter
    _db_getter = db_getter


def set_upstream(host: str | None, port_: int | None, tls: bool = False) -> None:
    global _upstream
    _upstream = (host, int(port_), tls) if host and port_ else None


def session_bytes(session: str | None) -> dict | None:
    """What a session moved so far, by destination: {host: {up, down, conns, ms}}."""
    if not session:
        return None
    got = _sessions.get(session)
    return {h: dict(v) for h, v in got.items()} if got else None


def _session_of(head: bytes) -> str | None:
    m = re.search(rb"(?im)^proxy-authorization:\s*basic\s+([A-Za-z0-9+/=]+)\s*$", head)
    if not m:
        return None
    try:
        user = base64.b64decode(m.group(1)).decode(errors="replace").split(":", 1)[0]
    except Exception:                                  # noqa: BLE001
        return None
    s = re.search(r"-session-([A-Za-z0-9]+)", user)
    return s.group(1) if s else None


def _target_of(head: bytes) -> str:
    first = head.split(b"\r\n", 1)[0].decode(errors="replace")
    parts = first.split()
    if len(parts) >= 2:
        if parts[0].upper() == "CONNECT":
            return parts[1].rsplit(":", 1)[0].lower()
        m = re.match(r"[a-z]+://([^/:]+)", parts[1], re.I)
        if m:
            return m.group(1).lower()
    return "?"


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, count: list[int]) -> None:
    try:
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                break
            count[0] += len(chunk)
            writer.write(chunk)
            await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError, OSError):
        pass
    finally:
        try:
            if writer.can_write_eof():
                writer.write_eof()
        except (OSError, RuntimeError):
            pass


async def _handle(c_reader: asyncio.StreamReader, c_writer: asyncio.StreamWriter) -> None:
    t0 = time.monotonic()
    up, down = [0], [0]
    host, session = "?", None
    u_writer = None
    try:
        head = await c_reader.readuntil(b"\r\n\r\n")
        if len(head) > HEAD_MAX or not _upstream:
            c_writer.close()
            return
        host, session = _target_of(head), _session_of(head)
        uh, up_port, tls = _upstream
        u_reader, u_writer = await asyncio.open_connection(uh, up_port, ssl=tls or None)
        up[0] += len(head)                     # the request head goes to the proxy as it came
        u_writer.write(head)
        await u_writer.drain()
        await asyncio.gather(_pipe(c_reader, u_writer, up), _pipe(u_reader, c_writer, down))
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError, OSError) as exc:
        log.debug("proxy connection ended early: %s", exc)
    finally:
        for w in (c_writer, u_writer):
            if w is not None:
                try:
                    w.close()
                except Exception:                      # noqa: BLE001
                    pass
        _account(host, session, up[0], down[0], (time.monotonic() - t0) * 1000)


def _account(host: str, session: str | None, up: int, down: int, ms: float) -> None:
    if not (up or down):
        return
    now = time.time()
    if session:
        h = _sessions.setdefault(session, {}).setdefault(host, {"up": 0, "down": 0, "conns": 0, "ms": 0})
        h["up"] += up
        h["down"] += down
        h["conns"] += 1
        h["ms"] += round(ms)
        _session_seen[session] = now
    for s, seen in list(_session_seen.items()):          # forget old sessions
        if now - seen > SESSION_TTL:
            _session_seen.pop(s, None)
            _sessions.pop(s, None)
    if _db_getter is None:
        return
    hour = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H")
    key = re.sub(r"[.$]", "_", host)[:120]

    async def add():
        try:
            db = _db_getter()
            raw = db.raw if getattr(type(db), "SCOPED", False) else db
            await raw[TRAFFIC].update_one(
                {"_id": hour},
                {"$inc": {"up": up, "down": down, "conns": 1,
                          f"hosts.{key}.up": up, f"hosts.{key}.down": down, f"hosts.{key}.conns": 1}},
                upsert=True)
        except Exception as exc:                       # noqa: BLE001
            log.warning("traffic not recorded: %s", exc)
    asyncio.get_running_loop().create_task(add())


async def start() -> int:
    """Open the forwarder on 127.0.0.1 (once); returns its port."""
    global _server, _port
    if _server is None:
        _server = await asyncio.start_server(_handle, "127.0.0.1", 0, limit=HEAD_MAX)
        _port = _server.sockets[0].getsockname()[1]
        log.info("proxy meter listening on 127.0.0.1:%s", _port)
    return _port


async def hourly(since_hour: str) -> list[dict]:
    """The hourly totals from `since_hour` ("YYYY-MM-DDTHH") on."""
    if _db_getter is None:
        return []
    db = _db_getter()
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    return [d async for d in raw[TRAFFIC].find({"_id": {"$gte": since_hour}}).sort("_id", 1)]
