"""dm_read: the DM tab's conversations (backend/dm.py) - the asker's own
direct conversations with the people of this server, listed as the tab's
list shows them (who, unread, the last line), or one of them read, its
last lines oldest first, as opening it shows them.

Only the asker's own: the same `dm._chat` lookup the routes use (anyone
else's conversation is "no such conversation"), signed in as a person
(dm.me). Reading here does not mark anything read - the DM tab does that
when the person opens it."""

from __future__ import annotations

from .. import dm
from . import Ctx, Result, Tool, ToolError, clip
from . import _dm
from ._rights import need

LIMIT = 20                           # lines read by default
MOST = 100                           # and at most
LINE = 800                           # characters of one line the model gets
LIST = 40                            # conversations a list names


def _when(at) -> str:
    return str(at or "")[:16].replace("T", " ")


async def _listing(uid: str) -> Result:
    need("GET", "/api/dm/state")
    chats = [d async for d in dm._raw()[dm.CHATS].find(dm._mine(uid)).sort("updated_at", -1).limit(300)
             if uid in (d.get("members") or [])]
    if not chats:
        n = len(await _dm.people(uid))
        return Result(text=f"No direct conversations yet. {n} other people can be written to (dm_send).",
                      say="No direct conversations", vars={"n": 0}, summary="none")
    folks = await dm._people([m for d in chats for m in d.get("members") or []])
    rows = []
    unread = 0
    for d in chats[:LIST]:
        s = await dm.summary(d, uid, folks)
        unread += s["unread"]
        who = ", ".join(p["name"] for p in s["members"]) or "?"
        last = s.get("last") or {}
        rows.append(f"{d['_id']}  {who}" + (f"  {s['unread']} unread" if s["unread"] else "")
                    + (" (pinned)" if s["pinned"] else "") + (" (archived)" if s["archived"] else "")
                    + (f"  last {_when(last.get('at'))} {last.get('by') or ''}: {dm._clip(last.get('text'), 80)}" if last else ""))
    text = (f"{len(chats)} direct conversation(s), the latest first (id, with whom, unread, the last line). Read one "
            "with dm_read and its id or the person's name:\n" + "\n".join(rows))
    return Result(text=clip(text, 8_000), say="Listed {n} direct conversations", vars={"n": len(chats), "unread": unread},
                  summary=f"{len(chats)} conversations · {unread} unread")


async def run(ctx: Ctx, args: dict) -> Result:
    who = _dm.me()
    uid = who["id"]
    ref = str(args.get("person") or "").strip()
    if not ref:
        return await _listing(uid)
    try:
        limit = int(args.get("limit") or LIMIT)
    except (TypeError, ValueError):
        raise ToolError("limit is a number of lines, 1 to 100")
    limit = max(1, min(limit, MOST))
    doc, other = await _dm.thread(uid, ref)
    name = (other or {}).get("name") or ref
    if doc is None:
        return Result(text=f"There is no conversation with {name} yet: nothing was written either way.",
                      say="No conversation with {name}", vars={"name": name, "n": 0}, summary="none")
    need("GET", f"/api/dm/chats/{doc['_id']}")
    rows = [m async for m in dm._raw()[dm.MSGS].find({"chat": doc["_id"]}).sort("at", -1).limit(limit + 1)]
    more = len(rows) > limit
    rows = list(reversed(rows[:limit]))
    s = await dm.summary(doc, uid)
    lines = []
    for m in rows:
        by = (m.get("by") or {}).get("name") or "?"
        if (m.get("by") or {}).get("id") == uid:
            by += " (the person)"
        things = [f"[{it.get('kind')}: {it.get('label')}]" + (" (taken back)" if it.get("revoked") else "")
                  for it in m.get("items") or []]
        txt = str(m.get("text") or "")
        txt = txt if len(txt) <= LINE else txt[:LINE] + " [...]"
        lines.append(f"{_when(m.get('at'))} {by}: {txt}" + (" " + " ".join(things) if things else "")
                     + (" (edited)" if m.get("edited_at") else ""))
    text = (f"Direct conversation {doc['_id']} with {name}: its last {len(rows)} line(s), oldest first"
            + (" (older ones exist: ask with a larger limit)" if more else "")
            + (f"; {s['unread']} unread by the person" if s["unread"] else "") + f". Open it: /dm/{doc['_id']}\n"
            + ("\n".join(lines) or "(no lines)"))
    return Result(text=clip(text, 12_000), say="Read {n} lines with {name}",
                  vars={"name": name, "n": len(rows), "thread": doc["_id"], "unread": s["unread"]},
                  summary=f"{len(rows)} lines · {s['unread']} unread")


TOOL = Tool(
    name="dm_read", package="commandcode", level="read", order=40, default=False,
    label="Read direct messages",
    about="Lists the person's direct conversations, or reads one's last lines.",
    description="The person's direct messages with the other people of this server (the DM part of the Chat tab): "
                "without `person` it lists their conversations - with whom, unread lines, the last line; with a "
                "`person` (a name, or a conversation's id, as the list gives them) it reads that "
                "conversation's last `limit` lines (default 20, at most 100), oldest first, with what was sent "
                "along. Only their own conversations; reading here marks nothing read. Use it when they ask what "
                "someone wrote, or before writing to someone with dm_send.",
    schema={"type": "object", "properties": {
        "person": {"type": "string", "description": "Whose conversation: their name, or the conversation's id (dm-...)"},
        "limit": {"type": "integer", "minimum": 1, "maximum": MOST, "description": "How many of the last lines (default 20)"}}},
    running="Reading direct messages", failed="Could not read the direct messages",
    run=run)
