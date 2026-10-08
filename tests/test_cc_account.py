"""The Command Code account in Settings > LLM settings (backend/llm.py
cc_account, GET /api/llm/commandcode/account) and its Telegram alert.

Command Code's account endpoints are undocumented "alpha" ones, so what is
tested first is that nothing in them is trusted: a field may be missing or
the wrong type, a part may answer 404, all of them may be down. Then the
minute's cache, the chart's points (one per ten minutes, 14 days), who sees
what, the weekly window's alert (once at 90%, once when used up, again
after the window resets) and that the key is never in an answer or a log.
"""

from __future__ import annotations

import asyncio
import json
import logging

import httpx
import pytest

from backend import access, actors, llm, llm_api, scope
from backend.tgbot import core, fmt, links, notify, outbox
from tests.test_telegram import FakeDb, configured, drain, env, linked  # noqa: F401 - env is a fixture

KEY = "user_SECRETkey0123456789abcdef"
NOW = 1_760_000_000.0                      # seconds
NOW_MS = int(NOW * 1000)

WHOAMI = {"success": True, "user": {"id": "u1", "name": "Emir P", "email": "emir@example.com", "userName": "emirp"},
          "org": None}
CREDITS = {"credits": {"belowThreshold": False, "creditThreshold": 5, "monthlyCredits": 812.5,
                       "purchasedCredits": 0, "freeCredits": 3},
           "windowLimits": {"limited": True, "exceeded": False,
                            "fiveHour": {"used": 12, "cap": 40, "exceeded": False, "resetAt": NOW_MS + 3_600_000},
                            "weekly": {"used": 150, "cap": 200, "exceeded": False, "resetAt": NOW_MS + 4 * 86_400_000}},
           "sandboxAccess": False, "sandboxMinutes": {}}
SUBS = {"success": True, "data": {"status": "active", "planId": "individual-goat",
                                  "currentPeriodStart": "2026-09-14T00:00:00Z",
                                  "currentPeriodEnd": "2026-10-14T00:00:00Z", "cancelAtPeriodEnd": False}}
SUMMARY = {"totalCount": 200, "totalCost": 18.4, "averageCost": 0.092, "successRate": 0.97,
           "completedCount": 194, "failedCount": 6, "totalTokensIn": 1_200_000, "totalTokensOut": 80_000,
           "totalTokens": 1_280_000, "totalCredits": 187.5, "totalMonthlyCredits": 187.5,
           "totalPurchasedCredits": 0, "totalFreeCredits": 0, "periodBasis": "billing-period"}
BODIES = {"/alpha/whoami": WHOAMI, "/alpha/billing/credits": CREDITS,
          "/alpha/billing/subscriptions": SUBS, "/alpha/usage/summary": SUMMARY}


def run(c):
    return asyncio.run(c)


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setattr(llm, "_conf", {"keys": {"commandcode": KEY}, "jobs": {}})
    monkeypatch.setattr(llm, "_cc", {"at": 0.0, "key": None, "data": None})
    monkeypatch.setattr(llm, "_cc_ttl_made", False)
    monkeypatch.setattr(llm, "_cc_transport", None)


class CC:
    """Command Code, standing in: answers from a table, counts the asks and
    remembers the Authorization header it got."""

    def __init__(self, bodies=None, status=None):
        self.bodies = dict(BODIES if bodies is None else bodies)
        self.status = status or {}
        self.asked = []
        self.auth = set()

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.asked.append(req.url.path)
        self.auth.add(req.headers.get("authorization"))
        st = self.status.get(req.url.path)
        if st:
            return httpx.Response(st, json={"error": "nope"})
        if req.url.path not in self.bodies:
            return httpx.Response(404, json={"error": "not found"})
        return httpx.Response(200, json=self.bodies[req.url.path])


def stand_in(monkeypatch, cc: CC):
    monkeypatch.setattr(llm, "_cc_transport", httpx.MockTransport(cc))
    return cc


def settings_db():
    db = FakeDb()
    db[llm.COLL].docs[llm.DOC_ID] = {"_id": llm.DOC_ID, "keys": {"commandcode": KEY}}
    return db


