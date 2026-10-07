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
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

CURSOR_ID = "usage_cursor"
CALLS = "llm_calls"
ANALYTICS = "analytics"

CLAUDE_HOME = Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude"))

# Which transcript folders belong to this project. Claude Code names the
# folder after the working directory with the slashes turned into dashes.
# Every project folder is read, sub-agents' transcripts included, and a
# line counts when its working directory is this checkout (or below it):
# a session started elsewhere that works here - with agents of its own -
# is this project's work too; one elsewhere is not.
_CHECKOUT = Path(__file__).resolve().parent.parent
PROJECT_GLOB = os.environ.get("REDLINE_TRANSCRIPTS", "*")
WORK_DIR = os.environ.get("REDLINE_TRANSCRIPTS_CWD", str(_CHECKOUT)).rstrip("/")


def _here(entry: dict) -> bool:
    cwd = (entry.get("cwd") or "").rstrip("/")
    if not WORK_DIR or not cwd:            # a line that does not say where it was
        return True
    return cwd == WORK_DIR or cwd.startswith(WORK_DIR + "/")

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
                  for p in d.rglob("*.jsonl"))


# What a request was for. The usage belongs to a whole assistant turn, and
# the honest way to label it is by what that turn actually did: a turn that
# ran `revisions.py log` was writing a progress line, one that ran a build
# was building. A turn with no tool call is a reply to the person.
KINDS = ("progress", "build", "work", "reply", "summary")


def _kind(tools: list[str]) -> str:
    if not tools:
        return "reply"
    joined = " ".join(tools)
    # Build first: a turn usually logs a progress line in the same command as
    # the build it kicks off, and what that turn was for is the build.
    if any(k in joined for k in ("revisions.py build", "revisions.py save",
                                 "export_model.py", "render.py")):
        return "build"
    if any(k in joined for k in ("revisions.py log", "revisions.py start",
                                 "revisions.py finish")):
        return "progress"
    return "work"


def _tools(entry: dict) -> list[str]:
    out = []
    for b in (entry.get("message") or {}).get("content") or []:
        if isinstance(b, dict) and b.get("type") == "tool_use":
            i = b.get("input") or {}
            out.append(f"{b.get('name')} " +
                       str(i.get("command") or i.get("file_path") or
                           i.get("skill") or "")[:200])
    return out


def _row(entry: dict) -> dict | None:
    """One transcript line -> one call row, or None if it carries no usage."""
    msg = entry.get("message") or {}
    use = msg.get("usage")
    if not use or entry.get("type") != "assistant" or not _here(entry):
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
            # Who made the call: the Claude Code session, and the sub-agent
            # within it (None for the session's main thread). A note's cost
            # is attributed by these, not by the clock (see `pick`).
            "session": entry.get("sessionId"),
            "agent": entry.get("agentId")}


# `revisions.py start <rid>` in a shell command, flags before the id allowed;
# or the MCP server's `start` tool. The line that made that tool call is how
# a note's run learns which agent took it (`resolve`).
_START = re.compile(r"revisions\.py\s+start\s+(?:--?[\w-]+\s+)*[\"']?([A-Za-z0-9][\w:.-]*)")


def _starts(entry: dict) -> list[str]:
    """The notes a transcript line's tool calls started."""
    out = []
    for b in (entry.get("message") or {}).get("content") or []:
        if not (isinstance(b, dict) and b.get("type") == "tool_use"):
            continue
        i = b.get("input") or {}
        name = b.get("name") or ""
        if name == "Bash":
            out += _START.findall(str(i.get("command") or ""))
        elif name.startswith("mcp__") and name.endswith("__start") and i.get("id"):
            out.append(str(i["id"]))
    return out


def _spawns(entry: dict) -> list[str]:
    """Tool-use ids of the sub-agents a line started (the Agent tool)."""
    return [b["id"] for b in (entry.get("message") or {}).get("content") or []
            if isinstance(b, dict) and b.get("type") == "tool_use"
            and b.get("name") in ("Agent", "Task") and b.get("id")]


