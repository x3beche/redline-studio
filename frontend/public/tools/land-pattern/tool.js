// IPC-7351B land patterns, calculated from the component's dimensions and tolerances:
//   Z(max) = L(min) + 2·Jt + sqrt(CL² + F² + P²)        outer edge to outer edge of the pads
//   G(min) = S(max) − 2·Jh − sqrt(CS² + F² + P²)        inner edge to inner edge
//   X(max) = W(min) + 2·Js + sqrt(CW² + F² + P²)        pad width
//   S = L − 2·T; its tolerance is taken as RMS: CS = sqrt(CL² + 2·CT²), S(max) moved in by (CS,wc − CS)/2
//   pad length Y = (Z − G)/2, pad pitch across the part C = (Z + G)/2
//   courtyard = max(body, pads) + 2 × courtyard excess
// Jt/Jh/Js (toe, heel, side fillet goals) and the courtyard excess per density level come from the
// IPC-7351B tables for each lead form. Pads round up (Z, X) or down (G) to 0.01 mm, the courtyard
// up to 0.05 mm.
import { fmtNum } from '../kit/eng.js';

// Fillet goals [M, N, L] in mm: jt toe, jh heel, js side, cy courtyard excess.
const GOALS = {
  gull: { name: 'gull-wing, pitch > 0.625 mm', jt: [0.55, 0.35, 0.15], jh: [0.45, 0.35, 0.25], js: [0.05, 0.03, 0.01], cy: [0.5, 0.25, 0.1] },
  gullFine: { name: 'gull-wing, pitch ≤ 0.625 mm', jt: [0.55, 0.35, 0.15], jh: [0.45, 0.35, 0.25], js: [0.01, -0.02, -0.04], cy: [0.5, 0.25, 0.1] },
  chip: { name: 'chip, 0603 (1608) and larger', jt: [0.55, 0.35, 0.15], jh: [-0.05, -0.05, -0.05], js: [0.05, 0.0, -0.05], cy: [0.5, 0.25, 0.1] },
  chipSmall: { name: 'chip, smaller than 0603 (1608)', jt: [0.3, 0.2, 0.1], jh: [0.0, 0.0, 0.0], js: [0.05, 0.0, -0.05], cy: [0.2, 0.15, 0.1] },
  nolead: { name: 'flat no-lead (QFN/DFN)', jt: [0.4, 0.3, 0.2], jh: [0.0, 0.0, 0.0], js: [-0.04, -0.04, -0.04], cy: [0.5, 0.25, 0.1] },
  // Inward L-bend: the big fillet forms at the outer bend, the small one at the lead end under the
  // body, so the 0.8/0.5/0.2 goal is applied at the outside (Z) and 0.25/0.15/0.07 inside (G).
  molded: { name: 'molded body, inward L-bend', jt: [0.8, 0.5, 0.2], jh: [0.25, 0.15, 0.07], js: [0.01, -0.05, -0.1], cy: [0.5, 0.25, 0.1] },
};

