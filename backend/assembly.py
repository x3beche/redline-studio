"""Every component a model uses is one node in its 3D tree.

An assembly says `import base` and puts `base.PARTS` (moved, relabelled)
into its own PARTS. The viewer used to get that as one flat list - 48
solids under "Group", the station's base and fan module indistinguishable
except by a name prefix - so hiding the base meant 30 clicks. Here, during
the build (export_model.py, in the build's own process), every shape a
component module hands out is marked with where it came from, and the
model's PARTS is turned into a tree from those marks:

    Station
      Base
        Enclosure            govde
        Lid                  kapak
        Silicone Foot x4     ayak_1 .. ayak_4
        Screw M3 countersunk x4
        18650 Cell           pil_kovan, pil_kilif, pil_arti_kutup
        kart                 the board, as it always was
      Fan Module
        Fan 120 mm
        Pivot Pin x2
        ...

No model source changes. How a shape gets its mark (`TAG`: one
(module, key, title, size) entry per component it passed through,
outermost first):

- when a component module has finished importing (run, or filled from the
  component cache - backend/buildcache.py), each shape in its PARTS gets
  (module, key) put in front of the marks it already has, and every other
  unmarked shape among its module-level names gets (module, name);
- what its top-level functions return (`screw_m3.screw(10)`,
  `fan_cable.make(...)`) and what its module `__getattr__` hands out
  lazily (a board's `B.part`) is marked the same way;
- the mark is an attribute, so it travels with the copies build123d makes
  (`Pos(...) * part`, `moved`, `located`, `copy`), and a boolean keeps the
  mark of the shape it was done to (`screen -= lid` is still the OLED).
  A shape made fresh (`extrude`, `Box`, `Compound(children=...)`) is the
  model's own.

The key says which part of the component a shape is, so the copies can be
counted: four feet are four copies of `foot_bumper`'s one part (four
instances, "Silicone Foot x4"), a fan is ten different parts of `fan_120`
once (one instance). The marks are kept with a component's cached result
(they are an attribute, and the cache keeps a shape's attributes), and
this file's text is part of the cache's key (buildcache.runtime), so a
change here invalidates the entries once.

Stdlib only at import time, like buildcache: build123d is imported when
the build first needs it.
"""

from __future__ import annotations

import functools
import sys
import types
from collections import Counter
from pathlib import Path

# The mark: ((module, key, title, size), ...), outermost first. The title
# and the size of the component's PARTS travel with it: a component served
# from the cache inside another one is never imported, so they could not be
# looked up at the end.
TAG = "_redline_from"
TIMES = "\u00d7"             # "Screw M3 countersunk \u00d74"


def _shape_cls():
    from build123d.topology.shape_core import Shape
    return Shape


def tag_of(shape) -> tuple:
    return tuple(getattr(shape, TAG, None) or ())


def claim(shape, module: str, key: str, info: tuple = ()) -> None:
    """Put (module, key, *info) in front of the shape's marks - unless it
    already says it comes from `module` (claimed twice, or handed out twice)."""
    tag = tag_of(shape)
    if tag and tag[0][0] == module:
        return
    setattr(shape, TAG, ((module, key, *info), *tag))


def mark_new(shape, module: str, key: str, info: tuple = ()) -> None:
    """Mark a shape that has no mark yet; one that has is somebody else's."""
    if not tag_of(shape):
        setattr(shape, TAG, ((module, key, *info),))


def _shapes_in(value, key: str, depth: int = 2):
    """(key, shape) for a value: a shape, or shapes in lists, tuples and
    dicts a couple of levels down - PARTS, `feet = [...]`, `{"a": shape}`."""
    Shape = _shape_cls()
    if isinstance(value, Shape):
        yield key, value
    elif depth > 0 and isinstance(value, (list, tuple)):
        for i, x in enumerate(value):
            yield from _shapes_in(x, f"{key}[{i}]", depth - 1)
    elif depth > 0 and isinstance(value, dict):
        for k, x in value.items():
            yield from _shapes_in(x, f"{key}[{k!r}]", depth - 1)


def _claim_result(module: str, key: str, value, info: tuple = ()) -> None:
    """What a component's function or lazy name handed out is its output."""
    Shape = _shape_cls()
    if isinstance(value, Shape):
        claim(value, module, key, info)
    elif isinstance(value, (list, tuple)):
        for i, x in enumerate(value):
            if isinstance(x, Shape):
                claim(x, module, f"{key}#{i}", info)


