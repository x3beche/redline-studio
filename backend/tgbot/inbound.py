"""What people send the bot, and what it does about it.

An update is the Bot API's JSON, as the webhook receives it (or as long
polling hands it over, turned back into JSON). Everything a linked person
does goes through the same code the app's routes run, as that person, in
their workspace, with their role now (links.acting): an answer is
questions.answer(), a note is main.create_revision(), queueing it is
main.set_status(), a line to the agent is chat.post(). So a viewer cannot
do from Telegram what the app would not let them do, and the record says
who did it - "via": "telegram" on the actor.

    /start <code>   link this chat (the code from Settings > Telegram)
    /note <text>    a draft note on a model or board, picked from buttons
                    (a photo with a caption is a note too)
    /queue          queue the last draft note made here
    /ask <text>     a line to a room's agent ("ask the agent")
    /status         Working now (backend/worknow.py)
    /lang <code>    the language questions come in
    /stop           unlink
    /help           the list

Anything else - text, or a photo without a caption - is asked about:
make it a note, send it to the agent, or ignore it. A reply to a
question's card (or to the "in your own words" prompt) answers it.
"""

from __future__ import annotations

import base64
import io
import logging
import re
import uuid

from .. import access, chat, questions, scope
from . import core, fmt, languages, links, notify, outbox

log = logging.getLogger("redline.telegram")

_CMD = re.compile(r"^/([A-Za-z_]+)(?:@\w+)?(?:\s+(.*))?$", re.S)


def parse_command(text: str) -> tuple[str | None, str]:
    m = _CMD.match((text or "").strip())
    if not m:
        return None, (text or "").strip()
    return m.group(1).lower(), (m.group(2) or "").strip()


async def reply(raw, chat_id, text: str, *, link: dict | None = None, markup: dict | None = None,
                kind: str = "reply", track: dict | None = None) -> None:
    await outbox.enqueue(raw, chat_id, text=text, kind=kind, user=(link or {}).get("_id"),
                         ws=(link or {}).get("workspace"), markup=markup, track=track)


async def _refuse(raw, chat_id, link, role, act) -> None:
    who = next((r for r in reversed(access.ROLES) if act in access.CAN[r]), "owner")
    await reply(raw, chat_id, fmt.w(link, "role_cant", role=role, what=access.ACTIONS.get(act, act), who=who),
                link=link)


async def handle(raw, update: dict) -> None:
    """One update. Never raises: a webhook that answers 500 is sent the
    same update again and again."""
    raw = core.raw_of(raw)
    try:
        uid = update.get("update_id")
        if uid is not None and not await notify.announce(raw, f"u:{uid}"):
            return                                       # seen already
        await core.patch_settings(raw, {"last_update_at": core.now()})
        if update.get("callback_query"):
            await on_callback(raw, update["callback_query"])
        elif update.get("message"):
            await on_message(raw, update["message"])
    except Exception as exc:                              # noqa: BLE001
        await core.remember_error(raw, f"{type(exc).__name__}: {exc}", "handling an update")


# ---------------- messages ----------------

def _photo_id(msg: dict) -> str | None:
    sizes = msg.get("photo") or []
    if not sizes:
        doc = msg.get("document") or {}
        return doc.get("file_id") if str(doc.get("mime_type", "")).startswith("image/") else None
    fit = [s for s in sizes if max(s.get("width", 0), s.get("height", 0)) <= 1600]
    return (fit or sizes)[-1].get("file_id")


