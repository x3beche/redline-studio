// Prompt Template & Variables: a template with {{variables}} rendered once per
// data row, every render checked.
//
// Pure: no DOM, no clock, no randomness.
//
// The template language is a small, documented subset of Mustache /
// Handlebars (mustache(5) manual, handlebarsjs.com "Built-in helpers"):
//   {{name}}                 the row's value; {{ a.b }} reads a field of a JSON object
//   {{name|default text}}    the default when the value is missing or empty (not Mustache: a
//                            Jinja-like filter spelled the short way)
//   {{#if name}}…{{else}}…{{/if}}     Handlebars #if: false for missing, "", false, 0, no, null
//                                     and an empty list
//   {{#unless name}}…{{/unless}}      the opposite
//   {{#each name}}…{{/each}}          once per list item; {{.}} or {{this}} is the item,
//                                     {{field}} a field of an object item, {{@index}} counts from
//                                     0 (Handlebars), {{@number}} from 1 (added here)
//   {{! comment}}            removed
// Differences from Mustache: values are inserted as they are (no HTML
// escaping, so {{{x}}} and {{x}} are the same); a block tag alone on its line
// takes its line with it (Mustache "standalone" rule).
// A CSV cell used by #each is split on the list separator (default ";").

import { fmtNum } from '../kit/eng.js';

// ---------------------------------------------------------------- tokens
/** Token estimate: the mean of chars/4 and a word-piece count shaped like
 *  o200k/cl100k (a short word is one token, long words split every ~5
 *  letters, digits in threes, punctuation one each). Not a tokenizer. */
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

// ---------------------------------------------------------------- template
const lineOf = (text, pos) => text.slice(0, pos).split('\n').length;