# ---------------------------------------------------------------- parsing

def test_the_four_answers_become_the_pages_figures():
    d = llm.cc_parse({"whoami": WHOAMI, "credits": CREDITS, "subscription": SUBS, "usage": SUMMARY})
    assert d["account"] == {"name": "Emir P", "user_name": "emirp", "email": "emir@example.com", "org": None}
    assert d["plan"]["name"] == "Individual Goat" and d["plan"]["status"] == "active"
    from datetime import datetime, timezone
    assert d["plan"]["period_end"] == int(datetime(2026, 10, 14, tzinfo=timezone.utc).timestamp() * 1000)
    w = d["windows"]["weekly"]
    assert w == {"used": 150.0, "cap": 200.0, "pct": 75.0, "exceeded": False, "reset_at": NOW_MS + 4 * 86_400_000}
    assert d["windows"]["five_hour"]["pct"] == 30.0
    assert d["credits"]["monthly_left"] == 812.5
    u = d["usage"]
    assert u["requests"] == 200 and u["success_pct"] == 97.0 and u["tokens_in"] == 1_200_000
    assert u["credits"] == 187.5 and u["cost_avg"] == 0.092


def test_missing_and_odd_fields_are_left_out_not_trusted():
    d = llm.cc_parse({"whoami": {"success": True}, "credits": {"windowLimits": {"weekly": {"used": "50", "cap": 0},
                                                                               "fiveHour": "nonsense"}},
                      "subscription": {"data": {"planId": 7, "currentPeriodEnd": 1_760_000_000}},
                      "usage": {"totalCount": None, "successRate": 88, "totalTokensIn": 10, "totalTokensOut": True}})
    assert d["account"] is None and d["credits"] is None
    assert d["windows"]["weekly"] == {"used": 50.0, "cap": 0.0, "pct": None, "exceeded": False, "reset_at": None}
    assert d["windows"]["five_hour"] is None
    assert d["plan"]["id"] is None and d["plan"]["period_end"] == 1_760_000_000_000     # seconds -> ms
    assert d["usage"]["success_pct"] == 88.0 and d["usage"]["tokens"] == 10.0 and d["usage"]["tokens_out"] is None
    # nothing at all
    empty = llm.cc_parse({})
    assert empty["account"] is None and empty["windows"]["weekly"] is None and empty["usage"] is None


def test_a_part_that_answers_404_is_left_out(monkeypatch):
    cc = stand_in(monkeypatch, CC(status={"/alpha/usage/summary": 404, "/alpha/whoami": 401}))
    d = run(llm.cc_account(settings_db(), now=NOW))
    assert d["shared"] is True and d["stale"] is False
    assert d["usage"] is None and d["account"] is None and d["windows"]["weekly"]["used"] == 150
    assert d["answers"]["usage"] == 404 and d["answers"]["whoami"] == 401 and d["answers"]["credits"] == 200
    assert cc.auth == {f"Bearer {KEY}"}


def test_nothing_shared_says_so_and_then_shows_the_last_figures(monkeypatch):
    db = settings_db()
    stand_in(monkeypatch, CC(bodies={}))
    d = run(llm.cc_account(db, now=NOW))
    assert d["set"] is True and d["shared"] is False
    # a good look, kept; then Command Code goes away
    monkeypatch.setattr(llm, "_cc", {"at": 0.0, "key": None, "data": None})
    stand_in(monkeypatch, CC())
    run(llm.cc_account(db, now=NOW + 100))
    assert db[llm.COLL].docs[llm.DOC_ID]["cc_account"]["windows"]["weekly"]["used"] == 150
    stand_in(monkeypatch, CC(bodies={}, status={p: 503 for p in BODIES}))
    d = run(llm.cc_account(db, now=NOW + 300))
    assert d["shared"] is True and d["stale"] is True and d["windows"]["weekly"]["used"] == 150
    assert d["answers"]["credits"] == 503


def test_a_network_error_is_a_part_missing_not_an_error(monkeypatch):
    def boom(req):
        raise httpx.ConnectTimeout("timed out", request=req)
    monkeypatch.setattr(llm, "_cc_transport", httpx.MockTransport(boom))
    d = run(llm.cc_account(settings_db(), now=NOW))
    assert d["shared"] is False and d["answers"]["credits"] == "ConnectTimeout"


