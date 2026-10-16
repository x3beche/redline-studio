"""The parts a Workbench document is made of.

A part is a block drawn from the values the model gives it: a measurement
table, a bill of materials, a pinout, a pass/fail matrix, or the document's own
furniture (a revision history, the sign-off line). The model supplies the
numbers and the part draws them - so a figure cannot quietly disagree with the
text beside it, and a part never invents a value to fill a hole.

What the parts refuse (each is a way a document lies):

- a measurement with no method is not a measurement: it prints as "not
  recorded" and is counted under the table;
- a budget whose contributors do not sum to its total says so, instead of
  printing a number nobody can check;
- a verdict with no measured value is "not checked", never a pass;
- a sign-off with no name is "not signed".

`PARTS` is the registry, `catalog()` is what the model is shown (the
`pdf_parts` tool) and `render(name, data)` is one part's HTML. A document
places one with a fenced block (see `backend/pdfdoc.py`):

    ```part:measurement-table
    {"title": "3V3 rail", "rows": [{"what": "idle", "value": "3.28", "unit": "V",
                                    "method": "PPK2, 100 kHz"}]}
    ```

Nothing here reads a file, a datasheet or an instrument: every value came from
the model. That is deliberately the whole contract - the same part works
whether the number came off a scope, out of a datasheet or out of a design that
does not exist yet.
"""

from __future__ import annotations

import ast
import html
import json
import operator
from typing import Any, Callable

# A value that is not known prints like this and is counted, rather than left
# as an empty cell the reader would read as zero.
NOT_RECORDED = "not recorded"


class PartError(ValueError):
    """A part that cannot be drawn. The message goes into the document."""


def _e(v: Any) -> str:
    return html.escape("" if v is None else str(v), quote=True)


def _s(v: Any, n: int = 400) -> str:
    return " ".join(str(v if v is not None else "").split())[:n]


def _num(v: Any) -> float | None:
    """A number a row's value may be, or None when it is prose."""
    t = _s(v, 40).replace(",", ".")
    try:
        return float("".join(c for c in t if c in "0123456789.-+eE"))
    except ValueError:
        return None


def _rows(data: dict, key: str = "rows") -> list[dict]:
    raw = data.get(key)
    if raw in (None, ""):
        return []
    if isinstance(raw, dict):                       # {label: value} also works
        return [{"label": k, "value": v} for k, v in raw.items()]
    if not isinstance(raw, list):
        raise PartError(f"`{key}` is a list of rows")
    out = []
    for r in raw[:200]:
        if not isinstance(r, dict):
            raise PartError(f"every row of `{key}` is an object")
        out.append(r)
    return out


def _cap(name: str, data: dict, body: str, note: str = "") -> str:
    t = _s(data.get("title"), 200)
    head = (f'<figcaption>{_e(t)}</figcaption>' if t else "")
    foot = (f'<p class="p-note">{_e(note)}</p>' if note else "")
    return f'<figure class="p p-{name}">{head}{body}{foot}</figure>'


def _table(head: list[tuple[str, str]], rows: list[list[str]], cls: str = "") -> str:
    th = "".join(f'<th class="{c}">{_e(h)}</th>' for h, c in head)
    tr = "".join("<tr>" + "".join(c for c in r) + "</tr>" for r in rows)
    return f'<table class="p-tbl {cls}"><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table>'


def _cell(v: Any, dim: bool = False, cls: str = "") -> str:
    return f'<td class="{cls}{" p-dim" if dim else ""}">{_e(v)}</td>'


def _code(v: Any, dim: bool = False) -> str:
    """A cell that is an identifier (an LCSC number, a net): in the code face."""
    return f'<td class="{"p-dim" if dim else ""}"><code>{_e(v)}</code></td>'


# ---------------------------------------------------------------- the parts

def fields(data: dict) -> str:
    """A label / value grid: the document's specification block."""
    rows = _rows(data, "rows") or [{"label": k, "value": v} for k, v in (data.get("fields") or {}).items()]
    if not rows:
        raise PartError("a `fields` part needs `rows`, or `fields` as {label: value}")
    body = '<table class="p-kv"><tbody>' + "".join(
        f'<tr><th>{_e(_s(r.get("label"), 80))}</th>'
        f'<td>{_e(_s(r.get("value"), 300)) or "—"}</td></tr>' for r in rows) + "</tbody></table>"
    return _cap("fields", data, body)


