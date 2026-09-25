// Endianness Inspector, custom page: the bytes and the wiring of each order.
//
// Bytes to values: the memory strip holds the bytes at their addresses (a
// hex editor: click a byte and type, arrows move, Delete removes). A window
// of 1, 2, 4 or 8 bytes sits on it; drag its tab (or focus it and use the
// arrows) to change the offset. Each byte in the window gets a letter and a
// colour (A = lowest address), and one crossbar per byte order shows which
// memory byte lands in which position of the register, most significant
// first, with the numbers that register makes as every type of that size.
// Value to bytes runs the same crossbars the other way: the value's bytes,
// most significant first, wired out to the addresses each order stores them at.
//
// Every value shown comes from run()'s result (inspect.reads / layout and the
// table); the page only draws the permutations it returns.

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
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const hx = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const LET = 'ABCDEFGH';
const printable = (b) => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '·');
const TYPE_NAMES = { u8: 'uint8_t', i8: 'int8_t', u16: 'uint16_t', i16: 'int16_t', u32: 'uint32_t', i32: 'int32_t', f32: 'float', u64: 'uint64_t', i64: 'int64_t', f64: 'double' };
const TYPES_BY_SIZE = { 1: ['u8', 'i8'], 2: ['u16', 'i16'], 4: ['u32', 'i32', 'f32'], 8: ['u64', 'i64', 'f64'] };
const TAGS = [
  [/^Big endian/, 'network order · Modbus registers · Motorola, PowerPC'],
  [/^Little endian/, 'ARM, x86, RISC-V memory'],
  [/^Word swap/, 'Modbus float/long, low word first'],
  [/^Byte swap/, 'bytes swapped inside each word'],
  [/^Single/, 'one byte has no order'],
];
const tagOf = (name) => (TAGS.find(([re]) => re.test(name)) || [, ''])[1];
// A float that reads as an ordinary number is a strong hint the order is right.
function plausible(s) {
  const v = Number(s);
  if (!Number.isFinite(v)) return false;
  const a = Math.abs(v);
  return a === 0 || (a >= 1e-6 && a < 1e9);
}
const WKEY = 'redline.tool.endianness.width';
const store = {
  get() { try { const v = localStorage.getItem(WKEY); return v == null ? null : Number(v); } catch { return null; } },
  set(v) { try { localStorage.setItem(WKEY, String(v)); } catch { /* private window */ } },
};

