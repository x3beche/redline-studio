// BOM deduplicator: reads a pasted BOM (CSV, TSV or semicolon-separated, with
// a header row), recognises different spellings of the same part, and merges
// them into one consolidated line with the summed quantity and all designators.
//
// Merge key, in order of trust:
//   1. MPN, normalised (upper case, spaces removed) + manufacturer alias
//      (e.g. "TI" = "Texas Instruments").
//   2. Without MPN: part kind (from the designator letter) + value read as a
//      number with the kind's unit (10k = 10K = 10kΩ = 10000 = 10 kohm;
//      100n = 0.1uF = 100nF; 4R7 = 4.7 Ω, after IEC 60062 R-notation) + package
//      (0603 = R_0603_1608Metric = 1608 metric) + any extra spec (16V, X7R, 1%).
// Lines that match on value and package but differ in spec are not merged; they
// are listed for review, because a 16 V and a 50 V capacitor are not the same part.

const ALIAS = {
  ref: ['reference', 'references', 'designator', 'designators', 'refdes', 'ref', 'refs', 'part reference', 'reference designator', 'ref des'],
  qty: ['qty', 'quantity', 'count', 'qnty', 'amount', 'qty per board'],
  value: ['value', 'val', 'comment', 'part value'],
  footprint: ['footprint', 'package', 'case', 'pattern', 'case/package', 'pcb footprint', 'size'],
  mpn: ['mpn', 'mfr part', 'mfr pn', 'mfr. part #', 'mfr part number', 'manufacturer part number', 'manufacturer part', 'mfg pn', 'mfg part number', 'part number', 'pn', 'manufacturer_part_number'],
  mfr: ['manufacturer', 'mfr', 'mfg', 'manufacturer name', 'mfr name', 'make'],
  desc: ['description', 'desc', 'part description'],
  supplier: ['lcsc', 'lcsc part', 'lcsc part #', 'digikey', 'digi-key', 'digikey pn', 'mouser', 'mouser pn', 'supplier pn', 'supplier part number', 'jlcpcb part #'],
};

const MFR = [
  [/^(ti|texas ?instruments?( inc\.?)?)$/i, 'Texas Instruments'], [/^(st|stm|stmicro(electronics)?|st ?micro(electronics)?)$/i, 'STMicroelectronics'],
  [/^(on|onsemi|on ?semi(conductor)?)$/i, 'onsemi'], [/^(adi|analog ?devices?( inc\.?)?|linear ?tech(nology)?|maxim( integrated)?)$/i, 'Analog Devices'],
  [/^(microchip( technology)?|atmel|mchp)$/i, 'Microchip'], [/^(nxp|nxp semiconductors?|freescale)$/i, 'NXP'],
  [/^(yageo( corp(oration)?)?)$/i, 'Yageo'], [/^(murata( electronics)?|murata manufacturing)$/i, 'Murata'],
  [/^(samsung( electro-?mechanics)?|semco)$/i, 'Samsung Electro-Mechanics'], [/^(kemet)$/i, 'KEMET'],
  [/^(vishay( dale| intertechnology)?)$/i, 'Vishay'], [/^(tdk( corporation)?)$/i, 'TDK'], [/^(panasonic( electronic components)?)$/i, 'Panasonic'],
  [/^(w(u|ü|ue)rth( elektronik)?|we)$/i, 'Würth Elektronik'], [/^(nexperia)$/i, 'Nexperia'], [/^(infineon( technologies)?|ifx)$/i, 'Infineon'],
  [/^(uni-?royal|uniroyal elec)$/i, 'UNI-ROYAL'], [/^(diodes( inc(orporated)?)?)$/i, 'Diodes Inc.'], [/^(rohm( semiconductor)?)$/i, 'ROHM'],
];
const normMfr = (s) => { const t = String(s || '').trim().replace(/[,.]$/, ''); if (!t) return ''; const hit = MFR.find(([re]) => re.test(t)); return hit ? hit[1] : t; };
const normMpn = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');

