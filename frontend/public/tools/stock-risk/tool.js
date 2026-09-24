// Stock risk scanner: ranks the parts of a pasted BOM by supply risk, from
// what the BOM says about each part's sources, stock, lead time and lifecycle.
//
// Score (0–100, a documented rule of thumb, higher = riskier):
//   lifecycle   Obsolete/EOL/discontinued 40, last-time-buy 35, NRND 25,
//               preview/new 5, blank/unknown 5, active 0
//   sources     1 manufacturer (single source) 25, 2 → 10, 3+ → 0,
//               unknown 10 (0 for a generic R/C/L/FB with no MPN: many makers)
//   stock       none 35, less than the build needs 30, less than
//               coverage × need 15, enough 0, unknown 10
//   lead time   > 26 weeks 15, > 12 weeks 8
// Level: High ≥ 50, Medium ≥ 25, Low below. Need = qty per board × boards.

const ALIAS = {
  ref: ['reference', 'references', 'designator', 'designators', 'refdes', 'ref', 'refs', 'part reference'],
  qty: ['qty', 'quantity', 'qty per board', 'count', 'qty/board', 'per board'],
  mpn: ['mpn', 'mfr part', 'mfr pn', 'mfr part number', 'manufacturer part number', 'part number', 'mfg pn', 'pn', 'part'],
  mfr: ['manufacturer', 'mfr', 'mfg', 'make'],
  value: ['value', 'val', 'comment'],
  stock: ['stock', 'in stock', 'available', 'availability', 'inventory', 'qty available', 'stock qty', 'quantity available', 'distributor stock'],
  sources: ['sources', '# sources', 'source count', 'manufacturers', 'number of sources', 'sourcing', 'sole source', 'single source'],
  alt: ['alternates', 'alternate', 'alt', 'alt mpn', 'alternative', 'alternatives', 'second source', '2nd source'],
  lead: ['lead time', 'leadtime', 'lt', 'factory lead time', 'lead'],
  life: ['lifecycle', 'life cycle', 'status', 'lifecycle status', 'part status', 'life'],
};

