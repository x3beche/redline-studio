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
             rev: str | None = None, ws: str | None = None, thread: str | None = None,
             chat: str | None = None, fw: str | None = None) -> str | None:
    """A deep link into the app: a note on its model or board, a room, a
    room's agent thread or a Command Code conversation (both in the Chat
    tab, whose id is still "commandcode"), or a firmware."""
    if not base:
        return None
    base = base.rstrip("/")
    if thread:
        return f"{base}/?ws=commandcode&thread={quote(thread)}"
    if chat:
        return f"{base}/?ws=commandcode&chat={quote(chat)}"
    if fw:
        return f"{base}/?ws=firmware&fw={quote(fw)}"
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


def _num_short(v) -> str:
    if not isinstance(v, (int, float)):
        return "?"
    return f"{v:,.0f}" if abs(v) >= 100 else f"{v:,.2f}".rstrip("0").rstrip(".")


def cc_usage_event(link: dict | None, alert: dict, base: str | None) -> str:
    """Command Code's weekly window at 90%, or used up - with when it resets
    (Istanbul time, as the digest)."""
    from datetime import datetime, timedelta, timezone
    tr = ui_lang(link) == "tr"
    used, cap, pct = alert.get("used"), alert.get("cap"), alert.get("pct")
    if pct is None and isinstance(used, (int, float)) and isinstance(cap, (int, float)) and cap:
        pct = 100 * used / cap
    pct_s = f"{round(pct)}%" if isinstance(pct, (int, float)) else "?"
    of = f"{_num_short(used)} / {_num_short(cap)}"
    reset = alert.get("reset_at")
    when = None
    if isinstance(reset, (int, float)) and reset > 0:
        d = datetime.fromtimestamp(reset / 1000, timezone(timedelta(hours=3)))
        when = d.strftime("%d.%m %H:%M")
    if alert.get("level") == "exceeded":
        head = "🛑 <b>Command Code</b>"
        body = (f"Haftalık kullanım penceresi doldu ({of})." if tr
                else f"The weekly usage window is used up ({of}).")
    else:
        head = "⚠️ <b>Command Code</b>"
        body = (f"Haftalık kullanım penceresi %{pct_s.rstrip('%')} dolu ({of})." if tr
                else f"The weekly usage window is at {pct_s} ({of}).")
    if when:
        body += (f" Sıfırlanma: {when} (İstanbul)." if tr else f" Resets {when} (Istanbul).")
    if alert.get("plan"):
        body += f"\n{core.esc(alert['plan'])}"
    url = app_link(base, ws="settings")
    return f"{head}\n{body}" + (f"\n{_a(url, w(link, 'open'))}" if url else "")


def build_event(link: dict | None, job: dict, base: str | None) -> str:
    what = job.get("model") or job.get("board") or "?"
    kind = job.get("kind") or "build"
    secs = job.get("wall_s")
    detail = f"{kind}, exit {job.get('rc')}" + (f", {secs:.0f} s" if isinstance(secs, (int, float)) else "")
    url = app_link(base, model=job.get("model") or job.get("board"),
                   kind="pcb" if job.get("board") and not job.get("model") else None)
    head = "🛠 <b>Build failed</b>" if ui_lang(link) != "tr" else "🛠 <b>Derleme başarısız</b>"
    return f"{head} · {core.esc(what)}\n{core.esc(detail)}" + (f"\n{_a(url, w(link, 'open'))}" if url else "")


def digest_text(link: dict | None, d: dict, base: str | None, every: str = "day") -> str:
    """The digest: a day's figures, or a week's (`every`)."""
    tr = ui_lang(link) == "tr"
    span = ("7 g" if tr else "7 d") if every == "week" else ("24 sa" if tr else "24 h")
    rows = ([("Uygulanan notlar", d.get("applied", 0)), ("Başarısız notlar", d.get("failed", 0)),
             ("Sırada", d.get("queued", 0)), ("Taslaklar", d.get("drafts", 0)),
             ("Açık sorular", d.get("questions", 0)), ("Ajan yanıtları", d.get("replies", 0)),
             ("Derlemeler: biten / başarısız", f"{d.get('builds_ok', 0)} / {d.get('builds_failed', 0)}"),
             ("Firmware: biten / başarısız", f"{d.get('fw_ok', 0)} / {d.get('fw_failed', 0)}"),
             ("Yönlendirilen kartlar", d.get("routes", 0)), ("Sürümler", d.get("releases", 0))] if tr else
            [("Notes applied", d.get("applied", 0)), ("Notes failed", d.get("failed", 0)),
             ("Queued now", d.get("queued", 0)), ("Drafts", d.get("drafts", 0)),
             ("Open questions", d.get("questions", 0)), ("Agent replies", d.get("replies", 0)),
             ("Builds done / failed", f"{d.get('builds_ok', 0)} / {d.get('builds_failed', 0)}"),
             ("Firmware done / failed", f"{d.get('fw_ok', 0)} / {d.get('fw_failed', 0)}"),
             ("Boards routed", d.get("routes", 0)), ("Releases", d.get("releases", 0))])
    body = "\n".join(f"• {core.esc(k)}: <b>{v}</b>" for k, v in rows)
    if tr:
        head = "📋 <b>Haftalık özet</b>" if every == "week" else "📋 <b>Günlük özet</b>"
    else:
        head = "📋 <b>Weekly digest</b>" if every == "week" else "📋 <b>Daily digest</b>"
    url = app_link(base, ws="notes")
    return f"{head} · {span}\n" + body + (f"\n{_a(url, w(link, 'open'))}" if url else "")


