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


# ---------------------------------------------------------------- the proxy and the route orders

@pytest.fixture()
def proxy_unread(monkeypatch):
    """This process has not read the proxy settings and the route orders."""
    from backend import netproxy, netroutes
    monkeypatch.setattr(netproxy, "_conf", {})
    monkeypatch.setattr(netproxy, "_loaded", False)
    monkeypatch.setattr(netproxy, "_load_error", None)
    monkeypatch.setattr(netroutes, "_orders", {})
    monkeypatch.setattr(netroutes, "_loaded", False)
    monkeypatch.setattr(netroutes, "_load_error", None)


def test_never_read_proxy_settings_are_not_taken_for_no_proxy(proxy_unread):
    from backend import lcsc, netproxy, netroutes
    with pytest.raises(llm.NotLoaded, match="Proxy settings not loaded: whether a proxy is set up .*never read"):
        netproxy.url()
    with pytest.raises(llm.NotLoaded, match="netproxy.load"):
        netproxy.active()
    with pytest.raises(llm.NotLoaded, match="Route orders not loaded"):
        netroutes.order("parts")
    with pytest.raises(llm.NotLoaded, match="Route orders not loaded"):
        netroutes.plan("catalog")
    with pytest.raises(llm.NotLoaded):
        netproxy.public()
    # given its settings, the url is still made (the settings page's test does that)
    assert netproxy.url({"host": "gw.example", "port": 1}) == "http://gw.example:1"
    # an EasyEDA lookup does not quietly go out directly
    went = []
    with pytest.raises(llm.NotLoaded):
        run(lcsc._polite("search", "x", "u", lambda url: went.append(url) or {}, "u"))
    assert went == []


def test_a_proxy_read_that_finds_nothing_is_no_proxy_and_the_default_order(proxy_unread):
    from backend import netproxy, netroutes
    fake = FakeDb()
    run(netproxy.load(fake))
    assert netproxy.loaded() and netroutes.loaded()
    assert netproxy.url() is None and netproxy.active() is False
    assert netroutes.order("parts") == ["local"] and netroutes.plan("catalog") == ["local"]


def test_a_failed_proxy_read_says_why(proxy_unread):
    from backend import netproxy, netroutes
    with pytest.raises(ConnectionError):
        run(netproxy.load(Broken()))
    with pytest.raises(llm.NotLoaded, match="reading them failed .*no database at mongo"):
        netproxy.url()
    with pytest.raises(ConnectionError):
        run(netroutes.load(Broken()))
    with pytest.raises(llm.NotLoaded, match="reading them failed .*no database at mongo"):
        netroutes.order("catalog")
    # read once, a later failure keeps what was read
    fake = FakeDb()
    run(fake[netproxy.COLL].insert_one({"_id": netproxy.DOC_ID, "host": "gw.example", "port": 2334}))
    run(netproxy.load(fake))
    with pytest.raises(ConnectionError):
        run(netproxy.load(Broken()))
    assert netproxy.url() == "http://gw.example:2334"


def test_the_api_reads_the_proxy_with_the_llm_settings_before_it_starts_anything():
    import inspect
    from backend import main
    src = inspect.getsource(main._start_sampler)
    first = src.index("for mod in (llm, jina, netproxy):")
    assert first < src.index("create_task(")                   # before any loop that may ask


def test_a_manufacturer_run_in_a_process_that_never_read_them_fails_on_its_record(unread):
    from backend import manufacturers as mf
    fake = FakeDb()

    async def go():
        doc = await mf.create(fake, "https://www.example.com/", by={"id": "a", "name": "A"})
        jd, started = await mf.start_job(fake, doc["_id"])
        return doc, jd, started, await mf.job(fake, jd["_id"]), await mf.get(fake, doc["_id"])

    doc, jd, started, d, m = run(go())
    assert started and jd["_id"] not in mf._TASKS                 # nothing was fetched or asked
    assert d["status"] == "failed" and d["finished_at"] and d["model"] is None
    assert "LLM settings not loaded" in d["error"] and m["last_job"] == jd["_id"]


def test_a_manufacturer_run_without_the_route_orders_fails_on_its_record(proxy_unread):
    from backend import manufacturers as mf
    fake = FakeDb()

    async def go():
        doc = await mf.create(fake, "https://www.example.com/", by={"id": "a", "name": "A"})
        jd, _ = await mf.start_job(fake, doc["_id"])
        return jd, await mf.job(fake, jd["_id"])

    jd, d = run(go())
    assert jd["_id"] not in mf._TASKS
    assert d["status"] == "failed" and "Route orders not loaded" in d["error"]
    assert mf.job_out(d)["route"] == ["local"]


def test_the_chat_runner_reads_the_proxy_and_route_orders_too():
    """A Chat answer is written by a process of its own (backend/ccgen.py);
    it read the LLM and Jina settings but not the proxy's, so the catalog's
    page reading (catalog_read_page) failed "Route orders not loaded"."""
    import inspect
    from backend import ccgen
    src = inspect.getsource(ccgen._main)
    assert '("proxy", netproxy.load)' in src
    assert src.index("netproxy.load") < src.index("await run(gid")
