"""Editing source in the code view: a save names the version it started
from, and a source changed in between is not written over."""
import pytest
from fastapi import HTTPException

from backend import access
from backend.main import _rev, _stale_write


def test_the_version_is_a_fingerprint_of_the_text():
    assert _rev("a") == _rev("a") and _rev("a") != _rev("b") and len(_rev("a")) == 16


def test_a_save_from_an_older_version_is_refused():
    _stale_write("same", _rev("same"))                  # nothing changed: goes through
    _stale_write("anything", None)                      # no version named: the old behaviour
    with pytest.raises(HTTPException) as e:
        _stale_write("the agent's", _rev("mine"))
    assert e.value.status_code == 409 and e.value.detail["rev"] == _rev("the agent's")


def test_only_editors_and_up_write_source():
    for path in ("/api/models/iot-fan/stand", "/api/boards/controller"):
        act = access.action("PUT", path)
        assert access.allowed("editor", act) and not access.allowed("reviewer", act)
