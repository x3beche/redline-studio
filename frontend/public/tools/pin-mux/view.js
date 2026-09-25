// Pin Mux Explorer: the page is the chip, pin by pin.
//   Package - the MCU's real package (LQFP48, QFN-56, DIP-28) with every pin
//             in its place and number order: supply pins grey, used pins in
//             their peripheral's colour, conflicts red on the pin itself, the
//             pins that offer the searched function ringed. Click a pin (or
//             walk the pins with the arrow keys) to open its mux.
//   Mux     - drawn inside the package body: the selected pin's alternate
//             functions with their remap setting. Pick one to put it on the
//             pin (a signal already placed elsewhere moves here), or free it.
//   Side    - the planned assignment as a list (click a row to find its pin),
//             the AFIO remap each peripheral needs, messages, outputs.
// On a narrow screen the package is drawn unfolded: pins 1..N/2 down the
// left, the rest up the right, in the same order around the chip.
// All pin data, states and checks come from run()'s result.package.

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

const PAL = 8;
const CSS = `
.pm { --tool-f0: #1f4ed8; --tool-f1: #d97706; --tool-f2: #0f9d8a; --tool-f3: #a23fbf; --tool-f4: #c2410c; --tool-f5: #0e7490; --tool-f6: #4d7c0f; --tool-f7: #be185d;
  --tool-pwr: #9aa7b3; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .pm { --tool-f0: #7ea2ff; --tool-f1: #f0a33a; --tool-f2: #3cc7b3; --tool-f3: #c982e0; --tool-f4: #fb8c5a; --tool-f5: #4cc3e0; --tool-f6: #a3d45a; --tool-f7: #f07ab0; --tool-pwr: #3a4854; } }
:root[data-theme="dark"] .pm { --tool-f0: #7ea2ff; --tool-f1: #f0a33a; --tool-f2: #3cc7b3; --tool-f3: #c982e0; --tool-f4: #fb8c5a; --tool-f5: #4cc3e0; --tool-f6: #a3d45a; --tool-f7: #f07ab0; --tool-pwr: #3a4854; }
.pm { display: grid; grid-template-columns: minmax(0, 1fr) 350px; gap: 12px; align-items: start; min-width: 0; }
@media (max-width: 1040px) { .pm { grid-template-columns: minmax(0, 1fr); } }
.pm-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.pm-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.pm-head { display: flex; align-items: center; gap: 6px 12px; flex-wrap: wrap; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.pm-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.pm-sub { font-size: 11.5px; color: var(--ink-soft); }
.pm-sub b { font: 500 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.pm-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; flex-wrap: wrap; }
.pm-seg button { border: 0; background: var(--surface); padding: 3px 9px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.pm-seg button + button { border-left: 1px solid var(--line); }
.pm-seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.pm-find { display: flex; align-items: center; gap: 6px; margin-left: auto; font-size: 11.5px; color: var(--ink-soft); }
.pm-find input { width: 130px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font: 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.pm-fams { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 10px; border-bottom: 1px solid var(--line-soft); }
.pm-fam { border: 1px solid var(--line); background: var(--surface); border-radius: 10px; padding: 0 8px; font: 11px "IBM Plex Mono", ui-monospace, monospace; cursor: pointer; color: var(--ink-soft); }
.pm-fam:hover { border-color: var(--ink-soft); color: var(--ink); }
.pm-fam[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.pm-fam i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 4px; vertical-align: 0; }
.pm-stage { position: relative; margin: 6px auto 8px; }
.pm-stage svg { display: block; width: 100%; height: auto; user-select: none; -webkit-user-select: none; }
.pm-stage svg text { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.pm-stage svg text.soft { fill: var(--ink-soft); }
.pm-stage svg .pin { cursor: pointer; }
.pm-stage svg .pin.pwr { cursor: default; }
.pm-stage svg .pin:hover .lead { stroke: var(--ink); stroke-width: 1.5; }
.pm-stage svg .pin:focus { outline: none; }
.pm-stage svg .pin:focus-visible .hit { stroke: var(--accent); stroke-width: 1.5; stroke-dasharray: 3 2; fill: color-mix(in srgb, var(--accent) 8%, transparent); }
.pm-mux { position: absolute; display: flex; flex-direction: column; gap: 4px; overflow: auto; padding: 8px; min-width: 0; scrollbar-width: thin; }
.pm-mux .top { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.pm-mux .top b { font: 600 18px "IBM Plex Mono", ui-monospace, monospace; }
.pm-mux .top span { font-size: 11px; color: var(--ink-soft); }
.pm-mux .sp { font-size: 11px; color: var(--warn); line-height: 1.3; }
.pm-mux .hint { font-size: 10.5px; color: var(--ink-soft); }
.pm-fn { display: grid; grid-template-columns: 9px minmax(0, 1fr) auto; align-items: center; gap: 2px 7px; text-align: left; border: 1px solid var(--line);
  background: var(--surface); border-radius: 4px; padding: 3px 6px; cursor: pointer; font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); min-width: 0; }
.pm-fn:hover { border-color: var(--ink-soft); }
.pm-fn i { width: 9px; height: 9px; border-radius: 2px; border: 1.5px solid var(--line); }
.pm-fn .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-fn .rm { font-size: 10px; color: var(--ink-soft); white-space: nowrap; }
.pm-fn .mv { grid-column: 2 / -1; font-size: 10px; color: var(--ink-soft); }
.pm-fn[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; font-weight: 600; }
.pm-fn.bad[aria-pressed="true"] { border-color: var(--danger); box-shadow: 0 0 0 1px var(--danger) inset; }
.pm-fn.match .nm { color: var(--accent); }
.pm-free { align-self: flex-start; }
.pm-mux.below { position: static; border-top: 1px solid var(--line-soft); margin-top: 8px; }
.pm-mux.below .pm-fn { max-width: 420px; }
.pm-help { padding: 4px 10px 8px; font-size: 11.5px; color: var(--ink-soft); border-top: 1px solid var(--line-soft); }
.pm-help kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px; padding: 0 3px; }
.pm-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; color: var(--ink-soft); padding: 5px 10px; border-bottom: 1px solid var(--line-soft); }
.pm-legend i { display: inline-block; width: 12px; height: 8px; border-radius: 1px; margin-right: 4px; vertical-align: 0; border: 1.5px solid transparent; }
.pm-list { display: flex; flex-direction: column; }
.pm-row { display: grid; grid-template-columns: 9px minmax(0, 1fr) auto auto; gap: 1px 8px; align-items: center; padding: 5px 10px; border-bottom: 1px solid var(--line-soft); cursor: pointer; }
.pm-row:hover { background: var(--sunken); }
.pm-row.sel { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.pm-row i { width: 9px; height: 9px; border-radius: 2px; }
.pm-row .sg { font: 600 12px "IBM Plex Mono", ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-row .pn { font: 12px "IBM Plex Mono", ui-monospace, monospace; }
.pm-row .st { font-size: 10.5px; padding: 0 5px; border-radius: 3px; border: 1px solid var(--ok); color: var(--ok); }
.pm-row .st.check { border-color: var(--warn); color: var(--warn); }
.pm-row .st.bad { border-color: var(--danger); color: var(--danger); }
.pm-row .nt { grid-column: 2 / -1; font-size: 10.5px; color: var(--ink-soft); }
.pm-row .x { grid-row: 1; grid-column: 5; border: 0; background: transparent; color: var(--ink-soft); cursor: pointer; font-size: 14px; padding: 0 2px; }
.pm-row { grid-template-columns: 9px minmax(0, 1fr) auto auto auto; }
.pm-add { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto; gap: 6px; padding: 8px 10px; }
.pm-add input { min-width: 0; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.pm-remap { width: 100%; border-collapse: collapse; font-size: 12px; }
.pm-remap td, .pm-remap th { padding: 4px 10px; border-bottom: 1px solid var(--line-soft); text-align: left; }
.pm-remap th { font-weight: 500; color: var(--ink-soft); font-size: 11px; }
.pm-remap td:first-child { font-family: "IBM Plex Mono", ui-monospace, monospace; font-weight: 600; }
.pm-warns { border: 1px solid var(--warn); border-left-width: 3px; border-radius: 6px; padding: 6px 10px; background: var(--surface); font-size: 12px; }
.pm-warns div + div { margin-top: 4px; }
.pm-warns:empty { display: none; }
.pm-notes { font-size: 11.5px; color: var(--ink-soft); padding: 0 2px; }
.pm-notes summary { cursor: pointer; }
.pm-notes div { margin-top: 4px; }
.pm .k-out { max-height: 220px; }
`;

