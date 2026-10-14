"""The Analytics overview with Chat calls read from the prompt cache: what
the cache saved is priced at the Claude API's own rates (llm.cache_rates)
for a model the Claude Code price list does not hold. A stand-in database
answers every query empty but the LLM call log's."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from backend import insights


class Cur:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, *a, **k):
        return self

    async def to_list(self, *a, **k):
        return list(self.rows)

    def __aiter__(self):
        async def gen():
            for r in self.rows:
                yield r
        return gen()


class Coll:
    def __init__(self, name):
        self.name = name

    def find(self, *a, **k):
        return Cur([])

    async def find_one(self, *a, **k):
        return None

    async def count_documents(self, *a, **k):
        return 0

    async def replace_one(self, *a, **k):
        return None

    async def update_one(self, *a, **k):
        return None

    async def insert_one(self, *a, **k):
        return None

    def aggregate(self, pipeline):
        if self.name != insights.usage.CALLS or "$facet" not in str(pipeline):
            return Cur([])
        row = {"input": 1_000, "output": 200, "cache_read": 900_000, "cache_write": 50_000, "thinking": 0}
        model = {"_id": "claude-haiku-5-5", "calls": 3, "cost": 0.02, "tokens": sum(row.values()), **row}
        return Cur([{"total": [{"_id": None, "calls": 3, "cost": 0.02, "unpriced": 0, **row}],
                     "buckets": [], "model": [model], "provider": [], "kind": [], "revision": [], "run": [],
                     "bucket_rev": []}])


class Db:
    workspace = "default"

    def __getitem__(self, name):
        return Coll(name)

    def __getattr__(self, name):
        return Coll(name)

    async def command(self, *a):
        return {}

    async def list_collection_names(self):
        return []


def test_the_cache_savings_of_a_chat_model_are_priced(monkeypatch):
    async def nothing(*a, **k):
        return {}

    async def none_list(*a, **k):
        return []

    async def projects(db):
        return {}, {}
    monkeypatch.setattr(insights, "_projects", projects)
    monkeypatch.setattr(insights, "docker_usage", nothing)
    monkeypatch.setattr(insights, "_grid_files", none_list)
    until = datetime.now(timezone.utc)
    try:
        got = asyncio.run(insights.overview(Db(), until - timedelta(days=7), until))
    except Exception as exc:                           # noqa: BLE001 - say which part the stand-in lacks
        pytest.fail(f"overview failed: {type(exc).__name__}: {exc}")
    cache = got["cache"] if "cache" in got else got["llm"]["cache"]
    (m,) = cache["by_model"]
    # Haiku 5.5: $0.10 a million fresh, $0.01 read back - 900K read saved $0.081
    assert m["name"] == "claude-haiku-5-5" and m["saved_usd"] == pytest.approx(0.081)
    assert cache["read"] == 900_000
