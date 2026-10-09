"""Route a placed board. Runs inside the KiCad container.

    python3 route.py < plan.json

The plan names a placed board and the rules. The rules go onto the board
as net classes - track width, clearance, via, and pair width and gap -
because that is what KiCad writes into the Specctra DSN and what
Freerouting routes to. Then:

    board -> DSN -> Freerouting -> SES -> board

and the pours the rules ask for, filled after routing.

Nothing here decides a number. A rule the board cannot meet - a track wider
than a pad it has to reach - stops the run with the reason, and the person
or the agent changes the rule.

Freerouting routes a differential pair as two nets at the class's width
and clearance. It does not couple them or match their lengths. For USB
full speed on a board this size that is fine; for anything fast it is
not, and the rules panel says so.
"""

import json
import os
import re
import subprocess
import sys
import time

import pcbnew

MM = 1_000_000


def nm(mm: float) -> int:
    return int(round(mm * MM))


def discard(container, item) -> None:
    """Take an item off a board (or a footprint) and free it in C++.

    Not `Remove()`: that hands the C++ object to its Python wrapper, and
    when Python later collects the wrapper, KiCad 9's bindings run outside
    KiCad lose their type table - every object asked for after that comes
    back as a bare SwigPyObject (`board.GetTracks()`: "'SwigPyObject'
    object is not iterable"; a bounding box with no GetX). The pipeline's
    placed boards have no zones to take off, so only a board run by hand -
    an imported one, with its pours - met it. `Delete()` lets the
    container free the item, and nothing is left for Python to collect.
    """
    container.Delete(item)


def pad_limits(board) -> dict:
    """The narrowest pad on each net, in mm, and whose it is.

    Freerouting cannot neck a track down to meet a pad: a 0.5 mm track
    never reaches a 0.35 mm pin on a 0.65 mm-pitch chip, and the pin is
    left unrouted. So a class can be no wider than the narrowest pad on
    any of its nets. This is measured and reported - the rules are the
    person's, and the router does not change them.
    """
    out = {}
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            net = pad.GetNetname()
            if not net:
                continue
            size = pad.GetSize()
            if pad.GetShape() == pcbnew.PAD_SHAPE_CUSTOM:
                # A custom pad's size is only its anchor - an exposed pad
                # drawn as a polygon read as 0.005 mm wide. Its outline is
                # the pad.
                box = pad.GetBoundingBox()
                size = pcbnew.VECTOR2I(box.GetWidth(), box.GetHeight())
            short = round(min(size.x, size.y) / MM, 3)
            if short > 0 and (net not in out or short < out[net]["width"]):
                out[net] = {"width": short,
                            "who": f"{fp.GetReference()} pad {pad.GetNumber()}"}
    return out


def too_wide(rules, pads) -> list[str]:
    """Classes whose track cannot reach one of their pads."""
    out = []
    for cls in rules.get("classes", []):
        for net in cls.get("nets", []):
            lim = pads.get(net)
            if lim and cls["track"] > lim["width"]:
                out.append(f"classes.{cls['name']}.track: {cls['track']} mm will not reach "
                           f"{lim['who']} on {net} ({lim['width']} mm wide) - at most "
                           f"{lim['width']} mm, or put {net} in a narrower class")
    return out


def apply_rules(board, rules) -> None:
    """Net classes onto the board, and the board's minimums."""
    ds = board.GetDesignSettings()
    ns = ds.m_NetSettings
    pairs = {p["p"]: p for p in rules.get("pairs", [])}
    pairs.update({p["n"]: p for p in rules.get("pairs", [])})

    for cls in rules.get("classes", []):
        if cls["name"] == "Default":
            nc = ns.GetDefaultNetclass()
        else:
            nc = pcbnew.NETCLASS(cls["name"])
        nc.SetTrackWidth(nm(cls["track"]))
        nc.SetClearance(nm(cls["clearance"]))
        nc.SetViaDiameter(nm(cls["via"]))
        nc.SetViaDrill(nm(cls["drill"]))
        pair = next((pairs[n] for n in cls.get("nets", []) if n in pairs), None)
        if pair:
            nc.SetDiffPairWidth(nm(pair["width"]))
            nc.SetDiffPairGap(nm(pair["gap"]))
        if cls["name"] != "Default":
            ns.SetNetclass(cls["name"], nc)
        for net in cls.get("nets", []):
            ns.SetNetclassPatternAssignment(net, cls["name"])

    b = rules.get("board", {})
    ds.m_TrackMinWidth = nm(b.get("min_track", 0.15))
    ds.m_MinClearance = nm(b.get("min_clearance", 0.15))
    ds.m_ViasMinSize = nm(b.get("min_via", 0.6))
    ds.m_MinThroughDrill = nm(b.get("min_drill", 0.3))
    # Copper to the board's edge (rules.py board.min_edge). Unset, KiCad's
    # 0.5 mm applied to every board, whatever its maker had done.
    ds.m_CopperEdgeClearance = nm(b.get("min_edge", 0.5))
    ns.RecomputeEffectiveNetclasses()
    board.SynchronizeNetsAndNetClasses(True)


