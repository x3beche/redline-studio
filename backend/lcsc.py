"""Parts, from LCSC.

A netlist names parts; it does not carry their shape. atopile used to ask
its own service for that and the service is gone, so the shape comes from
where the part is actually bought: EasyEDA publishes the footprint and the
3D model for every LCSC part, and `easyeda2kicad` turns both into KiCad's
own formats.

Fetched once and kept. A part number means the same thing tomorrow as it
did today, so asking twice is just being slow - and a board that is
rebuilt ten times should not hit somebody else's API ten times.

The 3D model matters more than it sounds: without one a board renders as
bare copper with nothing standing on it, which is not what anybody means
by a picture of the board.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from . import store

PARTS = "parts"
TIMEOUT = 90
# Their service, so it is asked politely and named honestly. The
# "compatible" prefix is for their image host, which holds a request
# without a browser-shaped agent open until it times out - ninety seconds
# for a 35 kB photo - while the same request with it takes one.
AGENT = "Mozilla/5.0 (compatible; redline/1.0; board room)"

# Lives with atopile, in its own environment.
TOOL = os.environ.get(
    "X3_EASYEDA", str(Path(__file__).resolve().parent.parent.parent.parent
                      / ".venv-ato" / "bin" / "easyeda2kicad"))

LCSC_ID = re.compile(r"^C\d{3,10}$")


def looks_like_a_part(text: str | None) -> bool:
    """LCSC numbers are C followed by digits, and nothing else is."""
    return bool(text and LCSC_ID.match(text.strip()))


async def _run(args: list[str], cwd: Path) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        raise TimeoutError(f"{args[0]} did not answer in {TIMEOUT}s")
    return proc.returncode, out.decode(errors="replace")


# EasyEDA's own catalogue search, which is LCSC's. The part numbers it
# gives back are the ones `fetch` takes, so a search result is one click
# from a footprint and a 3D model.
SEARCH = "https://easyeda.com/api/eda/product/list"


# ---- asking politely, and writing down every ask ---------------------------
#
# These are EasyEDA's own endpoints, public but not a promised API, and a
# burst of them gets turned away: ten previews in a few seconds and the
# component endpoint answered 403 for minutes; thirty-three searches at
# one a second and the search endpoint did too. So every request waits
# its turn, and a 403 or 429 stops all of them for a while rather than
# retrying into it. Anything already looked at is on disk and asks nothing.
#
# The page's server and an agent's command line are two processes asking
# the same service, so the turn-taking and the refusal live in a file both
# of them lock - kept apart in memory, each would go on asking after the
# other had been told to stop. And every ask is written to a journal the
# page shows, so what the agents are doing to LCSC is something you can
# watch rather than infer.

import contextvars
import fcntl
import sys
import time as _time

GAP = float(os.environ.get("X3_LCSC_GAP", "2.5"))        # seconds between asks
COOL_OFF = 600                                           # after being refused
# Spacing alone does not keep EasyEDA happy. The journal's two refusals:
# 42 searches in 71 s, and 35 asks spread over 220 s - one every 6 s. So
# it is a count, not a rate, and asks are budgeted: this many in any
# window this long, across every process, then nothing is sent until the
# window moves on.
BUDGET = int(os.environ.get("X3_LCSC_BUDGET", "25"))
WINDOW = 300
KEEP_LINES = 1000                                        # journal length

# Who is asking: the page (through the server), an agent (the command line
# or curl), or the passives builder. The server sets it per request.
_DEFAULT_WHO = {"revisions.py": "agent", "passives.py": "passives"}.get(
    Path(sys.argv[0]).name if sys.argv else "", "page")
WHO: contextvars.ContextVar[str] = contextvars.ContextVar("who", default=_DEFAULT_WHO)
# Whether a spent budget means "wait for it" or "say so now". The page
# answers someone looking at it, so it says so. An agent fetching twenty
# parts for a board would rather wait twelve minutes than get eight.
PATIENT: contextvars.ContextVar[bool] = contextvars.ContextVar("patient", default=False)


class Refused(OSError):
    """EasyEDA turned requests away; say when to try again, do not retry."""


def _files() -> tuple[Path, Path, Path]:
    LOOK.mkdir(parents=True, exist_ok=True)
    return LOOK / "_state.json", LOOK / "_state.lock", LOOK / "requests.jsonl"


def _locked(fn):
    """Run fn(state) with the shared state file held; returns fn's result."""
    state_path, lock_path, _ = _files()
    with open(lock_path, "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            state = json.loads(state_path.read_text()) if state_path.exists() else {}
        except (OSError, ValueError):
            state = {}
        out = fn(state)
        state_path.write_text(json.dumps(state))
        return out


def state() -> dict:
    """The turn-taking as it stands: for the page's status line."""
    now = _time.time()
    s = _locked(lambda st: dict(st))
    until = s.get("refused_until") or 0
    recent = [t for t in s.get("asks", []) if t > now - WINDOW]
    return {"gap_s": GAP, "cool_off_s": COOL_OFF, "now": now,
            "refused_until": until if until > now else None,
            "refused_why": s.get("refused_why") if until > now else None,
            "last_ask": s.get("last"),
            "budget": BUDGET, "window_s": WINDOW, "used": len(recent)}


def _record(kind: str, target: str, source: str, *, url: str = "",
            status: int | None = None, ms: float = 0, size: int = 0,
            error: str | None = None) -> None:
    """One line in the journal. Never fails the request it describes."""
    row = {"at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
           "who": WHO.get(), "kind": kind, "target": target, "source": source,
           "url": url, "status": status, "ms": round(ms), "bytes": size,
           "error": error}
    try:
        _, lock_path, journal = _files()
        with open(lock_path, "a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with open(journal, "a") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
            if journal.stat().st_size > KEEP_LINES * 600:
                lines = journal.read_text().splitlines()[-KEEP_LINES:]
                journal.write_text("\n".join(lines) + "\n")
    except OSError:
        pass


def journal(limit: int = 200) -> list[dict]:
    """The most recent asks, newest first."""
    _, _, path = _files()
    try:
        lines = path.read_text().splitlines()[-limit:]
    except OSError:
        return []
    out = []
    for line in reversed(lines):
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


async def _polite(kind: str, target: str, url: str, fn, *args, weight: int = 1):
    """One request: its turn, the request, and a line in the journal."""
    import urllib.error

    def claim(st: dict):
        now = _time.time()
        if now < (st.get("refused_until") or 0):
            return ("refused", st["refused_until"] - now)
        recent = [t for t in st.get("asks", []) if t > now - WINDOW]
        if len(recent) + weight > BUDGET:
            st["asks"] = recent
            return ("budget", recent[0] + WINDOW - now)
        wait = max(0.0, (st.get("last") or 0) + GAP - now)
        # A heavy ask (a download that is several requests inside) takes
        # its weight in slots from the budget and pushes the next ask back.
        st["last"] = now + wait + GAP * (weight - 1)
        st["asks"] = recent + [now + wait] * weight
        return ("go", wait)

    verdict, wait = await asyncio.get_running_loop().run_in_executor(None, _locked, claim)
    waited = 0.0
    while verdict == "budget" and PATIENT.get():
        if not waited:
            _record(kind, target, "wait", url=url,
                    error=f"budget spent - waiting {int(wait) + 1} s for it")
        await asyncio.sleep(min(wait + 0.5, 30))
        waited += min(wait + 0.5, 30)
        verdict, wait = await asyncio.get_running_loop().run_in_executor(None, _locked, claim)
    if verdict == "refused":
        _record(kind, target, "refused", url=url,
                error=f"cooling off, {int(wait // 60) + 1} min left")
        raise Refused(f"EasyEDA is turning requests away; parts already looked "
                      f"at still work, new ones in {int(wait // 60) + 1} min")
    if verdict == "budget":
        _record(kind, target, "refused", url=url,
                error=f"budget: {BUDGET} asks per {WINDOW // 60} min spent, "
                      f"next in {int(wait) + 1} s")
        raise Refused(f"{BUDGET} asks in {WINDOW // 60} minutes is all EasyEDA is "
                      f"asked for; the next one can go in {int(wait) + 1} s")
    if wait:
        await asyncio.sleep(wait)

    t0 = _time.monotonic()
    try:
        out = await asyncio.get_running_loop().run_in_executor(None, fn, *args)
    except urllib.error.HTTPError as exc:
        ms = (_time.monotonic() - t0) * 1000
        if exc.code in (403, 429):
            why = f"EasyEDA said {exc.code} to {kind} {target}"

            def refuse(st: dict):
                st["refused_until"] = _time.time() + COOL_OFF
                st["refused_why"] = why
            await asyncio.get_running_loop().run_in_executor(None, _locked, refuse)
            _record(kind, target, "net", url=url, status=exc.code, ms=ms,
                    error=f"refused - nobody asks again for {COOL_OFF // 60} min")
            raise Refused(f"{why}; not asking again for {COOL_OFF // 60} minutes") from exc
        _record(kind, target, "net", url=url, status=exc.code, ms=ms, error=str(exc))
        raise
    except Exception as exc:
        _record(kind, target, "net", url=url, ms=(_time.monotonic() - t0) * 1000,
                error=f"{type(exc).__name__}: {exc}"[:200])
        raise
    ms = (_time.monotonic() - t0) * 1000
    if isinstance(out, tuple):
        # A download reports (return code, log): a failed one is written
        # down as failed, not as a 200 it never got.
        rc, log = out
        _record(kind, target, "net", url=url, status=200 if rc == 0 else None,
                ms=ms, error=None if rc == 0 else log.strip()[-200:])
        return out
    size = len(out) if isinstance(out, (bytes, bytearray)) else \
        len(json.dumps(out)) if out is not None else 0
    _record(kind, target, "net", url=url, status=200, ms=ms, size=size)
    return out


def _ask(url: str) -> dict:
    """One GET, blocking. Its own function so a test can stand in for it
    rather than calling somebody else's service."""
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode(errors="replace"))


async def search(term: str, limit: int = 20) -> list[dict]:
    """Look for a part by name, package, manufacturer - or by number.

    Returns what a person needs to choose between two capacitors: the
    number to order, what it is, how it is packaged, and whether anybody
    has it in stock. Not the footprint - that is a download, and it
    happens when one is picked.
    """
    import urllib.parse

    term = (term or "").strip()
    if not term:
        return []

    url = (f"{SEARCH}?keyword={urllib.parse.quote(term)}"
           f"&page=1&pageSize={max(1, min(limit, 50))}")
    body = await _polite("search", term, url, _ask, url)
    rows = ((body or {}).get("result") or {}).get("productList") or []

    out = []
    for row in rows:
        price = None
        for band in row.get("price") or []:
            # [quantity, price, price with tax] - the first band is one-off.
            if len(band) >= 2:
                try:
                    price = float(band[1])
                except (TypeError, ValueError):
                    price = None
                break
        out.append({
            "lcsc": row.get("number"),
            "mpn": row.get("mpn"),
            "package": row.get("package"),
            "maker": row.get("manufacturer"),
            "stock": row.get("stock"),
            "price": price,
        })
    return [r for r in out if looks_like_a_part(r["lcsc"])]


# ---- a look before buying ------------------------------------------------
#
# Everything a person needs to decide on a part - what it is, its
# footprint, its symbol, its 3D shape, a photo - is public on EasyEDA and
# none of it has to be kept to be looked at. So it is fetched on click,
# through here rather than from the browser, and kept on disk: a part
# number means the same thing tomorrow, and this is a preview, not a part
# of anything, so it has no business in the database.

COMPONENT = "https://easyeda.com/api/products/{}/components?version=6.4.19.5"
SVGS = "https://easyeda.com/api/products/{}/svgs"
OBJ = "https://modules.easyeda.com/3dmodel/{}"

LOOK = Path(os.environ.get(
    "X3_LCSC_CACHE",
    Path(__file__).resolve().parent.parent / ".cache" / "lcsc"))

# EasyEDA's own numbering for the two drawings it keeps per part.
SYMBOL, FOOTPRINT = 2, 4


def _get_bytes(url: str) -> bytes:
    import urllib.request

    if url.startswith("//"):
        url = "https:" + url
    req = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


_KINDS = {"component.json": "component", "svgs.json": "drawings",
          "model.obj": "3d model", "photo.jpg": "photo"}


async def _kept(lcsc: str, name: str, url: str) -> bytes:
    """One file about a part: from disk if it has been looked at before."""
    if not looks_like_a_part(lcsc):
        raise ValueError(f"{lcsc!r} is not an LCSC part number")
    path = LOOK / lcsc.strip() / name
    kind = _KINDS.get(name, name)
    try:
        if path.exists():
            blob = path.read_bytes()
            _record(kind, lcsc.strip(), "disk", size=len(blob))
            return blob
    except OSError:
        pass
    blob = await _polite(kind, lcsc.strip(), url, _get_bytes, url)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(blob)
        tmp.replace(path)
    except OSError:
        pass
    return blob


async def _component(lcsc: str) -> dict:
    raw = await _kept(lcsc, "component.json", COMPONENT.format(lcsc))
    body = json.loads(raw.decode(errors="replace"))
    if not body.get("success") or not body.get("result"):
        raise LookupError(f"{lcsc}: EasyEDA does not know this part")
    return body["result"]


def _model_of(component: dict) -> tuple[str | None, str | None]:
    """The 3D model's id and name, from inside the footprint.

    EasyEDA keeps it as one node among the footprint's shapes - a JSON
    blob after `SVGNODE~`, tagged `outline3D`.
    """
    shapes = ((component.get("packageDetail") or {}).get("dataStr") or {}) \
        .get("shape") or []
    for shape in shapes:
        if not shape.startswith("SVGNODE~"):
            continue
        try:
            attrs = json.loads(shape[len("SVGNODE~"):]).get("attrs") or {}
        except ValueError:
            continue
        if attrs.get("c_etype") == "outline3D" and attrs.get("uuid"):
            return attrs["uuid"], attrs.get("title")
    return None, None


async def preview(lcsc: str) -> dict:
    """What a part is, for somebody choosing one.

    The drawings, the model and the photo are separate requests so the
    page can show the facts at once and let the 3.8 MB model arrive when
    it arrives.
    """
    c = await _component(lcsc)
    para = ((c.get("dataStr") or {}).get("head") or {}).get("c_para") or {}
    shop = c.get("lcsc") or {}
    photo = (c.get("szlcsc") or {}).get("image")
    model_id, model_name = _model_of(c)
    return {
        "lcsc": lcsc,
        "name": c.get("title") or para.get("name"),
        "description": c.get("description") or "",
        "maker": para.get("Manufacturer"),
        "mpn": para.get("Manufacturer Part"),
        "package": para.get("package")
                   or (c.get("packageDetail") or {}).get("title"),
        # JLCPCB assembles "Basic" parts without a loading fee; an
        # "Extended" one costs a feeder per board run. It decides between
        # two otherwise equal parts more often than price does.
        "jlc_class": para.get("JLCPCB Part Class"),
        "price": shop.get("price"),
        "stock": shop.get("stock"),
        "min": shop.get("min"),
        "url": shop.get("url"),
        "has_photo": bool(photo),
        "has_model": bool(model_id),
        "model_name": model_name,
    }


async def drawing(lcsc: str, which: int) -> bytes:
    """The symbol or the footprint, as the SVG EasyEDA draws it."""
    raw = await _kept(lcsc, "svgs.json", SVGS.format(lcsc))
    body = json.loads(raw.decode(errors="replace"))
    for row in body.get("result") or []:
        if row.get("docType") == which and row.get("svg"):
            return row["svg"].encode()
    raise LookupError(f"{lcsc}: no drawing of that kind")


async def model_obj(lcsc: str) -> bytes:
    """The 3D shape, as the OBJ EasyEDA keeps it - materials inline."""
    model_id, _ = _model_of(await _component(lcsc))
    if not model_id:
        raise LookupError(f"{lcsc}: no 3D model")
    return await _kept(lcsc, "model.obj", OBJ.format(model_id))


# ---- a part, as a board's source needs it --------------------------------
#
# A board is written in atopile, and every pin is a line: `signal PA9 ~
# pin 17`. Written from memory that is a guess per pin, and the guesses
# are wrong in the way that costs a board spin. The pin list is already
# in the part's EasyEDA symbol - numbers and names both - so it is read
# from there, and the component block is written from it.


def _symbol_pins(shapes: list[str]) -> list[dict]:
    """Pins out of an EasyEDA symbol.

    A pin is one `P~...` string of `^^`-separated segments: the first holds
    the electrical type, the fourth its name as drawn, the fifth its
    number as drawn - the pad it lands on.
    """
    out = []
    for shape in shapes:
        if not shape.startswith("P~"):
            continue
        parts = shape.split("^^")
        head = parts[0].split("~")
        try:
            name = parts[3].split("~")[4]
            number = parts[4].split("~")[4]
        except IndexError:
            continue
        out.append({"number": number.strip(), "name": name.strip(),
                    "electric": head[2] if len(head) > 2 else ""})
    return out


async def pins(lcsc: str) -> list[dict]:
    """Every pin of a part, by the number it has on the footprint.

    Parts drawn as several symbols (a dual op-amp, a relay) carry the
    others as subparts; they are all read, and a pin that appears twice
    is listed once.
    """
    c = await _component(lcsc)
    shapes = list((c.get("dataStr") or {}).get("shape") or [])
    for sub in c.get("subparts") or []:
        shapes += (sub.get("dataStr") or {}).get("shape") or []
    seen, out = set(), []
    for pin in _symbol_pins(shapes):
        if pin["number"] in seen:
            continue
        seen.add(pin["number"])
        out.append(pin)

    def order(p: dict):
        n = p["number"]
        return (0, int(n), "") if n.isdigit() else (1, 0, n)
    return sorted(out, key=order)


def _ident(text: str, fallback: str) -> str:
    """A pin or part name as an atopile identifier: PB8-BOOT0 -> PB8_BOOT0.

    The signs carry meaning and are spelled out before anything is
    stripped: UD+ and UD- are the two halves of a USB pair, and reduced to
    "UD" they became one signal - D+ shorted to D-.
    """
    text = (text or "").strip()
    text = re.sub(r"\+$", "P", text)            # UD+   -> UDP
    text = re.sub(r"-$", "N", text)              # UD-   -> UDN
    text = text.replace("+", "P")               # VBAT+ -> VBATP
    text = re.sub(r"^[~/!]", "n", text)          # ~RST  -> nRST
    text = re.sub(r"#$", "_N", text)             # RST#  -> RST_N
    out = re.sub(r"[^A-Za-z0-9_]", "_", text).strip("_")
    out = re.sub(r"_+", "_", out)
    if not out:
        out = fallback
    return out if not out[0].isdigit() else f"p{out}"


async def ato_component(lcsc: str) -> str:
    """The part as an atopile component block, ready to paste.

    Pins that share a name - three GNDs, two VDDs - become one signal on
    several pins, which is what they are.
    """
    c = await _component(lcsc)
    para = ((c.get("dataStr") or {}).get("head") or {}).get("c_para") or {}
    package = (c.get("packageDetail") or {}).get("title") or para.get("package") or ""
    name = _ident(para.get("Manufacturer Part") or c.get("title") or lcsc, lcsc)

    lines = [f"component {name}:",
             f"    # {lcsc} · {para.get('Manufacturer') or '?'} · "
             f"{para.get('JLCPCB Part Class') or 'class unknown'}",
             f'    footprint = "{package}"',
             f'    mpn = "{lcsc}"']
    # Only pins with the same name share a signal - three GNDs are one
    # net. Two different names that come out as the same identifier are
    # two signals, and each gets its pin number to tell them apart.
    by_raw: dict[str, str] = {}
    taken: dict[str, str] = {}
    for pin in await pins(lcsc):
        raw = pin["name"].strip()
        sig = _ident(raw, f"p{pin['number']}")
        # A pin named NC is not connected to anything - and several of
        # them are not connected to each other either.
        if sig.upper() in ("NC", "N_C", "DNC"):
            lines.append(f"    signal NC_{pin['number']} ~ pin {pin['number']}")
            continue
        if raw in by_raw:
            lines.append(f"    {by_raw[raw]} ~ pin {pin['number']}")
            continue
        if sig in taken and taken[sig] != raw:
            sig = f"{sig}_{_ident(pin['number'], 'x')}"
        by_raw[raw] = sig
        taken[sig] = raw
        lines.append(f"    signal {sig} ~ pin {pin['number']}")
    return "\n".join(lines) + "\n"


PASSIVES = Path(__file__).resolve().parent / "passives.json"


def passive(kind: str, value: str, size: str) -> dict | None:
    """A resistor or capacitor by value and size, from the checked table.

    No request at all: tools/passives.py confirmed every row against LCSC
    by exact part number. `10k`, `10K`, `10kΩ` are the same resistor;
    `100n`, `100nF` the same capacitor.
    """
    try:
        table = json.loads(PASSIVES.read_text()).get("parts", {})
    except (OSError, ValueError):
        return None
    k = kind.strip().upper()[:1]
    v = value.strip().replace("Ω", "").replace("ohm", "")
    v = re.sub(r"[Ff]$", "", v)                    # 100nF -> 100n
    v = re.sub(r"(?<=\d)K$", "k", v)               # 10K -> 10k
    s = size.strip()
    for key, row in table.items():
        tk, tv, ts = key.split(" ")
        if tk == k and tv.lower() == v.lower() and ts == s:
            return {"key": key, **row}
    return None


def passive_values() -> list[str]:
    try:
        return sorted(json.loads(PASSIVES.read_text()).get("parts", {}))
    except (OSError, ValueError):
        return []


ASK_PER_PICK = 2


async def pick(term: str, limit: int = 6) -> list[dict]:
    """Search, then put first what can actually be bought and assembled.

    LCSC lists by its own relevance, which put an out-of-stock TP4056
    first. Here: in stock before out of it, JLCPCB Basic before Extended
    (no feeder fee), then the most stock.
    """
    rows = await search(term, max(limit * 2, 10))
    # The class needs a lookup per part. Only the few with the most stock
    # are asked about - the rest could not be bought in quantity anyway -
    # and a refusal ends the asking rather than failing the search.
    rows.sort(key=lambda r: -(r.get("stock") or 0))
    out, asked = [], 0
    for row in rows:
        row["jlc_class"], row["has_model"] = None, None
        if asked < ASK_PER_PICK:
            try:
                look = await preview(row["lcsc"])
                row["jlc_class"] = look.get("jlc_class")
                row["has_model"] = look.get("has_model")
            except Refused:
                asked = ASK_PER_PICK
            except (LookupError, OSError, ValueError, TimeoutError):
                pass
            asked += 1
        out.append(row)

    def rank(r: dict):
        basic = (r.get("jlc_class") or "").lower().startswith("basic")
        return (not (r.get("stock") or 0) > 0, not basic, -(r.get("stock") or 0))
    return sorted(out, key=rank)[:limit]


async def model_glb(lcsc: str) -> bytes:
    """The 3D shape as a GLB the page can open without parsing text.

    Converted once and kept beside the OBJ it came from. In the browser the
    OBJ froze the whole application for seconds; here it takes 0.15.
    """
    from . import objglb

    path = LOOK / lcsc.strip() / "model.glb"
    try:
        if path.exists():
            return path.read_bytes()
    except OSError:
        pass
    obj = await model_obj(lcsc)
    glb = await asyncio.get_running_loop().run_in_executor(
        None, objglb.convert, obj.decode(errors="replace"))
    try:
        tmp = path.with_suffix(".glb.part")
        tmp.write_bytes(glb)
        tmp.replace(path)
    except OSError:
        pass
    return glb


async def photo(lcsc: str) -> bytes:
    """The product photo, where there is one to be had.

    Older parts point at EasyEDA's image host, which answers. Newer ones
    point at LCSC's own, which turns away anything that is not a browser;
    that is their call, so those parts simply have no photo here.
    """
    import urllib.error

    url = ((await _component(lcsc)).get("szlcsc") or {}).get("image")
    if not url:
        raise LookupError(f"{lcsc}: no photo")
    try:
        return await _kept(lcsc, "photo.jpg", url)
    except urllib.error.HTTPError as exc:
        raise LookupError(f"{lcsc}: the photo host said {exc.code}") from exc


async def fetch(db, lcsc: str, force: bool = False) -> dict:
    """The footprint and 3D model for one part, from cache or from LCSC."""
    lcsc = (lcsc or "").strip()
    if not looks_like_a_part(lcsc):
        raise ValueError(f"{lcsc!r} is not an LCSC part number")

    if not force:
        got = await db[PARTS].find_one({"_id": lcsc})
        if got and got.get("footprint"):
            return got

    if not Path(TOOL).exists():
        raise RuntimeError(f"easyeda2kicad is not at {TOOL}")

    tmp = Path(tempfile.mkdtemp(prefix="x3lcsc-"))
    try:
        # easyeda2kicad asks EasyEDA itself - the component, then the 3D
        # model twice over - so it takes its turn like any other ask, is
        # written down, and counts as three against the budget. Unthrottled,
        # laying out a twenty-part board was sixty requests nobody saw.
        def download(argv, cwd):
            import subprocess
            done = subprocess.run(argv, cwd=str(cwd), capture_output=True,
                                  text=True, timeout=TIMEOUT)
            if done.returncode != 0 and "403" in (done.stdout + done.stderr):
                import urllib.error
                raise urllib.error.HTTPError("easyeda2kicad", 403, "refused",
                                             {}, None)
            return done.returncode, (done.stdout + done.stderr)

        rc, log = await _polite(
            "download", lcsc, f"easyeda2kicad --lcsc_id {lcsc} --footprint --3d",
            download, [TOOL, "--lcsc_id", lcsc, "--footprint", "--3d",
                       "--output", str(tmp / "lib")], tmp, weight=3)
        pretty = list((tmp / "lib.pretty").glob("*.kicad_mod")) \
            if (tmp / "lib.pretty").exists() else []
        if rc != 0 or not pretty:
            raise RuntimeError(f"{lcsc}: nothing came back\n{log[-400:]}")

        fp = pretty[0]
        doc = {
            "_id": lcsc,
            "name": fp.stem,
            "footprint": fp.read_text(),
            "at": datetime.now(timezone.utc).isoformat(),
        }
        await db[PARTS].replace_one({"_id": lcsc}, doc, upsert=True)

        # The model goes where every other generated thing goes: gzipped
        # into GridFS, with a copy on disk. An LQFP-48 is a 9.8 MB STEP,
        # and writing that into the document took ninety-nine seconds -
        # a document is for the things you search by, not for megabytes.
        #
        # STEP is what the board exporter can use; the WRL is what KiCad
        # shows in its own viewer. One of them, not both.
        shapes = tmp / "lib.3dshapes"
        if shapes.exists():
            for suffix in (".step", ".wrl"):
                hit = next(iter(shapes.glob(f"*{suffix}")), None)
                if not hit:
                    continue
                await store.put_artifact(db, lcsc, "model", hit.read_bytes(),
                                         collection=PARTS)
                await db[PARTS].update_one(
                    {"_id": lcsc},
                    {"$set": {"model_name": hit.stem,
                              "model_kind": suffix.lstrip(".")}})
                doc["model_name"] = hit.stem
                doc["model_kind"] = suffix.lstrip(".")
                break
        return await db[PARTS].find_one({"_id": lcsc}) or doc

    finally:
        shutil.rmtree(tmp, ignore_errors=True)


async def model_of(db, lcsc: str) -> tuple[bytes, str] | None:
    """The part's 3D model, and which format it is in.

    Parts fetched before the models moved out of the document still carry
    them inline; those are read from where they are rather than being
    migrated, because the next fetch of that part writes it the new way.
    """
    doc = await db[PARTS].find_one({"_id": lcsc})
    if not doc:
        return None
    if (doc.get("artifacts") or {}).get("model"):
        blob = await store.get_artifact(db, lcsc, "model", PARTS)
        return blob, doc.get("model_kind") or "step"
    for field, kind in (("model_step", "step"), ("model_wrl", "wrl")):
        if doc.get(field):
            return bytes(doc[field]), kind
    return None


async def fetch_many(db, ids: list[str]) -> tuple[dict, list[str]]:
    """Every part a board needs, and the ones that could not be had.

    One at a time on purpose: this is somebody else's service, and a board
    with thirty parts should not open thirty connections to it.
    """
    out, failed = {}, []
    for lcsc in dict.fromkeys(i for i in ids if looks_like_a_part(i)):
        try:
            out[lcsc] = await fetch(db, lcsc)
        except (ValueError, RuntimeError, TimeoutError, OSError) as exc:
            failed.append(f"{lcsc}: {exc}")
    return out, failed


async def known(db) -> list[dict]:
    """What is in the drawer already.

    Asked as an aggregation because the answer must not carry a STEP file
    per part across the wire. Leaving those fields out of a find() left
    `has_3d` reading false for every part that had one - what is not
    fetched cannot be truthy.
    """
    rows = [row async for row in db[PARTS].aggregate([
        {"$project": {
            "name": 1, "at": 1,
            "has_3d": {"$or": [{"$ifNull": ["$artifacts.model", False]},
                               {"$ifNull": ["$model_step", False]},
                               {"$ifNull": ["$model_wrl", False]}]},
        }},
        {"$sort": {"_id": 1}},
    ])]
    return [{"lcsc": r["_id"], "name": r.get("name"),
             "has_3d": bool(r.get("has_3d")), "at": r.get("at")}
            for r in rows]
