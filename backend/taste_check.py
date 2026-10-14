"""The Taste check before a note is marked applied.

A note whose project has Taste palettes (attached to it, or to a folder it
is in - backend/taste.py attached_to) is checked against them before it is
called applied, from the page ("mark applied") and from the agents'
`revisions.py done <id>` alike:

- a 3D note: the model is rendered from the views of the palettes'
  reference renders (as `revisions.py taste-check` takes them, so the two
  line up) and a model that reads images is shown the references, the
  design and the items that are about a shape (form, mechanical, general),
  numbered, and says of each pass, fail or unclear;
- a board or a firmware note: there is no picture of one to hold against
  the palette, so its items (pcb or firmware, and general) are listed as
  unchecked, for the person to look at.

Pass - no item failed - and the note is marked. Otherwise the person sees
what failed (or why nothing could be checked) and marks it anyway or goes
back; an agent needs `done <id> --force`. PATCH /api/revisions/{id}?status=applied
refuses (409) a note with palettes until its latest check passed, or with
force=true; what was decided is kept on the note (`taste_check`).

The rendering (one headless browser, up to minutes) and the model's look
(up to minutes) are too long for one request, so a check is a job like a
Taste extraction: POST starts it and answers at once, the work runs as a
task of this API process writing each step down (`taste_checks`, per
workspace), and GET reads it. A check left running by a process that is
gone (uvicorn --reload) is failed with GONE when it is read.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets

from fastapi import APIRouter, HTTPException

from . import actors, llm, taste

router = APIRouter(prefix="/api/revisions")
log = logging.getLogger("redline.taste_check")

COLL = "taste_checks"
ACTIVE = ("queued", "rendering", "asking")
VERDICTS = ("pass", "fail", "unclear")
CHECK_TOKENS = 4_000
CHECK_TIMEOUT = 240.0
MAX_ITEMS = 60                  # numbered for the model in one check
MAX_REF_SHOTS = 6               # reference renders it is shown, across the palettes
KEEP = 3                        # checks kept per note, newest first
# Which items a kind of work is checked against: a model is a shape.
DOMAINS_FOR = {"model": ("form", "mechanical", "general"), "board": ("pcb", "general"),
               "firmware": ("firmware", "general")}
GONE = "the check was interrupted (the server restarted) - run it again"
_TASKS: dict[str, asyncio.Task] = {}

CHECK_PROMPT = (
    "You check a finished design against the person's design taste: a \"Taste palette\" of numbered "
    "statements, each MUST, PREFER or AVOID. You are shown reference renders of the product the palette was "
    "read from (when there are any) - they show what the person means - and renders of the design to check, "
    "from the same views. Judge the design, not the references.\n"
    "For every statement say whether the design follows it, from what the renders show:\n"
    "- \"pass\": it does, or the statement is about nothing this design has;\n"
    "- \"fail\": it visibly does not - a MUST not met, an AVOID done, a PREFER plainly ignored;\n"
    "- \"unclear\": the renders cannot show it (inside, hidden, a size you cannot judge).\n"
    "Be strict about MUST and AVOID; a PREFER fails only when it is plainly ignored. A statement's "
    "\"where\" (visible surfaces, internal features) and its exception hold.\n"
    "Answer with JSON only, one object per statement, in order: "
    "[{\"n\": 1, \"verdict\": \"pass\", \"why\": \"one short sentence: what you see\"}]"
)


def _db():
    from .main import db
    return db()


def note_projects(doc: dict) -> list[tuple[str, str]]:
    """The projects a note is about, as (kind, id): a firmware note's
    firmware, a board note's board, a 3D note's model."""
    if doc.get("kind") == "firmware":
        return [("firmware", doc["model"])] if doc.get("model") else []
    out = []
    if doc.get("board"):
        out.append(("board", doc["board"]))
    if doc.get("model"):
        out.append(("board" if doc.get("kind") == "pcb" and not doc.get("board") else "model", doc["model"]))
    return out


async def applying(db, doc: dict) -> tuple[list[dict], dict, list[tuple[str, str]]]:
    """(the palettes that apply to the note's projects, each once with the
    project it reaches - `for` - the per-palette switch of the
    project-specific items, the projects)."""
    targets = note_projects(doc)
    rows, seen, overrides = [], set(), {}
    for kind, ref in targets:
        got = await taste.attached_to(db, kind, ref)
        overrides = {**taste.overrides_for(got, kind, ref), **overrides}
        for p in got:
            if p["_id"] not in seen:
                seen.add(p["_id"])
                rows.append({**p, "for": [kind, ref]})
    return rows, overrides, targets


async def items_for(db, palettes: list[dict], overrides: dict, kind: str) -> list[dict]:
    """The items of these palettes a `kind` of work is checked against:
    its domains, and the project-specific ones only where they apply."""
    want = DOMAINS_FOR.get(kind, ())
    out = []
    for p in palettes:
        k, ref = p["for"]
        on = taste.specifics_for(p, await taste.product_of(db, k, ref), override=overrides.get(p["_id"]))
        for i in p.get("items") or []:
            i = taste.item_out(i)
            if i["domain"] in want and (i["layer"] != "specific" or on):
                out.append({"palette": p["_id"], "palette_name": p.get("name") or "", "id": i["id"],
                            "text": i["text"], "strength": i["strength"], "domain": i["domain"],
                            "applies_to": i["applies_to"], "exception": i.get("exception") or ""})
    out.sort(key=lambda i: taste.STRENGTHS.index(i["strength"]))
    return out[:MAX_ITEMS]


def _numbered(items: list[dict]) -> str:
    lines = []
    for n, i in enumerate(items, 1):
        where = "" if i["applies_to"] == "all" else f" [{taste.SCOPE_NAMES.get(i['applies_to'], i['applies_to'])}]"
        lines.append(f"{n}. {i['strength'].upper()}{where}: {i['text']}"
                     + (f" (except: {i['exception']})" if i.get("exception") else ""))
    return "\n".join(lines)


def parse_verdicts(raw: str, n: int) -> list[dict]:
    """[{verdict, why}] for items 1..n out of what the model wrote; an item
    it left out is unclear. ValueError when there is no JSON list in it."""
    text = re.sub(r"```(?:json)?", "", raw or "")
    a, b = text.find("["), text.rfind("]")
    if a < 0 or b <= a:
        raise ValueError("the model did not answer with a list")
    try:
        rows = json.loads(text[a:b + 1])
    except ValueError as exc:
        raise ValueError("the model's answer is not JSON") from exc
    got: dict[int, dict] = {}
    for pos, r in enumerate(rows if isinstance(rows, list) else [], 1):
        if not isinstance(r, dict):
            continue
        try:
            k = int(r.get("n") or pos)
        except (TypeError, ValueError):
            k = pos
        v = str(r.get("verdict") or "").strip().lower()
        if 1 <= k <= n and k not in got:
            got[k] = {"verdict": v if v in VERDICTS else "unclear", "why": str(r.get("why") or "").strip()[:300]}
    return [got.get(k, {"verdict": "unclear", "why": "not answered"}) for k in range(1, n + 1)]


def overall(items: list[dict]) -> str:
    """fail when an item failed; unchecked when none could be looked at;
    else pass (an unclear item does not stop it)."""
    if any(i.get("verdict") == "fail" for i in items):
        return "fail"
    if items and all(i.get("verdict") == "unchecked" for i in items):
        return "unchecked"
    return "pass"


async def check(db, note: dict, track: taste.Tracker) -> dict:
    """One check of a note: {verdict, items, palettes, provider, model, notice}."""
    from . import store
    palettes, overrides, targets = await applying(db, note)
    shown = [{"id": p["_id"], "name": p.get("name") or "", "via": p.get("via"), "count": len(p.get("items") or [])}
             for p in palettes]
    base = {"palettes": shown, "projects": [list(t) for t in targets], "provider": None, "model": None, "notice": ""}
    if not palettes:
        return {**base, "verdict": "pass", "items": [], "notice": "no palette applies"}
    kind, ref = targets[0]
    items = await items_for(db, palettes, overrides, kind)
    if not items:
        return {**base, "verdict": "pass", "items": [],
                "notice": f"none of the palettes' items are about a {'3D model' if kind == 'model' else kind}"}
    if kind != "model":
        return {**base, "verdict": "unchecked", "items": [{**i, "verdict": "unchecked", "why": ""} for i in items],
                "notice": f"a {kind} has no picture to check against the palette - look at each item yourself"}

    def unchecked(why: str) -> dict:
        return {**base, "verdict": "unchecked", "items": [{**i, "verdict": "unchecked", "why": ""} for i in items],
                "notice": why}

    # The references: the views they were taken from are the views the design is taken from.
    refs, views = [], []
    for p in palettes:
        for r in p.get("references") or []:
            if r.get("view") in taste.LOOK_VIEWS and r["view"] not in views:
                views.append(r["view"])
            if len(refs) < MAX_REF_SHOTS and r.get("gridfs_id"):
                try:
                    refs.append((f"{p.get('name')}: {r.get('label') or r.get('model') or ''}, {r.get('view')} view",
                                 await store.get_shot(db, r["gridfs_id"])))
                except Exception:                       # noqa: BLE001 - a render gone: the rest do
                    pass
    views = views or list(taste.LOOK_VIEWS)
    prov, model, vision = await taste.vision_route()
    if not vision:
        return unchecked("no configured model reads images - choose one that does for Taste extraction in "
                         "Settings > LLM settings")
    if not llm.key(prov):
        return unchecked(llm.no_key(prov, taste.JOB))
    await track.phase("rendering")
    await track.step("render", kind="render", model=ref, views=views)
    try:
        pngs = await taste.render_views(db, ref, tuple(views))
    except asyncio.CancelledError:
        raise
    except Exception as exc:                            # noqa: BLE001 - said; the person decides
        why = str(exc)[:300] or type(exc).__name__
        await track.step("render", state="failed", reason=why)
        return unchecked(f"the model could not be rendered ({why})")
    await track.step("render", state="done", shots=len(pngs))
    label = await taste.project_label(db, "model", ref) or ref
    text = (f"Design to check: the 3D model \"{label}\". The note it was changed for: "
            f"{(note.get('comment') or '').strip()[:600]}\n\nThe palette's statements:\n{_numbered(items)}")
    user: list = [{"type": "text", "text": text}]
    for what, png in refs:
        user += [{"type": "text", "text": f"Reference render - {what}"},
                 {"type": "image_url", "image_url": {"url": await asyncio.to_thread(taste._for_model, png)}}]
    for v, png in pngs.items():
        user += [{"type": "text", "text": f"The design to check, {v} view"},
                 {"type": "image_url", "image_url": {"url": await asyncio.to_thread(taste._for_model, png)}}]
    await track.phase("asking", provider=prov, model=model)
    await track.step("ask", kind="ask", provider=prov, model=model, images=len(refs) + len(pngs), items=len(items))
    try:
        d = await llm.complete([{"role": "system", "content": CHECK_PROMPT}, {"role": "user", "content": user}],
                               job=taste.JOB, provider=prov, model=model, max_tokens=CHECK_TOKENS,
                               temperature=0.1, timeout=CHECK_TIMEOUT)
    except asyncio.CancelledError:
        raise
    except Exception as exc:                            # noqa: BLE001 - said; the person decides
        why = taste._failed(prov, model, exc, CHECK_TIMEOUT)
        await track.step("ask", state="failed", reason=why)
        return {**unchecked(why), "provider": prov, "model": model}
    prov, model = d.get("provider") or prov, d.get("model") or model
    used = d.get("usage") or {}
    await llm.record(db, provider=prov, model=model, surface="taste", kind="taste-check", used=used)
    content = ((d.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    try:
        verdicts = parse_verdicts(content, len(items))
    except ValueError as exc:
        await track.step("ask", state="failed", reason=str(exc))
        return {**unchecked(f"{exc} - run the check again"), "provider": prov, "model": model}
    await track.step("ask", state="done", tokens_in=used.get("prompt_tokens"), tokens_out=used.get("completion_tokens"))
    got = [{**i, **v} for i, v in zip(items, verdicts)]
    notice = "" if refs else "the palettes have no reference renders: judged from the statements alone"
    return {**base, "verdict": overall(got), "items": got, "provider": prov, "model": model, "notice": notice}


# ---- the check as a job --------------------------------------------------------

class CheckTracker(taste.Tracker):
    """A check's steps, written on its job as they happen."""

    def __init__(self, db, cid: str):
        super().__init__()
        self.db, self.cid = db, cid
        self.status = "queued"

    async def flush(self) -> None:
        await self.db[COLL].update_one({"_id": self.cid, "status": {"$in": list(ACTIVE)}},
                                       {"$set": {"status": self.status, "steps": self.steps, **self.meta,
                                                 "beat": taste._now()}})


