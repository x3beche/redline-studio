# Using it

[← back to the README](README.md) · [Install](INSTALL.md)

## The rooms

Along the top: **3D Drawing**, **PCB Design**, **Web Programming**,
**Embedded Programming**, **Mobile Programming** and **Analyze**. All but
Analyze are built, and every built room has the same layout - the 3D
room's: a toolbar across the top with the pen at its end, tabs down the
left, the view, and the room's own log under it. Analyze opens on what it
needs before it can exist. `?ws=pcb` in the URL opens a room, and the
browser remembers the last one you were in.

The left column belongs to no room. One tree holds everything: a model is
a `.3d`, a board is a `.pcb`, a program a `.web`, `.fw` or `.mobile`, and
clicking any of them opens the room that can show it.

The 3D room stays loaded whichever tab is showing — its viewer holds a
WebGL context and tens of megabytes of geometry, and throwing that away to
look at another tab would mean waiting for it again on the way back.

## The everyday loop

1. Create a model with **+ Model** in the left column. A skeleton is generated.
2. Write it, then build with **↻**. build123d runs on the server and the result
   goes into the database.
3. Click the model to open it in the viewer, or open one directly with
   `?model=<name>`. **Double-click a part** and the form on the right fills
   itself in.
4. **Freeze and draw** → mark it up → write the comment and save. Seven tools:
   freehand, line, arrow, rectangle, ellipse, triangle and text. Text is typed
   where you click rather than in a dialog, so you can see what you are
   labelling. Saving releases the freeze.
5. Press **queue** when it is ready.

A comment about a part is a revision on its own — freezing and drawing is
optional. When a run finishes, a notice appears in the top-right corner and the
camera swings to the angle the revision was drawn from; the notice stays until
it is dismissed.

The viewer's **Clip** tab cuts the model on three planes, which is how the
inside gets inspected without exporting anything.

The log along the bottom is a record and reads as one: it can be folded
away, and that is all. There is no clearing it from the page.

What you fold away stays folded. The log, the thread under the queue, the
two side columns and every folder in the catalog come back the way you
left them — the window remembers its own shape in `x3.panels`, per
browser, and nothing about it reaches the database.

A single button on the card cycles the status: draft → queued → applied →
draft, so "applied" can be undone. **edit** changes the comment and the part;
the drawing itself is the record and stays as it was.

Clicking a card's thumbnail opens the drawing full size, with the comment,
part, model and status underneath:

![a revision opened from its card](docs/revision-modal.png)

### Before and after

A card keeps two pictures. The **before** is what you drew on. The **after** is
taken when the work is finished, from the same camera and with the same parts
shown or hidden, so the two line up and a mistake is obvious. Toggle between
them on the card.

### Auto english

A switch on the comment form turns a note written in any language into an
English revision request as it is saved. The original is kept; the translation
is what the queue shows.

## Model contract

A module must define the following to appear in the catalog:

```python
TITLE = "Fan 120 mm"                    # optional, shown in the UI
PARTS = [frame, rotor, pins]            # build123d objects to tessellate
NAMES = ["housing", "impeller", "pins"] # optional, names in the tree
```

Models are parametric: when a dimension is requested, change the constant
rather than rewriting the geometry.

### Measure, then assert

The habit that keeps this codebase honest is to probe the geometry, fix what
the probe found, and then leave the probe behind as a check that raises:

```python
hit = plug.intersect(shroud)
if hit and hit.volume > 0.05:
    raise ValueError(f"the plug is buried {hit.volume:.2f} mm^3 in the shroud")
```

Builds print their own measurements, so a regression shows up as a number
changing rather than as a picture looking slightly wrong.

## Assemblies

Every model's source is written into the build directory, not just the one
being built, so a module can import the parts it is made of:

```python
import os
os.environ["X3_IMPORT_ONLY"] = "1"      # parts must not run their own exports
import fan_pro as F
import stand as D

PARTS = place(F.PARTS, ...) + place(D.PARTS, ...)
```

Guard exports and the `show()` call in each part with `if STANDALONE:`
(`STANDALONE = os.environ.get("X3_IMPORT_ONLY") != "1"`), or importing one will
drop its STEP and STL into the assembly's output.

