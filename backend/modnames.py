"""Which model `import lid` means - one rule, for the build and the graph.

Every model has a module of its own in a build, named after its whole id
(`iot-fan/parts/lid` is `iot_fan__parts__lid`: `/` as `__`, anything else
that is not a letter, digit or `_` as `_`). That name always imports that
model, from anywhere.

A model is also imported by its bare name (`import lid`), and which model
that is depends on who imports it. For a model whose id is in top folder P
(the project: `iot-fan` for `iot-fan/assemblies/station`):

1. exactly one model in P has that bare name: that one;
2. else exactly one model in the whole workspace has it: that one (the
   80 mm station importing iot-fan's OLED);
3. else a model whose whole-id module name it is (`import stand` for a
   model `stand` at the top);
4. else, with several candidates, it does not resolve: the build stops
   with an error naming them and the line that imports one explicitly.

Resolution is per importing module, never per build: iot-fan-80mm's
station imports iot-fan's `module_dock`, and module_dock's own `import lid`
is iot-fan's lid. The build process (export_model.py) gets this from
`install()`: `builtins.__import__` (and `importlib.import_module`) send a
bare model name, imported from a model module, to the module the rule
picks - nothing is bound as `sys.modules["lid"]`, so no importer sees
another's answer. backend/links.py (the graph, the code view's table) and
backend/buildcache.py (whose keys name the modules each import resolved
to) read the same `Names`.

Stdlib only: the build subprocess imports this before build123d.
"""

from __future__ import annotations

import builtins
import collections
import hashlib
import importlib
import json
import re
import sys
from pathlib import Path

MANIFEST = "_modules.json"        # in a build's models directory: every model id and bare name


def project(model_id: str) -> str:
    """The top folder a model is in ("" for one at the top)."""
    return model_id.split("/", 1)[0] if "/" in model_id else ""


def bare(model_id: str, name: str | None = None) -> str:
    return name or model_id.rpartition("/")[2]


def _ident(model_id: str) -> str:
    s = re.sub(r"\W", "_", model_id.replace("/", "__"), flags=re.ASCII)
    return ("_" + s) if not s or s[:1].isdigit() else s


def module_names(ids) -> dict[str, str]:
    """Model id -> its whole-id module name, unique: two ids that read the
    same (`a-b/x`, `a_b/x`) each get a few characters of their hash."""
    base = {i: _ident(i) for i in ids}
    count = collections.Counter(base.values())
    return {i: (q if count[q] == 1 else f"{q}_{hashlib.sha256(i.encode()).hexdigest()[:6]}")
            for i, q in base.items()}


class Ambiguous(ImportError):
    """A bare name with more than one model it could be."""

    def __init__(self, name: str, importer: str | None, candidates: list[str],
                 modules: dict[str, str]):
        self.candidates = candidates
        where = f" in {importer}" if importer else ""
        scope = (f"{len(candidates)} models in {project(importer)}/" if importer and
                 all(project(c) == project(importer) for c in candidates)
                 else f"{len(candidates)} models")
        lines = ", ".join(f"`import {modules[c]} as {name}` ({c})" for c in candidates)
        super().__init__(
            f"`import {name}`{where} is ambiguous: {scope} are called {name} "
            f"({', '.join(candidates)}). Import the one you mean by its full name: {lines}",
            name=name)


