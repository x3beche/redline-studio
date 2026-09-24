// String table -> platform resource files.
// Input: a CSV/TSV table, header "key,<lang>,<lang>,...[,comment]".
// Output formats and their escaping rules:
//   Android strings.xml  developer.android.com/guide/topics/resources/string-resource
//                        (\' \" \\ \n, &amp; &lt;, a leading @ or ? escaped, names = Java identifiers)
//   iOS .strings         Apple "String Resources" / Localizable.strings: "key" = "value"; with \" \\ \n
//   JSON (flat / nested) i18next-style key -> value objects
//   Flutter ARB          Application Resource Bundle spec (github.com/google/app-resource-bundle):
//                        "@@locale", keys are Dart identifiers, "@key": {description}
// Placeholders compared across languages: printf (%s %d %1$s %@, %%) and ICU/brace ({name}, {{name}}).

const COMMENT_COLS = ['comment', 'comments', 'description', 'desc', 'note', 'notes', 'context'];

/** RFC 4180 style CSV: quoted fields, doubled quotes, newlines inside quotes. */
function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = '', q = false, line = 1, startLine = 1, unclosed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else { if (c === '\n') line++; field += c; }
      continue;
    }
    if (c === '"' && field.trim() === '') { q = true; field = ''; continue; }
    if (c === delim) { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push({ cells: row, line: startLine }); row = []; field = ''; line++; startLine = line; continue; }
    field += c;
  }
  if (q) unclosed = true;
  if (field !== '' || row.length) { row.push(field); rows.push({ cells: row, line: startLine }); }
  return { rows, unclosed };
}

function sniff(firstLine) {
  const counts = { '\t': 0, ';': 0, ',': 0, '|': 0 };
  let q = false;
  for (const c of firstLine) { if (c === '"') q = !q; else if (!q && c in counts) counts[c]++; }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ',';
}

const PH = /%(?:(\d+)\$)?[-#+0,(]*\d*(?:\.\d+)?(?:ll|l|h|z)?([sdifuxXoceEgG@])|\{\{?\s*([A-Za-z_][\w.]*)\s*(?:,[^{}]*)?\}?\}/g;
function placeholders(s) {
  const out = [];
  for (const m of String(s).replace(/%%/g, '').matchAll(PH)) {
    if (m[3]) out.push(`{${m[3]}}`);
    else out.push(`%${m[1] ? m[1] + '$' : ''}${m[2] === '@' || m[2] === 's' ? 's' : /[diu]/.test(m[2]) ? 'd' : m[2]}`);
  }
  return out;
}
const sameBag = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

// ---- escaping per format ----
function androidEscape(v) {
  let s = String(v)
    .replace(/%@/g, '%s').replace(/%(\d+)\$@/g, '%$1$s')
    .replace(/\\/g, '\\\\').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  if (/^[@?]/.test(s)) s = '\\' + s;
  return s;
}
function iosEscape(v) {
  return String(v)
    .replace(/%(\d+\$)?s/g, '%$1@')
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}
const xmlComment = (c) => String(c).replace(/--/g, '- -');

function androidDir(lang, isBase) {
  if (isBase) return 'values';
  const [l, r] = lang.split(/[-_]/);
  return `values-${l.toLowerCase()}${r ? `-r${r.toUpperCase()}` : ''}`;
}

function nest(flat) {
  const out = {};
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split('.');
    let o = out, clash = false;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof o[parts[i]] === 'string') { clash = true; break; }
      o = (o[parts[i]] ||= {});
    }
    if (clash || typeof o[parts[parts.length - 1]] === 'object') return { ok: false, key: k };
    o[parts[parts.length - 1]] = v;
  }
  return { ok: true, obj: out };
}

