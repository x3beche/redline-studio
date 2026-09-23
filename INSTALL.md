# Installing

[← back to the README](README.md) · [Usage](USAGE.md)

Requirements: **Python ≥ 3.10**, **Node ≥ 20.19**, and a MongoDB connection —
Atlas or a local server, either works.

```bash
git clone https://github.com/x3beche/x3-studios-asset-manager.git
cd x3-studios-asset-manager
cp .env.example .env          # fill in MONGODB_URI
./start.sh
```

On first run `start.sh` creates the virtual environment, installs the npm
dependencies and starts both servers with live reload:

- UI <http://127.0.0.1:4200>
- API <http://127.0.0.1:8000>

For a single-server production build, `./start.sh --build` compiles the UI and
serves it from `:8000` alone.

## Configuration

Everything is read from `.env`, which is git-ignored. The connection string and
the API key are read by the **backend only** and never reach the browser.

| Variable | Default | What it does |
|---|---|---|
| `MONGODB_URI` | — | required; the database is the source of truth |
| `MONGODB_DB` | `assets_3d` | database name |
| `OPENROUTER_API_KEY` | — | card summaries and the English translation; without it a card simply has neither |
| `X3_BUILD_MEM` | `6G` | memory ceiling a build may use before the kernel kills it |
| `X3_CACHE` | `.cache/artifacts` | where generated artifacts are kept on disk |
| `X3_WATTS_PER_CORE` | `8.0` | assumed power of one busy core, for the energy figure on a revision card |
| `X3_WATTS_GPU` | the card's rated limit | assumed power of the GPU while it is busy; nvidia-smi reports no live draw on many cards |
| `X3_KWH_PRICE` | — | electricity price in USD/kWh; unset means the card shows energy and no money |
| `X3_TRANSCRIPTS` | `-mnt-ssd-3d-arena*` | which agent transcript folders the token analytics read |

## The board room

Two things it needs, and neither goes on the machine.

**atopile**, in its own virtualenv. It brings pydantic, numpy and a KiCad
stack of its own, and this project's environment has build123d in it:

```bash
python3 -m venv .venv-ato && .venv-ato/bin/pip install atopile easyeda2kicad
```

`X3_ATO` and `X3_EASYEDA` point at the two binaries if they live somewhere
else. Note that pip will give you atopile 0.2 on Python 3.12: 0.15 needs
3.14, and its part picking wants an atopile account, so 0.2 is what this
uses.

**KiCad**, in a container, because it is a gigabyte of libraries and the
point is not to install it:

```bash
docker build -f docker/kicad.Dockerfile -t redline-kicad .
```

`X3_KICAD_IMAGE` names another image. Without it the room still builds and
shows the circuit; it just cannot place or draw the board, and says so.

Footprints and 3D models come from LCSC by part number, through EasyEDA's
public API, and are kept in the `parts` collection so a board that is
rebuilt ten times asks once.

## Themes

`?theme=light`, `?theme=oled` or `?theme=default` in the URL, or set
`x3.theme` in the browser's local storage. A theme is a complete set of
tokens in `frontend/src/styles.css`; adding one means copying the default
block and changing the values, and the tests will say if anything is
missing.

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
X3_BUILD_MEM=12G tools/capped.sh ...      # raise it for one run
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
