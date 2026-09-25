// Fixed-point (Q format) conversion.
//   raw   = round(x * 2^n)          stored integer, n fraction bits
//   x'    = raw / 2^n               value it stands for
//   LSB   = 2^-n                    resolution; round-to-nearest error <= LSB/2
//   range = [-2^(W-1), 2^(W-1)-1] * 2^-n signed, [0, 2^W - 1] * 2^-n unsigned
// Notation (Wikipedia "Q (number format)", TI and ARM conventions):
//   TI  Qm.n  m integer bits NOT counting the sign bit: Q15 = Q0.15 is int16_t
//   ARM Qm.n  m counts the sign bit: the same int16_t is Q1.15
//   UQm.n     unsigned
import { fmtNum } from '../kit/eng.js';

const pow2 = (k) => 2 ** k;

function roundBy(v, mode) {
  switch (mode) {
    case 'floor': return Math.floor(v); // arithmetic shift right
    case 'trunc': return Math.trunc(v); // C cast
    case 'even': { // IEEE / banker's rounding
      const f = Math.floor(v), d = v - f;
      if (d > 0.5) return f + 1;
      if (d < 0.5) return f;
      return f % 2 === 0 ? f : f + 1;
    }
    default: return v < 0 ? -Math.round(-v) : Math.round(v); // half away from zero, like lround()
  }
}

function hexOf(raw, W) {
  const b = BigInt.asUintN(W, BigInt(raw));
  return '0x' + b.toString(16).toUpperCase().padStart(Math.ceil(W / 4), '0');
}

function ctype(W, signed) {
  const w = W <= 8 ? 8 : W <= 16 ? 16 : W <= 32 ? 32 : 64;
  return `${signed ? '' : 'u'}int${w}_t`;
}

const g = (v) => {
  if (v == null || !Number.isFinite(v)) return '–';
  if (v === 0) return '0';
  const a = Math.abs(v);
  return a >= 1e7 || a < 1e-4 ? v.toExponential(6).replace(/\.?0+e/, 'e').replace('e+', 'e') : fmtNum(v, 10);
};

function convert(x, W, n, signed, mode, overflow) {
  const lo = signed ? -pow2(W - 1) : 0, hi = signed ? pow2(W - 1) - 1 : pow2(W) - 1;
  let raw = roundBy(x * pow2(n), mode);
  let over = null;
  if (raw > hi || raw < lo) {
    over = raw > hi ? 'high' : 'low';
    if (overflow === 'wrap') {
      const b = BigInt.asUintN(W, BigInt(raw));
      raw = Number(signed ? BigInt.asIntN(W, b) : b);
    } else raw = raw > hi ? hi : lo;
  }
  return { raw, rep: raw / pow2(n), over, lo, hi };
}

