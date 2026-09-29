// Prompt Caching Planner: replay a trace of calls against a provider's
// prompt-caching rules and say what each prompt part costs.
//
// Model of a cache entry: its key is the exact text of every part before
// the boundary it ends at. A part's text is the same between two calls when
//   never     - always,
//   per day   - both calls fall on the same day,
//   per user  - both calls come from the same user,
//   per call  - never.
// So a volatile part early in the prompt changes the key of every boundary
// after it - the whole rest of the prompt misses (Anthropic docs "Prompt
// caching": the cache is a prefix; any change invalidates everything after it).
//
// Anthropic (docs "Prompt caching", as of 2026-09): up to 4 cache_control
//   breakpoints; the longest breakpoint prefix that is live is read (0.1x
//   input on most models, $0.20/MTok on Opus 5.5 and Sonnet 5.5, $0.25 on
//   Fable 5.1); the prefixes of later breakpoints are written (1.25x input for
//   the 5-minute TTL, 2x for 1 hour); a read refreshes the entry's TTL; a
//   breakpoint whose prefix is under the model's minimum is not cached.
// OpenAI ("Prompt caching" guide): automatic for prompts >= 1024 tokens; the
//   cached part is the longest recently seen prefix, counted from 1024 tokens
//   in 128-token steps; no write fee; kept 5-10 min idle (24 h "extended"
//   retention on some models). Modelled at part boundaries.
// Gemini ("Context caching"): an explicit cache holds the prefix up to one
//   boundary (the last breakpoint here) for its TTL - reads do not extend it;
//   creating it bills the tokens as input once, reads bill the cached rate,
//   and the cache is billed for storage per MTok per hour for its whole TTL.

import { parseEng, fmtNum } from '../kit/eng.js';

export const AS_OF = '2026-09';
// $ per million tokens. Anthropic from the Claude API reference cached
// 2026-09-25; OpenAI and Google remembered at build time - unverified.
export const MODELS = {
  'claude-opus-5-5': { prov: 'anthropic', name: 'Claude Opus 5.5', in: 4, cr: 0.2, min: 512 },
  'claude-sonnet-5-5': { prov: 'anthropic', name: 'Claude Sonnet 5.5', in: 2, cr: 0.2, min: 512 },
  'claude-haiku-4-5': { prov: 'anthropic', name: 'Claude Haiku 4.5', in: 1, cr: 0.1, min: 4096 },
  'claude-fable-5-1': { prov: 'anthropic', name: 'Claude Fable 5.1', in: 10, cr: 0.25, min: 512 },
  'claude-sonnet-4-6': { prov: 'anthropic', name: 'Claude Sonnet 4.6', in: 3, cr: 0.3, min: 1024 },
  'gpt-5': { prov: 'openai', name: 'GPT-5', in: 1.25, cr: 0.125, min: 1024 },
  'gpt-5-mini': { prov: 'openai', name: 'GPT-5 mini', in: 0.25, cr: 0.025, min: 1024 },
  'gemini-2.5-pro': { prov: 'google', name: 'Gemini 2.5 Pro', in: 1.25, cr: 0.125, storage: 4.5, min: 4096 },
  'gemini-2.5-flash': { prov: 'google', name: 'Gemini 2.5 Flash', in: 0.3, cr: 0.03, storage: 1, min: 1024 },
};
const RANK = { never: 0, 'per day': 1, 'per user': 2, 'per call': 3 };
const MAX_BP = 4;
const TTL_MIN = { '5m': 5, '1h': 60, '24h': 1440 };
const VOLATILE_NAME = /(time\s*stamp|timestamp|date|time|now|clock|uuid|guid|request[\s_-]*id|session[\s_-]*id|trace[\s_-]*id|nonce|random|seed)/i;

export const money = (v) => {
  if (!Number.isFinite(v)) return '$0';
  if (v < 0) return `-${money(-v)}`;
  const a = Math.abs(v);
  if (a >= 1e4) return `$${Math.round(v).toLocaleString('en-US')}`;
  if (a >= 100) return `$${v.toFixed(0)}`;
  if (a >= 1) return `$${v.toFixed(2)}`;
  if (a >= 0.001) return `$${v.toFixed(4)}`;
  return a === 0 ? '$0' : `$${v.toPrecision(2)}`;
};
const int = (v) => Math.round(v).toLocaleString('en-US');

