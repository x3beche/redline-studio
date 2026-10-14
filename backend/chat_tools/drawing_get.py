"""drawing_get: "is the lid's drawing ready?" - a 3D model's technical
drawing as the 3D room's Model tab shows it (release.drawing_status: made
when, its size, the sheet, its scale and views; or none yet, failed, no
STEP to draw from), with its PDF and its preview, and the model's place in
the app (app_links); `make_now` presses the tab's Make now (Make again when
it is made) and answers at once.

The drawing is made as the tab's Make now makes it - release.model_drawing,
the drawing container - but by a process of its own (`_drawing_job.py`):
this tool runs in the answer's runner, which ends with the answer, long
before a drawing does. Making it is not undone (it is drawn again from the
STEP; nothing written changes), and it asks first: it takes minutes of the
machine.

What the API keeps in its own memory - a drawing the room is making right
now, the one it makes by itself a while after a build - is not seen from
here: the files on disk (made, and the Chat's own making) are."""

from __future__ import annotations

from .. import app_links, chat_undo, release
from . import Ctx, Result, Tool, ToolError, size
from . import _drawing_job as job
from ._rights import need
from ._things import find

SAYS = {"ready": "Drawing of {title}: made", "making": "Drawing of {title}: being made",
        "failed": "Drawing of {title}: failed", "no_step": "{title} has no STEP to draw from"}
SAID = {"no_step": "no STEP to draw from", "none": "not made yet", "scheduled": "made by itself after the build",
        "queued": "waiting its turn", "making": "being made", "ready": "made", "failed": "failed"}


def pdf_url(mid: str) -> str:
    return f"/api/models/{app_links.segs(mid)}/drawing.pdf"


async def run(ctx: Ctx, args: dict) -> Result:
    ref = str(args.get("model") or "").strip()
    if not ref:
        raise ToolError("say which 3D model's drawing (its id or title words - model_read lists them)")
    d = await find(ctx.db, "models", ref, ("title", "name"), "3D model")
    mid, title = d["_id"], d.get("title") or d.get("name") or d["_id"]
    db = chat_undo.inner(ctx.db)
    need("GET", f"/api/models/{mid}/drawing/status")
    st = await release.drawing_status(db, mid)
    key = st.get("key") or ""
    started = ""
    if args.get("make_now"):
        need("POST", f"/api/models/{mid}/drawing")
        if st["state"] == "no_step":
            raise ToolError(f"{title} has no STEP to draw from - its script does not export one")
        if d.get("building"):
            raise ToolError(f"{title} is being built right now - make its drawing once the build is done")
        if key and job.running(key):
            started = "already"
        else:
            await job.spawn(getattr(db, "workspace", "default"), mid, again=bool(st.get("made")))
            started = "again" if st.get("made") else "now"
    mine = job.running(key) if key else None
    state = "making" if mine else st["state"]
    made = st.get("made") or {}
    v = {"title": title, "model": mid, "state": state, "key": key}
    lines = [f"Technical drawing of {title} ({mid}): {SAID.get(state, state)}."]
    if started == "already":
        lines.append("Make now was not pressed again: the Chat's making of it is still under way.")
    elif started:
        lines.append(("Making it again" if started == "again" else "Making it now")
                     + " in the background (minutes for a large model); ask again for how far it is.")
    if mine and not started:
        lines.append(f"The Chat started making it at {mine.get('started_at')}; it is still under way.")
    if made:
        v.update(made=str(made.get("at") or "")[:16].replace("T", " "), pdf=1, pdf_bytes=made.get("pdf_bytes") or 0,
                 preview=1 if made.get("preview") else 0, sheet=str(made.get("sheet") or ""),
                 scale=str(made.get("scale") or ""), views=len(made.get("views") or []))
        lines.append(f"Made {made.get('at')}, PDF {size(made.get('pdf_bytes') or 0)}"
                     + (f", sheet {made['sheet']}" if made.get("sheet") else "")
                     + (f", scale {made['scale']}" if made.get("scale") else "")
                     + (f", {len(made['views'])} views" if made.get("views") else "")
                     + (f", {len(made['parts'])} parts listed" if isinstance(made.get("parts"), list) else "")
                     + f". PDF: {pdf_url(mid)}"
                     + (f"  Preview: {pdf_url(mid)[:-4]}.png?k={key}" if made.get("preview") else ""))
        if st.get("built", {}).get("at") and made.get("at") and str(made["at"]) < str(st["built"]["at"]):
            lines.append("The model was built after this drawing was made, from the same STEP.")
    lay = st.get("layout") or {}
    if lay.get("custom"):
        lines.append(f"It uses the model's own sheet layout (v{lay.get('version')}); drawing_layout reads it.")
    gone = st.get("failed") or (job.failed(key) if key and not made and not mine else None)
    if gone:
        v["error"] = str(gone.get("reason") or "")[:80]
        lines.append(f"The last attempt failed{(' at ' + str(gone.get('at'))) if gone.get('at') else ''}: "
                     f"{gone.get('reason')}")
    if state == "no_step":
        lines.append("Its script exports no STEP, so there is nothing to draw from.")
    lines.append(f"In the app: {app_links.model(mid)} (the 3D room's Model tab, Technical drawing).")
    say = ("Started the drawing of {title}" if started in ("now", "again")
           else SAYS.get(state, "Drawing of {title}: not made yet"))
    summary = SAID.get(state, state) + (f" · {made.get('sheet')}" if made.get("sheet") else "") \
        + (f" · {size(made.get('pdf_bytes') or 0)}" if made else "") + (" · started" if started in ("now", "again") else "")
    return Result(text="\n".join(lines), say=say, vars=v, summary=summary)


TOOL = Tool(
    name="drawing_get", package="cad", level="change", order=34, default=True,
    asks=lambda a: bool(a.get("make_now")),
    undo="a drawing is drawn again from the model's STEP and changes nothing written - there is nothing to undo",
    label="Technical drawing",
    about="Says where a 3D model's technical drawing is, links its PDF, and can press Make now.",
    description="A 3D model's technical drawing as the 3D room's Model tab shows it: made (when, the sheet, its "
                "scale and views, the PDF's size), not made yet, failed (why) or no STEP to draw from - with the "
                "PDF's link, its preview and the model's place in the app. The page shows the drawing under the "
                "step; give the PDF link when the person wants it. `make_now` presses Make now (Make again when it "
                "is made): it runs in the background for minutes and the answer comes at once - the person is "
                "asked first. Use make_now only when asked to make the drawing.",
    schema={"type": "object", "properties": {
        "model": {"type": "string", "description": "The 3D model's id or title words"},
        "make_now": {"type": "boolean", "description": "Start making the drawing (asks the person first)"}},
        "required": ["model"]},
    running="Reading the technical drawing", failed="Could not read the technical drawing",
    run=run)
