// Prompt Eval Grid: test cases (rows) against prompt variants (columns),
// each answer scored by rules and optionally an LLM judge.
// Pure: no DOM, no fetch, no clock. It never calls a model - the page does,
// and hands the answers back in as the `answers` input (JSONL); an agent can
// do the same with answers it got elsewhere. Given no answers it still
// builds the grid, the exact messages each cell would send, and checks the
// set-up (placeholders, check syntax, regexes, schemas).

// ---------------- parsing ----------------
const nl = (s) => String(s ?? '').replace(/\r\n?/g, '\n');

/** Blocks that start with `### name` lines; text before the first is `pre`. */
function blocks(text) {
  const lines = nl(text).split('\n');
  const out = [];
  let cur = null;
  const pre = [];
  lines.forEach((l, i) => {
    const m = /^###\s+(.*?)\s*$/.exec(l);
    if (m) { cur = { head: m[1], start: i, end: i + 1, lines: [] }; out.push(cur); return; }
    if (cur) { cur.lines.push(l); cur.end = i + 1; } else pre.push(l);
  });
  return { list: out, pre: pre.join('\n').trim() };
}
const slugId = (s, i, pfx) => (String(s).trim().split(/\s+/)[0] || `${pfx}${i + 1}`).replace(/[^\w.\-]/g, '').slice(0, 40) || `${pfx}${i + 1}`;

/**
 * Variants: `### name`, then the prompt. A line of three dashes splits a
 * system prompt (above) from the user message (below); without it the whole
 * block is the user message. {{input}} is replaced by the case's input,
 * {{expected}} by its expected answer.
 */
export function parseVariants(text) {
  const b = blocks(text);
  return b.list.map((blk, i) => {
    const body = blk.lines.join('\n');
    const cut = blk.lines.findIndex((l) => /^---\s*$/.test(l));
    const system = cut >= 0 ? blk.lines.slice(0, cut).join('\n').trim() : '';
    const user = (cut >= 0 ? blk.lines.slice(cut + 1).join('\n') : body).trim();
    return { id: slugId(blk.head, i, 'v'), name: blk.head || `v${i + 1}`, system, user, start: blk.start, end: blk.end };
  });
}

/**
 * Cases: `### id optional title`, then the input text. Lines starting with
 * `expected:` and `check:` anywhere in the block are taken out of the input.
 */
export function parseCases(text) {
  const b = blocks(text);
  return b.list.map((blk, i) => {
    const input = [], checks = [];
    let expected = null;
    for (const l of blk.lines) {
      const e = /^expected:\s?(.*)$/i.exec(l);
      const c = /^check:\s*(.+)$/i.exec(l);
      if (e) expected = e[1].trim();
      else if (c) checks.push(c[1].trim());
      else input.push(l);
    }
    let inp = input.join('\n').trim().replace(/^input:\s?/i, '');
    const id = slugId(blk.head, i, 'c');
    return { id, title: blk.head.slice(id.length).trim(), input: inp, expected, checks, start: blk.start, end: blk.end };
  });
}

const KINDS = {
  contains: 'answer contains the text (case-insensitive)',
  not_contains: 'answer does not contain the text (case-insensitive)',
  starts_with: 'answer starts with the text (after trimming, case-insensitive)',
  regex: 'answer matches the regular expression (/pattern/flags or a bare pattern)',
  not_regex: 'answer does not match the regular expression',
  json: 'answer is valid JSON (one ```json fence around it is allowed)',
  schema: 'answer is JSON that fits a JSON Schema subset: type, required, properties, additionalProperties:false, enum, const, items, minItems, maxItems, minLength, maxLength, pattern, minimum, maximum',
  max_chars: 'answer is at most N characters',
  max_words: 'answer is at most N words',
  equals_expected: 'answer equals the case\'s expected text (trimmed, case and runs of spaces ignored)',
  contains_expected: 'answer contains the case\'s expected text (case-insensitive)',
  judge: 'the judge scores the answer at least N of 5 (default: the judge pass mark)',
};
const ALIASES = { equals: 'equals_expected', expected: 'contains_expected', max_len: 'max_chars', maxlen: 'max_chars', valid_json: 'json', not_contain: 'not_contains', contain: 'contains' };

