// External spur / helical gear pair, involute, standard full-depth rack
// (addendum 1.0 m, dedendum 1.25 m), ISO 21771 / ISO 53 geometry, formulas
// as in KHK "Gear Technical Reference" section 4 (profile-shifted gears):
//   transverse module      mt = mn / cos b,   tan at = tan an / cos b
//   pitch diameter         d = z mt
//   base diameter          db = d cos at
//   working pressure angle inv awt = 2 tan an (x1 + x2) / (z1 + z2) + inv at
//   centre distance        a = (d1 + d2) / 2,  aw = a cos at / cos awt
//   centre-distance mod.   y = (z1 + z2) / (2 cos b) * (cos at / cos awt - 1)
//   tip diameter           da1 = d1 + 2 mn (1 + y - x2)   (keeps 0.25 m clearance)
//   whole depth            h = mn (2.25 + y - (x1 + x2)),  df = da - 2 h
//   transverse contact ratio
//     ea = (sqrt(ra1^2 - rb1^2) + sqrt(ra2^2 - rb2^2) - aw sin awt) / (pi mt cos at)
//   undercut limit         z_min = 2 cos b (1 - x) / sin^2 at
import { fmtNum } from '../kit/eng.js';

const DEG = Math.PI / 180;
const inv = (a) => Math.tan(a) - a;

/** Solve inv(a) = v for a (Newton; inv' = tan^2 a). */
function invInverse(v) {
  let a = Math.cbrt(3 * v); // good start: inv(a) ~ a^3 / 3
  for (let i = 0; i < 50; i++) {
    const f = inv(a) - v;
    const t = Math.tan(a);
    a -= f / (t * t);
    if (Math.abs(f) < 1e-14) break;
  }
  return a;
}

