// Units & Numbers: every engineering unit, and the embedded helpers.
//   convert  free text ("25 psi to bar", "3.3 mils", "2000 mAh @ 3.7 V to Wh",
//            "Δ10 °C in °F") -> the quantity it belongs to and the value in
//            every unit of it, with the related figures (period, wire gauge,
//            volts into 50 Ω ...). Unit table and sources: table.js.
//   length   the first calculator's mm / mil / inch / µm (kept as it was)
//   bases    an integer in decimal, hex, binary and octal, two's complement
//   uart     an STM32/ESP32 UART divider and its baud error
//   timer    an STM32 timer's PSC and ARR for a frequency
// The page's drawings read `view` (left out for agents: manifest agentOmit).
import { fmtEng, fmtNum } from '../kit/eng.js';
import { QUANTITIES, BY_ID, PREFIXES, SYSTEMS, awgDiameterMm, C0, CMIL, MIL } from './table.js';

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

// ---------------- the first calculator's modes, unchanged ----------------
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

function bases0({ num_text, num_base, width }) {
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

function uart0({ uart_clk: clk, baud: b }) {
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

function timer0({ tim_clk: clk, tim_f: f, arr_bits }) {
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


// ---------------- the embedded modes, with what the page draws ----------------
function parseInt0({ num_text, num_base, width }) {
  const w = [8, 16, 32, 64].includes(Number(width)) ? Number(width) : 32;
  const k = BASES.some((b) => b.k === num_base) ? num_base : 'hex';
  let t = String(num_text ?? '').trim().replace(/[_\s]/g, '').toLowerCase();
  const neg = t.startsWith('-');
  if (neg) t = t.slice(1);
  t = t.replace(/^(0x|0b|0o)/, '');
  const digits = { dec: /^\d+$/, hex: /^[0-9a-f]+$/, bin: /^[01]+$/, oct: /^[0-7]+$/ }[k];
  if (!t || !digits.test(t)) return null;
  const raw = BigInt({ dec: '', hex: '0x', bin: '0b', oct: '0o' }[k] + t) * (neg ? -1n : 1n);
  return { w, k, neg, raw, v: raw & ((1n << BigInt(w)) - 1n) };
}

/** The bit pattern, its bytes both ways and the IEEE-754 reading, for the bit grid. */
function basesView(input) {
  const p = parseInt0(input);
  if (!p) return undefined;
  const { w, v, k, neg } = p;
  const half = 1n << BigInt(w - 1);
  const signed = v >= half ? v - (1n << BigInt(w)) : v;
  const hex = v.toString(16).toUpperCase().padStart(w / 4, '0');
  const bytes = hex.match(/../g);
  const view = {
    kind: 'bases', width: w, base: k, neg,
    bits: v.toString(2).padStart(w, '0'),
    hex, unsigned: v.toString(), signed: signed.toString(),
    bytesBE: bytes, bytesLE: [...bytes].reverse(),
    c: { dec: `${signed < 0n ? signed : v}`, hex: `0x${hex}`, bin: `0b${v.toString(2).padStart(w, '0')}` },
  };
  // The same bits read as a float, where the width is one.
  if (w >= 16) {
    const dv = new DataView(new ArrayBuffer(8));
    let f;
    if (w === 64) { dv.setBigUint64(0, v); f = dv.getFloat64(0); }
    else if (w === 32) { dv.setUint32(0, Number(v)); f = dv.getFloat32(0); }
    else {
      const n = Number(v), e = (n >> 10) & 31, m = n & 1023, s = n >> 15 ? -1 : 1;
      f = e === 0 ? s * 2 ** -14 * (m / 1024) : e === 31 ? (m ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + m / 1024);
    }
    view.float = { name: `float${w}`, s: Number.isNaN(f) ? 'NaN' : fmt(f, w === 16 ? 5 : w === 32 ? 9 : 17, 'auto').s };
  }
  return view;
}

function bases(input) {
  const r = bases0(input);
  const view = basesView(input);
  if (view) r.view = view;
  return r;
}

const STD_BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000, 3000000, 4000000];

function uart(input) {
  const r = uart0(input);
  const clk = input.uart_clk, b = input.baud;
  if (!clk || !b || b <= 0 || clk < b) return r;
  // The standard rates at this clock. With 16x oversampling BRR must be 16 or more.
  const list = [...new Set([...STD_BAUDS, Math.round(b)])].sort((x, y) => x - y).map((baud) => {
    const reach = clk / baud >= 16;
    const brr = Math.round(clk / baud);
    const err = reach ? (100 * Math.abs(clk / brr - baud)) / baud : null;
    return { baud, s: fmtNum(baud, 7), reach, brr: reach ? brr : null, err, e: err == null ? '–' : `${fmtNum(err, 2)} %`, mine: baud === Math.round(b) };
  });
  r.view = { kind: 'uart', list, limit: 2, clock: fmtEng(clk, 'Hz', 4) };
  return r;
}

function timer(input) {
  const r = timer0(input);
  const clk = input.tim_clk, f = input.tim_f;
  if (!clk || !f || f <= 0 || f > clk || !r.values) return r;
  const bits = String(input.arr_bits) === '32' ? 32 : 16;
  const maxArr = bits === 32 ? 2 ** 32 - 1 : 65535;
  const total = clk / f;
  const lo = Math.max(0, Math.ceil(total / (maxArr + 1)) - 1);
  const hi = Math.min(65535, Math.max(lo, Math.floor(total) - 1));
  const pt = (psc) => {
    const arr = Math.min(maxArr, Math.max(0, Math.round(total / (psc + 1)) - 1));
    const got = clk / ((psc + 1) * (arr + 1));
    const err = (100 * Math.abs(got - f)) / f;
    return { psc, arr, steps: arr + 1, err, e: `${fmtNum(err, 2)} %`, f: fmtEng(got, 'Hz', 6) };
  };
  // A curve across every prescaler that works, spaced evenly on a log scale.
  const curve = [];
  const n = Math.min(72, hi - lo + 1);
  for (let i = 0; i < n; i++) {
    const psc = Math.round(Math.exp(Math.log(lo + 1) + ((Math.log(hi + 1) - Math.log(lo + 1)) * i) / Math.max(1, n - 1))) - 1;
    if (!curve.length || curve[curve.length - 1].psc !== psc) curve.push(pt(psc));
  }
  // The pairs that hit the target exactly, the finest (most steps) first.
  const exact = [];
  for (let psc = lo; psc <= hi && exact.length < 400; psc++) {
    const c = total / (psc + 1);
    if (Math.abs(c - Math.round(c)) < 1e-9 * c && Math.round(c) - 1 <= maxArr && Math.round(c) >= 1) exact.push(pt(psc));
  }
  const best = r.values[0].value;
  r.view = { kind: 'timer', bits, lo, hi, curve, exact: exact.slice(0, 12), exactCount: exact.length, best: pt(best) };
  return r;
}

// ---------------- numbers, the way they are shown ----------------
const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const sup = (n) => String(n).replace(/./g, (ch) => SUP[ch] ?? ch);
const group = (str) => str.replace(/^(\d+)/, (i) => (i.length > 4 ? i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : i));

/**
 * v to `digits` significant figures: s to show (grouped, ×10ⁿ, a real minus),
 * c to copy (plain ASCII that any program reads back).
 * notation: auto (plain from 1e-4 to 1e9), eng (exponents in threes), sci, plain.
 */
export function fmt(v, digits = 6, notation = 'auto') {
  if (v == null || Number.isNaN(v)) return { s: '–', c: '' };
  if (v === Infinity) return { s: '∞', c: 'Infinity' };
  if (v === -Infinity) return { s: '−∞', c: '-Infinity' };
  if (v === 0) return { s: '0', c: '0' };
  const neg = v < 0;
  const [m, e] = Math.abs(v).toExponential(Math.min(14, Math.max(1, digits) - 1)).split('e');
  const D = m.replace('.', '').replace(/0+$/, '') || '0';
  const E = Number(e);
  const minus = neg ? '−' : '', sign = neg ? '-' : '';
  const at = (n) => { const d = D.padEnd(n, '0'); return d.slice(0, n) + (d.length > n ? `.${d.slice(n)}` : ''); };
  const sci = (mant, ex) => ({ s: `${minus}${mant}×10${sup(ex)}`, c: `${sign}${mant}e${ex}` });
  let mode = notation;
  if (mode === 'auto') mode = E >= -4 && E < 9 ? 'plain' : 'sci';
  if (mode === 'eng') {
    const e3 = Math.floor(E / 3) * 3;
    if (e3 !== 0) return sci(at(E - e3 + 1), e3);
    mode = 'plain';
  }
  if (mode === 'plain' && E <= 21 && E >= -21) {
    const str = E >= 0 ? at(E + 1) : `0.${'0'.repeat(-E - 1)}${D}`;
    return { s: minus + group(str), c: sign + str };
  }
  return sci(at(1), E);
}

const STEPS = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];
/** 0.000333 s -> "333.333 µs": a figure with its own prefix, for the related values. */
function withPrefix(v, unit, digits) {
  if (!Number.isFinite(v)) return { s: '–', c: '' };
  const a = Math.abs(v);
  const [k, p] = a === 0 ? [1, ''] : STEPS.find(([x]) => a >= x * 0.9999995) || STEPS[STEPS.length - 1];
  const f = fmt(v / k, digits, 'plain');
  return { s: `${f.s} ${p}${unit}`, c: `${f.c} ${p}${unit}` };
}

// ---------------- reading units ----------------
const norm = (s) => String(s)
  .replace(/Ω/g, 'Ω').replace(/μ/g, 'µ').replace(/[⋅•∙*]/g, '·')
  .replace(/\^2|(?<=[a-zA-Zµ])2(?![\d])/g, '²').replace(/\^3|(?<=[a-zA-Zµ])3(?![\d])/g, '³')
  .replace(/º/g, '°').replace(/\s+/g, ' ').trim();
const squash = (s) => s.replace(/ /g, '');

const EXACT = new Map(), LOWER = new Map(), PREFIXABLE = new Map();
function addKey(map, key, entry) {
  if (!key) return;
  const list = map.get(key) || [];
  if (!list.some((x) => x.u === entry.u)) list.push(entry);
  map.set(key, list);
}
for (const q of QUANTITIES) {
  for (const u of q.units) {
    const keys = [[u.sym, !!u.lo], ...u.aliases.map((a) => (a.startsWith('~') ? [a.slice(1), true] : [a, false]))];
    for (const [a, weak] of keys) {
      const n = norm(a);
      for (const k of new Set([n, squash(n)])) {
        addKey(EXACT, k, { u, weak });
        addKey(LOWER, k.toLowerCase(), { u, weak: true });
      }
    }
    if (u.pre && u.f != null) for (const a of new Set([u.sym, ...u.aliases.filter((x) => /^[a-zA-ZΩ]+$/.test(x) && x.length > 2 && x === x.toLowerCase())])) PREFIXABLE.set(a, u);
  }
}
const ORDER = new Map(QUANTITIES.map((q, i) => [q.id, i]));
const rank = (list) => [...list].sort((a, b) => (a.weak - b.weak) || (ORDER.get(a.u.q) - ORDER.get(b.u.q)));

/** Every unit a piece of text can be, the likeliest first. */
function lookup(text) {
  const n = norm(text).replace(/\.$/, '');
  if (!n) return [];
  const tries = [n, squash(n)];
  for (const t of tries) if (EXACT.has(t)) return rank(EXACT.get(t));
  for (const t of tries) if (LOWER.has(t.toLowerCase())) return rank(LOWER.get(t.toLowerCase()));
  // plurals: mils, inches, volts
  for (const t of tries) {
    for (const cut of [/s$/, /es$/]) {
      if (!cut.test(t) || t.length < 3) continue;
      const s = t.replace(cut, '');
      if (EXACT.has(s)) return rank(EXACT.get(s));
      if (LOWER.has(s.toLowerCase())) return rank(LOWER.get(s.toLowerCase()));
    }
  }
  // An SI prefix on a unit that takes one: kbar, µWh, GΩ, kohm.
  const out = [];
  for (const [p, mult, pname] of [...PREFIXES].sort((a, b) => b[0].length - a[0].length)) {
    for (const t of tries) {
      if (!t.startsWith(p)) continue;
      const base = PREFIXABLE.get(t.slice(p.length)) || PREFIXABLE.get(t.slice(p.length).toLowerCase());
      if (!base) continue;
      const pow = /²$/.test(base.sym) ? 2 : /³$/.test(base.sym) ? 3 : 1;
      const sym = (p === 'u' || p === 'μ' ? 'µ' : p) + base.sym;
      const q = BY_ID.get(base.q);
      const known = q.bySym.get(sym);
      out.push({ u: known || { q: base.q, sym, name: `${pname}${base.name.replace(/ \(.*\)$/, '')}`, sys: base.sys, f: base.f * mult ** pow, gen: true, aliases: [] }, weak: false });
    }
    if (out.length) return rank(out);
  }
  return [];
}

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
function suggest(text) {
  const t = norm(text).toLowerCase();
  if (t.length < 2) return [];
  const seen = new Map();
  for (const [k, list] of LOWER) {
    const dist = lev(t, k);
    if (dist <= (t.length > 4 ? 2 : 1)) for (const { u } of list) if (!seen.has(u.sym + u.q) || seen.get(u.sym + u.q).dist > dist) seen.set(u.sym + u.q, { u, dist });
  }
  return [...seen.values()].sort((a, b) => a.dist - b.dist).slice(0, 4).map(({ u }) => `${u.sym} (${BY_ID.get(u.q).name.toLowerCase()})`);
}

// ---------------- reading an amount ----------------
const MID = { R: 1, r: 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, m: 1e-3, u: 1e-6, 'µ': 1e-6, n: 1e-9, p: 1e-12 };
const LONE = { k: 1e3, K: 1e3, M: 1e6, G: 1e9, m: 1e-3, u: 1e-6, 'µ': 1e-6, n: 1e-9, p: 1e-12 };

/** "25 psi", "1,5 mm", "3 1/2 in", "4k7", "1.2e-3", "2×10^6 Hz" -> {v, rest, implied?}. */
function amount(text) {
  let t = text.trim().replace(/[−–]/g, '-');
  // mixed and plain fractions: 3 1/2 in, 1/4"
  let m = /^([-+]?)(\d+)\s+(\d+)\/(\d+)(?![\d/])\s*(.*)$/.exec(t);
  if (m && +m[4]) return { v: (m[1] === '-' ? -1 : 1) * (+m[2] + m[3] / m[4]), rest: m[5] };
  m = /^([-+]?\d+)\/(\d+)(?![\d/])\s*(.*)$/.exec(t);
  if (m && +m[2]) return { v: m[1] / m[2], rest: m[3] };
  // The resistor / capacitor way: 4k7, 4R7, R47, 2n2, 4u7
  m = /^([-+]?\d*)([RrkKMGmunpµ])(\d+)\b\s*(.*)$/.exec(t);
  if (m && (m[1] || /[Rr]/.test(m[2]))) {
    const v = Number(`${m[1] || '0'}.${m[3]}`) * MID[m[2]];
    const implied = m[4] ? undefined : /[RrkKMG]/.test(m[2]) ? 'Ω' : /[unpµ]/.test(m[2]) ? 'F' : undefined;
    return { v, rest: m[4], implied };
  }
  // thousands separators (1,000.5) or a decimal comma (1,5)
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?(?!\d)/.test(t)) t = t.replace(/,(?=\d{3})/g, '');
  else t = t.replace(/^([-+]?\d+),(\d+)/, '$1.$2');
  m = /^([-+]?(?:\d+\.?\d*|\.\d+))(?:[eE]([-+]?\d+)|\s*[x×·]\s*10\s*\^?\s*([-+]?\d+))?\s*(.*)$/.exec(t);
  if (!m) return null;
  const v = Number(m[1]) * 10 ** Number(m[2] ?? m[3] ?? 0);
  return Number.isFinite(v) ? { v, rest: m[4] } : null;
}

