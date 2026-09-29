"""The tool pages' model call: what it refuses before anything is sent."""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from backend import tools_llm


def call(**body):
    body.setdefault("messages", [{"role": "user", "content": "hi"}])
    return asyncio.run(tools_llm.call(tools_llm.LlmIn(**body)))


def test_status_says_whether_a_key_is_set_and_never_shows_it(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key-not-real")
    s = asyncio.run(tools_llm.status())
    assert s["available"] is True and "test-key" not in repr(s)
    monkeypatch.delenv("OPENROUTER_API_KEY")
    assert asyncio.run(tools_llm.status())["available"] is False


def test_no_key_is_a_clear_503(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with pytest.raises(HTTPException) as e:
        call()
    assert e.value.status_code == 503


def test_only_offered_models_and_capped_input(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key-not-real")
    monkeypatch.setenv("X3_TOOLS_MODELS", "a/one,b/two")
    with pytest.raises(HTTPException) as e:
        call(model="c/three")
    assert e.value.status_code == 400 and "a/one" in e.value.detail
    with pytest.raises(HTTPException) as e:
        call(model="a/one", messages=[{"role": "user", "content": "x" * (tools_llm.MAX_INPUT_CHARS + 1)}])
    assert e.value.status_code == 413


def test_roles_and_answer_size_are_validated():
    with pytest.raises(Exception):
        tools_llm.LlmIn(messages=[{"role": "tool", "content": "x"}])
    with pytest.raises(Exception):
        tools_llm.LlmIn(messages=[{"role": "user", "content": "x"}], max_tokens=tools_llm.MAX_ANSWER + 1)


def test_the_rate_limit_answers_429(monkeypatch):
    monkeypatch.setattr(tools_llm, "_calls", tools_llm.deque([tools_llm.time.monotonic()] * tools_llm.PER_MINUTE))
    with pytest.raises(HTTPException) as e:
        tools_llm._admit()
    assert e.value.status_code == 429
