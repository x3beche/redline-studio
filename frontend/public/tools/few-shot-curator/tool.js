// Few-shot Example Curator.
//
// Reads a pool of input/output examples (JSONL, CSV or "Input:/Output:"
// blocks), works out each one's label (the output itself when it is a short
// class name, or a field of a JSON output), finds near-duplicates, examples
// that contradict each other and examples that leak the test input, then
// picks and orders a few-shot set by a strategy and fits it to a token
// budget. The block comes out as XML tags, chat messages and JSONL.
//
// Similarity: inputs are normalised (lower case, accents folded, digits to 0,
// punctuation to spaces, whitespace collapsed) and cut into character
// 5-gram shingles; two examples' similarity is the Jaccard index of their
// shingle sets, |A ∩ B| / |A ∪ B| (Broder 1997, "On the resemblance and
// containment of documents"). Distance = 1 - similarity.
// Diverse selection is greedy max-min (farthest-point) selection (Gonzalez
// 1985), started from the most typical example (highest mean similarity).
// Tokens are estimates from ./estimate.js (o200k_base-shaped), plus a few
// tokens of framing per example.

import { estimate } from './estimate.js';

export const DEFAULT_EXAMPLES = `{"input": "Board resets when the modem starts transmitting; 3V3 rail dips to 2.9 V on the scope during TX bursts.", "output": "hardware"}
{"input": "UART3 overrun (ORE) after enabling the URC parser in the RX interrupt handler.", "output": "firmware"}
{"input": "Yocto build fails: do_compile for u-boot-imx, 'fatal error: openssl/evp.h: No such file or directory'.", "output": "build"}
{"input": "SIM card not detected after hot-plug; SIM_DET pin floats, no pull-up fitted (R118 DNP).", "output": "hardware"}
{"input": "Which AT command sets the modem's RI pin behaviour for URCs?", "output": "question"}
{"input": "Ethernet PHY link drops at 100 Mbit; 25 MHz crystal load caps are 22 pF instead of 12 pF.", "output": "hardware"}
{"input": "HardFault in HAL_UART_IRQHandler after 40 minutes; stacked PC points into the ring buffer write.", "output": "firmware"}
{"input": "Board resets when modem starts transmitting, the 3.3V rail drops to 2.9V on the scope in TX bursts.", "output": "hardware"}
{"input": "USB enumeration fails on some hosts; D+ and D- are swapped at the connector on rev B.", "output": "hardware"}
{"input": "CMake: arm-none-eabi-gcc not found when building in the CI container, works locally.", "output": "build"}
{"input": "Watchdog resets the MCU right after PDP deactivation; the task blocks in HAL_UART_Transmit.", "output": "firmware"}
{"input": "LED D4 is dim; series resistor is 4.7k, datasheet asks for 470 ohm at 5 mA.", "output": "hardware"}
{"input": "Watchdog resets the MCU right after PDP deactivation; the task blocks in HAL_UART_Transmit.", "output": "hardware"}
{"input": "Can the EG25-G run on 3.3 V directly or does VBAT need 3.8 V?", "output": "question"}
{"input": "ADC readings on PA0 jump by 40 LSB when the buck converter switches; no RC filter on the input.", "output": "hardware"}
{"input": "Linker error: region FLASH overflowed by 1840 bytes after enabling printf float support.", "output": "build"}
{"input": "OTA update leaves the device in the bootloader; the image CRC is checked over the wrong length.", "output": "firmware"}
{"input": "Enclosure screw boss cracks when torqued to 0.6 Nm; PLA print at 20 % infill.", "output": "hardware"}`;

export const DEFAULT_TEST = 'After an OTA update the device stays in the bootloader; CRC of the image is computed over the wrong length.';

