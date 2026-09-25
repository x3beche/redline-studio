# Tools

The **Tools** tab: calculators, references, checkers and sketch pads that
serve every room - PCB, embedded, mechanical, web, mobile and the project as
a whole. It sits on the top bar just left of Analytics. Agents reach the
same tools over MCP.

This file is the whole story of the tab. Read it when a task is about a tool
- using one, fixing one, adding one - or before you work out an engineering
value by hand: there is probably a tool for it.

## For agents: find a tool, read its manual, run it

The MCP server (`tools/mcp_server.py`, started by `.mcp.json`) has four tools
for this:

| MCP tool | What it does |
|---|---|
| `find_tool` | `{task, room?, limit?}` - describe what you are trying to work out; a small model reads a one-line index of **every** tool and picks the best 1-3. Each pick comes back with its manual. |
| `tool_manual` | `{id}` - a tool's inputs (keys, units, defaults, options), an example input, what it answers, its sources, and whether it can be run. |
| `run_tool` | `{id, input}` - runs the tool offline in the tools image and returns `{values, tables, texts, charts, warnings, notes}`. Numbers may be engineering-notation strings: `"4k7"`, `"100n"`, `"3.3V"`. |
| `tool_data` | `{id, data?, project?}` - reads (no `data`) or replaces a project tool's shared record: `interface-contract`, `project-constants`, `decision-log`, `glossary`, `req-test-matrix`. Every room and agent then uses the same values. |

A typical call: `find_tool {task: "pull-ups for a 400 kHz I2C bus with three
sensors"}` → `i2c-pullup` with its manual → `run_tool {id: "i2c-pullup",
input: {vdd: "3.3", mode: "fast", cb: "120"}}`. Read the `warnings` - they
say when a formula is outside its range or a result is unsafe. Set `X3_AGENT`
to your name; it is sent with every call and shows in the usage.

Interactive tools (Grid Sketch, Screenshot Annotator, the editors) have a
manual but cannot be run by an agent; the manual says so.

### How the picker works

`backend/tool_router.py`. The index is one line per tool - `id | what it does
| rooms` - and the whole request (instructions, the index, the task, room for
the answer) is held under **8192 tokens**, so a small, cheap model with an 8k
window can read every tool at once. If a catalog ever outgrows that, the
lines are ranked by a keyword score and the best that fit are sent. The model
is the app's OpenRouter model (`summarise.MODEL`, key in `.env`, server side
only); its calls are billed in Analytics under surface `tools`, kind
`tool-router`. Without a key, or when the model fails, the keyword score
(a small BM25 over names, blurbs and keywords) answers instead. The API is
`POST /api/tools/find`.

## For people: the tab

- **Search** - press `/` anywhere in the tab. Words match names, keywords,
  descriptions and rooms; arrows move through the results, Enter opens, Esc
  clears.
- **Filters** - ★ shows only favourites; the room chips (PCB, Embedded, 3D,
  Web, Mobile, Analytics) show the tools for that room.
- **Favourites** - the ★ beside a tool, or in its header. Favourites and the
  last few tools used are listed first.
- **Groups** - PCB & electronics, Embedded, Mechanical & 3D, Web & design,
  Mobile, Code, data & prompts, Project; click a heading to fold it.
- Each tool's header shows **MCP** when agents can run it, and its uses over
  30 days.

Favourites, recents and folded groups are kept in this browser. Uses are
counted on the server (below).

## Usage, in Analytics

Every open, run, copy, check, find and manual lookup is one row in
`tool_usage` (per workspace) - the tool, the event, the surface (`ui` for
people in the app, `mcp` for agents, `api`), when, and who
(`actors.current()`). `GET /api/tools/usage/summary?days=N` sums it; the
Analytics tab's **Tools** section draws it: uses by day, people against
agents, the most used, and every tool nobody used.

## The tools

<!-- catalog:start -->
175 tools. **MCP** marks the ones agents can run with `run_tool`.

### PCB & electronics

