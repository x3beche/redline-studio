"""Route a board with TraceMaker, and keep what its viewer stream says.

Runs inside the TraceMaker container (docker/tracemaker.Dockerfile):

    python3 /opt/tm_relay.py < plan.json

    plan = {"board": "/work/pre.kicad_pcb", "out": "/work/routed.kicad_pcb",
            "args": ["--work", "20000000", "--diff-pairs"],
            "live": "/work/live.jsonl", "timeout": 900}

TraceMaker streams its routing to a browser viewer of its own over a
WebSocket (docs/13-viewer-protocol.md: JSON messages - the board, tracks
and vias added and removed, the unrouted connections, the paths it is
trying, failures, progress). Redline draws the routing in its own board
view instead, so this listens to that stream on the container's loopback
and writes it to `live`, one JSON object a line, for the API to hand the
page (backend/routelive.py).

Most of the stream is state - every track, every via - and is kept whole.
The search itself (`path_try`, `frontier`) is thousands of messages a
second and only there to be watched: a few a second are kept, the latest
of each. Heatmaps are kept at most once a second each.

Standard library only: the container has python3 and nothing else.
"""

import base64
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time

PORT = 8766
TRANSIENT_EVERY = {"path_try": 0.06, "frontier": 0.15}   # s between kept ones
HEATMAP_EVERY = 1.0


class Live:
    """The file the page reads, a line a message, flushed as it goes."""

    def __init__(self, path: str):
        self.f = open(path, "w", encoding="utf-8")
        self.t0 = time.monotonic()
        self.seq = 0
        self.lock = threading.Lock()
        self.last_kept: dict[str, float] = {}
        self.held: dict[str, str] = {}        # transient: the latest not yet kept
        self.stats: dict | None = None

    def put(self, msg: dict) -> None:
        with self.lock:
            self.seq += 1
            msg = {"seq": self.seq, "t": round(time.monotonic() - self.t0, 3), **msg}
            self.f.write(json.dumps(msg, separators=(",", ":")) + "\n")
            self.f.flush()

    def take(self, text: str) -> None:
        try:
            msg = json.loads(text)
        except ValueError:
            return
        kind = msg.get("type")
        now = time.monotonic()
        if kind in TRANSIENT_EVERY or kind == "heatmap":
            key = kind if kind != "heatmap" else "heatmap:" + str(msg.get("name"))
            gap = TRANSIENT_EVERY.get(kind, HEATMAP_EVERY)
            if now - self.last_kept.get(key, 0) < gap:
                self.held[key] = text
                return
            self.last_kept[key] = now
            self.held.pop(key, None)
        if kind == "stats":
            self.stats = msg
        self.put(msg)

    def flush_held(self) -> None:
        """The latest search step of each kind, once its gap has passed."""
        now = time.monotonic()
        for key, text in list(self.held.items()):
            kind = key.split(":", 1)[0]
            if now - self.last_kept.get(key, 0) >= TRANSIENT_EVERY.get(kind, HEATMAP_EVERY):
                self.held.pop(key, None)
                self.last_kept[key] = now
                try:
                    self.put(json.loads(text))
                except ValueError:
                    pass


# ---- a WebSocket client, as small as the viewer protocol needs ----

def ws_connect(port: int, timeout: float = 5.0) -> socket.socket:
    s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = s.recv(4096)
        if not chunk:
            raise ConnectionError("closed during the handshake")
        head += chunk
    status = head.split(b"\r\n", 1)[0]
    if b" 101 " not in status:
        raise ConnectionError(status.decode(errors="replace"))
    s.settimeout(None)
    rest = head.split(b"\r\n\r\n", 1)[1]
    return _Buffered(s, rest)


class _Buffered:
    def __init__(self, s: socket.socket, rest: bytes):
        self.s, self.buf = s, bytearray(rest)

    def read(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out

    def send(self, opcode: int, payload: bytes = b"") -> None:
        mask = os.urandom(4)
        n = len(payload)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 1 << 16:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def messages(self):
        """Each text message, whole (fragments joined); pings answered."""
        parts: list[bytes] = []
        while True:
            b0, b1 = self.read(2)
            fin, op, n = b0 & 0x80, b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self.read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self.read(8))[0]
            mask = self.read(4) if b1 & 0x80 else None
            data = self.read(n)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if op == 0x8:
                return
            if op == 0x9:
                self.send(0xA, data)
                continue
            if op in (0x1, 0x2, 0x0):
                parts.append(data)
                if fin:
                    yield b"".join(parts).decode("utf-8", errors="replace")
                    parts = []


def listen(live: Live, proc: subprocess.Popen, port: int) -> None:
    """Connect once the viewer is up, and keep what it says until it stops."""
    conn = None
    while proc.poll() is None and conn is None:
        try:
            conn = ws_connect(port)
        except OSError:
            time.sleep(0.1)
    if conn is None:
        return
    try:
        for text in conn.messages():
            live.take(text)
    except (OSError, ConnectionError):
        pass


def main() -> int:
    plan = json.load(sys.stdin)
    port = int(plan.get("port", PORT))
    live = Live(plan.get("live", "/work/live.jsonl"))
    live.put({"type": "engine", "name": "tracemaker"})
    argv = ["tracemaker", "route", plan["board"], "-o", plan["out"], *plan.get("args", []),
            "--view", "--view-host", "127.0.0.1", "--view-port", str(port)]
    log = open(plan.get("log", "/work/tracemaker.log"), "w")
    t0 = time.monotonic()
    proc = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT)
    th = threading.Thread(target=listen, args=(live, proc, port), daemon=True)
    th.start()
    deadline = t0 + float(plan.get("timeout", 900))
    while proc.poll() is None:
        live.flush_held()
        if time.monotonic() > deadline:
            proc.kill()
            break
        time.sleep(0.05)
    th.join(timeout=3)
    live.flush_held()
    rc = proc.wait()
    log.close()
    tail = open(plan.get("log", "/work/tracemaker.log"), encoding="utf-8", errors="replace").read()[-3000:]
    live.put({"type": "done", "rc": rc})
    print(json.dumps({"rc": rc, "seconds": round(time.monotonic() - t0, 1),
                      "stats": live.stats, "log": tail, "argv": argv[1:]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