class Marker:
    """The import hook: a meta path finder in front of the others (the
    component cache's included) that lets them find and load a model module
    and marks what it made once it has loaded."""

    def __init__(self, names: set[str]):
        self.names = set(names)           # model and board modules a build can import
        self.adopted: dict[int, types.ModuleType] = {}
        self.titles: dict[str, str] = {}
        self.sizes: dict[str, int] = {}   # how many parts a component's PARTS has

    # -- import machinery
    def find_spec(self, fullname, path=None, target=None):
        if path is not None or fullname not in self.names or fullname in sys.modules:
            return None
        spec = None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(fullname, path, target)
            if spec is not None:
                break
        if spec is None or spec.loader is None or not hasattr(spec.loader, "exec_module"):
            return spec
        loader = spec.loader
        if not getattr(loader, "_redline_marks", False):
            run = loader.exec_module

            def exec_module(module, _run=run):
                _run(module)
                self.adopt(module)
            loader.exec_module = exec_module
            loader._redline_marks = True
        return spec

    def invalidate_caches(self):
        pass

    # -- marking
    def adopt(self, module) -> None:
        # An alias module (`sys.modules[__name__] = import_module(main)`)
        # is its main module, which was adopted when it was imported.
        real = sys.modules.get(module.__name__, module)
        if id(real) in self.adopted:
            return
        self.adopted[id(real)] = real
        name = real.__name__
        title = real.__dict__.get("TITLE")
        self.titles[name] = title if isinstance(title, str) and title.strip() else name
        self._size(real)
        try:
            self.scan(real)
        except Exception as exc:                        # noqa: BLE001 - a build never fails over this
            print(f"note: {name}: parts not grouped ({type(exc).__name__}: {exc})", file=sys.stderr)

    def _size(self, module) -> None:
        parts = module.__dict__.get("PARTS")
        if isinstance(parts, (list, tuple)):
            self.sizes[module.__name__] = len(parts)
        elif "Generated by Redline" in (module.__dict__.get("__doc__") or ""):
            self.sizes[module.__name__] = 1          # a board: PARTS = [part], lazily

    def info(self, name: str) -> tuple:
        return (self.titles.get(name) or name, self.sizes.get(name))

    def scan(self, module) -> None:
        name = module.__name__
        ns = module.__dict__
        # Its output first: PARTS is what an assembly takes from it.
        if "PARTS" in ns:
            for key, s in _shapes_in(ns["PARTS"], "PARTS", 1):
                claim(s, name, key, self.info(name))
        for k, v in list(ns.items()):
            if k.startswith("__") or k == "PARTS" or isinstance(v, types.ModuleType):
                continue
            for key, s in _shapes_in(v, k):
                mark_new(s, name, key, self.info(name))
        for k, v in list(ns.items()):
            if (isinstance(v, types.FunctionType) and not k.startswith("__")
                    and getattr(v, "__module__", None) == name
                    and not getattr(v, "_redline_marks", False)):
                ns[k] = self._wrap(name, v)
        lazy = ns.get("__getattr__")
        if callable(lazy) and not getattr(lazy, "_redline_marks", False):
            ns["__getattr__"] = self._wrap_lazy(module, lazy)

    def _wrap(self, module: str, fn):
        @functools.wraps(fn)
        def marked(*args, **kwargs):
            out = fn(*args, **kwargs)
            try:
                _claim_result(module, f"{fn.__name__}()", out, self.info(module))
            except Exception:                           # noqa: BLE001
                pass
            return out
        marked._redline_marks = True
        return marked

    def _wrap_lazy(self, module, lazy):
        name = module.__name__

        def __getattr__(attr):
            out = lazy(attr)
            try:
                if attr == "PARTS" and isinstance(out, (list, tuple)):
                    self.sizes[name] = len(out)
                _claim_result(name, attr, out, self.info(name))
                # A name the component cache did not keep ran the module's
                # source again, in place: what it made is unmarked.
                self.scan(module)
            except Exception:                           # noqa: BLE001
                pass
            return out
        __getattr__._redline_marks = True
        return __getattr__


_BOOL_PATCHED = False


