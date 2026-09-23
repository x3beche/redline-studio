"""The question renderer, run for real.

`markdown.ts` turns what the agent wrote into HTML on the person's screen.
It is the one piece of the front end that takes text from somewhere else
and produces tags, so it is worth a test that actually runs it rather than
reading it.

Node runs the TypeScript directly (`--experimental-strip-types`); the two
Angular lines - an import and the pipe - are cut out first, because
nothing here needs a component to render a paragraph.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

SOURCE = (Path(__file__).resolve().parent.parent
          / "frontend" / "src" / "app" / "markdown.ts")

HARNESS = """
import { toHtml, plain } from './markdown.mts';
const cases = JSON.parse(process.argv[2]);
console.log(JSON.stringify(cases.map(
  ([fn, text]) => (fn === 'plain' ? plain(text) : toHtml(text)))));
"""


def _render(cases: list[tuple[str, str]]) -> list[str]:
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH")

    text = SOURCE.read_text()
    text = re.sub(r"import \{[^}]*\} from '@angular/core';\n", "", text)
    text = re.sub(r"@Pipe\(\{[\s\S]*?\n\}\n", "", text)

    work = Path(tempfile.mkdtemp(prefix="md-test-"))
    try:
        (work / "markdown.mts").write_text(text)
        (work / "run.mjs").write_text(HARNESS)
        done = subprocess.run(
            [node, "--experimental-strip-types", "--no-warnings",
             str(work / "run.mjs"), json.dumps(cases)],
            capture_output=True, text=True, timeout=60)
        if done.returncode != 0:
            raise AssertionError(done.stderr[-800:])
        return json.loads(done.stdout)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def html(*texts: str) -> list[str]:
    return _render([("toHtml", t) for t in texts])


def one(text: str) -> str:
    return html(text)[0]


# --- what a question is made of -------------------------------------------

def test_paragraph():
    assert one("just a line") == "<p>just a line</p>"


def test_two_paragraphs_do_not_run_together():
    assert one("first\n\nsecond") == "<p>first</p><p>second</p>"


def test_a_single_newline_is_a_break_not_a_paragraph():
    assert one("first\nsecond") == "<p>first<br>second</p>"


def test_bullets():
    assert one("- one\n- two") == "<ul><li>one</li><li>two</li></ul>"


def test_numbered_list():
    assert one("1. one\n2. two") == "<ol><li>one</li><li>two</li></ol>"


def test_a_list_ends_when_the_prose_comes_back():
    out = one("- one\n\nafter")
    assert out == "<ul><li>one</li></ul><p>after</p>"


def test_heading():
    # A question's headings sit inside a card, so they start at h3.
    assert one("# Fit") == "<h3>Fit</h3>"


def test_bold_and_italic():
    assert one("**7 mm** and *maybe*") == "<p><strong>7 mm</strong> and <em>maybe</em></p>"


def test_code_span():
    assert one("`BACK_H = 28`") == "<p><code>BACK_H = 28</code></p>"


def test_fenced_code_keeps_its_lines():
    assert one("```\na\nb\n```") == "<pre><code>a\nb</code></pre>"


def test_table():
    out = one("| a | b |\n|---|---|\n| 1 | 2 |")
    assert out == ("<table><thead><tr><th>a</th><th>b</th></tr></thead>"
                   "<tbody><tr><td>1</td><td>2</td></tr></tbody></table>")


def test_a_line_with_pipes_is_not_a_table():
    assert "<table>" not in one("a | b | c")


def test_link():
    out = one("see [the board](https://example.com/b)")
    assert '<a href="https://example.com/b"' in out
    assert ">the board</a>" in out


def test_quote():
    assert one("> noted") == "<blockquote>noted</blockquote>"


def test_rule():
    assert one("---") == "<hr>"


# --- the parts that must not go wrong -------------------------------------

def test_tags_in_the_text_are_escaped():
    out = one("<script>alert('x')</script>")
    assert "<script>" not in out
    assert "&lt;script&gt;" in out


def test_an_image_tag_cannot_be_smuggled_in():
    out = one('<img src=x onerror="alert(1)">')
    assert "<img" not in out
    assert "onerror" not in out.replace("&quot;", '"') or "&lt;img" in out


def test_marks_inside_code_stay_as_they_were_typed():
    assert one("`**not bold**`") == "<p><code>**not bold**</code></p>"


def test_an_unclosed_fence_still_closes():
    assert one("```\nx = 1") == "<pre><code>x = 1</code></pre>"


def test_empty_text_renders_nothing():
    assert one("") == ""


def test_a_lone_asterisk_is_left_alone():
    assert one("2 * 3 = 6") == "<p>2 * 3 = 6</p>"


def test_underscores_inside_a_name_are_not_emphasis():
    assert one("BACK_H and CASE_Y") == "<p>BACK_H and CASE_Y</p>"


# --- the one-line version --------------------------------------------------

def test_plain_strips_the_marks():
    got = _render([("plain", "# Fit\n\n- **7 mm** of `room`")])[0]
    assert got == "Fit 7 mm of room"


def test_plain_drops_fenced_code():
    got = _render([("plain", "before\n```\nx = 1\n```\nafter")])[0]
    assert "x = 1" not in got
    assert got.startswith("before")


# --- the real thing --------------------------------------------------------

def test_a_question_as_the_agent_writes_one():
    out = one(
        "**18650 does not fit** - I need 7 mm.\n\n"
        "| option | cost |\n|---|---|\n| taller | +7.1 mm |\n| deeper | 0 |\n\n"
        "- `BACK_H` goes 28 -> 35.1\n"
        "- the wall moves 7.3 mm\n")
    assert "<strong>18650 does not fit</strong>" in out
    assert out.count("<tr>") == 3
    assert out.count("<li>") == 2
    assert "<code>BACK_H</code>" in out
