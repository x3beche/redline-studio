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

Three rooms write notes into one queue: **3D Drawing** (`cad`), **PCB
Design** (`pcb`) and **Firmware** (`firmware`). The agent opened in this repository is the **main agent**. It
does not apply notes itself. It keeps the queue moving:

1. `revisions.py wait` in the background - it returns on a queued note or
   on something said in the thread.
2. `revisions.py chat` first, when something was said: the person comes
   before the queue. Answer with `say`.
3. `revisions.py queue`, then hand each note to its room's agent with the
   Agent tool - `redline-3d`, `redline-pcb` or `redline-firmware`
   (`.claude/agents/`). Give it the
   revision id and nothing it can read for itself. `revisions.py kind
   <id>` says which room a note is from.
4. Rooms run **in parallel**, one note per room at a time: every room has
   its own run (`runs/current` for the 3D room, `runs/current:<room>` for
   the others), so one room's `start` and `finish` never touch another's.
   A second note for a busy room waits for the first.
5. When an agent reports back, review its work: read the report, look at
   the after picture (`revisions.py show <id>`) or, for firmware, the diff
   and the build on the card, and check it does what the note asked. If it
   does, mark it applied yourself - `revisions.py done <id>` (archived too
   when auto-archive is on). If it does not, send it back to the room's
   agent with what is missing, or leave it in review and say why in the
   thread. A failed run (`finish --failed`) is never marked applied. Then
   say what happened in the thread in a line, and start `wait` again.

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

### Never block your own turn

If you are the main agent, you are the only thing moving the queue. Every
room agent you would hand a note to, every thread you would answer, every
question that would reach the person's screen goes through your turn. So a
turn that sits and waits does not cost you a minute - it stops everything.

Never spend your turn waiting for something to happen. In particular, never
write a shell loop that polls:

```bash
until ! pgrep -f something; do sleep 10; done      # NO
while [ ! -f result ]; do sleep 5; done            # NO
sleep 60 && cat output                             # NO
```

These look harmless and they are the main way a session dies. The loop holds
the turn open, the watcher cannot wake you because you never went to sleep,
notes pile up queued, and the person watches a progress bar that has stopped
and has to type "don't get stuck" to get you back.

What to do instead: start the slow thing in the background and **end your
turn**. A background command re-invokes you when it exits, and that is the
whole mechanism - `revisions.py wait` works the same way. Both bring you
back with the output. You do not need to watch anything to find out how it
went.

```bash
# start it in the background, then stop talking and let the turn end
.venv/bin/python tools/revisions.py board run controller
```

The same goes for a room agent you handed a note to: it reports back on its
own when it is done. Do not poll it, do not ask it whether it is finished,
and do not hold your turn open until it answers. Hand the note over, write
your line in the thread, start the watcher, end the turn.

If you genuinely have nothing to do but wait, the correct move is to end the
turn with the watcher running. An idle main agent with a live watcher is
working. An agent in a `sleep` loop is not.

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

**Each room (tab) has its own thread** - cad and pcb.
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

### Writing a task for the person

When someone asks you (in a room's thread, or anywhere they will read it on
screen) to write a note or a task for the queue, do not hand them text to
copy into the note form. Put each task in a fenced block whose info string is
`task`:

````
```task
title: Seat the screen on the real STEP
target: iot-fan/assemblies/base
- oled_091 takes its geometry from the uploaded STEP ...
- ask before changing the design if it does not fit
```
````

- `title:` and `target:` are optional first lines; `target` is the model id
  (3D room), board id (PCB room) or firmware id (Firmware room) the note is
  about. Leave it out when you do not know - the page then uses what the
  person has open, or lets them pick.
- Everything after them is the note itself, plain text or Markdown. One task
  per fence; several tasks are several fences.
- The page draws the block as a box with a **Send to 3D queue** (PCB,
  Firmware) button and the target beside it. One click files it as a
  queued note in that room (from the stored message, not
  from anything the page sends) and the button stays spent for everyone.
  Write the text the agent who picks it up needs - it is the note, word for
  word.

