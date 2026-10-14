"""Shared links (backend/shares.py): one model, board or drawing, read-only,
for a while, to someone without an account.

Sign-in is on; the database is test_telegram's fake, the stored files and
the drawings are stand-ins. What is checked: a visitor reaches the shared
thing and nothing else, an ended link is 410, a wrong one 404, a password is
checked by the server, only the token's hash is kept, who may make and turn
off a link, that the owner is never named to a visitor, and the rate limits."""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from backend import actors, auth, release, scope, shares, store
from test_telegram import FakeDb

PW = "a long password 1"
OWNER_NAME, OWNER_MAIL = "Owner Person", "owner@example.com"


def run(c):
    return asyncio.run(c)


def gz(b: bytes) -> bytes:
    return gzip.compress(b)


def png(text: bytes = b"") -> bytes:
    """A tiny PNG, with a text chunk when given one (the cleaning drops it)."""
    import struct
    import zlib

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 0, 0, 0, 0))
    if text:
        out += chunk(b"tEXt", b"Author\x00" + text)
    return out + chunk(b"IDAT", zlib.compress(b"\x00\x00")) + chunk(b"IEND", b"")


STEP = (b"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('x'),'2;1');\n"
        b"FILE_NAME('case','2026-10-14T10:00:00',('" + OWNER_NAME.encode() + b"'),('Acme, ''Inc'''),"
        b"'proc','orig','auth');\nFILE_SCHEMA(('AP214'));\nENDSEC;\nDATA;\n#1=PRODUCT('case','case','',(#2));\nENDSEC;\n")


def model_doc(mid: str, viewer: bytes, **extra) -> dict:
    return {"_id": mid, "name": mid.split("/")[-1], "title": "Case base", "version": 3,
            "built": {"version": 3, "at": "2026-10-14T10:00:00+00:00"},
            "artifacts": {"viewer": {"blob": gz(viewer), "sha256": hashlib.sha256(viewer).hexdigest(),
                                     "at": "2026-10-14T10:00:00+00:00"},
                          "step": {"blob": gz(STEP), "sha256": "s"}},
            **extra}


@pytest.fixture
def db(monkeypatch):
    from backend import main
    fake = FakeDb()
    monkeypatch.setattr(main, "db", lambda: scope.ScopedDb(fake, scope.current()))
    monkeypatch.setattr(auth, "enabled", lambda: True)
    for c in (auth._CACHE, auth._TOKEN_CACHE, auth._USAGE):
        c.clear()
    for w in (shares.HITS, shares.MISSES, shares.WRONG, shares.WRONG_LINK):
        w.clear()
    shares._looked.clear()

    # Stored files: kept on the catalog documents themselves, so the space
    # a lookup is made in decides what it finds, as in the real store.
    async def get_gz(d, target, label, coll="models"):
        doc = await d[coll].find_one({"_id": target})
        meta = ((doc or {}).get("artifacts") or {}).get(label)
        if not meta:
            raise KeyError(f"{target}/{label}")
        return meta["blob"]
    monkeypatch.setattr(store, "get_artifact_gz", get_gz)
    kept: dict = {}

    async def put(d, name, packed):
        kept[name] = packed
        return name

    async def get(d, fid):
        return kept[fid]

    async def drop(d, fid):
        kept.pop(fid, None)
    monkeypatch.setattr(shares, "_put", put)
    monkeypatch.setattr(shares, "_get", get)
    monkeypatch.setattr(shares, "_drop", drop)

    # The drawing: "made" when the model says so; never made here.
    async def status(d, mid):
        doc = await d.models.find_one({"_id": mid})
        if not doc:
            raise KeyError(mid)
        return {"made": {"at": "x"}} if doc.get("drawn") else {"state": "none"}

    async def pdf(d, mid, tag="", again=False):
        doc = await d.models.find_one({"_id": mid})
        if not doc.get("drawn"):
            raise AssertionError("a link must never make a drawing")
        return b"%PDF-1.4 drawing of " + doc["drawn"].encode()

    async def sheet(d, mid):
        return png(OWNER_NAME.encode())
    monkeypatch.setattr(release, "drawing_status", status)
    monkeypatch.setattr(release, "model_drawing", pdf)
    monkeypatch.setattr(release, "model_drawing_sheet", sheet)

    now = datetime.now(timezone.utc)
    for uid, role, extra in (("u-own", "owner", {}), ("u-other", "user", {}),
                             ("u-adm", "admin", {"space": "default"}), ("u-mate", "user", {"space": "default"})):
        run(fake["users"].insert_one({"_id": uid, "email": OWNER_MAIL if uid == "u-own" else f"{uid}@example.com",
                                      "name": OWNER_NAME if uid == "u-own" else uid, "role": role,
                                      "pw": "x", "created_at": now, **extra}))
    tokens = (actors.CURRENT.set(actors.local_user()), scope.WORKSPACE.set(scope.DEFAULT))
    sd = scope.ScopedDb(fake, scope.DEFAULT)
    run(sd.models.insert_one(model_doc("iot/case", b'{"data": "case v3"}', drawn="v3")))
    run(sd.models.insert_one(model_doc("iot/secret", b'{"data": "secret"}')))
    run(sd.boards.insert_one({"_id": "ctl", "title": "Controller", "component": {"version": 7},
                              "artifacts": {"layout": {"blob": gz(b"<svg><!-- by Owner Person --><g/></svg>")},
                                            "model3d": {"blob": gz(b"glTF")},
                                            "step": {"blob": gz(STEP)}}}))
    # Another person's space has a model of the same name.
    run(scope.ScopedDb(fake, "uu-other").models.insert_one(model_doc("iot/case", b'{"data": "theirs"}')))
    yield fake
    actors.CURRENT.reset(tokens[0])
    scope.WORKSPACE.reset(tokens[1])
    for c in (auth._CACHE, auth._TOKEN_CACHE, auth._USAGE):
        c.clear()


