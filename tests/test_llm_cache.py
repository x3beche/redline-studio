"""The prompt cache: a conversation's long start marked for the provider's
cache where the provider takes the marks (backend/llm.py), what came from
the cache counted and priced, and the replayed history kept the same from
one line to the next so there is a start to cache (backend/cc_chat.py).
No real HTTP: an httpx.MockTransport stands in for the providers."""
import asyncio
import json

import httpx
import pytest

from backend import cc_chat, llm, scope
from tests.test_llm_providers import LogColl, body, collect, mock, sse

KEY_C = "sk-ant-test-0000-abcd"


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setattr(llm, "_conf", {"keys": {"claude": KEY_C, "opencode-go": "oc-test-1", "commandcode": "cc-test-1",
                                                "openrouter": "or-test-1"}, "jobs": {}})
    monkeypatch.setattr(llm, "_models_cache", {})
    monkeypatch.setattr(llm, "_NO_FALLBACK", set())
    monkeypatch.setattr(llm, "_NO_TEMPERATURE", set())
    monkeypatch.setattr(llm, "_NO_CACHE", set())


CLAUDE_EVENTS = [
    {"type": "message_start", "message": {"usage": {"input_tokens": 20, "cache_read_input_tokens": 9000,
                                                    "cache_creation_input_tokens": 1000}}},
    {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hi."}},
    {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 10}},
    {"type": "message_stop"},
]

TOOLS = [{"name": "drawer_search", "description": "d", "parameters": {"type": "object", "properties": {}}}]


def convo():
    """A conversation in a tool loop: two earlier lines, the question, a round of tools."""
    return [{"role": "system", "content": "be useful"},
            {"role": "user", "content": "first"}, {"role": "assistant", "content": "one"},
            {"role": "user", "content": "second"}, {"role": "assistant", "content": "two"},
            {"role": "user", "content": "third"},
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "t1", "type": "function", "function": {"name": "drawer_search", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "t1", "content": "found it"}]


def marks(obj) -> list:
    """Every cache mark in a request body, wherever it is."""
    out = []

    def walk(o, where):
        if isinstance(o, dict):
            if "cache_control" in o:
                out.append(where)
            for k, v in o.items():
                walk(v, f"{where}.{k}")
        elif isinstance(o, list):
            for i, v in enumerate(o):
                walk(v, f"{where}[{i}]")
    walk(obj, "")
    return out


def stream_events(monkeypatch, events=CLAUDE_EVENTS):
    return mock(monkeypatch, lambda req: httpx.Response(200, content=sse(events),
                                                        headers={"content-type": "text/event-stream"}))


def test_claude_marks_the_system_line_the_people_s_lines_and_the_last_turn(monkeypatch):
    seen = stream_events(monkeypatch)
    got = collect(llm.stream(convo(), provider="claude", model="claude-sonnet-5-5", tools=TOOLS))
    sent = body(seen[0])
    assert sent["system"] == [{"type": "text", "text": "be useful", "cache_control": {"type": "ephemeral"}}]
    msgs = sent["messages"]
    # the tool results (the last turn), the question, and the line before it: four marks with the system's
    assert msgs[-1]["content"][-1]["type"] == "tool_result" and msgs[-1]["content"][-1]["cache_control"]
    assert msgs[4]["content"] == [{"type": "text", "text": "third", "cache_control": {"type": "ephemeral"}}]
    assert msgs[2]["content"][-1]["cache_control"] and msgs[0]["content"] == "first"
    assert len(marks(sent)) == 4
    # the caller's lines are left as they were
    assert convo()[5] == {"role": "user", "content": "third"}
    used = got[-1]["usage"]
    assert used["prompt_tokens"] == 10_020 and used["cache_read_tokens"] == 9000 and used["cache_write_tokens"] == 1000
    # Sonnet 5.5 at $2/M in, $10/M out: fresh 20, read 9000 at a tenth, written 1000 at 1.25x
    assert used["cost"] == pytest.approx((20 * 2 + 9000 * 0.2 + 1000 * 2.5 + 10 * 10) / 1e6)


def test_without_a_system_line_the_tools_carry_the_mark(monkeypatch):
    seen = stream_events(monkeypatch)
    collect(llm.stream([{"role": "user", "content": "hi"}], provider="claude", model="claude-haiku-4-5", tools=TOOLS))
    sent = body(seen[0])
    assert sent["tools"][-1]["cache_control"] == {"type": "ephemeral"} and "system" not in sent
    assert sent["messages"][0]["content"][0]["cache_control"]
    assert len(marks(sent)) == 2


