// Flash & EEPROM Wear Lifetime: how long a storage area lasts at a write rate.
//
// Every scheme reduces to "record writes until the most-erased sector reaches
// its endurance":
//   none      in place: every write erases the sector holding the record
//             W = E / WA
//   circular  append records across N sectors, erase a sector when the log
//             wraps onto it:  W = E x N x floor(S / r) / WA
//   eeprom    EEPROM emulation (ST AN3969 / AN4894): elements are appended to
//             the active page; a full page has its V live variables copied to
//             the next page and is erased, so each fill brings (C - V) new
//             writes, C = floor(S / r) - 1 (one element's room for the page
//             header). The N pages rotate:  W = E x N x (C - V) / WA
//   littlefs  dynamic wear levelling over the free blocks only (littlefs
//             DESIGN.md "wear leveling"): W = E x N x (1 - fill) x S / (r x WA)
//   ftl       an eMMC / SD / SSD controller levelling statically over the
//             whole area: W = E x N x S / (r x WA)
// Lifetime = W x write interval.  E = erase cycles, S = erase unit, N = sectors
// in the area, r = bytes per record write, WA = write amplification.
import { fmtNum } from '../kit/eng.js';

export const TECH = {
  mcu: { label: 'MCU internal flash', cycles: 10000, erase: 2048, note: 'STM32 flash: typically 10 kcycles per page/sector; retention shrinks with cycling (STM32F407 datasheet: 30 years at 85 °C after 1 kcycle, 20 years at 55 °C after 10 kcycles).' },
  mcueeprom: { label: 'MCU data EEPROM (L0/L1)', cycles: 100000, erase: 4, note: 'STM32L0/L1 data EEPROM: 100 kcycles per word (datasheet), written a word at a time without a page erase.' },
  eeprom: { label: 'External EEPROM (I2C/SPI)', cycles: 1000000, erase: 32, note: 'Serial EEPROM (e.g. 24LC256, M24C64): 1 Mcycles per page at 25 °C, fewer when hot; retention ~200 years.' },
  nor: { label: 'SPI NOR flash', cycles: 100000, erase: 4096, note: 'SPI NOR (e.g. W25Q128JV): 100 kcycles per 4 KiB sector, 20 years retention.' },
  slc: { label: 'NAND SLC', cycles: 60000, erase: 131072, note: 'SLC NAND: 50-100 kcycles per block with ECC; bad blocks exist from new.' },
  mlc: { label: 'NAND MLC', cycles: 3000, erase: 1048576, note: 'MLC NAND: ~3 kcycles per block; retention drops fast near end of life.' },
  emmc: { label: 'eMMC (MLC/TLC, device FTL)', cycles: 3000, erase: 524288, note: 'eMMC MLC/TLC: ~3 kcycles (TLC often 1 kcycle); pSLC mode ~20-30 kcycles at a third of the capacity. Read the vendor health report (EXT_CSD life time estimation).' },
};
export const SCHEMES = {
  none: 'In place (no levelling)',
  circular: 'Circular log',
  eeprom: 'EEPROM emulation (AN3969/AN4894)',
  littlefs: 'littlefs (dynamic, free blocks)',
  ftl: 'Device FTL (static, whole area)',
};
const YEAR = 365.25 * 86400;
const num = (v, d) => (Number.isFinite(v) && v != null ? v : d);

function fmtDur(s) {
  if (!Number.isFinite(s)) return 'forever';
  if (s >= YEAR) return `${fmtNum(s / YEAR, 3)} years`;
  if (s >= 86400) return `${fmtNum(s / 86400, 3)} days`;
  if (s >= 3600) return `${fmtNum(s / 3600, 3)} hours`;
  return `${fmtNum(s, 3)} s`;
}
const kib = (b) => (b >= 1048576 ? `${fmtNum(b / 1048576, 4)} MiB` : b >= 1024 ? `${fmtNum(b / 1024, 4)} KiB` : `${b} B`);

