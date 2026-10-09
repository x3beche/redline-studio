#!/usr/bin/env python
"""Render the current model from a revision's camera angle.

After applying a revision, take the picture from exactly the angle the user
drew on, so the before and after can be compared side by side.

    python tools/render.py <revision_id> [-o out.png] [--width 1500]

--width and --height are the size of the picture, not of the browser
window. The 3D page is opened in its shot layout (?shot=WxH: the viewer
alone, its canvas pinned to exactly that size, whatever panels or room the
page would otherwise lay out), and a canvas that does not come out that
size is an error, not a picture.

Another side of the model:

    python tools/render.py model:<id> --side front|back|left|right|top|bottom|iso
    python tools/render.py <id> --only knob --side top
    python tools/render.py model:<id> --camera 0,-400,60[,tx,ty,tz]

--side frames everything shown (after --only) from that side, with the
viewer's own preset directions (Z up; front looks from -Y). --camera is the
camera's position and target in the model's world millimetres - absolute,
not relative to the model's centre, which is often far from the origin (a
station standing on z=0 has its middle at z=60). Without a target it looks
at the middle of what is shown. The perspective field of view is 22 deg, so
from 400 mm away the picture is about 155 mm tall.

Needs the dev server running (start.sh). Drives headless Chrome, waits for
the viewer to load the model and move to the stored camera, then captures
the canvas.

The picture is of exactly the model asked for (a revision's own model, or
model:<id>), from its current build: a build or a linked rebuild of that
model is waited out first, the page is told which model to open, and what
the page says is on screen is checked before and after the capture. Any
mismatch is an error - a shot of some other model is worse than none.

A note's view is more than its camera: where the model was clipped, which
tab, which parts, which render settings, and the canvas's shape (frontend
api.ts NoteView, format 2). The page puts all of it back and says so in
window.redlineView (view_rev, view_applied, view_hash); the clipping and
the tab are read back from the viewer itself and compared with the note,
before and after the capture. A note drawn on a cut is never photographed
uncut. Without --width/--height the picture is the note's own canvas size;
with them, the note's aspect is kept (the framing depends on it) unless
--free-aspect says otherwise. A note from before its canvas was kept is shot
in the shape of its own drawing (the stored before image, whose pixel size
is the canvas it was drawn on).
"""

from __future__ import annotations

import hashlib
import argparse
import base64
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

WEB = "http://127.0.0.1:4200"
# The browser's DevTools port: a free one for each render. It used to be a
# fixed 9411, and two renders at once (two agents finishing at the same
# time) both talked to whichever browser had the port: each navigated,
# resized and photographed the other's page - pictures of the wrong note,
# canvases grown twice over, and a call never answered when the other run
# closed the browser under it.
PORT = 0                                    # 0: browser.free_port() per render


def devtools_page(tabs: list) -> dict | None:
    """The browser's own blank tab - not a page some other render opened."""
    return next((t for t in tabs if t.get("type") == "page"
                 and t.get("url") in ("about:blank", "")), None)
# Hardware GL through the ANGLE OpenGL backend: the default backend cannot
# create a GPU command buffer on hybrid Intel + NVIDIA machines.
FLAGS = ["--headless=new", "--ignore-gpu-blocklist", "--use-angle=gl",
         "--no-first-run", "--disable-gpu-sandbox"]


# The browser lookup lives in backend/browser.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend import browser  # noqa: E402
from backend.browser import IMAGE, NoBrowser, find_browser  # noqa: E402,F401

API = os.environ.get("REDLINE_API", "http://127.0.0.1:8000")


def browser_argv(found: tuple[str, str], port: int, width: int, height: int,
                 profile: str, url: str, name: str) -> list[str]:
    return browser.argv(found, port=port, width=width, height=height, profile=profile,
                        url=url, name=name, flags=FLAGS)


# ---------------- signing the browser in ----------------
# With sign-in on, the page shows "Sign in to continue." and no canvas. The
# browser gets a page session instead (backend/auth.py): the agents' token
# is traded for a cookie that is read-only, minutes long and in the token's
# workspace, handed to the browser over DevTools - never on a command line
# or in the address - and ended when the picture is taken.

def agent_token(env: dict | None = None, dotenv: Path | None = None) -> str | None:
    """The agents' token: REDLINE_TOKEN, else the
    repo's .env."""
    env = os.environ if env is None else env
    for k in ("REDLINE_TOKEN",):
        if (env.get(k) or "").strip():
            return env[k].strip()
    dotenv = dotenv or Path(__file__).resolve().parent.parent / ".env"
    try:
        lines = dotenv.read_text().splitlines()
    except OSError:
        return None
    for want in ("REDLINE_TOKEN=",):
        for line in lines:
            if line.startswith(want):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                if value:
                    return value
    return None


def _call(method: str, path: str, headers: dict | None = None, opener=urllib.request.urlopen):
    req = urllib.request.Request(API + path, method=method, data=b"" if method == "POST" else None,
                                 headers=headers or {})
    with opener(req, timeout=20) as r:
        return json.load(r)


def page_session(token: str | None, call=_call) -> dict | None:
    """{cookie, value, expires, ...} for the browser, or None when sign-in
    is off and the page needs nothing. Exits with a reason - never the
    token - when it is on and there is no way in."""
    try:
        mode = call("GET", "/api/auth/state").get("mode")
    except Exception as exc:                                  # noqa: BLE001
        sys.exit(f"the API at {API} does not answer ({type(exc).__name__}); is the dev server up?")
    if mode != "on":
        return None
    if not token:
        sys.exit("sign-in is on: set REDLINE_TOKEN to an agent token (Preferences > Agent "
                 "tokens) so the browser can be given a page session")
    try:
        return call("POST", "/api/auth/page-session", {"Authorization": "Bearer " + token})
    except urllib.error.HTTPError as exc:
        sys.exit(f"the API would not give the browser a page session: HTTP {exc.code}")
    except Exception as exc:                                  # noqa: BLE001
        sys.exit(f"the API would not give the browser a page session ({type(exc).__name__})")


def end_page_session(session: dict | None, call=_call) -> None:
    """Sign the page session out once the picture is taken; it would
    expire on its own in minutes anyway."""
    if not session:
        return
    try:
        call("POST", "/api/auth/logout",
             {"Cookie": f"{session['cookie']}={session['value']}", "X-Redline-CSRF": "1"})
    except Exception:                                         # noqa: BLE001
        pass


