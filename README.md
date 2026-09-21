<div align="center">

# X3 Studios Asset Manager

**Open a parametric CAD model in the browser, freeze an angle, draw on it,
leave a revision note.** All project data lives in MongoDB.

</div>

![user interface](docs/screenshot.png)

## What it solves

Talking about a CAD revision is awkward: "chamfer that corner" — which corner,
by how much? This tool makes the conversation concrete. You orbit the model,
freeze the angle you want, mark it with a red pen and type your note. The
record is stored together with the marked-up image, the camera angle, the
selected part and the model name.

Revisions start as **drafts**. Until you press *queue*, `GET /api/queue`
returns nothing — so a teammate or a language model only ever sees what you
have approved.

## Stack

| Layer | Technology |
|---|---|
| Model | Python 3.12 + [build123d](https://github.com/gumyr/build123d) (OpenCascade) |
| Tessellation | `ocp_vscode` / `ocp-viewer-core` |
| Viewer | [three-cad-viewer](https://github.com/bernhard-42/three-cad-viewer) 5.0.6 — the very viewer the VS Code extension uses |
| Frontend | Angular 20 + Tailwind CSS 4 |
| Service | FastAPI + Uvicorn |
| Data | MongoDB + GridFS |

## Where the data lives

Nothing project-related is kept on disk. A temporary directory is created while
a model is built and removed as soon as the build finishes.

| Collection | Contents |
|---|---|
| `models` | model source code, title, sha256, generated-artifact references |
| `folders` | catalog folders |
| `revisions` | comment, camera, part, status, queue timestamp |
| `model_versions` | version history (latest + 10), source text only |
| `model_files` (GridFS) | generated viewer JSON / STEP / STL, gzipped |
| `shots` (GridFS) | marked-up revision images |

Version history deliberately stores **source code only**: viewer, STEP and STL
are derived artifacts and are rebuilt after a rollback. That keeps history in
kilobytes rather than megabytes.

## Setup

Requirements: **Python >= 3.10**, **Node >= 20.19**, a MongoDB connection
(Atlas or local).

```bash
git clone https://github.com/x3beche/x3-studios-asset-manager.git
cd x3-studios-asset-manager
cp .env.example .env          # fill in MONGODB_URI
./start.sh
```

On first run `start.sh` creates the virtual environment, installs npm
dependencies and starts both servers with live reload:

- UI <http://127.0.0.1:4200>
- API <http://127.0.0.1:8000>

Single-server production build: `./start.sh --build` &rarr; `:8000` only.

The connection string is read by the backend alone and never reaches the
frontend. `.env` is git-ignored.

## Working with language models

Two files are aimed at models opening this repository:

- **`AGENTS.md`** — the summary to read first
- **`.claude/skills/asset-revisions/SKILL.md`** — a Claude Code skill that
  triggers on requests like "what's queued" or "apply what I drew"

Because revisions live in the database, a model can see pending requests the
moment it opens the project:

```bash
.venv/bin/python tools/revisions.py queue    # queued requests
.venv/bin/python tools/revisions.py show ID  # write the marked image to disk
.venv/bin/python tools/revisions.py source fan_pro > /tmp/m.py
.venv/bin/python tools/revisions.py save fan_pro /tmp/m.py
.venv/bin/python tools/revisions.py build fan_pro
.venv/bin/python tools/revisions.py done ID
.venv/bin/python tools/render.py ID          # render from the drawing's camera
```

Every revision stores the camera it was drawn from, so the result can be
photographed from the same viewpoint. `?rev=<id>` in the URL opens the model
at that camera too.

The tool talks to MongoDB directly, so it works with the server stopped. Only
**queued** revisions count as work; drafts stay invisible.

While working, a model can report progress to the screen — a bar at the top and
a log at the bottom:

```bash
.venv/bin/python tools/revisions.py start ID "what you are doing"
.venv/bin/python tools/revisions.py log "reading source" -p 20 -l work
.venv/bin/python tools/revisions.py finish
```

## Usage

1. Create a model with **+M** in the left column. A skeleton is generated.
2. Write the model, build it with **↻** (build123d runs, the result goes to the
   database).
3. Click the model to open it in the viewer. **Double-click a part** and the
   form on the right fills itself in.
4. **Freeze and draw** &rarr; mark it up &rarr; write the comment and save.
5. Press **queue** when it is ready. Click the card thumbnail to enlarge it.

A single button on the card cycles the status: draft &rarr; queued &rarr;
applied &rarr; draft. So "applied" can be undone. **edit** changes the comment
and the part; the drawing itself is the record and stays as it was.

### Model contract

A module must define the following to appear in the catalog:

```python
TITLE = "Fan 120 mm"                    # optional, shown in the UI
PARTS = [frame, rotor, pins]            # build123d objects to tessellate
NAMES = ["housing", "impeller", "pins"] # optional, names in the tree
```

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/catalog` | folder + model tree |
| `PUT /api/models/{id}` | write source code |
| `POST /api/models/{id}/build` | tessellate, store output in the database |
| `GET /api/models/{id}/viewer.json` | viewer payload |
| `GET /api/models/{id}/file/{step\|stl}` | generated file |
| `GET /api/queue` | **queued revisions only** |
| `GET /api/revisions/{id}/image` | marked-up image |
| `PUT /api/revisions/{id}` | edit the comment and part (the drawing is immutable) |
| `DELETE /api/revisions/{id}` | delete a revision and its image |
| `POST /api/versions` · `POST /api/versions/{id}/restore` | snapshot / roll back |
| `GET /api/stats` · `GET /api/system` | database usage, CPU/RAM/GPU |
| `POST /api/activity` · `GET /api/activity` | the log shown at the bottom |
| `POST /api/run/start` · `POST /api/run/finish` · `GET /api/run` | the progress bar at the top |

## Gotchas

- **If WebGL is unavailable in Chrome** the viewer will not start. Chrome 137+
  removed the automatic software fallback. On hybrid Intel + NVIDIA machines
  `chrome://flags/#use-angle` &rarr; **OpenGL** fixes it; on the machine this
  was developed on, the default ANGLE backend could not create a GPU command
  buffer.
- `export_gltf` and tessellation calls **silently ignore** `linear_deflection`
  when the shape already carries a triangulation. Call `BRepTools.Clean_s`
  first.
- The `display.render(...)` example in the `three-cad-viewer` docs is
  misleading: `render()` lives on `Viewer`, and `resizeCadView` throws before
  the first `render()`.
- `Plane.rotated()` takes **global** angles, not local — assuming otherwise
  produces silently wrong geometry.
- Loft sections must be polygons; with ellipse wires OCCT fails to match
  sections and raises `NCollection_DataMap::Find`.
- `Compound(children=[...])` **reparents** its children, so building a helper
  compound detaches them from the previous one and corrupts the bounding box.

## License

MIT
