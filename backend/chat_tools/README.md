# Chat tools

Tools the Chat tab's models may call while they answer (backend/ccgen.py runs
the loop: the model asks, the server runs the tool, the result goes back, the
model goes on - at most `MAX_ROUNDS` rounds). Each call is a *step* kept on
the answer and shown inline on the page.

## Adding a tool

1. One new file here, `backend/chat_tools/<name>.py`, with a `TOOL`:

   ```python
   from . import Ctx, Result, Tool, ToolError

   async def run(ctx: Ctx, args: dict) -> Result:
       # ctx.db is the asker's workspace (backend/scope.py); ctx.vision says
       # whether the model reads images; ctx.actor is who asked; ctx.chat the
       # conversation.
       if not args.get("x"):
           raise ToolError("say what x is")           # told to the model, shown as the step's error
       return Result(text="what the model reads",     # capped at MAX_TEXT
                     say="Did the thing with {x}",    # the page's sentence, {holes} from vars
                     vars={"x": args["x"]},
                     summary="short result for the expanded row")

   TOOL = Tool(
       name="my_tool", level="read",                  # read | change | delete
       label="Do the thing",                          # its name on the Tools panel
       about="Does the thing, in one line.",          # its line on the Tools panel
       description="What the model is told: when to use it, what it returns.",
       schema={"type": "object", "properties": {"x": {"type": "string"}}, "required": ["x"]},
       running="Doing the thing with {x}",            # while it runs (holes from the input)
       failed="Could not do the thing with {x}",
       default=False,                                 # on or off for people who never chose
       run=run)
   ```

   The registry finds it by itself (files starting with `_` are helpers,
   like `_parts.py`). No other Python changes.

2. Its strings in `frontend/src/app/i18n.ts` (TR): `label`, `about`,
   `running`, `failed` and every `say` the handler can return - the English
   is the key, the page translates and then fills the `{holes}`.

3. Optionally an icon: `TOOL_ICON` in `frontend/src/app/rooms/cc-tools.ts`
   (a wrench otherwise).

4. A test in `tests/test_chat_tools.py` (or a file of its own beside it,
   as `tests/test_chat_tools_notes.py`).

Helpers: `_parts.py` (an LCSC number, a kept datasheet), `_things.py` (a
board, model or firmware named by its id or by words of its title, read
through the workspace, and the list of them when the name fits nothing).

## The tools

- Parts: `drawer_search`, `drawer_list`, `lcsc_search`, `drawer_add`,
  `datasheet_get`, `datasheet_read`.
- Files on Parts products (package `mfr`; backend/product_files.py, the
  helper `_product.py`): `product_find` (a product of any source by words,
  with its `maker:product` ids), `product_files_read` (its files and what
  its 3D model measured), `product_file_attach` (change, on: a STEP, PDF or
  picture onto a product - the files attached to the person's latest line,
  Files ids, or a link; a STEP is its model and measured, the answer waits
  a little for the size), `product_file_detach` (delete: asks first),
  `product_set_main` (an attached picture or model made the product's
  own), `product_to_model` (its model into a CAD project, as Files' "Add to
  project": a build, no agent), `product_files_missing` (which have no 3D
  model or datasheet) and `product_to_my_items` (change, off). A product
  left unnamed is the one the conversation's last product step named.
- Building from stock (package `mfr`, helper `_build.py`): `build_count`
  (read: a board's BOM lines - bom_cost.py `board_lines` - or a 3D
  assembly's bought parts - the models it imports that are Parts products
  or in purchased/ - against the stock lines counting the same product,
  LCSC number or MPN: whole builds, the limiting parts, the shortfall for a
  target), `shopping_list` (change: the shortfall or a given list priced
  across LCSC's kept price breaks and least quantities, the sites' prices
  and McMaster-Carr's snippet prices, cheapest first per line in the
  display currency at fx.py's rates, totals per seller; `export` csv, md or
  pdf into Files > Documents) and `stock_consume` (delete: asks first; the
  parts of N builds taken out of stock, all or nothing, "used 4 for
  fan-board x2" in each line's log).
- `basic_tool`: the Tools tab's calculators, in two steps - `task` finds
  them (tool_router.py, as the MCP server's find_tool) with their inputs,
  `id` + `input` runs one (tools_api.py `run_kit`: its own tool.js, in a
  throwaway offline container). Interactive-only tools are said to be so.
- Workspace things: `board_read` (cc_context.py `board_parts` +
  board_stats.py), `model_read` (cc_context.py `model_parts`), `bom_cost`
  (bom_cost.py, offers on disk only), `firmware_build` (the firmware's
  build summary and fwbuild.py's jobs), `file_read` (files.py, pdftext.py).
- `drawing_layout` (change, off; package `cad`): a 3D model's technical
  drawing layout read, set (the whole spec, checked by backend/drawlayout.py)
  or put back to automatic, as the layout editor's PUT does, and with
  `make` the drawing made again with it.
- `pdf_make` (change, on; package `files`): a document the model writes in
  Markdown, printed as a PDF in Workbench's white theme (backend/pdfdoc.py:
  headless Chromium in its container, no network) and kept in Files >
  Documents; its description is the writing guide. The step carries the
  file; the Chat opens it, and any `/api/files/<id>` link, in its viewer
  (frontend/src/app/rooms/file-modal.ts).
- `room_note` (change, off by default): a queued note, as a ```task
  block's "Send to queue" files one (tasks.py `_file`).
- The rooms' queues (General: they span the 3D, PCB and Firmware rooms):
  `queue_list` (the revisions, by room, newest first, each with its state
  - draft, queued, working, review, failed, applied, rejected - and the
  runs open now, as "Working now" reads them) and `queue_read` (one, whole).
- The Chat's own (package `commandcode`): `rename_chat` (change, on:
  this conversation's title, through cc_chat.py `rename` - the list's own
  rename, said to every open tab), `chat_list` and `chat_read` (the
  conversations, as the list and opening one show them) and `chat_archive`
  (change, off).
- `analytics_read` (General, read, on): the Analytics room's figures -
  the very answer `GET /api/insights` gives the page (insights.py
  `overview_cached`, kept per workspace and range), with the right that GET
  needs; a compact overview, or one `section` (costs, llm, tokens, runs,
  notes, api, budget) or `project` in full, in the display currency.
- Notes (the Notes tab, notes.py): `notes_search`, `note_read`; and, off
  by default, `note_write`, `note_todo` (tick or untick one to-do),
  `note_edit` - with the rights the Notes API's routes need (`_notes.py`).

## Levels

- `read` - runs freely.
- `change` - runs, and always shows a step (it keeps something).
- `delete` - asks first: the step waits with Allow / Deny on the page
  (`POST /api/cc/chats/{id}/steps/{step}`), for whoever asked or anyone who
  may delete; nothing runs without a yes (`ASK_WAIT` seconds, then no).

## Who gets which

Each person turns tools on or off for themselves (the Chat tab's "Tools"
button, `GET/PUT /api/cc/tools`, kept in `cc_tool_prefs` per account). A
tool nobody chose about follows its `default`. Only the tools on for whoever
sent the line go to the model. A model or provider that refuses tools gets
the question again without them (`no_tools` on the answer).
