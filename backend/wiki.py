"""A project's wiki: what was decided and why, the dimensions and limits,
where the parts come from, the open questions, the production notes.

A project is a top folder of the tree (iot-fan, aribax, pyro...): the
same thing the 3D, PCB and Firmware rooms call a project, and Taste a
product line (backend/taste.py product_of). Its wiki is a handful of
short Markdown pages, each with a name the person gives it ("Decisions",
"Dimensions and limits") and an id read from that name (`slug`). A page
links another as [[Its name]] or [[its-name|words]], and points at a
model, a board, a part or a firmware as @model:iot-fan/parts/lid,
@board:controller, @part:C25744, @firmware:cb4a67357c9f - the page draws
both as links that open the thing in the app.

The wiki is the project's facts; Taste is how the person likes things
designed in general. A palette item says "outer corners R6-8"; the wiki
says "the lid is 3 mm because the M3 inserts need it (2026-10-12)".

Every save is a version of its own (`wiki_versions`): who, when, the
words of the change, the whole text - so the history shows any version,
its difference from the one before, and puts an old one back as a new
version (restore never rewrites history). A save names the version it
was made on (`base`): when the page moved on since, it is refused rather
than written over.

Who may: everyone in the workspace reads (GET is "view"); writing is
"edit" (backend/access.py: owner, admin, user, editor tokens), deleting a
page "delete". Pages live in the workspace's own space (backend/scope.py),
and every write is a line in the audit trail.

The rooms' agents read it before they work a note (`brief`, printed by
`revisions.py show`): the project's pages, pinned ones first, then the
newest, bounded so the brief stays a brief. The Chat reads it with
wiki_search / wiki_read and writes with wiki_write, which always asks the
person first, showing the change (backend/chat_tools/wiki_write.py).

TODO (not in v1): suggest "add this to the wiki?" when a conversation or
a finished note settles a decision - the hook is `suggest_from()` below,
which returns nothing yet.
"""

from __future__ import annotations

import difflib
import re
from datetime import datetime, timezone

COLL = "wiki_pages"
VERSIONS = "wiki_versions"

MAX_TEXT = 20_000          # characters of one page: a wiki page is short
MAX_TITLE = 80
MAX_SUMMARY = 200
MAX_PAGES = 300            # pages of one project
KEEP_VERSIONS = 200        # versions kept of one page; older ones go
BRIEF_CHARS = 6_000        # the agents' brief, all pages together
BRIEF_PAGE = 2_500         # ...and one page of it

# [[Page name]] or [[page-name|the words shown]]
LINK = re.compile(r"\[\[([^\[\]\n|]{1,80})(?:\|([^\[\]\n]{1,80}))?\]\]")
MENTION_KINDS = ("model", "board", "part", "firmware")
# @model:iot-fan/parts/lid - an id ends on a letter or digit, so a full stop after it is the sentence's.
MENTION = re.compile(r"(?<![\w@])@(model|board|part|firmware):([A-Za-z0-9_](?:[A-Za-z0-9_./\-]*[A-Za-z0-9_])?)")
# Code is code: [[x]] or @model:x inside it is not a link.
CODE = re.compile(r"```[\s\S]*?(?:```|$)|`[^`\n]+`")


