"""The model calls the app makes, and which provider and model each one uses.

Every LLM call the server makes goes through here: the card summaries,
the English translation, the tool pages' prompt runs, the tool finder,
the reading translation of the agents' questions and the Command Code
room's conversations. Each of those is a *job*, and a
job names a provider and a model - chosen in Settings > LLM settings,
kept in the database, the same for the whole server.

Two providers, both spoken to in the OpenAI chat format:

- OpenRouter (https://openrouter.ai), what the app always used;
- Command Code (https://api.commandcode.ai/provider/v1). Its Claude models
  answer only on the Anthropic `/messages` endpoint (the model list says
  so per model), so those calls are translated both ways here and the
  callers never see the difference.

The keys are the server's. They are kept in the `llm_settings` document
and only there - typed in Settings > LLM settings, never read from .env or
the environment - and never sent to a browser: the page is told whether a
key is set and its last four characters, nothing more. No key, no call:
the job fails with `no_key()`'s message, which says where to add one.
"""

from __future__ import annotations

import json
import logging
import time
from typing import AsyncIterator

log = logging.getLogger("redline.llm")

COLL = "llm_settings"          # machine-wide, like the keys: not per workspace
DOC_ID = "llm"

# "priced": whether the provider says what a call cost. OpenRouter puts it
# in every answer's usage; Command Code sends tokens only - no cost in the
# answer, no prices on /models - so its calls are kept as unpriced, never
# guessed. (Its account's own figures - plan, usage windows, credits - come
# from undocumented "alpha" endpoints: cc_account() below.)
PROVIDERS = {
    "openrouter": {"name": "OpenRouter", "base": "https://openrouter.ai/api/v1",
                   "site": "https://openrouter.ai/keys", "priced": True},
    "commandcode": {"name": "Command Code", "base": "https://api.commandcode.ai/provider/v1",
                    "site": "https://commandcode.ai", "priced": False},
}

# What the app asks a model to do. Every job defaults to the one cheap
# model, Command Code's Qwen3.8-Flash: nothing expensive runs unless
# somebody picks it in Settings > LLM settings.
CHEAP = ("commandcode", "Qwen/Qwen3.8-Flash")
JOBS = {
    "summary": {"label": "Card summaries",
                "about": "the one-line sentence on a revision card",
                "default": CHEAP},
    "translate": {"label": "English translation",
                  "about": "a note written in Turkish, turned into an English request",
                  "default": CHEAP},
    "tools": {"label": "Tool pages",
              "about": "running a prompt from the AI & prompts tools",
              "default": CHEAP},
    "router": {"label": "Tool finder",
               "about": "picking the right Basic Tool for what someone typed",
               "default": CHEAP},
    "reading": {"label": "Reading translation",
                "about": "an agent's question or reply, shown in the reader's language",
                "default": CHEAP},
    "chat": {"label": "Chat room",
             "about": "the model a new conversation starts with",
             "default": CHEAP},
    "part_category": {"label": "Part category",
                      "about": "which parts drawer a new LCSC part goes in, when its own category says too little",
                      "default": CHEAP},
}

# The usage log's `kind` of a call -> the job it did, named as in the
# "Which model does what" list. The room's titles are written by the
# summary job's model but belong to the room.
KINDS = {"summary": "summary", "translate": "translate", "tool-llm": "tools",
         "tool-router": "router", "cc-chat": "chat", "reading": "reading",
         "part-category": "part_category"}
KIND_LABELS = {"cc-title": "Chat titles", "llm-test": "Settings test"}


def job_label(kind: str | None) -> str:
    """The job a logged call was for, as the settings page names it."""
    kind = kind or "?"
    if kind in KIND_LABELS:
        return KIND_LABELS[kind]
    job = KINDS.get(kind.split(":", 1)[0])
    return JOBS[job]["label"] if job else kind


TIMEOUT = 60.0

# The settings, read once from the database and kept here: the callers
# (summarise, the tool pages) have no database of their own to hand.
_conf: dict = {"keys": {}, "jobs": {}}
_loaded = False


async def load(db) -> dict:
    """Read the settings document into memory (the server does this at start
    and after every change)."""
    global _conf, _loaded
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    doc = await raw[COLL].find_one({"_id": DOC_ID}) or {}
    _conf = {"keys": dict(doc.get("keys") or {}), "jobs": dict(doc.get("jobs") or {})}
    _loaded = True
    return _conf


def key(provider: str) -> str | None:
    """The provider's key, as saved in Settings > LLM settings - the only
    place a key comes from."""
    if provider not in PROVIDERS:
        return None
    return (_conf["keys"].get(provider) or "").strip() or None


def key_source(provider: str) -> str | None:
    """Where the key comes from: "settings" (the database) or nowhere."""
    return "settings" if key(provider) else None


def no_key(provider: str, job: str | None = None) -> str:
    """What a call without a key says: which key, and where to add it."""
    name = PROVIDERS[provider]["name"] if provider in PROVIDERS else provider
    what = f" for {JOBS[job]['label'].lower()}" if job in JOBS else ""
    return f"no {name} API key is saved{what} - add one in Settings > LLM settings"


def route(job: str) -> tuple[str, str]:
    """(provider, model) for a job: what was chosen, else its default."""
    got = _conf["jobs"].get(job) or {}
    prov, model = JOBS[job]["default"]
    return got.get("provider") or prov, got.get("model") or model


def public() -> dict:
    """What the page may see: whether each key is set, never the key."""
    provs = {}
    for p, info in PROVIDERS.items():
        k = key(p)
        provs[p] = {"name": info["name"], "set": bool(k), "hint": ("…" + k[-4:]) if k else None,
                    "source": key_source(p), "site": info["site"]}
    jobs = {}
    for j, info in JOBS.items():
        prov, model = route(j)
        jobs[j] = {"label": info["label"], "about": info["about"], "provider": prov, "model": model,
                   "default": {"provider": info["default"][0], "model": info["default"][1]}}
    return {"providers": provs, "jobs": jobs,
            "cheap": {"provider": CHEAP[0], "model": CHEAP[1]},
            "registry": registry()}


async def save(db, keys: dict | None = None, jobs: dict | None = None) -> dict:
    """Change keys and job routes. A string sets a key; "" or None removes
    it, and the provider's jobs stop until a new one is saved."""
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    sets: dict = {}
    unsets: dict = {}
    for p, v in (keys or {}).items():
        if p not in PROVIDERS:
            raise ValueError(f"unknown provider {p!r}")
        if v:
            if len(v) > 400 or any(c.isspace() for c in v.strip()):
                raise ValueError(f"{PROVIDERS[p]['name']}: that does not look like an API key")
            sets[f"keys.{p}"] = v.strip()
        else:
            unsets[f"keys.{p}"] = ""
    if keys:
        unsets["off"] = ""                             # the old "forget the .env key too" list
    for j, r in (jobs or {}).items():
        if j not in JOBS:
            raise ValueError(f"unknown job {j!r}")
        prov, model = (r or {}).get("provider"), ((r or {}).get("model") or "").strip()
        if prov not in PROVIDERS:
            raise ValueError(f"{JOBS[j]['label']}: unknown provider {prov!r}")
        if not model or len(model) > 200:
            raise ValueError(f"{JOBS[j]['label']}: choose a model")
        sets[f"jobs.{j}"] = {"provider": prov, "model": model}
    update: dict = {}
    if sets:
        update["$set"] = sets
    if unsets:
        update["$unset"] = unsets
    if update:
        await raw[COLL].update_one({"_id": DOC_ID}, update, upsert=True)
    await load(db)
    return public()