def test_no_key_no_call(monkeypatch):
    cc = stand_in(monkeypatch, CC())
    monkeypatch.setattr(llm, "_conf", {"keys": {}, "jobs": {}})
    assert run(llm.cc_account(settings_db(), now=NOW)) == {"set": False, "shared": False}
    assert cc.asked == []


# ---------------------------------------------------------------- caching

def test_a_minute_of_cache_and_a_refresh_waits_ten_seconds(monkeypatch):
    cc = stand_in(monkeypatch, CC())
    db = settings_db()
    run(llm.cc_account(db, now=NOW))
    assert len(cc.asked) == 4
    run(llm.cc_account(db, now=NOW + 30))
    assert len(cc.asked) == 4                         # cached
    run(llm.cc_account(db, now=NOW + 5, force=True))
    assert len(cc.asked) == 4                         # a refresh too soon
    run(llm.cc_account(db, now=NOW + 15, force=True))
    assert len(cc.asked) == 8
    run(llm.cc_account(db, now=NOW + 80))
    assert len(cc.asked) == 12                        # a minute on
    # a new key is a new account: not the old one's figures
    llm._conf["keys"]["commandcode"] = KEY + "x"
    run(llm.cc_account(db, now=NOW + 81))
    assert len(cc.asked) == 16


def test_many_pages_at_once_ask_once(monkeypatch):
    cc = stand_in(monkeypatch, CC())
    db = settings_db()

    async def many():
        return await asyncio.gather(*(llm.cc_account(db, now=NOW) for _ in range(5)))
    out = run(many())
    assert len(cc.asked) == 4 and all(o is out[0] for o in out)


# ---------------------------------------------------------------- the chart's points

def test_one_point_per_ten_minutes_kept_fourteen_days(monkeypatch):
    db = settings_db()
    made = []

    async def create_index(*a, **kw):
        made.append((a, kw))
    monkeypatch.setattr(db[llm.CC_POINTS], "create_index", create_index)
    data = llm.cc_parse({"credits": CREDITS, "usage": SUMMARY})
    t0 = 1_760_000_400.0                              # on a ten-minute line
    run(llm.cc_point(db, data, t0 + 10))
    data["windows"]["weekly"]["used"] = 155
    run(llm.cc_point(db, data, t0 + 590))             # same ten minutes: the latest wins
    run(llm.cc_point(db, data, t0 + 600))
    pts = db[llm.CC_POINTS].docs
    assert len(pts) == 2 and pts[int(t0)]["weekly_used"] == 155
    assert made == [(("at",), {"expireAfterSeconds": 14 * 86400})]
    # older than 14 days: not on the chart, whatever the TTL monitor has done yet
    run(llm.cc_point(db, data, t0 - 15 * 86400))
    hist = run(llm.cc_history(db, now=t0 + 600))
    assert [h["t"] for h in hist] == [int(t0) * 1000, int(t0 + 600) * 1000]
    assert hist[0]["weekly_cap"] == 200 and hist[0]["monthly_left"] == 812.5 and hist[0]["total_credits"] == 187.5


def test_nothing_to_draw_is_no_point():
    db = settings_db()
    assert run(llm.cc_point(db, llm.cc_parse({"whoami": WHOAMI}), NOW)) is None
    assert db[llm.CC_POINTS].docs == {}


# ---------------------------------------------------------------- the alert

def wk(used, cap=200, reset=NOW_MS + 86_400_000, exceeded=False):
    return {"used": used, "cap": cap, "exceeded": exceeded, "reset_at": reset}


