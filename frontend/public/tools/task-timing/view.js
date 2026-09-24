// Timeline: one lane per task, execution segments as bars, releases as ticks
// on top, missed deadlines as red marks. Drawn from result.timeline (ms).
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const COLS = ['var(--tool-s0)', 'var(--tool-s1)', 'var(--tool-s2)', 'var(--tool-s3)'];

function niceStep(span, px) {
  const target = span / Math.max(2, Math.floor(px / 70));
  const p = 10 ** Math.floor(Math.log10(target));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= target) || p * 10;
}

export function view(el, result, input, api) {
  el.replaceChildren();
  const tl = result?.timeline;
  if (!tl || !tl.lanes?.length || !(tl.window > 0)) return;
  const fmt = api?.fmtNum || ((v) => String(v));
  const W = Math.max(280, Math.round(el.clientWidth || el.parentElement?.clientWidth || 600) - 22);
  const narrow = W < 460;
  const LW = narrow ? 72 : 110, R = 8, LH = narrow ? 24 : 26, T = 8, AX = 22;
  const H = T + tl.lanes.length * LH + AX;
  const X = (t) => LW + (t / tl.window) * (W - LW - R);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'task timeline', style: 'display:block' });
  // time grid
  const step = niceStep(tl.window, W - LW - R);
  for (let t = 0; t <= tl.window + 1e-9; t += step) {
    svg.append(s('line', { x1: X(t), x2: X(t), y1: T, y2: H - AX + 3, stroke: 'var(--line-soft)', 'stroke-width': 1 }));
    svg.append(s('text', { x: X(t), y: H - 6, 'text-anchor': t === 0 ? 'start' : 'middle', fill: 'var(--ink-soft)', 'font-size': 10 }, fmt(Number(t.toPrecision(6)))));
  }
  tl.lanes.forEach((ln, i) => {
    const y = T + i * LH;
    const col = COLS[i % 4];
    if (i % 2 === 0) svg.append(s('rect', { x: 0, y, width: W, height: LH, fill: 'var(--sunken)', opacity: 0.5 }));
    const name = ln.name.length > (narrow ? 9 : 15) ? ln.name.slice(0, narrow ? 8 : 14) + '…' : ln.name;
    const lab = s('text', { x: 4, y: y + LH / 2 + 4, fill: 'var(--ink)', 'font-size': 11 }, name);
    lab.append(s('title', {}, ln.name)); svg.append(lab);
    for (const r of ln.releases) svg.append(s('line', { x1: X(r), x2: X(r), y1: y + 2, y2: y + 7, stroke: 'var(--ink-soft)', 'stroke-width': 1 }));
    for (const [a, b] of ln.segs) {
      const rect = s('rect', { x: X(a), y: y + 7, width: Math.max(1, X(b) - X(a)), height: LH - 12, fill: col, rx: 1.5 });
      rect.append(s('title', {}, `${ln.name}: ${fmt(a)} – ${fmt(b)} ms`)); svg.append(rect);
    }
    for (const m of ln.misses) {
      const x = X(m);
      const mk = s('path', { d: `M${x - 4},${y + 2} L${x + 4},${y + 2} L${x},${y + 8} Z`, fill: 'var(--danger)' });
      mk.append(s('title', {}, `${ln.name}: deadline missed at ${fmt(m)} ms`)); svg.append(mk);
      svg.append(s('line', { x1: x, x2: x, y1: y + 2, y2: y + LH - 2, stroke: 'var(--danger)', 'stroke-width': 1.5 }));
    }
  });
  svg.append(s('line', { x1: LW, x2: W - R, y1: H - AX + 3, y2: H - AX + 3, stroke: 'var(--line)' }));
  const block = document.createElement('div');
  block.className = 'k-block';
  const t = document.createElement('div'); t.className = 'k-title';
  t.textContent = `Timeline, first ${fmt(tl.window)} ms (ticks = releases, red = missed deadline)`;
  block.append(t, svg);
  el.append(block);
}