def app():
    return __import__("backend.main", fromlist=["app"]).app


def person(fake, uid: str) -> TestClient:
    c = TestClient(app())
    c.cookies.set(auth.COOKIE, run(auth.create_session(fake, {"_id": uid}, "default", "Mozilla/5.0")))
    c.headers[auth.CSRF_HEADER] = "1"
    return c


def visitor(ip: str = "203.0.113.9") -> TestClient:
    c = TestClient(app())
    c.headers["X-Forwarded-For"] = ip
    return c


def share(c: TestClient, **kw) -> dict:
    r = c.post("/api/shares", json={"kind": "model", "target": "iot/case", **kw})
    assert r.status_code == 200, r.text
    return r.json()


def token_of(made: dict) -> str:
    return made["path"].rsplit("/", 1)[1]


# ---------------------------------------------------------------- a visitor

def test_a_visitor_sees_the_shared_model_and_nobody_behind_it(db):
    made = share(person(db, "u-own"), downloads=True)
    t = token_of(made)
    v = visitor()
    r = v.get(f"/api/public/s/{t}")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    meta = r.json()
    assert meta["kind"] == "model" and meta["title"] == "Case base" and not meta["locked"]
    assert meta["views"] == ["model.json"] and set(meta["downloads"]) == {"step", "pdf"}
    assert meta["version"]["pinned"] and meta["version"]["label"] == "v3"
    # No person, no space, no id of anything.
    for word in (OWNER_NAME, OWNER_MAIL, "u-own", "iot/case", "default", made["share"]["id"]):
        assert word not in r.text
    got = v.get(f"/api/public/s/{t}/view/model.json")
    assert got.status_code == 200 and got.json() == {"data": "case v3"}
    assert "sandbox" in got.headers["content-security-policy"]
    step = v.get(f"/api/public/s/{t}/download/step")
    assert step.status_code == 200 and b"FILE_NAME('case'" in step.content
    assert OWNER_NAME.encode() not in step.content and b"Acme" not in step.content
    assert "attachment" in step.headers["content-disposition"]
    assert v.get(f"/api/public/s/{t}/download/pdf").content.startswith(b"%PDF")
    # The app itself still wants a sign-in.
    assert v.get("/api/models/iot/case/viewer.json").status_code == 401
    assert v.get("/api/shares").status_code == 401


