// WIC Partition Layout: where wic puts every partition of a .wks on the disk,
// and how big it makes each one - the same arithmetic as the tools, so the
// drawing matches the image bitbake writes.
//
// Sources (poky scarthgap 5.0, read from scripts/lib/wic and meta/):
//   ksparser.py      option units (--size M, --offset K or s, --align KiB int),
//                    defaults --extra-space 10M, --overhead-factor 1.3, and the
//                    errors for --fixed-size with either of them
//   partition.py     get_rootfs_size(): fixed, or int((du + max(size - du,
//                    extra)) * overhead); prepare_rootfs(): with no --size the
//                    rootfs partition starts from bitbake's ROOTFS_SIZE
//   plugins/source   rawcopy: max(--size, file); bootimg-efi/-pcbios: du +
//                    max(size - du, BOOTDD_EXTRA_SPACE = 16 MiB), then fixed
//   direct.py        layout_partitions(): MBR 1 / GPT 34 sectors before the
//                    first partition, 2 sectors per logical partition, align
//                    then --offset, GPT keeps 34 sectors at the end
//   image.bbclass    get_rootfs_size(): ROOTFS_SIZE = align(ceil(max(du *
//                    IMAGE_OVERHEAD_FACTOR, IMAGE_ROOTFS_SIZE) +
//                    IMAGE_ROOTFS_EXTRA_SPACE)), all in KiB

import { parseWks, opt, sizeK, sizeArg, PART_OPTS, BOOT_OPTS } from './wks.js';

const SECTOR = 512;
const MBR_OVERHEAD = 1, GPT_OVERHEAD = 34;          // direct.py
const EXTRA_DEFAULT = 10 * 1024, OVERHEAD_DEFAULT = 1.3; // ksparser.py KickStart
const BOOTDD_EXTRA_SPACE = 16384;                   // wic/misc.py, KiB

// User-area sizes of common parts, in 512-byte sectors (what the kernel reports
// in /sys/block/mmcblkN/size). Marketing "8 GB" is 10^9 bytes and less after
// the card's own reserve; your part may differ by a few MiB.
export const DEVICES = {
  sd4: { name: 'SD 4 GB', sectors: 7744512 },
  sd8: { name: 'SD 8 GB', sectors: 15523840 },
  sd16: { name: 'SD 16 GB', sectors: 31116288 },
  sd32: { name: 'SD 32 GB', sectors: 62333952 },
  emmc4: { name: 'eMMC 4 GB', sectors: 7634944 },
  emmc8: { name: 'eMMC 8 GB', sectors: 15269888 },
  emmc16: { name: 'eMMC 16 GB', sectors: 30777344 },
  emmc32: { name: 'eMMC 32 GB', sectors: 61071360 },
};

const MiB = (k) => `${Number((k / 1024).toFixed(k % 1024 ? 2 : 0))} MiB`;
const human = (k) => (k >= 1048576 ? `${Number((k / 1048576).toFixed(2))} GiB` : k >= 1024 ? MiB(k) : `${Number(k.toFixed(1))} KiB`);
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/** image.bbclass get_rootfs_size(), KiB. */
export function rootfsSize({ du, req, factor, extra, align, max }) {
  const base = du * factor;
  const base2 = Math.max(base, req) + extra;
  const ceil = base2 !== Math.trunc(base2) ? Math.trunc(base2 + 1) : Math.trunc(base2);
  const a = Math.max(1, Math.trunc(align));
  const aligned = ceil + a - 1 - ((ceil + a - 1) % a);
  return { base, base2, ceil, aligned, over: max > 0 && aligned > max };
}

