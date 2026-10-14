"""Settings that were never read are not taken for the defaults
(backend/llm.py, backend/jina.py): a process of its own - a job, a script
run with docker exec - that skipped load() is told so when it asks for a
job's model or a key, instead of running on the default. A Taste
extraction once ran on the cheap model instead of the one chosen that way.
The defaults are what a load() that found nothing saved answers."""

from __future__ import annotations

import asyncio

import pytest

from backend import jina, llm, summarise, taste
from test_telegram import FakeDb


def run(c):
    return asyncio.run(c)


@pytest.fixture()
def unread(monkeypatch):
    """This process has not read the settings (conftest reads them for every
    other test, as the API does at its start)."""
    monkeypatch.setattr(llm, "_conf", {"keys": {}, "jobs": {}})
    monkeypatch.setattr(llm, "_loaded", False)
    monkeypatch.setattr(llm, "_load_error", None)
    monkeypatch.setattr(jina, "_conf", {})
    monkeypatch.setattr(jina, "_loaded", False)
    monkeypatch.setattr(jina, "_load_error", None)


class Broken:
    """A database that does not answer."""
    SCOPED = False

    def __getitem__(self, name):
        return self

    async def find_one(self, *a, **kw):
        raise ConnectionError("no database at mongo:27017")


def test_never_read_refuses_to_name_a_model_or_a_key(unread):
    with pytest.raises(llm.NotLoaded) as e:
        llm.route("taste")
    assert "Taste extraction" in str(e.value) and "(taste)" in str(e.value)
    assert "never read" in str(e.value) and "llm.load" in str(e.value)
    with pytest.raises(llm.NotLoaded, match="Claude API API key"):
        llm.key("claude")
    with pytest.raises(llm.NotLoaded, match="Next-question suggestion"):
        llm.job_switch("suggest")
    with pytest.raises(llm.NotLoaded, match="Chat example questions"):
        llm.job_ideas("chat_suggestions")
    with pytest.raises(llm.NotLoaded, match="Card summaries"):
        summarise.api_key("summary")
    with pytest.raises(llm.NotLoaded, match="Jina"):
        jina.configured()
    assert not llm.loaded()


def test_a_failed_read_says_why(unread):
    with pytest.raises(ConnectionError):
        run(llm.load(Broken()))
    with pytest.raises(ConnectionError):
        run(jina.load(Broken()))
    with pytest.raises(llm.NotLoaded, match="reading them failed .*no database at mongo"):
        llm.route("summary")
    with pytest.raises(llm.NotLoaded, match="reading it failed .*no database at mongo"):
        jina.key()


def test_read_with_nothing_saved_gives_the_defaults(unread):
    fake = FakeDb()
    run(llm.load(fake))
    run(jina.load(fake))
    assert llm.loaded()
    for job in llm.JOBS:
        assert llm.route(job) == llm.JOBS[job]["default"]
    assert llm.key("openrouter") is None
    assert llm.job_switch("suggest")["on"] is False
    assert llm.job_ideas("chat_suggestions") == llm.IDEAS_DEFAULT
    assert jina.configured() is False


def test_read_gives_what_was_saved(unread):
    fake = FakeDb()
    run(fake[llm.COLL].insert_one({"_id": llm.DOC_ID, "keys": {"claude": "sk-ant-test-0000"},
                                   "jobs": {"taste": {"provider": "claude", "model": "claude-opus-4-1"}}}))
    run(fake[jina.COLL].insert_one({"_id": jina.DOC_ID, "key": "jina_test_0000"}))
    run(llm.load(fake))
    run(jina.load(fake))
    assert llm.route("taste") == ("claude", "claude-opus-4-1")
    assert llm.route("summary") == llm.CHEAP                     # nothing saved for it
    assert llm.key("claude") == "sk-ant-test-0000"
    assert jina.configured() is True


def test_a_read_that_fails_later_keeps_what_was_read(unread):
    fake = FakeDb()
    run(fake[llm.COLL].insert_one({"_id": llm.DOC_ID, "jobs": {"taste": {"provider": "claude", "model": "m"}}}))
    run(llm.load(fake))
    with pytest.raises(ConnectionError):
        run(llm.load(Broken()))
    assert llm.route("taste") == ("claude", "m")


def test_a_taste_run_in_a_process_that_never_read_them_fails_on_its_record(unread):
    fake = FakeDb()
    run(fake["models"].insert_one({"_id": "case", "title": "Fan case", "source": "box = Box(1, 1, 1)"}))

    async def go():
        doc, started = await taste.start_job(fake, "model", "case")
        return doc, await taste.job(fake, doc["_id"])

    doc, d = run(go())
    assert doc["_id"] not in taste._TASKS                       # nothing was asked
    assert d["status"] == "failed" and d["finished_at"] and d["model"] is None
    assert "LLM settings not loaded" in d["error"] and "Taste extraction" in d["error"]
    assert "never read" in taste.job_out(d)["error"]
