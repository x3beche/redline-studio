"""analytics_read: the Analytics room's figures (GET /api/insights), for
questions like "what did I spend this week", "which model costs most",
"where did my tokens go", "how long do builds take".

It reads the very answer the page reads - insights.overview_cached, the
same kept answer per workspace and range - so the Chat and the page never
disagree; with the right the page's GET needs, in the asker's workspace.
Amounts are in the workspace's display currency (Settings > Costs &
currency), at the rates the answer carries, as the page's money() shows
them; LLM money is at API list prices, as on the page."""

from __future__ import annotations

import asyncio
import time

from .. import app_links, insights
from . import Ctx, Result, Tool, ToolError, clip
from ._rights import need

RANGES = ("1h", "6h", "24h", "7d", "30d", "90d", "all")
SAID = {"1h": "the last hour", "6h": "the last 6 hours", "24h": "the last 24 hours", "7d": "the last 7 days",
        "30d": "the last 30 days", "90d": "the last 90 days", "all": "all time"}
SECTIONS = ("overview", "costs", "llm", "tokens", "runs", "notes", "api", "budget")
TOP = 8
FRESH_WAIT = 90                      # seconds to wait for a fresh answer when the kept one is old


class Fmt:
    """Money in the display currency (the dollar figure beside it when that
    is not dollars, for the headline), counts and durations."""

    def __init__(self, fx: dict):
        cur = str((fx or {}).get("display_currency") or "USD").upper()
        rate = ((fx or {}).get("rates") or {}).get(cur)
        self.cur, self.rate = (cur, float(rate)) if rate else ("USD", 1.0)
        self.fx = fx or {}

    def money(self, usd, both: bool = False) -> str:
        if usd is None:
            return "-"
        v = float(usd) * self.rate
        s = f"{v:,.0f}" if abs(v) >= 100 else f"{v:,.2f}"
        out = f"{s} {self.cur}"
        if both and self.cur != "USD":
            out += f" (${float(usd):,.2f})"
        return out

    def rates_line(self) -> str:
        if self.cur == "USD":
            return "amounts in USD"
        return (f"amounts in {self.cur} (1 USD = {self.rate:,.4g} {self.cur}"
                + (f", rates of {self.fx['date']}" if self.fx.get("date") else "") + ")")


def n(x) -> str:
    """1,234 / 1.2M / 4.9B."""
    if x is None:
        return "-"
    x = float(x)
    for size, unit in ((1e9, "B"), (1e6, "M"), (1e3, "k")):
        if abs(x) >= max(size, 1e4):
            return f"{x / size:,.1f}{unit}"
    return f"{x:,.0f}" if x == int(x) else f"{x:,.1f}"


def secs(s) -> str:
    if s is None:
        return "-"
    s = float(s)
    if s < 120:
        return f"{s:.0f} s"
    if s < 7200:
        return f"{s / 60:.1f} min"
    return f"{s / 3600:.1f} h"


def pct(x) -> str:
    return "-" if x is None else f"{100 * float(x):.1f}%"


def change(d: dict, key: str, prev_fmt=None) -> str:
    """'(+12.5% vs the period before: 410 USD)' - nothing when there was nothing before."""
    c = (d.get("change") or {}).get(key)
    p = (d.get("previous") or {}).get(key)
    if c is None:
        return " (nothing in the period before)" if not p else ""
    return f" ({'+' if c >= 0 else ''}{c:,.1f}% vs the period before" + (f": {prev_fmt(p)}" if prev_fmt else "") + ")"


def short(text, k: int = 80) -> str:
    t = " ".join(str(text or "").split())
    return t[:k] + ("…" if len(t) > k else "")


def ranked(rows: list[dict], line, top: int = TOP) -> list[str]:
    return [f"  {i}. {line(r)}" for i, r in enumerate(rows[:top], 1)] or ["  (none)"]


# ---------------------------------------------------------------- sections

