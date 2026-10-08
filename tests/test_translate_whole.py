"""A note translated into English keeps all of itself.

A multi-line note came back as its title: the translation went through
clean(), which is for one-sentence summaries and keeps only the first line.
And a long note could be cut by a fixed 400-token budget."""

from __future__ import annotations

import pytest

from backend import summarise

NOTE = ("OLED: STEP'in kendi renkleri + arkadan vidalı tutucu\n\n"
        "**Renkler:** oled_091 STEP'teki orijinal renkleriyle görünsün.\n"
        "- M2 vida + insert\n- Ender 3 V3 SE'de desteksiz basılabilsin")
EN = ("OLED: the STEP's own colours + a screwed holder from behind\n\n"
      "**Colours:** show oled_091 in the STEP's original colours.\n"
      "- M2 screw + insert\n- printable without supports on an Ender 3 V3 SE")


def _fake(answer: str, finish: str = "stop", seen: dict | None = None):
    async def post(messages, max_tokens=0, job=""):
        if seen is not None:
            seen["max_tokens"] = max_tokens
        return {"choices": [{"message": {"content": answer}, "finish_reason": finish}],
                "usage": {}, "provider": "x", "model": "y"}
    return post


@pytest.mark.asyncio
async def test_every_line_of_the_note_survives(monkeypatch):
    monkeypatch.setattr(summarise, "_post", _fake(EN))
    out, _ = await summarise.translate(NOTE)
    assert out == EN and out.count("\n") == EN.count("\n")


@pytest.mark.asyncio
async def test_a_fence_or_label_around_it_is_taken_off(monkeypatch):
    monkeypatch.setattr(summarise, "_post", _fake("Translation:\n```\n" + EN + "\n```"))
    out, _ = await summarise.translate(NOTE)
    assert out.strip("`\n") .endswith("Ender 3 V3 SE") and "Translation" not in out


@pytest.mark.asyncio
async def test_a_cut_translation_keeps_the_original(monkeypatch):
    monkeypatch.setattr(summarise, "_post", _fake(EN[:40], finish="length"))
    out, _ = await summarise.translate(NOTE)
    assert out == NOTE


@pytest.mark.asyncio
async def test_a_long_note_gets_room(monkeypatch):
    seen = {}
    monkeypatch.setattr(summarise, "_post", _fake("ok", seen=seen))
    await summarise.translate("x " * 3000)
    assert seen["max_tokens"] > summarise.TRANSLATE_TOKENS
    assert seen["max_tokens"] <= summarise.TRANSLATE_TOKENS_MAX


def test_clean_translation_keeps_lines():
    assert summarise.clean_translation(EN) == EN
    assert summarise.clean_translation('"Make it 2 mm."') == "Make it 2 mm."
