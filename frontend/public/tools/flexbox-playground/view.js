// Flexbox Playground page: the flex container is the interface. It is drawn
// to scale with its items where run() places them, the leftover space hatched
// and measured, the gaps banded. Drag the container's edges to resize it, an
// item's far edge to change its size along the main axis, its cross edge to
// change the other size, a gap band to change the gap; pick the container
// properties from pictures of what they do. Every position and number drawn
// comes from tool.js run() (result.drawing and the layout table).

const SVGNS = 'http://www.w3.org/2000/svg';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const el = (tag, attrs = {}, html) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  if (html != null) e.innerHTML = html;
  return e;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r0 = (v) => Math.round(v);
const fmt = (v) => String(Math.round(v * 10) / 10);
const SER = ['s0', 's1', 's2', 's3'];

// ---------------- pictograms (28 x 28, drawn for a row; CSS turns them for a column) ----------------
const bar = (x, y, w, h, cls = 'pb') => `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="1"/>`;
function icoJustify(m) {
  const w = 4, n = 3, L = 4, R = 24, span = R - L, used = n * w, free = span - used;
  let x0 = L, ex = 1;
  if (m === 'flex-end') x0 = L + free - 2 * ex;
  else if (m === 'center') x0 = L + (free - 2 * ex) / 2;
  else if (m === 'space-between') ex = free / 2;
  else if (m === 'space-around') { ex = free / 3; x0 = L + ex / 2; }
  else if (m === 'space-evenly') { ex = free / 4; x0 = L + ex; }
  let h = '<line class="pf" x1="3" y1="7" x2="3" y2="21"/><line class="pf" x1="25" y1="7" x2="25" y2="21"/>';
  for (let i = 0; i < n; i++) h += bar(x0 + i * (w + ex), 9, w, 10);
  return h;
}
function icoAlign(m) {
  const hs = [8, 14, 10];
  let h = '<line class="pf" x1="4" y1="4" x2="24" y2="4"/><line class="pf" x1="4" y1="24" x2="24" y2="24"/>';
  hs.forEach((hh, i) => {
    const H = m === 'stretch' ? 18 : hh;
    const y = m === 'flex-end' ? 23 - H : m === 'center' ? 14 - H / 2 : 5;
    h += bar(6 + i * 6, y, 4, H);
  });
  return h;
}
function icoContent(m) {
  const rows = 2, rh = 4, T = 4, B = 24, free = B - T - rows * rh;
  let y0 = T, ex = 1, H = rh;
  if (m === 'flex-end') y0 = B - rows * rh - ex;
  else if (m === 'center') y0 = T + (free - ex) / 2;
  else if (m === 'space-between') ex = free;
  else if (m === 'space-around') { ex = free / 2; y0 = T + ex / 2; }
  else if (m === 'space-evenly') { ex = free / 3; y0 = T + ex; }
  else if (m === 'stretch' || m === 'normal') { H = (B - T - 1) / 2; }
  let h = '<line class="pf" x1="4" y1="3" x2="24" y2="3"/><line class="pf" x1="4" y1="25" x2="24" y2="25"/>';
  for (let r = 0; r < rows; r++) for (let c = 0; c < 3; c++) h += bar(5 + c * 6.5, y0 + r * (H + ex), 5, H);
  return h;
}
function icoDir(m) {
  const arr = { row: 'M5 14h16m-4-4 4 4-4 4', 'row-reverse': 'M23 14H7m4-4-4 4 4 4', column: 'M14 5v16m-4-4 4 4 4-4', 'column-reverse': 'M14 23V7m-4 4 4-4 4 4' }[m];
  return `<path class="pa" d="${arr}"/>`;
}
function icoWrap(m) {
  if (m === 'nowrap') return `<line class="pf" x1="3" y1="6" x2="3" y2="22"/><line class="pf" x1="25" y1="6" x2="25" y2="22"/>${bar(4, 10, 5, 8)}${bar(10, 10, 5, 8)}${bar(16, 10, 5, 8)}${bar(22, 10, 5, 8, 'pb over')}`;
  const top = m === 'wrap' ? 5 : 16, bot = m === 'wrap' ? 16 : 5;
  return `${bar(4, top, 6, 7)}${bar(11, top, 6, 7)}${bar(18, top, 6, 7)}${bar(4, bot, 6, 7, 'pb soft')}<path class="pa thin" d="M21 ${m === 'wrap' ? '13 l-12 5' : '15 l-12 -5'}"/>`;
}

const GROUPS = [
  { key: 'direction', label: 'flex-direction', ico: icoDir, turn: false },
  { key: 'wrap', label: 'flex-wrap', ico: icoWrap, turn: true },
  { key: 'justify', label: 'justify-content', ico: icoJustify, turn: true, idle: /^justify-content/ },
  { key: 'alignItems', label: 'align-items', ico: icoAlign, turn: true },
  { key: 'alignContent', label: 'align-content', ico: icoContent, turn: true, idle: /^align-content has no effect/ },
];