def s_overview(d: dict, f: Fmt) -> list[str]:
    llm, comp, cache, api = d.get("llm") or {}, d.get("compute") or {}, d.get("cache") or {}, d.get("api") or {}
    tot, costs = d.get("now_totals") or {}, d.get("costs") or {}
    out = ["Headline:",
           f"  LLM spend (API list prices): {f.money(llm.get('cost_usd'), True)}{change(d, 'llm_usd', f.money)}",
           f"  LLM calls: {n(llm.get('calls'))}{change(d, 'llm_calls', n)}"
           + (f" · {n(llm['unpriced_calls'])} without a price" if llm.get("unpriced_calls") else ""),
           f"  Tokens: {n(tot.get('tokens'))}{change(d, 'tokens', n)}",
           f"  Cache saved: {f.money(cache.get('saved_usd'))} · hit ratio {pct(cache.get('hit_ratio'))}",
           f"  Actually paid in the range (subscriptions, proxy, electricity, other): {f.money(costs.get('total_usd'))}",
           f"  Jobs (builds, renders, layouts, tests): {n(comp.get('count'))}{change(d, 'jobs', n)} · "
           f"{n(comp.get('failed'))} failed · CPU {n((comp.get('cpu_s') or 0) / 3600)} h",
           f"  Notes written: {n(tot.get('notes'))} · agent runs: {n(tot.get('runs'))}",
           f"  Energy: {n((d.get('energy') or {}).get('machine_kwh'))} kWh (machine)",
           f"  API: {n(api.get('requests'))} requests, {n(api.get('errors'))} errors"]
    month = (d.get("budget_status") or {}).get("month_so_far") or {}
    if month:
        out.append(f"  This month so far: {f.money(month.get('total_usd'))} paid, forecast {f.money(month.get('forecast_usd'))}"
                   f" · LLM list price this month {f.money(month.get('llm_usd'))}")
    out.append("Top models: " + ("; ".join(f"{r['name']} {f.money(r.get('cost_usd'))}"
                                           for r in (llm.get("by_model") or [])[:3]) or "none"))
    out.append("Most expensive notes: " + ("; ".join(f"\"{short(r.get('title'), 50)}\" {f.money(r.get('cost_usd'))}"
                                                     for r in (llm.get("top_notes") or [])[:3]) or "none"))
    return out


def s_costs(d: dict, f: Fmt) -> list[str]:
    costs, sub, waste, en = d.get("costs") or {}, d.get("subscription") or {}, d.get("waste") or {}, d.get("energy") or {}
    out = [f"Costs ({costs.get('months', '-')} months of fixed costs fall in the range):",
           f"  Paid in total: {f.money(costs.get('total_usd'), True)} - subscriptions {f.money(costs.get('subscriptions_usd'))},"
           f" proxy {f.money(costs.get('proxy_usd'))}, electricity {f.money(costs.get('electricity_usd'))}, other {f.money(costs.get('other_usd'))}"]
    out += ranked(costs.get("items") or [], lambda r: f"{r.get('name')} ({r.get('kind')}): {f.money(r.get('usd'))}"
                  + (f" - {r['detail']}" if r.get("detail") else ""))
    if sub.get("plan_usd_month") is not None:
        out.append(f"  Subscription vs list prices: the work would have cost {f.money(sub.get('list_usd'))} at list prices,"
                   f" the plan ({sub.get('plan_name') or 'plan'}) cost {f.money(sub.get('plan_usd'))}"
                   f" - saved {f.money(sub.get('saved_usd'))}, {n(sub.get('ratio'))}x")
    out.append(f"  Waste: {f.money(waste.get('usd'))} - reruns {f.money(waste.get('rerun_usd'))} ({n(waste.get('rerun_runs'))} runs),"
               f" rejected notes {f.money(waste.get('rejected_usd'))} ({n(waste.get('rejected_notes'))});"
               f" {n(waste.get('failed_jobs'))} failed jobs, {n(waste.get('failed_cpu_h'))} CPU h")
    out.append(f"  Energy: machine {n(en.get('machine_kwh'))} kWh, jobs {n(en.get('jobs_kwh'))} kWh"
               + (f", costing {f.money(en.get('machine_cost'))}" if en.get("machine_cost") is not None else " (no kWh price set)"))
    return out


def _llm_row(f: Fmt, total: float):
    def line(r):
        share = f" ({100 * r['cost_usd'] / total:.0f}%)" if total and r.get("cost_usd") else ""
        return (f"{r.get('name')}: {f.money(r.get('cost_usd'))}{share} · {n(r.get('calls'))} calls"
                + (f" · {n(r['tokens'])} tokens" if r.get("tokens") is not None else ""))
    return line


def s_llm(d: dict, f: Fmt) -> list[str]:
    llm = d.get("llm") or {}
    line = _llm_row(f, float(llm.get("cost_usd") or 0))
    out = [f"LLM spend {f.money(llm.get('cost_usd'), True)} over {n(llm.get('calls'))} calls (API list prices)"
           + change(d, "llm_usd", f.money)]
    for key, what in (("by_model", "By model"), ("by_provider", "By provider"),
                      ("by_surface", "By kind of work (work = the rooms' agents, reply, build, chat...)"),
                      ("by_room", "By room ((no run) = outside a room's run)"), ("by_project", "By project")):
        out.append(what + ":")
        out += ranked(llm.get(key) or [], line)
    return out


