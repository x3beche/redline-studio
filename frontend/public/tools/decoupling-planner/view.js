// Log-log impedance plot of the planned network against the target.
// Data come from run()'s result.plot, so agents get the same numbers.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const SI = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ']];
const si = (v, unit) => { const [d, p] = SI.find(([x]) => Math.abs(v) >= x * 0.999) || SI[SI.length - 1]; return `${Number((v / d).toPrecision(3))} ${p}${unit}`; };

export function view(el, result) {
  el.replaceChildren();
  const p = result && result.plot;
  if (!p || !p.f || p.f.length < 2) return;
  const W = Math.max(300, Math.round(el.clientWidth || (el.parentElement && el.parentElement.clientWidth) || 560)), H = Math.round(Math.min(300, Math.max(200, W * 0.45)));
  const L = 52, R = 10, T = 12, B = 28;
  const f0 = p.f[0], f1 = p.f[p.f.length - 1];
  // Part curves: n identical capacitors in parallel, |Z| / n.
  const partZ = p.parts.map((k) => p.f.map((f) => {
    const om = 2 * Math.PI * f; const x = om * k.l - 1 / (om * k.c); return Math.hypot(k.esr, x) / k.n;
  }));
  const all = [...p.z, p.target];
  let zlo = Math.min(...all) / 3, zhi = Math.max(...p.z, p.target) * 4;
  zlo = Math.pow(10, Math.floor(Math.log10(zlo))); zhi = Math.pow(10, Math.ceil(Math.log10(zhi)));
  const X = (f) => L + (W - L - R) * Math.log10(f / f0) / Math.log10(f1 / f0);
  const Y = (z) => T + (H - T - B) * (1 - Math.log10(Math.min(Math.max(z, zlo), zhi) / zlo) / Math.log10(zhi / zlo));
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Impedance of the decoupling network against frequency', style: 'display:block;height:auto' });
  svg.append(s('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'var(--sunken)', stroke: 'var(--line)' }));
  for (let d = zlo; d <= zhi * 1.001; d *= 10) {
    svg.append(s('line', { x1: L, x2: W - R, y1: Y(d), y2: Y(d), stroke: 'var(--line-soft)' }));
    svg.append(s('text', { x: L - 5, y: Y(d) + 3, 'text-anchor': 'end', fill: 'var(--ink-soft)', 'font-size': 10 }, si(d, 'Ω')));
  }
  const step = W < 420 ? 100 : 10;
  for (let d = Math.pow(10, Math.ceil(Math.log10(f0))); d <= f1 * 1.001; d *= step) {
    svg.append(s('line', { x1: X(d), x2: X(d), y1: T, y2: H - B, stroke: 'var(--line-soft)' }));
    svg.append(s('text', { x: X(d), y: H - B + 14, 'text-anchor': X(d) > W - R - 24 ? 'end' : X(d) < L + 20 ? 'start' : 'middle', fill: 'var(--ink-soft)', 'font-size': 10 }, si(d, 'Hz')));
  }
  const path = (zs) => zs.map((z, i) => `${i ? 'L' : 'M'}${X(p.f[i]).toFixed(1)},${Y(z).toFixed(1)}`).join('');
  const colours = ['var(--tool-s1)', 'var(--tool-s2)', 'var(--tool-s3)', 'var(--ink-soft)'];
  partZ.forEach((zs, i) => svg.append(s('path', { d: path(zs), fill: 'none', stroke: colours[i % colours.length], 'stroke-width': 1.2, 'stroke-dasharray': '3 3', opacity: 0.9 })));
  svg.append(s('line', { x1: L, x2: W - R, y1: Y(p.target), y2: Y(p.target), stroke: 'var(--danger)', 'stroke-width': 1.5, 'stroke-dasharray': '6 4' }));
  svg.append(s('text', { x: W - R - 4, y: Y(p.target) - 4, 'text-anchor': 'end', fill: 'var(--danger)', 'font-size': 10 }, `target ${si(p.target, 'Ω')}`));
  svg.append(s('path', { d: path(p.z), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2.2 }));

  const legend = document.createElement('div');
  legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--ink-soft);margin-top:4px';
  const item = (colour, label, dash) => {
    const sp = document.createElement('span');
    const i = document.createElement('i');
    i.style.cssText = `display:inline-block;width:14px;height:0;border-top:2px ${dash ? 'dashed' : 'solid'} ${colour};margin-right:4px;vertical-align:middle`;
    sp.append(i, label); return sp;
  };
  legend.append(item('var(--accent)', 'network |Z|'), item('var(--danger)', 'target', true),
    ...p.parts.map((k, i) => item(colours[i % colours.length], k.label, true)));
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = 'Impedance against frequency (log-log)';
  const box = document.createElement('div');
  box.className = 'k-block';
  box.append(title, svg, legend);
  el.append(box);
}
