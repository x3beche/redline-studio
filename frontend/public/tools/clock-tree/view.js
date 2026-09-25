// Clock Tree Planner: the page is the RCC clock tree itself.
//   Tree   - the crystal (or the internal RC) through the source switch, the
//            PLL's divider, multiplier and dividers, the AHB and APB
//            prescalers to the clocks the peripherals get, drawn left to right
//            as a signal-flow diagram (a vertical tree on a phone). Every block
//            carries its setting, the frequency it puts out and a gauge of the
//            chip's legal range. Click the switch to change the source, step
//            the crystal or type it on the crystal, step the AHB prescaler on
//            its block, switch the 48 MHz branch on or off on its block.
//   Ruler  - SYSCLK from 0 to the chip's maximum, shaded by flash wait
//            states; drag the target (or use the arrow keys) and watch the
//            PLL find the dividers and the wait states step.
//   Below  - the HAL code and the other outputs, the other PLL settings,
//            warnings and notes.
// Every number drawn comes from run()'s result (result.drawing / values).

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

const CSS = `
.ckt { --tool-sig: #1f4ed8; --tool-idle: #9aa9b7; --tool-band: #2f855a; --tool-ws0: #e7eef5; --tool-ws1: #d6e1eb; --tool-usb: #0f8a7a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .ckt {
  --tool-sig: #7b98ff; --tool-idle: #4a5b6a; --tool-band: #68b36b; --tool-ws0: #17212a; --tool-ws1: #1d2833; --tool-usb: #3cc7b3; } }
:root[data-theme="dark"] .ckt { --tool-sig: #7b98ff; --tool-idle: #4a5b6a; --tool-band: #68b36b; --tool-ws0: #17212a; --tool-ws1: #1d2833; --tool-usb: #3cc7b3; }
.ckt { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ckt-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.ckt-head { display: flex; align-items: center; gap: 8px 14px; flex-wrap: wrap; padding: 7px 12px; border-bottom: 1px solid var(--line-soft); }
.ckt-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.ckt-head .sub { font-size: 11.5px; color: var(--ink-soft); }
.ckt-head .sub b { font: 500 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.ckt-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.ckt-chip { border: 1px solid var(--line); background: var(--sunken); border-radius: 3px; padding: 3px 8px; cursor: pointer;
  font: 500 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.ckt-chip span { font-weight: 400; opacity: .8; }
.ckt-chip:hover { border-color: var(--ink-soft); }
.ckt-chip[aria-pressed="true"] { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.ckt-stage { position: relative; }
.ckt-wires { position: absolute; left: 0; top: 0; pointer-events: none; }
.ckt-b { position: absolute; box-sizing: border-box; background: var(--surface); border: 1.5px solid var(--line); border-radius: 5px;
  padding: 4px 8px 5px; display: flex; flex-direction: column; gap: 1px; min-width: 0; overflow: hidden; }
.ckt-b.on { border-color: var(--tool-sig); }
.ckt-b.off { opacity: .55; border-style: dashed; }
.ckt-b.bad { border-color: var(--danger); }
.ckt-b.warn { border-color: var(--warn); }
.ckt-b.sink { background: var(--sunken); border-radius: 14px 5px 5px 14px; }
.ckt-b .t { font-size: 10.5px; color: var(--ink-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; gap: 6px; align-items: center; }
.ckt-b .t b { color: var(--ink); font-weight: 600; font-size: 11px; }
.ckt-b .v { display: flex; align-items: center; gap: 4px; font: 500 15px "IBM Plex Mono", ui-monospace, monospace; white-space: nowrap; }
.ckt-b .v small { font-size: 11px; color: var(--ink-soft); font-weight: 400; }
.ckt-b .o { font: 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ckt-b .o b { color: var(--ink); font-weight: 500; }
.ckt-b .o b.bad { color: var(--danger); } .ckt-b .o b.warn { color: var(--warn); } .ckt-b .o b.ok { color: var(--ok); }
.ckt-b .x { font-size: 10.5px; color: var(--ink-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ckt-b svg.g { display: block; width: 100%; height: 8px; margin-top: 2px; overflow: visible; }
.ckt-b input[type="text"] { width: 52px; padding: 1px 4px; border: 1px solid var(--line); border-radius: 3px; background: var(--sunken);
  font: 500 14px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.ckt-b input.bad { border-color: var(--danger); }
.ckt-stage.nar .ckt-b { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 8px; row-gap: 1px; align-content: start; }
.ckt-stage.nar .ckt-b .t { grid-column: 1; grid-row: 1; }
.ckt-stage.nar .ckt-b .v { grid-column: 2; grid-row: 1 / span 2; justify-self: end; align-self: center; }
.ckt-stage.nar .ckt-b .o { grid-column: 1; grid-row: 2; }
.ckt-stage.nar .ckt-b .x { grid-column: 1 / -1; grid-row: 3; }
.ckt-eq { position: absolute; font-size: 11.5px; color: var(--ink-soft); border-left: 2px solid var(--line); padding: 2px 0 2px 10px; display: flex; flex-direction: column; gap: 3px; }
.ckt-eq .n { font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.ckt-eq .n b { color: var(--ink); font-weight: 600; }
.ckt-step { border: 1px solid var(--line); background: var(--surface); border-radius: 3px; width: 20px; height: 20px; padding: 0; cursor: pointer;
  font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); line-height: 1; }
.ckt-step:hover { border-color: var(--ink-soft); color: var(--ink); }
.ckt-mux { position: absolute; padding: 0; border: 0; background: transparent; cursor: pointer; }
.ckt-mux svg { display: block; width: 100%; height: 100%; }
.ckt-mux:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ckt-xtal { cursor: ew-resize; touch-action: none; flex: none; }
.ckt-sw { display: inline-flex; align-items: center; gap: 5px; border: 0; background: none; padding: 0; cursor: pointer; font-size: 10.5px; color: var(--ink-soft); }
.ckt-sw i { width: 24px; height: 13px; border-radius: 7px; background: var(--line); position: relative; transition: background .15s; }
.ckt-sw i::after { content: ""; position: absolute; left: 2px; top: 2px; width: 9px; height: 9px; border-radius: 50%; background: var(--surface); transition: left .15s; }
.ckt-sw[aria-checked="true"] i { background: var(--tool-usb); }
.ckt-sw[aria-checked="true"] i::after { left: 13px; }
.ckt-sw:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ckt-ruler svg { display: block; width: 100%; user-select: none; -webkit-user-select: none; }
.ckt-ruler text { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink-soft); }
.ckt-ruler text.ink { fill: var(--ink); }
.ckt-ruler .hdl { cursor: ew-resize; touch-action: none; }
.ckt-ruler .hdl:focus { outline: none; }
.ckt-ruler .hdl:focus-visible .ring { stroke: var(--accent); stroke-width: 3; }
.ckt-ruler .surf { cursor: crosshair; touch-action: none; }
.ckt-ruler .head input { width: 70px; padding: 2px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 500 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.ckt-ruler .head input.bad { border-color: var(--danger); }
.ckt-ruler .head label { display: inline-flex; gap: 5px; align-items: center; font-size: 11.5px; color: var(--ink-soft); }
.ckt-help { padding: 5px 12px 8px; font-size: 11.5px; color: var(--ink-soft); }
.ckt-help kbd { font: 10.5px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px; padding: 0 3px; }
.ckt-low { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 10px; align-items: start; }
@media (max-width: 900px) { .ckt-low { grid-template-columns: minmax(0, 1fr); } }
.ckt-side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ckt-warns { border: 1px solid var(--warn); border-left-width: 3px; border-radius: 6px; padding: 6px 10px; background: var(--surface); font-size: 12px; }
.ckt-warns div + div { margin-top: 4px; }
.ckt-warns:empty { display: none; }
.ckt-alt table { border-collapse: collapse; width: 100%; font: 11.5px "IBM Plex Mono", ui-monospace, monospace; }
.ckt-alt th { text-align: left; font: 500 10.5px "IBM Plex Sans", sans-serif; color: var(--ink-soft); padding: 3px 8px; border-bottom: 1px solid var(--line); }
.ckt-alt td { padding: 3px 8px; border-bottom: 1px solid var(--line-soft); white-space: nowrap; }
.ckt-alt tr.cur td { color: var(--tool-sig); font-weight: 600; }
.ckt-alt .wrap { overflow-x: auto; }
.ckt-notes { font-size: 11.5px; color: var(--ink-soft); }
.ckt-notes summary { cursor: pointer; }
.ckt-notes div { margin-top: 4px; }
.ckt .k-out { max-height: 260px; }
`;

