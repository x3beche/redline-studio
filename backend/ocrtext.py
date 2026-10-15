"""The words on a picture or a scanned page, written out by a model that sees.

A datasheet photographed with a phone, a page off a flatbed scanner, a
screenshot of a table: there is no text layer anywhere in them, so
pdftext.py reads nothing from them and neither datasheet_read nor file_read
can quote a line of them. Here a model that reads images (the "file_ocr"
job, Settings > LLM settings) is shown the pages as pictures and writes
their words back as text.

A PDF is read page by page: a page that carries text comes from PDFium
(pdftext.layout - tables as rows, as a datasheet's pages do) and a page that
is only a picture of text goes to the model, so a scan, a photograph and a
digital page in the same file all come out, and a PDF that is all text costs
no call at all. An image is the model's page.

Kept once, by the file's content and the language asked for (key_of), in
`file_text` (COLL) - and, like the Files lists' small pictures
(file_minis.py), that collection is the machine's and not a workspace's
(backend/scope.py does not name it): what is kept is the words of bytes the
asker already holds, it is reached only through a file they may read
(files_api.py finds it in their space first), and the same scan uploaded
twice is read - and paid for - once. A file that cannot be read keeps that
"none" too, so it is not tried again on every view; a missing key or a
provider that failed is not kept, since the person may add the key a moment
later.

Bounded: at most MAX_PAGES pages of a PDF are read, at most MAX_SHOTS page
pictures go to the model in one call, at most SLOTS reads are made at once
and QUEUE_MAX may be waiting - past that the answer is "busy" and the asker
comes back later (files_api.py answers 202 either way, and so does the
Chat's tool). A read outlives the request that started it: the first asker
starts it, the ones after are told "making".

The words go with the last copy of the file (files.py `_drop_thumb`).
"""

from __future__ import annotations

import asyncio
import base64
import io
import os
import re
import time
from datetime import datetime, timezone

from . import files, llm, pdftext, taste

COLL = "file_text"
JOB = "file_ocr"
VERSION = 1                      # bumped when the way the words are read changes
MB = 2 ** 20
# Larger than this is not read here, as a picture is not drawn above its own limit (file_minis.py).
MAX_BYTES = {"image": 30 * MB, "pdf": pdftext.MAX_BYTES}
MAX_PAGES = 12                   # pages of a PDF read in one go
MAX_SHOTS = 6                    # the most page pictures sent to the model in one call
BARE = 80                        # a page with fewer letters than this is a picture of text (datasheets.py)
PAGE_PX = 1600                   # the longer side a page goes to the model at
QUALITY = 85
MAX_CHARS = 120_000              # the words kept of one file
TOKENS = 4_000                   # the model's answer
TIMEOUT = float(os.getenv("REDLINE_OCR_TIMEOUT", "240"))
DPI = 150                        # the page is drawn at this before it is made smaller
SLOTS = 2                        # reads made at once
QUEUE_MAX = 12                   # ... and waiting or being read
RETRY_AFTER = 8                  # what the route and the command line say to wait

_running: dict[str, asyncio.Task] = {}
_slots: tuple | None = None

# What the model that reads the pages is told. {lang} is the phrase _lang() makes.
PROMPT = (
    "You write out the words on a picture of a page - a photograph, a scan, a screenshot - so that they can be read "
    "and searched as text. Write every word you can see{lang}, and nothing else: no comment of your own, no "
    "translation, no heading that is not on the page, no word you cannot read.\n"
    "Keep the page's own shape: its lines as lines, a table's row as one line with its cells separated by ' | ', a "
    "drawing's labels where they are. Numbers, units and symbols exactly as they are printed; something you cannot "
    "make out as [?].\n"
    "Each picture is one page: write that page's words after a line naming the page, exactly '--- page N ---' with "
    "the number given with the picture, and nothing before the first such line. A page with nothing written on it "
    "is that line and then '(no text)'. Answer with the pages' words only, in order."
)

# The page line the model is asked to write, as it comes back.
PAGE_LINE = re.compile(r"^[ \t]*-{0,4}[ \t]*page[ \t]*(\d+)[ \t]*-{0,4}[ \t]*$", re.I | re.M)
# What it writes for a page it found no writing on.
NO_TEXT = ("(no text)", "no text", "(no text on this page)", "[no text]")
NOT_WRITTEN = "(the model did not write this page out)"

_LANGS = {"": " in the language it is written in", "tr": " in Turkish", "en": " in English"}


def _lang(lang: str) -> str:
    """The language the words are asked for in, as the prompt says it."""
    return _LANGS.get(lang) or f" in the language '{lang}'"


def kind_of(doc: dict) -> str | None:
    """What the words are read from, or None for a file this cannot read."""
    name = (doc.get("name") or "").lower()
    ctype = (doc.get("content_type") or "").split(";")[0].strip().lower()
    preview = files.preview_of(name, doc.get("kind") or "", doc.get("content_type") or "")
    if preview == "pdf" or doc.get("kind") == "pdf" or ctype == "application/pdf":
        return "pdf"
    if (preview == "image" or ctype.startswith("image/")) and not name.endswith(".svg"):
        return "image"
    return None


