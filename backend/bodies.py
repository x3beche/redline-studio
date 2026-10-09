"""A part's 3D bodies: LCSC's, and the ones drawn here.

Every part in the drawer has the 3D model LCSC/EasyEDA gives it, seated
on its pads (backend/modelseat.py). That is one body, and sometimes not
the one fitted: a TO-220 bolted down lying flat, a header with short
legs. So a part can also have bodies **drawn here** - build123d models
of the 3D room, bound to the part under a name ("lying flat") - and one of
its bodies is its **default** (LCSC's until somebody says otherwise).

    part_bodies (per workspace, by LCSC number)
        {_id: "C111607", default: "lying-flat" | None,       # None: LCSC's
         bodies: [{slug: "lying-flat", name: "lying flat",
                   model: "components/C111607-lying-flat",
                   by, at, step_sha, model_version}]}

    boards.bodies (the board's own choice, per reference)
        {"Q5": {variant: "lying-flat" | "lcsc", part: "C111607", by, at}}

A board's part wears its part's default unless the board chooses another
of that part's bodies for its reference. The choice is the board's -
workspace-scoped like its rules, audited, and nobody else's business.

A drawn body is drawn in the **component frame** (modelseat.py says what
it is, and nowhere else does) and used as-is: its footprint's model block
is offset 0, rotate 0, scale 1. Its STEP is the model's build artifact,
whatever version was built last. A board's pose override for the same
reference (backend/poses.py) is NOT applied to a drawn body: those numbers
were measured to fix another body.

Where it reaches the pipeline (backend/kicad.py): a layout writes the
part's footprint for that reference with the drawn body's block and the
STEP beside it, so the .kicad_pcb, the GLB of the PCB room, the board's
STEP / STL / named data (backend/board3d.py), the board as a component in
3D assemblies and every render have it. A refresh of the board's 3D (no
re-routing) puts each reference's body in again.

How a change travels: a bound model built again with a different STEP
(build_outcome), a default changed, a board's choice changed - each marks
the boards that wear it `body_refresh: queued`. The API's `loop` takes
them a few seconds later and redraws the board's 3D without routing it
again (kicad.refresh_component); a new 3D is a new board version, and
from there the link machinery (backend/links.py) rebuilds whatever
imports the board, as after any layout.
"""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import json
import logging
import re
from datetime import datetime, timedelta, timezone

from . import scope, store

LOG = logging.getLogger("redline.bodies")

COLL = "part_bodies"
BOARDS = "boards"
LCSC = "lcsc"                       # the variant that is LCSC's own model
NAME_MAX = 40
WHY_MAX = 1500
DEBOUNCE = 3.0                      # seconds before a queued board is redrawn
TICK = 3.0
REF = re.compile(r"^[A-Za-z0-9_+\-]{1,40}$")
PART = re.compile(r"^C\d{3,12}$")
# How a drawn body's files are named in a layout's work directory.
FOLDER = "components"               # where a requested body's model is asked to live
STEP_DIR = "/work/3d"
FP_DIR = "/work/fp"


class BodyError(ValueError):
    """A refusal, with the HTTP status that says what kind."""

    def __init__(self, text: str, status: int = 400):
        super().__init__(text)
        self.status = status


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def slug(name: str) -> str:
    """'Lying flat' -> 'lying-flat': how a variant is named on a board and
    in a command."""
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower()).strip("-")
    return s[:NAME_MAX]


def check_name(name: str) -> tuple[str, str]:
    name = re.sub(r"\s+", " ", (name or "").strip())
    if not name:
        raise BodyError("name the body (--name \"lying flat\")")
    if len(name) > NAME_MAX:
        raise BodyError(f"a body's name is at most {NAME_MAX} characters")
    s = slug(name)
    if not s:
        raise BodyError(f"{name!r}: a name needs letters or digits")
    if s in (LCSC, "default"):
        raise BodyError(f"{name!r} is reserved - {LCSC!r} is LCSC's own model, 'default' the part's")
    return name, s


def find(doc: dict | None, variant: str | None) -> dict | None:
    """A drawn body of the part by its slug or its name, any case."""
    v = (variant or "").strip()
    if not v or not doc:
        return None
    for b in doc.get("bodies") or []:
        if v == b["slug"] or v.lower() == b["name"].lower() or slug(v) == b["slug"]:
            return b
    return None


def file_names(part: str, body: dict) -> tuple[str, str]:
    """Where a layout puts a drawn body: its STEP, and the part's footprint
    wearing it (the file keeps the part's own name, so the footprint does)."""
    return (f"{STEP_DIR}/body-{part}-{body['slug']}.step",
            f"{FP_DIR}/body-{body['slug']}/{part}.kicad_mod")


# ---------------------------------------------------------------- the drawer side

async def get(db, part: str) -> dict:
    return await db[COLL].find_one({"_id": part}) or {"_id": part, "default": None, "bodies": []}


async def _put(db, doc: dict) -> None:
    doc = {k: v for k, v in doc.items() if k != "workspace_id"}
    await db[COLL].replace_one({"_id": doc["_id"]}, doc, upsert=True)


