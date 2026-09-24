// Open two-pulley belt drive, exact geometry (Shigley's Mechanical
// Engineering Design, section 17-2, open belt):
//   phi   = asin((D - d) / 2C)                 half the belt's angle to the centre line
//   L     = 2 C cos(phi) + pi (D + d) / 2 + phi (D - d)
//   wrap  = pi - 2 phi (small pulley), pi + 2 phi (large)
// (the familiar approximation L = 2C + pi(D+d)/2 + (D-d)^2/4C is shown for comparison).
// Centre distance from a belt length: L(C) is monotonic, solved by bisection.
// Timing belts: pitch diameter = z p / pi, belt teeth = L / p; pulley outside
// diameter = pitch diameter - 2 * pitch-line differential (makers' tables).
import { fmtNum } from '../kit/eng.js';

// pitch mm, pitch-line differential mm (Gates / Optibelt tables).
const PROFILES = {
  gt2: { name: 'GT2 2 mm', p: 2, pld: 0.254 },
  gt3: { name: 'GT2 3 mm (GT3)', p: 3, pld: 0.381 },
  htd3: { name: 'HTD 3M', p: 3, pld: 0.381 },
  htd5: { name: 'HTD 5M', p: 5, pld: 0.5715 },
  htd8: { name: 'HTD 8M', p: 8, pld: 0.686 },
  mxl: { name: 'MXL (0.080 in)', p: 2.032, pld: 0.254 },
  xl: { name: 'XL (0.200 in)', p: 5.08, pld: 0.254 },
  l: { name: 'L (0.375 in)', p: 9.525, pld: 0.381 },
};

const lengthOf = (C, d, D) => {
  const phi = Math.asin((D - d) / (2 * C));
  return 2 * C * Math.cos(phi) + (Math.PI * (D + d)) / 2 + phi * (D - d);
};