| Tool | id | What it answers | Rooms |
|---|---|---|---|
| **Annular Ring Checker** · MCP | `annular-ring` | whether the ring left around a drill is safe for a fab's tolerance | PCB |
| **Antenna Length Calculator** · MCP | `antenna-length` | quarter-wave antenna length and keep-out for a frequency | PCB |
| **Assembly Cost Estimator** · MCP | `assembly-cost` | assembly cost from unique parts, placements and extended-part fees | PCB, Analytics |
| **Board Cost Estimator** · MCP | `board-cost` | estimated fabrication cost from board size, layer count, quantity and options | PCB, Analytics |
| **Board Density Estimator** · MCP | `board-density` | density class and routing difficulty from part count and area | PCB, Analytics |
| **BOM Deduplicator** · MCP | `bom-dedupe` | merges spellings of the same part and produces a consolidated BOM | PCB, Analytics |
| **Buck Converter Designer** · MCP | `buck-designer` | inductor, output capacitor and ripple for a buck converter | PCB |
| **Capacitor Derating** · MCP | `cap-derating` | real capacitance of an MLCC under DC bias and temperature | PCB |
| **Connector Pinout Library** · MCP | `connector-pinouts` | pin maps of USB-C, SWD, JTAG, JST, IDC and other common connectors | PCB, Embedded |
| **Copper Area Thermal** · MCP | `copper-thermal` | temperature rise of a power part from the copper area under it | PCB |
| **Creepage & Clearance** · MCP | `creepage-clearance` | minimum conductor spacing for a working voltage per IPC-2221, as a table | PCB |
| **Crystal Load Capacitor** · MCP | `crystal-load` | load capacitors for a crystal from its CL and board stray capacitance | PCB, Embedded |
| **Current Sense Designer** · MCP | `current-sense` | shunt value, its power and the amplifier gain for a range and an ADC input | PCB, Embedded |
| **Decoupling Planner** · MCP | `decoupling-planner` | how many decoupling capacitors and which values for an IC's supply pins and target impedance | PCB |
| **Design Rule Diff** · MCP | `rule-diff` | two rule sets compared side by side | PCB |
| **Differential Pair Matcher** · MCP | `diffpair-match` | length-matching tolerance for USB, Ethernet, HDMI and similar pairs | PCB |
| **DRC Rule Preset Builder** · MCP | `drc-presets` | track, space and drill rules from a fab's capabilities, ready for the Rules tab | PCB |
| **ERC Rule Explainer** · MCP | `erc-explainer` | what an ERC error means and its usual fix, in plain words | PCB |
| **ESD Protection Selector** · MCP | `esd-selector` | TVS diode selection criteria by interface and line speed | PCB |
| **Fiducial & Tooling Planner** · MCP | `fiducial-planner` | fiducial and tooling-hole placement for assembly | PCB |
| **Fuse & Polyfuse Selector** · MCP | `fuse-selector` | fuse rating from normal current and fault scenario | PCB |
| **Gerber Checklist** · MCP | `gerber-checklist` | completeness of layers, drills, panel and notes before sending to fab | PCB |
| **Heat Sink Sizing** · MCP | `heatsink-sizing` | required thermal resistance and heat sink size from power and ambient | PCB, 3D |
| **I2C Pull-up Calculator** · MCP | `i2c-pullup` | the pull-up resistor range for an I2C bus from its supply, speed and capacitance | PCB, Embedded |
| **Impedance Calculator** · MCP | `impedance-calc` | characteristic impedance of microstrip, stripline and differential pairs from the stackup | PCB |
| **Land Pattern Reference** · MCP | `land-pattern` | IPC-7351 pad sizes and courtyard for common packages | PCB |
| **Layer Assignment Advisor** · MCP | `layer-advisor` | signal, power and ground distribution for a layer count | PCB |
| **LDO vs Buck Advisor** · MCP | `ldo-vs-buck` | efficiency, heat and noise of an LDO against a buck, side by side | PCB |
| **Length Matching Budget** · MCP | `length-budget` | maximum length mismatch for a bus speed, in ps and mm | PCB |
| **MOSFET Gate Drive Check** · MCP | `mosfet-gate` | switching loss and driver adequacy from gate charge, drive current and frequency | PCB |
| **Mounting Hole Planner** · MCP | `mounting-holes` | keep-out on the board from hole size, standoff and screw | PCB, 3D |
| **Net Naming Linter** · MCP | `net-name-linter` | checks net names against a convention and lists the inconsistent ones | PCB |
| **Op-Amp Gain Tool** · MCP | `opamp-gain` | gain, offset and bandwidth of inverting and non-inverting stages | PCB |
| **Package Dimension Explorer** · MCP | `package-explorer` | physical sizes of packages from 0201 to QFN, compared to scale | PCB, 3D |
| **Panelization Planner** · MCP | `panelization` | how many boards fit a panel with V-cut or mouse-bite margins, and the waste | PCB |
| **Part Alternative Finder** · MCP | `part-alternatives` | alternatives for a part in stock, with basic/extended class compared | PCB |
| **PCB Weight & CoG** · MCP | `pcb-weight` | mass and centre of gravity of board, copper and parts | PCB, 3D |
| **Power Rail Tree** · MCP | `power-rail-tree` | supply rails as a tree with each branch's current budget and total power | PCB, Embedded |
| **RC / LC Filter Designer** · MCP | `rc-lc-filter` | component values from a cutoff frequency, with the magnitude response drawn | PCB |
| **Resistor & LED** · MCP | `resistor` | Ohm's law, an LED's series resistor, a divider from standard values | PCB, Embedded |
| **Return Path Checker** · MCP | `return-path` | return-path problems of layer changes and the stitching vias they need | PCB |
| **Schematic Symbol Checklist** · MCP | `symbol-checklist` | pin types, names and electrical properties to check on a new symbol | PCB |
| **Silkscreen Legibility Check** · MCP | `silkscreen-check` | whether text height and stroke width are under a fab's minimum | PCB |
| **SMD Code Decoder** · MCP | `smd-code` | resistor and capacitor markings (103, 4R7, EIA-96) to their values | PCB |
| **Stackup Designer** · MCP | `stackup-designer` | pick layer order, dielectric thickness and copper weight; see board thickness and impedance targets | PCB |
| **Stencil Aperture Calculator** · MCP | `stencil-aperture` | solder paste aperture and area/aspect ratio from pad size and stencil thickness | PCB |
| **Stock Risk Scanner** · MCP | `stock-risk` | ranks single-source and low-stock parts in a BOM by risk | PCB, Analytics |
| **Terminal Block & Crimp Reference** · MCP | `crimp-reference` | terminal blocks and crimp sizes for a wire cross-section | PCB |
| **Test Point Planner** · MCP | `test-point-planner` | test point list for critical nets and probe access checks | PCB |
| **Trace Width** · MCP | `trace-width` | how wide a track must be for a current, by IPC-2221, and what it drops | PCB |
| **Via Current & Thermal** · MCP | `via-thermal` | current a via array carries and its temperature rise from drill, plating and count | PCB |
| **Wire Gauge Selector** · MCP | `wire-gauge` | cable size from current, length and allowed voltage drop | PCB, Embedded |

