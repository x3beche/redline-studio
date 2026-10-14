"""The secrets kept in the database, encrypted at rest (backend/secretbox.py):
sealed on the way in, read back whole, older plaintext still read, the pages
still shown only whether a secret is set, the migration done once, and a key
that does not fit said clearly instead of taking the API down.

Every value here is made up; each test has a key of its own (conftest.py)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import stat

import pytest

from backend import jina, llm, mcmaster, netproxy, secretbox
from backend.tgbot import core as tg
from test_telegram import FakeDb
from test_users_admin import db, person  # noqa: F401 - db is a fixture

JINA = "jina_" + "e" * 40 + "Qrst"
ORK = "sk-or-v1-" + "a" * 48 + "Mnop"
PW = "made-up p@ss/word"


def run(c):
    return asyncio.run(c)


def other_key(monkeypatch, tmp_path):
    """The server started again with another key (the old one lost)."""
    monkeypatch.setenv(secretbox.KEY_FILE_ENV, str(tmp_path / "another.key"))
    secretbox.reset()


# ---------------------------------------------------------------- the box

def test_a_secret_goes_in_sealed_and_comes_back_whole():
    s = secretbox.seal(PW)
    assert s.startswith(secretbox.PREFIX) and PW not in s
    assert secretbox.unseal(s) == PW
    assert secretbox.seal(s) == s                      # sealed once, not twice
    assert secretbox.seal("") == "" and secretbox.seal(None) is None


def test_an_older_plaintext_value_is_still_read():
    assert secretbox.unseal(PW) == PW and secretbox.reveal(PW, "x") == PW
    assert not secretbox.unreadable(PW)


def test_the_key_file_is_made_once_with_0600(tmp_path):
    path = tmp_path / "secret.key"
    assert not path.exists()
    s = secretbox.seal(PW)
    assert path.exists() and stat.S_IMODE(os.stat(path).st_mode) == 0o600
    first = path.read_bytes()
    secretbox.reset()                                  # a restart reads the same file
    assert secretbox.unseal(s) == PW and path.read_bytes() == first


def test_the_env_key_wins_and_a_passphrase_works(monkeypatch, tmp_path):
    monkeypatch.setenv(secretbox.KEY_ENV, "a long made-up passphrase, not a Fernet key")
    secretbox.reset()
    s = secretbox.seal(PW)
    assert not (tmp_path / "secret.key").exists()      # no file when the variable is set
    secretbox.reset()
    assert secretbox.unseal(s) == PW


def test_a_wrong_key_is_a_clear_error_not_a_crash(monkeypatch, tmp_path, caplog):
    s = secretbox.seal(PW)
    other_key(monkeypatch, tmp_path)
    with pytest.raises(secretbox.SecretError, match="does not decrypt"):
        secretbox.unseal(s)
    assert secretbox.unreadable(s)
    with caplog.at_level(logging.ERROR, logger="redline.secretbox"):
        assert secretbox.reveal(s, "the test secret") is None
    assert "the test secret" in caplog.text and "Settings again" in caplog.text and PW not in caplog.text


# ---------------------------------------------------------------- where they are kept

def test_the_llm_key_is_sealed_in_the_database_and_masked_on_the_page(db, monkeypatch, tmp_path):  # noqa: F811
    o = person(db, "o")
    r = o.put("/api/llm/settings", json={"keys": {"openrouter": ORK}})
    assert r.status_code == 200 and ORK not in r.text
    stored = db[llm.COLL].docs[llm.DOC_ID]["keys"]["openrouter"]
    assert secretbox.sealed(stored) and ORK not in json.dumps(db[llm.COLL].docs, default=str)
    assert llm.key("openrouter") == ORK
    got = o.get("/api/llm/settings")
    assert ORK not in got.text and "Mnop" in got.text            # set, and only its last four
    # another key: the page says not set, a call says why and what to do
    other_key(monkeypatch, tmp_path)
    assert llm.key("openrouter") is None
    assert "does not decrypt" in llm.no_key("openrouter")
    assert o.get("/api/llm/settings").status_code == 200


def test_the_jina_key_is_sealed(db, monkeypatch):  # noqa: F811
    monkeypatch.setattr(jina, "_conf", {})
    o = person(db, "o")
    r = o.put("/api/jina/settings", json={"key": JINA})
    assert r.status_code == 200 and JINA not in r.text and r.json()["hint"] == "…Qrst"
    assert secretbox.sealed(db[jina.COLL].docs[jina.DOC_ID]["key"])
    assert jina.key() == JINA
    # an older plaintext key, as the database held it before
    monkeypatch.setattr(jina, "_conf", {"key": JINA})
    assert jina.key() == JINA


def test_the_proxy_password_is_sealed(db):  # noqa: F811
    o = person(db, "o")
    r = o.put("/api/proxy/settings", json={"host": "gw.example", "port": 2334, "username": "u", "password": PW})
    assert r.status_code == 200 and PW not in r.text and r.json()["password_set"] is True
    assert secretbox.sealed(db[netproxy.COLL].docs[netproxy.DOC_ID]["password"])
    assert netproxy.url() == "http://u:made-up%20p%40ss%2Fword@gw.example:2334"


def test_the_mcmaster_credentials_and_certificate_are_sealed(db):  # noqa: F811
    o = person(db, "o")
    r = o.put("/api/mcmaster/settings", json={"username": "me", "password": PW, "cert_password": PW + "2"})
    assert r.status_code == 200 and PW not in r.text
    r = o.post("/api/mcmaster/settings/cert", files={"upload": ("me.pfx", b"made-up certificate bytes")})
    assert r.status_code == 200 and r.json()["cert_password_set"] and r.json()["filled"]
    doc = db[mcmaster.SETTINGS].docs[mcmaster.SETTINGS_ID]
    assert all(secretbox.sealed(v) for v in (doc["password"], doc["cert_password"], doc["cert"]["data"]))
    assert doc["username"] == "me"                                # not a secret
    c = run(mcmaster.conf(db))
    assert c["password"] == PW and c["cert_password"] == PW + "2" and c["cert"]["data"]
    assert o.post("/api/mcmaster/test").json()["implemented"] is False   # the stub still answers


def test_the_telegram_token_and_webhook_secret_are_sealed():
    fake = FakeDb()
    run(tg.patch_settings(fake, {"token": "123:" + "x" * 35, "secret": "made-up-secret", "public_url": "https://x"}))
    doc = fake[tg.SETTINGS].docs[tg.DOC_ID]
    assert secretbox.sealed(doc["token"]) and secretbox.sealed(doc["secret"]) and doc["public_url"] == "https://x"
    st = run(tg.settings(fake))
    assert st["token"] == "123:" + "x" * 35 and st["secret"] == "made-up-secret"


# ---------------------------------------------------------------- the migration

def _plain_db() -> FakeDb:
    fake = FakeDb()
    fake["llm_settings"].docs["llm"] = {"_id": "llm", "keys": {"openrouter": ORK, "anthropic": "sk-ant-made-up"},
                                        "jobs": {}}
    fake["server_settings"].docs["jina"] = {"_id": "jina", "key": JINA}
    fake["server_settings"].docs["proxy"] = {"_id": "proxy", "host": "gw.example", "password": PW}
    fake["server_settings"].docs["routes"] = {"_id": "routes", "parts": ["local"]}
    fake["server_settings"].docs["mcmaster"] = {"_id": "mcmaster", "username": "me", "password": PW,
                                                "cert": {"name": "me.pfx", "data": "bWFkZS11cA=="}}
    fake["telegram_settings"].docs["bot"] = {"_id": "bot", "token": "123:" + "x" * 35, "public_url": "https://x"}
    return fake


def test_the_migration_seals_every_plaintext_secret_once():
    fake = _plain_db()
    got = run(secretbox.migrate(fake))
    assert got == {"encrypted": 7, "already": 0}
    dump = json.dumps({n: c.docs for n, c in fake.colls.items()}, default=str)
    for secret in (ORK, JINA, PW, "sk-ant-made-up", "bWFkZS11cA==", "123:" + "x" * 35):
        assert secret not in dump
    assert fake["server_settings"].docs["mcmaster"]["username"] == "me"
    assert fake["server_settings"].docs["routes"] == {"_id": "routes", "parts": ["local"]}
    before = dump
    assert run(secretbox.migrate(fake)) == {"encrypted": 0, "already": 7}      # again: nothing changes
    assert json.dumps({n: c.docs for n, c in fake.colls.items()}, default=str) == before
    # and every one still reads back
    assert secretbox.unseal(fake["llm_settings"].docs["llm"]["keys"]["openrouter"]) == ORK
    assert secretbox.unseal(fake["server_settings"].docs["mcmaster"]["cert"]["data"]) == "bWFkZS11cA=="


def test_the_migration_of_an_empty_database_does_nothing():
    assert run(secretbox.migrate(FakeDb())) == {"encrypted": 0, "already": 0}
