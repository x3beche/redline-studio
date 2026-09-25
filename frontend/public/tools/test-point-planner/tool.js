// Test point plan from a list of nets, with probe access checks.
//
// Each net is classified (by the kind given, or by its name) and gets a
// priority and a test-point count:
//   power    >= 1, and ceil(I / (50 % of the probe rating)) when the rail is
//            powered or loaded through probes (probes are derated by half)
//   ground   max(2, one per ten other test points), spread over the board
//   debug    always: programming and reset pads
//   high-speed  avoid stubs: test at the connector or on a via
// Probe access (pad size, centre-to-centre pitch, distance from the board
// edge) follows the usual in-circuit-test DFT guidance: 100 mil (2.54 mm)
// pitch preferred for bed-of-nails, 0.9-1.0 mm pads, 3.2 mm (0.125 in) from
// the board edge for the fixture's gasket; flying probes take much smaller.
import { fmtNum } from '../kit/eng.js';

const METHOD = {
  bed: { name: 'Bed-of-nails (ICT fixture)', pad: 0.9, pitch: 2.54, pitchMin: 1.905, edge: 3.2, full: true, sides: 'bottom' },
  flying: { name: 'Flying probe', pad: 0.5, pitch: 1.0, pitchMin: 0.5, edge: 1.0, full: true, sides: 'both' },
  pogo: { name: 'Pogo programming / bring-up fixture', pad: 1.0, pitch: 2.54, pitchMin: 2.54, edge: 3.0, full: false, sides: 'bottom' },
  manual: { name: 'Manual probing (bench)', pad: 1.0, pitch: 2.54, pitchMin: 1.27, edge: 1.0, full: false, sides: 'top' },
};
const KINDS = ['power', 'gnd', 'debug', 'clock', 'hs', 'analog', 'control', 'signal'];
const ALIAS = { ground: 'gnd', pwr: 'power', rail: 'power', supply: 'power', prog: 'debug', swd: 'debug', jtag: 'debug', clk: 'clock', highspeed: 'hs', diff: 'hs', sense: 'analog', ctrl: 'control', sig: 'signal', io: 'signal', gpio: 'signal' };

function guessKind(name) {
  const n = name.toUpperCase().replace(/^[/\\]+/, '');
  if (/^(GND|AGND|DGND|PGND|SGND|VSS|VSSA|GROUND|0V|EARTH|CHASSIS)\b/.test(n)) return 'gnd';
  if (/(SWDIO|SWCLK|SWO|TDI|TDO|TMS|TCK|NRST|RESET|RST|BOOT|JTAG|PROG|UART.*(TX|RX)|^TXD?$|^RXD?$|DEBUG)/.test(n)) return 'debug';
  if (/(USB_?D[PN+-]|^D[PN+-]$|^D[+-]$|PCIE|HDMI|LVDS|MIPI|SATA|ETH|MDI|RGMII|TMDS|_[PN]$)/.test(n)) return 'hs';
  if (/(CLK|XTAL|OSC|XIN|XOUT|MCO)/.test(n)) return 'clock';
  if (/^(\+?\d+V\d*|V\d+V\d*|\d+V\d+|VBUS|VIN|VCC\w*|VDD\w*|VBAT\w*|VSYS|VOUT\w*|VMOT\w*|V_?\w*RAIL|PWR\w*|\+\w+)$/.test(n)) return 'power';
  if (/(ADC|AIN|SENSE|SNS|VREF|FB$|ISENSE|THERM|NTC)/.test(n)) return 'analog';
  if (/(^EN($|_)|_EN$|ENABLE|PGOOD|^PG$|_PG$|INT|IRQ|ALERT|FAULT)/.test(n)) return 'control';
  return 'signal';
}