// Component data (mm, [min, max]); typical JEDEC / EIA outlines. L: overall length across the
// terminals (lead tip to lead tip, or body length for chips and QFN), T: terminal/foot length,
// W: terminal width, bx/by: body size (max) across and along the rows, h: max height,
// n: pins, row: most pins in one row, sides: 2 or 4, p: pitch.
const P = [
  { id: '0201', ipc: 'RESC0603X33', form: 'chipSmall', L: [0.57, 0.63], T: [0.10, 0.20], W: [0.27, 0.33], bx: 0.63, by: 0.33, h: 0.33, n: 2 },
  { id: '0402', ipc: 'RESC1005X40', form: 'chipSmall', L: [0.90, 1.10], T: [0.15, 0.35], W: [0.45, 0.55], bx: 1.10, by: 0.55, h: 0.40, n: 2 },
  { id: '0603', ipc: 'RESC1608X55', form: 'chip', L: [1.50, 1.70], T: [0.15, 0.45], W: [0.70, 0.90], bx: 1.70, by: 0.90, h: 0.55, n: 2 },
  { id: '0805', ipc: 'RESC2012X60', form: 'chip', L: [1.90, 2.10], T: [0.15, 0.55], W: [1.15, 1.35], bx: 2.10, by: 1.35, h: 0.60, n: 2 },
  { id: '1206', ipc: 'RESC3216X70', form: 'chip', L: [3.00, 3.20], T: [0.25, 0.75], W: [1.50, 1.70], bx: 3.20, by: 1.70, h: 0.70, n: 2 },
  { id: '1210', ipc: 'RESC3225X70', form: 'chip', L: [3.00, 3.20], T: [0.25, 0.75], W: [2.40, 2.60], bx: 3.20, by: 2.60, h: 0.70, n: 2 },
  { id: '2010', ipc: 'RESC5025X70', form: 'chip', L: [4.90, 5.10], T: [0.35, 0.85], W: [2.35, 2.65], bx: 5.10, by: 2.65, h: 0.70, n: 2 },
  { id: '2512', ipc: 'RESC6332X70', form: 'chip', L: [6.25, 6.45], T: [0.35, 0.85], W: [3.05, 3.35], bx: 6.45, by: 3.35, h: 0.70, n: 2 },
  { id: 'Tantalum A (3216-18)', ipc: 'CAPM3216X180', form: 'molded', L: [3.00, 3.40], T: [0.50, 1.10], W: [1.10, 1.30], bx: 3.40, by: 1.80, h: 1.80, n: 2 },
  { id: 'Tantalum B (3528-21)', ipc: 'CAPM3528X210', form: 'molded', L: [3.30, 3.70], T: [0.50, 1.10], W: [2.10, 2.30], bx: 3.70, by: 3.00, h: 2.10, n: 2 },
  { id: 'SMA (DO-214AC)', ipc: 'DIOM5226X244', form: 'molded', L: [4.80, 5.28], T: [0.76, 1.52], W: [1.27, 1.63], bx: 4.60, by: 2.92, h: 2.44, n: 2 },
  { id: 'SMB (DO-214AA)', ipc: 'DIOM5436X244', form: 'molded', L: [5.21, 5.59], T: [0.76, 1.52], W: [1.96, 2.21], bx: 4.57, by: 3.94, h: 2.44, n: 2 },
  { id: 'SMC (DO-214AB)', ipc: 'DIOM7959X262', form: 'molded', L: [7.75, 8.13], T: [0.76, 1.52], W: [2.90, 3.20], bx: 7.11, by: 6.22, h: 2.62, n: 2 },
  { id: 'SOD-323', ipc: 'SOD2513X110', form: 'gull', L: [2.30, 2.70], T: [0.20, 0.45], W: [0.25, 0.40], bx: 1.80, by: 1.35, h: 1.10, n: 2 },
  { id: 'SOD-123', ipc: 'SOD3716X135', form: 'gull', L: [3.55, 3.85], T: [0.25, 0.60], W: [0.45, 0.65], bx: 2.85, by: 1.80, h: 1.35, n: 2 },
  { id: 'SOT-23-3', ipc: 'SOT95P237X112-3', form: 'gull', L: [2.10, 2.64], T: [0.30, 0.60], W: [0.30, 0.50], bx: 1.40, by: 3.04, h: 1.12, n: 3, row: 2, sides: 2, p: 0.95 },
  { id: 'SOT-23-5', ipc: 'SOT95P280X145-5', form: 'gull', L: [2.60, 3.00], T: [0.30, 0.60], W: [0.30, 0.50], bx: 1.75, by: 3.05, h: 1.45, n: 5, row: 3, sides: 2, p: 0.95 },
  { id: 'SOT-23-6', ipc: 'SOT95P280X145-6', form: 'gull', L: [2.60, 3.00], T: [0.30, 0.60], W: [0.30, 0.50], bx: 1.75, by: 3.05, h: 1.45, n: 6, row: 3, sides: 2, p: 0.95 },
  { id: 'SC-70-5 (SOT-353)', ipc: 'SOT65P210X110-5', form: 'gull', L: [1.80, 2.40], T: [0.26, 0.46], W: [0.15, 0.30], bx: 1.35, by: 2.20, h: 1.10, n: 5, row: 3, sides: 2, p: 0.65 },
  { id: 'SOT-223', ipc: 'SOT230P700X180-4', form: 'gull', L: [6.70, 7.30], T: [0.75, 1.10], W: [0.66, 0.84], tab: [2.90, 3.18], bx: 3.70, by: 6.70, h: 1.80, n: 4, row: 3, sides: 2, p: 2.30 },
  { id: 'SOIC-8', ipc: 'SOIC127P600X175-8', form: 'gull', L: [5.80, 6.20], T: [0.40, 1.27], W: [0.31, 0.51], bx: 4.00, by: 5.00, h: 1.75, n: 8, row: 4, sides: 2, p: 1.27 },
  { id: 'SOIC-14', ipc: 'SOIC127P600X175-14', form: 'gull', L: [5.80, 6.20], T: [0.40, 1.27], W: [0.31, 0.51], bx: 4.00, by: 8.75, h: 1.75, n: 14, row: 7, sides: 2, p: 1.27 },
  { id: 'SOIC-16', ipc: 'SOIC127P600X175-16', form: 'gull', L: [5.80, 6.20], T: [0.40, 1.27], W: [0.31, 0.51], bx: 4.00, by: 10.00, h: 1.75, n: 16, row: 8, sides: 2, p: 1.27 },
  { id: 'SOIC-16W', ipc: 'SOIC127P1030X265-16', form: 'gull', L: [10.00, 10.65], T: [0.40, 1.27], W: [0.31, 0.51], bx: 7.60, by: 10.50, h: 2.65, n: 16, row: 8, sides: 2, p: 1.27 },
  { id: 'MSOP-8', ipc: 'SOP65P490X110-8', form: 'gull', L: [4.75, 5.05], T: [0.40, 0.70], W: [0.22, 0.40], bx: 3.10, by: 3.10, h: 1.10, n: 8, row: 4, sides: 2, p: 0.65 },
  { id: 'MSOP-10', ipc: 'SOP50P490X110-10', form: 'gullFine', L: [4.75, 5.05], T: [0.40, 0.70], W: [0.17, 0.27], bx: 3.10, by: 3.10, h: 1.10, n: 10, row: 5, sides: 2, p: 0.50 },
  { id: 'TSSOP-14', ipc: 'TSSOP65P640X120-14', form: 'gull', L: [6.20, 6.60], T: [0.45, 0.75], W: [0.19, 0.30], bx: 4.50, by: 5.10, h: 1.20, n: 14, row: 7, sides: 2, p: 0.65 },
  { id: 'TSSOP-16', ipc: 'TSSOP65P640X120-16', form: 'gull', L: [6.20, 6.60], T: [0.45, 0.75], W: [0.19, 0.30], bx: 4.50, by: 5.10, h: 1.20, n: 16, row: 8, sides: 2, p: 0.65 },
  { id: 'TSSOP-20', ipc: 'TSSOP65P640X120-20', form: 'gull', L: [6.20, 6.60], T: [0.45, 0.75], W: [0.19, 0.30], bx: 4.50, by: 6.60, h: 1.20, n: 20, row: 10, sides: 2, p: 0.65 },
  { id: 'TSSOP-28', ipc: 'TSSOP65P640X120-28', form: 'gull', L: [6.20, 6.60], T: [0.45, 0.75], W: [0.19, 0.30], bx: 4.50, by: 9.80, h: 1.20, n: 28, row: 14, sides: 2, p: 0.65 },
  { id: 'LQFP-32 (7×7, 0.8)', ipc: 'QFP80P900X900X160-32', form: 'gull', L: [8.80, 9.20], T: [0.45, 0.75], W: [0.30, 0.45], bx: 7.10, by: 7.10, h: 1.60, n: 32, row: 8, sides: 4, p: 0.80 },
  { id: 'LQFP-48 (7×7, 0.5)', ipc: 'QFP50P900X900X160-48', form: 'gullFine', L: [8.80, 9.20], T: [0.45, 0.75], W: [0.17, 0.27], bx: 7.10, by: 7.10, h: 1.60, n: 48, row: 12, sides: 4, p: 0.50 },
  { id: 'LQFP-64 (10×10, 0.5)', ipc: 'QFP50P1200X1200X160-64', form: 'gullFine', L: [11.80, 12.20], T: [0.45, 0.75], W: [0.17, 0.27], bx: 10.10, by: 10.10, h: 1.60, n: 64, row: 16, sides: 4, p: 0.50 },
  { id: 'LQFP-100 (14×14, 0.5)', ipc: 'QFP50P1600X1600X160-100', form: 'gullFine', L: [15.80, 16.20], T: [0.45, 0.75], W: [0.17, 0.27], bx: 14.10, by: 14.10, h: 1.60, n: 100, row: 25, sides: 4, p: 0.50 },
  { id: 'DFN-8 (3×3, 0.65)', ipc: 'SON65P300X300X90-9', form: 'nolead', L: [2.90, 3.10], T: [0.30, 0.50], W: [0.25, 0.35], bx: 3.10, by: 3.10, h: 0.90, n: 8, row: 4, sides: 2, p: 0.65, ep: [1.60, 2.40] },
  { id: 'QFN-16 (3×3, 0.5)', ipc: 'QFN50P300X300X90-17', form: 'nolead', L: [2.90, 3.10], T: [0.30, 0.50], W: [0.18, 0.30], bx: 3.10, by: 3.10, h: 0.90, n: 16, row: 4, sides: 4, p: 0.50, ep: [1.70, 1.70] },
  { id: 'QFN-20 (4×4, 0.5)', ipc: 'QFN50P400X400X90-21', form: 'nolead', L: [3.90, 4.10], T: [0.30, 0.50], W: [0.18, 0.30], bx: 4.10, by: 4.10, h: 0.90, n: 20, row: 5, sides: 4, p: 0.50, ep: [2.60, 2.60] },
  { id: 'QFN-24 (4×4, 0.5)', ipc: 'QFN50P400X400X90-25', form: 'nolead', L: [3.90, 4.10], T: [0.30, 0.50], W: [0.18, 0.30], bx: 4.10, by: 4.10, h: 0.90, n: 24, row: 6, sides: 4, p: 0.50, ep: [2.60, 2.60] },
  { id: 'QFN-32 (5×5, 0.5)', ipc: 'QFN50P500X500X90-33', form: 'nolead', L: [4.90, 5.10], T: [0.30, 0.50], W: [0.18, 0.30], bx: 5.10, by: 5.10, h: 0.90, n: 32, row: 8, sides: 4, p: 0.50, ep: [3.45, 3.45] },
  { id: 'QFN-48 (7×7, 0.5)', ipc: 'QFN50P700X700X90-49', form: 'nolead', L: [6.90, 7.10], T: [0.30, 0.50], W: [0.18, 0.30], bx: 7.10, by: 7.10, h: 0.90, n: 48, row: 12, sides: 4, p: 0.50, ep: [5.15, 5.15] },
];

