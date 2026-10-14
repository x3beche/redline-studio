"""Scheduled tasks speak their owner's language and respect the owner's
`task` switches (backend/sched/deliver.py, kinds.Ctx.lang,
notifications.lang_of): the report, its summary and the words around it in
Turkish for a Turkish reader, English otherwise; the bell and Telegram only
when Settings > Notifications has the scheduled-task kind on."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from backend import notifications as nc
from backend.sched import core, deliver, kinds
from backend.tgbot import core as tg, links
from test_sched import T0, ctx_for, echo_kind, make, runs, sch, settle  # noqa: F401 - sch is a fixture
from test_telegram import configured, env, linked, run  # noqa: F401 - env is a fixture

UTC = timezone.utc


def test_task_is_a_kind_in_the_app_and_on_telegram():
    assert "task" in nc.KIND_IDS and nc.INAPP_DEFAULT["task"] is True
    assert links.PREFS["task"] is True


def test_language_comes_from_the_page_then_telegram_then_english(sch):
    assert run(nc.lang_of(sch.db, "local")) == "en"
    linked(sch.db, user="local", tg={"id": 1, "language_code": "tr"})
    assert run(nc.lang_of(sch.db, "local")) == "tr"                        # the Telegram chat's
    sch.db[nc.PREFS].docs["local"] = {"_id": "local", "lang": "en"}
    assert run(nc.lang_of(sch.db, "local")) == "en"                        # the page said English


def test_stock_report_in_turkish(sch, monkeypatch):
    from backend import fx, inventory
    rows = [{"_id": "a", "name": "M3 screw", "quantity": 10, "min_stock": 50, "unit": "pcs", "price": 0.5, "currency": "USD"},
            {"_id": "b", "name": "PLA black", "quantity": 0, "price": 20, "currency": "USD"}]

    async def everything(db):
        return rows
    monkeypatch.setattr(inventory, "everything", everything)
    monkeypatch.setattr(fx, "to_usd", lambda a, c: a)
    k = kinds.KINDS["stock_report"]
    ctx = ctx_for(sch.db)
    ctx.lang = "tr"
    o = run(k.run(ctx, k.check({})))
    assert "stok satırından" in o.markdown and "asgari belirleyin" in o.markdown and "M3 screw" in o.markdown
    assert "azalmış" in o.summary and o.csv.startswith("Ürün,")
    ctx.lang = "en"
    assert "stock lines are low" in run(k.run(ctx, k.check({}))).markdown


def test_words_around_the_report_follow_the_owner(sch):
    t = {"_id": "t1", "name": "Stok"}
    r = {"status": "failed", "output": "x"}
    assert "Görevi aç" in deliver.message(t, r, "https://w.example", "tr") and "başarısız" in deliver.message(t, r, None, "tr")
    assert "Open the task" in deliver.message(t, r, "https://w.example") and " - failed" in deliver.message(t, r, None)
    assert kinds.ago(0, 1800, "tr") == "30 dk önce" and kinds.ago(0, 1800) == "30 min ago"


def test_the_task_kind_switches_stop_the_bell_and_telegram(sch, monkeypatch):
    echo_kind(monkeypatch)
    configured(sch.db)
    link = linked(sch.db, user="local", chat=7007)
    link["prefs"]["task"] = False
    sch.db[nc.PREFS].docs["local"] = {"_id": "local", "inapp": {"task": False}}
    make(sch.db, next_run=datetime(2026, 10, 19, 6, 0, tzinfo=UTC), params={"n": 3},
         deliver={"inapp": True, "telegram": True})
    run(core.tick(sch.db, T0))
    settle()
    r = runs(sch.db)[0]
    assert r["status"] == "done" and not r["delivered"]["inapp"] and r["delivered"]["telegram"] is None
    assert not sch.db[nc.COLL].docs and not sch.db[tg.OUTBOX].docs


@pytest.mark.parametrize("lang", ["en", "tr"])
def test_settings_keep_the_page_language(sch, lang, monkeypatch):
    from backend import actors
    monkeypatch.setattr(nc, "_raw", lambda: sch.db)
    tok = actors.CURRENT.set({"type": "user", "id": "local", "name": "you"})
    try:
        run(nc.put_settings(nc.SettingsIn(lang=lang)))
    finally:
        actors.CURRENT.reset(tok)
    assert sch.db[nc.PREFS].docs["local"]["lang"] == lang
    assert run(nc.lang_of(sch.db, "local")) == lang
