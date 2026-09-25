// ISO 286 limits and fits: hole and shaft limits, and the clearance or interference.
// Data and rules from ISO 286-1:2010:
//   Table 1   standard tolerance grades IT3..IT12 (µm) for nominal sizes up to 500 mm.
//   Table 2/3 fundamental deviations of shafts: es for c..h, ei for k..s (µm).
//   Holes     A..H: EI = -es of the same shaft letter (general rule).
//             K, M, N up to IT8 and P..ZC up to IT7: ES = -ei + Δ, Δ = IT(n) - IT(n-1) (special rule).
//             K above IT8: ES = 0; N above IT8: ES = 0; M above IT8: ES = -ei; P..S above IT7: ES = -ei.
//             Sizes up to 3 mm: Δ = 0 (and N: ES = -4 µm for every grade).
//   JS / js   ±IT/2, an odd IT in whole µm rounded down to even first (ISO 286-1, 5.2.3 note).
// Clearance: max = ES - ei, min = EI - es (negative = interference).

const B13 = [3, 6, 10, 18, 30, 50, 80, 120, 180, 250, 315, 400, 500];
const B23 = [3, 6, 10, 18, 30, 40, 50, 65, 80, 100, 120, 140, 160, 180, 200, 225, 250, 280, 315, 355, 400, 450, 500];
const IT = {
  3: [2, 2.5, 2.5, 3, 4, 4, 5, 6, 8, 10, 12, 13, 15],
  4: [3, 4, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20],
  5: [4, 5, 6, 8, 9, 11, 13, 15, 18, 20, 23, 25, 27],
  6: [6, 8, 9, 11, 13, 16, 19, 22, 25, 29, 32, 36, 40],
  7: [10, 12, 15, 18, 21, 25, 30, 35, 40, 46, 52, 57, 63],
  8: [14, 18, 22, 27, 33, 39, 46, 54, 63, 72, 81, 89, 97],
  9: [25, 30, 36, 43, 52, 62, 74, 87, 100, 115, 130, 140, 155],
  10: [40, 48, 58, 70, 84, 100, 120, 140, 160, 185, 210, 230, 250],
  11: [60, 75, 90, 110, 130, 160, 190, 220, 250, 290, 320, 360, 400],
  12: [100, 120, 150, 180, 210, 250, 300, 350, 400, 460, 520, 570, 630],
};
// Shaft fundamental deviations (µm). Upper (es) for c..h, lower (ei) for k..s.
const UPPER13 = {
  d: [-20, -30, -40, -50, -65, -80, -100, -120, -145, -170, -190, -210, -230],
  e: [-14, -20, -25, -32, -40, -50, -60, -72, -85, -100, -110, -125, -135],
  f: [-6, -10, -13, -16, -20, -25, -30, -36, -43, -50, -56, -62, -68],
  g: [-2, -4, -5, -6, -7, -9, -10, -12, -14, -15, -17, -18, -20],
  h: Array(13).fill(0),
};
const UPPER23 = { c: [-60, -70, -80, -95, -110, -120, -130, -140, -150, -170, -180, -200, -210, -230, -240, -260, -280, -300, -330, -360, -400, -440, -480] };
const LOWER13 = {
  k: [0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5], // IT4..IT7 only; 0 otherwise
  m: [2, 4, 6, 7, 8, 9, 11, 13, 15, 17, 20, 21, 23],
  n: [4, 8, 10, 12, 15, 17, 20, 23, 27, 31, 34, 37, 40],
  p: [6, 12, 15, 18, 22, 26, 32, 37, 43, 50, 56, 62, 68],
};
const LOWER23 = {
  r: [10, 15, 19, 23, 28, 34, 34, 41, 43, 51, 54, 63, 65, 68, 77, 80, 84, 94, 98, 108, 114, 126, 132],
  s: [14, 19, 23, 28, 35, 43, 43, 53, 59, 71, 79, 92, 100, 108, 122, 130, 140, 158, 170, 190, 208, 232, 252],
};
export const LETTERS = ['c', 'd', 'e', 'f', 'g', 'h', 'js', 'k', 'm', 'n', 'p', 'r', 's'];
const COMMON = [
  ['H11/c11', 'Loose running: wide play, dirty or hot'], ['H9/d9', 'Free running: large temperature swings'],
  ['H8/f7', 'Close running: accurate running on a shaft'], ['H7/g6', 'Sliding: turns and slides, locates well'],
  ['H7/h6', 'Locational clearance: assembles freely, stationary'], ['H7/k6', 'Locational transition: accurate, little play'],
  ['H7/n6', 'Locational transition: tighter, light press'], ['H7/p6', 'Locational interference: press, no torque'],
  ['H7/s6', 'Medium drive: shrink or press, carries torque'],
];

