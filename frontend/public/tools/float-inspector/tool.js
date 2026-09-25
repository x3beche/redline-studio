// IEEE 754-2019 binary floating point, taken apart.
//   value = (-1)^s * 1.f * 2^(e - bias)     normal,    0 < e < 2^E - 1
//   value = (-1)^s * 0.f * 2^(1 - bias)     subnormal, e = 0
//   bias  = 2^(E-1) - 1
// A decimal input is read EXACTLY (as a BigInt fraction) and rounded once to
// the format, round-half-to-even (IEEE 754 section 4.3.1), so there is no
// double rounding through a JS double. bfloat16 is binary32 with 7 fraction
// bits (Intel/Google BF16), rounded the same way.

export const FORMATS = {
  binary16: { E: 5, M: 10, name: 'half (binary16, _Float16)' },
  bfloat16: { E: 8, M: 7, name: 'bfloat16' },
  binary32: { E: 8, M: 23, name: 'float (binary32)' },
  binary64: { E: 11, M: 52, name: 'double (binary64)' },
};

const bl = (x) => (x === 0n ? 0 : x.toString(2).length);
const pow2 = (k) => 1n << BigInt(k);
const babs = (x) => (x < 0n ? -x : x);

// Read "-12.5e-3" exactly as sign, num/den
function parseDecimal(t) {
  const m = /^([-+]?)(\d+\.?\d*|\.\d+)(?:e([-+]?\d+))?$/i.exec(t);
  if (!m) return null;
  const [ip, fp = ''] = m[2].split('.');
  let exp = Number(m[3] || 0) - fp.length;
  const digits = BigInt((ip || '0') + fp);
  if (Math.abs(exp) > 6000) return { neg: m[1] === '-', num: digits === 0n ? 0n : 1n, den: 1n, huge: exp > 0 ? 1 : -1 };
  let num = digits, den = 1n;
  if (exp >= 0) num *= 10n ** BigInt(exp); else den = 10n ** BigInt(-exp);
  return { neg: m[1] === '-', num, den };
}

// Round |x| = num/den into the format; returns the biased exponent and fraction fields
function encode(num, den, f) {
  const bias = 2 ** (f.E - 1) - 1, emin = 1 - bias, emaxField = 2 ** f.E - 1;
  if (num === 0n) return { e: 0, frac: 0n };
  let ex = bl(num) - bl(den); // floor(log2(num/den)) is ex or ex-1
  const ge = ex >= 0 ? num >= den * pow2(ex) : num * pow2(-ex) >= den;
  if (!ge) ex -= 1;
  let s = Math.max(ex, emin) - f.M; // value = q * 2^s with q < 2^(M+1)
  // q = round_half_even(num / den / 2^s)
  let n = num, d = den;
  if (s >= 0) d *= pow2(s); else n *= pow2(-s);
  let q = n / d;
  const r = n - q * d;
  if (2n * r > d || (2n * r === d && (q & 1n))) q += 1n;
  if (q === pow2(f.M + 1)) { q >>= 1n; s += 1; }
  if (q < pow2(f.M)) return { e: 0, frac: q, inexact: r !== 0n };
  const e = s + f.M + bias;
  if (e >= emaxField) return { e: emaxField, frac: 0n, overflow: true };
  return { e, frac: q - pow2(f.M), inexact: r !== 0n };
}

// Field values -> exact value as q * 2^k (null for inf/nan)
function decode(e, frac, f) {
  const bias = 2 ** (f.E - 1) - 1;
  if (e === 2 ** f.E - 1) return null;
  if (e === 0) return { q: frac, k: 1 - bias - f.M };
  return { q: frac + pow2(f.M), k: e - bias - f.M };
}