### Embedded

| Tool | id | What it answers | Rooms |
|---|---|---|---|
| **ADC Resolution Calculator** · MCP | `adc-resolution` | LSB size from reference and bits, and the oversampling gain | Embedded |
| **Battery Life Estimator** · MCP | `battery-life` | run time in days from average current and battery capacity | Embedded, PCB |
| **Bootloader Size Check** · MCP | `bootloader-fit` | whether application and bootloader regions fit | Embedded |
| **CAN Bit Timing Calculator** · MCP | `can-bit-timing` | segment values and sample point from a clock and bit rate | Embedded |
| **Clock Tree Planner** · MCP | `clock-tree` | PLL settings and peripheral clocks from a crystal frequency | Embedded |
| **Compiler Flag Explainer** · MCP | `compiler-flags` | size and speed effect of the optimisation flags in a build log | Embedded |
| **CRC Calculator** · MCP | `crc-calc` | CRC-8/16/32 with polynomial, init and reflection settings | Embedded |
| **Cycle to Time Converter** · MCP | `cycles-time` | instruction cycles to microseconds and back at a clock | Embedded |
| **Debounce Time Calculator** · MCP | `debounce-time` | debounce time for a button type and sampling period | Embedded |
| **EMA / IIR Coefficient Tool** · MCP | `iir-coefficient` | smoothing coefficient from a cutoff frequency, with the response drawn | Embedded |
| **Endianness Inspector** · MCP | `endianness` | the same bytes read as little and big endian side by side | Embedded |
| **Firmware Size Diff** · MCP | `firmware-size-diff` | symbol-by-symbol size change between two builds, largest first | Embedded |
| **Fixed-Point Converter** · MCP | `fixed-point` | a decimal value in a Q format and the precision lost | Embedded |
| **Flash Partition Planner** · MCP | `flash-partitions` | OTA, NVS and filesystem partitions sized, with a partition table | Embedded |
| **GPIO Restriction Warner** · MCP | `gpio-warner` | risks of using boot straps and special-purpose GPIOs | Embedded, PCB |
| **Hash & Checksum Quick Tool** · MCP | `hash-checksum` | MD5, SHA and simple checksums of text or hex data | Embedded, Web |
| **Hex Dump Decoder** · MCP | `hex-dump-decoder` | captured raw bytes split into frames for a chosen protocol | Embedded |
| **I2C Address Map** · MCP | `i2c-address-map` | devices on a bus by address, with conflicts and alternative addresses | Embedded, PCB |
| **IEEE754 Float Inspector** · MCP | `float-inspector` | sign, exponent and mantissa bits of a float | Embedded |
| **Interrupt Latency Budget** · MCP | `irq-latency` | CPU load and miss risk from interrupt rates and handler times | Embedded |
| **Linker Script Helper** · MCP | `linker-script` | a linker script from sections and memory regions in a form | Embedded |
| **Log Format Designer** · MCP | `log-format` | a compact embedded log format and its parser code | Embedded |
| **Memory Map Viewer** · MCP | `memory-map` | flash and RAM region use as a scaled strip | Embedded |
| **Modbus Frame Builder** · MCP | `modbus-frame` | an RTU/TCP frame with its CRC from function code and registers | Embedded |
| **Motor Driver Current Limit** · MCP | `motor-current-limit` | current limit and reference voltage from the sense resistor | Embedded, PCB |
| **NMEA / Serial Log Parser** · MCP | `serial-log-parser` | a serial log parsed line by line into a table of fields | Embedded |
| **NVIC Priority Planner** · MCP | `nvic-planner` | interrupt priorities in order, with preemption conflicts | Embedded |
| **PID Tuning Playground** · MCP | `pid-playground` | a simple plant's step response live as the gains move | Embedded |
| **Pin Mux Explorer** · MCP | `pin-mux` | a pin's alternate functions on an MCU and the conflicts | Embedded, PCB |
| **printf Format Checker** · MCP | `printf-checker` | whether a format string matches its argument types | Embedded |
| **Register Bitfield Editor** · MCP | `bitfield-editor` | toggle bits of a hex value and read each field's meaning | Embedded |
| **Sensor Calibration Fit** · MCP | `sensor-calibration` | linear calibration coefficients from two or more readings | Embedded |
| **Servo Pulse Mapper** · MCP | `servo-pulse` | angle range to pulse width, with calibration values | Embedded |
| **Sleep Current Profiler** · MCP | `sleep-current` | average current from sleep and wake times and currents | Embedded |
| **SPI Mode Reference** · MCP | `spi-modes` | CPOL/CPHA combinations with timing diagrams | Embedded |
| **Stack Usage Estimator** · MCP | `stack-estimator` | worst-case stack from call depth and locals | Embedded |
| **Stepper Motor Calculator** · MCP | `stepper-calc` | pulse frequency and torque from step angle, microstepping and speed | Embedded, 3D |
| **Struct Packing Visualizer** · MCP | `struct-packing` | alignment of struct members and the padding bytes wasted | Embedded |
| **Task Timing Planner** · MCP | `task-timing` | scheduling conflicts of periodic tasks from period and duration | Embedded |
| **Units & Numbers** · MCP | `units` | mm, mil and inch; hex, decimal and binary; UART baud and timer periods | Embedded, PCB |
| **Watchdog Planner** · MCP | `watchdog-planner` | a safe watchdog period and feed points from the longest task | Embedded |

