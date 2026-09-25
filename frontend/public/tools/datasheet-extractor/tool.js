// Datasheet Snippet Extractor: the Absolute Maximum Ratings table and the
// pin table of a datasheet, from its text as `pdftotext -layout` writes it
// (columns kept as runs of spaces), into rows an agent or a script can use.
//
// How it reads a table (a heuristic - datasheets have no common format):
//   - Absolute maximum: the lines after an "Absolute Maximum Ratings"
//     heading (not a table-of-contents line) up to the next section
//     (ESD ratings, recommended operating conditions, thermal, electrical
//     characteristics). A header line with MIN / MAX / UNIT gives the
//     column positions; each value is put in the header column nearest to
//     it. Without a header, "−0.3 V to +6 V" style lines are read instead.
//     A parameter name printed once for a group of rows (TI's "Voltage"
//     beside IN/EN/OUT, a label between two condition rows) is given to the
//     neighbouring rows.
//   - Pins: a header with a name column (NAME, SYMBOL, SIGNAL) and an
//     I/O, TYPE or DESCRIPTION column; rows have a pin or ball number
//     (1, 4, 5, A1, N8) and a name; lines with only text in the description
//     column continue the row above.
// Cells are split at runs of 2 or more spaces. Lines it cannot place are
// reported, so a person can check them against the PDF.

const norm = (s) => String(s ?? '').trim();
const MINUS = /[−–‒—]/g;

const UNITS = new Set(['V', 'mV', 'kV', 'A', 'mA', 'µA', 'uA', 'nA', 'W', 'mW', '°C', 'ºC', 'C', 'K', '°C/W', 'K/W', 'Hz', 'kHz', 'MHz',
  'Ω', 'kΩ', 'ohm', 's', 'ms', 'µs', 'us', 'ns', 'V/µs', 'V/us', 'dB', 'dBm', '%', 'mJ', 'J', 'mA/µs', 'g', 'N', 'mm', 'V/ms']);

const TOC = /(\.\s*){5,}|(·\s*){4,}|…{2,}|_{5,}/;
const FOOT = /^\(\d+\)|^note\s*\d*[:.]|^\d+\.\s+[A-Z][a-z]/i;
const PAGEFOOT = /©|copyright|proprietary|confidential|all rights reserved|submit document feedback|www\.[a-z]+\.com/i;
const END_AMR = /^(\d+(\.\d+)*\.?\s+|table\s+[\d.-]+\.?\s*)?(esd ratings?|recommended operating|thermal (information|characteristics|resistance)|electrical characteristics|typical characteristics|pin (configuration|description|functions|assignments?)|detailed description|functional block|handling ratings)/i;

/** Split a layout line into cells at 2+ spaces, keeping each cell's start column. */
function cells(line) {
  const out = [];
  const re = /\S(?:.*?\S)??(?=\s{2,}|\s*$)/g;
  let m;
  while ((m = re.exec(line))) out.push({ text: m[0], at: m.index, end: m.index + m[0].length });
  return out;
}

/** "−0.3" "2,000" "150" -> number; else null. */
function numberOf(t) {
  let s = norm(t).replace(MINUS, '-').replace(/\(\d+\)$/, '').replace(/^\+/, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return Number(s);
  return null;
}
/** A value cell: a number, or an expression with a number in it ("VIN + 0.3", "Vxx+0.5(3)"). */
const isValue = (t) => numberOf(t) != null || (/\d/.test(t) && /^[+\-−–]?\s*[A-Za-z]{1,4}[\w()]*\s*[+\-−–]\s*\d/.test(norm(t)) && t.length < 24);
const unitOf = (t) => { const s = norm(t).replace(/^\[|\]$/g, ''); return UNITS.has(s) ? (s === 'ºC' || s === 'C' ? '°C' : s) : null; };
const clean = (t) => norm(t).replace(/\s*\(\d+\)/g, '').replace(/\s{2,}/g, ' ');

// ---------------- absolute maximum ratings ----------------
function findSections(lines, head, end, maxLen) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!head.test(lines[i]) || TOC.test(lines[i])) continue;
    // A heading, not a sentence that mentions it ("Stresses beyond the absolute maximum ratings...").
    if (norm(lines[i]).length > 90 || /stresses|beyond|exceed/i.test(lines[i])) continue;
    let j = i + 1;
    for (; j < lines.length && j < i + maxLen; j++) if (end.test(norm(lines[j])) && !TOC.test(lines[j])) break;
    out.push([i, j]);
    i = j - 1;
  }
  return out;
}