async def _model_step(db, model_id: str) -> tuple[dict | None, dict | None]:
    """The model, and its STEP artifact's record (None when not built)."""
    m = await db.models.find_one({"_id": model_id}, {"artifacts": 1, "version": 1, "title": 1,
                                                      "built": 1})
    if not m:
        return None, None
    return m, (m.get("artifacts") or {}).get("step")


async def listing(db, part: str) -> dict:
    """The part's bodies, LCSC's first, each marked default or not, the
    drawn ones with their model's state."""
    from . import lcsc
    p = await db[lcsc.PARTS].find_one({"_id": part}, {"name": 1, "model_kind": 1, "model_name": 1,
                                                       "artifacts": 1, "model_step": 1,
                                                       "model_wrl": 1})
    doc = await get(db, part)
    has_lcsc = bool(p and ((p.get("artifacts") or {}).get("model")
                           or p.get("model_step") or p.get("model_wrl")))
    rows = [{"slug": LCSC, "name": "LCSC", "kind": "lcsc", "default": not doc.get("default"),
             "model": None, "ready": has_lcsc,
             "detail": (f"{p.get('model_kind', '').upper()} {p.get('model_name') or ''}".strip()
                        if has_lcsc else "LCSC has no 3D model for it")}]
    for b in doc.get("bodies") or []:
        m, step = await _model_step(db, b["model"])
        rows.append({"slug": b["slug"], "name": b["name"], "kind": "drawn",
                     "default": doc.get("default") == b["slug"], "model": b["model"],
                     "ready": bool(step), "by": b.get("by"), "at": b.get("at"),
                     "model_version": (m or {}).get("version"),
                     "step_bytes": (step or {}).get("bytes"),
                     "detail": ("its model is gone" if not m else
                                "not built yet - no STEP" if not step else
                                f"v{(m or {}).get('version') or 1}, "
                                f"{round(((step or {}).get('bytes') or 0) / 1024)} kB STEP")})
    return {"lcsc": part, "name": (p or {}).get("name"), "in_drawer": bool(p),
            "default": doc.get("default") or LCSC, "bodies": rows}


async def bind(db, part: str, model_id: str, name: str, default: bool = False) -> dict:
    """A drawn model bound to the part as a body of its own."""
    from . import lcsc
    part = (part or "").strip().upper()
    if not PART.match(part):
        raise BodyError(f"{part!r} is not an LCSC number (C12345)")
    if not await db[lcsc.PARTS].find_one({"_id": part}, {"_id": 1}):
        raise BodyError(f"{part} is not in the drawer - `part keep {part}` first", 404)
    name, s = check_name(name)
    model_id = (model_id or "").strip()
    m, step = await _model_step(db, model_id)
    if not m:
        raise BodyError(f"no model {model_id} - save it in the 3D room first", 404)
    if not step:
        raise BodyError(f"{model_id} has no STEP yet - build it (`revisions.py build {model_id}`)", 409)
    doc = await get(db, part)
    bodies = list(doc.get("bodies") or [])
    if any(b["slug"] == s for b in bodies):
        raise BodyError(f"{part} already has a body called {name!r} - unbind it first, or pick "
                        "another name", 409)
    who = _who()
    body = {"slug": s, "name": name, "model": model_id, "by": who, "at": now(),
            "step_sha": step.get("sha256"), "model_version": m.get("version") or 1}
    bodies.append(body)
    doc = {**doc, "bodies": bodies}
    was_default = doc.get("default")
    if default:
        doc["default"] = s
    await _put(db, doc)
    out = {"lcsc": part, "body": body, "default": doc.get("default") or LCSC, "queued": []}
    if default and was_default != s:
        out["queued"] = await queue_boards(db, await boards_wearing_part(db, part),
                                           {"part": part, "default": s})
    return out


async def set_default(db, part: str, variant: str) -> dict:
    doc = await get(db, part)
    v = (variant or "").strip()
    if v.lower() in (LCSC, "default", ""):
        new = None
    else:
        b = find(doc, v)
        if not b:
            raise BodyError(f"{part} has no body {v!r} - {_names(doc)}", 404)
        new = b["slug"]
    if doc.get("default") == new:
        return {"lcsc": part, "default": new or LCSC, "queued": [], "changed": False}
    if not doc.get("bodies") and new is None and not await db[COLL].find_one({"_id": part}):
        return {"lcsc": part, "default": LCSC, "queued": [], "changed": False}
    await _put(db, {**doc, "default": new})
    queued = await queue_boards(db, await boards_wearing_part(db, part),
                                {"part": part, "default": new or LCSC})
    return {"lcsc": part, "default": new or LCSC, "queued": queued, "changed": True}