### Mechanical & 3D

| Tool | id | What it answers | Rooms |
|---|---|---|---|
| **Assembly Order Planner** · MCP | `assembly-order` | assembly order and access needs as a step list | 3D |
| **Beam Deflection Calculator** · MCP | `beam-deflection` | deflection and maximum stress of a simple beam under load | 3D |
| **Bearing Fit Advisor** · MCP | `bearing-fit` | shaft and housing tolerances for a bearing's bore and outside diameter | 3D |
| **Belt & Pulley Calculator** · MCP | `belt-pulley` | belt length and ratio from pulley diameters and centre distance | 3D |
| **Bolt Circle Generator** · MCP | `bolt-circle` | hole coordinates and CAD code from count and diameter | 3D |
| **Bolt Torque Calculator** · MCP | `bolt-torque` | tightening torque and preload for a bolt size and material | 3D |
| **Cable Bend Radius** · MCP | `cable-bend` | minimum bend radius and clearance for a cable | 3D |
| **Chamfer & Fillet Guide** · MCP | `chamfer-fillet` | recommended chamfers and radii by manufacturing process | 3D |
| **Clearance Fit Calculator** · MCP | `iso-fit` | actual clearance or interference of an ISO fit such as H7/g6 | 3D |
| **Draft Angle Checker** · MCP | `draft-angle` | minimum draft angle for release from a mould | 3D |
| **Enclosure Fit Checker** · MCP | `enclosure-fit` | inner enclosure size and cut-outs from the board outline and connector heights | 3D, PCB |
| **Fastener Library** · MCP | `fastener-library` | screw, nut and washer sizes by head type, with CAD variables | 3D |
| **Gear Calculator** · MCP | `gear-calc` | pitch and outside diameter and centre distance from module and teeth | 3D |
| **Heat-Set Insert Sizer** · MCP | `heat-set-insert` | boss hole diameter and wall thickness for an insert | 3D |
| **Knurl & Grip Pattern** · MCP | `knurl-pattern` | grip pattern parameters and CAD code | 3D |
| **Mass & CoG from Volume** · MCP | `mass-cog` | mass and centre of gravity from volumes and materials | 3D |
| **Material Property Table** · MCP | `material-table` | density, modulus, yield strength and expansion of materials compared | 3D |
| **Print Guideline Checker** · MCP | `print-guidelines` | wall, bridge and overhang values checked for a print process | 3D |
| **Print Time & Cost** · MCP | `print-cost` | print time and cost from volume, infill and material price | 3D |
| **Sheet Metal Bend Allowance** · MCP | `bend-allowance` | flat length from K-factor and bend radius | 3D |
| **Shrinkage Compensator** · MCP | `shrinkage` | corrected dimension for a material's shrinkage | 3D |
| **Snap-Fit Calculator** · MCP | `snap-fit` | insertion force and strain of a cantilever snap hook | 3D |
| **Spring Rate Calculator** · MCP | `spring-rate` | spring constant from wire diameter, coils and diameter | 3D |
| **Standoff Height Planner** · MCP | `standoff-height` | standoff length from the tallest part under the board | 3D, PCB |
| **Thermal Expansion Calculator** · MCP | `thermal-expansion` | dimension change of a part over a temperature change | 3D, PCB |
| **Thread & Tap Drill Chart** · MCP | `thread-drill` | tap drill and clearance hole sizes for a thread | 3D |
| **Tolerance Stack-Up** · MCP | `tolerance-stack` | worst-case and statistical sum of a chain of dimensions | 3D |
| **Vibration Frequency Estimator** · MCP | `vibration-freq` | rough first natural frequency from geometry and material | 3D |