Share the numbers rather than copying them. When the station tilts the fan
module, the tilt lives in one file and the other reads it:

```python
TILT = B.TILT        # not a second 18.0 that can drift from the first
```

Two copies of a number is how the plug ended up modelled 19 mm away from the
socket it plugs into.

An assembly imports the parts it is made of, so deleting one of those parts
breaks its build the next time it runs, with a traceback and no clue why. The
server checks who imports a model before removing it and refuses:

```
base is imported by station; deleting it breaks their build.
```

The UI offers the override rather than hiding it.

## PCB Design

A board is a `.pcb` in the same tree as the models. Its source is
[atopile](https://github.com/atopile/atopile): a circuit written as text,
where a part is a line and a connection is `~`, so an agent can change it
the way it changes a model.

```ato
component R1206:
    footprint = "R1206"
    mpn = "C368196"          # the LCSC number: what gets bought, and drawn
    signal p1 ~ pin 1
    signal p2 ~ pin 2

module PowerIn:
    signal vin
    signal vrail

    r_series = new R1206
    d1 = new Diode_SOD123

    vin ~ r_series.p1
    r_series.p2 ~ d1.anode
    d1.cathode ~ vrail
```

There are no buttons that make anything. A change to a board is asked
for - a board note, or the thread under the queue - and the agent runs
the whole pipeline, in order, every time:

1. **build** - atopile turns the source into a netlist;
2. **schematic** - KiCad draws it: every part with its real symbol, grouped
   by module, each pin joined to its net by a labelled stub, then ERC;
3. **place** - each module's parts as a block, small parts beside the chip
   they serve, connectors on the board's edge facing out;
4. **route** - Freerouting, to the board's rules, then a ground pour on
   both layers;
5. **check** - KiCad's DRC over the routed board.

About a minute for a 33-part board. The room shows what came of it.

| place | what it holds |
|---|---|
| **toolbar** | across the top, the 3D room's icon buttons: *layout*, *schematic*, *3D*; the board's *front* (with the pour), *tracks* (copper only) or *back*; fit, closer, further; the `.kicad_pcb`, `.kicad_sch` and `.glb` files; what the last run came to (routed, DRC, ERC). The **pen** is at its far end |
| **tabs** | down the left, like the 3D room's Tree/Clip/…: **Parts** (LCSC's catalogue, the part you clicked in full, the drawer), **Rules**, **Checks** (DRC and ERC), **Sourcing** (every request made of LCSC) |
| **view** | the board as the toolbar picked it; on the layout the corner selector switches side, as *All* does in the 3D room. Scroll to zoom, drag to move, double-click to fit; drag to turn the 3D one over |
| **log** | a card under the view, as in the 3D room: folded to one line, or open to the last lines - only this room's lines - with what each run took and what the board's files weigh in a narrow column on its right |

It is the 3D room's layout, and every room shares it (`rooms/frame.ts`):
one toolbar, one column of tabs, one view, one log band. The room remembers
the tab, the view and whether the log is open across a reload.

**Windows.** The fourth view button (three rectangles) opens the centre as
windows: a tall one on the left and two stacked on the right. The picker
in each window's corner sets what it shows - Layout, Schematic or 3D, the
same one twice if you like - and the room remembers the choice. Each window
zooms on its own (+, −, fit); the toolbar's side buttons (front, tracks,
back) apply to any window showing the layout; the pen draws over all
three at once.

**Looking into the copper.** On the layout (front, tracks or back) point at
anything: the track, via or pad under the mouse lights up with the rest of
its net, and a note by the cursor says what it is - a track's net, width,
length and layer; a pad's part, number, net, size and shape; a via's size
and drill. Click to hold a net: the rest of the board dims and the corner
says how many tracks, how many mm and how many pads it has. Click empty board
or press Esc to let it go. Dragging still moves the board. This works from
the routed board's own geometry, which every run stores.

**Drawing on a board.** Press the pen: the view is held as a picture -
exactly what is on screen, at that zoom or angle - and the 3D room's tools
dock in the toolbar (freehand, line, arrow, rectangle, ellipse, triangle,
text; four inks; width; undo, clear). **Save as draft** in the column on
the right files the board note with that picture. Press the pen again to
let the view go.