def test_the_alert_fires_once_at_90_once_when_used_up_and_again_after_the_reset():
    st, fired = {}, []
    reset = NOW_MS + 86_400_000
    for used, t in [(100, NOW_MS), (179, NOW_MS + 1), (180, NOW_MS + 2), (185, NOW_MS + 3), (190, NOW_MS + 4),
                    (200, NOW_MS + 5), (210, NOW_MS + 6)]:
        level, st = llm.cc_alert_step(st, wk(used, reset=reset), t)
        fired.append(level)
    assert fired == [None, None, "90", None, None, "exceeded", None]
    # the window resets: a new resetAt, the old one passed
    new_reset = reset + 7 * 86_400_000
    level, st = llm.cc_alert_step(st, wk(5, reset=new_reset), reset + 1)
    assert level is None and st["fired"] == [] and st["reset_at"] == new_reset
    level, st = llm.cc_alert_step(st, wk(182, reset=new_reset), reset + 2)
    assert level == "90"


def test_straight_past_the_cap_is_one_message():
    level, st = llm.cc_alert_step({}, wk(0, exceeded=True), NOW_MS)
    assert level == "exceeded" and st["fired"] == ["90", "exceeded"]
    assert llm.cc_alert_step(st, wk(220), NOW_MS + 1)[0] is None


def test_a_rolling_window_that_empties_rearms():
    level, st = llm.cc_alert_step({}, wk(185, reset=NOW_MS + 999_999_999), NOW_MS)
    assert level == "90"
    _, st = llm.cc_alert_step(st, wk(170, reset=NOW_MS + 999_999_999), NOW_MS + 1)   # 85%: still told
    assert st["fired"] == ["90"]
    _, st = llm.cc_alert_step(st, wk(150, reset=NOW_MS + 999_999_999), NOW_MS + 2)   # 75%: re-armed
    assert st["fired"] == []
    assert llm.cc_alert_step(st, wk(181, reset=NOW_MS + 999_999_999), NOW_MS + 3)[0] == "90"


def test_no_cap_no_alert_unless_command_code_says_exceeded():
    assert llm.cc_alert_step({}, wk(500, cap=None), NOW_MS)[0] is None
    assert llm.cc_alert_step({}, wk(None, cap=None, exceeded=True), NOW_MS)[0] == "exceeded"


def test_the_alert_is_written_once_and_kept_with_the_window(monkeypatch):
    db = settings_db()
    data = {"windows": {"weekly": llm._window({"used": 181, "cap": 200, "resetAt": NOW_MS + 86_400_000})},
            "plan": {"name": "Individual Goat"}}
    assert run(llm.cc_check_alert(db, data, NOW)) == "90"
    assert run(llm.cc_check_alert(db, data, NOW + 600)) is None
    alerts = list(db[llm.CC_ALERTS].docs.values())
    assert len(alerts) == 1 and alerts[0]["level"] == "90" and alerts[0]["pct"] == 90.5
    st = db[llm.COLL].docs[llm.DOC_ID]["cc_alert"]
    assert st["fired"] == ["90"] and st["reset_at"] == NOW_MS + 86_400_000 and st["v"] == 1


def test_two_looks_at_once_write_one_alert():
    db = settings_db()
    data = {"windows": {"weekly": llm._window({"used": 195, "cap": 200})}}
    real = db[llm.COLL].find_one

    async def stale_read(q=None, proj=None, *a, **kw):        # both read the state before either writes
        return {"_id": llm.DOC_ID}
    db[llm.COLL].find_one = stale_read

    async def both():
        return [await llm.cc_check_alert(db, data, NOW), await llm.cc_check_alert(db, data, NOW)]
    assert run(both()) == ["90", None]
    db[llm.COLL].find_one = real
    assert len(db[llm.CC_ALERTS].docs) == 1