const METRIC = { '0603': '0201', 1005: '0402', 1608: '0603', 2012: '0805', 3216: '1206', 3225: '1210', 5025: '2010', 6332: '2512' };
function normPkg(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  const base = t.replace(/^.*:/, '');                                   // KiCad "Lib:Footprint"
  const imp = /(?:^|[^0-9])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)(?:[^0-9]|$)/.exec(base);
  if (imp && !/^\s*(\d{4})\s*metric/i.test(base)) return imp[1];
  const met = /(?:^|[^0-9])(0603|1005|1608|2012|3216|3225|5025|6332)(?:[^0-9]|$)/.exec(base);
  if (met && /metric|mm|\bm\b/i.test(base)) return METRIC[met[1]];
  const sot = /(SOT|SOD|SOIC|TSSOP|SSOP|QFN|DFN|QFP|LQFP|TQFP|BGA|SC|TO|DO|MSOP|VQFN|WQFN|UQFN)-?(\d+[A-Z]?)(?:-(\d+))?/i.exec(base);
  if (sot) {
    const fam = sot[1].toUpperCase(), n = sot[2].toUpperCase();
    const pins = sot[3] && !(fam === 'SOT' && ((n === '23' && sot[3] === '3') || (n === '223' && sot[3] === '3'))) ? '-' + sot[3] : '';
    return `${fam}-${n}${pins}`;                                          // SOT-23-3 = SOT-23
  }
  return base.toUpperCase().replace(/\s+/g, '');
}

const KIND = { R: ['Ω', 'R'], C: ['F', 'C'], L: ['H', 'L'], FB: [null, 'FB'] };
function kindOf(refs) {
  const p = (/^[A-Za-z]+/.exec(refs[0] || '') || [''])[0].toUpperCase();
  if (p === 'R' || p === 'RN') return 'R';
  if (p === 'C') return 'C';
  if (p === 'L') return 'L';
  return p || '?';
}

const PFX = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
/** '10k', '4k7', '4R7', '100nF', '0.1uF', '10 kohm' -> number, for kind R/C/L; null if not read. */
function readValue(tok, kind) {
  let t = String(tok || '').trim().replace(/\s+/g, '').replace(',', '.').replace(/(ohms?|Ω|Ω|R$)/i, (m) => (m.toUpperCase() === 'R' ? 'R' : ''));
  t = t.replace(/meg/i, 'M');                                                // SPICE 1meg
  if (kind === 'C') t = t.replace(/F$/i, '');
  if (kind === 'L') t = t.replace(/H$/i, '');
  if (kind === 'C' || kind === 'L') t = t.replace(/[PNU]/g, (c) => c.toLowerCase()); // 100N = 100n for a capacitor
  let m;
  if ((m = /^(\d+)R(\d*)$/i.exec(t))) return Number(`${m[1]}.${m[2] || 0}`);            // 4R7, 100R
  if ((m = /^(\d+)([pnuµμmkKMG])(\d+)$/.exec(t))) return Number(`${m[1]}.${m[3]}`) * PFX[m[2]];
  if ((m = /^((?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([pnuµμmkKMG]?)$/i.exec(t))) {
    const p = m[2];
    if (kind === 'R' && p === 'm') return Number(m[1]) * 1e-3;
    return Number(m[1]) * (p ? PFX[p] ?? PFX[p.toLowerCase()] : 1);
  }
  return null;
}
const STEPS = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
function fmtVal(v, unit) {
  if (v === 0) return `0 ${unit}`;
  const [s, p] = STEPS.find(([x]) => Math.abs(v) >= x * 0.9995) || STEPS[STEPS.length - 1];
  return `${Number((v / s).toPrecision(4))} ${p}${unit}`;
}

function normValue(value, kind) {
  const raw = String(value || '').trim();
  if (!raw) return { key: '', show: '', spec: '' };
  if (!['R', 'C', 'L'].includes(kind)) return { key: raw.toUpperCase().replace(/\s+/g, ''), show: raw, spec: '' };
  const toks = raw.split(/[\s/_,]+/).filter(Boolean);
  // The value may be split "10 k" or "10 kohm": try the first one or two tokens.
  let v = null, used = 1;
  if (toks.length > 1 && /^[pnuµμmkKMG]?(ohms?|Ω|F|H)?$/i.test(toks[1])) { v = readValue(toks[0] + toks[1], kind); used = 2; }
  if (v == null) { v = readValue(toks[0], kind); used = 1; }
  if (v == null) return { key: raw.toUpperCase().replace(/\s+/g, ''), show: raw, spec: '' };
  const spec = toks.slice(used).map((s) => s.toUpperCase().replace(/^(\d+)V$/, '$1V')).sort().join(' ');
  return { key: `${v.toPrecision(4)}`, show: fmtVal(v, KIND[kind][0]), spec };
}

// ---- CSV ----
function detectDelim(line) {
  const c = { '\t': 0, ';': 0, ',': 0 };
  let q = false;
  for (const ch of line) { if (ch === '"') q = !q; else if (!q && ch in c) c[ch]++; }
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(c).sort((a, b) => b[1] - a[1])[0][0] : ',';
}
function splitRow(line, d) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === d) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
function mapHeader(cells) {
  const map = {};
  cells.forEach((c, i) => {
    const h = c.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const [k, names] of Object.entries(ALIAS)) if (map[k] == null && names.includes(h)) { map[k] = i; break; }
  });
  return map;
}
function expandRefs(s) {
  const out = [];
  for (const part of String(s || '').split(/[\s,;]+/).filter(Boolean)) {
    const m = /^([A-Za-z]+)(\d+)-(?:([A-Za-z]+))?(\d+)$/.exec(part);
    if (m && (!m[3] || m[3] === m[1]) && Number(m[4]) >= Number(m[2]) && Number(m[4]) - Number(m[2]) < 500) {
      for (let i = Number(m[2]); i <= Number(m[4]); i++) out.push(m[1] + i);
    } else out.push(part);
  }
  return out;
}
const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const csvCell = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

