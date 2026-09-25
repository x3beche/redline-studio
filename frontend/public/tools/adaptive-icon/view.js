// Adaptive Icon Composer, custom page: the icon on the bench.
//
// The main area is the 108 dp layer canvas itself, drawn large with dp rulers:
// the parallax band the launcher never shows, the chosen launcher mask cut
// out of it, the 66 dp safe circle and the logo with its reach drawn as a
// dimension from the centre. Drag a corner handle of the logo (or use the
// arrow keys on it) to size it; the parts a circle mask would cut turn red.
// The layer panel beside it holds the two layers as a design app would -
// foreground above background, each with its colour - and the contrast
// between them. Below: the icon on a home screen under every mask and as a
// themed icon, and the export sizes drawn to scale.
//
// Every number shown (reach, largest logo, contrast, the px sizes) comes from
// run()'s result (values, drawing, tables).

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, text) => {
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
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};

// AOSP config_icon_mask paths, 100 x 100 units over the 72 dp visible area.
const MASKS = [
  ['circle', 'Circle', 'M50 0A50 50 0 1 1 50 100A50 50 0 1 1 50 0Z'],
  ['squircle', 'Squircle', 'M50,0 C10,0 0,10 0,50 C0,90 10,100 50,100 C90,100 100,90 100,50 C100,10 90,0 50,0 Z'],
  ['rsquare', 'Rounded square', 'M50,0L92,0C96.42,0 100,4.58 100,8L100,92C100,96.42 96.42,100 92,100L8,100C3.58,100 0,96.42 0,92L0,8C0,3.58 3.58,0 8,0L50,0Z'],
  ['teardrop', 'Teardrop', 'M50,0A50,50,0,0 1 100,50L100,85A15,15,0,0 1 85,100L50,100A50,50,0,0 1 50,0Z'],
  ['square', 'Square', 'M0,0H100V100H0Z'],
];
const KINDS = [['text', 'Letters'], ['circle', 'Circle'], ['square', 'Rounded square'], ['image', 'Image']];