# ---------------- the model lists ----------------

_models_cache: dict[str, tuple[float, list[dict]]] = {}
MODELS_TTL = 600


async def models(provider: str) -> list[dict]:
    """[{id, name, context, anthropic}] - the provider's own list, ten minutes old at most."""
    import httpx

    hit = _models_cache.get(provider)
    if hit and time.time() - hit[0] < MODELS_TTL:
        return hit[1]
    if provider not in PROVIDERS:
        raise ValueError(f"unknown provider {provider!r}")
    headers = {"Authorization": f"Bearer {key(provider)}"} if key(provider) else {}
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(PROVIDERS[provider]["base"] + "/models", headers=headers)
    r.raise_for_status()
    rows = r.json().get("data") or []
    out = []
    for m in rows:
        ends = m.get("supported_endpoints") or []
        out.append({"id": m["id"], "name": m.get("name") or m["id"],
                    "context": m.get("context_length"),
                    "anthropic": "/messages" in ends and "/chat/completions" not in ends,
                    # the one a picker may land on by itself; anything else is chosen
                    "cheap": (provider, m["id"]) == CHEAP,
                    # whether it reads images (the Command Code room's @-mentions)
                    "vision": vision(m)})
    out.sort(key=lambda m: m["id"].lower())
    _models_cache[provider] = (time.time(), out)
    return out


# Model names that read images, for a provider whose list does not say
# (Command Code's /models has no modalities). Guessed narrowly: a model not
# matched here gets a text description instead of the picture.
_VISION_NAMES = ("claude-", "gpt-4o", "gpt-4.1", "gpt-5", "gpt-6", "gemini", "vision", "omni", "-vl", "vl-",
                 "pixtral", "llava")


def vision(m: dict) -> bool:
    """Whether a /models row reads images: the provider's own word when it
    gives one (OpenRouter's architecture.input_modalities), else the name."""
    arch = m.get("architecture") or {}
    mods = arch.get("input_modalities")
    if isinstance(mods, list):
        return "image" in mods
    if isinstance(arch.get("modality"), str):
        return "image" in arch["modality"].split("->")[0]
    name = str(m.get("id") or "").lower()
    return any(k in name for k in _VISION_NAMES)


async def _anthropic_model(provider: str, model: str) -> bool:
    """Whether this model answers only on /messages (Command Code's Claude)."""
    if provider != "commandcode":
        return False
    try:
        for m in await models(provider):
            if m["id"] == model:
                return m["anthropic"]
    except Exception:                                  # noqa: BLE001 - guess from the name
        pass
    return model.startswith("claude-")


# ---------------- the calls ----------------

def _to_anthropic(messages: list[dict], max_tokens: int, temperature: float | None, model: str,
                  stream: bool = False) -> dict:
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system" and isinstance(m["content"], str))
    rest = []
    for m in messages:
        if m["role"] == "system":
            continue
        content = m["content"]
        if isinstance(content, list):                  # OpenAI parts -> Anthropic blocks
            blocks = []
            for part in content:
                if part.get("type") == "text":
                    blocks.append({"type": "text", "text": part["text"]})
                elif part.get("type") == "image_url":
                    url = part["image_url"]["url"]
                    if url.startswith("data:"):
                        head, _, data = url.partition(",")
                        blocks.append({"type": "image", "source": {
                            "type": "base64", "media_type": head[5:].split(";")[0], "data": data}})
            content = blocks
        rest.append({"role": m["role"], "content": content})
    body = {"model": model, "max_tokens": max_tokens, "messages": rest, "stream": stream}
    if system:
        body["system"] = system
    if temperature is not None:
        body["temperature"] = temperature
    return body


def _headers(provider: str, anthropic: bool) -> dict:
    k = key(provider)
    if not k:
        raise RuntimeError(no_key(provider))
    h = {"Authorization": f"Bearer {k}", "Content-Type": "application/json"}
    if anthropic:
        h.update({"x-api-key": k, "anthropic-version": "2023-06-01"})
    return h


def _openai_body(provider: str, model: str, messages: list[dict], max_tokens: int,
                 temperature: float | None, reasoning: bool, stream: bool = False) -> dict:
    body: dict = {"model": model, "messages": messages, "max_tokens": max_tokens, "stream": stream}
    if temperature is not None:
        body["temperature"] = temperature
    if provider == "openrouter":
        body["reasoning"] = {"enabled": reasoning}
        body["usage"] = {"include": True}
    elif not reasoning:
        # Command Code's models think before they answer and that thinking
        # comes out of max_tokens: a 60-token summary would be all thought
        # and no sentence. Leave room for it.
        body["max_tokens"] = max(max_tokens, 1024)
    if stream and provider != "openrouter":
        body["stream_options"] = {"include_usage": True}
    return body


def _error(provider: str, r) -> RuntimeError:
    try:
        d = r.json()
        msg = (d.get("error") or {}).get("message") if isinstance(d.get("error"), dict) else d.get("error")
        msg = msg or d.get("detail") or r.text
    except Exception:                                  # noqa: BLE001
        msg = r.text
    return RuntimeError(f"{PROVIDERS[provider]['name']} answered HTTP {r.status_code}: {str(msg)[:300]}")


async def complete(messages: list[dict], *, job: str | None = None, provider: str | None = None,
                   model: str | None = None, max_tokens: int = 400, temperature: float | None = 0.2,
                   reasoning: bool = False, timeout: float = TIMEOUT) -> dict:
    """One answer, in the OpenAI shape whatever the provider:
    {choices: [{message: {content}}], usage: {prompt_tokens, completion_tokens, cost?},
     provider, model}."""
    import httpx

    if job:
        jp, jm = route(job)
        provider, model = provider or jp, model or jm
    if provider not in PROVIDERS or not model:
        raise RuntimeError("no provider or model chosen")
    anthropic = await _anthropic_model(provider, model)
    base = PROVIDERS[provider]["base"]
    if anthropic:
        url, body = base + "/messages", _to_anthropic(messages, max_tokens, temperature, model)
    else:
        url, body = base + "/chat/completions", _openai_body(provider, model, messages, max_tokens,
                                                             temperature, reasoning)
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(url, json=body, headers=_headers(provider, anthropic))
    if r.status_code >= 400:
        raise _error(provider, r)
    d = r.json()
    if anthropic:
        text = "".join(b.get("text", "") for b in d.get("content") or [] if b.get("type") == "text")
        u = d.get("usage") or {}
        d = {"choices": [{"message": {"role": "assistant", "content": text}}],
             "usage": {"prompt_tokens": u.get("input_tokens"), "completion_tokens": u.get("output_tokens")}}
    d["provider"], d["model"] = provider, model
    return d


