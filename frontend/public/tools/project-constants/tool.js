// Project Constants: the numbers every room shares (board outline, rails,
// holes, heights, temperatures) in one list, checked and exported as code.
//
// A value is a number in engineering notation (3.3, 4k7, 100n), a range
// written "min..max" (-20..60), or plain text (ENIG). A tolerance is
// "±0.2" (same unit as the value), "±5%" (of the value), or "+0.1/-0.05"
// (asymmetric); the limits are value - lower .. value + upper.
// Values are exported in the unit they are written in - nothing is
// converted - with the unit in a comment, the way ISO 80000-1 says a value
// is a number times a unit.
import { parseEng, fmtNum } from '../kit/eng.js';

const GROUPS = ['board', 'power', 'mechanical', 'thermal', 'interface', 'environment', 'other'];

// Units the check recognises; anything else is kept but noted.
const UNITS = new Set(['mm', 'cm', 'm', 'µm', 'um', 'mil', 'in', 'inch', '°', 'deg', 'rad', 'V', 'mV', 'µV', 'kV', 'A', 'mA', 'µA', 'uA', 'nA',
  'W', 'mW', 'Hz', 'kHz', 'MHz', 'GHz', '°C', 'K', 's', 'ms', 'µs', 'us', 'ns', 'min', 'h', 'g', 'kg', 'N', 'N·m', 'Nm', 'mN·m', 'Ω', 'ohm',
  'kΩ', 'MΩ', 'F', 'mF', 'µF', 'uF', 'nF', 'pF', 'H', 'mH', 'µH', 'uH', 'nH', '%', 'dB', 'dBm', 'bps', 'kbps', 'Mbps', 'baud', 'B', 'kB',
  'KiB', 'MB', 'MiB', 'pcs', 'mAh', 'Wh', 'rpm', 'Pa', 'kPa', 'MPa', 'oz', 'mm²', 'mm2', '-', '']);

// C11 §6.4.2.1: an identifier is a letter or underscore, then letters,
// digits or underscores. The same rule suits Python and OpenSCAD.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const num = (t) => {
  const s = String(t ?? '').trim().replace(/^−/, '-').replace(/−/g, '-');
  if (!s) return null;
  return parseEng(s);
};

/** "3.3", "-20..60", "-20 to 60", "ENIG" -> {kind, v?, lo?, hi?, text?}. */
function readValue(text) {
  const s = String(text ?? '').trim();
  if (!s) return { kind: 'empty' };
  const r = /^(.+?)\s*(?:\.\.|…|\bto\b)\s*(.+)$/.exec(s);
  if (r) {
    const lo = num(r[1]), hi = num(r[2]);
    if (lo != null && hi != null) return { kind: 'range', lo: Math.min(lo, hi), hi: Math.max(lo, hi), swapped: lo > hi };
  }
  const v = num(s);
  if (v != null) return { kind: 'number', v };
  return { kind: 'text', text: s };
}

/** "±0.2" | "0.2" | "±5%" | "+0.1/-0.05" -> {lo, hi} absolute deviations, or null / {bad}. */
function readTol(text, v) {
  const s = String(text ?? '').trim().replace(/\s+/g, '').replace(/−/g, '-');
  if (!s) return null;
  const pct = (x, isPct) => (isPct ? Math.abs(v) * x / 100 : x);
  let m = /^(?:±|\+\/-|\+-)?([0-9.]+(?:e-?\d+)?[pnuµmkM]?)(%)?$/.exec(s);
  if (m) {
    const d = parseEng(m[1]);
    if (d == null) return { bad: true };
    return { lo: pct(d, m[2]), hi: pct(d, m[2]) };
  }
  m = /^\+([0-9.]+[pnuµmkM]?)(%)?\/-([0-9.]+[pnuµmkM]?)(%)?$/.exec(s) || /^-([0-9.]+[pnuµmkM]?)(%)?\/\+([0-9.]+[pnuµmkM]?)(%)?$/.exec(s);
  if (m) {
    const a = parseEng(m[1]), b = parseEng(m[3]);
    if (a == null || b == null) return { bad: true };
    const plusFirst = s.startsWith('+');
    const up = plusFirst ? pct(a, m[2]) : pct(b, m[4]);
    const down = plusFirst ? pct(b, m[4]) : pct(a, m[2]);
    return { lo: down, hi: up };
  }
  return { bad: true };
}

const lit = (v) => {
  // A number as code: whole numbers stay whole, the rest to 6 significant figures.
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(6)));
};
// A negative number in a #define is bracketed, so X-1 never reads as X - 1.
const clit = (v) => (v < 0 ? `(${lit(v)})` : lit(v));
const cstr = (s) => JSON.stringify(String(s));
const safeName = (n) => String(n).trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^(\d)/, '_$1') || '_';