// Exact decimal expansion of q * 2^k, cut to `sig` significant digits
function exactDecimal(q, k, sig = 60) {
  if (q === 0n) return { text: '0', digits: 1 };
  let s, point;
  if (k >= 0) { s = (q << BigInt(k)).toString(); point = s.length; }
  else { s = (q * 5n ** BigInt(-k)).toString(); point = s.length + k; }
  // s is the digit string, the decimal point sits after `point` digits
  const lead = s.replace(/0+$/, '');
  const all = lead.length;
  const cut = all > sig;
  const body = cut ? lead.slice(0, sig) : lead;
  let text;
  if (point <= -5 || point > 24) {
    // scientific for very small / large values: d.ddd…e±x
    text = body[0] + (body.length > 1 ? '.' + body.slice(1) : '') + (cut ? '…' : '') + 'e' + (point - 1);
    return { text, digits: all };
  }
  if (point <= 0) text = '0.' + '0'.repeat(-point) + body;
  else if (point >= body.length) text = body + '0'.repeat(point - body.length);
  else text = body.slice(0, point) + '.' + body.slice(point);
  if (cut) text += '…';
  return { text, digits: all };
}

// q*2^k - num/den as a JS number (rational arithmetic, then one rounding)
function ratToNumber(n, d) {
  if (n === 0n) return 0;
  const neg = n < 0n; if (neg) n = -n;
  const shift = bl(d) - bl(n) + 64;
  const v = shift >= 0 ? Number((n << BigInt(shift)) / d) * 2 ** -shift : Number(n / (d << BigInt(-shift))) * 2 ** -shift;
  return neg ? -v : v;
}

function shortest(v) {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e7 || a < 1e-4)) return v.toExponential().replace('e+', 'e');
  return String(v);
}

// shortest decimal that rounds back to the same bits in this format
function shortestIn(q, k, neg, f) {
  const target = { q, k };
  for (let p = 1; p <= 17; p++) {
    const approx = Number(q) * 2 ** k;
    const str = approx.toPrecision(p);
    const r = parseDecimal(str.replace('+', ''));
    if (!r) continue;
    const enc = encode(r.num, r.den, f);
    const dec = decode(enc.e, enc.frac, f);
    if (dec && dec.q * (dec.k >= target.k ? pow2(dec.k - target.k) : 1n) === target.q * (target.k > dec.k ? pow2(target.k - dec.k) : 1n)) {
      const n = Number(str);
      return (neg ? '-' : '') + shortest(n);
    }
  }
  return (neg ? '-' : '') + shortest(Number(q) * 2 ** k);
}

// The stored value as people write it: exact when that is short, else the
// shortest decimal that reads back to the same bits
function display(dec, neg, f) {
  const ex = exactDecimal(dec.q, dec.k, 40);
  if (ex.digits <= 12 && !ex.text.includes('e')) return (neg ? '-' : '') + ex.text;
  return shortestIn(dec.q, dec.k, neg, f);
}

const sci = (v) => (v === 0 ? '0' : Number.isFinite(v) ? shortest(Number(v.toPrecision(7))) : String(v));

