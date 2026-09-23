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

## Never stop between revisions

When you finish one revision, do not hand the turn back and wait to be told
to carry on. Start the watcher **in the background** instead:

```bash
.venv/bin/python tools/revisions.py wait     # blocks; checks every 30s
```

It sits on the database and returns the moment anything is queued, printing
the ids. Its exit is what wakes you up, so you pick the next revision up by
yourself and the person never has to type "continue". Nothing is polled from
inside your turn - the turn ends, and the command brings you back.

```bash
.venv/bin/python tools/revisions.py wait --every 15        # check more often
.venv/bin/python tools/revisions.py wait --timeout 7200    # give up after 2h
.venv/bin/python tools/revisions.py wait --ignore <id>     # skip one you are leaving
```

It exits 0 when there is work and 2 when it timed out. Without `--timeout` it
waits as long as the session lasts, which is what you want: finish, start the
watcher, and the next request picks you up on its own.

## Ask on their screen, not in your terminal

When you reach a fork that is not yours to choose - which print process a
part is for, whether a shaft is bought or printed - ask. But the person who
drew the revision is looking at the model in a browser, not at your log:

```bash
.venv/bin/python tools/revisions.py ask "Which print process is this for?" \
  -o "FDM, 0.4 mm nozzle" -o "SLA / resin" \
  -c "Five fits are sized for accurate manufacture and would fuse on FDM."
```

The question appears at the top of the right-hand column, the browser raises
a notice, and the tab title says one is waiting. The command blocks and
prints the answer when it comes, so the answer is simply its output.

`-o` offers an answer and may be repeated; the form takes free text whichever
way, because the real answer is often "neither, and here is why". `-c` is
what you already know, so they are not made to reconstruct it. `--timeout N`
withdraws the question and exits 2 rather than waiting for ever.

Ask when the answer changes what you build. Do not ask what the drawing
already says, and do not ask two questions where one would do.

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
.venv/bin/python tools/revisions.py wait                 # block until there is
.venv/bin/python tools/revisions.py ask "..." -o A -o B  # ask on their screen
.venv/bin/python tools/revisions.py show <id>            # write drawing to disk
.venv/bin/python tools/revisions.py models               # list models
.venv/bin/python tools/revisions.py source <model>       # print source
.venv/bin/python tools/revisions.py save <model> <file>  # update source
.venv/bin/python tools/revisions.py build <model>        # rebuild (minutes)
.venv/bin/python tools/revisions.py done <id>            # mark as applied
.venv/bin/python tools/revisions.py finish               # close the run
.venv/bin/python tools/revisions.py after <id>           # the "after" picture
.venv/bin/python tools/revisions.py usage [--full]       # what the work cost
.venv/bin/python tools/render.py <id> [--camera=…|--only PART]
```

Without `build` the user cannot see your change. It takes minutes, so check
your arithmetic locally first - `export_model.py` renders straight from a
directory of sources - and run anything heavy through `./tools/capped.sh`,
which puts a memory ceiling on it. A boolean against a few hundred solids
will otherwise take the machine down with it.

`finish` closes the run, takes the after picture from the revision's own
camera and freezes what the work cost onto the card - tokens and money on
one side, the machine's CPU, memory and energy on the other.

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

### Always finish by rendering from the user's angle

Every revision stores the camera it was drawn from. After rebuilding, take the
picture from that same angle and look at it before you call the work done:

```bash
python tools/render.py <revision_id>          # writes /tmp/after-<id>.png
```

Open that file with the Read tool and compare it against the revision drawing.
Same viewpoint, so the before and after line up and a mistake is obvious. The
app also accepts `?rev=<id>` in the URL, which opens the model at that camera.

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
