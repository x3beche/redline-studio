"""Settings > LLM settings > Prompts (backend/prompts.py): every instruction
the app sends a model is listed with its default, an override is kept
machine-wide in the LLM settings document and used from the next call, a
required slot cannot be dropped (and an override that lost one anyway is
not used), only the owner and the admins change one, every change is
audited, and the Chat's preview is exactly the system line an answer is
sent. No real model is called here."""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

import pytest
from fastapi import HTTPException

from backend import access, actors, cc_chat, ccgen, chat_ideas, llm, llm_api, prompts, reading, suggest, summarise
from tests.test_cc_mentions_live_search import env, events, line, seed_chat  # noqa: F401 - env is a fixture
from tests.test_chat_tools import tool_model
from tests.test_llm import FakeDb

ROOT = Path(__file__).resolve().parents[1]


def run(c):
    return asyncio.run(c)


def put(pid: str, text: str, by=None) -> str:
    """An override, straight into the settings as llm.load would read it."""
    llm._conf.setdefault("prompts", {})[pid] = {"text": text, "at": "2026-10-15T10:00:00+00:00", "by": by or {}}
    return text


# ---------------------------------------------------------------- the list

def test_every_prompt_sent_to_a_model_is_listed_with_its_default():
    got = {p["id"]: p for p in prompts.public()["prompts"]}
    for pid in ("chat_system", "chat_steps", "chat_tools", "chat_title", "chat_retitle", "suggest", "chat_ideas",
                "summary_tr", "summary_en", "translate", "reading", "router", "part_category", "taste_extract",
                "taste_folder", "taste_look", "taste_text_only", "taste_check", "manufacturer",
                "manufacturer_only", "voice", "file_ocr", "scheduled_ask", "llm_test"):
        assert pid in got, pid
        p = got[pid]
        assert p["default"].strip() and p["where"] and p["state"] == "default" and p["override"] is None
        assert p["tokens"] == prompts.tokens(p["default"]) > 0
    # The defaults are the code's own texts, with the slots as named holes.
    assert got["chat_system"]["default"] == cc_chat.SYSTEM
    assert got["suggest"]["default"] == suggest.PROMPT
    assert got["chat_ideas"]["default"].count("{n}") == 1 and "{{" not in got["chat_ideas"]["default"]
    assert {s["name"]: s["required"] for s in got["chat_ideas"]["slots"]} == {"n": True, "chars": False, "lang": True}
    assert "{lang}" in got["reading"]["default"] and "{places}" in got["part_category"]["default"]
    assert "{nothing}" in got["voice"]["default"] and got["voice"]["role"] == "user"
    # The jobs are the LLM settings' own, and the run-time parts of the Chat are named.
    assert got["chat_title"]["job"] == "summary" and got["chat_title"]["job_label"] == "Card summaries"
    assert got["chat_system"]["runtime"] and not got["llm_test"]["editable"]
    # Every prompt with a job names one the settings have.
    assert all(p["job"] in llm.JOBS for p in got.values() if p["job"])


def test_the_defaults_fill_to_exactly_what_was_sent_before():
    from backend import lcsc, voice
    assert prompts.text("chat_ideas", n=6, chars=90, lang="Turkish") == \
        chat_ideas.PROMPT.format(n=6, chars=90, lang="Turkish")
    assert prompts.text("reading", lang="German") == reading.PROMPT.format(lang="German")
    assert prompts.text("voice", nothing=voice.NOTHING) == voice.PROMPT
    places = "\n".join(f"- {g} / {b}" for g, b in lcsc.PLACES)
    assert lcsc._category_prompt("C1", {"mpn": "X"}, None)[0]["content"] == (
        "You sort electronic parts into a parts drawer. Pick exactly one group and branch from "
        "this list, spelled exactly as written:\n" + places + "\n"
        'Answer with strict JSON only, no prose: {"group": "...", "branch": "..."}')
    assert summarise.build_messages("x", None)[0]["content"] == summarise.SYSTEM_PROMPT_TR


# ---------------------------------------------------------------- save, check, reset

def test_an_override_is_saved_checked_and_reset():
    db = FakeDb()
    entry, warn = run(prompts.save(db, "suggest", "  Write the next line.\r\nShort.  ", {"id": "u1", "name": "Emir", "x": 1}))
    kept = db[llm.COLL].doc["prompts"]["suggest"]
    assert kept["text"] == "Write the next line.\nShort." and kept["by"] == {"id": "u1", "name": "Emir"} and kept["at"]
    assert entry["state"] == "override" and entry["override"] == kept["text"] and warn == []
    assert prompts.text("suggest") == "Write the next line.\nShort."           # read back by llm.load
    # The default's own text is the same as none.
    entry, _ = run(prompts.save(db, "suggest", suggest.PROMPT))
    assert "suggest" not in db[llm.COLL].doc["prompts"] and entry["state"] == "default"
    # A required slot cannot be dropped; the page is told which.
    with pytest.raises(ValueError, match=r"\{lang\}"):
        run(prompts.save(db, "reading", "Translate it."))
    with pytest.raises(ValueError, match="empty"):
        run(prompts.save(db, "router", "   "))
    with pytest.raises(ValueError, match="not changed here"):
        run(prompts.save(db, "llm_test", "Say hi"))
    with pytest.raises(KeyError):
        run(prompts.save(db, "nope", "x"))
    # A hole the code does not fill is kept, with a warning.
    entry, warn = run(prompts.save(db, "reading", "Into {lang}, for {reader}."))
    assert warn and "{reader}" in warn[0]
    assert prompts.text("reading", lang="Turkish") == "Into Turkish, for {reader}."
    entry = run(prompts.reset(db, "reading"))
    assert entry["state"] == "default" and prompts.text("reading", lang="Turkish") == reading.PROMPT.format(lang="Turkish")


