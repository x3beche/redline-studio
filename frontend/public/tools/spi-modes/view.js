// SPI Mode Reference: the page is the bus on a logic analyser.
//   Mode square - CPOL down the side, CPHA across the top: the four modes as
//                 four squares, each with its clock and sample edge drawn.
//                 Click one (arrow keys move); "Compare all" stacks the four.
//   Analyser    - CS, SCK, MOSI and MISO for one byte, big. Grab the idle
//                 clock and pull it high or low (CPOL); drag a sample marker to
//                 the other clock edge (CPHA). Click a bit to flip it; the
//                 bytes, bit order and the part filter sit on the capture.
//   Parts       - every listed part with the four modes it accepts as four
//                 little squares; the ones that work in the chosen mode are lit.
//                 Click a part to switch to a mode it accepts.
//   Settings    - the chosen mode spelled for each SDK and register.
// Everything drawn comes from run()'s result: drawing, parts and tables.

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
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
const hx = (v) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;

const CSS = `
.spi { --tool-sck: var(--tool-s0); --tool-mosi: var(--tool-s1); --tool-miso: var(--tool-s2); --tool-cs: #5b6b7a; --tool-trace-bg: #f7f9fb; }
:root[data-theme="dark"] .spi { --tool-cs: #8ea0b0; --tool-trace-bg: #0c1217; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .spi { --tool-cs: #8ea0b0; --tool-trace-bg: #0c1217; } }
.spi { display: grid; grid-template-columns: 318px minmax(0, 1fr); gap: 12px; align-items: start; }
@media (max-width: 900px) { .spi { grid-template-columns: minmax(0, 1fr); } .spi .spi-col { display: contents; }
  .spi-sqc { order: 1; } .spi-warns { order: 2; } .spi-capc { order: 3; } .spi-partc { order: 4; } .spi-setc { order: 5; } .spi .k-outwrap { order: 6; } .spi-notes { order: 7; }
  .spi-parts { max-height: 260px; } }
.spi-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.spi-card { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.spi-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.spi-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; }
.spi-sub { font-size: 11.5px; color: var(--ink-soft); }
.spi-sub b { font: 500 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.spi-grow { flex: 1; }
.spi input { padding: 2px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken); color: var(--ink); font: 12px "IBM Plex Mono", ui-monospace, monospace; min-width: 0; }
.spi input.bad { border-color: var(--danger); }
.spi-f { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--ink-soft); white-space: nowrap; }
.spi-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.spi-seg button { border: 0; background: var(--surface); color: var(--ink-soft); padding: 2px 8px; font-size: 11.5px; cursor: pointer; }
.spi-seg button + button { border-left: 1px solid var(--line); }
.spi-seg button[aria-pressed="true"] { background: var(--sunken); color: var(--ink); font-weight: 600; }
/* mode square */
.spi-sq { display: grid; grid-template-columns: 26px 1fr 1fr; grid-template-rows: 22px 1fr 1fr; gap: 6px; padding: 10px; }
.spi-ax { font: 11px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); display: flex; align-items: center; justify-content: center; }
.spi-ax.v { writing-mode: vertical-rl; transform: rotate(180deg); }
.spi-q { position: relative; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); padding: 6px 7px 5px; cursor: pointer; text-align: left;
  display: flex; flex-direction: column; gap: 2px; color: var(--ink); min-width: 0; }
.spi-q:hover { border-color: var(--ink-soft); }
.spi-q[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; background: color-mix(in srgb, var(--accent) 6%, var(--surface)); }
.spi-q .n { font: 600 22px "IBM Plex Mono", ui-monospace, monospace; line-height: 1; }
.spi-q .n small { font-size: 11px; font-weight: 400; color: var(--ink-soft); margin-left: 4px; }
.spi-q .e { font-size: 11px; color: var(--ink-soft); }
.spi-q .c { position: absolute; top: 6px; right: 7px; font: 10.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.spi-q svg { display: block; width: 100%; height: 30px; }
.spi-all { margin: 0 10px 10px; width: calc(100% - 20px); }
.spi-all[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
/* parts */
.spi-find { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--line-soft); }
.spi-find input { flex: 1; }
.spi-parts { list-style: none; margin: 0; padding: 4px 0; max-height: 360px; overflow-y: auto; }
.spi-parts li button { width: 100%; display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 8px; align-items: center; padding: 3px 10px; border: 0;
  background: transparent; color: var(--ink); text-align: left; cursor: pointer; font-size: 12px; }
.spi-parts li button:hover { background: var(--sunken); }
.spi-parts li button.off { color: var(--ink-soft); }
.spi-parts li button.off .pm i.y { opacity: .55; }
.spi-parts .pm { display: grid; grid-template-columns: repeat(4, 11px); gap: 2px; }
.spi-parts .pm i { display: block; height: 11px; border-radius: 2px; background: var(--sunken); border: 1px solid var(--line); font: 8px/10px "IBM Plex Mono", monospace; text-align: center; font-style: normal; color: transparent; }
.spi-parts .pm i.y { background: var(--ok); border-color: var(--ok); color: var(--surface); }
.spi-parts .pm i.sel { outline: 1.5px solid var(--accent); outline-offset: 1px; }
.spi-parts .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spi-parts .nt { grid-column: 2; font-size: 11px; color: var(--ink-soft); white-space: normal; }
.spi-none { padding: 8px 10px; font-size: 12px; color: var(--ink-soft); }
/* analyser */
.spi-mode { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 16px; padding: 10px 12px 0; }
.spi-mode .big { font: 600 26px "IBM Plex Mono", ui-monospace, monospace; letter-spacing: -0.5px; }
.spi-mode .kv { font: 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.spi-mode .kv b { color: var(--ink); font-weight: 600; }
.spi-svg { display: block; width: 100%; user-select: none; -webkit-user-select: none; touch-action: none; }
.spi-svg text { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
.spi-svg text.soft { fill: var(--ink-soft); }
.spi-svg text.sm { font-size: 10px; }
.spi-svg text.b { font-weight: 600; }
.spi-svg .hd { cursor: pointer; }
.spi-svg .hd:focus { outline: none; }
.spi-svg .hd:focus-visible .ring { stroke: var(--accent); stroke-width: 2.5; stroke-dasharray: 3 2; }
.spi-svg .ns { cursor: ns-resize; } .spi-svg .ew { cursor: ew-resize; }
.spi-help { padding: 2px 12px 9px; font-size: 11px; color: var(--ink-soft); }
.spi-help kbd { font: 10px "IBM Plex Mono", ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px; padding: 0 3px; }
/* settings */
.spi-set { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr)); gap: 0 14px; padding: 4px 10px 8px; }
.spi-set div { display: grid; grid-template-columns: 124px minmax(0, 1fr); gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--line-soft); font-size: 11.5px; align-items: baseline; }
.spi-set span { color: var(--ink-soft); }
.spi-set code { font: 11.5px "IBM Plex Mono", ui-monospace, monospace; word-break: break-word; }
.spi-set code.inv { color: var(--warn); }
@media (max-width: 520px) { .spi-set div { grid-template-columns: minmax(0, 1fr); gap: 0; } }
.spi-warns { border: 1px solid var(--warn); border-left-width: 3px; border-radius: 6px; padding: 6px 10px; background: var(--surface); font-size: 12px; }
.spi-warns:empty { display: none; }
.spi-warns div + div { margin-top: 3px; }
.spi-notes { font-size: 11.5px; color: var(--ink-soft); }
.spi-notes summary { cursor: pointer; }
.spi-notes div { margin-top: 3px; }
.spi .k-out { max-height: 220px; }
`;

