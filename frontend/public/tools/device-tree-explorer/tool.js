// Device Tree Explorer: a .dts with its .dtsi includes and overlays merged
// into the one tree the kernel would get, with the source of every property
// (which file set it, which files it overrode), phandle references resolved,
// every reg translated through the parents' ranges to a CPU physical address,
// and the conflicts dtc does not tell you about.
//
// Rules, with their source:
//   #address-cells / #size-cells default to 2 / 1 when a parent omits them
//     (Devicetree Specification v0.4 §2.3.5); dtc warns (avoid_default_addr_size).
//   reg is (address, size) pairs in the parent's cells (DT spec §2.3.6).
//   ranges = <child-addr parent-addr length>; empty ranges = identity; no
//     ranges = not memory mapped (DT spec §2.3.8, Linux of_translate_address).
//   phandle + specifier: the provider's #gpio-cells, #clock-cells, ... say how
//     many cells follow (DT spec §2.4, Linux Documentation/devicetree/bindings).
//   interrupt-parent is inherited from the tree parent (DT spec §2.4.1).
//   status "okay"/"ok" or absent = enabled (DT spec §2.3.4); a node under a
//     disabled parent is not probed (Linux of_platform_bus_create).
//   unit address must match reg (dtc checks.c unit_address_vs_reg,
//     simple_bus_reg, i2c_bus_reg, spi_bus_reg).
//   pinctrl-single,pins: offset + #pinctrl-cells values per pin
//     (bindings/pinctrl/pinctrl-single.txt); fsl,pins: 6 cells per pin
//     (bindings/pinctrl/fsl,imx-pinctrl.txt); rockchip,pins: 4 cells;
//     pinmux (STM32): pin << 8 | mode (stm32-pinfunc.h).

import { preprocess, parseInto, Node, fmtValue, cellList, strings, hex, expandMacros, evalExpr } from './dts.js';
import { HEADERS } from './bindings.js';

const SPEC = {
  gpios: '#gpio-cells', clocks: '#clock-cells', dmas: '#dma-cells', pwms: '#pwm-cells', resets: '#reset-cells',
  phys: '#phy-cells', 'interrupts-extended': '#interrupt-cells', 'io-channels': '#io-channel-cells', mboxes: '#mbox-cells',
  'power-domains': '#power-domain-cells', iommus: '#iommu-cells', 'thermal-sensors': '#thermal-sensor-cells',
  'sound-dai': '#sound-dai-cells', 'nvmem-cells': null,
};
const specKey = (name) => (/^(.+-)?gpios?$/.test(name) ? 'gpios' : Object.prototype.hasOwnProperty.call(SPEC, name) ? name : null);

