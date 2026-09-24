// The rail tree as an indented diagram: one box per node, elbow lines to its
// parent, a bar for the share of its rating in use. Drawn from result.tree.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const STRIPE = { source: 'var(--tool-s0)', switcher: 'var(--tool-s1)', ldo: 'var(--tool-s2)', load: 'var(--tool-s3)' };

export function view(el, result, input, api) {
  el.replaceChildren();
  const tree = result?.tree || [];
  if (!tree.length) return;
  const fmt = (v, u) => {
    if (v == null || !Number.isFinite(v)) return '–';
    const a = Math.abs(v);
    if (a !== 0 && a < 1) return `${api.fmtNum(v * 1000, 3)} m${u}`;
    return `${api.fmtNum(v, 3)} ${u}`;
  };
  // el is display:none while empty, so measure the column it sits in
  const W = Math.max(280, Math.round(el.clientWidth || el.parentElement?.clientWidth || 600) - 22);
  const narrow = W < 480;
  const IND = narrow ? 16 : 26, RH = narrow ? 60 : 46, BH = narrow ? 52 : 38, TOP = 4;
  const H = TOP + tree.length * RH;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'power rail tree', style: 'display:block' });
  const rowOf = new Map();
  tree.forEach((n, i) => rowOf.set(n.name, i));
  tree.forEach((n, i) => {
    const x = 2 + n.depth * IND, y = TOP + i * RH;
    // elbow from the parent's left edge
    const pi = n.parent ? rowOf.get(n.parent) : undefined;
    if (pi != null) {
      const px = 2 + tree[pi].depth * IND + 8, py = TOP + pi * RH + BH;
      svg.append(s('path', { d: `M${px},${py} V${y + BH / 2} H${x}`, fill: 'none', stroke: 'var(--line)', 'stroke-width': 1.5 }));
    }
    const bw = W - x - 2;
    svg.append(s('rect', { x, y, width: bw, height: BH, rx: 5, fill: 'var(--surface)', stroke: 'var(--line)' }));
    svg.append(s('rect', { x, y, width: 4, height: BH, rx: 2, fill: STRIPE[n.type] || 'var(--ink-soft)' }));
    const title = s('text', { x: x + 10, y: y + 15, fill: 'var(--ink)', 'font-size': 12, 'font-weight': 600 });
    title.textContent = n.name;
    const meta = s('tspan', { fill: 'var(--ink-soft)', 'font-weight': 400, 'font-size': 11 },
      `  ${n.type}${n.vout != null ? ` · ${api.fmtNum(n.vout, 3)} V` : ''}`);
    title.append(meta);
    svg.append(title);
    const parts = [`out ${fmt(n.iout, 'A')}`];
    if (n.type === 'switcher' || n.type === 'ldo') parts.push(`in ${fmt(n.iin, 'A')}`);
    if (n.loss > 0) parts.push(`loss ${fmt(n.loss, 'W')}`);
    else if (n.pout != null && n.type !== 'source') parts.push(`${fmt(n.pout, 'W')}`);
    if (n.type === 'source' && n.pout != null) parts.push(fmt(n.pout, 'W'));
    svg.append(s('text', { x: x + 10, y: y + 30, fill: 'var(--ink-soft)', 'font-size': 11, 'font-family': 'IBM Plex Mono, ui-monospace, monospace' }, parts.join(' · ')));
    // rating bar
    if (n.use != null) {
      const col = n.use > 1 ? 'var(--danger)' : n.use > 0.8 ? 'var(--warn)' : 'var(--ok)';
      const label = `${Math.round(n.use * 100)} % of ${fmt(n.limit, 'A')}`;
      // wide: bar top-right with its label under it; narrow: a third line, bar then label
      const bl = narrow ? 48 : 64;
      const bx = narrow ? x + 10 : x + bw - 74, by = narrow ? y + 38 : y + 8;
      svg.append(s('rect', { x: bx, y: by, width: bl, height: 6, rx: 3, fill: 'var(--sunken)', stroke: 'var(--line-soft)' }));
      svg.append(s('rect', { x: bx, y: by, width: Math.max(1, Math.min(1, n.use) * bl), height: 6, rx: 3, fill: col }));
      svg.append(narrow
        ? s('text', { x: bx + bl + 6, y: by + 6, fill: n.use > 0.8 ? col : 'var(--ink-soft)', 'font-size': 10.5 }, label)
        : s('text', { x: bx + bl, y: by + 19, fill: n.use > 0.8 ? col : 'var(--ink-soft)', 'font-size': 10.5, 'text-anchor': 'end' }, label));
    }
  });
  const legend = document.createElement('div');
  legend.className = 'k-legend';
  for (const [t, c] of Object.entries(STRIPE)) {
    const sp = document.createElement('span');
    const i = document.createElement('i'); i.style.background = c; i.style.height = '8px'; i.style.width = '8px';
    sp.append(i, t); legend.append(sp);
  }
  const block = document.createElement('div');
  block.className = 'k-block';
  const t = document.createElement('div'); t.className = 'k-title'; t.textContent = 'Rail tree';
  block.append(t, svg, legend);
  el.append(block);
}
