// The .wks kickstart as wic reads it: `part`, `partition` and `bootloader`
// lines, `include` lines, comments. Parsed into an ordered model that keeps
// every line's text, so a file written back changes only the lines edited.
// Pure: used by tool.js (Node) and view.js (browser).
//
// Option names, units and defaults follow scripts/lib/wic/ksparser.py
// (poky scarthgap): --size/--fixed-size/--extra-space take M by default,
// --offset K by default, --align is a plain KiB integer, K/M/G suffixes.

// Options that take no value (ksparser.py action='store_true').
export const FLAGS = new Set(['active', 'no-table', 'use-uuid', 'use-label', 'no-fstab-update', 'hidden', 'mbr']);
// Every option ksparser.py accepts on a part line, and on the bootloader line.
export const PART_OPTS = new Set(['active', 'align', 'offset', 'exclude-path', 'include-path', 'change-directory', 'extra-space',
  'fsoptions', 'fspassno', 'fstype', 'mkfs-extraopts', 'label', 'use-label', 'no-table', 'ondisk', 'overhead-factor', 'part-name',
  'part-type', 'rootfs-dir', 'type', 'hidden', 'size', 'fixed-size', 'source', 'sourceparams', 'system-id', 'use-uuid', 'uuid',
  'fsuuid', 'no-fstab-update', 'mbr']);
export const BOOT_OPTS = new Set(['append', 'configfile', 'ptable', 'timeout', 'source']);

/** Split a line into tokens, honouring "double" and 'single' quotes. */
function tokenize(line) {
  const out = [];
  let cur = '', q = null, quoted = false, any = false;
  for (const ch of line) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; quoted = true; any = true; continue; }
    if (/\s/.test(ch)) { if (any) out.push({ t: cur, quoted }); cur = ''; quoted = false; any = false; continue; }
    cur += ch; any = true;
  }
  if (any) out.push({ t: cur, quoted });
  return out;
}

/** One `part` line -> {mount, opts: [{k, v, eq, quoted}], bad: [..]}. */
function parsePart(rest) {
  const toks = tokenize(rest);
  const part = { mount: '', opts: [], bad: [] };
  let i = 0;
  if (toks[0] && !toks[0].t.startsWith('--')) { part.mount = toks[0].t; i = 1; }
  for (; i < toks.length; i++) {
    const tk = toks[i].t;
    if (!tk.startsWith('--')) { part.bad.push(tk); continue; }
    let k = tk.slice(2), v = true, eq = false, quoted = false;
    const e = k.indexOf('=');
    if (e >= 0) { v = k.slice(e + 1); k = k.slice(0, e); eq = true; quoted = toks[i].quoted; }
    else if (!FLAGS.has(k) && toks[i + 1] && !toks[i + 1].t.startsWith('--')) { v = toks[i + 1].t; quoted = toks[i + 1].quoted; i++; }
    if (k === 'ondrive') k = 'ondisk';
    part.opts.push({ k, v, eq, quoted });
  }
  return part;
}

/** The whole file -> {lines: [{kind, text, part?, boot?}], parts, bootloader}. */
export function parseWks(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((t) => {
    const s = t.trim();
    if (!s) return { kind: 'blank', text: t };
    if (s.startsWith('#')) return { kind: 'comment', text: t };
    const m = /^(part|partition)\s*(.*)$/.exec(s);
    if (m) return { kind: 'part', text: t, word: m[1], part: parsePart(m[2]) };
    const b = /^bootloader\b\s*(.*)$/.exec(s);
    if (b) return { kind: 'bootloader', text: t, boot: parsePart(b[1]) };
    if (/^include\b/.test(s)) return { kind: 'include', text: t };
    return { kind: 'bad', text: t };
  });
  // a trailing blank line from the final newline is not a line
  while (lines.length && lines[lines.length - 1].kind === 'blank' && lines[lines.length - 1].text === '') lines.pop();
  return { lines };
}

export const opt = (p, k) => { const o = p.opts.find((x) => x.k === k); return o ? o.v : undefined; };

const needsQuote = (v) => /[\s"',;=]/.test(String(v));
function optText(o) {
  if (o.v === true) return `--${o.k}`;
  const v = String(o.v);
  const val = o.quoted || needsQuote(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
  return o.eq ? `--${o.k}=${val}` : `--${o.k} ${val}`;
}
export function partText(word, p) {
  return [word || 'part', p.mount || null, ...p.opts.map(optText)].filter(Boolean).join(' ');
}

/** Set (value) or remove (null/false/'') an option on a part, keeping its place and style. */
export function setOpt(p, k, v) {
  const i = p.opts.findIndex((x) => x.k === k);
  if (v == null || v === false || v === '') { if (i >= 0) p.opts.splice(i, 1); return; }
  if (i >= 0) p.opts[i] = { ...p.opts[i], v };
  else p.opts.push({ k, v, eq: /^(fstype|sourceparams|part-name|part-type)$/.test(k) && p.opts.some((x) => x.eq), quoted: false });
}

/** Model back to text: edited lines regenerated, the rest verbatim. */
export function writeWks(model) {
  return model.lines.map((l) => {
    if (l.kind === 'part' && l.dirty) return partText(l.word, l.part);
    if (l.kind === 'bootloader' && l.dirty) return ['bootloader', ...l.boot.opts.map(optText)].join(' ');
    return l.text;
  }).join('\n') + '\n';
}

/** A size argument -> KiB, as ksparser.sizetype() reads it: an integer with an
 *  optional suffix K/k, M or G (case matters for M and G), or S/s sectors for
 *  --offset. No decimals. Returns null when wic would refuse it. */
export function sizeK(v, unit = 'M', sectors = false) {
  if (v == null || v === true) return null;
  const t = String(v).trim();
  let m = /^(\d+)$/.exec(t);
  if (m) return unit === 'K' ? Number(m[1]) : Number(m[1]) * 1024;
  m = /^(\d+)([kKMGsS])$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2] === 's' || m[2] === 'S') return sectors ? n / 2 : null;
  return m[2] === 'M' ? n * 1024 : m[2] === 'G' ? n * 1048576 : n;
}
/** KiB -> the shortest exact wks size argument. */
export function sizeArg(k) {
  if (k % 1048576 === 0) return `${k / 1048576}G`;
  if (k % 1024 === 0) return `${k / 1024}M`;
  return `${k}K`;
}