# ---------------- what was made: replies, routes, builds, releases, parts ----------------

ROOMS = {"cad": ("3D room", "3D oda"), "pcb": ("Board room", "Kart odası"),
         "firmware": ("Firmware room", "Firmware odası")}


def _tail(*parts: str) -> str:
    return " · ".join(x for x in parts if x)


def dur(secs, tr: bool = False) -> str:
    """45 s, 3 min 20 s, 1 h 05 min - Turkish: sn, dk, sa."""
    if not isinstance(secs, (int, float)):
        return ""
    s = int(round(secs))
    u_s, u_m, u_h = ("sn", "dk", "sa") if tr else ("s", "min", "h")
    if s < 60:
        return f"{s} {u_s}"
    if s < 3600:
        return f"{s // 60} {u_m}" + (f" {s % 60} {u_s}" if s % 60 else "")
    return f"{s // 3600} {u_h} {s % 3600 // 60:02d} {u_m}"


def _size(n) -> str:
    if not isinstance(n, (int, float)):
        return ""
    return f"{n / 1048576:.1f} MB" if n >= 1048576 else f"{max(1, round(n / 1024))} KB"


def reply_event(link: dict | None, room: str, text: str | None, base: str | None, *,
                title: str | None = None, chat: str | None = None, error: str | None = None,
                more: int = 0) -> str:
    """A room's agent wrote in its thread (`room` cad, pcb or firmware), or a
    Command Code conversation was answered (`chat`) - or its answer failed.
    `more`: the agent's other lines since the last look, not shown."""
    tr = ui_lang(link) == "tr"
    if chat:
        if error:
            head = "⚠️ <b>Command Code yanıtı başarısız</b>" if tr else "⚠️ <b>Command Code answer failed</b>"
        else:
            head = "💬 <b>Command Code yanıtladı</b>" if tr else "💬 <b>Command Code answered</b>"
        url = app_link(base, chat=chat)
    else:
        name = ROOMS.get(room, ROOMS["cad"])[1 if tr else 0]
        head = f"💬 <b>{core.esc(name)} ajanı yanıtladı</b>" if tr else f"💬 <b>{core.esc(name)} agent replied</b>"
        url = app_link(base, thread=room)
    if title:
        head += f" · {core.esc(core.clip(title, 120))}"
    lines = [head]
    if error:
        lines.append(f"<i>{core.esc(core.clip(error, 300))}</i>")
    if text:
        lines.append(core.esc(core.clip(text, 300)))
    extra = (f"+{more} satır daha" if tr else f"+{more} more line{'s' if more > 1 else ''}") if more else ""
    lines.append(_tail(extra, _a(url, w(link, "open"))))
    return "\n".join(x for x in lines if x)


def route_event(link: dict | None, board: str, title: str | None, route: dict, drc: dict | None,
                erc: dict | None, base: str | None) -> str:
    """A board was routed: by which engine, all connected or how many not,
    vias, how long, and DRC (and ERC when the schematic has one)."""
    tr = ui_lang(link) == "tr"
    left = route.get("unrouted")
    done = isinstance(left, int) and left == 0
    if done:
        head = "🧭 <b>Kart yönlendirildi</b>" if tr else "🧭 <b>Board routed</b>"
    else:
        head = "🧭 <b>Yönlendirme bitti</b>" if tr else "🧭 <b>Routing finished</b>"
    head += f" · {core.esc(title or board)}"
    engine = {"tracemaker": "TraceMaker", "freerouting": "Freerouting"}.get(route.get("engine"),
                                                                             route.get("engine") or "")
    if done:
        state = "hepsi bağlı" if tr else "all connected"
    elif isinstance(left, int):
        state = f"{left} bağlantı açık" if tr else f"{left} unrouted"
    else:
        state = ""
    vias = f"{route['vias']} via" + ("" if tr or route["vias"] == 1 else "s") \
        if isinstance(route.get("vias"), int) else ""
    lines = [head, core.esc(_tail(engine, state, vias, dur(route.get("route_s"), tr)))]
    checks = []
    for name, rep in (("DRC", drc), ("ERC", erc)):
        if not rep or rep.get("error_count") is None:
            continue
        e, wn = rep.get("error_count") or 0, rep.get("warning_count") or 0
        if not e and not wn:
            checks.append(f"{name} {'temiz' if tr else 'clean'}")
        else:
            checks.append(f"{name} {e} {'hata' if tr else 'error' + ('' if e == 1 else 's')}, "
                          f"{wn} {'uyarı' if tr else 'warning' + ('' if wn == 1 else 's')}")
    if checks:
        lines.append(core.esc(" · ".join(checks)))
    url = app_link(base, model=board, kind="pcb")
    if url:
        lines.append(_a(url, w(link, "open")))
    return "\n".join(x for x in lines if x)


