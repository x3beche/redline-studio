// First-order IIR low-pass (EMA): y[n] = y[n-1] + α (x[n] - y[n-1])
//   H(z) = α / (1 - β z^-1),  β = 1 - α
//   |H(e^jω)|² = α² / (1 - 2β cos ω + β²),  ω = 2π f / fs
// Exact -3 dB: setting |H|² = 1/2 gives β² - (4 - 2c) β + 1 = 0 with c = cos ωc, so
//   α = c - 1 + sqrt(c² - 4c + 3)                                (standard derivation)
//   and back: c = (1 + β² - 2α²) / (2β)
// Matched RC (impulse invariance, Oppenheim & Schafer ch. 7):
//   α = 1 - exp(-2π fc / fs),   fc = -ln(1 - α) fs / (2π)
// Time constant in samples: τn = -1 / ln(β); settle to p: n = ln(1 - p) / ln(β)
// White-noise variance ratio: Σ α² β^(2n) = α / (2 - α)
import { fmtEng, fmtNum } from '../kit/eng.js';

const TAU = 2 * Math.PI;

const alphaExact = (fc, fs) => {
  const c = Math.cos((TAU * fc) / fs);
  return c - 1 + Math.sqrt(c * c - 4 * c + 3);
};
const alphaRc = (fc, fs) => 1 - Math.exp((-TAU * fc) / fs);
/** The true -3 dB frequency of a given α, or null when |H| never falls to -3 dB before fs/2. */
const f3db = (a, fs) => {
  const b = 1 - a;
  if (b <= 0) return null;
  const c = (1 + b * b - 2 * a * a) / (2 * b);
  if (c < -1 || c > 1) return null;
  return (fs * Math.acos(c)) / TAU;
};
const magDb = (a, f, fs) => {
  const b = 1 - a, w = (TAU * f) / fs;
  return 10 * Math.log10((a * a) / (1 - 2 * b * Math.cos(w) + b * b));
};