async def on_message(raw, msg: dict) -> None:
    chat_id = (msg.get("chat") or {}).get("id")
    if chat_id is None or (msg.get("chat") or {}).get("type") not in (None, "private"):
        return                                           # the bot works in private chats only
    text = msg.get("text") or msg.get("caption") or ""
    photo = _photo_id(msg)
    cmd, arg = parse_command(text)
    link = await links.by_chat(raw, chat_id)
    await core.journal(raw, "in", f"/{cmd}" if cmd else ("photo" if photo else "text"), chat=chat_id,
                       user=(link or {}).get("_id"), preview=text if cmd != "start" else "/start",
                       workspace=(link or {}).get("workspace"))

    # Linking: only ever by a valid one-time code - from the deep link
    # (/start <code>), /link <code>, or the code pasted into a chat that is
    # not linked yet. No chat is linked any other way, the first one included.
    if cmd in ("start", "link") and arg:
        await try_code(raw, chat_id, arg, msg.get("from") or {}, link)
        return
    if not link:
        if not cmd and CODE_SHAPE.match(text.strip()):
            await try_code(raw, chat_id, text.strip(), msg.get("from") or {}, None)
        else:
            await reply(raw, chat_id, fmt.w(None, "not_linked"))
        return
    if link.get("blocked"):
        await raw[core.LINKS].update_one({"_id": link["_id"]}, {"$set": {"blocked": False}})
    if cmd == "stop":
        await links.unlink(raw, link["_id"])
        await reply(raw, chat_id, fmt.w(link, "stopped"), link=link)
        return
    role = await links.role_of(raw, link)
    if not role:
        await reply(raw, chat_id, fmt.w(link, "no_access"), link=link)
        return

    if cmd in ("help", "start"):
        await reply(raw, chat_id, fmt.w(link, "help"), link=link)
    elif cmd == "lang":
        await set_lang(raw, link, arg)
    elif cmd == "status":
        await status(raw, link, role)
    elif cmd == "note":
        await start_note(raw, link, role, arg, photo)
    elif cmd == "queue":
        await queue_last(raw, link, role, arg)
    elif cmd == "ask":
        await start_ask(raw, link, role, arg)
    elif cmd:
        await reply(raw, chat_id, fmt.w(link, "help"), link=link)
    else:
        # A reply to a question's card, or to the "own words" prompt, answers it.
        to = (msg.get("reply_to_message") or {}).get("message_id")
        if to is not None and text.strip():
            m = await raw[core.MSGS].find_one({"chat": chat_id, "message_id": to,
                                               "kind": {"$in": ["question", "prompt"]}})
            if m:
                await answer(raw, link, role, m["question"], text.strip(), chat_id)
                return
        if photo and text.strip():
            await start_note(raw, link, role, text.strip(), photo)
            return
        await ask_what(raw, link, text.strip(), photo)


CODE_SHAPE = re.compile(r"^[A-Za-z0-9]{8}$")


async def try_code(raw, chat_id, code: str, tg_user: dict, link: dict | None) -> bool:
    """One link attempt. A chat that sent TRY_LIMIT wrong codes in
    TRY_MINUTES is not even checked until the oldest of them is that old."""
    from datetime import timedelta
    since = core.now() - timedelta(minutes=core.TRY_MINUTES)
    if await raw[core.TRIES].count_documents({"chat": chat_id, "at": {"$gt": since}}) >= core.TRY_LIMIT:
        await reply(raw, chat_id, fmt.w(link, "too_many", m=core.TRY_MINUTES), link=link)
        return False
    got = await links.use_code(raw, code, chat_id, tg_user)
    if not got:
        await raw[core.TRIES].insert_one({"chat": chat_id, "at": core.now()})
        await reply(raw, chat_id, fmt.w(link, "bad_code"), link=link)
        return False
    await raw[core.TRIES].delete_many({"chat": chat_id})
    role = await links.role_of(raw, got) or "-"
    await reply(raw, chat_id, fmt.w(got, "linked", name=core.esc(got.get("name") or got["_id"]),
                                   ws=core.esc(links.ws_of(got)), role=role), link=got)
    return True


async def set_lang(raw, link: dict, arg: str) -> None:
    code = (arg or "").strip().lower()[:2]
    if not code:
        await reply(raw, link["chat"], fmt.w(link, "lang_usage"), link=link)
        return
    try:
        link = await links.set_prefs(raw, link["_id"], lang=code) or link
    except ValueError:
        await reply(raw, link["chat"], fmt.w(link, "lang_usage"), link=link)
        return
    await reply(raw, link["chat"], fmt.w(link, "lang_set", lang=core.esc(languages.label(link.get("lang")))),
                link=link)


async def status(raw, link: dict, role: str) -> None:
    from .. import worknow
    with links.acting(link, role):
        now = await worknow.now()
    await reply(raw, link["chat"], fmt.status_text(link, now), link=link, kind="status")


# ---------------- questions ----------------

async def answer(raw, link: dict, role: str, qid: str, text: str, chat_id) -> bool:
    """Answer exactly as the app does (POST /api/questions/{id}/answer), as
    this person via Telegram; then every card of the question is closed."""
    if not links.can(role, "draw"):
        await _refuse(raw, chat_id, link, role, "draw")
        return False
    with links.acting(link, role) as sdb:
        doc = await questions.answer(sdb, qid, text)
    if not doc:
        await reply(raw, chat_id, fmt.w(link, "already"), link=link)
        await notify.sync_questions(raw)
        return False
    await notify.sync_questions(raw)
    await reply(raw, chat_id, fmt.w(link, "thanks_answer", a=core.esc(core.clip(text, 200))), link=link)
    return True


