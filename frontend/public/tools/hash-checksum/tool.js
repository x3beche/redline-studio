// Hashes and simple checksums of text or bytes, all in plain JS so the tool
// stays pure and synchronous (no WebCrypto, no Node crypto):
//   MD5      RFC 1321            SHA-1    FIPS 180-4 section 6.1
//   SHA-256  FIPS 180-4 6.2      SHA-512  FIPS 180-4 6.4 (BigInt words)
//   CRC-32   ISO-HDLC / zlib (poly 0xEDB88320 reflected)
//   Adler-32 RFC 1950 section 8.2  Fletcher-16 / Fletcher-32 (J. Fletcher 1982)
//   8-bit sum, two's-complement sum (Intel HEX record checksum), XOR (LRC)

// ---- bytes in ----
function utf8(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function toBytes(data, format) {
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
  if (format === 'base64') {
    const clean = s.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return { error: 'Not Base64: only A-Z, a-z, 0-9, + / (or - _) and trailing = are allowed.' };
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const body = clean.replace(/=+$/, '');
    if (body.length % 4 === 1) return { error: 'Base64 length is wrong (one character too many or missing): check it was copied whole.' };
    const out = [];
    let acc = 0, bits = 0;
    for (const ch of body) {
      acc = (acc << 6) | A.indexOf(ch); bits += 6;
      if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xFF); }
    }
    return { bytes: out };
  }
  return { bytes: utf8(s) };
}

const hx = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
const w32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const rotl = (x, n) => (x << n) | (x >>> (32 - n));
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

// ---- MD5, RFC 1321 ----
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
function md5(bytes) {
  const n = bytes.length;
  const msg = [...bytes, 0x80];
  while (msg.length % 64 !== 56) msg.push(0);
  const bitLen = n * 8;
  for (let i = 0; i < 8; i++) msg.push(Math.floor(bitLen / 2 ** (8 * i)) & 255); // little-endian length
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < msg.length; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => msg[off + 4 * i] | (msg[off + 4 * i + 1] << 8) | (msg[off + 4 * i + 2] << 16) | (msg[off + 4 * i + 3] << 24));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MD5_K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, MD5_S[(i >> 4) * 4 + (i % 4)])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  return hx([a0, b0, c0, d0].flatMap((v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]));
}

// Merkle-Damgard padding with a big-endian bit length, 64-byte blocks
function padBE(bytes, block = 64, lenBytes = 8) {
  const msg = [...bytes, 0x80];
  while (msg.length % block !== block - lenBytes) msg.push(0);
  const bitLen = bytes.length * 8;
  for (let i = lenBytes - 1; i >= 0; i--) msg.push(i >= 6 ? 0 : Math.floor(bitLen / 2 ** (8 * i)) & 255);
  return msg;
}

// ---- SHA-1, FIPS 180-4 6.1 ----
function sha1(bytes) {
  const msg = padBE(bytes);
  let h = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
  for (let off = 0; off < msg.length; off += 64) {
    const W = new Array(80);
    for (let t = 0; t < 16; t++) W[t] = (msg[off + 4 * t] << 24) | (msg[off + 4 * t + 1] << 16) | (msg[off + 4 * t + 2] << 8) | msg[off + 4 * t + 3];
    for (let t = 16; t < 80; t++) W[t] = rotl(W[t - 3] ^ W[t - 8] ^ W[t - 14] ^ W[t - 16], 1);
    let [a, b, c, d, e] = h;
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = t < 20 ? 0x5A827999 : t < 40 ? 0x6ED9EBA1 : t < 60 ? 0x8F1BBCDC : 0xCA62C1D6;
      const T = (rotl(a, 5) + f + e + k + W[t]) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = T;
    }
    h = h.map((v, i) => (v + [a, b, c, d, e][i]) | 0);
  }
  return hx(h.flatMap((v) => w32(v >>> 0)));
}

// ---- SHA-256, FIPS 180-4 6.2 ----
const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
function sha256(bytes) {
  const msg = padBE(bytes);
  let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  for (let off = 0; off < msg.length; off += 64) {
    const W = new Array(64);
    for (let t = 0; t < 16; t++) W[t] = (msg[off + 4 * t] << 24) | (msg[off + 4 * t + 1] << 16) | (msg[off + 4 * t + 2] << 8) | msg[off + 4 * t + 3];
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const T1 = (hh + S1 + ((e & f) ^ (~e & g)) + K256[t] + W[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const T2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + T1) | 0; d = c; c = b; b = a; a = (T1 + T2) | 0;
    }
    h = h.map((v, i) => (v + [a, b, c, d, e, f, g, hh][i]) | 0);
  }
  return hx(h.flatMap((v) => w32(v >>> 0)));
}

// ---- SHA-512, FIPS 180-4 6.4, 64-bit words as BigInt ----
const K512 = [
  '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc', '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118',
  'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2', '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694',
  'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65', '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
  '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4', 'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70',
  '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df', '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b',
  'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30', 'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
  '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8', '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3',
  '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec', '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b',
  'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178', '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
  '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c', '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817',
].map((h) => BigInt('0x' + h));
const M64 = (1n << 64n) - 1n;
const rotr64 = (x, n) => ((x >> n) | (x << (64n - n))) & M64;
function sha512(bytes) {
  const msg = padBE(bytes, 128, 16);
  let h = ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1', '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179'].map((v) => BigInt('0x' + v));
  for (let off = 0; off < msg.length; off += 128) {
    const W = new Array(80);
    for (let t = 0; t < 16; t++) {
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(msg[off + 8 * t + i]);
      W[t] = v;
    }
    for (let t = 16; t < 80; t++) {
      const s0 = rotr64(W[t - 15], 1n) ^ rotr64(W[t - 15], 8n) ^ (W[t - 15] >> 7n);
      const s1 = rotr64(W[t - 2], 19n) ^ rotr64(W[t - 2], 61n) ^ (W[t - 2] >> 6n);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) & M64;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 80; t++) {
      const S1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const T1 = (hh + S1 + ((e & f) ^ (~e & M64 & g)) + K512[t] + W[t]) & M64;
      const S0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const T2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) & M64;
      hh = g; g = f; f = e; e = (d + T1) & M64; d = c; c = b; b = a; a = (T1 + T2) & M64;
    }
    h = h.map((v, i) => (v + [a, b, c, d, e, f, g, hh][i]) & M64);
  }
  return h.map((v) => v.toString(16).padStart(16, '0')).join('');
}

