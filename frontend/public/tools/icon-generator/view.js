// Icon & Favicon Generator, custom page: the icon board.
//
//   Canvas  - one file of the set drawn large: its square at full size, the
//             background (or a checkerboard when it stays transparent), the
//             logo box at the size run() gives for that file, and the safe
//             zone and mask of its platform (maskable 80 % circle, Android 72
//             dp window and 66 dp circle, Apple margin, iOS squircle). "As
//             launched" clips it the way the launcher does. Shape buttons,
//             the background swatch and a drop zone for a logo sit on it; a
//             dropped or loaded logo fills in the source name and width and
//             is shown everywhere (it stays in the browser).
//   Ladder  - every file of every platform drawn to scale against each other,
//             grouped under a switch per platform; click one to put it on the
//             canvas.
//   In use  - a home screen (Android adaptive, iOS) with the short name as
//             the launcher cuts it, and a browser tab with the favicon, the
//             app name and the theme colour in the toolbar; click them to edit.
// File sizes, logo sizes and backgrounds come from run()'s result.files, the
// file purposes from its table, the safe fractions from result.safe.

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

const SHAPES = [['square', 'Square'], ['circle', 'Round'], ['wide', 'Wide 2:1'], ['tall', 'Tall 1:2']];
const PLATFORMS = [['web', 'Web and PWA', 'Web'], ['android', 'Android app', 'Android'], ['ios', 'iOS app', 'iOS']];
const hexOk = (c) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c || '').trim());
const long6 = (c) => { const s = String(c).trim(); return s.length === 4 ? '#' + [...s.slice(1)].map((x) => x + x).join('') : s.slice(0, 7); };
const base = (f) => f.split('/').pop();
let seq = 0;

