// Prompt Diff & History: two versions of a prompt compared sentence by
// sentence and word by word, with the token change per section, what kind of
// instruction changed, and the version history as a changelog.
//
// Pure: no DOM, no clock, no randomness. Dates are whatever the history says.
//
// Method:
//  - Each version is cut into units: one line, or one sentence of a line.
//  - Units are aligned by longest common subsequence on their normalised
//    text (lowercase, single spaces) - the classic diff (Hunt-McIlroy /
//    Myers give the same edit length; this is the O(n·m) table).
//  - Inside a run of removed + added units, pairs with word overlap
//    (Jaccard) >= 0.5 are a changed unit and get a word-level LCS diff.
//  - A removed unit that reappears unchanged (or >= 0.9 similar) elsewhere
//    is a moved unit, not a delete plus an add.
//  - The unified diff output is line based with 3 lines of context, in the
//    format of GNU diff -u (GNU diffutils manual, "Unified Format").
//  - Modal verbs (must, should, never, always, may...) are compared per
//    changed unit: "must -> should" is a rule that got weaker.
//  - Token counts are estimates (chars/4 and a word-piece heuristic), not
//    a tokenizer.

export function tokens(text) {
  const t = String(text || '');
  let wp = 0;
  const re = /[A-Za-z]+|\d+|([^\sA-Za-z\d])\1*|\n+/g;
  let m;
  while ((m = re.exec(t))) {
    const w = m[0];
    if (/^[A-Za-z]/.test(w)) wp += w.length <= 8 ? 1 : 1 + Math.ceil((w.length - 8) / 5);
    else if (/^\d/.test(w)) wp += Math.ceil(w.length / 3);
    else if (w[0] === '\n') wp += 1;
    else if (w.charCodeAt(0) > 0x2e7f) wp += w.length;
    else wp += Math.ceil(w.length / 4);
  }
  return Math.round((Math.ceil(t.length / 4) + wp) / 2);
}

// ---------------------------------------------------------------- units
function unitsOf(text) {
  const out = [];
  let pos = 0, lineNo = 0, blankBefore = false;
  for (const line of text.split('\n')) {
    lineNo++;
    const base = pos;
    pos += line.length + 1;
    if (!line.trim()) { blankBefore = true; continue; }
    const cuts = [0];
    const re = /([.!?])\s+(?=["'(<[]?[A-Z0-9])/g;
    let m;
    while ((m = re.exec(line))) {
      if (/(e\.g|i\.e|etc|vs|no)\.$/i.test(line.slice(Math.max(0, m.index - 4), m.index + 1))) continue;
      if (/^\s*([-*•]\s*)?\d+$/.test(line.slice(0, m.index))) continue;          // "1. The cause" is one item
      cuts.push(m.index + 1);
    }
    cuts.push(line.length);
    for (let k = 0; k < cuts.length - 1; k++) {
      let a = cuts[k], b = cuts[k + 1];
      while (a < b && /\s/.test(line[a])) a++;
      while (b > a && /\s/.test(line[b - 1])) b--;
      if (b <= a) continue;
      out.push({ s: base + a, e: base + b, t: line.slice(a, b), line: lineNo, first: k === 0, gap: k === 0 && blankBefore, indent: k === 0 ? line.slice(0, a) : '' });
    }
    blankBefore = false;
  }
  return out;
}
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const words = (s) => new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || []));
function jaccard(a, b) {
  const A = words(a), B = words(b);
  if (!A.size && !B.size) return 1;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}
/** How alike two sentences are, for pairing: word overlap, forgiving a
 *  sentence that grew (overlap over the shorter one) as long as a third of
 *  all words are shared. */
function alike(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  const j = n / (A.size + B.size - n);
  return j >= 0.3 ? Math.max(j, 0.85 * n / Math.min(A.size, B.size)) : j;
}

