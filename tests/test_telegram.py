"""Telegram (backend/tgbot/), with the Bot API and the database both faked.

The fake database is a dict of collections that understands the filters and
updates the package (and backend/scope.py's workspace wrapper) uses; the
fake bot records every call python-telegram-bot's Bot would have made. No
network, no Mongo: what is tested is what the package decides - the token
kept and never shown, the webhook's secret, a link code used once inside ten
minutes, the role behind every action, a question going out as buttons and
coming back as an answer, a message turning into a draft note, and the send
queue's retries.
"""

from __future__ import annotations

import asyncio
import copy
import io
import json
import logging
import re
from datetime import timedelta

import pytest
from pymongo.errors import DuplicateKeyError

from backend import actors, auth, scope
from backend.tgbot import api, core, fmt, inbound, links, notify, outbox

TOKEN = "123456789:AAH" + "x" * 32


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------- a database

def _get(doc, path):
    cur = doc
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return _MISSING
        cur = cur[part]
    return cur


_MISSING = object()


def _cmp(a, b, op):
    try:
        return {"$gt": a > b, "$gte": a >= b, "$lt": a < b, "$lte": a <= b}[op]
    except TypeError:
        return False


def _match_value(v, cond) -> bool:
    if isinstance(cond, dict) and cond and all(k.startswith("$") for k in cond):
        for op, arg in cond.items():
            val = None if v is _MISSING else v
            if op == "$ne" and val == arg:
                return False
            if op == "$in" and val not in arg:
                return False
            if op == "$nin" and val in arg:
                return False
            if op in ("$gt", "$gte", "$lt", "$lte") and (v is _MISSING or not _cmp(v, arg, op)):
                return False
            if op == "$exists" and (v is not _MISSING) != bool(arg):
                return False
            if op == "$regex" and (not isinstance(val, str) or not re.search(arg, val)):
                return False
        return True
    return (None if v is _MISSING else v) == cond


def match(doc, q) -> bool:
    for k, cond in (q or {}).items():
        if k == "$and":
            if not all(match(doc, x) for x in cond):
                return False
        elif k == "$or":
            if not any(match(doc, x) for x in cond):
                return False
        elif not _match_value(_get(doc, k), cond):
            return False
    return True


def _set(doc, path, value):
    parts = path.split(".")
    for p in parts[:-1]:
        doc = doc.setdefault(p, {})
    doc[parts[-1]] = value


def _unset(doc, path):
    parts = path.split(".")
    for p in parts[:-1]:
        doc = doc.get(p, {})
    doc.pop(parts[-1], None)


def apply(doc, update, inserting=False):
    for op, fields in update.items():
        for k, v in fields.items():
            if op == "$set" or (op == "$setOnInsert" and inserting):
                _set(doc, k, copy.deepcopy(v))
            elif op == "$unset":
                _unset(doc, k)
            elif op == "$inc":
                _set(doc, k, (_get(doc, k) if _get(doc, k) is not _MISSING else 0) + v)


class Res:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, key, direction=1):
        if isinstance(key, list):
            key, direction = key[0]
        self.rows.sort(key=lambda d: (_get(d, key) is _MISSING, str(_get(d, key))), reverse=direction == -1)
        return self

    def limit(self, n):
        self.rows = self.rows[:n] if n else self.rows
        return self

    def __aiter__(self):
        async def gen():
            for r in self.rows:
                yield r
        return gen()

    async def to_list(self, n=None):
        return self.rows[:n] if n else self.rows


class Coll:
    def __init__(self):
        self.docs: dict = {}
        self._n = 0

    def _all(self, q):
        return [d for d in self.docs.values() if match(d, q)]

    async def create_index(self, *a, **kw):
        return "ix"

    async def insert_one(self, doc):
        if "_id" not in doc:
            self._n += 1
            doc["_id"] = f"oid{self._n}"
        if doc["_id"] in self.docs:
            raise DuplicateKeyError("dup")
        self.docs[doc["_id"]] = copy.deepcopy(doc)
        return Res(inserted_id=doc["_id"])

    def find(self, q=None, projection=None, *a, **kw):
        return Cursor([copy.deepcopy(d) for d in self._all(q)])

    async def find_one(self, q=None, projection=None, *a, **kw):
        rows = self._all(q)
        return copy.deepcopy(rows[0]) if rows else None

    async def count_documents(self, q=None, **kw):
        return len(self._all(q))

    def _upsert_doc(self, q):
        doc = {k: v for k, v in (q or {}).items() if not k.startswith("$") and not isinstance(v, dict)}
        for part in (q or {}).get("$and", []):
            doc.update({k: v for k, v in part.items() if not k.startswith("$") and not isinstance(v, dict)})
        return doc

    async def update_one(self, q, update, upsert=False, **kw):
        rows = self._all(q)
        if rows:
            apply(self.docs[rows[0]["_id"]], update)
            return Res(matched_count=1, modified_count=1, upserted_id=None)
        if upsert:
            doc = self._upsert_doc(q)
            apply(doc, update, inserting=True)
            await self.insert_one(doc)
            return Res(matched_count=0, modified_count=0, upserted_id=doc["_id"])
        return Res(matched_count=0, modified_count=0, upserted_id=None)

    async def update_many(self, q, update, upsert=False, **kw):
        rows = self._all(q)
        for r in rows:
            apply(self.docs[r["_id"]], update)
        return Res(matched_count=len(rows), modified_count=len(rows))

    async def replace_one(self, q, doc, upsert=False, **kw):
        rows = self._all(q)
        if rows:
            del self.docs[rows[0]["_id"]]
            doc = {**doc, "_id": rows[0]["_id"]}
        elif not upsert:
            return Res(matched_count=0)
        self.docs[doc["_id"]] = copy.deepcopy(doc)
        return Res(matched_count=len(rows))

    async def find_one_and_update(self, q, update, sort=None, return_document=False, upsert=False, **kw):
        rows = self._all(q)
        if sort:
            rows = Cursor(rows).sort(sort).rows
        if not rows:
            return None
        before = copy.deepcopy(rows[0])
        apply(self.docs[rows[0]["_id"]], update)
        return copy.deepcopy(self.docs[rows[0]["_id"]]) if return_document else before

    async def find_one_and_delete(self, q, **kw):
        rows = self._all(q)
        if not rows:
            return None
        return self.docs.pop(rows[0]["_id"])

    async def delete_one(self, q, **kw):
        rows = self._all(q)
        if rows:
            del self.docs[rows[0]["_id"]]
        return Res(deleted_count=len(rows[:1]))

    async def delete_many(self, q, **kw):
        rows = self._all(q)
        for r in rows:
            del self.docs[r["_id"]]
        return Res(deleted_count=len(rows))