def keep_marks_through_booleans() -> None:
    """A shape cut or joined is still the shape it was: `screen -= lid`
    keeps the OLED's mark. build123d hands a boolean's result the operand's
    attributes (label, colour...) with `copy_attributes_to`, but only those
    both sides already have, which a mark never is; this adds it."""
    global _BOOL_PATCHED
    if _BOOL_PATCHED:
        return
    from build123d.topology.shape_core import Shape
    original = Shape.copy_attributes_to

    @functools.wraps(original)
    def copy_attributes_to(self, target, exceptions=None):
        original(self, target, exceptions)
        tag = getattr(self, "__dict__", {}).get(TAG)
        if tag and target is not self and not getattr(target, TAG, None) \
                and TAG not in set(exceptions or ()):
            try:
                setattr(target, TAG, tag)
            except Exception:                           # noqa: BLE001
                pass
    Shape.copy_attributes_to = copy_attributes_to
    _BOOL_PATCHED = True


def install(models_dir: Path, target: str | None = None) -> Marker:
    """Mark what the build directory's model modules make (export_model.py,
    after the component cache is installed, before the model is loaded)."""
    names = {p.stem for p in Path(models_dir).glob("*.py") if p.stem.isidentifier()}
    names.discard(target or "")
    marker = Marker(names)
    sys.meta_path.insert(0, marker)
    try:
        keep_marks_through_booleans()
    except Exception as exc:                            # noqa: BLE001
        print(f"note: booleans do not keep part marks ({exc})", file=sys.stderr)
    return marker


# ---------------------------------------------------------------- the tree

def _about(entry: tuple, titles: dict, sizes: dict) -> tuple[str, int | None]:
    """A mark's component title and PARTS size: from the mark, else as the
    build saw the module."""
    m = entry[0]
    title = entry[2] if len(entry) > 2 and entry[2] else titles.get(m) or m
    size = entry[3] if len(entry) > 3 and entry[3] is not None else sizes.get(m)
    return str(title), size


def tree(parts: list, names: list, title: str, titles: dict | None = None,
         sizes: dict | None = None):
    """The model's PARTS as a labelled Compound tree, one node per
    component instance (by the marks above); None when no part came from a
    component, so a plain part is exported exactly as before.

    Leaves are the parts themselves, labelled with NAMES; a node holds what
    one component contributed, its own components nested inside it. Several
    copies of one component are "Title xN" holding each copy - the part
    itself when a copy is one part, "Title i" when it is several.

    Which shapes are one copy: the n-th shape made from a part of the
    component (by its key) is in the n-th copy. A component whose PARTS is
    one part (`sizes`) has every shape from it a copy of its own, whether it
    came from PARTS or from a function (`screw.part`, `screw.make(8)`)."""
    from build123d import Compound
    titles = titles or {}
    sizes = sizes or {}
    marks = [tag_of(p) for p in parts]
    if not any(marks):
        return None
    seen: set[int] = set()
    items = []
    for p, n, tag in zip(parts, names, marks):
        if id(p) in seen:                 # one object twice: a node holds it once
            import copy
            p = copy.copy(p)
            setattr(p, TAG, tag)
        seen.add(id(p))
        items.append((tag, p, str(n)))

    def leaf(item):
        _, p, n = item
        p.label = n
        return p

    def build(members: list, level: int) -> list:
        out: list = []                     # in the order things first appear
        groups: dict[str, list] = {}
        for it in members:
            tag = it[0]
            if len(tag) <= level:
                out.append(("leaf", it))
                continue
            m = tag[level][0]
            if m not in groups:
                groups[m] = []
                out.append(("group", m))
            groups[m].append(it)
        kids = []
        for kind, x in out:
            if kind == "leaf":
                kids.append(leaf(x))
                continue
            m, got = x, groups[x]
            # The n-th copy of a part belongs to the n-th instance.
            name, size = _about(got[0][0][level], titles, sizes)
            count: Counter = Counter()
            inst: dict[int, list] = {}
            for n, it in enumerate(got):
                k = it[0][level][1]
                inst.setdefault(n if size == 1 else count[k], []).append(it)
                count[k] += 1
            if len(inst) == 1:
                kids.append(Compound(label=name, children=build(inst[0], level + 1)))
                continue
            copies = []
            for i in sorted(inst):
                one = inst[i]
                if len(one) == 1 and len(one[0][0]) == level + 1:
                    copies.append(leaf(one[0]))
                else:
                    copies.append(Compound(label=f"{name} {i + 1}", children=build(one, level + 1)))
            kids.append(Compound(label=f"{name} {TIMES}{len(inst)}", children=copies))
        return kids

    return Compound(label=title, children=build(items, 0))