async def unbind(db, part: str, variant: str, force: bool = False) -> dict:
    """A drawn body taken off the part. Refused while a board chooses it,
    unless `force` - then those boards go back to the part's default. The
    model itself stays in the 3D room."""
    doc = await get(db, part)
    b = find(doc, variant)
    if not b:
        raise BodyError(f"{part} has no body {variant!r} - {_names(doc)}", 404)
    choosers = await boards_choosing(db, part, b["slug"])
    if choosers and not force:
        raise BodyError(f"{', '.join(f'{bid} {ref}' for bid, ref in choosers)} "
                        f"{'chooses' if len(choosers) == 1 else 'choose'} {b['name']!r} - "
                        "choose another body there first, or unbind with force", 409)
    for bid, ref in choosers:
        await db[BOARDS].update_one({"_id": bid}, {"$unset": {f"bodies.{ref}": ""}})
    wearing = await boards_wearing_part(db, part)
    rest = [x for x in doc.get("bodies") or [] if x["slug"] != b["slug"]]
    new = {**doc, "bodies": rest,
           "default": None if doc.get("default") == b["slug"] else doc.get("default")}
    await _put(db, new)
    queued = await queue_boards(db, wearing, {"part": part, "unbound": b["slug"]}) \
        if (doc.get("default") == b["slug"] or choosers) else []
    return {"lcsc": part, "unbound": b, "default": new["default"] or LCSC,
            "cleared": [f"{bid} {ref}" for bid, ref in choosers], "queued": queued}


def _names(doc: dict) -> str:
    names = [LCSC] + [b["slug"] for b in doc.get("bodies") or []]
    return "it has " + ", ".join(names)


def _who() -> dict:
    from . import actors
    a = actors.current()
    return {k: a.get(k) for k in ("type", "id", "name")}


# ---------------------------------------------------------------- the board side

async def board_parts(db, bid: str) -> dict[str, str | None] | None:
    """ref -> LCSC number, from the board's build; None before the first."""
    try:
        graph = json.loads(await store.get_artifact(db, bid, "graph", BOARDS))
    except (KeyError, ValueError):
        return None
    return {c["ref"]: c.get("part") for c in graph.get("components") or [] if c.get("ref")}


def effective(part: str | None, doc: dict | None, choice: dict | None) -> tuple[dict | None, str | None]:
    """Which body a reference wears: (the drawn body, or None for LCSC's;
    why the board's own choice is not used, or None)."""
    why = None
    if choice:
        v = choice.get("variant")
        if choice.get("part") and part and choice["part"] != part:
            why = f"chosen for {choice['part']}, the board now has {part} - choose again"
        elif v == LCSC:
            return None, None
        else:
            b = find(doc, v)
            if b:
                return b, None
            why = f"{part} no longer has a body {v!r}"
    if doc and doc.get("default"):
        return find(doc, doc["default"]), why
    return None, why


async def for_board(db, bid: str, parts: dict[str, str | None] | None = None,
                    choices: dict | None = None) -> tuple[dict, dict]:
    """The drawn bodies a board's parts wear: ({ref: {part, slug, name,
    model, step_sha}}, {ref: why its choice or body is left out})."""
    if parts is None:
        parts = await board_parts(db, bid) or {}
    if choices is None:
        choices = ((await db[BOARDS].find_one({"_id": bid}, {"bodies": 1})) or {}).get("bodies") or {}
    use, left = {}, {}
    docs: dict[str, dict] = {}
    for ref, part in sorted(parts.items()):
        if not part:
            continue
        if part not in docs:
            docs[part] = await db[COLL].find_one({"_id": part}) or {}
        body, why = effective(part, docs[part], choices.get(ref))
        if why:
            left[ref] = why
        if body:
            _m, step = await _model_step(db, body["model"])
            if not step:
                left[ref] = (f"{body['name']!r} ({body['model']}) has no STEP - build it; "
                             "LCSC's body is used meanwhile")
                continue
            use[ref] = {"part": part, "slug": body["slug"], "name": body["name"],
                        "model": body["model"], "step_sha": step.get("sha256")}
    for ref in choices:
        if ref not in parts:
            left[ref] = "not on the board any more"
    return use, left


async def board_listing(db, bid: str) -> dict:
    """Every reference whose part has more than one body: what it could
    wear, what it chose, what it wears."""
    doc = await db[BOARDS].find_one({"_id": bid}, {"bodies": 1, "bodies_applied": 1, "bodies_at": 1})
    if doc is None:
        raise BodyError(f"no board {bid}", 404)
    parts = await board_parts(db, bid)
    choices = doc.get("bodies") or {}
    use, left = await for_board(db, bid, parts or {}, choices)
    applied = doc.get("bodies_applied") or {}
    rows, docs = [], {}
    for ref, part in sorted((parts or {}).items(), key=lambda kv: _ref_key(kv[0])):
        if not part:
            continue
        if part not in docs:
            docs[part] = await db[COLL].find_one({"_id": part}) or {}
        d = docs[part]
        if not d.get("bodies") and ref not in choices:
            continue
        ch = choices.get(ref) or {}
        wears = use.get(ref)
        rows.append({
            "ref": ref, "part": part,
            "options": [{"slug": LCSC, "name": "LCSC"}]
                       + [{"slug": b["slug"], "name": b["name"], "model": b["model"]}
                          for b in d.get("bodies") or []],
            "default": d.get("default") or LCSC,
            "chosen": ch.get("variant"), "by": ch.get("by"), "at": ch.get("at"),
            "wears": wears["slug"] if wears else LCSC,
            "wears_name": wears["name"] if wears else "LCSC",
            # What its 3D was last drawn with (None: not drawn since bodies existed).
            "applied": ((applied.get(ref) or {}).get("slug") or LCSC)
                       if (applied or doc.get("bodies_at")) else None,
            **({"left_out": left[ref]} if ref in left else {})})
    stale = [r["ref"] for r in rows if r["applied"] is not None and r["applied"] != r["wears"]]
    return {"board": bid, "built": parts is not None, "refs": rows,
            "refresh": (await db[BOARDS].find_one({"_id": bid}, {"body_refresh": 1}) or {}).get("body_refresh"),
            "not_drawn_yet": stale,
            "left_out": {r: w for r, w in left.items() if not any(x["ref"] == r for x in rows)}}


