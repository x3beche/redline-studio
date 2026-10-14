"""The notification centre (backend/notifications.py), fed by the watcher
(backend/tgbot/notify.py): each event once, one row per person of its space
who wants it in the app - with or without a Telegram bot or link - the two
new kinds (a technical drawing made or failed, a price dropped), the
per-kind settings (the Telegram side kept in the link's own preferences),
and the routes, each person seeing and changing only their own. The
database and the bot are test_telegram's fakes."""

from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi import HTTPException

from backend import access, actors, auth, notifications as nc, release, scope
from backend.tgbot import core, links, notify
from test_telegram import configured, drain, env, linked, made_everything, run  # noqa: F401 - env is a fixture


def rows(db, user=None):
    return [d for d in db[nc.COLL].docs.values() if user is None or d["user"] == user]


def start(db):
    """The first look starts the clocks."""
    run(notify.tick(db))


def people(db, monkeypatch):
    """Sign-in on: the owner (the default space), an admin and a user each in
    their own, a disabled account and a second account working in the default space."""
    monkeypatch.setattr(auth, "enabled", lambda: True)
    for uid, role, extra in (("o", "owner", {}), ("ad", "admin", {}), ("u", "user", {}),
                             ("off", "user", {"disabled": True, "space": scope.DEFAULT}),
                             ("mate", "user", {"space": scope.DEFAULT})):
        db[auth.USERS].docs[uid] = {"_id": uid, "email": f"{uid}@x.y", "name": uid, "role": role, **extra}


def as_user(uid, ws=scope.DEFAULT, page=False):
    actors.CURRENT.set({"type": "user", "id": uid, "name": uid, **({"page": True} if page else {})})
    scope.WORKSPACE.set(ws)


# ---------------------------------------------------------------- the watcher

def test_without_a_bot_the_app_still_hears_and_telegram_does_not(env):
    linked(env.db)                                          # a link left from an old bot, no token now
    start(env.db)
    made_everything(env.db)
    assert run(notify.tick(env.db)) == 8
    kinds = sorted(d["kind"] for d in rows(env.db))
    # the drawer is off in the app by default; the rest is one row each, for the person at the machine
    assert kinds == sorted(["reply", "reply", "route", "longbuild", "firmware", "release", "bodies"])
    assert {d["user"] for d in rows(env.db)} == {nc.LOCAL}
    assert not env.db[core.OUTBOX].docs                     # nothing queued for Telegram


def test_each_event_is_one_row_per_person_however_often_it_is_seen(env):
    configured(env.db)
    start(env.db)
    made_everything(env.db)
    run(notify.tick(env.db))
    n = len(rows(env.db))
    assert run(notify.tick(env.db)) == 0 and len(rows(env.db)) == n
    # the same event delivered again (two processes, a crash between announcing and writing)
    one = next(iter(env.db[nc.COLL].docs.values()))
    assert run(nc.deliver(env.db, scope.DEFAULT, one["kind"], one["event"], {"title": "x"})) == 0
    assert len(rows(env.db)) == n


def test_rows_carry_a_title_the_names_and_the_in_app_link(env):
    configured(env.db)
    start(env.db)
    made_everything(env.db)
    run(notify.tick(env.db))
    by = {d["title"]: d for d in rows(env.db)}
    assert by["Board routed"]["link"] == "/pcb/ctl" and "Controller" in by["Board routed"]["ctx"]
    # the words between the names in Turkish too; the names as they are
    assert "all connected" in by["Board routed"]["ctx"] and "Controller · hepsi bağlı" in by["Board routed"]["ctx_tr"]
    assert by["Firmware built"]["ctx_tr"] is None                               # nothing but names: one is enough
    assert by["Agent replied"]["link"] == "/chat/thread/pcb"
    assert by["Chat answered"]["link"] == "/chat/k1" and "Thermal budget" in by["Chat answered"]["ctx"]
    assert by["Firmware built"]["link"] == "/firmware/fan"
    assert by["Build done"]["link"] == "/3d/iot/box"
    assert all(d["read_at"] is None and d["workspace"] == scope.DEFAULT for d in rows(env.db))