export function parseParts(rows, warnings) {
  const parts = [];
  (Array.isArray(rows) ? rows : []).forEach((r, i) => {
    const name = String(r?.name ?? '').trim() || `Part ${i + 1}`;
    const tok = parseEng(String(r?.tokens ?? '').replace(/[,_\s]/g, ''));
    let changes = String(r?.changes ?? 'never').trim().toLowerCase();
    if (!(changes in RANK)) { warnings.push(`"${name}": changes "${r?.changes}" is not one of never, per day, per user, per call - "per call" is assumed.`); changes = 'per call'; }
    if (tok == null || tok < 0) { warnings.push(`"${name}": tokens "${r?.tokens ?? ''}" is not a number - the part is left out.`); return; }
    parts.push({ name, tokens: Math.round(tok), changes, bp: /^(y|yes|true|1)$/i.test(String(r?.bp ?? '').trim()), row: i });
  });
  return parts;
}

export function parseCalls(text, warnings) {
  const calls = [];
  const bad = [];
  String(text ?? '').split(/\r?\n/).forEach((line, i) => {
    const s = line.replace(/#.*/, '').trim();
    if (!s) return;
    const m = /^(-?\d+(?:\.\d+)?)\s*(?:min|m)?[\s,;:]*([\w.@-]*)$/i.exec(s);
    if (!m || Number(m[1]) < 0) { bad.push(i + 1); return; }
    calls.push({ t: Number(m[1]), user: m[2] || 'A', line: i + 1 });
  });
  if (bad.length) warnings.push(`Call trace: line${bad.length > 1 ? 's' : ''} ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? '…' : ''} could not be read - write "minute user", e.g. "12.5 B".`);
  calls.sort((a, b) => a.t - b.t || a.line - b.line);
  return calls;
}

function version(p, c, k) {
  if (p.changes === 'never') return 'n';
  if (p.changes === 'per day') return `d${Math.floor(c.t / 1440)}`;
  if (p.changes === 'per user') return `u${c.user}`;
  return `c${k}`;
}

/** Replays `calls` over `parts`; returns per-call results, entry lifetimes and totals. */
export function simulate(parts, model, ttlMin, calls) {
  const M = model;
  const n = parts.length;
  const cum = []; let acc = 0;
  for (const p of parts) { acc += p.tokens; cum.push(acc); }
  const total = acc;
  const cwMul = ttlMin >= 60 ? 2 : 1.25;
  const entries = new Map(); // key -> {exp, seg}
  const segs = [];           // drawing: {b, user, from, to, reads, writes}
  const bps = parts.map((p, i) => (p.bp ? i : -1)).filter((i) => i >= 0).slice(0, MAX_BP);
  const valid = bps.filter((b) => cum[b] >= M.min);
  const gemB = valid.length ? valid[valid.length - 1] : -1;
  const out = [];
  let storageTotal = 0;

  const touch = (b, key, t, user, kind, refresh) => {
    let e = entries.get(key);
    if (!e || e.exp <= t) {
      const seg = { b, user, from: t, to: t + ttlMin, reads: [], writes: [t] };
      segs.push(seg);
      e = { exp: t + ttlMin, seg };
      entries.set(key, e);
      return 'write';
    }
    if (refresh) { e.exp = t + ttlMin; e.seg.to = e.exp; }
    if (kind === 'read') e.seg.reads.push(t);
    return 'read';
  };

  calls.forEach((c, k) => {
    const keys = []; let key = '';
    parts.forEach((p, i) => { key += `${i}:${version(p, c, k)}|`; keys.push(key); });
    const perUser = (b) => parts.slice(0, b + 1).some((p) => p.changes === 'per user');
    let read = 0, write = 0, storage = 0;
    if (M.prov === 'anthropic') {
      let hit = -1;
      for (const b of valid) { const e = entries.get(keys[b]); if (e && e.exp > c.t) hit = b; }
      read = hit >= 0 ? cum[hit] : 0;
      for (const b of valid) {
        if (b <= hit) { const e = entries.get(keys[b]); if (e && e.exp > c.t) { e.exp = c.t + ttlMin; e.seg.to = e.exp; if (b === hit) e.seg.reads.push(c.t); } }
        else touch(b, keys[b], c.t, perUser(b) ? c.user : '', 'write', true);
      }
      const last = valid.filter((b) => b > hit).pop();
      write = last != null ? cum[last] - read : 0;
    } else if (M.prov === 'openai') {
      let hit = -1;
      if (total >= 1024) for (let j = 0; j < n; j++) { const e = entries.get(keys[j]); if (e && e.exp > c.t) hit = j; }
      const matched = hit >= 0 ? cum[hit] : 0;
      read = matched >= 1024 ? 1024 + Math.floor((matched - 1024) / 128) * 128 : 0;
      if (total >= 1024) {
        for (let j = 0; j < n; j++) {
          if (parts.slice(0, j + 1).some((p) => p.changes === 'per call')) continue; // never reusable: not drawn
          const e = entries.get(keys[j]);
          if (e && e.exp > c.t) { e.exp = c.t + ttlMin; e.seg.to = e.exp; if (j === hit) e.seg.reads.push(c.t); }
          else if (cum[j] >= 1024) touch(j, keys[j], c.t, perUser(j) ? c.user : '', 'write', true);
        }
        // Entries past a per-call part still exist in the provider's cache but
        // are never matched again; they are not tracked.
      }
    } else {
      if (gemB >= 0) {
        const r = touch(gemB, keys[gemB], c.t, perUser(gemB) ? c.user : '', 'read', false);
        if (r === 'read') read = cum[gemB];
        else { write = cum[gemB]; storage = (cum[gemB] / 1e6) * M.storage * (ttlMin / 60); storageTotal += storage; }
      }
    }
    const plain = total - read - write;
    const wPrice = M.prov === 'anthropic' ? M.in * cwMul : M.in;
    const cost = (plain * M.in + write * wPrice + read * M.cr) / 1e6 + storage;
    const base = (total * M.in) / 1e6;
    const layers = parts.map((p, i) => {
      const lo = i ? cum[i - 1] : 0;
      if (cum[i] <= read) return 'r';
      if (lo < read) return 'r'; // OpenAI: a part partly inside the 128-token-rounded prefix
      if (cum[i] <= read + write) return 'w';
      return 'p';
    });
    out.push({ t: c.t, user: c.user, line: c.line, read, write, plain, cost, base, storage, layers });
  });
  const sum = (k) => out.reduce((a, o) => a + o[k], 0);
  const N = out.length || 1;
  return {
    cum, total, calls: out, segs, bps, valid, gemB, cwMul,
    avgCost: sum('cost') / N, avgBase: sum('base') / N, readShare: total ? sum('read') / (total * N) : 0,
    hitRate: out.length ? out.filter((o) => o.read > 0).length / out.length : 0, storage: storageTotal,
    layerStats: parts.map((p, i) => ({ r: out.filter((o) => o.layers[i] === 'r').length / N, w: out.filter((o) => o.layers[i] === 'w').length / N })),
  };
}

/** Stable to volatile; a breakpoint after the last part of each reusable group. */
export function suggest(parts, model) {
  const sorted = parts.map((p, i) => ({ ...p, i })).sort((a, b) => RANK[a.changes] - RANK[b.changes] || a.i - b.i);
  let acc = 0; let n = 0;
  const cum = sorted.map((p) => (acc += p.tokens));
  return sorted.map((p, j) => {
    const next = sorted[j + 1];
    const end = RANK[p.changes] < 3 && (!next || RANK[next.changes] !== RANK[p.changes]);
    const bp = end && cum[j] >= model.min && n < MAX_BP;
    if (bp) n++;
    return { name: p.name, tokens: p.tokens, changes: p.changes, bp };
  });
}

function skeleton(parts, model, modelId, ttl) {
  const cc = (p, k) => (p.bp && k < MAX_BP ? { cache_control: ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' } } : {});
  let k = 0;
  const tools = [], system = [], content = [];
  let inMessages = false;
  for (const p of parts) {
    const mark = cc(p, k); if (p.bp) k++;
    const label = `<${p.name}: ~${p.tokens} tokens, changes ${p.changes}>`;
    if (/\btools?\b|function/i.test(p.name) && !inMessages) {
      tools.push({ name: 'example_tool', description: label, input_schema: { type: 'object', properties: {} }, ...mark });
      continue;
    }
    if (!inMessages && (p.changes === 'per user' || p.changes === 'per call')) inMessages = true;
    (inMessages ? content : system).push({ type: 'text', text: label, ...mark });
  }
  const body = { model: model.prov === 'anthropic' ? modelId : 'claude-sonnet-5-5', max_tokens: 1024 };
  if (tools.length) body.tools = tools;
  if (system.length) body.system = system;
  body.messages = [{ role: 'user', content: content.length ? content : [{ type: 'text', text: '<user message>' }] }];
  return JSON.stringify(body, null, 2);
}

export function run(input) {
  const warnings = [];
  const notes = [];
  const modelId = String(input.model || 'claude-sonnet-5-5');
  const M = MODELS[modelId] || MODELS['claude-sonnet-5-5'];
  if (!MODELS[modelId]) warnings.push(`Unknown model "${modelId}" - Claude Sonnet 5.5 is used.`);
  let ttl = String(input.ttl || '5m');
  if (!(ttl in TTL_MIN)) { warnings.push(`TTL "${ttl}" is not 5m, 1h or 24h - 5m is used.`); ttl = '5m'; }
  if (M.prov === 'anthropic' && ttl === '24h') { warnings.push('Anthropic offers 5-minute and 1-hour cache lifetimes only; 1h is used.'); ttl = '1h'; }
  if (M.prov === 'openai' && ttl === '1h') { notes.push('OpenAI has no 1-hour setting: in-memory entries live 5-10 minutes idle (up to an hour off-peak). Modelled as 5 minutes.'); ttl = '5m'; }
  const ttlMin = TTL_MIN[ttl];
  const parts = parseParts(input.parts, warnings);
  const calls = parseCalls(input.calls, warnings);
  let perDay = parseEng(input.calls_day); if (perDay == null || perDay < 0) { warnings.push('Calls per day is not a number; 0 is used.'); perDay = 0; }
  let days = parseEng(input.days); if (!(days > 0)) days = 30;
  if (!parts.length) warnings.push('No prompt parts could be read: add rows with a name and a token count.');
  if (!calls.length) warnings.push('The call trace is empty: add lines like "0 A", "3.5 B".');

  const sim = simulate(parts, M, ttlMin, calls);
  const { cum, total } = sim;

  // ---- lint ----
  const flags = parts.map(() => []); // per part: messages drawn on the layer
  const flagBp = parts.map(() => []);
  parts.forEach((p, i) => {
    const later = parts.slice(i + 1).find((q) => RANK[q.changes] < RANK[p.changes]);
    if (later) {
      const lost = total - cum[i];
      const why = p.changes === 'per call' ? `its text changes on every call, so the ${int(lost)} tokens after it can never be read from cache`
        : p.changes === 'per user' ? `its text differs per user, so the ${int(lost)} tokens after it are cached once per user instead of once for everyone`
          : `its text changes every day, so the ${int(lost)} tokens after it are re-written daily`;
      const msg = `"${p.name}" (${p.changes}) sits above "${later.name}" (${later.changes}): ${why}. Move it below the more stable parts.`;
      warnings.push(msg); flags[i].push(`breaks the prefix for ${int(lost)} tokens below`);
    }
    if (VOLATILE_NAME.test(p.name) && p.changes !== 'per call' && p.changes !== 'per day') {
      warnings.push(`"${p.name}" is named like a timestamp or ID but marked "${p.changes}". If its text changes per request it breaks the prefix at position ${i + 1}; put it after the last breakpoint.`);
      flags[i].push('looks like a timestamp/ID');
    }
  });
  const bpAll = parts.map((p, i) => (p.bp ? i : -1)).filter((i) => i >= 0);
  if (M.prov === 'anthropic') {
    if (bpAll.length > MAX_BP) { warnings.push(`${bpAll.length} breakpoints: Anthropic allows at most ${MAX_BP} cache_control markers per request (a 400 error); only the first ${MAX_BP} are used here.`); bpAll.slice(MAX_BP).forEach((b) => flagBp[b].push('over the 4-breakpoint limit')); }
    if (!bpAll.length && parts.length) warnings.push('No breakpoint: without cache_control nothing is cached. Add one after the last stable part, or use the top-level automatic cache_control.');
  }
  if (M.prov === 'google' && bpAll.length > 1) notes.push('Gemini holds one explicit cache per request: the last breakpoint that meets the minimum is used as its boundary.');
  if (M.prov === 'google' && !bpAll.length && parts.length) warnings.push('No breakpoint: an explicit Gemini cache needs a boundary - mark the last stable part. (Implicit caching on Gemini 2.5 may still discount repeated prefixes, without a guarantee.)');
  if (M.prov === 'openai' && bpAll.length) notes.push('OpenAI caches automatically: the breakpoints are ignored for the replay; only the order of the parts matters.');
  for (const b of bpAll.slice(0, MAX_BP)) {
    if (M.prov !== 'openai' && cum[b] < M.min) {
      warnings.push(`The breakpoint after "${parts[b].name}" covers ${int(cum[b])} tokens, under ${M.name}'s minimum of ${int(M.min)}: it silently does not cache. Move it lower or drop it.`);
      flagBp[b].push(`under the ${int(M.min)}-token minimum`);
    }
    if (parts.slice(0, b + 1).some((p) => p.changes === 'per call') && M.prov !== 'openai') {
      const cost = M.prov === 'anthropic' ? `written every call at ${sim.cwMul}x input` : 're-created every call, with storage';
      warnings.push(`The breakpoint after "${parts[b].name}" includes a per-call part above it, so its prefix is never the same twice: it is ${cost} and never read.`);
      flagBp[b].push('never read: a per-call part is above it');
    }
  }
  if (M.prov === 'openai' && total < 1024) warnings.push(`The prompt is ${int(total)} tokens: OpenAI caches only prompts of 1024 tokens or more.`);

  // Gaps longer than the TTL between calls that could share a prefix.
  if (calls.length > 1 && M.prov !== 'google') {
    const gaps = calls.slice(1).map((c, i) => c.t - calls[i].t);
    const long = gaps.filter((g) => g > ttlMin).length;
    if (long && ttl === '5m' && long / gaps.length > 0.25) notes.push(`${long} of ${gaps.length} gaps between calls are longer than 5 minutes: each one lets the shared prefix expire. ${M.prov === 'anthropic' ? 'A 1-hour TTL (2x write) or a keep-alive request may pay off - try 1h.' : ''}`);
  }

  // ---- suggestion ----
  const sug = suggest(parts, M);
  const simS = simulate(sug, M, ttlMin, calls);
  const same = sug.every((p, i) => parts[i] && p.name === parts[i].name && p.bp === parts[i].bp);
  const month = (v) => v * perDay * days;
  const better = !same && simS.avgCost < sim.avgCost * 0.995;
  if (better) warnings.unshift(`Ordered stable to volatile with breakpoints at each group's end, the same trace costs ${money(simS.avgCost)} per call instead of ${money(sim.avgCost)} - ${money(month(sim.avgCost - simS.avgCost))} a month less at ${int(perDay)} calls a day.`);

  const saving = sim.avgBase - sim.avgCost;
  const values = [
    { label: 'Per call, with caching', value: money(sim.avgCost), hint: `${money(sim.avgBase)} without` , tone: saving > 0 ? 'ok' : saving < 0 ? 'bad' : undefined },
    { label: 'Saving per call', value: sim.avgBase > 0 ? `${Math.round((saving / sim.avgBase) * 100)} %` : '0 %', tone: saving > 0 ? 'ok' : saving < 0 ? 'bad' : undefined },
    { label: 'Saving per month', value: money(month(saving)), hint: `at ${int(perDay)} calls/day, ${days} days`, tone: saving > 0 ? 'ok' : saving < 0 ? 'bad' : undefined },
    { label: 'Calls with a cache hit', value: `${Math.round(sim.hitRate * 100)} %`, hint: `${calls.length} calls in the trace` },
    { label: 'Input tokens from cache', value: `${Math.round(sim.readShare * 100)} %`, hint: `prompt ${int(total)} tokens` },
  ];
  if (M.prov === 'google') values.push({ label: 'Cache storage in the trace', value: money(sim.storage), hint: `${M.storage} $/MTok/h, TTL ${ttl}` });
  if (better) values.push({ label: 'Suggested order, per call', value: money(simS.avgCost), hint: `${money(month(sim.avgCost - simS.avgCost))}/month less`, tone: 'warn' });
  values.forEach((v) => { if (v.tone === undefined) delete v.tone; });

  const tables = [
    { title: `Parts on ${M.name} (${ttl} TTL): share of calls each part was read from cache, written, or sent uncached`, columns: ['#', 'Part', 'Tokens', 'Changes', 'Prefix tokens', 'Breakpoint', 'Read %', 'Written %', 'Uncached %'],
      rows: parts.map((p, i) => [i + 1, p.name, p.tokens, p.changes, cum[i], p.bp ? (M.prov === 'openai' ? 'ignored' : cum[i] < M.min ? 'under min' : 'yes') : '', Math.round(sim.layerStats[i].r * 100), Math.round(sim.layerStats[i].w * 100), Math.round((1 - sim.layerStats[i].r - sim.layerStats[i].w) * 100)]) },
    { title: 'Calls', columns: ['Minute', 'User', 'Read tokens', 'Written tokens', 'Uncached tokens', 'Cost $', 'Without cache $'],
      rows: sim.calls.slice(0, 60).map((c) => [c.t, c.user, c.read, c.write, c.plain, Number(c.cost.toPrecision(3)), Number(c.base.toPrecision(3))]) },
  ];

  const layout = [
    `Prompt layout for ${M.name} (${ttl} cache), ${int(total)} tokens:`,
    ...parts.map((p, i) => `${String(i + 1).padStart(2)}. ${p.name} - ${int(p.tokens)} tok, changes ${p.changes}, prefix ${int(cum[i])}${p.bp ? '  <-- cache breakpoint' : ''}${flags[i].length ? `  [${flags[i].join('; ')}]` : ''}`),
    '',
    better ? 'Suggested order (stable to volatile):' : 'The order is already stable to volatile.',
    ...(better ? sug.map((p, i) => `${String(i + 1).padStart(2)}. ${p.name} - ${int(p.tokens)} tok, ${p.changes}${p.bp ? '  <-- cache breakpoint' : ''}`) : []),
  ].join('\n') + '\n';

  notes.push(`Rules and prices as of ${AS_OF}: ${M.prov === 'anthropic' ? 'Anthropic numbers from the Claude API reference of 2026-09-25' : 'this provider\'s numbers were entered from memory and are unverified'} - check the provider's prompt-caching page. Token counts are what you enter.`);
  notes.push('The replay sees only the trace: a busier real day keeps entries warmer than a sparse trace suggests. Hits are counted at part boundaries.');
  if (M.prov === 'anthropic') notes.push('Verify in production with usage.cache_read_input_tokens and cache_creation_input_tokens: zero reads across repeated calls means something in the prefix still changes (a timestamp, unsorted JSON, a varying tool list).');

  const trace = {
    prov: M.prov, model: modelId, modelName: M.name, min: M.min, ttl, ttlMin, total, cum, perDay, days,
    parts: parts.map((p, i) => ({ ...p, flags: flags[i], bpFlags: flagBp[i], stat: sim.layerStats[i], valid: sim.valid.includes(i) || (M.prov === 'google' && i === sim.gemB) })),
    calls: sim.calls.map((c) => ({ t: c.t, user: c.user, line: c.line, read: c.read, write: c.write, plain: c.plain, cost: c.cost, base: c.base, layers: c.layers.join('') })),
    segs: sim.segs.map((s) => ({ b: s.b, user: s.user, from: s.from, to: s.to, reads: s.reads.length, writes: s.writes.length })),
    gemB: sim.gemB, avgCost: sim.avgCost, avgBase: sim.avgBase, hitRate: sim.hitRate, readShare: sim.readShare,
    monthSave: month(saving), suggested: better ? sug : null, sugCost: simS.avgCost, sugMonth: month(sim.avgCost - simS.avgCost),
  };
  return { values, tables, texts: [{ title: 'Layout', body: layout }, { title: 'Anthropic JSON', body: skeleton(parts, M, modelId, ttl) + '\n', lang: 'json' }], warnings, notes, trace };
}

export { fmtNum };
