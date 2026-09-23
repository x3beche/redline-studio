"""LCSC search: what comes back, and what is not asked for.

The search is somebody else's service, so the test does not call it. What
is worth pinning is the shape this puts around it - a part number is a
part number, a row is normalised the same way whatever LCSC calls its
fields, and nothing without a number gets through to a fetch.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import lcsc


def test_a_part_number_is_c_and_digits():
    assert lcsc.looks_like_a_part("C368196")
    assert lcsc.looks_like_a_part(" C25744 ")


def test_anything_else_is_not():
    for text in ("", None, "R0402", "368196", "C12", "C1234567890123",
                 "C25744; rm -rf", "0603 100nF"):
        assert not lcsc.looks_like_a_part(text), text


def test_search_normalises_a_row(monkeypatch):
    # What LCSC actually sends back, trimmed to the fields that are read.
    body = {"result": {"productList": [
        {"number": "C8734", "mpn": "STM32F103C8T6", "package": "LQFP-48",
         "manufacturer": "ST", "stock": 69161,
         "price": [[1, "1.6255", "1.6255"], [10, "1.50", "1.50"]]},
        {"number": "not-a-part", "mpn": "x"},
    ]}}
    monkeypatch.setattr(lcsc, "_ask", lambda url: body, raising=False)

    rows = asyncio.run(lcsc.search("stm32", 5))
    assert len(rows) == 1, "the row without a part number is dropped"
    row = rows[0]
    assert row == {"lcsc": "C8734", "mpn": "STM32F103C8T6",
                   "package": "LQFP-48", "maker": "ST", "stock": 69161,
                   "price": 1.6255}


def test_search_takes_the_first_price_band(monkeypatch):
    monkeypatch.setattr(lcsc, "_ask", lambda url: {"result": {"productList": [
        {"number": "C1234", "price": [[100, "0.05", "0.05"], [1, "0.09", "0.09"]]},
    ]}}, raising=False)
    assert asyncio.run(lcsc.search("x"))[0]["price"] == 0.05


def test_a_price_that_is_not_a_number_is_no_price(monkeypatch):
    monkeypatch.setattr(lcsc, "_ask", lambda url: {"result": {"productList": [
        {"number": "C1234", "price": [[1, "on request", ""]]},
    ]}}, raising=False)
    assert asyncio.run(lcsc.search("x"))[0]["price"] is None


def test_nothing_is_asked_for_an_empty_term(monkeypatch):
    def boom(url):
        raise AssertionError("asked LCSC for nothing")
    monkeypatch.setattr(lcsc, "_ask", boom, raising=False)
    assert asyncio.run(lcsc.search("   ")) == []


def test_the_term_is_escaped(monkeypatch):
    seen = {}
    monkeypatch.setattr(lcsc, "_ask",
                        lambda url: seen.setdefault("url", url) and None
                        or {"result": {"productList": []}}, raising=False)
    asyncio.run(lcsc.search("0603 100nF & 16V"))
    assert " " not in seen["url"]
    assert "%26" in seen["url"] or "&keyword" not in seen["url"].split("?")[1]
