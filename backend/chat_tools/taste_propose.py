"""taste_propose: a statement proposed for the person's taste, put where an
extraction's proposals wait (backend/taste.py: a finished run of
`taste_jobs` holding `proposals`) - so the person reviews it in the Taste
tab exactly as they review an extraction's: accept, edit or reject, then
save the ones they keep into a palette. Nothing goes into a palette here.

A conversation's proposals gather on one run of its own (project kind
"chat"), until they are saved; a `palette` named is the one the Taste tab
offers to save them into. It asks the person first, and what it writes goes
through the workspace, so the Chat's undo takes the proposal back."""

from __future__ import annotations

import secrets

from .. import taste
from . import Ctx, Result, Tool, ToolError
from ._rights import need
from ._things import find

STRENGTHS = ("prefer", "avoid")      # a "must" is the person's own word: written in the Taste tab
MOST = 30                            # proposals one conversation's run holds (an extraction asks for at most as many)


async def _title(ctx: Ctx) -> str:
    if not ctx.chat:
        return "the Chat"
    from .. import cc_chat
    doc = await ctx.db[cc_chat.COLL].find_one({"_id": ctx.chat}, {"title": 1})
    return str((doc or {}).get("title") or "a conversation")[:160]


async def run(ctx: Ctx, args: dict) -> Result:
    need("POST", "/api/taste/extract")
    strength = str(args.get("strength") or "").strip().lower()
    if strength not in STRENGTHS:
        raise ToolError("strength is prefer or avoid (a must is written by the person in the Taste tab)")
    item = taste.clean_item({"text": args.get("text"), "strength": strength, "domain": args.get("domain") or "general",
                             "applies_to": args.get("scope") or "", "why": args.get("why") or ""}, None)
    if not item:
        raise ToolError("say the statement: one short, checkable sentence, like \"Outside edges filleted 1 mm\"")
    target = None
    if str(args.get("palette") or "").strip():
        pal = await find(ctx.db, taste.COLL, str(args["palette"]), ("name", "description"), "taste palette")
        target = {"id": pal["_id"], "name": pal.get("name") or pal["_id"]}
        if any(str(i.get("text") or "").lower() == item["text"].lower() for i in pal.get("items") or []):
            raise ToolError(f"\"{item['text']}\" is in {target['name']} already")
    chat = ctx.chat or "chat"
    jobs = taste.JOBS
    now = taste._now()
    run_doc = await ctx.db[jobs].find_one({"project.kind": "chat", "project.id": chat, "status": "done",
                                           "saved_to": None})
    if run_doc and len(run_doc.get("proposals") or []) >= MOST:
        raise ToolError(f"this conversation has {MOST} proposals waiting in the Taste tab: review those first")
    if run_doc:
        if any(p.get("text", "").lower() == item["text"].lower() for p in run_doc.get("proposals") or []):
            raise ToolError(f"\"{item['text']}\" is proposed already: it waits in the Taste tab")
        props = [*(run_doc.get("proposals") or []), item]
        sets = {"proposals": props, "totals.proposals": len(props), "finished_at": now}
        if target:
            sets["target"] = target
        await ctx.db[jobs].update_one({"_id": run_doc["_id"]}, {"$set": sets})
        jid, n = run_doc["_id"], len(props)
    else:
        jid, n = secrets.token_hex(6), 1
        label = await _title(ctx)
        await ctx.db[jobs].insert_one({
            "_id": jid, "status": "done", "project": {"kind": "chat", "id": chat, "label": label},
            "by": ctx.actor or {}, "started_at": now, "finished_at": now, "beat": now, "worker": taste.WORKER,
            "provider": None, "model": None, "provider_name": None,
            "steps": [{"id": "chat", "state": "done", "kind": "done", "started_at": now, "finished_at": now,
                       "seconds": 0, "proposals": 1}],
            "totals": {"proposals": 1}, "proposals": [item], "error": None, "saved_to": None, "seconds": 0,
            **({"target": target} if target else {})})
    link = f"/taste/run/{jid}"
    to = f" - it offers to save into {target['name']}" if target else ""
    text = (f"Proposed for the person's taste ({item['strength'].upper()}, {taste.DOMAIN_NAMES.get(item['domain'], item['domain'])}"
            + (f", where: {item['applies_to']}" if item["applies_to"] != "all" else "") + f"): \"{item['text']}\". "
            f"It waits with this conversation's other proposals ({n}) for the person to review and save in the Taste "
            f"tab{to}: {link}. Nothing is in a palette until they save it.")
    return Result(text=text, say="Proposed for taste: {text}",
                  vars={"text": item["text"][:80], "strength": item["strength"], "run": jid, "link": link, "n": n,
                        "palette": (target or {}).get("name", "")},
                  summary=f"{item['strength']} · {n} waiting in Taste")


TOOL = Tool(
    name="taste_propose", package="taste", level="change", order=69,
    label="Propose a taste rule",
    about="Proposes a statement for a taste palette; the person reviews it in the Taste tab. Asks first.",
    description="Propose one statement for the person's design taste - the way an extraction's proposals are made: "
                "it waits in the Taste tab, where the person accepts, edits or rejects it and saves it into a "
                "palette; nothing goes into a palette here. `text`: one short, checkable sentence (\"Outside edges "
                "filleted 1 mm\"); `strength` prefer or avoid; `scope`: where it holds (visible, hidden, internal, "
                "or a few words); `domain` form, mechanical, pcb, firmware or general; `palette`: the palette it is "
                "meant for (offered first when they save). Use it only when the person asks to remember a "
                "preference as taste; it asks them first. Read the palettes with taste_read.",
    schema={"type": "object", "properties": {
        "text": {"type": "string", "description": "The statement, one short checkable sentence"},
        "strength": {"type": "string", "enum": list(STRENGTHS)},
        "scope": {"type": "string", "description": "Where it holds: visible, hidden, internal, or a few words"},
        "domain": {"type": "string", "enum": list(taste.DOMAINS)},
        "why": {"type": "string", "description": "Why, in a few words (optional)"},
        "palette": {"type": "string", "description": "The palette it is meant for: id or name (optional)"}},
        "required": ["text", "strength"]},
    running="Proposing for taste: {text}", failed="Could not propose it",
    asks=lambda args: True,
    run=run)