/** The core: writes to wear-out and how the area is used. */
function model(p) {
  const { E, S, N, r, WA, V, fill, scheme } = p;
  let W, active, why;
  const perSector = Math.floor(S / r);
  switch (scheme) {
    case 'none':
      W = E / WA; active = Math.min(N, Math.max(1, Math.ceil(r / S)));
      why = `W = E / WA = ${fmtNum(E)} / ${fmtNum(WA)}`;
      break;
    case 'circular':
      W = (E * N * perSector) / WA; active = N;
      why = `W = E x N x floor(S/r) / WA = ${fmtNum(E)} x ${N} x ${perSector} / ${fmtNum(WA)}`;
      break;
    case 'eeprom': {
      const C = perSector - 1;
      const fresh = Math.max(0, C - V);
      W = (E * N * fresh) / WA; active = N;
      why = `W = E x N x (C - V) / WA, C = floor(S/r) - 1 = ${C}: ${fmtNum(E)} x ${N} x (${C} - ${V}) / ${fmtNum(WA)}`;
      break;
    }
    case 'littlefs': {
      const free = Math.max(1, Math.round(N * (1 - fill)));
      W = (E * free * S) / (r * WA); active = free;
      why = `W = E x N_free x S / (r x WA) = ${fmtNum(E)} x ${free} x ${S} / (${r} x ${fmtNum(WA)})`;
      break;
    }
    default:
      W = (E * N * S) / (r * WA); active = N;
      why = `W = E x N x S / (r x WA) = ${fmtNum(E)} x ${N} x ${S} / (${r} x ${fmtNum(WA)})`;
  }
  return { W: Math.max(0, W), active, why };
}