### Rules

The **Rules** tab is a form of what the router is told. It starts worked
out from the net names — `vbus`, `gnd`, `v3v3` are power and get 0.5 mm
tracks, `dp`/`dn` are a pair, `gnd` is poured — and everything in it can be
changed, added or removed:

- **Net classes**: name, track, gap, via and drill; which nets are in it, by
  name or by a pattern such as `usb_*` that catches them on any board.
  *holds:* under a class lists what it catches. Default holds every net no
  other class takes, and cannot be removed.
- **Differential pairs**: pick the + and − nets, width and gap. Freerouting
  routes a pair as two nets at these numbers; it does not couple them or
  match their lengths. Fine for USB full speed; not for anything fast.
- **Copper pours**: any net, on either or both layers, *solid* (pads straight
  into the pour, what reflow wants) or *thermal* (spokes, easier to
  hand-solder). The first in the list wins where two meet.
- **What the board house can make**: the minimums every class is checked
  against, and **Router** passes.

**+ add** makes a row, **×** removes one; ⓘ and each field's tooltip say
what it is. The server checks the form as you type (the same check the
agent's edits go through) and puts each problem under the row it is about;
**Save** keeps it, and the next run routes to it. The field list comes from
the server (`/api/rules/schema`), so the form and the agent's
`revisions.py board rules` always describe the same rules.

Freerouting cannot narrow a track to reach a small pad, and nothing narrows
it for you. After a run the room knows each net's narrowest pad, so a class
too wide for one of its pads is a problem in the form - *Power.track: 0.5 mm
will not reach U24 pad 5 on v3v3 (0.364 mm wide)* - and a run with it stops
with the same words. Lower the class's track, or move that net into a
narrower class. **Copper pours** also take *From edge*: how far inside the
outline the pour stops.

### Checks

DRC and ERC, itemised: errors first, then warnings, then two kinds kept
apart because they are not about the design — findings wholly inside one
part's footprint (a connector's pegs next to its own pads: the maker's
land pattern), and ERC's notes about the generated project having no
library tables.

### Analytics

The board at a glance, compact enough to sit above the agent's card while
it works: parts and nets, size and density, tracks and what is still
unrouted, DRC and ERC, copper and area, and the bill - priced from
LCSC's answers already on disk, `$0.77 · 10/23` meaning ten of
twenty-three part numbers had a price, JLCPCB Basic against Extended -
then the parts by circuit block and the nets by how many pins they join.
Nothing in it asks LCSC anything.

When the agent starts on the board the room turns to this tab, once per
task - also when the page is opened while one runs. Any other tab picked
after that stays picked.

### Parts

Type a part number or what you are after — `C25744`, or `0603 100nF` —
and the **parts** pane searches LCSC: the number to order, what it is, the
package, who makes it, how many they have and what one costs. Searching
downloads nothing.

Click a result — or anything in the drawer — and the column becomes that
part: its photo, what it is, the package, price, stock, and whether
JLCPCB counts it **Basic** (no loading fee) or **Extended** (a feeder fee
per assembly run), which settles a choice between two equal parts more
often than the price does. Under that, its 3D shape to turn over, its
footprint and its schematic symbol, all straight from EasyEDA on the
click and kept on the server's disk, so a second look is instant.
**← list** goes back.

The shape arrives as EasyEDA keeps it, an OBJ with its colours written
inline. The server turns that into a GLB once — 0.15 s for an LQFP-48,
and 1.2 MB instead of 3.8 — because parsed in the page it held the whole
window still for seconds.

**+** fetches one and keeps it: the footprint, and the 3D model if there
is one. That is what puts it within reach of a board — *lay out* draws
each part from what is in the drawer, so a part with no model is a part
that will not be standing on the board when you turn it over. The drawer
marks which is which, **3d** or **2d**.

Fetched once and kept: a part number means the same thing tomorrow as it
does today, and a board rebuilt ten times should not ask somebody else's
service ten times. The models are big — an LQFP-48 is a 9.8 MB STEP file —
so they are gzipped into GridFS like every other generated thing, with a
copy on disk. Expect a few seconds of waiting for a large one.

