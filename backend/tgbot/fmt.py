"""What the bot says: the notifications, the question cards, the replies.

Short, HTML-formatted (parse_mode=HTML: only <b> <i> <code> <a> are used,
and everything that came from a person or an agent is escaped), with a link
back to the right place in the app when the server's public address is
known. The bot's own words come in English or Turkish - the person's
question language decides, Turkish if they read questions in Turkish.
"""

from __future__ import annotations

from urllib.parse import quote

from . import core

# The bot's own words. A key missing in a language falls back to English.
WORDS = {
    "en": {
        "open": "Open in Redline",
        "asking": "Agent is asking",
        "own_words": "✍️ Reply in your own words",
        "send_picked": "Send ✓",
        "viewer_cant": "You can read this, but as {role} you cannot answer it.",
        "answered": "Answered",
        "answered_by": "by {who}",
        "via_tg": "via Telegram",
        "in_app": "in the app",
        "withdrawn": "Withdrawn - the agent stopped waiting.",
        "your_answer": "Your answer to: {q}",
        "type_answer": "Type your answer…",
        "thanks_answer": "✅ Answer sent: {a}",
        "already": "That question was already answered or withdrawn.",
        "not_linked": "This chat is not linked to Redline. Open Settings → Telegram in Redline and press <b>Link my Telegram</b>.",
        "too_many": "Too many wrong codes. Wait {m} minutes, then make a new code in Redline → Settings → Telegram.",
        "bad_code": "That link code is unknown or older than 10 minutes. Make a new one in Redline → Settings → Telegram.",
        "linked": "✅ Linked. This chat is now <b>{name}</b> in Redline ({ws}, {role}).\nYou will hear about agents' questions and applied notes here. /help lists what you can do.",
        "stopped": "Unlinked. This chat is no longer connected to Redline. Link it again any time from Settings → Telegram.",
        "no_access": "Your Redline account is disabled or no longer there, so the bot cannot act for you. Ask an admin, then link again.",
        "role_cant": "As {role} you cannot {what} - ask someone who is {who} or above.",
        "pick_target": "Which model or board is the note for?",
        "last_used": "↺ {t}",
        "cancel": "✕ Cancel",
        "cancelled": "Cancelled.",
        "nothing_targets": "You have no models or boards to put a note on.",
        "note_saved": "📝 Draft note saved on <b>{t}</b>.\nSend /queue to queue it for the agent.",
        "note_text_needed": "Write it as <code>/note what to change</code>, or send a photo with a caption.",
        "queued": "▶️ Queued: <b>{t}</b>. The agent picks it up from the queue.",
        "nothing_to_queue": "No draft note from Telegram to queue. Make one with /note first.",
        "not_draft": "That note is {status} already, not a draft.",
        "pick_room": "Which room's agent should read it?",
        "room_cad": "3D room",
        "room_pcb": "Board room",
        "asked": "💬 Sent to the agent in the {room}.",
        "ask_text_needed": "Write it as <code>/ask your message</code>.",
        "what_now": "What should I do with this?",
        "as_note": "📝 Make it a note",
        "as_ask": "💬 Ask the agent",
        "ignore": "✕ Ignore",
        "ignored": "Ignored.",
        "expired": "That has expired - send it again.",
        "status_head": "<b>Working now</b>",
        "status_idle": "Nothing is running.",
        "status_recent": "<b>Finished lately</b>",
        "lang_set": "Questions will come in {lang}.",
        "lang_usage": "Use <code>/lang tr</code>, <code>/lang de</code> … or <code>/lang en</code> for the original English.",
        "help": (
            "<b>Redline bot</b>\n"
            "/note <i>text</i> - a draft note on a model or board (a photo with a caption works too)\n"
            "/queue - queue the last draft note you made here\n"
            "/ask <i>text</i> - write to the agent's thread in a room\n"
            "/status - what is working now\n"
            "/lang <i>code</i> - the language questions come in\n"
            "/stop - unlink this chat\n"
            "/help - this list\n\n"
            "Anything else you send, I will ask whether it is a note or for the agent. "
            "When an agent asks a question, answer with the buttons, or reply in your own words."),
        "test": "👋 <b>Test from Redline</b>\nThe bot can reach you. This is what notifications look like.",
        "photo_note": "Photo from Telegram",
    },
    "tr": {
        "open": "Redline'da aç",
        "asking": "Ajan soruyor",
        "own_words": "✍️ Kendi sözlerinle yanıtla",
        "send_picked": "Gönder ✓",
        "viewer_cant": "Bunu okuyabilirsin, ama {role} olarak yanıtlayamazsın.",
        "answered": "Yanıtlandı",
        "answered_by": "{who} tarafından",
        "via_tg": "Telegram'dan",
        "in_app": "uygulamadan",
        "withdrawn": "Geri çekildi - ajan beklemeyi bıraktı.",
        "your_answer": "Yanıtın: {q}",
        "type_answer": "Yanıtını yaz…",
        "thanks_answer": "✅ Yanıt gönderildi: {a}",
        "already": "Bu soru zaten yanıtlanmış ya da geri çekilmiş.",
        "not_linked": "Bu sohbet Redline'a bağlı değil. Redline'da Ayarlar → Telegram'ı aç ve <b>Telegram'ımı bağla</b>'ya bas.",
        "too_many": "Çok fazla yanlış kod. {m} dakika bekle, sonra Redline → Ayarlar → Telegram'dan yeni kod al.",
        "bad_code": "Bu bağlantı kodu bilinmiyor ya da 10 dakikadan eski. Redline → Ayarlar → Telegram'dan yenisini al.",
        "linked": "✅ Bağlandı. Bu sohbet artık Redline'da <b>{name}</b> ({ws}, {role}).\nAjanların soruları ve uygulanan notlar buraya gelecek. /help yapabileceklerini listeler.",
        "stopped": "Bağlantı kaldırıldı. Bu sohbet artık Redline'a bağlı değil. İstediğin zaman Ayarlar → Telegram'dan yeniden bağlayabilirsin.",
        "no_access": "Redline hesabın devre dışı ya da artık yok, bot senin adına iş yapamaz. Bir yöneticiye sor, sonra yeniden bağla.",
        "role_cant": "{role} olarak {what} yapamazsın - {who} ya da üstü birine sor.",
        "pick_target": "Not hangi model ya da kart için?",
        "cancel": "✕ Vazgeç",
        "cancelled": "Vazgeçildi.",
        "nothing_targets": "Not eklenecek model ya da kartın yok.",
        "note_saved": "📝 Taslak not <b>{t}</b> üzerine kaydedildi.\nAjan için sıraya almak için /queue gönder.",
        "note_text_needed": "<code>/note ne değişsin</code> diye yaz ya da açıklamalı bir fotoğraf gönder.",
        "queued": "▶️ Sıraya alındı: <b>{t}</b>. Ajan sıradan alacak.",
        "nothing_to_queue": "Telegram'dan sıraya alınacak taslak not yok. Önce /note ile bir tane yap.",
        "not_draft": "Bu not zaten {status}, taslak değil.",
        "pick_room": "Hangi odanın ajanı okusun?",
        "room_cad": "3D oda",
        "room_pcb": "Kart odası",
        "asked": "💬 {room} ajanına gönderildi.",
        "ask_text_needed": "<code>/ask mesajın</code> diye yaz.",
        "what_now": "Bununla ne yapayım?",
        "as_note": "📝 Not yap",
        "as_ask": "💬 Ajana sor",
        "ignore": "✕ Yok say",
        "ignored": "Yok sayıldı.",
        "expired": "Süresi doldu - yeniden gönder.",
        "status_head": "<b>Şu an çalışanlar</b>",
        "status_idle": "Çalışan bir şey yok.",
        "status_recent": "<b>Az önce bitenler</b>",
        "lang_set": "Sorular {lang} gelecek.",
        "test": "👋 <b>Redline'dan test</b>\nBot sana ulaşabiliyor. Bildirimler böyle görünür.",
        "photo_note": "Telegram'dan fotoğraf",
    },
}