// The small clock glyph of a mode: idle level, 3 pulses, dots on sample edges.
function glyph(n) {
  const cpol = n >> 1, cpha = n & 1;
  const svg = s('svg', { viewBox: '0 0 100 30', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const yi = cpol ? 6 : 24, ya = cpol ? 24 : 6;
  let d = `M0,${yi}H14`;
  const dots = [];
  for (let i = 0; i < 3; i++) {
    const a = 14 + i * 26, b = a + 13;
    d += `V${ya}H${b}V${yi}H${a + 26}`;
    dots.push(cpha ? b : a);
  }
  d += 'H100';
  svg.append(s('path', { d, fill: 'none', stroke: 'var(--tool-sck)', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
  for (const x of dots) svg.append(s('line', { x1: x, x2: x, y1: 2, y2: 28, stroke: 'var(--accent)', 'stroke-dasharray': '2 2', 'vector-effect': 'non-scaling-stroke' }));
  return svg;
}

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  const wrap = h('div', { class: 'spi' });
  root.append(wrap);
  let res = null;

  // ---------- mode square ----------
  const quads = [];
  const sqBox = h('div', { class: 'spi-sq', role: 'group', 'aria-label': 'SPI mode: CPOL by row, CPHA by column' },
    h('span', {}), h('span', { class: 'spi-ax' }, 'CPHA 0'), h('span', { class: 'spi-ax' }, 'CPHA 1'));
  for (const cpol of [0, 1]) {
    sqBox.append(h('span', { class: 'spi-ax v' }, `CPOL ${cpol}`));
    for (const cpha of [0, 1]) {
      const n = cpol * 2 + cpha;
      const cnt = h('span', { class: 'c' });
      const q = h('button', { class: 'spi-q', type: 'button', 'data-n': n, 'aria-label': `Mode ${n}: CPOL ${cpol}, CPHA ${cpha}`,
        onclick: () => ctx.set('mode', String(n)),
        onkeydown: (e) => {
          const mv = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] }[e.key];
          if (!mv) return;
          e.preventDefault();
          const r = Math.min(1, Math.max(0, cpol + mv[0])), c = Math.min(1, Math.max(0, cpha + mv[1]));
          ctx.set('mode', String(r * 2 + c));
          quads[r * 2 + c].el.focus();
        } },
      h('span', { class: 'n' }, String(n), h('small', {}, `${cpol}·${cpha}`)), cnt, glyph(n),
      h('span', { class: 'e' }, `idle ${cpol ? 'high' : 'low'} · sample ${(cpol ^ cpha) ? 'falling' : 'rising'}`));
      quads[n] = { el: q, cnt };
      sqBox.append(q);
    }
  }
  const allBtn = h('button', { class: 'k-btn spi-all', type: 'button', onclick: () => ctx.set('mode', ctx.raw.mode === 'all' ? '0' : 'all') }, 'Compare all four');
  const sqCard = h('section', { class: 'spi-card spi-sqc' }, h('div', { class: 'spi-head' }, h('h2', {}, 'Mode'), h('span', { class: 'spi-sub' }, 'mode = 2·CPOL + CPHA')), sqBox, allBtn);

  // ---------- parts ----------
  const find = h('input', { type: 'search', spellcheck: 'false', placeholder: 'find a part: ADXL345, flash, display', 'aria-label': 'Find a part',
    oninput: (e) => ctx.set('device', e.target.value) });
  const partList = h('ul', { class: 'spi-parts' });
  const partsSub = h('span', { class: 'spi-sub' });
  const partsCard = h('section', { class: 'spi-card spi-partc' }, h('div', { class: 'spi-head' }, h('h2', {}, 'Parts'), partsSub), h('div', { class: 'spi-find' }, find), partList);

  // ---------- analyser ----------
  const modeLine = h('div', { class: 'spi-mode', 'aria-live': 'polite' });
  const cap = s('svg', { class: 'spi-svg', role: 'group', 'aria-label': 'Logic analyser capture of one SPI byte' });
  const byteField = (key, label) => {
    const el = h('input', { type: 'text', spellcheck: 'false', style: 'width:62px', 'aria-label': `${label} byte`, oninput: (e) => ctx.set(key, e.target.value) });
    return [el, h('label', { class: 'spi-f' }, label, el)];
  };
  const [mosiIn, mosiLab] = byteField('mosi', 'MOSI');
  const [misoIn, misoLab] = byteField('miso', 'MISO');
  const orderBtns = [['msb', 'MSB first'], ['lsb', 'LSB first']].map(([v, t]) => h('button', { type: 'button', 'data-v': v, onclick: () => ctx.set('order', v) }, t));
  const capCard = h('section', { class: 'spi-card spi-capc' },
    h('div', { class: 'spi-head' }, h('h2', {}, 'Capture: one byte'), h('span', { class: 'spi-grow' }), mosiLab, misoLab, h('span', { class: 'spi-seg', role: 'group', 'aria-label': 'Bit order' }, orderBtns)),
    modeLine, cap,
    h('div', { class: 'spi-help spi-help1' }, 'Pull the idle clock (grey band, left of CS) up or down to change CPOL; drag a blue sample marker to the other clock edge to change CPHA; click a bit to flip it. ',
      'Focused: ', h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' on SCK, ', h('kbd', {}, '←'), h('kbd', {}, '→'), ' on a marker, ', h('kbd', {}, 'Enter'), ' on a bit.'));

  // ---------- settings ----------
  const setBody = h('div', { class: 'spi-set' });
  const setSub = h('span', { class: 'spi-sub' });
  const setCard = h('section', { class: 'spi-card spi-setc' }, h('div', { class: 'spi-head' }, h('h2', {}, 'How to set it'), setSub), setBody);
  const warns = h('div', { class: 'spi-warns', role: 'status' });
  const notes = h('details', { class: 'spi-notes' });

  wrap.append(h('div', { class: 'spi-col' }, sqCard, partsCard),
    h('div', { class: 'spi-col' }, warns, capCard, setCard, ctx.outputs, notes));

  const onDrag = (move, done) => {
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      done && done();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const setMode = (cpol, cpha) => ctx.set('mode', String(cpol * 2 + cpha));

  // ---------- the capture ----------
  function drawCap() {
    const id = cap.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    cap.replaceChildren();
    drawCapInner();
    if (id) cap.querySelector(`[data-id="${id}"]`)?.focus({ preventScroll: true });
  }
  function drawCapInner() {
    const d = res && res.drawing;
    const W = Math.max(300, cap.clientWidth || capCard.clientWidth || 800);
    if (!d || !d.modes?.length) return;
    const narrow = W < 560;
    const all = d.modes.length > 1;
    const L = narrow ? 44 : 64, R = 10;
    const P = (W - L - R - (narrow ? 26 : 44)) / 8.6;     // one clock period
    const x0 = L + (narrow ? 14 : 26);                     // CS falls
    const xEnd = x0 + 8 * P + P / 2;                       // CS rises
    const sampleX = (m, i) => x0 + P / 2 + i * P + (m.cpha ? P / 2 : 0);
    const shiftX = (m, i) => x0 + P / 2 + i * P + (m.cpha ? 0 : P / 2);
    const rowH = all ? 26 : narrow ? 34 : 42, gap = all ? 6 : 10;
    // Rows: one CS; per mode one SCK; then MOSI and MISO (drawn for the first mode shown).
    const rows = [['CS', 'cs']];
    d.modes.forEach((m) => rows.push([all ? `SCK ${m.n}` : 'SCK', 'sck', m]));
    if (!all) rows.push(['MOSI', 'mosi', d.modes[0]], ['MISO', 'miso', d.modes[0]]);
    const top = 22;
    const H = top + rows.length * (rowH + gap) + 30;
    cap.setAttribute('viewBox', `0 0 ${W} ${H}`);
    cap.setAttribute('height', H);
    cap.append(s('rect', { x: L - 4, y: top - 16, width: W - L - R + 4, height: H - top - 4, rx: 4, fill: 'var(--tool-trace-bg)', stroke: 'var(--line-soft)' }));
    const yOf = (r) => top + r * (rowH + gap);
    const hi = (r) => yOf(r) + 4, lo = (r) => yOf(r) + rowH - 4;
    // Bit number header.
    for (let i = 0; i < 8; i++) {
      const m = d.modes[0];
      const a = m.cpha && !all ? x0 + P / 2 + i * P : x0 + i * P;
      const pos = d.lsb ? i : 7 - i;
      cap.append(s('text', { x: a + P / 2, y: top - 4, 'text-anchor': 'middle', class: 'soft sm' }, all ? String(i + 1) : `b${pos}`));
    }
    const path = (pts, color, width = 2) => s('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(''), fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linejoin': 'round' });
    rows.forEach(([name, kind, m], r) => {
      const col = kind === 'cs' ? 'var(--tool-cs)' : kind === 'sck' ? 'var(--tool-sck)' : kind === 'mosi' ? 'var(--tool-mosi)' : 'var(--tool-miso)';
      cap.append(s('text', { x: 4, y: yOf(r) + rowH / 2 + 4, class: 'b', style: `fill:${col}` }, name));
      if (kind === 'cs') {
        cap.append(path([[L, hi(r)], [x0, hi(r)], [x0, lo(r)], [xEnd, lo(r)], [xEnd, hi(r)], [W - R, hi(r)]], col));
        if (!narrow) cap.append(s('text', { x: x0 + 4, y: hi(r) + 8, class: 'soft sm' }, 'CS low: transfer'));
        return;
      }
      if (kind === 'sck') {
        const idle = m.cpol ? hi(r) : lo(r), act = m.cpol ? lo(r) : hi(r);
        const pts = [[L, idle]];
        for (let i = 0; i < 8; i++) { const a = x0 + P / 2 + i * P, b = a + P / 2; pts.push([a, idle], [a, act], [b, act], [b, idle]); }
        pts.push([W - R, idle]);
        // Edge arrows: sample edges solid, shift edges hollow.
        for (let i = 0; i < 8; i++) {
          const xs = sampleX(m, i), xh = shiftX(m, i);
          const upS = (m.cpol ^ m.cpha) === 0;   // sample on rising edge
          const ym = (hi(r) + lo(r)) / 2;
          cap.append(s('path', { d: upS ? `M${xs - 4},${ym + 3}l4,-6l4,6z` : `M${xs - 4},${ym - 3}l4,6l4,-6z`, fill: 'var(--accent)' }));
          if (!all && !narrow) cap.append(s('path', { d: upS ? `M${xh - 3.5},${ym - 2.5}l3.5,5l3.5,-5z` : `M${xh - 3.5},${ym + 2.5}l3.5,-5l3.5,5z`, fill: 'none', stroke: 'var(--ink-soft)' }));
        }
        cap.append(path(pts, col));
        if (all) {
          // Click a row to pick that mode.
          const hit = s('rect', { class: 'hd', x: 0, y: yOf(r) - 2, width: W, height: rowH + 4, fill: 'transparent', tabindex: 0, 'data-id': `row${m.n}`, role: 'button', 'aria-label': `Use mode ${m.n}` });
          hit.addEventListener('click', () => ctx.set('mode', String(m.n)));
          hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.set('mode', String(m.n)); } });
          cap.append(hit);
          const sl = `sample ${m.sample}`;
          cap.append(s('rect', { x: W - R - 8 - sl.length * 6.1, y: yOf(r) + rowH / 2 - 7, width: sl.length * 6.1 + 6, height: 14, fill: 'var(--tool-trace-bg)' }));
          cap.append(s('text', { x: W - R - 4, y: yOf(r) + rowH / 2 + 4, 'text-anchor': 'end', class: 'soft sm' }, sl));
          return;
        }
        // The idle clock: a grip before CS falls (and after it rises). Pull it up or down.
        const grip = s('g', { class: 'hd ns', tabindex: 0, 'data-id': 'cpol', role: 'switch', 'aria-checked': String(!!m.cpol), 'aria-label': `Clock idle level: ${m.cpol ? 'high' : 'low'} (CPOL ${m.cpol}). Up or down arrow changes it.` });
        grip.append(s('rect', { class: 'ring', x: L - 2, y: yOf(r) - 2, width: x0 - L - 2, height: rowH + 4, rx: 3, fill: 'var(--ink-soft)', 'fill-opacity': 0.12, stroke: 'var(--line)' }));
        grip.append(s('rect', { x: xEnd + 4, y: yOf(r) - 2, width: W - R - xEnd - 6, height: rowH + 4, rx: 3, fill: 'var(--ink-soft)', 'fill-opacity': 0.12 }));
        grip.append(s('path', { d: `M${(L + x0) / 2 - 4},${yOf(r) + rowH / 2 - (m.cpol ? -5 : 5)}l4,${m.cpol ? 5 : -5}l4,${m.cpol ? -5 : 5}`, fill: 'none', stroke: 'var(--ink-soft)', 'stroke-width': 1.5 }));
        if (!narrow) cap.append(s('text', { x: xEnd + 8, y: (m.cpol ? lo(r) : hi(r)) + (m.cpol ? -2 : 9), class: 'soft sm' }, `idle ${m.cpol ? 'high' : 'low'}`));
        grip.append(s('title', {}, `Idle ${m.cpol ? 'high' : 'low'}: CPOL ${m.cpol}. Drag up or down, or click, to change.`));
        cap.append(grip);
        let moved = false;
        grip.addEventListener('pointerdown', (e) => {
          e.preventDefault(); grip.focus({ preventScroll: true });
          const r0 = cap.getBoundingClientRect(), k = W / r0.width;
          const mid = (hi(r) + lo(r)) / 2;
          moved = false;
          onDrag((ev) => {
            const y = (ev.clientY - r0.top) * k;
            const want = y < mid ? 1 : 0;
            if (want !== m.cpol && Math.abs(y - mid) > 3) { moved = true; setMode(want, m.cpha); }
          }, () => { if (!moved) setMode(1 - m.cpol, m.cpha); });
        });
        grip.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowUp' && !m.cpol) { e.preventDefault(); setMode(1, m.cpha); }
          else if (e.key === 'ArrowDown' && m.cpol) { e.preventDefault(); setMode(0, m.cpha); }
          else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMode(1 - m.cpol, m.cpha); }
        });
        return;
      }
      // Data lines: one cell per bit, from its shift point for one period.
      const bits = kind === 'mosi' ? d.mosi : d.miso, val = kind === 'mosi' ? d.mosiVal : d.misoVal;
      const start = m.cpha ? x0 + P / 2 : x0;
      const yh = hi(r), yl = lo(r), ym = (yh + yl) / 2, k = Math.min(6, P / 6);
      cap.append(s('path', { d: `M${L},${ym}H${start}M${start + 8 * P},${ym}H${W - R}`, stroke: 'var(--ink-soft)', 'stroke-dasharray': '2 3', fill: 'none' }));
      for (let i = 0; i < 8; i++) {
        const a = start + i * P, b = a + P;
        const pos = d.lsb ? i : 7 - i;
        const g = s('g', { class: 'hd', tabindex: 0, 'data-id': `${kind}${i}`, role: 'button', 'aria-label': `${kind.toUpperCase()} bit ${pos} = ${bits[i]}: press Enter to flip` });
        g.append(s('path', { class: 'ring', d: `M${a},${ym}L${a + k},${yh}L${b - k},${yh}L${b},${ym}L${b - k},${yl}L${a + k},${yl}Z`,
          fill: bits[i] ? col : 'var(--surface)', 'fill-opacity': bits[i] ? 0.28 : 1, stroke: col, 'stroke-width': 1.4 }));
        g.append(s('text', { x: (a + b) / 2, y: ym + 4, 'text-anchor': 'middle', class: 'b', 'pointer-events': 'none' }, String(bits[i])));
        g.append(s('title', {}, `${kind.toUpperCase()} bit ${pos}: click to flip`));
        const flip = () => ctx.set(kind, hx(val ^ (1 << pos)));
        g.addEventListener('click', flip);
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
        cap.append(g);
      }
      if (narrow) cap.append(s('text', { x: 4, y: yOf(r) + rowH / 2 + 16, class: 'sm', style: `fill:${col}` }, kind === 'mosi' ? d.mosiHex : d.misoHex));
      else cap.append(s('text', { x: W - R - 2, y: yOf(r) - 1, 'text-anchor': 'end', class: 'b sm', style: `fill:${col}` }, `${kind === 'mosi' ? d.mosiHex : d.misoHex} · ${d.order}`));
    });

    // Sample markers through SCK and the data (single mode): drag to the other edge.
    if (!all) {
      const m = d.modes[0];
      const y1 = yOf(1) - 3, y2 = lo(rows.length - 1) + 6;
      for (let i = 0; i < 8; i++) {
        const xs = sampleX(m, i);
        const g = s('g', { class: 'hd ew', tabindex: i === 0 ? 0 : -1, 'data-id': `smp${i}`, role: 'switch', 'aria-checked': String(!!m.cpha),
          'aria-label': `Sample edge: ${m.cpha ? 'second (trailing)' : 'first (leading)'} edge, CPHA ${m.cpha}. Left or right arrow moves it.` });
        g.append(s('rect', { x: xs - 7, y: y1, width: 14, height: y2 - y1, fill: 'transparent' }));
        g.append(s('line', { class: 'ring', x1: xs, x2: xs, y1, y2, stroke: 'var(--accent)', 'stroke-dasharray': '4 3', 'stroke-width': 1.4 }));
        g.append(s('circle', { cx: xs, cy: y2 + 4, r: 4, fill: 'var(--accent)' }));
        cap.insertBefore(g, cap.children[1]);
        const toEdge = (x) => {
          // Which half of the clock period the pointer is nearest: leading or trailing edge.
          const ph = ((x - x0 - P / 2) / P) % 1;
          return ((ph + 1) % 1) > 0.25 && ((ph + 1) % 1) < 0.75 ? 1 : 0;
        };
        g.addEventListener('pointerdown', (e) => {
          e.preventDefault(); g.focus({ preventScroll: true });
          const r0 = cap.getBoundingClientRect(), kx = W / r0.width;
          onDrag((ev) => { const want = toEdge((ev.clientX - r0.left) * kx); if (want !== (res.drawing.modes[0].cpha)) setMode(m.cpol, want); });
        });
        g.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowRight' && !m.cpha) { e.preventDefault(); setMode(m.cpol, 1); }
          else if (e.key === 'ArrowLeft' && m.cpha) { e.preventDefault(); setMode(m.cpol, 0); }
        });
      }
      // Where the first bit becomes valid.
      const yb = lo(rows.length - 1) + 22;
      const fx = m.cpha ? x0 + P / 2 : x0;
      cap.append(s('path', { d: `M${x0},${yb}H${fx}`, stroke: 'var(--ink-soft)' }));
      cap.append(s('text', { x: fx + 4, y: yb + 4, class: 'soft sm' }, narrow ? (m.cpha ? 'bit 1 out on edge 1' : 'bit 1 valid at CS fall') : m.cpha ? 'first bit put out on the first clock edge, read on the second' : 'first bit on the line as CS falls, read on the first clock edge'));
    } else {
      cap.append(s('text', { x: L, y: H - 10, class: 'soft sm' }, 'Triangles = sample edges. Click a clock row to use that mode.'));
    }
  }

  // ---------- mode line, square, parts, settings ----------
  function drawSide() {
    const d = res && res.drawing;
    const m = d && d.modes.length === 1 ? d.modes[0] : null;
    const cur = m ? m.n : null;
    const parts = (res && res.parts) || [];
    for (let n = 0; n < 4; n++) {
      quads[n].el.setAttribute('aria-pressed', String(cur === n));
      quads[n].el.tabIndex = (cur ?? 0) === n ? 0 : -1;
      const c = parts.filter((p) => p.modes.includes(n)).length;
      quads[n].cnt.textContent = `${c} part${c === 1 ? '' : 's'}`;
    }
    allBtn.setAttribute('aria-pressed', String(!m));
    capCard.querySelector('.spi-help1').hidden = !m;
    allBtn.textContent = m ? 'Compare all four' : 'Comparing all four: pick one';
    // Mode line over the capture.
    if (m) {
      modeLine.replaceChildren(h('span', { class: 'big' }, `Mode ${m.n}`),
        h('span', { class: 'kv' }, 'CPOL ', h('b', {}, String(m.cpol)), ` idle ${m.cpol ? 'high' : 'low'}`),
        h('span', { class: 'kv' }, 'CPHA ', h('b', {}, String(m.cpha)), ` sample on ${m.cpha ? '2nd' : '1st'} edge`),
        h('span', { class: 'kv' }, 'sample ', h('b', {}, m.sample), ' · shift ', h('b', {}, m.sample === 'rising' ? 'falling' : 'rising')));
    } else modeLine.replaceChildren(h('span', { class: 'big' }, 'All four modes'), h('span', { class: 'kv' }, 'same byte, four clocks'));
    // Parts.
    const q = String(ctx.raw.device || '').trim();
    const fits = parts.filter((p) => cur == null || p.modes.includes(cur)).length;
    partsSub.replaceChildren(q ? `${parts.length} match "${q}"` : `${parts.length} listed`, cur != null ? h('span', {}, ' · ', h('b', {}, String(fits)), ` accept mode ${cur}`) : '');
    const had = partList.contains(document.activeElement) ? document.activeElement.dataset.name : null;
    const sorted = cur == null ? parts : [...parts].sort((a, b) => (b.modes.includes(cur) ? 1 : 0) - (a.modes.includes(cur) ? 1 : 0));
    partList.replaceChildren(...sorted.map((p) => {
      const ok = cur == null || p.modes.includes(cur);
      const btn = h('button', { type: 'button', class: ok ? null : 'off', 'data-name': p.name,
        title: `${p.name}: modes ${p.modes.join(', ')}${p.note ? ` - ${p.note}` : ''}`,
        onclick: () => { if (!p.modes.includes(cur)) ctx.set('mode', String(p.modes[0])); } },
      h('span', { class: 'pm', 'aria-label': `modes ${p.modes.join(', ')}` }, [0, 1, 2, 3].map((n) => h('i', { class: `${p.modes.includes(n) ? 'y' : ''}${n === cur ? ' sel' : ''}` }, String(n)))),
      h('span', { class: 'nm' }, p.name),
      p.note && (q || parts.length <= 6) ? h('span', { class: 'nt' }, p.note) : null);
      return h('li', {}, btn);
    }));
    if (!parts.length) partList.replaceChildren(h('li', { class: 'spi-none' }, 'No listed part matches. Read the part\'s timing diagram: SCK level while CS is high = CPOL; the edge where it reads MOSI = the sample edge.'));
    if (had) partList.querySelector(`[data-name="${window.CSS.escape(had)}"]`)?.focus({ preventScroll: true });
    // Settings.
    const tbl = (res?.tables || []).find((t) => /in each ecosystem/.test(t.title));
    setSub.textContent = tbl ? `mode ${cur} in each SDK and register` : 'pick a mode';
    setBody.replaceChildren(...(tbl ? tbl.rows.map(([k, v]) => h('div', {}, h('span', {}, k), h('code', { class: /inverted/.test(v) ? 'inv' : null }, v)))
      : [h('div', {}, h('span', {}, 'All four shown'), h('code', {}, 'choose a mode in the square to see how to set it'))]));
    // Fields.
    for (const [el, key] of [[mosiIn, 'mosi'], [misoIn, 'miso'], [find, 'device']]) {
      if (document.activeElement !== el) el.value = ctx.raw[key] ?? '';
    }
    mosiIn.classList.toggle('bad', (res?.warnings || []).some((w) => w.startsWith('MOSI')));
    misoIn.classList.toggle('bad', (res?.warnings || []).some((w) => w.startsWith('MISO')));
    for (const b of orderBtns) b.setAttribute('aria-pressed', String(b.dataset.v === (ctx.raw.order || 'msb')));
    warns.replaceChildren(...((res && res.warnings) || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'Notes'), ...((res && res.notes) || []).map((t) => h('div', {}, t)));
  }

  ctx.onResult((r) => { res = r; drawSide(); drawCap(); });
  let lastW = 0;
  new ResizeObserver(() => { const w = capCard.clientWidth; if (w !== lastW) { lastW = w; drawCap(); } }).observe(capCard);
}