class Names:
    """The models of a workspace, as import names."""

    def __init__(self, models):
        """`models`: (id, bare name) pairs, or ids."""
        pairs = [(m, bare(m)) if isinstance(m, str) else (str(m[0]), bare(str(m[0]), m[1]))
                 for m in models]
        self.bare_of = dict(pairs)
        self.module = module_names(self.bare_of)            # id -> whole-id module name
        self.model_of = {q: i for i, q in self.module.items()}
        self.by_bare: dict[str, list[str]] = collections.defaultdict(list)
        for i, b in sorted(pairs):
            self.by_bare[b].append(i)

    @classmethod
    def from_docs(cls, docs) -> "Names":
        return cls([(str(d["_id"]), d.get("name")) for d in docs])

    def candidates(self, name: str, importer: str | None = None) -> list[str]:
        ids = self.by_bare.get(name) or []
        if importer is not None:
            local = [i for i in ids if project(i) == project(importer)]
            if local:
                return local
        return list(ids)

    def resolve(self, name: str, importer: str | None = None) -> str | None:
        """The model id `import name` means in `importer`, or None when it
        names no model. Raises Ambiguous."""
        ids = self.by_bare.get(name)
        if ids:
            local = [i for i in ids if project(i) == project(importer)] \
                if importer is not None else []
            if len(local) == 1:
                return local[0]
            if len(local) > 1:
                raise Ambiguous(name, importer, local, self.module)
            if len(ids) == 1:
                return ids[0]
        if name in self.model_of:
            return self.model_of[name]
        if ids:
            raise Ambiguous(name, importer, self.candidates(name, importer), self.module)
        return None

    def module_for(self, name: str, importer: str | None = None) -> str | None:
        """The module `import name` loads in `importer`: a model's whole-id
        module, or None when it is not a model's name."""
        mid = self.resolve(name, importer)
        return self.module[mid] if mid is not None else None

    def manifest(self) -> str:
        return json.dumps({"models": sorted(self.bare_of.items())})


def read(models_dir: Path) -> Names | None:
    """The build directory's names (backend/build.py writes them), or None
    for a directory without them (tests, a hand-made one)."""
    p = Path(models_dir) / MANIFEST
    try:
        return Names([tuple(x) for x in json.loads(p.read_text())["models"]])
    except (OSError, ValueError, KeyError, TypeError):
        return None


# ---------------------------------------------------------------- the import hook

class Hook:
    """Bare model names to the module the importer's project means."""

    def __init__(self, names: Names, extra: dict[str, str] | None = None):
        self.names = names
        self.bares = frozenset(names.by_bare)
        # Module name -> model id: every model's own, and whatever else a
        # model runs as (export_model.py loads its target as model_<flat>).
        self.ids = {q: i for i, q in names.module.items()}
        self.ids.update(extra or {})
        self.original = builtins.__import__
        self.original_import_module = importlib.import_module

    def route(self, name: str, g) -> str | None:
        importer = self.ids.get(g.get("__name__")) if g else None
        if importer is None or name in sys.stdlib_module_names:
            return None
        return self.names.module_for(name, importer)

    def __import__(self, name, globals=None, locals=None, fromlist=(), level=0):
        if level == 0 and name in self.bares:
            real = self.route(name, globals if globals is not None else sys._getframe(1).f_globals)
            if real is not None:
                name = real
        return self.original(name, globals, locals, fromlist, level)

    def import_module(self, name, package=None):
        if name in self.bares:
            real = self.route(name, sys._getframe(1).f_globals)
            if real is not None:
                name = real
        return self.original_import_module(name, package)


_HOOK: Hook | None = None


def install(models_dir: Path, extra: dict[str, str] | None = None) -> Hook | None:
    """Route bare model imports in this process (export_model.py, before
    any model runs). None without a manifest: names are files, as they are."""
    global _HOOK
    names = read(models_dir)
    if names is None:
        return None
    hook = Hook(names, extra)
    builtins.__import__ = hook.__import__
    importlib.import_module = hook.import_module
    _HOOK = hook
    return hook


def resolver(models_dir: Path):
    """For backend/buildcache.py's keys: (importing module, imported name)
    -> the module that import loads. Identity without a manifest."""
    names = read(models_dir)
    if names is None:
        return lambda importer, name: name
    ids = {q: i for i, q in names.module.items()}

    def resolve(importer: str, name: str) -> str:
        mid = ids.get(importer)
        if mid is None or name not in names.by_bare or name in sys.stdlib_module_names:
            return name
        return names.module_for(name, mid) or name
    return resolve