def test_a_turn_ending_in_thinking_or_empty_text_takes_no_mark():
    assert llm._mark_last([{"type": "thinking", "thinking": "x", "signature": "s"}]) is None
    assert llm._mark_last("   ") is None and llm._mark_last([]) is None
    pic = llm._mark_last([{"type": "text", "text": "a"}, {"type": "image", "source": {}}])
    assert pic[-1]["cache_control"] and "cache_control" not in pic[0]


def test_caching_off_sends_no_marks(monkeypatch):
    seen = stream_events(monkeypatch)
    collect(llm.stream(convo(), provider="claude", model="claude-sonnet-5-5", tools=TOOLS, cache=False))
    assert marks(body(seen[0])) == [] and body(seen[0])["system"] == "be useful"


def test_command_code_marks_its_claude_models_only(monkeypatch):
    seen = stream_events(monkeypatch)
    llm._models_cache["commandcode"] = (10 ** 12, [{"id": "claude-haiku-4-5", "anthropic": True},
                                                   {"id": "Qwen/Qwen3.8-Flash", "anthropic": False}])
    collect(llm.stream(convo(), provider="commandcode", model="claude-haiku-4-5", tools=TOOLS))
    assert len(marks(body(seen[0]))) == 4
    assert llm.caches("commandcode", "chat", "Qwen/Qwen3.8-Flash") is False
    # OpenCode Go does not say it takes the marks: it is told the conversation instead
    collect(llm.stream(convo(), provider="opencode-go", model="minimax-m3", tools=TOOLS))
    assert marks(body(seen[1])) == [] and llm.caches("opencode-go", "chat", "glm-5.3") is False


def test_cache_reads_are_priced_per_model():
    one = {"prompt_tokens": 1_000_000, "cache_read_tokens": 1_000_000}
    assert llm.claude_cost("claude-opus-5-5", one) == pytest.approx(0.20)            # its own read price
    assert llm.claude_cost("claude-fable-5-1", one) == pytest.approx(0.25)
    assert llm.claude_cost("claude-sonnet-5-5", one) == pytest.approx(0.20)          # a tenth of $2
    assert llm.claude_cost("claude-haiku-5-5", {"prompt_tokens": 50_000, "completion_tokens": 0}) == pytest.approx(0.005)
    # beyond 100K tokens Haiku 5.5 is priced higher, all of the call
    assert llm.claude_cost("claude-haiku-5-5", {"prompt_tokens": 200_000}) == pytest.approx(0.10)


def test_a_provider_that_refuses_the_marks_is_asked_again_without_them(monkeypatch):
    def h(req):
        if b"cache_control" in req.content:
            return httpx.Response(400, json={"error": {"message": "Extra inputs are not permitted: cache_control"}})
        return httpx.Response(200, content=sse(CLAUDE_EVENTS), headers={"content-type": "text/event-stream"})
    seen = mock(monkeypatch, h)
    got = collect(llm.stream(convo(), provider="claude", model="claude-sonnet-5-5"))
    assert [p["text"] for p in got if "text" in p] == ["Hi."] and len(seen) == 2
    collect(llm.stream(convo(), provider="claude", model="claude-sonnet-5-5"))
    assert len(seen) == 3 and marks(body(seen[2])) == []                 # remembered


def test_opencode_is_told_the_conversation(monkeypatch):
    seen = stream_events(monkeypatch)

    async def go():
        llm.SESSION.set("c42")
        return [p async for p in llm.stream([{"role": "user", "content": "x"}], provider="opencode-go",
                                            model="minimax-m3")]
    asyncio.run(go())
    assert seen[0].headers["x-opencode-session"] == "c42"
    collect(llm.stream([{"role": "user", "content": "x"}], provider="opencode-go", model="minimax-m3"))
    assert "x-opencode-session" not in seen[1].headers                  # no conversation, no header