def test_the_people_of_the_space_hear_with_or_without_telegram(env, monkeypatch):
    configured(env.db)
    people(env.db, monkeypatch)
    linked(env.db, user="o", role="owner")                  # the owner linked a chat; "mate" did not
    start(env.db)
    env.db.compute_jobs.docs["x1"] = {"_id": "x1", "kind": "build", "model": "iot/box", "rc": 2, "at": core.iso()}
    run(notify.tick(env.db))
    assert sorted(d["user"] for d in rows(env.db)) == ["mate", "o"]   # not the disabled one, nor other spaces
    drain(env.db)
    # Telegram as before: a build failure is off there by default
    assert not env.bot.sent("send_message")


def test_another_space_hears_only_of_its_own(env, monkeypatch):
    configured(env.db)
    people(env.db, monkeypatch)
    start(env.db)
    env.db.compute_jobs.docs["x2"] = {"_id": "x2", "kind": "build", "model": "box@uu", "workspace_id": "uu",
                                      "rc": 1, "at": core.iso()}
    run(notify.tick(env.db))
    assert [d["user"] for d in rows(env.db)] == ["u"]
    assert rows(env.db)[0]["workspace"] == "uu" and rows(env.db)[0]["link"] == "/3d/box@uu"


def test_the_servers_news_is_for_the_owner_and_admins_in_their_own_spaces(env, monkeypatch):
    configured(env.db)
    people(env.db, monkeypatch)
    start(env.db)
    monkeypatch.setattr(notify, "disk_now", lambda: {"pct": 97, "free_gb": 2.0, "path": "/x"})
    monkeypatch.setattr(notify, "_disk_at", 0.0)
    run(notify.tick(env.db))
    got = {d["user"]: d for d in rows(env.db)}
    assert set(got) == {"o", "ad"}
    assert got["ad"]["workspace"] == "uad" and got["o"]["workspace"] == scope.DEFAULT
    assert got["o"]["title"] == "Disk nearly full" and got["o"]["link"] == "/settings/dashboard"


def test_a_kind_switched_off_in_the_app_is_not_kept(env):
    configured(env.db)
    run(nc.put_settings(nc.SettingsIn(inapp={"route": False})))
    start(env.db)
    made_everything(env.db)
    run(notify.tick(env.db))
    assert "route" not in {d["kind"] for d in rows(env.db)}
    assert "firmware" in {d["kind"] for d in rows(env.db)}


def test_questions_and_notes_come_in_too(env):
    configured(env.db)
    start(env.db)
    env.db.questions.docs["q1"] = {"_id": "q1", "status": "open", "text": "Which screw?", "options": ["M3", "M4"],
                                   "at": core.iso(), "room": "cad"}
    env.db.revisions.docs["r1"] = {"_id": "r1", "status": "applied", "applied_at": core.iso(), "model": "iot/box",
                                   "comment": "rounder corners"}
    run(notify.tick(env.db))
    by = {d["kind"]: d for d in rows(env.db)}
    assert by["question"]["title"] == "Agent asks" and "Which screw?" in by["question"]["ctx"]
    assert by["question"]["link"] == "/chat/thread/cad"
    assert by["note"]["title"] == "Note applied" and by["note"]["link"] == "/3d/iot/box?rev=r1"


# ---------------------------------------------------------------- drawings

def test_a_drawing_asked_for_is_told_the_backgrounds_only_when_it_fails(env):
    configured(env.db)
    linked(env.db)
    start(env.db)
    sdb = scope.ScopedDb(env.db, scope.DEFAULT)
    run(release._drawn(sdb, "iot/box", "Box", True, secs=42))
    run(release._drawn(sdb, "iot/lid", "Lid", True, auto=True, secs=30))
    run(release._drawn(sdb, "iot/fan", "Fan", False, error="the projection crashed (exit 139)", auto=True))
    assert run(notify.tick(env.db)) == 2
    by = {d["title"]: d for d in rows(env.db)}
    assert set(by) == {"Drawing ready", "Drawing failed"}
    assert by["Drawing ready"]["link"] == "/3d/iot/box" and "Box" in by["Drawing ready"]["ctx"]
    assert "exit 139" in by["Drawing failed"]["ctx"] and by["Drawing failed"]["tone"] == "danger"
    drain(env.db)
    texts = [kw["text"] for kw in env.bot.sent("send_message")]
    assert any("Drawing ready" in x and "/3d/iot/box" in x for x in texts)
    assert any("Drawing failed" in x and "exit 139" in x for x in texts)
    assert run(notify.tick(env.db)) == 0


