"""Which tool fits a task: the picker behind the MCP server's find_tool.

An agent describes what it is trying to do; a small model reads a compact
line for every tool in the Tools tab and names the best few. The whole
request - instructions, the index of every tool, the task and the answer -
is held under CONTEXT tokens, so a small, cheap model with an 8k window
can do it. Only after the pick is a tool's full manual looked up, so an
agent never has to read 175 manuals to find one.

Without a key, or when the model fails or answers nonsense, a keyword
score over the same index answers instead - it is never the only way.
"""

from __future__ import annotations

import json
import logging
import math
import re
from collections import Counter

from . import summarise

log = logging.getLogger("x3.tool_router")

CONTEXT = 8192            # tokens: the whole request, prompt and answer
ANSWER = 300              # tokens kept for the model's answer
TASK_MAX = 1200           # characters of the task kept
CHARS_PER_TOKEN = 3.6     # conservative for English with ids and units

SYSTEM = (
    "You pick tools for an engineering agent. Below is an index of every tool, "
    "one per line: id | what it does | rooms. Read the task and choose the 1-3 "
    "tools that best help with it, best first. Only choose ids from the index. "
    "If none fits, return an empty list. Answer with JSON only: "
    '{"picks": [{"id": "<tool id>", "why": "<one short sentence>"}]}'
)


def line_of(t: dict) -> str:
    rooms = ",".join(t.get("rooms") or [])
    return f"{t['id']} | {t.get('blurb', '')} | {rooms}"


def tokens(text: str) -> int:
    return math.ceil(len(text) / CHARS_PER_TOKEN)


# ---------------- the keyword fallback, and the pre-filter ----------------
WORD = re.compile(r"[a-z0-9]+")
STOP = set("a an the of to for and or in on at by with from is are be it this that how what "
           "which i we my our need want make get use using do does can".split())


def words(text: str) -> list[str]:
    return [w for w in WORD.findall(text.lower()) if w not in STOP]


def score(task: str, catalog: list[dict]) -> list[tuple[float, dict]]:
    """A small BM25 over name, blurb, keywords and rooms."""
    q = words(task)
    docs = [(t, words(" ".join([t["id"].replace("-", " "), t.get("name", ""), t.get("blurb", ""),
                                " ".join(t.get("keywords") or []), " ".join(t.get("rooms") or [])])))
            for t in catalog]
    n = len(docs) or 1
    avg = sum(len(d) for _, d in docs) / n or 1
    df = Counter(w for _, d in docs for w in set(d))
    out = []
    for t, d in docs:
        tf = Counter(d)
        s = 0.0
        for w in q:
            if w in tf:
                idf = math.log(1 + (n - df[w] + 0.5) / (df[w] + 0.5))
                s += idf * tf[w] * 2.2 / (tf[w] + 1.2 * (0.25 + 0.75 * len(d) / avg))
        # a word that is part of the id or name counts a little extra
        s += 0.5 * sum(1 for w in q if w in t["id"] or w in t.get("name", "").lower())
        if s > 0:
            out.append((s, t))
    out.sort(key=lambda p: -p[0])
    return out


def keyword_picks(task: str, catalog: list[dict], limit: int = 3) -> list[dict]:
    return [{"id": t["id"], "why": "matches the task's words", "score": round(s, 2)}
            for s, t in score(task, catalog)[:limit]]


def index_for(task: str, catalog: list[dict]) -> tuple[str, int]:
    """Every tool's line if they fit the budget; otherwise the best-scoring
    ones that do. Returns the index and how many tools it holds."""
    budget = CONTEXT - ANSWER - tokens(SYSTEM) - tokens(task) - 64
    lines = [line_of(t) for t in catalog]
    if tokens("\n".join(lines)) <= budget:
        return "\n".join(lines), len(lines)
    ranked = [t for _, t in score(task, catalog)]
    ranked += [t for t in catalog if t not in ranked]
    kept: list[str] = []
    used = 0
    for t in ranked:
        ln = line_of(t)
        if used + tokens(ln) + 1 > budget:
            break
        kept.append(ln)
        used += tokens(ln) + 1
    return "\n".join(kept), len(kept)


async def pick(task: str, catalog: list[dict], limit: int = 3,
               room: str | None = None) -> dict:
    """{picks: [{id, why}], method: 'model'|'keywords', tools_seen, prompt_tokens?, cost?}"""
    task = task.strip()[:TASK_MAX]
    if room:
        task = f"{task}\n(The agent works in the {room} room.)"
    ids = {t["id"] for t in catalog}
    if not summarise.api_key():
        return {"picks": keyword_picks(task, catalog, limit), "method": "keywords",
                "tools_seen": len(catalog), "reason": "no model key configured"}
    index, seen = index_for(task, catalog)
    messages = [{"role": "system", "content": SYSTEM},
                {"role": "user", "content": f"Tools:\n{index}\n\nTask:\n{task}\n\nJSON:"}]
    try:
        payload = await summarise._post(messages, max_tokens=ANSWER)
        text = payload["choices"][0]["message"]["content"] or ""
        m = re.search(r"\{.*\}", text, re.S)
        picks = json.loads(m.group(0)).get("picks", []) if m else []
        picks = [{"id": p["id"], "why": str(p.get("why", ""))[:200]}
                 for p in picks if isinstance(p, dict) and p.get("id") in ids][:limit]
        used = payload.get("usage") or {}
        if not picks and keyword_picks(task, catalog, 1):
            # The model found nothing; say so, and offer what the words match.
            return {"picks": [], "method": "model", "tools_seen": seen, "usage": used,
                    "also": keyword_picks(task, catalog, limit)}
        return {"picks": picks, "method": "model", "tools_seen": seen, "usage": used}
    except Exception as exc:                           # noqa: BLE001 - fall back, never fail
        log.warning("tool router model failed: %s", exc)
        return {"picks": keyword_picks(task, catalog, limit), "method": "keywords",
                "tools_seen": len(catalog), "reason": f"model unavailable: {exc}"[:200]}
