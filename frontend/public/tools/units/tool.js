// Units & Numbers, ported from the app's Angular calculator (src/app/tools/units/units.ts)
// so an agent gets the same answers: lengths, number bases, a UART's divider and a
// timer's prescaler. One section at a time, chosen by `mode`.
import { fmtEng, fmtNum } from '../kit/eng.js';

// 1 mil = 0.001 in = 0.0254 mm (exact, by the 1959 inch).
const LENGTH = [
  { k: 'mm', label: 'mm', per: 1 },
  { k: 'mil', label: 'mil (thou)', per: 0.0254 },
  { k: 'in', label: 'inch', per: 25.4 },
  { k: 'um', label: 'µm', per: 0.001 },
];

const BASES = [
  { k: 'dec', label: 'Decimal', radix: 10 },
  { k: 'hex', label: 'Hex', radix: 16 },
  { k: 'bin', label: 'Binary', radix: 2 },
  { k: 'oct', label: 'Octal', radix: 8 },
];

function length({ len_value: v, len_unit }) {
  const u = LENGTH.find((x) => x.k === len_unit) || LENGTH[0];
  if (v == null) return { warnings: ['Give a length, e.g. 1.6 (mm) or 62 (mil).'] };
  const mm = v * u.per;
  return {
    values: LENGTH.map((x) => ({ label: x.label, value: fmtNum(mm / x.per, 6), tone: x.k === u.k ? 'ok' : undefined,
      hint: x.k === u.k ? 'as given' : undefined })),
    notes: ['1 inch = 25.4 mm exactly; 1 mil (thou) = 0.001 inch = 25.4 µm.'],
  };
}

function bases({ num_text, num_base, width }) {
  const w = [8, 16, 32, 64].includes(Number(width)) ? Number(width) : 32;
  const k = BASES.some((b) => b.k === num_base) ? num_base : 'hex';
  const mask = (1n << BigInt(w)) - 1n;
  // What was typed, as an unbounded integer; a 0x/0b/0o prefix, _ and spaces are allowed.
  let t = String(num_text ?? '').trim().replace(/[_\s]/g, '').toLowerCase();
  const neg = t.startsWith('-');
  if (neg) t = t.slice(1);
  t = t.replace(/^(0x|0b|0o)/, '');
  const digits = { dec: /^\d+$/, hex: /^[0-9a-f]+$/, bin: /^[01]+$/, oct: /^[0-7]+$/ }[k];
  const name = BASES.find((b) => b.k === k).label.toLowerCase();
  if (!t || !digits.test(t)) {
    return { warnings: [`"${num_text ?? ''}" is not a ${name} number. Use only ${name} digits (an optional - sign and 0x/0b/0o prefix are fine), or change the base it is written in.`] };
  }
  const raw = BigInt({ dec: '', hex: '0x', bin: '0b', oct: '0o' }[k] + t) * (neg ? -1n : 1n);
  // Held as the unsigned pattern of `width` bits: a negative number is its two's complement.
  const v = raw & mask;
  const half = 1n << BigInt(w - 1);
  const overflow = raw < 0n ? raw < -half : raw > mask;
  const text = (b) => {
    const s = v.toString(b.radix).toUpperCase();
    // Binary in nibbles, so a register reads at a glance.
    return b.k === 'bin' ? s.replace(/\B(?=(\d{4})+(?!\d))/g, ' ') : s;
  };
  const bin = v.toString(2);
  return {
    values: [
      ...BASES.map((b) => ({ label: b.label, value: text(b), tone: b.k === k ? 'ok' : undefined, hint: b.k === k ? 'as given' : undefined })),
      { label: `Signed ${w}-bit`, value: String(v >= half ? v - (mask + 1n) : v) },
      { label: 'Bits set', value: [...bin].filter((c) => c === '1').length },
      { label: 'Highest bit', value: v ? String(bin.length - 1) : '–', hint: 'bit 0 is the least significant' },
    ],
    warnings: overflow ? [`Does not fit in ${w} bits; shown cut to its low ${w} bits. Choose a wider word if you need all of it.`] : [],
    notes: [`Negative decimals are shown as their two's complement in ${w} bits.`],
  };
}

