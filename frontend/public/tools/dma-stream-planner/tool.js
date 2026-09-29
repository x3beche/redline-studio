// DMA Stream Planner: place peripheral DMA requests on an STM32's streams /
// channels, find the clashes, and write the CubeMX list and HAL init code.
//
// Three kinds of DMA front end (the request tables themselves are in data.js):
//   stream  F4/F7: DMA1/DMA2 x 8 streams; each stream picks ONE of 8 request
//           lines with DMA_SxCR.CHSEL (RM0090 §10.3.3, Tables 42/43).
//   channel F1/F0: each channel ORs a fixed set of request lines - no selector,
//           only one of them may be enabled at a time (RM0008 §13.3.7);
//           L0/L4: the same, but DMA_CSELR picks the line (RM0367 §11.3.2,
//           RM0351 §11.3.2 / Tables 41-42).
//   mux     G4/L4+/H7 DMAMUX1 and U5 GPDMA1: any request on any channel
//           (RM0440 §13, RM0432 §12, RM0433 §17, RM0456 §17).
// Arbitration inside one controller: the software priority (PL) first, then the
// lower stream/channel number wins (RM0090 §10.3.3, RM0008 §13.3.1).
import { DATA } from './data.js';

const PRIOS = ['low', 'medium', 'high', 'veryhigh'];
const PRIO_HAL = { low: 'DMA_PRIORITY_LOW', medium: 'DMA_PRIORITY_MEDIUM', high: 'DMA_PRIORITY_HIGH', veryhigh: 'DMA_PRIORITY_VERY_HIGH' };
// U5 GPDMA: two priority levels, the low one in three weights (RM0456 §17.4.12).
const PRIO_GP = { low: 'DMA_LOW_PRIORITY_LOW_WEIGHT', medium: 'DMA_LOW_PRIORITY_MID_WEIGHT', high: 'DMA_LOW_PRIORITY_HIGH_WEIGHT', veryhigh: 'DMA_HIGH_PRIORITY' };
const PRIO_CUBE = { low: 'Low', medium: 'Medium', high: 'High', veryhigh: 'Very High' };

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// Per family: its controllers and units, what the selector is called, where
// memory-to-memory may run, the IRQ vector of a unit and the manual.
export const FAMILIES = {
  f407: { label: 'STM32F405/407', kind: 'stream', ctrls: [['DMA1', range(0, 7)], ['DMA2', range(0, 7)]], sel: 'Channel',
    m2m: ['DMA2'], rm: 'RM0090 §10.3.3, Tables 42 (DMA1) and 43 (DMA2)' },
  f746: { label: 'STM32F74x/75x', kind: 'stream', ctrls: [['DMA1', range(0, 7)], ['DMA2', range(0, 7)]], sel: 'Channel',
    m2m: ['DMA2'], rm: 'RM0385 §8.3.4, DMA1/DMA2 request mapping tables' },
  f103md: { label: 'STM32F103 x8/xB (medium density)', kind: 'channel', ctrls: [['DMA1', range(1, 7)]], sel: null,
    m2m: ['DMA1'], rm: 'RM0008 §13.3.7, Table 78 (DMA1 requests)' },
  f103hd: { label: 'STM32F103 xC/xD/xE (high density)', kind: 'channel', ctrls: [['DMA1', range(1, 7)], ['DMA2', range(1, 5)]], sel: null,
    m2m: ['DMA1', 'DMA2'], rm: 'RM0008 §13.3.7, Tables 78/79 (DMA1/DMA2 requests)' },
  f072: { label: 'STM32F07x', kind: 'channel', ctrls: [['DMA1', range(1, 7)]], sel: null,
    m2m: ['DMA1'], rm: 'RM0091 §10.3.7 (DMA1 request mapping; alternates through SYSCFG_CFGR1 remap bits)' },
  l073: { label: 'STM32L07x/08x', kind: 'channel', ctrls: [['DMA1', range(1, 7)]], sel: 'CSELR',
    m2m: ['DMA1'], rm: 'RM0367 §11.3.2 (DMA1 request mapping, DMA_CSELR)' },
  l476: { label: 'STM32L47x/48x', kind: 'channel', ctrls: [['DMA1', range(1, 7)], ['DMA2', range(1, 7)]], sel: 'CSELR',
    m2m: ['DMA1', 'DMA2'], rm: 'RM0351 §11.6.7, Tables 41/42 (DMA1/DMA2 requests, DMA_CSELR)' },
  g474: { label: 'STM32G47x (DMAMUX)', kind: 'mux', ctrls: [['DMA1', range(1, 8)], ['DMA2', range(1, 8)]], sel: 'DMAMUX1',
    m2m: ['DMA1', 'DMA2'], rm: 'RM0440 §12-13 (DMA, DMAMUX request table)' },
  h743: { label: 'STM32H743/753 (DMAMUX1)', kind: 'mux', ctrls: [['DMA1', range(0, 7)], ['DMA2', range(0, 7)]], sel: 'DMAMUX1',
    m2m: ['DMA1', 'DMA2'], rm: 'RM0433 §15-17 (DMA, DMAMUX1 request table); BDMA/DMAMUX2 not planned here' },
  l4r5: { label: 'STM32L4R/L4S (DMAMUX)', kind: 'mux', ctrls: [['DMA1', range(1, 7)], ['DMA2', range(1, 7)]], sel: 'DMAMUX1',
    m2m: ['DMA1', 'DMA2'], rm: 'RM0432 §11-12 (DMA, DMAMUX request table)' },
  u575: { label: 'STM32U575/585 (GPDMA1)', kind: 'mux', ctrls: [['GPDMA1', range(0, 15)]], sel: 'GPDMA',
    m2m: ['GPDMA1'], rm: 'RM0456 §17 (GPDMA; request selection in GPDMA_CxTR2.REQSEL)' },
};