// Bootloader raw areas and layouts from the BSP layers' own .wks files.
export const TEMPLATES = [
  { id: 'imx8mm', content: [{ part: 'imx-boot', size: '1950K' }, { part: '/boot', size: '34M' }], title: 'i.MX8M Mini/Quad: imx-boot at 33 KiB, A/B rootfs (eMMC)', device: 'emmc8', wks: `# i.MX8M Mini eMMC: imx-boot raw at 33K (ROM offset), boot, A/B rootfs, data
# after meta-freescale imx-imx-boot-bootpart.wks.in
part u-boot --source rawcopy --sourceparams="file=imx-boot" --ondisk mmcblk2 --no-table --align 33
part /boot --source bootimg-partition --ondisk mmcblk2 --fstype=vfat --label boot --active --align 8192 --size 64
part / --source rootfs --ondisk mmcblk2 --fstype=ext4 --label rootfsA --align 8192 --fixed-size 1536
part --source rootfs --ondisk mmcblk2 --fstype=ext4 --label rootfsB --align 8192 --fixed-size 1536
part /data --ondisk mmcblk2 --fstype=ext4 --label data --align 8192 --size 512
bootloader --ptable msdos
` },
  { id: 'imx8mp', content: [{ part: 'imx-boot', size: '2100K' }, { part: '/boot', size: '36M' }], title: 'i.MX8M Plus/Nano, i.MX93: imx-boot at 32 KiB (SD)', device: 'sd8', wks: `# i.MX8M Plus SD card: imx-boot at 32K
part u-boot --source rawcopy --sourceparams="file=imx-boot" --ondisk mmcblk1 --no-table --align 32
part /boot --source bootimg-partition --ondisk mmcblk1 --fstype=vfat --label boot --active --align 8192 --size 64
part / --source rootfs --ondisk mmcblk1 --fstype=ext4 --label root --align 8192
bootloader --ptable msdos
` },
  { id: 'imx6', content: [{ part: 'SPL', size: '60K' }, { part: 'u-boot.img', size: '700K' }, { part: '/boot', size: '8M' }], title: 'i.MX6/7: SPL at 1 KiB, u-boot.img at 69 KiB', device: 'sd4', wks: `# i.MX6 SD card: SPL at 1K, u-boot.img at 69K (imx-uboot-spl-bootpart.wks.in)
part SPL --source rawcopy --sourceparams="file=SPL" --ondisk mmcblk --no-table --align 1
part u-boot --source rawcopy --sourceparams="file=u-boot.img" --ondisk mmcblk --no-table --align 69
part /boot --source bootimg-partition --ondisk mmcblk --fstype=vfat --label boot --active --align 4096 --size 16
part / --source rootfs --ondisk mmcblk --fstype=ext4 --label root --align 4096
bootloader --ptable msdos
` },
  { id: 'rockchip', content: [{ part: 'idbloader.img', size: '180K' }, { part: 'u-boot.itb', size: '1100K' }, { part: '/boot', size: '40M' }], title: 'Rockchip: idbloader at sector 64, u-boot.itb at 8 MiB (GPT)', device: 'emmc16', wks: `# Rockchip eMMC: idbloader.img at sector 64 (32K), u-boot.itb at sector 16384 (8M)
part loader1 --part-name=loader1 --offset 32K --fixed-size 4000K --source rawcopy --sourceparams="file=idbloader.img"
part v_storage --part-name=v_storage --offset 4032K --fixed-size 32K
part loader2 --part-name=loader2 --offset 8M --fixed-size 4M --source rawcopy --sourceparams="file=u-boot.itb"
part /boot --part-name=boot --source bootimg-partition --fstype=vfat --label boot --active --align 16384 --size 64
part / --part-name=root --source rootfs --fstype=ext4 --label root --align 16384
bootloader --ptable gpt
` },
  { id: 'rpi', content: [{ part: '/boot', size: '48M' }], title: 'Raspberry Pi: firmware in a FAT boot partition, no raw area', device: 'sd16', wks: `# Raspberry Pi (meta-raspberrypi sdimage-raspberrypi.wks)
part /boot --source bootimg-partition --ondisk mmcblk0 --fstype=vfat --label boot --active --align 4096 --size 100
part / --source rootfs --ondisk mmcblk0 --fstype=ext4 --label root --align 4096
bootloader --ptable msdos
` },
  { id: 'efi', content: [{ part: '/boot', size: '24M' }], title: 'x86-64 EFI: ESP, rootfs and swap (GPT)', device: 'custom', wks: `# x86-64 EFI disk (poky mkefidisk.wks)
part /boot --source bootimg-efi --sourceparams="loader=grub-efi" --ondisk sda --label msdos --active --align 1024
part / --source rootfs --ondisk sda --fstype=ext4 --label platform --align 1024 --use-uuid
part swap --ondisk sda --size 44 --label swap1 --fstype=swap
bootloader --ptable gpt --timeout=5 --append="rootfstype=ext4 console=ttyS0,115200 console=tty0"
` },
];