async def stream(messages: list[dict], *, provider: str, model: str, max_tokens: int = 8000,
                 temperature: float | None = None) -> AsyncIterator[dict]:
    """The answer as it is written: {"text": ...} pieces, {"thinking": ...}
    while the model reasons, and a last {"usage": {...}}."""
    import httpx

    anthropic = await _anthropic_model(provider, model)
    base = PROVIDERS[provider]["base"]
    if anthropic:
        url, body = base + "/messages", _to_anthropic(messages, max_tokens, temperature, model, stream=True)
    else:
        url, body = base + "/chat/completions", _openai_body(provider, model, messages, max_tokens,
                                                             temperature, True, stream=True)
    usage: dict = {}
    async with httpx.AsyncClient(timeout=httpx.Timeout(TIMEOUT, read=300)) as client:
        async with client.stream("POST", url, json=body, headers=_headers(provider, anthropic)) as r:
            if r.status_code >= 400:
                await r.aread()
                raise _error(provider, r)
            async for line in r.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                try:
                    ev = json.loads(data)
                except ValueError:
                    continue
                if anthropic:
                    t = ev.get("type")
                    if t == "content_block_delta":
                        delta = ev.get("delta") or {}
                        if delta.get("type") == "text_delta":
                            yield {"text": delta.get("text", "")}
                        elif delta.get("type") == "thinking_delta":
                            yield {"thinking": delta.get("thinking", "")}
                    elif t == "message_start":
                        u = (ev.get("message") or {}).get("usage") or {}
                        usage["prompt_tokens"] = u.get("input_tokens")
                    elif t == "message_delta":
                        usage["completion_tokens"] = (ev.get("usage") or {}).get("output_tokens")
                    elif t == "error":
                        raise RuntimeError(str((ev.get("error") or {}).get("message") or ev)[:300])
                    continue
                if ev.get("usage"):
                    usage = {k: ev["usage"].get(k) for k in ("prompt_tokens", "completion_tokens", "cost")}
                for ch in ev.get("choices") or []:
                    delta = ch.get("delta") or {}
                    if delta.get("reasoning_content") or delta.get("reasoning"):
                        yield {"thinking": delta.get("reasoning_content") or delta.get("reasoning")}
                    if delta.get("content"):
                        yield {"text": delta["content"]}
    yield {"usage": usage}


async def record(db, *, provider: str, model: str, surface: str, kind: str, used: dict) -> None:
    """Count the call in the app's usage, like every other model call."""
    import uuid

    from . import usage as _usage
    try:
        await _usage.record_call(
            db, _id=f"{provider[:2]}:{uuid.uuid4().hex[:16]}", provider=provider, surface=surface,
            kind=kind, model=model, input=used.get("prompt_tokens") or 0,
            output=used.get("completion_tokens") or 0, cache_read=0, cache_write=0, thinking=0,
            cost_usd=used.get("cost"), cost_basis="billed" if used.get("cost") is not None else "unpriced",
            revision=None)
    except Exception:                                  # noqa: BLE001 - the answer matters more
        log.warning("could not record a %s call", provider)


# ---------------- the Command Code account ----------------
#
# Command Code has no documented account API, but four "alpha" endpoints
# answer the provider key as a bearer token (found October 2026): who the
# key belongs to, the plan, the credits with the 5-hour and weekly usage
# windows, and a summary of the billing period's requests. Undocumented
# means any of them may go, change shape or start refusing: each is asked
# on its own (10 s each, in parallel), every field is optional, and a part
# that does not answer is left out - the page says "Command Code didn't
# share usage" when none does, and shows the last figures it had (kept in
# the settings document) when Command Code is down.
#
# The key goes in the Authorization header and nowhere else: not in what
# the page is sent, not in the log (errors are logged by their type only).
#
# A point of the windows is kept every ten minutes for 14 days
# (`cc_usage_points`, a TTL index) for the page's chart, and the weekly
# window crossing 90% - and running out - writes one alert
# (`cc_usage_alerts`) that the Telegram watcher (tgbot/notify.py) sends to
# the owner and the admins who want it.

CC_ALPHA = "https://api.commandcode.ai/alpha"
CC_PARTS = {"whoami": "/whoami", "credits": "/billing/credits",
            "subscription": "/billing/subscriptions", "usage": "/usage/summary"}
CC_TIMEOUT = 10.0
CC_TTL = 60                     # one look a minute at most, however many pages ask
CC_FORCE_GAP = 10               # the refresh button, pressed again and again
CC_POINTS = "cc_usage_points"
CC_POINT_EVERY = 600            # one point per ten minutes
CC_KEEP_DAYS = 14
CC_ALERTS = "cc_usage_alerts"
CC_WARN = 0.9                   # the weekly window this full: one message
CC_REARM = 0.8                  # and below this again, the next crossing is told too
CC_LOOP_S = 600

_cc: dict = {"at": 0.0, "key": None, "data": None}
_cc_locks: dict = {}
_cc_ttl_made = False
# For the tests: an httpx transport that stands in for Command Code.
_cc_transport = None


def _raw(db):
    return db.raw if getattr(type(db), "SCOPED", False) else db


def _num(v) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        f = float(v)
    elif isinstance(v, str):
        try:
            f = float(v.strip())
        except ValueError:
            return None
    else:
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _int(v) -> int | None:
    f = _num(v)
    return int(f) if f is not None else None


def _dict(v) -> dict:
    return v if isinstance(v, dict) else {}


def _ms(v) -> int | None:
    """A time as epoch milliseconds: from milliseconds, seconds or ISO text."""
    f = _num(v)
    if f is not None:
        if f <= 0:
            return None
        return int(f if f >= 1e11 else f * 1000)
    if isinstance(v, str) and v.strip():
        from datetime import datetime, timezone
        try:
            d = datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return int(d.timestamp() * 1000)
    return None


def _str(v, n: int = 120) -> str | None:
    return v.strip()[:n] if isinstance(v, str) and v.strip() else None


def _window(w) -> dict | None:
    w = _dict(w)
    used, cap = _num(w.get("used")), _num(w.get("cap"))
    if used is None and cap is None:
        return None
    pct = round(100 * used / cap, 1) if used is not None and cap else None
    return {"used": used, "cap": cap, "pct": pct,
            "exceeded": bool(w.get("exceeded")) or (pct is not None and pct >= 100),
            "reset_at": _ms(w.get("resetAt"))}


