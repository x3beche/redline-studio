"""Run inside the KiCad container: open a board file with KiCad's own
importers and say what is on it.

KiCad reads its own boards and, through its IO plugins, EasyEDA (Std and
Pro), Altium, Eagle, CADSTAR, P-CAD, Fabmaster, IPC-2581 and ODB++. This
script is ours; it only calls pcbnew's Python API, the way a user's
script would. Reads one JSON object on stdin:

    {"input": "/work/in/board.PcbDoc", "plugin": "ALTIUM_DESIGNER" | null,
     "out": "/work/board.kicad_pcb"}

loads the board, saves it as a .kicad_pcb (which kicad-cli then draws),
and prints one JSON object: the netlist graph (SPEC §5 shape), where
each part sits, the board's size, the drill table and the copper counts.
"""

import json
import sys

import pcbnew

MM = 1e-6          # KiCad's internal unit is the nanometre


def mm(v):
    return round(v * MM, 4)


def plugin_type(name, path):
    mgr = pcbnew.PCB_IO_MGR
    if name:
        return getattr(mgr, name)
    return mgr.FindPluginTypeFromBoardPath(path)


def load(path, kind):
    mgr = pcbnew.PCB_IO_MGR
    if kind == mgr.KICAD_SEXP:
        return pcbnew.LoadBoard(path)
    # PCB_IO_MGR.Load(type, path) is the importers' front door: the same
    # call KiCad's File > Import makes.
    return mgr.Load(kind, path)


def field(fp, *names):
    for n in names:
        try:
            if fp.HasFieldByName(n):
                v = fp.GetFieldText(n) if hasattr(fp, "GetFieldText") else fp.GetFieldByName(n).GetText()
                if v and v.strip() and v.strip() not in ("~",):
                    return v.strip()
        except Exception:                         # noqa: BLE001
            pass
    return None


def main():
    job = json.loads(sys.stdin.read())
    kind = plugin_type(job.get("plugin"), job["input"])
    if kind in (pcbnew.PCB_IO_MGR.FILE_TYPE_NONE, getattr(pcbnew.PCB_IO_MGR, "PCB_FILE_UNKNOWN", -1)):
        print(json.dumps({"error": "KiCad does not recognise this file as a board"}))
        return 2
    plugin = pcbnew.PCB_IO_MGR.PluginFind(kind)
    name = pcbnew.PCB_IO_MGR.ShowType(kind)
    try:
        if plugin is not None and hasattr(plugin, "CanReadBoard") \
                and not plugin.CanReadBoard(job["input"]):
            print(json.dumps({"error": f"KiCad's {name} importer cannot read this file "
                                       f"(KiCad {pcbnew.Version()} may only write this format)"}))
            return 2
    except Exception:                                   # noqa: BLE001
        pass
    try:
        board = load(job["input"], kind)
    except Exception as exc:                            # noqa: BLE001
        print(json.dumps({"error": f"KiCad's {name} importer failed: {exc}"}))
        return 2
    if board is None:
        print(json.dumps({"error": "KiCad could not load the board"}))
        return 2
    board.BuildConnectivity()

    edges = board.GetBoardEdgesBoundingBox()
    x0, y0 = edges.GetX(), edges.GetY()
    w, h = edges.GetWidth(), edges.GetHeight()
    if w <= 0 or h <= 0:
        bb = board.ComputeBoundingBox(False)
        x0, y0, w, h = bb.GetX(), bb.GetY(), bb.GetWidth(), bb.GetHeight()

    comps, placement, nets = [], [], {}
    for fp in board.GetFootprints():
        ref = fp.GetReference()
        if not ref:
            continue
        fpid = fp.GetFPID()
        foot = str(fpid.GetLibItemName()) if fpid else None
        lib = str(fpid.GetLibNickname()) if fpid else ""
        comps.append({
            "ref": ref,
            "value": fp.GetValue() or None,
            "footprint": (f"{lib}:{foot}" if lib else foot) or None,
            "part": field(fp, "LCSC Part", "LCSC", "JLCPCB Part", "LCSC Part #",
                          "Supplier Part", "MPN", "Manufacturer Part"),
            "where": None,
        })
        pos = fp.GetPosition()
        placement.append({
            "ref": ref,
            # From the board's lower-left corner, y up, seen from the top.
            "x": mm(pos.x - x0), "y": mm(y0 + h - pos.y),
            "rot": round(fp.GetOrientationDegrees(), 3),
            "side": "bottom" if fp.IsFlipped() else "top",
        })
        for pad in fp.Pads():
            num = str(pad.GetNumber())
            net = pad.GetNet()
            if not num or net is None or net.GetNetCode() <= 0:
                continue
            name = net.GetNetname()
            entry = nets.setdefault(name, {"name": name, "code": str(net.GetNetCode()),
                                           "nodes": []})
            node = {"ref": ref, "pin": num}
            if node not in entry["nodes"]:
                entry["nodes"].append(node)

    drills, tracks, vias, length = {}, 0, 0, 0.0
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            size = pad.GetDrillSize()
            if size.x <= 0:
                continue
            plated = pad.GetAttribute() != pcbnew.PAD_ATTRIB_NPTH
            key = (mm(size.x), mm(size.y) if size.y != size.x else None, plated)
            drills[key] = drills.get(key, 0) + 1
    for t in board.GetTracks():
        if t.GetClass() == "PCB_VIA":
            vias += 1
            d = mm(t.GetDrillValue())
            drills[(d, None, True)] = drills.get((d, None, True), 0) + 1
        else:
            tracks += 1
            length += t.GetLength() * MM

    pcbnew.SaveBoard(job["out"], board)
    copper = [pcbnew.BOARD.GetStandardLayerName(l) if hasattr(pcbnew.BOARD, "GetStandardLayerName")
              else board.GetLayerName(l) for l in board.GetEnabledLayers().CuStack()]
    out = {
        "plugin": pcbnew.PCB_IO_MGR.ShowType(kind),
        "size_mm": [mm(w), mm(h)],
        "graph": {"components": comps,
                  "nets": sorted(nets.values(), key=lambda n: int(n["code"]))},
        "placement": placement,
        "drills": [{"diameter_mm": k[0], "slot_mm": k[1], "plated": k[2], "count": n}
                   for k, n in sorted(drills.items(), key=lambda kv: (not kv[0][2], kv[0][0]))],
        "route": {"tracks": tracks, "vias": vias, "length_mm": round(length, 1),
                  "zones": len(list(board.Zones()))},
        "copper_layers": copper,
    }
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
