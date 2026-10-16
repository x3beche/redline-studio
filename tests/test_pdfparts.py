"""The parts a document is made of (backend/pdfparts.py) and the ```part: fence
that draws one (backend/pdfdoc.py).

What matters: a part draws the values it was given; a value it was not given is
never invented (a measurement with no method, a check with no measured value, a
sign-off with no name); a budget whose contributors do not sum to its total is
refused rather than printed; and a part that cannot be drawn says so in the
document instead of breaking it.
"""

from __future__ import annotations

from backend import pdfdoc, pdfparts


def html(name: str, data: dict) -> str:
    return pdfdoc.md_html(pdfdoc.part_fence(name, data))


ROW = {"what": "a", "label": "a", "value": "1", "qty": 1, "role": "Prepared", "name": "Me",
       "pin": 1, "version": "0", "date": "2026-01-01", "actual": "ok", "expected": "ok",
       "method": "DMM", "total": "1", "code": "graph TD; A-->B", "expression": "2 * 3",
       "at": "0x40", "from": "0", "to": "1", "bits": "7:0", "register": "R", "field": "F", "size": "4 kB",
       "kind": "flash", "load": "0x8000", "use": "code", "access": "rw", "reset": "0x0", "region": "flash",
       "section": ".text", "task": "main", "stack": "2 kB", "used": "1 kB", "peak": "1.4 kB", "free": "0.6 kB",
       "irq": "USART1", "priority": "5", "handler": "on_uart", "source": "USART1", "node": "PLL", "rate": "72 MHz",
       "channel": "1", "direction": "mem2mem", "peripheral": "SPI1", "trigger": "SPI1_TX", "number": "37",
       "vector": "USART1_IRQHandler", "partition": "app", "type": "app", "housing": "JST-PH",
       "signal": "SWDIO", "wire": "30 AWG", "net": "SWD", "side": "top", "where": "U1", "spot": "U1",
       "temperature": "48", "limit": "85", "time": "1.204", "level": "info", "line": "boot ok", "fault": "FPU",
       "status": "hard", "cause": "unaligned", "instrument": "PPK2", "setting": "1 kHz", "why": "ripple",
       "who": "me", "how": "checked twice", "id": "R1", "severity": "low", "state": "open",
       "likelihood": "low", "impact": "low", "mitigation": "guard", "decision": "use the LDO", "alternatives": "BUCK",
       "weight": "3", "criterion": "cost", "option": "LDO", "was": "1.1", "now": "1.2", "unit": "V",
       "frame": "0x55", "bytes": "0", "values": "0x55", "hop": "1", "link": "eth0", "address": "10.0.0.1",
       "call": "read()", "takes": "id", "returns": "row", "meaning": "no ack", "action": "retry", "title": "Ref",
       "source_ref": "datasheet", "page": "4", "requirement": "R-1", "evidence": "test 3", "verdict": "pass",
       "term": "seat", "severity_note": "x", "what_it_is": "x"}


def test_every_part_draws_itself_and_only_needs_its_rows():
    # A few parts are another part under the name of what is being drawn or
    # budgeted: they draw that part's class.
    base = {"sequence-diagram": "mermaid", "state-machine": "mermaid", "timing-diagram": "mermaid",
            "block-diagram": "mermaid", "latency-budget": "budget-table", "throughput-budget": "budget-table",
            "power-budget": "budget-table", "memory-budget": "budget-table"}
    for name in pdfparts.PARTS:
        out = html(name, {"title": "T", **ROW, "rows": [dict(ROW)]})
        cls = base.get(name, name)
        assert f"p-{cls}" in out and "<figure" in out and "p-err" not in out, name
        assert "<figcaption>T</figcaption>" in out, name


def test_a_measurement_with_no_method_is_not_a_measurement():
    out = html("measurement-table", {"rows": [{"what": "3V3", "value": "3.28", "unit": "V"},
                                              {"what": "5V", "value": "5.01", "method": "DMM"}]})
    assert "not recorded" in out and "1 of 2 rows have no method" in out


def test_a_check_with_no_measured_value_is_not_a_pass():
    out = html("pass-fail-matrix", {"rows": [{"what": "boot", "expected": "ok"},
                                             {"what": "uart", "expected": "ok", "actual": "ok"}]})
    assert "not checked" in out and "1 not checked" in out


def test_a_budget_that_does_not_add_up_is_refused():
    out = html("budget-table", {"unit": "ms", "total": 120,
                                "rows": [{"what": "a", "value": 40}, {"what": "b", "value": 30}]})
    assert "Refused" in out and "70 ms" in out and "120" in out


def test_a_budget_that_adds_up_says_so():
    out = html("budget-table", {"total": 70, "rows": [{"what": "a", "value": 40}, {"what": "b", "value": 30}]})
    assert "add up to it" in out and "Refused" not in out


def test_a_signoff_with_no_name_is_not_signed():
    out = html("signoff", {"rows": [{"role": "Prepared", "name": "Me"}, {"role": "Checked"}]})
    assert "not signed" in out


def test_a_bom_totals_its_quantities():
    out = html("bom", {"rows": [{"ref": "U1", "part": "STM32", "qty": 2, "lcsc": "C123"},
                                {"ref": "R1", "value": "10k", "qty": 1}]})
    assert "Total" in out and ">3<" in out and "C123" in out and "STM32" in out


def test_an_unknown_part_says_so_and_the_document_survives():
    out = pdfdoc.md_html("before\n\n```part:no-such-part\n{}\n```\n\nafter")
    assert "p-err" in out and "no part" in out and "before" in out and "after" in out


def test_a_body_that_is_not_json_says_so():
    out = pdfdoc.md_html("```part:bom\nnot json\n```")
    assert "p-err" in out and "not JSON" in out


def test_the_catalog_names_every_part_with_what_it_takes():
    text = pdfparts.catalog()
    for name, (about, how, _) in pdfparts.PARTS.items():
        assert f"`{name}`" in text and about in text and how in text
