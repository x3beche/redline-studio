"""The notification centre: what happened, kept for each person in the app.

backend/tgbot/notify.py watches the database for events - an agent asked,
a note was applied, a build failed, a drawing was made, a price dropped -
and announces each one once. Every event it announces becomes one row here
for each person of its space who wants that kind in the app (and, as
before, a Telegram message for those who linked a chat and want it there).
The people are the space's accounts as they are *now* - not disabled,
working in that space, with a role that may look - which is exactly who
Telegram tells, minus the need for a linked chat. The server's own news
(the Command Code account, the server's health) goes to those who may
change the server's settings, in their own space.

    notifications        one row per person and event: kind, title, the
                         thing it is about (`ctx`), a longer `body`, the
                         in-app link (backend/app_links.py), created_at,
                         read_at. Kept KEEP_DAYS (TTL).
    notification_prefs   per person: which kinds come into the app, and
                         whether a new one shows a toast. What comes on
                         Telegram stays in telegram_links.prefs (one place
                         for it); the settings route reads and writes both.
    drawing_events       a technical drawing finished or failed
                         (backend/release.py writes it, the watcher reads it)

The title is one of a few fixed English phrases (the page translates it);
`ctx` holds names - models, boards, parts - which are never translated.

Routes (anyone signed in, about themselves only - backend/access.py):

    GET  /api/notifications            a page of mine: ?kind=a,b &unread=1 &before=<iso> &limit=
    GET  /api/notifications/count      how many unread, and the newest (the bell polls it)
    POST /api/notifications/read       {ids} or {all: true}
    POST /api/notifications/remove     {ids}, or {all: true} (with {read: true}: only the read ones)
    GET  /api/notifications/settings   each kind: in the app, on Telegram; toasts
    PUT  /api/notifications/settings   {inapp: {kind: bool}, telegram: {kind: bool}, toast: bool}

Marking and removing are POSTs on purpose: a DELETE is a line in the audit
trail (actors.audited), and clearing one's own bell is not worth one.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import access, actors, app_links, auth, scope

COLL = "notifications"
PREFS = "notification_prefs"
KEEP_DAYS = 60
PAGE = 50

# Every kind, in the settings' order: its group, its name and what it is,
# whether it comes into the app unless switched off (`inapp`), and whether
# it is the server's own (owner and admins only). The ids are the Telegram
# preferences' (backend/tgbot/links.py PREFS) - one kind, two ways to hear.
KINDS = [
    {"id": "question", "group": "agents", "label": "An agent asks a question", "inapp": True},
    {"id": "reply", "group": "agents", "label": "An agent replies", "inapp": True},
    {"id": "note", "group": "agents", "label": "A note is applied or fails", "inapp": True},
    {"id": "run", "group": "agents", "label": "A run starts", "inapp": False},
    {"id": "build", "group": "builds", "label": "A build fails", "inapp": True},
    {"id": "longbuild", "group": "builds", "label": "A long build is done", "inapp": True},
    {"id": "route", "group": "builds", "label": "A board is routed", "inapp": True},
    {"id": "firmware", "group": "builds", "label": "A firmware build ends", "inapp": True},
    {"id": "drawing", "group": "made", "label": "A technical drawing is made", "inapp": True},
    {"id": "release", "group": "made", "label": "A release is ready", "inapp": True},
    {"id": "bodies", "group": "made", "label": "Part bodies", "inapp": True},
    {"id": "library", "group": "made", "label": "A part joins the drawer", "inapp": False},
    {"id": "price", "group": "made", "label": "A price drops", "inapp": True},
    {"id": "budget", "group": "money", "label": "Budget warnings", "inapp": True},
    {"id": "ccusage", "group": "server", "label": "Command Code usage", "inapp": True, "server": True},
    {"id": "health", "group": "server", "label": "Server health", "inapp": True, "server": True},
]
KIND_IDS = [k["id"] for k in KINDS]
SERVER_KINDS = {k["id"] for k in KINDS if k.get("server")}
INAPP_DEFAULT = {k["id"]: k["inapp"] for k in KINDS}

router = APIRouter(prefix="/api/notifications")


def now() -> datetime:
    return datetime.now(timezone.utc)


def clip(text, n: int) -> str | None:
    text = " ".join(str(text or "").split())
    if not text:
        return None
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


async def ensure_indexes(raw) -> None:
    await raw[COLL].create_index([("user", 1), ("workspace", 1), ("created_at", -1)])
    await raw[COLL].create_index([("user", 1), ("workspace", 1), ("read_at", 1)])
    await raw[COLL].create_index("created_at", expireAfterSeconds=KEEP_DAYS * 86400)
    from . import release
    await raw[release.DRAWN].create_index("at", expireAfterSeconds=release.DRAWN_DAYS * 86400)


# ---------------- who hears ----------------

LOCAL = "local"     # the person at the machine, in local mode (actors.local_user)


async def people(raw, ws: str) -> list[tuple[str, str, str]]:
    """The accounts of a space now, as (user, role, space): not disabled,
    working in it, with a role that may look. Local mode: the person at
    the machine."""
    if not auth.enabled():
        return [(LOCAL, "owner", ws)]
    out = []
    async for u in raw[auth.USERS].find({}, {"pw": 0, "avatar": 0}):
        if u.get("disabled") or auth.space_of(u) != ws:
            continue
        role = auth.role_of(u)
        if access.allowed(role, "view"):
            out.append((u["_id"], role, ws))
    return out


async def server_people(raw, act: str = "settings") -> list[tuple[str, str, str]]:
    """Those who may change the server's settings, each in their own space."""
    if not auth.enabled():
        return [(LOCAL, "owner", scope.DEFAULT)]
    out = []
    async for u in raw[auth.USERS].find({}, {"pw": 0, "avatar": 0}):
        role = auth.role_of(u)
        if not u.get("disabled") and access.allowed(role, act):
            out.append((u["_id"], role, auth.space_of(u)))
    return out


