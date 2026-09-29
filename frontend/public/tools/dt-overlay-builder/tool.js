// DT Overlay Builder: from a base tree, a target node and the changes asked
// for, the overlay source in both forms dtc accepts, the line that loads it,
// and the checks a reviewer would make first.
//
// Overlay syntax: Documentation/devicetree/overlay-notes.rst and dtc's
// "sugar" form (&label { } / &{/path} { } in a /plugin/ file, dtc >= 1.4.5),
// which dtc compiles to the fragment@N { target = <&label>; __overlay__ { } }
// form written out below as well.
// I2C reserved addresses: NXP UM10204 rev. 7, table 4 (0x00-0x07 and
// 0x78-0x7F). 10-bit addresses in DT: I2C_TEN_BIT_ADDRESS (1 << 31),
// include/dt-bindings/i2c/i2c.h. Node names: DT spec v0.4 §2.2.1
// (1-31 chars of [0-9a-zA-Z,._+-], unit address after @).
// Macro values (dtc has no preprocessor, so the output carries numbers):
// include/dt-bindings/gpio/gpio.h, interrupt-controller/irq.h,
// interrupt-controller/arm-gic.h, pwm/pwm.h.

import { parseDts, pathOf, findPath, cells, str, refs } from './dts.js';

const MACROS = {
  GPIO_ACTIVE_HIGH: 0, GPIO_ACTIVE_LOW: 1, GPIO_PUSH_PULL: 0, GPIO_SINGLE_ENDED: 2,
  GPIO_LINE_OPEN_SOURCE: 0, GPIO_LINE_OPEN_DRAIN: 4, GPIO_OPEN_DRAIN: 6, GPIO_OPEN_SOURCE: 2,
  GPIO_PERSISTENT: 0, GPIO_TRANSITORY: 8, GPIO_PULL_UP: 16, GPIO_PULL_DOWN: 32, GPIO_PULL_DISABLE: 64,
  IRQ_TYPE_NONE: 0, IRQ_TYPE_EDGE_RISING: 1, IRQ_TYPE_EDGE_FALLING: 2, IRQ_TYPE_EDGE_BOTH: 3,
  IRQ_TYPE_LEVEL_HIGH: 4, IRQ_TYPE_LEVEL_LOW: 8,
  GIC_SPI: 0, GIC_PPI: 1, PWM_POLARITY_NORMAL: 0, PWM_POLARITY_INVERTED: 1,
};
const I2C_TEN_BIT = 0x80000000;

export const KINDS = {
  i2c: { title: 'I2C device', addr: 'I2C address', param: '', ref: '' },
  spi: { title: 'SPI device', addr: 'Chip select', param: 'spi-max-frequency (Hz)', ref: '' },
  'gpio-led': { title: 'GPIO LED', addr: 'GPIO line (add "low" for active-low)', param: 'Trigger', ref: 'GPIO controller' },
  'pwm-led': { title: 'PWM LED', addr: 'PWM channel', param: 'Period (ns)', ref: 'PWM controller' },
  uart: { title: 'UART (serdev) device', addr: '', param: 'current-speed (baud)', ref: '' },
  custom: { title: 'Custom node', addr: 'Unit address (reg)', param: '', ref: '' },
};

const num = (t) => {
  const s = String(t ?? '').trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(s)) return parseInt(s, 16);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = /^(\d+(?:\.\d+)?)\s*([kmg])(?:hz)?$/.exec(s);
  if (m) return Math.round(Number(m[1]) * { k: 1e3, m: 1e6, g: 1e9 }[m[2]]);
  return null;
};
const hex = (v) => '0x' + v.toString(16);
const NODE_OK = /^[0-9a-zA-Z,._+-]{1,31}$/;