const CTX_DEFAULT = { volts: 3.7, ohms: 50, dpi: 96 };
const BASE_WORD = { hex: 'hex', hexadecimal: 'hex', bin: 'bin', binary: 'bin', dec: 'dec', decimal: 'dec', oct: 'oct', octal: 'oct' };

/** Split "a to b": the first place where both sides read. */
function splitTarget(q, tryLeft) {
  const re = /(?<=\s)(?:to|in|into|as)(?=\s)|->|→|=>|⇒|=/gi;
  for (const m of q.matchAll(re)) {
    const left = q.slice(0, m.index).trim(), right = q.slice(m.index + m[0].length).trim();
    if (left && right && tryLeft(left, right)) return [left, right];
  }
  return [q, ''];
}

/** An integer written for a register: 0x3F, 0b1010, 0o17, "255 in hex", "hex FF". */
function literal(src, dst) {
  const s = src.replace(/[\s_]/g, '');
  let m = /^([-+]?)(0x[0-9a-f]+|0b[01]+|0o[0-7]+)$/i.exec(s);
  if (m) return { num_text: m[1] === '-' ? `-${m[2]}` : m[2], num_base: { x: 'hex', b: 'bin', o: 'oct' }[m[2][1].toLowerCase()] };
  m = /^(hex|bin|oct|dec)([-+]?[0-9a-f]+)$/i.exec(s);
  if (m) return { num_text: m[2], num_base: m[1].toLowerCase() };
  if (dst && BASE_WORD[dst.toLowerCase()] && /^[-+]?\d+$/.test(s)) return { num_text: s, num_base: 'dec' };
  return null;
}