export function run(input) {
  const warnings = [], notes = [];
  const techKey = TECH[input.tech] ? input.tech : 'mcu';
  const tech = TECH[techKey];
  const scheme = SCHEMES[input.scheme] ? input.scheme : 'eeprom';
  const E = Math.max(1, Math.round(num(input.endurance, tech.cycles)));
  const S = Math.max(1, Math.round(num(input.eraseSize, tech.erase)));
  const area = Math.max(1, Math.round(num(input.areaSize, S * 4)));
  const r = Math.max(1, Math.round(num(input.recordSize, 8)));
  const interval = num(input.interval, 60);
  const WA = Math.max(1, num(input.wa, 1));
  const V = Math.max(0, Math.round(num(input.variables, 0)));
  const fill = Math.min(0.99, Math.max(0, num(input.fill, 0) / 100));
  const target = Math.max(0, num(input.target, 10));

  if (!(interval > 0)) {
    return { warnings: ['Give a write interval above zero (seconds between record writes).'], values: [{ label: 'Lifetime', value: '-' }] };
  }
  if (num(input.wa, 1) < 1) warnings.push('Write amplification below 1 is not physical; 1 is used.');
  const N = Math.floor(area / S);
  if (N < 1) {
    return { warnings: [`The area (${kib(area)}) is smaller than one erase unit (${kib(S)}). Make it at least one sector.`], values: [{ label: 'Lifetime', value: '-' }] };
  }
  if (area % S) warnings.push(`The area is not a whole number of ${kib(S)} sectors; the last ${kib(area % S)} is not used.`);
  if (r > S && scheme !== 'none') warnings.push(`A ${kib(r)} record is larger than the ${kib(S)} erase unit; the model assumes records fit in a sector.`);
  if (scheme === 'eeprom') {
    if (N < 2) warnings.push('EEPROM emulation needs at least two pages: one to fill while the other is being erased (AN3969 §2).');
    const C = Math.floor(S / r) - 1;
    if (V >= C) warnings.push(`${V} variables do not fit in a page of ${C} elements: every page transfer would fill the new page. Use bigger pages or fewer variables.`);
    else if (V > C * 0.5) warnings.push(`${V} live variables take ${fmtNum(V / C * 100, 3)} % of each page; most of every erase goes to copying them. Bigger pages help more than more pages.`);
  }
  if (scheme === 'none' && N > 1) warnings.push(`In place, one sector takes all the wear and the other ${N - 1} do nothing. A circular log over the same area lasts ${fmtNum(N * Math.floor(S / r), 4)} times longer.`);
  if (scheme === 'littlefs' && fill > 0.8) warnings.push(`littlefs levels only over free blocks: with the area ${fmtNum(fill * 100, 3)} % full, the wear lands on ${Math.max(1, Math.round(N * (1 - fill)))} blocks.`);
  if (scheme === 'ftl' && !['emmc', 'slc', 'mlc'].includes(techKey)) notes.push('A static FTL is what an eMMC, SD card or SSD controller does; on raw flash you would need a flash translation layer of your own (UBI, a filesystem).');
  if (scheme === 'littlefs' && WA === 1) notes.push('littlefs rewrites metadata and copies-on-write partial blocks: a write amplification of 2-4 is more honest for small records than 1.');

  const m = model({ E, S, N, r, WA, V, fill, scheme });
  const life = m.W * interval;
  const perDay = 86400 / interval;
  const erasesPerDay = m.W > 0 ? (E * perDay) / m.W : 0; // on each active sector
  const bytesPerDay = perDay * r;
  if (m.W === 0) warnings.push('No writes fit before wear-out with these settings.');
  const short = target > 0 && life < target * YEAR;
  if (short) {
    const need = (target * YEAR) / Math.max(life, 1e-9);
    warnings.push(`Wears out in ${fmtDur(life)}, short of the ${fmtNum(target)} year target by ${fmtNum(need, 3)}x. Write ${fmtNum(need, 3)}x less often, ${scheme === 'none' ? 'spread the writes (circular log or EEPROM emulation)' : `use a ${fmtNum(need, 3)}x larger area`}, or move to ${techKey === 'mcu' ? 'an external EEPROM or FRAM' : 'a part with more endurance'}.`);
  }

  // Sensitivity: the same model with one thing changed.
  const alt = (label, ch) => {
    const p = { E, S, N, r, WA, V, fill, scheme, interval, ...ch };
    const w = model(p).W * p.interval;
    return [label, fmtDur(w), `${fmtNum(w / Math.max(life, 1e-12), 3)}x`];
  };
  const sens = [
    alt('Write interval x2', { interval: interval * 2 }),
    alt('Write interval / 2', { interval: interval / 2 }),
    alt('Area x2', { N: N * 2 }),
    alt('Record size / 2', { r: Math.max(1, Math.floor(r / 2)) }),
    alt('Write amplification x2', { WA: WA * 2 }),
    alt(`Endurance at ${fmtNum(E / 10)} (hot / worn part)`, { E: E / 10 }),
  ];
  if (scheme === 'eeprom') sens.push(alt(`${Math.max(0, V * 2)} variables`, { V: V * 2 }));
  if (scheme !== 'circular') sens.push(alt('Same area as a circular log', { scheme: 'circular' }));

  // Drawing data (agentOmit): the sectors, which of them wear, and how fast.
  const MAXCELLS = 256;
  const group = Math.max(1, Math.ceil(N / MAXCELLS));
  const cells = [];
  for (let i = 0; i < N; i += group) {
    let kind = 'rot';
    if (scheme === 'none') kind = i < m.active ? 'hot' : 'idle';
    else if (scheme === 'littlefs') kind = i >= m.active ? 'static' : 'rot';
    cells.push(kind);
  }

  const lifeY = life / YEAR;
  const formula = [
    `${SCHEMES[scheme]}:`,
    `  ${m.why}`,
    `  W = ${fmtNum(m.W, 6)} record writes before the busiest sector reaches ${fmtNum(E)} erase cycles`,
    `Lifetime = W x interval = ${fmtNum(m.W, 6)} x ${fmtNum(interval)} s = ${fmtNum(life, 6)} s = ${fmtDur(life)}`,
    `Each active sector: ${fmtNum(erasesPerDay, 4)} erases per day; ${fmtNum(bytesPerDay, 4)} B of records per day.`,
  ].join('\n');

  return {
    values: [
      { label: 'Lifetime', value: fmtDur(life), tone: short ? 'bad' : 'ok', hint: target > 0 ? `target ${fmtNum(target)} years` : '' },
      { label: 'Writes to wear-out', value: fmtNum(m.W, 4) },
      { label: 'Sectors wearing', value: `${m.active} of ${N}`, hint: `${kib(S)} each` },
      { label: 'Erases / day / sector', value: fmtNum(erasesPerDay, 4) },
      { label: 'Records / day', value: fmtNum(perDay, 4), hint: `${fmtNum(bytesPerDay / 1024, 4)} KiB/day` },
      { label: 'Endurance', value: `${fmtNum(E)} cycles`, hint: tech.label },
    ],
    tables: [{ title: 'Sensitivity', columns: ['Change', 'Lifetime', 'vs now'], rows: sens }],
    texts: [{ title: 'Formula', body: formula + '\n' }],
    warnings,
    notes: [...notes, tech.note, 'Retention falls as cycles accumulate: a sector near its endurance keeps data for less time than a fresh one. Leave margin.'],
    map: { N, group, cells, E, lifeSec: life, targetSec: target * YEAR, S, area, scheme, lifeY },
  };
}