def s_tokens(d: dict, f: Fmt) -> list[str]:
    tok, cache = (d.get("llm") or {}).get("tokens") or {}, d.get("cache") or {}
    total = sum(tok.values()) or 0
    out = [f"Tokens: {n(total)}{change(d, 'tokens', n)}"]
    out += [f"  {k}: {n(v)}" + (f" ({100 * v / total:.1f}%)" if total else "")
            for k, v in sorted(tok.items(), key=lambda kv: -kv[1])]
    out.append(f"Cache: hit ratio {pct(cache.get('hit_ratio'))}, read {n(cache.get('read'))}, written {n(cache.get('write'))},"
               f" fresh input {n(cache.get('fresh'))}; saved {f.money(cache.get('saved_usd'), True)} against paying full input price")
    out += ranked(cache.get("by_model") or [], lambda r: f"{r.get('name')}: saved {f.money(r.get('saved_usd'))},"
                  f" hit {pct(r.get('hit_ratio'))}, cache read {n(r.get('cache_read'))}")
    out.append("Tokens by model:")
    out += ranked((d.get("llm") or {}).get("by_model") or [], lambda r: f"{r.get('name')}: {n(r.get('tokens'))}")
    return out


def s_runs(d: dict, f: Fmt) -> list[str]:
    work, b, comp = d.get("work") or {}, d.get("builds") or {}, d.get("compute") or {}
    st = work.get("status") or {}
    out = ["Notes by state: " + (", ".join(f"{v} {k}" for k, v in st.items()) or "none")]
    out.append("Agent runs by room:")
    out += ranked(work.get("runs_by_room") or [], lambda r: f"{r.get('room')}: {n(r.get('runs'))} runs, {n(r.get('done'))} done,"
                  f" avg {secs(r.get('avg_s'))}")
    q = work.get("questions") or {}
    if q.get("asked"):
        out.append(f"Agents' questions: {n(q.get('asked'))} asked, {n(q.get('answered'))} answered, avg wait {secs(q.get('avg_wait_s'))}")
    out.append(f"Jobs: {n(comp.get('count'))}{change(d, 'jobs', n)}, {n(comp.get('failed'))} failed, wall {secs(comp.get('wall_s'))},"
               f" CPU {secs(comp.get('cpu_s'))}. By kind:")
    out += ranked(b.get("by_kind") or [], lambda r: f"{r.get('name')}: {n(r.get('jobs'))} jobs, {n(r.get('failed'))} failed"
                  f" ({pct(r.get('fail_rate'))}), median {secs(r.get('median_s'))}, longest {secs(r.get('max_s'))}")
    out.append("Slowest models to build:")
    out += ranked(b.get("by_model") or [], lambda r: f"{r.get('name')}: median {secs(r.get('median_s'))},"
                  f" longest {secs(r.get('max_s'))}, {n(r.get('builds'))} builds", 5)
    loops = (d.get("loops") or {}).get("jobs") or []
    if loops:
        out.append("Jobs run over and over for one note:")
        out += ranked(loops, lambda r: f"{r.get('id')} \"{short(r.get('title'), 60)}\": {r.get('kind')} x{n(r.get('runs'))},"
                      f" {n(r.get('failed'))} failed, {secs(r.get('wall_s'))}", 5)
    return out


def _notes_rows(d: dict, project: str) -> list[dict]:
    rows = (d.get("llm") or {}).get("top_notes") or []
    return [r for r in rows if r.get("project") == project] if project else rows


def s_notes(d: dict, f: Fmt, project: str = "") -> list[str]:
    nc = d.get("note_costs") or {}
    out = [f"Note cost: {n(nc.get('notes'))} notes, median {f.money(nc.get('median'))}, mean {f.money(nc.get('mean'))}",
           "Most expensive notes" + (f" of {project}" if project else "") + " (id, title, room, project):"]
    out += ranked(_notes_rows(d, project), lambda r: f"{r.get('id')} \"{short(r.get('title'))}\" - {f.money(r.get('cost_usd'))},"
                  f" {n(r.get('calls'))} calls, {n(r.get('tokens'))} tokens · {r.get('room') or '-'} · {r.get('project') or '-'}"
                  + (" · approximate" if r.get("approximate") else ""), 10)
    return out


