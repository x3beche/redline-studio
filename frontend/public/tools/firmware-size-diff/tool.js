// Symbol-by-symbol size change between two firmware builds.
// Reads, line by line, whichever of these it finds (formats per GNU binutils
// documentation and Bloaty McBloatface's CSV output):
//   nm -S / nm --print-size --size-sort   "08000200 00000024 T main"   (hex)
//   GNU ld map file (-Wl,-Map)            " .text.main  0x08000200  0x24 main.o"
//                                         (also the two-line form when the name is long)
//   size -A (SysV)                        ".text   12345   134217728"   (decimal)
//   size (Berkeley)                       "text data bss dec hex filename" + a row
//   bloaty --csv                          "symbols,vmsize,filesize" header
//   plain "name size" / "size name"       decimal
// Region, from the nm type letter or the section name:
//   text  T t W w V v (code)    rodata R r (constants)     -> flash
//   data  D d G g (initialised: flash image + RAM copy)    -> flash and RAM
//   bss   B b S s C (zeroed)                               -> RAM only

function regionOf(letterOrSection) {
  const x = String(letterOrSection);
  if (x.length === 1) {
    if (/[TtWwVv]/.test(x)) return 'text';
    if (/[Rr]/.test(x)) return 'rodata';
    if (/[DdGg]/.test(x)) return 'data';
    if (/[BbSsC]/.test(x)) return 'bss';
    return 'other';
  }
  if (/^\.?(text|init|fini|isr_vector|vectors|ARM\.ex|iram|flash\.text)/i.test(x)) return 'text';
  if (/^\.?(rodata|flash\.rodata|ARM\.extab)/i.test(x)) return 'rodata';
  if (/^\.?(data|sdata|dram0\.data|tdata)/i.test(x)) return 'data';
  if (/^\.?(bss|sbss|COMMON|tbss|noinit|dram0\.bss|heap|stack)/i.test(x)) return 'bss';
  return 'other';
}

const MAP_SECTION = /^\s*(\.(?:text|rodata|data|bss|sdata|sbss|tbss|tdata|iram1|dram0\.data|dram0\.bss|flash\.text|flash\.rodata)(?:\.\S*)?|COMMON)\s*$/;
const MAP_LINE = /^\s*(\.(?:text|rodata|data|bss|sdata|sbss|tbss|tdata|iram1|dram0\.data|dram0\.bss|flash\.text|flash\.rodata)(?:\.\S*)?|COMMON)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(\S.*)$/;
const MAP_CONT = /^\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(\S.*)$/;