def browser_cookie(session: dict, web: str = WEB) -> dict:
    """The DevTools cookie: the app's origin only, HttpOnly, and expiring
    with the session."""
    out = {"name": session["cookie"], "value": session["value"], "url": web + "/",
           "path": "/", "httpOnly": True, "secure": web.startswith("https:"),
           "sameSite": "Lax"}
    if session.get("expires"):
        out["expires"] = float(session["expires"])
    return out


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


# ---------------------------------------------------------------- which model
# A shot taken right after a build once came back of the Base assembly
# instead of the part the note was about: the page opened the first model
# in the catalog, then switched to the revision's, and the two-second poll
# reloaded the first one over it. The page no longer does that, and on top
# of that nothing here takes it on trust.

UPDATING = ("queued", "building")


def _models(node: dict):
    yield from node.get("models") or []
    for f in node.get("folders") or []:
        yield from _models(f)


def find_entry(catalog: dict, want: str) -> dict:
    """The catalog entry for a model id, or for a bare name if exactly one
    model has it."""
    models = list(_models(catalog))
    hit = [m for m in models if m["id"] == want]
    if not hit:
        hit = [m for m in models if m.get("name") == want]
    if len(hit) > 1:
        raise SystemExit(f"{want!r} names {len(hit)} models ("
                         + ", ".join(m["id"] for m in hit) + "); give the full id")
    if not hit:
        raise SystemExit(f"no model {want!r} in the catalog")
    return hit[0]


def build_wait(entry: dict, allow_stale: bool = False) -> str | None:
    """Why the model cannot be photographed yet, or None when its build on
    record is its current one. Raises when waiting would not help."""
    link = (entry.get("link") or {}).get("state")
    if entry.get("building"):
        return "building"
    if link in UPDATING:
        why = (entry.get("link") or {}).get("because") or {}
        return f"{link} for a linked rebuild" + (f" ({why.get('title') or why.get('id')} changed)"
                                                 if why else "")
    if not entry.get("data"):
        raise SystemExit(f"{entry['id']} has never been built - nothing to photograph")
    if entry.get("stale") and not allow_stale:
        raise SystemExit(f"{entry['id']}: its source changed since the last build and no build "
                         "is under way, so the picture would show the old geometry. Build it, "
                         "or pass --allow-stale")
    return None


def after_shot() -> bool:
    """Run as a card's "after" shot (tools/revisions.py `after` and `finish`
    set REDLINE_REVISION): it never waits for a build. Finishing a run
    took over five minutes waiting for a chain of linked rebuilds to land;
    the shot of the build on record is taken at once, and says so."""
    return bool(os.environ.get("REDLINE_REVISION"))


def wait_built(fetch, model: str, timeout: float, allow_stale: bool = False,
               sleep=time.sleep, clock=time.monotonic, find=None, check=None,
               wait: bool | None = None) -> dict:
    """Poll the catalog until `model`'s own build is done; its entry.
    `find` and `check` default to a 3D model's; a board passes its own.
    `wait` False (an after shot, by default): the build on record, now."""
    find, check = find or find_entry, check or build_wait
    wait = (not after_shot()) if wait is None else wait
    t0, said = clock(), None
    while True:
        entry = find(fetch(), model)
        why = check(entry, allow_stale)
        if why is None:
            return entry
        if not wait:
            print(f"{entry['id']} is {why}; not waiting - the shot shows its last build")
            return entry
        if clock() - t0 > timeout:
            raise SystemExit(f"{entry['id']} is still {why} after {timeout:.0f} s - not "
                             "photographing an old or half-built model")
        if why != said:
            print(f"{entry['id']} is {why}; waiting for it")
            said = why
        sleep(5)


def view_problem(view: dict | None, model: str, built_at: str | None) -> str | None:
    """What is wrong with what the page says it shows (window.redlineView,
    set by the editor), or None when it is `model` at build `built_at`.
    A page that says it cannot show the model is an error, not a wait."""
    if not isinstance(view, dict):
        return "the page has not said what it shows yet"
    if view.get("error"):
        raise SystemExit(f"the page cannot show {model}: {view['error']}")
    if view.get("pending"):
        return "the page is still looking up the revision"
    if view.get("loading"):
        return f"the page is still loading {view['loading']}"
    if view.get("model") != model:
        return f"the page shows {view.get('model') or 'nothing'}, not {model}"
    if built_at and view.get("built_at") != built_at:
        return f"the page shows the build of {view.get('built_at')}, not {built_at}"
    return None


# ---------------------------------------------------------------- which board
# A board note's after shot came back of a 3D-room model: the page had no
# way to be told which board, and the editor under the PCB room drew
# whatever model it opened first. A board is shown in the PCB room's 3D
# view - the view board notes are drawn on - and checked the same way.

def find_board(rows: list, want: str) -> dict:
    hit = [b for b in rows if b.get("_id") == want]
    if not hit:
        raise SystemExit(f"no board {want!r}")
    return {**hit[0], "id": hit[0]["_id"]}


def board_wait(b: dict, allow_stale: bool = False) -> str | None:
    """As build_wait, for a board: its pipeline or a linked rebuild running
    is a wait; no 3D to show is an error."""
    link = (b.get("link") or {}).get("state")
    if b.get("building"):
        return "building"
    if link in UPDATING:
        return f"{link} for a linked rebuild"
    if not ((b.get("artifacts") or {}).get("model3d") or {}).get("at"):
        raise SystemExit(f"board {b['id']} has no 3D model - nothing to photograph")
    if b.get("stale") and not allow_stale:
        raise SystemExit(f"board {b['id']}: its source changed since the last build and no "
                         "build is under way. Build it, or pass --allow-stale")
    return None


def board_glb(board: str, at: str) -> str:
    """The address the PCB room loads the board's 3D from (pcb.ts modelUrl)."""
    from urllib.parse import quote
    return f"/api/boards/{board}/board.glb?v=" + quote(at, safe="-_.!~*'()")


