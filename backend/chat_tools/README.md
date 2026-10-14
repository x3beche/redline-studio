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
- `model_render` (change, on; package `cad`): a model's last build
  photographed from up to 4 views (taste.py `render_views`, tools/render.py)
  or a board's 3D (render.py board:<id>; its top and bottom drawings when it
  has none), kept as PNGs in Files > Chat/Renders with the model, build
  version, view and size in their context - the cache, and what the step's
  `shot0..3` vars point at so the Chat shows them inline. A model building
  or broken is refused with why.
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

## Undo

Everything a `change` or `delete` tool writes while it runs as a step is
kept for undo (backend/chat_undo.py): `Tool` wraps the handler, the
handler gets `ctx.db` seen through a recorder, and each write - through
any helper, in any collection - is read before and after. What changed is
one document of `cc_changes` per step: the conversation (`ctx.chat`), the
step (`ctx.step`, set by ccgen.run_step), the tool, who, when, the rights
its handler checked with `need()` (`_rights.py`), and per document the
whole of it (made or deleted) or only its changed fields - a list of dicts
with an `id` (or `file`, `_id`, `key`) by its members, a log by the lines
it gained. A tool that changes nothing keeps nothing.

The Chat shows "Changed: n things · Undo" under the answer and every
change of the conversation in its header menu's "Changes"
(`GET /api/cc/chats/{id}/changes`, `POST .../changes/undo` with `ids`,
`POST .../changes/{change}/redo`). Undo sets back only a target that is
as the tool left it - else it says, field by field, what changed since and
undoes nothing of that change - and needs the rights the change needed. It
is kept as a change of its own (`of`), so it can be redone. Changes stay
undoable for `REDLINE_CC_UNDO_DAYS` (30) days; a Files file a tool (or an
undo) removed keeps its bytes until then (`files.HOLD`).

A new tool needs nothing for this: the generic inverse covers whatever it
writes through `ctx.db`. When that is not right, say so on its `Tool`:

```python
TOOL = Tool(..., undo=False)                       # a cache: nothing kept, nothing shown
TOOL = Tool(..., undo="a build cannot be unbuilt")  # kept and shown; not undoable, the words say why

async def undo(ctx: Ctx, change: dict, apply: bool) -> None:
    """Its own inverse (drawer_add.py): `change` has its `args`, `vars` and
    `docs`; raise chat_undo.Conflict("why") when it cannot, PermissionError
    without the right; change nothing unless `apply`."""
TOOL = Tool(..., undo=undo)
```

Per collection, `chat_undo.VOLATILE_IN` names fields a background job
writes after the tool (never a conflict, never set back - a STEP's
`measured`), `chat_undo.AFTER` a hook after an undo (the conversation's
new title said to its open pages, a model measured again) and
`chat_undo.KIND` what the page calls its documents (an English key of
i18n.ts). Write outside `ctx.db` (a file on disk, a job started) and it is
not undone: give the tool an `undo` string or function.

Which tools: generic - stock (`inventory_add`, `_adjust`, `_edit`,
`_remove`), catalog products (`catalog_add_product`, `_edit_product`,
`_remove_product`), a product's files (`product_file_attach`, `_detach`,
`product_set_main`, `product_to_my_items`), notes (`note_write`,
`note_edit`, `note_todo`), `rename_chat`, `chat_archive`, `mcmaster_save`,
`grabcad_save`, `room_note`, `pdf_make`, `drawing_layout`; its own -
`drawer_add`; shown, not undoable - `catalog_read_page`,
`catalog_add_maker`, `product_to_model`; not kept - `datasheet_get`.

## Who gets which

Each person turns tools on or off for themselves (the Chat tab's "Tools"
button, `GET/PUT /api/cc/tools`, kept in `cc_tool_prefs` per account). A
tool nobody chose about follows its `default`. Only the tools on for whoever
sent the line go to the model. A model or provider that refuses tools gets
the question again without them (`no_tools` on the answer).