def s_api(d: dict, f: Fmt) -> list[str]:
    api, up, lat = d.get("api") or {}, d.get("uptime") or {}, d.get("db_latency") or {}
    out = [f"API: {n(api.get('requests'))} requests, {n(api.get('errors'))} errors (5xx)",
           f"Uptime {pct((up.get('up_pct') or 0) / 100) if up.get('up_pct') is not None else '-'},"
           f" {n(up.get('down_minutes'))} min unwatched, {len(up.get('starts') or [])} server starts;"
           f" database round trip median {n(lat.get('median_ms'))} ms, p95 {n(lat.get('p95_ms'))} ms",
           "Busiest routes:"]
    routes = api.get("routes") or []
    out += ranked(sorted(routes, key=lambda r: -(r.get("count") or 0)), lambda r: f"{r.get('route')}: {n(r.get('count'))},"
                  f" avg {n(r.get('avg_ms'))} ms, p95 {n(r.get('p95_ms'))} ms, {n(r.get('errors'))} errors", 6)
    out.append("Slowest routes:")
    out += ranked(sorted(routes, key=lambda r: -(r.get("avg_ms") or 0)), lambda r: f"{r.get('route')}: avg {n(r.get('avg_ms'))} ms,"
                  f" max {n(r.get('max_ms'))} ms, {n(r.get('count'))} calls", 5)
    errs = up.get("error_routes") or []
    if errs:
        out.append("Routes with errors:")
        out += ranked(errs, lambda r: f"{r.get('route')}: {n(r.get('errors'))} errors of {n(r.get('count'))}", 5)
    return out


def s_budget(d: dict, f: Fmt) -> list[str]:
    b = d.get("budget_status") or {}
    m = b.get("month_so_far") or {}
    out = [f"Month {b.get('month', '-')}: day {n(b.get('days_elapsed'))} of {b.get('days_in_month', '-')}"
           + (f", state {b['state']}" if b.get("state") else ""),
           f"  So far: {f.money(m.get('total_usd'), True)} paid (fixed {f.money(m.get('fixed_usd'))}, proxy {f.money(m.get('proxy_usd'))},"
           f" electricity {f.money(m.get('electricity_usd'))}); forecast for the month {f.money(m.get('forecast_usd'))}",
           f"  LLM at list prices: {f.money(m.get('llm_usd'))} so far, {f.money(m.get('llm_7d_per_day_usd'))} a day lately,"
           f" {f.money(m.get('llm_forecast_usd'))} by month end" + ("" if m.get("llm_in_total") else " (covered by a plan, not in the total)")]
    items = b.get("items") or []
    if not items:
        out.append("  No budget is set (Settings > Costs & currency).")
    for it in items:
        if it.get("error"):
            out.append(f"  {it.get('name')}: {it['error']}")
            continue
        out.append(f"  {it.get('name')} budget {f.money(it.get('budget_usd'))}: spent {f.money(it.get('spent_usd'))} ({pct(it.get('ratio'))},"
                   f" {it.get('state')}), forecast {f.money(it.get('forecast_usd'))} ({pct(it.get('forecast_ratio'))}, {it.get('forecast_state')})"
                   + (f" - {it['missing']}" if it.get("missing") else ""))
    return out


def s_project(d: dict, f: Fmt, name: str) -> list[str]:
    p = (d.get("project_detail") or {}).get(name) or {}
    items = sorted(p.get("items") or [], key=lambda i: -(i.get("spend_usd") or 0))
    out = [f"Project {name}: LLM spend on its notes {f.money(p.get('spend_usd'), True)} · {n(p.get('notes'))} notes (all time) ·"
           f" {n(p.get('runs'))} runs · {n(p.get('jobs'))} jobs, {n(p.get('failed'))} failed · {len(items)} items",
           "Its items by spend:"]
    out += ranked(items, lambda i: f"{i.get('kind')} {i.get('id')} \"{short(i.get('title'), 50)}\": {f.money(i.get('spend_usd'))},"
                  f" {n(i.get('notes'))} notes, {n(i.get('runs'))} runs, {n(i.get('jobs'))} jobs ({n(i.get('failed'))} failed),"
                  f" median build {secs(i.get('job_median_s'))}")
    return out


DO = {"overview": s_overview, "costs": s_costs, "llm": s_llm, "tokens": s_tokens, "runs": s_runs,
      "api": s_api, "budget": s_budget}


async def figures(db, rng: str) -> dict:
    """The page's own answer: GET /api/insights?range=rng, as main.py works it out."""
    async def span():
        since, until = insights.parse_range(rng)
        if rng == "all":
            since = await insights.first_use(db) or since
        return since, until
    d = await insights.overview_cached(db, rng, span)
    # The page shows a kept answer and asks again while a fresh one is
    # worked out; a model gets one look, so it waits for the fresh one
    # when the kept one is more than a minute old.
    end = time.monotonic() + FRESH_WAIT
    while d.get("stale") and (d.get("age_s") or 0) > 60 and time.monotonic() < end:
        await asyncio.sleep(2)
        d = await insights.overview_cached(db, rng, span)
        if (d.get("age_s") or 0) <= 60:
            break
    return d


