<div align="center">

# Redline

**One place to design hardware with agents: parametric 3D, circuit boards,
firmware, web and mobile.** Freeze a view, draw on it, leave a note - an
agent picks it up, changes the source, rebuilds, and shows you what changed.
All project data lives in MongoDB.

[Install](INSTALL.md) · [Usage](USAGE.md) · [Tools](TOOLS.md) · [Accounts](docs/ACCOUNTS.md) · [For language models](AGENTS.md)

</div>

![user interface](docs/screenshot.png)

## What it solves

Talking about a CAD revision is awkward. "Tilt the fan the other way" — which
way, by how much, and from which viewpoint? Words alone lose the thing you
were looking at.

This tool makes the conversation concrete. You orbit the model, freeze the
angle you want, mark it with a pen and type the note. What gets stored is the
note **together with** the marked-up image, the camera, the parts that were
visible and the model name.

### A worked example

Someone wanted the fan to lean the other way. They froze the view, drew a red
line along the tilt it had and a blue line along the tilt it should have, and
wrote one sentence:

> The fan should not be like the red line, it should be slanted like the blue
> line; update the connector etc. accordingly.

| What was drawn | What came back |
|---|---|
| ![the revision drawing: a red line and a blue line across the fan](docs/example-drawing.png) | ![the same model after the change, seen from the side](docs/example-after.png) |

The lines were measured off the image in pixels and projected back through the
stored camera: the red one matched the module's existing +18°, the blue one the
same angle mirrored. One constant changed:

```python
TILT = -18.0        # + : top toward the front, - : top toward the back
```

"Update the connector etc. accordingly" turned out to be the interesting half.
The plug was drawn where the socket sits on an **upright** fan, and the
assembly then tilted the fan without moving the plug — so at any tilt but
zero, the plug was hanging in mid-air. Now it rides the same rotation, and a
check in the assembly says so out loud:

```
fis <-> soket  : plug-shroud 0.00, plug-pins 0.00, plug-body 0.00 mm^3
               : cavity wall 14.3 mm^3  (must be > 0: the plug really is in the socket)
```

Zero clash on its own means nothing — a plug 18 mm away in open air also
clashes with nothing. The second line is the one that matters: a probe the
size of the socket cavity, grown slightly, has to *hit* the shroud around it.

## Five rooms, one loop

The loop under this is not about geometry. Source lives in a database as
text you can change a constant in; it is built into something you can look
at; you freeze a view, mark it and leave a note; an agent picks the note
up, edits the source, rebuilds, photographs it from the same angle and
checks it against a measurement. A board and a running interface fit that
as well as a solid does.

| | |
|---|---|
| **3D Drawing** | parametric solids in build123d - this is what is built |
| **PCB Design** | atopile for the circuit, LCSC for the parts, KiCad in a container for the board |
| **Embedded Programming** | STM32 and ESP32 firmware: what the build made of the source, the change as a diff, programmed by the agent |
| **Web Programming** | a page while it runs: draw on it, the change arrives as a diff, the tests are the check |
| **Mobile Programming** | an app on an emulated phone, redlined the way a page is |
| **Notes** | what you jot down while working - Enter keeps it, Alt+N from anywhere |
| **Tools** | 175 engineering calculators and sketch pads, most of them runnable by agents too |
| **Analytics** | what all of it cost and used: LLM money and tokens, the machine and its energy, builds, storage, per project |

The five design rooms share one layout - the 3D room's - so a board, a
page and a phone are looked at the same way.

![A board in the PCB room: atopile for the circuit, KiCad for the board](docs/pcb-room.png)

The board room takes a circuit written as text, fetches each part from
LCSC by its number — footprint and 3D model together — and has KiCad
place and draw it inside a container, so a gigabyte of libraries never
lands on the machine. Out come a layer render, a model and a BOM.

The programming rooms redline a program while it runs. The pen takes a
real screenshot - of a page in a container's Chrome, of an emulated
phone's screen - and a ring or an arrow is laid on the elements under
it: "this button, in public/index.html", not "these pixels". Firmware has
no screen, so its view is what the build made of the source, and a note
is about a function picked there. Each comes back as a diff, with the
test suite or the build as the check and the same screen afterwards as
the after.

![The Web room: the iot-fan dashboard running, and its tests](docs/web-room.png)

| | |
|---|---|
| ![The Embedded room: STM32 firmware as built](docs/embedded-room.png) | ![The Mobile room: the app on the phone](docs/mobile-room.png) |

## Who does the work

One main agent watches the queue and the thread, and hands each note to
an agent for its room - 3D, board, web, embedded, mobile - which applies
it, checks it and closes it. Rooms work in parallel, each with its own
run, its own log and, for the three programming rooms, its own Docker
image, so nothing a project needs is installed on the machine itself.
The queue is also an MCP server (`.mcp.json`), for any agent that
speaks it. [AGENTS.md](AGENTS.md) has the details.

## Everything in one box

**Ctrl+K**, anywhere: every model, board, app and tool by name, the room's
actions (show the code, release, technical drawing, build the board, a new
note, a theme), and, as you type, code lines (opened at that line), notes,
chats, revisions and parts.

![Ctrl+K: models, tools and code lines for "stand"](docs/palette.png)

## The code, as an IDE

The `</>` button beside the pen opens the source behind the view in VS
Code's editor (Monaco): the project's files on the left with the ones the
open file imports marked, a tab per file, Ctrl+click on an import to open
it, search, folding, the minimap. Editors can change it and save
(Ctrl+S); if an agent saved in between, nothing is written over - you are
asked.

![The station assembly in the code view: its project on the left, its imports marked](docs/code-view.png)

## What a note changed

