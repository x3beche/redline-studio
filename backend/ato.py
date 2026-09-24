"""Boards: the same loop, over a circuit instead of a solid.

A model is parametric Python that builds into geometry. A board is
parametric atopile that builds into a netlist - the components it is made
of and what is joined to what. Change a value in the source, rebuild, and
the connections change; that is the same loop, and it is why the board
room can be the CAD room with a different builder under it.

What comes out of `ato build` is a KiCad netlist. Parsed, it is a graph:
components with a designator and a footprint, nets with the pins on them.
That graph is the artefact the room draws and somebody marks up, the way
the tessellation is for a model.

Two things about atopile 0.2 that shape this:

* its hosted component API is gone - components.atopileapi.com does not
  resolve any more - so a source that asks for "a 10k 0402" and expects a
  part number to be found fails. A component declares its own footprint
  and part, which is a better record anyway;
* it does not place a board. Layout stays KiCad's job, so what is
  parametric here is the circuit, not the copper.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import tempfile
import time
from pathlib import Path

from . import compute, store

BOARDS = "boards"
TIMEOUT = 600

# The tool lives in its own environment: it brings pydantic, numpy and a
# KiCad stack of its own, and the CAD venv has build123d in it. One of them
# was going to lose.
ATO = os.environ.get(
    "X3_ATO", str(Path(__file__).resolve().parent.parent.parent.parent
                  / ".venv-ato" / "bin" / "ato"))

PROJECT = """ato-version: ^0.2.0
builds:
  default:
    entry: elec/src/main.ato:{entry}
paths:
  src: elec/src
  layout: elec/layout
