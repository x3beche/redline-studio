"""The Mobile Programming room's phone: an emulated Pixel 7 in a container.

One long-lived container, `redline-phone`, from the Mobile image, with
KVM passed through and the host's network - so the phone's 10.0.2.2 is
the host's loopback and a dev server on 127.0.0.1 is reachable from its
browser. Its adb server listens on its own port, so an adb on the host is
never in its way.

What there is to look at is the phone's screen, as `screencap` draws it.
What is on it comes from one of two places: `uiautomator dump` for a
native app - every view with its bounds, resource id and text - or, for a
page in the phone's Chrome, Chrome's own DevTools socket, which lists the
elements the way the Web room does, converted to the screen's pixels.
"""

from __future__ import annotations

import json
import re
import struct
import subprocess
import time
import urllib.request
from pathlib import Path
from xml.etree import ElementTree

from . import sandbox

CONTAINER = "redline-phone"
ADB_PORT = "5038"
CDP_PORT = 9333
BOOT_S = 240


def _exec(*args: str, binary: bool = False, timeout: float = 60):
    out = subprocess.run(["docker", "exec", "-e", f"ANDROID_ADB_SERVER_PORT={ADB_PORT}",
                          CONTAINER, *args], capture_output=True, timeout=timeout)
    return out.stdout if binary else out.stdout.decode(errors="replace")


def adb(*args: str, binary: bool = False, timeout: float = 60):
    return _exec("adb", *args, binary=binary, timeout=timeout)


def state() -> dict:
    """Whether the phone's container runs, and whether Android is up."""
    try:
        running = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", CONTAINER],
            capture_output=True, text=True, timeout=10).stdout.strip() == "true"
    except (OSError, subprocess.TimeoutExpired):
        running = False
    booted = False
    if running:
        try:
            booted = adb("shell", "getprop", "sys.boot_completed",
                         timeout=10).strip() == "1"
        except subprocess.TimeoutExpired:
            pass
    return {"container": running, "booted": booted,
            "image": sandbox.image_of("mobile")}


def boot(wait: bool = True) -> dict:
    """Start the phone, or start it again. Minutes the first time; the
    container is kept, so its snapshot makes the next boot quick."""
    st = state()
    if st["booted"]:
        return {**st, "started": False}
    if not st["container"]:
        if not sandbox.have_image("mobile"):
            raise sandbox.NoImage(f"the mobile image is not built: "
                                  f"{sandbox.build_hint('mobile')}")
        exists = subprocess.run(["docker", "inspect", CONTAINER],
                                capture_output=True).returncode == 0
        if exists:
            subprocess.run(["docker", "start", CONTAINER], capture_output=True,
                           check=True)
        else:
            subprocess.run(
                ["docker", "run", "-d", "--name", CONTAINER, "--device", "/dev/kvm",
                 "--network", "host", "-e", f"ANDROID_ADB_SERVER_PORT={ADB_PORT}",
                 sandbox.image_of("mobile")], capture_output=True, check=True)
    if not wait:
        return {**state(), "started": True}
    t0 = time.monotonic()
    while time.monotonic() - t0 < BOOT_S:
        if state()["booted"]:
            _prepare_chrome()
            return {**state(), "started": True,
                    "boot_s": round(time.monotonic() - t0, 1)}
        time.sleep(3)
    raise TimeoutError(f"the phone did not finish booting in {BOOT_S}s")


# What a person presses to get past Chrome's first run, and past the
# questions Android asks the first time a page is opened. Pressed the way
# a person would - found on the screen by its words - because the Play
# Store image ignores the command-line flags that would skip them.
PAST = ("Use without an account", "No thanks", "No, thanks", "Accept & continue",
        "Got it", "Don't allow", "Not now", "Skip", "Continue", "Done")


def _prepare_chrome(rounds: int = 8) -> list[str]:
    """Open Chrome once and press through its welcome screens. The phone
    keeps the answer, so this is once per phone, not once per freeze."""
    adb("shell", "am", "start", "-W", "-a", "android.intent.action.VIEW",
        "-d", "about:blank", "com.android.chrome")
    return press_through(rounds)