async def prefs_of(raw, user: str) -> dict:
    doc = await raw[PREFS].find_one({"_id": user}) or {}
    return {"inapp": {**INAPP_DEFAULT, **{k: bool(v) for k, v in (doc.get("inapp") or {}).items()
                                          if k in INAPP_DEFAULT}},
            "toast": doc.get("toast", True) is not False}


def row_id(event: str, user: str) -> str:
    """One row per event and person, whoever tries to write it twice."""
    return hashlib.sha1(f"{event}|{user}".encode()).hexdigest()[:24]


async def deliver(raw, ws: str, kind: str, event: str, n: dict) -> int:
    """One event into the app: a row for each person who wants `kind`.
    `n`: title, ctx, body, link, tone. Returns how many rows were written."""
    from pymongo.errors import DuplicateKeyError
    who = await (server_people(raw) if kind in SERVER_KINDS else people(raw, ws))
    wrote = 0
    for user, _role, space in who:
        if not (await prefs_of(raw, user))["inapp"].get(kind):
            continue
        ctx = n.get("ctx")
        en, tr = ctx if isinstance(ctx, tuple) else (ctx, None)
        doc = {"_id": row_id(event, user), "user": user, "workspace": space, "kind": kind,
               "title": n.get("title") or kind, "ctx": clip(en, 240),
               "ctx_tr": clip(tr, 240) if tr and tr != en else None, "body": clip(n.get("body"), 600),
               "link": n.get("link"), "tone": n.get("tone"), "event": event, "created_at": now(), "read_at": None}
        try:
            await raw[COLL].insert_one(doc)
            wrote += 1
        except DuplicateKeyError:
            pass
    return wrote


# ---------------- what each event says ----------------
# Titles are fixed phrases (frontend i18n.ts has them in Turkish). ctx is
# the names, as they are, with the few words between them (a room, "all
# connected", "4 products") written in both languages: `ctx` and, where
# it differs, `ctx_tr` - the page shows the reader's.

ROOM_NAMES = {"cad": ("3D room", "3D oda"), "pcb": ("Board room", "Kart odası"),
              "firmware": ("Firmware room", "Firmware odası")}
JOB_NAMES = {"build": ("build", "derleme"), "layout": ("layout", "yerleşim"), "convert": ("convert", "dönüştürme"),
             "board": ("board build", "kart derlemesi"), "run": ("run", "çalışma")}


def _join(*parts) -> tuple[str, str]:
    """The parts, " · " between them, in English and in Turkish: a part is a
    name (the same in both) or an (english, turkish) pair."""
    bits = [p if isinstance(p, tuple) else (str(p), str(p)) for p in parts if p not in (None, "")]
    return " · ".join(b[0] for b in bits), " · ".join(b[1] for b in bits)


def _secs(v) -> tuple[str, str] | None:
    return (f"{v:.0f} s", f"{v:.0f} sn") if isinstance(v, (int, float)) else None


def _job(kind: str | None) -> tuple[str, str]:
    return JOB_NAMES.get(kind or "build", (kind, kind))


def question(q: dict) -> dict:
    room = q.get("room") or "cad"
    return {"title": "Agent asks", "ctx": _join(ROOM_NAMES.get(room, (room, room)), q.get("text")),
            "body": q.get("context"), "link": app_links.thread(room)}