### Web & design

| Tool | id | What it answers | Rooms |
|---|---|---|---|
| **Accessibility Audit Lite** · MCP | `a11y-audit` | contrast, focus order and missing labels in pasted HTML | Web, Mobile |
| **Chart Spec Builder** · MCP | `chart-spec` | axes, series and scales chosen into a chart configuration | Web |
| **CSS Specificity Calculator** · MCP | `css-specificity` | which of two selectors wins, and why | Web |
| **DOM Selector Finder** · MCP | `selector-finder` | the shortest stable CSS selector for an element in pasted HTML | Web |
| **Flexbox Playground** · MCP | `flexbox-playground` | try alignment properties and see the result and code | Web |
| **Form Builder** | `form-builder` | build a form with its rules, get Zod, types and a React component | Web |
| **Grid Sketch** | `grid-sketch` | draw a layout on a grid, copy it as a prompt, CSS or JSON | Web, Mobile |
| **HTTP Request Tester** · MCP | `http-tester` | send a request and see headers, timing and the response | Web, Embedded |
| **Icon & Favicon Generator** · MCP | `icon-generator` | every icon size and the manifest entries from one image | Web, Mobile |
| **JSON Diff Viewer** · MCP | `json-diff` | two responses compared by line and by field | Web, Analytics |
| **JSON Path Explorer** · MCP | `json-path` | walk a large JSON and copy the access path of a field | Web |
| **JSON to TypeScript** · MCP | `json-to-ts` | type definitions and a validation schema from sample JSON | Web, Mobile |
| **JWT & Base64 Decoder** · MCP | `jwt-decoder` | decode a token and show its expiry and signature fields | Web |
| **Motion Lab** | `motion-lab` | shape an easing curve and timing, take it as CSS or JS | Web, Mobile |
| **MQTT Message Simulator** · MCP | `mqtt-simulator` | fake telemetry messages to test an IoT dashboard | Web, Embedded |
| **Palette Forge** | `palette-forge` | one colour into an accessible palette and light/dark tokens | Web, Mobile |
| **Responsive Preview Matrix** · MCP | `responsive-matrix` | one page at several breakpoints side by side, with overflow flagged | Web, Mobile |
| **Screenshot Annotator** | `screenshot-annotator` | mark up a screenshot and turn the marks into a fix list | Web, Mobile |
| **Shadow & Radius Studio** · MCP | `shadow-radius` | layered shadows and radii tuned visually, as one CSS line | Web |
| **SVG Path Editor** · MCP | `svg-path-editor` | edit a path node by node and trim needless decimals | Web |
| **Telemetry Mock Generator** · MCP | `telemetry-mock` | realistic sensor time series with noise, drift and faults | Web, Embedded |
| **Type Scale Generator** · MCP | `type-scale` | heading and body sizes from a base and ratio, as CSS variables | Web, Mobile |
| **WebSocket Echo Tester** · MCP | `websocket-tester` | open a socket, send messages and list replies with timestamps | Web |

