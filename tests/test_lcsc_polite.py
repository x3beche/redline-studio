"""Asking EasyEDA politely, and writing every ask down.

Their endpoints turn a burst away - a 403 that lasted minutes, twice in
one session. What has to hold: asks are spaced; a refusal stops every
later ask, from any process, without sending it; nothing is retried into
a refusal; and the journal the page shows records all of it.
"""

from __future__ import annotations

import asyncio
import io
import json
import sys
import time
import urllib.error
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import lcsc


@pytest.fixture(autouse=True)
def spaced(monkeypatch):
    """conftest.py already keeps this away from the real cache; here the
    gap is made measurable and the cool-off short."""
    monkeypatch.setattr(lcsc, "GAP", 0.2)
    monkeypatch.setattr(lcsc, "COOL_OFF", 60)


def _refuse(code):
    def fn(url):
        raise urllib.error.HTTPError(url, code, "no", {}, io.BytesIO(b""))
    return fn


def run(coro):
    return asyncio.run(coro)


def test_an_ask_is_written_down():
    run(lcsc._polite("search", "10k", "https://x/?q=10k", lambda url: {"ok": 1}, "u"))
    row = lcsc.journal()[0]
    assert (row["kind"], row["target"], row["source"], row["status"]) == \
        ("search", "10k", "net", 200)
    assert row["url"] == "https://x/?q=10k"


def test_asks_are_spaced():
    ok = lambda url: {}
    t0 = time.monotonic()
    run(lcsc._polite("search", "a", "", ok, "u"))
    run(lcsc._polite("search", "b", "", ok, "u"))
    run(lcsc._polite("search", "c", "", ok, "u"))
    assert time.monotonic() - t0 >= 2 * lcsc.GAP * 0.9


@pytest.mark.parametrize("code", [403, 429])
def test_a_refusal_stops_every_later_ask_without_sending_it(code):
    with pytest.raises(lcsc.Refused):
        run(lcsc._polite("component", "C1234", "", _refuse(code), "u"))

    sent = []
    with pytest.raises(lcsc.Refused):
        run(lcsc._polite("search", "later", "", lambda url: sent.append(url), "u"))
    assert sent == [], "the second ask must not reach EasyEDA"

    rows = lcsc.journal()
    assert rows[0]["source"] == "refused"
    assert rows[1]["status"] == code


def test_the_refusal_is_shared_through_the_file():
    # Another process - the page's server, an agent's command line - reads
    # the same file. Simulate it by reading the state the way it would.
    with pytest.raises(lcsc.Refused):
        run(lcsc._polite("search", "x", "", _refuse(403), "u"))
    state = json.loads((lcsc.LOOK / "_state.json").read_text())
    assert state["refused_until"] > time.time() + 50
    assert "403" in state["refused_why"]
    assert lcsc.state()["refused_until"] is not None


def test_other_errors_are_not_a_refusal():
    with pytest.raises(urllib.error.HTTPError):
        run(lcsc._polite("photo", "C1234", "", _refuse(404), "u"))
    assert lcsc.state()["refused_until"] is None
    assert lcsc.journal()[0]["status"] == 404


def test_a_file_already_on_disk_asks_nothing_and_says_so():
    (lcsc.LOOK / "C1234").mkdir(parents=True)
    (lcsc.LOOK / "C1234" / "svgs.json").write_bytes(b"{}")
    out = run(lcsc._kept("C1234", "svgs.json", "https://never"))
    assert out == b"{}"
    row = lcsc.journal()[0]
    assert (row["kind"], row["source"], row["bytes"]) == ("drawings", "disk", 2)


def test_who_asked_is_recorded():
    token = lcsc.WHO.set("agent")
    try:
        run(lcsc._polite("search", "q", "", lambda url: {}, "u"))
    finally:
        lcsc.WHO.reset(token)
    assert lcsc.journal()[0]["who"] == "agent"


def test_the_journal_is_newest_first_and_bounded(monkeypatch):
    monkeypatch.setattr(lcsc, "KEEP_LINES", 5)
    for i in range(40):
        lcsc._record("search", f"q{i}", "disk")
    rows = lcsc.journal(1000)
    assert rows[0]["target"] == "q39"
    assert len(rows) <= 40
    assert (lcsc.LOOK / "requests.jsonl").stat().st_size < 40 * 600
