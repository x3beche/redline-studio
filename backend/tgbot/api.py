"""Settings > Telegram, and the webhook Telegram calls.

    GET    /api/telegram                 everything the page shows (no token, ever)
    GET    /api/telegram/check           getMe and getWebhookInfo, live
    GET    /api/telegram/avatar          the bot's picture
    PUT    /api/telegram/token           check a token with getMe and keep it   (settings)
    DELETE /api/telegram/bot             remove the bot: webhook, token, links  (settings)
    GET    /api/telegram/profile         name, descriptions, commands - live from Telegram
    PUT    /api/telegram/profile         change the fields given, per language  (settings)
    PUT    /api/telegram/profile/photo   a new picture (cut square, sent as JPG) (settings)
    PUT    /api/telegram/profile/photo/default   Redline's mark as the picture   (settings)
    DELETE /api/telegram/profile/lang/{code}     a language's own texts away     (settings)
    POST   /api/telegram/profile/translate       the default's texts, translated (settings)
    POST   /api/telegram/profile/done            step 3 saved: the profile is as wanted (settings)
    GET    /api/telegram/languages       every ISO 639-1 language, for the pickers
    DELETE /api/telegram/profile/photo   no picture                             (settings)
    PUT    /api/telegram/mode            webhook | polling | off                 (settings)
    PUT    /api/telegram/settings        the public address links point to      (settings)
    POST   /api/telegram/link            a one-time code to link my chat
    DELETE /api/telegram/link            unlink my chat
    PUT    /api/telegram/me              what I hear about, and in which language
    POST   /api/telegram/me/test         a test message to my chat, now
    POST   /api/telegram/webhook         Telegram's updates - only with the secret header

Who may call which is backend/access.py's, like every route.
"""

from __future__ import annotations

import hmac
import time
import uuid
from datetime import timedelta

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field

from .. import access, actors, auth, scope
from . import core, inbound, languages, links, outbox, profile

router = APIRouter(prefix="/api/telegram")

COMMANDS = [
    ("note", "a draft note on a model or board"),
    ("queue", "queue the last draft note"),
    ("ask", "write to the agent's thread"),
    ("status", "what is working now"),
    ("lang", "the language questions come in"),
    ("help", "what the bot can do"),
    ("stop", "unlink this chat"),
]

PREF_INFO = [
    {"id": "question", "label": "An agent asks a question", "about": "answer with buttons or in your own words"},
    {"id": "note", "label": "A note is applied or fails", "about": "with its after picture when there is one"},
    {"id": "run", "label": "A run starts", "about": "an agent picks up a note"},
    {"id": "budget", "label": "Budget warnings", "about": "a monthly budget crosses its warning or 100%"},
    {"id": "build", "label": "A build fails", "about": "a model build, a board layout or convert"},
    {"id": "digest", "label": "Daily digest", "about": "every morning, 09:00 Istanbul: the day in six numbers"},
]


def _raw():
    return core.raw()


def _me() -> dict:
    who = actors.current()
    if who.get("type") != "user" or who.get("page"):
        raise HTTPException(400, "only a person links a Telegram chat - not an agent or a page session")
    return who


def _can(act: str) -> bool:
    return access.allowed(access.current(), act)


def _webhook_ok(st: dict) -> bool | None:
    if st.get("mode") != "webhook":
        return None
    info = st.get("webhook_info") or {}
    if not info.get("url") or info.get("url") != core.webhook_url(st.get("public_url")):
        return False
    err = core.aware(info.get("last_error_date")) if not isinstance(info.get("last_error_date"), (int, float)) \
        else core.aware(_from_ts(info["last_error_date"]))
    if err and err > core.now() - timedelta(hours=1):
        good = core.aware(st.get("last_update_at"))
        return bool(good and good > err)
    return True


def _from_ts(v):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(v, timezone.utc)


def _link_out(link: dict | None) -> dict:
    if not link:
        return {"linked": False}
    tg = link.get("tg") or {}
    return {"linked": True, "chat": link.get("chat"), "username": tg.get("username"),
            "name": " ".join(x for x in [tg.get("first_name"), tg.get("last_name")] if x) or None,
            "linked_at": link.get("linked_at"), "prefs": links.prefs_of(link), "lang": link.get("lang"),
            "blocked": bool(link.get("blocked"))}