def _ref_key(ref: str):
    m = re.match(r"([A-Za-z_]*)(\d*)", ref)
    return (m.group(1), int(m.group(2) or 0), ref)


async def choose(db, bid: str, ref: str, variant: str | None) -> dict:
    """The body `ref` wears on this board: one of its part's ('lcsc' for
    LCSC's own), or None / 'default' to wear the part's default again."""
    ref = (ref or "").strip()
    if not REF.match(ref):
        raise BodyError(f"{ref!r} is not a reference designator")
    doc = await db[BOARDS].find_one({"_id": bid}, {"bodies": 1})
    if doc is None:
        raise BodyError(f"no board {bid}", 404)
    parts = await board_parts(db, bid)
    if parts is None:
        raise BodyError(f"{bid} has no build yet - run it first, so its parts are known", 409)
    if ref not in parts:
        near = sorted(r for r in parts if r[:1].upper() == ref[:1].upper())[:12]
        raise BodyError(f"no part {ref} on {bid}" + (f" (it has {', '.join(near)})" if near else ""),
                        404)
    part = parts[ref]
    if not part:
        raise BodyError(f"{ref} has no LCSC number - only an LCSC part has bodies to choose from")
    pdoc = await get(db, part)
    v = (variant or "").strip()
    was = (doc.get("bodies") or {}).get(ref)
    if v.lower() in ("", "default"):
        if was is None:
            return {"board": bid, "ref": ref, "part": part, "chosen": None, "changed": False,
                    "wears": (find(pdoc, pdoc.get("default")) or {}).get("slug") or LCSC, "queued": []}
        await db[BOARDS].update_one({"_id": bid}, {"$unset": {f"bodies.{ref}": ""}})
        chosen = None
    else:
        if v.lower() == LCSC:
            s = LCSC
        else:
            b = find(pdoc, v)
            if not b:
                raise BodyError(f"{part} ({ref}) has no body {v!r} - {_names(pdoc)}", 404)
            s = b["slug"]
        chosen = {"variant": s, "part": part, "by": _who(), "at": now()}
        if was and was.get("variant") == s and was.get("part") == part:
            return {"board": bid, "ref": ref, "part": part, "chosen": s, "changed": False,
                    "wears": s, "queued": []}
        await db[BOARDS].update_one({"_id": bid}, {"$set": {f"bodies.{ref}": chosen}})
    body, _why = effective(part, pdoc, chosen)
    queued = await queue_boards(db, [bid], {"board": bid, "ref": ref,
                                            "variant": chosen["variant"] if chosen else "default"})
    return {"board": bid, "ref": ref, "part": part, "chosen": chosen["variant"] if chosen else None,
            "wears": body["slug"] if body else LCSC, "changed": True, "queued": queued}


async def boards_wearing_part(db, part: str) -> list[str]:
    """Boards with that part on them (any reference)."""
    out = []
    async for b in db[BOARDS].find({}, {"_id": 1}):
        parts = await board_parts(db, str(b["_id"])) or {}
        if part in parts.values():
            out.append(str(b["_id"]))
    return sorted(out)


async def boards_choosing(db, part: str, variant: str) -> list[tuple[str, str]]:
    out = []
    async for b in db[BOARDS].find({}, {"bodies": 1}):
        for ref, ch in (b.get("bodies") or {}).items():
            if isinstance(ch, dict) and ch.get("part") == part and ch.get("variant") == variant:
                out.append((str(b["_id"]), ref))
    return sorted(out)


async def boards_wearing_model(db, model_id: str) -> list[str]:
    """Boards one of whose references wears a drawn body made by `model_id`."""
    if not [d async for d in db[COLL].find({}) if any(b.get("model") == model_id
                                                      for b in d.get("bodies") or [])]:
        return []
    out = []
    async for b in db[BOARDS].find({}, {"bodies": 1}):
        bid = str(b["_id"])
        use, _ = await for_board(db, bid, choices=b.get("bodies") or {})
        if any(u["model"] == model_id for u in use.values()):
            out.append(bid)
    return sorted(out)


# ---------------------------------------------------------------- how a change travels