### Mobile

| Tool | id | What it answers | Rooms |
|---|---|---|---|
| **Adaptive Icon Composer** · MCP | `adaptive-icon` | foreground and background layers with mask previews | Mobile |
| **ADB Command Palette** · MCP | `adb-commands` | common emulator and device commands, ready to copy | Mobile |
| **Deep Link Builder** · MCP | `deep-link` | a deep link from scheme and parameters, with the emulator test command | Mobile |
| **DP / PX / DPI Converter** · MCP | `dp-px-converter` | sizes across density buckets and the asset sizes to export | Mobile |
| **Layout Inspector Mapper** · MCP | `layout-mapper` | a region of a screen mapped to its view in a uiautomator dump | Mobile |
| **Permission Picker** · MCP | `permission-picker` | the permissions and manifest lines a feature set needs | Mobile |
| **Safe Area Overlay** · MCP | `safe-area` | notch, status bar and navigation bar areas over a screenshot | Mobile |
| **Screen Flow Mapper** · MCP | `screen-flow` | screen-to-screen transitions as a diagram and a navigation graph | Mobile |
| **String Table Editor** · MCP | `string-table` | multilingual strings in a table, out as resource files | Mobile, Web |
| **Touch Target Checker** · MCP | `touch-targets` | touch targets under the minimum size in a layout | Mobile |

