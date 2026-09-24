// CRC over bytes, the Rocksoft / Ross Williams parameter model
// ("A Painless Guide to CRC Error Detection Algorithms", 1993): width, poly,
// init, refin, refout, xorout. Presets and their check values (the CRC of
// the ASCII string "123456789") come from Greg Cook's CRC RevEng catalogue.
//
// The bitwise algorithm (MSB-first register, reflected input bytes when
// refin, reflected register at the end when refout):
//   reg = init
//   for each byte b: reg ^= (refin ? reflect8(b) : b) << (width - 8)
//     8 times: reg = (reg & topbit) ? (reg << 1) ^ poly : reg << 1
//   crc = (refout ? reflect(reg, width) : reg) ^ xorout

export const PRESETS = {
  'CRC-8': { w: 8, poly: 0x07, init: 0x00, refin: false, refout: false, xorout: 0x00, check: 0xF4, alias: 'CRC-8/SMBUS' },
  'CRC-8/MAXIM': { w: 8, poly: 0x31, init: 0x00, refin: true, refout: true, xorout: 0x00, check: 0xA1, alias: 'Dallas/Maxim 1-Wire' },
  'CRC-8/AUTOSAR': { w: 8, poly: 0x2F, init: 0xFF, refin: false, refout: false, xorout: 0xFF, check: 0xDF },
  'CRC-8/SAE-J1850': { w: 8, poly: 0x1D, init: 0xFF, refin: false, refout: false, xorout: 0xFF, check: 0x4B },
  'CRC-8/NRSC-5': { w: 8, poly: 0x31, init: 0xFF, refin: false, refout: false, xorout: 0x00, check: 0xF7, alias: 'Sensirion SHT3x/SCD4x' },
  'CRC-16/CCITT-FALSE': { w: 16, poly: 0x1021, init: 0xFFFF, refin: false, refout: false, xorout: 0x0000, check: 0x29B1, alias: 'CRC-16/IBM-3740' },
  'CRC-16/XMODEM': { w: 16, poly: 0x1021, init: 0x0000, refin: false, refout: false, xorout: 0x0000, check: 0x31C3, alias: 'CRC-16/ACORN, LTE' },
  'CRC-16/KERMIT': { w: 16, poly: 0x1021, init: 0x0000, refin: true, refout: true, xorout: 0x0000, check: 0x2189, alias: 'CRC-16/CCITT (true)' },
  'CRC-16/X-25': { w: 16, poly: 0x1021, init: 0xFFFF, refin: true, refout: true, xorout: 0xFFFF, check: 0x906E, alias: 'HDLC' },
  'CRC-16/MODBUS': { w: 16, poly: 0x8005, init: 0xFFFF, refin: true, refout: true, xorout: 0x0000, check: 0x4B37 },
  'CRC-16/ARC': { w: 16, poly: 0x8005, init: 0x0000, refin: true, refout: true, xorout: 0x0000, check: 0xBB3D, alias: 'CRC-16, CRC-16/LHA' },
  'CRC-16/USB': { w: 16, poly: 0x8005, init: 0xFFFF, refin: true, refout: true, xorout: 0xFFFF, check: 0xB4C8 },
  'CRC-32': { w: 32, poly: 0x04C11DB7, init: 0xFFFFFFFF, refin: true, refout: true, xorout: 0xFFFFFFFF, check: 0xCBF43926, alias: 'CRC-32/ISO-HDLC: zlib, Ethernet, PNG' },
  'CRC-32C': { w: 32, poly: 0x1EDC6F41, init: 0xFFFFFFFF, refin: true, refout: true, xorout: 0xFFFFFFFF, check: 0xE3069283, alias: 'Castagnoli: iSCSI, SCTP, ext4' },
  'CRC-32/BZIP2': { w: 32, poly: 0x04C11DB7, init: 0xFFFFFFFF, refin: false, refout: false, xorout: 0xFFFFFFFF, check: 0xFC891918 },
  'CRC-32/MPEG-2': { w: 32, poly: 0x04C11DB7, init: 0xFFFFFFFF, refin: false, refout: false, xorout: 0x00000000, check: 0x0376E6E7, alias: 'STM32 CRC unit default (on bytes)' },
};

const mask = (w) => (w === 32 ? 0xFFFFFFFF : (1 << w) - 1);
const hex = (v, w) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(Math.ceil(w / 4), '0');

function reflect(v, w) {
  let r = 0;
  for (let i = 0; i < w; i++) if (v & (2 ** i)) r += 2 ** (w - 1 - i);
  return r >>> 0;
}

