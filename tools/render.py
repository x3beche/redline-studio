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


def _ink(png: bytes) -> float:
    """Fraction of pixels that are not the background gradient."""
    import io

    from PIL import Image

    img = Image.open(io.BytesIO(png)).convert("RGB")
    small = img.resize((160, 120))
    px = list(small.getdata())
    # The background runs pale blue-grey; anything darker or more saturated
    # is the model.
    off = sum(1 for r, g, b in px if max(r, g, b) - min(r, g, b) > 24 or r < 190)
    return off / len(px)


def render(revision: str, out: Path, width: int, height: int, wait: int,
           camera: str | None = None) -> Path:
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
        # Waiting for a canvas is not waiting for the model: the canvas exists
        # within a second, while a 50 MB payload takes the best part of a
        # minute. Every shot taken that way came out empty. Wait for the
        # viewer to hold a scene and for the canvas to have been laid out.
        probe = ("(() => { const c = document.querySelector('canvas');"
                 " if (!c) return '0x0/0';"
                 " const n = (window.tcv && window.tcv.scene)"
                 "   ? window.tcv.scene.children.length : 0;"
                 " return c.width + 'x' + c.height + '/' + n; })()")
        seen, stable = None, 0
        for _ in range(wait * 2):
            now = js(probe)
            if now == seen and now and not now.startswith("0x0"):
                stable += 1
                width = int(now.split("x")[0])
                if stable >= 3 and width > 500 and not now.endswith("/0"):
                    break
            else:
                seen, stable = now, 0
            time.sleep(1)
        time.sleep(5)                       # let the camera settle on the model

        # --camera overrides the stored angle. A revision's camera looks at
        # what the user drew on; checking the result sometimes needs a
        # different side of the part, and clicking one up by hand is slow.
        if camera:
            n = [float(v) for v in camera.replace(" ", "").split(",")]
            if len(n) != 6:
                raise SystemExit("--camera wants px,py,pz,tx,ty,tz")
            js(f"(() => {{ const v = window.tcv; if (!v) return 'no viewer';"
               f" v.setCameraTarget([{n[3]},{n[4]},{n[5]}], false);"
               f" v.setCameraPosition([{n[0]},{n[1]},{n[2]}], false, true);"
               f" return 'ok'; }})()")
            time.sleep(3)

        # ?rev= also pops the revision card over the top-right corner, which
        # is exactly where the model usually sits. It is not part of the model.
        # Dismissing it would release the held camera too, so only hide it.
        js("document.querySelectorAll('.tcv-card.absolute')"
           ".forEach(e => e.style.visibility = 'hidden')")
        time.sleep(0.5)

        # The signals above say the page is ready, not that the geometry is on
        # screen. Check the picture itself: a nearly uniform frame is the
        # background, so wait and take it again.
        for attempt in range(3):
            box = js("(()=>{const c=document.querySelector('canvas');"
                     "const r=c.getBoundingClientRect();"
                     "return JSON.stringify([r.left|0,r.top|0,r.width|0,r.height|0])})()")
            x, y, w, h = json.loads(box)
            shot = send("Page.captureScreenshot",
                        {"format": "png",
                         "clip": {"x": x, "y": y, "width": w, "height": h,
                                  "scale": 1}})
            data = base64.b64decode(shot["data"])
            if _ink(data) > 0.02 or attempt == 2:
                out.write_bytes(data)
                return out
            print(f"frame looks empty, waiting ({attempt + 1}/2)")
            time.sleep(25)
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
    ap.add_argument("--camera", help="px,py,pz,tx,ty,tz - look from somewhere "
                                     "other than the stored angle")
    args = ap.parse_args()
    out = Path(args.out or f"/tmp/after-{args.revision.replace(':', '-')}.png")
    render(args.revision, out, args.width, args.height, args.wait, args.camera)
    print(f"{out}   ({out.stat().st_size} bytes)")
    print("Open it with the Read tool and compare against the revision drawing.")


if __name__ == "__main__":
    main()