export function parseSizes(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const syms = new Map(); // key -> {name, region, size, count}
  const bad = [];
  let format = null, bloatyCols = null, berkeley = null, pendingSection = null, noSize = 0, skipBlock = false;
  const add = (name, region, size, fmt) => {
    format = format || fmt;
    const key = `${name}\u0000${region}`;
    const s = syms.get(key) || { name, region, size: 0, count: 0 };
    s.size += size; s.count += 1;
    syms.set(key, s);
  };
  const mapName = (sec, obj) => {
    const m = /^\.(?:text|rodata|data|bss|sdata|sbss|tbss|tdata|iram1|dram0\.data|dram0\.bss|flash\.text|flash\.rodata)\.(.+)$/.exec(sec);
    if (m) return m[1].replace(/^(startup|unlikely|hot|exit)\./, '');
    // a whole-object section (built without -ffunction-sections): name it by its object file
    const o = String(obj || '').trim().split(/[\\/]/).pop();
    return o ? `${sec} (${o})` : sec;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    let m;
    // map-file preamble blocks carry no final sizes (and "Discarded input
    // sections" lists what the linker threw away): skip them
    if (/^(Archive member included|Allocating common symbols|Discarded input sections|Memory Configuration)/.test(line)) { skipBlock = true; format = format || 'map'; continue; }
    if (/^Linker script and memory map/.test(line)) { skipBlock = false; continue; }
    if (skipBlock) continue;
    if (bloatyCols) {
      const cells = line.split(',');
      if (cells.length >= 2) {
        const size = Number(cells[bloatyCols.size]);
        if (Number.isFinite(size)) { add(cells[0].replace(/^"|"$/g, ''), bloatyCols.region ? regionOf(cells[bloatyCols.region]) : 'other', size, 'bloaty'); continue; }
      }
      bad.push(line); continue;
    }
    if (/^(sections|symbols|compileunits|inputfiles),/.test(line)) {
      const h = line.split(',');
      bloatyCols = { size: Math.max(h.indexOf('vmsize'), 1) };
      continue;
    }
    if (/^\s*text\s+data\s+bss\s+dec\s+hex/.test(line)) { berkeley = true; continue; }
    if (berkeley && (m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+\d+\s+[0-9a-f]+/i.exec(line))) {
      add('text (code + rodata)', 'text', Number(m[1]), 'size'); add('data', 'data', Number(m[2]), 'size'); add('bss', 'bss', Number(m[3]), 'size');
      continue;
    }
    // nm -S: address size type name
    if ((m = /^([0-9a-fA-F]{4,16})\s+([0-9a-fA-F]{1,16})\s+([A-Za-z])\s+(\S.*)$/.exec(line))) {
      add(m[4].trim(), regionOf(m[3]), parseInt(m[2], 16), 'nm');
      continue;
    }
    // nm without -S: address type name  (no size)
    if (/^([0-9a-fA-F]{8,16})\s+[A-Za-z]\s+\S+$/.test(line) || /^\s+[Uw]\s+\S+$/.test(line)) { noSize++; continue; }
    // ld map
    if ((m = MAP_LINE.exec(line))) {
      pendingSection = null;
      const size = parseInt(m[3], 16);
      if (size > 0) add(mapName(m[1], m[4]), regionOf(m[1]), size, 'map');
      continue;
    }
    if ((m = MAP_SECTION.exec(line))) { pendingSection = m[1]; continue; }
    if (pendingSection && (m = MAP_CONT.exec(line))) {
      const size = parseInt(m[2], 16);
      if (size > 0) add(mapName(pendingSection, m[3]), regionOf(pendingSection), size, 'map');
      pendingSection = null;
      continue;
    }
    pendingSection = null;
    // size -A: .section size addr
    if ((m = /^(\.\S+)\s+(\d+)\s+(\d+)$/.exec(line))) {
      // debug and note sections are not loaded into the target
      if (!/^\.(debug|comment|ARM\.attributes|stab|note|riscv\.attributes|xtensa\.info|xt\.)/.test(m[1])) add(m[1], regionOf(m[1]), Number(m[2]), 'size -A');
      else format = format || 'size -A';
      continue;
    }
    if (/^section\s+size\s+addr/i.test(line) || /^Total\s+\d+\s*$/i.test(line) || /^\S+\s+:\s*$/.test(line)) continue; // size -A header, total, file name
    // plain: name size | size name (decimal), CSV or whitespace
    if ((m = /^\s*"?([^\s,;"]+)"?\s*[,;\t ]\s*(\d+)\s*$/.exec(line))) { add(m[1], 'other', Number(m[2]), 'plain'); continue; }
    if ((m = /^\s*(\d+)\s*[,;\t ]\s*"?([^\s,;"]+)"?\s*$/.exec(line))) { add(m[2], 'other', Number(m[1]), 'plain'); continue; }
    // map-file lines that carry no size information are normal: skip quietly
    if (format === 'map' || /^\s*(0x[0-9a-f]+|\*fill\*|\*\(|LOAD|OUTPUT|Memory Configuration|Linker script|Archive member|Discarded|Name\s+Origin|\/DISCARD\/|[A-Z_]+\s+0x)/i.test(line)) continue;
    bad.push(line);
  }
  return { syms, bad, format, noSize };
}

const fmtB = (n) => (n > 0 ? `+${n}` : String(n));
const kb = (n) => `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)} KiB`;

export function run({ before, after, top, minDelta }) {
  const A = parseSizes(before), B = parseSizes(after);
  const warnings = [];
  for (const [label, P] of [['Old build', A], ['New build', B]]) {
    if (!P.syms.size) warnings.push(`${label}: no sizes found. Paste the output of "arm-none-eabi-nm -S --size-sort firmware.elf", a linker .map file, "size -A firmware.elf" or "name size" lines.`);
    if (P.noSize) warnings.push(`${label}: ${P.noSize} nm lines have no size column: run nm with -S (--print-size).`);
    if (P.bad.length) warnings.push(`${label}: ${P.bad.length} line${P.bad.length > 1 ? 's' : ''} not understood and skipped, e.g. "${P.bad[0].slice(0, 70)}".`);
  }
  if (A.format && B.format && A.format !== B.format) warnings.push(`The builds are in different formats (${A.format} and ${B.format}): symbols will not line up. Produce both the same way.`);
  if (!A.syms.size || !B.syms.size) return { warnings };

  const keys = new Set([...A.syms.keys(), ...B.syms.keys()]);
  const all = [...keys].map((k) => {
    const a = A.syms.get(k), b = B.syms.get(k);
    const s = a || b;
    const o = a ? a.size : 0, n = b ? b.size : 0;
    return { name: s.name, region: s.region, old: o, neu: n, d: n - o, status: !a ? 'added' : !b ? 'removed' : n > o ? 'grew' : n < o ? 'shrank' : 'same', dup: Math.max(a?.count || 0, b?.count || 0) };
  });
  const sum = (f) => all.reduce((s, x) => s + f(x), 0);
  const inFlash = (r) => r === 'text' || r === 'rodata' || r === 'data';
  const inRam = (r) => r === 'data' || r === 'bss';
  const tot = { old: sum((x) => x.old), neu: sum((x) => x.neu) };
  const flash = { old: sum((x) => (inFlash(x.region) ? x.old : 0)), neu: sum((x) => (inFlash(x.region) ? x.neu : 0)) };
  const ram = { old: sum((x) => (inRam(x.region) ? x.old : 0)), neu: sum((x) => (inRam(x.region) ? x.neu : 0)) };
  const known = all.some((x) => x.region !== 'other');
  const tone = (d) => (d > 0 ? 'warn' : d < 0 ? 'ok' : undefined);
  const pct = (o, n) => (o ? ` (${fmtB(Math.round(((n - o) / o) * 1000) / 10)} %)` : '');

  const values = [
    { label: 'Total change', value: fmtB(tot.neu - tot.old), unit: 'bytes', tone: tone(tot.neu - tot.old), hint: `${tot.old} → ${tot.neu}${pct(tot.old, tot.neu)}` },
  ];
  if (known) {
    values.push(
      { label: 'Flash (text + rodata + data)', value: fmtB(flash.neu - flash.old), unit: 'bytes', tone: tone(flash.neu - flash.old), hint: `${kb(flash.old)} → ${kb(flash.neu)}` },
      { label: 'RAM (data + bss)', value: fmtB(ram.neu - ram.old), unit: 'bytes', tone: tone(ram.neu - ram.old), hint: `${kb(ram.old)} → ${kb(ram.neu)}` },
    );
  }
  const cnt = (st) => all.filter((x) => x.status === st).length;
  values.push({ label: 'Symbols', value: `${B.syms.size}`, hint: `${cnt('added')} added, ${cnt('removed')} removed, ${cnt('grew')} grew, ${cnt('shrank')} shrank` });

  const N = Number.isInteger(top) && top > 0 ? top : 25;
  const minD = Number.isFinite(minDelta) && minDelta > 0 ? minDelta : 1;
  const changed = all.filter((x) => Math.abs(x.d) >= minD).sort((a, b) => Math.abs(b.d) - Math.abs(a.d) || a.name.localeCompare(b.name));
  const shown = changed.slice(0, N);
  const rows = shown.map((x) => [x.name + (x.dup > 1 ? ` (×${x.dup})` : ''), x.region, x.old || '–', x.neu || '–', fmtB(x.d), x.status]);
  if (changed.length > N) {
    const rest = changed.slice(N).reduce((s, x) => s + x.d, 0);
    rows.push([`… ${changed.length - N} more changed symbols`, '', '', '', fmtB(rest), '']);
  }
  if (!changed.length) warnings.push('No symbol changed size between the two builds.');
  // growth by region
  const regions = ['text', 'rodata', 'data', 'bss', 'other'].map((r) => {
    const o = sum((x) => (x.region === r ? x.old : 0)), n = sum((x) => (x.region === r ? x.neu : 0));
    return [r, o, n, fmtB(n - o)];
  }).filter((r) => r[1] || r[2]);

  const big = shown.slice(0, 12);
  const notes = [
    `Formats read: old = ${A.format}, new = ${B.format}. Sizes are in bytes.`,
    'data counts twice in practice: its initial values sit in flash and a copy lives in RAM.',
    'Static functions with the same name in different files are summed and marked ×n. Build both with the same flags (-ffunction-sections -fdata-sections) so names line up.',
  ];
  if (A.format === 'map' || B.format === 'map') notes.push('From a map file the name is the input section (.text.foo → foo); functions merged by the linker or without -ffunction-sections show up under their object file\'s section.');
  const md = ['| Symbol | Region | Old | New | Change |', '|---|---|---:|---:|---:|', ...shown.map((x) => `| ${x.name} | ${x.region} | ${x.old} | ${x.neu} | ${fmtB(x.d)} |`)].join('\n');
  return {
    values,
    warnings,
    charts: big.length ? [{ title: 'Largest changes (bytes)', type: 'bars', x: big.map((x) => (x.name.length > 14 ? x.name.slice(0, 13) + '…' : x.name)), series: [{ name: 'Change', y: big.map((x) => x.d) }] }] : [],
    tables: [
      { title: `Changed symbols, largest first${changed.length > N ? ` (top ${N})` : ''}`, columns: ['Symbol', 'Region', 'Old', 'New', 'Change', 'Status'], rows },
      { title: 'By region', columns: ['Region', 'Old', 'New', 'Change'], rows: regions },
    ],
    texts: [{ title: 'Markdown', body: `Size change: ${fmtB(tot.neu - tot.old)} bytes total${known ? `, flash ${fmtB(flash.neu - flash.old)}, RAM ${fmtB(ram.neu - ram.old)}` : ''}.\n\n${md}\n` }],
    notes,
    // every symbol of both builds with its region, for a drawing of the two
    // images side by side (the tables above keep only the top changes)
    diff: {
      formats: { old: A.format, new: B.format },
      total: { old: tot.old, new: tot.neu }, flash: { old: flash.old, new: flash.neu }, ram: { old: ram.old, new: ram.neu }, minDelta: minD, top: N, changed: changed.length,
      regions: regions.map(([region, o, n]) => ({ region, old: o, new: n, d: n - o })),
      symbols: all.map((x) => ({ name: x.name, region: x.region, old: x.old, new: x.neu, d: x.d, status: x.status, dup: x.dup }))
        .sort((a, b) => Math.abs(b.d) - Math.abs(a.d) || a.name.localeCompare(b.name)),
    },
  };
}
