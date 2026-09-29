// Boot Log Timeline, custom page: the boot itself on one time axis.
//   Overview - the stages (firmware, bootloader, kernel, userspace) to scale
//              with the part in view as a window: drag it to pan, drag its
//              edges to zoom, click a stage to zoom to it.
//   Timeline - a Gantt with a lane per kind: bootloader stages, kernel
//              phases, initcalls, driver probes, userspace units, milestones.
//              Silent stretches are hatched across all lanes. Wheel zooms at
//              the pointer, drag pans, drag on the time axis zooms to that
//              span, double-click fits; click a bar or a gap to select it.
//   Silence  - under the lanes: every pause between two log lines as a stem
//              (log scale); drag the dashed threshold line to set what counts
//              as a gap. The tool re-runs and the gaps follow.
//   Detail, slowest and gaps lists, and the log itself are linked to the
//   bars: selecting in one shows it in all.
// Everything drawn comes from run()'s result.timeline.

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
const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v); return el; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '–';
  const a = Math.abs(ms);
  if (a >= 60000) return `${Math.floor(ms / 60000)}min ${((a % 60000) / 1000).toFixed(1)}s`;
  if (a >= 1000) return `${(ms / 1000).toFixed(3)} s`;
  if (a >= 10) return `${Number(ms.toFixed(1))} ms`;
  return `${ms.toFixed(2)} ms`;
}
const shown = (text, t) => (t == null ? text : String(text).replace(/^(\[\s*\d+\.\d+\s+\d+\.\d+\]\s?)?(?:<\d>)?\[\s*\d+\.\d+\]\s?/, '$1'));
const fmtAt = (ms) => (ms == null ? '' : (ms / 1000).toFixed(6).replace(/^(-?)(\d)\./, '$1$2.'));

const LANE_CLASS = { loader: 'ln-loader', kernel: 'ln-kernel', initcall: 'ln-init', probe: 'ln-probe', unit: 'ln-unit', mark: 'ln-mark' };
const LANE_NAME = { loader: 'Bootloader', kernel: 'Kernel', initcall: 'Initcall', probe: 'Driver probe', unit: 'Userspace unit', mark: 'Milestone' };
const ROW_H = { loader: 20, kernel: 20, initcall: 14, probe: 14, unit: 14, mark: 38 };

function niceTicks(a, b, px) {
  const span = b - a;
  const target = span / Math.max(2, px / 92);
  const p = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= target) || p * 10;
  const out = [];
  for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return { step, out };
}
function tickLabel(v, step) {
  if (step >= 100) return `${(v / 1000).toFixed(step >= 1000 ? 0 : 1)} s`;
  if (step >= 1) return `${Math.round(v)} ms`;
  return `${v.toFixed(step >= 0.1 ? 1 : 2)} ms`;
}