def revision_history(data: dict) -> str:
    """What changed, when and by whom - the document's own furniture."""
    rows = _rows(data)
    if not rows:
        raise PartError("a `revision-history` part needs `rows`")
    body = _table([("Rev", ""), ("Date", ""), ("Who", ""), ("What changed", "")],
                  [[_cell(_s(r.get("version") or r.get("rev"), 20)),
                    _cell(_s(r.get("date"), 30), dim=not r.get("date")),
                    _cell(_s(r.get("who") or r.get("author"), 60), dim=not (r.get("who") or r.get("author"))),
                    _cell(_s(r.get("what") or r.get("note"), 400))] for r in rows])
    return _cap("revision-history", data, body)


def signoff(data: dict) -> str:
    """Who prepared, checked and approved it. A blank name is not a signature."""
    rows = _rows(data)
    if not rows:
        raise PartError("a `signoff` part needs `rows`")
    out = []
    for r in rows:
        who = _s(r.get("name"), 80)
        out.append([_cell(_s(r.get("role"), 60)), _cell(who, dim=not who),
                    _cell(_s(r.get("date"), 30), dim=not r.get("date"))])
    note = "" if all(_s(r.get("name")) for r in rows) else "A role with no name is not signed."
    body = _table([("Role", ""), ("Name", ""), ("Date", "")], out)
    return _cap("signoff", data, body, note)


def measurement_table(data: dict) -> str:
    """A measurement and the conditions it was taken under. No method, no
    measurement: the value prints as "not recorded" and is counted."""
    rows = _rows(data)
    if not rows:
        raise PartError("a `measurement-table` part needs `rows`")
    out, unknown = [], 0
    for r in rows:
        method = _s(r.get("method"), 200)
        value = _s(r.get("value"), 60)
        if not method:
            unknown += 1
            cells = [_cell(_s(r.get("what"), 120)), _cell(NOT_RECORDED, cls="p-none", dim=True),
                     _cell(_s(r.get("unit"), 20)), _cell(NOT_RECORDED, cls="p-none", dim=True),
                     _cell(_s(r.get("limit"), 60), dim=not r.get("limit"))]
        else:
            cells = [_cell(_s(r.get("what"), 120)), _cell(value or "—", cls="num"),
                     _cell(_s(r.get("unit"), 20)), _cell(method),
                     _cell(_s(r.get("limit"), 60), dim=not r.get("limit"))]
        out.append(cells)
    body = _table([("What", ""), ("Value", "num"), ("Unit", ""), ("Method", ""), ("Limit", "")], out)
    note = (f"{unknown} of {len(rows)} rows have no method and are not measurements."
            if unknown else "")
    return _cap("measurement-table", data, body, note)


def pass_fail_matrix(data: dict) -> str:
    """What was checked, what it should be, what it was, and the verdict. A row
    with no measured value is "not checked" - never a pass."""
    rows = _rows(data)
    if not rows:
        raise PartError("a `pass-fail-matrix` part needs `rows`")
    out, fails, unchecked = [], 0, 0
    for r in rows:
        actual = _s(r.get("actual") or r.get("measured"), 120)
        v = _s(r.get("verdict"), 20).lower()
        if not actual:
            v, unchecked = "not checked", unchecked + 1
        elif v not in ("pass", "fail", "waived"):
            v = "pass" if _s(r.get("expected")) and actual == _s(r.get("expected")) else ""
            v = v or "fail"
        if v == "fail":
            fails += 1
        out.append([_cell(_s(r.get("what") or r.get("step"), 160)),
                    _cell(_s(r.get("expected"), 160), dim=not r.get("expected")),
                    _cell(actual, dim=not actual),
                    f'<td class="p-verdict" data-v="{_e(v)}">{_e(v)}</td>'])
    body = _table([("Check", ""), ("Expected", ""), ("Measured", ""), ("Verdict", "")], out)
    bits = [f"{fails} failed"] if fails else []
    if unchecked:
        bits.append(f"{unchecked} not checked")
    return _cap("pass-fail-matrix", data, body, "; ".join(bits))