def orphaned(doc: dict) -> bool:
    t = _TASKS.get(doc["_id"])
    if doc.get("status") not in ACTIVE or (t and not t.done()):
        return False
    w = doc.get("worker") or {}
    if w.get("boot") == taste.WORKER["boot"]:
        return True
    if w.get("host") == taste.WORKER["host"] and w.get("pid") and not taste._pid_alive(w["pid"]):
        return True
    quiet = taste._seconds(doc.get("beat") or doc.get("started_at"))
    return quiet is None or quiet > taste.JOB_LOST


async def _end(db, cid: str, status: str, sets: dict) -> None:
    now = taste._now()
    doc = await db[COLL].find_one({"_id": cid}) or {}
    await db[COLL].update_one({"_id": cid, "status": {"$in": list(ACTIVE)}},
                              {"$set": {"status": status, "finished_at": now,
                                        "seconds": taste._seconds(doc.get("started_at"), now), **sets}})


async def latest(db, rid: str) -> dict | None:
    """The note's newest check, settled: one whose process is gone is failed."""
    rows = [d async for d in db[COLL].find({"note": rid})]
    rows.sort(key=lambda d: d.get("started_at") or "", reverse=True)
    doc = rows[0] if rows else None
    if doc and orphaned(doc):
        await _end(db, doc["_id"], "failed", {"error": GONE})
        doc = await db[COLL].find_one({"_id": doc["_id"]})
    return doc