def ui_lang(link: dict | None) -> str:
    lang = (link or {}).get("lang")
    if lang in WORDS:
        return lang
    tg = ((link or {}).get("tg") or {}).get("language_code") or ""
    return "tr" if not lang and tg.startswith("tr") else "en"


def w(link: dict | None, key: str, **kw) -> str:
    lang = ui_lang(link)
    text = WORDS.get(lang, {}).get(key) or WORDS["en"].get(key) or key
    return text.format(**kw) if kw else text


# ---------------- links back to the app ----------------

def app_link(base: str | None, *, model: str | None = None, kind: str | None = None,
             rev: str | None = None, ws: str | None = None, thread: str | None = None) -> str | None:
    """A deep link into the app: a note on its model or board, a room, or a
    room's agent thread (pinned in the Chat tab, whose id is still
    "commandcode")."""
    if not base:
        return None
    base = base.rstrip("/")
    if thread:
        return f"{base}/?ws=commandcode&thread={quote(thread)}"
    if kind == "pcb" and model:
        return f"{base}/?ws=pcb&board={quote(model)}"
    if model:
        return f"{base}/?model={quote(model)}" + (f"&rev={quote(rev)}" if rev else "")
    if rev:
        return f"{base}/?ws=notes&rev={quote(rev)}"
    return f"{base}/" + (f"?ws={quote(ws)}" if ws else "")


