"""note_status: where a room's note (a revision) stands - its status, when
it was written, queued and applied, its run (who worked on it, how far,
from when to when, who took it over) and what the agent said while it
worked: the room's log for that run's time, the band the note's card
shows while it runs (GET /api/activity) - with its Taste check, if one
applies; or the newest note about a model, board or firmware.

`mark_applied` does what the card's Mark applied does (PATCH
/api/revisions/{id}?status=applied, main.py `set_status`), the Taste check
gate included (backend/taste_check.py): where palettes apply to the note's
project it is marked only once its latest check passed. Otherwise, as the
card's box does, the check is started (or the running one read) and the
answer says to ask again when it is done; a check that did not pass is
said item by item, and `force` marks it anyway - only when the person says
so, having seen what failed. The person is asked before it is marked, and
it is kept for undo: the status, its time and who set it go back."""

from __future__ import annotations

from .. import actors, chat_undo, store, taste_check
from . import Ctx, Result, Tool, ToolError, clip
from ._rights import need
from ._things import find
from .queue_list import NAME, SAID, THING, room_of, state, who

LOG = 40                            # lines of the run's log given
SAY = {"draft": "Note {title}: draft", "queued": "Note {title}: queued", "working": "Note {title}: working now",
       "review": "Note {title}: done, waiting for review", "failed": "Note {title}: failed",
       "applied": "Note {title}: applied", "rejected": "Note {title}: rejected"}


def _at(v) -> str:
    return str(v or "")[:16].replace("T", " ")


async def _latest_for(db, ref: str) -> dict:
    """The newest note about the model, board or firmware `ref` names (its id, or words of it)."""
    ids = sorted({d.get("model") async for d in db.revisions.find({}, {"model": 1}) if d.get("model")})
    words = [w for w in ref.lower().replace("/", " ").replace("_", " ").replace("-", " ").split() if w]
    hit = [ref] if ref in ids else [i for i in ids if words and all(
        w in i.lower().replace("/", " ").replace("_", " ").replace("-", " ") for w in words)]
    if not hit:
        raise ToolError(f"no note is about {ref!r}" + (f"; notes are about: {', '.join(ids[:40])}" if ids else ""))
    if len(hit) > 1:
        raise ToolError(f"{len(hit)} things match {ref!r}: {', '.join(hit[:40])}. Ask again with one id.")
    rows = [d async for d in db.revisions.find({"model": hit[0]}).sort("created_at", -1).limit(1)]
    return rows[0]


async def _band(db, room: str, run: dict | None) -> list[dict]:
    """The room's log over the run's time: what the agent said while it worked on the note."""
    if not run or not run.get("started_at"):
        return []
    q: dict = {"at": {"$gte": str(run["started_at"])}}
    if run.get("finished_at"):
        q["at"]["$lte"] = str(run["finished_at"])
    q["room"] = {"$in": ["cad", None]} if room == "cad" else room
    rows = [x async for x in db.activity.find(q).sort("at", -1).limit(LOG)]
    return list(reversed(rows))


def _check_lines(c: dict | None) -> list[str]:
    if not c:
        return ["Taste check: none yet."]
    res = c.get("result") or {}
    out = [f"Taste check {c.get('id') or c.get('_id')}: {c.get('status')}"
           + (f", verdict {res.get('verdict')}" if res.get("verdict") else "")
           + f", started {_at(c.get('started_at'))}" + (f" - {c['error']}" if c.get("error") else "")]
    bad = [i for i in res.get("items") or [] if i.get("verdict") in ("fail", "unclear", "unchecked")]
    out += [f"  {i.get('verdict')}: [{i.get('strength')}] {i.get('text')} - {i.get('why') or ''}"[:300] for i in bad[:20]]
    return out


async def _mark(ctx: Ctx, d: dict, force: bool) -> tuple[str, dict]:
    """Mark applied as the card does: (what happened, vars). Writes through ctx.db, so it is kept for undo."""
    rid = d["_id"]
    need("PATCH", f"/api/revisions/{rid}")
    plain = chat_undo.inner(ctx.db)
    if d.get("status") == "applied":
        return "It is applied already: nothing changed.", {"marked": "already"}
    if not force:
        held = await taste_check.gate(plain, rid)
        if held:
            cur = held.get("check") or {}
            pal = ", ".join(p.get("name") or p.get("id") for p in held.get("palettes") or [])
            if cur.get("status") in taste_check.ACTIVE:
                return (f"Not marked: the Taste check ({pal}) is running - ask again when it is done.",
                        {"marked": "checking"})
            if cur.get("status") == "done" and (cur.get("result") or {}).get("verdict") != "pass":
                return ("Not marked: its Taste check did not pass:\n" + "\n".join(_check_lines(cur))
                        + "\nMark it anyway only if the person says so, with force.", {"marked": "held"})
            # No check yet, or it stopped: started, as the card's box starts it (a model reads the renders).
            need("POST", f"/api/revisions/{rid}/taste-check")
            got = await taste_check.start(plain, rid)
            if got is None:
                pass                                       # no palette applies any more: marked below
            else:
                return (f"Not marked yet: palettes apply to its project ({pal}), so its Taste check was started "
                        f"(check {got['_id']}) - ask again when it is done; it is marked once it passes.",
                        {"marked": "checking"})
    patch = await store.set_status(ctx.db, rid, "applied")
    if patch is None:
        raise ToolError(f"no note {rid}")
    await taste_check.decided(ctx.db, rid, force)
    await ctx.db.revisions.update_one({"_id": rid}, {"$set": {"status_by": actors.current()}})
    return ("Marked applied" + (" anyway, past its Taste check" if force else "") + "."
            + (" It was archived with it (the auto-archive setting)." if patch.get("archived") else ""),
            {"marked": "yes"})


