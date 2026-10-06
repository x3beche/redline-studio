#!/usr/bin/env python
"""Render the current model from a revision's camera angle.

After applying a revision, take the picture from exactly the angle the user
drew on, so the before and after can be compared side by side.

    python tools/render.py <revision_id> [-o out.png] [--width 1500]

--width and --height are the size of the picture, not of the browser
window: the window is grown until the canvas measures what was asked for.

Needs the dev server running (start.sh). Drives headless Chrome, waits for
the viewer to load the model and move to the stored camera, then captures
the canvas.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
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


# Where a browser is looked for, in order. REDLINE_CHROME names one outright
# (a path, a command on PATH, or "docker" for the container below); then
# whatever is installed; then a headless Chromium in a container, which is
# what a machine with no browser of its own has. It used to be
# "google-chrome" and nothing else, and a box with Chromium - or none -
# failed with FileNotFoundError before it had looked anywhere.
NAMES = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
         "chrome")
PLACES = ("/opt/google/chrome/chrome", "/usr/bin/google-chrome",
          "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium",
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
IMAGE = os.environ.get("REDLINE_CHROME_IMAGE", "zenika/alpine-chrome:with-puppeteer")
# In the container there is no GPU: WebGL goes through SwiftShader, and
# there is no user namespace for Chrome's sandbox.
DOCKER_FLAGS = ["--headless=new", "--no-first-run", "--no-sandbox",
                "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                "--disable-dev-shm-usage"]


class NoBrowser(RuntimeError):
    pass


def _image_there(image: str) -> bool:
    if not shutil.which("docker"):
        return False
    try:
        return subprocess.run(["docker", "image", "inspect", image],
                              capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def find_browser(env: dict | None = None, which=shutil.which,
                 exists=os.path.exists, image_there=_image_there) -> tuple[str, str]:
    """("local", path) for an installed browser, ("docker", image) for the
    container. Raises NoBrowser naming everything it tried."""
    env = os.environ if env is None else env
    want = (env.get("REDLINE_CHROME") or "").strip()
    if want:
        if want == "docker" or want.startswith("docker:"):
            image = want.partition(":")[2] or IMAGE
            if image_there(image):
                return "docker", image
            raise NoBrowser(f"REDLINE_CHROME={want}: no docker image {image}")
        got = which(want) or (want if exists(want) else None)
        if got:
            return "local", got
        raise NoBrowser(f"REDLINE_CHROME={want}: not found")
    for name in NAMES:
        got = which(name)
        if got:
            return "local", got
    for place in PLACES:
        if exists(place):
            return "local", place
    if image_there(IMAGE):
        return "docker", IMAGE
    raise NoBrowser("no browser: tried " + ", ".join(NAMES) + " on PATH, "
                    + ", ".join(PLACES) + f", and the docker image {IMAGE}. "
                    "Install Chrome/Chromium, or set REDLINE_CHROME to one.")


def browser_argv(found: tuple[str, str], port: int, width: int, height: int,
                 profile: str, url: str, name: str) -> list[str]:
    how, what = found
    tail = [f"--remote-debugging-port={port}", f"--window-size={width},{height}"]
    if how == "docker":
        # Host network: the page is on 127.0.0.1:4200 and the DevTools port
        # has to be reachable on the host's 127.0.0.1 too. The profile lives
        # and dies in the container.
        return ["docker", "run", "--rm", "--name", name, "--network", "host",
                "--shm-size", "1g", "--entrypoint", "chromium-browser", what,
                *DOCKER_FLAGS, *tail, "--remote-debugging-address=127.0.0.1",
                "--user-data-dir=/tmp/profile", url]
    return [what, *FLAGS, *tail, f"--user-data-dir={profile}", url]


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


# What the browser spent. The picture is the return value, so the meter's
# reading is left here for main() to log - chrome is killed rather than
# waited for, and nothing else in the process ever sees its time.
LAST_JOB: dict = {}


def render(revision: str, out: Path, width: int, height: int, wait: int,
           camera: str | None = None, only: str | None = None) -> Path:
    from websockets.sync.client import connect

    try:
        found = find_browser()
    except NoBrowser as exc:
        sys.exit(str(exc))
    profile = tempfile.mkdtemp(prefix="x3render-")
    name = f"x3render-{os.getpid()}"
    url = (f"{WEB}/?{'model=' + revision.split(':', 1)[1] if revision.startswith('model:') else 'rev=' + revision}")
    chrome = subprocess.Popen(
        browser_argv(found, PORT, width, height, profile, url, name),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from backend import compute
    meter = compute.ProcMeter(chrome.pid)
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
            sys.exit(f"chrome ({found[0]}: {found[1]}) did not start; "
                     "is the dev server up?")

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
                if stable >= 3 and int(now.split("x")[0]) > 500 \
                        and not now.endswith("/0"):
                    break
            else:
                seen, stable = now, 0
            time.sleep(1)

        # The window is not the picture. The catalog, the queue, the tree
        # column, the toolbar and the log all take their cut before the
        # canvas gets any, and it is not a fixed cut - it moves with the
        # layout. Asking for 1200x800 used to hand back a 320x394 canvas.
        # So measure what came out, give the window back the difference,
        # and check. --width and --height mean the picture now.
        box = ("(() => { const c = document.querySelector('canvas');"
               " const r = c.getBoundingClientRect();"
               " return JSON.stringify([r.width|0, r.height|0,"
               " innerWidth, innerHeight]); })()")
        for _ in range(3):
            cw, ch, iw, ih = json.loads(js(box))
            dw, dh = width - cw, height - ch
            if abs(dw) <= 2 and abs(dh) <= 2:
                break
            send("Emulation.setDeviceMetricsOverride",
                 {"width": max(iw + dw, 320), "height": max(ih + dh, 240),
                  "deviceScaleFactor": 1, "mobile": False})
            time.sleep(1.5)
        else:
            print(f"canvas came out {cw}x{ch}, asked for {width}x{height}")

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

        # --only isolates one part, the way the user does before drawing on
        # it. Without it a detail inside the case is buried under the walls
        # and the check shot cannot show what the drawing showed.
        if only:
            got = js("(() => { const v = window.tcv; if (!v) return 'no viewer';"
                     " const s = v.getStates(); let n = 0;"
                     f" const want = {json.dumps(only.lower())};"
                     " for (const p of Object.keys(s)) {"
                     "   const on = p.toLowerCase().includes(want);"
                     "   v.setState(p, on ? [1, 1] : [0, 0]); if (on) n++; }"
                     " return n; })()")
            print(f"--only {only!r}: {got} part(s) left visible")
            time.sleep(2)

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
        # Read before the kill: a terminated browser takes its counters with
        # it, and its renderers are never reaped by anyone here.
        LAST_JOB.update(meter.stop())
        chrome.terminate()
        # The profile goes with it. Every render used to leave its own
        # behind in /tmp - 150 MB each, 8.7 GB of them by the time the
        # system disk filled up on 2026-09-24.
        try:
            chrome.wait(10)
        except subprocess.TimeoutExpired:
            chrome.kill()
        if found[0] == "docker":
            # Killing the docker client does not always stop the container.
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        shutil.rmtree(profile, ignore_errors=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("revision", help="revision id, or model:<name> for a "
                                     "plain shot of one model")
    ap.add_argument("-o", "--out")
    ap.add_argument("--width", type=int, default=1400,
                    help="width of the picture itself, not of the window")
    ap.add_argument("--height", type=int, default=950,
                    help="height of the picture itself")
    ap.add_argument("--wait", type=int, default=40)
    ap.add_argument("--camera", help="px,py,pz,tx,ty,tz - look from somewhere "
                                     "other than the stored angle")
    ap.add_argument("--only", help="show only parts whose tree path contains "
                                   "this text, e.g. kapak")
    args = ap.parse_args()
    out = Path(args.out or f"/tmp/after-{args.revision.replace(':', '-')}.png")
    t0 = time.monotonic()
    try:
        render(args.revision, out, args.width, args.height, args.wait, args.camera,
               args.only)
    finally:
        # A picture costs a browser: the card shows what that came to next to
        # what the model cost in tokens. Recorded whether or not the frame
        # came out - a render that timed out still ran the machine.
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from backend import compute
        compute.record_sync(Path(__file__).resolve().parent.parent, "render",
                            model=args.revision,
                            **compute.whole_process(t0, LAST_JOB))
    print(f"{out}   ({out.stat().st_size} bytes)")
    print("Open it with the Read tool and compare against the revision drawing.")


if __name__ == "__main__":
    main()
