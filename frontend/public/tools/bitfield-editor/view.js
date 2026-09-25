// Register Bitfield Editor: the page is the register as a bank of switches.
//   Bank      - one slide switch per bit, MSB left, set = up. The switches of a
//               field sit in one coloured housing with its name above and its
//               decoded value under it; bits in no field have a dashed slot and
//               turn amber when set. Over every four switches is their hex
//               digit, a wheel: scroll it, drag it, or arrow up/down.
//               Click a switch (or Space on it; arrows move along the bank).
//   Field     - the housing you click: its codes as a list, click one to write
//               it into the field; - / + step the field's value.
//   Map       - the field list itself (NAME msb:lsb code=meaning), editable
//               for a custom register; a preset's map can be copied to edit.
// Every value shown comes from run()'s result (bits, fields, hexValue); the page
// only writes the new register value back into the Value input.
import { PRESETS } from './tool.js';

const NS = 'http://www.w3.org/2000/svg';
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const txt = (x, y, s, cls = '', anchor = 'start') => sv('text', { x, y, class: cls, 'text-anchor': anchor }, s);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hexW = (v, w) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(Math.ceil(w / 4), '0');
const NF = 6; // field colours

const CSS = `
.bf { --tool-f0: #1f4ed8; --tool-f1: #c2410c; --tool-f2: #0f8a78; --tool-f3: #a23fbf; --tool-f4: #a16207; --tool-f5: #be185d;
  --tool-knob: #ffffff; --tool-slot: #d5dde5;
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.1fr); gap: 12px; align-items: start; }
:root[data-theme="dark"] .bf { --tool-f0: #7d9bff; --tool-f1: #f59e5b; --tool-f2: #3cc7b3; --tool-f3: #c982e0; --tool-f4: #e0b84a; --tool-f5: #f07aa8;
  --tool-knob: #e4ebf1; --tool-slot: #0b1116; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .bf { --tool-f0: #7d9bff; --tool-f1: #f59e5b; --tool-f2: #3cc7b3; --tool-f3: #c982e0; --tool-f4: #e0b84a; --tool-f5: #f07aa8;
  --tool-knob: #e4ebf1; --tool-slot: #0b1116; } }
@media (max-width: 1100px) { .bf { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .bf-out { grid-column: 1 / -1; } }
@media (max-width: 700px) { .bf { grid-template-columns: minmax(0, 1fr); } }
.bf-bank { grid-column: 1 / -1; }
.bf-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.bf-head { display: flex; align-items: center; gap: 6px 12px; flex-wrap: wrap; padding: 6px 10px; border-bottom: 1px solid var(--line-soft); }
.bf-head h2 { font-size: 12.5px; font-weight: 600; margin: 0; }
.bf-sub { color: var(--ink-soft); font-size: 11.5px; }
.bf-grow { flex: 1; }
.bf-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; flex-wrap: wrap; }
.bf-seg button { border: 0; background: transparent; padding: 2px 8px; font-size: 11.5px; cursor: pointer; color: var(--ink-soft); }
.bf-seg button + button { border-left: 1px solid var(--line); }
.bf-seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.bf-f { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--ink-soft); }
.bf-f input { width: 120px; padding: 2px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.bf-f input.bad { border-color: var(--danger); }
.bf-read { display: flex; flex-wrap: wrap; gap: 4px 18px; align-items: baseline; padding: 8px 12px 2px; }
.bf-read .hex { font: 600 22px "IBM Plex Mono", ui-monospace, monospace; letter-spacing: .02em; }
.bf-read .was { font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--warn); }
.bf-read span { font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.bf-read span b { color: var(--ink); font-weight: 500; }
.bf-draw { position: relative; touch-action: none; user-select: none; -webkit-user-select: none; padding: 2px 8px 0; }
.bf-draw svg { display: block; width: 100%; overflow: visible; }
.bf-foot { padding: 4px 10px 7px; color: var(--ink-soft); font-size: 11px; display: flex; gap: 4px 14px; flex-wrap: wrap; }
.bf-foot kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 3px; }
.bf-warns:empty { display: none; }
.bf-warns { grid-column: 1 / -1; }
/* field inspector */
.bf-insp { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 8px; }
.bf-title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.bf-title b { font: 600 15px "IBM Plex Mono", ui-monospace, monospace; }
.bf-title span { font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.bf-chip { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
.bf-val { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font: 12.5px "IBM Plex Mono", ui-monospace, monospace; }
.bf-val .num { font-size: 18px; font-weight: 600; min-width: 2ch; text-align: center; }
.bf-desc { color: var(--ink-soft); font-size: 12px; }
.bf-codes { display: flex; flex-direction: column; border: 1px solid var(--line-soft); border-radius: 5px; overflow: hidden; max-height: 290px; overflow-y: auto; }
.bf-code { display: grid; grid-template-columns: 34px 44px minmax(0, 1fr); gap: 6px; align-items: center; padding: 4px 8px; border: 0;
  border-bottom: 1px solid var(--line-soft); background: transparent; text-align: left; cursor: pointer; font: inherit; color: var(--ink); }
.bf-code:last-child { border-bottom: 0; }
.bf-code:hover { background: var(--sunken); }
.bf-code[aria-pressed="true"] { background: var(--sunken); box-shadow: inset 3px 0 0 var(--accent); font-weight: 600; }
.bf-code .k { font: 12px "IBM Plex Mono", ui-monospace, monospace; }
.bf-code .bin { font: 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.bf-code .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.bf-code .t.none { color: var(--ink-soft); font-style: italic; }
/* map */
.bf-map { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 6px; }
.bf-map textarea { width: 100%; min-height: 210px; resize: vertical; padding: 6px 8px; border: 1px solid var(--line); border-radius: 4px;
  background: var(--sunken); font: 12px/1.5 "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.bf-map textarea[readonly] { color: var(--ink-soft); }
.bf-map .bf-sub { font-size: 11px; }
.bf-out .k-out { max-height: 300px; }
.bf-notes { color: var(--ink-soft); font-size: 11.5px; grid-column: 1 / -1; }
.bf-notes div + div { margin-top: 3px; }
/* drawing */
.bf svg text { font: 11px "IBM Plex Sans", -apple-system, sans-serif; fill: var(--ink); }
.bf svg .m { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.bf svg .sm { font-size: 9.5px; } .bf svg .soft { fill: var(--ink-soft); } .bf svg .b { font-weight: 600; }
.bf svg .house { stroke-width: 1.5; }
.bf svg .house-free { fill: none; stroke: var(--line); stroke-dasharray: 3 3; }
.bf svg .slot { fill: var(--tool-slot); stroke: var(--line); }
.bf svg .knob { stroke: var(--line); stroke-width: 1; }
.bf svg .knob.off { fill: var(--tool-knob); }
.bf svg .knob.loose { fill: var(--warn); stroke: var(--warn); }
.bf svg g.sw { cursor: pointer; outline: none; }
.bf svg g.sw .foc { fill: none; stroke: transparent; stroke-width: 2; }
.bf svg g.sw:focus-visible .foc { stroke: var(--accent); }
.bf svg g.sw:hover .slot { stroke: var(--ink-soft); }
.bf svg g.nib { cursor: ns-resize; outline: none; }
.bf svg g.nib rect { fill: var(--surface); stroke: var(--line); }
.bf svg g.nib:hover rect { stroke: var(--ink-soft); }
.bf svg g.nib:focus-visible rect { stroke: var(--accent); stroke-width: 2; }
.bf svg g.nib text { font: 600 15px "IBM Plex Mono", ui-monospace, monospace; }
.bf svg g.nib .chev { fill: var(--ink-soft); }
.bf svg g.nib.chg text.d { fill: var(--warn); }
.bf svg g.fh { cursor: pointer; outline: none; }
.bf svg g.fh.sel .house { stroke-width: 3; }
.bf svg g.fh:focus-visible .house { stroke-dasharray: 4 2; stroke-width: 2.5; }
.bf svg .fval { font: 600 11px "IBM Plex Mono", ui-monospace, monospace; }
.bf svg .lead { stroke-width: 1; fill: none; }
.bf svg .warnb { fill: var(--warn); }
`;
const fcol = (i) => `var(--tool-f${i % NF})`;

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  const st = { sel: null, focusBit: null, wheel: null };

  // ---------- panels ----------
  const presetSeg = h('div', { class: 'bf-seg', role: 'group', 'aria-label': 'Register' });
  const widthSeg = h('div', { class: 'bf-seg', role: 'group', 'aria-label': 'Width' });
  const valueIn = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Register value (0x hex, 0b binary or decimal)',
    placeholder: '0x27', oninput: (e) => ctx.setMany({ value: e.target.value, flip: '' }) });
  const valueF = h('label', { class: 'bf-f' }, 'value', valueIn);
  const flipIn = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Bits to flip, e.g. 3, 5', placeholder: '3, 5',
    style: 'width:64px', oninput: (e) => ctx.set('flip', e.target.value) });
  const flipF = h('label', { class: 'bf-f', title: 'Bit numbers to toggle on top of the value' }, 'flip', flipIn);
  const readout = h('div', { class: 'bf-read', 'aria-live': 'polite' });
  const bankDraw = h('div', { class: 'bf-draw' });
  const bank = h('section', { class: 'bf-panel bf-bank', 'aria-label': 'Register bits' },
    h('div', { class: 'bf-head' }, h('h2', {}, 'Register'), presetSeg, widthSeg, h('span', { class: 'bf-grow' }), valueF, flipF),
    readout, bankDraw,
    h('div', { class: 'bf-foot' },
      h('span', {}, 'Click a switch to flip its bit; click a field\'s housing to pick one of its codes.'),
      h('span', {}, h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' along the bank, ', h('kbd', {}, 'Space'), ' flip'),
      h('span', {}, 'hex digit: wheel, drag or ', h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ', or type 0-F')));

  const insp = h('div', { class: 'bf-insp' });
  const inspPanel = h('section', { class: 'bf-panel', 'aria-label': 'Selected field' },
    h('div', { class: 'bf-head' }, h('h2', {}, 'Field'), h('span', { class: 'bf-sub' }, 'click a code to write it')), insp);

  const mapArea = h('textarea', { spellcheck: 'false', 'aria-label': 'Field list, one per line: NAME msb:lsb code=meaning',
    oninput: (e) => ctx.set('fields', e.target.value) });
  const mapNote = h('div', { class: 'bf-sub' });
  const mapBtn = h('button', { class: 'k-btn', type: 'button' }, 'Edit a copy as Custom');
  mapBtn.addEventListener('click', () => {
    const P = PRESETS[ctx.raw.preset];
    if (!P) return;
    ctx.setMany({ preset: 'custom', width: String(P.width), value: ctx.result?.hexValue || P.value, flip: '', fields: P.fields });
  });
  const mapPanel = h('section', { class: 'bf-panel', 'aria-label': 'Field map' },
    h('div', { class: 'bf-head' }, h('h2', {}, 'Field map'), h('span', { class: 'bf-sub' }, 'NAME msb:lsb  code=meaning …'), h('span', { class: 'bf-grow' }), mapBtn),
    h('div', { class: 'bf-map' }, mapArea, mapNote));

  const warns = h('div', { class: 'k-warns bf-warns', 'aria-live': 'polite' });
  const notes = h('div', { class: 'bf-notes' });
  ctx.outputs.classList.add('bf-out');
  root.append(h('div', { class: 'bf' }, bank, warns, inspPanel, mapPanel, ctx.outputs, notes));

  // ---------- writing the value ----------
  const R = () => ctx.result;
  const writeValue = (v) => {
    const r = R(); if (!r?.width) return;
    ctx.setMany({ value: hexW(v >>> 0, r.width), flip: '' });
  };
  const flipBit = (b) => { const r = R(); if (!r?.width) return; writeValue((r.value ^ 2 ** b) >>> 0); };
  const setField = (f, code) => {
    const r = R(); if (!r?.width) return;
    const w = f.msb - f.lsb + 1;
    const c = ((code % 2 ** w) + 2 ** w) % 2 ** w;
    // clear the field's bits, then put the code in (arithmetic, 32-bit safe)
    const lo = r.value % 2 ** f.lsb, hi = Math.floor(r.value / 2 ** (f.msb + 1));
    writeValue(hi * 2 ** (f.msb + 1) + c * 2 ** f.lsb + lo);
  };
  const setNibble = (k, d) => {
    const r = R(); if (!r?.width) return;
    const cur = Math.floor(r.value / 16 ** k) % 16;
    const n = ((d.abs != null ? d.abs : cur + d.rel) % 16 + 16) % 16;
    writeValue(r.value + (n - cur) * 16 ** k);
  };

  const keepFocus = (fn) => {
    const fk = document.activeElement?.getAttribute?.('data-fk');
    fn();
    if (fk) root.querySelector(`[data-fk="${fk}"]`)?.focus({ preventScroll: true });
  };

  // ---------- the bank ----------
  function drawBank(r) {
    const W = Math.max(300, (bankDraw.clientWidth || 900) - 16);
    const width = r.width;
    // Bits per row: everything on one row when the switches stay >= 26 px.
    const perRow = [32, 16, 8].filter((n) => n <= width || n === 8).find((n) => (W - 10 - (n / 4 - 1) * 8) / n >= 26 && n <= width) || 8;
    const cw = Math.min(width <= 8 ? 92 : width <= 16 ? 70 : 62, (W - 10 - (perRow / 4 - 1) * 8) / perRow);
    const rowW = perRow * cw + (perRow / 4 - 1) * 8;
    const x0 = (W - rowW) / 2;
    const fields = r.fields || [];
    const idx = new Map(fields.map((f, i) => [f.name, i]));
    const owner = (b) => r.bits[b]?.field;
    const rows = Math.ceil(width / perRow);
    const NAME_H = 58, NIB_H = 30, SW_H = Math.round(clamp(cw * 1.15, 58, 92)), NUM_H = 16, VAL_H = 34;
    const RH = NIB_H + NAME_H + SW_H + NUM_H + VAL_H + 12;
    const H = rows * RH;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'group', 'aria-label': `register ${r.hexValue}` });
    const X = (b, hi) => { const i = hi - b; return x0 + i * cw + Math.floor(i / 4) * 8; };
    const focusBit = st.focusBit != null && st.focusBit < width ? st.focusBit : width - 1;
    const beforeNib = (k) => Math.floor(r.before / 16 ** k) % 16;
    for (let row = 0; row < rows; row++) {
      const hi = width - 1 - row * perRow, lo = Math.max(0, hi - perRow + 1);
      const y = row * RH;
      const yNib = y + 2, yName = y + NIB_H, ySw = yName + NAME_H, yNum = ySw + SW_H, yVal = yNum + NUM_H;
      // hex digits over each nibble: wheels
      for (let k = Math.floor(hi / 4); k >= Math.floor(lo / 4); k--) {
        const xa = X(k * 4 + 3, hi), xb = X(k * 4, hi) + cw;
        const d = Math.floor(r.value / 16 ** k) % 16;
        const g = sv('g', { class: `nib${d !== beforeNib(k) ? ' chg' : ''}`, tabindex: 0, role: 'spinbutton', 'data-fk': `nib${k}`,
          'aria-label': `hex digit ${k} (bits ${k * 4 + 3} to ${k * 4})`, 'aria-valuenow': d, 'aria-valuemin': 0, 'aria-valuemax': 15,
          'aria-valuetext': d.toString(16).toUpperCase() });
        const cx = (xa + xb) / 2;
        g.append(sv('rect', { x: cx - 22, y: yNib, width: 44, height: 24, rx: 4 }));
        g.append(sv('path', { d: `M${cx - 17},${yNib + 14} l4,-5 l4,5 z M${cx + 17},${yNib + 10} l-4,5 l-4,-5 z`, class: 'chev' }));
        g.append(txt(cx, yNib + 17.5, d.toString(16).toUpperCase(), 'd', 'middle'));
        g.append(sv('title', {}, `Hex digit ${k}: scroll, drag up/down, arrows, or type 0-F`));
        g.addEventListener('wheel', (e) => { e.preventDefault(); setNibble(k, { rel: e.deltaY < 0 ? 1 : -1 }); }, { passive: false });
        g.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowUp') { e.preventDefault(); setNibble(k, { rel: 1 }); } else if (e.key === 'ArrowDown') { e.preventDefault(); setNibble(k, { rel: -1 }); } else if (/^[0-9a-f]$/i.test(e.key)) { e.preventDefault(); setNibble(k, { abs: parseInt(e.key, 16) }); }
        });
        g.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          st.wheel = { k, y: e.clientY, acc: 0 };
          try { bankDraw.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
          g.focus({ preventScroll: true });
        });
        svg.append(g);
        if (xb - xa > 60 && cw >= 30) {
          // nibble brace down to its switches
          svg.append(sv('path', { d: `M${xa + 3},${yNib + 26} v3 M${xb - 3},${yNib + 26} v3 M${xa + 3},${yNib + 28} H${xb - 3}`, class: 'lead', stroke: 'var(--line)' }));
        }
      }
      // field housings
      const lanes = [-1e9, -1e9, -1e9];
      const inRow = fields.filter((f) => Math.min(f.msb, hi) >= Math.max(f.lsb, lo)).sort((a, b) => b.msb - a.msb);
      for (const f of inRow) {
        const i = idx.get(f.name);
        const a = Math.min(f.msb, hi), z = Math.max(f.lsb, lo);
        const xa = X(a, hi) + 1, xb = X(z, hi) + cw - 1;
        const col = fcol(i);
        const sel = st.sel === f.name;
        const g = sv('g', { class: `fh${sel ? ' sel' : ''}`, tabindex: 0, role: 'button', 'data-fk': `f-${f.name}`,
          'aria-label': `field ${f.name}, bits ${f.msb}:${f.lsb}, value ${f.value}${f.meaning ? `, ${f.meaning}` : ''}` });
        g.append(sv('rect', { x: xa, y: ySw - 6, width: xb - xa, height: SW_H + NUM_H + 2, rx: 5, class: 'house', fill: col, 'fill-opacity': sel ? 0.22 : 0.1, stroke: col }));
        // name label in one of two lanes above the housing
        const w = f.msb - f.lsb + 1;
        let label = f.name;
        const tw = label.length * 6.9;
        const cx = clamp((xa + xb) / 2, tw / 2 + 2, W - tw / 2 - 2);
        let lane = lanes.findIndex((e) => cx - tw / 2 > e + 6);
        if (lane < 0) lane = lanes.indexOf(Math.min(...lanes));
        lanes[lane] = Math.max(lanes[lane], cx + tw / 2);
        const ly = ySw - 12 - lane * 15;
        if (lane > 0) g.append(sv('path', { d: `M${cx},${ly + 3} V${ySw - 6}`, class: 'lead', stroke: col }));
        const nt = txt(cx, ly, label, 'm b', 'middle'); nt.setAttribute('style', `fill:${col}`); g.append(nt);
        // decoded value under the housing (multi-bit fields, or a 1-bit field with a stated meaning)
        const val = w > 4 ? `0x${(f.value >>> 0).toString(16).toUpperCase()}` : String(f.value);
        const mean = f.codes && Object.keys(f.codes).length ? f.meaning : '';
        if (w > 1 || mean) {
          const room = xb - xa + (w > 1 ? 24 : 16);
          let s = w > 1 ? `= ${val}${mean ? ` ${mean}` : ''}` : mean;
          const max = Math.max(3, Math.floor(room / 6.2));
          if (s.length > max) s = s.slice(0, max - 1) + '…';
          g.append(txt((xa + xb) / 2, yVal + 12, s, 'fval', 'middle'));
          if (w > 1) g.append(txt((xa + xb) / 2, yVal + 25, (f.value >>> 0).toString(2).padStart(w, '0').slice(-(a - z + 1)), 'm sm soft', 'middle'));
        }
        g.append(sv('title', {}, `${f.name} [${f.msb}:${f.lsb}] = ${f.value}${f.meaning ? ` — ${f.meaning}` : ''}. Click to list its codes.`));
        const pick = () => { st.sel = f.name; draw(); };
        g.addEventListener('click', pick);
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        svg.append(g);
      }
      // switches
      for (let b = hi; b >= lo; b--) {
        const x = X(b, hi);
        const bit = r.bits[b];
        const f = owner(b);
        if (!f) svg.append(sv('rect', { x: x + 1, y: ySw - 6, width: cw - 2, height: SW_H + NUM_H + 2, rx: 5, class: 'house-free' }));
        const col = f ? fcol(idx.get(f)) : null;
        const loose = !f && bit.on && fields.length;
        const g = sv('g', { class: 'sw', tabindex: b === focusBit ? 0 : -1, role: 'switch', 'aria-checked': String(bit.on), 'data-fk': `b${b}`,
          'aria-label': `bit ${b}${f ? ` of ${f}` : ', no field'}` });
        const sw = Math.min(cw - 10, Math.max(22, cw * 0.4)), sx = x + (cw - sw) / 2, sh = SW_H - 12;
        g.append(sv('rect', { x: sx, y: ySw, width: sw, height: sh, rx: 4, class: 'slot' }));
        const ky = bit.on ? ySw + 3 : ySw + sh / 2 + 1;
        const knob = sv('rect', { x: sx + 3, y: ky, width: sw - 6, height: sh / 2 - 4, rx: 3, class: `knob${bit.on ? '' : ' off'}${loose ? ' loose' : ''}` });
        if (bit.on && !loose) knob.setAttribute('style', `fill:${col || 'var(--ink-soft)'};stroke:${col || 'var(--ink-soft)'}`);
        g.append(knob);
        g.append(txt(x + cw / 2, bit.on ? ySw + sh - 4 : ySw + 12, bit.on ? '1' : '0', 'm sm soft', 'middle'));
        g.append(txt(x + cw / 2, yNum + 8, String(b), 'm sm soft', 'middle'));
        g.append(sv('rect', { x: sx - 3, y: ySw - 3, width: sw + 6, height: sh + 6, rx: 6, class: 'foc' }));
        g.append(sv('title', {}, `bit ${b}${f ? ` · ${f}` : ' · no field'}: click to flip`));
        g.addEventListener('click', () => { st.focusBit = b; flipBit(b); });
        g.addEventListener('keydown', (e) => {
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); st.focusBit = b; flipBit(b); return; }
          const d = { ArrowLeft: 1, ArrowRight: -1, Home: width, End: -width }[e.key];
          if (d == null) return;
          e.preventDefault();
          const nb = clamp(b + d, 0, width - 1);
          st.focusBit = nb;
          for (const el of svg.querySelectorAll('g.sw')) el.setAttribute('tabindex', el.getAttribute('data-fk') === `b${nb}` ? 0 : -1);
          svg.querySelector(`g.sw[data-fk="b${nb}"]`)?.focus({ preventScroll: true });
        });
        svg.append(g);
        if (loose) svg.append(txt(x + cw / 2, yVal + 12, '!', 'warnb b', 'middle'));
      }
    }
    bankDraw.replaceChildren(svg);
  }
  // Dragging a hex digit: 14 px per step.
  bankDraw.addEventListener('pointermove', (e) => {
    if (!st.wheel) return;
    const dy = st.wheel.y - e.clientY;
    const steps = Math.trunc(dy / 14);
    if (steps !== st.wheel.acc) { setNibble(st.wheel.k, { rel: steps - st.wheel.acc }); st.wheel.acc = steps; }
  });
  const endWheel = () => { st.wheel = null; };
  bankDraw.addEventListener('pointerup', endWheel); bankDraw.addEventListener('pointercancel', endWheel);

  // ---------- the selected field ----------
  function drawInspector(r) {
    const fields = r.fields || [];
    if (!fields.length) {
      insp.replaceChildren(h('div', { class: 'bf-desc' }, 'No fields yet: describe them in the field map, one per line, e.g. "mode 1:0 0=sleep 1=forced 3=normal".'));
      return;
    }
    let f = fields.find((x) => x.name === st.sel);
    if (!f) { f = [...fields].sort((a, b) => b.msb - a.msb)[0]; st.sel = f.name; }
    const i = fields.indexOf(f);
    const w = f.msb - f.lsb + 1;
    const codes = f.codes || {};
    const keys = Object.keys(codes).map(Number);
    // Every code when there are few; else the listed ones and the current value.
    const list = w <= 4 ? Array.from({ length: 2 ** w }, (_, k) => k) : [...new Set([...keys, f.value])].sort((a, b) => a - b);
    const step = (d) => setField(f, f.value + d);
    insp.replaceChildren(...[
      h('div', { class: 'bf-title' }, h('i', { class: 'bf-chip', style: `background:${fcol(i)}` }), h('b', {}, f.name),
        h('span', {}, f.msb === f.lsb ? `bit ${f.msb}` : `bits ${f.msb}:${f.lsb} · ${w} bits`),
        h('span', {}, `mask ${hexW(((2 ** w - 1) * 2 ** f.lsb) >>> 0, r.width)}`)),
      h('div', { class: 'bf-val' },
        h('button', { class: 'k-btn', type: 'button', 'aria-label': `${f.name} minus one`, onclick: () => step(-1) }, '−'),
        h('span', { class: 'num' }, String(f.value)),
        h('button', { class: 'k-btn', type: 'button', 'aria-label': `${f.name} plus one`, onclick: () => step(1) }, '+'),
        h('span', {}, `0x${(f.value >>> 0).toString(16).toUpperCase()} · 0b${(f.value >>> 0).toString(2).padStart(w, '0')}`)),
      f.meaning && !codes[f.value] ? h('div', {}, f.meaning) : null,
      f.desc && f.desc !== f.meaning ? h('div', { class: 'bf-desc' }, f.desc) : null,
      h('div', { class: 'bf-codes', role: 'group', 'aria-label': `${f.name} codes` }, list.map((k) => {
        const t = codes[k];
        return h('button', { type: 'button', class: 'bf-code', 'aria-pressed': String(k === f.value), onclick: () => setField(f, k) },
          h('span', { class: 'k' }, String(k)), h('span', { class: 'bin' }, w <= 8 ? k.toString(2).padStart(w, '0') : `0x${k.toString(16).toUpperCase()}`),
          h('span', { class: `t${t ? '' : ' none'}` }, t || (w === 1 ? (k ? 'set' : 'clear') : 'not listed')));
      }))].filter(Boolean));
  }

  // ---------- header, map, readout ----------
  function drawTop(r) {
    const raw = ctx.raw;
    const P = PRESETS[raw.preset];
    const presets = ctx.manifest.inputs.find((d) => d.key === 'preset')?.options || [];
    presetSeg.replaceChildren(...presets.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String((raw.preset || 'custom') === id), title: label,
      onclick: () => (id === 'custom' ? ctx.set('preset', 'custom') : ctx.setMany({ preset: id, value: '', flip: '' })) },
    id === 'custom' ? 'Custom' : label.split(' ')[0])));
    widthSeg.replaceChildren(...(P ? [] : ['8', '16', '32'].map((w) => h('button', { type: 'button', 'aria-pressed': String(String(raw.width) === w),
      onclick: () => ctx.set('width', w) }, `${w}-bit`))));
    widthSeg.style.display = P ? 'none' : '';
    if (document.activeElement !== valueIn) valueIn.value = raw.value ?? '';
    valueIn.placeholder = P ? P.value : '0x27';
    if (document.activeElement !== flipIn) flipIn.value = raw.flip ?? '';
    if (document.activeElement !== mapArea) mapArea.value = P ? P.fields : (raw.fields ?? '');
    mapArea.readOnly = !!P;
    mapBtn.style.display = P ? '' : 'none';
    mapNote.textContent = P ? `${P.name}: a preset, read only. "Edit a copy as Custom" to change it.`
      : 'One field per line: NAME msb:lsb (or NAME bit), then code=meaning pairs; codes may be 0x hex. # starts a comment.';
    if (!r?.width) { readout.replaceChildren(h('span', {}, 'no value')); return; }
    const vals = Object.fromEntries((r.values || []).map((v) => [v.label, v]));
    const hx = vals.Hex;
    readout.replaceChildren(
      h('b', { class: 'hex' }, String(hx?.value ?? r.hexValue)),
      hx?.tone === 'warn' ? h('span', { class: 'was' }, hx.hint) : h('span', {}, hx?.hint || ''),
      h('span', {}, 'dec ', h('b', {}, String(vals.Decimal?.value ?? ''))),
      h('span', {}, 'bin ', h('b', {}, String(vals.Binary?.value ?? ''))),
      h('span', {}, 'set ', h('b', {}, `${vals['Bits set']?.value ?? ''}`), ` ${vals['Bits set']?.hint || ''}`));
  }

  function draw() {
    const r = R();
    keepFocus(() => {
      drawTop(r);
      warns.replaceChildren(...(r?.warnings || []).map((w) => h('div', {}, w)));
      notes.replaceChildren(...(r?.notes || []).map((w) => h('div', {}, w)));
      if (!r?.width) { bankDraw.replaceChildren(); insp.replaceChildren(); return; }
      drawInspector(r);
      drawBank(r);
    });
  }

  ctx.onResult(() => draw());
  let rt = 0;
  new ResizeObserver(() => { cancelAnimationFrame(rt); rt = requestAnimationFrame(draw); }).observe(root);
}
