"""A picture of a running page, and what is on it.

The note a person leaves on an interface is "this button", not "these
pixels", so a screenshot on its own is half the record. This takes the
picture with headless Chrome over the DevTools protocol - the same way
tools/render.py photographs a model - and in the same breath lists every
element that is visible: its box on the picture, a selector for it, its
text, and the component that renders it.

Afterwards the marks drawn over the picture are laid on that list, and
what they cover or point at is what the note is about.
"""

from __future__ import annotations

import base64
import gzip
import json
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / ".cache" / "shots"

# The same backend tools/render.py uses: a page that draws with WebGL (this
# one does) comes out black with the default one on this machine.
FLAGS = ["--headless=new", "--ignore-gpu-blocklist", "--use-angle=gl",
         "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
         "--disable-gpu-sandbox", "--remote-debugging-port=0"]

# Walked once per shot, inside the page. Kept compact: two thousand
# elements with a selector each is already a few hundred kilobytes.
INVENTORY = r"""
(() => {
  const W = innerWidth, H = innerHeight, out = [];
  const skip = new Set(['SCRIPT','STYLE','LINK','META','HEAD','TITLE','NOSCRIPT','BR','TEMPLATE']);
  const esc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : s;
  function step(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id && document.querySelectorAll('#' + esc(el.id)).length === 1)
      return {s: '#' + esc(el.id), stop: true};
    let s = tag;
    const cls = [...el.classList].filter(c => !/^ng-|^_ng|:/.test(c)).slice(0, 2);
    if (cls.length) s += '.' + cls.map(esc).join('.');
    const p = el.parentElement;
    if (p) {
      const same = [...p.children].filter(c => c.tagName === el.tagName);
      if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
    }
    return {s, stop: tag.includes('-')};
  }
  function selector(el) {
    const parts = [];
    for (let e = el, n = 0; e && e.nodeType === 1 && n < 6; e = e.parentElement, n++) {
      const st = step(e);
      parts.unshift(st.s);
      if (st.stop || e === document.body) break;
    }
    return parts.join(' > ');
  }
  function owner(el) {
    // Angular in development says who owns an element; the host's tag is
    // what the source is searched for.
    try {
      if (window.ng && ng.getOwningComponent) {
        const c = ng.getOwningComponent(el);
        const host = c && ng.getHostElement(c);
        if (host) return {tag: host.tagName.toLowerCase(), name: c.constructor && c.constructor.name};
      }
    } catch (e) {}
    // React in development keeps where each element was written.
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber'));
    if (key) {
      for (let f = el[key]; f; f = f.return) {
        if (f._debugSource) return {file: f._debugSource.fileName, line: f._debugSource.lineNumber,
                                    name: f.type && (f.type.displayName || f.type.name)};
      }
    }
    for (let e = el.parentElement; e; e = e.parentElement)
      if (e.tagName.includes('-')) return {tag: e.tagName.toLowerCase()};
    return null;
  }
  function text(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    t = t.replace(/\s+/g, ' ').trim();
    return (t || el.getAttribute('aria-label') || el.getAttribute('title')
            || el.getAttribute('placeholder') || '').slice(0, 60);
  }
  const all = document.body ? document.body.querySelectorAll('*') : [];
  for (const el of all) {
    if (out.length >= 3000) break;
    if (skip.has(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3 || r.right < 0 || r.bottom < 0 || r.left > W || r.top > H) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    const o = owner(el);
    out.push({i: out.length, tag: el.tagName.toLowerCase(), sel: selector(el), text: text(el),
              box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
              own: o});
  }
  return JSON.stringify({w: W, h: H, title: document.title, url: location.href, els: out});
})()
"""

# Nothing on the page moves for this long and it is called ready. Angular
# boots after the load event, so the load event alone is too early.
SETTLE_POLLS = 3
POLL_S = 0.35