const CSS = `
:root { --tool-b0: #1f4ed8; --tool-b1: #c26a00; --tool-b2: #0f8a78; --tool-b3: #a23fbf; --tool-b4: #b83246; --tool-b5: #5f7d0e; --tool-b6: #0a7bb0; --tool-b7: #8a5a2b; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tool-b0: #7d9bff; --tool-b1: #f0a33a; --tool-b2: #3cc7b3; --tool-b3: #c982e0; --tool-b4: #f07a8c; --tool-b5: #a8c94a; --tool-b6: #5cc1ef; --tool-b7: #d7a26d; } }
:root[data-theme="dark"] { --tool-b0: #7d9bff; --tool-b1: #f0a33a; --tool-b2: #3cc7b3; --tool-b3: #c982e0; --tool-b4: #f07a8c; --tool-b5: #a8c94a; --tool-b6: #5cc1ef; --tool-b7: #d7a26d; }

.en { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 12px; align-items: start; }
.en > * { min-width: 0; }
.en [hidden] { display: none !important; }
@media (max-width: 1000px) { .en { grid-template-columns: minmax(0, 1fr); } }
.en-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.en-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.en-h { font-size: 11px; font-weight: 600; color: var(--ink-soft); text-transform: uppercase; letter-spacing: .05em; }
.en-soft { color: var(--ink-soft); }
.en input[type="text"] { padding: 4px 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 13px "IBM Plex Mono", ui-monospace, monospace; min-width: 0; }
.en input.bad { border-color: var(--danger); }
.en-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; background: var(--surface); flex-wrap: wrap; }
.en-seg button { border: 0; background: transparent; padding: 3px 10px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.en-seg button + button { border-left: 1px solid var(--line); }
.en-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
.en-seg button:disabled { opacity: .4; cursor: default; }
.en-mono { font-family: "IBM Plex Mono", ui-monospace, monospace; }

.en-top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 9px 12px; }
.en-top .grow { flex: 1 1 260px; display: flex; align-items: center; gap: 8px; min-width: 0; }
.en-top .grow input { flex: 1 1 auto; width: 100%; }
.en-warns { border: 1px solid var(--warn); border-left-width: 3px; border-radius: 4px; padding: 5px 9px; font-size: 12px; margin: 0 12px 9px; }
.en-warns:empty { display: none; }
.en-warns div + div { margin-top: 3px; }

/* memory strip */
.en-mem { padding: 8px 12px 12px; }
.en-memhead { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-bottom: 6px; }
.en-memhead .sp { flex: 1; }
.en-scroll { overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; padding: 30px 6px 8px; position: relative; }
.en-strip { display: flex; gap: 4px; position: relative; width: max-content; }
.en-byte { flex: 0 0 auto; width: 46px; display: flex; flex-direction: column; align-items: center; padding: 3px 0 4px; border: 1px solid var(--line);
  border-radius: 4px; background: var(--sunken); cursor: text; position: relative; }
.en-byte small { font: 10px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.en-byte b { font: 600 17px/1.2 "IBM Plex Mono", ui-monospace, monospace; }
.en-byte i { font: normal 10.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); height: 13px; }
.en-byte.in { background: var(--surface); border-width: 2px; padding: 2px 0 3px; }
.en-byte.sel { outline: 2px solid var(--accent); outline-offset: 1px; }
.en-byte.sel.half b::after { content: '_'; color: var(--accent); }
.en-byte.far b { color: var(--ink-soft); }
.en-byte:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.en-add { flex: 0 0 auto; width: 34px; border: 1px dashed var(--line); border-radius: 4px; background: transparent; color: var(--ink-soft); cursor: pointer; font-size: 16px; }
.en-add:hover { border-color: var(--ink-soft); color: var(--ink); }
.en-win { position: absolute; top: -28px; height: calc(100% + 32px); border: 2px solid var(--accent); border-radius: 6px; pointer-events: none;
  transition: left .12s ease-out, width .12s ease-out; }
.en-tab { position: absolute; left: -2px; top: -2px; height: 22px; display: flex; align-items: center; gap: 6px; padding: 0 8px; border-radius: 6px 6px 6px 0;
  background: var(--accent); color: var(--accent-ink); font: 600 11.5px "IBM Plex Mono", ui-monospace, monospace; white-space: nowrap; pointer-events: auto;
  cursor: grab; touch-action: none; user-select: none; outline: none; }
.en-tab:focus-visible { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--ink); }
.en-tab.drag { cursor: grabbing; }
.en-tab .grip { letter-spacing: -2px; opacity: .8; }
.en-hint { font-size: 11.5px; color: var(--ink-soft); margin-top: 7px; }
.en-hint kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px; padding: 0 4px; background: var(--sunken); }

/* the register in value mode */
.en-regbig { display: flex; gap: 4px; flex-wrap: wrap; }
.en-regbig div { width: 58px; text-align: center; border: 2px solid; border-radius: 5px; padding: 3px 0 4px; background: var(--surface); }
.en-regbig b { display: block; font: 600 19px/1.2 "IBM Plex Mono", ui-monospace, monospace; }
.en-regbig small { font: 10px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.en-types { display: flex; flex-wrap: wrap; gap: 4px; }

/* crossbars */
.en-rows { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 470px), 1fr)); gap: 10px; }
.en-row { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 14px; padding: 10px 12px; align-items: start; }
.en-row.best { border-color: var(--ok); box-shadow: inset 3px 0 0 var(--ok); }
.en-row svg { display: block; overflow: visible; }
.en-rt { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; }
.en-rt b { font-size: 13px; }
.en-rt span { font-size: 11.5px; color: var(--ink-soft); }
.en-info { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.en-hex { font: 600 18px "IBM Plex Mono", ui-monospace, monospace; letter-spacing: .02em; overflow-wrap: anywhere; }
.en-vals { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1px 10px; font-size: 12px; }
.en-vals dt { color: var(--ink-soft); font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 11.5px; }
.en-vals dd { margin: 0; font: 500 13px "IBM Plex Mono", ui-monospace, monospace; overflow-wrap: anywhere; min-width: 0; }
.en-vals dd.pl { color: var(--ok); font-weight: 600; }
.en-vals dd.im { color: var(--ink-soft); }
.en-vals dd em { font-style: normal; font-family: "IBM Plex Sans", sans-serif; font-size: 10.5px; font-weight: 500; margin-left: 6px; }
.en-code { font: 12px "IBM Plex Mono", ui-monospace, monospace; background: var(--sunken); border-radius: 4px; padding: 3px 6px; overflow-wrap: anywhere; }

.en-svg .cell { stroke-width: 2; }
.en-svg .ct { font: 600 13px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.en-svg .cl { font: 600 10.5px "IBM Plex Mono", ui-monospace, monospace; }
.en-svg .ax { font: 10px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.en-svg .wire { fill: none; stroke-width: 2.2; opacity: .9; }
.en-hl .en-svg .wire { opacity: .18; }
.en-hl .en-svg .dim { opacity: .35; }
${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `.en-hl[data-hl="${i}"] .en-svg [data-s="${i}"] { opacity: 1 !important; stroke-width: 3.2; }`).join('\n')}
${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `.en-hl[data-hl="${i}"] .en-byte[data-s="${i}"] { box-shadow: 0 0 0 3px var(--tool-b${i}); }`).join('\n')}

.en-notes { color: var(--ink-soft); font-size: 11.5px; padding: 0 2px; }
.en-notes div + div { margin-top: 4px; }
.en .k-out { max-height: 420px; }
@media (max-width: 640px) {
  .en-row { grid-template-columns: minmax(0, 1fr); }
  .en-byte { width: 40px; }
  .en-regbig div { width: 44px; }
}
@media (prefers-reduced-motion: reduce) { .en-win { transition: none; } }
`;

