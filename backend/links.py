"""Components, and what uses them - the linked-component model.

Fusion 360's idea, for this catalog: a part is designed once and *used*
everywhere else, by reference. Change the part and every design that uses
it follows; nothing anywhere holds a copy of it. Here a component is either

- a 3D model (`models`, `.3d`): build123d source, used by `import stand`;
- a board (`boards`, `.pcb`): its 3D artifact (backend/board3d.py), used
  by `import demoboard_gerber_zip as B`.

What this module keeps
    models.uses      [{kind, id, module}] - what the source imports, read
                     with `ast` (never by substring) and mapped to ids.
    models.version   n, bumped whenever the source changes.
    boards.component {version, digest, ...}, bumped whenever a layout makes
                     a different STEP or different named data.
    models.built     {at, against: {key: {version, digest}}, hash} - what
                     the last build used, so the page can say "built
                     against demoboard v12", and say when that is old.
    models.pins      {key: version} - "break link": that component is used
                     at that version and a newer one does not propagate.
    models.link      the propagation state: {state: queued | building |
                     done | failed | blocked | cycle, because: {kind, id,
                     title, version}, due, error, cycle}.
    component_versions  a copy of every version a pin can point at.

How a change travels
    A model saved with a different source, or a board whose layout gave a
    new 3D artifact, calls `changed()`. Every model that uses it, directly
    or through another, is marked stale and queued with a due time a few
    seconds away (a burst of saves is one rebuild). The API's `loop()`
    takes the queue in topological order - a model is only built once
    nothing it uses is still waiting - at most PARALLEL at once, through
    the ordinary memory-capped build (backend/build.py). A dependent that
    fails is marked failed with the error, and what depends on it is
    blocked rather than built against a broken part. A cycle is never
    built: its members are marked with the cycle.
"""

from __future__ import annotations

import ast
import asyncio
import contextvars
import gzip
import hashlib
import logging
import os
import re
from datetime import datetime, timedelta, timezone

from . import board3d, scope, store

LOG = logging.getLogger("redline.links")

BOARDS = "boards"
VERSIONS = "component_versions"
DEBOUNCE = float(os.environ.get("REDLINE_LINK_DEBOUNCE", "4"))
PARALLEL = max(1, int(os.environ.get("REDLINE_LINK_BUILDS", "1")))
TICK = 2.0
KEEP = 8                    # versions of a component kept besides pinned ones
# On a board: a layout that leaves its 3D unchanged is a new version all
# the same (off: such a layout is no version, the default).
EVERY_RUN = "component_every_run"

UPDATING = ("queued", "building")


def key(kind: str, cid: str) -> str:
    return f"{kind}:{cid}"


def split(k: str) -> tuple[str, str]:
    kind, _, cid = k.partition(":")
    return kind, cid


# ---------------------------------------------------------------- reading imports

_IMPORT_LINE = re.compile(r"^\s*(?:import\s+([A-Za-z_]\w*)|from\s+([A-Za-z_]\w*)\s+import\b)", re.M)


def imported_names(source: str) -> list[str]:
    """The top-level module names a source imports, in order: `import a.b`
    and `import a as x` are `a`, `from a import b` is `a`. Relative
    imports name nothing in the catalog. `importlib.import_module("a")`
    with a literal counts too. A source that does not parse falls back to
    reading the import lines, so a half-written model still says what it
    uses."""
    try:
        tree = ast.parse(source or "")
    except SyntaxError:
        return list(dict.fromkeys(a or b for a, b in _IMPORT_LINE.findall(source or "")))
    found: list[tuple[int, int, str]] = []
    for node in ast.walk(tree):
        at = (getattr(node, "lineno", 0), getattr(node, "col_offset", 0))
        if isinstance(node, ast.Import):
            found += [(*at, a.name.split(".")[0]) for a in node.names]
        elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
            found.append((*at, node.module.split(".")[0]))
        elif (isinstance(node, ast.Call) and node.args
              and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)
              and ((isinstance(node.func, ast.Attribute) and node.func.attr == "import_module")
                   or (isinstance(node.func, ast.Name) and node.func.id == "__import__"))):
            found.append((*at, node.args[0].value.split(".")[0]))
    # ast.walk is breadth-first; the order a person reads is the line order.
    return list(dict.fromkeys(name for _l, _c, name in sorted(found)))


def flat(model_id: str) -> str:
    return model_id.replace("/", "__")


