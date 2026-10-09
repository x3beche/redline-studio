"""Preferences > LLM settings: the keys, and which model does which job.

The page sees whether a key is set and its last four characters; the key
itself goes one way only, from the page to the server (backend/llm.py).
Changing any of it is a workspace owner's or admin's ("settings").
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import actors, llm

router = APIRouter(prefix="/api/llm")


def _db():
    from .main import db
    return db()


@router.get("/settings")
async def get_settings() -> dict:
    return llm.public()


class Route(BaseModel):
    provider: str = Field(max_length=40)
    model: str = Field(min_length=1, max_length=200)
    # A switched job's (llm.JOBS "switch"): on/off, and seconds of quiet
    # before it runs. Left out: unchanged.
    on: bool | None = None
    delay: int | None = None


class SettingsIn(BaseModel):
    # provider -> key; "" or null clears it. Left out: unchanged.
    keys: dict[str, str | None] | None = None
    jobs: dict[str, Route] | None = None


@router.put("/settings")
async def put_settings(body: SettingsIn) -> dict:
    try:
        out = await llm.save(_db(), body.keys, {j: r.model_dump(exclude_none=True) for j, r in (body.jobs or {}).items()})
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    changed = [f"key {p} {'set' if v else 'cleared'}" for p, v in (body.keys or {}).items()]
    changed += [f"{j} -> {r.provider}/{r.model}" + (f" on={r.on}" if r.on is not None else "")
                + (f" delay={r.delay}s" if r.delay is not None else "") for j, r in (body.jobs or {}).items()]
    if changed:
        llm._models_cache.clear()                     # a new key may see other models
        await actors.audit(_db(), "settings", "llm", {"changed": changed})
    return out


@router.get("/models")
async def get_models(provider: str) -> list[dict]:
    if provider not in llm.PROVIDERS:
        raise HTTPException(400, f"unknown provider {provider!r}")
    try:
        return await llm.models(provider)
    except Exception as exc:                           # noqa: BLE001
        raise HTTPException(502, f"{llm.PROVIDERS[provider]['name']}: the model list did not come: {exc}"[:300]) from exc


class TestIn(BaseModel):
    provider: str = Field(max_length=40)
    model: str = Field(min_length=1, max_length=200)


@router.post("/test")
async def test(body: TestIn) -> dict:
    """A one-word answer from the model, to show the key and the model work."""
    import time
    if body.provider not in llm.PROVIDERS:
        raise HTTPException(400, f"unknown provider {body.provider!r}")
    t0 = time.monotonic()
    try:
        d = await llm.complete([{"role": "user", "content": "Reply with exactly: OK"}],
                               provider=body.provider, model=body.model, max_tokens=16,
                               temperature=0, timeout=60)
    except Exception as exc:                           # noqa: BLE001
        return {"ok": False, "error": str(exc)[:400], "ms": round((time.monotonic() - t0) * 1000)}
    text = (d["choices"][0]["message"]["content"] or "").strip()
    await llm.record(_db(), provider=body.provider, model=body.model, surface="settings",
                     kind="llm-test", used=d.get("usage") or {})
    return {"ok": True, "answer": text[:80], "ms": round((time.monotonic() - t0) * 1000)}


# ---------------- usage, for Settings > LLM ----------------

def _buckets(days: int) -> tuple[int, int, int, float]:
    """(step, t0, n, since) for a period of `days`: hourly up to two days, daily beyond."""
    import math
    import time as _t
    step = 3600 if days <= 2 else 86400
    now = _t.time()
    t0 = int((now - days * 86400) // step * step)
    n = max(1, math.ceil((now - t0) / step))
    return step, t0, n, now - days * 86400


def _series(names: list[str], n: int) -> dict[str, list]:
    return {k: [0] * n for k in names}


_account_cache: dict[str, tuple[float, dict | None]] = {}


async def _openrouter_account() -> dict | None:
    """OpenRouter's own figures for the key: used, limit, remaining (USD)."""
    import time as _t
    import httpx
    hit = _account_cache.get("openrouter")
    if hit and _t.time() - hit[0] < 60:
        return hit[1]
    key = llm.key("openrouter")
    out = None
    if key:
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                r = await client.get(llm.PROVIDERS["openrouter"]["base"] + "/key",
                                     headers={"Authorization": f"Bearer {key}"})
            if r.status_code < 400:
                d = r.json().get("data") or {}
                out = {k: d.get(k) for k in ("label", "usage", "limit", "limit_remaining", "is_free_tier")}
        except Exception:                              # noqa: BLE001 - the page shows the rest
            out = None
    _account_cache["openrouter"] = (_t.time(), out)
    return out