const CSS = `
.ai { --tool-cut: var(--danger); --tool-band: var(--paper); --tool-wall: #d9dee4; --tool-wall-ink: #26313b;
  display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(300px, 1fr); gap: 12px; align-items: start; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .ai { --tool-wall: #0a0f14; --tool-wall-ink: #c8d3dc; } }
:root[data-theme="dark"] .ai { --tool-wall: #0a0f14; --tool-wall-ink: #c8d3dc; }
.ai [hidden] { display: none !important; }
.ai-bench { grid-row: 1 / span 3; }
.ai-out { grid-column: 1 / -1; }
@media (max-width: 900px) { .ai { grid-template-columns: minmax(0, 1fr); } .ai-bench { grid-row: auto; } }
.ai-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.ai-head { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.ai-h { font-weight: 600; font-size: 13px; }
.ai-sub { color: var(--ink-soft); font-size: 12px; }
.ai-mono { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.ai-masks { display: flex; gap: 3px; margin-left: auto; }
.ai-mask { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 28px; padding: 0;
  border: 1px solid var(--line); border-radius: 4px; background: var(--surface); cursor: pointer; }
.ai-mask svg { width: 18px; height: 18px; display: block; }
.ai-mask path { fill: none; stroke: var(--ink-soft); stroke-width: 9; }
.ai-mask[aria-pressed="true"] { background: var(--sunken); border-color: var(--accent); }
.ai-mask[aria-pressed="true"] path { stroke: var(--accent); fill: var(--accent); fill-opacity: .18; }
.ai-canvaswrap { padding: 6px 10px 4px; display: flex; justify-content: center; }
.ai-canvas { display: block; width: 100%; max-width: 640px; height: auto; max-height: calc(100vh - 205px); min-height: 280px;
  touch-action: none; user-select: none; -webkit-user-select: none; }
.ai-canvas .ruler { fill: var(--ink-soft); font: 2.6px "IBM Plex Mono", ui-monospace, monospace; }
.ai-canvas .tick { stroke: var(--line); stroke-width: .25; }
.ai-canvas .tick.major { stroke: var(--ink-soft); }
.ai-canvas .edge { fill: none; stroke: var(--line); stroke-width: .3; }
.ai-canvas .band { fill: var(--tool-band); fill-opacity: .74; }
.ai-canvas .maskline { fill: none; stroke: var(--accent); stroke-width: .45; }
.ai-canvas .view72 { fill: none; stroke: var(--ink-soft); stroke-width: .25; stroke-dasharray: 1.2 1; }
.ai-canvas .safe { fill: none; stroke: var(--ok); stroke-width: .45; stroke-dasharray: 1.6 1.1; }
.ai-canvas .safe.bad { stroke: var(--danger); }
.ai-canvas .bbox { fill: none; stroke: var(--ink); stroke-width: .3; stroke-dasharray: .9 .7; opacity: .75; }
.ai-canvas .cut { fill: url(#ai-hatch); }
.ai-canvas .dim { stroke: var(--ink); stroke-width: .35; }
.ai-canvas .dim.bad { stroke: var(--danger); }
.ai-canvas .tag { fill: var(--surface); stroke: var(--line); stroke-width: .25; }
.ai-canvas .tagt { fill: var(--ink); font: 500 3.1px "IBM Plex Mono", ui-monospace, monospace; }
.ai-canvas .tagt.bad { fill: var(--danger); }
.ai-canvas .lbl { fill: var(--ink-soft); font: 2.7px "IBM Plex Sans", system-ui, sans-serif; }
.ai-canvas .lbl.acc { fill: var(--accent); }
.ai-canvas .lbl.ok { fill: var(--ok); } .ai-canvas .lbl.bad { fill: var(--danger); }
.ai-canvas .hnd { cursor: nwse-resize; outline: none; }
.ai-canvas .hnd.ne, .ai-canvas .hnd.sw { cursor: nesw-resize; }
.ai-canvas .hnd .knob { fill: var(--accent); stroke: var(--surface); stroke-width: .45; }
.ai-canvas .hnd .hit { fill: transparent; }
.ai-canvas .hnd .ring { fill: none; stroke: none; }
.ai-canvas .hnd:hover .knob, .ai-canvas .hnd:focus-visible .knob, .ai-canvas .hnd.drag .knob { fill: var(--ink); }
.ai-canvas .hnd:focus-visible .ring { stroke: var(--accent); stroke-width: .4; fill: none; }
.ai-canvas.drop { outline: 2px dashed var(--accent); outline-offset: -4px; }
.ai-bar { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; padding: 6px 10px 9px; font-size: 12px; color: var(--ink-soft); }
.ai-bar label { display: inline-flex; align-items: center; gap: 5px; }
.ai-num { width: 64px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--sunken);
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.ai-num.bad { border-color: var(--danger); }
.ai-read { font: 500 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.ai-read.bad { color: var(--danger); } .ai-read.ok { color: var(--ok); }
.ai-warns:empty { display: none; }
.ai-warns { margin: 0 10px 10px; border: 1px solid var(--warn); border-left-width: 3px; border-radius: 4px; padding: 5px 9px; font-size: 12px; color: var(--ink); }
.ai-warns div + div { margin-top: 3px; }
.ai-help { padding: 0 10px 9px; font-size: 11.5px; color: var(--ink-soft); }

/* layers */
.ai-layers { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 0; }
.ai-layer { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 4px 10px; padding: 8px; border: 1px solid var(--line); border-radius: 5px; background: var(--sunken); }
.ai-thumb { grid-row: 1 / span 3; width: 54px; height: 54px; border-radius: 4px; border: 1px solid var(--line); display: block; }
.ai-lname { font-weight: 600; font-size: 12.5px; display: flex; gap: 8px; align-items: baseline; }
.ai-lname span { font-weight: 400; color: var(--ink-soft); font-size: 11.5px; }
.ai-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
.ai-sw { display: inline-flex; align-items: center; gap: 0; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); overflow: hidden; }
.ai-sw input[type="color"] { width: 28px; height: 26px; padding: 0; border: 0; background: none; cursor: pointer; }
.ai-sw input[type="text"] { width: 76px; border: 0; border-left: 1px solid var(--line); padding: 3px 6px; background: transparent;
  font: 12.5px "IBM Plex Mono", ui-monospace, monospace; }
.ai-sw.bad { border-color: var(--danger); }
.ai-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; background: var(--surface); }
.ai-seg button { border: 0; background: transparent; padding: 3px 8px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.ai-seg button + button { border-left: 1px solid var(--line); }
.ai-seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.ai-glyph { width: 58px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); font: 600 13px "IBM Plex Sans", sans-serif; }
.ai-file { cursor: pointer; }
.ai-contrast { display: flex; align-items: center; gap: 8px; padding: 4px 0 4px 26px; font-size: 12px; color: var(--ink-soft); position: relative; }
.ai-contrast::before { content: ""; position: absolute; left: 34px; top: -2px; bottom: -2px; border-left: 2px solid var(--line); }
.ai-contrast b { font: 500 12.5px "IBM Plex Mono", ui-monospace, monospace; padding: 1px 6px; border-radius: 3px; border: 1px solid var(--line); background: var(--surface); position: relative; margin-left: 18px; }
.ai-contrast b.ok { color: var(--ok); border-color: var(--ok); } .ai-contrast b.bad { color: var(--warn); border-color: var(--warn); }

/* home screen and sizes */
.ai-home svg, .ai-sizes svg { display: block; width: 100%; height: auto; }
.ai-home .wall { fill: var(--tool-wall); }
.ai-home .nm { fill: var(--tool-wall-ink); font: 10px "IBM Plex Sans", system-ui, sans-serif; }
.ai-home .nm.sel { font-weight: 600; }
.ai-home .pick { cursor: pointer; outline: none; }
.ai-home .pick .selring { fill: none; stroke: none; }
.ai-home .pick[aria-pressed="true"] .selring { stroke: var(--accent); stroke-width: 2; }
.ai-home .pick:focus-visible .selring { stroke: var(--accent); stroke-width: 2; stroke-dasharray: 3 2; }
.ai-sizes .sq { fill: var(--sunken); stroke: var(--line); }
.ai-sizes .sq.safe { fill: none; stroke: var(--ok); stroke-dasharray: 3 2; }
.ai-sizes .vis { fill: none; stroke: var(--ink-soft); stroke-dasharray: 2 2; }
.ai-sizes .t { fill: var(--ink); font: 500 10.5px "IBM Plex Mono", ui-monospace, monospace; }
.ai-sizes .s { fill: var(--ink-soft); font: 10px "IBM Plex Sans", system-ui, sans-serif; }
.ai-note { padding: 0 10px 8px; font-size: 11.5px; color: var(--ink-soft); }
@media (max-width: 560px) {
  .ai-canvas { max-height: none; min-height: 0; }
  .ai-canvas .ruler { font-size: 4px; } .ai-canvas .lbl { font-size: 3.9px; } .ai-canvas .tagt { font-size: 4.2px; }
  .ai-masks { margin-left: 0; }
}
`;