When an agent works a note, every source in the project is kept as it was
before and after. The note's card then says `+12 −3`, and opens each
changed file side by side - and the picture it was drawn on against the one
taken after: side by side, with a slider, or with the changed pixels
painted in.

![A note's changes: the file before and after, side by side](docs/changes.png)

## Releases for manufacturing

One press packs a project as it stands into a zip kept under a tag
(`v1.0`, `v1.1`...), never overwritten, to download exactly as it was:
each board's **Gerbers and drill files**, **BOM and pick-and-place in
JLCPCB's columns**, a **BOM priced from LCSC** (price, stock, Basic or
Extended, the cost of a board), schematic and assembly PDFs, STEP and its
DRC/ERC; each model's **STEP, STL and a dimensioned technical drawing**;
and every source as it was. KiCad and the drawings run in their own
containers.

<img src="docs/technical-drawing.png" alt="A technical drawing made from a model: three views, an isometric, overall sizes, a title block" width="720">

## Notes that take no time

Type and press Enter: the first line is the title, `#tags` file it,
`@controller` points at a board, `- [ ]` lines are boxes to tick. **Alt+N**
opens a small box over any room and keeps the note with the room and the
model or board that was open. A note can be handed to a room's agent as a
message.

![The Notes room: search, tags, to-dos, a note with its boxes ticked](docs/notes.png)

## Themes, languages, shortcuts

Twenty-six themes over the whole window - the 3D backdrop and the code
editor included: Redline's own, Light, OLED black, GitHub, Atom One Dark,
One Dark Pro, VS Code, Dracula, Tokyo Night, Catppuccin, Nord, Monokai,
Gruvbox, Solarized, Material Palenight, Night Owl, Ayu, Rosé Pine,
Kanagawa, Synthwave '84 and High Contrast. On a light theme the boards are
drawn on white too. The interface speaks English or Türkçe; **?** shows
the keyboard shortcuts.

![Every theme on the same model](docs/themes.png)

## People, roles and workspaces

Local mode needs no sign-in. Switched on, it has accounts, invitation
links, five roles (owner, admin, editor, reviewer, viewer - a reviewer
draws and comments but does not queue, build or delete), separate
workspaces with the same names in each, and agent tokens so an agent
works through the API without the database password. Every delete and
change of state is in an audit trail. [docs/ACCOUNTS.md](docs/ACCOUNTS.md)
says how to run it and how to get back in.

## How it goes

1. **Write a model.** Python and [build123d](https://github.com/gumyr/build123d);
   parametric, so a dimension is a constant rather than a drawing.
2. **Build it.** OpenCascade runs on the server, the tessellated result goes
   into the database.
3. **Look at it.** The same viewer the OCP VS Code extension uses, in a browser
   tab.
4. **Freeze and draw.** Seven tools: freehand, line, arrow, rectangle, ellipse,
   triangle and text. Text lands where you click, so you can see what you are
   labelling.
5. **Queue it.** Until you press *queue* the note is a draft and `GET /api/queue`
   returns nothing — a teammate or a language model only ever sees what you
   have approved.

A note about a part is a revision on its own; the drawing is optional.

## What a revision cost

Every card carries its own bill, from two different meters that are never
added together:

<img src="docs/analytics.png" alt="the analytics panel on a revision card" width="300">

**The models.** Tokens, money at list price, calls, output per second and a
rate chart, split by model, by provider and by what the spend went on —
design, builds, the progress notes, the card's own one-line summary. The
figures come from the agent's own transcripts, counted once per request.

**The machine.** CPU, peak memory and energy for every build and render the
revision needed, measured by the kernel rather than guessed. What the whole
machine burned over the same window is reported separately, with our share of
it as a percentage — a build is not the only thing a computer does.

Energy is the one estimate, and it says so: Intel's RAPL counter is root-only
on modern kernels, so core-seconds times an assumed per-core wattage is the
honest substitute.

## Stack

| Layer | Technology |
|---|---|
| Model | Python 3.12 + [build123d](https://github.com/gumyr/build123d) (OpenCascade) |
| Tessellation | `ocp_vscode` / `ocp-viewer-core` |
| Viewer | [three-cad-viewer](https://github.com/bernhard-42/three-cad-viewer) 5.0.6 — the very viewer the VS Code extension uses |
| Frontend | Angular 20 + Tailwind CSS 4, themeable down to the last colour; Monaco for code |
| Service | FastAPI + Uvicorn |
| Data | MongoDB + GridFS |
| Boards | atopile, KiCad 9 and Freerouting in a container |
| Everything heavy | Docker: KiCad, the drawings, each coding room, the tools' checks - limited to a share of the machine |

Models can be built from other models, so an assembly is just a module that
imports its parts and positions them. The fit is then checked in code rather
than by eye — the assembly below reports its own pivot alignment, engagement
length and clash volumes on every build:

![a fan module on its base, tilted on the yoke](docs/assembly.png)

## Where to next

| | |
|---|---|
| **[INSTALL.md](INSTALL.md)** | requirements, `.env`, first run, the production build, what to do when WebGL will not start |
| **[USAGE.md](USAGE.md)** | day-to-day use, the model contract, assemblies, importing CAD, the API, and the traps this codebase has already fallen into |
| **[TOOLS.md](TOOLS.md)** | the Tools tab: what each calculator does, and how to add a tool |
| **[AGENTS.md](AGENTS.md)** | the short version, written for a language model opening this repository |
| **[docs/ACCOUNTS.md](docs/ACCOUNTS.md)** | sign-in, members and roles, agent tokens, a forgotten password, the office network |
| **[docs/USERS-PLAN.md](docs/USERS-PLAN.md)** | how the user system was built, phase by phase, and what was verified |

## License

MIT