## What your work changed is kept

`start` and `finish` record every model's and board's source in the
note's project, before and after; the card then shows the files you
changed side by side. Nothing to do for it - but it is what the person
reads, so change what the note asks for and not more.

The person can edit a source too, in the code view (the `</>` button).
**Read the source again right before you save it** - `source` / `board
source` - rather than saving over a copy you read at the start of the
note, or their edit is lost.

An **imported** board (`kind: imported`) has no atopile source: it was
made from Gerbers, a netlist, a STEP. Don't try to build or edit it -
convert it first (below, *Converting an imported board*).

## Say who you are

Set `REDLINE_AGENT` to your name before running `tools/revisions.py` - the room
you work, e.g. `REDLINE_AGENT="pcb room"` - and everything you write carries it:
runs, log lines, thread replies, questions, and every change you make
through the API (the command sends it as `X-Redline-Actor`). Without it you
are "agent". Deletes and changes of state are kept in an audit trail with
who made them; the person sees it in Analytics under *Recent changes*.

### Working without the database password

Two ways to reach the data, same commands and the same output:

- **Direct** (the default): `MONGODB_URI` from `.env`, as always.
- **Through the server**: `REDLINE_TRANSPORT=api`, `REDLINE_API=http://localhost:8000`
  and, when sign-in is on, `REDLINE_TOKEN=rlat_...` - a token the person makes
  for you in the app (user menu > *Agent tokens*) and can take back at any
  time. No connection string is needed; the server does each database
  step for you (`backend/agent_api.py`, `tools/remote_db.py`) in the
  token's workspace, under the token's name, and records deletes. The MCP
  server and `revisions.py board ...` send the same token.

On this machine the agents share one token, `REDLINE_TOKEN` in `.env` (which
is not in the repo): the commands and the MCP server read it from there,
and `REDLINE_AGENT` still says which of you is acting.

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

### Your questions reach Telegram too

When the server has a Telegram bot (Settings > Telegram), each question you
ask is also sent to the linked people who opted in. The options become
buttons, and there is a reply box for their own words. The question is
translated into their language if they set one. Their answer comes back
through the same `answer` as the app's, recorded as theirs `"via":
"telegram"`, and your `ask` command returns it like any other answer. Write
for a phone screen:

- put the question in the first line;
- put the evidence in `-c`;
- keep options short: a button shows about 60 characters, and longer options
  are numbered and spelled out in the message.

People can also reach you from Telegram. `/ask` and the "ask the agent"
button post into your room's thread like the page's Chat tab does, and `/note`
makes a draft note (with a photo, when they sent one) that is work only
once it is `queued`. Nothing changes for you: read the thread and the
queue as always.

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
connectors on the edges facing out), routes to the board's rules with
the router its rules name (`route.engine`: `freerouting`, the default, or
`tracemaker`, which the person can watch routing in the layout view),
pours ground, and runs KiCad's DRC. It prints what came
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
speed, and say so if someone asks for anything faster; TraceMaker routes
pairs coupled. The engine is the person's choice, like the other rules:
change it only when asked.

A part is chosen by its LCSC number (`mpn = "C25744"` on the component).
Then `done <id>` as usual.

### A part's 3D sits wrong on this board

An LCSC part's model comes seated the way EasyEDA placed it, and that is
not always how it is fitted here: a right-angle header comes standing, a
TO-220 meant to lie flat stands up. Never change the shared parts drawer
for one board - set the pose on the board, by reference:

```bash
.venv/bin/python tools/revisions.py board pose <id> Q5 --rotate 90,0,0 --offset 0,1.785,2.27 \
    --why "TO-220 lies flat on the board"
.venv/bin/python tools/revisions.py board pose <id> I2C --rotate 0,0,0 --offset 0.005,2.85,0.05 \
    --mirror y --why "right-angle header, pins out over the rear edge"