export function run({ constants, filter }) {
  const rows = Array.isArray(constants) ? constants : [];
  const warnings = [];
  const notes = [];
  if (!rows.length) return { warnings: ['The list is empty: add a row per constant (name, value, unit, group).'] };

  const seen = new Map();
  const items = [];
  const unknownUnits = new Set();
  let missingUnit = [];
  rows.forEach((r, i) => {
    const name = String(r.name ?? '').trim();
    const where = name || `row ${i + 1}`;
    const val = readValue(r.value);
    const unit = String(r.unit ?? '').trim();
    const group = GROUPS.includes(r.group) ? r.group : 'other';
    if (!name && val.kind === 'empty') return;          // a blank row
    if (!name) warnings.push(`Row ${i + 1} has no name: give it one (e.g. BOARD_W) so code and agents can refer to it.`);
    else if (!IDENT.test(name)) warnings.push(`"${name}" is not a code identifier (letters, digits, _; not starting with a digit): it is exported as ${safeName(name)}. Rename it so every room uses the same spelling.`);
    const key = name.toUpperCase();
    if (name && seen.has(key)) warnings.push(`"${name}" appears twice (rows ${seen.get(key) + 1} and ${i + 1}): one name, one value - delete or rename one.`);
    else if (name) seen.set(key, i);
    if (val.kind === 'empty') warnings.push(`${where} has no value.`);
    if (val.swapped) warnings.push(`${where}: the range is written high..low; read as ${lit(val.lo)}..${lit(val.hi)}.`);
    if ((val.kind === 'number' || val.kind === 'range') && (unit === '' )) missingUnit.push(where);
    if (unit && !UNITS.has(unit)) unknownUnits.add(unit);
    let tol = null;
    if (String(r.tol ?? '').trim()) {
      if (val.kind !== 'number') warnings.push(`${where}: a tolerance needs a single numeric value (not a range or text); it is ignored.`);
      else {
        tol = readTol(r.tol, val.v);
        if (tol?.bad) { warnings.push(`${where}: tolerance "${r.tol}" does not read - write ±0.2, ±5% or +0.1/-0.05.`); tol = null; }
      }
    }
    items.push({ i, name, sname: safeName(name || `ROW_${i + 1}`), val, unit, group, tol, tolText: String(r.tol ?? '').trim(), note: String(r.note ?? '').trim() });
  });
  if (missingUnit.length) warnings.push(`No unit on ${missingUnit.join(', ')}: write the unit (mm, V, °C…) or "-" for a pure number, or other rooms will guess.`);
  if (unknownUnits.size) notes.push(`Units not in the checker's list (kept as written): ${[...unknownUnits].join(', ')}.`);

  const f = String(filter ?? '').trim().toLowerCase();
  const shown = f ? items.filter((it) => [it.name, it.note, it.group, it.unit].some((x) => x.toLowerCase().includes(f))) : items;

  const valueText = (it) => (it.val.kind === 'number' ? fmtNum(it.val.v, 6) : it.val.kind === 'range' ? `${fmtNum(it.val.lo, 6)} .. ${fmtNum(it.val.hi, 6)}`
    : it.val.kind === 'text' ? it.val.text : '–');
  const limits = (it) => {
    if (it.val.kind === 'range') return [it.val.lo, it.val.hi];
    if (it.val.kind === 'number' && it.tol) return [it.val.v - it.tol.lo, it.val.v + it.tol.hi];
    return null;
  };

  const tables = [];
  for (const g of GROUPS) {
    const list = shown.filter((it) => it.group === g);
    if (!list.length) continue;
    tables.push({
      title: `${g[0].toUpperCase()}${g.slice(1)} (${list.length})`,
      columns: ['Name', 'Value', 'Unit', 'Tolerance', 'Min', 'Max', 'Note'],
      rows: list.map((it) => {
        const lim = limits(it);
        return [it.name || `(row ${it.i + 1})`, valueText(it), it.unit || '–', it.tolText || '–',
          lim ? fmtNum(lim[0], 6) : '–', lim ? fmtNum(lim[1], 6) : '–', it.note];
      }),
    });
  }
  if (f && !shown.length) warnings.push(`Nothing matches "${filter}".`);

  // ---- exports: the same list as C, Python and OpenSCAD ----
  const c = ['/* Project constants - generated by Redline "Project Constants". Values in the unit noted. */', '#pragma once', ''];
  const py = ['"""Project constants - generated by Redline "Project Constants". Values in the unit noted."""', ''];
  const scad = ['// Project constants - generated by Redline "Project Constants". Values in the unit noted.', ''];
  const js = {};
  for (const it of items) {
    const U = it.sname.toUpperCase(), l = it.sname.toLowerCase();
    const cm = [it.unit && it.unit !== '-' ? it.unit : '', it.tolText, it.note].filter(Boolean).join(', ');
    const tail = (mark) => (cm ? ` ${mark} ${cm}` : '');
    if (it.val.kind === 'number') {
      c.push(`#define ${U} ${clit(it.val.v)}${cm ? ` /* ${cm} */` : ''}`);
      py.push(`${U} = ${lit(it.val.v)}${tail('#')}`);
      scad.push(`${l} = ${lit(it.val.v)};${tail('//')}`);
      js[it.sname] = { value: it.val.v, unit: it.unit || null };
      const lim = limits(it);
      if (lim) {
        c.push(`#define ${U}_MIN ${clit(lim[0])}`, `#define ${U}_MAX ${clit(lim[1])}`);
        py.push(`${U}_MIN = ${lit(lim[0])}`, `${U}_MAX = ${lit(lim[1])}`);
        scad.push(`${l}_min = ${lit(lim[0])};`, `${l}_max = ${lit(lim[1])};`);
        Object.assign(js[it.sname], { min: lim[0], max: lim[1] });
      }
    } else if (it.val.kind === 'range') {
      c.push(`#define ${U}_MIN ${clit(it.val.lo)}${cm ? ` /* ${cm} */` : ''}`, `#define ${U}_MAX ${clit(it.val.hi)}`);
      py.push(`${U}_MIN = ${lit(it.val.lo)}${tail('#')}`, `${U}_MAX = ${lit(it.val.hi)}`);
      scad.push(`${l}_min = ${lit(it.val.lo)};${tail('//')}`, `${l}_max = ${lit(it.val.hi)};`);
      js[it.sname] = { min: it.val.lo, max: it.val.hi, unit: it.unit || null };
    } else if (it.val.kind === 'text') {
      c.push(`#define ${U} ${cstr(it.val.text)}${cm ? ` /* ${cm} */` : ''}`);
      py.push(`${U} = ${cstr(it.val.text)}${tail('#')}`);
      scad.push(`${l} = ${cstr(it.val.text)};${tail('//')}`);
      js[it.sname] = { value: it.val.text, unit: it.unit || null };
    }
  }

  // For the page: every row as data, with its limits and the problems that name it.
  const shownSet = new Set(shown.map((it) => it.i));
  const sheet = items.map((it) => {
    const lim = limits(it);
    const label = it.name || `row ${it.i + 1}`;
    return {
      row: it.i, name: it.name, code: it.sname, group: it.group, unit: it.unit, note: it.note, tol: it.tolText,
      kind: it.val.kind, value: it.val.kind === 'number' ? it.val.v : null, text: valueText(it),
      lo: it.val.kind === 'range' ? it.val.lo : null, hi: it.val.kind === 'range' ? it.val.hi : null,
      min: lim ? lim[0] : null, max: lim ? lim[1] : null, shown: shownSet.has(it.i),
      problems: warnings.filter((w) => w.includes(`"${it.name}"`) || w.startsWith(`${label} `) || w.startsWith(`${label}:`)
        || (it.name && new RegExp(`No unit on .*\\b${it.name.replace(/[^\w]/g, '')}\\b`).test(w)) || (!it.name && w.startsWith(`Row ${it.i + 1} `))),
    };
  });

  const numeric = items.filter((it) => it.val.kind === 'number' || it.val.kind === 'range').length;
  const groups = new Set(items.map((it) => it.group));
  notes.push('Values are exported in the unit they are written in; nothing is converted. Keep one unit per quantity (mm for lengths) across the project.',
    'A tolerance ±x is in the value\'s unit, ±x% is of the value; +a/-b is asymmetric. Min/Max are value - lower .. value + upper.');
  return {
    values: [
      { label: 'Constants', value: items.length },
      { label: 'Numeric', value: numeric, hint: 'numbers and ranges' },
      { label: 'With limits', value: items.filter((it) => limits(it)).length, hint: 'tolerance or range' },
      { label: 'Groups', value: groups.size },
      { label: 'Problems', value: warnings.length, tone: warnings.length ? 'warn' : 'ok' },
    ],
    tables,
    texts: [
      { title: 'C header', body: c.join('\n') + '\n', lang: 'c' },
      { title: 'Python', body: py.join('\n') + '\n', lang: 'python' },
      { title: 'OpenSCAD', body: scad.join('\n') + '\n', lang: 'openscad' },
      { title: 'Constants JSON', body: JSON.stringify(js, null, 2) + '\n', lang: 'json' },
    ],
    warnings,
    notes,
    sheet,
  };
}
