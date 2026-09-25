// Pin-to-Net-to-Symbol Mapper: joins an MCU's pins from a PCB netlist with the pin
// symbols a firmware defines, on a canonical port/pin key.
//   Netlist: KiCad .net (s-expression "(export (version ...) ... (nets (net (name ..)
//   (node (ref ..) (pin ..) (pinfunction ..)))))" - KiCad 5 to 8; pin names come from
//   pinfunction or, for KiCad 5, from the libparts section), or a CSV "ref,pin,name,net".
//   Firmware: STM32CubeMX main.h pairs (#define X_Pin GPIO_PIN_n / #define X_GPIO_Port GPIOx),
//   #define / const assignments to PA5, PA_5, GPIO_NUM_5, GPIO5, IO5, GP5, P0.13,
//   NRF_GPIO_PIN_MAP(p,n), and Zephyr devicetree "gpios = <&gpioa 5 ...>".
//   Canonical keys: STM32-style port letter PA5, numbered GPIO5, nRF-style P0.13.

// ---------- canonical pin keys ----------
export function canon(tok) {
  const t = String(tok ?? '').trim().toUpperCase();
  let m;
  if ((m = /^P([A-K])_?0*(\d{1,2})$/.exec(t))) return `P${m[1]}${+m[2]}`;
  if ((m = /^P(\d)[._]0*(\d{1,2})$/.exec(t))) return `P${m[1]}.${String(+m[2]).padStart(2, '0')}`;
  if ((m = /^(?:GPIO_NUM_|GPIO_?|IO|GP)0*(\d{1,3})$/.exec(t))) return `GPIO${+m[1]}`;
  if ((m = /^NRF_GPIO_PIN_MAP\(\s*(\d)\s*,\s*(\d+)\s*\)$/.exec(t))) return `P${m[1]}.${String(+m[2]).padStart(2, '0')}`;
  return null;
}
/** A netlist pin name like "PA5/ADC1_IN5", "PC14-OSC32_IN" or "IO5" -> its key. */
const pinKey = (name) => {
  for (const part of String(name).split(/[\s/,()]+|-(?=[A-Z])/)) { const k = canon(part); if (k) return k; }
  return null;
};

// ---------- s-expression reader ----------
function sexpr(text) {
  const re = /\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|([^\s()"]+))/gy;
  const root = []; const stack = [root]; let m;
  while (re.lastIndex < text.length && (m = re.exec(text))) {
    if (m[1]) { const l = []; stack[stack.length - 1].push(l); stack.push(l); }
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3] != null) stack[stack.length - 1].push(m[3].replace(/\\(.)/g, '$1'));
    else if (m[4] != null) stack[stack.length - 1].push(m[4]);
    else break;
  }
  return { tree: root, open: stack.length - 1 };
}
const kids = (l, name) => (Array.isArray(l) ? l.filter((x) => Array.isArray(x) && x[0] === name) : []);
const val = (l, name) => { const k = kids(l, name)[0]; return k ? k[1] : undefined; };
function find(l, name, out = []) {
  if (!Array.isArray(l)) return out;
  if (l[0] === name) out.push(l);
  for (const x of l) if (Array.isArray(x)) find(x, name, out);
  return out;
}

