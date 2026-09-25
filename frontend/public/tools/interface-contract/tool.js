// Interface contract: the GPIO map, the I2C addresses and the voltage rails of
// a board, defined once and checked, so the PCB, firmware and mechanical rooms
// (and their agents) work from one record. view.js loads and saves the tables
// as the project's record (/api/tools/data/interface-contract); run() is pure
// and only checks and exports what it is given.
// Checks and where they come from:
//   I2C 7-bit addresses 0x00-0x07 and 0x78-0x7F are reserved (NXP UM10204 rev. 7, table 4);
//   an address above 0x7F is an 8-bit (address + R/W) form: the 7-bit one is addr >> 1.
//   A bus runs at the speed of its slowest device (UM10204 section 5).
//   CMOS input thresholds VIH = 0.7 VDD, VIL = 0.3 VDD (JEDEC JESD8C / JESD8-5 style levels);
//   a pin's absolute maximum is typically VDD + 0.3 V unless it is 5 V tolerant (check the MCU datasheet).

const DIRS = ['in', 'out', 'io', 'od', 'analog', 'pwm'];

export function parseAddr(a) {
  const t = String(a ?? '').trim().toLowerCase();
  if (!t) return null;
  const v = /^0x[0-9a-f]+$/.test(t) ? parseInt(t, 16) : /^[01]{7,8}b$/.test(t) ? parseInt(t, 2) : /^\d+$/.test(t) ? parseInt(t, 10) : NaN;
  return Number.isFinite(v) ? v : NaN;
}
const hex = (v) => '0x' + v.toString(16).toUpperCase().padStart(2, '0');
const num = (v) => { const x = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(x) ? x : null; };
const ident = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'X';

