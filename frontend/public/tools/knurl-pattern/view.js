// Side view of the knurled cylinder (grooves projected on the visible half)
// and an end view of the tooth ring, both from result.drawing.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};

export function view(el, result, input, api) {
  el.replaceChildren();
  const g = result && result.drawing;
  if (!g || !(g.d > 0) || !(g.len > 0) || !(g.N > 0)) return;
  const W = Math.max(300, Math.min(640, (el.parentElement?.clientWidth || 640) - 22));
  const Hmax = 230, pad = 16, endW = Math.min(170, W * 0.32);
  // One scale for both views so they stay to scale.
  const k = Math.min((Hmax - 2 * pad - 18) / g.d, (W - endW - 3 * pad - 48) / g.len, (endW - pad) / g.d);
  const R = g.d / 2, Rr = Math.max(0, g.root / 2);
  const H = Math.min(Hmax, pad + 4 + 2 * R * k + 34);          // no empty band under a small drawing
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', style: 'display:block;max-height:260px',
    'aria-label': `Knurl, ${g.N} grooves on diameter ${g.d} mm` });
  const txt = { 'font-size': 11, 'font-family': 'IBM Plex Mono, ui-monospace, monospace', fill: 'var(--ink-soft)' };

  // End view: the tooth ring (crest on R, root on R - depth), 90 deg V grooves.
  const ecx = pad + endW / 2 - 4, ecy = pad + 4 + R * k;
  const pts = [];
  for (let i = 0; i < g.N; i++) {
    const a0 = (2 * Math.PI * i) / g.N, a1 = a0 + Math.PI / g.N;
    pts.push([ecx + R * k * Math.cos(a0), ecy + R * k * Math.sin(a0)], [ecx + Rr * k * Math.cos(a1), ecy + Rr * k * Math.sin(a1)]);
  }
  svg.append(s('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('') + 'Z',
    fill: 'var(--tool-s0)', 'fill-opacity': 0.18, stroke: 'var(--ink)', 'stroke-width': 0.8 }));
  svg.append(s('circle', { cx: ecx, cy: ecy, r: 2, fill: 'var(--ink)' }));
  svg.append(s('text', { ...txt, x: ecx, y: H - 8, 'text-anchor': 'middle' }, `end: ${g.N} teeth`));

  // Side view: axis horizontal. A groove of hand h at angle t0 sits at
  // theta(z) = t0 + h z tan(beta) / R; it shows where cos(theta) > 0.
  const x0 = pad * 2 + endW, y0 = ecy, Lp = g.len * k;
  svg.append(s('rect', { x: x0, y: y0 - R * k, width: Lp, height: 2 * R * k, fill: 'var(--sunken)', stroke: 'var(--ink)', 'stroke-width': 1.2 }));
  const tb = Math.tan((g.beta * Math.PI) / 180);
  const steps = 60;
  const paths = [];
  for (const h of g.hands) {
    for (let i = 0; i < g.N; i++) {
      const t0 = (2 * Math.PI * i) / g.N;
      let d = '', pen = false;
      for (let j = 0; j <= steps; j++) {
        const z = (g.len * j) / steps;
        const th = t0 + (h * z * tb) / R;
        if (Math.cos(th) > 0.02) {
          const X = x0 + z * k, Y = y0 - R * k * Math.sin(th);
          d += `${pen ? 'L' : 'M'}${X.toFixed(1)},${Y.toFixed(1)}`; pen = true;
        } else pen = false;
      }
      if (d) paths.push(d);
    }
  }
  svg.append(s('path', { d: paths.join(''), fill: 'none', stroke: g.hands.length > 1 ? 'var(--accent)' : 'var(--tool-s1)', 'stroke-width': 0.9, 'stroke-opacity': 0.9 }));
  // Dimensions.
  svg.append(s('line', { x1: x0, x2: x0 + Lp, y1: y0 + R * k + 10, y2: y0 + R * k + 10, stroke: 'var(--line)' }));
  svg.append(s('text', { ...txt, x: x0 + Lp / 2, y: y0 + R * k + 24, 'text-anchor': 'middle' }, `L ${api.fmtNum(g.len, 4)} mm`));
  svg.append(s('text', { ...txt, x: x0 + Lp + 6, y: y0 + 4 }, `Ø${api.fmtNum(g.d, 4)}`));

  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = 'End and side view, to scale (front half of the grooves)';
  wrap.append(title, svg);
  el.append(wrap);
}
