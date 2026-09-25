// ADC resolution and oversampling.
//   LSB = FSR / 2^N                       FSR = Vref (unipolar) or 2 Vref (bipolar)   [ADI MT-001]
//   quantisation noise = LSB / sqrt(12)   (uniform error over one LSB)                 [ADI MT-001]
//   ideal SNR = 6.02 N + 1.76 dB          (full-scale sine against quantisation noise) [ADI MT-001]
//   ENOB = (SNR - 1.76) / 6.02, SNR of a full-scale sine against the total noise       [ADI MT-003]
//   noise-free resolution = log2(FSR / (6.6 * analog RMS noise))                         [ADI MT-229]
//   oversampling: summing OSR = 4^n samples and shifting right n adds n bits;
//   white noise falls by sqrt(OSR), SNR rises by 10 log10(OSR) dB      [SiLabs AN118, AVR121]
import { fmtEng, fmtNum } from '../kit/eng.js';

// Error function (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7), for the code
// probabilities the noise gives: P(code c) = Phi((c+1) LSB - vin) - Phi(c LSB - vin).
const erf = (x) => {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x < 0 ? -y : y;
};
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

const hex = (code, bits) => {
  const b = Math.max(1, Math.round(bits));
  const u = code < 0 ? BigInt(2) ** BigInt(b) + BigInt(code) : BigInt(code);
  return '0x' + u.toString(16).toUpperCase().padStart(Math.ceil(b / 4), '0');
};