async def state() -> dict:
    raw = _raw()
    st = await core.settings(raw)
    token = core.token_of(st)
    botinfo = st.get("bot") or {}
    who = actors.current()
    mine = await links.of_user(raw, who.get("id")) if who.get("type") == "user" else None
    code = await raw[core.CODES].find_one({"user": who.get("id")}) if who.get("type") == "user" else None
    linked = await raw[core.LINKS].count_documents({})
    out = {
        "bot": {"set": bool(token), "hint": core.hint(token), "id": botinfo.get("id"),
                "username": botinfo.get("username"), "name": botinfo.get("first_name"),
                "has_avatar": bool(st.get("avatar")), "set_at": st.get("set_at"),
                "set_by": (st.get("set_by") or {}).get("name"),
                "url": f"https://t.me/{botinfo['username']}" if botinfo.get("username") else None},
        "online": st.get("online") or None,
        "mode": st.get("mode"), "public_url": st.get("public_url"),
        "webhook_url": core.webhook_url(st.get("public_url")),
        "webhook": st.get("webhook_info") or None, "webhook_ok": _webhook_ok(st),
        "last_update_at": st.get("last_update_at"),
        "last_error": st.get("last_error"),
        "stats": await core.counts(raw),
        "linked": linked,
        "me": {**_link_out(mine), "code_pending": bool(code and (core.aware(code.get("expires")) or core.now())
                                                       > core.now())},
        "prefs": PREF_INFO,
        "commands": [{"command": c, "about": a} for c, a in COMMANDS],
        "can_edit": _can("settings"),
        "queue": await raw[core.OUTBOX].count_documents({"status": {"$in": ["pending", "sending"]}}),
        "profile": st.get("profile_state") or None,
        # step 3 is done when someone pressed its Save - not guessed from the fields
        "profile_done": st.get("profile_done") or None,
    }
    # Each person sees their own link only; the bot's log is the server's.
    if out["can_edit"]:
        out["log"] = [{k: r.get(k) for k in ("at", "dir", "kind", "ok", "error", "preview", "user")}
                      async for r in raw[core.LOG].find({}).sort("at", -1).limit(25)]
    return out


@router.get("")
async def get_state() -> dict:
    return await state()


async def _avatar(b, bot_id: int) -> bytes | None:
    try:
        photos = await b.get_user_profile_photos(bot_id, limit=1)
        sizes = (getattr(photos, "photos", None) or [[]])[0]
        if not sizes:
            return None
        small = [s for s in sizes if getattr(s, "width", 0) >= 120] or list(sizes)
        f = await b.get_file(small[0].file_id)
        return bytes(await f.download_as_bytearray())
    except Exception:                                    # noqa: BLE001 - no picture is fine
        return None


async def _webhook_info(b) -> dict:
    info = core.to_dict(await b.get_webhook_info())
    return {k: info.get(k) for k in ("url", "pending_update_count", "last_error_date", "last_error_message",
                                     "max_connections", "ip_address", "allowed_updates")}


@router.get("/check")
async def check() -> dict:
    """Is the bot there, and is the webhook as we left it - asked of
    Telegram now."""
    from telegram.error import TelegramError
    raw = _raw()
    b = await core.bot(raw)
    if b is None:
        return await state()
    t0 = time.monotonic()
    try:
        me = core.to_dict(await b.get_me())
        patch = {"online": {"ok": True, "at": core.now(), "ms": round((time.monotonic() - t0) * 1000)},
                 "bot": {k: me.get(k) for k in ("id", "username", "first_name", "can_join_groups")}}
        patch["webhook_info"] = await _webhook_info(b)
        pic = await _avatar(b, me["id"]) if me.get("id") else None
        if pic:
            patch["avatar"] = pic
        await core.patch_settings(raw, patch)
    except TelegramError as exc:
        await core.patch_settings(raw, {"online": {"ok": False, "at": core.now(), "error": core.redact(exc)[:200]}})
        await core.remember_error(raw, str(exc), "checking the bot")
    return await state()