export function parseBom(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l));
  if (!lines.length) return { error: 'Paste a BOM with a header row (CSV, TSV or ;-separated).' };
  // Header = first of the first five lines that names at least two known columns.
  let hi = -1, map = {}, delim = ',';
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const d = detectDelim(lines[i]); const m = mapHeader(splitRow(lines[i], d));
    if (Object.keys(m).length >= 2) { hi = i; map = m; delim = d; break; }
  }
  if (hi < 0) return { error: 'No header row found. The first line should name the columns, e.g. "Reference,Qty,Value,Footprint,MPN,Manufacturer".' };
  const rows = [], bad = [];
  lines.slice(hi + 1).forEach((l, i) => {
    const c = splitRow(l, delim);
    if (c.every((x) => !x)) return;
    const get = (k) => (map[k] != null ? c[map[k]] ?? '' : '');
    const r = { line: hi + i + 2, refs: expandRefs(get('ref')), qty: get('qty'), value: get('value'), footprint: get('footprint'), mpn: get('mpn'), mfr: get('mfr'), desc: get('desc'), supplier: get('supplier') };
    if (!r.refs.length && !r.mpn && !r.value) bad.push(`line ${r.line}: ${l.slice(0, 60)}`);
    else rows.push(r);
  });
  return { rows, bad, map, delim };
}

