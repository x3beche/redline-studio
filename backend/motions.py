"""Motions in a 3D model: parts that move in the viewer.

A model can say which of its parts move and how, next to PARTS:

    MOTIONS = {
        # turns all the time, about `axis` through `pivot`, at `spin` rpm
        "Fan":  {"part": "Fan Module 80/Fan rotor", "spin": 900,
                 "axis": (0, -1, 0), "pivot": (0, 0, 40)},
        # set by hand in the viewer, degrees, inside `range`; `default` is
        # the angle the model is built at (its parts are drawn there)
        "Tilt": {"part": ["Fan Module 80/Fan housing", "Fan Module 80/Fan rotor"],
                 "range": (-18, 18), "default": -18,
                 "axis": (1, 0, 0), "pivot": (0, 0, 40)},
        # a cable bent by a range motion: drawn live as a tube along the
        # centre line it has at that motion's value
        "Cable": {"part": "Fan Module 80/Fan cable (loop)", "follows": "Tilt",
                  "radius": 1.0, "paths": {-18: [(x, y, z), ...], 0: [...], 18: [...]}},
    }

- `part`: a path in the viewer's tree as the tree shows it ("Fan Module
  80/Fan rotor"; the root's name may be left out), or the part's own name
  ("Fan rotor") when only one node has it, or a list of them. A node
  moves with everything under it.
- `axis` / `pivot`: the model's world frame, mm, at the default pose (the
  pose the model is built in). Rotation is right-handed about `axis`.
- A motion whose part is inside (or is) a part of another motion rides on
  it: the fan spins about its axis as the tilt carries it. `"on": "Tilt"`
  says so explicitly.
- A flexible part (`follows`) is redrawn as a tube while the motion it
  follows is away from its default; at the default the model's own part
  is shown. Its centre line comes from `paths` (value -> points, world mm,
  the same number of points at every value, interpolated in between) or,
  without them, from its two ends: `"from": {"at": p, "dir": d}` (carried
  by the motion it follows), `"to": {"at": p, "dir": d}` (fixed) and its
  `length` - a curve leaving and entering along `dir` (the direction the
  cable runs, from -> to) whose length is kept.

A motion is visual only: nothing checks that moving parts do not collide.
The model as built (the default pose) stays the truth for printing.

What an imported model declares stays its own: an assembly gets the
motions it declares itself (its sub-models' would be in another frame and
another tree).

`check` validates the declaration against the tree the build produced
and returns it in the form the page reads (export_model.py puts it in the
viewer payload as `motions`). Stdlib only.
"""

from __future__ import annotations

import difflib
import math

MAX_SAMPLES = 400            # values in a flexible part's `paths`
MAX_POINTS = 4000            # points in one of them
KINDS = ("spin", "range", "flex")


class MotionError(ValueError):
    pass


def tree_paths(shapes: dict) -> list[str]:
    """Every node's path in the viewer's tree, "/Root/Group/part"."""
    out: list[str] = []

    def walk(node, prefix):
        path = f"{prefix}/{node.get('name')}"
        out.append(path)
        for kid in node.get("parts") or []:
            walk(kid, path)
    if isinstance(shapes, dict) and shapes.get("name") is not None:
        walk(shapes, "")
    return out


def _num(name: str, what: str, x) -> float:
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
        raise MotionError(f"MOTIONS[{name!r}]: {what} must be a finite number, got {x!r}")
    return float(x)


def _vec(name: str, what: str, v, unit: bool = False) -> list[float]:
    if not isinstance(v, (list, tuple)) or len(v) != 3:
        raise MotionError(f"MOTIONS[{name!r}]: {what} must be (x, y, z), got {v!r}")
    out = [_num(name, what, c) for c in v]
    if unit:
        n = math.sqrt(sum(c * c for c in out))
        if n < 1e-9:
            raise MotionError(f"MOTIONS[{name!r}]: {what} is zero")
        out = [c / n for c in out]
    return out