.venv/bin/python tools/revisions.py board pose <id>                 # list them
.venv/bin/python tools/revisions.py board pose <id> Q5 --clear      # remove one
```

Measure first (the model's box against the pads, in KiCad's conventions:
degrees; offset in mm with +Y up - the footprint's -Y; rotated, then
moved - see `backend/modelseat.py`). The numbers **replace** the model's
seat, they are not added to it; a value left out stays as the footprint
has it. `--mirror x|y` flips the part's silkscreen and courtyard about its
own axis (pads and copper stay) for a body that now sticks out the other
side. A negative first number is written `--rotate=-90,0,0`. The pose is
kept with the LCSC part it was measured on (`--lcsc` to name another) and
only applied while the board uses that part. Then `board run` - every
layout applies it, held or packed, so the GLB and STEP have it - and look
at the 3D view (or render it) from the side the part is on. Board health
lists the poses, and whoever may edit the board can remove one there.

### A part needs another 3D body: ask the 3D room

A part fitted differently from LCSC's model - a TO-220 lying flat, a
header with short legs - gets a **body of its own**, drawn in the 3D room
and bound to the part, rather than a pose hand-tuned on one board. A part
has LCSC's body plus any drawn ones; one is the part's **default** (LCSC's
until changed), and a board can choose another per reference:

```bash
.venv/bin/python tools/revisions.py part bodies C111607              # its bodies, * the default
.venv/bin/python tools/revisions.py part body-request C111607 --name "lying flat" \
    --why "bolted flat, tab over the edge" --board demoboard-gerber-zip --ref Q5
.venv/bin/python tools/revisions.py board body demoboard-gerber-zip               # who wears what
.venv/bin/python tools/revisions.py board body demoboard-gerber-zip Q5 lying-flat  # or lcsc / default
.venv/bin/python tools/revisions.py part body-default C111607 lying-flat|lcsc     # every board
```

`body-request` files a queued note in the 3D room with the footprint
(pads, pin 1, outlines) in the component frame, LCSC's body's box, the
datasheet command, the model id to use (`components/<C>-<name>`) and the
bind command. When the 3D agent has bound it, choose it on the board with
`board body` - the board's 3D is redrawn at once without re-routing (a
`board run` does it too). The choice is the board's, audited; Board health
shows a selector per reference whose part has more than one body. A drawn
body is used as-is: a pose on the same reference is not applied to it.

### Converting an imported board

```bash
.venv/bin/python tools/revisions.py board convert <id>                  # parts, source, build, check
.venv/bin/python tools/revisions.py board convert <id> --part U5=C14267 --why "CH340G: XI/XO, UD+/UD-"
.venv/bin/python tools/revisions.py board convert <id> --bom bom.csv    # a BOM replaces the guesses
.venv/bin/python tools/revisions.py board convert <id> --run            # then the whole pipeline
.venv/bin/python tools/revisions.py board hold <id> off                 # let the placer redo the layout
```

`backend/convert.py` writes the atopile: one component per part number
from the part's EasyEDA symbol, every multi-pad net of the import under
its own name (`override_net_name`), every pad by its number, every
designator kept (`designator = "U2"`), parts grouped into modules by who
shares nets with which chip. It builds the source and compares the
netlist with the import's as sets of (ref, pad) pairs; the board stops
being `imported` only when they are equivalent. `board run` repeats the
comparison on every build - a difference after a note is the note's
change, and should be one you meant.

Where the parts come from, in order: the BOM's LCSC number; a pick
(`--part`, kept on the board); `backend/passives.json` for R and C by
size (value from the BOM, else a placeholder); a search by the
footprint's name that only accepts a part whose EasyEDA footprint has
that exact name. Anything else is **unresolved** and the command says
which designator needs a `--part`. Choose it the way *Designing a board
from a description* says - read the nets on its pads, `part find`,
`part pins` - and check the report's `land` column: the part's own
footprint is laid over the board's pads, and more than a few hundredths
of a millimetre means a different land pattern. **Every part not from a
BOM is marked `GUESSED`** in the source and the report; say which ones
when you report, and never present a guess as the board's real part.

Do not fix the design while converting - a net that looks wrong is kept
and listed under findings. The layout is held (placer puts each part
where its pads were; the Gerber outline is the edge); routing, the pour
and DRC are the pipeline's.

Fixing it afterwards, when a note asks, is a normal board change (source,
save, run). A part the note adds has no place in the import: the placer
puts it in the free room nearest the pads it connects to (signal nets
first, ground and wide rails count little), every held part stays where
it was, and the run lists it as `placed_new`. The comparison with the
import then shows the change as a difference - say it was meant:

```bash
.venv/bin/python tools/revisions.py board changes <id> --net LED2_2 --net GND \
    --ref R23 --why "LED common cathode was not grounded"
