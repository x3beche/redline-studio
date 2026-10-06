"""Which model does which job, the keys, and the Command Code room's history."""
import pytest

from backend import access, cc_chat, llm


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setattr(llm, "_conf", {"keys": {}, "jobs": {}})
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("COMMANDCODE_API_KEY", raising=False)


def test_a_job_uses_its_default_until_one_is_chosen():
    assert llm.route("summary") == ("openrouter", "deepseek/deepseek-v4.1-flash")
    llm._conf["jobs"]["summary"] = {"provider": "commandcode", "model": "Qwen/Qwen3.8-Flash"}
    assert llm.route("summary") == ("commandcode", "Qwen/Qwen3.8-Flash")
    assert llm.route("chat")[0] == "commandcode"


def test_a_saved_key_wins_over_env_and_the_page_never_sees_it(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-from-env-1234")
    assert llm.key("openrouter") == "sk-or-from-env-1234" and llm.key_source("openrouter") == ".env"
    llm._conf["keys"]["openrouter"] = "sk-or-saved-9876"
    assert llm.key("openrouter") == "sk-or-saved-9876" and llm.key_source("openrouter") == "settings"
    shown = llm.public()
    assert shown["providers"]["openrouter"] == {"name": "OpenRouter", "set": True, "hint": "…9876",
                                                "source": "settings", "site": "https://openrouter.ai/keys"}
    assert "sk-or" not in repr(shown)
    assert shown["providers"]["commandcode"]["set"] is False


def test_claude_on_command_code_is_spoken_to_in_the_anthropic_shape():
    msgs = [{"role": "system", "content": "be brief"},
            {"role": "user", "content": [{"type": "text", "text": "what is this"},
                                         {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]}]
    body = llm._to_anthropic(msgs, 100, 0.2, "claude-sonnet-5-5")
    assert body["system"] == "be brief"
    assert body["messages"][0]["content"][1] == {"type": "image", "source": {
        "type": "base64", "media_type": "image/png", "data": "AAAA"}}
    assert all(m["role"] != "system" for m in body["messages"])


def test_command_code_gets_room_to_think():
    """Its models reason before answering, out of max_tokens: a 60-token
    summary would be all thought and no sentence."""
    assert llm._openai_body("commandcode", "m", [], 60, 0.2, False)["max_tokens"] >= 1024
    body = llm._openai_body("openrouter", "m", [], 60, 0.2, False)
    assert body["max_tokens"] == 60 and body["reasoning"] == {"enabled": False}


def test_history_names_people_once_there_are_two_and_alternates():
    one = {"id": "a", "name": "Ayşe"}
    two = {"id": "b", "name": "Can"}
    msgs = [{"role": "user", "content": "selam", "by": one},
            {"role": "assistant", "content": "merhaba"},
            {"role": "user", "content": "ben de", "by": two},
            {"role": "user", "content": "devam", "by": one}]
    h = cc_chat.history(msgs)
    assert h[0]["role"] == "system"
    assert [m["role"] for m in h[1:]] == ["user", "assistant", "user"]
    assert h[1]["content"] == "[Ayşe] selam"
    assert h[3]["content"] == "[Can] ben de\n\n[Ayşe] devam"
    # one person: no names
    assert cc_chat.history(msgs[:2])[1]["content"] == "selam"


def test_a_failed_answer_is_left_out_of_the_history():
    msgs = [{"role": "user", "content": "a", "by": {"id": "x"}},
            {"role": "assistant", "content": "", "error": "HTTP 403"},
            {"role": "user", "content": "b", "by": {"id": "x"}}]
    h = cc_chat.history(msgs)
    assert [m["role"] for m in h[1:]] == ["user"] and h[1]["content"] == "a\n\nb"


def test_settings_are_for_admins_talking_is_for_reviewers():
    for m, p in (("PUT", "/api/llm/settings"), ("POST", "/api/llm/test")):
        a = access.action(m, p)
        assert access.allowed("admin", a) and not access.allowed("editor", a)
    assert access.allowed("viewer", access.action("GET", "/api/llm/settings"))
    for m, p in (("POST", "/api/cc/chats"), ("POST", "/api/cc/chats/c1/messages"), ("PATCH", "/api/cc/chats/c1")):
        a = access.action(m, p)
        assert access.allowed("reviewer", a) and not access.allowed("viewer", a)
