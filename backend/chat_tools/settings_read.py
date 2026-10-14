"""settings_read: what Settings shows, read only - which provider and model
each LLM job uses (Settings > LLM settings, GET /api/llm/settings: whether
a provider has a key, never the key nor its last characters), this
month's LLM usage and spend (GET /api/llm/summary and /api/llm/usage, as
the LLM settings' usage and the Chat's Models card count them), and the
backups (Settings > Backups, GET /api/admin/backups: the last nightly
dump and the last restore check) - each with the right its page's GET
needs: the backups are the owner's and the admins'.

Nothing is changed and no secret is ever read: the keys stay in
backend/llm.py, the backups' secret key in backend/secretbox.py."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from .. import access, llm
from . import Ctx, Result, Tool, ToolError, clip
from ._rights import need

WHATS = ("models", "usage", "backups", "all")
TOP = 6


def _usd(x) -> str:
    return "-" if x is None else f"${float(x):,.2f}"


def _n(x) -> str:
    x = float(x or 0)
    for size, unit in ((1e9, "B"), (1e6, "M"), (1e3, "k")):
        if x >= max(size, 1e4):
            return f"{x / size:,.1f}{unit}"
    return f"{x:,.0f}"


def models() -> tuple[list[str], dict]:
    need("GET", "/api/llm/settings")
    pub = llm.public()
    provs = pub.get("providers") or {}
    out = ["LLM jobs (Settings > LLM settings), which provider and model each uses:"]
    for j, d in (pub.get("jobs") or {}).items():
        p = provs.get(d.get("provider")) or {}
        bits = [f"  {d.get('label') or j} ({j}): {p.get('name') or d.get('provider') or '-'} / {d.get('model') or '-'}"]
        if d.get("switch"):
            bits.append("on" if d.get("on") else "off")
        if p and not p.get("set"):
            bits.append("its provider has no key: this job does not run")
        if (d.get("default") or {}).get("model") == d.get("model") and (d.get("default") or {}).get("provider") == d.get("provider"):
            bits.append("the default")
        out.append(", ".join(bits))
    ready = [v.get("name") for v in provs.values() if v.get("set")]
    out.append("Providers with a key: " + (", ".join(ready) or "none") + " (the keys themselves are never shown).")
    return out, {"jobs": len(pub.get("jobs") or {})}


async def usage() -> tuple[list[str], dict]:
    need("GET", "/api/llm/usage")
    from .. import llm_api
    s = await llm_api.summary(days=7)
    m, today = s.get("month") or {}, s.get("today") or {}
    here = datetime.now(timezone.utc).astimezone(ZoneInfo(os.environ.get("REDLINE_TZ", "Europe/Istanbul")))
    u = await llm_api.usage(provider="all", days=max(1, here.day))
    out = [f"LLM usage this month ({here.strftime('%B %Y')}, this workspace's, API list prices): {_n(m.get('calls'))} calls, "
           f"{_n(m.get('tokens'))} tokens ({_n(m.get('input'))} in, {_n(m.get('output'))} out), {_usd(m.get('cost_usd'))}"
           + (f"; {_n(m['unpriced_calls'])} calls without a price" if m.get("unpriced_calls") else "")
           + f". Today: {_n(today.get('calls'))} calls, {_n(today.get('tokens'))} tokens, {_usd(today.get('cost_usd'))}."]
    for key, what in (("by_kind", "By job"), ("by_model", "By model"), ("by_provider", "By provider")):
        rows = sorted(u.get(key) or [], key=lambda r: -(r.get("cost_usd") or 0))[:TOP]
        if rows:
            out.append(f"{what} (last {u.get('days')} days): " + "; ".join(
                f"{r.get('name')} {_usd(r.get('cost_usd'))}, {_n(r.get('calls'))} calls" for r in rows))
    if u.get("unpriced_providers"):
        out.append("Not priced (their calls count, their money does not): " + ", ".join(u["unpriced_providers"]))
    return out, {"spend": _usd(m.get("cost_usd")), "calls": int(m.get("calls") or 0)}


async def backups() -> tuple[list[str], dict]:
    if not access.allowed(access.current(), access.action("GET", "/api/admin/backups")):
        return ["Backups: only the owner and the admins see them (Settings > Backups)."], {}
    need("GET", "/api/admin/backups")
    from .. import backups as bk
    d = await bk.state()
    h, sch = d.get("health") or {}, d.get("schedule") or {}
    if d.get("error") and not d.get("archives"):
        return [f"Backups: not readable now - {str(d['error'])[:200]}"], {"backup": "unreadable"}
    dumps, checks = d.get("dumps") or [], d.get("checks") or []
    nightly = [a for a in d.get("archives") or [] if a.get("kind") == "nightly"]
    newest = next((a for a in nightly if a.get("newest")), None)
    age = h.get("newest_age_s")
    out = ["Backups (Settings > Backups):",
           f"  Nightly dump at {sch.get('at') or '-'} ({sch.get('tz') or '-'}), kept {sch.get('keep_days') or '-'} days; "
           f"{len(nightly)} nightly and {len(d.get('archives') or []) - len(nightly)} manual archives.",
           "  Last nightly: " + (f"{newest['name']}, {round(age / 3600, 1)} h ago" if newest and age is not None else "none")
           + (f" - the last dump {'worked' if dumps[0].get('ok') else 'FAILED'} ({str(dumps[0].get('at') or '')[:16]})" if dumps else "")
           + ("" if h.get("fresh") else " - older than a day"),
           "  Last restore check: " + (f"{'passed' if checks[0].get('ok') else 'FAILED'} on {str(checks[0].get('archive') or '')} "
                                       f"({str(checks[0].get('at') or '')[:16]})" if checks else "never run")]
    if h.get("plaintext"):
        out.append(f"  {h['plaintext']} archive(s) hold the saved secrets in plaintext (written before the secret key).")
    state = "ok" if h.get("dump_ok") and h.get("fresh") and h.get("check_ok") is not False else "check"
    return out, {"backup": state}


async def run(ctx: Ctx, args: dict) -> Result:
    what = str(args.get("what") or "all").strip().lower()
    what = {"model": "models", "llm": "models", "spend": "usage", "cost": "usage", "backup": "backups"}.get(what, what)
    if what not in WHATS:
        raise ToolError(f"what is one of {', '.join(WHATS)}")
    out: list[str] = []
    v: dict = {"what": what}
    if what in ("models", "all"):
        lines, got = models()
        out += lines
        v.update(got)
    if what in ("usage", "all"):
        lines, got = await usage()
        out += ([""] if out else []) + lines
        v.update(got)
    if what in ("backups", "all"):
        try:
            lines, got = await backups()
        except ToolError:
            if what == "backups":
                raise
            lines, got = ["Backups: only the owner and the admins see them."], {}
        out += ([""] if out else []) + lines
        v.update(got)
    out.append("\nSettings: /settings/llm" + (" · Backups: /settings/backups" if what in ("backups", "all") else ""))
    say = {"models": "Read the LLM models", "usage": "Read this month's LLM usage: {spend}",
           "backups": "Read the backups' state", "all": "Read Settings: models, usage, backups"}[what]
    text = "\n".join(out)
    return Result(text=clip(text, 10_000), say=say, vars=v,
                  summary=" · ".join(x for x in (f"{v['jobs']} jobs" if "jobs" in v else "",
                                                  f"{v['spend']} this month" if "spend" in v else "",
                                                  f"backups {v['backup']}" if "backup" in v else "") if x))


TOOL = Tool(
    name="settings_read", package="general", level="read", order=85,
    label="Read Settings",
    about="Reads the LLM models per job, this month's LLM usage and spend, and the backups' state. No keys.",
    description="Read what Settings shows, without changing anything: `models` - which provider and model each LLM "
                "job uses (chat, taste extraction, manufacturer exploration, summaries...) and whether its provider "
                "has a key (never the key); `usage` - this month's LLM calls, tokens and spend at API list prices, by "
                "job, model and provider; `backups` - the last nightly database dump and the last restore check "
                "(the owner's and admins' only); `all` (default) - all three. Use it for \"which model does the chat "
                "use\", \"what did the LLMs cost this month\", \"did last night's backup work\". For costs beyond the "
                "LLMs and other ranges use analytics_read.",
    schema={"type": "object", "properties": {
        "what": {"type": "string", "enum": list(WHATS), "description": "Which part (default all)"}}},
    running="Reading Settings", failed="Could not read Settings",
    run=run)
