// Annular ring left around a drilled hole, nominal and worst case.
//
//   Nominal ring      (pad - drill) / 2
//   Worst case        (pad - (drill + hole tolerance)) / 2 - drill-to-copper registration
//   Breakout angle    hole of radius r offset by e in a pad of radius R: the hole
//                     edge leaves the pad where e² + r² + 2 e r cosθ > R²,
//                     an arc of 2·acos((R² - e² - r²) / (2 e r))
//   Minimum ring      IPC-6012 annular ring requirements: class 3 plated 0.050 mm
//                     external, 0.025 mm internal; class 2 allows 90° breakout,
//                     class 1 180°; unsupported (non-plated) holes 0.15 mm.
//   Design land       IPC-2221B 9.1.1: land = a + 2b + c; a max hole, b min ring,
//                     c fabrication allowance (table 9-1: level A 0.4, B 0.25, C 0.2 mm)
import { fmtNum } from '../kit/eng.js';

const ALLOW = [['A (general)', 0.4], ['B (moderate)', 0.25], ['C (high)', 0.2]];

function breakout(R, r, e) {
  if (e <= 0) return r > R ? 360 : 0;
  const c = (R * R - e * e - r * r) / (2 * e * r);
  if (c >= 1) return 0;
  if (c <= -1) return 360;
  return (2 * Math.acos(c) * 180) / Math.PI;
}

const mm = (v) => `${fmtNum(v, 3)} mm`;
const mil = (v) => `${fmtNum(v / 0.0254, 3)} mil`;

