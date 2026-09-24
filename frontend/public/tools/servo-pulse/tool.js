// RC servo: angle -> pulse width by the line through two calibration points,
//   pulse(a) = p1 + (a - a1) · (p2 - p1) / (a2 - a1)        (two-point linear calibration)
// then the timer:  period counts = f_timer / f_frame,  compare = pulse · f_timer,
//   duty = pulse · f_frame.                                  (PWM definitions)
import { fmtEng, fmtNum } from '../kit/eng.js';

export function run({ a1, p1, a2, p2, amin, amax, target, frame, tclk, step }) {
  const warnings = [];
  if ([a1, p1, a2, p2].some((v) => v == null)) return { warnings: ['Give both calibration points: angle in degrees and pulse width in µs.'] };
  if (a1 === a2) return { warnings: ['The two calibration angles are equal: measure the pulse at two different angles.'] };
  if (!(p1 > 0 && p2 > 0)) return { warnings: ['Calibration pulses must be positive, in µs (e.g. 1000 and 2000).'] };
  const k = (p2 - p1) / (a2 - a1);                     // µs per degree
  const pulse = (a) => p1 + (a - a1) * k;
  let lo = amin ?? Math.min(a1, a2), hi = amax ?? Math.max(a1, a2);
  if (lo > hi) { [lo, hi] = [hi, lo]; warnings.push('Allowed angle min is above max: they were swapped.'); }
  let t = target ?? (lo + hi) / 2;
  let clamped = false;
  if (t < lo || t > hi) { warnings.push(`Target ${fmtNum(t, 4)}° is outside the allowed ${fmtNum(lo, 4)}…${fmtNum(hi, 4)}°: clamped to ${fmtNum(t < lo ? lo : hi, 4)}°.`); t = t < lo ? lo : hi; clamped = true; }
  const pw = pulse(t);
  const pLo = pulse(lo), pHi = pulse(hi);
  const pmin = Math.min(pLo, pHi), pmax = Math.max(pLo, pHi);
  if (pmin < 500 || pmax > 2500) warnings.push(`The allowed range needs ${fmtNum(pmin, 4)}…${fmtNum(pmax, 4)} µs, beyond the usual 500…2500 µs: many servos hit their end stop and stall there. Narrow the allowed angles.`);
  if (Math.min(lo, hi) < Math.min(a1, a2) || Math.max(lo, hi) > Math.max(a1, a2)) warnings.push('The allowed range reaches past the calibration points: the line is extrapolated there; calibrate near the ends you use.');
  const values = [
    { label: 'Pulse width', value: fmtNum(pw, 5), unit: 'µs', tone: pw < 500 || pw > 2500 ? 'bad' : 'ok', hint: clamped ? `at ${fmtNum(t, 4)}° (clamped)` : `at ${fmtNum(t, 4)}°` },
    { label: 'Slope', value: fmtNum(k, 4), unit: 'µs/°' },
    { label: 'Pulse range used', value: `${fmtNum(pmin, 4)} – ${fmtNum(pmax, 4)}`, unit: 'µs' },
    { label: 'Centre of range', value: fmtNum(pulse((lo + hi) / 2), 5), unit: 'µs', hint: `${fmtNum((lo + hi) / 2, 4)}°` },
  ];
  const tables = [];
  const notes = ['Angles are measured the way you calibrated them; reverse the direction by swapping the two pulses.',
    'Most analog servos have a 2-8 µs dead band: steps smaller than that do not move the horn.'];
  if (frame > 0) {
    const period = 1e6 / frame;
    const duty = pw / period;
    values.push({ label: 'Frame period', value: fmtNum(period, 5), unit: 'µs' }, { label: 'Duty cycle', value: fmtNum(duty * 100, 4), unit: '%' });
    if (pmax > period * 0.9) warnings.push(`A ${fmtNum(pmax, 4)} µs pulse does not fit a ${fmtNum(period, 4)} µs frame with room for the gap: lower the frame rate.`);
    if (frame > 60) notes.push(`${fmtNum(frame, 4)} Hz is only for digital servos; an analog servo expects about 50 Hz and may overheat or jitter faster.`);
    if (tclk > 0) {
      const counts = tclk / frame;
      const cmp = Math.round(pw * 1e-6 * tclk);
      const tick = 1e6 / tclk;
      values.push(
        { label: 'Timer period (ARR + 1)', value: fmtNum(Math.round(counts), 8), hint: Number.isInteger(counts) ? `ARR = ${Math.round(counts) - 1}` : `not exact: ${fmtNum(counts, 6)} → frame ${fmtNum(tclk / Math.round(counts), 5)} Hz` },
        { label: 'Compare value (CCR)', value: fmtNum(cmp, 8), tone: 'ok' },
        { label: 'Angle per timer tick', value: fmtNum(tick / Math.abs(k), 3), unit: '°', hint: `1 tick = ${fmtEng(tick * 1e-6, 's')}` },
      );
      if (counts > 65536) warnings.push(`The period needs ${fmtNum(Math.round(counts), 8)} counts: too many for a 16-bit timer. Divide the timer clock by at least ${Math.ceil(counts / 65536)} more (e.g. ${fmtEng(tclk / Math.ceil(counts / 65536), 'Hz')}); 1 MHz is the usual choice.`);
      if (tick / Math.abs(k) > 1) warnings.push(`One timer tick moves the servo ${fmtNum(tick / Math.abs(k), 3)}°: raise the timer clock for finer steps.`);
      const n = Math.abs(hi - lo) / (step > 0 ? step : 15);
      const s = step > 0 && n <= 200 ? step : Math.max(1, Math.abs(hi - lo) / 12);
      const rows = [];
      for (let a = lo; a <= hi + 1e-9; a += s) rows.push([`${fmtNum(a, 4)}°`, fmtNum(pulse(a), 5), fmtNum(Math.round(pulse(a) * 1e-6 * tclk), 8), fmtNum(pulse(a) / period * 100, 4)]);
      if (rows.length && Math.abs(rows.at(-1)[0].replace('°', '') - hi) > 1e-6) rows.push([`${fmtNum(hi, 4)}°`, fmtNum(pulse(hi), 5), fmtNum(Math.round(pulse(hi) * 1e-6 * tclk), 8), fmtNum(pulse(hi) / period * 100, 4)]);
      tables.push({ title: 'Angle to pulse', columns: ['Angle', 'Pulse µs', 'Compare', 'Duty %'], rows });
      const c = `// servo: ${fmtNum(p1, 5)} us at ${fmtNum(a1, 4)} deg, ${fmtNum(p2, 5)} us at ${fmtNum(a2, 4)} deg; timer ${fmtEng(tclk, 'Hz')}, ${fmtNum(frame, 4)} Hz frame\n` +
        `#define SERVO_ARR       ${Math.round(counts) - 1}u\n#define SERVO_MIN_DEG   ${fmtNum(lo, 6)}f\n#define SERVO_MAX_DEG   ${fmtNum(hi, 6)}f\n\n` +
        `static inline uint32_t servo_ccr(float deg)\n{\n    if (deg < SERVO_MIN_DEG) deg = SERVO_MIN_DEG;\n    if (deg > SERVO_MAX_DEG) deg = SERVO_MAX_DEG;\n` +
        `    float us = ${fmtNum(p1, 6)}f + (deg - (${fmtNum(a1, 6)}f)) * ${fmtNum(k, 6)}f;\n    return (uint32_t)(us * ${fmtNum(tclk / 1e6, 6)}f + 0.5f);   /* timer ticks per µs */\n}\n`;
      return { values, warnings, tables, notes, texts: [{ title: 'C', body: c, lang: 'c' }] };
    }
  } else warnings.push('Give the frame rate in Hz (50 for most servos) to get the timer values.');
  return { values, warnings, tables, notes };
}
