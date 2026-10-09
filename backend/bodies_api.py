"""The routes of a part's 3D bodies and a board's choice of them
(backend/bodies.py).

Binding, unbinding, the default and a board's choice change the design
("edit", backend/access.py); asking the 3D room for a body queues a note
("run"). Every change is in the audit trail with who made it.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import actors, bodies

router = APIRouter()


def _db():
    from .main import db
    return db()


async def _say(text: str, level: str = "info", room: str = "pcb") -> None:
    from .main import say
    try:
        await say(text, level, room=room)
    except Exception:                                   # noqa: BLE001 - the log is a nicety
        pass


def _refused(exc: bodies.BodyError) -> HTTPException:
    return HTTPException(exc.status, str(exc))


def _queued(out: dict) -> str:
    q = out.get("queued") or []
    return f" - redrawing {', '.join(q)}" if q else ""


class BindIn(BaseModel):
    model: str = Field(min_length=1, max_length=300)
    name: str = Field(min_length=1, max_length=bodies.NAME_MAX * 2)
    default: bool = False


class DefaultIn(BaseModel):
    variant: str = Field(min_length=1, max_length=100)


class ChooseIn(BaseModel):
    variant: str | None = Field(default=None, max_length=100)    # None / "default": the part's


class RequestIn(BaseModel):
    name: str = Field(min_length=1, max_length=bodies.NAME_MAX * 2)
    why: str = Field(min_length=1, max_length=bodies.WHY_MAX)
    board: str | None = Field(default=None, max_length=200)
    ref: str | None = Field(default=None, max_length=40)


@router.get("/api/parts/{lcsc_id}/bodies")
async def part_bodies(lcsc_id: str):
    """The part's 3D bodies: LCSC's, and the drawn ones, the default marked."""
    return await bodies.listing(_db(), lcsc_id.strip().upper())


@router.get("/api/parts/{lcsc_id}/body-spec")
async def part_body_spec(lcsc_id: str):
    """What a body for the part is drawn against: the footprint's pads and
    outlines in the component frame, pin 1, LCSC's body's box."""
    try:
        return await bodies.spec(_db(), lcsc_id.strip().upper())
    except bodies.BodyError as exc:
        raise _refused(exc)


@router.post("/api/parts/{lcsc_id}/bodies")
async def bind_body(lcsc_id: str, body: BindIn):
    """Bind a built model of the 3D room to the part as a body of its own."""
    d = _db()
    try:
        out = await bodies.bind(d, lcsc_id, body.model, body.name, body.default)
    except bodies.BodyError as exc:
        raise _refused(exc)
    b = out["body"]
    await actors.audit(d, "body-bind", f"part {out['lcsc']}",
                       {"body": b["slug"], "model": b["model"], "default": body.default})
    await _say(f"{out['lcsc']}: 3D body \"{b['name']}\" bound - {b['model']}"
               + (" (the part's default now)" if body.default else "") + _queued(out))
    return out


@router.put("/api/parts/{lcsc_id}/bodies/default")
async def default_body(lcsc_id: str, body: DefaultIn):
    """Which body the part wears on every board that does not choose."""
    d = _db()
    part = lcsc_id.strip().upper()
    try:
        out = await bodies.set_default(d, part, body.variant)
    except bodies.BodyError as exc:
        raise _refused(exc)
    if out["changed"]:
        await actors.audit(d, "body-default", f"part {part}", {"default": out["default"]})
        await _say(f"{part}: default 3D body is {out['default']}" + _queued(out))
    return out


@router.delete("/api/parts/{lcsc_id}/bodies/{variant}")
async def unbind_body(lcsc_id: str, variant: str, force: bool = False):
    """Take a drawn body off the part (the model stays in the 3D room).
    409 while a board chooses it; `force=1` sends those boards back to
    the part's default."""
    d = _db()
    part = lcsc_id.strip().upper()
    try:
        out = await bodies.unbind(d, part, variant, force)
    except bodies.BodyError as exc:
        raise _refused(exc)
    await actors.audit(d, "body-unbind", f"part {part}",
                       {"body": out["unbound"]["slug"], "model": out["unbound"]["model"],
                        "cleared": out["cleared"]})
    await _say(f"{part}: 3D body \"{out['unbound']['name']}\" unbound"
               + (f", {', '.join(out['cleared'])} back to the default" if out["cleared"] else "")
               + _queued(out))
    return out


@router.post("/api/parts/{lcsc_id}/body-request")
async def request_body(lcsc_id: str, body: RequestIn):
    """Ask the 3D room for a body: a note in its queue with the footprint,
    the frame, the name and where the model goes - queued at once."""
    d = _db()
    try:
        out = await bodies.request(d, lcsc_id, body.name, body.why, body.board, body.ref)
    except bodies.BodyError as exc:
        raise _refused(exc)
    await _say(f"{out['part']}: asked the 3D room for a body \"{out['name']}\" -> {out['model']}"
               + (f" (for {out['board']} {out['ref']})" if out.get("board") else ""))
    await _say(f"queued: a 3D body \"{out['name']}\" for {out['part']}, as {out['model']} "
               "(asked from the PCB room)", "info", room="cad")
    return out


@router.get("/api/boards/{bid}/bodies")
async def board_bodies(bid: str):
    """Each reference whose part has more than one body: what it may wear,
    what this board chose, what it wears, what its 3D was drawn with."""
    try:
        return await bodies.board_listing(_db(), bid)
    except bodies.BodyError as exc:
        raise _refused(exc)


@router.put("/api/boards/{bid}/bodies/{ref}")
async def choose_body(bid: str, ref: str, body: ChooseIn):
    """The body one reference wears on this board - one of its part's,
    `lcsc` for LCSC's, `default` (or nothing) for the part's default."""
    d = _db()
    try:
        out = await bodies.choose(d, bid, ref, body.variant)
    except bodies.BodyError as exc:
        raise _refused(exc)
    if out["changed"]:
        await actors.audit(d, "body-choose", f"board {bid}",
                           {"ref": ref, "part": out["part"], "variant": out["chosen"] or "default"})
        await _say(f"{bid}: {ref} ({out['part']}) wears "
                   + (f"\"{out['wears']}\"" if out["chosen"] else f"its part's default ({out['wears']})")
                   + _queued(out))
    return out