const idx = (bounds, x) => bounds.findIndex((b) => x <= b);
const itOf = (n, x) => IT[n][idx(B13, x)];
const half = (t) => (Number.isInteger(t) && t % 2 ? (t - 1) / 2 : t / 2);

/** Shaft deviations {es, ei} in µm, or {error}. */
function shaft(letter, n, x) {
  const t = itOf(n, x);
  if (letter === 'js') return { es: half(t), ei: -half(t) };
  if (UPPER13[letter]) { const es = UPPER13[letter][idx(B13, x)]; return { es, ei: es - t }; }
  if (UPPER23[letter]) { const es = UPPER23[letter][idx(B23, x)]; return { es, ei: es - t }; }
  let ei;
  if (letter === 'k') ei = n >= 4 && n <= 7 ? LOWER13.k[idx(B13, x)] : 0;
  else if (LOWER13[letter]) ei = LOWER13[letter][idx(B13, x)];
  else if (LOWER23[letter]) ei = LOWER23[letter][idx(B23, x)];
  else return { error: `Shaft letter "${letter}" is not in this tool (${LETTERS.join(', ')}).` };
  return { es: ei + t, ei };
}

/** Hole deviations {ES, EI} in µm, from the shaft letter by the ISO 286-1 rules. */
function hole(L, n, x) {
  const l = L.toLowerCase();
  const t = itOf(n, x);
  if (l === 'js') return { ES: half(t), EI: -half(t) };
  if (UPPER13[l] || UPPER23[l]) { const EI = -shaft(l, n, x).es; return { ES: EI + t, EI }; }
  if (!LOWER13[l] && !LOWER23[l]) return { error: `Hole letter "${L}" is not in this tool (${LETTERS.map((a) => a.toUpperCase()).join(', ')}).` };
  const delta = x <= 3 ? 0 : t - itOf(n - 1, x);
  const eiShaft = l === 'k' ? LOWER13.k[idx(B13, x)] : shaft(l, 7, x).ei; // the letter's ei, independent of grade (k: the IT4-7 column)
  let ES;
  if (l === 'k') ES = n <= 8 ? -eiShaft + delta : 0;
  else if (l === 'm') ES = n <= 8 ? -eiShaft + delta : -eiShaft;
  else if (l === 'n') ES = x <= 3 ? -4 : n <= 8 ? -eiShaft + delta : 0;
  else ES = n <= 7 ? -eiShaft + delta : -eiShaft;
  return { ES, EI: ES - t };
}

function parseFit(text) {
  const m = /^\s*([A-Za-z]{1,2})\s*(\d{1,2})\s*[/ ]\s*([A-Za-z]{1,2})\s*(\d{1,2})\s*$/.exec(String(text || ''));
  if (!m) return null;
  return { hl: m[1].toUpperCase(), hn: Number(m[2]), sl: m[3].toLowerCase(), sn: Number(m[4]) };
}

const fmtDev = (v) => (v > 0 ? `+${v}` : `${v}`);
// Limits in mm to the µm (a half µm from JS/js keeps its 4th decimal).
const mm4 = (v) => { const t = v.toFixed(4); return t.endsWith('0') ? t.slice(0, -1) : t; };
const kind = (max, min) => (min >= 0 ? 'clearance' : max <= 0 ? 'interference' : 'transition');

export function evalFit(size, f) {
  if (f.hn < 4 || f.hn > 12 || f.sn < 4 || f.sn > 12) return { error: 'Grades 4 to 12 are covered (IT4-IT12).' };
  const h = hole(f.hl, f.hn, size); if (h.error) return h;
  const s = shaft(f.sl, f.sn, size); if (s.error) return s;
  const max = h.ES - s.ei, min = h.EI - s.es;
  return { h, s, max, min, type: kind(max, min) };
}

