// ESP-IDF partition table planner (ESP32 family), after the ESP-IDF
// Programming Guide, "Partition Tables" and "Over The Air Updates (OTA)":
//   - the partition table sits at 0x8000 by default (CONFIG_PARTITION_TABLE_OFFSET),
//     0xC00 long; the first partition starts one 4 KiB sector later (0x9000)
//   - app partitions must start on a 64 KiB (0x10000) boundary: the flash MMU
//     maps code in 64 KiB pages; data partitions on 4 KiB (erase sector)
//   - OTA needs an otadata partition (data/ota, 0x2000 = two sectors) and at
//     least two app slots ota_0/ota_1; a factory slot is optional
//   - NVS needs at least 3 pages (0x3000); 0x6000 is the IDF default
//   - NVS encryption needs an nvs_keys partition (0x1000, encrypted flag)
//   - core dump to flash: data/coredump, 64 KiB covers a typical dump
// Sizes are rounded up to those boundaries; the gaps they leave are reported.

const KB = 1024, SECTOR = 0x1000, APP_ALIGN = 0x10000;
const up = (v, a) => Math.ceil(v / a) * a;
const hex = (v) => '0x' + v.toString(16);
const kib = (v) => (v % KB === 0 ? `${v / KB} KiB` : `${(v / KB).toFixed(1)} KiB`);
const human = (v) => (v >= 1024 * KB && v % (64 * KB) === 0 ? `${(v / (1024 * KB)).toFixed(v % (1024 * KB) ? 3 : 0).replace(/\.?0+$/, '')} MiB` : kib(v));

const CHIPS = {
  esp32: { name: 'ESP32', boot: 0x1000 },
  esp32s2: { name: 'ESP32-S2', boot: 0x1000 },
  esp32s3: { name: 'ESP32-S3', boot: 0x0 },
  esp32c3: { name: 'ESP32-C3 / C6 / H2', boot: 0x0 },
  esp32p4: { name: 'ESP32-P4', boot: 0x2000 },
};