def _spawned_by(path: Path) -> str | None:
    """For a sub-agent's transcript, the tool-use id that started it:
    Claude Code keeps it beside the transcript in agent-<id>.meta.json."""
    meta = path.with_name(path.name[:-len(".jsonl")] + ".meta.json")
    try:
        return json.loads(meta.read_text()).get("toolUseId")
    except (OSError, ValueError, AttributeError):
        return None


# The transcript is only read when it can have grown. A page reload asks for
# the running revision's numbers straight away, and re-reading the tail of a
# 60 MB file on every one of those made the panel arrive late for no reason.
_LAST_INGEST = 0.0
INGEST_EVERY = 2.0                     # seconds


async def ingest(db, full: bool = False, force: bool = True) -> dict:
    """Pull new transcript lines into the calls collection.

    The transcript is tens of megabytes and only grows at the end, so the
    byte offset of every file is remembered and the next pass reads just the
    tail. `full` throws the offsets away and re-reads everything; the rows
    are keyed by request id, so re-reading changes nothing.
    """
    global _LAST_INGEST
    import time

    if not force and not full and time.time() - _LAST_INGEST < INGEST_EVERY:
        return {"scanned": 0, "new_calls": 0, "files": 0, "skipped": True}
    _LAST_INGEST = time.time()

    cur = {} if full else ((await db.meta.find_one({"_id": CURSOR_ID}) or {})
                           .get("files", {}))
    fresh, seen, scanned = [], {}, 0
    tools: dict[str, list[str]] = {}
    starts: dict[str, list[str]] = {}
    spawns: dict[str, list[str]] = {}
    for path in transcripts():
        key = str(path)
        start = int(cur.get(key, 0))
        size = path.stat().st_size
        if start > size:                   # file was replaced, start over
            start = 0
        with path.open("rb") as fh:
            fh.seek(start)
            data = fh.read()
        # Only whole lines: a line still being written is read next time,
        # not skipped for good - it may be the one that says who started
        # a note.
        cut = data.rfind(b"\n") + 1
        data = data[:cut]
        cur[key] = start + cut
        parent = _spawned_by(path) if path.parent.name == "subagents" else None
        for line in data.decode("utf-8", "replace").splitlines():
            line = line.strip()
            if not line:
                continue
            scanned += 1
            try:
                entry = json.loads(line)
                row = _row(entry)
            except Exception:
                continue
            if not row:
                continue
            row["spawned_by"] = parent
            # A request's blocks are separate lines and the tool call can be
            # in any of them, so the tools are gathered per request and the
            # kind decided once at the end.
            found = _tools(entry)
            if found:
                tools.setdefault(row["_id"], []).extend(found)
            for got, into in ((_starts(entry), starts), (_spawns(entry), spawns)):
                if got:
                    into.setdefault(row["_id"], []).extend(got)
            if row["_id"] not in seen:
                seen[row["_id"]] = row
                fresh.append(row)

    for r in fresh:
        r["kind"] = _kind(tools.get(r["_id"], []))

    written = 0
    if fresh:
        from pymongo import UpdateOne
        ops = []
        for r in fresh:
            kind = r.pop("kind")
            # Who made the call is always written, so a full pass fills it
            # in on rows ingested before it was kept.
            ident = {k: r.pop(k) for k in ("session", "agent", "spawned_by")}
            # The numbers are written once; the kind can be refined later,
            # because a request whose tool call fell in the next chunk of the
            # file would otherwise stay filed as a plain reply.
            patch = {"$setOnInsert": r, "$set": ident}
            if kind != "reply" or full:
                patch["$set"]["kind"] = kind
            else:
                patch["$setOnInsert"] = {**r, "kind": kind}
            add = {k: {"$each": sorted(set(v[r["_id"]]))}
                   for k, v in (("starts", starts), ("spawns", spawns))
                   if v.get(r["_id"])}
            if add:
                patch["$addToSet"] = add
            ops.append(UpdateOne({"_id": r["_id"]}, patch, upsert=True))
        res = await db[CALLS].bulk_write(ops, ordered=False)
        written = res.upserted_count
    await db.meta.update_one({"_id": CURSOR_ID}, {"$set": {"files": cur}},
                             upsert=True)
    return {"scanned": scanned, "new_calls": written,
            "files": len(cur)}


