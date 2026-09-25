// SMD marking codes, after IEC 60062 and the EIA-96 / EIA-198 code tables.
//   3-digit   ABC   -> AB × 10^C           (resistors ±5 %, capacitors in pF)
//   4-digit   ABCD  -> ABC × 10^D          (resistors ±1 %)
//   R / m     4R7   -> 4.7 Ω, R047 -> 0.047 Ω, 4m7 -> 4.7 mΩ; capacitors 1R5 -> 1.5 pF
//   EIA-96    NNL   -> E96[NN] × multiplier(L)       (resistors ±1 %)
//   EIA-198   Ln    -> mantissa(L) × 10^n pF (n = 9 means × 0.1)   (capacitors)
import { fmtEng, E24 } from '../kit/eng.js';

// EIA-96: code 01..96 -> the three significant digits (the real E96 table, not a formula).
const EIA96 = [100, 102, 105, 107, 110, 113, 115, 118, 121, 124, 127, 130, 133, 137, 140, 143,
  147, 150, 154, 158, 162, 165, 169, 174, 178, 182, 187, 191, 196, 200, 205, 210, 215, 221, 226,
  232, 237, 243, 249, 255, 261, 267, 274, 280, 287, 294, 301, 309, 316, 324, 332, 340, 348, 357,
  365, 374, 383, 392, 402, 412, 422, 432, 442, 453, 464, 475, 487, 499, 511, 523, 536, 549, 562,
  576, 590, 604, 619, 634, 649, 665, 681, 698, 715, 732, 750, 768, 787, 806, 825, 845, 866, 887,
  909, 931, 953, 976];
const EIA96_MULT = { Z: 0.001, Y: 0.01, R: 0.01, X: 0.1, S: 0.1, A: 1, B: 10, H: 10, C: 100, D: 1e3, E: 1e4, F: 1e5 };
const EIA96_LETTER = [[0.001, 'Z'], [0.01, 'Y'], [0.1, 'X'], [1, 'A'], [10, 'B'], [100, 'C'], [1e3, 'D'], [1e4, 'E'], [1e5, 'F']];

// EIA-198 capacitor code: letter = mantissa (case matters), digit = power of ten in pF.
const EIA198 = { A: 1.0, B: 1.1, C: 1.2, D: 1.3, E: 1.5, F: 1.6, G: 1.8, H: 2.0, J: 2.2, K: 2.4,
  a: 2.5, L: 2.7, M: 3.0, N: 3.3, b: 3.5, P: 3.6, Q: 3.9, d: 4.0, R: 4.3, e: 4.5, S: 4.7, f: 5.0,
  T: 5.1, U: 5.6, m: 6.0, V: 6.2, W: 6.8, n: 7.0, X: 7.5, t: 8.0, Y: 8.2, y: 9.0, Z: 9.1 };

const clean = (v) => Number(v.toPrecision(12));
const inE24 = (v) => { const m = v / Math.pow(10, Math.floor(Math.log10(v))); return E24.some((e) => Math.abs(e - m) < 1e-6); };