class Refused(Exception):
    """Not done; the message says why. `status` is the HTTP status it means."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def slug(name: str) -> str:
    """A page's id from its name: lower case, words joined by '-'. The page
    (frontend/src/app/rooms/wiki-text.ts slug) does the same."""
    s = str(name or "").replace("İ", "i").strip().lower()
    s = re.sub(r"[^\w-]+", "-", s, flags=re.UNICODE).strip("-_")
    return re.sub(r"-{2,}", "-", s)[:60].strip("-")


def page_id(project: str, sl: str) -> str:
    return f"{project}/{sl}"


def parse(text: str) -> dict:
    """The pages a text links to (slugs, in order, once each) and what it
    mentions ({kind, id}), code left out."""
    bare = CODE.sub(" ", text or "")
    links: list[str] = []
    for m in LINK.finditer(bare):
        s = slug(m.group(1))
        if s and s not in links:
            links.append(s)
    mentions: list[dict] = []
    for m in MENTION.finditer(bare):
        one = {"kind": m.group(1), "id": m.group(2)}
        if one not in mentions:
            mentions.append(one)
    return {"links": links, "mentions": mentions}


# ---------------------------------------------------------------- projects

def _top(path: str | None) -> str:
    return (path or "").split("/", 1)[0].strip()


async def projects(db) -> list[dict]:
    """The workspace's projects - its top folders, and any project that has
    pages - each with how many pages its wiki has and when one last changed."""
    names: set[str] = set()
    async for f in db["folders"].find({}, {"_id": 1}):
        if _top(f["_id"]):
            names.add(_top(f["_id"]))
    async for m in db["models"].find({}, {"folder": 1}):
        top = _top(m.get("folder") or (m["_id"] if "/" in m["_id"] else ""))
        if top:
            names.add(top)
    async for b in db["boards"].find({}, {"folder": 1}):
        if _top(b.get("folder")):
            names.add(_top(b.get("folder")))
    count: dict[str, list] = {}
    async for p in db[COLL].find({}, {"project": 1, "updated_at": 1}):
        c = count.setdefault(p["project"], [0, ""])
        c[0] += 1
        c[1] = max(c[1], p.get("updated_at") or "")
        names.add(p["project"])
    return [{"id": n, "pages": count.get(n, [0, ""])[0], "updated_at": count.get(n, [0, None])[1] or None}
            for n in sorted(names, key=str.lower)]


async def exists(db, project: str) -> bool:
    return any(p["id"] == project for p in await projects(db))


async def project_of(db, kind: str, ref: str) -> str | None:
    """The project a model, board or firmware is in: its top folder. A model
    or a board at the top of the tree is in none."""
    if not ref:
        return None
    if kind == "model":
        d = await db["models"].find_one({"_id": ref}, {"folder": 1}) or {}
        return _top(d.get("folder") or (ref if "/" in ref else "")) or None
    if kind == "firmware":
        fw = await db["firmware"].find_one({"_id": ref}, {"board": 1}) or {}
        if not fw.get("board"):
            return None
        kind, ref = "board", str(fw["board"])
    if kind == "board":
        b = await db["boards"].find_one({"_id": ref}, {"folder": 1}) or {}
        return _top(b.get("folder")) or None
    if kind == "folder":
        return _top(ref) or None
    return None


# ---------------------------------------------------------------- pages

def _listed(d: dict) -> dict:
    """A page in a list: everything but its text."""
    return {"project": d["project"], "slug": d["slug"], "title": d.get("title") or d["slug"],
            "version": d.get("version") or 1, "pinned": bool(d.get("pinned")),
            "chars": len(d.get("text") or ""), "links": d.get("links") or [],
            "updated_at": d.get("updated_at"), "updated_by": d.get("updated_by") or {},
            "summary": d.get("summary") or ""}


def _order(rows: list[dict]) -> list[dict]:
    """Pinned first, then the newest."""
    rows = sorted(rows, key=lambda d: d.get("updated_at") or "", reverse=True)
    return sorted(rows, key=lambda d: not d.get("pinned"))


async def pages(db, project: str) -> list[dict]:
    rows = [d async for d in db[COLL].find({"project": project})]
    return [_listed(d) for d in _order(rows)]


async def get(db, project: str, name: str) -> dict | None:
    """A page by its name or slug, whole, with the pages that link to it."""
    sl = slug(name)
    d = await db[COLL].find_one({"_id": page_id(project, sl)}) if sl else None
    if not d:
        return None
    back = [{"slug": o["slug"], "title": o.get("title") or o["slug"]}
            async for o in db[COLL].find({"project": project}, {"slug": 1, "title": 1, "links": 1})
            if sl in (o.get("links") or []) and o["slug"] != sl]
    titles = {o["slug"]: o.get("title") or o["slug"]
              async for o in db[COLL].find({"project": project}, {"slug": 1, "title": 1})}
    return {**_listed(d), "text": d.get("text") or "", "mentions": d.get("mentions") or [],
            "created_at": d.get("created_at"), "created_by": d.get("created_by") or {},
            "linked_from": sorted(back, key=lambda x: x["title"].lower()),
            # The links it holds, and whether each page is there yet (a link to none makes it).
            "link_titles": {s: titles.get(s) for s in d.get("links") or []}}


def _who(by: dict | None) -> dict:
    by = by or {}
    return {k: by[k] for k in ("type", "id", "name") if by.get(k)}


async def write(db, project: str, name: str, *, text: str | None = None, append: str | None = None,
                summary: str = "", title: str | None = None, base: int | None = None,
                by: dict | None = None, restored_from: int | None = None) -> tuple[dict, bool]:
    """Write a page: `text` is its whole new text, or `append` goes at its
    end. A new page is made when there is none of that name. Returns the
    page and whether anything changed. `base` - the version the change was
    made on - is checked: a page that moved on since is refused (409)."""
    from . import actors

    project = str(project or "").strip()
    if not project or "/" in project:
        raise Refused("name a project (a top folder of the tree)")
    sl = slug(name)
    if not sl:
        raise Refused("give the page a name with letters or digits in it")
    if (text is None) == (append is None):
        raise Refused("give the page's whole text, or the lines to append to it")
    by = _who(by or actors.current())
    pid = page_id(project, sl)
    cur = await db[COLL].find_one({"_id": pid})
    if cur is None and not await exists(db, project):
        raise Refused(f"no project {project!r} here - a project is a top folder of the tree", 404)
    if cur is not None and base is not None and int(base) != int(cur.get("version") or 1):
        raise Refused(f"the page changed since version {base} (it is at version {cur.get('version')}) - "
                      "read it again and redo the change on it", 409)
    before = (cur or {}).get("text") or ""
    if append is not None:
        add = str(append).strip("\n")
        new = (before.rstrip("\n") + "\n\n" + add if before.strip() else add) if add.strip() else before
    else:
        new = str(text).replace("\r\n", "\n")
    new = new.strip("\n") + "\n" if new.strip() else ""
    if not new:
        raise Refused("a page needs some text - to remove a page, delete it")
    if len(new) > MAX_TEXT:
        raise Refused(f"a wiki page is at most {MAX_TEXT} characters (this would be {len(new)}) - "
                      "split it into pages and link them with [[...]]")
    want_title = (title or (cur or {}).get("title") or str(name).strip())[:MAX_TITLE].strip() or sl
    summary = str(summary or "").strip()[:MAX_SUMMARY]
    if cur is not None and new == before and want_title == cur.get("title"):
        return await get(db, project, sl) or {}, False
    if cur is None:
        n_pages = len([1 async for _ in db[COLL].find({"project": project}, {"_id": 1})])
        if n_pages >= MAX_PAGES:
            raise Refused(f"a project's wiki holds at most {MAX_PAGES} pages")
    now = _now()
    n = int((cur or {}).get("version") or 0) + 1
    got = parse(new)
    fields = {"project": project, "slug": sl, "title": want_title, "text": new, "version": n,
              "links": got["links"], "mentions": got["mentions"], "updated_at": now, "updated_by": by,
              "summary": summary}
    if cur is None:
        doc = {"_id": pid, **fields, "pinned": False, "created_at": now, "created_by": by}
        try:
            await db[COLL].insert_one(doc)
        except Exception as exc:                                   # noqa: BLE001 - a duplicate key: made meanwhile
            if "duplicate" in str(exc).lower() or "E11000" in str(exc):
                raise Refused("someone made this page just now - read it and redo the change on it", 409) from exc
            raise
    else:
        res = await db[COLL].update_one({"_id": pid, "version": cur.get("version")}, {"$set": fields})
        if not getattr(res, "matched_count", 1):
            raise Refused("the page changed while this was saved - read it again", 409)
    added, removed = _counts(before, new)
    await db[VERSIONS].insert_one({
        "_id": f"{pid}@{n}", "page": pid, "project": project, "slug": sl, "n": n, "title": want_title,
        "text": new, "by": by, "at": now, "summary": summary, "added": added, "removed": removed,
        **({"restored_from": int(restored_from)} if restored_from else {})})
    if n > KEEP_VERSIONS:
        await db[VERSIONS].delete_many({"page": pid, "n": {"$lte": n - KEEP_VERSIONS}})
    await actors.audit(db, "wiki.restore" if restored_from else "wiki.write", pid,
                       {"version": n, **({"summary": summary} if summary else {}),
                        **({"restored_from": restored_from} if restored_from else {})}, by or None)
    return await get(db, project, sl) or {}, True


async def set_pinned(db, project: str, name: str, pinned: bool) -> dict:
    sl = slug(name)
    res = await db[COLL].update_one({"_id": page_id(project, sl)}, {"$set": {"pinned": bool(pinned)}})
    if not getattr(res, "matched_count", 1):
        raise Refused(f"no page {name!r} in {project}'s wiki", 404)
    return await get(db, project, sl) or {}


async def remove(db, project: str, name: str) -> bool:
    """A page and its history go; the audit trail keeps that it did."""
    from . import actors
    pid = page_id(project, slug(name))
    gone = bool(getattr(await db[COLL].delete_one({"_id": pid}), "deleted_count", 0))
    if gone:
        await db[VERSIONS].delete_many({"page": pid})
        await actors.audit(db, "wiki.delete", pid)
    return gone


# ---------------------------------------------------------------- history

def _counts(a: str, b: str) -> tuple[int, int]:
    added = removed = 0
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a.splitlines(), b.splitlines(), autojunk=False).get_opcodes():
        if op in ("replace", "delete"):
            removed += i2 - i1
        if op in ("replace", "insert"):
            added += j2 - j1
    return added, removed


def diff_rows(a: str, b: str, context: int = 3) -> list[dict]:
    """Line by line, from `a` to `b`: kept lines ("=") around the changes
    ("-" gone, "+" new), a skip ("…") where unchanged lines are left out.
    Each row has its line numbers in a and b."""
    al, bl = (a or "").splitlines(), (b or "").splitlines()
    sm = difflib.SequenceMatcher(None, al, bl, autojunk=False)
    rows: list[dict] = []
    groups = list(sm.get_grouped_opcodes(context)) if al != bl else []
    for gi, group in enumerate(groups):
        if gi or group[0][1] > 0 or group[0][3] > 0:
            rows.append({"op": "…", "text": ""})
        for op, i1, i2, j1, j2 in group:
            if op == "equal":
                rows += [{"op": "=", "text": al[i], "a": i + 1, "b": j1 + i - i1 + 1} for i in range(i1, i2)]
                continue
            if op in ("replace", "delete"):
                rows += [{"op": "-", "text": al[i], "a": i + 1} for i in range(i1, i2)]
            if op in ("replace", "insert"):
                rows += [{"op": "+", "text": bl[j], "b": j + 1} for j in range(j1, j2)]
    if groups:
        last = groups[-1][-1]
        if last[2] < len(al) or last[4] < len(bl):
            rows.append({"op": "…", "text": ""})
    return rows


def diff_text(a: str, b: str, limit: int = 4000) -> str:
    """The same as a few lines of text (the Chat's preview of a write)."""
    out = []
    for r in diff_rows(a, b, context=2):
        out.append("  ..." if r["op"] == "…" else ("  " if r["op"] == "=" else r["op"] + " ") + r["text"])
    s = "\n".join(out) or "(no change)"
    return s if len(s) <= limit else s[:limit] + f"\n[... {len(s) - limit} more characters of the change]"


async def history(db, project: str, name: str) -> list[dict]:
    pid = page_id(project, slug(name))
    rows = [d async for d in db[VERSIONS].find({"page": pid})]
    rows.sort(key=lambda d: d.get("n") or 0, reverse=True)
    return [{"n": d["n"], "title": d.get("title"), "by": d.get("by") or {}, "at": d.get("at"),
             "summary": d.get("summary") or "", "added": d.get("added") or 0, "removed": d.get("removed") or 0,
             "chars": len(d.get("text") or ""), **({"restored_from": d["restored_from"]} if d.get("restored_from") else {})}
            for d in rows]


async def version(db, project: str, name: str, n: int) -> dict | None:
    d = await db[VERSIONS].find_one({"_id": f"{page_id(project, slug(name))}@{int(n)}"})
    if not d:
        return None
    return {"n": d["n"], "title": d.get("title"), "text": d.get("text") or "", "by": d.get("by") or {},
            "at": d.get("at"), "summary": d.get("summary") or ""}


async def compare(db, project: str, name: str, n: int, against: int | None = None) -> dict:
    """Version `n` against `against` (the one before it, by default; 0 is
    the empty page before the first)."""
    to = await version(db, project, name, n)
    if not to:
        raise Refused(f"no version {n} of {name!r}", 404)
    m = int(against) if against is not None else int(n) - 1
    frm = await version(db, project, name, m) if m > 0 else None
    if m > 0 and not frm:
        # The one before is gone (KEEP_VERSIONS): compare with the oldest kept.
        older = [h["n"] for h in await history(db, project, name) if h["n"] < int(n)]
        frm = await version(db, project, name, max(older)) if older else None
    return {"from": frm["n"] if frm else 0, "to": to["n"], "version": to,
            "rows": diff_rows((frm or {}).get("text") or "", to["text"])}


async def restore(db, project: str, name: str, n: int, by: dict | None = None) -> dict:
    """Version `n` back as the page's text: a new version, not a rewind."""
    old = await version(db, project, name, n)
    if not old:
        raise Refused(f"no version {n} of {name!r}", 404)
    got, _ = await write(db, project, name, text=old["text"], title=old.get("title"),
                         summary=f"Restored version {n}", by=by, restored_from=n)
    return got


# ---------------------------------------------------------------- search

def _snippet(text: str, rx: re.Pattern, width: int = 140) -> tuple[str, int]:
    for i, line in enumerate(text.splitlines(), 1):
        m = rx.search(line)
        if m:
            a = max(0, m.start() - width // 3)
            return ("…" if a else "") + line[a:a + width].strip(), i
    return text[:width].replace("\n", " ").strip(), 0


async def search(db, q: str, project: str | None = None, limit: int = 20) -> list[dict]:
    """Pages whose name or text has the words, the name's matches first.
    Every word must be there (any order)."""
    words = [w for w in str(q or "").split() if w][:8]
    if not words:
        return []
    rxs = [re.compile(re.escape(w), re.IGNORECASE) for w in words]
    hits = []
    async for d in db[COLL].find({"project": project} if project else {}):
        hay = f"{d.get('title') or ''}\n{d.get('text') or ''}"
        if not all(r.search(hay) for r in rxs):
            continue
        in_title = sum(1 for r in rxs if r.search(d.get("title") or "") or r.search(d["slug"]))
        n = sum(len(r.findall(hay)) for r in rxs)
        snip, line = _snippet(d.get("text") or "", rxs[0])
        hits.append(({"project": d["project"], "slug": d["slug"], "title": d.get("title") or d["slug"],
                      "snippet": snip, "line": line, "updated_at": d.get("updated_at")},
                     (-in_title, -n, d.get("title") or "")))
    hits.sort(key=lambda h: h[1])
    return [h[0] for h in hits[:max(1, min(limit, 100))]]


# ---------------------------------------------------------------- the agents' brief

async def brief(db, project: str, budget: int = BRIEF_CHARS) -> list[str]:
    """The project's wiki as a room's agent gets it with a note: each page
    under its name and id, pinned first, then the newest; a page longer
    than BRIEF_PAGE is cut, and when the budget runs out the rest are only
    named. Lines, without indent; empty when the project has no pages."""
    rows = _order([d async for d in db[COLL].find({"project": project})])
    if not rows:
        return []
    out: list[str] = []
    used = 0
    left: list[str] = []
    for d in rows:
        text = (d.get("text") or "").strip()
        if len(text) > BRIEF_PAGE:
            text = text[:BRIEF_PAGE].rstrip() + f"\n[... cut: {len(d['text']) - BRIEF_PAGE} more characters]"
        when = (d.get("updated_at") or "")[:10]
        who = (d.get("updated_by") or {}).get("name") or "?"
        head = (f"## {d.get('title') or d['slug']}  [{d['slug']}]" + (" - pinned" if d.get("pinned") else "")
                + f" - v{d.get('version') or 1}, {when}, {who}")
        cost = len(head) + len(text) + 2
        if used + cost > budget and out:
            left.append(d["slug"])
            continue
        if used + cost > budget:
            text = text[:max(200, budget - len(head) - 60)].rstrip() + "\n[... cut to fit the brief]"
            cost = len(head) + len(text) + 2
        out += [head, *text.splitlines(), ""]
        used += cost
    if left:
        out.append(f"not shown here (the brief is {budget} characters at most): {', '.join(left)}")
    return out


async def brief_for(db, targets: list[tuple[str, str]], budget: int = BRIEF_CHARS) -> tuple[str | None, list[str]]:
    """The brief of the project a note's targets ((kind, id) - its model,
    board or firmware) are in: (project, lines)."""
    for kind, ref in targets:
        p = await project_of(db, kind, ref)
        if p:
            return p, await brief(db, p, budget)
    return None, []


def suggest_from(_text: str) -> list[dict]:
    """The hook for "add this to the wiki?" suggestions (not in v1): what a
    conversation or a finished note decided, as proposed lines for a page."""
    return []