# ---------------- notes ----------------

async def targets(raw, link: dict) -> list[dict]:
    """What a note can be put on: the last one used, then recent models and
    boards."""
    sdb = scope.ScopedDb(raw, links.ws_of(link))
    out: list[dict] = []
    last = link.get("last_target")
    if last:
        out.append({**last, "last": True})
    seen = {(t["kind"], t["id"]) for t in out}
    models = [m async for m in sdb.models.find({}, {"title": 1, "name": 1, "updated_at": 1})
              .sort("updated_at", -1).limit(6)]
    boards = [b async for b in sdb.boards.find({}, {"title": 1, "updated_at": 1})
              .sort("updated_at", -1).limit(4)]
    for kind, rows in (("cad", models), ("pcb", boards)):
        for d in rows:
            if (kind, d["_id"]) in seen:
                continue
            seen.add((kind, d["_id"]))
            out.append({"kind": kind, "id": d["_id"], "title": d.get("title") or d.get("name") or d["_id"]})
    return out[:9]


async def start_note(raw, link: dict, role: str, text: str, photo: str | None) -> None:
    chat_id = link["chat"]
    if not links.can(role, "draw"):
        await _refuse(raw, chat_id, link, role, "draw")
        return
    if not text and not photo:
        await reply(raw, chat_id, fmt.w(link, "note_text_needed"), link=link)
        return
    ts = await targets(raw, link)
    if not ts:
        await reply(raw, chat_id, fmt.w(link, "nothing_targets"), link=link)
        return
    pid = uuid.uuid4().hex[:10]
    await raw[core.PENDING].insert_one({"_id": pid, "at": core.now(), "chat": chat_id, "user": link["_id"],
                                        "kind": "note", "text": text, "photo": photo, "targets": ts})
    rows = []
    for i, t in enumerate(ts):
        icon = "🧊" if t["kind"] == "cad" else "🟩"
        label = fmt.w(link, "last_used", t=t["title"]) if t.get("last") else f"{icon} {t['title']}"
        rows.append([{"text": core.clip(label, 60), "callback_data": f"nt:{pid}:{i}"}])
    rows.append([{"text": fmt.w(link, "cancel"), "callback_data": f"nx:{pid}"}])
    await reply(raw, chat_id, fmt.w(link, "pick_target"), link=link, markup={"inline_keyboard": rows})


def to_png(data: bytes) -> bytes:
    """A photo as the PNG a note's picture is stored as."""
    from PIL import Image
    im = Image.open(io.BytesIO(data))
    im.thumbnail((1600, 1600))
    out = io.BytesIO()
    im.convert("RGB").save(out, "PNG", optimize=True)
    return out.getvalue()


async def download(file_id: str) -> bytes:
    b = await core.bot()
    f = await b.get_file(file_id)
    return bytes(await f.download_as_bytearray())


async def make_note(raw, link: dict, role: str, text: str, photo: str | None, target: dict) -> dict:
    """The note, through the app's own POST /api/revisions."""
    from .. import main
    png = to_png(await download(photo)) if photo else None
    with links.acting(link, role):
        body = main.RevisionIn(comment=(text or fmt.w(link, "photo_note"))[:4000],
                               image_png=base64.b64encode(png).decode() if png else None,
                               model=target["id"], kind=target["kind"])
        out = await main.create_revision(body)
    await raw[core.LINKS].update_one({"_id": link["_id"]}, {"$set": {
        "last_target": {k: target[k] for k in ("kind", "id", "title")}, "last_note": out["id"]}})
    return out


async def queue_last(raw, link: dict, role: str, arg: str = "") -> None:
    chat_id = link["chat"]
    if not links.can(role, "run"):
        await _refuse(raw, chat_id, link, role, "run")
        return
    rid = (arg or "").strip() or link.get("last_note")
    if not rid:
        await reply(raw, chat_id, fmt.w(link, "nothing_to_queue"), link=link)
        return
    from .. import main
    with links.acting(link, role) as sdb:
        doc = await sdb.revisions.find_one({"_id": rid})
        if not doc:
            await reply(raw, chat_id, fmt.w(link, "nothing_to_queue"), link=link)
            return
        if doc.get("status") != "draft":
            await reply(raw, chat_id, fmt.w(link, "not_draft", status=doc.get("status")), link=link)
            return
        await main.set_status(rid, "queued")
    title = await notify._title(scope.ScopedDb(raw, links.ws_of(link)), doc.get("model"), doc.get("kind"))
    await reply(raw, chat_id, fmt.w(link, "queued", t=core.esc(core.clip(doc.get("summary") or doc.get("comment"), 80)
                                                               + (f" · {title}" if title else ""))), link=link)


