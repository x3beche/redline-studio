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


def state(gen: dict) -> dict:
    """A generation as the live stream shows it: who, which model, the
    question and the answer so far."""
    return {"gen": gen["_id"], "client": gen.get("client"), "by": gen.get("by") or {},
            "provider": gen.get("provider"), "model": gen.get("model"), "message": gen.get("message"),
            "keep": gen.get("keep"), "text": gen.get("text") or "", "thinking": gen.get("thinking") or "",
            "at": gen.get("at")}


# ---------------------------------------------------------------- the API's side

async def new(db, cid: str, *, keep: int, upto: int, question: str | None, message: dict | None,
              provider: str, model: str, client: str | None, images: bool, want_title: bool) -> dict:
    """Write a generation down, before the conversation's lock is taken."""
    from . import access, actors, scope

    who = actors.current() or {}
    t = now()
    gen = {"_id": secrets.token_hex(8), "chat": cid, "workspace": scope.current(), "status": "running",
           "by": {"id": who.get("id"), "name": who.get("name")}, "actor": who, "role": access.current(),
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
        "thinking": answer.get("thinking") or "", "finished_at": now(), "naming": bool(naming and put)}})
    return put


def partial(gen: dict, **flags) -> dict:
    """The answer as far as the generation got, as a line of the conversation."""
    m = {"id": secrets.token_hex(5), "role": "assistant", "content": gen.get("text") or "", "at": gen.get("at") or _iso(),
         "provider": gen.get("provider"), "model": gen.get("model")}
    if gen.get("thinking"):
        m["thinking"] = gen["thinking"]
    if gen.get("thinking_ms"):
        m["thinking_ms"] = gen["thinking_ms"]
    started = _aware(gen.get("started_at"))
    if started:
        m["ms"] = round((now() - started).total_seconds() * 1000)
    m["usage"] = {"prompt_tokens": None, "completion_tokens": None, "cost": None}
    m.update(flags)
    return m


async def lose(db, gen: dict, why: str, status: str = "interrupted") -> dict:
    """A generation whose runner is gone: what it wrote is kept, marked, and
    the conversation let go. `db` sees the generation's workspace."""
    flags: dict = {"interrupted": True} if status == "interrupted" else {}
    if status == "stopped":
        flags = {"stopped": True}
    if not (gen.get("text") or "").strip():
        flags["error"] = why if status != "stopped" else "stopped before the answer began"
    answer = partial(gen, **flags)
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
    out = {"text": "", "thinking": "", "thought": 0.0, "used": {}}
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
        images = None
        pics = convo[-1].get("attach") or []
        if gen.get("images") and pics:
            images = await cc_context.images(db, pics)
        async for piece in llm.stream(cc_chat.history(convo, images), provider=gen["provider"],
                                      model=gen["model"], max_tokens=cc_chat.MAX_ANSWER):
            if "thinking" in piece:
                out["thought"] = time.monotonic() - t0
                out["thinking"] += piece["thinking"] or ""
            elif "text" in piece:
                out["text"] += piece["text"] or ""
            elif "usage" in piece:
                out["used"] = piece["usage"] or {}

    task = asyncio.create_task(produce())
    stopped = False
    written = (0, 0)
    beat = time.monotonic()
    while not task.done():
        await asyncio.wait({task}, timeout=FLUSH)
        size = (len(out["text"]), len(out["thinking"]))
        if size != written or time.monotonic() - beat >= BEAT:
            patch = {"text": out["text"], "thinking": out["thinking"], "beat": now()}
            if out["thought"]:
                patch["thinking_ms"] = round(out["thought"] * 1000)
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
    status = "failed" if error else "stopped" if stopped else "done"
    want_title = bool(gen.get("want_title"))
    put = await finish(db, gen, answer, status, naming=want_title)
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
