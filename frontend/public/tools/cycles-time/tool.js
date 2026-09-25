// Cycles and time at a clock.
//   t = N · CPC / fclk            N instruction cycles, CPC clocks per instruction cycle
//   N = t · fclk / CPC
//   delay-loop passes = N / (cycles per pass)
// Timers (clocked from fclk here): period = PSC · COUNT / fclk, reload register = COUNT - 1
// (STM32 PSC register = prescaler - 1, ARR = COUNT - 1; AVR prescalers 1/8/64/256/1024, OCR = COUNT - 1).
import { fmtEng, fmtNum } from '../kit/eng.js';

const AVR = [1, 8, 64, 256, 1024];
const CLOCKS = [1e6, 4e6, 8e6, 16e6, 48e6, 72e6, 168e6, 240e6, 480e6];

/** The prescaler and count a timer of `bits` needs for `ticks` input clocks. */
function timerFit(ticks, bits, pres) {
  const max = 2 ** bits;
  if (!(ticks >= 0.5)) return null;
  if (pres) {
    for (const p of pres) {
      const c = Math.round(ticks / p);
      if (c >= 1 && c <= max) return { p, c };
    }
    return null;
  }
  // Any prescaler 1 … 65536: start at the smallest that fits, search a little above it
  // for one that divides more exactly.
  const pmin = Math.max(1, Math.ceil(ticks / max - 1e-9));
  if (pmin > 65536) return null;
  let best = null;
  for (let p = pmin; p <= Math.min(65536, pmin + 4096); p++) {
    const c = Math.round(ticks / p);
    if (c < 1 || c > max) continue;
    const err = Math.abs(c * p - ticks);
    if (!best || err < best.err - 1e-9) best = { p, c, err };
    if (err < 1e-9) break;
  }
  return best;
}

export function run({ dir, fclk, cycles, time, cpc, loop }) {
  const warnings = [];
  if (!(fclk > 0)) return { warnings: ['Give the clock frequency in Hz, e.g. 16M.'] };
  let k = cpc;
  if (!(cpc > 0)) { k = 1; warnings.push('Clocks per instruction cycle must be above 0: 1 used.'); }
  let N, t;
  if (dir === 't2c') {
    if (!(time > 0)) return { warnings: [...warnings, 'Give the time in seconds, e.g. 10u.'] };
    t = time; N = (t * fclk) / k;
  } else {
    if (!(cycles >= 0)) return { warnings: [...warnings, 'Give a cycle count of 0 or more, e.g. 1000.'] };
    N = cycles; t = (N * k) / fclk;
  }
  if (fclk > 5e9) warnings.push(`${fmtEng(fclk, 'Hz')} is beyond any MCU clock: check the unit (16M = 16 MHz).`);
  if (fclk < 1e3) warnings.push(`${fmtEng(fclk, 'Hz')} is a very slow clock: check the unit (write 16M for 16 MHz).`);
  const tcyc = k / fclk;
  const whole = Math.ceil(N - 1e-9);
  if (dir === 't2c' && Math.abs(N - Math.round(N)) > 1e-6) warnings.push(`${fmtEng(t, 's')} is ${fmtNum(N, 6)} cycles, not a whole number: ${whole} cycles give ${fmtEng((whole * k) / fclk, 's', 5)}.`);
  let passes = null;
  if (loop > 0) passes = N / loop;
  else warnings.push('Cycles per delay-loop pass must be above 0 to get a loop count.');

  const values = dir === 't2c'
    ? [{ label: 'Instruction cycles', value: fmtNum(N, 7), tone: 'ok', hint: `${whole} whole` },
      { label: 'Clock cycles', value: fmtNum(N * k, 7) }]
    : [{ label: 'Time', value: fmtEng(t, 's', 5), tone: 'ok' },
      { label: 'Clock cycles', value: fmtNum(N * k, 7), hint: `${fmtNum(t * 1e6, 6)} µs` }];
  values.push(
    { label: 'Instruction cycle', value: fmtEng(tcyc, 's', 4), hint: `${fmtNum(k)} clock${k === 1 ? '' : 's'} at ${fmtEng(fclk, 'Hz')}` },
    { label: 'Instruction rate', value: fmtEng(fclk / k, 'IPS') , hint: 'if each instruction takes one cycle' },
    { label: 'Delay-loop passes', value: passes != null ? fmtNum(Math.round(passes), 7) : '–', hint: passes != null ? `${fmtNum(loop)} cycles each; ${fmtNum(passes, 6)} exact` : undefined },
  );
  if (passes != null && passes > 65535) warnings.push(`${fmtNum(Math.round(passes), 7)} loop passes do not fit a 16-bit counter: use a 32-bit counter, nest two loops or use a timer.`);
  if (passes != null && passes < 1 && N > 0) warnings.push(`The time is shorter than one loop pass: use ${fmtNum(Math.round(N))} NOPs instead.`);

  // Timers.
  const ticks = t * fclk;
  const kinds = [['8-bit, AVR prescalers', 8, AVR], ['16-bit, AVR prescalers', 16, AVR], ['16-bit, any prescaler (STM32 PSC)', 16, null], ['32-bit, any prescaler', 32, null]];
  const timers = [];
  const trows = kinds.map(([name, bits, pres]) => {
    const f = timerFit(ticks, bits, pres);
    if (!f) { timers.push({ name, bits, fit: null, why: ticks < 0.5 ? 'too short' : 'too long' }); return [name, '–', '–', ticks < 0.5 ? 'too short' : 'too long', '–']; }
    const act = (f.p * f.c) / fclk;
    const err = `${Math.abs(act - t) < 1e-9 * t ? '0' : fmtNum(((act - t) / t) * 100, 3)} %`;
    timers.push({ name, bits, fit: { prescaler: f.p, count: f.c, reload: f.c - 1, actual: act, error: err } });
    return [name, String(f.p), String(f.c - 1), fmtEng(act, 's', 5), err];
  });
  const crow = CLOCKS.map((c) => [fmtEng(c, 'Hz'), fmtEng((N * k) / c, 's', 4), fmtNum((t * c) / k, 6)]);
  return {
    // The numbers behind the values, for the page's drawing.
    timing: { dir: dir === 't2c' ? 't2c' : 'c2t', fclk, cpc: k, cycles: N, whole, time: t, tclk: 1 / fclk, tcyc, loop: loop > 0 ? loop : null, passes, timers,
      clocks: CLOCKS.map((c) => ({ fclk: c, time: (N * k) / c, cycles: (t * c) / k })) },
    values,
    warnings,
    tables: [
      { title: 'Timer settings for this time, timer clocked at the clock above', columns: ['Timer', 'Prescaler', 'Reload (count − 1)', 'Actual period', 'Error'], rows: trows },
      { title: 'At other clocks', columns: ['Clock', `${fmtNum(N, 6)} cycles take`, `Cycles in ${fmtEng(t, 's', 4)}`], rows: crow },
    ],
    notes: [
      'Cycle counts assume every instruction takes one instruction cycle; branches, multi-cycle instructions, flash wait states, caches and interrupts all add to it. Measure critical timing with a timer or a scope.',
      'For STM32 write PSC = prescaler − 1 and ARR = reload; the timer clock can be the APB clock ×2, not the core clock.',
    ],
  };
}
