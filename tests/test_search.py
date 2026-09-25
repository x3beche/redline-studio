"""The search box finds a line of code with its file and line number."""
import re

from backend import search


def test_code_lines_with_their_numbers():
    rx = re.compile(re.escape("m3"), re.I)
    src = "import x\nscrew = 'M3'\nother\nM3_LEN = 10\n"
    assert search._line_hits(src, rx) == [(2, "screw = 'M3'"), (4, "M3_LEN = 10")]


def test_a_snippet_around_the_match():
    rx = re.compile("needle")
    text = "a" * 200 + " needle " + "b" * 200
    got = search._around(text, rx, width=60)
    assert "needle" in got and got.startswith("…")