export function run({ value, format, input: how }) {
  const f = FORMATS[format] || FORMATS.binary32;
  const W = 1 + f.E + f.M, bias = 2 ** (f.E - 1) - 1;
  const warnings = [];
  const t = String(value ?? '').trim().replace(/_/g, '').replace(/\s+/g, '');
  if (!t) return { warnings: ['Give a value: a decimal like 0.1 or -1.5e-3, inf, nan, or a bit pattern like 0x3DCCCCCD.'] };
  let sign = 0, e, frac, rat = null, source;
  const asBits = how === 'bits' || (how !== 'decimal' && /^0x[0-9a-f]+$/i.test(t));
  if (asBits) {
    const hexs = t.replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]+$/.test(hexs)) return { warnings: [`"${t}" is not a hex bit pattern. Write it like 0x3DCCCCCD.`] };
    let bits = BigInt('0x' + hexs);
    if (bl(bits) > W) {
      warnings.push(`0x${hexs} has more than ${W} bits for ${f.name}: only the low ${W} bits are used.`);
      bits &= pow2(W) - 1n;
    }
    sign = Number(bits >> BigInt(W - 1));
    e = Number((bits >> BigInt(f.M)) & (pow2(f.E) - 1n));
    frac = bits & (pow2(f.M) - 1n);
    source = 'bits';
  } else if (/^[-+]?(inf|infinity)$/i.test(t)) {
    sign = t[0] === '-' ? 1 : 0; e = 2 ** f.E - 1; frac = 0n; source = 'inf';
  } else if (/^[-+]?nan$/i.test(t)) {
    sign = t[0] === '-' ? 1 : 0; e = 2 ** f.E - 1; frac = pow2(f.M - 1); source = 'nan';
  } else {
    rat = parseDecimal(t);
    if (!rat) return { warnings: [`"${t}" is not a number. Write it like 0.1, -1.5e-3, 1e38, inf or nan, or give bits as 0x3DCCCCCD.`] };
    sign = rat.neg ? 1 : 0;
    if (rat.huge > 0) { e = 2 ** f.E - 1; frac = 0n; warnings.push(`${t} is far beyond the largest ${f.name}: it becomes infinity.`); }
    else if (rat.huge < 0) { e = 0; frac = 0n; warnings.push(`${t} is far below the smallest ${f.name}: it becomes zero.`); }
    else {
      const enc = encode(rat.num, rat.den, f);
      e = enc.e; frac = enc.frac;
      if (enc.overflow) warnings.push(`${t} is above the largest finite ${f.name} (${sci(Number(pow2(f.M + 1) - 1n) * 2 ** (bias - f.M))}): it rounds to infinity. Scale the value or use a wider format.`);
      else if (e === 0 && frac === 0n && rat.num !== 0n) warnings.push(`${t} is below half the smallest subnormal ${f.name}: it underflows to zero.`);
    }
    source = 'decimal';
  }

  const eMax = 2 ** f.E - 1;
  const cls = e === eMax ? (frac === 0n ? 'infinity' : (frac >> BigInt(f.M - 1)) & 1n ? 'quiet NaN' : 'signalling NaN')
    : e === 0 ? (frac === 0n ? 'zero' : 'subnormal') : 'normal';
  const bitsStr = { sign: String(sign), exp: e.toString(2).padStart(f.E, '0'), frac: frac.toString(2).padStart(f.M, '0') };
  const pattern = (BigInt(sign) << BigInt(W - 1)) | (BigInt(e) << BigInt(f.M)) | frac;
  const hex = '0x' + pattern.toString(16).toUpperCase().padStart(W / 4, '0');
  const dec = decode(e, frac, f);
  const approx = dec ? (sign ? -1 : 1) * Number(dec.q) * 2 ** dec.k : cls === 'infinity' ? (sign ? -Infinity : Infinity) : NaN;

  const values = [
    { label: 'Stored value', value: dec ? display(dec, !!sign, f) : cls === 'infinity' ? (sign ? '-Inf' : '+Inf') : 'NaN', tone: cls === 'normal' || cls === 'zero' ? 'ok' : 'warn', hint: cls },
    { label: 'Bit pattern', value: hex },
    { label: 'Sign', value: sign ? '1 (negative)' : '0 (positive)' },
    { label: 'Exponent field', value: `${e}`, hint: cls === 'normal' ? `2^${e - bias} (bias ${bias})` : cls === 'subnormal' || cls === 'zero' ? `subnormal scale 2^${1 - bias}` : 'all ones' },
    { label: 'Significand', value: dec ? shortest(Number(dec.q) / 2 ** f.M) : '–', hint: dec ? (e === 0 ? '0.fraction, no implicit 1' : '1.fraction') : '' },
  ];
  const rows = [];
  let exactText = '–';
  // for the page's drawings: the same numbers as the values, unformatted
  const extra = { bias, e, fracHex: '0x' + frac.toString(16).toUpperCase(), err: null, rel: null, ulp: null, toward: null, away: null, input: null };
  if (dec) {
    const ex = exactDecimal(dec.q, dec.k);
    exactText = (sign ? '-' : '') + ex.text;
    values.push({ label: 'Exact stored value', value: exactText, hint: `${ex.digits} significant digits` });
    if (rat && !rat.huge) {
      // error = stored - input, exactly
      const sq = (sign ? -1n : 1n) * dec.q;
      const inNum = (rat.neg ? -1n : 1n) * rat.num;
      let n, d;
      if (dec.k >= 0) { n = sq * pow2(dec.k) * rat.den - inNum; d = rat.den; }
      else { n = sq * rat.den - inNum * pow2(-dec.k); d = rat.den * pow2(-dec.k); }
      const err = ratToNumber(n, d);
      const rel = rat.num === 0n ? 0 : ratToNumber(babs(n * rat.den), babs(d * inNum));
      extra.err = n === 0n ? 0 : err; extra.rel = n === 0n ? 0 : Math.abs(rel); extra.input = t;
      values.push(
        { label: 'Rounding error', value: n === 0n ? '0 (exact)' : sci(err), tone: n === 0n ? 'ok' : undefined, hint: 'stored − input' },
        { label: 'Relative error', value: n === 0n ? '0' : sci(Math.abs(rel)), hint: `limit 2^-${f.M + 1} = ${sci(2 ** -(f.M + 1))} for normals` },
      );
      if (n !== 0n && cls === 'subnormal') warnings.push(`${t} is subnormal in ${f.name}: it keeps fewer than ${f.M + 1} significant bits, so its relative error can be far above 2^-${f.M + 1}. Scale the value up if precision matters.`);
    }
    // spacing: one unit in the last place at this value
    const ulpK = e === 0 ? 1 - bias - f.M : e - bias - f.M;
    values.push({ label: 'ULP here', value: sci(2 ** ulpK), hint: 'gap to the next value' });
    extra.ulp = 2 ** ulpK;
    const nxt = (de) => {
      let p = pattern + BigInt(de);
      const d2 = decode(Number((p >> BigInt(f.M)) & (pow2(f.E) - 1n)), p & (pow2(f.M) - 1n), f);
      return d2 ? shortestIn(d2.q, d2.k, !!sign, f) : 'Inf';
    };
    rows.push(['Next toward zero', frac === 0n && e === 0 ? '–' : nxt(-1)], ['Next away from zero', e === eMax - 1 && frac === pow2(f.M) - 1n ? 'Inf' : nxt(1)]);
    const hexOf = (p) => '0x' + p.toString(16).toUpperCase().padStart(W / 4, '0');
    extra.toward = frac === 0n && e === 0 ? null : { text: rows[0][1], hex: hexOf(pattern - 1n) };
    extra.away = { text: rows[1][1], hex: hexOf(pattern + 1n) };
  }
  rows.push(
    ['Largest finite', sci(Number(pow2(f.M + 1) - 1n) * 2 ** (bias - f.M))],
    ['Smallest normal', sci(2 ** (1 - bias))],
    ['Smallest subnormal', sci(2 ** (1 - bias - f.M))],
    ['Machine epsilon (2^-M)', sci(2 ** -f.M)],
    ['Decimal digits (safe / round-trip)', `${Math.floor(f.M * Math.log10(2))} / ${Math.ceil((f.M + 1) * Math.log10(2) + 1)}`],
  );
  if (source === 'bits' && cls.includes('NaN')) warnings.push(`${hex} is a ${cls}: any arithmetic with it gives NaN. Check the data source (uninitialised memory or a wrong byte order often looks like this).`);
  const notes = [
    `${f.name}: 1 sign bit, ${f.E} exponent bits (bias ${bias}), ${f.M} fraction bits plus the implicit leading 1.`,
    'Decimal input is rounded once, exactly, half to even; a JS or C parser gives the same result.',
  ];
  if (format === 'binary32') notes.push('In C, write float constants with an f suffix (0.1f): 0.1 alone is a double, and mixing them promotes the arithmetic to double, which is slow on Cortex-M4F/M33.');
  return {
    values,
    warnings,
    tables: [
      { title: 'Fields', columns: ['Field', 'Bits', 'Value'], rows: [
        ['Sign', bitsStr.sign, sign ? '−' : '+'],
        ['Exponent', bitsStr.exp, cls === 'normal' ? `${e} − ${bias} = ${e - bias}` : cls],
        ['Fraction', bitsStr.frac, dec ? `${frac} / 2^${f.M}` : cls],
      ] },
      { title: `${f.name}: neighbours and range`, columns: ['Quantity', 'Value'], rows },
    ],
    bits: { ...bitsStr, E: f.E, M: f.M, W, hex, cls, exponent: cls === 'normal' ? e - bias : cls === 'subnormal' ? 1 - bias : null, approx: Number.isFinite(approx) ? approx : String(approx),
      ...extra, stored: values[0].value, exact: exactText,
      range: { max: Number(pow2(f.M + 1) - 1n) * 2 ** (bias - f.M), minNormal: 2 ** (1 - bias), minSub: 2 ** (1 - bias - f.M) } },
    notes,
  };
}
