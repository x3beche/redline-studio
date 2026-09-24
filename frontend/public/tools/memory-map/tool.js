// Memory map viewer: how much of each flash and RAM region the sections of a
// firmware image use, from the output of GNU `size` or a hand-written list.
//
// Accepted input (auto-detected, one format per paste):
//  - `arm-none-eabi-size -A [-x] firmware.elf` (System V): "section size addr" rows;
//    each section is placed in the region its address falls in.
//  - `arm-none-eabi-size firmware.elf` (Berkeley): "text data bss dec hex filename";
//    flash = text + data, RAM = data + bss (GNU binutils size(1) definitions).
//  - Lines "name size region" written by hand, e.g. ".text 23K FLASH".
// Initialised data (.data and friends) lives in RAM but its initial values are
// stored in flash and copied at start-up (the LMA/VMA split of GNU ld), so it
// counts in both.

const K = { '': 1, B: 1, K: 1024, KB: 1024, KIB: 1024, M: 1048576, MB: 1048576, MIB: 1048576 };
/** "512K", "0x80000", "128 KB", "1M" -> bytes (K = 1024, as in linker scripts) */
export function parseSize(t) {
  const s = String(t ?? '').trim().toUpperCase().replace(/\s+/g, '');
  let m;
  if ((m = /^0X([0-9A-F]+)$/.exec(s))) return parseInt(m[1], 16);
  if ((m = /^(\d+(?:\.\d+)?)(|B|K|KB|KIB|M|MB|MIB)$/.exec(s))) return Math.round(Number(m[1]) * K[m[2]]);
  return null;
}
const num = (t) => (/^0x[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : /^\d+$/.test(t) ? Number(t) : null);
const kb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(2)} MiB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KiB` : `${b} B`);
const hex = (v) => '0x' + v.toString(16).toUpperCase().padStart(8, '0');

const SKIP = /^\.(debug|comment|ARM\.attributes|stab|note\.gnu|gnu\.attributes)|^Total$/i;
const NOLOAD = /bss|noinit|heap|stack|\._user_heap_stack|uninit/i;

export function run({ regions: regIn, sizes, flashName, ramName }) {
  const warnings = [], notes = [];
  const regions = [];
  for (const r of regIn || []) {
    const name = String(r.name ?? '').trim();
    if (!name) continue;
    const origin = parseSize(r.origin), length = parseSize(r.length);
    if (origin == null || !(length > 0)) { warnings.push(`Region ${name}: give the origin (0x08000000) and length (512K). Row skipped.`); continue; }
    regions.push({ name, origin, length, used: 0, parts: [] });
  }
  if (!regions.length) return { warnings: [...warnings, 'Add at least one memory region: name, origin, length.'] };
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    const a = regions[i], b = regions[j];
    if (a.origin < b.origin + b.length && b.origin < a.origin + a.length) warnings.push(`Regions ${a.name} and ${b.name} overlap: check their origins and lengths.`);
  }
  const find = (n, re, idx) => regions.find((r) => r.name.toUpperCase() === String(n ?? '').trim().toUpperCase())
    || regions.find((r) => re.test(r.name)) || regions[idx] || regions[0];
  const flash = find(flashName, /flash|rom/i, 0);
  const ram = find(ramName, /ram/i, 1);

  const lines = String(sizes ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const unread = [];
  let format = 'none';
  const berk = lines.findIndex((l) => /^text\s+data\s+bss/i.test(l));
  if (berk >= 0) {
    format = 'Berkeley';
    const row = lines.slice(berk + 1).find((l) => /^\d+\s+\d+\s+\d+/.test(l));
    if (!row) unread.push('no number row under "text data bss"');
    else {
      const [text, data, bss] = row.split(/\s+/).map(Number);
      flash.parts.push({ name: 'text', size: text }, { name: 'data (load copy)', size: data, copy: true });
      ram.parts.push({ name: 'data', size: data }, { name: 'bss', size: bss });
      notes.push('Berkeley format: "text" includes the vector table and read-only data; the heap and stack are only counted if the linker script reserves them as a section.');
    }
  } else {
    for (const l of lines) {
      if (/^section\s+size/i.test(l) || /:\s*$/.test(l) || /^-+$/.test(l)) continue;
      const t = l.split(/\s+/);
      if (SKIP.test(t[0])) continue;
      const size = num(t[1]) ?? parseSize(t[1]);
      if (t.length >= 3 && size != null && num(t[2]) != null) {
        format = 'size -A';
        const addr = num(t[2]);
        if (size === 0) continue;
        const reg = regions.find((r) => addr >= r.origin && addr < r.origin + r.length);
        if (!reg) { if (addr !== 0) unread.push(`${t[0]} at ${hex(addr)} is in no region`); continue; }
        reg.parts.push({ name: t[0], size, addr });
        if (reg !== flash && !NOLOAD.test(t[0])) flash.parts.push({ name: `${t[0]} (load copy)`, size, copy: true });
      } else if (t.length >= 3 && size != null) {
        format = 'list';
        const reg = regions.find((r) => r.name.toUpperCase() === t[2].toUpperCase());
        if (!reg) { unread.push(`${l} (no region "${t[2]}")`); continue; }
        reg.parts.push({ name: t[0], size });
        if (reg !== flash && !NOLOAD.test(t[0]) && t[3] !== 'noload') flash.parts.push({ name: `${t[0]} (load copy)`, size, copy: true });
      } else unread.push(l);
    }
  }
  if (unread.length) warnings.push(`Could not place ${unread.length} line${unread.length > 1 ? 's' : ''}: ${unread.slice(0, 5).join('; ')}${unread.length > 5 ? ' ...' : ''}.`);
  if (format === 'none' && lines.length) warnings.push('No size output recognised: paste the output of arm-none-eabi-size -A firmware.elf, or lines "name size region".');

  const rows = [];
  for (const r of regions) {
    // lay the parts out: at their addresses when known, else one after another
    let cur = 0;
    const placed = r.parts.filter((p) => p.addr != null).sort((a, b) => a.addr - b.addr);
    for (const p of placed) { p.offset = p.addr - r.origin; cur = Math.max(cur, p.offset + p.size); }
    for (const p of r.parts.filter((q) => q.addr == null)) { p.offset = cur; cur += p.size; }
    r.used = r.parts.reduce((s, p) => s + p.size, 0);
    r.end = cur;
    r.pct = (r.used / r.length) * 100;
    for (const p of r.parts.sort((a, b) => a.offset - b.offset)) rows.push([r.name, p.name, String(p.size), kb(p.size), hex(r.origin + p.offset), `${((p.size / r.length) * 100).toFixed(1)} %`]);
    if (r.end > r.length || r.used > r.length) warnings.push(`${r.name} overflows: ${kb(r.used)} in a ${kb(r.length)} region (${r.pct.toFixed(1)} %). The link will fail; shrink the image (-Os, -flto, drop printf float) or move sections.`);
    else if (r.pct > 90) warnings.push(`${r.name} is ${r.pct.toFixed(1)} % full: leave room for the next features, and for the stack if it is not reserved as a section.`);
  }
  if (!regions.some((r) => r.parts.some((p) => /stack|heap/i.test(p.name))) && format !== 'none') notes.push('No stack or heap section found: RAM free space is shared by the stack and heap at run time, so "free" is not really spare.');
  notes.push('Sizes in KiB (1024 bytes), as linker scripts count them.');
  return {
    values: regions.map((r) => ({ label: r.name, value: `${r.pct.toFixed(1)} %`, tone: r.pct > 100 ? 'bad' : r.pct > 90 ? 'warn' : 'ok',
      hint: `${kb(r.used)} of ${kb(r.length)}, ${kb(Math.max(0, r.length - r.used))} free` })).concat([{ label: 'Input read as', value: format }]),
    tables: [
      { title: 'Regions', columns: ['Region', 'Origin', 'Length', 'Used', 'Free', 'Use'], rows: regions.map((r) => [r.name, hex(r.origin), kb(r.length), kb(r.used), kb(Math.max(0, r.length - r.used)), `${r.pct.toFixed(1)} %`]) },
      ...(rows.length ? [{ title: 'Sections', columns: ['Region', 'Section', 'Bytes', 'Size', 'Address', 'Share'], rows }] : []),
    ],
    regions: regions.map((r) => ({ name: r.name, origin: r.origin, length: r.length, used: r.used, pct: r.pct,
      parts: r.parts.map((p) => ({ name: p.name, size: p.size, offset: p.offset, copy: !!p.copy })) })),
    warnings, notes,
  };
}
