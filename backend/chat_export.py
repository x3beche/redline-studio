"""A conversation of the Chat, written out: as Markdown, or as a PDF in
Workbench's white theme (backend/pdfdoc.py, the printer `pdf_make` uses).

What goes in: the title, the day it was started and the models that
answered; then every line in order - who wrote it (a person by name, never
an e-mail address; an answer by its model) and when, its text as the
Markdown it was written in (code blocks stay code), each tool step of an
answer as one line (the tool and what it said it did), the pictures sent
with a line and those a render tool took. The model's thinking, the
context read for a mention and what the tools gave back stay out.

The file is the Chat's, like the PDFs its tools make: kept in Files under
Chat/Exports (Files > In the app > Chat, with the conversation's other
files), by the person who asked for it, and downloaded by the page from
there. It reaches My files only as a copy the person asks for ("Save to My
files"). Exporting takes the right to add a file (draw); the trail says who
exported which conversation, and how.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import actors, files, pdfdoc

FOLDER = "Chat/Exports"
FORMATS = ("md", "pdf")
NAME_MAX = 100
LINE_MAX = 400                         # characters of a step's line, as the page sends it

LABELS = {
    "en": {"date": "Date", "models": "Models", "model": "Model", "lines": "Lines", "someone": "someone",
           "purpose": "A conversation in the Chat, exported", "failed": "failed", "denied": "not allowed",
           "stopped": "stopped", "files": "Files", "error": "Error", "made": "Made"},
    "tr": {"date": "Tarih", "models": "Modeller", "model": "Model", "lines": "Satır", "someone": "biri",
           "purpose": "Sohbet'ten dışa aktarılmış bir konuşma", "failed": "başarısız", "denied": "izin verilmedi",
           "stopped": "durduruldu", "files": "Dosyalar", "error": "Hata", "made": "Yapıldı"},
}

router = APIRouter(prefix="/api/cc")


def _db():
    from .cc_chat import _db as chat_db
    return chat_db()


def _when(iso: str | None) -> str:
    try:
        w = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return ""
    if w.tzinfo is None:
        w = w.replace(tzinfo=timezone.utc)
    return pdfdoc.stamp(w)


def person(by: dict | None, lab: dict) -> str:
    """A person's name as the page shows it - never an e-mail address."""
    name = " ".join(str((by or {}).get("name") or "").split())
    if "@" in name:
        name = name.split("@", 1)[0]
    return name or lab["someone"]


def model_name(model: str | None) -> str:
    """claude-haiku-5-5 for anthropic/claude-haiku-5-5."""
    m = str(model or "").strip()
    return m.rsplit("/", 1)[-1] or m


def _fill(template: str, v: dict) -> str:
    return re.sub(r"\{(\w+)\}", lambda m: str(v[m.group(1)]) if v.get(m.group(1)) not in (None, "") else m.group(0),
                  template)


def _flat(text: str) -> str:
    """One line, with nothing in it that Markdown would read as markup."""
    t = " ".join(str(text or "").split())
    return re.sub(r"([\\`*_\[\]<>#|])", r"\\\1", t)[:LINE_MAX]


def step_line(s: dict, lab: dict, given: dict | None = None) -> str:
    """A tool step in one line: what the tool said it did - the page's own
    sentence when it sent one (in the person's language) - or its name."""
    from . import chat_tools
    tool = chat_tools.tools().get(str(s.get("tool") or ""))
    name = (tool.label if tool and tool.label else "") or str(s.get("tool") or "tool")
    st = s.get("status")
    note = {"error": lab["failed"], "denied": lab["denied"], "stopped": lab["stopped"],
            "interrupted": lab["stopped"]}.get(st)
    line = (given or {}).get(str(s.get("id") or ""))
    if not line:
        # The tool's own sentence says what it did ("Searched the web for ..."); its name only when it has none.
        line = _fill(str(s.get("say") or ""), s.get("vars") or {}) or name
    if st == "error" and s.get("error"):
        line = f"{line} ({s['error']})"
    return f"- *{_flat(line)}*" + (f" · {note}" if note else "")


def _pic(fid: str, label: str) -> str:
    alt = re.sub(r"[\[\]\\]", "", " ".join(str(label or "").split()))[:120] or "picture"
    return f"![{alt}](/api/files/{fid}?inline=1)"


