"""PDF documents of Workbench: Markdown in, a PDF out.

The Chat's `pdf_make` tool (backend/chat_tools/pdf_make.py) writes a
report, a BOM comparison or a part's summary as Markdown; this turns it
into a printed page and keeps nothing itself.

How it is drawn: the Markdown becomes HTML (markdown-it-py, raw HTML off,
so nothing the model writes is markup of its own), set in a page of print
CSS (page size, margins, the app's own fonts embedded), and printed by
headless Chromium - the zenika/alpine-chrome image the stack already uses
for its pictures (backend/browser.py), started next to the API through the
Docker socket. Chromium is the engine because it is real CSS - tables that
repeat their header row on the next page, rows and figures that are not
cut, page N of M in a running header and footer - and because it needs
nothing installed in the API image: WeasyPrint wants Pango and Cairo,
which the image does not have.

The container runs with no network at all, and is handed the page on its
stdin and gives the PDF back on its stdout: nothing is mounted, nothing
can be fetched. Pictures are fetched here first - a file of the Files room
by its id, or a public http(s) address (backend/manufacturers.py `check`:
no private, local or link-local address, every redirect checked again) -
re-encoded with Pillow and put in the page as data: URLs.

Two themes (`Doc.theme`):

- "document", the default: an engineering document's sheet, black on white.
  Page 1 opens with a ruled header block across the page - the logo at the
  left, the title in bold capitals in the middle, and at the right a grid of
  labelled cells (Number | Page "1 of M", Date of writing | Revision,
  Applicability, Prepared), with Subject | Author in a row under it. Every
  later page has a one-row header instead (the logo, the title on one line,
  Number, Revision, "Page N of M"); every page a thin footer rule. Fields
  left empty get defaults (`fields`): the number WB-<yyyymmdd>-<hhmm> of the
  date it was made, revision 0, the date it was made (dd.mm.yyyy in a
  Turkish document, yyyy-mm-dd otherwise), applicability "-", prepared
  "Workbench", the subject the purpose (else the title). No e-mail address
  is ever printed in the header: one in a field is dropped (a name that is
  an address keeps the part before the @). The logo is Workbench's section
  mark, drawn in black, unless REDLINE_PDF_LOGO names a picture file (SVG,
  PNG, JPEG) to print instead.
- "simple", the theme before it: the Workbench mark and wordmark at the
  top left, the title at the top right; the project (if one is given) at
  the bottom left, and the author, the date and time it was made, its
  purpose and "page N of M" at the bottom right. Page 1 opens with the
  title block.

The headers are Chromium's print header templates, which are the same on
every page, so the page is printed twice from one layout - page 1 with the
big header, then pages 2- with the compact one (`pageRanges`; the page
numbers stay the whole document's) - and the two are joined with PDFium.
"""

from __future__ import annotations

import asyncio
import base64
import html
import io
import json
import os
import re
import secrets
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from markdown_it import MarkdownIt

from . import browser

IMAGE = os.environ.get("REDLINE_PDF_IMAGE", browser.IMAGE)
TIMEOUT = float(os.environ.get("REDLINE_PDF_TIMEOUT", "90"))
TZ = os.environ.get("REDLINE_TZ", "Europe/Istanbul")
FONTS = Path(__file__).resolve().parents[1] / "frontend" / "public" / "fonts"
SIZES = ("A4", "Letter")
THEMES = ("document", "simple")
LOGO = os.environ.get("REDLINE_PDF_LOGO", "")   # a picture file printed instead of the Workbench mark
MAX_MD = 200_000                      # characters of Markdown a document may have
MAX_IMAGES = 24
IMAGE_BYTES = 8 * 1024 * 1024         # one picture, as fetched
IMAGES_BYTES = 24 * 1024 * 1024       # all of them, as put in the page
IMAGE_PX = 2000                       # the longer side a picture is kept at
_RUNNING = asyncio.Semaphore(2)       # Chromiums at once

MARK = "M8 8H56V56H8ZM14 14V30L30 14ZM14 50H22L50 22V14H42L14 42ZM34 50H50V34Z"

LABELS = {
    "en": {"date": "Date", "author": "Author", "project": "Project", "purpose": "Purpose", "page": "Page",
           "of": "of", "missing": "picture not available", "number": "Number", "written": "Date of Writing",
           "revision": "Revision", "applicability": "Applicability", "prepared": "Prepared", "subject": "Subject",
           "rev": "Rev.", "no": "No."},
    "tr": {"date": "Tarih", "author": "Yazan", "project": "Proje", "purpose": "Amaç", "page": "Sayfa",
           "of": "/", "missing": "resim alınamadı", "number": "Numara", "written": "Yazım tarihi",
           "revision": "Revizyon", "applicability": "Uygulama alanı", "prepared": "Hazırlayan", "subject": "Konu",
           "rev": "Rev.", "no": "No."},
}
# The defaults of the document theme's header (`fields`).
DEFAULTS = {"revision": "0", "applicability": "—", "prepared": "Workbench"}


class RenderError(RuntimeError):
    """The PDF could not be made; the message says why."""


@dataclass
class Doc:
    title: str
    body: str = ""                         # Markdown (GFM tables, task lists)
    purpose: str = ""                      # one line: what the document is for
    author: str = ""
    project: str = ""                      # bottom left, and in the title block
    size: str = "A4"                       # A4 | Letter
    lang: str = "en"                       # the fixed labels: en | tr
    created: datetime | None = None
    sections: list[dict] = field(default_factory=list)   # [{"title", "body"}], after the body
    meta: list[tuple[str, str]] = field(default_factory=list)   # more (label, value) rows in the title block
    theme: str = "document"                # document | simple
    # The document theme's header; empty is the default (`fields`).
    number: str = ""
    revision: str = ""
    date: str = ""                         # as printed; the day it was made otherwise
    applicability: str = ""
    prepared: str = ""                     # the role or team that prepared it
    subject: str = ""


# ---------------------------------------------------------------- Markdown -> HTML

_md = MarkdownIt("commonmark", {"html": False, "linkify": False, "typographer": True}).enable(
    ["table", "strikethrough"])

_NUM = re.compile(r"^[~≈<>≤≥±+\-−]?\s*[$€£₺¥]?\s*\d[\d.,  ]*(\s*[%‰]|\s*[A-Za-zµμ°Ω/²³·]{1,8})?"
                  r"(\s*[-–]\s*[$€£₺¥]?\d[\d.,]*(\s*[%A-Za-zµμ°Ω/]{1,8})?)?$")