/** The squircle Apple uses for app icons, as a path in a box (x, y, size). */
function squircle(x, y, s) {
  // a superellipse, n = 5, close to the iOS mask
  const pts = [];
  for (let i = 0; i < 72; i++) {
    const t = (i / 72) * Math.PI * 2, c = Math.cos(t), si = Math.sin(t);
    const px = Math.sign(c) * Math.abs(c) ** (2 / 5), py = Math.sign(si) * Math.abs(si) ** (2 / 5);
    pts.push(`${(x + s / 2 + (px * s) / 2).toFixed(2)},${(y + s / 2 + (py * s) / 2).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

/** The kind of file: which safe zone and mask belong to it. */
function kindOf(f) {
  const n = f.file;
  if (n === 'icon-mask.png') return 'maskable';
  if (n.includes('ic_launcher_foreground')) return 'adaptive';
  if (n.includes('/ic_launcher.png')) return 'legacy';
  if (n === 'apple-touch-icon.png') return 'apple';
  if (n.startsWith('AppIcon')) return 'ios';
  if (n === 'play-store-512.png') return 'play';
  if (n === 'favicon.ico') return 'favicon';
  return 'any';
}

export function page(root, ctx) {
  const uid = `ig${++seq}`;
  const st = { sel: null, crop: false, img: null, imgName: null };
  let res = null;

  // ---------------------------------------------------------------- source strip
  const fileIn = h('input', { type: 'file', accept: 'image/svg+xml,image/png,image/webp,image/jpeg', class: 'ig-hide', 'aria-label': 'Load a logo',
    onchange: (e) => { const f = e.target.files?.[0]; if (f) loadImage(f); e.target.value = ''; } });
  const loadBtn = h('button', { class: 'k-btn ig-load', onclick: () => fileIn.click() }, 'Load a logo…');
  const srcIn = h('input', { type: 'text', class: 'ig-src', spellcheck: 'false', 'aria-label': 'Source file name', oninput: (e) => ctx.set('source', e.target.value) });
  const sizeIn = h('input', { type: 'text', class: 'ig-num', inputmode: 'numeric', spellcheck: 'false', 'aria-label': 'Source width in px', oninput: (e) => ctx.set('sourceSize', e.target.value) });
  const srcNote = h('span', { class: 'ig-soft ig-small' });
  const srcBar = h('div', { class: 'ig-row ig-srcbar' }, h('span', { class: 'ig-h' }, 'Source'), srcIn,
    h('label', { class: 'ig-soft ig-small ig-inl' }, 'width ', sizeIn, ' px'), loadBtn, fileIn, srcNote);

  // ---------------------------------------------------------------- canvas
  const shapeBtns = SHAPES.map(([v, t]) => {
    const g = sv('svg', { viewBox: '0 0 20 20', width: 20, height: 20, 'aria-hidden': 'true' });
    if (v === 'circle') g.append(sv('circle', { cx: 10, cy: 10, r: 7 }));
    else if (v === 'wide') g.append(sv('rect', { x: 2, y: 6, width: 16, height: 8, rx: 1.5 }));
    else if (v === 'tall') g.append(sv('rect', { x: 6, y: 2, width: 8, height: 16, rx: 1.5 }));
    else g.append(sv('rect', { x: 3, y: 3, width: 14, height: 14, rx: 1.5 }));
    return h('button', { class: 'ig-shape', 'data-v': v, 'aria-pressed': 'false', title: `Logo shape: ${t}`, 'aria-label': `Logo shape ${t}`, onclick: () => ctx.set('shape', v) }, g);
  });
  const bgPick = h('input', { type: 'color', class: 'ig-color', 'aria-label': 'Background colour', oninput: (e) => ctx.set('background', e.target.value) });
  const bgText = h('input', { type: 'text', class: 'ig-hex', spellcheck: 'false', 'aria-label': 'Background colour, hex', oninput: (e) => ctx.set('background', e.target.value) });
  const cropCb = h('input', { type: 'checkbox', onchange: (e) => { st.crop = e.target.checked; drawCanvas(); } });
  const canvasTitle = h('div', { class: 'ig-ctitle' });
  const canvasSub = h('div', { class: 'ig-soft ig-small ig-csub' });
  const stage = h('div', { class: 'ig-stage', tabindex: '-1' });
  const dropHint = h('div', { class: 'ig-drop', 'aria-hidden': 'true' }, 'Drop the logo here');
  const zoneKey = h('div', { class: 'ig-zkey' });
  const canvasPanel = h('section', { class: 'ig-panel ig-canvas' },
    h('div', { class: 'ig-row' }, canvasTitle, h('span', { class: 'ig-grow' }),
      h('span', { class: 'ig-shapes', role: 'group', 'aria-label': 'Logo shape' }, shapeBtns)),
    canvasSub, h('div', { class: 'ig-stagewrap' }, stage, dropHint),
    h('div', { class: 'ig-row ig-under' },
      h('label', { class: 'ig-swatch', title: 'Background of the opaque icons' }, bgPick, h('span', {}, 'Background'), bgText),
      h('label', { class: 'ig-cb' }, cropCb, ' As launched (mask applied)'), h('span', { class: 'ig-grow' }), zoneKey),
    srcBar);

  // ---------------------------------------------------------------- ladder
  const ladder = h('div', { class: 'ig-ladder' });
  const ladderPanel = h('section', { class: 'ig-panel ig-ladpanel' },
    h('div', { class: 'ig-row' }, h('span', { class: 'ig-h' }, 'Every file, to scale'), h('span', { class: 'ig-soft ig-small ig-filecount' })), ladder);

  // ---------------------------------------------------------------- in use
  const nameIn = h('input', { type: 'text', class: 'ig-namein', spellcheck: 'false', 'aria-label': 'App name', oninput: (e) => ctx.set('name', e.target.value) });
  const shortIn = h('input', { type: 'text', class: 'ig-namein', spellcheck: 'false', 'aria-label': 'Short name', oninput: (e) => ctx.set('shortName', e.target.value) });
  const shortCount = h('span', { class: 'ig-small ig-soft' });
  const themePick = h('input', { type: 'color', class: 'ig-color', 'aria-label': 'Theme colour', oninput: (e) => ctx.set('theme', e.target.value) });
  const themeText = h('input', { type: 'text', class: 'ig-hex', spellcheck: 'false', 'aria-label': 'Theme colour, hex', oninput: (e) => ctx.set('theme', e.target.value) });
  const phone = h('div', { class: 'ig-phone' });
  const browser = h('div', { class: 'ig-browser' });
  const usePanel = h('section', { class: 'ig-panel ig-use' },
    h('div', { class: 'ig-row' }, h('span', { class: 'ig-h' }, 'In use')),
    h('div', { class: 'ig-usegrid' },
      h('div', { class: 'ig-usecol' }, browser,
        h('div', { class: 'ig-row ig-fields' }, h('label', { class: 'ig-lab' }, 'App name', nameIn),
          h('label', { class: 'ig-swatch', title: 'theme-color: the browser toolbar on Android' }, themePick, h('span', {}, 'Theme'), themeText))),
      h('div', { class: 'ig-usecol' }, phone,
        h('div', { class: 'ig-row ig-fields' }, h('label', { class: 'ig-lab' }, 'Short name', shortIn, shortCount)))));

  const prefixIn = h('input', { type: 'text', class: 'ig-src', spellcheck: 'false', 'aria-label': 'URL path of the icons', oninput: (e) => ctx.set('prefix', e.target.value) });
  const warns = h('div', { class: 'ig-warns', 'aria-live': 'polite' });
  const outs = h('div', { class: 'ig-out' },
    h('div', { class: 'ig-row' }, h('span', { class: 'ig-h' }, 'Files and code'), h('label', { class: 'ig-soft ig-small ig-inl' }, 'icons served from ', prefixIn),
      h('span', { class: 'ig-soft ig-small' }, 'the ImageMagick script makes every file above from your source')),
    ctx.outputs);
  root.append(h('div', { class: 'ig-page' }, canvasPanel, h('div', { class: 'ig-rightcol' }, warns, ladderPanel, usePanel), outs));

  // ---------------------------------------------------------------- logo loading
  function loadImage(file) {
    if (st.img) URL.revokeObjectURL(st.img);
    st.img = URL.createObjectURL(file);
    st.imgName = file.name;
    const isSvg = /svg/.test(file.type) || /\.svg$/i.test(file.name);
    const done = (w) => ctx.setMany({ source: file.name, ...(w ? { sourceSize: String(Math.round(w)) } : {}) });
    if (isSvg) {
      file.text().then((t) => {
        const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)/i.exec(t);
        const w = /<svg[^>]*\swidth\s*=\s*["']([\d.]+)/i.exec(t);
        done(vb ? Number(vb[1]) : w ? Number(w[1]) : null);
      }).catch(() => done(null));
    } else {
      const im = new Image();
      im.onload = () => done(im.naturalWidth);
      im.onerror = () => done(null);
      im.src = st.img;
    }
  }
  const stageWrap = canvasPanel.querySelector('.ig-stagewrap');
  stageWrap.addEventListener('dragover', (e) => { e.preventDefault(); stageWrap.classList.add('is-drag'); });
  stageWrap.addEventListener('dragleave', () => stageWrap.classList.remove('is-drag'));
  stageWrap.addEventListener('drop', (e) => {
    e.preventDefault(); stageWrap.classList.remove('is-drag');
    const f = [...(e.dataTransfer?.files || [])].find((x) => /^image\//.test(x.type));
    if (f) loadImage(f);
  });

  // ---------------------------------------------------------------- the logo, anywhere
  /** The logo (the loaded image or a stand-in mark) in the box x, y, w, h. */
  function logo(parent, x, y, w, hgt, shape, pixel) {
    if (st.img) {
      parent.append(sv('image', { href: st.img, x, y, width: w, height: hgt, preserveAspectRatio: 'xMidYMid meet', style: pixel ? 'image-rendering:pixelated' : null }));
      return;
    }
    const g = sv('g', { class: 'ig-mark' });
    if (shape === 'circle') g.append(sv('circle', { cx: x + w / 2, cy: y + hgt / 2, r: Math.min(w, hgt) / 2, class: 'ig-markbg' }));
    else g.append(sv('rect', { x, y, width: w, height: hgt, rx: Math.min(w, hgt) * 0.16, class: 'ig-markbg' }));
    // a stand-in glyph: a chevron and a bar, so the crop and the padding read
    const s = Math.min(w, hgt), cx = x + w / 2, cy = y + hgt / 2;
    g.append(sv('path', { class: 'ig-markfg', d: `M${cx - s * 0.26},${cy - s * 0.22} L${cx + 0.02 * s},${cy} L${cx - s * 0.26},${cy + s * 0.22}`, 'stroke-width': Math.max(1, s * 0.1) }));
    g.append(sv('path', { class: 'ig-markfg', d: `M${cx + s * 0.06},${cy + s * 0.22} L${cx + s * 0.28},${cy + s * 0.22}`, 'stroke-width': Math.max(1, s * 0.1) }));
    parent.append(g);
  }
  /** One icon file as it would come out: background, logo box, optional mask. */
  function iconSvg(f, size, { mask = null, pixel = false } = {}) {
    const safe = res.safe;
    const s = sv('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'ig-icon', 'aria-hidden': 'true' });
    const id = `${uid}m${Math.random().toString(36).slice(2, 8)}`;
    let clip = null;
    if (mask) {
      const cp = sv('clipPath', { id });
      if (mask === 'circle') cp.append(sv('circle', { cx: size / 2, cy: size / 2, r: size / 2 }));
      else if (mask === 'adaptive') cp.append(sv('circle', { cx: size / 2, cy: size / 2, r: (size * 72) / 108 / 2 }));
      else if (mask === 'squircle') cp.append(sv('path', { d: squircle(0, 0, size) }));
      else if (mask === 'rounded') cp.append(sv('rect', { width: size, height: size, rx: size * 0.2 }));
      const defs = sv('defs'); defs.append(cp); s.append(defs);
      clip = `url(#${id})`;
    }
    const g = sv('g', { 'clip-path': clip });
    const bg = f.background !== 'none' ? f.background : mask === 'adaptive' ? safe.background : null;
    if (bg) g.append(sv('rect', { width: size, height: size, fill: bg }));
    const k = size / (f.px || 512);
    const lw = (f.logoW ?? f.px) * k, lh = (f.logoH ?? f.px) * k;
    logo(g, (size - lw) / 2, (size - lh) / 2, lw, lh, safe.shape, pixel);
    s.append(g);
    return s;
  }

  // ---------------------------------------------------------------- canvas drawing
  function drawCanvas() {
    stage.replaceChildren();
    zoneKey.replaceChildren();
    if (!res?.files) { canvasTitle.textContent = 'No files'; canvasSub.textContent = 'Switch on a platform at the right.'; return; }
    const pref = ['icon-mask.png', 'mipmap-xxxhdpi/ic_launcher_foreground.png', 'AppIcon.appiconset/icon-1024.png'];
    const f = res.files.find((x) => x.file === st.sel) || pref.map((p) => res.files.find((x) => x.file === p)).find(Boolean) || res.files[0];
    st.sel = f.file;
    const kind = kindOf(f);
    const row = res.tables?.[0]?.rows?.find((r) => r[0] === f.file);
    canvasTitle.replaceChildren(h('span', { class: 'ig-fname' }, f.file), h('span', { class: 'ig-soft' }, f.px ? `  ${f.px} × ${f.px} px` : '  vector'));
    canvasSub.textContent = row ? row[5] : '';
    const S = Math.max(240, Math.min(470, Math.floor((stage.clientWidth || 440) - 20)));
    const M = 40; // room for dimensions
    const W = S + M * 2 - 10, H = S + M + 34;
    const x0 = M - 6, y0 = 14;
    const svg = sv('svg', { class: 'ig-board', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
      'aria-label': `${f.file}: logo ${f.logoW ?? ''} by ${f.logoH ?? ''} px in a ${f.px ?? ''} px square` });
    const defs = sv('defs');
    const pat = sv('pattern', { id: `${uid}chk`, width: 16, height: 16, patternUnits: 'userSpaceOnUse', x: x0, y: y0 });
    pat.append(sv('rect', { width: 16, height: 16, class: 'ig-chk0' }), sv('rect', { width: 8, height: 8, class: 'ig-chk1' }), sv('rect', { x: 8, y: 8, width: 8, height: 8, class: 'ig-chk1' }));
    defs.append(pat);
    // the launcher's mask, when "as launched"
    const maskKind = { maskable: 'circle', adaptive: 'adaptive', apple: 'squircle', ios: 'squircle', play: 'rounded' }[kind];
    if (maskKind) {
      const cp = sv('clipPath', { id: `${uid}crop` });
      if (maskKind === 'circle') cp.append(sv('circle', { cx: x0 + S / 2, cy: y0 + S / 2, r: S / 2 }));
      else if (maskKind === 'adaptive') cp.append(sv('circle', { cx: x0 + S / 2, cy: y0 + S / 2, r: (S * 72) / 108 / 2 }));
      else if (maskKind === 'squircle') cp.append(sv('path', { d: squircle(x0, y0, S) }));
      else cp.append(sv('rect', { x: x0, y: y0, width: S, height: S, rx: S * 0.2 }));
      defs.append(cp);
    }
    svg.append(defs);
    svg.append(sv('rect', { x: x0, y: y0, width: S, height: S, fill: `url(#${uid}chk)`, class: 'ig-frame' }));
    const art = sv('g', { 'clip-path': st.crop && maskKind ? `url(#${uid}crop)` : null });
    if (f.background !== 'none') art.append(sv('rect', { x: x0, y: y0, width: S, height: S, fill: f.background }));
    else if (kind === 'adaptive' && st.crop) art.append(sv('rect', { x: x0, y: y0, width: S, height: S, fill: res.safe.background }));
    const k = S / (f.px || 512);
    const lw = (f.logoW ?? f.px ?? 512) * k, lh = (f.logoH ?? f.px ?? 512) * k;
    const lx = x0 + (S - lw) / 2, ly = y0 + (S - lh) / 2;
    logo(art, lx, ly, lw, lh, res.safe.shape, false);
    svg.append(art);
    if (st.crop && maskKind) {
      // the cut-away part, faint
      const ghost = sv('g', { class: 'ig-ghost' });
      if (f.background !== 'none') ghost.append(sv('rect', { x: x0, y: y0, width: S, height: S, fill: f.background }));
      logo(ghost, lx, ly, lw, lh, res.safe.shape, false);
      svg.insertBefore(ghost, art);
    }
    // safe zones
    const z = sv('g', { class: 'ig-zones' });
    const key = [];
    const cx = x0 + S / 2, cy = y0 + S / 2;
    if (kind === 'maskable') {
      z.append(sv('circle', { class: 'ig-safe', cx, cy, r: S * 0.4 }));
      z.append(sv('circle', { class: 'ig-mask', cx, cy, r: S / 2 }));
      key.push(['safe', 'safe circle, 80 %'], ['mask', 'circle crop (strictest launcher mask)']);
    } else if (kind === 'adaptive') {
      z.append(sv('circle', { class: 'ig-mask', cx, cy, r: (S * 72) / 108 / 2 }));
      z.append(sv('rect', { class: 'ig-mask ig-thin', x: cx - (S * 72) / 108 / 2, y: cy - (S * 72) / 108 / 2, width: (S * 72) / 108, height: (S * 72) / 108 }));
      z.append(sv('circle', { class: 'ig-safe', cx, cy, r: (S * 66) / 108 / 2 }));
      key.push(['safe', '66 dp safe circle'], ['mask', '72 dp visible (circle or square, by launcher)'], ['soft', 'the rest: parallax and motion only']);
    } else if (kind === 'apple') {
      z.append(sv('path', { class: 'ig-mask', d: squircle(x0, y0, S) }));
      z.append(sv('rect', { class: 'ig-safe', x: x0 + (S * 20) / 180, y: y0 + (S * 20) / 180, width: (S * 140) / 180, height: (S * 140) / 180 }));
      key.push(['safe', '20 px margin (of 180)'], ['mask', 'iOS rounds the corners']);
    } else if (kind === 'ios') {
      z.append(sv('path', { class: 'ig-mask', d: squircle(x0, y0, S) }));
      key.push(['mask', 'iOS squircle mask; no transparency']);
    } else if (kind === 'legacy' || kind === 'play') {
      z.append(sv('rect', { class: 'ig-safe', x: x0 + S * 0.1, y: y0 + S * 0.1, width: S * 0.8, height: S * 0.8 }));
      if (kind === 'play') { z.append(sv('rect', { class: 'ig-mask', x: x0, y: y0, width: S, height: S, rx: S * 0.2 })); key.push(['mask', 'Play rounds it (20 %)']); }
      key.push(['safe', 'logo in the centre 80 %']);
    } else if (kind === 'favicon') {
      for (let i = 1; i < 32; i++) {
        const t = (S * i) / 32;
        z.append(sv('line', { class: 'ig-px', x1: x0 + t, x2: x0 + t, y1: y0, y2: y0 + S }), sv('line', { class: 'ig-px', x1: x0, x2: x0 + S, y1: y0 + t, y2: y0 + t }));
      }
      key.push(['soft', 'the 32 px grid: thin strokes vanish at 16 px']);
    } else key.push(['soft', 'full square, transparent']);
    svg.append(z);
    // dimensions: the logo box, from run()
    const dim = sv('g', { class: 'ig-dim' });
    const by = y0 + S + 18;
    if (f.logoW != null) {
      dim.append(sv('line', { x1: lx, x2: lx, y1: y0 + S + 4, y2: by + 4 }), sv('line', { x1: lx + lw, x2: lx + lw, y1: y0 + S + 4, y2: by + 4 }),
        sv('line', { class: 'ig-dimline', x1: lx, x2: lx + lw, y1: by, y2: by }));
      dim.append(sv('text', { x: lx + lw / 2, y: by + 14, 'text-anchor': 'middle', class: 'ig-dimtxt' }, `logo ${f.logoW} px`));
      const rx = x0 + S + 16;
      dim.append(sv('line', { x1: x0 + S + 4, x2: rx + 4, y1: ly, y2: ly }), sv('line', { x1: x0 + S + 4, x2: rx + 4, y1: ly + lh, y2: ly + lh }),
        sv('line', { class: 'ig-dimline', x1: rx, x2: rx, y1: ly, y2: ly + lh }));
      dim.append(sv('text', { x: rx + 6, y: ly + lh / 2, class: 'ig-dimtxt', transform: `rotate(90 ${rx + 6} ${ly + lh / 2})`, 'text-anchor': 'middle' }, `${f.logoH} px`));
    }
    if (f.px) {
      const lx2 = x0 - 16;
      dim.append(sv('line', { class: 'ig-dimline ig-dimsoft', x1: lx2, x2: lx2, y1: y0, y2: y0 + S }));
      dim.append(sv('text', { x: lx2 - 6, y: y0 + S / 2, class: 'ig-dimtxt ig-dimsoft', transform: `rotate(-90 ${lx2 - 6} ${y0 + S / 2})`, 'text-anchor': 'middle' }, `${f.px} px`));
    }
    svg.append(dim);
    stage.append(svg);
    for (const [c, t] of key) zoneKey.append(h('span', {}, h('i', { class: `ig-k-${c}` }), t));
  }

  // ---------------------------------------------------------------- ladder
  function drawLadder() {
    ladder.replaceChildren();
    const raw = ctx.raw;
    const files = res?.files || [];
    ladder.parentElement.querySelector('.ig-filecount').textContent = files.length ? `${files.length} files` : '';
    const rows = res?.tables?.[0]?.rows || [];
    for (const [key, label, plat] of PLATFORMS) {
      const on = !!ctx.input[key];
      const sw = h('button', { class: 'ig-switch', role: 'switch', 'aria-checked': String(on), 'aria-label': label, onclick: () => ctx.set(key, !on) }, h('i'));
      const head = h('div', { class: 'ig-lhead' }, sw, h('span', { class: 'ig-lname' }, label));
      if (key === 'ios' && on) {
        head.append(h('span', { class: 'ig-segs', role: 'group', 'aria-label': 'iOS icon set' },
          [['single', 'One 1024 px'], ['full', 'Every size']].map(([v, t]) => h('button', { class: 'ig-seg', 'aria-pressed': String((raw.iosSet || 'single') === v), onclick: () => ctx.set('iosSet', v) }, t))));
      }
      const group = h('div', { class: `ig-lgroup${on ? '' : ' is-off'}` }, head);
      const mine = files.filter((f) => f.platform === plat);
      if (on && mine.length) {
        const max = Math.max(...mine.map((f) => f.px || 64));
        const k = Math.min(1, 132 / max);
        const tiles = h('div', { class: 'ig-tiles' });
        for (const f of mine) {
          const size = Math.max(10, Math.round((f.px || 64) * k));
          const kind = kindOf(f);
          const r = rows.find((x) => x[0] === f.file);
          const tile = h('button', { class: `ig-tile${f.file === st.sel ? ' is-sel' : ''}`, title: `${f.file}\n${r ? r[5] : ''}`,
            'aria-pressed': String(f.file === st.sel), onclick: () => { st.sel = f.file; drawCanvas(); drawLadderSel(); } },
          h('span', { class: 'ig-tileart', style: `width:${size}px;height:${size}px` }, f.px ? iconSvg(f, size, { pixel: size < 24 }) : h('span', { class: 'ig-vec' }, 'SVG')),
          h('span', { class: 'ig-tpx' }, f.px ? `${f.px}` : 'any'),
          h('span', { class: 'ig-tname' }, kind === 'adaptive' ? `fg ${f.file.split('/')[0].replace('mipmap-', '')}` : kind === 'legacy' ? f.file.split('/')[0].replace('mipmap-', '') : base(f.file).replace('.png', '')));
          tiles.append(tile);
        }
        group.append(tiles);
      } else if (!on) group.append(h('div', { class: 'ig-soft ig-small ig-offnote' }, 'off'));
      ladder.append(group);
    }
  }
  function drawLadderSel() {
    for (const t of ladder.querySelectorAll('.ig-tile')) {
      const sel = t.title.startsWith(st.sel + '\n');
      t.classList.toggle('is-sel', sel); t.setAttribute('aria-pressed', String(sel));
    }
  }

  // ---------------------------------------------------------------- in use
  function drawUse() {
    phone.replaceChildren(); browser.replaceChildren();
    const raw = ctx.raw, safe = res?.safe, files = res?.files || [];
    const short = String(raw.shortName || raw.name || 'App');
    const cut = short.length > 12 ? short.slice(0, 11) + '…' : short;
    shortCount.textContent = `${short.length}/12`;
    shortCount.className = `ig-small ${short.length > 12 ? 'ig-warntext' : 'ig-soft'}`;
    // browser tab and toolbar
    const fav = files.find((f) => f.file === 'favicon.ico');
    const th = safe?.theme || '#ffffff';
    const tab = h('div', { class: 'ig-tab' }, h('span', { class: 'ig-fav' }, fav && safe ? iconSvg(fav, 16, { pixel: true }) : h('i', { class: 'ig-nofav' })),
      h('span', { class: 'ig-tabtitle' }, String(raw.name || 'My App')), h('span', { class: 'ig-soft' }, '×'));
    const toolbar = h('button', { class: 'ig-toolbar', style: `background:${th}`, title: 'theme-color: click to change', onclick: () => themePick.click() },
      h('span', { class: 'ig-url' }, `example.com${String(raw.prefix || '/')}`));
    browser.append(h('div', { class: 'ig-tabs' }, tab, h('span', { class: 'ig-tabsfill' })), toolbar,
      h('div', { class: 'ig-soft ig-small ig-cap' }, fav ? 'Favicon at 16 px, the Android toolbar in the theme colour' : 'Web is off: no favicon'));
    // home screen
    const screen = h('div', { class: 'ig-screen' });
    const add = (f, mask, label) => {
      if (!f || !safe) return;
      screen.append(h('button', { class: 'ig-app', title: `${label}: click to open ${f.file} on the canvas`, onclick: () => { st.sel = f.file; drawCanvas(); drawLadderSel(); } },
        h('span', { class: 'ig-appicon' }, iconSvg(f, 56, { mask })), h('span', { class: 'ig-applab' }, cut), h('span', { class: 'ig-appos' }, label)));
    };
    add(files.find((f) => f.file === 'icon-mask.png'), 'circle', 'PWA, maskable');
    add(files.find((f) => f.file.includes('xxxhdpi/ic_launcher_foreground')), 'adaptive', 'Android');
    const iosF = files.filter((f) => f.file.startsWith('AppIcon')).sort((a, b) => b.px - a.px)[0];
    if (iosF) add(iosF, 'squircle', 'iOS');
    else add(files.find((f) => f.file === 'apple-touch-icon.png'), 'squircle', 'iOS, web clip');
    if (!screen.childElementCount) screen.append(h('span', { class: 'ig-soft ig-small' }, 'No home-screen icon in this set.'));
    phone.append(screen, h('div', { class: 'ig-soft ig-small ig-cap' }, short.length > 12 ? `Launchers cut "${short}" after about 12 characters.` : 'Home screen, with the short name'));
  }

  // ---------------------------------------------------------------- result in
  const sync = (el, v) => { if (document.activeElement !== el && el.value !== v) el.value = v; };
  ctx.onResult((r) => {
    res = r;
    const raw = ctx.raw;
    for (const b of shapeBtns) b.setAttribute('aria-pressed', String(b.dataset.v === (r.safe?.shape || raw.shape)));
    sync(srcIn, String(raw.source ?? '')); sync(sizeIn, String(raw.sourceSize ?? ''));
    sync(bgText, String(raw.background ?? '')); sync(themeText, String(raw.theme ?? ''));
    sync(nameIn, String(raw.name ?? '')); sync(shortIn, String(raw.shortName ?? '')); sync(prefixIn, String(raw.prefix ?? ''));
    if (r.safe) { bgPick.value = long6(hexOk(r.safe.background) ? r.safe.background : '#ffffff'); themePick.value = long6(hexOk(r.safe.theme) ? r.safe.theme : '#ffffff'); }
    srcNote.textContent = st.img ? `previewing ${st.imgName} (stays in this browser)` : 'no logo loaded: a stand-in mark is drawn';
    const w = r.warnings || [];
    warns.replaceChildren(...w.map((x) => h('div', {}, x)));
    const big = (r.values || []).find((v) => v.label === 'Largest icon');
    sizeIn.classList.toggle('is-bad', big?.tone === 'bad');
    drawCanvas(); drawLadder(); drawUse();
  });

  let rt = 0, lastW = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(rt);
    rt = requestAnimationFrame(() => { const wd = stage.clientWidth; if (Math.abs(wd - lastW) > 3) { lastW = wd; if (res) drawCanvas(); } });
  }).observe(stage);
}