const LEVEL = { M: 0, N: 1, L: 2 };
const LEVEL_NAME = { M: 'M, most (low density)', N: 'N, nominal', L: 'L, least (high density)' };
const up = (v, g) => Math.ceil(v / g - 1e-9) * g;
const down = (v, g) => Math.floor(v / g + 1e-9) * g;
const r2 = (v) => Number(v.toFixed(2));

export function land(pk, level, F, Pl) {
  const g = GOALS[pk.form];
  const i = LEVEL[level] ?? 1;
  const CL = pk.L[1] - pk.L[0], CT = pk.T[1] - pk.T[0], CW = pk.W[1] - pk.W[0];
  const sMin = pk.L[0] - 2 * pk.T[1], sMax = pk.L[1] - 2 * pk.T[0];
  const CSwc = sMax - sMin, CS = Math.sqrt(CL * CL + 2 * CT * CT);
  const sMaxRms = sMax - (CSwc - CS) / 2;
  const tol = (c) => Math.sqrt(c * c + F * F + Pl * Pl);
  const Z = up(pk.L[0] + 2 * g.jt[i] + tol(CL), 0.01);
  const G = Math.max(0, down(sMaxRms - 2 * g.jh[i] - tol(CS), 0.01));
  let X = up(pk.W[0] + 2 * g.js[i] + tol(CW), 0.01);
  const Xtab = pk.tab ? up(pk.tab[0] + 2 * g.js[i] + tol(pk.tab[1] - pk.tab[0]), 0.01) : null;
  const Y = (Z - G) / 2, C = (Z + G) / 2;
  const gap = pk.p ? pk.p - X : null;
  const row = pk.row || 1;
  const along = Math.max(pk.by, pk.p ? (row - 1) * pk.p + X : X, Xtab || 0);
  const across = Math.max(pk.bx, Z);
  const cy = g.cy[i];
  const cyX = up(across + 2 * cy, 0.05);
  const cyY = pk.sides === 4 ? cyX : up(along + 2 * cy, 0.05);
  return { Z: r2(Z), G: r2(G), X: r2(X), Y: r2(Y), C: r2(C), Xtab: Xtab && r2(Xtab), gap: gap != null ? r2(gap) : null, cyX: r2(cyX), cyY: r2(cyY), goal: g };
}