def press_through(rounds: int = 8) -> list[str]:
    """Press whatever is standing between the screen and the page."""
    pressed: list[str] = []
    for _ in range(rounds):
        time.sleep(1.5)
        hit = next((e for e in parse_dump(dump())
                    if e["text"].strip() in PAST), None)
        if not hit:
            break
        x, y, w, h = hit["box"]
        adb("shell", "input", "tap", str(x + w // 2), str(y + h // 2))
        pressed.append(hit["text"].strip())
    return pressed


def screen() -> bytes:
    """The screen as a PNG, as the phone draws it."""
    return adb("exec-out", "screencap", "-p", binary=True, timeout=30)


def png_size(png: bytes) -> tuple[int, int]:
    if png[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    return struct.unpack(">II", png[16:24])


def open_app(app: dict, route: str = "/") -> None:
    """Bring the project up on the phone: its own activity when it is an
    app, its page in Chrome when it is served on the web."""
    if app.get("package"):
        target = app["package"] + "/" + (app.get("activity") or ".MainActivity")
        adb("shell", "am", "start", "-W", "-n", target)
    else:
        url = (app.get("url") or "").rstrip("/") + (route or "/")
        adb("shell", "am", "start", "-W", "-a", "android.intent.action.VIEW",
            "-d", url, "com.android.chrome")
    # Anything the system put in front of it - a first run, a permission.
    press_through(3)


# ---------------- what is on the screen ----------------
BOUNDS = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")


def dump() -> str:
    return adb("exec-out", "sh", "-c",
               "uiautomator dump /sdcard/ui.xml >/dev/null && cat /sdcard/ui.xml",
               timeout=60)


def parse_dump(xml: str) -> list[dict]:
    """uiautomator's view tree as the element list a mark is laid on.

    A view with a resource id is named by it - that is what the source
    says - and one without by its class and position among its siblings.
    """
    try:
        root = ElementTree.fromstring(xml[xml.index("<"):])
    except (ValueError, ElementTree.ParseError):
        return []
    out: list[dict] = []

    def walk(node, path: str) -> None:
        for n, child in enumerate(node.findall("node")):
            cls = (child.get("class") or "View").rsplit(".", 1)[-1]
            rid = child.get("resource-id") or ""
            step = rid.split("/", 1)[-1] if rid else f"{cls}[{n}]"
            here = f"{path} > {step}" if path else step
            m = BOUNDS.match(child.get("bounds") or "")
            if m:
                x0, y0, x1, y1 = map(int, m.groups())
                if x1 - x0 >= 3 and y1 - y0 >= 3:
                    out.append({
                        "i": len(out), "tag": cls,
                        "sel": ("#" + rid.split("/", 1)[-1]) if rid else here,
                        "text": (child.get("text") or child.get("content-desc") or "")[:60],
                        "box": [x0, y0, x1 - x0, y1 - y0],
                        "own": {"rid": rid, "package": child.get("package")}})
            walk(child, here)

    walk(root, "")
    return out


def content_top(elements: list[dict], screen_h: int, inner_css_h: float,
                dpr: float) -> int:
    """Where a page's first CSS pixel lands on the screen. Chrome draws its
    toolbar above the page and Android its navigation bar below, so the
    page ends at the bar's top and starts its own height above that."""
    bar = next((e for e in elements
                if (e["own"].get("rid") or "").endswith("navigationBarBackground")), None)
    bottom = bar["box"][1] if bar else screen_h
    return max(0, round(bottom - inner_css_h * dpr))


def web_inventory(app_url: str, elements_native: list[dict],
                  screen_h: int) -> list[dict]:
    """The page's elements from the phone's Chrome, in screen pixels."""
    from .webshot import INVENTORY, Cdp

    adb("forward", f"tcp:{CDP_PORT}", "localabstract:chrome_devtools_remote")
    tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json",
                                            timeout=5))
    page = next((t for t in tabs if t.get("type") == "page"
                 and (t.get("url") or "").startswith(app_url.rstrip("/"))), None) \
        or next((t for t in tabs if t.get("type") == "page"), None)
    if not page:
        return []
    cdp = Cdp(page["webSocketDebuggerUrl"])
    try:
        inv = json.loads(cdp.js(INVENTORY) or "{}")
        dpr = float(cdp.js("devicePixelRatio") or 1)
    finally:
        cdp.close()
    top = content_top(elements_native, screen_h, inv.get("h") or 0, dpr)
    for e in inv.get("els") or []:
        x, y, w, h = e["box"]
        e["box"] = [round(x * dpr), round(top + y * dpr), round(w * dpr), round(h * dpr)]
    return inv.get("els") or []


def source_of_view(repo: str | Path, rid: str) -> dict | None:
    """The file that declares a view, by its resource id: a layout's
    `@+id/name`, code's `R.id.name`, or Compose's `testTag("name")`."""
    name = rid.split("/", 1)[-1] if rid else ""
    if not re.fullmatch(r"[A-Za-z0-9_]+", name or ""):
        return None
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "grep", "-n", "-E",
             rf"@\+id/{name}\b|R\.id\.{name}\b|testTag\(\"{name}\"\)"],
            capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    first = out.splitlines()[0] if out else ""
    m = re.match(r"^(.*?):(\d+):", first)
    return {"file": m.group(1), "line": int(m.group(2))} if m else None
