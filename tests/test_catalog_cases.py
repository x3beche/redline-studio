"""Seller pages the catalog once read wrong, read right now.

When someone presses "Wrong" beside a product's price or stock in the
Product Catalog, the server keeps the product's page as it was then, with
the wrong and the right value, as tests/fixtures/catalog_pages/<host>-<id>.json
(and the page's HTML beside it, <host>-<id>.html) - on the server only, it is
never committed by it (backend/manufacturers.py, keep_case). This test reads
every case in that folder with today's reader and wants the right value, so
a change to backend/catalog_facts.py cannot bring a fixed mistake back.

A case nobody has fixed yet fails here: that is the work to do. To make one a
committed test, fix the reader until this test passes for it, then commit
the case's two files with the fix:

    git add tests/fixtures/catalog_pages/<host>-<id>.json tests/fixtures/catalog_pages/<host>-<id>.html

(a case read through Jina has only the .json: its text is in it). Nothing
else is needed - this test picks up every case in the folder. A case whose
page could not be read again is skipped, with why.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend import manufacturers as mf

CASES = Path(__file__).resolve().parent / "fixtures" / "catalog_pages"


def _cases() -> list[Path]:
    return sorted(CASES.glob("*.json")) if CASES.is_dir() else []


@pytest.mark.parametrize("path", _cases() or [None], ids=lambda p: p.stem if p else "none")
def test_a_page_read_wrong_once_is_read_right(path):
    if path is None:
        pytest.skip("no kept cases in tests/fixtures/catalog_pages")
    wrong = mf.check_case(path)
    if wrong is None:
        pytest.skip(json.loads(path.read_text("utf-8")).get("error") or "the case has no page")
    assert wrong == [], f"{path.name}: " + "; ".join(wrong)