/** A value as the person typed it, made into DTS: 400000 -> <400000>, text -> "text". */
export function dtsValue(v) {
  const t = String(v ?? '').trim();
  if (t === '') return '';
  if (/^[<"[&]/.test(t)) return t;
  if (/^(0x[0-9a-f]+|\d+)(\s+(0x[0-9a-f]+|\d+))*$/i.test(t)) return `<${t}>`;
  return `"${t.replace(/"/g, '\\"')}"`;
}

/** Macros in <cells> to numbers, and the names that were not known. */
function expand(raw, unknown) {
  const used = [];
  const out = String(raw).replace(/<([^>]*)>/g, (all, inner) => '<' + inner.replace(/\b([A-Z][A-Z0-9_]{2,})\b/g, (w) => {
    if (w in MACROS) { if (!used.includes(w)) used.push(w); return String(MACROS[w]); }
    unknown.add(w); return w;
  }) + '>');
  return used.length ? `${out}; /* ${used.join(', ')} */` : `${out};`;
}

/** "k = v; flag; k2 = <1 2>" -> [[k, v], [flag, ''], ...] */
function extraProps(text) {
  const out = [];
  let cur = '', depth = 0, q = false;
  for (const c of String(text ?? '')) {
    if (c === '"') q = !q;
    if (!q && (c === '<' || c === '[')) depth++;
    if (!q && (c === '>' || c === ']')) depth--;
    if (!q && depth <= 0 && (c === ';' || c === '\n')) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((p) => {
    const k = p.indexOf('=');
    return k < 0 ? [p.trim(), ''] : [p.slice(0, k).trim(), dtsValue(p.slice(k + 1))];
  });
}

const statusOf = (node) => (node ? str(node.props.get('status')) : null);
const isOff = (node) => { for (let n = node; n; n = n.parent) { const s = statusOf(n); if (s && s !== 'okay' && s !== 'ok') return true; } return false; };
const compatOf = (node) => (node ? String(node.props.get('compatible') || '') : '');

/** Build one requested child into {name, props: [[k, v]], kids: [...] } plus its problems. */
function buildChild(c, ctx) {
  const kind = KINDS[c.kind] ? c.kind : 'custom';
  const issues = [];
  const base = String(c.name || '').trim() || { i2c: 'device', spi: 'device', 'gpio-led': 'led', 'pwm-led': 'led', uart: 'device', custom: 'node' }[kind];
  const compatible = String(c.compatible || '').trim().replace(/^"|"$/g, '');
  const extras = extraProps(c.extra);
  const refsUsed = [];
  let node;
  const needCompat = () => {
    if (!compatible) issues.push({ level: 'bad', text: 'no compatible: no driver will bind to this node. Use the vendor,device string from the binding.' });
    else if (!compatible.includes(',')) issues.push({ level: 'warn', text: `compatible "${compatible}" has no vendor prefix (vendor,device).` });
  };
  if (kind === 'i2c') {
    needCompat();
    const a = num(c.addr);
    if (a == null) { issues.push({ level: 'bad', text: `I2C address "${c.addr}" does not read: write it as 0x48.` }); node = { name: base, props: [] }; }
    else {
      let reg = hex(a);
      if (a > 0x7f && a <= 0x3ff) { reg = `${hex(I2C_TEN_BIT | a)}`; issues.push({ level: 'warn', text: `${hex(a)} is a 10-bit address: reg carries I2C_TEN_BIT_ADDRESS (1 << 31); the adapter driver must support 10-bit.` }); }
      else if (a > 0x3ff) issues.push({ level: 'bad', text: `${hex(a)} is not an I2C address (7-bit 0x08-0x77).` });
      else if (a < 0x08 || a > 0x77) issues.push({ level: 'bad', text: `${hex(a)} is reserved by the I2C spec (0x00-0x07 and 0x78-0x7F, UM10204 table 4).` });
      node = { name: `${base}@${a.toString(16)}`, props: [['compatible', `"${compatible}"`], ['reg', `<${reg}>`]], addr: a };
      if (!compatible) node.props.shift();
    }
    if (ctx.cellsA != null && (ctx.cellsA !== 1 || ctx.cellsS !== 0)) issues.push({ level: 'bad', text: `the target has #address-cells = <${ctx.cellsA}>, #size-cells = <${ctx.cellsS}>; an I2C bus needs <1> and <0>. Is the target an I2C controller?` });
  } else if (kind === 'spi') {
    needCompat();
    const cs = num(c.addr);
    const hz = num(c.param);
    if (cs == null) { issues.push({ level: 'bad', text: `chip select "${c.addr}" does not read: reg is the CS index (0, 1, ...).` }); node = { name: base, props: [] }; }
    else {
      node = { name: `${base}@${cs.toString(16)}`, props: [], addr: cs };
      if (compatible) node.props.push(['compatible', `"${compatible}"`]);
      node.props.push(['reg', `<${cs}>`]);
      if (ctx.numCs != null && cs >= ctx.numCs) issues.push({ level: 'bad', text: `CS ${cs} but the controller has ${ctx.numCs} chip select${ctx.numCs === 1 ? '' : 's'} (${ctx.numCsFrom}).` });
    }
    if (hz == null) issues.push({ level: 'bad', text: 'spi-max-frequency is required by spi-peripheral-props.yaml: give the device\'s maximum SCLK in Hz.' });
    else {
      node.props.push(['spi-max-frequency', `<${hz}>`]);
      if (hz > 100e6) issues.push({ level: 'warn', text: `${hz / 1e6} MHz is above what most SPI devices and controllers run; check the datasheet.` });
    }
    if (ctx.cellsA != null && (ctx.cellsA !== 1 || ctx.cellsS !== 0)) issues.push({ level: 'bad', text: `the target has #address-cells = <${ctx.cellsA}>, #size-cells = <${ctx.cellsS}>; an SPI bus needs <1> and <0>. Is the target an SPI controller?` });
  } else if (kind === 'gpio-led' || kind === 'pwm-led') {
    const ref = String(c.ref || '').trim().replace(/^&/, '') || (kind === 'gpio-led' ? 'gpio' : 'pwm');
    refsUsed.push(ref);
    const m = /^\s*(\d+)\s*(low|active[-_ ]?low|l)?\s*$/i.exec(String(c.addr || ''));
    const ch = m ? Number(m[1]) : null;
    if (ch == null) issues.push({ level: 'bad', text: `${kind === 'gpio-led' ? 'GPIO line' : 'PWM channel'} "${c.addr}" does not read: a number${kind === 'gpio-led' ? ', optionally followed by "low"' : ''}.` });
    const led = { name: base, props: [] };
    if (kind === 'gpio-led') {
      led.props.push(['gpios', `<&${ref} ${ch ?? 0} ${m && m[2] ? 'GPIO_ACTIVE_LOW' : 'GPIO_ACTIVE_HIGH'}>`]);
      led.props.push(['label', `"${base}"`]);
      const trig = String(c.param || '').trim();
      if (trig) led.props.push(['linux,default-trigger', `"${trig}"`]);
      led.props.push(['default-state', '"off"']);
    } else {
      const per = num(c.param) ?? 1000000;
      if (num(c.param) == null && String(c.param || '').trim()) issues.push({ level: 'warn', text: `period "${c.param}" does not read; 1000000 ns (1 kHz) used.` });
      led.props.push(['pwms', `<&${ref} ${ch ?? 0} ${per}>`]);
      led.props.push(['label', `"${base}"`]);
      led.props.push(['max-brightness', '<255>']);
      if (ctx.pwmCells && ctx.pwmCells[ref] != null && ctx.pwmCells[ref] !== 2) issues.push({ level: 'warn', text: `&${ref} has #pwm-cells = <${ctx.pwmCells[ref]}>; this entry has 2 cells (channel, period). Add the flags cell (PWM_POLARITY_NORMAL = 0).` });
    }
    const drv = kind === 'gpio-led' ? 'gpio-leds' : 'pwm-leds';
    if (ctx.targetCompat.includes(`"${drv}"`)) node = led;
    else node = { name: `${kind === 'gpio-led' ? 'leds' : 'pwmleds'}-${base}`, props: [['compatible', `"${drv}"`]], kids: [led] };
    if (compatible && compatible !== drv) issues.push({ level: 'warn', text: `compatible "${compatible}" ignored: LEDs use the ${drv} driver.` });
    if (ctx.targetIsBus) issues.push({ level: 'warn', text: `the target is a bus (${ctx.targetPath}); ${drv} nodes usually go under the root: target &{/}.` });
  } else if (kind === 'uart') {
    needCompat();
    node = { name: base, props: [] };
    if (compatible) node.props.push(['compatible', `"${compatible}"`]);
    const bd = num(c.param);
    if (String(c.param || '').trim()) {
      if (bd == null) issues.push({ level: 'bad', text: `baud "${c.param}" does not read.` });
      else node.props.push(['current-speed', `<${bd}>`]);
    }
    if (!ctx.targetIsUart) issues.push({ level: 'warn', text: `the target ${ctx.targetPath} does not look like a UART; a serdev device goes under its serial@ node.` });
  } else {
    needCompat();
    const a = String(c.addr || '').trim();
    const v = a ? num(a) : null;
    if (a && v == null) issues.push({ level: 'bad', text: `unit address "${a}" does not read.` });
    node = { name: v != null ? `${base}@${v.toString(16)}` : base, props: [], addr: v ?? undefined };
    if (compatible) node.props.push(['compatible', `"${compatible}"`]);
    if (v != null) node.props.push(['reg', `<${hex(v)}>`]);
  }
  for (const [k, v] of extras) {
    if (!NODE_OK.test(k.replace(/^#/, '')) && !/^#?[\w,.+-]+$/.test(k)) { issues.push({ level: 'bad', text: `"${k}" is not a property name.` }); continue; }
    const target = node.kids ? node.kids[0] : node;
    const at = target.props.findIndex(([n]) => n === k);
    if (at >= 0) target.props[at] = [k, v]; else target.props.push([k, v]);
    refsUsed.push(...refs(v));
  }
  if (!NODE_OK.test(base)) issues.push({ level: 'bad', text: `node name "${base}" is not valid: 1-31 of 0-9 a-z A-Z , . _ + - (DT spec 2.2.1).` });
  return { node, issues, refsUsed, kind };
}

function emit(node, indent, lines, unknown) {
  const pad = '\t'.repeat(indent);
  lines.push(`${pad}${node.name} {`);
  for (const [k, v] of node.props) lines.push(`${pad}\t${k}${v === '' ? ';' : ` = ${expand(v, unknown)}`}`);
  for (const kid of node.kids || []) { lines.push(''); emit(kid, indent + 1, lines, unknown); }
  lines.push(`${pad}};`);
}

export function run(input) {
  const warnings = [], notes = [];
  const base = parseDts(input.base);
  const ovName = (String(input.name || '').trim() || 'my-overlay').replace(/\.dtbo?$/, '');
  const unknown = new Set();

  // ---- the target
  const tRaw = String(input.target || '').trim();
  let tNode = null, tRef = null;
  if (/^&\{.*\}$/.test(tRaw) || tRaw.startsWith('/')) {
    const p = tRaw.replace(/^&\{|\}$/g, '') || '/';
    tRef = { path: p }; tNode = findPath(base.root, p);
  } else {
    const l = tRaw.replace(/^&/, '');
    tRef = { label: l }; tNode = base.labels.get(l) || null;
  }
  const tName = tRef.path != null ? `&{${tRef.path}}` : `&${tRef.label}`;
  if (!tRaw || (tRef.label != null && !/^[A-Za-z_]\w*$/.test(tRef.label))) warnings.push(`The target "${tRaw}" is neither &label nor a /path. Click a node in the base tree.`);
  else if (!tNode) warnings.push(`${tName} is not in the base tree: the loader will refuse the overlay ("${tRef.label ?? tRef.path}" not found in __symbols__). Check the name or paste the right base.`);
  if (tRef.path != null) notes.push('A path target (&{/path} or target-path) works without __symbols__ in the base, but breaks if the SoC dtsi renames the node; a label is sturdier.');

  const tProps = tNode ? tNode.props : new Map();
  const cellsA0 = cells(tProps.get('#address-cells'));
  const cellsS0 = cells(tProps.get('#size-cells'));
  const children = Array.isArray(input.children) ? input.children : [];
  const props = (Array.isArray(input.props) ? input.props : []).filter((p) => String(p.name || '').trim());

  // cells after the overlay: the overlay may set them
  const setCells = (k) => { const p = props.find((q) => String(q.name).trim() === k); return p ? cells(dtsValue(p.value)) : null; };
  const cA = setCells('#address-cells') ?? cellsA0;
  const cS = setCells('#size-cells') ?? cellsS0;
  const busKids = children.filter((c) => c.kind === 'i2c' || c.kind === 'spi');
  const autoCells = busKids.length && !cA && !cS;

  const cs = tNode && cells(tNode.props.get('num-cs'));
  const csg = tNode && tNode.props.get('cs-gpios');
  // cs-gpios entries: <&gpio 8 1>, <&gpio 7 1> or one <...> list; a bare <0> is a native CS
  const csEntries = (v) => [...String(v).matchAll(/<([^>]*)>/g)].reduce((t, m) => t + Math.max(1, (m[1].match(/&/g) || []).length), 0);
  const numCs = cs && Number.isFinite(cs[0]) ? Number(cs[0]) : csg ? csEntries(csg) || null : null;
  const pwmCells = {};
  for (const [l, nd] of base.labels) { const pc = cells(nd.props.get('#pwm-cells')); if (pc) pwmCells[l] = pc[0]; }
  const tCompat = compatOf(tNode);
  const bctx = {
    cellsA: autoCells ? 1 : cA ? cA[0] : null, cellsS: autoCells ? 0 : cS ? cS[0] : null,
    numCs, numCsFrom: cs ? 'num-cs' : 'cs-gpios entries', pwmCells,
    targetCompat: tCompat, targetPath: tNode ? pathOf(tNode) : tName,
    targetIsBus: /i2c|spi/i.test(tCompat) || /^(i2c|spi)@/.test(tNode?.name || ''),
    targetIsUart: /uart|serial|pl011|8250|16550|lpuart|usart/i.test(tCompat + ' ' + (tNode?.name || '')),
  };
  if (!tNode || (cA == null && !autoCells)) { bctx.cellsA = null; bctx.cellsS = null; }

  const built = children.map((c) => buildChild(c, bctx));

  // ---- conflicts with what the base already has on the bus
  const alsoDisable = String(input.alsoDisable || '').split(/[\s,]+/).map((s) => s.replace(/^&/, '')).filter(Boolean);
  const alsoEnable = String(input.alsoEnable || '').split(/[\s,]+/).map((s) => s.replace(/^&/, '')).filter(Boolean);
  const willDisable = new Set(alsoDisable.map((l) => base.labels.get(l)).filter(Boolean));
  built.forEach((b, k) => {
    if (b.node.addr == null || !tNode) return;
    for (const kid of tNode.children) {
      const u = kid.name.split('@')[1];
      if (u == null || parseInt(u, 16) !== b.node.addr) continue;
      // its own status only: the target itself may be the thing being enabled
      const own = statusOf(kid);
      if ((own && own !== 'okay' && own !== 'ok') || willDisable.has(kid)) continue;
      const lab = kid.labels[0];
      b.issues.push({ level: 'bad', text: `${kid.name} in the base already uses ${b.kind === 'spi' ? `CS ${b.node.addr}` : `address ${hex(b.node.addr)}`}${lab ? `: put ${lab} in "Also disable"` : ''}.`, fix: lab ? { disable: lab } : null });
    }
    built.forEach((o, j) => { if (j < k && o.node.addr === b.node.addr && o.kind === b.kind) b.issues.push({ level: 'bad', text: `same ${b.kind === 'spi' ? 'chip select' : 'address'} as ${o.node.name} above.` }); });
    if (b.node.name && built.some((o, j) => j < k && o.node.name === b.node.name)) b.issues.push({ level: 'bad', text: `two nodes named ${b.node.name}: the second overwrites the first.` });
  });

  // ---- properties on the target
  const tPropsOut = [];
  if (autoCells) { tPropsOut.push(['#address-cells', '<1>', 'auto']); tPropsOut.push(['#size-cells', '<0>', 'auto']); }
  for (const p of props) {
    const k = String(p.name).trim();
    if (k === 'status') { warnings.push('status is set with the Status control, not as a property row; the row was left out.'); continue; }
    const v = dtsValue(p.value);
    if (!/^#?[A-Za-z0-9,._+?-]+$/.test(k)) { warnings.push(`"${k}" is not a property name; left out.`); continue; }
    const at = tPropsOut.findIndex(([n]) => n === k);
    if (at >= 0) tPropsOut[at] = [k, v, 'prop']; else tPropsOut.push([k, v, 'prop']);
  }
  const status = ['okay', 'disabled'].includes(input.status) ? input.status : 'keep';
  if (status !== 'keep') tPropsOut.push(['status', `"${status}"`, 'status']);
  const tOffNow = tNode ? isOff(tNode) : false;
  if (tNode && children.length && status === 'keep' && tOffNow) warnings.push(`${tName} is disabled in the base: its new children will not probe. Set its status to okay.`);
  if (tNode && status === 'okay' && tNode.parent && isOff(tNode.parent)) warnings.push(`${tName}'s parent ${pathOf(tNode.parent)} is disabled, so okay here does nothing until the parent is enabled too.`);
  if (autoCells) notes.push(`#address-cells = <1> and #size-cells = <0> were added: the base ${tName} does not set them and its new children carry reg.`);

  // ---- references to labels the base does not have
  const refsNeeded = new Set();
  for (const b of built) for (const r of b.refsUsed) refsNeeded.add(r);
  for (const [, v] of tPropsOut) for (const r of refs(v)) refsNeeded.add(r);
  for (const r of refsNeeded) if (!base.labels.has(r)) warnings.push(`&${r} is not a label in the base tree: the overlay compiles (it goes to __fixups__) but fails to apply. Check the controller's label.`);
  for (const l of [...alsoDisable, ...alsoEnable]) if (!base.labels.has(l)) warnings.push(`Also ${alsoDisable.includes(l) ? 'disable' : 'enable'}: &${l} is not a label in the base tree.`);
  for (const [k, b] of built.entries()) for (const is of b.issues) warnings.push(`${b.node.name || `child ${k + 1}`}: ${is.text}`);
  if (!children.length && !tPropsOut.length && !alsoDisable.length && !alsoEnable.length) warnings.push('Nothing to change yet: set the status, add a property or add a child.');

  // ---- the overlay, both forms
  const frags = [];
  const tLines = [];
  for (const [k, v] of tPropsOut) tLines.push(`\t${k}${v === '' ? ';' : ` = ${expand(v, unknown)}`}`);
  const kidLines = [];
  for (const b of built) { kidLines.push(''); emit(b.node, 1, kidLines, unknown); }
  if (!tLines.length && kidLines[0] === '') kidLines.shift();
  frags.push({ ref: tRef, name: tName, lines: [...tLines, ...kidLines], what: [status !== 'keep' ? `status = "${status}"` : null, ...props.filter((p) => p.name.trim() !== 'status').map((p) => p.name.trim()), ...built.map((b) => `+ ${b.node.name}`)].filter(Boolean).join(', ') });
  for (const l of alsoDisable) frags.push({ ref: { label: l }, name: `&${l}`, lines: ['\tstatus = "disabled";'], what: 'status = "disabled"' });
  for (const l of alsoEnable) frags.push({ ref: { label: l }, name: `&${l}`, lines: ['\tstatus = "okay";'], what: 'status = "okay"' });
  const used = frags.filter((f) => f.lines.length);

  const head = ['/dts-v1/;', '/plugin/;', '', `/* ${ovName}: built with DT Overlay Builder. Compile: dtc -@ -I dts -O dtb -o ${ovName}.dtbo ${ovName}.dts */`];
  const sugar = [...head];
  for (const f of used) sugar.push('', `${f.name} {`, ...f.lines, '};');
  const frag = [...head, '', '/ {'];
  const compat = String(input.compat || '').trim().replace(/^"|"$/g, '');
  if (compat) frag.push(`\tcompatible = ${compat.split(/\s*,\s*(?=[a-z0-9-]+,)/i).map((c) => `"${c.replace(/"/g, '')}"`).join(', ')};`);
  used.forEach((f, k) => {
    frag.push('', `\tfragment@${k} {`, f.ref.path != null ? `\t\ttarget-path = "${f.ref.path}";` : `\t\ttarget = <&${f.ref.label}>;`, '', '\t\t__overlay__ {');
    for (const l of f.lines) frag.push(l === '' ? '' : '\t\t' + l);
    frag.push('\t\t};', '\t};');
  });
  frag.push('};');
  if (unknown.size) warnings.push(`Unknown macro${unknown.size > 1 ? 's' : ''} ${[...unknown].join(', ')}: dtc has no preprocessor, write the number (or compile through cpp with the dt-bindings headers).`);

  // ---- loading it
  const loader = input.loader || 'rpi';
  const load = {
    rpi: [`# Raspberry Pi (firmware applies it at boot)`, `dtc -@ -I dts -O dtb -o ${ovName}.dtbo ${ovName}.dts`, `sudo cp ${ovName}.dtbo /boot/firmware/overlays/     # /boot/overlays/ before Bookworm`, '', '# /boot/firmware/config.txt', `dtoverlay=${ovName}`, '', '# or at run time, without a reboot', `sudo dtoverlay ${ovName}      # dtoverlay -l lists, dtoverlay -r ${ovName} removes`],
    uboot: ['# U-Boot: apply by hand before booting (CONFIG_OF_LIBFDT_OVERLAY=y)', 'load mmc 0:1 ${fdt_addr_r} ${fdtfile}', 'fdt addr ${fdt_addr_r}', 'fdt resize 8192', `load mmc 0:1 \${fdtoverlay_addr_r} overlays/${ovName}.dtbo`, 'fdt apply ${fdtoverlay_addr_r}', 'booti ${kernel_addr_r} - ${fdt_addr_r}      # kernel loaded first; bootz on 32-bit Arm, initrd in place of -'],
    extlinux: ['# /boot/extlinux/extlinux.conf (U-Boot distro boot, CONFIG_OF_LIBFDT_OVERLAY=y)', 'label linux', '    kernel /Image', '    fdt /dtbs/${fdtfile}', `    fdtoverlays /overlays/${ovName}.dtbo`, '    append root=/dev/mmcblk0p2 rootwait'],
    yocto: ['# Yocto: build the overlay with the kernel and let the boot loader apply it', `# linux-yourboard_%.bbappend: SRC_URI += "file://${ovName}.dts"`, `KERNEL_DEVICETREE:append = " overlays/${ovName}.dtbo"`, '# Raspberry Pi layer (meta-raspberrypi), local.conf:', `RPI_EXTRA_CONFIG = "dtoverlay=${ovName}"`],
  };
  const loadText = [...(load[loader] || load.rpi)];
  notes.push('The base DTB must carry __symbols__ (built with dtc -@, DTC_FLAGS += -@) for &label targets to resolve at apply time. Raspberry Pi firmware DTBs have them.');

  // ---- the drawing: the tree and the target before / after
  const tree = [];
  const pendingOf = (nd) => (nd === tNode && status !== 'keep' ? status : nd.labels.some((l) => alsoDisable.includes(l)) ? 'disabled' : nd.labels.some((l) => alsoEnable.includes(l)) ? 'okay' : null);
  const walk = (nd, depth) => {
    if (tree.length >= 400) return;
    tree.push({ path: pathOf(nd), name: nd.name || '/', label: nd.labels[0] || '', depth, status: statusOf(nd) || '', off: isOff(nd),
      compat: str(nd.props.get('compatible')) || '', kids: nd.children.length, target: nd === tNode, pending: pendingOf(nd),
      adds: nd === tNode ? built.length : 0 });
    for (const k of nd.children) walk(k, depth + 1);
  };
  walk(base.root, 0);
  const before = tNode ? [...tNode.props].map(([k, v]) => ({ name: k, value: v })) : [];
  const after = before.map((p) => ({ ...p, change: 'same' }));
  for (const [k, v, src] of tPropsOut) {
    const at = after.findIndex((p) => p.name === k);
    if (at >= 0) { if (after[at].value.replace(/\s+/g, ' ') !== v.replace(/\s+/g, ' ')) Object.assign(after[at], { value: v, change: 'changed', was: after[at].value, src }); else after[at].src = src; }
    else after.push({ name: k, value: v, change: 'new', src });
  }
  const drawKid = (b) => { const l = []; emit(b.node, 0, l, new Set()); return l; };
  const view = {
    tree,
    target: { name: tName, path: tNode ? pathOf(tNode) : '', label: tNode?.labels[0] || '', found: !!tNode, off: tOffNow, compat: str(tProps.get('compatible')) || '',
      nodeName: tNode ? (tNode.name || '/') : '', before, after,
      baseKids: tNode ? tNode.children.map((c) => ({ name: c.name, label: c.labels[0] || '', off: isOff(c) || willDisable.has(c), disabling: willDisable.has(c), compat: str(c.props.get('compatible')) || '' })) : [],
      newKids: built.map((b, k) => ({ index: k, kind: b.kind, name: b.node.name, lines: drawKid(b), issues: b.issues })) },
    fragments: used.map((f, k) => ({ n: k, name: f.name, what: f.what })),
    parseErrors: base.errors.slice(0, 20),
    kinds: KINDS,
  };
  if (base.errors.length) warnings.push(`The base tree has ${base.errors.length} place${base.errors.length > 1 ? 's' : ''} the reader could not follow (first: line ${base.errors[0].line}, ${base.errors[0].message}); the tree may be incomplete.`);
  if (base.includes.length) notes.push(`The base includes ${base.includes.map((x) => x.file).join(', ')}, not read here: labels defined there are unknown. Paste the merged tree (dtc -I dtb -O dts of the running board, or cpp output) for full checks.`);

  const values = [
    { label: 'Target', value: tNode ? `${tName} → ${pathOf(tNode)}` : tName, tone: tNode ? 'ok' : 'bad' },
    { label: 'Fragments', value: used.length },
    { label: 'New nodes', value: built.length },
    { label: 'Target status', value: status === 'keep' ? (tOffNow ? 'disabled (kept)' : 'okay (kept)') : `${tOffNow ? 'disabled' : 'okay'} → ${status}`, tone: (status === 'keep' ? !tOffNow : status === 'okay') ? 'ok' : 'warn' },
  ];
  const tables = [{ title: 'What the overlay changes', columns: ['Fragment', 'Target', 'Change'], rows: used.map((f, k) => [`fragment@${k}`, f.name, f.what || '-']) }];
  return {
    values, tables,
    texts: [
      { title: 'Overlay (&label form)', body: sugar.join('\n') + '\n', lang: 'dts' },
      { title: 'Overlay (fragment form)', body: frag.join('\n') + '\n', lang: 'dts' },
      { title: 'Load it', body: loadText.join('\n') + '\n', lang: 'sh' },
    ],
    warnings, notes, view,
  };
}