/** The whole question: what was given, in what, and into what. */
function read(qText, input) {
  const warnings = [], notes = [];
  const ctx = { ...CTX_DEFAULT };
  for (const k of Object.keys(ctx)) if (Number.isFinite(input[k]) && input[k] > 0) ctx[k] = input[k];
  let q = String(qText ?? '').trim().replace(/[−–]/g, '-');
  // A setting inside the question: "@ 3.7 V", "at 50 ohm", "@ 300 dpi".
  q = q.replace(/\s*(?:@|\bat\b)\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*([kmµu]?)\s*(V|volts?|Ω|ohms?|dpi|ppi)\b/gi, (_, n, p, u) => {
    const v = Number(n) * ({ k: 1e3, m: 1e-3, µ: 1e-6, u: 1e-6 }[p] || 1);
    const key = /^v/i.test(u) ? 'volts' : /^(Ω|ohm)/i.test(u) ? 'ohms' : 'dpi';
    if (v > 0) ctx[key] = v;
    ctx.set = { ...(ctx.set || {}), [key]: v };
    return ' ';
  }).trim();
  if (!q) return { empty: true, warnings, notes, ctx };

  // A difference of temperature: Δ10 °C, delta 5 K, 10 °C rise.
  let diff = false;
  q = q.replace(/^(?:Δ|∆|delta\s*|dT\s*=?\s*)/i, () => { diff = true; return ''; })
    .replace(/\s*\(?\b(?:difference|diff|delta|rise|change|interval|increase|drop)\)?$/i, () => { diff = true; return ''; }).trim();

  const toTarget = String(input.to ?? '').trim();
  let [left, right] = splitTarget(q, (l, r) => (literal(l, r) || lookup(r).length || BASE_WORD[r.toLowerCase()]) && (literal(l, r) || given(l)));
  if (toTarget) right = toTarget;
  const lit = literal(left, right);
  if (lit) return { route: { mode: 'bases', ...lit }, warnings, notes, ctx };

  const g = given(left);
  if (!g) {
    warnings.push(`Could not read "${left}". Write a number and a unit, e.g. 25 psi, 1.6 mm, 3 1/2 in, 4k7, 0x3F, or 25 psi to bar.`);
    return { warnings, notes, ctx };
  }
  let { v, cands, unitText } = g;
  if (!cands.length && !unitText) {
    // No unit: the one the page last used, else a bare integer is a register value.
    const hint = String(input.unit ?? '').trim();
    if (hint) { cands = lookup(hint); unitText = hint; }
    else if (Number.isInteger(v) && Math.abs(v) < 2 ** 63) return { route: { mode: 'bases', num_text: String(v), num_base: 'dec' }, warnings, notes, ctx };
    else {
      warnings.push(`${fmt(v).s} has no unit. Add one: ${v} mm, ${v} psi, ${v} V ...`);
      return { warnings, notes, ctx, v };
    }
  }
  if (!cands.length) {
    const s = suggest(unitText);
    warnings.push(`"${unitText}" is not a unit I know${s.length ? `. Did you mean ${s.join(', ')}?` : '. Try a symbol (psi, N·m, mAh) or a name (inch, pound-force).'}`);
    return { warnings, notes, ctx, v };
  }
  // Point or difference of temperature.
  const toDiff = (list) => list.map((c) => (c.u.q === 'temperature' ? { ...c, u: BY_ID.get('dtemp').units.find((x) => x.sym === `Δ${c.u.sym}`) || c.u } : c));
  if (diff) cands = toDiff(cands);

  let dstC = right ? lookup(right) : [];
  let src = cands[0], dst = null;
  if (right && !dstC.length && !BASE_WORD[right.toLowerCase()]) {
    const s = suggest(right);
    warnings.push(`"${right}" is not a unit I know${s.length ? `. Did you mean ${s.join(', ')}?` : ''}; showing every unit instead.`);
  } else if (dstC.length) {
    if (cands.some((c) => c.u.q === 'dtemp')) dstC = toDiff(dstC);
    const pair = cands.flatMap((c) => dstC.filter((d) => d.u.q === c.u.q).map((d) => [c, d]))[0];
    if (pair) [src, dst] = [pair[0], pair[1].u];
    else {
      warnings.push(`${src.u.sym} is ${article(BY_ID.get(src.u.q).name)} unit and ${dstC[0].u.sym} ${article(BY_ID.get(dstC[0].u.q).name)} one: they do not convert. Showing ${src.u.sym} in every ${BY_ID.get(src.u.q).name.toLowerCase()} unit.`);
    }
  }
  // Say how an ambiguous symbol was read.
  const others = cands.filter((c) => c.u.q !== src.u.q && !c.u.quiet);
  if (others.length && !src.u.quiet && !dst) {
    const alt = [...new Map(others.map((c) => [c.u.q, c])).values()].slice(0, 3)
      .map((c) => `${c.u.name} (${BY_ID.get(c.u.q).name.toLowerCase()}; write ${c.u.sym === norm(unitText) ? c.u.aliases.find((a) => !a.startsWith('~') && a.length > 2) || c.u.sym : c.u.sym})`);
    notes.push(`Read "${unitText}" as ${src.u.name}. It can also mean ${alt.join(', ')}.`);
  }
  return { v, src: src.u, dst, diff, warnings, notes, ctx, unitText };
}
const article = (name) => `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name.toLowerCase()}`;

