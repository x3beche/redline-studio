"""Where the tokens, the money and the minutes went.

Every revision on the board is applied by an agent talking to one or more
LLMs. The card should say what that cost - not an estimate, but the numbers
the agent's own transcript recorded.

Two sources feed this:

* Claude Code writes one JSONL line per assistant message under
  ``~/.claude/projects/<slug>/``, each carrying the model, the timestamp and
  a full ``usage`` block. Several lines share one ``requestId`` - one per
  content block - and they all repeat the SAME usage. Checked over 806
  multi-block requests in this repo's transcript: not one differed. So a
  request is counted once; summing the lines would have trebled every
  figure.
* The card summariser calls OpenRouter and logs what came back. Those rows
  land in the same collection with their own provider, so the card can show
  that two different vendors were involved in one revision.

Prices are list prices, per million tokens, and they are a guess about the
outside world rather than a measurement - so every rate carries where it
came from, and a model nobody priced reports tokens with a null cost rather
than a made-up number. A subscription pays a flat fee instead: the marginal
cost of one revision is then zero, and the figure here answers "what would
this have cost on the API".
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

CURSOR_ID = "usage_cursor"
CALLS = "llm_calls"
ANALYTICS = "analytics"

CLAUDE_HOME = Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude"))

# Which transcript folders belong to this project. Claude Code names the
# folder after the working directory with the slashes turned into dashes.
PROJECT_GLOB = os.environ.get("X3_TRANSCRIPTS", "-mnt-ssd-3d-arena*")

# USD per million tokens. "list" means published; "assumed" means we put the
# model in its family's tier because no public rate was to hand - the card
# says so rather than pretending to know.
PRICES: dict[str, dict] = {
    "claude-opus-5": dict(input=15.0, output=75.0, cache_read=1.5,
                          cache_write=18.75, basis="assumed",
                          note="Opus tier rate"),
    "claude-opus-4-5": dict(input=15.0, output=75.0, cache_read=1.5,
                            cache_write=18.75, basis="assumed",
                            note="Opus tier rate"),
    "claude-sonnet-5": dict(input=3.0, output=15.0, cache_read=0.30,
                            cache_write=3.75, basis="assumed",
                            note="Sonnet tier rate"),
    "claude-haiku-4-5-20251001": dict(input=1.0, output=5.0, cache_read=0.10,
                                      cache_write=1.25, basis="assumed",
                                      note="Haiku tier rate"),
}

# Anything the summariser used. Filled from the OpenRouter response, which
# reports its own cost, so these need no rate card.
OPENROUTER_PRICED_BY_PROVIDER = True


def _rates(model: str) -> dict | None:
    if model in PRICES:
        return PRICES[model]
    # An unseen dated build of a known model: claude-opus-5-20260101 etc.
    for name, row in PRICES.items():
        if model.startswith(name):
            return row
    return None


def price(model: str, inp: int, out: int, cache_read: int, cache_write: int):
    """USD at list price, or None when the model has no rate."""
    r = _rates(model)
    if not r:
        return None, None
    usd = (inp * r["input"] + out * r["output"] +
           cache_read * r["cache_read"] + cache_write * r["cache_write"]) / 1e6
    return usd, r["basis"]


# ---------------- ingest ----------------
def transcripts() -> list[Path]:
    root = CLAUDE_HOME / "projects"
    if not root.exists():
        return []
    return sorted(p for d in root.glob(PROJECT_GLOB) if d.is_dir()
                  for p in d.glob("*.jsonl"))


def _row(entry: dict) -> dict | None:
    """One transcript line -> one call row, or None if it carries no usage."""
    msg = entry.get("message") or {}
    use = msg.get("usage")
    if not use or entry.get("type") != "assistant":
        return None
    req = entry.get("requestId")
    if not req:
        return None
    model = msg.get("model") or "unknown"
    inp = use.get("input_tokens") or 0
    out = use.get("output_tokens") or 0
    c_read = use.get("cache_read_input_tokens") or 0
    c_write = use.get("cache_creation_input_tokens") or 0
    usd, basis = price(model, inp, out, c_read, c_write)
    detail = use.get("output_tokens_details") or {}
    return {"_id": f"cc:{req}", "at": entry.get("timestamp"),
            "provider": "anthropic", "surface": "claude-code",
            "model": model, "input": inp, "output": out,
            "cache_read": c_read, "cache_write": c_write,
            "thinking": detail.get("thinking_tokens") or 0,
            "tier": use.get("service_tier"),
            "cost_usd": usd, "cost_basis": basis,
            "session": entry.get("sessionId")}


async def ingest(db, full: bool = False) -> dict:
    """Pull new transcript lines into the calls collection.

    The transcript is tens of megabytes and only grows at the end, so the
    byte offset of every file is remembered and the next pass reads just the
    tail. `full` throws the offsets away and re-reads everything; the rows
    are keyed by request id, so re-reading changes nothing.
    """
    cur = {} if full else ((await db.meta.find_one({"_id": CURSOR_ID}) or {})
                           .get("files", {}))
    fresh, seen, scanned = [], set(), 0
    for path in transcripts():
        key = str(path)
        start = int(cur.get(key, 0))
        size = path.stat().st_size
        if start > size:                   # file was replaced, start over
            start = 0
        with path.open("rb") as fh:
            fh.seek(start)
            data = fh.read()
        cur[key] = start + len(data)
        for line in data.decode("utf-8", "replace").splitlines():
            line = line.strip()
            if not line:
                continue
            scanned += 1
            try:
                row = _row(json.loads(line))
            except Exception:
                continue
            if row and row["_id"] not in seen:
                seen.add(row["_id"])
                fresh.append(row)

    written = 0
    if fresh:
        from pymongo import UpdateOne
        res = await db[CALLS].bulk_write(
            [UpdateOne({"_id": r["_id"]}, {"$setOnInsert": r}, upsert=True)
             for r in fresh], ordered=False)
        written = res.upserted_count
    await db.meta.update_one({"_id": CURSOR_ID}, {"$set": {"files": cur}},
                             upsert=True)
    return {"scanned": scanned, "new_calls": written,
            "files": len(cur)}


async def record_call(db, **row) -> None:
    """Log one non-Claude-Code call, e.g. the OpenRouter card summariser."""
    row.setdefault("at", datetime.now(timezone.utc).isoformat())
    await db[CALLS].update_one({"_id": row["_id"]}, {"$setOnInsert": row},
                               upsert=True)


# ---------------- roll up ----------------
def _parse(ts: str | None):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def summarise(rows: list[dict], started: str, finished: str | None) -> dict:
    """Totals, per-model and per-provider splits, and a rate series."""
    t0, t1 = _parse(started), _parse(finished) or datetime.now(timezone.utc)
    seconds = max((t1 - t0).total_seconds(), 0.0) if t0 else 0.0

    tot = {"calls": 0, "input": 0, "output": 0, "cache_read": 0,
           "cache_write": 0, "thinking": 0, "cost_usd": 0.0}
    priced, unpriced = True, set()
    models: dict[str, dict] = {}
    providers: dict[str, dict] = {}
    series: dict[int, int] = {}

    for r in rows:
        tot["calls"] += 1
        for k in ("input", "output", "cache_read", "cache_write", "thinking"):
            tot[k] += r.get(k) or 0
        if r.get("cost_usd") is None:
            priced = False
            unpriced.add(r.get("model", "?"))
        else:
            tot["cost_usd"] += r["cost_usd"]

        m = models.setdefault(r.get("model", "?"),
                              {"calls": 0, "input": 0, "output": 0,
                               "cache_read": 0, "cache_write": 0,
                               "cost_usd": 0.0, "basis": r.get("cost_basis"),
                               "provider": r.get("provider")})
        p = providers.setdefault(r.get("provider", "?"),
                                 {"calls": 0, "output": 0, "cost_usd": 0.0})
        for d in (m, p):
            d["calls"] += 1
            d["output"] += r.get("output") or 0
            d["cost_usd"] += r.get("cost_usd") or 0.0
        for k in ("input", "cache_read", "cache_write"):
            m[k] += r.get(k) or 0

        at = _parse(r.get("at"))
        if at and t0:
            bucket = int((at - t0).total_seconds() // 30)
            if bucket >= 0:
                series[bucket] = series.get(bucket, 0) + (r.get("output") or 0)

    billed = tot["input"] + tot["output"] + tot["cache_read"] + tot["cache_write"]
    return {
        "seconds": round(seconds, 1),
        "totals": {**tot, "billed_tokens": billed,
                   "cost_usd": round(tot["cost_usd"], 6),
                   "complete": priced,
                   "unpriced_models": sorted(unpriced)},
        "rate": {
            "output_per_s": round(tot["output"] / seconds, 2) if seconds else None,
            "billed_per_s": round(billed / seconds, 1) if seconds else None,
            "usd_per_min": round(tot["cost_usd"] / seconds * 60, 4)
            if seconds and priced else None,
        },
        "models": [{"model": k, **v, "cost_usd": round(v["cost_usd"], 6)}
                   for k, v in sorted(models.items(),
                                      key=lambda kv: -kv[1]["output"])],
        "providers": [{"provider": k, **v, "cost_usd": round(v["cost_usd"], 6)}
                      for k, v in sorted(providers.items(),
                                         key=lambda kv: -kv[1]["output"])],
        "series": {"bucket_s": 30,
                   "output": [series.get(i, 0)
                              for i in range(max(series) + 1)] if series else []},
    }


async def for_window(db, started: str, finished: str | None) -> dict:
    q = {"at": {"$gte": started}}
    if finished:
        q["at"]["$lte"] = finished
    rows = [r async for r in db[CALLS].find(q)]
    return summarise(rows, started, finished)


async def store(db, revision_id: str, run: dict) -> dict:
    """Freeze the numbers for one revision and keep them."""
    await ingest(db)
    data = await for_window(db, run.get("started_at"), run.get("finished_at"))
    doc = {"_id": revision_id, "title": run.get("title"),
           "started_at": run.get("started_at"),
           "finished_at": run.get("finished_at"),
           "computed_at": datetime.now(timezone.utc).isoformat(), **data}
    await db[ANALYTICS].replace_one({"_id": revision_id}, doc, upsert=True)
    return doc