async def _work(db, cid: str, note: dict) -> None:
    track = CheckTracker(db, cid)
    try:
        got = await check(db, note, track)
        await _end(db, cid, "done", {"steps": track.steps, "result": got})
    except asyncio.CancelledError:
        track.close_running("failed", GONE)
        try:
            await asyncio.shield(_end(db, cid, "failed", {"steps": track.steps, "error": GONE}))
        except BaseException:                           # noqa: BLE001 - the process is going; a read settles it
            pass
        raise
    except Exception as exc:                            # noqa: BLE001 - said to the person, plainly
        log.exception("taste check %s failed", cid)
        why = f"the check stopped: {str(exc)[:300] or type(exc).__name__}"
        track.close_running("failed", why)
        await _end(db, cid, "failed", {"steps": track.steps, "error": why})
    finally:
        _TASKS.pop(cid, None)


async def start(db, rid: str, by: dict | None = None) -> dict | None:
    """Start a check of a note (the running one, if there is one); None
    when no palette applies to its project - there is nothing to check."""
    note = await db.revisions.find_one({"_id": rid})
    if not note:
        raise LookupError(rid)
    palettes, _, _ = await applying(db, note)
    if not palettes:
        return None
    cur = await latest(db, rid)
    if cur and cur.get("status") in ACTIVE:
        return cur
    now = taste._now()
    doc = {"_id": secrets.token_hex(6), "note": rid, "status": "queued", "by": by or actors.current(),
           "started_at": now, "finished_at": None, "beat": now, "worker": taste.WORKER, "steps": [],
           "result": None, "error": None,
           "palettes": [{"id": p["_id"], "name": p.get("name") or "", "via": p.get("via")} for p in palettes]}
    await db[COLL].insert_one(doc)
    _TASKS[doc["_id"]] = asyncio.create_task(_work(db, doc["_id"], note))
    rows = sorted([d async for d in db[COLL].find({"note": rid}, {"started_at": 1})],
                  key=lambda d: d.get("started_at") or "", reverse=True)
    for d in rows[KEEP:]:
        await db[COLL].delete_one({"_id": d["_id"]})
    return doc


