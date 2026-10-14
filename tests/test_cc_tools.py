"""The tool packages a Chat line is sent (backend/cc_tools.py): picked from
its words (English and Turkish), its mentions and its conversation, always
with the core tools, never a tool the person turned off; tools_more takes
the rest mid-answer; the answer keeps which packages it had."""

from __future__ import annotations

import asyncio
import json

from backend import cc_chat, cc_tools, chat_tools
from tests.test_cc_generation import answers
from tests.test_cc_mentions_live_search import env, events, seed_chat  # noqa: F401 - env is a fixture
from tests.test_chat_tools import tool_model


def on() -> dict:
    return {n: t for n, t in chat_tools.tools().items() if t.default}


def picked(text, *, convo=(), tools=None, **extra):
    return cc_tools.pick([*convo, {"role": "user", "content": text, **extra}], tools or on())


def test_words_in_either_language_pick_their_packages():
    assert picked("IRL540N datasheet RDS(on)?").groups == ["pcb"]
    assert picked("notlarımı listele").groups == ["notes"]
    assert picked("Show my notes about the fan").groups == ["notes"]
    assert set(picked("Kaç tane M3 vida kaldı stokta?").groups) == {"parts", "stock"}
    assert picked("How much did I spend on tokens this week?").groups == ["analytics"]
    assert picked("Bu ayki maliyet ne kadar?").groups == ["analytics"]
    assert set(picked("add https://robotistan.com/x to the catalog").groups) >= {"web", "parts"}
    assert "notes" not in cc_tools.groups_in("I do not know what this is")      # English "not" is not a note


def test_the_core_tools_always_go_and_a_line_that_points_nowhere_gets_everything():
    p = picked("IRL540N RDS(on)?")
    assert {"clock", "drawer_search", "datasheet_read"} <= p.names and "inventory_add" not in p.names
    assert not p.all
    hi = picked("hi")
    assert hi.all and hi.names == set(on())
    assert cc_tools.note(hi, on()) == ""


def test_an_attached_file_brings_the_product_file_tools():
    # "add this STEP to the product": even a small model must see product_file_attach
    for line in ({"mentions": [{"kind": "file", "id": "f1"}]}, {"attach": [{"id": "f1"}]}):
        p = picked("add this", **line)
        assert {"product_file_attach", "product_find", "file_read"} <= p.names
        assert {"parts", "files"} <= set(p.groups)


def test_the_conversation_keeps_its_packages_for_the_next_lines():
    convo = [{"role": "user", "content": "stokta kaç tane var?"},
             {"role": "assistant", "content": "3.", "packages": ["stock"],
              "steps": [{"tool": "notes_search", "status": "done"}]}]
    p = picked("and the other one?", convo=convo)
    assert set(p.groups) == {"stock", "notes"}
    # a line that got everything does not pass "everything" on
    p = picked("thanks", convo=[{"role": "user", "content": "hi"},
                                {"role": "assistant", "content": "Hello.", "packages": ["pcb", "parts"],
                                 "packages_all": True}])
    assert p.all                                   # nothing to go by: everything, again


def test_a_tool_that_is_off_is_never_sent_nor_taken():
    mine = {n: t for n, t in on().items() if n != "datasheet_read"}
    p = picked("datasheet of IRL540N", tools=mine)
    assert "datasheet_read" not in p.names and "drawer_search" in p.names
    sent = {n: mine[n] for n in p.names}
    out: dict = {}
    more = cc_tools.more_tool(mine, sent, out)
    res = asyncio.run(more.run(None, {"tools": ["datasheet_read"], "packages": ["notes"]}))
    assert "datasheet_read" not in sent and "notes_search" in sent
    assert "Turned off by the person" in res.text and out["packages_added"] == ["notes"]
    res = asyncio.run(more.run(None, {"packages": ["nonsense"]}))
    assert "No such package" in res.text


def test_the_model_takes_more_tools_mid_answer_and_the_answer_says_what_it_had(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    tool_model(monkeypatch, state, [
        ("", [("tools_more", {"packages": ["notes"]})]),
        ("", [("notes_search", {"query": "fan"})]),
        ("Done.", []),
    ])
    events(cc_chat.say("c1", cc_chat.SayIn(text="IRL540N RDS(on)?", client="tab1")))
    r = state["rounds"]
    first = {t["name"] for t in r[0]["tools"]}
    assert "tools_more" in first and "notes_search" not in first and "drawer_search" in first
    assert "call tools_more" in r[0]["messages"][0]["content"]
    assert "notes_search" in {t["name"] for t in r[1]["tools"]}
    (last,) = answers(raw)
    assert last["packages"] == ["pcb"] and last["packages_added"] == ["notes"]
    assert last["steps"][0]["tool"] == "tools_more" and last["steps"][0]["status"] == "done"
    assert last["steps"][0]["vars"]["packages"] == "Notes"
    # the next line starts with what this one ended with
    tool_model(monkeypatch, state, [("Ok.", [])])
    events(cc_chat.say("c1", cc_chat.SayIn(text="and again", client="tab1")))
    names = {t["name"] for t in state["rounds"][0]["tools"]}
    assert {"drawer_search", "notes_search"} <= names


def test_the_savings_on_a_typical_line():
    full = sum(len(json.dumps(t.spec())) for t in on().values())
    p = picked("IRL540N datasheet RDS(on)?")
    sent = sum(len(json.dumps(on()[n].spec())) for n in p.names)
    assert sent < full / 4