@router.get("/avatar")
async def avatar():
    st = await core.settings(_raw())
    if not st.get("avatar"):
        raise HTTPException(404, "the bot has no picture")
    return Response(bytes(st["avatar"]), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=300"})


class TokenIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)


@router.put("/token")
async def put_token(body: TokenIn) -> dict:
    """Check the token with getMe, then keep it. The token never comes back."""
    from telegram.error import InvalidToken, NetworkError, TelegramError
    raw = _raw()
    token = body.token.strip()
    if not core.TOKEN_SHAPE.match(token):
        raise HTTPException(400, "that does not look like a bot token - it is digits, a colon and "
                                 "35 letters, as @BotFather gives it")
    b = core.make_bot(token)
    try:
        me = core.to_dict(await b.get_me())
    except InvalidToken:
        raise HTTPException(400, "Telegram refused this token - copy it again from @BotFather "
                                 "(/mybots → your bot → API Token)")
    except (NetworkError, TelegramError) as exc:
        raise HTTPException(502, f"Telegram did not answer: {core.redact(exc)}"[:300])
    if not me.get("is_bot", True):
        raise HTTPException(400, "that token is not a bot's")
    old = await core.settings(raw)
    if (old.get("bot") or {}).get("id") not in (None, me.get("id")):
        # Another bot: its chats are not this bot's, so the links go.
        await raw[core.LINKS].delete_many({})
        await raw[core.MSGS].delete_many({})
    pic = await _avatar(b, me["id"])
    await profile.set_commands(b)                      # the menu, in English and Turkish
    who = actors.current()
    await core.patch_settings(raw, {
        "token": token, "bot": {k: me.get(k) for k in ("id", "username", "first_name", "can_join_groups")},
        "avatar": pic, "set_at": core.now(), "set_by": {"id": who.get("id"), "name": who.get("name")},
        "online": {"ok": True, "at": core.now()}}, unset=["last_error", "watch", "profile_done"])
    try:
        await b.shutdown()
    except Exception:                                    # noqa: BLE001
        pass
    await core.drop_bot()
    await actors.audit(raw, "telegram", "token", {"bot": me.get("username")})
    if old.get("mode") == "webhook" and old.get("public_url"):
        try:
            await _set_mode(raw, "webhook", old.get("public_url"))
        except HTTPException:
            pass
    return await state()


@router.delete("/bot")
async def remove_bot(forget: bool = False) -> dict:
    """Remove the bot from Redline: tell every linked chat, take the webhook
    down (dropping what waits), forget the token, the secret and the bot's
    state, unlink everyone, drop the codes and what was not sent. With
    `forget`, the log and the counters go too. The bot itself still exists
    on Telegram - only @BotFather (/deletebot) can delete it."""
    from telegram.error import TelegramError
    raw = _raw()
    b = await core.bot(raw)
    told = 0
    if b is not None:
        async for link in raw[core.LINKS].find({}):
            try:
                await b.send_message(chat_id=link["chat"],
                                     text="This bot was disconnected from Redline. Nothing more will come "
                                          "from it, and what you send is not read.")
                told += 1
            except TelegramError:
                pass
        try:
            await b.delete_webhook(drop_pending_updates=True)
        except TelegramError as exc:
            core.log.warning("telegram: webhook not removed: %s", core.redact(exc))
    unlinked = (await raw[core.LINKS].delete_many({})).deleted_count
    for coll in (core.CODES, core.MSGS, core.PENDING, core.OUTBOX, core.TRIES):
        await raw[coll].delete_many({})
    st = await core.settings(raw)
    if forget:
        await raw[core.LOG].delete_many({})
        await raw[core.EVENTS].delete_many({})
        await raw[core.SETTINGS].delete_one({"_id": core.DOC_ID})
    else:
        await raw[core.SETTINGS].replace_one({"_id": core.DOC_ID},
                                             {"_id": core.DOC_ID, "public_url": st.get("public_url")}, upsert=True)
    await core.drop_bot()
    await actors.audit(raw, "telegram", "bot", {"removed": (st.get("bot") or {}).get("username"),
                                                "unlinked": unlinked, "told": told, "forget": forget})
    return {**await state(), "removed": {"unlinked": unlinked, "told": told, "forget": forget}}


# ---------------- the bot's profile ----------------

