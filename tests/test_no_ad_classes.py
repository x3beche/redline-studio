"""No class name an ad blocker would hide.

The Admin panel's users vanished in one browser: its rows were .ad-row in
an .ad-list (ad for admin), and the ad blocker's cosmetic filters hid them
at no height. Class names that start like an advert are kept out of the
frontend for good.
"""

import re
from pathlib import Path

FRONT = Path(__file__).resolve().parents[1] / "frontend" / "src"
# what generic cosmetic filters (EasyList and the like) match on
BAD = re.compile(r'(?<![\w-])(ad|ads|advert|advertisement|sponsor|sponsored)[-_][a-z0-9]', re.I)


def _classes(text: str):
    for m in re.finditer(r'class="([^"]*)"', text):
        yield from m.group(1).split()
    for m in re.finditer(r'\[class\.([\w-]+)\]', text):
        yield m.group(1)
    for m in re.finditer(r'(?<![\w-])\.([a-zA-Z][\w-]*)', text):
        yield m.group(1)


def test_no_class_starts_like_an_advert():
    hits = []
    for p in list(FRONT.rglob("*.css")) + list(FRONT.rglob("*.ts")) + list(FRONT.rglob("*.html")):
        if "node_modules" in p.parts:
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        if p.suffix == ".ts" and "template:" not in text and "styles:" not in text:
            continue
        for c in set(_classes(text)):
            if BAD.match(c):
                hits.append(f"{p.relative_to(FRONT)}: .{c}")
    assert not hits, "class names an ad blocker hides:\n" + "\n".join(sorted(hits))
