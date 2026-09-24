// Linear sensor calibration, ref = gain * raw + offset.
//   Ordinary least squares (NIST/SEMATECH e-Handbook 4.1.4.1):
//     gain   = Σ (x - x̄)(y - ȳ) / Σ (x - x̄)²
//     offset = ȳ - gain · x̄
//     R²     = 1 - SS_res / SS_tot
//   With two points this is the exact line through both.
//   Fixed point: K = round(k · scale · 2^bits), out = (raw · G + O + 2^(bits-1)) >> bits.
import { parseEng, fmtNum } from '../kit/eng.js';

const INT32 = 2 ** 31 - 1;
const f6 = (v) => fmtNum(v, 7);

export function run({ points, rawUnit, refUnit, probe, scale, shift }) {
  const warnings = [];
  const ru = String(rawUnit || '').trim() || 'raw';
  const yu = String(refUnit || '').trim() || 'units';
  const pts = [], bad = [];
  (Array.isArray(points) ? points : []).forEach((r, i) => {
    const rs = String(r?.raw ?? '').trim(), ys = String(r?.ref ?? '').trim();
    if (!rs && !ys) return;
    const x = parseEng(rs), y = parseEng(ys);
    if (x == null || y == null) bad.push(`row ${i + 1} (${rs || '–'}, ${ys || '–'})`);
    else pts.push({ x, y, row: i + 1 });
  });
  if (bad.length) warnings.push(`Skipped, not numbers: ${bad.join('; ')}. Write values like 1580, 25.1 or 4k7.`);
  if (pts.length < 2) return { warnings: [...warnings, 'Give at least two calibration points (raw reading and reference value).'] };
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  const sxx = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  const sxy = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
  const syy = pts.reduce((a, p) => a + (p.y - my) ** 2, 0);
  if (!(sxx > 0)) return { warnings: [...warnings, 'All raw readings are the same: a line needs at least two different raw values. Take readings across the range.'] };
  const gain = sxy / sxx;
  const offset = my - gain * mx;
  if (gain === 0) warnings.push('The reference does not change with the raw reading (gain 0): check the points.');
  // Floating-point dust (1e-14) is shown as the exact zero it is.
  const tiny = 1e-9 * Math.max(1, ...pts.map((p) => Math.abs(p.y)));
  const clean = (v) => (Math.abs(v) < tiny ? 0 : v);
  const fit = (x) => clean(gain * x + offset);
  const res = pts.map((p) => clean(p.y - (gain * p.x + offset)));
  const ssr = res.reduce((a, r) => a + r * r, 0);
  const r2 = syy > 0 ? 1 - ssr / syy : 1;
  const rms = Math.sqrt(ssr / n);
  // Residual standard error uses n - 2 degrees of freedom (none left with 2 points).
  const se = n > 2 ? Math.sqrt(ssr / (n - 2)) : null;
  const maxRes = res.reduce((a, r) => (Math.abs(r) > Math.abs(a) ? r : a), 0);
  const span = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
  if (n > 2 && span > 0 && Math.abs(maxRes) / span > 0.01) {
    warnings.push(`The worst point is ${fmtNum(Math.abs(maxRes), 3)} ${yu} off the line, ${fmtNum((100 * Math.abs(maxRes)) / span, 3)} % of the span: the sensor is not linear over this range. Use a piecewise table or a polynomial, or calibrate a narrower range.`);
  }
  if (n === 2) warnings.push('Two points fit any line exactly: there is no check on linearity or on a bad reading. Add a third point in the middle if you can.');

  const xs = pts.map((p) => p.x);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  let conv = '–';
  if (probe != null) {
    conv = `${fmtNum(gain * probe + offset, 6)}`;
    if (probe < xmin - 0.1 * (xmax - xmin) || probe > xmax + 0.1 * (xmax - xmin)) {
      warnings.push(`${fmtNum(probe)} ${ru} is outside the calibrated range ${fmtNum(xmin)} … ${fmtNum(xmax)}: the line is extrapolated there. Add a calibration point near it.`);
    }
  }

  // Fixed point.
  const sc = scale > 0 ? scale : 1;
  if (!(scale > 0)) warnings.push('The fixed-point scale must be above 0: 1 used.');
  let bits = Number.isFinite(shift) ? Math.round(shift) : 16;
  if (!(bits >= 0 && bits <= 30)) { warnings.push('Fraction bits must be 0 to 30: 16 used.'); bits = 16; }
  const q = 2 ** bits;
  const G = Math.round(gain * sc * q);
  const O = Math.round(offset * sc * q);
  const xAbs = Math.max(Math.abs(xmin), Math.abs(xmax)) * 1.25;
  const peak = xAbs * Math.abs(G) + Math.abs(O) + q / 2;
  const wide = peak > INT32;
  const itype = wide ? 'int64_t' : 'int32_t';
  if (!Number.isSafeInteger(G) || !Number.isSafeInteger(O)) warnings.push('The fixed-point constants are too large: lower the fraction bits or the scale.');
  if (G !== 0 && Math.abs(G) < 1000) warnings.push(`The fixed-point gain is only ${G}: it is rounded by up to ${fmtNum(50 / Math.abs(G), 2)} %. Raise the fraction bits.`);
  if (G === 0 && gain !== 0) warnings.push('The fixed-point gain rounds to 0: raise the fraction bits or the scale.');
  const fixed = (x) => Math.floor((x * G + O + (bits ? q / 2 : 0)) / q);
  const fixErr = pts.reduce((a, p) => Math.max(a, Math.abs(fixed(p.x) / sc - fit(p.x))), 0);

  const values = [
    { label: 'Gain', value: f6(gain), tone: 'ok', hint: `${yu} per ${ru}` },
    { label: 'Offset', value: f6(offset), unit: yu, tone: 'ok' },
    { label: 'Inverse gain', value: gain ? f6(1 / gain) : '–', hint: gain ? `raw = ${f6(1 / gain)} · y ${-offset / gain < 0 ? '−' : '+'} ${f6(Math.abs(offset / gain))}` : undefined },
    { label: 'Points used', value: String(n), hint: n === 2 ? 'exact two-point line' : 'least squares' },
    { label: 'R²', value: n > 2 ? fmtNum(r2, 6) : '–', tone: n > 2 ? (r2 > 0.999 ? 'ok' : r2 > 0.99 ? 'warn' : 'bad') : undefined },
    { label: 'Worst residual', value: fmtNum(maxRes, 4), unit: yu, hint: `RMS ${fmtNum(rms, 3)}${se != null ? `, std. error ${fmtNum(se, 3)}` : ''}` },
    { label: `${fmtNum(probe ?? NaN)} ${ru} reads`, value: conv, unit: yu },
    { label: 'Fixed-point gain', value: String(G), hint: `× ${fmtNum(sc)} · 2^${bits}, ${itype} math` },
    { label: 'Fixed-point offset', value: String(O), hint: `× ${fmtNum(sc)} · 2^${bits}` },
  ];

  const code = [
    `// ${yu} = gain * ${ru} + offset   (${n === 2 ? 'two-point line' : `least squares over ${n} points, worst residual ${fmtNum(Math.abs(maxRes), 3)} ${yu}`})`,
    `#define CAL_GAIN    ${f6(gain)}f`,
    `#define CAL_OFFSET  ${f6(offset)}f`,
    '',
    'static inline float cal_apply(float raw)',
    '{',
    '    return CAL_GAIN * raw + CAL_OFFSET;',
    '}',
    '',
    `// Integer version: result in ${yu} x ${fmtNum(sc)} (Q${bits} constants, max rounding error ${fmtNum(fixErr, 2)} ${yu} over the points).`,
    `#define CAL_GAIN_Q    ${G}${wide ? 'LL' : 'L'}   /* gain   * ${fmtNum(sc)} * 2^${bits} */`,
    `#define CAL_OFFSET_Q  ${O}${wide ? 'LL' : 'L'}   /* offset * ${fmtNum(sc)} * 2^${bits} */`,
    '',
    `static inline ${itype} cal_apply_fixed(int32_t raw)`,
    '{',
    `    return ((${itype})raw * CAL_GAIN_Q + CAL_OFFSET_Q${bits ? ` + (1L << ${bits - 1})` : ''}) >> ${bits};`,
    '}',
  ].join('\n');

  return {
    values,
    warnings,
    charts: [{ title: 'Residual at each point', type: 'bars', x: pts.map((p) => fmtNum(p.x, 5)),
      series: [{ name: 'Reference − fit', y: res.map((r) => Number(r.toPrecision(6))) }], xLabel: `raw (${ru})`, yLabel: `residual (${yu})` }],
    tables: [{
      title: 'Points against the fit',
      columns: ['Row', `Raw (${ru})`, `Reference (${yu})`, `Fit (${yu})`, `Residual (${yu})`, `Fixed-point (${yu} × ${fmtNum(sc)})`],
      rows: pts.map((p, i) => [p.row, fmtNum(p.x, 6), fmtNum(p.y, 6), fmtNum(fit(p.x), 6), fmtNum(res[i], 4), String(fixed(p.x))]),
    }],
    texts: [{ title: 'C code', body: code, lang: 'c' }],
    notes: [
      'The fit minimises the error in the reference value (y); the raw readings are taken as exact.',
      'Spread the points over the whole working range: a line fitted to a narrow cluster extrapolates badly.',
      wide ? 'The fixed-point product can pass 2^31 for readings near the calibrated range, so the integer version uses int64_t.' : 'The fixed-point product stays inside int32_t for readings up to 1.25 × the largest calibration reading.',
    ],
  };
}
