// Specificity of two CSS selectors and which one wins, per Selectors Level 4
// (W3C, section 17 "Calculating a selector's specificity") and the cascade
// order of CSS Cascading Level 5 (section 6):
//   a = ID selectors
//   b = class selectors, attribute selectors and pseudo-classes
//   c = type selectors and pseudo-elements
//   *, combinators and :where() count 0.
//   :is(), :not(), :has() count as their most specific argument.
//   :nth-child(An+B of S) / :nth-last-child count one pseudo-class plus S.
//   ::slotted(S), :host(S), :host-context(S) count one pseudo plus S.
// Cascade: !important beats normal; then (both equal) higher specificity; then
// the one later in the stylesheet.

const LEGACY_PE = new Set(['before', 'after', 'first-line', 'first-letter']);
const MAX_ARG = new Set(['is', 'not', 'has', 'matches', '-webkit-any', '-moz-any']);
const ZERO = new Set(['where']);
const NTH = new Set(['nth-child', 'nth-last-child']);
const HOST = new Set(['host', 'host-context']);

const add = (x, y) => [x[0] + y[0], x[1] + y[1], x[2] + y[2]];
const cmp = (x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);
const str = (s) => `(${s.join(', ')})`;

// Split at top-level commas (not inside (), [] or strings).
function splitList(text) {
  const out = [];
  let depth = 0, q = '', cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { cur += ch; if (ch === '\\') { cur += text[++i] ?? ''; } else if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '\\') { cur += ch + (text[++i] ?? ''); continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const identStart = (ch) => /[A-Za-z_ -￿\\-]/.test(ch || '');
function readIdent(t, i) {
  let j = i, s = '';
  while (j < t.length) {
    const ch = t[j];
    if (ch === '\\') { s += t.slice(j, j + 2); j += 2; continue; }
    if (/[A-Za-z0-9_ -￿-]/.test(ch)) { s += ch; j++; continue; }
    break;
  }
  return [s, j];
}
// From an opening bracket at i, the index just past its match.
function readGroup(t, i, open, close) {
  let depth = 0, q = '';
  for (let j = i; j < t.length; j++) {
    const ch = t[j];
    if (q) { if (ch === '\\') j++; else if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '\\') { j++; continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return j + 1;
  }
  return -1;
}

// Most specific selector in a list (for :is/:not/:has and friends).
function maxOf(list, errs, forgiving) {
  let best = [0, 0, 0], bestSel = '';
  for (const sel of splitList(list)) {
    if (!sel) { if (!forgiving) errs.push('empty selector in an argument list'); continue; }
    const e = [];
    const r = complex(sel, e);
    if (e.length) { if (!forgiving) errs.push(...e); continue; }
    if (cmp(r.spec, best) > 0) { best = r.spec; bestSel = sel; }
  }
  return { spec: best, sel: bestSel };
}

// One complex selector (no top-level commas) -> {spec, parts}.
function complex(sel, errs) {
  const t = sel.trim();
  let spec = [0, 0, 0];
  const parts = [];
  const push = (text, kind, s) => { parts.push({ text, kind, adds: s }); spec = add(spec, s); };
  if (!t) { errs.push('empty selector'); return { spec, parts }; }
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '>' || ch === '+' || ch === '~') { i++; continue; }
    if (ch === '|' && t[i + 1] === '|') { i += 2; continue; }
    if (ch === '*') {
      if (t[i + 1] === '|' && t[i + 2] !== '|') { i += 2; continue; }        // *|type namespace
      push('*', 'universal', [0, 0, 0]); i++; continue;
    }
    if (ch === '&') { push('&', 'nesting (counts as its parent, not included)', [0, 0, 0]); i++; continue; }
    if (ch === '#') {
      const [id, j] = readIdent(t, i + 1);
      if (!id) { errs.push(`"#" without a name at position ${i + 1}`); return { spec, parts }; }
      push('#' + id, 'ID', [1, 0, 0]); i = j; continue;
    }
    if (ch === '.') {
      const [c, j] = readIdent(t, i + 1);
      if (!c) { errs.push(`"." without a class name at position ${i + 1}`); return { spec, parts }; }
      push('.' + c, 'class', [0, 1, 0]); i = j; continue;
    }
    if (ch === '[') {
      const j = readGroup(t, i, '[', ']');
      if (j < 0) { errs.push('an attribute selector "[" is not closed'); return { spec, parts }; }
      push(t.slice(i, j), 'attribute', [0, 1, 0]); i = j; continue;
    }
    if (ch === ':') {
      const el = t[i + 1] === ':';
      const [name0, j0] = readIdent(t, i + (el ? 2 : 1));
      const name = name0.toLowerCase();
      if (!name) { errs.push(`"${el ? '::' : ':'}" without a name at position ${i + 1}`); return { spec, parts }; }
      let j = j0, arg = null;
      if (t[j] === '(') {
        const k = readGroup(t, j, '(', ')');
        if (k < 0) { errs.push(`":${name}(" is not closed`); return { spec, parts }; }
        arg = t.slice(j + 1, k - 1); j = k;
      }
      const text = t.slice(i, j);
      if (el) {
        let s = [0, 0, 1], kind = 'pseudo-element';
        if (arg != null && name === 'slotted') { const m = maxOf(arg, errs, false); s = add(s, m.spec); kind += ` + its argument ${str(m.spec)}`; }
        push(text, kind, s);
      } else if (LEGACY_PE.has(name) && arg == null) {
        push(text, 'pseudo-element (legacy one-colon form)', [0, 0, 1]);
      } else if (ZERO.has(name)) {
        if (arg == null) errs.push(':where needs an argument');
        push(text, ':where() always counts 0', [0, 0, 0]);
      } else if (MAX_ARG.has(name)) {
        if (arg == null) { errs.push(`:${name} needs an argument`); return { spec, parts }; }
        const m = maxOf(arg, errs, name !== 'not');
        push(text, `its most specific argument${m.sel ? ` "${m.sel}"` : ''}`, m.spec);
      } else if (NTH.has(name) && arg != null && /\sof\s/i.test(arg)) {
        const sub = arg.split(/\sof\s/i).slice(1).join(' of ');
        const m = maxOf(sub, errs, false);
        push(text, `pseudo-class + "of" list ${str(m.spec)}`, add([0, 1, 0], m.spec));
      } else if (HOST.has(name) && arg != null) {
        const m = maxOf(arg, errs, false);
        push(text, `pseudo-class + its argument ${str(m.spec)}`, add([0, 1, 0], m.spec));
      } else {
        push(text, 'pseudo-class', [0, 1, 0]);
      }
      i = j; continue;
    }
    if (identStart(ch)) {
      const [name, j] = readIdent(t, i);
      if (t[j] === '|' && t[j + 1] !== '|' && t[j + 1] !== '=') { i = j + 1; continue; }   // ns|type
      push(name, 'type', [0, 0, 1]); i = j; continue;
    }
    if (ch === '|') { i++; continue; }
    errs.push(`unexpected "${ch}" at position ${i + 1}`);
    return { spec, parts };
  }
  return { spec, parts };
}

function analyse(text) {
  const errs = [];
  const raw = String(text || '').trim().replace(/\s*\{[\s\S]*$/, '');   // allow a pasted rule "sel { … }"
  if (!raw) return { errs: ['empty'], list: [], spec: [0, 0, 0] };
  const list = splitList(raw).map((sel) => ({ sel, ...complex(sel, errs) }));
  const best = list.reduce((a, b) => (cmp(b.spec, a.spec) > 0 ? b : a), list[0]);
  return { errs, list, spec: best.spec, best };
}

export function run({ a, b, importantA, importantB, bLater }) {
  const warnings = [];
  const A = analyse(a), B = analyse(b);
  for (const [n, X] of [['A', A], ['B', B]]) {
    if (X.errs[0] === 'empty') warnings.push(`Selector ${n} is empty: type a selector such as .card > h2.`);
    else if (X.errs.length) warnings.push(`Selector ${n}: ${X.errs.join('; ')}. Its count may be off; check the selector.`);
  }
  for (const [n, X] of [['A', A], ['B', B]]) {
    if (X.list.length > 1) warnings.push(`Selector ${n} is a list of ${X.list.length}: each one counts on its own. The most specific (${str(X.spec)}, "${X.best.sel}") is used here; an element matched only by another one gets that one's specificity.`);
    if (X.list.some((x) => x.parts.some((p) => p.text === '&'))) warnings.push(`Selector ${n} uses "&": in nested CSS it counts as :is(parent selector); add the parent's specificity by hand.`);
  }

  let winner, why;
  const c = cmp(A.spec, B.spec);
  if (importantA !== importantB) {
    winner = importantA ? 'A' : 'B';
    why = `${winner} has !important, which beats any specificity of a normal declaration.`;
  } else if (c !== 0) {
    winner = c > 0 ? 'A' : 'B';
    const k = A.spec[0] !== B.spec[0] ? 0 : A.spec[1] !== B.spec[1] ? 1 : 2;
    const what = ['IDs', 'classes, attributes and pseudo-classes', 'types and pseudo-elements'][k];
    why = `${winner} has more ${what} (${(c > 0 ? A : B).spec[k]} against ${(c > 0 ? B : A).spec[k]})${k > 0 ? `, and the columns before it are equal` : ''}${importantA ? '; both are !important' : ''}.`;
  } else {
    winner = bLater ? 'B' : 'A';
    why = `Equal specificity ${str(A.spec)}${importantA ? ' and both !important' : ''}: the one later in the stylesheet wins, which is ${winner}.`;
  }

  const rowsFor = (n, X) => X.list.flatMap((x) => x.parts.map((p) => [n + (X.list.length > 1 ? ` "${x.sel}"` : ''), p.text, p.kind, str(p.adds)]));
  return {
    values: [
      { label: 'Selector A', value: str(A.spec), hint: importantA ? '!important' : 'IDs, classes, types', tone: winner === 'A' ? 'ok' : undefined },
      { label: 'Selector B', value: str(B.spec), hint: importantB ? '!important' : 'IDs, classes, types', tone: winner === 'B' ? 'ok' : undefined },
      { label: 'Winner', value: winner, hint: c === 0 && importantA === importantB ? 'by source order' : importantA !== importantB ? 'by !important' : 'by specificity', tone: 'ok' },
    ],
    warnings,
    tables: [
      { title: 'Why', columns: ['', 'IDs (a)', 'Classes (b)', 'Types (c)'], rows: [['A', ...A.spec], ['B', ...B.spec]] },
      { title: 'How each part counts', columns: ['Selector', 'Part', 'Counts as', 'Adds'], rows: [...rowsFor('A', A), ...rowsFor('B', B)] },
    ],
    notes: [
      why,
      'Compare left to right: one ID beats any number of classes; one class beats any number of types. Combinators and * add nothing.',
      'Before specificity the cascade checks origin, !important, cascade layers (@layer: unlayered normal styles beat layered ones) and @scope proximity; inline style="" beats every selector.',
    ],
  };
}
