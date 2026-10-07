"""Which model does which job, the keys, and the Command Code room's history."""
import pytest

from backend import access, cc_chat, llm


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setattr(llm, "_conf", {"keys": {}, "jobs": {}})


def test_a_job_uses_its_default_until_one_is_chosen():
    # Every job starts on the one cheap model; anything dearer is a choice.
    assert llm.CHEAP == ("commandcode", "Qwen/Qwen3.8-Flash")
    for job in llm.JOBS:
        assert llm.route(job) == llm.CHEAP, job
    llm._conf["jobs"]["summary"] = {"provider": "openrouter", "model": "deepseek/deepseek-v4.1-flash"}
    assert llm.route("summary") == ("openrouter", "deepseek/deepseek-v4.1-flash")
    assert llm.route("chat") == llm.CHEAP


def test_keys_come_from_the_database_only_and_the_page_never_sees_them(monkeypatch):
    # The environment is never read, whatever it holds.
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-from-env-1234")
    monkeypatch.setenv("COMMANDCODE_API_KEY", "user_from-env-1234")
    assert llm.key("openrouter") is None and llm.key_source("openrouter") is None
    assert llm.key("commandcode") is None
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


class FakeColl:
    def __init__(self):
        self.doc: dict = {}

    async def update_one(self, flt, update, upsert=False):
        for k, v in update.get("$set", {}).items():
            node = self.doc
            *path, last = k.split(".")
            for p in path:
                node = node.setdefault(p, {})
            node[last] = v
        for k in update.get("$unset", {}):
            node = self.doc
            *path, last = k.split(".")
            for p in path:
                node = node.get(p, {})
            node.pop(last, None)

    async def find_one(self, flt):
        return self.doc


class FakeDb(dict):
    def __missing__(self, name):
        self[name] = FakeColl()
        return self[name]


def test_save_replace_and_remove_a_key_in_the_database(monkeypatch):
    import asyncio
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-from-env-1234")
    db = FakeDb()
    shown = asyncio.run(llm.save(db, keys={"openrouter": "sk-or-saved-1111"}))
    assert db[llm.COLL].doc["keys"] == {"openrouter": "sk-or-saved-1111"}
    assert shown["providers"]["openrouter"]["source"] == "settings"
    asyncio.run(llm.save(db, keys={"openrouter": "sk-or-new-5555"}))   # replace
    assert llm.key("openrouter") == "sk-or-new-5555"
    shown = asyncio.run(llm.save(db, keys={"openrouter": None}))       # remove: the env one does not step in
    assert llm.key("openrouter") is None and shown["providers"]["openrouter"]["set"] is False
    with pytest.raises(ValueError):
        asyncio.run(llm.save(db, keys={"openrouter": "has a space"}))


def test_a_call_without_a_saved_key_says_where_to_add_one(monkeypatch):
    import asyncio
    monkeypatch.setenv("COMMANDCODE_API_KEY", "user_from-env-1234")
    with pytest.raises(RuntimeError, match="Settings > LLM settings"):
        asyncio.run(llm.complete([{"role": "user", "content": "hi"}], provider="commandcode", model="m"))
    assert "Card summaries".lower() in llm.no_key("openrouter", "summary")


def test_logged_kinds_are_named_like_the_jobs():
    assert llm.job_label("summary") == "Card summaries"
    assert llm.job_label("translate") == "English translation"
    assert llm.job_label("tool-llm:smoke") == "Tool pages"
    assert llm.job_label("tool-router") == "Tool finder"
    assert llm.job_label("cc-chat") == "Command Code room"
    assert llm.job_label("cc-title") == "Command Code room titles"
    assert llm.job_label("llm-test") == "Settings test"
    assert llm.job_label("something-new") == "something-new"


def test_nothing_lands_on_a_dearer_model_unasked(monkeypatch):
    """Only the cheap model is picked by itself: a provider switched to
    without a model named gets the cheap one, or has to be told which."""
    from fastapi import HTTPException
    llm._conf["keys"].update({"openrouter": "k-or", "commandcode": "k-cc"})
    assert llm.public()["cheap"] == {"provider": "commandcode", "model": "Qwen/Qwen3.8-Flash"}
    chat = {"provider": "commandcode", "model": "claude-opus-5"}           # chosen, so kept
    assert cc_chat._pick(chat, None, None) == ("commandcode", "claude-opus-5")
    with pytest.raises(HTTPException) as e:                                # no model named
        cc_chat._pick(chat, "openrouter", None)
    assert e.value.status_code == 400 and "choose" in e.value.detail
    assert cc_chat._pick({"provider": "openrouter", "model": "x/y"}, "commandcode", None) == llm.CHEAP
    assert cc_chat._pick(chat, "openrouter", "z/cheap") == ("openrouter", "z/cheap")


def test_the_model_list_marks_the_cheap_one(monkeypatch):
    import asyncio

    class R:
        status_code = 200
        def raise_for_status(self): pass
        def json(self):
            return {"data": [{"id": "aaa/claude-opus-5"}, {"id": "Qwen/Qwen3.8-Flash"}]}

    class C:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, *a, **k): return R()

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", C)
    monkeypatch.setattr(llm, "_models_cache", {})
    rows = asyncio.run(llm.models("commandcode"))
    assert [m["id"] for m in rows if m["cheap"]] == ["Qwen/Qwen3.8-Flash"]
    assert rows[0]["cheap"] is False                                      # the first is not it