function uart({ uart_clk: clk, baud: b }) {
  // STM32 USART with 16x oversampling: USARTDIV = fCK / (16 * baud), and BRR holds it in
  // sixteenths, so BRR = fCK / baud, rounded (STM32 reference manuals, "USART baud rate generation").
  if (!clk || !b || b <= 0 || clk < b) {
    return { warnings: ['Give a peripheral clock above the baud rate, and a baud rate above 0 (e.g. 80M and 115200).'] };
  }
  const brr = Math.round(clk / b);
  const actual = clk / brr;
  const err = 100 * Math.abs(actual - b) / b;
  const warnings = [];
  if (err > 2) warnings.push(`The baud rate is ${fmtNum(err, 2)} % off: over 2 % the link may drop bytes. Choose a clock that divides better or a lower baud rate.`);
  return {
    values: [
      { label: 'BRR', value: brr, hint: `0x${brr.toString(16).toUpperCase()}` },
      { label: 'Actual baud', value: fmtNum(actual, 6) },
      { label: 'Error', value: fmtNum(err, 2), unit: '%', tone: err > 2 ? 'bad' : err > 1 ? 'warn' : 'ok', hint: 'under 2 % is safe for most links' },
    ],
    warnings,
    notes: ['STM32 USART (16x oversampling, BRR = clock / baud) and ESP32 (80 MHz APB, a divider in sixteenths).'],
  };
}

function timer({ tim_clk: clk, tim_f: f, arr_bits }) {
  // f = clock / ((PSC + 1) * (ARR + 1)): STM32 timers count 0..ARR at clock / (PSC + 1) (reference manual, timer time base).
  if (!clk || !f || f <= 0 || f > clk) {
    return { warnings: ['Give a timer clock and a target frequency above 0 and not above the clock (e.g. 72M and 1k).'] };
  }
  const bits = String(arr_bits) === '32' ? 32 : 16;
  const maxArr = bits === 32 ? 2 ** 32 - 1 : 65535;
  const total = clk / f;
  let best = null;
  // The smallest prescaler whose counter still fits gives the finest
  // steps; past an exact hit nothing does better.
  for (let psc = 0; psc <= 65535; psc++) {
    const arr = Math.round(total / (psc + 1)) - 1;
    if (arr > maxArr) continue;
    if (arr < 0) break;
    const got = clk / ((psc + 1) * (arr + 1));
    const err = 100 * Math.abs(got - f) / f;
    if (!best || err < best.err - 1e-12) best = { psc, arr, f: got, err };
    if (err === 0) break;
  }
  if (!best) {
    return { warnings: [`Out of reach: ${fmtEng(f, 'Hz')} is too slow for a 16-bit prescaler and a ${bits}-bit counter at ${fmtEng(clk, 'Hz')}. Use a 32-bit timer or a slower timer clock.`] };
  }
  const warnings = [];
  if (best.err > 1) warnings.push(`The nearest frequency is ${fmtNum(best.err, 2)} % off the target: choose a timer clock the target divides into, or accept the error.`);
  if (best.arr < 10) warnings.push(`Only ${best.arr + 1} steps per period: a PWM duty can be set only that coarsely. Raise the timer clock or lower the frequency for finer steps.`);
  return {
    values: [
      { label: 'PSC', value: best.psc },
      { label: 'ARR', value: best.arr },
      { label: 'Actual', value: fmtEng(best.f, 'Hz', 6), hint: `period ${fmtEng(1 / best.f, 's', 4)}` },
      { label: 'Error', value: fmtNum(best.err, 2), unit: '%', tone: best.err > 1 ? 'warn' : 'ok' },
      { label: 'Steps per period', value: best.arr + 1, hint: 'the PWM duty resolution' },
    ],
    warnings,
    notes: ['f = clock / ((PSC + 1) × (ARR + 1)); the pair nearest the target, with the smallest prescaler (finest step).'],
  };
}

export function run(input) {
  switch (input.mode) {
    case 'bases': return bases(input);
    case 'uart': return uart(input);
    case 'timer': return timer(input);
    default: return length(input);
  }
}