export function run(input) {
  const warnings = [];
  const notes = [];
  const mainName = String(input.main_name || 'board.dts').trim() || 'board.dts';
  const rows = Array.isArray(input.files) ? input.files : [];
  const files = [{ name: mainName, text: String(input.dts ?? '') }];
  const overlays = [];
  for (const r of rows) {
    const name = String(r?.name ?? '').trim();
    if (!name) continue;
    const f = { name, text: String(r.text ?? '') };
    const kind = String(r.kind || '').toLowerCase();
    if (kind === 'overlay' || (!kind && /\.dtso$/.test(name))) overlays.push(f);
    else files.push(f);
  }

  // ---------- read: preprocess + parse the base, then each overlay ----------
  const macros = new Map();
  const pre = preprocess(mainName, files, HEADERS, macros);
  const root = new Node('', null);
  const ctx = { root, labels: new Map(), problems: [...pre.problems], deleted: [], memreserve: [], overlay: false, fileTag: 'base', aliases: new Map() };
  parseInto(pre.lines, ctx);
  const flats = [{ name: mainName, overlay: false, text: pre.lines.map((l) => l.text).join('\n'), origin: compactOrigin(pre.lines) }];
  if (!ctx.v1 && String(input.dts ?? '').trim()) ctx.problems.push({ sev: 'warn', file: mainName, line: 1, msg: 'no /dts-v1/; line: dtc reads the file as the old v0 format and rejects most of it' });
  const unused = files.slice(1).filter((f) => !pre.included.includes(f.name)).map((f) => f.name);
  for (const u of unused) ctx.problems.push({ sev: 'info', file: u, line: 1, msg: `${u} is never included by ${mainName} (nor by what it includes), so it is not part of the tree` });
  const baseLabels = new Set(ctx.labels.keys());
  for (const ov of overlays) {
    const op = preprocess(ov.name, [ov, ...files], HEADERS, new Map(macros));
    ctx.problems.push(...op.problems);
    ctx.overlay = true; ctx.plugin = false; ctx.fileTag = ov.name;
    parseInto(op.lines, ctx);
    if (!ctx.plugin) ctx.problems.push({ sev: 'warn', file: ov.name, line: 1, msg: `${ov.name} has no /plugin/; line - dtc -@ would build it as a full tree, not an overlay` });
    flats.push({ name: ov.name, overlay: true, text: op.lines.map((l) => l.text).join('\n'), origin: compactOrigin(op.lines) });
  }
  // aliases (for &{alias} and the stdout-path check)
  const aliasNode = root.child('aliases');

  // ---------- flatten ----------
  const nodes = [];
  const idx = new Map();
  const walk = (n, depth) => { idx.set(n, nodes.length); nodes.push({ n, depth }); n.children.forEach((c) => walk(c, depth + 1)); };
  walk(root, 0);
  const P = (n, k) => { const p = n.props.get(k); return p && !p.deleted ? p : null; };
  const num = (n, k) => { const c = cellList(P(n, k)); return c.length && !c[0].ref ? Number(c[0].n) : null; };
  const pathOf = (n) => n.path;
  const findings = [];
  const add = (sev, msg, ns = [], loc = null, kind = '') => {
    findings.push({ sev, msg, nodes: ns.filter(Boolean).map((x) => (x instanceof Node ? idx.get(x) : x)).filter((x) => x != null), file: loc?.file || null, line: loc?.line || null, kind });
  };
  const byPath = new Map(nodes.map((x, i) => [x.n.path, i]));
  for (const p of ctx.problems) {
    add(p.sev, p.msg, (p.nodes || []).map((q) => byPath.get(q)), p, p.fatal ? 'syntax' : p.macro ? 'macro' : p.undef ? 'label' : 'source');
  }

  const resolveRef = (r) => {
    if (!r) return null;
    if (r.label) return ctx.labels.get(r.label) || null;
    let p = r.path;
    if (!p.startsWith('/') && aliasNode) { const a = strings(P(aliasNode, p))[0]; if (a) p = a; }
    let n = root;
    for (const part of p.split('/').filter(Boolean)) {
      n = n.children.find((c) => c.name === part) || n.children.find((c) => c.name.split('@')[0] === part);
      if (!n) return null;
    }
    return n;
  };

  // ---------- status ----------
  const own = (n) => { const s = strings(P(n, 'status'))[0]; return s == null || s === 'okay' || s === 'ok'; };
  const eff = new Map();
  for (const { n } of nodes) eff.set(n, own(n) && (!n.parent || eff.get(n.parent)));
  for (const { n } of nodes) {
    const s = strings(P(n, 'status'))[0];
    if (s != null && !['okay', 'ok', 'disabled', 'reserved', 'fail'].includes(s) && !s.startsWith('fail-')) add('warn', `${n.path}: status "${s}" is not okay/disabled/reserved/fail - the kernel treats it as disabled`, [n], P(n, 'status'), 'status');
    if ((s === 'okay' || s === 'ok') && n.parent && !eff.get(n.parent)) {
      let up = n.parent; while (up.parent && own(up)) up = up.parent;
      add('warn', `${n.path} is "okay" but ${up.path} above it is disabled, so it is never probed - enable ${up.labels[0] ? '&' + up.labels[0] : up.path} too`, [n, up], P(n, 'status'), 'status');
    }
  }

  // ---------- cells, reg, ranges, translation ----------
  const cellsFor = (bus) => {
    const ac = num(bus, '#address-cells'), sc = num(bus, '#size-cells');
    return { ac: ac ?? 2, sc: sc ?? 1, acMissing: ac == null, scMissing: sc == null };
  };
  const warnedBus = new Set();
  const regs = new Map();   // node -> [{addr, size, cpu, why}]
  const join = (cells) => cells.reduce((a, c) => (a << 32n) | (c.n ?? 0n), 0n);
  const translate = (node, addr, size) => {
    let bus = node.parent, a = addr;
    const hops = [];
    while (bus && bus.parent) {
      const r = P(bus, 'ranges');
      if (!r) return { cpu: null, why: `${bus.name || "/"} has no ranges: addresses below it are local to that bus`, local: true };
      const cl = cellList(r);
      if (cl.length) {
        const { ac: cac, sc: csc } = cellsFor(bus);
        const { ac: pac } = cellsFor(bus.parent);
        const stride = cac + pac + csc;
        let hit = null;
        for (let i = 0; i + stride <= cl.length; i += stride) {
          const ca = join(cl.slice(i, i + cac)), pa = join(cl.slice(i + cac, i + cac + pac)), len = join(cl.slice(i + cac + pac, i + stride));
          if (a >= ca && a < ca + len) { hit = { ca, pa, len }; break; }
        }
        if (!hit) return { cpu: null, why: `is outside every ranges window of ${bus.name || "/"}${a !== addr ? ` (as ${hex(a)})` : ''}`, bad: bus };
        if (a + size > hit.ca + hit.len) hops.push(`runs past the end of ${bus.name || "/"}'s ranges window (${hex(hit.pa)}+${hex(hit.len)})`);
        hops.push(`${bus.name || "/"}: ${hex(hit.ca)}->${hex(hit.pa)}`);
        a = hit.pa + (a - hit.ca);
      }
      bus = bus.parent;
    }
    return { cpu: a, hops };
  };
  for (const { n } of nodes) {
    const rp = P(n, 'ranges');
    if (rp && cellList(rp).length && n.parent) {
      const { ac: cac, sc: csc } = cellsFor(n); const { ac: pac } = cellsFor(n.parent);
      if (cellList(rp).length % (cac + pac + csc)) add('error', `${n.path}: ranges has ${cellList(rp).length} cells, not a multiple of ${cac}+${pac}+${csc} (child address + parent address + size cells)`, [n], rp, 'cells');
    }
    const reg = P(n, 'reg');
    if (!reg || !n.parent) continue;
    const bus = n.parent;
    const c = cellsFor(bus);
    if ((c.acMissing || c.scMissing) && !warnedBus.has(bus)) {
      warnedBus.add(bus);
      const miss = [c.acMissing && '#address-cells', c.scMissing && '#size-cells'].filter(Boolean).join(' and ');
      add('warn', `${bus.path} has children with reg but no ${miss}: the defaults ${c.acMissing ? '#address-cells = <2>' : ''}${c.acMissing && c.scMissing ? ', ' : ''}${c.scMissing ? '#size-cells = <1>' : ''} apply, which is rarely what an ${(bus.name || "root").split('@')[0]} bus wants`, [bus], bus.defs[0], 'cells');
    }
    const cl = cellList(reg);
    if (cl.some((x) => x.ref)) { add('error', `${n.path}: reg holds a phandle`, [n], reg, 'cells'); continue; }
    const stride = c.ac + c.sc;
    if (!cl.length || cl.length % stride) {
      add('error', `${n.path}: reg has ${cl.length} cells but ${bus.name || "/"} says ${c.ac} address + ${c.sc} size = ${stride} per entry${c.acMissing || c.scMissing ? ' (defaults)' : ''}`, [n, bus], reg, 'cells');
      continue;
    }
    const list = [];
    for (let i = 0; i < cl.length; i += stride) {
      const addr = join(cl.slice(i, i + c.ac)), size = c.sc ? join(cl.slice(i + c.ac, i + stride)) : 0n;
      const t = c.sc ? translate(n, addr, size) : { cpu: null, why: `${bus.name || "/"} has #size-cells = <0>: a bus-local address (chip select or device address)`, local: true };
      if (t.bad) add('error', `${n.path}: reg ${hex(addr)} ${t.why} - it has no CPU address`, [n, t.bad], reg, 'ranges');
      list.push({ addr, size, ...t });
    }
    regs.set(n, list);
    // unit address vs reg (dtc checks.c)
    const unit = n.name.includes('@') ? n.name.split('@')[1] : null;
    const first = list[0].addr.toString(16);
    if (unit == null) {
      if (n.parent.parent || true) add('warn', `${n.path} has reg but no unit address - name it ${n.name}@${first} (dtc: unit_address_vs_reg)`, [n], n.defs[0], 'unit');
    } else if (!unit.includes(',') && unit.toLowerCase().replace(/^0+(?=.)/, '') !== first) {
      add('warn', `${n.path}: unit address @${unit} but reg starts at ${hex(list[0].addr)} - one of them is wrong (dtc: unit address and first address in "reg" do not match)`, [n], reg, 'unit');
    }
  }
  for (const { n } of nodes) {
    if (n.parent && n.name.includes('@') && !P(n, 'reg') && !P(n, 'ranges') && !n.name.startsWith('fragment@')) {
      add('warn', `${n.path} has a unit address but no reg or ranges (dtc: unit_address_vs_reg)`, [n], n.defs[0], 'unit');
    }
  }

  // ---------- the CPU address map ----------
  const map = [];
  for (const [n, list] of regs) for (const r of list) if (r.cpu != null && r.size > 0n) map.push({ n, start: r.cpu, end: r.cpu + r.size, size: r.size });
  map.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0) || (a.end > b.end ? -1 : 1));
  const isAnc = (a, b) => { for (let x = b.parent; x; x = x.parent) if (x === a) return true; return false; };
  const under = (n, name) => { for (let x = n; x; x = x.parent) if (x.name === name) return true; return false; };
  const isMem = (n) => strings(P(n, 'device_type'))[0] === 'memory';
  const clash = new Set();
  for (let i = 0; i < map.length; i++) {
    for (let j = i + 1; j < map.length && map[j].start < map[i].end; j++) {
      const a = map[i], b = map[j];
      if (a.n === b.n || isAnc(a.n, b.n) || isAnc(b.n, a.n)) continue;
      if (!eff.get(a.n) || !eff.get(b.n)) continue;
      if ((under(a.n, 'reserved-memory') && isMem(b.n)) || (under(b.n, 'reserved-memory') && isMem(a.n))) continue;
      const lo = a.start > b.start ? a.start : b.start, hi = a.end < b.end ? a.end : b.end;
      clash.add(a); clash.add(b);
      add('error', `${a.n.path} [${hex(a.start)}..${hex(a.end - 1n)}] overlaps ${b.n.path} [${hex(b.start)}..${hex(b.end - 1n)}] by ${fmtSize(hi - lo)} - check the size in reg`, [a.n, b.n], P(a.n, 'reg'), 'overlap');
    }
  }

  // ---------- devices sharing an address on a local bus (I2C, SPI, MDIO) ----------
  for (const { n } of nodes) {
    const kids = n.children.filter((k) => eff.get(k) && regs.get(k)?.[0]?.local);
    const seen = new Map();
    for (const k of kids) {
      const a = regs.get(k)[0].addr;
      const key = a.toString();
      if (seen.has(key)) {
        const o = seen.get(key);
        const what = cellsFor(n).sc === 0 ? (/spi/.test(n.name) ? 'chip select' : 'address') : 'address';
        add('error', `${o.name} and ${k.name} on ${n.path} both use ${what} ${hex(a)}${eff.get(n) ? '' : ' (bus disabled)'} - the second one fails to probe (-EBUSY)`, [o, k, n], P(k, 'reg'), 'bus');
      } else seen.set(key, k);
    }
  }

  // ---------- references: undefined labels, specifiers, disabled providers ----------
  const refBy = new Map();
  const undefSeen = new Set(ctx.problems.filter((p) => p.undef).map((p) => p.undef));
  const specs = new Map();   // node -> prop -> [{target, args}]
  for (const { n } of nodes) {
    for (const [pname, p] of n.props) {
      if (p.deleted) continue;
      const refs = [];
      for (const part of p.value) {
        if (part.t === 'ref') refs.push({ r: part.v, at: part.at });
        if (part.t === 'cells') for (const x of part.v) if (x.ref) refs.push({ r: x.ref, at: x.at });
      }
      for (const { r, at } of refs) {
        const t = resolveRef(r);
        if (!t) {
          const nm = r.label ? '&' + r.label : `&{${r.path}}`;
          const key = `${nm}@${at?.file}:${at?.line}`;
          if (!undefSeen.has(key)) { undefSeen.add(key); add('error', `${n.path}: ${pname} points to ${nm}, which no file defines - dtc stops with "Reference to non-existent node or label"`, [n], at || p, 'label'); }
          continue;
        }
        if (!refBy.has(t)) refBy.set(t, new Set());
        refBy.get(t).add(n);
      }
      // phandle + specifier lists
      const key = specKey(pname);
      if (key) {
        const cl = cellList(p), out = [];
        for (let i = 0; i < cl.length;) {
          const x = cl[i];
          if (!x.ref) { if (x.n === 0n) { out.push({ target: null, args: [] }); i++; continue; } add('warn', `${n.path}: ${pname} cell ${i + 1} should be a phandle (&label) but is ${hex(x.n)}`, [n], p, 'spec'); break; }
          const t = resolveRef(x.ref);
          if (!t) { i++; while (i < cl.length && !cl[i].ref) i++; continue; }
          const cprop = SPEC[key];
          const want = cprop ? num(t, cprop) : 0;
          if (cprop && want == null) { add('error', `${n.path}: ${pname} points to ${t.path}, which has no ${cprop} - it is not a ${key.replace(/s$/, '')} provider`, [n, t], p, 'spec'); break; }
          const args = cl.slice(i + 1, i + 1 + want);
          if (args.length < want || args.some((a) => a.ref)) { add('error', `${n.path}: ${pname} gives ${args.filter((a) => !a.ref).length} cells after &${x.ref.label || x.ref.path} but ${t.name} has ${cprop} = <${want}>`, [n, t], p, 'spec'); break; }
          out.push({ target: t, args: args.map((a) => a.n) });
          if (eff.get(n) && !eff.get(t)) add('warn', `${n.path}: ${pname} uses ${t.path}, which is disabled - the driver waits for it forever (probe deferral)`, [n, t], p, 'disabled-provider');
          i += 1 + want;
        }
        if (!specs.has(n)) specs.set(n, new Map());
        specs.get(n).set(pname, out);
      }
      if (/-supply$/.test(pname) && eff.get(n)) {
        const r = p.value[0]?.t === 'cells' ? p.value[0].v[0]?.ref : null;
        const t = r ? resolveRef(r) : null;
        if (t && !eff.get(t)) add('warn', `${n.path}: ${pname} is ${t.path}, which is disabled - the consumer defers probe`, [n, t], p, 'disabled-provider');
      }
    }
  }

  // ---------- interrupts ----------
  const irqParent = (n) => {
    for (let x = n; x; x = x.parent) {
      const ip = P(x, 'interrupt-parent');
      if (ip) { const r = cellList(ip)[0]?.ref; return r ? resolveRef(r) : null; }
      if (x !== n && P(x, 'interrupt-controller') && x === n.parent) return x;
    }
    return null;
  };
  for (const { n } of nodes) {
    const ip = P(n, 'interrupts');
    if (!ip) continue;
    const ctl = irqParent(n);
    if (!ctl) { add('warn', `${n.path} has interrupts but no interrupt-parent anywhere above it`, [n], ip, 'irq'); continue; }
    const cells = num(ctl, '#interrupt-cells');
    if (cells == null) { add('error', `${n.path}: its interrupt parent ${ctl.path} has no #interrupt-cells`, [n, ctl], ip, 'irq'); continue; }
    if (!P(ctl, 'interrupt-controller') && !P(ctl, 'interrupt-map')) add('warn', `${n.path}: interrupt parent ${ctl.path} is not marked interrupt-controller`, [n, ctl], ip, 'irq');
    const len = cellList(ip).length;
    if (len % cells) add('error', `${n.path}: interrupts has ${len} cells but ${ctl.name} takes ${cells} per interrupt`, [n, ctl], ip, 'irq');
    if (eff.get(n) && !eff.get(ctl)) add('warn', `${n.path}: its interrupt parent ${ctl.path} is disabled`, [n, ctl], ip, 'disabled-provider');
  }

  // ---------- pinctrl: pins claimed twice ----------
  const pinName = amPinNames(macros);
  const groupPins = (g) => {
    const out = [];
    const ps = P(g, 'pinctrl-single,pins') || P(g, 'pinctrl-single,bits');
    if (ps) {
      let ctl = g; while (ctl && !P(ctl, '#pinctrl-cells')) ctl = ctl.parent;
      const per = (ctl ? num(ctl, '#pinctrl-cells') : 1) + 1;
      const cl = cellList(ps);
      for (let i = 0; i + per <= cl.length; i += per) {
        const off = cl[i].n;
        const nm = pinName.get(off);
        out.push({ id: 'off:' + off, label: nm ? `${nm} (${hex(off)})` : `offset ${hex(off)}`, mux: per > 1 ? Number(cl[i + per - 1].n) & 0x7 : null });
      }
    }
    const fp = P(g, 'fsl,pins');
    if (fp) { const cl = cellList(fp); for (let i = 0; i + 6 <= cl.length; i += 6) out.push({ id: 'mux:' + cl[i].n, label: `mux_reg ${hex(cl[i].n)}` }); }
    const rp = P(g, 'rockchip,pins');
    if (rp) { const cl = cellList(rp); for (let i = 0; i + 4 <= cl.length; i += 4) out.push({ id: `rk:${cl[i].n}:${cl[i + 1].n}`, label: `GPIO${cl[i].n}_${'ABCD'[Number(cl[i + 1].n) >> 3] || '?'}${Number(cl[i + 1].n) & 7}` }); }
    const pm = P(g, 'pinmux');
    if (pm) for (const x of cellList(pm)) { if (x.ref) continue; const pin = Number(x.n >> 8n); out.push({ id: 'pin:' + pin, label: `P${String.fromCharCode(65 + (pin >> 4))}${pin & 15}` }); }
    const pn = P(g, 'pins');
    if (pn) for (const s of strings(pn)) out.push({ id: 'name:' + s, label: s });
    for (const k of g.children) if (!P(k, 'status') || own(k)) out.push(...groupPins(k));
    return out;
  };
  const claims = new Map();   // pin id -> [{consumer, group, label}]
  const pinUse = [];
  for (const { n } of nodes) {
    if (!eff.get(n)) continue;
    const names = strings(P(n, 'pinctrl-names'));
    const di = names.length ? names.indexOf('default') : 0;
    if (di < 0) continue;
    const pc = P(n, `pinctrl-${di}`);
    if (!pc) continue;
    for (const x of cellList(pc)) {
      if (!x.ref) continue;
      const g = resolveRef(x.ref);
      if (!g) continue;
      for (const pin of groupPins(g)) {
        if (!claims.has(pin.id)) claims.set(pin.id, []);
        claims.get(pin.id).push({ consumer: n, group: g, label: pin.label, mux: pin.mux });
        pinUse.push({ pin: pin.label, g: idx.get(g), c: idx.get(n), mux: pin.mux });
      }
    }
  }
  for (const [, list] of claims) {
    const cons = [...new Set(list.map((c) => c.consumer))];
    if (cons.length < 2) continue;
    const who = list.map((c) => `${c.consumer.labels[0] ? '&' + c.consumer.labels[0] : c.consumer.path} (${c.group.name}${c.mux != null ? `, mode ${c.mux}` : ''})`);
    add('error', `pin ${list[0].label} is muxed by ${[...new Set(who)].join(' and ')} - whichever probes second gets -EINVAL from pinctrl`, [...cons, ...new Set(list.map((c) => c.group))], P(list[1].group, 'pinctrl-single,pins') || list[1].group.defs[0], 'pinmux');
  }

  // ---------- chosen / aliases ----------
  const chosen = root.child('chosen');
  const sp = chosen && P(chosen, 'stdout-path');
  if (sp) {
    const v = sp.value[0];
    const t = v?.t === 'ref' ? resolveRef(v.v) : v?.t === 'str' ? resolveRef({ path: v.v.split(':')[0] }) : null;
    if (t && !eff.get(t)) add('warn', `chosen/stdout-path is ${t.path}, which is disabled: no console`, [t], sp, 'status');
  }

  // ---------- counts, order ----------
  const sevRank = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => sevRank[a.sev] - sevRank[b.sev]);
  const fcount = { error: 0, warn: 0, info: 0 };
  for (const f of findings) fcount[f.sev]++;
  const findsOf = new Map();
  findings.forEach((f, i) => f.nodes.forEach((ni) => { if (!findsOf.has(ni)) findsOf.set(ni, []); findsOf.get(ni).push(i); }));

  // ---------- selected node ----------
  const want = String(input.node ?? '').trim();
  let sel = null;
  if (want) {
    const w = want.replace(/^&/, '');
    sel = ctx.labels.get(w) || resolveRef({ path: w.startsWith('/') ? w : '/' + w }) || nodes.find((x) => x.n.name === w)?.n || null;
    if (!sel) warnings.push(`Node ${want} is not in the merged tree: give a label (uart1), a path (/ocp/serial@...) or a node name.`);
  }

  // ---------- the drawing data ----------
  const nodeRef = (t) => (t ? idx.get(t) : null);
  const fmtProp = (n, p) => {
    const v = fmtValue(p.value);
    const out = { name: p.name, v: v.length > 600 ? v.slice(0, 600) + ' ...' : v, file: p.file, line: p.line, del: p.deleted || undefined };
    if (p.trail.length > 1 || p.deleted) out.trail = p.trail.map((t) => ({ a: t.action, v: t.action === 'set' ? trunc(fmtValue(t.value), 120) : '', file: t.file, line: t.line }));
    const refs = [];
    for (const part of p.value) {
      if (part.t === 'ref') refs.push({ t: part.v.label ? '&' + part.v.label : `&{${part.v.path}}`, i: nodeRef(resolveRef(part.v)) });
      if (part.t === 'cells') for (const x of part.v) if (x.ref) refs.push({ t: x.ref.label ? '&' + x.ref.label : `&{${x.ref.path}}`, i: nodeRef(resolveRef(x.ref)) });
    }
    if (refs.length) out.refs = refs;
    const sp2 = specs.get(n)?.get(p.name);
    if (sp2 && sp2.length) out.spec = sp2.map((e) => (e.target ? `${e.target.labels[0] || e.target.name} ${e.args.map((a) => (a < 10n ? a.toString() : hex(a))).join(' ')}`.trim() : '(none)'));
    if (p.name === 'reg' && regs.get(n)) out.reg = regs.get(n).map((r) => ({ addr: hex(r.addr), size: hex(r.size), cpu: r.cpu != null ? hex(r.cpu) : null, why: r.why || null, hops: r.hops || [] }));
    if (p.name === 'status') out.status = true;
    return out;
  };
  const view = {
    main: mainName,
    nodes: nodes.map(({ n, depth }, i) => ({
      i, name: n.name || '/', path: n.path, depth, parent: n.parent ? idx.get(n.parent) : -1,
      labels: n.labels, status: strings(P(n, 'status'))[0] ?? null, on: own(n), eff: eff.get(n),
      compat: strings(P(n, 'compatible'))[0] || null,
      defs: dedupeLoc(n.defs),
      props: [...n.props.values()].map((p) => fmtProp(n, p)),
      kids: n.children.map((c) => idx.get(c)),
      refBy: [...(refBy.get(n) || [])].map((x) => idx.get(x)),
      finds: findsOf.get(i) || [],
      cpu: (regs.get(n) || []).filter((r) => r.cpu != null).map((r) => hex(r.cpu)),
    })),
    map: map.map((m) => ({ i: idx.get(m.n), start: hex(m.start), end: hex(m.end - 1n), size: hex(m.size), human: fmtSize(m.size), on: eff.get(m.n), bad: clash.has(m) })),
    findings,
    deleted: ctx.deleted.map((d) => ({ path: d.path, file: d.file, line: d.line })),
    flats,
    files: [...files.map((f) => ({ name: f.name, kind: f === files[0] ? 'main' : 'include', used: f === files[0] || pre.included.includes(f.name) })), ...overlays.map((f) => ({ name: f.name, kind: 'overlay', used: true }))],
    sel: sel ? idx.get(sel) : null,
    pins: pinUse.slice(0, 300),
  };

  // ---------- agent-facing result ----------
  const enabled = nodes.filter((x) => eff.get(x.n)).length;
  const values = [
    { label: 'Nodes', value: nodes.length, hint: `${enabled} enabled, ${nodes.length - enabled} disabled` },
    { label: 'Files merged', value: 1 + pre.included.length + overlays.length, hint: [mainName, ...pre.included, ...overlays.map((o) => o.name)].join(', ').slice(0, 120) },
    { label: 'Labels', value: ctx.labels.size },
    { label: 'Mapped regions', value: map.length, hint: 'reg translated to CPU physical addresses' },
    { label: 'Errors', value: fcount.error, tone: fcount.error ? 'bad' : 'ok' },
    { label: 'Warnings', value: fcount.warn, tone: fcount.warn ? 'warn' : 'ok' },
  ];
  const tables = [];
  if (findings.length) tables.push({ title: 'Findings', columns: ['Severity', 'Where', 'Finding'], rows: findings.slice(0, 60).map((f) => [f.sev, f.file ? `${f.file}:${f.line}` : '', f.msg]) });
  if (map.length) tables.push({ title: 'CPU physical address map (enabled and disabled)', columns: ['Start', 'End', 'Size', 'Node', 'Status'], rows: map.slice(0, 120).map((m) => [hex(m.start), hex(m.end - 1n), fmtSize(m.size), m.n.path, eff.get(m.n) ? 'okay' : 'disabled']) });
  if (sel) {
    const v = view.nodes[idx.get(sel)];
    tables.push({ title: `Node ${sel.path}${sel.labels.length ? ' (' + sel.labels.map((l) => l + ':').join(' ') + ')' : ''}${eff.get(sel) ? '' : ' - disabled'}`, columns: ['Property', 'Value', 'Set in', 'History'],
      rows: v.props.map((p) => [p.name, p.del ? '(deleted)' : p.v + (p.reg ? '  => CPU ' + p.reg.map((r) => r.cpu || 'local').join(', ') : '') + (p.spec ? '  => ' + p.spec.join('; ') : ''), `${p.file}:${p.line}`,
        (p.trail || []).slice(0, -1).map((t) => `${t.a === 'delete' ? 'deleted' : t.v || '(set, no value)'} @ ${t.file}:${t.line}`).join(' | ')]) });
  }
  // The whole tree for a real board runs to tens of KB: cap it, and give the
  // chosen node's subtree on its own.
  let whole = printTree(root, P, ctx.memreserve);
  if (whole.length > 24000) { whole = whole.slice(0, 24000).replace(/\n[^\n]*$/, '') + '\n\n/* ... cut at 24 KB: inspect a node to get its subtree in full */\n'; notes.push('The merged tree text is cut at 24 KB; the Node subtree output has the chosen node in full.'); }
  const texts = [{ title: 'Merged tree', body: whole, lang: 'dts' }];
  if (sel && sel !== root) texts.push({ title: 'Node subtree', body: printTree(sel, P, [], true), lang: 'dts' });
  for (const f of findings.filter((x) => x.sev === 'error').slice(0, 12)) warnings.push(`${f.file ? f.file + ':' + f.line + ': ' : ''}${f.msg}`);
  if (fcount.error > 12) warnings.push(`... and ${fcount.error - 12} more errors (see Findings).`);
  if (!String(input.dts ?? '').trim()) warnings.push('The main .dts is empty: paste a board .dts (and its .dtsi files as extra files).');
  notes.push('Merge order: the main file with its #include/include files in place, then each overlay in list order, as fdt apply / dtoverlay applies them. A later definition of a property replaces the earlier one; History shows each step.');
  notes.push('The C preprocessor pass handles #include, #define (with arguments), #if/#ifdef; dt-bindings headers bundled: ' + Object.keys(HEADERS).map((h) => h.replace('dt-bindings/', '')).join(', ') + '. Paste any other header as a file tab with its include path as the name.');
  if (map.length) notes.push('CPU addresses come from reg translated through each parent bus\'s ranges up to the root; a bus without ranges (I2C, SPI, MDIO) keeps its children\'s addresses local.');
  return { values, tables, texts, warnings, notes, view };
}

