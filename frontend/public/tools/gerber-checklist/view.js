// Gerber Checklist: the page is the fab package itself. The board's layer
// files are drawn as an exploded stack - silkscreen, mask, paste, copper,
// inner layers, outline, drills - and each sheet is there only once it is
// ticked: click a sheet to put it in the zip. While the files do not share an
// origin the sheets sit out of register; unnamed files carry no layer name.
// Beside the stack lie the papers that go with it (fab notes to fill in line
// by line, the assembly files, the panel drawing, the final checks), and the
// open items as a to-do list. Every state and count drawn comes from run()'s
// result (result.check).

const NS = 'http://www.w3.org/2000/svg';
function h(tag, attrs = {}, ...kids) {
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
}
function sv(parent, tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// The sample board every sheet shows (board units, 100 × 60).
const PADS = [
  ...[0, 1, 2, 3].flatMap((i) => [[34, 21 + i * 6, 5, 3], [50, 21 + i * 6, 5, 3]]), // U1
  [13, 14, 4, 5], [21, 14, 4, 5], [13, 46, 4, 5], [21, 46, 4, 5], // R1, C1
  ...[0, 1, 2, 3, 4, 5].map((i) => [88, 12 + i * 7, 5, 4]), // J1
];
const VIAS = [[28, 18], [58, 44], [62, 13], [27, 50], [72, 30]];
const HOLES = [[5, 5], [95, 5], [5, 55], [95, 55]];
const SLOT = [70, 44, 14, 5];
const TRACES = [
  'M36.5 21 H28 V18', 'M13 14 V8 H62 V13', 'M52.5 39 H58 V44', 'M21 46 H27 V50',
  'M52.5 21 H72 V30', 'M72 30 H80 V12 H88', 'M52.5 33 H80 V19 H88', 'M21 14 H30 V27 H36.5', 'M58 44 H86 V47 H88',
];
const CUT = 'M4 0 H96 A4 4 0 0 1 100 4 V56 A4 4 0 0 1 96 60 H4 A4 4 0 0 1 0 56 V4 A4 4 0 0 1 4 0 Z';
const OPEN_CUT = 'M4 0 H60 M68 0 H96 A4 4 0 0 1 100 4 V56 A4 4 0 0 1 96 60 H4 A4 4 0 0 1 0 56 V4 A4 4 0 0 1 4 0';

// Fab notes: example wording for a filled-in line.
const NOTE_TEXT = {
  n_material: ['Material, thickness', 'FR-4, Tg 150, 1.6 mm'],
  n_copper: ['Copper weight', '1 oz outer, 0.5 oz inner'],
  n_finish: ['Surface finish', 'ENIG'],
  n_colour: ['Mask / silk colour', 'green / white'],
  n_stackup: ['Stack-up, impedance', 'JLC7628, 50 Ω on L1/L4'],
  n_vias: ['Via treatment', 'tented both sides'],
  n_class: ['IPC class, quantity', 'IPC-6012 class 2, 10 pcs'],
};

export function page(root, ctx) {
  let res = null, C = null;
  let hot = null;       // item key under the pointer or focus
  let focusKey = null, focusIdx = 0;  // item to refocus after a redraw
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));

  const item = (k) => C?.items.find((it) => it.key === k);
  const toggle = (k) => {
    const a = document.activeElement?.closest?.('[data-k]');
    focusKey = a && a.dataset.k === k ? k : null;
    focusIdx = focusKey ? [...root.querySelectorAll(`[data-k="${k}"]`)].indexOf(a) : 0;
    ctx.set(k, !ctx.raw[k]);
  };
  const keyToggle = (e, k) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(k); } };

  // ---------- context strip ----------
  const layerSeg = h('div', { class: 'gc-seg', role: 'radiogroup', 'aria-label': 'Layer count' },
    [['2', '2 layers'], ['4', '4 layers'], ['6', '6 or more']].map(([v, t]) => h('button', { type: 'button', role: 'radio', 'data-v': v,
      onclick: () => ctx.set('layers', v),
      onkeydown: (e) => {
        const order = ['2', '4', '6'];
        const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!d) return; e.preventDefault();
        const n = order[clamp(order.indexOf(v) + d, 0, 2)]; ctx.set('layers', n);
        requestAnimationFrame(() => layerSeg.querySelector(`[data-v="${n}"]`)?.focus());
      } }, t)));
  const asmBtn = h('button', { type: 'button', class: 'gc-toggle', 'aria-pressed': 'false', onclick: () => ctx.set('asm', !ctx.raw.asm) }, 'Assembly too (SMT)');
  const panelBtn = h('button', { type: 'button', class: 'gc-toggle', 'aria-pressed': 'false', onclick: () => ctx.set('panel', !ctx.raw.panel) }, 'I supply the panel');
  const ctxBar = h('div', { class: 'gc-ctx' },
    h('span', { class: 'gc-cap' }, 'The board'), layerSeg, asmBtn, panelBtn,
    h('span', { class: 'gc-hint' }, 'Click a sheet, a note line or a document to put it in the zip.'));

  // ---------- the stack ----------
  const svg = sv(null, 'svg', { role: 'group', 'aria-label': 'The Gerber files as an exploded layer stack' });
  const box = h('div', { class: 'gc-box' }, svg);
  const inspector = h('div', { class: 'gc-insp', 'aria-live': 'polite' });
  const stack = h('section', { class: 'gc-stack' },
    h('div', { class: 'gc-head' }, h('span', { class: 'gc-cap' }, 'Layer files, exploded'), h('span', { class: 'gc-hint' }, 'dashed: not in the zip yet')),
    box, inspector);

  // ---------- documents ----------
  const docs = h('section', { class: 'gc-docs' });

  // ---------- to-do ----------
  const prog = h('div', { class: 'gc-prog' });
  const todo = h('div', { class: 'gc-todo', role: 'list', 'aria-label': 'Still open' });
  const todoCol = h('aside', { class: 'gc-todocol' }, h('div', { class: 'gc-card gc-progcard' }, prog, todo), ctx.outputs);

  root.append(h('div', { class: 'gc' }, ctxBar, stack, docs, todoCol));
  new ResizeObserver(() => drawStack()).observe(box);

  ctx.onResult((r) => {
    res = r; C = r.check || null;
    const raw = ctx.raw;
    for (const b of layerSeg.children) { const on = b.dataset.v === String(raw.layers); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    asmBtn.setAttribute('aria-pressed', String(!!raw.asm));
    panelBtn.setAttribute('aria-pressed', String(!!raw.panel));
    drawStack(); drawDocs(); drawTodo(); showInspector();
    if (focusKey) {
      const el = root.querySelectorAll(`[data-k="${focusKey}"]`)[focusIdx];
      if (el && el !== document.activeElement) el.focus({ preventScroll: true });
      focusKey = null;
    }
  });

  // hover / focus -> inspector and highlight everywhere the item appears
  const setHot = (k) => {
    if (hot === k) return;
    hot = k;
    for (const el of root.querySelectorAll('.gc-hot')) el.classList.remove('gc-hot');
    if (k) for (const el of root.querySelectorAll(`[data-k="${k}"]`)) el.classList.add('gc-hot');
    showInspector();
  };
  root.addEventListener('pointerover', (e) => { const el = e.target.closest?.('[data-k]'); setHot(el ? el.dataset.k : null); });
  root.addEventListener('focusin', (e) => { const el = e.target.closest?.('[data-k]'); if (el) setHot(el.dataset.k); });

  function showInspector() {
    const it = hot && item(hot);
    if (!it) {
      inspector.replaceChildren(h('span', { class: 'gc-insp-k' }, 'Point at a sheet or a tag'), ' to see what the fab does without it.');
      return;
    }
    const state = !it.live ? 'n/a' : it.done ? 'in the zip' : it.blocker ? 'open, blocks the order' : 'open';
    inspector.replaceChildren(
      h('span', { class: `gc-state gc-s-${!it.live ? 'na' : it.done ? 'done' : it.blocker ? 'block' : 'open'}` }, state),
      h('b', {}, `${it.group}: ${it.what}. `), h('span', {}, it.why));
  }

  // ---------- stack drawing ----------
  function sheetsFor(layers, asm) {
    const s = [];
    s.push({ id: 'silkT', key: 'l_silk', kind: 'silk', name: 'Top silkscreen', file: 'F_Silkscreen.gbr' });
    if (asm) s.push({ id: 'pasteT', key: 'l_paste', kind: 'paste', name: 'Top paste', file: 'F_Paste.gbr' });
    s.push({ id: 'maskT', key: 'l_mask', kind: 'mask', name: 'Top solder mask', file: 'F_Mask.gbr' });
    s.push({ id: 'cuT', key: 'l_cu', kind: 'cu', name: 'Top copper', file: 'F_Cu.gbr' });
    const n = layers === '2' ? 0 : layers === '4' ? 2 : 4;
    for (let i = 1; i <= n; i++) s.push({ id: `in${i}`, key: 'l_inner', kind: i % 2 ? 'plane' : 'cuIn', name: `Inner ${i}${i % 2 ? ', plane' : ''}`, file: `In${i}_Cu.gbr` });
    s.push({ id: 'cuB', key: 'l_cu', kind: 'cu', name: 'Bottom copper', file: 'B_Cu.gbr', flip: true });
    s.push({ id: 'maskB', key: 'l_mask', kind: 'mask', name: 'Bottom solder mask', file: 'B_Mask.gbr' });
    if (asm) s.push({ id: 'pasteB', key: 'l_paste', kind: 'paste', name: 'Bottom paste', file: 'B_Paste.gbr', flip: true });
    s.push({ id: 'silkB', key: 'l_silk', kind: 'silk', name: 'Bottom silkscreen', file: 'B_Silkscreen.gbr', flip: true });
    s.push({ id: 'outline', key: 'l_outline', kind: 'outline', name: 'Board outline', file: 'Edge_Cuts.gbr' });
    s.push({ id: 'drill', key: 'd_pth', kind: 'drill', name: 'Drills, plated', file: 'PTH.drl' });
    return s;
  }

  function drawStack() {
    if (!C) return;
    const W = box.clientWidth, H = box.clientHeight;
    if (W < 40 || H < 40) return;
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const raw = ctx.raw;
    const sheets = sheetsFor(String(raw.layers), !!raw.asm);
    const narrow = W < 560;
    const labelW = narrow ? 0 : 250;
    const topPad = narrow ? 64 : 44, botPad = narrow ? 70 : 60;
    // as wide as the room allows, but narrow enough that each sheet shows ~40 % of its depth
    const wFit = (H - topPad - botPad) / (1 + 0.4 * (sheets.length - 1)) / 0.2;
    const w = clamp(Math.min((W - labelW - 40) / 1.3, wFit), narrow ? 120 : 170, 460);
    const dx = w * 0.3, dy = w * 0.2;
    const n = sheets.length;
    const gap = clamp((H - topPad - botPad - dy) / Math.max(1, n - 1), 14, 62);
    const yOff = Math.max(0, (H - topPad - botPad - dy - gap * (n - 1)) / 2);
    const x0 = narrow ? Math.max(12, (W - w - dx) / 2) : Math.max(18, (W - labelW - (w + dx)) / 2);
    const aligned = !!raw.f_origin;
    const named = !!raw.f_names;
    const sx = w / 100, sd = dy / 60, kx = dx / 60;
    // registration: out of register until the files share one origin
    const jitter = (i) => (aligned ? [0, 0] : [Math.sin(i * 2.3 + 1) * 9, Math.cos(i * 1.7) * 4]);
    const origin = (i) => { const [jx, jy] = jitter(i); return [x0 + jx, topPad + yOff + dy + i * gap + jy]; };
    const M = (i) => { const [ox, oy] = origin(i); return `matrix(${sx} 0 ${kx} ${-sd} ${ox} ${oy})`; };
    const corners = (i) => { const [ox, oy] = origin(i); return [[ox, oy], [ox + w, oy], [ox + w + dx, oy - dy], [ox + dx, oy - dy]]; };
    const pts = (c) => c.map((p) => p.join(',')).join(' ');

    // format tags over the stack
    flow([['f_x2', 'RS-274X / X2'], ['f_origin', 'one origin'], ['f_names', 'named / .gbrjob']], narrow ? 10 : x0, 20, false);
    // registration guide through the front-left corners
    const guide = sheets.map((_, i) => origin(i));
    sv(svg, 'path', { d: guide.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(''), class: `gc-reg-line${aligned ? '' : ' gc-reg-off'}`, 'data-k': 'f_origin' });

    // draw bottom-up so upper sheets overlap lower ones
    for (let i = n - 1; i >= 0; i--) {
      const s = sheets[i];
      const it = item(s.key);
      const done = !!it?.done;
      const bad = !done && it?.blocker;
      const first = sheets.findIndex((q) => q.key === s.key) === i;
      const g = sv(svg, 'g', { class: `gc-sheet gc-k-${s.kind}${done ? ' gc-in' : ' gc-out'}${bad ? ' gc-block' : ''}`, 'data-k': s.key,
        tabindex: first ? '0' : '-1', role: 'checkbox', 'aria-checked': String(done), 'aria-label': `${s.name}: ${it?.what || ''}` });
      g.addEventListener('click', () => toggle(s.key));
      g.addEventListener('keydown', (e) => keyToggle(e, s.key));
      const c = corners(i);
      sv(g, 'polygon', { points: pts(c), class: 'gc-base' });
      if (done) {
        const b = sv(g, 'g', { transform: M(i) });
        drawContent(b, s, raw);
      } else {
        const b = sv(g, 'g', { transform: M(i), class: 'gc-ghost' });
        if (s.kind === 'outline') sv(b, 'path', { d: OPEN_CUT, 'vector-effect': 'non-scaling-stroke', class: 'gc-ol-open' });
        else drawContent(sv(b, 'g', { class: 'gc-faint' }), s, raw);
      }
      // label at the right of the sheet
      if (!narrow) {
        const lx = c[2][0] + 14, ly = c[1][1] - dy * 0.5 + 4;
        sv(g, 'line', { x1: c[1][0] + dx * 0.5 + 3, x2: lx - 4, y1: ly - 4, y2: ly - 4, class: 'gc-lead' });
        const t = sv(g, 'text', { x: lx, y: ly, class: 'gc-lab' });
        sv(t, 'tspan', { class: 'gc-lab-n' }, s.name);
        sv(t, 'tspan', { class: `gc-lab-f${named ? '' : ' gc-unnamed'}`, dx: 8 }, done ? (named ? s.file : `gerber_${String(i + 1).padStart(2, '0')}.gbr`) : bad ? 'missing, blocks the order' : 'missing');
      }
    }
    // tags on the outline and drill sheets
    const iOut = sheets.findIndex((s) => s.id === 'outline'), iDr = sheets.findIndex((s) => s.id === 'drill');
    {
      // on the outline sheet itself, next to the slot
      const [ox, oy] = origin(iOut);
      chip(svg, ox + w * 0.06 + dx * 0.35, oy - dy * 0.3, narrow ? 'cut-outs here' : 'cut-outs on this layer', 'l_cutouts', true);
    }
    {
      // under the drill sheet
      const [, oy] = origin(iDr);
      flow([['d_npth', 'NPTH separate'], ['d_slots', 'slots routed'], ['d_units', 'units match'], ['d_map', 'drill table']], narrow ? 10 : x0, oy + 22, true, 'drill file:');
    }

    function flow(list, ax, ay, small, head) {
      let cx = ax;
      if (head && !narrow) { sv(svg, 'text', { x: cx, y: ay + 1, class: 'gc-lab-f' }, head); cx += head.length * 6.6 + 8; }
      const left = cx;
      for (const [k, t] of list) {
        const wd = t.length * (small ? 6.6 : 7) + 22;
        if (cx + wd > W - 6 && cx > left) { cx = left; ay += 23; }
        cx += chip(svg, cx, ay, t, k, small) + 6;
      }
    }
  }

  function chip(parent, x, y, text, k, small = false) {
    const it = item(k);
    const done = !!it?.done, live = it ? it.live : true;
    const w = text.length * 7.1 + 22;
    const g = sv(parent, 'g', { class: `gc-chip${done ? ' gc-in' : ''}${!live ? ' gc-na' : ''}${!done && it?.blocker ? ' gc-block' : ''}`, 'data-k': k,
      tabindex: '0', role: 'checkbox', 'aria-checked': String(done), 'aria-label': it?.what || text });
    sv(g, 'rect', { x, y: y - 13, width: w, height: 19, rx: 4 });
    sv(g, 'text', { x: x + 7, y: y + 1, class: 'gc-chip-m' }, done ? '✓' : '○');
    sv(g, 'text', { x: x + 19, y: y + 1, class: 'gc-chip-t' }, text);
    g.addEventListener('click', () => toggle(k));
    g.addEventListener('keydown', (e) => keyToggle(e, k));
    return w;
  }

  function drawContent(b, s, raw) {
    const ns = { 'vector-effect': 'non-scaling-stroke' };
    const flipX = (x) => (s.flip ? 100 - x : x);
    const pads = (cls, grow = 0) => PADS.forEach(([x, y, pw, ph]) => sv(b, 'rect', { x: flipX(x) - pw / 2 - grow, y: y - ph / 2 - grow, width: pw + 2 * grow, height: ph + 2 * grow, class: cls }));
    switch (s.kind) {
      case 'silk': {
        sv(b, 'rect', { x: 28, y: 16, width: 28, height: 28, class: 'gc-silk', ...ns, fill: 'none' });
        sv(b, 'circle', { cx: flipX(31), cy: 19, r: 1.2, class: 'gc-silk-f' });
        sv(b, 'rect', { x: flipX(s.flip ? 94 : 84) - (s.flip ? 0 : 0), y: 8, width: 10, height: 44, class: 'gc-silk', ...ns, fill: 'none' });
        for (const [x, y, t] of [[39, 12, 'U1'], [14, 22, 'R1'], [14, 40, 'C1'], [80, 56, 'J1'], [4, 30, 'REV B']]) {
          sv(b, 'rect', { x: flipX(x) - (s.flip ? t.length * 2.6 : 0), y: y - 2.4, width: t.length * 2.6, height: 3.2, class: 'gc-silk-f' });
        }
        break;
      }
      case 'mask':
        sv(b, 'path', { d: CUT, class: 'gc-mask' });
        pads('gc-mask-open', 0.6);
        VIAS.forEach(([x, y]) => sv(b, 'circle', { cx: flipX(x), cy: y, r: 1.4, class: 'gc-mask-open' }));
        break;
      case 'paste':
        PADS.forEach(([x, y, pw, ph]) => sv(b, 'rect', { x: flipX(x) - pw * 0.4, y: y - ph * 0.4, width: pw * 0.8, height: ph * 0.8, class: 'gc-paste' }));
        break;
      case 'cu': case 'cuIn':
        for (const d of TRACES) sv(b, 'path', { d, class: 'gc-trace', transform: s.flip ? 'matrix(-1 0 0 1 100 0)' : null, ...ns });
        if (s.kind === 'cu') pads('gc-pad');
        VIAS.forEach(([x, y]) => { sv(b, 'circle', { cx: flipX(x), cy: y, r: 1.6, class: 'gc-pad' }); sv(b, 'circle', { cx: flipX(x), cy: y, r: 0.7, class: 'gc-hole' }); });
        break;
      case 'plane':
        sv(b, 'rect', { x: 2, y: 2, width: 96, height: 56, rx: 3, class: 'gc-plane' });
        VIAS.forEach(([x, y]) => sv(b, 'circle', { cx: x, cy: y, r: 2.4, class: 'gc-hole' }));
        HOLES.forEach(([x, y]) => sv(b, 'circle', { cx: x, cy: y, r: 3.6, class: 'gc-hole' }));
        break;
      case 'outline':
        sv(b, 'path', { d: CUT, class: 'gc-ol', ...ns });
        if (raw.l_cutouts) sv(b, 'rect', { x: SLOT[0], y: SLOT[1], width: SLOT[2], height: SLOT[3], rx: 2.5, class: 'gc-ol', ...ns });
        else sv(b, 'rect', { x: SLOT[0], y: SLOT[1], width: SLOT[2], height: SLOT[3], rx: 2.5, class: 'gc-ol-open', ...ns });
        break;
      case 'drill':
        VIAS.forEach(([x, y]) => sv(b, 'circle', { cx: x, cy: y, r: 1.1, class: 'gc-drill' }));
        PADS.slice(-6).forEach(([x, y]) => sv(b, 'circle', { cx: x, cy: y, r: 1.3, class: 'gc-drill' }));
        HOLES.forEach(([x, y]) => sv(b, 'circle', { cx: x, cy: y, r: 2.6, class: raw.d_npth ? 'gc-npth' : 'gc-drill gc-wrong', ...ns }));
        if (raw.d_slots) sv(b, 'rect', { x: 8, y: 26, width: 10, height: 3, rx: 1.5, class: 'gc-drill' });
        else [9.5, 12, 14.5, 17].forEach((x) => sv(b, 'circle', { cx: x, cy: 27.5, r: 1.4, class: 'gc-drill gc-wrong', ...ns }));
        break;
      default:
    }
  }

  // ---------- documents ----------
  function docBtn(k, cls, kids, label) {
    const it = item(k);
    const b = h('button', { type: 'button', class: `${cls}${it?.done ? ' gc-in' : ''}${it && !it.live ? ' gc-na' : ''}`, 'data-k': k, role: 'checkbox',
      'aria-checked': String(!!it?.done), 'aria-label': label || it?.what, title: it?.what, onclick: () => toggle(k) }, kids);
    return b;
  }
  function drawDocs() {
    if (!C) return;
    const raw = ctx.raw;
    const cards = [];
    // fab notes as a notes block on the fab drawing
    const noteKeys = Object.keys(NOTE_TEXT);
    const notes = h('ol', { class: 'gc-notes' }, noteKeys.map((k, i) => {
      const it = item(k);
      const [lab, val] = NOTE_TEXT[k];
      return h('li', {}, docBtn(k, 'gc-note', [
        h('span', { class: 'gc-note-n' }, `${i + 1}.`),
        h('span', { class: 'gc-note-l' }, lab.toUpperCase()),
        h('span', { class: 'gc-note-v' }, !it?.live ? 'n/a on 2 layers' : it.done ? val : '')]));
    }));
    const nDone = noteKeys.filter((k) => item(k)?.done && item(k)?.live).length, nLive = noteKeys.filter((k) => item(k)?.live).length;
    cards.push(h('div', { class: 'gc-card gc-paper' },
      h('div', { class: 'gc-head' }, h('span', { class: 'gc-cap' }, 'Fab drawing, notes'), h('span', { class: 'gc-hint' }, `${nDone} / ${nLive}`)),
      notes,
      h('div', { class: 'gc-titleblock' }, h('span', {}, 'FAB DRAWING'), h('span', {}, 'REV B'), h('span', {}, 'SHEET 1/1'))));

    // netlist + assembly files as documents
    const mini = (kind) => {
      const s = sv(null, 'svg', { viewBox: '0 0 60 40', 'aria-hidden': 'true' });
      if (kind === 'net') for (let i = 0; i < 6; i++) sv(s, 'rect', { x: 6, y: 6 + i * 5.2, width: 20 + ((i * 17) % 26), height: 2.2, class: 'gc-ink' });
      if (kind === 'bom') for (let i = 0; i < 6; i++) { sv(s, 'rect', { x: 5, y: 5 + i * 5.4, width: 10, height: 2.4, class: 'gc-ink' }); sv(s, 'rect', { x: 18, y: 5 + i * 5.4, width: 22, height: 2.4, class: 'gc-ink' }); sv(s, 'rect', { x: 44, y: 5 + i * 5.4, width: 10, height: 2.4, class: 'gc-ink' }); }
      if (kind === 'cpl') for (let i = 0; i < 6; i++) [5, 17, 29, 41, 51].forEach((x) => sv(s, 'rect', { x, y: 5 + i * 5.4, width: 8, height: 2.4, class: 'gc-ink' }));
      if (kind === 'draw') {
        sv(s, 'rect', { x: 6, y: 5, width: 48, height: 30, rx: 2, class: 'gc-ink-o' });
        sv(s, 'rect', { x: 22, y: 12, width: 14, height: 14, class: 'gc-ink-o' });
        sv(s, 'circle', { cx: 24.5, cy: 14.5, r: 1.2, class: 'gc-ink' });
        sv(s, 'path', { d: 'M10 30 l4 -3 v6 z M14 27 v6', class: 'gc-ink-o' });
      }
      return s;
    };
    const tile = (k, kind, name, file) => docBtn(k, 'gc-doc', [mini(kind), h('b', {}, name), h('span', {}, file)]);
    cards.push(h('div', { class: 'gc-card' },
      h('div', { class: 'gc-head' }, h('span', { class: 'gc-cap' }, 'Test and assembly files'), h('span', { class: 'gc-hint' }, raw.asm ? '' : 'assembly off')),
      h('div', { class: 'gc-docrow' },
        tile('f_netlist', 'net', 'Netlist', 'board.ipc'),
        tile('a_bom', 'bom', 'BOM + MPN', 'bom.csv'),
        tile('a_cpl', 'cpl', 'Pick & place', 'pos.csv'),
        tile('a_draw', 'draw', 'Assembly dwg', 'assy.pdf'))));

    // the panel
    const pan = sv(null, 'svg', { viewBox: '0 0 240 120', class: 'gc-panel-svg', role: 'group', 'aria-label': 'Panel' });
    const pOn = !!raw.panel;
    const hitG = (k) => {
      const it = item(k);
      const g = sv(pan, 'g', { class: `gc-pf${it?.done ? ' gc-in' : ''}`, 'data-k': k, tabindex: pOn ? '0' : '-1', role: 'checkbox', 'aria-checked': String(!!it?.done), 'aria-label': it?.what });
      g.addEventListener('click', () => pOn && toggle(k));
      g.addEventListener('keydown', (e) => pOn && keyToggle(e, k));
      return g;
    };
    sv(pan, 'rect', { x: 4, y: 4, width: 232, height: 112, rx: 3, class: 'gc-p-frame' });
    const boards = [[26, 22], [126, 22], [26, 64], [126, 64]];
    for (const [x, y] of boards) sv(pan, 'rect', { x, y, width: 88, height: 36, rx: 3, class: 'gc-p-board' });
    const gd = hitG('p_drawing');
    sv(gd, 'rect', { x: 20, y: 104, width: 200, height: 14, class: 'gc-hit' });
    sv(gd, 'path', { d: 'M26 110 H214 M26 106 V114 M214 106 V114', class: 'gc-p-dim' });
    sv(gd, 'text', { x: 120, y: 108, 'text-anchor': 'middle', class: 'gc-p-t' }, '2 × 2, 200 mm');
    const gs = hitG('p_sep');
    sv(gs, 'rect', { x: 110, y: 12, width: 20, height: 96, class: 'gc-hit' });
    sv(gs, 'path', { d: 'M120 14 V106 M22 61 H218', class: 'gc-p-vs' });
    const gf = hitG('p_fid');
    sv(gf, 'rect', { x: 4, y: 4, width: 18, height: 112, class: 'gc-hit' });
    sv(gf, 'rect', { x: 218, y: 4, width: 18, height: 112, class: 'gc-hit' });
    for (const [x, y] of [[13, 16], [227, 16], [13, 104]]) sv(gf, 'circle', { cx: x, cy: y, r: 3, class: 'gc-p-fid' });
    for (const [x, y] of [[13, 60], [227, 60]]) sv(gf, 'circle', { cx: x, cy: y, r: 3.5, class: 'gc-p-tool' });
    const pDone = ['p_drawing', 'p_sep', 'p_fid'].filter((k) => item(k)?.done).length;
    cards.push(h('div', { class: `gc-card gc-panel${pOn ? '' : ' gc-na'}` },
      h('div', { class: 'gc-head' }, h('span', { class: 'gc-cap' }, 'Panel drawing'), h('span', { class: 'gc-hint' }, pOn ? `${pDone} / 3 · click the dimension, the V-score, the rails` : 'the fab panels it: switch on "I supply the panel"')),
      pan));

    // final checks
    cards.push(h('div', { class: 'gc-card gc-final' },
      h('div', { class: 'gc-head' }, h('span', { class: 'gc-cap' }, 'Before it goes'), h('span', { class: 'gc-hint' }, 'board-rev-B.zip')),
      h('div', { class: 'gc-stamps' },
        [['v_view', 'Looked at every layer in a Gerber viewer'], ['v_drc', 'DRC clean against this fab'], ['v_rev', 'One zip, latest rev on silk and name']]
          .map(([k, t]) => docBtn(k, 'gc-stamp', [h('i', {}), h('span', {}, t)])))));
    docs.replaceChildren(...cards);
    if (hot) for (const el of docs.querySelectorAll(`[data-k="${hot}"]`)) el.classList.add('gc-hot');
  }

  // ---------- progress and to-do ----------
  function drawTodo() {
    if (!C) return;
    const tone = C.pct === 100 ? 'ok' : C.blockers.length ? 'bad' : 'warn';
    prog.replaceChildren(
      h('div', { class: 'gc-prog-row' },
        h('b', { class: `gc-pct gc-t-${tone}` }, `${C.pct} %`),
        h('span', {}, `${C.done} of ${C.live} in the zip`, h('br'), h('small', {}, C.skipped ? `${C.skipped} not needed for this board` : 'every item applies'))),
      h('div', { class: 'gc-bar' }, h('i', { class: `gc-t-${tone}`, style: `width:${C.pct}%` })),
      C.blockers.length
        ? h('div', { class: 'gc-verdict gc-t-bad' }, `Not ready: ${C.blockers.length} open item${C.blockers.length > 1 ? 's' : ''} make a scrap board or a held order.`)
        : C.open ? h('div', { class: 'gc-verdict gc-t-warn' }, `No blockers; ${C.open} item${C.open > 1 ? 's' : ''} still open.`)
          : h('div', { class: 'gc-verdict gc-t-ok' }, 'Ready to send.'));
    const open = C.items.filter((it) => it.live && !it.done).sort((a, b) => Number(b.blocker) - Number(a.blocker));
    todo.replaceChildren(...open.map((it) => h('div', { role: 'listitem' },
      h('button', { type: 'button', class: `gc-row${it.blocker ? ' gc-block' : ''}`, 'data-k': it.key, title: it.why,
        'aria-label': `Mark done: ${it.what}`, onclick: () => toggle(it.key) },
      h('i', {}), h('span', { class: 'gc-row-g' }, it.group), h('span', { class: 'gc-row-t' }, it.what)))));
    if (!open.length) todo.append(h('div', { class: 'gc-empty' }, 'Nothing open.'));
    if (hot) for (const el of todo.querySelectorAll(`[data-k="${hot}"]`)) el.classList.add('gc-hot');
  }
}