export function page(root, ctx) {
  const wrap = h('div', { class: 'blt' });
  root.append(wrap);

  // ---------- header stats ----------
  const stats = h('div', { class: 'blt-stats', 'aria-live': 'polite' });

  // ---------- overview ----------
  const ov = sv('svg', { class: 'blt-ov', role: 'group', 'aria-label': 'Boot stages overview' });
  const ovContent = sv('g');
  const ovWin = sv('g', { class: 'blt-win', tabindex: '0', role: 'slider', 'aria-label': 'Visible time window: arrows pan, + and - zoom' });
  ov.append(ovContent, ovWin);
  const ovCard = h('section', { class: 'blt-card blt-ovcard' },
    h('div', { class: 'blt-head' }, h('h2', {}, 'Stages'), stats), ov);

  // ---------- timeline ----------
  const gapInput = h('input', { type: 'text', inputmode: 'decimal', class: 'blt-num', 'aria-label': 'Gap threshold in ms', spellcheck: 'false',
    onchange: (e) => { const v = ctx.parseEng(e.target.value); if (v != null && v > 0) ctx.set('gap', v); } });
  const legend = h('div', { class: 'blt-legend' });
  const hidden = new Set();
  const zoomBy = (f, at) => { if (!view) return; const c = at ?? (view.a + view.b) / 2; setView(c - (c - view.a) * f, c + (view.b - c) * f); };
  const tbar = h('div', { class: 'blt-tbar' },
    h('div', { class: 'blt-seg' },
      h('button', { class: 'k-btn', title: 'Zoom out (-)', 'aria-label': 'Zoom out', onclick: () => zoomBy(1.6) }, '−'),
      h('button', { class: 'k-btn', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onclick: () => zoomBy(1 / 1.6) }, '+'),
      h('button', { class: 'k-btn', title: 'Fit the whole boot (0)', onclick: () => fit() }, 'Fit'),
      h('button', { class: 'k-btn', title: 'Zoom to the selection (Enter)', onclick: () => zoomToSel() }, 'To selection')),
    h('label', { class: 'blt-gapin' }, 'Gap ≥', gapInput, 'ms'),
    legend);
  const svgBox = h('div', { class: 'blt-svgbox' });
  const svg = sv('svg', { class: 'blt-svg', tabindex: '0', role: 'application',
    'aria-label': 'Boot timeline. Arrows left and right pan, plus and minus zoom, 0 fits, up and down step through the items, Enter zooms to the selected one.' });
  const content = sv('g');
  const handle = sv('g', { class: 'blt-thr', tabindex: '0', role: 'slider', 'aria-label': 'Gap threshold: up and down arrows change it' });
  svg.append(content, handle);
  svgBox.append(svg);
  const chartCard = h('section', { class: 'blt-card blt-chart' },
    h('div', { class: 'blt-head' }, h('h2', {}, 'Timeline'), h('span', { class: 'blt-sub', id: 'blt-viewtxt' })),
    tbar, svgBox,
    h('div', { class: 'blt-help' }, 'Wheel zooms at the pointer, drag pans, drag along the time axis to zoom to a span, double-click fits. Drag the dashed line in Silence to set the gap threshold. Keys on the chart: ',
      h('kbd', {}, '←'), h('kbd', {}, '→'), ' pan, ', h('kbd', {}, '+'), h('kbd', {}, '−'), ' zoom, ', h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' step, ', h('kbd', {}, 'Enter'), ' zoom to it.'));

  // ---------- side ----------
  const warns = h('div', { class: 'blt-warns', role: 'status' });
  const detail = h('div', { class: 'blt-detail' });
  const detailCard = h('section', { class: 'blt-card blt-detcard' }, h('div', { class: 'blt-head' }, h('h2', {}, 'Selected')), detail);
  const topInput = h('input', { type: 'text', inputmode: 'numeric', class: 'blt-num', 'aria-label': 'How many slowest items', spellcheck: 'false',
    onchange: (e) => { const v = ctx.parseEng(e.target.value); if (v != null && v >= 1) ctx.set('top', Math.round(v)); } });
  const slowList = h('div', { class: 'blt-list', role: 'list' });
  const slowCard = h('section', { class: 'blt-card blt-slowcard' }, h('div', { class: 'blt-head' }, h('h2', {}, 'Slowest'), h('label', { class: 'blt-sub blt-gapin' }, 'top', topInput)), slowList);
  const gapList = h('div', { class: 'blt-list', role: 'list' });
  const gapSub = h('span', { class: 'blt-sub' });
  const gapCard = h('section', { class: 'blt-card blt-gapcard' }, h('div', { class: 'blt-head' }, h('h2', {}, 'Silent gaps'), gapSub), gapList);
  const notes = h('details', { class: 'blt-notes' }, h('summary', {}, 'Notes'));

  // ---------- log ----------
  const logList = h('div', { class: 'blt-log', tabindex: '0', role: 'listbox', 'aria-label': 'Log lines: up and down move, Enter selects the item the line belongs to' });
  const ta = h('textarea', { class: 'blt-ta', spellcheck: 'false', rows: '16', 'aria-label': 'Boot log text' });
  let taTimer = null;
  ta.addEventListener('input', () => { clearTimeout(taTimer); taTimer = setTimeout(() => ctx.set('log', ta.value), 350); });
  const tabLines = h('button', { class: 'k-tab', role: 'tab', 'aria-selected': 'true', onclick: () => setMode('lines') }, 'Lines');
  const tabEdit = h('button', { class: 'k-tab', role: 'tab', 'aria-selected': 'false', onclick: () => setMode('edit') }, 'Edit / paste');
  const logSub = h('span', { class: 'blt-sub' });
  const logCard = h('section', { class: 'blt-card blt-logcard' },
    h('div', { class: 'blt-head' }, h('h2', {}, 'Log'), h('div', { class: 'k-tabs', role: 'tablist' }, tabLines, tabEdit), logSub), logList, ta);
  ta.hidden = true;
  let mode = 'lines';
  function setMode(m) {
    mode = m;
    tabLines.setAttribute('aria-selected', String(m === 'lines'));
    tabEdit.setAttribute('aria-selected', String(m === 'edit'));
    logList.hidden = m !== 'lines';
    ta.hidden = m !== 'edit';
    if (m === 'edit') { ta.value = ctx.raw.log || ''; ta.focus(); }
  }

  const outCard = h('div', { class: 'blt-out' }, ctx.outputs);
  wrap.append(
    h('div', { class: 'blt-col blt-main' }, ovCard, chartCard, logCard),
    h('div', { class: 'blt-col blt-side' }, warns, detailCard, slowCard, gapCard, notes, outCard));

  // ---------- state ----------
  let res = null, T = null, view = null, sel = null, hoverId = null, logKey = null, cursor = -1;
  let byId = new Map();
  let geo = null; // last layout, for hit tests and drags

  function setView(a, b) {
    if (!T) return;
    const [lo, hi] = T.range;
    const full = Math.max(1, hi - lo);
    let span = clamp(b - a, 0.05, full * 1.3);
    let c = (a + b) / 2;
    c = clamp(c, lo - full * 0.15 + span / 2 - span, hi + full * 0.15 - span / 2 + span);
    view = { a: c - span / 2, b: c + span / 2 };
    drawChart(); drawOverview();
  }
  function fit() {
    if (!T) return;
    const [lo, hi] = T.range; const pad = (hi - lo) * 0.02;
    setView(lo - pad, hi + pad);
  }
  function zoomToSel() {
    const it = sel && byId.get(sel);
    if (!it) return;
    const s = it.start ?? it.from, d = Math.max(it.dur, 1);
    setView(s - d * 0.35, s + d * 1.35);
  }
  function ensureVisible(it) {
    if (!view || !it) return;
    const s = it.start ?? it.from, e = s + it.dur, span = view.b - view.a;
    const pxPerMs = (geo ? geo.pw : 800) / span;
    if (it.dur * pxPerMs < 3 && it.dur > 0) { setView(s - it.dur * 0.6, e + it.dur * 0.6); return; }
    if (s < view.a || e > view.b) {
      if (e - s > span * 0.9) setView(s - (e - s) * 0.1, e + (e - s) * 0.1);
      else setView(s - span * 0.3, s + span * 0.7);
    }
  }
  function select(id, opts = {}) {
    sel = id;
    const it = id && byId.get(id);
    if (it && opts.reveal !== false) ensureVisible(it);
    drawChart(); drawOverview(); drawDetail(); markLists(); markLog(opts.scrollLog !== false);
  }

  // ---------- overview ----------
  function drawOverview() {
    if (!T) { ovContent.innerHTML = ''; ovWin.innerHTML = ''; return; }
    const W = Math.max(280, ov.clientWidth || ov.parentNode.clientWidth || 600);
    const H = 64;
    ov.setAttribute('viewBox', `0 0 ${W} ${H}`); ov.setAttribute('height', H);
    const [lo, hi] = T.range; const pad = (hi - lo) * 0.02;
    const a = lo - pad, b = hi + pad;
    const X = (t) => 8 + ((t - a) / (b - a)) * (W - 16);
    let s = '';
    for (const st of T.stages) {
      const x0 = X(st.from), x1 = X(st.from + st.dur), w = Math.max(1, x1 - x0);
      const share = T.total > 0 ? Math.round((st.dur / T.total) * 100) : 0;
      s += `<g class="ov-st st-${st.id}" data-stage="${st.id}"><rect x="${x0}" y="6" width="${w}" height="30" rx="3"><title>${esc(`${st.name}: ${fmtMs(st.dur)} (${share}%) - ${st.src}`)}</title></rect>`;
      const lbl = `${st.name} ${fmtMs(st.dur)}`;
      if (w > lbl.length * 6.3 + 10) s += `<text x="${x0 + 6}" y="19" class="ov-t">${esc(st.name)}</text><text x="${x0 + 6}" y="31" class="ov-v">${esc(fmtMs(st.dur))} · ${share}%</text>`;
      else if (w > 34) s += `<text x="${x0 + 4}" y="25" class="ov-v">${esc(fmtMs(st.dur))}</text>`;
      s += '</g>';
    }
    if (!T.stages.length) s += `<text x="10" y="25" class="ov-v">No stage totals in this log</text>`;
    for (const g of T.gaps) {
      const x0 = X(g.from), x1 = X(g.to);
      s += `<rect class="ov-gap" x="${x0}" y="40" width="${Math.max(1.5, x1 - x0)}" height="5"><title>${esc(fmtMs(g.dur) + ' silent')}</title></rect>`;
    }
    s += `<line class="ov-zero" x1="${X(0)}" x2="${X(0)}" y1="2" y2="48"/>`;
    s += `<text x="${X(lo)}" y="60" class="ov-ax">${esc(tickLabel(lo, 1000 > hi - lo ? 1 : 100))}</text><text x="${X(hi)}" y="60" class="ov-ax" text-anchor="end">${esc(fmtMs(hi))}</text>`;
    s += `<text x="${X(0)}" y="60" class="ov-ax" text-anchor="middle">0</text>`;
    ovContent.innerHTML = s;
    if (view) {
      const x0 = clamp(X(view.a), 0, W), x1 = clamp(X(view.b), 0, W);
      ovWin.innerHTML = `<rect class="win" x="${x0}" y="2" width="${Math.max(4, x1 - x0)}" height="${H - 18}" rx="3"/>`
        + `<rect class="win-e" data-edge="a" x="${x0 - 4}" y="2" width="8" height="${H - 18}"/>`
        + `<rect class="win-e" data-edge="b" x="${x1 - 4}" y="2" width="8" height="${H - 18}"/>`;
    }
    ovGeo = { X, a, b, W };
  }
  let ovGeo = null;
  ov.addEventListener('pointerdown', (e) => {
    if (!ovGeo || !view || e.button > 0) return;
    const r = ov.getBoundingClientRect();
    const toT = (cx) => ovGeo.a + ((cx - r.left) * (ovGeo.W / r.width) - 8) / (ovGeo.W - 16) * (ovGeo.b - ovGeo.a);
    const edge = e.target.getAttribute && e.target.getAttribute('data-edge');
    const inWin = e.target.closest && e.target.closest('.blt-win');
    const stage = e.target.closest && e.target.closest('[data-stage]');
    const t0 = toT(e.clientX), v0 = { ...view };
    let moved = false;
    try { ov.setPointerCapture(e.pointerId); } catch { /* synthetic or ended pointer */ }
    const move = (ev) => {
      const t = toT(ev.clientX);
      if (Math.abs(ev.clientX - e.clientX) > 2) moved = true;
      if (!moved) return;
      if (edge === 'a') setView(Math.min(t, v0.b - 0.1), v0.b);
      else if (edge === 'b') setView(v0.a, Math.max(t, v0.a + 0.1));
      else if (inWin) setView(v0.a + (t - t0), v0.b + (t - t0));
      else setView(Math.min(t0, t), Math.max(t0, t));
    };
    const up = () => {
      ov.removeEventListener('pointermove', move); ov.removeEventListener('pointerup', up); ov.removeEventListener('pointercancel', up);
      if (!moved) {
        if (stage) { const st = T.stages.find((x) => x.id === stage.getAttribute('data-stage')); if (st) setView(st.from - st.dur * 0.04, st.from + st.dur * 1.04); }
        else if (!inWin) { const span = view.b - view.a; setView(t0 - span / 2, t0 + span / 2); }
      }
      ovWin.focus({ preventScroll: true });
    };
    ov.addEventListener('pointermove', move); ov.addEventListener('pointerup', up); ov.addEventListener('pointercancel', up);
    e.preventDefault();
  });
  ovWin.addEventListener('keydown', (e) => {
    if (!view) return;
    const span = view.b - view.a;
    if (e.key === 'ArrowLeft') setView(view.a - span * 0.15, view.b - span * 0.15);
    else if (e.key === 'ArrowRight') setView(view.a + span * 0.15, view.b + span * 0.15);
    else if (e.key === '+' || e.key === '=' || e.key === 'ArrowUp') zoomBy(1 / 1.5);
    else if (e.key === '-' || e.key === '_' || e.key === 'ArrowDown') zoomBy(1.5);
    else if (e.key === '0' || e.key === 'Home') fit();
    else return;
    e.preventDefault();
  });

  // ---------- timeline ----------
  function layout(W) {
    const labelW = W < 560 ? 70 : 108;
    const pw = Math.max(80, W - labelW - 10);
    const lanes = T.lanes.filter((l) => !hidden.has(l.id));
    let y = 26;
    const laneY = {};
    for (const l of lanes) {
      let rh = ROW_H[l.id];
      if (l.rows > 16) rh = 11;
      const hgt = l.rows * rh + 8;
      laneY[l.id] = { y, h: hgt, rh };
      y += hgt;
    }
    const silY = y + 4, silH = 72;
    return { W, labelW, pw, laneY, lanes, lanesEnd: y, silY, silH, H: silY + silH + 16 };
  }
  function drawChart() {
    if (!T) { content.innerHTML = ''; handle.innerHTML = ''; return; }
    const W = Math.max(300, svgBox.clientWidth || 800);
    const G = layout(W);
    geo = G;
    const { labelW, pw } = G;
    svg.setAttribute('viewBox', `0 0 ${W} ${G.H}`); svg.setAttribute('width', W); svg.setAttribute('height', G.H);
    const X = (t) => labelW + ((t - view.a) / (view.b - view.a)) * pw;
    G.X = X;
    const inView = (s, e) => e >= view.a && s <= view.b;
    let s = `<defs><pattern id="blt-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="hatch"/></pattern>`
      + `<pattern id="blt-approx" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="5" class="hatch2"/></pattern>`
      + `<clipPath id="blt-clip"><rect x="${labelW}" y="0" width="${pw}" height="${G.H}"/></clipPath></defs>`;
    // axis
    const tk = niceTicks(view.a, view.b, pw);
    s += `<rect class="axis-bg" x="${labelW}" y="0" width="${pw}" height="22"/>`;
    s += `<g clip-path="url(#blt-clip)">`;
    for (const v of tk.out) {
      const x = X(v);
      s += `<line class="grid" x1="${x}" x2="${x}" y1="18" y2="${G.silY + G.silH}"/><text class="ax" x="${x + 3}" y="14">${esc(tickLabel(v, tk.step))}</text>`;
    }
    // stage boundaries
    for (const st of T.stages) {
      const x = X(st.from);
      if (x < labelW - 1 || x > labelW + pw + 1) continue;
      s += `<line class="stage-b" x1="${x}" x2="${x}" y1="22" y2="${G.lanesEnd}"><title>${esc(st.name)} starts</title></line>`;
    }
    // gaps
    for (const g of T.gaps) {
      if (!inView(g.from, g.to)) continue;
      const x0 = X(g.from), x1 = X(g.to), w = Math.max(2, x1 - x0);
      const on = sel === g.id ? ' on' : '';
      s += `<g class="gap${on}" data-id="${g.id}"><rect x="${x0}" y="22" width="${w}" height="${G.lanesEnd - 22}"><title>${esc(`${fmtMs(g.dur)} with nothing logged: ${g.cause}`)}</title></rect>`;
      if (w > 64) s += `<text class="gap-t" x="${x0 + w / 2}" y="${G.lanesEnd - 5}" text-anchor="middle">${esc(fmtMs(g.dur))} silent</text>`;
      s += '</g>';
    }
    // items
    for (const l of G.lanes) {
      const L = G.laneY[l.id];
      const its = T.items.filter((it) => it.lane === l.id);
      if (l.id === 'mark') {
        const lev = [-Infinity, -Infinity];
        for (const it of its) {
          if (!inView(it.start, it.start)) continue;
          const x = X(it.start), y = L.y + 30;
          const on = sel === it.id ? ' on' : '';
          s += `<g class="mk ${it.kind === 'target' ? 'mk-t' : ''}${on}" data-id="${it.id}"><path d="M${x} ${y - 5}L${x + 5} ${y}L${x} ${y + 5}L${x - 5} ${y}Z"/><title>${esc(`${it.name} at ${fmtMs(it.start)}${it.approx ? ' (approx.)' : ''}`)}</title>`;
          const tw = it.name.length * 5.9 + 6;
          const k = lev.findIndex((e) => e < x - tw / 2 - 3);
          if (k >= 0) { s += `<text class="mk-l" x="${x}" y="${L.y + 12 + k * 10}" text-anchor="middle">${esc(it.name)}</text>`; lev[k] = x + tw / 2; }
          s += '</g>';
        }
        continue;
      }
      // Items per row, in order, to know the room to the right of each.
      const rows = new Map();
      for (const it of its) { if (!rows.has(it.row)) rows.set(it.row, []); rows.get(it.row).push(it); }
      for (const [row, list] of rows) {
        list.sort((p, q) => p.start - q.start);
        list.forEach((it, n) => {
          const e = it.start + it.dur;
          if (!inView(it.start, e)) return;
          const x0 = X(it.start), x1 = X(e);
          const w = Math.max(it.point ? 3 : 1.5, x1 - x0);
          const y = L.y + 4 + row * L.rh, bh = L.rh - 3;
          const cls = ['bar', LANE_CLASS[it.lane]];
          if (it.tone) cls.push('t-' + it.tone);
          if (it.approx) cls.push('approx');
          if (it.open) cls.push('open');
          if (sel === it.id) cls.push('on');
          if (hoverId === it.id) cls.push('hov');
          s += `<g class="${cls.join(' ')}" data-id="${it.id}"><rect x="${x0}" y="${y}" width="${w}" height="${bh}" rx="2"/>`;
          if (it.approx) s += `<rect x="${x0}" y="${y}" width="${w}" height="${bh}" rx="2" class="approx-f"/>`;
          s += `<title>${esc(`${it.name}\n${fmtMs(it.dur)} from ${fmtMs(it.start)}${it.approx ? ' (start unknown)' : ''}`)}</title>`;
          const txt = it.name;
          const cw = bh >= 16 ? 6.3 : 5.6;
          const need = txt.length * cw + 8;
          const nextX = n + 1 < list.length ? X(list[n + 1].start) : labelW + pw + 400;
          if (bh >= 10) {
            if (w >= need) s += `<text class="bl in" x="${Math.max(x0, labelW) + 4}" y="${y + bh / 2 + 3.5}">${esc(txt)}</text>`;
            else if (nextX - x1 >= need + 2 && x1 + 3 > labelW) s += `<text class="bl out" x="${x1 + 3}" y="${y + bh / 2 + 3.5}">${esc(txt)} <tspan class="d">${esc(fmtMs(it.dur))}</tspan></text>`;
            else if (w >= 5 * cw + 8) {
              const fitN = Math.floor((w - 8) / cw);
              s += `<text class="bl in" x="${Math.max(x0, labelW) + 4}" y="${y + bh / 2 + 3.5}">${esc(txt.slice(0, fitN - 1) + '…')}</text>`;
            }
          }
          if (it.tone === 'bad') s += `<text class="bang" x="${x0 - 2}" y="${y + bh / 2 + 3.5}" text-anchor="end">!</text>`;
          s += '</g>';
        });
      }
    }
    // silence lane
    const maxDt = Math.max(T.gapMs * 2, 1000, ...T.deltas.map((d) => d[1]));
    const decades = Math.max(3, Math.ceil(Math.log10(maxDt)));
    const Ys = (dt) => G.silY + G.silH - 4 - (clamp(Math.log10(Math.max(dt, 1)), 0, decades) / decades) * (G.silH - 10);
    G.Ys = Ys; G.decades = decades;
    for (let k = 0; k <= decades; k++) {
      const y = Ys(10 ** k);
      s += `<line class="sil-grid" x1="${labelW}" x2="${labelW + pw}" y1="${y}" y2="${y}"/>`;
    }
    for (const d of T.deltas) {
      if (d[0] + d[1] < view.a || d[0] > view.b) continue;
      const x = X(d[0] + d[1]);
      const big = d[1] >= T.gapMs;
      s += `<line class="stem${big ? ' big' : ''}" x1="${x}" x2="${x}" y1="${Ys(1)}" y2="${Ys(d[1])}"/>`;
    }
    s += '</g>';
    for (let k = 0; k <= decades; k++) {
      const y = Ys(10 ** k);
      const lbl = k < 3 ? `${10 ** k} ms` : `${10 ** (k - 3)} s`;
      if (labelW < 100) { if (k % 3 === 0) s += `<text class="sil-ax" x="${labelW + 3}" y="${y - 2}">${lbl}</text>`; } else s += `<text class="sil-ax" x="${labelW - 4}" y="${y + 3}" text-anchor="end">${lbl}</text>`;
    }
    // lane labels and separators
    for (const l of G.lanes) {
      const L = G.laneY[l.id];
      s += `<line class="sep" x1="0" x2="${labelW + pw}" y1="${L.y}" y2="${L.y}"/>`;
      s += `<rect class="lane-sw ${LANE_CLASS[l.id]}" x="4" y="${L.y + 6}" width="4" height="${Math.max(8, L.h - 12)}" rx="1"/>`;
      s += `<text class="lane-l" x="12" y="${L.y + Math.min(L.h / 2, 14) + 4}">${esc(labelW < 100 ? l.label.replace('Driver probes', 'Probes').replace('Milestones', 'Marks') : l.label)}</text>`;
      if (l.rows > 1 && L.h > 30) s += `<text class="lane-n" x="12" y="${L.y + Math.min(L.h / 2, 14) + 16}">${l.rows} rows</text>`;
    }
    s += `<line class="sep" x1="0" x2="${labelW + pw}" y1="${G.lanesEnd}" y2="${G.lanesEnd}"/>`;
    s += `<text class="lane-l" x="12" y="${G.silY + 14}">Silence</text>${labelW < 100 ? '' : `<text class="lane-n" x="12" y="${G.silY + 26}">between lines</text>`}`;
    content.innerHTML = s;
    // threshold handle (kept as one element so it keeps focus)
    const ty = Ys(T.gapMs);
    handle.innerHTML = `<line class="thr-hit" x1="${labelW}" x2="${labelW + pw}" y1="${ty}" y2="${ty}"/><line class="thr" x1="${labelW}" x2="${labelW + pw}" y1="${ty}" y2="${ty}"/>`
      + `<g transform="translate(${labelW + pw - 70},${ty - 9})"><rect class="thr-k" width="68" height="18" rx="9"/><text class="thr-t" x="34" y="12.5" text-anchor="middle">≥ ${esc(fmtMs(T.gapMs))}</text></g>`;
    handle.setAttribute('aria-valuenow', String(T.gapMs));
    handle.setAttribute('aria-valuetext', `${fmtMs(T.gapMs)}`);
    const vt = document.getElementById('blt-viewtxt');
    if (vt) vt.textContent = `${fmtMs(view.a)} to ${fmtMs(view.b)} · ${fmtMs(view.b - view.a)} shown`;
  }

  // pointer: pan, brush, click
  svg.addEventListener('pointerdown', (e) => {
    if (!geo || !view || e.button > 0) return;
    if (e.target.closest('.blt-thr')) return;
    const r = svg.getBoundingClientRect();
    const sx = geo.W / r.width;
    const px = (e.clientX - r.left) * sx, py = (e.clientY - r.top) * sx;
    if (px < geo.labelW) return;
    const toT = (cx) => view.a + (((cx - r.left) * sx - geo.labelW) / geo.pw) * (view.b - view.a);
    const brush = py < 22;
    const v0 = { ...view }, t0 = toT(e.clientX);
    let moved = false, band = null;
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic or ended pointer */ }
    const move = (ev) => {
      if (Math.abs(ev.clientX - e.clientX) > 3) moved = true;
      if (!moved) return;
      if (brush) {
        const x0 = Math.min(px, (ev.clientX - r.left) * sx), x1 = Math.max(px, (ev.clientX - r.left) * sx);
        if (!band) { band = sv('rect', { class: 'brush', y: 0, height: geo.H }); svg.append(band); }
        band.setAttribute('x', x0); band.setAttribute('width', Math.max(1, x1 - x0));
      } else {
        const dt = ((ev.clientX - e.clientX) * sx / geo.pw) * (v0.b - v0.a);
        setView(v0.a - dt, v0.b - dt);
      }
    };
    const up = (ev) => {
      svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); svg.removeEventListener('pointercancel', up);
      if (band) { band.remove(); const t1 = toT(ev.clientX); if (Math.abs(t1 - t0) > 0) setView(Math.min(t0, t1), Math.max(t0, t1)); }
      else if (!moved) {
        const hit = e.target.closest && e.target.closest('[data-id]');
        if (hit) select(hit.getAttribute('data-id'), { reveal: false });
      }
      svg.focus({ preventScroll: true });
    };
    svg.addEventListener('pointermove', move); svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
    e.preventDefault();
  });
  svg.addEventListener('wheel', (e) => {
    if (!geo || !view) return;
    const r = svg.getBoundingClientRect();
    const sx = geo.W / r.width;
    const px = (e.clientX - r.left) * sx;
    if (px < geo.labelW) return;
    e.preventDefault();
    const at = view.a + ((px - geo.labelW) / geo.pw) * (view.b - view.a);
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { const dt = (e.deltaX / geo.pw) * (view.b - view.a); setView(view.a + dt, view.b + dt); return; }
    zoomBy(Math.exp(clamp(e.deltaY, -200, 200) * 0.0022), at);
  }, { passive: false });
  svg.addEventListener('dblclick', (e) => { if (!e.target.closest('[data-id]')) fit(); });
  svg.addEventListener('pointermove', (e) => {
    const hit = e.target.closest && e.target.closest('[data-id]');
    const id = hit ? hit.getAttribute('data-id') : null;
    if (id !== hoverId) { setHover(id); }
  });
  svg.addEventListener('pointerleave', () => setHover(null));
  function setHover(id) {
    hoverId = id;
    for (const el of content.querySelectorAll('.hov')) el.classList.remove('hov');
    if (id) for (const el of content.querySelectorAll(`[data-id="${id}"]`)) el.classList.add('hov');
    for (const el of wrap.querySelectorAll('.blt-row.hov')) el.classList.remove('hov');
    if (id) for (const el of wrap.querySelectorAll(`.blt-row[data-id="${id}"]`)) el.classList.add('hov');
  }
  const navOrder = () => [...T.items.filter((i) => !hidden.has(i.lane)), ...T.gaps].sort((p, q) => (p.start ?? p.from) - (q.start ?? q.from));
  svg.addEventListener('keydown', (e) => {
    if (!view || !T) return;
    const span = view.b - view.a;
    if (e.key === 'ArrowLeft') setView(view.a - span * 0.15, view.b - span * 0.15);
    else if (e.key === 'ArrowRight') setView(view.a + span * 0.15, view.b + span * 0.15);
    else if (e.key === '+' || e.key === '=') zoomBy(1 / 1.5);
    else if (e.key === '-' || e.key === '_') zoomBy(1.5);
    else if (e.key === '0' || e.key === 'Home') fit();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'j' || e.key === 'k') {
      const list = navOrder();
      let n = list.findIndex((x) => x.id === sel);
      n = e.key === 'ArrowDown' || e.key === 'j' ? n + 1 : n < 0 ? list.length - 1 : n - 1;
      n = clamp(n, 0, list.length - 1);
      if (list[n]) select(list[n].id);
    } else if (e.key === 'Enter') zoomToSel();
    else if (e.key === 'Escape') select(null);
    else return;
    e.preventDefault();
  });

  // threshold handle
  let thrPending = null, thrRaf = 0;
  const pushThr = (v) => {
    thrPending = v;
    if (thrRaf) return;
    thrRaf = requestAnimationFrame(() => { thrRaf = 0; if (thrPending != null) ctx.set('gap', thrPending); thrPending = null; });
  };
  const niceThr = (v) => { const p = 10 ** Math.floor(Math.log10(v)); return Math.max(1, Math.round(v / p * 4) / 4 * p); };
  handle.addEventListener('pointerdown', (e) => {
    if (!geo) return;
    const r = svg.getBoundingClientRect();
    const sx = geo.W / r.width;
    try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic or ended pointer */ }
    handle.classList.add('drag');
    const move = (ev) => {
      const y = (ev.clientY - r.top) * sx;
      const frac = (geo.silY + geo.silH - 4 - y) / (geo.silH - 10);
      const v = 10 ** (clamp(frac, 0, 1) * geo.decades);
      pushThr(Number(niceThr(v).toPrecision(3)));
    };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); handle.classList.remove('drag'); handle.focus({ preventScroll: true }); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
    e.preventDefault(); e.stopPropagation();
  });
  handle.addEventListener('keydown', (e) => {
    if (!T) return;
    const f = e.shiftKey ? 2 : 1.25;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') ctx.set('gap', Number(niceThr(T.gapMs * f).toPrecision(3)));
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') ctx.set('gap', Number(Math.max(1, niceThr(T.gapMs / f)).toPrecision(3)));
    else return;
    e.preventDefault();
  });

  // ---------- side: detail, lists ----------
  function lineRow(j, focus) {
    const t = T.times[j];
    return h('div', { class: `blt-dl${focus ? ' f' : ''}`, onclick: () => { cursor = j; markLog(true, j); } },
      h('span', { class: 'n' }, String(j + 1)), h('span', { class: 't' }, t == null ? '' : fmtAt(t)), h('span', { class: 'x' }, shown(T.lines[j], t)));
  }
  function drawDetail() {
    detail.replaceChildren();
    const it = sel && byId.get(sel);
    if (!T) return;
    if (!it) {
      detail.append(h('p', { class: 'blt-empty' }, 'Click a bar, a hatched gap, a row of the lists or a log line.'));
      return;
    }
    if (it.cause != null) {
      detail.append(
        h('div', { class: 'blt-dh' }, h('i', { class: 'sw sw-gap' }), h('b', {}, `${fmtMs(it.dur)} with nothing logged`)),
        h('div', { class: 'blt-kv' }, kv('from', fmtMs(it.from)), kv('to', fmtMs(it.to)), kv('lines', `${it.before + 1}–${it.after + 1}`)),
        h('p', { class: 'blt-info' }, `Likely: ${it.cause}.`),
        h('div', { class: 'blt-dlines' }, lineRow(it.before, true), h('div', { class: 'blt-dgap' }, `⋯ ${fmtMs(it.dur)} ⋯`), lineRow(it.after, true)));
      return;
    }
    const stage = T.stages.find((s) => it.start >= s.from - 0.001 && it.start < s.from + s.dur);
    const share = stage && stage.dur > 0 && it.dur > 0 ? ` · ${Math.round((it.dur / stage.dur) * 100)}% of ${stage.name.toLowerCase()}` : '';
    const tone = it.tone === 'bad' ? h('span', { class: 'pill bad' }, 'failed') : it.tone === 'warn' ? h('span', { class: 'pill warn' }, it.open ? 'no end' : 'deferred') : null;
    const ls = it.lines.slice(0, 16);
    const rows = [];
    let prev = null;
    for (const j of ls) { if (prev != null && j > prev + 1) rows.push(h('div', { class: 'blt-dgap' }, '⋯')); rows.push(lineRow(j, j === it.focus)); prev = j; }
    if (it.lines.length > ls.length) rows.push(h('div', { class: 'blt-dgap' }, `+ ${it.lines.length - ls.length} more lines`));
    detail.append(
      h('div', { class: 'blt-dh' }, h('i', { class: `sw ${LANE_CLASS[it.lane]}` }), h('b', { title: it.name }, it.name), tone),
      h('div', { class: 'blt-kv' }, kv(LANE_NAME[it.lane], ''), it.dur > 0 || !it.point ? kv('takes', fmtMs(it.dur)) : null, kv('from', fmtMs(it.start)), it.dur > 0 ? kv('to', fmtMs(it.start + it.dur)) : null),
      share ? h('div', { class: 'blt-share' }, share.slice(3)) : null,
      h('p', { class: 'blt-info' }, it.info || ''),
      h('div', { class: 'blt-dlines' }, rows));
  }
  const kv = (k, v) => h('span', {}, k, v ? h('b', {}, v) : null);

  function drawLists() {
    slowList.replaceChildren();
    const slow = T.slow.map((id) => byId.get(id)).filter(Boolean);
    const max = Math.max(1, ...slow.map((x) => x.dur));
    slow.forEach((it, n) => {
      slowList.append(h('button', { class: `blt-row${it.tone ? ' t-' + it.tone : ''}`, role: 'listitem', 'data-id': it.id, title: it.name,
        onclick: () => select(it.id), onpointerenter: () => setHover(it.id), onpointerleave: () => setHover(null) },
      h('span', { class: 'rk' }, String(n + 1)),
      h('span', { class: 'nm' }, h('i', { class: `sw ${LANE_CLASS[it.lane]}` }), h('span', {}, it.name)),
      h('span', { class: 'du' }, fmtMs(it.dur)),
      h('span', { class: 'mb' }, h('i', { class: LANE_CLASS[it.lane], style: `width:${Math.max(1, (it.dur / max) * 100)}%` }))));
    });
    if (!slow.length) slowList.append(h('p', { class: 'blt-empty' }, 'No timed items.'));
    gapList.replaceChildren();
    gapSub.textContent = `≥ ${fmtMs(T.gapMs)} · ${T.gaps.length}`;
    for (const g of T.gaps.slice(0, 30)) {
      gapList.append(h('button', { class: 'blt-row gp', role: 'listitem', 'data-id': g.id, title: g.cause,
        onclick: () => select(g.id), onpointerenter: () => setHover(g.id), onpointerleave: () => setHover(null) },
      h('span', { class: 'du' }, fmtMs(g.dur)), h('span', { class: 'at' }, `at ${fmtMs(g.from)}`), h('span', { class: 'cz' }, g.cause)));
    }
    if (!T.gaps.length) gapList.append(h('p', { class: 'blt-empty' }, `No stretch of ${fmtMs(T.gapMs)} or more without a line. Drag the threshold line down to see smaller ones.`));
    markLists();
  }
  function markLists() {
    for (const el of wrap.querySelectorAll('.blt-row')) el.classList.toggle('on', el.getAttribute('data-id') === sel);
  }

  // ---------- log ----------
  let logRows = [];
  function drawLog() {
    logRows = T.lines.map((text, j) => {
      const t = T.times[j];
      return h('div', { class: `blt-ll${T.lineLane[j] ? ' ll-' + T.lineLane[j] : ''}`, 'data-j': String(j), role: 'option' },
        h('span', { class: 'n' }, String(j + 1)), h('span', { class: 't' }, t == null ? '' : fmtAt(t)), h('span', { class: 'x' }, shown(text, t) || ' '));
    });
    logList.replaceChildren(...logRows);
    const timed = T.times.filter((t) => t != null).length;
    logSub.textContent = `${T.lines.length} lines · ${timed} timed · ${T.sources.join(', ')}`;
  }
  let marked = [];
  function markLog(scroll, only) {
    for (const el of marked) el.classList.remove('sel', 'f', 'cur');
    marked = [];
    const it = sel && byId.get(sel);
    const add = (j, c) => { const el = logRows[j]; if (el) { el.classList.add(c); marked.push(el); } };
    if (it) {
      if (it.cause != null) { add(it.before, 'sel'); add(it.after, 'sel'); add(it.after, 'f'); }
      else { for (const j of it.lines) add(j, 'sel'); add(it.focus, 'f'); }
    }
    if (only != null) cursor = only;
    if (cursor >= 0) add(cursor, 'cur');
    const target = only != null ? only : it ? (it.cause != null ? it.before : it.lines[0]) : null;
    if (scroll && target != null && logRows[target] && mode === 'lines') {
      const el = logRows[target];
      logList.scrollTop = Math.max(0, el.offsetTop - logList.offsetTop - 40);
    }
  }
  logList.addEventListener('click', (e) => {
    const row = e.target.closest('.blt-ll');
    if (!row) return;
    const j = Number(row.getAttribute('data-j'));
    cursor = j;
    const owner = T.lineItem[j] || T.gaps.find((g) => g.after === j || g.before === j)?.id || null;
    if (owner) select(owner, { scrollLog: false }); else markLog(false, j);
  });
  logList.addEventListener('keydown', (e) => {
    if (!T) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      cursor = clamp(cursor + (e.key === 'ArrowDown' ? 1 : -1), 0, T.lines.length - 1);
      markLog(false, cursor);
      const el = logRows[cursor];
      if (el) { const top = el.offsetTop - logList.offsetTop; if (top < logList.scrollTop + 20 || top > logList.scrollTop + logList.clientHeight - 30) logList.scrollTop = top - logList.clientHeight / 2; }
    } else if (e.key === 'Enter' && cursor >= 0) {
      const owner = T.lineItem[cursor] || T.gaps.find((g) => g.after === cursor || g.before === cursor)?.id || null;
      if (owner) select(owner, { scrollLog: false });
    } else return;
    e.preventDefault();
  });

  // ---------- header / warnings / legend ----------
  function drawStats() {
    const v = res.values || [];
    stats.replaceChildren(...v.slice(0, 6).map((x) => h('span', { class: x.tone ? `st-${x.tone}` : null, title: x.hint || '' }, x.label, ' ', h('b', {}, String(x.value)))));
  }
  function drawWarns() {
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, `Notes (${(res.notes || []).length})`), ...(res.notes || []).map((w) => h('div', {}, w)));
    notes.hidden = !(res.notes || []).length;
  }
  function drawLegend() {
    legend.replaceChildren(...T.lanes.map((l) => h('button', { class: 'blt-chip', 'aria-pressed': String(!hidden.has(l.id)), title: `Show or hide the ${l.label} lane`,
      onclick: () => { if (hidden.has(l.id)) hidden.delete(l.id); else hidden.add(l.id); drawLegend(); drawChart(); } },
    h('i', { class: `sw ${LANE_CLASS[l.id]}` }), l.label)),
    h('span', { class: 'blt-chip static' }, h('i', { class: 'sw sw-gap' }), 'gap'));
  }

  // ---------- results ----------
  ctx.onResult((r) => {
    res = r;
    T = r.timeline || null;
    const raw = ctx.raw;
    if (document.activeElement !== gapInput) gapInput.value = String(raw.gap ?? '');
    if (document.activeElement !== topInput) topInput.value = String(raw.top ?? '');
    if (mode === 'edit' && document.activeElement !== ta) ta.value = raw.log || '';
    drawStats(); drawWarns();
    if (!T) { content.innerHTML = ''; return; }
    byId = new Map([...T.items.map((i) => [i.id, i]), ...T.gaps.map((g) => [g.id, g])]);
    const key = `${T.lines.length}|${T.lines[0] || ''}|${T.lines[T.lines.length - 1] || ''}|${T.range.join(',')}`;
    if (key !== logKey) {
      logKey = key; view = null; cursor = -1;
      for (const l of [...hidden]) if (!T.lanes.some((x) => x.id === l)) hidden.delete(l);
      drawLog();
      sel = T.slow[0] || null;
    } else if (sel && !byId.has(sel)) {
      // a gap that vanished when the threshold moved
      sel = null;
    }
    drawLegend();
    if (!view) { const [lo, hi] = T.range; const pad = (hi - lo) * 0.02; view = { a: lo - pad, b: hi + pad }; }
    drawChart(); drawOverview(); drawLists(); drawDetail(); markLog(key === logKey);
  });

  const ro = new ResizeObserver(() => { if (T && view) { drawChart(); drawOverview(); } });
  ro.observe(svgBox); ro.observe(ovCard);
}