function detectDelim(line) {
  const c = { '\t': 0, ';': 0, ',': 0 };
  let q = false;
  for (const ch of line) { if (ch === '"') q = !q; else if (!q && ch in c) c[ch]++; }
  const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return best[1] ? best[0] : ',';
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
    const h = c.toLowerCase().replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
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

/** '12,345' '12 345' '12k' '1.2M' -> number; null for blank / n/a. */
function readCount(s) {
  const t = String(s ?? '').trim().replace(/[\s,']/g, '');
  if (!t || /^(n\/?a|-|–|\?|unknown|tbd)$/i.test(t)) return null;
  const m = /^(\d+(?:\.\d+)?)([kKM]?)\+?$/.exec(t);
  if (!m) return NaN;
  return Number(m[1]) * (m[2] === 'M' ? 1e6 : m[2] ? 1e3 : 1);
}
/** '12 wk', '16 weeks', '8w', '60 days', '12' (weeks) -> weeks. */
function readWeeks(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (!t || /^(n\/?a|-|–|\?|unknown|tbd)$/.test(t)) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(w|wk|wks|week|weeks|d|day|days|m|mo|month|months)?$/.exec(t);
  if (!m) return NaN;
  const n = Number(m[1]); const u = m[2] || 'w';
  return u.startsWith('d') ? n / 7 : u.startsWith('m') ? n * 4.345 : n;
}
function readSources(s, alt) {
  const t = String(s ?? '').trim().toLowerCase();
  let n = null;
  if (t) {
    if (/^(single|sole|1|one|yes|y)$/.test(t)) n = 1;          // 'Sole source: yes'
    else if (/^(no|n)$/.test(t)) n = 2;                           // 'Sole source: no' = at least two
    else if (/^\d+$/.test(t)) n = Number(t);
    else if (/^(multi|multiple|many)/.test(t)) n = 3;
    else n = NaN;
  }
  const alts = String(alt ?? '').split(/[;|/]+|,\s+/).map((x) => x.trim()).filter((x) => x && !/^(none|n\/?a|-|–|no)$/i.test(x));
  if (alts.length) n = Math.max(n ?? 1, 1 + alts.length);
  return n;
}
function lifeOf(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (!t) return { pts: 5, label: 'unknown' };
  if (/obsol|eol|end of life|discontinu|inactive/.test(t)) return { pts: 40, label: 'obsolete / EOL' };
  if (/ltb|last.?time/.test(t)) return { pts: 35, label: 'last-time buy' };
  if (/nrnd|not recommended/.test(t)) return { pts: 25, label: 'NRND' };
  if (/prelim|preview|new product|sampling|pre-?release/.test(t)) return { pts: 5, label: 'preview' };
  if (/active|production|in production|released/.test(t)) return { pts: 0, label: 'active' };
  return { pts: 5, label: `"${s}" (unknown)` };
}

export function run({ bom, builds, coverage }) {
  const warnings = [];
  const lines = String(bom || '').split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l));
  if (!lines.length) return { warnings: ['Paste a BOM with a header row: MPN, Qty and at least one of Stock, Sources, Lead time, Lifecycle.'] };
  if (!(builds > 0)) return { warnings: ['Give the number of boards to build, e.g. 100.'] };
  const cov = coverage > 0 ? coverage : 3;
  if (!(coverage > 0)) warnings.push('No stock coverage factor given: 3× the build need is used.');
  let hi = -1, map = {}, delim = ',';
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const d = detectDelim(lines[i]); const m = mapHeader(splitRow(lines[i], d));
    if (Object.keys(m).length >= 2) { hi = i; map = m; delim = d; break; }
  }
  if (hi < 0) return { warnings: ['No header row found. The first line should name the columns, e.g. "Reference,Qty,MPN,Manufacturer,Stock,Sources,Lead time,Lifecycle".'] };
  const risky = ['stock', 'sources', 'alt', 'lead', 'life'].filter((k) => map[k] != null);
  if (!risky.length) warnings.push('No Stock, Sources, Lead time or Lifecycle column: every part scores as "unknown". Add them from your distributor export (Octopart, Digi-Key, Mouser, LCSC).');

  const parts = [], unread = [];
  lines.slice(hi + 1).forEach((l, i) => {
    const c = splitRow(l, delim);
    if (c.every((x) => !x)) return;
    const get = (k) => (map[k] != null ? c[map[k]] ?? '' : '');
    const lineNo = hi + i + 2;
    const refs = expandRefs(get('ref'));
    const mpn = get('mpn').trim(), value = get('value').trim();
    if (!mpn && !refs.length && !value) { unread.push(`line ${lineNo}`); return; }
    const probs = [];
    let qty = get('qty') !== '' ? Number(get('qty').replace(',', '.')) : refs.length || 1;
    if (!Number.isFinite(qty) || qty < 0) { probs.push(`qty "${get('qty')}"`); qty = refs.length || 1; }
    let stock = readCount(get('stock'));
    if (Number.isNaN(stock)) { probs.push(`stock "${get('stock')}"`); stock = null; }
    let lead = readWeeks(get('lead'));
    if (Number.isNaN(lead)) { probs.push(`lead time "${get('lead')}"`); lead = null; }
    let src = readSources(get('sources'), get('alt'));
    if (Number.isNaN(src)) { probs.push(`sources "${get('sources')}"`); src = null; }
    if (probs.length) unread.push(`line ${lineNo}: ${probs.join(', ')} not read`);
    const kind = (/^[A-Za-z]+/.exec(refs[0] || '') || [''])[0].toUpperCase();
    const generic = !mpn && ['R', 'C', 'L', 'FB', 'RN'].includes(kind);

    const reasons = [];
    let score = 0;
    const life = lifeOf(get('life'));
    score += life.pts; if (life.pts >= 25) reasons.push(life.label);
    if (src == null) { if (!generic) { score += 10; reasons.push('sources unknown'); } }
    else if (src <= 1) { score += 25; reasons.push('single source'); }
    else if (src === 2) { score += 10; reasons.push('two sources'); }
    const need = qty * builds;
    if (stock == null) { score += 10; reasons.push('stock unknown'); }
    else if (stock <= 0) { score += 35; reasons.push('out of stock'); }
    else if (stock < need) { score += 30; reasons.push(`stock ${stock} < need ${need}`); }
    else if (stock < cov * need) { score += 15; reasons.push(`stock under ${cov}× need`); }
    if (lead != null && lead > 26) { score += 15; reasons.push(`lead time ${Math.round(lead)} wk`); }
    else if (lead != null && lead > 12) { score += 8; reasons.push(`lead time ${Math.round(lead)} wk`); }
    score = Math.min(100, score);
    parts.push({ name: mpn || (value ? `${value} (no MPN)` : `${refs[0]}${refs.length > 1 ? '…' + refs[refs.length - 1] : ''} (no MPN)`), mfr: get('mfr'), refs, qty, need, stock, lead, src, generic, life: life.label, score, reasons,
      level: score >= 50 ? 'High' : score >= 25 ? 'Medium' : 'Low' });
  });
  if (!parts.length) return { warnings: ['No part lines under the header.'] };
  if (unread.length) warnings.push(`Some cells could not be read and were treated as unknown: ${unread.slice(0, 5).join('; ')}${unread.length > 5 ? ' …' : ''}`);

  parts.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const nH = parts.filter((p) => p.level === 'High').length, nM = parts.filter((p) => p.level === 'Medium').length;
  const single = parts.filter((p) => p.src === 1).length;
  const short = parts.filter((p) => p.stock != null && p.stock < p.need).length;
  const top = parts[0];
  const fmtCov = (p) => (p.stock == null ? '–' : p.need ? `${Number((p.stock / p.need).toPrecision(2))}×` : '–');
  const rows = parts.map((p, i) => [i + 1, p.name, p.refs.length > 4 ? `${p.refs.slice(0, 4).join(' ')} …` : p.refs.join(' ') || '–', p.score, p.level,
    p.need, p.stock == null ? '?' : p.stock, fmtCov(p), p.src == null ? (p.generic ? 'generic' : '?') : p.src, p.life, p.reasons.join('; ') || 'no flags']);
  if (nH) warnings.push(`${nH} high-risk part(s). Start with ${top.name}: ${top.reasons.join(', ')}. Buy ahead, qualify a second source, or design it out.`);
  const ch = parts.slice(0, 12);
  return {
    values: [
      { label: 'Parts scanned', value: String(parts.length), hint: `for ${builds} board(s)` },
      { label: 'High risk', value: String(nH), tone: nH ? 'bad' : 'ok' },
      { label: 'Medium risk', value: String(nM), tone: nM ? 'warn' : 'ok' },
      { label: 'Single-source', value: String(single), tone: single ? 'warn' : 'ok' },
      { label: 'Short for this build', value: String(short), tone: short ? 'bad' : 'ok', hint: 'stock < need' },
      { label: 'Riskiest', value: top.name, hint: `score ${top.score}` },
    ],
    warnings,
    charts: [{ title: 'Risk score (top parts)', type: 'bars', x: ch.map((p) => p.name.length > 14 ? p.name.slice(0, 13) + '…' : p.name), series: [{ name: 'Score', y: ch.map((p) => p.score) }], yLabel: 'score 0–100' }],
    tables: [{ title: 'Parts by risk', columns: ['#', 'Part', 'Refs', 'Score', 'Level', 'Need', 'Stock', 'Coverage', 'Sources', 'Lifecycle', 'Why'], rows }],
    notes: [
      'Score (rule of thumb): lifecycle obsolete 40 / LTB 35 / NRND 25; single source 25, two sources 10; out of stock 35, stock < need 30, stock < coverage × need 15; lead time > 26 wk 15, > 12 wk 8; unknowns 5–10. High ≥ 50, Medium ≥ 25.',
      'The data is only as fresh as your BOM export: refresh stock and lifecycle from the distributor before ordering.',
      'Sources = manufacturers that make a drop-in part; an Alternates column adds one source per listed MPN. Generic R/C/L without an MPN count as multi-source.',
    ],
  };
}