export function run({ mode, fs, fc, method, alpha, k }) {
  const warnings = [];
  if (!(fs > 0)) return { warnings: ['Give the sample rate in Hz, e.g. 1k.'] };
  let a, src;
  if (mode === 'alpha') {
    if (!(alpha > 0 && alpha <= 1)) return { warnings: ['α must be above 0 and at most 1, e.g. 0.1 (1 = no filtering).'] };
    a = alpha; src = `α = ${fmtNum(a, 6)}`;
  } else if (mode === 'shift') {
    if (!(k >= 0 && k <= 30)) return { warnings: ['Give the right shift as a whole number 0 … 30, e.g. 4.'] };
    const kk = Math.round(k);
    if (kk !== k) warnings.push(`A shift must be whole: ${kk} used.`);
    a = 2 ** -kk; src = `>> ${kk}`;
  } else {
    if (!(fc > 0)) return { warnings: ['Give the cutoff frequency in Hz, e.g. 10.'] };
    if (fc >= fs / 2) return { warnings: [`A cutoff of ${fmtEng(fc, 'Hz')} is at or above Nyquist (${fmtEng(fs / 2, 'Hz')}): a sampled filter cannot have it. Lower the cutoff or raise the sample rate.`] };
    a = method === 'rc' ? alphaRc(fc, fs) : alphaExact(fc, fs);
    src = method === 'rc' ? 'matched RC' : 'exact −3 dB';
    if (fc > fs / 10) warnings.push(`The cutoff is ${fmtNum(fs / fc, 3)}× below the sample rate: a one-pole IIR only behaves like an RC filter well below fs/10, and the 'exact' and 'RC' coefficients differ here. Sample faster if the shape matters.`);
  }
  const b = 1 - a;
  const f3 = f3db(a, fs);
  const fRc = b > 0 ? (-Math.log(b) * fs) / TAU : null;
  if (f3 == null) warnings.push(`With α = ${fmtNum(a, 4)} the filter never reaches −3 dB below Nyquist: it barely filters. Use a smaller α.`);
  if (a < 1e-4) warnings.push(`α = ${fmtNum(a, 3)} is very small: in float32 the update α (x − y) can round away when y is large, and in fixed point it needs more than ${Math.ceil(-Math.log2(a))} fraction bits in y. Keep y in 32-bit fixed point or double, or decimate first.`);
  const tauN = b > 0 ? -1 / Math.log(b) : 0;
  const settle = (p) => (b > 0 ? Math.log(1 - p) / Math.log(b) : 1);
  const nvr = a / (2 - a);
  const kNear = Math.max(0, Math.round(Math.log2(1 / a)));
  const aNear = 2 ** -kNear;
  const q15 = Math.round(a * 32768);
  if (q15 === 0) warnings.push('α rounds to 0 in Q15: use a Q31 constant or a shift.');

  const values = [
    { label: 'α', value: fmtNum(a, 6), tone: 'ok', hint: src },
    { label: '1 − α (pole)', value: fmtNum(b, 6) },
    { label: '−3 dB frequency', value: f3 != null ? fmtEng(f3, 'Hz', 4) : '–', hint: 'from |H| of this α' },
    { label: 'RC-equivalent cutoff', value: fRc != null ? fmtEng(fRc, 'Hz', 4) : '–', hint: '1 / (2π τ)' },
    { label: 'Time constant', value: fmtNum(tauN, 4), unit: 'samples', hint: fmtEng(tauN / fs, 's') },
    { label: 'Settle 63 / 95 / 99 %', value: `${Math.ceil(settle(0.632))} / ${Math.ceil(settle(0.95))} / ${Math.ceil(settle(0.99))}`,
      hint: `samples; 99 % in ${fmtEng(Math.ceil(settle(0.99)) / fs, 's')}` },
    { label: 'Noise variance ratio', value: fmtNum(nvr, 4), hint: `RMS noise × ${fmtNum(Math.sqrt(nvr), 3)} (white noise)` },
    { label: 'Nearest shift', value: `>> ${kNear}`, hint: `α = 1/${2 ** kNear}, −3 dB at ${f3db(aNear, fs) != null ? fmtEng(f3db(aNear, fs), 'Hz') : '–'}` },
    { label: 'Q15 α', value: String(q15), hint: `${fmtNum(q15 / 32768, 5)} after rounding` },
  ];

  // Magnitude: 64 log-spaced points from a decade below the corner to Nyquist.
  const corner = f3 ?? fRc ?? fs / 20;
  const lo = Math.min(corner / 20, fs / 2000), hi = fs / 2;
  const fx = Array.from({ length: 64 }, (_, i) => lo * (hi / lo) ** (i / 63));
  const mag = fx.map((f) => Number(magDb(a, f, fs).toFixed(3)));
  // Analog RC with the same -3 dB frequency, for comparison.
  const rc = fx.map((f) => Number((-10 * Math.log10(1 + (f / corner) ** 2)).toFixed(3)));
  const nMax = Math.min(2000, Math.max(8, Math.ceil(settle(0.995)) + 2));
  // Uniform stride: the kit plots points evenly, so the x values must be evenly spaced.
  const stride = Math.max(1, Math.ceil(nMax / 80));
  const idx = []; for (let n = 0; n <= nMax; n += stride) idx.push(n);
  const step = idx.map((n) => Number((1 - b ** (n + 1)).toFixed(5)));

  const code = [
    `// One-pole low-pass at fs = ${fmtEng(fs, 'Hz')}: -3 dB at ${f3 != null ? fmtEng(f3, 'Hz', 4) : '–'}, time constant ${fmtNum(tauN, 4)} samples`,
    `#define EMA_ALPHA  ${fmtNum(a, 7)}f`,
    'static float ema_y;',
    'static inline float ema_update(float x) { ema_y += EMA_ALPHA * (x - ema_y); return ema_y; }',
    '',
    `// Integer, shift form: alpha = 1/${2 ** kNear}. Keep ${kNear} extra fraction bits in the state or it stalls short of x.`,
    'static int32_t ema_acc;   /* = y << EMA_SHIFT */',
    `#define EMA_SHIFT  ${kNear}`,
    'static inline int32_t ema_update_i(int32_t x) { ema_acc += x - (ema_acc >> EMA_SHIFT); return ema_acc >> EMA_SHIFT; }',
    '',
    `// Q15 form: alpha = ${q15}/32768`,
    `#define EMA_ALPHA_Q15  ${q15}`,
    'static int32_t ema_q;     /* y in Q15 of the input units */',
    'static inline int16_t ema_update_q15(int16_t x) { ema_q += (EMA_ALPHA_Q15 * (((int32_t)x << 15) - ema_q)) >> 15; return (int16_t)(ema_q >> 15); }',
  ].join('\n');

  return {
    values,
    warnings,
    response: { alpha: a, f3db: f3, fs },
    charts: [
      { title: 'Magnitude response', type: 'line', x: fx.map((f) => Number(f.toPrecision(3))),
        series: [{ name: `EMA α = ${fmtNum(a, 4)}`, y: mag }, { name: 'Analog RC, same corner', y: rc }],
        xLabel: 'frequency (Hz, log-spaced)', yLabel: 'gain (dB)' },
      { title: 'Step response', type: 'line', x: idx, series: [{ name: 'output / step', y: step }], xLabel: 'samples', yLabel: 'fraction of the step' },
    ],
    tables: [{
      title: 'Shift filters at this sample rate',
      columns: ['Shift', 'α', '−3 dB', 'Time constant', '99 % settle'],
      rows: [1, 2, 3, 4, 5, 6, 7, 8, 10, 12].map((s) => {
        const al = 2 ** -s, be = 1 - al, f = f3db(al, fs), t = -1 / Math.log(be);
        return [`>> ${s}${s === kNear ? '  ←' : ''}`, `1/${2 ** s}`, f != null ? fmtEng(f, 'Hz') : '–', `${fmtNum(t, 3)} samp. (${fmtEng(t / fs, 's')})`, `${Math.ceil(Math.log(0.01) / Math.log(be))} samp.`];
      }),
    }],
    texts: [{ title: 'C code', body: code, lang: 'c' }],
    notes: [
      'The filter is y += α (x − y), run once per sample. Its phase lag near the corner is about 45°, like an RC.',
      'Near Nyquist the one-pole IIR levels off at α / (2 − α) while an analog RC keeps falling, so the two curves separate on the right.',
      'The integer shift form keeps y scaled by 2^k in the accumulator; without those fraction bits the output never quite reaches a small step.',
    ],
  };
}
