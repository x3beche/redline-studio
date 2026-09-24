// The logo as each platform will crop it: the maskable circle, the Android
// adaptive 72 dp window with its 66 dp safe circle, the iOS rounded square
// and a 16 px favicon. Pick an image to preview it (it stays in the browser).
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};

let picked = null; // object URL of the previewed image, kept across redraws
let seq = 0;

export function view(el, result) {
  el.replaceChildren();
  const safe = result?.safe;
  if (!safe) return;
  const W = Math.max(260, Math.round(el.clientWidth || el.parentElement?.clientWidth || 600) - 22);
  const P = Math.min(150, Math.floor((W - 30) / 2)); // panel size
  const cols = Math.max(2, Math.min(4, Math.floor((W + 16) / (P + 16))));
  const panels = [
    { title: 'Maskable (circle crop)', fit: safe.maskable, clip: 'circle', guide: 0.8 },
    { title: 'Android adaptive', fit: { w: safe.adaptive.w, h: safe.adaptive.h }, clip: 'adaptive', guide: 66 / 108 },
    { title: 'Apple touch icon', fit: safe.apple, clip: 'squircle' },
    { title: 'Favicon at 16 px', fit: { w: safe.shape === 'tall' ? 0.5 : 1, h: safe.shape === 'wide' ? 0.5 : 1 }, clip: 'none', tiny: true },
  ];
  const rows = Math.ceil(panels.length / cols);
  const H = rows * (P + 30);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'icon crops per platform', style: 'display:block' });
  const id = `ig${++seq}`;
  panels.forEach((p, i) => {
    const x = (i % cols) * (P + 16), y = Math.floor(i / cols) * (P + 30);
    const g = s('g', { transform: `translate(${x},${y})` });
    g.append(s('text', { x: 0, y: 12, fill: 'var(--ink-soft)', 'font-size': 11 }, p.title));
    const top = 20;
    // clip shape
    const cp = s('clipPath', { id: `${id}c${i}` });
    if (p.clip === 'circle') cp.append(s('circle', { cx: P / 2, cy: top + P / 2, r: P / 2 }));
    else if (p.clip === 'adaptive') cp.append(s('circle', { cx: P / 2, cy: top + P / 2, r: (P * 72) / 108 / 2 }));
    else if (p.clip === 'squircle') cp.append(s('rect', { x: 0, y: top, width: P, height: P, rx: P * 0.2237 }));
    else cp.append(s('rect', { x: 0, y: top, width: P, height: P }));
    g.append(cp);
    // the full canvas, faint, then the cropped icon on top
    g.append(s('rect', { x: 0, y: top, width: P, height: P, fill: 'var(--sunken)', stroke: 'var(--line)', 'stroke-dasharray': '3 3' }));
    const icon = s('g', { 'clip-path': `url(#${id}c${i})` });
    const bgFill = p.tiny ? 'var(--surface)' : safe.background;
    icon.append(s('rect', { x: 0, y: top, width: P, height: P, fill: bgFill }));
    const lw = P * p.fit.w, lh = P * p.fit.h;
    const lx = (P - lw) / 2, ly = top + (P - lh) / 2;
    if (picked) {
      icon.append(s('image', { href: picked, x: lx, y: ly, width: lw, height: lh, preserveAspectRatio: 'xMidYMid meet',
        style: p.tiny ? 'image-rendering:pixelated' : null }));
    } else if (safe.shape === 'circle') {
      icon.append(s('circle', { cx: P / 2, cy: top + P / 2, r: lw / 2, fill: 'var(--accent)' }));
    } else {
      icon.append(s('rect', { x: lx, y: ly, width: lw, height: lh, rx: Math.min(lw, lh) * 0.12, fill: 'var(--accent)' }));
    }
    g.append(icon);
    if (p.tiny) {
      // a 16 x 16 pixel grid over the favicon panel
      for (let k = 1; k < 16; k++) {
        const t = (P * k) / 16;
        g.append(s('line', { x1: t, y1: top, x2: t, y2: top + P, stroke: 'var(--line-soft)', 'stroke-width': 0.5 }));
        g.append(s('line', { x1: 0, y1: top + t, x2: P, y2: top + t, stroke: 'var(--line-soft)', 'stroke-width': 0.5 }));
      }
    }
    if (p.guide) g.append(s('circle', { cx: P / 2, cy: top + P / 2, r: (P * p.guide) / 2, fill: 'none', stroke: 'var(--warn)', 'stroke-dasharray': '4 3' }));
    if (p.clip === 'adaptive') g.append(s('circle', { cx: P / 2, cy: top + P / 2, r: (P * 72) / 108 / 2, fill: 'none', stroke: 'var(--ink-soft)' }));
    svg.append(g);
  });

  const block = document.createElement('div');
  block.className = 'k-block';
  const title = document.createElement('div');
  title.className = 'k-title';
  title.textContent = 'How each platform crops it (dashed orange: safe zone)';
  const pick = document.createElement('input');
  pick.type = 'file';
  pick.accept = 'image/*';
  pick.setAttribute('aria-label', 'Preview an image');
  pick.addEventListener('change', () => {
    const f = pick.files?.[0];
    if (!f) return;
    if (picked) URL.revokeObjectURL(picked);
    picked = URL.createObjectURL(f);
    view(el, result);
  });
  const help = document.createElement('div');
  help.className = 'k-help';
  help.textContent = 'Preview your logo here (not uploaded; the script above makes the real files).';
  block.append(title, svg, help, pick);
  el.append(block);
}
