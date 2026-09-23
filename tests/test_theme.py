"""Every colour in the interface has to come from a theme token.

A theme that is switched in cannot leave an element unstyled, and the only
way to be sure of that is to make it impossible to write a colour anywhere
else. So these tests read the stylesheet, the template and the component
and fail on a literal outside the theme blocks, on a `var(--x)` nobody
defines, on a token no theme uses, and on a theme that is missing one.

The one exemption is the drawing pens. A mark's colour is written into the
revision and printed into the picture: it is pigment, not chrome, and has
to mean the same thing in every theme and on paper. Those lines say
`theme:pigment` and this knows to skip them.
"""

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
CSS = ROOT / "frontend/src/styles.css"
HTML = ROOT / "frontend/src/app/editor/editor.html"
TS = ROOT / "frontend/src/app/editor/editor.ts"
# The shell carries its own template, so it can leak a colour just as well.
SHELL = ROOT / "frontend/src/app/app.ts"
THEME_TS = ROOT / "frontend/src/theme.ts"

# A hex colour, or an rgb()/rgba() with a number in it. `rgb(var(--x))`
# is fine, so the first character after the bracket has to be a digit.
COLOUR = re.compile(r"#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d")
EXEMPT = "theme:pigment"

DEFAULT = ":root {"
THEME_HEAD = re.compile(r':root\[data-theme="([a-z]+)"\]\s*\{')


def blocks(css: str) -> dict[str, str]:
    """The text of every theme block, keyed by name."""
    out: dict[str, str] = {}
    start = css.index(DEFAULT) + len(DEFAULT)
    out["default"] = css[start:css.index("}", start)]
    for m in THEME_HEAD.finditer(css):
        body_at = m.end()
        out[m.group(1)] = css[body_at:css.index("}", body_at)]
    return out


def defined(block: str) -> dict[str, str]:
    return {name: value.strip() for name, value in
            re.findall(r"(--[a-z0-9-]+)\s*:\s*([^;]+);", block)}


def used(text: str) -> set[str]:
    return set(re.findall(r"var\(\s*(--[a-z0-9-]+)", text))


def blank(match: re.Match) -> str:
    """Rub a comment out without moving the lines under it."""
    return re.sub(r"[^\n]", " ", match.group(0))


def strip_comments(text: str, css: bool) -> str:
    text = re.sub(r"/\*.*?\*/", blank, text, flags=re.S)
    if not css:
        text = re.sub(r"<!--.*?-->", blank, text, flags=re.S)
        text = re.sub(r"^\s*//.*$", blank, text, flags=re.M)
        text = re.sub(r"&#\d+;", "", text)      # &#8594; is an arrow
    return text


def literals(path: Path, skip_head: int = 0) -> list[tuple[int, str]]:
    """Colour literals in a file, by line, honouring the exemption."""
    raw = path.read_text().splitlines()
    clean = strip_comments(path.read_text(), css=path.suffix == ".css").splitlines()
    out = []
    for i, line in enumerate(clean):
        if i < skip_head or not COLOUR.search(line):
            continue
        near = " ".join(raw[max(0, i - 5):i + 1])
        if EXEMPT in near:
            continue
        out.append((i + 1, raw[i].strip()))
    return out


@pytest.fixture(scope="module")
def css() -> str:
    return CSS.read_text()


# ---------------- the themes themselves ----------------
def test_there_is_a_default_and_at_least_one_alternative(css):
    names = set(blocks(css))
    assert "default" in names
    assert names - {"default"}, "a theme mechanism with one theme proves nothing"


def test_every_theme_defines_exactly_the_same_tokens(css):
    """A theme missing a token leaves whatever used it unstyled."""
    all_blocks = blocks(css)
    base = set(defined(all_blocks["default"]))
    assert base, "the default theme defines no tokens"
    for name, block in all_blocks.items():
        if name == "default":
            continue
        here = set(defined(block))
        assert not (base - here), f"{name} is missing {sorted(base - here)}"
        assert not (here - base), f"{name} invents {sorted(here - base)}"


def test_no_theme_leaves_a_token_empty(css):
    for name, block in blocks(css).items():
        for token, value in defined(block).items():
            assert value, f"{name}: {token} has no value"