_TASK = re.compile(r"^\[([ xX])\]\s+")
_ALERT = re.compile(r"^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*", re.I)
_PAGEBREAK = ("\\pagebreak", "\\newpage", "[pagebreak]")
_FLOAT = ("right", "float")              # a figure's title that floats it to the right
_FILE_REF = re.compile(r"^(?:files?:|/api/files/|https?://[^/]+/api/files/)([A-Za-z0-9]{6,32})(?:[?#].*)?$")


def _safe_href(url: str) -> str | None:
    """Links that work on paper: http(s) and mailto only."""
    u = (url or "").strip()
    if re.match(r"^(https?://|mailto:)", u, re.I):
        return u
    return None


def _numeric(text: str) -> bool:
    t = text.strip().replace("**", "")
    return bool(t) and bool(_NUM.match(t))


def _tables(tokens) -> None:
    """Columns whose every filled body cell is a number, a price or a value
    with its unit are set right-aligned (unless the Markdown aligned them)."""
    i = 0
    while i < len(tokens):
        if tokens[i].type != "table_open":
            i += 1
            continue
        j = i
        while tokens[j].type != "table_close":
            j += 1
        cols: dict[int, list[str]] = {}
        col = 0
        in_body = False
        for k in range(i, j):
            t = tokens[k]
            if t.type == "tbody_open":
                in_body = True
            elif t.type == "tr_open":
                col = 0
            elif t.type in ("td_open", "th_open"):
                if in_body and k + 1 < j and tokens[k + 1].type == "inline":
                    cols.setdefault(col, []).append(tokens[k + 1].content)
                col += 1
        right = {c for c, cells in cols.items()
                 if [x for x in cells if x.strip() not in ("", "-", "–", "—")]
                 and all(_numeric(x) for x in cells if x.strip() not in ("", "-", "–", "—"))}
        col = 0
        for k in range(i, j):
            t = tokens[k]
            if t.type == "tr_open":
                col = 0
            elif t.type in ("td_open", "th_open"):
                if col in right and not t.attrGet("style"):
                    t.attrJoin("class", "num")
                col += 1
        i = j + 1


def _tasks(tokens) -> None:
    """'- [ ] x' and '- [x] x' items as boxes."""
    for k, t in enumerate(tokens):
        if t.type != "inline" or k < 2 or tokens[k - 1].type != "paragraph_open" or tokens[k - 2].type != "list_item_open":
            continue
        m = _TASK.match(t.content)
        if not m or not t.children or t.children[0].type != "text":
            continue
        done = m.group(1) != " "
        t.children[0].content = _TASK.sub("", t.children[0].content, count=1)
        tokens[k - 2].attrJoin("class", "task" + (" done" if done else ""))
        t.meta = {**(t.meta or {}), "task": done}


def _alerts(tokens) -> None:
    """'> [!NOTE]' quotes (GitHub's alerts) as labelled callouts."""
    for k, t in enumerate(tokens):
        if t.type != "blockquote_open":
            continue
        if k + 2 < len(tokens) and tokens[k + 1].type == "paragraph_open" and tokens[k + 2].type == "inline":
            inl = tokens[k + 2]
            m = _ALERT.match(inl.content)
            if m and inl.children and inl.children[0].type == "text":
                kind = m.group(1).lower()
                inl.children[0].content = _ALERT.sub("", inl.children[0].content, count=1)
                if inl.children[0].content == "" and len(inl.children) > 1 and inl.children[1].type == "softbreak":
                    inl.children = inl.children[2:]
                t.attrJoin("class", f"alert {kind}")
                t.meta = {"alert": kind}


def _figures(tokens) -> None:
    """A paragraph that is one picture is a figure, its title (or alt) the caption."""
    for k, t in enumerate(tokens):
        if t.type == "inline" and k and tokens[k - 1].type == "paragraph_open":
            kids = [c for c in (t.children or []) if not (c.type == "text" and not c.content.strip())]
            if len(kids) == 1 and kids[0].type == "image":
                tokens[k - 1].meta = {"figure": True}
                tokens[k + 1].meta = {"figure": True}
                kids[0].meta = {"figure": True}


def _render_rules(md: MarkdownIt) -> None:
    def paragraph_open(self, tokens, idx, options, env):
        t = tokens[idx]
        if (t.meta or {}).get("figure"):
            img = next((c for c in tokens[idx + 1].children or [] if c.type == "image"), None)
            right = img is not None and (img.attrGet("title") or "").strip().lower() in _FLOAT
            return '<figure class="right">' if right else "<figure>"
        nxt = tokens[idx + 1] if idx + 1 < len(tokens) else None
        if nxt is not None and nxt.type == "inline" and nxt.content.strip() in _PAGEBREAK:
            t.meta = {"pagebreak": True}
            nxt.children = []
            tokens[idx + 2].meta = {"pagebreak": True}
            return '<div class="pagebreak">'
        return self.renderToken(tokens, idx, options, env)

    def paragraph_close(self, tokens, idx, options, env):
        meta = tokens[idx].meta or {}
        if meta.get("figure"):
            return "</figure>\n"
        if meta.get("pagebreak"):
            return "</div>\n"
        return self.renderToken(tokens, idx, options, env)

    def image(self, tokens, idx, options, env):
        t = tokens[idx]
        src = t.attrGet("src") or ""
        alt = self.renderInlineAsText(t.children or [], options, env)
        title = t.attrGet("title") or ""
        if title.strip().lower() in _FLOAT:
            title = ""
        data = (env.get("images") or {}).get(src)
        fig = (t.meta or {}).get("figure")
        if not data:
            lab = LABELS.get(env.get("lang"), LABELS["en"])["missing"]
            return f'<span class="img-missing">[{html.escape(alt or "image")} - {lab}]</span>'
        img = f'<img src="{data}" alt="{html.escape(alt)}">'
        if fig:
            cap = title or alt
            return img + (f"<figcaption>{html.escape(cap)}</figcaption>" if cap else "")
        return img

    def link_open(self, tokens, idx, options, env):
        t = tokens[idx]
        href = _safe_href(t.attrGet("href") or "")
        env.setdefault("_links", []).append(bool(href))
        if not href:
            return '<span class="link">'
        return f'<a href="{html.escape(href)}">'

    def link_close(self, tokens, idx, options, env):
        ok = env.get("_links", [True]).pop() if env.get("_links") else True
        return "</a>" if ok else "</span>"

    def list_item_open(self, tokens, idx, options, env):
        out = self.renderToken(tokens, idx, options, env)
        cls = tokens[idx].attrGet("class") or ""
        if "task" in cls:
            out += f'<span class="box{" on" if "done" in cls else ""}" aria-hidden="true"></span>'
        return out

    def blockquote_open(self, tokens, idx, options, env):
        out = self.renderToken(tokens, idx, options, env)
        kind = (tokens[idx].meta or {}).get("alert")
        if kind:
            out += f'<div class="alert-label">{kind.title()}</div>'
        return out

    def table_open(self, tokens, idx, options, env):
        return '<div class="table">' + self.renderToken(tokens, idx, options, env)

    def table_close(self, tokens, idx, options, env):
        return self.renderToken(tokens, idx, options, env) + "</div>\n"

    def fence(self, tokens, idx, options, env):
        t = tokens[idx]
        lang = re.sub(r"[^\w+#.-]", "", (t.info or "").split(" ")[0])[:20]
        head = f'<div class="code-lang">{html.escape(lang)}</div>' if lang else ""
        return f'<div class="code">{head}<pre><code>{html.escape(t.content)}</code></pre></div>\n'

    for name, fn in list(locals().items()):
        if callable(fn) and name != "md":
            md.add_render_rule(name, fn)


