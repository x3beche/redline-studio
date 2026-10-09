"""Command Code answers, written apart from the request that asked for them.

An answer used to be written inside the POST that asked for it: closing the
tab cut the stream, and with it the answer (kept as "stopped"); a refresh
lost it the same way; and uvicorn --reload, which restarts the API on every
save of a backend file, cut every answer being written at that moment.

So an answer is a generation of its own, written by a process of its own
(`python -m backend.ccgen <gen>`, its own session, as backend/buildjobs.py
does for builds): the API writes the generation down (`cc_gens`, the
machine's like `build_jobs`, holding its workspace), takes the
conversation's lock (`gen` on the conversation: one answer at a time), and
starts the runner. The runner streams the model and writes the answer so
far - text and thinking, whole, never cut - to the generation every FLUSH
seconds, which is also how it says it is alive; it reads there whether
someone pressed stop. When it is done it puts the answer in the
conversation and lets go of the lock in one write, then marks the
generation done (or stopped, or failed), counts the usage and names the
conversation if it is still unnamed.

The API follows the generation in the database (cc_chat.py `_tail`) and
hands every new piece to everyone watching (GET /chats/{id}/live) - the
one who asked included, whose POST is only one more watcher. So the page
may close, refresh or lose the API to a reload: the answer goes on, and
whoever opens the conversation gets it as far as it got and the rest as
it comes.

A runner that dies (the container restarted) leaves its generation
running and silent: one not heard from for LOST seconds, or whose process
is known to be gone, is "interrupted" - its answer so far is put in the
conversation, marked, and the lock let go (at the API's startup, and
whenever someone looks at it). The page offers to answer again.
"""

from __future__ import annotations

import asyncio
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime, timezone

from . import jobs
from .buildjobs import _dead_here, _pid_ns

GENS = "cc_gens"                    # the machine's, like build_jobs: each holds its workspace
ENV = "REDLINE_CC_GEN"
FLUSH = 0.25                        # the answer so far is written this often, s
BEAT = 2.0                          # and at least this often while nothing new came
LOST = 30.0                         # a runner not heard from for this long has died
KEEP_DAYS = 7                       # finished generations are dropped after this
ROOT = jobs.ROOT
LOGS = jobs.LOGS


def now() -> datetime:
    return datetime.now(timezone.utc)


def _iso() -> str:
    return now().isoformat()


def _aware(t) -> datetime | None:
    if isinstance(t, str):
        try:
            t = datetime.fromisoformat(t)
        except ValueError:
            return None
    if not isinstance(t, datetime):
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def coll(db):
    """The generations: the database itself, whether `db` is a workspace's
    view of it or not."""
    raw = getattr(db, "raw", None)                  # (a database has no truth value)
    return (db if raw is None else raw)[GENS]


def alive(gen: dict, at: datetime | None = None) -> bool:
    """A running generation is alive while its runner keeps writing."""
    if gen.get("status") != "running":
        return False
    beat = _aware(gen.get("beat") or gen.get("started_at"))
    return beat is not None and ((at or now()) - beat).total_seconds() < LOST


def gone(gen: dict) -> bool:
    """Its runner is known to be gone, without waiting for the beat to go
    stale: its process is not there in this namespace, or the container
    it ran in has restarted since (the same host, another namespace)."""
    if _dead_here(gen):
        return True
    ns = gen.get("ns")
    return bool(gen.get("pid") and ns and gen.get("host") == socket.gethostname() and ns != _pid_ns())


def dead(gen: dict) -> bool:
    return gen.get("status") == "running" and (gone(gen) or not alive(gen))


def _isoz(t) -> str | None:
    t = _aware(t)
    return t.isoformat() if t else None


