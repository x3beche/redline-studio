#!/usr/bin/env python
"""Build the table of everyday passives: value and size to LCSC number.

Most of a board is resistors and capacitors, and LCSC's keyword search is
no use for them - "0402 10k resistor" comes back with 10 W through-hole
parts, because "10" matches "10 W". What does work is the manufacturer
part number, which spells the value out: UNI-ROYAL's 0402WGF1002TCE is
10 kΩ in 0402, and Samsung's CL05B104KO5NNNC is 100 nF X7R in 0402.

So the table is built from those, and every row is checked against LCSC
by exact part-number match before it goes in. A number that does not come
back exactly is left out and named, never guessed - an invented LCSC
number has already cost this project a board once.

    python tools/passives.py            # rebuild backend/passives.json

It asks once a second; forty rows is under a minute.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import lcsc  # noqa: E402

OUT = ROOT / "backend" / "passives.json"

# UNI-ROYAL thick-film, 1 %. The code is three digits and a multiplier -
# 1002 is 100 x 10^2 - with J standing for x0.1 below 100 Ω.
RESISTOR_SERIES = {"0402": "0402WGF{}TCE", "0603": "0603WAF{}T5E"}
RESISTORS = {
    "0": "0000", "10": "100J", "22": "220J", "47": "470J", "100": "1000",
    "220": "2200", "330": "3300", "470": "4700", "1k": "1001", "1.2k": "1201",
    "2k": "2001", "2.2k": "2201", "4.7k": "4701", "5.1k": "5101",
    "10k": "1002", "20k": "2002", "47k": "4702", "100k": "1003", "1M": "1004",
}

# Samsung MLCC, which JLCPCB stocks as Basic parts: the value is the usual
# three-digit picofarad code, then dielectric, tolerance and voltage.
CAPACITORS = {
    ("10p", "0402"): "CL05C100JB5NNNC",
    ("22p", "0402"): "CL05C220JB5NNNC",
    ("100p", "0402"): "CL05C101JB5NNNC",
    ("1n", "0402"): "CL05B102KB5NNNC",
    ("10n", "0402"): "CL05B103KB5NNNC",
    ("100n", "0402"): "CL05B104KO5NNNC",
    ("1u", "0402"): "CL05A105KA5NQNC",
    ("4.7u", "0603"): "CL10A475KO8NNNC",
    ("10u", "0603"): "CL10A106KP8NNNC",
    ("22u", "0805"): "CL21A226MAQNNNE",
    ("100n", "0603"): "CL10B104KB8NNNC",
    ("1u", "0603"): "CL10A105KB8NNNC",
}


async def _exact(mpn: str) -> dict | None:
    for row in await lcsc.search(mpn, 5):
        if (row.get("mpn") or "").upper() == mpn.upper():
            return row
    return None


def _save(table: dict, missing: list) -> None:
    OUT.write_text(json.dumps(
        {"_about": "Checked against LCSC by exact part number. "
                   "Rebuild with tools/passives.py.",
         "parts": dict(sorted(table.items())),
         "not_found": sorted(set(missing))}, indent=1, ensure_ascii=False) + "\n")


async def main() -> None:
    # Resumes: LCSC turned the first run away after thirty-three rows and
    # it kept none of them. Now every row is saved as it is confirmed, and
    # a second run asks only about what is still missing.
    try:
        old = json.loads(OUT.read_text())
        table: dict[str, dict] = old.get("parts", {})
    except (OSError, ValueError):
        table = {}
    missing: list[str] = []

    wanted = [("R", value, size, series.format(code))
              for size, series in RESISTOR_SERIES.items()
              for value, code in RESISTORS.items()]
    wanted += [("C", value, size, mpn) for (value, size), mpn in CAPACITORS.items()]

    for kind, value, size, mpn in wanted:
        if f"{kind} {value} {size}" in table:
            continue
        try:
            row = await _exact(mpn)
        except lcsc.Refused as exc:
            _save(table, missing)
            sys.exit(f"stopped with {len(table)} rows saved: {exc}")
        if not row:
            missing.append(f"{kind} {value} {size} ({mpn})")
            print(f"  -- {kind} {value:>5} {size}: {mpn} not on LCSC")
            continue
        key = f"{kind} {value} {size}"
        table[key] = {"lcsc": row["lcsc"], "mpn": row["mpn"],
                      "package": row.get("package"), "stock": row.get("stock")}
        _save(table, missing)
        print(f"  ok {key:14} {row['lcsc']:9} {row['mpn']:18} stock {row.get('stock')}")

    _save(table, missing)
    print(f"\n{len(table)} rows -> {OUT.relative_to(ROOT)}"
          + (f"; {len(missing)} left out" if missing else ""))


if __name__ == "__main__":
    asyncio.run(main())