function decodeResistor(c) {
  if (/^0+$/.test(c)) return { value: 0, format: 'zero-ohm jumper', tol: 'jumper, typ. < 50 mΩ' };
  let m;
  if ((m = /^(\d*)[Rr](\d*)$/.exec(c)) && (m[1] || m[2])) {
    const r = { value: clean(Number(`${m[1] || '0'}.${m[2] || '0'}`)), format: 'R-notation (R = decimal point)', tol: c.length >= 4 ? '±1 %' : '±5 %' };
    const n = Number(m[1]);
    if (/^\d\d[Rr]$/.test(c) && n >= 1 && n <= 96 && clean(EIA96[n - 1] * 0.01) !== r.value) {
      r.note = `read as EIA-96 (R = ×0.01) it would be ${fmtEng(EIA96[n - 1] * 0.01, 'Ω')}; R-notation is far more common`;
    }
    return r;
  }
  if ((m = /^(\d*)m(\d*)$/.exec(c)) && (m[1] || m[2])) {
    return { value: clean(Number(`${m[1] || '0'}.${m[2] || '0'}`) / 1000), format: 'm-notation (m = decimal point, mΩ)', tol: 'current-sense part, see datasheet' };
  }
  if ((m = /^(\d+)([kKM])(\d*)$/.exec(c))) {
    const mult = m[2] === 'M' ? 1e6 : 1e3;
    return { value: clean(Number(`${m[1]}.${m[3] || '0'}`) * mult), format: `${m[2].toLowerCase() === 'k' ? 'k' : 'M'}-notation`, tol: 'see datasheet' };
  }
  if ((m = /^(\d{2})([A-Za-z])$/.exec(c))) {
    const n = Number(m[1]), L = m[2].toUpperCase();
    if (n < 1 || n > 96) return { error: `EIA-96 codes run from 01 to 96, not ${m[1]}.` };
    if (!(L in EIA96_MULT)) return { error: `"${m[2]}" is not an EIA-96 multiplier letter (Z Y R X S A B H C D E F).` };
    return { value: clean(EIA96[n - 1] * EIA96_MULT[L]), format: `EIA-96 (${m[1]} = ${EIA96[n - 1]}, ${L} = ×${EIA96_MULT[L]})`, tol: '±1 %' };
  }
  if ((m = /^(\d{2})(\d)$/.exec(c))) {
    const exp = Number(m[2]);
    if (exp > 8) return { error: `A multiplier digit of 9 is not used on resistors: is "${c}" a capacitor or upside down?` };
    const value = clean(Number(m[1]) * Math.pow(10, exp));
    const r = { value, format: `3-digit (${m[1]} × 10^${exp})`, tol: '±5 %' };
    if (!inE24(value)) r.note = 'not an E24 value: check the reading (upside down?)';
    return r;
  }
  if ((m = /^(\d{3})(\d)$/.exec(c))) {
    const exp = Number(m[2]);
    if (exp > 7) return { error: `A multiplier digit of ${exp} would be over 1 GΩ: check the reading.` };
    return { value: clean(Number(m[1]) * Math.pow(10, exp)), format: `4-digit (${m[1]} × 10^${exp})`, tol: '±1 %' };
  }
  if (/^\d+$/.test(c)) return { error: `${c.length} digits: resistor codes have 3 or 4.` };
  return { error: 'not a 3-digit, 4-digit, R-notation or EIA-96 code.' };
}

function decodeCapacitor(c) {
  let m;
  if ((m = /^(\d{2})(\d)$/.exec(c))) {
    const d = Number(m[2]);
    if (d === 7) return { error: 'A multiplier digit of 7 is not used in capacitor codes.' };
    const mult = d === 8 ? 0.01 : d === 9 ? 0.1 : Math.pow(10, d);
    return { value: clean(Number(m[1]) * mult * 1e-12), format: `3-digit pF (${m[1]} × ${mult} pF)`, tol: 'not in the code: see the letter after it (J ±5 %, K ±10 %, M ±20 %)' };
  }
  if ((m = /^(\d*)[Rr](\d*)$/.exec(c)) && (m[1] || m[2])) {
    return { value: clean(Number(`${m[1] || '0'}.${m[2] || '0'}`) * 1e-12), format: 'R-notation pF', tol: 'small C0G parts, often ±0.1 or ±0.25 pF' };
  }
  if ((m = /^(\d*)([pnuµ])(\d*)$/.exec(c)) && (m[1] || m[3])) {
    const mult = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6 }[m[2]];
    return { value: clean(Number(`${m[1] || '0'}.${m[3] || '0'}`) * mult), format: `${m[2]}-notation`, tol: 'see datasheet' };
  }
  if ((m = /^([A-Za-z])(\d)$/.exec(c))) {
    if (!(m[1] in EIA198)) return { error: `"${m[1]}" is not an EIA-198 letter (case matters: a b d e f m n t y are lower case).` };
    const d = Number(m[2]);
    const mult = d === 9 ? 0.1 : Math.pow(10, d);
    return { value: clean(EIA198[m[1]] * mult * 1e-12), format: `EIA-198 (${m[1]} = ${EIA198[m[1]]}, ×${mult} pF)`, tol: 'not in the code' };
  }
  if (/^\d{4}$/.test(c)) return { error: 'Four digits is a resistor code (or a date code); capacitors use three.' };
  return { error: 'not a 3-digit pF, R-notation or EIA-198 code. Most MLCCs are not marked at all.' };
}