JOB_KINDS = {"build": ("build", "derleme"), "layout": ("layout", "yerleşim"),
             "convert": ("convert", "dönüştürme"), "board": ("board build", "kart derlemesi"),
             "run": ("run", "çalışma")}


def longbuild_event(link: dict | None, job: dict, base: str | None, title: str | None = None) -> str:
    """A build, layout or convert that took long enough to walk away from is
    done, well."""
    tr = ui_lang(link) == "tr"
    what = job.get("model") or job.get("board") or "?"
    kind = JOB_KINDS.get(job.get("kind") or "build", (job.get("kind"), job.get("kind")))[1 if tr else 0]
    head = ("⏱ <b>Bitti</b>" if tr else "⏱ <b>Done</b>") + f" · {core.esc(title or what)}"
    pcb = job.get("kind") in ("layout", "board")
    url = app_link(base, model=what, kind="pcb" if pcb else None)
    return "\n".join(x for x in [head, core.esc(_tail(kind, dur(job.get("wall_s"), tr))),
                                  _a(url, w(link, "open"))] if x)


def firmware_event(link: dict | None, job: dict, base: str | None) -> str:
    """A firmware build ended: flash and RAM used, or the first error."""
    tr = ui_lang(link) == "tr"
    res = job.get("result") or {}
    ok = job.get("status") == "done" and res.get("ok")
    if ok:
        head = "🔌 <b>Firmware derlendi</b>" if tr else "🔌 <b>Firmware built</b>"
    else:
        head = "⚠️ <b>Firmware derlenemedi</b>" if tr else "⚠️ <b>Firmware build failed</b>"
    head += f" · {core.esc(job.get('title') or job.get('firmware') or '?')}"
    secs = dur(job.get("seconds"), tr)
    warn = res.get("warning_count") or 0
    warns = (f"{warn} uyarı" if tr else f"{warn} warning{'' if warn == 1 else 's'}") if warn else ""
    if ok:
        fl, ram = res.get("flash") or {}, res.get("ram") or {}
        line = _tail(f"flash {fl['pct']:g}%" if isinstance(fl.get("pct"), (int, float)) else "",
                     f"RAM {ram['pct']:g}%" if isinstance(ram.get("pct"), (int, float)) else "", warns, secs)
        lines = [head, core.esc(line)]
    else:
        n = res.get("error_count") or 0
        errs = (f"{n} hata" if tr else f"{n} error{'' if n == 1 else 's'}") if n else ""
        first = (res.get("errors") or [{}])[0]
        where = f"{first.get('file')}:{first['line']}" if first.get("line") else first.get("file") or ""
        why = f"{where} {first.get('text') or ''}".strip() or job.get("detail") or ""
        lines = [head, core.esc(_tail(errs, warns, secs)),
                 f"<code>{core.esc(core.clip(why, 300))}</code>" if why else ""]
    url = app_link(base, fw=job.get("firmware"))
    lines.append(_a(url, w(link, "open")))
    return "\n".join(x for x in lines if x)


