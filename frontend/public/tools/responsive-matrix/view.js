// Responsive Preview Matrix: the page is a width rail and the page itself.
//   Rail    - the viewport-width axis (phone / tablet / desktop zones) with one
//             flag per breakpoint, coloured by what the frame measured; where
//             a page is wider than its viewport a hatched bar runs on to the
//             width the document really takes. Drag a flag to move that
//             breakpoint (the set becomes Custom), drag the probe to any width.
//   Probe   - the page live at the probe's width, measured as you scrub, so a
//             break between two breakpoints shows; add it as a breakpoint.
//   Matrix  - one frame per breakpoint at one common scale, so their widths
//             compare truly; the overflow sticks out of the frame, hatched,
//             with the elements that cause it.
// The frames measure the page (same origin only) and write the report input;
// every status and number drawn comes from run()'s result.rail.

const NS = 'http://www.w3.org/2000/svg';
const PRESETS = [['common', 'Common'], ['tailwind', 'Tailwind'], ['bootstrap', 'Bootstrap 5'], ['material', 'Material 3'], ['reflow', 'WCAG 320'], ['custom', 'Custom']];
const ZONES = [[0, 600, 'phone'], [600, 1024, 'tablet'], [1024, 99999, 'desktop']];
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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

// What sticks out of a same-origin frame (the outermost elements past the viewport).
const selOf = (e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
function measure(frame, w) {
  let doc;
  try { doc = frame.contentDocument; if (!doc || !doc.documentElement) throw new Error('no document'); } catch {
    return { status: 'blocked', line: `${w} blocked cross-origin` };
  }
  const de = doc.documentElement;
  const cw = de.clientWidth, sw = de.scrollWidth;
  if (sw <= cw + 1) return { status: 'ok', sw, line: `${w} ok sw=${sw}` };
  const lim = cw + 0.5;
  const out = [...doc.querySelectorAll('body *')].filter((e) => {
    const r = e.getBoundingClientRect();
    if (!(r.right > lim) || r.width === 0) return false;
    const p = e.parentElement;
    return !p || p === doc.body || p.getBoundingClientRect().right <= lim;
  }).slice(0, 4).map((e) => `${selOf(e)}(${Math.round(e.getBoundingClientRect().right)})`);
  return { status: 'overflow', sw, line: `${w} overflow sw=${sw} ${out.join(' ')}`.trim() };
}

export function page(root, ctx) {
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = new URL('style.css', import.meta.url).href;
  document.head.append(link);
  const served = /^https?:/.test(location.protocol);
  const PKEY = `redline.tool.${ctx.manifest.id}.probe`;

  let res = null;
  let probe = Number(store.get(PKEY)) || 540;
  let dragW = null;        // {i, w} while a flag is dragged
  let results = new Map(); // width -> measure() of the matrix frames
  let frameKey = '';
  let cells = [];

  // ---------------- address bar ----------------
  const urlIn = h('input', { type: 'text', class: 'rm-url', spellcheck: 'false', 'aria-label': 'Page URL',
    onchange: (e) => ctx.set('url', e.target.value.trim()), onkeydown: (e) => { if (e.key === 'Enter') ctx.set('url', e.target.value.trim()); } });
  const presetSeg = h('div', { class: 'rm-seg', role: 'group', 'aria-label': 'Breakpoint set' },
    PRESETS.map(([v, t]) => h('button', { type: 'button', 'data-p': v, onclick: () => choosePreset(v) }, t)));
  const scaleSel = h('select', { class: 'rm-sel', 'aria-label': 'Matrix scale', onchange: (e) => ctx.set('scale', e.target.value) },
    [['0', 'Fit'], ['0.25', '25 %'], ['0.33', '33 %'], ['0.5', '50 %']].map(([v, t]) => h('option', { value: v }, t)));
  const reloadBtn = h('button', { type: 'button', class: 'k-btn', onclick: () => reloadAll() }, 'Reload frames');
  const bar = h('div', { class: 'rm-bar' },
    h('span', { class: 'rm-lock', 'aria-hidden': 'true' }, served ? 'page' : 'file'), urlIn, presetSeg,
    h('label', { class: 'rm-fld' }, h('span', {}, 'scale'), scaleSel), reloadBtn);

  // ---------------- rail ----------------
  const rail = sv('svg', { class: 'rm-rail', role: 'group', 'aria-label': 'Viewport widths' });
  const railNote = h('span', { class: 'rm-sub' });
  const railBox = h('section', { class: 'rm-panel rm-railbox' },
    h('div', { class: 'rm-phead' }, h('span', { class: 'rm-h' }, 'Viewport width'), railNote), rail);

  // ---------------- probe ----------------
  const probeFrame = h('iframe', { class: 'rm-pframe', title: 'Page at the probe width', tabindex: '-1', loading: 'eager' });
  const probeClip = h('div', { class: 'rm-pclip' }, probeFrame);
  const probeOver = h('div', { class: 'rm-pover' });
  const probeStage = h('div', { class: 'rm-pstage' }, probeClip, probeOver);
  const probeW = h('input', { type: 'text', inputmode: 'numeric', class: 'rm-num', 'aria-label': 'Probe width in px',
    onchange: (e) => { const v = Math.round(Number(e.target.value)); if (v >= 200 && v <= 3840) setProbe(v); } });
  const probeStat = h('span', { class: 'rm-pstat' });
  const addBtn = h('button', { type: 'button', class: 'k-btn', onclick: () => addBreakpoint(probe) }, 'Add as breakpoint');
  const probeBox = h('section', { class: 'rm-panel rm-probebox' },
    h('div', { class: 'rm-phead' }, h('span', { class: 'rm-h' }, 'Probe'), h('label', { class: 'rm-fld' }, probeW, h('i', {}, 'px')), probeStat, addBtn),
    probeStage);

  // ---------------- matrix ----------------
  const grid = h('div', { class: 'rm-grid' });
  const matrixNote = h('span', { class: 'rm-sub' });
  const matrixBox = h('section', { class: 'rm-panel rm-matrix' },
    h('div', { class: 'rm-phead' }, h('span', { class: 'rm-h' }, 'Breakpoints'), matrixNote), grid);
  const warns = h('div', { class: 'rm-warns', 'aria-live': 'polite' });
  const notes = h('details', { class: 'rm-notes' });

  root.classList.add('rm-root');
  ctx.outputs.classList.add('rm-out');
  root.append(h('div', { class: 'rm' }, bar, railBox,
    h('div', { class: 'rm-cols' },
      h('div', { class: 'rm-left' }, matrixBox),
      h('aside', { class: 'rm-side' }, probeBox, warns, ctx.outputs, notes))));

  // ---------------- editing the set ----------------
  const bps = () => res?.rail || [];
  const asRows = (list) => list.map((b) => ({ name: b.name, width: String(b.width), height: String(b.height) }));
  function choosePreset(v) {
    if (v === 'custom' && ctx.raw.preset !== 'custom') ctx.setMany({ preset: 'custom', sizes: asRows(bps()) });
    else ctx.set('preset', v);
  }
  function commitWidths(list) {
    const sorted = [...list].sort((a, b) => a.width - b.width);
    ctx.setMany({ preset: 'custom', sizes: asRows(sorted) });
  }
  function moveBreakpoint(i, w) {
    const list = bps().map((b) => ({ ...b }));
    if (!list[i] || list.some((b, j) => j !== i && b.width === w)) return;
    list[i].width = w;
    commitWidths(list);
  }
  function addBreakpoint(w) {
    if (bps().some((b) => b.width === w)) return;
    const cls = w < 600 ? 'phone' : w < 1024 ? 'tablet' : 'desktop';
    let name = cls;
    for (let k = 2; bps().some((b) => b.name === name); k++) name = `${cls} ${k}`;
    commitWidths([...bps(), { name, width: w, height: w < 600 ? 800 : w < 1024 ? 1024 : 800 }]);
  }
  function removeBreakpoint(i) {
    if (bps().length <= 1) return;
    commitWidths(bps().filter((_, j) => j !== i));
  }
  function setProbe(w) {
    probe = clamp(Math.round(w), 200, 3840);
    store.set(PKEY, String(probe));
    drawRail(); layoutProbe(); measureProbeSoon();
  }

  // ---------------- rail drawing ----------------
  let rg = null;
  function drawRail() {
    const list = bps();
    const W = Math.max(300, rail.parentElement.clientWidth - 20);
    const narrow = W < 560;
    const maxSw = Math.max(0, ...list.map((b) => b.sw || 0));
    const wmin = 200, wmax = Math.max(1600, probe + 60, ...list.map((b) => b.width + 120), maxSw + 40);
    const L = 10, R = 12;
    const X = (w) => L + ((w - wmin) / (wmax - wmin)) * (W - L - R);
    const Wof = (x) => wmin + ((x - L) / (W - L - R)) * (wmax - wmin);
    // Lanes: flags too close to their neighbour go one lane down.
    const shown = list.map((b, i) => ({ ...b, i, w: dragW && dragW.i === i ? dragW.w : b.width }));
    const order = [...shown].sort((a, b) => a.w - b.w);
    const lanes = [];
    const laneOf = new Map();
    const need = narrow ? 64 : 92;
    // A flag takes its label, and its overflow bar with the +px label when it has one.
    const lab = (b) => (narrow ? `${b.w}` : `${b.name} ${b.w}`);
    const reach = (b) => Math.max(X(b.w) + lab(b).length * 6.6 + 18, b.status === 'overflow' && b.sw && !(dragW && dragW.i === b.i) ? X(b.sw) + 36 : 0);
    for (const b of order) {
      let lane = 0;
      while (lanes[lane] != null && X(b.w) - lanes[lane] < 6) lane++;
      lanes[lane] = reach(b); laneOf.set(b.i, lane);
    }
    void need;
    const nl = Math.max(1, lanes.length);
    const top = 8, laneH = 34, axisY = top + nl * laneH + 8, H = axisY + 40;
    rail.setAttribute('viewBox', `0 0 ${W} ${H}`); rail.setAttribute('height', H);
    rg = { X, Wof, axisY, H, W, wmin, wmax };
    const g = [];
    const defs = sv('defs');
    const pat = sv('pattern', { id: 'rm-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(sv('rect', { width: 6, height: 6, class: 'rm-hatch-bg' }), sv('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'rm-hatch-ln' }));
    defs.append(pat); g.push(defs);
    // Device zones.
    for (const [a, b, t] of ZONES) {
      const x1 = X(Math.max(a, wmin)), x2 = X(Math.min(b, wmax));
      if (x2 <= x1) continue;
      g.push(sv('rect', { x: x1, y: top - 4, width: x2 - x1, height: axisY - top + 4, class: `rm-zone rm-zone-${t}` }));
      g.push(sv('text', { x: x1 + 5, y: axisY - 5, class: 'rm-zonetxt' }, t));
    }
    if (320 >= wmin) {
      g.push(sv('line', { x1: X(320), x2: X(320), y1: top - 4, y2: axisY, class: 'rm-wcag' }));
      if (!narrow) g.push(sv('text', { x: X(320) + 4, y: top + 6, class: 'rm-wcagtxt' }, 'WCAG 320'));
    }
    // Axis and ticks.
    g.push(sv('line', { x1: L, x2: W - R, y1: axisY, y2: axisY, class: 'rm-axis' }));
    const step = (wmax - wmin) / (W / 70) > 200 ? 400 : 200;
    for (let w = Math.ceil(wmin / step) * step; w <= wmax; w += step) {
      g.push(sv('line', { x1: X(w), x2: X(w), y1: axisY, y2: axisY + 5, class: 'rm-tick' }));
      g.push(sv('text', { x: X(w), y: axisY + 16, 'text-anchor': 'middle', class: 'rm-ticktxt' }, String(w)));
    }
    // Flags.
    for (const b of shown) {
      const lane = laneOf.get(b.i);
      const x = X(b.w), fy = top + lane * laneH;
      const st = dragW && dragW.i === b.i ? 'unmeasured' : b.status;
      const f = sv('g', { class: `rm-flag rm-st-${st}`, tabindex: '0', role: 'slider', 'data-focus': `flag-${b.i}`,
        'aria-label': `${b.name}: ${b.w} px wide, ${st === 'ok' ? 'fits' : st === 'overflow' ? `overflows by ${b.over} px` : st}`,
        'aria-valuenow': String(b.w), 'aria-valuemin': '200', 'aria-valuemax': '3840', 'data-i': b.i });
      f.append(sv('title', {}, `${b.name} · ${b.w} × ${b.height} · ${b.query}${b.culprits.length ? ` · sticks out: ${b.culprits.map((c) => c.sel).join(', ')}` : ''}\nDrag to move · Delete removes`));
      if (st === 'overflow' && b.sw) {
        g.push(sv('rect', { x, y: fy + 20, width: Math.max(2, X(b.sw) - x), height: 8, fill: 'url(#rm-hatch)', class: 'rm-overbar' }));
        g.push(sv('text', { x: X(b.sw) + 4, y: fy + 27, class: 'rm-overtxt' }, `+${b.over}`));
      }
      f.append(sv('line', { x1: x, x2: x, y1: fy + 2, y2: axisY, class: 'rm-pole' }));
      const label = lab(b);
      const tw = label.length * 6.6 + 18;
      f.append(sv('rect', { x, y: fy, width: tw, height: 17, rx: 2, class: 'rm-flagbg' }));
      f.append(sv('circle', { cx: x + 7, cy: fy + 8.5, r: 3.5, class: 'rm-dot' }));
      f.append(sv('text', { x: x + 14, y: fy + 12.5, class: 'rm-flagtxt' }, label));
      f.append(sv('rect', { x: x - 6, y: fy, width: tw + 6, height: axisY - fy, class: 'rm-hit' }));
      f.addEventListener('keydown', (e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeBreakpoint(b.i); return; }
        const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (!d) return; e.preventDefault();
        moveBreakpoint(b.i, clamp(b.width + d * (e.shiftKey ? 10 : 1), 200, 3840));
      });
      g.push(f);
    }
    // The probe.
    const px = X(probe);
    const pr = sv('g', { class: 'rm-probe', tabindex: '0', role: 'slider', 'data-focus': 'probe', 'aria-label': 'Probe width, px',
      'aria-valuenow': String(probe), 'aria-valuemin': '200', 'aria-valuemax': '3840' });
    pr.append(sv('title', {}, 'Probe: drag to see the page at any width'));
    pr.append(sv('line', { x1: px, x2: px, y1: top - 4, y2: axisY, class: 'rm-probeline' }));
    pr.append(sv('path', { d: `M${px},${axisY + 1} l-7,11 h14 z`, class: 'rm-probehead' }));
    pr.append(sv('rect', { x: px - 18, y: axisY + 20, width: 36, height: 14, rx: 2, class: 'rm-probetab' }));
    pr.append(sv('text', { x: px, y: axisY + 31, 'text-anchor': 'middle', class: 'rm-probetxt' }, String(probe)));
    pr.append(sv('rect', { x: px - 10, y: top - 4, width: 20, height: axisY - top + 40, class: 'rm-hit' }));
    pr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === '+') { e.preventDefault(); addBreakpoint(probe); return; }
      const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
      if (!d) return; e.preventDefault();
      setProbe(probe + d * (e.shiftKey ? 10 : 1));
    });
    g.push(pr);
    const k = document.activeElement?.dataset?.focus;
    rail.replaceChildren(...g);
    if (k) rail.querySelector(`[data-focus="${k}"]`)?.focus({ preventScroll: true });
    const over = list.filter((b) => b.status === 'overflow').length, meas = list.filter((b) => b.status === 'ok' || b.status === 'overflow').length;
    railNote.textContent = `${list.length} breakpoints · ${meas ? `${over} of ${meas} measured overflow` : 'measuring…'} · drag a flag to move it, the probe to look between`;
  }
  // Drag on the rail: a flag moves its breakpoint (committed on release), anywhere else moves the probe.
  rail.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !rg) return;
    const flag = e.target.closest?.('.rm-flag');
    e.preventDefault();
    rail.setPointerCapture(e.pointerId);
    const rx = () => rail.getBoundingClientRect();
    const toW = (ev) => { const r = rx(); return clamp(Math.round(rg.Wof(((ev.clientX - r.left) * rg.W) / r.width)), 200, 3840); };
    const st = flag ? { i: Number(flag.dataset.i), x0: e.clientX, moved: false } : null;
    if (flag) flag.focus({ preventScroll: true });
    const move = (ev) => {
      if (st) {
        if (Math.abs(ev.clientX - st.x0) > 2) st.moved = true;
        if (!st.moved) return;
        dragW = { i: st.i, w: toW(ev) }; drawRail();
      } else setProbe(toW(ev));
    };
    const up = () => {
      rail.removeEventListener('pointermove', move); rail.removeEventListener('pointerup', up); rail.removeEventListener('pointercancel', up);
      if (st && dragW) { const d = dragW; dragW = null; moveBreakpoint(d.i, d.w); drawRail(); }
    };
    rail.addEventListener('pointermove', move); rail.addEventListener('pointerup', up); rail.addEventListener('pointercancel', up);
    if (!st) move(e);
  });

  // ---------------- probe ----------------
  let probeTimer = null, probeSrc = '', probeOver0 = 0;
  function layoutProbe() {
    const avail = Math.max(200, probeStage.clientWidth || 360);
    const s = Math.min(1, (avail - 2) / (probe + probeOver0));
    const hgt = Math.round(Math.min(560, Math.max(240, probe * 0.75)));
    Object.assign(probeFrame.style, { width: `${probe}px`, height: `${hgt}px`, transform: `scale(${s})` });
    probeClip.style.width = `${Math.round(probe * s)}px`;
    probeClip.style.height = `${Math.round(hgt * s)}px`;
    if (document.activeElement !== probeW) probeW.value = String(probe);
    probeOver.style.left = `${Math.round(probe * s)}px`;
    probeOver.dataset.s = String(s);
  }
  function measureProbeSoon() {
    clearTimeout(probeTimer);
    probeStat.textContent = 'measuring…'; probeStat.className = 'rm-pstat';
    probeTimer = setTimeout(() => {
      const r = measure(probeFrame, probe);
      const s = Number(probeOver.dataset.s) || 0.3;
      if (r.status === 'overflow') {
        probeStat.textContent = `overflow +${r.sw - probe} px`; probeStat.className = 'rm-pstat rm-bad';
        if (probeOver0 !== r.sw - probe) { probeOver0 = r.sw - probe; layoutProbe(); }
        probeOver.style.width = `${Math.max(3, Math.round((r.sw - probe) * (Number(probeOver.dataset.s) || s)))}px`; probeOver.hidden = false;
      } else {
        probeStat.textContent = r.status === 'ok' ? 'fits' : 'not inspectable'; probeStat.className = `rm-pstat ${r.status === 'ok' ? 'rm-good' : 'rm-warnc'}`;
        probeOver.hidden = true;
        if (probeOver0) { probeOver0 = 0; layoutProbe(); }
      }
    }, 350);
  }
  probeFrame.addEventListener('load', () => measureProbeSoon());

  // ---------------- matrix ----------------
  function report() {
    const list = bps();
    if (!list.length || !list.every((b) => results.has(b.width))) return;
    const text = list.map((b) => results.get(b.width).line).join('\n');
    if (text !== String(ctx.raw.report || '')) ctx.set('report', text);
  }
  function reloadAll() {
    results = new Map();
    for (const c of cells) { c.badge.textContent = 'loading'; try { c.frame.contentWindow.location.reload(); } catch { c.frame.src = c.frame.src; } }
    try { probeFrame.contentWindow.location.reload(); } catch { probeFrame.src = probeFrame.src; }
  }
  function scaleFor(list) {
    const fixed = Number(ctx.input.scale);
    if (fixed > 0) return fixed;
    const avail = Math.max(260, grid.clientWidth || 800);
    const gap = 14 * (list.length - 1);
    const total = list.reduce((a, b) => a + b.width + (b.status === 'overflow' ? b.over : 0), 0) * 1.02;
    // One row when it fits at 12 % or more, else as large as the widest frame allows.
    const one = (avail - gap - 8) / total;
    return Math.round(100 * (one >= 0.12 ? Math.min(0.35, one) : Math.min(0.35, (avail - 8) / Math.max(...list.map((b) => b.width))))) / 100;
  }
  function buildMatrix() {
    const list = bps();
    const url = String(ctx.input.url || '').trim();
    const s = scaleFor(list);
    // The scale is not in the key: rescaling only restyles, it never reloads a frame.
    const key = JSON.stringify([url, list.map((b) => [b.width, b.height])]);
    if (key === frameKey) return s;
    frameKey = key;
    results = new Map();
    cells = list.map((b) => {
      const badge = h('span', { class: 'rm-badge' }, 'loading');
      const frame = h('iframe', { src: url, title: `${b.name} ${b.width}px`, loading: 'eager', tabindex: '-1',
        style: `width:${b.width}px;height:${b.height}px` });
      const box = h('div', { class: 'rm-box' }, frame);
      const over = h('div', { class: 'rm-overflow', hidden: true }, h('span', {}));
      const culprits = h('div', { class: 'rm-culprits' });
      const head = h('div', { class: 'rm-chead' }, h('b', {}, b.name), h('span', { class: 'rm-dims' }, `${b.width} × ${b.height}`), badge);
      const cell = h('figure', { class: 'rm-cell' }, head, h('div', { class: 'rm-frow' }, box, over), culprits);
      const c = { w: b.width, frame, badge, over, culprits, cell, box };
      frame.addEventListener('load', () => {
        setTimeout(() => { results.set(b.width, measure(frame, b.width)); report(); }, 700);
      });
      return c;
    });
    grid.replaceChildren(...cells.map((c) => c.cell));
    return s;
  }
  function decorateMatrix(s) {
    const list = bps();
    list.forEach((b, i) => {
      const c = cells[i];
      if (!c) return;
      const st = b.status;
      c.cell.dataset.st = st;
      c.badge.textContent = st === 'ok' ? 'fits' : st === 'overflow' ? `overflow +${b.over} px` : st === 'blocked' ? 'not inspectable' : (results.has(b.width) ? 'measured' : 'loading');
      c.badge.className = `rm-badge rm-b-${st}`;
      c.over.hidden = st !== 'overflow';
      const vh = Math.round(Math.min(b.height, 1100) * s);
      c.frame.style.transform = `scale(${s})`;
      Object.assign(c.box.style, { width: `${Math.round(b.width * s)}px`, height: `${vh}px` });
      c.over.style.height = `${vh}px`;
      c.cell.style.width = `${Math.max(64, Math.round((b.width + (st === 'overflow' ? b.over : 0)) * s) + (st === 'overflow' ? 2 : 0))}px`;
      if (st === 'overflow') {
        c.over.style.width = `${Math.max(3, Math.round(b.over * s))}px`;
        c.over.firstChild.textContent = b.over * s >= 26 ? `+${b.over}` : '';
      }
      c.culprits.replaceChildren(...b.culprits.map((k) => h('div', {}, h('code', {}, k.sel), ` reaches ${k.right} px`)));
    });
    matrixNote.textContent = `all at ${Math.round(s * 100)} % · the same scale, so widths compare · hatched: the part of the page past the viewport`;
  }

  // ---------------- sync ----------------
  function syncBar() {
    const raw = ctx.raw;
    if (document.activeElement !== urlIn) urlIn.value = raw.url ?? '';
    for (const b of presetSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.p === raw.preset));
    scaleSel.value = String(raw.scale ?? '0');
  }
  function render() {
    syncBar();
    const url = String(ctx.input.url || '').trim();
    if (!served || !url || !bps().length) {
      grid.replaceChildren(h('div', { class: 'rm-empty' }, !served
        ? 'Open this tool in the app to see the page at every breakpoint and measure overflow. The media queries and the Playwright script work here too.'
        : (res?.warnings || ['Give a URL and at least one breakpoint.'])[0]));
      frameKey = ''; cells = [];
    } else {
      const s = buildMatrix();
      decorateMatrix(s);
    }
    if (bps().length || rg) drawRail();
    if (served && url && url !== probeSrc) { probeSrc = url; probeFrame.src = url; }
    layoutProbe();
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    warns.hidden = !(res?.warnings || []).length;
    notes.replaceChildren(h('summary', {}, 'Notes'), ...(res?.notes || []).map((n) => h('p', {}, n)));
  }

  ctx.onResult((r) => { res = r; render(); });
  let lastW = 0;
  new ResizeObserver(() => {
    const w = root.clientWidth;
    if (w !== lastW && res) { lastW = w; render(); }
  }).observe(root);
}