const CHIPS = [['stm32f103c8', 'STM32F103C8'], ['rp2040', 'RP2040'], ['atmega328p', 'ATmega328P']];

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  let res = null;
  let refocus = null;   // 'pin' to focus the selected pin after a redraw, 'mux' for the first function

  // ---------- stage ----------
  const chipSeg = h('div', { class: 'pm-seg', role: 'group', 'aria-label': 'Microcontroller' });
  const findIn = h('input', { type: 'text', spellcheck: 'false', placeholder: 'USART1, PWM3, ADC', 'aria-label': 'Highlight pins offering a function',
    oninput: (e) => ctx.set('find', e.target.value) });
  const stageSub = h('span', { class: 'pm-sub' });
  const fams = h('div', { class: 'pm-fams', role: 'group', 'aria-label': 'Peripherals on this chip' });
  const svg = s('svg', { role: 'group', 'aria-label': 'Package pins' });
  const mux = h('div', { class: 'pm-mux', role: 'group', 'aria-label': 'Functions of the selected pin' });
  const stage = h('div', { class: 'pm-stage' }, svg, mux);
  const legend = h('div', { class: 'pm-legend' },
    h('span', {}, h('i', { style: 'background:var(--tool-f0)' }), 'used (colour = peripheral)'),
    h('span', {}, h('i', { style: 'background:var(--sunken);border-color:var(--line)' }), 'free I/O'),
    h('span', {}, h('i', { style: 'background:var(--tool-pwr)' }), 'supply / no GPIO'),
    h('span', {}, h('i', { style: 'background:transparent;border-color:var(--accent)' }), 'offers the searched function'),
    h('span', {}, h('i', { style: 'background:var(--danger)' }), 'conflict'),
    h('span', {}, h('i', { style: 'background:transparent;border-color:var(--warn)' }), 'special pin'));
  const stageCard = h('section', { class: 'pm-card' },
    h('div', { class: 'pm-head' }, chipSeg, stageSub, h('label', { class: 'pm-find' }, 'Highlight', findIn)),
    fams, legend, stage,
    h('div', { class: 'pm-help' }, 'Click a pin to open its mux inside the chip, then pick the function it should carry. Keyboard: ',
      h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' walk the pins in number order, ', h('kbd', {}, 'Enter'), ' opens the mux.'));

  // ---------- side ----------
  const list = h('div', { class: 'pm-list', role: 'list' });
  const listSub = h('span', { class: 'pm-sub' });
  const addSig = h('input', { type: 'text', spellcheck: 'false', placeholder: 'USART2_TX', 'aria-label': 'Function to add' });
  const addPin = h('input', { type: 'text', spellcheck: 'false', placeholder: 'PA2', 'aria-label': 'Pin for it' });
  const add = () => {
    if (!addSig.value.trim() && !addPin.value.trim()) return;
    const r = rows(); r.push({ signal: addSig.value.trim(), pin: addPin.value.trim() });
    addSig.value = ''; addPin.value = '';
    ctx.set('assign', r);
  };
  addPin.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  const listCard = h('section', { class: 'pm-card' },
    h('div', { class: 'pm-head' }, h('h2', {}, 'Assignment'), listSub), list,
    h('div', { class: 'pm-add' }, addSig, addPin, h('button', { class: 'k-btn', onclick: add }, 'Add')));
  const remapBody = h('div', {});
  const remapCard = h('section', { class: 'pm-card' }, h('div', { class: 'pm-head' }, h('h2', {}, 'AFIO remap'), h('span', { class: 'pm-sub' }, 'AFIO_MAPR, per peripheral')), remapBody);
  const warns = h('div', { class: 'pm-warns', role: 'status', 'aria-live': 'polite' });
  const notes = h('details', { class: 'pm-notes' });

  root.append(h('div', { class: 'pm' },
    h('div', { class: 'pm-col' }, stageCard),
    h('aside', { class: 'pm-col' }, listCard, warns, remapCard, ctx.outputs, notes)));

  // A chip switch starts from a plan that fits that chip: the manifest's
  // default or example for it, a small one for the ATmega.
  const startFor = (chip) => {
    const d = Object.fromEntries(ctx.manifest.inputs.map((x) => [x.key, x.default]));
    if (d.chip === chip) return { chip, pin: d.pin, find: d.find, assign: structuredClone(d.assign) };
    const ex = (ctx.manifest.examples || []).find((e) => e.input.chip === chip);
    if (ex) return { chip, pin: ex.input.pin, find: ex.input.find, assign: structuredClone(ex.input.assign) };
    return { chip, pin: 'PB1', find: 'OC', assign: [{ signal: 'RXD', pin: 'PD0' }, { signal: 'TXD', pin: 'PD1' }, { signal: 'SDA', pin: 'PC4' }, { signal: 'SCL', pin: 'PC5' }, { signal: 'OC1A', pin: 'PB1' }] };
  };

  // ---------- helpers ----------
  const rows = () => (ctx.raw.assign || []).map((r) => ({ ...r }));
  let famColour = new Map();
  const colourOf = (fam) => (famColour.has(fam) ? `var(--tool-f${famColour.get(fam) % PAL})` : null);
  const pkgPin = (name) => res?.package?.pins.find((p) => p.name === name);
  const familyOfSignal = (sig) => {
    for (const p of res?.package?.pins || []) for (const f of p.funcs) if (f.name === sig) return f.family;
    return null;
  };
  const select = (name, focus) => { refocus = focus || null; if (name !== res?.package?.selected) ctx.set('pin', name); else draw(); };

  // Put `sig` on pin `name`: the pin carries one function, so what was on it
  // goes; a signal already placed on another pin moves here.
  function place(name, sig) {
    const pk = res.package;
    const r = rows();
    const here = pk.assign.filter((a) => a.pin === name).map((a) => a.row);
    const already = pk.assign.find((a) => a.pin === name && a.signal === sig);
    if (already) { r.splice(already.row, 1); refocus = 'mux'; ctx.set('assign', r); return; }
    const other = sig !== 'GPIO' ? pk.assign.find((a) => a.signal === sig && a.pin !== name) : null;
    if (other) r[other.row] = { ...r[other.row], pin: name };
    else r.push({ signal: sig, pin: name });
    const keep = r.filter((_, i) => !here.includes(i));
    refocus = 'mux';
    ctx.set('assign', keep);
  }
  const freePin = (name) => {
    const drop = res.package.assign.filter((a) => a.pin === name).map((a) => a.row);
    refocus = 'pin';
    ctx.set('assign', rows().filter((_, i) => !drop.includes(i)));
  };

  // ---------- geometry ----------
  function layout(pk, avail) {
    const unfold = pk.kind !== 'dip' && avail < 600;
    const dual = pk.kind === 'dip' || unfold;
    if (!dual) {
      const n = pk.count / 4;
      const P = pk.kind === 'qfn' ? 21 : 25, PL = 16, LM = 148;
      const S = n * P + P;
      const W = S + 2 * (PL + LM);
      // Top and bottom margins only as deep as their longest label.
      const labLen = (p) => ((p.name.length + 1) + ((p.use || []).length ? p.use.map((u) => u.signal).join(' + ').length + 1
        : p.match.length ? p.match[0].length + 4 : 0)) * 6.6 + 12;
      const deep = (side) => Math.min(LM, Math.max(60, ...pk.pins.slice(side * n, side * n + n).map(labLen)));
      const MT = deep(3), MB = deep(1);
      const bx = LM + PL, by = MT + PL;
      const H = MT + MB + 2 * PL + S;
      const pins = pk.pins.map((p, i) => {
        const side = Math.floor(i / n), k = i % n;
        if (side === 0) return { p, side, x: LM, y: by + P * (k + 1), dx: -1, dy: 0 };
        if (side === 1) return { p, side, x: bx + P * (k + 1), y: by + S + PL, dx: 0, dy: 1 };
        if (side === 2) return { p, side, x: bx + S + PL, y: by + S - P * (k + 1), dx: 1, dy: 0 };
        return { p, side, x: bx + S - P * (k + 1), y: MT, dx: 0, dy: -1 };
      });
      return { W, H, body: { x: bx, y: by, w: S, h: S }, pins, P, PL, dual: false, unfold: false, maxScale: 1.12 };
    }
    const n = pk.count / 2;
    const P = unfold ? 23 : 27, PL = 14;
    const W = Math.max(300, Math.min(unfold ? avail : 640, avail));
    // Narrow: a slim body carrying the pin names; the mux goes under the drawing.
    const inside = W < 520;
    const LM = inside ? Math.floor((W - 124) / 2) - PL : Math.min(150, Math.floor((W - 130) / 2) - PL);
    const bw = W - 2 * (LM + PL);
    const top = 10;
    const bh = n * P + P;
    const bx = LM + PL, by = top;
    const pins = pk.pins.map((p, i) => (i < n
      ? { p, side: 0, x: LM, y: by + P * (i + 1), dx: -1, dy: 0 }
      : { p, side: 2, x: bx + bw + PL, y: by + bh - P * (i - n + 1), dx: 1, dy: 0 }));
    return { W, H: bh + 2 * top, body: { x: bx, y: by, w: bw, h: bh }, pins, P, PL, dual: true, unfold, inside, maxScale: inside ? 1 : 1.1 };
  }

  // ---------- drawing ----------
  function drawStage() {
    const pk = res?.package;
    chipSeg.replaceChildren(...CHIPS.map(([k, t]) => h('button', { 'aria-pressed': String((pk?.chip || ctx.raw.chip) === k), onclick: () => { if ((pk?.chip || ctx.raw.chip) !== k) ctx.setMany(startFor(k)); } }, t)));
    if (document.activeElement !== findIn) findIn.value = ctx.raw.find || '';
    svg.replaceChildren();
    if (!pk) { mux.replaceChildren(); return; }
    // Families: the colours follow the order signals appear in the assignment.
    famColour = new Map();
    for (const a of pk.assign) { const fam = familyOfSignal(a.signal); if (fam && !famColour.has(fam)) famColour.set(fam, famColour.size); }
    const allFams = [...new Set(pk.pins.flatMap((p) => p.funcs.map((f) => f.family)))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    fams.replaceChildren(...allFams.map((fam) => h('button', { class: 'pm-fam', 'aria-pressed': String(pk.find === fam), title: `Ring the pins that offer ${fam}`,
      onclick: () => ctx.set('find', pk.find === fam ? '' : fam) },
    colourOf(fam) ? h('i', { style: `background:${colourOf(fam)}` }) : null, fam)));
    const io = pk.pins.filter((p) => p.io).length;
    const matches = pk.pins.filter((p) => p.match.length).length;
    stageSub.replaceChildren(h('b', {}, pk.label), ` · ${io} I/O of ${pk.count} pins`, ...(pk.find ? [' · ', h('b', { style: 'color:var(--accent)' }, String(matches)), ` offer ${pk.find}`] : []));

    const avail = Math.max(300, stageCard.clientWidth - 20);
    const L = layout(pk, avail);
    svg.setAttribute('viewBox', `0 0 ${L.W} ${L.H}`);
    stage.style.maxWidth = `${Math.round(L.W * L.maxScale)}px`;
    const b = L.body;
    svg.append(s('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: pk.kind === 'dip' ? 6 : 4, fill: 'var(--sunken)', stroke: 'var(--ink-soft)', 'stroke-width': 1.5 }));
    if (pk.kind === 'dip') svg.append(s('path', { d: `M${b.x + b.w / 2 - 14},${b.y}a14,14 0 0 0 28,0`, fill: 'var(--surface)', stroke: 'var(--ink-soft)', 'stroke-width': 1.2 }));
    svg.append(s('circle', { cx: b.x + 12, cy: b.y + (pk.kind === 'dip' ? 14 : 12), r: 4.5, fill: 'var(--ink-soft)' }));
    if (pk.pad && !L.dual) {
      const m = b.w * 0.2;
      svg.append(s('rect', { x: b.x + m, y: b.y + m, width: b.w - 2 * m, height: b.h - 2 * m, fill: 'none', stroke: 'var(--line)', 'stroke-dasharray': '4 3' }));
    }
    svg.append(s('text', { x: b.x + b.w - (L.dual ? 8 : 30), y: b.y + b.h - (L.dual ? 6 : 16), 'text-anchor': 'end', class: 'soft', style: 'font-size:10px' },
      `${pk.label}${pk.pad && !L.dual ? ` · pad ${pk.count + 1} = ${pk.pad}` : ''}${L.unfold ? ' · unfolded' : ''}`));

    const selName = pk.selected;
    const ioOrder = pk.pins.filter((p) => p.io).map((p) => p.name);
    const tabName = selName || ioOrder[0];
    for (const g of L.pins) {
      const p = g.p;
      const horiz = g.dy === 0;
      const pw = horiz ? L.PL : L.P * 0.56, ph = horiz ? L.P * 0.56 : L.PL;
      const rx = horiz ? g.x : g.x - pw / 2, ry = horiz ? g.y - ph / 2 : g.y - (g.dy < 0 ? L.PL : 0) - (g.dy > 0 ? L.PL : 0);
      // leads start at the body edge
      const leadX = g.dx < 0 ? g.x : g.dx > 0 ? g.x - L.PL : rx;
      const leadY = g.dy < 0 ? g.y : g.dy > 0 ? g.y - L.PL : ry;
      const use = p.use || [];
      const st = use.some((u) => u.status === 'bad') ? 'bad' : use.some((u) => u.status === 'check') ? 'check' : use.length ? 'ok' : '';
      const fam = use.length ? familyOfSignal(use[0].signal) : null;
      const fill = !p.io ? 'var(--tool-pwr)' : st === 'bad' ? 'var(--danger)' : use.length ? (colourOf(fam) || 'var(--ink-soft)') : 'var(--sunken)';
      const sel = p.name === selName && p.io;
      const grp = s('g', { class: `pin${p.io ? '' : ' pwr'}`, 'data-pin': p.io ? p.name : null, tabindex: p.io && p.name === tabName ? 0 : (p.io ? -1 : null),
        role: p.io ? 'button' : null, 'aria-label': p.io ? `Pin ${p.n} ${p.name}${use.length ? `, ${use.map((u) => u.signal).join(' and ')}` : ', free'}${st === 'bad' ? ', conflict' : ''}` : null });
      // label geometry
      const lab = [];
      if (!L.inside) lab.push([p.name, p.io ? (use.length ? 'var(--ink)' : 'var(--ink-soft)') : 'var(--ink-soft)', use.length ? 600 : 400]);
      if (use.length) lab.push([use.map((u) => u.signal).join(' + '), st === 'bad' ? 'var(--danger)' : (colourOf(fam) || 'var(--ink)'), 600]);
      else if (p.match.length) lab.push([p.match[0] + (p.match.length > 1 ? ` +${p.match.length - 1}` : ''), 'var(--accent)', 500]);
      const labLen = lab.reduce((t, [x]) => t + x.length + 1, 0) * 6.6;
      const LBL = (L.dual ? (b.x - L.PL - 6) : 146);
      // hit area over pin and its label
      let hit;
      if (g.dx < 0) hit = { x: g.x - Math.min(LBL, labLen + 14), y: g.y - L.P / 2, w: Math.min(LBL, labLen + 14) + L.PL + 2, h: L.P };
      else if (g.dx > 0) hit = { x: g.x - L.PL - 2, y: g.y - L.P / 2, w: Math.min(LBL, labLen + 14) + L.PL + 2, h: L.P };
      else if (g.dy > 0) hit = { x: g.x - L.P / 2, y: g.y - L.PL - 2, w: L.P, h: Math.min(LBL, labLen + 14) + L.PL + 2 };
      else hit = { x: g.x - L.P / 2, y: g.y - Math.min(LBL, labLen + 14), w: L.P, h: Math.min(LBL, labLen + 14) + L.PL + 2 };
      grp.append(s('rect', { class: 'hit', x: hit.x, y: hit.y, width: hit.w, height: hit.h, rx: 3, fill: sel ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
        stroke: sel ? 'var(--accent)' : 'none', 'stroke-width': 1.2 }));
      const lr = { x: horiz ? leadX : g.x - pw / 2, y: horiz ? g.y - ph / 2 : leadY, w: pw, h: ph };
      grp.append(s('rect', { class: 'lead', x: lr.x, y: lr.y, width: lr.w, height: lr.h, rx: 1.5, fill,
        stroke: p.match.length ? 'var(--accent)' : st === 'check' || (p.special && !use.length) ? 'var(--warn)' : p.io ? 'var(--line)' : 'none',
        'stroke-width': p.match.length ? 2.2 : 1.3 }));
      if (p.match.length) grp.append(s('rect', { x: lr.x - 3, y: lr.y - 3, width: lr.w + 6, height: lr.h + 6, rx: 3, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1, 'stroke-opacity': 0.6 }));
      // pin number inside the body
      const num = s('text', { class: 'soft', style: 'font-size:9px', 'text-anchor': 'middle' }, String(p.n));
      if (L.inside) { num.textContent = g.dx < 0 ? `${p.n} ` : ` ${p.n}`; num.append(s('tspan', { style: `font-size:10.5px;fill:${use.length || !p.io ? 'var(--ink)' : 'var(--ink-soft)'};font-weight:${use.length ? 600 : 400}` }, p.name)); if (g.dx > 0) { num.textContent = ''; num.append(s('tspan', { style: `font-size:10.5px;fill:${use.length || !p.io ? 'var(--ink)' : 'var(--ink-soft)'};font-weight:${use.length ? 600 : 400}` }, p.name), s('tspan', {}, ` ${p.n}`)); } }
      if (g.dx < 0) { num.setAttribute('x', b.x + 9); num.setAttribute('y', g.y + 3); num.setAttribute('text-anchor', 'start'); num.setAttribute('x', b.x + 4); }
      else if (g.dx > 0) { num.setAttribute('x', b.x + b.w - 4); num.setAttribute('y', g.y + 3); num.setAttribute('text-anchor', 'end'); }
      else if (g.dy > 0) { num.setAttribute('x', g.x); num.setAttribute('y', b.y + b.h - 4); }
      else { num.setAttribute('x', g.x); num.setAttribute('y', b.y + 11); }
      grp.append(num);
      // label outside
      const t = s('text', {});
      for (const [txt, col, wgt] of lab) t.append(s('tspan', { style: `fill:${col};font-weight:${wgt}` }, `${txt} `));
      if (g.dx < 0) { t.setAttribute('x', g.x - 5); t.setAttribute('y', g.y + 4); t.setAttribute('text-anchor', 'end'); }
      else if (g.dx > 0) { t.setAttribute('x', g.x + 5); t.setAttribute('y', g.y + 4); }
      else if (g.dy > 0) { t.setAttribute('transform', `translate(${g.x + 4},${g.y + 5}) rotate(90)`); }
      else { t.setAttribute('transform', `translate(${g.x + 4},${g.y - 5}) rotate(-90)`); }
      grp.append(t);
      if (st === 'bad') {
        const cx = g.dx < 0 ? g.x + L.PL / 2 : g.dx > 0 ? g.x - L.PL / 2 : g.x, cy = g.dy < 0 ? g.y + L.PL / 2 : g.dy > 0 ? g.y - L.PL / 2 : g.y;
        grp.append(s('text', { x: cx, y: cy + 4, 'text-anchor': 'middle', style: 'fill:var(--surface);font-weight:700;font-size:11px' }, '!'));
      }
      grp.append(s('title', {}, p.io ? `${p.n} ${p.name}: ${p.funcs.map((f) => f.name).join(', ')}${p.special ? `\n${p.special}` : ''}${use.some((u) => u.note) ? `\n${use.map((u) => u.note).filter(Boolean).join('; ')}` : ''}` : `${p.n} ${p.name}`));
      if (p.io) {
        grp.addEventListener('click', () => select(p.name, 'pin'));
        grp.addEventListener('keydown', (e) => {
          const i = ioOrder.indexOf(p.name);
          let j = null;
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % ioOrder.length;
          if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + ioOrder.length) % ioOrder.length;
          if (e.key === 'Home') j = 0;
          if (e.key === 'End') j = ioOrder.length - 1;
          if (j != null) { e.preventDefault(); select(ioOrder[j], 'pin'); return; }
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (p.name !== selName) select(p.name, 'mux'); else mux.querySelector('.pm-fn')?.focus(); }
        });
      }
      svg.append(grp);
    }

    // The mux: an HTML panel laid over the package body (under the drawing when the body is slim).
    const pad = L.dual ? 24 : 26;
    mux.classList.toggle('below', !!L.inside);
    if (L.inside) mux.removeAttribute('style');
    else Object.assign(mux.style, {
      left: `${((b.x + pad) / L.W) * 100}%`, top: `${((b.y + pad) / L.H) * 100}%`,
      width: `${((b.w - 2 * pad) / L.W) * 100}%`, height: `${((b.h - 2 * pad - (L.dual ? 14 : 10)) / L.H) * 100}%`,
    });
    drawMux(pk);
    if (refocus === 'pin') svg.querySelector(`.pin[data-pin="${selName}"]`)?.focus({ preventScroll: true });
    if (refocus === 'mux') (mux.querySelector('.pm-fn[aria-pressed="true"]') || mux.querySelector('.pm-fn'))?.focus({ preventScroll: true });
  }

  function drawMux(pk) {
    const p = pk.selected ? pkgPin(pk.selected) : null;
    if (!p) {
      mux.replaceChildren(h('div', { class: 'top' }, h('span', {}, 'Click a pin to see what it can do.')));
      return;
    }
    const use = p.use || [];
    const onHere = new Set(use.map((u) => u.signal));
    const bad = new Set(use.filter((u) => u.status === 'bad').map((u) => u.signal));
    const fnBtn = (name, remap, fam, isMatch) => {
      const elsewhere = name !== 'GPIO' ? pk.assign.find((a) => a.signal === name && a.pin !== p.name) : null;
      const col = fam ? colourOf(fam) : null;
      return h('button', { class: `pm-fn${bad.has(name) ? ' bad' : ''}${isMatch ? ' match' : ''}`, type: 'button', 'aria-pressed': String(onHere.has(name)),
        title: onHere.has(name) ? `Take ${name} off ${p.name}` : `Put ${name} on ${p.name}`, onclick: () => place(p.name, name) },
      h('i', { style: col ? `background:${col};border-color:${col}` : null }),
      h('span', { class: 'nm' }, name),
      remap ? h('span', { class: 'rm' }, remap) : h('span', {}),
      elsewhere ? h('span', { class: 'mv' }, `now on ${elsewhere.pin}: moves here`) : null);
    };
    const fnKeys = (e) => {
      const btns = [...mux.querySelectorAll('.pm-fn')];
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
      if (e.key === 'Escape') { e.preventDefault(); svg.querySelector(`.pin[data-pin="${p.name}"]`)?.focus(); }
    };
    mux.onkeydown = fnKeys;
    mux.replaceChildren(...[
      h('div', { class: 'top' }, h('b', {}, p.name), h('span', {}, `pin ${p.n} · ${p.funcs.length} functions`)),
      p.special ? h('div', { class: 'sp' }, p.special) : null,
      ...use.filter((u) => u.note && u.status !== 'ok').map((u) => h('div', { class: 'sp', style: u.status === 'bad' ? 'color:var(--danger)' : null }, `${u.signal}: ${u.note}`)),
      fnBtn('GPIO', null, null, false),
      ...p.funcs.map((f) => fnBtn(f.name, f.remap, f.family, p.match.includes(f.name))),
      use.length ? h('button', { class: 'k-btn pm-free', type: 'button', onclick: () => freePin(p.name) }, 'Free this pin') : null,
      h('div', { class: 'hint' }, 'The pin carries one function: picking another replaces it.')].filter(Boolean));
  }

  function drawSide() {
    const pk = res?.package;
    list.replaceChildren();
    if (!pk) return;
    listSub.replaceChildren(h('b', {}, String(pk.assign.length)), ' signals · ', h('b', { style: pk.issues ? 'color:var(--danger)' : 'color:var(--ok)' }, pk.issues ? `${pk.issues} issue${pk.issues > 1 ? 's' : ''}` : 'no conflicts'));
    for (const a of pk.assign) {
      const fam = familyOfSignal(a.signal);
      const col = colourOf(fam);
      const row = h('div', { class: `pm-row${a.pin === pk.selected ? ' sel' : ''}`, role: 'listitem', tabindex: 0, title: `Show ${a.pin} on the chip`,
        onclick: (e) => { if (e.target.closest('.x')) return; if (pkgPin(a.pin)) select(a.pin, 'pin'); },
        onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); if (pkgPin(a.pin)) select(a.pin, 'pin'); } } },
      h('i', { style: `background:${a.status === 'bad' ? 'var(--danger)' : col || 'var(--ink-soft)'}` }),
      h('span', { class: 'sg' }, a.signal || '–'),
      h('span', { class: 'pn' }, a.pin || '–'),
      h('span', { class: `st ${a.status}` }, a.status === 'ok' ? 'ok' : a.status === 'check' ? 'check' : 'conflict'),
      h('button', { class: 'x', type: 'button', 'aria-label': `Remove ${a.signal} from the assignment`, onclick: () => { const r = rows(); r.splice(a.row, 1); ctx.set('assign', r); } }, '×'),
      a.note ? h('span', { class: 'nt' }, a.note) : null);
      list.append(row);
    }
    const remap = (res.tables || []).find((t) => /^Remap settings/.test(t.title));
    remapCard.style.display = remap ? '' : 'none';
    if (remap) remapBody.replaceChildren(h('table', { class: 'pm-remap' },
      h('tr', {}, remap.columns.map((c) => h('th', {}, c))),
      remap.rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, String(c)))))));
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'How it is worked out'), ...(res.notes || []).map((t) => h('div', {}, t)));
  }

  function draw() { drawStage(); drawSide(); refocus = null; }
  ctx.onResult((r) => { res = r; draw(); });
  let lastW = 0;
  new ResizeObserver(() => { const w = stageCard.clientWidth; if (w !== lastW) { lastW = w; drawStage(); } }).observe(stageCard);
}