def test_nothing_else_is_reachable_through_a_link(db):
    t = token_of(share(person(db, "u-own")))
    v = visitor()
    for path in ("view/step", "view/layout.svg", "view/..%2F..%2Fmodels%2Fiot%2Fsecret%2Fviewer.json",
                 "view/model.json/../../secret", "download/step", "download/pdf", "files", "chat", "notes",
                 "../iot/secret", "view/", "download/viewer"):
        r = v.get(f"/api/public/s/{t}/{path}")
        assert r.status_code in (404, 405), (path, r.status_code)
        assert b"secret" not in r.content
    # Another model's id where the token goes is just a wrong token.
    assert v.get("/api/public/s/iot%2Fsecret/view/model.json").status_code == 404
    assert v.get("/api/public/s/iot/secret").status_code == 404


def test_a_wrong_token_is_404_and_looks_like_any_other(db):
    share(person(db, "u-own"))
    v = visitor()
    a = v.get("/api/public/s/" + "A" * 43)
    b = v.get("/api/public/s/short")
    assert a.status_code == b.status_code == 404
    assert a.json() == b.json()


def test_expired_and_turned_off_links_are_410(db):
    own = person(db, "u-own")
    t1, t2 = token_of(share(own)), token_of(share(own))
    run(db["shares"].update_one({"_id": shares.digest(t1)},
                                {"$set": {"expires_at": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()}}))
    v = visitor()
    assert v.get(f"/api/public/s/{t1}").status_code == 410
    assert v.get(f"/api/public/s/{t1}/view/model.json").status_code == 410
    sid = run(db["shares"].find_one({"_id": shares.digest(t2)}))["id"]
    assert own.post(f"/api/shares/{sid}/revoke").json()["state"] == "revoked"
    assert v.get(f"/api/public/s/{t2}").status_code == 410
    assert v.get(f"/api/public/s/{t2}/view/model.json").status_code == 410


def test_only_the_hash_of_the_token_is_kept(db):
    made = share(person(db, "u-own"), password="hunter22")
    t = token_of(made)
    doc = run(db["shares"].find_one({"id": made["share"]["id"]}))
    assert doc["_id"] == hashlib.sha256(t.encode()).hexdigest()
    stored = json.dumps(list(db["shares"].docs.values()), default=str)
    assert t not in stored and "hunter22" not in stored
    assert doc["password"].startswith("scrypt$")
    # The app's own list never shows the token either.
    listed = person(db, "u-own").get("/api/shares?kind=model&target=iot/case").text
    assert t not in listed and doc["_id"] not in listed and "scrypt" not in listed


def test_a_password_is_checked_by_the_server(db):
    own = person(db, "u-own")
    t = token_of(share(own, password="hunter22"))
    t_other = token_of(share(own, password="hunter22"))
    v = visitor()
    meta = v.get(f"/api/public/s/{t}").json()
    assert meta == {"kind": "model", "locked": True, "expires_at": meta["expires_at"]}
    assert v.get(f"/api/public/s/{t}/view/model.json").status_code == 401
    assert v.post(f"/api/public/s/{t}/unlock", json={"password": "wrong one"}).status_code == 403
    ok = v.post(f"/api/public/s/{t}/unlock", json={"password": "hunter22"})
    assert ok.status_code == 200 and ok.json()["title"] == "Case base"
    assert v.get(f"/api/public/s/{t}/view/model.json").status_code == 200
    # The cookie is that link's alone.
    other = visitor("203.0.113.10")
    other.cookies.set(shares.COOKIE, v.cookies.get(shares.COOKIE))
    assert other.get(f"/api/public/s/{t_other}/view/model.json").status_code == 401
    other.cookies.set(shares.COOKIE, "0" * 64)
    assert other.get(f"/api/public/s/{t}/view/model.json").status_code == 401


def test_wrong_passwords_are_limited(db, monkeypatch):
    t = token_of(share(person(db, "u-own"), password="hunter22"))
    monkeypatch.setattr(shares, "WRONG", shares.Window(3, 900))
    v = visitor()
    codes = [v.post(f"/api/public/s/{t}/unlock", json={"password": f"no {i}"}).status_code for i in range(5)]
    assert codes == [403, 403, 403, 429, 429]
    # Even the right one waits now, from that address.
    assert v.post(f"/api/public/s/{t}/unlock", json={"password": "hunter22"}).status_code == 429
    # Across addresses, the link has a limit of its own.
    monkeypatch.setattr(shares, "WRONG_LINK", shares.Window(4, 3600))
    for i in range(4):
        visitor(f"198.51.100.{i}").post(f"/api/public/s/{t}/unlock", json={"password": "no"})
    assert visitor("198.51.100.99").post(f"/api/public/s/{t}/unlock",
                                         json={"password": "hunter22"}).status_code == 429


