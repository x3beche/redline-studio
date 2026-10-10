"""Settings > LLM settings: a job's model is picked with the chat's own
model picker, and what is picked is what the server keeps.

The owner picked OpenRouter and a model for the next-question suggestion
and the server still had Command Code: picking the provider was only a
choice in the page until a model came with it, while the row already
showed OpenRouter as on, and the switch and the wait saved under it sent
the old route with a "Saved." for each. These pin down the fix: the
server side of that sequence, and the page's own (the source, as the
other page tests here read it).
"""
import asyncio
import re
from pathlib import Path

import pytest

from backend import llm

from test_llm import FakeDb

APP = Path(__file__).resolve().parents[1] / "frontend/src/app"


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setattr(llm, "_conf", {"keys": {}, "jobs": {}})


def run(c):
    return asyncio.run(c)


def test_the_suggestions_route_is_kept_through_its_switch_and_wait():
    db = FakeDb()
    # On and a wait first, under the default route (what the owner's page sent).
    run(llm.save(db, jobs={"suggest": {"provider": "commandcode", "model": "Qwen/Qwen3.8-Flash", "on": True}}))
    run(llm.save(db, jobs={"suggest": {"provider": "commandcode", "model": "Qwen/Qwen3.8-Flash", "delay": 15}}))
    # Then a provider and a model: kept, with the switch and the wait as they were.
    shown = run(llm.save(db, jobs={"suggest": {"provider": "openrouter", "model": "anthropic/claude-haiku-5.5"}}))
    job = shown["jobs"]["suggest"]
    assert (job["provider"], job["model"], job["on"], job["delay"]) == ("openrouter", "anthropic/claude-haiku-5.5", True, 15)
    assert db[llm.COLL].doc["jobs"]["suggest"] == {"provider": "openrouter", "model": "anthropic/claude-haiku-5.5",
                                                   "on": True, "delay": 15}
    assert llm.route("suggest") == ("openrouter", "anthropic/claude-haiku-5.5")
    # The switch turned off afterwards, sent with the route the row shows, leaves the route alone.
    run(llm.save(db, jobs={"suggest": {"provider": "openrouter", "model": "anthropic/claude-haiku-5.5", "on": False}}))
    assert llm.route("suggest") == ("openrouter", "anthropic/claude-haiku-5.5")
    # A provider with no model is refused, never kept half way.
    with pytest.raises(ValueError):
        run(llm.save(db, jobs={"suggest": {"provider": "openrouter", "model": ""}}))
    assert llm.route("suggest") == ("openrouter", "anthropic/claude-haiku-5.5")


def _src(name: str) -> str:
    return (APP / name).read_text()


def test_one_model_picker_for_the_chat_and_the_settings():
    picker = _src("model-picker.ts")
    chat = _src("rooms/commandcode.ts")
    page = _src("llm-settings.ts")
    assert "selector: 'app-model-picker'" in picker
    for src in (chat, page):
        assert "<app-model-picker" in src and "ModelPicker" in src
    # The list is drawn in one place only.
    assert "tcv-cc-modellist" in picker
    assert "tcv-cc-modellist" not in chat and "tcv-cc-modellist" not in page
    # No native select for a job's model: the only one is its provider.
    jobs = page[page.index("'Which model does what' | t"):page.index("<app-llm-usage />")]
    assert jobs.count("<select") == 1 and 'class="st-in st-prov"' in jobs
    # In a settings row the list is against the window (the card scrolls).
    assert re.search(r'<app-model-picker[^>]*\[fixed\]="true"', page)


def test_a_route_is_shown_before_it_is_sent_and_sends_go_in_order():
    page = _src("llm-settings.ts")
    route = page[page.index("  private route(j: string"):]
    route = route[:route.index("\n  }\n")]
    # The row takes the new route first, so a switch or a wait changed
    # before the answer comes sends it, not the one it replaces.
    assert route.index("this.patchJob(") < route.index("this.put(")
    switch = page[page.index("  setSwitch("):]
    switch = switch[:switch.index("\n  }\n")]
    assert "job.provider" in switch and "job.model" in switch
    # One change after another.
    assert "this.queue = this.queue.then(" in page
    # A provider still waiting for its model says so on its row, with a way back.
    assert "st-job-pending" in page and "cancelPending(j)" in page
    assert "'not saved until a model is chosen - the job stays on'" in _src("i18n.ts")


def test_the_default_is_a_row_of_the_picker_not_a_button():
    page = _src("llm-settings.ts")
    picker = _src("model-picker.ts")
    jobs = page[page.index("'Which model does what' | t"):page.index("<app-llm-usage />")]
    # No button of its own on the row: every row's columns line up.
    assert "(click)=\"reset(j)\"" not in jobs
    assert '(pickDefault)="reset(j)"' in jobs and '[fallback]="fallbacks()[j]"' in jobs
    assert "tcv-mp-default" in picker and "pickDefault" in picker
    # The chip names the provider whose model it is, and the list says whose list it is.
    # The provider is named by its own select beside the picker, not a tag in it.
    assert '[models]="models()[prov(j)] || []"' in jobs and "setProvider(j, " in jobs
