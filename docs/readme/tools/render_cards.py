"""Render the README's feature cards (docs/readme/src/*.html) to PNG.

usage: .venv/bin/python docs/readme/tools/render_cards.py [name ...]

Each page is opened in headless Chrome at device scale 2 on a transparent
background, clipped to its `.page` element and written to
docs/readme/<name>.png, then quantized by frame.py (--raw). Needs the
repo's browser helper (backend/browser.py) and websockets.
"""
import base64, functools, http.server, json, os, subprocess, sys, tempfile, threading, time, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)
from backend import browser  # noqa: E402
from websockets.sync.client import connect  # noqa: E402

SRC = os.path.join(ROOT, "docs", "readme", "src")
OUT = os.path.join(ROOT, "docs", "readme")


def main(names):
    names = names or sorted(f[:-5] for f in os.listdir(SRC) if f.endswith(".html"))
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    handler = functools.partial(Quiet, directory=ROOT)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}/docs/readme/src/"
    port = browser.free_port()
    found = browser.find_browser()
    name = f"redline-cards-{int(time.time())}"
    argv = browser.argv(found, port=port, width=1400, height=1000, profile=tempfile.mkdtemp(),
                        url="about:blank", name=name, flags=["--headless=new", "--hide-scrollbars"])
    chrome = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
                page = next(t for t in tabs if t["type"] == "page")
                break
            except Exception:
                time.sleep(0.5)
        ws = connect(page["webSocketDebuggerUrl"], max_size=200_000_000)
        seq = [0]

        def send(method, params=None):
            seq[0] += 1
            ws.send(json.dumps({"id": seq[0], "method": method, "params": params or {}}))
            while True:
                msg = json.loads(ws.recv())
                if msg.get("id") == seq[0]:
                    return msg.get("result", {})
                if msg.get("method") == "Runtime.exceptionThrown":
                    print("  exception:", msg["params"]["exceptionDetails"].get("exception", {}).get("description"))
                if msg.get("method") == "Runtime.consoleAPICalled":
                    print("  console:", [a.get("value") for a in msg["params"]["args"]])

        def js(expr):
            r = send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
            return r.get("result", {}).get("value")

        send("Runtime.enable")
        send("Emulation.setDeviceMetricsOverride", {"width": 1400, "height": 1000, "deviceScaleFactor": 2, "mobile": False})
        send("Emulation.setDefaultBackgroundColorOverride", {"color": {"r": 0, "g": 0, "b": 0, "a": 0}})
        for n in names:
            send("Page.navigate", {"url": base + n + ".html"})
            time.sleep(0.6)
            js("new Promise(r => { const f = () => document.readyState === 'complete' ? document.fonts.ready.then(() => Promise.all([...document.images].map(i => i.decode().catch(() => 0)))).then(r) : setTimeout(f, 100); f(); })")
            time.sleep(0.3)
            x, y, w, h = js("(() => { const r = document.querySelector('.page').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()")
            r = send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True,
                                                "clip": {"x": x, "y": y, "width": w, "height": h, "scale": 1}})
            raw = os.path.join(tempfile.gettempdir(), f"card-{n}.png")
            open(raw, "wb").write(base64.b64decode(r["data"]))
            subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "frame.py"), raw,
                            os.path.join(OUT, n + ".png"), "--raw", "--quality", "90"], check=False)
    finally:
        srv.shutdown()
        subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        chrome.kill()


if __name__ == "__main__":
    main(sys.argv[1:])
