// Linker script helper: writes a GNU ld script for a Cortex-M part from its
// memory regions, stack/heap reservation and extra sections, in the layout
// STM32CubeIDE and most vendor startup files expect
// (_sidata/_sdata/_edata for .data copy, _sbss/_ebss for zeroing, _estack).
//
// GNU ld manual: §3.6 SECTIONS, §3.6.8.2 "AT> lma_region" (load in flash, run in RAM),
// §3.6.7 NOLOAD, §3.7 MEMORY. Stack alignment: 8 bytes at public interfaces
// (Arm AAPCS §6.2.1.2), so the stack top and the heap/stack block are 8-aligned.

const K = { '': 1, B: 1, K: 1024, KB: 1024, KIB: 1024, M: 1048576, MB: 1048576, MIB: 1048576 };
function parseSize(t) {
  const s = String(t ?? '').trim().toUpperCase().replace(/\s+/g, '');
  let m;
  if ((m = /^0X([0-9A-F]+)$/.exec(s))) return parseInt(m[1], 16);
  if ((m = /^(\d+)(|B|K|KB|KIB|M|MB|MIB)$/.exec(s))) return Number(m[1]) * K[m[2]];
  return null;
}
const hex = (v) => '0x' + v.toString(16).toUpperCase().padStart(8, '0');
const hexs = (v) => '0x' + v.toString(16).toUpperCase();
const lenText = (b) => (b % 1048576 === 0 ? `${b / 1048576}M` : b % 1024 === 0 ? `${b / 1024}K` : hexs(b));
const kb = (b) => (b >= 1024 ? `${(b / 1024).toFixed(b % 1024 ? 1 : 0)} KiB` : `${b} B`);
const ident = (n) => n.replace(/^\./, '').replace(/[^A-Za-z0-9_]/g, '_');

