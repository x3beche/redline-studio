# Installing

[← back to the README](README.md) · [Usage](USAGE.md)

Requirements: **Python ≥ 3.10**, **Node ≥ 20.19**, and a MongoDB connection —
Atlas or a local server, either works.

```bash
git clone https://github.com/x3beche/redline-studio.git
cd redline-studio
cp .env.example .env          # fill in MONGODB_URI
./start.sh
```

On first run `start.sh` creates the virtual environment, installs the npm
dependencies and starts both servers with live reload:

- UI <http://127.0.0.1:4200>
- API <http://127.0.0.1:8000>

For a single-server production build, `./start.sh --build` compiles the UI and
serves it from `:8000` alone.

## On Windows

Run it inside WSL 2, not on Windows itself. On Windows 11, Smart App Control
blocks OpenCascade's unsigned DLL, and build123d fails on import with *"An
Application Control policy has blocked this file"*; `start.sh` and
`tools/capped.sh` are Linux scripts besides.

```powershell
wsl --install -d Ubuntu-24.04      # admin PowerShell, then restart - not shut down
```

Inside Ubuntu, Node 20.19+ has to come from NodeSource (apt's is older), and
the checkout belongs in the Linux home rather than under `/mnt/c`: npm and the
file watchers are many times slower across that boundary.

```bash
sudo apt install -y python3-venv python3-dev build-essential libgl1 libglib2.0-0 libxrender1
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
```

The UI is then at <http://127.0.0.1:4200> in a Windows browser as usual.
Anything already listening on `:8000` on the Windows side takes the port
first and the API cannot be reached; stop it before `start.sh`.

**Atlas refuses a new machine** with `TLSV1_ALERT_INTERNAL_ERROR` rather than
an authentication error. Add its public IP under Network Access. A home
connection's IP changes now and then; the same error means it has.

WSL stops its VM a while after the last terminal closes, and whatever runs
inside stops with it. To keep the servers up, put this in
`%UserProfile%\.wslconfig` and run `wsl --shutdown` once:

```ini
[general]
instanceIdleTimeout=-1

[wsl2]
vmIdleTimeout=-1
```

## In containers, still live

`compose.dev.yml` runs the same two servers as `start.sh`, with no Python or
Node on the machine. The checkout is mounted, not copied: an edit reloads
the API or the page at once, and packages are reinstalled only when
`requirements.txt` or `package-lock.json` changes. `--build` is needed only
when a file in `docker/dev/` does.

```bash
export DOCKER_GID=$(getent group docker | cut -d: -f3)   # the API starts KiCad and the rooms
docker compose -f compose.dev.yml up -d                 # UI :4200, API :8000
docker compose -f compose.dev.yml logs -f
docker compose -f compose.dev.yml down
```

`API_PORT=8010` in front moves the API, as with `start.sh`. The two are
interchangeable - run one or the other, not both. The first start installs
build123d into a volume and takes a few minutes.

## Configuration

Everything is read from `.env`, which is git-ignored. The connection string and
the API key are read by the **backend only** and never reach the browser.
Redline's own settings are all named `REDLINE_*`.

| Variable | Default | What it does |
|---|---|---|
| `MONGODB_URI` | — | required; the database is the source of truth |
| `MONGODB_DB` | `redline` | database name |
| `OPENROUTER_API_KEY` | — | card summaries and the English translation; without it a card simply has neither |
| `COMMANDCODE_API_KEY` | — | Command Code's models, for the Command Code room or any job. Both keys can instead be saved in **Preferences > LLM settings**, where each job also picks its provider and model |
| `REDLINE_BUILD_MEM` | `10G` | memory ceiling a build may use before the kernel kills it |
| `REDLINE_CACHE` | `.cache/artifacts` | where generated artifacts are kept on disk |
| `REDLINE_WATTS_PER_CORE` | `8.0` | assumed power of one busy core, for the energy figure on a revision card |
| `REDLINE_WATTS_GPU` | the card's rated limit | assumed power of the GPU while it is busy; nvidia-smi reports no live draw on many cards |
| `REDLINE_KWH_PRICE` | — | electricity price in USD/kWh; unset means the card shows energy and no money |
| `REDLINE_TRANSCRIPTS` | this checkout's path, in Claude Code's folder naming (`-home-you-redline-studio*`) | which agent transcript folders the token analytics read |
| `REDLINE_REQUIRE_SIGNIN` | `false` | `true` asks for a sign-in (old name `REDLINE_REQUIRE_SIGNIN` still works); see [docs/ACCOUNTS.md](docs/ACCOUNTS.md) |
| `REDLINE_TOKEN` | — | the agents' shared token when sign-in is on (made in the app, kept only here) |
| `REDLINE_WEB_HOST` | `127.0.0.1` | `0.0.0.0` opens the page (`./start.sh`) to the local network; the API stays on the machine |
| `REDLINE_BOX_CPUS` / `REDLINE_BOX_MEMORY` / `REDLINE_BOX_PIDS` | half the cores / 40 % of RAM up to 12g / 4096 | how much of the machine one build container may take |
| `REDLINE_DRAW_IMAGE` | `redline-draw` | the image technical drawings are made in |

## The board room

Two things it needs, and neither goes on the machine.

**atopile**, in its own virtualenv. It brings pydantic, numpy and a KiCad
stack of its own, and this project's environment has build123d in it:

```bash
python3 -m venv .venv-ato && .venv-ato/bin/pip install atopile easyeda2kicad kiutils
```

`REDLINE_ATO` and `REDLINE_EASYEDA` point at the two binaries if they live somewhere
else, `REDLINE_ATO_PYTHON` at the venv's Python. A `.venv-ato` made inside the API
container has a `bin/python` that only exists there; on the host the venv's packages
are then run by a Python of the same version instead (backend/atoenv.py), and when
nothing works the error names what was tried. Note that pip will give you atopile 0.2 on Python 3.12: 0.15 needs
3.14, and its part picking wants an atopile account, so 0.2 is what this
uses.

**KiCad**, in a container, because it is a gigabyte of libraries and the
point is not to install it. The image carries the footprint, 3D-model and
symbol libraries, a Java 25 runtime and Freerouting 2.4 - the autorouter,
which is built for Java 25 and will not start on 21:

```bash
docker build -f docker/kicad.Dockerfile -t redline-kicad .
```

`REDLINE_KICAD_IMAGE` names another image. Without it the room still builds and
shows the circuit; it just cannot place or draw the board, and says so.

Footprints and 3D models come from LCSC by part number, through EasyEDA's
public API, and are kept in the `parts` collection so a board that is
rebuilt ten times asks once. The board room searches the same catalogue,
so a part can be found by name as well as by number. The models go into
GridFS gzipped, not into the part document: a 9.8 MB STEP file written
inline took ninety-nine seconds.

## The Tools tab's checks

SQL in PostgreSQL, Prisma, TypeScript, OpenAPI,
Mermaid, regex engines, cron - run in one more image, offline. It is
optional: without it the tools work and just show no **Check**.

```bash
docker build -f docker/tools/tools.Dockerfile -t redline-tools docker/tools
```

| image | size | what is in it |
|---|---|---|
| `redline-tools` | 2.4 GB | PostgreSQL 16, Node 22 with TypeScript, zod, react-hook-form, Prisma 7, mermaid-cli, Python with the OpenAPI validator and croniter, PCRE2 |

## Releases and technical drawings

A release's KiCad outputs are made in `redline-kicad`; the technical
drawings in their own small image, which `./start.sh` builds the first
time (in the background) if it is missing:

```bash
docker build -t redline-draw -f docker/draw/Dockerfile docker/draw
```

| image | size | what is in it |
|---|---|---|
| `redline-draw` | 1.3 GB | Python 3.12, build123d (hidden-line projection), fpdf2 |

Without it a release still goes out, and says the drawings could not be
made. Release zips are kept in the database and, for speed, in
`.cache/releases`.

## Themes

Twenty-six, chosen under your name > **Preferences** (or ⚙, or Ctrl+K),
or `?theme=github-dark` and the like in the URL; the choice is kept in the
browser (`redline.theme`). A theme is a complete set of tokens in
`frontend/src/styles.css` and its name in `frontend/src/theme.ts` (light
ones also in `LIGHT_THEMES`, so boards are drawn with light inks); adding
one means copying a block and changing the values, and the tests will say
if anything is missing.

## Where the data lives

Nothing project-related is kept on disk. A temporary directory is created while
a model is built and removed as soon as the build finishes.

| Collection | Contents |
|---|---|
| `models` | model source code, title, sha256, generated-artifact references |
| `folders` | catalog folders |
| `revisions` | comment, camera, visible parts, status, queue timestamp |
| `model_versions` | version history (latest + 10), source text only |
| `runs` | one row per revision worked on, plus `current` |
| `activity` | the log shown at the bottom of the screen |
| `llm_calls`, `analytics` | what each revision cost in tokens and money |
| `compute_jobs` | one row per build or render: CPU, peak memory, disk |
| `boards` | board source (.ato), and its netlist, footprints, layout and 3D model |
| `parts` | footprints and 3D models fetched from LCSC, kept so the API is asked once |
| `questions` | what the agent asked and what was answered |
| `chat` | the thread between the person and the agent |
| `model_files` (GridFS) | generated viewer JSON / STEP / STL, gzipped |
| `shots` (GridFS) | revision images, before and after |
| `uploads` (GridFS) | imported STEP / IGES / BREP / STL / 3MF |

Version history deliberately stores **source code only**: viewer, STEP and STL
are derived artifacts and are rebuilt after a rollback. That keeps history in
kilobytes rather than megabytes.

## Builds run under a ceiling

A model that imports a large STEP and booleans against it can grow without
bound. Left alone it pushes the machine into swap and the desktop freezes,
and the process has to be killed by hand.

```bash
tools/capped.sh .venv/bin/python export_model.py thing
REDLINE_BUILD_MEM=12G tools/capped.sh ...      # raise it for one run
```

With a `systemd` user scope available it uses `MemoryMax` with swap disabled,
so hitting the ceiling is an instant kill rather than a swap storm; without
one it falls back to an address-space limit. The server runs every build this
way and reports a kill in words rather than a traceback.

## When it will not start

**WebGL is unavailable in Chrome.** The viewer will not start at all. Chrome
137+ removed the automatic software fallback. On hybrid Intel + NVIDIA
machines, `chrome://flags/#use-angle` → **OpenGL** fixes it; on the machine
this was developed on, the default ANGLE backend could not create a GPU
command buffer.

**The headless render tool** (`tools/render.py`) has the same requirement and
passes `--use-angle=gl` for exactly that reason. It also needs the dev server
running, because it drives a real browser against it.

**A model does not appear in the catalog.** It has to define `PARTS`; see the
model contract in [USAGE.md](USAGE.md).

**Nothing is queued but you expected something.** Only `queued` revisions
count as work — a draft is invisible to `GET /api/queue` on purpose.

## Tests

```bash
.venv/bin/python -m pytest tests -q
```

No network is used: the OpenRouter calls and the transcript reads are both
faked. They cover the token accounting, the machine accounting, the card
summaries and the queue rules.