function parseNetlist(text) {
  const nodes = []; // {ref, pin, name, net}
  const problems = [];
  if (/^\s*\(/.test(text)) {
    const { tree, open } = sexpr(text);
    if (open) problems.push(`The netlist has ${open} unclosed "(": it looks cut off; nets after the cut are missing.`);
    // KiCad 5: pin names from libparts via each component's libsource
    const partOf = new Map();
    for (const c of find(tree, 'comp')) { const ls = kids(c, 'libsource')[0]; if (ls) partOf.set(val(c, 'ref'), `${val(ls, 'lib')}:${val(ls, 'part')}`); }
    const pinNames = new Map();
    for (const lp of find(tree, 'libpart')) {
      const key = `${val(lp, 'lib')}:${val(lp, 'part')}`;
      const m = new Map();
      for (const p of find(lp, 'pin')) if (val(p, 'num') != null) m.set(String(val(p, 'num')), val(p, 'name'));
      pinNames.set(key, m);
    }
    for (const n of find(tree, 'net')) {
      const net = val(n, 'name');
      if (net == null) continue;
      for (const nd of kids(n, 'node')) {
        const ref = val(nd, 'ref'), pin = String(val(nd, 'pin') ?? '');
        const name = val(nd, 'pinfunction') ?? pinNames.get(partOf.get(ref))?.get(pin) ?? '';
        nodes.push({ ref, pin, name, net: String(net), type: val(nd, 'pintype') || '' });
      }
    }
    if (!nodes.length) problems.push('No (net ... (node ...)) entries found: export the netlist from KiCad (File > Export > Netlist, KiCad format).');
    return { nodes, problems, format: 'KiCad netlist' };
  }
  // CSV / TSV: ref,pin,name,net  or  pin,name,net
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(#|\/\/)/.test(l));
  lines.forEach((l, i) => {
    const c = l.split(/\t|;|,/).map((x) => x.trim().replace(/^"|"$/g, ''));
    if (i === 0 && /^(ref|pin|designator)/i.test(c[0])) return;
    if (c.length >= 4) nodes.push({ ref: c[0], pin: c[1], name: c[2], net: c[3], type: '' });
    else if (c.length === 3) nodes.push({ ref: '', pin: c[0], name: c[1], net: c[2], type: '' });
    else problems.push(`Netlist line ${i + 1} skipped (need ref,pin,name,net or pin,name,net): ${l}`);
  });
  return { nodes, problems, format: 'CSV' };
}

// ---------- firmware ----------
const PINISH = /PIN|GPIO|IO|LED|BTN|BUTTON|KEY|SDA|SCL|MOSI|MISO|SCK|CLK|CS|NSS|TX|RX|EN|RST|RESET|IRQ|INT|PWM|ADC|BUZZ|RELAY|SENSE|DRDY/i;
function parseFirmware(text, numbers) {
  const syms = []; // {sym, key, line, how}
  const src = String(text ?? '');
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  // CubeMX pairs
  const pins = new Map(), ports = new Map();
  for (const m of src.matchAll(/#define\s+(\w+)_Pin\s+GPIO_PIN_(\d+)\b/g)) pins.set(m[1], { n: +m[2], line: lineOf(m.index) });
  for (const m of src.matchAll(/#define\s+(\w+)_GPIO_Port\s+GPIO([A-K])\b/g)) ports.set(m[1], m[2]);
  const unpaired = [];
  for (const [s, p] of pins) {
    if (ports.has(s)) syms.push({ sym: s, key: `P${ports.get(s)}${p.n}`, line: p.line, how: 'CubeMX _Pin/_GPIO_Port' });
    else unpaired.push(s);
  }
  const VAL = String.raw`(P[A-K]_?\d{1,2}|P\d[._]\d{1,2}|GPIO_NUM_\d{1,3}|GPIO_?\d{1,3}|IO\d{1,3}|GP\d{1,3}|NRF_GPIO_PIN_MAP\(\s*\d\s*,\s*\d+\s*\)|\d{1,3})`;
  const defs = [
    new RegExp(String.raw`#define\s+(\w+)\s+\(?\s*${VAL}\s*\)?\s*(?:$|//|/\*)`, 'gm'),
    new RegExp(String.raw`(?:static\s+)?(?:constexpr\s+|const\s+)?(?:unsigned\s+)?(?:int|uint8_t|uint16_t|uint32_t|uint|gpio_num_t|pin_size_t|byte|auto|int8_t)\s+(?:const\s+)?(\w+)\s*=\s*${VAL}\s*;`, 'g'),
    new RegExp(String.raw`(?:^|[\s,{])(\w+)\s*=\s*${VAL}\s*,?\s*(?:$|//)`, 'gm'), // enum { LED = GPIO_NUM_2, }
  ];
  const skippedNums = [];
  const seen = new Set();
  for (const re of defs) for (const m of src.matchAll(re)) {
    const s = m[1], v = m[2];
    if (/_Pin$|_GPIO_Port$/.test(s) || seen.has(`${s}=${v}`)) continue;
    let key;
    if (/^\d+$/.test(v)) {
      if (numbers !== 'gpio' || !PINISH.test(s) || +v > 60) { if (PINISH.test(s) && +v <= 60) skippedNums.push(s); continue; }
      key = `GPIO${+v}`;
    } else key = canon(v.replace(/\s+/g, ''));
    if (!key) continue;
    seen.add(`${s}=${v}`);
    syms.push({ sym: s, key, line: lineOf(m.index + m[0].indexOf(s)), how: /^\d+$/.test(v) ? 'number as GPIO' : 'define / const' });
  }
  // Zephyr devicetree
  for (const m of src.matchAll(/(\w+)\s*:\s*[\w-]+(?:@\w+)?\s*\{[^{}]*?gpios\s*=\s*<\s*&gpio([a-k]|\d)\s+(\d+)/gi)) {
    const port = m[2];
    const key = /\d/.test(port) ? `P${port}.${String(+m[3]).padStart(2, '0')}` : `P${port.toUpperCase()}${+m[3]}`;
    syms.push({ sym: m[1], key, alt: port === '0' ? `GPIO${+m[3]}` : null, line: lineOf(m.index), how: 'devicetree gpios' });
  }
  return { syms, unpaired, skippedNums };
}

// ---------- names ----------
const STOP = new Set(['PIN', 'GPIO', 'PORT', 'IO', 'NET', 'THE', 'MCU', 'N']);
const words = (s) => String(s).replace(/^\//, '').split('/').pop().replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w && !STOP.has(w));
const related = (a, b) => { const A = words(a), B = words(b); return A.some((x) => B.some((y) => x === y || (x.length >= 3 && y.startsWith(x)) || (y.length >= 3 && x.startsWith(y)))); };
const isPower = (net) => /^(\/)?(GND|AGND|DGND|PGND|VSS\w*|VDD\w*|VCC\w*|VBAT|VREF\S*|\+?\d+V\d*|\+\d+V\w*|3V3|5V|1V8)$/i.test(net.replace(/^\//, ''));
const isUnconnected = (net) => /^unconnected-/i.test(net) || /^NC$/i.test(net);
const isAuto = (net) => /^Net-\(/.test(net);

/** Whether a map row [pin, pin name, net, symbol, ...] matches a trace query (lower-cased). */
export function rowMatches(r, q) {
  return r.slice(0, 4).some((c) => String(c).toLowerCase().includes(q)) || !!(canon(q) && canon(q) === pinKey(r[1]));
}

export function run({ netlist, mcu, firmware, numbers, query }) {
  const warnings = [], notes = [];
  const nl = String(netlist ?? '');
  if (!nl.trim()) return { warnings: ['Paste the netlist (KiCad .net file, or CSV lines ref,pin,name,net).'] };
  const { nodes, problems, format } = parseNetlist(nl);
  warnings.push(...problems);
  if (!nodes.length) return { warnings };
  const refs = [...new Set(nodes.map((n) => n.ref).filter(Boolean))];
  let ref = String(mcu ?? '').trim();
  if (ref && refs.length && !refs.includes(ref)) {
    warnings.push(`No part "${ref}" in the netlist (refs: ${refs.slice(0, 12).join(', ')}${refs.length > 12 ? '…' : ''}). Set the MCU reference.`);
    return { warnings };
  }
  if (!ref) {
    // the part with the most port-named pins
    const score = new Map();
    for (const n of nodes) if (pinKey(n.name)) score.set(n.ref, (score.get(n.ref) || 0) + 1);
    ref = [...score].sort((a, b) => b[1] - a[1])[0]?.[0] ?? refs[0] ?? '';
    if (ref) notes.push(`MCU reference not given: ${ref} has the most GPIO-named pins and was used.`);
  }
  const pins = nodes.filter((n) => !refs.length || n.ref === ref);
  const byNet = new Map();
  for (const n of nodes) (byNet.get(n.net) || byNet.set(n.net, []).get(n.net)).push(n);

  const { syms, unpaired, skippedNums } = parseFirmware(firmware, numbers);
  for (const s of unpaired) warnings.push(`Firmware: ${s}_Pin has no matching ${s}_GPIO_Port define, so its port is unknown; it was skipped.`);
  if (skippedNums.length) notes.push(`Bare numbers were ${numbers === 'gpio' ? 'too large to be GPIO numbers' : 'not mapped'} for: ${skippedNums.join(', ')}${numbers !== 'gpio' ? ' (set "Bare numbers mean" to GPIO numbers for ESP32 / RP2040)' : ''}.`);

  const keyToPins = new Map();
  for (const p of pins) { p.key = pinKey(p.name); if (p.key) (keyToPins.get(p.key) || keyToPins.set(p.key, []).get(p.key)).push(p); }
  const symsByKey = new Map();
  for (const s of syms) {
    let k = s.key;
    if (!keyToPins.has(k) && s.alt && keyToPins.has(s.alt)) k = s.alt;
    s.at = k;
    (symsByKey.get(k) || symsByKey.set(k, []).get(k)).push(s);
  }

  // ---- rows per MCU pin ----
  const rows = [];
  const chipPins = []; // the same rows as structured data, for the page's drawing of the part
  let ok = 0, missingFw = 0, onDead = 0, mismatch = 0;
  const sorted = [...pins].sort((a, b) => (parseInt(a.pin, 10) - parseInt(b.pin, 10)) || String(a.pin).localeCompare(String(b.pin)));
  const seenPin = new Set();
  for (const p of sorted) {
    if (seenPin.has(p.pin)) continue; seenPin.add(p.pin);
    const ss = p.key ? symsByKey.get(p.key) || [] : [];
    const others = (byNet.get(p.net) || []).filter((o) => o !== p).map((o) => `${o.ref}.${o.pin}`);
    const unc = isUnconnected(p.net) || (!others.length && !isPower(p.net));
    let status;
    if (isPower(p.net)) { status = 'power'; }
    else if (!p.key) { status = unc ? 'unconnected' : 'not a GPIO name'; }
    else if (ss.length && unc) { status = 'firmware uses an unconnected pin'; onDead++; }
    else if (ss.length && !isAuto(p.net) && !ss.some((s) => related(s.sym, p.net))) { status = 'names differ'; mismatch++; }
    else if (ss.length) { status = 'ok'; ok++; }
    else if (unc) status = 'unconnected';
    else { status = isAuto(p.net) ? 'unnamed net, not in firmware' : 'not in firmware'; missingFw++; }
    rows.push([p.pin, p.name || '–', unc && !isUnconnected(p.net) && !others.length ? `${p.net} (no other pin)` : p.net, ss.map((s) => s.sym).join(', ') || '–', others.slice(0, 4).join(', ') + (others.length > 4 ? ` +${others.length - 4}` : '') || '–', status]);
    chipPins.push({ pin: p.pin, name: p.name || '', key: p.key || null, net: p.net, type: p.type || '', status, unconnected: unc,
      symbols: ss.map((s) => ({ sym: s.sym, line: s.line, how: s.how })),
      others: (byNet.get(p.net) || []).filter((o) => o !== p).map((o) => ({ ref: o.ref, pin: o.pin, name: o.name || '', type: o.type || '' })) });
  }
  const orphans = syms.filter((s) => !keyToPins.has(s.at));
  const dupes = [...symsByKey].filter(([k, v]) => keyToPins.has(k) && new Set(v.map((s) => s.sym)).size > 1);

  if (onDead) warnings.push(`${onDead} firmware symbol${onDead > 1 ? 's point' : ' points'} at a pin with nothing else on its net: wrong pin in firmware, or a missing connection on the board.`);
  if (orphans.length) warnings.push(`${orphans.length} firmware symbol${orphans.length > 1 ? 's name pins' : ' names a pin'} that ${ref} does not have: ${orphans.map((s) => `${s.sym} (${s.key})`).join(', ')}. Check the port letter, or the package's pin list.`);
  if (mismatch) notes.push(`${mismatch} pin${mismatch > 1 ? 's have' : ' has'} a firmware name that shares no word with its net name: harmless if intended, a classic swap if not.`);
  for (const [k, v] of dupes) notes.push(`${k} has several firmware names: ${[...new Set(v.map((s) => s.sym))].join(', ')} (aliases, or a conflict).`);
  if (missingFw && syms.length) notes.push(`${missingFw} connected GPIO pin${missingFw > 1 ? 's are' : ' is'} not named in the firmware you pasted (may be configured elsewhere, e.g. by a peripheral's alternate function).`);
  if (!syms.length && String(firmware ?? '').trim()) warnings.push('No pin symbols found in the firmware text: paste the defines (main.h, board.h, pins.h) or the devicetree overlay.');

  // ---- query ----
  const q = String(query ?? '').trim().toLowerCase();
  let shown = rows;
  const values = [
    { label: 'MCU', value: ref || '–', hint: `${seenPin.size} pins · ${format}` },
    { label: 'Pins traced to firmware', value: ok + mismatch + onDead, tone: 'ok' },
    { label: 'Connected, not in firmware', value: missingFw, tone: missingFw ? 'warn' : 'ok' },
    { label: 'Firmware on dead pins', value: onDead, tone: onDead ? 'bad' : 'ok' },
    { label: 'Symbols not on this MCU', value: orphans.length, tone: orphans.length ? 'bad' : 'ok' },
  ];
  if (q) {
    shown = rows.filter((r) => rowMatches(r, q));
    if (!shown.length) warnings.push(`Nothing matches "${query}" among ${ref}'s pins, nets or firmware symbols.`);
    else if (shown.length === 1) {
      const r = shown[0];
      values.unshift({ label: 'Trace', value: `pin ${r[0]} (${r[1]}) → ${r[2]} → ${r[3]}`, tone: r[5] === 'ok' ? 'ok' : 'warn' });
    }
  }
  const tables = [{ title: q ? `Pins matching "${query}"` : `${ref} pins`, columns: ['Pin', 'Pin name', 'Net', 'Firmware symbol', 'Also on net', 'Status'], rows: shown }];
  if (orphans.length) tables.push({ title: 'Firmware symbols with no pin', columns: ['Symbol', 'Pin', 'Line', 'Read as'], rows: orphans.map((s) => [s.sym, s.key, s.line, s.how]) });
  if (syms.length) tables.push({ title: 'Firmware symbols read', columns: ['Symbol', 'Pin', 'Line', 'Read as'], rows: syms.map((s) => [s.sym, s.at, s.line, s.how]) });
  const csv = ['pin,pin_name,net,firmware_symbol,status', ...rows.map((r) => [r[0], r[1], r[2], r[3], r[5]].map((c) => (/[,"]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(','))].join('\n') + '\n';
  notes.push('Pins are joined on port and number (PA5 = PA_5 = GPIOA pin 5; GPIO5 = IO5 = GPIO_NUM_5; P0.13 = NRF_GPIO_PIN_MAP(0,13)). Power nets are recognised by name (GND, VDD, +3V3...).');
  // For the page: the part's pins as data (which rows the query picked, too).
  const picked = new Set(q ? shown.map((r) => r[0]) : []);
  const chip = {
    ref, format, pinCount: seenPin.size, query: q,
    pins: chipPins.map((c) => ({ ...c, match: picked.has(c.pin) })),
    orphans: orphans.map((s) => ({ sym: s.sym, key: s.key, line: s.line, how: s.how })),
    counts: { ok, mismatch, onDead, missingFw, orphans: orphans.length },
  };
  return { values, tables, warnings, notes, texts: [{ title: 'Pin map CSV', body: csv, lang: 'csv' }], chip };
}
