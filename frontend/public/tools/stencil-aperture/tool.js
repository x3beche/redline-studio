// Stencil aperture check, after IPC-7525B section 3.2:
//   aspect ratio = W / T                          (> 1.5 for a clean release)
//   area ratio   = (L·W) / (2·(L+W)·T)            (> 0.66) - opening area over wall area
//   circle:        area ratio = D / (4·T), aspect = D / T
// The thickest foil that still prints an aperture follows from the same two limits:
//   T(max) = min( L·W / (0.66·2·(L+W)),  W / 1.5 )
import { fmtNum } from '../kit/eng.js';

const AR_MIN = 0.66, ASPECT_MIN = 1.5;
const FOILS = [75, 80, 100, 110, 120, 127, 130, 150, 180, 200];

function geometry(shape, L, W, frac) {
  // A uniform area reduction scales both sides by sqrt(frac), keeping the pad's shape.
  const k = Math.sqrt(frac);
  if (shape === 'round') {
    const d = L * k;
    return { l: d, w: d, area: Math.PI * d * d / 4, perim: Math.PI * d };
  }
  const l = Math.max(L, W) * k, w = Math.min(L, W) * k;
  return { l, w, area: l * w, perim: 2 * (l + w) };
}

const ratios = (g, t) => ({ area: g.area / (g.perim * t), aspect: g.w / t });

export function run({ shape, padL, padW, reduce, thick, count }) {
  const warnings = [];
  const round = shape === 'round';
  if (!(padL > 0)) return { warnings: ['Give the pad length (or the diameter) in mm, e.g. 1.25.'] };
  if (!round && !(padW > 0)) return { warnings: ['Give the pad width in mm, e.g. 0.25.'] };
  if (!(thick > 0)) return { warnings: ['Give the stencil thickness in µm, e.g. 125.'] };
  let pct = reduce > 0 ? reduce : 100;
  if (!(reduce > 0)) warnings.push('Aperture area must be above 0 %; 100 % is used.');
  if (pct > 120) warnings.push(`${fmtNum(pct, 3)} % of the pad is an overprint far beyond the usual 100-110 %: paste will bridge or ball. Check the value.`);
  if (padL > 20 || (!round && padW > 20)) warnings.push('A pad above 20 mm is unusual: check that the size is in mm, not mils.');
  if (thick < 50 || thick > 250) warnings.push(`${fmtNum(thick, 3)} µm is outside the usual 75-200 µm foil range: check that it is in µm.`);
  const n = count >= 1 ? Math.round(count) : 1;

  const g = geometry(round ? 'round' : 'rect', padL, round ? padL : padW, pct / 100);
  const t = thick / 1000; // mm
  const r = ratios(g, t);
  const tMaxArea = g.area / (AR_MIN * g.perim);
  const tMaxAspect = g.w / ASPECT_MIN;
  const tMax = Math.min(tMaxArea, tMaxAspect);
  const vol = g.area * t; // mm³ = µL; 1 mm³ = 1000 nL
  const areaOk = r.area >= AR_MIN, aspectOk = r.aspect >= ASPECT_MIN;

  if (!areaOk) warnings.push(`Area ratio ${fmtNum(r.area, 3)} is below 0.66: paste will stay in the aperture. Use a foil of at most ${fmtNum(tMaxArea * 1000, 3)} µm, a step-down stencil here, or a nano-coated / electroformed foil (these release down to about 0.5).`);
  if (!aspectOk) warnings.push(`Aspect ratio ${fmtNum(r.aspect, 3)} is below 1.5: the aperture is narrower than the foil can release. Use a foil of at most ${fmtNum(tMaxAspect * 1000, 3)} µm.`);
  if (areaOk && r.area < 0.7) warnings.push('Area ratio is just above 0.66: release will vary from print to print. A laser-cut, electropolished or coated foil is advised.');

  const values = [
    { label: 'Aperture', value: round ? `Ø ${fmtNum(g.l, 3)}` : `${fmtNum(g.l, 3)} × ${fmtNum(g.w, 3)}`, unit: 'mm',
      hint: pct === 100 ? 'same as pad' : `${fmtNum(pct, 3)} % of pad area` },
    { label: 'Area ratio', value: fmtNum(r.area, 3), tone: areaOk ? (r.area < 0.7 ? 'warn' : 'ok') : 'bad', hint: 'IPC-7525: ≥ 0.66' },
    { label: 'Aspect ratio', value: fmtNum(r.aspect, 3), tone: aspectOk ? 'ok' : 'bad', hint: 'IPC-7525: ≥ 1.5' },
    { label: 'Thickest foil that passes', value: fmtNum(tMax * 1000, 3), unit: 'µm',
      hint: tMaxArea < tMaxAspect ? 'set by the area ratio' : 'set by the aspect ratio' },
    { label: 'Paste volume', value: fmtNum(vol * 1000, 3), unit: 'nL', hint: n > 1 ? `${fmtNum(vol * 1000 * n, 3)} nL for ${n}` : 'per aperture, 100 % transfer' },
    { label: 'Aperture area', value: fmtNum(g.area, 3), unit: 'mm²' },
  ];

  const foils = FOILS.map((f) => {
    const q = ratios(g, f / 1000);
    return { t: f, area: q.area, aspect: q.aspect, vol: g.area * f, ok: q.area >= AR_MIN && q.aspect >= ASPECT_MIN };
  });
  const rows = foils.map((q) => [`${q.t} µm`, fmtNum(q.area, 3), fmtNum(q.aspect, 3), fmtNum(q.vol, 3) + ' nL', q.ok ? 'yes' : 'no']);

  // Everything the page draws, as numbers (mm, µm, nL): the aperture, its
  // walls at this foil, the limits, and the standard foils.
  const stencil = {
    shape: round ? 'round' : 'rect', padL, padW: round ? padL : padW, pct,
    l: g.l, w: g.w, area: g.area, perim: g.perim, wallArea: g.perim * t, thick,
    areaRatio: r.area, aspect: r.aspect, areaOk, aspectOk, marginal: areaOk && r.area < 0.7,
    tMax: tMax * 1000, tMaxArea: tMaxArea * 1000, tMaxAspect: tMaxAspect * 1000,
    limitBy: tMaxArea < tMaxAspect ? 'area' : 'aspect',
    vol: vol * 1000, count: n, volTotal: vol * 1000 * n, arMin: AR_MIN, aspectMin: ASPECT_MIN, foils,
  };

  return {
    values,
    warnings,
    stencil,
    tables: [{ title: 'This aperture on other foils', columns: ['Foil', 'Area ratio', 'Aspect ratio', 'Paste volume', 'Prints?'], rows }],
    notes: [
      'Area ratio = opening area / aperture wall area; aspect ratio = narrowest opening / foil thickness (IPC-7525B 3.2).',
      'The limits assume a laser-cut stainless foil. Electroformed or nano-coated foils release reliably down to an area ratio of about 0.5.',
      'The volume is the aperture volume; real transfer efficiency is typically 70-90 % at area ratio 0.66 and near 100 % above 0.8.',
      'One foil serves the whole board: the smallest aperture sets the thickness, or use a step stencil.',
    ],
  };
}
