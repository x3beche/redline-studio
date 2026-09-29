// Fine-tune Dataset Validator: a chat-format JSONL training set checked line
// by line (JSON, roles, turns, tool calls, empty content), then as a set
// (exact and near duplicates, contradicting answers, system prompt drift,
// train/validation overlap, token lengths, label balance), and written back
// out cleaned. Pure: no DOM, no clock, no randomness.
//
// Format rules, as documented by the providers (as of 2026-09; verify):
//   OpenAI supervised fine-tuning, chat format: one JSON object per line with
//     "messages" (roles system/developer/user/assistant/tool), optional
//     "tools" and "parallel_tool_calls"; assistant messages may carry
//     "tool_calls" [{id, type:"function", function:{name, arguments: JSON
//     string}}] and "weight" 0 or 1; tool messages answer a tool_call_id.
//     At least 10 examples are required; 50-100 are recommended to start.
//   Anthropic-style (Claude fine-tuning on Amazon Bedrock): {"system"?,
//     "messages": [...]} with user/assistant only, alternating, starting
//     with user and ending with assistant.
//   Legacy completions: {"prompt", "completion"}.
// Near duplicates: Broder 1997 ("On the resemblance and containment of
// documents") - word 3-gram shingles, MinHash signatures with LSH banding
// to find candidates, then the exact Jaccard similarity of the shingle sets.
// Tokens: an estimate (about 4 characters per token for English, digits in
// groups of up to 3, punctuation one each, plus 3 tokens per message and 3
// for the reply - the overhead in OpenAI's cookbook for its chat models). It
// is not a real tokenizer: expect +-20 %.

export const LIMITS_ASOF = '2026-09';
export const OPENAI_MIN_EXAMPLES = 10;
export const OPENAI_RECOMMENDED = 50;

const OA_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);
const OA_MSG_KEYS = new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'function_call', 'weight', 'refusal']);
const OA_TOP_KEYS = new Set(['messages', 'tools', 'parallel_tool_calls', 'functions']);

// ---------------- helpers ----------------
function fnv(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
const norm = (t) => String(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Text of a content field: a string, or an array of parts {type:"text", text}. */
export function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? String(p.text ?? '') : '')).join('\n');
  return '';
}

/** Estimated tokens of one text. */
export function estTokens(text) {
  const t = String(text ?? '');
  let n = 0;
  for (const m of t.matchAll(/[A-Za-zÀ-ɏ]+|\d+|[^\sA-Za-z\dÀ-ɏ]/g)) {
    const s = m[0];
    if (/^\d/.test(s)) n += Math.ceil(s.length / 3);
    else if (/^[A-Za-zÀ-ɏ]/.test(s)) n += Math.max(1, Math.round(s.length / 4.2));
    else n += 1;
  }
  return n;
}

function shingles(text) {
  const w = norm(text).replace(/[^\p{L}\p{N} ]+/gu, ' ').split(' ').filter(Boolean);
  const out = new Set();
  if (w.length < 3) { for (const x of w) out.add(x); return out; }
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}
const PERMS = 64, BANDS = 16, ROWS = 4;
const SEEDS = Array.from({ length: PERMS }, (_, i) => fnv(`perm-${i}`));
function minhash(set) {
  const sig = new Array(PERMS).fill(0xffffffff);
  for (const s of set) for (let i = 0; i < PERMS; i++) { const v = fnv(s, SEEDS[i]); if (v < sig[i]) sig[i] = v; }
  return sig;
}
function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  const [x, y] = a.size < b.size ? [a, b] : [b, a];
  for (const v of x) if (y.has(v)) inter++;
  return inter / (a.size + b.size - inter);
}
/** Pairs [i, j, J] with Jaccard >= th among the items' shingle sets. */
function nearPairs(sets, th, crossWith = null) {
  const sigs = sets.map(minhash);
  const other = crossWith ? crossWith.map(minhash) : null;
  const pairs = new Map();
  for (let b = 0; b < BANDS; b++) {
    const buckets = new Map();
    const key = (sig) => sig.slice(b * ROWS, b * ROWS + ROWS).join(',');
    sigs.forEach((sig, i) => { const k = key(sig); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(['a', i]); });
    if (other) other.forEach((sig, i) => { const k = key(sig); if (buckets.has(k)) buckets.get(k).push(['b', i]); });
    for (const list of buckets.values()) {
      if (list.length < 2 || list.length > 400) continue;
      for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
        const [p, q] = [list[x], list[y]];
        if (other ? !(p[0] === 'a' && q[0] === 'b') : false) continue;
        const k = `${p[1]}:${q[1]}`;
        if (pairs.has(k)) continue;
        const J = jaccard(sets[p[1]], other ? crossWith[q[1]] : sets[q[1]]);
        pairs.set(k, J);
      }
    }
  }
  return [...pairs.entries()].filter(([, J]) => J >= th).map(([k, J]) => { const [i, j] = k.split(':').map(Number); return [i, j, J]; });
}