const unitWord = (fam) => (fam.kind === 'stream' || fam.label.startsWith('STM32H7') ? 'Stream' : 'Channel');
const instName = (fam, c, u) => `${c}_${unitWord(fam)}${u}`;
// Shared vectors on the small parts (from each device's CubeMX NVIC file).
function irqName(key, fam, c, u) {
  if (key === 'f072' || key === 'l073') {
    if (u === 1) return 'DMA1_Channel1_IRQn';
    if (u <= 3) return 'DMA1_Channel2_3_IRQn';
    return 'DMA1_Channel4_5_6_7_IRQn';
  }
  if (key === 'f103hd' && c === 'DMA2' && u >= 4) return 'DMA2_Channel4_5_IRQn';
  return `${instName(fam, c, u)}_IRQn`;
}

// 'TIM1_CH4/TRIG/COM' -> TIM1_CH4, TIM1_TRIG, TIM1_COM: one line, several events.
function expand(name) {
  const parts = name.split('/');
  const head = parts[0];
  const pref = head.includes('_') ? head.slice(0, head.lastIndexOf('_') + 1) : '';
  return [head, ...parts.slice(1).map((p) => pref + p)];
}
const guessDir = (n) => (/(_RX|_OUT|_READ|_FLT\d|_IC\d|PSSIRX)$|^ADC|^DCMI|^DFSDM|^MDF|^ADF|^SWPMI_RX/.test(n) ? 'R' : 'T');
// The same request under the names different reference manuals give it.
const ALIAS_GROUPS = [['DAC1', 'DAC_CH1', 'DAC1_CH1', 'DAC1_CHANNEL1'], ['DAC2', 'DAC_CH2', 'DAC1_CH2', 'DAC1_CHANNEL2'],
  ['SDIO', 'SDMMC1', 'SDMMC'], ['ADC1', 'ADC'], ['QUADSPI', 'QSPI', 'OCTOSPI1']];
const aliasesOf = (n) => (ALIAS_GROUPS.find((g) => g.includes(n)) || [n]).filter((x) => x !== n);
const norm = (s) => String(s || '').trim().toUpperCase().replace(/[\s-]+/g, '_');

