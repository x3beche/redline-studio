// RC and LC filter design, cutoff = −3 dB point.
//   RC:  fc = 1 / (2π R C)
//   LC into load R (series L + shunt C for low-pass, series C + shunt L for high-pass):
//        H_lp = 1 / (1 − x² + j x/Q),  H_hp = −x² / (1 − x² + j x/Q),  x = ω/ω0
//        ω0 = 1/√(LC),  Q = R·√(C/L)   ->  C = Q / (R ω0),  L = R / (Q ω0)
//   −3 dB of a 2nd-order section: x² = u, u² − (2 − 1/Q²)u − 1 = 0
//        u = [(2 − 1/Q²) + √((2 − 1/Q²)² + 4)] / 2;   low-pass ω0 = ωc/√u, high-pass ω0 = ωc·√u
import { fmtEng, fmtNum, standard, SERIES, E12 } from '../kit/eng.js';

const ALIGN = {
  butterworth: { name: 'Butterworth', q: Math.SQRT1_2 },
  bessel: { name: 'Bessel', q: 0.5773 },
  critical: { name: 'Critically damped', q: 0.5 },
  cheby1: { name: 'Chebyshev 1 dB', q: 0.9565 },
};
const TWO_PI = 2 * Math.PI;

const u3 = (q) => { const b = 2 - 1 / (q * q); return (b + Math.sqrt(b * b + 4)) / 2; };

/** complex response {mag, deg} at f */
function resp(topo, f, p) {
  if (topo === 'rc-lp' || topo === 'rc-hp') {
    const x = f / p.fc;
    const den = { re: 1, im: x };
    const num = topo === 'rc-lp' ? { re: 1, im: 0 } : { re: 0, im: x };
    return div(num, den);
  }
  const x = f / p.f0;
  const den = { re: 1 - x * x, im: x / p.q };
  const num = topo === 'lc-lp' ? { re: 1, im: 0 } : { re: -x * x, im: 0 };
  return div(num, den);
}
function div(a, b) {
  const d = b.re * b.re + b.im * b.im;
  const re = (a.re * b.re + a.im * b.im) / d, im = (a.im * b.re - a.re * b.im) / d;
  return { mag: Math.hypot(re, im), deg: (Math.atan2(im, re) * 180) / Math.PI };
}
const db = (m) => 20 * Math.log10(Math.max(m, 1e-12));

/** −3 dB frequency of the built filter */
function f3(topo, p) {
  if (topo.startsWith('rc')) return p.fc;
  const u = u3(p.q);
  return topo === 'lc-lp' ? p.f0 * Math.sqrt(u) : p.f0 / Math.sqrt(u);
}