def _path(name: str, raw, paths: list[str]) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise MotionError(f"MOTIONS[{name!r}]: part must be a path in the tree, got {raw!r}")
    have = set(paths)
    root = paths[0] if paths else "/"
    p = raw.strip()
    tries = [p] if p.startswith("/") else [f"{root}/{p}", f"/{p}"]
    for t in tries:
        if t in have:
            return t
    # A part's own name ("Fan rotor"), or the end of its path, when exactly
    # one node in the tree has it: the model need not spell out the groups
    # its components make (backend/assembly.py).
    tail = [q for q in paths if q.endswith("/" + p.lstrip("/"))]
    if len(tail) == 1:
        return tail[0]
    if len(tail) > 1:
        raise MotionError(f"MOTIONS[{name!r}]: part {raw!r} is {len(tail)} nodes in the tree "
                          f"({', '.join(tail[:4])}); give more of its path")
    near = difflib.get_close_matches(tries[0], paths, n=3, cutoff=0.5)
    hint = f"; did you mean {', '.join(repr(n) for n in near)}?" if near else ""
    raise MotionError(f"MOTIONS[{name!r}]: no part {raw!r} in the tree{hint}")


def _parts(name: str, spec: dict, paths: list[str]) -> list[str]:
    raw = spec.get("part")
    items = raw if isinstance(raw, (list, tuple)) else [raw]
    if not items:
        raise MotionError(f"MOTIONS[{name!r}]: part is empty")
    out = []
    for r in items:
        p = _path(name, r, paths)
        if p not in out:
            out.append(p)
    return out


def _under(a: str, b: str) -> bool:
    """`a` is `b` or inside it."""
    return a == b or a.startswith(b + "/")


def _end(name: str, what: str, raw) -> dict:
    if not isinstance(raw, dict):
        raise MotionError(f"MOTIONS[{name!r}]: {what} must be {{'at': (x, y, z), 'dir': (dx, dy, dz)}}")
    return {"at": _vec(name, f"{what}.at", raw.get("at")),
            "dir": _vec(name, f"{what}.dir", raw.get("dir"), unit=True)}