def key_of(doc: dict, lang: str = "") -> str:
    """The content the words are of: its hash, or (a room's file without one)
    the entry, its size and when it was made - and the language asked for."""
    sha = doc.get("sha256")
    what = sha or f"{doc['_id']}.{doc.get('bytes') or 0}.{doc.get('at') or doc.get('created_at') or ''}"
    return f"{what}:{lang}:v{VERSION}"


def _slot() -> asyncio.Semaphore:
    global _slots
    loop = asyncio.get_running_loop()
    if _slots is None or _slots[0] is not loop:
        _slots = (loop, asyncio.Semaphore(SLOTS))
    return _slots[1]


async def words(db, doc: dict, wait: float = 1.5, lang: str = "") -> tuple[str, str | None]:
    """("ready", the words), ("making"|"busy", None) - ask again - or
    ("none", why) for a file whose words cannot be read."""
    kind = kind_of(doc)
    if kind is None:
        return "none", "the words here are read from a picture or a PDF - a photograph, a scan, a screenshot"
    if int(doc.get("bytes") or 0) > MAX_BYTES[kind]:
        return "none", f"larger than {MAX_BYTES[kind] // MB} MB - not read here"
    key = key_of(doc, lang)
    if (hit := await db[COLL].find_one({"_id": key})) is not None:
        return ("ready", hit["text"]) if hit.get("text") else ("none", hit.get("none") or "")
    task = _running.get(key)
    if task is None or task.get_loop() is not asyncio.get_running_loop():
        if len(_running) >= QUEUE_MAX:
            return "busy", None
        task = asyncio.get_running_loop().create_task(_make(db, doc, kind, key, lang))
        _running[key] = task
        task.add_done_callback(lambda t: _forget(key, t))
    try:
        return await asyncio.wait_for(asyncio.shield(task), max(wait, 0.0))
    except asyncio.TimeoutError:
        return "making", None


def _forget(key: str, task: asyncio.Task) -> None:
    if _running.get(key) is task:
        _running.pop(key, None)
    if not task.cancelled():
        task.exception()                 # retrieved: a failure is kept, not an unhandled error


async def _keep(db, doc: dict, key: str, kind: str, text: str | None, why: str = "",
                took: float = 0.0, lang: str = "") -> tuple[str, str]:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rec = {"_id": key, "sha256": doc.get("sha256") or "", "kind": kind, "lang": lang,
           "made_at": now, "ms": round(took * 1000)}
    rec.update({"text": text, "chars": len(text)} if text else {"none": why[:300]})
    await db[COLL].replace_one({"_id": key}, rec, upsert=True)
    return ("ready", text) if text else ("none", why[:300])


async def _read(db, doc: dict) -> bytes:
    """The file's bytes, wherever they are kept (Files' bucket, a room's own)."""
    _, data = await files.get(db, doc["_id"])
    return data


def _jpeg(png: bytes) -> str:
    """A page the model gets: at most PAGE_PX a side, as a JPEG data URL."""
    from PIL import Image, ImageOps
    with Image.open(io.BytesIO(png)) as im:
        im = ImageOps.exif_transpose(im)
        im.thumbnail((PAGE_PX, PAGE_PX), Image.Resampling.LANCZOS)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=QUALITY)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def _bare(text: str) -> int:
    return len(re.sub(r"\s+", "", text or ""))


def test_picture() -> str:
    """A small grey square as a data URL: for the Settings page's Test of a job
    whose model must read images (llm_api.py)."""
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (200, 200, 200)).save(buf, "PNG")
    return _jpeg(buf.getvalue())


def pages_of(data: bytes) -> list[dict]:
    """A PDF's pages, read as far as MAX_PAGES: {"n", "text"} for a page with
    a text layer, {"n", "url"} for a page that is only a picture of text (at
    most MAX_SHOTS of them; the ones past that say so in their text).
    Runs in a thread. PdfError: why the PDF cannot be read."""
    got = pdftext.layout(data, None, MAX_PAGES)
    pages, shots = [], 0
    for p in got["pages"]:
        text = p.get("text") or ""
        if _bare(text) >= BARE or not p.get("images"):
            pages.append({"n": p["n"], "text": text})
            continue
        if shots >= MAX_SHOTS:
            pages.append({"n": p["n"], "text": f"(a picture of text; at most {MAX_SHOTS} such pages are read at "
                                               "once - this one was not read)"})
            continue
        shots += 1
        png, _ = pdftext.render_png(data, p["n"], DPI)
        pages.append({"n": p["n"], "url": _jpeg(png)})
    return pages


def written(raw: str, numbers: list[int]) -> dict[int, str]:
    """The pages' words out of what the model wrote, by its own page lines.
    A model that wrote no page line at all is taken at its word for one page."""
    got: dict[int, str] = {}
    hits = list(PAGE_LINE.finditer(raw or ""))
    for i, m in enumerate(hits):
        end = hits[i + 1].start() if i + 1 < len(hits) else len(raw)
        body = raw[m.end():end].strip()
        n = int(m.group(1))
        if n in numbers and n not in got:
            got[n] = "" if body.lower() in NO_TEXT else body
    if not got and len(numbers) == 1:
        got[numbers[0]] = (raw or "").strip()
    return got


