// Conversation & Agent Trace Viewer: a chat or agent transcript split into
// turns and tool calls, with tokens per turn and where the context grew.
// Pure: no DOM, no fetch, no clock.
//
// Formats read (auto-detected, or forced with `format`):
//   anthropic   Messages API: [{role, content: string | blocks}] or a request
//               body {system, messages}; blocks text, tool_use {id, name,
//               input}, tool_result {tool_use_id, content, is_error}, thinking,
//               redacted_thinking, image. A message may carry `usage`.
//   openai      Chat Completions: roles system/developer/user/assistant/tool,
//               assistant.tool_calls [{id, function: {name, arguments}}],
//               tool messages {tool_call_id, content}, legacy function_call;
//               `usage` {prompt_tokens, completion_tokens,
//               prompt_tokens_details.cached_tokens} if a log attached it.
//   claude-code Claude Code session JSONL (~/.claude/projects/<dir>/<id>.jsonl):
//               lines {type: user|assistant|system|summary, message, uuid,
//               timestamp, isSidechain}; an assistant message streamed as one
//               line per content block with the same message.id is merged.
//
// Tokens: from `usage` where the trace has it (the provider's count); else
// an estimate of characters / 4, said so everywhere it is shown.

const CHARS_PER_TOKEN = 4;          // rough average for English and code; not a tokenizer
const IMAGE_TOKENS = 1600;          // estimate for one image block (about 1.2 megapixels at ~750 px per token)
const est = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);
const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} more characters]` : s);
const MAX_SHOW = 6000;              // characters of each block kept for the page

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' && typeof v !== 'boolean' ? Number(v) : null);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v, null, 1));

/** Text of a tool_result content (string or blocks). */
function resultText(c) {
  if (typeof c === 'string') return { text: c, images: 0 };
  if (Array.isArray(c)) {
    let images = 0;
    const text = c.map((b) => {
      if (b?.type === 'text') return b.text ?? '';
      if (b?.type === 'image') { images++; return '[image]'; }
      return str(b);
    }).join('\n');
    return { text, images };
  }
  return { text: str(c), images: 0 };
}

// ---------------- reading ----------------
function readJsonl(text) {
  const rows = [], bad = [];
  text.split('\n').forEach((l, i) => {
    const t = l.trim();
    if (!t) return;
    try { rows.push({ line: i + 1, v: JSON.parse(t) }); } catch { bad.push(i + 1); }
  });
  return { rows, bad };
}

export function detect(text) {
  const t = String(text || '').trim();
  if (!t) return { format: 'empty' };
  let whole = null;
  try { whole = JSON.parse(t); } catch { /* JSONL or broken */ }
  if (whole != null) {
    const list = Array.isArray(whole) ? whole : Array.isArray(whole.messages) ? whole.messages : null;
    if (!list) return { format: 'unknown', whole };
    if (list.some((x) => x && (x.type === 'user' || x.type === 'assistant') && x.message)) return { format: 'claude-code', rows: list.map((v, i) => ({ line: i + 1, v })), bad: [] };
    return { format: flavour(list), list, system: whole.system ?? null, bad: [] };
  }
  const { rows, bad } = readJsonl(t);
  if (!rows.length) return { format: 'unknown', bad };
  if (rows.some((r) => r.v && (r.v.type === 'user' || r.v.type === 'assistant') && r.v.message)) return { format: 'claude-code', rows, bad };
  const list = rows.map((r) => r.v);
  return { format: flavour(list), list, system: null, bad };
}
function flavour(list) {
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'tool' || m.tool_calls || m.function_call || m.role === 'function' || m.role === 'developer') return 'openai';
    if (Array.isArray(m.content) && m.content.some((b) => ['tool_use', 'tool_result', 'thinking', 'redacted_thinking'].includes(b?.type))) return 'anthropic';
  }
  return 'anthropic';
}

/** Blocks of one Anthropic-style content value. */
function anthropicBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return content == null ? [] : [{ type: 'other', text: str(content) }];
  return content.map((b) => {
    switch (b?.type) {
      case 'text': return { type: 'text', text: b.text ?? '' };
      case 'thinking': return { type: 'thinking', text: b.thinking ?? '' };
      case 'redacted_thinking': return { type: 'thinking', text: '[redacted thinking]', redacted: true, chars: String(b.data ?? '').length };
      case 'tool_use': case 'server_tool_use': return { type: 'tool_use', id: String(b.id ?? ''), name: String(b.name ?? '?'), input: b.input ?? {} };
      case 'tool_result': case 'web_search_tool_result': {
        const r = resultText(b.content);
        return { type: 'tool_result', id: String(b.tool_use_id ?? ''), text: r.text, images: r.images, isError: !!b.is_error };
      }
      case 'image': return { type: 'image', text: '[image]' };
      case 'document': return { type: 'other', text: '[document]' };
      default: return { type: 'other', text: str(b) };
    }
  });
}
function usageOf(u) {
  if (!u || typeof u !== 'object') return null;
  const out = {
    input: num(u.input_tokens ?? u.prompt_tokens), output: num(u.output_tokens ?? u.completion_tokens),
    cacheRead: num(u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens),
    cacheWrite: num(u.cache_creation_input_tokens), cost: num(u.cost ?? u.cost_usd),
  };
  // OpenAI's prompt_tokens already include the cached ones; Anthropic's input_tokens do not.
  out.openai = u.prompt_tokens != null;
  if (out.input == null && out.output == null) return null;
  return out;
}

/** Turns from any supported format: [{role, blocks, usage?, ts?, model?, side?}]. */
function toTurns(det, problems) {
  const turns = [];
  if (det.format === 'claude-code') {
    const byId = new Map();
    for (const { line, v } of det.rows) {
      if (!v || typeof v !== 'object') continue;
      if (v.type === 'summary' || v.type === 'file-history-snapshot' || v.type === 'queue-operation') continue;
      if (v.type === 'system') {
        const text = str(v.content ?? v.message?.content ?? v.subtype ?? '');
        turns.push({ role: 'system', blocks: [{ type: 'text', text }], ts: v.timestamp, line, compact: v.subtype === 'compact_boundary' });
        continue;
      }
      if ((v.type !== 'user' && v.type !== 'assistant') || !v.message) continue;
      const msg = v.message;
      const blocks = anthropicBlocks(msg.content);
      const usage = usageOf(msg.usage);
      if (v.costUSD != null && usage) usage.cost = num(v.costUSD);
      const mid = v.type === 'assistant' && msg.id ? String(msg.id) : null;
      if (mid && byId.has(mid)) {
        const t = byId.get(mid);
        t.blocks.push(...blocks);
        if (usage) t.usage = usage;       // the last line of a streamed message has the final output count
        continue;
      }
      const onlyResults = blocks.length && blocks.every((b) => b.type === 'tool_result');
      const t = { role: v.type === 'assistant' ? 'assistant' : onlyResults ? 'tool' : 'user', blocks, usage, ts: v.timestamp, model: msg.model, line,
        side: !!v.isSidechain, meta: !!v.isMeta || !!v.isCompactSummary };
      turns.push(t);
      if (mid) byId.set(mid, t);
    }
    return turns;
  }
  const list = det.list || [];
  if (det.system) {
    const text = typeof det.system === 'string' ? det.system : Array.isArray(det.system) ? det.system.map((b) => b?.text ?? '').join('\n') : str(det.system);
    turns.push({ role: 'system', blocks: [{ type: 'text', text }] });
  }
  list.forEach((m, i) => {
    if (!m || typeof m !== 'object' || !m.role) { problems.push(`Message ${i + 1} has no role; skipped`); return; }
    const usage = usageOf(m.usage);
    if (det.format === 'openai') {
      const blocks = [];
      const content = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => (p?.type === 'text' ? p.text : p?.type === 'image_url' ? '[image]' : str(p))).join('\n') : '';
      if (m.role === 'tool' || m.role === 'function') {
        const err = /^\s*(error|traceback|exception)\b/i.test(content);
        turns.push({ role: 'tool', blocks: [{ type: 'tool_result', id: String(m.tool_call_id ?? m.name ?? ''), text: content, images: 0, isError: err }], usage });
        return;
      }
      if (content) blocks.push({ type: 'text', text: content });
      if (m.reasoning_content || m.reasoning) blocks.unshift({ type: 'thinking', text: String(m.reasoning_content ?? m.reasoning) });
      for (const tc of m.tool_calls || []) {
        let input = tc.function?.arguments ?? '{}';
        try { input = JSON.parse(input); } catch { problems.push(`Tool call ${tc.id} arguments are not JSON`); }
        blocks.push({ type: 'tool_use', id: String(tc.id ?? ''), name: String(tc.function?.name ?? tc.type ?? '?'), input });
      }
      if (m.function_call) {
        let input = m.function_call.arguments ?? '{}';
        try { input = JSON.parse(input); } catch { /* keep text */ }
        blocks.push({ type: 'tool_use', id: String(m.function_call.name ?? ''), name: String(m.function_call.name ?? '?'), input });
      }
      const role = m.role === 'developer' ? 'system' : m.role;
      turns.push({ role, blocks, usage, model: m.model });
      return;
    }
    const blocks = anthropicBlocks(m.content);
    const onlyResults = blocks.length && blocks.every((b) => b.type === 'tool_result');
    turns.push({ role: m.role === 'user' && onlyResults ? 'tool' : m.role, blocks, usage, model: m.model });
  });
  return turns;
}

// ---------------- analysis ----------------
const CATS = ['system', 'user', 'assistant', 'toolCalls', 'toolResults'];

export function run(input) {
  const warnings = [], notes = [], problems = [];
  const big = num(input.bigResult) ?? 4000;
  const loopN = Math.max(2, Math.round(num(input.loopRepeat) ?? 3));
  const price = { in: num(input.priceIn), out: num(input.priceOut), cr: num(input.priceCacheRead), cw: num(input.priceCacheWrite) };

  let det = detect(input.trace);
  const forced = ['anthropic', 'openai', 'claude-code'].includes(input.format) ? input.format : null;
  if (forced && det.format !== forced && det.format !== 'empty' && det.format !== 'unknown') {
    if (forced === 'claude-code' && !det.rows) warnings.push('Format is set to Claude Code but the text is not a session JSONL; read as detected instead.');
    else if (forced !== 'claude-code' && det.list) det = { ...det, format: forced };
  }
  if (det.format === 'empty') return empty('Paste a transcript: Anthropic Messages JSON, OpenAI chat JSON, or a Claude Code session .jsonl.');
  if (det.format === 'unknown') return empty('Could not find messages: expected a JSON array of messages, an object with "messages", or JSONL with one message or Claude Code event per line.');
  if (det.bad?.length) warnings.push(`${det.bad.length} line(s) are not JSON and were skipped (line ${det.bad.slice(0, 5).join(', ')}${det.bad.length > 5 ? ', …' : ''}). A transcript cut mid-line loses that event.`);

  const turns = toTurns(det, problems);
  warnings.push(...problems.slice(0, 5));
  if (!turns.length) return empty('The transcript has no user, assistant or tool messages.');

  // Per turn: sizes by category, the calls it makes, the results it carries.
  const calls = [];             // {id, name, input, inputText, turn, result?}
  const byId = new Map();
  const orphanResults = [];
  const events = turns.map((t, i) => {
    const cat = Object.fromEntries(CATS.map((c) => [c, 0]));
    let thinking = 0;
    const blocks = t.blocks.map((b) => {
      let chars = 0, tok = 0;
      const out = { type: b.type };
      if (b.type === 'tool_use') {
        const txt = JSON.stringify(b.input);
        chars = txt.length + b.name.length; tok = est(chars);
        cat.toolCalls += tok;
        const call = { id: b.id, name: b.name, input: b.input, inputText: txt, turn: i, tok, result: null };
        calls.push(call);
        if (b.id) byId.set(b.id, call);
        Object.assign(out, { id: b.id, name: b.name, text: cut(JSON.stringify(b.input, null, 2), MAX_SHOW), call: calls.length - 1 });
      } else if (b.type === 'tool_result') {
        chars = b.text.length; tok = est(chars) + b.images * IMAGE_TOKENS;
        cat.toolResults += tok;
        const call = byId.get(b.id);
        if (call && !call.result) call.result = { turn: i, tok, chars, isError: b.isError };
        else orphanResults.push({ id: b.id, turn: i });
        Object.assign(out, { id: b.id, name: call?.name ?? '?', text: cut(b.text, MAX_SHOW), isError: b.isError, call: call ? calls.indexOf(call) : -1 });
      } else if (b.type === 'thinking') {
        chars = b.redacted ? b.chars : b.text.length; tok = est(chars);
        thinking += tok;
        out.text = cut(b.text, MAX_SHOW);
      } else {
        chars = b.type === 'image' ? 0 : String(b.text ?? '').length;
        tok = b.type === 'image' ? IMAGE_TOKENS : est(chars);
        cat[t.role === 'system' ? 'system' : t.role === 'assistant' ? 'assistant' : t.role === 'tool' ? 'toolResults' : 'user'] += tok;
        out.text = cut(String(b.text ?? ''), MAX_SHOW);
      }
      out.chars = chars; out.tok = tok;
      return out;
    });
    return { i, role: t.role, blocks, cat, thinking, usage: t.usage || null, ts: t.ts || null, model: t.model || null,
      side: !!t.side, meta: !!t.meta, compact: !!t.compact, line: t.line ?? null };
  });

  // Cumulative estimated context by category, before each turn is answered.
  const cum = Object.fromEntries(CATS.map((c) => [c, 0]));
  const series = events.map((e) => {
    for (const c of CATS) cum[c] += e.cat[c];
    if (e.compact) for (const c of CATS) cum[c] = 0;      // Claude Code compacted: the context starts again from the summary
    return { ...cum, total: CATS.reduce((s, c) => s + cum[c], 0) };
  });
  // Measured context: what the provider billed as input for each model call.
  const measured = events.map((e) => {
    const u = e.usage;
    if (!u || e.role !== 'assistant') return null;
    return u.openai ? (u.input ?? 0) : (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  });

  // Spikes: one turn adding at least `big` estimated tokens, or a measured jump of that size.
  // A big tool result shows up twice - as its own size, then as the jump in
  // the next call's measured input - so the jump is filed under the result.
  const spikes = [];
  let lastMeasured = null, open = null;
  events.forEach((e, i) => {
    const added = CATS.reduce((s, c) => s + e.cat[c], 0);
    const m = measured[i];
    const jump = m != null && lastMeasured != null ? m - lastMeasured : null;
    if (m != null) lastMeasured = m;
    if (jump != null && open) { open.jump = jump; open = null; if (added < big) return; }
    if (added >= big || (jump != null && jump >= big)) {
      const topBlock = [...e.blocks].sort((a, b) => b.tok - a.tok)[0];
      const sp = { turn: i, added, jump, what: topBlock?.type === 'tool_result' ? `${topBlock.name} result` : topBlock?.type === 'tool_use' ? `${topBlock.name} call` : `${e.role} ${topBlock?.type ?? ''}`.trim() };
      spikes.push(sp);
      if (m == null) open = sp;
    }
  });

  // Loops: the same tool with the same input again and again.
  const seen = new Map();
  for (const c of calls) {
    const k = `${c.name}\u0000${c.inputText}`;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(c.turn);
  }
  const loops = [...seen.entries()].filter(([, t]) => t.length >= loopN).map(([k, t]) => ({ name: k.split('\u0000')[0], input: k.split('\u0000')[1], turns: t }));

  // The first measured call against the estimate at that point: the part of
  // the context the trace does not show (system prompt, tool definitions).
  const firstM = measured.findIndex((v) => v != null);
  const hidden = firstM >= 0 ? Math.max(0, measured[firstM] - series[firstM].total) : 0;

  const pending = calls.filter((c) => !c.result);
  const errors = calls.filter((c) => c.result?.isError);
  const largest = calls.filter((c) => c.result).sort((a, b) => b.result.tok - a.result.tok);

  // Usage totals (assistant turns).
  const used = events.filter((e) => e.usage && e.role === 'assistant').map((e) => e.usage);
  const sum = (f) => used.reduce((s, u) => s + (f(u) ?? 0), 0);
  const tot = used.length ? {
    input: sum((u) => (u.openai ? (u.input ?? 0) - (u.cacheRead ?? 0) : u.input)), cacheRead: sum((u) => u.cacheRead), cacheWrite: sum((u) => u.cacheWrite),
    output: sum((u) => u.output), cost: used.some((u) => u.cost != null) ? sum((u) => u.cost) : null,
  } : null;
  let cost = tot?.cost ?? null, costBasis = cost != null ? 'from the trace' : '';
  if (tot && cost == null && price.in != null && price.out != null) {
    cost = (tot.input * price.in + tot.output * price.out + tot.cacheRead * (price.cr ?? price.in) + tot.cacheWrite * (price.cw ?? price.in)) / 1e6;
    costBasis = 'from the prices entered';
  }

  const counts = { user: 0, assistant: 0, tool: 0, system: 0 };
  for (const e of events) counts[e.role] = (counts[e.role] || 0) + 1;
  const models = [...new Set(events.map((e) => e.model).filter(Boolean))];
  const tsList = events.map((e) => Date.parse(e.ts)).filter(Number.isFinite);
  const duration = tsList.length > 1 ? (Math.max(...tsList) - Math.min(...tsList)) / 1000 : null;
  const peakMeasured = measured.reduce((m, v) => (v != null && v > m ? v : m), 0) || null;
  const lastM = [...measured].reverse().find((v) => v != null) ?? null;
  const peakEst = Math.max(...series.map((s) => s.total));

  // ---------- warnings ----------
  if (pending.length) warnings.push(`${pending.length} tool call(s) have no matching result (${pending.slice(0, 4).map((c) => `${c.name} in turn ${c.turn + 1}`).join(', ')}): the run was cut off, or the log lost the result. The API rejects a next request that leaves a tool_use without its tool_result.`);
  if (orphanResults.length) warnings.push(`${orphanResults.length} tool result(s) answer no earlier call (${orphanResults.slice(0, 3).map((r) => `turn ${r.turn + 1}`).join(', ')}): ids do not match, or the log starts mid-run.`);
  for (const l of loops.slice(0, 4)) warnings.push(`Possible loop: ${l.name} was called ${l.turns.length} times with the same input (turns ${l.turns.map((t) => t + 1).join(', ')}): ${l.input.slice(0, 90)}. The agent is repeating itself; the result did not change what it did.`);
  const huge = largest.filter((c) => c.result.tok >= big);
  if (huge.length) warnings.push(`${huge.length} tool result(s) are over ${big} estimated tokens (largest: ${huge[0].name} in turn ${huge[0].result.turn + 1}, ~${huge[0].result.tok}). Big results stay in the context for every later turn: page them (offset/limit, head/tail, grep) instead.`);
  if (errors.length) warnings.push(`${errors.length} tool call(s) returned an error (${[...new Set(errors.map((c) => c.name))].join(', ')}).`);
  if (tot && tot.cacheRead === 0 && used.length > 3 && !used[0].openai) warnings.push('No cache reads across the calls: prompt caching is off or the prefix changes every turn, so every call pays for the whole context again.');

  const values = [
    { label: 'Format', value: det.format, hint: det.format === 'claude-code' ? 'streamed assistant lines merged by message id' : '' },
    { label: 'Turns', value: events.length, hint: `${counts.user} user · ${counts.assistant} assistant · ${counts.tool} tool${counts.system ? ` · ${counts.system} system` : ''}` },
    { label: 'Tool calls', value: calls.length, hint: `${new Set(calls.map((c) => c.name)).size} tools`, tone: pending.length || loops.length ? 'warn' : undefined },
    { label: 'Tool errors', value: errors.length, tone: errors.length ? 'warn' : 'ok' },
  ];
  if (peakMeasured) values.push({ label: 'Peak context', value: peakMeasured, unit: 'tokens', hint: 'measured: input + cache read + cache write of one call' });
  else values.push({ label: 'Peak context (est.)', value: peakEst, unit: 'tokens', hint: `characters / ${CHARS_PER_TOKEN}; no usage in the trace` });
  if (hidden > 500) values.push({ label: 'Not in the trace', value: hidden, unit: 'tokens', hint: 'first call measured minus the estimate: system prompt and tool definitions' });
  if (lastM) values.push({ label: 'Final context', value: lastM, unit: 'tokens', hint: 'measured, last call' });
  if (tot) {
    values.push({ label: 'Output tokens', value: tot.output, unit: 'tokens' });
    const inAll = tot.input + tot.cacheRead + tot.cacheWrite;
    if (inAll) values.push({ label: 'Cache read share', value: Math.round((tot.cacheRead / inAll) * 1000) / 10, unit: '%', hint: `${tot.cacheRead} of ${inAll} input tokens`, tone: tot.cacheRead / inAll > 0.6 ? 'ok' : 'warn' });
  }
  if (cost != null) values.push({ label: 'Cost', value: Number(cost.toPrecision(3)), unit: 'USD', hint: costBasis });
  if (duration != null) values.push({ label: 'Duration', value: duration >= 120 ? `${Math.floor(duration / 60)} min ${Math.round(duration % 60)} s` : `${Math.round(duration)} s`, hint: 'first to last timestamp' });
  if (models.length) values.push({ label: 'Model', value: models.join(', ') });

  const byName = new Map();
  for (const c of calls) {
    const r = byName.get(c.name) || { calls: 0, errors: 0, tok: 0, max: 0, pending: 0 };
    r.calls++; if (c.result?.isError) r.errors++; if (!c.result) r.pending++;
    r.tok += c.result?.tok ?? 0; r.max = Math.max(r.max, c.result?.tok ?? 0);
    byName.set(c.name, r);
  }
  const shortInput = (c) => {
    const i = c.input || {};
    const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.query ?? i.url ?? Object.values(i)[0];
    return String(typeof v === 'string' ? v : JSON.stringify(v ?? '')).replace(/\s+/g, ' ').slice(0, 70);
  };
  const tables = [
    { title: 'Tool calls by name (result tokens estimated)', columns: ['tool', 'calls', 'errors', 'no result', 'result tokens', 'largest'],
      rows: [...byName.entries()].sort((a, b) => b[1].tok - a[1].tok).map(([n, r]) => [n, r.calls, r.errors, r.pending, r.tok, r.max]) },
    { title: 'Largest tool results', columns: ['turn', 'tool', 'input', 'tokens (est.)', 'error'],
      rows: largest.slice(0, 8).map((c) => [c.result.turn + 1, c.name, shortInput(c), c.result.tok, c.result.isError ? 'yes' : '']) },
  ];
  if (spikes.length) tables.push({ title: `Context spikes (a turn adding ${big}+ tokens)`, columns: ['turn', 'what', 'added (est.)', 'measured jump'],
    rows: spikes.slice(0, 10).map((s) => [s.turn + 1, s.what, s.added, s.jump ?? '-']) });
  if (tot) tables.push({ title: 'Usage totals (from the trace)', columns: ['input (uncached)', 'cache read', 'cache write', 'output', 'calls with usage'],
    rows: [[tot.input, tot.cacheRead, tot.cacheWrite, tot.output, used.length]] });

  const tsv = ['turn\ttool\tinput\tresult_tokens_est\terror', ...calls.map((c) => [c.turn + 1, c.name, c.inputText.replace(/\s+/g, ' ').slice(0, 200), c.result?.tok ?? '', c.result ? (c.result.isError ? 'error' : '') : 'no result'].join('\t'))].join('\n');

  notes.push(`Token counts marked "est." are characters / ${CHARS_PER_TOKEN} (images ~${IMAGE_TOKENS}); a real tokenizer differs by 10-30 %, more for non-English text. Numbers from usage fields are the provider's own.`,
    'The context area stacks what each kind of content adds (system, user, assistant text, tool calls, tool results); thinking is shown per turn but left out of the area, because Anthropic drops earlier turns\' thinking from the context.',
    'Cost is only shown when the trace has cost fields or all prices are entered; prices change - take them from the provider\'s pricing page.');

  return {
    values, tables,
    texts: [{ title: 'Tool calls TSV', body: tsv }],
    warnings, notes,
    trace: {
      format: det.format, events, series, measured, spikes, hidden,
      calls: calls.map((c) => ({ id: c.id, name: c.name, turn: c.turn, short: shortInput(c), tok: c.tok, result: c.result })),
      loops: loops.map((l) => ({ name: l.name, turns: l.turns })), big,
      tools: [...byName.entries()].map(([n, r]) => ({ name: n, calls: r.calls, errors: r.errors })),
    },
  };

  function empty(msg) {
    return { values: [{ label: 'Turns', value: 0, tone: 'bad' }], warnings: [...warnings, msg], notes: [],
      tables: [{ title: 'Tool calls by name', columns: ['tool', 'calls'], rows: [] }],
      trace: { format: det?.format ?? 'empty', events: [], series: [], measured: [], spikes: [], calls: [], loops: [], big, tools: [] } };
  }
}
