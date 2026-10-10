"""The Claude API and OpenCode Go as providers: the wire formats, the keys,
the routing, and what a call leaves in the usage log. No real HTTP: an
httpx.MockTransport stands in for the providers (llm._transport)."""
import asyncio
import json

import httpx
import pytest
from fastapi import HTTPException

from backend import cc_chat, llm, scope
from tests.test_llm import FakeDb

KEY_C = "sk-ant-test-0000-abcd"
KEY_O = "oc-test-0000-wxyz"


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setattr(llm, "_conf", {"keys": {"claude": KEY_C, "opencode-go": KEY_O}, "jobs": {}})
    monkeypatch.setattr(llm, "_models_cache", {})
    monkeypatch.setattr(llm, "_NO_FALLBACK", set())
    monkeypatch.setattr(llm, "_NO_TEMPERATURE", set())


def mock(monkeypatch, handler):
    seen: list[httpx.Request] = []

    def h(req):
        seen.append(req)
        return handler(req)
    monkeypatch.setattr(llm, "_transport", httpx.MockTransport(h))
    return seen


def body(req) -> dict:
    return json.loads(req.content or b"{}")


def sse(events: list[dict]) -> bytes:
    return "".join(f"data: {json.dumps(e)}\n\n" for e in events).encode()


def collect(gen):
    async def go():
        return [p async for p in gen]
    return asyncio.run(go())


# ---------------- the Claude API ----------------

def test_claude_is_asked_on_messages_with_its_own_key_header_and_no_temperature(monkeypatch):
    seen = mock(monkeypatch, lambda req: httpx.Response(200, json={
        "content": [{"type": "thinking", "thinking": "", "signature": "s"}, {"type": "text", "text": "OK"}],
        "stop_reason": "end_turn", "usage": {"input_tokens": 1000, "output_tokens": 500}}))
    d = asyncio.run(llm.complete([{"role": "system", "content": "be brief"}, {"role": "user", "content": "hi"}],
                                 provider="claude", model="claude-opus-5-5", max_tokens=40, temperature=0.2))
    req = seen[0]
    assert str(req.url) == "https://api.anthropic.com/v1/messages"
    assert req.headers["x-api-key"] == KEY_C and req.headers["anthropic-version"] == "2023-06-01"
    assert "authorization" not in req.headers                       # never as a bearer token
    sent = body(req)
    assert "temperature" not in sent and sent["system"] == "be brief"
    # thinking can not be turned off on Opus 5.5: room for it, and a low effort
    assert sent["max_tokens"] >= 2048 and sent["output_config"] == {"effort": "low"}
    assert sent["fallbacks"] == "default" and req.headers["anthropic-beta"] == llm.CLAUDE_FALLBACK_BETA
    assert d["choices"][0]["message"]["content"] == "OK"
    assert d["provider"] == "claude" and d["usage"]["prompt_tokens"] == 1000
    assert d["usage"]["cost"] == pytest.approx((1000 * 4 + 500 * 20) / 1e6)     # list price


def test_haiku_gets_neither_effort_nor_fallbacks():
    sent = llm._build("claude", "messages", "claude-haiku-4-5-20251001", [{"role": "user", "content": "x"}],
                      60, 0.2, False, False)[1]
    assert "output_config" not in sent and "fallbacks" not in sent and "thinking" not in sent
    assert "temperature" not in sent and sent["max_tokens"] == 60
    assert llm.claude_version("claude-haiku-4-5-20251001") == ("haiku", (4, 5))
    assert llm.claude_adaptive("claude-sonnet-4-6") and not llm.claude_adaptive("claude-sonnet-4-5")
    assert llm.claude_adaptive("claude-fable-5-1")