def board_problem(view: dict | None, shown: str | None, board: str, at: str) -> str | None:
    """What is wrong with what the PCB room says it shows (window.redlineBoard,
    and the 3D view's data-shown), or None when it is `board`'s 3D at `at`."""
    if not isinstance(view, dict):
        return "the PCB room has not said what it shows yet"
    if view.get("error"):
        raise SystemExit(f"the page cannot show board {board}: {view['error']}")
    if view.get("board") != board:
        return f"the PCB room shows {view.get('board') or 'nothing'}, not {board}"
    if view.get("tab") != "3d":
        return f"the PCB room is on its {view.get('tab')} view, not 3D"
    want = board_glb(board, at)
    if shown != want:
        return ("the 3D view is still loading" if not shown
                else f"the 3D view shows {shown}, not {want}")
    return None


# ---------------------------------------------------------------- which view
# The person cut the base assembly open, looked at the encoder wheel through
# the case and drew on it. The after shot from the same camera over the
# uncut model showed the outside of the case. So the whole view goes back,
# and it is checked rather than assumed.

def view_format(view) -> int:
    """1 for a note that kept only which parts were shown, 2 for one that
    kept the whole view."""
    if not isinstance(view, dict):
        return 0
    try:
        return int(view.get("v") or 1)
    except (TypeError, ValueError):
        return 1


def _canon(x) -> str:
    """The page's canonical form (ocp.ts viewHash): keys sorted, numbers to
    four decimals rounded half away from zero like toFixed, strings as JSON."""
    from decimal import ROUND_HALF_UP, Decimal
    if x is None:
        return "null"
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, (int, float)):
        if isinstance(x, float) and (x != x or x in (float("inf"), float("-inf"))):
            return "null"
        t = str(Decimal(x).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))
        return "0.0000" if t == "-0.0000" else t
    if isinstance(x, str):
        return json.dumps(x, ensure_ascii=False)
    if isinstance(x, (list, tuple)):
        return "[" + ",".join(_canon(v) for v in x) + "]"
    if isinstance(x, dict):
        return "{" + ",".join(json.dumps(str(k), ensure_ascii=False) + ":" + _canon(x[k])
                              for k in sorted(x, key=str)) + "}"
    return json.dumps(str(x), ensure_ascii=False)


def view_hash(view) -> str:
    """FNV-1a over the canonical form - the same eight hex digits the page
    publishes as view_hash for the view it applied."""
    h = 0x811C9DC5
    for b in _canon(view).encode("utf-8"):
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def _unit(v) -> list[float]:
    n = sum(float(c) * float(c) for c in v) ** 0.5 or 1.0
    return [float(c) / n for c in v]


def readback_mismatch(view: dict, rb) -> list[str]:
    """Where what the viewer shows (window.redlineViewReadback()) differs
    from the note's view: the tab, the camera type, each clipping plane by
    its world position, the clip switches. Empty when it matches."""
    if view_format(view) < 2:
        return []
    if not isinstance(rb, dict):
        return ["the viewer did not say what it shows"]
    out = []
    tab = view.get("tab") or "tree"
    if rb.get("tab") != tab:
        out.append(f"the viewer is on its {rb.get('tab')} tab, not {tab}")
    cam = view.get("camera") or {}
    if "ortho" in cam and bool(cam["ortho"]) != bool(rb.get("ortho")):
        out.append("the camera is " + ("orthographic" if rb.get("ortho") else "perspective")
                   + ", the note's is not")
    clip = view.get("clip")
    if isinstance(clip, dict):
        half = float(rb.get("half") or 0)
        tol = max(1e-3, half * 1e-4)
        got = rb.get("planes") or []
        for i, p in enumerate((clip.get("planes") or [])[:3]):
            if i >= len(got):
                out.append(f"plane {i + 1} missing")
                continue
            g = got[i]
            n, gn = _unit(p["normal"]), _unit(g["normal"])
            if abs(sum(a * b for a, b in zip(n, gn)) - 1) > 1e-6:
                out.append(f"plane {i + 1} faces {gn}, not {n}")
            elif p.get("enabled") is False:
                if float(g["slider"]) < half - tol:
                    out.append(f"plane {i + 1} should be open and cuts at {g['offset']:.3f}")
            elif abs(float(g["offset"]) - float(p["offset"])) > tol:
                out.append(f"plane {i + 1} cuts at {float(g['offset']):.3f}, "
                           f"not {float(p['offset']):.3f}")
        if bool(clip.get("intersection")) != bool(rb.get("intersection")):
            out.append("intersection mode differs")
        if bool(clip.get("caps")) != bool(rb.get("caps")):
            out.append("cap colours differ")
        if rb.get("tab") == "clip" and bool(clip.get("helpers")) != bool(rb.get("helpers")):
            out.append("plane helpers differ")
    return out


def view_state_problem(page: dict | None, rb, rid: str, view: dict) -> str | None:
    """What is wrong with the note's view on the page, or None when the page
    applied exactly this note's view and the viewer reads back as the note
    says. A page that could not apply it is an error, not a wait."""
    if view_format(view) < 2:
        return None                         # an older note: its camera, as before
    if not isinstance(page, dict):
        return "the page has not said what it shows yet"
    if page.get("view_rev") != rid:
        return f"the page has not applied note {rid}'s view yet"
    if page.get("view_error"):
        raise SystemExit(f"the page could not apply note {rid}'s view: {page['view_error']}")
    if page.get("view_applied") is not True:
        return "the page is still applying the note's view"
    want = view_hash(view)
    if page.get("view_hash") != want:
        raise SystemExit(f"the page applied view {page.get('view_hash')}, not note {rid}'s "
                         f"({want})")
    off = readback_mismatch(view, rb)
    return "the viewer does not show the note's view: " + "; ".join(off) if off else None


def png_size(png: bytes | None) -> tuple[int, int] | None:
    """(width, height) from a PNG's header, or None when it is not one."""
    if not png or len(png) < 24 or not png.startswith(b"\x89PNG\r\n\x1a\n") \
            or png[12:16] != b"IHDR":
        return None
    w, h = struct.unpack(">II", png[16:24])
    return (w, h) if w and h else None


def note_canvas(view) -> tuple[int, int] | None:
    """The canvas size a note kept (format 2), or None."""
    canvas = view.get("canvas") if isinstance(view, dict) else None
    try:
        cw, ch = int(canvas["w"]), int(canvas["h"])
    except (TypeError, KeyError, ValueError):
        return None
    return (cw, ch) if cw >= 50 and ch >= 50 else None


