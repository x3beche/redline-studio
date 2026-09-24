// Design values of a part checked against the usual limits of a 3D printing process.
// Limits (typical, not machine-specific):
//   FDM   Hubs "Key design guidelines for 3D printing": walls 0.8 mm (scaled here as 2 x nozzle),
//         details 0.6 mm (1.5 x nozzle), 45° overhang, 10 mm bridge, Ø2 mm hole, Ø3 mm pin,
//         0.5 mm clearance, ±0.5 % (at least ±0.5 mm).
//   SLA   Formlabs "Design guide for SLA": unsupported wall 0.6 mm, overhang >= 19° from horizontal,
//         21 mm bridge, Ø0.5 mm hole, 0.4 mm engraved detail, 0.5 mm clearance, Ø3.5 mm drain hole;
//         tolerance ±0.5 % (at least ±0.15 mm, Hubs).
//   SLS   Hubs: wall 0.7 mm, Ø1.5 mm hole, Ø0.8 mm pin, 1 mm detail, 0.3 mm clearance, Ø5 mm escape
//         holes, ±0.3 % (at least ±0.3 mm); no supports, so no overhang or bridge limit.
//   MJF   HP Multi Jet Fusion design guidelines (typical): wall 0.5 mm, Ø1 mm hole and pin,
//         0.5 mm detail, 0.5 mm clearance, Ø5 mm escape holes, ±0.3 % (at least ±0.2 mm).
import { fmtNum } from '../kit/eng.js';

const PROC = {
  fdm: (n) => ({ name: `FDM, ${fmtNum(n)} mm nozzle`, wall: 2 * n, overhang: 45, bridge: 10, hole: 2, pin: 3, detail: 1.5 * n, clearance: 0.5, escape: null, tol: [0.005, 0.5] }),
  sla: () => ({ name: 'SLA / resin', wall: 0.6, overhang: 71, bridge: 21, hole: 0.5, pin: 0.5, detail: 0.4, clearance: 0.5, escape: 3.5, tol: [0.005, 0.15] }),
  sls: () => ({ name: 'SLS nylon', wall: 0.7, overhang: null, bridge: null, hole: 1.5, pin: 0.8, detail: 1.0, clearance: 0.3, escape: 5, tol: [0.003, 0.3] }),
  mjf: () => ({ name: 'HP Multi Jet Fusion', wall: 0.5, overhang: null, bridge: null, hole: 1.0, pin: 1.0, detail: 0.5, clearance: 0.5, escape: 5, tol: [0.003, 0.2] }),
};
// key, label, unit, limit is a minimum ('min') or a maximum ('max'), why it matters
const CHECKS = [
  ['wall', 'Thinnest wall', 'mm', 'min', 'thinner walls do not print, warp or break when cleaned'],
  ['overhang', 'Steepest overhang (from vertical)', '°', 'max', 'beyond it the surface sags or needs supports'],
  ['bridge', 'Longest unsupported bridge', 'mm', 'max', 'longer spans sag and need supports'],
  ['hole', 'Smallest hole Ø', 'mm', 'min', 'smaller holes close up; drill them after printing'],
  ['pin', 'Thinnest pin / post Ø', 'mm', 'min', 'thinner pins break or do not form'],
  ['detail', 'Smallest detail (text, emboss, engrave)', 'mm', 'min', 'finer detail is lost'],
  ['clearance', 'Clearance between mating / moving parts', 'mm', 'min', 'less and the parts fuse or bind'],
  ['escape', 'Drain / escape hole Ø (hollow parts)', 'mm', 'min', 'resin or powder stays trapped inside'],
];

const r2 = (v) => Math.round(v * 100) / 100;