_render_rules(_md)


def image_sources(markdown: str) -> list[str]:
    """Every picture the Markdown asks for, in order, each once."""
    out: list[str] = []
    for t in _md.parse(markdown or "", {}):
        for c in t.children or []:
            if c.type == "image":
                src = c.attrGet("src") or ""
                if src and src not in out:
                    out.append(src)
    return out


def md_html(markdown: str, images: dict[str, str] | None = None, lang: str = "en") -> str:
    """The Markdown as the body's HTML. No raw HTML passes; pictures only
    as the data: URLs in `images` (src -> data URL), others are a note."""
    env = {"images": images or {}, "lang": lang}
    tokens = _md.parse(markdown or "", env)
    _tables(tokens)
    _tasks(tokens)
    _alerts(tokens)
    _figures(tokens)
    return _md.renderer.render(tokens, _md.options, env)


# ---------------------------------------------------------------- pictures

def file_ref(src: str) -> str | None:
    """The Files id a picture's address names: files:<id>, /api/files/<id>."""
    m = _FILE_REF.match((src or "").strip())
    return m.group(1) if m else None


def clean_image(data: bytes) -> str | None:
    """A picture as a data: URL, read and written again by Pillow (so only
    pixels pass), at most IMAGE_PX on its longer side; None if it is not
    one. SVG passes as it is: in an <img> nothing in it runs or is fetched."""
    head = data[:512].lstrip().lower()
    if head.startswith(b"<?xml") or head.startswith(b"<svg"):
        if b"<svg" in data[:4096].lower() and len(data) <= 2 * 1024 * 1024:
            return "data:image/svg+xml;base64," + base64.b64encode(data).decode()
        return None
    from PIL import Image, ImageOps
    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.format not in ("PNG", "JPEG", "GIF", "WEBP", "BMP", "TIFF"):
                return None
            photo = im.format == "JPEG"
            im = ImageOps.exif_transpose(im)
            im.thumbnail((IMAGE_PX, IMAGE_PX))
            buf = io.BytesIO()
            if photo:
                im.convert("RGB").save(buf, "JPEG", quality=88)
                kind = "jpeg"
            else:
                if im.mode not in ("RGB", "RGBA", "L", "LA"):
                    im = im.convert("RGBA")
                im.save(buf, "PNG", optimize=True)
                kind = "png"
    except Exception:  # noqa: BLE001 - anything Pillow cannot read is not a picture
        return None
    return f"data:image/{kind};base64," + base64.b64encode(buf.getvalue()).decode()


async def fetch_public(url: str, limit: int = IMAGE_BYTES, hops: int = 4) -> bytes:
    """GET a public http(s) address: every hop checked to be public (no
    private, loopback or link-local address), at most `limit` bytes."""
    import httpx
    from .manufacturers import Refused, check
    for _ in range(hops + 1):
        try:
            url = await check(url)
        except Refused as exc:
            raise RenderError(str(exc)) from exc
        async with httpx.AsyncClient(follow_redirects=False, timeout=15,
                                     headers={"User-Agent": "Workbench-PDF/1"}) as client:
            async with client.stream("GET", url) as r:
                if r.is_redirect and r.headers.get("location"):
                    url = str(httpx.URL(url).join(r.headers["location"]))
                    continue
                if r.status_code != 200:
                    raise RenderError(f"{url} answered {r.status_code}")
                chunks, n = [], 0
                async for chunk in r.aiter_bytes():
                    n += len(chunk)
                    if n > limit:
                        raise RenderError(f"{url} is larger than {limit // (1024 * 1024)} MB")
                    chunks.append(chunk)
                return b"".join(chunks)
    raise RenderError(f"{url}: too many redirects")


async def resolve_images(sources: list[str], db=None) -> tuple[dict[str, str], list[str]]:
    """The pictures as data: URLs (src -> URL), and what could not be had."""
    from . import files
    got: dict[str, str] = {}
    missing: list[str] = []
    total = 0
    for src in sources[:MAX_IMAGES]:
        data: bytes | None = None
        try:
            fid = file_ref(src)
            if fid:
                if db is None:
                    raise RenderError("no Files to read from")
                try:
                    _doc, data = await files.get(db, fid)
                except KeyError:
                    raise RenderError(f"no file {fid} in Files") from None
                if len(data) > IMAGE_BYTES:
                    raise RenderError(f"file {fid} is too large for a picture")
            elif re.match(r"^https?://", src, re.I):
                data = await fetch_public(src)
            else:
                raise RenderError("only Files ids and public http(s) addresses")
            url = clean_image(data or b"")
            if not url:
                raise RenderError("not a picture")
            if total + len(url) > IMAGES_BYTES:
                raise RenderError("too many pictures in one document")
            total += len(url)
            got[src] = url
        except (RenderError, OSError, ValueError) as exc:
            missing.append(f"{src[:120]}: {exc}")
        except Exception as exc:  # noqa: BLE001 - a network error is a missing picture, not a failed document
            missing.append(f"{src[:120]}: {exc.__class__.__name__}")
    missing += [f"{s[:120]}: more than {MAX_IMAGES} pictures" for s in sources[MAX_IMAGES:]]
    return got, missing


