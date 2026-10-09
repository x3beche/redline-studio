"""Place a netlist onto a board, using KiCad's own writer.

Runs inside the KiCad container, never on the machine. It is given a plan
on stdin - components with a footprint file each, and the nets between
them - and it writes a .kicad_pcb with KiCad's own library code, which is
the only thing that agrees with KiCad about the format.

Hand-writing that file was the first attempt and it is a bad idea: the
board is rejected whole, with "Failed to load board" and no line number,
and the difference between a footprint in a library and the same
footprint in a board is not written down anywhere obvious.

    plan = {
      "out": "/work/board.kicad_pcb",
      "gap": 0.8, "margin": 1.0, "block_gap": 1.0,
      "components": [{"ref": "R1", "footprint": "/work/fp/R0402.kicad_mod",
                      "value": "10k"}],
      "nets": [{"name": "vcc", "nodes": [{"ref": "R1", "pin": "1"}]}]
    }
"""

import hashlib
import json
import math
import os
import re
import struct
import subprocess
import sys
import uuid as uuids
from pathlib import Path

import pcbnew

MM = 1_000_000                      # KiCad works in nanometres


def discard(container, item) -> None:
    """Take an item off a board or a footprint and let KiCad free it.
    `Remove()` hands it to its Python wrapper instead, and the wrapper,
    collected, leaves KiCad 9's bindings without their types: everything
    asked for after it is a bare SwigPyObject (docker/route.py, discard)."""
    container.Delete(item)


def at(x_mm: float, y_mm: float):
    return pcbnew.VECTOR2I(int(x_mm * MM), int(y_mm * MM))


def extent(fp) -> tuple[float, float, float, float]:
    """A footprint's extent in mm, relative to its origin: x, y, w, h.

    The courtyard where it has one - that is what the footprint says it
    needs - and the pads and outline otherwise.
    """
    box = None
    try:
        court = fp.GetCourtyard(pcbnew.F_CrtYd)
        if court.OutlineCount():
            box = court.BBox()
    except Exception:
        box = None
    if box is None:
        try:
            box = fp.GetBoundingBox(False, False)
        except TypeError:
            box = fp.GetBoundingBox(False)
    return (box.GetX() / MM, box.GetY() / MM, box.GetWidth() / MM, box.GetHeight() / MM)


def cluster(loaded, nets):
    """Order the parts so each small one follows the chip it serves.

    A decoupling capacitor belongs beside the pin it decouples, and a
    crystal's load capacitors beside the crystal. Parts with five pads or
    more are anchors, biggest first; every smaller part goes after the
    anchor it shares the most nets with. Nets that touch more than six
    parts - ground, the rails - are left out of that count: they share
    everything with everything and would put every part beside the MCU.
    """
    parts = {comp.get("ref"): (comp, fp, box) for comp, fp, box in loaded}
    touches = {}
    for net in nets:
        refs = {n["ref"] for n in net.get("nodes", []) if n.get("ref") in parts}
        if 2 <= len(refs) <= 6:
            for r in refs:
                touches.setdefault(r, set()).add(net.get("name"))

    def pads(ref):
        return len(list(parts[ref][1].Pads()))

    anchors = sorted((r for r in parts if pads(r) >= 5),
                     key=lambda r: (-pads(r), r))
    followers = {a: [] for a in anchors}
    loose = []
    for ref in sorted(r for r in parts if r not in followers):
        mine = touches.get(ref, set())
        best = max(anchors, key=lambda a: len(mine & touches.get(a, set())),
                   default=None)
        if best is not None and mine & touches.get(best, set()):
            followers[best].append(ref)
        else:
            loose.append(ref)

    order = []
    for a in anchors:
        order += [a] + followers[a]
    return [parts[r] for r in order + loose]


REACH = 7.0                 # how far a part may land from its own chip, mm


def bottom_left(boxes, gap, limit, kin=None):
    """One pass: each extent as far up the block as it will go, then as
    far left, against what is already down.

    The spots a part may start at are the corners the others leave - the
    right-hand edge of one, the bottom edge of another - so a 0402 slides
    into the space beside a chip instead of taking a row to itself.

    A hole is only worth filling with a part that belongs there. A part
    that shares a net with something already down has to land within
    reach of it, and only when nothing within reach is free does it take
    whatever is left: packing without that put a decoupling capacitor
    three centimetres from the pin it decouples, and the router paid for
    it in vias.
    """
    placed, spots = [], []
    for i, (_, _, w, h) in enumerate(boxes):
        near = [placed[j] for j in (kin[i] if kin else ()) if j < len(placed)]
        xs = sorted({0.0} | {px + pw + gap for px, _, pw, _ in placed})
        ys = sorted({0.0} | {py + ph + gap for _, py, _, ph in placed})
        reaches = (REACH, 2 * REACH, None) if near else (None,)
        if near:
            cx = sum(p[0] + p[2] / 2 for p in near) / len(near)
            cy = sum(p[1] + p[3] / 2 for p in near) / len(near)
        spot = None
        for reach in reaches:
            for y in ys:
                for x in xs:
                    if x > 0 and x + w > limit + 1e-6:
                        continue
                    if reach is not None and math.hypot(
                            x + w / 2 - cx, y + h / 2 - cy) > reach:
                        continue
                    if all(x + w + gap <= px + 1e-6 or px + pw + gap <= x + 1e-6
                           or y + h + gap <= py + 1e-6 or py + ph + gap <= y + 1e-6
                           for px, py, pw, ph in placed):
                        spot = (x, y)
                        break
                if spot is not None:
                    break
            if spot is not None:
                break
        if spot is None:                       # wider than the trial width
            spot = (0.0, max((py + ph + gap for _, py, _, ph in placed),
                             default=0.0))
        placed.append((spot[0], spot[1], w, h))
        spots.append(spot)
    return spots


def kinship(ordered, nets):
    """For each part, which of the others share a net with it - the same
    count `cluster` works from, so a rail everything is on does not make
    every part everybody's neighbour."""
    seats = {comp.get("ref"): i for i, (comp, _, _) in enumerate(ordered)}
    kin = [set() for _ in ordered]
    for net in nets:
        refs = [seats[n["ref"]] for n in net.get("nodes", [])
                if n.get("ref") in seats]
        if 2 <= len(set(refs)) <= 6:
            for a in refs:
                kin[a] |= set(refs) - {a}
    return kin


TRIALS = list(range(6, 22, 2))      # trial widths, as tenths of the square side


def pack(boxes, gap, kin=None, attempt=0):
    """Pack extents into the smallest rectangle they will go in.

    Rows of shelves was what this did before, and a row is as tall as its
    tallest part: an 0402 next to a TSSOP wasted six millimetres of the
    row, and thirty parts covered a quarter of the ground they took up.
    Filling from the top left instead puts the small parts in the gaps.

    How wide to pack into is not obvious, so it is measured rather than
    guessed: eight trial widths around the square root of the area, and
    the one whose result covers the least, squarest ground wins.

    `attempt` takes the next-best trial instead of the best. The tightest
    board is not always one the router can finish - a 0.5 mm rail has to
    leave a connector's pad field somehow - and the eight trials are eight
    real layouts of the same parts, in order of how much ground they take.
    So a run that comes up a wire short is laid out again one step looser,
    rather than routed again, which on the same board gives the same
    answer every time.
    """
    if not boxes:
        return []
    area = sum((w + gap) * (h + gap) for _, _, w, h in boxes)
    widest = max(w for _, _, w, _ in boxes)
    side = math.sqrt(area)
    trials = []
    for tenths in TRIALS:
        limit = max(widest, side * tenths / 10.0)
        spots = bottom_left(boxes, gap, limit, kin)
        w = max(x + box[2] for (x, _), box in zip(spots, boxes))
        h = max(y + box[3] for (_, y), box in zip(spots, boxes))
        trials.append(((round(w * h, 3), round(abs(w - h), 3)), spots))
    trials.sort(key=lambda t: t[0])
    return trials[min(max(attempt, 0), len(trials) - 1)][1]


CONNECTOR_NAMES = ("CONN", "TYPE-C", "USB", "HDR", "HEADER", "JST", "PH-K", "TERMINAL")


def is_connector(fp) -> bool:
    """Something a cable plugs into, and so belongs on an edge.

    By name first - EasyEDA's connector footprints say what they are - and
    then by having through-hole pads on nets, which in a board of surface
    parts is nearly always a connector or a header.
    """
    name = str(fp.GetFPID().GetLibItemName()).upper()
    if any(k in name for k in CONNECTOR_NAMES):
        return True
    return any(p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH and p.GetNumber()
               for p in fp.Pads())


