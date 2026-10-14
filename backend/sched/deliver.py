"""Where a scheduled task's result goes, besides its own history.

- In the app: a row in the notification centre (backend/notifications.py)
  for the task's owner, written the way that module writes its own (one row
  per event and person, its `row_id`), linking to /tasks/<id>. Two switches
  must both be on: the task's own "In the app" box, and the owner's kind
  `task` in Settings > Notifications. Without the module, the task's
  history is the in-app record.
- Telegram: through the bot's send queue (backend/tgbot/outbox.py), to the
  owner's own linked chat, only when a bot is set up, the chat is linked
  and not blocked, and the owner's `task` kind is on for Telegram.
- The words around the report (its status, "Open the task", the file's
  head) are in the owner's language (notifications.lang_of), like the
  report itself (kinds.Ctx.lang). The app has no quiet hours yet; `quiet()` is where they
  would be honoured.
- A file: Markdown or CSV, into Files > In the app > Agents > "Scheduled
  tasks" (read-only there; "Save to My files" copies it).

There is no e-mail: the app has no way to send one.
"""

from __future__ import annotations

import logging
import re

from .. import app_links, scope

log = logging.getLogger("redline.sched")

AGENT = {"type": "agent", "id": "scheduled-tasks", "name": "Scheduled tasks"}
TG_MAX = 3900
STATUS_TR = {"done": "tamamlandı", "failed": "başarısız", "missed": "kaçırıldı", "skipped": "atlandı",
             "interrupted": "yarıda kaldı", "cancelled": "iptal edildi"}
TITLES = {"done": "Task done", "failed": "Task failed", "missed": "Task missed", "skipped": "Task skipped",
          "interrupted": "Task interrupted"}


def quiet(link: dict, at=None) -> bool:
    """Whether the person asked not to be messaged now. No quiet hours exist
    in the app yet: never."""
    return False


def tg_text(md: str) -> str:
    """The report's Markdown as Telegram's HTML: escaped, **bold** and
    headings kept as bold, a table's rows as lines."""
    from ..tgbot import core
    out = []
    for line in (md or "").splitlines():
        s = line.rstrip()
        if re.match(r"^\|\s*-{2,}", s) or re.match(r"^\|?(\s*:?-{3,}:?\s*\|)+\s*$", s):
            continue
        if s.startswith("|") and s.endswith("|"):
            s = " · ".join(c.strip() for c in s.strip("|").split("|"))
        head = re.match(r"^#{1,6}\s+(.*)$", s)
        s = core.esc(head.group(1) if head else s)
        s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
        s = re.sub(r"(?<![\w*])_(.+?)_(?![\w*])", r"<i>\1</i>", s)
        out.append(f"<b>{s}</b>" if head else s)
    return "\n".join(out).strip()


def status_word(status: str, lang: str = "en") -> str:
    return STATUS_TR.get(status, status) if lang == "tr" else status


async def lang_of(raw, task: dict) -> str:
    try:
        from .. import notifications as nc
    except ImportError:
        return "en"
    return await nc.lang_of(raw, task["owner"]["id"])


def message(task: dict, run: dict, base: str | None, lang: str = "en") -> str:
    from ..tgbot import core
    status = run["status"]
    head = f"<b>{core.esc(task['name'])}</b>" + ("" if status == "done" else f" - {core.esc(status_word(status, lang))}")
    body = tg_text(run.get("output") or run.get("error") or run.get("summary") or "")
    link = app_links.app_url(base, app_links.task(task["_id"]))
    open_ = "Görevi aç" if lang == "tr" else "Open the task"
    tail = f'\n\n<a href="{core.esc(link)}">{open_}</a>' if link else ""
    room = TG_MAX - len(head) - len(tail) - 2
    if len(body) > room:
        body = body[: max(0, room - 2)].rsplit("\n", 1)[0] + "\n…"
    return f"{head}\n{body}{tail}"


async def telegram(raw, task: dict, run: dict) -> str | None:
    """Queued to the owner's chat: the outbox row's id, or why not (None)."""
    from ..tgbot import core, links, outbox
    st = await core.settings(raw)
    if not core.token_of(st):
        return None
    link = await links.of_user(raw, task["owner"]["id"])
    if not link or link.get("blocked") or quiet(link) or not links.prefs_of(link).get("task"):
        return None
    text = message(task, run, st.get("public_url"), await lang_of(raw, task))
    return await outbox.enqueue(raw, link["chat"], text=text, kind="task",
                                user=task["owner"]["id"], ws=task["workspace"])


async def bell(raw, task: dict, run: dict) -> bool:
    """One row in the owner's notification centre, if the app has one."""
    try:
        from .. import notifications as nc
    except ImportError:
        return False
    from pymongo.errors import DuplicateKeyError
    user = task["owner"]["id"]
    if not (await nc.prefs_of(raw, user))["inapp"].get("task", True):
        return False
    event = f"task:{run['_id']}"
    doc = {"_id": nc.row_id(event, user), "user": user, "workspace": task["workspace"], "kind": "task",
           "title": TITLES.get(run["status"], "Task done"),
           "ctx": nc.clip(f"{task['name']} · {run.get('summary') or run.get('error') or ''}", 240),
           "body": nc.clip(run.get("output") or "", 600), "link": app_links.task(task["_id"]),
           "tone": None if run["status"] == "done" else "danger" if run["status"] == "failed" else "warn",
           "event": event, "created_at": nc.now(), "read_at": None}
    try:
        await raw[nc.COLL].insert_one(doc)
        return True
    except DuplicateKeyError:
        return False


async def file(raw, task: dict, run: dict, csv_text: str | None) -> str | None:
    """The report as a file in In the app > Agents > Scheduled tasks: its id."""
    from .. import files
    fmt = task["deliver"].get("format") or "md"
    stamp = (run.get("started_at") or run.get("at")).strftime("%Y-%m-%d %H%M")
    if fmt == "csv" and csv_text:
        data, ext, mime = csv_text.encode(), "csv", "text/csv"
    else:
        status = status_word(run["status"], await lang_of(raw, task))
        md = f"# {task['name']}\n\n{stamp} UTC · {status}\n\n{run.get('output') or run.get('error') or ''}\n"
        data, ext, mime = md.encode(), "md", "text/markdown"
    db = scope.ScopedDb(raw, task["workspace"])
    doc = await files.put(db, f"{task['name']} {stamp}.{ext}", data, mime,
                          {"room": "tasks", "task": task["_id"], "run": run["_id"]}, AGENT,
                          note=f"Scheduled task: {task['name']}")
    return doc["_id"]


async def deliver(raw, task: dict, run: dict, csv_text: str | None = None) -> dict:
    """Every way the task asked for; each one on its own (one failing does
    not stop the others). What went where."""
    want = task.get("deliver") or {}
    got: dict = {}
    for key, go in (("inapp", lambda: bell(raw, task, run)), ("telegram", lambda: telegram(raw, task, run)),
                    ("file", lambda: file(raw, task, run, csv_text))):
        if not want.get(key):
            continue
        if key == "file" and run["status"] != "done":
            continue
        try:
            got[key] = await go()
        except Exception as exc:                                 # noqa: BLE001 - said on the run
            log.warning("scheduled task %s: %s delivery failed: %s", task["_id"], key, exc)
            got[key] = None
            got[f"{key}_error"] = str(exc)[:200]
    return got
