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


def models() -> list[str]:
    """The models a tool page may ask for: X3_TOOLS_MODELS (comma separated),
    or the app's own default model."""
    raw = os.environ.get("X3_TOOLS_MODELS", "")
    listed = [m.strip() for m in raw.split(",") if m.strip()]
    return listed or [summarise.MODEL]


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
    return {"available": bool(summarise.api_key()), "models": models(),
            "default": models()[0], "max_input_chars": MAX_INPUT_CHARS,
            "max_tokens": MAX_ANSWER, "per_minute": PER_MINUTE}


@router.post("")
async def call(body: LlmIn) -> dict:
    """{text, model, ms, usage: {prompt_tokens, completion_tokens, cost}}"""
    key = summarise.api_key()
    if not key:
        raise HTTPException(503, "no model key is configured on the server (OPENROUTER_API_KEY)")
    model = body.model or models()[0]
    if model not in models():
        raise HTTPException(400, f"model {model!r} is not offered; one of {', '.join(models())}")
    if sum(len(m.content) for m in body.messages) > MAX_INPUT_CHARS:
        raise HTTPException(413, f"the messages are over {MAX_INPUT_CHARS} characters together")
    _admit()
    import httpx

    payload = {"model": model, "messages": [m.model_dump() for m in body.messages],
               "max_tokens": body.max_tokens, "temperature": body.temperature,
               "reasoning": {"enabled": body.reasoning}, "usage": {"include": True}}
    t0 = time.monotonic()
    async with _gate:
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                r = await client.post(summarise.ENDPOINT, json=payload,
                                      headers={"Authorization": f"Bearer {key}",
                                               "Content-Type": "application/json"})
        except httpx.HTTPError as exc:
            raise HTTPException(502, f"the model did not answer: {exc}"[:300]) from exc
    ms = round((time.monotonic() - t0) * 1000)
    if r.status_code >= 400:
        raise HTTPException(502, f"the model provider answered HTTP {r.status_code}: {r.text[:200]}")
    data = r.json()
    try:
        text = data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as exc:
        raise HTTPException(502, "the model's answer had no text") from exc
    used = data.get("usage") or {}
    try:
        from . import usage as _usage
        from .tools_api import _db
        await _usage.record_call(
            _db(), _id=f"or:{uuid.uuid4().hex[:16]}", provider="openrouter",
            surface="tools", kind=f"tool-llm:{body.tool}" if body.tool else "tool-llm", model=model,
            input=used.get("prompt_tokens") or 0, output=used.get("completion_tokens") or 0,
            cache_read=0, cache_write=0, thinking=0, cost_usd=used.get("cost"),
            cost_basis="billed", revision=None)
    except Exception:                                  # noqa: BLE001 - the answer matters more
        pass
    return {"text": text, "model": model, "ms": ms,
            "usage": {"prompt_tokens": used.get("prompt_tokens"),
                      "completion_tokens": used.get("completion_tokens"),
                      "cost": used.get("cost")}}