export function crc(bytes, p) {
  const { w } = p;
  const m = mask(w), top = 2 ** (w - 1);
  let reg = p.init >>> 0;
  for (const b0 of bytes) {
    const b = p.refin ? reflect(b0, 8) : b0;
    reg = ((reg ^ (b * 2 ** (w - 8))) >>> 0) & m;
    reg >>>= 0;
    for (let i = 0; i < 8; i++) {
      const hi = reg >= top;
      reg = ((reg * 2) % (2 ** w)) >>> 0; // shift left inside w bits
      if (hi) reg = (reg ^ p.poly) >>> 0;
      reg = (reg & m) >>> 0;
    }
  }
  if (p.refout) reg = reflect(reg, w);
  return ((reg ^ p.xorout) & m) >>> 0;
}

// ---- input bytes ----
export function toBytes(data, format) {
  const s = String(data ?? '');
  if (format === 'hex') {
    const clean = s.replace(/0x/gi, '').replace(/\\x/gi, '').replace(/[\s,;:_\-{}[\]]/g, '');
    const bad = clean.match(/[^0-9a-fA-F]/g);
    if (bad) return { error: `Not hex: "${[...new Set(bad)].slice(0, 6).join('')}". Write bytes like 01 A2 FF or 0x01, 0xA2.` };
    if (clean.length % 2) return { error: `Odd number of hex digits (${clean.length}): each byte needs two, e.g. 0F not F.` };
    const out = [];
    for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
    return { bytes: out };
  }
  if (format === 'escaped') {
    // C escapes make single bytes; every other character is UTF-8 encoded
    const out = [];
    const re = /\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|[nrtabfv\\"'?])|([\s\S])/gu;
    const ESC = { n: 10, r: 13, t: 9, a: 7, b: 8, f: 12, v: 11, '\\': 92, '"': 34, "'": 39, '?': 63 };
    let m;
    while ((m = re.exec(s))) {
      const e = m[1];
      if (e == null) out.push(...utf8(m[2]));
      else if (e[0] === 'x') out.push(parseInt(e.slice(1), 16));
      else if (/^[0-7]+$/.test(e)) out.push(parseInt(e, 8) & 0xFF);
      else out.push(ESC[e]);
    }
    return { bytes: out };
  }
  return { bytes: utf8(s) };
}

function utf8(str) {
  const out = [];
  for (const ch of str) {
    let c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function parseHexNum(t) {
  const s = String(t ?? '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,8}$/.test(s)) return null;
  return parseInt(s, 16) >>> 0;
}

function cCode(name, p) {
  const T = p.w === 8 ? 'uint8_t' : p.w === 16 ? 'uint16_t' : 'uint32_t';
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const lines = [
    `#include <stdint.h>`, `#include <stddef.h>`, ``,
    `/* ${name}: width ${p.w}, poly ${hex(p.poly, p.w)}, init ${hex(p.init, p.w)}, refin ${p.refin}, refout ${p.refout}, xorout ${hex(p.xorout, p.w)} */`,
    `${T} ${id}(const uint8_t *data, size_t len)`, `{`, `    ${T} crc = ${hex(p.init, p.w)}u;`,
  ];
  if (p.refin && p.refout) {
    // reflected algorithm: shift right with the reflected polynomial
    lines.push(`    while (len--) {`, `        crc ^= *data++;`, `        for (int i = 0; i < 8; i++)`,
      `            crc = (crc & 1u) ? (${T})((crc >> 1) ^ ${hex(reflect(p.poly, p.w), p.w)}u) : (${T})(crc >> 1);`, `    }`);
  } else if (!p.refin && !p.refout) {
    lines.push(`    while (len--) {`, `        crc ^= (${T})((${T})*data++ << ${p.w - 8});`, `        for (int i = 0; i < 8; i++)`,
      `            crc = (crc & ${hex(2 ** (p.w - 1), p.w)}u) ? (${T})((crc << 1) ^ ${hex(p.poly, p.w)}u) : (${T})(crc << 1);`, `    }`);
  } else {
    lines.push(`    /* refin != refout: uncommon, reflect by hand */`, `    while (len--) {`, `        uint8_t b = *data++;`,
      ...(p.refin ? [`        b = (uint8_t)(((b * 0x0802u & 0x22110u) | (b * 0x8020u & 0x88440u)) * 0x10101u >> 16); /* reflect8 */`] : []),
      `        crc ^= (${T})((${T})b << ${p.w - 8});`, `        for (int i = 0; i < 8; i++)`,
      `            crc = (crc & ${hex(2 ** (p.w - 1), p.w)}u) ? (${T})((crc << 1) ^ ${hex(p.poly, p.w)}u) : (${T})(crc << 1);`, `    }`,
      ...(p.refout ? [`    { ${T} r = 0; for (int i = 0; i < ${p.w}; i++) if (crc & ((${T})1u << i)) r |= (${T})1u << (${p.w - 1} - i); crc = r; }`] : []));
  }
  lines.push(`    return (${T})(crc ^ ${hex(p.xorout, p.w)}u);`, `}`);
  return lines.join('\n');
}

export function run({ data, format, preset, width, poly, init, refin, refout, xorout }) {
  const warnings = [];
  const got = toBytes(data, format);
  if (got.error) return { warnings: [got.error] };
  const bytes = got.bytes;
  let p, name;
  if (preset === 'custom') {
    const w = Number(width) || 16;
    const P = parseHexNum(poly), I = parseHexNum(init), X = parseHexNum(xorout);
    if (P == null || I == null || X == null) {
      return { warnings: [`Give polynomial, init and xorout as hex, e.g. 1021, FFFF, 0000 (up to 8 hex digits). Unreadable: ${[['polynomial', P], ['init', I], ['xorout', X]].filter((x) => x[1] == null).map((x) => x[0]).join(', ')}.`] };
    }
    const m = mask(w);
    for (const [k, v] of [['Polynomial', P], ['Init', I], ['Xorout', X]]) {
      if (v > m) warnings.push(`${k} ${hex(v, 32)} is wider than ${w} bits: only the low ${w} bits are used (${hex(v & m, w)}).`);
    }
    if (!((P & m) & 1)) warnings.push('The polynomial is even (its x^0 term is missing): every CRC standard has it odd, and an even one detects fewer errors. Check you wrote it in normal (MSB-first) form without the implicit top bit, e.g. 0x1021 for CRC-CCITT.');
    p = { w, poly: (P & m) >>> 0, init: (I & m) >>> 0, refin: !!refin, refout: !!refout, xorout: (X & m) >>> 0 };
    name = `Custom CRC-${w}`;
  } else {
    p = PRESETS[preset] || PRESETS['CRC-32'];
    name = PRESETS[preset] ? preset : 'CRC-32';
  }
  const v = crc(bytes, p);
  const nb = p.w / 8;
  const be = Array.from({ length: nb }, (_, i) => (v >>> (8 * (nb - 1 - i))) & 0xFF);
  const hb = (arr) => arr.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  const check = crc([...'123456789'].map((c) => c.charCodeAt(0)), p);
  if (p.check != null && check !== p.check) warnings.push(`Internal check failed: ${name} of "123456789" gave ${hex(check, p.w)}, catalogue says ${hex(p.check, p.w)}.`);
  if (!bytes.length) warnings.push('No data: the CRC shown is of zero bytes (init ^ xorout after reflection). Paste text or hex bytes.');

  const values = [
    { label: name, value: hex(v, p.w), tone: 'ok', hint: `${bytes.length} byte${bytes.length === 1 ? '' : 's'} in` },
    { label: 'Decimal', value: String(v) },
    { label: 'Bytes, big endian', value: hb(be), hint: 'MSB first' },
    { label: 'Bytes, little endian', value: hb([...be].reverse()), hint: 'as a uint on ARM/x86' },
    { label: 'Check ("123456789")', value: hex(check, p.w), hint: p.check != null ? 'matches the catalogue' : 'compare with your datasheet' },
  ];
  const rows = Object.entries(PRESETS).map(([n, q]) => [
    n, q.w, hex(q.poly, q.w), hex(q.init, q.w), q.refin ? 'yes' : 'no', q.refout ? 'yes' : 'no', hex(q.xorout, q.w), hex(crc(bytes, q), q.w), q.alias || '',
  ]);
  const notes = [
    'Polynomials are written in normal (MSB-first) form without the implicit top bit: CRC-32 is 0x04C11DB7, its reflected form 0xEDB88320 is what the C code uses when refin and refout are set.',
    'Which bytes go on the wire in which order is protocol-specific: Modbus RTU sends the CRC low byte first; most big-endian protocols send it high byte first.',
    'To find an unknown CRC: compute your device\'s CRC over "123456789" and look for that check value in the table\'s catalogue column set.',
  ];
  if (preset === 'CRC-32/MPEG-2') notes.push('The STM32 CRC peripheral (default settings) computes CRC-32/MPEG-2 on 32-bit words written to CRC->DR: fed byte-wise from a little-endian buffer it gives a different result unless you reorder each word\'s bytes.');
  return {
    values,
    warnings,
    tables: [{ title: 'The same data under every preset', columns: ['Preset', 'Width', 'Poly', 'Init', 'RefIn', 'RefOut', 'XorOut', 'CRC', 'Also known as'], rows }],
    texts: [{ title: 'C code', body: cCode(name, p), lang: 'c' }],
    notes,
  };
}
