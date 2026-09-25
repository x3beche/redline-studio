// Compact binary log format ("deferred formatting", the idea behind ARM ITM
// printf offload, Zephyr dictionary logging and Rust defmt): the device sends
// a message id, level, timestamp and the raw arguments; the format strings
// stay on the host in a dictionary. This tool lays the record out, sizes it
// against printf text, and generates the C encoder and a Python decoder.
//   COBS framing overhead: 1 byte per 254 data bytes + a 0x00 delimiter
//     (Cheshire & Baker, IEEE/ACM ToN 1999).
//   CRC-8/SMBUS (poly 0x07, init 0, check 0xF4) and CRC-16/CCITT-FALSE
//     (poly 0x1021, init 0xFFFF, check 0x29B1), per the CRC RevEng catalogue.
//   UART load: 10 bits per byte (8N1).
import { fmtEng, fmtNum } from '../kit/eng.js';

const TYPES = {
  u8: { c: 'uint8_t', py: 'B', size: 1, digits: 3 }, i8: { c: 'int8_t', py: 'b', size: 1, digits: 4 },
  u16: { c: 'uint16_t', py: 'H', size: 2, digits: 5 }, i16: { c: 'int16_t', py: 'h', size: 2, digits: 6 },
  u32: { c: 'uint32_t', py: 'I', size: 4, digits: 10 }, i32: { c: 'int32_t', py: 'i', size: 4, digits: 11 },
  u64: { c: 'uint64_t', py: 'Q', size: 8, digits: 20 }, i64: { c: 'int64_t', py: 'q', size: 8, digits: 20 },
  f32: { c: 'float', py: 'f', size: 4, digits: 10 }, f64: { c: 'double', py: 'd', size: 8, digits: 14 },
  bool: { c: 'bool', py: '?', size: 1, digits: 5 },
};
const LEVELS = {
  none: { bits: 0, names: [] },
  l4: { bits: 2, names: ['DEBUG', 'INFO', 'WARN', 'ERROR'] },
  l8: { bits: 3, names: ['TRACE', 'DEBUG', 'INFO', 'NOTICE', 'WARN', 'ERROR', 'CRITICAL', 'FATAL'] },
};
const TS = {
  none: { size: 0, c: null, py: null, wrap: null, unit: '' },
  u16ms: { size: 2, c: 'uint16_t', py: 'H', wrap: 65536e-3, unit: 'ms' },
  u32ms: { size: 4, c: 'uint32_t', py: 'I', wrap: 4294967296e-3, unit: 'ms' },
  u32us: { size: 4, c: 'uint32_t', py: 'I', wrap: 4294967296e-6, unit: 'µs' },
};

const snake = (s) => String(s).trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase() || 'msg';
const h2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');

function crc8(bytes) { let c = 0; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xFF : (c << 1) & 0xFF; } return c; }
function crc16(bytes) { let c = 0xFFFF; for (const b of bytes) { c ^= b << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; } return c; }
function cobs(bytes) {
  const out = [0]; let codeAt = 0, code = 1;
  for (const b of bytes) {
    if (b === 0) { out[codeAt] = code; codeAt = out.length; out.push(0); code = 1; continue; }
    out.push(b); code++;
    if (code === 0xFF) { out[codeAt] = code; codeAt = out.length; out.push(0); code = 1; }
  }
  out[codeAt] = code;
  return out;
}

