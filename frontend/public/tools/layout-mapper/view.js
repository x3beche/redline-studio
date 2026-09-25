// Layout Inspector Mapper: the page is the screen as the dump sees it.
//   Screen    - every node of the uiautomator dump drawn at its bounds (over
//               your screenshot, if you drop one in). Click to point, drag to
//               move the point; in Rectangle mode drag a box. The matched view
//               is filled, its parents outlined, the tap target ringed with
//               its tap point. Arrow keys move the point (Shift ×10, Alt
//               resizes the box).
//   Hierarchy - the whole tree, the matched chain marked; hover a row to see
//               it on the screen, click it to point at its centre.
//   Locators  - the selectors run() found, grouped by strategy, each with its
//               uniqueness and a Copy; the adb tap; the dump itself; then the
//               output panel.
// Every number shown comes from run()'s result (values, tables, texts, view).

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
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.append(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  const was = btn.textContent; btn.textContent = ok ? 'Copied' : 'Select it';
  setTimeout(() => { btn.textContent = was; }, 1200);
}

export function page(root, ctx) {
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = new URL('style.css', import.meta.url).href;
  document.head.append(link);

  let res = null, hover = null, shotUrl = null, shotSize = null;

  // ---------------- screen ----------------
  const modeSeg = h('div', { class: 'lm-seg', role: 'group', 'aria-label': 'Pick by' },
    h('button', { type: 'button', 'data-m': 'point', onclick: () => setMode('point') }, 'Point'),
    h('button', { type: 'button', 'data-m': 'rect', onclick: () => setMode('rect') }, 'Rectangle'));
  const fileIn = h('input', { type: 'file', accept: 'image/*,.xml,text/xml', hidden: true, onchange: (e) => { for (const f of e.target.files) loadFile(f); e.target.value = ''; } });
  const shotBtn = h('button', { type: 'button', class: 'lm-btn', onclick: () => fileIn.click(), title: 'A screenshot of the same screen goes under the views; an .xml file replaces the dump' }, 'Screenshot…');
  const clearShot = h('button', { type: 'button', class: 'lm-btn', hidden: true, onclick: () => {
    if (shotUrl) URL.revokeObjectURL(shotUrl);
    shotUrl = null; shotSize = null;
    const v = V(), raw = ctx.raw, f = v ? v.scale : 1;
    const k = (key) => String(Math.round(Number(raw[key] || 0) * f));
    ctx.setMany({ shotWidth: '', x: k('x'), y: k('y'), w: k('w'), h: k('h') });
  } }, 'Remove screenshot');
  const fx = h('input', { class: 'lm-num', inputmode: 'numeric', 'aria-label': 'X in screenshot px', oninput: (e) => ctx.set('x', e.target.value) });
  const fy = h('input', { class: 'lm-num', inputmode: 'numeric', 'aria-label': 'Y in screenshot px', oninput: (e) => ctx.set('y', e.target.value) });
  const fw = h('input', { class: 'lm-num', inputmode: 'numeric', 'aria-label': 'Width in screenshot px, 0 for a point', oninput: (e) => ctx.set('w', e.target.value) });
  const fh = h('input', { class: 'lm-num', inputmode: 'numeric', 'aria-label': 'Height in screenshot px, 0 for a point', oninput: (e) => ctx.set('h', e.target.value) });
  const fsw = h('input', { class: 'lm-num', inputmode: 'numeric', placeholder: 'same', 'aria-label': 'Screenshot width in px (empty: same as the device)', oninput: (e) => ctx.set('shotWidth', e.target.value) });
  const whBox = h('span', { class: 'lm-wh' }, h('i', {}, 'w'), fw, h('i', {}, 'h'), fh);
  const coords = h('div', { class: 'lm-coords' },
    h('label', {}, h('i', {}, 'x'), fx), h('label', {}, h('i', {}, 'y'), fy), whBox,
    h('label', { title: 'Only when the screenshot was resized: its width in pixels' }, h('i', {}, 'shot width'), fsw));
  const svg = sv('svg', { class: 'lm-screen', tabindex: '0', role: 'application',
    'aria-label': 'The screen. Click to point, drag to move; arrow keys move the point, Shift for 10 px, Alt resizes the rectangle.' });
  const hoverTag = h('div', { class: 'lm-hovertag', 'aria-hidden': 'true' });
  const screenHead = h('div', { class: 'lm-shead' });
  const screenPanel = h('section', { class: 'lm-panel lm-screen-panel' },
    h('div', { class: 'lm-phead' }, h('span', { class: 'lm-h' }, 'Screen'), modeSeg, shotBtn, clearShot, fileIn),
    screenHead,
    h('div', { class: 'lm-screen-wrap' }, svg, hoverTag),
    coords,
    h('div', { class: 'lm-hint' }, 'Coordinates are screenshot pixels. Drop a screenshot or a window_dump.xml on the screen.'));

  // ---------------- hierarchy ----------------
  const tree = h('div', { class: 'lm-tree', role: 'list' });
  const treeHead = h('span', { class: 'lm-sub' });
  const treePanel = h('section', { class: 'lm-panel lm-tree-panel' },
    h('div', { class: 'lm-phead' }, h('span', { class: 'lm-h' }, 'Hierarchy'), treeHead), tree,
    h('div', { class: 'lm-legend' },
      h('span', {}, h('i', { class: 'lm-sw lm-sw-best' }), 'matched'), h('span', {}, h('i', { class: 'lm-sw lm-sw-chain' }), 'its parents'),
      h('span', {}, h('b', { class: 'lm-tap' }, 'TAP'), 'tap target'), h('span', {}, h('b', { class: 'lm-clk' }, 'c'), 'clickable')));

  // ---------------- locators ----------------
  const match = h('div', { class: 'lm-match' });
  const warns = h('div', { class: 'lm-warns' });
  const sels = h('div', { class: 'lm-sels' });
  const dumpTa = h('textarea', { class: 'lm-dump', rows: 10, spellcheck: 'false', 'aria-label': 'uiautomator dump XML', oninput: (e) => ctx.set('dump', e.target.value) });
  const dumpBox = h('details', { class: 'lm-panel lm-dumpbox' }, h('summary', {}, 'Dump XML'),
    h('div', { class: 'lm-sub' }, 'adb shell uiautomator dump /sdcard/window_dump.xml, then adb pull /sdcard/window_dump.xml and paste it here (or drop the file on the screen).'), dumpTa);
  const notes = h('div', { class: 'lm-notes' });
  const locPanel = h('section', { class: 'lm-panel' }, h('div', { class: 'lm-phead' }, h('span', { class: 'lm-h' }, 'Locators for the tap target')), sels);

  root.classList.add('lm-root');
  root.append(h('div', { class: 'lm' },
    screenPanel,
    treePanel,
    h('div', { class: 'lm-side' }, match, warns, locPanel, dumpBox, ctx.outputs, notes)));

  // ---------------- input helpers ----------------
  const V = () => res?.view;
  const toShot = (d) => Math.round(d / (V()?.scale || 1));
  function setMode(m) {
    const v = V();
    if (m === 'point') {
      if (Number(ctx.raw.w) > 0 || Number(ctx.raw.h) > 0) {
        const r = v?.rect;
        ctx.setMany(r ? { x: String(toShot((r.x1 + r.x2) / 2)), y: String(toShot((r.y1 + r.y2) / 2)), w: '0', h: '0' } : { w: '0', h: '0' });
      }
    } else if (!(Number(ctx.raw.w) > 0 && Number(ctx.raw.h) > 0)) {
      const n = v && v.best != null ? v.nodes[v.best] : null;
      if (n) ctx.setMany({ x: String(toShot(n.x1)), y: String(toShot(n.y1)), w: String(toShot(n.x2 - n.x1)), h: String(toShot(n.y2 - n.y1)) });
      else ctx.setMany({ w: '100', h: '60' });
    }
  }
  function loadFile(f) {
    if (/xml/i.test(f.type) || /\.xml$/i.test(f.name)) { f.text().then((t) => ctx.set('dump', t)); return; }
    if (!/^image\//.test(f.type)) return;
    if (shotUrl) URL.revokeObjectURL(shotUrl);
    shotUrl = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      shotSize = [img.naturalWidth, img.naturalHeight];
      // keep the pick on the same place of the screen: its numbers are screenshot pixels
      const v = V(), raw = ctx.raw;
      const f = v ? v.scale / (v.devW / img.naturalWidth) : 1;
      const k = (key) => String(Math.round(Number(raw[key] || 0) * f));
      ctx.setMany({ shotWidth: String(img.naturalWidth), x: k('x'), y: k('y'), w: k('w'), h: k('h') });
    };
    img.src = shotUrl;
  }
  root.addEventListener('dragover', (e) => { if (e.target.closest('.lm-screen-wrap')) { e.preventDefault(); svg.classList.add('lm-drop'); } });
  root.addEventListener('dragleave', () => svg.classList.remove('lm-drop'));
  root.addEventListener('drop', (e) => {
    if (!e.target.closest('.lm-screen-wrap')) return;
    e.preventDefault(); svg.classList.remove('lm-drop');
    for (const f of e.dataTransfer.files) loadFile(f);
  });

  // ---------------- draw: screen ----------------
  const label = (n) => n.text || n.desc || '';
  const nameOf = (n) => `${n.cls}${n.id ? '#' + n.id : ''}`;
  function screenDraw() {
    svg.replaceChildren();
    const v = V();
    if (!v) {
      svg.setAttribute('viewBox', '0 0 360 640');
      svg.append(sv('rect', { x: 0, y: 0, width: 360, height: 640, class: 'lm-bg' }));
      const t = (res?.warnings || ['Paste a dump.'])[0];
      const fo = sv('foreignObject', { x: 20, y: 260, width: 320, height: 200 });
      fo.append(h('div', { class: 'lm-empty' }, t)); svg.append(fo);
      return;
    }
    const W = v.devW, H = v.devH, u = W / 360;          // u: one "css px" of a 360-wide drawing
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.append(sv('rect', { x: 0, y: 0, width: W, height: H, class: 'lm-bg' }));
    if (shotUrl) svg.append(sv('image', { href: shotUrl, x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none', class: 'lm-shot' }));
    const inChain = new Set(v.chain);
    const gNodes = sv('g', { class: shotUrl ? 'lm-nodes lm-over' : 'lm-nodes' });
    for (const n of v.nodes) {
      if (n.x2 == null || n.x2 <= n.x1 || n.y2 <= n.y1) continue;
      const whole = (n.x2 - n.x1) * (n.y2 - n.y1) >= 0.9 * W * H;   // a full-screen frame: outlining it says nothing
      const cls = ['lm-node', `lm-d${Math.min(n.depth, 6)}`, n.clickable ? 'lm-n-clk' : '', inChain.has(n.i) && !whole ? 'lm-n-chain' : '', n.i === v.best ? 'lm-n-best' : ''].join(' ');
      gNodes.append(sv('rect', { x: n.x1, y: n.y1, width: n.x2 - n.x1, height: n.y2 - n.y1, class: cls, 'vector-effect': 'non-scaling-stroke' }));
    }
    svg.append(gNodes);
    // labels of views with text, and ids of leaf-ish views
    const gT = sv('g', { class: 'lm-labels' });
    for (const n of v.nodes) {
      if (n.x2 == null) continue;
      const t = label(n);
      const bw = n.x2 - n.x1, bh = n.y2 - n.y1;
      if (t && bh >= 9 * u) {
        const fs = Math.min(bh * 0.5, 13 * u);
        gT.append(sv('text', { x: n.x1 + 5 * u, y: n.y1 + bh / 2 + fs * 0.35, 'font-size': fs, class: 'lm-t' }, clip(t, Math.max(3, Math.floor(bw / (fs * 0.55))))));
      } else if (n.id && !t && bh >= 14 * u && bw >= 40 * u && !v.nodes.some((c) => c.parent === n.i && label(c))) {
        gT.append(sv('text', { x: n.x1 + 4 * u, y: n.y1 + 10 * u, 'font-size': 8 * u, class: 'lm-idt' }, clip('#' + n.id, Math.floor(bw / (4.6 * u)))));
      }
    }
    svg.append(gT);
    // the picked point or rectangle
    const R = v.rect;
    const gP = sv('g', { class: 'lm-pick' });
    if (v.isPoint) {
      const r = 9 * u;
      gP.append(sv('line', { x1: R.x1 - 2.2 * r, x2: R.x1 + 2.2 * r, y1: R.y1, y2: R.y1, 'vector-effect': 'non-scaling-stroke' }),
        sv('line', { x1: R.x1, x2: R.x1, y1: R.y1 - 2.2 * r, y2: R.y1 + 2.2 * r, 'vector-effect': 'non-scaling-stroke' }),
        sv('circle', { cx: R.x1, cy: R.y1, r, 'vector-effect': 'non-scaling-stroke' }));
    } else {
      gP.append(sv('rect', { x: R.x1, y: R.y1, width: R.x2 - R.x1, height: R.y2 - R.y1, class: 'lm-pickbox', 'vector-effect': 'non-scaling-stroke' }));
      const cand = v.candidates[0];
      if (cand) gP.append(sv('text', { x: R.x1, y: R.y1 - 5 * u, 'font-size': 11 * u, class: 'lm-pick-t' }, `IoU ${Math.round(cand.score * 100)} %`));
    }
    svg.append(gP);
    // the tap target and where a tap lands
    if (v.act != null && v.tap) {
      const a = v.nodes[v.act];
      const g = sv('g', { class: 'lm-act' });
      g.append(sv('rect', { x: a.x1, y: a.y1, width: a.x2 - a.x1, height: a.y2 - a.y1, 'vector-effect': 'non-scaling-stroke' }));
      g.append(sv('circle', { cx: v.tap.x, cy: v.tap.y, r: 4 * u, class: 'lm-tapdot' }));
      const ty = a.y2 + 14 * u < H ? a.y2 + 13 * u : a.y1 - 5 * u;
      g.append(sv('text', { x: a.x1 + 2 * u, y: ty, 'font-size': 10.5 * u, class: 'lm-act-t' }, `tap ${v.tap.x}, ${v.tap.y} · ${clip(nameOf(a), 34)}`));
      svg.append(g);
    }
    // the hovered node
    if (hover != null && v.nodes[hover]?.x2 != null) {
      const n = v.nodes[hover];
      svg.append(sv('rect', { x: n.x1, y: n.y1, width: n.x2 - n.x1, height: n.y2 - n.y1, class: 'lm-hover', 'vector-effect': 'non-scaling-stroke' }));
    }
    if (v.act == null && v.best != null) {
      const b = v.nodes[v.best];
      svg.append(sv('text', { x: b.x1 + 2 * u, y: Math.min(H - 4 * u, b.y2 + 12 * u), 'font-size': 10.5 * u, class: 'lm-warn-t' }, 'nothing clickable here'));
    }
  }

  // hover tag + pointer on the screen
  const devPoint = (e) => {
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const m = svg.getScreenCTM(); if (!m) return null;
    const p = pt.matrixTransform(m.inverse());
    const v = V(); if (!v) return null;
    return { x: Math.max(0, Math.min(v.devW - 1, p.x)), y: Math.max(0, Math.min(v.devH - 1, p.y)) };
  };
  const innermost = (p) => {
    const v = V(); if (!v) return null;
    let b = null;
    for (const n of v.nodes) if (n.x2 != null && p.x >= n.x1 && p.x < n.x2 && p.y >= n.y1 && p.y < n.y2 && (!b || (n.x2 - n.x1) * (n.y2 - n.y1) <= (b.x2 - b.x1) * (b.y2 - b.y1))) b = n;
    return b;
  };
  const showHover = (i, e) => {
    if (hover === i) { if (e) placeTag(e); return; }
    hover = i; screenDraw(); treeMark();
    const v = V();
    if (i == null || !v) { hoverTag.hidden = true; return; }
    const n = v.nodes[i];
    hoverTag.hidden = false;
    hoverTag.replaceChildren(h('b', {}, nameOf(n)), label(n) ? h('span', {}, ` "${clip(label(n), 30)}"`) : null, h('small', {}, `[${n.x1},${n.y1}][${n.x2},${n.y2}]${n.clickable ? ' · clickable' : ''}`));
    if (e) placeTag(e);
  };
  const placeTag = (e) => {
    const r = svg.parentElement.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    hoverTag.style.left = `${Math.min(x + 14, r.width - 200)}px`; hoverTag.style.top = `${y + 16}px`;
  };
  let drag = null;
  svg.style.touchAction = 'none';
  svg.addEventListener('pointerdown', (e) => {
    const p = devPoint(e); if (!p) return;
    e.preventDefault(); svg.focus({ preventScroll: true });
    svg.setPointerCapture(e.pointerId);
    const rectMode = Number(ctx.raw.w) > 0 && Number(ctx.raw.h) > 0;
    drag = { rectMode, p0: p };
    if (!rectMode) ctx.setMany({ x: String(toShot(p.x)), y: String(toShot(p.y)) });
  });
  svg.addEventListener('pointermove', (e) => {
    const p = devPoint(e); if (!p) return;
    if (!drag) { const n = innermost(p); showHover(n ? n.i : null, e); return; }
    if (drag.rectMode) {
      const x1 = Math.min(p.x, drag.p0.x), y1 = Math.min(p.y, drag.p0.y);
      const w = Math.abs(p.x - drag.p0.x), hh = Math.abs(p.y - drag.p0.y);
      if (toShot(w) >= 4 && toShot(hh) >= 4) ctx.setMany({ x: String(toShot(x1)), y: String(toShot(y1)), w: String(toShot(w)), h: String(toShot(hh)) });
    } else ctx.setMany({ x: String(toShot(p.x)), y: String(toShot(p.y)) });
  });
  const endDrag = () => { drag = null; };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('pointerleave', () => { if (!drag) showHover(null); });
  svg.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    const st = e.shiftKey ? 10 : 1;
    const raw = ctx.raw;
    if (e.altKey && Number(raw.w) > 0) ctx.setMany({ w: String(Math.max(1, Number(raw.w) + d[0] * st)), h: String(Math.max(1, Number(raw.h) + d[1] * st)) });
    else ctx.setMany({ x: String(Math.max(0, Number(raw.x) + d[0] * st)), y: String(Math.max(0, Number(raw.y) + d[1] * st)) });
  });

  // ---------------- draw: tree ----------------
  function treeDraw() {
    tree.replaceChildren();
    const v = V();
    if (!v) return;
    const inChain = new Set(v.chain);
    const cand = new Map(v.candidates.map((c) => [c.i, c.score]));
    for (const n of v.nodes) {
      const row = h('button', { type: 'button', role: 'listitem', class: ['lm-trow', inChain.has(n.i) ? 'lm-in' : '', n.i === v.best ? 'lm-best' : ''].join(' '),
        'data-i': String(n.i), style: `--d:${n.depth}`, title: n.x2 != null ? `[${n.x1},${n.y1}][${n.x2},${n.y2}] - click to point at its centre` : 'no bounds',
        onclick: () => { if (n.x2 == null) return; ctx.setMany({ x: String(toShot((n.x1 + n.x2) / 2)), y: String(toShot((n.y1 + n.y2) / 2)), w: '0', h: '0' }); },
        onmouseenter: () => showHover(n.i), onmouseleave: () => showHover(null),
        onfocus: () => showHover(n.i), onblur: () => showHover(null) },
      h('span', { class: 'lm-tcls' }, n.cls),
      n.id ? h('span', { class: 'lm-tid' }, '#' + n.id) : null,
      label(n) ? h('span', { class: 'lm-ttxt' }, `"${clip(label(n), 26)}"`) : null,
      h('span', { class: 'lm-tbad' },
        n.i === v.act ? h('b', { class: 'lm-tap' }, 'TAP') : null,
        n.clickable ? h('b', { class: 'lm-clk', title: 'clickable' }, 'c') : null,
        !v.isPoint && cand.has(n.i) ? h('b', { class: 'lm-iou' }, `${Math.round(cand.get(n.i) * 100)}%`) : null));
      tree.append(row);
    }
    treeHead.textContent = `${v.nodes.length} nodes · ${v.chain.length ? `depth ${v.chain.length - 1}` : 'nothing matched'}`;
  }
  function treeMark() {
    for (const r of tree.children) r.classList.toggle('lm-hov', String(hover) === r.dataset.i);
  }

  // ---------------- draw: side ----------------
  function sideDraw() {
    const vals = Object.fromEntries((res?.values || []).map((x) => [x.label, x]));
    const v = V();
    match.replaceChildren();
    if (v && v.best != null) {
      const tapTxt = (res.texts || []).find((t) => t.title === 'adb tap');
      const copyBtn = h('button', { type: 'button', class: 'lm-btn lm-copy' }, 'Copy');
      copyBtn.onclick = () => copyText(tapTxt ? tapTxt.body.trim() : '', copyBtn);
      const m = vals['Matched view'], tt = vals['Tap target'];
      match.append(
        h('div', { class: 'lm-mrow' }, h('span', { class: 'lm-k' }, v.isPoint ? 'Under the point' : 'Best overlap'),
          h('b', {}, m?.value), h('span', { class: 'lm-sub' }, ` ${m?.hint || ''}`),
          h('span', { class: 'lm-bounds' }, vals['Bounds (device px)']?.value)),
        h('div', { class: 'lm-mrow' }, h('span', { class: 'lm-k' }, 'Tap target'),
          h('b', { class: tt?.tone === 'warn' ? 'lm-bad' : 'lm-good' }, tt?.value),
          h('span', { class: 'lm-sub' }, v.isPoint ? ` · ${vals['Views under the point']?.value} views under the point` : ` · IoU ${vals['Overlap (IoU)']?.value}`)),
        tapTxt ? h('div', { class: 'lm-mrow lm-adb' }, h('code', {}, tapTxt.body.trim()), copyBtn) : null);
    }
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    // selectors grouped by strategy
    sels.replaceChildren();
    const t = res?.tables?.[0];
    if (t) {
      const groups = new Map();
      for (const [by, m, fw, code] of t.rows) { if (!groups.has(by)) groups.set(by, { m, rows: [] }); groups.get(by).rows.push([fw, code]); }
      for (const [by, g] of groups) {
        const unique = g.m === 'unique' || g.m === 'by attribute';
        sels.append(h('div', { class: `lm-sel${unique ? '' : ' lm-sel-weak'}` },
          h('div', { class: 'lm-selh' }, h('b', {}, by), h('span', { class: `lm-badge ${g.m === 'unique' ? 'lm-ok' : unique ? '' : 'lm-warn'}` }, g.m)),
          g.rows.map(([fw, code]) => {
            const b = h('button', { type: 'button', class: 'lm-btn lm-copy' }, 'Copy');
            b.onclick = () => copyText(code, b);
            return h('div', { class: 'lm-selr' }, h('span', { class: 'lm-fw' }, fw), h('code', {}, code), b);
          })));
      }
    }
    notes.replaceChildren(...(res?.notes || []).map((n) => h('div', {}, n)));
    const sc = vals['Screen (device px)'];
    screenHead.replaceChildren(...[h('span', {}, `${sc ? sc.value : ''} device px`),
      sc?.hint ? h('span', { class: 'lm-sub' }, ` · ${sc.hint}`) : null,
      shotSize ? h('span', { class: 'lm-sub' }, ` · screenshot ${shotSize[0]}×${shotSize[1]}`) : null,
      v && shotSize && Math.abs(shotSize[0] / shotSize[1] - v.devW / v.devH) > 0.02 ? h('span', { class: 'lm-bad' }, ' · screenshot and dump shapes differ') : null].filter(Boolean));
  }

  // ---------------- sync ----------------
  const syncField = (el, key) => { if (document.activeElement !== el) el.value = ctx.raw[key] ?? ''; };
  function sync() {
    syncField(fx, 'x'); syncField(fy, 'y'); syncField(fw, 'w'); syncField(fh, 'h'); syncField(fsw, 'shotWidth');
    if (document.activeElement !== dumpTa && dumpTa.value !== (ctx.raw.dump ?? '')) dumpTa.value = ctx.raw.dump ?? '';
    const rect = Number(ctx.raw.w) > 0 && Number(ctx.raw.h) > 0;
    for (const b of modeSeg.children) b.setAttribute('aria-pressed', String((b.dataset.m === 'rect') === rect));
    whBox.classList.toggle('lm-dim', !rect);
    clearShot.hidden = !shotUrl;
    dumpBox.querySelector('summary').textContent = `Dump XML${V() ? ` · ${V().nodes.length} nodes` : ''}`;
  }
  ctx.onResult((r) => { res = r; if (hover != null && !(V()?.nodes[hover])) hover = null; sync(); screenDraw(); treeDraw(); treeMark(); sideDraw(); });
}
