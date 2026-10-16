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

import html
import json
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