export function run({ vref, bits, range, vin, noise, fs, osr }) {
  const warnings = [];
  if (!(vref > 0)) return { warnings: ['Give the reference voltage in volts, e.g. 3.3.'] };
  if (!(bits >= 1 && bits <= 32)) return { warnings: ['Give the ADC resolution as 1 to 32 bits, e.g. 12.'] };
  const N = Math.round(bits);
  if (N !== bits) warnings.push(`${bits} bits is not a whole number: ${N} bits used.`);
  const bip = range === 'bipolar';
  const fsr = bip ? 2 * vref : vref;
  const levels = 2 ** N;
  const lsb = fsr / levels;
  const qn = lsb / Math.sqrt(12);
  const sigma = noise > 0 ? noise : 0;
  if (noise != null && noise < 0) warnings.push('Noise cannot be negative: taken as 0.');
  const total = Math.sqrt(sigma ** 2 + qn ** 2);
  const snrIdeal = 6.02 * N + 1.76;
  // Full-scale sine RMS = FSR / (2 sqrt 2).
  const enobOf = (n) => (20 * Math.log10(fsr / (2 * Math.SQRT2) / n) - 1.76) / 6.02;
  const effBits = enobOf(total);
  const nfBits = sigma > 0 ? Math.min(N, Math.log2(fsr / (6.6 * sigma))) : N;

  // The code for vin: straight binary (unipolar) or two's complement (bipolar),
  // truncating (floor) as most SAR ADCs do; clipped at the ends of the range.
  let code = '–', codeHex = '–', clipped = false, vq = null;
  const lo = bip ? -(levels / 2) : 0, hi = bip ? levels / 2 - 1 : levels - 1;
  if (vin != null) {
    let c = Math.floor(vin / lsb);
    if (c < lo || c > hi) { clipped = true; c = Math.min(hi, Math.max(lo, c)); }
    code = String(c); codeHex = hex(c, N); vq = c * lsb;
    if (clipped) warnings.push(`${fmtEng(vin, 'V')} is outside the ${bip ? `±${fmtEng(vref, 'V')}` : `0 … ${fmtEng(vref, 'V')}`} range: the ADC clips at code ${code}. Scale the input down or raise the reference.`);
  }

  // Oversampling.
  let R = osr > 0 ? osr : 1;
  if (!(osr >= 1)) warnings.push('The oversampling ratio must be 1 or more: 1 used.');
  if (R < 1) R = 1;
  const extra = 0.5 * Math.log2(R);            // n = log4(OSR)
  const whole = Math.floor(extra + 1e-9);
  if (R > 1 && Math.abs(extra - whole) > 1e-9) warnings.push(`${fmtNum(R)}× is not a power of 4: it adds ${fmtNum(extra, 3)} bits; a right shift gives ${whole}. Use 4, 16, 64 or 256.`);
  const outBits = N + whole;
  const outLsb = fsr / 2 ** outBits;
  const outRate = fs > 0 ? fs / R : null;
  const ditherLsb = sigma / lsb;
  // Without dither every sample returns the same code: averaging gains nothing.
  const dithered = ditherLsb >= 0.3;
  const totalOs = dithered ? total / Math.sqrt(R) : total;
  const snrOs = dithered ? snrIdeal + 10 * Math.log10(R) : snrIdeal;
  if (R > 1 && ditherLsb < 0.3) {
    warnings.push(`The input noise is only ${fmtNum(ditherLsb, 2)} LSB RMS: without about 0.5 LSB of noise every sample gives the same code and oversampling adds no resolution. Add dither (noise or a small triangle) or rely on fewer extra bits.`);
  }
  if (sigma > 4 * lsb) warnings.push(`The input noise (${fmtNum(ditherLsb, 3)} LSB RMS) swamps the LSB: the last ${fmtNum(Math.log2(sigma / lsb * Math.sqrt(12)), 2)} bits are noise. Filter the input or oversample.`);
  if (!(fs > 0)) warnings.push('Give the sample rate in Hz to see the output rate after oversampling.');

  const values = [
    { label: 'LSB size', value: fmtEng(lsb, 'V'), tone: 'ok', hint: `${fmtEng(fsr, 'V')} / 2^${N}` },
    { label: 'Levels', value: levels.toLocaleString('en-US'), hint: bip ? 'two\'s complement' : 'straight binary' },
    { label: 'Code for input', value: code, hint: `${codeHex}${vq != null ? `, reads back ${fmtEng(vq, 'V', 5)}` : ''}`, tone: clipped ? 'bad' : undefined },
    { label: 'Quantisation noise', value: fmtEng(qn, 'V'), hint: 'RMS, LSB / √12' },
    { label: 'Ideal SNR', value: fmtNum(snrIdeal, 4), unit: 'dB', hint: '6.02 N + 1.76' },
    { label: 'ENOB', value: fmtNum(effBits, 3), unit: 'bits', hint: `with ${fmtEng(sigma, 'V')} RMS noise + quantisation` },
    { label: 'Noise-free resolution', value: fmtNum(nfBits, 3), unit: 'bits', hint: 'no code flicker; p-p = 6.6 × RMS' },
  ];
  if (R > 1) {
    values.push(
      { label: 'Bits after oversampling', value: String(outBits), unit: 'bits', tone: ditherLsb >= 0.3 ? 'ok' : 'warn', hint: `+${fmtNum(extra, 3)} from ${fmtNum(R)}×` },
      { label: 'LSB after oversampling', value: fmtEng(outLsb, 'V') },
      { label: 'Output rate', value: outRate ? fmtEng(outRate, 'Hz') : '–', hint: 'sample rate / OSR' },
      { label: 'SNR after oversampling', value: fmtNum(snrOs, 4), unit: 'dB', hint: dithered ? 'white noise only' : 'no gain without dither' },
      { label: 'ENOB after oversampling', value: fmtNum(enobOf(totalOs), 3), unit: 'bits', hint: 'noise / √OSR' },
    );
  }

  // Which codes a single conversion returns with this noise (floor quantiser,
  // clipped at the ends), when the spread is narrow enough to list.
  let hist = null;
  if (vin != null) {
    if (!(sigma > 0)) hist = [{ code: Number(code), p: 1 }];
    else {
      const c0 = Math.floor((vin - 4.5 * sigma) / lsb), c1 = Math.floor((vin + 4.5 * sigma) / lsb);
      if (c1 - c0 <= 160) {
        const m = new Map();
        for (let c = c0; c <= c1; c++) {
          const p = Phi(((c + 1) * lsb - vin) / sigma) - Phi((c * lsb - vin) / sigma);
          const k = Math.min(hi, Math.max(lo, c));
          m.set(k, (m.get(k) || 0) + p);
        }
        hist = [...m].map(([c, p]) => ({ code: c, p })).filter((e) => e.p >= 5e-4);
      }
    }
  }

  const rows = [8, 10, 12, 14, 16, 18, 20, 24].map((b) => {
    const l = fsr / 2 ** b;
    return [`${b}`, fmtEng(l, 'V'), (2 ** b).toLocaleString('en-US'), fmtNum(6.02 * b + 1.76, 4) + ' dB', b === N ? '← this ADC' : ''];
  });
  const osRows = [1, 4, 16, 64, 256, 1024].map((r) => [
    `${r}×`, `+${fmtNum(0.5 * Math.log2(r), 2)}`, `${N + Math.floor(0.5 * Math.log2(r))}`,
    fmtEng(fsr / 2 ** (N + Math.floor(0.5 * Math.log2(r))), 'V'), fs > 0 ? fmtEng(fs / r, 'Hz') : '–']);

  return {
    values,
    warnings,
    // The same numbers for a drawing (the page draws the staircase from these).
    adc: {
      N, bip, vref, fsr, lsb, levels, lo, hi, vin: vin ?? null, code: vin != null ? Number(code) : null, codeHex, vq, clipped,
      sigma, qn, ditherLsb, ppLsb: (6.6 * sigma) / lsb, nfBits, effBits, snrIdeal, hist,
      R, extra, whole, outBits, outLsb, fs: fs > 0 ? fs : null, outRate, dithered, snrOs, enobOs: enobOf(totalOs),
    },
    tables: [
      { title: 'The same span at other resolutions', columns: ['Bits', 'LSB', 'Levels', 'Ideal SNR', ''], rows },
      { title: 'Oversampling: what each ratio buys', columns: ['OSR', 'Extra bits', 'Result bits', 'LSB', 'Output rate'], rows: osRows },
    ],
    notes: [
      'LSB = full-scale span / 2^N. Some datasheets divide by 2^N − 1; the difference is under one LSB at full scale.',
      'The code assumes truncation (floor); ADCs with a ½-LSB offset round instead. Gain and offset errors, INL and DNL are not included.',
      'Oversampling helps only against white noise with enough dither; it does nothing for offset, gain or INL errors, and it lowers the output rate by the OSR.',
    ],
  };
}