def test_the_alert_goes_to_the_owner_and_admins_who_want_it(env, monkeypatch):
    from backend import auth
    monkeypatch.setattr(auth, "enabled", lambda: True)
    configured(env.db)
    linked(env.db, user="own", chat=7001, role="owner", name="Emir")
    linked(env.db, user="adm", chat=7002, role="admin", name="Can", lang="tr")
    linked(env.db, user="usr", chat=7003, role="user", name="Ece")                 # not the server's
    off = linked(env.db, user="ad2", chat=7004, role="admin", name="Deniz")
    off["prefs"]["ccusage"] = False                                                  # does not want it
    run(notify.tick(env.db))                     # the first look starts the clock
    env.db[llm.COLL].docs[llm.DOC_ID] = {"_id": llm.DOC_ID}
    data = {"windows": {"weekly": llm._window({"used": 185, "cap": 200, "resetAt": NOW_MS + 86_400_000})},
            "plan": {"name": "Individual Goat"}}
    import time
    assert run(llm.cc_check_alert(env.db, data, time.time())) == "90"
    assert run(notify.tick(env.db)) == 1
    assert run(notify.tick(env.db)) == 0         # announced once
    drain(env.db)
    sent = {m["chat_id"]: m["text"] for m in env.bot.sent("send_message")}
    assert set(sent) == {7001, 7002}
    assert "weekly usage window is at 92%" in sent[7001] and "185 / 200" in sent[7001]
    assert "Individual Goat" in sent[7001] and "Resets" in sent[7001]
    assert "Haftalık" in sent[7002]


def test_the_pref_is_shown_only_to_those_who_run_the_server(env):
    from backend.tgbot import api
    assert links.PREFS["ccusage"] is True and "ccusage" in links.SERVER_PREFS
    configured(env.db)
    tok = access.ROLE.set("user")
    try:
        ids = [p["id"] for p in run(api.state())["prefs"]]
    finally:
        access.ROLE.reset(tok)
    assert "ccusage" not in ids and "budget" in ids
    assert "ccusage" in [p["id"] for p in run(api.state())["prefs"]]       # the owner (local mode)


def test_the_exceeded_message():
    text = fmt.cc_usage_event(None, {"level": "exceeded", "used": 200, "cap": 200, "reset_at": NOW_MS}, None)
    assert text.startswith("🛑") and "used up (200 / 200)" in text


# ---------------------------------------------------------------- the route, and who sees what

def call_route(monkeypatch, db, role="owner", actor=None, refresh=False):
    from backend import main
    monkeypatch.setattr(main, "db", lambda: db)
    t1 = access.ROLE.set(role)
    t2 = actors.CURRENT.set(actor or {"type": "user", "id": "u1", "name": "Emir"})
    try:
        return run(llm_api.commandcode_account(refresh=refresh))
    finally:
        access.ROLE.reset(t1)
        actors.CURRENT.reset(t2)


def test_the_route_gives_the_figures_and_the_chart(monkeypatch):
    stand_in(monkeypatch, CC())
    db = settings_db()
    out = call_route(monkeypatch, db)
    assert out["shared"] and out["plan"]["name"] == "Individual Goat"
    assert out["account"]["email"] == "emir@example.com"                 # the owner sees it
    assert len(out["history"]) == 1 and out["history"][0]["weekly_used"] == 150


def test_only_the_owner_sees_the_email(monkeypatch):
    stand_in(monkeypatch, CC())
    db = settings_db()
    for role in ("admin", "user", "viewer"):
        out = call_route(monkeypatch, db, role=role)
        assert "email" not in out["account"] and out["account"]["user_name"] == "emirp", role
    page = {"type": "user", "id": "u1", "name": "Emir", "page": True}
    assert "email" not in call_route(monkeypatch, db, role="owner", actor=page)["account"]


def test_anyone_who_may_see_llm_settings_may_see_it():
    for role in ("owner", "admin", "user", "editor", "reviewer", "viewer"):
        assert access.allowed(role, access.action("GET", "/api/llm/commandcode/account")), role
        assert access.allowed(role, access.action("GET", "/api/llm/settings")), role
    assert access.page_allowed("GET", "/api/llm/commandcode/account")


def test_a_failure_inside_is_said_not_a_500(monkeypatch):
    async def broken(*a, **kw):
        raise RuntimeError(f"boom {KEY}")
    monkeypatch.setattr(llm, "cc_account", broken)
    out = call_route(monkeypatch, settings_db())
    assert out["shared"] is False and out["set"] is True and KEY not in json.dumps(out)