# ---------------------------------------------------------------- the page

def _font(name: str) -> str:
    p = FONTS / name
    return base64.b64encode(p.read_bytes()).decode() if p.exists() else ""


_FACES: str | None = None


def font_faces() -> str:
    """The app's fonts (frontend/public/fonts), embedded."""
    global _FACES
    if _FACES is None:
        latin = ("U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, "
                 "U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD")
        ext = ("U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, "
               "U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, "
               "U+A720-A7FF")
        faces = []

        def face(family, weight, file, rng=None):
            b = _font(file)
            if b:
                faces.append(f"@font-face{{font-family:'{family}';font-style:normal;font-weight:{weight};"
                             f"src:url(data:font/woff2;base64,{b}) format('woff2');"
                             + (f"unicode-range:{rng};" if rng else "") + "}")
        face("IBM Plex Sans", "100 700", "plexsans-var-latin.woff2", latin)
        face("IBM Plex Sans", "100 700", "plexsans-var-latin-ext.woff2", ext)
        for w in (500, 600):
            face("IBM Plex Mono", w, f"plexmono-{w}-latin.woff2", latin)
            face("IBM Plex Mono", w, f"plexmono-{w}-latin-ext.woff2", ext)
        for w in (400, 500, 600):
            face("Switzer", w, f"switzer-{w}.woff2")
        _FACES = "\n".join(faces)
    return _FACES


# The page's colours: Workbench's light theme (frontend/src/styles.css
# [data-theme="light"]), on white paper.
CSS = """

:root {
  --ink: #1d2329; --ink-dim: #5e6873; --ink-faint: #8a939c; --line: #d5dae0; --line-soft: #e6e9ed;
  --wash: #f4f6f8; --accent: #1d6fb8; --pen: #e00d22; --ok: #3d7a3d; --warn: #a86a06; --danger: #b52a2a;
}
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #fff; color: var(--ink);
  font: 400 9.6pt/1.55 'IBM Plex Sans', 'Noto Sans', 'FreeSans', sans-serif; font-feature-settings: "kern"; text-rendering: geometricPrecision; }

/* page 1: the title block */
.tb { margin: 0 0 22pt; padding: 0 0 14pt; border-bottom: 1.2pt solid var(--ink); }
.tb-title { margin: 0; font: 600 23pt/1.15 'Switzer', 'IBM Plex Sans', sans-serif; letter-spacing: -.015em; }
.tb-purpose { margin: 7pt 0 0; font-size: 11.5pt; line-height: 1.4; color: var(--ink-dim); }
.tb-meta { display: flex; flex-wrap: wrap; gap: 6pt 26pt; margin: 14pt 0 0; }
.tb-meta div { min-width: 0; }
.tb-meta dt { font-size: 7pt; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-faint); }
.tb-meta dd { margin: 1pt 0 0; font-size: 9pt; }

/* the text */
h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; break-inside: avoid; color: var(--ink); }
h1 { margin: 22pt 0 8pt; font: 600 16pt/1.25 'Switzer', 'IBM Plex Sans', sans-serif; letter-spacing: -.01em; }
h2 { margin: 20pt 0 7pt; padding-bottom: 3pt; font: 600 12.5pt/1.3 'Switzer', 'IBM Plex Sans', sans-serif;
  border-bottom: .6pt solid var(--line); }
h3 { margin: 15pt 0 5pt; font-size: 10.6pt; font-weight: 600; }
h4, h5, h6 { margin: 12pt 0 4pt; font-size: 9.6pt; font-weight: 600; color: var(--ink-dim); }
.tb + h1, .tb + h2, .tb + h3 { margin-top: 0; }
p { margin: 0 0 7pt; orphans: 3; widows: 3; }
a { color: var(--accent); text-decoration: none; }
strong { font-weight: 600; }
em { font-style: italic; }
del, s { color: var(--ink-dim); }
hr { border: 0; border-top: .6pt solid var(--line); margin: 14pt 0; }
ul, ol { margin: 0 0 8pt; padding-left: 16pt; }
li { margin: 1.5pt 0; }
li > p { margin: 0 0 3pt; }
li.task { list-style: none; position: relative; }
li.task > .box { position: absolute; left: -13pt; top: 2.6pt; width: 8pt; height: 8pt; border: .8pt solid var(--ink-dim);
  border-radius: 1.5pt; }
li.task > .box.on { background: var(--ink); border-color: var(--ink); }
li.task > .box.on::after { content: ""; position: absolute; left: 2.3pt; top: .5pt; width: 2pt; height: 4.2pt;
  border: solid #fff; border-width: 0 1.1pt 1.1pt 0; transform: rotate(45deg); }
li.task.done > p, li.task.done { color: var(--ink-dim); }
code { font: 500 8.6pt/1.4 'IBM Plex Mono', ui-monospace, monospace; background: var(--wash); padding: .5pt 3pt;
  border-radius: 2pt; }
.code { margin: 0 0 9pt; border: .6pt solid var(--line); border-radius: 3pt; background: var(--wash); break-inside: avoid; }
.code-lang { padding: 3pt 8pt 0; font: 600 6.8pt 'IBM Plex Mono', monospace; letter-spacing: .06em; text-transform: uppercase;
  color: var(--ink-faint); }
.code pre { margin: 0; padding: 6pt 8pt 7pt; white-space: pre-wrap; overflow-wrap: anywhere; }
.code code { background: none; padding: 0; font-size: 8pt; line-height: 1.5; }
blockquote { margin: 0 0 9pt; padding: 6pt 10pt; background: var(--wash); border-left: 2.2pt solid var(--ink-faint);
  border-radius: 0 3pt 3pt 0; break-inside: avoid; }
blockquote > :last-child { margin-bottom: 0; }
blockquote.alert.note, blockquote.alert.tip { border-left-color: var(--accent); }
blockquote.alert.important { border-left-color: var(--ink); }
blockquote.alert.warning { border-left-color: var(--warn); }
blockquote.alert.caution { border-left-color: var(--pen); }
.alert-label { font-size: 7pt; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-dim);
  margin-bottom: 2pt; }

/* tables: a header row, hairlines between rows, numbers to the right */
.table { margin: 2pt 0 11pt; }
table { width: 100%; border-collapse: collapse; font-size: 8.6pt; line-height: 1.4; font-variant-numeric: tabular-nums; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th { text-align: left; font-weight: 600; font-size: 7.6pt; letter-spacing: .02em; color: var(--ink-dim);
  background: var(--wash); border-top: .9pt solid var(--ink); border-bottom: .9pt solid var(--ink); padding: 4pt 6pt; }
td { padding: 3.6pt 6pt; border-bottom: .5pt solid var(--line); vertical-align: top; }
tbody tr:last-child td { border-bottom: .9pt solid var(--ink); }
th.num, td.num { text-align: right; white-space: nowrap; }
td code, th code { font-size: 7.8pt; padding: 0 2pt; }

/* pictures */
img { max-width: 100%; height: auto; }
figure { margin: 4pt 0 12pt; text-align: center; break-inside: avoid; page-break-inside: avoid; }
figure img { max-height: 120mm; object-fit: contain; }
/* Several pictures in one paragraph (a render's views): side by side, three to a row. */
p > img:not(:only-child) { width: 32%; margin: 0 1% 4pt 0; vertical-align: top; }
figcaption { margin-top: 4pt; font-size: 8pt; color: var(--ink-dim); }
.img-missing { color: var(--ink-faint); font-size: 8.4pt; }
.pagebreak { break-after: page; page-break-after: always; height: 0; }
.pagebreak + h1, .pagebreak + h2, .pagebreak + h3 { margin-top: 0; }
"""

