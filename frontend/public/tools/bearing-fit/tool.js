// Shaft and housing tolerance classes for a radial rolling bearing, and the
// fit they make with the bearing's own tolerances.
//
// Choice of class: condensed from the SKF and NSK general tables for solid
// steel shafts and cast-iron / steel housings (SKF Rolling bearings catalogue,
// "Selecting fits", tables 2-4; NSK Rolling Bearings, section 8.2). Rotating
// ring -> interference fit; stationary ring -> a fit that lets it creep or slide.
//
// Limit deviations: ISO 286-1/-2. IT grades are tabulated; fundamental
// deviations for g, k, m, n, p (shafts) are tabulated, and the holes follow
// ISO 286-1 rules: G: EI = -es(g); H: EI = 0; K, M, N (<= IT8) and P (<= IT7):
// ES = -ei(shaft letter) + delta, delta = IT(n) - IT(n-1) (0 up to 3 mm);
// JS / js: +-IT/2; J7 and j5/j6 from the ISO 286-2 table.
// Bearing tolerances: ISO 492 normal class, mean bore / mean OD deviation
// (upper deviation 0).

// Size ranges "over .. up to and including", mm.
const R = [3, 6, 10, 18, 30, 50, 80, 120, 180, 250, 315, 400, 500];
const IT = { // um
  5: [4, 5, 6, 8, 9, 11, 13, 15, 18, 20, 23, 25, 27],
  6: [6, 8, 9, 11, 13, 16, 19, 22, 25, 29, 32, 36, 40],
  7: [10, 12, 15, 18, 21, 25, 30, 35, 40, 46, 52, 57, 63],
  8: [14, 18, 22, 27, 33, 39, 46, 54, 63, 72, 81, 89, 97],
};
const ES_G = [-2, -4, -5, -6, -7, -9, -10, -12, -14, -15, -17, -18, -20]; // es of g
const EI_K = [0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5]; // ei of k (IT4..IT7)
const EI_M = [2, 4, 6, 7, 8, 9, 11, 13, 15, 17, 20, 21, 23];
const EI_N = [4, 8, 10, 12, 15, 17, 20, 23, 27, 31, 34, 37, 40];
const EI_P = [6, 12, 15, 18, 22, 26, 32, 37, 43, 50, 56, 62, 68];
const EI_J = [-2, -2, -2, -3, -4, -5, -7, -9, -11, -13, -16, -18, -20]; // j5 and j6 lower deviation
const ES_J7 = [4, 6, 8, 10, 12, 14, 18, 22, 26, 30, 36, 39, 43];

// ISO 492 normal class: [up to d, lower deviation of mean bore (um)] and of mean OD.
const BORE = [[2.5, -8], [10, -8], [18, -8], [30, -10], [50, -12], [80, -15], [120, -20], [180, -25], [250, -30], [315, -35], [400, -40], [500, -45]];
const OD = [[6, -8], [18, -8], [30, -9], [50, -11], [80, -13], [120, -15], [150, -18], [180, -25], [250, -30], [315, -35], [400, -40], [500, -45], [630, -50]];

const idx = (s) => R.findIndex((r) => s <= r);

/** Shaft limit deviations [ei, es] in um, or null. */
export function shaftDev(cls, s) {
  const i = idx(s);
  if (i < 0 || s <= 0) return null;
  const [, letter, g] = /^([a-z]+)(\d)$/.exec(cls) || [];
  const it = IT[g]?.[i];
  if (it == null) return null;
  switch (letter) {
    case 'g': return [ES_G[i] - it, ES_G[i]];
    case 'h': return [-it, 0];
    case 'j': return [EI_J[i], EI_J[i] + it];
    case 'js': return [-it / 2, it / 2];
    case 'k': return [EI_K[i], EI_K[i] + it];
    case 'm': return [EI_M[i], EI_M[i] + it];
    case 'n': return [EI_N[i], EI_N[i] + it];
    case 'p': return [EI_P[i], EI_P[i] + it];
    default: return null;
  }
}

