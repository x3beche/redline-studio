"""Card summaries: output cleaning, the length retry, failure, and the rule
that a hand-written sentence is never replaced.

The model is never called here; every test stubs the HTTP layer.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import summarise as S


def reply(text: str, cost: float = 0.0002) -> dict:
    return {"choices": [{"message": {"content": text}}],
            "usage": {"prompt_tokens": 320, "completion_tokens": 20,
                      "total_tokens": 340, "cost": cost}}


# ---------------- cikti temizleme ----------------
@pytest.mark.parametrize("raw,want", [
    ("Yaziyi kucult ve ortala", "Yaziyi kucult ve ortala"),
    ('  "Yaziyi kucult"  ', "Yaziyi kucult"),
    ("Özet: Yuvayi kucult", "Yuvayi kucult"),
    ('"Özet: Yuvayi kucult"', "Yuvayi kucult"),
    ("Summary - Fani kucult", "Fani kucult"),
    ("Ilk cumle\nikinci satir", "Ilk cumle"),
    ("Yuvayi    kucult", "Yuvayi kucult"),
    ("“Boslugu doldur”", "Boslugu doldur"),
    ("", ""),
    (None, ""),
])
def test_clean(raw, want):
    assert S.clean(raw) == want


def test_word_count_ignores_extra_spaces():
    assert S.word_count("  bir   iki uc ") == 3
    assert S.word_count("") == 0


# ---------------- normal yol ----------------
@pytest.mark.asyncio
async def test_summarise_returns_clean_sentence(monkeypatch):
    calls = []

    async def fake_post(messages):
        calls.append(messages)
        return reply('  "Özet: Yaziyi kucult ve ortala"  ')

    monkeypatch.setattr(S, "_post", fake_post)
    text, usage = await S.summarise("bu yazinin fontunu birazcik dusurelim")
    assert text == "Yaziyi kucult ve ortala"
    assert usage["cost"] == 0.0002
    assert len(calls) == 1
    assert calls[0][0]["role"] == "system"
    assert calls[0][0]["content"] == S.SYSTEM_PROMPT       # onek birebir sabit


@pytest.mark.asyncio
async def test_image_is_attached_and_shrunk(monkeypatch):
    from PIL import Image
    import io

    buf = io.BytesIO()
    Image.new("RGB", (1600, 900), "white").save(buf, format="PNG")
    seen = {}

    async def fake_post(messages):
        seen["content"] = messages[1]["content"]
        return reply("Kirmizi alani doldur")

    monkeypatch.setattr(S, "_post", fake_post)
    await S.summarise("bu kisimdaki yeri fill edelim", buf.getvalue())
    kinds = [c["type"] for c in seen["content"]]
    assert kinds == ["text", "image_url"]
    url = seen["content"][1]["image_url"]["url"]
    assert url.startswith("data:image/jpeg;base64,")


def test_shrink_keeps_the_long_edge_within_the_limit():
    from PIL import Image
    import io

    buf = io.BytesIO()
    Image.new("RGB", (1600, 900), "white").save(buf, format="PNG")
    small = Image.open(io.BytesIO(S.shrink_png(buf.getvalue())))
    assert max(small.size) == S.IMAGE_EDGE


# ---------------- uzunluk kontrolu ----------------
@pytest.mark.asyncio
async def test_too_long_is_asked_once_more(monkeypatch):
    answers = ["bir iki uc dort bes alti yedi sekiz dokuz on onbir oniki onuc",
               "Yuvayi kucult ve ortala"]

    async def fake_post(messages):
        return reply(answers.pop(0))

    monkeypatch.setattr(S, "_post", fake_post)
    text, _ = await S.summarise("uzun bir talimat")
    assert text == "Yuvayi kucult ve ortala"
    assert answers == []                                   # iki cagri yapildi


@pytest.mark.asyncio
async def test_still_long_after_retry_is_kept_whole(monkeypatch):
    long = "bir iki uc dort bes alti yedi sekiz dokuz on onbir oniki onuc"

    async def fake_post(messages):
        return reply(long)

    monkeypatch.setattr(S, "_post", fake_post)
    text, _ = await S.summarise("uzun bir talimat")
    assert text == long                                    # kesilmiyor


# ---------------- hata yolu ----------------
@pytest.mark.asyncio
async def test_retries_then_gives_up(monkeypatch):
    tries = {"n": 0}

    class Boom:
        status_code = 429
        text = "rate limited"

        def raise_for_status(self):
            raise AssertionError("should not get here")

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **k):
            tries["n"] += 1
            return Boom()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(S.asyncio, "sleep", lambda *_: _done())

    async def _done():
        return None

    with pytest.raises(RuntimeError, match="after 3 tries"):
        await S._post([{"role": "system", "content": "x"}])
    assert tries["n"] == S.RETRIES + 1


@pytest.mark.asyncio
async def test_missing_key_is_an_error(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY"):
        await S._post([])


def test_cost_over_budget_warns(caplog):
    with caplog.at_level("WARNING", logger="x3.summarise"):
        S._report_usage({"usage": {"cost": S.BUDGET_USD * 2}})
    assert "over the" in caplog.text


def test_cost_within_budget_is_quiet(caplog):
    with caplog.at_level("WARNING", logger="x3.summarise"):
        S._report_usage({"usage": {"cost": 0.0002}})
    assert "over the" not in caplog.text