export function run(input) {
  const { process, nozzle, size } = input;
  const warnings = [];
  let n = nozzle;
  if (process === 'fdm' && !(n > 0)) { warnings.push('Give the nozzle diameter in mm, e.g. 0.4; 0.4 is used.'); n = 0.4; }
  if (process === 'fdm' && (n < 0.2 || n > 1.2)) warnings.push(`A ${fmtNum(n)} mm nozzle is outside 0.2-1.2 mm, where the nozzle-scaled limits hold; check walls and details on a test print.`);
  const p = (PROC[process] || PROC.fdm)(n || 0.4);
  const rows = [];
  let pass = 0, marginal = 0, fail = 0, checked = 0;
  const open = [];
  for (const [key, label, unit, sense, why] of CHECKS) {
    const lim = p[key];
    const v = input[key];
    if (v != null && (v < 0 || (key === 'overhang' && v > 90))) { warnings.push(`${label}: ${fmtNum(v)} ${unit} is not a valid value${key === 'overhang' ? ' (0° = vertical wall, 90° = flat ceiling)' : ''}.`); continue; }
    if (lim == null) {
      if (v != null && key !== 'escape') rows.push([label, `${fmtNum(v)} ${unit}`, 'no limit', 'ok, self-supporting']);
      if (key === 'escape' && v != null) rows.push([label, `${fmtNum(v)} ${unit}`, 'not needed', 'ok, FDM parts are not hollowed']);
      continue;
    }
    if (v == null) { rows.push([label, '–', `${sense === 'min' ? '≥' : '≤'} ${fmtNum(r2(lim))} ${unit}`, 'not checked']); continue; }
    checked++;
    const ok = sense === 'min' ? v >= lim - 1e-9 : v <= lim + 1e-9;
    const near = ok && (sense === 'min' ? v < lim * 1.25 : v > lim * 0.8);
    const verdict = !ok ? 'fails' : near ? 'at the limit' : 'passes';
    if (!ok) { fail++; open.push(`${label}: ${fmtNum(v)} ${unit}, needs ${sense === 'min' ? 'at least' : 'at most'} ${fmtNum(r2(lim))} ${unit}: ${why}.`); }
    else if (near) marginal++; else pass++;
    rows.push([label, `${fmtNum(v)} ${unit}`, `${sense === 'min' ? '≥' : '≤'} ${fmtNum(r2(lim))} ${unit}`, verdict]);
  }
  warnings.push(...open);
  const values = [
    { label: 'Process', value: p.name.split(',')[0], hint: p.name.split(',')[1]?.trim() || null },
    { label: 'Checks passed', value: `${pass + marginal} of ${checked}`, tone: fail ? 'bad' : marginal ? 'warn' : 'ok', hint: marginal ? `${marginal} at the limit` : null },
  ];
  if (size != null) {
    if (!(size > 0)) warnings.push('Give the largest dimension in mm to get the expected tolerance.');
    else {
      const tol = Math.max(p.tol[0] * size, p.tol[1]);
      values.push({ label: 'Expected tolerance', value: `± ${fmtNum(r2(tol))} mm`, hint: `on ${fmtNum(size)} mm: ±${fmtNum(p.tol[0] * 100)} %, at least ±${fmtNum(p.tol[1])} mm` });
    }
  }
  const lim = (k, u) => (p[k] == null ? 'none' : `${fmtNum(r2(p[k]))} ${u}`);
  return {
    values,
    tables: [
      { title: `Your part against ${p.name}`, columns: ['Check', 'Your value', 'Guideline', 'Result'], rows },
      { title: 'All processes (typical limits)', columns: ['Process', 'Wall', 'Overhang', 'Bridge', 'Hole', 'Pin', 'Detail', 'Clearance', 'Escape hole'],
        rows: Object.keys(PROC).map((k) => { const q = PROC[k](0.4); return [q.name, `${fmtNum(r2(q.wall))} mm`, q.overhang == null ? 'none' : `${q.overhang}°`, q.bridge == null ? 'none' : `${q.bridge} mm`, `Ø${q.hole}`, `Ø${q.pin}`, `${fmtNum(r2(q.detail))} mm`, `${q.clearance} mm`, q.escape == null ? '–' : `Ø${q.escape}`]; }) },
    ],
    warnings,
    notes: [
      `Limits: wall ${lim('wall', 'mm')}, overhang ${p.overhang == null ? 'none' : p.overhang + '° from vertical'}, bridge ${lim('bridge', 'mm')}. Typical published values; a tuned machine does better, a worn one worse.`,
      'Overhang is measured from the vertical: 0° is a vertical wall, 90° a flat ceiling.',
      'Leave a value empty to skip that check.',
    ],
  };
}