def _shots(s: dict) -> list[str]:
    """The pictures a render step took (chat_tools/model_render.py): `shotN` is "view:file id"."""
    if s.get("status") != "done" or s.get("tool") not in ("model_render", "board_render"):
        return []
    v = s.get("vars") or {}
    out = []
    for k in sorted((k for k in v if re.fullmatch(r"shot\d+", k)), key=lambda k: int(k[4:])):
        view, _, fid = str(v[k]).partition(":")
        if re.fullmatch(r"[A-Za-z0-9]{6,32}", fid):
            out.append(_pic(fid, f"{v.get('title') or ''} {view}".strip()))
    return out


def _segments(text: str, steps: list[dict]) -> list[tuple[str, list[dict]]]:
    from .cc_chat import _segments as cut
    return cut(text, steps)


def line_markdown(m: dict, lab: dict, given: dict | None = None) -> str:
    """One line of the conversation: who and when, then what it says."""
    if m.get("role") == "user":
        who = person(m.get("by"), lab)
    else:
        who = model_name(m.get("model")) or lab["model"]
    head = f"### {_flat(who)} · {_when(m.get('at'))}".rstrip(" ·")
    body: list[str] = []
    text = str(m.get("content") or "")
    steps = [s for s in m.get("steps") or [] if isinstance(s, dict)]
    if steps and "```task" not in text:
        for part, here in _segments(text, steps):
            if part.strip():
                body.append(part.strip())
            if here:
                body.append("\n".join(step_line(s, lab, given) for s in here))
                pics = [p for s in here for p in _shots(s)]
                if pics:
                    body.append(" ".join(pics))
    else:
        if steps:
            body.append("\n".join(step_line(s, lab, given) for s in steps))
            pics = [p for s in steps for p in _shots(s)]
            if pics:
                body.append(" ".join(pics))
        if text.strip():
            body.append(text.strip())
    sent = [x for x in m.get("mentions") or [] if isinstance(x, dict)]
    pics = [_pic(x["id"], x.get("label") or "") for x in sent if x.get("kind") == "file" and x.get("image") and x.get("id")]
    others = [str(x.get("label") or x.get("id") or "") for x in sent if not (x.get("kind") == "file" and x.get("image"))]
    if others:
        body.append(f"*{_flat(lab['files'] + ': ' + ', '.join(o for o in others if o))}*")
    if pics:
        body.append(" ".join(pics))
    if m.get("error"):
        body.append(f"> {_flat(lab['error'] + ': ' + str(m['error']))}")
    return head + "\n\n" + "\n\n".join(b for b in body if b.strip())


def models_of(doc: dict) -> list[str]:
    seen: list[str] = []
    for m in doc.get("messages") or []:
        if m.get("role") != "user":
            n = model_name(m.get("model"))
            if n and n not in seen:
                seen.append(n)
    return seen or ([model_name(doc.get("model"))] if doc.get("model") else [])


def title_of(doc: dict) -> str:
    return " ".join(str(doc.get("title") or "").split())[:200] or "Conversation"


def body(doc: dict, lang: str = "en", given: dict | None = None) -> str:
    """Every line, in order, as Markdown (no title: the PDF prints its own)."""
    lab = LABELS.get(lang, LABELS["en"])
    msgs = [m for m in doc.get("messages") or [] if isinstance(m, dict)]
    return "\n\n---\n\n".join(line_markdown(m, lab, given) for m in msgs)


def markdown(doc: dict, lang: str = "en", given: dict | None = None) -> str:
    """The conversation as one Markdown file: its title, the day, the models, then every line."""
    lab = LABELS.get(lang, LABELS["en"])
    msgs = [m for m in doc.get("messages") or [] if isinstance(m, dict)]
    meta = [f"{lab['date']}: {_when(doc.get('created_at'))}"]
    ms = models_of(doc)
    if ms:
        meta.append(f"{lab['models'] if len(ms) > 1 else lab['model']}: {', '.join(ms)}")
    meta.append(f"{lab['lines']}: {len(msgs)}")
    return f"# {_flat(title_of(doc))}\n\n*{_flat(' · '.join(meta))}*\n\n---\n\n{body(doc, lang, given)}\n"


