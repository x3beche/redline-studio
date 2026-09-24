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
import re
import sys
import uuid as uuids
from pathlib import Path

import pcbnew

MM = 1_000_000                      # KiCad works in nanometres


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


def main() -> int:
    plan = json.load(sys.stdin)
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
    loaded = []
    for i, comp in enumerate(comps):
        path = Path(comp["footprint"])
        fp = pcbnew.FootprintLoad(str(path.parent), path.stem)
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

    # Which of the eight packings to take, best first. A pipeline that
    # came up a connection short asks for the next one.
    attempt = int(plan.get("attempt", 0))

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
        placed += 1

    # The outline: the parts plus a margin, except where a connector sits
    # on the edge - there the edge is the connector's front, so a plug
    # goes all the way in.
    x0 = min(xs) - (0 if flush.get("left") else margin)
    x1 = max(xs) + (0 if flush.get("right") else margin)
    y0 = min(ys) - (0 if flush.get("top") else margin)
    y1 = max(ys) + (0 if flush.get("bottom") else margin)
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

    # What the board says about itself is printed on the board: every
    # designator over the part it names, and anything still reaching past
    # the outline pulled back in.
    nudged = label(board, gap, (x0, y0, x1, y1))
    escaped = keep_inside(board, x0, y0, x1, y1)

    out = plan.get("out", "/work/board.kicad_pcb")
    pcbnew.SaveBoard(out, board)
    # Written once for KiCad to name everything, renamed, then written
    # again so KiCad itself puts the footprints in the new order - the
    # order is its business, and hand-sorting the file is how a board
    # stops loading.
    steadied = steady(out, attempt)
    pcbnew.SaveBoard(out, pcbnew.LoadBoard(out))
    json.dump({"placed": placed, "missing": missing, "attempt": attempt,
               "uuids": steadied,
               "attempts_available": len(TRIALS),
               "size_mm": [round(x1 - x0, 2), round(y1 - y0, 2)],
               "texts_beside": nudged, "texts_moved_in": escaped,
               "nets": len(nets), "out": out}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