def edge_parts(board, clearance_mm: float) -> list[str]:
    """Parts with copper nearer the board's edge than the rule allows.

    On a board kept as it was imported, those are where their maker put
    them - a button or a USB shell flush with the edge is the design - and
    the router never moves a pad. They are named here so DRC can let them
    be (`edge_rules`), and only them: a track or a pour is still held to
    the rule.
    """
    edges = [d.GetEffectiveShape() for d in board.GetDrawings()
             if d.GetLayer() == pcbnew.Edge_Cuts]
    if not edges:
        return []
    gap = nm(clearance_mm)
    out = []
    for fp in board.GetFootprints():
        near = False
        for pad in fp.Pads():
            for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
                if not pad.IsOnLayer(layer):
                    continue
                shape = pad.GetEffectiveShape(layer)
                if any(e.Collide(shape, gap) for e in edges):
                    near = True
                    break
            if near:
                break
        if near:
            out.append(fp.GetReference())
    return sorted(out)


def edge_rules(refs: list[str]) -> str:
    """A custom DRC rule (board.kicad_dru, read beside the board) that lets
    these parts' own copper sit at the edge."""
    if not refs:
        return ""
    cond = " || ".join(f"A.memberOfFootprint('{r}') || B.memberOfFootprint('{r}')"
                       for r in (x.replace("'", "") for x in refs))
    return ("(version 1)\n"
            "(rule \"edge: parts kept where the import had them\"\n"
            "  (constraint edge_clearance (min 0mm))\n"
            f"  (condition \"{cond}\")\n"
            "  (severity ignore))\n")


def pours(board, specs) -> int:
    """Every pour, the first in the list on top where two meet."""
    made = 0
    for i, spec in enumerate(specs):
        made += pour(board, spec, priority=len(specs) - i)
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    return made


def pour(board, spec, priority=0) -> int:
    """A zone per layer on one net, covering the board."""
    if not spec or not spec.get("net"):
        return 0
    net = board.FindNet(spec["net"])
    if net is None:
        return 0
    box = board.GetBoardEdgesBoundingBox()
    inset = nm(spec.get("edge", 0.3))
    x0, y0 = box.GetX() + inset, box.GetY() + inset
    x1, y1 = box.GetRight() - inset, box.GetBottom() - inset
    layers = {"F.Cu": pcbnew.F_Cu, "B.Cu": pcbnew.B_Cu}
    made = 0
    for name in spec.get("layers", ["F.Cu", "B.Cu"]):
        zone = pcbnew.ZONE(board)
        zone.SetLayer(layers[name])
        zone.SetNetCode(net.GetNetCode())
        zone.SetAssignedPriority(priority)
        zone.SetLocalClearance(nm(spec.get("clearance", 0.3)))
        zone.SetMinThickness(nm(0.2))
        # Solid by default: thermal spokes crowded by tracks come out
        # "starved" - one spoke where two were asked for - and a solid
        # joint is what reflow wants anyway. Hand-soldering a connector's
        # ground pin to it takes a hotter iron; "thermal" is the choice.
        zone.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL
                              if spec.get("connection") == "thermal"
                              else pcbnew.ZONE_CONNECTION_FULL)
        outline = zone.Outline()
        outline.NewOutline()
        for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
            outline.Append(x, y)
        outline.Outline(0).SetClosed(True)
        board.Add(zone)
        made += 1
    return made


