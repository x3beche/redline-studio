---
name: asset-revisions
description: Read and apply pending CAD revision requests from the database in this project. The user freezes the model in the browser, draws on it with a red pen and leaves a note; requests live in MongoDB, not on disk. Use when the user says "check the revisions", "what's queued", "pending requests", "apply what I drew", "update the model", or when you need to learn how to start work in this repository.
---

# Read and apply CAD revisions

This repository is a **CAD revision tool**. The user opens a parametric
build123d model in the browser, freezes an angle, marks it with a red pen and
writes a note. The request lands in MongoDB. **There are no model files on
disk**; both source code and generated artifacts live in the database.

## Two rules before anything else

1. **Only `queued` items are your work** (see below).
2. **Open a run the moment you pick one up, and keep the bar moving.** The
   user follows the work on screen, not in your terminal. A revision worked
   on without a run looks like nothing is happening.

   ```bash
   .venv/bin/python tools/revisions.py start <id> "what you are doing"
   .venv/bin/python tools/revisions.py log "reading the drawing" -p 10
   ...                                    # a line at every step, -p rising
   .venv/bin/python tools/revisions.py finish
   ```

   This is not optional and not something to do at the end: `start` comes
   before the first edit, and every step that takes more than a moment gets
   its own `log` line with a percentage.

## Not every queued item is a model

The queue is shared by two rooms. `revisions.py queue` marks a board note
`[BOARD]`; `revisions.py kind <id>` says which room any note is from.
This skill is the model loop. A board note goes to the board room's agent
(`redline-pcb` in `.claude/agents/`) and follows AGENTS.md - a board note
does not have a camera, and `build` does not take a board.

Rooms work in parallel, so close a run by its id: `finish <id>`.

## Firmware notes

`revisions.py queue` marks a note from the Firmware room `[FIRMWARE]`
(`kind` firmware, `model` = the firmware id). It goes to the Firmware
room's agent (`redline-firmware` in `.claude/agents/`) and follows
AGENTS.md, "Firmware notes". In short:

1. `start <id> "..."`, then `show <id>` (or `next --room firmware`): the
   firmware, the pin / net / code lines the note is anchored to as they are
   now, the build. Open the picture it writes - the sheet or the code the
   person drew on.
2. Read `include/pins.h` (`fw get <fw> include/pins.h`) - it is **generated
   from the schematic, never edit it** - and `fw pins <fw>`.
3. `fw get <fw> <path> -o /tmp/x`, edit, `fw put <fw> <path> /tmp/x --note "..."`
   (refused when the firmware moved on since you read it - read again).
4. `fw build <fw> --wait`: 0 errors, no new warnings (`-Wall -Wextra`),
   flash and RAM sane. `log ... --room firmware` as you go.
5. `finish <id>` - refused until the version holding the change has built
   cleanly; it keeps the diff, the build (flash/RAM before -> after) and a
   picture of the main changed hunk on the card. There is no render.
   The note then stays queued until the person reviews it and marks it
   applied - do not `done` it yourself unless they asked.

Rules: keep to the macros in pins.h; never drive a pin whose function is
unclear (input-only 34-39, strapping 0/2/5/12/15, a net you have not read
the parts of) - ask with `ask "..." --revision <id>`, which goes to the
Firmware thread; no blocking `delay()` in `loop()`; keep the serial
console's commands working; keep `-Wall` clean. Flashing is the person's
job, in the browser: the report says "built, ready to flash".

## Writing a task for the person

Asked to write a note or task for the queue? Put it in a ```` ```task ````
fence in your `say` answer - optional first lines `title: ...` and
`target: <model | board | firmware id>`, then the note as plain text; one
task per fence. The person queues it with one click ("Send to 3D queue"
under the box); nothing to copy and paste. See AGENTS.md, "Writing a task for the
person".

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
database. Without it the user cannot see the change. It is **slow** - a
couple of minutes for the assembly, and the page shows a progress bar while
it runs - so do not reach for it to check your arithmetic.

**Iterate locally instead.** The same script the build runs will render a
model straight from a directory of sources, in a fraction of the time and
without touching the database:

```bash
mkdir -p /tmp/w/models /tmp/w/assets
.venv/bin/python tools/revisions.py source base > /tmp/w/models/base.py
# ...and any module it imports, under the name it imports them by
./tools/capped.sh .venv/bin/python export_model.py base \
    --models-dir /tmp/w/models --assets-dir /tmp/w/assets