def check(motions, shapes: dict) -> list[dict]:
    """The declared MOTIONS, validated against the tree, as the page reads
    them: [{name, kind, parts, axis, pivot, ...}], parents before children.
    Raises MotionError with what is wrong."""
    if motions is None:
        return []
    if not isinstance(motions, dict):
        raise MotionError(f"MOTIONS must be a dict of name -> motion, got {type(motions).__name__}")
    paths = tree_paths(shapes)
    out: dict[str, dict] = {}
    for name, spec in motions.items():
        if not isinstance(name, str) or not name.strip():
            raise MotionError(f"MOTIONS: a motion's name must be text, got {name!r}")
        if not isinstance(spec, dict):
            raise MotionError(f"MOTIONS[{name!r}] must be a dict")
        kinds = [k for k, key in (("spin", "spin"), ("range", "range"), ("flex", "follows")) if key in spec]
        if len(kinds) != 1:
            raise MotionError(f"MOTIONS[{name!r}]: say exactly one of 'spin' (rpm), 'range' (degrees) "
                              f"or 'follows' (a flexible part), not {kinds or 'none'}")
        kind = kinds[0]
        m: dict = {"name": name, "kind": kind, "parts": _parts(name, spec, paths)}
        if spec.get("label") is not None:
            m["label"] = str(spec["label"])
        if kind in ("spin", "range"):
            m["axis"] = _vec(name, "axis", spec.get("axis"), unit=True)
            m["pivot"] = _vec(name, "pivot", spec.get("pivot"))
            on = spec.get("on")
            if on is not None and not isinstance(on, str):
                raise MotionError(f"MOTIONS[{name!r}]: on must be another motion's name")
            m["on"] = on
        if kind == "spin":
            rpm = _num(name, "spin", spec["spin"])
            if rpm == 0 or abs(rpm) > 100000:
                raise MotionError(f"MOTIONS[{name!r}]: spin is rpm, not zero and at most 100000, got {rpm}")
            m["rpm"] = rpm
        elif kind == "range":
            r = spec["range"]
            if not isinstance(r, (list, tuple)) or len(r) != 2:
                raise MotionError(f"MOTIONS[{name!r}]: range must be (low, high) in degrees, got {r!r}")
            lo, hi = _num(name, "range", r[0]), _num(name, "range", r[1])
            if not lo < hi or hi - lo > 720:
                raise MotionError(f"MOTIONS[{name!r}]: range ({lo}, {hi}) must be low < high, at most 720 degrees")
            d = _num(name, "default", spec.get("default", 0.0 if lo <= 0 <= hi else lo))
            if not lo - 1e-9 <= d <= hi + 1e-9:
                raise MotionError(f"MOTIONS[{name!r}]: default {d} is outside the range ({lo}, {hi})")
            m["range"], m["default"] = [lo, hi], d
        else:
            if len(m["parts"]) != 1:
                raise MotionError(f"MOTIONS[{name!r}]: a flexible part is one part")
            m["follows"] = spec["follows"]
            m["radius"] = _num(name, "radius", spec.get("radius"))
            if m["radius"] <= 0:
                raise MotionError(f"MOTIONS[{name!r}]: radius must be > 0")
            if "paths" in spec:
                m["path"] = _samples(name, spec["paths"])
            else:
                m["from"] = _end(name, "from", spec.get("from"))
                m["to"] = _end(name, "to", spec.get("to"))
                m["length"] = _num(name, "length", spec.get("length"))
        out[name] = m

    # What rides on what: said with `on`, or found from the tree.
    for name, m in out.items():
        if m["kind"] == "flex":
            f = out.get(m["follows"])
            if f is None or f["kind"] != "range":
                raise MotionError(f"MOTIONS[{name!r}]: follows {m['follows']!r}, which is not a range motion here")
            if "path" in m:
                lo, hi = f["range"]
                vals = m["path"]["values"]
                if vals[0] > lo + 1e-6 or vals[-1] < hi - 1e-6:
                    raise MotionError(f"MOTIONS[{name!r}]: paths cover {vals[0]}..{vals[-1]}, "
                                      f"not all of {m['follows']}'s range {lo}..{hi}")
            else:
                gap = math.dist(m["from"]["at"], m["to"]["at"])
                if m["length"] < gap - 1e-6:
                    raise MotionError(f"MOTIONS[{name!r}]: length {m['length']} is shorter than "
                                      f"the {gap:.2f} mm between its ends")
            continue
        if m["on"] is not None:
            p = out.get(m["on"])
            if p is None or p["kind"] == "flex" or m["on"] == name:
                raise MotionError(f"MOTIONS[{name!r}]: on {m['on']!r} is not another rigid motion here")
            continue
        holders = [o for o, q in out.items() if o != name and q["kind"] != "flex"
                   and all(any(_under(a, b) for b in q["parts"]) for a in m["parts"])
                   and not all(any(_under(b, a) for a in m["parts"]) for b in q["parts"])]
        if not holders:
            # Same parts both ways: the one that is not a spin holds.
            holders = [o for o, q in out.items() if o != name and q["kind"] == "range" and m["kind"] == "spin"
                       and all(any(_under(a, b) for b in q["parts"]) for a in m["parts"])]
        # The innermost holder: the one the others hold.
        if holders:
            holders.sort(key=lambda o: -min(len(p) for p in out[o]["parts"]))
            m["on"] = holders[0]
    for name in out:
        seen, at = [name], out[name].get("on")
        while at is not None:
            if at in seen:
                raise MotionError(f"MOTIONS: {' -> '.join([*seen, at])} goes round in a circle")
            seen.append(at)
            at = out[at].get("on")

    # Parents first: a child's transform is built on its parent's.
    def depth(n):
        d, at = 0, out[n].get("on") if out[n]["kind"] != "flex" else out[n]["follows"]
        while at is not None:
            d, at = d + 1, out[at].get("on")
        return d
    return [out[n] for n in sorted(out, key=lambda n: (depth(n), list(out).index(n)))]


def _samples(name: str, raw) -> dict:
    if not isinstance(raw, dict) or len(raw) < 2:
        raise MotionError(f"MOTIONS[{name!r}]: paths must be {{value: [(x, y, z), ...]}} at two values at least")
    if len(raw) > MAX_SAMPLES:
        raise MotionError(f"MOTIONS[{name!r}]: {len(raw)} paths, at most {MAX_SAMPLES}")
    items = sorted(((_num(name, "a paths value", k), v) for k, v in raw.items()), key=lambda e: e[0])
    count = None
    values, points = [], []
    for k, pts in items:
        if not isinstance(pts, (list, tuple)) or len(pts) < 2:
            raise MotionError(f"MOTIONS[{name!r}]: the path at {k} needs two points at least")
        if len(pts) > MAX_POINTS:
            raise MotionError(f"MOTIONS[{name!r}]: the path at {k} has {len(pts)} points, at most {MAX_POINTS}")
        if count is not None and len(pts) != count:
            raise MotionError(f"MOTIONS[{name!r}]: the path at {k} has {len(pts)} points, the others {count}"
                              " - every path needs the same number to be blended")
        count = len(pts)
        if values and k - values[-1] < 1e-9:
            raise MotionError(f"MOTIONS[{name!r}]: paths value {k} twice")
        values.append(k)
        points.append([[round(c, 4) for c in _vec(name, f"paths[{k}]", p)] for p in pts])
    return {"values": values, "points": points}