export function run({ regions: regIn, flash: flashName, ram: ramName, stack, heap, entry, extra, cpp }) {
  const warnings = [], notes = [];
  const regions = [];
  for (const [row, r] of (regIn || []).entries()) {
    const name = String(r.name ?? '').trim();
    if (!name) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { warnings.push(`Region name "${name}" is not a valid ld identifier: use letters, digits and _.`); continue; }
    const origin = parseSize(r.origin), length = parseSize(r.length);
    if (origin == null || !(length > 0)) { warnings.push(`Region ${name}: give the origin as 0x... and the length as 512K or 0x... . Row skipped.`); continue; }
    regions.push({ name, attr: String(r.attr || 'rwx').trim() || 'rwx', origin, length, row });
  }
  if (!regions.length) return { warnings: [...warnings, 'Add the memory regions: at least a flash and a RAM.'] };
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    const a = regions[i], b = regions[j];
    if (a.origin < b.origin + b.length && b.origin < a.origin + a.length) warnings.push(`Regions ${a.name} and ${b.name} overlap: ld will place sections on top of each other. Fix the origins or lengths.`);
  }
  const byName = (n) => regions.find((r) => r.name.toUpperCase() === String(n ?? '').trim().toUpperCase());
  const F = byName(flashName) || regions[0];
  const R = byName(ramName) || regions.find((r) => r !== F) || regions[0];
  if (!byName(flashName)) warnings.push(`No region called "${flashName}": using ${F.name} for code.`);
  if (!byName(ramName)) warnings.push(`No region called "${ramName}": using ${R.name} for data and stack.`);
  if (F === R) warnings.push('Code and data are in the same region: fine for a RAM-only build, otherwise pick separate flash and RAM regions.');
  if (!/x/i.test(F.attr)) warnings.push(`${F.name} is not marked executable (x): ld will warn or misplace .text. Give it (rx).`);
  const st = parseSize(stack), hp = parseSize(heap);
  if (st == null || hp == null) return { warnings: [...warnings, 'Give the stack and heap sizes as bytes, 0x400 or 1K.'] };
  if (st % 8) warnings.push(`A stack of ${st} bytes is not a multiple of 8; the script rounds the block to 8 (AAPCS stack alignment).`);
  if (st < 512) warnings.push(`${st} bytes of stack is very little for C with interrupts; start from 1-2 KiB and measure (see Stack Usage Estimator).`);
  if (F.origin % 512) warnings.push(`${F.name} starts at ${hex(F.origin)}: the vector table lands there and VTOR needs it aligned to the table size rounded up to a power of two (512 bytes covers up to 128 vectors). Align the origin.`);
  if (F.origin !== 0 && F.origin !== 0x08000000) notes.push(`Code starts at ${hex(F.origin)}, not at the boot address: the bootloader (or SystemInit) must set SCB->VTOR = ${hex(F.origin)} before enabling interrupts.`);
  const estack = R.origin + R.length;
  if (estack % 8) warnings.push(`The stack top ${hex(estack)} is not 8-byte aligned: shorten ${R.name} so ORIGIN + LENGTH is a multiple of 8.`);
  const reserve = Math.ceil(st / 8) * 8 + Math.ceil(hp / 8) * 8;
  if (reserve > R.length) warnings.push(`Stack + heap (${kb(reserve)}) do not fit ${R.name} (${kb(R.length)}): the link will fail. Shrink them.`);
  else if (reserve > R.length * 0.75) warnings.push(`Stack + heap take ${Math.round((reserve / R.length) * 100)} % of ${R.name}, leaving ${kb(R.length - reserve)} for .data and .bss.`);

  const ex = [];
  for (const [row, e] of (extra || []).entries()) {
    const name = String(e.name ?? '').trim();
    if (!name) continue;
    const reg = byName(e.region);
    if (!reg) { warnings.push(`Section ${name}: no region "${e.region}". Add the region or fix its name.`); continue; }
    const sec = name.startsWith('.') ? name : `.${name}`;
    ex.push({ sec, id: ident(sec), reg, kind: e.kind || 'zero', row });
  }

  const W = Math.max(...regions.map((r) => r.name.length));
  const L = [];
  L.push('/* Generated by the Redline Linker Script Helper.', ' * Check it against your startup file: it expects _sidata/_sdata/_edata,', ' * _sbss/_ebss and _estack (the STM32Cube / CMSIS GCC convention). */', '');
  L.push(`ENTRY(${String(entry || 'Reset_Handler').trim() || 'Reset_Handler'})`, '');
  L.push(`_estack = ORIGIN(${R.name}) + LENGTH(${R.name});    /* ${hex(estack)}: top of the stack */`);
  L.push(`_Min_Heap_Size = ${hexs(hp)};    /* ${hp} bytes */`, `_Min_Stack_Size = ${hexs(st)};   /* ${st} bytes */`, '');
  L.push('MEMORY', '{');
  for (const r of regions) L.push(`  ${r.name.padEnd(W)} (${r.attr.padEnd(3)}) : ORIGIN = ${hex(r.origin)}, LENGTH = ${lenText(r.length)}`);
  L.push('}', '', 'SECTIONS', '{');
  const blk = (head, body, tail) => { L.push(`  ${head}`, '  {', ...body.map((b) => `    ${b}`), `  } ${tail}`, ''); };
  blk('.isr_vector :', ['. = ALIGN(4);', 'KEEP(*(.isr_vector))    /* the vector table first */', '. = ALIGN(4);'], `>${F.name}`);
  blk('.text :', ['. = ALIGN(4);', '*(.text)', '*(.text*)', '*(.glue_7)', '*(.glue_7t)', '*(.eh_frame)', 'KEEP (*(.init))', 'KEEP (*(.fini))', '. = ALIGN(4);', '_etext = .;'], `>${F.name}`);
  blk('.rodata :', ['. = ALIGN(4);', '*(.rodata)', '*(.rodata*)', '. = ALIGN(4);'], `>${F.name}`);
  if (cpp) {
    blk('.ARM.extab :', ['*(.ARM.extab* .gnu.linkonce.armextab.*)'], `>${F.name}`);
    blk('.ARM :', ['__exidx_start = .;', '*(.ARM.exidx*)', '__exidx_end = .;'], `>${F.name}`);
    blk('.preinit_array :', ['PROVIDE_HIDDEN (__preinit_array_start = .);', 'KEEP (*(.preinit_array*))', 'PROVIDE_HIDDEN (__preinit_array_end = .);'], `>${F.name}`);
    blk('.init_array :', ['PROVIDE_HIDDEN (__init_array_start = .);', 'KEEP (*(SORT(.init_array.*)))', 'KEEP (*(.init_array*))', 'PROVIDE_HIDDEN (__init_array_end = .);'], `>${F.name}`);
    blk('.fini_array :', ['PROVIDE_HIDDEN (__fini_array_start = .);', 'KEEP (*(SORT(.fini_array.*)))', 'KEEP (*(.fini_array*))', 'PROVIDE_HIDDEN (__fini_array_end = .);'], `>${F.name}`);
  }
  for (const e of ex.filter((x) => x.kind === 'rom')) blk(`${e.sec} :`, ['. = ALIGN(4);', `KEEP(*(${e.sec}))`, `KEEP(*(${e.sec}*))`, '. = ALIGN(4);'], `>${e.reg.name}`);
  L.push('  /* initialised data: runs in RAM, its initial values are stored in flash */', `  _sidata = LOADADDR(.data);`, '');
  blk('.data :', ['. = ALIGN(4);', '_sdata = .;', '*(.data)', '*(.data*)', '*(.RamFunc)        /* functions placed in RAM */', '*(.RamFunc*)', '. = ALIGN(4);', '_edata = .;'], `>${R.name} AT> ${F.name}`);
  for (const e of ex.filter((x) => x.kind === 'init')) {
    L.push(`  _si${e.id} = LOADADDR(${e.sec});`, '');
    blk(`${e.sec} :`, ['. = ALIGN(4);', `_s${e.id} = .;`, `*(${e.sec})`, `*(${e.sec}*)`, '. = ALIGN(4);', `_e${e.id} = .;`], `>${e.reg.name} AT> ${F.name}`);
  }
  L.push('  . = ALIGN(4);');
  blk('.bss :', ['_sbss = .;', '__bss_start__ = _sbss;', '*(.bss)', '*(.bss*)', '*(COMMON)', '. = ALIGN(4);', '_ebss = .;', '__bss_end__ = _ebss;'], `>${R.name}`);
  for (const e of ex.filter((x) => x.kind === 'zero' || x.kind === 'noload')) {
    blk(`${e.sec} (NOLOAD) :`, ['. = ALIGN(4);', `_s${e.id} = .;`, `*(${e.sec})`, `*(${e.sec}*)`, '. = ALIGN(4);', `_e${e.id} = .;`], `>${e.reg.name}`);
  }
  blk('._user_heap_stack :', ['. = ALIGN(8);', 'PROVIDE ( end = . );     /* _sbrk() starts the heap here */', 'PROVIDE ( _end = . );', '. = . + _Min_Heap_Size;', '. = . + _Min_Stack_Size;', '. = ALIGN(8);'], `>${R.name}`);
  L.push('  .ARM.attributes 0 : { *(.ARM.attributes) }', '}');

  // start-up additions for the extra sections
  const C = [];
  const inits = ex.filter((x) => x.kind === 'init'), zeros = ex.filter((x) => x.kind === 'zero');
  if (inits.length || zeros.length) {
    C.push('/* Add to Reset_Handler (or SystemInit) before main(): the standard startup only handles .data and .bss. */', '#include <stdint.h>', '#include <string.h>');
    for (const e of inits) C.push(`extern uint32_t _si${e.id}, _s${e.id}, _e${e.id};`);
    for (const e of zeros) C.push(`extern uint32_t _s${e.id}, _e${e.id};`);
    C.push('', 'static void init_extra_sections(void)', '{');
    for (const e of inits) C.push(`  memcpy(&_s${e.id}, &_si${e.id}, (uint32_t)&_e${e.id} - (uint32_t)&_s${e.id});   /* ${e.sec} */`);
    for (const e of zeros) C.push(`  memset(&_s${e.id}, 0, (uint32_t)&_e${e.id} - (uint32_t)&_s${e.id});            /* ${e.sec} */`);
    C.push('}', '', '/* place variables with: __attribute__((section(".name"))) */');
  }
  if (ex.some((x) => x.kind === 'noload')) notes.push('NOLOAD sections are neither copied nor zeroed: their contents survive a reset (useful for a crash log or boot flags) and start as garbage after power-up.');
  notes.push(`Stack and heap are a reservation check: ._user_heap_stack makes the link fail if ${kb(reserve)} does not fit after .data and .bss; the stack itself grows down from _estack.`);

  // The map the page draws: regions by address, what each one holds in
  // link order, and the stack/heap reservation (runtime picture: the heap
  // grows up after .bss, the stack down from _estack).
  const overlapsOf = (a) => regions.filter((b) => b !== a && a.origin < b.origin + b.length && b.origin < a.origin + a.length).map((b) => b.name);
  const holds = (r) => {
    const out = [];
    if (r === F) {
      out.push({ name: '.isr_vector', what: 'vectors' }, { name: '.text', what: 'code' }, { name: '.rodata', what: 'const' });
      if (cpp) out.push({ name: '.ARM.exidx, .init_array', what: 'cpp' });
      for (const e of ex.filter((x) => x.kind === 'rom' && x.reg === F)) out.push({ name: e.sec, what: 'extra', kind: e.kind, row: e.row });
      out.push({ name: '.data', what: 'image', of: R.name, symbol: '_sidata' });
      for (const e of ex.filter((x) => x.kind === 'init')) out.push({ name: e.sec, what: 'image', of: e.reg.name, symbol: `_si${e.id}`, row: e.row, kind: 'init' });
    }
    if (r === R) out.push({ name: '.data', what: 'data', symbol: '_sdata', from: F.name }, { name: '.bss', what: 'bss', symbol: '_sbss' });
    for (const e of ex.filter((x) => x.reg === r && !(x.kind === 'rom' && r === F))) {
      out.push({ name: e.sec, what: 'extra', kind: e.kind, row: e.row, symbol: `_s${e.id}`, from: e.kind === 'init' ? F.name : null });
    }
    return out;
  };
  const map = {
    code: F.name, data: R.name, estack, estackAligned: estack % 8 === 0, stack: st, heap: hp,
    stackBlock: Math.ceil(st / 8) * 8, heapBlock: Math.ceil(hp / 8) * 8, stackLimitHex: hex(Math.max(0, estack - Math.ceil(st / 8) * 8)), reserve, free: R.length - reserve, fits: reserve <= R.length, share: reserve / R.length,
    regions: [...regions].sort((a, b) => a.origin - b.origin).map((r) => ({
      name: r.name, attr: r.attr, origin: r.origin, length: r.length, end: r.origin + r.length, row: r.row,
      originHex: hex(r.origin), endHex: hex(r.origin + r.length), lengthText: lenText(r.length), size: kb(r.length),
      role: r === F && r === R ? 'both' : r === F ? 'code' : r === R ? 'data' : 'other', exec: /x/i.test(r.attr),
      vtorBad: r === F && r.origin % 512 !== 0, overlaps: overlapsOf(r), holds: holds(r),
    })),
  };

  return {
    map,
    values: [
      { label: '_estack', value: hex(estack), hint: `top of ${R.name}` },
      { label: 'Code region', value: F.name, hint: `${hex(F.origin)}, ${kb(F.length)}` },
      { label: 'Data region', value: R.name, hint: `${hex(R.origin)}, ${kb(R.length)}` },
      { label: 'Stack + heap reserved', value: kb(reserve), tone: reserve > R.length ? 'bad' : reserve > R.length * 0.75 ? 'warn' : 'ok', hint: `${Math.round((reserve / R.length) * 100)} % of ${R.name}` },
    ],
    tables: [{ title: 'Section placement', columns: ['Section', 'Runs in', 'Stored in', 'Start-up'], rows: [
      ['.isr_vector, .text, .rodata', F.name, F.name, '–'],
      ...(cpp ? [['.ARM.exidx, .init_array ...', F.name, F.name, '__libc_init_array()']] : []),
      ['.data', R.name, F.name, 'copied (_sidata -> _sdata.._edata)'],
      ['.bss', R.name, '–', 'zeroed (_sbss.._ebss)'],
      ...ex.map((e) => [e.sec, e.reg.name, e.kind === 'init' ? F.name : e.kind === 'rom' ? e.reg.name : '–', { init: 'copied: add the loop below', zero: 'zeroed: add the loop below', noload: 'left as is', rom: '–' }[e.kind]]),
      ['._user_heap_stack', R.name, '–', 'reserved only'],
    ] }],
    texts: [{ title: 'Linker script', lang: 'ld', body: L.join('\n') + '\n' }, ...(C.length ? [{ title: 'Start-up C', lang: 'c', body: C.join('\n') + '\n' }] : [])],
    warnings, notes,
  };
}