.venv/bin/python tools/revisions.py board changes <id> --clear          # forget them
```

Every difference stays listed; those touching a named net (either
netlist's name) or part are marked `intended` with the reason, and Board
health shows them under *Changed on purpose* instead of calling the board
not the original. Name only what the note changed.

## Firmware notes

A queued item marked `[FIRMWARE]` is a note written in the **Firmware**
room. `model` is then a firmware id (`U2 ESP32` on the demoboard is
`cb4a67357c9f`), and the note has an **anchor** - what it is about:

- a pin of the MCU (a row of Pins) or a net label on the sheet: the pin,
  its GPIO, the net and its `pins.h` macro, and the parts on that net;
- lines of a file (selected in the Code view): `src/main.cpp:12-18`, with
  the lines as they were when the note was written;
- nothing: the firmware as a whole.

`show <id>` (or `next --room firmware`) prints the firmware, the anchor as
it is now (the code lines with context, or where the pin's macro is used),
the note, and where the last build stands; the picture it writes is the view
the note was drawn on (the sheet or the code) - open it.

The work, start to finish:

```bash
.venv/bin/python tools/revisions.py start <id> "blink LED4 on the button"
.venv/bin/python tools/revisions.py fw files <fw>                    # the tree, its version
.venv/bin/python tools/revisions.py fw pins <fw>                     # pins, nets, parts, used where
.venv/bin/python tools/revisions.py fw get <fw> include/pins.h       # read it - GENERATED, never edit
.venv/bin/python tools/revisions.py fw get <fw> src/input.cpp -o /tmp/input.cpp
# edit /tmp/input.cpp
.venv/bin/python tools/revisions.py fw put <fw> src/input.cpp /tmp/input.cpp --note "LED4 blinks twice on press"
.venv/bin/python tools/revisions.py fw build <fw> --wait             # errors/warnings as file:line, flash, RAM
.venv/bin/python tools/revisions.py fw diff <fw>                      # what the last version changed
.venv/bin/python tools/revisions.py log "built: 0 errors, flash 24.7%" --room firmware -p 90 -l done
.venv/bin/python tools/revisions.py finish <id>
```

- `fw put` saves a new version, refused (409) when the firmware moved on
  since the version you read (`fw files` / `fw get` remember it; `--base N`
  says it outright). Read again, merge, put again. Several files: give
  `path file` pairs.
- `finish <id>` on a firmware note is **refused until the version holding
  the change has built with 0 errors**. Then it keeps on the card the diff
  from the version the run started at, the build (errors, warnings, flash
  and RAM before -> after) and a picture of the main changed hunk - that is
  the note's "after"; there is no render. `finish --failed` when it cannot
  be done, with the reason in the thread.
- After `finish` the note is in review, as with a 3D or board note:
  `wait` and `next` no longer count it as work, and the main agent
  reviews it and marks it applied (`done <id>`) when it does what the
  note asked - see "One main agent, one agent per room". The room's
  agent does not mark its own note applied.
- **Flashing is the person's job**, from the browser (Firmware room >
  Flash, over USB). Never claim it runs on the board: the report says
  "built, ready to flash", with what to look for when they do.

Rules:

- `include/pins.h` is generated from the board's schematic and written
  again when the board changes. **Never edit it** (`fw put` refuses);
  use its macros (`LED4`, `ENC_S`, `L_SDA`), never a bare GPIO number. A
  pin that is not in it is not wired on this board - ask, do not invent.
- **Never drive a pin whose function is unclear** - an input-only pin
  (34-39), a strapping pin (0, 2, 5, 12, 15), a net whose parts you have not
  read. Read `fw pins`, and ask on their screen (`ask --revision <id>`,
  it goes to the Firmware thread) when the note does not say.
- No blocking `delay()` in `loop()` or in anything it calls: timing with
  `millis()` and state, so the console, the encoder and the display keep
  running.
- Keep the serial console's commands working (`src/console.cpp` and its
  `help`): the person's Flash dialog and serial monitor offer them as
  buttons. A new behaviour worth poking at gets a command.
- Keep the build `-Wall -Wextra` clean: a new warning is a failure to fix,
  not a figure to report.

Questions about a firmware note go to the Firmware room's thread:
`revisions.py ask "..." --revision <id>` (or `--room firmware`), and
`chat --room firmware` / `say --room firmware` for the thread itself. The
MCP server has the same: `next`, `fw_files`, `fw_get`, `fw_put`,
`fw_build`, `fw_diff`, `fw_pins`.

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
- `datasheet C2969989 [-o file.pdf]` saves LCSC's PDF (default
  `/tmp/<C>-datasheet.pdf`) and prints the path, the page count when it
  is cheap to tell, and where it came from; read it with `pdf text C2969989`
  and `pdf page` (below, *Reading a PDF*).
  Only when the note needs facts from it - a pinout the symbol leaves
  unclear, ratings, the application circuit, layout guidance - never by
  default. Kept in `.cache/lcsc/<C>/` after the first fetch; the page's
  part card has the same **Datasheet** button (`GET /api/parts/<C>/datasheet`).

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

## Files people upload

The **Files** tab is where a person drops what the work needs and the app
has no other place for: a BOM for a board that came in as bare Gerbers, a
pick-and-place file, a datasheet, a photo. Each file keeps who brought it
and the board it is for; a BOM is recognised by its header row. "Send to
agent" puts a line in a room's thread with the file's id and the command
that fetches it - that line is information, not a queued note.

A person can also paste, drop or attach a picture (or any file) straight
into a room's thread. It is kept in Files (folder "Chat") and `chat` prints
it under their line as `[attached image: <name>, file id <id> - fetch: ...]`.
When the line is about the picture, run that `files get <id> -o /tmp/<name>`
and open the file with the Read tool to look at it before you answer.

```bash
.venv/bin/python tools/revisions.py files --board <id>        # what was uploaded for a board
.venv/bin/python tools/revisions.py files get <file-id> -o bom.csv
.venv/bin/python tools/revisions.py board convert <id> --bom bom.csv --run
.venv/bin/python tools/revisions.py files put out.pdf --board <id> --note "..."   # give one back
.venv/bin/python tools/revisions.py files --folder datasheets/power      # what is in a folder ('/' the top)
.venv/bin/python tools/revisions.py files put ldo.pdf --folder datasheets/power   # into a folder (made if missing)
.venv/bin/python tools/revisions.py files mkdir datasheets/power         # a folder, and its parents
.venv/bin/python tools/revisions.py files mv <file-id|folder path> <folder path|/>
```

Files sit in folders the person makes (`file_folders`); a file from before
folders is at the top. Put what you give back where they keep that kind of
thing, and do not move or rename their files unless they ask.

Before guessing parts for an imported board, look here: a BOM someone
uploaded replaces every guess.

### Reading a PDF

A datasheet in Files, a part's LCSC datasheet, or a PDF on disk - the
server reads it (backend/pdftext.py, PDFium), so it works with a token as
well (`REDLINE_TRANSPORT=api`). No pdftotext or PDF library is needed on
your side. **Text first, then the page as a picture** for what the text
leaves out - tables, pinout diagrams, a mechanical drawing's dimensions:

```bash
.venv/bin/python tools/revisions.py pdf text <file-id|C111607|file.pdf> [--pages 1-3]
.venv/bin/python tools/revisions.py pdf page <file-id|C111607|file.pdf> 8 [--dpi 200] [-o out.png]
```

- `pdf text` prints each page under `===== page n / N =====` (at most 50
  pages a call; `--pages 1-3`, `2`, `1,4,7-9`, `5-`). A page with little
  or no text is marked - it is drawn or scanned: look at it.
- `pdf page` writes `/tmp/<name>-p<n>.png` (36-300 dpi, the longer side
  at most 4000 px) and prints the path: **open it with the Read tool**.
  200 dpi reads small dimension text.
- A C-number reads the part's kept datasheet, fetched from LCSC first only
  if it never was. A file id must be a PDF (415 otherwise). Never guess a
  dimension a datasheet gives: read the drawing.
- The routes: `GET /api/files/<id>/pdf?pages=1-3` -> `{count, pages: [{n, text}]}`,
  `GET /api/files/<id>/pdf/page/<n>.png?dpi=150`, and the same for a part:
  `GET /api/parts/<C>/datasheet/text`, `.../datasheet/page/<n>.png`.

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
.venv/bin/python tools/revisions.py next [--room R]      # the next one nobody started, in full
.venv/bin/python tools/revisions.py kind <id>            # which room a note is from
.venv/bin/python tools/revisions.py wait                 # block until there is
.venv/bin/python tools/revisions.py ask "..." -o A -o B  # ask on their screen
.venv/bin/python tools/revisions.py part find|pins|ato|passive|keep|datasheet ...  # parts
.venv/bin/python tools/revisions.py part bodies|body-bind|body-default|body-unbind|body-request C...  # 3D bodies
.venv/bin/python tools/revisions.py board body <board> [REF variant|lcsc|default]  # which body a ref wears
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
.venv/bin/python tools/revisions.py after <id> --model <new>  # ...on the model the work went into
.venv/bin/python tools/revisions.py usage [--full]       # what the work cost
.venv/bin/python tools/revisions.py files [get <id>|put <file>|mkdir|mv]  # the Files tab
.venv/bin/python tools/revisions.py pdf text|page <file-id|C...|file.pdf> ...  # read a PDF
.venv/bin/python tools/revisions.py component list|show|deps|pin|refresh ...  # components
.venv/bin/python tools/revisions.py fw files|get|put|pins|build|diff <fw> ...   # firmware
.venv/bin/python tools/render.py <id> [--camera=…|--only PART]
```