@router.get("/usage")
async def usage(provider: str = "all", days: int = 30) -> dict:
    """What the app asked of one provider, or of both ("all"): calls, tokens
    and money over time, by job, by model and by provider (from the usage
    log every call writes to), this space's own. Jobs are named as in
    "Which model does what"."""
    from datetime import datetime, timezone

    from . import usage as _usage

    if provider != "all" and provider not in llm.PROVIDERS:
        raise HTTPException(400, f"unknown provider {provider!r}")
    provs = list(llm.PROVIDERS) if provider == "all" else [provider]
    days = max(1, min(days, 90))
    step, t0, n, since = _buckets(days)
    since_iso = datetime.fromtimestamp(since, timezone.utc).isoformat()
    raw = _db().raw if getattr(type(_db()), "SCOPED", False) else _db()
    rows = [r async for r in raw[_usage.CALLS].find(
        {"$and": [{"provider": {"$in": provs}, "at": {"$gte": since_iso}}, _usage.of_space()]},
        {"_id": 0, "at": 1, "provider": 1, "kind": 1, "model": 1, "input": 1, "output": 1,
         "cost_usd": 1}).sort("at", 1)]
    for r in rows:
        r["job"] = llm.job_label(r.get("kind"))

    kinds = sorted({r["job"] for r in rows})
    models = sorted({r.get("model") or "?" for r in rows})
    calls, cost = _series(kinds, n), {m: [None] * n for m in models}
    tokens = _series(["input", "output"], n)
    by_model: dict[str, dict] = {}
    by_kind: dict[str, dict] = {}
    by_provider: dict[str, dict] = {}
    totals = {"calls": 0, "input": 0, "output": 0, "cost_usd": None, "unpriced_calls": 0}
    for r in rows:
        try:
            ts = datetime.fromisoformat(r["at"]).timestamp()
        except (KeyError, ValueError, TypeError):
            continue
        i = min(n - 1, max(0, int((ts - t0) // step)))
        kind, model = r["job"], r.get("model") or "?"
        pname = llm.PROVIDERS.get(r.get("provider"), {}).get("name") or r.get("provider") or "?"
        inp, out, usd = r.get("input") or 0, r.get("output") or 0, r.get("cost_usd")
        calls[kind][i] += 1
        tokens["input"][i] += inp
        tokens["output"][i] += out
        totals["calls"] += 1
        totals["input"] += inp
        totals["output"] += out
        if usd is None:
            totals["unpriced_calls"] += 1
        else:
            cost[model][i] = (cost[model][i] or 0) + usd
            totals["cost_usd"] = (totals["cost_usd"] or 0) + usd
        for table, name in ((by_model, model), (by_kind, kind), (by_provider, pname)):
            row = table.setdefault(name, {"name": name, "calls": 0, "input": 0, "output": 0, "cost_usd": None})
            row["calls"] += 1
            row["input"] += inp
            row["output"] += out
            if usd is not None:
                row["cost_usd"] = (row["cost_usd"] or 0) + usd

    def td(series: dict) -> dict:
        return {"t0": t0, "step": step, "n": n, "series": [{"name": k, "values": v} for k, v in series.items()]}

    recent = [{**{k: r.get(k) for k in ("at", "kind", "job", "model", "input", "output", "cost_usd")},
               "provider": llm.PROVIDERS.get(r.get("provider"), {}).get("name") or r.get("provider")}
              for r in reversed(rows[-25:])]
    unpriced = [llm.PROVIDERS[p]["name"] for p in provs if not llm.PROVIDERS[p].get("priced")]
    return {"provider": provider, "days": days, "step": step, "totals": totals,
            "unpriced_providers": unpriced,
            "by_provider": sorted(by_provider.values(), key=lambda x: -x["calls"]),
            "calls": td(calls), "tokens": td(tokens), "cost": td(cost),
            "by_model": sorted(by_model.values(), key=lambda x: -x["calls"]),
            "by_kind": sorted(by_kind.values(), key=lambda x: -x["calls"]),
            "recent": recent,
            "account": await _openrouter_account_new() if "openrouter" in provs else None}


async def _openrouter_account_new() -> dict | None:
    """The key's figures from llm.or_account, in the usage panel's old shape."""
    d = await llm.or_account()
    k = d.get("key") if d.get("shared") else None
    return {kk: k.get(kk) for kk in ("label", "usage", "limit", "limit_remaining", "is_free_tier")} if k else None


# ---------------- the Command Code account ----------------

@router.get("/commandcode/account")
async def commandcode_account(refresh: bool = False) -> dict:
    """The Command Code account the saved key belongs to: plan, the 5-hour
    and weekly windows, credits, the period's requests, and 14 days of the
    weekly window for a chart (backend/llm.py cc_account). Anyone who may
    see LLM settings may see it; the account's email only the owner, and
    only a person - not an agent's page session. Never the key."""
    from . import access

    try:
        d = await llm.cc_account(_db(), force=refresh)
    except Exception as exc:                           # noqa: BLE001 - say so, not a 500
        llm.log.warning("Command Code account failed: %s", type(exc).__name__)
        d = {"set": bool(llm.key("commandcode")), "shared": False}
    out = {k: v for k, v in d.items()}
    acct = out.get("account")
    if isinstance(acct, dict):
        who = actors.current()
        owner = access.current() == "owner" and who.get("type") in (None, "user") and not who.get("page")
        out["account"] = {k: v for k, v in acct.items() if k != "email" or owner}
    out["history"] = []
    out["weekly_kind"] = "unknown"
    if out.get("set"):
        try:
            raw = _db().raw if getattr(type(_db()), "SCOPED", False) else _db()
            out["history"] = await llm.cc_history(raw)
            out["weekly_kind"] = llm.cc_window_kind(out["history"])
        except Exception as exc:                       # noqa: BLE001 - the figures still show
            llm.log.warning("Command Code history not read: %s", type(exc).__name__)
    return out



@router.get("/commandcode/analysis")
async def commandcode_analysis(refresh: bool = False) -> dict:
    """The billing period analysed: spend per day (from Command Code's own
    totals, a day at a time), the burn rate and where it leads, the weekly
    window, and how much of it was Redline's (backend/llm.py cc_analysis)."""
    try:
        return await llm.cc_analysis(_db(), force=refresh)
    except Exception as exc:                           # noqa: BLE001 - say so, not a 500
        llm.log.warning("Command Code analysis failed: %s", type(exc).__name__)
        return {"set": bool(llm.key("commandcode")), "shared": False}




@router.get("/providers/{provider}/account")
async def provider_account(provider: str, refresh: bool = False) -> dict:
    """One provider's own account figures (backend/llm.py REGISTRY), and -
    for a provider that prices its calls - what Redline itself spent there.
    Never the key."""
    if provider not in llm.REGISTRY:
        raise HTTPException(404, f"unknown provider {provider!r}")
    if provider == "commandcode":
        return await commandcode_account(refresh=refresh)
    try:
        out = dict(await llm.provider_account(_db(), provider, force=refresh))
    except Exception as exc:                           # noqa: BLE001 - say so, not a 500
        llm.log.warning("%s account failed: %s", provider, type(exc).__name__)
        out = {"set": bool(llm.key(provider)), "shared": False}
    try:
        raw = _db().raw if getattr(type(_db()), "SCOPED", False) else _db()
        out["redline"] = await llm.own_spend(raw, provider)
    except Exception as exc:                           # noqa: BLE001
        llm.log.warning("%s: Redline's own spend not read: %s", provider, type(exc).__name__)
        out["redline"] = None
    return out