class FakeDb:
    def __init__(self):
        self.colls: dict[str, Coll] = {}

    def __getitem__(self, name):
        return self.colls.setdefault(name, Coll())

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]


# ---------------------------------------------------------------- a bot

class Msg:
    def __init__(self, mid, photo=False):
        self.message_id = mid
        self.photo = ["p"] if photo else None


class FakeFile:
    def __init__(self, data):
        self.data = data

    async def download_as_bytearray(self):
        return bytearray(self.data)


class FakeBot:
    """Records what would have gone to the Bot API. `fail` is a list of
    exceptions the next sends raise, one each."""

    def __init__(self, token=TOKEN):
        self.token = token
        self.calls: list[tuple[str, dict]] = []
        self.fail: list[Exception] = []
        self.n = 100
        self.file_bytes = _jpeg()

    def _rec(self, name, kw):
        self.calls.append((name, kw))
        if name.startswith(("send_", "edit_")) and self.fail:
            raise self.fail.pop(0)

    def sent(self, name=None):
        return [kw for n, kw in self.calls if name is None or n == name]

    async def get_me(self):
        self._rec("get_me", {})
        if self.token != TOKEN:
            from telegram.error import InvalidToken
            raise InvalidToken("refused")
        return {"id": 123456789, "is_bot": True, "username": "redline_test_bot", "first_name": "Redline"}

    async def send_message(self, **kw):
        self._rec("send_message", kw)
        self.n += 1
        return Msg(self.n)

    async def send_photo(self, **kw):
        self._rec("send_photo", kw)
        self.n += 1
        return Msg(self.n, photo=True)

    async def edit_message_text(self, **kw):
        self._rec("edit_message_text", kw)
        return True

    async def edit_message_caption(self, **kw):
        self._rec("edit_message_caption", kw)
        return True

    async def edit_message_reply_markup(self, **kw):
        self._rec("edit_message_reply_markup", kw)
        return True

    async def answer_callback_query(self, cid, text=None):
        self._rec("answer_callback_query", {"id": cid, "text": text})

    async def get_file(self, file_id):
        self._rec("get_file", {"file_id": file_id})
        return FakeFile(self.file_bytes)

    async def get_user_profile_photos(self, uid, limit=1):
        return Res(photos=[])

    async def set_my_commands(self, cmds, language_code=None):
        self._rec("set_my_commands", {"n": len(cmds), "lang": language_code})

    # the profile, per language
    def _p(self, lang):
        return self.__dict__.setdefault("prof", {}).setdefault(lang or "", {})

    async def get_my_name(self, language_code=None):
        return {"name": self._p(language_code).get("name", "")}

    async def get_my_description(self, language_code=None):
        return {"description": self._p(language_code).get("description", "")}

    async def get_my_short_description(self, language_code=None):
        return {"short_description": self._p(language_code).get("short_description", "")}

    async def get_my_commands(self, language_code=None):
        return [{"command": "note", "description": "a note"}]

    async def set_my_name(self, v, language_code=None):
        self._rec("set_my_name", {"v": v, "lang": language_code})
        self._p(language_code)["name"] = v

    async def set_my_description(self, v, language_code=None):
        self._rec("set_my_description", {"v": v, "lang": language_code})
        if v and "bad" in v:
            from telegram.error import BadRequest
            raise BadRequest("description is invalid")
        self._p(language_code)["description"] = v

    async def set_my_short_description(self, v, language_code=None):
        self._rec("set_my_short_description", {"v": v, "lang": language_code})
        self._p(language_code)["short_description"] = v

    async def set_my_profile_photo(self, photo):
        self._rec("set_my_profile_photo", {"photo": photo})

    async def remove_my_profile_photo(self):
        self._rec("remove_my_profile_photo", {})

    async def get_webhook_info(self):
        return {"url": "", "pending_update_count": 0}

    async def set_webhook(self, **kw):
        self._rec("set_webhook", kw)

    async def delete_webhook(self, **kw):
        self._rec("delete_webhook", kw)

    async def shutdown(self):
        pass


def _jpeg() -> bytes:
    from PIL import Image
    out = io.BytesIO()
    Image.new("RGB", (64, 48), (200, 30, 30)).save(out, "JPEG")
    return out.getvalue()


# ---------------------------------------------------------------- set-up

@pytest.fixture
def env(monkeypatch):
    db = FakeDb()
    bot = FakeBot()
    core.bind(lambda: db)
    core._bot, core._bot_key = None, None
    monkeypatch.setattr(core, "make_bot", lambda token: bot if token == TOKEN else FakeBot(token))
    monkeypatch.setattr(outbox, "GLOBAL_GAP", 0)
    monkeypatch.setattr(outbox, "CHAT_GAP", 0)
    monkeypatch.setattr(outbox, "_paused_until", 0.0)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    notify._tr_cache.clear()

    # The app's own note routes, against the fake database.
    from backend import main, store
    shots = []

    async def put_shot(d, png):
        shots.append(png)
        return {"gridfs_id": f"g{len(shots)}", "bytes": len(png)}

    async def get_shot(d, gid):
        return b"\x89PNG fake"

    monkeypatch.setattr(main, "db", lambda: scope.ScopedDb(db, scope.current()))
    monkeypatch.setattr(main, "schedule_note_work", lambda rid: None)
    monkeypatch.setattr(store, "put_shot", put_shot)
    monkeypatch.setattr(store, "get_shot", get_shot)

    class Env:
        pass
    e = Env()
    e.db, e.bot, e.shots = db, bot, shots
    # The person at the machine, whatever an earlier test left behind.
    tokens = (actors.CURRENT.set(actors.local_user()), scope.WORKSPACE.set(scope.DEFAULT))
    yield e
    actors.CURRENT.reset(tokens[0])
    scope.WORKSPACE.reset(tokens[1])