_HEAD_CSS = ("<style>{faces}"
             "*{{box-sizing:border-box}}"
             ".rl{{width:100%;display:flex;align-items:center;gap:8pt;margin:0 {mx};padding:0 0 4pt;"
             "font:500 7.4pt/1.2 'IBM Plex Sans',sans-serif;color:#5e6873;-webkit-print-color-adjust:exact;"
             "border-bottom:.5pt solid #d5dae0}}"
             ".rl-brand{{display:flex;align-items:center;gap:4.5pt;color:#1d2329;"
             "font:600 10pt/1 'Switzer','IBM Plex Sans',sans-serif;letter-spacing:-.01em}}"
             ".rl-brand svg{{width:11pt;height:11pt;display:block}}"
             ".rl-right{{margin-left:auto;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
             "max-width:60%}}"
             ".ft{{width:100%;display:flex;align-items:flex-end;gap:12pt;margin:0 {mx};padding:4pt 0 0;"
             "font:400 7pt/1.35 'IBM Plex Sans',sans-serif;color:#5e6873;border-top:.5pt solid #d5dae0;"
             "-webkit-print-color-adjust:exact}}"
             ".ft-left{{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34%}}"
             ".ft-right{{margin-left:auto;text-align:right;min-width:0;white-space:nowrap;overflow:hidden;"
             "text-overflow:ellipsis}}"
             ".ft b{{font-weight:600;color:#1d2329}}"
             ".ft .pg{{display:inline-block;margin-left:8pt;padding-left:8pt;border-left:.5pt solid #d5dae0;"
             "font-weight:600;font-variant-numeric:tabular-nums;color:#1d2329}}"
             "</style>")

MARGIN = {"top": "21mm", "bottom": "19mm", "left": "18mm", "right": "18mm"}


def stamp(when: datetime | None = None) -> str:
    """The date and time on the document: 12 Oct 2026, 14:03 (+03)."""
    try:
        tz = ZoneInfo(TZ)
    except Exception:  # noqa: BLE001 - an unknown zone is UTC
        tz = ZoneInfo("UTC")
    w = (when or datetime.now(tz)).astimezone(tz)
    off = w.strftime("%z")
    off = off[:3] + (":" + off[3:] if off[3:] != "00" else "")
    return w.strftime("%d %b %Y, %H:%M") + f" (UTC{off})"


def _e(s: str) -> str:
    return html.escape(s or "", quote=True)


def page_html(doc: Doc, body_html: str) -> str:
    lab = LABELS.get(doc.lang, LABELS["en"])
    meta = [(lab["date"], stamp(doc.created))]
    if doc.author:
        meta.append((lab["author"], doc.author))
    if doc.project:
        meta.append((lab["project"], doc.project))
    meta += [(str(k), str(v)) for k, v in doc.meta or [] if str(v or "").strip()]
    dl = "".join(f"<div><dt>{_e(k)}</dt><dd>{_e(v)}</dd></div>" for k, v in meta)
    purpose = f'<p class="tb-purpose">{_e(doc.purpose)}</p>' if doc.purpose else ""
    return ("<!doctype html><html lang=\"" + _e(doc.lang) + "\"><head><meta charset=\"utf-8\">"
            "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; "
            "font-src data:; style-src 'unsafe-inline'\">"
            f"<title>{_e(doc.title)}</title><style>{font_faces()}{CSS}</style></head><body>"
            f'<header class="tb"><h1 class="tb-title">{_e(doc.title)}</h1>{purpose}<dl class="tb-meta">{dl}</dl></header>'
            f'<main>{body_html}</main></body></html>')


def header_html(doc: Doc) -> str:
    mx = MARGIN["left"]
    return (_HEAD_CSS.format(faces=font_faces(), mx=mx)
            + '<div class="rl"><span class="rl-brand"><svg viewBox="0 0 64 64" aria-hidden="true">'
            f'<path fill="#1d2329" fill-rule="evenodd" d="{MARK}"/></svg>Workbench</span>'
            f'<span class="rl-right">{_e(doc.title)}</span></div>')


def short(text: str, n: int = 70) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def footer_html(doc: Doc) -> str:
    lab = LABELS.get(doc.lang, LABELS["en"])
    right = [f"<b>{_e(doc.author)}</b>" if doc.author else "", _e(stamp(doc.created)), _e(short(doc.purpose))]
    right = " · ".join(x for x in right if x)
    of = lab["of"]
    return (_HEAD_CSS.format(faces=font_faces(), mx=MARGIN["left"])
            + f'<div class="ft"><span class="ft-left">{_e(doc.project)}</span>'
            f'<span class="ft-right">{right}<span class="pg">{_e(lab["page"])} <span class="pageNumber"></span> '
            f'{_e(of)} <span class="totalPages"></span></span></span></div>')