`build` ends with where its time went (`timing: load ..., tessellate ...,
step ...`) and which imported models came from the component cache and
which ran (`cache: kept ...; ran ...`).

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
neither room's log is half about the other. Start a run when you pick up a revision and finish it when you are
done; the bar stays live in between.

### Always finish by rendering from the user's angle

Every revision stores the camera it was drawn from. After rebuilding, take the
picture from that same angle and look at it before you call the work done:

```bash
python tools/render.py <revision_id>          # writes /tmp/after-<id>.png
```

`--width` and `--height` are the size of the picture, not of the browser
window: the window is grown until the canvas measures what was asked for.
The stored camera is applied for you. For a different side of the part than
the one drawn on, `--side front|back|left|right|top|bottom|iso` frames the
whole model (or the `--only` parts) from that side; `--camera=px,py,pz[,tx,ty,tz]`
is an exact camera in world millimetres (absolute - the model's middle is
rarely the origin; leave the target out to look at the middle of what is shown).

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

### Parts that move: MOTIONS

A model can make parts move in the viewer: a fan that spins, a hinge the
person sets by hand (a slider in the 3D room's "Motion" panel, the mouse
wheel over it), a cable that bends with the hinge. Declare it next to PARTS
(backend/motions.py has the whole format):

```python
MOTIONS = {
    "Tilt": {"part": ["Fan housing", "Fan rotor", "Fan frame"],   # tree paths or unique part names
             "range": (-18, 18), "default": TILT,                 # degrees; default = the pose PARTS is built in
             "axis": (1, 0, 0), "pivot": (0, 0, 41.5)},           # world frame, mm, at the default pose
    "Fan":  {"part": "Fan rotor", "spin": 1800, "on": "Tilt",     # rpm, turns all the time
             "axis": (0, -1, 0), "pivot": (0, 0, 41.5)},
    "Cable": {"part": "Fan cable (loop)", "follows": "Tilt", "radius": 1.0,
              "paths": {t: centre_line_at(t) for t in SWEEP}},    # world mm, same point count at every t
}
```

