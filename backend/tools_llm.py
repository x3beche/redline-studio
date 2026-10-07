"""A model call for the tool pages: run a prompt for real, from the server.

The AI & prompts tools (Prompt Eval Grid and the like) draft prompts in the
browser; this is where one is actually sent to a model. The call goes out
from here with the server's OpenRouter key, which never reaches the page.
Each call is small by construction - capped input, capped answer, a fixed
list of models - counted in the app's usage like every other model call,
and rate limited so a grid of test cases cannot run away with the budget.
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from collections import deque

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import summarise

router = APIRouter(prefix="/api/tools/llm")

TIMEOUT = 60.0
MAX_INPUT_CHARS = 60_000        # all messages together, about 15k tokens
MAX_ANSWER = 2000               # tokens
PER_MINUTE = 60                 # calls, the whole server
CONCURRENT = 4


def options() -> list[tuple[str, str]]:
    """(provider, model) a tool page may ask for: the "tools" job's choice
    (Settings > LLM settings) first, then REDLINE_TOOLS_MODELS (comma
    separated OpenRouter models)."""
    from . import llm
    first = llm.route("tools")
    extra = [("openrouter", m.strip()) for m in os.environ.get("REDLINE_TOOLS_MODELS", "").split(",") if m.strip()]
    return [first] + [o for o in extra if o != first]


def models() -> list[str]:
    return [m for _, m in options()]


_calls: deque[float] = deque()
_gate = asyncio.Semaphore(CONCURRENT)


def _admit() -> None:
    now = time.monotonic()
    while _calls and now - _calls[0] > 60:
        _calls.popleft()
    if len(_calls) >= PER_MINUTE:
        raise HTTPException(429, f"more than {PER_MINUTE} model calls in a minute; wait a little")
    _calls.append(now)


class Message(BaseModel):
    role: str = Field(pattern="^(system|user|assistant)$")
    content: str


class LlmIn(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=50)
    model: str | None = None
    max_tokens: int = Field(400, ge=1, le=MAX_ANSWER)
    temperature: float = Field(0.2, ge=0, le=1.5)
    reasoning: bool = False                       # off: the answer gets every token asked for
    tool: str = Field("", max_length=64)          # which tool asked, for the usage log


@router.get("")
async def status() -> dict:
    return {"available": bool(summarise.api_key("tools")), "models": models(),
            "default": models()[0], "max_input_chars": MAX_INPUT_CHARS,
            "max_tokens": MAX_ANSWER, "per_minute": PER_MINUTE}


@router.post("")
async def call(body: LlmIn) -> dict:
    """{text, model, ms, usage: {prompt_tokens, completion_tokens, cost}}"""
    from . import llm

    model = body.model or models()[0]
    provider = dict((m, p) for p, m in reversed(options())).get(model)
    if not provider:
        raise HTTPException(400, f"model {model!r} is not offered; one of {', '.join(models())}")
    if not llm.key(provider):
        raise HTTPException(503, llm.no_key(provider, "tools"))
    if sum(len(m.content) for m in body.messages) > MAX_INPUT_CHARS:
        raise HTTPException(413, f"the messages are over {MAX_INPUT_CHARS} characters together")
    _admit()
    t0 = time.monotonic()
    async with _gate:
        try:
            data = await llm.complete([m.model_dump() for m in body.messages], provider=provider, model=model,
                                      max_tokens=body.max_tokens, temperature=body.temperature,
                                      reasoning=body.reasoning, timeout=TIMEOUT)
        except Exception as exc:                       # noqa: BLE001
            raise HTTPException(502, f"the model did not answer: {exc}"[:300]) from exc
    ms = round((time.monotonic() - t0) * 1000)
    try:
        text = data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as exc:
        raise HTTPException(502, "the model's answer had no text") from exc
    used = data.get("usage") or {}
    try:
        from . import usage as _usage
        from .tools_api import _db
        await _usage.record_call(
            _db(), _id=f"or:{uuid.uuid4().hex[:16]}", provider=provider,
            surface="tools", kind=f"tool-llm:{body.tool}" if body.tool else "tool-llm", model=model,
            input=used.get("prompt_tokens") or 0, output=used.get("completion_tokens") or 0,
            cache_read=0, cache_write=0, thinking=0, cost_usd=used.get("cost"),
            cost_basis="billed" if used.get("cost") is not None else "unpriced", revision=None)
    except Exception:                                  # noqa: BLE001 - the answer matters more
        pass
    return {"text": text, "model": model, "ms": ms,
            "usage": {"prompt_tokens": used.get("prompt_tokens"),
                      "completion_tokens": used.get("completion_tokens"),
                      "cost": used.get("cost")}}