/** Hole limit deviations [EI, ES] in um, or null. */
export function holeDev(cls, s) {
  const i = idx(s);
  if (i < 0 || s <= 0) return null;
  const [, letter, g] = /^([A-Z]+)(\d)$/.exec(cls) || [];
  const n = Number(g);
  const it = IT[n]?.[i];
  if (it == null) return null;
  const delta = i === 0 ? 0 : it - (IT[n - 1]?.[i] ?? 0);
  switch (letter) {
    case 'G': return [-ES_G[i], -ES_G[i] + it];
    case 'H': return [0, it];
    case 'J': return n === 7 ? [ES_J7[i] - it, ES_J7[i]] : null;
    case 'JS': return [-it / 2, it / 2];
    case 'K': { const es = -EI_K[i] + delta; return [es - it, es]; }
    case 'M': { const es = -EI_M[i] + delta; return [es - it, es]; }
    case 'N': { const es = -EI_N[i] + delta; return [es - it, es]; }
    case 'P': { const es = -EI_P[i] + delta; return [es - it, es]; }
    default: return null;
  }
}

const bearingDev = (table, s) => (table.find(([u]) => s <= u) || [null, null])[1];

// Shaft class for a rotating inner ring (or indeterminate direction):
// [up to d mm, class] by bearing type and load.
const SHAFT_ROT = {
  ball: {
    light: [[18, 'h5'], [100, 'j6'], [200, 'k6'], [500, 'm6']],
    normal: [[18, 'j5'], [100, 'k5'], [140, 'm5'], [200, 'm6'], [500, 'n6']],
    heavy: [[18, 'k5'], [50, 'm5'], [140, 'n6'], [500, 'p6']],
  },
  roller: {
    light: [[40, 'j6'], [140, 'k6'], [500, 'm6']],
    normal: [[40, 'k5'], [65, 'm5'], [140, 'm6'], [200, 'n6'], [500, 'p6']],
    heavy: [[50, 'm6'], [100, 'n6'], [500, 'p6']],
  },
};

const pick = (rows, d) => (rows.find(([u]) => d <= u) || rows[rows.length - 1])[1];
const sg = (v) => `${v > 0 ? '+' : ''}${Number(v.toFixed(1))}`;
const um = (v) => `${sg(v)} µm`;