export function run({ plated, given, hole, pad, allowance, tol, reg, layer, klass, fabmin }) {
  const warnings = [];
  if (!(hole > 0)) return { warnings: ['Give the hole diameter in mm, e.g. 0.3.'] };
  if (!(pad > 0)) return { warnings: ['Give the pad (land) diameter in mm, e.g. 0.6.'] };
  const pth = plated !== 'npth';
  const inner = layer === 'inner';
  if (!pth && inner) warnings.push('A non-plated hole has no inner-layer land to check; the outer-layer rule is used.');
  const allow = pth && given === 'finished' ? (allowance >= 0 ? allowance : 0.1) : 0;
  const drill = hole + allow;
  const t = tol >= 0 ? tol : 0;
  const e = reg >= 0 ? reg : 0;
  if (!(reg >= 0)) warnings.push('No registration tolerance given: 0 used, which is optimistic (0.05-0.1 mm is typical).');
  const cls = ['1', '2', '3'].includes(String(klass)) ? Number(klass) : 2;
  const bmin = !pth ? 0.15 : inner ? 0.025 : 0.05; // IPC min ring, class 3 (and design target)
  const allowBreak = cls === 1 ? 180 : cls === 2 ? 90 : 0;

  const nominal = (pad - drill) / 2;
  const dmax = drill + t;
  const worst = Math.round(((pad - dmax) / 2 - e) * 1e6) / 1e6; // µm resolution, no float dust
  const angle = breakout(pad / 2, dmax / 2, e);
  if (pad <= drill) return { warnings: [`The ${mm(pad)} pad is not larger than the ${mm(drill)} drill: there is no ring at all. Make the pad at least ${mm(drill + 2 * (bmin + e) + t)}.`] };

  let verdict, tone;
  if (!pth || cls === 3) {
    const ok = worst >= bmin - 1e-9;
    verdict = ok ? `Pass: worst case ${mm(worst)} ≥ ${mm(bmin)}` : `Fail: worst case ${mm(worst)} < ${mm(bmin)}`;
    tone = ok ? 'ok' : 'bad';
  } else if (worst >= bmin) {
    verdict = `Pass: ring stays ${mm(worst)} at worst`; tone = 'ok';
  } else if (worst >= 0) {
    verdict = `Pass for class ${cls}: ${mm(worst)} ring at worst, under the ${mm(bmin)} class 3 asks`; tone = 'warn';
  } else if (angle <= allowBreak) {
    verdict = `Marginal: ${fmtNum(angle, 3)}° breakout at worst, class ${cls} allows ${allowBreak}°`; tone = 'warn';
  } else {
    verdict = `Fail: ${fmtNum(angle, 3)}° breakout at worst, class ${cls} allows ${allowBreak}°`; tone = 'bad';
  }
  const padNeeded = dmax + 2 * ((!pth || cls === 3) ? bmin : 0) + 2 * e;
  if (tone === 'bad') warnings.push(`At the fab's tolerances the drill can ${worst < 0 ? 'break out of' : 'come too close to the edge of'} the pad. Make the pad at least ${mm(padNeeded)} (or a teardrop at the trace entry), or use a smaller drill.`);
  if (tone === 'warn' && worst >= 0) warnings.push(`At worst the drill just touches the pad edge (${mm(worst)} ring): fine for class ${cls}, but a ${mm(dmax + 2 * (bmin + e))} pad keeps the ${mm(bmin)} ring class 3 asks.`);
  if (tone === 'warn' && worst < 0) warnings.push(`Breakout is acceptable for class ${cls} only where it is not at the trace connection: add a teardrop, or grow the pad to ${mm(dmax + 2 * e)}.`);
  if (fabmin > 0 && nominal < fabmin - 1e-9) warnings.push(`Nominal ring ${mm(nominal)} is below the fab's stated minimum of ${mm(fabmin)}: they may reject or enlarge it. Pad needs to be ${mm(drill + 2 * fabmin)}.`);
  if (pth && drill < 0.15) warnings.push(`${mm(drill)} is a laser/microvia drill; mechanical drills usually stop at 0.15-0.2 mm.`);
  if (pth && given !== 'finished' && hole >= 0.6) warnings.push('For component holes, check whether your fab reads the size as drill or finished hole: plating takes ~0.05-0.1 mm off the diameter.');

  const values = [
    { label: 'Verdict', value: tone === 'ok' ? 'Pass' : tone === 'warn' ? (worst >= 0 ? 'Pass, tangent' : 'Marginal') : 'Fail', tone, hint: verdict },
    { label: 'Drill diameter', value: mm(drill), hint: allow ? `finished ${mm(hole)} + ${mm(allow)} plating allowance` : 'as given' },
    { label: 'Nominal annular ring', value: mm(nominal), hint: mil(nominal) },
    { label: 'Worst-case ring', value: mm(worst), tone: worst >= bmin ? 'ok' : worst >= 0 ? 'warn' : 'bad', hint: `hole +${mm(t)}, offset ${mm(e)}` },
    { label: 'Worst-case breakout', value: `${fmtNum(angle, 3)}°`, tone: angle === 0 ? 'ok' : angle <= allowBreak ? 'warn' : 'bad', hint: `class ${cls} allows ${allowBreak}°` },
    { label: `Pad for class ${cls}, these tolerances`, value: mm(padNeeded), hint: mil(padNeeded) },
  ];

  const classRows = [1, 2, 3].map((c) => {
    const ab = c === 1 ? 180 : c === 2 ? 90 : 0;
    const need = (!pth || c === 3) ? `ring ≥ ${mm(bmin)}` : `breakout ≤ ${ab}°`;
    const ok = (!pth || c === 3) ? worst >= bmin - 1e-9 : angle <= ab;
    return [`Class ${c}`, need, ok ? 'pass' : 'fail'];
  });
  const landRows = ALLOW.map(([lvl, c]) => [lvl, mm(c), mm(dmax + 2 * bmin + c), fmtNum((dmax + 2 * bmin + c) / 0.0254, 3)]);
  return {
    values,
    warnings,
    tables: [
      { title: `IPC-6012 acceptance at worst case (${pth ? (inner ? 'plated, inner layer' : 'plated, outer layer') : 'non-plated'})`, columns: ['Class', 'Requirement', 'Result'], rows: classRows },
      { title: 'IPC-2221 design land size: max hole + 2 × min ring + fabrication allowance', columns: ['Producibility level', 'Allowance', 'Land (mm)', 'Land (mil)'], rows: landRows },
    ],
    notes: [
      'Ring is measured from the drilled hole wall (conservative for outer layers, where IPC measures from the plating inside the hole).',
      'Registration is the drill\'s position error relative to the copper; for inner layers add layer-to-layer misregistration to it.',
      'Etching also shrinks the pad slightly (about 0.01-0.025 mm per side); not included.',
      'Typical budget-fab values: registration ±0.075 mm, hole tolerance +0.05/-0.05 mm, stated min via ring 0.1-0.15 mm.',
    ],
  };
}
