"""What a note changed: the sources before an agent worked it and after.

When an agent starts on a note, every model's and board's source in the
note's project is fingerprinted, and the text of each is kept once, by its
fingerprint (`source_blobs`). When it finishes, the same again; the files
whose text changed are written on the note as `changes` - which file, the
two fingerprints, the lines added and removed - for good. The page shows
them side by side (rooms/changes.ts), with the before and after pictures.

Both the command line (tools/revisions.py start/finish) and the API's
run routes call this; either transport, the same record.
"""

from __future__ import annotations

import difflib
import hashlib
from datetime import datetime, timezone

BLOBS = "source_blobs"
BOARDS = "boards"


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def project_of(db, rev: dict) -> str | None:
    """The project a note is in: the top folder of its model or board."""
    item = rev.get("model")
    if not item:
        return None
    if rev.get("kind") == "pcb":
        b = await db[BOARDS].find_one({"_id": item}, {"folder": 1})
        return ((b or {}).get("folder") or item).split("/")[0]
    return item.split("/")[0]


async def snapshot(db, project: str | None) -> dict:
    """Every model's and board's source in the project, by fingerprint;
    the texts kept once each."""
    import re
    out: dict[str, str] = {}
    mq = {"_id": {"$regex": "^" + re.escape(project) + "/"}} if project else {}
    bq = {"folder": {"$regex": "^" + re.escape(project) + "(/|$)"}} if project else {}
    texts: dict[str, str] = {}
    async for m in db.models.find(mq, {"source": 1}):
        if m.get("source"):
            sha = _sha(m["source"])
            out[f"model:{m['_id']}"] = sha
            texts[sha] = m["source"]
    async for b in db[BOARDS].find(bq, {"source": 1}):
        if b.get("source"):
            sha = _sha(b["source"])
            out[f"board:{b['_id']}"] = sha
            texts[sha] = b["source"]
    if texts:
        have = set(await db[BLOBS].distinct("_id", {"_id": {"$in": list(texts)}}))
        new = [{"_id": s, "text": t} for s, t in texts.items() if s not in have]
        if new:
            try:
                await db[BLOBS].insert_many(new)
            except Exception:                     # a race with another writer: the text is there
                pass
    return out


async def started(db, rev_id: str) -> None:
    """Called when an agent starts on a note: the sources as they are."""
    rev = await db.revisions.find_one({"_id": rev_id}, {"model": 1, "kind": 1})
    if not rev:
        return
    base = await snapshot(db, await project_of(db, rev))
    await db.revisions.update_one({"_id": rev_id}, {"$set": {"changes_base": base, "changes_base_at": _now()}})


def _counts(before: str, after: str) -> tuple[int, int]:
    added = removed = 0
    for line in difflib.unified_diff(before.splitlines(), after.splitlines(), lineterm="", n=0):
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed += 1
    return added, removed


async def finished(db, rev_id: str) -> list[dict]:
    """Called when the agent finishes: what changed since it started, kept
    on the note."""
    rev = await db.revisions.find_one({"_id": rev_id}, {"model": 1, "kind": 1, "changes_base": 1})
    if not rev or rev.get("changes_base") is None:
        return []
    base: dict = rev["changes_base"]
    after = await snapshot(db, await project_of(db, rev))
    changed = []
    for key in sorted(set(base) | set(after)):
        b, a = base.get(key), after.get(key)
        if b == a:
            continue
        texts = {d["_id"]: d["text"] async for d in db[BLOBS].find({"_id": {"$in": [x for x in (b, a) if x]}})}
        added, removed = _counts(texts.get(b, ""), texts.get(a, ""))
        kind, _, ident = key.partition(":")
        changed.append({"kind": kind, "id": ident, "before": b, "after": a, "added": added, "removed": removed})
    await db.revisions.update_one({"_id": rev_id}, {"$set": {"changes": changed, "changes_at": _now()}})
    return changed


async def detail(db, rev_id: str) -> dict | None:
    """The changed files with their two texts, for the side-by-side view."""
    rev = await db.revisions.find_one({"_id": rev_id}, {"changes": 1, "changes_at": 1, "changes_base_at": 1,
                                                         "image": 1, "image_after": 1})
    if not rev:
        return None
    files = rev.get("changes") or []
    shas = [s for f in files for s in (f.get("before"), f.get("after")) if s]
    texts = {d["_id"]: d["text"] async for d in db[BLOBS].find({"_id": {"$in": shas}})} if shas else {}
    return {
        "recorded": rev.get("changes") is not None,
        "since": rev.get("changes_base_at"), "at": rev.get("changes_at"),
        "files": [{**f, "before_text": texts.get(f.get("before"), ""), "after_text": texts.get(f.get("after"), "")}
                  for f in files],
        "pictures": {"before": bool(rev.get("image")), "after": bool(rev.get("image_after"))},
    }
