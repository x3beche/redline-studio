"""A model's technical drawing laid out by hand: its layout spec.

Without one, tools/techdraw.py lays the sheet out by itself (the largest
standard scale that fits; FRONT, RIGHT beside it, TOP under it, the
isometric view in the rest; A4 if it goes on it at 1:1, else A3). With
one, the 3D room's layout editor (frontend/src/app/editor/drawing-layout.ts)
or an agent (chat tool `drawing_layout`) has said:

    {"sheet": {"size": "auto" | "A4" | "A3", "orientation": "landscape" | "portrait"},
     "views": [{"view": "front" | "back" | "top" | "bottom" | "left" | "right" | "iso",
                "x": .., "y": .., "w": .., "h": ..,      # fractions of the sheet, from its top left
                "scale": "auto" | "fit" | "fill" | "1:1" | "2:1" | ..,
                                                  # auto: one scale the auto boxes share; fit: the largest
                                                  # standard one for this box alone; fill: the largest
                                                  # ratio to a tenth that fills the box ("1.7:1"); or any
                                                  # ratio written ("1:2.5")
                "hidden_lines": bool, "dims": bool}],
     "parts": {"hide": [part names], "highlight": [part names]},
     "title": str | None, "notes": str | None}

Kept on the model's own document (`models.drawing_layout`: the spec, a
version that goes up by one with each save, when and by whom) - in its
workspace like the model, and kept over a source save (store.save_model).
`names` beside it are the model's part names in order as the page knew
them, for a flat model whose STEP names no part (not part of the spec:
they change only with a build, which is a new STEP anyway).

The drawing is kept by its STEP's fingerprint and this spec's (`digest`),
so a changed layout is a new drawing, and the old one is still there to go
back to.

Saving is changing the model ("edit", backend/access.py: the PUT falls to
the default); reading it is looking.
"""

from __future__ import annotations

import re

import hashlib
import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import actors

VIEWS = ("front", "back", "top", "bottom", "left", "right", "iso")
SIZES = ("auto", "A4", "A3")
ORIENTATIONS = ("landscape", "portrait")
# The standard scales (techdraw.py SCALES), as written on the sheet.
SCALES = ("10:1", "5:1", "2:1", "1:1", "1:2", "1:5", "1:10", "1:20", "1:50", "1:100")
MAX_VIEWS = 8
MAX_PARTS = 300
MIN_SIDE = 0.05                      # a box at least this much of the sheet each way



def _trim(n: str) -> str:
    """"1.70" as "1.7", "2.0" as "2"."""
    return f"{float(n):g}"

class LayoutError(ValueError):
    """What is wrong with a spec, said plainly (to the page or the agent)."""