def configured(db, **extra):
    db[core.SETTINGS].docs[core.DOC_ID] = {"_id": core.DOC_ID, "token": TOKEN, "mode": "webhook",
                                           "secret": "s3cret", "public_url": "https://redline.example.com",
                                           "bot": {"id": 123456789, "username": "redline_test_bot"}, **extra}


def linked(db, user="u1", chat=5001, role=None, name="Ayşe", **extra):
    db[core.LINKS].docs[user] = {"_id": user, "name": name, "workspace": scope.DEFAULT, "chat": chat,
                                 "tg": {"id": chat, "username": "ayse"}, "prefs": dict(links.PREFS),
                                 "lang": None, "blocked": False, **extra}
    if role:
        # An account with a system role, working in the link's space.
        db[auth.USERS].docs[user] = {"_id": user, "email": f"{user}@x.y", "name": name, "role": role,
                                     "space": scope.DEFAULT}
    return db[core.LINKS].docs[user]


def text_update(chat, text, uid=[0], **msg):
    uid[0] += 1
    return {"update_id": 900000 + uid[0], "message": {
        "message_id": 10 + uid[0], "date": 0, "chat": {"id": chat, "type": "private"},
        "from": {"id": chat, "is_bot": False, "first_name": "Ayşe"}, "text": text, **msg}}


def button(chat, data, mid, uid=[0]):
    uid[0] += 1
    return {"update_id": 800000 + uid[0], "callback_query": {
        "id": f"cq{uid[0]}", "data": data, "from": {"id": chat},
        "message": {"message_id": mid, "chat": {"id": chat, "type": "private"}}}}


def drain(db):
    return run(outbox.drain(db))


def kb(kw):
    """The inline keyboard of a recorded call, as [[(text, data)]]."""
    m = kw.get("reply_markup")
    return [[(b.text, b.callback_data) for b in row] for row in m.inline_keyboard] if m else None


# ---------------------------------------------------------------- the token

def test_the_token_is_checked_kept_and_never_shown(env):
    got = run(api.put_token(api.TokenIn(token=TOKEN)))
    doc = env.db[core.SETTINGS].docs[core.DOC_ID]
    assert doc["token"] == TOKEN                                # kept in the database, only there
    assert got["bot"]["set"] and got["bot"]["hint"] == "…" + TOKEN[-4:]
    assert got["bot"]["username"] == "redline_test_bot"
    assert TOKEN not in json.dumps(got, default=str)            # the page never sees it
    assert TOKEN[:-4] not in json.dumps(got, default=str)
    # the command menu, in English and in Turkish
    assert ("set_my_commands", {"n": len(api.COMMANDS), "lang": None}) in env.bot.calls
    assert ("set_my_commands", {"n": len(api.COMMANDS), "lang": "tr"}) in env.bot.calls


def test_a_wrong_or_misshapen_token_is_refused(env):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as e:
        run(api.put_token(api.TokenIn(token="not a token at all")))
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        run(api.put_token(api.TokenIn(token="987654321:" + "y" * 35)))   # getMe refuses it
    assert e.value.status_code == 400 and "refused" in e.value.detail
    assert not env.db[core.SETTINGS].docs.get(core.DOC_ID, {}).get("token")


def test_the_token_is_rubbed_out_of_logs_and_errors(env, caplog):
    assert TOKEN not in core.redact(f"POST https://api.telegram.org/bot{TOKEN}/getMe")
    with caplog.at_level(logging.INFO, logger="httpx"):
        logging.getLogger("httpx").info("HTTP Request: POST https://api.telegram.org/bot%s/sendMessage", TOKEN)
    assert TOKEN not in caplog.text and "<bot-token>" in caplog.text
    run(core.remember_error(env.db, f"The token `{TOKEN}` was rejected"))
    assert TOKEN not in env.db[core.SETTINGS].docs[core.DOC_ID]["last_error"]["text"]


def test_removing_the_bot_tells_the_chats_and_forgets_it(env):
    configured(env.db)
    linked(env.db)
    linked(env.db, user="u2", chat=5002)
    run(links.make_code(env.db, {"id": "u3"}, scope.DEFAULT))
    run(outbox.enqueue(env.db, 5001, text="waiting", kind="t"))
    run(core.journal(env.db, "out", "t", chat=5001))
    out = run(api.remove_bot(forget=False))
    told = [kw["chat_id"] for kw in env.bot.sent("send_message")]
    assert sorted(told) == [5001, 5002] and out["removed"] == {"unlinked": 2, "told": 2, "forget": False}
    assert ("delete_webhook", {"drop_pending_updates": True}) in env.bot.calls
    for c in (core.LINKS, core.CODES, core.OUTBOX):
        assert not env.db[c].docs
    doc = env.db[core.SETTINGS].docs[core.DOC_ID]
    assert doc == {"_id": core.DOC_ID, "public_url": "https://redline.example.com"}     # no token, no secret
    assert not out["bot"]["set"] and out["mode"] is None and out["linked"] == 0
    assert len(env.db[core.LOG].docs) == 1                       # the history stays
    configured(env.db)
    run(core.journal(env.db, "out", "t", chat=5001))
    out = run(api.remove_bot(forget=True))
    assert not env.db[core.LOG].docs and core.DOC_ID not in env.db[core.SETTINGS].docs
    assert out["stats"]["sent"] == 0 and out["public_url"] is None


def test_a_webhook_needs_https_and_gets_a_fresh_secret(env):
    from fastapi import HTTPException
    configured(env.db, mode=None, secret=None)
    with pytest.raises(HTTPException):
        run(api.put_mode(api.ModeIn(mode="webhook", public_url="http://127.0.0.1:4200")))
    run(api.put_mode(api.ModeIn(mode="webhook", public_url="https://redline.example.com/")))
    call = [kw for n, kw in env.bot.calls if n == "set_webhook"][-1]
    doc = env.db[core.SETTINGS].docs[core.DOC_ID]
    assert call["url"] == "https://redline.example.com/api/telegram/webhook"
    assert call["secret_token"] == doc["secret"] and len(doc["secret"]) > 30
    assert doc["mode"] == "webhook"


# ---------------------------------------------------------------- the webhook