The **Part** field in the right-hand column follows the room: in the board
room it offers the board's own components, `U1 · C368196`, so a note can
be about one of them.

### Watching what is asked of LCSC

The board room's left column has a **Sourcing** tab:
every request made of LCSC, by the page or by an agent, newest first —
what was asked (a search, a part's details, its drawings, its model, its
photo), whether it went to EasyEDA or was answered from disk, the status,
how long it took and how big the answer was. Click a row for the full URL
and any error; **⤢** makes the pane tall enough to read.

It is there because these are EasyEDA's own endpoints, not a promised
API, and they turn a burst away for ten minutes at a time. The line at
the top says how far apart asks are kept (2.5 s, across every process),
and when EasyEDA has said no, why and for how long. Nothing is sent while
that lasts; parts already looked at still work from disk.

### Board notes

**Save as draft** in the board room files a note on the open board, not a
revision of a model: no camera and no drawing, just the note and the part
it is about. The list under it is **Board notes**, and the 3D room's
revisions are not in it — nor are board notes in the 3D room's list. The
agent sees them in the same queue, marked `[BOARD]`.

![The board room: parts, layout, circuit, model, machine and log](docs/pcb-room.png)

There was a switch between the drawing, the circuit and the model, and it
was wrong: they are not three ways of looking at one picture, they are
different questions about the same board, and answering one usually means
looking at another.

The catalog is on one side and the queue on the other, as they are in the
3D room — the room takes the centre column and nothing else.

The ring is deliberate. A netlist has no positions in it, and inventing
some with a physics run gives a different picture every time the page is
opened; a ring is the same picture for the same circuit.

There is no **+ Board** in the left column yet and no editor for the
source in the room: a board is written through `PUT /api/boards/{id}`,
which is how the agent writes one. The room reads, builds and draws it.

A part without an LCSC number still appears in the netlist and in the
circuit, and is not on the board: there is no shape to place. It is named
under the drawing — *no footprint for U3* — rather than quietly left out,
and a part number that does not exist says so the same way.

## Web, Embedded and Mobile Programming

Redlining a running program. A project is a git checkout: where it is
served, how it is built, and the command whose exit code says it still
works. The example projects are **iot-fan**'s - the dashboard, the phone
app and the controller firmware for the fan in the 3D room, in
`/mnt/ssd/3d-arena/projects/iot-fan`.

Nothing runs on the machine itself. Each room has its own Docker image
(see [INSTALL](INSTALL.md)): a page is served and photographed in
`redline-code-web`, firmware is built and flashed in
`redline-code-embedded`, and the phone is an emulator in
`redline-code-mobile`. Nor is there a button that runs anything: the
person marks, and the agent starts servers, builds, tests and flashes.

### Web Programming

![The Web room: the iot-fan dashboard, live, and its tests](docs/web-room.png)

The page runs in the view, in a frame at a chosen size - desktop, tablet
or phone, from the toolbar - scaled into a dark surround so it reads as it
renders. **The pen** takes a real screenshot of the route in the web
container's Chrome, about three seconds, and puts the same seven drawing
tools over it. Every mark is laid on the page's elements as it is drawn:
a ring means the outermost element mostly inside it, an arrow the
smallest element under its head. What it landed on is outlined over the
picture and offered in the Part field with its file -
`#duty "0" · public/index.html`, or `button.tcv-btn "build" ·
rooms/pcb.ts` for an Angular component. **Save as draft** files the note
with the picture and that list.

### Embedded Programming

![The Embedded room: the STM32 firmware as built, a function picked](docs/embedded-room.png)