/** Every request line on the family: {name, ctrl, unit, sel, dir, events}. */
export function slots(key) {
  const fam = FAMILIES[key], d = DATA[key];
  if (fam.kind === 'mux') {
    return d.reqs.split(/\s+/).filter(Boolean).map((t) => {
      const [name, dir] = t.split(':');
      return { name, dir: dir === '?' ? guessDir(name) : dir, events: [name] };
    });
  }
  const out = [];
  for (const [c, units] of fam.ctrls) {
    for (const u of units) {
      const txt = d.map[c]?.[u] || '';
      for (const t of txt.split(',').filter(Boolean)) {
        const [name, sel, dir] = t.split(':');
        out.push({ name, ctrl: c, unit: u, sel: sel === '-' ? null : Number(sel), dir, events: expand(name) });
      }
    }
  }
  return out;
}

/** 'SPI1_RX high @DMA2_S0' -> {name, prio, pin: {ctrl, unit} | null, bad}. */
export function parseLine(line) {
  const t = line.replace(/#.*/, '').trim();
  if (!t) return null;
  const words = t.split(/[\s,;]+/).filter(Boolean);
  let prio = 'low', pin = null, name = '';
  const bad = [];
  for (const w of words) {
    const lw = w.toLowerCase().replace(/[_-]/g, '');
    if (PRIOS.includes(lw) || lw === 'veryhigh' || lw === 'vhigh' || lw === 'vh') { prio = lw.startsWith('v') ? 'veryhigh' : lw; continue; }
    if (lw === 'med' || lw === 'mid') { prio = 'medium'; continue; }
    if (w.startsWith('@')) {
      const m = /^@((?:GP)?DMA\d)[._\s]*(?:S|STREAM|CH|CHANNEL|C)?\s*(\d+)$/i.exec(w);
      if (m) pin = { ctrl: m[1].toUpperCase(), unit: Number(m[2]) };
      else if (!/^@auto$/i.test(w)) bad.push(w);
      continue;
    }
    if (!name) name = norm(w); else bad.push(w);
  }
  return name ? { name, prio, pin, bad } : null;
}

export function run(input) {
  const key = FAMILIES[input.family] ? input.family : 'f407';
  const fam = FAMILIES[key];
  const all = slots(key);
  const warnings = [], notes = [];
  const units = fam.ctrls.flatMap(([c, us]) => us.map((u) => ({ ctrl: c, unit: u, id: `${c}.${u}` })));
  const unitSet = new Set(units.map((u) => u.id));

  // ---- the plan, as typed ----
  const lines = String(input.requests ?? '').split('\n');
  const plan = [];
  const seen = new Set();
  lines.forEach((l, i) => {
    const p = parseLine(l);
    if (!p) return;
    if (p.bad.length) warnings.push(`Line ${i + 1}: could not read ${p.bad.join(' ')} - write NAME [low|medium|high|veryhigh] [@DMA2_S3].`);
    const dupKey = p.name;
    if (seen.has(dupKey) && p.name !== 'MEMTOMEM') { warnings.push(`${p.name} is listed twice; the second one is ignored.`); return; }
    seen.add(dupKey);
    plan.push({ ...p, line: i + 1 });
  });

  // ---- where each request may go ----
  const knownNames = new Set(all.flatMap((s) => s.events.concat(s.name)));
  for (const r of plan) {
    if (r.name === 'MEMTOMEM' || r.name === 'M2M' || r.name === 'MEM2MEM') {
      r.name = 'MEMTOMEM'; r.dir = 'M';
      r.cands = units.filter((u) => fam.m2m.includes(u.ctrl)).map((u) => ({ ctrl: u.ctrl, unit: u.unit, sel: null, line: 'MEMTOMEM' }));
      continue;
    }
    let hits = all.filter((s) => s.name === r.name || s.events.includes(r.name));
    for (const alt of hits.length ? [] : aliasesOf(r.name)) {
      hits = all.filter((s) => s.name === alt || s.events.includes(alt));
      if (hits.length) { notes.push(`${r.name} is called ${alt} on ${fam.label}.`); break; }
    }
    if (!hits.length) {
      const stripped = r.name.replace(/_(RX|TX)$/, '');
      hits = all.filter((s) => s.name === stripped);
    }
    if (!hits.length) {
      r.cands = [];
      const stem = r.name.split('_')[0];
      const near = [...knownNames].filter((n) => n.startsWith(stem)).slice(0, 8);
      warnings.push(`${r.name} is not a DMA request on ${fam.label}.${near.length ? ` Requests of ${stem}: ${near.join(', ')}.` : ' Check the name against the reference manual.'}`);
      continue;
    }
    r.dir = hits[0].dir;
    r.line = hits[0].name;
    if (fam.kind === 'mux') r.cands = units.map((u) => ({ ctrl: u.ctrl, unit: u.unit, sel: null, line: hits[0].name }));
    else r.cands = hits.map((s) => ({ ctrl: s.ctrl, unit: s.unit, sel: s.sel, line: s.name }));
  }

  // ---- pins, then a maximum matching for the rest (Kuhn's augmenting paths) ----
  const occupied = new Map(); // unit id -> [plan index]
  plan.forEach((r, i) => {
    r.at = null; r.pinned = false; r.pinErr = null;
    if (!r.pin) return;
    const id = `${r.pin.ctrl}.${r.pin.unit}`;
    if (!unitSet.has(id)) { r.pinErr = `${r.pin.ctrl} ${unitWord(fam)} ${r.pin.unit} does not exist on ${fam.label}`; return; }
    const c = r.cands.find((x) => `${x.ctrl}.${x.unit}` === id);
    if (!c) { r.pinErr = `${r.name} is not wired to ${r.pin.ctrl} ${unitWord(fam)} ${r.pin.unit}`; return; }
    r.at = c; r.pinned = true;
    occupied.set(id, [...(occupied.get(id) || []), i]);
  });
  for (const r of plan) if (r.pinErr) {
    const where = r.cands.map((c) => `${c.ctrl} ${unitWord(fam)} ${c.unit}`).slice(0, 6).join(', ');
    warnings.push(`${r.pinErr}${where ? `; it can use ${where}` : ''}. Placed automatically instead.`);
  }
  const solve = input.solve !== false;
  const owner = new Map(); // unit id -> plan index, for the solver
  for (const [id, list] of occupied) owner.set(id, list[0]);
  const free = plan.map((r, i) => i).filter((i) => !plan[i].pinned && plan[i].cands.length);
  // Higher priority first so that, when not everything fits, the requests left
  // out are the low-priority ones; then the most constrained first.
  free.sort((a, b) => PRIOS.indexOf(plan[b].prio) - PRIOS.indexOf(plan[a].prio) || plan[a].cands.length - plan[b].cands.length || a - b);
  const pinnedIds = new Set(occupied.keys());
  function augment(i, visited) {
    for (const c of plan[i].cands) {
      const id = `${c.ctrl}.${c.unit}`;
      if (pinnedIds.has(id) || visited.has(id)) continue;
      visited.add(id);
      const j = owner.get(id);
      if (j == null || augment(j, visited)) { owner.set(id, i); plan[i].at = c; return true; }
    }
    return false;
  }
  if (solve) for (const i of free) augment(i, new Set());

  // ---- clashes and leftovers ----
  const byUnit = new Map();
  plan.forEach((r, i) => { if (r.at) { const id = `${r.at.ctrl}.${r.at.unit}`; byUnit.set(id, [...(byUnit.get(id) || []), i]); } });
  let clashes = 0;
  for (const [id, list] of byUnit) {
    if (list.length < 2) continue;
    clashes++;
    const [c, u] = id.split('.');
    for (const i of list) plan[i].clash = true;
    const alt = list.map((i) => {
      const others = plan[i].cands.filter((x) => !byUnit.has(`${x.ctrl}.${x.unit}`)).map((x) => `${x.ctrl} ${unitWord(fam)} ${x.unit}`);
      return others.length ? `${plan[i].name} also fits ${others.slice(0, 3).join(', ')}` : `${plan[i].name} has nowhere else to go`;
    });
    warnings.push(`${c} ${unitWord(fam)} ${u}: ${list.map((i) => plan[i].name).join(' and ')} are both pinned here - one ${unitWord(fam).toLowerCase()} serves one request at a time. ${alt.join('; ')}.`);
  }
  const unplaced = plan.filter((r) => !r.at && r.cands.length);
  for (const r of unplaced) {
    const holders = [...new Set(r.cands.map((c) => byUnit.get(`${c.ctrl}.${c.unit}`)).filter((l) => l).flat().map((i) => plan[i].name))];
    if (!solve) warnings.push(`${r.name} is not placed (auto-assign is off). Pin it: ${r.cands.slice(0, 4).map((c) => `@${c.ctrl}_${c.unit}`).join(', ')}.`);
    else if (fam.kind === 'mux') warnings.push(`${r.name}: all ${units.length} channels are in use. Drop a request or move one to another controller.`);
    else warnings.push(`${r.name} cannot be placed: every ${unitWord(fam).toLowerCase()} it is wired to (${r.cands.map((c) => `${c.ctrl} ${unitWord(fam)} ${c.unit}`).join(', ')}) is taken by ${holders.join(', ') || 'another request'}. Use it without DMA, or change which of those uses DMA.`);
  }

  // ---- shared vectors, F4 memory-to-memory note, arbitration ----
  const placed = plan.filter((r) => r.at);
  const irqs = new Map();
  for (const r of placed) {
    const v = irqName(key, fam, r.at.ctrl, r.at.unit);
    irqs.set(v, [...(irqs.get(v) || []), r.name]);
  }
  for (const [v, names] of irqs) if (names.length > 1 && new Set(placed.filter((r) => names.includes(r.name)).map((r) => `${r.at.ctrl}.${r.at.unit}`)).size > 1) {
    notes.push(`${names.join(' and ')} share one interrupt vector (${v.replace('_IRQn', '_IRQHandler')}); its handler must call HAL_DMA_IRQHandler for each.`);
  }
  if (fam.kind === 'stream') notes.push('Memory-to-memory transfers run only on DMA2 on this family; DMA1 cannot reach the AHB peripherals or GPIO (its peripheral port is on APB1 only).');
  if (key === 'h743') notes.push('H7: DMA1/DMA2 cannot reach DTCM/ITCM; put buffers in AXI SRAM or SRAM1-3 and keep the D-cache coherent. D3 peripherals (LPUART1, SPI6, I2C4, SAI4, ADC3) use BDMA through DMAMUX2, not planned here.');
  if (key === 'u575') notes.push('U5 GPDMA1: channels 12-15 have 2D addressing and a larger FIFO; channels 0-11 are linear only.');
  if (fam.kind === 'channel' && !fam.sel) notes.push('On this family the request lines of a channel are ORed: enable DMA in only one of the peripherals wired to that channel at a time.');

  const order = [];
  for (const [c] of fam.ctrls) {
    const mine = placed.filter((r) => r.at.ctrl === c)
      .sort((a, b) => PRIOS.indexOf(b.prio) - PRIOS.indexOf(a.prio) || a.at.unit - b.at.unit);
    if (mine.length) order.push(`${c}: ${mine.map((r) => `${r.name} (${unitWord(fam)[0]}${r.at.unit}, ${r.prio})`).join(' > ')}`);
  }

  // ---- outputs ----
  const muxIndex = (c, u) => {
    if (fam.kind !== 'mux' || key === 'u575') return null;
    let n = 0;
    for (const [cc, us] of fam.ctrls) { for (const uu of us) { if (cc === c && uu === u) return n; n++; } }
    return null;
  };
  const rows = plan.map((r) => {
    const a = r.at;
    const where = a ? `${a.ctrl} ${unitWord(fam)} ${a.unit}` : '-';
    const sel = !a ? '-' : fam.kind === 'stream' ? (a.sel == null ? '-' : `CH${a.sel}`) : fam.sel === 'CSELR' ? `REQ ${a.sel}` : fam.kind === 'mux' ? (r.name === 'MEMTOMEM' ? '-' : key === 'u575' ? 'REQSEL' : `mux ch ${muxIndex(a.ctrl, a.unit)}`) : 'fixed';
    const status = r.clash ? 'CLASH' : a ? (r.pinned ? 'pinned' : 'auto') : r.cands.length ? 'not placed' : 'unknown';
    return [r.name, where, sel, PRIO_CUBE[r.prio], r.dir === 'R' ? 'P->M' : r.dir === 'M' ? 'M->M' : 'M->P', a ? irqName(key, fam, a.ctrl, a.unit) : '-', status];
  });
  const cube = placed.map((r) => {
    const dir = r.dir === 'R' ? 'Peripheral To Memory' : r.dir === 'M' ? 'Memory To Memory' : 'Memory To Peripheral';
    return `${r.name.padEnd(18)} ${instName(fam, r.at.ctrl, r.at.unit).padEnd(18)} ${dir.padEnd(22)} ${PRIO_CUBE[r.prio]}`;
  });
  const hal = placed.map((r) => halInit(key, fam, r)).join('\n');
  const irqText = [...irqs.keys()].map((v) => `void ${v.replace('_IRQn', '_IRQHandler')}(void)\n{\n${irqs.get(v).map((n) => `  HAL_DMA_IRQHandler(&${handleName(n)});`).join('\n')}\n}`).join('\n\n');

  const used = new Set(placed.map((r) => `${r.at.ctrl}.${r.at.unit}`));
  const values = [
    { label: 'Placed', value: `${placed.length} / ${plan.length}`,
      tone: unplaced.length || clashes || plan.some((r) => !r.cands.length) ? 'bad' : 'ok',
      hint: [unplaced.length ? `${unplaced.length} not placed` : '', plan.some((r) => !r.cands.length) ? `${plan.filter((r) => !r.cands.length).length} unknown` : ''].filter(Boolean).join(', ') || 'every request has a stream' },
    ...fam.ctrls.map(([c, us]) => ({ label: `${c} free`, value: `${us.filter((u) => !used.has(`${c}.${u}`)).length} / ${us.length}`, hint: `${unitWord(fam).toLowerCase()}s left` })),
    { label: 'Clashes', value: clashes, tone: clashes ? 'bad' : 'ok' },
  ];
  // Drawing data for the page only (agentOmit): the matrix and the plan as parsed.
  const cells = {};
  if (fam.kind !== 'mux') for (const s of all) (cells[`${s.ctrl}.${s.unit}`] ||= []).push([s.name, s.sel, s.dir]);
  const selCols = fam.kind === 'channel' && !fam.sel ? [] : fam.kind === 'mux' ? [] : [...new Set(all.map((s) => s.sel))].sort((a, b) => a - b);
  const grid = {
    family: key, kind: fam.kind, label: fam.label, unitWord: unitWord(fam), sel: fam.sel, selCols,
    ctrls: fam.ctrls.map(([c, us]) => ({ name: c, units: us.map((u) => ({ u, irq: irqName(key, fam, c, u), mux: muxIndex(c, u) })) })),
    cells, m2m: fam.m2m,
    catalog: fam.kind === 'mux' ? all.map((s) => s.name) : [...new Set(all.flatMap((s) => s.events))].sort(),
    plan: plan.map((r) => ({ name: r.name, prio: r.prio, pinned: r.pinned, clash: !!r.clash, line: r.line || r.name,
      at: r.at ? { ctrl: r.at.ctrl, unit: r.at.unit, sel: r.at.sel, line: r.at.line } : null, dir: r.dir || '',
      cands: (r.cands || []).map((c) => [c.ctrl, c.unit, c.sel, c.line]), known: r.cands.length > 0 })),
  };

  return {
    values,
    tables: [{ title: `Assignment - ${fam.label}`, columns: ['Request', fam.kind === 'stream' ? 'Stream' : 'Channel', fam.kind === 'stream' ? 'Channel' : 'Selector', 'Priority', 'Direction', 'IRQ', 'Status'], rows }],
    texts: [
      { title: 'CubeMX list', body: (cube.length ? cube.join('\n') : '(nothing placed)') + '\n' },
      { title: 'HAL init', body: (hal || '/* nothing placed */') + '\n', lang: 'c' },
      { title: 'IRQ handlers', body: (irqText || '/* nothing placed */') + '\n', lang: 'c' },
    ],
    warnings,
    notes: [...(order.length ? [`Arbitration (priority, then the lower number): ${order.join('; ')}.`] : []), ...notes, `Request table: ${fam.rm}; data from STM32CubeMX ${DATA[key].src}.`],
    grid,
  };
}

const handleName = (n) => `hdma_${n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_$/, '')}`;

function halInit(key, fam, r) {
  const h = handleName(r.name);
  const a = r.at;
  const inst = instName(fam, a.ctrl, a.unit);
  const dir = r.dir === 'R' ? 'DMA_PERIPH_TO_MEMORY' : r.dir === 'M' ? 'DMA_MEMORY_TO_MEMORY' : 'DMA_MEMORY_TO_PERIPH';
  const L = [`/* ${r.name} on ${inst} */`];
  if (key === 'u575') {
    L.push(`${h}.Instance = ${inst};`);
    if (r.name !== 'MEMTOMEM') L.push(`${h}.Init.Request = GPDMA1_REQUEST_${r.line};`);
    else L.push(`${h}.Init.Request = DMA_REQUEST_SW;`);
    L.push(`${h}.Init.BlkHWRequest = DMA_BREQ_SINGLE_BURST;`, `${h}.Init.Direction = ${dir};`,
      `${h}.Init.SrcInc = ${r.dir === 'R' ? 'DMA_SINC_FIXED' : 'DMA_SINC_INCREMENTED'};`, `${h}.Init.DestInc = ${r.dir === 'T' ? 'DMA_DINC_FIXED' : 'DMA_DINC_INCREMENTED'};`,
      `${h}.Init.Priority = ${PRIO_GP[r.prio]};`, `if (HAL_DMA_Init(&${h}) != HAL_OK) Error_Handler();`);
    return L.join('\n') + '\n';
  }
  L.push(`${h}.Instance = ${inst};`);
  if (fam.kind === 'stream') L.push(`${h}.Init.Channel = DMA_CHANNEL_${a.sel ?? 0};`);
  else if (fam.sel === 'CSELR' && r.name !== 'MEMTOMEM') L.push(`${h}.Init.Request = DMA_REQUEST_${a.sel};`);
  else if (fam.kind === 'mux') L.push(`${h}.Init.Request = ${r.name === 'MEMTOMEM' ? 'DMA_REQUEST_MEM2MEM' : `DMA_REQUEST_${r.line}`};`);
  L.push(`${h}.Init.Direction = ${dir};`,
    `${h}.Init.PeriphInc = ${r.dir === 'M' ? 'DMA_PINC_ENABLE' : 'DMA_PINC_DISABLE'};`,
    `${h}.Init.MemInc = DMA_MINC_ENABLE;`,
    `${h}.Init.PeriphDataAlignment = DMA_PDATAALIGN_BYTE;`,
    `${h}.Init.MemDataAlignment = DMA_MDATAALIGN_BYTE;`,
    `${h}.Init.Mode = DMA_NORMAL;`,
    `${h}.Init.Priority = ${PRIO_HAL[r.prio]};`);
  if (fam.kind === 'stream' || key === 'h743') L.push(`${h}.Init.FIFOMode = ${r.dir === 'M' ? 'DMA_FIFOMODE_ENABLE' : 'DMA_FIFOMODE_DISABLE'};`);
  L.push(`if (HAL_DMA_Init(&${h}) != HAL_OK) Error_Handler();`);
  return L.join('\n') + '\n';
}