def test_a_key_without_the_fallback_beta_is_asked_again_without_it(monkeypatch):
    def h(req):
        if "fallbacks" in body(req):
            return httpx.Response(400, json={"type": "error", "error": {"message": "fallbacks: not available"}})
        return httpx.Response(200, json={"content": [{"type": "text", "text": "OK"}], "usage": {}})
    seen = mock(monkeypatch, h)
    asyncio.run(llm.complete([{"role": "user", "content": "x"}], provider="claude", model="claude-sonnet-5-5"))
    assert len(seen) == 2 and "anthropic-beta" not in seen[1].headers
    asyncio.run(llm.complete([{"role": "user", "content": "x"}], provider="claude", model="claude-sonnet-5-5"))
    assert len(seen) == 3 and "fallbacks" not in body(seen[2])        # remembered


def test_a_declined_answer_says_so(monkeypatch):
    mock(monkeypatch, lambda req: httpx.Response(200, json={
        "content": [], "stop_reason": "refusal", "stop_details": {"type": "refusal", "category": "cyber"},
        "usage": {"input_tokens": 3, "output_tokens": 0}}))
    with pytest.raises(RuntimeError, match="declined.*cyber"):
        asyncio.run(llm.complete([{"role": "user", "content": "x"}], provider="claude", model="claude-opus-5-5"))