### Code, data & prompts

| Tool | id | What it answers | Rooms |
|---|---|---|---|
| **API Sketch** | `api-sketch` | define endpoints, get OpenAPI, curl and a TypeScript client | Web, Mobile |
| **Context Packer** | `context-packer` | pack code, logs and notes into one well-built prompt | Web, Embedded, Mobile, PCB, 3D |
| **Cron Studio** | `cron-studio` | build a cron expression, see when it next runs | Web, Embedded |
| **Data Digest** | `data-digest` | profile a large CSV or JSON into a compact brief for an LLM | Web, Embedded |
| **Flow to Mermaid** | `flow-mermaid` | draw a flowchart with boxes and arrows, get Mermaid code | Web, Embedded, Mobile |
| **Regex by Example** | `regex-example` | pick what should match in a text and get the regex, explained | Web, Embedded |
| **Schema Sketch** | `schema-sketch` | draw tables and relations, get SQL, Prisma and Mermaid | Web, Mobile |

### Project

| Tool | id | What it answers | Rooms |
|---|---|---|---|
| **Agent Queue Inspector** · MCP | `queue-inspector` | queued work by time, room and success rate, with the stuck step | all |
| **Certification Pre-Check** · MCP | `cert-precheck` | typical gaps before CE/FCC (filtering, grounding, labels) as a checklist | Analytics |
| **Change Impact Estimator** · MCP | `change-impact` | which rooms a change touches, from dependencies | Analytics |
| **Datasheet Snippet Extractor** · MCP | `datasheet-extractor` | pinout and absolute maximum tables from a PDF into structured data | all |
| **Decision Log (ADR)** · MCP | `decision-log` | short records of why a part or topology was chosen | Analytics |
| **FMEA Lite** · MCP | `fmea-lite` | failure modes scored by likelihood and effect into a risk order | Analytics |
| **Glossary & Acronym Book** · MCP | `glossary` | a project's acronyms and terms in one list | all |
| **Interface Contract** · MCP | `interface-contract` | GPIO map, I2C addresses and voltage levels defined once for every room | PCB, 3D, Web, Embedded, Mobile |
| **Naming Convention Enforcer** · MCP | `naming-enforcer` | nets, symbols, parts and files checked against one naming rule | PCB, 3D, Web, Embedded, Mobile |
| **Pin-to-Net-to-Symbol Mapper** · MCP | `pin-net-symbol` | trace an MCU pin to its PCB net and its firmware symbol | PCB, Embedded |
| **Project Constants** · MCP | `project-constants` | board size, supply voltages and mechanical references kept in one place | all |
| **Redline History Diff** · MCP | `redline-history` | every note that landed on the same area over time, with outcomes | all |
| **Requirement ↔ Test Matrix** · MCP | `req-test-matrix` | each requirement matched with the test that proves it, gaps shown | Analytics |
| **Total Cost Roll-Up** · MCP | `cost-rollup` | PCB, BOM, assembly, enclosure and cable cost per unit at a quantity | Analytics |
<!-- catalog:end -->

The calculators read values the way an engineer writes them: `4k7`, `2M2`,
`100n`, `10m` (milli) and `3.3V` all work. `m` is milli and `M` is mega.

## Where it lives

```
frontend/public/tools/
  <id>/manifest.json   every tool: name, blurb, group, rooms, keywords, inputs, usage
  <id>/tool.js         a kit tool's calculation: export function run(input) - pure, runs in Node
  <id>/index.html      a kit tool's page: three lines that call the kit
  <id>/view.js         optional: a drawing the standard blocks cannot make
  kit/kit.js           the kit: form, results, Prompt/JSON outputs, Copy, usage pings
  kit/kit.css          the kit's look, in the colour names the app rewrites
  kit/eng.js           engineering notation, E12/E24/E96, nearest standard value
  kit/cli.mjs          runs one tool in Node: how run_tool and the tests call it
  <name>.html          the older single-page tools (Grid Sketch, Palette Forge, ...)
frontend/src/app/tools/
  room.ts, room.css    the tab: search, filters, favourites, the list, the tool
  registry.ts          groups, rooms, and the tools that are Angular components
  frame.ts             frames a page and dresses it in the app's colours
  units/ trace-width/ resistor/     the three Angular calculators
backend/tools_api.py   catalog, manual, run, find, usage, project records, checks
backend/tool_router.py the picker
```