Firmware has no screen to draw on, so there is no pen here. The view is
the firmware as built: memory per region - with how much it grew since
the build before - and the largest functions and tables, file by file.
Click one and it becomes the note's Part, `fan_command ·
firmware/common/fan.c:66`, the way the board room offers its components.
STM32 and ESP32 both: the ARM or Xtensa toolchain is chosen from the
image itself. The **Boards** tab lists an ST-Link or an ESP32 serial port
when one is plugged in, and the agent programs it (`code flash`).

### Mobile Programming

![The Mobile room: the iot-fan app on the emulated phone](docs/mobile-room.png)

The view is the phone - an emulated Pixel 7 on KVM, its screen refreshed
every second and a half, the project put on it when its room opens. The
pen freezes the phone's own screen; a page's elements come from the
phone's Chrome and a native app's from its view tree, both in the
screen's pixels, so a ring round the **+** button is `#up "+" ·
mobile/public/index.html:26`.

### The diff, the check

The toolbar's second button turns the view into the **diff**: the working
tree against HEAD, or one note's own change - only the files that moved
since it was drawn, so somebody else's uncommitted work in the same
checkout stays out of it - with the note's before and after over it. The
**Check** tab shows the last test run; a pass says so when the tree has
changed since, rather than showing a green from an older one. A note is
not done until the check passes and the after shot is taken, and the
agent's `code done` will not mark it applied otherwise.

A project is registered through the API:

```bash
curl -X PUT localhost:8000/api/apps/iot-fan-web -H 'content-type: application/json' -d '{
  "title": "iot-fan dashboard", "platform": "web", "folder": "iot-fan",
  "repo": "/mnt/ssd/3d-arena/projects/iot-fan", "cwd": "web",
  "url": "http://127.0.0.1:5173", "dev": "node server.js", "test": "node --test"}'
```

Firmware adds `target` (`stm32` or `esp32`), `build` - with `$BUILD` for
Redline's own output directory, never the project's tree - and `flash`
(`$ELF`, `$BUILD`, `$PORT`). A phone app served on the web gives the url
as the phone sees the host, `http://10.0.2.2:5174`.

## The left column

Hovering a row shows what can be done with it: a model has **→** (move), **↻**
(rebuild) and **×** (delete); a board has **→** and **×**, since it builds in
its own room; a folder has **+M**, **+K** and **×**.

Clicking a file opens the room that can show it — a `.pcb` goes to PCB
Design, a `.3d` to 3D Drawing — and the lit row is whatever the room on
screen is showing. Both can be loaded at once; only one of them is what
you are looking at.

Deleting takes two clicks — the first arms the row, the second does it. No
dialog: a `confirm()` freezes the page and cannot be driven in a test.

Moving is two clicks rather than a drag — press **→** on the model, then click
the folder, or *to root* in the strip that appears. A folder deletes only when
it holds nothing; the server refuses otherwise and says so.

A model's id carries its folder, so moving one renames it and its revisions
follow. A board's does not: it keeps its id and its history — the netlist,
the layout, every job filed against it — and only the folder it is listed
under changes. Assemblies keep working: during a build every model is also written
under its bare name while that name is unambiguous, so `import stand` still
resolves after `stand` moves into `parts/`.

Folders fold. The caret on a folder closes it, and what is closed is
remembered — after F5 the tree comes back the way it was left, along with
the log and the thread under the queue.

The foot of the column carries the database usage and the machine's live CPU,
RAM and GPU. While a revision is being worked on, the running task sits here
too, with its cost updating every second.

## Bringing in a CAD file

**+ CAD** takes STEP, IGES, BREP, STL or 3MF. The file goes to GridFS and the
server writes a model that imports it, so it is in the viewer without a second
step:

```python
part = import_step(ROOT / "bracket.step")   # uploads land in the build root
PARTS = [part]
```

| Format | How it comes in |
|---|---|
| STEP / BREP | solids, exactly |
| IGES | surfaces — the generated module sews them and makes solids where the shells close |
| STL / 3MF | mesh; written back as STL, because a mesh saved as STEP is one face per triangle (a 660 kB 3MF became a 131 MB STEP) |

**Native CAD files cannot be read.** `.f3d`, `.sldprt`, `.ipt`, `.catpart` and
friends are each vendor's own database; no open reader exists. The upload says
so and names the export to use instead.

An imported solid **is not parametric**. It carries no feature history, so a
dimension cannot be dialled in — it can be cut, joined, filleted, measured and
placed in an assembly, and that is all. Colours survive the import.

## Card summaries

A card holds whatever the person typed while looking at the model, which is
usually long. Folded, it shows one sentence instead:

```
▸ 1  Fanın iki yüzündeki yuva derinliklerini yarıya indir        QUEUED
```