# A note from before its view was kept (format 1, before 03fd1c4) has no
# canvas size, and was shot at a fixed 1200x800. Its drawing was 1028x823:
# the same camera over another aspect frames another picture (a perspective
# camera's field of view is vertical, so the sides move; an orthographic
# one is fitted to the shorter side, so everything does). The drawing
# itself is a capture of the canvas it was made on, so its pixel size is
# that canvas's shape.
def drawn_size(rid: str, headers: dict | None = None,
               opener=urllib.request.urlopen) -> tuple[int, int] | None:
    """The pixel size of a note's stored drawing (its before image), or None."""
    req = urllib.request.Request(f"{API}/api/revisions/{rid}/image", headers=headers or {})
    try:
        with opener(req, timeout=20) as r:
            return png_size(r.read())
    except Exception:                                         # noqa: BLE001
        return None


def shot_size(view, width: int | None, height: int | None,
              free_aspect: bool = False,
              drawn: tuple[int, int] | None = None) -> tuple[int, int, str | None]:
    """The picture's size, and why when it is not what was asked for. The
    framing depends on the canvas's aspect - a perspective camera's field of
    view is vertical, an orthographic one is fitted to it - so a note that
    knows its canvas is shot in its shape: its own size when none is asked
    for, the asked-for width at its aspect otherwise. A note that does not
    know it is shot in the shape of its drawing (`drawn`, the before
    image's pixel size), the same way."""
    size, what = note_canvas(view), "the note's canvas"
    if size is None and drawn and drawn[0] >= 50 and drawn[1] >= 50:
        size, what = (int(drawn[0]), int(drawn[1])), "the drawing's size"
    if size is None or free_aspect:
        return width or 1400, height or 950, None
    cw, ch = size
    aspect = cw / ch
    if width is None and height is None:
        # Too small a canvas makes a useless picture; too big, a slow one.
        k = min(max(1.0, 800 / cw, 500 / ch), 2400 / cw, 1600 / ch)
        w, h = round(cw * k), round(ch * k)
        return w, h, f"{what}, {cw}x{ch}" + (f" scaled to {w}x{h}" if k != 1 else "")
    if width is None:
        w, h = round(height * aspect), height
    else:
        w, h = width, round(width / aspect)
    why = (f"height {height} -> {h} to keep the note's aspect {aspect:.3f}"
           if height is not None and h != height else None)
    return w, h, why


def board_url(board: str, web: str = WEB) -> str:
    from urllib.parse import urlencode
    return f"{web}/?{urlencode({'ws': 'pcb', 'board': board, 'tab': '3d'})}"


# How long one call into the browser may take before the render gives up.
# Each used to wait for its answer for ever: a page stuck setting a camera
# (an explicit front view of station_80, 2026-10-09) left the render hanging
# with no picture and no error, twice.
CALL_TIMEOUT = float(os.environ.get("REDLINE_RENDER_CALL_TIMEOUT", "90"))


def cdp_call(ws, seq: list, method: str, params: dict | None = None,
             timeout: float | None = None, clock=time.monotonic) -> dict:
    """One DevTools call and its answer - or a failure that says which call
    the page did not answer, after `timeout` seconds."""
    limit = CALL_TIMEOUT if timeout is None else timeout
    seq[0] += 1
    ws.send(json.dumps({"id": seq[0], "method": method, "params": params or {}}))
    end = clock() + limit
    while True:
        left = end - clock()
        if left <= 0:
            raise SystemExit(f"the page did not answer {method} in {limit:.0f} s"
                             + (f" ({str(params.get('expression', ''))[:120]!r})"
                                if params and params.get("expression") else "")
                             + " - the browser is stuck; nothing was photographed")
        try:
            msg = json.loads(ws.recv(timeout=left))
        except TimeoutError:
            continue
        if msg.get("id") == seq[0]:
            if "exceptionDetails" in (msg.get("result") or {}):
                d = msg["result"]["exceptionDetails"]
                print(f"page error in {method}: {(d.get('exception') or {}).get('description') or d.get('text')}"[:300])
            return msg.get("result", {})


def page_url(revision: str | None, model: str, web: str = WEB,
             shot: tuple[int, int] | None = None) -> str:
    """The address that opens exactly `model` (and a revision's camera).
    `shot` puts the page in its shot layout: the viewer alone, its canvas
    pinned to that many pixels (editor ocp.ts OcpViewer.shot)."""
    from urllib.parse import urlencode
    q = {"rev": revision} if revision else {}
    q["model"] = model
    if shot:
        q["shot"] = f"{int(shot[0])}x{int(shot[1])}"
    return f"{web}/?{urlencode(q)}"


# ---------------- the canvas's size ----------------
# The picture is cut from the canvas, so the canvas's size is the picture's.
# It used to be whatever the page's layout left over: the window was grown
# by the difference and measured 1.5 s later - before the viewer had
# answered the resize, so the same difference was added again (508x589 one
# run, 2292x1312 the next, both "asked for 1400x950"). The CAD page now
# takes the size in its address (?shot=WxH) and pins the canvas to it; the
# window only has to be big enough to hold it.

# The viewer's tree column, beside the canvas (ocp.ts TREE_W), and what the
# shell, the toolbar and the borders take around it - generous, since the
# window is checked and grown if the canvas does not fit.
TREE_W = 240
SHOT_PAD = (TREE_W + 100, 120)
# The page turns into its phone layout at 768 px (styles.css, PHONES).
MIN_WINDOW_W = 800


def shot_window(width: int, height: int) -> tuple[int, int]:
    """A window that holds a pinned canvas of width x height."""
    return max(width + SHOT_PAD[0], MIN_WINDOW_W), height + SHOT_PAD[1]


def window_plan(rect, width: int, height: int, pinned: bool) -> tuple[int, int] | None:
    """The window to ask for next, or None when the canvas is right.
    `rect` is [left, top, canvas w, canvas h, window w, window h]. A pinned
    canvas has its size already and only needs room: the window grows until
    all of it is on screen (what is off screen is not in the screenshot).
    Otherwise the window takes the difference."""
    left, top, cw, ch, iw, ih = (int(round(float(x))) for x in rect)
    right_size = abs(cw - width) <= 2 and abs(ch - height) <= 2
    fits = left + cw <= iw and top + ch <= ih
    if right_size and fits:
        return None
    if pinned and right_size:
        return max(iw, left + cw + 16, MIN_WINDOW_W), max(ih, top + ch + 16)
    return max(iw + width - cw, 320), max(ih + height - ch, 240)


