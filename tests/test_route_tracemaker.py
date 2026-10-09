"""TraceMaker as the second router: the rule that picks it, its stream for
the page (docker/tm_relay.py -> backend/routelive.py) and its last word."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from backend import kicad, routelive, rules

ROOT = Path(__file__).resolve().parent.parent


def relay():
    spec = importlib.util.spec_from_file_location("tm_relay", ROOT / "docker" / "tm_relay.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_engine_is_a_rule_and_freerouting_stays_the_default():
    fresh = rules.normalise({"classes": [dict(rules.DEFAULT)]})
    assert fresh["route"]["engine"] == "freerouting"
    assert fresh["route"]["seconds"] == 120
    ok = rules.check({**fresh, "route": {**fresh["route"], "engine": "tracemaker"}})
    assert not [p for p in ok if p.startswith("route.")]
    bad = rules.check({**fresh, "route": {**fresh["route"], "engine": "autorouter9000"}})
    assert any(p.startswith("route.engine") for p in bad)
    field = next(f for f in rules.SCHEMA["route"]["fields"] if f["key"] == "engine")
    assert field["options"] == ["freerouting", "tracemaker"] and field["labels"]["tracemaker"] == "TraceMaker"


def test_the_page_reads_whole_lines_from_where_it_stopped(tmp_path):
    f = tmp_path / "live.jsonl"
    f.write_text('{"type":"board","seq":1}\n{"type":"track_add","seq":2}\n{"type":"sta')
    got, at, size = routelive.read_from(str(f), 0)
    assert [e["type"] for e in got] == ["board", "track_add"]
    assert at == len('{"type":"board","seq":1}\n{"type":"track_add","seq":2}\n') and size > at
    with open(f, "a") as h:
        h.write('ts","seq":3}\n')
    got, at2, _ = routelive.read_from(str(f), at)
    assert [e["type"] for e in got] == ["stats"]
    f.write_text('{"type":"board","seq":1}\n')          # the next try started the file again
    got, _, _ = routelive.read_from(str(f), at2)
    assert [e["type"] for e in got] == ["board"]
    assert routelive.read_from(str(tmp_path / "none"), 5) == ([], 0, 0)


def test_the_relay_keeps_state_whole_and_thins_the_search(tmp_path):
    r = relay()
    live = r.Live(str(tmp_path / "live.jsonl"))
    for i in range(50):
        live.take(json.dumps({"type": "path_try", "conn": i, "pts": []}))
        live.take(json.dumps({"type": "track_add", "track": {"id": i}}))
    live.take(json.dumps({"type": "stats", "routed": 3, "total": 9}))
    lines = [json.loads(x) for x in (tmp_path / "live.jsonl").read_text().splitlines()]
    kinds = [x["type"] for x in lines]
    assert kinds.count("track_add") == 50                # state: every one
    assert 1 <= kinds.count("path_try") < 5              # the search: a few
    assert [x["seq"] for x in lines] == list(range(1, len(lines) + 1))
    assert live.stats["routed"] == 3


def test_tracemakers_last_word_is_kept():
    log = "  variant 3 ... <- best\nrouted 235/235 connections, 981 tracks, 178 vias, pitch 0.065 mm, 120.18 s\n"
    assert kicad.tm_summary(log).startswith("routed 235/235 connections")
    assert kicad.tm_summary("nothing") is None
