// The same bytes read as integers and IEEE 754 floats in every byte order,
// and a value written out as bytes in every order. Byte orders for 32-bit
// values use the Modbus/PLC names: ABCD = big endian, DCBA = little endian,
// CDAB = word swapped (little-endian words of big-endian bytes, common for
// Modbus floats), BADC = byte swapped inside big-endian words.
// Reading and writing go through DataView (ECMAScript ArrayBuffer spec).

const TYPES = {
  u8: { size: 1, get: 'getUint8', set: 'setUint8', name: 'uint8_t' },
  i8: { size: 1, get: 'getInt8', set: 'setInt8', name: 'int8_t' },
  u16: { size: 2, get: 'getUint16', set: 'setUint16', name: 'uint16_t' },
  i16: { size: 2, get: 'getInt16', set: 'setInt16', name: 'int16_t' },
  u32: { size: 4, get: 'getUint32', set: 'setUint32', name: 'uint32_t' },
  i32: { size: 4, get: 'getInt32', set: 'setInt32', name: 'int32_t' },
  f32: { size: 4, get: 'getFloat32', set: 'setFloat32', name: 'float', float: true },
  u64: { size: 8, get: 'getBigUint64', set: 'setBigUint64', name: 'uint64_t', big: true },
  i64: { size: 8, get: 'getBigInt64', set: 'setBigInt64', name: 'int64_t', big: true },
  f64: { size: 8, get: 'getFloat64', set: 'setFloat64', name: 'double', float: true },
};

// Byte permutations applied before a big-endian read: out[i] = in[perm[i]]
const ORDERS = {
  2: [['Big endian (AB)', [0, 1]], ['Little endian (BA)', [1, 0]]],
  4: [['Big endian (ABCD)', [0, 1, 2, 3]], ['Little endian (DCBA)', [3, 2, 1, 0]], ['Word swap (CDAB)', [2, 3, 0, 1]], ['Byte swap (BADC)', [1, 0, 3, 2]]],
  8: [['Big endian', [0, 1, 2, 3, 4, 5, 6, 7]], ['Little endian', [7, 6, 5, 4, 3, 2, 1, 0]], ['Word swap (16-bit words reversed)', [6, 7, 4, 5, 2, 3, 0, 1]], ['Byte swap in words', [1, 0, 3, 2, 5, 4, 7, 6]]],
};

const hb = (arr) => arr.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

function parseBytes(s) {
  const clean = String(s ?? '').replace(/0x/gi, '').replace(/\\x/gi, '').replace(/[\s,;:_\-{}[\]]/g, '');
  const bad = clean.match(/[^0-9a-fA-F]/g);
  if (bad) return { error: `Not hex: "${[...new Set(bad)].slice(0, 6).join('')}". Write bytes like 12 34 56 78 or 0x12, 0x34.` };
  if (clean.length % 2) return { error: `Odd number of hex digits (${clean.length}): each byte needs two, e.g. 0F not F.` };
  const out = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return { bytes: out };
}

// Shortest decimal that reads back to the same float32 / float64
function fmtFloat(v, single) {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? '+Inf' : '-Inf';
  if (Object.is(v, -0)) return '-0';
  const a = Math.abs(v);
  const sci = a !== 0 && (a >= 1e7 || a < 1e-4);
  const max = single ? 9 : 17;
  for (let p = 1; p <= max; p++) {
    const s = v.toPrecision(p);
    const back = single ? Math.fround(Number(s)) : Number(s);
    if (back === v) return sci ? Number(s).toExponential(p - 1) : String(Number(s));
  }
  return sci ? v.toExponential(max - 1) : v.toPrecision(max);
}

function read(bytes, t) {
  const T = TYPES[t];
  const dv = new DataView(new Uint8Array(bytes).buffer);
  const v = dv[T.get](0, false);
  if (T.float) return fmtFloat(v, t === 'f32');
  return v.toString();
}

function write(value, t, order) {
  const T = TYPES[t];
  const dv = new DataView(new ArrayBuffer(T.size));
  dv[T.set](0, value, false); // big endian first
  const be = Array.from(new Uint8Array(dv.buffer));
  return order.map((i) => be[i]);
}