def test_making_a_drawing_records_how_it_went(env, monkeypatch, tmp_path):
    monkeypatch.setattr(release, "DRAWINGS", tmp_path)
    sdb = scope.ScopedDb(env.db, scope.DEFAULT)
    env.db.models.docs["iot/box"] = {"_id": "iot/box", "title": "Box", "artifacts": {"step": {"sha256": "ab" * 32}}}

    async def get_artifact(db, mid, kind):
        return b"STEP"
    from backend import store
    monkeypatch.setattr(store, "get_artifact", get_artifact)
    results = iter([None, "the projection failed"])

    async def drawing(step, out, **kw):
        why = next(results)
        if not why:
            out.write_bytes(b"%PDF")
        return why
    monkeypatch.setattr(release, "drawing", drawing)
    assert run(release.model_drawing(sdb, "iot/box")) == b"%PDF"
    with pytest.raises(RuntimeError):
        run(release.model_drawing(sdb, "iot/box", again=True, auto=True))
    got = sorted((d["state"], d["auto"]) for d in env.db[release.DRAWN].docs.values())
    assert got == [("done", False), ("failed", True)]
    assert all(d["workspace_id"] == scope.DEFAULT and d["title"] == "Box" for d in env.db[release.DRAWN].docs.values())


# ---------------------------------------------------------------- prices

def _p(pid, *amounts, cur="TRY", vat=None, **extra):
    hist = [{"at": f"2026-10-1{i}T10:00:00+00:00", "amount": a, "currency": cur, "vat": vat}
            for i, a in enumerate(amounts)]
    return {"id": pid, "name": pid.upper(), "price": {"amount": amounts[-1], "currency": cur}, "history": hist, **extra}


def test_the_price_drop_rule():
    d = notify.price_drop(_p("a", 100.0, 95.0))
    assert d == {"was": 100.0, "now": 95.0, "currency": "TRY", "pct": 5, "at": "2026-10-11T10:00:00+00:00"}
    assert notify.price_drop(_p("a", 100.0, 95.5)) is None                 # less than 5%
    assert notify.price_drop(_p("a", 100.0, 120.0)) is None                # up
    assert notify.price_drop(_p("a", 100.0)) is None                       # one reading
    p = _p("a", 100.0, 50.0)
    p["history"][-1]["currency"] = "USD"
    assert notify.price_drop(p) is None                                    # another currency
    p = _p("a", 100.0, 80.0)
    p["history"][-1]["vat"] = "incl"
    assert notify.price_drop(p) is None                                    # with VAT now, without before
    assert notify.price_drop(_p("a", 100.0, 80.0, price={"amount": 80.0, "source": "hand"})) is None
    assert notify.price_drop(_p("a", 100.0, 80.0, price={"amount": 80.0, "manual": True})) is None
    assert notify.price_drop(_p("a", 100.0, 40.0, price={"amount": 40.0, "doubt": [{"k": "jump"}]})) is None
    p = _p("a", 100.0, 80.0)
    p["history"].append({"at": "2026-10-19T10:00:00+00:00", "stock": "out"})
    assert notify.price_drop(p) is None                                    # the newest reading has no price