async def run(ctx: Ctx, args: dict) -> Result:
    ref, about = str(args.get("note") or "").strip(), str(args.get("for") or "").strip()
    if ref.lower().startswith("latest for "):
        ref, about = "", ref[len("latest for "):].strip()
    action = str(args.get("action") or "read").strip().lower()
    if action not in ("read", "mark_applied"):
        raise ToolError("action is read or mark_applied")
    if about:
        d = await _latest_for(ctx.db, about)
    elif ref:
        d = await find(ctx.db, "revisions", ref, ("comment", "summary"), "queued note")
    else:
        raise ToolError("say which note (its id - queue_list lists them) or what it is about (for)")
    need("GET", f"/api/revisions/{d['_id']}")
    done, mv = "", {}
    if action == "mark_applied":
        done, mv = await _mark(ctx, d, bool(args.get("force")))
        d = await ctx.db.revisions.find_one({"_id": d["_id"]}) or d
    rid, r = d["_id"], room_of(d)
    run_ = await ctx.db.runs.find_one({"_id": rid})
    st = state(d, run_)
    title = " ".join((d.get("summary") or (d.get("comment") or "").strip().split("\n")[0]).split())[:80] or rid
    lines = [f"Note {rid} in the {NAME[r]} room, about {THING[r]} {d.get('model') or '-'}: {SAID.get(st, st)}"
             + (" (archived)" if d.get("archived") else ""), f"\"{title}\""]
    if done:
        lines.insert(0, done)
    lines.append("Written " + _at(d.get("created_at")) + (f" by {who(d.get('created_by'))}" if who(d.get("created_by")) else "")
                 + (f"; queued {_at(d['queued_at'])}" if d.get("queued_at") else "")
                 + (f"; applied {_at(d['applied_at'])}" if d.get("applied_at") else "")
                 + (f"; status set by {who(d.get('status_by'))}" if who(d.get("status_by")) else ""))
    if run_:
        pct = run_.get("percent")
        lines.append(f"Run: {run_.get('status')} \"{run_.get('title') or ''}\""
                     + (f", {round(pct)}%" if isinstance(pct, (int, float)) else "")
                     + f", {_at(run_.get('started_at'))}" + (f" to {_at(run_['finished_at'])}" if run_.get("finished_at") else "")
                     + (", worked on by " + ", ".join(who(h.get("by")) for h in run_.get("holders") or [] if who(h.get("by")))
                        if run_.get("holders") else "")
                     + (f"; taken over {len(run_['taken_over'])} time(s)" if run_.get("taken_over") else ""))
        band = await _band(ctx.db, r, run_)
        if band:
            lines.append(f"What the agent said while it worked ({len(band)} lines of the room's log):")
            lines += [f"  {_at(x.get('at'))[11:]} {x.get('level') or 'info'}: {str(x.get('text') or '')[:300]}" for x in band]
    else:
        lines.append("No run: no agent has worked on it.")
    if d.get("changes"):
        lines.append("Changed: " + ", ".join(f"{c.get('kind')} {c.get('id')} +{c.get('added') or 0}/-{c.get('removed') or 0}"
                                              for c in d["changes"]))
    tc = d.get("taste_check") or {}
    if tc:
        lines.append(f"Marked applied with Taste verdict {tc.get('verdict') or 'none'}" + (" (forced)" if tc.get("forced") else ""))
    elif st in ("review", "queued", "working") and not mv:
        cur = await taste_check.latest(chat_undo.inner(ctx.db), rid)
        if cur:
            lines += _check_lines(taste_check.out(cur))
    v = {"title": title, "note": rid, "room": r, "state": st, "model": d.get("model") or "",
         "at": _at(d.get("applied_at") or d.get("queued_at") or d.get("created_at")), **mv}
    if run_:
        v.update(run=run_.get("status") or "", started=_at(run_.get("started_at")), finished=_at(run_.get("finished_at")))
    say = {"yes": "Marked {title} applied", "held": "{title}: Taste check did not pass",
           "checking": "{title}: Taste check running"}.get(mv.get("marked", ""), SAY.get(st, "Note {title}: {state}"))
    return Result(text=clip("\n".join(lines)), say=say, vars=v,
                  summary=f"{rid} · {NAME[r]} · {SAID.get(st, st)}" + (f" · {mv['marked']}" if mv else ""))


TOOL = Tool(
    name="note_status", package="general", level="change", order=74, default=True,
    asks=lambda a: str(a.get("action") or "").strip().lower() == "mark_applied",
    label="Note status",
    about="Where a room's note stands - status, run, what the agent did - and Mark applied, after asking.",
    description="Where one note of the 3D, PCB or Firmware room stands, as its card shows it: status (draft, queued, "
                "working, done and waiting for review, failed, applied, rejected), when it was written, queued and "
                "applied, its run (who, how far, from when to when) and what the agent said while it worked (the "
                "room's log over the run), its Taste check. `note` is its id (queue_list lists them) or words of "
                "it; `for` gives the newest note about a model, board or firmware instead. action=mark_applied does "
                "the card's Mark applied - the person is asked first; where Taste palettes apply it is marked only "
                "after its check passed (the check is started, or its failures said - `force` marks anyway, only "
                "when the person says so). Use mark_applied only when asked. Undoable.",
    schema={"type": "object", "properties": {
        "note": {"type": "string", "description": "The note's id, or words of it"},
        "for": {"type": "string", "description": "Or: a model, board or firmware id - its newest note"},
        "action": {"type": "string", "enum": ["read", "mark_applied"], "description": "read (default) or mark_applied"},
        "force": {"type": "boolean", "description": "Mark applied past a Taste check that did not pass"}}},
    running="Reading a note's status", failed="Could not read the note's status",
    run=run)