def _plan_name(pid: str | None) -> str | None:
    """"individual-goat" -> "Individual Goat"."""
    if not pid:
        return None
    return " ".join(p.capitalize() for p in pid.replace("_", "-").split("-") if p)


def cc_parse(parts: dict) -> dict:
    """The four answers (any of them None) as the page's figures. Nothing
    here trusts a field to be there or to be the type it was."""
    who = _dict(parts.get("whoami"))
    user = _dict(who.get("user"))
    org = who.get("org")
    org_name = _str(org.get("name")) if isinstance(org, dict) else _str(org)
    account = None
    if user:
        account = {"name": _str(user.get("name")), "user_name": _str(user.get("userName")),
                   "email": _str(user.get("email"), 200), "org": org_name}

    sub = _dict(_dict(parts.get("subscription")).get("data"))
    plan = None
    if sub:
        pid = _str(sub.get("planId"))
        plan = {"id": pid, "name": _plan_name(pid), "status": _str(sub.get("status"), 40),
                "period_start": _ms(sub.get("currentPeriodStart")),
                "period_end": _ms(sub.get("currentPeriodEnd")),
                "cancel_at_period_end": bool(sub.get("cancelAtPeriodEnd"))}

    cr = _dict(parts.get("credits"))
    c = _dict(cr.get("credits"))
    wl = _dict(cr.get("windowLimits"))
    credits = None
    if c:
        credits = {"monthly_left": _num(c.get("monthlyCredits")), "purchased": _num(c.get("purchasedCredits")),
                   "free": _num(c.get("freeCredits")), "threshold": _num(c.get("creditThreshold")),
                   "below_threshold": bool(c.get("belowThreshold")) if "belowThreshold" in c else None}
    windows = {"five_hour": _window(wl.get("fiveHour")), "weekly": _window(wl.get("weekly")),
               "limited": bool(wl.get("limited")) if "limited" in wl else None,
               "exceeded": bool(wl.get("exceeded")) if "exceeded" in wl else None}

    us = _dict(parts.get("usage"))
    usage = None
    if us:
        total, done = _int(us.get("totalCount")), _int(us.get("completedCount"))
        if total and done is not None:
            success = round(100 * done / total, 1)
        else:
            rate = _num(us.get("successRate"))
            success = None if rate is None else round(rate * 100 if rate <= 1 else rate, 1)
        tin, tout = _num(us.get("totalTokensIn")), _num(us.get("totalTokensOut"))
        tokens = _num(us.get("totalTokens"))
        if tokens is None and (tin is not None or tout is not None):
            tokens = (tin or 0) + (tout or 0)
        usage = {"requests": total, "completed": done, "failed": _int(us.get("failedCount")),
                 "success_pct": success, "cost_total": _num(us.get("totalCost")),
                 "cost_avg": _num(us.get("averageCost")), "credits": _num(us.get("totalCredits")),
                 "credits_monthly": _num(us.get("totalMonthlyCredits")),
                 "credits_purchased": _num(us.get("totalPurchasedCredits")),
                 "credits_free": _num(us.get("totalFreeCredits")),
                 "tokens_in": tin, "tokens_out": tout, "tokens": tokens,
                 "basis": _str(us.get("periodBasis"), 40)}
    # The month, as far as it can be told: what the period's usage spent of
    # the monthly credits, against that plus what Command Code says is left
    # (monthlyCredits is read as what is left - its name does not say).
    # Derived, so marked so; no share of a cap when the sum cannot be one.
    windows["monthly"] = None
    if usage and credits:
        spent = usage["credits_monthly"] if usage["credits_monthly"] is not None else usage["credits"]
        left = credits["monthly_left"]
        if spent is not None and left is not None:
            cap = spent + left if left >= 0 else None
            pct = round(100 * spent / cap, 1) if cap else None
            windows["monthly"] = {"used": spent, "cap": cap, "pct": pct, "exceeded": left <= 0,
                                  "reset_at": (plan or {}).get("period_end"), "left": left, "derived": True}
    return {"account": account, "plan": plan, "credits": credits, "windows": windows, "usage": usage}


async def _cc_fetch(k: str) -> dict:
    """{part: (HTTP status or None, the JSON object or None, what went wrong or None)}."""
    import asyncio

    import httpx

    kw = {"transport": _cc_transport} if _cc_transport is not None else {}
    async with httpx.AsyncClient(timeout=CC_TIMEOUT, base_url=CC_ALPHA,
                                 headers={"Authorization": f"Bearer {k}", "Accept": "application/json"},
                                 **kw) as client:
        async def one(path: str):
            try:
                r = await client.get(path)
            except Exception as exc:                   # noqa: BLE001 - a part that did not come
                return None, None, type(exc).__name__
            if r.status_code >= 400:
                return r.status_code, None, f"HTTP {r.status_code}"
            try:
                body = r.json()
            except ValueError:
                return r.status_code, None, "not JSON"
            if not isinstance(body, dict) or body.get("success") is False:
                return r.status_code, None, "no figures"
            return r.status_code, body, None

        got = await asyncio.gather(*(one(p) for p in CC_PARTS.values()))
    return dict(zip(CC_PARTS, got))


def _cc_lock():
    import asyncio
    loop = asyncio.get_running_loop()
    lock = _cc_locks.get(id(loop))
    if lock is None:
        _cc_locks.clear()
        lock = _cc_locks[id(loop)] = asyncio.Lock()
    return lock


def _key_tag(k: str) -> str:
    import hashlib
    return hashlib.sha256(k.encode()).hexdigest()[:16]


async def cc_account(db=None, *, force: bool = False, now: float | None = None) -> dict:
    """The Command Code account's figures, at most a minute old (ten
    seconds with `force`): {set, shared, stale, at, account, plan, credits,
    windows, usage, answers}. `answers` is what each endpoint said (a
    status, never a body). Without a key: {set: False}."""
    k = key("commandcode")
    if not k:
        return {"set": False, "shared": False}
    tag = _key_tag(k)

    def fresh(t: float) -> dict | None:
        hit = _cc["data"]
        if hit is not None and _cc["key"] == tag and t - _cc["at"] < (CC_FORCE_GAP if force else CC_TTL):
            return hit
        return None

    t = now if now is not None else time.time()
    if (hit := fresh(t)) is not None:
        return hit
    async with _cc_lock():
        t = now if now is not None else time.time()
        if (hit := fresh(t)) is not None:
            return hit
        got = await _cc_fetch(k)
        answers = {n: (st if st is not None else err) for n, (st, _b, err) in got.items()}
        bodies = {n: b for n, (_s, b, _e) in got.items()}
        bad = {n: a for n, a in answers.items() if bodies.get(n) is None}
        if bad:
            log.info("Command Code account: %s", ", ".join(f"{n} {a}" for n, a in bad.items()))
        from datetime import datetime, timezone
        at = datetime.fromtimestamp(t, timezone.utc).isoformat()
        raw = _raw(db) if db is not None else None
        if any(b is not None for b in bodies.values()):
            data = {"set": True, "shared": True, "stale": False, "at": at, **cc_parse(bodies),
                    "answers": answers}
            if raw is not None:
                await _cc_after(raw, data, t)
        else:
            last = await _cc_last(raw) if raw is not None else None
            if last:
                data = {**last, "set": True, "shared": True, "stale": True, "answers": answers}
            else:
                data = {"set": True, "shared": False, "stale": False, "at": at, "answers": answers}
        _cc.update(at=t, key=tag, data=data)
        return data