export function run({ table, format, base, missing, nestKeys }) {
  const warnings = [], notes = [];
  const text = String(table ?? '').replace(/^\uFEFF/, '');
  if (!text.trim()) return { warnings: ['Paste a table: a header row "key,en,tr,..." and one row per string.'] };
  const delim = sniff(text.split('\n')[0]);
  const { rows, unclosed } = parseDelimited(text, delim);
  if (unclosed) warnings.push('A quoted field is never closed: everything after its opening quote was read as one value. Close the quote or double any quote inside the text ("").');
  const data = rows.filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (data.length < 2) return { warnings: ['Need a header row and at least one string row.'] };

  const header = data[0].cells.map((h) => h.trim());
  const keyCol = Math.max(0, header.findIndex((h) => /^(key|id|name|string|resource)$/i.test(h)));
  const commentCol = header.findIndex((h) => COMMENT_COLS.includes(h.toLowerCase()));
  const langCols = header.map((h, i) => ({ h, i })).filter(({ h, i }) => i !== keyCol && i !== commentCol && h);
  if (!langCols.length) return { warnings: ['The header has no language columns: write it like "key,en,tr,de".'] };
  const badLang = langCols.filter(({ h }) => !/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,4})?$/.test(h));
  if (badLang.length) warnings.push(`Column${badLang.length > 1 ? 's' : ''} ${badLang.map((b) => `"${b.h}"`).join(', ')} ${badLang.length > 1 ? 'do' : 'does'} not look like a language code (en, tr, pt-BR) and ${badLang.length > 1 ? "were" : "was"} used as a language anyway. Rename it, or call a notes column "comment".`);
  const want = String(base ?? '').trim();
  let baseCol = langCols.find(({ h }) => h.toLowerCase() === want.toLowerCase());
  if (want && !baseCol) warnings.push(`Base language "${want}" is not a column; the first language column (${langCols[0].h}) was used.`);
  baseCol ||= langCols[0];

  // ---- rows ----
  const strings = [];
  const seen = new Map();
  const problems = [];
  for (const r of data.slice(1)) {
    const key = (r.cells[keyCol] ?? '').trim();
    if (!key) { problems.push([r.line, '(no key)', 'row has no key; skipped']); continue; }
    if (r.cells.length > header.length) problems.push([r.line, key, `${r.cells.length} cells but ${header.length} columns: an unquoted "${delim === '\t' ? 'tab' : delim}" inside a value? Quote the value.`]);
    if (seen.has(key)) { problems.push([r.line, key, `duplicate key (first on line ${seen.get(key)}); the later row wins`]); strings.splice(strings.findIndex((s) => s.key === key), 1); }
    seen.set(key, r.line);
    const vals = {};
    for (const { h, i } of langCols) vals[h] = r.cells[i] ?? '';
    strings.push({ key, line: r.line, vals, comment: commentCol >= 0 ? (r.cells[commentCol] ?? '').trim() : '' });
  }
  if (!strings.length) return { warnings: [...warnings, 'No rows with a key were found.'] };

  // ---- key rules per platform ----
  const javaId = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const dartId = /^[a-z][A-Za-z0-9_]*$/;
  for (const s of strings) {
    if (format === 'android' && !javaId.test(s.key)) problems.push([s.line, s.key, `not a valid Android resource name; use letters, digits and _ (e.g. ${s.key.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1')})`]);
    if (format === 'arb' && !dartId.test(s.key)) problems.push([s.line, s.key, 'ARB/Flutter keys must be Dart identifiers starting with a lowercase letter (camelCase)']);
    const bv = s.vals[baseCol.h];
    if (format === 'arb' && placeholders(bv).some((p) => p.startsWith('%'))) problems.push([s.line, s.key, 'printf placeholders (%s, %1$d) are not read by Flutter gen-l10n: use {name} and describe it in the base ARB']);
    if (!bv.trim()) problems.push([s.line, s.key, `no ${baseCol.h} (base) text: every other language falls back to this`]);
    const bp = placeholders(bv);
    if (format === 'android' && bp.filter((p) => /^%[a-zA-Z]$/.test(p)).length > 1) problems.push([s.line, s.key, 'several non-positional placeholders: Android needs %1$s, %2$d... so translators can reorder them']);
    for (const { h } of langCols) {
      if (h === baseCol.h) continue;
      const v = s.vals[h];
      if (!v.trim()) continue;
      const p = placeholders(v);
      if (!sameBag(bp, p)) problems.push([s.line, s.key, `${h} placeholders ${p.join(' ') || 'none'} differ from ${baseCol.h} ${bp.join(' ') || 'none'}: the app can crash or show the wrong value`]);
    }
  }

  // ---- coverage ----
  const coverage = langCols.map(({ h }) => {
    const done = strings.filter((s) => s.vals[h].trim()).length;
    return { lang: h, done, missing: strings.length - done, pct: (100 * done) / strings.length };
  });

  // ---- files ----
  const valueFor = (s, h) => {
    const v = s.vals[h];
    if (v.trim()) return v;
    if (h === baseCol.h) return v;
    if (missing === 'base') return s.vals[baseCol.h];
    if (missing === 'empty') return '';
    return null; // omit
  };
  const texts = [];
  for (const { h } of langCols) {
    const isBase = h === baseCol.h;
    const items = strings.map((s) => ({ s, v: valueFor(s, h) })).filter((x) => x.v !== null);
    let title, body;
    if (format === 'android') {
      title = `${androidDir(h, isBase)}/strings.xml`;
      body = ['<?xml version="1.0" encoding="utf-8"?>', '<resources>',
        ...items.flatMap(({ s, v }) => [
          ...(s.comment ? [`    <!-- ${xmlComment(s.comment)} -->`] : []),
          `    <string name="${s.key.replace(/"/g, '&quot;')}">${androidEscape(v)}</string>`]),
        '</resources>', ''].join('\n');
    } else if (format === 'ios') {
      title = `${isBase ? (h === 'en' ? 'en' : h) : h}.lproj/Localizable.strings`;
      body = items.flatMap(({ s, v }) => [
        `/* ${(s.comment || s.key).replace(/\*\//g, '* /')} */`,
        `"${iosEscape(s.key)}" = "${iosEscape(v)}";`, '']).join('\n');
    } else if (format === 'arb') {
      title = `app_${h.replace('-', '_')}.arb`;
      const o = { '@@locale': h.replace('-', '_') };
      for (const { s, v } of items) {
        o[s.key] = v;
        if (isBase) {
          const names = placeholders(v).filter((p) => p.startsWith('{')).map((p) => p.slice(1, -1));
          if (s.comment || names.length) o['@' + s.key] = { ...(s.comment ? { description: s.comment } : {}), ...(names.length ? { placeholders: Object.fromEntries(names.map((n) => [n, {}])) } : {}) };
        }
      }
      body = JSON.stringify(o, null, 2) + '\n';
    } else {
      title = `${h}.json`;
      const flat = Object.fromEntries(items.map(({ s, v }) => [s.key, v]));
      if (nestKeys) {
        const n = nest(flat);
        if (!n.ok) { warnings.push(`Key "${n.key}" is both a string and a group of keys, so the ${h} JSON could not be nested; it is written flat. Rename one of them.`); body = JSON.stringify(flat, null, 2) + '\n'; }
        else body = JSON.stringify(n.obj, null, 2) + '\n';
      } else body = JSON.stringify(flat, null, 2) + '\n';
    }
    texts.push({ title, body, lang: format === 'android' ? 'xml' : format === 'ios' ? 'text' : 'json' });
  }

  const totalMissing = coverage.filter((c) => c.lang !== baseCol.h).reduce((a, c) => a + c.missing, 0);
  const values = [
    { label: 'Strings', value: strings.length },
    { label: 'Languages', value: langCols.length, hint: langCols.map((l) => l.h).join(', ') },
    { label: 'Base language', value: baseCol.h },
    { label: 'Missing translations', value: totalMissing, tone: totalMissing ? 'warn' : 'ok' },
    { label: 'Problems', value: problems.length, tone: problems.length ? 'bad' : 'ok' },
  ];
  if (problems.length) warnings.push(`${problems.length} problem${problems.length > 1 ? 's' : ''} found: see the Problems table and fix them in the sheet before shipping the files.`);
  const tables = [{
    title: 'Coverage per language',
    columns: ['Language', 'Translated', 'Missing', 'Complete'],
    rows: coverage.map((c) => [c.lang + (c.lang === baseCol.h ? ' (base)' : ''), c.done, c.missing, `${Math.round(c.pct)} %`]),
  }];
  if (problems.length) tables.push({ title: 'Problems', columns: ['Line', 'Key', 'Problem'], rows: problems });
  const missList = strings.flatMap((s) => langCols.filter(({ h }) => h !== baseCol.h && !s.vals[h].trim()).map(({ h }) => [s.key, h, s.vals[baseCol.h]]));
  if (missList.length) tables.push({ title: 'Untranslated', columns: ['Key', 'Language', `${baseCol.h} text`], rows: missList.slice(0, 200) });

  notes.push(`Read as ${delim === '\t' ? 'tab' : `"${delim}"`}-separated; column "${header[keyCol]}" is the key${commentCol >= 0 ? `, "${header[commentCol]}" the translator comment` : ''}.`);
  if (format === 'android') notes.push('Android: missing strings fall back to values/strings.xml at run time, so "omit" is the normal choice. %@ is written as %s.');
  if (format === 'ios') notes.push('iOS: %s is written as %@ (NSString). Save the files as UTF-8; missing keys fall back to the development language.');
  if (format === 'arb') notes.push('Flutter gen-l10n reads the base (template) ARB for descriptions and placeholders; the others only need the translated values.');
  notes.push('Plurals (Android <plurals>, iOS .stringsdict, ICU plural) are not generated: keep them as separate rows or write them by hand.');
  return { values, tables, texts, warnings, notes };
}