Nothing else — no drawing, no date, no buttons. Opened, the sentence sits above
the full text, marked **◆** when generated and **✎** when written by hand.

The sentence comes from an LLM that is given the text *and* the drawing,
because the text leans on the drawing: "this part", "this text" only mean
something next to the red marks. The call is made by the server; the key never
reaches the browser.

| | |
|---|---|
| Service | OpenRouter, `deepseek/deepseek-v4.1-flash` |
| Key | `OPENROUTER_API_KEY` in `.env` (gitignored) |
| Request | `max_tokens` 60, `temperature` 0.2, reasoning off, 15 s timeout, 2 retries with backoff |
| Image | long edge scaled to 512 px, sent as a JPEG data URL |
| Cost | ~0.00018 USD per card measured over 15 cards; warns above 0.005 |

The system prompt is byte-identical on every request so the provider can cache
the prefix. A reply is trimmed to one line and stripped of quotes and a
"Summary:" prefix; over 12 words it asks once more and then keeps whatever came
back rather than cutting a sentence in half.

Generated when a card is created and when its text changes. It runs off the
request, so a slow or failed call never holds up saving, and it never replaces
a sentence someone wrote by hand — clearing the field in **edit** hands the
card back to the generator.

```bash
.venv/bin/python tools/revisions.py summaries            # backfill
.venv/bin/python tools/revisions.py summaries --all      # redo every card
.venv/bin/python tools/revisions.py summaries --force    # replace hand-written
```

## Working with language models

Two files are aimed at models opening this repository:

- **[`AGENTS.md`](AGENTS.md)** — the summary to read first
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
photographed from the same viewpoint. `?rev=<id>` in the URL opens the model at
that camera too.

The tool talks to MongoDB directly, so it works with the server stopped. Only
**queued** revisions count as work; drafts stay invisible.

While working, a model reports progress to the screen — a bar at the top and a
log at the bottom:

```bash
.venv/bin/python tools/revisions.py start ID "what you are doing"
.venv/bin/python tools/revisions.py log "reading source" -p 20 -l work
.venv/bin/python tools/revisions.py finish
```

`finish` closes the run, takes the after picture from the revision's own camera
and freezes what the work cost onto the card.

## Talking to the agent

Under the queue there is a thread, for everything that is not a mark on a
model — moving models between folders, renaming one, why a build is taking
so long. Enter sends, shift+enter keeps typing.

The **urgent** switch changes when it is read, not what it does. An
ordinary line waits until the agent next looks up, which can be the far
side of a four-minute build; an urgent one is printed by every command the
agent runs, so it lands between one step and the next.

It stops nothing by itself. Whether the work under way is worth abandoning
is a judgement about the work, so the agent makes it — and it can end a
build early if that is the answer. Nothing in the application throws four
minutes of compute away on a switch.

A line you have sent says **waiting** until the agent picks it up, and while
it does there is an **undo** beside it: taking it back is refused once the
agent has read it, because by then the work may be half done and an answer
would be talking to a message that is no longer there.

On the agent's side it is two commands, and its idle wait returns on a
message just as it does on a queued revision — so it comes back on its own:

```bash
.venv/bin/python tools/revisions.py chat          # read, and pick it up
.venv/bin/python tools/revisions.py say "..."     # answer, on your screen
```

Nothing in the thread changes a model by itself. If you ask for something,
what you get back is the agent saying what it did.

## When the agent asks

An agent applying a revision sometimes reaches a fork that is not its to
choose: which print process the part is for, whether a shaft is bought or
printed. It stops and asks, and because it has stopped, the question stops the
screen: a card in the middle of it, in the pen's red, with whatever the
agent already worked out underneath.

It is written in Markdown and rendered as Markdown — a question worth
stopping for usually carries a measurement, two options and the reasoning
between them, and that reads as a list or a table or it does not read at
all. Headings, emphasis, code, lists, quotes, tables and links all work;
`tests/test_markdown.py` runs the renderer and checks them, and that
nothing in the text can become a tag.

**later** puts it back in the left-hand column as one line, so you can go
and look at the model before answering. The agent is waiting either way —
nothing is dismissed, only moved — and **answer** on that line brings it
back.