The API serves `frontend/public/tools/` itself at `/api/tools/files/`, so a
tool added while the app runs is there at once - no restart - and the same
path works in the production build.

## Adding a tool

Make a folder `frontend/public/tools/<id>/`; `i2c-pullup/` is the reference.

1. **`manifest.json`** - `id` (the folder's name), `name`, `blurb` (one line:
   what it answers), `group` (`pcb`, `embedded`, `mechanical`, `web`,
   `mobile`, `code`, `project`), `rooms`, `keywords` (8-15 - the words
   people and agents search with), `intro`, `inputs`, `examples`, `usage`
   (for agents: which inputs, in which units, what comes back), `sources`,
   and `"view": true` if there is a view.js. Input types: `number` (give
   `unit`; engineering notation accepted), `text`, `textarea`, `select`
   (`options`), `bool`, `table` (`columns`). Give every input a `default` so
   the tool shows a real answer on first open.
2. **`tool.js`** - `export function run(input)` returning `{values, tables,
   texts, charts, warnings, notes}` (see the head of `kit/kit.js`). Pure: no
   DOM, no fetch, no clock, no randomness - it must run in Node, where
   agents call it. Import only from `../kit/eng.js`. Comment each formula
   with its source; return a warning, never NaN, when an input is out of
   range.
3. **`index.html`** - copy the reference's and change the title.
4. **Its own interface** (`"layout": "custom"` in the manifest): `view.js`
   exports `page(root, ctx)` and builds the whole page around the thing the
   tool is about - Grid Sketch's grid, the Impedance Calculator's
   cross-section, the CRC's shift register, the FMEA's risk matrix - worked
   on directly. The kit still keeps the inputs, runs the tool and hands over
   `ctx.outputs` (the Prompt/JSON panel) to place. `ctx.set(key, value)`
   changes an input, `ctx.onResult(fn)` gets every new result; every number
   drawn comes from `run()`'s result. See the head of `kit/kit.js`.
   Result fields that only feed the drawing and are large (a whole package's
   pins, a curve's points) can be listed in the manifest's `agentOmit`:
   `run_tool` leaves them out for agents; the page still gets them.
5. **`view.js`** with `view()` only, when a drawing under the standard form helps: `export function view(el, result,
   input)`, colours only from the CSS variables. Put the drawing's numbers
   in the result too - agents never see the view.

Nothing else to register: the catalog, the search, the picker and the MCP
tools read the manifests. Run the tests (below) and regenerate the catalog
section of this file with `.venv/bin/python tools/tools_md.py`.

The older kinds - a self-contained page in `public/tools/<name>.html` (give
its folder a manifest with `"page": "tools/<name>.html"`), or an Angular
component under `src/app/tools/` (add it to `COMPONENTS` in `registry.ts`,
and `"native": true` in its manifest) - still work, for tools that are
editors rather than calculations.

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
.venv/bin/python -m pytest tests/test_tool_catalog.py -q   # every manifest; every kit tool runs its example
cd frontend && npx ng build
```

`tests/test_tool_catalog.py` holds every tool to the contract above, runs
every kit tool's example in Node and fails on NaN, `undefined` or an empty
result, and checks that the picker's request for the real catalog fits the
8192-token window whole. Run a tool the way an agent does:

```bash
cd frontend/public/tools
echo '{"vdd": "3.3", "cb": "120"}' | docker run --rm -i --network none \
  -v "$PWD":/tools:ro --entrypoint node redline-tools /tools/kit/cli.mjs i2c-pullup
```

Then open it at `/api/tools/files/<id>/` (or in the tab) at a wide and a
360 px window, and check one answer against a figure worked out by hand.