// ---------------------------------------------------------------------------
function trunc(s, n) { return s.length > n ? s.slice(0, n) + ' ...' : s; }
function dedupeLoc(list) {
  const seen = new Set(), out = [];
  for (const d of list) { const k = `${d.file}:${d.line}`; if (!seen.has(k)) { seen.add(k); out.push({ file: d.file, line: d.line }); } }
  return out;
}
/** [[file, firstLine, count], ...] runs, so a flat source line maps back to its file. */
function compactOrigin(lines) {
  const out = [];
  let run = null;
  for (const l of lines) {
    if (run && run[0] === l.file && l.line === run[1] + run[2]) run[2]++;
    else { run = [l.file, l.line, 1]; out.push(run); }
  }
  return out;
}
export function fmtSize(b) {
  const v = BigInt(b);
  const units = [[1n << 30n, 'GiB'], [1n << 20n, 'MiB'], [1n << 10n, 'KiB']];
  for (const [u, s] of units) if (v >= u && v % (u / 4n) === 0n) return `${Number(v) / Number(u)} ${s}`;
  for (const [u, s] of units) if (v >= u) return `${(Number(v) / Number(u)).toFixed(1)} ${s}`;
  return `${v} B`;
}
/** AM335X_PIN_* macros (dt-bindings/pinctrl/am33xx.h) by the offset AM33XX_PADCONF puts in the cells (pin - 0x800). */
function amPinNames(macros) {
  const out = new Map();
  for (const [k, m] of macros) {
    if (!k.startsWith('AM335X_PIN_') || m.params) continue;
    try { const v = evalExpr(expandMacros(m.body, macros)); out.set(v - 0x800n, k.slice(11)); } catch { /* not a number */ }
  }
  return out;
}
function printTree(root, P, memreserve, sub = false) {
  const out = sub ? [`/* ${root.path} */`] : ['/dts-v1/;', ''];
  for (const m of memreserve) out.push(`/memreserve/ ${hex(m.start)} ${hex(m.size)};`);
  if (memreserve.length) out.push('');
  const node = (n, ind) => {
    const pad = '\t'.repeat(ind);
    const head = n.parent || sub ? `${n.labels.map((l) => l + ': ').join('')}${n.name}` : '/';
    out.push(`${pad}${head} {`);
    for (const p of n.props.values()) {
      if (p.deleted) continue;
      const v = fmtValue(p.value);
      const sets = p.trail.filter((t) => t.action === 'set');
      const note = sets.length > 1 ? `\t/* ${p.file}:${p.line}, over ${sets.slice(0, -1).map((t) => `${t.file}:${t.line}`).join(', ')} */` : '';
      out.push(`${pad}\t${p.name}${v ? ' = ' + v : ''};${note}`);
    }
    n.children.forEach((c, i) => { if (i || n.props.size) out.push(''); node(c, ind + 1); });
    out.push(`${pad}};`);
  };
  node(root, 0);
  return out.join('\n') + '\n';
}