/** One line -> {name, kind, amps, x, y, side} or null. */
function parseLine(line) {
  // CSV without spaces (VBUS,power,1.5) splits on commas; otherwise a comma
  // only separates when a space follows, so @x,y stays one token.
  const csv = !/\s/.test(line) && line.includes(',') && !line.includes('@');
  const parts = line.split(csv ? /,/ : /\t|;|,\s+|\s+/).filter(Boolean);
  if (!parts.length) return null;
  const name = parts.shift().replace(/^["']|["']$/g, '');
  if (!/^[\w/\\+\-.~$#[\]]+$/.test(name)) return null;
  const out = { name, kind: null, amps: null, x: null, y: null, side: null, extra: [] };
  for (const p of parts) {
    const t = p.toLowerCase();
    const pos = /^@?(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(t);
    if (pos) { out.x = Number(pos[1]); out.y = Number(pos[2]); continue; }
    if (KINDS.includes(t) || ALIAS[t]) { out.kind = KINDS.includes(t) ? t : ALIAS[t]; continue; }
    if (/^(top|t|bottom|bot|b)$/.test(t)) { out.side = t.startsWith('t') ? 'top' : 'bottom'; continue; }
    const a = /^(\d+(?:\.\d+)?)(m?)a?$/.exec(t);
    if (a) { out.amps = Number(a[1]) * (a[2] ? 1e-3 : 1); continue; }
    out.extra.push(p);
  }
  return out;
}

/** Net names from a KiCad netlist or a pasted list. */
function readNets(text) {
  const src = String(text || '');
  const bad = [];
  if (/\(net\s+\(code/.test(src)) {
    const names = [...src.matchAll(/\(net\s+\(code\s+"?\d+"?\)\s+\(name\s+"?([^")]+)"?\)/g)].map((m) => m[1]);
    return { rows: [...new Set(names)].filter((n) => !/^(unconnected-|Net-\()/.test(n)).map((n) => ({ name: n.replace(/^\//, ''), kind: null, amps: null, x: null, y: null, side: null, extra: [] })), bad, format: 'KiCad netlist' };
  }
  const rows = [];
  src.split(/\r?\n/).forEach((raw, line) => {
    const l = raw.trim();
    if (!l || /^(#|\/\/)/.test(l)) return;
    if (/^(net|name)\b/i.test(l) && /kind|type|current/i.test(l)) return; // a header row
    const r = parseLine(l);
    if (r) rows.push({ ...r, line }); else bad.push(l);
  });
  return { rows, bad, format: 'list' };
}

const PLAN = {
  power: ['must', 'Voltage and ripple at bring-up; power the board through it in ICT.'],
  gnd: ['must', 'Probe return: spread them, one near each power test point.'],
  debug: ['must', 'Programming and reset: group them on a 2.54 mm grid or a Tag-Connect footprint.'],
  clock: ['should', 'Pad right on the trace, no stub; above ~50 MHz the pad and probe load it.'],
  hs: ['avoid', 'No stubs on a high-speed line: test at the connector or use an existing via; above ~1 Gb/s leave it alone.'],
  analog: ['should', 'Sense/reference points; a Kelvin pair where the drop matters.'],
  control: ['should', 'Enable, power-good, interrupts: what you look at when bring-up fails.'],
  signal: ['optional', 'Needed for net coverage in ICT; a via or pad is enough for a flying probe.'],
};
const f = (v) => fmtNum(v, 3);

export function run({ nets, method, rating, bw, bh }) {
  const warnings = [];
  const M = METHOD[method] || METHOD.bed;
  const { rows, bad, format } = readNets(nets);
  if (!rows.length) return { warnings: ['Paste the nets, one per line: NAME [kind] [current A] [@x,y] [top|bottom]. A KiCad netlist (.net) works too.'] };
  const probeA = rating > 0 ? rating : 2;
  if (bad.length) warnings.push(`Could not read ${bad.length} line(s): ${bad.slice(0, 4).map((b) => `"${b.slice(0, 40)}"`).join(', ')}${bad.length > 4 ? ' ...' : ''}. Write NAME first, then kind, current, @x,y, side.`);
  const odd = rows.filter((r) => r.extra.length);
  if (odd.length) warnings.push(`Ignored words on ${odd.length} line(s): ${odd.slice(0, 3).map((r) => `${r.name}: "${r.extra.join(' ')}"`).join(', ')}. Kinds are power, gnd, debug, clock, hs, analog, control, signal.`);
  const seen = new Map();
  for (const r of rows) {
    if (seen.has(r.name) && r.x == null) warnings.push(`${r.name} is listed twice: counted once.`);
    if (!seen.has(r.name)) seen.set(r.name, r);
  }
  const plan = [];
  for (const r of seen.values()) {
    const kind = r.kind || guessKind(r.name);
    let [prio, why] = PLAN[kind];
    if (kind === 'signal' && M.full) prio = 'must';
    let n = prio === 'avoid' ? 0 : prio === 'optional' ? 0 : 1;
    if (kind === 'power' && r.amps > 0) n = Math.max(1, Math.ceil(r.amps / (0.5 * probeA)));
    if (kind === 'gnd') n = 0; // counted below
    plan.push({ ...r, kind, prio, n, why, guessed: !r.kind });
  }
  const others = plan.reduce((s, p) => s + p.n, 0);
  const gndNets = plan.filter((p) => p.kind === 'gnd');
  const gndTotal = Math.max(2, Math.ceil(others / 10));
  if (gndNets.length) gndNets.forEach((g, i) => { g.n = i === 0 ? gndTotal : 1; });
  else warnings.push(`No ground net in the list: add GND with at least ${gndTotal} test points - every probe measurement needs a return.`);
  const total = plan.reduce((s, p) => s + p.n, 0) + (gndNets.length ? 0 : gndTotal);
  const must = plan.filter((p) => p.prio === 'must').length;
  const hs = plan.filter((p) => p.kind === 'hs');
  if (hs.length && method === 'bed') warnings.push(`${hs.length} high-speed net(s) (${hs.slice(0, 4).map((h) => h.name).join(', ')}) cannot get a normal test pad without a stub: test them at the connector, and accept that ICT coverage will not be 100 %.`);
  for (const p of plan) if (p.kind === 'power' && p.amps > probeA * 0.5 * 4) warnings.push(`${p.name} at ${f(p.amps)} A needs ${p.n} probes of ${f(probeA)} A: power it through its connector during test instead.`);

  // Access checks from positions, when given
  const placed = [...rows].filter((r) => r.x != null);
  const access = [];
  const issues = []; // the same problems, by pad index, for the page
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      if ((a.side || M.sides) !== (b.side || M.sides)) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < M.pitch) {
        access.push([`${a.name} - ${b.name}`, `${f(d)} mm apart`, d < M.pitchMin ? 'too close' : 'under preferred', `${M.name}: ${f(M.pitch)} mm preferred, ${f(M.pitchMin)} mm least`]);
        issues.push({ type: 'pitch', i, j, d, level: d < M.pitchMin ? 'too close' : 'under preferred' });
      }
    }
    const a = placed[i];
    if (bw > 0 && bh > 0) {
      const e = Math.min(a.x, a.y, bw - a.x, bh - a.y);
      if (e < M.edge) {
        access.push([a.name, `${f(e)} mm from the edge`, e < 0 ? 'off the board' : 'too near the edge', `keep ≥ ${f(M.edge)} mm`]);
        issues.push({ type: 'edge', i, e, level: e < 0 ? 'off the board' : 'too near the edge' });
      }
    }
    if (M.sides !== 'both' && a.side && a.side !== M.sides) {
      access.push([a.name, `on the ${a.side}`, 'wrong side', `${M.name} probes the ${M.sides} side`]);
      issues.push({ type: 'side', i, level: 'wrong side' });
    }
  }
  if (access.length) warnings.push(`${access.length} probe-access problem(s) in the placed test points: see the table.`);

  let k = 1;
  const tpList = [];
  for (const p of plan) for (let i = 0; i < p.n; i++) tpList.push(`TP${k++}\t${p.name}\t${p.kind}\t${f(M.pad)} mm\t${p.side || M.sides}`);
  if (!gndNets.length) for (let i = 0; i < gndTotal; i++) tpList.push(`TP${k++}\tGND\tgnd\t${f(M.pad)} mm\t${M.sides}`);

  const order = { must: 0, should: 1, optional: 2, avoid: 3 };
  plan.sort((a, b) => order[a.prio] - order[b.prio]);
  // Everything the page draws, as numbers: the plan per net, the placed pads
  // (with the source line each came from) and the access problems by pad.
  const firstLine = {};
  for (const r of rows) if (!(r.name in firstLine)) firstLine[r.name] = r.line ?? null;
  const drawPlan = {
    method: METHOD[method] ? method : 'bed', M, probeA, bw: bw > 0 ? bw : null, bh: bh > 0 ? bh : null, format,
    total, gndTotal, must, missingGnd: !gndNets.length,
    nets: plan.map((p) => ({ name: p.name, kind: p.kind, prio: p.prio, n: p.n, amps: p.amps, guessed: p.guessed, line: firstLine[p.name] ?? null })),
    pads: placed.map((r) => ({ name: r.name, x: r.x, y: r.y, side: r.side || M.sides, sideGiven: r.side, line: r.line ?? null })),
    issues,
  };
  return {
    plan: drawPlan,
    values: [
      { label: 'Nets read', value: plan.length, hint: format },
      { label: 'Test points', value: total, tone: 'ok', hint: `${must} net${must === 1 ? '' : 's'} must have one` },
      { label: 'Ground test points', value: gndTotal, hint: 'max(2, 1 per 10)' },
      { label: 'Pad diameter', value: `≥ ${f(M.pad)}`, unit: 'mm', hint: M.name },
      { label: 'Probe pitch', value: `${f(M.pitch)}`, unit: 'mm', hint: `least ${f(M.pitchMin)} mm, centre to centre` },
      { label: 'From board edge', value: `≥ ${f(M.edge)}`, unit: 'mm', hint: `probe from ${M.sides === 'both' ? 'both sides' : `the ${M.sides}`}` },
    ],
    warnings,
    tables: [
      { title: 'Plan per net', columns: ['Net', 'Kind', 'Priority', 'TPs', 'Why'], rows: plan.map((p) => [p.name, p.kind + (p.guessed ? ' (by name)' : ''), p.prio, p.n, p.why + (p.kind === 'power' && p.amps ? ` ${f(p.amps)} A / ${f(probeA * 0.5)} A per probe.` : '')]) },
      ...(access.length ? [{ title: 'Probe access problems', columns: ['Where', 'Found', 'Problem', 'Rule'], rows: access }] : []),
    ],
    texts: [{ title: 'Test point list', body: `Ref\tNet\tKind\tPad\tSide\n${tpList.join('\n')}\n` }],
    notes: [
      `${M.name}: pads ≥ ${f(M.pad)} mm, no solder mask on them, not covered by parts or silk; ≥ 1 mm from part bodies (more beside tall parts).`,
      'Kinds guessed from names are marked "(by name)": write the kind after the net to override (power, gnd, debug, clock, hs, analog, control, signal).',
      'Probe currents are derated to 50 %; check the fixture maker\'s probe rating.',
    ],
  };
}