export function run({ chip, flash, ota, image, headroom, appMode, nvs, nvsKeys, phy, coredump, fs, fsSize, ptOffset }) {
  const warnings = [];
  const C = CHIPS[chip] || CHIPS.esp32;
  const FLASH = (Number(flash) || 4) * 1024 * KB;
  const pt = parseInt(String(ptOffset ?? '0x8000').trim().replace(/^0x/i, ''), 16);
  if (!Number.isFinite(pt) || pt % SECTOR || pt < 0x8000) {
    return { warnings: ['Partition table offset must be hex on a 4 KiB boundary, e.g. 0x8000 (the default) or 0x10000 with a large or secure-boot bootloader.'] };
  }
  if (!(image > 0)) return { warnings: ['Give the app image size in KiB (the size of build/<project>.bin), e.g. 1200.'] };
  const h = Number.isFinite(headroom) && headroom >= 0 ? headroom : 0;
  if (!(nvs > 0)) return { warnings: ['Give the NVS size in KiB, e.g. 24.'] };

  const parts = [];
  let off = pt + SECTOR;
  const add = (name, type, sub, size, flags = '', align = SECTOR) => {
    const start = up(off, align);
    const gap = start - off;
    parts.push({ name, type, sub, offset: start, size, flags, gap });
    off = start + size;
    return parts[parts.length - 1];
  };

  // data partitions before the apps (IDF order)
  const nvsSize = up(nvs * KB, SECTOR);
  if (nvsSize < 0x3000) warnings.push(`NVS of ${kib(nvsSize)} is below the 12 KiB minimum (3 pages): nvs_flash_init() fails. Use 24 KiB (0x6000).`);
  else if (nvsSize < 0x5000) warnings.push(`NVS of ${kib(nvsSize)} leaves little room for wear levelling and Wi-Fi calibration data; 24 KiB (0x6000) is the IDF default.`);
  add('nvs', 'data', 'nvs', nvsSize);
  const slots = ota === 'factory' ? ['factory'] : ota === 'ota2' ? ['factory', 'ota_0', 'ota_1'] : ota === 'ota3' ? ['ota_0', 'ota_1', 'ota_2'] : ['ota_0', 'ota_1'];
  const hasOta = slots.some((s) => s.startsWith('ota_'));
  if (hasOta) add('otadata', 'data', 'ota', 0x2000);
  if (phy) add('phy_init', 'data', 'phy', SECTOR);
  if (nvsKeys) add('nvs_keys', 'data', 'nvs_keys', SECTOR, 'encrypted');

  // app slots
  const appStart = up(off, APP_ALIGN);
  const cdSize = coredump ? 64 * KB : 0;
  const want = up(image * KB * (1 + h / 100), APP_ALIGN);
  let appSize;
  const fsFixed = fs !== 'none' && fsSize > 0 ? up(fsSize * KB, SECTOR) : 0;
  if (appMode === 'max') {
    const fsNeed = fsFixed;
    if (fs !== 'none' && !fsFixed) warnings.push('With "as large as possible" app slots, give the filesystem a size above 0, or it gets nothing.');
    const room = FLASH - appStart - cdSize - fsNeed;
    appSize = Math.floor(room / slots.length / APP_ALIGN) * APP_ALIGN;
    if (appSize < want) warnings.push(`Each app slot gets ${human(appSize)}, less than the ${human(want)} the image plus headroom needs. Use a bigger flash, fewer slots or a smaller filesystem.`);
  } else appSize = want;
  if (!(appSize > 0)) {
    return { warnings: [...warnings, `Nothing is left for the app slots on ${human(FLASH)} flash. Choose a bigger flash or a smaller filesystem.`] };
  }
  for (const s of slots) add(s, 'app', s, appSize, '', APP_ALIGN);
  if (coredump) add('coredump', 'data', 'coredump', cdSize);

  // filesystem: fixed size or the rest of the flash
  let fsPart = null;
  if (fs !== 'none') {
    const start = up(off, SECTOR);
    const size = appMode === 'max' ? fsFixed : fsFixed || Math.max(0, FLASH - start);
    const sub = fs === 'fat' ? 'fat' : fs === 'spiffs' ? 'spiffs' : 'littlefs';
    const name = fs === 'fat' ? 'storage' : fs === 'spiffs' ? 'spiffs' : 'littlefs';
    if (size > 0) fsPart = add(name, 'data', sub, size);
    else warnings.push('No room is left for the filesystem.');
  }
  const end = off;
  const free = FLASH - end;
  if (free < 0) {
    warnings.push(`The partitions end at ${hex(end)}, ${human(-free)} past the end of the ${human(FLASH)} flash. Shrink the filesystem, the headroom or the number of app slots, or choose a bigger flash.`);
  }
  const fill = (image * KB) / appSize;
  if (fill > 1) warnings.push(`The ${kib(image * KB)} image does not fit its ${human(appSize)} slot. Enlarge the slots.`);
  else if (fill > 0.9) warnings.push(`The image fills ${Math.round(fill * 100)} % of its slot: the next few features will not fit an OTA update. Leave 20-30 % headroom.`);
  if (fs === 'spiffs') warnings.push('SPIFFS is no longer developed and has no directories or power-loss safety; LittleFS is the usual choice for new designs.');
  if (fs === 'fat' && fsPart && fsPart.size < 528 * KB) warnings.push(`FAT with wear levelling needs a partition of more than ~528 KiB for 128 FAT sectors plus WL overhead; ${kib(fsPart.size)} may fail to mount or format.`);
  if (ota === 'factory') warnings.push('Without OTA slots the firmware can only be updated over the cable (or by a custom updater).');
  const gaps = parts.reduce((s, p) => s + p.gap, 0);
  const firstApp = parts.find((p) => p.type === 'app');
  const notes2 = [];
  if (firstApp && firstApp.gap >= 16 * KB) {
    notes2.push(`The ${kib(firstApp.gap)} gap before ${firstApp.name} (64 KiB app alignment) is lost otherwise: NVS could grow to ${kib(nvsSize + firstApp.gap)} at no cost.`);
  }

  const csv = [
    `# ESP-IDF partition table for ${C.name}, ${human(FLASH)} flash, table at ${hex(pt)}`,
    '# Name,     Type, SubType,  Offset,    Size,      Flags',
    ...parts.map((p) => `${(p.name + ',').padEnd(11)} ${(p.type + ',').padEnd(5)} ${(p.sub + ',').padEnd(9)} ${(hex(p.offset) + ',').padEnd(10)} ${(hex(p.size) + ',').padEnd(10)} ${p.flags}`.trimEnd()),
  ].join('\n');
  const sdk = [
    `CONFIG_ESPTOOLPY_FLASHSIZE_${Number(flash) || 4}MB=y`,
    'CONFIG_PARTITION_TABLE_CUSTOM=y',
    'CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="partitions.csv"',
    `CONFIG_PARTITION_TABLE_OFFSET=${hex(pt)}`,
    ...(coredump ? ['CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH=y'] : []),
    ...(nvsKeys ? ['CONFIG_NVS_ENCRYPTION=y'] : []),
  ].join('\n');

  const values = [
    { label: 'App slot size', value: human(appSize), hint: `${hex(appSize)} × ${slots.length} slot${slots.length > 1 ? 's' : ''}` },
    { label: 'Image fills its slot', value: `${Math.round(fill * 100)} %`, tone: fill > 1 ? 'bad' : fill > 0.9 ? 'warn' : 'ok' },
    { label: 'Filesystem', value: fsPart ? human(fsPart.size) : '–', hint: fsPart ? `${fsPart.sub} at ${hex(fsPart.offset)}` : 'none' },
    { label: 'Unused flash', value: free >= 0 ? human(free) : `${human(-free)} over`, tone: free < 0 ? 'bad' : undefined, hint: gaps ? `plus ${kib(gaps)} of alignment gaps` : '' },
    { label: 'Partitions end at', value: hex(end), hint: `flash ends at ${hex(FLASH)}` },
  ];
  const map = [
    { name: 'bootloader', offset: C.boot, size: pt - C.boot, kind: 'boot' },
    { name: 'partition table', offset: pt, size: SECTOR, kind: 'boot' },
    ...parts.map((p) => ({ name: p.name, offset: p.offset, size: p.size, kind: p.type === 'app' ? 'app' : p.sub === 'littlefs' || p.sub === 'spiffs' || p.sub === 'fat' ? 'fs' : 'data' })),
  ];
  return {
    values,
    warnings,
    tables: [{ title: 'Partitions', columns: ['Name', 'Type', 'SubType', 'Offset', 'Size', 'Size (KiB)', 'End'],
      rows: [
        ['(bootloader)', '', '', hex(C.boot), hex(pt - C.boot), (pt - C.boot) / KB, hex(pt)],
        ['(partition table)', '', '', hex(pt), '0xc00', 3, hex(pt + 0xC00)],
        ...parts.map((p) => [p.name, p.type, p.sub, hex(p.offset), hex(p.size), Math.round((p.size / KB) * 10) / 10, hex(p.offset + p.size)]),
      ] }],
    texts: [{ title: 'partitions.csv', body: csv + '\n', lang: 'csv' }, { title: 'sdkconfig', body: sdk + '\n' }],
    notes: [
      `The ${C.name} second-stage bootloader starts at ${hex(C.boot)} and must end before the table at ${hex(pt)}; move the table to 0x10000 if secure boot or a debug bootloader overflows it.`,
      'App slots are 64 KiB aligned and data partitions 4 KiB aligned, as the ESP-IDF partition tool requires; offsets are written out so the table does not depend on its automatic placement.',
      `Image size = the size of build/<project>.bin (idf.py size prints it); headroom ${h} % is added before rounding up to 64 KiB.`,
      ...notes2,
    ],
    map: { flash: FLASH, parts: map },
  };
}