def _num(v, what: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise LayoutError(f"{what} must be a number between 0 and 1")
    v = float(v)
    if not 0 <= v <= 1:
        raise LayoutError(f"{what} must be between 0 and 1 (a fraction of the sheet)")
    return round(v, 4)


def _names(v, what: str) -> list[str]:
    if v is None:
        return []
    if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
        raise LayoutError(f"{what} must be a list of part names")
    out = list(dict.fromkeys(x.strip()[:160] for x in v if x.strip()))
    if len(out) > MAX_PARTS:
        raise LayoutError(f"{what}: at most {MAX_PARTS} names")
    return out


def _text(v, what: str, n: int) -> str | None:
    if v is None or v == "":
        return None
    if not isinstance(v, str):
        raise LayoutError(f"{what} must be text")
    v = " ".join(v.split())
    if len(v) > n:
        raise LayoutError(f"{what}: at most {n} characters")
    return v or None


def validate(spec) -> dict:
    """The spec as kept: every field there, in its own form; a LayoutError
    saying what is wrong otherwise."""
    if not isinstance(spec, dict):
        raise LayoutError("the layout must be an object")
    unknown = set(spec) - {"sheet", "views", "parts", "title", "notes"}
    if unknown:
        raise LayoutError(f"unknown field {sorted(unknown)[0]!r}; the fields are sheet, views, parts, title, notes")
    sheet = spec.get("sheet") or {}
    if not isinstance(sheet, dict):
        raise LayoutError("sheet must be {size, orientation}")
    size = sheet.get("size", "auto")
    if size not in SIZES:
        raise LayoutError(f"sheet size must be one of {', '.join(SIZES)}")
    orient = sheet.get("orientation", "landscape")
    if orient not in ORIENTATIONS:
        raise LayoutError("sheet orientation must be landscape or portrait")
    views = spec.get("views")
    if not isinstance(views, list) or not views:
        raise LayoutError("views must be a list of at least one view box")
    if len(views) > MAX_VIEWS:
        raise LayoutError(f"at most {MAX_VIEWS} views on a sheet")
    boxes = []
    for i, b in enumerate(views, 1):
        if not isinstance(b, dict):
            raise LayoutError(f"view {i} must be an object")
        view = b.get("view")
        if view not in VIEWS:
            raise LayoutError(f"view {i}: view must be one of {', '.join(VIEWS)}")
        x, y, w, h = (_num(b.get(k), f"view {i} {k}") for k in ("x", "y", "w", "h"))
        if w < MIN_SIDE or h < MIN_SIDE:
            raise LayoutError(f"view {i}: a box is at least {MIN_SIDE} of the sheet each way")
        if x + w > 1.0001 or y + h > 1.0001:
            raise LayoutError(f"view {i}: the box goes off the sheet (x + w and y + h must be at most 1)")
        scale = str(b.get("scale") or "auto").replace(" ", "").replace(",", ".")
        if scale not in ("auto", "fit", "fill") and scale not in SCALES:
            # Any scale written as a ratio ("1.7:1", "1:2.5"): kept as written, within reason.
            m = re.fullmatch(r"(\d{1,4}(?:\.\d{1,2})?):(\d{1,4}(?:\.\d{1,2})?)", scale)
            if not m or not (0.01 <= float(m[1]) / max(float(m[2]), 1e-9) <= 100) or float(m[2]) == 0:
                raise LayoutError(f"view {i}: scale must be auto, fit, fill, a ratio like 1.7:1, "
                                  f"or one of {', '.join(SCALES)}")
            scale = f"{_trim(m[1])}:{_trim(m[2])}"
        hidden, dims = b.get("hidden_lines", view != "iso"), b.get("dims", view != "iso")
        if not isinstance(hidden, bool) or not isinstance(dims, bool):
            raise LayoutError(f"view {i}: hidden_lines and dims are true or false")
        boxes.append({"view": view, "x": x, "y": y, "w": w, "h": h, "scale": scale,
                      "hidden_lines": hidden, "dims": dims and view != "iso"})
    parts = spec.get("parts") or {}
    if not isinstance(parts, dict) or set(parts) - {"hide", "highlight"}:
        raise LayoutError("parts must be {hide: [names], highlight: [names]}")
    return {"sheet": {"size": size, "orientation": orient}, "views": boxes,
            "parts": {"hide": _names(parts.get("hide"), "parts.hide"),
                      "highlight": _names(parts.get("highlight"), "parts.highlight")},
            "title": _text(spec.get("title"), "title", 120), "notes": _text(spec.get("notes"), "notes", 300)}


def digest(spec: dict | None) -> str:
    """The spec's fingerprint, in the kept drawing's name ("" without one)."""
    if not spec:
        return ""
    return hashlib.sha256(json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:12]


def for_drawing(layout: dict | None) -> dict | None:
    """What tools/techdraw.py --spec reads: the spec, with the part names a
    flat model's STEP lacks."""
    spec = (layout or {}).get("spec")
    if not spec:
        return None
    return {**spec, "parts": {**spec.get("parts", {}), "names": (layout or {}).get("names") or []}}


def _out(model_id: str, layout: dict | None) -> dict:
    layout = layout or {}
    return {"id": model_id, "spec": layout.get("spec"), "version": layout.get("version", 0),
            "updated_at": layout.get("updated_at"), "by": layout.get("by"), "names": layout.get("names") or [],
            "key": digest(layout.get("spec"))}


async def read(db, model_id: str) -> dict:
    """The model's layout (spec None: the automatic one). KeyError if no model."""
    doc = await db.models.find_one({"_id": model_id}, {"drawing_layout": 1})
    if not doc:
        raise KeyError(model_id)
    return _out(model_id, doc.get("drawing_layout"))


class Stale(Exception):
    """Saved by someone else since the version the change was made on."""


async def write(db, model_id: str, spec, *, version: int | None = None, names=None, actor: dict | None = None) -> dict:
    """Save the model's layout (None: back to the automatic one). With
    `version`, only over that one (Stale otherwise). `names` None keeps
    the ones kept."""
    doc = await db.models.find_one({"_id": model_id}, {"drawing_layout": 1})
    if not doc:
        raise KeyError(model_id)
    now = doc.get("drawing_layout") or {}
    if version is not None and version != now.get("version", 0):
        raise Stale(now.get("version", 0))
    clean = validate(spec) if spec is not None else None
    kept_names = now.get("names") or []
    if names is not None:
        if not isinstance(names, list) or not all(isinstance(x, str) for x in names):
            raise LayoutError("names must be a list of part names")
        kept_names = [x[:160] for x in names[:2000]]
    who = actor or {}
    layout = {"spec": clean, "version": now.get("version", 0) + 1,
              "updated_at": datetime.now(timezone.utc).isoformat(),
              "by": {"id": who.get("id"), "name": who.get("name")}, "names": kept_names}
    q = {"_id": model_id}
    q["drawing_layout.version" if now else "drawing_layout"] = now.get("version") if now else {"$exists": False}
    res = await db.models.update_one(q, {"$set": {"drawing_layout": layout}})
    if not getattr(res, "matched_count", 1):
        raise Stale(now.get("version", 0))
    return _out(model_id, layout)


# ---------------------------------------------------------------- routes

router = APIRouter()


def _db():
    from .main import db
    return db()


class LayoutIn(BaseModel):
    spec: dict | None = None
    # The version the change was made on: a 409 if someone saved since.
    version: int | None = None
    names: list[str] | None = None


@router.get("/api/models/{model_id:path}/drawing/layout")
async def layout_get(model_id: str):
    """The model's drawing layout; spec null means the automatic one."""
    try:
        return await read(_db(), model_id)
    except KeyError as exc:
        raise HTTPException(404, model_id) from exc


@router.put("/api/models/{model_id:path}/drawing/layout")
async def layout_put(model_id: str, body: LayoutIn):
    """Save the model's drawing layout (spec null: back to automatic). The
    drawing is not made here: POST .../drawing makes it with this layout."""
    try:
        out = await write(_db(), model_id, body.spec, version=body.version, names=body.names,
                          actor=actors.current())
    except KeyError as exc:
        raise HTTPException(404, model_id) from exc
    except LayoutError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Stale as exc:
        raise HTTPException(409, f"the layout was saved by someone else since (now version {exc.args[0]}) - "
                                 "open it again") from exc
    await actors.audit(_db(), "edit", f"drawing layout {model_id}",
                       {"layout": "automatic" if body.spec is None else f"v{out['version']}"})
    return out

