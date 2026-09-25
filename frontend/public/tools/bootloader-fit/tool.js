// Bootloader / application flash partitioning on real erase sectors.
//   region boundaries must fall on sector boundaries (a sector is the smallest erasable unit)
//   VTOR alignment = max(128, 4 × 2^ceil(log2(entries))) bytes     (Armv7-M ARM B3.2.5)
//   MCUboot swap-scratch: scratch ≥ largest sector in the slots     (MCUboot design doc)
import { fmtNum } from '../kit/eng.js';

/** '32K', '0x8000', '1M', '32 KiB', '12,288' -> bytes; null when it does not read. */
export function parseSize(t) {
  const s = String(t ?? '').trim().replace(/[_\s]/g, '').replace(/,(?=\d{3}\b)/g, '');
  if (!s) return null;
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  const m = /^(\d+(?:\.\d+)?)(k|kb|kib|m|mb|mib|b|bytes?)?$/i.exec(s);
  if (!m) return null;
  const u = (m[2] || '').toLowerCase();
  const mul = u.startsWith('k') ? 1024 : u.startsWith('m') ? 1048576 : 1;
  return Math.round(Number(m[1]) * mul);
}
const hex = (v) => '0x' + v.toString(16).toUpperCase().padStart(8, '0');
const kb = (b) => (b >= 1048576 && b % 1048576 === 0 ? `${b / 1048576} MiB` : b >= 1024 ? `${fmtNum(b / 1024, 5)} KiB` : `${b} B`);

function parseSectors(text, bad) {
  const out = [];
  for (const part of String(text || '').split(/[,;\s]+(?![*x×])/).map((p) => p.trim()).filter(Boolean)) {
    const m = /^(.+?)\s*[*x×]\s*(\d+)$/.exec(part);
    const size = parseSize(m ? m[1] : part), n = m ? Number(m[2]) : 1;
    if (!(size > 0) || !(n > 0) || n > 100000) { bad.push(part); continue; }
    for (let i = 0; i < n; i++) out.push(size);
  }
  return out;
}

