// The path drawn to fit the width with its nodes: endpoints as squares,
// control points as circles on handle lines. Drag a node to move it; on
// release the edited path (in the chosen output style) replaces the input.
import { nodesOf, moveNode, serialize } from './tool.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};

export function view(el, result, input, api) {
  el.replaceChildren();
  let segs = result?.segments;
  const box = result?.box;
  if (!segs?.length || !box) return;
  const W = Math.max(260, Math.round(el.clientWidth || el.parentElement?.clientWidth || 600) - 22);
  const bw = box.w || 1, bh = box.h || 1;
  const pad = Math.max(bw, bh) * 0.08 + 1;
  const vx = box.x - pad, vy = box.y - pad, vw = bw + 2 * pad, vh = bh + 2 * pad;
  const H = Math.min(440, Math.max(160, Math.round((W * vh) / vw)));
  const unit = Math.max(vw / W, vh / H); // path units per screen pixel
  const svg = s('svg', { viewBox: `${vx} ${vy} ${vw} ${vh}`, width: '100%', height: H, preserveAspectRatio: 'xMidYMid meet',
    role: 'img', 'aria-label': 'path with its nodes', style: 'display:block;touch-action:none;background:var(--sunken);border-radius:6px' });
  const opts = { ...(result.options || {}), tx: 0, ty: 0, scale: 1 };
  const full = { mode: 'absolute', dec: null, compact: false, shorthand: false };
  const path = s('path', { d: serialize(segs, full).d, fill: 'var(--accent)', 'fill-opacity': 0.12, stroke: 'var(--ink)',
    'stroke-width': 1.5 * unit, 'stroke-linejoin': 'round' });
  const handles = s('g');
  const dots = s('g');
  svg.append(path, handles, dots);

  const draw = () => {
    handles.replaceChildren(); dots.replaceChildren();
    path.setAttribute('d', serialize(segs, full).d);
    for (const n of nodesOf(segs)) {
      if (n.kind === 'ctrl') {
        handles.append(s('line', { x1: n.ax, y1: n.ay, x2: n.x, y2: n.y, stroke: 'var(--tool-s1)', 'stroke-width': unit }));
        if (n.bx != null) handles.append(s('line', { x1: n.bx, y1: n.by, x2: n.x, y2: n.y, stroke: 'var(--tool-s1)', 'stroke-width': unit }));
      }
      const r = 5 * unit;
      const shape = n.kind === 'end'
        ? s('rect', { x: n.x - r, y: n.y - r, width: 2 * r, height: 2 * r, fill: 'var(--accent)', stroke: 'var(--surface)', 'stroke-width': unit })
        : s('circle', { cx: n.x, cy: n.y, r, fill: 'var(--surface)', stroke: 'var(--tool-s1)', 'stroke-width': 1.5 * unit });
      shape.style.cursor = 'move';
      shape.append(s('title', {}, `segment ${n.seg}${n.kind === 'ctrl' ? ' control' : ''}: ${api.fmtNum(n.x, 6)}, ${api.fmtNum(n.y, 6)} — drag to move`));
      shape.addEventListener('pointerdown', (e) => start(e, n));
      dots.append(shape);
    }
  };

  const toPath = (e) => {
    const m = svg.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return p;
  };
  let drag = null;
  function start(e, n) {
    e.preventDefault();
    drag = n;
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  }
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toPath(e);
    if (!p) return;
    segs = moveNode(segs, drag.seg, drag.slot, p.x, p.y);
    draw();
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    api.set('d', serialize(segs, opts).d);
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  draw();

  const block = document.createElement('div');
  block.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = 'Drag a node to move it (drawn before translate and scale)';
  block.append(title, svg);
  el.append(block);
}