@router.get("/languages")
async def get_languages() -> list[dict]:
    """Every ISO 639-1 language, for the pickers (languages.py)."""
    return languages.listing()


async def _profile_bot():
    b = await core.bot(_raw())
    if b is None:
        raise HTTPException(409, "save the bot's token first")
    return b


def _codes(extra: str | None) -> list[str]:
    out = []
    for c in (extra or "").split(","):
        c = c.strip().lower()
        if c and c != "default":
            if not languages.known(c):
                raise HTTPException(400, f"no language {c!r} - an ISO 639-1 code, like de or ja")
            out.append(c)
    return out


async def _profile_out(b, extra: list[str] | None = None) -> dict:
    from telegram.error import TelegramError
    raw = _raw()
    st = await core.settings(raw)
    kept = list(st.get("profile_langs") or [])
    try:
        langs = await profile.read(b, kept + [c for c in extra or [] if c not in kept])
    except TelegramError as exc:
        raise HTTPException(502, f"Telegram did not answer: {core.redact(exc)}"[:300])
    # What the bot really has text in: a kept language Telegram has emptied is dropped.
    has = [c for c in kept if any(langs.get(c, {}).get(f) for f in profile.FIELDS)]
    d = langs.get("default") or {}
    ps = {"name": bool(d.get("name")), "description": bool(d.get("description")),
          "short_description": bool(d.get("short_description")), "photo": bool(st.get("avatar")),
          "at": core.now()}
    await core.patch_settings(raw, {"profile_state": ps, "profile_langs": has})
    return {"langs": langs, "with_text": ["default"] + has, "limits": profile.LIMITS,
            "defaults": profile.DEFAULTS, "has_photo": bool(st.get("avatar")), "state": ps,
            "min_side": profile.MIN_SIDE}


@router.get("/profile")
async def get_profile(extra: str | None = None) -> dict:
    """The default and every language written from here, live; `extra`
    (codes, comma-separated) reads more."""
    return await _profile_out(await _profile_bot(), _codes(extra))


class ProfileIn(BaseModel):
    lang: str = Field(default="default", max_length=10)
    name: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    short_description: str | None = Field(default=None, max_length=1000)


@router.put("/profile")
async def put_profile(body: ProfileIn) -> dict:
    """Only the fields sent are changed; each is reported on its own."""
    b = await _profile_bot()
    raw = _raw()
    try:
        lc = profile.code_of(body.lang)
        results = await profile.save(b, body.lang, {"name": body.name, "description": body.description,
                                                    "short_description": body.short_description})
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if lc and any(r.get("ok") for r in results.values()):
        kept = list((await core.settings(raw)).get("profile_langs") or [])
        if lc not in kept:
            await core.patch_settings(raw, {"profile_langs": kept + [lc]})
    await actors.audit(raw, "telegram", "profile", {"lang": body.lang, "fields": sorted(results)})
    return {**await _profile_out(b, [lc] if lc else []), "results": results}


@router.post("/profile/done")
async def profile_done() -> dict:
    """Step 3's Save: the profile is as its editor wants it. A new token
    (another bot) clears it."""
    await _profile_bot()
    who = actors.current()
    done = {"at": core.now(), "by": who.get("name")}
    await core.patch_settings(_raw(), {"profile_done": done})
    return {"profile_done": done}


@router.delete("/profile/lang/{code}")
async def delete_profile_lang(code: str) -> dict:
    """A language's own texts taken away: its speakers see the default."""
    b = await _profile_bot()
    raw = _raw()
    try:
        lc = profile.code_of(code)
        if not lc:
            raise ValueError("the default stays - empty its fields instead")
        results = await profile.save(b, lc, {f: "" for f in profile.FIELDS})
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    kept = [c for c in (await core.settings(raw)).get("profile_langs") or [] if c != lc]
    await core.patch_settings(raw, {"profile_langs": kept})
    await actors.audit(raw, "telegram", "profile", {"lang": lc, "removed": True})
    return {**await _profile_out(b), "results": results}


class TranslateIn(BaseModel):
    lang: str = Field(min_length=2, max_length=10)
    name: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    short_description: str | None = Field(default=None, max_length=1000)


