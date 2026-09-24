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

## One main agent, one agent per room

Five rooms write notes into one queue: **3D Drawing** (`cad`), **PCB
Design** (`pcb`), and the three coding rooms **Web Programming** (`web`),
**Embedded Programming** (`embedded`) and **Mobile Programming**
(`mobile`). The agent opened in this repository is the **main agent**. It
does not apply notes itself. It keeps the queue moving:

1. `revisions.py wait` in the background - it returns on a queued note or
   on something said in the thread.
2. `revisions.py chat` first, when something was said: the person comes
   before the queue. Answer with `say`.
3. `revisions.py queue`, then hand each note to its room's agent with the
   Agent tool - `redline-3d`, `redline-pcb`, `redline-web`,
   `redline-embedded`, `redline-mobile` (`.claude/agents/`). Give it the
   revision id and nothing it can read for itself. `revisions.py kind
   <id>` says which room a note is from.
4. Rooms run **in parallel**, one note per room at a time: every room has
   its own run (`runs/current` for the 3D room, `runs/current:<room>` for
   the others), so one room's `start` and `finish` never touch another's.
   A second note for a busy room waits for the first.
5. When an agent reports back, say what happened in the thread in a
   line, and start `wait` again.

A room's agent owns its note from `start` to `finish`; `wait` stops
counting a note once its run has started, so the main agent is not woken
for work already in hand. Questions to the person go through `ask` from
whichever agent has the fork in front of it.

The same operations are an MCP server - `redline` in `.mcp.json`
(`tools/mcp_server.py`): `queue` (by room), `show`, `start`, `log`,
`finish`, `done`, `code_diff`, `code_test`, `chat`, `say`, `ask`. Each
one runs the matching revisions.py command, so the answers and the
refusals are the same either way.

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

**Each room (tab) has its own thread** - cad, pcb, web, embedded, mobile.
`chat` shows every room's, each line tagged `[pcb]` and so on; `chat --room
pcb` shows one. Answer in the room it was asked in: `say --room pcb "..."`.
Without `--room`, `say` goes to the room the person last spoke in. A room's
own agent runs `wait --room pcb` and `chat --room pcb` and hears only that
room.

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

## Say who you are

Set `X3_AGENT` to your name before running `tools/revisions.py` - the room
you work, e.g. `X3_AGENT="pcb room"` - and everything you write carries it:
runs, log lines, thread replies, questions, and every change you make
through the API (the command sends it as `X-Redline-Actor`). Without it you
are "agent". Deletes and changes of state are kept in an audit trail with
who made them; the person sees it in Analytics under *Recent changes*.

### Working without the database password

Two ways to reach the data, same commands and the same output:

- **Direct** (the default): `MONGODB_URI` from `.env`, as always.
- **Through the server**: `X3_TRANSPORT=api`, `X3_API=http://localhost:8000`
  and, when sign-in is on, `X3_TOKEN=rlat_...` - a token the person makes
  for you in the app (user menu > *Agent tokens*) and can take back at any
  time. No connection string is needed; the server does each database
  step for you (`backend/agent_api.py`, `tools/remote_db.py`) in the
  token's workspace, under the token's name, and records deletes. The MCP
  server and `revisions.py board ...` send the same token.

Never write a token into a file in the repo, a log line or a note. If a
command says it "wants an agent token", ask the person for one - do not
fall back to the database password.

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

**Ask it the way you would ask a systems engineer who is not a specialist
in this part.** The person decides what the product should be; they
should not have to know Freerouting, net names or DRC to answer. So:

- **Open with the decision in one plain sentence** - what they are choosing
  between and why it is theirs to choose. *"The board is almost done, but
  one connection sometimes fails to route. Should I retry automatically, or
  leave it for you to fix by hand?"*
- **Say what each choice means for the product**, not how it is done
  inside: time, cost, size, risk, what they would have to do. Keep jargon
  out; where a term is needed, say what it is in half a line.
- **Short.** Three or four sentences before the options is plenty. The
  evidence (numbers, tables, net names) goes in `-c`, for whoever wants it -
  the question itself reads without it.
- **Options are answers a person would say**: a few words to lead, then
  what it means - `-o "Retry automatically: a few seconds more per run,
  the board comes out complete"`, not `-o "retry: route again up to 3x"`.

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

Worse - too technical to answer without being an expert:

> Freerouting is non-deterministic at 40 passes; runs 1-4 left 1/2/0/1
> unrouted (v3v3 to U24 pin 16, vbus at U1). Retry up to 3x or keep stub?

Better - plain, short, the evidence behind it in `-c`:

> **One connection sometimes doesn't get routed.** The router is a little
> random: of four tries on the same layout, one came out complete and three
> left one wire short. I can retry automatically until a run comes out
> complete, or keep what we have and you finish that wire by hand.

Ask when the answer changes what you build. Do not ask what the drawing
already says, and do not ask two questions where one would do. A question is
worth a paragraph of what you measured; it is not worth a page.

## Board notes

A queued item marked `[BOARD]` is a note on a circuit board, written in
the PCB room. `model` is then a board id, and `part` is one of its
components as `U2 · C64898` - the reference and the LCSC number it is
bought by. There is no drawing and no camera; the note is the request.

The source is atopile. **Every change to a board goes through the whole
pipeline** - never a build on its own, never a layout on its own:

```bash
.venv/bin/python tools/revisions.py board source <id> > board.ato   # read it
.venv/bin/python tools/revisions.py board save <id> board.ato       # write it
.venv/bin/python tools/revisions.py board run <id>                  # all of it
.venv/bin/python tools/revisions.py board show <id>                 # where it stands
```

