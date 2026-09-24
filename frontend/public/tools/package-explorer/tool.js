// Package dimensions for a to-scale comparison. Nominal sizes (mm) from the JEDEC / EIA outlines
// (EIA-198 chip sizes, JEDEC MS-012, MO-153, MO-187, MO-220, TO-236, TO-261, TO-252, DO-214).
// The drawing (view.js) uses result.shapes: every number it draws is here, so an agent gets them too.
import { fmtNum } from '../kit/eng.js';

// cat: chip | discrete | ic.  bx × by: body (x is the long axis for chips, the row axis for ICs).
// sx × sy: overall size with leads.  leads: [side, count, pitch, width, extension beyond body]
// (a negative extension draws a pad inside the body edge: no-lead parts).  term: chip end band.
// ep: exposed pad [x, y].  balls: [cols, rows, pitch, diameter].
const PK = [
  { id: '01005', metric: '0402M', cat: 'chip', bx: 0.4, by: 0.2, h: 0.13, term: 0.1, pins: 2 },
  { id: '0201', metric: '0603M', cat: 'chip', bx: 0.6, by: 0.3, h: 0.3, term: 0.15, pins: 2 },
  { id: '0402', metric: '1005M', cat: 'chip', bx: 1.0, by: 0.5, h: 0.35, term: 0.25, pins: 2 },
  { id: '0603', metric: '1608M', cat: 'chip', bx: 1.6, by: 0.8, h: 0.45, term: 0.3, pins: 2 },
  { id: '0805', metric: '2012M', cat: 'chip', bx: 2.0, by: 1.25, h: 0.5, term: 0.4, pins: 2 },
  { id: '1206', metric: '3216M', cat: 'chip', bx: 3.2, by: 1.6, h: 0.55, term: 0.5, pins: 2 },
  { id: '1210', metric: '3225M', cat: 'chip', bx: 3.2, by: 2.5, h: 0.55, term: 0.5, pins: 2 },
  { id: '1812', metric: '4532M', cat: 'chip', bx: 4.5, by: 3.2, h: 0.6, term: 0.5, pins: 2 },
  { id: '2010', metric: '5025M', cat: 'chip', bx: 5.0, by: 2.5, h: 0.55, term: 0.6, pins: 2 },
  { id: '2512', metric: '6332M', cat: 'chip', bx: 6.35, by: 3.2, h: 0.55, term: 0.6, pins: 2 },
  { id: 'SOD-523', cat: 'discrete', bx: 1.2, by: 0.8, h: 0.6, pins: 2, leads: [['L', 1, 0, 0.3, 0.2], ['R', 1, 0, 0.3, 0.2]] },
  { id: 'SOD-323', cat: 'discrete', bx: 1.7, by: 1.25, h: 1.0, pins: 2, leads: [['L', 1, 0, 0.3, 0.4], ['R', 1, 0, 0.3, 0.4]] },
  { id: 'SOD-123', cat: 'discrete', bx: 2.7, by: 1.6, h: 1.17, pins: 2, leads: [['L', 1, 0, 0.55, 0.5], ['R', 1, 0, 0.55, 0.5]] },
  { id: 'SMA (DO-214AC)', cat: 'discrete', bx: 4.3, by: 2.6, h: 2.2, pins: 2, leads: [['L', 1, 0, 1.45, 0.35], ['R', 1, 0, 1.45, 0.35]] },
  { id: 'SMB (DO-214AA)', cat: 'discrete', bx: 4.3, by: 3.6, h: 2.2, pins: 2, leads: [['L', 1, 0, 2.1, 0.55], ['R', 1, 0, 2.1, 0.55]] },
  { id: 'SMC (DO-214AB)', cat: 'discrete', bx: 6.9, by: 5.9, h: 2.3, pins: 2, leads: [['L', 1, 0, 3.05, 0.5], ['R', 1, 0, 3.05, 0.5]] },
  { id: 'SOT-23', cat: 'discrete', bx: 2.9, by: 1.3, h: 1.0, p: 0.95, pins: 3, leads: [['B', 2, 1.9, 0.4, 0.55], ['T', 1, 0, 0.4, 0.55]] },
  { id: 'SOT-23-6', cat: 'discrete', bx: 2.9, by: 1.6, h: 1.2, p: 0.95, pins: 6, leads: [['B', 3, 0.95, 0.4, 0.6], ['T', 3, 0.95, 0.4, 0.6]] },
  { id: 'SC-70-6 (SOT-363)', cat: 'discrete', bx: 2.0, by: 1.25, h: 0.95, p: 0.65, pins: 6, leads: [['B', 3, 0.65, 0.2, 0.43], ['T', 3, 0.65, 0.2, 0.43]] },
  { id: 'SOT-223', cat: 'discrete', bx: 6.5, by: 3.5, h: 1.6, p: 2.3, pins: 4, leads: [['B', 3, 2.3, 0.7, 1.75], ['T', 1, 0, 3.0, 1.75]] },
  { id: 'DPAK (TO-252)', cat: 'discrete', bx: 6.6, by: 6.1, h: 2.3, p: 2.29, pins: 3, leads: [['B', 2, 4.57, 0.8, 3.0], ['T', 1, 0, 5.3, 0.9]] },
  { id: 'SOIC-8', cat: 'ic', bx: 4.9, by: 3.9, h: 1.5, p: 1.27, pins: 8, leads: [['B', 4, 1.27, 0.42, 1.05], ['T', 4, 1.27, 0.42, 1.05]] },
  { id: 'SOIC-16', cat: 'ic', bx: 9.9, by: 3.9, h: 1.5, p: 1.27, pins: 16, leads: [['B', 8, 1.27, 0.42, 1.05], ['T', 8, 1.27, 0.42, 1.05]] },
  { id: 'MSOP-8', cat: 'ic', bx: 3.0, by: 3.0, h: 0.95, p: 0.65, pins: 8, leads: [['B', 4, 0.65, 0.3, 0.95], ['T', 4, 0.65, 0.3, 0.95]] },
  { id: 'TSSOP-20', cat: 'ic', bx: 6.5, by: 4.4, h: 1.0, p: 0.65, pins: 20, leads: [['B', 10, 0.65, 0.25, 1.0], ['T', 10, 0.65, 0.25, 1.0]] },
  { id: 'DFN-8 (2×2)', cat: 'ic', bx: 2.0, by: 2.0, h: 0.75, p: 0.5, pins: 8, ep: [1.6, 0.9], leads: [['B', 4, 0.5, 0.25, -0.3], ['T', 4, 0.5, 0.25, -0.3]] },
  { id: 'QFN-16 (3×3)', cat: 'ic', bx: 3.0, by: 3.0, h: 0.85, p: 0.5, pins: 16, ep: [1.7, 1.7], leads: [['B', 4, 0.5, 0.25, -0.4], ['T', 4, 0.5, 0.25, -0.4], ['L', 4, 0.5, 0.25, -0.4], ['R', 4, 0.5, 0.25, -0.4]] },
  { id: 'QFN-32 (5×5)', cat: 'ic', bx: 5.0, by: 5.0, h: 0.85, p: 0.5, pins: 32, ep: [3.45, 3.45], leads: [['B', 8, 0.5, 0.25, -0.4], ['T', 8, 0.5, 0.25, -0.4], ['L', 8, 0.5, 0.25, -0.4], ['R', 8, 0.5, 0.25, -0.4]] },
  { id: 'QFN-48 (7×7)', cat: 'ic', bx: 7.0, by: 7.0, h: 0.85, p: 0.5, pins: 48, ep: [5.15, 5.15], leads: [['B', 12, 0.5, 0.25, -0.4], ['T', 12, 0.5, 0.25, -0.4], ['L', 12, 0.5, 0.25, -0.4], ['R', 12, 0.5, 0.25, -0.4]] },
  { id: 'LQFP-48 (7×7)', cat: 'ic', bx: 7.0, by: 7.0, h: 1.4, p: 0.5, pins: 48, leads: [['B', 12, 0.5, 0.22, 1.0], ['T', 12, 0.5, 0.22, 1.0], ['L', 12, 0.5, 0.22, 1.0], ['R', 12, 0.5, 0.22, 1.0]] },
  { id: 'LQFP-100 (14×14)', cat: 'ic', bx: 14.0, by: 14.0, h: 1.4, p: 0.5, pins: 100, leads: [['B', 25, 0.5, 0.22, 1.0], ['T', 25, 0.5, 0.22, 1.0], ['L', 25, 0.5, 0.22, 1.0], ['R', 25, 0.5, 0.22, 1.0]] },
  { id: 'WLCSP-9 (1.5×1.5)', cat: 'ic', bx: 1.5, by: 1.5, h: 0.5, p: 0.5, pins: 9, balls: [3, 3, 0.5, 0.25] },
  { id: 'BGA-256 (17×17)', cat: 'ic', bx: 17.0, by: 17.0, h: 1.5, p: 1.0, pins: 256, balls: [16, 16, 1.0, 0.5] },
];