def test_the_key_is_never_in_an_answer_or_a_log(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    db = settings_db()
    # some parts refuse, some answer, one times out
    calls = {"n": 0}

    def flaky(req):
        calls["n"] += 1
        if req.url.path.endswith("summary"):
            raise httpx.ReadTimeout(f"timed out {req.headers.get('authorization')}", request=req)
        if req.url.path.endswith("whoami"):
            return httpx.Response(401, json={"error": f"bad key {KEY}"})
        return httpx.Response(200, json=BODIES[req.url.path])
    monkeypatch.setattr(llm, "_cc_transport", httpx.MockTransport(flaky))
    out = call_route(monkeypatch, db, refresh=True)
    db_text = json.dumps(db[llm.COLL].docs[llm.DOC_ID].get("cc_account"), default=str)
    assert KEY not in json.dumps(out, default=str)
    assert KEY not in caplog.text and "SECRETkey" not in caplog.text
    assert KEY not in db_text
    assert out["answers"] == {"whoami": 401, "credits": 200, "subscription": 200, "usage": "ReadTimeout"}


# ---------------------------------------------------------------- the month, and the window's kind

def test_the_month_is_spent_of_spent_plus_left_and_marked_derived():
    d = llm.cc_parse({"credits": CREDITS, "usage": SUMMARY, "subscription": SUBS})
    m = d["windows"]["monthly"]
    assert m["used"] == 187.5 and m["cap"] == 1000.0 and m["pct"] == 18.8 and m["left"] == 812.5
    assert m["derived"] is True and m["reset_at"] == d["plan"]["period_end"]
    # left below zero: no share of a cap is made up
    neg = llm.cc_parse({"credits": {"credits": {"monthlyCredits": -3}}, "usage": SUMMARY})["windows"]["monthly"]
    assert neg["cap"] is None and neg["pct"] is None and neg["exceeded"] is True
    assert llm.cc_parse({"credits": CREDITS})["windows"]["monthly"] is None


def test_the_points_tell_a_fixed_window_from_a_rolling_one():
    r1, r2 = NOW_MS + 86_400_000, NOW_MS + 8 * 86_400_000
    fixed = [{"weekly_used": 30, "weekly_reset": r1}, {"weekly_used": 33, "weekly_reset": r1},
             {"weekly_used": 0.5, "weekly_reset": r2}]
    rolling = [{"weekly_used": 30, "weekly_reset": r1}, {"weekly_used": 28, "weekly_reset": r1 + 3_600_000}]
    assert llm.cc_window_kind(fixed) == "fixed"
    assert llm.cc_window_kind(rolling) == "rolling"
    assert llm.cc_window_kind(fixed[:2]) == "unknown" and llm.cc_window_kind([]) == "unknown"


# ---------------------------------------------------------------- the period, day by day

DAY = 86_400_000


def since_cc(spend_at: list[tuple[int, float]], fail=False):
    """Command Code's /usage/summary?since=: the totals of what was spent from then on."""
    from datetime import datetime

    asked = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path != "/alpha/usage/summary":
            return httpx.Response(200, json=BODIES[req.url.path])
        since = req.url.params.get("since")
        if since is None:
            return httpx.Response(200, json=SUMMARY)
        if fail:
            return httpx.Response(400, json={"error": "no"})
        asked.append(since)
        t = int(datetime.fromisoformat(since.replace("Z", "+00:00")).timestamp() * 1000)
        got = [c for at, c in spend_at if at >= t]
        return httpx.Response(200, json={"totalCredits": sum(got), "totalCount": len(got),
                                         "totalTokensIn": 10 * len(got), "totalTokensOut": len(got)})
    return handler, asked


def test_a_day_is_the_difference_of_two_sinces_and_a_finished_day_is_kept(monkeypatch):
    db = settings_db()
    start = llm._day_start(NOW_MS) - 3 * DAY + 5 * 3_600_000          # a period that began 3 days ago, mid-morning
    spend = [(start + 3_600_000, 1.0), (start + DAY, 2.0), (start + DAY + 60_000, 0.5), (NOW_MS - 1000, 4.0)]
    handler, asked = since_cc(spend)
    monkeypatch.setattr(llm, "_cc_transport", httpx.MockTransport(handler))
    days, src = run(llm.cc_days(db, KEY, start, NOW_MS))
    assert src == "command-code" and len(days) == 4
    assert [d["credits"] for d in days] == [1.0, 2.5, 0.0, 4.0]
    assert days[-1]["partial"] is True and not days[0]["partial"]
    assert days[1]["requests"] == 2
    assert len(db[llm.CC_DAYS].docs) == 3                             # the finished ones
    n = len(asked)
    days2, _ = run(llm.cc_days(db, KEY, start, NOW_MS))
    assert [d["credits"] for d in days2] == [1.0, 2.5, 0.0, 4.0]
    assert len(asked) - n == 1                                         # only today asked again


def test_without_since_the_days_come_from_our_points(monkeypatch):
    db = settings_db()
    handler, _ = since_cc([], fail=True)
    monkeypatch.setattr(llm, "_cc_transport", httpx.MockTransport(handler))
    start = llm._day_start(NOW_MS) - 2 * DAY
    assert run(llm.cc_days(db, KEY, start, NOW_MS)) == ([], "none")
    for i, total in enumerate([10.0, 12.0, 15.0]):
        t = (start + i * DAY + 7_200_000) / 1000
        db[llm.CC_POINTS].docs[int(t)] = {"_id": int(t), "total_credits": total}
    days, since = run(llm.cc_days_from_points(db, start, NOW_MS))
    assert [d["credits"] for d in days] == [2.0, 3.0] and since == int((start + 7_200_000) / 1000) * 1000


def test_the_analysis_says_the_burn_rate_and_where_it_leads(monkeypatch):
    db = settings_db()
    sub = {"success": True, "data": {**SUBS["data"], "currentPeriodStart": NOW_MS - 10 * DAY,
                                     "currentPeriodEnd": NOW_MS + 20 * DAY}}
    spend = [(NOW_MS - 9 * DAY, 47.5), (NOW_MS - 6 * DAY, 70.0), (NOW_MS - DAY, 70.0)]
    handler, _ = since_cc(spend)

    def all_parts(req):
        if req.url.path == "/alpha/billing/subscriptions":
            return httpx.Response(200, json=sub)
        return handler(req)
    monkeypatch.setattr(llm, "_cc_transport", httpx.MockTransport(all_parts))
    monkeypatch.setattr(llm, "_cc_an", {"at": 0.0, "key": None, "data": None})
    a = run(llm.cc_analysis(db, now=NOW))
    assert a["days_source"] == "command-code" and abs(sum(d["credits"] for d in a["days"]) - 187.5) < 1e-6
    p = a["projection"]
    assert p["burn_per_day"] == 20.0 and p["spent"] == 187.5 and p["allowance"] == 1000.0
    assert p["runs_out_at"] is None                    # 812.5 left at 20 a day outlasts the 20 days
    assert p["at_end"] == 587.5 and p["at_end_pct"] == 58.8
    assert a["weekly"]["used"] == 150 and a["period"]["days_left"] == 20.0
    assert a["redline"]["requests"] == 0 and a["others"]["requests"] == 200
    assert KEY not in json.dumps(a, default=str)


# ---------------------------------------------------------------- the providers, one by one; OpenRouter's account

OR_KEY = "sk-or-v1-SECRETopenrouter0123456789"
OR_KEYBODY = {"data": {"label": "sk-or-v1-0e6...a1b", "usage": 0.25, "limit": 1, "limit_remaining": 0.75,
                       "limit_reset": "monthly", "is_free_tier": False, "usage_daily": 0, "usage_weekly": 0.1,
                       "usage_monthly": 0.25, "rate_limit": {"requests": -1, "interval": "10s"}}}
OR_CREDITS = {"data": {"total_credits": 65, "total_usage": 56.125}}


def test_the_registry_lists_each_provider_for_the_page():
    reg = llm.registry()
    assert [p["id"] for p in reg] == ["commandcode", "openrouter"]
    for p in reg:
        assert p["name"] == llm.PROVIDERS[p["id"]]["name"] and p["site"].startswith("https://") and p["about"]
    assert {p["id"]: p["priced"] for p in reg} == {"commandcode": False, "openrouter": True}
    assert llm.public()["registry"] == reg
    # every registered provider is one the calls know, and has an account reader
    assert set(llm.REGISTRY) <= set(llm.PROVIDERS)
    assert all(callable(e["account"]) for e in llm.REGISTRY.values())
    with pytest.raises(ValueError):
        run(llm.provider_account(None, "nope"))


def test_openrouter_figures_and_a_label_that_is_the_key_is_left_out():
    d = llm.or_parse(OR_KEYBODY, OR_CREDITS)
    assert d["key"]["usage"] == 0.25 and d["key"]["limit"] == 1.0 and d["key"]["limit_remaining"] == 0.75
    assert d["key"]["label"] is None and d["key"]["limit_reset"] == "monthly"
    assert d["key"]["rate_limit"] == {"requests": -1, "interval": "10s"}
    assert d["credits"] == {"total": 65.0, "used": 56.125, "left": 8.875}
    named = llm.or_parse({"data": {"label": "redline server"}}, None)
    assert named["key"]["label"] == "redline server" and named["credits"] is None
    assert llm.or_parse({}, {"data": {"total_credits": "x"}})["credits"]["left"] is None


def or_stand_in(monkeypatch, status=None):
    def handler(req):
        assert req.headers["authorization"] == f"Bearer {OR_KEY}"
        st = (status or {}).get(req.url.path)
        if st:
            return httpx.Response(st, json={"error": {"message": f"bad key {OR_KEY}"}})
        return httpx.Response(200, json=OR_KEYBODY if req.url.path.endswith("/key") else OR_CREDITS)
    llm._conf["keys"]["openrouter"] = OR_KEY
    monkeypatch.setattr(llm, "_or", {"at": 0.0, "key": None, "data": None})
    monkeypatch.setattr(llm, "_or_transport", httpx.MockTransport(handler))


def test_openrouter_401_is_not_shared_and_credits_may_refuse_alone(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    or_stand_in(monkeypatch, {"/api/v1/key": 401, "/api/v1/credits": 401})
    d = run(llm.or_account(now=NOW))
    assert d["shared"] is False and d["answers"] == {"key": 401, "credits": 401}
    or_stand_in(monkeypatch, {"/api/v1/credits": 403})
    d = run(llm.or_account(now=NOW))
    assert d["shared"] is True and d["credits"] is None and d["key"]["usage"] == 0.25
    assert OR_KEY not in caplog.text and OR_KEY not in json.dumps(d)


def test_openrouter_is_cached_a_minute_and_no_key_no_call(monkeypatch):
    or_stand_in(monkeypatch)
    first = run(llm.or_account(now=NOW))
    assert run(llm.or_account(now=NOW + 30)) is first
    assert run(llm.or_account(now=NOW + 61)) is not first
    llm._conf["keys"].pop("openrouter")
    assert run(llm.or_account(now=NOW + 62)) == {"set": False, "shared": False}


def test_the_provider_route_adds_redlines_own_spend_and_never_the_key(monkeypatch, caplog):
    from datetime import datetime, timezone
    from backend import usage as _usage
    caplog.set_level(logging.DEBUG)
    or_stand_in(monkeypatch)
    db = settings_db()
    now = datetime.now(timezone.utc).isoformat()
    db[_usage.CALLS].docs["c1"] = {"_id": "c1", "provider": "openrouter", "at": now, "model": "deepseek/x",
                                   "input": 100, "output": 20, "cost_usd": 0.002}
    db[_usage.CALLS].docs["c2"] = {"_id": "c2", "provider": "commandcode", "at": now, "model": "q", "input": 1,
                                   "output": 1, "cost_usd": None}
    from backend import main
    monkeypatch.setattr(main, "db", lambda: db)
    out = run(llm_api.provider_account("openrouter"))
    assert out["credits"]["left"] == 8.875 and out["redline"]["days30"]["calls"] == 1
    assert out["redline"]["days30"]["cost_usd"] == 0.002 and out["redline"]["by_model"][0]["name"] == "deepseek/x"
    assert OR_KEY not in json.dumps(out, default=str) and OR_KEY not in caplog.text
    with pytest.raises(llm_api.HTTPException):
        run(llm_api.provider_account("opencode"))