/** The number and the unit(s) it can be in; null when there is no number and no unit. */
function given(text) {
  const t = text.trim();
  // Wire gauge: 24 AWG, AWG 24, 4/0 AWG, 0000 AWG, #10 AWG
  let m = /^(?:awg\s*#?\s*([\d/]+)|#?([\d/]+)\s*(?:awg|ga|gauge))$/i.exec(t);
  if (m) {
    const g = m[1] || m[2];
    const n = /^\d+\/0$/.test(g) ? 1 - Number(g.split('/')[0]) : /^0{2,}$/.test(g) ? 1 - g.length : Number(g);
    if (Number.isFinite(n)) return { v: n, cands: lookup('AWG'), unitText: 'AWG' };
  }
  // 5' 11" and 5 ft 11 in
  m = /^(\d+(?:\.\d+)?)\s*(?:'|′|’|ft)\s*(\d+(?:\.\d+)?)\s*(?:"|″|”|in)?$/.exec(t);
  if (m) return { v: Number(m[1]) * 12 + Number(m[2]), cands: lookup('in'), unitText: 'in' };
  // 12°30'15"
  m = /^([-+]?\d+(?:\.\d+)?)\s*°\s*(\d+(?:\.\d+)?)\s*['′’]\s*(?:(\d+(?:\.\d+)?)\s*(?:"|″|”))?$/.exec(t);
  if (m) return { v: (m[1].startsWith('-') ? -1 : 1) * (Math.abs(Number(m[1])) + Number(m[2]) / 60 + Number(m[3] || 0) / 3600), cands: lookup('°'), unitText: '°' };
  const a = amount(t);
  if (!a) {
    // No number: "psi" alone is one of it.
    const c = lookup(t);
    return c.length ? { v: 1, cands: c, unitText: t } : null;
  }
  let rest = a.rest.trim();
  if (!rest && a.implied) return { v: a.v, cands: lookup(a.implied), unitText: a.implied };
  if (!rest) return { v: a.v, cands: [], unitText: '' };
  let c = lookup(rest);
  if (!c.length) {
    // "10 k ohm", "10k" (a prefix on its own)
    const p = /^([kKMGmunpµ])(?:\s+(.+))?$/.exec(rest);
    if (p) {
      const v = a.v * LONE[p[1]];
      if (!p[2]) return { v, cands: [], unitText: '' };
      c = lookup(p[2]);
      if (c.length) return { v, cands: c, unitText: p[2] };
    }
  }
  return { v: a.v, cands: c, unitText: rest };
}

// ---------------- converting ----------------
const toBase = (u, x, ctx) => (u.fn ? u.fn.to(x, ctx) : x * u.f);
const fromBase = (u, b, ctx) => (u.fn ? u.fn.from(b, ctx) : b / u.f);
const awgName = (n) => {
  const r = Math.round(n);
  if (Math.abs(n - r) < 0.05) return r <= 0 ? `${1 - r}/0` : String(r);
  return null;
};

function cell(u, x, digits, notation) {
  if (u.fn?.awg) {
    if (!Number.isFinite(x)) return { s: '–', c: '' };
    const name = awgName(x);
    const f = fmt(x, 3, 'plain');
    return name ? { s: name, c: name } : { s: f.s, c: f.c };
  }
  return fmt(x, digits, notation);
}

const labelOf = (u, ctx) => (u.fn?.ctx === 'volts' ? `${u.sym.replace('@V', '')} @ ${fmtNum(ctx.volts, 4)} V`
  : u.fn?.ctx === 'dpi' ? `px @ ${fmtNum(ctx.dpi, 4)} dpi` : u.sym);

/** Short "1 psi = 6894.757 Pa" for the notes. */
function definition(u, Q, ctx) {
  if (u.fn?.affine && u.fn.f === 1 && !u.fn.off) return null;
  if (u.fn?.affine) return u.fn.off ? `${u.sym}: K = (${u.sym} + ${fmtNum(u.fn.off, 6)}) × ${u.fn.f === 1 ? '1' : '5/9'}` : `${u.sym}: K = ${u.sym} × 5/9`;
  if (u.fn?.log) return `${u.sym} = ${u.fn.log}·log₁₀(value / ${fmtNum(u.fn.to(0, ctx), 6)} ${Q.si})`;
  if (u.fn?.awg) return 'AWG n: diameter = 0.005 in × 92^((36 − n)/39)';
  if (u.fn) return null;
  if (u.sym === Q.si) return null;
  return `1 ${u.sym} = ${fmt(u.f, 12, 'auto').c} ${Q.si}`;
}

function extrasFor(Q, base, ctx, digits, src) {
  const out = [];
  const add = (label, v, unit, note) => { const f = withPrefix(v, unit, digits); out.push({ label, s: f.s, c: f.c, note }); };
  switch (Q.id) {
    case 'area': if (base > 0) {
      const d = Math.sqrt((4 * base) / Math.PI);
      out.push({ label: 'Round wire diameter', ...(() => { const f = fmt(d * 1e3, digits); return { s: `${f.s} mm`, c: `${f.c} mm` }; })() });
      out.push({ label: 'Round wire diameter', ...(() => { const f = fmt(d / MIL, digits); return { s: `${f.s} mil`, c: `${f.c} mil` }; })() });
    } break;
    case 'frequency': if (base > 0) {
      add('Period (1/f)', 1 / base, 's');
      add('Wavelength in vacuum (c/f)', C0 / base, 'm');
      add('Angular frequency ω', 2 * Math.PI * base, 'rad/s');
    } break;
    case 'time': if (base > 0) add('As a frequency (1/t)', 1 / base, 'Hz'); break;
    case 'power': if (base > 0) {
      const vr = Math.sqrt(base * ctx.ohms);
      add(`Voltage into ${fmtNum(ctx.ohms, 4)} Ω (rms)`, vr, 'V');
      add(`Voltage into ${fmtNum(ctx.ohms, 4)} Ω (peak to peak, sine)`, 2 * Math.SQRT2 * vr, 'V');
      add(`Current into ${fmtNum(ctx.ohms, 4)} Ω (rms)`, Math.sqrt(base / ctx.ohms), 'A');
    } break;
    case 'voltage': if (Number.isFinite(base)) {
      const p = (base * base) / ctx.ohms;
      add(`Power into ${fmtNum(ctx.ohms, 4)} Ω (rms volts)`, p, 'W');
      if (p > 0) { const f = fmt(10 * Math.log10(p / 1e-3), digits); out.push({ label: `Power into ${fmtNum(ctx.ohms, 4)} Ω`, s: `${f.s} dBm`, c: `${f.c} dBm` }); }
    } break;
    case 'charge': if (Number.isFinite(base)) {
      add(`Energy at ${fmtNum(ctx.volts, 4)} V`, (base * ctx.volts) / 3600, 'Wh');
      add(`Energy at ${fmtNum(ctx.volts, 4)} V`, base * ctx.volts, 'J');
    } break;
    case 'energy': if (Number.isFinite(base)) {
      const f = fmt(base / ctx.volts / 3.6, digits); out.push({ label: `Charge at ${fmtNum(ctx.volts, 4)} V`, s: `${f.s} mAh`, c: `${f.c} mAh` });
    } break;
    case 'datarate': if (base > 0) {
      add('Time per bit (symbol)', 1 / base, 's');
      const f = fmt(base / 10, digits);
      out.push({ label: 'UART 8N1 throughput (10 bits a byte)', s: `${f.s} B/s`, c: `${f.c} B/s` });
    } break;
    case 'datasize': if (base >= 0) {
      const f = fmt(base / 8, 15, 'plain');
      out.push({ label: 'Bytes', s: `${f.s} B`, c: f.c });
    } break;
    case 'angle': if (Number.isFinite(base)) {
      const deg = (base * 180) / Math.PI, a = Math.abs(deg);
      let d = Math.floor(a), mi = Math.floor((a - d) * 60), se = ((a - d) * 60 - mi) * 60;
      if (se >= 59.995) { se = 0; mi += 1; } if (mi >= 60) { mi = 0; d += 1; }
      out.push({ label: 'Degrees, minutes, seconds', s: `${deg < 0 ? '−' : ''}${d}° ${mi}′ ${fmtNum(Number(se.toFixed(2)), 4)}″`, c: `${deg < 0 ? '-' : ''}${d}°${mi}'${Number(se.toFixed(2))}"` });
      if (a < 89.9) { const f = fmt(100 * Math.tan(base), digits); out.push({ label: 'As a slope (rise / run)', s: `${f.s} %`, c: `${f.c}%` }); }
    } break;
    case 'resistance': if (base > 0) add('Conductance (1/R)', 1 / base, 'S'); break;
    case 'conductance': if (base > 0) add('Resistance (1/G)', 1 / base, 'Ω'); break;
    case 'resistivity': if (base > 0) {
      add('Conductivity (1/ρ)', 1 / base, 'S/m');
      const f = fmt(100 * (1 / base) / 58e6, digits); out.push({ label: 'Conductivity', s: `${f.s} % IACS`, c: `${f.c} %IACS` });
    } break;
    case 'conductivity': if (base > 0) { const f = fmt(1e8 / base, digits); out.push({ label: 'Resistivity (1/σ)', s: `${f.s} µΩ·cm`, c: `${f.c} µΩ·cm` }); } break;
    default: break;
  }
  return out;
}

// ---------------- the drawings' data ----------------
function nice(x) {
  const e = Math.floor(Math.log10(x)), b = x / 10 ** e;
  return (b <= 1 ? 1 : b <= 2 ? 2 : b <= 5 ? 5 : 10) * 10 ** e;
}
function scaleTicks(spanU, target = 8) {
  const step = nice(spanU / target);
  const sub = String(step).startsWith('2') ? 4 : 5;
  return { step, minor: step / sub };
}
const METRIC = [['nm', 1e-9], ['µm', 1e-6], ['mm', 1e-3], ['m', 1], ['km', 1e3]];
const IMPERIAL = [['µin', 0.0254e-6], ['mil', 0.0254e-3], ['in', 0.0254], ['ft', 0.3048], ['mi', 1609.344]];

function ruler(base) {
  const a = Math.abs(base) || 1e-3;
  const span = nice(a * 1.25) * (a * 1.25 > nice(a * 1.25) ? 2 : 1);
  const scale = (list) => {
    const [sym, f] = [...list].reverse().find(([, k]) => span / k >= 1.5) || list[0];
    const { step, minor } = scaleTicks(span / f);
    const major = [], minors = [];
    for (let i = 0; i * step <= span / f + 1e-9; i++) major.push({ x: (i * step * f) / span, l: fmtNum(i * step, 6) });
    for (let i = 0; i * minor <= span / f + 1e-9 && minors.length < 400; i++) minors.push((i * minor * f) / span);
    return { sym, major, minor: minors };
  };
  return { type: 'ruler', at: Math.min(1, a / span), top: scale(METRIC), bottom: scale(IMPERIAL) };
}

const MARKS = [[0, 'absolute zero'], [77.36, 'liquid N₂ boils'], [194.7, 'dry ice'], [233.15, '−40: °C = °F'], [273.15, 'water freezes'],
  [298.15, '25 °C lab'], [310.15, 'body 37 °C'], [358.15, '85 °C industrial'], [373.15, 'water boils'], [398.15, '125 °C automotive'],
  [490.15, 'SAC305 melts ~217 °C'], [533.15, 'reflow peak ~260 °C'], [933.47, 'aluminium melts'], [1357.77, 'copper melts']];

function thermo(K) {
  let lo = Math.min(K, 233.15), hi = Math.max(K, 398.15);
  const pad = (hi - lo) * 0.08; lo = Math.max(0, lo - pad); hi += pad;
  const scales = [['°C', 1, 273.15], ['°F', 5 / 9, 459.67], ['K', 1, 0], ['°R', 5 / 9, 0]].map(([sym, f, off]) => {
    const a = lo / f - off, b = hi / f - off;
    const { step } = scaleTicks(b - a, 7);
    const ticks = [];
    for (let t = Math.ceil(a / step) * step; t <= b + 1e-9; t += step) ticks.push({ k: (t + off) * f, l: fmtNum(t, 6) });
    return { sym, ticks };
  });
  return { type: 'thermo', K, lo, hi, scales, marks: MARKS.filter(([k]) => k >= lo && k <= hi).map(([k, l]) => ({ k, l })) };
}

// ---------------- the convert mode ----------------
function convert(input) {
  const digits = Math.max(2, Math.min(12, Number(input.digits) || 6));
  const notation = ['auto', 'eng', 'sci', 'plain'].includes(input.notation) ? input.notation : 'auto';
  const r = read(input.q, input);
  if (r.empty) return { warnings: ['Type a value and a unit, e.g. 25 psi, 3.3 mil to mm, -40 °F, 2000 mAh @ 3.7 V to Wh, or 0x3F.'], view: { kind: 'convert', empty: true } };
  if (r.route) {
    const res = bases({ ...input, ...r.route });
    res.notes = [...(res.notes || []), `Read "${input.q}" as an integer written in ${r.route.num_base}.`];
    res.view = { ...(res.view || {}), route: r.route };
    return res;
  }
  if (!r.src) return { warnings: r.warnings, notes: r.notes, view: { kind: 'convert', bad: true } };

  const { v, src, dst, ctx } = r;
  const Q = BY_ID.get(src.q);
  const base = toBase(src, v, ctx);
  const warnings = [...r.warnings];
  if (Number.isNaN(base)) warnings.push(`${v} ${src.sym} has no value in ${Q.si}.`);
  if (Q.id === 'temperature' && base < 0) warnings.push(`${fmt(v).s} ${src.sym} is below absolute zero (${fmt(fromBase(src, 0, ctx)).s} ${src.sym}).`);

  // Every unit of the quantity; a prefixed unit that was typed (kbar, µWh) joins the list.
  const list = [...Q.units];
  for (const u of [src, dst]) if (u?.gen && !list.some((x) => x.sym === u.sym)) list.push(u);
  const rows = list.map((u) => {
    const x = fromBase(u, base, ctx);
    const f = cell(u, x, digits, notation);
    return { sym: u.sym, label: labelOf(u, ctx), name: u.name, sys: u.sys, s: f.s, c: f.c, v: Number.isFinite(x) ? x : null, gen: u.gen || undefined, lin: u.f != null || undefined };
  });
  // Linear units by size within each system; the rest keep their order.
  const sysOrder = { M: 0, U: 1, O: 2, L: 3 };
  const sizeOf = (sym) => { const u = list.find((x) => x.sym === sym); return u.f ?? (u.fn?.ctx ? toBase(u, 1, ctx) : null); };
  rows.sort((a, b) => (sysOrder[a.sys] - sysOrder[b.sys]) || ((sizeOf(a.sym) ?? Infinity) - (sizeOf(b.sym) ?? Infinity)) || 0);
  const srcRow = rows.find((x) => x.sym === src.sym), dstRow = dst ? rows.find((x) => x.sym === dst.sym) : null;
  const srcText = `${fmt(v, 15, 'auto').c} ${labelOf(src, ctx)}`;
  const siRow = rows.find((x) => x.sym === Q.si) || rows.find((x) => x.lin && sizeOf(x.sym) === 1);

  const extras = Number.isFinite(base) ? extrasFor(Q, base, ctx, digits, src) : [];
  const values = [];
  if (dstRow) values.push({ label: `${srcText} in ${dstRow.label}`, value: dstRow.c, unit: dstRow.label, tone: 'ok' });
  values.push({ label: 'Quantity', value: Q.name });
  if (siRow && siRow !== dstRow && siRow !== srcRow) values.push({ label: `In ${Q.si}`, value: siRow.c, unit: siRow.label });

  const tables = [{ title: `${srcText} in every ${Q.name.toLowerCase()} unit`, columns: ['Unit', 'Value', 'Name'],
    rows: rows.map((x) => [x.label, x.c, `${x.name}${x.sym === src.sym ? ' (as given)' : dstRow && x.sym === dstRow.sym ? ' (asked for)' : ''}`]) }];
  if (extras.length) tables.push({ title: 'Related', columns: ['What', 'Value'], rows: extras.map((e) => [e.label, e.c]) });

  let awg;
  if (Q.id === 'area' && base > 0) {
    const n0 = Math.round(fromBase(Q.bySym.get('AWG'), base, ctx));
    awg = [];
    for (let n = Math.max(-3, n0 - 4); n <= Math.min(40, n0 + 4); n++) {
      const d = awgDiameterMm(n), a = (Math.PI / 4) * d * d;
      awg.push({ n, name: awgName(n), d: fmtNum(d, 4), dmil: fmtNum(d / 0.0254, 4), a: fmtNum(a, 4), kcmil: fmtNum((a * 1e-6) / CMIL / 1000, 4), dmm: d, mine: n === n0 });
    }
    tables.push({ title: 'Nearby AWG sizes', columns: ['AWG', 'Diameter mm', 'Diameter mil', 'Area mm²', 'kcmil'],
      rows: awg.map((x) => [x.name, x.d, x.dmil, x.a, x.kcmil]) });
  }

  const notes = [...r.notes];
  const defs = [src, dst].filter(Boolean).map((u) => definition(u, Q, ctx)).filter(Boolean);
  if (defs.length) notes.push(`${[...new Set(defs)].join('; ')}.`);
  notes.push(...(Q.notes || []));
  const usesCtx = [...new Set(list.filter((u) => u.fn?.ctx).map((u) => u.fn.ctx))];
  if (['power', 'voltage'].includes(Q.id)) usesCtx.push('ohms');
  if (['charge'].includes(Q.id)) usesCtx.push('volts');

  let draw;
  if (Number.isFinite(base)) {
    if (Q.id === 'length') draw = ruler(base);
    else if (Q.id === 'temperature') draw = thermo(base);
    else if (Q.id === 'angle') draw = { type: 'dial', rad: base };
    else if (Q.id === 'area' && awg) draw = { type: 'awg' };
    else {
      const lin = list.filter((u) => u.f != null && u.f > 0 && !u.gen);
      if (lin.length >= 3 && base !== 0) draw = { type: 'log', at: Math.log10(Math.abs(base)), units: lin.map((u) => ({ sym: u.sym, e: Math.log10(u.f), sys: u.sys })) };
    }
  }

  return {
    values, tables, warnings, notes,
    view: {
      kind: 'convert', q: Q.id, name: Q.name, si: Q.si, diff: r.diff,
      src: { sym: src.sym, label: srcRow.label, v, s: fmt(v, 15, 'auto').s, c: fmt(v, 15, 'auto').c, text: r.unitText },
      dst: dstRow ? { sym: dstRow.sym, label: dstRow.label, s: dstRow.s, c: dstRow.c } : null,
      rows, extras, ctx: { volts: ctx.volts, ohms: ctx.ohms, dpi: ctx.dpi, uses: [...new Set(usesCtx)], set: ctx.set || null },
      draw, awg, systems: SYSTEMS,
    },
  };
}

export function run(input) {
  const q = String(input.q ?? '').trim();
  switch (input.mode) {
    case 'bases': return bases(input);
    case 'uart': return uart(input);
    case 'timer': return timer(input);
    case 'convert': return convert(input);
    // The first calculator's default: lengths, unless a question was given.
    default: return q ? convert(input) : length(input);
  }
}
