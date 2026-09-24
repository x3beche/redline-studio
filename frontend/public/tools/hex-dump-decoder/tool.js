// Split a captured byte stream into frames for one protocol, check each
// frame's integrity, and report the bytes that belong to no frame.
//   Modbus RTU: CRC-16/MODBUS, low byte first (Modbus over Serial Line V1.02 §6.2.2);
//     frame lengths from the function code (Modbus Application Protocol V1.1b3 §6).
//   u-blox UBX: B5 62, class, id, length (LE16), payload, 8-bit Fletcher CK_A/CK_B
//     over class..payload (u-blox 8 / M8 Receiver Description §32.4).
//   SLIP: RFC 1055 (END C0, ESC DB, DB DC -> C0, DB DD -> DB).
//   COBS: Cheshire & Baker, IEEE/ACM ToN 1999; frames end with 0x00.
//   Delimiter, fixed length and length-prefixed are generic splitters.

const h2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const hexs = (a, max = 24) => a.slice(0, max).map(h2).join(' ') + (a.length > max ? ` … (+${a.length - max})` : '');

// --- input: hex dumps in the usual shapes ---
export function parseBytes(text) {
  const bytes = [], bad = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, li) => {
    let l = raw;
    l = l.replace(/\|.*\|\s*$/, '');                               // hexdump -C ASCII column
    if (/^\s*[0-9a-f]{8}:\s/i.test(l)) l = l.replace(/^\s*[0-9a-f]{8}:\s*/i, '').replace(/\s{2,}\S.*$/, ''); // xxd: offset, hex, ASCII
    l = l.replace(/^\s*(?:0x)?[0-9a-f]{4,8}[:]\s*/i, '');         // "0000:" offsets
    l = l.replace(/^\s*[0-9a-f]{7,8}\s{2,}/i, '');                // "00000010  " offsets (hexdump -C, xxd)
    l = l.replace(/\/\/.*$|#.*$/, '');
    const toks = l.replace(/0x/gi, ' ').split(/[\s,;:]+/).filter(Boolean);
    for (const t of toks) {
      if (/^([0-9a-f]{2})+$/i.test(t)) for (let i = 0; i < t.length; i += 2) bytes.push(parseInt(t.slice(i, i + 2), 16));
      else if (/^[0-9a-f]$/i.test(t)) bytes.push(parseInt(t, 16));
      else bad.push(`line ${li + 1}: "${t}"`);
    }
  });
  return { bytes, bad };
}

function crc16(bytes) {
  let crc = 0xFFFF;
  for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xA001 : crc >>> 1; }
  return crc;
}
const crcOk = (f) => f.length >= 4 && crc16(f.slice(0, -2)) === (f[f.length - 2] | (f[f.length - 1] << 8));

const MB_FN = { 1: 'Read Coils', 2: 'Read Discrete Inputs', 3: 'Read Holding Registers', 4: 'Read Input Registers', 5: 'Write Single Coil', 6: 'Write Single Register', 15: 'Write Multiple Coils', 16: 'Write Multiple Registers', 8: 'Diagnostics', 17: 'Report Server ID', 23: 'Read/Write Multiple Registers', 43: 'Encapsulated Interface' };
const MB_EX = { 1: 'illegal function', 2: 'illegal data address', 3: 'illegal data value', 4: 'server device failure', 5: 'acknowledge', 6: 'server busy', 10: 'gateway path unavailable', 11: 'gateway target failed to respond' };
const w16 = (b, i) => (b[i] << 8) | b[i + 1];

function modbusDescribe(f) {
  const fc = f[1], d = f.slice(2, -2);
  if (fc & 0x80) return `slave ${f[0]} exception to fc ${fc & 0x7F}: ${MB_EX[d[0]] || 'code ' + d[0]}`;
  const name = MB_FN[fc] || `fc ${fc}`;
  if (fc <= 4) {
    if (d.length === 4) return `slave ${f[0]} request ${name}: addr ${w16(d, 0)}, qty ${w16(d, 2)}`;
    const data = d.slice(1);
    if (fc <= 2) return `slave ${f[0]} reply ${name}: ${data.length} byte(s) ${hexs(data, 8)}`;
    const regs = []; for (let i = 0; i + 1 < data.length; i += 2) regs.push(w16(data, i));
    return `slave ${f[0]} reply ${name}: ${regs.slice(0, 8).join(', ')}${regs.length > 8 ? ' …' : ''}`;
  }
  if (fc === 5 || fc === 6) return `slave ${f[0]} ${name}: addr ${w16(d, 0)} = ${fc === 5 ? (w16(d, 2) === 0xFF00 ? 'ON' : 'OFF') : w16(d, 2)} (request or echo)`;
  if (fc === 15 || fc === 16) return d.length === 4 ? `slave ${f[0]} reply ${name}: addr ${w16(d, 0)}, qty ${w16(d, 2)}` : `slave ${f[0]} request ${name}: addr ${w16(d, 0)}, qty ${w16(d, 2)}`;
  return `slave ${f[0]} ${name}, ${d.length} data byte(s)`;
}