- A moving part has to be its own node in the tree: its own entry in PARTS
  (or a component's group). Split a solid that moves out of one that does
  not; never move half a part.
- `part` is a path as the tree shows it ("Fan Module 80/Fan rotor") or a
  part's own name when only one node has it, or a list of them; a node
  moves with what is under it. Rotation is right-handed about `axis`.
- Read axis and pivot from the model's own numbers (the hinge's `swing`,
  a placement), never retype them; give them at the default pose.
- A motion inside another rides on it (the rotor keeps spinning about its
  tilted axis); found from the tree or said with `"on"`.
- A cable that a range bends: `follows` that motion, with its centre line
  sampled over the range (`paths`, blended in between - best when the
  model already works the cable's shape out) or its two ends and length
  (`from`/`to` `{"at", "dir"}`, `length`; a curve of that length). At the
  default the model's own cable is shown, elsewhere a live tube.
- The build checks it (paths in the tree, finite numbers, range low <
  high, default inside it, sampled paths covering the range) and stops
  with what is wrong. An imported model's MOTIONS stay its own: the
  assembly declares the ones it shows.
- **A motion is visual only**: nothing checks that moving parts collide.
  Keep the model's own check over the range in code; the built pose stays
  the truth for printing and clearances.
- A note keeps the hand-set values (Tilt = 30) and the after shot puts
  them back (render.py checks the page read them back); spins are not
  kept, and shots are taken with them stopped at their rest pose.

## Components: reuse is importing, never copying

Every `.3d` model and every `.pcb` board is a **component**. A design that
needs one imports it; it never copies its geometry, and never retypes a
number the component already names. Change the component and every design
that uses it is rebuilt by the server, in order (backend/links.py).

```python
import os
os.environ["REDLINE_IMPORT_ONLY"] = "1"      # imported parts skip their own exports
import stand as D                             # a 3D model: by its bare name
import iot_fan__parts__lid as L               # ...or by its whole id (/ as __, - as _)
import demoboard_gerber_zip as B              # a board: its id with - and / as _

base = B.part                                 # the board with its parts (STEP)
for h in B.HOLES:                             # Hole(x, y, d, plated, ref)
    ...                                       # a standoff at h.x, h.y, not at 3.2, 4.0
lid_z = B.THICKNESS + B.KEEPOUT["top"] + 1.0  # not 1.6 + 15.1 + 1.0
```

- A bare model name resolves by the importer's top folder (its project):
  the one model of that name in the importer's project, else the one in
  the whole workspace, else the build stops and names the candidates. So
  `iot-fan-80mm` can have its own `lid` next to iot-fan's; its station
  still gets iot-fan's unique `oled_091` by `import oled_091`, and a part
  of iot-fan imported there keeps getting iot-fan's `lid` (per importing
  module, not per build). The whole-id name always means that one model.
  `component show <model>` lists AMBIGUOUS imports.