/** One check line: `kind: argument` or a bare kind. */
export function parseCheck(line) {
  const m = /^\s*([a-z_]+)\s*(?::\s*([\s\S]*))?$/i.exec(line);
  if (!m) return { kind: '?', arg: line, error: `"${line}" is not "kind: argument"` };
  const kind = ALIASES[m[1].toLowerCase()] || m[1].toLowerCase();
  const arg = (m[2] ?? '').trim();
  if (!KINDS[kind]) return { kind, arg, error: `unknown check "${m[1]}"; one of ${Object.keys(KINDS).join(', ')}` };
  const c = { kind, arg, label: arg ? `${kind}: ${arg.length > 40 ? arg.slice(0, 39) + '…' : arg}` : kind };
  if (kind === 'regex' || kind === 'not_regex') {
    try { c.re = toRegex(arg); } catch (e) { c.error = `bad regex ${arg}: ${e.message}`; }
  }
  if (kind === 'schema') {
    try { c.schema = JSON.parse(arg); } catch (e) { c.error = `schema is not JSON: ${e.message}`; }
  }
  if ((kind === 'max_chars' || kind === 'max_words') && !(Number(arg) > 0)) c.error = `${kind} needs a positive number`;
  if (kind === 'judge' && arg && !(Number(arg) >= 1 && Number(arg) <= 5)) c.error = 'judge takes a pass mark from 1 to 5';
  if (['contains', 'not_contains', 'starts_with'].includes(kind) && !arg) c.error = `${kind} needs a text`;
  return c;
}
function toRegex(arg) {
  const m = /^\/([\s\S]*)\/([dgimsuy]*)$/.exec(arg);
  return m ? new RegExp(m[1], m[2].replace('g', '')) : new RegExp(arg);
}

/** JSON from an answer: the whole text, or the inside of one ``` fence. */
export function extractJson(text) {
  const t = String(text ?? '').trim();
  const f = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(t);
  const body = f ? f[1].trim() : t;
  try { return { ok: true, value: JSON.parse(body), fenced: !!f }; } catch (e) { return { ok: false, error: e.message }; }
}

/** A JSON Schema subset (draft 2020-12 keywords listed in KINDS.schema). Returns the first problems. */
export function schemaErrors(v, s, path = '$', out = []) {
  if (out.length >= 5 || !s || typeof s !== 'object') return out;
  const typeOf = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : Number.isInteger(x) ? 'integer' : typeof x);
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const t = typeOf(v);
    if (!types.some((ty) => ty === t || (ty === 'number' && t === 'integer'))) { out.push(`${path} is ${t}, not ${types.join('|')}`); return out; }
  }
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) out.push(`${path} = ${JSON.stringify(v)} is not one of ${JSON.stringify(s.enum)}`);
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(v)) out.push(`${path} is not ${JSON.stringify(s.const)}`);
  if (typeof v === 'string') {
    if (s.minLength != null && v.length < s.minLength) out.push(`${path} is shorter than ${s.minLength}`);
    if (s.maxLength != null && v.length > s.maxLength) out.push(`${path} is longer than ${s.maxLength}`);
    if (s.pattern) { try { if (!new RegExp(s.pattern, 'u').test(v)) out.push(`${path} does not match ${s.pattern}`); } catch { out.push(`bad pattern ${s.pattern}`); } }
  }
  if (typeof v === 'number') {
    if (s.minimum != null && v < s.minimum) out.push(`${path} = ${v} < ${s.minimum}`);
    if (s.maximum != null && v > s.maximum) out.push(`${path} = ${v} > ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems != null && v.length < s.minItems) out.push(`${path} has fewer than ${s.minItems} items`);
    if (s.maxItems != null && v.length > s.maxItems) out.push(`${path} has more than ${s.maxItems} items`);
    if (s.items) v.forEach((x, i) => schemaErrors(x, s.items, `${path}[${i}]`, out));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const r of s.required || []) if (!(r in v)) out.push(`${path}.${r} is missing`);
    for (const [k, sub] of Object.entries(s.properties || {})) if (k in v) schemaErrors(v[k], sub, `${path}.${k}`, out);
    if (s.additionalProperties === false) {
      const extra = Object.keys(v).filter((k) => !(k in (s.properties || {})));
      if (extra.length) out.push(`${path} has extra key(s) ${extra.join(', ')}`);
    }
  }
  return out;
}

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** One check on one answer: {pass: true|false|null, detail}. null = cannot tell yet. */
export function runCheck(c, answer, kase, judge, judgePass) {
  if (c.error) return { pass: null, detail: c.error };
  const a = String(answer ?? '');
  const low = a.toLowerCase();
  switch (c.kind) {
    case 'contains': return { pass: low.includes(c.arg.toLowerCase()), detail: low.includes(c.arg.toLowerCase()) ? 'found' : `"${c.arg}" not in the answer` };
    case 'not_contains': { const i = low.indexOf(c.arg.toLowerCase()); return { pass: i < 0, detail: i < 0 ? 'absent' : `found at character ${i}` }; }
    case 'starts_with': return { pass: low.trim().startsWith(c.arg.toLowerCase()), detail: `starts "${a.trim().slice(0, 24)}"` };
    case 'regex': { const m = c.re.exec(a); return { pass: !!m, detail: m ? `matched "${m[0].slice(0, 40)}"` : 'no match' }; }
    case 'not_regex': { const m = c.re.exec(a); return { pass: !m, detail: m ? `matched "${m[0].slice(0, 40)}"` : 'no match' }; }
    case 'json': { const j = extractJson(a); return { pass: j.ok, detail: j.ok ? (j.fenced ? 'valid (inside a ``` fence)' : 'valid') : j.error }; }
    case 'schema': {
      const j = extractJson(a);
      if (!j.ok) return { pass: false, detail: `not JSON: ${j.error}` };
      const errs = schemaErrors(j.value, c.schema);
      return { pass: !errs.length, detail: errs.length ? errs.join('; ') : 'fits the schema' };
    }
    case 'max_chars': return { pass: a.length <= Number(c.arg), detail: `${a.length} characters` };
    case 'max_words': { const w = a.trim() ? a.trim().split(/\s+/).length : 0; return { pass: w <= Number(c.arg), detail: `${w} words` }; }
    case 'equals_expected':
      if (kase.expected == null) return { pass: null, detail: 'the case has no expected: line' };
      return { pass: norm(a) === norm(kase.expected), detail: norm(a) === norm(kase.expected) ? 'equal' : `expected "${kase.expected}"` };
    case 'contains_expected':
      if (kase.expected == null) return { pass: null, detail: 'the case has no expected: line' };
      return { pass: low.includes(kase.expected.toLowerCase()), detail: low.includes(kase.expected.toLowerCase()) ? 'found' : `"${kase.expected}" not in the answer` };
    case 'judge': {
      const mark = Number(c.arg) || judgePass;
      if (!judge || judge.score == null) return { pass: null, detail: judge?.error || 'not judged yet' };
      return { pass: judge.score >= mark, detail: `${judge.score}/5 (pass at ${mark})${judge.reason ? `: ${judge.reason}` : ''}` };
    }
    default: return { pass: null, detail: 'unknown' };
  }
}