export function run({ d, D, rotating, load, type, housing, slide }) {
  const warnings = [];
  const notes = [];
  if (!(d > 0) || !(D > 0)) return { warnings: ['Give the bearing bore d and outside diameter D in mm (e.g. 6204: 20 and 47).'] };
  if (D <= d) return { warnings: ['The outside diameter must be larger than the bore.'] };
  if (d < 3 || D > 500) return { warnings: ['This table covers bores from 3 mm and outside diameters up to 500 mm.'] };
  const t = type === 'roller' ? 'roller' : 'ball';
  const ld = ['light', 'normal', 'heavy'].includes(load) ? load : 'normal';

  // Choose the classes.
  let shaft, hole, why;
  if (rotating === 'outer') {
    // Load stationary relative to the inner ring (wheel hub on a fixed axle).
    shaft = slide ? 'g6' : 'h6';
    hole = ld === 'light' ? 'M7' : ld === 'normal' ? 'N7' : 'P7';
    why = 'The outer ring turns with the load: it needs interference in the housing; the inner ring on the stationary axle may be a sliding fit.';
    if (housing === 'split') warnings.push('A rotating outer ring needs an interference fit, which a split housing cannot give reliably: use a solid housing or hub.');
  } else if (rotating === 'indeterminate') {
    shaft = pick(SHAFT_ROT[t][ld], d);
    hole = ld === 'light' ? 'K7' : ld === 'normal' ? 'M7' : 'N7';
    why = 'Direction of load indeterminate (unbalance, vibration): both rings get an interference fit.';
    if (housing === 'split') warnings.push('Interference in a split housing distorts the outer ring: prefer a solid housing for indeterminate loads.');
  } else {
    // Usual case: shaft turns, load direction fixed (belt pull, gear force, weight).
    shaft = pick(SHAFT_ROT[t][ld], d);
    if (housing === 'split') hole = 'H7';
    else hole = slide ? (ld === 'heavy' ? 'H7' : 'G7') : ld === 'heavy' ? 'J7' : 'H7';
    why = 'The inner ring turns relative to the load: it needs an interference fit on the shaft or it creeps and wears; the stationary outer ring can have a sliding fit.';
    if (slide) notes.push('The outer ring of the floating (non-locating) bearing must slide axially as the shaft grows with heat: H7, or G7 for easy sliding.');
  }

  const sd = shaftDev(shaft, d);
  const hd = holeDev(hole, D);
  const bd = bearingDev(BORE, d);
  const od = bearingDev(OD, D);
  if (!sd || !hd || bd == null || od == null) return { warnings: ['Size out of the tabulated range.'] };

  // Shaft vs bore: interference positive. Bore runs from d + bd to d.
  const shMax = sd[1] - bd, shMin = sd[0] - 0;
  // Housing vs OD: clearance positive. OD runs from D + od to D.
  const hoMax = hd[1] - od, hoMin = hd[0] - 0;
  const fitWord = (lo, hi, pos, neg) => (lo >= 0 ? pos : hi <= 0 ? neg : 'transition');

  const lim = (n, v) => `${(n + v[0] / 1000).toFixed(3)} – ${(n + v[1] / 1000).toFixed(3)} mm`;
  const values = [
    { label: 'Shaft tolerance', value: shaft, tone: 'ok', hint: `Ø${d}: ${lim(d, sd)} (${um(sd[0])} / ${um(sd[1])})` },
    { label: 'Fit on shaft', value: fitWord(shMin, shMax, 'interference', 'clearance'),
      hint: `${shMax >= 0 ? `${um(shMax)} max interference` : `${um(-shMax)} min clearance`}, ${shMin >= 0 ? `${um(shMin)} min interference` : `${um(-shMin)} max clearance`}` },
    { label: 'Housing tolerance', value: hole, tone: 'ok', hint: `Ø${D}: ${lim(D, hd)} (${um(hd[0])} / ${um(hd[1])})` },
    { label: 'Fit in housing', value: fitWord(hoMin, hoMax, 'clearance', 'interference'),
      hint: `${hoMax >= 0 ? `${um(hoMax)} max clearance` : `${um(-hoMax)} min interference`}, ${hoMin >= 0 ? `${um(hoMin)} min clearance` : `${um(-hoMin)} max interference`}` },
  ];

  // Alternatives: the neighbouring classes, so a designer can move one step.
  const shafts = ['g6', 'h6', 'h5', 'j5', 'j6', 'js5', 'js6', 'k5', 'k6', 'm5', 'm6', 'n6', 'p6'];
  const holes = ['G7', 'H7', 'H8', 'J7', 'JS7', 'K7', 'M7', 'N7', 'P7'];
  const shaftRows = shafts.map((c) => {
    const v = shaftDev(c, d);
    const hi = v[1] - bd, lo = v[0];
    return [c + (c === shaft ? ' ◀' : ''), sg(v[0]), sg(v[1]), `${sg(lo)} … ${sg(hi)}`, fitWord(lo, hi, 'interference', 'clearance')];
  });
  const holeRows = holes.map((c) => {
    const v = holeDev(c, D);
    const hi = v[1] - od, lo = v[0];
    return [c + (c === hole ? ' ◀' : ''), sg(v[0]), sg(v[1]), `${sg(lo)} … ${sg(hi)}`, fitWord(lo, hi, 'clearance', 'interference')];
  });

  if (d > 200 && ld === 'heavy') notes.push('Heavy loads on large roller bearings often go one step tighter (r6); check the maker\'s table and the bearing\'s internal clearance (C3).');
  if (['m5', 'm6', 'n6', 'p6'].includes(shaft)) notes.push('A tight shaft fit eats internal clearance: with m, n or p shafts a C3 clearance bearing is usually needed.');
  notes.push(
    'Bearing tolerances are ISO 492 normal class (P0). With P6 / P5 bearings, use one IT grade finer on shaft and housing.',
    'Assumes a solid steel shaft and a cast-iron or steel housing. Aluminium housings grow more with heat: go one step tighter, or ask the maker. Hollow shafts need more interference.',
    'Load classes: light P ≤ 0.05 C, normal 0.05-0.1 C, heavy over 0.1 C (P equivalent load, C dynamic load rating).',
  );

  return {
    values,
    warnings,
    tables: [
      { title: `Shaft classes at Ø${d} (bore ${um(bd)} / 0)`, columns: ['Class', 'Lower µm', 'Upper µm', 'Interference µm (− = clearance)', 'Fit'], rows: shaftRows },
      { title: `Housing classes at Ø${D} (OD ${um(od)} / 0)`, columns: ['Class', 'Lower µm', 'Upper µm', 'Clearance µm (− = interference)', 'Fit'], rows: holeRows },
    ],
    notes: [why, ...notes],
  };
}