def bom(data: dict) -> str:
    """A bill of materials. `qty` is per board unless `total` says otherwise."""
    rows = _rows(data)
    if not rows:
        raise PartError("a `bom` part needs `rows`")
    per = bool(data.get("per_board", True))
    out, total = [], 0
    for r in rows:
        q = _num(r.get("qty"))
        total += int(q) if q is not None else 0
        out.append([_cell(_s(r.get("ref"), 60)),
                    _cell(_s(r.get("part") or r.get("mpn"), 120)),
                    _cell(_s(r.get("value"), 40)),
                    _cell(_s(r.get("package") or r.get("pkg"), 40)),
                    _cell(_s(r.get("qty"), 12), cls="num"),
                    _code(_s(r.get("lcsc"), 20), dim=not r.get("lcsc"))])
    out.append([f'<td colspan="4" class="p-total">{_e("Total")}</td>',
                _cell(total, cls="num p-total"), _cell("")])
    body = _table([("Ref", ""), ("Part", ""), ("Value", ""), ("Package", ""), ("Qty", "num"), ("LCSC", "")],
                  out)
    return _cap("bom", data, body, "" if per else "Quantities are for the whole build, not one board.")


def pinout_table(data: dict) -> str:
    """Connector and header pinouts, as they are wired."""
    rows = _rows(data)
    if not rows:
        raise PartError("a `pinout-table` part needs `rows`")
    out = []
    for r in rows:
        pin = r.get("pin")
        if isinstance(pin, list) and len(pin) == 2:      # a range, e.g. [1, 4]
            pin = f"{pin[0]}–{pin[1]}"
        out.append([_cell(_s(pin, 20), cls="num"), _cell(_s(r.get("name"), 80)),
                    _cell(_s(r.get("type"), 40), dim=not r.get("type")),
                    _code(_s(r.get("net"), 80), dim=not r.get("net")),
                    _cell(_s(r.get("note"), 200), dim=not r.get("note"))])
    body = _table([("Pin", "num"), ("Name", ""), ("Type", ""), ("Net", ""), ("Note", "")], out)
    return _cap("pinout-table", data, body)


def budget_table(data: dict) -> str:
    """Contributors, their values, and the total they must add up to. A total
    that does not match is refused: the model wrote both numbers and the reader
    cannot tell which one is wrong."""
    rows = _rows(data)
    if not rows:
        raise PartError("a `budget-table` part needs `rows`")
    unit = _s(data.get("unit"), 12)
    out, summed, missing = [], 0.0, 0
    for r in rows:
        v = _num(r.get("value"))
        if v is None:
            missing += 1
        else:
            summed += v
        out.append([_cell(_s(r.get("what"), 120)), _cell(_s(r.get("value"), 30), cls="num"),
                    _cell(_s(r.get("share"), 20), cls="num", dim=not r.get("share")),
                    _cell(_s(r.get("note"), 200), dim=not r.get("note"))])
    stated = _num(data.get("total"))
    note = ""
    shown = summed
    if stated is not None and abs(stated - summed) > max(1e-6, abs(stated) * 1e-4):
        note = (f"Refused: the contributors add up to {summed:g}{(' ' + unit) if unit else ''}, "
                f"not the stated {stated:g}. Fix the rows or the total.")
        shown = stated
    elif stated is not None:
        note = f"Total {stated:g}{(' ' + unit) if unit else ''}, and the contributors add up to it."
    out.append([f'<td colspan="1" class="p-total">{_e("Total")}</td>',
                _cell(f"{shown:g}", cls="num p-total"),
                _cell(unit, cls="p-total"),
                _cell("the stated total" if note.startswith("Refused") else "", dim=True)])
    body = _table([("Contributor", ""), ("Value", "num"), ("Share", "num"), ("Note", "")], out)
    if missing:
        note = (note + " " if note else "") + f"{missing} row(s) have no value."
    if data.get("over") is not None and stated is not None and _num(data["over"]) is not None:
        limit = _num(data["over"])
        state = "over" if shown > limit else "within"
        note = (note + " " if note else "") + f"{shown:g}{(' ' + unit) if unit else ''} is {state} the {limit:g} limit."
    return _cap("budget-table", data, body, note)


