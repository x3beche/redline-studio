// Modbus request frame builder.
// PDU layouts: Modbus Application Protocol V1.1b3 §6 (function codes 01–06, 15, 16).
// RTU ADU: address + PDU + CRC-16/MODBUS (poly 0x8005 reflected = 0xA001,
//   init 0xFFFF), CRC sent low byte first — Modbus over Serial Line V1.02 §2.5.1.2, §6.2.2.
// ASCII ADU: ':' + hex(address + PDU + LRC) + CR LF, LRC = two's complement of the
//   8-bit sum — ibid. §2.5.2.2, §6.2.1.
// TCP ADU: MBAP header (transaction id, protocol id 0, length = unit id + PDU,
//   unit id) + PDU — Modbus Messaging on TCP/IP V1.0b §3.1.3.
// Serial character: RTU 11 bits (start + 8 data + even parity + stop, 8E1), ASCII
//   10 bits (start + 7 data + parity + stop, 7E1) — Serial Line V1.02 §2.5.1.1, §2.5.2.1.
// RTU timing: t3.5 = 3.5 characters, fixed at 1.75 ms
//   above 19200 baud (Serial Line §2.5.1.1).
import { fmtEng, fmtNum } from '../kit/eng.js';

const FUNCS = {
  1: { name: 'Read Coils', table: 'coil', ref: 0, maxQ: 2000 },
  2: { name: 'Read Discrete Inputs', table: 'discrete input', ref: 10001, maxQ: 2000 },
  3: { name: 'Read Holding Registers', table: 'holding register', ref: 40001, maxQ: 125 },
  4: { name: 'Read Input Registers', table: 'input register', ref: 30001, maxQ: 125 },
  5: { name: 'Write Single Coil', table: 'coil', ref: 1 },
  6: { name: 'Write Single Register', table: 'holding register', ref: 40001 },
  15: { name: 'Write Multiple Coils', table: 'coil', ref: 1, maxQ: 1968 },
  16: { name: 'Write Multiple Registers', table: 'holding register', ref: 40001, maxQ: 123 },
};

export function crc16(bytes) {
  let crc = 0xFFFF;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
  }
  return crc;
}
const lrc = (bytes) => (-bytes.reduce((a, b) => a + b, 0)) & 0xFF;
const h2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const hx = (v, n = 4) => '0x' + v.toString(16).toUpperCase().padStart(n, '0');

function num(t) {
  const s = String(t ?? '').trim();
  if (!s) return null;
  if (/^[-+]?0x[0-9a-f]+$/i.test(s)) return (s.startsWith('-') ? -1 : 1) * parseInt(s.replace(/^[-+]/, ''), 16);
  if (/^[-+]?\d+$/.test(s)) return Number(s);
  if (/^[01]$/.test(s)) return Number(s);
  if (/^(on|true|high)$/i.test(s)) return 1;
  if (/^(off|false|low)$/i.test(s)) return 0;
  return null;
}