export function run({ size, fit }) {
  if (size == null) return { warnings: ['Give the nominal size in mm, e.g. 25.'] };
  if (!(size > 0) || size > 500) return { warnings: [`${size} mm is outside ISO 286's 0-500 mm range covered here. Give a size above 0 and up to 500 mm.`] };
  const f = parseFit(fit);
  if (!f) return { warnings: [`Could not read the fit "${fit}". Write it as hole/shaft, e.g. H7/g6 or H7/p6.`] };
  const r = evalFit(size, f);
  if (r.error) return { warnings: [r.error] };
  const { h, s, max, min, type } = r;
  const warnings = [];
  if (f.hl !== 'H' && f.sl !== 'h') warnings.push('Neither part is H or h: a legal fit, but hole-basis (H) or shaft-basis (h) fits are the standard choice and cheaper to make and gauge.');
  if (f.sl === 'c' && f.sn < 8) warnings.push('c shafts are normally used in grades 8-11.');
  const tone = type === 'clearance' ? 'ok' : type === 'interference' ? 'bad' : 'warn';
  const values = [
    { label: 'Fit', value: `Ø${size} ${f.hl}${f.hn}/${f.sl}${f.sn}`, hint: `${type} fit`, tone },
    { label: `Hole ${f.hl}${f.hn}`, value: `${fmtDev(h.ES)} / ${fmtDev(h.EI)}`, unit: 'µm', hint: `${mm4(size + h.EI / 1000)} to ${mm4(size + h.ES / 1000)} mm` },
    { label: `Shaft ${f.sl}${f.sn}`, value: `${fmtDev(s.es)} / ${fmtDev(s.ei)}`, unit: 'µm', hint: `${mm4(size + s.ei / 1000)} to ${mm4(size + s.es / 1000)} mm` },
    { label: max >= 0 ? 'Maximum clearance' : 'Minimum interference', value: Math.abs(max), unit: 'µm', hint: 'largest hole, smallest shaft' },
    { label: min >= 0 ? 'Minimum clearance' : 'Maximum interference', value: Math.abs(min), unit: 'µm', hint: 'smallest hole, largest shaft', tone },
    { label: 'Mean', value: fmtDev((max + min) / 2), unit: 'µm', hint: '+ clearance, − interference' },
  ];
  const rows = COMMON.map(([name, what]) => {
    const c = evalFit(size, parseFit(name));
    return [name, what, `${fmtDev(c.h.ES)} / ${fmtDev(c.h.EI)}`, `${fmtDev(c.s.es)} / ${fmtDev(c.s.ei)}`, `${fmtDev(c.min)} … ${fmtDev(c.max)}`, c.type];
  });
  // For the page's drawing only (agentOmit): every letter at the chosen grades,
  // every grade of the chosen letters, and the preferred fits' zones.
  const zoneH = (L, g) => { const z = hole(L, g, size); return z.error ? null : [z.EI, z.ES]; };
  const zoneS = (l, g) => { const z = shaft(l, g, size); return z.error ? null : [z.ei, z.es]; };
  const GR = [4, 5, 6, 7, 8, 9, 10, 11, 12];
  const chart = {
    size, bounds: B13, bounds23: B23, step: [idx(B13, size) > 0 ? B13[idx(B13, size) - 1] : 0, B13[idx(B13, size)]],
    hole: { letter: f.hl, grade: f.hn, zone: [h.EI, h.ES], limits: [mm4(size + h.EI / 1000), mm4(size + h.ES / 1000)] },
    shaft: { letter: f.sl, grade: f.sn, zone: [s.ei, s.es], limits: [mm4(size + s.ei / 1000), mm4(size + s.es / 1000)] },
    min, max, mean: (max + min) / 2, type,
    it: GR.map((g) => ({ grade: g, it: itOf(g, size) })),
    holeLetters: LETTERS.map((l) => ({ letter: l.toUpperCase(), zone: zoneH(l.toUpperCase(), f.hn) })),
    shaftLetters: LETTERS.map((l) => ({ letter: l, zone: zoneS(l, f.sn) })),
    holeGrades: GR.map((g) => ({ grade: g, zone: zoneH(f.hl, g) })),
    shaftGrades: GR.map((g) => ({ grade: g, zone: zoneS(f.sl, g) })),
    preferred: COMMON.map(([name, use]) => { const c = evalFit(size, parseFit(name)); return { name, use, hole: [c.h.EI, c.h.ES], shaft: [c.s.ei, c.s.es], min: c.min, max: c.max, type: c.type }; }),
  };
  return {
    values,
    chart,
    drawing: { size, hole: [h.EI, h.ES], shaft: [s.ei, s.es], holeName: `${f.hl}${f.hn}`, shaftName: `${f.sl}${f.sn}`, type },
    tables: [{ title: `Preferred hole-basis fits at Ø${size} mm (deviations and clearance in µm)`, columns: ['Fit', 'Use', 'Hole', 'Shaft', 'Clearance min … max', 'Type'], rows }],
    warnings,
    notes: [
      'Deviations from ISO 286-1 tables; a handful of footnoted exceptions in ISO 286-2 (grades not used at some sizes) are not flagged.',
      'Clearance is + and interference is −. Measured at 20 °C: parts of different materials change the fit with temperature.',
    ],
  };
}