def test_a_makers_drops_come_as_one_notification(env):
    configured(env.db)
    linked(env.db)
    start(env.db)
    now = core.now()
    at = lambda s: (now + timedelta(seconds=s)).isoformat()                 # noqa: E731
    one = _p("m3", 10.0, 8.0)
    one["history"][-1]["at"] = at(1)
    env.db.manufacturers.docs["acme"] = {"_id": "acme", "name": "Acme", "updated_at": at(2), "products": [one]}
    two = [_p(f"p{i}", 100.0, 100.0 - 10 * (i + 1)) for i in range(3)]
    for p in two:
        p["history"][-1]["at"] = at(1)
    two.append(_p("same", 100.0, 99.0))
    env.db.manufacturers.docs["bolt"] = {"_id": "bolt", "name": "Bolt", "updated_at": at(2), "products": two}
    old = _p("old", 10.0, 5.0)                                             # read before the clock started
    env.db.manufacturers.docs["cog"] = {"_id": "cog", "name": "Cog", "updated_at": at(2), "products": [old]}
    assert run(notify.tick(env.db, now=now + timedelta(seconds=5))) == 2
    by = {d["title"]: d for d in rows(env.db)}
    assert by["Price dropped"]["link"] == "/parts/acme/m3"
    assert "M3" in by["Price dropped"]["ctx"] and "10.00 TRY → 8.00 TRY" in by["Price dropped"]["ctx"]
    assert by["Prices dropped"]["link"] == "/parts/bolt" and "3 products" in by["Prices dropped"]["ctx"]
    assert "P2 −30%" in by["Prices dropped"]["ctx"]
    drain(env.db)
    texts = [kw["text"] for kw in env.bot.sent("send_message")]
    assert any("Price dropped" in x and "/parts/acme/m3" in x for x in texts)
    assert any("3 prices dropped" in x and "Bolt" in x for x in texts)
    # read again, nothing new
    assert run(notify.tick(env.db, now=now + timedelta(seconds=9))) == 0


# ---------------------------------------------------------------- settings

def test_settings_default_and_the_telegram_side_is_the_links_own(env):
    configured(env.db)
    got = run(nc.get_settings())
    k = {x["id"]: x for x in got["kinds"]}
    assert k["question"]["inapp"] and not k["run"]["inapp"] and k["price"]["inapp"] and k["drawing"]["inapp"]
    assert k["question"]["telegram"] is None and got["telegram"] == {"bot": True, "linked": False, "blocked": False}
    assert got["toast"] is True
    with pytest.raises(HTTPException) as e:
        run(nc.put_settings(nc.SettingsIn(telegram={"price": False})))
    assert e.value.status_code == 400
    linked(env.db, user=nc.LOCAL)
    got = run(nc.put_settings(nc.SettingsIn(inapp={"run": True}, telegram={"price": False, "build": True}, toast=False)))
    k = {x["id"]: x for x in got["kinds"]}
    assert k["run"]["inapp"] and k["price"]["telegram"] is False and k["build"]["telegram"] is True
    assert got["toast"] is False
    assert env.db[core.LINKS].docs[nc.LOCAL]["prefs"]["price"] is False      # one place for Telegram's
    assert not any("telegram" in d for d in env.db[nc.PREFS].docs.values())
    with pytest.raises(HTTPException):
        run(nc.put_settings(nc.SettingsIn(inapp={"nonsense": True})))


def test_the_servers_kinds_are_listed_only_for_those_who_may_change_it(env, monkeypatch):
    people(env.db, monkeypatch)
    as_user("u", "uu")
    access.ROLE.set("user")
    assert "health" not in {x["id"] for x in run(nc.get_settings())["kinds"]}
    access.ROLE.set("admin")
    assert "health" in {x["id"] for x in run(nc.get_settings())["kinds"]}
    access.ROLE.set("owner")


def test_every_kind_is_a_telegram_preference_too():
    assert set(nc.KIND_IDS) <= set(links.PREFS)
    assert set(links.PREFS) - set(nc.KIND_IDS) == {"digest"}               # the digest is Telegram's alone
    from backend.tgbot import api
    assert {p["id"] for p in api.PREF_INFO} == set(links.PREFS)


# ---------------------------------------------------------------- the routes

def _seed(db, user, ws=scope.DEFAULT, n=3, kind="build"):
    for i in range(n):
        run(nc.deliver(db, ws, kind, f"ev-{user}-{kind}-{i}", {"title": f"t{i}", "ctx": "ctx", "link": "/pcb/x"}))