const XTALS = [4, 6, 8, 10, 12, 12.288, 16, 20, 24, 25, 26, 27, 32, 40, 48];
const AHB = ['1', '2', '4', '8', '16', '64', '128', '256', '512'];
const FAM = [['f407', 'F405/407', '168'], ['f429', 'F427/429', '180'], ['f411', 'F411', '100'], ['g474', 'G431/474', '170'], ['rp2040', 'RP2040', '133']];
const PERI = {
  f4: { p1: 'USART2/3, I2C, SPI2/3, TIM2-7', p2: 'USART1/6, SPI1, ADC, TIM1/8', q: 'USB OTG FS, SDIO, RNG' },
  g4: { p1: 'USART2/3, I2C, SPI2/3, FDCAN, TIM2-7', p2: 'USART1, SPI1/4, TIM1/8/15-20', q: 'USB FS, (FDCAN via PLLQ)' },
};

export function page(root, ctx) {
  const f = ctx.fmtNum;
  const mhz = (hz, d = 4) => (hz == null ? '–' : hz >= 1e6 ? `${f(hz / 1e6, d)} MHz` : hz >= 1e3 ? `${f(hz / 1e3, d)} kHz` : `${f(hz, d)} Hz`);
  root.append(h('style', {}, CSS));
  const wrap = h('div', { class: 'ckt' });
  root.append(wrap);

  // ---------- the tree ----------
  const chips = h('div', { class: 'ckt-chips', role: 'group', 'aria-label': 'Microcontroller' });
  const treeSub = h('span', { class: 'sub' });
  const stage = h('div', { class: 'ckt-stage' });
  const wires = s('svg', { class: 'ckt-wires', 'aria-hidden': 'true' });
  stage.append(wires);
  let treeHelp;
  const treeCard = h('section', { class: 'ckt-card' },
    h('div', { class: 'ckt-head' }, h('h2', {}, 'Clock tree'), chips, treeSub), stage,
    treeHelp = h('div', { class: 'ckt-help' }, 'Click the source switch to change between crystal and internal RC; step or type the crystal (or drag its symbol sideways); step the AHB prescaler; switch the 48 MHz branch. The PLL dividers and APB prescalers are chosen by the planner.'));

  // ---------- the SYSCLK ruler ----------
  const targetIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Wanted system clock in MHz',
    oninput: (e) => ctx.set('target', e.target.value) });
  const rulerSub = h('span', { class: 'sub' });
  const rulerHelpTail = h('span', {});
  const rulerSvg = s('svg', { role: 'group', 'aria-label': 'System clock ruler with flash wait states' });
  const rulerCard = h('section', { class: 'ckt-card ckt-ruler' },
    h('div', { class: 'ckt-head head' }, h('h2', {}, 'SYSCLK'), h('label', {}, 'wanted', targetIn, 'MHz'), rulerSub), rulerSvg,
    h('div', { class: 'ckt-help' }, 'Drag the wanted clock along the ruler, or focus its handle and use ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'),
      ' (', h('kbd', {}, 'Shift'), ' 10 MHz).', rulerHelpTail));

  // ---------- below ----------
  const warns = h('div', { class: 'ckt-warns', role: 'status', 'aria-live': 'polite' });
  const altBody = h('div', { class: 'wrap' });
  const altCard = h('section', { class: 'ckt-card ckt-alt' }, h('div', { class: 'ckt-head' }, h('h2', {}, 'Other PLL settings for this clock')), altBody);
  const notes = h('details', { class: 'ckt-notes' }, h('summary', {}, 'Limits and how the search chooses'));
  wrap.append(treeCard, rulerCard, h('div', { class: 'ckt-low' }, ctx.outputs, h('div', { class: 'ckt-side' }, warns, altCard, notes)));

  let res = null;
  let built = null; // the kind the blocks were built for
  const B = {};     // blocks by id

  // A crystal input that survives redraws (it keeps focus while typing).
  const xtalIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Crystal frequency in MHz',
    oninput: (e) => ctx.set('xtal', e.target.value) });
  const stepXtal = (dir) => {
    const cur = Number(ctx.input.xtal) || 8;
    const list = dir > 0 ? XTALS.filter((x) => x > cur + 1e-9) : XTALS.filter((x) => x < cur - 1e-9).reverse();
    if (list.length) ctx.set('xtal', String(list[0]));
  };
  const stepAhb = (dir) => {
    const i = Math.max(0, AHB.indexOf(String(ctx.raw.ahb || '1')));
    const j = Math.max(0, Math.min(AHB.length - 1, i + dir));
    if (j !== i) ctx.set('ahb', AHB[j]);
  };
  const crystalGlyph = () => {
    const g = s('svg', { class: 'ckt-xtal', width: 22, height: 26, viewBox: '0 0 22 26', role: 'slider', tabindex: 0,
      'aria-label': 'Crystal: drag sideways or use arrow keys to step through standard values' });
    g.append(s('line', { x1: 11, x2: 11, y1: 0, y2: 6, stroke: 'currentColor', 'stroke-width': 1.4 }));
    g.append(s('line', { x1: 3, x2: 19, y1: 6, y2: 6, stroke: 'currentColor', 'stroke-width': 1.6 }));
    g.append(s('rect', { x: 5, y: 9, width: 12, height: 8, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 }));
    g.append(s('line', { x1: 3, x2: 19, y1: 20, y2: 20, stroke: 'currentColor', 'stroke-width': 1.6 }));
    g.append(s('line', { x1: 11, x2: 11, y1: 20, y2: 26, stroke: 'currentColor', 'stroke-width': 1.4 }));
    g.style.color = 'var(--ink)';
    g.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); stepXtal(1); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); stepXtal(-1); }
    });
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      g.focus({ preventScroll: true });
      let x0 = e.clientX;
      const move = (ev) => { const dx = ev.clientX - x0; if (Math.abs(dx) >= 18) { stepXtal(Math.sign(dx)); x0 = ev.clientX; } };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    });
    return g;
  };
  const xtalGlyph = crystalGlyph();

  // A gauge: the legal range shaded on an axis, the value as a tick.
  function gauge(val, lo, hi, axisHi, tone) {
    const g = s('svg', { class: 'g', viewBox: '0 0 100 8', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const X = (v) => Math.max(0, Math.min(100, (v / axisHi) * 100));
    g.append(s('rect', { x: 0, y: 3, width: 100, height: 2, fill: 'var(--line)' }));
    g.append(s('rect', { x: X(lo), y: 2, width: Math.max(0.8, X(hi) - X(lo)), height: 4, fill: 'var(--tool-band)', 'fill-opacity': 0.45 }));
    const col = tone === 'bad' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : 'var(--ink)';
    g.append(s('rect', { x: X(val) - 0.9, y: 0, width: 1.8, height: 8, fill: col }));
    return g;
  }
  const inRange = (v, [lo, hi]) => v >= lo * 0.9999 && v <= hi * 1.0001;

  // ---------- block construction ----------
  function block(id, cls = '') {
    const el = h('div', { class: `ckt-b ${cls}`, 'data-id': id },
      h('div', { class: 't' }), h('div', { class: 'v' }), h('div', { class: 'o' }), h('div', { class: 'x' }));
    B[id] = el;
    stage.append(el);
    return el;
  }
  const part = (id, sel) => B[id].querySelector(sel);
  function build(kind) {
    for (const el of stage.querySelectorAll('.ckt-b, .ckt-mux')) el.remove();
    for (const k of Object.keys(B)) delete B[k];
    built = kind;
    if (kind === 'rp') {
      block('xosc'); block('ref'); block('fb'); block('pd1'); block('pd2'); block('sys', 'sink');
      block('uref'); block('ufb'); block('upd1'); block('upd2'); block('usb', 'sink');
    } else {
      block('hsi'); block('hse');
      const mux = h('button', { class: 'ckt-mux', 'data-id': 'mux', onclick: () => ctx.set('source', ctx.raw.source === 'hsi' ? 'hse' : 'hsi') });
      B.mux = mux; stage.append(mux);
      block('m'); block('n'); block('p'); block('ahb'); block('apb1'); block('apb2'); block('q'); block('hclk', 'sink'); block('pclk1', 'sink'); block('pclk2', 'sink'); block('usb', 'sink');
    }
  }

  // Positions in grid units (column, row); the tree view for narrow screens is an ordered list with depth.
  const GRID = {
    stm: { cols: 8, rows: 5, at: { hsi: [0, 0], hse: [0, 1], mux: [1, 1], m: [1.45, 1], n: [2.6, 1], p: [3.75, 1], ahb: [4.9, 1], apb1: [6, 2], apb2: [6, 3], q: [3.75, 4],
      hclk: [7, 1], pclk1: [7, 2], pclk2: [7, 3], usb: [7, 4] } },
    rp: { cols: 7, rows: 2, at: { xosc: [0, 0.6], ref: [1, 0], fb: [2, 0], pd1: [3, 0], pd2: [4, 0], sys: [5.2, 0], uref: [1, 1.2], ufb: [2, 1.2], upd1: [3, 1.2], upd2: [4, 1.2], usb: [5.2, 1.2] } },
  };
  const TREE = {
    stm: [['hsi', 0], ['hse', 0], ['mux', 0], ['m', 1], ['n', 1], ['p', 2], ['ahb', 2], ['hclk', 3], ['apb1', 3], ['pclk1', 4], ['apb2', 3], ['pclk2', 4], ['q', 2], ['usb', 3]],
    rp: [['xosc', 0], ['ref', 1], ['fb', 1], ['pd1', 1], ['pd2', 1], ['sys', 2], ['uref', 1], ['ufb', 1], ['upd1', 1], ['upd2', 1], ['usb', 2]],
  };
  const EDGES = {
    stm: [['hsi', 'mux', 'hsi'], ['hse', 'mux', 'hse'], ['mux', 'm'], ['m', 'n'], ['n', 'p'], ['n', 'q', 'usb'], ['p', 'ahb'], ['ahb', 'hclk'], ['ahb', 'apb1'], ['ahb', 'apb2'], ['apb1', 'pclk1'], ['apb2', 'pclk2'], ['q', 'usb', 'usb']],
    rp: [['xosc', 'ref'], ['ref', 'fb'], ['fb', 'pd1'], ['pd1', 'pd2'], ['pd2', 'sys'], ['xosc', 'uref', 'usb'], ['uref', 'ufb', 'usb'], ['ufb', 'upd1', 'usb'], ['upd1', 'upd2', 'usb'], ['upd2', 'usb', 'usb']],
  };
  const PARENT = { stm: { hsi: null, hse: null, mux: 'hse', m: 'mux', n: 'm', p: 'n', ahb: 'p', hclk: 'ahb', apb1: 'ahb', pclk1: 'apb1', apb2: 'ahb', pclk2: 'apb2', q: 'n', usb: 'q' },
    rp: { xosc: null, ref: 'xosc', fb: 'ref', pd1: 'fb', pd2: 'pd1', sys: 'pd2', uref: 'xosc', ufb: 'uref', upd1: 'ufb', upd2: 'upd1', usb: 'upd2' } };

  // ---------- fill the blocks from the result ----------
  function fill(d) {
    const setT = (id, name, extra) => part(id, '.t').replaceChildren(...[h('b', {}, name), extra != null ? h('span', {}, extra) : null].filter(Boolean));
    const setV = (id, ...kids) => part(id, '.v').replaceChildren(...kids.filter((k) => k != null));
    const setO = (id, ...kids) => part(id, '.o').replaceChildren(...kids.filter((k) => k != null));
    const setX = (id, ...kids) => part(id, '.x').replaceChildren(...kids.filter((k) => k != null));
    const tone = (id, t) => { B[id].classList.remove('bad', 'warn'); if (t) B[id].classList.add(t); };
    const on = (id, v) => { B[id].classList.toggle('on', !!v); };
    const off = (id, v) => { B[id].classList.toggle('off', !!v); };
    const b = (text, cls) => h('b', { class: cls || null }, text);
    const step = (label, dir, fn) => h('button', { class: 'ckt-step', 'aria-label': label, title: label, onclick: () => fn(dir) }, dir < 0 ? '‹' : '›');
    const xtalRange = `${f(d.srcRange[0] / 1e6, 3)}–${f(d.srcRange[1] / 1e6, 3)} MHz`;
    const xtalOk = inRange(d.fsrc, d.srcRange);
    const xtalBlock = (id, useIt) => {
      setT(id, d.kind === 'rp' ? 'XOSC crystal' : 'HSE crystal', 'MHz');
      if (!part(id, '.v').contains(xtalIn)) setV(id, xtalGlyph, xtalIn, step('Next lower standard crystal', -1, stepXtal), step('Next higher standard crystal', 1, stepXtal));
      setO(id, useIt ? b(xtalOk ? 'in range' : 'out of range', xtalOk ? 'ok' : 'bad') : 'not used', ` ${xtalRange}`);
      tone(id, useIt && !xtalOk ? 'bad' : null); on(id, useIt); off(id, !useIt);
    };

    if (d.kind === 'rp') {
      xtalBlock('xosc', true);
      const chain = (pre, c, name, outName) => {
        if (!c) {
          for (const k of ['ref', 'fb', 'pd1', 'pd2']) { const id = pre + k; setT(id, '–'); setV(id, '–'); setO(id, ''); setX(id); off(id, true); }
          return;
        }
        const ref = d.fsrc / c.r;
        setT(pre + 'ref', 'REFDIV', name); setV(pre + 'ref', '÷ ', c.r); setO(pre + 'ref', 'ref ', b(mhz(ref))); setX(pre + 'ref', gauge(ref, 5e6, d.fsrc, Math.max(d.fsrc, 5e6) * 1.1, ref >= 5e6 ? null : 'bad'));
        setT(pre + 'fb', 'FBDIV', 'VCO'); setV(pre + 'fb', '× ', c.fb); setO(pre + 'fb', 'VCO ', b(mhz(c.vco)));
        setX(pre + 'fb', gauge(c.vco, d.limits.vco[0], d.limits.vco[1], d.limits.vco[1] * 1.15, inRange(c.vco, d.limits.vco) ? null : 'bad'));
        setT(pre + 'pd1', 'POSTDIV1'); setV(pre + 'pd1', '÷ ', c.p1); setO(pre + 'pd1', b(mhz(c.vco / c.p1))); setX(pre + 'pd1');
        setT(pre + 'pd2', 'POSTDIV2'); setV(pre + 'pd2', '÷ ', c.p2); setO(pre + 'pd2', outName, ' ', b(mhz(c.out))); setX(pre + 'pd2');
        for (const k of ['ref', 'fb', 'pd1', 'pd2']) { on(pre + k, true); off(pre + k, false); tone(pre + k, null); }
      };
      chain('', d.sys, 'PLL_SYS', 'clk_sys');
      chain('u', d.usb, 'PLL_USB', 'clk_usb');
      const exact = Math.abs(d.sys.out - d.target) / d.target < 1e-6;
      setT('sys', 'clk_sys', 'core, bus, clk_peri (UART, SPI)'); setV('sys', mhz(d.sys.out));
      setO('sys', exact ? b('exact', 'ok') : b(`${f(d.sys.e * 100, 3)} % off`, 'warn'), d.sys.out > d.limits.sys * 1.0001 ? ' · overclocked' : ` · max ${mhz(d.limits.sys)}`);
      setX('sys', gauge(d.sys.out, 0, d.limits.sys, d.limits.sys * 1.25, d.sys.out > d.limits.sys * 1.0001 ? 'warn' : null));
      tone('sys', exact ? null : 'warn'); on('sys', true);
      const uok = d.usb && d.usb.ok;
      setT('usb', 'clk_usb · clk_adc', 'USB, ADC, RTC'); setV('usb', d.usb ? mhz(d.usb.out) : '–');
      setO('usb', uok ? b('±0.25 % ok', 'ok') : b('USB will not work', 'bad'), d.usb ? ` · rtc ${mhz(d.usb.out / 1024)}` : '');
      setX('usb', d.usb ? gauge(d.usb.out - 44e6, 48e6 * 0.9975 - 44e6, 48e6 * 1.0025 - 44e6, 8e6, uok ? null : 'bad') : null);
      tone('usb', uok ? null : 'bad'); on('usb', uok);
      return;
    }

    const hse = d.source === 'hse';
    // Oscillators and the switch.
    setT('hsi', 'HSI', 'internal RC'); setV('hsi', mhz(d.hsi)); setO('hsi', '±1 % · no USB'); setX('hsi');
    on('hsi', !hse); off('hsi', hse); tone('hsi', null);
    B.hsi.onclick = hse ? () => ctx.set('source', 'hsi') : null;
    B.hsi.style.cursor = hse ? 'pointer' : '';
    xtalBlock('hse', hse);
    B.mux.setAttribute('aria-label', `PLL source: ${hse ? 'crystal (HSE)' : 'internal RC (HSI)'}. Click to switch to ${hse ? 'HSI' : 'HSE'}.`);
    B.mux.title = 'PLL source switch: click to change';

    const vinOk = inRange(d.vin, d.limits.vin), vcoOk = inRange(d.vco, d.limits.vco);
    setT('m', 'PLLM'); setV('m', '÷ ', d.m); setO('m', 'in ', b(mhz(d.vin), vinOk ? null : 'bad'));
    setX('m', gauge(d.vin, d.limits.vin[0], d.limits.vin[1], d.limits.vin[1] * 1.25, vinOk ? null : 'bad'));
    setT('n', 'PLLN', 'VCO'); setV('n', '× ', d.n); setO('n', 'VCO ', b(mhz(d.vco), vcoOk ? null : 'bad'));
    setX('n', gauge(d.vco, d.limits.vco[0], d.limits.vco[1], d.limits.vco[1] * 1.12, vcoOk ? null : 'bad'));
    const exact = Math.abs(d.sys - d.target) / d.target < 1e-6;
    setT('p', d.pName, 'SYSCLK'); setV('p', '÷ ', d.p); setO('p', b(mhz(d.sys), exact ? null : 'warn'), exact ? ' exact' : ` ≠ ${mhz(d.target)}`);
    setX('p', gauge(d.sys, 0, d.limits.sys, d.limits.sys * 1.15, exact ? null : 'warn'));
    tone('p', exact ? null : 'warn');
    for (const id of ['m', 'n', 'p']) on(id, true);
    tone('m', vinOk ? null : 'bad'); tone('n', vcoOk ? null : 'bad');

    setT('ahb', 'AHB', 'HCLK'); setV('ahb', '÷ ', h('span', {}, String(d.ahb)), step('Smaller AHB divider', -1, stepAhb), step('Larger AHB divider', 1, stepAhb));
    setO('ahb', b(mhz(d.hclk))); setX('ahb'); on('ahb', true);
    const apb = (id, div, pclk, max, name) => {
      const ok = pclk <= max * 1.0001;
      setT(id, name, 'auto'); setV(id, '÷ ', div); setO(id, b(mhz(pclk), ok ? null : 'bad'), ` ≤ ${f(max / 1e6, 4)}`);
      setX(id, gauge(pclk, 0, max, Math.max(max, d.limits.sys) * 1.05, ok ? null : 'bad')); on(id, true); tone(id, ok ? null : 'bad');
    };
    apb('apb1', d.apb1, d.pclk1, d.limits.apb1, 'APB1');
    apb('apb2', d.apb2, d.pclk2, d.limits.apb2, 'APB2');

    const sw = h('button', { class: 'ckt-sw', role: 'switch', 'aria-checked': String(d.need48), 'aria-label': 'Need a 48 MHz clock',
      onclick: () => ctx.set('need48', !d.need48) }, h('i', {}), '48 MHz');
    setT('q', 'PLLQ', sw);
    if (d.need48) {
      setV('q', '÷ ', d.q);
      setO('q', b(mhz(d.f48, 5), d.ok48 ? 'ok' : 'bad'));
      setX('q', gauge(d.f48 - 44e6, 48e6 * 0.9975 - 44e6, 48e6 * 1.0025 - 44e6, 8e6, d.ok48 ? null : 'bad'));
      tone('q', d.ok48 ? null : 'bad');
    } else {
      setV('q', '÷ ', h('small', {}, 'not set')); setO('q', 'switched off'); setX('q'); tone('q', null);
    }
    on('q', d.need48); off('q', !d.need48);

    const peri = PERI[d.kind] || PERI.f4;
    const wsTxt = `flash ${d.ws} WS`;
    setT('hclk', 'HCLK'); setV('hclk', mhz(d.hclk)); setO('hclk', b(wsTxt), ` · SysTick ${mhz(d.hclk)} or ${mhz(d.hclk / 8)}`); setX('hclk', 'core, AHB, DMA, memory'); on('hclk', true);
    setT('pclk1', 'PCLK1'); setV('pclk1', mhz(d.pclk1)); setO('pclk1', 'timers ', b(mhz(d.tim1)), d.apb1 === 1 ? ' (= PCLK1)' : ' (2 × PCLK1)'); setX('pclk1', peri.p1); on('pclk1', true);
    setT('pclk2', 'PCLK2'); setV('pclk2', mhz(d.pclk2)); setO('pclk2', 'timers ', b(mhz(d.tim2)), d.apb2 === 1 ? ' (= PCLK2)' : ' (2 × PCLK2)'); setX('pclk2', peri.p2); on('pclk2', true);
    setT('usb', '48 MHz'); setX('usb', peri.q);
    if (d.need48) {
      setV('usb', mhz(d.f48, 5)); setO('usb', d.ok48 ? b('within ±0.25 %', 'ok') : b(`${f((d.f48 / 48e6 - 1) * 100, 3)} %: USB fails`, 'bad'));
      if (!hse) part('usb', '.o').append(h('span', { style: 'color:var(--warn)' }, ' · HSI too loose'));
      tone('usb', d.ok48 && hse ? null : d.ok48 ? 'warn' : 'bad');
    } else { setV('usb', h('small', {}, 'not used')); setO('usb', ''); tone('usb', null); }
    on('usb', d.need48 && d.ok48); off('usb', !d.need48);
  }

  // ---------- place the blocks and draw the wires ----------
  function place(d) {
    const kind = d.kind === 'rp' ? 'rp' : 'stm';
    const W = Math.max(300, stage.clientWidth || treeCard.clientWidth || 900);
    const narrow = W < 760;
    const pos = {};
    let H;
    if (!narrow) {
      const G = GRID[kind];
      const pad = 12, colW = (W - pad * 2) / G.cols;
      const rowH = kind === 'rp' ? 88 : 82;
      const bw = Math.min(176, colW - 26), bh = 70;
      for (const [id, [c, r]] of Object.entries(G.at)) {
        let w = bw, x = pad + c * colW;
        if (id === 'mux') { pos[id] = { x: x + 4, y: 12 + r * rowH + 6, w: 26, h: bh - 12 }; continue; }
        if (kind === 'stm' && ['m', 'n', 'p', 'ahb'].includes(id)) w = Math.min(bw, colW * 1.15 - 26);
        if (B[id]?.classList.contains('sink')) w = W - pad - x;
        pos[id] = { x, y: 12 + r * rowH, w, h: B[id]?.classList.contains('sink') && kind === 'stm' ? bh + 4 : bh };
      }
      H = 12 + G.rows * rowH;
      if (kind === 'rp') H = 12 + 2.2 * rowH + 8;
    } else {
      const rowH = 64, bh = 56, ind = 16;
      let y = 8;
      for (const [id, depth] of TREE[kind]) {
        const x = 8 + depth * ind;
        if (id === 'mux') { pos[id] = { x: x + 10, y, w: 40, h: 22 }; y += 30; continue; }
        pos[id] = { x, y, w: W - x - 8, h: bh };
        y += rowH;
      }
      H = y + 4;
    }
    stage.style.height = `${H}px`;
    stage.classList.toggle('nar', narrow);
    // The PLL as one equation, in the room the tree leaves free (wide STM32 only).
    stage.querySelector('.ckt-eq')?.remove();
    if (!narrow && kind === 'stm') {
      const G = GRID.stm, colW = (W - 24) / G.cols;
      const src = d.source === 'hse' ? 'HSE' : 'HSI';
      const eq = h('div', { class: 'ckt-eq', style: `left:12px;top:${12 + 2 * 82 + 6}px;width:${Math.min(2.4 * colW, 420)}px` },
        h('div', {}, 'SYSCLK = ', src, ' ÷ PLLM × PLLN ÷ ', d.pName),
        h('div', { class: 'n' }, `${f(d.fsrc / 1e6, 5)} ÷ ${d.m} × ${d.n} ÷ ${d.p} = `, h('b', {}, mhz(d.sys))),
        d.need48 ? h('div', { class: 'n' }, `48 MHz = VCO ÷ PLLQ = ${f(d.vco / 1e6, 5)} ÷ ${d.q} = `, h('b', {}, mhz(d.f48, 5))) : null,
        h('div', { class: 'n' }, `HCLK = ${f(d.sys / 1e6, 5)} ÷ ${d.ahb} = `, h('b', {}, mhz(d.hclk)), ` → ${d.ws} WS`));
      stage.append(eq);
    }
    for (const [id, p] of Object.entries(pos)) {
      const el = B[id];
      if (!el) continue;
      Object.assign(el.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` });
    }
    // The switch: a trapezoid with the chosen input joined to the output.
    if (B.mux) {
      const p = pos.mux, hse = d.source === 'hse';
      const m = s('svg', { viewBox: `0 0 ${p.w} ${p.h}`, preserveAspectRatio: 'none' });
      if (!narrow) {
        m.append(s('path', { d: `M1,1L${p.w - 1},${p.h * 0.22}V${p.h * 0.78}L1,${p.h - 1}Z`, fill: 'var(--surface)', stroke: 'var(--tool-sig)', 'stroke-width': 1.5 }));
        const yin = hse ? p.h * 0.7 : p.h * 0.3;
        m.append(s('path', { d: `M4,${yin}L${p.w - 4},${p.h / 2}`, stroke: 'var(--tool-sig)', 'stroke-width': 2, fill: 'none' }));
        m.append(s('circle', { cx: 4, cy: p.h * 0.3, r: 2, fill: hse ? 'var(--tool-idle)' : 'var(--tool-sig)' }));
        m.append(s('circle', { cx: 4, cy: p.h * 0.7, r: 2, fill: hse ? 'var(--tool-sig)' : 'var(--tool-idle)' }));
      } else {
        m.append(s('rect', { x: 1, y: 1, width: p.w - 2, height: p.h - 2, rx: 4, fill: 'var(--surface)', stroke: 'var(--tool-sig)', 'stroke-width': 1.5 }));
        const t = s('text', { x: p.w / 2, y: p.h / 2 + 4, 'text-anchor': 'middle', style: 'font:600 10px IBM Plex Mono,monospace;fill:var(--ink)' }, hse ? 'HSE' : 'HSI');
        m.append(t);
      }
      B.mux.replaceChildren(m);
    }
    // Wires.
    wires.setAttribute('width', W); wires.setAttribute('height', H);
    wires.setAttribute('viewBox', `0 0 ${W} ${H}`);
    wires.replaceChildren();
    const defs = s('defs');
    for (const [id, col] of [['a', 'var(--tool-sig)'], ['i', 'var(--tool-idle)'], ['u', 'var(--tool-usb)'], ['x', 'var(--danger)']]) {
      const mk = s('marker', { id: `ckt-ar-${id}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      mk.append(s('path', { d: 'M0,0L8,4L0,8z', fill: col }));
      defs.append(mk);
    }
    wires.append(defs);
    const hse = d.source === 'hse';
    for (const [a, bId, branch] of EDGES[kind]) {
      const pa = pos[a], pb = pos[bId];
      if (!pa || !pb) continue;
      let active = true, col = 'a';
      if (branch === 'hsi') active = !hse;
      if (branch === 'hse') active = hse;
      if (branch === 'usb') { col = 'u'; active = kind === 'rp' ? !!d.usb : d.need48; }
      const bad = B[bId]?.classList.contains('bad') && B[bId]?.classList.contains('sink');
      if (bad) col = 'x';
      if (!active) col = 'i';
      const stroke = { a: 'var(--tool-sig)', i: 'var(--tool-idle)', u: 'var(--tool-usb)', x: 'var(--danger)' }[col];
      let dPath;
      if (!narrow) {
        const x1 = pa.x + pa.w, y1 = pa.y + pa.h / 2;
        const x2 = pb.x, y2 = bId === 'mux' ? pb.y + pb.h * (branch === 'hsi' ? 0.3 : 0.7) : pb.y + pb.h / 2;
        const xm = y1 === y2 ? null : Math.max(x1 + 8, x2 - 14);
        dPath = xm == null ? `M${x1},${y1}H${x2 - 1}` : `M${x1},${y1}H${xm}V${y2}H${x2 - 1}`;
      } else {
        const x1 = pa.x + 10, y1 = pa.y + pa.h;
        const x2 = pb.x, y2 = pb.y + Math.min(pb.h / 2, 16);
        dPath = x2 > x1 + 2 ? `M${x1},${y1}V${y2}H${x2 - 1}` : `M${x1},${y1}V${pb.y - 1}`;
        if (bId === 'mux') dPath = `M${pa.x + 10},${pa.y + pa.h}V${pb.y + pb.h / 2}H${pb.x - 1}`;
      }
      wires.append(s('path', { d: dPath, fill: 'none', stroke, 'stroke-width': active ? 2 : 1.4, 'stroke-dasharray': active ? null : '4 3', 'marker-end': `url(#ckt-ar-${col})` }));
    }
  }

  // ---------- the SYSCLK ruler ----------
  let rulerMax = null, dragging = false;
  function drawRuler(d) {
    const had = rulerSvg.contains(document.activeElement);
    rulerSvg.replaceChildren();
    try { drawRulerInner(d); } finally { if (had) rulerSvg.querySelector('.hdl')?.focus({ preventScroll: true }); }
  }
  function drawRulerInner(d) {
    const W = Math.max(300, rulerCard.clientWidth || 900);
    const H = 92;
    rulerSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    rulerSvg.setAttribute('height', H);
    if (!d) { rulerSub.textContent = ''; return; }
    const L = 16, R = 16, yA = 44;
    const top = rulerMax || Math.ceil((d.limits.sys * 1.12) / 10e6) * 10e6;
    const X = (hz) => L + (Math.max(0, Math.min(top, hz)) / top) * (W - L - R);
    const hclkPerSys = d.kind === 'rp' ? 1 : d.hclk / d.sys;
    // Wait-state bands: by HCLK, drawn on SYSCLK through the AHB divider.
    if (d.limits.ws) {
      let lo = 0;
      d.limits.ws.forEach((edge, i) => {
        const a = lo / hclkPerSys, b = Math.min(edge / hclkPerSys, top);
        if (a < top) {
          rulerSvg.append(s('rect', { x: X(a), y: yA - 22, width: Math.max(0, X(b) - X(a)), height: 30, fill: i % 2 ? 'var(--tool-ws1)' : 'var(--tool-ws0)', stroke: 'var(--line-soft)' }));
          if (X(b) - X(a) > 34) rulerSvg.append(s('text', { x: (X(a) + X(b)) / 2, y: yA - 9, 'text-anchor': 'middle' }, `${i} WS`));
        }
        lo = edge;
      });
    }
    // Over the chip's maximum.
    const xmax = X(d.limits.sys);
    rulerSvg.append(s('rect', { x: xmax, y: yA - 22, width: Math.max(0, W - R - xmax), height: 30, fill: d.kind === 'rp' ? 'var(--warn)' : 'var(--danger)', 'fill-opacity': 0.14 }));
    rulerSvg.append(s('line', { x1: xmax, x2: xmax, y1: yA - 26, y2: yA + 12, stroke: d.kind === 'rp' ? 'var(--warn)' : 'var(--danger)', 'stroke-width': 1.5 }));
    rulerSvg.append(s('text', { x: xmax + 4, y: yA - 27 + 10, style: `fill:${d.kind === 'rp' ? 'var(--warn)' : 'var(--danger)'}` }, d.kind === 'rp' ? 'overclock' : `max ${f(d.limits.sys / 1e6, 4)}`));
    // Axis.
    rulerSvg.append(s('line', { x1: L, x2: W - R, y1: yA + 8, y2: yA + 8, stroke: 'var(--ink-soft)' }));
    const step = top > 150e6 ? 20e6 : 10e6;
    for (let v = 0; v <= top + 1; v += step) {
      rulerSvg.append(s('line', { x1: X(v), x2: X(v), y1: yA + 8, y2: yA + 12, stroke: 'var(--ink-soft)' }));
      if (W > 560 || (v / step) % 2 === 0) rulerSvg.append(s('text', { x: X(v), y: yA + 23, 'text-anchor': 'middle' }, String(v / 1e6)));
    }
    rulerSvg.append(s('text', { x: W - R, y: yA + 36, 'text-anchor': 'end' }, 'MHz'));
    // Actual SYSCLK.
    const sys = d.kind === 'rp' ? d.sys.out : d.sys;
    rulerSvg.append(s('path', { d: `M${X(sys)},${yA + 8}l-5,-8h10z`, fill: 'var(--tool-sig)' }));
    const exact = Math.abs(sys - d.target) / d.target < 1e-6;
    // Target handle.
    const xt = X(d.target);
    const col = exact ? 'var(--tool-sig)' : 'var(--warn)';
    const g = s('g', { class: 'hdl', tabindex: 0, role: 'slider', 'aria-label': 'Wanted system clock', 'aria-valuemin': 1, 'aria-valuemax': Math.round(top / 1e6),
      'aria-valuenow': f(d.target / 1e6, 5), 'aria-valuetext': `${mhz(d.target)}${exact ? '' : `, nearest ${mhz(sys)}`}` });
    const lab = `${f(d.target / 1e6, 5)} MHz`;
    const lw = lab.length * 6.6 + 14;
    const lx = Math.max(L, Math.min(W - R - lw, xt - lw / 2));
    g.append(s('line', { x1: xt, x2: xt, y1: yA - 22, y2: yA + 8, stroke: col, 'stroke-width': 2.5 }));
    g.append(s('rect', { class: 'ring', x: lx, y: 2, width: lw, height: 17, rx: 8.5, fill: col, stroke: col }));
    g.append(s('text', { x: lx + lw / 2, y: 14.5, 'text-anchor': 'middle', style: 'fill:var(--accent-ink);font-weight:600' }, lab));
    g.append(s('rect', { x: xt - 9, y: 0, width: 18, height: yA + 10, fill: 'transparent' }));
    const surf = s('rect', { class: 'surf', x: L, y: yA - 22, width: W - L - R, height: 42, fill: 'transparent' });
    rulerSvg.append(surf, g);
    const toHz = (ev) => { const r = rulerSvg.getBoundingClientRect(); return (((ev.clientX - r.left) * (W / r.width) - L) / (W - L - R)) * top; };
    const setT = (hz) => {
      const snap = top > 150e6 ? 1e6 : 0.5e6;
      const v = Math.max(snap, Math.round(hz / snap) * snap);
      const t = String(Number((v / 1e6).toPrecision(6)));
      if (t !== String(ctx.raw.target)) ctx.set('target', t);
    };
    const start = (e) => {
      e.preventDefault();
      g.focus({ preventScroll: true });
      rulerMax = top; dragging = true;
      const move = (ev) => setT(toHz(ev));
      move(e);
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        rulerMax = null; dragging = false; drawRuler(res && res.drawing); rulerSvg.querySelector('.hdl')?.focus({ preventScroll: true });
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    };
    g.addEventListener('pointerdown', start);
    surf.addEventListener('pointerdown', start);
    g.addEventListener('keydown', (e) => {
      const st = e.shiftKey ? 10 : 1;
      let v = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = d.target / 1e6 + st;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = d.target / 1e6 - st;
      if (e.key === 'End') v = d.limits.sys / 1e6;
      if (v == null) return;
      e.preventDefault();
      ctx.set('target', String(Math.max(1, Math.round(v * 10) / 10)));
    });
    rulerSub.replaceChildren('PLL gives ', h('b', { style: exact ? null : 'color:var(--warn)' }, mhz(sys)), exact ? ' exactly' : ' (nearest)',
      ...(d.kind === 'rp' ? [] : [' · HCLK ', h('b', {}, mhz(d.hclk)), ' → ', h('b', {}, `${d.ws} wait state${d.ws === 1 ? '' : 's'}`)]));
  }

  // ---------- below ----------
  function drawBelow(d) {
    warns.replaceChildren(...((res && res.warnings) || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'Limits and how the search chooses'), ...((res && res.notes) || []).map((t) => h('div', {}, t)));
    altBody.replaceChildren();
    if (!d) { altCard.style.display = 'none'; return; }
    altCard.style.display = '';
    let head, rows;
    if (d.kind === 'rp') {
      head = ['REFDIV', 'FBDIV', 'VCO', 'POSTDIV1', 'POSTDIV2', 'clk_sys'];
      rows = [[d.sys.r, d.sys.fb, mhz(d.sys.vco), d.sys.p1, d.sys.p2, mhz(d.sys.out)], ...d.alternatives.map((x) => [x.r, x.fb, mhz(x.vco), x.p1, x.p2, mhz(x.out)])];
    } else {
      head = ['PLLM', 'PLLN', d.pName, ...(d.need48 ? ['PLLQ → 48'] : []), 'VCO', 'SYSCLK'];
      rows = [[d.m, d.n, d.p, ...(d.need48 ? [`${d.q} → ${mhz(d.f48, 5)}`] : []), mhz(d.vco), mhz(d.sys)],
        ...d.alternatives.map((x) => [x.m, x.n, x.p, ...(d.need48 ? [`${x.q} → ${mhz(x.f48, 5)}`] : []), mhz(x.vco), mhz(x.sys)])];
    }
    altBody.append(h('table', {}, h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, c)))),
      h('tbody', {}, rows.map((r, i) => h('tr', { class: i === 0 ? 'cur' : null, title: i === 0 ? 'The setting in use' : null }, r.map((c) => h('td', {}, String(c))))))));
  }

  function drawChips() {
    const cur = ctx.raw.family || 'f407';
    chips.replaceChildren(...FAM.map(([v, name, mx]) => h('button', { class: 'ckt-chip', 'aria-pressed': String(cur === v), title: `${name}, up to ${mx} MHz`,
      onclick: () => ctx.set('family', v) }, name, h('span', {}, ` ${mx}`))));
  }

  function syncInputs() {
    const raw = ctx.raw;
    if (document.activeElement !== xtalIn) xtalIn.value = raw.xtal ?? '';
    if (document.activeElement !== targetIn) targetIn.value = raw.target ?? '';
    const bad = (k) => { const t = String(raw[k] ?? '').trim(); return t !== '' && ctx.parseEng(t) == null; };
    xtalIn.classList.toggle('bad', bad('xtal'));
    targetIn.classList.toggle('bad', bad('target'));
  }

  function draw() {
    drawChips();
    const d = res && res.drawing;
    if (!d) {
      for (const el of stage.querySelectorAll('.ckt-b, .ckt-mux')) el.remove();
      built = null;
      stage.style.height = '120px';
      wires.replaceChildren();
      if (!stage.querySelector('.ckt-empty')) stage.append(h('div', { class: 'ckt-empty', style: 'padding:40px 16px;color:var(--ink-soft)' }, 'No PLL setting to draw: see the message below.',
        h('div', { style: 'margin-top:8px' }, 'Crystal ', xtalIn, ' MHz')));
      treeSub.textContent = '';
      drawRuler(null); drawBelow(null);
      return;
    }
    stage.querySelector('.ckt-empty')?.remove();
    const kind = d.kind === 'rp' ? 'rp' : 'stm';
    const hadFocus = document.activeElement === xtalIn;
    if (built !== kind) build(kind);
    fill(d);
    place(d);
    if (hadFocus && document.activeElement !== xtalIn) xtalIn.focus({ preventScroll: true });
    treeHelp.textContent = kind === 'rp'
      ? 'Step or type the crystal (or drag its symbol sideways). PLL_SYS makes clk_sys, PLL_USB the 48 MHz for USB and the ADC; the dividers are chosen by the planner, lowest VCO first.'
      : 'Click the source switch (or the HSI block) to change between crystal and internal RC; step or type the crystal (or drag its symbol sideways); step the AHB prescaler; switch the 48 MHz branch. The PLL dividers and APB prescalers are chosen by the planner.';
    rulerHelpTail.textContent = kind === 'rp' ? ' Past 133 MHz the RP2040 is overclocked.' : ' Shading = flash wait states the core needs at that HCLK.';
    treeSub.replaceChildren(...(kind === 'rp' ? ['XOSC ', h('b', {}, mhz(d.fsrc)), ' → clk_sys ', h('b', {}, mhz(d.sys.out))] : [d.source === 'hse' ? 'HSE' : 'HSI', ' ', h('b', {}, mhz(d.fsrc)), ' → SYSCLK ', h('b', {}, mhz(d.sys))]));
    drawRuler(d);
    drawBelow(d);
  }

  ctx.onResult((r) => { res = r; syncInputs(); draw(); });
  let lastW = 0;
  new ResizeObserver(() => {
    const w = stage.clientWidth;
    if (w !== lastW) { lastW = w; if (res && res.drawing) { place(res.drawing); drawRuler(res.drawing); } }
  }).observe(stage);
}
