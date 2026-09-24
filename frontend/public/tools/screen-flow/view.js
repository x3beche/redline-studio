// The screen flow as a layered diagram: one column (wide) or row (narrow) per
// step from the start screen, boxes for screens, arrows for transitions.
// Back edges (to the same or an earlier step) arc around. Click a screen to
// show the shortest path to it (sets the Goal input). Drawn from result.graph.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const fit = (t, px, size) => {
  const max = Math.max(3, Math.floor(px / (size * 0.58)));
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

export function view(el, result, input, api) {
  el.replaceChildren();
  const g = result?.graph;
  if (!g || !g.nodes?.length) return;
  const W = Math.max(280, Math.round(el.clientWidth || el.parentElement?.clientWidth || 600) - 22);
  const nL = g.layers.length;
  const maxPer = Math.max(...g.layers.map((L) => L.length));
  const LR = nL * 120 <= W; // left-to-right when every step gets a 120 px column
  const M = 10, BH = 34, GAP = 22;
  let BW, pos = new Map(), H, gapW = 90;
  if (LR) {
    const colW = (W - 2 * M) / nL;
    BW = Math.min(150, colW - 56);
    gapW = colW - BW - 6;
    const rowH = BH + GAP + 12;
    H = 2 * M + 40 + maxPer * rowH;
    g.layers.forEach((L, li) => L.forEach((n, i) => {
      const off = ((maxPer - L.length) * rowH) / 2;
      pos.set(n, { x: M + li * colW + (colW - BW) / 2, y: M + 20 + off + i * rowH });
    }));
  } else {
    const colW = (W - 2 * M) / Math.max(1, maxPer);
    BW = Math.min(150, colW - 12);
    const rowH = BH + 46;
    H = 2 * M + nL * rowH;
    g.layers.forEach((L, li) => L.forEach((n, i) => {
      const cw = (W - 2 * M) / L.length;
      pos.set(n, { x: M + i * cw + (cw - BW) / 2, y: M + li * rowH + 6 });
    }));
  }
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'screen flow diagram', style: 'display:block' });
  const defs = s('defs');
  for (const [id, col] of [['sf-arrow', 'var(--ink-soft)'], ['sf-arrow-hot', 'var(--accent)']]) {
    const mk = s('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' });
    mk.append(s('path', { d: 'M0,0 L10,5 L0,10 z', fill: col }));
    defs.append(mk);
  }
  svg.append(defs);

  // step labels
  g.layers.forEach((L, li) => {
    if (!L.length) return;
    const unreach = L.every((n) => g.nodes.find((x) => x.name === n)?.depth == null);
    const t = unreach ? 'unreachable' : li === 0 ? 'start' : `step ${li}`;
    const p = pos.get(L[0]);
    if (LR) svg.append(s('text', { x: p.x + BW / 2, y: M + 8, 'text-anchor': 'middle', fill: 'var(--ink-soft)', 'font-size': 10.5 }, t));
    else svg.append(s('text', { x: M, y: p.y - 5, fill: 'var(--ink-soft)', 'font-size': 10 }, t));
  });

  // edges
  const layerOf = new Map(g.nodes.map((n) => [n.name, n.layer]));
  const edgeLayer = s('g');
  const labelLayer = s('g');
  g.edges.forEach((e, k) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) return;
    const hot = e.onPath;
    const col = hot ? 'var(--accent)' : 'var(--ink-soft)';
    let d, lx, ly;
    if (e.from === e.to) {
      const x = a.x + BW - 14, y = a.y;
      d = `M${x},${y} C${x - 4},${y - 26} ${x + 26},${y - 26} ${x + 12},${y}`;
      lx = x + 6; ly = y - 22;
    } else if (!e.back) {
      if (LR) {
        const x1 = a.x + BW, y1 = a.y + BH / 2, x2 = b.x, y2 = b.y + BH / 2, mx = (x1 + x2) / 2;
        d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`; lx = mx; ly = (y1 + y2) / 2;
      } else {
        const x1 = a.x + BW / 2, y1 = a.y + BH, x2 = b.x + BW / 2, y2 = b.y, my = (y1 + y2) / 2;
        d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`; lx = (x1 + x2) / 2; ly = my;
      }
    } else {
      const span = Math.abs(layerOf.get(e.from) - layerOf.get(e.to));
      const bulge = 18 + 10 * span + (k % 3) * 5;
      if (LR && span === 0) {
        // same step: arc out to the right of the column
        const x1 = a.x + BW, y1 = a.y + BH / 2 + 4, x2 = b.x + BW, y2 = b.y + BH / 2 - 4;
        const xb = x1 + 16 + Math.abs(y2 - y1) * 0.12;
        d = `M${x1},${y1} C${xb},${y1} ${xb},${y2} ${x2},${y2}`; lx = xb; ly = (y1 + y2) / 2;
      } else if (LR) {
        const x1 = a.x + BW / 2 + 8, y1 = a.y + BH, x2 = b.x + BW / 2 - 8, y2 = b.y + BH;
        const yb = Math.max(y1, y2) + bulge;
        d = `M${x1},${y1} C${x1},${yb} ${x2},${yb} ${x2},${y2}`; lx = (x1 + x2) / 2; ly = yb - bulge * 0.25;
      } else {
        const x1 = a.x, y1 = a.y + BH / 2 + 5, x2 = b.x, y2 = b.y + BH / 2 - 5;
        const xb = Math.max(M - 4, Math.min(x1, x2) - bulge);
        d = `M${x1},${y1} C${xb},${y1} ${xb},${y2} ${x2},${y2}`; lx = xb + 2; ly = (y1 + y2) / 2;
      }
    }
    const path = s('path', { d, fill: 'none', stroke: col, 'stroke-width': hot ? 2.2 : 1.3, 'stroke-dasharray': e.back && !hot ? '4 3' : null, 'marker-end': `url(#${hot ? 'sf-arrow-hot' : 'sf-arrow'})` });
    path.append(s('title', {}, `${e.from} → ${e.to}${e.label ? `: ${e.label}` : ''}`));
    edgeLayer.append(path);
    if (e.label && W >= 420 && (hot || g.edges.length <= 16)) {
      const t = fit(e.label, LR && !e.back ? gapW : 110, 10);
      const tw = t.length * 5.8 + 6;
      labelLayer.append(s('rect', { x: lx - tw / 2, y: ly - 8, width: tw, height: 13, rx: 3, fill: 'var(--surface)', opacity: 0.9 }));
      labelLayer.append(s('text', { x: lx, y: ly + 2, 'text-anchor': 'middle', fill: hot ? 'var(--accent)' : 'var(--ink-soft)', 'font-size': 10 }, t));
    }
  });
  svg.append(edgeLayer, labelLayer);

  // nodes
  for (const n of g.nodes) {
    const p = pos.get(n.name);
    const onPath = g.path?.includes(n.name);
    const stroke = n.status === 'start' ? 'var(--accent)' : n.status === 'unreachable' ? 'var(--danger)' : n.status === 'dead end' ? 'var(--warn)' : onPath ? 'var(--accent)' : 'var(--line)';
    const grp = s('g', { style: 'cursor:pointer', tabindex: 0, role: 'button', 'aria-label': `Show the path to ${n.name}` });
    grp.append(s('rect', { x: p.x, y: p.y, width: BW, height: BH, rx: n.status === 'end' ? BH / 2 : 6,
      fill: onPath ? 'var(--sunken)' : 'var(--surface)', stroke, 'stroke-width': n.status === 'start' || onPath ? 2 : 1.3,
      'stroke-dasharray': n.status === 'unreachable' ? '4 3' : null }));
    grp.append(s('text', { x: p.x + BW / 2, y: p.y + BH / 2 + 4, 'text-anchor': 'middle', fill: 'var(--ink)', 'font-size': 12, 'font-weight': n.status === 'start' ? 600 : 500 }, fit(n.name, BW - 10, 12)));
    grp.append(s('title', {}, `${n.name}${n.depth != null ? ` · ${n.depth} step${n.depth === 1 ? '' : 's'} from start` : ' · unreachable'}${n.status && n.status !== 'start' ? ` · ${n.status}` : ''}`));
    const pick = () => api.set('goal', api.raw.goal === n.name ? '' : n.name);
    grp.addEventListener('click', pick);
    grp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
    svg.append(grp);
  }

  const block = document.createElement('div');
  block.className = 'k-block';
  const t = document.createElement('div'); t.className = 'k-title';
  t.textContent = g.path ? `Screen flow · path to ${g.path[g.path.length - 1]}` : 'Screen flow · click a screen for its path';
  const legend = document.createElement('div'); legend.className = 'k-legend';
  for (const [c, label, dash] of [['var(--accent)', 'start / path'], ['var(--warn)', 'dead end'], ['var(--danger)', 'unreachable', true], ['var(--ink-soft)', 'back edge', true]]) {
    const sp = document.createElement('span');
    const i = document.createElement('i');
    i.style.cssText = `background:none;border-top:2px ${dash ? 'dashed' : 'solid'} ${c};height:0;width:14px;display:inline-block;vertical-align:middle`;
    sp.append(i, label); legend.append(sp);
  }
  block.append(t, svg, legend);
  el.append(block);
}