async def run(ctx: Ctx, args: dict) -> Result:
    need("GET", "/api/insights")
    rng = str(args.get("range") or "7d").strip().lower()
    rng = {"1d": "24h", "day": "24h", "week": "7d", "month": "30d", "1w": "7d"}.get(rng, rng)
    if rng not in RANGES:
        raise ToolError(f"range is one of {', '.join(RANGES)}")
    section = str(args.get("section") or "").strip().lower()
    section = {"builds": "runs", "cache": "tokens", "requests": "api", "spend": "costs"}.get(section, section)
    if section and section not in SECTIONS:
        raise ToolError(f"section is one of {', '.join(SECTIONS)}")
    d = await figures(ctx.db, rng)
    projects = sorted((d.get("project_detail") or {}).keys())
    project = str(args.get("project") or "").strip()
    if project:
        hit = next((p for p in projects if p.lower() == project.lower()), None)
        if not hit:
            raise ToolError(f"no project {project!r}; the projects are: {', '.join(projects) or 'none'}")
        project = hit
    f = Fmt(d.get("fx") or {})

    r = d.get("range") or {}
    head = [f"Analytics for {SAID[rng]} ({str(r.get('since', ''))[:16].replace('T', ' ')} to "
            f"{str(r.get('until', ''))[:16].replace('T', ' ')} UTC) · {f.rates_line()}"
            + (f" · figures from {d['computed_at'][:16].replace('T', ' ')} UTC" if d.get("computed_at") else ""),
            "LLM money is at API list prices: on a subscription it is what the same work would have cost, not what was paid."]
    body: list[str] = []
    if project:
        body += s_project(d, f, project) + [""] + s_notes(d, f, project)
        if section and section != "notes":
            body += ["", f"(the {section} figures below are the whole workspace's, not only {project}'s)", ""]
            body += DO[section](d, f)
    elif section == "notes":
        body += s_notes(d, f)
    elif section:
        body += DO[section](d, f)
    else:
        body += s_overview(d, f)
        if projects:
            body.append("Projects: " + ", ".join(projects))
        body.append("Ask again with a section (costs, llm, tokens, runs, notes, api, budget) or a project for more.")
    link = app_links.analytics(rng, project)
    text = "\n".join(head + [""] + body + ["", f"Open Analytics: {link}"])

    llm = d.get("llm") or {}
    summary = (f"{SAID[rng]}: LLM {f.money(llm.get('cost_usd'))} · {n(llm.get('calls'))} calls · "
               f"{n(sum((llm.get('tokens') or {}).values()))} tokens"
               + (f" · project {project}" if project else "") + (f" · {section}" if section else ""))
    vars_ = {"range": rng, "section": section or "overview", "project": project}
    say = "Read Analytics for {project}, {range}" if project else "Read Analytics: {section}, {range}"
    return Result(text=clip(text, 12_000), say=say, vars=vars_, summary=summary)


TOOL = Tool(
    name="analytics_read", package="general", level="read", order=80,
    label="Read Analytics",
    about="Reads the Analytics room's figures: spend, models, tokens and cache, builds, notes, API, budget.",
    description="Read this workspace's Analytics (the Analytics room's own figures) over a range: LLM spend at API "
                "list prices and what was actually paid, by model, provider, room, kind of work and project; tokens "
                "by type and what the cache saved; agent runs, jobs and build times; the most expensive notes; API "
                "requests and errors; the month's budget and forecast. Headline figures come with the change against "
                "the period before of the same length; amounts are in the workspace's display currency. Without "
                "`section` it gives a compact overview of everything; with one, that part in full. `project` gives "
                "one project's items and figures. Use it for questions like \"how much did I spend this week\", "
                "\"which model is the most expensive\", \"where did my tokens go\", \"how long do builds take\".",
    schema={"type": "object", "properties": {
        "range": {"type": "string", "enum": list(RANGES), "description": "The period (default 7d)"},
        "section": {"type": "string", "enum": list(SECTIONS),
                    "description": "One part in full: overview, costs (paid, subscriptions, waste, energy), llm (by model/"
                                   "provider/room/kind of work/project), tokens (by type, cache), runs (runs, jobs, builds), "
                                   "notes (most expensive), api (requests, errors, latency), budget (the month's)"},
        "project": {"type": "string", "description": "Only this project (its name as Analytics lists it)"}}},
    running="Reading Analytics", failed="Could not read Analytics",
    run=run)
