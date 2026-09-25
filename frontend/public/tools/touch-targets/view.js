// Touch Target Checker page: the targets themselves, laid out at scale on an
// 8 dp grid - a bench of specimens.
//   Each specimen is the control's touch area drawn to size (1 dp = z px).
//   Where it is under the guideline's minimum, the missing padding is the red
//   hatched frame around it, labelled with how much each side needs. To its
//   right stands its nearest neighbour at the gap given, with the gap measured
//   on a dimension line; Material's 8 dp spacing is the amber band after the
//   padded edge, and where the padding would run into the neighbour the
//   overlap is red. WCAG AA's spacing exception draws the 24 px circle.
//   Drag the target's right / bottom edge or corner to resize it, drag the
//   neighbour to change the gap (Shift snaps to the 8 dp grid). Focused
//   specimen: arrows resize, [ and ] change the gap, Enter edits the name.
//   Under the bench: the selected target's fields, its verdict under all four
//   guidelines and the fix, then the kit's outputs.
// Every size, padding, gap and verdict drawn comes from run()'s
// result.specimens and result.rule.

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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v) => { const x = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(x) ? x : null; };

const GUIDES = [
  ['material', 'Material', '48 dp · 8 apart', 48],
  ['apple', 'Apple HIG', '44 pt', 44],
  ['wcagAA', 'WCAG AA', '24 px + spacing', 24],
  ['wcagAAA', 'WCAG AAA', '44 px', 44],
];
const UNITS = [['dp', 'dp'], ['pt', 'pt'], ['css', 'CSS px'], ['px', 'device px']];
const ZOOMS = [['fit', 'Fit'], ['1', '1×'], ['2', '2×'], ['3', '3×']];
const ALL_SHORT = { material: 'M', apple: 'A', wcagAA: 'AA', wcagAAA: 'AAA' };
const ALL_NAME = { material: 'Material 48', apple: 'Apple 44', wcagAA: 'WCAG AA 24', wcagAAA: 'WCAG AAA 44' };
const BLANK = { name: 'New target', w: '40', h: '40', gap: '8' };