function getPath(obj, path) {
  let cur = obj;
  for (const k of path.split('.').filter(Boolean)) { if (cur == null || typeof cur !== 'object') return undefined; cur = cur[k]; }
  return cur;
}

// ---------------- one line ----------------
function detect(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'unknown';
  if (Array.isArray(obj.messages)) return typeof obj.system === 'string' && obj.messages.every((m) => m && (m.role === 'user' || m.role === 'assistant')) ? 'anthropic' : 'openai-chat';
  if ('prompt' in obj || 'completion' in obj) return 'prompt-completion';
  return 'unknown';
}

function checkLine(obj, fmt) {
  const issues = [];
  const E = (code, msg, mi) => issues.push({ sev: 'error', code, msg, ...(mi != null ? { mi } : {}) });
  const W = (code, msg, mi) => issues.push({ sev: 'warn', code, msg, ...(mi != null ? { mi } : {}) });
  let msgs = [];
  let system = '';
  if (fmt === 'prompt-completion') {
    for (const k of ['prompt', 'completion']) {
      if (typeof obj[k] !== 'string') E('missing-field', `"${k}" must be a string`);
      else if (!obj[k].trim()) E('empty-content', `"${k}" is empty`);
    }
    for (const k of Object.keys(obj)) if (k !== 'prompt' && k !== 'completion') W('unknown-key', `unexpected key "${k}"`);
    msgs = [{ role: 'user', content: String(obj.prompt ?? '') }, { role: 'assistant', content: String(obj.completion ?? '') }];
    return { issues, msgs, system };
  }
  if (!Array.isArray(obj.messages)) { E('no-messages', '"messages" is missing or not an array'); return { issues, msgs, system }; }
  if (!obj.messages.length) { E('no-messages', '"messages" is empty'); return { issues, msgs, system }; }
  if (fmt === 'anthropic') {
    if (obj.system != null && typeof obj.system !== 'string') E('bad-system', '"system" must be a string');
    system = typeof obj.system === 'string' ? obj.system : '';
    for (const k of Object.keys(obj)) if (k !== 'system' && k !== 'messages') W('unknown-key', `unexpected top-level key "${k}"`);
  } else {
    for (const k of Object.keys(obj)) if (!OA_TOP_KEYS.has(k)) W('unknown-key', `unexpected top-level key "${k}" (OpenAI accepts messages, tools, parallel_tool_calls)`);
  }
  const toolNames = Array.isArray(obj.tools) ? new Set(obj.tools.map((t) => t?.function?.name).filter(Boolean)) : null;
  const callIds = new Set();
  let prevRole = '', sawAssistant = false, sawNonSystem = false, sysCount = 0;
  obj.messages.forEach((m, i) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) { E('bad-message', `message ${i + 1} is not an object`, i); msgs.push({ role: '?', content: '' }); return; }
    const role = m.role;
    const text = contentText(m.content);
    msgs.push({ role: String(role ?? '?'), content: text, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id, weight: m.weight });
    for (const k of Object.keys(m)) if (!OA_MSG_KEYS.has(k)) E('unknown-key', `message ${i + 1}: unknown key "${k}"${k === 'text' || k === 'message' ? ' (the field is called "content")' : ''}`, i);
    if (fmt === 'anthropic') {
      if (role !== 'user' && role !== 'assistant') E('bad-role', `message ${i + 1}: role "${role}" - this format allows user and assistant only${role === 'system' ? ' (put the system prompt in the top-level "system")' : ''}`, i);
    } else if (!OA_ROLES.has(role)) E('bad-role', `message ${i + 1}: role "${role}" is not one of system, developer, user, assistant, tool`, i);
    if (role === 'system' || role === 'developer') {
      sysCount++;
      if (sawNonSystem) W('system-not-first', `message ${i + 1}: a ${role} message after the conversation started`, i);
      if (!system) system = text;
    } else sawNonSystem = true;
    if (role === 'user' || role === 'assistant' || role === 'system') {
      const hasCalls = role === 'assistant' && (Array.isArray(m.tool_calls) || m.function_call);
      if (m.content == null && !hasCalls) E('empty-content', `message ${i + 1} (${role}) has no content`, i);
      else if (m.content != null && typeof m.content !== 'string' && !Array.isArray(m.content)) E('bad-content', `message ${i + 1}: content must be a string or an array of parts`, i);
      else if (!text.trim() && !hasCalls) E('empty-content', `message ${i + 1} (${role}) is empty`, i);
    }
    if (role === 'assistant') {
      sawAssistant = true;
      if (m.weight != null && m.weight !== 0 && m.weight !== 1) E('bad-weight', `message ${i + 1}: weight must be 0 or 1`, i);
      if (m.tool_calls != null) {
        if (!Array.isArray(m.tool_calls)) E('bad-tool-call', `message ${i + 1}: tool_calls must be an array`, i);
        else m.tool_calls.forEach((c, k) => {
          const where = `message ${i + 1} tool call ${k + 1}`;
          if (!c || typeof c !== 'object') { E('bad-tool-call', `${where} is not an object`, i); return; }
          if (typeof c.id !== 'string' || !c.id) E('bad-tool-call', `${where}: missing "id"`, i); else callIds.add(c.id);
          if (c.type !== 'function') E('bad-tool-call', `${where}: "type" must be "function"`, i);
          const f = c.function;
          if (!f || typeof f.name !== 'string') E('bad-tool-call', `${where}: missing function.name`, i);
          else if (toolNames && !toolNames.has(f.name)) W('unknown-tool', `${where}: "${f.name}" is not in this example's tools`, i);
          if (f && typeof f.arguments !== 'string') E('bad-tool-call', `${where}: function.arguments must be a JSON string, not ${Array.isArray(f.arguments) ? 'an array' : typeof f.arguments}`, i);
          else if (f) { try { JSON.parse(f.arguments); } catch { E('bad-tool-call', `${where}: function.arguments is not valid JSON`, i); } }
        });
      }
    }
    if (role === 'tool') {
      if (prevRole !== 'assistant' && prevRole !== 'tool') E('tool-order', `message ${i + 1}: a tool result must follow the assistant message that called it`, i);
      if (typeof m.tool_call_id !== 'string') E('tool-order', `message ${i + 1}: tool message without tool_call_id`, i);
      else if (!callIds.has(m.tool_call_id)) E('tool-order', `message ${i + 1}: tool_call_id "${m.tool_call_id}" matches no earlier tool call`, i);
    }
    const nonSys = role !== 'system' && role !== 'developer';
    if (nonSys && prevRole && prevRole === role && role !== 'tool') (fmt === 'anthropic' ? E : W)('role-order', `message ${i + 1}: two ${role} messages in a row${fmt === 'anthropic' ? ' - this format requires alternation' : ''}`, i);
    if (nonSys && !prevRole && role !== 'user') (fmt === 'anthropic' ? E : W)('role-order', `message ${i + 1}: the conversation starts with ${role}, not user`, i);
    if (nonSys) prevRole = role;
  });
  if (sysCount > 1) W('system-many', `${sysCount} system messages in one example`);
  if (!sawAssistant) E('no-assistant', 'no assistant message: nothing to train on');
  else if (msgs.length && msgs[msgs.length - 1].role !== 'assistant') (fmt === 'anthropic' ? E : W)('last-not-assistant', `the example ends with ${msgs[msgs.length - 1].role}, not an assistant answer${fmt === 'anthropic' ? '' : ' - trailing turns are not learned'}`);
  return { issues, msgs, system };
}