def test_the_webhook_wants_the_secret_header(env, monkeypatch):
    from fastapi.testclient import TestClient
    from backend import main
    configured(env.db)
    seen = []

    async def handle(raw, update):
        seen.append(update)
    monkeypatch.setattr(inbound, "handle", handle)
    c = TestClient(main.app)
    assert c.post("/api/telegram/webhook", json={"update_id": 1}).status_code == 401
    assert c.post("/api/telegram/webhook", json={"update_id": 1},
                  headers={core.SECRET_HEADER: "nope"}).status_code == 403
    assert not seen
    r = c.post("/api/telegram/webhook", json={"update_id": 1}, headers={core.SECRET_HEADER: "s3cret"})
    assert r.status_code == 200 and seen == [{"update_id": 1}]
    # In polling mode the webhook is not ours to take, secret or not.
    env.db[core.SETTINGS].docs[core.DOC_ID]["mode"] = "polling"
    assert c.post("/api/telegram/webhook", json={"update_id": 2},
                  headers={core.SECRET_HEADER: "s3cret"}).status_code == 403


def test_an_update_is_handled_once(env):
    configured(env.db)
    linked(env.db)
    up = text_update(5001, "/help")
    run(inbound.handle(env.db, up))
    run(inbound.handle(env.db, up))                 # Telegram sent it again
    assert len(env.db[core.OUTBOX].docs) == 1


# ---------------------------------------------------------------- linking

def test_a_code_links_a_chat_once_and_only_for_ten_minutes(env):
    configured(env.db)
    got = run(links.make_code(env.db, {"id": "u1", "name": "Ayşe"}, scope.DEFAULT))
    code = got["code"]
    assert len(code) == 8 and code not in json.dumps(list(env.db[core.CODES].docs.values()), default=str)
    run(inbound.handle(env.db, text_update(5001, f"/start {code}")))
    assert env.db[core.LINKS].docs["u1"]["chat"] == 5001
    drain(env.db)
    assert "Linked" in env.bot.sent("send_message")[-1]["text"]
    # once
    assert run(links.use_code(env.db, code, 5002, {})) is None
    # ten minutes
    late = run(links.make_code(env.db, {"id": "u2", "name": "Can"}, scope.DEFAULT))
    env.db[core.CODES].docs[core.digest(late["code"])]["expires"] = core.now() - timedelta(seconds=1)
    assert run(links.use_code(env.db, late["code"], 5003, {})) is None
    assert "u2" not in env.db[core.LINKS].docs


def test_an_unknown_chat_is_told_how_to_link_and_stop_unlinks(env):
    configured(env.db)
    run(inbound.handle(env.db, text_update(7777, "hello")))
    drain(env.db)
    assert "not linked" in env.bot.sent("send_message")[-1]["text"]
    linked(env.db)
    run(inbound.handle(env.db, text_update(5001, "/stop")))
    assert "u1" not in env.db[core.LINKS].docs


def test_a_new_link_of_the_chat_replaces_the_old_one(env):
    linked(env.db, user="old", chat=5001)
    got = run(links.make_code(env.db, {"id": "u1", "name": "Ayşe"}, scope.DEFAULT))
    run(links.use_code(env.db, got["code"], 5001, {"id": 5001}))
    assert set(env.db[core.LINKS].docs) == {"u1"}


# ---------------------------------------------------------------- roles

def open_question(db, qid="q1", options=("FDM", "SLA"), multi=False, at=None):
    db.questions.docs[qid] = {"_id": qid, "at": core.iso(at or core.now() - timedelta(seconds=5)),
                              "text": "Which <process>?", "context": "fits are tight", "options": list(options),
                              "multi": multi, "revision": None, "status": "open", "answer": None,
                              "answered_at": None, "asked_by": {"type": "agent", "id": "a", "name": "a"}}


def test_a_disabled_account_is_nobody(env, monkeypatch):
    monkeypatch.setattr(auth, "enabled", lambda: True)
    configured(env.db)
    linked(env.db, role="user")
    env.db[auth.USERS].docs["u1"]["disabled"] = True
    open_question(env.db)
    run(inbound.handle(env.db, button(5001, "qa:q1:0", 42)))
    assert env.db.questions.docs["q1"]["status"] == "open"
    run(inbound.handle(env.db, text_update(5001, "/status")))
    drain(env.db)
    assert "disabled or no longer there" in env.bot.sent("send_message")[-1]["text"]


def test_an_account_gone_is_nobody(env, monkeypatch):
    monkeypatch.setattr(auth, "enabled", lambda: True)
    configured(env.db)
    linked(env.db, role="user")
    del env.db[auth.USERS].docs["u1"]
    run(inbound.handle(env.db, text_update(5001, "/status")))
    drain(env.db)
    assert "disabled or no longer there" in env.bot.sent("send_message")[-1]["text"]


def test_a_person_answers_and_queues_from_telegram(env, monkeypatch):
    monkeypatch.setattr(auth, "enabled", lambda: True)
    configured(env.db)
    linked(env.db, role="user", last_note="r1")
    env.db.revisions.docs["r1"] = {"_id": "r1", "status": "draft", "comment": "x", "created_at": "z"}
    open_question(env.db)
    run(inbound.handle(env.db, button(5001, "qa:q1:1", 42)))
    assert env.db.questions.docs["q1"]["answer"] == "SLA"


# ---------------------------------------------------------------- questions

def test_a_question_goes_out_as_buttons_and_comes_back_as_the_answer(env):
    configured(env.db)
    linked(env.db)
    run(notify.tick(env.db))                     # the first look starts the clock
    open_question(env.db)
    assert run(notify.tick(env.db)) == 1
    assert run(notify.tick(env.db)) == 0         # announced once
    drain(env.db)
    card = env.bot.sent("send_message")[-1]
    assert "Which &lt;process&gt;?" in card["text"] and "fits are tight" in card["text"]
    assert card["parse_mode"] == "HTML"
    rows = kb(card)
    assert rows[0] == [("FDM", "qa:q1:0")] and rows[1] == [("SLA", "qa:q1:1")]
    assert rows[-1][0][1] == "qr:q1"             # reply in your own words
    mid = env.db[core.MSGS].docs[next(iter(env.db[core.MSGS].docs))]["message_id"]

    run(inbound.handle(env.db, button(5001, "qa:q1:1", mid)))
    q = env.db.questions.docs["q1"]
    assert q["status"] == "answered" and q["answer"] == "SLA"
    assert q["answered_by"]["id"] == "u1" and q["answered_by"]["name"] == "Ayşe" and q["answered_by"]["via"] == "telegram"
    drain(env.db)
    edit = env.bot.sent("edit_message_text")[-1]
    assert edit["message_id"] == mid and edit["reply_markup"] is None      # the buttons go
    assert "Answered" in edit["text"] and "SLA" in edit["text"] and "via Telegram" in edit["text"]
    assert any(n == "answer_callback_query" for n, _ in env.bot.calls)