export function page(root, ctx) {
  const F = (v, d = 3) => (v == null ? '–' : ctx.fmtNum(v, d));
  const state = { sel: 0, zoom: 'fit', z: 1.5, drag: null, refocus: null };
  const rowsNow = () => structuredClone(ctx.raw.targets || []);
  const setRows = (rows) => ctx.set('targets', rows);

  // ---------- skeleton ----------
  const guideSeg = h('div', { class: 'tt-guides', role: 'radiogroup', 'aria-label': 'Check against' });
  const unitSeg = h('div', { class: 'tt-seg', role: 'group', 'aria-label': 'Sizes are in' });
  const densIn = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Scale (devicePixelRatio)' });
  densIn.addEventListener('input', () => ctx.set('density', densIn.value));
  const densBox = h('label', { class: 'tt-fld' }, h('span', {}, 'scale ×'), densIn);
  const zoomSeg = h('div', { class: 'tt-seg', role: 'group', 'aria-label': 'Zoom' });
  const stats = h('div', { class: 'tt-stats', 'aria-live': 'polite' });
  const bench = h('div', { class: 'tt-bench', role: 'group', 'aria-label': 'Targets drawn to scale' });
  const scaleNote = h('span', { class: 'tt-scale' });
  const benchWrap = h('section', { class: 'tt-panel tt-benchp' },
    h('div', { class: 'tt-head' }, h('h2', {}, 'Targets at scale'), scaleNote, h('span', { class: 'tt-grow' }),
      h('span', { class: 'tt-lbl' }, 'Zoom'), zoomSeg),
    bench,
    h('div', { class: 'tt-legend' }));
  const insp = h('section', { class: 'tt-panel tt-insp' });
  const warns = h('div', { class: 'k-warns', role: 'alert' });
  const notes = h('div', { class: 'k-notes' });
  const all = h('details', { class: 'tt-panel tt-all' }, h('summary', {}, 'All targets as a table'), ctx.form);
  root.append(h('div', { class: 'tt' },
    h('div', { class: 'tt-top' }, guideSeg,
      h('div', { class: 'tt-units' }, h('span', { class: 'tt-lbl' }, 'Sizes in'), unitSeg, densBox), stats),
    benchWrap,
    h('div', { class: 'tt-bottom' }, h('div', { class: 'tt-col' }, insp, warns, all), h('div', { class: 'tt-col' }, ctx.outputs, notes))));
  benchWrap.querySelector('.tt-legend').innerHTML =
    '<span><i class="sw tgt"></i>touch area as given</span>'
    + '<span><i class="sw pad"></i>padding still needed</span>'
    + '<span><i class="sw nb"></i>nearest neighbour, at the gap</span>'
    + '<span><i class="sw band"></i>spacing the guideline asks for</span>'
    + '<span><i class="sw clash"></i>neighbour too close: it has to move out of the red</span>'
    + '<span>gap 16 → 4: what is left once the padding is added</span>'
    + '<span><i class="sw ring"></i>24 px spacing circle (WCAG AA)</span>'
    + '<span class="tt-keys">Drag an edge or corner to resize, the neighbour to change the gap (Shift: 8 dp steps) · focused: arrows resize, [ ] gap, Enter edits</span>';

  // ---------- helpers ----------
  const res = () => ctx.result || {};
  const rule = () => res().rule || null;
  const specs = () => res().specimens || [];
  const scale = () => rule()?.scale || 1;
  const unitName = () => rule()?.unit || (ctx.raw.unit === 'pt' ? 'pt' : ctx.raw.unit === 'css' ? 'px' : 'dp');
  const select = (i, focus) => {
    state.sel = i; render();
    if (focus) bench.querySelector(`.tt-spec[data-i="${i}"]`)?.focus({ preventScroll: true });
  };
  // Raw (as typed) values change; the page works in the rule's unit (dp).
  const setDims = (i, dims) => {
    const rows = rowsNow(); const r = rows[i]; if (!r) return;
    for (const [k, v] of Object.entries(dims)) r[k] = String(Math.round(v * 100) / 100);
    setRows(rows);
  };

  // ---------- one specimen ----------
  function specimen(s, R, z) {
    const u = unitName();
    const wrap = h('div', {
      class: `tt-spec${s.invalid ? ' invalid' : s.ok ? ' ok' : ' fail'}${s.i === state.sel ? ' is-sel' : ''}`,
      tabindex: 0, 'data-i': s.i, role: 'button', 'aria-pressed': String(s.i === state.sel),
      'aria-label': s.invalid ? `${s.name}: no valid size`
        : `${s.name}, ${F(s.w)} by ${F(s.h)} ${u}, gap ${s.g == null ? 'not given' : F(s.g)}: ${s.ok ? 'passes' : 'fails'}. Arrow keys resize, brackets change the gap, Enter edits.`,
    });
    const head = h('div', { class: 'tt-sh' }, h('span', { class: 'nm', title: s.name }, s.name));
    wrap.append(head);
    if (s.invalid) {
      wrap.append(h('div', { class: 'tt-inv' }, 'No valid width and height'));
      return wrap;
    }
    head.append(h('span', { class: 'dim' }, `${F(s.w)} × ${F(s.h)}`));
    const m = R.min;
    const padX = s.padX || 0, padY = s.padY || 0;
    const Rw = s.w + 2 * padX, Rh = s.h + 2 * padY;
    const px = (p) => p / z; // a size in screen px, in dp units
    const fs = px(10.5);
    const hasNb = s.g != null;
    const nbW = Math.max(px(12), 6);
    const bandGap = R.gap || 0;
    const gx = s.w + padX; // target's right edge (target starts at padX)
    const nbX = padX + s.w + (hasNb ? s.g : 0);
    const reach = hasNb ? Math.max(Rw, nbX + nbW, padX + s.w + padX + bandGap) : Rw;
    const ringR = R.spacing && Math.min(s.w, s.h) < 24 ? 12 : 0;
    const ml = Math.max(px(8), ringR ? Math.max(0, 12 - s.w / 2 - padX) + px(2) : 0);
    const mt = Math.max(px(8), ringR ? Math.max(0, 12 - s.h / 2 - padY) + px(2) : 0);
    const dimH = hasNb ? px(22) : px(6);
    const short = hasNb && s.left != null && R.gap && s.left < R.gap;
    const gapBad = hasNb && R.gap && s.g < R.gap;
    const lbl = hasNb ? `gap ${F(s.g)}${short && !gapBad ? ` → ${F(s.left)}` : ''}` : '';
    // room on the right for the gap label, which starts at the neighbour
    const lblEnd = hasNb ? Math.max(gx, nbX) + px(4) + lbl.length * fs * 0.62 : 0;
    const vbW = ml + Math.max(reach + px(10), lblEnd + px(4)) + (hasNb ? 0 : px(4));
    const vbH = mt + Math.max(Rh, s.h + 2 * ringR > Rh ? padY + s.h / 2 + ringR : 0) + dimH + px(4);
    const svg = sv('svg', { class: 'tt-svg', viewBox: `${-ml} ${-mt} ${vbW} ${vbH}`, width: (vbW * z).toFixed(1), height: (vbH * z).toFixed(1), 'aria-hidden': 'true' });
    const tx = padX, ty = padY;
    // padding needed: the frame around the target
    if (padX || padY) {
      svg.append(sv('rect', { x: 0, y: 0, width: Rw, height: Rh, class: 'tt-padr' }));
      if (padX >= px(12)) {
        svg.append(sv('text', { x: padX / 2, y: ty + s.h / 2 + fs * 0.35, class: 'tt-pl', 'text-anchor': 'middle', 'font-size': fs }, `+${F(padX)}`));
      }
      if (padY >= px(10) && Rw >= px(26)) {
        svg.append(sv('text', { x: Rw / 2, y: padY / 2 + fs * 0.35, class: 'tt-pl', 'text-anchor': 'middle', 'font-size': fs }, `+${F(padY)}`));
      }
    }
    // neighbour, gap and spacing band
    if (hasNb) {
      const nbTop = ty - Math.min(px(6), s.h * 0.15), nbH = s.h + 2 * Math.min(px(6), s.h * 0.15);
      // the guideline's spacing after the padded edge; wherever the neighbour
      // stands inside the padding or that spacing, the rest is red: the
      // neighbour has to move out to its end.
      const rEdge = padX + s.w + padX, need = rEdge + bandGap;
      if (bandGap && nbX > rEdge) svg.append(sv('rect', { x: rEdge, y: 0, width: Math.min(bandGap, nbX - rEdge), height: Rh, class: 'tt-band' }));
      if (nbX < need) svg.append(sv('rect', { x: nbX, y: 0, width: need - nbX, height: Rh, class: 'tt-clash' }));
      const nb = sv('g', { class: 'tt-nb', 'data-h': 'g' });
      nb.append(sv('rect', { x: nbX, y: nbTop, width: nbW, height: nbH, class: 'tt-nbr' }),
        sv('rect', { x: nbX - px(6), y: nbTop, width: nbW + px(12), height: nbH, class: 'tt-hit' }));
      nb.append(sv('title', {}, `Nearest neighbour, ${F(s.g)} ${u} away: drag to change the gap`));
      svg.append(nb);
      // dimension line for the gap
      const dy = Math.max(Rh, ty + nbH) + px(11);
      const x0 = gx, x1 = nbX;
      svg.append(sv('line', { x1: x0, x2: x0, y1: ty + s.h, y2: dy + px(4), class: 'tt-ext' }),
        sv('line', { x1: x1, x2: x1, y1: nbTop + nbH, y2: dy + px(4), class: 'tt-ext' }));
      if (x1 - x0 > 0) svg.append(sv('line', { x1: x0, x2: x1, y1: dy, y2: dy, class: 'tt-dimln' }));
      svg.append(sv('text', { x: Math.max(x0, x1) + px(4), y: dy + fs * 0.35, class: `tt-dim${gapBad || short ? ' bad' : ''}`, 'font-size': fs }, lbl));
    }
    // WCAG AA spacing circle
    if (ringR) svg.append(sv('circle', { cx: tx + s.w / 2, cy: ty + s.h / 2, r: ringR, class: `tt-ring${s.ok ? ' ok' : ''}` }));
    // the target
    svg.append(sv('rect', { x: tx, y: ty, width: s.w, height: s.h, rx: Math.min(px(3), s.w / 6, s.h / 6), class: 'tt-tgt' }));
    // passes on size: the minimum square drawn inside it, to show the slack
    if (!padX && !padY && Math.min(s.w, s.h) >= m) svg.append(sv('rect', { x: tx + (s.w - m) / 2, y: ty + (s.h - m) / 2, width: m, height: m, class: 'tt-minsq' }));
    // handles
    const gw = px(7), gl = Math.min(px(20), s.h * 0.8), gl2 = Math.min(px(20), s.w * 0.8);
    const hw = sv('g', { class: 'tt-hd', 'data-h': 'w' });
    hw.append(sv('rect', { x: tx + s.w - px(6), y: ty, width: px(12), height: s.h, class: 'tt-hit' }),
      sv('rect', { x: tx + s.w - gw / 2, y: ty + s.h / 2 - gl / 2, width: gw, height: gl, rx: gw / 2, class: 'tt-grip' }),
      sv('title', {}, 'Drag to change the width'));
    const hh = sv('g', { class: 'tt-hd', 'data-h': 'h' });
    hh.append(sv('rect', { x: tx, y: ty + s.h - px(6), width: s.w, height: px(12), class: 'tt-hit' }),
      sv('rect', { x: tx + s.w / 2 - gl2 / 2, y: ty + s.h - gw / 2, width: gl2, height: gw, rx: gw / 2, class: 'tt-grip' }),
      sv('title', {}, 'Drag to change the height'));
    const hc = sv('g', { class: 'tt-hd', 'data-h': 'wh' });
    hc.append(sv('rect', { x: tx + s.w - px(7), y: ty + s.h - px(7), width: px(14), height: px(14), class: 'tt-hit' }),
      sv('circle', { cx: tx + s.w, cy: ty + s.h, r: px(4.5), class: 'tt-corner' }),
      sv('title', {}, 'Drag to change width and height'));
    svg.append(hw, hh, hc);
    wrap.append(svg);
    // verdict row
    const why = s.ok ? (s.why === 'spacing exception' ? 'pass by spacing' : 'pass') : `fail · ${s.why}`;
    wrap.append(h('div', { class: 'tt-sf' },
      h('span', { class: `tt-tag ${s.ok ? 'ok' : 'bad'}` }, why),
      h('span', { class: 'tt-four', title: 'Material · Apple · WCAG AA · WCAG AAA' },
        Object.entries(s.all).map(([k, c]) => h('i', { class: c.ok ? 'ok' : 'bad', title: `${ALL_NAME[k]}: ${c.ok ? 'pass' : 'fail'} (${c.why})` }, ALL_SHORT[k])))));
    return wrap;
  }

  // ---------- bench ----------
  function fitZoom(list, R) {
    if (state.zoom !== 'fit') return +state.zoom;
    const avail = Math.max(200, bench.clientWidth - 28);
    // One very wide control (a full-width button) should not shrink the
    // rest: it is fitted to the bench on its own (max-width) instead.
    const ws = list.filter((s) => !s.invalid).map((s) => {
      const Rw = s.w + 2 * (s.padX || 0);
      return (s.g != null ? Math.max(Rw, s.w + (s.padX || 0) + s.g + 10, Rw + (R.gap || 0)) : Rw) + 30;
    }).sort((a, b) => a - b);
    const med = ws.length ? ws[Math.floor(ws.length / 2)] : 60;
    const widest = Math.max(60, ...ws.filter((w) => w <= 2.5 * med));
    return clamp(Math.floor((avail / widest) * 4) / 4, 0.5, 2);
  }
  function drawBench() {
    const R = rule();
    const list = specs();
    bench.replaceChildren();
    if (!R || !list.length) {
      bench.append(h('div', { class: 'tt-empty' }, res().warnings?.[0] || 'No targets yet.'),
        h('button', { class: 'k-btn', onclick: addTarget }, '+ Add target'));
      scaleNote.textContent = '';
      return;
    }
    const z = fitZoom(list, R);
    state.z = z;
    bench.style.setProperty('--tt-grid', `${8 * z}px`);
    scaleNote.textContent = `1 ${R.unit} = ${F(z, 3)} px · grid 8 ${R.unit}${R.scale !== 1 ? ` · device px ÷ ${F(R.scale)}` : ''}`;
    for (const s of list) bench.append(specimen(s, R, z));
    bench.append(h('button', { class: 'tt-add', onclick: addTarget, title: 'Add a target' }, '+ Add target'));
  }

  // pointer: resize by the edges, move the neighbour, click to select
  bench.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const spec = e.target.closest?.('.tt-spec'); if (!spec) return;
    const i = +spec.dataset.i;
    const hd = e.target.closest('[data-h]');
    const s = specs().find((x) => x.i === i);
    if (!hd || !s || s.invalid) { if (state.sel !== i) select(i); return; }
    e.preventDefault();
    try { bench.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const svgEl = spec.querySelector('.tt-svg');
    const zz = svgEl ? svgEl.getBoundingClientRect().width / svgEl.viewBox.baseVal.width : state.z;
    state.drag = { z: zz || state.z, i, k: hd.dataset.h, x0: e.clientX, y0: e.clientY, w: s.w, h: s.h, g: s.g ?? 0, last: '' };
    if (state.sel !== i) { state.sel = i; render(); }
    bench.classList.add('dragging');
  });
  bench.addEventListener('pointermove', (e) => {
    const d = state.drag; if (!d) return;
    const z = d.z, sc = scale();
    const snap = (v) => (e.shiftKey ? Math.max(8, Math.round(v / 8) * 8) : Math.max(1, Math.round(v)));
    const dx = (e.clientX - d.x0) / z, dy = (e.clientY - d.y0) / z;
    const dims = {};
    if (d.k === 'w' || d.k === 'wh') dims.w = snap(d.w + dx) * sc;
    if (d.k === 'h' || d.k === 'wh') dims.h = snap(d.h + dy) * sc;
    if (d.k === 'g') dims.gap = (e.shiftKey ? Math.max(0, Math.round((d.g + dx) / 8) * 8) : Math.max(0, Math.round(d.g + dx))) * sc;
    const key = JSON.stringify(dims);
    if (key !== d.last) { d.last = key; state.refocus = d.i; setDims(d.i, dims); }
  });
  const endDrag = (e) => {
    if (!state.drag) return;
    const i = state.drag.i; state.drag = null;
    bench.classList.remove('dragging');
    try { bench.releasePointerCapture(e.pointerId); } catch { /* released */ }
    bench.querySelector(`.tt-spec[data-i="${i}"]`)?.focus({ preventScroll: true });
  };
  bench.addEventListener('pointerup', endDrag);
  bench.addEventListener('pointercancel', endDrag);
  bench.addEventListener('focusin', (e) => {
    const spec = e.target.closest?.('.tt-spec');
    if (spec && +spec.dataset.i !== state.sel && !state.drag) { state.sel = +spec.dataset.i; state.refocus = state.sel; render(); }
  });
  bench.addEventListener('keydown', (e) => {
    const spec = e.target.closest?.('.tt-spec'); if (!spec) return;
    const i = +spec.dataset.i; const s = specs().find((x) => x.i === i);
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i); insp.querySelector('input')?.focus(); return; }
    if (!s || s.invalid) return;
    const step = e.shiftKey ? 8 : 1, sc = scale();
    let dims = null;
    if (e.key === 'ArrowRight') dims = { w: s.w + step };
    else if (e.key === 'ArrowLeft') dims = { w: Math.max(1, s.w - step) };
    else if (e.key === 'ArrowDown') dims = { h: s.h + step };
    else if (e.key === 'ArrowUp') dims = { h: Math.max(1, s.h - step) };
    else if (e.key === ']') dims = { gap: (s.g ?? 0) + step };
    else if (e.key === '[') dims = { gap: Math.max(0, (s.g ?? 0) - step) };
    if (!dims) return;
    e.preventDefault();
    for (const k of Object.keys(dims)) dims[k] *= sc;
    state.refocus = i; setDims(i, dims);
  });

  // ---------- inspector ----------
  const fld = {};
  function field(key, label, wide) {
    const inp = h('input', { type: 'text', spellcheck: 'false', inputmode: key === 'name' ? null : 'decimal', 'aria-label': label });
    inp.addEventListener('input', () => { const rows = rowsNow(); if (!rows[state.sel]) return; rows[state.sel][key] = inp.value; setRows(rows); });
    fld[key] = inp;
    return h('label', { class: `tt-if${wide ? ' wide' : ''}` }, h('span', {}, label), inp);
  }
  const unitTags = [];
  const utag = () => { const t = h('small', {}); unitTags.push(t); return t; };
  const inspHead = h('div', { class: 'tt-head' });
  const inspFields = h('div', { class: 'tt-ifs' },
    field('name', 'Name', true),
    h('div', { class: 'tt-num' }, field('w', 'Width'), utag()),
    h('div', { class: 'tt-num' }, field('h', 'Height'), utag()),
    h('div', { class: 'tt-num' }, field('gap', 'Gap to nearest'), utag()));
  const inspBody = h('div', { class: 'tt-ib' });
  insp.append(inspHead, h('div', { class: 'tt-ibody' }, inspFields, inspBody));

  function drawInspector() {
    const rows = ctx.raw.targets || [];
    const r = rows[state.sel];
    const s = specs().find((x) => x.i === state.sel);
    const R = rule();
    inspHead.replaceChildren(h('h2', {}, 'Selected target'), h('span', { class: 'tt-sub' }, r ? `${state.sel + 1} of ${rows.length}` : ''),
      h('span', { class: 'tt-grow' }),
      h('button', { class: 'k-btn', onclick: addTarget }, '+ Add'),
      r ? h('button', { class: 'k-btn tt-danger', onclick: delTarget, title: 'Remove this target' }, 'Remove') : null);
    inspFields.hidden = !r;
    if (!r) { inspBody.replaceChildren(h('div', { class: 'tt-empty' }, 'Click a target on the bench.')); return; }
    for (const k of ['name', 'w', 'h', 'gap']) {
      if (document.activeElement !== fld[k]) fld[k].value = r[k] ?? '';
      if (k !== 'name') fld[k].classList.toggle('bad', String(r[k] ?? '').trim() !== '' && num(r[k]) == null);
    }
    const rawU = { dp: 'dp', pt: 'pt', css: 'px', px: 'device px' }[ctx.raw.unit] || 'dp';
    for (const t of unitTags) t.textContent = rawU;
    if (!s || s.invalid || !R) { inspBody.replaceChildren(h('div', { class: 'tt-empty bad' }, 'Give a width and a height above zero.')); return; }
    const verdicts = h('div', { class: 'tt-vd' }, Object.entries(s.all).map(([k, c]) =>
      h('button', { class: `tt-v ${c.ok ? 'ok' : 'bad'}${k === R.key ? ' cur' : ''}`, type: 'button', 'aria-pressed': String(k === R.key),
        title: `Check against ${ALL_NAME[k]}`, onclick: () => ctx.set('guideline', k) },
      h('span', {}, ALL_NAME[k]), h('b', {}, c.ok ? 'pass' : 'fail'), h('em', {}, c.why))));
    const canFix = !s.ok;
    inspBody.replaceChildren(
      h('div', { class: 'tt-sec' }, `Against each guideline${R.unit !== rawU ? ` (in ${R.unit})` : ''}`), verdicts,
      h('div', { class: `tt-fix${s.ok ? ' ok' : ''}` },
        s.ok ? `Passes ${R.name}${s.why === 'spacing exception' ? ' by the spacing exception' : ''}.` : `Fix: ${s.fix}.`,
        canFix ? h('button', { class: 'k-btn k-primary', onclick: () => applyFix(s, R), title: 'Set the touch area to the minimum and the gap to what is left, or to the guideline spacing' }, 'Apply fix') : null));
  }
  function applyFix(s, R) {
    const sc = scale();
    const dims = { w: (s.w + 2 * (s.padX || 0)) * sc, h: (s.h + 2 * (s.padY || 0)) * sc };
    if (s.g != null) dims.gap = Math.max(s.left ?? s.g, R.gap || 0) * sc;
    state.refocus = s.i; setDims(s.i, dims);
  }
  function addTarget() {
    const rows = rowsNow(); rows.push({ ...BLANK });
    state.sel = rows.length - 1; setRows(rows);
    fld.name.focus(); fld.name.select();
  }
  function delTarget() {
    const rows = rowsNow(); if (!rows[state.sel]) return;
    rows.splice(state.sel, 1); state.sel = Math.max(0, state.sel - 1); setRows(rows);
  }

  // ---------- header ----------
  function drawTop() {
    const g = ctx.raw.guideline || 'material';
    guideSeg.replaceChildren(...GUIDES.map(([k, t, sub, m]) => {
      const s = 10 + (m / 48) * 16;
      return h('button', { type: 'button', role: 'radio', 'aria-checked': String(g === k), class: 'tt-g', onclick: () => ctx.set('guideline', k) },
        h('span', { class: 'sq', style: `width:${s}px;height:${s}px` }),
        h('span', { class: 't' }, h('b', {}, t), h('small', {}, sub)));
    }));
    const u = ctx.raw.unit || 'dp';
    unitSeg.replaceChildren(...UNITS.map(([k, t]) => h('button', { type: 'button', 'aria-pressed': String(u === k), onclick: () => ctx.set('unit', k) }, t)));
    densBox.hidden = u !== 'px';
    if (document.activeElement !== densIn) densIn.value = ctx.raw.density ?? '';
    zoomSeg.replaceChildren(...ZOOMS.map(([k, t]) => h('button', { type: 'button', 'aria-pressed': String(state.zoom === k),
      onclick: () => { state.zoom = k; render(); } }, t)));
    const vals = res().values || [];
    stats.replaceChildren(...vals.map((v) => h('div', { class: `tt-stat${v.tone ? ` ${v.tone}` : ''}` },
      h('span', {}, v.label), h('b', {}, typeof v.value === 'number' ? F(v.value, 4) : String(v.value), v.unit ? h('small', {}, ` ${v.unit}`) : null),
      v.hint ? h('em', {}, v.hint) : null)));
  }

  function render() {
    const r = res();
    const rows = ctx.raw.targets || [];
    if (state.sel >= rows.length) state.sel = Math.max(0, rows.length - 1);
    const act = document.activeElement;
    const refocus = state.refocus ?? (act?.classList?.contains('tt-spec') ? +act.dataset.i : null);
    state.refocus = null;
    drawTop();
    drawBench();
    drawInspector();
    warns.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    warns.hidden = !(r.warnings || []).length;
    notes.replaceChildren(...(r.notes || []).map((w) => h('div', {}, w)));
    if (refocus != null && (state.drag || act === document.body || act?.classList?.contains('tt-spec') || !act)) {
      bench.querySelector(`.tt-spec[data-i="${refocus}"]`)?.focus({ preventScroll: true });
    }
  }
  let lastW = 0;
  new ResizeObserver(() => {
    const w = bench.clientWidth;
    if (Math.abs(w - lastW) > 8 && !state.drag) { lastW = w; requestAnimationFrame(() => { if (ctx.result) render(); }); }
  }).observe(bench);
  ctx.onResult(() => render());
}
