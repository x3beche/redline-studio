// The closed-loop step response: output against setpoint on top, the controller
// output with its limits underneath, on one time axis.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};

function ticks(lo, hi, n = 4) {
  const span = hi - lo || 1;
  const raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => span / x <= n + 0.5) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9 * span; v += step) out.push(Number(v.toPrecision(6)));
  return out;
}

export function view(el, result, input, api) {
  el.replaceChildren();
  const d = result && result.sim;
  if (!d || !d.t || d.t.length < 2) return;
  const f = (v) => api.fmtNum(v, 3);
  // el is display:none while empty, so size from the parent column (minus the block's padding).
  const W = Math.max(280, Math.min(1000, Math.round(el.clientWidth || el.parentElement?.clientWidth || 600) - 22));
  const narrow = W < 460;
  const L = narrow ? 40 : 50, R = 12, T = narrow ? 38 : 22, gap = 26, B = 30;
  const H1 = narrow ? 170 : 200, H2 = narrow ? 80 : 90;
  const H = T + H1 + gap + H2 + B;
  const t0 = d.t[0], t1 = d.t[d.t.length - 1];
  const X = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const txt = { 'font-size': 11, 'font-family': 'IBM Plex Mono, ui-monospace, monospace', fill: 'var(--ink-soft)' };
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Closed-loop step response', style: 'display:block' });

  // Upper panel: y and setpoint.
  const ys = [...d.y, ...d.sp, 0].filter(Number.isFinite);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const Y1 = (v) => T + H1 * (1 - (v - lo) / (hi - lo));
  // Upper panel: u with its limits.
  const us = [...d.u, d.umin, d.umax].filter(Number.isFinite);
  let ulo = Math.min(...us), uhi = Math.max(...us);
  const upad = (uhi - ulo) * 0.1 || 1; ulo -= upad; uhi += upad;
  const top2 = T + H1 + gap;
  const Y2 = (v) => top2 + H2 * (1 - (v - ulo) / (uhi - ulo));

  const frame = (y0, h) => svg.append(s('rect', { x: L, y: y0, width: W - L - R, height: h, fill: 'var(--sunken)', stroke: 'var(--line)' }));
  frame(T, H1); frame(top2, H2);
  for (const v of ticks(lo, hi)) {
    svg.append(s('line', { x1: L, x2: W - R, y1: Y1(v), y2: Y1(v), stroke: 'var(--line-soft)' }));
    svg.append(s('text', { ...txt, x: L - 5, y: Y1(v) + 3, 'text-anchor': 'end' }, f(v)));
  }
  for (const v of ticks(ulo, uhi, 2)) {
    svg.append(s('line', { x1: L, x2: W - R, y1: Y2(v), y2: Y2(v), stroke: 'var(--line-soft)' }));
    svg.append(s('text', { ...txt, x: L - 5, y: Y2(v) + 3, 'text-anchor': 'end' }, f(v)));
  }
  for (const v of ticks(t0, t1, narrow ? 4 : 6)) {
    svg.append(s('line', { x1: X(v), x2: X(v), y1: T, y2: T + H1, stroke: 'var(--line-soft)' }));
    svg.append(s('line', { x1: X(v), x2: X(v), y1: top2, y2: top2 + H2, stroke: 'var(--line-soft)' }));
    svg.append(s('text', { ...txt, x: X(v), y: H - 12, 'text-anchor': 'middle' }, f(v)));
  }
  svg.append(s('text', { ...txt, x: W - R, y: H - 1, 'text-anchor': 'end' }, 'time (s)'));

  // The ±2 % settling band around the setpoint, from the settling time on.
  const spv = d.sp[d.sp.length - 1];
  const band = Math.abs(spv) * 0.02;
  if (d.settle != null && band > 0) {
    const xa = X(d.settle), xb = d.tdist != null ? X(d.tdist) : W - R;
    if (xb > xa) svg.append(s('rect', { x: xa, y: Y1(spv + band), width: xb - xa, height: Math.max(1, Y1(spv - band) - Y1(spv + band)), fill: 'var(--ok)', 'fill-opacity': 0.18 }));
    svg.append(s('line', { x1: xa, x2: xa, y1: T, y2: T + H1, stroke: 'var(--ok)', 'stroke-dasharray': '3 3' }));
    svg.append(s('text', { ...txt, x: xa + 4, y: T + H1 - 6, fill: 'var(--ok)' }, `settled ${f(d.settle)} s`));
  }
  if (d.tdist != null) {
    const xd = X(d.tdist);
    for (const [y0, h] of [[T, H1], [top2, H2]]) svg.append(s('line', { x1: xd, x2: xd, y1: y0, y2: y0 + h, stroke: 'var(--warn)', 'stroke-dasharray': '5 3' }));
    svg.append(s('text', { ...txt, x: xd + 4, y: T + 12, fill: 'var(--warn)' }, 'load step'));
  }
  // Output limits.
  for (const v of [d.umin, d.umax]) svg.append(s('line', { x1: L, x2: W - R, y1: Y2(v), y2: Y2(v), stroke: 'var(--danger)', 'stroke-dasharray': '4 3', 'stroke-opacity': 0.7 }));

  const path = (arr, Y) => arr.map((v, i) => `${i ? 'L' : 'M'}${X(d.t[i]).toFixed(1)},${Y(Number.isFinite(v) ? v : 0).toFixed(1)}`).join('');
  svg.append(s('path', { d: path(d.sp, Y1), fill: 'none', stroke: 'var(--ink-soft)', 'stroke-width': 1.3, 'stroke-dasharray': '6 4' }));
  svg.append(s('path', { d: path(d.y, Y1), fill: 'none', stroke: 'var(--tool-s0)', 'stroke-width': 2 }));
  svg.append(s('path', { d: path(d.u, Y2), fill: 'none', stroke: 'var(--tool-s1)', 'stroke-width': 1.6 }));

  // Legend and panel labels.
  const leg = [['var(--tool-s0)', 'output y', ''], ['var(--ink-soft)', 'setpoint', '6 4'], ['var(--tool-s1)', 'controller u', ''], ['var(--danger)', 'u limits', '4 3']];
  let lx = L, ly = 11;
  for (const [c, name, dash] of leg) {
    const w = 30 + name.length * 6.6;
    if (lx + w > W - R && lx > L) { lx = L; ly += 16; }
    svg.append(s('line', { x1: lx, x2: lx + 16, y1: ly, y2: ly, stroke: c, 'stroke-width': 2, 'stroke-dasharray': dash }));
    svg.append(s('text', { ...txt, x: lx + 20, y: ly + 4, fill: 'var(--ink)' }, name));
    lx += w;
  }
  if (d.diverged) svg.append(s('text', { ...txt, x: L + 8, y: T + 18, fill: 'var(--danger)', 'font-size': 13 }, 'unstable: the run stopped when the output diverged'));

  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = 'Closed-loop step response';
  wrap.append(title, svg);
  el.append(wrap);
}