def test_answered_in_the_app_closes_the_card_too(env):
    configured(env.db)
    linked(env.db)
    run(notify.tick(env.db))
    open_question(env.db)
    run(notify.tick(env.db))
    drain(env.db)
    env.db.questions.docs["q1"].update(status="answered", answer="FDM, please",
                                       answered_by={"type": "user", "id": "u9", "name": "Can"})
    run(notify.tick(env.db))
    drain(env.db)
    edit = env.bot.sent("edit_message_text")[-1]
    assert "in the app" in edit["text"] and "FDM, please" in edit["text"]


def test_in_your_own_words_is_a_force_reply(env):
    from telegram import ForceReply
    configured(env.db)
    linked(env.db)
    open_question(env.db)
    run(inbound.handle(env.db, button(5001, "qr:q1", 42)))
    drain(env.db)
    prompt = env.bot.sent("send_message")[-1]
    assert isinstance(prompt["reply_markup"], ForceReply)
    pid = env.db[core.MSGS].docs[next(iter(env.db[core.MSGS].docs))]["message_id"]
    run(inbound.handle(env.db, text_update(5001, "Neither - it is bought", reply_to_message={"message_id": pid})))
    assert env.db.questions.docs["q1"]["answer"] == "Neither - it is bought"


def test_a_multi_choice_question_is_ticked_then_sent(env):
    configured(env.db)
    linked(env.db)
    run(notify.tick(env.db))
    open_question(env.db, options=("M3", "M4", "M5"), multi=True)
    run(notify.tick(env.db))
    drain(env.db)
    rows = kb(env.bot.sent("send_message")[-1])
    assert rows[0][0][0].startswith("☐") and rows[3] == [("Send ✓", "qs:q1")]
    mid = next(iter(env.db[core.MSGS].docs.values()))["message_id"]
    run(inbound.handle(env.db, button(5001, "qa:q1:0", mid)))
    run(inbound.handle(env.db, button(5001, "qa:q1:2", mid)))
    drain(env.db)
    assert kb(env.bot.sent("edit_message_reply_markup")[-1])[2][0][0].startswith("☑")
    run(inbound.handle(env.db, button(5001, "qs:q1", mid)))
    assert env.db.questions.docs["q1"]["answer"] == "M3, M5"


def test_a_question_comes_in_the_readers_language(env, monkeypatch):
    from backend import reading
    configured(env.db)
    linked(env.db, lang="tr")

    async def translate_doc(db, coll, did, lang, fields, kind):
        return {"id": did, "lang": "Turkish", "text": "Hangi süreç?", "context": "geçmeler sıkı",
                "options": ["FDM baskı", "SLA baskı"]}
    monkeypatch.setattr(reading, "translate_doc", translate_doc)
    run(notify.tick(env.db))
    open_question(env.db)
    run(notify.tick(env.db))
    drain(env.db)
    card = env.bot.sent("send_message")[-1]
    assert "Hangi süreç?" in card["text"] and kb(card)[0] == [("FDM baskı", "qa:q1:0")]
    run(inbound.handle(env.db, button(5001, "qa:q1:0", 101)))
    assert env.db.questions.docs["q1"]["answer"] == "FDM"          # the agent's own words


# ---------------------------------------------------------------- feedback

def test_a_note_from_telegram_is_a_draft_on_the_picked_model(env):
    configured(env.db)
    linked(env.db)
    env.db.models.docs["iot/box"] = {"_id": "iot/box", "title": "Box", "updated_at": "2026-10-01"}
    env.db.boards.docs["ctrl"] = {"_id": "ctrl", "title": "Controller", "updated_at": "2026-10-02"}
    run(inbound.handle(env.db, text_update(5001, "/note make the wall 2 mm thicker")))
    drain(env.db)
    rows = kb(env.bot.sent("send_message")[-1])
    assert ("🧊 Box", rows[0][0][1]) == rows[0][0] and rows[1][0][0] == "🟩 Controller"
    run(inbound.handle(env.db, button(5001, rows[0][0][1], 77)))
    rev = next(iter(env.db.revisions.docs.values()))
    assert rev["status"] == "draft" and rev["model"] == "iot/box" and rev["kind"] == "cad"
    assert rev["comment"] == "make the wall 2 mm thicker"
    assert rev["created_by"]["via"] == "telegram"
    link = env.db[core.LINKS].docs["u1"]
    assert link["last_note"] == rev["_id"] and link["last_target"]["id"] == "iot/box"
    # the last one used comes first next time
    run(inbound.handle(env.db, text_update(5001, "/note and round the corners")))
    drain(env.db)
    assert kb(env.bot.sent("send_message")[-1])[0][0][0] == "↺ Box"
    # /queue queues the last one
    run(inbound.handle(env.db, text_update(5001, "/queue")))
    assert env.db.revisions.docs[rev["_id"]]["status"] == "queued"
    assert env.db.revisions.docs[rev["_id"]]["status_by"]["via"] == "telegram"


def test_a_photo_with_a_caption_is_a_note_with_that_picture(env):
    configured(env.db)
    linked(env.db)
    env.db.models.docs["iot/box"] = {"_id": "iot/box", "title": "Box", "updated_at": "2026-10-01"}
    up = text_update(5001, None, photo=[{"file_id": "small", "width": 90, "height": 60},
                                        {"file_id": "big", "width": 1280, "height": 960}],
                     caption="this lid rattles")
    up["message"].pop("text")
    run(inbound.handle(env.db, up))
    drain(env.db)
    run(inbound.handle(env.db, button(5001, kb(env.bot.sent("send_message")[-1])[0][0][1], 78)))
    rev = next(iter(env.db.revisions.docs.values()))
    assert rev["comment"] == "this lid rattles" and rev["image"]["gridfs_id"] == "g1"
    assert ("get_file", {"file_id": "big"}) in env.bot.calls
    assert env.shots[0].startswith(b"\x89PNG")             # stored as a note's PNG