def mermaid(data: dict) -> str:
    """A diagram Mermaid draws in the page (zamanlama, akış, durum makinesi,
    sınıf): the model writes Mermaid's own lines and Chromium draws them while
    the page is printed (mermaid.min.js is vendored, so it works offline)."""
    code = data.get("code")
    if isinstance(code, list):
        code = "\n".join(str(x) for x in code)
    code = str(code or "").strip()
    if not code:
        raise PartError("a `mermaid` part needs `code`: the diagram's Mermaid lines")
    # The source is the element's text, so a line of it can never become markup.
    return _cap("mermaid", data, f'<div class="mermaid">{_e(code)}</div>')


def _table_part(name: str, columns: tuple, dim: bool = True) -> Callable[[dict], str]:
    """A part that is a named table: `rows` of objects, one cell each. A value
    the model did not give prints faint, so a gap shows as a gap - never as a
    zero. (measurement-table and budget-table have rules of their own and their
    own renderers; everything else that is a table is built from this.)"""

    def draw(data: dict) -> str:
        rows = _rows(data)
        if not rows:
            raise PartError(f"a `{name}` part needs `rows`")
        out = []
        for r in rows:
            cells = []
            for _label, key, cls in columns:
                v = r.get(key)
                if isinstance(v, list):
                    v = ", ".join(str(x) for x in v)
                elif isinstance(v, bool):
                    v = "yes" if v else "no"
                cells.append(_cell(_s(v, 500), dim=dim and v in (None, ""), cls=cls))
            out.append(cells)
        return _cap(name, data, _table([(l, c) for l, _, c in columns], out))

    draw.__name__ = name.replace("-", "_")
    return draw


def _mermaid_part(name: str) -> Callable[[dict], str]:
    """One of Mermaid's own diagram kinds under its own name, so the model asks
    for the drawing it means (a state machine, a timing sketch) instead of
    remembering which syntax the generic part takes."""

    def draw(data: dict) -> str:
        return mermaid(data)

    draw.__name__ = name.replace("-", "_")
    return draw


def _budget_part(name: str, unit: str) -> Callable[[dict], str]:
    """budget-table under the name of what is being budgeted: the unit is filled
    in when the model leaves it out (and the total still has to add up)."""

    def draw(data: dict) -> str:
        return budget_table({**data, "unit": data.get("unit") or unit})

    draw.__name__ = name.replace("-", "_")
    return draw


_CALC_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
             ast.Mod: operator.mod, ast.FloorDiv: operator.floordiv, ast.Pow: operator.pow}


def _value(node) -> float:
    """The expression's value: a walk over the parsed tree, never eval. Only
    numbers, the arithmetic operators and parentheses are allowed."""
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)
    if isinstance(node, ast.UnaryOp):
        v = _value(node.operand)
        return -v if isinstance(node.op, ast.USub) else +v
    if isinstance(node, ast.BinOp):
        fn = _CALC_OPS.get(type(node.op))
        if fn is None:
            raise ValueError("only + - * / % // and ** are allowed")
        return fn(_value(node.left), _value(node.right))
    raise ValueError(f"{type(node).__name__.lower()} is not arithmetic - write the numbers in")


def _g(v: float) -> str:
    return f"{v:g}"


