# For models working in this repository

This is a **CAD revision tool**. A user opens a parametric build123d model in
the browser, freezes an angle, marks it with a red pen and leaves a note. The
request lands in MongoDB.

**There are no model files on disk.** Both the source code and the generated
artifacts live in the database — do not go looking for a `models/` folder.

## First thing to do

```bash
.venv/bin/python tools/revisions.py queue
```

If something is queued, write the drawing to disk with `show` and **open that
file with the Read tool**. The comment alone is not enough: when the user says
"these areas", only the red marks say which areas.

## Only `queued` items are work

| Status | Meaning |
|---|---|
| `draft` | the user is still writing — **leave it alone** |
| `queued` | **this is your work** |
| `applied` / `rejected` | closed |

Nothing counts as work until the user presses *queue*.

## Commands

```bash
.venv/bin/python tools/revisions.py queue                # what is queued
.venv/bin/python tools/revisions.py show <id>            # write drawing to disk
.venv/bin/python tools/revisions.py models               # list models
.venv/bin/python tools/revisions.py source <model>       # print source
.venv/bin/python tools/revisions.py save <model> <file>  # update source
.venv/bin/python tools/revisions.py build <model>        # rebuild (~15 s)
.venv/bin/python tools/revisions.py done <id>            # mark as applied
```

Without `build` the user cannot see your change.

## Show your progress on screen

The app has a progress bar at the top and an IDE-style log at the bottom. Use
them while you work so the user can follow along without reading a terminal:

```bash
.venv/bin/python tools/revisions.py start <id> "what you are doing"
.venv/bin/python tools/revisions.py log "reading source" -p 20 -l work
.venv/bin/python tools/revisions.py log "tessellating"  -p 80 -l work
.venv/bin/python tools/revisions.py finish            # or --failed
```

`-p` moves the bar, `-l` colours the line (`info`, `work`, `done`, `warn`,
`error`). Start a run when you pick up a revision and finish it when you are
done; the bar stays live in between.

## Model contract

```python
TITLE = "Fan 120 mm"
PARTS = [frame, rotor, pins]              # objects to tessellate
NAMES = ["housing", "impeller", "pins"]   # names in the tree
```

Models are parametric: when a dimension is requested, change the constant —
do not rewrite the geometry by hand.

## Silent failures

Traps already hit in this codebase:

- **Tessellation cache** — `linear_deflection` is silently ignored when the
  shape already has a triangulation. Call `BRepTools.Clean_s` first.
- **`Plane.rotated()` takes global angles**, not local. Assume local and the
  geometry comes out quietly wrong.
- **Loft sections must be polygons** — with ellipse wires OCCT raises
  `NCollection_DataMap::Find`.
- **`Compound(children=[...])` reparents** — building a helper compound
  detaches the parts from the previous one and corrupts the bounding box.
- **Use `grep -a` when scanning binaries** — in a concatenation that includes
  PNGs, grep treats the file as binary and silently reports nothing.

## Architecture

| Layer | Location |
|---|---|
| Model source | `models` collection |
| Generated viewer/STEP/STL | GridFS `model_files` (gzip) |
| Revision images | GridFS `shots` |
| Version history | `model_versions` — source text only |
| Build | temporary directory, removed when finished |

See `.claude/skills/asset-revisions/SKILL.md` for details.
