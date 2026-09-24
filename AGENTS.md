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

## They can talk back

Not everything a person wants is a mark on a model. "Move these into a
folder", "rename that one", "why is this build so slow" arrive in a thread
at the foot of the queue column:

```bash
.venv/bin/python tools/revisions.py chat          # read it, and pick it up
.venv/bin/python tools/revisions.py say "..."     # answer, on their screen
```

`chat` marks what they said as read, which is what stops it waking you
again - `--keep-unread` looks without picking it up. `wait` returns on a
message as well as on a queued revision, so the same idle loop covers both.

### When a line comes in marked urgent

They have flipped a switch that means "read this between steps, not when
you next look up". Every command you run prints it:

```
!! URGENT  09:14:02  wrong model, I meant the stand
```

It stops nothing by itself. What to do about it is your judgement, and the
whole range is open: answer and carry on, answer and change what you were
going to do next, or decide the four minutes of booleans under way are a
waste and end them:

```bash
.venv/bin/python tools/revisions.py stop <model>    # kill a running build
```

Nothing else in the application will do that for you. A build is expensive
to start again, so read what they said before you throw one away - and say
what you decided, either way.

Answer in the thread rather than in your terminal. Nothing in here changes
a model by itself: if they ask for something, do it and then say what you
did.

## Ask on their screen, not in your terminal

When you reach a fork that is not yours to choose - which print process a
part is for, whether a shaft is bought or printed - ask. But the person who
drew the revision is looking at the model in a browser, not at your log:

```bash
.venv/bin/python tools/revisions.py ask "Which print process is this for?" \
  -o "FDM, 0.4 mm nozzle" -o "SLA / resin" \
  -c "Five fits are sized for accurate manufacture and would fuse on FDM."
```

The question stops the screen: a card in the middle of it, the browser
raises a notice, and the tab title says one is waiting. The command blocks
and prints the answer when it comes, so the answer is simply its output.

**Write it in Markdown.** The question and the `-c` context are both
rendered, so use what the question needs and nothing it does not:

- `**bold**` for the thing that has to be read first - the measurement
  that does not fit, the constraint that broke;
- a list for the options and what each one costs;
- a table when every option has the same two or three numbers against it;
- `` `BACK_H = 28` `` for anything that is a name in the source.

```bash
.venv/bin/python tools/revisions.py ask "$(cat <<'EOF'
**The 18650 does not fit in any direction** - I need 7 mm.

| option | what moves | the product |
|---|---|---|
| taller | `BACK_H` 28 -> 35.1 | grows 7.1 mm |
| deeper | back wall 7.3 mm | length unchanged |

Two revisions ago you asked for compact, so I am asking rather than
guessing.
EOF
)" -o "taller" -o "deeper"
```

`-o` offers an answer and may be repeated; the form takes free text whichever
way, because the real answer is often "neither, and here is why". `-c` is
what you already know, so they are not made to reconstruct it. `--timeout N`
withdraws the question and exits 2 rather than waiting for ever.

Ask when the answer changes what you build. Do not ask what the drawing
already says, and do not ask two questions where one would do. A question is
worth a paragraph of what you measured; it is not worth a page.

## Board notes

A queued item marked `[BOARD]` is a note on a circuit board, written in
the PCB room. `model` is then a board id, and `part` is one of its
components as `U2 · C64898` - the reference and the LCSC number it is
bought by. There is no drawing and no camera; the note is the request.

The source is atopile, and it lives behind the API rather than behind
`revisions.py`:

```bash
curl -s localhost:8000/api/boards/<id> | jq -r .source   # read it
curl -s -X PUT localhost:8000/api/boards/<id> \
     -H 'content-type: application/json' -d '{"source": "..."}'
curl -s -X POST localhost:8000/api/boards/<id>/build     # netlist
curl -s -X POST localhost:8000/api/boards/<id>/layout    # place, draw, model
```