def state(gen: dict) -> dict:
    """A generation as the live stream shows it: who, which model, the
    question and the answer so far - and when it started and when its
    first token came, so a page that joins late can tell its speed
    (`now` is the server's clock, for the page to line its own up with)."""
    return {"gen": gen["_id"], "client": gen.get("client"), "by": gen.get("by") or {},
            "provider": gen.get("provider"), "model": gen.get("model"), "message": gen.get("message"),
            "keep": gen.get("keep"), "text": gen.get("text") or "", "thinking": gen.get("thinking") or "",
            "steps": gen.get("steps") or [], "at": gen.get("at"), "started_at": _isoz(gen.get("started_at")), "first_at": _isoz(gen.get("first_at")),
            "now": _iso()}


CHARS_PER_TOKEN = 4                 # the estimate when the provider does not count


def timing(started, first, finished, out_tokens: int | None, chars: int) -> dict:
    """How the answer came: when it was asked for, when its first token
    (thinking or text) came and when it ended; the output tokens - the
    provider's count, or the characters / 4 marked `estimated` - and the
    average speed over the writing (first token to the end)."""
    started, first, finished = _aware(started), _aware(first), _aware(finished) or now()
    est = not out_tokens
    tokens = int(out_tokens) if out_tokens else -(-chars // CHARS_PER_TOKEN)
    out: dict = {"started_at": started.isoformat() if started else None, "first_at": first.isoformat() if first else None,
                 "finished_at": finished.isoformat(), "out_tokens": tokens, "estimated": est}
    if started:
        out["total_ms"] = max(0, round((finished - started).total_seconds() * 1000))
    if started and first:
        out["ttft_ms"] = max(0, round((first - started).total_seconds() * 1000))
    if first and tokens:
        writing = (finished - first).total_seconds()
        if writing >= 0.1:                          # all at once says nothing of speed
            out["tps"] = round(tokens / writing, 1)
    return out


# ---------------------------------------------------------------- the API's side

async def new(db, cid: str, *, keep: int, upto: int, question: str | None, message: dict | None,
              provider: str, model: str, client: str | None, images: bool, want_title: bool,
              actor: dict | None = None, role: str | None = None) -> dict:
    """Write a generation down, before the conversation's lock is taken.
    `actor` and `role`: a queued line's, sent later by whoever is running
    then (backend/cc_chat.py send_next) - by default, whoever is asking."""
    from . import access, actors, scope

    who = actor if actor is not None else (actors.current() or {})
    t = now()
    gen = {"_id": secrets.token_hex(8), "chat": cid, "workspace": scope.current(), "status": "running",
           "by": {"id": who.get("id"), "name": who.get("name")}, "actor": who,
           "role": role if role is not None else access.current(),
           "client": client, "provider": provider, "model": model, "message": message, "keep": keep,
           "upto": upto, "question": question, "images": images, "want_title": want_title,
           "text": "", "thinking": "", "at": _iso(), "started_at": t, "beat": t,
           "host": socket.gethostname(), "ns": _pid_ns()}
    await coll(db).insert_one(gen)
    return gen


async def drop(db, gen: dict) -> None:
    """A generation that never got its lock: never run."""
    await coll(db).update_one({"_id": gen["_id"], "status": "running"},
                              {"$set": {"status": "dropped", "finished_at": now()}})


def runner_argv(gid: str) -> list[str]:
    return [sys.executable, "-m", "backend.ccgen", gid]


def _popen(gid: str) -> int:
    """Its own session, so a reload's signal does not reach it."""
    LOGS.mkdir(parents=True, exist_ok=True)
    with open(LOGS / f"cc-{gid}.log", "ab") as log:
        proc = subprocess.Popen(runner_argv(gid), cwd=str(ROOT), stdin=subprocess.DEVNULL,
                                stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                env={**os.environ, ENV: gid})
    threading.Thread(target=proc.wait, daemon=True).start()
    return proc.pid


async def spawn(db, gid: str) -> int:
    """Start the runner. Its own function so a test can stand in."""
    return await asyncio.to_thread(_popen, gid)


async def launch(db, gen: dict) -> None:
    """Start the runner of a generation that holds its lock; one that
    cannot be started ends at once, as failed."""
    try:
        pid = await spawn(db, gen["_id"])
    except OSError as exc:
        await lose(db, gen, f"the answer could not be started: {exc}", status="failed")
        raise
    if pid:
        await coll(db).update_one({"_id": gen["_id"], "status": "running"}, {"$set": {"pid": pid}})


async def get(db, gid: str) -> dict | None:
    return await coll(db).find_one({"_id": gid})


async def finish(db, gen: dict, answer: dict, status: str, naming: bool = False) -> bool:
    """The answer into the conversation and the lock let go, in one write -
    only while this generation holds it, so it is put there once; then the
    generation marked. Says whether this call put it there."""
    from . import cc_chat

    res = await db[cc_chat.COLL].update_one(
        {"_id": gen["chat"], "gen": gen["_id"]},
        {"$push": {"messages": answer}, "$set": {"updated_at": _iso()}, "$unset": {"gen": ""}})
    put = bool(getattr(res, "matched_count", 1))
    await coll(db).update_one({"_id": gen["_id"], "status": "running"}, {"$set": {
        "status": status, "answer": answer, "text": answer.get("content") or "",
        "thinking": answer.get("thinking") or "", "steps": answer.get("steps") or [],
        "finished_at": now(), "naming": bool(naming and put)}})
    return put


def partial(gen: dict, **flags) -> dict:
    """The answer as far as the generation got, as a line of the conversation."""
    m = {"id": secrets.token_hex(5), "role": "assistant", "content": gen.get("text") or "", "at": gen.get("at") or _iso(),
         "provider": gen.get("provider"), "model": gen.get("model")}
    if gen.get("thinking"):
        m["thinking"] = gen["thinking"]
    if gen.get("thinking_ms"):
        m["thinking_ms"] = gen["thinking_ms"]
    if gen.get("steps"):
        m["steps"] = settle(gen["steps"], "interrupted")
    started = _aware(gen.get("started_at"))
    if started:
        m["ms"] = round((now() - started).total_seconds() * 1000)
    m["usage"] = {"prompt_tokens": None, "completion_tokens": None, "cost": None}
    m["timing"] = timing(gen.get("started_at"), gen.get("first_at"), now(), None,
                         len(gen.get("text") or "") + len(gen.get("thinking") or ""))
    m.update(flags)
    return m


async def _pause(db, gen: dict, status: str) -> None:
    from . import cc_chat
    try:
        await cc_chat.pause(db, gen["chat"], status)
    except Exception as exc:                                     # noqa: BLE001 - the answer comes first
        print(f"cc {gen['_id']}: queue not paused: {exc}", file=sys.stderr)


async def _send_next(db, gen: dict) -> None:
    """The answer ended well: the next line waiting in its conversation is
    sent - here, so it goes whether or not any page is open."""
    from . import cc_chat
    try:
        nxt = await cc_chat.send_next(db, gen["chat"])
        if nxt:
            print(f"cc {gen['_id']}: next in the queue: {nxt['_id']}", flush=True)
    except Exception as exc:                                     # noqa: BLE001 - said, not lost
        print(f"cc {gen['_id']}: the queue did not go on: {exc}", file=sys.stderr)


async def lose(db, gen: dict, why: str, status: str = "interrupted") -> dict:
    """A generation whose runner is gone: what it wrote is kept, marked, and
    the conversation let go. `db` sees the generation's workspace."""
    flags: dict = {"interrupted": True} if status == "interrupted" else {}
    if status == "stopped":
        flags = {"stopped": True}
    if not (gen.get("text") or "").strip():
        flags["error"] = why if status != "stopped" else "stopped before the answer began"
    answer = partial(gen, **flags)
    await _pause(db, gen, status)                              # what was queued waits to be let go
    await finish(db, gen, answer, status)
    await coll(db).update_one({"_id": gen["_id"]}, {"$set": {"detail": why}})
    return {**gen, "status": status, "answer": answer, "detail": why}


GONE = "the answer was interrupted (the server restarted)"


async def free(db, chat: dict) -> bool:
    """The conversation's lock, if its generation is no longer running (or
    its runner died): let go, the answer so far kept. True when the
    conversation is free now; False while an answer is being written."""
    from . import cc_chat

    gid = chat.get("gen")
    if not gid:
        return True
    gen = await get(db, gid)
    if gen and gen.get("status") == "running":
        if not dead(gen):
            return False
        await lose(db, gen, GONE)
        return True
    # Finished (or never there) but the lock stayed: let it go.
    await db[cc_chat.COLL].update_one({"_id": chat["_id"], "gen": gid}, {"$unset": {"gen": ""}})
    return True


async def answer_step(db, gen: dict, sid: str, allow: bool, who: dict) -> bool:
    """The person's yes or no to a step waiting for one (a delete-level
    tool): written on the generation, where the runner reads it."""
    if not any(s.get("id") == sid and s.get("status") == "ask" for s in gen.get("steps") or []):
        return False
    res = await coll(db).update_one({"_id": gen["_id"], "status": "running"},
                                    {"$set": {f"answers.{sid}": bool(allow), f"answered.{sid}": who}})
    return bool(getattr(res, "matched_count", 1))


async def request_stop(db, gen: dict, who: dict) -> dict:
    """Ask the runner to stop; a runner that is gone is stopped here."""
    await coll(db).update_one({"_id": gen["_id"], "status": "running"},
                              {"$set": {"stop": {"by": who, "at": now()}}})
    if dead(gen):
        return await lose(db, gen, "stopped", status="stopped")
    return gen


async def recover(raw) -> list[str]:
    """At startup: running generations whose runner is gone are
    interrupted now - their answer so far kept, their conversation let go.
    Long-finished ones are dropped."""
    from . import scope

    out = []
    async for gen in raw[GENS].find({"status": "running"}):
        if gone(gen) or not alive(gen):
            await lose(scope.ScopedDb(raw, gen.get("workspace") or scope.DEFAULT), gen, GONE)
            out.append(gen["_id"])
    try:
        from datetime import timedelta
        await raw[GENS].delete_many({"status": {"$ne": "running"},
                                     "finished_at": {"$lt": now() - timedelta(days=KEEP_DAYS)}})
    except Exception:                                            # noqa: BLE001 - only tidying
        pass
    return out


# ---------------------------------------------------------------- tools

MAX_ROUNDS = 10                     # tool rounds in one answer; then it answers with what it has
TOOL_TIMEOUT = 180.0                # seconds one tool may take (adding a part waits for LCSC)
ASK_WAIT = 600.0                    # seconds a delete-level tool waits for the person's yes
LIMIT_NOTE = "Not run: the limit of tool steps for one answer is reached - answer now with what you have."


def settle(steps: list[dict], why: str) -> list[dict]:
    """Steps still running (or waiting for a yes) when the answer ended: said so."""
    return [{**s, "status": why} if s.get("status") in ("running", "ask") else s for s in steps]


def _vars(args: dict) -> dict:
    """The tool's input as the page's sentence fills it: short strings."""
    return {k: (v if isinstance(v, (int, float)) and not isinstance(v, bool) else str(v)[:80])
            for k, v in (args or {}).items() if v is not None}


async def run_step(call: dict, tools: dict, ctx, out: dict) -> tuple[object, bool]:
    """One tool the model asked for, as a step of the answer (`out["steps"]`,
    written with the answer so far): run, or - a delete-level tool - asked
    for first. Returns what the model is handed back, and whether it is an
    error."""
    import base64
    import json

    from . import chat_tools

    tool = tools.get(call.get("name"))
    try:
        args = json.loads(call.get("arguments") or "{}")
        if not isinstance(args, dict):
            raise ValueError("not an object")
    except ValueError:
        args = {}
    step = {"id": secrets.token_hex(4), "tool": call.get("name") or "?", "level": tool.level if tool else "read",
            "status": "running", "pos": len(out["text"]), "args": args, "vars": _vars(args),
            "say": tool.running if tool else "Unknown tool {tool}", "at": _iso()}
    if not tool:
        step["vars"]["tool"] = step["tool"]
    out["steps"].append(step)
    out["rev"] += 1

    def end(**kw):
        step.update(kw)
        out["rev"] += 1

    if tool is None:
        end(status="error", error="no such tool")
        return f"Error: there is no tool {call.get('name')!r}.", True
    if out.get("limit"):
        end(status="error", error="step limit reached", say=tool.failed)
        return LIMIT_NOTE, True
    if tool.level == "delete":
        end(status="ask")
        until = time.monotonic() + ASK_WAIT
        while (out.get("answers") or {}).get(step["id"]) is None:
            if time.monotonic() > until:
                end(status="denied", error="nobody answered")
                return "Not run: nobody allowed it in time.", True
            await asyncio.sleep(FLUSH)
        allowed = (out["answers"] or {}).get(step["id"])
        if not allowed:
            end(status="denied")
            return "Not run: the person did not allow it.", True
        end(status="running")
    t0 = time.monotonic()
    try:
        res = await asyncio.wait_for(tool.run(ctx, args), TOOL_TIMEOUT)
    except asyncio.TimeoutError:
        end(status="error", error=f"took over {int(TOOL_TIMEOUT)} s", say=tool.failed,
            ms=round((time.monotonic() - t0) * 1000))
        return f"Error: {tool.name} took too long.", True
    except asyncio.CancelledError:
        raise
    except Exception as exc:                                     # noqa: BLE001 - the model is told, the page shows it
        why = str(exc)[:400] or type(exc).__name__
        if not isinstance(exc, chat_tools.ToolError):
            print(traceback.format_exc()[-1500:], file=sys.stderr)
        end(status="error", error=why, say=tool.failed, ms=round((time.monotonic() - t0) * 1000))
        return f"Error: {why}", True
    end(status="done", say=res.say, vars={**step["vars"], **_vars(res.vars)},
        summary=(res.summary or "")[:chat_tools.MAX_SUMMARY], ms=round((time.monotonic() - t0) * 1000))
    text = chat_tools.clip(res.text)
    # What later turns are shown it gave (backend/cc_chat.py history): the
    # start of it, and how long all of it was - the model had all of it.
    end(result=text[:chat_tools.RECALL], result_chars=len(text))
    if res.image and ctx.vision:
        return [{"type": "text", "text": text},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(res.image).decode()}}], False
    return text, False