def geometry(board) -> dict:
    """The routed board as data, for looking at it in the page: every
    track, via and pad with its net, in mm. `box` is the area the SVG
    exporter crops to (page-size-mode 2), so a point here lands on the
    same point of the drawing."""
    r = lambda v: round(v / MM, 4)
    box = board.ComputeBoundingBox(False)
    shapes = {pcbnew.PAD_SHAPE_CIRCLE: "circle", pcbnew.PAD_SHAPE_OVAL: "oval",
              pcbnew.PAD_SHAPE_RECTANGLE: "rect",
              pcbnew.PAD_SHAPE_ROUNDRECT: "roundrect"}
    tracks, vias, pads, parts = [], [], [], []
    for t in board.GetTracks():
        if t.GetClass() == "PCB_VIA":
            p = t.GetPosition()
            vias.append({"x": r(p.x), "y": r(p.y), "d": r(t.GetWidth(pcbnew.F_Cu)),
                         "drill": r(t.GetDrillValue()), "net": t.GetNetname()})
        else:
            a, b = t.GetStart(), t.GetEnd()
            tracks.append({"x1": r(a.x), "y1": r(a.y), "x2": r(b.x), "y2": r(b.y),
                           "w": r(t.GetWidth()), "layer": t.GetLayerName(),
                           "net": t.GetNetname()})
    for fp in board.GetFootprints():
        bb = fp.GetBoundingBox(False)
        parts.append({"ref": fp.GetReference(), "value": fp.GetValue(),
                      "side": "B" if fp.IsFlipped() else "F",
                      "box": [r(bb.GetX()), r(bb.GetY()), r(bb.GetWidth()), r(bb.GetHeight())]})
        for pad in fp.Pads():
            p, sz = pad.GetPosition(), pad.GetSize()
            side = ("FB" if pad.IsOnLayer(pcbnew.F_Cu) and pad.IsOnLayer(pcbnew.B_Cu)
                    else "B" if pad.IsOnLayer(pcbnew.B_Cu) else "F")
            pads.append({"x": r(p.x), "y": r(p.y), "w": r(sz.x), "h": r(sz.y),
                         "angle": round(pad.GetOrientationDegrees(), 2),
                         "shape": shapes.get(pad.GetShape(), "rect"), "side": side,
                         "net": pad.GetNetname(), "ref": fp.GetReference(),
                         "num": pad.GetNumber(), "pin": pad.GetPinFunction(),
                         "drill": r(pad.GetDrillSize().x) if pad.GetDrillSize().x else 0})
    return {"box": [r(box.GetX()), r(box.GetY()), r(box.GetWidth()), r(box.GetHeight())],
            "tracks": tracks, "vias": vias, "pads": pads, "parts": parts}


def freeroute(board, passes: int, timeout: int, stem: str = "board") -> dict:
    """board -> DSN -> Freerouting -> SES -> board. Returns the log, the
    nets Freerouting said it left unrouted, and an error if it failed."""
    dsn, ses = f"/work/{stem}.dsn", f"/work/{stem}.ses"
    if not pcbnew.ExportSpecctraDSN(board, dsn):
        return {"error": "KiCad could not write the DSN"}
    run = subprocess.run(
        ["java", "-Djava.awt.headless=true", "-jar", "/opt/freerouting.jar",
         "-de", dsn, "-do", ses, "-mp", str(passes)],
        capture_output=True, text=True, timeout=timeout)
    log = run.stdout + run.stderr
    try:
        open(ses).close()
    except OSError:
        return {"error": "Freerouting wrote no session", "log": log[-3000:], "rc": run.returncode}
    if not pcbnew.ImportSpecctraSES(board, ses):
        return {"error": "KiCad could not read the session back", "log": log[-3000:]}
    return {"log": log, "left": left_unrouted(log)}


def left_unrouted(log: str) -> list[str]:
    """The nets Freerouting names as still unconnected when it stops:
    `  Net 'L_SCL' (1 unrouted connection):`."""
    return sorted(set(re.findall(r"Net '([^']+)' \(\d+ unrouted", log or "")))


def unrouted_count(board) -> int:
    board.BuildConnectivity()
    return board.GetConnectivity().GetUnconnectedCount(False)


def leftovers_first(path: str, rules: dict, nets: list[str], passes: int, timeout: int):
    """Route the connections a first pass left over *before* everything
    else, then the rest around them.

    Freerouting routes in its own order, and a net routed early can wall a
    pad in: on the demo board a ground track run straight down from the
    header's GND pin, and the 3.3 V beside it, boxed the I2C header's SCL
    pad in on both layers, so it was the one connection left, on every
    try - more passes changed nothing, the router stops once its score
    stops moving. So: the leftover nets alone on the placed board (every
    other pad still there, on no net, as an obstacle), routed while the
    board is empty (alone_in_turn); their tracks put back locked -
    Freerouting routes round a locked track and leaves it be - and the
    whole board routed round them. The caller keeps whichever came out
    with fewer unrouted.
    """
    first, got = alone_in_turn(path, rules, nets, passes, timeout)
    if got.get("error"):
        return None, got

    board = pcbnew.LoadBoard(path)
    apply_rules(board, rules)
    for zone in list(board.Zones()):
        discard(board, zone)
    copy_tracks(board, first, locked=True)
    got = freeroute(board, passes, timeout, "second")
    if got.get("error"):
        return None, got
    # Reading a session back keeps a locked track; should a KiCad not, the
    # leftovers' tracks go back in. Either way they are let go of after.
    copy_tracks(board, first, locked=False)
    for t in board.GetTracks():
        t.SetLocked(False)
    return board, got


