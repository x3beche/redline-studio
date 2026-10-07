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
PORT = 9411
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


def page_url(revision: str | None, model: str, web: str = WEB) -> str:
    """The address that opens exactly `model` (and a revision's camera)."""
    from urllib.parse import urlencode
    q = {"rev": revision} if revision else {}
    q["model"] = model
    return f"{web}/?{urlencode(q)}"


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
           free_aspect: bool = False) -> Path:
    from websockets.sync.client import connect

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
        url, canvas_sel = page_url(rid, model), CAD_CANVAS

    def current() -> str:
        return stamp(wait_built(fetch, model, build_timeout, allow_stale, find=find, check=check))

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
    chrome = subprocess.Popen(
        browser_argv(found, PORT, width, height, profile, "about:blank", name),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    from backend import compute
    meter = compute.ProcMeter(chrome.pid)
    try:
        page = None
        for _ in range(60):
            try:
                tabs = json.load(urllib.request.urlopen(
                    f"http://127.0.0.1:{PORT}/json"))
                page = next(t for t in tabs if t["type"] == "page")
                break
            except Exception:
                time.sleep(0.5)
        if page is None:
            sys.exit(f"chrome ({found[0]}: {found[1]}) did not start")

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
        if session:
            send("Network.enable")
            if not send("Network.setCookie", browser_cookie(session)).get("success", True):
                sys.exit("the browser would not take the page session's cookie")
        send("Page.navigate", {"url": url})
        # Waiting for a canvas is not waiting for the model: the canvas exists
        # within a second, while a 50 MB payload takes the best part of a
        # minute. Every shot taken that way came out empty. Wait for the
        # viewer to hold a scene and for the canvas to have been laid out.
        probe = ("(() => { const c = " + CANVAS + ";"
                 " if (!c) return '0x0/0';"
                 " const n = (window.tcv && window.tcv.scene)"
                 "   ? window.tcv.scene.children.length : 0;"
                 " return c.width + 'x' + c.height + '/' + n; })()")
        seen, stable = None, 0
        for _ in range(0 if is_board else wait * 2):
            now = js(probe)
            if now == seen and now and not now.startswith("0x0"):
                stable += 1
                if stable >= 3 and int(now.split("x")[0]) > 500 \
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

        # The window is not the picture. The catalog, the queue, the tree
        # column, the toolbar and the log all take their cut before the
        # canvas gets any, and it is not a fixed cut - it moves with the
        # layout. Asking for 1200x800 used to hand back a 320x394 canvas.
        # So measure what came out, give the window back the difference,
        # and check. --width and --height mean the picture now.
        box = ("(() => { const c = " + CANVAS + ";"
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
    ap.add_argument("--camera", help="px,py,pz,tx,ty,tz - look from somewhere "
                                     "other than the stored angle")
    ap.add_argument("--only", help="show only parts whose tree path contains "
                                   "this text, e.g. kapak")
    ap.add_argument("--build-timeout", type=int, default=1200,
                    help="seconds to wait for the model's own build or linked rebuild")
    ap.add_argument("--allow-stale", action="store_true",
                    help="photograph the last build even though the source has "
                         "changed since and nothing is building it")
    args = ap.parse_args()
    out = Path(args.out or f"/tmp/after-{args.revision.replace(':', '-')}.png")
    t0 = time.monotonic()
    try:
        render(args.revision, out, args.width, args.height, args.wait, args.camera,
               args.only, args.build_timeout, args.allow_stale, args.free_aspect)
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
