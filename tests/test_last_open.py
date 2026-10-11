"""Where each account left off (PUT /api/me/last-open, backend/profile.py):
kept on the account, handed back by /api/auth/state, one account's never
another's - so switching accounts or signing out opens the same model."""

from __future__ import annotations

from test_users_admin import db, person  # noqa: F401  (the fixture)


def test_the_last_model_is_kept_on_the_account(db):  # noqa: F811
    a = person(db, "a")
    assert a.get("/api/auth/state").json()["last_open"] == {}
    r = a.put("/api/me/last-open", json={"model": "iot-fan/Station"})
    assert r.status_code == 200 and r.json() == {"saved": ["model"]}
    assert a.get("/api/auth/state").json()["last_open"] == {"model": "iot-fan/Station"}
    # A new session - after signing out, or from another browser - has it too.
    assert person(db, "a").get("/api/auth/state").json()["last_open"]["model"] == "iot-fan/Station"


def test_each_account_has_its_own(db):  # noqa: F811
    person(db, "a").put("/api/me/last-open", json={"model": "m-a"})
    person(db, "b").put("/api/me/last-open", json={"model": "m-b"})
    assert person(db, "a").get("/api/auth/state").json()["last_open"] == {"model": "m-a"}
    assert person(db, "b").get("/api/auth/state").json()["last_open"] == {"model": "m-b"}


def test_rooms_are_kept_apart_and_empty_values_change_nothing(db):  # noqa: F811
    a = person(db, "a")
    a.put("/api/me/last-open", json={"model": "m1"})
    a.put("/api/me/last-open", json={"board": "b1"})
    assert a.put("/api/me/last-open", json={"model": None}).json() == {"saved": []}
    assert a.get("/api/auth/state").json()["last_open"] == {"model": "m1", "board": "b1"}


def test_signed_out_keeps_nothing(db):  # noqa: F811
    from test_users_admin import app
    c = app()
    c.headers["x-redline-csrf"] = "1"
    assert c.put("/api/me/last-open", json={"model": "m"}).status_code in (401, 403)
    assert c.get("/api/auth/state").json()["last_open"] == {}