def mouth(fp) -> tuple[float, float]:
    """Which way a connector opens, as a vector, at its current turn.

    A receptacle's pads are at its back and its body reaches forward to
    the opening, so the opening is the way the body's centre sits from the
    pads' centre. A plain vertical header has no such offset, and no
    preferred way round.
    """
    x0, y0, w, h = extent(fp)
    pads = list(fp.Pads())
    if not pads:
        return (0.0, 0.0)
    px = sum(pd.GetPosition().x for pd in pads) / len(pads) / MM
    py = sum(pd.GetPosition().y for pd in pads) / len(pads) / MM
    return (x0 + w / 2 - px, y0 + h / 2 - py)


def face(fp, direction: tuple[float, float]) -> None:
    """Turn a connector so it opens towards `direction`, trying the four
    right-angle turns and keeping the one that points best. Measured, not
    worked out: which way KiCad counts a turn is not worth being wrong
    about."""
    import math

    best, best_score = 0, -2.0
    for turn in (0, 90, 180, 270):
        fp.SetOrientationDegrees(turn)
        mx, my = mouth(fp)
        length = math.hypot(mx, my)
        if length < 0.5:
            # No opening to point: lie along the edge instead.
            x0, y0, w, h = extent(fp)
            along = w >= h if direction[1] else h >= w
            score = 1.0 if along else 0.0
        else:
            score = (mx * direction[0] + my * direction[1]) / length
        if score > best_score:
            best, best_score = turn, score
    fp.SetOrientationDegrees(best)


def copper_reach(fp, box, edge: str) -> float:
    """How far inside the part's outline its copper starts, on one side.

    Measured at the part's current turn, with it at the origin: the gap
    between the outline's edge and the nearest pad's edge, on the side that
    will sit on the board's edge.
    """
    x0, y0, w, h = box
    left, top, right, bottom = [], [], [], []
    for pad in fp.Pads():
        b = pad.GetBoundingBox()
        left.append(b.GetX() / MM)
        top.append(b.GetY() / MM)
        right.append(b.GetRight() / MM)
        bottom.append(b.GetBottom() / MM)
    if not left:
        return 99.0
    return {"top": min(top) - y0, "bottom": (y0 + h) - max(bottom),
            "left": min(left) - x0, "right": (x0 + w) - max(right)}[edge]


def texts(fp):
    """Every text a part carries: its reference, its value, and any the
    footprint draws for itself."""
    out = [fp.Reference(), fp.Value()]
    field = getattr(pcbnew, "PCB_FIELD", ())
    out += [i for i in fp.GraphicalItems()
            if isinstance(i, pcbnew.PCB_TEXT) and not isinstance(i, field)]
    return out


def boxed(item) -> tuple[float, float, float, float]:
    """An item's bounding box in mm: left, top, right, bottom."""
    r = item.GetBoundingBox()
    return (r.GetX() / MM, r.GetY() / MM, r.GetRight() / MM, r.GetBottom() / MM)


def clashes(a, b, slack=0.05) -> bool:
    return (a[0] < b[2] + slack and b[0] < a[2] + slack
            and a[1] < b[3] + slack and b[1] < a[3] + slack)


def fit(text, room_w, room_h, largest=1.0, smallest=0.8) -> float:
    """Shrink a text until its own bounding box fits the room it has.

    Measured, not worked out from the character count: how wide a string
    sets is the font's business, and a reference that is a millimetre out
    is a reference over its neighbour's pad.
    """
    height = largest
    for _ in range(6):
        text.SetTextSize(at(height, height))
        text.SetTextThickness(int(height * 0.15 * MM))
        box = text.GetBoundingBox()
        w, h = box.GetWidth() / MM, box.GetHeight() / MM
        if w <= 0 or h <= 0 or height <= smallest or (w <= room_w and h <= room_h):
            break
        height = max(smallest, height * min(room_w / w, room_h / h) * 0.97)
    return height


SILK = (pcbnew.F_SilkS, pcbnew.B_SilkS)


def label(board, gap, bounds, edge=0.25) -> int:
    """Every part's texts, on the part it names.

    An EasyEDA footprint carries its reference four millimetres above
    itself, which on a board packed this tight is over a neighbour or off
    the board - six of this one's designators were printed on nothing.
    So each is shrunk to what the part can hold, no smaller than a board
    house will print, and put in the middle of it; where the middle is
    already somebody's, it tries just off each side of the part before
    settling there anyway. A value nobody set is not printed at all.

    Says how many ended up somewhere other than the middle.
    """
    x0, y0, x1, y1 = bounds
    pads = [boxed(pad) for fp in board.GetFootprints() for pad in fp.Pads()]
    taken: dict[int, list] = {}
    off_centre = 0
    # Biggest first: a chip's own name has the better claim on its middle.
    parts = sorted(board.GetFootprints(),
                   key=lambda fp: -(extent(fp)[2] * extent(fp)[3]))
    for fp in parts:
        px, py, w, h = extent(fp)
        middle = (px + w / 2, py + h / 2)
        # The part's own ground and half the gap to its neighbour: a
        # designator a shade wider than an 0402 is still plainly that
        # 0402's.
        room_w, room_h = w + gap * 0.9, h + gap * 0.9
        for text in texts(fp):
            if (text.GetShownText(True) or "").strip() in ("", "?", "~"):
                text.SetVisible(False)
                continue
            text.SetKeepUpright(False)
            best = (-1.0, 0.0)
            for angle in (0.0, 90.0):
                text.SetTextAngleDegrees(angle)
                got = fit(text, room_w, room_h)
                if got > best[0]:
                    best = (got, angle)
            text.SetTextAngleDegrees(best[1])
            fit(text, room_w, room_h)
            box = text.GetBoundingBox()
            tw, th = box.GetWidth() / MM, box.GetHeight() / MM

            def sits(spot):
                return (spot[0] - tw / 2, spot[1] - th / 2,
                        spot[0] + tw / 2, spot[1] + th / 2)

            above, below = py - th / 2 - 0.1, py + h + th / 2 + 0.1
            left, right = px - tw / 2 - 0.1, px + w + tw / 2 + 0.1
            spots = [middle,
                     (middle[0], above), (middle[0], below),
                     (left, middle[1]), (right, middle[1]),
                     (left, above), (right, above),
                     (left, below), (right, below)]
            spots = [s for s in spots
                     if x0 + edge <= s[0] - tw / 2 and s[0] + tw / 2 <= x1 - edge
                     and y0 + edge <= s[1] - th / 2 and s[1] + th / 2 <= y1 - edge]
            mine = taken.setdefault(text.GetLayer(), [])
            silk = text.GetLayer() in SILK
            spot = None
            for avoid in (mine + pads if silk else mine, mine):
                spot = next((s for s in spots
                             if not any(clashes(sits(s), b) for b in avoid)),
                            None)
                if spot is not None:
                    break
            spot = spot or (spots[0] if spots else middle)
            text.SetPosition(at(*spot))
            mine.append(sits(spot))
            off_centre += spot != middle
    return off_centre


def keep_inside(board, x0, y0, x1, y1, inset=0.25) -> int:
    """Pull any text that still reaches past the outline back inside it,
    and say how many had to move. Nothing is printed on air."""
    moved = 0
    for fp in board.GetFootprints():
        for text in texts(fp):
            if not text.IsVisible():
                continue
            box = text.GetBoundingBox()
            dx = (max(0.0, x0 + inset - box.GetX() / MM)
                  - max(0.0, box.GetRight() / MM - (x1 - inset)))
            dy = (max(0.0, y0 + inset - box.GetY() / MM)
                  - max(0.0, box.GetBottom() / MM - (y1 - inset)))
            if abs(dx) < 1e-6 and abs(dy) < 1e-6:
                continue
            here = text.GetPosition()
            text.SetPosition(pcbnew.VECTOR2I(here.x + int(dx * MM),
                                             here.y + int(dy * MM)))
            moved += 1
    return moved