def test_list_count_read_and_remove_my_own(env, monkeypatch):
    people(env.db, monkeypatch)
    _seed(env.db, "o", n=3)
    _seed(env.db, "o", n=2, kind="route")
    run(nc.deliver(env.db, "uu", "build", "ev-u", {"title": "theirs"}))
    as_user("o")
    got = run(nc.listing(counts=True))
    # the second account working in the default space has the same rows of its own; not the other space's
    assert len(got["items"]) == 5 and got["unread"] == 5 and got["counts"] == {"build": 3, "route": 2}
    assert all(x["title"] != "theirs" for x in got["items"])
    assert len(run(nc.listing(kind="route"))["items"]) == 2
    page = run(nc.listing(limit=2))
    assert len(page["items"]) == 2 and page["more"]
    c = run(nc.count())
    assert c["unread"] == 5 and c["latest"]["title"]
    one = got["items"][0]["id"]
    assert run(nc.mark_read(nc.Pick(ids=[one])))["unread"] == 4
    assert len(run(nc.listing(unread=True))["items"]) == 4
    assert run(nc.remove(nc.Pick(all=True, read=True)))["removed"] == 1
    assert run(nc.mark_read(nc.Pick(all=True)))["unread"] == 0
    assert run(nc.remove(nc.Pick(all=True)))["removed"] == 4
    # the other people's rows are untouched
    assert {d["user"] for d in rows(env.db)} == {"mate", "u"}
    with pytest.raises(HTTPException):
        run(nc.mark_read(nc.Pick()))


def test_someone_elses_ids_change_nothing(env, monkeypatch):
    people(env.db, monkeypatch)
    _seed(env.db, "u", ws="uu", n=1)
    theirs = rows(env.db, "u")[0]["_id"]
    as_user("o")
    assert run(nc.mark_read(nc.Pick(ids=[theirs])))["marked"] == 0
    assert run(nc.remove(nc.Pick(ids=[theirs])))["removed"] == 0
    assert rows(env.db, "u")[0]["read_at"] is None


def test_an_agent_has_no_bell_and_a_page_session_only_looks(env, monkeypatch):
    people(env.db, monkeypatch)
    _seed(env.db, "o", n=1)
    actors.CURRENT.set(actors.agent("bot"))
    assert run(nc.listing())["items"] == [] and run(nc.count())["unread"] == 0
    with pytest.raises(HTTPException) as e:
        run(nc.mark_read(nc.Pick(all=True)))
    assert e.value.status_code == 400
    as_user("o", page=True)
    assert len(run(nc.listing())["items"]) == 1
    with pytest.raises(HTTPException) as e:
        run(nc.remove(nc.Pick(all=True)))
    assert e.value.status_code == 403


def test_the_routes_rights():
    for method, path in (("GET", "/api/notifications"), ("GET", "/api/notifications/count"),
                         ("POST", "/api/notifications/read"), ("POST", "/api/notifications/remove"),
                         ("GET", "/api/notifications/settings"), ("PUT", "/api/notifications/settings")):
        assert access.action(method, path, {}) == "view"
        for role in ("owner", "admin", "user", "viewer"):
            assert access.allowed(role, access.action(method, path, {}))
    assert access.page_allowed("GET", "/api/notifications", {})
    assert not access.page_allowed("POST", "/api/notifications/read", {})
    assert not access.page_allowed("PUT", "/api/notifications/settings", {})


def test_rows_go_with_their_account(env, monkeypatch):
    from backend import admin
    people(env.db, monkeypatch)
    _seed(env.db, "u", ws="uu", n=2)
    env.db[nc.PREFS].docs["u"] = {"_id": "u", "toast": False}
    monkeypatch.setattr(admin, "_raw", lambda: env.db)

    async def nothing(*a, **kw):
        return None
    monkeypatch.setattr(admin, "_audit", nothing)
    monkeypatch.setattr(auth, "end_sessions_of", nothing)
    as_user("o")
    access.ROLE.set("owner")
    try:
        run(admin.delete_user("u", with_data=True))
    except HTTPException:
        pytest.skip("deleting an account here needs more of the app than this test brings")
    assert not rows(env.db, "u") and "u" not in env.db[nc.PREFS].docs


def test_links_into_the_app():
    from backend import app_links as L
    assert L.notifications() == "/notifications" and L.room("notifications") == "/notifications"
    assert L.settings("costs") == "/settings/costs" and L.settings() == "/settings"
    assert L.product("lcsc", "C123") == "/parts/lcsc/C123" and L.product("a b", "x/y") == "/parts/a%20b/x%2Fy"