export function run(inp) {
  const warnings = [];
  const base = parseSize(inp.base) ?? 0;
  if (inp.base && parseSize(inp.base) == null) warnings.push(`Flash start "${inp.base}" is not an address: using 0.`);
  const flash = parseSize(inp.size);
  if (!(flash > 0)) return { warnings: ['Give the flash size in bytes, e.g. 512K, 1M or 0x80000.'] };
  let sectors;
  if (inp.layout === 'list') {
    const bad = [];
    sectors = parseSectors(inp.sectors, bad);
    if (bad.length) warnings.push(`Could not read sector entries: ${bad.join(', ')}. Write them like 16K*4, 64K, 128K*7.`);
    if (!sectors.length) return { warnings: [...warnings, 'Give the sector list, e.g. 16K*4, 64K, 128K*7.'] };
    const tot = sectors.reduce((a, b) => a + b, 0);
    if (tot !== flash) {
      warnings.push(`The sectors add up to ${kb(tot)}, not the ${kb(flash)} flash size: using the ${tot < flash ? 'sectors' : 'first ' + kb(flash)}.`);
      if (tot > flash) { let acc = 0; sectors = sectors.filter((s) => (acc += s) <= flash); }
    }
  } else {
    const page = parseSize(inp.page);
    if (!(page > 0)) return { warnings: ['Give the page size in bytes, e.g. 2K or 4096.'] };
    if (flash % page) warnings.push(`${kb(flash)} is not a whole number of ${kb(page)} pages: the last partial page is ignored.`);
    if (flash / page > 1e5) return { warnings: ['Over 100 000 pages: check the page size.'] };
    sectors = Array.from({ length: Math.floor(flash / page) }, () => page);
  }
  // boundaries[i] = offset where sector i starts; boundaries[n] = end
  const bnd = [0];
  for (const s of sectors) bnd.push(bnd.at(-1) + s);
  const end = bnd.at(-1);
  const up = (off) => bnd.find((b) => b >= off) ?? null;
  const down = (off) => [...bnd].reverse().find((b) => b <= off) ?? 0;
  const count = (a, b) => bnd.filter((x) => x >= a && x < b).length;
  const maxSector = (a, b) => Math.max(0, ...sectors.filter((_, i) => bnd[i] >= a && bnd[i] < b));

  const margin = Math.max(0, inp.margin ?? 0) / 100;
  const boot = parseSize(inp.boot);
  const app = parseSize(inp.app);
  const hdr = parseSize(inp.hdr) ?? 0;
  const nvmWant = parseSize(inp.nvm) ?? 0;
  if (!(boot >= 0) || boot == null) return { warnings: [...warnings, 'Give the bootloader image size in bytes (e.g. 18432 or 18K).'] };
  if (!(app >= 0) || app == null) return { warnings: [...warnings, 'Give the application image size in bytes (e.g. 190000 or 186K).'] };
  if (inp.hdr && parseSize(inp.hdr) == null) warnings.push(`Header size "${inp.hdr}" does not read: using 0.`);

  // bootloader reserve
  let bootEnd;
  const res = parseSize(inp.bootres);
  if (inp.bootres && res == null) warnings.push(`Bootloader reserve "${inp.bootres}" does not read: sizing it from the image.`);
  if (res > 0) {
    bootEnd = up(res);
    if (bootEnd == null) return { warnings: [...warnings, 'The bootloader reserve is larger than the flash.'] };
    if (bootEnd !== res) warnings.push(`A ${kb(res)} bootloader reserve does not end on a sector boundary: rounded up to ${kb(bootEnd)}.`);
  } else {
    bootEnd = up(Math.ceil(boot * (1 + margin)));
    if (bootEnd == null) return { warnings: [...warnings, 'The bootloader alone is larger than the flash.'] };
  }
  // reserved data area at the end
  const nvmStart = nvmWant > 0 ? down(end - nvmWant) : end;
  const slotsN = inp.slots === '1' ? 1 : 2;
  const scratch = inp.slots === '2s';
  let areaEnd = nvmStart;
  let scr = null;
  if (scratch) {
    const need = maxSector(bootEnd, nvmStart);
    // scratch = the smallest run of whole sectors at the end of the app area that is >= the largest slot sector
    let s = areaEnd;
    while (s > bootEnd && areaEnd - s < need) s = down(s - 1);
    scr = { start: s, end: areaEnd };
    areaEnd = s;
  }
  const regions = [];
  regions.push({ name: 'Bootloader', start: 0, end: bootEnd, used: boot });
  let slotSize = 0;
  if (areaEnd <= bootEnd) {
    warnings.push('No flash is left for the application after the bootloader, scratch and reserved data.');
  } else if (slotsN === 1) {
    slotSize = areaEnd - bootEnd;
    regions.push({ name: 'Application', start: bootEnd, end: areaEnd, used: app + hdr });
  } else {
    // the boundary that makes the two slots as large as possible (slot 2 = same size, whole sectors)
    let best = null;
    for (const b of bnd) {
      if (b <= bootEnd || b >= areaEnd) continue;
      const s1 = b - bootEnd;
      const e2 = down(Math.min(areaEnd, b + s1));
      const sz = Math.min(s1, e2 - b);
      if (!best || sz > best.sz) best = { b, sz, e2 };
    }
    if (!best) warnings.push('The application area is a single sector: it cannot be split into two slots.');
    else {
      slotSize = best.sz;
      regions.push({ name: 'Slot A (primary, runs)', start: bootEnd, end: bootEnd + best.sz, used: app + hdr });
      if (bootEnd + best.sz < best.b) regions.push({ name: '(slot A tail, unused)', start: bootEnd + best.sz, end: best.b, used: 0 });
      regions.push({ name: 'Slot B (secondary, download)', start: best.b, end: best.b + best.sz, used: app + hdr });
      if (best.b + best.sz < areaEnd) regions.push({ name: '(unused)', start: best.b + best.sz, end: areaEnd, used: 0 });
    }
  }
  if (scr) regions.push({ name: 'Scratch', start: scr.start, end: scr.end, used: 0 });
  if (nvmStart < end) regions.push({ name: 'Reserved data', start: nvmStart, end, used: 0 });

  const bootRes = bootEnd;
  const bootFree = bootRes - boot;
  const appNeed = app + hdr;
  const appFree = slotSize - appNeed;
  const bootOk = boot <= bootRes, appOk = slotSize > 0 && appNeed <= slotSize;
  const bootMarginOk = boot * (1 + margin) <= bootRes, appMarginOk = appNeed * (1 + margin) <= slotSize;
  // VTOR alignment of the application's vector table (it sits after the header)
  const entries = Math.max(1, Math.round(inp.vectors || 0));
  const align = Math.max(128, 4 * 2 ** Math.ceil(Math.log2(entries)));
  const vt = bootEnd + hdr;
  const vtOk = vt % align === 0;

  const tone = (ok, mok) => (!ok ? 'bad' : mok ? 'ok' : 'warn');
  const values = [
    { label: 'Fits', value: bootOk && appOk ? (bootMarginOk && appMarginOk ? 'yes' : 'yes, under margin') : 'no', tone: tone(bootOk && appOk, bootMarginOk && appMarginOk) },
    { label: 'Bootloader reserve', value: kb(bootRes), hint: `${count(0, bootEnd)} sector(s), ${fmtNum(boot / bootRes * 100, 3)} % used`, tone: tone(bootOk, bootMarginOk) },
    { label: slotsN === 2 ? 'Slot size (each)' : 'Application region', value: kb(slotSize), hint: slotSize ? `${fmtNum(appNeed / slotSize * 100, 3)} % used` : null, tone: tone(appOk, appMarginOk) },
    { label: 'Application headroom', value: appFree >= 0 ? kb(appFree) : `−${kb(-appFree)}`, tone: appFree >= 0 ? 'ok' : 'bad' },
    { label: 'Application start', value: hex(base + bootEnd), hint: hdr ? `vector table at ${hex(base + vt)}` : null },
    { label: 'VTOR alignment', value: `${align} B`, tone: vtOk ? 'ok' : 'bad', hint: vtOk ? 'vector table aligned' : 'vector table NOT aligned' },
  ];
  if (!bootOk) warnings.push(`The bootloader (${kb(boot)}) does not fit its ${kb(bootRes)} reserve: enlarge the reserve by one sector (${kb(sectors[count(0, bootEnd)] || 0)}) or shrink the bootloader (-Os, no printf).`);
  else if (!bootMarginOk) warnings.push(`The bootloader fits but has less than ${fmtNum(margin * 100, 3)} % headroom: a bootloader is hard to update in the field, reserve one more sector now.`);
  if (slotSize && !appOk) warnings.push(`The application (${kb(appNeed)} with header) is ${kb(appNeed - slotSize)} over its ${kb(slotSize)} slot: ${slotsN === 2 ? 'use an external flash for slot B, compress the update, or ' : ''}shrink the image or the bootloader reserve.`);
  else if (slotSize && !appMarginOk) warnings.push(`The application fits with only ${kb(appFree)} left, under the ${fmtNum(margin * 100, 3)} % margin: the next features will not fit.`);
  if (!vtOk) warnings.push(`The application's vector table at ${hex(base + vt)} is not ${align}-byte aligned: VTOR ignores the low bits and the core would jump to garbage. Make the header a multiple of ${align} bytes or move the start.`);
  if (bootEnd % 4096 && inp.layout !== 'list' && sectors[0] < 1024) warnings.push('Pages are small: check the memory protection (write-protect) granularity, which is often coarser than the erase page.');
  if (scratch && scr && scr.end - scr.start < maxSector(bootEnd, nvmStart)) warnings.push('There is no room for a scratch sector as large as the largest slot sector.');
  if (slotsN === 2 && inp.layout === 'list') {
    const s1 = regions.find((r) => r.name.startsWith('Slot A')), s2 = regions.find((r) => r.name.startsWith('Slot B'));
    if (s1 && s2 && count(s1.start, s1.end) !== count(s2.start, s2.end)) warnings.push('Slot A and B have different sector layouts: MCUboot swap needs compatible sectors (swap-scratch copes, swap-move needs equal sectors). Check your bootloader\'s rules.');
  }
  const rows = regions.map((r) => [r.name, hex(base + r.start), hex(base + r.end - 1), kb(r.end - r.start), String(count(r.start, r.end)),
    r.used ? kb(r.used) : '–', r.used ? (r.used <= r.end - r.start ? kb(r.end - r.start - r.used) : `over by ${kb(r.used - (r.end - r.start))}`) : '–']);
  const ld = [
    '/* bootloader */',
    `MEMORY { FLASH (rx) : ORIGIN = ${hex(base)}, LENGTH = ${bootRes} }  /* ${kb(bootRes)} */`,
    '',
    '/* application (runs from slot A' + (hdr ? ', after the image header' : '') + ') */',
    `MEMORY { FLASH (rx) : ORIGIN = ${hex(base + vt)}, LENGTH = ${Math.max(0, slotSize - hdr)} }  /* ${kb(Math.max(0, slotSize - hdr))}${hdr ? ', trailer not subtracted' : ''} */`,
    '',
    `/* in the application's SystemInit: SCB->VTOR = ${hex(base + vt)}; */`,
  ].join('\n');
  // For the page's drawing (the map itself): the same numbers, as data.
  const kind = (n) => (n === 'Bootloader' ? 'boot' : n.startsWith('Slot A') ? 'slota' : n.startsWith('Slot B') ? 'slotb'
    : n === 'Scratch' ? 'scratch' : n === 'Reserved data' ? 'nvm' : n === 'Application' ? 'slota' : 'unused');
  const drawing = {
    base, end, sectors, boundaries: bnd, page: inp.layout === 'list' ? null : sectors[0],
    regions: regions.map((r) => ({ name: r.name, kind: kind(r.name), start: r.start, end: r.end, used: r.used, sectors: count(r.start, r.end) })),
    boot, app, hdr, appNeed, margin, bootEnd, bootAuto: !(res > 0), slotSize, slots: inp.slots === '2s' ? '2s' : String(slotsN),
    nvmStart, scratch: scr, vt, align, vtOk, entries,
    bootOk, appOk, bootMarginOk, appMarginOk,
  };
  return {
    values, warnings, drawing,
    tables: [{ title: 'Flash layout', columns: ['Region', 'Start', 'End', 'Size', 'Sectors', 'Image', 'Free'], rows }],
    texts: [{ title: 'Linker', body: ld, lang: 'ld' }],
    notes: ['Sizes: K = 1024 bytes. Image size = text + data (what is programmed), not bss.',
      'Each region starts and ends on an erase boundary so the bootloader can erase one without touching another.',
      slotsN === 2 ? 'With internal A/B slots each slot is at most half of what is left; an external SPI flash for slot B doubles the room for the application.' : 'One slot means an update overwrites the running image: a power cut mid-update needs the bootloader to recover (keep it able to receive a new image).'],
  };
}