def _later(seconds: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


async def queue_boards(db, boards: list[str], because: dict) -> list[str]:
    """Mark boards to have their 3D redrawn with the bodies they wear now
    (`loop` does it). A board with no layout yet is left: its first run
    draws it with them."""
    queued = []
    for bid in boards:
        doc = await db[BOARDS].find_one({"_id": bid}, {"artifacts": 1})
        arts = (doc or {}).get("artifacts") or {}
        if not (arts.get("routed") or arts.get("pcb")):
            continue
        at = now()
        token = hashlib.sha256(f"{bid}{at}".encode()).hexdigest()[:12]
        await db[BOARDS].update_one({"_id": bid}, {"$set": {"body_refresh": {
            "state": "queued", "at": at, "due": _later(DEBOUNCE), "because": because,
            "token": token}}})
        queued.append(bid)
    return queued


async def model_built(db, model_id: str) -> list[str]:
    """After a build of `model_id`: if it is a body bound to a part and its
    STEP changed, the boards that wear it are queued to be redrawn."""
    m, step = await _model_step(db, model_id)
    if not m or not step:
        return []
    changed = False
    async for d in db[COLL].find({}):
        bodies = d.get("bodies") or []
        touched = False
        for b in bodies:
            if b.get("model") == model_id and b.get("step_sha") != step.get("sha256"):
                b["step_sha"] = step.get("sha256")
                b["model_version"] = m.get("version") or 1
                touched = True
        if touched:
            changed = True
            await _put(db, {**d, "bodies": bodies})
    if not changed:
        return []
    return await queue_boards(db, await boards_wearing_model(db, model_id),
                              {"model": model_id, "version": m.get("version") or 1})


async def applied(db, bid: str, use: dict, left: dict | None = None) -> None:
    """What the board's 3D was last drawn with, per reference (and what was
    left out, and why)."""
    await db[BOARDS].update_one({"_id": bid}, {"$set": {
        "bodies_applied": {ref: {"slug": u["slug"], "model": u["model"],
                                 "step_sha": u.get("step_sha")} for ref, u in use.items()},
        "bodies_left": dict(left or {}), "bodies_at": now()}})


async def _job_running(db, bid: str) -> bool:
    from . import jobs
    try:
        running = await db.raw[jobs.JOBS].find_one(
            {"board": bid, "workspace": scope.current(), "status": "running"})
    except Exception:                                   # noqa: BLE001 - no jobs to ask
        return False
    return bool(running and jobs.alive(running))


async def tick(db, refresher, say=None) -> list[str]:
    """One look at one workspace's queued boards: each whose time has come
    redrawn by `refresher(db, bid)` (kicad.refresh_component). A board a
    job is running on waits - its layout wears the bodies anyway."""
    t = now()
    done = []
    rows = [b async for b in db[BOARDS].find({"body_refresh.state": "queued"}, {"body_refresh": 1})]
    for b in rows:
        r = b.get("body_refresh") or {}
        bid = str(b["_id"])
        if (r.get("due") or "") > t or await _job_running(db, bid):
            continue
        claim = await db[BOARDS].update_one(
            {"_id": bid, "body_refresh.state": "queued", "body_refresh.token": r.get("token")},
            {"$set": {"body_refresh.state": "drawing", "body_refresh.started": t}})
        if not claim.modified_count:
            continue
        try:
            out = await refresher(db, bid)
        except Exception as exc:                       # noqa: BLE001 - said on the board
            await db[BOARDS].update_one({"_id": bid, "body_refresh.token": r.get("token")}, {"$set": {
                "body_refresh.state": "failed", "body_refresh.error": str(exc)[-1500:],
                "body_refresh.done_at": now()}})
            if say:
                await say(f"{bid}: 3D not redrawn with its bodies - {str(exc).splitlines()[0][:200]}",
                          "error", room="pcb")
            continue
        await db[BOARDS].update_one({"_id": bid, "body_refresh.token": r.get("token")}, {"$set": {
            "body_refresh.state": "done", "body_refresh.done_at": now()},
            "$unset": {"body_refresh.error": ""}})
        done.append(bid)
        if say:
            q = (out or {}).get("queued") or []
            await say(f"{bid}: 3D redrawn with its parts' bodies - v{(out or {}).get('version')}"
                      + (" (new)" if (out or {}).get("changed") else " (unchanged)")
                      + (f"; rebuilding {', '.join(q)}" if q else ""), "done", room="pcb")
    return done


async def loop(raw_db, refresher, say=None, stop: asyncio.Event | None = None) -> None:
    """The API's redraw loop, over every workspace."""
    busy = {"body_refresh.state": "queued"}
    while not (stop and stop.is_set()):
        try:
            raw = raw_db()
            wss = list(await raw[BOARDS].distinct("workspace_id", busy))
            if None not in wss and scope.DEFAULT not in wss and await raw[BOARDS].find_one(
                    {**busy, "workspace_id": {"$exists": False}}, {"_id": 1}):
                wss.append(None)
            for w in wss:
                ws = w or scope.DEFAULT
                ctx = contextvars.copy_context()
                ctx.run(scope.WORKSPACE.set, ws)
                await asyncio.get_running_loop().create_task(
                    tick(scope.ScopedDb(raw, ws), refresher, say), context=ctx)
        except Exception:                               # noqa: BLE001 - next tick
            LOG.exception("body redraw tick failed")
        await asyncio.sleep(TICK)


# ---------------------------------------------------------------- what to draw

_PAD = re.compile(
    r'\(pad\s+"?([^"\s)]*)"?\s+(\w+)\s+(\w+)\s+\(at\s+([-\d.eE+]+)\s+([-\d.eE+]+)(?:\s+([-\d.eE+]+))?\s*\)'
    r'\s*\(size\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s*\)([^\n]*)')
_DRILL = re.compile(r"\(drill\s+(?:oval\s+)?([-\d.eE+]+)(?:\s+([-\d.eE+]+))?")
_LINE = re.compile(r"\(fp_(?:line|rect)\s+\(start\s+([-\d.eE+]+)\s+([-\d.eE+]+)\)\s*"
                   r"\(end\s+([-\d.eE+]+)\s+([-\d.eE+]+)\)[^\n]*?\(layer\s+\"?([\w.]+)")


def _f(v) -> float:
    return round(float(v) + 0.0, 3)


def footprint_spec(text: str) -> dict:
    """A .kicad_mod read for whoever draws a body for it - in the
    component frame (modelseat.py): every pad, pin 1, the courtyard,
    the silkscreen and fab outlines as boxes."""
    from . import modelseat
    pads = []
    for m in _PAD.finditer(text or ""):
        num, kind, shape, x, y, rot, w, h, rest = m.groups()
        cx, cy = modelseat.to_component(float(x), float(y))
        d = _DRILL.search(rest or "")
        pads.append({"number": num, "type": kind, "shape": shape, "x": _f(cx), "y": _f(cy),
                     "w": _f(w), "h": _f(h), "rot": _f(rot or 0),
                     **({"drill": _f(d.group(1))} if d else {})})
    boxes: dict[str, list[float]] = {}
    for m in _LINE.finditer(text or ""):
        x0, y0, x1, y1, layer = m.groups()
        layer = {"F.Silkscreen": "F.SilkS", "F.Courtyard": "F.CrtYd"}.get(layer, layer)
        if layer not in ("F.SilkS", "F.CrtYd", "F.Fab"):
            continue
        b = boxes.setdefault(layer, [1e9, 1e9, -1e9, -1e9])
        for x, y in ((x0, y0), (x1, y1)):
            cx, cy = modelseat.to_component(float(x), float(y))
            b[0], b[1] = min(b[0], cx), min(b[1], cy)
            b[2], b[3] = max(b[2], cx), max(b[3], cy)
    outline = {k: {"x": [_f(v[0]), _f(v[2])], "y": [_f(v[1]), _f(v[3])],
                   "size": [_f(v[2] - v[0]), _f(v[3] - v[1])]} for k, v in boxes.items()}
    pin1 = next((p for p in pads if p["number"] in ("1", "A1")), None)
    name = re.match(r'\s*\((?:module|footprint)\s+"?([^"\s)]+)', text or "")
    return {"footprint": name.group(1).split(":")[-1] if name else None,
            "smd": "(attr smd)" in (text or "") and not any(p["type"] == "thru_hole" for p in pads),
            "pads": pads, "pin1": pin1, "outline": outline}


# A model's raw box by (kind, sha256 of its bytes); a few hundred parts at most.
_BOXES: dict[tuple[str, str], object] = {}


async def spec(db, part: str) -> dict:
    """Everything needed to draw a body for a part: the footprint in the
    component frame, LCSC's body's box where it sits now, what the part is."""
    from . import lcsc, modelseat
    p = await db[lcsc.PARTS].find_one({"_id": part}, {"footprint": 1, "name": 1})
    if not p or not p.get("footprint"):
        raise BodyError(f"{part} is not in the drawer - `part keep {part}` first", 404)
    out = footprint_spec(p["footprint"])
    out["lcsc"] = part
    facts = lcsc._drawer_facts(part)
    out["part"] = {k: facts.get(k) for k in ("mpn", "maker", "package", "description", "value")}
    out["frame"] = FRAME
    box = None
    got = await lcsc.model_of(db, part)
    if got:
        # Reading a STEP's box is a CAD kernel's work (~0.3 s): kept by the
        # model's content, so the part card opens again without it.
        key = (got[1], hashlib.sha256(got[0]).hexdigest())
        if key in _BOXES:
            raw = _BOXES[key]
        else:
            loop = asyncio.get_running_loop()
            try:
                raw = await loop.run_in_executor(None, modelseat.model_box, got[0], got[1])
            except Exception:                           # noqa: BLE001 - the box is a nicety
                raw = None
            _BOXES[key] = raw
            while len(_BOXES) > 256:
                _BOXES.pop(next(iter(_BOXES)))
        if raw:
            (x0, y0, z0), (x1, y1, z1) = modelseat.placed_box(
                raw, modelseat.rotation_of(p["footprint"]), modelseat.offset_of(p["footprint"]))
            box = {"x": [_f(x0), _f(x1)], "y": [_f(y0), _f(y1)], "z": [_f(z0), _f(z1)],
                   "size": [_f(x1 - x0), _f(y1 - y0), _f(z1 - z0)], "kind": got[1]}
    out["lcsc_box"] = box
    return out


FRAME = ("mm; origin = the footprint's origin; +Z up out of the board's top surface "
         "(z = 0 on it, leads go below); +X = the footprint's +X; +Y = the footprint's -Y "
         "(a .kicad_mod has +Y down the page) - KiCad's 3D frame. Used as-is: no offset, "
         "no rotate, no pose (backend/modelseat.py, 'The component frame').")


def _span(v: dict) -> str:
    return f"{v[0]:g}..{v[1]:g}"


def request_text(sp: dict, name: str, why: str, model_id: str, board: str | None,
                 ref: str | None, limit: int = 3900) -> str:
    """The note the 3D room gets: what to draw, in which frame, where it
    lives and how it is bound when done. Kept under a note's 4000."""
    s = slug(name)
    part = sp["lcsc"]
    facts = sp.get("part") or {}
    head = [f"Draw a 3D body for {part} ({sp.get('footprint') or facts.get('package') or '?'}): "
            f"\"{name}\"."]
    if why:
        head.append(f"Asked: {why.strip()}")
    if board and ref:
        head.append(f"For {board} {ref} (selected there once it is bound).")
    head += ["", f"Model: {model_id}  (a new model in the 3D room)",
             f"Frame: {FRAME}", ""]
    what = [x for x in (facts.get("mpn"), facts.get("maker"), facts.get("package")) if x]
    if what:
        head.append("Part: " + " · ".join(what))
    if facts.get("description"):
        head.append("  " + str(facts["description"])[:200])
    head.append(f"Datasheet: revisions.py pdf text {part}, then pdf page {part} <n> for its drawing")
    head.append("")
    pads = sp.get("pads") or []
    lines = [f"Footprint, component frame (+Y = footprint -Y), {len(pads)} pads"
             + (", SMD" if sp.get("smd") else "") + ":"]
    for p in pads:
        lines.append(f"  {p['number']:>3} {p['type']} {p['shape']} {p['w']:g}x{p['h']:g}"
                     + (f" rot {p['rot']:g}" if p.get("rot") else "")
                     + f" at ({p['x']:g}, {p['y']:g})"
                     + (f" drill {p['drill']:g}" if p.get("drill") else "")
                     + ("  <- pin 1" if sp.get("pin1") is p else ""))
    for layer, label in (("F.CrtYd", "courtyard"), ("F.SilkS", "silkscreen"), ("F.Fab", "fab")):
        o = (sp.get("outline") or {}).get(layer)
        if o:
            lines.append(f"  {label}: x {_span(o['x'])}, y {_span(o['y'])} "
                         f"({o['size'][0]:g} x {o['size'][1]:g})")
    b = sp.get("lcsc_box")
    if b:
        lines.append(f"LCSC's body as it sits now: x {_span(b['x'])}, y {_span(b['y'])}, "
                     f"z {_span(b['z'])} ({b['size'][0]:g} x {b['size'][1]:g} x {b['size'][2]:g})")
    else:
        lines.append("LCSC's body: none to measure")
    tail = ["", "When it is built:",
            f"  revisions.py part body-bind {part} {model_id} --name \"{name}\"",
            f"  (--default makes it the part's body on every board)"]
    if board and ref:
        tail.append(f"  then {board} {ref} wears it with: revisions.py board body {board} {ref} {s}"
                    " (the PCB agent or the person)")
    tail.append(f"Everything above as JSON: revisions.py part bodies {part} --spec")
    body = "\n".join(head + lines + tail)
    if len(body) <= limit:
        return body
    # A many-pad part: the pads trimmed, the rest of the note whole.
    keep = lines[:1]
    room = limit - len("\n".join(head + tail)) - 80
    for ln in lines[1:]:
        if len("\n".join(keep + [ln])) > room:
            break
        keep.append(ln)
    keep.append(f"  ... {len(lines) - len(keep)} more lines: `part bodies {part} --spec`")
    return "\n".join(head + keep + tail)[:limit]


async def request(db, part: str, name: str, why: str, board: str | None = None,
                  ref: str | None = None) -> dict:
    """A note in the 3D room's queue asking for a body for the part -
    filed the way every note is (main.create_revision), queued at once."""
    from . import actors, main
    part = (part or "").strip().upper()
    if not PART.match(part):
        raise BodyError(f"{part!r} is not an LCSC number (C12345)")
    name, s = check_name(name)
    why = (why or "").strip()[:WHY_MAX]
    if not why:
        raise BodyError("say what the body is for (--why): it is what the 3D agent reads")
    if bool(board) != bool(ref):
        raise BodyError("--board and --ref go together")
    if board:
        parts = await board_parts(db, board)
        if parts is None:
            raise BodyError(f"no built board {board}", 404)
        if parts.get(ref) != part:
            raise BodyError(f"{board} {ref} is " + (f"{parts[ref]}, not {part}" if ref in parts
                                                     else "not on the board"), 404)
    doc = await get(db, part)
    if find(doc, s):
        raise BodyError(f"{part} already has a body {name!r} - choose it, or ask for another name",
                        409)
    sp = await spec(db, part)
    model_id = f"{FOLDER}/{part}-{s}"
    # The folder it goes in, so the model shows in the catalog once saved.
    if not await db.folders.find_one({"_id": FOLDER}):
        try:
            await store.create_folder(db, "", FOLDER)
        except (FileExistsError, ValueError):
            pass
    text = request_text(sp, name, why, model_id, board, ref)
    note = await main.create_revision(main.RevisionIn(comment=text, model=model_id, kind="cad"))
    await store.set_status(db, note["id"], "queued")
    asked = {"part": part, "name": name, "slug": s, "model": model_id,
             "board": board, "ref": ref, "why": why}
    await db.revisions.update_one({"_id": note["id"]}, {"$set": {
        "status_by": actors.current(), "body_request": asked}})
    await actors.audit(db, "body-request", note["id"], asked)
    return {"note": note["id"], "model": model_id, "text": text, **asked}


# ---------------------------------------------------------------- into a layout

async def _write_step(db, work, part: str, u: dict, written: set) -> str:
    """The body's STEP into the layout's work directory; its path there."""
    from pathlib import Path
    step_path, _fp = file_names(part, u)
    if step_path not in written:
        blob = await store.get_artifact(db, u["model"], "step")
        local = Path(work) / step_path[len("/work/"):]
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(blob)
        written.add(step_path)
    return step_path


async def stage(db, work, use: dict, library: dict | None = None) -> tuple[dict, dict]:
    """A layout's files for the drawn bodies its references wear: each
    body's STEP in work/3d, and the part's footprint wearing it in
    work/fp/body-<slug>/<part>.kicad_mod (the part's own footprint, as the
    layout wrote it, with the body's block). Returns ({ref: the
    footprint's path in the container}, {ref: why not}). A part drawn from
    KiCad's library (a passive) has no footprint here to dress."""
    from pathlib import Path

    from . import modelseat
    out, left, written = {}, {}, set()
    for ref, u in sorted(use.items()):
        part = u["part"]
        src = Path(work) / "fp" / f"{part}.kicad_mod"
        if (library or {}).get(part) or not src.exists():
            left[ref] = f"{part} is drawn from KiCad's library here - its drawn body is not applied"
            continue
        try:
            step_path = await _write_step(db, work, part, u, written)
        except KeyError:
            left[ref] = f"{u['model']} has no STEP - built since? LCSC's body is used"
            continue
        _sp, fp_path = file_names(part, u)
        local = Path(work) / fp_path[len("/work/"):]
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_text(modelseat.with_body(src.read_text(), step_path))
        out[ref] = fp_path
    return out, left


def unposed(plan: dict, dressed: dict, use: dict) -> dict:
    """Take a board's poses (backend/poses.py) off the references that wear
    a drawn body: it is drawn where it sits, and the numbers were measured
    for another body. Returns {ref: why} for the ones taken off."""
    left = {}
    for ref in dressed:
        if ref in (plan.get("poses") or {}):
            plan["poses"].pop(ref)
            left[ref] = (f"wears the drawn body \"{use[ref]['name']}\" - drawn in place, "
                         "a pose is not applied to it")
    if "poses" in plan and not plan["poses"]:
        plan.pop("poses")
    return left


def _lcsc_block(footprint: str, part: str, kind: str) -> str | None:
    """The part's own model block, as the drawer seats it, pointed where a
    layout puts LCSC models."""
    from . import modelseat
    block = modelseat.model_block_of(footprint or "")
    if not block:
        return None
    return re.sub(r'\(model\s+("(?:[^"\\]|\\.)*"|[^\s()]+)', f'(model "{STEP_DIR}/{part}.{kind}"',
                  block, count=1)


async def refit(db, bid: str, pcb: str, work) -> tuple[str, dict, dict]:
    """A laid-out board's .kicad_pcb with every reference wearing the body
    the board wants now - for redrawing its 3D without placing or routing
    it again. Each drawn body's STEP is written into work/3d. A reference
    that goes back to LCSC's body gets the drawer's seated block (and the
    board's pose for it, when one applies). Returns (the text, what is
    worn {ref: use}, what is left out {ref: why})."""
    from . import lcsc, modelseat
    use, left = await for_board(db, bid)
    pose_use = {}
    try:
        from . import poses
        kept = ((await db[BOARDS].find_one({"_id": bid}, {"poses": 1})) or {}).get("poses")
        parts = await board_parts(db, bid) or {}
        pose_use, _ = poses.for_plan(kept, [{"ref": r, "part": p} for r, p in parts.items()])
    except ImportError:
        pass
    written: set = set()
    worn = {}
    for fp in modelseat.board_footprints(pcb):
        ref, path = fp["ref"], fp["model"] or ""
        if ref in use:
            u = use[ref]
            try:
                step_path = await _write_step(db, work, u["part"], u, written)
            except KeyError:
                left[ref] = f"{u['model']} has no STEP - LCSC's body is used"
                continue
            worn[ref] = u
            if path != step_path:
                pcb = modelseat.with_ref_model(pcb, ref, modelseat.body_block(step_path))
        elif path.startswith(f"{STEP_DIR}/body-"):
            part = fp["name"]
            doc = await db[lcsc.PARTS].find_one({"_id": part}, {"footprint": 1, "model_kind": 1})
            got = await lcsc.model_of(db, part) if doc else None
            block = _lcsc_block((doc or {}).get("footprint"), part, got[1] if got else "step") \
                if got else None
            if block and ref in pose_use:
                block = modelseat.with_turn(block, pose_use[ref].get("rotate"),
                                            pose_use[ref].get("offset"))
            if block:
                pcb = modelseat.with_ref_model(pcb, ref, block)
            else:
                left[ref] = f"{part}: no LCSC body to go back to"
    return pcb, worn, left