export function run({ pkg, filter, level, fab, place }) {
  const warnings = [];
  const lv = LEVEL[level] != null ? level : 'N';
  const F = Number.isFinite(fab) && fab >= 0 ? fab : 0.05;
  const Pl = Number.isFinite(place) && place >= 0 ? place : 0.025;
  if (F > 0.2 || Pl > 0.2) warnings.push('Fabrication or placement tolerance above 0.2 mm is far beyond normal (0.05 / 0.025 mm): check the values are in mm.');
  const q = String(filter || '').trim().toLowerCase();
  const one = P.find((x) => x.id === pkg);
  const list = one ? [one] : P.filter((x) => !q || `${x.id} ${x.ipc} ${GOALS[x.form].name}`.toLowerCase().includes(q));
  if (!list.length) return { warnings: [`No package matches "${filter}". Try 0603, SOIC, QFN, SOT or TSSOP.`] };

  const name = (x) => `${x.ipc}${lv}`;
  const size = (a, b) => `${fmtNum(a, 3)} × ${fmtNum(b, 3)}`;
  if (!one) {
    const rows = list.map((x) => {
      const r = land(x, lv, F, Pl);
      return [x.id, name(x), x.p ? fmtNum(x.p, 3) : '–', size(r.Y, r.X) + (r.Xtab ? ` (tab ${fmtNum(r.Xtab, 3)})` : ''), fmtNum(r.C, 3), fmtNum(r.Z, 3), fmtNum(r.G, 3), size(r.cyX, r.cyY)];
    });
    // For the page's drawing: every matching pattern's lands, as run() computed them.
    const patterns = list.map((x) => {
      const r = land(x, lv, F, Pl);
      return { id: x.id, ipc: name(x), form: x.form, p: x.p || null, n: x.n, row: x.row || 1, sides: x.sides || 2, ep: x.ep || null,
        bx: x.bx, by: x.by, L: x.L, Z: r.Z, G: r.G, X: r.X, Y: r.Y, C: r.C, Xtab: r.Xtab, gap: r.gap, cyX: r.cyX, cyY: r.cyY };
    });
    return {
      pattern: null,
      patterns,
      values: [
        { label: 'Packages', value: `${list.length} of ${P.length}`, hint: q ? `matching "${filter}"` : 'all' },
        { label: 'Density level', value: LEVEL_NAME[lv] },
      ],
      warnings,
      tables: [{ title: `Land patterns, density ${lv} (mm; pad = length × width)`, columns: ['Package', 'IPC name', 'Pitch', 'Pad', 'Pad centres C', 'Z', 'G', 'Courtyard'], rows }],
      notes: notes(F, Pl),
    };
  }

  const r = land(one, lv, F, Pl);
  if (r.gap != null && r.gap < 0.15) warnings.push(`Only ${fmtNum(r.gap, 3)} mm between neighbouring pads: too little for a solder mask web. Use density L, or narrow the pads to keep 0.15-0.2 mm.`);
  if (r.G < 0.2) warnings.push(`The pads are only ${fmtNum(r.G, 3)} mm apart across the part: solder may bridge under it. Check the component's tolerances.`);
  const values = [
    { label: 'Pad (length × width)', value: size(r.Y, r.X), unit: 'mm', tone: 'ok' },
    { label: 'Pad centres across (C)', value: fmtNum(r.C, 3), unit: 'mm', hint: `pad centres at ±${fmtNum(r.C / 2, 3)}` },
    { label: 'Outer / inner span (Z / G)', value: `${fmtNum(r.Z, 3)} / ${fmtNum(r.G, 3)}`, unit: 'mm' },
    { label: 'Courtyard', value: size(r.cyX, r.cyY), unit: 'mm', hint: `excess ${r.goal.cy[LEVEL[lv]]} mm` },
  ];
  if (one.p) values.push({ label: 'Pitch', value: fmtNum(one.p, 3), unit: 'mm', hint: r.gap != null ? `gap between pads ${fmtNum(r.gap, 3)} mm` : '' });
  if (one.p) values.push({ label: 'First pin', value: `−${fmtNum(r.C / 2, 3)}, ${fmtNum((one.row - 1) * one.p / 2, 3)}`, unit: 'mm', hint: 'x, y of pin 1: top left, y up, counter-clockwise' });
  if (r.Xtab) values.push({ label: 'Tab pad', value: size(r.Y, r.Xtab), unit: 'mm', hint: 'opposite pins 1-3' });
  if (one.ep) values.push({ label: 'Thermal pad', value: size(one.ep[0], one.ep[1]), unit: 'mm', hint: 'land = exposed pad nominal; paste 50-70 % in window panes' });

  const rows = ['M', 'N', 'L'].map((k) => {
    const t = land(one, k, F, Pl);
    return [k, size(t.Y, t.X), fmtNum(t.C, 3), fmtNum(t.Z, 3), fmtNum(t.G, 3), size(t.cyX, t.cyY)];
  });
  const dims = [
    ['Overall length L (tip to tip)', fmtNum(one.L[0], 3), fmtNum(one.L[1], 3)],
    ['Terminal / foot length T', fmtNum(one.T[0], 3), fmtNum(one.T[1], 3)],
    ['Terminal width W', fmtNum(one.W[0], 3), fmtNum(one.W[1], 3)],
    ['Body (max), across × along', size(one.bx, one.by), ''],
    ['Height (max)', fmtNum(one.h, 3), ''],
  ];
  if (one.ep && one.form === 'nolead') warnings.push('Exposed pad sizes differ between makers: take the thermal land from your part\'s datasheet.');
  const levels = Object.fromEntries(['M', 'N', 'L'].map((k) => {
    const t = land(one, k, F, Pl);
    return [k, { Z: t.Z, G: t.G, X: t.X, Y: t.Y, C: t.C, Xtab: t.Xtab, gap: t.gap, cyX: t.cyX, cyY: t.cyY, cy: t.goal.cy[LEVEL[k]] }];
  }));
  // For the page's drawing: the pattern and the part it was calculated for (mm).
  const pattern = {
    id: one.id, ipc: name(one), level: lv, form: one.form, formName: r.goal.name,
    p: one.p || null, n: one.n, row: one.row || 1, sides: one.sides || 2, ep: one.ep || null, tab: one.tab || null,
    L: one.L, T: one.T, W: one.W, bx: one.bx, by: one.by, h: one.h,
    Z: r.Z, G: r.G, X: r.X, Y: r.Y, C: r.C, Xtab: r.Xtab, gap: r.gap, cyX: r.cyX, cyY: r.cyY, cy: r.goal.cy[LEVEL[lv]],
    jt: r.goal.jt[LEVEL[lv]], jh: r.goal.jh[LEVEL[lv]], js: r.goal.js[LEVEL[lv]],
    pin1: one.p ? [-r.C / 2, (one.row - 1) * one.p / 2] : null,
    F, P: Pl, levels,
  };
  return {
    pattern,
    values,
    warnings,
    tables: [
      { title: `${name(one)}: ${one.id} at the three density levels (mm)${one.form.startsWith('chip') ? '; CAPC… for capacitors, same land' : ''}`, columns: ['Level', 'Pad', 'C', 'Z', 'G', 'Courtyard'], rows },
      { title: 'Component dimensions used (mm)', columns: ['Dimension', 'Min', 'Max'], rows: dims },
    ],
    notes: notes(F, Pl),
  };
}

