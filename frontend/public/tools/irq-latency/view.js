// Interrupt Latency Budget, drawn as the thing itself: the CPU's worst case.
//   CPU second - one second of CPU as a bar: each interrupt's share (its
//                entry/exit overhead hatched) and what is left for the main
//                loop. Click a share to pick that interrupt.
//   Schedule   - one lane per interrupt, most urgent on top, for the worst
//                case of the picked one: the blocker runs first, everything
//                of higher or equal priority fires at t = 0 and again every
//                period, the picked handler runs last and finishes at R.
//                Drag the end of any block to change that handler's time,
//                drag the next-event tick to change its rate, drag the
//                deadline flag, drag a priority chip up or down; the end of
//                the interrupts-off block is the critical section length.
//   Inspector  - the picked interrupt's fields and figures, then warnings
//                and the output panel.
// Every time, load, slack and verdict shown comes from run()'s result.drawing
// (the schedule is its trace, not worked out here).

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

const niceCeil = (v) => {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1e-9)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v - 1e-9) return m * p;
  return 10 * p;
};
const niceStep = (range, px) => {
  const target = range / Math.max(2, Math.floor(px / 80));
  const p = 10 ** Math.floor(Math.log10(target));
  for (const m of [1, 2, 5, 10]) if (m * p >= target) return m * p;
  return 10 * p;
};
const num = (v, sig = 4) => String(Number(Number(v).toPrecision(sig)));
const col = (k) => `var(--tool-c${((k % 8) + 8) % 8})`;

