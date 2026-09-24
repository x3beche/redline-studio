# Tools

The **Tools** tab: small calculators and sketch pads that serve every room. It
sits on the top bar just left of Analytics. The tools are listed on the left;
the one you pick fills the room, and the tab comes back to it next time.

This file is the whole story of the tab. Read it only when a task is about a
tool - using one, fixing one or adding one. Nothing else in the repository
depends on it.

## The tools

| Tool | What it does | Mostly for |
|---|---|---|
| **Grid Sketch** | Draw a layout on a grid (drag to draw an area, drag it to move it, rename it in the list) and copy it as a prompt, CSS, grid areas, Tailwind, ASCII or JSON. Remembers its own work. | Web, Mobile |
| **Units & Numbers** | mm, mil, inch and µm; decimal, hex, binary and octal, with the two's complement at 8 to 64 bits; a UART's BRR and baud error for a clock (STM32 16× oversampling); the timer PSC/ARR pair nearest a frequency. | Embedded, PCB |
| **Trace Width** | How wide a track must be for a current on an outer and an inner layer (IPC-2221), with its resistance, voltage drop and loss over a length; what a given width carries; what a via carries. | PCB |
| **Resistor & LED** | Ohm's law from any two of V, I, R and P; an LED's series resistor rounded up to an E12/E24/E96 value, with the current and package it then needs; the standard divider pair nearest a Vout, with its current and source impedance. | PCB, Embedded |

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
  grid-sketch/       one folder per tool
  units/
  trace-width/
  resistor/
frontend/public/tools/grid-sketch.html   Grid Sketch's page itself
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
   (see `grid-sketch/`). The frame dresses the page in the app's colours.

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

## Checking a tool

```bash
cd frontend && npx ng build          # no errors; the tool is its own lazy chunk
cd .. && .venv/bin/python -m pytest tests -q
```

Then open the app with `?ws=tools`, pick the tool, and check at least one
result against a figure worked out by hand.