def test_claude_streams_thinking_and_tool_calls_and_takes_its_turn_back(monkeypatch):
    events = [
        {"type": "message_start", "message": {"usage": {"input_tokens": 20}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "look it up"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "SIG"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Checking."}},
        {"type": "content_block_start", "index": 2,
         "content_block": {"type": "tool_use", "id": "tu1", "name": "drawer_search", "input": {}}},
        {"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": '{"query": "IRL"}'}},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 10}},
        {"type": "message_stop"},
    ]
    seen = mock(monkeypatch, lambda req: httpx.Response(200, content=sse(events),
                                                        headers={"content-type": "text/event-stream"}))
    spec = [{"name": "drawer_search", "description": "d", "parameters": {"type": "object", "properties": {}}}]
    msgs = [{"role": "user", "content": [{"type": "text", "text": "what is this"},
                                         {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]}]
    got = collect(llm.stream(msgs, provider="claude", model="claude-opus-5-5", tools=spec))
    sent = body(seen[0])
    assert sent["stream"] is True and sent["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert "output_config" not in sent and "temperature" not in sent
    assert sent["tools"][0]["input_schema"] == {"type": "object", "properties": {}}
    assert sent["messages"][0]["content"][1]["source"] == {"type": "base64", "media_type": "image/png", "data": "AAAA"}
    assert got[0] == {"thinking": "look it up"} and got[1] == {"text": "Checking."}
    turn = next(p["blocks"] for p in got if "blocks" in p)
    assert turn == [{"type": "thinking", "thinking": "look it up", "signature": "SIG"},
                    {"type": "text", "text": "Checking."},
                    {"type": "tool_use", "id": "tu1", "name": "drawer_search", "input": {"query": "IRL"}}]
    calls = next(p["calls"] for p in got if "calls" in p)
    assert calls == [{"id": "tu1", "name": "drawer_search", "arguments": '{"query": "IRL"}'}]
    used = got[-1]["usage"]
    assert used["prompt_tokens"] == 20 and used["completion_tokens"] == 10 and used["cost"] > 0

    # The next round sends the turn back as it came, then the tool's answer.
    loop = [*msgs, {"role": "assistant", "content": "Checking.", "blocks": turn, "tool_calls": [
        {"id": "tu1", "type": "function", "function": {"name": "drawer_search", "arguments": '{"query": "IRL"}'}}]},
        {"role": "tool", "tool_call_id": "tu1", "content": "IRL540N in drawer 3"}]
    again = llm._to_anthropic(loop, 100, None, "claude-opus-5-5", tools=spec)
    assert again["messages"][1] == {"role": "assistant", "content": turn}
    assert again["messages"][2]["content"][0] == {"type": "tool_result", "tool_use_id": "tu1",
                                                  "content": [{"type": "text", "text": "IRL540N in drawer 3"}]}


def test_claude_models_come_from_every_page(monkeypatch):
    def h(req):
        assert req.headers["x-api-key"] == KEY_C
        if "after_id" not in req.url.params:
            return httpx.Response(200, json={"data": [{"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5",
                                                       "max_input_tokens": 1000000}],
                                             "has_more": True, "last_id": "claude-opus-5-5"})
        return httpx.Response(200, json={"data": [{"id": "claude-haiku-4-5-20251001", "display_name": "Claude Haiku 4.5"}],
                                         "has_more": False})
    seen = mock(monkeypatch, h)
    rows = asyncio.run(llm.models("claude"))
    assert [r["id"] for r in rows] == ["claude-haiku-4-5-20251001", "claude-opus-5-5"]
    opus = rows[1]
    assert opus["name"] == "Claude Opus 5.5" and opus["context"] == 1000000
    assert opus["vision"] and opus["anthropic"] and opus["endpoint"] == "messages" and not opus["cheap"]
    assert len(seen) == 2 and seen[1].url.params["after_id"] == "claude-opus-5-5"


def test_claude_prices_are_list_prices_and_unknown_models_stay_unpriced():
    assert llm.claude_cost("claude-sonnet-5-5", {"prompt_tokens": 1_000_000, "completion_tokens": 0}) == 2.0
    assert llm.claude_cost("claude-haiku-4-5-20251001", {"prompt_tokens": 0, "completion_tokens": 1_000_000}) == 5.0
    assert llm.claude_cost("claude-opus-5", {"prompt_tokens": 1_000_000}) == 5.0       # not opus-5-5's rate
    assert llm.claude_cost("claude-new-thing", {"prompt_tokens": 10}) is None


# ---------------- OpenCode Go ----------------

def test_opencode_go_picks_the_wire_format_by_model():
    assert llm.opencode_endpoint("glm-5.3") == "chat"
    assert llm.opencode_endpoint("kimi-k3") == "chat"
    assert llm.opencode_endpoint("deepseek-v4-flash") == "chat"
    assert llm.opencode_endpoint("minimax-m3") == "messages"
    assert llm.opencode_endpoint("qwen3.8-flash") == "messages"
    assert llm.opencode_endpoint("claude-haiku-5-5") == "messages"
    assert llm.opencode_endpoint("gpt-6-luna") == "responses"
    assert llm.opencode_endpoint("grok-4.7") == "responses"


def test_opencode_go_chat_and_messages_go_to_zen_go_with_the_key(monkeypatch):
    def h(req):
        if req.url.path.endswith("/messages"):
            return httpx.Response(200, json={"content": [{"type": "text", "text": "M"}],
                                             "usage": {"input_tokens": 2, "output_tokens": 1}})
        return httpx.Response(200, json={"choices": [{"message": {"content": "C"}}],
                                         "usage": {"prompt_tokens": 2, "completion_tokens": 1}})
    seen = mock(monkeypatch, h)
    d = asyncio.run(llm.complete([{"role": "user", "content": "x"}], provider="opencode-go", model="glm-5.3",
                                 max_tokens=60))
    assert d["choices"][0]["message"]["content"] == "C" and d["provider"] == "opencode-go"
    assert str(seen[0].url) == "https://opencode.ai/zen/go/v1/chat/completions"
    assert seen[0].headers["authorization"] == f"Bearer {KEY_O}"
    assert body(seen[0])["max_tokens"] >= 1024                      # room to think
    d = asyncio.run(llm.complete([{"role": "user", "content": "x"}], provider="opencode-go", model="minimax-m3"))
    assert d["choices"][0]["message"]["content"] == "M"
    assert str(seen[1].url) == "https://opencode.ai/zen/go/v1/messages"
    assert seen[1].headers["x-api-key"] == KEY_O
    assert "cost" not in d["usage"]                                 # a subscription: tokens only


def test_opencode_go_responses_models_get_the_responses_shape(monkeypatch):
    seen = mock(monkeypatch, lambda req: httpx.Response(200, json={
        "output": [{"type": "reasoning", "summary": []},
                   {"type": "message", "content": [{"type": "output_text", "text": "Merhaba"}]}],
        "usage": {"input_tokens": 7, "output_tokens": 3}}))
    d = asyncio.run(llm.complete([{"role": "system", "content": "sys"}, {"role": "user", "content": "selam"}],
                                 provider="opencode-go", model="gpt-6-luna"))
    assert str(seen[0].url) == "https://opencode.ai/zen/go/v1/responses"
    sent = body(seen[0])
    assert sent["instructions"] == "sys" and sent["store"] is False
    assert sent["input"] == [{"role": "user", "content": [{"type": "input_text", "text": "selam"}]}]
    assert d["choices"][0]["message"]["content"] == "Merhaba"
    assert d["usage"] == {"prompt_tokens": 7, "completion_tokens": 3}


def test_a_tool_loop_in_the_responses_shape():
    loop = [{"role": "user", "content": [{"type": "text", "text": "q"},
                                         {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA"}}]},
            {"role": "assistant", "content": "Looking.", "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "lcsc_search", "arguments": '{"q":"x"}'}}]},
            {"role": "tool", "tool_call_id": "c1", "content": [{"type": "text", "text": "found"},
                                                               {"type": "image_url", "image_url": {"url": "data:image/png;base64,BB"}}]}]
    spec = [{"name": "lcsc_search", "description": "d", "parameters": {"type": "object"}}]
    b = llm._to_responses(loop, 100, "gpt-6-luna", stream=True, tools=spec)
    assert b["input"][0]["content"][1] == {"type": "input_image", "image_url": "data:image/png;base64,AA"}
    assert b["input"][1] == {"role": "assistant", "content": [{"type": "output_text", "text": "Looking."}]}
    assert b["input"][2] == {"type": "function_call", "call_id": "c1", "name": "lcsc_search", "arguments": '{"q":"x"}'}
    assert b["input"][3] == {"type": "function_call_output", "call_id": "c1", "output": "found"}
    assert b["input"][4]["content"][1] == {"type": "input_image", "image_url": "data:image/png;base64,BB"}
    assert b["tools"] == [{"type": "function", "name": "lcsc_search", "description": "d", "parameters": {"type": "object"}}]


def test_a_responses_stream_hands_back_text_thinking_and_calls(monkeypatch):
    events = [
        {"type": "response.reasoning_summary_text.delta", "delta": "hmm"},
        {"type": "response.output_text.delta", "delta": "Bakıyorum."},
        {"type": "response.output_item.added", "output_index": 2,
         "item": {"type": "function_call", "call_id": "c9", "name": "lcsc_search", "arguments": ""}},
        {"type": "response.function_call_arguments.delta", "output_index": 2, "delta": '{"q":'},
        {"type": "response.function_call_arguments.delta", "output_index": 2, "delta": '"x"}'},
        {"type": "response.output_item.done", "output_index": 2,
         "item": {"type": "function_call", "call_id": "c9", "name": "lcsc_search", "arguments": '{"q":"x"}'}},
        {"type": "response.completed", "response": {"usage": {"input_tokens": 5, "output_tokens": 6}}},
    ]
    mock(monkeypatch, lambda req: httpx.Response(200, content=sse(events)))
    got = collect(llm.stream([{"role": "user", "content": "q"}], provider="opencode-go", model="grok-4.7",
                             tools=[{"name": "lcsc_search", "parameters": {}}]))
    assert got == [{"thinking": "hmm"}, {"text": "Bakıyorum."},
                   {"calls": [{"id": "c9", "name": "lcsc_search", "arguments": '{"q":"x"}'}]},
                   {"usage": {"prompt_tokens": 5, "completion_tokens": 6}}]


def test_opencode_go_models_say_their_format(monkeypatch):
    mock(monkeypatch, lambda req: httpx.Response(200, json={"data": [
        {"id": "glm-5.3", "object": "model"}, {"id": "minimax-m3"}, {"id": "gpt-6-luna"},
        {"id": "deepseek-v4-flash-vision-exp"}]}))
    rows = {r["id"]: r for r in asyncio.run(llm.models("opencode-go"))}
    assert rows["glm-5.3"]["endpoint"] == "chat" and not rows["glm-5.3"]["anthropic"]
    assert rows["minimax-m3"]["endpoint"] == "messages" and rows["minimax-m3"]["anthropic"]
    assert rows["gpt-6-luna"]["endpoint"] == "responses"
    assert rows["deepseek-v4-flash-vision-exp"]["vision"] and not rows["glm-5.3"]["vision"]


# ---------------- the settings, the routing, the log ----------------

def test_keys_for_the_new_providers_are_saved_and_never_shown(monkeypatch):
    monkeypatch.setattr(llm, "_conf", {"keys": {}, "jobs": {}})
    db = FakeDb()
    shown = asyncio.run(llm.save(db, keys={"claude": KEY_C, "opencode-go": KEY_O}))
    assert shown["providers"]["claude"] == {"name": "Claude API", "set": True, "hint": "…abcd", "source": "settings",
                                            "site": "https://console.anthropic.com/settings/keys"}
    assert shown["providers"]["opencode-go"]["hint"] == "…wxyz"
    assert KEY_C not in repr(shown) and KEY_O not in repr(shown)
    assert [p["id"] for p in shown["registry"]] == ["commandcode", "openrouter", "claude", "opencode-go"]
    with pytest.raises(ValueError, match="does not look like an API key"):
        asyncio.run(llm.save(db, keys={"claude": "two words"}))
    with pytest.raises(ValueError, match="unknown provider"):
        asyncio.run(llm.save(db, keys={"anthropic-direct": "k"}))


def test_a_job_can_be_routed_to_either_and_a_bad_route_is_refused(monkeypatch):
    db = FakeDb()
    asyncio.run(llm.save(db, jobs={"summary": {"provider": "claude", "model": "claude-haiku-4-5-20251001"},
                                   "chat": {"provider": "opencode-go", "model": "kimi-k3"}}))
    assert llm.route("summary") == ("claude", "claude-haiku-4-5-20251001")
    assert llm.route("chat") == ("opencode-go", "kimi-k3")
    with pytest.raises(ValueError, match="choose a model"):
        asyncio.run(llm.save(db, jobs={"summary": {"provider": "claude", "model": ""}}))


def test_a_conversation_on_a_new_provider_names_its_model_and_needs_its_key(monkeypatch):
    with pytest.raises(HTTPException) as e:
        cc_chat._pick({"provider": "commandcode", "model": "x"}, "claude", None)
    assert e.value.status_code == 400 and "Claude API" in e.value.detail
    assert cc_chat._pick({}, "opencode-go", "glm-5.3") == ("opencode-go", "glm-5.3")
    llm._conf["keys"].pop("opencode-go")
    with pytest.raises(HTTPException) as e:
        cc_chat._pick({}, "opencode-go", "glm-5.3")
    assert e.value.status_code == 503 and "OpenCode Go" in e.value.detail


class LogColl:
    def __init__(self):
        self.rows = []

    async def update_one(self, q, update, upsert=False):
        self.rows.append(dict(update.get("$setOnInsert") or {}))


def test_a_claude_call_is_logged_priced_in_its_space():
    db = {"llm_calls": LogColl()}

    async def go():
        scope.WORKSPACE.set("u1")
        await llm.record(db, provider="claude", model="claude-sonnet-5-5", surface="chat", kind="cc-chat",
                         used={"prompt_tokens": 1_000_000, "completion_tokens": 0})
        await llm.record(db, provider="opencode-go", model="glm-5.3", surface="chat", kind="cc-chat",
                         used={"prompt_tokens": 10, "completion_tokens": 5})
    asyncio.run(go())
    rows = db["llm_calls"].rows
    assert rows[0]["provider"] == "claude" and rows[0]["cost_usd"] == 2.0 and rows[0]["cost_basis"] == "list"
    assert rows[1]["cost_usd"] is None and rows[1]["cost_basis"] == "unpriced"
    assert {r["workspace_id"] for r in rows} == {"u1"}