def module_table(models: list[dict], boards: list[dict]) -> dict[str, tuple[str, str]]:
    """Module name -> (kind, id), the way the build lays the files out.

    A model is there under its flat id (`iot-fan__parts__stand`) and, while
    nothing else has the same name, its bare one (`stand`) - the way
    assemblies have always imported. A board is there as `pcb_<name>`,
    always, and as `<name>` unless a model already is.
    """
    import collections
    bare = collections.Counter(m.get("name") or str(m["_id"]).rpartition("/")[2] for m in models)
    table: dict[str, tuple[str, str]] = {}
    for m in models:
        table[flat(str(m["_id"]))] = ("model", str(m["_id"]))
    for m in models:
        name = m.get("name") or str(m["_id"]).rpartition("/")[2]
        if bare[name] == 1:
            table.setdefault(name, ("model", str(m["_id"])))
    for b in boards:
        mod = board3d.module_name(str(b["_id"]))
        table.setdefault("pcb_" + mod, ("board", str(b["_id"])))
        table.setdefault(mod, ("board", str(b["_id"])))
    return table


def table_rows(g: "Graph") -> dict[str, dict]:
    """The module table as the code view needs it: every name a model can
    import, what it resolves to, and that component's title."""
    out = {}
    for name, (kind, cid) in sorted(g.table.items()):
        if not name.isidentifier():
            continue
        info = g.nodes.get(key(kind, cid)) or {}
        out[name] = {"kind": kind, "id": cid, "title": info.get("title") or cid}
    return out


def table_digest(table: dict) -> str:
    return hashlib.sha256(repr(sorted(table.items())).encode()).hexdigest()[:16]


def resolve(source: str, table: dict, self_id: str | None = None) -> list[dict]:
    """What a source uses: [{kind, id, module}], each component once."""
    out, seen = [], set()
    for name in imported_names(source):
        hit = table.get(name)
        if not hit:
            continue
        kind, cid = hit
        if (kind == "model" and cid == self_id) or key(kind, cid) in seen:
            continue
        seen.add(key(kind, cid))
        out.append({"kind": kind, "id": cid, "module": name})
    return out


def module_for(kind: str, cid: str, table: dict) -> str | None:
    """The name to import a component by: the shortest the table has."""
    names = [n for n, v in table.items() if v == (kind, cid)]
    if not names:
        return None
    importable = [n for n in names if n.isidentifier()]
    if kind == "board":
        plain = board3d.module_name(cid)
        if plain in importable:
            return plain
    return min(importable or names, key=len)


# ---------------------------------------------------------------- the graph

class Graph:
    """Components and the uses between them. Edges run from a model to
    what it uses."""

    def __init__(self):
        self.nodes: dict[str, dict] = {}
        self.uses: dict[str, list[str]] = {}
        self.pins: dict[str, dict[str, int]] = {}
        self.table: dict[str, tuple[str, str]] = {}

    def add(self, k: str, info: dict, uses: list[str] | None = None,
            pins: dict | None = None) -> None:
        self.nodes[k] = info
        self.uses[k] = [u for u in (uses or []) if u != k]
        self.pins[k] = dict(pins or {})

    def used_by(self, k: str) -> list[str]:
        return sorted(d for d, us in self.uses.items() if k in us)

    def pinned(self, dependent: str, component: str) -> bool:
        return component in self.pins.get(dependent, {})

    def dependents(self, k: str, follow_pins: bool = False) -> list[str]:
        """Everything that uses `k`, directly or through something else.
        A pinned use does not carry a change, unless asked to."""
        out, todo = [], [k]
        seen = {k}
        while todo:
            cur = todo.pop()
            for d in self.used_by(cur):
                if d in seen or (not follow_pins and self.pinned(d, cur)):
                    continue
                seen.add(d)
                out.append(d)
                todo.append(d)
        return sorted(out)

    def upstream(self, k: str) -> list[str]:
        """Everything `k` uses, down to the bottom."""
        out, todo, seen = [], [k], {k}
        while todo:
            cur = todo.pop()
            for u in self.uses.get(cur, []):
                if u in seen:
                    continue
                seen.add(u)
                out.append(u)
                todo.append(u)
        return sorted(out)

    def cycles(self) -> list[list[str]]:
        """Each import cycle once (Tarjan's strongly connected components,
        and a model importing itself)."""
        index, low, on, stack, out = {}, {}, set(), [], []
        counter = [0]

        def strong(v):
            index[v] = low[v] = counter[0]
            counter[0] += 1
            stack.append(v)
            on.add(v)
            for w in self.uses.get(v, []):
                if w not in self.nodes:
                    continue
                if w not in index:
                    strong(w)
                    low[v] = min(low[v], low[w])
                elif w in on:
                    low[v] = min(low[v], index[w])
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop()
                    on.discard(w)
                    comp.append(w)
                    if w == v:
                        break
                if len(comp) > 1:
                    out.append(sorted(comp))

        for v in sorted(self.nodes):
            if v not in index:
                strong(v)
        return out

    def order(self, keys) -> tuple[list[str], list[str]]:
        """`keys` with every component before what uses it. Returns the
        order and whatever could not be ordered (a cycle among them)."""
        keys = set(keys)
        need = {k: {u for u in self.upstream(k) if u in keys} for k in keys}
        done, out = set(), []
        while True:
            ready = sorted(k for k in keys - done if need[k] <= done)
            if not ready:
                break
            out += ready
            done |= set(ready)
        return out, sorted(keys - done)


