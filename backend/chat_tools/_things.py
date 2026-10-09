"""What the workspace tools share: a thing named by its id - or by words of
its id or title, the way a person says "the base model" - read through the
asker's workspace (ctx.db is backend/scope.py's ScopedDb), and a short
list of what there is when the name fits nothing."""

from __future__ import annotations

import re

from . import ToolError

SHOW = 40                  # things a list names


def _words(text: str) -> list[str]:
    return [w for w in re.split(r"[\s/_.\-]+", text.lower()) if w]


def _hay(row: dict, fields: tuple[str, ...]) -> str:
    return " ".join(str(row.get(f) or "") for f in ("_id", *fields)).lower().replace("_", " ").replace("-", " ")


async def rows(db, coll: str, fields: tuple[str, ...], sort: str = "_id") -> list[dict]:
    proj = {f: 1 for f in fields}
    return [d async for d in db[coll].find({}, proj or None).sort(sort, 1)]


async def find(db, coll: str, ref: str, fields: tuple[str, ...], what: str) -> dict:
    """The one row `ref` names: by id, else the only one whose id and
    `fields` hold every word of it. Several or none: a ToolError naming
    the ids, so the model can ask again with one of them."""
    ref = str(ref or "").strip()
    doc = await db[coll].find_one({"_id": ref}) if ref else None
    if doc:
        return doc
    every = await rows(db, coll, fields)
    words = [w.replace("_", " ").replace("-", " ") for w in _words(ref)]
    hits = [r for r in every if words and all(w in _hay(r, fields) for w in words)]
    # Words the person added that the name does not hold ("model", "board"):
    # try again with the ones that do appear somewhere.
    if not hits and words:
        known = [w for w in words if any(w in _hay(r, fields) for r in every)]
        if known:
            hits = [r for r in every if all(w in _hay(r, fields) for w in known)]
    if len(hits) > 1:
        # "base" names iot-fan/assemblies/base, not iot-fan/parts/case_base:
        # a word that is a whole name (the id's last part, or the title) wins.
        whole = [r for r in hits if any(w in (_last(r), label(r, fields).lower()) for w in words)]
        hits = whole if len(whole) == 1 else hits
    if len(hits) == 1:
        return await db[coll].find_one({"_id": hits[0]["_id"]}) or hits[0]
    pool = hits or every
    names = ", ".join(f"{r['_id']}" + (f" ({label(r, fields)})" if label(r, fields) != r["_id"] else "")
                      for r in pool[:SHOW])
    if hits:
        raise ToolError(f"{len(hits)} {what}s match {ref!r}: {names}. Ask again with one id.")
    if not every:
        raise ToolError(f"there is no {what} in this workspace")
    raise ToolError(f"no {what} {ref!r} in this workspace. There are: {names}"
                    + (f" (and {len(every) - SHOW} more)" if len(every) > SHOW else ""))


def _last(row: dict) -> str:
    return str(row["_id"]).rsplit("/", 1)[-1].lower().replace("_", " ").replace("-", " ")


def label(row: dict, fields: tuple[str, ...]) -> str:
    for f in fields:
        if row.get(f) and isinstance(row[f], str):
            return row[f]
    return str(row["_id"])
