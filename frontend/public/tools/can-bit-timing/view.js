// One CAN bit as its time quanta: Sync, Prop, PS1, PS2, with the sample point.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};

export function view(el, result, input, api) {
  el.replaceChildren();
  const d = result && result.drawing;
  if (!d) return;
  const segs = [['Sync', d.sync, 'var(--ink-soft)'], ['Prop', d.prop, 'var(--tool-s2)'], ['PS1', d.ps1, 'var(--tool-s1)'], ['PS2', d.ps2, 'var(--tool-s3)']].filter((x) => x[1] > 0);
  const n = segs.reduce((a, x) => a + x[1], 0);
  if (!(n > 0)) return;
  const W = Math.max(300, Math.min(640, (el.parentElement?.clientWidth || 640) - 22)), L = 12, R = 12, y = 34, h = 34;
  const q = (W - L - R) / n;
  const svg = s('svg', { viewBox: `0 0 ${W} 110`, width: '100%', role: 'img', style: 'display:block;max-height:170px', 'aria-label': 'CAN bit segments and sample point' });
  const txt = { 'font-size': 11, 'font-family': 'IBM Plex Mono, ui-monospace, monospace' };
  let x = L;
  for (const [name, len, col] of segs) {
    svg.append(s('rect', { x, y, width: len * q, height: h, fill: col, 'fill-opacity': 0.22, stroke: col, 'stroke-width': 1.5 }));
    for (let i = 1; i < len; i++) svg.append(s('line', { x1: x + i * q, x2: x + i * q, y1: y, y2: y + h, stroke: col, 'stroke-opacity': 0.5 }));
    if (len * q > 20) svg.append(s('text', { ...txt, x: x + (len * q) / 2, y: y + h / 2 + 4, 'text-anchor': 'middle', fill: 'var(--ink)' }, len * q > 44 ? `${name} ${len}` : String(len)));
    x += len * q;
  }
  const xs = L + d.sp * (W - L - R);
  svg.append(s('line', { x1: xs, x2: xs, y1: y - 12, y2: y + h + 10, stroke: 'var(--accent)', 'stroke-width': 2 }));
  svg.append(s('path', { d: `M${xs - 5},${y - 18}L${xs + 5},${y - 18}L${xs},${y - 10}Z`, fill: 'var(--accent)' }));
  const lab = `sample point ${api.fmtNum(d.sp * 100, 4)} %`;
  svg.append(s('text', { ...txt, x: Math.min(Math.max(xs, L + 75), W - R - 75), y: y - 22, 'text-anchor': 'middle', fill: 'var(--accent)' }, lab));
  svg.append(s('text', { ...txt, x: L, y: y + h + 22, fill: 'var(--ink-soft)' }, `${n} tq × ${api.fmtNum(d.tq * 1e9, 4)} ns = ${api.fmtNum(n * d.tq * 1e6, 4)} µs/bit, SJW ${d.sjw}`));
  svg.append(s('text', { ...txt, x: L, y: y + h + 38, fill: 'var(--ink-soft)' }, 'Sync · Prop · PS1 · PS2 (tq)'));
  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = 'One bit in time quanta';
  wrap.append(title, svg);
  el.append(wrap);
}