export function run(input) {
  const warnings = [], issues = [];
  // Each issue goes into the Issues table and onto the item it is about (for the page's drawing).
  const flag = (item, row) => { issues.push(row); if (item) item.issues.push(row[2]); };
  const rails = (Array.isArray(input.rails) ? input.rails : []).map((r, row) => ({ row, issues: [], name: String(r.name || '').trim(), v: num(r.volts), source: String(r.source || '').trim(), notes: String(r.notes || '').trim() })).filter((r) => r.name);
  const gpio = (Array.isArray(input.gpio) ? input.gpio : []).map((g, row) => ({ row, issues: [], signal: String(g.signal || '').trim(), pin: String(g.pin || '').trim(), dir: String(g.dir || '').trim().toLowerCase(),
    rail: String(g.rail || '').trim(), pull: String(g.pull || 'none').trim().toLowerCase(), notes: String(g.notes || '').trim() })).filter((g) => g.signal || g.pin);
  const i2c = (Array.isArray(input.i2c) ? input.i2c : []).map((d, row) => ({ row, issues: [], bus: String(d.bus || '0').trim() || '0', addr: parseAddr(d.addr), raw: String(d.addr ?? '').trim(), device: String(d.device || '').trim(), khz: num(d.khz), notes: String(d.notes || '').trim() })).filter((d) => d.raw || d.device);

  const railV = new Map(rails.map((r) => [r.name.toUpperCase(), r.v]));
  const mcuRail = String(input.mcu_rail || '').trim();
  const mcuV = railV.get(mcuRail.toUpperCase()) ?? num(mcuRail);
  const tol5 = !!input.five_tolerant;
  if (mcuV == null) warnings.push(`MCU I/O rail "${mcuRail}" is not in the rails table: add it, or write its voltage (e.g. 3.3).`);
  for (const r of rails) if (r.v == null) flag(r, ['Rails', r.name, 'no voltage given']);

  // ---- GPIO ----
  const seenPin = new Map(), seenSig = new Map();
  for (const g of gpio) {
    const id = g.signal || g.pin;
    if (!g.signal) flag(g, ['GPIO', id, 'no signal name']);
    if (!g.pin) flag(g, ['GPIO', id, 'no pin assigned']);
    if (g.pin) { const k = g.pin.toUpperCase(); if (seenPin.has(k)) flag(g, ['GPIO', id, `pin ${g.pin} also used by ${seenPin.get(k)}`]); else seenPin.set(k, id); }
    if (g.signal) { const k = g.signal.toUpperCase(); if (seenSig.has(k)) flag(g, ['GPIO', id, 'signal name defined twice']); else seenSig.set(k, 1); }
    if (!DIRS.includes(g.dir)) flag(g, ['GPIO', id, `direction "${g.dir}" is not one of ${DIRS.join(', ')}`]);
    const v = g.rail ? (railV.get(g.rail.toUpperCase()) ?? num(g.rail)) : mcuV;
    g.v = v;
    if (g.rail && v == null) flag(g, ['GPIO', id, `rail "${g.rail}" is not in the rails table`]);
    if (v != null && mcuV != null && v > mcuV + 0.05) {
      if (['in', 'io', 'analog', 'od'].includes(g.dir)) {
        const lim = mcuV + 0.3;
        if (!tol5 || v > 5.5) flag(g, ['GPIO', id, `${v} V into a ${mcuV} V pin: above its ~${lim.toFixed(1)} V absolute maximum. Use a divider, a level shifter, or a 5 V tolerant pin`]);
        else flag(g, ['GPIO', id, `${v} V on a 5 V tolerant pin: fine when the MCU is powered; check the datasheet for the unpowered case and analog mode`]);
      }
      if (['out', 'io', 'pwm'].includes(g.dir)) {
        const vih = 0.7 * v;
        if (vih > mcuV - 0.1) flag(g, ['GPIO', id, `the device on ${v} V wants VIH ≈ ${vih.toFixed(2)} V (0.7 × VDD); a ${mcuV} V output may not reach it. Use a level shifter or a TTL-input part (74HCT, VIH 2.0 V)`]);
      }
    }
    if (g.dir === 'od' && g.pull === 'none') flag(g, ['GPIO', id, 'open-drain with no pull-up listed: add one (here or on the board)']);
    if (g.dir === 'analog' && g.pull !== 'none') flag(g, ['GPIO', id, `analog input with a pull-${g.pull}: the pull skews the reading; turn it off`]);
  }

  // ---- I2C ----
  const buses = new Map();
  for (const d of i2c) {
    const id = `${d.device || '?'} @ ${d.raw || '?'}`;
    if (d.addr == null) { flag(d, ['I2C', id, 'no address']); continue; }
    if (Number.isNaN(d.addr)) { flag(d, ['I2C', id, 'address not readable: write 0x48, 72 or 1001000b']); continue; }
    if (d.addr > 0x7F && d.addr <= 0xFF) { flag(d, ['I2C', id, `${hex(d.addr)} is an 8-bit address (with R/W): the 7-bit address is ${hex(d.addr >> 1)}`]); d.addr >>= 1; d.eight = true; }
    else if (d.addr > 0xFF) { flag(d, ['I2C', id, 'address above 0xFF: 10-bit addressing is not checked here']); continue; }
    if (d.addr <= 0x07 || d.addr >= 0x78) flag(d, ['I2C', id, `${hex(d.addr)} is in a reserved range (0x00-0x07, 0x78-0x7F; UM10204 table 4)`]);
    if (!buses.has(d.bus)) buses.set(d.bus, []);
    buses.get(d.bus).push(d);
  }
  const busRows = [], busInfo = [];
  for (const [bus, list] of buses) {
    const by = new Map();
    for (const d of list) { const k = d.addr; if (!by.has(k)) by.set(k, []); by.get(k).push(d.device || '?'); }
    for (const [a, devs] of by) if (devs.length > 1) {
      const msg = `address conflict: ${devs.join(', ')}. Change an address strap, or move one to another bus / behind a mux (TCA9548A)`;
      issues.push(['I2C', `bus ${bus} ${hex(a)}`, msg]);
      for (const d of list) if (d.addr === a) d.issues.push(msg);
    }
    const speeds = list.map((d) => d.khz).filter((k) => k > 0);
    const busKhz = speeds.length ? Math.min(...speeds) : null;
    const slow = speeds.length && busKhz < Math.max(...speeds) ? list.filter((d) => d.khz === busKhz).map((d) => d.device).join(', ') : '';
    busInfo.push({ bus, khz: busKhz, limitedBy: slow ? slow.split(', ') : [], devices: list.length });
    busRows.push([bus, list.length, [...by.keys()].sort((a, b) => a - b).map(hex).join(' '), busKhz ? `${busKhz} kHz` : '–', slow ? `limited by ${slow}` : '']);
  }

  const bad = issues.length;
  if (bad) warnings.push(`${bad} issue(s) in the contract - see "Issues". Fix them before the rooms build on it.`);
  const values = [
    { label: 'GPIO signals', value: gpio.length, hint: `${seenPin.size} pins used` },
    { label: 'I2C devices', value: i2c.length, hint: `${buses.size} bus(es)` },
    { label: 'Rails', value: rails.length, hint: mcuV != null ? `MCU I/O ${mcuV} V` : 'MCU rail unknown' },
    { label: 'Issues', value: bad, tone: bad ? 'bad' : 'ok' },
  ];

  // ---- exports ----
  const name = String(input.board || 'board').trim() || 'board';
  const guard = `${ident(name)}_PINS_H`;
  const header = [`// ${name}: interface contract (generated by the Interface Contract tool - edit the contract, not this file)`, `#ifndef ${guard}`, `#define ${guard}`, '',
    '// GPIO',
    ...gpio.filter((g) => g.signal && g.pin).map((g) => { const n = (/(\d+)\s*$/.exec(g.pin) || [])[1]; return `#define PIN_${ident(g.signal).padEnd(18)} ${n ?? `/* ${g.pin} */ -1`}  // ${g.pin}, ${g.dir}${g.v != null ? `, ${g.v} V` : ''}${g.pull !== 'none' ? `, pull-${g.pull}` : ''}`; }),
    '', '// I2C 7-bit addresses',
    ...[...buses].flatMap(([bus, list]) => list.map((d) => `#define I2C${ident(bus)}_ADDR_${ident(d.device).padEnd(12)} ${hex(d.addr)}${d.khz ? `  // max ${d.khz} kHz` : ''}`)),
    '', '// Rails (mV)', ...rails.filter((r) => r.v != null).map((r) => `#define ${`RAIL_${ident(r.name)}_MV`.padEnd(22)} ${Math.round(r.v * 1000)}`),
    '', `#endif // ${guard}`, ''].join('\n');
  const md = [`# ${name} - interface contract`, '', `MCU I/O rail: ${mcuRail || '?'}${mcuV != null ? ` (${mcuV} V)` : ''}${tol5 ? ', 5 V tolerant inputs' : ''}`, '',
    '## GPIO', '', '| Signal | Pin | Dir | Level | Pull | Notes |', '|---|---|---|---|---|---|',
    ...gpio.map((g) => `| ${g.signal} | ${g.pin} | ${g.dir} | ${g.v != null ? g.v + ' V' : '?'} | ${g.pull} | ${g.notes} |`), '',
    '## I2C', '', '| Bus | Address | Device | Max speed | Notes |', '|---|---|---|---|---|',
    ...i2c.map((d) => `| ${d.bus} | ${Number.isFinite(d.addr) && d.addr != null ? hex(d.addr) : d.raw} | ${d.device} | ${d.khz ? d.khz + ' kHz' : ''} | ${d.notes} |`), '',
    '## Rails', '', '| Rail | Voltage | Source | Notes |', '|---|---|---|---|',
    ...rails.map((r) => `| ${r.name} | ${r.v ?? '?'} V | ${r.source} | ${r.notes} |`), ''].join('\n');
  const json = JSON.stringify({ board: name, mcu_rail: mcuRail, five_tolerant: tol5,
    rails: rails.map((r) => ({ name: r.name, volts: r.v, source: r.source })),
    gpio: gpio.map((g) => ({ signal: g.signal, pin: g.pin, dir: g.dir, volts: g.v ?? null, pull: g.pull })),
    i2c: i2c.map((d) => ({ bus: d.bus, addr: Number.isFinite(d.addr) && d.addr != null ? hex(d.addr) : d.raw, device: d.device, khz: d.khz })) }, null, 2) + '\n';

  // For the page's drawing (agentOmit: contract): every row with its index, level and issues.
  const contract = {
    board: name, mcuRail, mcuV: mcuV ?? null, fiveTolerant: tol5,
    rails: rails.map((r) => ({ row: r.row, name: r.name, v: r.v, source: r.source, mcu: r.name.toUpperCase() === mcuRail.toUpperCase() || (r.v != null && r.v === num(mcuRail)), issues: r.issues })),
    gpio: gpio.map((g) => ({ row: g.row, signal: g.signal, pin: g.pin, dir: g.dir, pull: g.pull, rail: g.rail, v: g.v ?? null, issues: g.issues })),
    i2c: i2c.map((d) => ({ row: d.row, bus: d.bus, addr: Number.isFinite(d.addr) ? d.addr : null, raw: d.raw, device: d.device, khz: d.khz, eight: !!d.eight, issues: d.issues })),
    buses: busInfo,
  };
  return {
    contract,
    values, warnings,
    tables: [
      ...(issues.length ? [{ title: 'Issues', columns: ['Area', 'Item', 'Problem'], rows: issues }] : []),
      { title: 'I2C buses', columns: ['Bus', 'Devices', 'Addresses', 'Bus speed', 'Note'], rows: busRows },
      { title: 'GPIO map', columns: ['Signal', 'Pin', 'Dir', 'Level', 'Pull'], rows: gpio.map((g) => [g.signal || '–', g.pin || '–', g.dir, g.v != null ? `${g.v} V` : '?', g.pull]) },
    ],
    texts: [{ title: 'C header', body: header, lang: 'c' }, { title: 'Markdown', body: md, lang: 'md' }, { title: 'Contract JSON', body: json, lang: 'json' }],
    notes: [
      'In the app the tables are the project\'s record: they load when the tool opens, and "Save to project" writes them for every room (agents read the same record through MCP tool_data).',
      'A GPIO row with an empty rail is taken to be on the MCU I/O rail.',
      'Level checks use generic CMOS thresholds (VIH = 0.7 VDD) and VDD + 0.3 V absolute maximum; the datasheets of the parts decide.',
    ],
  };
}
