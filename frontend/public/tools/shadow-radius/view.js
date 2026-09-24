// Live preview: a card on a stage with the computed box-shadow and radius,
// and a nested box showing the inner radius. Click the stage to point the
// shadow: the direction and distance follow the click.
export function view(el, result, input, api) {
  el.replaceChildren();
  const d = result && result.drawing;
  if (!d) return;
  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = 'Preview (click the stage to aim the shadow)';
  const stage = document.createElement('div');
  stage.style.cssText = 'position:relative;height:240px;border-radius:6px;background:var(--paper);border:1px solid var(--line-soft);'
    + 'display:flex;align-items:center;justify-content:center;cursor:crosshair;overflow:hidden;touch-action:manipulation';
  const card = document.createElement('div');
  card.style.cssText = `width:min(190px,55%);height:120px;background:var(--surface);box-sizing:border-box;padding:${Math.min(d.padding, 40)}px;`
    + `border-radius:${d.radius}px;box-shadow:${d.shadow};display:flex;pointer-events:none`;
  const inner = document.createElement('div');
  inner.style.cssText = `flex:1;border-radius:${d.inner}px;background:var(--sunken);border:1px dashed var(--line);display:flex;align-items:center;justify-content:center;`
    + 'font:11px "IBM Plex Mono",ui-monospace,monospace;color:var(--ink-soft);text-align:center;min-width:0';
  inner.textContent = `r ${api.fmtNum(d.radius, 4)} / ${api.fmtNum(d.inner, 4)}`;
  card.append(inner);
  // Direction marker from the card centre.
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none');
  stage.append(svg, card);
  wrap.append(title, stage);
  el.append(wrap);
  const w = stage.clientWidth || 300, h = stage.clientHeight || 240;
  const a = (d.angle * Math.PI) / 180, len = Math.min(d.distance * 4, Math.min(w, h) / 2 - 8);
  const line = document.createElementNS(NS, 'line');
  const cx = w / 2, cy = h / 2;
  for (const [k, v] of Object.entries({ x1: cx, y1: cy, x2: cx + Math.sin(a) * len, y2: cy - Math.cos(a) * len, stroke: 'var(--accent)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' })) line.setAttribute(k, v);
  const dot = document.createElementNS(NS, 'circle');
  for (const [k, v] of Object.entries({ cx: cx + Math.sin(a) * len, cy: cy - Math.cos(a) * len, r: 4, fill: 'var(--accent)' })) dot.setAttribute(k, v);
  svg.append(line, dot);
  stage.addEventListener('click', (e) => {
    const r = stage.getBoundingClientRect();
    const dx = e.clientX - r.left - r.width / 2, dy = e.clientY - r.top - r.height / 2;
    const ang = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360);
    const dist = Math.round(Math.min(64, Math.hypot(dx, dy) / 4));
    api.set('angle', String(ang));
    api.set('distance', String(dist));
  });
}