def release_event(link: dict | None, rel: dict, base: str | None, rid: str | None = None) -> str:
    """A release is ready - its size, what could not be made, a download
    link - or it failed, with the last line of its log."""
    tr = ui_lang(link) == "tr"
    rid = rid or rel.get("_id")
    name = f"{rel.get('project')} {rel.get('tag')}"
    if rel.get("status") == "ready":
        head = ("📦 <b>Sürüm hazır</b>" if tr else "📦 <b>Release ready</b>") + f" · {core.esc(name)}"
        n = len(rel.get("files") or [])
        files = (f"{n} dosya" if tr else f"{n} files") if n else ""
        lines = [head, core.esc(_tail(_size(rel.get("bytes")), files, dur(rel.get("took_s"), tr)))]
        problems = rel.get("problems") or []
        if problems:
            shown = "; ".join(core.clip(p, 120) for p in problems[:3])
            more = f" (+{len(problems) - 3})" if len(problems) > 3 else ""
            lines.append(("Yapılamayanlar: " if tr else "Could not make: ") + core.esc(shown + more))
        dl = f"{base.rstrip('/')}/api/releases/{quote(str(rid))}/download" if base else None
        lines.append(_tail(_a(dl, "İndir" if tr else "Download"), _a(app_link(base), w(link, "open"))))
    else:
        head = ("⚠️ <b>Sürüm yapılamadı</b>" if tr else "⚠️ <b>Release failed</b>") + f" · {core.esc(name)}"
        last = next((ln for ln in reversed(rel.get("log") or []) if ln), "")
        lines = [head, f"<i>{core.esc(core.clip(last, 300))}</i>" if last else "", _a(app_link(base), w(link, "open"))]
    return "\n".join(x for x in lines if x)


def body_event(link: dict | None, what: str, part: str, base: str | None, *, name: str | None = None,
               model: str | None = None, board: str | None = None, ref: str | None = None) -> str:
    """A part's drawn body: asked of the 3D room (`what` "asked"), or bound
    to the part ("bound")."""
    tr = ui_lang(link) == "tr"
    if what == "asked":
        head = "🧩 <b>Gövde istendi</b>" if tr else "🧩 <b>Body asked for</b>"
        for_ = (f"{board} {ref} için" if tr else f"for {board} {ref}") if board else ""
        body = _tail(for_, f"→ {model}" if model else "")
    else:
        head = "🧩 <b>Gövde hazır</b>" if tr else "🧩 <b>Body bound</b>"
        body = model or ""
    head += f" · {core.esc(part)}" + (f" “{core.esc(name)}”" if name else "")
    url = app_link(base, model=model) if model else app_link(base, ws="pcb")
    return "\n".join(x for x in [head, core.esc(body), _a(url, w(link, "open"))] if x)


def library_event(link: dict | None, part: dict, base: str | None, pid: str | None = None) -> str:
    tr = ui_lang(link) == "tr"
    head = ("📚 <b>Çekmeceye parça geldi</b>" if tr else "📚 <b>Part in the drawer</b>") + \
        f" · {core.esc(pid or part.get('_id'))}"
    has_3d = bool(part.get("artifacts") or part.get("model_step"))
    what = ("footprint, sembol" + (", 3D model" if has_3d else "") if tr
            else "footprint, symbol" + (" and 3D model" if has_3d else ""))
    return "\n".join(x for x in [head, core.esc(_tail(part.get("name") or "", what)),
                                  _a(app_link(base, ws="pcb"), w(link, "open"))] if x)


def health_event(link: dict | None, what: str, d: dict, base: str | None) -> str:
    """The server's own trouble, for its owner and admins: `what` is disk,
    llm, pages or crash. `d` carries the figures, and what went wrong in
    its own words (`detail`) when there is one. A crash: the signal it died
    on if it never got through, and whether it was run again."""
    tr = ui_lang(link) == "tr"
    if what == "disk":
        text = (f"Disk %{d['pct']} dolu - {d['free_gb']:.0f} GB boş kaldı ({d['path']})." if tr else
                f"The disk is {d['pct']}% full - {d['free_gb']:.0f} GB left ({d['path']}).")
    elif what == "llm":
        text = (f"{d['provider']}: son {d['minutes']} dakikada {d['n']} çağrı başarısız." if tr else
                f"{d['provider']}: {d['n']} calls failed in the last {d['minutes']} minutes.")
    elif what == "pages":
        text = (f"Son {d['minutes']} dakikada tarayıcılardan {d['n']} hata geldi." if tr else
                f"{d['n']} errors came from browsers in the last {d['minutes']} minutes.")
    elif d.get("signal"):
        text = (f"{d['what']} derlemesi çöktü ({d['signal']}) - yeniden denemesi de." if tr and d.get("retried") else
                f"{d['what']} derlemesi çöktü ({d['signal']})." if tr else
                f"The build of {d['what']} crashed ({d['signal']}), and again when run once more."
                if d.get("retried") else f"The build of {d['what']} crashed ({d['signal']}).")
    else:
        text = (f"{d['what']} derlemesi çöktü, yeniden çalıştırılınca geçti." if tr else
                f"The build of {d['what']} crashed, and went through when run again.")
    head = f"🩺 <b>{'Sunucu' if tr else 'Server'}</b>"
    detail = f"<i>{core.esc(core.clip(d['detail'], 300))}</i>" if d.get("detail") else ""
    url = app_link(base, ws="settings")
    return "\n".join(x for x in [head, core.esc(text), detail, _a(url, w(link, "open"))] if x)


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