# ---------------- the agent's thread ----------------

async def start_ask(raw, link: dict, role: str, text: str) -> None:
    chat_id = link["chat"]
    if not links.can(role, "draw"):
        await _refuse(raw, chat_id, link, role, "draw")
        return
    if not text:
        await reply(raw, chat_id, fmt.w(link, "ask_text_needed"), link=link)
        return
    pid = uuid.uuid4().hex[:10]
    await raw[core.PENDING].insert_one({"_id": pid, "at": core.now(), "chat": chat_id, "user": link["_id"],
                                        "kind": "ask", "text": text})
    rooms = ["cad", "pcb"]
    if link.get("last_room") == "pcb":
        rooms.reverse()
    row = [{"text": fmt.w(link, f"room_{r}"), "callback_data": f"ak:{pid}:{r}"} for r in rooms]
    await reply(raw, chat_id, fmt.w(link, "pick_room"), link=link,
                markup={"inline_keyboard": [row, [{"text": fmt.w(link, "cancel"), "callback_data": f"nx:{pid}"}]]})


async def ask_agent(raw, link: dict, role: str, text: str, room: str) -> dict:
    """A line in the room's thread, as POST /api/chat writes it."""
    with links.acting(link, role) as sdb:
        line = await chat.post(sdb, text, room=room)
    await raw[core.LINKS].update_one({"_id": link["_id"]}, {"$set": {"last_room": room}})
    return line


async def ask_what(raw, link: dict, text: str, photo: str | None) -> None:
    pid = uuid.uuid4().hex[:10]
    await raw[core.PENDING].insert_one({"_id": pid, "at": core.now(), "chat": link["chat"], "user": link["_id"],
                                        "kind": "choose", "text": text, "photo": photo})
    row = [{"text": fmt.w(link, "as_note"), "callback_data": f"pm:{pid}:note"}]
    if text:
        row.append({"text": fmt.w(link, "as_ask"), "callback_data": f"pm:{pid}:ask"})
    row.append({"text": fmt.w(link, "ignore"), "callback_data": f"pm:{pid}:ignore"})
    await reply(raw, link["chat"], fmt.w(link, "what_now"), link=link, markup={"inline_keyboard": [row]})


# ---------------- buttons ----------------

async def _ack(cq: dict, text: str | None = None) -> None:
    """Every button press is answered, or the button keeps spinning."""
    try:
        b = await core.bot()
        if b is not None:
            await b.answer_callback_query(cq["id"], text=text)
    except Exception:                                    # noqa: BLE001
        pass


async def _close_buttons(raw, chat_id, message_id, text: str, link: dict | None) -> None:
    """The message the buttons were on, with what was chosen and no buttons."""
    if message_id is not None:
        await outbox.enqueue(raw, chat_id, op="edit", message_id=message_id, text=text, kind="choice",
                             user=(link or {}).get("_id"), ws=(link or {}).get("workspace"))