export function page(root, ctx) {
  const defOf = (k) => ctx.manifest.inputs.find((d) => d.key === k);
  const itemsDef = defOf('items');
  const selfOpts = itemsDef.columns.find((c) => c.key === 'self').options;

  // ---------------- DOM ----------------
  const props = el('div', { class: 'fx-props' });
  const groupEls = {};
  for (const g of GROUPS) {
    const box = el('div', { class: 'fx-grp', role: 'radiogroup', 'aria-label': g.label });
    const head = el('div', { class: 'fx-grp-head' }, `<code>${g.label}</code><span class="fx-grp-val"></span><span class="fx-idle" hidden>no effect now</span>`);
    const btns = el('div', { class: 'fx-grp-btns' });
    for (const o of defOf(g.key).options) {
      const b = el('button', { type: 'button', class: 'fx-ico', role: 'radio', 'data-v': o, title: `${g.label}: ${o}`, 'aria-label': `${g.label}: ${o}` },
        `<svg viewBox="0 0 28 28" aria-hidden="true">${g.ico(o)}</svg>`);
      b.addEventListener('click', () => ctx.set(g.key, o));
      b.addEventListener('keydown', (e) => {
        const opts = defOf(g.key).options, i = opts.indexOf(o);
        const j = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1 : null;
        if (j == null) return;
        e.preventDefault();
        const nv = opts[(j + opts.length) % opts.length];
        ctx.set(g.key, nv);
        requestAnimationFrame(() => btns.querySelector(`[data-v="${nv}"]`)?.focus());
      });
      btns.append(b);
    }
    box.append(head, btns);
    props.append(box);
    groupEls[g.key] = { box, head, btns, g };
  }

  const stage = el('section', { class: 'fx-stage' });
  const stageHead = el('div', { class: 'fx-stage-head' });
  const tip = el('span', { class: 'fx-tip' }, 'Drag the container\'s edges, an item\'s far edge (size) or its cross edge, or a gap band · click an item to select it · arrow keys on a focused item or handle');
  const sumEl = el('span', { class: 'fx-sum' });
  stageHead.append(sumEl, tip);
  const canvas = el('div', { class: 'fx-canvas' });
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'fx-svg');
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', 'The flex container drawn to scale; its edges, the items\' edges and the gaps can be dragged');
  canvas.append(svg);
  const warnEl = el('div', { class: 'fx-warns', role: 'status' });
  stage.append(stageHead, canvas, warnEl);

  const side = el('aside', { class: 'fx-side' });
  const insp = el('section', { class: 'fx-insp' });
  side.append(insp, ctx.outputs);

  const grid = el('div', { class: 'fx' });
  grid.append(props, stage, side);
  root.append(grid);

  const narrowLayout = () => grid.clientWidth < 880;
  // ---------------- state ----------------
  let sel = 1;            // selected item number (1-based)
  let drag = null;
  let frozen = null;      // {k, ox, oy} kept while dragging
  let pending = null;
  let geo = null;         // last drawing geometry for pointer maths

  const rawItems = () => (ctx.raw.items || []).map((r) => ({ ...r }));
  function setSoon(obj) {
    const first = !pending;
    pending = { ...(pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = pending; pending = null; ctx.setMany(p); });
  }
  const setItem = (i, patch, soon = false) => {
    const rows = rawItems();
    if (!rows[i - 1]) return;
    Object.assign(rows[i - 1], patch);
    if (soon) setSoon({ items: rows }); else ctx.set('items', rows);
  };

  // ---------------- drawing ----------------
  function draw(res) {
    const d = res && res.drawing && res.flexLines ? { ...res.drawing, ...res.flexLines } : null;
    const warns = res?.warnings || [];
    warnEl.innerHTML = warns.map((w) => `<div>${esc(w)}</div>`).join('');
    drawProps(res);
    if (!d) { svg.innerHTML = ''; drawInspector(null); sumEl.textContent = ''; return; }
    const row = d.direction === 'row' || d.direction === 'row-reverse';
    const mainRev = d.direction.endsWith('reverse');
    const crossRev = d.wrap === 'wrap-reverse';
    const multi = d.wrap !== 'nowrap';
    const W = d.width, H = d.height;
    const box = (i) => d.boxes.find((b) => b.i === i);
    // extent incl. overflow
    const maxX = Math.max(W, ...d.boxes.map((b) => b.x + b.w)), maxY = Math.max(H, ...d.boxes.map((b) => b.y + b.h));
    const minX = Math.min(0, ...d.boxes.map((b) => b.x)), minY = Math.min(0, ...d.boxes.map((b) => b.y));
    const Wp = Math.max(300, canvas.clientWidth), Hp = Math.max(260, canvas.clientHeight);
    const nar = Wp < 560;
    const L = nar ? 50 : 64, T = 58, R = nar ? 26 : 40, B = nar ? 22 : 34;
    let k, ox, oy;
    if (frozen) ({ k, ox, oy } = frozen);
    else {
      k = Math.min((Wp - L - R) / (maxX - minX), (Hp - T - B) / (maxY - minY), 3);
      const cw = (maxX - minX) * k, ch = (maxY - minY) * k;
      ox = L + Math.max(0, (Wp - L - R - cw) / 2) - minX * k;
      oy = T + Math.max(0, (Hp - T - B - ch) / 2) - minY * k;
    }
    geo = { k, ox, oy, row, d };
    const X = (v) => ox + v * k, Y = (v) => oy + v * k;
    svg.setAttribute('viewBox', `0 0 ${Wp} ${Hp}`);
    const fk = svg.contains(document.activeElement) ? document.activeElement.getAttribute('data-key') : null;
    const s = [];
    s.push(`<defs>
      <pattern id="fx-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" class="fx-hl"/></pattern>
      <pattern id="fx-xhatch" width="9" height="9" patternUnits="userSpaceOnUse"><path d="M0 4.5h9M4.5 0v9" class="fx-xl"/></pattern>
      <pattern id="fx-hatch-bad" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="6" class="fx-hl bad"/></pattern>
      <marker id="fx-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 8 4 0 8z" class="fx-arrhead"/></marker>
    </defs>`);
    // container
    s.push(`<rect class="fx-cont" x="${X(0)}" y="${Y(0)}" width="${W * k}" height="${H * k}"/>`);
    // lines (bands) when wrapping
    const physLine = (l) => {
      const p = crossRev ? (row ? H : W) - l.pos - l.cross : l.pos;
      return row ? { x: 0, y: p, w: W, h: l.cross } : { x: p, y: 0, w: l.cross, h: H };
    };
    if (multi && d.lines.length) {
      d.lines.forEach((l, li) => {
        const r = physLine(l);
        s.push(`<rect class="fx-line" x="${X(r.x)}" y="${Y(r.y)}" width="${r.w * k}" height="${r.h * k}"/>`);
        s.push(row ? `<text class="fx-lnlab" x="${X(W) + 6}" y="${Y(r.y + r.h / 2) + 4}">L${li + 1}</text>`
          : `<text class="fx-lnlab" x="${X(r.x + r.w / 2)}" y="${Y(H) + 14}" text-anchor="middle">L${li + 1}</text>`);
      });
    }
    // leftover cross space between/around the lines (what align-content places), when wrapping
    if (multi && d.lines.length) {
      const crossSize = row ? H : W;
      const ivs = d.lines.map(physLine).map((r) => (row ? [r.y, r.y + r.h] : [r.x, r.x + r.w])).sort((p, q) => p[0] - q[0]);
      let cur = 0;
      const holes = [];
      for (const [a0, a1] of ivs) { if (a0 - cur > 0.5) holes.push([cur, a0]); cur = Math.max(cur, a1); }
      if (crossSize - cur > 0.5) holes.push([cur, crossSize]);
      for (const [a0, a1] of holes) {
        const rect = row ? [X(0), Y(a0), W * k, (a1 - a0) * k] : [X(a0), Y(0), (a1 - a0) * k, H * k];
        s.push(`<rect class="fx-xfree" x="${rect[0]}" y="${rect[1]}" width="${rect[2]}" height="${rect[3]}"/>`);
        if ((row ? rect[3] : rect[2]) >= 16) s.push(`<text class="fx-xfreelab" x="${rect[0] + rect[2] / 2}" y="${rect[1] + rect[3] / 2 + 4}" text-anchor="middle">${r0(a1 - a0)} px</text>`);
      }
      if (d.crossFree < -0.5) {
        s.push(`<text class="fx-xtot bad" x="${X(W)}" y="${Y(H) + 28}" text-anchor="end">lines need ${fmt(-d.crossFree)} px more</text>`);
      }
    }
    // free space + gaps per line, along the main axis
    const mainSize = row ? W : H;
    let gapKeyDone = false;
    d.lines.forEach((l, li) => {
      const r = physLine(l);
      const bs = l.items.map(box).filter(Boolean).map((b) => ({ a: row ? b.x : b.y, b: row ? b.x + b.w : b.y + b.h }))
        .sort((p, q) => p.a - q.a);
      const segs = [];
      let cur = 0;
      bs.forEach((b, bi) => { segs.push({ a: cur, b: b.a, between: bi > 0 }); cur = b.b; });
      segs.push({ a: cur, b: mainSize, between: false });
      const c0 = row ? r.y : r.x, c1 = row ? r.y + r.h : r.x + r.w;
      for (const sg of segs) {
        const len = sg.b - sg.a;
        if (len < 0.5) continue;
        if (sg.between && d.gap > 0) {
          const ga = sg.a + (len - d.gap) / 2, gb = ga + Math.min(d.gap, len);
          const rect = row ? [X(ga), Y(c0), (gb - ga) * k, (c1 - c0) * k] : [X(c0), Y(ga), (c1 - c0) * k, (gb - ga) * k];
          const key = gapKeyDone ? '' : ' data-key="gap" tabindex="0"';
          gapKeyDone = true;
          s.push(`<rect class="fx-gap" data-h="gap"${key} role="slider" aria-label="gap ${fmt(d.gap)} px" x="${rect[0]}" y="${rect[1]}" width="${Math.max(2, rect[2])}" height="${Math.max(2, rect[3])}"><title>gap ${fmt(d.gap)} px: drag to change</title></rect>`);
          const free = len - d.gap;
          if (free > 0.5) {
            pushFree(sg.a, ga, c0, c1, free / 2);
            pushFree(gb, sg.b, c0, c1, free / 2);
          }
          continue;
        }
        pushFree(sg.a, sg.b, c0, c1, len);
      }
      // total free for the line (from run())
      const lab = l.free < -0.5 ? `overflow ${fmt(-l.free)} px` : `free ${fmt(l.free)} px`;
      const cls = l.free < -0.5 ? 'fx-freelab bad' : 'fx-freelab';
      if (row) s.push(`<text class="${cls}" x="${X(0) + 3}" y="${Y(c1) - 4}">${lab}</text>`);
      else s.push(`<text class="${cls}" x="${X(c0) + 3}" y="${Y(H) - 5}">${lab}</text>`);
      void li;
    });
    function pushFree(a, b, c0, c1, len) {
      if (b - a < 0.5) return;
      const rect = row ? [X(a), Y(c0), (b - a) * k, (c1 - c0) * k] : [X(c0), Y(a), (c1 - c0) * k, (b - a) * k];
      s.push(`<rect class="fx-free" x="${rect[0]}" y="${rect[1]}" width="${rect[2]}" height="${rect[3]}"/>`);
      const big = (row ? rect[2] : rect[3]) >= 26 && (row ? rect[3] : rect[2]) >= 18;
      if (big) s.push(`<text class="fx-freenum" x="${rect[0] + rect[2] / 2}" y="${rect[1] + rect[3] / 2 + 4}" text-anchor="middle">${r0(len)}</text>`);
    }
    // items
    const post = [];
    for (const b of d.boxes) {
      const it = d.items.find((x) => x.i === b.i) || {};
      const x = X(b.x), y = Y(b.y), w = b.w * k, h = b.h * k;
      const c = SER[(b.i - 1) % 4];
      const on = b.i === sel;
      const out = b.x < -0.5 || b.y < -0.5 || b.x + b.w > W + 0.5 || b.y + b.h > H + 0.5;
      const mainAuto = (row ? it.w : it.h) === 'auto', crossAuto = (row ? it.h : it.w) === 'auto';
      const basis = mainAuto ? 'auto' : `${row ? it.w : it.h}`;
      s.push(`<g class="fx-item ${c}${on ? ' on' : ''}${out ? ' out' : ''}" data-h="item" data-i="${b.i}" data-key="item${b.i}" tabindex="0" role="button"
        aria-label="Item ${b.i}: ${fmt(b.w)} by ${fmt(b.h)} px at ${fmt(b.x)}, ${fmt(b.y)}; flex ${it.grow} ${it.shrink} ${basis}. Arrow keys resize, G toggles grow.">
        <rect class="fx-ib" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/>`);
      if (out) s.push(`<rect class="fx-outhatch" x="${x}" y="${y}" width="${w}" height="${h}" rx="3" clip-path="none"/>`);
      // flexed: the basis it started from, dashed, so grow and shrink show as a difference
      const basisV = mainAuto ? 0 : Number(row ? it.w : it.h);
      const size = row ? b.w : b.h;
      if (Number.isFinite(basisV) && Math.abs(size - Math.max(24, basisV)) > 0.5) {
        const bl = Math.max(24, basisV) * k;
        const gr = size > basisV;
        s.push(row ? `<rect class="fx-basis${gr ? ' grow' : ''}" x="${x}" y="${y + 2}" width="${bl}" height="${Math.max(2, h - 4)}"/>`
          : `<rect class="fx-basis${gr ? ' grow' : ''}" x="${x + 2}" y="${y}" width="${Math.max(2, w - 4)}" height="${bl}"/>`);
        if ((row ? w : h) >= 40 && (row ? h : w) >= 40) {
          const tx = row ? x + Math.min(bl, w) / 2 : x + w / 2, ty = row ? y + h / 2 + 4 : y + Math.min(bl, h) / 2 + 4;
          s.push(`<text class="fx-basislab" x="${tx}" y="${ty}" text-anchor="middle">${gr ? 'grew' : 'shrank'} ${fmt(Math.abs(size - Math.max(24, basisV)))}</text>`);
        }
      }
      const roomy = w >= 46 && h >= 34;
      s.push(`<text class="fx-inum" x="${x + 6}" y="${y + 15}">${b.i}${it.order ? `<tspan class="fx-ord"> o${it.order}</tspan>` : ''}</text>`);
      if (roomy) {
        s.push(`<text class="fx-isz" x="${x + 6}" y="${y + h - 7}">${fmt(b.w)}×${fmt(b.h)}</text>`);
      }
      if (w >= 62 && h >= 24) {
        s.push(`<text class="fx-iflex" x="${x + w - 5}" y="${y + 14}" text-anchor="end">${it.grow ? `grow ${it.grow}` : ''}${it.grow && it.shrink !== 1 ? ' · ' : ''}${it.shrink !== 1 ? `shrink ${it.shrink}` : ''}</text>`);
      }
      if (crossAuto && roomy && w >= 96) s.push(`<text class="fx-iauto" x="${x + w - 5}" y="${y + h - 7}" text-anchor="end">${row ? 'h' : 'w'} auto</text>`);
      s.push('</g>');
      // handles: main-end edge and cross-end edge (wide invisible hit areas; grips on the selected item)
      const hs = 9;
      if (on) {
        const gm = row ? `<rect class="fx-grip" x="${x + w - 2}" y="${y + h / 2 - 9}" width="4" height="18" rx="2"/>` : `<rect class="fx-grip" x="${x + w / 2 - 9}" y="${y + h - 2}" width="18" height="4" rx="2"/>`;
        const gc = row ? `<rect class="fx-grip${crossAuto ? ' auto' : ''}" x="${x + w / 2 - 9}" y="${y + h - 2}" width="18" height="4" rx="2"/>` : `<rect class="fx-grip${crossAuto ? ' auto' : ''}" x="${x + w - 2}" y="${y + h / 2 - 9}" width="4" height="18" rx="2"/>`;
        post.push(gm, gc);
      }
      if (row) {
        s.push(`<rect class="fx-hdl${on ? ' on' : ''}" data-h="im" data-i="${b.i}" x="${x + w - hs / 2}" y="${y + 4}" width="${hs}" height="${Math.max(6, h - 8)}"><title>Item ${b.i} width: drag</title></rect>`);
        s.push(`<rect class="fx-hdl x${on ? ' on' : ''}${crossAuto ? ' auto' : ''}" data-h="ic" data-i="${b.i}" x="${x + 4}" y="${y + h - hs / 2}" width="${Math.max(6, w - 8)}" height="${hs}"><title>Item ${b.i} height${crossAuto ? ' (auto)' : ''}: drag · double-click for auto</title></rect>`);
      } else {
        s.push(`<rect class="fx-hdl x${on ? ' on' : ''}" data-h="im" data-i="${b.i}" x="${x + 4}" y="${y + h - hs / 2}" width="${Math.max(6, w - 8)}" height="${hs}"><title>Item ${b.i} height: drag</title></rect>`);
        s.push(`<rect class="fx-hdl${on ? ' on' : ''}${crossAuto ? ' auto' : ''}" data-h="ic" data-i="${b.i}" x="${x + w - hs / 2}" y="${y + 4}" width="${hs}" height="${Math.max(6, h - 8)}"><title>Item ${b.i} width${crossAuto ? ' (auto)' : ''}: drag · double-click for auto</title></rect>`);
      }
    }
    s.push(...post);
    // overflow edges
    if (d.boxes.some((b) => b.x + b.w > W + 0.5 || b.y + b.h > H + 0.5 || b.x < -0.5 || b.y < -0.5)) {
      s.push(`<rect class="fx-contbad" x="${X(0)}" y="${Y(0)}" width="${W * k}" height="${H * k}"/>`);
    }
    // dimensions + axes
    const yTop = Y(Math.min(0, minY)) - 30, xLeft = X(Math.min(0, minX)) - 34;
    s.push(`<line class="fx-dim" x1="${X(0)}" y1="${yTop}" x2="${X(W)}" y2="${yTop}"/><line class="fx-ext" x1="${X(0)}" y1="${yTop - 5}" x2="${X(0)}" y2="${Y(0)}"/><line class="fx-ext" x1="${X(W)}" y1="${yTop - 5}" x2="${X(W)}" y2="${Y(0)}"/>`);
    s.push(`<text class="fx-dimlab" x="${X(W / 2)}" y="${yTop - 5}" text-anchor="middle">width ${fmt(W)} px</text>`);
    s.push(`<line class="fx-dim" x1="${xLeft}" y1="${Y(0)}" x2="${xLeft}" y2="${Y(H)}"/><line class="fx-ext" x1="${xLeft - 5}" y1="${Y(0)}" x2="${X(0)}" y2="${Y(0)}"/><line class="fx-ext" x1="${xLeft - 5}" y1="${Y(H)}" x2="${X(0)}" y2="${Y(H)}"/>`);
    s.push(`<text class="fx-dimlab" transform="translate(${xLeft - 6} ${Y(H / 2)}) rotate(-90)" text-anchor="middle">height ${fmt(H)} px</text>`);
    // axis arrows: main (thick) and cross (thin), inside the dimension band
    const ma = row ? { x1: X(0) + 8, x2: X(W) - 8, y1: yTop + 13, y2: yTop + 13 } : { x1: xLeft + 14, x2: xLeft + 14, y1: Y(0) + 8, y2: Y(H) - 8 };
    if (mainRev) [ma.x1, ma.x2, ma.y1, ma.y2] = [ma.x2, ma.x1, ma.y2, ma.y1];
    s.push(`<line class="fx-axis" x1="${ma.x1}" y1="${ma.y1}" x2="${ma.x2}" y2="${ma.y2}" marker-end="url(#fx-arr)"/>`);
    s.push(row ? `<text class="fx-axlab" x="${(ma.x1 + ma.x2) / 2}" y="${ma.y1 + 12}" text-anchor="middle">main axis · justify-content</text>`
      : `<text class="fx-axlab" transform="translate(${ma.x1 + 12} ${(ma.y1 + ma.y2) / 2}) rotate(90)" text-anchor="middle">main axis · justify-content</text>`);
    const ca = row ? { x1: xLeft + 14, x2: xLeft + 14, y1: Y(0) + 8, y2: Y(H) - 8 } : { x1: X(0) + 8, x2: X(W) - 8, y1: yTop + 13, y2: yTop + 13 };
    if (crossRev) [ca.x1, ca.x2, ca.y1, ca.y2] = [ca.x2, ca.x1, ca.y2, ca.y1];
    s.push(`<line class="fx-axis cross" x1="${ca.x1}" y1="${ca.y1}" x2="${ca.x2}" y2="${ca.y2}" marker-end="url(#fx-arr)"/>`);
    s.push(row ? `<text class="fx-axlab" transform="translate(${ca.x1 + 12} ${(ca.y1 + ca.y2) / 2}) rotate(90)" text-anchor="middle">cross · align</text>`
      : `<text class="fx-axlab" x="${(ca.x1 + ca.x2) / 2}" y="${ca.y1 + 12}" text-anchor="middle">cross · align</text>`);
    // container handles
    s.push(`<rect class="fx-chdl" data-h="cw" data-key="cw" tabindex="0" role="slider" aria-label="Container width ${fmt(W)} px" x="${X(W) - 4}" y="${Y(H / 2) - 22}" width="8" height="44" rx="3"><title>Container width: drag</title></rect>`);
    s.push(`<rect class="fx-chdl" data-h="ch" data-key="ch" tabindex="0" role="slider" aria-label="Container height ${fmt(H)} px" x="${X(W / 2) - 22}" y="${Y(H) - 4}" width="44" height="8" rx="3"><title>Container height: drag</title></rect>`);
    s.push(`<rect class="fx-chdl corner" data-h="cc" x="${X(W) - 6}" y="${Y(H) - 6}" width="12" height="12" rx="3"><title>Container size: drag</title></rect>`);

    svg.innerHTML = s.join('');
    // narrow screens: the canvas takes the drawing's own proportions
    if (narrowLayout() && !frozen) {
      const want = Math.round(clamp((maxY - minY) * k + T + B + 8, 200, 560));
      if (Math.abs(canvas.clientHeight - want) > 2) canvas.style.height = `${want}px`;
    } else if (!narrowLayout()) canvas.style.height = '';
    if (fk) svg.querySelector(`[data-key="${fk}"]`)?.focus();

    const lines = d.lines.length;
    sumEl.innerHTML = `<b>${row ? 'Row' : 'Column'}</b>${mainRev ? ' reversed' : ''} · ${lines} line${lines > 1 ? 's' : ''} · ${d.boxes.length} items · scale ${Math.round(k * 100)} %`;
    drawInspector(d);
  }

  function drawProps(res) {
    const inp = ctx.raw;
    const notes = res?.notes || [];
    const row = inp.direction === 'row' || inp.direction === 'row-reverse';
    props.classList.toggle('col', !row);
    for (const [key, G] of Object.entries(groupEls)) {
      for (const b of G.btns.children) {
        const on = b.dataset.v === String(inp[key]);
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      G.head.querySelector('.fx-grp-val').textContent = inp[key];
      let idle = G.g.idle ? notes.find((n) => G.g.idle.test(n)) : null;
      if (key === 'alignItems') idle = notes.find((n) => /^Stretch has no effect/.test(n)) || null;
      const tag = G.head.querySelector('.fx-idle');
      tag.hidden = !idle;
      tag.textContent = key === 'alignItems' ? 'stretch ignored' : 'no effect now';
      tag.title = idle || '';
      G.box.classList.toggle('idle', !!idle && key !== 'alignItems');
    }
  }

  // ---------------- inspector: container + selected item (the typing path) ----------------
  function field(label, key, value, unit, onInput, attrs = {}) {
    const id = `fx-f-${key}`;
    const f = el('label', { class: 'fx-f', for: id }, `<span>${label}</span>`);
    const inp = el('input', { id, type: 'text', inputmode: 'decimal', spellcheck: 'false', class: 'fx-in', ...attrs });
    inp.value = value ?? '';
    inp.addEventListener('input', () => onInput(inp.value));
    f.append(inp);
    if (unit) f.append(el('em', {}, unit));
    return f;
  }
  function stepper(label, key, value, onSet, min = 0) {
    const f = el('div', { class: 'fx-f fx-step' }, `<span>${label}</span>`);
    const dec = el('button', { type: 'button', class: 'fx-sb', 'aria-label': `${label} minus 1` }, '−');
    const inp = el('input', { id: `fx-f-${key}`, type: 'text', inputmode: 'decimal', spellcheck: 'false', class: 'fx-in', 'aria-label': label });
    const inc = el('button', { type: 'button', class: 'fx-sb', 'aria-label': `${label} plus 1` }, '+');
    inp.value = value ?? '';
    const n = () => Number.parseFloat(inp.value) || 0;
    dec.addEventListener('click', () => onSet(String(Math.max(min, n() - 1))));
    inc.addEventListener('click', () => onSet(String(n() + 1)));
    inp.addEventListener('input', () => onSet(inp.value, true));
    f.append(dec, inp, inc);
    return f;
  }

  let inspSig = '';
  function drawInspector(d) {
    const raw = ctx.raw;
    const rows = raw.items || [];
    if (sel > rows.length) sel = rows.length || 1;
    // Rebuild only when the structure changed, so typing keeps focus.
    const sig = `${rows.length}|${sel}|${raw.direction}`;
    const active = insp.contains(document.activeElement) ? document.activeElement.id : null;
    if (sig !== inspSig || !active) {
      inspSig = sig;
      insp.replaceChildren();
      const c = el('div', { class: 'fx-card' });
      c.append(el('div', { class: 'fx-card-head' }, '<b>Container</b><code>.container</code>'));
      const cf = el('div', { class: 'fx-fields' });
      cf.append(field('width <i>px</i>', 'width', raw.width, '', (v) => ctx.set('width', v)),
        field('height <i>px</i>', 'height', raw.height, '', (v) => ctx.set('height', v)),
        field('gap <i>px</i>', 'gap', raw.gap, '', (v) => ctx.set('gap', v)));
      c.append(cf);
      insp.append(c);

      const it = rows[sel - 1];
      const ic = el('div', { class: 'fx-card' });
      const tabs = el('div', { class: 'fx-itabs', role: 'tablist', 'aria-label': 'Items' });
      rows.forEach((_, i) => {
        const b = el('button', { type: 'button', role: 'tab', class: `fx-itab ${SER[i % 4]}`, 'aria-selected': String(i + 1 === sel) }, String(i + 1));
        b.addEventListener('click', () => { sel = i + 1; draw(ctx.result); });
        tabs.append(b);
      });
      const add = el('button', { type: 'button', class: 'fx-itab add', title: 'Add an item', 'aria-label': 'Add an item' }, '+');
      add.addEventListener('click', () => {
        const rs = rawItems();
        const last = rs[rs.length - 1] || {};
        rs.push({ w: last.w ?? '80', h: last.h ?? '50', grow: '0', shrink: '1', self: 'auto', order: '0' });
        sel = rs.length;
        ctx.set('items', rs);
      });
      tabs.append(add);
      ic.append(el('div', { class: 'fx-card-head' }, `<b>Item</b><code>.item:nth-child(${sel})</code>`), tabs);
      if (it) {
        const f = el('div', { class: 'fx-fields' });
        f.append(field('width <i>px | auto</i>', 'iw', it.w, '', (v) => setItem(sel, { w: v })),
          field('height <i>px | auto</i>', 'ih', it.h, '', (v) => setItem(sel, { h: v })),
          stepper('grow', 'grow', it.grow, (v) => setItem(sel, { grow: v })),
          stepper('shrink', 'shrink', it.shrink, (v) => setItem(sel, { shrink: v })),
          stepper('order', 'order', it.order, (v) => setItem(sel, { order: v }), -99));
        ic.append(f);
        const selfBox = el('div', { class: 'fx-self', role: 'radiogroup', 'aria-label': 'align-self' }, '<span>align-self</span>');
        const selfBtns = el('div', { class: 'fx-grp-btns' });
        for (const o of selfOpts) {
          const b = el('button', { type: 'button', class: 'fx-ico sm', role: 'radio', 'aria-checked': String(String(it.self || 'auto') === o), title: `align-self: ${o}`, 'aria-label': `align-self: ${o}` },
            o === 'auto' ? '<span class="fx-auto">auto</span>' : `<svg viewBox="0 0 28 28" aria-hidden="true">${icoAlign(o)}</svg>`);
          b.addEventListener('click', () => setItem(sel, { self: o }));
          selfBtns.append(b);
        }
        selfBox.append(selfBtns);
        ic.append(selfBox);
        const acts = el('div', { class: 'fx-acts' });
        const mv = (dir) => {
          const rs = rawItems(), j = sel - 1 + dir;
          if (j < 0 || j >= rs.length) return;
          [rs[sel - 1], rs[j]] = [rs[j], rs[sel - 1]];
          sel = j + 1;
          ctx.set('items', rs);
        };
        const b1 = el('button', { type: 'button', class: 'k-btn', title: 'Move this item one place earlier in the HTML' }, '← earlier');
        const b2 = el('button', { type: 'button', class: 'k-btn', title: 'Move this item one place later in the HTML' }, 'later →');
        const b3 = el('button', { type: 'button', class: 'k-btn fx-del' }, 'Remove');
        b1.disabled = sel <= 1; b2.disabled = sel >= rows.length; b3.disabled = rows.length <= 1;
        b1.addEventListener('click', () => mv(-1));
        b2.addEventListener('click', () => mv(1));
        b3.addEventListener('click', () => { const rs = rawItems(); rs.splice(sel - 1, 1); sel = Math.max(1, sel - 1); ctx.set('items', rs); });
        acts.append(b1, b2, b3);
        ic.append(acts);
        ic.append(el('div', { class: 'fx-computed' }));
      }
      insp.append(ic);
    } else {
      // keep the fields that are not being typed in in step with the drawing
      const it = rows[sel - 1] || {};
      const vals = { 'fx-f-width': raw.width, 'fx-f-height': raw.height, 'fx-f-gap': raw.gap, 'fx-f-iw': it.w, 'fx-f-ih': it.h, 'fx-f-grow': it.grow, 'fx-f-shrink': it.shrink, 'fx-f-order': it.order };
      for (const [id, v] of Object.entries(vals)) { const e = insp.querySelector(`#${id}`); if (e && id !== active && e.value !== String(v ?? '')) e.value = v ?? ''; }
      for (const b of insp.querySelectorAll('.fx-self .fx-ico')) b.setAttribute('aria-checked', String(b.title === `align-self: ${it.self || 'auto'}`));
    }
    if (active && !insp.contains(document.activeElement)) insp.querySelector(`#${active}`)?.focus();
    const comp = insp.querySelector('.fx-computed');
    const tbl = ctx.result?.tables?.[0];
    const rowT = tbl?.rows?.find((r) => r[0] === sel);
    if (comp) comp.innerHTML = rowT
      ? `<span>laid out at</span> <b>x ${rowT[1]}</b> <b>y ${rowT[2]}</b> <span>size</span> <b>${rowT[3]} × ${rowT[4]}</b> <span>line ${rowT[5]}</span>`
      : '';
    // sizes (for the item switch) change with every run
    void d;
  }

  // ---------------- pointer + keys on the drawing ----------------
  const num = (v, fb) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : fb; };
  svg.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('[data-h]');
    if (!t || !geo) return;
    const h = t.getAttribute('data-h');
    const i = Number(t.getAttribute('data-i')) || 0;
    if (h === 'item') { sel = i; draw(ctx.result); return; }
    e.preventDefault();
    const raw = ctx.raw, row = geo.row;
    const box = i ? geo.d.boxes.find((b) => b.i === i) : null;
    drag = { h, i, x0: e.clientX, y0: e.clientY, W: num(raw.width, 480), H: num(raw.height, 220), gap: num(raw.gap, 0),
      main: box ? (row ? box.w : box.h) : 0, cross: box ? (row ? box.h : box.w) : 0, moved: false };
    if (i) sel = i;
    frozen = { k: geo.k, ox: geo.ox, oy: geo.oy };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('dragging');
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const k = frozen.k, dx = (e.clientX - drag.x0) / k, dy = (e.clientY - drag.y0) / k;
    const row = geo.row;
    drag.moved = true;
    const R = (v) => String(Math.round(v));
    if (drag.h === 'cw') setSoon({ width: R(clamp(drag.W + dx, 40, 2000)) });
    else if (drag.h === 'ch') setSoon({ height: R(clamp(drag.H + dy, 30, 2000)) });
    else if (drag.h === 'cc') setSoon({ width: R(clamp(drag.W + dx, 40, 2000)), height: R(clamp(drag.H + dy, 30, 2000)) });
    else if (drag.h === 'gap') setSoon({ gap: R(clamp(drag.gap + (row ? dx : dy), 0, 200)) });
    else if (drag.h === 'im') setItem(drag.i, { [row ? 'w' : 'h']: R(clamp(drag.main + (row ? dx : dy), 0, 2000)) }, true);
    else if (drag.h === 'ic') setItem(drag.i, { [row ? 'h' : 'w']: R(clamp(drag.cross + (row ? dy : dx), 0, 2000)) }, true);
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    svg.classList.remove('dragging');
    // unfreeze the scale after the last run lands
    requestAnimationFrame(() => requestAnimationFrame(() => { frozen = null; draw(ctx.result); }));
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('dblclick', (e) => {
    const t = e.target.closest('[data-h="ic"]');
    if (!t) return;
    const i = Number(t.getAttribute('data-i'));
    setItem(i, { [geo.row ? 'h' : 'w']: 'auto' });
  });
  svg.addEventListener('keydown', (e) => {
    const t = e.target.closest('[data-key]');
    if (!t || !geo) return;
    const key = t.getAttribute('data-key');
    const step = e.shiftKey ? 10 : 1;
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key];
    const raw = ctx.raw, row = geo.row;
    const R = (v) => String(Math.round(v));
    if (key.startsWith('item')) {
      const i = Number(key.slice(4));
      const b = geo.d.boxes.find((x) => x.i === i);
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sel = i; draw(ctx.result); return; }
      if (e.key === 'g' || e.key === 'G') { const it = raw.items[i - 1]; setItem(i, { grow: Number(it.grow) ? '0' : '1' }); return; }
      if (!dir || !b) return;
      e.preventDefault();
      sel = i;
      if (dir[0]) setItem(i, { w: R(Math.max(0, b.w + dir[0] * step)) });
      else setItem(i, { h: R(Math.max(0, b.h + dir[1] * step)) });
      return;
    }
    if (!dir) return;
    e.preventDefault();
    if (key === 'cw') ctx.set('width', R(clamp(num(raw.width, 480) + (dir[0] || -dir[1]) * step, 40, 2000)));
    if (key === 'ch') ctx.set('height', R(clamp(num(raw.height, 220) + (dir[1] || dir[0]) * step, 30, 2000)));
    if (key === 'gap') ctx.set('gap', R(clamp(num(raw.gap, 0) + (dir[0] || -dir[1]) * step, 0, 200)));
    void row;
  });

  ctx.onResult((res) => draw(res));
  let lastW = 0, lastH = 0, rz = 0;
  new ResizeObserver(() => {
    if (canvas.clientWidth === lastW && canvas.clientHeight === lastH) return;
    lastW = canvas.clientWidth; lastH = canvas.clientHeight;
    cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { if (!drag) draw(ctx.result); });
  }).observe(canvas);
}