// ---- checksums ----
const CRC_T = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = CRC_T[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function adler32(bytes) { // RFC 1950: A = 1 + sum, B = sum of A, mod 65521
  let a = 1, b = 0;
  for (const x of bytes) { a = (a + x) % 65521; b = (b + a) % 65521; }
  return ((b * 65536) + a) >>> 0;
}
function fletcher16(bytes) { // mod 255 sums over bytes
  let a = 0, b = 0;
  for (const x of bytes) { a = (a + x) % 255; b = (b + a) % 255; }
  return (b << 8) | a;
}
function fletcher32(bytes) { // mod 65535 sums over 16-bit little-endian words, odd byte zero-padded
  let a = 0, b = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    const w = bytes[i] | ((bytes[i + 1] ?? 0) << 8);
    a = (a + w) % 65535; b = (b + a) % 65535;
  }
  return ((b * 65536) + a) >>> 0;
}

const h8 = (v) => '0x' + v.toString(16).toUpperCase().padStart(2, '0');
const h16 = (v) => '0x' + v.toString(16).toUpperCase().padStart(4, '0');
const h32 = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

export function run({ data, format, expect }) {
  const got = toBytes(data, format);
  if (got.error) return { warnings: [got.error] };
  const bytes = got.bytes;
  const warnings = [];
  const MAX = 1 << 20;
  if (bytes.length > MAX) return { warnings: [`${bytes.length} bytes is more than this tool hashes in the page (1 MiB). Use sha256sum / md5sum on the file.`] };
  if (!bytes.length) warnings.push('No data: the values shown are for zero bytes (the empty-input hashes). Paste text, hex or Base64.');

  const sum = bytes.reduce((s, b) => s + b, 0);
  const rows = [
    ['MD5', md5(bytes), '128-bit'],
    ['SHA-1', sha1(bytes), '160-bit'],
    ['SHA-256', sha256(bytes), '256-bit'],
    ['SHA-512', sha512(bytes), '512-bit'],
    ['CRC-32', h32(crc32(bytes)), 'zlib / Ethernet / PNG / ZIP'],
    ['Adler-32', h32(adler32(bytes)), 'zlib stream trailer (RFC 1950)'],
    ['Fletcher-32', h32(fletcher32(bytes)), '16-bit little-endian words, mod 65535'],
    ['Fletcher-16', h16(fletcher16(bytes)), 'bytes, mod 255'],
    ['Sum (8-bit)', h8(sum & 255), 'sum of bytes mod 256'],
    ['Sum (16-bit)', h16(sum & 0xFFFF), 'sum of bytes mod 65536'],
    ['Two\'s complement sum', h8((256 - (sum & 255)) & 255), 'Intel HEX: bytes + it = 0 mod 256'],
    ['XOR (LRC)', h8(bytes.reduce((x, b) => x ^ b, 0)), 'XOR of all bytes, e.g. NMEA 0183'],
  ];
  const values = [
    { label: 'Bytes', value: String(bytes.length) },
    { label: 'SHA-256', value: rows[2][1].slice(0, 16) + '…', hint: 'full value in the table' },
    { label: 'CRC-32', value: rows[4][1] },
  ];
  const e = String(expect ?? '').trim().toLowerCase().replace(/^0x/, '').replace(/[\s:-]/g, '');
  if (e) {
    const hit = rows.find((r) => r[1].toLowerCase().replace(/^0x/, '') === e);
    if (hit) values.unshift({ label: 'Expected value', value: `matches ${hit[0]}`, tone: 'ok' });
    else {
      values.unshift({ label: 'Expected value', value: 'no match', tone: 'bad' });
      warnings.push(`The expected value matches none of the results. Check the input format (${format}), a trailing newline or CR/LF line endings, and that the hash was made over the same bytes.`);
    }
  }
  const notes = [
    format === 'text' ? 'Text is hashed as UTF-8 exactly as typed: a trailing newline or Windows CR/LF line ending changes every hash.' : `Input read as ${format === 'hex' ? 'hex bytes' : 'Base64'}.`,
    'Hashes are shown lowercase hex (as sha256sum prints them); checksums as 0x-prefixed hex. The List tab has every value on one line each, for copying.',
    'MD5 and SHA-1 are broken for security (practical collisions): use them only to match a published checksum. SHA-256 is the default for firmware images and downloads.',
  ];
  return {
    values,
    warnings,
    tables: [
      { title: 'Hashes', columns: ['Algorithm', 'Value'], rows: rows.slice(0, 4).map((r) => [r[0], r[1]]) },
      { title: 'Checksums', columns: ['Algorithm', 'Value', 'Note'], rows: rows.slice(4) },
    ],
    texts: [{ title: 'List', body: rows.map((r) => `${r[0].padEnd(22)} ${r[1]}`).join('\n') }],
    notes,
  };
}
