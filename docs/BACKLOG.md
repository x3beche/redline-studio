# Open work

Written down so nothing is dropped between sessions. Tick a line only when it
has been built, measured or seen on screen, and pushed.

**Two hands now.** One agent works the revision queue, which lives in MongoDB;
the other works the app, which lives in this repository. They do not overlap:
a revision changes a model's source in the database and commits nothing, and
an app change never touches a model. Only the app side pushes.

## Revisions

The queue is the source of truth — `tools/revisions.py queue`. Nothing is
listed here, because a copy would go stale the moment someone presses *queue*.

Rules that are easy to get wrong:

- only `queued` counts as work; a draft is somebody still typing;
- read the drawing before the note, with the Read tool, every time;
- measure, fix, re-measure, then leave the measurement behind as a check that
  raises;
- zero clash proves nothing on its own — probe for the material that should be
  there as well;
- rebuild, render from the revision's own camera, and look at it before
  calling it done.

## The board room

Built and answered: the source is atopile, text and parametric, so a
change is an edit and the loop works as it does for a model. KiCad never
touches the source — it places, draws and exports, in a container, from
the netlist that build produced.

Left to do, roughly in order:

- **No way to make a board from the screen.** No **+ Board** in the left
  column, no editor for the `.ato` in the room. The source goes in through
  `revisions.py board save`, which is fine for the agent and no use to a
  person.
- **Differential pairs are not coupled.** Freerouting routes them as two
  nets at the class's width and gap. Fine for USB full speed; a fast pair
  would need KiCad's own interactive router or another tool.
- **Silkscreen warnings.** Reference text lands on pads and outlines on a
  dense board - 16 warnings on the controller. The fab clips silk from
  pads, but moving the text would be tidier.
- **ERC pin types.** LCSC symbols mostly type their pins Unspecified, so
  ERC warns on every connection to them (57 on the controller) and cannot
  catch two outputs tied together. Typing the pins from the datasheet, or
  from the symbol's own names (VDD, GND, ~RST), would make ERC mean more.
- **The placer is a start, not a layout.** Modules as blocks, connectors on
  edges, decoupling beside its chip; not thermal zones, not keep-outs, not
  "this LED on the front".

## Coding rooms

Three tabs, not one: **Web**, **Embedded** and **Mobile**. They are the
same loop over different things on screen, so they are one component
with a platform, the way the 3D room is one viewer whatever the model.
Web is built first and in full; the other two get the shared plumbing
(the file in the tree, notes, diff, tests, log, machine) and say plainly
that their preview is not there yet.

**A project is a file.** Collection `apps`, one document per project:

    {_id, title, folder, platform: web | embedded | mobile,
     repo:  absolute path of the git checkout,
     cwd:   where the commands run, relative to repo ("frontend"),
     url:   where its dev server answers ("http://127.0.0.1:4200"),
     dev:   the command that starts that server, if nothing answers,
     test:  the command whose exit code is the check,
     routes: a few routes worth offering}

It sits in the catalog tree beside `.3d` and `.pcb` as `.web`, `.fw` or
`.mobile`, and clicking it opens its room (`Selection.openApp`). Nothing
big goes in the document: test output is a tail, a frozen diff goes
through `store.put_artifact`.

**A code note** is a revision with `kind` web | embedded | mobile,
`model` the app id, the drawing as its image, and a `code` block:

    code: {route, viewport: [w, h], base: HEAD sha when frozen,
           dirty: {path: blob sha} of what was already changed then,
           dom: [{selector, tag, text, box, component, file}]}

`dirty` is what keeps somebody else's uncommitted work out of the note's
diff: only files that differ from how they were when the note was drawn
belong to it.

