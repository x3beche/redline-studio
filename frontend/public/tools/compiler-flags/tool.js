// Compiler flag explainer: finds the GCC/Clang flags in a pasted build log
// and says what each does to code size and speed. Effects are qualitative
// (they depend on the code); they follow the GCC manual ("Optimize Options",
// "Code Gen Options", "ARM Options", "Link Options"), the newlib-nano
// README and the Clang command-line reference.
// Size/speed columns: -- much smaller/slower, - smaller/slower, 0 none, + larger/faster, ++ much larger/faster.

const O = {
  '-O0': { size: '++', speed: '--', what: 'No optimisation (the default). Largest, slowest code; every variable lives in memory, so debugging is exact.' },
  '-O': { alias: '-O1' },
  '-O1': { size: '0', speed: '+', what: 'Basic optimisations without the costly ones: much smaller and faster than -O0.' },
  '-O2': { size: '0', speed: '++', what: 'Nearly all optimisations that do not trade size for speed. The usual release level for speed.' },
  '-O3': { size: '++', speed: '++', what: '-O2 plus aggressive inlining, loop unrolling and vectorisation. Often larger with little gain on an MCU; measure.' },
  '-Os': { size: '--', speed: '+', what: '-O2 without the optimisations that grow code. The usual choice for flash-limited MCUs.' },
  '-Oz': { size: '--', speed: '0', what: 'Smaller still than -Os (Clang; GCC 12+): prefers short instruction sequences even when slower.' },
  '-Og': { size: '+', speed: '0', what: 'Optimise what does not hurt debugging. Recommended for debug builds instead of -O0.' },
  '-Ofast': { size: '++', speed: '++', what: '-O3 plus -ffast-math: breaks IEEE float rules (NaN, infinities, rounding). Deprecated in GCC 14/Clang 18.' },
};
const FLAGS = [
  // [pattern, category, size, speed, what]
  [/^-flto(=.*)?$/, 'link', '-', '+', 'Link-time optimisation: inlines and removes code across files. Must be on the compile AND the link command, with the same compiler.'],
  [/^-fno-lto$/, 'link', '0', '0', 'Turns link-time optimisation off.'],
  [/^-ffunction-sections$/, 'size', '-', '0', 'Each function in its own section, so --gc-sections can drop unused ones. Does nothing without -Wl,--gc-sections.'],
  [/^-fdata-sections$/, 'size', '-', '0', 'Each variable in its own section, so --gc-sections can drop unused ones.'],
  [/^-Wl,--gc-sections$/, 'link', '--', '0', 'The linker drops sections nothing refers to. Needs -ffunction-sections -fdata-sections to be effective.'],
  [/^--gc-sections$/, 'link', '--', '0', 'The linker drops sections nothing refers to.'],
  [/^--specs=nano\.specs$/, 'libc', '--', '-', 'Links newlib-nano: much smaller printf/scanf/malloc; no float printf unless -u _printf_float.'],
  [/^--specs=nosys\.specs$/, 'libc', '0', '0', 'Stub system calls (_write, _sbrk...) that do nothing: links without an OS.'],
  [/^--specs=rdimon\.specs$/, 'libc', '+', '-', 'Semihosting: printf goes to the debugger. Halts the CPU without a debugger attached.'],
  [/^-u ?_?_printf_float$/, 'libc', '+', '0', 'Pulls float support into newlib-nano printf (several KB of flash).'],
  [/^-u ?_?_scanf_float$/, 'libc', '+', '0', 'Pulls float support into newlib-nano scanf.'],
  [/^-lprintf_flt$/, 'libc', '+', '0', 'avr-libc: the float-capable printf (about 1.5 KB more than the default).'],
  [/^-lprintf_min$/, 'libc', '-', '0', 'avr-libc: the minimal printf (no width, no float).'],
  [/^-g(gdb|dwarf(-\d)?|[0-3])?$/, 'debug', '0', '0', 'Debug information. Only in the ELF\'s debug sections: nothing more in flash, no slower code.'],
  [/^-g0$/, 'debug', '0', '0', 'No debug information.'],
  [/^-fno-exceptions$/, 'c++', '-', '+', 'C++ without exceptions: no unwind tables or exception runtime.'],
  [/^-fno-rtti$/, 'c++', '-', '0', 'C++ without run-time type information (no dynamic_cast/typeid).'],
  [/^-fno-threadsafe-statics$/, 'c++', '-', '+', 'No guard locks around function-local statics (safe only if they are not first used from two threads).'],
  [/^-fno-use-cxa-atexit$/, 'c++', '-', '0', 'Static destructors are not registered at run time.'],
  [/^-fno-unwind-tables$|^-fno-asynchronous-unwind-tables$/, 'size', '-', '0', 'No stack unwind tables (.ARM.exidx / .eh_frame).'],
  [/^-funroll(-all)?-loops$/, 'speed', '+', '+', 'Unrolls loops: fewer branches, more code.'],
  [/^-finline-functions$|^-finline-limit=.*$|^-finline-small-functions$/, 'speed', '+', '+', 'More inlining: fewer calls, more code.'],
  [/^-fno-inline(-functions|-small-functions|-functions-called-once)?$/, 'size', '-', '-', 'Less inlining: smaller, slower, easier to step through.'],
  [/^-fomit-frame-pointer$/, 'speed', '-', '+', 'Frees the frame pointer register (default at -O1 and up on most targets).'],
  [/^-fno-omit-frame-pointer$/, 'debug', '+', '-', 'Keeps a frame pointer for stack traces and profilers.'],
  [/^-fstack-protector(-strong|-all|-explicit)?$/, 'safety', '+', '-', 'Stack canaries: detects stack buffer overflows at function return; needs __stack_chk_guard/__stack_chk_fail.'],
  [/^-fno-stack-protector$/, 'safety', '0', '0', 'No stack canaries.'],
  [/^-fsanitize=.*$/, 'debug', '++', '--', 'Run-time sanitiser instrumentation: host builds only, far too big for most MCUs.'],
  [/^-pg$|^--coverage$|^-fprofile-arcs$|^-ftest-coverage$|^-finstrument-functions$|^-fprofile-generate.*$/, 'debug', '++', '-', 'Profiling/coverage instrumentation: counters on every branch or call.'],
  [/^-ffast-math$/, 'float', '0', '+', 'Float arithmetic without strict IEEE rules: faster, but NaN/inf checks and exact rounding break.'],
  [/^-fsingle-precision-constant$/, 'float', '-', '+', 'Unsuffixed float constants become float, not double: avoids slow double maths on single-precision FPUs.'],
  [/^-fno-math-errno$/, 'float', '-', '+', 'sqrt() and friends need not set errno: can use the FPU instruction directly.'],
  [/^-mthumb$/, 'target', '-', '0', 'Thumb/Thumb-2 instructions (the only set on Cortex-M): about 30 % smaller than ARM mode.'],
  [/^-marm$/, 'target', '+', '+', 'ARM (32-bit) instruction set: larger code (Cortex-A/R only).'],
  [/^-mcpu=.*$|^-march=.*$|^-mtune=.*$/, 'target', '0', '+', 'The core to generate code for: the right one enables its instructions (DSP, divide, FPU).'],
  [/^-mfpu=.*$/, 'target', '-', '++', 'The floating-point unit to use (fpv4-sp-d16 = Cortex-M4F, fpv5-d16 = M7).'],
  [/^-mfloat-abi=hard$/, 'target', '-', '++', 'Float in FPU registers and instructions: fastest; all linked objects must use it.'],
  [/^-mfloat-abi=softfp$/, 'target', '0', '+', 'FPU instructions, but floats passed in integer registers (link-compatible with soft).'],
  [/^-mfloat-abi=soft$/, 'target', '+', '--', 'All float maths in software: slow and larger; the FPU sits idle.'],
  [/^-mslow-flash-data$/, 'target', '+', '0', 'Avoids literal pools in flash (for flash that is slow to read data from).'],
  [/^-mno-unaligned-access$/, 'target', '+', '-', 'Byte-wise access for possibly unaligned data: needed where unaligned access faults (Cortex-M0, device memory).'],
  [/^-munaligned-access$/, 'target', '-', '+', 'Allows unaligned word loads where the core supports them.'],
  [/^-mcall-prologues$/, 'size', '-', '-', 'AVR: shared prologue/epilogue subroutines.'],
  [/^-mrelax$|^-Wl,--relax$/, 'link', '-', '+', 'Linker relaxation: shorter call/jump sequences (AVR, RISC-V).'],
  [/^-msave-restore$/, 'size', '-', '-', 'RISC-V: register save/restore through library routines.'],
  [/^-mno-relax$/, 'link', '+', '0', 'No linker relaxation.'],
  [/^-fshort-enums$/, 'size', '0', '0', 'Enums as small as their values allow: less RAM, but an ABI change - every object and library must agree.'],
  [/^-fshort-wchar$/, 'abi', '0', '0', 'wchar_t is 16-bit: an ABI change.'],
  [/^-fno-common$/, 'c', '0', '0', 'Tentative definitions are real definitions (default since GCC 10): duplicate globals become link errors.'],
  [/^-fcommon$/, 'c', '0', '0', 'Old behaviour: duplicate tentative globals are merged silently.'],
  [/^-f(pic|PIC|pie|PIE)$/, 'target', '+', '-', 'Position-independent code: accesses go through a GOT. Only for relocatable firmware or shared objects.'],
  [/^-fno-(pic|PIC|pie|PIE)$|^-no-pie$/, 'target', '0', '0', 'Position-dependent code (the normal case for firmware).'],
  [/^-fno-builtin(-.*)?$/, 'c', '+', '-', 'memcpy/strlen/etc. are always called, never inlined or folded by the compiler.'],
  [/^-ffreestanding$/, 'c', '+', '-', 'No hosted C library assumed (implies -fno-builtin): for kernels and bootloaders.'],
  [/^-nostdlib$|^-nostartfiles$|^-nodefaultlibs$/, 'link', '-', '0', 'Leaves out the standard startup files or libraries: you provide them.'],
  [/^-fno-strict-aliasing$/, 'c', '0', '-', 'Allows type-punning through pointers; blocks some optimisations.'],
  [/^-fstrict-aliasing$/, 'c', '0', '+', 'Assumes pointers of different types do not alias (default at -O2).'],
  [/^-fwrapv$/, 'c', '0', '-', 'Signed overflow wraps around instead of being undefined.'],
  [/^-fno-delete-null-pointer-checks$/, 'c', '0', '0', 'Keeps null checks the optimiser could remove; needed where address 0 is valid memory.'],
  [/^-fstack-usage$/, 'report', '0', '0', 'Writes a .su file with each function\'s stack use.'],
  [/^-Wl,-Map(=|,).*$|^-Wl,--print-memory-usage$|^-Wl,--cref$/, 'report', '0', '0', 'Linker report (map file / memory usage): no effect on code.'],
  [/^-DNDEBUG$/, 'size', '-', '+', 'Compiles assert() out.'],
  [/^-fmerge-all-constants$/, 'size', '-', '0', 'Merges identical constants and arrays.'],
  [/^-fno-jump-tables$/, 'target', '0', '-', 'switch statements without jump tables (for XIP or security reasons).'],
  [/^-fconserve-stack$/, 'size', '0', '-', 'Less stack use, at some speed cost.'],
  [/^-fwhole-program$/, 'link', '-', '+', 'Assumes this compile unit is the whole program (older alternative to -flto).'],
  [/^-fvisibility=hidden$/, 'link', '-', '+', 'Symbols hidden by default (shared libraries).'],
  [/^-s$|^-Wl,(-s|--strip-all)$/, 'debug', '0', '0', 'Strips symbols from the ELF: nothing changes in flash.'],
  [/^-fno-move-loop-invariants$/, 'size', '-', '-', 'Keeps loop-invariant code in the loop (smaller at -Os on some targets).'],
  [/^-fipa-pta$|^-fipa-.*$|^-fgcse.*$|^-ftree-.*$|^-fno-tree-.*$/, 'optimise', '?', '?', 'A single optimisation pass switch: fine tuning, the -O level already sets it.'],
  [/^-std=.*$|^-ansi$/, 'language', '0', '0', 'Language standard.'],
  [/^-pedantic(-errors)?$|^-W(?!l,|a,|p,).*$|^-w$/, 'warning', '0', '0', 'Warning option: no effect on the code generated.'],
  [/^-fdiagnostics-.*$|^-fmessage-length=.*$|^-fno-diagnostics-.*$/, 'warning', '0', '0', 'Diagnostic formatting only.'],
  [/^-fmacro-prefix-map=.*$|^-ffile-prefix-map=.*$|^-fdebug-prefix-map=.*$/, 'report', '0', '0', 'Rewrites paths in __FILE__/debug info (reproducible builds): no size effect unless __FILE__ strings get shorter.'],
  [/^-fno-ident$/, 'size', '0', '0', 'Leaves the compiler version string out of the object (not in flash anyway on most targets).'],
];
// Not flags that change code: file, include, define, output switches.
const IGNORE = /^-(I|isystem|iquote|include|o|c|S|E|M[MDFTGP]?|MMD|MF|MT|L|l(?!printf)|x|D(?!NDEBUG$)|U|T|B|v|pipe|save-temps|specs=(?!nano|nosys|rdimon)|Wa,|Xlinker|Xassembler|fdiagnostics|fno-diagnostics)/;