def body_on_board(path: str, ref: str) -> tuple | None:
    """Where one part's own 3D shape sits on the board: x0, x1, y0, y1 in mm.

    A footprint's outline is a drawing, and a drawing can be generous. This
    board's USB-C socket is drawn 8.35 mm deep and its own 3D shape is
    8.33 mm deep - the same socket - but the shape sits 1.45 mm further
    back in the footprint than the drawing does. Flush to the drawing left
    1.5 mm of bare board in front of the socket, which is what the person
    saw and asked about. The shape is the thing a plug meets, so it is what
    the edge is cut to.

    KiCad will export one part's shape on its own, placed and turned as it
    sits on the board, and glTF carries the vertices: so this is measured,
    not worked out from the footprint. None when the part has no shape.
    """
    glb = f"{path}.{ref}.glb"
    try:
        run = subprocess.run(
            ["kicad-cli", "pcb", "export", "glb", "-f", "--component-filter", ref,
             "-o", glb, path],
            capture_output=True, text=True, timeout=120,
            env={**os.environ,
                 "KICAD9_3DMODEL_DIR": os.environ.get(
                     "KICAD9_3DMODEL_DIR", "/usr/share/kicad/3dmodels")})
        if run.returncode != 0:
            return None
        raw = Path(glb).read_bytes()
    except (OSError, subprocess.SubprocessError):
        return None
    finally:
        try:
            os.unlink(glb)
        except OSError:
            pass

    chunks, at = [], 12
    while at < len(raw) - 8:
        length, _kind = struct.unpack_from("<II", raw, at)
        chunks.append(raw[at + 8:at + 8 + length])
        at += 8 + length
    if len(chunks) < 2:
        return None
    try:
        doc = json.loads(chunks[0].decode("utf-8").rstrip("\x00 "))
    except ValueError:
        return None
    node = next((n for n in doc.get("nodes", [])
                 if n.get("name") == ref and n.get("mesh") is not None), None)
    if node is None:
        return None

    # glTF is metres, y up: the board's x is x and the board's y is z. The
    # part's turn is a quaternion about that up axis.
    tx, _ty, tz = [v * 1000 for v in node.get("translation", [0, 0, 0])]
    qx, qy, qz, qw = node.get("rotation", [0, 0, 0, 1])
    turn = 2 * math.atan2(qy, qw)
    cos, sin = math.cos(turn), math.sin(turn)
    xs, ys = [], []
    for prim in doc["meshes"][node["mesh"]].get("primitives", []):
        acc = doc["accessors"][prim["attributes"]["POSITION"]]
        view = doc["bufferViews"][acc["bufferView"]]
        base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        step = view.get("byteStride") or 12
        for i in range(acc["count"]):
            x, _y, z = struct.unpack_from("<3f", chunks[1], base + i * step)
            x, z = x * 1000, z * 1000
            xs.append(tx + x * cos + z * sin)
            ys.append(tz - x * sin + z * cos)
    if not xs:
        return None
    return (min(xs), max(xs), min(ys), max(ys))


def draw_outline(board, x0, y0, x1, y1) -> None:
    """The board's edge, as four segments."""
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    for j, (ax, ay) in enumerate(corners):
        bx, by = corners[(j + 1) % 4]
        line = pcbnew.PCB_SHAPE(board)
        line.SetShape(pcbnew.SHAPE_T_SEGMENT)
        line.SetStart(at(ax, ay))
        line.SetEnd(at(bx, by))
        line.SetLayer(pcbnew.Edge_Cuts)
        line.SetWidth(int(0.1 * MM))
        board.Add(line)


def clear_outline(board) -> None:
    for shape in list(board.GetDrawings()):
        if shape.GetLayer() == pcbnew.Edge_Cuts:
            discard(board, shape)


def cut_to_bodies(board, path, on_edge, bounds, clearance=0.5):
    """Bring each edge in to the front of the connectors standing on it.

    Inwards only, and never nearer a pad than the board house's clearance.
    Where two connectors share an edge, the edge stops at whichever one
    reaches least far out; the other then hangs over it, which is what a
    connector on an edge is for, and how far is reported rather than
    quietly allowed.
    """
    x0, y0, x1, y1 = bounds
    pads = [pad.GetBoundingBox() for fp in board.GetFootprints() for pad in fp.Pads()]
    # How far in each edge may come before it crowds the nearest pad. A hair
    # over the rule, not exactly on it: the outline is kept in whole
    # nanometres, and an edge laid exactly 0.5 mm from a pad came back from
    # DRC as 0.499999 mm, five times over.
    room = clearance + 0.05
    limit = {
        "left": min((p.GetX() / MM for p in pads), default=x1) - room,
        "right": max((p.GetRight() / MM for p in pads), default=x0) + room,
        "top": min((p.GetY() / MM for p in pads), default=y1) - room,
        "bottom": max((p.GetBottom() / MM for p in pads), default=y0) + room,
    }
    was = {"left": x0, "right": x1, "top": y0, "bottom": y1}
    face_of = {"left": 0, "right": 1, "top": 2, "bottom": 3}
    moved, over = {}, {}
    for edge, refs in on_edge.items():
        faces = {}
        for ref in refs:
            got = body_on_board(path, ref)
            if got:
                faces[ref] = got[face_of[edge]]
        if not faces:
            continue
        if edge in ("left", "top"):             # the edge moves up in value
            want = min(max(max(faces.values()), was[edge]), limit[edge])
        else:                                   # and down on the other two
            want = max(min(min(faces.values()), was[edge]), limit[edge])
        # Not worth moving an edge for a tenth of a millimetre.
        if abs(want - was[edge]) < 0.1:
            continue
        moved[edge] = round(abs(want - was[edge]), 3)
        for ref, face in faces.items():
            past = (want - face) if edge in ("left", "top") else (face - want)
            if past > 0.01:
                over[ref] = round(past, 3)
        was[edge] = want
    return (was["left"], was["top"], was["right"], was["bottom"]), moved, over


UUID = re.compile(r'\(uuid "[0-9a-fA-F-]{36}"\)')


def span(text: str, start: int) -> int:
    """Where the s-expression opening at `start` closes."""
    depth, i, quoted = 0, start, False
    while i < len(text):
        c = text[i]
        if quoted:
            if c == "\\":
                i += 1
            elif c == '"':
                quoted = False
        elif c == '"':
            quoted = True
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return len(text)


def named(key: str) -> str:
    return str(uuids.UUID(hashlib.md5(key.encode()).hexdigest()))


def steady(path: str, salt: int) -> int:
    """Name everything in the saved board after what it is, not after when
    it was written. Says how many were renamed.

    KiCad gives every item a fresh random uuid each time it writes a board,
    and it writes the footprints in uuid order. So the same placement came
    out as a different file every run, KiCad exported the DSN in that order,
    and Freerouting - which is the same twice on the same DSN - answered
    differently each time: this board, placed identically and routed six
    times, came back 1, 3, 0, 0, 1 and 1 connections short. A layout nobody
    can reproduce is not one anybody can fix.

    So each uuid is derived from the part's own reference instead. The
    board is then the same file every run, the DSN is the same, and the
    routing is the same. `salt` moves them all at once, which is how a
    second try becomes a different problem for the router rather than the
    same one over again.
    """
    text = Path(path).read_text()
    spans, i = [], 0
    while True:
        at = text.find("\n\t(", i)
        if at < 0:
            break
        a = at + 1
        b = span(text, a)
        spans.append((a, b))
        i = b

    done = 0

    def rename(chunk: str, key: str) -> str:
        """Every uuid in one item, after the item and its place in it."""
        nonlocal done
        seen = [0]

        def swap(_):
            seen[0] += 1
            return '(uuid "%s")' % named(f"{salt}:{key}:{seen[0]}")

        out = UUID.sub(swap, chunk)
        done += seen[0]
        return out

    twice: dict[str, int] = {}

    def whose(chunk: str) -> str:
        """What the item is, independent of what it is called. A footprint
        is its reference; anything else - the four lines of the outline -
        is its own text with the old names taken out, because where it
        came in the file is itself one of the things that varied. Two that
        come out the same are counted apart, so no name is used twice."""
        ref = re.search(r'\(property "Reference" "([^"]*)"', chunk)
        if chunk.startswith("(footprint ") and ref:
            key = ref.group(1)
        else:
            key = hashlib.md5(UUID.sub("", chunk).encode()).hexdigest()
        twice[key] = twice.get(key, 0) + 1
        return key if twice[key] == 1 else f"{key}#{twice[key]}"

    out, cursor = [], 0
    for a, b in spans:
        out.append(text[cursor:a])
        chunk = text[a:b]
        out.append(rename(chunk, whose(chunk)))
        cursor = b
    out.append(text[cursor:])
    Path(path).write_text("".join(out))
    return done


