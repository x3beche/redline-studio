"""Themes people make: a built-in theme with some of its colours changed.

A custom theme names a base (one of the themes in styles.css), says
whether it is drawn on a light ground, and overrides some tokens. The page
wears the base and then sets the overridden tokens on the root element, so
whatever is not overridden comes from the base - a custom theme can never
leave an element unstyled.

They belong to the workspace (backend/scope.py), so teammates can wear
each other's, and say who made them. Anyone who may look at the workspace
may make one; changing or deleting one is its maker's, or an owner's or
admin's.
"""

from __future__ import annotations

import re
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import access, actors

COLL = "themes"
MAX_PER_WORKSPACE = 200
NAME_MAX = 40

# Every token a theme defines (the default block of styles.css; a test
# keeps the two the same). A custom theme may override any of them.
TOKENS = frozenset({
    "--surface", "--surface-2", "--hover", "--pressed", "--line",
    "--ink", "--ink-dim", "--ink-bright", "--ink-on-accent", "--ink-on-warn",
    "--accent", "--accent-deep", "--warn", "--danger", "--ok", "--ink-on-ok",
    "--pen", "--pen-wash",
    "--scrim", "--shade", "--shadow-soft", "--shadow-hard",
    "--view-top", "--view-mid", "--view-bottom", "--draw-label", "--shot-bg", "--pcb-bg",
    "--switch-knob", "--overlay", "--overlay-rest", "--tooltip-bg",
    "--scroll-thumb", "--scroll-hover", "--scroll-active",
    "--chart-work", "--chart-build", "--chart-progress", "--chart-reply",
    "--chart-summary", "--chart-translate", "--chart-other",
    "--code-kw", "--code-str", "--code-num", "--code-com", "--code-fn", "--code-type",
    *(f"--series-{i}" for i in range(1, 9)),
})

HEX = re.compile(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})")
RGB = re.compile(r"rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)")
BASE = re.compile(r"[a-z0-9-]{1,40}")


def colour_ok(v: str) -> bool:
    """#rgb, #rrggbb, #rrggbbaa, or rgb()/rgba() with numbers in range."""
    if not isinstance(v, str) or len(v) > 40:
        return False
    v = v.strip()
    if HEX.fullmatch(v):
        return True
    m = RGB.fullmatch(v)
    if not m:
        return False
    if any(int(m.group(i)) > 255 for i in (1, 2, 3)):
        return False
    return m.group(4) is None or float(m.group(4)) <= 1


def clean(name: str, base: str, light: bool, vars: dict) -> dict:
    """The theme as it is kept, or a ValueError saying what is wrong."""
    name = (name or "").strip()
    if not name:
        raise ValueError("a theme needs a name")
    if len(name) > NAME_MAX:
        raise ValueError(f"a theme's name is at most {NAME_MAX} characters")
    if not BASE.fullmatch(base or ""):
        raise ValueError("unknown base theme")
    if not isinstance(vars, dict) or not vars:
        raise ValueError("a theme changes at least one colour")
    unknown = sorted(k for k in vars if k not in TOKENS)
    if unknown:
        raise ValueError(f"unknown token: {', '.join(unknown[:5])}")
    bad = sorted(k for k, v in vars.items() if not colour_ok(v))
    if bad:
        raise ValueError(f"not a colour (#rgb, #rrggbb, #rrggbbaa or rgba()): {', '.join(bad[:5])}")
    return {"name": name, "base": base, "light": bool(light),
            "vars": {k: v.strip() for k, v in sorted(vars.items())}}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db():
    from .main import db
    return db()


def _may_change(doc: dict) -> bool:
    """Its maker, or someone who runs the workspace."""
    mine = (doc.get("by") or {}).get("id") == actors.current().get("id")
    return mine or access.rank(access.current() or "viewer") <= access.rank("admin")


def _out(doc: dict) -> dict:
    return {"id": doc["_id"], "name": doc["name"], "base": doc["base"], "light": doc.get("light", False),
            "vars": doc.get("vars") or {}, "by": doc.get("by"), "created_at": doc.get("created_at"),
            "updated_at": doc.get("updated_at"),
            "mine": (doc.get("by") or {}).get("id") == actors.current().get("id"),
            "can_edit": _may_change(doc)}


class ThemeIn(BaseModel):
    name: str = Field(max_length=200)
    base: str = Field(max_length=60)
    light: bool = False
    vars: dict[str, str]


router = APIRouter(prefix="/api/themes")


@router.get("")
async def listing() -> list[dict]:
    rows = [d async for d in _db()[COLL].find({}).sort("created_at", 1).limit(MAX_PER_WORKSPACE)]
    return [_out(d) for d in rows]


@router.post("")
async def create(body: ThemeIn) -> dict:
    try:
        doc = clean(body.name, body.base, body.light, body.vars)
    except ValueError as e:
        raise HTTPException(422, str(e))
    d = _db()
    if await d[COLL].count_documents({}) >= MAX_PER_WORKSPACE:
        raise HTTPException(409, f"this workspace already has {MAX_PER_WORKSPACE} themes")
    now = _now()
    who = actors.current()
    doc = {"_id": secrets.token_hex(6), **doc, "by": {k: who.get(k) for k in ("type", "id", "name")},
           "created_at": now, "updated_at": now}
    await d[COLL].insert_one(doc)
    return _out(doc)


async def _mine(tid: str) -> dict:
    doc = await _db()[COLL].find_one({"_id": tid})
    if not doc:
        raise HTTPException(404, "no such theme")
    if not _may_change(doc):
        raise HTTPException(403, "only its maker, an owner or an admin can change this theme")
    return doc


@router.put("/{tid}")
async def update(tid: str, body: ThemeIn) -> dict:
    doc = await _mine(tid)
    try:
        patch = clean(body.name, body.base, body.light, body.vars)
    except ValueError as e:
        raise HTTPException(422, str(e))
    patch["updated_at"] = _now()
    await _db()[COLL].update_one({"_id": tid}, {"$set": patch})
    return _out({**doc, **patch})


@router.delete("/{tid}")
async def remove(tid: str) -> dict:
    await _mine(tid)
    await _db()[COLL].delete_one({"_id": tid})
    return {"ok": True}