export function run({ mode, slave, fc, address, addrStyle, quantity, values, tid, baud }) {
  const warnings = [], notes = [];
  const f = Number(fc);
  const F = FUNCS[f];
  if (!F) return { warnings: ['Choose a function code: 1, 2, 3, 4, 5, 6, 15 or 16.'] };
  let unit = num(slave);
  if (unit == null || unit < 0 || unit > 255) return { warnings: [`Slave address "${slave}" must be 0–255 (1–247 for devices, 0 = broadcast).`] };
  if (mode !== 'tcp' && (unit > 247)) warnings.push(`Slave ${unit} is in the reserved range 248–255 on a serial line; use 1–247.`);
  if (unit === 0 && f <= 4) warnings.push('Address 0 is broadcast: no device answers a read sent to it.');

  // Address: raw PDU address, or 1-based PLC reference (40001 = holding register 0).
  let a = num(address);
  if (a == null) return { warnings: [`Start address "${address}" is not a number (decimal, or hex as 0x…).`] };
  let refNote = '';
  if (addrStyle === 'plc') {
    let base = F.ref || 1;
    if (F.ref === 0) base = 1;
    // Accept 40001-style and 400001-style (6-digit) references; otherwise treat as 1-based offset.
    if (base > 1 && a >= base && a < base + 10000) a -= base;
    else if (base > 1 && a >= base * 10 - 9 && a < base * 10 - 9 + 65536) a -= base * 10 - 9;
    else a -= 1;
    refNote = `PLC reference ${address} → PDU address ${a}.`;
  }
  if (a < 0 || a > 0xFFFF) return { warnings: [`The start address works out to ${a}, outside 0–65535. With "PLC reference" numbering, 40001 is holding register 0; with "PDU address" it is sent as written.`] };

  const q = Math.round(num(quantity) ?? 1);
  const vals = String(values ?? '').split(/[\s,;]+/).filter(Boolean);
  const parsed = vals.map(num);
  const badVals = vals.filter((v, i) => parsed[i] == null);
  if (badVals.length) warnings.push(`Could not read value(s) ${badVals.map((v) => `"${v}"`).join(', ')}; they are left out.`);
  const nums = parsed.filter((v) => v != null);

  const pdu = [f];
  const fields = [];
  const push16 = (v, label, meaning) => { pdu.push((v >> 8) & 0xFF, v & 0xFF); fields.push([label, `${h2((v >> 8) & 0xFF)} ${h2(v & 0xFF)}`, meaning]); };
  let respLen = 0; // response PDU length
  let count = 1;   // items addressed: coils or registers
  if (f <= 4) {
    if (!(q >= 1 && q <= F.maxQ)) return { warnings: [`${F.name} takes a quantity of 1–${F.maxQ}; ${quantity} is outside it.`] };
    push16(a, 'Start address', `${a} (${F.table} ${a + (F.ref || 1)} in PLC numbering)`);
    push16(q, 'Quantity', `${q} ${F.table}${q > 1 ? 's' : ''}`);
    respLen = 2 + (f <= 2 ? Math.ceil(q / 8) : 2 * q);
    count = q;
    if (a + q > 0x10000) warnings.push('Start address + quantity runs past 65535.');
  } else if (f === 5) {
    const v = nums.length ? nums[0] : 1;
    push16(a, 'Coil address', String(a));
    push16(v ? 0xFF00 : 0x0000, 'Value', v ? 'ON (0xFF00)' : 'OFF (0x0000)');
    respLen = 5;
  } else if (f === 6) {
    if (!nums.length) warnings.push('Give the register value in Values; 0 is sent.');
    let v = nums.length ? nums[0] : 0;
    if (v < -32768 || v > 65535) { warnings.push(`${v} does not fit a 16-bit register; it is cut to 16 bits.`); }
    v = ((v % 65536) + 65536) % 65536;
    push16(a, 'Register address', String(a));
    push16(v, 'Value', `${v}${v > 32767 ? ` (signed ${v - 65536})` : ''}`);
    respLen = 5;
  } else if (f === 15) {
    const bits = nums.map((v) => (v ? 1 : 0));
    if (!bits.length) return { warnings: ['Give the coil states in Values, e.g. 1 0 1 1.'] };
    if (bits.length > F.maxQ) return { warnings: [`Write Multiple Coils takes at most ${F.maxQ} coils.`] };
    const bc = Math.ceil(bits.length / 8);
    count = bits.length;
    push16(a, 'Start address', String(a));
    push16(bits.length, 'Quantity', `${bits.length} coils`);
    pdu.push(bc); fields.push(['Byte count', h2(bc), String(bc)]);
    const packed = [];
    for (let i = 0; i < bc; i++) { let b = 0; for (let k = 0; k < 8; k++) if (bits[i * 8 + k]) b |= 1 << k; packed.push(b); }
    pdu.push(...packed); fields.push(['Coil states', packed.map(h2).join(' '), 'first coil in bit 0 of the first byte']);
    respLen = 5;
  } else if (f === 16) {
    if (!nums.length) return { warnings: ['Give the register values in Values, e.g. 100, 0x1234, -5.'] };
    if (nums.length > F.maxQ) return { warnings: [`Write Multiple Registers takes at most ${F.maxQ} registers.`] };
    const regs = nums.map((v) => {
      if (v < -32768 || v > 65535) warnings.push(`${v} does not fit a 16-bit register; it is cut to 16 bits.`);
      return ((v % 65536) + 65536) % 65536;
    });
    push16(a, 'Start address', String(a));
    push16(regs.length, 'Quantity', `${regs.length} registers`);
    count = regs.length;
    pdu.push(regs.length * 2); fields.push(['Byte count', h2(regs.length * 2), String(regs.length * 2)]);
    for (const r of regs) pdu.push((r >> 8) & 0xFF, r & 0xFF);
    fields.push(['Register values', regs.map((r) => hx(r)).join(' '), 'big-endian, high byte first']);
    respLen = 5;
  }
  if ((f === 1 || f === 2 || f === 3 || f === 4) && vals.length) notes.push('Values are ignored for a read request.');
  if (q !== 1 && (f === 5 || f === 6)) notes.push('Quantity is ignored for a single write.');

  let adu, head = [], tail = [];
  const pduRows = [['Function code', h2(f), `${f} ${F.name}`], ...fields];
  let text = '';
  if (mode === 'tcp') {
    const t = ((num(tid) ?? 1) % 65536 + 65536) % 65536;
    const len = pdu.length + 1;
    head = [t >> 8, t & 0xFF, 0, 0, len >> 8, len & 0xFF, unit];
    adu = [...head, ...pdu];
    const rows = [['Transaction id', `${h2(t >> 8)} ${h2(t & 0xFF)}`, String(t)], ['Protocol id', '00 00', 'Modbus'], ['Length', `${h2(len >> 8)} ${h2(len & 0xFF)}`, `${len} bytes follow`], ['Unit id', h2(unit), String(unit)], ...pduRows];
    text = adu.map(h2).join(' ');
    return finish(adu, rows, text, respLen + 7, mode);
  }
  if (mode === 'ascii') {
    const body = [unit, ...pdu];
    const l = lrc(body);
    const ascii = ':' + [...body, l].map(h2).join('') + '\r\n';
    adu = [...ascii].map((ch) => ch.charCodeAt(0));
    const rows = [['Start', '3A', "':'"], ['Address', h2(unit), String(unit)], ...pduRows, ['LRC', h2(l), 'two\'s complement of the byte sum'], ['End', '0D 0A', 'CR LF']];
    text = ascii.replace('\r\n', '\\r\\n');
    return finish(adu, rows, text, 2 * (respLen + 2) + 3, mode, ascii);
  }
  const body = [unit, ...pdu];
  const c = crc16(body);
  adu = [...body, c & 0xFF, c >> 8];
  const rows = [['Slave address', h2(unit), String(unit)], ...pduRows, ['CRC', `${h2(c & 0xFF)} ${h2(c >> 8)}`, `${hx(c)}, low byte first`]];
  text = adu.map(h2).join(' ');
  return finish(adu, rows, text, respLen + 3, 'rtu');

  function finish(bytes, rows, frameText, respBytes, m, asciiText) {
    const values = [
      { label: 'Length', value: bytes.length, unit: 'bytes' },
      { label: 'Expected response', value: respBytes, unit: 'bytes', hint: 'normal reply; an exception is ' + (m === 'tcp' ? '9' : m === 'ascii' ? '11' : '5') },
    ];
    if (m === 'rtu') {
      const c = crc16(bytes.slice(0, -2));
      values.push({ label: 'CRC-16/MODBUS', value: hx(c), hint: `sent ${h2(c & 0xFF)} ${h2(c >> 8)}` });
    }
    const serial = m !== 'tcp' && baud > 0;
    const bits = m === 'ascii' ? 10 : 11; // RTU 8E1: start + 8 data + parity + stop; ASCII 7E1: start + 7 data + parity + stop
    const tc = serial ? bits / baud : null;
    // t3.5 / t1.5 frame RTU only; ASCII frames are delimited by ':' and CR LF
    const t35 = serial && m === 'rtu' ? (baud > 19200 ? 1.75e-3 : 3.5 * tc) : null, t15 = serial && m === 'rtu' ? (baud > 19200 ? 0.75e-3 : 1.5 * tc) : null;
    if (serial) {
      values.push({ label: 'Request on the wire', value: fmtEng(bytes.length * tc, 's'), hint: `${fmtNum(baud, 6)} baud, ${bits} bits/char` });
      values.push({ label: 'Response on the wire', value: fmtEng(respBytes * tc, 's') });
      if (m === 'rtu') values.push({ label: 't3.5 frame gap', value: fmtEng(t35, 's'), hint: 'silence that ends a frame' }, { label: 't1.5 char gap', value: fmtEng(t15, 's'), hint: 'longest gap inside a frame' });
    }
    if (m === 'ascii') notes.push('ASCII mode sends 7 data bits: 10 bits per character, 7E1 (start, 7 data, even parity, stop), or 7N2 without parity (Modbus over Serial Line V1.02 §2.5.2.1). Frames are delimited by \':\' and CR LF, not by silences.');
    if (refNote) notes.push(refNote);
    notes.push('Registers are big-endian on the wire. 32-bit values span two registers and their word order is device-specific.');
    const texts = [
      { title: 'Hex', body: (asciiText ? asciiText.replace('\r\n', '\\r\\n') + '\n\n' : '') + bytes.map(h2).join(' ') + '\n' },
      { title: 'C array', lang: 'c', body: `static const uint8_t modbus_req[${bytes.length}] = { ${bytes.map((b) => '0x' + h2(b)).join(', ')} };\n` },
      { title: 'Python', lang: 'python', body: `req = bytes.fromhex("${bytes.map(h2).join(' ')}")\n` },
    ];
    // The frame for a drawing: the bytes on the wire, each field's byte count
    // (in ASCII mode, binary bytes before hex encoding) and the line timing.
    const frame = {
      mode: m, bytes, fc: f, func: F.name, table: F.table, ref: F.ref || 1, maxQ: F.maxQ || 1,
      address: a, count, unit, respBytes,
      fields: rows.map(([label, hexText, meaning]) => {
        const tok = String(hexText).split(' ').filter(Boolean);
        return { label, hex: hexText, meaning, n: tok[0]?.startsWith('0x') ? tok.length * 2 : tok.length };
      }),
      baud: serial ? baud : null, charTime: tc, t35, t15,
      bitsPerChar: serial ? bits : null, dataBits: m === 'ascii' ? 7 : 8,
      reqTime: serial ? bytes.length * tc : null, respTime: serial ? respBytes * tc : null,
    };
    return { frame, values, warnings, tables: [{ title: `${m.toUpperCase()} frame`, columns: ['Bytes (hex)'], rows: [[frameText]] }, { title: `${m.toUpperCase()} frame, field by field`, columns: ['Field', 'Bytes', 'Meaning'], rows }], texts, notes };
  }
}