def calculation(data: dict) -> str:
    """A calculation whose arithmetic is checked. The expression is evaluated
    here and a stated result that disagrees stops it: the model wrote both
    numbers and the reader cannot tell which one is wrong."""
    expr = _s(data.get("expression"), 200)
    if not expr:
        raise PartError("a `calculation` part needs `expression`, e.g. \"2 * pi * 12e3 * 1e-9\"")
    try:
        got = _value(ast.parse(expr, mode="eval").body)
    except (SyntaxError, ValueError, ZeroDivisionError, TypeError, OverflowError) as exc:
        raise PartError(f"the expression {expr!r}: {exc}") from exc
    stated = _num(data.get("result")) if str(data.get("result") or "").strip() else None
    unit = _s(data.get("unit"), 12)
    note, shown = "", got
    if stated is not None and abs(stated - got) > max(1e-9, abs(got) * 1e-6):
        note = f"Refused: {expr} is {_g(got)}, not the stated {_g(stated)}."
        shown = stated
    rows = [{"label": "Expression", "value": expr},
            {"label": "Result", "value": (f"{_g(shown)} {unit}".strip())}]
    for r in _rows(data, "inputs"):
        rows.append({"label": _s(r.get("what") or r.get("label"), 80),
                     "value": (f"{_s(r.get('value'), 40)} {_s(r.get('unit'), 10)}".strip()
                               + (f"  ({_s(r.get('note'), 160)})" if r.get("note") else ""))})
    body = fields({"rows": rows})
    if note:
        body += f'<p class="p-note">{_e(note)}</p>'
    return _cap("calculation", data, body)