def test_wrong_tokens_and_floods_are_limited(db, monkeypatch):
    t = token_of(share(person(db, "u-own")))
    monkeypatch.setattr(shares, "MISSES", shares.Window(3, 600))
    v = visitor()
    codes = [v.get("/api/public/s/" + chr(65 + i) * 43).status_code for i in range(5)]
    assert codes == [404, 404, 404, 429, 429]
    assert v.get(f"/api/public/s/{t}").status_code == 429           # that address waits
    assert visitor("192.0.2.1").get(f"/api/public/s/{t}").status_code == 200
    monkeypatch.setattr(shares, "HITS", shares.Window(5, 60))
    w = visitor("192.0.2.2")
    assert [w.get(f"/api/public/s/{t}").status_code for _ in range(6)][-1] == 429


# ---------------------------------------------------------------- who may

def test_making_a_link_needs_the_thing_in_ones_own_space(db):
    other = person(db, "u-other")
    # Their own model of that name is theirs to share; the owner's secret is not there for them.
    assert other.post("/api/shares", json={"kind": "model", "target": "iot/secret"}).status_code == 404
    made = share(other)
    got = visitor().get(f"/api/public/s/{token_of(made)}/view/model.json").json()
    assert got == {"data": "theirs"}
    # Signed out, nothing is made.
    assert visitor().post("/api/shares", json={"kind": "model", "target": "iot/case"},
                          headers={auth.CSRF_HEADER: "1"}).status_code == 401


def test_an_agent_token_does_not_make_links(db):
    raw, _ = run(auth.create_agent_token(db, "bot", "default", None,
                                         {"type": "user", "id": "u-own", "name": "O"}, "viewer"))
    c = TestClient(app())
    c.headers["Authorization"] = "Bearer " + raw
    r = c.post("/api/shares", json={"kind": "model", "target": "iot/case"})
    assert r.status_code == 403
    # A page session (the headless browser) may only look.
    agent = run(auth.token_agent(db, raw))
    value, _ = run(auth.create_page_session(db, agent["workspace"], agent["actor"], token_id=agent["actor"]["token"]))
    p = TestClient(app())
    p.cookies.set(auth.COOKIE, value)
    p.headers[auth.CSRF_HEADER] = "1"
    assert p.post("/api/shares", json={"kind": "model", "target": "iot/case"}).status_code == 403
    assert p.get("/api/shares").status_code == 200


def test_turning_off_is_the_makers_or_an_admins(db):
    own = person(db, "u-own")
    sid = share(own)["share"]["id"]
    sid2 = share(own)["share"]["id"]
    mate, adm, other = person(db, "u-mate"), person(db, "u-adm"), person(db, "u-other")
    assert other.post(f"/api/shares/{sid}/revoke").status_code == 404          # not in their space
    assert mate.post(f"/api/shares/{sid}/revoke").status_code == 403           # not theirs, not an admin
    assert adm.post(f"/api/shares/{sid}/revoke").json()["state"] == "revoked"
    assert own.post(f"/api/shares/{sid2}/revoke").json()["state"] == "revoked"
    trail = [a for a in db["audit"].docs.values() if a["action"].startswith("share")]
    assert {a["action"] for a in trail} >= {"share", "share-revoke"}


def test_lists_per_thing_and_ones_own(db):
    own, mate = person(db, "u-own"), person(db, "u-mate")
    share(own)
    share(mate, kind="board", target="ctl")
    assert [r["kind"] for r in own.get("/api/shares?kind=model&target=iot/case").json()] == ["model"]
    assert [r["kind"] for r in own.get("/api/shares?mine=1").json()] == ["model"]
    assert len(own.get("/api/shares").json()) == 2
    assert person(db, "u-other").get("/api/shares").json() == []