- A board's module is generated from its last layout: `part` (STEP, read on
  first use), `simple` (slab + one box per part, fast), `SIZE`, `THICKNESS`,
  `OUTLINE`, `CUTOUTS`, `HOLES`, `DRILLS`, `CONNECTORS` / `EDGE_PARTS`
  (`edge`, `along`, `overhang`, `height`, `box`), `BODIES`, `KEEPOUT`,
  `HEIGHT_MAP`, `keepout(clearance)`. Frame: mm, origin at the outline's
  lower-left corner, +Z out of the top, board bottom at z = 0.
  `GET /api/boards/<id>/module.py` shows it; `pcb_<name>` is the same module
  when a model already has the plain name.
- A board with no 3D yet gets one from its next layout or run, or at once
  from `POST /api/boards/<id>/component` (no re-routing).
- Do not make a second "3D model of the board". The `.pcb` is the component.
- Never paste a part's geometry into another model to tweak it. If a variant
  is needed, give the part a parameter and import it.
- `GET /api/models/<id>/links` lists what a model uses, who uses it, the
  rebuild a change set off and **copied numbers** - literals in the source
  that a component it imports already names. Clear those before finishing.
- Deleting a component something imports is refused (409) for models and
  boards alike; `force=true` is the person's call, not yours.
