"""One search box over everything: code, notes, chats, parts, revisions.

What the Ctrl+K palette asks as you type (after two characters). Each kind
answers a handful of its best matches: a code line with its file and line
number, a note by its title with the matching line, a chat line with its
room, a part from the drawer, a revision by its summary. The workspace's
own, through the scope (backend/scope.py). Names of models, boards, apps
and tools the page already has; it matches those itself.
"""

from __future__ import annotations

import re

EACH = 8


def _line_hits(text: str, rx: re.Pattern, most: int = 3) -> list[tuple[int, str]]:
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        if rx.search(line):
            out.append((i, line.strip()[:160]))
            if len(out) >= most:
                break
    return out


def _around(text: str, rx: re.Pattern, width: int = 120) -> str:
    m = rx.search(text)
    if not m:
        return text[:width]
    a = max(0, m.start() - width // 3)
    return ("…" if a else "") + text[a:a + width].replace("\n", " ").strip()


async def everything(db, q: str) -> list[dict]:
    q = (q or "").strip()
    if len(q) < 2:
        return []
    rx = re.compile(re.escape(q), re.IGNORECASE)
    mq = {"$regex": re.escape(q), "$options": "i"}
    out: list[dict] = []

    # Code: the models' and boards' sources, line by line.
    n = 0
    async for m in db.models.find({"source": mq}, {"source": 1}):
        for line, text in _line_hits(m.get("source") or "", rx):
            out.append({"kind": "code", "file": "model", "id": m["_id"], "line": line, "text": text,
                        "label": f"{m['_id'].split('/')[-1]}.py:{line}"})
            n += 1
        if n >= EACH:
            break
    n = 0
    async for b in db.boards.find({"source": mq}, {"source": 1}):
        for line, text in _line_hits(b.get("source") or "", rx):
            out.append({"kind": "code", "file": "board", "id": b["_id"], "line": line, "text": text,
                        "label": f"{b['_id']}.ato:{line}"})
            n += 1
        if n >= EACH:
            break

    async for d in db.notes.find({"text": mq}, {"text": 1, "title": 1}).sort("updated_at", -1).limit(EACH):
        out.append({"kind": "note", "id": d["_id"], "label": d.get("title") or "Untitled",
                    "text": _around(d.get("text") or "", rx)})

    async for c in db.chat.find({"text": mq}, {"text": 1, "room": 1, "at": 1, "role": 1}).sort("at", -1).limit(EACH):
        out.append({"kind": "chat", "id": str(c["_id"]), "room": c.get("room") or "cad",
                    "label": f"{'agent' if c.get('role') == 'agent' else 'you'} · {c.get('room') or 'cad'}",
                    "text": _around(c.get("text") or "", rx)})

    async for r in db.revisions.find({"$or": [{"comment": mq}, {"summary": mq}]},
                                     {"comment": 1, "summary": 1, "kind": 1, "model": 1, "status": 1}) \
            .sort("created_at", -1).limit(EACH):
        out.append({"kind": "revision", "id": r["_id"], "room": r.get("kind") or "cad", "model": r.get("model"),
                    "label": r.get("summary") or r.get("comment", "")[:80], "text": f"{r.get('status')} · {r.get('model') or ''}"})

    async for p in db.parts.find({"$or": [{"_id": mq}, {"name": mq}, {"model_name": mq}]},
                                 {"name": 1, "model_name": 1}).limit(EACH):
        out.append({"kind": "part", "id": p["_id"], "label": f"{p['_id']} · {p.get('name') or ''}".strip(" ·"),
                    "text": p.get("model_name") or ""})
    return out