ALONE_ORDERS = 6
# Rounds of leftovers_first after the first pass. A second round, with
# what the first left added, was tried on the demo board: twelve minutes
# a layout and no better (4 -> 3), so one.
LEFTOVER_ROUNDS = 1


def alone_in_turn(path: str, rules: dict, nets: list[str], passes: int, timeout: int):
    """The leftover nets routed on the otherwise empty board, one at a
    time, each round the tracks of the ones before it.

    Two of them can still fight over one gap: on the demo board the I2C
    header's SDA and SCL pads both have to pass a battery holder's peg
    hole, one on each side of it, and routed together Freerouting sent SCL
    the side SDA needed and SDA was left - while each alone routed. So
    the order is tried - each net first in turn, forwards and backwards,
    up to ALONE_ORDERS of them, a few seconds each on a board this empty -
    and the first in which every one routes wins, else the one that left
    fewest."""
    orders = []
    for k in range(len(nets)):                     # each net first once, then reversed
        for o in (tuple(nets[k:] + nets[:k]), tuple(reversed(nets[k:] + nets[:k]))):
            if o not in orders:
                orders.append(o)
    orders = orders[:ALONE_ORDERS]
    best = None
    for order in orders:
        items, failed, got = [], 0, {}
        for i, net in enumerate(order):
            keep = set(order[:i + 1])
            alone = pcbnew.LoadBoard(path)
            apply_rules(alone, rules)
            for zone in list(alone.Zones()):
                discard(alone, zone)
            for fp in alone.GetFootprints():
                for pad in fp.Pads():
                    if pad.GetNetname() and pad.GetNetname() not in keep:
                        pad.SetNetCode(0)
            # The nets before this one: routed, and locked where they are.
            copy_tracks(alone, items, locked=True)
            got = freeroute(alone, passes, timeout, "leftovers")
            if got.get("error"):
                return [], got
            items += track_data(t for t in alone.GetTracks() if t.GetNetname() == net)
            # KiCad's count, not Freerouting's list: Freerouting names a
            # net whose locked tracks already join it as still unrouted.
            failed += unrouted_count(alone) > 0
        if best is None or failed < best[0]:
            best = (failed, items, got)
        if not failed:
            break
    return best[1], best[2]


def track_data(tracks) -> list[dict]:
    """Tracks and vias as plain data, to outlive the board they came from."""
    out = []
    for t in tracks:
        a, b = t.GetStart(), t.GetEnd()
        via = t.GetClass() == "PCB_VIA"
        out.append({"net": t.GetNetname(), "via": via, "layer": t.GetLayer(),
                    "start": (a.x, a.y), "end": (b.x, b.y),
                    "width": t.GetWidth(pcbnew.F_Cu) if via else t.GetWidth(),
                    "drill": t.GetDrillValue() if via else 0})
    return out


def copy_tracks(board, items: list[dict], locked: bool) -> None:
    """Tracks and vias (track_data) onto a board, on the nets of the same
    names. One already there - same net, kind, layer and ends - is not
    doubled."""
    there = {(t.GetNetname(), t.GetClass() == "PCB_VIA", t.GetLayer(),
              (t.GetStart().x, t.GetStart().y), (t.GetEnd().x, t.GetEnd().y))
             for t in board.GetTracks()}
    for t in items:
        net = board.FindNet(t["net"])
        if net is None or (t["net"], t["via"], t["layer"], t["start"], t["end"]) in there:
            continue
        if t["via"]:
            item = pcbnew.PCB_VIA(board)
            item.SetPosition(pcbnew.VECTOR2I(*t["start"]))
            item.SetWidth(pcbnew.F_Cu, t["width"])
            item.SetDrill(t["drill"])
            item.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        else:
            item = pcbnew.PCB_TRACK(board)
            item.SetStart(pcbnew.VECTOR2I(*t["start"]))
            item.SetEnd(pcbnew.VECTOR2I(*t["end"]))
            item.SetWidth(t["width"])
            item.SetLayer(t["layer"])
        item.SetNet(net)
        item.SetLocked(locked)
        board.Add(item)