const REF = PK.find((p) => p.id === '0603');

function overall(p) {
  let sx = p.bx, sy = p.by;
  for (const [side, , , , ext] of p.leads || []) {
    if (ext <= 0) continue;
    if (side === 'L' || side === 'R') sx = Math.max(sx, p.bx + 2 * ext);
    else sy = Math.max(sy, p.by + 2 * ext);
  }
  return [Number(sx.toFixed(2)), Number(sy.toFixed(2))];
}

export function run({ group, filter, sort, custom }) {
  const warnings = [];
  const q = String(filter || '').trim().toLowerCase();
  const terms = q.split(/[,;]+/).map((t) => t.trim()).filter(Boolean);
  let list = PK.filter((p) => (group === 'all' || !group || p.cat === group)
    && (!terms.length || terms.some((t) => p.id.toLowerCase().includes(t) || (/m$/.test(t) && (p.metric || '').toLowerCase() === t))));
  // A custom body from the user, e.g. "5x4" or "5 x 4 x 1": drawn as a plain block for comparison.
  const cm = /^\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)(?:\s*[x×*]\s*(\d+(?:\.\d+)?))?\s*$/i.exec(String(custom || ''));
  if (String(custom || '').trim() && !cm) warnings.push(`"${custom}" is not a size: write it as length x width in mm, e.g. 5x4 or 5x4x1.`);
  if (cm) {
    const bx = Number(cm[1]), by = Number(cm[2]);
    if (bx > 0 && by > 0 && bx <= 100 && by <= 100) list = [...list, { id: `Yours (${bx}×${by})`, cat: 'custom', bx, by, h: cm[3] ? Number(cm[3]) : undefined }];
    else warnings.push('A custom size must be between 0 and 100 mm on each side.');
  }
  if (!list.length) return { warnings: [`Nothing matches "${filter}". Try 0402, SOT, QFN or leave the filter empty.`] };
  const shapes = list.map((p) => {
    const [sx, sy] = overall(p);
    return { id: p.id, cat: p.cat, bx: p.bx, by: p.by, sx, sy, h: p.h, term: p.term || 0, leads: p.leads || [], ep: p.ep || undefined, balls: p.balls || undefined, area: Number((sx * sy).toFixed(3)) };
  });
  if (sort === 'area') shapes.sort((a, b) => a.area - b.area);
  const refArea = REF.bx * REF.by;
  const rows = shapes.map((s) => {
    const p = list.find((x) => x.id === s.id);
    return [s.id + (p.metric ? ` (${p.metric})` : ''), `${fmtNum(s.bx, 3)} × ${fmtNum(s.by, 3)}`, s.h != null ? fmtNum(s.h, 3) : '–',
      `${fmtNum(s.sx, 3)} × ${fmtNum(s.sy, 3)}`, p.p ? fmtNum(p.p, 3) : '–', p.pins ?? '–', fmtNum(s.area, 3), `${fmtNum(s.area / refArea, 3)}×`];
  });
  const byArea = [...shapes].sort((a, b) => a.area - b.area);
  const small = byArea[0], big = byArea[byArea.length - 1];
  return {
    values: [
      { label: 'Packages shown', value: shapes.length },
      { label: 'Smallest', value: small.id, hint: `${fmtNum(small.sx, 3)} × ${fmtNum(small.sy, 3)} mm` },
      { label: 'Largest', value: big.id, hint: `${fmtNum(big.sx, 3)} × ${fmtNum(big.sy, 3)} mm` },
      { label: 'Largest / smallest area', value: `${fmtNum(big.area / small.area, 3)}×` },
    ],
    warnings,
    tables: [{ title: 'Nominal dimensions (mm)', columns: ['Package', 'Body', 'Height', 'With leads', 'Pitch', 'Pins', 'Area mm²', 'vs 0603'], rows }],
    shapes,
    notes: [
      'Nominal sizes; each maker\'s outline differs by a few tenths of a millimetre, and heights vary a lot (thin QFNs, tall MLCCs).',
      'Chip sizes are the inch codes (EIA); the metric code is in brackets. 0402 inch is 1005 metric, not 0402 metric.',
      'The drawing is to one common scale; the grid is 1 mm.',
    ],
  };
}
