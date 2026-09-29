// Subagent & Hooks Builder: a Claude Code subagent file (.claude/agents/<name>.md)
// or the hooks section of settings.json, linted, with the hooks placed on the
// session lifecycle and merged into an existing settings.json.
//
// Pure: no DOM, no fetch, no clock. run(input) -> the kit's result plus
// result.lifecycle (the drawing data; agentOmit).
//
// Everything about Claude Code here is from its docs ("Hooks reference",
// "Subagents", "Settings") as read 2026-09 and is marked "verify": events,
// matchers, exit-code meaning, JSON fields, the default timeout and the
// subagent frontmatter keys change between releases. Check them against
// docs.claude.com before relying on them.

export const AS_OF = '2026-09';
export const DEFAULT_TIMEOUT = 60;   // seconds per hook command (verify)
export const TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite', 'Agent', 'Task', 'Skill', 'BashOutput', 'KillShell', 'ExitPlanMode', 'SlashCommand', 'LS'];
const HOT = ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep'];
const MCP_SAMPLE = ['mcp__github__create_issue', 'mcp__memory__read_graph', 'mcp__filesystem__read_file'];

// phase: where the event sits in the drawing. matcher: what the matcher is
// compared with (null = the event takes no matcher). values: the documented
// matcher values for non-tool events. exit2: what exit code 2 does. json: the
// JSON output fields specific to it. All: verify.
export const EVENTS = [
  { id: 'SessionStart', phase: 'session', matcher: 'source', values: ['startup', 'resume', 'clear', 'compact'],
    when: 'A session starts, resumes, or restarts after /clear or compaction.',
    exit0: 'stdout is added to Claude\'s context (use it to load today\'s notes, the branch, open issues).',
    exit2: 'Cannot block: stderr is shown to the user only.', json: 'hookSpecificOutput.additionalContext', input: 'source' },
  { id: 'UserPromptSubmit', phase: 'turn', matcher: null,
    when: 'The user sends a prompt, before Claude reads it.',
    exit0: 'stdout is added as context to the prompt.',
    exit2: 'Blocks the prompt and erases it; stderr is shown to the user.', json: 'decision: "block" + reason; hookSpecificOutput.additionalContext', input: 'prompt' },
  { id: 'PreToolUse', phase: 'loop', matcher: 'tool',
    when: 'Claude has written the tool call, before it runs. Fires for every call that matches.',
    exit0: 'The call goes on (stdout only in the transcript view).',
    exit2: 'Blocks the tool call; stderr is fed to Claude, which sees why and adapts.', json: 'hookSpecificOutput.permissionDecision: "allow" | "deny" | "ask", permissionDecisionReason, updatedInput', input: 'tool_name, tool_input' },
  { id: 'PermissionRequest', phase: 'loop', matcher: 'tool',
    when: 'A permission dialog is about to be shown for a tool call.',
    exit0: 'The dialog is shown as usual.',
    exit2: 'Denies the permission; stderr is fed to Claude.', json: 'hookSpecificOutput.decision.behavior: "allow" | "deny"', input: 'tool_name, tool_input' },
  { id: 'PostToolUse', phase: 'loop', matcher: 'tool',
    when: 'A tool call has succeeded. Fires after every matching call.',
    exit0: 'Nothing is added (stdout only in the transcript view).',
    exit2: 'The tool already ran; stderr is fed to Claude as feedback (a formatter or linter complaint).', json: 'decision: "block" + reason; hookSpecificOutput.additionalContext', input: 'tool_name, tool_input, tool_response' },
  { id: 'PostToolUseFailure', phase: 'loop', matcher: 'tool',
    when: 'A tool call has failed.',
    exit0: 'Nothing is added.',
    exit2: 'stderr is fed to Claude next to the failure.', json: 'hookSpecificOutput.additionalContext', input: 'tool_name, tool_input, error' },
  { id: 'SubagentStart', phase: 'sub', matcher: 'agent',
    when: 'A subagent (the Agent tool) starts.',
    exit0: 'stdout is added to the subagent\'s context.',
    exit2: 'Cannot block: stderr is shown to the user only.', json: 'hookSpecificOutput.additionalContext', input: 'agent_type' },
  { id: 'SubagentStop', phase: 'sub', matcher: 'agent',
    when: 'A subagent finishes its work.',
    exit0: 'The subagent stops and its result goes back.',
    exit2: 'Keeps the subagent working; stderr tells it what is missing.', json: 'decision: "block" + reason', input: 'stop_hook_active' },
  { id: 'Notification', phase: 'turn', matcher: 'type', values: ['permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog'],
    when: 'Claude Code sends a notification: it needs a permission, or the prompt has been idle.',
    exit0: 'Nothing is added.',
    exit2: 'Cannot block: stderr is shown to the user only.', json: '-', input: 'message' },
  { id: 'Stop', phase: 'turn', matcher: null,
    when: 'Claude has finished its answer (not on a user interrupt).',
    exit0: 'Claude stops.',
    exit2: 'Claude does not stop; stderr tells it what to do next (run the tests, fix the build).', json: 'decision: "block" + reason (required when blocking)', input: 'stop_hook_active' },
  { id: 'PreCompact', phase: 'session', matcher: 'trigger', values: ['manual', 'auto'],
    when: 'Before the conversation is compacted (/compact or a full context).',
    exit0: 'Compaction goes on.',
    exit2: 'Cannot block: stderr is shown to the user only.', json: '-', input: 'trigger, custom_instructions' },
  { id: 'SessionEnd', phase: 'session', matcher: 'reason', values: ['clear', 'logout', 'prompt_input_exit', 'other'],
    when: 'The session ends. For cleanup and logging.',
    exit0: 'Nothing.',
    exit2: 'Cannot block.', json: '-', input: 'reason' },
];
export const COMMON = {
  exit0: 'Exit 0: success. JSON on stdout is read for the fields below.',
  exit2: 'Exit 2: a blocking error, with the event-specific meaning shown per event; stderr is the message.',
  other: 'Any other exit code: a non-blocking error; stderr is shown in verbose mode and the session goes on.',
  json: 'Common JSON fields: continue (false stops Claude, with stopReason), suppressOutput, systemMessage.',
  stdin: 'Each hook gets JSON on stdin: session_id, transcript_path, cwd, hook_event_name, plus the event\'s own fields. $CLAUDE_PROJECT_DIR is set.',
};
export const MODELS = ['inherit', 'sonnet', 'opus', 'haiku'];
export const COLORS = ['', 'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];
const EV = Object.fromEntries(EVENTS.map((e) => [e.id, e]));

// ---------- helpers ----------
function regexOf(alt) {
  try { return new RegExp(`^(?:${alt})$`); } catch { return null; }
}
/** Which known tool names a matcher hits: "" and "*" hit all; "A|B" are
 *  alternatives; anything with regex syntax is a regular expression. */
export function matcherHits(m) {
  const t = String(m ?? '').trim();
  if (!t || t === '*') return { all: true, hits: [...TOOLS, 'mcp__*'], bad: [], near: [] };
  const alts = t.split('|').map((x) => x.trim()).filter(Boolean);
  const hits = new Set(); const bad = []; const near = [];
  for (const a of alts) {
    if (/[.*+?^${}()[\]\\]/.test(a)) {
      const re = regexOf(a);
      if (!re) { bad.push(a); continue; }
      const got = [...TOOLS, ...MCP_SAMPLE].filter((x) => re.test(x));
      if (got.length) got.forEach((x) => hits.add(x.startsWith('mcp__') ? 'mcp__*' : x));
      else near.push({ alt: a, hint: null });
      continue;
    }
    if (TOOLS.includes(a) || /^mcp__[\w-]+__[\w-]+$/.test(a)) { hits.add(a); continue; }
    const ci = TOOLS.find((x) => x.toLowerCase() === a.toLowerCase());
    near.push({ alt: a, hint: ci || null });
  }
  return { all: false, hits: [...hits], bad, near };
}

function unquotedVars(cmd) {
  // Walk the command tracking quotes; $NAME / ${NAME} outside double quotes
  // (and outside single quotes, where it is literal) is split on spaces.
  const out = [];
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\' && q !== "'") { i++; continue; }
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '$') {
      const m = /^\$(\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)/.exec(cmd.slice(i));
      if (m) { out.push(m[0]); i += m[0].length - 1; }
    }
  }
  return [...new Set(out)];
}