export function run({ topo, fc, r, c, align, series }) {
  const warnings = [];
  const T = ['rc-lp', 'rc-hp', 'lc-lp', 'lc-hp'].includes(topo) ? topo : 'rc-lp';
  if (!(fc > 0)) return { warnings: ['Give the cutoff frequency in Hz (e.g. 1k).'] };
  const rs = SERIES[series] || SERIES.E24;
  const values = [];
  let built, exact;
  const isRC = T.startsWith('rc');

  if (isRC) {
    if (c > 0) {
      const R = 1 / (TWO_PI * fc * c);
      const Rs = standard(R, rs), Cs = c;
      exact = { R, C: c };
      built = { fc: 1 / (TWO_PI * Rs * Cs), R: Rs, C: Cs };
      values.push({ label: 'R (exact)', value: fmtEng(R, 'Ω') }, { label: `R (${series || 'E24'})`, value: fmtEng(Rs, 'Ω'), tone: 'ok' },
        { label: 'C (fixed)', value: fmtEng(Cs, 'F') });
      if (R < 100) warnings.push(`R is only ${fmtEng(R, 'Ω')}: the source must drive that load; a smaller C gives a friendlier R.`);
    } else {
      if (!(r > 0)) return { warnings: ['Give R in ohms (or fix C instead).'] };
      const C = 1 / (TWO_PI * fc * r);
      const Rs = standard(r, rs), Cs = standard(C, E12);
      exact = { R: r, C };
      built = { fc: 1 / (TWO_PI * Rs * Cs), R: Rs, C: Cs };
      values.push({ label: 'C (exact)', value: fmtEng(C, 'F') }, { label: 'C (E12)', value: fmtEng(Cs, 'F'), tone: 'ok' },
        { label: `R (${series || 'E24'})`, value: fmtEng(Rs, 'Ω') });
      if (C < 10e-12) warnings.push(`C is only ${fmtEng(C, 'F')}: comparable to stray and input capacitance. Use a larger R or accept a lower cutoff.`);
      if (C > 10e-6) warnings.push(`C is ${fmtEng(C, 'F')}: large, and electrolytic tolerance is poor. Use a larger R if the load allows.`);
    }
  } else {
    if (!(r > 0)) return { warnings: ['Give the load resistance in ohms: an LC filter\'s damping depends on it.'] };
    const al = ALIGN[align] || ALIGN.butterworth;
    const u = u3(al.q);
    const w0 = T === 'lc-lp' ? (TWO_PI * fc) / Math.sqrt(u) : TWO_PI * fc * Math.sqrt(u);
    const C = al.q / (r * w0), L = r / (al.q * w0);
    const Cs = standard(C, E12), Ls = standard(L, E12);
    exact = { L, C, R: r, q: al.q, f0: w0 / TWO_PI };
    built = { L: Ls, C: Cs, R: r, f0: 1 / (TWO_PI * Math.sqrt(Ls * Cs)), q: r * Math.sqrt(Cs / Ls) };
    built.fc = f3(T, built);
    values.push(
      { label: 'L (exact)', value: fmtEng(L, 'H') }, { label: 'L (E12)', value: fmtEng(Ls, 'H'), tone: 'ok' },
      { label: 'C (exact)', value: fmtEng(C, 'F') }, { label: 'C (E12)', value: fmtEng(Cs, 'F'), tone: 'ok' },
      { label: 'Resonance f0', value: fmtEng(built.f0, 'Hz') },
      { label: 'Q with standard parts', value: fmtNum(built.q, 3), hint: `${al.name} target ${fmtNum(al.q, 3)}` },
      { label: 'Impedance √(L/C)', value: fmtEng(Math.sqrt(Ls / Cs), 'Ω') },
    );
    const peak = built.q > Math.SQRT1_2 ? db(1 / ((1 / built.q) * Math.sqrt(1 - 1 / (4 * built.q * built.q)))) : 0;
    values.push({ label: 'Peaking', value: fmtNum(peak, 2), unit: 'dB', tone: peak > 3 ? 'bad' : peak > 0.5 ? 'warn' : 'ok' });
    if (peak > 3) warnings.push(`${fmtNum(peak, 2)} dB peaking near ${fmtEng(built.f0, 'Hz')}: add damping (a series R with the C, or a lower load resistance).`);
    if (L > 0.1) warnings.push(`L is ${fmtEng(L, 'H')}: impractical. At this frequency and load use an RC or active filter instead.`);
    if (C < 5e-12) warnings.push(`C is ${fmtEng(C, 'F')}: comparable to parasitics; the real cutoff will be off.`);
  }

  const err = (built.fc / fc - 1) * 100;
  values.unshift({ label: 'Cutoff with standard parts', value: fmtEng(built.fc, 'Hz'), tone: Math.abs(err) > 10 ? 'warn' : 'ok',
    hint: `${err >= 0 ? '+' : ''}${fmtNum(err, 2)} % from target` });
  if (Math.abs(err) > 10) warnings.push(`Standard values move the cutoff ${fmtNum(err, 2)} %: try the E24/E96 resistor series, or combine two capacitors.`);

  // response, 0.01·fc … 100·fc, log-spaced
  const N = 41, xs = [], ys = [];
  for (let k = 0; k < N; k++) {
    const fx = fc * Math.pow(10, -2 + (4 * k) / (N - 1));
    xs.push(fmtEng(fx, 'Hz'));
    ys.push(Number(db(resp(T, fx, built).mag).toFixed(2)));
  }
  const mults = [0.01, 0.1, 0.5, 1, 2, 10, 100];
  const rows = mults.map((m) => { const q = resp(T, m * fc, built); return [`${m} × fc`, fmtEng(m * fc, 'Hz'), fmtNum(db(q.mag), 3), fmtNum(q.deg, 3)]; });
  const slope = isRC ? 20 : 40;

  return {
    values,
    warnings,
    charts: [{ title: 'Magnitude response with standard values', type: 'line', x: xs, series: [{ name: 'gain dB', y: ys }],
      xLabel: 'frequency (log steps)', yLabel: 'gain, dB' }],
    tables: [{ title: 'Gain and phase with standard values', columns: ['Point', 'Frequency', 'Gain dB', 'Phase °'], rows }],
    exact,
    notes: [
      `Beyond the cutoff the response falls ${slope} dB per decade (${slope / 20 * 6} dB per octave).`,
      isRC ? 'Assumes a source impedance well below R and a load impedance well above R (or buffer the output).'
        : 'Assumes an ideal voltage source and a purely resistive load R; a different or missing load changes Q and can cause peaking. Inductor DCR and capacitor ESR add damping.',
      'Capacitor tolerance (C0G ±5 %, X7R ±10–20 % plus DC-bias loss) moves the cutoff more than the E-series step.',
    ],
  };
}