/** Centre distance for belt length L, or null when the belt is too short. */
function centreFor(L, d, D) {
  let lo = (D - d) / 2 + 1e-9; // the smallest C with real geometry
  if (lengthOf(lo, d, D) > L) return null;
  let hi = Math.max(L, 1);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (lengthOf(mid, d, D) < L) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function run({ kind, d1, d2, z1, z2, mode, C, L, teeth, rpm }) {
  const warnings = [];
  const prof = PROFILES[kind];
  let a, b; // driver and driven pitch diameters
  if (prof) {
    if (!(z1 >= 1 && z2 >= 1)) return { warnings: ['Give the tooth counts of both pulleys.'] };
    if (!Number.isInteger(z1) || !Number.isInteger(z2)) warnings.push('Pulley tooth counts should be whole numbers.');
    a = (z1 * prof.p) / Math.PI; b = (z2 * prof.p) / Math.PI;
  } else {
    if (!(d1 > 0 && d2 > 0)) return { warnings: ['Give both pulley diameters in mm (pitch diameters for a V-belt).'] };
    a = d1; b = d2;
  }
  const small = Math.min(a, b), large = Math.max(a, b);

  let c;
  if (mode === 'centre') {
    let Lb = L;
    if (prof) {
      if (!(teeth > 0)) return { warnings: ['Give the belt length as a number of teeth.'] };
      Lb = teeth * prof.p;
    }
    if (!(Lb > 0)) return { warnings: ['Give the belt length in mm (pitch length).'] };
    c = centreFor(Lb, small, large);
    if (c == null) return { warnings: [`A ${fmtNum(Lb, 5)} mm belt is too short to go round these pulleys: it needs more than ${fmtNum(lengthOf((large - small) / 2 + 1e-9, small, large), 5)} mm.`] };
  } else {
    if (!(C > 0)) return { warnings: ['Give the centre distance in mm.'] };
    c = C;
  }
  if (c <= (large - small) / 2) return { warnings: ['The centre distance is less than the difference of the radii: the geometry is impossible. Increase it.'] };
  if (c < (a + b) / 2) warnings.push(`At ${fmtNum(c, 4)} mm the pulleys overlap (they need at least ${fmtNum((a + b) / 2, 4)} mm between centres plus flange room).`);

  const phi = Math.asin((large - small) / (2 * c));
  const len = lengthOf(c, small, large);
  const approx = 2 * c + (Math.PI * (large + small)) / 2 + (large - small) ** 2 / (4 * c);
  const wrap = (Math.PI - 2 * phi) * (180 / Math.PI);
  const ratio = b / a;

  const values = [];
  if (mode === 'centre') values.push({ label: 'Centre distance', value: fmtNum(c, 5), unit: 'mm', tone: 'ok' });
  values.push({ label: 'Belt pitch length', value: fmtNum(len, 5), unit: 'mm', tone: mode === 'centre' ? undefined : 'ok', hint: `approx. formula ${fmtNum(approx, 5)} mm` });
  values.push(
    { label: 'Speed ratio', value: `${fmtNum(ratio, 4)} : 1`, hint: ratio >= 1 ? 'driven turns slower' : 'driven turns faster' },
    { label: 'Wrap on small pulley', value: fmtNum(wrap, 4), unit: '°', tone: wrap >= 120 ? 'ok' : 'warn' },
  );
  if (wrap < 120) warnings.push(`Only ${fmtNum(wrap, 3)}° of wrap on the small pulley: the belt may slip (friction belts) or jump teeth. Increase the centre distance, reduce the ratio or add an idler.`);

  const tables = [];
  if (prof) {
    const zs = Math.min(z1, z2);
    const mesh = (zs * wrap) / 360;
    const bt = len / prof.p;
    values.push(
      { label: 'Belt teeth (exact)', value: fmtNum(bt, 5), hint: `${prof.name}, pitch ${prof.p} mm` },
      { label: 'Teeth in mesh (small)', value: fmtNum(mesh, 3), tone: mesh >= 6 ? 'ok' : 'warn', hint: '6 or more' },
      { label: 'Pulley pitch Ø', value: `${fmtNum(a, 5)} / ${fmtNum(b, 5)}`, unit: 'mm', hint: 'driver / driven' },
      { label: 'Pulley outside Ø', value: `${fmtNum(a - 2 * prof.pld, 5)} / ${fmtNum(b - 2 * prof.pld, 5)}`, unit: 'mm', hint: 'driver / driven' },
    );
    if (mesh < 6) warnings.push(`Only ${fmtNum(mesh, 2)} teeth in mesh on the small pulley: the belt can jump under load. Use a larger pulley or more wrap.`);
    if (mode !== 'centre' && Math.abs(bt - Math.round(bt)) > 1e-6) {
      const opts = [Math.floor(bt) - 1, Math.floor(bt), Math.ceil(bt), Math.ceil(bt) + 1].filter((n) => n > 0);
      tables.push({
        title: 'Closed belts near this length',
        columns: ['Belt teeth', 'Pitch length', 'Centre distance', 'Change'],
        rows: opts.map((n) => {
          const cc = centreFor(n * prof.p, small, large);
          return [String(n), `${fmtNum(n * prof.p, 5)} mm`, cc == null ? 'too short' : `${fmtNum(cc, 5)} mm`, cc == null ? '–' : `${cc >= c ? '+' : ''}${fmtNum(cc - c, 3)} mm`];
        }),
      });
      warnings.push(`A closed ${prof.name} belt has a whole number of teeth: ${fmtNum(bt, 5)} is not. Pick a belt from the table and set the centre distance it gives.`);
    }
  }
  if (rpm > 0) {
    values.push(
      { label: 'Driven speed', value: fmtNum(rpm / ratio, 4), unit: 'rpm' },
      { label: 'Belt speed', value: fmtNum((Math.PI * a * rpm) / 60000, 3), unit: 'm/s' },
    );
  }

  return {
    values,
    warnings,
    tables,
    notes: [
      'Open (uncrossed) belt, two pulleys. Lengths are pitch lengths: for V-belts use pitch (datum) diameters, for flat belts the pulley diameter plus the belt thickness.',
      'Leave adjustment for tensioning and fitting: about ±2 % of the centre distance for V-belts, a tensioner or slotted mount for timing belts.',
      prof ? 'Pitch-line differential and outside diameters are the belt makers\' nominal values; check the pulley supplier.' : 'Speed ratio neglects belt slip (1-2 % for flat and V-belts).',
    ],
  };
}