async def gate(db, rid: str) -> dict | None:
    """None when the note may be marked applied now; else why not:
    {reason: "check" (palettes apply and no passing check), check: the latest}."""
    note = await db.revisions.find_one({"_id": rid})
    if not note:
        return None
    palettes, _, _ = await applying(db, note)
    if not palettes:
        return None
    cur = await latest(db, rid)
    # A pass counts for the work it looked at: not once the note was queued again after it.
    fresh = cur and (cur.get("started_at") or "") >= str(note.get("queued_at") or "")
    if fresh and cur.get("status") == "done" and (cur.get("result") or {}).get("verdict") == "pass":
        return None
    return {"reason": "check", "palettes": [{"id": p["_id"], "name": p.get("name"), "via": p.get("via")}
                                            for p in palettes],
            "check": out(cur) if cur else None}


async def decided(db, rid: str, forced: bool, by: dict | None = None) -> None:
    """What the check said when the note was marked applied, kept on the
    note - when palettes apply to it, or it was forced."""
    note = await db.revisions.find_one({"_id": rid})
    if not note or not (forced or (await applying(db, note))[0]):
        return
    cur = await latest(db, rid)
    await db.revisions.update_one({"_id": rid}, {"$set": {"taste_check": {
        "check": cur["_id"] if cur else None, "verdict": ((cur or {}).get("result") or {}).get("verdict"),
        "forced": forced, "by": by or actors.current(), "at": taste._now()}}})


def out(d: dict | None) -> dict | None:
    if not d:
        return None
    keep = {k: v for k, v in d.items() if k not in ("_id", "workspace_id", "worker", "beat")}
    return {**keep, "id": d["_id"], "now": taste._now(),
            "seconds": d.get("seconds") if d.get("finished_at") else taste._seconds(d.get("started_at"))}


# ---- the API -----------------------------------------------------------------

@router.post("/{rid}/taste-check")
async def api_start(rid: str):
    """Start the Taste check of a note (or read the one running): {status:
    "none"} when no palette applies to its project."""
    try:
        doc = await start(_db(), rid)
    except LookupError as exc:
        raise HTTPException(404, rid) from exc
    return out(doc) if doc else {"status": "none"}


@router.get("/{rid}/taste-check")
async def api_latest(rid: str):
    """The note's latest check, or {status: "none"}."""
    return out(await latest(_db(), rid)) or {"status": "none"}