def main() -> int:
    plan = json.load(sys.stdin)
    path = plan["board"]
    board = pcbnew.LoadBoard(path)
    rules = plan["rules"]

    pads = pad_limits(board)
    problems = too_wide(rules, pads)
    if problems:
        # Said, not fixed: which number to change is the person's call.
        print(json.dumps({"error": "rules", "problems": problems, "pads": pads}))
        return 0
    apply_rules(board, rules)
    # The pour goes on after routing: routed into, it would stand in the
    # router's way; poured afterwards it fills around the tracks.
    for zone in list(board.Zones()):
        discard(board, zone)

    if plan.get("stage") == "prepare":
        # TraceMaker routes in a container of its own (docker/tm_relay.py):
        # the board goes to it with the rules on as net classes and no
        # pour, and comes back to `finish` here.
        pre = plan["pre"]
        # SaveBoard writes the net classes into the .kicad_pro beside it -
        # KiCad keeps them in the project, not the board - and that is
        # where TraceMaker reads them from.
        pcbnew.SaveBoard(pre, board)
        print(json.dumps({"prepared": pre, "pads": pads}))
        return 0
    if plan.get("stage") == "finish":
        routed = pcbnew.LoadBoard(plan["routed"])
        apply_rules(routed, rules)
        for zone in list(routed.Zones()):
            discard(routed, zone)
        return finish(routed, plan, rules, pads, plan.get("route_s") or 0.0,
                      (plan.get("log") or "")[-3000:], None, engine="tracemaker")

    t0 = time.monotonic()
    passes = int(rules.get("route", {}).get("passes", 40))
    timeout = plan.get("timeout", 900)
    got = freeroute(board, passes, timeout)
    if got.get("error"):
        print(json.dumps({k: v for k, v in got.items() if k != "left"}))
        return 1
    log = got["log"][-3000:]
    unrouted = unrouted_count(board)

    # What the first pass left: routed first, the rest round it, kept if
    # it comes out better (leftovers_first) - and again with what that
    # left, up to LEFTOVER_ROUNDS.
    second = None
    # A net that is poured afterwards is joined by the pour where its
    # tracks are not: not a leftover to route first.
    poured = {p.get("net") for p in (rules.get("pours") or [])} | \
        ({rules["pour"].get("net")} if rules.get("pour") else set())
    left = [n for n in got["left"] if n not in poured]
    if unrouted and left and plan.get("leftovers", True):
        second = {"nets": [], "unrouted_before": unrouted, "rounds": 0}
        for _ in range(LEFTOVER_ROUNDS):
            second["rounds"] += 1
            second["nets"] = sorted(set(second["nets"]) | set(left))
            better, again = leftovers_first(path, rules, second["nets"], passes, timeout)
            if better is None:
                second["error"] = again.get("error")
                break
            after = unrouted_count(better)
            if after < unrouted:
                board, unrouted = better, after
                log = again["log"][-3000:]
                second["kept"] = True
            second["unrouted_after"] = unrouted
            left = [n for n in again.get("left") or [] if n not in poured]
            if not unrouted or not left:
                break
    routed_s = time.monotonic() - t0
    return finish(board, plan, rules, pads, routed_s, log, second, engine="freerouting", passes=passes)


def finish(board, plan: dict, rules: dict, pads: dict, routed_s: float, log: str, second,
           engine: str, passes: int | None = None) -> int:
    """Pour, count, save and report a routed board - whichever router routed it."""
    path = plan["board"]
    zones = pours(board, rules.get("pours")
                  or ([rules["pour"]] if rules.get("pour") else []))
    tracks = [t for t in board.GetTracks() if t.GetClass() == "PCB_TRACK"]
    vias = [t for t in board.GetTracks() if t.GetClass() == "PCB_VIA"]
    length = sum(t.GetLength() for t in tracks) / MM

    unrouted = unrouted_count(board)

    out = plan.get("out", path)
    pcbnew.SaveBoard(out, board)
    # A held board: the parts its maker put at the edge are let be by DRC.
    exempt = edge_parts(board, rules.get("board", {}).get("min_edge", 0.5)) \
        if plan.get("held") else []
    dru = os.path.splitext(out)[0] + ".kicad_dru"
    if exempt:
        with open(dru, "w") as f:
            f.write(edge_rules(exempt))
    elif os.path.exists(dru):
        os.remove(dru)
    shape = geometry(board)
    print(json.dumps({
        "tracks": len(tracks), "vias": len(vias),
        "length_mm": round(length, 1), "zones": zones,
        "unrouted": unrouted, "route_s": round(routed_s, 1),
        "passes": passes, "pads": pads, "geometry": shape, "log": log[-1500:],
        "edge_exempt": exempt, "leftovers": second, "engine": engine,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
