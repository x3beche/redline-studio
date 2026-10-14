"""A model's technical drawing is made by itself a while after its build
(backend/release.py draw_later): only after the last of several builds in a
row, and a failure there is only printed."""

from __future__ import annotations

import asyncio

from backend import release


def test_only_the_last_build_in_a_row_is_drawn(monkeypatch):
    drawn: list[str] = []
    autos: list = []

    async def fake(db, model_id, tag="", **kw):
        drawn.append(model_id)
        autos.append(kw.get("auto"))
        return b"%PDF"

    monkeypatch.setattr(release, "model_drawing", fake)
    monkeypatch.setattr(release, "DRAW_AFTER_BUILD_S", 0.05)

    async def run():
        release.draw_later(None, "p/a")
        await asyncio.sleep(0.02)
        release.draw_later(None, "p/a")          # built again: the wait starts over
        release.draw_later(None, "p/b")
        await asyncio.sleep(0.2)

    asyncio.run(run())
    assert sorted(drawn) == ["p/a", "p/b"]
    assert autos == [True, True]                 # the background's: told only if it fails (notifications)
    assert release._DRAW_LATER == {}


def test_a_failed_drawing_does_not_raise(monkeypatch, capsys):
    async def broken(db, model_id, tag="", **kw):
        raise RuntimeError("the drawing image is not built")

    monkeypatch.setattr(release, "model_drawing", broken)
    monkeypatch.setattr(release, "DRAW_AFTER_BUILD_S", 0)

    async def run():
        release.draw_later(None, "p/c")
        await asyncio.sleep(0.05)

    asyncio.run(run())
    assert "not built" in capsys.readouterr().out
