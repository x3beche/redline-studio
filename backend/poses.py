"""A part's 3D body pose, corrected for one board.

An LCSC part's 3D model comes seated the way EasyEDA placed it
(backend/modelseat.py), and sometimes that is not the way it is fitted:
a right-angle header comes standing, a TO-220 meant to lie on the board
stands up. The shared footprint in the parts drawer is every board's, so
it is not the place to fix one board's part. The fix lives on the board,
by reference:

    board["poses"] = {"Q5": {"rotate": [90, 0, 0], "offset": [0, 1.785, 2.27],
                             "mirror": None, "part": "C29780637",
                             "why": "...", "by": {actor}, "at": "..."}}

and the placer (docker/place.py, `posed`) writes it into this board's copy
of the footprint every time the board is laid out - packed or held - so
the route, the drawings, the GLB and the STEP all have it, and a rebuild,
a re-seat or a re-conversion does not lose it.

- `rotate` and `offset` REPLACE the model's (the seat is not added to):
  they are measured as the whole answer. KiCad's conventions, as
  modelseat.py says: degrees; mm in the 3D frame, +Y up (the footprint's
  -Y); rotated first, then moved. Either may be left out (None): that one
  stays as the footprint has it.
- `mirror` "x" or "y" flips the footprint's silkscreen and courtyard about
  its own axis ("y": y -> -y), never the pads or the copper - for a body
  that now sticks out the other side of its pins.
- `part` is the LCSC number the numbers were measured on. A pose is only
  applied while the board still uses that part: another part's model
  would be turned by numbers that mean nothing for it. None: whatever
  part the reference has.
"""

from __future__ import annotations

import math
import re

MAX_OFFSET = 100.0           # mm, on any axis
MAX_ANGLE = 360.0            # degrees, either way
MIRRORS = (None, "x", "y")
WHY_MAX = 500
REF = re.compile(r"^[A-Za-z0-9_+\-]{1,40}$")          # no ".", "$", "/": a key, a path
PART = re.compile(r"^C\d{1,12}$")


class PoseError(ValueError):
    """What is wrong with a pose, every problem named."""

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


def _triple(name: str, value, limit: float, unit: str, problems: list[str]):
    if value is None:
        return None
    if isinstance(value, str):
        value = [v for v in re.split(r"[,\s]+", value.strip()) if v]
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        problems.append(f"{name}: three numbers, x y z")
        return None
    out = []
    for axis, v in zip("xyz", value):
        try:
            f = float(v)
        except (TypeError, ValueError):
            problems.append(f"{name}.{axis}: {v!r} is not a number")
            continue
        if isinstance(v, bool) or not math.isfinite(f):
            problems.append(f"{name}.{axis}: {v!r} is not a finite number")
        elif abs(f) > limit:
            problems.append(f"{name}.{axis}: {f:g} {unit} is past ±{limit:g} {unit}")
        else:
            out.append(round(f, 4) + 0.0)
    return out if len(out) == 3 else None


def check(ref: str, body: dict, parts: dict[str, str | None] | None) -> dict:
    """The pose to keep for `ref`, cleaned - or PoseError listing every
    problem. `parts` is the board's ref -> LCSC number from its build (None
    when the board has not been built: then no ref can be checked)."""
    problems: list[str] = []
    ref = (ref or "").strip()
    if not REF.match(ref):
        problems.append(f"ref: {ref!r} is not a reference designator")
    elif parts is None:
        problems.append("the board has no build yet - run it first, so its parts are known")
    elif ref not in parts:
        near = sorted(r for r in parts if r.upper().startswith(ref[:1].upper()))[:12]
        problems.append(f"ref: no part {ref} on this board"
                        + (f" (it has {', '.join(near)})" if near else ""))
    rotate = _triple("rotate", body.get("rotate"), MAX_ANGLE, "deg", problems)
    offset = _triple("offset", body.get("offset"), MAX_OFFSET, "mm", problems)
    mirror = body.get("mirror")
    if isinstance(mirror, str):
        mirror = mirror.strip().lower() or None
        if mirror in ("none", "off", "no"):
            mirror = None
    if mirror not in MIRRORS:
        problems.append(f"mirror: {mirror!r} - x, y or none")
    if body.get("rotate") is None and body.get("offset") is None and not mirror:
        problems.append("say what to change: rotate, offset or mirror")
    part = (body.get("part") or "").strip().upper() or None
    if part and not PART.match(part):
        problems.append(f"part: {part!r} is not an LCSC number (C12345)")
    why = str(body.get("why") or "").strip()
    if problems:
        raise PoseError(problems)
    return {"rotate": rotate, "offset": offset, "mirror": mirror,
            "part": part or (parts or {}).get(ref), "why": why[:WHY_MAX]}


def for_plan(poses: dict | None, components: list[dict]) -> tuple[dict, dict]:
    """The poses the placer applies - only those whose part is still the
    one the board has - and the rest, with why they are left out."""
    have = {c.get("ref"): c.get("part") for c in components or []}
    use, left = {}, {}
    for ref, pose in sorted((poses or {}).items()):
        if not isinstance(pose, dict):
            continue
        if ref not in have:
            left[ref] = "not on the board any more"
        elif pose.get("part") and have[ref] and pose["part"] != have[ref]:
            left[ref] = (f"measured on {pose['part']}, the board now has {have[ref]} "
                         "- set it again for this part")
        else:
            use[ref] = {k: pose.get(k) for k in ("rotate", "offset", "mirror")}
    return use, left


def describe(ref: str, pose: dict) -> str:
    """One line for a log or a terminal."""
    def xyz(v):
        return ",".join(f"{x:g}" for x in v) if v else "as the footprint has it"
    out = f"{ref}"
    if pose.get("part"):
        out += f" ({pose['part']})"
    out += f": rotate {xyz(pose.get('rotate'))}, offset {xyz(pose.get('offset'))}"
    if pose.get("mirror"):
        out += f", silk/courtyard mirrored in {pose['mirror']}"
    if pose.get("why"):
        out += f" - {pose['why']}"
    return out
