// The stack as a cross-section: copper bands (solid for planes, traces for
// signal layers), dielectrics scaled by thickness, and each signal layer's
// target widths beside it. Thin rows get a minimum height so every row is readable.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};

export function view(el, result, input, api) {
  el.replaceChildren();
  const stack = result && result.stack;
  if (!stack || !stack.length) return;
  const fmt = api && api.fmtNum ? (v, d = 3) => api.fmtNum(v, d) : (v) => String(v);
  const W = Math.max(300, Math.min(1000, el.clientWidth || (el.parentElement && el.parentElement.clientWidth) || 560));
  const narrow = W < 460;
  const maxD = Math.max(1, ...stack.filter((r) => r.kind === 'prepreg' || r.kind === 'core').map((r) => r.t));
  const hOf = (r) => (r.kind === 'mask' ? 12 : ['signal', 'plane', 'mixed'].includes(r.kind) ? 18 : 20 + 56 * (r.t / maxD));
  const top = 8, x0 = 4, x1 = W - 4;
  let y = top;
  const svg = s('svg', { width: '100%', role: 'img', 'aria-label': 'Stackup cross-section', style: 'display:block' });
  const font = 'font: 11px ui-monospace, monospace';
  const txt = (x, yy, t, anchor, fill = 'var(--ink)') => svg.append(s('text', { x, y: yy, 'text-anchor': anchor, fill, style: font }, t));
  const zse = input && input.zse, zd = input && input.zdiff;
  for (const r of stack) {
    const h = hOf(r);
    const mid = y + h / 2 + 4;
    if (r.kind === 'plane' || r.kind === 'mixed') {
      svg.append(s('rect', { x: x0, y, width: x1 - x0, height: h, fill: 'var(--tool-s1)', 'fill-opacity': r.kind === 'plane' ? 0.55 : 0.4 }));
      if (r.kind === 'mixed') {
        for (let x = x0 + 40; x < x1 - 30; x += 90) svg.append(s('rect', { x, y, width: 10, height: h, fill: 'var(--surface)' }));
      }
    } else if (r.kind === 'signal') {
      svg.append(s('rect', { x: x0, y, width: x1 - x0, height: h, fill: 'var(--surface)' }));
      for (let x = x0 + 8; x < x1 - 20; x += 34) svg.append(s('rect', { x, y: y + 2, width: 18, height: h - 4, fill: 'var(--tool-s1)', 'fill-opacity': 0.55 }));
    } else if (r.kind === 'mask') {
      svg.append(s('rect', { x: x0, y, width: x1 - x0, height: h, fill: 'var(--tool-s2)', 'fill-opacity': 0.35 }));
    } else {
      svg.append(s('rect', { x: x0, y, width: x1 - x0, height: h, fill: r.kind === 'core' ? 'var(--line)' : 'var(--sunken)' }));
    }
    svg.append(s('line', { x1: x0, x2: x1, y1: y + h, y2: y + h, stroke: 'var(--line-soft)' }));
    // labels
    const kindName = { signal: 'Signal', plane: 'Plane', mixed: 'Mixed', prepreg: 'Prepreg', core: 'Core', mask: 'Mask' }[r.kind];
    const left = r.name ? `${r.name} ${kindName}${r.structure && r.kind !== 'plane' && !narrow ? ` · ${r.structure}` : ''}` : kindName;
    let right = `${fmt(r.t, 4)} µm${r.er ? ` · Er ${r.er}` : ''}`;
    if (r.name && r.kind !== 'plane' && (r.wse != null || r.wdiff != null)) {
      const a = r.wse != null ? fmt(r.wse) : '–', b = r.wdiff != null ? fmt(r.wdiff) : '–';
      right = narrow ? `${a} / ${b} mm` : `${fmt(r.t, 3)} µm · ${zse || ''} Ω ${a} mm · ${zd || ''} Ω ${b} mm`;
    }
    const pad = r.kind === 'signal' ? 6 : 8;
    // a backing so labels stay readable over traces
    const lw = left.length * 6.7 + 8, rw = right.length * 6.7 + 8;
    if (r.kind === 'signal' || r.kind === 'mixed' || r.kind === 'plane') {
      svg.append(s('rect', { x: x0 + pad - 4, y: mid - 12, width: lw, height: 16, rx: 3, fill: 'var(--surface)', 'fill-opacity': 0.85 }));
      svg.append(s('rect', { x: x1 - pad - rw + 4, y: mid - 12, width: rw, height: 16, rx: 3, fill: 'var(--surface)', 'fill-opacity': 0.85 }));
    }
    if (h >= 11) {
      txt(x0 + pad, mid, left, 'start');
      txt(x1 - pad, mid, right, 'end', 'var(--ink-soft)');
    }
    y += h;
  }
  const total = stack.reduce((a, r) => a + r.t, 0) / 1000;
  txt(x0, y + 16, `${fmt(total, 4)} mm total · ${stack.filter((r) => ['signal', 'plane', 'mixed'].includes(r.kind)).length} copper layers${(zse || zd) && !narrow ? ` · widths for ${zse || '–'} Ω single / ${zd || '–'} Ω pair` : ''}`, 'start', 'var(--ink-soft)');
  svg.setAttribute('viewBox', `0 0 ${W} ${y + 24}`);
  el.append(svg);
}