/** Parse the template into a tree, the tag positions for the page, and errors. */
export function parseTemplate(src) {
  const tags = [];
  const errors = [];
  const re = /\{\{\{?\s*([#/!^]?)\s*([^}]*?)\s*\}?\}\}/g;
  const root = { t: 'root', body: [] };
  const stack = [root];
  let last = 0, m;
  const cur = () => stack[stack.length - 1];
  const pushText = (s, e) => { if (e > s) cur().body.push({ t: 'text', v: src.slice(s, e), s, e }); };
  while ((m = re.exec(src))) {
    let s = m.index, e = m.index + m[0].length;
    const sig = m[1], body = m[2];
    const block = sig === '#' || sig === '/' || sig === '!' || /^else$/i.test(body);
    // Mustache "standalone": a block tag alone on its line drops that line.
    let ts = s, te = e;
    if (block) {
      const ls = src.lastIndexOf('\n', s - 1) + 1;
      let le = src.indexOf('\n', e); if (le < 0) le = src.length;
      if (!src.slice(ls, s).trim() && !src.slice(e, le).trim()) { ts = ls; te = le < src.length ? le + 1 : le; }
    }
    pushText(last, ts);
    last = te;
    if (sig === '!') { tags.push({ s, e, kind: 'comment' }); continue; }
    if (sig === '#') {
      const mm = /^(if|unless|each)\s+([\w.@-]+)$/i.exec(body);
      if (!mm) { errors.push({ s, e, msg: `Line ${lineOf(src, s)}: "{{#${body}}}" is not a block this subset knows (#if, #unless, #each followed by one name).` }); tags.push({ s, e, kind: 'error' }); continue; }
      const kind = mm[1].toLowerCase();
      const node = kind === 'each' ? { t: 'each', name: mm[2], body: [], s, e } : { t: 'if', neg: kind === 'unless', name: mm[2], body: [], alt: null, s, e };
      cur().body.push(node);
      stack.push(node);
      tags.push({ s, e, kind: 'open', block: kind, name: mm[2] });
      continue;
    }
    if (sig === '/') {
      const want = body.toLowerCase();
      const top = cur();
      const topKind = top.t === 'each' ? 'each' : top.t === 'if' ? (top.neg ? 'unless' : 'if') : null;
      if (top.t === 'root') { errors.push({ s, e, msg: `Line ${lineOf(src, s)}: {{/${body}}} closes nothing.` }); tags.push({ s, e, kind: 'error' }); continue; }
      if (want !== topKind) errors.push({ s, e, msg: `Line ${lineOf(src, s)}: {{/${body}}} closes {{#${topKind} ${top.name}}} from line ${lineOf(src, top.s)}.` });
      if (top.inAlt) top.alt = top.body, top.body = top.yes;
      stack.pop();
      tags.push({ s, e, kind: 'close', block: topKind, name: top.name });
      continue;
    }
    if (/^else$/i.test(body)) {
      const top = cur();
      if (top.t !== 'if' || top.inAlt) { errors.push({ s, e, msg: `Line ${lineOf(src, s)}: {{else}} outside an {{#if}}.` }); tags.push({ s, e, kind: 'error' }); continue; }
      top.yes = top.body; top.body = []; top.inAlt = true;
      tags.push({ s, e, kind: 'else' });
      continue;
    }
    // a value
    const vm = /^([\w.@-]+|\.)\s*(?:\|\s*([\s\S]*))?$/.exec(body);
    if (!vm) { errors.push({ s, e, msg: `Line ${lineOf(src, s)}: "{{${body}}}" is not a variable name.` }); tags.push({ s, e, kind: 'error' }); cur().body.push({ t: 'text', v: m[0], s, e }); continue; }
    const name = vm[1] === 'this' ? '.' : vm[1];
    cur().body.push({ t: 'var', name, def: vm[2] ?? null, s, e });
    tags.push({ s, e, kind: 'var', name, def: vm[2] ?? null });
  }
  pushText(last, src.length);
  while (stack.length > 1) {
    const top = stack.pop();
    if (top.inAlt) { top.alt = top.body; top.body = top.yes; }
    errors.push({ s: top.s, e: top.e, msg: `Line ${lineOf(src, top.s)}: {{#${top.t === 'each' ? 'each' : top.neg ? 'unless' : 'if'} ${top.name}}} is never closed.` });
  }
  // Leftover single braces that look like a typo: {name} or {{name}
  const typo = /(^|[^{])\{([A-Za-z_]\w*)\}(?!\})|\{\{([A-Za-z_]\w*)\}(?!\})/g;
  while ((m = typo.exec(src))) {
    if (tags.some((t) => m.index >= t.s && m.index < t.e)) continue;
    const at = m.index + (m[1] ? m[1].length : 0);
    errors.push({ s: at, e: m.index + m[0].length, msg: `Line ${lineOf(src, at)}: "${m[0].trim()}" looks like a variable with a missing brace; it will be sent as it is.`, soft: true });
  }
  return { root, tags, errors };
}

function walkNames(nodes, out, inEach) {
  for (const n of nodes) {
    if (n.t === 'var' && n.name !== '.' && !n.name.startsWith('@')) out.push({ name: n.name, def: n.def, inEach, cond: false });
    if (n.t === 'if') { out.push({ name: n.name, inEach, cond: true }); walkNames(n.body, out, inEach); if (n.alt) walkNames(n.alt, out, inEach); }
    if (n.t === 'each') { out.push({ name: n.name, inEach, list: true }); walkNames(n.body, out, n.name); }
  }
}

// ---------------------------------------------------------------- data
/** RFC 4180 CSV (quotes, "" escapes, line breaks inside quotes) or TSV. */
function parseDelimited(text, delim) {
  const rows = [];
  let row = [], f = '', q = false, i = 0, line = 1;
  const problems = [];
  let quoteLine = 0;
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; }
      if (c === '\n') line++;
      f += c; i++; continue;
    }
    if (c === '"' && f === '') { q = true; quoteLine = line; i++; continue; }
    if (c === delim) { row.push(f); f = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(f); rows.push({ cells: row, line }); row = []; f = ''; i++; line++; continue; }
    f += c; i++;
  }
  if (q) problems.push(`A quoted cell that starts on line ${quoteLine} is never closed; the rest of the data went into it.`);
  if (f !== '' || row.length) { row.push(f); rows.push({ cells: row, line }); }
  return { rows: rows.filter((r) => r.cells.some((c) => c.trim() !== '')), problems };
}

export function parseData(text, listSep = ';') {
  const src = String(text || '').replace(/^﻿/, '');
  const t = src.trim();
  const problems = [];
  if (!t) return { format: 'none', columns: [], rows: [], problems: ['No data: paste CSV, TSV or a JSON array of objects. Each row renders one prompt.'] };
  if (t[0] === '[' || t[0] === '{') {
    let v;
    try { v = JSON.parse(t); } catch (e) {
      const pos = /position (\d+)/.exec(e.message);
      return { format: 'json', columns: [], rows: [], problems: [`The JSON does not parse${pos ? ` (line ${lineOf(t, Number(pos[1]))})` : ''}: ${e.message}.`] };
    }
    if (!Array.isArray(v)) v = [v];
    const rows = [];
    const cols = [];
    v.forEach((o, i) => {
      if (!o || typeof o !== 'object' || Array.isArray(o)) { problems.push(`Item ${i + 1} is not an object; skipped.`); return; }
      for (const k of Object.keys(o)) if (!cols.includes(k)) cols.push(k);
      rows.push({ values: o, line: i + 1 });
    });
    return { format: 'json', columns: cols, rows, problems };
  }
  const first = t.split('\n')[0];
  const delim = first.includes('\t') ? '\t' : (first.split(',').length >= first.split(';').length || listSep === ';') && first.includes(',') ? ',' : first.includes(';') ? ';' : ',';
  const p = parseDelimited(t, delim);
  problems.push(...p.problems);
  if (!p.rows.length) return { format: delim === '\t' ? 'tsv' : 'csv', columns: [], rows: [], problems: [...problems, 'No rows found.'] };
  const header = p.rows[0].cells.map((c, i) => c.trim() || `column${i + 1}`);
  const dup = header.filter((c, i) => header.indexOf(c) !== i);
  if (dup.length) problems.push(`Column names repeat (${[...new Set(dup)].join(', ')}); the later one wins.`);
  const rows = [];
  for (const r of p.rows.slice(1)) {
    if (r.cells.length !== header.length) problems.push(`Line ${r.line}: ${r.cells.length} cell${r.cells.length === 1 ? '' : 's'} for ${header.length} columns${r.cells.length > header.length ? ' (a delimiter inside an unquoted cell?)' : ''}.`);
    const o = {};
    header.forEach((c, i) => { o[c] = r.cells[i] ?? ''; });
    rows.push({ values: o, line: r.line });
  }
  return { format: delim === '\t' ? 'tsv' : 'csv', delim, columns: header, rows, problems };
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** "var = column" pairs, one per line or separated by ;. */
export function parseMapping(text) {
  const map = {}, bad = [];
  for (const raw of String(text || '').split(/[\n;]/)) {
    const l = raw.trim(); if (!l) continue;
    const m = /^([\w.@-]+)\s*(?:=|->|<-|:)\s*(.*)$/.exec(l);
    if (!m) { bad.push(l); continue; }
    map[m[1]] = m[2].trim();
  }
  return { map, bad };
}

// ---------------------------------------------------------------- render
const FALSY = new Set(['', 'false', '0', 'no', 'null', 'none', 'n/a']);
function truthy(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  if (typeof v === 'boolean') return v;
  return !FALSY.has(String(v).trim().toLowerCase());
}
const str = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function renderRow(root, lookup, listSep) {
  let out = '';
  const pieces = [];
  const uses = [];                               // {name, state: 'ok'|'empty'|'missing'|'default'}
  const get = (name, scopes) => {
    if (name === '.') return { found: true, v: scopes[0].item };
    if (name === '@index') return { found: true, v: scopes[0].index };
    if (name === '@number') return { found: true, v: scopes[0].index + 1 };
    for (const sc of scopes) {
      if (sc.item && typeof sc.item === 'object' && !Array.isArray(sc.item)) {
        const v = name.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), sc.item);
        if (v !== undefined) return { found: true, v, field: true };
      }
    }
    return lookup(name);
  };
  const walk = (nodes, scopes) => {
    for (const n of nodes) {
      if (n.t === 'text') { out += n.v; continue; }
      if (n.t === 'var') {
        const r = get(n.name, scopes);
        let v = r.found ? str(r.v) : '';
        let state = !r.found ? 'missing' : v.trim() === '' ? 'empty' : 'ok';
        if (state !== 'ok' && n.def != null) { v = n.def; state = 'default'; }
        if (!r.field && !n.name.startsWith('@') && n.name !== '.') uses.push({ name: n.name, state, mapped: r.mapped !== false });
        const s = out.length; out += v;
        pieces.push({ s, e: out.length, v: n.name, state });
        continue;
      }
      if (n.t === 'if') {
        const r = get(n.name, scopes);
        if (!r.field) uses.push({ name: n.name, state: r.found ? 'cond' : 'missing-cond', mapped: r.mapped !== false });
        const yes = truthy(r.found ? r.v : null) !== !!n.neg;
        walk(yes ? n.body : (n.alt || []), scopes);
        continue;
      }
      if (n.t === 'each') {
        const r = get(n.name, scopes);
        if (!r.field) uses.push({ name: n.name, state: r.found ? (truthy(r.v) ? 'ok' : 'empty-list') : 'missing', mapped: r.mapped !== false });
        let list = r.found ? r.v : [];
        if (typeof list === 'string') list = list.split(listSep).map((x) => x.trim()).filter(Boolean);
        else if (!Array.isArray(list)) list = list == null ? [] : [list];
        list.forEach((item, index) => walk(n.body, [{ item, index }, ...scopes]));
      }
    }
  };
  walk(root.body, []);
  return { text: out, pieces, uses };
}

// ---------------------------------------------------------------- code
const pyStr = (s) => JSON.stringify(s);
const jsTpl = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

function toPython(root, sep) {
  const lines = ['def render(row: dict) -> str:', '    """Equivalent of the template: row maps variable names to values; lists for #each."""', '    out = []'];
  const raw = (name, scope) => {
    if (name === '.') return scope || 'row';
    if (name === '@index') return 'i';
    if (name === '@number') return 'i + 1';
    const keys = name.split('.');
    const src = scope ? `(${scope} if isinstance(${scope}, dict) and ${pyStr(keys[0])} in ${scope} else row)` : 'row';
    return keys.slice(1).reduce((e, k) => `(${e} or {}).get(${pyStr(k)})`, `${src}.get(${pyStr(keys[0])})`);
  };
  const truth = (name, scope) => `truthy(${raw(name, scope)})`;
  const walk = (nodes, ind, scope) => {
    const pad = ' '.repeat(ind);
    for (const n of nodes) {
      if (n.t === 'text') { if (n.v) lines.push(`${pad}out.append(${pyStr(n.v)})`); }
      else if (n.t === 'var') {
        const r = raw(n.name, scope);
        lines.push(`${pad}out.append(${n.name.startsWith('@') ? `str(${r})` : `str(${r} or ${pyStr(n.def ?? '')})`})`);
      }
      else if (n.t === 'if') {
        lines.push(`${pad}if ${n.neg ? 'not ' : ''}${truth(n.name, scope)}:`);
        const before = lines.length; walk(n.body, ind + 4, scope); if (lines.length === before) lines.push(`${pad}    pass`);
        if (n.alt && n.alt.length) { lines.push(`${pad}else:`); walk(n.alt, ind + 4, scope); }
      } else if (n.t === 'each') {
        lines.push(`${pad}items = ${raw(n.name, scope)} or []`, `${pad}if isinstance(items, str):`, `${pad}    items = [x.strip() for x in items.split(${pyStr(sep)}) if x.strip()]`);
        lines.push(`${pad}for i, item in enumerate(items):`);
        const before = lines.length; walk(n.body, ind + 4, 'item'); if (lines.length === before) lines.push(`${pad}    pass`);
      }
    }
  };
  walk(root.body, 4, null);
  lines.push('    return "".join(out)', '', '',
    'def truthy(v) -> bool:',
    '    if isinstance(v, (list, dict)):',
    '        return len(v) > 0',
    '    return str(v if v is not None else "").strip().lower() not in ("", "false", "0", "no", "null", "none", "n/a")');
  return lines.join('\n');
}

function toJs(root, sep) {
  const val = (name, scope) => {
    if (name === '.') return `String(${scope || 'row'})`;
    if (name === '@index') return 'i';
    if (name === '@number') return 'i + 1';
    const path = name.split('.').map((k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `?.${k}` : `?.[${JSON.stringify(k)}]`)).join('');
    return scope ? `((${scope} && typeof ${scope} === 'object' ? ${scope} : row)${path} ?? '')` : `(row${path} ?? '')`;
  };
  const walk = (nodes, scope) => nodes.map((n) => {
    if (n.t === 'text') return jsTpl(n.v);
    if (n.t === 'var') return n.def != null ? `\${${val(n.name, scope)} || ${JSON.stringify(n.def)}}` : `\${${val(n.name, scope)}}`;
    if (n.t === 'if') return `\${${n.neg ? '!' : ''}truthy(${n.name === '.' ? scope : val(n.name, scope)}) ? \`${walk(n.body, scope)}\` : \`${n.alt ? walk(n.alt, scope) : ''}\`}`;
    if (n.t === 'each') return `\${list(${val(n.name, scope)}).map((item, i) => \`${walk(n.body, 'item')}\`).join('')}`;
    return '';
  }).join('');
  return [
    '// Equivalent of the template: row maps variable names to values; lists for #each.',
    "const truthy = (v) => Array.isArray(v) ? v.length > 0 : !['', 'false', '0', 'no', 'null', 'none', 'n/a'].includes(String(v ?? '').trim().toLowerCase());",
    `const list = (v) => Array.isArray(v) ? v : String(v ?? '').split(${JSON.stringify(sep)}).map((x) => x.trim()).filter(Boolean);`,
    '',
    `export const render = (row) => \`${walk(root.body, null)}\`;`,
  ].join('\n');
}

// ---------------------------------------------------------------- run
export function run(input) {
  const tpl = String(input.template ?? '').replace(/\r\n?/g, '\n');
  const listSep = String(input.listSep ?? ';') || ';';
  const limit = Number.isFinite(input.limit) && input.limit > 0 ? input.limit : null;
  const system = String(input.system ?? '').replace(/\r\n?/g, '\n').trim();
  const P = parseTemplate(tpl);
  const D = parseData(input.data, listSep);
  const M = parseMapping(input.mapping);
  const warnings = [], notes = [];

  const refs = [];
  walkNames(P.root.body, refs, null);
  // A name inside #each that is a field of the object items (and not a column) is the item's, not the row's.
  const itemFields = new Set();
  for (const r of refs.filter((x) => x.inEach)) {
    const lists = D.rows.map((row) => row.values[r.inEach]).filter((v) => Array.isArray(v) && v.length);
    if (lists.length && !D.columns.includes(r.name) && lists.some((l) => l.some((it) => it && typeof it === 'object' && r.name.split('.')[0] in it))) itemFields.add(r.name);
  }
  const names = [];
  for (const r of refs) if (!itemFields.has(r.name) && !names.includes(r.name)) names.push(r.name);

  // Bind variables to columns: an explicit mapping first, then the same name.
  const bind = {};
  const colSet = new Set(D.columns);
  for (const n of names) {
    const root = n.split('.')[0];
    if (M.map[n] != null && M.map[n] !== '') {
      bind[n] = colSet.has(M.map[n]) ? { col: M.map[n], how: 'mapped' } : { col: null, how: 'bad-map', want: M.map[n] };
    } else if (M.map[n] === '') bind[n] = { col: null, how: 'off' };
    else {
      const c = D.columns.find((x) => x === root) || D.columns.find((x) => norm(x) === norm(root));
      bind[n] = c ? { col: c, how: 'same name' } : { col: null, how: 'none' };
    }
  }
  const usedCols = new Set(Object.values(bind).map((b) => b.col).filter(Boolean));
  const unused = D.columns.filter((c) => !usedCols.has(c));

  const rows = D.rows.map((row, ri) => {
    const lookup = (name) => {
      const b = bind[name] || bind[name.split('.')[0]];
      if (!b || !b.col) return { found: false, mapped: false };
      let v = row.values[b.col];
      if (name.includes('.') && bind[name]?.col == null) v = name.split('.').slice(1).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), v);
      else if (name.includes('.') && typeof v === 'object') v = name.split('.').slice(1).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), v);
      return v === undefined ? { found: false, mapped: true } : { found: true, v };
    };
    const r = renderRow(P.root, lookup, listSep);
    const tk = tokens((system ? system + '\n' : '') + r.text);
    const firstCol = D.columns[0] ? str(row.values[D.columns[0]]) : '';
    return { i: ri, line: row.line, label: firstCol.slice(0, 40), text: r.text, pieces: r.pieces, uses: r.uses, tokens: tk, chars: r.text.length,
      over: limit != null && tk > limit };
  });

  // Findings
  const F = [];
  for (const e of P.errors) F.push({ sev: e.soft ? 'warn' : 'bad', rule: 'syntax', msg: e.msg, s: e.s, e: e.e });
  for (const n of names) {
    const b = bind[n];
    const hasDef = refs.some((r) => r.name === n && r.def != null);
    const onlyCond = refs.filter((r) => r.name === n).every((r) => r.cond);
    if (b.how === 'bad-map') F.push({ sev: 'bad', rule: 'bad-mapping', msg: `"${n}" is mapped to column "${b.want}", which the data does not have (columns: ${D.columns.join(', ') || 'none'}).`, v: n });
    else if (!b.col && D.rows.length) {
      if (hasDef) F.push({ sev: 'info', rule: 'default-only', msg: `"${n}" has no column; every row uses its default.`, v: n });
      else if (onlyCond) F.push({ sev: 'info', rule: 'never-true', msg: `"${n}" has no column, so {{#if ${n}}} is never true.`, v: n });
      else F.push({ sev: 'bad', rule: 'not-provided', msg: `"${n}" is used but no column provides it: every prompt gets an empty gap there. Map a column to it (drag a column onto the chip) or give a default {{${n}|…}}.`, v: n });
    }
  }
  for (const n of names) {
    if (!bind[n]?.col) continue;
    const empty = rows.filter((r) => r.uses.some((u) => u.name === n && u.state === 'empty')).map((r) => r.i + 1);
    const missing = rows.filter((r) => r.uses.some((u) => u.name === n && u.state === 'missing')).map((r) => r.i + 1);
    const deflt = rows.filter((r) => r.uses.some((u) => u.name === n && u.state === 'default')).map((r) => r.i + 1);
    if (empty.length) F.push({ sev: 'warn', rule: 'empty-value', msg: `"${n}" is empty in row${empty.length > 1 ? 's' : ''} ${empty.join(', ')} and has no default: the prompt says nothing there.`, v: n, rows: empty });
    if (missing.length) F.push({ sev: 'warn', rule: 'missing-value', msg: `"${n}" is missing in row${missing.length > 1 ? 's' : ''} ${missing.join(', ')} (the JSON item has no such key).`, v: n, rows: missing });
    if (deflt.length) F.push({ sev: 'info', rule: 'default-used', msg: `"${n}" falls back to its default in row${deflt.length > 1 ? 's' : ''} ${deflt.join(', ')}.`, v: n, rows: deflt });
  }
  if (unused.length && D.rows.length) F.push({ sev: 'info', rule: 'unused-column', msg: `Column${unused.length > 1 ? 's' : ''} never used: ${unused.join(', ')}. Drop ${unused.length > 1 ? 'them' : 'it'} or use ${unused.length > 1 ? 'them' : 'it'} in the template.`, cols: unused });
  const over = rows.filter((r) => r.over);
  if (over.length) F.push({ sev: 'warn', rule: 'over-limit', msg: `Row${over.length > 1 ? 's' : ''} ${over.map((r) => `${r.i + 1} (${r.tokens})`).join(', ')} exceed${over.length > 1 ? '' : 's'} the ${limit}-token limit.`, rows: over.map((r) => r.i + 1) });
  for (const p of D.problems) F.push({ sev: /never closed|does not parse|No data/.test(p) ? 'bad' : 'warn', rule: 'data', msg: p });
  const leftover = rows.filter((r) => /\{\{[^}]*\}\}/.test(r.text)).map((r) => r.i + 1);
  if (leftover.length) F.push({ sev: 'info', rule: 'braces-in-value', msg: `Rows ${leftover.join(', ')} contain "{{…}}" coming from a value; values are not rendered again, so it goes to the model as written.`, rows: leftover });
  for (const b of M.bad) F.push({ sev: 'warn', rule: 'mapping', msg: `Could not read the mapping "${b}"; write "variable = column".` });
  for (const [k] of Object.entries(M.map)) if (!names.includes(k)) F.push({ sev: 'info', rule: 'mapping', msg: `The mapping for "${k}" is for a variable the template no longer uses.` });
  const order = { bad: 0, warn: 1, info: 2 };
  F.sort((a, b) => order[a.sev] - order[b.sev]);

  for (const f of F.filter((x) => x.sev === 'bad')) warnings.push(f.msg);
  const warnN = F.filter((x) => x.sev === 'warn').length;
  if (warnN) warnings.push(`${warnN} warning${warnN > 1 ? 's' : ''} more in the findings (empty values, rows over the limit, data problems).`);

  // Outputs
  const jsonl = rows.map((r) => JSON.stringify({ messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: r.text }] })).join('\n');
  const tks = rows.map((r) => r.tokens).sort((a, b) => a - b);
  const med = tks.length ? tks[Math.floor((tks.length - 1) / 2)] : 0;
  const vars = names.map((n) => {
    const b = bind[n];
    const ref = refs.find((r) => r.name === n && r.def != null);
    const kind = refs.some((r) => r.name === n && r.list) ? 'list' : refs.filter((r) => r.name === n).every((r) => r.cond) ? 'condition' : 'value';
    const empty = rows.filter((r) => r.uses.some((u) => u.name === n && (u.state === 'empty' || u.state === 'missing' || u.state === 'empty-list'))).length;
    return { name: n, col: b.col, how: b.how, def: ref ? ref.def : null, kind, empty };
  });

  return {
    values: [
      { label: 'Rows rendered', value: rows.length, hint: D.format === 'none' ? 'no data' : `${D.format.toUpperCase()}, ${D.columns.length} columns` },
      { label: 'Variables', value: names.length, hint: `${vars.filter((v) => v.col).length} bound to a column` },
      { label: 'Tokens per prompt', value: rows.length ? `${tks[0]} – ${tks[tks.length - 1]}` : '–', hint: rows.length ? `median ${med}, estimate${system ? ', with the system message' : ''}` : 'estimate' },
      { label: 'Over the limit', value: limit == null ? 'no limit' : `${over.length} of ${rows.length}`, tone: over.length ? 'warn' : 'ok', hint: limit ? `limit ${fmtNum(limit, 6)} tokens` : null },
      { label: 'Findings', value: `${F.filter((f) => f.sev === 'bad').length} bad · ${warnN} warn · ${F.filter((f) => f.sev === 'info').length} info`, tone: F.some((f) => f.sev === 'bad') ? 'bad' : warnN ? 'warn' : 'ok' },
    ],
    tables: [
      { title: 'Variables', columns: ['Variable', 'Use', 'Column', 'Default', 'Rows empty'],
        rows: vars.map((v) => [v.name, v.kind, v.col || (v.how === 'bad-map' ? 'unknown column' : '—'), v.def ?? '', v.col ? v.empty : rows.length]) },
      { title: 'Rows', columns: ['Row', 'First column', 'Tokens', 'Characters', 'Status'],
        rows: rows.map((r) => [r.i + 1, r.label, r.tokens, r.chars, r.over ? 'over the limit' : r.uses.some((u) => u.state === 'empty' || u.state === 'missing') ? 'has empty values' : 'ok']) },
      { title: 'Findings', columns: ['Severity', 'Rule', 'Finding'], rows: F.map((f) => [f.sev, f.rule, f.msg]) },
    ],
    texts: [
      { title: 'JSONL (messages)', body: jsonl + (jsonl ? '\n' : ''), lang: 'json' },
      { title: 'Python', body: toPython(P.root, listSep), lang: 'python' },
      { title: 'JavaScript', body: toJs(P.root, listSep), lang: 'javascript' },
    ],
    warnings,
    notes: [
      'Template syntax: a subset of Mustache/Handlebars ({{x}}, {{#if}}/{{else}}/{{/if}}, {{#unless}}, {{#each}} with {{.}}, {{@index}}) plus {{x|default}}. Values go in unescaped; a block tag alone on a line removes the line.',
      `CSV cells used by {{#each}} are split on "${listSep}". Empty, false, 0, no, null, none and n/a count as false in {{#if}}.`,
      'Token counts are estimates (mean of chars/4 and a word-piece heuristic); the model\'s own tokenizer gives the exact number.',
      'The Python and JavaScript code render the same text from a dict / object per row, so the template can move into code unchanged.',
    ],
    render: {
      tags: P.tags, errors: P.errors.map((e) => ({ s: e.s, e: e.e, msg: e.msg, soft: !!e.soft })),
      vars, columns: D.columns, format: D.format,
      data: D.rows.slice(0, 200).map((r) => D.columns.map((c) => str(r.values[c]))),
      rows: rows.map((r) => ({ i: r.i, label: r.label, text: r.text, pieces: r.pieces, tokens: r.tokens, chars: r.chars, over: r.over,
        empty: [...new Set(r.uses.filter((u) => ['empty', 'missing'].includes(u.state)).map((u) => u.name))],
        defaults: [...new Set(r.uses.filter((u) => u.state === 'default').map((u) => u.name))],
        notProvided: [...new Set(r.uses.filter((u) => !u.mapped && u.state === 'missing').map((u) => u.name))] })),
      findings: F, limit, system, unused,
    },
  };
}