# ---------------------------------------------------------------- what a link shows

def test_this_version_stays_and_the_latest_follows(db):
    own = person(db, "u-own")
    pinned, latest = token_of(share(own)), token_of(share(own, version="latest"))
    sd = scope.ScopedDb(db, scope.DEFAULT)
    run(sd.models.update_one({"_id": "iot/case"}, {"$set": {"artifacts.viewer.blob": gz(b'{"data": "case v4"}')}}))
    v = visitor()
    assert v.get(f"/api/public/s/{pinned}/view/model.json").json() == {"data": "case v3"}
    assert v.get(f"/api/public/s/{latest}/view/model.json").json() == {"data": "case v4"}
    assert v.get(f"/api/public/s/{latest}").json()["version"]["pinned"] is False
    # Turned off, what it kept is dropped.
    sid = run(db["shares"].find_one({"_id": shares.digest(pinned)}))["id"]
    own.post(f"/api/shares/{sid}/revoke")
    assert run(db["shares"].find_one({"id": sid}))["files"] is None


def test_a_board_and_a_drawing(db):
    own = person(db, "u-own")
    b = token_of(share(own, kind="board", target="ctl", downloads=True))
    v = visitor()
    meta = v.get(f"/api/public/s/{b}").json()
    assert meta["title"] == "Controller" and meta["views"] == ["layout.svg", "board.glb"]
    assert meta["downloads"] == ["step"] and meta["version"]["label"] == "v7"
    svg = v.get(f"/api/public/s/{b}/view/layout.svg")
    assert svg.headers["content-type"].startswith("image/svg+xml") and b"Owner" not in svg.content
    d = token_of(share(own, kind="drawing"))
    meta = v.get(f"/api/public/s/{d}").json()
    assert meta["views"] == ["sheet.png"] and meta["downloads"] == []
    sheet = v.get(f"/api/public/s/{d}/view/sheet.png").content
    assert sheet.startswith(b"\x89PNG") and OWNER_NAME.encode() not in sheet and b"tEXt" not in sheet
    assert v.get(f"/api/public/s/{d}/download/pdf").status_code == 404           # view only
    # No drawing made, no drawing link.
    r = own.post("/api/shares", json={"kind": "drawing", "target": "iot/secret"})
    assert r.status_code == 409


def test_how_long_a_link_lasts(db):
    own = person(db, "u-own")
    now = datetime.now(timezone.utc)
    week = datetime.fromisoformat(share(own)["share"]["expires_at"])
    assert timedelta(days=6, hours=23) < week - now <= timedelta(days=7, seconds=30)
    ok = share(own, expires="custom", until=(now + timedelta(days=89)).isoformat())
    assert ok["share"]["expires_at"]
    for until in ((now + timedelta(days=91)).isoformat(), (now - timedelta(days=1)).isoformat(), "soon"):
        r = own.post("/api/shares", json={"kind": "model", "target": "iot/case", "expires": "custom", "until": until})
        assert r.status_code == 400, until


def test_views_are_counted_once_per_visitor_and_audited(db):
    t = token_of(share(person(db, "u-own")))
    for _ in range(3):
        visitor().get(f"/api/public/s/{t}")
    visitor("192.0.2.77").get(f"/api/public/s/{t}")
    doc = run(db["shares"].find_one({"_id": shares.digest(t)}))
    assert doc["views"] == 2 and doc["last_viewed_at"]
    seen = [a for a in db["audit"].docs.values() if a["action"] == "share-view"]
    assert len(seen) == 2 and all(a["actor"]["type"] == "visitor" for a in seen)


def test_cleaning_keeps_the_file_and_drops_the_people():
    out = shares.clean_step(STEP)
    assert b"FILE_NAME('case','2026-10-14T10:00:00',(''),(''),'proc','orig','auth');" in out
    assert out.endswith(STEP[STEP.index(b"FILE_SCHEMA"):])
    assert shares.clean_step(b"no header at all") == b"no header at all"
    assert b"tEXt" not in shares.clean_png(png(b"someone")) and shares.clean_png(png()).startswith(b"\x89PNG")
    assert shares.clean_svg(b"<svg><metadata>x</metadata><!-- y --><g/></svg>") == b"<svg><g/></svg>"