// The other ways the same value is written.
function encodeResistor(v) {
  if (v === 0) return ['0', '000', '0000'];
  const out = [];
  const dec = (x) => { const s = String(clean(x)); return s.includes('.') ? s.replace('.', 'R') : `${s}R0`; };
  if (v < 10) out.push(dec(v));
  else for (let e = 0; e <= 8; e++) { const ab = v / Math.pow(10, e); if (Math.abs(ab - Math.round(ab)) < 1e-9 && ab >= 10 && ab <= 99) { out.push(`${Math.round(ab)}${e}`); break; } }
  if (v < 100) { const s = clean(v).toString(); const [i, f = ''] = s.split('.'); const code = `${i}R${f}`.padEnd(4, '0'); if (code.replace('R', '').length <= 3) out.push(code); }
  else for (let e = 0; e <= 7; e++) { const abc = v / Math.pow(10, e); if (Math.abs(abc - Math.round(abc)) < 1e-9 && abc >= 100 && abc <= 999) { out.push(`${Math.round(abc)}${e}`); break; } }
  for (const [mult, L] of EIA96_LETTER) {
    const n = v / mult;
    const i = EIA96.findIndex((x) => Math.abs(x - n) < 1e-6);
    if (i >= 0) { out.push(`${String(i + 1).padStart(2, '0')}${L}`); break; }
  }
  return [...new Set(out)];
}

function encodeCapacitor(v) {
  const pf = clean(v * 1e12);
  const out = [];
  if (pf < 10) out.push(String(pf).replace('.', 'R').replace(/^(\d+)$/, '$1R0'));
  for (let e = 0; e <= 6; e++) { const ab = pf / Math.pow(10, e); if (Math.abs(ab - Math.round(ab)) < 1e-9 && ab >= 10 && ab <= 99) { out.push(`${Math.round(ab)}${e}`); break; } }
  for (const [L, man] of Object.entries(EIA198)) {
    for (let d = -1; d <= 8; d++) {
      if (Math.abs(man * Math.pow(10, d) - pf) < 1e-9 * Math.max(1, pf)) out.push(`${L}${d === -1 ? 9 : d}`);
    }
  }
  return [...new Set(out)];
}

// How each printed character is read, for the page's drawing: groups of
// characters with their role and meaning. Same patterns as the decoders above.
//   role: sig (significant digits), mult (multiplier), point (decimal point /
//   unit letter), index (EIA-96 table index), mant (EIA-198 mantissa letter),
//   zero (jumper), bad (not read)
const sup = (n) => String(n).replace(/-/g, '⁻').split('').map((ch) => '⁰¹²³⁴⁵⁶⁷⁸⁹⁻'['0123456789⁻'.indexOf(ch)] || ch).join('');
function groupsFor(c, cap, d) {
  if (d.error) return [{ chars: c, role: 'bad', meaning: 'not read' }];
  const G = [];
  const add = (chars, role, meaning) => { if (chars) G.push({ chars, role, meaning }); };
  let m;
  if (!cap && /^0+$/.test(c)) { add(c, 'zero', 'jumper, 0 Ω'); return G; }
  if (cap && (m = /^(\d{2})(\d)$/.exec(c))) {
    const n = Number(m[2]);
    add(m[1], 'sig', m[1]); add(m[2], 'mult', n === 8 ? '× 0.01 pF' : n === 9 ? '× 0.1 pF' : `× 10${sup(n)} pF`); return G;
  }
  if ((m = /^(\d*)([Rr])(\d*)$/.exec(c))) { add(m[1], 'sig', m[1]); add(m[2], 'point', cap ? 'decimal point, pF' : 'decimal point'); add(m[3], 'sig', m[3]); return G; }
  if (!cap && (m = /^(\d*)(m)(\d*)$/.exec(c))) { add(m[1], 'sig', m[1]); add(m[2], 'point', 'point, in mΩ'); add(m[3], 'sig', m[3]); return G; }
  if (!cap && (m = /^(\d+)([kKM])(\d*)$/.exec(c))) { add(m[1], 'sig', m[1]); add(m[2], 'point', m[2] === 'M' ? 'point, in MΩ' : 'point, in kΩ'); add(m[3], 'sig', m[3]); return G; }
  if (cap && (m = /^(\d*)([pnuµ])(\d*)$/.exec(c))) { add(m[1], 'sig', m[1]); add(m[2], 'point', `point, in ${m[2] === 'u' ? 'µ' : m[2]}F`); add(m[3], 'sig', m[3]); return G; }
  if (!cap && (m = /^(\d{2})([A-Za-z])$/.exec(c))) {
    const L = m[2].toUpperCase();
    add(m[1], 'index', `E96 #${Number(m[1])} = ${EIA96[Number(m[1]) - 1]}`); add(m[2], 'mult', `× ${EIA96_MULT[L]}`); return G;
  }
  if (!cap && (m = /^(\d{2,3})(\d)$/.exec(c))) { add(m[1], 'sig', m[1]); add(m[2], 'mult', `× 10${sup(Number(m[2]))}`); return G; }
  if (cap && (m = /^([A-Za-z])(\d)$/.exec(c))) {
    const n = Number(m[2]);
    add(m[1], 'mant', `${EIA198[m[1]]}`); add(m[2], 'mult', n === 9 ? '× 0.1 pF' : `× 10${sup(n)} pF`); return G;
  }
  return [{ chars: c, role: 'bad', meaning: 'not read' }];
}