def test_a_plain_message_asks_what_to_do_and_can_go_to_the_agent(env):
    configured(env.db)
    linked(env.db)
    run(inbound.handle(env.db, text_update(5001, "why is the build so slow?")))
    drain(env.db)
    row = kb(env.bot.sent("send_message")[-1])[0]
    assert [d.split(":")[-1] for _, d in row] == ["note", "ask", "ignore"]
    run(inbound.handle(env.db, button(5001, row[1][1], 90)))
    drain(env.db)
    rooms = kb(env.bot.sent("send_message")[-1])[0]
    run(inbound.handle(env.db, button(5001, rooms[1][1], 91)))          # the board room
    line = next(iter(env.db.chat.docs.values()))
    assert line["room"] == "pcb" and line["text"] == "why is the build so slow?"
    assert line["by"]["via"] == "telegram" and line["seen_at"] is None


# ---------------------------------------------------------------- notifications

def test_an_applied_note_goes_out_with_its_after_picture(env):
    configured(env.db)
    linked(env.db)
    env.db.models.docs["iot/box"] = {"_id": "iot/box", "title": "Box"}
    run(notify.tick(env.db))
    env.db.revisions.docs["r1"] = {"_id": "r1", "status": "applied", "applied_at": core.iso(),
                                   "comment": "wall <2 mm>", "summary": "Thicker wall", "model": "iot/box",
                                   "image": {"gridfs_id": "a"}, "image_after": {"gridfs_id": "b"},
                                   "status_by": {"name": "agent-7"}}
    assert run(notify.tick(env.db)) == 1
    drain(env.db)
    photo = env.bot.sent("send_photo")[-1]
    assert photo["photo"] == b"\x89PNG fake" and "Note applied" in photo["caption"]
    assert "Box" in photo["caption"] and "Thicker wall" in photo["caption"]
    assert 'href="https://redline.example.com/?model=iot/box&amp;rev=r1"' in photo["caption"]


def test_the_preferences_decide_who_hears(env):
    configured(env.db)
    linked(env.db)                                           # runs: off by default
    linked(env.db, user="u2", chat=5002, prefs={**links.PREFS, "run": True})
    run(notify.tick(env.db))
    env.db.runs.docs["current"] = {"_id": "current", "status": "running", "started_at": core.iso(),
                                   "title": "Thicker wall", "revision": "r1", "room": "cad"}
    run(notify.tick(env.db))
    drain(env.db)
    assert [kw["chat_id"] for kw in env.bot.sent("send_message")] == [5002]


def test_formatting_escapes_and_links():
    rev = {"_id": "r9", "comment": "<b>not bold</b> & more", "model": "pcb1", "kind": "pcb"}
    out = fmt.note_event(None, rev, False, "https://x.y", "Board <1>")
    assert "&lt;b&gt;not bold&lt;/b&gt; &amp; more" in out and "Board &lt;1&gt;" in out
    assert "Note failed" in out and "https://x.y/?ws=pcb&amp;board=pcb1" in out
    assert fmt.note_event(None, rev, True, None).count("<a ") == 0        # no address, no link
    q = {"_id": "q", "text": "t", "options": ["x" * 80, "y"], "multi": False}
    assert "1. " in fmt.question_text(None, q, None, None, True)          # long options spelled out
    assert fmt.question_markup(None, q, None)["inline_keyboard"][0][0]["text"].startswith("1. ")
    assert "cannot answer" in fmt.question_text(None, q, None, None, False, "viewer")
    tr = fmt.w({"lang": "tr"}, "asking")
    assert tr == "Ajan soruyor"


# ---------------------------------------------------------------- the queue

def test_a_network_error_is_tried_again_with_backoff(env):
    from telegram.error import NetworkError
    configured(env.db)
    env.bot.fail = [NetworkError("down")]
    jid = run(outbox.enqueue(env.db, 5001, text="hi", kind="t"))
    assert drain(env.db) == 0
    job = env.db[core.OUTBOX].docs[jid]
    assert job["status"] == "pending" and job["attempts"] == 1
    assert core.aware(job["due"]) > core.now()                  # it waits
    job["due"] = core.now()
    assert drain(env.db) == 1
    assert env.db[core.OUTBOX].docs[jid]["status"] == "sent"
    assert outbox.backoff(1) < outbox.backoff(3) <= 600.5


def test_flood_control_waits_as_long_as_telegram_says(env):
    from telegram.error import RetryAfter
    configured(env.db)
    env.bot.fail = [RetryAfter(7)]
    jid = run(outbox.enqueue(env.db, 5001, text="hi", kind="t"))
    drain(env.db)
    job = env.db[core.OUTBOX].docs[jid]
    wait = (core.aware(job["due"]) - core.now()).total_seconds()
    assert job["status"] == "pending" and job["floods"] == 1 and job["attempts"] == 0 and 6 < wait < 8.5


def test_it_gives_up_after_six_tries_and_logs_it(env):
    from telegram.error import TimedOut
    configured(env.db)
    jid = run(outbox.enqueue(env.db, 5001, text="hi", kind="t"))
    for _ in range(outbox.MAX_ATTEMPTS):
        env.bot.fail = [TimedOut()]
        env.db[core.OUTBOX].docs[jid]["due"] = core.now()
        drain(env.db)
    assert env.db[core.OUTBOX].docs[jid]["status"] == "failed"
    row = list(env.db[core.LOG].docs.values())[-1]
    assert row["ok"] is False and row["dir"] == "out"
    assert env.db[core.SETTINGS].docs[core.DOC_ID]["last_error"]


def test_a_blocked_bot_stops_and_a_bad_request_is_not_retried(env):
    from telegram.error import BadRequest, Forbidden
    configured(env.db)
    linked(env.db)
    env.bot.fail = [Forbidden("bot was blocked by the user"), BadRequest("can't parse entities")]
    a = run(outbox.enqueue(env.db, 5001, text="hi", kind="t"))
    b = run(outbox.enqueue(env.db, 5002, text="<b", kind="t"))
    drain(env.db)
    assert env.db[core.OUTBOX].docs[a]["status"] == "failed"
    assert env.db[core.LINKS].docs["u1"]["blocked"] is True
    assert env.db[core.OUTBOX].docs[b]["status"] == "failed" and env.db[core.OUTBOX].docs[b]["attempts"] == 1


