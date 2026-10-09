"""board_read: a board's BOM, nets, DRC/ERC, rules and layout figures - the
block an @-mention of it gives (backend/cc_context.py `board_parts`), a
section at a time if asked, with the Analytics tab's figures
(backend/board_stats.py) - or the workspace's boards when none is named."""

from __future__ import annotations

from .. import ato, board_stats, cc_context
from . import MAX_TEXT, Ctx, Result, Tool, ToolError, clip
from ._things import find, rows

SECTIONS = cc_context.BOARD_SECTIONS
MAX_NETS = 40                       # nets a name filter shows with their pins


def _pins(n: dict) -> str:
    out = []
    for node in n.get("nodes") or []:
        if isinstance(node, dict):
            ref = node.get("ref") or node.get("component") or "?"
            pin = node.get("pin") or node.get("pad") or node.get("name") or ""
            out.append(f"{ref}.{pin}" if pin else str(ref))
        else:
            out.append(str(node))
    return ", ".join(out)


async def _listing(ctx: Ctx) -> Result:
    found = await rows(ctx.db, ato.BOARDS, ("title", "folder", "component", "drc", "schematic"))
    if not found:
        return Result(text="There are no boards in this workspace.", say="No boards here", summary="none")
    lines = []
    for d in found:
        drc = d.get("drc") or {}
        erc = (d.get("schematic") or {}).get("erc") or {}
        lines.append(f"{d['_id']}  \"{d.get('title') or d['_id']}\""
                     + (f"  in {d['folder']}" if d.get("folder") else "")
                     + f"  v{(d.get('component') or {}).get('version') or '?'}"
                     + (f"  DRC {drc.get('error_count')} errors/{drc.get('warning_count')} warnings" if drc else "")
                     + (f"  ERC {erc.get('error_count')} errors" if erc else ""))
    text = (f"{len(found)} board(s) in this workspace (id, title, folder, version, checks). "
            "Read one with board_read and its id:\n" + "\n".join(lines))
    return Result(text=clip(text), say="Listed {n} boards", vars={"n": len(found)},
                  summary="\n".join(d["_id"] for d in found[:20]))


def _overview(s: dict) -> list[str]:
    """board_stats.summary as lines: size, density, blocks, fanout, BOM price."""
    out = []
    size = s.get("size") or {}
    if size.get("mm"):
        out.append(f"Board size {size['mm']} mm, {size.get('area_cm2')} cm², "
                   f"{size.get('density')} parts/cm²")
    p = s.get("parts") or {}
    if p:
        out.append(f"Parts {p.get('components')}, nets {p.get('nets')}, joins {p.get('joins')}")
    if s.get("blocks"):
        out.append("Parts by circuit block: " + ", ".join(f"{b['label']} {b['value']}" for b in s["blocks"]))
    if s.get("fanout"):
        out.append("Nets by pins joined: " + ", ".join(f"{b['label']}: {b['value']}" for b in s["fanout"]))
    b = s.get("bom") or {}
    if b:
        out.append(f"BOM: {b.get('lines')} distinct parts, {b.get('priced')} priced, one-off price "
                   f"${b.get('cost_usd')} per board ({b.get('basic')} JLC Basic, {b.get('extended')} Extended, "
                   f"{b.get('unpartnumbered')} without a part number) - bom_cost gives the price at a quantity")
    return out


async def run(ctx: Ctx, args: dict) -> Result:
    ref = str(args.get("board") or "").strip()
    if not ref:
        return await _listing(ctx)
    section = str(args.get("section") or "").strip().lower()
    if section in ("", "all"):
        section = ""
    elif section not in SECTIONS:
        raise ToolError(f"section is one of {', '.join(SECTIONS)} (or leave it out for all of them)")
    net = str(args.get("net") or "").strip()
    doc = await find(ctx.db, ato.BOARDS, ref, ("title", "folder"), "board")
    bid = doc["_id"]
    got = await cc_context.board_parts(ctx.db, bid)
    if not got:
        raise ToolError(f"no board {bid!r}")
    d, graph = got["doc"], got["graph"] or {}
    keep = [t for s, t in got["lines"] if s == "head" or not section or s == section]
    if section in ("", "routing"):
        try:
            keep += _overview(await board_stats.summary(ctx.db, bid))
        except KeyError:
            pass
    if net:
        want = net.lower()
        hits = [n for n in graph.get("nets") or [] if want in str(n.get("name") or "").lower()]
        if not graph:
            keep.append(f"Nets matching {net!r}: none - the board has no netlist (not built yet).")
        elif not hits:
            keep.append(f"Nets matching {net!r}: none.")
        else:
            keep.append(f"Nets matching {net!r} ({len(hits)}), with their pins:")
            keep += [f"{n.get('name')}: {_pins(n)}" for n in hits[:MAX_NETS]]
            if len(hits) > MAX_NETS:
                keep.append(f"... and {len(hits) - MAX_NETS} more; give a longer name")
    text = "\n".join(keep)
    if len(text) > MAX_TEXT:
        text = clip(text, MAX_TEXT - 200) + ("\nAsk for one section (bom, nets, drc, erc, rules, routing) "
                                             "or a net name to see the rest.")
    title = d.get("title") or bid
    drc = d.get("drc") or {}
    v = {"board": bid, "title": title, "section": section.upper() if section in ("drc", "erc", "bom") else section,
         "net": net}
    if net:
        say = "Read nets “{net}” of board {board}"
    elif section:
        say = "Read the {section} of board {board}"
    else:
        say = "Read board {board}"
    summary = f"{title} · v{(d.get('component') or {}).get('version') or '?'}" + (
        f" · DRC {drc.get('error_count')} errors, {drc.get('warning_count')} warnings" if drc else "")
    return Result(text=text, say=say, vars=v, summary=summary)


TOOL = Tool(
    name="board_read", level="read", order=60,
    label="Read a board",
    about="Reads a board: BOM, nets, DRC and ERC, rules, layout and routing.",
    description="Read one of this workspace's circuit boards (the PCB room): its BOM, nets, DRC and ERC "
                "results, design rules, layout and routing figures - what an @-mention of it gives. "
                "`section` keeps one part of it (bom | nets | drc | erc | rules | routing); `net` lists "
                "the nets whose name holds that text, with their pins. Without `board` it lists the "
                "boards. A board may be named by its id or by words of its title.",
    schema={"type": "object", "properties": {
        "board": {"type": "string", "description": "The board's id (like demoboard-gerber-zip); leave out to list"},
        "section": {"type": "string", "enum": [*SECTIONS, "all"], "description": "Only this part of it"},
        "net": {"type": "string", "description": "Nets whose name holds this, like GND or SDA"}}},
    running="Reading a board", failed="Could not read the board",
    run=run)