class Cdp:
    """Just enough of the DevTools protocol: one page, commands in order."""

    def __init__(self, ws_url: str) -> None:
        from websockets.sync.client import connect
        self.ws = connect(ws_url, max_size=120_000_000)
        self.seq = 0

    def send(self, method: str, params: dict | None = None,
             timeout: float = 30) -> dict:
        self.seq += 1
        self.ws.send(json.dumps({"id": self.seq, "method": method,
                                 "params": params or {}}))
        end = time.monotonic() + timeout
        while True:
            msg = json.loads(self.ws.recv(timeout=max(0.1, end - time.monotonic())))
            if msg.get("id") == self.seq:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error'].get('message')}")
                return msg.get("result", {})

    def js(self, expr: str):
        r = self.send("Runtime.evaluate", {"expression": expr,
                                           "returnByValue": True})
        return r.get("result", {}).get("value")

    def close(self) -> None:
        try:
            self.ws.close()
        except Exception:                            # noqa: BLE001
            pass


def _devtools_port(profile: Path, chrome: subprocess.Popen,
                   wait: float = 15) -> int:
    """Chrome picks a free port and writes it into the profile. Asking for
    port 0 means two shots at once never fight over one."""
    end = time.monotonic() + wait
    marker = profile / "DevToolsActivePort"
    while time.monotonic() < end:
        if chrome.poll() is not None:
            raise RuntimeError("chrome exited before it opened its port")
        try:
            return int(marker.read_text().split("\n", 1)[0])
        except (OSError, ValueError):
            time.sleep(0.1)
    raise TimeoutError("chrome did not open a DevTools port")