// Candidate lengths from the function code; fall back to any CRC match.
function modbusLengths(b, i) {
  const fc = b[i + 1];
  if (fc == null) return [];
  if (fc & 0x80) return [5];
  if (fc >= 1 && fc <= 4) return [8, b[i + 2] != null ? 5 + b[i + 2] : null].filter(Boolean);
  if (fc === 5 || fc === 6) return [8];
  if (fc === 15 || fc === 16) return [8, b[i + 6] != null ? 9 + b[i + 6] : null].filter(Boolean);
  return Array.from({ length: 253 }, (_, k) => k + 4);
}

function splitModbus(b) {
  const frames = [];
  let i = 0, junkStart = -1;
  while (i < b.length) {
    let hit = null;
    if (b[i] <= 247) for (const n of modbusLengths(b, i)) if (i + n <= b.length && crcOk(b.slice(i, i + n))) { hit = n; break; }
    if (hit) {
      if (junkStart >= 0) { frames.push({ off: junkStart, bytes: b.slice(junkStart, i), junk: true }); junkStart = -1; }
      const f = b.slice(i, i + hit);
      frames.push({ off: i, bytes: f, check: 'CRC ok', info: modbusDescribe(f) });
      i += hit;
    } else { if (junkStart < 0) junkStart = i; i++; }
  }
  if (junkStart >= 0) frames.push({ off: junkStart, bytes: b.slice(junkStart), junk: true });
  return frames;
}

const UBX = { '01 07': 'NAV-PVT', '01 02': 'NAV-POSLLH', '01 03': 'NAV-STATUS', '01 12': 'NAV-VELNED', '01 35': 'NAV-SAT', '01 21': 'NAV-TIMEUTC',
  '05 01': 'ACK-ACK', '05 00': 'ACK-NAK', '06 00': 'CFG-PRT', '06 01': 'CFG-MSG', '06 08': 'CFG-RATE', '06 24': 'CFG-NAV5', '06 09': 'CFG-CFG',
  '06 8A': 'CFG-VALSET', '06 8B': 'CFG-VALGET', '0A 04': 'MON-VER', '0A 09': 'MON-HW', '02 15': 'RXM-RAWX', '0D 01': 'TIM-TP' };
function splitUbx(b) {
  const frames = [];
  let i = 0, junkStart = -1;
  const flush = (to) => { if (junkStart >= 0) { frames.push({ off: junkStart, bytes: b.slice(junkStart, to), junk: true }); junkStart = -1; } };
  while (i < b.length) {
    if (b[i] === 0xB5 && b[i + 1] === 0x62 && i + 6 <= b.length) {
      const len = b[i + 4] | (b[i + 5] << 8);
      const end = i + 8 + len;
      if (end <= b.length) {
        let a = 0, c = 0;
        for (let k = i + 2; k < i + 6 + len; k++) { a = (a + b[k]) & 0xFF; c = (c + a) & 0xFF; }
        const ok = a === b[end - 2] && c === b[end - 1];
        if (ok || len < 1024) {
          flush(i);
          const key = `${h2(b[i + 2])} ${h2(b[i + 3])}`;
          let info = `${UBX[key] || 'class/id ' + key}, ${len}-byte payload`;
          if (key === '05 01' || key === '05 00') info += ` for ${UBX[`${h2(b[i + 6])} ${h2(b[i + 7])}`] || h2(b[i + 6]) + ' ' + h2(b[i + 7])}`;
          if (key === '01 07' && len >= 92 && ok) {
            const p = b.slice(i + 6, end - 2);
            const i32 = (o) => (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24));
            info += `: fix ${p[20]}, ${p[23]} sats, lat ${(i32(28) * 1e-7).toFixed(7)}, lon ${(i32(24) * 1e-7).toFixed(7)}`;
          }
          frames.push({ off: i, bytes: b.slice(i, end), check: ok ? 'checksum ok' : `CHECKSUM BAD (want ${h2(a)} ${h2(c)})`, bad: !ok, info });
          i = end; continue;
        }
      } else {
        flush(i);
        frames.push({ off: i, bytes: b.slice(i), check: 'truncated', bad: true, info: `header says ${len}-byte payload, capture ends first` });
        i = b.length; continue;
      }
    }
    if (junkStart < 0) junkStart = i;
    i++;
  }
  flush(b.length);
  return frames;
}