# ---------------------------------------------------------------- the document theme

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")


def no_email(text: str) -> str:
    """A header field without e-mail addresses: a name that is one keeps the
    part before the @, an address inside other words is dropped."""
    t = " ".join(str(text or "").split())
    m = _EMAIL.fullmatch(t)
    if m:
        return t.split("@", 1)[0]
    if not _EMAIL.search(t):
        return t
    return " ".join(re.sub(r"[<(\[]?\s*" + _EMAIL.pattern + r"\s*[>)\]]?", "", t).split()).strip(" ,;·-")


def _local(when: datetime | None) -> datetime:
    try:
        tz = ZoneInfo(TZ)
    except Exception:  # noqa: BLE001 - an unknown zone is UTC
        tz = ZoneInfo("UTC")
    return (when or datetime.now(tz)).astimezone(tz)


def fields(doc: Doc) -> dict[str, str]:
    """The header's fields as printed, the defaults filled in."""
    w = _local(doc.created)
    lang = doc.lang if doc.lang in LABELS else "en"
    out = {
        "title": no_email(doc.title),
        "number": no_email(doc.number) or f"WB-{w:%Y%m%d}-{w:%H%M}",
        "revision": no_email(doc.revision) or DEFAULTS["revision"],
        "date": no_email(doc.date) or (w.strftime("%d.%m.%Y") if lang == "tr" else w.strftime("%Y-%m-%d")),
        "applicability": no_email(doc.applicability) or DEFAULTS["applicability"],
        "prepared": no_email(doc.prepared) or DEFAULTS["prepared"],
        "subject": no_email(doc.subject) or no_email(doc.purpose) or no_email(doc.title),
        "author": no_email(doc.author),
    }
    return {k: v[:300] for k, v in out.items()}


_LOGO: dict[str, str] = {}


def logo_html(size: str = "100%") -> str:
    """The logo: REDLINE_PDF_LOGO's picture when it names one that reads,
    otherwise Workbench's section mark in black - a vector, crisp at any size."""
    if LOGO:
        if LOGO not in _LOGO:
            try:
                _LOGO[LOGO] = clean_image(Path(LOGO).read_bytes()) or ""
            except OSError:
                _LOGO[LOGO] = ""
        if _LOGO[LOGO]:
            return f'<img class="logo-img" src="{_LOGO[LOGO]}" alt="">'
    return (f'<svg viewBox="8 8 48 48" width="{size}" height="{size}" aria-hidden="true">'
            f'<path fill="#000" fill-rule="evenodd" d="{MARK}"/></svg>')


def _title_size(title: str) -> str:
    """The big header's title shrinks as it grows, to stay in its cell."""
    n = len(title)
    return "15pt" if n <= 48 else "13pt" if n <= 84 else "11pt" if n <= 130 else "9.5pt"


# Body text of the document theme: black on white, ruled tables, plain headings.
DOC_CSS = """
:root { --ink: #000; --ink-dim: #333; --ink-faint: #666; --line: #000; --line-soft: #bbb; --wash: #f2f2f2;
  --accent: #000; }
body { font-size: 10pt; line-height: 1.5; }
@page :first { margin-top: 64mm; }
h1 { margin: 18pt 0 7pt; font: 700 16pt/1.25 'IBM Plex Sans', sans-serif; letter-spacing: 0; }
h2 { margin: 16pt 0 6pt; padding: 0; border: 0; font: 700 13pt/1.3 'IBM Plex Sans', sans-serif; }
h3 { margin: 13pt 0 4pt; font-size: 11pt; font-weight: 700; }
h4, h5, h6 { font-weight: 700; color: var(--ink); }
main > :first-child { margin-top: 0; }
strong { font-weight: 700; }
a { color: #000; text-decoration: underline; text-decoration-thickness: .4pt; }
.doc-meta { margin: 0 0 12pt; font-size: 8.4pt; color: var(--ink-dim); }
.doc-meta b { font-weight: 600; color: #000; }
code { background: var(--wash); }
.code { border-color: #999; border-radius: 0; background: #f6f6f6; }
blockquote { background: none; border-left: 1.5pt solid #000; border-radius: 0; padding: 2pt 10pt; }
blockquote.alert.note, blockquote.alert.tip, blockquote.alert.important, blockquote.alert.warning,
blockquote.alert.caution { border-left-color: #000; }
th { color: #000; background: var(--wash); border: .6pt solid #000; font-size: 8pt; }
td { border: .6pt solid #000; }
tbody tr:last-child td { border-bottom: .6pt solid #000; }
figure.right { float: right; width: 44%; margin: 2pt 0 8pt 12pt; }
figure.right img { max-height: 90mm; }
h1, h2 { clear: both; }
"""

# The header templates: Chromium prints them in the top margin, outside the page's CSS.
_DOC_HEAD_CSS = ("<style>{faces}"
                 "*{{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}}"
                 ".h{{width:100%;margin:0 {mx};padding:0 .6pt;font:400 7pt/1.2 'IBM Plex Sans',sans-serif;color:#000}}"
                 "table{{width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;"
                 "border-top:.8pt solid #000;border-left:.8pt solid #000}}"
                 "td{{border:0;border-right:.8pt solid #000;border-bottom:.8pt solid #000;padding:0;"
                 "vertical-align:top;overflow:hidden}}"
                 ".f{{position:relative;height:9mm}}"
                 ".f .l{{position:absolute;left:4pt;top:2.6pt;font-size:6.6pt;color:#000}}"
                 ".f .v{{position:absolute;right:5pt;bottom:3pt;left:4pt;text-align:right;font-weight:700;"
                 "font-size:8.4pt;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}"
                 ".logo{{text-align:center;vertical-align:middle}}"
                 ".logo svg,.logo img{{display:block;margin:auto}}"
                 ".logo img{{max-width:86%;max-height:86%;object-fit:contain}}"
                 ".ttl{{vertical-align:middle;text-align:center;padding:4pt 9pt}}"
                 ".ttl div{{font-weight:700;text-transform:uppercase;line-height:1.22;letter-spacing:.01em;"
                 "display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden}}"
                 ".sub{{height:10.5mm}}"
                 ".sub .v{{font-size:9pt}}"
                 ".subj .v{{text-transform:uppercase;text-align:left;left:4pt}}"
                 ".f .v.s{{font-size:7.2pt;line-height:1.12;white-space:normal;bottom:2.4pt;"
                 "display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}}"
                 ".c td{{height:8mm;vertical-align:middle;padding:0 5pt;white-space:nowrap;overflow:hidden;"
                 "text-overflow:ellipsis;font-size:7.6pt}}"
                 ".c .logo{{padding:0}}"
                 ".c .t{{font-weight:700;text-transform:uppercase;font-size:8pt}}"
                 ".c b{{font-weight:700}}"
                 ".ft{{width:100%;margin:0 {mx};display:flex;gap:12pt;padding-top:3.5pt;border-top:.6pt solid #000;"
                 "font:400 6.8pt/1.3 'IBM Plex Sans',sans-serif;color:#333}}"
                 ".ft span{{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}"
                 ".ft .r{{margin-left:auto;text-align:right}}"
                 "</style>")

