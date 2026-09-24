// Register bitfield editor: decode a register value into its fields, flip
// bits, and emit CMSIS-style _Pos/_Msk macros.
//   field value = (reg >> lsb) & ((1 << width) - 1),   width = msb - lsb + 1
// Presets transcribed from:
//   Cortex-M SCB->AIRCR: Armv7-M ARM B3.2.6
//   ATmega328P TCCR1B:   ATmega328P datasheet §15.11.2, table 15-6 (clock select)
//   STM32F4 USART_CR1:   RM0090 §30.6.4
//   default custom example: BME280 ctrl_meas (0xF4), Bosch BME280 datasheet §5.4.5

const PRESETS = {
  aircr: { name: 'SCB->AIRCR (Cortex-M)', width: 32, value: '0xFA050300', fields: `VECTKEY 31:16 0x05FA=write key 0xFA05=read value
ENDIANNESS 15 0=little 1=big
PRIGROUP 10:8 0=7.1 group.sub split 3=4 bits group (STM32 GROUP_4) 4=3.1 5=2.2 6=1.3 7=0.4
SYSRESETREQ 2 1=request a system reset
VECTCLRACTIVE 1 debug only
VECTRESET 0 debug only` },
  tccr1b: { name: 'TCCR1B (ATmega328P)', width: 8, value: '0x0B', fields: `ICNC1 7 1=input capture noise canceler on
ICES1 6 0=capture on falling edge 1=rising edge
WGM13 4 waveform mode bit 3
WGM12 3 waveform mode bit 2 (set, with WGM11 and WGM10 clear: CTC mode, top OCR1A)
CS1 2:0 0=stopped 1=clk/1 2=clk/8 3=clk/64 4=clk/256 5=clk/1024 6=T1 falling 7=T1 rising` },
  usartcr1: { name: 'USART_CR1 (STM32F4)', width: 32, value: '0x0000200C', fields: `OVER8 15 0=oversampling by 16 1=by 8
UE 13 1=USART enabled
M 12 0=8 data bits 1=9 data bits
WAKE 11 0=idle line 1=address mark
PCE 10 1=parity on
PS 9 0=even 1=odd
PEIE 8 parity error interrupt
TXEIE 7 TX empty interrupt
TCIE 6 transmission complete interrupt
RXNEIE 5 RX not empty interrupt
IDLEIE 4 idle interrupt
TE 3 1=transmitter on
RE 2 1=receiver on
RWU 1 receiver mute
SBK 0 send break` },
};