**Endpoints**, all under `/api/apps`: list, one, PUT, move, DELETE;
`status` (does the url answer, branch, head, dirty count); `serve`
(start `dev` when nothing answers); `shot` (headless Chrome over CDP -
route, viewport, PNG and every visible element's box, selector and the
component that renders it); `diff` (working tree, or one note's since
its base, as files and hunks); `test` (run it, measured by the same
meter as a build, stored as a tail); `compute` (jobs, as for boards).

**The room** is a grid of panes like the board room's: the preview
(iframe, route field, viewport chips, the 3D room's freeze button and
drawing tools over a real screenshot), diff with before/after, tests,
the room's own log with its ⤢, and machine. What is under the marks
fills the Part field on the right as `button.tcv-btn · rooms/pcb.ts`.

**For the agent**, `tools/revisions.py code`:

    code show <id>     note, route, viewport, the elements under the marks,
                       and the drawing written to disk
    code diff <id>     what changed since the note, as a patch
    code test <id>     run the project's test command
    code after <id>    the same route and viewport, photographed again
    code done <id>     tests, then the after shot, then applied - it
                       refuses while the tests fail

`queue` marks these `[WEB]`, `[EMBEDDED]`, `[MOBILE]`.

- [x] tabs, catalog entry, opening the room
- [x] live preview
- [x] screenshot, pen and note
- [x] DOM mapping
- [x] agent CLI
- [x] diff view
- [x] tests as the check
- [x] before/after

Left to do, roughly in order:

- **No + App in the left column.** A project is registered with
  `PUT /api/apps/{id}`; fine for an agent, no use to a person.
- **Embedded has nothing to frame.** A serial console in the log pane's
  second tab and a capture of the device's display as the "page" are the
  obvious two; the notes, diff and tests already work for firmware.
- **Mobile is a phone-sized web page.** Real devices want an emulator
  screenshot (adb exec-out screencap, xcrun simctl io) and a view
  hierarchy dump in place of the DOM inventory.
- **A note's picture is 340-380 kB of PNG** and takes about 4.6 s to
  reach the database at this link's speed. A lossless crop to what the
  marks touch, or WebP, would cut it several times over.
- **websockets warns** that `connect()` should be a context manager, in
  webshot.py and render.py both; the sync client still works.

## Coding rooms, second round

Asked for on 2026-09-24:

- The tabs are called **Web Programming**, **Embedded Programming** and
  **Mobile Programming**, and stay three tabs of their own.
- **Each has its own Docker image and its own view.** Nothing is
  installed on the host. `docker/code/web.Dockerfile` (Chrome, Node,
  python for the photographer), `embedded.Dockerfile` (arm-none-eabi,
  CMake, Ninja), `mobile.Dockerfile` (Android SDK, an emulated Pixel 7 on
  KVM). A shot, a build and a test run go through the tab's container,
  with the checkout mounted at its own path and the host's network.
  - Web: the page in a frame, as now.
  - Embedded: the firmware as built - memory regions and the largest
    symbols, each one tagged with its source file and line so a ring
    round it says `Core/Src/main.c:212`. First project: the STM32H743
    firmware in ~/Desktop/stm32_projects/PS, built out of tree (4.0 s).
  - Mobile: the phone's screen, live, from `adb screencap`; freeze lists
    the elements on it (uiautomator for a native app, Chrome's DevTools
    for a page) with their boxes in the screen's pixels.
- **No run or build buttons.** The person marks; the agent builds, runs
  the tests and starts servers. The board room's are going the same way
  (its owner is doing that).
- **One main agent, one sub-agent per tab.** The main agent waits on the
  queue, reads the thread, and hands each queued note to the sub-agent
  for its room (`.claude/agents/redline-*.md`). Rooms work in parallel,
  so a run is per room - `runs/current` for the 3D room as before,
  `runs/current:<room>` for the others - and a build is filed under its
  own room's run.
- **An MCP server for the queues** (`tools/mcp_server.py`, stdio, no new
  dependency): queue by room, show a note, start, log, finish, done,
  chat, say, ask - the same operations as revisions.py.