function tokenize(line) {
  const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function explain(flag) {
  if (O[flag]) { const o = O[flag].alias ? O[O[flag].alias] : O[flag]; return { cat: 'optimise', ...o }; }
  for (const [re, cat, size, speed, what] of FLAGS) if (re.test(flag)) return { cat, size, speed, what };
  return null;
}
const WORD = { '--': 'much smaller', '-': 'smaller', '0': 'none', '+': 'larger', '++': 'much larger', '?': 'depends' };
const SWORD = { '--': 'much slower', '-': 'slower', '0': 'none', '+': 'faster', '++': 'much faster', '?': 'depends' };

// The same reading as run()'s loop, keeping where each flag sits in the line,
// for the page's drawing of the log (and for editing a flag out of it).
function scanLine(raw) {
  const toks = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(raw))) toks.push({ text: m[1] ?? m[2] ?? m[3], start: m.index, end: m.index + m[0].length });
  const pieces = [];
  toks.forEach((t, ti) => {
    if (t.text.startsWith('-Wl,') && !/^-Wl,-Map,/.test(t.text)) {
      const parts = t.text.slice(4).split(',').filter(Boolean);
      parts.forEach((x, k) => pieces.push({ t: x.startsWith('-') ? '-Wl,' + x : x, ref: [ti, k] }));
    } else pieces.push({ t: t.text, ref: [ti, null] });
  });
  const items = [];
  for (let i = 0; i < pieces.length; i++) {
    let t = pieces[i].t; const refs = [pieces[i].ref];
    if ((t === '-u' || t === '-Wl,-u') && pieces[i + 1]) { t = `-u ${pieces[i + 1].t}`; refs.push(pieces[++i].ref); }
    else if (/^-u_/.test(t)) t = `-u ${t.slice(2)}`;
    if (t === '--specs' && pieces[i + 1]) { t = `--specs=${pieces[i + 1].t}`; refs.push(pieces[++i].ref); }
    items.push({ t, refs, flag: /^-/.test(t) && t !== '-' && t !== '--' });
  }
  return { toks, items };
}

