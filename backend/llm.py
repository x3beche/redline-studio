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
# answer, no prices on /models, no account or usage endpoint (checked
# October 2026) - so its calls are kept as unpriced, never guessed.
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
    "chat": {"label": "Command Code room",
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
KIND_LABELS = {"cc-title": "Command Code room titles", "llm-test": "Settings test"}


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
            "cheap": {"provider": CHEAP[0], "model": CHEAP[1]}}


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