def test_a_vanished_message_is_nothing_to_edit(env):
    from telegram.error import BadRequest
    configured(env.db)
    env.bot.fail = [BadRequest("Message is not modified")]
    jid = run(outbox.enqueue(env.db, 5001, op="edit", message_id=3, text="x", kind="t"))
    drain(env.db)
    assert env.db[core.OUTBOX].docs[jid]["status"] == "sent"


def test_the_test_message_goes_now_with_a_picture(env):
    configured(env.db)
    linked(env.db, user="local")
    out = run(api.test_me(api.TestIn(photo=True)))
    assert out["ok"] is True
    sent = env.bot.sent("send_photo")[-1]
    assert sent["chat_id"] == 5001 and sent["photo"].startswith(b"\x89PNG")


def test_the_page_state_has_my_link_and_no_secrets(env):
    configured(env.db)
    linked(env.db, user="local")
    st = run(api.state())
    assert st["me"]["linked"] and st["me"]["username"] == "ayse"
    assert st["linked"] == 1 and "people" not in st
    blob = json.dumps(st, default=str)
    assert TOKEN not in blob and "s3cret" not in blob


def test_a_link_code_comes_with_a_deep_link_and_a_qr_code(env):
    configured(env.db)
    out = run(api.make_link())
    assert out["url"] == f"https://t.me/redline_test_bot?start={out['code']}"
    assert out["qr"].startswith("data:image/png;base64,")
    assert actors.current()["id"] == "local"


# ---------------------------------------------------------------- linking: codes only

def test_no_chat_is_ever_linked_without_a_code(env):
    configured(env.db)
    for text in ("/start", "hello", "/help", "/note x"):
        run(inbound.handle(env.db, text_update(6001, text)))
    run(inbound.handle(env.db, button(6001, "qa:q1:0", 1)))
    assert not env.db[core.LINKS].docs
    drain(env.db)
    texts = [kw["text"] for kw in env.bot.sent("send_message")]
    assert len(texts) == 4 and all("Link my Telegram" in t for t in texts)   # the button press: nothing


def test_a_pasted_code_or_link_command_links_too(env):
    configured(env.db)
    a = run(links.make_code(env.db, {"id": "u1", "name": "Ayşe"}, scope.DEFAULT))
    run(inbound.handle(env.db, text_update(6001, a["code"].lower())))
    assert env.db[core.LINKS].docs["u1"]["chat"] == 6001
    b = run(links.make_code(env.db, {"id": "u2", "name": "Can"}, scope.DEFAULT))
    run(inbound.handle(env.db, text_update(6002, f"/link {b['code']}")))
    assert env.db[core.LINKS].docs["u2"]["chat"] == 6002          # any number of people, each their own


def test_a_code_is_bound_to_whoever_made_it(env):
    configured(env.db)
    a = run(links.make_code(env.db, {"id": "u1", "name": "Ayşe"}, scope.DEFAULT))
    run(links.make_code(env.db, {"id": "u1", "name": "Ayşe"}, scope.DEFAULT))   # a newer one replaces it
    assert run(links.use_code(env.db, a["code"], 6001, {})) is None


def test_wrong_codes_are_limited_per_chat(env):
    configured(env.db)
    for i in range(core.TRY_LIMIT):
        run(inbound.handle(env.db, text_update(6001, f"/start WRONG{i:03d}")))
    good = run(links.make_code(env.db, {"id": "u1", "name": "Ayşe"}, scope.DEFAULT))
    run(inbound.handle(env.db, text_update(6001, f"/start {good['code']}")))
    assert not env.db[core.LINKS].docs                           # not even checked
    drain(env.db)
    assert "Too many wrong codes" in env.bot.sent("send_message")[-1]["text"]
    # another chat is not held up, and the tries fall away after 15 minutes
    for d in env.db[core.TRIES].docs.values():
        d["at"] = core.now() - timedelta(minutes=core.TRY_MINUTES + 1)
    run(inbound.handle(env.db, text_update(6001, f"/start {good['code']}")))
    assert env.db[core.LINKS].docs["u1"]["chat"] == 6001


# ---------------------------------------------------------------- the bot's profile

def test_the_profile_is_read_per_language_and_only_changes_are_sent(env):
    configured(env.db)
    env.bot.__dict__["prof"] = {"": {"name": "Redline", "description": "old"}, "tr": {"name": "Redline TR"}}
    got = run(api.get_profile(extra="tr"))
    assert got["langs"]["default"]["name"] == "Redline" and got["langs"]["tr"]["name"] == "Redline TR"
    assert got["langs"]["default"]["commands"][0]["command"] == "note"
    out = run(api.put_profile(api.ProfileIn(lang="tr", description="Türkçe açıklama")))
    assert out["results"] == {"description": {"ok": True}}
    assert [n for n, _ in env.bot.calls if n.startswith("set_my_")] == ["set_my_description"]
    assert ("set_my_description", {"v": "Türkçe açıklama", "lang": "tr"}) in env.bot.calls
    out = run(api.put_profile(api.ProfileIn(name="Redline", description="a bad one", short_description="x" * 121)))
    r = out["results"]
    assert r["name"]["ok"] and not r["description"]["ok"] and "120" in r["short_description"]["error"]
    assert env.db[core.SETTINGS].docs[core.DOC_ID]["profile_state"]["name"] is True


def test_the_profile_photo_is_cut_square_and_sent_as_jpg(env):
    from fastapi import HTTPException
    from PIL import Image
    from telegram import InputProfilePhotoStatic

    class Up:
        def __init__(self, data):
            self.data = data

        async def read(self, n=-1):
            return self.data
    configured(env.db)
    buf = io.BytesIO()
    Image.new("RGBA", (900, 500), (10, 20, 30, 255)).save(buf, "PNG")
    run(api.put_profile_photo(Up(buf.getvalue())))
    sent = env.bot.sent("set_my_profile_photo")[-1]["photo"]
    assert isinstance(sent, InputProfilePhotoStatic)
    jpg = env.db[core.SETTINGS].docs[core.DOC_ID]["avatar"]
    im = Image.open(io.BytesIO(jpg))
    assert im.format == "JPEG" and im.size == (500, 500)
    small = io.BytesIO()
    Image.new("RGB", (100, 100)).save(small, "PNG")
    for bad in (small.getvalue(), b"not a picture"):
        with pytest.raises(HTTPException) as e:
            run(api.put_profile_photo(Up(bad)))
        assert e.value.status_code == 400