def only_js(only: str) -> str:
    """Shows the parts whose tree path contains `only`, hides the rest - in
    one setStates. Part by part, setState redraws the tree and the scene and
    notifies the page each time: station_80's 149 parts kept the page busy
    for minutes, and the render's next call (the screenshot, or a camera)
    was never answered."""
    return ("(() => { const v = window.tcv; if (!v) return 'no viewer';"
            " const s = v.getStates(), out = {}; let n = 0;"
            f" const want = {json.dumps(only.lower())};"
            " for (const p of Object.keys(s)) {"
            "   const on = p.toLowerCase().includes(want);"
            "   out[p] = on ? [1, 1] : [0, 0]; if (on) n++; }"
            " v.setStates(out); return n; })()")


# ---------------- where the camera is ----------------
# The viewer's own preset directions (three-cad-viewer Camera, z_up):
# front looks along +Y from -Y, top down from +Z, iso from (1,-1,1).
SIDES = {"front": "front", "back": "rear", "rear": "rear", "left": "left",
         "right": "right", "top": "top", "bottom": "bottom", "iso": "iso"}


def parse_camera(text: str) -> tuple[list[float], list[float] | None]:
    """--camera px,py,pz[,tx,ty,tz]: world millimetres, absolute. Without a
    target the camera looks at the middle of what is shown. A camera on its
    target, or one with a NaN in it, is refused - it leaves the viewer with
    no direction to look in and the picture with nothing in it."""
    import math
    try:
        n = [float(v) for v in text.replace(" ", "").split(",")]
    except ValueError:
        raise SystemExit(f"--camera wants numbers: px,py,pz[,tx,ty,tz], not {text!r}")
    if len(n) not in (3, 6):
        raise SystemExit("--camera wants px,py,pz (looking at the middle of the model) "
                         "or px,py,pz,tx,ty,tz")
    if not all(math.isfinite(v) for v in n):
        raise SystemExit(f"--camera has a number that is not one: {text!r}")
    pos, target = n[:3], (n[3:] if len(n) == 6 else None)
    if target is not None and math.dist(pos, target) < 1e-6:
        raise SystemExit("--camera puts the camera on its own target: no direction to look in")
    return pos, target


# The box around what is visible (after --only), the way the viewer's own
# centreVisibleObjects measures it; the whole model's box when nothing is.
_VISIBLE_BOX = (
    "const box = new v.bbox.constructor(); let n = 0;"
    " const groups = (v.rendered && v.rendered.nestedGroup && v.rendered.nestedGroup.groups) || {};"
    " for (const p in groups) { const o = groups[p];"
    "   if (o && typeof o.getVisibility === 'function' && o.getVisibility()) {"
    "     box.expandByObject(o); n++; } }"
    " if (!n || box.isEmpty()) box.copy(v.bbox);"
    " const c = box.center();"
    " const size = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];")


def side_js(side: str, margin: float = 1.08) -> str:
    """Frames what is visible from one side: the viewer's own preset for the
    direction (and the up vector - top and bottom look along it), then the
    camera moved back until every corner of the visible box is inside the
    picture, `margin` to spare. An orthographic camera is zoomed instead."""
    return ("(() => { const v = window.tcv; if (!v) return 'no viewer';"
            + _VISIBLE_BOX +
            f" v.presetCamera({json.dumps(SIDES[side])}, null, false);"
            " const cam = v.rendered.camera.getCamera(); const q = cam.quaternion;"
            " const right = v.vector3(1, 0, 0).applyQuaternion(q),"
            "   up = v.vector3(0, 1, 0).applyQuaternion(q),"
            "   back = v.vector3(0, 0, 1).applyQuaternion(q);"
            " const ortho = !!v.getOrtho();"
            " const tv = Math.tan((cam.fov || 22) * Math.PI / 360), th = tv * (cam.aspect || 1);"
            " let mx = 1e-6, my = 1e-6, dz = 0, need = 0;"
            " for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y])"
            "  for (const z of [box.min.z, box.max.z]) {"
            "   const p = v.vector3(x - c[0], y - c[1], z - c[2]);"
            "   const px = Math.abs(p.dot(right)), py = Math.abs(p.dot(up)), pz = p.dot(back);"
            "   mx = Math.max(mx, px); my = Math.max(my, py); dz = Math.max(dz, pz);"
            "   need = Math.max(need, pz + px / th, pz + py / tv); }"
            " const r = box.boundingSphere().radius || 1;"
            f" const d = ortho ? Math.max(4 * r, dz + r) : need * {margin};"
            # A hair back along the picture's own up: looking straight down
            # (top, bottom) is along the up vector, where the orbit controls
            # pick the roll from whatever rounding left - top views came out
            # turned by 7 degrees.
            " const e = d * 1e-3;"
            " const pos = [c[0] + back.x * d - up.x * e, c[1] + back.y * d - up.y * e,"
            "   c[2] + back.z * d - up.z * e];"
            " v.setCameraTarget(c, false);"
            " v.setCameraPosition(pos, false, false);"
            " if (ortho) { const o = v.rendered.camera.oCamera;"
            f"   v.setCameraZoom(Math.min(o.top / my, o.right / mx) / {margin}, false); }}"
            " v.update(true, true);"
            " return JSON.stringify({visible: n, centre: c, size, distance: d, ortho,"
            "   position: v.getCameraPosition(), target: v.getCameraTarget()}); })()")


def camera_js(pos: list[float], target: list[float] | None) -> str:
    """Puts the camera at `pos` looking at `target` (world coordinates, as
    three-cad-viewer's setCameraPosition(.., relative=false) takes them), or
    at the middle of what is visible. The zoom is left alone: a perspective
    camera's is its distance, which `pos` says; an orthographic one keeps
    the note's."""
    return ("(() => { const v = window.tcv; if (!v) return 'no viewer';"
            + _VISIBLE_BOX +
            f" const t = {json.dumps(target)} || c; const p0 = {json.dumps(pos)};"
            # Straight down (or up) is along the up vector: no roll follows
            # from it, and the orbit controls pick one from rounding. A hair
            # towards -Y (+Y looking up) puts +Y at the top, as --side top does.
            " const dx = p0[0] - t[0], dy = p0[1] - t[1], dz = p0[2] - t[2];"
            " const len = Math.hypot(dx, dy, dz);"
            " if (Math.hypot(dx, dy) < len * 1e-4) { p0[0] = t[0]; p0[1] = t[1] + (dz > 0 ? -1 : 1) * len * 1e-3; }"
            " v.setCameraTarget(t, false);"
            " v.setCameraPosition(p0, false, false);"
            " v.update(true, true);"
            " const p = v.getCameraPosition();"
            " if (!p.every(Number.isFinite)) return 'the camera came out NaN';"
            " return JSON.stringify({visible: n, centre: c, size, ortho: !!v.getOrtho(),"
            "   position: p, target: v.getCameraTarget()}); })()")