def _a(url: str | None, label: str) -> str:
    return f'<a href="{core.esc(url)}">{core.esc(label)}</a>' if url else ""


def _by(who: dict | None) -> str:
    return core.esc((who or {}).get("name") or (who or {}).get("id") or "")


# ---------------- notifications ----------------

def note_event(link: dict | None, rev: dict, ok: bool, base: str | None, title: str | None = None) -> str:
    what = "✅ <b>Note applied</b>" if ok else "⚠️ <b>Note failed</b>"
    if ui_lang(link) == "tr":
        what = "✅ <b>Not uygulandı</b>" if ok else "⚠️ <b>Not başarısız</b>"
    on = title or rev.get("model")
    head = what + (f" · {core.esc(on)}" if on else "")
    body = core.esc(core.clip(rev.get("summary") or rev.get("comment"), 600))
    by = rev.get("status_by") or rev.get("created_by")
    url = app_link(base, model=rev.get("model"), kind=rev.get("kind"), rev=rev.get("_id"))
    tail = " · ".join(x for x in [f"<i>{_by(by)}</i>" if by else "", _a(url, w(link, "open"))] if x)
    return "\n".join(x for x in [head, body, tail] if x)


def run_event(link: dict | None, run: dict, base: str | None) -> str:
    head = "▶️ <b>Run started</b>" if ui_lang(link) != "tr" else "▶️ <b>Çalışma başladı</b>"
    room = "board room" if run.get("room") == "pcb" else "3D room"
    who = _by(run.get("by"))
    url = app_link(base, model=run.get("model"), rev=run.get("revision"),
                   kind="pcb" if run.get("room") == "pcb" else None)
    lines = [head + f" · {core.esc(core.clip(run.get('title'), 200))}",
             " · ".join(x for x in [room, f"<i>{who}</i>" if who else "", _a(url, w(link, "open"))] if x)]
    return "\n".join(lines)


def budget_event(link: dict | None, alert: dict, text: str | None, base: str | None) -> str:
    level = alert.get("level")
    icon = "🛑" if level == "over" else "💸"
    body = core.esc(text or f"{alert.get('kind')} budget at {round((alert.get('ratio') or 0) * 100)}%")
    url = app_link(base, ws="settings")
    return f"{icon} <b>Budget</b>\n{body}" + (f"\n{_a(url, w(link, 'open'))}" if url else "")


def build_event(link: dict | None, job: dict, base: str | None) -> str:
    what = job.get("model") or job.get("board") or "?"
    kind = job.get("kind") or "build"
    secs = job.get("wall_s")
    detail = f"{kind}, exit {job.get('rc')}" + (f", {secs:.0f} s" if isinstance(secs, (int, float)) else "")
    url = app_link(base, model=job.get("model") or job.get("board"),
                   kind="pcb" if job.get("board") and not job.get("model") else None)
    head = "🛠 <b>Build failed</b>" if ui_lang(link) != "tr" else "🛠 <b>Derleme başarısız</b>"
    return f"{head} · {core.esc(what)}\n{core.esc(detail)}" + (f"\n{_a(url, w(link, 'open'))}" if url else "")