function splitSlip(b) {
  const frames = [];
  let cur = [], start = 0, raw = 0, err = '';
  const end = (i) => {
    if (cur.length || err) frames.push({ off: start, bytes: b.slice(start, i + 1), payload: cur, check: err || 'ok', bad: !!err, info: `${cur.length}-byte payload: ${hexs(cur, 12)}` });
    cur = []; err = ''; start = i + 1;
  };
  for (let i = 0; i < b.length; i++) {
    const x = b[i];
    if (x === 0xC0) { end(i); continue; }
    if (x === 0xDB) {
      const y = b[i + 1];
      if (y === 0xDC) cur.push(0xC0); else if (y === 0xDD) cur.push(0xDB); else err = `bad escape DB ${y == null ? 'at end' : h2(y)}`;
      i++; continue;
    }
    cur.push(x); raw++;
  }
  if (cur.length) frames.push({ off: start, bytes: b.slice(start), payload: cur, check: 'no closing C0', bad: true, info: `${cur.length}-byte payload (incomplete)` });
  return frames;
}

function splitCobs(b) {
  const frames = [];
  let start = 0;
  for (let i = 0; i <= b.length; i++) {
    if (i < b.length && b[i] !== 0) continue;
    const enc = b.slice(start, i);
    if (enc.length) {
      const out = []; let k = 0, err = '';
      while (k < enc.length) {
        const code = enc[k];
        if (code === 0) { err = 'zero inside frame'; break; }
        if (k + code > enc.length) { err = 'code runs past the frame'; break; }
        out.push(...enc.slice(k + 1, k + code));
        k += code;
        if (code < 0xFF && k < enc.length) out.push(0);
      }
      frames.push({ off: start, bytes: b.slice(start, Math.min(i + 1, b.length)), check: err || (i === b.length ? 'no closing 00' : 'ok'), bad: !!err || i === b.length, info: err ? 'not valid COBS' : `${out.length}-byte payload: ${hexs(out, 12)}` });
    }
    start = i + 1;
  }
  return frames;
}

function splitDelim(b, d) {
  const frames = [];
  let start = 0;
  for (let i = 0; i < b.length; i++) if (b[i] === d) { frames.push({ off: start, bytes: b.slice(start, i + 1), check: 'ok', info: ascii(b.slice(start, i)) }); start = i + 1; }
  if (start < b.length) frames.push({ off: start, bytes: b.slice(start), check: 'no delimiter', bad: true, info: ascii(b.slice(start)) });
  return frames;
}
const ascii = (a) => {
  const s = a.map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('');
  return `"${s.length > 40 ? s.slice(0, 40) + '…' : s}"`;
};

function splitFixed(b, n) {
  const frames = [];
  for (let i = 0; i < b.length; i += n) frames.push({ off: i, bytes: b.slice(i, i + n), check: i + n <= b.length ? 'ok' : 'short', bad: i + n > b.length, info: ascii(b.slice(i, i + n)) });
  return frames;
}

function splitLen(b, sync, lenOff, lenSize, lenEndian, adjust) {
  const frames = [];
  let i = 0, junkStart = -1;
  const flush = (to) => { if (junkStart >= 0) { frames.push({ off: junkStart, bytes: b.slice(junkStart, to), junk: true }); junkStart = -1; } };
  const matchSync = (k) => sync.every((s, j) => b[k + j] === s);
  while (i < b.length) {
    if (matchSync(i) && i + lenOff + lenSize <= b.length) {
      let v = 0;
      for (let j = 0; j < lenSize; j++) v = lenEndian === 'le' ? v | (b[i + lenOff + j] << (8 * j)) : (v << 8) | b[i + lenOff + j];
      const total = v + adjust;
      if (total >= sync.length + lenSize && total < 65536) {
        flush(i);
        const f = b.slice(i, i + total);
        frames.push({ off: i, bytes: f, check: f.length === total ? 'length ok' : 'truncated', bad: f.length !== total, info: `length field ${v} → ${total} bytes` });
        i += total; continue;
      }
    }
    if (junkStart < 0) junkStart = i;
    i++;
  }
  flush(b.length);
  return frames;
}