```

The model prints its own measurements, so this is where you check a change.
Only `save` + `build` when the numbers are right.

**Always run a model through `tools/capped.sh`.** A boolean against a few
hundred solids will eat the machine's memory and freeze the desktop; the
wrapper puts a ceiling on it so the kernel kills the build instead.

### Always finish by rendering from the user's angle

Every revision stores the camera it was drawn from. After rebuilding, take the
picture from that same angle and look at it before you call the work done:

```bash
.venv/bin/python tools/render.py <revision_id>    # writes /tmp/after-<id>.png
```

Open that file with the Read tool and compare it against the revision drawing.
Same viewpoint, so the before and after line up and a mistake is obvious. The
app also accepts `?rev=<id>` in the URL, which opens the model at that camera.

Two flags for when that angle is not the one that shows the change:

```bash
--camera=px,py,pz,tx,ty,tz    # look from somewhere else
--only taban_kapak            # show one part, the way a drawing was made
```

`--camera` starting with a minus needs `--camera=-150,...`, or argparse reads
it as another flag.

A shot with `--camera` or `--only` is a look of your own: it is written to
`/tmp/view-<id>-<hash>.png`, never to `/tmp/after-<id>.png`, so a close-up
cannot become the card's after picture. Only the plain shot (the note's own
camera) is the after.

The card keeps this picture as the revision's "after", beside the drawing:

```bash
.venv/bin/python tools/revisions.py after <id> [--only PART]
```

`finish` takes it for you, so this is only for a revision closed without one.

### 4. Mark it

```bash
.venv/bin/python tools/revisions.py done <id>
.venv/bin/python tools/revisions.py finish
```

Only once the work is genuinely finished. When unsure, ask the user.

`done` archives it too when auto-archive is on, and `finish` closes the run,
takes the after picture and freezes what the work cost - tokens, time and
money at list price - onto the card. Those numbers come from your own
transcripts; `revisions.py usage` re-reads them if a run ended badly.

A line marked **urgent** is printed by every command you run, so it reaches
you between steps rather than when you next go idle. It stops nothing:
answering it, changing course, or ending a running build with
`revisions.py stop <model>` are all your call.

There is a thread at the foot of the queue column for everything that is
not a mark on a model - moving models between folders, renaming, questions
about a build. `revisions.py chat` reads it and marks it picked up,
`revisions.py say "..."` answers on their screen, and `wait` returns on a
message as well as on a queued revision.

A fork that is not yours to choose goes to their screen, not to your log:
`revisions.py ask "..." -o "one" -o "another" -c "what you already know"`.
It blocks, the page shows it with a browser notice, and the answer comes
back as the command's output. `--timeout` withdraws it instead of waiting
for ever.

When the work is closed, do not wait to be asked for the next one. Put
`revisions.py wait` in the background and let the turn end: it checks the
queue every thirty seconds and returns as soon as anything is queued, which
brings you back with the ids in hand. `--every` changes the interval,
`--timeout` gives it an end, and it exits 2 if it reached one.

The card also shows what the machine spent: every build and every render is
metered by the kernel and filed against the revision you are working on, so
nothing has to be done by hand. `start` and `finish` read the machine's own
busy counter at both ends, which is the only way the "whole machine" figure
exists - a run closed some other way will not have it.

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
done; the bar stays live in between. Report bad news too: a `warn` line when
a measurement comes out wrong is more useful than a silent correction.

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

**Measure before you change anything, and leave the measurement behind as a
check.** Guessing at a dimension and looking at the render is how a part ends
up 0.4 mm inside another one. Probe the geometry - a thin box intersected with
a solid tells you where its surfaces are - then write the rule into the model
so it raises if it is ever broken again. Nearly every real defect in this
repository was found that way, and the ones that came back were the ones
nobody left a check for.

Write the number into the comment as well: *why* 1.6 mm and not 0.6 mm is the
thing the next reader cannot recover.

## Gotchas in this codebase

- **Tessellation cache**: `linear_deflection` is **silently ignored** when the
  shape already carries a triangulation. Call `BRepTools.Clean_s` first.
- **`Plane.rotated()` takes global angles**, not local. Assuming local produces
  silently wrong geometry.
- **Loft sections must be polygons**: with ellipse wires OCCT fails to match
  sections and raises `NCollection_DataMap::Find`.
- **`Compound(children=[...])` reparents its children**; building a helper
  compound detaches them from the previous one and corrupts the bounding box.
- **`is_valid` does not mean "one piece"**: two solids that never touch are
  both "valid". A lid that came apart into a body and two 0.95 mm³ flakes
  passed every check for weeks. Count `.solids()` where a part must be whole.
- **A half-space prism only spans the points that define it.** Extending a cut
  from a line between two points leaves material where the line stopped; run
  the line well past both ends.
- **`getComputedStyle(el).width` is the used width**, not what the rule says -
  it will report the laid-out size while a CSS rule says something else. When
  a panel will not resize, the layout is overriding it, not the cascade.
- **The notes may already be in English.** A switch on the comment form saves
  each one as an English request and keeps what was typed; the card summary
  follows the note's language.

## Talking to the database directly

If the tool is not enough, the collections are `revisions`, `models`,
`folders`, `uploads`, `settings`, `runs` (one row per
revision worked on, plus `current`), `activity` (the on-screen log),
`llm_calls` and `analytics` (what each revision cost), `compute_jobs` (one
row per build or render: CPU, peak memory, disk), `questions` (what the
agent is waiting on), `chat` (the thread). The GridFS buckets are
`model_files` (generated artifacts, gzipped), `shots` (revision images before
and after) and `uploads` (imported STEP/STL). The connection string is
`MONGODB_URI` in `.env`.

With the server running there is also HTTP:

```
GET  /api/queue
GET  /api/revisions/{id}/image?which=before|after
POST /api/models/{id}/build
GET  /api/revisions/{id}/analytics[?live=true]
POST /api/revisions/english          # every note as an English request
```

**Secrets stay server-side.** `MONGODB_URI` lives in `.env`, which is
gitignored; the model API keys (OpenRouter, Command Code) live only in MongoDB
(`llm_settings`, typed in Settings > LLM settings) and are never read from the
environment. Never put any of them in code, a log line or anything the browser
receives, and scan the diff before pushing - this repository is public.

## A part from the Files tab

Copy it into the project as a model of its own:
`revisions.py files to-model <file-id> --folder iot-fan/purchased [--title "..."]`
(the Files tab's "Add to project" does the same). The model keeps its own
copy of the CAD file, so deleting it from Files breaks nothing; then use the
new model as a component.