def joined(pages: list[dict], got: dict[int, str]) -> str:
    """The pages' words in the file's order, each page named when there is
    more than one; a page nothing was read from says so."""
    many = len(pages) > 1
    out = []
    for p in pages:
        body = got.get(p["n"], NOT_WRITTEN) if "url" in p else (p.get("text") or "")
        out.append((f"--- page {p['n']} ---\n" if many else "") + (body.strip() or "(no text)"))
    text = "\n\n".join(out)
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS] + "\n[... the rest of this file's words are cut]"
    return text


def _failed(prov: str, model: str, exc: BaseException) -> str:
    """A model call that failed, in a sentence for the person."""
    import httpx
    name = llm.PROVIDERS.get(prov, {}).get("name", prov)
    if isinstance(exc, (asyncio.TimeoutError, httpx.TimeoutException)):
        return (f"the {name} model {model} did not answer within {TIMEOUT:.0f} s - try again, or pick a faster model "
                "for \"Read a file's text (OCR)\" in Settings > LLM settings")
    return f"the {name} model {model} failed: {str(exc)[:300] or type(exc).__name__}"


async def route() -> tuple[str, str, bool]:
    """(provider, model, reads images) for the words: the file_ocr job's own
    model; when that one does not read images, the first other configured
    job's model that does (said in the answer); else the job's own, text only."""
    prov, model = llm.route(JOB)
    if await taste.reads_images(prov, model):
        return prov, model, True
    for j in llm.JOBS:
        p2, m2 = llm.route(j)
        if (p2, m2) != (prov, model) and llm.key(p2) and await taste.reads_images(p2, m2):
            return p2, m2, True
    return prov, model, False


async def _ask(db, prov: str, model: str, pages: list[dict], lang: str) -> str:
    """The pages' words, from the model that is shown their pictures."""
    from . import prompts
    user: list = []
    for p in pages:
        user += [{"type": "text", "text": f"--- page {p['n']} ---"},
                 {"type": "image_url", "image_url": {"url": p["url"]}}]
    d = await llm.complete([{"role": "system", "content": prompts.text(JOB, lang=_lang(lang))},
                            {"role": "user", "content": user}],
                           job=JOB, provider=prov, model=model, max_tokens=TOKENS, temperature=0.1, timeout=TIMEOUT)
    await llm.record(db, provider=d.get("provider") or prov, model=d.get("model") or model, surface="files",
                     kind=JOB, used=d.get("usage") or {})
    return ((d.get("choices") or [{}])[0].get("message") or {}).get("content") or ""


async def _make(db, doc: dict, kind: str, key: str, lang: str) -> tuple[str, str | None]:
    async with _slot():
        if (hit := await db[COLL].find_one({"_id": key})) is not None:
            return ("ready", hit["text"]) if hit.get("text") else ("none", hit.get("none") or "")
        t0 = time.monotonic()
        try:
            data = await _read(db, doc)
        except Exception as exc:                     # noqa: BLE001 - the bytes are not there
            return "none", f"the file could not be read ({type(exc).__name__})"
        try:
            pages = await asyncio.to_thread(pages_of, data) if kind == "pdf" \
                else await asyncio.to_thread(one_page, data)
            if not any((p.get("text") or "").strip() for p in pages) and not any("url" in p for p in pages):
                return await _keep(db, doc, key, kind, None, "nothing is written on this file",
                                   took=time.monotonic() - t0, lang=lang)
            got: dict[int, str] = {}
            shots = [p for p in pages if "url" in p]
            if shots:
                # Only the pages that are pictures of text cost a call; a PDF's own pages come from PDFium.
                prov, model, vision = await route()
                if not vision:
                    return "none", ("no configured model reads images - choose one for \"Read a file's text (OCR)\" "
                                    "in Settings > LLM settings")
                if not llm.key(prov):
                    return "none", llm.no_key(prov, JOB)
                try:
                    raw = await _ask(db, prov, model, shots, lang)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:             # noqa: BLE001 - said plainly; the key may be added a moment later
                    return "none", _failed(prov, model, exc)
                got = written(raw, [p["n"] for p in shots])
            return await _keep(db, doc, key, kind, joined(pages, got), took=time.monotonic() - t0, lang=lang)
        except ValueError as exc:                    # PdfError: the PDF says why
            return await _keep(db, doc, key, kind, None, why=str(exc), took=time.monotonic() - t0, lang=lang)
        except Exception as exc:                     # noqa: BLE001 - anything PDFium or Pillow cannot read
            return await _keep(db, doc, key, kind, None, why=f"no words could be read ({type(exc).__name__})",
                               took=time.monotonic() - t0, lang=lang)
        finally:
            del data


def one_page(data: bytes) -> list[dict]:
    """An image as the one page the model is shown."""
    return [{"n": 1, "url": _jpeg(data)}]


async def drop(db, sha: str | None) -> None:
    """The words read from these bytes, with the last copy of them (files.py)."""
    if sha:
        await db[COLL].delete_many({"sha256": sha})