function parseAbsMax(lines, from, to, unparsed) {
  const rows = [];
  // The header: MAX and UNIT (or MIN and MAX) on one line.
  let h = -1, cols = null;
  for (let i = from; i < to; i++) {
    const l = lines[i];
    if (/\bmax\.?\b/i.test(l) && (/\bunits?\b/i.test(l) || /\bmin\.?\b/i.test(l))) {
      h = i; cols = {};
      for (const c of cells(l)) {
        const w = c.text.toLowerCase().replace(/\.$/, '');
        for (const k of ['min', 'typ', 'nom', 'max', 'unit', 'units']) if (w === k || w.split(/\s+/).includes(k)) cols[k === 'units' ? 'unit' : k === 'nom' ? 'typ' : k] = (c.at + c.end) / 2;
      }
      break;
    }
  }
  if (h < 0) {
    // No header: "Supply voltage VIN ........ −0.3 V to +6.5 V" lines.
    for (let i = from + 1; i < to; i++) {
      const l = lines[i].replace(/\.{3,}|…+/g, '  ');
      const m = /^(.*?\S)\s+([-−–+]?\d[\d.,]*|[A-Za-z]\w*\s*[+\-−–]\s*\d[\d.]*)\s*([A-Za-z°µΩ/]+)?\s+to\s+([-−–+]?\d[\d.,]*|\(?[A-Za-z]\w*\s*[+\-−–]\s*\d[\d.]*\)?)\s*([A-Za-z°µΩ/]+)/.exec(l);
      if (m && !FOOT.test(norm(l))) {
        rows.push({ parameter: clean(m[1]), condition: '', min: numberOf(m[2]) ?? clean(m[2]), typ: null, max: numberOf(m[4]) ?? clean(m[4]), unit: unitOf(m[5]) || m[5], line: i + 1 });
        continue;
      }
      const one = /^(.*?\S)\s{2,}([-−–+]?\d[\d.,]*)\s*([A-Za-z°µΩ/]+)\s*$/.exec(l);
      if (one && unitOf(one[3]) && !FOOT.test(norm(l))) { rows.push({ parameter: clean(one[1]), condition: '', min: null, typ: null, max: numberOf(one[2]), unit: unitOf(one[3]), line: i + 1 }); continue; }
      if (norm(l) && /\d/.test(l) && !FOOT.test(norm(l)) && !PAGEFOOT.test(l) && norm(l).length < 120) unparsed.push([i + 1, norm(l)]);
    }
    return { rows, header: false };
  }

  const valueCols = ['min', 'typ', 'max'].filter((k) => cols[k] != null);
  const firstValue = Math.min(...valueCols.map((k) => cols[k])) - 8;
  const body = [];
  for (let i = h + 1; i < to; i++) {
    const t = norm(lines[i]);
    if (!t || FOOT.test(t) || PAGEFOOT.test(t) || TOC.test(t)) continue;
    if (/^(over|unless|all voltages|stresses|exposure|these are)/i.test(t)) continue;
    body.push(i);
  }
  const base = Math.min(...body.map((i) => lines[i].search(/\S/)));
  // Each line: {i, group, item, vals, unit, textOnly}
  const L = body.map((i) => {
    const cs = cells(lines[i]);
    const left = cs.filter((c) => c.at < firstValue && !(isValue(c.text) || unitOf(c.text)));
    const right = cs.filter((c) => !left.includes(c));
    const o = { i, group: '', item: '', min: null, typ: null, max: null, unit: null, text: null };
    if (left.length && left[0].at <= base + 3) { o.group = clean(left[0].text); left.shift(); }
    o.item = left.map((c) => clean(c.text)).join(', ');
    // "VIN + 0.3 V": a value and its unit printed with one space between.
    for (let q = 0; q < right.length; q++) {
      const c = right[q];
      const m = /^(.*\S)\s+(\S+)$/.exec(c.text);
      if (m && unitOf(m[2]) && isValue(m[1])) {
        right.splice(q, 1, { text: m[1], at: c.at, end: c.at + m[1].length }, { text: m[2], at: c.end - m[2].length, end: c.end });
      }
    }
    for (const c of right) {
      const u = unitOf(c.text);
      const centre = (c.at + c.end) / 2;
      if (u && (cols.unit == null || Math.abs(centre - cols.unit) <= Math.abs(centre - Math.max(...valueCols.map((k) => cols[k]))))) { o.unit = u; continue; }
      if (isValue(c.text)) {
        const k = valueCols.reduce((b, x) => (Math.abs(cols[x] - centre) < Math.abs(cols[b] - centre) ? x : b), valueCols[0]);
        const v = numberOf(c.text) ?? clean(c.text);
        if (o[k] == null) o[k] = v; else if (k !== 'max' && o.max == null) o.max = v;
        continue;
      }
      o.text = o.text ? `${o.text} ${clean(c.text)}` : clean(c.text);  // "Internally limited"
    }
    o.data = o.min != null || o.typ != null || o.max != null || o.text != null;
    return o;
  });
  // Group labels printed once for several rows: a text-only line, or a row
  // that has both a group and an item cell, lends its group to unlabelled
  // neighbours (nearest first; a text-only label wins a tie, then the row above).
  const anchors = L.map((o, k) => ({ k, o })).filter(({ o }) => o.group && (!o.data || o.item));
  for (let k = 0; k < L.length; k++) {
    const o = L[k];
    if (!o.data || o.group) continue;
    let best = null, bd = 99;
    for (const a of anchors) {
      const d = Math.abs(a.o.i - o.i);
      const better = d < bd || (d === bd && best && ((!a.o.data && best.o.data) || (a.o.data === best.o.data && a.o.i < best.o.i)));
      if (d <= 3 && better) { best = a; bd = d; }
    }
    if (best) o.group = best.o.group;
  }
  // A lowercase text-only line right under a row continues its name ("to ambient").
  for (let k = 1; k < L.length; k++) {
    const o = L[k], p = L[k - 1];
    if (!o.data && o.group && /^[a-z(]/.test(o.group) && p.data && o.i === p.i + 1) { p.group = `${p.group} ${o.group}`.trim(); o.used = true; }
  }
  for (const o of L) {
    if (o.data) {
      rows.push({ parameter: o.group || o.item || '(unnamed)', condition: o.group ? o.item : '', min: o.min, typ: o.typ, max: o.max ?? o.text, unit: o.unit, line: o.i + 1 });
    } else if (!o.used && !anchors.some((a) => a.o === o)) unparsed.push([o.i + 1, norm(lines[o.i])]);
  }
  return { rows, header: true };
}

// ---------------- pins ----------------
const PINS = /^(?:[A-Z]{1,2}\d{1,2}|\d{1,3}|EP|PAD|TAB)(?:\s*[,/&]\s*(?:[A-Z]{1,2}\d{1,2}|\d{1,3}))*(?:\s*[-–]\s*\d{1,3})?\s*,?$/;
const TYPE = /^(I|O|I\/O|IO|B|P|G|S|A|AI|AO|OD|OC|PU|PD|NC|DI|DO|PWR|GND|POWER|GROUND|SUPPLY|ANALOG|INPUT|OUTPUT|BIDIR(ECTIONAL)?|[—–-])$/i;
const NAME = /^[A-Za-z_][\w/#+\-[\].~]*$|^[A-Za-z_][\w]*\s?\(?[\w/#+-]*\)?$/;

/** Header cells -> [{role, at, end}] for pin / name / type / desc. */
function headerRoles(line) {
  const out = [];
  for (const c of cells(line)) {
    const w = c.text.toLowerCase();
    const role = /description|function/.test(w) ? 'desc' : /\bi\/o\b|\btype\b|\bdir/.test(w) ? 'type'
      : /\bname\b|\bsymbol\b|\bsignal\b|\bmnemonic\b/.test(w) ? 'name' : /\bno\.?$|\bnumber\b|#|\bball\b|^pins?$/.test(w) ? 'pin' : null;
    if (role) out.push({ role, at: c.at, end: c.end });
  }
  return out;
}

function parsePins(lines, unparsed) {
  const pins = [];
  const ranges = [];
  let tables = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (TOC.test(l) || norm(l).length > 160) continue;
    const roles = headerRoles(l);
    const has = (r) => roles.some((x) => x.role === r);
    const pinAbove = /\b(pin|ball)s?\b/i.test(lines[i - 1] || '') || /\b(pin|ball)s?\b/i.test(lines[i - 2] || '');
    if (!(has('name') && (has('desc') || has('type')) && (has('pin') || pinAbove))) continue;
    tables++;
    const descAt = (roles.find((x) => x.role === 'desc') || roles.at(-1)).at;
    // The role of a cell: the header column whose start is nearest, checked by its text.
    const roleOf = (c) => {
      const h = roles.reduce((b, x) => (Math.abs(x.at - c.at) < Math.abs(b.at - c.at) ? x : b), roles[0]);
      if (h.role === 'pin' && PINS.test(c.text)) return 'pin';
      if (h.role === 'name' && NAME.test(c.text) && c.text.length <= 28) return 'name';
      if (h.role === 'type' && TYPE.test(c.text)) return 'type';
      if (h.role === 'desc' || c.at >= descAt - 4 || (h.role === 'type' && c.at > descAt - 30)) return 'desc';
      // No pin column in the header (a two-line header): a pin number is still a pin.
      if (!has('pin') && PINS.test(c.text)) return 'pin';
      return null;
    };
    // Read the table's lines: rows, and fragments (a description or pin list printed above or below its row).
    const items = [];
    let blank = 0, j = i + 1, rows = 0;
    for (; j < lines.length; j++) {
      const t = norm(lines[j]);
      if (!t) { if (++blank >= (rows ? 3 : 5)) break; continue; }
      blank = 0;
      if (PAGEFOOT.test(t) || TOC.test(t)) break;
      if (rows && /^(\d+(\.\d+)*\s+[A-Z][a-z]|table\s+[\d.-]+|figure\s+[\d.-]+)/i.test(t)) break;
      const cs = cells(lines[j]).map((c) => ({ ...c, role: roleOf(c) }));
      const get = (r) => cs.filter((c) => c.role === r);
      const pin = get('pin')[0], name = get('name')[0], type = get('type')[0];
      // A second type-looking cell ("GND  Ground", "NC  NC") is the description.
      const desc = cs.filter((c) => c !== type && (c.role === 'desc' || (c.role === 'type' && type && c.at > type.at)));
      if (name && (pin || type)) {
        items.push({ kind: 'row', j, pin: pin ? pin.text : '', name: name.text, type: type ? type.text : '', desc: desc.map((c) => c.text).join(' '), own: desc.length > 0 });
        rows++;
      } else if (cs.length && cs.every((c) => c.role === 'desc')) items.push({ kind: 'desc', j, text: cs.map((c) => c.text).join(' ') });
      else if (cs.length === 1 && pin) items.push({ kind: 'pins', j, text: pin.text });
      else if (rows) unparsed.push([j + 1, t]);
    }
    // Give each fragment to a row: a continuation goes to the row above unless
    // that row has its own text and the row below has none (a vertically
    // centred cell); between two rows without text, to the nearer one.
    const rowsOnly = items.filter((x) => x.kind === 'row');
    for (const f of items) {
      if (f.kind === 'row') continue;
      const A = [...rowsOnly].reverse().find((r) => r.j < f.j), B = rowsOnly.find((r) => r.j > f.j);
      let to;
      if (f.kind === 'pins') to = !A ? B : !B ? A : (B.j - f.j < f.j - A.j || (B.j - f.j === f.j - A.j && /,\s*$/.test(f.text))) ? B : A;
      else if (!A) to = B;
      else if (!B) to = A;
      else if (A.own && !B.own) to = B;
      else if (!A.own && !B.own) to = B.j - f.j < f.j - A.j ? B : A;
      else to = A;
      if (!to) { unparsed.push([f.j + 1, f.text]); continue; }
      (to.frags ||= []).push(f);
    }
    for (const r of rowsOnly) {
      const above = (r.frags || []).filter((f) => f.j < r.j), below = (r.frags || []).filter((f) => f.j > r.j);
      const d = [...above.filter((f) => f.kind === 'desc').map((f) => f.text), r.desc, ...below.filter((f) => f.kind === 'desc').map((f) => f.text)];
      const p = [...above.filter((f) => f.kind === 'pins').map((f) => f.text), r.pin, ...below.filter((f) => f.kind === 'pins').map((f) => f.text)];
      pins.push({ pin: p.join(' ').replace(/\s*,\s*/g, ',').replace(/,+$/, '').replace(/\s+/g, '') || '–', name: r.name,
        type: r.type.replace(/^[—–-]$/, '–'), description: clean(d.filter(Boolean).join(' ')), line: r.j + 1,
        more: (r.frags || []).map((f) => f.j + 1) });
    }
    ranges.push([i + 1, j]);
    i = j - 1;
  }
  return { pins, tables, ranges };
}

/** Power, ground, input, output, bidirectional, no-connect or other - by the type column, else the name. */
function pinKind(name, type, desc = '') {
  const t = norm(type).toUpperCase(), n = norm(name).toUpperCase();
  const supply = /^(input |power )?supply\b|\bsupply (input|voltage|pin)\b|^power input/i.test(norm(desc));
  if (/^(NC|DNC|N\.?C\.?)$/.test(n) || t === 'NC') return 'nc';
  if (/^(G|GND|GROUND)$/.test(t) || /^(GND|VSS|AGND|PGND|DGND|EP|PAD|THERMAL)/.test(n)) return 'gnd';
  if (/^(P|PWR|POWER|SUPPLY|S)$/.test(t) || (supply && /^(I|P|—|–|-|)$/.test(t)) || /^(V(CC|DD|IN|BAT|SYS|BUS|IO|REF|OUT)?|AVDD|DVDD|PVIN|VM)\b/.test(n) && !t) return 'pwr';
  if (/^(I\/O|IO|B|BIDIR(ECTIONAL)?)$/.test(t)) return 'io';
  if (/^(I|DI|AI|INPUT|PU|PD)$/.test(t)) return 'in';
  if (/^(O|DO|AO|OD|OC|OUTPUT)$/.test(t)) return 'out';
  if (/^(A|ANALOG)$/.test(t)) return 'an';
  return 'other';
}

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function run({ text, part, what }) {
  const src = String(text ?? '');
  const warnings = [];
  const notes = [];
  if (!norm(src)) return { warnings: ['Paste the datasheet text (pdftotext -layout keeps the columns), or in the app choose the PDF.'] };
  const lines = src.replace(/\t/g, '    ').replace(/\f/g, '\n').split(/\r?\n/);
  const want = what || 'both';
  const name = norm(part) || 'part';
  const unparsed = [];
  const tables = [];
  const values = [];
  let amr = [], pins = [];
  const regions = [];

  if (want !== 'pins') {
    const secs = findSections(lines, /absolute\s+maximum\s+ratings?/i, END_AMR, 70);
    let header = true;
    for (const [a, b] of secs) {
      regions.push({ kind: 'absmax', from: a + 1, to: b });
      const r = parseAbsMax(lines, a, b, unparsed);
      amr.push(...r.rows); header = header && r.header;
    }
    if (!secs.length) warnings.push('No "Absolute Maximum Ratings" heading found. Check the page range, or paste the page that has the table.');
    else if (!amr.length) warnings.push('Found the Absolute Maximum Ratings heading but no rows under it: the table may be an image in the PDF - read it by eye.');
    else if (!header) notes.push('The ratings table had no MIN/MAX/UNIT header; rows were read from "−0.3 V to 6 V" style lines.');
    for (const r of amr) {
      if (typeof r.min === 'number' && typeof r.max === 'number' && r.min > r.max) warnings.push(`Line ${r.line}: ${r.parameter} has min ${r.min} above max ${r.max} - check the columns against the PDF.`);
      if (r.max != null && !r.unit && typeof r.max === 'number') warnings.push(`Line ${r.line}: ${r.parameter} has no unit - check the PDF.`);
    }
    values.push({ label: 'Ratings found', value: amr.length, tone: amr.length ? 'ok' : 'warn' });
    if (amr.length) {
      tables.push({ title: `Absolute maximum ratings - ${name}`, columns: ['Parameter', 'Condition / pin', 'Min', 'Max', 'Unit', 'Line'],
        rows: amr.map((r) => [r.parameter, r.condition || '–', r.min ?? '–', r.max ?? '–', r.unit || '–', r.line]) });
    }
  }
  if (want !== 'absmax') {
    const r = parsePins(lines, unparsed);
    for (const [a, b] of r.ranges) regions.push({ kind: 'pins', from: a, to: b });
    // One pin, one row: the same table repeated on two pages is merged.
    const seen = new Map();
    for (const p of r.pins) {
      const k = `${p.pin}|${p.name}`.toUpperCase();
      if (!seen.has(k)) seen.set(k, p);
    }
    pins = [...seen.values()];
    const byPin = new Map();
    for (const p of pins) for (const n of p.pin.split(/[,/&]/).filter((x) => x && x !== '–')) {
      const o = byPin.get(n);
      if (o && o !== p.name && n !== 'EP' && n !== 'PAD') warnings.push(`Pin ${n} is listed as both ${o} and ${p.name}: two packages in one table? Check which column belongs to yours.`);
      byPin.set(n, p.name);
    }
    if (!r.tables) warnings.push('No pin table header found (a line with NAME or SYMBOL and I/O, TYPE or DESCRIPTION). Check the page range.');
    else if (!pins.length) warnings.push('Found a pin table header but no rows: the table may be an image or split oddly - read it by eye.');
    values.push({ label: 'Pins found', value: pins.length, tone: pins.length ? 'ok' : 'warn' });
    if (pins.length) {
      tables.push({ title: `Pins - ${name}`, columns: ['Pin', 'Name', 'Type', 'Description'], rows: pins.map((p) => [p.pin, p.name, p.type || '–', p.description || '–']) });
      const power = pins.filter((p) => /^(p|pwr|power|supply|g|gnd|ground)$/i.test(p.type) || /^(v(cc|dd|in|bat|sys|bus)|gnd|vss|agnd|pgnd)/i.test(p.name));
      values.push({ label: 'Power / ground pins', value: power.length });
    }
  }
  values.push({ label: 'Lines not read', value: unparsed.length, tone: unparsed.length ? 'warn' : 'ok', hint: unparsed.length ? 'listed below - check them' : undefined });
  if (unparsed.length) tables.push({ title: 'Lines inside the tables that were not read', columns: ['Line', 'Text'], rows: unparsed.slice(0, 30).map(([n, t]) => [n, t.length > 110 ? t.slice(0, 108) + '…' : t]) });

  notes.push('Absolute maximum ratings are stress limits, not operating conditions: design to the recommended operating conditions and keep margin below these.',
    'Read by a heuristic from the text layout: check every row against the PDF before relying on it.');
  const json = {
    part: name,
    absoluteMaximum: amr.map(({ parameter, condition, min, typ, max, unit }) => ({ parameter, condition: condition || null, min, ...(typ != null ? { typ } : {}), max, unit })),
    pins: pins.map(({ pin, name: n, type, description }) => ({ pin, name: n, type: type || null, description })),
  };
  const csv = [];
  if (amr.length) csv.push('parameter,condition,min,max,unit', ...amr.map((r) => [r.parameter, r.condition, r.min, r.max, r.unit].map(csvCell).join(',')), '');
  if (pins.length) csv.push('pin,name,type,description', ...pins.map((p) => [p.pin, p.name, p.type, p.description].map(csvCell).join(',')));
  // For the page's drawing only (manifest agentOmit): every row with its
  // source line, the table regions and the lines not read, and a kind per pin.
  const sheet = {
    part: name,
    lineCount: lines.length,
    regions,
    absmax: amr.map(({ parameter, condition, min, max, unit, line }) => ({ parameter, condition: condition || '', min, max, unit: unit || '', line })),
    pins: pins.map(({ pin, name: n, type, description, line, more }) => ({ pin, name: n, type: type || '', description, line, more: more || [], kind: pinKind(n, type, description) })),
    unparsed: unparsed.map(([n, t]) => ({ line: n, text: t })),
  };
  return {
    sheet,
    values,
    tables,
    texts: [
      { title: 'Extracted JSON', body: JSON.stringify(json, null, 2) + '\n', lang: 'json' },
      { title: 'CSV', body: (csv.join('\n') || '(nothing extracted)') + '\n', lang: 'csv' },
    ],
    warnings,
    notes,
  };
}