export function run({ log, goal }) {
  const text = String(log || '');
  if (!text.trim()) return { warnings: ['Paste a build log, a compile command, or CFLAGS/LDFLAGS lines.'] };
  const flags = new Map();          // flag -> {count, lines:Set}
  const unknown = new Map();
  const perLineO = [];
  let lines = 0;
  const isArm = /arm-none-eabi|-mcpu=cortex|-mthumb/.test(text);
  const isAvr = /avr-gcc|-mmcu=at/.test(text);
  text.split(/\r?\n/).forEach((raw, li) => {
    const toks = tokenize(raw).flatMap((t) => (t.startsWith('-Wl,') && !/^-Wl,-Map,/.test(t) ? t.slice(4).split(',').filter(Boolean).map((x) => (x.startsWith('-') ? '-Wl,' + x : x)) : [t]));
    let lastO = null, any = false;
    for (let i = 0; i < toks.length; i++) {
      let t = toks[i];
      if ((t === '-u' || t === '-Wl,-u') && toks[i + 1]) t = `-u ${toks[++i]}`;
      else if (/^-u_/.test(t)) t = `-u ${t.slice(2)}`;
      if (t === '--specs' && toks[i + 1]) t = `--specs=${toks[++i]}`;
      if (!/^-/.test(t) || t === '-' || t === '--') continue;
      if (/^-O/.test(t)) lastO = t;
      const e = explain(t);
      if (e) {
        any = true;
        if (!flags.has(t)) flags.set(t, { count: 0, lines: new Set(), ...e });
        const f = flags.get(t); f.count++; f.lines.add(li);
      } else if (!IGNORE.test(t) && t.length < 80) {
        if (!unknown.has(t)) unknown.set(t, 0);
        unknown.set(t, unknown.get(t) + 1);
      }
    }
    if (any) lines++;
    if (lastO) perLineO.push(lastO);
  });
  if (!flags.size && !unknown.size) return { warnings: ['No compiler flags found: paste the compile commands (make V=1, ninja -v, or CMake compile_commands.json).'] };

  const has = (re) => [...flags.keys()].some((k) => re.test(k));
  const oCount = {};
  for (const o of perLineO) oCount[o] = (oCount[o] || 0) + 1;
  const oLevels = Object.keys(oCount);
  const mainO = oLevels.sort((a, b) => oCount[b] - oCount[a])[0] || '-O0 (none given)';
  const warnings = [], notes = [];
  if (oLevels.length > 1) warnings.push(`Different optimisation levels in one build: ${oLevels.map((o) => `${o} ×${oCount[o]}`).join(', ')}. Usually one file got stale flags; check it is intended (the last -O on a command line wins).`);
  if (!oLevels.length) warnings.push('No -O flag: GCC then compiles at -O0, the largest and slowest code. Add -Os (size), -O2 (speed) or -Og (debug).');
  const goalO = { size: ['-Os', '-Oz'], speed: ['-O2', '-O3'], debug: ['-Og', '-O0'] }[goal] || ['-Os'];
  if (oLevels.length && !goalO.includes(mainO)) warnings.push(`The build mostly uses ${mainO}; for ${goal} use ${goalO[0]}${goal === 'size' ? ' (or -Oz with Clang/GCC 12+)' : ''}.`);
  if ((has(/^-ffunction-sections$/) || has(/^-fdata-sections$/)) && !has(/gc-sections/)) warnings.push('-ffunction-sections/-fdata-sections without -Wl,--gc-sections: unused code is not removed, and alignment padding can make it larger. Add -Wl,--gc-sections to the link.');
  if (has(/gc-sections/) && !has(/^-ffunction-sections$/)) warnings.push('--gc-sections without -ffunction-sections -fdata-sections can only drop whole object files: add both to the compile flags.');
  if (has(/^-Ofast$/) || has(/^-ffast-math$/)) warnings.push('-ffast-math/-Ofast breaks IEEE float semantics: isnan() may always be false and results change. Use it only if no code depends on NaN/inf or exact rounding.');
  if (has(/^-O3$/) && goal === 'size') warnings.push('-O3 grows code (inlining, unrolling, vectorising): wrong for a size-limited build.');
  if (has(/^-mfloat-abi=soft$/) && has(/^-mfpu=/)) warnings.push('-mfloat-abi=soft with -mfpu: the FPU is not used at all. Use -mfloat-abi=hard (or softfp) to use it.');
  if (has(/^-mfloat-abi=hard$/) && has(/^-mfloat-abi=soft(fp)?$/)) warnings.push('Mixed float ABIs in one build: hard and soft objects will not link together. Use one everywhere.');
  if (has(/^-u ?_?_printf_float$/) && !has(/nano\.specs/)) notes.push('-u _printf_float only matters with newlib-nano; full newlib already has float printf.');
  if (has(/^-fsanitize=/) && (isArm || isAvr)) warnings.push('Sanitisers on an MCU build: they need a runtime most embedded targets do not have. Use them in host unit tests.');
  if (has(/^-flto/)) notes.push('-flto: put it on the link command too (and use gcc-ar/gcc-nm for static libraries), or the objects are linked without LTO.');
  if (has(/^-g/)) notes.push('-g only adds debug sections to the ELF: the .bin/.hex and the flash use are unchanged. Keep it on release builds for post-mortem debugging.');

  const rec = {
    size: ['-Os', '-ffunction-sections', '-fdata-sections', '-Wl,--gc-sections', '-flto', ...(isArm ? ['--specs=nano.specs', '-mthumb'] : []), '-fno-exceptions', '-fno-rtti', '-DNDEBUG'],
    speed: ['-O2', '-flto', ...(isArm ? ['-mcpu=<your core>', '-mfloat-abi=hard', '-mfpu=<your FPU>'] : []), '-ffunction-sections', '-fdata-sections', '-Wl,--gc-sections', '-DNDEBUG'],
    debug: ['-Og', '-g3', '-ffunction-sections', '-fdata-sections', '-Wl,--gc-sections', '-fstack-usage'],
  }[goal] || [];
  const missing = rec.filter((r) => {
    if (r.includes('<')) return !has(new RegExp('^' + r.split('=')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '='));
    if (/^-f(no-exceptions|no-rtti)$/.test(r) && !/\b(g\+\+|c\+\+|clang\+\+)\b|\.cpp\b|\.cc\b/.test(text)) return false;
    if (r === '-Os') return !has(/^-O[sz]$/);
    if (r === '-O2') return !has(/^-O[23]$/);
    if (r === '-Og') return !has(/^-O[g0]$/);
    if (r === '-g3') return !has(/^-g/);
    return !has(new RegExp('^' + r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
  });
  // net effect: -O level plus the rest
  const netSize = { '-O0': 'large', '-Og': 'medium', '-O1': 'medium', '-O2': 'medium', '-O3': 'large', '-Os': 'small', '-Oz': 'smallest', '-Ofast': 'large' }[mainO] || 'large (no -O)';
  const rows = [...flags.entries()]
    .sort((a, b) => (a[1].cat === 'optimise' ? -1 : 0) - (b[1].cat === 'optimise' ? -1 : 0) || (a[1].cat === 'warning') - (b[1].cat === 'warning'))
    .filter(([, f]) => f.cat !== 'warning')
    .map(([k, f]) => [k, f.count, f.cat, WORD[f.size], SWORD[f.speed], f.what]);
  const warnFlags = [...flags.entries()].filter(([, f]) => f.cat === 'warning').map(([k]) => k);
  const values = [
    { label: 'Optimisation level', value: mainO, tone: goalO.includes(mainO) ? 'ok' : 'warn', hint: oLevels.length > 1 ? 'mixed in this build' : `goal: ${goal}` },
    { label: 'Code size tendency', value: netSize },
    { label: 'Command lines read', value: lines },
    { label: 'Flags explained', value: flags.size - warnFlags.length, hint: warnFlags.length ? `+ ${warnFlags.length} warning flags` : null },
    { label: 'Not recognised', value: unknown.size, tone: unknown.size ? 'warn' : 'ok' },
    { label: `Missing for ${goal}`, value: missing.length, tone: missing.length ? 'warn' : 'ok' },
  ];
  const tables = [{ title: 'Flags that change the code', columns: ['Flag', 'Times', 'Kind', 'Size', 'Speed', 'What it does'], rows }];
  if (missing.length) tables.push({ title: `Worth adding for a ${goal} build`, columns: ['Flag', 'Why'], rows: missing.map((m) => [m, (explain(m.replace(/=<.*>$/, '=x')) || {}).what || '']) });
  if (unknown.size) notes.push(`Not in the table (look them up in the GCC manual): ${[...unknown.keys()].slice(0, 25).join(' ')}${unknown.size > 25 ? ' …' : ''}.`);
  if (warnFlags.length) notes.push(`Warning flags (no code effect): ${warnFlags.slice(0, 20).join(' ')}${warnFlags.length > 20 ? ' …' : ''}.`);
  notes.push('Size and speed effects are the usual direction, not a promise: measure with arm-none-eabi-size (or -Wl,--print-memory-usage) and a timer.');
  const risky = (k) => /^-ffast-math$|^-fsanitize|^-pg$|^--coverage$|^-fprofile/.test(k) || (k === '-mfloat-abi=soft' && has(/^-mfpu=/)) || (goal !== 'debug' && k === '-O0');
  const sugg = [...new Set([...[...flags.keys()].filter((k) => !/^-O/.test(k) && !['warning', 'report'].includes(flags.get(k).cat) && !risky(k)), ...missing.filter((m) => !m.includes('<'))])];
  const body = `# ${goal} build: optimisation and the code-changing flags worth keeping or adding (fast-math, sanitisers and conflicting ABIs left out)\n${goalO.includes(mainO) ? mainO : goalO[0]} ${sugg.filter((f) => !/^-O/.test(f)).join(' ')}\n` +
    (missing.some((m) => m.includes('<')) ? `# also set: ${missing.filter((m) => m.includes('<')).join(' ')}\n` : '');
  // For the page: every line with its tokens, and what each flag is.
  const drawing = {
    goal, mainO, goalO, oCount, netSize,
    lines: text.split(/\r?\n/).map((raw) => {
      const { toks, items } = scanLine(raw);
      return {
        raw, toks: toks.map((t) => [t.start, t.end, t.text]),
        items: items.map((it) => ({ t: it.t, refs: it.refs, kind: !it.flag ? 'arg' : flags.has(it.t) ? 'flag' : unknown.has(it.t) ? 'unknown' : 'other' })),
        o: items.filter((it) => /^-O/.test(it.t)).map((it) => it.t).pop() || null,
        link: !toks.some((t) => t.text === '-c') && toks.length > 1,
      };
    }),
    flags: Object.fromEntries([...flags.entries()].map(([k, f]) => [k, { cat: f.cat, size: f.size, speed: f.speed, what: f.what, count: f.count, lines: [...f.lines] }])),
    missing: missing.map((m) => ({ flag: m, ...(explain(m.replace(/=<.*>$/, '=x')) || {}), placeholder: m.includes('<') })),
    unknown: [...unknown.keys()],
  };
  return { values, warnings, notes, tables, texts: [{ title: 'Flags', body, lang: 'sh' }], drawing };
}