def note(rev: dict, ok: bool, title: str | None, rejected: bool = False) -> dict:
    mid, kind = rev.get("model"), rev.get("kind")
    link = (app_links.board(mid) if kind == "pcb" else app_links.model(mid, rev.get("_id"))) if mid \
        else app_links.revision(rev.get("_id"), "notes")
    return {"title": "Note applied" if ok else "Note rejected" if rejected else "Note failed",
            "ctx": _join(title or mid, rev.get("summary") or rev.get("comment")),
            "link": link, "tone": None if ok else "danger"}


def run(run_: dict) -> dict:
    pcb = run_.get("room") == "pcb"
    mid = run_.get("model")
    link = (app_links.board(mid) if pcb else app_links.model(mid, run_.get("revision"))) if mid \
        else app_links.room("pcb" if pcb else "cad")
    return {"title": "Run started", "ctx": _join(run_.get("title"), ROOM_NAMES["pcb" if pcb else "cad"]),
            "link": link}


def budget(al: dict, name: str) -> dict:
    over = al.get("level") == "over"
    return {"title": "Over budget" if over else "Budget warning",
            "ctx": _join(name, f"{round((al.get('ratio') or 0) * 100)}%", al.get("month")),
            "link": app_links.settings("costs"), "tone": "danger" if over else "warn"}


def _job_link(job: dict) -> str:
    what = job.get("model") or job.get("board")
    if not what:
        return app_links.room("cad")
    pcb = job.get("kind") in ("layout", "board") or (job.get("board") and not job.get("model"))
    return app_links.board(what) if pcb else app_links.model(what)


def build_failed(job: dict) -> dict:
    return {"title": "Build failed",
            "ctx": _join(job.get("model") or job.get("board") or "?", _job(job.get("kind")),
                         (f"exit {job.get('rc')}", f"çıkış {job.get('rc')}")),
            "link": _job_link(job), "tone": "danger"}


def long_build(job: dict, title: str | None = None) -> dict:
    secs = job.get("wall_s")
    return {"title": "Build done",
            "ctx": _join(title or job.get("model") or job.get("board") or "?", _job(job.get("kind")), _secs(secs)),
            "link": _job_link(job)}


def reply(room: str, text: str | None, more: int = 0) -> dict:
    return {"title": "Agent replied", "ctx": _join(ROOM_NAMES.get(room, (room, room)), text),
            "body": f"+{more}" if more else None, "link": app_links.thread(room)}


def cc_reply(chat: str | None, title: str | None, text: str | None, error: str | None) -> dict:
    return {"title": "Chat answer failed" if error else "Chat answered",
            "ctx": _join(title, error or text), "link": app_links.chat(chat) if chat else app_links.room("commandcode"),
            "tone": "danger" if error else None}


def route(bid: str, title: str | None, rt: dict) -> dict:
    left = rt.get("unrouted")
    done = isinstance(left, int) and left == 0
    vias = rt.get("vias")
    return {"title": "Board routed" if done else "Routing finished",
            "ctx": _join(title or bid, ("all connected", "hepsi bağlı") if done else
                         ((f"{left} unrouted", f"{left} bağlantı açık") if isinstance(left, int) else None),
                         (f"{vias} vias", f"{vias} via") if isinstance(vias, int) else None),
            "link": app_links.board(bid), "tone": None if done else "warn"}


def firmware(job: dict) -> dict:
    res = job.get("result") or {}
    ok = job.get("status") == "done" and res.get("ok")
    first = (res.get("errors") or [{}])[0] if not ok else {}
    return {"title": "Firmware built" if ok else "Firmware build failed",
            "ctx": _join(job.get("title") or job.get("firmware") or "?",
                         None if ok else (first.get("text") or job.get("detail"))),
            "link": app_links.firmware(job["firmware"]) if job.get("firmware") else app_links.room("firmware"),
            "tone": None if ok else "danger"}


def release_done(rel: dict) -> dict:
    ok = rel.get("status") == "ready"
    return {"title": "Release ready" if ok else "Release failed",
            "ctx": _join(rel.get("project"), rel.get("tag")),
            "body": "; ".join(rel.get("problems") or []) or None, "link": app_links.room("cad"),
            "tone": None if ok else "danger"}


def body(what: str, part: str, name: str | None = None, model: str | None = None, board: str | None = None,
         ref: str | None = None) -> dict:
    return {"title": "Body asked for" if what == "asked" else "Body bound",
            "ctx": _join(part, name, f"{board} {ref}" if board else None, model),
            "link": app_links.model(model) if model else app_links.room("pcb")}


