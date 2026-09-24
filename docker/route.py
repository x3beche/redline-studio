"""Route a placed board. Runs inside the KiCad container.

    python3 route.py < plan.json

The plan names a placed board and the rules. The rules go onto the board
as net classes - track width, clearance, via, and pair width and gap -
because that is what KiCad writes into the Specctra DSN and what
Freerouting routes to. Then:

    board -> DSN -> Freerouting -> SES -> board

and a ground pour on both layers, filled, which ties together whatever
ground the router left as short stubs.

Freerouting routes a differential pair as two nets at the class's width
and clearance. It does not couple them or match their lengths. For USB
full speed on a board this size that is fine; for anything fast it is
not, and the rules panel says so.
"""

import json
import subprocess
import sys
import time

import pcbnew

MM = 1_000_000


def nm(mm: float) -> int:
    return int(round(mm * MM))


def narrowest_pad(board, nets: set) -> tuple[float, str]:
    """The smallest pad a class has to reach, in mm, and whose it is.

    Freerouting cannot neck a track down to meet a pad: a 0.5 mm power
    track simply never reaches a 0.35 mm pin on a 0.65 mm-pitch chip, and
    the pin is left unrouted. So a class is only as wide as its narrowest
    pad allows.
    """
    best, who = 1e9, ""
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            if pad.GetNetname() not in nets:
                continue
            size = pad.GetSize()
            short = min(size.x, size.y) / MM
            if 0 < short < best:
                best, who = short, f"{fp.GetReference()} pad {pad.GetNumber()}"
    return best, who


def apply_rules(board, rules) -> list[str]:
    """Net classes onto the board, and the board's minimums."""
    ds = board.GetDesignSettings()
    ns = ds.m_NetSettings
    notes = []
    for cls in rules.get("classes", []):
        nets = set(cls.get("nets", []))
        if not nets:
            continue
        pad, who = narrowest_pad(board, nets)
        if cls["track"] > pad:
            fit = max(rules.get("board", {}).get("min_track", 0.15),
                      round(pad - 0.02, 2))
            notes.append(f"{cls['name']}: {cls['track']} -> {fit} mm, to reach "
                         f"{who} ({pad:.2f} mm)")
            cls["track"] = fit
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
    ns.RecomputeEffectiveNetclasses()
    board.SynchronizeNetsAndNetClasses(True)
    return notes


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
    inset = nm(0.3)
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


def main() -> int:
    plan = json.load(sys.stdin)
    path = plan["board"]
    board = pcbnew.LoadBoard(path)
    rules = plan["rules"]

    notes = apply_rules(board, rules)
    # The pour goes on after routing: routed into, it would stand in the
    # router's way; poured afterwards it fills around the tracks.
    for zone in list(board.Zones()):
        board.Remove(zone)

    dsn, ses = "/work/board.dsn", "/work/board.ses"
    if not pcbnew.ExportSpecctraDSN(board, dsn):
        print(json.dumps({"error": "KiCad could not write the DSN"}))
        return 1

    t0 = time.monotonic()
    passes = int(rules.get("route", {}).get("passes", 40))
    run = subprocess.run(
        ["java", "-Djava.awt.headless=true", "-jar", "/opt/freerouting.jar",
         "-de", dsn, "-do", ses, "-mp", str(passes)],
        capture_output=True, text=True, timeout=plan.get("timeout", 900))
    routed_s = time.monotonic() - t0
    log = (run.stdout + run.stderr)[-3000:]
    try:
        open(ses).close()
    except OSError:
        print(json.dumps({"error": "Freerouting wrote no session",
                          "log": log, "rc": run.returncode}))
        return 1

    if not pcbnew.ImportSpecctraSES(board, ses):
        print(json.dumps({"error": "KiCad could not read the session back",
                          "log": log}))
        return 1

    zones = pours(board, rules.get("pours")
                  or ([rules["pour"]] if rules.get("pour") else []))
    tracks = [t for t in board.GetTracks() if t.GetClass() == "PCB_TRACK"]
    vias = [t for t in board.GetTracks() if t.GetClass() == "PCB_VIA"]
    length = sum(t.GetLength() for t in tracks) / MM

    board.BuildConnectivity()
    unrouted = board.GetConnectivity().GetUnconnectedCount(False)

    pcbnew.SaveBoard(plan.get("out", path), board)
    print(json.dumps({
        "tracks": len(tracks), "vias": len(vias),
        "length_mm": round(length, 1), "zones": zones,
        "unrouted": unrouted, "route_s": round(routed_s, 1),
        "passes": passes, "notes": notes, "log": log[-1500:],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