_FIRST_TOP = "64mm"        # page 1's top margin: the big header (@page :first in DOC_CSS)
DOC_MARGIN = {"top": "27mm", "bottom": "18mm", "left": "19mm", "right": "19mm"}


def _cell(label: str, value: str, cls: str = "f", span: int = 1, room: int = 0) -> str:
    """A labelled cell: the label small at the top left, the value bold at the
    bottom right; a value longer than `room` characters is set smaller."""
    sp = f' colspan="{span}"' if span > 1 else ""
    small = " s" if room and len(html.unescape(value)) > room else ""
    return (f'<td class="{cls}"{sp}><span class="l">{_e(label)}</span>'
            f'<span class="v{small}">{value}</span></td>')


def first_header_html(doc: Doc) -> str:
    """Page 1's header: the logo, the title, the fields' grid; Subject | Author under it."""
    lab = LABELS.get(doc.lang, LABELS["en"])
    f = fields(doc)
    pages = (f'<span class="pageNumber"></span> {_e(lab["of"])} <span class="totalPages"></span>')
    return (_DOC_HEAD_CSS.format(faces=font_faces(), mx=DOC_MARGIN["left"])
            + f'<div class="h" lang="{_e(doc.lang)}" style="margin-top:9mm;width:calc(100% - 2 * {DOC_MARGIN["left"]})">'
            '<table><colgroup><col style="width:30mm"><col><col style="width:31mm"><col style="width:31mm">'
            '</colgroup>'
            f'<tr><td class="logo" rowspan="4">{logo_html("22mm")}</td>'
            f'<td class="ttl" rowspan="4"><div style="font-size:{_title_size(f["title"])}">{_e(f["title"])}</div></td>'
            + _cell(lab["number"], _e(f["number"]), room=13) + _cell(lab["page"], pages) + "</tr>"
            "<tr>" + _cell(lab["written"], _e(f["date"]), room=15) + _cell(lab["revision"], _e(f["revision"]), room=15)
            + "</tr><tr>" + _cell(lab["applicability"], _e(f["applicability"]), span=2, room=26) + "</tr>"
            "<tr>" + _cell(lab["prepared"], _e(f["prepared"]), span=2, room=26) + "</tr>"
            "<tr>" + _cell(lab["subject"], _e(f["subject"]), "f sub subj", 2)
            + _cell(lab["author"], _e(f["author"]), "f sub", 2, room=30)
            + "</tr></table></div>")


def compact_header_html(doc: Doc) -> str:
    """Pages 2-: one row - the logo, the title on one line, Number, Revision, Page N of M."""
    lab = LABELS.get(doc.lang, LABELS["en"])
    f = fields(doc)
    return (_DOC_HEAD_CSS.format(faces=font_faces(), mx=DOC_MARGIN["left"])
            + f'<div class="h c" lang="{_e(doc.lang)}" style="margin-top:9mm;width:calc(100% - 2 * {DOC_MARGIN["left"]})">'
            '<table><colgroup><col style="width:11mm"><col><col style="width:40mm"><col style="width:17mm">'
            '<col style="width:26mm"></colgroup><tr>'
            f'<td class="logo">{logo_html("6mm")}</td><td class="t">{_e(f["title"])}</td>'
            f'<td>{_e(lab["no"])} <b>{_e(f["number"])}</b></td>'
            f'<td>{_e(lab["rev"])} <b>{_e(f["revision"])}</b></td>'
            f'<td>{_e(lab["page"])} <b><span class="pageNumber"></span> {_e(lab["of"])} '
            '<span class="totalPages"></span></b></td></tr></table></div>')


def doc_footer_html(doc: Doc) -> str:
    """Every page: a thin rule; the project (or who prepared it) left, when it was printed right."""
    f = fields(doc)
    left = no_email(doc.project) or f["prepared"]
    w = _local(doc.created)
    made = w.strftime("%d.%m.%Y %H:%M") if doc.lang == "tr" else stamp(doc.created)
    return (_DOC_HEAD_CSS.format(faces=font_faces(), mx=DOC_MARGIN["left"])
            + f'<div class="ft" style="width:calc(100% - 2 * {DOC_MARGIN["left"]})"><span>{_e(left)}</span>'
            f'<span class="r">{_e(f["number"])} · {_e(made)}</span></div>')


def doc_page_html(doc: Doc, body_html: str) -> str:
    """The document theme's page: the header is the template's; the body opens
    with the extra rows (`meta`), if any, on one line."""
    meta = [(str(k), str(v)) for k, v in doc.meta or [] if str(v or "").strip()]
    line = " · ".join(f"<b>{_e(k)}</b> {_e(no_email(v))}" for k, v in meta)
    head = f'<p class="doc-meta">{line}</p>' if line else ""
    return ("<!doctype html><html lang=\"" + _e(doc.lang) + "\"><head><meta charset=\"utf-8\">"
            "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; "
            "font-src data:; style-src 'unsafe-inline'\">"
            f"<title>{_e(doc.title)}</title><style>{font_faces()}{CSS}{DOC_CSS}</style></head><body>"
            f'<main>{head}{body_html}</main></body></html>')


