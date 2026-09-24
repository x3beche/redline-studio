// One row per interrupt in NVIC order: a bar of its worst-case response split
// into handler time, same-group blocking and preemption, drawn against its own
// deadline (the tick at the right). Drawn from result.irqs.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const PART = [['C', 'handler', 'var(--tool-s0)'], ['B', 'blocked by own group', 'var(--tool-s1)'], ['I', 'preempted', 'var(--tool-s2)']];

export function view(el, result, input, api) {
  el.replaceChildren();
  const list = result?.irqs || [];
  if (!list.length) return;
  const W = Math.max(280, Math.round(el.clientWidth || el.parentElement?.clientWidth || 600) - 22);
  const narrow = W < 480;
  const LW = narrow ? 0 : 150;                 // label column
  const RH = narrow ? 44 : 30, TOP = 4;
  const x0 = LW + 4, bw = W - x0 - (narrow ? 4 : 70);
  const H = TOP + list.length * RH + 4;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'interrupt response times against deadlines', style: 'display:block' });
  const us = (v) => (v == null ? '∞' : `${api.fmtNum(v, 3)} µs`);
  let lastPre = null;
  list.forEach((q, i) => {
    const y = TOP + i * RH;
    if (lastPre !== null && q.pre !== lastPre) svg.append(s('line', { x1: 0, x2: W, y1: y - 1, y2: y - 1, stroke: 'var(--line-soft)' }));
    lastPre = q.pre;
    const by = narrow ? y + 18 : y + 6, bh = narrow ? 14 : 14;
    const label = `${q.name}  ${q.pre}.${q.sub}${q.rtos ? ' · RTOS' : ''}`;
    svg.append(s('text', { x: narrow ? 2 : 2, y: narrow ? y + 12 : y + 17, fill: 'var(--ink)', 'font-size': 11.5, 'font-family': 'IBM Plex Mono, ui-monospace, monospace' }, label));
    // the deadline sits at 80 % of the bar width, so an overrun still shows
    const D = q.D, scale = (bw * 0.8) / D;
    svg.append(s('rect', { x: x0, y: by, width: bw, height: bh, rx: 3, fill: 'var(--sunken)', stroke: 'var(--line-soft)' }));
    let x = x0;
    for (const [k, , col] of PART) {
      const v = q[k] == null ? D * 1.25 : q[k];
      const w = Math.min(x0 + bw - x, v * scale);
      if (w > 0.2) { svg.append(s('rect', { x, y: by, width: w, height: bh, fill: col })); x += w; }
    }
    const dx = x0 + bw * 0.8;
    svg.append(s('line', { x1: dx, x2: dx, y1: by - 3, y2: by + bh + 3, stroke: q.ok ? 'var(--ink-soft)' : 'var(--danger)', 'stroke-width': 2 }));
    const txt = `${us(q.R)} / ${us(D)}`;
    if (narrow) svg.append(s('text', { x: W - 2, y: y + 12, 'text-anchor': 'end', fill: q.ok ? 'var(--ink-soft)' : 'var(--danger)', 'font-size': 10.5 }, txt));
    else svg.append(s('text', { x: W - 2, y: y + 17, 'text-anchor': 'end', fill: q.ok ? 'var(--ink-soft)' : 'var(--danger)', 'font-size': 10.5 }, q.ok ? us(q.R) : `${us(q.R)} late`));
    const t = s('title', {}, `${q.name}: handler ${us(q.C)}, blocked ${us(q.B)}, preempted ${us(q.I)}, response ${us(q.R)}, deadline ${us(D)}`);
    svg.append(t);
  });
  const legend = document.createElement('div');
  legend.className = 'k-legend';
  legend.style.flexWrap = 'wrap';
  for (const [, name, col] of [...PART, [null, 'deadline (tick)', 'var(--ink-soft)']]) {
    const sp = document.createElement('span');
    const i = document.createElement('i'); i.style.background = col; i.style.display = 'inline-block'; i.style.width = '8px'; i.style.height = '8px'; i.style.marginRight = '4px';
    sp.append(i, name); legend.append(sp);
  }
  const block = document.createElement('div');
  block.className = 'k-block';
  const title = document.createElement('div'); title.className = 'k-title'; title.textContent = 'Worst-case response against deadline (NVIC order)';
  block.append(title, svg, legend);
  el.append(block);
}
