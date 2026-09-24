// The screen to scale with the unsafe areas shaded, the cutout, the home
// indicator and the safe rectangle; a screenshot can be laid under it
// (it stays in this page only - nothing is uploaded).
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
let shot = null; // { url, w, h, name }
let lastArgs = null;
let clipN = 0;

export function view(el, result, input, api) {
  lastArgs = [el, result, input, api];
  el.replaceChildren();
  const d = result && result.drawing;
  if (!d) return;
  const f = (v) => api.fmtNum(v, 4);
  const pad = 26;
  const k = Math.min(1, 520 / d.H, 560 / d.W); // pt -> svg units, fits the column
  const VW = d.W * k + pad * 2, VH = d.H * k + pad * 2;
  const X = (x) => pad + x * k, Y = (y) => pad + y * k;
  const svg = s('svg', { viewBox: `0 0 ${VW} ${VH}`, width: '100%', role: 'img', 'aria-label': `${d.name} safe area`,
    style: `display:block;max-height:${Math.min(620, VH)}px;margin:0 auto` });
  const txt = { 'font-size': 11, 'font-family': 'IBM Plex Mono, ui-monospace, monospace' };
  const R = Math.min(d.r * k, (d.W * k) / 2);
  const clipId = `sa-clip-${++clipN}`;
  const defs = s('defs');
  const clip = s('clipPath', { id: clipId });
  clip.append(s('rect', { x: X(0), y: Y(0), width: d.W * k, height: d.H * k, rx: R }));
  defs.append(clip); svg.append(defs);
  const g = s('g', { 'clip-path': `url(#${clipId})` });
  g.append(s('rect', { x: X(0), y: Y(0), width: d.W * k, height: d.H * k, fill: 'var(--sunken)' }));
  if (shot) g.append(s('image', { href: shot.url, x: X(0), y: Y(0), width: d.W * k, height: d.H * k, preserveAspectRatio: 'none' }));
  // unsafe bands
  const band = (x, y, w, h) => { if (w > 0 && h > 0) g.append(s('rect', { x: X(x), y: Y(y), width: w * k, height: h * k, fill: 'var(--danger)', 'fill-opacity': shot ? 0.35 : 0.18 })); };
  band(0, 0, d.W, d.top);
  band(0, d.H - d.bottom, d.W, d.bottom);
  band(0, d.top, d.left, d.H - d.top - d.bottom);
  band(d.W - d.right, d.top, d.right, d.H - d.top - d.bottom);
  // cutout
  if (d.cut) {
    const c = d.cut;
    if (c.kind === 'punch') g.append(s('circle', { cx: X(c.x + c.w / 2), cy: Y(c.y + c.h / 2), r: (c.w / 2) * k, fill: 'var(--ink)' }));
    else if (c.kind === 'island') g.append(s('rect', { x: X(c.x), y: Y(c.y), width: c.w * k, height: c.h * k, rx: (Math.min(c.w, c.h) / 2) * k, fill: 'var(--ink)' }));
    else {
      const rr = Math.min(c.w, c.h) * 0.35 * k;
      // notch: square top edge, rounded bottom corners (landscape: rotated to the left edge)
      if (!d.land) g.append(s('path', { d: `M${X(c.x)},${Y(0)} h${c.w * k} v${c.h * k - rr} a${rr},${rr} 0 0 1 ${-rr},${rr} h${-(c.w * k - 2 * rr)} a${rr},${rr} 0 0 1 ${-rr},${-rr} z`, fill: 'var(--ink)' }));
      else g.append(s('path', { d: `M${X(0)},${Y(c.y)} h${c.w * k - rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${c.h * k - 2 * rr} a${rr},${rr} 0 0 1 ${-rr},${rr} h${-(c.w * k - rr)} z`, fill: 'var(--ink)' }));
    }
  }
  if (d.homeInd) {
    const w = d.homeInd.w, y = d.H - d.homeInd.gap - d.homeInd.h;
    g.append(s('rect', { x: X((d.W - w) / 2), y: Y(y), width: w * k, height: d.homeInd.h * k, rx: 2.5 * k, fill: 'var(--ink)' }));
  }
  if (d.nav && d.nav.kind === 'buttons') {
    const n = d.nav, cx = n.side === 'bottom' ? null : d.W - n.size / 2, cy = n.side === 'bottom' ? d.H - n.size / 2 : null;
    [0.25, 0.5, 0.75].forEach((t, i) => {
      const x = cx ?? d.W * t, y = cy ?? d.H * (1 - t);
      const sym = i === 0 ? '◁' : i === 1 ? '○' : '□';
      g.append(s('text', { ...txt, 'font-size': Math.max(9, 14 * k), x: X(x), y: Y(y) + 4, 'text-anchor': 'middle', fill: 'var(--ink)' }, n.side === 'bottom' ? sym : ['□', '○', '◁'][i]));
    });
  } else if (d.nav) {
    const w = 108;
    g.append(s('rect', { x: X((d.W - w) / 2), y: Y(d.H - 12), width: w * k, height: 4 * k, rx: 2 * k, fill: 'var(--ink)' }));
  }
  svg.append(g);
  // outline and safe rectangle
  svg.append(s('rect', { x: X(0), y: Y(0), width: d.W * k, height: d.H * k, rx: R, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 2 }));
  svg.append(s('rect', { x: X(d.left), y: Y(d.top), width: (d.W - d.left - d.right) * k, height: (d.H - d.top - d.bottom) * k, fill: 'none', stroke: 'var(--ok)', 'stroke-width': 1.5, 'stroke-dasharray': '6 4' }));
  // labels outside the phone
  const lab = (x, y, t, anchor = 'middle') => svg.append(s('text', { ...txt, x, y, 'text-anchor': anchor, fill: 'var(--ink-soft)' }, t));
  lab(VW / 2, pad - 8, `top ${f(d.top)} ${d.unit}`);
  lab(VW / 2, VH - 8, `bottom ${f(d.bottom)} ${d.unit}`);
  if (d.left) lab(pad - 4, VH / 2, `${f(d.left)}`, 'end');
  if (d.right) lab(VW - pad + 4, VH / 2, `${f(d.right)}`, 'start');
  svg.append(s('text', { ...txt, x: X(d.left) + 6, y: Y(d.top) + 16, fill: 'var(--ok)' }, `safe ${f(d.W - d.left - d.right)} × ${f(d.H - d.top - d.bottom)}`));

  // the screenshot picker
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;font-size:12px;color:var(--ink-soft)';
  const pick = document.createElement('label');
  pick.className = 'k-btn';
  pick.textContent = shot ? 'Change screenshot' : 'Load a screenshot';
  const file = document.createElement('input');
  file.type = 'file'; file.accept = 'image/*'; file.style.display = 'none';
  file.addEventListener('change', () => {
    const fl = file.files && file.files[0];
    if (!fl) return;
    const rd = new FileReader();
    rd.onload = () => {
      const im = new Image();
      im.onload = () => { shot = { url: rd.result, w: im.naturalWidth, h: im.naturalHeight, name: fl.name }; if (lastArgs) view(...lastArgs); };
      im.src = rd.result;
    };
    rd.readAsDataURL(fl);
  });
  pick.append(file);
  bar.append(pick);
  if (shot) {
    const rm = document.createElement('button');
    rm.className = 'k-btn'; rm.textContent = 'Remove';
    rm.addEventListener('click', () => { shot = null; if (lastArgs) view(...lastArgs); });
    bar.append(rm);
    const expW = Math.round(d.W * d.scale), expH = Math.round(d.H * d.scale);
    const info = document.createElement('span');
    const aspect = Math.abs(shot.w / shot.h - d.W / d.H) / (d.W / d.H);
    info.textContent = `${shot.name}: ${shot.w} × ${shot.h} px` + (shot.w === expW && shot.h === expH ? ' - matches this screen' : ` - this screen is ${expW} × ${expH} px${aspect > 0.02 ? '; the aspect differs, so it is stretched: pick the matching device or orientation' : ''}`);
    if (aspect > 0.02) info.style.color = 'var(--warn)';
    bar.append(info);
  } else {
    const hint = document.createElement('span');
    hint.textContent = `Expected size ${Math.round(d.W * d.scale)} × ${Math.round(d.H * d.scale)} px. The image stays in this page.`;
    bar.append(hint);
  }
  const wrap = document.createElement('div');
  wrap.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = `${d.name}, ${d.land ? 'landscape' : 'portrait'} · shaded = outside the safe area`;
  wrap.append(title, bar, svg);
  el.append(wrap);
}