def library(p: dict) -> dict:
    return {"title": "Part in the drawer", "ctx": _join(p.get("_id"), p.get("name")),
            "link": app_links.product("lcsc", p.get("_id"))}


def cc_usage(al: dict) -> dict:
    out = al.get("level") == "exceeded"
    pct = al.get("pct")
    return {"title": "Command Code window used up" if out else "Command Code usage high",
            "ctx": _join(("weekly window", "haftalık pencere"),
                         (f"{round(pct)}%", f"%{round(pct)}") if isinstance(pct, (int, float)) else None, al.get("plan")),
            "link": app_links.settings("llm"), "tone": "danger" if out else "warn"}


HEALTH_TITLES = {"disk": "Disk nearly full", "llm": "A model provider is failing",
                 "pages": "Page errors piling up", "crash": "A build crashed"}


def health(what: str, d: dict) -> dict:
    if what == "disk":
        ctx = _join((f"{d.get('pct')}% full", f"%{d.get('pct')} dolu"),
                    (f"{d.get('free_gb', 0):.0f} GB left", f"{d.get('free_gb', 0):.0f} GB boş"), d.get("path"))
    elif what == "llm":
        ctx = _join(d.get("provider"), (f"{d.get('n')} failed in {d.get('minutes')} min",
                                        f"{d.get('minutes')} dk içinde {d.get('n')} başarısız"))
    elif what == "pages":
        ctx = _join((f"{d.get('n')} in {d.get('minutes')} min", f"{d.get('minutes')} dk içinde {d.get('n')}"))
    else:
        ctx = _join(d.get("what"), d.get("signal"))
    return {"title": HEALTH_TITLES.get(what, "Server health"), "ctx": ctx, "body": d.get("detail"),
            "link": app_links.settings("dashboard"), "tone": "danger" if what != "pages" else "warn"}


def drawing(d: dict) -> dict:
    ok = d.get("state") == "done"
    secs = d.get("secs")
    return {"title": "Drawing ready" if ok else "Drawing failed",
            "ctx": _join(d.get("title") or d.get("model"), _secs(secs) if ok else d.get("error")),
            "link": app_links.model(d.get("model")), "tone": None if ok else "danger"}


def money(v, cur: str | None) -> str:
    return f"{v:,.2f}" + (f" {cur}" if cur else "")


def price_drop(maker: dict, mid: str, drops: list[tuple[dict, dict]]) -> dict:
    """One product cheaper - or several of one maker's at once, as one."""
    name = maker.get("name") or mid
    if len(drops) == 1:
        p, d = drops[0]
        return {"title": "Price dropped",
                "ctx": _join(p.get("name") or p.get("id"), name,
                             f"{money(d['was'], d['currency'])} → {money(d['now'], d['currency'])}", f"−{d['pct']}%"),
                "link": app_links.product(mid, p.get("id"))}
    p, d = max(drops, key=lambda x: x[1]["pct"])
    return {"title": "Prices dropped",
            "ctx": _join(name, (f"{len(drops)} products", f"{len(drops)} ürün"), f"{p.get('name') or p.get('id')} −{d['pct']}%"),
            "body": "; ".join(f"{q.get('name') or q.get('id')} −{e['pct']}%" for q, e in drops[:12]),
            "link": app_links.parts(mid)}


# ---------------- the routes ----------------

def _me(write: bool = False) -> dict | None:
    """The person asking. An agent has no bell; a page session only looks."""
    who = actors.current()
    if who.get("type") != "user":
        if write:
            raise HTTPException(400, "notifications belong to a person - not an agent")
        return None
    if write and who.get("page"):
        raise HTTPException(403, "a page session only looks")
    return who


def _mine(who: dict) -> dict:
    return {"user": who["id"], "workspace": scope.current()}


def _out(d: dict) -> dict:
    return {"id": d["_id"], "kind": d.get("kind"), "title": d.get("title"), "ctx": d.get("ctx"), "ctx_tr": d.get("ctx_tr"),
            "body": d.get("body"), "link": d.get("link"), "tone": d.get("tone"),
            "created_at": d.get("created_at"), "read": bool(d.get("read_at"))}


def _raw():
    from . import main
    return main.db().raw