- A dependent can pin a component version (`POST /api/models/<id>/pins
  {"component": "board:<id>", "version": 3}`, `null` to follow again).
  Pinning or following again rebuilds the model and what uses it. The
  person does the same from the Links card's version menu.

### Component commands

Through the API with the agents' token (`REDLINE_API`, `REDLINE_TOKEN`,
`REDLINE_AGENT`), like `board ...`; the MCP server has each as a tool
(`component_list`, `component_show`, `component_deps`, `component_pin`,
`component_refresh`).

```bash
.venv/bin/python tools/revisions.py component list                  # every model and board: version, uses, used by, pins, state
.venv/bin/python tools/revisions.py component show <id>             # a board's named data; uses / used by; pins; versions; last error
.venv/bin/python tools/revisions.py component deps <id> [--tree]    # what it uses, what uses it (--tree: all the way, both ways)
.venv/bin/python tools/revisions.py component pin <model> <component> 3       # use v3 of it
.venv/bin/python tools/revisions.py component pin <model> <component> latest  # follow it again
.venv/bin/python tools/revisions.py component refresh <board>       # its 3D component from its layout, now
```

An id that is both a model and a board is written `model:<id>` or
`board:<id>`. `pin` takes only a kept version (`show` lists them with
what each changed) and is refused for a component the model does not
use. `refresh` is refused while a job runs on the board - its layout makes
the component anyway - and exports from the layout as it is, without
placing or routing. An imported board (no layout here) gets its component
from the import: the Gerbers' outline and drills, the parts' placement,
and the STEP it was uploaded with moved into the board's frame (without
that STEP, the bare board with a box per part).

A board's 3D is a new version only when it changed (placement, models,
named data). The person can switch a board to "every run is a new
version" on its 3D card; don't change that setting yourself.

### A body for an LCSC part (asked by the PCB room)

A note from `part body-request` asks for a part's 3D body. Draw it as a
model at the id the note names (`components/<C>-<name>`) in the
**component frame** - mm, origin at the footprint's origin, +Z up from the
board's top surface (z = 0 on it, leads below), +X the footprint's X, +Y
the footprint's **-Y** (`backend/modelseat.py`, *The component frame*; the
note's pads are already in it). It is used as-is: no offset, no rotate.
Build it, then bind it - not as the default unless the note says so:

```bash
.venv/bin/python tools/revisions.py part bodies C111607 --spec          # the footprint, as JSON
.venv/bin/python tools/revisions.py build components/C111607-lying-flat
.venv/bin/python tools/revisions.py part body-bind C111607 components/C111607-lying-flat --name "lying flat" [--default]
.venv/bin/python tools/revisions.py part body-unbind C111607 lying-flat  # refused while a board chooses it
```

Its STEP is the build's: every later build with a different STEP redraws
the boards that wear it, and what imports those boards, on its own.

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
| Build | temporary directory, removed when finished |

See `.claude/skills/asset-revisions/SKILL.md` for details.

**A STEP from the Files tab goes into the project as a model of its own.**
`revisions.py files to-model <file-id> --folder iot-fan/purchased [--title "OLED 0.91 inch"]`
(or the Files tab's "Add to project") copies the bytes into the model's own
CAD files and builds it - the model stays whole if the file is later deleted
from Files. Use that model like any other component (`import oled_0_91_128x32`).