const LABEL_KEYS = ['label', 'category', 'class', 'intent', 'severity', 'type', 'component', 'sentiment', 'answer'];
const IN_KEYS = ['input', 'prompt', 'question', 'text', 'query', 'user', 'instruction', 'source', 'x'];
const OUT_KEYS = ['output', 'completion', 'answer', 'response', 'label', 'target', 'assistant', 'y', 'category', 'class'];

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
const pick = (o, keys) => { for (const k of keys) { const f = Object.keys(o).find((x) => x.toLowerCase() === k); if (f != null) return [f, o[f]]; } return [null, undefined]; };

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const delim = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Examples text -> {items:[{input, output}], format, problems}. */
export function parseExamples(text, format = 'auto') {
  const t = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  const problems = [];
  if (!t) return { items: [], format: 'none', problems };
  let fmt = format;
  if (fmt === 'auto') {
    if (/^[[{]/.test(t)) fmt = 'jsonl';
    else if (/^\s*(input|q|question|user|prompt)\s*:/im.test(t.split('\n')[0])) fmt = 'blocks';
    else fmt = 'csv';
  }
  const items = [];
  if (fmt === 'jsonl') {
    let lines = t.split('\n');
    // a JSON array of objects is accepted too
    if (t.startsWith('[')) { try { const arr = JSON.parse(t); if (Array.isArray(arr)) lines = arr.map((o) => JSON.stringify(o)); } catch { /* fall through to lines */ } }
    lines.forEach((line, i) => {
      const l = line.trim().replace(/,$/, '');
      if (!l || l === '[' || l === ']') return;
      let o;
      try { o = JSON.parse(l); } catch { problems.push(`line ${i + 1}: not JSON (${l.slice(0, 40)}${l.length > 40 ? '…' : ''})`); return; }
      if (!o || typeof o !== 'object') { problems.push(`line ${i + 1}: not an object`); return; }
      if (Array.isArray(o.messages)) {
        const u = [...o.messages].reverse().find((m) => m.role === 'user'), a = [...o.messages].reverse().find((m) => m.role === 'assistant');
        if (!u || !a) { problems.push(`line ${i + 1}: messages without a user and an assistant turn`); return; }
        items.push({ input: str(u.content), output: str(a.content), line: i + 1 });
        return;
      }
      const [ik, iv] = pick(o, IN_KEYS);
      const [, ov] = pick(Object.fromEntries(Object.entries(o).filter(([k]) => k !== ik)), OUT_KEYS);
      if (iv == null || ov == null) { problems.push(`line ${i + 1}: no input/output fields (found ${Object.keys(o).join(', ') || 'none'})`); return; }
      items.push({ input: str(iv), output: str(ov), line: i + 1 });
    });
  } else if (fmt === 'csv') {
    const rows = parseCSV(t);
    if (rows.length < 2) { problems.push('CSV needs a header row and at least one example row.'); return { items, format: fmt, problems }; }
    const head = rows[0].map((c) => c.trim().toLowerCase());
    let ii = head.findIndex((c) => IN_KEYS.includes(c)), oi = head.findIndex((c, k) => k !== ii && OUT_KEYS.includes(c));
    if (ii < 0 || oi < 0) { ii = 0; oi = 1; problems.push(`CSV header "${rows[0].join(', ')}" has no input/output column names; using the first two columns.`); }
    rows.slice(1).forEach((r, k) => {
      if (r.length <= Math.max(ii, oi)) { problems.push(`row ${k + 2}: ${r.length} column(s), expected ${Math.max(ii, oi) + 1}`); return; }
      items.push({ input: r[ii].trim(), output: r[oi].trim(), line: k + 2 });
    });
  } else {
    // Input:/Output: (also Q:/A:, User:/Assistant:) blocks
    const re = /^\s*(input|q|question|user|prompt|output|a|answer|assistant|label)\s*:\s?/i;
    let cur = null, field = null, ln = 0;
    for (const line of t.split('\n')) {
      ln++;
      const m = re.exec(line);
      if (m) {
        const isIn = /^(input|q|question|user|prompt)$/i.test(m[1]);
        if (isIn) { cur = { input: '', output: null, line: ln }; items.push(cur); field = 'input'; }
        else if (cur) { cur.output = ''; field = 'output'; }
        else { problems.push(`line ${ln}: an output before any input`); continue; }
        cur[field] += line.slice(m[0].length);
      } else if (cur && field) {
        if (/^\s*(---+|===+)\s*$/.test(line)) continue;
        cur[field] += '\n' + line;
      }
    }
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].output == null) { problems.unshift(`block at line ${items[i].line}: an input without an output`); items.splice(i, 1); continue; }
      items[i].input = items[i].input.trim(); items[i].output = items[i].output.trim();
    }
  }
  return { items, format: fmt, problems };
}