Run end to end on 2026-09-24, with Docker's storage on /mnt/ssd (web image
1.23 GB, mobile 5.09 GB, embedded 12.1 GB - Espressif's base is most of it):

- Web: the iot-fan dashboard served from its container, frozen in 3.0 s,
  a ring round the speed readout mapped to `#duty · web/public/index.html`;
  4 tests pass in 0.4 s.
- Embedded: the STM32F042 firmware builds in 1.1 s (12.0 kB of 32 kB
  flash, 36.7% - newlib's stdio is most of it), the ESP32 in 11.9 s the
  first time (252 kB app; five memory types from idf.py size); the fan
  logic's 5 tests pass in 1.1 s. Nothing plugged in, so no board has been
  programmed yet.
- Mobile: the phone boots in 44 s on KVM; Chrome's first run is pressed
  through by its own words; the app's page elements come from the phone's
  Chrome in screen pixels - `#up` at [564, 1356, 396, 168], exactly the +
  button - and map to `mobile/public/index.html:26`; 4 tests pass.

Still open: flashing a real board, a native Android app (the image has no
Gradle yet), and the iot-fan firmware drives a fan pin the Controller
board does not break out.

## Analyze

A tab that says what it needs before it can exist.

## App — further out
- **Revisions applied before the machine meter existed show nothing** for
  compute. That is deliberate — better than claiming zero — but it means the
  first few cards read as though they were free.
- **The bundle is 1.88 MB against a 1.5 MB budget.** Warned on every build.
  The CAD viewer is most of it. three.js and the glTF loader are no longer
  in that number — the board viewer is fetched when the 3d tab is opened.

## Done and pushed

- Lid screws: three bosses deleted, two left, the left one pulled out of the
  wall and shaved against the board's tall module, then lifted so the board
  can be fitted and mirrored so the two are symmetric.
- The fan leans back instead of forward (`TILT = -18`), and the plug follows
  the tilt instead of being drawn where an upright fan's socket would be — at
  any tilt but zero it used to hang in mid-air.
- Every note on the board is an English request; summaries follow.
- Card analytics: tokens, list-price cost, time, rate, a chart, a spend donut,
  and the split by model, provider and kind of work.
- Machine analytics beside them: CPU, peak memory, energy and the whole
  machine's share, measured by the kernel rather than guessed.
- Before/after pictures on the card; `finish` takes the after shot.
- The running task is docked in the viewer's column with its live cost,
  refreshed every second.
- The log runs along the bottom of the view; the toolbar spans the full width.
- Switches, padding, rounded viewer, native freeze icon.
- README split in three: front page, INSTALL, USAGE.
- Every colour is a theme token, with default, light and oled, and tests
  that fail on a colour written anywhere else.
- Questions: the agent asks on the person's screen and blocks for the
  answer, with a browser notice and a count in the tab title.
- A thread under the queue for everything that is not a mark on a model,
  with undo while the message is still unread.
- The log is read-only; the clear button and its endpoint are gone.
- Notices start where the 3D area does instead of covering the toolbar.
- `render.py` applies the revision's own camera from a cold profile, and
  --width/--height mean the picture rather than the window.
- A render's GPU time is measured, from nvidia-smi's per-process sampler,
  and reaches the energy figure at the card's rated limit.
- The thread's urgent switch, and `revisions.py stop` so the agent can end
  a build early when it decides that is the answer.
- Text selection works again; the viewer's stylesheet had turned it off on
  `body` for the whole application.
- A header of rooms across the two right-hand columns, the active tab's
  border opening into the card below it, the left column untouched.
- The board room: atopile builds the netlist, LCSC supplies the footprint
  and the 3D model for each part number, KiCad places and draws it in a
  container, and the result is a layer render, a GLB and a BOM.
- One tree for everything — `.3d` and `.pcb` side by side, folders that
  fold, and what is folded survives F5 along with the log and the thread.