PARTS: dict[str, tuple[str, str, Callable[[dict], str]]] = {
    "fields": ("A label / value block: a document's specification, key numbers, at a glance.",
               "rows: [{label, value}]  (or fields: {label: value})", fields),
    "revision-history": ("What changed, when and by whom - revision 0 upward.",
                         "rows: [{version, date, who, what}]", revision_history),
    "signoff": ("Who prepared, checked and approved it. A role with no name is not signed.",
                "rows: [{role, name, date}]", signoff),
    "measurement-table": ("Measurements with the conditions they were taken under. A row with no "
                          "method is counted as not recorded, never shown as a value.",
                          "rows: [{what, value, unit, method, limit}]", measurement_table),
    "pass-fail-matrix": ("What was checked against what was expected and what was measured. A row "
                         "with no measured value is 'not checked', never a pass.",
                         "rows: [{what, expected, actual, verdict: pass|fail|waived}]", pass_fail_matrix),
    "bom": ("A bill of materials, LCSC numbers included. Quantities are per board unless per_board "
            "is false.",
            "rows: [{ref, part, value, package, qty, lcsc}], per_board?", bom),
    "pinout-table": ("A connector, header or MCU pinout as it is wired.",
                     "rows: [{pin, name, type, net, note}] (pin may be [from, to])", pinout_table),
    "budget-table": ("Contributors that must add up to a total (power, latency, flash). A total that "
                     "does not match is refused.",
                     "rows: [{what, value, share, note}], total, unit, over?", budget_table),
    "mermaid": ("A diagram, drawn in the page by Mermaid: a sequence, a flow, a state machine, a class or a "
                "timing sketch. Write Mermaid's own lines; the PDF prints the drawing, not the source.",
                'code: "sequenceDiagram\\n  A->>B: ping"  (a string, or a list of lines)', mermaid),
    # --- registers and memory -------------------------------------------------
    "register-map": ("A peripheral's registers: where each sits, how it is reached, what resets it.",
                     "rows: [{at, name, access, reset, what}]",
                     _table_part("register-map", (("Address", "at", "num"), ("Name", "name", ""),
                                                  ("Access", "access", ""), ("Reset", "reset", "num"),
                                                  ("What", "what", "")))),
    "register-decode": ("One register, bit by bit: what each field is and how it is reached.",
                        "rows: [{register, bits, field, access, what}]",
                        _table_part("register-decode", (("Register", "register", ""), ("Bits", "bits", "num"),
                                                        ("Field", "field", ""), ("Access", "access", ""),
                                                        ("What", "what", "")))),
    "register-diff": ("Two builds of one register set, field by field - what moved and why.",
                      "rows: [{register, field, was, now, why}]",
                      _table_part("register-diff", (("Register", "register", ""), ("Field", "field", ""),
                                                    ("Was", "was", "num"), ("Now", "now", "num"),
                                                    ("Why", "why", "")))),
    "memory-map": ("The map of what lives where in a memory space.",
                   "rows: [{region, from, to, size, use}]",
                   _table_part("memory-map", (("Region", "region", ""), ("From", "from", "num"),
                                              ("To", "to", "num"), ("Size", "size", "num"),
                                              ("Use", "use", "")))),
    "section-table": ("A built image's sections: how big, where they load, what they are.",
                      "rows: [{section, size, kind, load, what}]",
                      _table_part("section-table", (("Section", "section", ""), ("Size", "size", "num"),
                                                    ("Kind", "kind", ""), ("Load", "load", "num"),
                                                    ("What", "what", "")))),
    "stack-usage": ("Stacks measured: how much was used, the peak, what is left - a block with no "
                    "margin is the one that overflows.",
                    "rows: [{task, stack, used, peak, free}]",
                    _table_part("stack-usage", (("Task", "task", ""), ("Stack", "stack", "num"),
                                                ("Used", "used", "num"), ("Peak", "peak", "num"),
                                                ("Free", "free", "num")))),
    "interrupt-timeline": ("The interrupts in the order they may preempt each other.",
                           "rows: [{irq, priority, handler, source, what}]",
                           _table_part("interrupt-timeline", (("IRQ", "irq", ""), ("Priority", "priority", "num"),
                                                              ("Handler", "handler", ""), ("Source", "source", ""),
                                                              ("What", "what", "")))),
    "clock-tree": ("The clock tree: what comes from where, at what rate.",
                   "rows: [{node, from, rate, what}]",
                   _table_part("clock-tree", (("Clock", "node", ""), ("From", "from", ""),
                                              ("Rate", "rate", "num"), ("What", "what", "")))),
    "dma-map": ("Which channel moves what, and how it is triggered.",
                "rows: [{channel, direction, peripheral, trigger, what}]",
                _table_part("dma-map", (("Channel", "channel", ""), ("Direction", "direction", ""),
                                        ("Peripheral", "peripheral", ""), ("Trigger", "trigger", ""),
                                        ("What", "what", "")))),
    "irq-table": ("The vector table: number, priority, handler, how often it fires.",
                  "rows: [{number, vector, priority, handler, rate}]",
                  _table_part("irq-table", (("Vector", "number", "num"), ("Name", "vector", ""),
                                            ("Priority", "priority", "num"), ("Handler", "handler", ""),
                                            ("Rate", "rate", "")))),
    "partition-layout": ("The partitions of a device: where each starts, how big, what it holds.",
                         "rows: [{partition, from, size, type, what}]",
                         _table_part("partition-layout", (("Partition", "partition", ""), ("From", "from", "num"),
                                                          ("Size", "size", "num"), ("Type", "type", ""),
                                                          ("What", "what", "")))),
    # --- hardware ------------------------------------------------------------
    "connector-pinout": ("A connector as it is wired, pin by pin, with the housing it goes in.",
                         "rows: [{pin, name, signal, wire, note}], housing?",
                         _table_part("connector-pinout", (("Pin", "pin", "num"), ("Name", "name", ""),
                                                          ("Signal", "signal", ""), ("Wire", "wire", ""),
                                                          ("Note", "note", "")))),
    "net-extract": ("Which net joins what - from a layout, a netlist or a schematic.",
                    "rows: [{net, from, to, what}]",
                    _table_part("net-extract", (("Net", "net", ""), ("From", "from", ""),
                                                ("To", "to", ""), ("What", "what", "")))),
    "board-layout": ("The board itself: side, what sits there, and where.",
                     "rows: [{side, what, where, note}]",
                     _table_part("board-layout", (("Side", "side", ""), ("What", "what", ""),
                                                  ("Where", "where", ""), ("Note", "note", "")))),
    "thermal-map": ("Heat by spot against its limit. A spot with no limit is the one nobody "
                    "worked out yet.",
                    "rows: [{spot, temperature, limit, note}]",
                    _table_part("thermal-map", (("Spot", "spot", ""), ("Temperature", "temperature", "num"),
                                                ("Limit", "limit", "num"), ("Note", "note", "")))),
    # --- evidence and method --------------------------------------------------
    "log-excerpt": ("The lines of a log that matter, in order.",
                    "rows: [{time, level, line}]",
                    _table_part("log-excerpt", (("Time", "time", "num"), ("Level", "level", ""),
                                                ("Line", "line", "")))),
    "fault-report": ("A fault as it presented itself, and what was found to be behind it.",
                     "rows: [{fault, status, what, cause}]",
                     _table_part("fault-report", (("Fault", "fault", ""), ("Status", "status", ""),
                                                  ("What was seen", "what", ""), ("Cause", "cause", "")))),
    "test-setup": ("The bench: what was set to what, and what it was set for.",
                   "rows: [{instrument, setting, why}]",
                   _table_part("test-setup", (("Instrument", "instrument", ""), ("Setting", "setting", ""),
                                              ("Why", "why", "")))),
    "procedure": ("The steps to run, in order, numbered as they are printed.",
                  "rows: [{what, who, expected}]",
                  _table_part("procedure", (("Step", "what", ""), ("Who", "who", ""),
                                            ("Expected", "expected", "")))),
    "defect-record": ("A defect, its state, and how the fix was checked - a fix with nothing "
                      "saying how it was checked is a hypothesis.",
                      "rows: [{id, severity, state, what, how}]",
                      _table_part("defect-record", (("Id", "id", ""), ("Severity", "severity", ""),
                                                    ("State", "state", ""), ("What", "what", ""),
                                                    ("How checked", "how", "")))),
    "risk-register": ("What could go wrong, how likely, how badly, and what is done about it.",
                      "rows: [{risk, likelihood, impact, mitigation}], unit?",
                      _table_part("risk-register", (("Risk", "risk", ""), ("Likelihood", "likelihood", ""),
                                                    ("Impact", "impact", ""), ("Mitigation", "mitigation", "")))),
    "requirement-trace": ("Every requirement against what shows it is met - evidence, a waiver, or "
                          "nothing yet.",
                          "rows: [{requirement, source, evidence, verdict}]",
                          _table_part("requirement-trace", (("Requirement", "requirement", ""),
                                                            ("Source", "source", ""),
                                                            ("Evidence", "evidence", ""),
                                                            ("Verdict", "verdict", "")))),
    # --- decisions, comparisons, budgets --------------------------------------
    "decision-record": ("A decision, why it was taken, and what was set aside.",
                        "rows: [{id, decision, why, alternatives}]",
                        _table_part("decision-record", (("Id", "id", ""), ("Decision", "decision", ""),
                                                        ("Why", "why", ""), ("Alternatives", "alternatives", "")))),
    "tradeoff-matrix": ("What was weighed, how much it counted, and which option it favours.",
                        "rows: [{criterion, weight, option, note}]",
                        _table_part("tradeoff-matrix", (("Criterion", "criterion", ""), ("Weight", "weight", "num"),
                                                        ("Favours", "option", ""), ("Note", "note", "")))),
    "version-compare": ("Two versions against each other, item by item, with the reason.",
                        "rows: [{what, was, now, why}]",
                        _table_part("version-compare", (("What", "what", ""), ("Was", "was", ""),
                                                        ("Now", "now", ""), ("Why", "why", "")))),
    "unit-matrix": ("One measurement kind across the things measured (units per option).",
                    "rows: [{unit, option, value, note}]",
                    _table_part("unit-matrix", (("Unit", "unit", ""), ("Option", "option", ""),
                                                ("Value", "value", "num"), ("Note", "note", "")))),
    "calculation": ("A calculation whose arithmetic is checked: the expression is evaluated and a "
                    "stated result that disagrees is refused.",
                    'expression: "2 * pi * 12e3 * 1e-9", result?, unit?, inputs?: [{what, value, unit, note}]',
                    calculation),
    "latency-budget": ("Where the time goes, against the time allowed.", 
                       "rows: [{what, value, share, note}], total, unit? (ms), over?",
                       _budget_part("latency-budget", "ms")),
    "throughput-budget": ("Where the throughput goes, against what is needed.",
                          "rows: [{what, value, share, note}], total, unit? (MB/s), over?",
                          _budget_part("throughput-budget", "MB/s")),
    "power-budget": ("Where the power goes, against what the supply gives.",
                     "rows: [{what, value, share, note}], total, unit? (mW), over?",
                     _budget_part("power-budget", "mW")),
    "memory-budget": ("Where the memory goes (flash, RAM), against the part.",
                      "rows: [{what, value, share, note}], total, unit? (kB), over?",
                      _budget_part("memory-budget", "kB")),
    # --- protocol and code ----------------------------------------------------
    "frame-format": ("A frame, byte by byte: which bits are the field, and what they are.",
                     "rows: [{bytes, bits, field, values}]",
                     _table_part("frame-format", (("Bytes", "bytes", "num"), ("Bits", "bits", "num"),
                                                  ("Field", "field", ""), ("Values", "values", "")))),
    "network-path": ("The path a packet takes: hop by hop, link by link.",
                     "rows: [{hop, link, address, what}]",
                     _table_part("network-path", (("Hop", "hop", "num"), ("Link", "link", ""),
                                                  ("Address", "address", ""), ("What", "what", "")))),
    "api-table": ("Calls offered, what each takes and gives back.",
                  "rows: [{call, takes, returns, what}]",
                  _table_part("api-table", (("Call", "call", ""), ("Takes", "takes", ""),
                                            ("Returns", "returns", ""), ("What", "what", "")))),
    "error-catalog": ("Every error the thing can report, and what to do about it.",
                      "rows: [{code, meaning, action}]",
                      _table_part("error-catalog", (("Code", "code", ""), ("Meaning", "meaning", ""),
                                                    ("What to do", "action", "")))),
    "references": ("Where the figures and the claims in this document come from.",
                   "rows: [{id, title, source, page}]",
                   _table_part("references", (("Id", "id", ""), ("Title", "title", ""),
                                              ("Source", "source", ""), ("Page", "page", "")))),
    "glossary": ("The words this document uses, in its own sense.",
                 "rows: [{term, what}]",
                 _table_part("glossary", (("Term", "term", ""), ("What it means here", "what", "")))),
    # --- diagrams, under the name of the drawing ------------------------------
    "sequence-diagram": ("A sequence diagram, drawn by Mermaid (who says what, in order).",
                         'code: "sequenceDiagram\\n  A->>B: ping"', _mermaid_part("sequence-diagram")),
    "state-machine": ("A state machine, drawn by Mermaid (a state's lines).",
                      'code: "stateDiagram-v2\\n  [*] --> Idle\\n  Idle --> Run: start"',
                      _mermaid_part("state-machine")),
    "timing-diagram": ("A timing sketch, drawn by Mermaid (signals over time).",
                       'code: "sequenceDiagram\\n  Note over A,B: 0 ms ... 12 ms"',
                       _mermaid_part("timing-diagram")),
    "block-diagram": ("How the parts connect, drawn by Mermaid.",
                      'code: "flowchart LR\\n  MCU --> Driver --> Motor"', _mermaid_part("block-diagram")),
}