export function run({ bom, mergeBy, ignoreMfr }) {
  const p = parseBom(bom);
  if (p.error) return { warnings: [p.error] };
  const warnings = [];
  const found = Object.keys(p.map);
  if (p.map.ref == null && p.map.qty == null) warnings.push('No Reference or Qty column: every line counts as quantity 1.');
  if (p.map.value == null && p.map.mpn == null) return { warnings: ['Need a Value or an MPN column to tell parts apart.'] };

  const groups = new Map();
  const seenRef = new Map();
  const qtyIssues = [];
  for (const r of p.rows) {
    const kind = kindOf(r.refs);
    const val = normValue(r.value, kind);
    const pkg = normPkg(r.footprint);
    const mpn = normMpn(r.mpn);
    const mfr = normMfr(r.mfr);
    let qty = r.qty !== '' ? Number(String(r.qty).replace(',', '.')) : r.refs.length || 1;
    if (!Number.isFinite(qty) || qty < 0) { qtyIssues.push(`line ${r.line}: quantity "${r.qty}" is not a number; used ${r.refs.length || 1}`); qty = r.refs.length || 1; }
    if (r.refs.length && r.qty !== '' && qty !== r.refs.length) {
      qtyIssues.push(`line ${r.line}: Qty ${qty} but ${r.refs.length} designator(s) (${r.refs.slice(0, 6).join(' ')}); counted ${r.refs.length}, one per placement. Fix the source BOM.`);
      qty = r.refs.length;
    }
    for (const ref of r.refs) {
      if (seenRef.has(ref)) qtyIssues.push(`${ref} appears on line ${seenRef.get(ref)} and line ${r.line}`);
      else seenRef.set(ref, r.line);
    }
    const byMpn = mpn && mergeBy !== 'value';
    const key = byMpn ? `MPN|${mpn}|${ignoreMfr ? '' : mfr.toUpperCase()}` : `VAL|${kind}|${val.key}|${pkg}|${val.spec}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, kind, refs: [], qty: 0, value: val.show || r.value, pkg, footprint: r.footprint, mpn: r.mpn.trim(), mfr, desc: r.desc, supplier: r.supplier, spellings: new Set(), lines: [], valKey: val.key, spec: val.spec, byMpn };
      groups.set(key, g);
    }
    g.refs.push(...r.refs); g.qty += qty; g.lines.push(r.line);
    g.spellings.add([r.value, r.footprint, r.mpn, r.mfr].map((s) => String(s || '').trim()).filter(Boolean).join(' / '));
    if (!g.supplier && r.supplier) g.supplier = r.supplier;
    if (!g.desc && r.desc) g.desc = r.desc;
  }
  const list = [...groups.values()].map((g) => ({ ...g, refs: g.refs.sort(natural) }))
    .sort((a, b) => natural(a.refs[0] || a.kind, b.refs[0] || b.kind));

  // Review: same value+package, different spec or MPN - maybe the same part, maybe not.
  const review = [];
  const byVP = {};
  for (const g of list) if (['R', 'C', 'L'].includes(g.kind) && g.valKey) (byVP[`${g.kind}|${g.valKey}|${g.pkg}`] ||= []).push(g);
  for (const gs of Object.values(byVP)) if (gs.length > 1) review.push([gs.map((g) => g.refs.slice(0, 4).join(' ') + (g.refs.length > 4 ? ' …' : '')).join('  vs  '), `${gs[0].value} ${gs[0].pkg}`, gs.map((g) => g.mpn || g.spec || '(no spec)').join('  vs  '), 'Same value and package but different MPN or spec: use one part if the specs allow.']);
  const byMpnOnly = {};
  for (const g of list) if (g.mpn) (byMpnOnly[normMpn(g.mpn)] ||= []).push(g);
  for (const gs of Object.values(byMpnOnly)) if (gs.length > 1) review.push([gs.map((g) => g.refs.slice(0, 4).join(' ')).join('  vs  '), gs[0].mpn, gs.map((g) => g.mfr || '(no manufacturer)').join('  vs  '), 'Same MPN under different manufacturers: check which one is right.']);

  const merged = list.filter((g) => g.spellings.size > 1 || g.lines.length > 1);
  const rows = list.map((g) => [g.qty, g.refs.join(' ') || '–', g.value || '–', g.pkg || '–', g.mpn || '–', g.mfr || '–', g.lines.length > 1 ? `${g.lines.length} lines` : '']);
  const csv = [['Qty', 'Reference', 'Value', 'Package', 'MPN', 'Manufacturer', 'Supplier PN', 'Description'].join(','),
    ...list.map((g) => [g.qty, g.refs.join(' '), g.value, g.pkg, g.mpn, g.mfr, g.supplier || '', g.desc || ''].map(csvCell).join(','))].join('\n') + '\n';

  if (p.bad.length) warnings.push(`${p.bad.length} line(s) had no designator, value or MPN and were skipped: ${p.bad.slice(0, 3).join(' | ')}`);
  for (const q of qtyIssues.slice(0, 8)) warnings.push(q);
  if (qtyIssues.length > 8) warnings.push(`… and ${qtyIssues.length - 8} more quantity/designator problems.`);

  const total = list.reduce((s, g) => s + g.qty, 0);
  return {
    values: [
      { label: 'Lines in', value: String(p.rows.length) },
      { label: 'Unique parts out', value: String(list.length), tone: 'ok' },
      { label: 'Lines merged', value: String(p.rows.length - list.length), hint: `${merged.length} parts had several lines or spellings` },
      { label: 'Total placements', value: String(total) },
      { label: 'Needs review', value: String(review.length), tone: review.length ? 'warn' : 'ok' },
    ],
    warnings,
    tables: [
      { title: 'Consolidated BOM', columns: ['Qty', 'Reference', 'Value', 'Package', 'MPN', 'Manufacturer', 'Merged'], rows },
      ...(merged.length ? [{ title: 'Spellings merged', columns: ['Part', 'Spellings found'], rows: merged.map((g) => [g.mpn || `${g.value} ${g.pkg}`, [...g.spellings].join('  |  ')]) }] : []),
      ...(review.length ? [{ title: 'Review: possible duplicates not merged', columns: ['Designators', 'Part', 'Differs in', 'Why'], rows: review }] : []),
    ],
    texts: [{ title: 'Consolidated CSV', body: csv, lang: 'csv' }],
    notes: [
      `Columns found: ${found.join(', ')}.`,
      mergeBy === 'value' ? 'Merged by kind + value + package + spec, ignoring MPN.' : 'Lines with an MPN merge by MPN (and manufacturer); lines without one merge by kind + value + package + spec.',
      'Values are read as numbers: 10k = 10K = 10000 = 10kΩ, 100n = 0.1uF, 4R7 = 4.7 Ω. Packages: R_0603_1608Metric = 0603.',
      'Extra words in the value (16V, X7R, 1%) must match for lines to merge; differences go to the review table.',
    ],
  };
}