async def _cc_last(raw) -> dict | None:
    try:
        doc = await raw[COLL].find_one({"_id": DOC_ID}, {"cc_account": 1}) or {}
    except Exception:                                  # noqa: BLE001
        return None
    last = doc.get("cc_account")
    return last if isinstance(last, dict) and last.get("at") else None


async def _cc_after(raw, data: dict, t: float) -> None:
    """A good answer: kept as the last one, a point for the chart, and the
    weekly window's alert looked at. None of it may stop the page."""
    keep = {k: data.get(k) for k in ("at", "account", "plan", "credits", "windows", "usage")}
    try:
        await raw[COLL].update_one({"_id": DOC_ID}, {"$set": {"cc_account": keep}}, upsert=True)
    except Exception as exc:                           # noqa: BLE001
        log.warning("Command Code account not kept: %s", type(exc).__name__)
    try:
        await cc_point(raw, data, t)
    except Exception as exc:                           # noqa: BLE001
        log.warning("Command Code usage point not kept: %s", type(exc).__name__)
    try:
        await cc_check_alert(raw, data, t)
    except Exception as exc:                           # noqa: BLE001
        log.warning("Command Code usage alert not checked: %s", type(exc).__name__)


async def cc_point(raw, data: dict, t: float) -> dict | None:
    """One point per ten minutes (the latest look in it), kept 14 days."""
    from datetime import datetime, timezone
    global _cc_ttl_made
    win = _dict(data.get("windows"))
    weekly, five = _dict(win.get("weekly")), _dict(win.get("five_hour"))
    cred, usage = _dict(data.get("credits")), _dict(data.get("usage"))
    point = {"weekly_used": weekly.get("used"), "weekly_cap": weekly.get("cap"),
             "five_used": five.get("used"), "five_cap": five.get("cap"),
             "monthly_left": cred.get("monthly_left"), "total_credits": usage.get("credits")}
    if all(v is None for v in point.values()):
        return None
    # When each window says it resets - kept to tell, over the days, whether
    # Command Code's weekly window is fixed (resetAt stays until it resets,
    # then the window empties) or rolling (resetAt moves on while the usage
    # stays). The page labels it by what the points show.
    point["weekly_reset"], point["five_reset"] = weekly.get("reset_at"), five.get("reset_at")
    if not _cc_ttl_made:
        try:
            await raw[CC_POINTS].create_index("at", expireAfterSeconds=CC_KEEP_DAYS * 86400)
            _cc_ttl_made = True
        except Exception as exc:                       # noqa: BLE001 - cc_history still cuts at 14 days
            log.warning("Command Code usage TTL index not made: %s", type(exc).__name__)
    bucket = int(t // CC_POINT_EVERY) * CC_POINT_EVERY
    doc = {"_id": bucket, "at": datetime.fromtimestamp(bucket, timezone.utc), **point}
    await raw[CC_POINTS].replace_one({"_id": bucket}, doc, upsert=True)
    return doc


async def cc_history(raw, now: float | None = None) -> list[dict]:
    """The last 14 days' points, oldest first: {t (ms), weekly_used, ...}."""
    t = now if now is not None else time.time()
    since = int(t - CC_KEEP_DAYS * 86400)
    out = []
    async for d in raw[CC_POINTS].find({"_id": {"$gte": since}}).sort("_id", 1):
        out.append({"t": int(d["_id"]) * 1000,
                    **{k: d.get(k) for k in ("weekly_used", "weekly_cap", "five_used", "five_cap",
                                             "monthly_left", "total_credits", "weekly_reset", "five_reset")}})
    return out


def cc_window_kind(history: list[dict], used_key: str = "weekly_used", reset_key: str = "weekly_reset") -> str:
    """What our own points show about a window: "fixed" (its resetAt moved
    only when the window emptied), "rolling" (resetAt moved on while the
    usage stayed - the oldest use dropping off), or "unknown" (it has not
    moved yet in what we kept)."""
    kind = "unknown"
    prev = None
    for p in history:
        r, u = p.get(reset_key), p.get(used_key)
        if r is None or u is None:
            continue
        if prev and prev[0] is not None and r != prev[0] and abs(r - prev[0]) > 60_000:
            if u < 0.2 * prev[1] or u <= 1e-9:
                if kind == "unknown":
                    kind = "fixed"
            else:
                return "rolling"
        prev = (r, u)
    return kind


def cc_alert_step(state: dict | None, weekly: dict | None, now_ms: int) -> tuple[str | None, dict]:
    """Whether the weekly window's state is news: ("90" | "exceeded" | None,
    the new state). Each level is told once per window. It is told again
    once the window it was told in has reset (its resetAt has passed), or
    the window has emptied below 80% - whichever Command Code's window
    does, fixed or rolling."""
    state = dict(state or {})
    fired = set(state.get("fired") or [])
    reset = state.get("reset_at")
    if reset and now_ms >= reset:
        fired.clear()
    weekly = weekly or {}
    used, cap = weekly.get("used"), weekly.get("cap")
    ratio = used / cap if isinstance(used, (int, float)) and isinstance(cap, (int, float)) and cap > 0 else None
    exceeded = bool(weekly.get("exceeded")) or (ratio is not None and ratio >= 1)
    if ratio is not None and ratio < CC_REARM and not exceeded:
        fired.clear()
    level = None
    if exceeded and "exceeded" not in fired:
        level = "exceeded"
        fired |= {"90", "exceeded"}
    elif ratio is not None and ratio >= CC_WARN and "90" not in fired:
        level = "90"
        fired.add("90")
    return level, {"fired": sorted(fired), "reset_at": weekly.get("reset_at") or reset}


async def cc_check_alert(raw, data: dict, t: float) -> str | None:
    """Look at the weekly window; write an alert when it is news. The state
    is changed only if nobody changed it since it was read, so two looks at
    once write one alert."""
    import uuid
    from datetime import datetime, timezone

    weekly = _dict(_dict(data.get("windows")).get("weekly"))
    if not weekly:
        return None
    doc = await raw[COLL].find_one({"_id": DOC_ID}, {"cc_alert": 1}) or {}
    old = _dict(doc.get("cc_alert"))
    level, new = cc_alert_step(old, weekly, int(t * 1000))
    if not level and new["fired"] == sorted(old.get("fired") or []) and new["reset_at"] == old.get("reset_at"):
        return None
    v = old.get("v") or 0
    new["v"] = v + 1
    q = {"_id": DOC_ID, "cc_alert.v": v} if v else {"_id": DOC_ID, "cc_alert.v": {"$exists": False}}
    res = await raw[COLL].update_one(q, {"$set": {"cc_alert": new}})
    if not getattr(res, "modified_count", 0):
        return None
    if level:
        plan = _dict(data.get("plan"))
        await raw[CC_ALERTS].insert_one({
            "_id": uuid.uuid4().hex, "at": datetime.fromtimestamp(t, timezone.utc), "level": level,
            "used": weekly.get("used"), "cap": weekly.get("cap"), "pct": weekly.get("pct"),
            "reset_at": weekly.get("reset_at"), "plan": plan.get("name")})
        log.info("Command Code weekly window: %s alert written", level)
    return level


async def cc_loop(raw_getter) -> None:
    """Every ten minutes, while a Command Code key is saved: a look at the
    account, so the chart has its points and the alert comes on time even
    when nobody has the page open."""
    import asyncio
    await asyncio.sleep(30)
    while True:
        try:
            if key("commandcode"):
                await cc_account(raw_getter(), force=True)
        except Exception as exc:                       # noqa: BLE001 - try again next time
            log.warning("Command Code account not read: %s", type(exc).__name__)
        await asyncio.sleep(CC_LOOP_S)


# ---------------- the month, analysed ----------------
#
# Command Code keeps no usage history a key can read: of the paths tried
# (/alpha/usage/daily, /history, /records, /models, /list, /by-model ...,
# October 2026) all answer 404, and /usage/summary ignores groupBy, from/to,
# until and model. It does take `since` (an ISO datetime): the totals from
# then until now. So a day's spend is the difference of two of those -
# since its start, minus since the next day's - and a finished day never
# changes again, so it is kept (`cc_usage_days`) and asked once. Days are
# Istanbul's (UTC+3), as the Telegram digest's.
#
# When `since` stops working, the days come from our own ten-minute points
# instead (total credits, day over day), and the page says since when we
# have been tracking.
#
# Nothing here says which model spent what - Command Code does not tell.
# What Redline itself asked of Command Code is in its own call log
# (llm_calls), by model and by job; the rest of the account's requests and
# tokens are other clients' (the Claude Code CLI, agents).

CC_DAYS = "cc_usage_days"
CC_TZ_H = 3
CC_ANALYSIS_TTL = 600
CC_SINCE_PAR = 4                # Command Code asked at most this many at once
_cc_an: dict = {"at": 0.0, "key": None, "data": None}


def _day_start(ms: int) -> int:
    """The start (ms) of the Istanbul day `ms` falls in."""
    off = CC_TZ_H * 3_600_000
    return (ms + off) // 86_400_000 * 86_400_000 - off


def _day_name(ms: int) -> str:
    from datetime import datetime, timedelta, timezone
    return datetime.fromtimestamp(ms / 1000, timezone(timedelta(hours=CC_TZ_H))).strftime("%Y-%m-%d")


def _iso_ms(ms: int) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


async def _cc_since(k: str, bounds: list[int]) -> dict[int, dict | None]:
    """/usage/summary?since=<each bound>: {bound: the totals, or None}."""
    import asyncio

    import httpx

    kw = {"transport": _cc_transport} if _cc_transport is not None else {}
    sem = asyncio.Semaphore(CC_SINCE_PAR)
    async with httpx.AsyncClient(timeout=CC_TIMEOUT, base_url=CC_ALPHA,
                                 headers={"Authorization": f"Bearer {k}", "Accept": "application/json"},
                                 **kw) as client:
        async def one(b: int):
            async with sem:
                try:
                    r = await client.get(CC_PARTS["usage"], params={"since": _iso_ms(b)})
                    d = r.json() if r.status_code < 400 else None
                except Exception:                      # noqa: BLE001 - that day is unknown
                    return b, None
            return b, d if isinstance(d, dict) and _num(d.get("totalCredits")) is not None else None

        got = await asyncio.gather(*(one(b) for b in sorted(set(bounds))))
    return dict(got)


def _totals(d: dict | None) -> dict | None:
    if d is None:
        return None
    return {"credits": _num(d.get("totalCredits")) or 0.0, "requests": _int(d.get("totalCount")) or 0,
            "tokens_in": _num(d.get("totalTokensIn")) or 0.0, "tokens_out": _num(d.get("totalTokensOut")) or 0.0}


def _minus(a: dict, b: dict) -> dict:
    return {k: max(0, a[k] - b[k]) for k in a}


async def cc_days(raw, k: str, start_ms: int, now_ms: int) -> tuple[list[dict], str]:
    """The period's days, oldest first: {date, start, credits, requests,
    tokens_in, tokens_out, partial}, and where they came from
    ("command-code" or "none")."""
    bounds, b = [], start_ms
    while b < now_ms:
        bounds.append(b)
        b = _day_start(b) + 86_400_000
    if not bounds:
        return [], "none"
    kept = {}
    try:
        async for d in raw[CC_DAYS].find({"start": {"$gte": start_ms}}):
            kept[d["start"]] = d
    except Exception:                                  # noqa: BLE001
        kept = {}
    ends = bounds[1:] + [None]
    want = set()
    for s, e in zip(bounds, ends):
        if s not in kept or e is None:
            want.add(s)
            if e is not None:
                want.add(e)
    got = await _cc_since(k, sorted(want)) if want else {}
    if want and all(v is None for v in got.values()):
        return [], "none"
    out = []
    for s, e in zip(bounds, ends):
        if s in kept and e is not None:
            d = kept[s]
            out.append({"date": d["_id"], "start": s, **{f: d.get(f) for f in ("credits", "requests", "tokens_in",
                                                                                "tokens_out")}, "partial": False})
            continue
        a = _totals(got.get(s))
        z = _totals(got.get(e)) if e is not None else {"credits": 0.0, "requests": 0, "tokens_in": 0.0,
                                                       "tokens_out": 0.0}
        if a is None or z is None:
            out.append({"date": _day_name(s), "start": s, "credits": None, "requests": None,
                        "tokens_in": None, "tokens_out": None, "partial": e is None})
            continue
        day = {"date": _day_name(s), "start": s, **_minus(a, z), "partial": e is None}
        out.append(day)
        if e is not None:                              # a finished day: asked once
            try:
                await raw[CC_DAYS].replace_one({"_id": day["date"]}, {
                    "_id": day["date"], "start": s, **{f: day[f] for f in ("credits", "requests", "tokens_in",
                                                                           "tokens_out")}}, upsert=True)
            except Exception:                          # noqa: BLE001
                pass
    return out, "command-code"


async def cc_days_from_points(raw, start_ms: int, now_ms: int) -> tuple[list[dict], int | None]:
    """The same days from our own points (total credits, day over day) -
    when Command Code's `since` does not answer. And since when we have points."""
    rows = [d async for d in raw[CC_POINTS].find({"_id": {"$gte": start_ms // 1000 - 86400}}).sort("_id", 1)]
    rows = [r for r in rows if r.get("total_credits") is not None]
    if len(rows) < 2:
        return [], (int(rows[0]["_id"]) * 1000 if rows else None)
    last_of_day: dict[int, float] = {}
    for r in rows:
        last_of_day[_day_start(int(r["_id"]) * 1000)] = r["total_credits"]
    days = sorted(last_of_day)
    out, prev = [], None
    for dstart in days:
        v = last_of_day[dstart]
        if prev is not None and dstart >= _day_start(start_ms):
            out.append({"date": _day_name(dstart), "start": dstart, "credits": max(0.0, v - prev) if v >= prev else v,
                        "requests": None, "tokens_in": None, "tokens_out": None,
                        "partial": dstart == _day_start(now_ms)})
        prev = v
    return out, int(rows[0]["_id"]) * 1000


async def redline_share(raw, since_ms: int) -> dict:
    """What Redline itself asked of Command Code since then, from its own
    call log: requests and tokens, by model and by job."""
    from datetime import datetime, timezone

    from . import usage as _usage
    since = datetime.fromtimestamp(since_ms / 1000, timezone.utc).isoformat()
    tot = {"requests": 0, "tokens_in": 0, "tokens_out": 0}
    by_model: dict[str, dict] = {}
    by_job: dict[str, dict] = {}
    async for r in raw[_usage.CALLS].find({"provider": "commandcode", "at": {"$gte": since}},
                                          {"_id": 0, "model": 1, "kind": 1, "input": 1, "output": 1}):
        i, o = r.get("input") or 0, r.get("output") or 0
        for table, name in ((by_model, r.get("model") or "?"), (by_job, job_label(r.get("kind")))):
            row = table.setdefault(name, {"name": name, "requests": 0, "tokens_in": 0, "tokens_out": 0})
            row["requests"] += 1
            row["tokens_in"] += i
            row["tokens_out"] += o
        tot["requests"] += 1
        tot["tokens_in"] += i
        tot["tokens_out"] += o
    order = lambda t: sorted(t.values(), key=lambda x: -x["requests"])   # noqa: E731
    return {**tot, "by_model": order(by_model), "by_job": order(by_job)}


async def cc_analysis(db, *, force: bool = False, now: float | None = None) -> dict:
    """The billing period so far: spend per day, the last 7 days' burn rate
    and where it leads, the weekly window, and Redline's share. Every figure
    says where it is from."""
    k = key("commandcode")
    if not k:
        return {"set": False}
    tag = _key_tag(k)
    t = now if now is not None else time.time()
    hit = _cc_an["data"]
    if hit is not None and _cc_an["key"] == tag and t - _cc_an["at"] < (CC_FORCE_GAP * 6 if force else CC_ANALYSIS_TTL):
        return hit
    raw = _raw(db)
    acct = await cc_account(db, now=now)
    if not acct.get("shared"):
        return {"set": True, "shared": False}
    now_ms = int(t * 1000)
    plan = acct.get("plan") or {}
    start = plan.get("period_start") or _day_start(now_ms) - 29 * 86_400_000
    end = plan.get("period_end")
    days, source = await cc_days(raw, k, int(start), now_ms)
    tracked_since = None
    if source == "none":
        days, tracked_since = await cc_days_from_points(raw, int(start), now_ms)
        source = "snapshots" if days else "none"
    # the last 7 days: one ask of its own, else the days' sum
    week = None
    got = await _cc_since(k, [now_ms - 7 * 86_400_000]) if source == "command-code" else {}
    w7 = _totals(next(iter(got.values()), None)) if got else None
    if w7:
        week = {**w7, "per_day": w7["credits"] / 7, "source": "command-code"}
    elif days:
        last = [d for d in days if d["start"] >= now_ms - 7 * 86_400_000 and d["credits"] is not None]
        if last:
            span_d = max(1.0, (now_ms - last[0]["start"]) / 86_400_000)
            c = sum(d["credits"] for d in last)
            week = {"credits": c, "requests": None, "tokens_in": None, "tokens_out": None,
                    "per_day": c / span_d, "source": source}
    monthly = (acct.get("windows") or {}).get("monthly") or {}
    spent, left, cap = monthly.get("used"), monthly.get("left"), monthly.get("cap")
    proj = None
    if week and spent is not None:
        days_left = max(0.0, (end - now_ms) / 86_400_000) if end else None
        rate = week["per_day"]
        at_end = spent + rate * days_left if days_left is not None else None
        runs_out = None
        if rate > 0 and left is not None and left > 0:
            runs_out = now_ms + int(left / rate * 86_400_000)
            if end and runs_out >= end:
                runs_out = None
        proj = {"burn_per_day": rate, "spent": spent, "left": left, "allowance": cap, "days_left": days_left,
                "at_end": at_end, "at_end_pct": round(100 * at_end / cap, 1) if at_end is not None and cap else None,
                "runs_out_at": runs_out}
    weekly = (acct.get("windows") or {}).get("weekly") or None
    weeks_left = None
    if weekly and weekly.get("reset_at") and end:
        weeks_left = max(0, int((end - weekly["reset_at"]) // (7 * 86_400_000)))
    try:
        mine = await redline_share(raw, int(start))
    except Exception as exc:                           # noqa: BLE001
        log.warning("Redline's Command Code calls not read: %s", type(exc).__name__)
        mine = None
    us = acct.get("usage") or {}
    others = None
    if mine is not None and us.get("requests") is not None:
        others = {"requests": max(0, (us.get("requests") or 0) - mine["requests"]),
                  "tokens_in": max(0, (us.get("tokens_in") or 0) - mine["tokens_in"]),
                  "tokens_out": max(0, (us.get("tokens_out") or 0) - mine["tokens_out"])}
    data = {"set": True, "shared": True, "at": acct.get("at"),
            "period": {"start": start, "end": end,
                       "days_total": round((end - start) / 86_400_000) if end else None,
                       "days_left": round((end - now_ms) / 86_400_000, 1) if end else None},
            "days": days, "days_source": source, "tracked_since": tracked_since,
            "week": week, "projection": proj,
            "weekly": {**weekly, "full_weeks_left": weeks_left} if weekly else None,
            "account_totals": {k2: us.get(k2) for k2 in ("requests", "tokens_in", "tokens_out", "credits")},
            "redline": mine, "others": others}
    _cc_an.update(at=t, key=tag, data=data)
    return data


# ---------------- the OpenRouter account ----------------
#
# OpenRouter documents two: GET /api/v1/key (this key: usage, limit,
# limit_remaining, is_free_tier, rate_limit) and GET /api/v1/credits (the
# account: total_credits bought, total_usage). Both take the key as a
# bearer token; /credits may refuse a key that is not allowed to read it -
# then only the key's figures show. Every field is optional, as with
# Command Code; the key's `label` is left out when it is the key itself,
# masked (OpenRouter labels an unnamed key "sk-or-v1-abc...xyz").

_or: dict = {"at": 0.0, "key": None, "data": None}
_or_transport = None            # for the tests


def or_parse(key_body: dict | None, credits_body: dict | None) -> dict:
    k = _dict(_dict(key_body).get("data"))
    c = _dict(_dict(credits_body).get("data"))
    key_out = None
    if k:
        label = _str(k.get("label"))
        if label and (label.lower().startswith("sk-") or "..." in label):
            label = None
        rl = _dict(k.get("rate_limit"))
        key_out = {"label": label, "usage": _num(k.get("usage")), "limit": _num(k.get("limit")),
                   "limit_remaining": _num(k.get("limit_remaining")),
                   "limit_reset": _str(k.get("limit_reset"), 20),
                   "is_free_tier": bool(k.get("is_free_tier")) if "is_free_tier" in k else None,
                   "usage_daily": _num(k.get("usage_daily")), "usage_weekly": _num(k.get("usage_weekly")),
                   "usage_monthly": _num(k.get("usage_monthly")),
                   "rate_limit": {"requests": _int(rl.get("requests")), "interval": _str(rl.get("interval"), 20)}
                   if rl else None}
    credits = None
    if c:
        total, used = _num(c.get("total_credits")), _num(c.get("total_usage"))
        credits = {"total": total, "used": used,
                   "left": round(total - used, 6) if total is not None and used is not None else None}
    return {"key": key_out, "credits": credits}


async def or_account(*, force: bool = False, now: float | None = None) -> dict:
    """OpenRouter's own figures for the saved key, at most a minute old:
    {set, shared, at, key, credits, answers}."""
    import asyncio

    import httpx

    k = key("openrouter")
    if not k:
        return {"set": False, "shared": False}
    tag = _key_tag(k)
    t = now if now is not None else time.time()
    hit = _or["data"]
    if hit is not None and _or["key"] == tag and t - _or["at"] < (CC_FORCE_GAP if force else CC_TTL):
        return hit
    kw = {"transport": _or_transport} if _or_transport is not None else {}
    async with httpx.AsyncClient(timeout=CC_TIMEOUT, base_url=PROVIDERS["openrouter"]["base"],
                                 headers={"Authorization": f"Bearer {k}"}, **kw) as client:
        async def one(path):
            try:
                r = await client.get(path)
            except Exception as exc:                   # noqa: BLE001
                return type(exc).__name__, None
            if r.status_code >= 400:
                return r.status_code, None
            try:
                body = r.json()
            except ValueError:
                return "not JSON", None
            return r.status_code, body if isinstance(body, dict) else None

        (ks, kb), (cs, cb) = await asyncio.gather(one("/key"), one("/credits"))
    answers = {"key": ks, "credits": cs}
    if kb is None and cb is None:
        log.info("OpenRouter account: key %s, credits %s", ks, cs)
    from datetime import datetime, timezone
    data = {"set": True, "shared": kb is not None or cb is not None,
            "at": datetime.fromtimestamp(t, timezone.utc).isoformat(), **or_parse(kb, cb), "answers": answers}
    _or.update(at=t, key=tag, data=data)
    return data


async def own_spend(raw, provider: str, now: float | None = None) -> dict:
    """What Redline itself asked of a provider, from its own call log: the
    last 30 days and this calendar month - calls, tokens, and the money
    when the provider priced the calls."""
    from datetime import datetime, timedelta, timezone

    from . import usage as _usage
    t = datetime.fromtimestamp(now if now is not None else time.time(), timezone.utc)
    month0 = t.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    since = min(month0, t - timedelta(days=30))
    out = {"month": {"calls": 0, "input": 0, "output": 0, "cost_usd": None},
           "days30": {"calls": 0, "input": 0, "output": 0, "cost_usd": None}}
    by_model: dict[str, dict] = {}
    async for r in raw[_usage.CALLS].find({"provider": provider, "at": {"$gte": since.isoformat()}},
                                          {"_id": 0, "at": 1, "model": 1, "input": 1, "output": 1, "cost_usd": 1}):
        try:
            at = datetime.fromisoformat(r["at"])
        except (KeyError, TypeError, ValueError):
            continue
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        usd = r.get("cost_usd")
        for name, start in (("month", month0), ("days30", t - timedelta(days=30))):
            if at >= start:
                b = out[name]
                b["calls"] += 1
                b["input"] += r.get("input") or 0
                b["output"] += r.get("output") or 0
                if usd is not None:
                    b["cost_usd"] = (b["cost_usd"] or 0) + usd
        if at >= t - timedelta(days=30):
            m = by_model.setdefault(r.get("model") or "?", {"name": r.get("model") or "?", "calls": 0, "cost_usd": None})
            m["calls"] += 1
            if usd is not None:
                m["cost_usd"] = (m["cost_usd"] or 0) + usd
    out["by_model"] = sorted(by_model.values(), key=lambda x: -x["calls"])
    return out


# ---------------- the providers, as the settings page shows them ----------------
#
# One entry per provider, so adding one (OpenCode, say) is a row in
# PROVIDERS for the calls and a row here for the page: where its key comes
# from, how its account is read, and whether its calls are priced. The page
# draws a card for each, in this order.

async def _cc_account_any(db, force: bool = False) -> dict:
    return await cc_account(db, force=force)


async def _or_account_any(db, force: bool = False) -> dict:
    return await or_account(force=force)


REGISTRY = {
    "commandcode": {"account": _cc_account_any, "analysis": True,
                    "about": "Qwen, GLM, Kimi, Claude and more under one subscription; plan windows and credits"},
    "openrouter": {"account": _or_account_any, "analysis": False,
                   "about": "hundreds of models, paid per call; every call is priced"},
}


def registry() -> list[dict]:
    """The providers in the page's order: id, name, where a key is had,
    whether the calls are priced, whether an account can be read."""
    out = []
    for pid, extra in REGISTRY.items():
        info = PROVIDERS[pid]
        out.append({"id": pid, "name": info["name"], "site": info["site"], "priced": info["priced"],
                    "about": extra["about"], "account": extra["account"] is not None,
                    "analysis": extra["analysis"]})
    return out


async def provider_account(db, provider: str, force: bool = False) -> dict:
    if provider not in REGISTRY:
        raise ValueError(f"unknown provider {provider!r}")
    fetch = REGISTRY[provider]["account"]
    if fetch is None:
        return {"set": bool(key(provider)), "shared": False}
    return await fetch(db, force)