def body_markdown(doc: Doc) -> str:
    parts = [doc.body or ""]
    for s in doc.sections or []:
        title = str((s or {}).get("title") or "").strip()
        text = str((s or {}).get("body") or (s or {}).get("markdown") or "").strip()
        if title or text:
            parts.append((f"## {title}\n\n" if title else "") + text)
    return "\n\n".join(p for p in parts if p.strip())


# ---------------------------------------------------------------- Chromium

# Run in the image's /usr/src/app, where its puppeteer is. The page is
# allowed nothing but itself: every request that is not a data: URL is
# refused (there is no network in the container either).
SCRIPT = r"""
const puppeteer = require('puppeteer');
const parts = [];
process.stdin.on('data', d => parts.push(d));
process.stdin.on('end', async () => {
  let browser;
  try {
    const j = JSON.parse(Buffer.concat(parts).toString('utf8'));
    browser = await puppeteer.launch({ headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'] });
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', r => { const u = r.url(); (u.startsWith('data:') || u === 'about:blank') ? r.continue() : r.abort(); });
    await page.setContent(j.html, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    // One print per pass, each its header and its pages of the same layout; each
    // written as its length (10 digits) and its bytes. A range past the last page is 0 bytes.
    for (const p of j.passes) {
      let pdf = Buffer.alloc(0);
      try {
        pdf = Buffer.from(await page.pdf({ format: j.format, printBackground: true, displayHeaderFooter: true,
          headerTemplate: p.header, footerTemplate: p.footer, margin: j.margin, outline: true, tagged: true,
          pageRanges: p.ranges || '', timeout: 60000 }));
      } catch (e) {
        if (!(p.ranges && /range|exceed/i.test(String(e && e.message)))) throw e;
      }
      process.stdout.write(String(pdf.length).padStart(10, '0'));
      process.stdout.write(pdf);
    }
  } catch (e) {
    process.stderr.write(String((e && e.stack) || e));
    process.exitCode = 2;
  } finally {
    if (browser) await browser.close();
  }
});
"""


def docker_argv(name: str) -> list[str]:
    return ["docker", "run", "-i", "--rm", "--name", name, "--network", "none",
            "--memory", "1g", "--cpus", "2", "--pids-limit", "512", "--security-opt", "no-new-privileges",
            "--workdir", "/usr/src/app", "--entrypoint", "node", IMAGE, "-e", SCRIPT]


def _passes(out: bytes) -> list[bytes]:
    got, i = [], 0
    while i + 10 <= len(out):
        if not out[i:i + 10].isdigit():
            break                                  # not what the script writes: no PDF
        n = int(out[i:i + 10])
        got.append(out[i + 10:i + 10 + n])
        i += 10 + n
    return got


async def print_pdf(page: str, header: str, footer: str, size: str = "A4", margin: dict | None = None,
                    rest: str | None = None) -> bytes:
    """The page printed by headless Chromium in its container. With `rest`,
    page 1 has `header` and pages 2- have `rest` (two prints of one layout, joined)."""
    passes = ([{"header": header, "footer": footer}] if rest is None else
              [{"header": header, "footer": footer, "ranges": "1"}, {"header": rest, "footer": footer, "ranges": "2-"}])
    payload = json.dumps({"html": page, "passes": passes, "margin": margin or MARGIN,
                          "format": size if size in SIZES else "A4"}).encode()
    name = "redline-pdf-" + secrets.token_hex(4)
    async with _RUNNING:
        try:
            proc = await asyncio.create_subprocess_exec(*docker_argv(name), stdin=asyncio.subprocess.PIPE,
                                                        stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.PIPE)
        except OSError as exc:
            raise RenderError(f"the PDF engine could not start (docker: {exc})") from exc
        try:
            out, err = await asyncio.wait_for(proc.communicate(payload), TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            rm = await asyncio.create_subprocess_exec("docker", "rm", "-f", name, stdout=asyncio.subprocess.DEVNULL,
                                                      stderr=asyncio.subprocess.DEVNULL)
            await rm.wait()
            raise RenderError(f"the PDF took longer than {int(TIMEOUT)} s") from None
    parts = _passes(out) if proc.returncode == 0 else []
    if proc.returncode != 0 or not parts or not parts[0].startswith(b"%PDF"):
        why = (err or b"").decode("utf-8", "replace").strip().splitlines()
        tail = why[-1] if why else f"exit {proc.returncode}"
        if "Unable to find image" in (err or b"").decode("utf-8", "replace") or "No such image" in tail:
            tail = f"the image {IMAGE} is not on this machine (docker pull {IMAGE})"
        raise RenderError(f"the PDF could not be printed: {tail[:300]}")
    if rest is None or len(parts) < 2 or not parts[1]:
        return parts[0]                        # one page: no rest
    return _first_then(parts[0], parts[1])


def _first_then(first: bytes, rest: bytes) -> bytes:
    """`first`'s pages put in front of `rest`'s, in `rest`: its outline and tags
    are kept (those of page 1's headings are not)."""
    import pypdfium2 as pdfium
    from .pdftext import _LOCK
    with _LOCK:
        base = pdfium.PdfDocument(rest)
        one = pdfium.PdfDocument(first)
        try:
            base.import_pages(one, index=0)
            buf = io.BytesIO()
            base.save(buf)
            return buf.getvalue()
        finally:
            one.close()
            base.close()


def page_count(pdf: bytes) -> int:
    import pypdfium2 as pdfium
    d = pdfium.PdfDocument(pdf)
    try:
        return len(d)
    finally:
        d.close()


@dataclass
class Made:
    pdf: bytes
    pages: int
    missing: list[str]                 # pictures that could not be had, and why


async def make(doc: Doc, db=None) -> Made:
    """The document as a PDF: its pictures fetched, its page printed."""
    if not (doc.title or "").strip():
        raise RenderError("a document needs a title")
    md = body_markdown(doc)
    if len(md) > MAX_MD:
        raise RenderError(f"the text is longer than {MAX_MD} characters")
    images, missing = await resolve_images(image_sources(md), db)
    body = md_html(md, images, doc.lang)
    if doc.theme == "simple":
        pdf = await print_pdf(page_html(doc, body), header_html(doc), footer_html(doc), doc.size)
    else:
        pdf = await print_pdf(doc_page_html(doc, body), first_header_html(doc), doc_footer_html(doc), doc.size,
                              DOC_MARGIN, rest=compact_header_html(doc))
    return Made(pdf=pdf, pages=page_count(pdf), missing=missing)
