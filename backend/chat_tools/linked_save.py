"""mcmaster_save, grabcad_save: found parts or models saved to their
built-in source in Parts, as its Save does (POST
/api/linked/<source>/parts, backend/linked.py `save`): one or several by
their key, with what the find tool said of them. One saved already is
given back, its empty fields filled."""

from __future__ import annotations

from .. import catalog_builtin, linked  # noqa: F401 - catalog_builtin registers the sources
from . import Ctx, Result, Tool, ToolError
from ._rights import need

MOST = 20
FIELDS = ("key", "title", "notes", "tags", "quantity", "specs", "licence", "author")


def _runner(src: str):
    async def run(ctx: Ctx, args: dict) -> Result:
        k = linked.KINDS[src]
        need("POST", f"/api/linked/{src}/parts")
        items = args.get("items")
        if not isinstance(items, list) or not items:
            raise ToolError(f"give the {k.noun}s to save: [{{key: ..., title: ...}}]")
        if len(items) > MOST:
            raise ToolError(f"at most {MOST} at once")
        done, failed = [], []
        for it in items:
            raw = it if isinstance(it, dict) else {"key": str(it)}
            try:
                doc, new = await linked.save(ctx.db, k, {f: raw[f] for f in FIELDS if f in raw},
                                             ctx.actor if ctx.actor else None)
                done.append((doc, new))
            except ValueError as exc:
                failed.append(f"{raw.get('key')!r}: {exc}")
        if not done:
            raise ToolError("nothing saved - " + "; ".join(failed))
        lines = [f"- {d['key']} {d.get('title') or ''} - {d['url']}" + ("" if new else " (saved already)")
                 for d, new in done]
        text = (f"Saved to Catalog > {k.name}:\n" + "\n".join(lines)
                + (("\nNot saved: " + "; ".join(failed)) if failed else "")
                + f"\nThe CAD file of each is on its page ({k.how}); dropped on it in the catalog, the CAD rooms can "
                "use it.")
        keys = ", ".join(d["key"] for d, _ in done)
        return Result(text=text, say=SAYS[src], vars={"keys": keys, "n": len(done)}, summary="\n".join(lines))
    return run


SAYS = {"mcmaster": "Saved {keys} to McMaster-Carr", "grabcad": "Saved {keys} to GrabCAD"}


def _schema(what: str, key: str, extra: dict) -> dict:
    return {"type": "object", "properties": {"items": {"type": "array", "maxItems": MOST, "items": {
        "type": "object", "properties": {
            "key": {"type": "string", "description": key},
            "title": {"type": "string", "description": f"What it is, as {what}_find said"},
            "notes": {"type": "string", "description": "Optional: what it is for"},
            "tags": {"type": "array", "items": {"type": "string"}, "description": "Optional: e.g. fasteners, lamp"},
            "quantity": {"type": "integer", "minimum": 0, "description": "Optional: how many are needed"},
            "specs": {"type": "object", "additionalProperties": {"type": "string"},
                      "description": f"Optional: the specs {what}_find gave"}, **extra},
        "required": ["key"]}}}, "required": ["items"]}


TOOLS = [
    Tool(
        name="mcmaster_save", package="mfr", level="change", order=76, default=True,
        label="Save McMaster-Carr parts",
        about="Saves McMaster-Carr parts to the catalog's McMaster-Carr source.",
        description="Save McMaster-Carr parts (by part number, as mcmaster_find gave them) to this workspace's "
                    "Parts > McMaster-Carr, with a title, notes, tags and how many are needed. One saved "
                    "already is kept and its empty fields filled. Only when the person asks to save or keep them.",
        schema=_schema("mcmaster", "The part number (91290A115) or its McMaster link", {}),
        running="Saving McMaster-Carr parts", failed="Could not save the McMaster-Carr parts",
        run=_runner("mcmaster")),
    Tool(
        name="grabcad_save", package="mfr", level="change", order=77, default=True,
        label="Save GrabCAD models",
        about="Saves GrabCAD models to the catalog's GrabCAD source.",
        description="Save GrabCAD library models (by their page or slug, as grabcad_find gave them) to this "
                    "workspace's Parts > GrabCAD, with a title, uploader, notes, tags and licence. One "
                    "saved already is kept and its empty fields filled. Only when the person asks to save them.",
        schema=_schema("grabcad", "The model's page (https://grabcad.com/library/<slug>) or its slug", {
            "author": {"type": "string", "description": "Who uploaded it, as grabcad_find said"},
            "licence": {"type": "string", "description": "Optional: its licence, when the person said"}}),
        running="Saving GrabCAD models", failed="Could not save the GrabCAD models",
        run=_runner("grabcad")),
]
