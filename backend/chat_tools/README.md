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
       # whether the model reads images; ctx.actor is who asked.
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

3. Optionally an icon: `TOOL_ICON` in `frontend/src/app/rooms/commandcode.ts`
   (a wrench otherwise).

4. A test in `tests/test_chat_tools.py`.

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
