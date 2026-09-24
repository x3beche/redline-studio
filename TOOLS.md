# Tools

The **Tools** tab: small calculators and sketch pads that serve every room. It
sits on the top bar just left of Analytics. The tools are listed on the left;
the one you pick fills the room, and the tab comes back to it next time.

This file is the whole story of the tab. Read it only when a task is about a
tool - using one, fixing one or adding one. Nothing else in the repository
depends on it.

## The tools

The list is grouped: **Electronics**, **Design & UI**, and **Code, data &
prompts**.

| Tool | What it does | Mostly for |
|---|---|---|
| **Units & Numbers** | mm, mil, inch and µm; decimal, hex, binary and octal, with the two's complement at 8 to 64 bits; a UART's BRR and baud error for a clock (STM32 16× oversampling); the timer PSC/ARR pair nearest a frequency. | Embedded, PCB |
| **Trace Width** | How wide a track must be for a current on an outer and an inner layer (IPC-2221), with its resistance, voltage drop and loss over a length; what a given width carries; what a via carries. | PCB |
| **Resistor & LED** | Ohm's law from any two of V, I, R and P; an LED's series resistor rounded up to an E12/E24/E96 value, with the current and package it then needs; the standard divider pair nearest a Vout, with its current and source impedance. | PCB, Embedded |
| **Grid Sketch** | Draw a layout on a grid and copy it as a prompt, CSS, grid areas, Tailwind, ASCII or JSON. | Web, Mobile |
| **Screenshot Annotator** | Paste or drop a screenshot, draw numbered marks (change, remove, add, move, resize, question) with notes; get a fix list with pixel, percent and nine-region positions, a Markdown checklist, JSON, or the marked-up PNG. | Web, Mobile |
| **Palette Forge** | One colour into seven roles × eleven OKLCH tones, WCAG contrast on each, semantic light/dark tokens, colour-blind preview; out as a prompt, CSS, Tailwind or design-tokens JSON. | Web, Mobile |
| **Motion Lab** | Shape a cubic-bezier or spring (simulated), set duration, delay and stagger, preview on five motions; out as CSS (`linear()` for springs), Web Animations, Framer Motion or a prompt, each with a reduced-motion variant. | Web, Mobile |
| **Form Builder** | 17 field types, validation, match rules and conditions, a working preview; out as Zod, a TypeScript type, a react-hook-form component, JSON Schema or a prompt. | Web |
| **Schema Sketch** | Draw tables, columns and relations (1-1, 1-N, N-N with a junction table), with checks; out as PostgreSQL DDL, Prisma, Mermaid erDiagram, JSON or a prompt. | Web, Mobile |
| **Flow to Mermaid** | Draw a flowchart (six step types, labelled links, groups, undo); out as Mermaid, a step-by-step prompt or JSON, with a mermaid.live link. | any |
| **API Sketch** | Define endpoints, parameters, bodies and responses, with consistency checks; out as OpenAPI 3.1 YAML, curl, a typed TypeScript client or a prompt. | Web, Mobile |
| **Regex by Example** | Mark what should and should not match in a text; get an inferred pattern, tunable part by part, in JavaScript, Python and PCRE, explained, with code and a prompt. Also explains a hand-written regex and warns of catastrophic backtracking. | any |
| **Cron Studio** | Build or type a cron expression; read it in plain English, see the next ten runs in any time zone with DST notes; out as 5-field, Quartz, EventBridge, GitHub Actions, Kubernetes and node-cron. | Web, Embedded |
| **Data Digest** | Profile a CSV, TSV, JSON or JSONL file in the browser (streamed, nothing uploaded): types, nulls, ranges, anomalies; out as a compact prompt, Markdown, JSON or CREATE TABLE. | any |
| **Context Packer** | Pack instructions, code, files, logs and notes into one prompt with a token budget, trim and log-clean helpers, and five templates. | any |

The calculators read values the way an engineer writes them: `4k7`, `2M2`,
`100n`, `10m` (milli) and `3.3V` all work. `m` is milli and `M` is mega.

## Where it lives

```
frontend/src/app/tools/
  registry.ts        the list: one entry per tool
  room.ts, room.css  the tab: the list on the left, the tool on the right
  frame.ts           shows a tool that is a self-contained HTML page
  eng.ts             shared: engineering notation, E12/E24/E96, nearest standard value
  calc.css           shared: the calculators' look (sections, fields, result boxes)
  units/ trace-width/ resistor/     native calculators (Angular components)
  grid-sketch/ palette-forge/ ...   one folder per page tool: a one-line component
frontend/public/tools/<id>.html      each page tool itself, self-contained
```