A part is chosen by its LCSC number (`mpn = "C25744"` on the component).
Then `done <id>` as usual.

## Designing a board from a description

"STM32F042, two buttons, USB-C charging with a TP4056, a CH340G with a
12 MHz crystal" is a board. Four commands do the part of it that is
looking things up, and none of them is written from memory:

```bash
.venv/bin/python tools/revisions.py part find TP4056          # ranked
.venv/bin/python tools/revisions.py part passive R 10k 0402   # instant
.venv/bin/python tools/revisions.py part pins C2969989        # pinout
.venv/bin/python tools/revisions.py part ato C2969989 C14267  # paste these
```

- `find` searches LCSC and puts first what can be bought and assembled:
  in stock, then JLCPCB **Basic** (no feeder fee) before Extended, then
  the most stock. LCSC's own order put an out-of-stock TP4056 first.
- `passive` is for resistors and capacitors. Keyword search is useless
  for them - "0402 10k resistor" returns 10 W through-hole parts - so
  they come from `backend/passives.json`, every row checked against LCSC
  by exact part number. Not in the table: pick one with `find` and the
  manufacturer part number, never a guessed C-number.
- `ato` writes the component block from the part's own EasyEDA symbol:
  every pin by its footprint number, pins that share a name on one
  signal, and names spelled out so `UD+` and `UD-` stay two signals.
  Paste it; do not retype it.
- `pins` is the same pinout as a list, for reading.

Then write the module that connects them and build. Before laying out,
fetch every part's footprint and model once:

```bash
.venv/bin/python tools/revisions.py part keep C2969989 C14267 ...
```

`keep` waits for LCSC's budget rather than failing, so twenty new parts
take a quarter of an hour - better there than in a layout that places half
the board. Then lay out.

Check the netlist the build produces for the connections that matter - the
USB pair, the UART crossover (TX to RX), each rail on its own net, every
ground - before you call it done. Write the checks down as code against
the build's netlist, not by eye.

Read each generated block, do not assume one from its neighbour: the
red KT-0603R LED has its anode on pin 1 and the green KT-0603G its
cathode. A four-pin tactile switch joins its pins in pairs; which pairs is
in the symbol's drawing (`part pins` then look at the shapes), and wiring
the wrong two makes a button that is always pressed.

Things this does not do for you: choose topology (a regulator the MCU
needs, load sharing on a Li-ion charger, CC pull-downs on a USB-C sink),
and check the datasheet's application circuit. Those are yours. And a
Cortex-M0 like the STM32F0 has SWD, not JTAG - say so when asked for JTAG.

### Be gentle with LCSC

These are EasyEDA's own endpoints, not a promised API, and they turn a
burst away - a 403 that lasts ten minutes, after roughly forty requests
in a minute or two. Every ask waits its turn (one per 2.5 s, shared by
every process), a refusal stops all asking until it passes, and parts
already looked at come from disk without asking. Every ask - yours, the
page's - is written down and shown in the board room's **lcsc** tab.
When `find` says it is cooling off, wait; do not loop on it.

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
.venv/bin/python tools/revisions.py part find|pins|ato|passive|keep ...  # parts
.venv/bin/python tools/revisions.py chat                 # what they said
.venv/bin/python tools/revisions.py say "..."            # answer them
.venv/bin/python tools/revisions.py show <id>            # write drawing to disk
.venv/bin/python tools/revisions.py models               # list models
.venv/bin/python tools/revisions.py source <model>       # print source
.venv/bin/python tools/revisions.py save <model> <file>  # update source
.venv/bin/python tools/revisions.py build <model>        # rebuild (minutes)
.venv/bin/python tools/revisions.py stop <model>         # end one early
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

`--width` and `--height` are the size of the picture, not of the browser
window: the window is grown until the canvas measures what was asked for.
The stored camera is applied for you - an explicit `--camera=px,py,pz,tx,ty,tz`
is for when you want a different side of the part than the one drawn on.

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