async def load(db, write_back: bool = True) -> Graph:
    """The catalog's graph, with every model's `uses` brought up to date.

    `uses` is kept on the model and reread only when its source or the
    module table changed - a rename elsewhere can change what `import
    stand` means."""
    models = [m async for m in db.models.find(
        {}, {"source": 1, "name": 1, "title": 1, "sha256": 1, "uses": 1, "uses_sha": 1,
             "version": 1, "pins": 1})]
    boards = [b async for b in db[BOARDS].find({}, {"title": 1, "component": 1})]
    table = module_table(models, boards)
    tdig = table_digest(table)
    g = Graph()
    g.table = table
    for b in boards:
        comp = b.get("component") or {}
        g.add(key("board", str(b["_id"])), {
            "kind": "board", "id": str(b["_id"]), "title": b.get("title") or str(b["_id"]),
            "version": comp.get("version") or 0, "digest": comp.get("digest") or "",
            "ready": bool(comp.get("digest"))})
    for m in models:
        mid = str(m["_id"])
        want = f"{m.get('sha256') or ''}:{tdig}"
        uses = m.get("uses")
        if uses is None or m.get("uses_sha") != want:
            uses = resolve(m.get("source") or "", table, mid)
            if write_back:
                try:
                    await db.models.update_one({"_id": mid},
                                               {"$set": {"uses": uses, "uses_sha": want}})
                except Exception:                    # noqa: BLE001 - kept next time
                    pass
        g.add(key("model", mid), {
            "kind": "model", "id": mid, "title": m.get("title") or m.get("name") or mid,
            "version": m.get("version") or 1, "digest": (m.get("sha256") or "")[:16],
            "source": m.get("source") or ""},
            [key(u["kind"], u["id"]) for u in uses], m.get("pins"))
    return g


async def reindex(db) -> Graph:
    """Read every model's imports again (after a rename, a new board...)."""
    return await load(db)


def against(g: Graph, k: str) -> dict:
    """What a build of `k` uses, each component at its version - pinned
    ones at their pin - and one hash over all of it."""
    pins = g.pins.get(k, {})
    rows = {}
    for u in g.upstream(k):
        info = g.nodes.get(u) or {}
        pin = pins.get(u)
        rows[u] = {"version": pin if pin is not None else info.get("version"),
                   "digest": "" if pin is not None else info.get("digest"),
                   "title": info.get("title"), "pinned": pin is not None,
                   "direct": u in g.uses.get(k, [])}
    blob = repr(sorted((u, r["version"], r["digest"]) for u, r in rows.items()))
    return {"against": rows, "hash": hashlib.sha256(blob.encode()).hexdigest()[:16]}


# ---------------------------------------------------------------- versions

async def archive(db, kind: str, cid: str, version: int, doc: dict) -> None:
    """Keep this version where a pin can find it, and let old unpinned
    ones go."""
    vid = f"{kind}:{cid}:v{version}"
    await db[VERSIONS].replace_one({"_id": vid}, {"_id": vid, "kind": kind, "component": cid,
                                                  "version": version, "at": store.now(), **doc},
                                   upsert=True)
    rows = [r async for r in db[VERSIONS].find({"kind": kind, "component": cid},
                                               {"version": 1, "step": 1})]
    rows.sort(key=lambda r: r.get("version") or 0, reverse=True)
    pinned = set()
    async for m in db.models.find({f"pins.{key(kind, cid)}": {"$exists": True}}, {"pins": 1}):
        pinned.add((m.get("pins") or {}).get(key(kind, cid)))
    for r in rows[KEEP:]:
        if r.get("version") in pinned:
            continue
        if (r.get("step") or {}).get("gridfs_id"):
            try:
                await store.bucket(db, "model_files").delete(r["step"]["gridfs_id"])
            except Exception:                        # noqa: BLE001
                pass
        await db[VERSIONS].delete_one({"_id": r["_id"]})


async def version_of(db, kind: str, cid: str, version: int) -> dict | None:
    return await db[VERSIONS].find_one({"_id": f"{kind}:{cid}:v{version}"})