def test_an_override_that_lost_a_required_slot_falls_back_to_the_default(caplog):
    put("chat_ideas", "Write some questions.")                   # no {n}, no {lang}: kept by hand
    with caplog.at_level("WARNING", logger="redline.llm"):
        sent = prompts.text("chat_ideas", n=4, chars=90, lang="English")
    assert sent == chat_ideas.PROMPT.format(n=4, chars=90, lang="English")
    assert "chat_ideas" in caplog.text and "{n}" in caplog.text
    p = next(x for x in prompts.public()["prompts"] if x["id"] == "chat_ideas")
    assert p["state"] == "fallback" and p["missing"] == ["n", "lang"] and p["chars"] == len(p["default"])
    assert prompts.stamp(("chat_ideas",)) == ""                   # not in use: no new cache start either


# ---------------------------------------------------------------- the routes: rights, audit

def test_only_the_owner_and_the_admins_change_a_prompt_anyone_reads_them():
    for m in ("PUT", "DELETE"):
        a = access.action(m, "/api/llm/prompts/chat_system")
        assert access.allowed("admin", a) and access.allowed("owner", a)
        assert not access.allowed("editor", a) and not access.allowed("viewer", a)
    for p in ("/api/llm/prompts", "/api/llm/prompts/preview"):
        assert access.allowed("viewer", access.action("GET", p))


def test_the_routes_save_refuse_and_audit(monkeypatch):
    db = FakeDb()
    monkeypatch.setattr(llm_api, "_db", lambda: db)
    monkeypatch.setattr(actors, "current", lambda: {"type": "person", "id": "u1", "name": "Emir"})
    audit = []

    async def keep(_db, action, target, detail=None, actor=None):
        audit.append((action, target, detail))
    monkeypatch.setattr(actors, "audit", keep)
    got = run(llm_api.put_prompt("chat_title", llm_api.PromptIn(text="Name it in two words.")))
    assert got["state"] == "override" and got["by"]["name"] == "Emir" and got["warnings"] == []
    assert audit[-1][:2] == ("settings", "llm") and "prompt chat_title overridden" in audit[-1][2]["changed"][0]
    with pytest.raises(HTTPException) as e:
        run(llm_api.put_prompt("chat_ideas", llm_api.PromptIn(text="Questions in {lang}.")))
    assert e.value.status_code == 400 and "{n}" in e.value.detail
    with pytest.raises(HTTPException) as e:
        run(llm_api.put_prompt("nope", llm_api.PromptIn(text="x")))
    assert e.value.status_code == 404
    n = len(audit)
    got = run(llm_api.delete_prompt("chat_title"))
    assert got["state"] == "default" and len(audit) == n + 1 and "back to the default" in audit[-1][2]["changed"][0]
    run(llm_api.delete_prompt("chat_title"))                       # nothing to put back: nothing audited
    assert len(audit) == n + 1
    listed = run(llm_api.get_prompts())
    assert {p["id"] for p in listed["prompts"]} == set(prompts.BY_ID)


# ---------------------------------------------------------------- the overrides are what is sent