def test_the_typo_that_started_this_is_caught(css):
    """`--danger":` once slipped in; a quoted name defines nothing."""
    for name, block in blocks(css).items():
        for line in block.splitlines():
            if ":" not in line or not line.strip().startswith("--"):
                continue
            token = line.split(":")[0].strip()
            assert re.fullmatch(r"--[a-z0-9-]+", token), \
                f"{name}: {token!r} is not a token name"


# ---------------- nothing outside the palette ----------------
def test_the_stylesheet_carries_no_colour_outside_the_theme_blocks(css):
    end = css.rindex("}", 0, css.index("/* Single-screen app"))
    head_lines = css[:end].count("\n") + 1
    found = literals(CSS, skip_head=head_lines)
    assert not found, "literal colours in styles.css: " + str(found[:6])


def test_the_template_carries_no_colour():
    found = literals(HTML)
    assert not found, "literal colours in editor.html: " + str(found[:6])


def test_the_component_carries_no_colour_that_is_not_pigment():
    found = literals(TS)
    assert not found, "literal colours in editor.ts: " + str(found[:6])


def test_the_shell_carries_no_colour_either():
    found = literals(SHELL)
    assert not found, "literal colours in app.ts: " + str(found[:6])


def test_the_pens_are_exempt_on_purpose_and_still_there():
    """The exemption has to be earning its keep, or it is a hole."""
    text = TS.read_text()
    assert EXEMPT in text
    assert re.search(r"PENS\s*=\s*\[", text), "the pen palette went missing"


# ---------------- the two halves agree ----------------
def test_every_token_used_anywhere_is_defined_by_the_default_theme(css):
    base = set(defined(blocks(css)["default"]))
    everywhere = set()
    for path in (CSS, HTML, TS, SHELL):
        everywhere |= used(strip_comments(path.read_text(),
                                          css=path.suffix == ".css"))
    # The viewer's own variables are read with a fallback and belong to it.
    everywhere = {t for t in everywhere if not t.startswith("--tcv-")}
    assert not (everywhere - base), \
        f"used but undefined: {sorted(everywhere - base)}"


def test_no_token_is_defined_and_then_never_used(css):
    """Dead colours drift: they stop matching and nobody notices."""
    base = set(defined(blocks(css)["default"]))
    everywhere = set()
    for path in (CSS, HTML, TS, SHELL):
        everywhere |= used(path.read_text())
    assert not (base - everywhere), \
        f"defined but unused: {sorted(base - everywhere)}"


# ---------------- the switch ----------------
def test_the_switch_knows_exactly_the_themes_the_stylesheet_has(css):
    names = set(blocks(css))
    listed = set(re.search(r"THEMES = \[([^\]]+)\]",
                           THEME_TS.read_text()).group(1).replace("'", "").split(", "))
    assert listed == names, f"stylesheet has {sorted(names)}, switch has {sorted(listed)}"


def test_an_unknown_theme_falls_back_rather_than_half_applying():
    text = THEME_TS.read_text()
    assert "includes(want" in text and "'default'" in text


def test_the_theme_is_applied_before_the_application_renders():
    """Deciding after render paints the default palette for a frame."""
    main = (ROOT / "frontend/src/main.ts").read_text()
    assert main.index("applyTheme()") < main.index("bootstrapApplication(App")


# ---------------- the framework's own colours ----------------
# Tailwind ships a palette of its own, and `bg-white` is every bit as much
# a hard-coded colour as #fff - it just does not look like one.
TAILWIND = re.compile(
    r"\b(?:bg|text|border|from|to|via|fill|stroke|ring|outline|decoration|"
    r"accent|caret|divide|placeholder|shadow)-(?:white|black|transparent|"
    r"current|inherit|(?:slate|gray|grey|zinc|neutral|stone|red|orange|amber|"
    r"yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|"
    r"fuchsia|pink|rose)-\d{2,3})\b")


def test_no_tailwind_colour_utility_slips_past_the_palette():
    for path in (HTML, TS, SHELL):
        text = strip_comments(path.read_text(), css=False)
        found = TAILWIND.findall(text)
        assert not found, f"{path.name} uses Tailwind colours: {sorted(set(found))}"