async def version_step(db, row: dict) -> bytes:
    meta = row.get("step") or {}
    hit = store.CACHE / f"{meta['gridfs_id']}.gz"
    try:
        if hit.exists():
            return gzip.decompress(hit.read_bytes())
    except OSError:
        pass
    stream = await store.bucket(db, "model_files").open_download_stream(meta["gridfs_id"])
    packed = await stream.read()
    store.cache_put(meta["gridfs_id"], packed)
    return gzip.decompress(packed)


async def model_saved(db, model_id: str, old: dict | None, doc: dict) -> dict:
    """After store.save_model: a new version if the source changed, and the
    change sent on to whatever uses the model."""
    changed_source = not old or old.get("sha256") != doc["sha256"]
    if not changed_source:
        return {"version": (old or {}).get("version") or 1, "queued": [], "cycles": []}
    # A model saved before versions existed is v1 (what the page shows it as).
    version = ((old.get("version") or 1) + 1) if old else 1
    await db.models.update_one({"_id": model_id}, {"$set": {"version": version}})
    try:
        await archive(db, "model", model_id, version,
                      {"source": doc["source"], "sha256": doc["sha256"]})
    except Exception:                                # noqa: BLE001 - pins are a nicety
        LOG.exception("could not keep %s v%s", model_id, version)
    out = await changed(db, "model", model_id, version=version)
    return {"version": version, **out}


async def board_component(db, board_id: str, step: bytes, data: dict, stl: bytes | None,
                          digest: str | None = None, glb_digest: str = "") -> dict:
    """A layout's 3D artifacts for a board: stored, versioned if the design
    they come from differs from the last (`digest`, backend/kicad.py's
    design_digest), and the change sent on."""
    digest = digest or hashlib.sha256(
        (board3d.step_digest(step) + board3d.data_digest(data)).encode()).hexdigest()
    doc = await db[BOARDS].find_one({"_id": board_id},
                                    {"component": 1, "title": 1, EVERY_RUN: 1}) or {}
    comp = doc.get("component") or {}
    import json as _json
    meta_step = await store.put_artifact(db, board_id, "step", step, collection=BOARDS)
    await store.put_artifact(db, board_id, "board3d", _json.dumps(data).encode(), collection=BOARDS)
    if stl:
        await store.put_artifact(db, board_id, "stl", stl, collection=BOARDS)
    # By default a layout that leaves the 3D as it was is not a version:
    # nothing that uses the board would be any different. The board can
    # say otherwise ("every run is a new version"), for pinning by run.
    same = comp.get("digest") == digest
    if same and not doc.get(EVERY_RUN):
        await db[BOARDS].update_one({"_id": board_id}, {"$unset": {"component_error": ""}})
        return {"version": comp.get("version"), "changed": False, "queued": []}
    version = (comp.get("version") or 0) + 1
    patch = {"version": version, "digest": digest, "at": store.now(), "same_as_before": same,
             "module": board3d.module_name(board_id), "step_bytes": len(step),
             "data_version": board3d.DATA_VERSION, "glb": glb_digest[:16],
             "summary": {"size": data.get("size"), "thickness": data.get("thickness"),
                         "holes": len(data.get("holes") or []),
                         "connectors": len(data.get("connectors") or []),
                         "approximate": data.get("approximate") or []}}
    await db[BOARDS].update_one({"_id": board_id}, {"$set": {"component": patch},
                                                    "$unset": {"component_error": ""}})
    # A pin needs its own copy of the STEP: the artifact is replaced by the
    # next layout.
    packed = gzip.compress(step, compresslevel=6)
    fid = await store.bucket(db, "model_files").upload_from_stream(f"{board_id}:step@v{version}.gz", packed)
    store.cache_put(fid, packed)
    await archive(db, "board", board_id, version, {
        "digest": digest, "data": data,
        "step": {"gridfs_id": fid, "bytes": len(step), "sha256": meta_step.get("sha256")}})
    out = await changed(db, "board", board_id, version=version)
    return {"version": version, "changed": True, **out}


# ---------------------------------------------------------------- propagation