export function run({ messages, levels, ts, framing, check, baud }) {
  const warnings = [], notes = [];
  const L = LEVELS[levels] || LEVELS.l4, T = TS[ts] || TS.u32ms;
  const rows = (messages || []).filter((r) => String(r.name || '').trim() || String(r.text || '').trim());
  if (!rows.length) return { warnings: ['Add at least one message: a name, its text with {} for each argument, the argument types (u8, i16, f32 …) and how often it is logged.'] };

  const seen = new Set();
  const msgs = rows.map((r, id) => {
    const row = (messages || []).indexOf(r);
    let name = snake(r.name || `msg${id}`);
    if (seen.has(name)) { warnings.push(`Two messages are called "${name}"; the second is renamed ${name}_${id}.`); name = `${name}_${id}`; }
    seen.add(name);
    const types = String(r.args || '').split(/[\s,;]+/).filter(Boolean).map((t) => t.toLowerCase());
    const bad = types.filter((t) => !TYPES[t]);
    if (bad.length) warnings.push(`${name}: unknown argument type(s) ${bad.join(', ')}; use ${Object.keys(TYPES).join(', ')}. They are left out.`);
    const args = types.filter((t) => TYPES[t]);
    const text = String(r.text || name);
    const holes = (text.match(/\{[^}]*\}/g) || []).length;
    if (holes !== args.length) warnings.push(`${name}: the text has ${holes} {} placeholder(s) but ${args.length} argument(s). Make them match or the host prints it wrong.`);
    let rate = Number(String(r.rate ?? '').trim());
    if (!Number.isFinite(rate) || rate < 0) { if (String(r.rate ?? '').trim()) warnings.push(`${name}: rate "${r.rate}" is not a number; 0 is used.`); rate = 0; }
    return { id, name, text, args, rate, row, holes };
  });

  const idBits = Math.max(1, Math.ceil(Math.log2(msgs.length)));
  const hdrBits = idBits + L.bits;
  const hdrBytes = hdrBits <= 8 ? 1 : hdrBits <= 16 ? 2 : 0;
  if (!hdrBytes) return { warnings: ['More than 8192 messages do not fit a 16-bit header.'] };
  const crcBytes = check === 'crc16' ? 2 : check === 'crc8' ? 1 : 0;
  const frameOver = (inner) => (framing === 'cobs' ? 2 + Math.floor(inner / 254) : framing === 'sync' ? 2 : 0);

  let binBps = 0, txtBps = 0;
  const table = msgs.map((m) => {
    const payload = m.args.reduce((a, t) => a + TYPES[t].size, 0);
    const inner = hdrBytes + T.size + payload + crcBytes;
    const wire = inner + frameOver(inner);
    if (framing === 'sync' && inner > 255) warnings.push(`${m.name}: ${inner}-byte record is too long for the 1-byte length field.`);
    // printf equivalent: "[ 1234.567] W text with args\r\n", args at their widest
    const fixed = m.text.replace(/\{[^}]*\}/g, '').length;
    const txt = (T.size ? 13 : 0) + (L.bits ? 2 : 0) + fixed + m.args.reduce((a, t) => a + TYPES[t].digits, 0) + 2;
    m.payload = payload; m.inner = inner; m.wire = wire; m.txt = txt;
    binBps += wire * m.rate; txtBps += txt * m.rate;
    return [m.id, m.name, m.args.join(' ') || '–', payload, wire, txt, fmtNum(m.rate, 4), fmtNum(wire * m.rate, 4), fmtNum(txt * m.rate, 4)];
  });
  const maxWire = Math.max(...msgs.map((m) => m.wire)), maxInner = Math.max(...msgs.map((m) => m.inner));

  const values = [
    { label: 'Header', value: `${hdrBytes} B`, hint: `${idBits}-bit id${L.bits ? ` + ${L.bits}-bit level` : ''}` },
    { label: 'Record size', value: `${Math.min(...msgs.map((m) => m.wire))}–${maxWire} B`, hint: 'on the wire, framing included' },
    { label: 'Binary log rate', value: fmtNum(binBps, 4), unit: 'B/s' },
    { label: 'Same as printf text', value: fmtNum(txtBps, 4), unit: 'B/s', hint: 'args at their widest' },
    { label: 'Saving', value: txtBps > 0 ? `${fmtNum(txtBps / Math.max(binBps, 1e-9), 3)}×` : '–', tone: 'ok' },
  ];
  if (baud > 0) {
    const lb = (binBps * 10) / baud, lt = (txtBps * 10) / baud;
    values.push({ label: 'UART load, binary', value: fmtNum(lb * 100, 3), unit: '%', tone: lb > 0.7 ? 'bad' : lb > 0.5 ? 'warn' : 'ok', hint: `${fmtNum(baud, 6)} baud 8N1` });
    values.push({ label: 'UART load, text', value: fmtNum(lt * 100, 3), unit: '%', tone: lt > 0.7 ? 'bad' : lt > 0.5 ? 'warn' : 'ok' });
    if (lb > 0.7) warnings.push(`The binary log needs ${fmtNum(lb * 100, 3)} % of the UART: raise the baud rate, lower the rates of the busiest messages, or drop records when the buffer is full (and count the drops).`);
  }
  if (T.wrap) values.push({ label: 'Timestamp wraps after', value: T.wrap < 120 ? `${fmtNum(T.wrap, 4)} s` : T.wrap < 7200 ? `${fmtNum(T.wrap / 60, 4)} min` : `${fmtNum(T.wrap / 86400, 4)} days` });
  if (ts === 'u16ms') notes.push('A 16-bit ms timestamp wraps every 65.5 s: the host must unwrap it, which only works if some record arrives at least once per wrap.');
  if (framing === 'none') warnings.push('Without framing a lost byte desynchronises everything after it. Use COBS (2 bytes per record) unless the channel is lossless (RTT, a file).');
  if (check === 'none' && framing !== 'none') notes.push('No checksum: a corrupted record decodes into wrong numbers silently. CRC-8 costs 1 byte.');

  // ---------- generated code ----------
  const lvlParam = L.bits ? 'uint8_t level, ' : '';
  const hdrExpr = L.bits ? `((uint${hdrBytes * 8}_t)level << ${idBits}) | LOG_ID_${'X'}` : 'LOG_ID_X';
  const c = [];
  c.push('/* log_fmt.h - compact binary log records (generated by Redline Log Format Designer).', ' * Little-endian MCU assumed (Cortex-M, ESP32, RISC-V). Provide log_write() and log_timestamp(). */',
    '#pragma once', '#include <stdint.h>', '#include <stddef.h>', '#include <stdbool.h>', '#include <string.h>', '');
  if (L.bits) c.push(`enum log_level { ${L.names.map((n, i) => `LOG_${n} = ${i}`).join(', ')} };`);
  c.push(`enum log_id {\n${msgs.map((m) => `  LOG_ID_${m.name.toUpperCase()} = ${m.id},  /* ${m.text.replace(/\*\//g, '* /')} */`).join('\n')}\n};`, '');
  c.push(`#define LOG_MAX_RECORD ${maxInner}`, `#define LOG_MAX_WIRE ${maxWire}`, '');
  c.push('void log_write(const uint8_t *data, size_t len);   /* your sink: UART DMA, RTT, flash ring */');
  if (T.size) c.push(`${T.c} log_timestamp(void);                       /* ${T.unit} since boot */`);
  c.push('');
  if (check === 'crc8') c.push('static inline uint8_t log_crc8(const uint8_t *p, size_t n) {  /* CRC-8/SMBUS */',
    '  uint8_t c = 0;', '  while (n--) { c ^= *p++; for (int i = 0; i < 8; i++) c = (c & 0x80) ? (uint8_t)((c << 1) ^ 0x07) : (uint8_t)(c << 1); }', '  return c;', '}', '');
  if (check === 'crc16') c.push('static inline uint16_t log_crc16(const uint8_t *p, size_t n) {  /* CRC-16/CCITT-FALSE */',
    '  uint16_t c = 0xFFFF;', '  while (n--) { c ^= (uint16_t)(*p++) << 8; for (int i = 0; i < 8; i++) c = (c & 0x8000) ? (uint16_t)((c << 1) ^ 0x1021) : (uint16_t)(c << 1); }', '  return c;', '}', '');
  c.push('static inline void log_emit(uint8_t *r, size_t n) {');
  if (check === 'crc8') c.push('  r[n] = log_crc8(r, n); n += 1;');
  if (check === 'crc16') c.push('  uint16_t crc = log_crc16(r, n); r[n++] = (uint8_t)crc; r[n++] = (uint8_t)(crc >> 8);');
  if (framing === 'cobs') c.push('  uint8_t out[LOG_MAX_WIRE]; size_t o = 1, code_at = 0; uint8_t code = 1;',
    '  for (size_t i = 0; i < n; i++) {', '    if (r[i] == 0) { out[code_at] = code; code_at = o++; code = 1; continue; }',
    '    out[o++] = r[i];', '    if (++code == 0xFF) { out[code_at] = code; code_at = o++; code = 1; }', '  }',
    '  out[code_at] = code; out[o++] = 0x00;  /* frame delimiter */', '  log_write(out, o);');
  else if (framing === 'sync') c.push('  uint8_t out[LOG_MAX_WIRE]; out[0] = 0xA5; out[1] = (uint8_t)n;', '  memcpy(out + 2, r, n);', '  log_write(out, n + 2);');
  else c.push('  log_write(r, n);');
  c.push('}', '');
  for (const m of msgs) {
    const params = m.args.map((t, i) => `${TYPES[t].c} a${i}`).join(', ');
    c.push(`/* ${m.text.replace(/\*\//g, '* /')} */`);
    c.push(`static inline void log_${m.name}(${(lvlParam + params).replace(/, $/, '') || 'void'}) {`);
    c.push(`  uint8_t r[${m.inner}]; size_t n = 0;`);
    c.push(`  uint${hdrBytes * 8}_t h = ${hdrExpr.replace('LOG_ID_X', `LOG_ID_${m.name.toUpperCase()}`)};`);
    c.push(hdrBytes === 1 ? '  r[n++] = (uint8_t)h;' : '  r[n++] = (uint8_t)h; r[n++] = (uint8_t)(h >> 8);');
    if (T.size) c.push(`  ${T.c} t = log_timestamp(); memcpy(r + n, &t, ${T.size}); n += ${T.size};`);
    m.args.forEach((t, i) => c.push(t === 'bool' ? `  r[n++] = a${i} ? 1 : 0;` : `  memcpy(r + n, &a${i}, ${TYPES[t].size}); n += ${TYPES[t].size};`));
    c.push('  log_emit(r, n);', '}', '');
  }

  const py = [];
  py.push('#!/usr/bin/env python3', '"""Decode the binary log (generated by Redline Log Format Designer).', 'Usage: python3 log_decode.py capture.bin   (or pipe bytes on stdin)"""', 'import struct, sys', '');
  py.push(`ID_BITS = ${idBits}`, `LEVELS = ${JSON.stringify(L.names)}`, `TS_FMT = ${T.py ? `"<${T.py}"` : 'None'}  # ${T.unit || 'no timestamp'}`, `HDR_FMT = "<${hdrBytes === 1 ? 'B' : 'H'}"`, '');
  py.push('MSGS = {', ...msgs.map((m) => `    ${m.id}: (${JSON.stringify(m.name)}, ${JSON.stringify(m.text)}, "<${m.args.map((t) => TYPES[t].py).join('')}"),`), '}', '');
  if (check === 'crc8') py.push('def crc_ok(r):', '    c = 0', '    for b in r[:-1]:', '        c ^= b', '        for _ in range(8):', '            c = ((c << 1) ^ 0x07) & 0xFF if c & 0x80 else (c << 1) & 0xFF', '    return c == r[-1], r[:-1]', '');
  else if (check === 'crc16') py.push('def crc_ok(r):', '    c = 0xFFFF', '    for b in r[:-2]:', '        c ^= b << 8', '        for _ in range(8):', '            c = ((c << 1) ^ 0x1021) & 0xFFFF if c & 0x8000 else (c << 1) & 0xFFFF', '    return c == (r[-2] | r[-1] << 8), r[:-2]', '');
  else py.push('def crc_ok(r):', '    return True, r', '');
  if (framing === 'cobs') py.push('def cobs_decode(b):', '    out, i = bytearray(), 0', '    while i < len(b):', '        code = b[i]', '        if code == 0 or i + code > len(b):', '            return None', '        out += b[i + 1:i + code]', '        i += code', '        if code < 0xFF and i < len(b):', '            out.append(0)', '    return bytes(out)', '',
    'def records(stream):', '    for chunk in stream.split(b"\\x00"):', '        if chunk:', '            r = cobs_decode(chunk)', '            if r is None:', '                print("# bad COBS frame:", chunk.hex(" "))', '            else:', '                yield r', '');
  else if (framing === 'sync') py.push('def records(stream):', '    i = 0', '    while i + 2 <= len(stream):', '        if stream[i] != 0xA5:', '            i += 1', '            continue', '        n = stream[i + 1]', '        if i + 2 + n > len(stream):', '            break', '        yield stream[i + 2:i + 2 + n]', '        i += 2 + n', '');
  else py.push('def records(stream):', '    # no framing: lengths come from the dictionary', '    i = 0', '    while i < len(stream):', '        h = struct.unpack_from(HDR_FMT, stream, i)[0]', '        m = MSGS.get(h & ((1 << ID_BITS) - 1))', '        if m is None:', '            print("# unknown id, stream lost sync at", i)', '            return', `        n = struct.calcsize(HDR_FMT) + (struct.calcsize(TS_FMT) if TS_FMT else 0) + struct.calcsize(m[2]) + ${crcBytes}`, '        yield stream[i:i + n]', '        i += n', '');
  py.push('def decode(r):', '    ok, r = crc_ok(r)', '    if not ok:', '        return "# CRC error: " + r.hex(" ")', '    off = 0', '    h = struct.unpack_from(HDR_FMT, r, off)[0]; off += struct.calcsize(HDR_FMT)',
    '    mid, lvl = h & ((1 << ID_BITS) - 1), h >> ID_BITS', '    t = None', '    if TS_FMT:', '        t = struct.unpack_from(TS_FMT, r, off)[0]; off += struct.calcsize(TS_FMT)', '    if mid not in MSGS:', '        return f"# unknown id {mid}: " + r.hex(" ")',
    '    name, text, fmt = MSGS[mid]', '    if len(r) - off != struct.calcsize(fmt):', '        return f"# {name}: {len(r) - off} payload bytes, expected {struct.calcsize(fmt)}"', '    args = struct.unpack_from(fmt, r, off)',
    '    lv = (LEVELS[lvl] if lvl < len(LEVELS) else str(lvl)) + " " if LEVELS else ""', '    ts = f"[{t:>10}] " if t is not None else ""', '    return ts + lv + text.format(*args)', '',
    'if __name__ == "__main__":', '    data = open(sys.argv[1], "rb").read() if len(sys.argv) > 1 else sys.stdin.buffer.read()', '    for rec in records(data):', '        print(decode(rec))', '');

  // An example record: a message with arguments 1, 2, 3 … at t = 1000.
  const lvl = L.bits ? L.names.indexOf('INFO') : 0;
  const record = (m0) => {
  const rec = [];
  const h = (lvl << idBits) | m0.id;
  rec.push(h & 0xFF); if (hdrBytes === 2) rec.push(h >> 8);
  const dv = new DataView(new ArrayBuffer(8));
  const put = (size, setter) => { setter(); for (let i = 0; i < size; i++) rec.push(dv.getUint8(i)); };
  if (T.size === 2) put(2, () => dv.setUint16(0, 1000, true));
  if (T.size === 4) put(4, () => dv.setUint32(0, 1000, true));
  m0.args.forEach((t, i) => {
    const v = i + 1;
    if (t === 'f32') put(4, () => dv.setFloat32(0, v + 0.5, true));
    else if (t === 'f64') put(8, () => dv.setFloat64(0, v + 0.5, true));
    else if (t === 'bool') rec.push(1);
    else if (TYPES[t].size === 8) put(8, () => dv.setBigUint64(0, BigInt(v), true));
    else put(TYPES[t].size, () => { for (let k = 0; k < 8; k++) dv.setUint8(k, 0); dv.setUint8(0, v); });
  });
  if (check === 'crc8') rec.push(crc8(rec));
  if (check === 'crc16') { const cc = crc16(rec); rec.push(cc & 0xFF, cc >> 8); }
  const wire = framing === 'cobs' ? [...cobs(rec), 0] : framing === 'sync' ? [0xA5, rec.length, ...rec] : rec;
  const exArgs = m0.args.map((t, i) => (t === 'f32' || t === 'f64' ? i + 1.5 : t === 'bool' ? 'true' : i + 1));
  return { rec, wire, exArgs, h };
  };
  const m0 = msgs[0];
  const { wire, exArgs } = record(m0);

  // The record of every message byte by byte, for the page to draw: the
  // fields in wire order (COBS keeps each byte in place, one code byte ahead
  // of it) with the example bytes.
  const layout = {
    idBits, levelBits: L.bits, levelNames: L.names, exampleLevel: L.bits ? L.names[lvl] : null, hdrBytes, tsSize: T.size, tsUnit: T.unit, tsType: T.c,
    tsWrap: T.wrap, crcBytes, framing, check, levels, ts, baud: baud > 0 ? baud : null, capacity: baud > 0 ? baud / 10 : null,
    binBps, txtBps, loadBin: baud > 0 ? (binBps * 10) / baud : null, loadTxt: baud > 0 ? (txtBps * 10) / baud : null,
    saving: txtBps > 0 ? txtBps / Math.max(binBps, 1e-9) : null,
    messages: msgs.map((m) => {
      const r = record(m);
      const fields = [];
      if (framing === 'cobs') fields.push({ kind: 'cobs', bytes: 1 + Math.floor(m.inner / 254), label: 'COBS' });
      if (framing === 'sync') fields.push({ kind: 'sync', bytes: 1, label: 'sync' }, { kind: 'len', bytes: 1, label: 'len' });
      fields.push({ kind: 'hdr', bytes: hdrBytes, label: 'header' });
      if (T.size) fields.push({ kind: 'ts', bytes: T.size, label: `time ${T.unit}` });
      m.args.forEach((t, i) => fields.push({ kind: 'arg', bytes: TYPES[t].size, label: t, type: t, i }));
      if (crcBytes) fields.push({ kind: 'crc', bytes: crcBytes, label: check === 'crc8' ? 'CRC-8' : 'CRC-16' });
      if (framing === 'cobs') fields.push({ kind: 'delim', bytes: 1, label: '00' });
      return { id: m.id, row: m.row, name: m.name, text: m.text, args: m.args, holes: m.holes, rate: m.rate, payload: m.payload, inner: m.inner, wire: m.wire, txt: m.txt,
        binBps: m.wire * m.rate, txtBps: m.txt * m.rate, fields, header: r.h, record: r.rec, bytes: r.wire, exArgs: r.exArgs };
    }),
  };

  notes.push(`Header: ${L.bits ? `level in the top ${L.bits} bits, ` : ''}message id in the low ${idBits} bit${idBits > 1 ? 's' : ''}; then the timestamp, then the arguments little-endian, packed with no padding${crcBytes ? `, then the CRC (${crcBytes} B)` : ''}.`);
  notes.push('Text size assumes each argument printed at its widest (u16 as 5 digits, f32 as 10 characters) plus a "[  1234.567] " stamp and CR LF.');
  notes.push('Keep the dictionary (the Python MSGS table) with each firmware build: a changed id order decodes old logs wrongly. Add new messages at the end.');

  return {
    values,
    warnings,
    layout,
    tables: [
      { title: 'Record layout', columns: ['Field', 'Bytes', 'Content'],
        rows: [
          ...(framing === 'sync' ? [['Sync + length', 2, '0xA5, record length']] : []),
          ['Header', hdrBytes, `${L.bits ? `level (${L.bits} bits) | ` : ''}id (${idBits} bit${idBits > 1 ? 's' : ''})`],
          ...(T.size ? [['Timestamp', T.size, `${T.c}, ${T.unit}`]] : []),
          ['Arguments', `0–${Math.max(...msgs.map((m) => m.payload))}`, 'raw, little-endian'],
          ...(crcBytes ? [['CRC', crcBytes, check === 'crc8' ? 'CRC-8/SMBUS' : 'CRC-16/CCITT-FALSE, low byte first']] : []),
          ...(framing === 'cobs' ? [['COBS overhead + 0x00', `${2}+`, '1 code byte per 254, then the delimiter']] : []),
        ] },
      { title: 'Messages', columns: ['Id', 'Name', 'Args', 'Payload B', 'Wire B', 'Text B', 'Rate /s', 'Binary B/s', 'Text B/s'], rows: table },
    ],
    texts: [
      { title: 'log_fmt.h', lang: 'c', body: c.join('\n') },
      { title: 'log_decode.py', lang: 'python', body: py.join('\n') },
      { title: 'Example record', body: `log_${m0.name}(${[L.bits ? `LOG_${L.names[lvl]}` : null, ...exArgs].filter((x) => x != null).join(', ')}) at t = 1000:\n${wire.map(h2).join(' ')}\n\ndecodes to: ${T.size ? '[      1000] ' : ''}${L.bits ? L.names[lvl] + ' ' : ''}${(() => { let k = 0; return m0.text.replace(/\{[^}]*\}/g, () => String(exArgs[k++] ?? '{}')); })()}\n` },
    ],
    notes,
  };
}