def filename(title: str, ext: str, when: datetime | None = None) -> str:
    n = re.sub(r"[\x00-\x1f\\/:*?\"<>|]+", " ", title)
    n = re.sub(r"\s+", " ", n).strip(" .")[:NAME_MAX] or "Conversation"
    return f"{n} {(when or datetime.now(timezone.utc)).strftime('%Y-%m-%d')}.{ext}"


async def _free(db, folder: str, name: str) -> str:
    """`name`, or `name (2)`, ... - not one already in the folder."""
    stem, dot, ext = name.rpartition(".")
    cand, n = name, 1
    while await db[files.COLL].find_one({"folder": folder, "name": cand}, {"_id": 1}):
        n += 1
        cand = f"{stem} ({n}){dot}{ext}"
        if n > 200:
            break
    return cand


class ExportIn(BaseModel):
    format: str = Field(default="md", max_length=8)
    lang: str = Field(default="en", max_length=8)
    # The steps' sentences as the page shows them (in the person's language), by step id.
    lines: dict[str, str] = Field(default_factory=dict, max_length=2000)
    size: str = Field(default="A4", max_length=10)


async def export(db, cid: str, fmt: str, lang: str = "en", given: dict | None = None, size: str = "A4",
                 by: dict | None = None) -> dict:
    """The conversation written out and kept in Files under Chat/Exports."""
    from .cc_chat import COLL, LIVE
    if fmt not in FORMATS:
        raise HTTPException(422, f"format is one of {', '.join(FORMATS)}")
    lang = lang if lang in LABELS else "en"
    doc = await db[COLL].find_one({"_id": cid, **LIVE})
    if not doc:
        raise HTTPException(404, "no such conversation")
    if not doc.get("messages"):
        raise HTTPException(409, "the conversation has no lines yet")
    given = {str(k)[:40]: " ".join(str(v).split())[:LINE_MAX] for k, v in (given or {}).items()}
    by = by or actors.current()
    who = {k: by.get(k) for k in ("type", "id", "name") if k in by}
    title = title_of(doc)
    pages = None
    if fmt == "md":
        data = markdown(doc, lang, given).encode("utf-8")
        ctype = "text/markdown"
    else:
        lab = LABELS[lang]
        ms = models_of(doc)
        meta = [(lab["models"] if len(ms) > 1 else lab["model"], ", ".join(ms))] if ms else []
        meta.append((lab["lines"], str(len(doc.get("messages") or []))))
        made_on = None
        try:
            made_on = datetime.fromisoformat(str(doc.get("created_at")).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            pass
        text = body(doc, lang, given)
        if len(text) > pdfdoc.MAX_MD:
            raise HTTPException(413, "the conversation is too long for a PDF - export it as Markdown")
        pdf = pdfdoc.Doc(title=title, body=text, purpose=lab["purpose"], author="", size=size if size in pdfdoc.SIZES else "A4",
                         lang=lang, created=made_on, meta=meta)
        try:
            made = await pdfdoc.make(pdf, db)
        except pdfdoc.RenderError as exc:
            raise HTTPException(502, str(exc)) from exc
        data, pages, ctype = made.pdf, made.pages, "application/pdf"
    try:
        folder = await files.make_path(db, FOLDER, who)
    except (ValueError, KeyError) as exc:
        raise HTTPException(409, f"the folder {FOLDER}: {exc}") from exc
    name = await _free(db, folder["_id"], filename(title, fmt))
    try:
        f = await files.put(db, name, data, ctype, {"room": "commandcode", "chat": cid}, who,
                            note=LABELS[lang]["purpose"], folder=folder["_id"])
    except ValueError as exc:
        raise HTTPException(413, str(exc)) from exc
    await actors.audit(db, "export", f"chat {cid}", {"format": fmt, "file": f["_id"], "name": name})
    return {"id": f["_id"], "name": name, "bytes": f["bytes"], "folder": folder.get("path") or FOLDER,
            "format": fmt, **({"pages": pages} if pages is not None else {})}


@router.post("/chats/{cid}/export")
async def export_chat(cid: str, body: ExportIn) -> dict:
    """The conversation as Markdown (`format: md`) or a PDF (`pdf`), kept in
    Files under Chat/Exports - the Chat's own area, not My files - and
    answered with the file, for the page to download. `lines`: the steps'
    sentences as the page shows them, by step id."""
    return await export(_db(), cid, body.format.lower(), body.lang.lower()[:2], body.lines, body.size)