/** The text that goes to the model for one cell. */
export function fill(template, kase) {
  return String(template).replace(/\{\{\s*input\s*\}\}/g, kase.input).replace(/\{\{\s*expected\s*\}\}/g, kase.expected ?? '');
}
export function messagesFor(v, kase) {
  const m = [];
  if (v.system) m.push({ role: 'system', content: fill(v.system, kase) });
  m.push({ role: 'user', content: fill(v.user, kase) });
  return m;
}

/** FNV-1a 32-bit of a string, hex: marks an answer made from a prompt that has since changed. */
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** The judge's messages: the rubric, the case, the answer; the judge must reply with JSON. */
export function judgeMessages(rubric, kase, answer) {
  return [
    { role: 'system', content: 'You grade one answer produced by another model. Apply the rubric strictly and literally. '
      + 'Reply with JSON only, no fence: {"score": <integer 1-5>, "reason": "<one sentence>"}. 5 = fully meets the rubric, 1 = fails it.' },
    { role: 'user', content: `Rubric:\n${rubric.trim()}\n\nTask input:\n${kase.input}\n`
      + (kase.expected != null ? `\nReference answer:\n${kase.expected}\n` : '') + `\nAnswer to grade:\n${answer}` },
  ];
}
/** The judge's score from its reply: a JSON object, or failing that "score: N" / "N/5". */
export function parseJudge(text) {
  const t = String(text ?? '');
  const j = extractJson(t.replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
  if (j.ok && j.value && Number.isFinite(Number(j.value.score))) {
    const s = Math.round(Number(j.value.score));
    if (s >= 1 && s <= 5) return { score: s, reason: String(j.value.reason ?? '').slice(0, 300) };
  }
  const m = /score"?\s*[:=]\s*([1-5])\b/i.exec(t) || /\b([1-5])\s*\/\s*5\b/.exec(t);
  if (m) return { score: Number(m[1]), reason: t.slice(0, 300) };
  return { score: null, error: `judge reply has no 1-5 score: "${t.slice(0, 80)}"` };
}

/** Answers JSONL: {variant, case, text, ms?, prompt_tokens?, completion_tokens?, cost?, model?, error?, hash?, judge_text?|judge?}. */
export function parseAnswers(text) {
  const map = new Map(), problems = [];
  nl(text).split('\n').forEach((l, i) => {
    const t = l.trim();
    if (!t) return;
    let o;
    try { o = JSON.parse(t); } catch { problems.push(`Answers line ${i + 1} is not JSON`); return; }
    if (!o || typeof o !== 'object' || o.variant == null || o.case == null) { problems.push(`Answers line ${i + 1} needs "variant" and "case"`); return; }
    map.set(`${o.variant}\u0000${o.case}`, o);
  });
  return { map, problems };
}

// ---------------- run ----------------
const n = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

export function run(input) {
  const warnings = [], notes = [];
  const variants = parseVariants(input.variants);
  const cases = parseCases(input.cases);
  const judgePass = Math.min(5, Math.max(1, Math.round(n(input.judgePass) ?? 4)));
  const rubric = String(input.judge ?? '').trim();
  const global = nl(input.checks).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(parseCheck);
  if (rubric && !global.some((c) => c.kind === 'judge')) global.push(parseCheck('judge'));
  const { map: answers, problems } = parseAnswers(input.answers);
  warnings.push(...problems.slice(0, 5));

  if (!variants.length) warnings.push('No prompt variants: start each with a line "### name", then the prompt with {{input}} where the case goes.');
  if (!cases.length) warnings.push('No test cases: start each with a line "### id", then the input; optional "expected:" and "check:" lines.');
  const dup = (list, what) => {
    const seen = new Set();
    for (const x of list) { if (seen.has(x.id)) warnings.push(`Two ${what} are called "${x.id}"; answers for them mix. Rename one.`); seen.add(x.id); }
  };
  dup(variants, 'variants'); dup(cases, 'cases');
  for (const v of variants) {
    if (!/\{\{\s*input\s*\}\}/.test(v.system + v.user)) warnings.push(`Variant "${v.name}" has no {{input}}: every case sends the same prompt.`);
    if (!v.user) warnings.push(`Variant "${v.name}" has no user message (nothing below ---).`);
  }
  for (const c of global) if (c.error) warnings.push(`Check "${c.kind}": ${c.error}`);
  const caseChecks = cases.map((k) => k.checks.map(parseCheck));
  caseChecks.forEach((cs, i) => cs.forEach((c) => { if (c.error) warnings.push(`Case ${cases[i].id}, check "${c.kind}": ${c.error}`); }));
  if (global.some((c) => c.kind === 'judge') && !rubric) warnings.push('A judge check is listed but the judge rubric is empty; it cannot pass.');
  if (!global.length && caseChecks.every((cs) => !cs.length)) warnings.push('No checks: add global checks (one per line) or check: lines in cases, or a judge rubric - without them every answer counts as passed.');

  const vIds = new Set(variants.map((v) => v.id)), cIds = new Set(cases.map((c) => c.id));
  const orphans = [...answers.values()].filter((a) => !vIds.has(String(a.variant)) || !cIds.has(String(a.case)));
  if (orphans.length) warnings.push(`${orphans.length} answer(s) belong to a variant or case that no longer exists (${orphans.slice(0, 3).map((a) => `${a.variant}/${a.case}`).join(', ')}); they are ignored.`);

  let samples = 0, stale = 0;
  const cells = [];
  for (const [ci, k] of cases.entries()) {
    for (const [vi, v] of variants.entries()) {
      const messages = messagesFor(v, k);
      const h = hash(JSON.stringify(messages));
      const a = answers.get(`${v.id}\u0000${k.id}`) || null;
      const checks = [...global, ...caseChecks[ci]];
      let judge = null;
      if (a) {
        if (a.judge && typeof a.judge === 'object') judge = { score: n(a.judge.score), reason: String(a.judge.reason ?? '') };
        else if (a.judge_text != null) judge = parseJudge(a.judge_text);
        else if (a.judge_error) judge = { score: null, error: String(a.judge_error) };
      }
      const res = a && !a.error ? checks.map((c) => ({ label: c.label || c.kind, kind: c.kind, ...runCheck(c, a.text, k, judge, judgePass) }))
        : checks.map((c) => ({ label: c.label || c.kind, kind: c.kind, pass: null, detail: a?.error ? 'no answer (error)' : 'not run' }));
      const decided = res.filter((r) => r.pass != null);
      const passed = decided.filter((r) => r.pass).length;
      let status = 'pending';
      if (a?.error) status = 'error';
      else if (a) status = decided.length < res.length && decided.every((r) => r.pass) ? 'partial' : passed === decided.length ? 'pass' : 'fail';
      const isStale = !!(a && a.hash && a.hash !== h);
      if (a?.sample) samples++;
      if (isStale) stale++;
      cells.push({ v: vi, c: ci, messages, hash: h, status, stale: isStale, sample: !!a?.sample,
        answer: a ? { text: String(a.text ?? ''), ms: n(a.ms), pt: n(a.prompt_tokens), ct: n(a.completion_tokens), cost: n(a.cost), model: a.model ? String(a.model) : '', error: a.error ? String(a.error) : '' } : null,
        judge, checks: res, passed, total: res.length, decided: decided.length });
    }
  }

  // Per variant: cells that pass every check, checks passed, judge mean, cost and latency from usage.
  const perVar = variants.map((v, vi) => {
    const cs = cells.filter((x) => x.v === vi);
    const done = cs.filter((x) => x.answer && !x.answer.error);
    const sum = (f) => done.reduce((s, x) => s + (f(x) ?? 0), 0);
    const js = done.map((x) => x.judge?.score).filter((s) => s != null);
    const withCost = done.filter((x) => x.answer.cost != null);
    const withMs = done.filter((x) => x.answer.ms != null);
    return {
      id: v.id, name: v.name, cells: cs.length, answered: done.length, errors: cs.filter((x) => x.status === 'error').length,
      pass: done.filter((x) => x.status === 'pass').length,
      checksPassed: done.reduce((s, x) => s + x.passed, 0), checksDecided: done.reduce((s, x) => s + x.decided, 0),
      judgeMean: js.length ? js.reduce((a, b) => a + b, 0) / js.length : null,
      cost: withCost.length ? withCost.reduce((s, x) => s + x.answer.cost, 0) : null,
      msMean: withMs.length ? withMs.reduce((s, x) => s + x.answer.ms, 0) / withMs.length : null,
      tokensIn: sum((x) => x.answer.pt), tokensOut: sum((x) => x.answer.ct),
    };
  });
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const answered = cells.filter((x) => x.answer && !x.answer.error).length;
  const best = perVar.filter((p) => p.answered).sort((a, b) => b.pass / b.answered - a.pass / a.answered || (b.judgeMean ?? 0) - (a.judgeMean ?? 0))[0];
  const totalCost = perVar.reduce((s, p) => s + (p.cost ?? 0), 0);
  const anyCost = perVar.some((p) => p.cost != null);
  const allMs = cells.filter((x) => x.answer?.ms != null).map((x) => x.answer.ms);

  const values = [
    { label: 'Grid', value: `${cases.length} x ${variants.length}`, hint: 'cases x variants' },
    { label: 'Answered', value: `${answered}/${cells.length}`, tone: answered === cells.length && cells.length ? 'ok' : 'warn' },
  ];
  const toRun = cells.filter((x) => x.status === 'pending' || x.status === 'error' || x.stale || x.sample).length;
  if (toRun) values.push({ label: 'Cells to run', value: toRun, hint: rubric ? `${toRun * 2} model calls with the judge` : `${toRun} model calls` });
  if (best) values.push({ label: 'Best variant', value: best.name, hint: `${best.pass}/${best.answered} cases pass every check`, tone: best.pass === best.answered ? 'ok' : 'warn' });
  for (const p of perVar) if (p.answered) values.push({ label: `${p.name} pass rate`, value: pct(p.pass, p.answered), unit: '%', tone: p.pass === p.answered ? 'ok' : p.pass / p.answered >= 0.6 ? 'warn' : 'bad' });
  if (anyCost) values.push({ label: 'Cost', value: Number(totalCost.toPrecision(3)), unit: 'USD', hint: 'as billed, from the usage the server reported' });
  if (allMs.length) values.push({ label: 'Mean latency', value: Math.round(allMs.reduce((a, b) => a + b, 0) / allMs.length), unit: 'ms' });

  const fmtC = (c) => (c == null ? '-' : c < 0.01 ? c.toFixed(5) : c.toFixed(3));
  const tables = [
    { title: 'Variants', columns: ['variant', 'answered', 'pass every check', 'checks passed', 'judge mean', 'mean ms', 'tokens in/out', 'cost USD'],
      rows: perVar.map((p) => [p.name, `${p.answered}/${p.cells}`, p.answered ? `${p.pass} (${pct(p.pass, p.answered)} %)` : '-',
        p.checksDecided ? `${p.checksPassed}/${p.checksDecided}` : '-', p.judgeMean == null ? '-' : Number(p.judgeMean.toFixed(2)),
        p.msMean == null ? '-' : Math.round(p.msMean), `${p.tokensIn}/${p.tokensOut}`, fmtC(p.cost)]) },
    { title: 'Grid (checks passed per cell)', columns: ['case', ...variants.map((v) => v.name)],
      rows: cases.map((k, ci) => [k.id, ...variants.map((v, vi) => {
        const x = cells.find((y) => y.v === vi && y.c === ci);
        if (x.status === 'pending') return 'not run';
        if (x.status === 'error') return 'error';
        return `${x.status.toUpperCase()} ${x.passed}/${x.decided}${x.judge?.score != null ? ` j${x.judge.score}` : ''}`;
      })]) },
  ];
  const failing = cells.filter((x) => x.status === 'fail').slice(0, 12);
  if (failing.length) {
    tables.push({ title: 'Failed checks', columns: ['case', 'variant', 'check', 'detail'],
      rows: failing.flatMap((x) => x.checks.filter((r) => r.pass === false).map((r) => [cases[x.c].id, variants[x.v].name, r.label, r.detail.slice(0, 120)])) });
  }

  const csvCell = (s) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const csvRows = (full) => [['case', 'variant', 'status', 'checks_passed', 'checks_decided', 'judge', 'ms', 'prompt_tokens', 'completion_tokens', 'cost_usd', 'model', 'answer'].join(','),
    ...cells.map((x) => [cases[x.c].id, variants[x.v].id, x.status, x.passed, x.decided, x.judge?.score ?? '', x.answer?.ms ?? '', x.answer?.pt ?? '', x.answer?.ct ?? '',
      x.answer?.cost ?? '', x.answer?.model ?? '', full ? x.answer?.text ?? '' : (x.answer?.text ?? '').replace(/\s+/g, ' ').slice(0, 60)].map(csvCell).join(','))].join('\n');
  const jsonl = cells.map((x) => JSON.stringify({ case: cases[x.c].id, variant: variants[x.v].id, status: x.status,
    checks: x.checks.map((r) => ({ check: r.label, pass: r.pass, detail: r.detail })), judge: x.judge?.score ?? null,
    answer: x.answer?.text ?? null, ms: x.answer?.ms ?? null, cost: x.answer?.cost ?? null })).join('\n');

  const pending = cells.filter((x) => x.status === 'pending').length;
  if (pending && answered) notes.push(`${pending} cell(s) not run yet.`);
  if (stale) warnings.push(`${stale} answer(s) were made from a prompt or case that has changed since; run them again ("Run missing" includes them).`);
  if (samples) notes.push(`${samples} answer(s) are samples written into the example to show the grid, not model output. Press Run in the app to replace them with real answers.`);
  const errs = cells.filter((x) => x.status === 'error');
  if (errs.length) warnings.push(`${errs.length} cell(s) failed to get an answer (${errs[0].answer.error.slice(0, 80)}); run them again.`);
  for (const p of perVar) if (p.answered >= 3 && p.pass === 0) warnings.push(`Variant "${p.name}" passes no case: check the checks against one of its answers before blaming the prompt.`);
  notes.push('Checks: ' + Object.entries(KINDS).map(([k, d]) => `${k} (${d})`).join('; ') + '.',
    'A cell passes when every check that could be decided passes; a judge check with no score leaves it "partial". Cost and latency are what the server reported for each call; tokens are the provider\'s counts.',
    'An LLM judge is itself a model: spot-check its reasons, keep its temperature low, and prefer rule checks where a rule can decide.');

  return {
    values, tables,
    // The outputs panel (and agents) get the CSV with answers cut to 60
    // characters; the page's Export buttons write the full files.
    texts: [{ title: 'CSV', body: csvRows(false), lang: 'csv' }],
    warnings, notes,
    grid: {
      variants: variants.map((v) => ({ id: v.id, name: v.name, system: v.system, user: v.user, start: v.start, end: v.end })),
      cases: cases.map((k) => ({ id: k.id, title: k.title, input: k.input, expected: k.expected, checks: k.checks, start: k.start, end: k.end })),
      cells, perVar, judgePass, rubric, globalChecks: global.map((c) => c.label || c.kind),
      exports: { csv: csvRows(true), jsonl },
    },
  };
}
