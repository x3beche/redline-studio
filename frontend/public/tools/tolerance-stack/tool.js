// 1-D tolerance stack-up of a chain of dimensions: worst case and statistical.
// Method (Fortini, "Dimensioning for Interchangeable Manufacture"; ASME Y14.5 stack-up practice):
//   Each dimension i: nominal N, tolerance +a / -b, sense s = +1 or -1 in the loop.
//   Converted to mean ± half-band:  m = N + (a - b)/2,  t = (a + b)/2.
//   Result mean       M  = Σ s·m
//   Worst case        ±Σ t
//   RSS (statistical) ±√(Σ t²)       each band taken as ±3σ of a centred normal process
//   Modified RSS      ±1.5·√(Σ t²)   Bender's factor for processes that are not centred
//   Out-of-spec share from the RSS normal: σ = RSS/3, Φ from Abramowitz & Stegun 7.1.26.
import { parseEng, fmtNum } from '../kit/eng.js';

const num = (v) => (v === '' || v == null ? null : parseEng(v));
const f4 = (v) => fmtNum(Math.round(v * 1e6) / 1e6, 6);
const pm = (v) => `± ${f4(v)}`;

function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

export function run({ dims, lsl, usl, unit }) {
  const warnings = [];
  const u = unit || 'mm';
  const rows = [];
  (dims || []).forEach((r, i) => {
    const name = String(r.name || `#${i + 1}`).trim() || `#${i + 1}`;
    const N = num(r.nominal), a = num(r.plus), bRaw = num(r.minus);
    if (N == null && a == null && bRaw == null) return; // an empty row
    if (N == null || a == null || bRaw == null) { warnings.push(`Row "${name}": nominal, + and − tolerance must all be numbers; the row is skipped.`); return; }
    const b = Math.abs(bRaw); // the − tolerance is given as its size
    if (a + b < 0) { warnings.push(`Row "${name}": the tolerance band is negative; the row is skipped.`); return; }
    if (a < 0 && -a > b) warnings.push(`Row "${name}": the + tolerance is negative, check the signs.`);
    const s = String(r.dir || '+').trim().startsWith('-') || String(r.dir).trim().startsWith('−') ? -1 : 1;
    rows.push({ name, N, a, b, s, m: N + (a - b) / 2, t: (a + b) / 2, i });
  });
  if (!rows.length) return { warnings: [...warnings, 'Add at least one dimension: name, nominal, + tolerance, − tolerance and direction (+ adds to the gap, − takes from it).'] };

  const nominal = rows.reduce((z, r) => z + r.s * r.N, 0);
  const mean = rows.reduce((z, r) => z + r.s * r.m, 0);
  const wc = rows.reduce((z, r) => z + r.t, 0);
  const rss = Math.sqrt(rows.reduce((z, r) => z + r.t * r.t, 0));
  const mrss = Math.min(wc, 1.5 * rss);
  const values = [
    { label: 'Nominal result', value: f4(nominal), unit: u },
    { label: 'Mean result', value: f4(mean), unit: u, hint: 'centre of all tolerance bands' },
    { label: 'Worst case', value: `${f4(mean - wc)} … ${f4(mean + wc)}`, unit: u, hint: pm(wc) },
    { label: 'Statistical (RSS)', value: `${f4(mean - rss)} … ${f4(mean + rss)}`, unit: u, hint: `${pm(rss)}, ±3σ` },
    { label: 'Modified RSS (x1.5)', value: `${f4(mean - mrss)} … ${f4(mean + mrss)}`, unit: u, hint: pm(mrss) },
  ];

  let lim = null;
  if (lsl != null && usl != null && lsl > usl) warnings.push('The lower limit is above the upper limit: swap them.');
  if (lsl != null || usl != null) {
    const wcOk = (lsl == null || mean - wc >= lsl - 1e-12) && (usl == null || mean + wc <= usl + 1e-12);
    const rsOk = (lsl == null || mean - rss >= lsl - 1e-12) && (usl == null || mean + rss <= usl + 1e-12);
    const sigma = rss / 3;
    let out = 0;
    if (sigma > 0) {
      if (lsl != null) out += Phi((lsl - mean) / sigma);
      if (usl != null) out += 1 - Phi((usl - mean) / sigma);
    } else out = (lsl != null && mean < lsl) || (usl != null && mean > usl) ? 1 : 0;
    lim = { wcOk, rsOk, out, sigma,
      outLo: lsl != null ? (sigma > 0 ? Phi((lsl - mean) / sigma) : (mean < lsl ? 1 : 0)) : 0,
      outHi: usl != null ? (sigma > 0 ? 1 - Phi((usl - mean) / sigma) : (mean > usl ? 1 : 0)) : 0 };
    const spec = `${lsl != null ? f4(lsl) : '−∞'} … ${usl != null ? f4(usl) : '+∞'} ${u}`;
    values.push(
      { label: 'Worst case vs limits', value: wcOk ? 'passes' : 'fails', tone: wcOk ? 'ok' : 'bad', hint: spec },
      { label: 'RSS vs limits', value: rsOk ? 'passes' : 'fails', tone: rsOk ? 'ok' : 'bad', hint: spec },
      { label: 'Expected out of spec', value: out < 1e-6 ? '< 1 ppm' : out < 0.01 ? `${fmtNum(out * 1e6, 3)} ppm` : `${fmtNum(out * 100, 3)} %`,
        tone: out < 0.00135 ? 'ok' : out < 0.01 ? 'warn' : 'bad', hint: 'normal, σ = RSS / 3' },
    );
    if (!wcOk && rsOk) warnings.push('Worst case fails but RSS passes: fine for volume production of centred processes; for a few parts or when every one must fit, tighten the largest contributors.');
    if (!rsOk) warnings.push('Even the statistical result is outside the limits: tighten the largest contributors (see the table) or move the nominal.');
  }

  const tbl = rows.map((r) => [r.name, r.s > 0 ? '+' : '−', f4(r.N), `+${f4(r.a)} / −${f4(r.b)}`, f4(r.m), pm(r.t),
    `${fmtNum(wc > 0 ? (100 * r.t) / wc : 0, 3)} %`, `${fmtNum((100 * r.t * r.t) / (rss * rss || 1), 3)} %`]);
  // For the page's drawing only (manifest agentOmit): the chain with its running
  // positions, the result's ranges and the RSS normal curve.
  let pos = 0;
  const sigma = rss / 3;
  const span = wc > 0 ? wc : Math.max(Math.abs(mean) * 0.01, 1e-3);
  let xlo = mean - span, xhi = mean + span;
  if (lsl != null) xlo = Math.min(xlo, lsl); if (usl != null) xhi = Math.max(xhi, usl);
  const padX = (xhi - xlo) * 0.12 || 1; xlo -= padX; xhi += padX;
  const draw = {
    unit: u, nominal, mean, wc, rss, mrss, sigma, lsl: lsl ?? null, usl: usl ?? null, lim,
    rows: rows.map((r) => {
      const start = pos; pos += r.s * r.N;
      return { i: r.i, name: r.name, N: r.N, a: r.a, b: r.b, s: r.s, m: r.m, t: r.t, start, end: pos,
        wcShare: wc > 0 ? (100 * r.t) / wc : 0, rssShare: rss > 0 ? (100 * r.t * r.t) / (rss * rss) : 0 };
    }),
    xRange: [xlo, xhi],
    curve: sigma > 0 ? Array.from({ length: 161 }, (_, k) => {
      const x = xlo + ((xhi - xlo) * k) / 160;
      return [x, Math.exp(-0.5 * ((x - mean) / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI))];
    }) : null,
  };
  return {
    values, draw,
    tables: [{ title: 'The chain', columns: ['Dimension', 'Dir', 'Nominal', 'Tolerance', 'Mean', 'Half band', 'Share, worst case', 'Share, RSS'], rows: tbl }],
    charts: [{ title: 'Contribution of each dimension', type: 'bars', x: rows.map((r) => r.name),
      series: [{ name: 'Worst case %', y: rows.map((r) => (100 * r.t) / wc || 0) }, { name: 'RSS %', y: rows.map((r) => (100 * r.t * r.t) / (rss * rss) || 0) }],
      yLabel: '% of the result tolerance' }],
    warnings,
    notes: [
      'Direction: + for dimensions that make the result (gap) larger, − for those that make it smaller; walk the loop in one direction.',
      'RSS assumes independent, centred, normal processes with each band = ±3σ; with fewer than about 4 dimensions or uncentred processes trust the worst case.',
      'A one-dimensional stack only: angles, form and position tolerances need their own terms added.',
    ],
  };
}