function notes(F, Pl) {
  return [
    `Calculated with the IPC-7351B equations, fabrication tolerance F = ${F} mm and placement tolerance P = ${Pl} mm; pads rounded to 0.01 mm, courtyards to 0.05 mm.`,
    'The component dimensions are typical JEDEC/EIA outlines. Makers differ: for a production footprint, enter your part\'s datasheet tolerances in an IPC-7351 calculator.',
    'Density N (nominal) suits most boards; M (most) is for hand soldering and wave, L (least) for dense boards and phones.',
  ];
}

export const PACKAGES = P.map((x) => x.id);
// The component outlines (not the lands), for drawing the packages to scale.
export const OUTLINES = P.map((x) => ({ id: x.id, ipc: x.ipc, formName: GOALS[x.form].name, form: x.form, L: x.L, T: x.T, W: x.W, bx: x.bx, by: x.by, n: x.n, row: x.row || 1, sides: x.sides || 2, p: x.p || null, ep: x.ep || null, tab: x.tab || null,
  family: x.form.startsWith('chip') ? 'Chip' : x.form === 'molded' ? 'Molded' : x.form === 'nolead' ? 'QFN / DFN' : x.sides === 4 ? 'LQFP' : /^SO[DT]|^SC/.test(x.id) ? 'SOD / SOT' : 'SOIC / SOP' }));