Routing rules (net classes, differential pairs, copper pours, the board
house's minimums, router passes) are the same ones the person edits in the
Rules tab. Change them as JSON, checked by the server before they are kept:

```bash
.venv/bin/python tools/revisions.py board rules-schema               # what every field is
.venv/bin/python tools/revisions.py board rules <id> rules.json      # current rules to a file
.venv/bin/python tools/revisions.py board rules-save <id> rules.json # write back (400 lists problems)
```

A class takes nets by name (`nets`) or by shell pattern (`patterns`, e.g.
`usb_*`); Default holds the rest and cannot be removed. `pours` is a list;
the first wins where two meet. Each problem names its field
(`classes.Power.track: ...`). Save the rules, then `board run`.

`run` builds the source, draws the schematic (KiCad, every part's real
symbol, pins joined by net labels, then ERC), places the parts (by module,
connectors on the edges facing out), routes with Freerouting to the
board's rules, pours ground, and runs KiCad's DRC. It prints what came
out. A board is done when it says **0 unrouted, DRC 0 errors, ERC 0
errors** - read the examples it prints when it does not, fix the source
or the rules, and run again. Log board work with `log --room pcb`.

The routing rules - net classes, pairs, the pour, the board house's
minimums - are the person's, in the room's **rules** tab. They are worked
out from net names the first time; do not overwrite what someone set. The
router narrows a class that cannot reach its narrowest pad and says so
("Power: 0.5 -> 0.34 mm, to reach U24 pad 5"); that is reported, not an
error. Freerouting routes a differential pair as two nets at the class's
width and gap, without coupling or length matching - fine for USB full
speed, and say so if someone asks for anything faster.

A part is chosen by its LCSC number (`mpn = "C25744"` on the component).
Then `done <id>` as usual.

## Code notes

A queued item marked `[WEB]`, `[EMBEDDED]` or `[MOBILE]` is a note from
one of the programming rooms. `model` is a project's id: a git checkout,
where it is served or how it is built, and its test command. A web or
phone note's drawing is a real screenshot of one route at one size, and
the note carries what was under the marks - selector, box, and the file
that renders it. A firmware note has no drawing; its `part` is the
function or table it is about, as `fan_command · firmware/common/fan.c:66`.

**Nothing runs on the host.** Every command below runs in the room's own
Docker image - `redline-code-web`, `-embedded`, `-mobile` - with the
checkout mounted at its own path. Do not install a compiler, a browser
or an SDK to get around a missing image; say which image is missing.

```bash
.venv/bin/python tools/revisions.py code show <id>     # note, page, elements, drawing
.venv/bin/python tools/revisions.py code diff <id>     # what changed since it was drawn
.venv/bin/python tools/revisions.py code test <id>     # the project's test command
.venv/bin/python tools/revisions.py code done <id>     # check, after shot, applied
.venv/bin/python tools/revisions.py code serve <app>   # its dev server, in its container
.venv/bin/python tools/revisions.py code build <app>   # firmware, into Redline's cache
.venv/bin/python tools/revisions.py code boards x      # STM32 / ESP32 boards plugged in
.venv/bin/python tools/revisions.py code flash <app>   # program the board
.venv/bin/python tools/revisions.py code phone x       # start the emulated phone
```

`show` writes the drawing out: **read it**, then go to the file it names.
Edit the project's checkout (`show` prints where it is). Files that were
already uncommitted when the note was drawn are somebody else's work in
progress: `show` counts them, and `code diff` leaves out what they said
then, so the diff is yours alone.

`done` is the only way a code note closes. For firmware it builds first
and refuses a build that fails; then it runs the test command and
**refuses while it fails**, photographs the same route at the same size
as the after picture, freezes the patch onto the note and marks it
applied. `done <id>` does the same for a code note, so the check cannot
be skipped by using the older command. Say what a firmware change cost in
flash and RAM - the build prints both.

Each room has its own log and its own thread: `log --room web`,
`chat --room web`, `say --room web` (or `embedded`, `mobile`). The room
agents in `.claude/agents/` already know theirs.

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

Resistors and capacitors from `part passive` need no fetching: the layout
draws them from KiCad's own library, which is in the container with its
3D models. `keep` the rest. It waits for LCSC's budget rather than
failing - a quarter of an hour for twenty new parts, better there than in
a layout that places half the board. Then lay out.

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
.venv/bin/python tools/revisions.py queue [--room R]     # what is queued, all or one room
.venv/bin/python tools/revisions.py kind <id>            # which room a note is from
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
.venv/bin/python tools/revisions.py finish <id>          # close that note's run
.venv/bin/python tools/revisions.py after <id>           # the "after" picture
.venv/bin/python tools/revisions.py usage [--full]       # what the work cost
.venv/bin/python tools/revisions.py code show|diff|test|done <id>        # code notes
.venv/bin/python tools/revisions.py code serve|build|flash <app>          # in the room's container
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
`error`). Each room has its own log: lines go to the 3D room's by default,
and `--room pcb` puts them in the board room's - log board work there, so
neither room's log is half about the other. `--room web`, `embedded` and
`mobile` are the coding rooms'. Start a run when you pick up a revision and finish it when you are
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

## The Tools tab

Read **[TOOLS.md](TOOLS.md)** when a task is about a tool, or before you
work out an engineering value by hand: `find_tool` (MCP) finds the tool for
it and `run_tool` runs it.

## Architecture

| Layer | Location |
|---|---|
| Model source | `models` collection |
| Generated viewer/STEP/STL | GridFS `model_files` (gzip) |
| Revision images | GridFS `shots` |
| Code projects | `apps` collection - a checkout, a url, a test command |
| A done code note's patch | GridFS `model_files` (gzip), on the revision |
| Version history | `model_versions` — source text only |
| Build | temporary directory, removed when finished |

See `.claude/skills/asset-revisions/SKILL.md` for details.