def draw_edges(board, loops) -> tuple[float, float, float, float]:
    """A given outline - lines and arcs, in mm - on Edge.Cuts. Returns its
    box."""
    xs, ys = [], []
    for loop in loops:
        for piece in loop:
            shape = pcbnew.PCB_SHAPE(board)
            if "arc" in piece:
                a, m, b = piece["arc"]
                shape.SetShape(pcbnew.SHAPE_T_ARC)
                shape.SetArcGeometry(at(*a), at(*m), at(*b))
                pts = [a, m, b]
            else:
                a, b = piece["line"]
                shape.SetShape(pcbnew.SHAPE_T_SEGMENT)
                shape.SetStart(at(*a))
                shape.SetEnd(at(*b))
                pts = [a, b]
            shape.SetLayer(pcbnew.Edge_Cuts)
            shape.SetWidth(int(0.1 * MM))
            board.Add(shape)
            xs += [p[0] for p in pts]
            ys += [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def edge_rule(board, plan) -> None:
    """The board's copper-to-edge clearance (rules.py board.min_edge), so a
    board opened by hand is checked against the edge the run used."""
    if plan.get("min_edge") is not None:
        board.GetDesignSettings().m_CopperEdgeClearance = int(round(float(plan["min_edge"]) * MM))


HOLE_SAME = 0.15        # mm: a footprint's own hole this near is the drill's hole


def mounting_hole(board, ref: str, x: float, y: float, d: float, plated: bool = False):
    """A hole on its own, the way KiCad's MountingHole library draws one: a
    footprint holding a single pad with no number - unplated, or plated with
    a ring - at the drill's own diameter. Board-only, out of the BOM and the
    position files: it is a hole, not a part."""
    fp = pcbnew.FOOTPRINT(board)
    name = f"MountingHole_{d:g}mm" + ("_Pad" if plated else "")
    fp.SetFPID(pcbnew.LIB_ID("", name))
    fp.SetReference(ref)
    fp.SetValue(name)
    fp.SetPosition(at(x, y))
    pad = pcbnew.PAD(fp)
    pad.SetShape(pcbnew.PAD_SHAPE_CIRCLE)
    hole = int(round(d * MM))
    pad.SetDrillSize(pcbnew.VECTOR2I(hole, hole))
    if plated:
        # The ring is not in the drill file; KiCad's MountingHole_*_Pad
        # rings are about 0.4 x the hole wide on each side.
        ring = int(round(d * 1.8 * MM))
        pad.SetAttribute(pcbnew.PAD_ATTRIB_PTH)
        pad.SetLayerSet(pad.PTHMask())
        pad.SetSize(pcbnew.VECTOR2I(ring, ring))
    else:
        pad.SetAttribute(pcbnew.PAD_ATTRIB_NPTH)
        pad.SetLayerSet(pad.UnplatedHoleMask())
        pad.SetSize(pcbnew.VECTOR2I(hole, hole))
    pad.SetPosition(at(x, y))
    fp.Add(pad)
    # Its courtyard: the hole and a quarter of a millimetre round it.
    court = pcbnew.PCB_SHAPE(fp)
    court.SetShape(pcbnew.SHAPE_T_CIRCLE)
    court.SetLayer(pcbnew.F_CrtYd)
    court.SetWidth(int(0.05 * MM))
    court.SetStart(at(x, y))
    court.SetEnd(at(x + (d * (1.8 if plated else 1.0)) / 2 + 0.25, y))
    fp.Add(court)
    fp.SetAttributes(pcbnew.FP_EXCLUDE_FROM_BOM | pcbnew.FP_EXCLUDE_FROM_POS_FILES
                     | pcbnew.FP_BOARD_ONLY)
    fp.Reference().SetVisible(False)
    board.Add(fp)
    return fp


# A part whose body lies beside its pads - a TO-220 laid flat, its tab
# screwed down - has the import's centroid off its pads, toward the body;
# a hole out along that line is the body's (the tab's), within this many
# times the centroid's distance from the pads, and this much either side
# of the pad row.
BODY_REACH = 3.0
BODY_SIDE = 1.0         # mm beyond the pads' own spread, across the line


def body_hole_owner(hole: dict, parts: dict) -> str | None:
    """Which part's original footprint a free hole is part of, judged from
    the import alone: the part whose import centroid lies off its pads
    (more than BODY_SIDE beyond their box - the body is not over them),
    with the hole further out along the line from the pads' centre through
    that centroid, no more than BODY_REACH times as far, and within the
    pad row's width of that line. A mounting hole beside a part, or
    behind its pads, is nobody's. None when no part claims it."""
    hx, hy = hole["at"]
    best = None
    for ref, want in parts.items():
        pts = list((want.get("pads") or {}).values())
        if len(pts) < 2 or not want.get("at"):
            continue
        cx, cy = want["at"]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        if (min(xs) - BODY_SIDE <= cx <= max(xs) + BODY_SIDE
                and min(ys) - BODY_SIDE <= cy <= max(ys) + BODY_SIDE):
            continue                       # body over its pads: owns no far hole
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        d = math.dist((mx, my), (cx, cy))
        ux, uy = (cx - mx) / d, (cy - my) / d
        t = (hx - mx) * ux + (hy - my) * uy
        side = abs(-(hx - mx) * uy + (hy - my) * ux)
        spread = max(abs(-(x - mx) * uy + (y - my) * ux) for x, y in pts)
        if d < t <= BODY_REACH * d and side <= spread + BODY_SIDE:
            if best is None or t < best[0]:
                best = (t, ref)
    return best[1] if best else None


def own_hole(fp, x: float, y: float, d: float, plated: bool = False) -> None:
    """A hole of the part's original footprint that the footprint used
    here does not have - an upright TO-220 standing in for a lying one,
    whose tab hole is in the drills - put into that footprint, and its
    courtyard redrawn to take in the pads and the hole: where the part
    lies on this board, not where the upright body would stand."""
    pad = pcbnew.PAD(fp)
    pad.SetShape(pcbnew.PAD_SHAPE_CIRCLE)
    hole = int(round(d * MM))
    pad.SetDrillSize(pcbnew.VECTOR2I(hole, hole))
    if plated:
        ring = int(round(d * 1.8 * MM))
        pad.SetAttribute(pcbnew.PAD_ATTRIB_PTH)
        pad.SetLayerSet(pad.PTHMask())
        pad.SetSize(pcbnew.VECTOR2I(ring, ring))
    else:
        pad.SetAttribute(pcbnew.PAD_ATTRIB_NPTH)
        pad.SetLayerSet(pad.UnplatedHoleMask())
        pad.SetSize(pcbnew.VECTOR2I(hole, hole))
    pad.SetPosition(at(x, y))
    fp.Add(pad)

    # The courtyard: a box along the line from the pads to the hole, as
    # wide as the old courtyard (the body's width) or the pads, whichever
    # is wider, from behind the pads to beyond the hole.
    layer = pcbnew.B_CrtYd if fp.IsFlipped() else pcbnew.F_CrtYd
    pads = [p for p in fp.Pads() if p.GetNumber()]
    mx = sum(p.GetPosition().x for p in pads) / len(pads) / MM
    my = sum(p.GetPosition().y for p in pads) / len(pads) / MM
    L = math.dist((mx, my), (x, y)) or 1.0
    ux, uy = (x - mx) / L, (y - my) / L
    vx, vy = -uy, ux

    def corners(box):
        x0, y0 = box.GetX() / MM, box.GetY() / MM
        x1, y1 = x0 + box.GetWidth() / MM, y0 + box.GetHeight() / MM
        return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    pts = [q for p in pads for q in corners(p.GetBoundingBox())]
    r = (d * (1.8 if plated else 1.0)) / 2
    pts += [(x + ux * r, y + uy * r), (x + vx * r, y + vy * r), (x - vx * r, y - vy * r)]
    old = [g for g in fp.GraphicalItems() if g.GetLayer() == layer]
    for g in old:
        pts += corners(g.GetBoundingBox())
    along = [(px - mx) * ux + (py - my) * uy for px, py in pts]
    across = [(px - mx) * vx + (py - my) * vy for px, py in pts]
    # Behind the pads: from the pads themselves, not the old body - the
    # old body stood across the pad row, the lying one does not.
    pad_along = [(px - mx) * ux + (py - my) * uy
                 for p in pads for px, py in corners(p.GetBoundingBox())]
    a0, a1 = min(pad_along) - 0.25, max(along) + 0.25
    c0, c1 = min(across) - 0.25, max(across) + 0.25
    for g in old:
        discard(fp, g)
    box = [(a0, c0), (a1, c0), (a1, c1), (a0, c1)]
    ends = [(mx + a * ux + c * vx, my + a * uy + c * vy) for a, c in box]
    for (x0, y0), (x1, y1) in zip(ends, ends[1:] + ends[:1]):
        seg = pcbnew.PCB_SHAPE(fp)
        seg.SetShape(pcbnew.SHAPE_T_SEGMENT)
        seg.SetLayer(layer)
        seg.SetWidth(int(0.05 * MM))
        seg.SetStart(at(x0, y0))
        seg.SetEnd(at(x1, y1))
        fp.Add(seg)


def free_holes(board, holes, parts: dict | None = None) -> list[dict]:
    """The import's holes no placed footprint already has, each put in as a
    mounting hole (H1, H2 ... after any H the board has). A footprint's own
    locating pegs come in the drill file too; they are its, not new holes.
    And a hole the import shows is a part's body's (body_hole_owner: a
    lying TO-220's tab) goes into that part (own_hole), marked `part`,
    rather than standing on the board as a mounting hole of its own.
    `parts` is the held plan's parts, for that."""
    owned = []
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            if pad.GetDrillSize().x > 0:
                p = pad.GetPosition()
                owned.append((p.x / MM, p.y / MM))
    taken = {fp.GetReference() for fp in board.GetFootprints()}
    n, out = 0, []
    for h in holes or []:
        x, y = h["at"]
        if any(math.dist((x, y), q) <= HOLE_SAME for q in owned):
            continue
        owner = body_hole_owner(h, parts or {})
        fp = board.FindFootprintByReference(owner) if owner else None
        if fp is not None:
            own_hole(fp, x, y, float(h["d"]), bool(h.get("plated")))
            owned.append((x, y))
            out.append({"part": owner, "at": [round(x, 4), round(y, 4)], "d": h["d"],
                        "plated": bool(h.get("plated"))})
            continue
        n += 1
        while f"H{n}" in taken:
            n += 1
        ref = f"H{n}"
        taken.add(ref)
        mounting_hole(board, ref, x, y, float(h["d"]), bool(h.get("plated")))
        owned.append((x, y))
        out.append({"ref": ref, "at": [round(x, 4), round(y, 4)], "d": h["d"],
                    "plated": bool(h.get("plated"))})
    return out


def pad_spots(fp) -> dict:
    """A placed footprint's pads: number -> centres in mm. A number can
    name several pads (a connector's shell)."""
    out = {}
    for pad in fp.Pads():
        if pad.GetNumber():
            p = pad.GetPosition()
            out.setdefault(pad.GetNumber(), []).append((p.x / MM, p.y / MM))
    return out


def hold(fp, want) -> dict:
    """Put a footprint where the board it came from had it.

    `want` is {"pads": {number: [x, y]}, "at": [x, y], "rot": deg, "side"}
    in the board's own millimetres. Where two pads or more can be told
    apart by number, the footprint is turned and moved so its pads lie on
    those - measured, the same way `face` measures a turn: the best turn
    by least squares, tried both ways round since which way KiCad counts
    an angle is not worth being wrong about, then the shift that centres
    the pads on theirs. Where they cannot, the part goes to the given
    centre and angle. Says how far its worst pad is from where it was.
    """
    if want.get("side") == "bottom":
        fp.Flip(fp.GetPosition(), False)
    fp.SetOrientationDegrees(0)
    fp.SetPosition(at(0, 0))
    targets = {k: tuple(v) for k, v in (want.get("pads") or {}).items()}
    mine = pad_spots(fp)
    pairs = [(mine[k][0], targets[k]) for k in targets if len(mine.get(k, [])) == 1]

    def worst():
        spots = pad_spots(fp)
        dist = [min(math.dist(p, q) for p in spots[k]) for k, q in targets.items() if k in spots]
        return max(dist) if dist else None

    if len(pairs) < 2:
        fp.SetOrientationDegrees(float(want.get("rot") or 0))
        fp.SetPosition(at(*want["at"]))
        return {"how": "centre", "worst_mm": worst()}

    def fit(src, dst):
        n = len(src)
        sx, sy = sum(p[0] for p in src) / n, sum(p[1] for p in src) / n
        dx, dy = sum(p[0] for p in dst) / n, sum(p[1] for p in dst) / n
        a = b = 0.0
        for (x0, y0), (x1, y1) in zip(src, dst):
            x0, y0, x1, y1 = x0 - sx, y0 - sy, x1 - dx, y1 - dy
            a += x0 * x1 + y0 * y1
            b += x0 * y1 - y0 * x1
        return math.degrees(math.atan2(b, a))

    turn = fit([p for p, _ in pairs], [q for _, q in pairs])
    best = None
    for angle in (turn, -turn):
        fp.SetOrientationDegrees(round(angle, 3) % 360)
        fp.SetPosition(at(0, 0))
        spots = pad_spots(fp)
        keys = [k for k in targets if len(spots.get(k, [])) == 1]
        got = [spots[k][0] for k in keys]
        dst = [targets[k] for k in keys]
        mx = sum(p[0] for p in dst) / len(dst) - sum(p[0] for p in got) / len(got)
        my = sum(p[1] for p in dst) / len(dst) - sum(p[1] for p in got) / len(got)
        fp.SetPosition(at(mx, my))
        w = worst()
        if best is None or w < best[0]:
            best = (w, angle, (mx, my))
    w, angle, (mx, my) = best
    fp.SetOrientationDegrees(round(angle, 3) % 360)
    fp.SetPosition(at(mx, my))
    return {"how": "pads", "worst_mm": round(w, 4)}



# ---------------- a part added to a held board ----------------

SPOT_STEP = 0.25        # mm: the grid a new part's position is looked for on
SPOT_GAP = 0.1          # mm between courtyards, on top of what they already keep
PAD_ROOM = 0.25         # mm kept round another part's pads, past its courtyard
WIDE_NET = 8            # pads: a net this big (ground, a rail) pulls a part only a little


def free_spot(shapes, taken, bounds, aims, step=SPOT_STEP, gap=SPOT_GAP, inside=None):
    """Where a new part goes on a board whose other parts may not move.

    `shapes` is the part at each turn it may take: (rot, box, pads), the
    box (left, top, right, bottom) and the pads {number: (x, y)} relative
    to its origin. `taken` are the boxes already on the board, `bounds`
    the box it must stay inside, `aims` {pad number: [(x, y, weight)]} -
    the placed pads each of its pads is joined to. The spot is the free
    one where its pads are nearest theirs (each pad to the nearest of its
    own net, weighted), on a `step` grid; `inside(box)`, when given, says
    whether a box is on the board (an outline that is not a rectangle).
    Returns (x, y, rot) or None when nothing is free.
    """
    x0, y0, x1, y1 = bounds
    pts = [(x, y) for ps in aims.values() for x, y, _w in ps]
    if not pts:
        pts = [((x0 + x1) / 2, (y0 + y1) / 2)]

    def cost(x, y, pads):
        total = 0.0
        for num, (px, py) in pads.items():
            near = aims.get(num)
            if near:
                total += min(math.hypot(x + px - ax, y + py - ay) * w for ax, ay, w in near)
        if not any(aims.get(n) for n in pads):      # joined to nothing placed: the middle
            total = math.hypot(x - pts[0][0], y - pts[0][1])
        return total

    def free(b):
        if b[0] < x0 or b[1] < y0 or b[2] > x1 or b[3] > y1:
            return False
        if any(b[0] < t[2] + gap and t[0] < b[2] + gap and b[1] < t[3] + gap and t[1] < b[3] + gap
               for t in taken):
            return False
        return inside is None or inside(b)

    def look(wx0, wy0, wx1, wy1):
        # On the board's own grid, so a window finds the spots the whole board would.
        i0, i1 = max(0, math.ceil((wx0 - x0) / step)), int((min(wx1, x1) - x0) / step)
        j0, j1 = max(0, math.ceil((wy0 - y0) / step)), int((min(wy1, y1) - y0) / step)
        found = []
        for rot, box, pads in shapes:
            for i in range(i0, i1 + 1):
                x = x0 + i * step
                for j in range(j0, j1 + 1):
                    y = y0 + j * step
                    found.append((cost(x, y, pads), rot, x, y, box))
        found.sort(key=lambda f: (round(f[0], 6), f[1], f[2], f[3]))
        for _c, rot, x, y, box in found:
            b = (x + box[0], y + box[1], x + box[2], y + box[3])
            if free(b):
                return (round(x, 4), round(y, 4), rot)
        return None

    # Near its signals first (a rail's pads are everywhere); then anywhere.
    near = [(x, y) for ps in aims.values() for x, y, w in ps if w >= 1.0] or pts
    reach = 15.0
    got = look(min(p[0] for p in near) - reach, min(p[1] for p in near) - reach,
               max(p[0] for p in near) + reach, max(p[1] for p in near) + reach)
    return got if got is not None else look(x0, y0, x1, y1)


def place_new(board, fps, where, bounds) -> dict:
    """Put the parts a held board did not have (a note added them) in the
    free room nearest what they are wired to - after every held part and
    hole is down, so none of those moves. Says where each went."""
    try:
        outline = pcbnew.SHAPE_POLY_SET()
        board.GetBoardPolygonOutlines(outline)

        def inside(b):
            return all(outline.Contains(at(x, y)) for x in (b[0], b[2]) for y in (b[1], b[3]))
    except Exception:                                   # noqa: BLE001 - the box will do
        inside = None
    new = {id(fp) for fp in fps}
    size = {}
    for (ref, pin), name in where.items():
        size[name] = size.get(name, 0) + 1

    def box_of(fp):
        # The courtyard, and the pads with room round them: an EasyEDA
        # courtyard can stop at the pads' centres (the ESP32 module's does),
        # and a part beside it would land on its copper.
        try:
            fp.BuildCourtyardCaches()
        except Exception:                               # noqa: BLE001 - older KiCad
            pass
        x, y, w, h = extent(fp)
        box = [x, y, x + w, y + h]
        for pad in fp.Pads():
            r = pad.GetBoundingBox()
            box = [min(box[0], r.GetX() / MM - PAD_ROOM), min(box[1], r.GetY() / MM - PAD_ROOM),
                   max(box[2], r.GetRight() / MM + PAD_ROOM), max(box[3], r.GetBottom() / MM + PAD_ROOM)]
        return tuple(box)

    taken = [box_of(fp) for fp in board.GetFootprints() if id(fp) not in new]
    out = {}
    for fp in fps:
        ref = fp.GetReference()
        spots: dict[str, list] = {}
        for other in board.GetFootprints():
            if id(other) in new and not out.get(other.GetReference()):
                continue
            for pad in other.Pads():
                name = pad.GetNetname()
                if name:
                    p = pad.GetPosition()
                    spots.setdefault(name, []).append((p.x / MM, p.y / MM))
        shapes, aims = [], {}
        for rot in (0, 90):
            fp.SetOrientationDegrees(rot)
            fp.SetPosition(at(0, 0))
            pads = {}
            for pad in fp.Pads():
                if pad.GetNumber():
                    q = pad.GetPosition()
                    pads.setdefault(pad.GetNumber(), (q.x / MM, q.y / MM))
                    name = where.get((ref, pad.GetNumber()))
                    if name and spots.get(name):
                        w = 0.2 if size.get(name, 0) > WIDE_NET else 1.0
                        aims[pad.GetNumber()] = [(x, y, w) for x, y in spots[name]]
            shapes.append((rot, box_of(fp), pads))
        got = free_spot(shapes, taken, bounds, aims, inside=inside)
        if got is None:
            out[ref] = None
            continue
        x, y, rot = got
        fp.SetOrientationDegrees(rot)
        fp.SetPosition(at(x, y))
        taken.append(box_of(fp))
        out[ref] = [x, y, rot]
    return out


# ---- a part's 3D pose, set for this board ------------------------------
#
# plan["poses"] = {ref: {"rotate": [rx, ry, rz], "offset": [x, y, z],
#                        "mirror": None | "x" | "y"}}   (backend/poses.py)
#
# Someone looked at the board in 3D and found a part's body lying wrong -
# a right-angle header standing up, a TO-220 meant to lie flat. The shared
# footprint stays as it is; this board's copy of it is changed before it
# is loaded, so everything downstream (the route, the drawings, the GLB,
# the STEP) reads the corrected one.
#
# The numbers REPLACE the model's offset and rotation (the seat worked out
# by backend/modelseat.py is not added to): they were measured as the
# whole answer. KiCad's conventions, as modelseat says: offset in mm in
# the 3D frame, +Y up (the footprint's -Y); rotated first, then moved.
#
# The mirror flips the footprint's silkscreen and courtyard about its own
# axis - "y" turns y into -y, "x" turns x into -x - and leaves the pads,
# the copper and the fab drawing alone. Text keeps its letters; only where
# it stands is mirrored.

POSE_LAYERS = ("F.SilkS", "B.SilkS", "F.Silkscreen", "B.Silkscreen", "F.CrtYd", "B.CrtYd",
               "F.Courtyard", "B.Courtyard")
SHAPES = ("fp_line", "fp_arc", "fp_circle", "fp_rect", "fp_poly", "fp_curve")
TEXTS = ("fp_text", "property")
_HEAD = re.compile(r"\(\s*([A-Za-z_0-9.]+)")
_LAYER = re.compile(r'\(layer\s+"?([^"\s)]+)"?')
_PNUM = r"([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)"
_POINT = re.compile(r"\((start|end|mid|center|xy|at)\s+" + _PNUM + r"\s+" + _PNUM)
_ANGLE = re.compile(r"\(angle\s+" + _PNUM + r"\s*\)")
_XYZ3 = r"\(xyz\s+" + _PNUM + r"\s+" + _PNUM + r"\s+" + _PNUM + r"\s*\)"


def children(text: str, start: int = 0) -> list[tuple[int, int]]:
    """Where each s-expression directly inside the one opening at `start`
    begins and ends."""
    end = span(text, start)
    out, i, quoted = [], start + 1, False
    while i < end - 1:
        c = text[i]
        if quoted:
            if c == "\\":
                i += 1
            elif c == '"':
                quoted = False
        elif c == '"':
            quoted = True
        elif c == "(":
            b = span(text, i)
            out.append((i, b))
            i = b
            continue
        i += 1
    return out


def num(v: float) -> str:
    """A number the way KiCad writes one: no trailing zeros, no -0."""
    s = f"{float(v):.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def _mirrored(item: str, axis: str) -> str:
    """One silkscreen or courtyard item mirrored about the footprint's own
    axis. A three-point arc (start, mid, end) mirrors point by point; the
    old centre-and-angle arc turns the other way, so its angle changes
    sign. A text is moved, not its letters."""
    head = _HEAD.match(item).group(1)
    is_text = head in TEXTS

    def flip(m):
        if is_text and m.group(1) != "at":
            return m.group(0)
        x, y = float(m.group(2)), float(m.group(3))
        x, y = (-x, y) if axis == "x" else (x, -y)
        return f"({m.group(1)} {num(x)} {num(y)}"

    # Only this item's own points - a text's (effects (font (size ..)))
    # holds none, a shape's (stroke (width ..)) neither.
    out = _POINT.sub(flip, item)
    if head == "fp_arc":
        out = _ANGLE.sub(lambda m: f"(angle {num(-float(m.group(1)))})", out)
    return out


def _with_model(block: str, rotate, offset) -> str:
    """A `(model ...)` block with this offset and rotation (None: that one
    as it was), the path and the scale left as they were. A KiCad 5
    `(at (xyz ...))` - inches, the offset's old spelling - goes when an
    offset is set, so it is not applied as well."""
    todo = []
    if offset is not None:
        todo.append(("offset", "(offset (xyz {} {} {}))".format(*(num(v) for v in offset))))
        block = re.sub(r"\s*\(at\s*" + _XYZ3 + r"\s*\)", "", block)
    if rotate is not None:
        todo.append(("rotate", "(rotate (xyz {} {} {}))".format(*(num(v) for v in rotate))))
    head = re.match(r'\(model\s+("(?:[^"\\]|\\.)*"|[^\s()]+)', block)
    cut = head.end() if head else len("(model")
    for name, new in todo:
        pat = re.compile(r"\(" + name + r"\s*" + _XYZ3 + r"\s*\)")
        if pat.search(block):
            block = pat.sub(lambda _m, n=new: n, block, count=1)
        else:
            block = block[:cut] + " " + new + block[cut:]
            cut += len(new) + 1
    return block


def posed(text: str, pose: dict) -> tuple[str, list[str]]:
    """A footprint's text with this board's pose for the part: the first
    model's offset and rotation replaced, and with a mirror, the
    silkscreen and courtyard flipped. Says what could not be done."""
    trouble = []
    root = text.find("(")
    if root < 0:
        return text, ["not a footprint"]
    edits = []                                 # (a, b, new text), in order
    model_done = False
    axis = pose.get("mirror")
    for a, b in children(text, root):
        item = text[a:b]
        head = _HEAD.match(item)
        head = head.group(1) if head else ""
        if head == "model" and not model_done:
            model_done = True
            if pose.get("rotate") is not None or pose.get("offset") is not None:
                edits.append((a, b, _with_model(item, pose.get("rotate"), pose.get("offset"))))
        elif axis in ("x", "y") and (head in SHAPES or head in TEXTS):
            layer = _LAYER.search(item)
            if layer and layer.group(1) in POSE_LAYERS:
                edits.append((a, b, _mirrored(item, axis)))
    if not model_done and (pose.get("rotate") is not None or pose.get("offset") is not None):
        trouble.append("its footprint has no 3D model to turn")
    out, cursor = [], 0
    for a, b, new in edits:
        out += [text[cursor:a], new]
        cursor = b
    out.append(text[cursor:])
    return "".join(out), trouble


def safe_name(ref: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", ref or "part")[:60] or "part"


def load(comp: dict, poses: dict, posed_refs: list, pose_trouble: dict,
         scratch: str = "/work/posed"):
    """A component's footprint, loaded by KiCad - with this board's pose
    for the part when it has one: the footprint's text changed and written
    under the part's own name (same file name, so the footprint keeps its
    name), then loaded from there. Never the shared file."""
    path = Path(comp["footprint"])
    pose = (poses or {}).get(comp.get("ref"))
    if pose:
        try:
            text, trouble = posed(path.read_text(), pose)
            where = Path(scratch) / safe_name(comp.get("ref"))
            where.mkdir(parents=True, exist_ok=True)
            (where / path.name).write_text(text)
            if trouble:
                pose_trouble[comp["ref"]] = "; ".join(trouble)
            else:
                posed_refs.append(comp["ref"])
            path = where / path.name
        except OSError as exc:
            pose_trouble[comp["ref"]] = f"footprint not read: {exc}"
    return pcbnew.FootprintLoad(str(path.parent), path.stem)


def pose_report(poses: dict, comps: list, posed_refs: list, trouble: dict) -> dict:
    """What came of the board's poses, for the run's report: the parts
    turned, and any that could not be (no model, not on the board)."""
    if not poses:
        return {}
    have = {c.get("ref") for c in comps}
    trouble = {**trouble, **{r: "not on the board" for r in poses if r not in have}}
    return {"posed": sorted(posed_refs), "pose_trouble": trouble}


def main() -> int:
    plan = json.load(sys.stdin)
    if plan.get("hold"):
        return main_held(plan)
    board = pcbnew.BOARD()

    # Nets first: a pad can only be put on a net the board already knows.
    nets = {}
    for net in plan.get("nets", []):
        name = net.get("name") or ""
        if not name or name in nets:
            continue
        item = pcbnew.NETINFO_ITEM(board, name)
        board.Add(item)
        nets[name] = item
    where = {(n["ref"], str(n["pin"])): net["name"]
             for net in plan.get("nets", [])
             for n in net.get("nodes", []) if net.get("name")}

    def put(fp, comp, x, y, box):
        """One part down: its extent's corner at (x, y), its reference and
        value, its pads on their nets, and peg holes made unplated."""
        fp.SetPosition(at(x - box[0], y - box[1]))
        fp.SetReference(comp.get("ref") or "U?")
        # A plated hole with no net and no copper ring round it is a
        # locating peg, which is an unplated hole. EasyEDA draws the pegs
        # of its USB-C footprints this way, and KiCad reads them as pads
        # with negative annular width that crowd their neighbours.
        for pad in fp.Pads():
            if pad.GetAttribute() != pcbnew.PAD_ATTRIB_PTH or pad.GetNumber():
                continue
            drill = pad.GetDrillSize()
            size = pad.GetSize()
            if min(size.x, size.y) <= min(drill.x, drill.y):
                pad.SetAttribute(pcbnew.PAD_ATTRIB_NPTH)
                pad.SetSize(drill)
        if comp.get("value"):
            fp.SetValue(str(comp["value"]))
        for pad in fp.Pads():
            name = where.get((comp.get("ref"), pad.GetNumber()))
            if name and name in nets:
                pad.SetNet(nets[name])
        board.Add(fp)

    placed, missing, xs, ys = 0, [], [], []
    # A courtyard is already the room a part asks for, so the gap between
    # two of them is routing room, not clearance: eight tenths of a
    # millimetre leaves a 0.25 mm track and its 0.2 mm either side between
    # two 0402s, and the margin is what a connector's pads escape through.
    gap = plan.get("gap", 0.8)                 # between two parts' extents
    margin = plan.get("margin", 1.0)           # from the outermost part to the edge

    comps = plan.get("components", [])
    poses, posed_refs, pose_trouble = plan.get("poses") or {}, [], {}
    loaded = []
    for i, comp in enumerate(comps):
        path = Path(comp["footprint"])
        fp = load(comp, poses, posed_refs, pose_trouble)
        if fp is None:
            missing.append(f"{comp.get('ref')} ({path.stem})")
            continue
        fp.SetPosition(at(0, 0))
        box = extent(fp)
        loaded.append((comp, fp, box))

    # The parts of each module packed as a block of their own, the way a
    # person lays a board out: power in one corner, the USB bridge in
    # another, the MCU in the middle. Connectors are not in any block -
    # they go on the edges, facing out, once the blocks are down.
    groups: dict[str, list] = {}
    connectors = []
    for item in loaded:
        comp, fp, _ = item
        if is_connector(fp):
            connectors.append(item)
        else:
            groups.setdefault(comp.get("group") or "", []).append(item)

    # Which of the eight packings to take, best first, and which set of
    # names to write it under. They are asked for separately: a looser
    # packing is a bigger board and is only worth it when the tightest one
    # cannot be finished, whereas another set of names costs nothing but
    # gives the router a different problem. See `steady`.
    attempt = int(plan.get("attempt", 0))
    salt = int(plan.get("salt", attempt))

    blocks = []                                # (name, parts, spots, w, h)
    for name in sorted(groups, key=lambda g: -len(groups[g])):
        ordered = cluster(groups[name], plan.get("nets", []))
        spots = pack([box for _, _, box in ordered], gap,
                     kinship(ordered, plan.get("nets", [])), attempt)
        w = max((x + box[2] for (_, _, box), (x, _) in zip(ordered, spots)), default=0)
        h = max((y + box[3] for (_, _, box), (_, y) in zip(ordered, spots)), default=0)
        blocks.append((name, ordered, spots, w, h))

    corners = [(20.0 + x, 20.0 + y)
               for x, y in pack([(0, 0, w, h) for *_, w, h in blocks],
                                plan.get("block_gap", 1.0), None, attempt)]
    centre = {}
    for (name, ordered, spots, w, h), (bx, by) in zip(blocks, corners):
        for (comp, fp, box), (x, y) in zip(ordered, spots):
            put(fp, comp, bx + x, by + y, box)
            xs += [bx + x, bx + x + box[2]]
            ys += [by + y, by + y + box[3]]
            placed += 1
        centre[name] = (bx + w / 2, by + h / 2)

    if not xs:
        xs, ys = [20.0], [20.0]
    ix0, ix1 = min(xs) - margin, max(xs) + margin
    iy0, iy1 = min(ys) - margin, max(ys) + margin

    # Each connector to the edge nearest its own module, opening outwards,
    # its opening flush with the edge. Along the edge they queue up rather
    # than overlap.
    edges = {"top": (0, -1), "bottom": (0, 1), "left": (-1, 0), "right": (1, 0)}
    # KiCad's default copper-to-edge clearance, and a little over.
    edge_gap = plan.get("edge_clearance", 0.5) + 0.05
    taken = {e: [] for e in edges}
    flush = {}
    on_edge: dict[str, list] = {}
    for comp, fp, _ in connectors:
        cx, cy = centre.get(comp.get("group") or "", ((ix0 + ix1) / 2, (iy0 + iy1) / 2))
        dist = {"top": cy - iy0, "bottom": iy1 - cy, "left": cx - ix0, "right": ix1 - cx}
        edge = min(dist, key=dist.get)
        face(fp, edges[edge])
        fp.SetPosition(at(0, 0))
        box = extent(fp)
        along = cx if edge in ("top", "bottom") else cy
        size = box[2] if edge in ("top", "bottom") else box[3]
        start = along - size / 2
        for a, b in sorted(taken[edge]):
            if start < b + gap and start + size > a - gap:
                start = b + gap
        taken[edge].append((start, start + size))
        # Flush means the part's outline on the edge - but copper still has
        # to keep its distance from a cut edge. A receptacle's body reaches
        # well past its pads, so flush is fine; a pin header's outline is a
        # hair outside its pads, and flush put them 0.465 mm from the edge
        # where 0.5 is the rule. So measure the copper, and step in by
        # whatever it is short.
        inset = max(0.0, edge_gap - copper_reach(fp, box, edge))
        if edge == "top":
            x, y = start, iy0 - box[3]
        elif edge == "bottom":
            x, y = start, iy1
        elif edge == "left":
            x, y = ix0 - box[2], start
        else:
            x, y = ix1, start
        # The edge is where the flush outline would be; only the part steps
        # in. Drawn around the stepped-in part, the edge came in with it and
        # the gap was the same 0.465 mm as before.
        xs += [x, x + box[2]]
        ys += [y, y + box[3]]
        dx, dy = {"top": (0, inset), "bottom": (0, -inset),
                  "left": (inset, 0), "right": (-inset, 0)}[edge]
        put(fp, comp, x + dx, y + dy, box)
        flush[edge] = True
        on_edge.setdefault(edge, []).append(comp.get("ref"))
        placed += 1

    # The outline: the parts plus a margin, except where a connector sits
    # on the edge - there the edge is the connector's front, so a plug
    # goes all the way in.
    x0 = min(xs) - (0 if flush.get("left") else margin)
    x1 = max(xs) + (0 if flush.get("right") else margin)
    y0 = min(ys) - (0 if flush.get("top") else margin)
    y1 = max(ys) + (0 if flush.get("bottom") else margin)
    out = plan.get("out", "/work/board.kicad_pcb")
    draw_outline(board, x0, y0, x1, y1)

    # The edge is drawn at the connectors' outlines first, because the
    # exporter wants a board before it will say where anything is; then it
    # is brought in to the connectors' own 3D shapes and drawn again.
    trimmed, hanging = {}, {}
    if on_edge and plan.get("cut_to_bodies", True):
        probe = out + ".probe.kicad_pcb"
        pcbnew.SaveBoard(probe, board)
        (x0, y0, x1, y1), trimmed, hanging = cut_to_bodies(
            board, probe, on_edge, (x0, y0, x1, y1),
            plan.get("edge_clearance", 0.5))
        try:
            os.unlink(probe)
        except OSError:
            pass
        if trimmed:
            clear_outline(board)
            draw_outline(board, x0, y0, x1, y1)

    # What the board says about itself is printed on the board: every
    # designator over the part it names, and anything still reaching past
    # the outline pulled back in.
    nudged = label(board, gap, (x0, y0, x1, y1))
    escaped = keep_inside(board, x0, y0, x1, y1)

    edge_rule(board, plan)
    pcbnew.SaveBoard(out, board)
    # Written once for KiCad to name everything, renamed, then written
    # again so KiCad itself puts the footprints in the new order - the
    # order is its business, and hand-sorting the file is how a board
    # stops loading.
    steadied = steady(out, salt)
    pcbnew.SaveBoard(out, pcbnew.LoadBoard(out))
    json.dump({"placed": placed, "missing": missing, "attempt": attempt,
               "salt": salt,
               "uuids": steadied, "trimmed_mm": trimmed,
               "hanging_over_mm": hanging,
               "attempts_available": len(TRIALS),
               "size_mm": [round(x1 - x0, 2), round(y1 - y0, 2)],
               "texts_beside": nudged, "texts_moved_in": escaped,
               **pose_report(poses, comps, posed_refs, pose_trouble),
               "nets": len(nets), "out": out}, sys.stdout)
    return 0


def main_held(plan) -> int:
    """A board whose layout is already decided - one converted from an
    import. Every part goes where it was, the outline is the one given,
    and nothing is packed, turned to face an edge or trimmed: the person
    made this board, and placing it again would be making another.

        plan["hold"] = {"parts": {ref: {"pads": {...}, "at": [x, y],
                                        "rot": deg, "side": "top"}},
                        "outline": [[{"line": ...} | {"arc": ...}, ...]]}
    """
    board = pcbnew.BOARD()
    nets = {}
    for net in plan.get("nets", []):
        name = net.get("name") or ""
        if name and name not in nets:
            item = pcbnew.NETINFO_ITEM(board, name)
            board.Add(item)
            nets[name] = item
    where = {(n["ref"], str(n["pin"])): net["name"]
             for net in plan.get("nets", [])
             for n in net.get("nodes", []) if net.get("name")}
    held = plan["hold"]
    placed, missing, off, unheld, by_centre, fresh = 0, [], {}, [], [], []
    poses, posed_refs, pose_trouble = plan.get("poses") or {}, [], {}
    for comp in plan.get("components", []):
        path = Path(comp["footprint"])
        fp = load(comp, poses, posed_refs, pose_trouble)
        if fp is None:
            missing.append(f"{comp.get('ref')} ({path.stem})")
            continue
        fp.SetReference(comp.get("ref") or "U?")
        if comp.get("value"):
            fp.SetValue(str(comp["value"]))
        want = held["parts"].get(comp.get("ref"))
        if want is None:
            # Not in the import: a part a note added. Placed after the rest.
            unheld.append(comp.get("ref"))
            fresh.append(fp)
            fp.SetPosition(at(0, 0))
        else:
            got = hold(fp, want)
            if got["how"] == "centre":
                by_centre.append(comp["ref"])
            if got["worst_mm"] is not None:
                off[comp["ref"]] = got["worst_mm"]
        # Pegs, as `put` does for a packed board.
        for pad in fp.Pads():
            if pad.GetAttribute() == pcbnew.PAD_ATTRIB_PTH and not pad.GetNumber():
                drill, size = pad.GetDrillSize(), pad.GetSize()
                if min(size.x, size.y) <= min(drill.x, drill.y):
                    pad.SetAttribute(pcbnew.PAD_ATTRIB_NPTH)
                    pad.SetSize(drill)
            name = where.get((comp.get("ref"), pad.GetNumber()))
            if name and name in nets:
                pad.SetNet(nets[name])
        board.Add(fp)
        placed += 1

    # The holes that belong to no part - mounting holes, a tab's hole -
    # where the import's drills had them. Not parts: in no netlist.
    holes = free_holes(board, held.get("holes"), held.get("parts"))
    x0, y0, x1, y1 = draw_edges(board, held["outline"])
    edge_rule(board, plan)
    inset = float(plan.get("min_edge") or 0.5) + 0.25
    placed_new = place_new(board, fresh, where, (x0 + inset, y0 + inset, x1 - inset, y1 - inset)) \
        if fresh else {}
    nudged = label(board, plan.get("gap", 0.8), (x0, y0, x1, y1))
    escaped = keep_inside(board, x0, y0, x1, y1)
    out = plan.get("out", "/work/board.kicad_pcb")
    salt = int(plan.get("salt", plan.get("attempt", 0)))
    pcbnew.SaveBoard(out, board)
    steadied = steady(out, salt)
    pcbnew.SaveBoard(out, pcbnew.LoadBoard(out))
    worst = max(off.values(), default=None)
    json.dump({"placed": placed, "missing": missing, "attempt": int(plan.get("attempt", 0)),
               "salt": salt, "uuids": steadied, "held": True,
               # How far each part's pads are from where the imported board
               # had them: the proof that the layout was kept.
               "held_worst_mm": worst,
               "held_off": {r: v for r, v in sorted(off.items(), key=lambda kv: -kv[1])
                            if v > 0.05},
               # Parts with too few numbered pads to fit, put by centre and angle.
               "held_by_centre": by_centre,
               "not_held": unheld, "attempts_available": 1,
               # Parts the import did not have, and where they went: [x, y, rot]
               # on KiCad's page, or None when the board had no room for one.
               "placed_new": placed_new,
               "size_mm": [round(x1 - x0, 2), round(y1 - y0, 2)],
               "texts_beside": nudged, "texts_moved_in": escaped,
               "holes": holes,
               **pose_report(poses, plan.get("components", []), posed_refs, pose_trouble),
               "nets": len(nets), "out": out}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