"""


# ---------------- the netlist ----------------
def _tokens(text: str):
    """S-expression tokens: brackets, quoted strings, bare words."""
    for m in re.finditer(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()]+', text):
        yield m.group(0)


def parse_netlist(text: str):
    """The netlist as nested lists. It is an S-expression, nothing more."""
    stack, cur = [], []
    for tok in _tokens(text):
        if tok == "(":
            stack.append(cur)
            cur = []
        elif tok == ")":
            done, cur = cur, stack.pop()
            cur.append(done)
        elif tok.startswith('"'):
            cur.append(tok[1:-1].replace('\\"', '"'))
        else:
            cur.append(tok)
    return cur[0] if len(cur) == 1 else cur


def _find(node, head: str):
    """Every child list whose first item is `head`."""
    return [c for c in node if isinstance(c, list) and c and c[0] == head]


def _value(node, head: str, default=None):
    hit = _find(node, head)
    return hit[0][1] if hit and len(hit[0]) > 1 else default


def _where(path: str | None) -> str | None:
    """The source location, without the temporary directory in front."""
    if not path:
        return None
    at = path.find("elec/")
    return path[at:] if at > 0 else path


def graph(netlist_text: str) -> dict:
    """Components and nets, as the room draws them.

    The source path each component came from is kept: a mark on a box has
    to lead back to the line that made it, the way a mark on a face leads
    back to the constant behind it.
    """
    tree = parse_netlist(netlist_text)
    comps = []
    for section in _find(tree, "components"):
        for c in _find(section, "comp"):
            lib = (_find(c, "libsource") or [[]])[0]
            comps.append({
                "ref": _value(c, "ref", "?"),
                "value": _value(c, "value"),
                "footprint": _value(c, "footprint"),
                "part": _value(lib, "part") if lib else None,
                # "elec/src/main.ato:App::r1" - the file, then the path to
                # the instance inside it. The build happens in a temporary
                # directory, and that directory is nobody's business.
                "where": _where(_value((_find(c, "sheetpath") or [[]])[0],
                                       "names")),
            })
    nets = []
    for section in _find(tree, "nets"):
        for n in _find(section, "net"):
            nets.append({
                "name": _value(n, "name"),
                "code": _value(n, "code"),
                "nodes": [{"ref": _value(nd, "ref"), "pin": _value(nd, "pin")}
                          for nd in _find(n, "node")],
            })
    return {"components": comps, "nets": nets,
            "counts": {"components": len(comps), "nets": len(nets),
                       "joins": sum(len(n["nodes"]) for n in nets)}}


def bom(csv_text: str) -> list[dict]:
    """The bill, as rows of named cells.

    Read with a real CSV reader, not by splitting on commas: atopile
    groups identical parts and writes the designators as one quoted field,
    `"U4,U5"`, which a naive split turns into two cells and shifts every
    column after it.
    """
    import csv as _csv
    import io

    rows = list(_csv.reader(io.StringIO(csv_text)))
    rows = [r for r in rows if any(c.strip() for c in r)]
    if not rows:
        return []
    head = [h.strip().lower() for h in rows[0]]
    return [dict(zip(head, [c.strip() for c in r])) for r in rows[1:]]


def parts_from_bom(components: list[dict], rows: list[dict]) -> None:
    """Give each component the part number the bill gives its designator.

    The bill groups identical parts - `"U9,U11"` on one row - so each
    designator in the group gets that row's number.
    """
    by_ref = {}
    for row in rows:
        for ref in (row.get("designator") or "").split(","):
            if ref.strip():
                by_ref[ref.strip()] = row.get("lcsc") or row.get("comment")
    for comp in components:
        if comp["ref"] in by_ref:
            comp["part"] = by_ref[comp["ref"]]


# ---------------- building ----------------
async def build(db, board_id: str) -> dict:
    """Run atopile over a board's source and store what comes out.

    Mirrors a model build on purpose: the source comes from the database,
    the work happens in a temporary directory, the output goes back to the
    database, and what the machine spent is measured the same way.
    """
    doc = await db[BOARDS].find_one({"_id": board_id})
    if not doc:
        raise KeyError(board_id)
    if not doc.get("source"):
        raise ValueError(f"{board_id}: no source")
    if not Path(ATO).exists():
        raise RuntimeError(
            f"atopile is not installed at {ATO}. It lives in its own "
            f"environment; set X3_ATO to point at another.")

    started = time.monotonic()
    started_at = store.now()
    await db[BOARDS].update_one(
        {"_id": board_id},
        {"$set": {"building": True, "build_started": started_at}})

    tmp = Path(tempfile.mkdtemp(prefix="x3ato-"))
    try:
        src = tmp / "elec" / "src"
        src.mkdir(parents=True)
        (tmp / "elec" / "layout").mkdir(parents=True)
        (tmp / "ato.yaml").write_text(
            PROJECT.format(entry=doc.get("entry") or "App"))
        (src / "main.ato").write_text(doc["source"])

        capped = Path(__file__).resolve().parent.parent / "tools" / "capped.sh"
        argv = [ATO, "--non-interactive", "build"]
        if capped.exists():
            argv = [str(capped), *argv]

        meter = compute.Meter()
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=str(tmp),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        meter.watch(proc.pid)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            raise TimeoutError(f"{board_id}: build did not finish in {TIMEOUT}s")
        finally:
            job = meter.stop()
            try:
                await compute.record(db, "board", await compute.current_revision(db, "pcb"),
                                     model=board_id, rc=proc.returncode, **job)
            except Exception:
                pass

        log = out.decode(errors="replace").strip().splitlines()
        if proc.returncode != 0:
            raise RuntimeError("\n".join(log[-12:]) or "the build failed")

        net = tmp / "build" / "default.net"
        if not net.exists() or not net.read_text().strip():
            raise RuntimeError("no netlist came out of the build")

        payload = graph(net.read_text())
        csv = tmp / "build" / "default.csv"
        # The part number comes from the bill, not from the netlist. The
        # netlist keeps one library part per footprint name, so every
        # R0402 on a board carried the first one's number - a 2 kΩ and a
        # 1 kΩ both read C25905, the 5.1 kΩ - and two different chips in
        # the same package would have been fetched and drawn as one.
        rows = bom(csv.read_text()) if csv.exists() else []
        parts_from_bom(payload["components"], rows)
        payload["bom"] = rows
        payload["built_at"] = store.now()

        import json
        stored = await store.put_artifact(
            db, board_id, "graph", json.dumps(payload).encode(),
            collection=BOARDS)

        # The footprints the build used, kept beside the netlist. Laying
        # the board out needs them, and they are the ones this build
        # actually named - not whatever a library has under that name
        # today.
        used = {(c.get("footprint") or "").split(":")[-1]
                for c in payload["components"]}
        pretty = tmp / "build" / "footprints" / "footprints.pretty"
        shapes = {}
        for name in sorted(n for n in used if n):
            f = pretty / f"{name}.kicad_mod"
            if f.exists():
                shapes[name] = f.read_text()
        await store.put_artifact(db, board_id, "footprints",
                                 json.dumps(shapes).encode(), collection=BOARDS)

        return {"board": board_id, "bytes": stored["bytes"],
                "footprints": len(shapes),
                **payload["counts"], "log": "\n".join(log[-3:])}
    finally:
        took = round(time.monotonic() - started, 1)
        patch = {"building": False}
        if took > 1:
            patch["build_secs"] = took
        await db[BOARDS].update_one(
            {"_id": board_id},
            {"$set": patch, "$unset": {"build_started": ""}})
        shutil.rmtree(tmp, ignore_errors=True)
