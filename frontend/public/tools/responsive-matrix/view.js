// The page in one iframe per breakpoint, each at its real CSS width and scaled
// down to fit. For same-origin pages each frame is measured after it loads
// (document wider than the viewport = overflow, and the outermost elements that
// stick out); the report goes into the Report input with api.set so run() and
// the Prompt/JSON see it. Frames are kept between redraws: moving an iframe in
// the DOM would reload it.

const S = { key: '', root: null, frames: [], results: new Map(), api: null };

const $ = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};

const sel = (e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;

function measure(frame, w) {
  let doc;
  try { doc = frame.contentDocument; if (!doc || !doc.documentElement) throw new Error('no document'); } catch {
    return { status: 'blocked', line: `${w} blocked cross-origin` };
  }
  const de = doc.documentElement;
  const cw = de.clientWidth, sw = de.scrollWidth;
  if (sw <= cw + 1) return { status: 'ok', line: `${w} ok sw=${sw}` };
  const lim = cw + 0.5;
  const out = [...doc.querySelectorAll('body *')].filter((e) => {
    const r = e.getBoundingClientRect();
    if (!(r.right > lim) || r.width === 0) return false;
    const p = e.parentElement;
    return !p || p === doc.body || p.getBoundingClientRect().right <= lim;
  }).slice(0, 4).map((e) => `${sel(e)}(${Math.round(e.getBoundingClientRect().right)})`);
  return { status: 'overflow', line: `${w} overflow sw=${sw} ${out.join(' ')}`.trim() };
}

function report() {
  const text = S.frames.map((f) => S.results.get(f.w)?.line).filter(Boolean).join('\n');
  if (S.frames.every((f) => S.results.has(f.w)) && text !== String(S.api?.raw.report || '')) S.api?.set('report', text);
}

export function view(el, result, input, api) {
  S.api = api;
  const bps = result?.breakpoints || [];
  const url = String(input.url || '').trim();
  const served = /^https?:/.test(location.protocol);
  if (!served || !bps.length || !url) {
    S.key = ''; S.root = null; S.frames = [];
    el.replaceChildren(!served ? $('div', { class: 'k-block' }, $('div', { class: 'k-title' }, 'Preview'),
      $('div', { style: 'font-size:12px;color:var(--ink-soft)' }, 'Open this tool in the app to see the page at every breakpoint and measure overflow. The table and the Playwright script work here too.')) : '');
    return;
  }
  const avail = Math.max(260, (el.clientWidth || el.parentElement?.clientWidth || 800) - 24);
  const maxW = Math.max(...bps.map((b) => b.width));
  const fixed = Number(input.scale);
  const scale = fixed > 0 ? fixed : Math.round(100 * Math.min(0.35, Math.max(0.12, avail / maxW))) / 100;
  const key = JSON.stringify([url, bps, scale]);
  if (key !== S.key) {
    S.key = key; S.results = new Map();
    const src = url;
    const grid = $('div', { style: 'display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start' });
    S.frames = bps.map((b) => {
      const badge = $('span', { style: 'font-size:10.5px;padding:0 5px;border-radius:3px;border:1px solid var(--line);color:var(--ink-soft)' }, 'loading');
      const frame = $('iframe', { src, title: `${b.name} ${b.width}px`, loading: 'eager', tabindex: '-1',
        style: `width:${b.width}px;height:${b.height}px;border:0;transform:scale(${scale});transform-origin:0 0;background:#fff;pointer-events:none` });
      const box = $('div', { style: `width:${Math.round(b.width * scale)}px;height:${Math.round(b.height * scale)}px;overflow:hidden;border:1px solid var(--line);border-radius:4px;background:var(--sunken)` }, frame);
      const cell = $('div', { style: 'display:flex;flex-direction:column;gap:4px;min-width:0;max-width:100%' },
        $('div', { style: 'display:flex;gap:6px;align-items:center;font-size:11px;color:var(--ink-soft)' }, $('b', { style: 'color:var(--ink);font-weight:500' }, b.name), `${b.width}×${b.height}`, badge),
        box);
      const f = { w: b.width, frame, badge };
      frame.addEventListener('load', () => {
        // Let late layout (fonts, images, scripts) settle before measuring.
        setTimeout(() => {
          const r = measure(frame, b.width);
          S.results.set(b.width, r);
          badge.textContent = r.status === 'ok' ? 'fits' : r.status === 'overflow' ? `overflow +${(Number((/sw=(\d+)/.exec(r.line) || [])[1]) || b.width) - b.width}px` : 'not inspectable';
          badge.style.color = `var(${r.status === 'ok' ? '--ok' : r.status === 'overflow' ? '--danger' : '--warn'})`;
          badge.style.borderColor = badge.style.color;
          report();
        }, 700);
      });
      grid.append(cell);
      return f;
    });
    S.root = $('div', { class: 'k-block', style: 'overflow:hidden' },
      $('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap' },
        $('div', { class: 'k-title', style: 'margin:0' }, `Preview at ${Math.round(scale * 100)} %`),
        $('button', { class: 'k-btn', style: 'margin-left:auto', onclick: () => { for (const f of S.frames) { f.badge.textContent = 'loading'; S.results.delete(f.w); try { f.frame.contentWindow.location.reload(); } catch { f.frame.src = f.frame.src; } } } }, 'Reload frames')),
      grid);
  }
  if (el.firstChild !== S.root) el.replaceChildren(S.root);
}