Each tool is loaded only when it is first opened, so a long list costs the
first screen nothing.

## Adding a tool

1. **Make a folder** `frontend/src/app/tools/<id>/` with `<id>.ts`, a
   standalone component. A form of figures takes `styleUrl: '../calc.css'` and
   uses its classes (`calc`, `calc-sec`, `calc-title`, `calc-hint`,
   `calc-grid`, `calc-f`, `calc-out`, `calc-warn`, `calc-bad`). Copy an
   existing calculator: `resistor/resistor.ts` is the fullest example.
2. **Add one entry** to `TOOLS` in `registry.ts`: `id`, `name`, a one-line
   `blurb`, `size` (`narrow` for a form, `wide` for a drawing surface) and
   `load: () => import('./<id>/<id>').then(m => m.YourTool)`.
3. **A self-contained HTML page** instead goes in `frontend/public/tools/`,
   and its component is one line around it:
   `<app-tool-frame src="tools/<page>.html" hide=".its-own-title" />`
   (see `grid-sketch/`). The frame dresses the page in the app's colours: the
   page must name its colours `--paper`, `--surface`, `--sunken`, `--ink`,
   `--ink-soft`, `--line`, `--line-soft`, `--accent`, `--accent-ink`,
   `--danger`, `--warn` and `--ok`, and put its title in `.brand` (hidden in
   the app). No external requests, no CDN.
4. **Pick its `group`** in the registry: `electronics`, `design` or `code`.

The rules:

- **Colours come from theme tokens only** (`var(--ink)`, `var(--accent)`,
  ...). `tests/test_theme.py` reads every file under `tools/` and fails on a
  literal colour or an undefined token.
- **Live results, no Calculate button.** Inputs are signals, results are
  `computed`. A field that is being typed in keeps exactly what was typed.
- **A `<select>` gets its state from `[selected]` on each option**, not from
  `[value]` on the select. With options drawn by `@for`, the select's value is
  set before the options exist and it shows the wrong one.
- **Say where the formula stops holding.** A figure outside a standard's
  range gets a `calc-warn` line, not silence.
- **Shared numbers go in `eng.ts`**, not a copy in each tool.

## The tools image: checks, offline

Some tools write something that can be tried for real: SQL, a Prisma schema,
TypeScript, an OpenAPI document, Mermaid, a regex, a cron schedule. One Docker
image, `redline-tools`, tries all of them - offline, nothing installed on the
host. Build it once (it lands in Docker's data root, `/mnt/ssd/docker`):

```bash
docker build -f docker/tools/tools.Dockerfile -t redline-tools docker/tools
```

It holds PostgreSQL 16, Node 22 with TypeScript 5, zod 3, react 19,
react-hook-form 7 and Prisma 7, mermaid-cli with Chrome, Python with the
OpenAPI validator and croniter, and PCRE2. Its first two layers are the Web
Programming image's own, so the two share them on disk.

| Tool | Its **Check** does |
|---|---|
| Schema Sketch | runs the SQL in a fresh PostgreSQL and lists the tables made; validates the Prisma schema |
| API Sketch | validates the OpenAPI YAML; compiles the TypeScript client with `tsc --strict` |
| Form Builder | compiles the Zod, TypeScript and React output against the real libraries |
| Flow to Mermaid | **Render** draws the diagram offline, or says where it does not parse |
| Regex by Example | runs the pattern in Python `re` and PCRE2 and compares with JavaScript |
| Cron Studio | asks croniter for the next runs and compares them with its own |

A check runs only when **Check** is pressed, in a container thrown away
afterwards: `--network none`, the host's user, 2 GB and 2 CPUs, two at a
time. The API is `GET /api/tools/status` and `POST /api/tools/check`
(`backend/tools_api.py`); the image's side is `docker/tools/check.py`, which
reads one JSON request on stdin and writes one JSON answer:

```bash
echo '{"kind":"sql","input":"create table t (id int primary key);"}' \
  | docker run --rm -i --network none redline-tools
```

Opened as a plain file, or without the image, the pages work as before and
simply show no Check.

## Checking a tool

```bash
cd frontend && npx ng build          # no errors; the tool is its own lazy chunk
cd .. && .venv/bin/python -m pytest tests -q
```

Then open the app with `?ws=tools`, pick the tool, and check at least one
result against a figure worked out by hand.
