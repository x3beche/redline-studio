/** A QR code, made here: byte mode, error correction M, versions 1-10 (up
 *  to 213 bytes - an address, a short text). No dependency and no web
 *  service: Settings > Mobile app draws the download link with it
 *  (mobile-settings.ts). The steps are the standard's (ISO/IEC 18004), as
 *  Nayuki's reference encoder lays them out: data codewords, Reed-Solomon
 *  blocks interleaved, the function patterns, the codewords in their zigzag,
 *  then the mask with the lowest penalty and its format bits.
 *
 *  `qrMatrix(text)` gives the modules (true = dark), `qrPath(text)` an SVG
 *  path of the dark ones with a 4-module quiet zone, for a viewBox of
 *  `0 0 n n` where n is the returned size. */

// Version 1..10, error correction M.
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_M = 0;                       // the two format bits of level M

function rawModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

function dataCodewords(ver: number): number {
  return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];
}

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < degree) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const r = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (r.shift() as number);
    r.push(0);
    divisor.forEach((d, i) => (r[i] ^= gfMul(d, factor)));
  }
  return r;
}

function alignPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

class Grid {
  readonly m: boolean[][];
  readonly fn: boolean[][];
  readonly size: number;
  constructor(size: number) {
    this.size = size;
    this.m = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  set(x: number, y: number, dark: boolean) { this.m[y][x] = dark; this.fn[y][x] = true; }
}

function drawFormat(g: Grid, mask: number) {
  const data = (FORMAT_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;
  const n = g.size;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
  g.set(8, 7, bit(6));
  g.set(8, 8, bit(7));
  g.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.set(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.set(8, n - 15 + i, bit(i));
  g.set(8, n - 8, true);
}

function drawFunctions(g: Grid, ver: number) {
  const n = g.size;
  for (let i = 0; i < n; i++) { g.set(6, i, i % 2 === 0); g.set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      g.set(x, y, d !== 2 && d !== 4);
    }
  }
  const al = alignPositions(ver), k = al.length;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === k - 1) || (i === k - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
      g.set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormat(g, 0);                       // reserved now, written for real once the mask is chosen
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = ((bits >>> i) & 1) !== 0, a = n - 11 + (i % 3), c = Math.floor(i / 3);
      g.set(a, c, b);
      g.set(c, a, b);
    }
  }
}

function codewords(bytes: number[], ver: number): number[] {
  const cap = dataCodewords(ver);
  const bits: number[] = [];
  const put = (v: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  bytes.forEach(b => put(b, 8));
  put(0, Math.min(4, cap * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);
  // Split into blocks, add each one's error correction, interleave.
  const nb = BLOCKS[ver], ecl = ECC_PER_BLOCK[ver], raw = Math.floor(rawModules(ver) / 8);
  const short = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const div = rsDivisor(ecl);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - ecl + (i < short ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < short) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++)
    blocks.forEach((b, j) => { if (i !== shortLen - ecl || j >= short) out.push(b[i]); });
  return out;
}

function placeData(g: Grid, data: number[]) {
  const n = g.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < n; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? n - 1 - v : v;
      if (!g.fn[y][x] && i < data.length * 8) {
        g.m[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
        i++;
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(g: Grid, mask: number) {
  for (let y = 0; y < g.size; y++) for (let x = 0; x < g.size; x++)
    if (!g.fn[y][x] && MASKS[mask](x, y)) g.m[y][x] = !g.m[y][x];
}

/** The standard's four penalty rules: runs, 2x2 blocks, finder look-alikes, balance. */
function penalty(m: boolean[][]): number {
  const n = m.length;
  let p = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < n; i++) { lines.push(m[i]); lines.push(m.map(r => r[i])); }
  const finder = [true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else { if (run >= 5) p += run - 2; run = 1; }
    }
    for (let i = 0; i + 7 <= n; i++) {
      if (!finder.every((f, k) => line[i + k] === f)) continue;
      const before = i >= 4 && [1, 2, 3, 4].every(k => !line[i - k]);
      const after = i + 11 <= n && [7, 8, 9, 10].every(k => !line[i + k]);
      if (before || after) p += 40;
    }
  }
  let dark = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (m[y][x]) dark++;
    if (x + 1 < n && y + 1 < n && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
  }
  p += (Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1) * 10;
  return p;
}

export function qrMatrix(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1;
  while (ver <= 10 && dataCodewords(ver) * 8 < 4 + (ver < 10 ? 8 : 16) + bytes.length * 8) ver++;
  if (ver > 10) throw new Error('too long for a QR code here');
  const data = codewords(bytes, ver);
  let best: boolean[][] | null = null, bestP = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = new Grid(ver * 4 + 17);
    drawFunctions(g, ver);
    placeData(g, data);
    applyMask(g, mask);
    drawFormat(g, mask);
    const p = penalty(g.m);
    if (p < bestP) { bestP = p; best = g.m; }
  }
  return best!;
}

/** The dark modules as one SVG path, with a 4-module quiet zone around. */
export function qrPath(text: string): { d: string; size: number } {
  const m = qrMatrix(text), q = 4;
  let d = '';
  m.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x + q} ${y + q}h1v1h-1z`; }));
  return { d, size: m.length + 2 * q };
}