# The canvas the picture is cut from. The 3D room's viewer is always in the
# page - the other rooms are laid over it - so a bare 'canvas' in the PCB
# room is the hidden 3D-room model, not the board.
CAD_CANVAS = ".tcv-stage canvas"
BOARD_CANVAS = "app-board-3d canvas"


def find_canvas(sel: str) -> str:
    return f"document.querySelector({json.dumps(sel)})"


def unclutter_js(sel: str) -> str:
    """Hides what sits over the model and is not part of it, leaving the
    canvas and whatever contains it alone."""
    return ("(() => { const c = " + find_canvas(sel) + "; let n = 0;"
            " const hide = e => { if (c && e.contains(c)) return;"
            "   e.style.visibility = 'hidden'; n++; };"
            " document.querySelectorAll('.tcv-card.absolute, app-links-card').forEach(hide);"
            " for (const e of document.body.querySelectorAll('*'))"
            "   if (getComputedStyle(e).position === 'fixed') hide(e);"
            " return n; })()")


# What the browser spent. The picture is the return value, so the meter's
# reading is left here for main() to log - chrome is killed rather than
# waited for, and nothing else in the process ever sees its time.
LAST_JOB: dict = {}


def render(revision: str, out: Path, width: int | None, height: int | None, wait: int,
           camera: str | None = None, only: str | None = None,
           build_timeout: int = 1200, allow_stale: bool = False,
           free_aspect: bool = False, no_wait: bool = False,
           on_model: str | None = None, side: str | None = None) -> Path:
    from websockets.sync.client import connect

    if camera and side:
        raise SystemExit("--camera and --side both say where to look; give one")
    if side and side not in SIDES:
        raise SystemExit(f"--side is one of {', '.join(SIDES)}")
    cam = parse_camera(camera) if camera else None
    try:
        found = find_browser()
    except NoBrowser as exc:
        sys.exit(str(exc))
    token = agent_token()
    auth = {"Authorization": "Bearer " + token} if token else {}

    def catalog() -> dict:
        try:
            return _call("GET", "/api/catalog", auth)
        except Exception as exc:                              # noqa: BLE001
            raise SystemExit(f"could not read the catalog ({type(exc).__name__})")

    def boards() -> list:
        try:
            return _call("GET", "/api/boards", auth)
        except Exception as exc:                              # noqa: BLE001
            raise SystemExit(f"could not read the boards ({type(exc).__name__})")

    # What to show, before any browser: the revision's own model or board,
    # or the one named (model:<id>, board:<id>).
    rid, is_board = None, revision.startswith("board:")
    note_view: dict | None = None
    if revision.startswith(("model:", "board:")):
        want = revision.split(":", 1)[1]
    else:
        rid = revision
        try:
            rev_doc = _call("GET", f"/api/revisions/{rid}", auth)
        except Exception as exc:                              # noqa: BLE001
            raise SystemExit(f"could not read revision {rid} ({type(exc).__name__})")
        if not rev_doc.get("model"):
            raise SystemExit(f"revision {rid} names no model")
        want, is_board = rev_doc["model"], rev_doc.get("kind") == "pcb"
        note_view = None if is_board else rev_doc.get("view")
        if on_model:
            # The note's view, on another model: a note whose work went into
            # a model of its own (a new project) is judged on that one.
            if is_board:
                raise SystemExit("--model is for a 3D note; a board note shows its board")
            want = on_model
    if view_format(note_view) >= 2:
        clip = note_view.get("clip") or {}
        cuts = sum(1 for p in clip.get("planes") or [] if p.get("enabled"))
        print(f"view    : tab {note_view.get('tab') or 'tree'}, {cuts} clipping plane(s) cutting, "
              f"{'ortho' if (note_view.get('camera') or {}).get('ortho') else 'perspective'}, "
              f"hash {view_hash(note_view)}")
    drawn = None
    if rid and note_canvas(note_view) is None and not free_aspect:
        drawn = drawn_size(rid, auth)
        if drawn:
            print(f"canvas  : not kept by this note; its drawing is {drawn[0]}x{drawn[1]}")
    width, height, why_size = shot_size(note_view, width, height, free_aspect, drawn)
    if why_size:
        print(f"size    : {width}x{height} ({why_size})")
    # Its own build first: a shot taken while it builds, or while a linked
    # rebuild of it is queued, is of the geometry that is about to go.
    if is_board:
        model = find_board(boards(), want)["id"]
        fetch, find, check = boards, find_board, board_wait

        def stamp(e: dict) -> str:
            return e["artifacts"]["model3d"]["at"]
        url, canvas_sel = board_url(model), BOARD_CANVAS
    else:
        model = find_entry(catalog(), want)["id"]
        fetch, find, check = catalog, find_entry, build_wait

        def stamp(e: dict) -> str:
            return e["built_at"]
        url, canvas_sel = page_url(rid, model, shot=(width, height)), CAD_CANVAS

    def current() -> str:
        # --no-wait (an after shot) says so; without it, REDLINE_REVISION does (after_shot).
        return stamp(wait_built(fetch, model, build_timeout, allow_stale, find=find, check=check,
                                wait=False if no_wait else None))

    built_at = current()
    print(f"{'board' if is_board else 'model'}   : {model}  (built {built_at})")
    CANVAS = find_canvas(canvas_sel)

    def problem() -> str | None:
        if is_board:
            return board_problem(
                js("window.redlineBoard || null"),
                js("(() => { const e = document.querySelector('app-board-3d [data-shown]');"
                   " return e ? e.dataset.shown : null; })()"),
                model, built_at)
        page = js("window.redlineView || null")
        why = view_problem(page, model, built_at)
        if why or not rid or view_format(note_view) < 2:
            return why
        # The note's view: applied by the page, and read back live from the
        # viewer - not only once, when it was applied.
        rb = js("window.redlineViewReadback ? window.redlineViewReadback() : null")
        return view_state_problem(page, rb, rid, note_view)

    session = page_session(token)
    profile = tempfile.mkdtemp(prefix="redline-render-")
    name = f"redline-render-{os.getpid()}"
    # The browser opens on a blank page: the cookie goes in first, then
    # the app is opened, so its first request is already signed in.
    # The CAD page pins its canvas to the picture's size (?shot=WxH); the
    # window only has to hold it. The board room has no such layout, and is
    # sized by measuring, as before.
    pinned = not is_board
    win_w, win_h = shot_window(width, height) if pinned else (width, height)
    port = PORT or browser.free_port()
    chrome = subprocess.Popen(
        browser_argv(found, port, win_w, win_h, profile, "about:blank", name),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    from backend import compute
    meter = compute.ProcMeter(chrome.pid)
    try:
        page = None
        for _ in range(60):
            if chrome.poll() is not None:
                break                       # ours is gone: whatever answers is not it
            try:
                tabs = json.load(urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/json", timeout=5))
                page = devtools_page(tabs)
                if page:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        if page is None:
            sys.exit(f"chrome ({found[0]}: {found[1]}) did not start on port {port}")

        ws = connect(page["webSocketDebuggerUrl"], max_size=80_000_000)
        seq = [0]

        def send(method, params=None):
            return cdp_call(ws, seq, method, params)

        def js(expr):
            r = send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
            return r.get("result", {}).get("value")

        send("Runtime.enable")
        if pinned:
            send("Emulation.setDeviceMetricsOverride",
                 {"width": win_w, "height": win_h, "deviceScaleFactor": 1, "mobile": False})
        if session:
            send("Network.enable")
            if not send("Network.setCookie", browser_cookie(session)).get("success", True):
                sys.exit("the browser would not take the page session's cookie")
        send("Page.navigate", {"url": url})
        # Waiting for a canvas is not waiting for the model: the canvas exists
        # within a second, while a 50 MB payload takes the best part of a
        # minute. Every shot taken that way came out empty. Wait for the
        # viewer to hold a scene and for the canvas to have been laid out.
        # (window.tcv.scene throws until the viewer has rendered once.)
        probe = ("(() => { const c = " + CANVAS + ";"
                 " if (!c) return '0x0/0'; let n = 0;"
                 " try { n = (window.tcv && window.tcv.scene)"
                 "   ? window.tcv.scene.children.length : 0; } catch (e) { n = 0; }"
                 " return c.width + 'x' + c.height + '/' + n; })()")
        seen, stable = None, 0
        for _ in range(0 if is_board else wait * 2):
            now = js(probe)
            if now == seen and now and not now.startswith("0x0"):
                stable += 1
                if stable >= 3 and (pinned or int(now.split("x")[0]) > 500) \
                        and not now.endswith("/0"):
                    break
            else:
                seen, stable = now, 0
            time.sleep(1)

        # The scene holding something is not the scene holding the right
        # thing. Wait for the page to say it shows this model from this
        # build; if the model is rebuilt meanwhile, the newer build is the
        # one to wait for (the page reloads it on its own).
        why = None
        for i in range(wait * 2 + 60):
            if i and i % 10 == 0:
                built_at = current()
            why = problem()
            if why is None:
                break
            time.sleep(1)
        else:
            raise SystemExit(f"not photographing: {why}")

        # The window is not the picture: the canvas is. The CAD page pins it
        # to the asked size and the window only has to hold all of it; the
        # board room's canvas is whatever its layout leaves, so the window is
        # given the difference. Either way every change of the window is
        # waited out - the viewer answers a resize when it gets to it, and a
        # measurement taken before that is of the old layout.
        box = ("(() => { const c = " + CANVAS + "; if (!c) return null;"
               " const r = c.getBoundingClientRect();"
               " return JSON.stringify([r.left, r.top, r.width|0, r.height|0,"
               " innerWidth, innerHeight]); })()")

        def measure(before=None, timeout: float = 15.0):
            """The canvas's box once it has stopped changing - and, when
            `before` is given, changed from it (or `timeout` ran out)."""
            end, last = time.monotonic() + timeout, None
            while True:
                got = js(box)
                if got is None:             # the viewer is between two scenes
                    if time.monotonic() > end:
                        raise SystemExit("not photographing: the page has no canvas")
                    time.sleep(0.5)
                    continue
                now = json.loads(got)
                if now == last and (before is None or now != before):
                    return now
                if time.monotonic() > end:
                    return now
                last = now
                time.sleep(0.5)

        rect = measure()
        for _ in range(4):
            plan = window_plan(rect, width, height, pinned)
            if plan is None:
                break
            send("Emulation.setDeviceMetricsOverride",
                 {"width": plan[0], "height": plan[1],
                  "deviceScaleFactor": 1, "mobile": False})
            rect = measure(before=rect)
        cw, ch = int(rect[2]), int(rect[3])
        if window_plan(rect, width, height, pinned) is not None:
            msg = (f"canvas came out {cw}x{ch} at {rect[0]:.0f},{rect[1]:.0f} in a "
                   f"{rect[4]}x{rect[5]} window, asked for {width}x{height}")
            if pinned:
                why = js("(() => { const v = window.tcv; let st = null;"
                         " try { st = [v.state.get('cadWidth'), v.state.get('height')]; } catch (e) {}"
                         " return JSON.stringify({shot: document.documentElement.dataset.shot || null,"
                         " canvases: document.querySelectorAll('.tcv-stage canvas').length,"
                         " viewer: st, url: location.search}); })()")
                msg += f" (page: {why})"
                # Another size is another framing; a picture that is not
                # the one asked for is not handed back as if it were.
                raise SystemExit(msg + " - not photographing")
            print(msg)

        time.sleep(5)                       # let the camera settle on the model

        # --only isolates one part, the way the user does before drawing on
        # it. Without it a detail inside the case is buried under the walls
        # and the check shot cannot show what the drawing showed. Before the
        # camera: --side and a --camera without a target frame what is left.
        if only:
            got = js(only_js(only))
            print(f"--only {only!r}: {got} part(s) left visible")
            if got == 0:
                names = js("JSON.stringify(Object.keys(window.tcv.getStates()).slice(0, 5))")
                raise SystemExit(f"--only {only!r} matches no part; the tree has e.g. {names}")
            time.sleep(2)

        # --side frames what is shown from one side, with the viewer's own
        # preset directions; --camera overrides the stored angle with world
        # coordinates. A revision's camera looks at what the user drew on;
        # checking the result sometimes needs a different side of the part,
        # and clicking one up by hand is slow.
        if side or cam:
            if is_board:
                raise SystemExit("--side and --camera are for the 3D room's viewer")
            got = js(side_js(side) if side else camera_js(*cam))
            try:
                info = json.loads(got)
            except (TypeError, ValueError):
                raise SystemExit(f"could not set the camera: {got}")

            def fmt(v) -> str:
                return ",".join(f"{x:.1f}" for x in v)
            print(f"camera  : {'--side ' + side if side else '--camera'}: from {fmt(info['position'])}"
                  f" at {fmt(info['target'])}; shown: {info['visible']} part(s),"
                  f" {fmt(info['size'])} mm around {fmt(info['centre'])}")
            time.sleep(3)

        # ?rev= also pops the revision card over the top-right corner, which
        # is exactly where the model usually sits. It is not part of the model.
        # Dismissing it would release the held camera too, so only hide it.
        #
        # Nor are the Links card in the corner, or anything laid over the
        # whole window: an agent's question arriving mid-render dimmed the
        # entire frame behind its scrim. Hidden again before every capture,
        # since the page can put a new one up at any moment.
        def unclutter() -> None:
            js(unclutter_js(canvas_sel))
            time.sleep(0.5)

        unclutter()

        # The signals above say the page is ready, not that the geometry is on
        # screen. Check the picture itself: a nearly uniform frame is the
        # background, so wait and take it again.
        def on_screen(when: str) -> None:
            why = problem()
            if why:
                raise SystemExit(f"not photographing ({when}): {why}")

        for attempt in range(3):
            if attempt:
                unclutter()
            on_screen("before the capture")
            box = js("(()=>{const c=" + CANVAS + ";"
                     "const r=c.getBoundingClientRect();"
                     "return JSON.stringify([r.left|0,r.top|0,r.width|0,r.height|0])})()")
            x, y, w, h = json.loads(box)
            shot = send("Page.captureScreenshot",
                        {"format": "png",
                         "clip": {"x": x, "y": y, "width": w, "height": h,
                                  "scale": 1}})
            data = base64.b64decode(shot["data"])
            # The model could have been swapped while the frame was taken.
            on_screen("after the capture")
            if _ink(data) > 0.02 or attempt == 2:
                out.write_bytes(data)
                return out
            print(f"frame looks empty, waiting ({attempt + 1}/2)")
            time.sleep(25)
    finally:
        # Read before the kill: a terminated browser takes its counters with
        # it, and its renderers are never reaped by anyone here.
        LAST_JOB.update(meter.stop())
        browser.stop(found, chrome, name)
        end_page_session(session)
        # The profile goes with it. Every render used to leave its own
        # behind in /tmp - 150 MB each, 8.7 GB of them by the time the
        # system disk filled up on 2026-09-24.
        shutil.rmtree(profile, ignore_errors=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("revision", help="revision id, or model:<name> / board:<id> for a "
                                     "plain shot of one model or board")
    ap.add_argument("-o", "--out")
    ap.add_argument("--width", type=int, default=None,
                    help="width of the picture itself, not of the window (default: the "
                         "note's own canvas, else its drawing's size, else 1400)")
    ap.add_argument("--height", type=int, default=None,
                    help="height of the picture itself (follows the note's aspect "
                         "unless --free-aspect; default 950 without one)")
    ap.add_argument("--free-aspect", action="store_true",
                    help="take --width x --height as given even when the note's canvas "
                         "had another shape (the framing will differ from the drawing)")
    ap.add_argument("--wait", type=int, default=40)
    ap.add_argument("--camera", help="px,py,pz[,tx,ty,tz] - the camera's position and "
                                     "the point it looks at, in the model's own world "
                                     "millimetres (absolute, not relative to the model). "
                                     "Without tx,ty,tz it looks at the middle of what is "
                                     "shown. The perspective camera's field of view is "
                                     "22 deg: at distance D it shows about 0.39 D top to "
                                     "bottom. An orthographic note keeps its zoom. For "
                                     "'the whole thing from one side', use --side")
    ap.add_argument("--side", choices=sorted(SIDES),
                    help="frame everything shown (or the --only parts) from one side: "
                         "front looks from -Y, back from +Y, left from -X, right from +X, "
                         "top down from +Z, bottom up from -Z, iso from (1,-1,1)")
    ap.add_argument("--only", help="show only parts whose tree path contains "
                                   "this text, e.g. kapak")
    ap.add_argument("--build-timeout", type=int, default=1200,
                    help="seconds to wait for the model's own build or linked rebuild")
    ap.add_argument("--allow-stale", action="store_true",
                    help="photograph the last build even though the source has "
                         "changed since and nothing is building it")
    ap.add_argument("--model", dest="on_model",
                    help="with a revision: its view, on this model instead of the one it "
                         "was filed on (work that went into a new model)")
    ap.add_argument("--no-wait", action="store_true",
                    help="never wait for a build: shoot the build on record now "
                         "(an after shot; REDLINE_REVISION set implies it)")
    args = ap.parse_args()
    # The plain shot of a note is its after picture: `finish` stores
    # /tmp/after-<id>.png as the card's. A close-up (--camera) or a shot of
    # some parts (--only) is a look of its own and must never land there -
    # it would stand in for the note's picture.
    rid = args.revision.replace(':', '-')
    if args.out:
        out = Path(args.out)
    elif args.camera or args.only or args.side:
        tag = hashlib.sha1(f"{args.camera}|{args.only}".encode()
                           + (f"|{args.side}".encode() if args.side else b"")).hexdigest()[:8]
        out = Path(f"/tmp/view-{rid}-{tag}.png")
    else:
        out = Path(f"/tmp/after-{rid}.png")
    t0 = time.monotonic()
    try:
        render(args.revision, out, args.width, args.height, args.wait, args.camera,
               args.only, args.build_timeout, args.allow_stale, args.free_aspect, args.no_wait,
               args.on_model, args.side)
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