function parseSet(text, fmtWanted) {
  const lines = String(text ?? '').split(/\r?\n/);
  const ex = [];
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    let obj = null, err = '';
    try { obj = JSON.parse(raw); } catch (e) {
      const t = raw.trim();
      err = /,\s*[\]}]/.test(t) ? 'a trailing comma before ] or }' : !/^[{[]/.test(t) ? 'the line does not start with {' : /[}\]]\s*[{[]/.test(t) ? 'two JSON objects on one line' : /[^\\]'/.test(t) && !/"/.test(t) ? "single quotes instead of double quotes" : String(e.message || e).replace(/,\s*".*$/s, '').slice(0, 80);
    }
    ex.push({ line: i + 1, raw, obj, err });
  });
  let fmt = fmtWanted;
  if (!['openai-chat', 'anthropic', 'prompt-completion'].includes(fmt)) {
    const votes = {};
    for (const e of ex.slice(0, 200)) if (e.obj) { const d = detect(e.obj); votes[d] = (votes[d] || 0) + 1; }
    delete votes.unknown;
    fmt = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] || 'openai-chat';
  }
  for (const e of ex) {
    if (!e.obj) { e.issues = [{ sev: 'error', code: 'bad-json', msg: `not valid JSON: ${clip(e.err, 90)}` }]; e.msgs = []; e.system = ''; continue; }
    if (typeof e.obj !== 'object' || Array.isArray(e.obj)) { e.issues = [{ sev: 'error', code: 'bad-json', msg: 'the line is JSON but not an object' }]; e.msgs = []; e.system = ''; continue; }
    const d = detect(e.obj);
    const r = checkLine(e.obj, fmt);
    if (d !== 'unknown' && d !== fmt && !(fmt !== 'prompt-completion' && d !== 'prompt-completion')) r.issues.unshift({ sev: 'error', code: 'mixed-format', msg: `this line is ${d}, the file is ${fmt}` });
    Object.assign(e, r);
    e.tokens = e.msgs.reduce((a, m) => a + 3 + estTokens(m.content) + (m.tool_calls ? estTokens(JSON.stringify(m.tool_calls)) : 0), 3) + (e.system && fmt === 'anthropic' ? 3 + estTokens(e.system) : 0);
  }
  for (const e of ex) {
    e.tokens = e.tokens || 0;
    e.convo = e.msgs.filter((m) => m.role !== 'system' && m.role !== 'developer').map((m) => `${m.role}: ${m.content}`).join('\n');
    e.prompt = e.msgs.filter((m) => m.role !== 'system' && m.role !== 'developer').slice(0, -1).map((m) => `${m.role}: ${m.content}`).join('\n');
    const lastA = [...e.msgs].reverse().find((m) => m.role === 'assistant');
    e.answer = lastA ? lastA.content : '';
    e.hash = e.obj ? fnv(`${norm(e.system)}\u0001${norm(e.convo)}`) : 0;
  }
  return { ex, fmt };
}

