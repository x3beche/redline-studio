// Stack usage estimator: worst-case stack depth from a call graph with a frame
// size per function (typed in, or read from GCC's -fstack-usage .su files),
// plus nested interrupts, plus a safety margin.
//
//   worst(f) = frame(f) + max over callees c of worst(c)          (longest path, DAG)
//   ISR load = sum over distinct preemption levels of
//              (max over ISRs at that level of worst(isr) + exception frame)
//              - only one ISR per level can be active; each higher level can nest once.
//   total    = worst(entry) + ISR load;   recommended = total * (1 + margin), rounded up to 8.
// Exception frames: Cortex-M stacks 8 words = 32 B, or 26 words = 104 B with the FPU
// context (Armv7-M ARM B1.5.7), plus up to 4 B of alignment padding (CCR.STKALIGN).
// AVR pushes the 2-byte return address (the ISR prologue's pushes are in its frame);
// RISC-V pushes nothing in hardware (the handler's prologue saves registers).
// GCC -fstack-usage: "file:line:col:function<TAB>bytes<TAB>static|dynamic[,bounded]" (GCC manual §3.11).

const ARCH = {
  cm: { name: 'Cortex-M, no FPU', frame: 36 },
  cmfpu: { name: 'Cortex-M4F/M7 with FPU in use', frame: 108 },
  avr: { name: 'AVR', frame: 2 },
  riscv: { name: 'RISC-V', frame: 0 },
};

const list = (t) => String(t ?? '').split(/[\s,;]+/).map((x) => x.trim().replace(/\(\)$/, '')).filter(Boolean);

function parseSu(text) {
  const out = new Map(), bad = [], dyn = [];
  for (const raw of String(text ?? '').split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    // file.c:12:6:name  48  static   |  name 48 static
    const m = /^(?:.*?:\d+:\d+:)?([A-Za-z_][\w:.$<>~]*)(?:\([^)]*\))?\s+(\d+)\s+(\S+)?\s*$/.exec(l);
    if (!m) { bad.push(l); continue; }
    const name = m[1].split('::').pop();
    const q = m[3] || 'static';
    if (/dynamic/.test(q) && !/bounded/.test(q)) dyn.push(name);
    out.set(name, Math.max(out.get(name) || 0, Number(m[2])));
  }
  return { out, bad, dyn };
}

