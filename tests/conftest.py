"""What every test gets, whether it asks or not."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
# Tests read the repo's files (frontend/src/app/i18n.ts...) by their paths from the root: run from there wherever pytest was started.
os.chdir(Path(__file__).resolve().parent.parent)


@pytest.fixture(autouse=True)
def _lcsc_elsewhere(tmp_path, monkeypatch):
    """No test reads or writes the real LCSC cache, turn-taking or journal.

    The journal is what the page shows as "what the agents did to LCSC";
    a test run once wrote rows into it that nobody had asked for, and a
    real cool-off made unrelated tests fail. Each test gets its own.
    """
    from backend import lcsc

    look = tmp_path / "lcsc"
    look.mkdir()
    monkeypatch.setattr(lcsc, "LOOK", look)
    monkeypatch.setattr(lcsc, "GAP", 0.0)


@pytest.fixture(autouse=True)
def _route_orders_of_its_own(monkeypatch):
    """Each test starts from the default route orders (backend/netroutes.py):
    a server started by one test loads its fake database's orders, and those
    must not decide how the next test's lookups go out."""
    from backend import netroutes
    monkeypatch.setattr(netroutes, "_orders", {})


@pytest.fixture(autouse=True)
def _builds_in_process(monkeypatch):
    """A model build is a process of its own (backend/buildjobs.py). In a
    test its runner is a task in this process, so the build.build a test
    stands in is the one that runs, and nothing is started for real."""
    import asyncio

    from backend import buildjobs

    async def spawn(raw, job_id):
        asyncio.create_task(buildjobs.run(raw, job_id))
        return 0

    monkeypatch.setattr(buildjobs, "spawn", spawn)
    monkeypatch.setattr(buildjobs, "POLL", 0.02)


@pytest.fixture(autouse=True)
def _cc_answers_in_process(monkeypatch):
    """A Command Code answer is written by a process of its own
    (backend/ccgen.py). In a test its runner is a task in this process, so
    the llm.stream a test stands in is the one that answers; and the
    answer is written and followed at once, not every quarter second."""
    import asyncio

    from backend import cc_chat, ccgen

    async def spawn(db, gid):
        task = asyncio.ensure_future(ccgen.run(gid))
        cc_chat._TASKS.add(task)
        task.add_done_callback(cc_chat._TASKS.discard)
        return 0

    monkeypatch.setattr(ccgen, "spawn", spawn)
    monkeypatch.setattr(ccgen, "FLUSH", 0.005)
    monkeypatch.setattr(cc_chat, "TAIL", 0.005)
    cc_chat.HUB.tails.clear()
    cc_chat.HUB.live.clear()
    cc_chat.HUB.poked.clear()


@pytest.fixture(autouse=True)
def _secret_key_of_its_own(tmp_path, monkeypatch):
    """The secrets saved by a test are sealed with a key of the test's own
    (backend/secretbox.py) - never with the checkout's .secrets/secret.key,
    and never by making one there."""
    from backend import secretbox

    monkeypatch.delenv(secretbox.KEY_ENV, raising=False)
    monkeypatch.setenv(secretbox.KEY_FILE_ENV, str(tmp_path / "secret.key"))
    secretbox.reset()
    yield
    secretbox.reset()


@pytest.fixture(autouse=True)
def _settings_read_as_on_a_fresh_install(monkeypatch):
    """Each test runs as the API does after its start: the LLM settings,
    Jina's key and the proxy with its route orders have been read
    (backend/main.py), and nothing is saved - so the defaults answer (no
    proxy, the default orders). Not "never read": that refuses to answer
    (llm.NotLoaded), and the tests that want it say so themselves. Set per
    test, so one test's saved choices never decide the next one's."""
    from backend import jina, llm, netproxy, netroutes

    monkeypatch.setattr(llm, "_conf", {"keys": {}, "jobs": {}})
    monkeypatch.setattr(llm, "_loaded", True)
    monkeypatch.setattr(llm, "_load_error", None)
    monkeypatch.setattr(jina, "_conf", {})
    monkeypatch.setattr(jina, "_loaded", True)
    monkeypatch.setattr(jina, "_load_error", None)
    monkeypatch.setattr(netproxy, "_conf", {})
    monkeypatch.setattr(netproxy, "_loaded", True)
    monkeypatch.setattr(netproxy, "_load_error", None)
    monkeypatch.setattr(netroutes, "_orders", {})
    monkeypatch.setattr(netroutes, "_loaded", True)
    monkeypatch.setattr(netroutes, "_load_error", None)


@pytest.fixture(autouse=True)
def _sign_in_memory_of_its_own():
    """What backend/auth.py keeps in memory - the sessions and agent tokens
    looked up in the last minute, failed sign-ins and switches, the tries
    counted per address, agent token use not yet written out - starts
    empty for each test and is left empty after it. A test that leaves
    five failed switches or thirty tries behind (or a tally that the next
    test's database would get) does not decide how the next one signs in."""
    from backend import auth

    def clear():
        for kept in (auth._CACHE, auth._TOKEN_CACHE, auth._FAILS, auth._HITS, auth._USAGE):
            kept.clear()
        auth._USAGE_DB = None
        auth._USAGE_TASK = None

    clear()
    yield
    clear()


@pytest.fixture(autouse=True)
def _scrypt_answers_the_same(monkeypatch):
    """scrypt must give one key for one password and salt. This host's CPU
    runs at 88-96 °C and once gave two; a sign-in then fails as a bare 401
    ("that email and password do not match") that no code explains. So a
    password check that says no is looked at again, and the test fails
    saying what happened when:
    - the same check says yes the second time, or
    - the stored hash was made in this test from this very password
      (auth.hash_password) - the code under test cannot get that wrong;
      only a wrong key, computed once, can.
    Nothing is retried into a pass: either case fails the test."""
    from backend import auth

    real_hash, real_check = auth.hash_password, auth.check_password
    made: dict[str, str] = {}

    def hash_password(password: str) -> str:
        stored = real_hash(password)
        made[stored] = password
        return stored

    def check_password(password: str, stored: str) -> bool:
        if real_check(password, stored):
            return True
        if real_check(password, stored):
            pytest.fail("HARDWARE? hashlib.scrypt gave two different keys for the same password and salt: "
                        "auth.check_password said no, then yes - not a bug in the code under test", pytrace=False)
        if made.get(stored) == password:
            pytest.fail("HARDWARE? the hash auth.hash_password made in this test from this password does not "
                        f"check against it ({stored[:40]}...): scrypt computed a wrong key once - not a bug in "
                        "the code under test", pytrace=False)
        return False

    monkeypatch.setattr(auth, "hash_password", hash_password)
    monkeypatch.setattr(auth, "check_password", check_password)