export function run({ direction, value, raw: rawText, signed: sgn, bits, frac, rounding, overflow }) {
  const warnings = [];
  const signed = sgn !== 'unsigned';
  const W = bits, n = frac;
  if (!Number.isInteger(W) || W < 2 || W > 64) return { warnings: ['Word length must be a whole number of bits from 2 to 64, e.g. 16.'] };
  if (!Number.isInteger(n) || n < 0) return { warnings: ['Fraction bits must be a whole number, 0 or more, e.g. 15.'] };
  if (n > 1074) return { warnings: ['Too many fraction bits.'] };
  const intBits = W - n - (signed ? 1 : 0);
  if (intBits < 0) warnings.push(`${n} fraction bits in a ${signed ? 'signed ' : ''}${W}-bit word leaves ${intBits} integer bits: every value is below 2^${intBits} = ${2 ** intBits} in magnitude. That is legal but unusual; check the fraction bits.`);
  if (W > 53) warnings.push(`A ${W}-bit word holds more digits than a JS double (53 bits): raw values above 2^53 are approximate here.`);
  const lsb = pow2(-n);
  const lo = signed ? -pow2(W - 1) : 0, hi = signed ? pow2(W - 1) - 1 : pow2(W) - 1;
  const ti = `${signed ? 'Q' : 'UQ'}${intBits}.${n}`;
  const arm = `${signed ? 'Q' : 'UQ'}${intBits + (signed ? 1 : 0)}.${n}`;
  const T = ctype(W, signed);
  const scale = pow2(n);
  const scaleText = n <= 30 ? `${scale}` : `(1ULL << ${n})`;

  let x, res;
  if (direction === 'fromq') {
    const t = String(rawText ?? '').trim().replace(/_/g, '');
    let r;
    try {
      if (/^[-+]?0x[0-9a-f]+$/i.test(t)) {
        const b = BigInt(t.replace(/^[-+]/, '')) * (t[0] === '-' ? -1n : 1n);
        // a hex literal is a bit pattern of the word: 0xC000 as int16_t is -16384
        if (b < 0n) r = Number(b);
        else {
          if (b >= (1n << BigInt(W))) warnings.push(`${t} has more than ${W} bits: only the low ${W} are used.`);
          const u = BigInt.asUintN(W, b);
          r = Number(signed ? BigInt.asIntN(W, u) : u);
        }
      } else if (/^[-+]?\d+$/.test(t)) r = Number(t);
      else return { warnings: [`"${t}" is not an integer. Give the raw stored value as decimal (-16384) or hex (0xC000).`] };
    } catch { return { warnings: [`"${t}" is not an integer.`] }; }
    if (r > hi || r < lo) warnings.push(`${t} is outside a ${signed ? 'signed' : 'unsigned'} ${W}-bit word (${lo} … ${hi}).`);
    res = { raw: r, rep: r / scale, over: null };
    x = res.rep;
  } else {
    if (value == null || !Number.isFinite(value)) return { warnings: ['Give the decimal value to convert, e.g. 0.7071 or -1.25.'] };
    x = value;
    res = convert(x, W, n, signed, rounding, overflow);
    if (res.over) {
      warnings.push(`${g(x)} is outside ${ti}'s range ${g(lo * lsb)} … ${g(hi * lsb)}: ${overflow === 'wrap' ? 'it wraps around (as plain C integer arithmetic does) and the stored value is far off' : 'it is saturated to the ' + (res.over === 'high' ? 'largest' : 'smallest') + ' value'}. Use fewer fraction bits or a wider word.`);
    }
  }
  const err = res.rep - x;
  const values = [
    { label: 'Format', value: `${ti} (TI) = ${arm} (ARM)`, hint: `${W}-bit ${T}` },
    { label: 'Stored integer', value: String(res.raw), tone: res.over ? 'bad' : 'ok', hint: hexOf(res.raw, W) },
    { label: 'Value it represents', value: g(res.rep) },
  ];
  if (direction !== 'fromq') {
    values.push(
      { label: 'Error', value: err === 0 ? '0 (exact)' : g(err), hint: `${g(err / lsb)} LSB` },
      { label: 'Relative error', value: x === 0 ? '–' : g(Math.abs(err / x)) },
    );
  }
  values.push(
    { label: 'Resolution (1 LSB)', value: g(lsb), hint: `2^-${n}` },
    { label: 'Range', value: `${g(lo * lsb)} … ${g(hi * lsb)}` },
    { label: 'Decimal digits after the point', value: fmtNum(n * Math.log10(2), 3), hint: 'n · log10 2' },
  );
  if (direction !== 'fromq' && x !== 0 && Math.abs(x) < 4 * lsb && !res.over) warnings.push(`${g(x)} is only ${fmtNum(Math.abs(x) / lsb, 3)} LSB: most of its precision is lost. Use more fraction bits.`);

  // The same value in the common formats
  const common = [['Q7 (int8_t)', 8, 7, true], ['Q15 (int16_t)', 16, 15, true], ['Q31 (int32_t)', 32, 31, true], ['Q8.8 (int16_t)', 16, 8, true], ['UQ8.8 (uint16_t)', 16, 8, false], ['Q16.16 (int32_t)', 32, 16, true], ['Q3.12 (int16_t)', 16, 12, true]];
  const rows = common.map(([name, w, f, s]) => {
    const c = convert(x, w, f, s, rounding, 'saturate');
    return [name, String(c.raw), hexOf(c.raw, w), g(c.rep), c.over ? 'saturated' : g(c.rep - x)];
  });
  const fracTxt = n <= 30 ? `${scale}.0` : `ldexp(1.0, ${n})`;
  const code = [
    `/* ${ti} (TI) = ${arm} (ARM): ${W}-bit ${signed ? 'signed' : 'unsigned'}, ${n} fraction bits, LSB = 2^-${n} */`,
    `#define Q_FRAC_BITS ${n}`,
    `#define TO_Q(x)   ((${T})lround((x) * ${fracTxt}))   /* saturate first if x can leave ${g(lo * lsb)} … ${g(hi * lsb)} */`,
    `#define FROM_Q(q) ((double)(q) / ${fracTxt})`,
    ``,
    `/* multiply two ${ti} numbers: the product has ${2 * n} fraction bits, shift back by ${n} */`,
    `static inline ${T} q_mul(${T} a, ${T} b)`,
    `{`,
    `    ${W <= 16 ? (signed ? 'int32_t' : 'uint32_t') : (signed ? 'int64_t' : 'uint64_t')} p = (${W <= 16 ? (signed ? 'int32_t' : 'uint32_t') : (signed ? 'int64_t' : 'uint64_t')})a * b;`,
    n > 0 ? `    return (${T})((p + (1${W <= 16 ? '' : 'LL'} << (Q_FRAC_BITS - 1))) >> Q_FRAC_BITS);   /* round to nearest; saturate if it can overflow */` : `    return (${T})p;`,
    `}`,
    ``,
    `${T} k = ${res.raw};   /* ${g(res.rep)} */`,
  ].join('\n');
  // the numbers a drawing of the word and the number line needs: the stored
  // integer's neighbours on the Q grid, the range, the same value in the
  // common formats with their parameters
  const near = [];
  for (let j = -6; j <= 6; j++) {
    const r = res.raw + j;
    if (r >= lo && r <= hi) near.push({ raw: r, value: r * lsb });
  }
  const fixed = {
    W, n, signed, intBits, ti, arm, ctype: T, direction: direction === 'fromq' ? 'fromq' : 'toq',
    x, raw: res.raw, hex: hexOf(res.raw, W), rep: res.rep, err, errLsb: err / lsb, over: res.over,
    lsb, lo, hi, min: lo * lsb, max: hi * lsb, digits: n * Math.log10(2), near,
    rounding: direction === 'fromq' ? null : rounding, overflow: direction === 'fromq' ? null : overflow,
    common: common.map(([name, w, f, s], i) => {
      const c = convert(x, w, f, s, rounding, 'saturate');
      return { name, W: w, n: f, signed: s, raw: c.raw, hex: rows[i][2], rep: c.rep, err: c.rep - x, errLsb: (c.rep - x) / pow2(-f), over: c.over };
    }),
  };
  return {
    values,
    warnings,
    tables: [{ title: `${g(x)} in common Q formats (${rounding === 'floor' ? 'floor' : rounding === 'trunc' ? 'truncate' : rounding === 'even' ? 'nearest, ties to even' : 'nearest'})`, columns: ['Format', 'Integer', 'Hex', 'Represents', 'Error'], rows }],
    texts: [{ title: 'C code', body: code, lang: 'c' }],
    notes: [
      'Signed values are two\'s complement; the hex column is the bit pattern of the word.',
      'Multiplying Qa.b by Qc.d gives Q(a+c).(b+d) in a double-width word; adding needs the same fraction bits on both sides.',
      `Scale factor 2^${n} = ${scaleText}. Floor is what an arithmetic right shift does; truncate is a C cast; nearest is lround().`,
    ],
    fixed,
  };
}