export function page(root, ctx) {
  const f = ctx.fmtNum;
  const us = (v) => (v == null ? 'unbounded' : `${f(v, 4)} µs`);
  const hz = (v) => (v >= 1e6 ? `${f(v / 1e6, 4)} MHz` : v >= 1e3 ? `${f(v / 1e3, 4)} kHz` : `${f(v, 4)} Hz`);
  const byKey = Object.fromEntries(ctx.manifest.inputs.map((d) => [d.key, d]));

  const wrap = h('div', { class: 'irq' });
  root.append(wrap);

  // ---------- the core ----------
  const fields = {};
  const text = (key, label, width) => {
    const el = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', title: byKey[key].help || '', style: width ? `width:${width}px` : null,
      oninput: (e) => ctx.set(key, e.target.value) });
    fields[key] = el;
    return h('label', {}, `${label}${byKey[key].unit ? ` (${byKey[key].unit})` : ''}`, el);
  };
  const coreSel = h('select', { onchange: (e) => ctx.set('core', e.target.value) }, byKey.core.options.map(([v, t]) => h('option', { value: v }, t)));
  const entryLab = text('entry', 'Entry + exit cycles', 70);
  const modeSeg = h('div', { class: 'irq-seg', role: 'group', 'aria-label': 'Nesting' },
    h('button', { 'data-v': 'nested', title: 'A lower priority number preempts', onclick: () => ctx.set('mode', 'nested') }, 'Nested'),
    h('button', { 'data-v': 'flat', title: 'No preemption: all one level', onclick: () => ctx.set('mode', 'flat') }, 'Flat'));
  const ovText = h('span', { class: 'irq-ov' });
  const core = h('section', { class: 'irq-core', 'aria-label': 'Core' },
    text('fclk', 'CPU clock'), h('label', {}, 'Core (entry / exit cycles)', coreSel), entryLab, text('ws', 'Extra cycles', 60),
    h('label', {}, 'Nesting', modeSeg), text('crit', 'Interrupts off', 70), ovText);

  // ---------- CPU second ----------
  const budSvg = s('svg', { class: 'irq-svg', role: 'img', 'aria-label': 'CPU share of each interrupt' });
  const budSub = h('span', { class: 'irq-sub' });
  const budget = h('section', { class: 'irq-card' }, h('div', { class: 'irq-head' }, h('h2', {}, 'One second of CPU'), budSub), budSvg);

  // ---------- schedule ----------
  const schSvg = s('svg', { class: 'irq-svg', role: 'group', 'aria-label': 'Worst-case schedule' });
  const schTitle = h('h2', {});
  const schSub = h('span', { class: 'irq-sub' });
  const fitBtn = h('button', { class: 'k-btn', onclick: () => { fitAll = !fitAll; drawSchedule(); } });
  const schedule = h('section', { class: 'irq-card' },
    h('div', { class: 'irq-head' }, schTitle, schSub, h('span', { class: 'irq-right' }, fitBtn)),
    schSvg,
    h('div', { class: 'irq-help' }, 'Click a lane to see its worst case. Drag the end of a block to change that handler\'s time, the ',
      h('b', {}, '▾'), ' tick to change its rate, the deadline flag, or a priority chip up and down. Focused handles take ',
      h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' (', h('kbd', {}, 'Shift'), ' ×10); chips ', h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), '.'));

  // ---------- inspector ----------
  const inspTitle = h('h2', {});
  const inspBody = h('div', { class: 'irq-insp' });
  const figs = h('div', { class: 'irq-figs' });
  const verdict = h('div', { class: 'irq-verdict', role: 'status' });
  const addBtn = h('button', { class: 'k-btn', onclick: () => {
    const rows = ctx.raw.irqs.map((r) => ({ ...r }));
    rows.push({ name: `IRQ ${rows.length + 1}`, prio: '4', rate: '1k', time: '2', deadline: '' });
    sel = rows.length - 1;
    ctx.set('irqs', rows);
  } }, '+ Interrupt');
  const insp = h('section', { class: 'irq-card' }, h('div', { class: 'irq-head' }, inspTitle, h('span', { class: 'irq-right' }, addBtn)), inspBody, figs, verdict);
  const warns = h('div', { class: 'irq-warns', role: 'status', 'aria-live': 'polite' });
  const notes = h('details', { class: 'irq-notes' }, h('summary', {}, 'How it is worked out'));

  wrap.append(core, budget, h('div', { class: 'irq-grid' },
    h('div', { class: 'irq-col' }, schedule, notes),
    h('div', { class: 'irq-col' }, insp, warns, ctx.outputs)));

  let res = null, sel = null, fitAll = false, frozen = null, dragging = false;
  const D = () => res && res.drawing;
  const pick = () => {
    const d = D();
    if (!d) return null;
    let x = d.irqs.find((q) => q.k === sel);
    if (!x) {
      // the least slack relative to the deadline, as the tool reports it
      // the worst one when something fails, else the least urgent: its
      // worst case has every other interrupt in it
      const failing = d.irqs.filter((q) => q.lost || q.miss);
      x = failing.length ? [...failing].sort((a, b) => ((a.slack ?? -Infinity) / a.D) - ((b.slack ?? -Infinity) / b.D))[0]
        : [...d.irqs].sort((a, b) => b.prio - a.prio || b.k - a.k)[0];
      sel = x ? x.k : null;
    }
    return x;
  };

  // Table edits: one row of the irqs input.
  const setRow = (k, patch) => {
    const rows = ctx.raw.irqs.map((r) => ({ ...r }));
    if (!rows[k]) return;
    Object.assign(rows[k], patch);
    ctx.set('irqs', rows);
  };
  const setHandler = (k, v) => setRow(k, { time: num(Math.max(0, Math.round(v * 100) / 100)) });
  const setRate = (k, T) => setRow(k, { rate: num(1e6 / Math.max(0.05, T), 4) });
  const setDeadline = (k, v) => setRow(k, { deadline: num(Math.max(0.1, Math.round(v * 10) / 10)) });

  const drag = (move, done) => {
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      dragging = false;
      done && done();
    };
    dragging = true;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  let focusId = null;
  const refocus = (svg) => {
    if (!focusId) return;
    const el = svg.querySelector(`[data-id="${focusId}"]`);
    if (el) el.focus({ preventScroll: true });
  };
  const trackFocus = (el, id) => {
    el.setAttribute('data-id', id);
    el.addEventListener('focus', () => { focusId = id; });
    el.addEventListener('keydown', () => { focusId = id; }, true);
    el.addEventListener('pointerdown', () => { focusId = id; }, true);
    el.addEventListener('blur', () => { if (!dragging) setTimeout(() => { if (!schSvg.contains(document.activeElement)) focusId = null; }, 0); });
  };

  // ---------- CPU second ----------
  function drawBudget() {
    budSvg.replaceChildren();
    const d = D();
    const W = Math.max(300, budSvg.clientWidth || budget.clientWidth || 800);
    const H = 64, L = 10, R = 10, y = 22, bh = 22;
    budSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    budSvg.setAttribute('height', H);
    if (!d) { budSub.textContent = ''; return; }
    const X = (u) => L + Math.min(u, 1) * (W - L - R);
    const defs = s('defs');
    const pat = s('pattern', { id: 'irq-hatch', width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(s('rect', { width: 5, height: 5, fill: 'var(--surface)', 'fill-opacity': 0.35 }), s('line', { x1: 0, y1: 0, x2: 0, y2: 5, stroke: 'var(--surface)', 'stroke-width': 2.2 }));
    defs.append(pat);
    budSvg.append(defs);
    budSvg.append(s('rect', { x: L, y, width: W - L - R, height: bh, rx: 3, fill: 'var(--tool-main)' }));
    const order = [...d.irqs].sort((a, b) => a.prio - b.prio || a.k - b.k);
    let u = 0;
    for (const x of order) {
      const xa = X(u), xb = X(u + x.load);
      const w = Math.max(0.8, xb - xa);
      const g = s('g', { class: 'seg' });
      g.append(s('title', {}, `${x.name}: ${f(x.load * 100, 3)} % of the CPU (${f(x.ovLoad * 100, 3)} % of it entry/exit)`));
      g.append(s('rect', { x: xa, y, width: w, height: bh, fill: col(x.k), 'fill-opacity': x.k === sel ? 1 : 0.8 }));
      const ow = Math.min(w, X(x.ovLoad) - L);
      if (ow > 0.5) g.append(s('rect', { x: xa + w - ow, y, width: ow, height: bh, fill: 'url(#irq-hatch)' }));
      if (x.k === sel) g.append(s('rect', { x: xa, y: y - 3, width: w, height: bh + 6, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.5 }));
      g.addEventListener('click', () => { sel = x.k; draw(); });
      budSvg.append(g);
      const lab = `${x.name.split(' ')[0]} ${f(x.load * 100, 2)}%`;
      if (w > lab.length * 6.3 + 6) budSvg.append(s('text', { x: xa + 4, y: y + 15, class: 'small', style: 'fill:var(--surface);pointer-events:none' }, lab));
      u += x.load;
    }
    // what is left
    if (u < 1) {
      const lab = `main loop ${f((1 - u) * 100, 3)} %`;
      if (X(1) - X(u) > lab.length * 6.3 + 8) budSvg.append(s('text', { x: X(1) - 6, y: y + 15, 'text-anchor': 'end', class: 'small soft' }, lab));
    } else {
      budSvg.append(s('rect', { x: L, y, width: W - L - R, height: bh, fill: 'none', stroke: 'var(--danger)', 'stroke-width': 2 }));
    }
    // limits
    for (const [p, t, c] of [[0.5, '50 %', 'var(--ink-soft)'], [0.7, '70 %', 'var(--warn)'], [1, '100 %', 'var(--danger)']]) {
      const x = X(p);
      budSvg.append(s('line', { x1: x, x2: x, y1: y - 6, y2: y + bh + 4, stroke: c, 'stroke-dasharray': p < 1 ? '3 2' : null, 'stroke-width': 1.2 }));
      budSvg.append(s('text', { x: p < 1 ? x : x, y: y - 9, 'text-anchor': p < 1 ? 'middle' : 'end', class: 'small', style: `fill:${c}` }, t));
    }
    const xu = X(u);
    budSvg.append(s('path', { d: `M${xu},${y + bh + 2}l-4,7h8z`, fill: d.U >= 1 ? 'var(--danger)' : 'var(--ink)' }));
    const tl = `interrupts ${f(d.U * 100, 3)} %`;
    budSvg.append(s('text', { x: Math.max(L + 2, Math.min(W - R - tl.length * 6.6, xu - (tl.length * 6.6) / 2)), y: H - 3, class: d.U >= 1 ? 'small bad' : 'small' }, tl));
    const v = (label) => (res.values || []).find((q) => q.label === label);
    const lv = v('Interrupt CPU load'), left = v('CPU left for the main loop / tasks'), ovs = v('Overhead share of the load');
    budSub.replaceChildren('interrupts ', h('b', { class: lv?.tone === 'bad' ? 'bad' : lv?.tone === 'warn' ? 'warn' : 'ok' }, `${lv?.value} %`),
      ' · left for the main loop ', h('b', {}, `${left?.value} %`), ' · entry/exit is ', h('b', {}, `${ovs?.value} %`), ' of the load (hatched)');
  }

  // ---------- schedule ----------
  function drawSchedule() {
    const had = schSvg.contains(document.activeElement);
    schSvg.replaceChildren();
    try { drawScheduleInner(); } finally { if (had || dragging) refocus(schSvg); }
  }
  function drawScheduleInner() {
    const d = D();
    const W = Math.max(300, schSvg.clientWidth || schedule.clientWidth || 800);
    const x = pick();
    if (!d || !x) {
      schSvg.setAttribute('viewBox', `0 0 ${W} 60`); schSvg.setAttribute('height', 60);
      schSvg.append(s('text', { x: 12, y: 34, class: 'soft' }, 'No interrupts to schedule: add one on the right.'));
      schTitle.textContent = 'Worst case'; schSub.textContent = ''; fitBtn.style.display = 'none';
      return;
    }
    const narrow = W < 600;
    const lw = narrow ? 112 : 206, sw = W < 820 ? 0 : 150, top = 30, lh = narrow ? 36 : 38, ch = 26;
    const x0 = lw + 8, x1 = W - sw - 16;
    const lanes = [...d.irqs].sort((a, b) => a.prio - b.prio || a.k - b.k);
    const H = top + ch + lanes.length * lh + 30;
    schSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    schSvg.setAttribute('height', H);

    const tr = x.trace;
    const Rx = x.R ?? tr.horizon;
    let span = Rx * 1.18;
    const farD = x.D > span * 2.5, farT = x.T > span * 2.5;
    if (fitAll || !farD) span = Math.max(span, x.D * 1.06);
    if (fitAll || !farT) span = Math.max(span, x.T * 1.06);
    span = frozen || niceCeil(span);
    fitBtn.style.display = farD || farT || fitAll ? '' : 'none';
    fitBtn.textContent = fitAll ? 'Zoom to the response' : `Show to ${farD ? 'the deadline' : 'the next event'}`;
    const X = (t) => x0 + (Math.min(t, span) / span) * (x1 - x0);
    const T = (px) => ((px - x0) / (x1 - x0)) * span;
    const ptX = (ev) => { const r = schSvg.getBoundingClientRect(); return (ev.clientX - r.left) * (W / r.width); };

    // axis
    const step = niceStep(span, x1 - x0);
    for (let t = 0; t <= span + 1e-9; t += step) {
      const xx = X(t);
      schSvg.append(s('line', { x1: xx, x2: xx, y1: top - 4, y2: H - 26, stroke: 'var(--line-soft)' }));
      schSvg.append(s('text', { x: xx, y: top - 9, 'text-anchor': 'middle', class: 'soft small' }, t === 0 ? '0 µs' : `${f(t, 4)}`));
    }
    schSvg.append(s('text', { x: 10, y: top - 9, class: 'soft small' }, narrow ? 'prio · irq' : 'priority · interrupt'));

    // the blocker, the higher ones, the picked one
    const involved = new Set(tr.segs.map((g) => g.k));
    const laneY = new Map();
    let yy = top;
    // interrupts-off lane
    const critY = yy;
    yy += ch;
    lanes.forEach((q, i) => laneY.set(q.k, yy + i * lh));

    // lane backgrounds + labels
    const critBlock = tr.segs.find((g) => g.kind === 'block' && g.k === -1);
    schSvg.append(s('rect', { x: 0, y: critY, width: W, height: ch, fill: 'var(--sunken)', 'fill-opacity': 0.6 }));
    schSvg.append(s('text', { x: 10, y: critY + 17, class: 'soft' }, narrow ? 'IRQs off' : `interrupts off · ${f(d.crit, 4)} µs`));
    for (const q of lanes) {
      const ly = laneY.get(q.k);
      const isSel = q.k === x.k;
      const g = s('g', { class: 'lane', tabindex: 0, role: 'button', 'aria-pressed': String(isSel), 'aria-label': `${q.name}: priority ${q.prio}, worst response ${us(q.R)}` });
      trackFocus(g, `lane-${q.k}`);
      g.append(s('rect', { class: 'lanebg', x: 0.5, y: ly + 0.5, width: W - 1, height: lh - 1, fill: isSel ? 'var(--accent)' : 'transparent', 'fill-opacity': isSel ? 0.08 : 0, stroke: isSel ? 'var(--accent)' : 'none', 'stroke-opacity': 0.5 }));
      g.append(s('line', { x1: 0, x2: W, y1: ly + lh, y2: ly + lh, stroke: 'var(--line-soft)' }));
      const bad = q.lost || q.miss;
      g.append(s('rect', { x: 36, y: ly + 9, width: 4, height: lh - 18, rx: 1, fill: col(q.k) }));
      const maxc = narrow ? 9 : 22;
      g.append(s('text', { x: 46, y: ly + (narrow ? 15 : 16), class: `name${bad ? ' bad' : ''}` }, q.name.length > maxc ? q.name.slice(0, maxc - 1) + '…' : q.name));
      g.append(s('text', { x: 46, y: ly + (narrow ? 29 : 30), class: 'soft small' }, narrow ? `${f(q.h, 3)}µs` : `${hz(q.rate)} · ${f(q.h, 4)} µs`));
      g.append(s('title', {}, `${q.name}: priority ${q.prio}, every ${f(q.T, 4)} µs, handler ${f(q.h, 4)} µs + ${f(d.ov, 3)} µs entry/exit`));
      g.addEventListener('click', () => { if (sel !== q.k) { sel = q.k; frozen = null; draw(); } });
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sel = q.k; frozen = null; draw(); } });
      schSvg.append(g);

      // priority chip
      const flat = d.mode === 'flat';
      const chip = s('g', { class: flat ? null : 'hdl-v', tabindex: flat ? null : 0, role: flat ? null : 'spinbutton', 'aria-label': `Priority of ${q.name}`, 'aria-valuenow': q.prio, 'aria-valuemin': 0 });
      const rawPrio = ctx.raw.irqs[q.k]?.prio ?? q.prio;
      chip.append(s('rect', { class: 'ring', x: 6, y: ly + 9, width: 26, height: lh - 18, rx: 4, fill: 'var(--sunken)', stroke: 'var(--line)' }));
      chip.append(s('text', { x: 19, y: ly + lh / 2 + 4, 'text-anchor': 'middle', class: flat ? 'soft small' : 'small' }, flat ? '–' : String(rawPrio)));
      if (!flat) {
        trackFocus(chip, `prio-${q.k}`);
        chip.append(s('title', {}, 'Priority (0 = most urgent): drag up or down, or ↑ ↓'));
        const setP = (p) => { p = Math.max(0, Math.min(255, Math.round(p))); if (String(p) !== String(ctx.raw.irqs[q.k]?.prio)) setRow(q.k, { prio: String(p) }); };
        chip.addEventListener('pointerdown', (e) => {
          e.preventDefault(); e.stopPropagation();
          chip.focus({ preventScroll: true });
          const y0 = e.clientY, p0 = Number(q.prio);
          const r = schSvg.getBoundingClientRect(), k = W / r.width;
          drag((ev) => setP(p0 + Math.round(((ev.clientY - y0) * k) / lh)));
        });
        chip.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowUp') { e.preventDefault(); setP(Number(q.prio) - 1); }
          if (e.key === 'ArrowDown') { e.preventDefault(); setP(Number(q.prio) + 1); }
        });
      }
      schSvg.append(chip);

      // per lane figures on the right: R against its own deadline
      if (sw) {
        const bx = x1 + 22, bw = sw - 30;
        const r = q.R == null ? Infinity : q.R / q.D;
        const tone = q.lost || q.miss ? 'var(--danger)' : q.tight ? 'var(--warn)' : 'var(--ok)';
        schSvg.append(s('text', { x: bx, y: ly + 14, class: `small${q.lost || q.miss ? ' bad' : ''}` },
          q.lost ? 'loses events' : q.miss ? 'misses deadline' : `R ${f(q.R, 3)} of ${f(q.D, 4)} µs`));
        schSvg.append(s('rect', { x: bx, y: ly + 19, width: bw, height: 5, rx: 2, fill: 'var(--sunken)' }));
        schSvg.append(s('rect', { x: bx, y: ly + 19, width: Math.max(1.5, Math.min(1, r) * bw), height: 5, rx: 2, fill: tone }));
        schSvg.append(s('text', { x: bx, y: ly + 34, class: 'soft small' }, `load ${f(q.load * 100, 3)} %`));
      }
    }
    // separator: priority levels that the picked one does not wait for
    const lower = lanes.filter((q) => q.prio > x.prio);
    if (lower.length) {
      const ly = laneY.get(lower[0].k);
      schSvg.append(s('line', { x1: x0 - 6, x2: x1, y1: ly, y2: ly, stroke: 'var(--ink-soft)', 'stroke-dasharray': '6 4' }));
      if (!narrow) schSvg.append(s('text', { x: x1, y: ly + 11, 'text-anchor': 'end', class: 'soft small' }, 'lower priority: only one can block, once'));
    }

    // releases of the higher ones
    for (const [k, rel] of Object.entries(tr.releases)) {
      const ly = laneY.get(Number(k));
      for (const t of rel) {
        if (t > span) break;
        const xx = X(t);
        schSvg.append(s('path', { d: `M${xx - 3.5},${ly + 3}h7l-3.5,5z`, fill: 'var(--ink-soft)' }));
      }
    }
    // blocks
    const lastSeg = new Map();
    for (const g of tr.segs) {
      const ly = g.k === -1 ? critY : laneY.get(g.k);
      if (ly == null) continue;
      const hh = g.k === -1 ? ch : lh;
      const xa = X(g.t0), xb = X(g.t1);
      const c = g.k === -1 ? 'var(--ink-soft)' : col(g.k);
      const r = s('rect', { x: xa, y: ly + 10, width: Math.max(1, xb - xa), height: hh - 20, rx: 2, fill: c, 'fill-opacity': g.kind === 'block' ? 0.35 : g.kind === 'self' ? 0.95 : 0.7,
        stroke: c, 'stroke-width': g.kind === 'block' ? 1.4 : 0, 'stroke-dasharray': g.kind === 'block' ? '3 2' : null });
      r.append(s('title', {}, `${g.k === -1 ? 'interrupts off' : d.irqs.find((q) => q.k === g.k)?.name}${g.kind === 'block' ? ' (blocking)' : ''}: ${f(g.t0, 4)} → ${f(g.t1, 4)} µs`));
      schSvg.append(r);
      lastSeg.set(g.k, g);
    }

    // the interrupts-off section is always there to edit, even when a lower
    // handler is the longer blocker
    if (!critBlock && d.crit >= 0) {
      schSvg.append(s('rect', { x: X(0), y: critY + 7, width: Math.max(1, X(d.crit) - X(0)), height: ch - 14, rx: 2, fill: 'none', stroke: 'var(--ink-soft)', 'stroke-dasharray': '3 2' }));
      const why = d.mode === 'flat' ? '' : 'shorter than the lower handler, which blocks instead';
      if (why && !narrow && X(d.crit) + why.length * 6.1 + 12 < x1) schSvg.append(s('text', { x: X(d.crit) + 12, y: critY + 17, class: 'soft small' }, why));
      lastSeg.set(-1, { t1: d.crit });
    }
    // handles: the end of each lane's last block changes that handler
    for (const [k, g] of lastSeg) {
      const ly = k === -1 ? critY : laneY.get(k);
      const hh = k === -1 ? ch : lh;
      const q = d.irqs.find((z) => z.k === k);
      const xb = X(g.t1);
      const hg = s('g', { class: 'hdl', tabindex: 0, role: 'slider', 'aria-label': k === -1 ? 'Interrupts-off section' : `Handler time of ${q.name}`,
        'aria-valuenow': k === -1 ? d.crit : q.h, 'aria-valuetext': k === -1 ? us(d.crit) : us(q.h) });
      trackFocus(hg, `h-${k}`);
      hg.append(s('rect', { class: 'ring', x: xb - 3, y: ly + 6, width: 6, height: hh - 12, rx: 2, fill: 'var(--surface)', stroke: 'var(--ink)', 'stroke-width': 1.2 }));
      hg.append(s('rect', { x: xb - 8, y: ly + 2, width: 16, height: hh - 4, fill: 'transparent' }));
      hg.append(s('title', {}, k === -1 ? 'Drag: longest interrupts-off section' : `Drag: ${q.name} handler time (now ${f(q.h, 4)} µs)`));
      const cur = () => (k === -1 ? d.crit : q.h);
      const apply = (v) => (k === -1 ? ctx.set('crit', num(Math.max(0, Math.round(v * 100) / 100))) : setHandler(k, v));
      hg.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        hg.focus({ preventScroll: true });
        frozen = span;
        const p0 = ptX(e), v0 = cur();
        drag((ev) => apply(v0 + T(ptX(ev)) - T(p0)), () => { frozen = null; drawSchedule(); });
      });
      hg.addEventListener('keydown', (e) => {
        const st = e.shiftKey ? 1 : 0.1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); apply(cur() + st); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); apply(Math.max(0, cur() - st)); }
      });
      schSvg.append(hg);
    }

    // next-event ticks (rate) for the higher lanes and the picked one
    const tick = (q, ly, label) => {
      if (q.T > span) return;
      const xx = X(q.T);
      const hg = s('g', { class: 'hdl', tabindex: 0, role: 'slider', 'aria-label': `Period of ${q.name}`, 'aria-valuenow': q.T, 'aria-valuetext': `every ${us(q.T)}, ${hz(q.rate)}` });
      trackFocus(hg, `t-${q.k}`);
      hg.append(s('path', { class: 'ring', d: `M${xx - 6},${ly + 1}h12l-6,9z`, fill: 'var(--ink)', stroke: 'var(--ink)', 'stroke-width': 0.5 }));
      hg.append(s('rect', { x: xx - 9, y: ly - 1, width: 18, height: 14, fill: 'transparent' }));
      if (label) {
        const tl = `next event ${f(q.T, 4)} µs`;
        const right = xx + 8 + tl.length * 6 < x1;
        hg.append(s('text', { x: right ? xx + 8 : xx - 8, y: ly + 9, 'text-anchor': right ? 'start' : 'end', class: `small${q.lost ? ' bad' : ' soft'}` }, tl));
      }
      hg.append(s('title', {}, `Drag: ${q.name} arrives every ${f(q.T, 4)} µs (${hz(q.rate)})`));
      const apply = (T2) => setRate(q.k, T2);
      hg.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        hg.focus({ preventScroll: true });
        frozen = span;
        drag((ev) => apply(Math.max(span / 400, T(ptX(ev)))), () => { frozen = null; drawSchedule(); });
      });
      hg.addEventListener('keydown', (e) => {
        const st = (e.shiftKey ? 0.1 : 0.01) * q.T;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); apply(q.T + st); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); apply(q.T - st); }
      });
      schSvg.append(hg);
    };
    for (const k of Object.keys(tr.releases)) { const q = d.irqs.find((z) => z.k === Number(k)); tick(q, laneY.get(q.k), false); }

    // the picked one: event, response bracket, deadline, next event
    const ly = laneY.get(x.k);
    const xe = X(0);
    schSvg.append(s('path', { d: `M${xe},${ly + 2}v${lh - 6}`, stroke: 'var(--ink)', 'stroke-width': 1.6 }));
    schSvg.append(s('path', { d: `M${xe - 4},${ly + 2}h8l-4,6z`, fill: 'var(--ink)' }));
    const bad = x.miss || x.lost;
    const yb = ly + lh - 5;
    if (x.R != null) {
      const xr = X(x.R);
      schSvg.append(s('path', { d: `M${xe},${yb - 3}v3H${xr}v-3`, fill: 'none', stroke: bad ? 'var(--danger)' : 'var(--accent)', 'stroke-width': 1.4 }));
      const rl = `R ${f(x.R, 4)} µs`;
      const inside = xr - xe > rl.length * 6.4 + 20;
      schSvg.append(s('rect', { x: inside ? xr - rl.length * 6.2 - 8 : xr + 3, y: yb - 9, width: rl.length * 6.2 + 4, height: 12, fill: 'var(--surface)' }));
      schSvg.append(s('text', { x: inside ? xr - 6 : xr + 5, y: yb + 1, 'text-anchor': inside ? 'end' : 'start', class: `small${bad ? ' bad' : ''}`, style: bad ? null : 'fill:var(--accent)' }, rl));
    } else {
      schSvg.append(s('text', { x: X(span * 0.5), y: ly + 22, 'text-anchor': 'middle', class: 'small bad' }, 'never finishes: the interrupts above use all the CPU'));
    }
    // deadline flag
    if (x.D <= span) {
      const xd = X(x.D);
      if (x.R != null && x.R > x.D) schSvg.append(s('rect', { x: xd, y: ly + 4, width: X(x.R) - xd, height: lh - 8, fill: 'var(--danger)', 'fill-opacity': 0.14 }));
      const hg = s('g', { class: 'hdl', tabindex: 0, role: 'slider', 'aria-label': `Deadline of ${x.name}`, 'aria-valuenow': x.D, 'aria-valuetext': us(x.D) });
      trackFocus(hg, `d-${x.k}`);
      const c = bad ? 'var(--danger)' : 'var(--ok)';
      hg.append(s('line', { x1: xd, x2: xd, y1: top - 2, y2: ly + lh, stroke: c, 'stroke-width': 1.6, 'stroke-dasharray': '5 3' }));
      const dl = Math.abs(x.D - x.T) < 1e-9 ? `deadline = next event ${f(x.D, 4)}` : `deadline ${f(x.D, 4)}`;
      const dw = dl.length * 6.1 + 10;
      const left = xd + dw > x1 + sw * 0.6;
      hg.append(s('path', { class: 'ring', d: left ? `M${xd},${ly - 13}h${-dw}v13h${dw}z` : `M${xd},${ly - 13}h${dw}v13h${-dw}z`, fill: c, stroke: c }));
      hg.append(s('text', { x: left ? xd - 5 : xd + 5, y: ly - 3, 'text-anchor': left ? 'end' : 'start', class: 'small', style: 'fill:var(--surface)' }, dl));
      hg.append(s('rect', { x: xd - 7, y: top, width: 14, height: ly + lh - top, fill: 'transparent' }));
      hg.append(s('title', {}, 'Drag: deadline (blank in the table = one period)'));
      hg.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        hg.focus({ preventScroll: true });
        frozen = span;
        drag((ev) => setDeadline(x.k, Math.max(span / 500, T(ptX(ev)))), () => { frozen = null; drawSchedule(); });
      });
      hg.addEventListener('keydown', (e) => {
        const st = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setDeadline(x.k, x.D + st); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setDeadline(x.k, x.D - st); }
      });
      schSvg.append(hg);
    } else {
      schSvg.append(s('text', { x: x1, y: ly + 14, 'text-anchor': 'end', class: 'small', style: `fill:${bad ? 'var(--danger)' : 'var(--ok)'}` }, `deadline ${f(x.D, 4)} µs →`));
    }
    // next event of the picked one: a second arrival while pending is lost
    if (x.T <= span) {
      if (x.lost) {
        const xt = X(x.T), xs = X(Math.min(span, x.start ?? span));
        schSvg.append(s('rect', { x: xt, y: ly + 4, width: Math.max(0, xs - xt), height: lh - 8, fill: 'url(#irq-lost)', 'fill-opacity': 1 }));
        const lt = 'the next event comes before this one starts: one is lost';
        const lt2 = 'next event before start: lost';
        const room = xs - xt - 12;
        const use = room > lt.length * 6.1 ? lt : room > lt2.length * 6.1 ? lt2 : null;
        if (use) {
          schSvg.append(s('rect', { x: xt + 5, y: ly + 12, width: use.length * 6.1 + 6, height: 14, fill: 'var(--surface)' }));
          schSvg.append(s('text', { x: xt + 8, y: ly + 23, class: 'small bad' }, use));
        }
      }
      tick(x, ly, Math.abs(x.D - x.T) >= 1e-9 || x.D > span);
    } else {
      schSvg.append(s('text', { x: x1, y: ly + 27, 'text-anchor': 'end', class: `small ${x.lost ? 'bad' : 'soft'}` }, `next event ${f(x.T, 4)} µs →`));
    }
    const defs = s('defs');
    const pat = s('pattern', { id: 'irq-lost', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(s('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--danger)', 'stroke-width': 2, 'stroke-opacity': 0.55 }));
    defs.append(pat);
    schSvg.prepend(defs);

    // bottom legend
    const yl = H - 10;
    const leg = [['block', 'blocking (runs first)'], ['run', 'higher or equal priority'], ['self', x.name.length > 18 ? 'this interrupt' : x.name]];
    let lx = x0;
    if (!narrow) for (const [kind, t] of leg) {
      schSvg.append(s('rect', { x: lx, y: yl - 8, width: 14, height: 8, rx: 1.5, fill: kind === 'self' ? col(x.k) : 'var(--ink-soft)', 'fill-opacity': kind === 'block' ? 0.35 : kind === 'self' ? 0.95 : 0.7,
        stroke: kind === 'block' ? 'var(--ink-soft)' : 'none', 'stroke-dasharray': '3 2' }));
      schSvg.append(s('text', { x: lx + 19, y: yl, class: 'soft small' }, t));
      lx += 34 + t.length * 6.1;
    }

    const blk = x.blocker == null ? 'nothing' : x.blocker === -1 ? `the interrupts-off section (${f(d.crit, 4)} µs)` : d.irqs.find((q) => q.k === x.blocker)?.name;
    schTitle.textContent = `Worst case of ${x.name}`;
    schSub.replaceChildren('event at 0 · blocked by ', h('b', {}, blk), ' · starts by ', h('b', {}, us(x.start)), ' · done by ',
      h('b', { class: bad ? 'bad' : 'ok' }, us(x.R)));
  }

  // ---------- inspector ----------
  let inspK = null;
  function drawInspector() {
    const d = D();
    const x = pick();
    const rows = ctx.raw.irqs || [];
    if (!x && rows[sel] == null) {
      inspTitle.textContent = 'Interrupt';
      inspBody.replaceChildren(h('div', { class: 'irq-sub', style: 'grid-column:1/-1' }, 'Add an interrupt to begin.'));
      figs.replaceChildren(); verdict.textContent = ''; verdict.className = 'irq-verdict';
      return;
    }
    const k = x ? x.k : sel;
    const row = rows[k] || {};
    inspTitle.replaceChildren(h('span', { style: `display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;background:${col(k)}` }), 'Interrupt ', h('span', { class: 'irq-sub' }, `row ${k + 1} of ${rows.length}`));
    // fields: rebuilt only when the row changes, so typing keeps focus
    if (inspK !== k || !inspBody.childElementCount) {
      inspK = k;
      const inp = (key, label, cls, extra) => {
        const el = h('input', { type: 'text', spellcheck: 'false', 'data-key': key, oninput: (e) => setRow(k, { [key]: e.target.value }) });
        return h('label', { class: cls }, label, extra ? h('div', { class: 'row' }, el, extra) : el);
      };
      const step = (dv) => h('button', { class: 'k-btn', 'aria-label': dv < 0 ? 'More urgent' : 'Less urgent', onclick: () => {
        const p = Number(ctx.raw.irqs[k]?.prio) || 0; setRow(k, { prio: String(Math.max(0, p + dv)) });
      } }, dv < 0 ? '−' : '+');
      inspBody.replaceChildren(
        inp('name', 'Name', 'wide'),
        inp('prio', 'Priority (0 = most urgent)', null, [step(-1), step(1)]),
        inp('rate', 'Rate (Hz)'),
        inp('time', 'Handler (µs)'),
        inp('deadline', 'Deadline (µs, blank = period)'),
        h('div', { style: 'grid-column:1/-1;display:flex;gap:6px;justify-content:flex-end' },
          h('button', { class: 'k-btn', onclick: () => { const r = ctx.raw.irqs.map((z) => ({ ...z })); r.splice(k + 1, 0, { ...r[k], name: `${r[k].name} copy` }); sel = k + 1; ctx.set('irqs', r); } }, 'Duplicate'),
          h('button', { class: 'k-btn', style: 'color:var(--danger)', onclick: () => { const r = ctx.raw.irqs.map((z) => ({ ...z })); r.splice(k, 1); sel = null; inspK = null; ctx.set('irqs', r); } }, 'Remove')));
    }
    for (const el of inspBody.querySelectorAll('input[data-key]')) {
      if (document.activeElement !== el) el.value = row[el.dataset.key] ?? '';
      const key = el.dataset.key;
      if (key !== 'name') { const t = String(row[key] ?? '').trim(); el.classList.toggle('bad', t !== '' && ctx.parseEng(t) == null); }
    }
    if (!x) { figs.replaceChildren(); verdict.textContent = 'This row is skipped: it needs a rate above 0 and a handler time.'; verdict.className = 'irq-verdict bad'; return; }
    const fig = (label, value, unit, tone) => h('div', { class: `irq-fig${tone ? ` ${tone}` : ''}` }, h('span', {}, label), h('b', {}, value, unit ? h('small', {}, ` ${unit}`) : null));
    const tone = x.lost || x.miss ? 'bad' : x.tight ? 'warn' : 'ok';
    figs.replaceChildren(
      fig('C with entry/exit', f(x.C, 4), 'µs'), fig('CPU load', f(x.load * 100, 3), '%'), fig('Blocking B', f(x.B, 4), 'µs'),
      fig('Worst start', x.start == null ? '∞' : f(x.start, 4), 'µs', x.lost ? 'bad' : null),
      fig('Worst response', x.R == null ? '∞' : f(x.R, 4), 'µs', tone), fig('Slack', x.slack == null ? '–' : f(x.slack, 4), 'µs', tone));
    verdict.className = `irq-verdict ${tone}`;
    verdict.textContent = x.lost ? `Loses events: it can wait ${us(x.start)} to start but the next one comes after ${us(x.T)}.`
      : x.miss ? `Misses its deadline: done by ${us(x.R)}, due at ${us(x.D)}.`
        : x.tight ? `Tight: ${us(x.slack)} of slack, under 20 % of the deadline.` : `OK: ${us(x.slack)} of slack before the deadline.`;
    void d;
  }

  // ---------- core fields, warnings ----------
  function syncCore() {
    const raw = ctx.raw;
    for (const [k, el] of Object.entries(fields)) {
      if (document.activeElement !== el) el.value = raw[k] ?? '';
      const t = String(raw[k] ?? '').trim();
      el.classList.toggle('bad', t !== '' && ctx.parseEng(t) == null);
    }
    coreSel.value = raw.core;
    entryLab.style.display = raw.core === 'custom' ? '' : 'none';
    for (const b of modeSeg.children) b.setAttribute('aria-pressed', String(b.dataset.v === raw.mode));
    const d = D();
    ovText.replaceChildren(d ? h('span', {}, 'each interrupt costs ', h('b', {}, `${d.ovCycles} cycles`), ' = ', h('b', {}, `${f(d.ov, 3)} µs`), ' entry + exit') : '');
  }
  function drawSide() {
    warns.replaceChildren(...((res && res.warnings) || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'How it is worked out'), ...((res && res.notes) || []).map((t) => h('div', {}, t)));
  }

  function draw() {
    drawBudget();
    drawSchedule();
    drawInspector();
    drawSide();
  }

  ctx.onResult((r) => { res = r; syncCore(); draw(); });
  let lastW = 0;
  new ResizeObserver(() => {
    const w = schedule.clientWidth;
    if (w !== lastW) { lastW = w; drawBudget(); drawSchedule(); }
  }).observe(schedule);
}
