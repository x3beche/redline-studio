"""Tools the Chat's models use while they answer (backend/chat_tools,
backend/ccgen.py's tool loop, backend/llm.py's two shapes of it).

What matters: the model asks for a tool, the server runs it and hands the
result back, and the model goes on - in a bounded number of rounds; each
tool is a step kept on the answer (so it shows after a reload and to
everyone watching); a model that cannot take tools answers without them;
a delete-level tool waits for a yes; each person's on/off choice decides
what goes to the model. The tools themselves read the drawer, LCSC and
the kept datasheet - LCSC and the model are never reached.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from backend import cc_chat, ccgen, chat_tools, lcsc, llm
from backend.chat_tools import Ctx, Result, Tool, ToolError
from tests.test_cc_generation import answers, gen_doc, until
from tests.test_cc_mentions_live_search import env, events, seed_chat  # noqa: F401 - env is a fixture
from tests.test_pdftext import make_pdf


def run(coro):
    return asyncio.run(coro)


DATASHEET = make_pdf([["IRL540N HEXFET Power MOSFET", "VDSS = 100V"],
                      ["Electrical Characteristics", "RDS(on) Static Drain-to-Source On-Resistance 0.044 Ohm"],
                      ["Package Outline TO-220AB"]])


def keep_datasheet(code="C29780637", blob=DATASHEET):
    folder = lcsc.LOOK / code
    folder.mkdir(parents=True, exist_ok=True)
    (folder / lcsc.DATASHEET).write_bytes(blob)
    (folder / lcsc.DATASHEET_FROM).write_text(json.dumps({"url": "https://datasheet.lcsc.com/x.pdf", "mpn": "IRL540N"}))


def tool_model(monkeypatch, state, rounds):
    """A model that, round by round, writes a text and asks for tools
    (OpenAI's shape of a call); the last round answers. What it was sent
    each round is kept."""
    state["rounds"] = []

    async def stream(messages, *, provider, model, max_tokens=8000, temperature=None, tools=None):
        i = len(state["rounds"])
        state["rounds"].append({"messages": messages, "tools": tools})
        text, calls = rounds[min(i, len(rounds) - 1)]
        if text:
            yield {"text": text}
        if calls and tools:
            yield {"calls": [{"id": f"call{i}_{j}", "name": n, "arguments": json.dumps(a)}
                             for j, (n, a) in enumerate(calls)]}
        yield {"usage": {"prompt_tokens": 10, "completion_tokens": 2, "cost": None}}

    monkeypatch.setattr(llm, "stream", stream)


def test_the_model_asks_the_server_runs_and_the_model_goes_on(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    keep_datasheet()
    tool_model(monkeypatch, state, [
        ("Let me check the datasheet.", [("datasheet_get", {"lcsc": "C29780637"})]),
        ("", [("datasheet_read", {"lcsc": "C29780637", "query": "RDS(on)"})]),
        ("RDS(on) is 0.044 Ω (datasheet p. 2).", []),
    ])
    evs = events(cc_chat.say("c1", cc_chat.SayIn(text="IRL540N RDS(on)?", client="tab1")))
    (last,) = answers(raw)
    assert last["content"] == "Let me check the datasheet.\n\nRDS(on) is 0.044 Ω (datasheet p. 2)."
    steps = last["steps"]
    assert [s["tool"] for s in steps] == ["datasheet_get", "datasheet_read"]
    assert all(s["status"] == "done" for s in steps)
    assert steps[0]["say"] == "Datasheet: from the drawer · {pages} pages" and steps[0]["vars"]["pages"] == 3
    assert steps[1]["say"] == "Searched the datasheet for “{query}” · pages {pages}" and steps[1]["vars"]["pages"] == "2"
    # Where each step goes in the answer: after the first round's words.
    assert steps[0]["pos"] == steps[1]["pos"] == len("Let me check the datasheet.\n\n")
    # The tools went out, with the note; each round got the last one's results.
    r = state["rounds"]
    assert {t["name"] for t in r[0]["tools"]} == set(chat_tools.tools())
    assert "drawer_search" in r[0]["messages"][0]["content"] and "Cite the" in r[0]["messages"][0]["content"]
    assert r[1]["messages"][-2]["tool_calls"][0]["function"]["name"] == "datasheet_get"
    assert r[1]["messages"][-1]["role"] == "tool" and "3 pages" in r[1]["messages"][-1]["content"]
    assert "0.044" in r[2]["messages"][-1]["content"] and "page 2 of 3" in r[2]["messages"][-1]["content"]
    # Usage of every round counted together.
    assert last["usage"]["prompt_tokens"] == 30 and last["usage"]["completion_tokens"] == 6
    # The steps went out live as well.
    assert any(e["type"] == "steps" for e in evs)
    assert gen_doc(raw)["steps"][-1]["status"] == "done"


def test_a_failing_tool_is_said_to_the_model_and_shown_as_an_error(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    tool_model(monkeypatch, state, [("", [("datasheet_read", {"lcsc": "nope"})]), ("Sorry.", [])])
    events(cc_chat.say("c1", cc_chat.SayIn(text="?", client="tab1")))
    (step,) = answers(raw)[-1]["steps"]
    assert step["status"] == "error" and "not an LCSC part number" in step["error"]
    assert step["say"] == "Could not read the datasheet of {lcsc}"
    assert state["rounds"][1]["messages"][-1]["content"].startswith("Error:")
    assert state["rounds"][1]["messages"][-1]["is_error"] is True


def test_the_rounds_are_bounded(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    monkeypatch.setattr(ccgen, "MAX_ROUNDS", 2)
    tool_model(monkeypatch, state, [("", [("drawer_search", {"query": "x"})])])     # asks for ever
    monkeypatch.setattr(lcsc, "known", lambda db: _rows([]))
    events(cc_chat.say("c1", cc_chat.SayIn(text="?", client="tab1")))
    last = answers(raw)[-1]
    assert len(state["rounds"]) == 4                          # 2 rounds, one refused, then it stops
    assert last["steps"][-1]["status"] == "error" and last["steps"][-1]["error"] == "step limit reached"


async def _rows(rows):
    return rows


def test_a_model_that_takes_no_tools_answers_without_them(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    sent = []

    async def stream(messages, *, provider, model, max_tokens=8000, temperature=None, tools=None):
        sent.append(tools)
        if tools:
            raise RuntimeError("OpenRouter answered HTTP 404: No endpoints found that support tool use")
        yield {"text": "From memory."}
        yield {"usage": {}}

    monkeypatch.setattr(llm, "stream", stream)
    events(cc_chat.say("c1", cc_chat.SayIn(text="?", client="tab1")))
    last = answers(raw)[-1]
    assert last["content"] == "From memory." and not last.get("error") and "tool use" in last["no_tools"]
    assert sent[0] and sent[1] is None


def test_each_person_chooses_their_tools(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    saved: dict = {}

    class Prefs:
        async def find_one(self, q, *a):
            return {"_id": q["_id"], "tools": dict(saved.get(q["_id"]) or {})}

        async def update_one(self, q, upd, upsert=False):
            for k, v in upd["$set"].items():
                saved.setdefault(q["_id"], {})[k.split(".", 1)[1]] = v

    real = raw.__class__.__getitem__
    monkeypatch.setattr(raw.__class__, "__getitem__",
                        lambda self, n: Prefs() if n == chat_tools.PREFS else real(self, n))
    got = run(cc_chat.set_tools(cc_chat.ToolsIn(tools={"drawer_add": False, "datasheet_get": False})))
    on = {t["name"]: t["on"] for t in got["tools"]}
    assert on == {"drawer_search": True, "drawer_list": True, "lcsc_search": True, "drawer_add": False,
                  "datasheet_get": False, "datasheet_read": True}
    assert run(cc_chat.list_tools())["tools"] == got["tools"]
    with pytest.raises(Exception):
        run(cc_chat.set_tools(cc_chat.ToolsIn(tools={"rm_rf": True})))
    tool_model(monkeypatch, state, [("Hi.", [])])
    events(cc_chat.say("c1", cc_chat.SayIn(text="?", client="tab1")))
    assert {t["name"] for t in state["rounds"][0]["tools"]} == {"drawer_search", "drawer_list", "lcsc_search",
                                                                "datasheet_read"}
    # Nothing on: no tools, and no note about them.
    run(cc_chat.set_tools(cc_chat.ToolsIn(tools={n: False for n in chat_tools.tools()})))
    events(cc_chat.say("c1", cc_chat.SayIn(text="again", client="tab1")))
    assert state["rounds"][-1]["tools"] is None and "drawer_search" not in state["rounds"][-1]["messages"][0]["content"]


def test_a_delete_level_tool_waits_for_a_yes(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    ran = []

    async def drop(ctx, args):
        ran.append(args)
        return Result(text="dropped", say="Dropped {what}", vars={"what": args.get("what")})

    reg = {**chat_tools.tools(), "drop_it": Tool(name="drop_it", description="d", schema={"type": "object"},
                                                 level="delete", run=drop, running="Dropping {what}",
                                                 failed="Could not drop {what}")}
    monkeypatch.setattr(chat_tools, "_TOOLS", reg)
    tool_model(monkeypatch, state, [("", [("drop_it", {"what": "C1"})]), ("Done.", [])])

    async def go():
        resp = await cc_chat.say("c1", cc_chat.SayIn(text="?", client="tab1"))
        step = await until(lambda: next((s for s in (gen_doc(raw) or {}).get("steps") or []
                                         if s["status"] == "ask"), None))
        assert not ran
        gen = gen_doc(raw)
        with pytest.raises(Exception):                     # only a step that is asking
            await cc_chat.answer_step("c1", "nope", cc_chat.StepIn(allow=True))
        # (the stand-in database keeps dotted keys flat: the runner's read is set here)
        await cc_chat.answer_step("c1", step["id"], cc_chat.StepIn(allow=True))
        raw[ccgen.GENS].rows[gen["_id"]]["answers"] = {step["id"]: True}
        await until(lambda: answers(raw))
        async for _ in resp.body_iterator:
            pass
    run(go())
    (step,) = answers(raw)[-1]["steps"]
    assert ran == [{"what": "C1"}] and step["status"] == "done" and step["say"] == "Dropped {what}"


def test_a_stop_while_a_tool_runs_keeps_the_step_as_stopped(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    async def slow(ctx, args):
        await asyncio.sleep(30)
        return Result(text="", say="")

    reg = {"slow": Tool(name="slow", description="s", schema={"type": "object"}, level="read", run=slow,
                        running="Slow", failed="Slow failed")}
    monkeypatch.setattr(chat_tools, "_TOOLS", reg)
    tool_model(monkeypatch, state, [("Looking.", [("slow", {})]), ("never", [])])

    async def go():
        resp = await cc_chat.say("c1", cc_chat.SayIn(text="?", client="tab1"))
        await until(lambda: (gen_doc(raw) or {}).get("steps"))
        await cc_chat.stop("c1")
        await until(lambda: answers(raw))
        async for _ in resp.body_iterator:
            pass
    run(go())
    last = answers(raw)[-1]
    assert last["stopped"] and last["steps"][0]["status"] == "stopped" and last["content"].startswith("Looking.")


# ---- the tools themselves ----------------------------------------------------

class Parts:
    def __init__(self, rows):
        self.rows = {r["_id"]: r for r in rows}

    async def find_one(self, q, projection=None):
        return self.rows.get(q.get("_id"))


class Db(dict):
    def __getitem__(self, n):
        return self.setdefault(n, Parts([]))


def test_drawer_search_finds_by_mpn_and_says_whether_a_datasheet_is_kept(monkeypatch):
    keep_datasheet()
    rows = [{"lcsc": "C29780637", "name": "TO-220", "mpn": "IRL540N", "maker": "Infineon", "group": "Discretes",
             "branch": "MOSFETs"},
            {"lcsc": "C111607", "name": "LQFP-48", "mpn": "STM32F103C8T6", "maker": "ST", "group": "ICs",
             "branch": "MCUs"}]
    monkeypatch.setattr(lcsc, "known", lambda db: _rows(rows))
    tool = chat_tools.tools()["drawer_search"]
    got = run(tool.run(Ctx(db=Db()), {"query": "irl540n"}))
    assert got.say == "Found {mpn} in the drawer ({lcsc})" and got.vars == {"mpn": "IRL540N", "lcsc": "C29780637",
                                                                           "query": "irl540n"}
    assert "datasheet kept" in got.text
    none = run(tool.run(Ctx(db=Db()), {"query": "ne555"}))
    assert none.say == "Nothing in the drawer for “{query}”" and "lcsc_search" in none.text


def test_lcsc_search_lists_candidates_and_marks_what_is_in_the_drawer(monkeypatch):
    async def search(term, limit=20):
        return [{"lcsc": "C29780637", "mpn": "IRL540NPBF", "maker": "Infineon", "package": "TO-220", "stock": 120,
                 "price": 0.61},
                {"lcsc": "C2900", "mpn": "IRL540N", "maker": "UMW", "package": "TO-220", "stock": None, "price": None}]
    monkeypatch.setattr(lcsc, "search", search)
    db = Db({lcsc.PARTS: Parts([{"_id": "C29780637", "name": "x"}])})
    got = run(chat_tools.tools()["lcsc_search"].run(Ctx(db=db), {"query": "IRL540N"}))
    assert got.vars["n"] == 2 and "(in the drawer)" in got.text.splitlines()[1]
    assert "(in the drawer)" not in got.text.splitlines()[2]


def test_lcsc_refusing_is_a_tool_error(monkeypatch):
    async def search(term, limit=20):
        raise lcsc.Refused("cooling off for 9 minutes")
    monkeypatch.setattr(lcsc, "search", search)
    with pytest.raises(ToolError, match="not being asked right now"):
        run(chat_tools.tools()["lcsc_search"].run(Ctx(db=Db()), {"query": "x"}))


def test_drawer_add_takes_the_pages_path_and_leaves_a_kept_part_alone(monkeypatch):
    calls = []

    async def component(c, fresh=False):
        calls.append(("component", c))

    async def fetch(db, c, force=False):
        calls.append(("fetch", c))
        return {"_id": c, "name": "TO-220-3", "artifacts": {"model": "x"}}

    async def categorise(db, c):
        calls.append(("categorise", c))

    monkeypatch.setattr(lcsc, "_component", component)
    monkeypatch.setattr(lcsc, "fetch", fetch)
    monkeypatch.setattr(lcsc, "categorise", categorise)
    tool = chat_tools.tools()["drawer_add"]
    assert tool.level == "change"
    got = run(tool.run(Ctx(db=Db()), {"lcsc": "c29780637"}))
    assert calls == [("component", "C29780637"), ("fetch", "C29780637"), ("categorise", "C29780637")]
    assert got.say == "Added {lcsc} to the drawer" and "3D model" in got.text
    calls.clear()
    kept = run(tool.run(Ctx(db=Db({lcsc.PARTS: Parts([{"_id": "C29780637", "name": "TO-220-3"}])})),
                        {"lcsc": "C29780637"}))
    assert not calls and kept.say == "{lcsc} is already in the drawer"


def test_datasheet_get_says_kept_or_fetched(monkeypatch):
    keep_datasheet()
    tool = chat_tools.tools()["datasheet_get"]
    got = run(tool.run(Ctx(db=Db()), {"lcsc": "C29780637"}))
    assert got.say == "Datasheet: from the drawer · {pages} pages" and got.vars["pages"] == 3

    async def fetched(c, fresh=False):
        return {"pdf": DATASHEET, "url": "u", "mpn": "IRL540N", "cached": False}
    monkeypatch.setattr(lcsc, "datasheet", fetched)
    got = run(tool.run(Ctx(db=Db()), {"lcsc": "C29780637"}))
    assert got.say == "Fetched datasheet from LCSC · {size}" and got.vars["size"].endswith("KB")


def test_datasheet_read_by_page_by_query_and_as_a_picture():
    keep_datasheet()
    tool = chat_tools.tools()["datasheet_read"]
    got = run(tool.run(Ctx(db=Db()), {"lcsc": "C29780637"}))
    assert got.vars["pages"] == "1–3" and got.say == "Read datasheet pages {pages}"
    one = run(tool.run(Ctx(db=Db()), {"lcsc": "C29780637", "pages": "2"}))
    assert one.say == "Read datasheet page {pages}" and "0.044" in one.text and "page 1 of" not in one.text
    q = run(tool.run(Ctx(db=Db()), {"lcsc": "C29780637", "query": "RDS(on)"}))
    assert q.vars["pages"] == "2"
    miss = run(tool.run(Ctx(db=Db()), {"lcsc": "C29780637", "query": "gate charge"}))
    assert "not found" in miss.say
    with pytest.raises(ToolError, match="does not read images"):
        run(tool.run(Ctx(db=Db()), {"lcsc": "C29780637", "image_page": 1}))
    pic = run(tool.run(Ctx(db=Db(), vision=True), {"lcsc": "C29780637", "image_page": 1}))
    assert pic.image[:4] == b"\x89PNG"


def test_the_text_is_capped(monkeypatch):
    monkeypatch.setattr(chat_tools, "MAX_TEXT", 100)
    assert len(chat_tools.clip("x" * 500, 100)) < 160


# ---- the two shapes of a tool loop (backend/llm.py) ---------------------------

LOOP = [{"role": "system", "content": "sys"},
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "Checking.", "tool_calls": [
            {"id": "t1", "type": "function", "function": {"name": "drawer_search", "arguments": '{"query": "x"}'}},
            {"id": "t2", "type": "function", "function": {"name": "datasheet_read", "arguments": '{"lcsc": "C1"}'}}]},
        {"role": "tool", "tool_call_id": "t1", "content": "found"},
        {"role": "tool", "tool_call_id": "t2", "is_error": True,
         "content": [{"type": "text", "text": "page"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}}]}]
SPEC = [{"name": "drawer_search", "description": "d", "parameters": {"type": "object", "properties": {}}}]


def test_the_anthropic_shape_of_a_tool_loop():
    body = llm._to_anthropic(LOOP, 100, None, "claude-haiku-5-5", stream=True, tools=SPEC)
    assert body["tools"] == [{"name": "drawer_search", "description": "d", "input_schema": SPEC[0]["parameters"]}]
    a, u = body["messages"][1], body["messages"][2]
    assert a["content"][0] == {"type": "text", "text": "Checking."}
    assert a["content"][1] == {"type": "tool_use", "id": "t1", "name": "drawer_search", "input": {"query": "x"}}
    assert u["role"] == "user" and [b["tool_use_id"] for b in u["content"]] == ["t1", "t2"]
    assert u["content"][1]["is_error"] and u["content"][1]["content"][1]["type"] == "image"
    assert len(body["messages"]) == 3


def test_the_openai_shape_of_a_tool_loop():
    body = llm._openai_body("openrouter", "m", LOOP, 100, None, True, stream=True, tools=SPEC)
    assert body["tools"] == [{"type": "function", "function": SPEC[0]}]
    msgs = body["messages"]
    assert msgs[2]["tool_calls"][0]["id"] == "t1"
    assert msgs[3] == {"role": "tool", "tool_call_id": "t1", "content": "found"}
    assert msgs[4] == {"role": "tool", "tool_call_id": "t2", "content": "page"}
    assert msgs[5]["role"] == "user" and msgs[5]["content"][1]["type"] == "image_url"


def _sse_client(monkeypatch, lines):
    class Resp:
        status_code = 200
        async def aiter_lines(self):
            for ln in lines:
                yield ln
        async def aread(self):
            return b""

    class Ctx:
        async def __aenter__(self):
            return Resp()
        async def __aexit__(self, *a):
            return False

    class Client:
        def __init__(self, *a, **k):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        def stream(self, method, url, json=None, headers=None):
            Client.sent = json
            return Ctx()

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", Client)
    monkeypatch.setattr(llm, "key", lambda p: "k")
    return Client


def _collect(gen):
    async def go():
        return [p async for p in gen]
    return run(go())


def test_an_anthropic_stream_hands_back_the_tool_calls(monkeypatch):
    ev = lambda d: "data: " + json.dumps(d)  # noqa: E731
    c = _sse_client(monkeypatch, [
        ev({"type": "message_start", "message": {"usage": {"input_tokens": 9}}}),
        ev({"type": "content_block_start", "index": 0, "content_block": {"type": "text"}}),
        ev({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Let me look."}}),
        ev({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "tu1", "name": "drawer_search"}}),
        ev({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"query": '}}),
        ev({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '"IRL540N"}'}}),
        ev({"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 4}}),
    ])

    async def anth(p, m):
        return True
    monkeypatch.setattr(llm, "_anthropic_model", anth)
    got = _collect(llm.stream([{"role": "user", "content": "q"}], provider="commandcode", model="claude-haiku-5-5",
                              tools=SPEC))
    assert got[0] == {"text": "Let me look."}
    assert got[1] == {"calls": [{"id": "tu1", "name": "drawer_search", "arguments": '{"query": "IRL540N"}'}]}
    assert got[2] == {"usage": {"prompt_tokens": 9, "completion_tokens": 4}}
    assert c.sent["tools"][0]["name"] == "drawer_search"


def test_an_openai_stream_hands_back_the_tool_calls(monkeypatch):
    ev = lambda d: "data: " + json.dumps(d)  # noqa: E731
    _sse_client(monkeypatch, [
        ev({"choices": [{"delta": {"content": "Hm."}}]}),
        ev({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "lcsc_search", "arguments": ""}}]}}]}),
        ev({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '{"query":'}}]}}]}),
        ev({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '"x"}'}}]}}]}),
        ev({"choices": [{"delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 3, "completion_tokens": 1, "cost": 0.1}}),
        "data: [DONE]",
    ])

    async def anth(p, m):
        return False
    monkeypatch.setattr(llm, "_anthropic_model", anth)
    got = _collect(llm.stream([{"role": "user", "content": "q"}], provider="openrouter", model="m", tools=SPEC))
    assert got == [{"text": "Hm."}, {"calls": [{"id": "c1", "name": "lcsc_search", "arguments": '{"query":"x"}'}]},
                   {"usage": {"prompt_tokens": 3, "completion_tokens": 1, "cost": 0.1}}]


def test_every_tool_is_registered_with_what_the_page_needs():
    for name, t in chat_tools.tools().items():
        assert t.level in chat_tools.LEVELS and t.running and t.failed and t.description
        assert t.schema["type"] == "object"
        assert name == t.name


# ---- earlier answers' steps go back to the model ---------------------------------

def _asked(text="do u have the datasheet of C29780637?"):
    return {"id": "q1", "role": "user", "content": text, "by": {"id": "u1", "name": "Ann"}, "at": "t"}


def _answered():
    """An answer that ran three tools in two rounds, as ccgen keeps it."""
    text = "Let me look.\n\nYes: IRL540N(UMW), TO-220-3, datasheet kept (p. 1)."
    pos = len("Let me look.\n\n")
    return {"id": "a1", "role": "assistant", "content": text, "at": "t", "steps": [
        {"id": "s1", "tool": "drawer_search", "pos": 0, "status": "done", "args": {"query": "C29780637"},
         "summary": "C29780637 IRL540N(UMW)", "result": "In the drawer, matching 'C29780637':\nC29780637  IRL540N(UMW)  UMW  TO-220-3"},
        {"id": "s2", "tool": "datasheet_get", "pos": pos, "status": "done", "args": {"lcsc": "C29780637"},
         "summary": "IRL540N(UMW) · 10 pages"},
        {"id": "s3", "tool": "datasheet_read", "pos": pos, "status": "error", "args": {"lcsc": "C29780637", "pages": "99"},
         "error": "no page 99"}]}


ALL = {"drawer_search", "datasheet_get", "datasheet_read"}


def test_history_replays_an_earlier_answers_tools_as_calls_and_results():
    h = cc_chat.history([_asked(), _answered(), {**_asked("summarize it"), "id": "q2"}], tools=ALL)
    assert cc_chat.STEPS_NOTE in h[0]["content"] and "do not take back" in h[0]["content"]
    roles = [m["role"] for m in h[1:]]
    assert roles == ["user", "assistant", "tool", "assistant", "tool", "tool", "assistant", "user"]
    first, res1, second, res2, res3, end = h[2:8]
    assert first["content"] == "" and first["tool_calls"][0]["function"]["name"] == "drawer_search"
    assert json.loads(first["tool_calls"][0]["function"]["arguments"]) == {"query": "C29780637"}
    assert res1["tool_call_id"] == first["tool_calls"][0]["id"] and "TO-220-3" in res1["content"]   # the kept result
    assert second["content"] == "Let me look." and [c["function"]["name"] for c in second["tool_calls"]] == \
        ["datasheet_get", "datasheet_read"]
    assert res2["content"].startswith("IRL540N(UMW) · 10 pages\n[only a short summary")       # older steps: the summary
    assert res3["is_error"] and res3["content"] == "Error: no page 99"
    assert end["content"] == "Yes: IRL540N(UMW), TO-220-3, datasheet kept (p. 1)."
    assert len({c["id"] for m in h if m.get("tool_calls") for c in m["tool_calls"]}) == 3
    assert not any("```" in str(m.get("content")) for m in h[1:])                               # no fences made up


def test_history_in_anthropics_shape_pairs_each_tool_use_with_its_result():
    h = cc_chat.history([_asked(), _answered(), {**_asked("summarize it"), "id": "q2"}], tools=ALL)
    body = llm._to_anthropic(h, 100, None, "claude-haiku-5-5",
                             tools=[chat_tools.tools()[n].spec() for n in sorted(ALL)])
    turns = body["messages"]
    assert [t["role"] for t in turns] == ["user", "assistant", "user", "assistant", "user", "assistant", "user"]
    uses = [b["id"] for t in turns if t["role"] == "assistant" and isinstance(t["content"], list)
            for b in t["content"] if b["type"] == "tool_use"]
    results = [b["tool_use_id"] for t in turns if t["role"] == "user" and isinstance(t["content"], list)
               for b in t["content"] if b["type"] == "tool_result"]
    assert uses == results and len(uses) == 3
    assert turns[3]["content"][0] == {"type": "text", "text": "Let me look."}
    assert "do not take back" in body["system"]


def test_without_tools_the_steps_are_written_at_the_answers_start():
    h = cc_chat.history([_asked(), _answered(), {**_asked("thanks"), "id": "q2"}])
    assert [m["role"] for m in h[1:]] == ["user", "assistant", "user"]
    a = h[2]["content"]
    assert a.startswith("[Tools run for this answer")
    assert "drawer_search(query='C29780637') -> In the drawer" in a
    assert "datasheet_read(lcsc='C29780637', pages='99') -> Error: no page 99" in a
    assert a.endswith("datasheet kept (p. 1).")
    assert "tool_calls" not in h[2]
    # A tool that is off now: that answer is written out too, not called.
    h2 = cc_chat.history([_asked(), _answered(), {**_asked("thanks"), "id": "q2"}], tools={"drawer_search"})
    assert h2[2]["content"].startswith("[Tools run") and "tool_calls" not in h2[2]


def test_older_answers_keep_less_of_each_result(monkeypatch):
    big = _answered()
    big["steps"][0]["result"] = "x" * 5000
    msgs = []
    for i in range(4):
        msgs += [{**_asked(f"q{i}"), "id": f"q{i}"}, {**big, "id": f"a{i}"}]
    msgs.append({**_asked("again"), "id": "q9"})
    h = cc_chat.history(msgs, tools=ALL)
    firsts = [m["content"] for m in h if m["role"] == "tool" and m["content"].startswith("x")]
    assert len(firsts) == 4
    assert len(firsts[-1]) < cc_chat.RECALL_RECENT + 200 and len(firsts[0]) < cc_chat.RECALL_OLD + 200
    assert len(firsts[0]) < len(firsts[-1])
    # A shortened result says it is only shortened here, not that the model lacked it.
    assert "left out of this replay only" in firsts[-1] and "written with all of it" in firsts[-1]
    # And the budget counts them: a small one keeps only the newest.
    monkeypatch.setattr(cc_chat, "CONTEXT_CHARS", 2500)
    h = cc_chat.history(msgs, tools=ALL)
    assert h[1]["role"] == "user" and sum(m["role"] == "tool" for m in h) <= 3


def test_the_next_line_is_answered_knowing_what_the_tools_gave(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    keep_datasheet()
    monkeypatch.setattr(lcsc, "known", lambda db: _rows([{"lcsc": "C29780637", "name": "TO-220", "mpn": "IRL540N",
                                                         "maker": "UMW", "group": "Discretes", "branch": "Transistors"}]))
    tool_model(monkeypatch, state, [("", [("drawer_search", {"query": "C29780637"})]), ("It is there.", [])])
    events(cc_chat.say("c1", cc_chat.SayIn(text="C29780637?", client="tab1")))
    (step,) = answers(raw)[-1]["steps"]
    assert "IRL540N" in step["result"] and len(step["result"]) <= chat_tools.RECALL
    assert step["result_chars"] == len(state["rounds"][1]["messages"][-1]["content"])
    tool_model(monkeypatch, state, [("You're welcome.", [])])
    events(cc_chat.say("c1", cc_chat.SayIn(text="thanks", client="tab1")))
    sent = state["rounds"][0]["messages"]
    calls = [m for m in sent if m.get("tool_calls")]
    assert calls and calls[0]["tool_calls"][0]["function"]["name"] == "drawer_search"
    assert any(m["role"] == "tool" and "IRL540N" in m["content"] for m in sent)
    assert "do not take back" in sent[0]["content"]
    assert sent[-1] == {"role": "user", "content": "thanks"} or sent[-1]["content"].endswith("thanks")


def test_the_note_names_the_tools_and_their_number():
    on = [chat_tools.tools()[n] for n in ("drawer_search", "datasheet_read")]
    n = chat_tools.note(on)
    assert "exactly these 2: drawer_search, datasheet_read" in n and "not a tool" in n


# ---- drawer_list -----------------------------------------------------------------

def test_drawer_list_lists_filters_and_pages(monkeypatch):
    keep_datasheet("C29780637")
    rows = [{"lcsc": "C29780637", "mpn": "IRL540N", "maker": "UMW", "group": "Discretes", "branch": "Transistors"},
            {"lcsc": "C111607", "mpn": "STM32F103C8T6", "maker": "ST", "group": "ICs", "branch": "MCUs"},
            {"lcsc": "C2", "mpn": "BSS138", "maker": "onsemi", "group": "Discretes", "branch": "Transistors"}]
    monkeypatch.setattr(lcsc, "known", lambda db: _rows([dict(r) for r in rows]))
    tool = chat_tools.tools()["drawer_list"]
    assert tool.level == "read" and tool.default
    got = run(tool.run(Ctx(db=Db()), {}))
    assert got.say == "Listed {n} drawer parts" and got.vars["n"] == 3
    assert "C29780637  IRL540N" in got.text and "datasheet kept" in got.text and "not fetched yet" in got.text
    ds = run(tool.run(Ctx(db=Db()), {"with_datasheet": True}))
    assert ds.vars["n"] == 1 and "C29780637" in ds.text and "C111607" not in ds.text
    assert ds.say == "Listed {n} drawer parts with a datasheet"
    cat = run(tool.run(Ctx(db=Db()), {"category": "transistors"}))
    assert cat.vars["n"] == 2 and "STM32" not in cat.text
    p2 = run(tool.run(Ctx(db=Db()), {"per_page": 2, "page": 2}))
    assert p2.vars["pages"] == 2 and p2.text.count("\nC") == 1 and "Page 2 of 2" in p2.text
    none = run(tool.run(Ctx(db=Db()), {"category": "relays"}))
    assert none.say == "No parts in the drawer like that"
