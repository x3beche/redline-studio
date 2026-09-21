#!/usr/bin/env python
"""Render the current model from a revision's camera angle.

After applying a revision, take the picture from exactly the angle the user
drew on, so the before and after can be compared side by side.

    python tools/render.py <revision_id> [-o out.png] [--width 1500]

Needs the dev server running (start.sh). Drives headless Chrome, waits for
the viewer to load the model and move to the stored camera, then captures
the canvas.
"""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

WEB = "http://127.0.0.1:4200"
PORT = 9411
# Hardware GL through the ANGLE OpenGL backend: the default backend cannot
# create a GPU command buffer on hybrid Intel + NVIDIA machines.
FLAGS = ["--headless=new", "--ignore-gpu-blocklist", "--use-angle=gl",
         "--no-first-run", "--disable-gpu-sandbox"]


def render(revision: str, out: Path, width: int, height: int, wait: int) -> Path:
    from websockets.sync.client import connect

    profile = tempfile.mkdtemp(prefix="x3render-")
    chrome = subprocess.Popen(
        ["google-chrome", *FLAGS, f"--remote-debugging-port={PORT}",
         f"--window-size={width},{height}", f"--user-data-dir={profile}",
         f"{WEB}/?{'model=' + revision.split(':', 1)[1] if revision.startswith('model:') else 'rev=' + revision}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        page = None
        for _ in range(60):
            try:
                tabs = json.load(urllib.request.urlopen(
                    f"http://127.0.0.1:{PORT}/json"))
                page = next(t for t in tabs if t["type"] == "page"
                            and ("rev=" in t["url"] or "model=" in t["url"]))
                break
            except Exception:
                time.sleep(0.5)
        if page is None:
            sys.exit("chrome did not start; is the dev server up?")

        ws = connect(page["webSocketDebuggerUrl"], max_size=80_000_000)
        seq = [0]

        def send(method, params=None):
            seq[0] += 1
            ws.send(json.dumps({"id": seq[0], "method": method,
                                "params": params or {}}))
            while True:
                msg = json.loads(ws.recv())
                if msg.get("id") == seq[0]:
                    return msg.get("result", {})

        def js(expr):
            r = send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
            return r.get("result", {}).get("value")

        send("Runtime.enable")
        for _ in range(wait * 2):
            if js("!!document.querySelector('canvas')"):
                break
            time.sleep(0.5)
        time.sleep(6)                       # let the camera settle on the model

        # ?rev= also pops the revision card over the top-right corner, which
        # is exactly where the model usually sits. It is not part of the model.
        # Dismissing it would release the held camera too, so only hide it.
        js("document.querySelectorAll('.tcv-card.absolute')"
           ".forEach(e => e.style.visibility = 'hidden')")
        time.sleep(0.5)

        box = js("(()=>{const c=document.querySelector('canvas');"
                 "const r=c.getBoundingClientRect();"
                 "return JSON.stringify([r.left|0,r.top|0,r.width|0,r.height|0])})()")
        x, y, w, h = json.loads(box)
        shot = send("Page.captureScreenshot", {"format": "png",
                                               "clip": {"x": x, "y": y, "width": w,
                                                        "height": h, "scale": 1}})
        out.write_bytes(base64.b64decode(shot["data"]))
        return out
    finally:
        chrome.terminate()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("revision", help="revision id, or model:<name> for a "
                                     "plain shot of one model")
    ap.add_argument("-o", "--out")
    ap.add_argument("--width", type=int, default=1500)
    ap.add_argument("--height", type=int, default=950)
    ap.add_argument("--wait", type=int, default=40)
    args = ap.parse_args()
    out = Path(args.out or f"/tmp/after-{args.revision.replace(':', '-')}.png")
    render(args.revision, out, args.width, args.height, args.wait)
    print(f"{out}   ({out.stat().st_size} bytes)")
    print("Open it with the Read tool and compare against the revision drawing.")


if __name__ == "__main__":
    main()