export function run({ arch, entry, funcs, su, isrs, margin }) {
  const A = ARCH[arch] || ARCH.cm;
  const warnings = [], notes = [];
  const g = new Map();   // name -> {frame, calls}
  const { out: suMap, bad: suBad, dyn } = parseSu(su);
  for (const f of funcs || []) {
    const name = String(f.name ?? '').trim();
    if (!name) continue;
    const fr = String(f.frame ?? '').trim();
    const frame = fr === '' ? null : Number(fr);
    if (fr !== '' && !(frame >= 0)) warnings.push(`${name}: frame "${f.frame}" is not a byte count; using the .su value or 0.`);
    g.set(name, { frame: frame >= 0 ? frame : null, calls: list(f.calls) });
  }
  for (const [n, b] of suMap) {
    if (!g.has(n)) g.set(n, { frame: b, calls: [] });
    else if (g.get(n).frame == null) g.get(n).frame = b;
  }
  if (suBad.length) warnings.push(`Could not read ${suBad.length} .su line${suBad.length > 1 ? 's' : ''}: ${suBad.slice(0, 3).join(' | ')}${suBad.length > 3 ? ' ...' : ''}. Expected "file.c:12:6:func<TAB>48<TAB>static".`);
  if (dyn.length) warnings.push(`GCC marks ${dyn.join(', ')} as dynamic (alloca or a variable-length array): the .su number is only the fixed part. Bound or remove the dynamic allocation.`);

  const unknown = new Set(), rec = new Set();
  const memo = new Map();
  const worst = (n, stack = []) => {
    if (memo.has(n)) return memo.get(n);
    if (stack.includes(n)) { rec.add([...stack.slice(stack.indexOf(n)), n].join(' → ')); return { bytes: 0, path: [] }; }
    const node = g.get(n);
    if (!node) { unknown.add(n); return { bytes: 0, path: [{ name: n, frame: null }] }; }
    let best = { bytes: 0, path: [] };
    for (const c of node.calls) {
      const w = worst(c, [...stack, n]);
      if (w.bytes > best.bytes || (!best.path.length && w.path.length)) best = w;
    }
    const fr = node.frame ?? 0;
    if (node.frame == null) unknown.add(n);
    const r = { bytes: fr + best.bytes, path: [{ name: n, frame: node.frame }, ...best.path] };
    // a result computed while cutting a cycle is not the true worst for other callers; only memoise clean runs
    if (!stack.length || !rec.size) memo.set(n, r);
    return r;
  };

  const ent = String(entry ?? '').trim() || 'main';
  if (!g.has(ent)) return { warnings: [...warnings, `The entry function "${ent}" is not in the table or the .su data. Add it, or set the entry to the top function (main or a task function).`] };
  const main = worst(ent);

  // interrupts: one per level, levels nest
  const levels = new Map();
  const isrRows = [];
  const isrDraw = [];   // for the page's drawing
  for (const i of isrs || []) {
    const name = String(i.name ?? '').trim();
    if (!name) continue;
    const lv = String(i.level ?? '').trim() === '' ? 0 : Number(i.level);
    if (!Number.isFinite(lv)) { warnings.push(`${name}: level "${i.level}" is not a number; treated as 0.`); }
    if (!g.has(name)) { warnings.push(`Interrupt ${name} is not in the function table or .su data: add it with its frame and calls. Counted as 0 + the exception frame.`); }
    const w = g.has(name) ? worst(name) : { bytes: 0, path: [] };
    const tot = w.bytes + A.frame;
    const key = Number.isFinite(lv) ? lv : 0;
    isrRows.push([name, key, w.bytes, A.frame, tot, w.path.map((p) => p.name).join(' → ') || name]);
    isrDraw.push({ name, level: key, bytes: w.bytes, total: tot, known: g.has(name), path: w.path.map((p) => ({ name: p.name, frame: p.frame })) });
    if (!levels.has(key) || levels.get(key).tot < tot) levels.set(key, { name, tot });
  }
  const isrSum = [...levels.values()].reduce((s, x) => s + x.tot, 0);
  const total = main.bytes + isrSum;
  const mg = Number.isFinite(margin) && margin >= 0 ? margin : 25;
  if (!(margin >= 0)) warnings.push('Margin should be a percentage, e.g. 25; using 25 %.');
  const rec8 = Math.ceil((total * (1 + mg / 100)) / 8) * 8;

  if (rec.size) warnings.push(`Recursion: ${[...rec].join('; ')}. Static analysis cannot bound it; each cycle was counted once. Bound the depth and add depth × frame by hand, or remove the recursion.`);
  const unk = [...unknown];
  if (unk.length) warnings.push(`No frame size for ${unk.slice(0, 8).join(', ')}${unk.length > 8 ? ' ...' : ''}: counted as 0 bytes, so the result is too low. Build with -fstack-usage and paste the .su lines, or type the frames.`);
  notes.push(`Exception frame per nesting level: ${A.frame} B (${A.name}).`,
    'Calls through function pointers and library code without .su data are invisible here: list them as calls with a measured frame (newlib printf with floats alone can need 1-2 KiB).',
    'Check the result on hardware too: fill the stack with a pattern (0xA5) at start-up and read the high-water mark after a stress run.');
  if (arch === 'cm' || arch === 'cmfpu') notes.push('With an RTOS on Cortex-M, interrupts run on the main stack (MSP): size each task stack with its own entry and without the interrupt load, and the MSP with the interrupt load only.');

  const recList = [...rec];
  // For the page's drawing: every function with its own worst path below it,
  // and the interrupts with the one per level that nests. Computed after the
  // warnings above, so it cannot change them.
  const nodes = [...g.entries()].map(([name, n]) => {
    const w = worst(name);
    return { name, frame: n.frame, calls: n.calls, worst: w.bytes, fromSu: suMap.has(name) && !(funcs || []).some((f) => String(f.name ?? '').trim() === name && String(f.frame ?? '').trim() !== '') };
  });
  const stack = {
    arch: arch in ARCH ? arch : 'cm', excFrame: A.frame, entry: ent,
    main: { bytes: main.bytes, path: main.path.map((p) => ({ name: p.name, frame: p.frame })) },
    isrs: isrDraw.map((r) => ({ ...r, nests: levels.get(r.level)?.name === r.name })),
    isrSum, total, margin: mg, recommended: rec8,
    nodes, unknown: unk, recursion: recList, lowerBound: !!(unk.length || recList.length),
  };

  let cum = 0;
  const pathRows = main.path.map((p) => { cum += p.frame ?? 0; return [p.name, p.frame == null ? '? (0)' : String(p.frame), String(cum)]; });
  return {
    values: [
      { label: `Deepest path from ${ent}`, value: String(main.bytes), unit: 'B', hint: `${main.path.length} calls deep` },
      { label: 'Nested interrupts', value: String(isrSum), unit: 'B', hint: `${levels.size} level${levels.size === 1 ? '' : 's'}` },
      { label: 'Worst case', value: String(total), unit: 'B', tone: unk.length || rec.size ? 'warn' : undefined, hint: unk.length || rec.size ? 'lower bound: see warnings' : undefined },
      { label: `Recommended (+${mg} %)`, value: String(rec8), unit: 'B', tone: 'ok', hint: `0x${rec8.toString(16).toUpperCase()}` },
    ],
    tables: [
      { title: `Deepest call path from ${ent}`, columns: ['Function', 'Frame (B)', 'Cumulative (B)'], rows: pathRows },
      ...(isrRows.length ? [{ title: 'Interrupts (the largest per level nests)', columns: ['Interrupt', 'Level', 'Handler path (B)', 'Exception frame (B)', 'Total (B)', 'Deepest path'],
        rows: isrRows.sort((a, b) => a[1] - b[1]).map((r) => r.map(String)) }] : []),
    ],
    warnings, notes, stack,
  };
}