export function run({ system, m, dp, z1, z2, alpha, beta, x1, x2, rpm }) {
  const warnings = [];
  const mn = system === 'dp' ? (dp > 0 ? 25.4 / dp : null) : m;
  if (!(mn > 0)) return { warnings: [system === 'dp' ? 'Give the diametral pitch (teeth per inch of pitch diameter), e.g. 24.' : 'Give the module in mm, e.g. 1.'] };
  if (!(z1 >= 1 && z2 >= 1)) return { warnings: ['Give both tooth counts (whole numbers above zero).'] };
  if (!Number.isInteger(z1) || !Number.isInteger(z2)) warnings.push('Tooth counts should be whole numbers.');
  const an = (Number(alpha) || 20) * DEG; // the select gives a string
  const b = (Number.isFinite(beta) ? beta : 0) * DEG;
  const s1 = Number.isFinite(x1) ? x1 : 0;
  const s2 = Number.isFinite(x2) ? x2 : 0;
  if (Math.abs(b) >= 45 * DEG) return { warnings: ['The helix angle must be under 45°; 15-30° is usual.'] };
  if (an <= 10 * DEG || an >= 35 * DEG) return { warnings: ['The pressure angle should be 14.5°, 20° or 25°.'] };

  const mt = mn / Math.cos(b);
  const at = Math.atan(Math.tan(an) / Math.cos(b));
  const d1 = z1 * mt, d2 = z2 * mt;
  const db1 = d1 * Math.cos(at), db2 = d2 * Math.cos(at);
  const a = (d1 + d2) / 2;
  const awt = invInverse((2 * Math.tan(an) * (s1 + s2)) / (z1 + z2) + inv(at));
  const aw = (a * Math.cos(at)) / Math.cos(awt);
  const y = ((z1 + z2) / (2 * Math.cos(b))) * (Math.cos(at) / Math.cos(awt) - 1);
  const da1 = d1 + 2 * mn * (1 + y - s2);
  const da2 = d2 + 2 * mn * (1 + y - s1);
  const h = mn * (2.25 + y - (s1 + s2));
  const df1 = da1 - 2 * h, df2 = da2 - 2 * h;
  const ra1 = da1 / 2, ra2 = da2 / 2, rb1 = db1 / 2, rb2 = db2 / 2;
  const ea = (Math.sqrt(Math.max(0, ra1 * ra1 - rb1 * rb1)) + Math.sqrt(Math.max(0, ra2 * ra2 - rb2 * rb2)) - aw * Math.sin(awt))
    / (Math.PI * mt * Math.cos(at));
  const sn = (x) => mn * (Math.PI / 2 + 2 * x * Math.tan(an)); // normal tooth thickness at the pitch circle
  const zmin = (x) => (2 * Math.cos(b) * (1 - x)) / Math.sin(at) ** 2;
  const ratio = z2 / z1;

  for (const [z, x, n] of [[z1, s1, 'Pinion'], [z2, s2, 'Gear']]) {
    if (z < zmin(x) - 1e-9) warnings.push(`${n} (${z} teeth) is below the undercut limit of ${fmtNum(zmin(x), 3)} teeth at x = ${x}: add a positive profile shift of about ${fmtNum(Math.max(0, 1 - (z * Math.sin(at) ** 2) / (2 * Math.cos(b))), 2)} or use more teeth.`);
  }
  if (ea < 1.2) warnings.push(`Contact ratio ${fmtNum(ea, 3)} is under 1.2: the drive runs rough or loses contact between teeth. Use more teeth or a smaller pressure angle.`);
  if (df1 <= 0 || df2 <= 0) warnings.push('A root diameter is zero or negative: too few teeth for this module.');

  const values = [
    { label: 'Centre distance', value: fmtNum(aw, 5), unit: 'mm', tone: 'ok', hint: s1 + s2 ? `standard ${fmtNum(a, 5)} mm without shift` : 'standard' },
    { label: 'Ratio', value: `${fmtNum(ratio, 4)} : 1`, hint: `${z2} / ${z1}` },
    { label: 'Pinion pitch Ø', value: fmtNum(d1, 5), unit: 'mm' },
    { label: 'Pinion outside Ø', value: fmtNum(da1, 5), unit: 'mm' },
    { label: 'Gear pitch Ø', value: fmtNum(d2, 5), unit: 'mm' },
    { label: 'Gear outside Ø', value: fmtNum(da2, 5), unit: 'mm' },
    { label: 'Contact ratio εα', value: fmtNum(ea, 3), tone: ea >= 1.2 ? 'ok' : 'bad', hint: '1.2 minimum, 1.4+ good' },
    { label: 'Module', value: fmtNum(mn, 4), unit: 'mm', hint: system === 'dp' ? `from ${fmtNum(dp, 4)} DP` : `${fmtNum(25.4 / mn, 4)} DP` },
  ];
  if (rpm > 0) values.push({ label: 'Output speed', value: fmtNum(rpm / ratio, 4), unit: 'rpm', hint: `pitch-line ${fmtNum((Math.PI * d1 * rpm) / 60000, 3)} m/s` });

  const row = (label, f) => [label, f(0), f(1)];
  const g = [
    { z: z1, x: s1, d: d1, da: da1, df: df1, db: db1 },
    { z: z2, x: s2, d: d2, da: da2, df: df2, db: db2 },
  ];
  const mm = (v) => `${fmtNum(v, 5)} mm`;
  return {
    values,
    warnings,
    tables: [{
      title: 'Gear dimensions',
      columns: ['', 'Pinion', 'Gear'],
      rows: [
        row('Teeth z', (i) => String(g[i].z)),
        row('Profile shift x', (i) => String(g[i].x)),
        row('Pitch diameter d', (i) => mm(g[i].d)),
        row('Outside (tip) diameter da', (i) => mm(g[i].da)),
        row('Root diameter df', (i) => mm(g[i].df)),
        row('Base diameter db', (i) => mm(g[i].db)),
        row('Tooth thickness (normal, at d)', (i) => mm(sn(g[i].x))),
        row('Whole depth h', () => mm(h)),
        row('Undercut limit z_min', (i) => fmtNum(zmin(g[i].x), 3)),
      ],
    }, {
      title: 'Pair',
      columns: ['Quantity', 'Value'],
      rows: [
        ['Circular pitch p (normal)', mm(Math.PI * mn)],
        ['Transverse module mt', mm(mt)],
        ['Transverse pressure angle', `${fmtNum(at / DEG, 5)}°`],
        ['Working pressure angle', `${fmtNum(awt / DEG, 5)}°`],
        ['Centre distance modification y', fmtNum(y, 4)],
        ['Base pitch (transverse)', mm(Math.PI * mt * Math.cos(at))],
      ],
    }],
    notes: [
      'Standard full-depth teeth: addendum 1 m, dedendum 1.25 m. No backlash allowance: thin the teeth or open the centre distance by the backlash you need.',
      Math.abs(b) > 0 ? 'Helical pair: diameters use the transverse module; the two gears need opposite hands. Overlap ratio depends on face width and is not computed.' : 'Spur pair.',
      'With profile shift the tip diameters are reduced by y so the root clearance stays 0.25 m (KHK method).',
    ],
  };
}