function hexByte(t) {
  const m = /^(?:0x)?([0-9a-f]{1,2})$/i.exec(String(t ?? '').trim());
  return m ? parseInt(m[1], 16) : null;
}

export function run({ data, protocol, delim, fixedLen, sync, lenOff, lenSize, lenEndian, lenAdjust }) {
  const warnings = [], notes = [];
  const { bytes, bad } = parseBytes(data);
  if (bad.length) warnings.push(`Skipped ${bad.length} token(s) that are not hex bytes: ${bad.slice(0, 6).join(', ')}${bad.length > 6 ? ' …' : ''}.`);
  if (!bytes.length) return { warnings: [...warnings, 'Paste the captured bytes as hex: "01 03 00 00", "0x01,0x03", "010300" or a hexdump -C / xxd listing.'] };

  let frames;
  if (protocol === 'modbus') frames = splitModbus(bytes);
  else if (protocol === 'ubx') frames = splitUbx(bytes);
  else if (protocol === 'slip') frames = splitSlip(bytes);
  else if (protocol === 'cobs') frames = splitCobs(bytes);
  else if (protocol === 'delim') {
    const d = hexByte(delim);
    if (d == null) return { warnings: [`Delimiter "${delim}" is not one hex byte, e.g. 0A.`] };
    frames = splitDelim(bytes, d);
  } else if (protocol === 'fixed') {
    const n = Math.round(fixedLen);
    if (!(n >= 1)) return { warnings: ['Give the fixed frame length in bytes (1 or more).'] };
    frames = splitFixed(bytes, n);
  } else {
    const syn = String(sync || '').split(/[\s,]+/).filter(Boolean).map(hexByte);
    if (syn.some((x) => x == null)) return { warnings: [`Sync bytes "${sync}" must be hex bytes, e.g. AA 55.`] };
    const off = Math.round(lenOff), size = Number(lenSize) === 2 ? 2 : 1;
    if (!(off >= 0)) return { warnings: ['Give the offset of the length field from the frame start (0 or more).'] };
    if (!syn.length) warnings.push('Without sync bytes one bad length loses the rest of the capture; give the sync bytes if the protocol has them.');
    frames = splitLen(bytes, syn, off, size, lenEndian, Math.round(lenAdjust) || 0);
  }

  const good = frames.filter((f) => !f.junk && !f.bad);
  const badF = frames.filter((f) => !f.junk && f.bad);
  const junk = frames.filter((f) => f.junk);
  const junkBytes = junk.reduce((a, f) => a + f.bytes.length, 0);
  if (junkBytes) warnings.push(`${junkBytes} byte(s) in ${junk.length} run(s) belong to no frame (shown as "unframed"): a capture that starts mid-frame, noise, or the wrong protocol setting.`);
  if (badF.length) warnings.push(`${badF.length} frame(s) fail their check (CRC, checksum, escape or length). Look for dropped bytes or a wrong baud rate.`);
  if (!good.length) warnings.push('No valid frame found. Check the protocol choice and that the bytes are in capture order.');
  if (protocol === 'modbus') notes.push('Modbus RTU frames are found by CRC; a request and its reply are told apart by length. An 8-byte FC 5/6 frame may be the request or its echo.');

  const MAX = 300;
  const rows = frames.slice(0, MAX).map((f, k) => [k + 1, `0x${f.off.toString(16).toUpperCase().padStart(4, '0')}`, f.bytes.length, hexs(f.bytes), f.junk ? 'unframed' : f.check, f.junk ? ascii(f.bytes) : f.info]);
  if (frames.length > MAX) notes.push(`Showing the first ${MAX} of ${frames.length} rows; the JSON output has the counts.`);

  return {
    values: [
      { label: 'Bytes read', value: bytes.length },
      { label: 'Valid frames', value: good.length, tone: good.length ? 'ok' : 'bad' },
      { label: 'Bad frames', value: badF.length, tone: badF.length ? 'bad' : 'ok' },
      { label: 'Unframed bytes', value: junkBytes, tone: junkBytes ? 'warn' : 'ok' },
    ],
    warnings,
    tables: [{ title: 'Frames', columns: ['#', 'Offset', 'Len', 'Bytes', 'Check', 'Decoded'], rows }],
    texts: [{ title: 'Frames (hex)', body: frames.map((f) => `${f.junk ? '? ' : f.bad ? '! ' : '  '}${f.bytes.map(h2).join(' ')}`).join('\n') + '\n' }],
    notes,
  };
}