def shoot(url: str, width: int, height: int, wait: float = 25,
          meter_into: dict | None = None) -> dict:
    """Open `url` at `width` x `height`, wait for it to settle, and return
    the PNG and the element inventory. Blocking: call it from a thread."""
    profile = Path(tempfile.mkdtemp(prefix="x3shot-"))
    chrome = subprocess.Popen(
        ["google-chrome", *FLAGS, f"--user-data-dir={profile}",
         f"--window-size={width},{height}", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    from . import compute
    meter = compute.ProcMeter(chrome.pid)
    t0 = time.monotonic()
    cdp = None
    try:
        port = _devtools_port(profile, chrome)
        page = None
        for _ in range(50):
            tabs = json.load(urllib.request.urlopen(
                f"http://127.0.0.1:{port}/json", timeout=3))
            page = next((t for t in tabs if t.get("type") == "page"), None)
            if page:
                break
            time.sleep(0.1)
        if not page:
            raise RuntimeError("chrome opened no page")
        cdp = Cdp(page["webSocketDebuggerUrl"])
        cdp.send("Page.enable")
        cdp.send("Runtime.enable")
        # The picture is the viewport asked for, pixel for pixel: a mark's
        # coordinates on it are then the element boxes' coordinates too.
        cdp.send("Emulation.setDeviceMetricsOverride",
                 {"width": width, "height": height, "deviceScaleFactor": 1,
                  "mobile": width < 600})
        cdp.send("Page.navigate", {"url": url})
        end = time.monotonic() + wait
        seen, still = None, 0
        while time.monotonic() < end:
            now = cdp.js("document.readyState + ':' + "
                         "(document.body ? document.body.querySelectorAll('*').length : 0)")
            if now and now.startswith("complete") and now == seen:
                still += 1
                if still >= SETTLE_POLLS:
                    break
            else:
                seen, still = now, 0
            time.sleep(POLL_S)
        time.sleep(0.4)                      # a transition or two finishing
        inv = json.loads(cdp.js(INVENTORY) or "{}")
        shot = cdp.send("Page.captureScreenshot",
                        {"format": "png", "clip": {"x": 0, "y": 0,
                                                   "width": width,
                                                   "height": height,
                                                   "scale": 1}})
        png = base64.b64decode(shot["data"])
    finally:
        if meter_into is not None:
            meter_into.update(meter.stop())
            meter_into["wall_s"] = round(time.monotonic() - t0, 2)
        else:
            meter.stop()
        if cdp:
            cdp.close()
        chrome.terminate()
        try:
            chrome.wait(5)
        except subprocess.TimeoutExpired:
            chrome.kill()
        shutil.rmtree(profile, ignore_errors=True)
    return {"png": png, "width": width, "height": height,
            "title": inv.get("title"), "url": inv.get("url") or url,
            "elements": inv.get("els") or []}


# ---------------- keeping a shot between the freeze and the save ----------------
# The person draws for as long as they like between taking the picture and
# saving the note, and the server reloads itself whenever a file changes.
# So the inventory waits on disk, not in memory. A few hundred kilobytes
# gzipped; the note keeps only the elements the marks landed on.
def keep(shot: dict, meta: dict) -> str:
    sid = uuid.uuid4().hex[:12]
    SHOTS.mkdir(parents=True, exist_ok=True)
    body = {k: v for k, v in shot.items() if k != "png"} | meta
    (SHOTS / f"{sid}.json.gz").write_bytes(
        gzip.compress(json.dumps(body).encode(), 5))
    (SHOTS / f"{sid}.png").write_bytes(shot["png"])
    _prune()
    return sid


def recall(sid: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{12}", sid):
        raise KeyError(sid)
    try:
        return json.loads(gzip.decompress((SHOTS / f"{sid}.json.gz").read_bytes()))
    except OSError:
        raise KeyError(sid)


def picture(sid: str) -> bytes:
    if not re.fullmatch(r"[0-9a-f]{12}", sid):
        raise KeyError(sid)
    try:
        return (SHOTS / f"{sid}.png").read_bytes()
    except OSError:
        raise KeyError(sid)


def _prune(keep_n: int = 60) -> None:
    files = sorted(SHOTS.glob("*.json.gz"), key=lambda p: p.stat().st_mtime)
    for old in files[:-keep_n]:
        old.unlink(missing_ok=True)
        old.with_name(old.name.replace(".json.gz", ".png")).unlink(missing_ok=True)


# ---------------- what the marks landed on ----------------
def _area(b) -> float:
    return max(0, b[2]) * max(0, b[3])


def _overlap(a, b) -> float:
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    return max(0, x1 - x0) * max(0, y1 - y0)


def _inside(b, pt) -> bool:
    return b[0] <= pt[0] <= b[0] + b[2] and b[1] <= pt[1] <= b[1] + b[3]


COVERED = 0.7


def under(elements: list[dict], marks: list[dict], per_mark: int = 4,
          width: int | None = None, height: int | None = None) -> list[dict]:
    """The elements a set of marks is about.

    Two ways a person marks something. They ring it - a rectangle, an
    ellipse, a loop of pen - and then the mark covers the element: the
    outermost element at least half inside the ring is the one meant, not
    the text node inside it. Or they point at it - an arrow, a stroke, a
    word - and then the element is the smallest one under the tip.

    `marks` are `{box: [x, y, w, h], tip: [x, y] | None}` in the picture's
    own pixels. Anything that is the whole page is ignored: `body` is under
    every mark and says nothing.
    """
    page = (width or 0) * (height or 0)
    usable = [e for e in elements
              if not page or _area(e["box"]) < 0.6 * page]
    chosen: list[dict] = []
    for m in marks:
        box = m["box"]
        tip = m.get("tip")
        picks: list[dict] = []
        if tip is None:
            ringed = [e for e in usable if _area(e["box"]) >= 16
                      and _overlap(e["box"], box) >= COVERED * _area(e["box"])
                      and _area(e["box"]) >= 0.02 * max(_area(box), 1)]
            # The outermost of what the ring covers: a ringed button covers
            # its label too, and the button is what was meant.
            outer = [e for e in ringed
                     if not any(o is not e and _contains(o["box"], e["box"])
                                for o in ringed)]
            outer.sort(key=lambda e: -_area(e["box"]))
            picks = outer[:per_mark]
            # A ring round nothing in particular - drawn inside one big
            # panel - is about the smallest thing under its middle.
            tip = [box[0] + box[2] / 2, box[1] + box[3] / 2]
        # Something pointed at: an arrow crosses half the page on its way
        # to the one thing it means, so only its head counts.
        if not picks:
            hits = [e for e in usable if _inside(e["box"], tip)]
            hits.sort(key=lambda e: _area(e["box"]))
            picks = hits[:1]
        for e in picks:
            if all(c["i"] != e["i"] for c in chosen):
                chosen.append(e)
    return chosen


def _contains(outer, inner) -> bool:
    return (outer[0] <= inner[0] and outer[1] <= inner[1]
            and outer[0] + outer[2] >= inner[0] + inner[2]
            and outer[1] + outer[3] >= inner[1] + inner[3]
            and _area(outer) > _area(inner))


# ---------------- which file renders it ----------------
_FILES: dict[tuple[str, str], dict | None] = {}


def source_of(repo: str | Path, tag: str | None,
              name: str | None = None) -> dict | None:
    """The file a component is written in, found by its selector.

    An Angular component is declared with `selector: 'app-room-pcb'`, and
    its markup is either inline or in the file `templateUrl` names; the
    markup is what a mark on the page is about, so that is the file given
    when there is one. Asked of git, so node_modules and build output are
    never searched.
    """
    if not tag:
        return None
    key = (str(repo), tag)
    if key in _FILES:
        return _FILES[key]
    found = None
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "grep", "-l", "-E",
             rf"selector:\s*['\"]{re.escape(tag)}['\"]", "--",
             "*.ts", "*.js", "*.tsx", "*.jsx"],
            capture_output=True, timeout=10)
        files = out.stdout.decode().split()
    except (OSError, subprocess.TimeoutExpired):
        files = []
    if files:
        ts = files[0]
        found = {"ts": ts, "file": ts}
        try:
            text = (Path(repo) / ts).read_text()
            m = re.search(r"templateUrl:\s*['\"]([^'\"]+)['\"]", text)
            if m:
                html = (Path(ts).parent / m.group(1)).as_posix()
                html = str(Path(html)).replace("\\", "/")
                found["file"] = re.sub(r"(^|/)\./", r"\1", html)
        except OSError:
            pass
        if name:
            found["name"] = name
    _FILES[key] = found
    return found


def describe(repo: str | Path, e: dict) -> dict:
    """One element as a note keeps it: where it is, what it says, and the
    file it is written in."""
    own = e.get("own") or {}
    src = None
    if own.get("file"):
        path = str(own["file"])
        try:
            path = str(Path(path).resolve().relative_to(Path(repo).resolve()))
        except ValueError:
            pass
        src = {"file": path, "line": own.get("line"), "name": own.get("name")}
    else:
        src = source_of(repo, own.get("tag"), own.get("name"))
    # A development build names the class `_RoomPcb`; the source says
    # RoomPcb, and the source is what the name is for.
    name = (own.get("name") or "").lstrip("_") or None
    return {"selector": e["sel"], "tag": e["tag"], "text": e.get("text") or "",
            "box": e["box"], "component": name or own.get("tag"),
            "file": (src or {}).get("file"), "line": (src or {}).get("line")}


def label(d: dict) -> str:
    """How an element reads in the Part field: short enough for a select."""
    what = d["tag"]
    last = d["selector"].split(" > ")[-1]
    if "." in last or "#" in last:
        what = re.sub(r":nth-of-type\(\d+\)", "", last)
    if d.get("text"):
        what += f' "{d["text"][:24]}"'
    where = d.get("file")
    if where:
        where = "/".join(where.split("/")[-2:])
    return f"{what} · {where}" if where else what