def digest_text(link: dict | None, d: dict, base: str | None) -> str:
    rows = [("Notes applied (24 h)", d.get("applied", 0)), ("Notes failed (24 h)", d.get("failed", 0)),
            ("Queued now", d.get("queued", 0)), ("Drafts", d.get("drafts", 0)),
            ("Open questions", d.get("questions", 0)), ("Builds failed (24 h)", d.get("builds_failed", 0))]
    body = "\n".join(f"• {core.esc(k)}: <b>{v}</b>" for k, v in rows)
    url = app_link(base, ws="notes")
    return "📋 <b>Daily digest</b>\n" + body + (f"\n{_a(url, w(link, 'open'))}" if url else "")


# ---------------- questions ----------------

OPT_LABEL = 60


def question_text(link: dict | None, q: dict, shown: dict | None, base: str | None,
                  can_answer: bool, role: str | None = None) -> str:
    """The card. `shown` is the question in the reader's language
    ({text, context, options}) or None for the original."""
    s = shown or q
    lines = [f"❓ <b>{core.esc(w(link, 'asking'))}</b>", core.esc(core.clip(s.get("text"), 1500))]
    if s.get("context"):
        lines.append(f"<i>{core.esc(core.clip(s.get('context'), 1200))}</i>")
    opts = s.get("options") or []
    if opts and any(len(o) > OPT_LABEL for o in opts):
        # The buttons are short; the options in full are in the message.
        lines.append("\n".join(f"{i + 1}. {core.esc(core.clip(o, 400))}" for i, o in enumerate(opts)))
    if not can_answer:
        lines.append(f"<i>{core.esc(w(link, 'viewer_cant', role=role or 'viewer'))}</i>")
    # The question waits in its room's thread in the Chat tab too.
    url = app_link(base, thread=q.get("room") or "cad")
    if url:
        lines.append(_a(url, w(link, "open")))
    return "\n\n".join(x for x in lines if x)


def question_markup(link: dict | None, q: dict, shown: dict | None, picked: list[int] | None = None) -> dict:
    s = shown or q
    opts = s.get("options") or []
    picked = picked or []
    rows = []
    long_ = any(len(o) > OPT_LABEL for o in opts)
    for i, o in enumerate(opts[:12]):
        label = f"{i + 1}. {core.clip(o, OPT_LABEL - 4)}" if long_ else core.clip(o, OPT_LABEL)
        if q.get("multi"):
            label = ("☑ " if i in picked else "☐ ") + label
        rows.append([{"text": label, "callback_data": f"qa:{q['_id']}:{i}"}])
    if q.get("multi") and opts:
        rows.append([{"text": w(link, "send_picked"), "callback_data": f"qs:{q['_id']}"}])
    rows.append([{"text": w(link, "own_words"), "callback_data": f"qr:{q['_id']}"}])
    return {"inline_keyboard": rows}


def question_closed(link: dict | None, sent_text: str, q: dict) -> str:
    """The card once it is over: what was sent, and the answer under it."""
    if q.get("status") == "answered":
        who = q.get("answered_by") or {}
        via = w(link, "via_tg") if who.get("via") == "telegram" else w(link, "in_app")
        by = w(link, "answered_by", who=_by(who) or "?")
        tail = (f"✅ <b>{core.esc(w(link, 'answered'))}</b> {by} {via}:\n"
                f"<i>{core.esc(core.clip(q.get('answer'), 600))}</i>")
    else:
        tail = f"⏹ <i>{core.esc(w(link, 'withdrawn'))}</i>"
    return f"{sent_text}\n\n{tail}"


def status_text(link: dict | None, now: dict) -> str:
    items = now.get("items") or []
    recent = now.get("recent") or []
    lines = [w(link, "status_head")]
    if not items:
        lines.append(w(link, "status_idle"))
    for it in items[:10]:
        pct = f" {it['percent']:.0f}%" if isinstance(it.get("percent"), (int, float)) else ""
        secs = f" · {int(it['secs'])} s" if isinstance(it.get("secs"), (int, float)) else ""
        lines.append(f"• {core.esc(it.get('kind'))} <b>{core.esc(core.clip(it.get('title'), 80))}</b> "
                     f"- {core.esc(it.get('state'))}{pct}{secs}")
    if recent:
        lines.append("")
        lines.append(w(link, "status_recent"))
        for r in recent[:5]:
            mark = "✓" if r.get("ok") else "✕"
            lines.append(f"{mark} {core.esc(r.get('kind'))} {core.esc(r.get('id'))}")
    return "\n".join(lines)