let image = null; // a loaded logo image, kept in this page only

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  const st = { mask: 'circle', drag: null, d: null };
  try { const m = localStorage.getItem('redline.tool.adaptive-icon.mask'); if (MASKS.some((x) => x[0] === m)) st.mask = m; } catch { /* private window */ }

  // ------------------------------------------------------------ bench
  const maskBtns = MASKS.map(([id, name, path]) => h('button', { class: 'ai-mask', title: `${name} mask`, 'aria-label': `${name} mask`,
    'aria-pressed': 'false', onclick: () => setMask(id) }, (() => {
    const s = sv('svg', { viewBox: '-6 -6 112 112', 'aria-hidden': 'true' }); s.append(sv('path', { d: path })); return s;
  })()));
  const canvas = sv('svg', { class: 'ai-canvas', viewBox: '-13 -12 131 126', role: 'group', 'aria-label': 'The 108 dp icon layers. Drag a corner handle to size the logo.' });
  const sizeIn = h('input', { class: 'ai-num', type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Logo size in dp',
    oninput: (e) => ctx.set('size', e.target.value) });
  const reachOut = h('span', { class: 'ai-read' });
  const maxOut = h('span', { class: 'ai-read' });
  const visOut = h('span', { class: 'ai-read' });
  const fitBtn = h('button', { class: 'k-btn', title: 'Make the logo the largest that stays in the 66 dp safe circle', onclick: () => {
    const d = st.d; if (!d) return; ctx.set('size', String(Math.floor(d.maxSize * 10) / 10));
  } }, 'Fit to safe zone');
  const warns = h('div', { class: 'ai-warns', 'aria-live': 'polite' });
  const maskName = h('span', { class: 'ai-sub' });
  const bench = h('section', { class: 'ai-panel ai-bench' },
    h('div', { class: 'ai-head' }, h('span', { class: 'ai-h' }, 'Layers, 108 × 108 dp'), maskName,
      h('div', { class: 'ai-masks', role: 'group', 'aria-label': 'Launcher mask' }, maskBtns)),
    h('div', { class: 'ai-canvaswrap' }, canvas),
    h('div', { class: 'ai-bar' },
      h('label', {}, 'Logo', sizeIn, 'dp'),
      h('span', {}, 'reach ', reachOut, ' of 33 dp'),
      h('span', {}, 'largest ', maxOut),
      h('span', {}, 'fills ', visOut, ' of the view'),
      fitBtn),
    warns,
    h('div', { class: 'ai-help' }, 'Drag a corner of the logo, or focus it and use the arrow keys (Shift for 5 dp). The dimmed ring is the 18 dp parallax band no launcher shows; the mask buttons swap the cut-out.'));

  // ------------------------------------------------------------ layers
  const swatch = (key, label) => {
    const col = h('input', { type: 'color', 'aria-label': `${label}, picker`, oninput: (e) => { txt.value = e.target.value; ctx.set(key, e.target.value); } });
    const txt = h('input', { type: 'text', spellcheck: 'false', 'aria-label': `${label}, hex`, oninput: (e) => ctx.set(key, e.target.value) });
    const wrap = h('span', { class: 'ai-sw' }, col, txt);
    return { wrap, col, txt, key };
  };
  const seg = (items, key, label) => {
    const btns = items.map(([v, t]) => h('button', { 'data-v': v, 'aria-pressed': 'false', onclick: () => ctx.set(key, v) }, t));
    return { el: h('span', { class: 'ai-seg', role: 'group', 'aria-label': label }, btns), btns, key };
  };
  const fgSw = swatch('fg', 'Logo colour');
  const bgSw = swatch('bg', 'Background colour');
  const bg2Sw = swatch('bg2', 'Second background colour');
  const kindSeg = seg(KINDS, 'fgKind', 'Logo kind');
  const shapeSeg = seg([['square', 'Square-ish'], ['round', 'Round']], 'shape', 'Logo outline, how far its corners reach');
  const styleSeg = seg([['solid', 'Solid'], ['gradient', 'Gradient']], 'bgStyle', 'Background style');
  const glyphIn = h('input', { class: 'ai-glyph', type: 'text', maxlength: '3', spellcheck: 'false', 'aria-label': 'Letters of the logo',
    oninput: (e) => ctx.set('glyph', e.target.value) });
  const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => loadFile(fileIn.files && fileIn.files[0]) });
  const fileBtn = h('label', { class: 'k-btn ai-file' }, 'Load image…', fileIn);
  const fileName = h('span', { class: 'ai-sub' });
  const fgThumb = sv('svg', { class: 'ai-thumb', viewBox: '0 0 108 108', 'aria-hidden': 'true' });
  const bgThumb = sv('svg', { class: 'ai-thumb', viewBox: '0 0 108 108', 'aria-hidden': 'true' });
  const crOut = h('b');
  const fgRowColour = h('div', { class: 'ai-row' }, fgSw.wrap, glyphIn, fileBtn, fileName);
  const layers = h('section', { class: 'ai-panel' },
    h('div', { class: 'ai-head' }, h('span', { class: 'ai-h' }, 'Layer stack'), h('span', { class: 'ai-sub' }, 'top to bottom, as the launcher composes them')),
    h('div', { class: 'ai-layers' },
      h('div', { class: 'ai-layer' }, fgThumb,
        h('div', { class: 'ai-lname' }, 'Foreground', h('span', {}, 'the logo, ic_launcher_foreground')),
        h('div', { class: 'ai-row' }, kindSeg.el),
        fgRowColour,
        h('div', { class: 'ai-row', style: 'grid-column: 2' }, h('span', { class: 'ai-sub' }, 'Reach counted as'), shapeSeg.el)),
      h('div', { class: 'ai-contrast' }, crOut, h('span', { class: 'ai-crtext' }, 'contrast, logo on background')),
      h('div', { class: 'ai-layer' }, bgThumb,
        h('div', { class: 'ai-lname' }, 'Background', h('span', {}, 'ic_launcher_background')),
        h('div', { class: 'ai-row' }, styleSeg.el),
        h('div', { class: 'ai-row' }, bgSw.wrap, bg2Sw.wrap))));

  // ------------------------------------------------------------ home + sizes
  const home = sv('svg', { viewBox: '0 0 400 172', role: 'group', 'aria-label': 'The icon on a home screen under each mask; click one to inspect it on the canvas' });
  const homePanel = h('section', { class: 'ai-panel ai-home' },
    h('div', { class: 'ai-head' }, h('span', { class: 'ai-h' }, 'On a home screen'), h('span', { class: 'ai-sub' }, 'every launcher mask at 48 dp, and the themed icon')),
    h('div', { style: 'padding: 8px 10px 10px' }, home));
  const sizes = sv('svg', { viewBox: '0 0 400 162', role: 'img', 'aria-label': 'Layer sizes to export, drawn to scale' });
  const sizesPanel = h('section', { class: 'ai-panel ai-sizes' },
    h('div', { class: 'ai-head' }, h('span', { class: 'ai-h' }, 'Export sizes'), h('span', { class: 'ai-sub' }, 'each layer per density, to scale, px')),
    h('div', { style: 'padding: 8px 10px 4px' }, sizes),
    h('div', { class: 'ai-note' }, 'Dashed: the 72 dp visible area and the safe circle at that density. Legacy icon is the flat pre-API-26 ic_launcher.png.'));

  const outWrap = h('div', { class: 'ai-out' }, ctx.outputs);
  root.append(h('div', { class: 'ai' }, bench, layers, homePanel, sizesPanel, outWrap));

  // ------------------------------------------------------------ actions
  function setMask(id) {
    st.mask = id;
    try { localStorage.setItem('redline.tool.adaptive-icon.mask', id); } catch { /* private window */ }
    draw();
  }
  function loadFile(fl) {
    if (!fl || !/^image\//.test(fl.type)) return;
    const rd = new FileReader();
    rd.onload = () => { image = { url: rd.result, name: fl.name }; if (ctx.raw.fgKind !== 'image') ctx.set('fgKind', 'image'); else draw(); };
    rd.readAsDataURL(fl);
  }
  canvas.addEventListener('dragover', (e) => { e.preventDefault(); canvas.classList.add('drop'); });
  canvas.addEventListener('dragleave', () => canvas.classList.remove('drop'));
  canvas.addEventListener('drop', (e) => { e.preventDefault(); canvas.classList.remove('drop'); loadFile(e.dataTransfer.files && e.dataTransfer.files[0]); });

  const toDp = (e) => {
    const m = canvas.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  const sizeFrom = (p, round) => {
    const dx = p.x - 54, dy = p.y - 54;
    let s = round ? 2 * Math.hypot(dx, dy) : 2 * Math.max(Math.abs(dx), Math.abs(dy));
    s = Math.max(4, Math.min(108, s));
    const d = st.d;
    if (d && Math.abs(s - d.maxSize) < 1.2) return Math.floor(d.maxSize * 10) / 10; // snap to the safe-zone fit
    return Math.round(s);
  };
  canvas.addEventListener('pointermove', (e) => {
    if (!st.drag || st.drag.id !== e.pointerId) return;
    const p = toDp(e); if (!p) return;
    const s = sizeFrom(p, st.drag.round);
    if (s !== st.drag.last) { st.drag.last = s; ctx.set('size', String(s)); }
  });
  const endDrag = (e) => {
    if (!st.drag || st.drag.id !== e.pointerId) return;
    st.drag = null;
    for (const g of canvas.querySelectorAll('.hnd.drag')) g.classList.remove('drag');
    const k = canvas.querySelector('.hnd.ne'); if (k) k.focus({ preventScroll: true });
  };
  canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
  const nudge = (delta) => {
    const cur = Number(st.d ? st.d.size : 44);
    ctx.set('size', String(Math.max(4, Math.min(108, Math.round(cur + delta)))));
  };

  // ------------------------------------------------------------ drawing
  const layerGroup = (d, uid) => {
    const g = sv('g');
    if (d.bg2) {
      const defs = sv('defs');
      const lg = sv('linearGradient', { id: `ai-g${uid}`, x1: 0, y1: 0, x2: 1, y2: 1 });
      lg.append(sv('stop', { offset: 0, 'stop-color': d.bg }), sv('stop', { offset: 1, 'stop-color': d.bg2 }));
      defs.append(lg); g.append(defs);
    }
    g.append(sv('rect', { width: 108, height: 108, fill: d.bg2 ? `url(#ai-g${uid})` : d.bg }));
    g.append(logo(d, d.fg));
    return g;
  };
  const logo = (d, fill) => {
    const z = d.size;
    if (d.kind === 'image') {
      if (image) return sv('image', { href: image.url, x: 54 - z / 2, y: 54 - z / 2, width: z, height: z, preserveAspectRatio: 'xMidYMid meet' });
      return sv('rect', { x: 54 - z / 2, y: 54 - z / 2, width: z, height: z, fill: 'none', stroke: 'var(--ink-soft)', 'stroke-width': 0.4, 'stroke-dasharray': '1.5 1' });
    }
    if (d.kind === 'text') return sv('text', { x: 54, y: 54, 'font-family': 'Roboto, Arial, sans-serif', 'font-weight': 700, 'font-size': z * 1.05, fill, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, d.text);
    if (d.kind === 'circle') return sv('circle', { cx: 54, cy: 54, r: z / 2, fill });
    return sv('rect', { x: 54 - z / 2, y: 54 - z / 2, width: z, height: z, rx: z * 0.18, fill });
  };
  const silhouette = (d) => {
    // the logo's area for the cut hatch: the letters themselves, the shape, or an image's box
    if (d.kind === 'image') { const z = d.size; return sv('rect', { x: 54 - z / 2, y: 54 - z / 2, width: z, height: z }); }
    return logo(d, '#000');
  };

  function drawCanvas(d) {
    canvas.replaceChildren();
    const mask = MASKS.find((m) => m[0] === st.mask) || MASKS[0];
    const MT = 'translate(18,18) scale(0.72)';
    const defs = sv('defs');
    const hatch = sv('pattern', { id: 'ai-hatch', width: 2.2, height: 2.2, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    hatch.append(sv('rect', { width: 2.2, height: 2.2, fill: 'var(--danger)', 'fill-opacity': 0.25 }), sv('line', { x1: 0, y1: 0, x2: 0, y2: 2.2, stroke: 'var(--danger)', 'stroke-width': 0.9 }));
    const outSafe = sv('mask', { id: 'ai-outsafe', maskUnits: 'userSpaceOnUse', x: -20, y: -20, width: 148, height: 148 });
    outSafe.append(sv('rect', { x: -20, y: -20, width: 148, height: 148, fill: '#fff' }), sv('circle', { cx: 54, cy: 54, r: 33, fill: '#000' }));
    const clip = sv('clipPath', { id: 'ai-clip108' }); clip.append(sv('rect', { width: 108, height: 108 }));
    const bandMask = sv('mask', { id: 'ai-band', maskUnits: 'userSpaceOnUse', x: -20, y: -20, width: 148, height: 148 });
    bandMask.append(sv('rect', { x: -20, y: -20, width: 148, height: 148, fill: '#fff' }), sv('path', { d: mask[2], transform: MT, fill: '#000' }));
    defs.append(hatch, outSafe, clip, bandMask);
    canvas.append(defs);

    // rulers
    const R = sv('g');
    for (let v = 0; v <= 108; v += 3) {
      const major = v % 18 === 0 || v === 21 || v === 87;
      const len = major ? 3 : 1.5;
      R.append(sv('line', { class: `tick${major ? ' major' : ''}`, x1: v, y1: -1, x2: v, y2: -1 - len }));
      R.append(sv('line', { class: `tick${major ? ' major' : ''}`, x1: -1, y1: v, x2: -1 - len, y2: v }));
    }
    for (const v of [0, 18, 36, 54, 72, 90, 108]) {
      R.append(sv('text', { class: 'ruler', x: v, y: -5.6, 'text-anchor': 'middle' }, v));
      R.append(sv('text', { class: 'ruler', x: -5.3, y: v + 0.9, 'text-anchor': 'end' }, v));
    }
    R.append(sv('text', { class: 'ruler', x: 112, y: -5.6, 'text-anchor': 'start' }, 'dp'));
    canvas.append(R);

    // the layers, clipped to the 108 dp square
    const lay = sv('g', { 'clip-path': 'url(#ai-clip108)' });
    lay.append(layerGroup(d, 'c'));
    // what a circle mask cuts off the logo: outside the 66 dp safe circle
    if (!d.fits) {
      const cut = sv('g', { mask: 'url(#ai-outsafe)' });
      const sil = silhouette(d); sil.setAttribute('class', 'cut'); sil.removeAttribute('fill');
      cut.append(sil); lay.append(cut);
    }
    canvas.append(lay);
    // the parallax band the mask hides, dimmed; the mask outline
    const band = sv('g', { 'clip-path': 'url(#ai-clip108)' });
    band.append(sv('rect', { class: 'band', x: 0, y: 0, width: 108, height: 108, mask: 'url(#ai-band)' }));
    canvas.append(band);
    canvas.append(sv('rect', { class: 'edge', x: 0, y: 0, width: 108, height: 108 }));
    canvas.append(sv('rect', { class: 'view72', x: 18, y: 18, width: 72, height: 72 }));
    canvas.append(sv('path', { class: 'maskline', d: mask[2], transform: MT, 'vector-effect': 'non-scaling-stroke', style: 'stroke-width: 1.6px' }));
    canvas.append(sv('circle', { class: `safe${d.fits ? '' : ' bad'}`, cx: 54, cy: 54, r: 33 }));

    // band labels
    canvas.append(sv('text', { class: 'lbl', x: 1.6, y: 4.2 }, 'parallax band, never shown'));
    canvas.append(sv('text', { class: 'lbl acc', x: 19.2, y: 16.6 }, `${mask[1].toLowerCase()} mask, 72 dp`));
    canvas.append(sv('text', { class: `lbl ${d.fits ? 'ok' : 'bad'}`, x: 54, y: 54 + 33 - 1.6, 'text-anchor': 'middle' }, 'safe zone Ø 66'));

    // the logo's box and its reach
    const z = d.size, half = z / 2, round = d.round;
    canvas.append(round ? sv('circle', { class: 'bbox', cx: 54, cy: 54, r: half }) : sv('rect', { class: 'bbox', x: 54 - half, y: 54 - half, width: z, height: z }));
    const ang = -Math.PI / 4; // up-right diagonal
    const rx = 54 + d.reach * Math.cos(ang), ry = 54 + d.reach * Math.sin(ang);
    const bad = !d.fits;
    canvas.append(sv('line', { class: `dim${bad ? ' bad' : ''}`, x1: 54, y1: 54, x2: rx, y2: ry }));
    canvas.append(sv('circle', { cx: 54, cy: 54, r: 0.7, fill: 'var(--ink)' }));
    // safe radius, down-left
    const sx = 54 - 33 * Math.SQRT1_2, sy = 54 + 33 * Math.SQRT1_2;
    canvas.append(sv('line', { class: 'dim', x1: 54, y1: 54, x2: sx, y2: sy, 'stroke-dasharray': '1 .8', opacity: 0.7 }));
    tag(54 - 16.5 * Math.SQRT1_2, 54 + 16.5 * Math.SQRT1_2, `r 33`, false);
    const mx = 54 + (d.reach / 2) * Math.cos(ang), my = 54 + (d.reach / 2) * Math.sin(ang);
    tag(mx, my, `reach ${ctx.fmtNum(d.reach, 3)} dp`, bad);
    if (bad) {
      const lx = Math.min(104, rx + 1.5), ly = Math.max(3, ry - 1.5);
      canvas.append(sv('text', { class: 'lbl bad', x: lx, y: ly, 'text-anchor': lx > 90 ? 'end' : 'start' }, 'cut by a circle mask'));
    }
    // size dimension above the box
    if (!round) {
      const y = Math.max(-0.5, 54 - half - 3.2);
      canvas.append(sv('line', { class: 'dim', x1: 54 - half, y1: y, x2: 54 + half, y2: y, opacity: 0.55 }));
      canvas.append(sv('text', { class: 'lbl', x: 54, y: y - 1, 'text-anchor': 'middle' }, `${ctx.fmtNum(z, 3)} dp`));
    } else {
      canvas.append(sv('text', { class: 'lbl', x: 54, y: Math.max(2, 54 - half - 1.4), 'text-anchor': 'middle' }, `Ø ${ctx.fmtNum(z, 3)} dp`));
    }

    // handles on the logo's corners (or its outline on the diagonals)
    const off = round ? half * Math.SQRT1_2 : half;
    [['nw', -1, -1], ['ne', 1, -1], ['se', 1, 1], ['sw', -1, 1]].forEach(([nm, ax, ay], i) => {
      const cx = 54 + ax * off, cy = 54 + ay * off;
      const g = sv('g', { class: `hnd ${nm}`, tabindex: i === 1 ? '0' : '-1', role: 'slider', 'aria-label': 'Logo size',
        'aria-valuemin': 4, 'aria-valuemax': 108, 'aria-valuenow': z, 'aria-valuetext': `${ctx.fmtNum(z, 3)} dp, reach ${ctx.fmtNum(d.reach, 3)} of 33 dp` });
      g.append(sv('circle', { class: 'hit', cx, cy, r: 4 }), sv('circle', { class: 'ring', cx, cy, r: 2.6 }), sv('rect', { class: 'knob', x: cx - 1.1, y: cy - 1.1, width: 2.2, height: 2.2, rx: 0.3 }));
      if (st.drag && st.drag.nm === nm) g.classList.add('drag');
      g.addEventListener('pointerdown', (e) => {
        e.preventDefault(); canvas.setPointerCapture(e.pointerId); g.classList.add('drag');
        st.drag = { id: e.pointerId, nm, last: z, round };
      });
      g.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 5 : 1;
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); nudge(step); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); nudge(-step); }
        else if (e.key === 'Home') { e.preventDefault(); fitBtn.click(); }
      });
      canvas.append(g);
    });
  }
  function tag(x, y, text, bad) {
    const k = matchMedia('(max-width: 560px)').matches ? 4.2 / 3.1 : 1;
    const w = (text.length * 1.9 + 2.4) * k;
    const g = sv('g', { 'pointer-events': 'none' });
    g.append(sv('rect', { class: 'tag', x: x - w / 2, y: y - 2.6 * k, width: w, height: 5 * k, rx: 0.8 }));
    g.append(sv('text', { class: `tagt${bad ? ' bad' : ''}`, x, y: y + 1.1 * k, 'text-anchor': 'middle' }, text));
    canvas.append(g);
  }

  function drawThumbs(d) {
    fgThumb.replaceChildren(sv('rect', { width: 108, height: 108, fill: 'var(--ink-soft)' }));
    for (let i = 0; i < 108; i += 12) for (let j = 0; j < 108; j += 12) if ((i + j) / 12 % 2 === 0) fgThumb.append(sv('rect', { x: i, y: j, width: 12, height: 12, fill: 'var(--line)' }));
    fgThumb.append(logo(d, d.fg));
    bgThumb.replaceChildren();
    const g = layerGroup({ ...d, kind: 'none' }, 't');
    g.lastChild.remove();
    bgThumb.append(g);
  }

  function drawHome(d) {
    home.replaceChildren();
    const W = 400;
    home.append(sv('rect', { class: 'wall', x: 0, y: 0, width: W, height: 172, rx: 6 }));
    const items = [...MASKS.map((m) => ({ id: m[0], name: m[1], path: m[2] })), { id: 'themed', name: 'Themed', path: MASKS.find((m) => m[0] === st.mask)[2] }];
    const cols = 6, cell = W / cols, icon = 44;
    items.forEach((it, i) => {
      const cx = cell * i + cell / 2, y0 = 22;
      const g = sv('g', { class: it.id === 'themed' ? '' : 'pick', transform: `translate(${cx - icon / 2},${y0})` });
      const cid = `ai-hm${i}`;
      const defs = sv('defs'); const cp = sv('clipPath', { id: cid }); cp.append(sv('path', { d: it.path, transform: `scale(${icon / 100})` })); defs.append(cp); g.append(defs);
      const clipG = sv('g', { 'clip-path': `url(#${cid})` });
      const inner = sv('g', { transform: `scale(${icon / 72}) translate(-18,-18)` });
      if (it.id === 'themed') {
        // Android 13 themed icon: the monochrome layer tinted by the wallpaper
        inner.append(sv('rect', { width: 108, height: 108, fill: 'var(--accent)', 'fill-opacity': 0.28 }));
        inner.append(sv('rect', { width: 108, height: 108, fill: 'var(--sunken)', 'fill-opacity': 0.55 }));
        const mono = d.kind === 'image' && image
          ? sv('image', { href: image.url, x: 54 - d.size / 2, y: 54 - d.size / 2, width: d.size, height: d.size, style: 'filter: grayscale(1) contrast(1.4)' })
          : logo(d, 'var(--accent)');
        inner.append(mono);
      } else inner.append(layerGroup(d, `h${i}`));
      clipG.append(inner); g.append(clipG);
      if (it.id !== 'themed') {
        g.append(sv('rect', { class: 'selring', x: -4, y: -4, width: icon + 8, height: icon + 8, rx: 9 }));
        g.setAttribute('tabindex', '0'); g.setAttribute('role', 'button');
        g.setAttribute('aria-pressed', String(st.mask === it.id)); g.setAttribute('aria-label', `${it.name} mask: show it on the canvas`);
        g.addEventListener('click', () => setMask(it.id));
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMask(it.id); } });
      }
      home.append(g);
      home.append(sv('text', { class: `nm${st.mask === it.id ? ' sel' : ''}`, x: cx, y: y0 + icon + 16, 'text-anchor': 'middle' }, it.name));
    });
    // a second row: at the real 48 dp launcher size next to other apps, in the chosen mask
    const mk = MASKS.find((m) => m[0] === st.mask);
    const y1 = 110, sm = 32;
    const neighbours = [['var(--line)'], ['var(--ink-soft)'], [null], ['var(--line)'], ['var(--ink-soft)']];
    neighbours.forEach(([fill], i) => {
      const x = 58 + i * 64;
      const g = sv('g', { transform: `translate(${x - sm / 2},${y1})` });
      if (fill) {
        g.append(sv('path', { d: mk[2], transform: `scale(${sm / 100})`, fill, 'fill-opacity': 0.55 }));
      } else {
        const cid = 'ai-hmsmall';
        const defs = sv('defs'); const cp = sv('clipPath', { id: cid }); cp.append(sv('path', { d: mk[2], transform: `scale(${sm / 100})` })); defs.append(cp); g.append(defs);
        const clipG = sv('g', { 'clip-path': `url(#${cid})` });
        const inner = sv('g', { transform: `scale(${sm / 72}) translate(-18,-18)` });
        inner.append(layerGroup(d, 'sm')); clipG.append(inner); g.append(clipG);
      }
      home.append(g);
      home.append(sv('rect', { x: x - 14, y: y1 + sm + 8, width: 28, height: 4, rx: 2, fill: 'var(--tool-wall-ink)', 'fill-opacity': fill ? 0.25 : 0.7 }));
    });
    home.append(sv('text', { class: 'nm', x: 8, y: 102, 'fill-opacity': 0.8 }, `among other apps, ${mk[1].toLowerCase()}`));
  }

  function drawSizes(res, d) {
    sizes.replaceChildren();
    const t = (res.tables || [])[0];
    if (!t) return;
    const rows = t.rows.filter((r) => /^mipmap/.test(r[0]));
    const px = rows.map((r) => parseInt(r[1], 10));
    const play = 512;
    const W = 400, base = 118, maxH = 96, k = maxH / play;
    let x = 6;
    rows.forEach((r, i) => {
      const s = px[i] * k;
      sizes.append(sv('rect', { class: 'sq', x, y: base - s, width: s, height: s, rx: 1 }));
      const v = (72 / 108) * s, sr = (parseFloat(r[2]) / 2) * k;
      sizes.append(sv('rect', { class: 'vis', x: x + (s - v) / 2, y: base - s + (s - v) / 2, width: v, height: v }));
      sizes.append(sv('circle', { class: 'sq safe', cx: x + s / 2, cy: base - s / 2, r: sr }));
      sizes.append(sv('text', { class: 't', x: x + s / 2, y: base + 13, 'text-anchor': 'middle' }, px[i]));
      sizes.append(sv('text', { class: 's', x: x + s / 2, y: base + 25, 'text-anchor': 'middle' }, r[0].replace('mipmap-', '')));
      x += s + 16;
    });
    // Play Store icon, no mask
    const s = play * k;
    x = Math.max(x + 6, W - s - 6);
    sizes.append(sv('rect', { class: 'sq', x, y: base - s, width: s, height: s, rx: 2, style: 'stroke-dasharray: 4 2' }));
    sizes.append(sv('text', { class: 't', x: x + s / 2, y: base + 13, 'text-anchor': 'middle' }, '512'));
    sizes.append(sv('text', { class: 's', x: x + s / 2, y: base + 25, 'text-anchor': 'middle' }, 'Play Store'));
    const legacy = rows.map((r) => r[4]).join(' · ');
    sizes.append(sv('text', { class: 's', x: 6, y: 158 }, `legacy icon: ${legacy.replace(/ × \d+/g, '')} px`));
  }

  // ------------------------------------------------------------ sync
  const syncVal = (el, v) => { if (document.activeElement !== el && el.value !== v) el.value = v; };
  const syncSw = (sw, raw) => {
    syncVal(sw.txt, String(raw ?? ''));
    const ok = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(raw || '').trim());
    sw.wrap.classList.toggle('bad', !ok);
    if (ok) {
      let hx = String(raw).trim().replace('#', '');
      if (hx.length === 3) hx = [...hx].map((c) => c + c).join('');
      if (document.activeElement !== sw.col) sw.col.value = '#' + hx.toLowerCase();
    }
  };
  function draw() {
    const res = ctx.result || {};
    const raw = ctx.raw;
    const d = res.drawing || st.d;
    if (res.drawing) st.d = res.drawing;
    syncVal(sizeIn, String(raw.size ?? ''));
    syncVal(glyphIn, String(raw.glyph ?? ''));
    syncSw(fgSw, raw.fg); syncSw(bgSw, raw.bg); syncSw(bg2Sw, raw.bg2);
    for (const s of [kindSeg, shapeSeg, styleSeg]) for (const b of s.btns) b.setAttribute('aria-pressed', String(b.dataset.v === String(raw[s.key])));
    const kind = raw.fgKind;
    glyphIn.hidden = kind !== 'text';
    fgSw.wrap.hidden = kind === 'image';
    fileBtn.hidden = kind !== 'image';
    fileName.hidden = kind !== 'image';
    fileName.textContent = image ? image.name : 'a transparent PNG or SVG, or drop it on the canvas';
    fileBtn.firstChild.textContent = image ? 'Change image…' : 'Load image…';
    bg2Sw.wrap.hidden = raw.bgStyle !== 'gradient';
    const mask = MASKS.find((m) => m[0] === st.mask);
    maskBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(MASKS[i][0] === st.mask)));
    maskName.textContent = `under the ${mask[1].toLowerCase()} mask`;

    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    sizeIn.classList.toggle('bad', !res.drawing && /size/i.test((res.warnings || []).join(' ')));
    if (!d) { canvas.replaceChildren(); return; }
    canvas.style.opacity = res.drawing ? '' : '0.45';
    const v = res.values || [];
    reachOut.textContent = v[0] ? `${v[0].value} dp` : '–';
    reachOut.className = `ai-read ${d.fits ? 'ok' : 'bad'}`;
    maxOut.textContent = v[1] ? `${v[1].value} dp` : '–';
    visOut.textContent = v[2] ? v[2].value : '–';
    crOut.textContent = v[3] ? v[3].value : '–';
    crOut.className = v[3] && v[3].tone === 'ok' ? 'ok' : v[3] && v[3].tone ? 'bad' : '';
    const hadFocus = document.activeElement && document.activeElement.closest && document.activeElement.closest('.hnd');
    drawCanvas(d);
    if (hadFocus && !st.drag) { const k = canvas.querySelector('.hnd.ne'); if (k) k.focus({ preventScroll: true }); }
    drawThumbs(d);
    drawHome(d);
    if (res.drawing) drawSizes(res, d);
  }
  ctx.onResult(() => draw());
}