function parseValue(t) {
  const s = String(t ?? '').trim().replace(/[_\s']/g, '');
  if (!s) return { v: 0, how: 'empty, taken as 0' };
  let m;
  if ((m = /^0x([0-9a-f]+)$/i.exec(s)) || (m = /^([0-9a-f]+)h$/i.exec(s))) return { v: parseInt(m[1], 16), how: 'hex' };
  if ((m = /^0b([01]+)$/i.exec(s))) return { v: parseInt(m[1], 2), how: 'binary' };
  if (/^\d+$/.test(s)) return { v: Number(s), how: 'decimal' };
  if (/^[0-9a-f]+$/i.test(s)) return { v: parseInt(s, 16), how: 'hex (it has hex letters)' };
  return null;
}

// "NAME msb:lsb meanings..." or "NAME bit meanings..."; meanings "k=text" (k decimal or 0x hex)
function parseFields(text, width) {
  const fields = [], bad = [];
  String(text ?? '').split('\n').forEach((raw, i) => {
    const line = raw.replace(/(#|\/\/).*$/, '').trim();
    if (!line) return;
    const m = /^([A-Za-z_][\w.]*)\s*[\s:=]\s*\[?(\d+)(?:\s*[:\-]\s*(\d+))?\]?\s*(.*)$/.exec(line);
    if (!m) { bad.push(`line ${i + 1}: "${raw.trim()}" (write NAME msb:lsb or NAME bit)`); return; }
    let hi = Number(m[2]), lo = m[3] != null ? Number(m[3]) : hi;
    if (lo > hi) [hi, lo] = [lo, hi];
    if (hi >= width) { bad.push(`line ${i + 1}: ${m[1]} uses bit ${hi}, beyond a ${width}-bit register`); return; }
    const rest = m[4] || '';
    const meanings = {};
    // split "0=off 1=single 2=cont" into codes; the text of a code runs to the next "k="
    const re = /(0x[0-9a-f]+|\d+)\s*=\s*/gi;
    const hits = [...rest.matchAll(re)];
    hits.forEach((h, k) => {
      const end = k + 1 < hits.length ? hits[k + 1].index : rest.length;
      meanings[parseInt(h[1], h[1].toLowerCase().startsWith('0x') ? 16 : 10)] = rest.slice(h.index + h[0].length, end).trim();
    });
    const desc = hits.length ? rest.slice(0, hits[0].index).trim() : rest.trim();
    fields.push({ name: m[1], msb: hi, lsb: lo, meanings, desc });
  });
  return { fields, bad };
}

const hex = (v, w) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(Math.ceil(w / 4), '0');
const bin = (v, w) => (v >>> 0).toString(2).padStart(w, '0').replace(/(?=(?:[01]{4})+$)(?!^)/g, '_');

export function run({ preset, width: wIn, value, flip, fields: ftext }) {
  const P = PRESETS[preset];
  const width = P ? P.width : [8, 16, 32].includes(Number(wIn)) ? Number(wIn) : 32;
  const warnings = [], notes = [];
  const pv = parseValue(value || (P ? P.value : ''));
  if (!pv) return { warnings: [`"${value}" is not a number: write it as 0x1A2B, 0b1010 or 6699.`] };
  const mask = width === 32 ? 0xFFFFFFFF : (1 << width) - 1;
  let v = pv.v;
  if (!Number.isSafeInteger(v) || v > mask) { warnings.push(`${value} does not fit ${width} bits; the upper bits are dropped.`); v = Number(BigInt(Math.min(v, Number.MAX_SAFE_INTEGER)) & BigInt(mask)); }
  v >>>= 0;
  const before = v;
  const flips = String(flip ?? '').split(/[,;\s]+/).filter(Boolean);
  for (const f of flips) {
    const n = Number(f);
    if (!Number.isInteger(n) || n < 0 || n >= width) { warnings.push(`Cannot flip bit "${f}": give bit numbers 0-${width - 1}.`); continue; }
    v = (v ^ (2 ** n)) >>> 0;
  }
  const { fields, bad } = parseFields(P ? P.fields : ftext, width);
  if (P && String(ftext ?? '').trim()) notes.push(`Using the ${P.name} preset fields; choose "Custom" to use your own field list.`);
  if (bad.length) warnings.push(`Could not read ${bad.length} field line${bad.length > 1 ? 's' : ''}: ${bad.join('; ')}.`);
  const owner = new Array(width).fill(null);
  const clash = new Map();
  for (const f of fields) for (let b = f.lsb; b <= f.msb; b++) {
    if (owner[b]) { const k = `${owner[b]} and ${f.name}`; clash.set(k, [...(clash.get(k) || []), b]); } else owner[b] = f.name;
  }
  for (const [k, bs] of clash) warnings.push(`${k} overlap on bit${bs.length > 1 ? 's' : ''} ${bs.join(', ')}: fix the field list.`);
  const rows = fields.slice().sort((a, b) => b.msb - a.msb).map((f) => {
    const w = f.msb - f.lsb + 1;
    const fv = Math.floor(v / 2 ** f.lsb) % 2 ** w;
    const meaning = f.meanings[fv] ?? (w === 1 ? `${fv ? 'set' : 'clear'}${f.desc ? ` (${f.desc})` : ''}`
      : Object.keys(f.meanings).length ? `(${fv}: no listed meaning)` : f.desc);
    f.value = fv; f.meaning = meaning;
    return [f.name, f.msb === f.lsb ? `${f.msb}` : `${f.msb}:${f.lsb}`, String(fv), hex(fv, w), (fv >>> 0).toString(2).padStart(w, '0'), meaning || ''];
  });
  const loose = [];
  for (let b = 0; b < width; b++) if (!owner[b] && Math.floor(v / 2 ** b) % 2) loose.push(b);
  if (fields.length && loose.length) warnings.push(`Bit${loose.length > 1 ? 's' : ''} ${loose.join(', ')} ${loose.length > 1 ? 'are' : 'is'} set but in no field: reserved bits should usually be written as 0 (or kept as read).`);
  if (preset === 'aircr' && (v >>> 16) !== 0x05FA && (v >>> 16) !== 0xFA05) notes.push('A write to AIRCR is ignored unless VECTKEY (bits 31:16) is 0x05FA.');
  const pre = (P ? P.name.split(' ')[0].replace(/\W+/g, '_') : 'REG').toUpperCase();
  const macros = fields.slice().sort((a, b) => b.msb - a.msb).map((f) => {
    const w = f.msb - f.lsb + 1, m = (2 ** w - 1) * 2 ** f.lsb;
    return `#define ${pre}_${f.name}_Pos  ${f.lsb}U\n#define ${pre}_${f.name}_Msk  (0x${(2 ** w - 1).toString(16).toUpperCase()}UL << ${pre}_${f.name}_Pos)  /* ${hex(m, width)} */`;
  }).join('\n');
  const set = fields.filter((f) => f.value).map((f) => (f.msb === f.lsb ? `${pre}_${f.name}_Msk` : `(${f.value}UL << ${pre}_${f.name}_Pos)`));
  const bits = Array.from({ length: width }, (_, b) => ({ bit: b, on: Math.floor(v / 2 ** b) % 2 === 1, field: owner[b] }));
  return {
    values: [
      { label: 'Hex', value: hex(v, width), tone: v !== before ? 'warn' : undefined, hint: v !== before ? `was ${hex(before, width)}` : `read as ${pv.how}` },
      { label: 'Decimal', value: String(v) },
      { label: 'Binary', value: bin(v, width) },
      { label: 'Bits set', value: bits.filter((b) => b.on).length, hint: `of ${width}` },
    ],
    tables: rows.length ? [{ title: 'Fields', columns: ['Field', 'Bits', 'Value', 'Hex', 'Binary', 'Meaning'], rows }] : [],
    texts: fields.length ? [{ title: 'C', lang: 'c', body: `${macros}\n\n/* this value from its fields */\n#define ${pre}_VALUE  (${set.join(' | ') || '0UL'})  /* ${hex(v, width)} */\n` }] : [],
    bits, width, hexValue: hex(v, width),
    fields: fields.map((f) => ({ name: f.name, msb: f.msb, lsb: f.lsb, value: f.value, meaning: f.meaning })),
    warnings, notes: [...notes, 'Click a bit in the drawing to flip it; agents give bit numbers in "Flip bits".'],
  };
}