# ---------------------------------------------------------------- the runner

async def run(gid: str, db=None) -> dict | None:
    """The runner's work, in whatever process runs it: the model streamed,
    the answer so far written as it comes, the end put in the conversation."""
    from . import cc_chat, cc_context, llm

    db = db if db is not None else cc_chat._db()
    gens = coll(db)
    gen = await gens.find_one({"_id": gid})
    if not gen or gen.get("status") != "running":
        return None
    t0 = time.monotonic()
    out = {"text": "", "thinking": "", "thought": 0.0, "used": {}, "first_at": None,
           "steps": [], "rev": 0, "answers": {}}
    chat = await db[cc_chat.COLL].find_one({"_id": gen["chat"]})
    msgs = (chat or {}).get("messages") or []
    upto = gen.get("upto") or 0
    if gen.get("question"):
        i = cc_chat.find(msgs, gen["question"])
        upto = i + 1 if i >= 0 else upto
    convo = msgs[:upto]
    if not chat or not convo or convo[-1].get("role") != "user":
        answer = partial(gen, error="the question was not found in the conversation")
        await finish(db, gen, answer, "failed")
        return {**gen, "status": "failed"}

    async def produce():
        from . import chat_tools

        images = None
        pics = convo[-1].get("attach") or []
        if gen.get("images") and pics:
            images = await cc_context.images(db, pics)
        uid = (gen.get("actor") or {}).get("id") or (gen.get("by") or {}).get("id")
        try:
            tools = {t.name: t for t in await chat_tools.enabled(db, uid)}
        except Exception as exc:                                 # noqa: BLE001 - an answer without tools
            print(f"cc {gid}: tools not read: {exc}", file=sys.stderr)
            tools = {}
        # Earlier answers' steps go back to the model with them: as tool
        # calls and results while it has tools, as a written list otherwise.
        base = cc_chat.history(convo, images)
        ctx = None
        if tools:
            ctx = chat_tools.Ctx(db=db, vision=await cc_chat._vision(gen["provider"], gen["model"]),
                                 actor=gen.get("actor") or {})
            withcalls = cc_chat.history(convo, images, tools=set(tools))
            msgs = [{**withcalls[0], "content": withcalls[0]["content"] + "\n\n" + chat_tools.note(list(tools.values()))},
                    *withcalls[1:]]
        else:
            msgs = base
        rounds = 0
        while True:
            calls: list[dict] = []
            said = ""
            kw = {"tools": [t.spec() for t in tools.values()]} if tools else {}
            try:
                async for piece in llm.stream(msgs, provider=gen["provider"], model=gen["model"],
                                              max_tokens=cc_chat.MAX_ANSWER, **kw):
                    if out["first_at"] is None and (piece.get("thinking") or piece.get("text")):
                        out["first_at"] = now()          # the first token, of either kind
                    if "thinking" in piece:
                        out["thought"] = time.monotonic() - t0
                        out["thinking"] += piece["thinking"] or ""
                    elif "text" in piece:
                        said += piece["text"] or ""
                        out["text"] += piece["text"] or ""
                    elif "calls" in piece:
                        calls = piece["calls"] or []
                    elif "usage" in piece:
                        for k, v in (piece["usage"] or {}).items():
                            if isinstance(v, (int, float)):
                                out["used"][k] = (out["used"].get(k) or 0) + v
                            elif k not in out["used"]:
                                out["used"][k] = v
            except Exception as exc:                             # noqa: BLE001 - see below
                if tools and rounds == 0 and not said and not out["thinking"]:
                    # The model (or its provider) does not take tools: it
                    # answers without them rather than not at all.
                    print(f"cc {gid}: no tools for {gen['model']}: {str(exc)[:200]}", file=sys.stderr)
                    out["no_tools"] = str(exc)[:200] or type(exc).__name__
                    tools, msgs = {}, base
                    continue
                raise
            if not calls or not tools:
                break
            rounds += 1
            out["limit"] = rounds > MAX_ROUNDS
            if out["text"] and not out["text"].endswith("\n\n"):
                out["text"] += "\n\n" if not out["text"].endswith("\n") else "\n"
            msgs = [*msgs, {"role": "assistant", "content": said, "tool_calls": [
                {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}}
                for c in calls]}]
            for c in calls:
                content, failed = await run_step(c, tools, ctx, out)
                msgs.append({"role": "tool", "tool_call_id": c["id"], "content": content,
                             **({"is_error": True} if failed else {})})
            if rounds > MAX_ROUNDS + 1:
                break

    task = asyncio.create_task(produce())
    stopped = False
    written = (0, 0, 0)
    beat = time.monotonic()
    while not task.done():
        await asyncio.wait({task}, timeout=FLUSH)
        size = (len(out["text"]), len(out["thinking"]), out["rev"])
        if size != written or time.monotonic() - beat >= BEAT:
            patch = {"text": out["text"], "thinking": out["thinking"], "beat": now()}
            if out["steps"]:
                patch["steps"] = out["steps"]
            if out["thought"]:
                patch["thinking_ms"] = round(out["thought"] * 1000)
            if out["first_at"]:
                patch["first_at"] = out["first_at"]
            try:
                await gens.update_one({"_id": gid, "status": "running"}, {"$set": patch})
                written, beat = size, time.monotonic()
            except Exception:                                    # noqa: BLE001 - the next flush
                pass
        if task.done():
            break
        try:
            cur = await gens.find_one({"_id": gid})
        except Exception:                                        # noqa: BLE001
            continue
        if cur is not None:
            out["answers"] = cur.get("answers") or {}       # a delete-level tool's yes or no
        if cur is None or cur.get("stop") or cur.get("status") != "running":
            stopped = True
            task.cancel()
            break
    error = None
    try:
        await task
    except asyncio.CancelledError:
        stopped = True
    except Exception as exc:                                     # noqa: BLE001 - said, not lost
        error = str(exc)[:500] or type(exc).__name__
        print(traceback.format_exc()[-2000:], file=sys.stderr)

    answer = {"id": secrets.token_hex(5), "role": "assistant", "content": out["text"], "at": gen.get("at") or _iso(),
              "provider": gen["provider"], "model": gen["model"]}
    if out["thinking"]:
        answer["thinking"] = out["thinking"]              # whole: the page shows all of it
    if out["steps"]:
        answer["steps"] = settle(out["steps"], "stopped" if stopped else "interrupted")
    if out.get("no_tools"):
        answer["no_tools"] = out["no_tools"]
    if stopped:
        answer["stopped"] = True
        if not out["text"]:
            answer["error"] = "stopped before the answer began"
    if error:
        answer["error"] = error
    answer["ms"] = round((time.monotonic() - t0) * 1000)
    if out["thought"]:
        answer["thinking_ms"] = round(out["thought"] * 1000)
    used = out["used"]
    answer["usage"] = {k: used.get(k) for k in ("prompt_tokens", "completion_tokens", "cost")}
    answer["timing"] = timing(gen.get("started_at") or out["first_at"], out["first_at"], now(),
                              used.get("completion_tokens"), len(out["text"]) + len(out["thinking"]))
    status = "failed" if error else "stopped" if stopped else "done"
    want_title = bool(gen.get("want_title"))
    if status != "done":
        await _pause(db, gen, status)                          # before the lock goes: nothing is sent meanwhile
    put = await finish(db, gen, answer, status, naming=want_title)
    if put and status == "done":
        await _send_next(db, gen)
    if used:
        await llm.record(db, provider=gen["provider"], model=gen["model"], surface="chat", kind="cc-chat", used=used)
    if put and want_title:
        title = None
        try:
            title = await cc_chat._name(db, gen["chat"], convo, answer)
        except Exception as exc:                                 # noqa: BLE001 - unnamed, not lost
            print(f"cc {gid}: not named: {exc}", file=sys.stderr)
        await gens.update_one({"_id": gid}, {"$set": {"naming": False, "title": title}})
    return {**gen, "status": status, "answer": answer}


async def _main(gid: str) -> int:
    from . import access, actors, llm, main, scope

    raw = main.db().raw
    gen = await raw[GENS].find_one({"_id": gid})
    if not gen or gen.get("status") != "running":
        print(f"cc {gid}: not waiting to run", file=sys.stderr)
        return 1
    scope.WORKSPACE.set(gen.get("workspace") or scope.DEFAULT)
    actors.CURRENT.set(gen.get("actor"))
    access.ROLE.set(gen.get("role"))
    try:
        await llm.load(main.db())                                # the keys, and the summary model
    except Exception as exc:                                     # noqa: BLE001 - .env keys still work
        print(f"cc {gid}: settings not read: {exc}", file=sys.stderr)
    print(f"cc {gid}: {gen['model']} (pid {os.getpid()})", flush=True)
    done = await run(gid, main.db())
    print(f"cc {gid}: {(done or {}).get('status')}", flush=True)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("python -m backend.ccgen <generation id>")
    sys.exit(asyncio.run(_main(sys.argv[1])))