export function page(root, ctx) {
  document.head.append(h('style', {}, CSS));
  const st = { width: store.get(), sel: null, half: false, dataKey: '', drag: null, bytes: [] };

  // ------------------------------------------------------------ top bar
  const modeBtns = [['bytes', 'Bytes → values'], ['value', 'Value → bytes']].map(([v, t]) => h('button', { 'data-v': v, 'aria-pressed': 'false',
    onclick: () => { if (ctx.raw.mode !== v) ctx.set('mode', v); } }, t));
  const bytesIn = h('input', { type: 'text', id: 'en-bytes', spellcheck: 'false', placeholder: '12 34 56 78, 0x12,0x34 or 12345678',
    oninput: (e) => ctx.set('bytes', e.target.value) });
  const valueIn = h('input', { type: 'text', id: 'en-value', spellcheck: 'false', placeholder: '1000, -5, 0x1234, 3.14',
    oninput: (e) => ctx.set('value', e.target.value) });
  const typeBtns = Object.entries(TYPE_NAMES).map(([k, n]) => h('button', { 'data-v': k, 'aria-pressed': 'false', onclick: () => ctx.set('type', k) }, n));
  const inBytes = h('div', { class: 'grow' }, h('label', { class: 'en-h', for: 'en-bytes' }, 'Bytes'), bytesIn);
  const inValue = h('div', { class: 'grow' }, h('label', { class: 'en-h', for: 'en-value' }, 'Value'), valueIn);
  const typeRow = h('div', { class: 'en-seg en-types', role: 'group', 'aria-label': 'Type' }, typeBtns);
  const warns = h('div', { class: 'en-warns', 'aria-live': 'polite' });
  const top = h('section', { class: 'en-panel' },
    h('div', { class: 'en-top' }, h('span', { class: 'en-seg', role: 'group', 'aria-label': 'Direction' }, modeBtns), inBytes, inValue, typeRow), warns);

  // ------------------------------------------------------------ memory strip (bytes mode)
  const widthBtns = [1, 2, 4, 8].map((n) => h('button', { 'data-n': n, 'aria-pressed': 'false', onclick: () => { st.width = n; store.set(n); drawAll(); } },
    `${n} byte${n > 1 ? 's' : ''}`));
  const offIn = h('input', { type: 'text', id: 'en-off', spellcheck: 'false', inputmode: 'numeric', style: 'width:52px;text-align:right',
    oninput: (e) => ctx.set('offset', e.target.value) });
  const memInfo = h('span', { class: 'en-soft', style: 'font-size:12px' });
  const strip = h('div', { class: 'en-strip', role: 'grid', 'aria-label': 'Memory, one byte per cell. Click a byte and type hex to edit it.' });
  const tabLabel = h('span', {});
  const tab = h('div', { class: 'en-tab', tabindex: '0', role: 'slider', 'aria-label': 'Window offset: drag, or arrow keys' }, h('span', { class: 'grip', 'aria-hidden': 'true' }, '⋮⋮'), tabLabel);
  const win = h('div', { class: 'en-win', 'aria-hidden': 'false' }, tab);
  const scroll = h('div', { class: 'en-scroll' }, h('div', { style: 'position:relative' }, strip, win));
  const mem = h('section', { class: 'en-panel en-mem' },
    h('div', { class: 'en-memhead' }, h('span', { class: 'en-h' }, 'Memory'), memInfo, h('span', { class: 'sp' }),
      h('span', { class: 'en-soft', style: 'font-size:12px' }, 'read'), h('span', { class: 'en-seg', role: 'group', 'aria-label': 'Window width' }, widthBtns),
      h('label', { class: 'en-soft', style: 'font-size:12px;display:inline-flex;gap:5px;align-items:center', for: 'en-off' }, 'at +', offIn)),
    scroll,
    h('div', { class: 'en-hint' }, 'Drag the window by its tab (or focus it: ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'),
      '). Click a byte and type hex; ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' move, ', h('kbd', {}, 'Del'), ' removes. Hover a byte to trace its wires.'));

  // ------------------------------------------------------------ register (value mode)
  const regBig = h('div', { class: 'en-regbig' });
  const regInfo = h('span', { class: 'en-soft', style: 'font-size:12px' });
  const reg = h('section', { class: 'en-panel en-mem' }, h('div', { class: 'en-memhead' }, h('span', { class: 'en-h' }, 'Register'), regInfo), regBig);

  const rows = h('div', { class: 'en-rows' });
  const notes = h('div', { class: 'en-notes' });
  const main = h('div', { class: 'en-col' }, top, mem, reg, rows);
  root.append(h('div', { class: 'en' }, main, h('div', { class: 'en-col' }, ctx.outputs, notes)));

  // hover a byte (in the strip or on a crossbar) to light its wires
  main.addEventListener('pointerover', (e) => {
    const s = e.target.closest?.('[data-s]');
    if (s && main.contains(s)) { main.classList.add('en-hl'); main.dataset.hl = s.getAttribute('data-s'); }
  });
  main.addEventListener('pointerout', (e) => {
    if (!e.relatedTarget || !e.relatedTarget.closest?.('[data-s]')) { main.classList.remove('en-hl'); delete main.dataset.hl; }
  });

  const syncVal = (el, v) => { if (document.activeElement !== el && el.value !== v) el.value = v; };

  // ------------------------------------------------------------ editing bytes
  const writeBytes = (arr) => { st.refocus = true; ctx.set('bytes', arr.map(hx).join(' ')); };
  function editKey(e, i) {
    const k = e.key;
    const arr = [...st.bytes];
    if (/^[0-9a-fA-F]$/.test(k)) {
      e.preventDefault();
      const d = parseInt(k, 16);
      if (!st.half) { arr[i] = (d << 4) | (arr[i] & 15); st.half = true; st.sel = i; }
      else { arr[i] = (arr[i] & 0xF0) | d; st.half = false; st.sel = Math.min(i + 1, arr.length - 1); }
      writeBytes(arr);
    } else if (k === 'ArrowRight' || k === 'ArrowLeft') {
      e.preventDefault();
      st.half = false;
      st.sel = Math.max(0, Math.min(arr.length - 1, i + (k === 'ArrowRight' ? 1 : -1)));
      markSel(true);
    } else if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      if (arr.length <= 1) return;
      arr.splice(i, 1);
      st.half = false;
      st.sel = Math.max(0, Math.min(arr.length - 1, k === 'Backspace' ? i - 1 : i));
      writeBytes(arr);
    } else if (k === 'Escape') { st.sel = null; st.half = false; markSel(false); e.target.blur(); }
  }
  function markSel(focus) {
    [...strip.querySelectorAll('.en-byte')].forEach((el, j) => {
      el.classList.toggle('sel', j === st.sel);
      el.classList.toggle('half', j === st.sel && st.half);
      el.tabIndex = j === (st.sel ?? 0) ? 0 : -1;
    });
    if (focus && st.sel != null) strip.children[st.sel]?.focus({ preventScroll: false });
  }

  // ------------------------------------------------------------ window dragging
  const cellPitch = () => {
    const a = strip.children[0], b = strip.children[1];
    return a && b ? b.offsetLeft - a.offsetLeft : 50;
  };
  tab.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    tab.setPointerCapture?.(e.pointerId);
    tab.classList.add('drag');
    const pitch = cellPitch();
    const start = { x: e.clientX, off: ctx.result?.inspect?.offset ?? 0 };
    st.drag = true;
    const move = (ev) => {
      const n = st.bytes.length;
      const off = Math.max(0, Math.min(n - 1, Math.round(start.off + (ev.clientX - start.x) / pitch)));
      if (String(off) !== String(ctx.raw.offset)) ctx.set('offset', String(off));
    };
    const up = () => {
      st.drag = false;
      tab.classList.remove('drag');
      tab.removeEventListener('pointermove', move);
      tab.removeEventListener('pointerup', up);
      tab.removeEventListener('pointercancel', up);
    };
    tab.addEventListener('pointermove', move);
    tab.addEventListener('pointerup', up);
    tab.addEventListener('pointercancel', up);
  });
  tab.addEventListener('keydown', (e) => {
    const off = ctx.result?.inspect?.offset ?? 0;
    const n = st.bytes.length;
    let to = null;
    if (e.key === 'ArrowRight') to = off + 1;
    else if (e.key === 'ArrowLeft') to = off - 1;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = Math.max(0, n - (st.width || 1));
    if (to == null) return;
    e.preventDefault();
    ctx.set('offset', String(Math.max(0, Math.min(n - 1, to))));
  });

  // ------------------------------------------------------------ result
  ctx.onResult(() => drawAll());

  function drawAll() {
    const res = ctx.result || {};
    const raw = ctx.raw;
    const valueMode = raw.mode === 'value';
    for (const b of modeBtns) b.setAttribute('aria-pressed', String(b.dataset.v === (valueMode ? 'value' : 'bytes')));
    inBytes.hidden = valueMode; mem.hidden = valueMode;
    inValue.hidden = !valueMode; typeRow.hidden = !valueMode; reg.hidden = !valueMode;
    syncVal(bytesIn, String(raw.bytes ?? ''));
    syncVal(valueIn, String(raw.value ?? ''));
    syncVal(offIn, String(raw.offset ?? ''));
    for (const b of typeBtns) b.setAttribute('aria-pressed', String(b.dataset.v === (raw.type || 'u32')));
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(...(res.notes || []).map((n) => h('div', {}, n)));
    if (valueMode) drawValue(res);
    else drawBytes(res);
  }

  // ------------------------------------------------------------ bytes to values
  function drawBytes(res) {
    const ins = res.inspect;
    bytesIn.classList.toggle('bad', !ins && !(res.warnings || []).some((w) => /past the end/.test(w)));
    if (!ins) { rows.replaceChildren(); win.hidden = true; return; }
    const all = ins.bytes, off = ins.offset;
    const avail = Math.min(8, all.length - off);
    const maxW = [8, 4, 2, 1].find((n) => n <= avail) || 1;
    let w = st.width && st.width <= avail ? st.width : Math.min(4, maxW);
    if (![1, 2, 4, 8].includes(w)) w = maxW;
    for (const b of widthBtns) {
      const n = Number(b.dataset.n);
      b.setAttribute('aria-pressed', String(n === w));
      b.disabled = n > avail;
    }
    memInfo.textContent = `${all.length} byte${all.length === 1 ? '' : 's'}${all.length > off + 8 ? ` · only 8 from +${off} are read` : ''}`;

    // the strip: rebuilt only when the bytes change
    const key = all.join(',');
    if (key !== st.dataKey) {
      st.dataKey = key;
      st.bytes = all;
      const cells = all.map((b, i) => h('div', { class: 'en-byte', role: 'gridcell', tabindex: '-1', 'aria-label': `+${i}: 0x${hx(b)}`,
        onclick: () => { st.sel = i; st.half = false; markSel(true); },
        onkeydown: (e) => editKey(e, i) },
      h('small', {}, `+${i}`), h('b', {}, hx(b)), h('i', {}, printable(b))));
      strip.replaceChildren(...cells, h('button', { class: 'en-add', title: 'Add a byte 00 at the end', 'aria-label': 'Add a byte',
        onclick: () => { st.sel = all.length; st.half = false; writeBytes([...all, 0]); } }, '+'));
      if (st.sel != null && st.sel >= all.length) st.sel = all.length - 1;
    }
    // colour the window's bytes by letter
    [...strip.querySelectorAll('.en-byte')].forEach((el, i) => {
      const inWin = i >= off && i < off + w;
      el.classList.toggle('in', inWin);
      el.classList.toggle('far', i >= off + 8 || i < off);
      el.style.borderColor = inWin ? `var(--tool-b${i - off})` : '';
      if (inWin) el.setAttribute('data-s', String(i - off)); else el.removeAttribute('data-s');
      const sm = el.querySelector('small');
      sm.textContent = inWin ? `+${i} ${LET[i - off]}` : `+${i}`;
      sm.style.color = inWin ? `var(--tool-b${i - off})` : '';
      sm.style.fontWeight = inWin ? '600' : '';
    });
    markSel(st.refocus);
    st.refocus = false;
    // place the window
    win.hidden = false;
    const c0 = strip.children[off], c1 = strip.children[off + w - 1];
    if (c0 && c1) {
      win.style.left = `${c0.offsetLeft - 5}px`;
      win.style.width = `${c1.offsetLeft + c1.offsetWidth - c0.offsetLeft + 10}px`;
    }
    const tnames = TYPES_BY_SIZE[w].map((t) => TYPE_NAMES[t].replace('_t', '')).join(' / ');
    tabLabel.textContent = `+${off} · ${w} B · ${tnames}`;
    tab.setAttribute('aria-valuenow', String(off));
    tab.setAttribute('aria-valuetext', `offset ${off}, ${w} bytes`);
    if (!st.drag && c0) {
      const l = c0.offsetLeft - 8, r = (c1 || c0).offsetLeft + 60;
      if (l < scroll.scrollLeft || r > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = Math.max(0, l - 20);
    }

    // the crossbars for this width
    const rd = ins.reads.find((r) => r.size === w);
    if (!rd) { rows.replaceChildren(); return; }
    const src = all.slice(off, off + w);
    // the order whose float (or, without floats, nothing) reads ordinary
    const fl = w === 4 ? 'f32' : w === 8 ? 'f64' : null;
    const ok = fl ? rd.orders.map((o) => plausible(o.values[fl])) : [];
    const onlyOne = ok.filter(Boolean).length === 1;
    rows.replaceChildren(...rd.orders.map((o, oi) => {
      const svg = crossbar(src, o.perm, w, 'bytes');
      const vals = TYPES_BY_SIZE[w].map((t) => {
        const s = o.values[t];
        const isF = t[0] === 'f';
        const cls = isF ? (plausible(s) ? 'pl' : 'im') : '';
        return [h('dt', {}, TYPE_NAMES[t]), h('dd', { class: cls }, s, isF && plausible(s) && onlyOne ? h('em', {}, 'the only ordinary float') : null)];
      });
      return h('section', { class: `en-panel en-row${onlyOne && ok[oi] ? ' best' : ''}` },
        h('div', { class: 'en-rt' }, h('b', {}, o.name), h('span', {}, tagOf(o.name))),
        svg,
        h('div', { class: 'en-info' }, h('div', { class: 'en-hex' }, '0x' + o.bytes.map(hx).join('')), h('dl', { class: 'en-vals' }, vals.flat()),
          h('span', { class: 'en-soft', style: 'font-size:10.5px' }, w > 1 ? 'top: memory, +0 first · bottom: register, most significant first' : 'top: memory · bottom: register')));
    }));
  }

  // ------------------------------------------------------------ value to bytes
  function drawValue(res) {
    const lay = res.layout;
    valueIn.classList.toggle('bad', !lay);
    if (!lay) { rows.replaceChildren(); regBig.replaceChildren(); return; }
    const n = lay.size;
    regInfo.textContent = `${lay.name} ${lay.value} · most significant byte first`;
    regBig.replaceChildren(...lay.be.map((b, i) => h('div', { 'data-s': String(i), style: `border-color:var(--tool-b${i})` },
      h('small', { style: `color:var(--tool-b${i});font-weight:600` }, n === 1 ? 'byte' : i === 0 ? 'MSB A' : i === n - 1 ? `LSB ${LET[i]}` : LET[i]), h('b', {}, hx(b)))));
    const trows = res.tables?.[0]?.rows || [];
    rows.replaceChildren(...lay.orders.map((o, oi) => {
      const svg = crossbar(lay.be, o.perm, n, 'value');
      return h('section', { class: 'en-panel en-row' },
        h('div', { class: 'en-rt' }, h('b', {}, o.name), h('span', {}, tagOf(o.name))),
        svg,
        h('div', { class: 'en-info' },
          h('span', { class: 'en-soft', style: 'font-size:11.5px' }, 'in memory, lowest address first'),
          h('div', { class: 'en-hex' }, trows[oi]?.[1] ?? o.bytes.map(hx).join(' ')),
          h('code', { class: 'en-code' }, trows[oi]?.[2] ?? ''),
          h('span', { class: 'en-soft', style: 'font-size:10.5px' }, n > 1 ? 'top: the value, most significant first · bottom: memory, +0 first' : '')));
    }));
  }

  // One order as a crossbar: the source bytes on top, the destination below,
  // out[i] = in[perm[i]]. Bytes mode: memory (address order) -> register (MSB
  // first). Value mode: register (MSB first) -> memory (address order).
  function crossbar(inBytes, perm, n, dir) {
    const narrow = rows.clientWidth < 420;
    const cw = n <= 2 ? 50 : n <= 4 ? (narrow ? 40 : 46) : (narrow ? 34 : 36);
    const gap = 4;
    const W = n * cw + (n - 1) * gap;
    const top = 16, ch = 26, bot = 92, bh = 30;
    const H = bot + bh + 16;
    const svg = sv('svg', { class: 'en-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img',
      'aria-label': dir === 'bytes' ? `register = ${perm.map((i) => LET[i]).join('')}` : `memory = ${perm.map((i) => LET[i]).join('')}` });
    const cx = (i) => i * (cw + gap) + cw / 2;
    // wires first, under the cells
    perm.forEach((s, i) => {
      const x0 = cx(s), x1 = cx(i);
      svg.append(sv('path', { d: `M${x0} ${top + ch}C${x0} ${top + ch + 32} ${x1} ${bot - 32} ${x1} ${bot}`, class: 'wire', 'data-s': String(s),
        style: `stroke:var(--tool-b${s})` }));
    });
    // source row
    inBytes.forEach((b, i) => {
      const x = i * (cw + gap);
      svg.append(sv('rect', { x: x + 1, y: top, width: cw - 2, height: ch, rx: 3, class: 'cell dim', 'data-s': String(i),
        style: `fill:var(--surface);stroke:var(--tool-b${i})` }));
      svg.append(sv('text', { x: x + cw / 2, y: top + 17.5, class: 'ct', 'text-anchor': 'middle' }, hx(b)));
      svg.append(sv('text', { x: x + 4, y: top - 3, class: 'cl', style: `fill:var(--tool-b${i})` }, n > 1 ? LET[i] : ''));
    });
    // destination row
    perm.forEach((s, i) => {
      const x = i * (cw + gap);
      svg.append(sv('rect', { x: x + 1, y: bot, width: cw - 2, height: bh, rx: 3, class: 'cell', 'data-s': String(s),
        style: `fill:var(--tool-b${s});fill-opacity:var(--fill-alpha);stroke:var(--tool-b${s})` }));
      svg.append(sv('text', { x: x + cw / 2, y: bot + 20, class: 'ct', 'text-anchor': 'middle' }, hx(inBytes[s])));
      if (n > 1) svg.append(sv('text', { x: x + cw / 2, y: bot + bh + 11, class: 'cl', 'text-anchor': 'middle', style: `fill:var(--tool-b${s})` },
        dir === 'bytes' ? LET[s] : `+${i}`));
    });
    return svg;
  }

  let lastW = 0;
  new ResizeObserver(() => {
    const w = Math.round(rows.clientWidth);
    if (w && Math.abs(w - lastW) > 30) { lastW = w; drawAll(); }
  }).observe(rows);
}