The offered answers are a convenience; the box below them always takes free
text, because the real answer is often "neither, and here is why" — and what
you type wins over what you clicked.

The tab title carries a dot and a count while anything is waiting, so a
background tab still shows it. **notify me** asks the browser for permission
to raise a notice, which it can only do from a click — after that each new
question raises one.

On the agent's side it is one blocking command, so the answer is simply its
output:

```bash
.venv/bin/python tools/revisions.py ask "**The 18650 does not fit** - 7 mm short.

| option | the product |
|---|---|
| taller | grows 7.1 mm |
| deeper | unchanged |" -o "taller" -o "deeper"
```

## Themes

Every colour in the window comes from a token in `styles.css`. A theme is a
complete set of those tokens, so switching one in cannot leave an element
unstyled — and `tests/test_theme.py` fails if a theme is missing a token, if
a colour is written anywhere outside the palette, or if a token nobody
defines is used.

```
?theme=light        bright rooms, and screenshots that will be printed
?theme=oled         true black, for a panel that switches its pixels off
?theme=default      what it has always looked like
```

The URL wins for a single look; `localStorage['x3.theme']` is what the
browser remembers. The viewer in the middle of the screen keeps its own
palette in `--tcv-*` variables, and those are bound to the same tokens, so
a new theme reaches the third-party chrome without touching it.

Two things deliberately stay out of the palette. **The drawing pens** are
pigment: a mark's colour is written into the revision and printed into the
picture, so it has to mean the same thing in every theme and on paper.
**The 3D backdrop** stays pale in every theme, because a CAD view is judged
against light — flipping it would change what the model looks like rather
than what the window looks like.

## What a revision cost

Two meters, kept apart.

**Tokens and money** come from the agent's own transcripts. Claude Code writes
one line per content block and every line of a request repeats the same usage
block, so a request is counted once — summing the lines would treble the bill.
The spend is split by model, by provider and by what the turn was doing:
design, a build, a progress note, the card's own summary.

Cache reads look absurd as a raw total — twenty-odd million for one revision —
until you see that every request re-reads the whole conversation from cache.
The card shows the context size per call instead.

**CPU, GPU, memory and energy** come from the kernel and the driver. A build is waited for, so its
`getrusage` delta is exact and covers the whole subtree, the memory-cap wrapper
included. A render is not waited for — the headless browser is terminated and
its renderers are reaped by nobody, which is why a 92-second render was once
filed as 0.11 core-seconds — so its process tree is polled while it works.

A render is drawn by the graphics card, so counting only its CPU left the
expensive half out — a 90-second render that reports 23 core-seconds also
spent 4.6 seconds of GPU, and at the rates below that is more energy than
the CPU used. `nvidia-smi pmon` prints one line per process per second with
the share of the card each had, and our own processes' share is summed the
same way core-seconds are. On a machine with no card the figure is absent
rather than zero: the render did not use no GPU, we just cannot say.

What the whole machine burned over the same window is read from `/proc/stat` at
both ends of the run. That figure includes the browser, the editor and the
desktop, so it is reported separately with our share as a percentage, never as
the revision's own.

Energy is the one estimate. Intel's RAPL counter has been root-only since the
Platypus fix and this machine's GPU reports no power, so there is nothing to
read; core-seconds times an assumed per-core wattage is the substitute, and the
figure carries "assumed" the way the token prices do. The GPU's rate is the
card's own rated limit, which is an upper bound on what it was pulling while
it was busy — an upper bound that says so beats a middle figure that was
invented. `X3_WATTS_PER_CORE`, `X3_WATTS_GPU` and `X3_KWH_PRICE` tune it. On a host where the counter *is* readable the same code
reports "measured" instead.

```bash
.venv/bin/python tools/revisions.py usage [--full]
```

## Keeping it quick

A viewer payload runs to tens of megabytes, and three things were making that
hurt:

| | |
|---|---|
| **Served as stored** | The payload is gzipped in GridFS and was being unpacked on the server for the browser to receive it uncompressed — 63 MB on the wire for a model that packs to under six. It now goes out with `Content-Encoding: gzip`. |
| **Cached on disk** | Generated artifacts never change, so they are kept under their GridFS id in `.cache/`. The build writes that copy too, so even the first read after a build is local. The database keeps the backup; the disk does the work. |
| **Stamped** | The payload is served `immutable`, so the URL carries the build time. Without it the browser keeps showing the build it cached however many times the model is rebuilt. |

```
station, 63.7 MB artifact
  before   63.7 MB on the wire, 100 s
  now       5.8 MB on the wire,  24 s first, 0.18 s after
```

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/catalog` | folder + model tree |
| `PUT /api/models/{id}` | write source code |
| `POST /api/models/{id}/build` | tessellate, store output in the database |
| `GET /api/models/{id}/viewer.json` | viewer payload |
| `GET /api/models/{id}/file/{step\|stl}` | generated file |
| `POST /api/models/{id}/move?folder=` | move between folders (the id carries the path) |
| `DELETE /api/models/{id}?force=` | delete; refused while another model imports it |
| `POST /api/uploads` · `GET /api/uploads` · `DELETE /api/uploads/{name}` | bring in a STEP/IGES/BREP/STL/3MF |
| `GET /api/queue` | **queued revisions only** |
| `GET /api/revisions/{id}/image?which=before\|after` | the two pictures |
| `PUT /api/revisions/{id}` | edit the comment and part (the drawing is immutable) |
| `POST /api/revisions/{id}/summary?force=` | regenerate the one-line summary |
| `POST /api/revisions/english` | translate every revision that has no English text |
| `DELETE /api/revisions/{id}` | delete a revision and its image |
| `GET /api/revisions/{id}/analytics[?live=true]` | what that revision cost, models and machine |
| `GET /api/chat` · `POST /api/chat` | the thread; say something |
| `DELETE /api/chat/{id}` | unsend, while it is still unread |
| `GET /api/questions` · `POST /api/questions` | what the agent is waiting on; ask something |
| `POST /api/questions/{id}/answer` · `DELETE /api/questions/{id}` | answer it; withdraw it |
| `POST /api/usage/ingest` · `GET /api/usage/prices` | re-read the transcripts; the rate card |
| `POST /api/versions` · `POST /api/versions/{id}/restore` | snapshot / roll back |
| `GET /api/stats` · `GET /api/system` | database usage, CPU/RAM/GPU |
| `POST /api/activity` · `GET /api/activity` | the log shown at the bottom |
| `POST /api/run/start` · `POST /api/run/finish` · `GET /api/run` | the progress bar at the top |

## Traps already hit here

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
- `is_valid` accepts a shape made of **detached solids**. A lid that had shed
  two 0.95 mm³ flakes still passed; count the solids as well.
- A half-space prism built from two points **stops where the points stop**.
  Cutting "everything above this line" with a prism spanning only the line's own
  extent leaves material standing where the line ends — in this case a 0.2 mm
  thin wall, 4 mm tall, running the width of the case. Extend the line past both
  ends.
- A plane built for a sloped face must have its **origin on that face**.
  Offsetting by the wall thickness from a plane that merely runs parallel puts
  the part slightly inside the wall, and the interference is small enough to
  look like a rounding error.
- Waiting for a `canvas` element is not waiting for the model: the canvas exists
  within a second while a 50 MB payload takes most of a minute. Every screenshot
  taken that way came out empty.
- `getComputedStyle(el).width` returns the **used** width, not the declared one,
  so a layout fix that "did not apply" may have applied and been overridden.
- Zero clash volume between two parts proves nothing on its own. A part that is
  nowhere near the other also has zero. Probe for the material that *should* be
  there as well.

## Tools

**Tools** at the right end of the top bar: hover it and the tools drop
down. A tool opens in a window over whatever room is on screen, in the
app's colours; **×** or Esc closes it, and it remembers its own work for next
time.

- **Grid Sketch** - draw a layout on a grid (drag to draw an area, drag it to
  move it, rename it in the list) and copy it as a prompt, CSS, grid areas,
  Tailwind, ASCII or JSON. Useful for telling an agent how a screen should
  be laid out.

A tool is a self-contained page in `frontend/public/tools/` plus one line in
`frontend/src/app/tools.ts`.