def test_openrouter_marks_claude_models_and_reads_any_model_s_cached_tokens(monkeypatch):
    chunks = [{"choices": [{"delta": {"content": "ok"}}]},
              {"choices": [], "usage": {"prompt_tokens": 5000, "completion_tokens": 3, "cost": 0.001,
                                        "prompt_tokens_details": {"cached_tokens": 4000, "cache_write_tokens": 600}}}]
    seen = stream_events(monkeypatch, chunks)
    got = collect(llm.stream(convo(), provider="openrouter", model="anthropic/claude-sonnet-5.5", tools=TOOLS))
    sent = body(seen[0])
    assert sent["messages"][0]["content"][0]["cache_control"]                      # the system line
    users = [m for m in sent["messages"] if m["role"] == "user"]
    assert isinstance(users[0]["content"], str)                                    # "first": too old
    assert users[1]["content"][-1]["cache_control"] and users[2]["content"][-1]["cache_control"]
    assert all(isinstance(m["content"], str) for m in sent["messages"] if m["role"] == "tool")
    assert len(marks(sent)) == 3
    used = got[-1]["usage"]
    assert used["cache_read_tokens"] == 4000 and used["cache_write_tokens"] == 600 and used["cost"] == 0.001
    collect(llm.stream(convo(), provider="openrouter", model="openai/gpt-6", tools=TOOLS))
    assert marks(body(seen[1])) == []


def test_a_complete_call_counts_the_cache_too(monkeypatch):
    mock(monkeypatch, lambda req: httpx.Response(200, json={
        "content": [{"type": "text", "text": "OK"}], "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 2000}}))
    d = asyncio.run(llm.complete([{"role": "user", "content": "hi"}], provider="claude", model="claude-haiku-4-5"))
    assert d["usage"]["prompt_tokens"] == 2010 and d["usage"]["cache_read_tokens"] == 2000


def test_the_usage_log_keeps_fresh_input_apart_from_the_cache():
    db = {"llm_calls": LogColl()}

    async def go():
        scope.WORKSPACE.set("u1")
        await llm.record(db, provider="claude", model="claude-sonnet-5-5", surface="chat", kind="cc-chat",
                         used={"prompt_tokens": 1_000_000, "completion_tokens": 0, "cache_read_tokens": 900_000,
                               "cache_write_tokens": 50_000})
    asyncio.run(go())
    (row,) = db["llm_calls"].rows
    assert row["input"] == 50_000 and row["cache_read"] == 900_000 and row["cache_write"] == 50_000
    assert row["cost_usd"] == pytest.approx((50_000 * 2 + 900_000 * 0.2 + 50_000 * 2.5) / 1e6)


# ---- the history stays the same from one line to the next -----------------

def _line(i):
    return {"id": f"q{i}", "role": "user", "content": f"question {i}", "by": {"id": "u1", "name": "A"}}


def _answer(i):
    return {"id": f"a{i}", "role": "assistant", "content": f"answer {i}",
            "steps": [{"tool": "drawer_search", "args": {"query": str(i)}, "status": "done", "pos": 0,
                       "result": "x" * 1400, "result_chars": 5000}]}


def _prefix_kept(a: list[dict], b: list[dict]) -> int:
    """How many of `a`'s turns `b` starts with, unchanged."""
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def test_a_new_line_leaves_the_history_before_it_as_it_was():
    tools = {"drawer_search"}
    msgs: list[dict] = []
    changed = 0
    prev = None
    for i in range(30):
        msgs += [_line(i)]
        h = cc_chat.history(msgs, tools=tools)
        if prev is not None and _prefix_kept(prev, h) < len(prev) - 1:
            changed += 1                    # something before the last line changed: the cache starts again
        prev = h
        msgs += [_answer(i)]
    # The newest answers' results are kept longer; that boundary moves only every RECALL_STEP answers.
    assert changed <= 30 // cc_chat.RECALL_STEP


def test_over_the_budget_the_start_moves_in_steps(monkeypatch):
    monkeypatch.setattr(cc_chat, "CONTEXT_CHARS", 20_000)
    msgs: list[dict] = []
    starts = []
    for i in range(60):
        msgs += [_line(i)]
        h = cc_chat.history(msgs, tools={"drawer_search"})
        starts.append(h[1]["content"])
        assert sum(len(json.dumps(m)) for m in h) < 3 * cc_chat.CONTEXT_CHARS
        msgs += [_answer(i)]
    assert len(set(starts)) <= 60 * 2 // cc_chat.CUT_STEP + 2


def test_the_analytics_room_knows_what_a_cache_read_saved():
    assert llm.cache_rates("claude-haiku-5-5") == {"input": 0.10, "cache_read": pytest.approx(0.01)}
    assert llm.cache_rates("claude-opus-5-5")["cache_read"] == 0.20 and llm.cache_rates("gpt-6") is None