def catalog() -> str:
    """The parts, their fields and what each refuses - what the model reads
    before it writes a document (`pdf_parts`)."""
    lines = ["The parts a document can place. Give each one the values it asks for; it draws them, "
             "and refuses to print something that would mislead.",
             "",
             "    ```part:<name>", '    {"title": "...", ...}', "    ```", ""]
    for name, (about, how, _) in PARTS.items():
        lines += [f"- `{name}` - {about}", f"  {how}"]
    lines += ["", "Every part takes an optional `title` (printed under it). Values the model does not "
                  "have are left out, never guessed: a part says what is missing rather than filling it."]
    return "\n".join(lines)


def render(name: str, data: Any) -> str:
    """One part's HTML. `name` is a key of `PARTS`."""
    part = PARTS.get((name or "").strip().lower())
    if not part:
        raise PartError(f"no part {name!r} - the parts are: {', '.join(PARTS)}")
    if data in (None, ""):
        data = {}
    if not isinstance(data, dict):
        raise PartError(f"part {name}: the body is an object of its fields")
    return part[2](data)


def as_json(body: Any) -> dict:
    """The JSON body of a ```part: fence."""
    try:
        data = json.loads(body or "{}")
    except json.JSONDecodeError as exc:
        raise PartError(f"the body is not JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise PartError("the body is a JSON object")
    return data