const kebabOk = (s) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);
const yamlStr = (s) => { const t = String(s); return !t || /^[\s>|&*!%@`'"{[\],?#-]|:\s|\s#|:$|\n/.test(t) ? JSON.stringify(t) : t; };
function estTokens(t) {
  let n = 0;
  for (const m of String(t).matchAll(/[\p{L}]+|\p{N}+|[^\s\p{L}\p{N}]/gu)) { const w = m[0]; n += /^\p{L}+$/u.test(w) ? (w.length <= 6 ? 1 : Math.ceil(w.length / 4.5)) : /^\p{N}+$/u.test(w) ? Math.ceil(w.length / 3) : 1; }
  return n;
}

// ---------- hooks ----------
function hooksMode(input) {
  const rows = (Array.isArray(input.hooks) ? input.hooks : []).map((r, i) => ({
    i, event: String(r?.event ?? '').trim(), matcher: String(r?.matcher ?? '').trim(), command: String(r?.command ?? '').trim(), timeout: String(r?.timeout ?? '').trim(),
  }));
  const lint = [];
  const L = (row, sev, rule, msg) => lint.push({ row, sev, rule, msg });
  const seen = new Map();
  for (const r of rows) {
    const ev = EV[r.event];
    if (!ev) { L(r.i, 'bad', 'event-unknown', `"${r.event}" is not a hook event (${EVENTS.map((e) => e.id).join(', ')}). (verify)`); continue; }
    // Matcher.
    if (ev.matcher === null && r.matcher && r.matcher !== '*') L(r.i, 'warn', 'matcher-ignored', `${r.event} takes no matcher; "${r.matcher}" is ignored and the hook runs every time. (verify)`);
    if (ev.matcher === 'tool') {
      const mh = matcherHits(r.matcher);
      r.hits = mh.hits; r.all = mh.all;
      for (const b of mh.bad) L(r.i, 'bad', 'matcher-regex', `"${b}" is not a valid regular expression.`);
      for (const n of mh.near) L(r.i, 'warn', 'matcher-never', n.hint ? `"${n.alt}" never matches: tool names are case-sensitive, did you mean "${n.hint}"?` : `"${n.alt}" matches no known tool (MCP tools are mcp__<server>__<tool>). If it is a newer tool, verify its name.`);
      const hot = mh.all || mh.hits.some((x) => HOT.includes(x));
      r.hot = hot && (r.event === 'PreToolUse' || r.event === 'PostToolUse');
    }
    if (ev.values && r.matcher && r.matcher !== '*') {
      const bad = r.matcher.split('|').map((x) => x.trim()).filter((x) => x && !ev.values.includes(x));
      if (bad.length) L(r.i, 'warn', 'matcher-value', `${r.event} matches ${ev.values.join(' | ')}; "${bad.join('|')}" never fires. (verify)`);
    }
    // Timeout.
    let to = null;
    if (r.timeout) {
      to = Number(r.timeout);
      if (!Number.isFinite(to) || to <= 0) { L(r.i, 'bad', 'timeout-bad', `Timeout "${r.timeout}" is not a positive number of seconds.`); to = null; }
      else if (r.hot && to > 120) L(r.i, 'warn', 'timeout-long', `${to} s on a hook that runs on every ${r.all ? '' : r.hits.filter((x) => HOT.includes(x)).join('/') + ' '}call: a hang stalls the session that long each time.`);
    } else if (r.hot) L(r.i, 'warn', 'timeout-missing', `Runs on every ${r.all ? 'tool' : r.hits.filter((x) => HOT.includes(x)).join('/')} call with no timeout: a hang blocks for the default ${DEFAULT_TIMEOUT} s each time. Set 5-30 s. (verify default)`);
    r.to = to;
    // Command.
    const c = r.command;
    if (!c) { L(r.i, 'bad', 'command-empty', 'The command is empty.'); continue; }
    const uq = unquotedVars(c);
    if (uq.length) L(r.i, 'warn', 'unquoted-var', `${uq.join(', ')} outside double quotes: a path with a space splits into two words. Write "${uq[0].replace(/^\$\{?(\w+)\}?$/, '$$$1')}".`);
    if (/(^|[\s;&|])(\.\/|\.claude\/)/.test(c)) L(r.i, 'warn', 'relative-path', 'A relative script path breaks when the working directory changes (cd in a Bash call). Start it with "$CLAUDE_PROJECT_DIR"/.');
    const legacy = [...c.matchAll(/\$\{?(CLAUDE_FILE_PATHS|CLAUDE_TOOL_INPUT|TOOL_INPUT|CLAUDE_TOOL_NAME|FILE|FILE_PATH|PROMPT)\}?/g)].map((m) => m[1]);
    if (legacy.length) L(r.i, 'warn', 'no-such-var', `$${legacy[0]} is not set for hooks: the input arrives as JSON on stdin. Read it with jq, e.g. jq -r '.tool_input.file_path'. (verify)`);
    if (/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/.test(c)) L(r.i, 'warn', 'dangerous', 'rm -rf in a hook runs unattended with your permissions. Make sure the path cannot be empty or /.');
    if (/\bsudo\b/.test(c)) L(r.i, 'warn', 'sudo', 'sudo in a hook waits for a password nobody types; the hook times out.');
    if ((r.event === 'Stop' || r.event === 'SubagentStop')) L(r.i, 'info', 'stop-loop', `A ${r.event} hook that exits 2 makes Claude continue, then fire ${r.event} again. Check stop_hook_active in the input and exit 0 when it is true, or it can loop.`);
    if (r.event === 'PostToolUse' && /\b(block|guard|deny|forbid)\b/i.test(c)) L(r.i, 'info', 'post-cannot-block', 'PostToolUse runs after the tool: it cannot stop the call, only complain. Guards belong in PreToolUse.');
    const key = `${r.event}|${r.matcher}|${c}`;
    if (seen.has(key)) L(r.i, 'info', 'duplicate', `Same as row ${seen.get(key) + 1}; identical hooks run once. (verify)`);
    else seen.set(key, r.i);
  }

  // settings.json: the hooks object, then merged into the pasted file.
  const hooksObj = {};
  for (const r of rows) {
    if (!EV[r.event] || !r.command) continue;
    const list = (hooksObj[r.event] ||= []);
    const mk = EV[r.event].matcher === null ? '' : r.matcher;
    let g = list.find((x) => (x.matcher ?? '') === mk);
    if (!g) { g = EV[r.event].matcher === null ? { hooks: [] } : { matcher: mk, hooks: [] }; list.push(g); }
    const hk = { type: 'command', command: r.command };
    if (r.to) hk.timeout = r.to;
    g.hooks.push(hk);
  }
  const warnings = [];
  let merged = null, existingKeys = [], added = 0, skipped = 0;
  const ex = String(input.existing ?? '').trim();
  if (ex) {
    try {
      const base = JSON.parse(ex);
      if (!base || typeof base !== 'object' || Array.isArray(base)) throw new Error('the top level is not an object');
      existingKeys = Object.keys(base);
      merged = structuredClone(base);
      if (merged.hooks != null && (typeof merged.hooks !== 'object' || Array.isArray(merged.hooks))) throw new Error('"hooks" is not an object');
      merged.hooks ||= {};
      for (const [ev, groups] of Object.entries(hooksObj)) {
        const list = Array.isArray(merged.hooks[ev]) ? merged.hooks[ev] : (merged.hooks[ev] = []);
        for (const g of groups) {
          let tgt = list.find((x) => (x.matcher ?? '') === (g.matcher ?? ''));
          if (!tgt) { list.push(structuredClone(g)); added += g.hooks.length; continue; }
          tgt.hooks ||= [];
          for (const hk of g.hooks) {
            if (tgt.hooks.some((x) => x.command === hk.command)) { skipped++; continue; }
            tgt.hooks.push(hk); added++;
          }
        }
      }
    } catch (e) {
      const pos = /position (\d+)/.exec(e.message);
      const line = pos ? ex.slice(0, Number(pos[1])).split('\n').length : null;
      warnings.push(`The pasted settings.json does not parse (${e.message}${line ? `, near line ${line}` : ''}). Only the hooks section is written; fix the file, or paste just {} to start clean. settings.json allows no comments or trailing commas.`);
      merged = null;
    }
  }
  const hooksJson = JSON.stringify({ hooks: hooksObj }, null, 2) + '\n';
  const mergedJson = merged ? JSON.stringify(merged, null, 2) + '\n' : null;
  const target = { project: '.claude/settings.json', local: '.claude/settings.local.json', user: '~/.claude/settings.json' }[input.hooksTarget] || '.claude/settings.json';

  // Lifecycle drawing data.
  const lifecycle = {
    mode: 'hooks',
    events: EVENTS.map((e) => ({ ...e, hooks: rows.filter((r) => r.event === e.id).map((r) => r.i) })),
    rows: rows.map((r) => ({ ...r, lint: lint.filter((x) => x.row === r.i) })),
    orphans: rows.filter((r) => !EV[r.event]).map((r) => r.i),
    common: COMMON, defaultTimeout: DEFAULT_TIMEOUT, tools: TOOLS, target,
  };
  const sev = (s) => lint.filter((x) => x.sev === s).length;
  const values = [
    { label: 'Hooks', value: rows.length, hint: `${Object.keys(hooksObj).length} events` },
    { label: 'On every tool call', value: rows.filter((r) => r.hot).length, hint: 'PreToolUse/PostToolUse on Bash, Edit, Write, Read...', tone: rows.some((r) => r.hot && !r.to) ? 'warn' : 'ok' },
    { label: 'Lint', value: `${sev('bad')} bad · ${sev('warn')} warn · ${sev('info')} info`, tone: sev('bad') ? 'bad' : sev('warn') ? 'warn' : 'ok' },
    { label: 'Merge', value: ex ? (merged ? `${added} added, ${skipped} already there` : 'not parsed') : 'no file pasted', hint: merged ? `kept: ${existingKeys.filter((k) => k !== 'hooks').join(', ') || 'no other keys'}` : `write to ${target}`, tone: ex && !merged ? 'bad' : undefined },
  ];
  const tables = [
    { title: 'Hooks on the lifecycle', columns: ['#', 'Event', 'Matcher', 'Command', 'Timeout s', 'Exit 2 means'], rows: rows.map((r) => [r.i + 1, r.event, r.matcher || (EV[r.event]?.matcher ? '(all)' : '-'), r.command, r.to ?? `default ${DEFAULT_TIMEOUT}`, EV[r.event]?.exit2 || '?']) },
  ];
  if (lint.length) tables.push({ title: 'Lint', columns: ['#', 'Severity', 'Check', 'Finding'], rows: lint.map((x) => [x.row + 1, x.sev, x.rule, x.msg]) });
  for (const x of lint.filter((y) => y.sev === 'bad')) warnings.push(`Hook ${x.row + 1}: ${x.msg}`);
  const texts = [];
  if (mergedJson) texts.push({ title: `Merged ${target}`, body: mergedJson, lang: 'json' });
  texts.push({ title: 'Hooks section', body: hooksJson, lang: 'json' });
  return { values, tables, texts, warnings, lifecycle };
}

// ---------- subagent ----------
function agentMode(input) {
  const name = String(input.agentName ?? '').trim();
  const desc = String(input.agentDescription ?? '').trim();
  const toolsRaw = String(input.agentTools ?? '').trim();
  const tools = toolsRaw ? toolsRaw.split(',').map((x) => x.trim()).filter(Boolean) : [];
  const model = MODELS.includes(input.agentModel) ? input.agentModel : 'inherit';
  const color = COLORS.includes(input.agentColor) ? input.agentColor : '';
  const prompt = String(input.agentPrompt ?? '').trim();
  const scope = input.agentScope === 'user' ? 'user' : 'project';
  const lint = [];
  const L = (field, sev, rule, msg) => lint.push({ field, sev, rule, msg });
  if (!name) L('name', 'bad', 'name-missing', 'The name is empty; it is the subagent_type the main agent passes.');
  else if (!kebabOk(name)) L('name', 'bad', 'name-format', `"${name}" should be lowercase letters, digits and hyphens. (verify)`);
  if (!desc) L('description', 'bad', 'desc-missing', 'The description is empty: it is all the main agent reads when deciding to delegate.');
  else {
    if (!/\b(use (it |this agent )?(when|for|after|before|proactively)|when the user|when you|proactively|must be used|use whenever)\b/i.test(desc)) L('description', 'warn', 'desc-when', 'Say when to delegate ("Use after editing C files...", "Use proactively when..."): the main agent picks subagents from this line.');
    if (desc.length < 60) L('description', 'warn', 'desc-short', `${desc.length} characters: name the task, the inputs it needs and what it returns.`);
    if (desc.length > 600) L('description', 'info', 'desc-long', `${desc.length} characters: every session carries this line; keep detail in the prompt body.`);
  }
  const toolInfo = tools.map((t) => {
    const base = t.replace(/\(.*\)$/, '');
    return { text: t, base, known: TOOLS.includes(base) || /^mcp__[\w-]+(__[\w*-]+)?$/.test(base) };
  });
  for (const t of toolInfo) if (!t.known) L('tools', 'warn', 'tool-unknown', `"${t.text}" is not a Claude Code tool name (case matters). (verify)`);
  if (!tools.length) L('tools', 'info', 'tools-inherit', 'No tools line: the subagent inherits every tool of the main session, MCP tools included. List only what the job needs. (verify)');
  const readOnly = /\b(review|reviewer|audit|analy[sz]e|inspect|explain|research|read-only|read only)\b/i.test(desc + ' ' + name);
  if (readOnly && toolInfo.some((t) => ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(t.base))) L('tools', 'warn', 'tools-write', 'A reviewing/analysing agent with Write or Edit: drop them unless it is meant to change files.');
  if (toolInfo.some((t) => t.base === 'Bash') && readOnly) L('tools', 'info', 'tools-bash', 'Bash on a read-only agent can still change files (sed -i, git checkout); keep it only if it must run commands.');
  if (!prompt) L('prompt', 'bad', 'prompt-missing', 'The system prompt is empty.');
  else {
    if (prompt.length < 200) L('prompt', 'warn', 'prompt-short', `${prompt.length} characters: a subagent starts with no memory of the conversation; say its role, the steps and what to return.`);
    if (!/\b(return|report|output|respond with|reply with|final (answer|message)|summary)\b/i.test(prompt)) L('prompt', 'warn', 'prompt-output', 'Say what to return: the main agent only gets the subagent\'s final message, so its shape matters.');
    if (/\byou are a helpful assistant\b/i.test(prompt)) L('prompt', 'info', 'prompt-generic', '"You are a helpful assistant" adds nothing; state the specific role.');
  }
  const fm = ['---', `name: ${yamlStr(name || 'my-agent')}`, `description: ${yamlStr(desc)}`];
  if (tools.length) fm.push(`tools: ${tools.join(', ')}`);
  fm.push(`model: ${model}`);
  if (color) fm.push(`color: ${color}`);
  fm.push('---', '');
  const md = fm.join('\n') + prompt + '\n';
  const path = `${scope === 'user' ? '~/.claude/agents' : '.claude/agents'}/${kebabOk(name) ? name : 'my-agent'}.md`;
  const listing = `- ${name || 'my-agent'}: ${desc || '(no description)'} (Tools: ${tools.length ? tools.join(', ') : '*'})`;
  const sev = (s) => lint.filter((x) => x.sev === s).length;
  const values = [
    { label: 'File', value: path },
    { label: 'Tools', value: tools.length ? `${tools.length} listed` : 'all (inherited)', tone: tools.length ? 'ok' : 'warn' },
    { label: 'Model', value: model, hint: model === 'inherit' ? 'same as the main session' : 'alias (verify)' },
    { label: 'Prompt', value: `~${estTokens(prompt)} tok`, hint: 'loaded when the subagent starts' },
    { label: 'Lint', value: `${sev('bad')} bad · ${sev('warn')} warn · ${sev('info')} info`, tone: sev('bad') ? 'bad' : sev('warn') ? 'warn' : 'ok' },
  ];
  const tables = lint.length ? [{ title: 'Lint', columns: ['Part', 'Severity', 'Check', 'Finding'], rows: lint.map((x) => [x.field, x.sev, x.rule, x.msg]) }] : [];
  let eof = 'EOF'; while (md.split('\n').includes(eof)) eof += '_';
  const dir = path.replace(/\/[^/]+$/, '');
  const qp = (p) => (p.startsWith('~/') ? `"$HOME/${p.slice(2)}"` : `'${p}'`);
  const sh = `mkdir -p ${qp(dir)}\ncat > ${qp(path)} <<'${eof}'\n${md.replace(/\n$/, '')}\n${eof}\n`;
  return {
    values, tables,
    texts: [{ title: path.split('/').pop(), body: md, lang: 'markdown' }, { title: 'Create file (sh)', body: sh, lang: 'sh' }, { title: 'How the main agent sees it', body: listing + '\n' }],
    warnings: lint.filter((x) => x.sev === 'bad').map((x) => `${x.field}: ${x.msg}`),
    lifecycle: { mode: 'subagent', lint, listing, path, tools: toolInfo, knownTools: TOOLS, models: MODELS, colors: COLORS, promptTokens: estTokens(prompt), descTokens: estTokens(listing) },
  };
}

export function run(input) {
  const mode = input.mode === 'subagent' ? 'subagent' : 'hooks';
  const res = mode === 'subagent' ? agentMode(input) : hooksMode(input);
  res.notes = [
    `Events, matchers, exit-code meanings, JSON fields, the ${DEFAULT_TIMEOUT} s default timeout and the subagent frontmatter keys are from the Claude Code docs as read ${AS_OF}: verify against docs.claude.com (Hooks reference, Subagents) before relying on them.`,
    mode === 'hooks' ? 'Hooks run shell commands with your user\'s permissions, unattended. Read every command before merging; settings are read at session start, so restart Claude Code (or review them in /hooks) after a change.'
      : 'Project agents live in .claude/agents/, personal ones in ~/.claude/agents/; a project agent with the same name wins. /agents lists and edits them. (verify)',
  ];
  return res;
}