@router.post("/profile/translate")
async def translate_profile(body: TranslateIn) -> dict:
    """The default's texts (as given - what is on the page) in another
    language, by the Reading translation job. Nothing is saved: the page
    shows it as machine-translated until it is edited or saved."""
    from .. import main
    try:
        return await profile.translate(main.db(), body.lang, {"name": body.name, "description": body.description,
                                                              "short_description": body.short_description})
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.put("/profile/photo")
async def put_profile_photo(file: UploadFile = File(...)) -> dict:
    data = await file.read(profile.MAX_UPLOAD + 1)
    return await _photo(data)


@router.get("/profile/photo/default")
async def default_photo():
    return Response(profile.DEFAULT_PHOTO.read_bytes(), media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600"})


@router.put("/profile/photo/default")
async def use_default_photo() -> dict:
    """Redline's mark as the bot's picture."""
    return await _photo(profile.DEFAULT_PHOTO.read_bytes())


async def _photo(data: bytes) -> dict:
    from telegram.error import TelegramError
    b = await _profile_bot()
    try:
        jpg = await profile.set_photo(b, data)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except TelegramError as exc:
        raise HTTPException(400, f"Telegram refused the picture: {core.redact(exc)}"[:300])
    await core.patch_settings(_raw(), {"avatar": jpg})
    await actors.audit(_raw(), "telegram", "profile", {"photo": len(jpg)})
    return {**await _profile_out(b), "results": {"photo": {"ok": True}}}


@router.delete("/profile/photo")
async def delete_profile_photo() -> dict:
    from telegram.error import TelegramError
    b = await _profile_bot()
    try:
        await b.remove_my_profile_photo()
    except TelegramError as exc:
        raise HTTPException(400, f"Telegram refused: {core.redact(exc)}"[:300])
    await core.patch_settings(_raw(), {}, unset=["avatar"])
    return {**await _profile_out(b), "results": {"photo": {"ok": True}}}


class ModeIn(BaseModel):
    mode: str = Field(pattern="^(webhook|polling|off)$")
    public_url: str | None = Field(default=None, max_length=300)


def _clean_url(url: str | None) -> str | None:
    url = (url or "").strip().rstrip("/")
    if not url:
        return None
    if not url.startswith(("https://", "http://")) or " " in url:
        raise HTTPException(400, "the public address is a URL, like https://redline.example.com")
    return url


async def _set_mode(raw, mode: str, public_url: str | None) -> None:
    from telegram.error import TelegramError
    b = await core.bot(raw)
    if b is None:
        raise HTTPException(409, "save the bot's token first")
    st = await core.settings(raw)
    if mode == "webhook":
        base = _clean_url(public_url) or st.get("public_url")
        url = core.webhook_url(base)
        if not url or not url.startswith("https://"):
            raise HTTPException(400, "a webhook needs the app's public https address - Telegram calls "
                                     f"{core.WEBHOOK_PATH} on it. Use long polling where there is none.")
        secret = core.new_secret()
        # The secret is kept before Telegram is told, so the first update passes.
        await core.patch_settings(raw, {"secret": secret, "public_url": base})
        try:
            await b.set_webhook(url=url, secret_token=secret, allowed_updates=core.ALLOWED_UPDATES,
                                max_connections=10)
        except TelegramError as exc:
            await core.remember_error(raw, str(exc), "setting the webhook")
            raise HTTPException(400, f"Telegram refused the webhook: {core.redact(exc)}"[:300])
        await core.patch_settings(raw, {"mode": "webhook"})
    else:
        try:
            await b.delete_webhook()
        except TelegramError as exc:
            raise HTTPException(502, f"Telegram did not answer: {core.redact(exc)}"[:300])
        await core.patch_settings(raw, {"mode": "polling" if mode == "polling" else None}, unset=["secret"])
        if public_url:
            await core.patch_settings(raw, {"public_url": _clean_url(public_url)})
    try:
        await core.patch_settings(raw, {"webhook_info": await _webhook_info(b)})
    except TelegramError:
        pass


@router.put("/mode")
async def put_mode(body: ModeIn) -> dict:
    """How updates arrive: a webhook (Telegram calls us, with a secret
    header), long polling (we ask Telegram), or not at all."""
    await _set_mode(_raw(), body.mode, body.public_url)
    await actors.audit(_raw(), "telegram", "mode", {"mode": body.mode})
    return await state()


class SettingsIn(BaseModel):
    public_url: str | None = Field(default=None, max_length=300)


@router.put("/settings")
async def put_settings(body: SettingsIn) -> dict:
    await core.patch_settings(_raw(), {"public_url": _clean_url(body.public_url)})
    return await state()


# ---------------- linking ----------------

@router.post("/link")
async def make_link() -> dict:
    """A one-time code, its t.me link and a QR code. Good for ten minutes."""
    import segno
    raw = _raw()
    who = _me()
    st = await core.settings(raw)
    username = (st.get("bot") or {}).get("username")
    if not core.token_of(st) or not username:
        raise HTTPException(409, "there is no bot yet - an admin sets it up first (Settings > Telegram)")
    got = await links.make_code(raw, who, scope.current())
    url = f"https://t.me/{username}?start={got['code']}"
    qr = segno.make(url, error="m").png_data_uri(scale=5, border=2)
    return {"code": got["code"], "url": url, "expires": got["expires"], "minutes": core.CODE_MINUTES,
            "qr": qr, "bot": username}


@router.delete("/link")
async def delete_my_link() -> dict:
    raw = _raw()
    who = _me()
    link = await links.of_user(raw, who["id"])
    await raw[core.CODES].delete_many({"user": who["id"]})
    if link:
        await links.unlink(raw, who["id"])
        await outbox.enqueue(raw, link["chat"], text="Unlinked from Redline (from the app).", kind="unlinked",
                             user=who["id"])
    return await state()


class MeIn(BaseModel):
    prefs: dict[str, bool] | None = None
    lang: str | None = Field(default="", max_length=10)


@router.put("/me")
async def put_me(body: MeIn) -> dict:
    who = _me()
    try:
        got = await links.set_prefs(_raw(), who["id"], body.prefs, body.lang)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not got:
        raise HTTPException(404, "your Telegram is not linked")
    return await state()


class TestIn(BaseModel):
    photo: bool = True


@router.post("/me/test")
async def test_me(body: TestIn) -> dict:
    """A test message to my own chat, sent now rather than queued, so the
    page can say at once whether it arrived."""
    from . import fmt
    raw = _raw()
    who = _me()
    link = await links.of_user(raw, who["id"])
    if not link:
        raise HTTPException(409, "link your Telegram first")
    b = await core.bot(raw)
    if b is None:
        raise HTTPException(409, "there is no bot yet")
    job = {"_id": uuid.uuid4().hex, "at": core.now(), "due": core.now(), "status": "sending", "lease": core.now(),
           "attempts": 0, "floods": 0, "op": "send", "chat": link["chat"], "user": who["id"],
           "ws": scope.current(), "kind": "test", "text": fmt.w(link, "test"), "markup": None,
           "photo": {"test": True} if body.photo else None, "track": None}
    await raw[core.OUTBOX].insert_one(job)
    t0 = time.monotonic()
    ok = await outbox.send_one(raw, b, job)
    after = await raw[core.OUTBOX].find_one({"_id": job["_id"]}) or {}
    return {"ok": ok, "ms": round((time.monotonic() - t0) * 1000), "error": after.get("error") if not ok else None,
            "retrying": after.get("status") == "pending"}


# ---------------- Telegram's way in ----------------

@router.post("/webhook")
async def webhook(request: Request) -> dict:
    """Updates from Telegram. Without the secret header it is not Telegram:
    401 when the header is missing, 403 when it is wrong."""
    got = request.headers.get(core.SECRET_HEADER)
    if not got:
        raise HTTPException(401, "no secret")
    st = await core.settings(_raw())
    want = st.get("secret") or ""
    if not want or st.get("mode") != "webhook" or not hmac.compare_digest(got.encode(), want.encode()):
        raise HTTPException(403, "wrong secret")
    try:
        update = await request.json()
    except Exception:                                    # noqa: BLE001
        raise HTTPException(400, "not JSON")
    if isinstance(update, dict):
        await inbound.handle(_raw(), update)
    return {"ok": True}


def auth_enabled() -> bool:      # for the page: whether people are real accounts
    return auth.enabled()