/** LCS alignment of two arrays by key: [{op:'eq'|'del'|'ins', a, b}]. */
function lcs(A, B, key = (x) => x) {
  const n = A.length, m = B.length;
  // Trim the common head and tail first: most prompt edits are local.
  let h0 = 0; while (h0 < n && h0 < m && key(A[h0]) === key(B[h0])) h0++;
  let t0 = 0; while (t0 < n - h0 && t0 < m - h0 && key(A[n - 1 - t0]) === key(B[m - 1 - t0])) t0++;
  const a = A.slice(h0, n - t0), b = B.slice(h0, m - t0);
  const N = a.length, M = b.length;
  const ops = [];
  for (let i = 0; i < h0; i++) ops.push({ op: 'eq', a: i, b: i });
  if (N * M > 4e6) {
    // Too large for the table: everything in the middle is replaced.
    for (let i = 0; i < N; i++) ops.push({ op: 'del', a: h0 + i });
    for (let j = 0; j < M; j++) ops.push({ op: 'ins', b: h0 + j });
  } else {
    const W = M + 1;
    const L = new Uint32Array((N + 1) * W);
    const ka = a.map(key), kb = b.map(key);
    for (let i = N - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--) {
      L[i * W + j] = ka[i] === kb[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    }
    let i = 0, j = 0;
    while (i < N || j < M) {
      if (i < N && j < M && ka[i] === kb[j]) { ops.push({ op: 'eq', a: h0 + i, b: h0 + j }); i++; j++; }
      else if (j < M && (i >= N || L[i * W + j + 1] > L[(i + 1) * W + j])) { ops.push({ op: 'ins', b: h0 + j }); j++; }
      else { ops.push({ op: 'del', a: h0 + i }); i++; }
    }
  }
  for (let k = 0; k < t0; k++) ops.push({ op: 'eq', a: n - t0 + k, b: m - t0 + k });
  return ops;
}

/** Word-level diff of two strings: [{op, t}] with whitespace kept. */
export function wordDiff(a, b) {
  const tok = (s) => s.match(/\s+|[A-Za-z0-9_'-]+|[^\sA-Za-z0-9_'-]/g) || [];
  const A = tok(a), B = tok(b);
  const ops = lcs(A, B);
  const out = [];
  for (const o of ops) {
    const t = o.op === 'ins' ? B[o.b] : A[o.a];
    const last = out[out.length - 1];
    if (last && last.op === o.op) last.t += t; else out.push({ op: o.op, t });
  }
  // A lone space between two changes reads better inside the change.
  return out;
}

// ---------------------------------------------------------------- sections
const SECTIONS = ['role', 'context', 'task', 'constraints', 'examples', 'format', 'data'];
const LABEL = { role: 'Role', context: 'Context', task: 'Task', constraints: 'Constraints', examples: 'Examples', format: 'Output format', data: 'Data' };
const HDR = [
  [/^(role|persona|system)\b/i, 'role'], [/^(output|format|response format|answer format|answer with|respond with|structure)/i, 'format'],
  [/^(examples?|sample|few-shot)\b/i, 'examples'], [/^(rules?|constraints?|guidelines?|requirements?)\b/i, 'constraints'],
  [/^(task|instructions?|question|goal)\b/i, 'task'], [/^(context|background|about)\b/i, 'context'],
  [/^(input|data|document|log|logs|code|report|text)\b/i, 'data'],
];
const MODALS = ['must not', "mustn't", 'must', 'should not', "shouldn't", 'should', 'never', 'always', 'do not', "don't", 'avoid', 'may', 'can', 'only', 'required', 'optional', 'prefer'];
const MODAL_RE = new RegExp(`\\b(${MODALS.map((m) => m.replace(/'/g, "'")).join('|')})\\b`, 'gi');
const modalsOf = (t) => (t.match(MODAL_RE) || []).map((m) => m.toLowerCase());
const IMPERATIVE = /^(\d+[.)]\s*|[-*•]\s*)?(please\s+)?(review|write|summari[sz]e|find|explain|analy[sz]e|generate|classify|extract|translate|list|identify|compare|create|draft|rewrite|fix|check|evaluate|describe|give|provide|tell|suggest|determine|calculate|answer|look|quote|cite|use|include|add|mention|keep|make|start|begin|end|return|output|respond|reply|decode|report|state|say|flag|mark|focus|consider|assume|treat|stay|be|do|don't|never|always|avoid|only|if)\b/i;

/** Section of each unit: tags and headers set it; wording decides the rest. */
function sectionsOf(text, units) {
  let cur = null, tag = null, mdScope = false;
  const lines = text.split('\n');
  const lineSec = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const open = /^<([A-Za-z][\w-]*)[^>]*>/.exec(t);
    if (!t) { if (!tag && !mdScope) cur = null; lineSec.push(null); continue; }
    if (open && !tag) {
      const n = open[1].toLowerCase();
      tag = n;
      const c = /example/.test(n) ? 'examples' : /^(rules?|constraints?)$/.test(n) ? 'constraints' : /^(instructions?|task)$/.test(n) ? 'task' : /format|output|schema/.test(n) ? 'format' : /^(context|background)$/.test(n) ? 'context' : 'data';
      lineSec.push(c);
      if (t.includes(`</${open[1]}>`)) tag = null;
      else cur = c;
      continue;
    }
    if (tag) { lineSec.push(cur); if (t.includes(`</${tag}`)) { tag = null; cur = null; } continue; }
    const hdr = /^(#{1,6}\s+(.+)|\**([A-Z][\w /'-]{1,30}?)\**:\s*$)/.exec(t);
    if (hdr) {
      const name = (hdr[2] || hdr[3] || '').trim();
      const c = HDR.find(([re]) => re.test(name));
      cur = c ? c[1] : null;
      mdScope = !!hdr[2];
      lineSec.push(cur || 'context');
      continue;
    }
    if (/^(answer|respond|reply|output|return|format)\b.*:\s*$/i.test(t)) { cur = 'format'; mdScope = false; lineSec.push('format'); continue; }
    lineSec.push(cur);
  }
  return units.map((u) => {
    const s = lineSec[u.line - 1];
    if (s) return s;
    const t = u.t;
    if (/^(you are|you're|act as|as an? )/i.test(t)) return 'role';
    if (/\b(json|markdown|bullets?|table|numbered|words|sentences|format|heading)\b/i.test(t) && /\b(answer|respond|reply|output|return|format|keep|use|write|under|at most)\b/i.test(t)) return 'format';
    if (/^([-*•]\s*)?(don't|do not|never|always|avoid|only|make sure|ensure|you must|you should|must|should)\b/i.test(t)) return 'constraints';
    if (IMPERATIVE.test(t) || /\?\s*$/.test(t)) return 'task';
    if (modalsOf(t).length) return 'constraints';
    return 'context';
  });
}
const isInstruction = (sec) => sec === 'task' || sec === 'constraints' || sec === 'format' || sec === 'role';
const NUMS = (t) => (t.toLowerCase().match(/\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|hundred)\b/g) || []);

// ---------------------------------------------------------------- compare
export function compare(textA, textB) {
  const A = unitsOf(textA), B = unitsOf(textB);
  const secA = sectionsOf(textA, A), secB = sectionsOf(textB, B);
  const ops = lcs(A, B, (u) => norm(u.t));
  // Hunks: runs of del/ins between equals. Pair similar units inside a hunk.
  const rows = [];
  let k = 0;
  const pendingDel = [], pendingIns = [];
  const flush = () => {
    const used = new Set();
    const pairs = [];
    for (const d of pendingDel) {
      let best = -1, bs = 0.5;
      for (const [bi, ins] of pendingIns.entries()) {
        if (used.has(bi)) continue;
        const s = alike(A[d].t, B[ins].t);
        if (s >= bs) { bs = s; best = bi; }
      }
      if (best >= 0) { used.add(best); pairs.push([d, pendingIns[best]]); }
    }
    // Keep the order: walk dels and inss, emitting pairs where the del sits.
    const pairOfDel = new Map(pairs.map(([d, i]) => [d, i]));
    const pairedIns = new Set(pairs.map(([, i]) => i));
    let ii = 0;
    for (const d of pendingDel) {
      if (pairOfDel.has(d)) {
        const target = pairOfDel.get(d);
        while (ii < pendingIns.length && pendingIns[ii] !== target) { if (!pairedIns.has(pendingIns[ii])) rows.push({ op: 'ins', b: pendingIns[ii] }); ii++; }
        ii++;
        rows.push({ op: 'chg', a: d, b: target, words: wordDiff(A[d].t, B[target].t) });
      } else rows.push({ op: 'del', a: d });
    }
    for (; ii < pendingIns.length; ii++) if (!pairedIns.has(pendingIns[ii])) rows.push({ op: 'ins', b: pendingIns[ii] });
    pendingDel.length = 0; pendingIns.length = 0;
  };
  for (; k < ops.length; k++) {
    const o = ops[k];
    if (o.op === 'eq') { flush(); rows.push(o); }
    else if (o.op === 'del') pendingDel.push(o.a);
    else pendingIns.push(o.b);
  }
  flush();
  // Moves: a deleted unit that was added elsewhere (same or >= 0.9 alike).
  const dels = rows.filter((r) => r.op === 'del');
  const inss = rows.filter((r) => r.op === 'ins');
  let moveId = 0;
  for (const d of dels) {
    const nd = norm(A[d.a].t);
    const hit = inss.find((x) => !x.moved && (norm(B[x.b].t) === nd || (nd.length > 30 && jaccard(A[d.a].t, B[x.b].t) >= 0.9)));
    if (hit) { moveId++; d.op = 'mvdel'; hit.op = 'mvins'; d.moved = hit.moved = moveId; d.to = hit.b; hit.from = d.a; d.same = hit.same = norm(B[hit.b].t) === nd; }
  }
  return { A, B, secA, secB, rows };
}

function summarise(cmp) {
  const { A, B, secA, secB, rows } = cmp;
  const items = [];
  const cut = (t, n = 70) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const add = (kind, detail, row) => items.push({ kind, detail, row });
  let wAdd = 0, wDel = 0;
  const wc = (t) => (t.match(/[A-Za-z0-9][\w'-]*/g) || []).length;
  const isHeader = (t) => /^(#{1,6}\s+.+|\**[A-Z][\w /'-]{0,30}\**:)$/.test(t.trim());
  const exCount = { added: 0, removed: 0, changed: 0, row: null };
  rows.forEach((r, ri) => {
    const ta = r.a != null ? A[r.a].t : '', tb = r.b != null ? B[r.b].t : '';
    if ((r.op === 'ins' && secB[r.b] === 'examples') || (r.op === 'del' && secA[r.a] === 'examples') || (r.op === 'chg' && (secA[r.a] === 'examples' || secB[r.b] === 'examples'))) {
      if (r.op === 'ins') { wAdd += wc(tb); exCount.added++; } else if (r.op === 'del') { wDel += wc(ta); exCount.removed++; } else {
        exCount.changed++; for (const w of r.words) { if (w.op === 'ins') wAdd += wc(w.t); if (w.op === 'del') wDel += wc(w.t); }
      }
      if (exCount.row == null) exCount.row = ri;
      return;
    }
    if ((r.op === 'ins' && isHeader(tb)) || (r.op === 'del' && isHeader(ta))) {
      if (r.op === 'ins') wAdd += wc(tb); else wDel += wc(ta);
      add(r.op === 'ins' ? 'section added' : 'section removed', `"${cut(r.op === 'ins' ? tb : ta, 40)}"`, ri);
      return;
    }
    if (r.op === 'ins') { wAdd += wc(B[r.b].t); if (isInstruction(secB[r.b])) add('instruction added', `${LABEL[secB[r.b]]}: "${cut(B[r.b].t)}"`, ri); else if (secB[r.b] === 'examples') add('example changed', `added: "${cut(B[r.b].t)}"`, ri); }
    if (r.op === 'del') { wDel += wc(A[r.a].t); if (isInstruction(secA[r.a])) add('instruction removed', `${LABEL[secA[r.a]]}: "${cut(A[r.a].t)}"`, ri); else if (secA[r.a] === 'examples') add('example changed', `removed: "${cut(A[r.a].t)}"`, ri); }
    if (r.op === 'mvins') add('moved', `"${cut(B[r.b].t, 50)}" from line ${A[r.from].line} to line ${B[r.b].line}${r.same ? '' : ' (and edited)'}`, ri);
    if (r.op === 'chg') {
      for (const w of r.words) { if (w.op === 'ins') wAdd += wc(w.t); if (w.op === 'del') wDel += wc(w.t); }
      const ma = modalsOf(A[r.a].t), mb = modalsOf(B[r.b].t);
      const na = NUMS(A[r.a].t), nb = NUMS(B[r.b].t);
      const modal = ma.join() !== mb.join(), num = na.join() !== nb.join() && isInstruction(secB[r.b]);
      if (modal || num) {
        const bits = [modal && `${ma.join('/') || '(none)'} → ${mb.join('/') || '(none)'}`, num && `${na.join('/') || '(none)'} → ${nb.join('/') || '(none)'}`].filter(Boolean);
        add('rule changed', `${bits.join(', ')}: "${cut(B[r.b].t, 60)}"`, ri);
      }
      else if (secB[r.b] === 'examples' || secA[r.a] === 'examples') add('example changed', `"${cut(B[r.b].t)}"`, ri);
      else if (isInstruction(secB[r.b])) add('instruction reworded', `"${cut(B[r.b].t)}"`, ri);
      else add('text reworded', `"${cut(B[r.b].t)}"`, ri);
    }
  });
  if (exCount.row != null) {
    const bits = [exCount.added && `${exCount.added} line${exCount.added > 1 ? 's' : ''} added`, exCount.removed && `${exCount.removed} removed`, exCount.changed && `${exCount.changed} changed`].filter(Boolean);
    const at = items.findIndex((it) => it.row > exCount.row);
    const it = { kind: 'example changed', detail: `examples: ${bits.join(', ')}`, row: exCount.row };
    if (at < 0) items.push(it); else items.splice(at, 0, it);
  }
  const fmtChanged = rows.some((r) => (r.a != null && secA[r.a] === 'format' && r.op !== 'eq') || (r.b != null && secB[r.b] === 'format' && r.op !== 'eq' && r.op !== 'mvins'));
  const exChanged = rows.some((r) => (r.a != null && secA[r.a] === 'examples' && r.op !== 'eq') || (r.b != null && secB[r.b] === 'examples' && r.op !== 'eq'));
  // Tokens per section
  const per = {};
  for (const s of SECTIONS) per[s] = { a: 0, b: 0 };
  A.forEach((u, i) => { per[secA[i]].a += tokens(u.t); });
  B.forEach((u, i) => { per[secB[i]].b += tokens(u.t); });
  return { items, wAdd, wDel, fmtChanged, exChanged, per };
}

// ---------------------------------------------------------------- unified diff
export function unified(a, b, la = 'a', lb = 'b', ctxN = 3) {
  if (a === b) return '';
  const split = (t) => { const l = t.split('\n'); if (l.length > 1 && l[l.length - 1] === '') l.pop(); return l; };
  const A = split(a), B = split(b);
  const ops = lcs(A, B);
  const hunks = [];
  let cur = null, lastChange = -1e9;
  ops.forEach((o, idx) => {
    if (o.op !== 'eq') {
      if (!cur || idx - lastChange > ctxN * 2 + 1) {
        cur = { ops: [] };
        hunks.push(cur);
        for (let k = Math.max(0, idx - ctxN); k < idx; k++) if (ops[k].op === 'eq' && !cur.ops.includes(ops[k])) cur.ops.push(ops[k]);
      } else for (let k = lastChange + 1; k < idx; k++) cur.ops.push(ops[k]);
      cur.ops.push(o); lastChange = idx;
      cur.end = idx;
    }
  });
  for (const hk of hunks) for (let k = hk.end + 1; k < Math.min(ops.length, hk.end + 1 + ctxN); k++) { if (ops[k].op !== 'eq') break; hk.ops.push(ops[k]); }
  const out = [`--- ${la}`, `+++ ${lb}`];
  for (const hk of hunks) {
    const aLines = hk.ops.filter((o) => o.op !== 'ins'), bLines = hk.ops.filter((o) => o.op !== 'del');
    const aStart = aLines.length ? aLines[0].a + 1 : (hk.ops.find((o) => o.b != null)?.b ?? 0);
    const bStart = bLines.length ? bLines[0].b + 1 : (hk.ops.find((o) => o.a != null)?.a ?? 0);
    out.push(`@@ -${aStart}${aLines.length === 1 ? '' : ',' + aLines.length} +${bStart}${bLines.length === 1 ? '' : ',' + bLines.length} @@`);
    for (const o of hk.ops) out.push(o.op === 'eq' ? ' ' + A[o.a] : o.op === 'del' ? '-' + A[o.a] : '+' + B[o.b]);
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- history
export function parseHistory(text) {
  const problems = [];
  const t = String(text || '').trim();
  if (!t) return { versions: [], problems };
  let v;
  try { v = JSON.parse(t); } catch (e) { return { versions: [], problems: [`The history is not valid JSON (${e.message}). It is a list: [{"label", "note", "at", "text"}].`] }; }
  if (!Array.isArray(v)) v = v && Array.isArray(v.history) ? v.history : [v];
  const versions = [];
  v.forEach((x, i) => {
    if (typeof x === 'string') { versions.push({ label: `v${i + 1}`, note: '', at: '', text: x }); return; }
    if (!x || typeof x.text !== 'string') { problems.push(`Version ${i + 1} has no "text"; skipped.`); return; }
    versions.push({ label: String(x.label || `v${i + 1}`), note: String(x.note || ''), at: String(x.at || ''), text: x.text.replace(/\r\n?/g, '\n') });
  });
  return { versions, problems };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function run(input) {
  const warnings = [];
  const H = parseHistory(input.history);
  warnings.push(...H.problems);
  const vs = H.versions;
  const direct = String(input.left ?? '').trim() !== '' || String(input.right ?? '').trim() !== '';
  const n = vs.length;
  const pick = (x, dflt) => {
    const k = Number.isFinite(x) ? Math.round(x) : dflt;
    return Math.min(Math.max(1, k), Math.max(1, n));
  };
  let ia = pick(input.from, Math.max(1, n - 1)), ib = pick(input.to, n);
  if (!direct && Number.isFinite(input.from) && (input.from < 1 || input.from > n)) warnings.push(`Version ${input.from} does not exist (1…${n}); using ${ia}.`);
  if (!direct && Number.isFinite(input.to) && (input.to < 1 || input.to > n)) warnings.push(`Version ${input.to} does not exist (1…${n}); using ${ib}.`);
  let A, B, la, lb;
  if (direct) {
    A = { label: 'left', text: String(input.left ?? '').replace(/\r\n?/g, '\n'), note: '', at: '' };
    B = { label: 'right', text: String(input.right ?? '').replace(/\r\n?/g, '\n'), note: '', at: '' };
    la = 'left'; lb = 'right'; ia = ib = 0;
  } else if (n) {
    A = vs[ia - 1]; B = vs[ib - 1]; la = A.label; lb = B.label;
  } else {
    A = B = { label: '', text: '', note: '', at: '' }; la = 'A'; lb = 'B';
    warnings.push('No versions: paste two prompts as left and right, or give a history.');
  }
  if (!direct && n && ia === ib) warnings.push(`Both sides are ${la}: pick two different versions to see a difference.`);
  if (!direct && ia > ib) warnings.push(`Comparing a newer version (${la}) against an older one (${lb}): additions and removals are reversed.`);

  const cmp = compare(A.text, B.text);
  const sum = summarise(cmp);
  const tA = tokens(A.text), tB = tokens(B.text);
  const count = (op) => cmp.rows.filter((r) => r.op === op).length;
  const nChg = count('chg'), nDel = count('del'), nIns = count('ins'), nMv = count('mvins');

  // Timeline: each version against the one before it.
  const timeline = vs.map((v, i) => {
    const tk = tokens(v.text);
    if (!i) return { i: i + 1, label: v.label, at: v.at, note: v.note, tokens: tk, delta: null, add: 0, del: 0 };
    const c = compare(vs[i - 1].text, v.text);
    const s = summarise(c);
    return { i: i + 1, label: v.label, at: v.at, note: v.note, tokens: tk, delta: tk - tokens(vs[i - 1].text), add: s.wAdd, del: s.wDel,
      kinds: [...new Set(s.items.map((x) => x.kind))] };
  });
  const byKind = {};
  for (const it of sum.items) (byKind[it.kind] ||= []).push(it.detail);

  const changelog = ['# Prompt changelog', ''];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const t = timeline[i];
    changelog.push(`## ${t.label}${t.at ? ` (${t.at})` : ''}`, '');
    if (t.note) changelog.push(t.note, '');
    if (i === 0) changelog.push(`- First version, ~${t.tokens} tokens.`, '');
    else {
      const c = compare(vs[i - 1].text, vs[i].text);
      const s = summarise(c);
      changelog.push(`- ~${t.tokens} tokens (${t.delta >= 0 ? '+' : ''}${t.delta}), ${plural(s.wAdd, 'word')} added, ${plural(s.wDel, 'word')} removed.`);
      for (const it of s.items.slice(0, 12)) changelog.push(`- ${it.kind}: ${it.detail}`);
      if (s.fmtChanged) changelog.push('- Output format changed.');
      changelog.push('');
    }
  }

  const perRows = SECTIONS.filter((s) => sum.per[s].a || sum.per[s].b).map((s) => [LABEL[s], sum.per[s].a, sum.per[s].b, sum.per[s].b - sum.per[s].a]);
  const udiff = unified(A.text, B.text, `a/${la}`, `b/${lb}`);
  return {
    values: [
      { label: `Tokens ${la} → ${lb}`, value: `${tA} → ${tB}`, hint: `${tB - tA >= 0 ? '+' : ''}${tB - tA} (estimate)`, tone: tB - tA > tA * 0.5 && tA > 0 ? 'warn' : undefined },
      { label: 'Words', value: `+${sum.wAdd} / −${sum.wDel}` },
      { label: 'Sentences', value: `${nChg} changed · ${nIns} added · ${nDel} removed · ${nMv} moved` },
      { label: 'Instructions', value: `+${(byKind['instruction added'] || []).length} / −${(byKind['instruction removed'] || []).length}`, hint: `${(byKind['rule changed'] || []).length} rule${(byKind['rule changed'] || []).length === 1 ? '' : 's'} changed` },
      { label: 'Output format', value: sum.fmtChanged ? 'changed' : 'unchanged', tone: sum.fmtChanged ? 'warn' : 'ok' },
      { label: 'Examples', value: sum.exChanged ? 'changed' : 'unchanged', tone: sum.exChanged ? 'warn' : 'ok' },
    ].map((v) => (v.tone === undefined ? (({ tone, ...r }) => r)(v) : v)),
    tables: [
      { title: `What changed, ${la} → ${lb}`, columns: ['Kind', 'Detail'], rows: sum.items.map((it) => [it.kind, it.detail]) },
      { title: 'Tokens per section', columns: ['Section', la || 'A', lb || 'B', 'Change'], rows: perRows },
      { title: 'Versions', columns: ['#', 'Label', 'Date', 'Tokens', 'Change', 'Why'], rows: timeline.map((t) => [t.i, t.label, t.at, t.tokens, t.delta == null ? '' : `${t.delta >= 0 ? '+' : ''}${t.delta}`, t.note]) },
    ],
    texts: [
      { title: 'Unified diff', body: udiff || '(no difference)\n', lang: 'diff' },
      { title: 'Changelog', body: changelog.join('\n').trim() + '\n', lang: 'markdown' },
    ],
    warnings,
    notes: [
      'Sentences are aligned by longest common subsequence; a removed sentence found again elsewhere is shown as moved; similar sentences (half their words shared) are diffed word by word.',
      '"Rule changed" means the modal verbs (must, should, never, always, may, only…) or the numbers in an instruction changed - a limit or its strength.',
      'Sections are guessed from headers, XML tags and wording. Token counts are estimates (chars/4 and a word-piece heuristic), not the model\'s tokenizer.',
      'The unified diff is line based (GNU diff -u format) and can be applied with patch.',
    ],
    diff: {
      direct, ia, ib, la, lb,
      a: cmp.A.map((u, i) => ({ t: u.t, line: u.line, gap: u.gap, first: u.first, indent: u.indent, sec: cmp.secA[i] })),
      b: cmp.B.map((u, i) => ({ t: u.t, line: u.line, gap: u.gap, first: u.first, indent: u.indent, sec: cmp.secB[i] })),
      rows: cmp.rows.map((r, ri) => ({ ...r, kind: sum.items.find((it) => it.row === ri)?.kind || null })),
      per: SECTIONS.map((s) => ({ sec: s, label: LABEL[s], a: sum.per[s].a, b: sum.per[s].b })).filter((x) => x.a || x.b),
      items: sum.items, tokensA: tA, tokensB: tB, wAdd: sum.wAdd, wDel: sum.wDel,
      timeline,
    },
  };
}