# ---------------------------------------------------------------- defaults and languages

def test_the_defaults_fit_telegrams_limits():
    from backend.tgbot import profile
    for lang, d in profile.DEFAULTS.items():
        assert d["name"] == "Redline"
        for f, limit in profile.LIMITS.items():
            assert 0 < len(d[f]) <= limit, (lang, f, len(d[f]))
    from PIL import Image
    im = Image.open(profile.DEFAULT_PHOTO)
    assert im.size == (640, 640)
    assert Image.open(io.BytesIO(profile.square_jpeg(profile.DEFAULT_PHOTO.read_bytes()))).format == "JPEG"


def test_the_default_picture_can_be_used(env):
    configured(env.db)
    out = run(api.use_default_photo())
    assert out["has_photo"] and out["results"]["photo"]["ok"]
    assert env.bot.sent("set_my_profile_photo")


def test_the_language_list_is_every_iso_639_1_code():
    from backend.tgbot import languages
    codes = [x["code"] for x in languages.listing()]
    assert len(codes) == len(set(codes)) >= 180
    assert all(re.fullmatch(r"[a-z]{2}", c) for c in codes)
    assert languages.label("de") == "Deutsch · de" and languages.label("ja") == "日本語 · ja"
    assert languages.label(None) == "English (original)" and languages.english("ar") == "Arabic"
    assert run(api.get_languages())[0]["name"] == "Abkhaz"


def test_any_language_can_have_its_own_texts_and_lose_them(env):
    from fastapi import HTTPException
    configured(env.db)
    out = run(api.put_profile(api.ProfileIn(lang="ja", short_description="レッドライン")))
    assert out["results"]["short_description"]["ok"] and "ja" in out["with_text"]
    assert ("set_my_short_description", {"v": "レッドライン", "lang": "ja"}) in env.bot.calls
    assert run(api.get_profile())["langs"]["ja"]["short_description"] == "レッドライン"   # kept, read back
    out = run(api.delete_profile_lang("ja"))
    assert "ja" not in out["with_text"]
    assert ("set_my_name", {"v": "", "lang": "ja"}) in env.bot.calls                # emptied on Telegram
    with pytest.raises(HTTPException):
        run(api.put_profile(api.ProfileIn(lang="xx", name="?")))
    with pytest.raises(HTTPException):
        run(api.get_profile(extra="zz"))


def test_translate_from_default_uses_the_reading_job(env, monkeypatch):
    from backend import reading
    from backend.tgbot import profile
    configured(env.db)
    asked = []

    async def one(db, text, lang, kind):
        asked.append((lang, kind))
        return ("Übersetzt: " + text) if len(text) < 100 else "wort " * 200, {"provider": "commandcode",
                                                                              "model": "Qwen/Qwen3.8-Flash"}
    monkeypatch.setattr(reading, "one", one)
    monkeypatch.setattr(reading, "_check_key", lambda: None)
    src = profile.DEFAULTS["default"]
    out = run(api.translate_profile(api.TranslateIn(lang="de", **src)))
    assert out["fields"]["name"] == "Redline"                                       # a name stays
    assert out["fields"]["short_description"].startswith("Übersetzt: ")
    assert len(out["fields"]["description"]) <= profile.LIMITS["description"] and out["cut"]["description"]
    assert asked == [("German", "reading:bot-profile")] * 2 and out["model"] == "Qwen/Qwen3.8-Flash"
    assert not env.bot.sent("set_my_description")                                    # nothing saved


def test_a_person_picks_any_language_for_questions(env):
    configured(env.db)
    linked(env.db)
    run(inbound.handle(env.db, text_update(5001, "/lang ja")))
    assert env.db[core.LINKS].docs["u1"]["lang"] == "ja"
    drain(env.db)
    assert "日本語 · ja" in env.bot.sent("send_message")[-1]["text"]
    run(inbound.handle(env.db, text_update(5001, "/lang xx")))
    assert env.db[core.LINKS].docs["u1"]["lang"] == "ja"
    with pytest.raises(ValueError):
        run(links.set_prefs(env.db, "u1", lang="klingon"))
    run(links.set_prefs(env.db, "u1", lang="en"))
    assert env.db[core.LINKS].docs["u1"]["lang"] is None


def test_a_question_is_translated_by_language_name(env, monkeypatch):
    from backend import reading
    configured(env.db)
    linked(env.db, lang="ja")
    seen = []

    async def translate_doc(db, coll, did, lang, fields, kind):
        seen.append(lang)
        return {"id": did, "lang": lang, "text": "どちら?", "context": None, "options": ["A", "B"]}
    monkeypatch.setattr(reading, "translate_doc", translate_doc)
    run(notify.tick(env.db))
    open_question(env.db)
    run(notify.tick(env.db))
    assert seen == ["Japanese"]


def test_step_three_is_done_by_its_save_and_a_new_bot_clears_it(env):
    configured(env.db)
    assert run(api.state())["profile_done"] is None
    out = run(api.profile_done())
    assert out["profile_done"]["at"]
    assert run(api.state())["profile_done"]["at"]
    run(api.put_token(api.TokenIn(token=TOKEN)))                # another bot: its profile is to do again
    assert run(api.state())["profile_done"] is None


def test_a_question_links_to_its_rooms_thread_in_the_chat_tab():
    """The old "ask the agent" box is gone: a question's card, and the
    reply to /ask, open the room's thread pinned in the Chat tab."""
    assert fmt.app_link("https://x.y/", thread="pcb") == "https://x.y/?ws=commandcode&thread=pcb"
    q = {"_id": "q", "text": "t", "options": [], "multi": False, "room": "pcb"}
    assert "https://x.y/?ws=commandcode&amp;thread=pcb" in fmt.question_text(None, q, None, "https://x.y", True)
    del q["room"]
    assert "thread=cad" in fmt.question_text(None, q, None, "https://x.y", True)
