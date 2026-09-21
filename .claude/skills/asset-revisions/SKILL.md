---
name: asset-revisions
description: Read and apply pending CAD revision requests from the database in this project. The user freezes the model in the browser, draws on it with a red pen and leaves a note; requests live in MongoDB, not on disk. Use when the user says "check the revisions", "what's queued", "pending requests", "apply what I drew", "update the model", or when you need to learn how to start work in this repository.
---

# Read and apply CAD revisions

This repository is a **CAD revision tool**. The user opens a parametric
build123d model in the browser, freezes an angle, marks it with a red pen and
writes a note. The request lands in MongoDB. **There are no model files on
disk**; both source code and generated artifacts live in the database.

## Important: only "queued" items are your work

Revisions have four states:

| Status | Meaning |
|---|---|
| `draft` | the user is still writing — **invisible to you, leave it alone** |
| `queued` | put in the apply queue — **this is your work** |
| `applied` | done |
| `rejected` | cancelled |

Nothing counts as work until the user presses *queue*. Do not apply drafts on
your own initiative.

## Workflow

Run everything from the repository root with the project virtual environment:

```bash
.venv/bin/python tools/revisions.py queue
```

### 1. See what is queued

```bash
.venv/bin/python tools/revisions.py queue
```

Prints the comment, which model, which part, the camera angle and the command
to fetch the image for each record.

### 2. Look at the drawing — do not skip this

```bash
.venv/bin/python tools/revisions.py show <id>
```

Writes the PNG to disk and prints the path. **Open that file with the Read
tool.** The comment alone is not enough: when the user says "these areas", only
the red marks say which areas. Interpret the marks together with the camera
angle.

### 3. Fetch the source, change it, write it back

```bash
.venv/bin/python tools/revisions.py source fan_pro > /tmp/fan_pro.py
# edit /tmp/fan_pro.py
.venv/bin/python tools/revisions.py save fan_pro /tmp/fan_pro.py
.venv/bin/python tools/revisions.py build fan_pro
```

`build` runs tessellation and writes the viewer/STEP/STL output to the
database. It takes roughly 15 seconds. Without it the user cannot see the
change.

You may want a snapshot before a large change:

```bash
curl -s -X POST "http://127.0.0.1:8000/api/versions?note=before%20change"
```

### Always finish by rendering from the user's angle

Every revision stores the camera it was drawn from. After rebuilding, take the
picture from that same angle and look at it before you call the work done:

```bash
python tools/render.py <revision_id>          # writes /tmp/after-<id>.png
```

Open that file with the Read tool and compare it against the revision drawing.
Same viewpoint, so the before and after line up and a mistake is obvious. The
app also accepts `?rev=<id>` in the URL, which opens the model at that camera.

### 4. Mark it

```bash
.venv/bin/python tools/revisions.py done <id>
```

Only once the work is genuinely finished. When unsure, ask the user.

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

## When changing a model

A model module must satisfy this contract or it will not appear in the catalog:

```python
TITLE = "Fan 120 mm"                      # name shown in the UI
PARTS = [frame, rotor, pins]              # build123d objects to tessellate
NAMES = ["housing", "impeller", "pins"]
```

Models are parametric. When a dimension is requested, change the constant
rather than rewriting the geometry. After a change, check volume, bounding box
and interference — the model files already print these.

## Gotchas in this codebase

- **Tessellation cache**: `linear_deflection` is **silently ignored** when the
  shape already carries a triangulation. Call `BRepTools.Clean_s` first.
- **`Plane.rotated()` takes global angles**, not local. Assuming local produces
  silently wrong geometry.
- **Loft sections must be polygons**: with ellipse wires OCCT fails to match
  sections and raises `NCollection_DataMap::Find`.
- **`Compound(children=[...])` reparents its children**; building a helper
  compound detaches them from the previous one and corrupts the bounding box.

## Talking to the database directly

If the tool is not enough, the collections are `revisions`, `models`,
`folders`, `model_versions`; the GridFS buckets are `model_files` (generated
artifacts, gzipped) and `shots` (revision images). The connection string is
`MONGODB_URI` in `.env`.

With the server running there is also HTTP: `GET /api/queue`,
`GET /api/revisions/{id}/image`, `POST /api/models/{id}/build`.