function labelOf(e, field) {
  const f = String(field ?? '').trim();
  if (!f || !e.obj) return null;
  if (f === 'assistant') return e.answer ? clip(e.answer.trim(), 40) : null;
  const m = /^assistant:json\.(.+)$/.exec(f);
  if (m) {
    try { const v = getPath(JSON.parse(e.answer), m[1]); return v == null || typeof v === 'object' ? null : String(v); } catch { return null; }
  }
  const v = getPath(e.obj, f);
  return v == null || typeof v === 'object' ? null : String(v);
}

// ---------------- run ----------------
const RANK = { error: 5, dup: 4, long: 3, near: 2, warn: 1, ok: 0 };

export function run(input) {
  const warnings = [], notes = [];
  const fmtIn = String(input.format || 'auto');
  const maxTok = Number.isFinite(input.maxTokens) && input.maxTokens > 0 ? Math.round(input.maxTokens) : 4096;
  let th = Number.isFinite(input.nearThreshold) ? input.nearThreshold : 0.7;
  if (th <= 0 || th > 1) { warnings.push(`Near-duplicate threshold ${th} is outside (0, 1]; using 0.7.`); th = 0.7; }
  const { ex, fmt } = parseSet(input.train, fmtIn);
  const val = parseSet(input.valid, fmt);
  if (!ex.length) {
    return { values: [{ label: 'Examples', value: 0 }], warnings: ['No training lines. Paste JSONL, one example per line, or drop a .jsonl file on the page.'], notes, texts: [{ title: 'Report', body: 'No training data.' }], draw: { ex: [], val: [], fmt, maxTok, hist: [], labels: [], issues: [], th } };
  }

  // Exact duplicates and contradicting answers.
  const byHash = new Map();
  for (const e of ex) if (e.obj && e.msgs.length) { if (!byHash.has(e.hash)) byHash.set(e.hash, []); byHash.get(e.hash).push(e); }
  for (const list of byHash.values()) for (const e of list.slice(1)) { e.dupOf = list[0].line; e.issues.push({ sev: 'dup', code: 'duplicate', msg: `exact duplicate of line ${list[0].line}`, ref: list[0].line }); }
  const byPrompt = new Map();
  for (const e of ex) if (e.obj && e.prompt && !e.dupOf) { const k = fnv(`${norm(e.system)}\u0001${norm(e.prompt)}`); if (!byPrompt.has(k)) byPrompt.set(k, []); byPrompt.get(k).push(e); }
  for (const list of byPrompt.values()) {
    const answers = new Set(list.map((e) => norm(e.answer)));
    if (list.length > 1 && answers.size > 1) for (const e of list) e.issues.push({ sev: 'warn', code: 'contradiction', msg: `same prompt, different answer than line ${list.find((x) => x !== e).line}${list.length > 2 ? ` (and ${list.length - 2} more)` : ''}`, ref: list.find((x) => x !== e).line });
  }
  // Near duplicates (not already exact).
  const live = ex.filter((e) => e.obj && e.msgs.length);
  const sets = live.map((e) => shingles(`${e.convo}`));
  const pairs = nearPairs(sets, th);
  for (const [i, j, J] of pairs) {
    const a = live[i], b = live[j];
    if (a.hash === b.hash) continue;
    const [first, second] = a.line < b.line ? [a, b] : [b, a];
    if (norm(first.prompt) === norm(second.prompt) && norm(first.system) === norm(second.system)) continue; // already a contradiction
    if (!second.nearOf) { second.nearOf = first.line; second.issues.push({ sev: 'near', code: 'near-duplicate', msg: `${Math.round(J * 100)} % the same as line ${first.line}`, ref: first.line }); }
  }
  // System prompt drift.
  const sysCount = new Map();
  for (const e of live) sysCount.set(norm(e.system), (sysCount.get(norm(e.system)) || 0) + 1);
  const [mainSys, mainN] = [...sysCount.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
  if (sysCount.size > 1 && mainN / live.length >= 0.6) {
    const mainSet = shingles(mainSys);
    for (const e of live) if (norm(e.system) !== mainSys) {
      const J = jaccard(shingles(e.system), mainSet);
      e.issues.push({ sev: 'warn', code: 'system-drift', msg: e.system ? `system prompt differs from the one in ${mainN} examples (${Math.round(J * 100)} % similar)` : `no system prompt, while ${mainN} examples have one` });
    }
  }
  // Length.
  for (const e of ex) if (e.tokens > maxTok) e.issues.push({ sev: 'long', code: 'too-long', msg: `about ${e.tokens} tokens, over the ${maxTok} limit` });
  // Labels.
  const lf = String(input.labelField ?? '').trim();
  const labelCounts = new Map();
  let unlabelled = 0;
  if (lf) for (const e of live.filter((x) => !x.issues.some((i) => i.sev === 'error'))) {
    e.label = labelOf(e, lf);
    if (e.label == null) { unlabelled++; e.issues.push({ sev: 'warn', code: 'no-label', msg: `no label at "${lf}"` }); } else labelCounts.set(e.label, (labelCounts.get(e.label) || 0) + 1);
  }
  // Status per example.
  for (const e of ex) {
    let st = 'ok';
    for (const i of e.issues) {
      const r = i.sev === 'error' ? 'error' : i.sev === 'dup' ? 'dup' : i.sev === 'long' ? 'long' : i.sev === 'near' ? 'near' : 'warn';
      if (RANK[r] > RANK[st]) st = r;
    }
    e.status = st;
  }

  // Validation set: its own errors, and overlap with training.
  for (const v of val.ex) {
    const hit = byHash.get(v.hash);
    if (v.obj && hit) v.issues.push({ sev: 'dup', code: 'train-overlap', msg: `identical to training line ${hit[0].line}`, ref: hit[0].line });
  }
  const vlive = val.ex.filter((v) => v.obj && v.msgs.length && !v.issues.some((i) => i.code === 'train-overlap'));
  if (vlive.length && live.length) {
    const vsets = vlive.map((v) => shingles(v.convo));
    for (const [ti, vi, J] of nearPairs(sets, th, vsets)) {
      const v = vlive[vi];
      if (!v.issues.some((i) => i.code === 'train-near')) v.issues.push({ sev: 'near', code: 'train-near', msg: `${Math.round(J * 100)} % the same as training line ${live[ti].line}`, ref: live[ti].line });
    }
  }
  for (const v of val.ex) {
    let st = 'ok';
    for (const i of v.issues) { const r = i.sev === 'error' ? 'error' : i.sev === 'dup' ? 'dup' : i.sev === 'near' ? 'near' : i.sev === 'long' ? 'long' : 'warn'; if (RANK[r] > RANK[st]) st = r; }
    v.status = st;
  }

  // Dataset-level findings.
  const nValid = ex.filter((e) => e.status !== 'error').length;
  if (fmt === 'openai-chat' && nValid < OPENAI_MIN_EXAMPLES) warnings.push(`Only ${nValid} usable examples; OpenAI requires at least ${OPENAI_MIN_EXAMPLES} (as of ${LIMITS_ASOF}; verify). Add examples before uploading.`);
  else if (nValid < OPENAI_RECOMMENDED) notes.push(`${nValid} usable examples. OpenAI suggests starting with ${OPENAI_RECOMMENDED}-100 well-made ones (as of ${LIMITS_ASOF}; verify).`);
  const errN = ex.filter((e) => e.status === 'error').length;
  if (errN) warnings.push(`${errN} line${errN > 1 ? 's' : ''} would be rejected by the provider's validator (bad JSON, roles, missing answer, tool call format). Fix them, or clean them out with "Drop invalid".`);
  const dupN = ex.filter((e) => e.dupOf).length, nearN = ex.filter((e) => e.nearOf && !e.dupOf).length;
  if (dupN) warnings.push(`${dupN} exact duplicate${dupN > 1 ? 's' : ''}: they overweight those examples. Drop them.`);
  const contra = ex.filter((e) => e.issues.some((i) => i.code === 'contradiction')).length;
  if (contra) warnings.push(`${contra} examples give different answers to the same prompt; the model learns the disagreement. Decide which answer is right.`);
  const vOver = val.ex.filter((v) => v.issues.some((i) => i.code === 'train-overlap' || i.code === 'train-near')).length;
  if (vOver) warnings.push(`${vOver} validation example${vOver > 1 ? 's' : ''} also appear (or nearly) in training, so validation loss will look better than it is.`);
  const longN = ex.filter((e) => e.tokens > maxTok).length;
  if (longN) warnings.push(`${longN} example${longN > 1 ? 's are' : ' is'} over ${maxTok} tokens (estimated); providers truncate or reject examples over the model's training context.`);
  const labels = [...labelCounts.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label, n }));
  if (labels.length > 1) {
    const max = labels[0].n, min = labels[labels.length - 1].n, tot = labels.reduce((a, b) => a + b.n, 0);
    const rare = labels.filter((l) => l.n / tot < 0.05);
    if (max / min >= 10 || rare.length) warnings.push(`Labels are unbalanced: ${labels.map((l) => `${l.label} ${l.n}`).join(', ')}. ${rare.length ? `${rare.map((l) => l.label).join(', ')} under 5 % - ` : ''}the model will under-predict the rare classes; add examples of them.`);
    else if (max / min >= 3) notes.push(`Label spread ${max}:${min} between the most and least common (${labels[0].label} / ${labels[labels.length - 1].label}).`);
  }
  if (lf && unlabelled) notes.push(`${unlabelled} example${unlabelled > 1 ? 's have' : ' has'} no label at "${lf}" (for assistant:json.key the answer must be JSON).`);
  if (fmt === 'openai-chat' && sysCount.size > 1 && mainN / live.length < 0.6) notes.push(`${sysCount.size} different system prompts, none in most examples. That is fine for a mixed-task set; otherwise pick one and use it everywhere, and use the same one at inference.`);
  notes.push(`Format: ${fmt}${fmtIn === 'auto' ? ' (detected)' : ''}. Token counts are estimates (±20 %), not a tokenizer's.`);
  notes.push(`Provider rules as of ${LIMITS_ASOF}; check the provider's fine-tuning guide before uploading.`);

  // Cleaning.
  const drop = (e) => (input.dropInvalid !== false && e.status === 'error') || (input.dropDuplicates !== false && e.dupOf)
    || (input.dropNear === true && e.nearOf && !e.dupOf) || (input.dropOverLength !== false && e.tokens > maxTok);
  const kept = ex.filter((e) => !drop(e));
  const vdrop = (v) => (input.dropInvalid !== false && v.status === 'error') || (input.dropValidOverlap !== false && v.issues.some((i) => i.code === 'train-overlap' || (input.dropNear === true && i.code === 'train-near')));
  const vkept = val.ex.filter((v) => !vdrop(v));
  const cleaned = kept.map((e) => JSON.stringify(e.obj)).join('\n');
  const vcleaned = vkept.map((v) => JSON.stringify(v.obj)).join('\n');

  // Issue summary.
  const issueMap = new Map();
  for (const [set, name] of [[ex, 'train'], [val.ex, 'valid']]) for (const e of set) for (const i of e.issues) {
    const k = `${name}:${i.code}`;
    if (!issueMap.has(k)) issueMap.set(k, { set: name, code: i.code, sev: i.sev, lines: [], sample: i.msg });
    const it = issueMap.get(k);
    if (!it.lines.includes(e.line)) it.lines.push(e.line);
  }
  const SEVR = { error: 4, dup: 3, long: 2, near: 1, warn: 0 };
  const issues = [...issueMap.values()].sort((a, b) => SEVR[b.sev] - SEVR[a.sev] || b.lines.length - a.lines.length);

  // Token histogram (bins across 0..max(maxTok*1.25, longest)).
  const toks = live.map((e) => e.tokens);
  const sorted = [...toks].sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
  // The axis runs to a little past the limit or the p95, whichever is
  // larger; longer examples collect in the last bin.
  const top = Math.max(maxTok * 1.3, pct(0.95) * 1.2, 16);
  const NB = 24, bw = top / NB;
  const hist = Array.from({ length: NB }, (_, b) => ({ from: Math.round(b * bw), to: Math.round((b + 1) * bw), n: 0 }));
  for (const t of toks) { const b = Math.min(NB - 1, Math.floor(t / bw)); hist[b].n++; if (t >= top) hist[b].rest = true; }
  const totalTok = toks.reduce((a, b) => a + b, 0);

  const report = [
    `Fine-tune dataset check (${fmt})`,
    `Training: ${ex.length} lines, ${errN} invalid, ${dupN} duplicate, ${nearN} near-duplicate, ${longN} over ${maxTok} tokens -> ${kept.length} kept.`,
    `Validation: ${val.ex.length} lines, ${vOver} overlapping training -> ${vkept.length} kept.`,
    `Tokens (estimated): ${totalTok} total, median ${pct(0.5)}, p95 ${pct(0.95)}, max ${sorted[sorted.length - 1] || 0} per example.`,
    labels.length ? `Labels (${lf}): ${labels.map((l) => `${l.label} ${l.n}`).join(', ')}` : '',
    '',
    'Issues:',
    ...issues.map((i) => `- [${i.set}] ${i.code} (${i.sev}) x${i.lines.length}: lines ${i.lines.slice(0, 12).join(', ')}${i.lines.length > 12 ? ', ...' : ''} - e.g. ${i.sample}`),
    '',
    ...warnings.map((w) => `! ${w}`),
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');

  const lineRows = [...ex.map((e) => ['train', e]), ...val.ex.map((v) => ['valid', v])].filter(([, e]) => e.issues.length).slice(0, 60)
    .map(([set, e]) => [set, e.line, e.status, e.issues.map((i) => i.msg).join('; ')]);

  const slim = (e) => ({
    line: e.line, status: e.status, tokens: e.tokens, label: e.label ?? null, issues: e.issues, dropped: false,
    preview: clip((e.msgs.find((m) => m.role === 'user')?.content || e.raw || '').replace(/\s+/g, ' '), 90),
    system: e.system ? clip(e.system, 400) : '',
    msgs: e.msgs.map((m) => ({ role: m.role, content: clip(m.content, 1500), calls: Array.isArray(m.tool_calls) ? clip(JSON.stringify(m.tool_calls), 400) : '', weight: m.weight ?? null, id: m.tool_call_id || '' })),
    raw: e.obj ? '' : clip(e.raw, 400),
  });
  const dex = ex.map((e) => ({ ...slim(e), dropped: drop(e) }));
  const dval = val.ex.map((v) => ({ ...slim(v), dropped: vdrop(v) }));

  return {
    values: [
      { label: 'Training examples', value: ex.length, hint: `${fmt}${fmtIn === 'auto' ? ', detected' : ''}` },
      { label: 'Would be rejected', value: errN, tone: errN ? 'bad' : 'ok' },
      { label: 'Duplicates / near', value: `${dupN} / ${nearN}`, tone: dupN ? 'warn' : 'ok' },
      { label: `Over ${maxTok} tokens`, value: longN, tone: longN ? 'warn' : 'ok' },
      { label: 'Tokens, estimated', value: totalTok, hint: `median ${pct(0.5)} · p95 ${pct(0.95)} per example` },
      { label: 'Validation overlap', value: `${vOver} of ${val.ex.length}`, tone: vOver ? 'warn' : 'ok' },
      { label: 'Kept after cleaning', value: `${kept.length} + ${vkept.length} valid` },
    ],
    tables: [
      { title: 'Issues by kind', columns: ['set', 'issue', 'severity', 'count', 'lines', 'example'], rows: issues.map((i) => [i.set, i.code, i.sev, i.lines.length, `${i.lines.slice(0, 10).join(', ')}${i.lines.length > 10 ? ', ...' : ''}`, clip(i.sample, 90)]) },
      { title: `Lines with issues${lineRows.length === 60 ? ' (first 60)' : ''}`, columns: ['set', 'line', 'status', 'issues'], rows: lineRows },
      ...(labels.length ? [{ title: `Label balance (${lf})`, columns: ['label', 'examples', 'share %'], rows: labels.map((l) => [l.label, l.n, Number(((l.n / labels.reduce((a, b) => a + b.n, 0)) * 100).toFixed(1))]) }] : []),
    ],
    texts: [
      { title: 'Report', body: report },
      { title: 'Cleaned train JSONL', body: cleaned },
      ...(val.ex.length ? [{ title: 'Cleaned validation JSONL', body: vcleaned }] : []),
    ],
    warnings, notes,
    draw: { ex: dex, val: dval, fmt, maxTok, hist, labels, issues: issues.map((i) => ({ ...i, lines: i.lines })), th, kept: kept.length, vkept: vkept.length, totalTok, p50: pct(0.5), p95: pct(0.95) },
  };
}
