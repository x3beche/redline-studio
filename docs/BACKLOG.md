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
  column, no editor for the `.ato` in the room. The source goes in
  through `PUT /api/boards/{id}`, which is fine for the agent and no use
  to a person.
- **The placer puts everything in one row.** `docker/place.py` walks
  along the board at a fixed pitch. It is honest — nothing pretends to
  be laid out — but a board with thirty parts will run off the edge.
  Grouping by net is the first thing to try.
- **Nothing is routed**, and the ratsnest does not show in the layer
  render. `kicad-cli` will not draw one; it would have to come from the
  netlist we already have.
- **A revision loop for boards.** Notes, queue, before/after, cost — all
  of it is `model`-shaped in `revisions.py`. Do not generalise it until
  the coding room says what its third shape looks like; splitting on a
  guess splits in the wrong places.

## The other two rooms

Coding and Analyze are tabs that say what they need before they can
exist. Everything in the spine still says `model`, `PARTS`,
`viewer.json`.

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