async def record_call(db, **row) -> None:
    """Log one non-Claude-Code call, e.g. the OpenRouter card summariser."""
    row.setdefault("at", datetime.now(timezone.utc).isoformat())
    row.setdefault("kind", "summary")
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

    surfaces: dict[str, dict] = {}
    kinds: dict[str, dict] = {}
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

        k = kinds.setdefault(r.get("kind") or "work",
                             {"calls": 0, "output": 0, "cost_usd": 0.0})
        k["calls"] += 1
        k["output"] += r.get("output") or 0
        k["cost_usd"] += r.get("cost_usd") or 0.0

        # What part of the app spent this: the agent applying the revision,
        # or the summariser writing the card's one-liner.
        sf = surfaces.setdefault(r.get("surface", "?"),
                                 {"calls": 0, "output": 0, "cost_usd": 0.0,
                                  "model": r.get("model"),
                                  "provider": r.get("provider")})
        sf["calls"] += 1
        sf["output"] += r.get("output") or 0
        sf["cost_usd"] += r.get("cost_usd") or 0.0

        at = _parse(r.get("at"))
        if at and t0:
            bucket = int((at - t0).total_seconds() // 30)
            if bucket >= 0:
                series[bucket] = series.get(bucket, 0) + (r.get("output") or 0)

    billed = tot["input"] + tot["output"] + tot["cache_read"] + tot["cache_write"]
    # Cache reads look absurd as a raw total - 24M for one revision - because
    # every request re-reads the whole conversation from cache. Divided by the
    # calls it is just the context size, which is the number a person can
    # actually judge.
    per_call = round(tot["cache_read"] / tot["calls"]) if tot["calls"] else 0
    return {
        "seconds": round(seconds, 1),
        "totals": {**tot, "billed_tokens": billed,
                   "context_per_call": per_call,
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
        "surfaces": [{"surface": k, **v, "cost_usd": round(v["cost_usd"], 6)}
                     for k, v in sorted(surfaces.items(),
                                        key=lambda kv: -kv[1]["output"])],
        "kinds": [{"kind": k, **v, "cost_usd": round(v["cost_usd"], 6)}
                  for k, v in sorted(kinds.items(),
                                     key=lambda kv: -kv[1]["cost_usd"])],
        "series": {"bucket_s": 30,
                   "output": [series.get(i, 0)
                              for i in range(max(series) + 1)] if series else []},
    }


# ---------------- whose calls ----------------
APPROX_LABEL = "approximate (time window)"
# How far before a run's start its `start` tool call may be. The tool call is
# written before the command runs, so it is never after the run's start; the
# slack is for two clocks on one machine.
CLAIM_BEFORE = timedelta(minutes=60)
CLAIM_AFTER = timedelta(seconds=2)


def _z(t: datetime) -> str:
    """The transcripts' own timestamp form, so string ranges compare."""
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def resolve(holders: list[dict], claims: list[dict]) -> list[dict]:
    """Give each holder the transcript identity of the agent that started it.

    `claims` are call rows whose tool call ran `start` for this note. A
    holder's is the latest one at or just before its `since` - in its own
    session when the session is known. Holders without one stay unresolved.
    """
    out = []
    for h in holders:
        h = dict(h)
        since = _parse(h.get("since"))
        if not h.get("resolved") and since:
            got = [c for c in claims
                   if (t := _parse(c.get("at")))
                   and since - CLAIM_BEFORE <= t <= since + CLAIM_AFTER
                   and (not h.get("session") or c.get("session") == h["session"])]
            if got:
                c = max(got, key=lambda c: _parse(c["at"]))
                h.update(session=c.get("session"), agent=c.get("agent"),
                         resolved=True, claim=c["_id"])
        out.append(h)
    return out


def pick(rows: list[dict], rid: str, holders: list[dict],
         finished: str | None) -> tuple[list[dict], bool]:
    """The calls that belong to one note, and whether that is exact.

    A call belongs when it carries the note's id (the card summariser), or
    when the agent holding the note made it while it held it - or a
    sub-agent that agent started while it held it, and theirs in turn. A
    holder whose identity is unknown falls back to everything in its
    stretch of time, and then the answer is only approximate.
    """
    end = _parse(finished)
    out = {r["_id"]: r for r in rows if r.get("revision") == rid}
    exact = bool(holders)
    for h in holders:
        lo = _parse(h.get("since"))
        hi = _parse(h.get("until")) or end

        def inside(r, lo=lo, hi=hi):
            t = _parse(r.get("at"))
            return bool(t and lo and t >= lo and (hi is None or t <= hi))

        if not h.get("resolved"):
            exact = False
            out.update((r["_id"], r) for r in rows if inside(r))
            continue
        sess = h.get("session")
        mine = [r for r in rows if r.get("surface") == "claude-code"
                and r.get("session") == sess and "agent" in r
                and r.get("agent") == h.get("agent") and inside(r)]
        spawned = {s for r in mine for s in r.get("spawns") or []}
        seen: set[str] = set()
        while spawned - seen:
            seen |= spawned
            kids = [r for r in rows if r.get("spawned_by") in spawned
                    and r.get("session") == sess and inside(r)]
            mine += kids
            spawned = seen | {s for r in kids for s in r.get("spawns") or []}
        out.update((r["_id"], r) for r in mine)
    return list(out.values()), exact


def derive(run: dict, claims: list[dict]) -> list[dict]:
    """Holders for a run started before they were kept.

    Such a run remembers only the last `start`: a second agent's start
    replaced the first agent's record, though both went on working the
    note. The transcripts still have every `start` tool call, so each agent
    that started this note during the run - or within CLAIM_BEFORE ahead of
    it - is a holder from its own start to the run's finish.
    """
    lo, hi = _parse(run.get("started_at")), _parse(run.get("finished_at"))
    if not lo:
        return []
    who: dict[tuple, dict] = {}
    for c in sorted(claims, key=lambda c: c.get("at") or ""):
        t = _parse(c.get("at"))
        if not t or t < lo - CLAIM_BEFORE or (hi and t > hi):
            continue
        k = (c.get("session"), c.get("agent"))
        who.setdefault(k, {"by": None, "session": k[0], "agent": k[1],
                           "since": c["at"], "until": None,
                           "resolved": True, "claim": c["_id"]})
    out = list(who.values())
    # The run's own `by` names the agent whose start it recorded: the one
    # whose claim is closest before the start.
    mine = resolve([{"since": run.get("started_at")}], claims)[0]
    for h in out:
        if mine.get("resolved") and h["claim"] == mine.get("claim"):
            h["by"] = run.get("by")
    return out


async def identify(db, rid: str, run: dict) -> list[dict]:
    """The run's holders with their transcript identities, read from the
    ingested calls when not known yet, and kept on the run once found."""
    from . import runs
    held = runs.holders_of(run)
    if all(h.get("resolved") for h in held):
        return held
    claims = [c async for c in db[CALLS].find(
        {"starts": rid}, {"at": 1, "session": 1, "agent": 1})]
    got = (resolve(held, claims) if run.get("holders")
           else derive(run, claims) or held)
    if got != held and run.get("_id") == rid:
        await db.runs.update_one({"_id": rid}, {"$set": {"holders": got}})
    return got


async def for_revision(db, rid: str, started: str,
                       finished: str | None, run: dict | None = None) -> dict:
    """Every call that belongs to one revision, and how sure that is.

    The card summariser runs when the card is created, long before anyone
    starts work on it; it writes the revision id on its rows, and those are
    pulled in whenever they happened. The agent's calls are the ones its
    own session and agent made between `start` and `finish` (`pick`) - the
    clock alone also caught every other agent working at the same time.
    A run whose agent cannot be told falls back to the window and says so.
    """
    held = await identify(db, rid, run) if run else runs_window(started)
    if not held:
        held = runs_window(started)
    lo = min((_parse(h.get("since")) for h in held if h.get("since")),
             default=_parse(started))
    window: dict = {"at": {"$gte": _z(lo - timedelta(seconds=1)) if lo else ""}}
    if _parse(finished):
        window["at"]["$lte"] = _z(_parse(finished) + timedelta(seconds=1))
    if all(h.get("resolved") for h in held):
        window["session"] = {"$in": sorted({h.get("session") for h in held})}
    rows = [r async for r in db[CALLS].find({"$or": [window, {"revision": rid}]})]
    chosen, exact = pick(rows, rid, held, finished)
    data = summarise(chosen, started, finished)
    data["attribution"] = {
        "method": "agent" if exact else "window",
        "approximate": not exact,
        "label": None if exact else APPROX_LABEL,
        "holders": [{"by": (h.get("by") or {}).get("name"), "session": h.get("session"),
                     "agent": h.get("agent"), "since": h.get("since"),
                     "until": h.get("until"), "resolved": bool(h.get("resolved"))}
                    for h in held]}
    return data


def runs_window(started: str | None) -> list[dict]:
    """No run to go by: one holder nobody can name, i.e. the plain window."""
    return [{"by": None, "since": started, "resolved": False}] if started else []


async def store(db, revision_id: str, run: dict, fresh: bool = True,
                keep_compute: dict | None = None) -> dict:
    """Freeze the numbers for one revision and keep them."""
    await ingest(db, force=fresh)
    data = await for_revision(db, revision_id, run.get("started_at"),
                              run.get("finished_at"), run)
    # What the machine spent on the same revision - builds and renders. A
    # different bill from a different meter, so it sits in its own block
    # rather than being added to the token cost.
    if keep_compute is not None:
        data["compute"] = keep_compute
    else:
        from . import compute
        data["compute"] = await compute.for_revision(
            db, revision_id, run.get("started_at"), run.get("finished_at"), run)
    doc = {"_id": revision_id, "title": run.get("title"),
           "started_at": run.get("started_at"),
           "finished_at": run.get("finished_at"),
           "computed_at": datetime.now(timezone.utc).isoformat(), **data}
    await db[ANALYTICS].replace_one({"_id": revision_id}, doc, upsert=True)
    return doc


async def reattribute(db, full: bool = True) -> dict:
    """Re-cost every note already costed, by who did the work.

    A note whose agent can be told from the transcripts is recomputed (its
    machine block kept as it was); one whose cannot keeps its numbers and
    is marked approximate, so the card can say so.
    """
    await ingest(db, full=full)
    done, approx, before = [], [], {}
    async for a in db[ANALYTICS].find({}, {"totals": 1}):
        before[a["_id"]] = (a.get("totals") or {})
    for rid in sorted(before):
        run = await db.runs.find_one({"_id": rid})
        if not run or not run.get("started_at"):
            approx.append(rid)
            await db[ANALYTICS].update_one({"_id": rid}, {"$set": {"attribution": {
                "method": "window", "approximate": True, "label": APPROX_LABEL,
                "holders": []}}})
            continue
        held = await identify(db, rid, run)
        if held and all(h.get("resolved") for h in held):
            old = await db[ANALYTICS].find_one({"_id": rid}, {"compute": 1}) or {}
            run = await db.runs.find_one({"_id": rid}) or run
            doc = await store(db, rid, run, fresh=False,
                              keep_compute=old.get("compute"))
            done.append({"id": rid, "before": before[rid], "after": doc["totals"]})
        else:
            approx.append(rid)
            await db[ANALYTICS].update_one({"_id": rid}, {"$set": {"attribution": {
                "method": "window", "approximate": True, "label": APPROX_LABEL,
                "holders": [{"by": (h.get("by") or {}).get("name"),
                             "since": h.get("since"), "resolved": False}
                            for h in held]}}})
    return {"recomputed": done, "approximate": approx}