export function normalise(s) {
  return String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ı/g, 'i')
    .replace(/\d+(?:[.,]\d+)?/g, '0').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function shingles(s, k = 5) {
  const t = ` ${s} `;
  const set = new Set();
  if (t.length <= k) { set.add(t); return set; }
  for (let i = 0; i + k <= t.length; i++) set.add(t.slice(i, i + k));
  return set;
}
export function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  for (const x of s) if (l.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function labelOf(output, field) {
  const o = output.trim();
  if (/^[{[]/.test(o)) {
    try {
      const j = JSON.parse(o);
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        if (field && j[field] != null) return str(j[field]);
        const [, v] = pick(j, LABEL_KEYS);
        if (v != null && str(v).length <= 40) return str(v);
      }
    } catch { /* not JSON */ }
  }
  if (field) return null;
  if (o.length <= 40 && o.split(/\s+/).length <= 4) return o.replace(/[.!]$/, '').toLowerCase();
  return null;
}

const fmtN = (n) => Math.round(n).toLocaleString('en-US');
const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FRAME = 8; // tokens of framing per example (<example><input>...</input><output>...</output></example>)

export function run(input) {
  const warnings = [], notes = [];
  const { items, format, problems } = parseExamples(input.examples, input.format || 'auto');
  if (problems.length) warnings.push(`Could not read ${problems.length} part${problems.length > 1 ? 's' : ''} of the examples: ${problems.slice(0, 4).join('; ')}${problems.length > 4 ? '; …' : ''}.`);
  const field = String(input.labelField || '').trim();
  const relabel = new Map();
  for (const m of String(input.relabel || '').matchAll(/#?(\d+)\s*[=:]\s*([^,;\n]+)/g)) relabel.set(Number(m[1]), m[2].trim());
  const dupT = Number.isFinite(Number(input.dup)) && input.dup > 0 && input.dup <= 1 ? Number(input.dup) : 0.45;
  const k = Math.max(1, Math.min(100, Math.round(Number(input.k) || 6)));
  const budget = Math.max(0, Math.round(Number(input.budget) || 0));
  const strategy = ['balanced', 'diverse', 'shortest', 'recent', 'manual'].includes(input.strategy) ? input.strategy : 'balanced';

  // ---- examples ----
  const E = items.map((it, i) => {
    const id = i + 1;
    const auto = labelOf(it.output, field);
    const label = relabel.get(id) || auto || '(none)';
    const e1 = estimate(it.input), e2 = estimate(it.output);
    return { id, line: it.line, input: it.input, output: it.output, label, autoLabel: auto, relabelled: relabel.has(id),
      tokens: e1.o200k + e2.o200k + FRAME, inTokens: e1.o200k, norm: normalise(it.input), sh: shingles(normalise(it.input)),
      multiline: /\n/.test(it.input.trim()), dupOf: null, conflict: [], leak: 0 };
  });
  const noLabel = E.filter((e) => e.label === '(none)').length;
  if (E.length && noLabel === E.length) notes.push(field ? `No output has a "${field}" field: every example is unlabelled.` : 'Outputs are free text, not short class names: every example is "(none)". Set the label field for JSON outputs, or relabel examples (e.g. 3=positive).');

  // ---- pairs: duplicates and contradictions ----
  const links = [];
  const parent = E.map((e) => e.id);
  const find = (x) => { while (parent[x - 1] !== x) x = parent[x - 1]; return x; };
  for (let a = 0; a < E.length; a++) {
    for (let b = a + 1; b < E.length; b++) {
      const s = E[a].norm === E[b].norm ? 1 : jaccard(E[a].sh, E[b].sh);
      if (s < dupT) continue;
      const sameOut = normalise(E[a].output) === normalise(E[b].output) || (E[a].label !== '(none)' && E[a].label === E[b].label);
      if (s >= Math.max(dupT, 0.8) && !sameOut) {
        E[a].conflict.push(E[b].id); E[b].conflict.push(E[a].id);
        links.push({ a: E[a].id, b: E[b].id, sim: Math.round(s * 100) / 100, kind: 'conflict' });
      } else {
        links.push({ a: E[a].id, b: E[b].id, sim: Math.round(s * 100) / 100, kind: 'dup' });
        const ra = find(E[a].id), rb = find(E[b].id);
        if (ra !== rb) parent[Math.max(ra, rb) - 1] = Math.min(ra, rb);
      }
    }
  }
  for (const e of E) { const r = find(e.id); if (r !== e.id) e.dupOf = r; }

  // ---- leakage of the test input ----
  const tests = String(input.test || '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const tSh = tests.map((t) => shingles(normalise(t)));
  for (const e of E) for (const ts of tSh) e.leak = Math.max(e.leak, Math.round(jaccard(e.sh, ts) * 100) / 100);
  const LEAK = 0.4; // unrelated inputs score < 0.15 on this measure; a paraphrase 0.4-0.6

  // ---- candidates for the automatic strategies ----
  const cand = E.filter((e) => !e.dupOf && !e.conflict.length && e.leak < LEAK);
  const sim = (a, b) => (a.norm === b.norm ? 1 : jaccard(a.sh, b.sh));
  const fits = (used, e) => !budget || used + e.tokens <= budget;
  let sel = [];
  const skippedBudget = [];
  if (strategy === 'manual') {
    const ids = String(input.picks || '').split(/[\s,;]+/).map((x) => Number(String(x).replace('#', ''))).filter((x) => Number.isInteger(x));
    const bad = ids.filter((x) => x < 1 || x > E.length);
    if (bad.length) warnings.push(`Picks ${bad.join(', ')} are not example numbers (1-${E.length}); ignored.`);
    const seen = new Set();
    for (const id of ids) if (id >= 1 && id <= E.length && !seen.has(id)) { seen.add(id); sel.push(E[id - 1]); }
  } else {
    let used = 0;
    const take = (e) => { sel.push(e); used += e.tokens; };
    const pool = [...cand];
    const farthest = (list) => {
      let best = null, bd = -1;
      for (const e of list) {
        const d = sel.length ? Math.min(...sel.map((s) => 1 - sim(e, s))) : 0;
        if (d > bd + 1e-9) { bd = d; best = e; }
      }
      return best;
    };
    if (strategy === 'shortest') {
      for (const e of pool.sort((a, b) => a.tokens - b.tokens || a.id - b.id)) { if (sel.length >= k) break; if (fits(used, e)) take(e); else skippedBudget.push(e.id); }
    } else if (strategy === 'recent') {
      const picked = [];
      for (const e of [...pool].reverse()) { if (picked.length >= k) break; if (fits(used, e)) { picked.push(e); used += e.tokens; } else skippedBudget.push(e.id); }
      sel = picked.reverse();
    } else if (strategy === 'diverse') {
      const typical = pool.length ? pool.reduce((b, e) => { const m = pool.reduce((a, o) => a + (o === e ? 0 : sim(e, o)), 0); return m > b.m ? { e, m } : b; }, { e: pool[0], m: -1 }).e : null;
      let left = [...pool];
      if (typical) { if (fits(used, typical)) take(typical); left = left.filter((e) => e !== typical); }
      while (sel.length < k && left.length) {
        const f = farthest(left.filter((e) => fits(used, e)));
        if (!f) break;
        take(f); left = left.filter((e) => e !== f);
      }
    } else { // balanced
      const labels = [...new Set(pool.map((e) => e.label))].sort();
      const byL = Object.fromEntries(labels.map((l) => [l, pool.filter((e) => e.label === l)]));
      let progress = true;
      while (sel.length < k && progress) {
        progress = false;
        for (const l of labels) {
          if (sel.length >= k) break;
          const f = farthest(byL[l].filter((e) => fits(used, e)));
          if (!f) continue;
          take(f); byL[l] = byL[l].filter((e) => e !== f); progress = true;
        }
      }
    }
  }
  const used = sel.reduce((a, e) => a + e.tokens, 0);

  // ---- warnings ----
  const count = (list) => list.reduce((m, e) => (m[e.label] = (m[e.label] || 0) + 1, m), {});
  const poolC = count(E), selC = count(sel);
  const labels = Object.keys(poolC).sort((a, b) => poolC[b] - poolC[a] || a.localeCompare(b));
  if (labels.length > 1) {
    const mx = poolC[labels[0]], mn = poolC[labels[labels.length - 1]];
    if (mx >= 3 * mn) warnings.push(`Labels are skewed in the pool: "${labels[0]}" has ${mx}, "${labels[labels.length - 1]}" has ${mn}. A few-shot set that copies this skew pulls answers toward "${labels[0]}"; the balanced strategy evens it out.`);
    const sl = Object.keys(selC);
    if (sel.length && sl.length > 1) { const smx = Math.max(...Object.values(selC)), smn = Math.min(...Object.values(selC)); if (smx >= 2 * smn + 1) warnings.push(`The selection is uneven: ${Object.entries(selC).map(([l, n]) => `${l} ${n}`).join(', ')}.`); }
    const missing = labels.filter((l) => l !== '(none)' && !selC[l]);
    if (sel.length && missing.length) warnings.push(`No example of ${missing.map((l) => `"${l}"`).join(', ')} in the selection: the model sees ${missing.length > 1 ? 'these labels' : 'this label'} only in the instructions, if at all.`);
  }
  const conflicts = links.filter((l) => l.kind === 'conflict');
  if (conflicts.length) warnings.push(`Examples contradict each other (same input, different output): ${conflicts.map((l) => `#${l.a} "${E[l.a - 1].label}" vs #${l.b} "${E[l.b - 1].label}"`).join('; ')}. Fix the label that is wrong; both are left out of automatic picks.`);
  const dups = E.filter((e) => e.dupOf);
  if (dups.length) notes.push(`${dups.length} near-duplicate${dups.length > 1 ? 's' : ''} (Jaccard ≥ ${dupT} on the input): ${dups.map((e) => `#${e.id} ≈ #${e.dupOf}`).join(', ')}. Only the first of each group is picked automatically.`);
  const leaks = E.filter((e) => e.leak >= LEAK);
  if (leaks.length) warnings.push(`The test input leaks into the examples: ${leaks.map((e) => `#${e.id} (${Math.round(e.leak * 100)} % similar)`).join(', ')}. An example that is nearly the test case inflates an evaluation; it is left out of automatic picks${sel.some((e) => e.leak >= LEAK) ? ' - and it IS in your manual selection' : ''}.`);
  if (sel.length >= 3) {
    const L = sel.map((e) => e.inTokens), mean = L.reduce((a, b) => a + b, 0) / L.length;
    const cv = Math.sqrt(L.reduce((a, b) => a + (b - mean) ** 2, 0) / L.length) / (mean || 1);
    if (cv < 0.15) warnings.push(`All selected inputs are about the same length (${Math.round(mean)} tokens, spread ${Math.round(cv * 100)} %): include a short and a long one so the model does not learn the length.`);
    if (tests.length) {
      const tl = estimate(tests[0]).o200k;
      if (tl > 2 * Math.max(...L) || tl < 0.4 * Math.min(...L)) warnings.push(`The test input (~${tl} tokens) is outside the length range of the selection (${Math.min(...L)}-${Math.max(...L)}): add an example of similar length.`);
      if (/\n/.test(tests[0].trim()) && !sel.some((e) => e.multiline)) warnings.push('The test input is multi-line but every selected example is one line: include a multi-line example.');
    }
    const last = sel.slice(-2);
    if (last.length === 2 && last[0].label === last[1].label && Object.keys(selC).length > 1) warnings.push(`The last two examples are both "${last[0].label}": models lean toward the most recent label. Move one earlier (drag in the sequence).`);
  }
  if (budget && used > budget) warnings.push(`The selection is ${fmtN(used)} tokens, over the ${fmtN(budget)} budget by ${fmtN(used - budget)}.`);
  if (skippedBudget.length && strategy !== 'manual') notes.push(`Skipped for the budget: ${skippedBudget.slice(0, 12).map((x) => `#${x}`).join(', ')}.`);
  if (!E.length) warnings.push('No examples read. Paste JSONL ({"input": ..., "output": ...} per line), CSV with input,output columns, or "Input: / Output:" blocks.');
  if (E.length && sel.length < Math.min(k, cand.length) && strategy !== 'manual' && budget) notes.push(`Only ${sel.length} of ${k} examples fit the ${fmtN(budget)}-token budget.`);
  notes.push(`Read as ${format}. Labels: ${field ? `the "${field}" field of the output` : 'the output when it is a short class name, or a label/category/class field of a JSON output'}; relabelled on the page where marked.`);
  notes.push('Similarity is the Jaccard index of character 5-gram shingles of the normalised input (case, accents, digits and punctuation ignored). Token counts are estimates (o200k-shaped), plus ~8 tokens of framing per example.');

  // ---- outputs ----
  const xml = ['<examples>', ...sel.map((e) => `<example>\n<input>${xmlEsc(e.input)}</input>\n<output>${xmlEsc(e.output)}</output>\n</example>`), '</examples>'].join('\n');
  const chat = JSON.stringify(sel.flatMap((e) => [{ role: 'user', content: e.input }, { role: 'assistant', content: e.output }]), null, 2);
  const jsonl = sel.map((e) => JSON.stringify({ input: e.input, output: e.output })).join('\n');
  const order = sel.map((e) => e.id);
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  return {
    values: [
      { label: 'Examples read', value: E.length, hint: problems.length ? `${problems.length} unreadable` : format },
      { label: 'Selected', value: sel.length, hint: strategy },
      { label: 'Tokens (est.)', value: used, unit: budget ? `of ${fmtN(budget)}` : 'tokens', tone: budget && used > budget ? 'bad' : 'ok' },
      { label: 'Labels', value: labels.length, hint: labels.map((l) => `${l} ${poolC[l]}`).join(', ') },
      { label: 'Near-duplicates', value: dups.length, tone: dups.length ? 'warn' : 'ok' },
      { label: 'Contradictions', value: conflicts.length, tone: conflicts.length ? 'bad' : 'ok' },
      { label: 'Leaks of the test input', value: leaks.length, tone: leaks.length ? 'bad' : 'ok' },
    ],
    tables: [
      { title: 'Selected, in order', columns: ['Order', '#', 'Label', 'Tokens', 'Input'], rows: sel.map((e, i) => [i + 1, e.id, e.label, e.tokens, clip(e.input.replace(/\s+/g, ' '), 90)]) },
      { title: 'Pool', columns: ['#', 'Label', 'Tokens', 'Flags', 'Input'], rows: E.map((e) => [e.id, e.label + (e.relabelled ? ' (relabelled)' : ''), e.tokens,
        [e.dupOf ? `dup of #${e.dupOf}` : '', e.conflict.length ? `contradicts #${e.conflict.join(', #')}` : '', e.leak >= LEAK ? `leak ${Math.round(e.leak * 100)} %` : ''].filter(Boolean).join('; '), clip(e.input.replace(/\s+/g, ' '), 70)]) },
    ],
    texts: [
      { title: 'XML block', body: xml + '\n' },
      { title: 'Chat messages', body: chat + '\n' },
      { title: 'JSONL', body: jsonl + (jsonl ? '\n' : '') },
    ],
    warnings,
    notes,
    draw: {
      examples: E.map((e) => ({ id: e.id, label: e.label, autoLabel: e.autoLabel, relabelled: e.relabelled, input: clip(e.input, 220), output: clip(e.output, 120), tokens: e.tokens,
        dupOf: e.dupOf, conflict: e.conflict, leak: e.leak >= LEAK ? e.leak : 0, candidate: cand.includes(e), sel: order.indexOf(e.id) })),
      links, labels: labels.map((l) => ({ label: l, pool: poolC[l], sel: selC[l] || 0 })), order, used, budget, strategy, k,
    },
  };
}