def test_the_chats_system_line_uses_the_overrides(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    put("chat_system", "You are Workbench's terse helper.")
    put("chat_tools", "Use the tools below sparingly.")
    tool_model(monkeypatch, state, [("Ok.", [])])
    events(cc_chat.say("c1", cc_chat.SayIn(text="hi", client="tab1")))
    system = state["rounds"][0]["messages"][0]["content"]
    assert system.startswith("You are Workbench's terse helper.") and cc_chat.SYSTEM not in system
    assert "Use the tools below sparingly. The tools you have now are exactly these" in system
    assert "You have tools for electronic parts" not in system


def test_the_preview_is_exactly_what_an_answer_is_sent(env, monkeypatch):
    raw, state = env
    seed_chat(raw, messages=[line("m1", "user", "find a 3.3 V LDO in the drawer"),
                             line("m2", "assistant", "Here it is.")])
    put("chat_system", "Custom system line.")
    shown = run(ccgen.preview(cc_chat._db(), raw["cc_chats"].rows["c1"]["messages"]
                              + [{"role": "user", "content": "and a datasheet for it"}], "u-ayse", "auto"))
    tool_model(monkeypatch, state, [("Ok.", [])])
    events(cc_chat.say("c1", cc_chat.SayIn(text="and a datasheet for it", client="tab1")))
    sent = state["rounds"][0]["messages"][0]["content"]
    assert shown["text"] == sent and shown["tokens"] == prompts.tokens(sent)
    assert "".join(p["text"] for p in shown["parts"]) == sent
    kinds = [(p["kind"], p["id"]) for p in shown["parts"]]
    assert kinds[0] == ("prompt", "chat_system") and ("prompt", "chat_tools") in kinds and ("runtime", "tool_list") in kinds
    assert set(shown["tools"]) == {t["name"] for t in state["rounds"][0]["tools"]} and shown["tools_tokens"] > 0
    # No tools: the system line alone; every tool: no packages left out.
    bare = run(ccgen.preview(cc_chat._db(), [], "u-ayse", "none"))
    assert bare["text"] == "Custom system line." and bare["tools"] == []
    every = run(ccgen.preview(cc_chat._db(), [], "u-ayse", "all"))
    assert every["all"] and not any(p["id"] == "packages" for p in every["parts"])


def test_the_preview_route_reads_a_conversation(env):
    raw, state = env
    seed_chat(raw, messages=[line("m1", "user", "hello"), line("m2", "assistant", "Hi.")])
    got = run(llm_api.prompt_preview(chat="c1", tools="none"))
    assert got["text"] == cc_chat.SYSTEM and got["chat"] == "c1" and got["model"] == "m1" and got["session"] == "c1"
    with pytest.raises(HTTPException):
        run(llm_api.prompt_preview(chat="nope"))
    with pytest.raises(HTTPException):
        run(llm_api.prompt_preview(tools="some"))


def test_titles_and_suggestions_use_the_overrides(monkeypatch):
    from tests.test_suggest import Db, convo, turn_on
    sent = []

    async def complete(messages, **kw):
        sent.append(messages)
        return {"choices": [{"message": {"content": "Next thing"}}], "usage": {}, "provider": "openrouter", "model": "m"}
    monkeypatch.setattr(llm, "complete", complete)
    monkeypatch.setattr(llm, "key", lambda p: "k")
    monkeypatch.setattr(suggest, "_indexed", False)
    put("chat_title", "TITLE RULES")
    put("chat_retitle", "RETITLE RULES")
    run(cc_chat.make_title("how do I route a board"))
    run(cc_chat.make_title("", whole="the whole conversation"))
    assert sent[0][0]["content"] == "TITLE RULES" and sent[1][0]["content"] == "RETITLE RULES"
    put("suggest", "SUGGEST RULES")
    db = Db()
    convo(db)
    turn_on()
    run(suggest.suggest(db, "cc", "c1"))
    assert sent[-1][0] == {"role": "system", "content": "SUGGEST RULES"}


def test_example_questions_use_the_override_and_are_written_again_after_a_change():
    conf = {"count": 6, "chats": True}
    before = chat_ideas._sig(conf)
    put("chat_ideas", "Give {n} questions in {lang}, JSON {\"questions\": []}.")
    assert prompts.text("chat_ideas", n=6, chars=90, lang="Turkish") == 'Give 6 questions in Turkish, JSON {"questions": []}.'
    assert chat_ideas._sig(conf) != before


# ---------------------------------------------------------------- the cache

def test_a_changed_prompt_is_a_new_start_for_the_cache():
    msgs = cc_chat.history([{"role": "user", "content": "hi"}])
    body = llm._to_anthropic(msgs, 100, None, "claude-sonnet-5-5", cache=True)      # marked for the cache
    before = body["system"][0]
    assert before["text"] == cc_chat.SYSTEM and before["cache_control"] == llm.CACHE
    assert prompts.session("c1") == "c1"
    put("chat_system", "Another system line.")
    body = llm._to_anthropic(cc_chat.history([{"role": "user", "content": "hi"}]), 100, None,
                             "claude-sonnet-5-5", cache=True)
    assert body["system"][0]["text"] == "Another system line." and body["system"][0]["cache_control"] == llm.CACHE
    key = prompts.session("c1")
    assert key.startswith("c1~") and key != "c1"
    put("chat_system", "Yet another.")
    assert prompts.session("c1") not in ("c1", key)                # each wording its own start
    put("suggest", "Not the Chat's.")
    assert prompts.session(None) is None


def test_the_page_lists_the_prompts_and_previews_the_chat():
    page = (ROOT / "frontend/src/app/llm-prompts.ts").read_text()
    assert "selector: 'app-llm-prompts'" in page
    for route in ("/api/llm/prompts", "/api/llm/prompts/preview"):
        assert route in page
    assert "<app-llm-prompts" in (ROOT / "frontend/src/app/llm-settings.ts").read_text()
    # Turkish for the page's own words.
    i18n = (ROOT / "frontend/src/app/i18n.ts").read_text()
    for s in re.findall(r"\{\{ '([^'\\]+)' \| t \}\}", page):
        assert f"'{s}':" in i18n, s