function parseValue(text, t) {
  const T = TYPES[t];
  const s = String(text ?? '').trim().replace(/_/g, '');
  if (!s) return { error: 'Give a value, e.g. 1000, -5, 0x1234 or 3.14.' };
  if (T.float) {
    if (/^[-+]?(inf|infinity)$/i.test(s)) return { v: s[0] === '-' ? -Infinity : Infinity };
    if (/^nan$/i.test(s)) return { v: NaN };
    const v = Number(s);
    if (!Number.isFinite(v)) return { error: `"${s}" is not a number. Write it like 3.14, -1e-3, inf or nan.` };
    const out = { v };
    if (t === 'f32' && Math.abs(v) > 3.4028234663852886e38) out.warn = `${s} is beyond float's range (±3.4e38): it is stored as infinity.`;
    else if (t === 'f32' && Math.fround(v) !== v) out.warn = `${s} is not exactly representable as a float: stored as ${fmtFloat(Math.fround(v), true)} (${Math.fround(v).toPrecision(12)}…).`;
    return out;
  }
  let big;
  try {
    if (/^[-+]?0x[0-9a-f]+$/i.test(s)) big = (s[0] === '-' ? -1n : 1n) * BigInt(s.replace(/^[-+]/, ''));
    else if (/^[-+]?0b[01]+$/i.test(s)) big = (s[0] === '-' ? -1n : 1n) * BigInt(s.replace(/^[-+]/, ''));
    else if (/^[-+]?\d+$/.test(s)) big = BigInt(s);
    else return { error: `"${s}" is not an integer. Write it like 1000, -5, 0x1234 or 0b1010.` };
  } catch { return { error: `"${s}" is not an integer.` }; }
  const bits = BigInt(T.size * 8);
  const signed = t[0] === 'i';
  const lo = signed ? -(1n << (bits - 1n)) : 0n;
  const hi = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
  const out = {};
  // A hex/binary literal for a signed type is a bit pattern: 0xFFFF as int16 = -1
  if (signed && /^0[xb]/i.test(s) && big > hi && big < (1n << bits)) big -= 1n << bits;
  if (big < lo || big > hi) {
    out.warn = `${s} does not fit ${T.name} (${lo} … ${hi}): only its low ${bits} bits are stored.`;
    big = BigInt.asUintN(Number(bits), big);
    if (signed) big = BigInt.asIntN(Number(bits), big);
  }
  out.v = T.big ? big : Number(big);
  return out;
}

export function run({ mode, bytes, offset, value, type }) {
  const warnings = [];
  if (mode === 'value') {
    const t = TYPES[type] ? type : 'u32';
    const T = TYPES[t];
    const p = parseValue(value, t);
    if (p.error) return { warnings: [p.error] };
    if (p.warn) warnings.push(p.warn);
    const orders = T.size === 1 ? [['Single byte', [0]]] : ORDERS[T.size];
    const rows = orders.map(([n, o]) => {
      const b = write(p.v, t, o);
      return [n, hb(b), '{ ' + b.map((x) => '0x' + x.toString(16).toUpperCase().padStart(2, '0')).join(', ') + ' }'];
    });
    const le = write(p.v, t, [...Array(T.size).keys()].reverse());
    const be = write(p.v, t, [...Array(T.size).keys()]);
    return {
      values: [
        { label: `${T.name} value`, value: read(be, t) },
        { label: 'In memory on ARM / x86 (little endian)', value: hb(le), tone: 'ok' },
        { label: 'On the wire, network order (big endian)', value: hb(be) },
      ],
      warnings,
      tables: [{ title: `${T.name} ${String(value).trim()} as bytes, lowest address first`, columns: ['Order', 'Bytes', 'C initializer'], rows }],
      notes: ['Bytes are listed in address / transmission order: the first byte is at the lowest address or is sent first.',
        'Network byte order (TCP/IP, most fieldbuses except Modbus register contents) is big endian; ARM Cortex-M, x86 and RISC-V memory is little endian.'],
    };
  }

  const got = parseBytes(bytes);
  if (got.error) return { warnings: [got.error] };
  const off = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  if (offset != null && !(Number.isInteger(offset) && offset >= 0)) warnings.push('Offset must be a whole number of bytes, 0 or more: using 0.');
  const all = got.bytes;
  const b = all.slice(off);
  if (!b.length) return { warnings: [...warnings, all.length ? `Offset ${off} is past the end of the ${all.length} bytes given.` : 'Give some hex bytes, e.g. 40 49 0F DB.'] };
  const rows = [];
  for (const [t, T] of Object.entries(TYPES)) {
    if (T.size > b.length) continue;
    const w = b.slice(0, T.size);
    if (T.size === 1) { rows.push([T.name, read(w, t), '', '', '']); continue; }
    const ords = ORDERS[T.size];
    const cells = ords.map(([, o]) => read(o.map((i) => w[i]), t));
    rows.push([T.name, cells[1], cells[0], cells[2] ?? '', cells[3] ?? '']);
  }
  const values = [
    { label: 'Bytes read', value: `${b.length}${off ? ` from offset ${off}` : ''}`, hint: hb(b.slice(0, 8)) + (b.length > 8 ? ' …' : '') },
  ];
  if (b.length >= 2) {
    const n = Math.min(b.length, 4) >= 4 ? 4 : 2;
    const w = b.slice(0, n);
    const v = (arr) => '0x' + arr.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');
    values.push(
      { label: `Little endian ${n * 8}-bit`, value: v([...w].reverse()), hint: 'ARM, x86, RISC-V memory' },
      { label: `Big endian ${n * 8}-bit`, value: v(w), hint: 'network order' },
    );
    if (b.length >= 4) {
      const f = read([...w].reverse(), 'f32');
      const g = read(w, 'f32');
      values.push({ label: 'float, LE / BE', value: `${f} / ${g}` });
    }
  }
  if (b.length > 8) warnings.push(`Only the first 8 of ${b.length} bytes are interpreted. Use the offset to look further into the buffer.`);
  // A float that is tiny, huge or NaN in one order and ordinary in the other is a strong hint
  const notes = ['Word swap (CDAB) is how many Modbus devices send 32-bit floats and longs in two registers, low word first.',
    'Bytes are given in address / reception order: the first byte is at the lowest address or arrived first.'];
  return {
    values,
    warnings,
    tables: [{ title: 'The bytes as each type', columns: ['Type', 'Little endian', 'Big endian', 'Word swap', 'Byte swap'], rows }],
    notes,
  };
}