async def on_callback(raw, cq: dict) -> None:
    msg = cq.get("message") or {}
    chat_id = (msg.get("chat") or {}).get("id") or (cq.get("from") or {}).get("id")
    mid = msg.get("message_id")
    data = cq.get("data") or ""
    link = await links.by_chat(raw, chat_id)
    await core.journal(raw, "in", "button", chat=chat_id, user=(link or {}).get("_id"), preview=data.split(":")[0],
                       workspace=(link or {}).get("workspace"))
    if not link:
        await _ack(cq, "not linked")
        return
    role = await links.role_of(raw, link)
    if not role:
        await _ack(cq)
        await reply(raw, chat_id, fmt.w(link, "no_access"), link=link)
        return
    kind, _, rest = data.partition(":")

    if kind in ("qa", "qs", "qr"):
        await _question_button(raw, link, role, cq, kind, rest, chat_id, mid)
        return
    if kind == "nx":
        await raw[core.PENDING].delete_one({"_id": rest, "user": link["_id"]})
        await _ack(cq)
        await _close_buttons(raw, chat_id, mid, fmt.w(link, "cancelled"), link)
        return

    pid, _, arg = rest.partition(":")
    pending = await raw[core.PENDING].find_one({"_id": pid, "user": link["_id"]})
    if not pending:
        await _ack(cq, fmt.w(link, "expired"))
        return

    if kind == "nt":
        try:
            target = pending["targets"][int(arg)]
        except (ValueError, IndexError, KeyError):
            await _ack(cq, fmt.w(link, "expired"))
            return
        if not links.can(role, "draw"):
            await _ack(cq)
            await _refuse(raw, chat_id, link, role, "draw")
            return
        await raw[core.PENDING].delete_one({"_id": pid})
        await _ack(cq)
        out = await make_note(raw, link, role, pending.get("text") or "", pending.get("photo"), target)
        base = (await core.settings(raw)).get("public_url")
        url = fmt.app_link(base, model=target["id"], kind=target["kind"], rev=out["id"])
        done = fmt.w(link, "note_saved", t=core.esc(target["title"]))
        if url:
            done += f'\n<a href="{core.esc(url)}">{core.esc(fmt.w(link, "open"))}</a>'
        await _close_buttons(raw, chat_id, mid, done, link)
        return

    if kind == "ak":
        if arg not in chat.ROOMS:
            await _ack(cq)
            return
        if not links.can(role, "draw"):
            await _ack(cq)
            await _refuse(raw, chat_id, link, role, "draw")
            return
        await raw[core.PENDING].delete_one({"_id": pid})
        await _ack(cq)
        await ask_agent(raw, link, role, pending["text"], arg)
        base = (await core.settings(raw)).get("public_url")
        url = fmt.app_link(base, thread=arg)
        await _close_buttons(raw, chat_id, mid, fmt.w(link, "asked", room=fmt.w(link, f"room_{arg}"))
                             + (f"\n{fmt._a(url, fmt.w(link, 'open'))}" if url else ""), link)
        return

    if kind == "pm":
        await raw[core.PENDING].delete_one({"_id": pid})
        await _ack(cq)
        if arg == "note":
            await _close_buttons(raw, chat_id, mid, fmt.w(link, "as_note"), link)
            await start_note(raw, link, role, pending.get("text") or "", pending.get("photo"))
        elif arg == "ask" and pending.get("text"):
            await _close_buttons(raw, chat_id, mid, fmt.w(link, "as_ask"), link)
            await start_ask(raw, link, role, pending["text"])
        else:
            await _close_buttons(raw, chat_id, mid, fmt.w(link, "ignored"), link)
        return
    await _ack(cq)


async def _question_button(raw, link, role, cq, kind, rest, chat_id, mid) -> None:
    qid, _, idx = rest.partition(":")
    ws = links.ws_of(link)
    q = await scope.ScopedDb(raw, ws).questions.find_one({"_id": qid})
    if not q or q.get("status") != questions.OPEN:
        await _ack(cq, fmt.w(link, "already"))
        await notify.sync_questions(raw)
        return
    if not links.can(role, "draw"):
        await _ack(cq)
        await _refuse(raw, chat_id, link, role, "draw")
        return
    card = await raw[core.MSGS].find_one({"chat": chat_id, "message_id": mid, "kind": "question"}) or {}
    if kind == "qr":
        await _ack(cq)
        await reply(raw, chat_id, fmt.w(link, "your_answer", q=core.esc(core.clip(q.get("text"), 300))), link=link,
                    markup={"force_reply": True, "input_field_placeholder": fmt.w(link, "type_answer")[:64]},
                    kind="prompt", track={"kind": "prompt", "question": qid})
        return
    opts = q.get("options") or []
    if kind == "qa":
        try:
            i = int(idx)
            opts[i]
        except (ValueError, IndexError):
            await _ack(cq)
            return
        if not q.get("multi"):
            await _ack(cq, "✓")
            # The option as the agent wrote it: the answer goes to the agent.
            await answer(raw, link, role, qid, opts[i], chat_id)
            return
        picked = list(card.get("picked") or [])
        picked = [p for p in picked if p != i] if i in picked else picked + [i]
        if card:
            await raw[core.MSGS].update_one({"_id": card["_id"]}, {"$set": {"picked": picked}})
        await _ack(cq)
        shown = {"options": card.get("options") or opts}
        await outbox.enqueue(raw, chat_id, op="markup", message_id=mid, text="", kind="question-pick",
                             user=link["_id"], ws=ws,
                             markup=fmt.question_markup(link, {"_id": qid, "multi": True}, shown, picked))
        return
    if kind == "qs":
        picked = sorted(card.get("picked") or [])
        if not picked:
            await _ack(cq, "–")
            return
        await _ack(cq, "✓")
        await answer(raw, link, role, qid, ", ".join(opts[i] for i in picked if i < len(opts)), chat_id)