export function run(input) {
  const warnings = [], notes = [];
  const model = parseWks(input.wks);
  const parts = [];
  let boot = null;
  model.lines.forEach((l, i) => {
    if (l.kind === 'part') parts.push({ line: i, word: l.word, p: l.part });
    else if (l.kind === 'bootloader' && !boot) boot = l.boot;
    else if (l.kind === 'bad') warnings.push(`Line ${i + 1} is not a wks command and wic would stop on it: "${l.text.trim().slice(0, 60)}". Start it with part, bootloader or include, or comment it out with #.`);
    else if (l.kind === 'include') notes.push(`Line ${i + 1} includes another .wks; its partitions are not drawn here - paste them in to see the whole disk.`);
  });

  // ---- the device ----
  const dev = DEVICES[input.device];
  let diskK = dev ? dev.sectors / 2 : sizeK(String(input.diskSize || '').replace(/i?B$/i, ''), 'M');
  if (!diskK) { warnings.push(`Device size "${input.diskSize}" does not read; write it like 7580M or 16G. Using 8 GiB.`); diskK = 8 * 1048576; }
  let eraseK = sizeK(String(input.erase || '').replace(/i?B$/i, ''), 'K');
  if (!eraseK) { warnings.push(`Erase block "${input.erase}" does not read; write it like 512K or 4M. Using 4 MiB.`); eraseK = 4096; }

  // ---- ROOTFS_SIZE as image.bbclass computes it ----
  const du = Math.max(0, num(input.rootfsDu, 0));
  const est = rootfsSize({ du, req: Math.max(0, num(input.imageRootfsSize, 65536)), factor: Math.max(1, num(input.overhead, 1.3)),
    extra: Math.max(0, num(input.extraSpace, 0)), align: Math.max(1, num(input.alignment, 1)), max: Math.max(0, num(input.maxSize, 0)) });
  if (est.over) warnings.push(`ROOTFS_SIZE ${est.aligned} KiB is over IMAGE_ROOTFS_MAXSIZE ${input.maxSize} KiB: bitbake stops the build. Remove packages or raise IMAGE_ROOTFS_MAXSIZE.`);
  if (num(input.overhead, 1.3) < 1) warnings.push('IMAGE_OVERHEAD_FACTOR below 1.0 leaves less room than the files need; 1.3 is the default.');

  // ---- content sizes the tool cannot know (raw files, boot files) ----
  const content = new Map();
  for (const r of input.content || []) {
    const k = sizeK(String(r.size || '').trim(), 'K');
    if (!String(r.part || '').trim()) continue;
    if (k == null) { warnings.push(`Content size "${r.size}" for ${r.part} does not read; write it like 1950K or 34M.`); continue; }
    content.set(String(r.part).trim(), k);
  }

  const ptable = (boot && opt(boot, 'ptable')) || 'msdos';
  if (boot) {
    const unknown = boot.opts.filter((o) => !BOOT_OPTS.has(o.k)).map((o) => `--${o.k}`);
    if (unknown.length) warnings.push(`bootloader ${unknown.join(', ')}: not a wic bootloader option; wic stops on it.`);
  }
  const gpt = ptable === 'gpt' || ptable === 'gpt-hybrid';
  if (!['msdos', 'gpt', 'gpt-hybrid'].includes(ptable)) warnings.push(`--ptable ${ptable} is not msdos, gpt or gpt-hybrid; wic refuses it.`);
  if (!boot) notes.push('No bootloader line: wic warns and uses an msdos partition table.');

  const tableCount = parts.filter((x) => !opt(x.p, 'no-table')).length;
  let offset = 0, numpart = 0, primary = 0, extended = 0, logicalCnt = 0, realpart = 0;
  const out = [];
  parts.forEach((x, idx) => {
    const p = x.p;
    const lineNo = x.line + 1;
    const src = opt(p, 'source') || '';
    const fstype = opt(p, 'fstype') || 'vfat';            // ksparser default
    const fsShown = opt(p, 'fstype') || (src === 'rawcopy' || (opt(p, 'no-table') && !src) ? '–' : 'vfat');
    const label = opt(p, 'label') || '';
    const noTable = !!opt(p, 'no-table');
    const name = p.mount || label || opt(p, 'part-name') || `part${idx + 1}`;
    const w = [];
    const bad = (msg) => { w.push(msg); warnings.push(`Line ${lineNo} (${name}): ${msg}`); };
    if (p.bad.length) bad(`"${p.bad.join(' ')}" is not an option; wic stops on it.`);
    const unknown = p.opts.filter((o) => !PART_OPTS.has(o.k)).map((o) => `--${o.k}`);
    if (unknown.length) bad(`${unknown.join(', ')}: not a wic part option; wic stops ("unrecognized arguments").`);
    const read = (k, unit, sectors) => {
      const v = opt(p, k);
      if (v === undefined) return undefined;
      const r = sizeK(v, unit, sectors);
      if (r == null) bad(`--${k} ${v} is not a size wic reads (an integer with K, M or G; no decimals).`);
      return r ?? undefined;
    };
    const fixed = read('fixed-size', 'M');
    const size = read('size', 'M');
    const extraOpt = read('extra-space', 'M');
    const ofOpt = opt(p, 'overhead-factor');
    const offK = read('offset', 'K', true);
    const alignRaw = opt(p, 'align');
    let align = 0;
    if (alignRaw !== undefined) {
      if (!/^\d+$/.test(String(alignRaw))) bad(`--align ${alignRaw} must be a whole number of KiB (no suffix).`);
      else align = Number(alignRaw);
    }
    if (fixed != null && size != null) bad('--size and --fixed-size cannot both be given.');
    if (fixed && (extraOpt || (ofOpt !== undefined && Number(ofOpt)))) bad('--overhead-factor and --extra-space are not allowed with --fixed-size.');
    if (ofOpt !== undefined && !(Number(ofOpt) >= 1)) bad(`--overhead-factor ${ofOpt} must be a number of at least 1.0.`);
    if (fstype === 'squashfs' && label) bad('SquashFS has no label; wic refuses --label with it.');
    if (fstype === 'erofs' && label) bad('erofs has no label; wic refuses --label with it.');
    if (opt(p, 'use-label') && !label) bad('--use-label needs --label.');
    if (!gpt && opt(p, 'part-name')) bad('--part-name is GPT only; wic stops with msdos. Use --ptable gpt or drop it.');
    if (!gpt && opt(p, 'part-type')) bad('--part-type is GPT only; wic stops with msdos.');
    if ((fstype === 'vfat' || fstype === 'msdos') && label.length > 11) bad(`FAT label "${label}" is longer than 11 characters; mkdosfs cuts it.`);
    if (fstype.startsWith('ext') && label.length > 16) bad(`ext label "${label}" is longer than 16 characters; mkfs.ext4 refuses it.`);

    const extra = extraOpt ?? EXTRA_DEFAULT;
    const of = ofOpt !== undefined && Number(ofOpt) >= 1 ? Number(ofOpt) : OVERHEAD_DEFAULT;
    const keys = [p.mount, label, opt(p, 'part-name'), (String(opt(p, 'sourceparams') || '').match(/file=([^,]+)/) || [])[1]].filter(Boolean);
    const given = keys.map((k) => content.get(k)).find((v) => v != null);

    // ---- the partition's size, as the source plugin makes it ----
    let sizeKiB = 0, how = '', contentK = null, headroom = null, mode = fixed ? 'fixed' : size ? 'size' : 'auto';
    const fromRootfs = (duK, sz) => {
      const extraBlocks = Math.max(sz > duK ? sz - duK : 0, extra);
      return Math.trunc((duK + extraBlocks) * of);
    };
    if (src === 'rootfs') {
      const own = !opt(p, 'rootfs-dir');
      contentK = own ? du : given ?? null;
      if (contentK == null) { contentK = 0; bad('--rootfs-dir content size unknown: add a row for it under Content sizes.'); }
      if (fixed) {
        sizeKiB = fixed; how = `--fixed-size ${sizeArg(fixed)}`;
        if (contentK > fixed) bad(`the rootfs (${human(contentK)}) is larger than --fixed-size ${sizeArg(fixed)}: wic stops ("Actual rootfs size is larger than allowed size"). Raise it to at least ${sizeArg(Math.ceil(contentK * 1.1 / 1024) * 1024)}.`);
        else if (contentK > fixed * 0.9) bad(`the rootfs fills ${Math.round((contentK / fixed) * 100)} % of --fixed-size; ext4 metadata and journal need several percent more, mkfs may fail. Leave at least 10 % free.`);
      } else {
        const start = size || (own ? est.aligned : contentK);
        sizeKiB = fromRootfs(contentK, start);
        how = size ? `int((${contentK} + max(${size} − ${contentK}, ${extra})) × ${of})`
          : own ? `ROOTFS_SIZE ${est.aligned} → int((${contentK} + max(${est.aligned} − ${contentK}, ${extra})) × ${of})`
            : `int((${contentK} + ${extra}) × ${of})`;
        if (!size && own) notes.push(`${name}: with no --size, wic starts from bitbake's ROOTFS_SIZE (${est.aligned} KiB, already × IMAGE_OVERHEAD_FACTOR) and multiplies by --overhead-factor again: the partition is ${human(sizeKiB)} for ${human(contentK)} of files. Give --size or --fixed-size to control it.`);
      }
      headroom = sizeKiB - contentK;
    } else if (src === 'bootimg-partition' || src === 'rootfs-u-boot' || src === 'extra-partition') {
      contentK = given ?? 0;
      if (given == null) bad('boot files size unknown (IMAGE_BOOT_FILES): add a row under Content sizes to size it; 0 assumed.');
      if (fixed) { sizeKiB = fixed; how = `--fixed-size ${sizeArg(fixed)}`; if (contentK > fixed) bad(`the boot files (${human(contentK)}) do not fit --fixed-size ${sizeArg(fixed)}.`); }
      else { sizeKiB = fromRootfs(contentK, size || 0); how = `int((${contentK} + max(${size || 0} − ${contentK}, ${extra})) × ${of})`; }
      headroom = sizeKiB - contentK;
    } else if (/^bootimg-(efi|pcbios|biosplusefi)$/.test(src)) {
      contentK = given ?? 0;
      if (given == null) bad('loader and kernel size unknown: add a row under Content sizes; 0 assumed.');
      let blocks = contentK + Math.max(size && size > contentK ? size - contentK : 0, BOOTDD_EXTRA_SPACE);
      how = `${contentK} + max(${size || 0} − ${contentK}, 16384)`;
      if (fixed && blocks < fixed) { blocks = fixed; how = `--fixed-size ${sizeArg(fixed)}`; }
      if (fixed && blocks > fixed) bad(`the ${src} content plus 16 MiB (${human(blocks)}) is over --fixed-size ${sizeArg(fixed)}.`);
      sizeKiB = blocks;
      headroom = sizeKiB - contentK;
    } else if (src === 'rawcopy') {
      contentK = given ?? 0;
      if (given == null) bad('file size unknown: add a row under Content sizes (the size of the file in sourceparams); 0 assumed.');
      const want = fixed || size || 0;
      sizeKiB = Math.max(want, contentK);
      how = want ? `max(--${fixed ? 'fixed-size' : 'size'} ${sizeArg(want)}, file ${contentK})` : `file ${contentK} KiB`;
      if (fixed && contentK > fixed) bad(`the file (${human(contentK)}) is larger than --fixed-size ${sizeArg(fixed)}: wic stops.`);
      mode = fixed ? 'fixed' : size ? 'size' : 'file';
    } else if (!src) {
      sizeKiB = fixed || size || 0;
      how = fixed ? `--fixed-size ${sizeArg(fixed)}` : size ? `--size ${sizeArg(size)} (empty ${fstype})` : '';
      if (!sizeKiB && !noTable && fstype !== 'none') bad('an empty partition needs --size or --fixed-size; wic stops with "has a size of zero".');
      if (fstype === 'squashfs' || fstype === 'erofs') bad(`wic cannot make an empty ${fstype} partition: give it a --source.`);
    } else {
      contentK = given ?? 0;
      sizeKiB = fixed || Math.max(size || 0, contentK);
      how = `plugin ${src}: taken as ${fixed ? '--fixed-size' : '--size or content'}`;
      notes.push(`${name}: source plugin "${src}" is not one this tool models; its size is taken from --fixed-size, --size or the content size you give.`);
    }
    if (mode === 'auto' && src === 'rawcopy') mode = 'file';

    // ---- where direct.py layout_partitions() puts it ----
    numpart += 1;
    if (!noTable) realpart += 1;
    if (numpart === 1) offset += gpt ? GPT_OVERHEAD : MBR_OVERHEAD;
    let type = opt(p, 'type') || 'primary';
    if (!gpt) {
      if (primary > 3 || (extended === 0 && primary >= 3 && tableCount > 4)) type = 'logical';
      if (type === 'logical') offset += 2;    // EBR, before alignment
    }
    const before = offset;
    if (align) {
      const as = (align * 1024) / SECTOR;
      const off = offset % as;
      if (off) offset += as - off;
    }
    let start = offset;
    let overlap = false;
    if (offK != null) {
      const want = offK * 2;
      if (!Number.isInteger(want)) bad(`--offset ${opt(p, 'offset')} is not a whole sector.`);
      if (want < offset) { overlap = true; bad(`--offset ${sizeArg(offK)} is before the next free sector (${human(offset / 2)}): wic stops with "Could not place". It overlaps what comes before.`); }
      start = want;
    }
    offset = Math.max(offset, start) + sizeKiB * 2;
    let num = 0;
    if (!noTable) {
      if (!gpt && type === 'logical') { logicalCnt += 1; num = logicalCnt + 4; if (extended === 0) { primary += 1; extended = num; } }
      else { primary += 1; num = gpt ? realpart : primary; }
    }
    // A raw bootloader placed with --align N (N not a MiB multiple) means "at N KiB":
    // the ROM looks there. If the table pushed it further, the board will not boot.
    if (noTable && align && offK == null && start !== align * 2) {
      bad(`asked for ${align} KiB (--align ${align}) but lands at ${human(start / 2)}: the ${gpt ? 'GPT header and entries take the first 17 KiB' : 'previous partition ends after it'}. The boot ROM will not find it there; use --offset or ${gpt ? 'an msdos table' : 'reorder'}.`);
    }
    if (!noTable && src !== 'rawcopy' && (start / 2) % eraseK) w.push(`starts at ${human(start / 2)}, not on a ${human(eraseK)} erase-block boundary`);
    out.push({
      i: idx, line: x.line, name, mount: p.mount, label, partName: opt(p, 'part-name') || '', file: (String(opt(p, 'sourceparams') || '').match(/file=([^,]+)/) || [])[1] || '', source: src || (fstype === 'swap' ? 'swap' : 'empty'), fstype: fsShown,
      table: !noTable, num, type: !noTable && !gpt ? type : '', active: !!opt(p, 'active'),
      startK: start / 2, sizeK: sizeKiB, endK: start / 2 + sizeKiB, gapK: (start - before) / 2,
      mode, fixedK: fixed || 0, sizeOptK: size || 0, alignK: align, offsetK: offK ?? null, contentK, headroomK: headroom, how,
      overlap, warns: w,
    });
  });

  // misaligned table partitions, one warning for all of them
  const mis = out.filter((o) => o.table && o.source !== 'rawcopy' && o.startK % eraseK);
  if (mis.length) warnings.push(`${mis.map((o) => `${o.name} starts at ${human(o.startK)}`).join(', ')}: not on a ${human(eraseK)} erase-block boundary. Writes straddle erase blocks and wear the flash faster; use --align ${eraseK} (or a multiple).`);
  // overlaps by position (--offset cases)
  for (let a = 0; a < out.length; a++) for (let b = a + 1; b < out.length; b++) {
    const A = out[a], B = out[b];
    if (A.sizeK && B.sizeK && A.startK < B.endK && B.startK < A.endK) {
      A.overlap = B.overlap = true;
      warnings.push(`${A.name} (${human(A.startK)}–${human(A.endK)}) and ${B.name} (${human(B.startK)}–${human(B.endK)}) overlap.`);
    }
  }
  const tableEndK = gpt ? GPT_OVERHEAD / 2 : MBR_OVERHEAD / 2;
  for (const o of out) if (o.startK < tableEndK && o.sizeK) {
    o.overlap = true;
    warnings.push(`${o.name} starts at ${human(o.startK)}, inside the ${gpt ? 'GPT header and entries (first 17 KiB)' : 'MBR (first sector)'}.`);
  }

  const endSec = offset + (gpt ? GPT_OVERHEAD : 0);
  const imageK = endSec / 2;
  const freeK = diskK - imageK;
  if (freeK < 0) warnings.push(`The image needs ${human(imageK)} but the device holds ${human(diskK)}: ${human(-freeK)} too much. Shrink the largest partition or pick a bigger device.`);
  if (!gpt && tableCount > 4) notes.push(`${tableCount} table partitions on msdos: from the 4th on they are logical (numbered 5, 6, ...) inside an extended partition; wic keeps 2 sectors before each for its EBR.`);
  if (gpt) notes.push('GPT keeps a backup header and entries in the last 17 KiB of the image; wic writes them at the end of the image, and the kernel/sgdisk -e moves them to the end of a larger device.');
  if (out.some((o) => o.source === 'rootfs')) notes.push('Rootfs partitions are ext images sized at build time; to use the rest of the device, grow the last one on first boot (growpart + resize2fs, or systemd-repart).');
  notes.push('An eMMC erase group is often 512 KiB (EXT_CSD HC_ERASE_GRP_SIZE) and an SD allocation unit 4 MiB (SD Status AU_SIZE); aligning to 4 MiB suits both.');
  if (!parts.length) warnings.push('No part lines: paste a .wks or pick a template.');

  const used = out.reduce((s, o) => s + o.sizeK, 0);
  const rootfsParts = out.filter((o) => o.source === 'rootfs');
  const values = [
    { label: 'Image size', value: human(imageK), hint: `${endSec} sectors`, tone: freeK < 0 ? 'bad' : undefined },
    { label: 'Device', value: human(diskK), hint: dev ? dev.name : 'custom' },
    { label: 'Free after image', value: freeK < 0 ? `−${human(-freeK)}` : human(freeK), tone: freeK < 0 ? 'bad' : freeK < diskK * 0.02 ? 'warn' : 'ok' },
    { label: 'ROOTFS_SIZE', value: est.aligned, unit: 'KiB', hint: `max(${du} × ${num(input.overhead, 1.3)}, ${num(input.imageRootfsSize, 65536)}) + ${num(input.extraSpace, 0)}, aligned to ${num(input.alignment, 1)}`, tone: est.over ? 'bad' : undefined },
    ...rootfsParts.slice(0, 2).map((o) => ({ label: `${o.name} partition`, value: human(o.sizeK), hint: o.how })),
    { label: 'Partition table', value: ptable, hint: `${tableCount} in table, ${out.length - tableCount} raw` },
  ];
  const table = {
    title: 'Layout',
    columns: ['#', 'Name', 'Source', 'fstype', 'Start', 'Size', 'End', 'Sized by'],
    rows: out.map((o) => [o.table ? o.num : 'raw', o.name, o.source, o.fstype, human(o.startK), human(o.sizeK), human(o.endK), o.how || '–']),
  };
  const layoutText = [
    `# ${ptable} table, device ${human(diskK)}, image ${human(imageK)} (${endSec} sectors), erase block ${human(eraseK)}`,
    '# num  start(sector)      end(sector)     size        name',
    ...out.map((o) => `${String(o.table ? o.num : '-').padStart(5)}  ${String(o.startK * 2).padStart(13)}  ${String(o.endK * 2 - 1).padStart(15)}  ${human(o.sizeK).padStart(10)}  ${o.name}${o.table ? '' : ' (not in table)'}`),
  ].join('\n');

  return {
    values,
    tables: [table],
    texts: [{ title: '.wks', body: String(input.wks || '').replace(/\s*$/, '\n'), lang: 'text' }, { title: 'Layout', body: layoutText }],
    warnings, notes,
    layout: {
      diskK, imageK, eraseK, ptable, gpt, tableK: tableEndK, used,
      parts: out,
      rootfs: { du, req: num(input.imageRootfsSize, 65536), factor: num(input.overhead, 1.3), extra: num(input.extraSpace, 0), align: num(input.alignment, 1), max: num(input.maxSize, 0), ...est },
    },
  };
}
