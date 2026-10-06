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


class SettingsIn(BaseModel):
    # provider -> key; "" or null clears it. Left out: unchanged.
    keys: dict[str, str | None] | None = None
    jobs: dict[str, Route] | None = None


@router.put("/settings")
async def put_settings(body: SettingsIn) -> dict:
    try:
        out = await llm.save(_db(), body.keys, {j: r.model_dump() for j, r in (body.jobs or {}).items()})
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    changed = [f"key {p} {'set' if v else 'cleared'}" for p, v in (body.keys or {}).items()]
    changed += [f"{j} -> {r.provider}/{r.model}" for j, r in (body.jobs or {}).items()]
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
