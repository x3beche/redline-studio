"""pdf_parts: the blocks a document can place (backend/pdfparts.py).

The model asks for this before it writes a report or a spec, the way a person
reads the parts list before drawing a figure: every part by name, the fields it
takes and what it refuses to print. Nothing here changes anything - it is the
catalogue, and it is what keeps a part's fields out of the bigger tools'
schemas (a report does not have to know what a pinout is)."""

from __future__ import annotations

from .. import pdfparts
from . import Ctx, Result, Tool


async def run(ctx: Ctx, args: dict) -> Result:
    return Result(text=pdfparts.catalog(), say="Read the document parts",
                  summary=f"{len(pdfparts.PARTS)} document parts")


TOOL = Tool(
    name="pdf_parts", package="pdf", level="read", order=30, default=True,
    label="Document parts",
    about="The blocks a PDF document can place, and the fields each one takes.",
    description="The parts a Workbench document can be built from - a fields block, a revision history, a "
                "sign-off, a measurement table, a pass/fail matrix, a BOM, a pinout, a budget - with the fields "
                "each one takes and what each refuses to print. Read it before writing a report or a spec with "
                "pdf_report (or inside a PDF with pdf_make, where a part is a fenced block: ```part:<name> and "
                "the JSON of its fields). A part draws the values you give it and never invents one: a "
                "measurement with no method is counted as not recorded, a budget that does not add up is "
                "refused, and a check with no measured value is 'not checked' - so gather the values from the "
                "tools that know them (drawer, datasheets, LCSC, builds, measurements) before writing.",
    schema={"type": "object", "properties": {}},
    running="Reading the document parts", failed="Could not read the document parts",
    run=run)