@router.get("")
async def listing(kind: str = "", unread: bool = False, before: str = "", limit: int = PAGE, counts: bool = False):
    who = _me()
    if not who:
        return {"items": [], "unread": 0, "more": False, "counts": {}}
    raw = _raw()
    mine = _mine(who)
    q = dict(mine)
    kinds = [k for k in kind.split(",") if k in KIND_IDS]
    if kinds:
        q["kind"] = {"$in": kinds}
    if unread:
        q["read_at"] = None
    if before:
        try:
            q["created_at"] = {"$lt": datetime.fromisoformat(before.replace("Z", "+00:00"))}
        except ValueError:
            raise HTTPException(400, "before: an ISO time") from None
    limit = max(1, min(int(limit or PAGE), 200))
    rows = await raw[COLL].find(q).sort("created_at", -1).limit(limit + 1).to_list(limit + 1)
    out = {"items": [_out(d) for d in rows[:limit]], "more": len(rows) > limit,
           "unread": await raw[COLL].count_documents({**mine, "read_at": None})}
    if counts:
        out["counts"] = {k: n for k in KIND_IDS if (n := await raw[COLL].count_documents({**mine, "kind": k}))}
    return out


@router.get("/count")
async def count():
    who = _me()
    if not who:
        return {"unread": 0, "latest": None}
    raw = _raw()
    mine = _mine(who)
    latest = await raw[COLL].find(mine).sort("created_at", -1).limit(1).to_list(1)
    return {"unread": await raw[COLL].count_documents({**mine, "read_at": None}),
            "latest": _out(latest[0]) if latest else None}


class Pick(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=500)
    all: bool = False
    read: bool = False          # remove: only the read ones


@router.post("/read")
async def mark_read(body: Pick):
    who = _me(write=True)
    raw = _raw()
    mine = _mine(who)
    q = {**mine, "read_at": None}
    if not body.all:
        if not body.ids:
            raise HTTPException(400, "which: ids, or all")
        q["_id"] = {"$in": body.ids}
    res = await raw[COLL].update_many(q, {"$set": {"read_at": now()}})
    return {"marked": int(getattr(res, "modified_count", 0) or 0),
            "unread": await raw[COLL].count_documents({**mine, "read_at": None})}


@router.post("/remove")
async def remove(body: Pick):
    who = _me(write=True)
    raw = _raw()
    mine = _mine(who)
    q = dict(mine)
    if body.all:
        if body.read:
            q["read_at"] = {"$ne": None}
    elif body.ids:
        q["_id"] = {"$in": body.ids}
    else:
        raise HTTPException(400, "which: ids, or all")
    res = await raw[COLL].delete_many(q)
    return {"removed": int(getattr(res, "deleted_count", 0) or 0),
            "unread": await raw[COLL].count_documents({**mine, "read_at": None})}


async def settings_of(raw, who: dict) -> dict:
    from .tgbot import core as tg_core, links as tg_links
    mine = await prefs_of(raw, who["id"])
    link = await tg_links.of_user(raw, who["id"])
    bot = bool(tg_core.token_of(await tg_core.settings(raw)))
    tg = tg_links.prefs_of(link) if link else None
    admin = access.allowed(access.current(), "settings")
    return {"kinds": [{"id": k["id"], "group": k["group"], "label": k["label"], "server": bool(k.get("server")),
                       "inapp": mine["inapp"][k["id"]], "telegram": tg.get(k["id"]) if tg is not None else None}
                      for k in KINDS if admin or not k.get("server")],
            "toast": mine["toast"], "telegram": {"bot": bot, "linked": bool(link), "blocked": bool((link or {}).get("blocked"))}}


@router.get("/settings")
async def get_settings():
    who = _me()
    if not who:
        raise HTTPException(400, "notifications belong to a person - not an agent")
    return await settings_of(_raw(), who)


class SettingsIn(BaseModel):
    inapp: dict[str, bool] | None = None
    telegram: dict[str, bool] | None = None
    toast: bool | None = None


@router.put("/settings")
async def put_settings(body: SettingsIn):
    who = _me(write=True)
    raw = _raw()
    patch: dict = {}
    for k, v in (body.inapp or {}).items():
        if k not in INAPP_DEFAULT:
            raise HTTPException(400, f"no such notification: {k}")
        patch[f"inapp.{k}"] = bool(v)
    if body.toast is not None:
        patch["toast"] = bool(body.toast)
    if body.telegram:
        # The Telegram side is the link's own preferences (tgbot/links.py) -
        # only with a linked chat.
        from .tgbot import links as tg_links
        try:
            if not await tg_links.set_prefs(raw, who["id"], body.telegram):
                raise HTTPException(400, "link your Telegram first (Settings > Telegram)")
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None
    if patch:
        await raw[PREFS].update_one({"_id": who["id"]}, {"$set": patch}, upsert=True)
    return await settings_of(raw, who)