def _later(seconds: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


async def changed(db, kind: str, cid: str, version: int | None = None,
                  g: Graph | None = None, because: dict | None = None,
                  include_self: bool = False) -> dict:
    """`kind:cid` changed: mark every dependent stale and queue its
    rebuild. Returns what was queued and any cycle met. `include_self`
    queues `kind:cid` too (a model whose pin moved is itself rebuilt)."""
    g = g or await load(db)
    k = key(kind, cid)
    info = g.nodes.get(k) or {"title": cid}
    deps = g.dependents(k)
    if include_self and kind == "model":
        deps = sorted({k, *deps})
    cycles = [c for c in g.cycles() if k in c or set(c) & set(deps)]
    in_cycle = {m for c in cycles for m in c}
    because = because or {"kind": kind, "id": cid, "title": info.get("title") or cid,
                          "version": version if version is not None else info.get("version")}
    at, due = store.now(), _later(DEBOUNCE)
    queued = []
    for d in deps:
        dk, did = split(d)
        if dk != "model":
            continue
        token = hashlib.sha256(f"{d}{at}".encode()).hexdigest()[:12]
        if d in in_cycle:
            cyc = next(c for c in cycles if d in c)
            link = {"state": "cycle", "because": because, "at": at, "token": token,
                    "cycle": [split(x)[1] for x in cyc],
                    "error": "import cycle: " + " -> ".join(split(x)[1] for x in cyc + cyc[:1])}
        else:
            link = {"state": "queued", "because": because, "at": at, "due": due, "token": token}
            queued.append(did)
        await db.models.update_one({"_id": did}, {"$set": {"stale": True, "link": link}})
    return {"queued": queued, "cycles": [[split(x)[1] for x in c] for c in cycles]}


async def users_of(db, kind: str, cid: str) -> list[str]:
    """The models that use this component directly (ids)."""
    g = await load(db)
    return [split(d)[1] for d in g.used_by(key(kind, cid))]


# ---------------------------------------------------------------- pins

def what_changed(kind: str, prev: dict | None, row: dict) -> list[str]:
    """A version against the one before it, in a few words a person can
    choose a version by: the numbers that moved, parts added or gone."""
    if prev is None:
        return ["first version" if row.get("version") == 1 else "oldest kept"]
    if kind == "model":
        a, b = prev.get("source") or "", row.get("source") or ""
        out = []
        ea, eb = model_exports(a), model_exports(b)
        for name in sorted(set(ea) | set(eb)):
            if ea.get(name) != eb.get(name):
                out.append(f"{name} {_num(ea.get(name))} -> {_num(eb.get(name))}")
        import difflib
        plus = minus = 0
        for line in difflib.unified_diff(a.splitlines(), b.splitlines(), lineterm="", n=0):
            if line.startswith("+") and not line.startswith("+++"):
                plus += 1
            elif line.startswith("-") and not line.startswith("---"):
                minus += 1
        if plus or minus:
            out.append(f"+{plus} -{minus} lines")
        return out[:5] or ["same source"]
    if prev.get("digest") and prev.get("digest") == row.get("digest"):
        return [f"same 3D as v{prev.get('version')}"]
    da, db_ = prev.get("data") or {}, row.get("data") or {}
    out = []
    if da.get("size") != db_.get("size"):
        out.append("size " + " x ".join(_num(v) for v in da.get("size") or []) + " -> "
                   + " x ".join(_num(v) for v in db_.get("size") or []) + " mm")
    if da.get("thickness") != db_.get("thickness"):
        out.append(f"thickness {_num(da.get('thickness'))} -> {_num(db_.get('thickness'))}")
    if da.get("outline") != db_.get("outline") and da.get("size") == db_.get("size"):
        out.append("outline changed")
    for name, label in (("holes", "holes"), ("connectors", "connectors")):
        ra, rb = da.get(name) or [], db_.get(name) or []
        if len(ra) != len(rb):
            out.append(f"{label} {len(ra)} -> {len(rb)}")
        elif name == "holes" and sorted((h["x"], h["y"], h["d"]) for h in ra) != \
                sorted((h["x"], h["y"], h["d"]) for h in rb):
            out.append("holes moved")
    ba = {b["ref"]: b["box"] for b in da.get("bodies") or []}
    bb = {b["ref"]: b["box"] for b in db_.get("bodies") or []}
    added, gone = sorted(set(bb) - set(ba)), sorted(set(ba) - set(bb))
    moved = sorted(r for r in set(ba) & set(bb)
                   if max(abs(x - y) for x, y in zip(ba[r], bb[r])) > 0.05)
    for words, refs in (("added", added), ("removed", gone), ("moved", moved)):
        if refs:
            out.append(f"{', '.join(refs[:4])}{' +' + str(len(refs) - 4) if len(refs) > 4 else ''} {words}")
    return out[:5] or ["placement or models changed"]


def _num(v) -> str:
    if v is None:
        return "-"
    return f"{v:g}" if isinstance(v, (int, float)) else str(v)


async def versions(db, kind: str, cid: str) -> list[dict]:
    """The kept versions of a component, newest first: when, and what each
    changed against the one before it."""
    rows = [r async for r in db[VERSIONS].find({"kind": kind, "component": cid})]
    rows.sort(key=lambda r: r.get("version") or 0)
    out, prev = [], None
    for r in rows:
        out.append({"version": r.get("version"), "at": r.get("at"),
                    "changes": what_changed(kind, prev, r)})
        prev = r
    return out[::-1]


def pinned_by(g: Graph, k: str) -> list[dict]:
    """Every model that pins `k`, at which version, and whether that is
    older than the latest."""
    latest = (g.nodes.get(k) or {}).get("version")
    out = []
    for d, pins in sorted(g.pins.items()):
        if k in pins and d in g.nodes:
            v = pins[k]
            out.append({"id": split(d)[1], "title": g.nodes[d].get("title"), "version": v,
                        "latest": latest, "behind": latest is not None and v is not None and v < latest})
    return out


class PinError(ValueError):
    """A pin that cannot be: a component the model does not use, a version
    no longer kept."""


async def set_pin(db, model_id: str, component: str, version: int | None) -> dict:
    """Use `component` at `version` in `model_id` (Fusion's "break link"),
    or follow its latest again (None). Either way the model is rebuilt -
    and what uses it, which builds against the model's pins too."""
    g = await load(db)
    k = key("model", model_id)
    if k not in g.nodes:
        raise KeyError(model_id)
    if component not in g.upstream(k):
        raise PinError(f"{model_id} does not use {component}")
    kind, cid = split(component)
    if version is not None and not await version_of(db, kind, cid, version):
        raise LookupError(f"{component} v{version} is not kept")
    was = g.pins.get(k, {}).get(component)
    if was == version:
        return {"model": model_id, "component": component, "version": version,
                "changed": False, "queued": []}
    if version is None:
        await db.models.update_one({"_id": model_id}, {"$unset": {f"pins.{component}": ""}})
        g.pins.setdefault(k, {}).pop(component, None)
    else:
        await db.models.update_one({"_id": model_id}, {"$set": {f"pins.{component}": version}})
        g.pins.setdefault(k, {})[component] = version
    info = g.nodes.get(component) or {}
    because = {"kind": kind, "id": cid, "title": info.get("title") or cid,
               "version": version if version is not None else info.get("version"),
               "pin": "pinned" if version is not None else "follow"}
    out = await changed(db, "model", model_id, g=g, because=because, include_self=True)
    return {"model": model_id, "component": component, "version": version, "was": was,
            "changed": True, **out}


async def update_pins(db, kind: str, cid: str) -> list[dict]:
    """Every model pinned to an older version of `kind:cid` moved to its
    latest - still pinned, so the next version waits for them again. A
    latest that is not kept (a model from before versions) is followed."""
    g = await load(db)
    k = key(kind, cid)
    latest = (g.nodes.get(k) or {}).get("version")
    kept = bool(latest is not None and await version_of(db, kind, cid, latest))
    out = []
    for row in pinned_by(g, k):
        if not row["behind"]:
            continue
        got = await set_pin(db, row["id"], k, latest if kept else None)
        out.append({"model": row["id"], "from": row["version"], "to": got["version"],
                    "queued": got.get("queued", [])})
    return out


async def recover(db) -> int:
    """After a restart: a rebuild this process had started is queued again
    (the process that ran it is gone)."""
    n = 0
    async for m in db.models.find({"link.state": "building"}, {"_id": 1}):
        await db.models.update_one({"_id": m["_id"]}, {"$set": {
            "link.state": "queued", "link.due": store.now(), "building": False}})
        n += 1
    return n


class Scheduler:
    """Takes the queue in order. One per API process."""

    def __init__(self, builder, parallel: int = PARALLEL):
        self.builder = builder                 # async (db, model_id) -> result
        self.parallel = parallel
        self.running: dict[tuple[str, str], asyncio.Task] = {}

    async def tick(self, db, ws: str = scope.DEFAULT) -> list[str]:
        """One look at one workspace's queue; the rebuilds it started."""
        queued = {str(m["_id"]): m async for m in db.models.find(
            {"link.state": "queued"}, {"link": 1})}
        if not queued:
            return []
        g = await load(db, write_back=False)
        now = store.now()
        busy = {mid for (w, mid) in self.running if w == ws}
        waiting = {key("model", m) for m in queued} | {key("model", m) for m in busy}
        order, stuck = g.order([key("model", m) for m in queued])
        started = []
        for k in stuck:                        # a cycle among the queued
            mid = split(k)[1]
            cyc = next((c for c in g.cycles() if k in c), [k])
            await db.models.update_one({"_id": mid, "link.state": "queued"}, {"$set": {
                "link.state": "cycle", "link.cycle": [split(x)[1] for x in cyc],
                "link.error": "import cycle: " + " -> ".join(split(x)[1] for x in cyc + cyc[:1])}})
        for k in order:
            if len(self.running) >= self.parallel:
                break
            mid = split(k)[1]
            link = queued[mid].get("link") or {}
            if (link.get("due") or "") > now or mid in busy:
                continue
            if any(u in waiting for u in g.upstream(k)):
                continue                       # something it uses is not built yet
            claim = await db.models.update_one(
                {"_id": mid, "link.state": "queued", "link.token": link.get("token")},
                {"$set": {"link.state": "building", "link.started": now}})
            if not claim.modified_count:
                continue
            task = asyncio.create_task(self._rebuild(db, mid, link.get("token"), g))
            self.running[(ws, mid)] = task
            task.add_done_callback(lambda _t, w=ws, m=mid: self.running.pop((w, m), None))
            started.append(mid)
        return started

    async def _rebuild(self, db, mid: str, token: str | None, g: Graph) -> None:
        try:
            await self.builder(db, mid)
        except Exception as exc:               # noqa: BLE001 - said on the model
            msg = f"{type(exc).__name__}: {exc}" if not str(exc) else str(exc)
            await db.models.update_one({"_id": mid, "link.token": token}, {"$set": {
                "link.state": "failed", "link.error": msg[-1500:], "link.done_at": store.now()}})
            # What uses it is not built against a part that does not build.
            for d in g.dependents(key("model", mid)):
                await db.models.update_one(
                    {"_id": split(d)[1], "link.state": "queued"},
                    {"$set": {"link.state": "blocked",
                              "link.error": f"{mid} failed to build after this change"}})
            return
        await db.models.update_one({"_id": mid, "link.token": token}, {"$set": {
            "link.state": "done", "link.done_at": store.now()}, "$unset": {"link.error": ""}})

    async def idle(self) -> None:
        """Until nothing this scheduler started is running (tests)."""
        while self.running:
            await asyncio.gather(*list(self.running.values()), return_exceptions=True)


async def loop(raw_db, builder, stop: asyncio.Event | None = None) -> None:
    """The API's propagation loop, over every workspace."""
    sched = Scheduler(builder)
    first = True
    while not (stop and stop.is_set()):
        try:
            raw = raw_db()
            wss = await raw.models.distinct("workspace_id", {"link.state": {"$in": ["queued", "building"]}})
            for w in wss or ([None] if first else []):
                ws = w or scope.DEFAULT
                ctx = contextvars.copy_context()
                ctx.run(scope.WORKSPACE.set, ws)
                sdb = scope.ScopedDb(raw, ws)
                if first:
                    await recover(sdb)
                await asyncio.get_running_loop().create_task(sched.tick(sdb, ws), context=ctx)
            first = False
        except Exception:                      # noqa: BLE001 - next tick
            LOG.exception("link propagation tick failed")
        await asyncio.sleep(TICK)


# ---------------------------------------------------------------- the build directory

class NoBoard3d(RuntimeError):
    """A model uses a board that has no 3D artifact yet."""


async def write_board(db, models_dir, root, board_id: str, table: dict,
                      pin: int | None = None) -> dict:
    """The board's module, and the STEP it reads, into a build directory:
    `<models_dir>/<module>.py` (and `pcb_<module>.py`, which is the same
    module) and `<root>/_boards/<id>.step`."""
    import json as _json
    from pathlib import Path

    models_dir, root = Path(models_dir), Path(root)
    doc = await db[BOARDS].find_one({"_id": board_id}, {"title": 1, "component": 1}) or {}
    comp = doc.get("component") or {}
    title = doc.get("title") or board_id
    if pin is not None and pin != comp.get("version"):
        row = await version_of(db, "board", board_id, pin)
        if not row:
            raise NoBoard3d(f"{board_id} v{pin} is pinned but no longer kept")
        data, step, version, digest = row["data"], await version_step(db, row), pin, row["digest"]
    else:
        if not comp.get("digest"):
            raise NoBoard3d(f"board {board_id} has no 3D yet - lay it out (a run or a layout "
                            "in the PCB room) and the models that use it build")
        try:
            data = _json.loads(await store.get_artifact(db, board_id, "board3d", BOARDS))
            step = await store.get_artifact(db, board_id, "step", BOARDS)
        except KeyError as exc:
            raise NoBoard3d(f"board {board_id}: its 3D artifact is missing ({exc})") from exc
        version, digest = comp.get("version") or 1, comp["digest"]
    step_name = f"{board_id.replace('/', '__')}.step"
    (root / "_boards").mkdir(exist_ok=True)
    (root / "_boards" / step_name).write_bytes(step)
    text = board3d.module_source(board_id, title, data, version, digest, step_name)
    names = [n for n, v in table.items() if v == ("board", board_id) and n.isidentifier()]
    main = board3d.module_name(board_id) if board3d.module_name(board_id) in names else names[0]
    (models_dir / f"{main}.py").write_text(text)
    for n in names:
        if n != main:
            # The same module under its other name, not a second copy of it:
            # one STEP import however it is reached.
            (models_dir / f"{n}.py").write_text(
                "import importlib, sys\n"
                f"sys.modules[__name__] = importlib.import_module({main!r})\n")
    return {"board": board_id, "version": version, "module": main}


async def prepare(db, model_id: str, models_dir, root) -> dict:
    """What a build of `model_id` needs from the graph: the board modules
    it uses (and their STEPs), pinned models at their pinned source, the
    sources it can reach - and what it is being built against."""
    g = await load(db)
    k = key("model", model_id)
    closure = g.upstream(k)
    pins: dict[str, int] = {}
    for m in [*closure, k]:                    # the model's own pins win
        pins.update(g.pins.get(m, {}))
    boards = []
    from pathlib import Path
    for u in closure:
        kind, cid = split(u)
        if kind == "board":
            boards.append(await write_board(db, models_dir, root, cid, g.table, pins.get(u)))
        elif u in pins and pins[u] != g.nodes.get(u, {}).get("version"):
            row = await version_of(db, "model", cid, pins[u])
            if row and row.get("source"):
                for n, v in g.table.items():
                    if v == ("model", cid):
                        (Path(models_dir) / f"{n}.py").write_text(row["source"])
    sources = [g.nodes[u].get("source") or "" for u in closure if split(u)[0] == "model"]
    return {"graph": g, "boards": boards, "sources": sources, **against(g, k)}


# ---------------------------------------------------------------- copied numbers

def _number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _telling(v: float) -> bool:
    """A number worth recognising: 1.6 or 95.504 is a measurement, 2 or 10
    could be anything."""
    if not _number(v):
        return False
    v = abs(float(v))
    return v >= 0.5 and (v != int(v) or v >= 20)


def model_exports(source: str) -> dict[str, float]:
    """A model's named numbers: top-level `NAME = 12.5` (and tuples of
    them, as NAME[0]...)."""
    try:
        tree = ast.parse(source or "")
    except SyntaxError:
        return {}
    out: dict[str, float] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for t in node.targets:
            if not isinstance(t, ast.Name) or not t.id.isupper():
                continue
            v = node.value
            if isinstance(v, ast.UnaryOp) and isinstance(v.op, ast.USub) and isinstance(v.operand, ast.Constant):
                v = ast.Constant(-v.operand.value) if _number(v.operand.value) else v
            if isinstance(v, ast.Constant) and _number(v.value):
                out[t.id] = v.value
            elif isinstance(v, ast.Tuple):
                for i, e in enumerate(v.elts):
                    if isinstance(e, ast.Constant) and _number(e.value):
                        out[f"{t.id}[{i}]"] = e.value
    return out


def board_exports(data: dict) -> dict[str, float]:
    out = {"THICKNESS": data.get("thickness")}
    for i, v in enumerate(data.get("size") or []):
        out[f"SIZE[{i}]"] = v
    for i, h in enumerate(data.get("holes") or []):
        out[f"HOLES[{i}].x"], out[f"HOLES[{i}].y"], out[f"HOLES[{i}].d"] = h["x"], h["y"], h["d"]
    for c in data.get("connectors") or []:
        if c.get("height") is not None:
            out[f"CONNECTORS[{c['ref']}].height"] = c["height"]
    return {k: v for k, v in out.items() if _number(v)}


def copied_numbers(source: str, exports: dict[str, dict[str, float]], limit: int = 12) -> list[dict]:
    """Numbers a model writes out that a component it imports already
    names: `1.6` where `B.THICKNESS` is meant. A hint, not a rule - the
    same value can be a coincidence - so it is said, never refused."""
    try:
        tree = ast.parse(source or "")
    except SyntaxError:
        return []
    by_value: dict[float, list[str]] = {}
    for module, names in exports.items():
        for name, v in names.items():
            if _telling(v):
                by_value.setdefault(round(float(v), 4), []).append(f"{module}.{name}")
    if not by_value:
        return []
    lines = (source or "").splitlines()
    out, seen = [], set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Constant) and _telling(node.value)):
            continue
        names = by_value.get(round(float(node.value), 4))
        if not names:
            continue
        line = lines[node.lineno - 1] if 0 < node.lineno <= len(lines) else ""
        if line.lstrip().startswith(("#", "import", "from")):
            continue
        spot = (node.lineno, node.value)
        if spot in seen:
            continue
        seen.add(spot)
        out.append({"line": node.lineno, "value": node.value, "names": names[:3],
                    "text": line.strip()[:120]})
    out.sort(key=lambda r: r["line"])
    return out[:limit]