// What a printed character can be turned to, for the page's steppers.
export const WHEELS = {
  digit: '0123456789',
  eia96: 'ZYRXSABHCDEF',
  eia198: Object.keys(EIA198).join(''),
};

export function run({ codes, kind }) {
  const cap = kind === 'capacitor';
  const list = String(codes || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  if (!list.length) return { warnings: ['Give a marking, e.g. 103 or 4R7.'] };
  const warnings = [];
  const rows = [];
  const parts = [];
  let first = null;
  for (const c of list.slice(0, 50)) {
    const d = cap ? decodeCapacitor(c) : decodeResistor(c);
    if (d.error) {
      rows.push([c, '–', 'not read', d.error, '']); warnings.push(`${c}: ${d.error}`);
      parts.push({ code: c, ok: false, error: d.error, groups: groupsFor(c, cap, d) });
      continue;
    }
    const val = cap ? fmtEng(d.value, 'F') : fmtEng(d.value, 'Ω');
    const alsoList = (cap ? encodeCapacitor(d.value) : encodeResistor(d.value)).filter((x) => x !== c);
    const also = alsoList.join(', ');
    rows.push([c, val, d.format, d.tol + (d.note ? `; ${d.note}` : ''), also]);
    parts.push({ code: c, ok: true, value: d.value, text: val, base: cap ? `${clean(d.value * 1e12)} pF` : `${clean(d.value)} Ω`,
      format: d.format, tol: d.tol, note: d.note || null, also: alsoList, groups: groupsFor(c, cap, d) });
    if (d.note) warnings.push(`${c}: ${d.note}.`);
    if (!first) first = { c, d, val };
  }
  if (list.length > 50) warnings.push(`Only the first 50 of ${list.length} codes were decoded.`);
  const values = first ? [
    { label: `Code ${first.c}`, value: first.val, tone: 'ok', hint: first.d.format },
    { label: 'In base units', value: cap ? `${clean(first.d.value * 1e12)} pF` : `${clean(first.d.value)} Ω` },
    { label: 'Usual tolerance', value: first.d.tol },
    { label: 'Decoded', value: `${rows.filter((r) => r[1] !== '–').length} of ${rows.length}` },
  ] : [{ label: 'Decoded', value: `0 of ${rows.length}`, tone: 'bad' }];
  return {
    values,
    warnings,
    parts,
    tables: [{ title: cap ? 'Capacitor codes' : 'Resistor codes', columns: ['Code', 'Value', 'Read as', 'Tolerance / note', 'Also written'], rows }],
    notes: cap ? [
      '3-digit capacitor codes are in pF: 104 = 10 × 10^4 pF = 100 nF; a 9 as the last digit means × 0.1 (109 = 1 pF).',
      'Most MLCCs carry no marking; tantalum and electrolytic parts print the value and voltage directly.',
    ] : [
      '3-digit codes are usually ±5 % (E24), 4-digit and EIA-96 codes ±1 % (E96).',
      'EIA-96 letters: Z ×0.001, Y/R ×0.01, X/S ×0.1, A ×1, B/H ×10, C ×100, D ×1k, E ×10k, F ×100k.',
      'A bar under a code, or an extra letter, can be a maker-specific mark: check the datasheet when a value looks wrong.',
    ],
  };
}
