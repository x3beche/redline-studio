// Panelization Planner page: the panel on the drawing board.
//   Plan     - the panel to scale under two rulers: rails with tooling holes
//              and fiducials, the grid of boards, the V-score lines or the
//              mouse-bite tabs, and the unused strips hatched with what one more
//              column or row would need. Drag the panel's edges or corner, the
//              first board's corner, the gap between boards and the rail's
//              inner edge; click a dimension to type it.
//   Below    - both orientations side by side (the one used is marked), and
//              the production run as a row of panels, the last one part-used.
// Every number drawn comes from run()'s result (result.plan, result.layout).
import { fmtNum } from '../kit/eng.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const h = (tag, attrs = {}, html) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  if (html != null) e.innerHTML = html;
  return e;
};
const NS = 'http://www.w3.org/2000/svg';
const svg = (cls, label) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('class', cls); if (label) { s.setAttribute('role', 'group'); s.setAttribute('aria-label', label); } return s; };
const f = (v, d = 4) => fmtNum(v, d);
const q = (v, st) => Math.round(v / st) * st;
const PRESETS = [[100, 100], [160, 100], [200, 150], [250, 250], [305, 457], [457, 610]];
const PNAME = { '305x457': '12 × 18 in', '457x610': '18 × 24 in', '160x100': 'Eurocard' };

const glyph = (m) => (m === 'vscore'
  ? '<svg viewBox="0 0 30 18" aria-hidden="true"><rect x="1" y="3" width="28" height="12" class="gb"/><path d="M15 1V17" class="gv"/><path d="M11 3l4 5 4-5" class="gl"/></svg>'
  : '<svg viewBox="0 0 30 18" aria-hidden="true"><rect x="1" y="3" width="12" height="12" class="gb"/><rect x="17" y="3" width="12" height="12" class="gb"/><circle cx="15" cy="7" r="1" class="gt"/><circle cx="15" cy="9" r="1" class="gt"/><circle cx="15" cy="11" r="1" class="gt"/></svg>');

export function page(root, ctx) {
  // ---------------- DOM ----------------
  const bar = h('div', { class: 'pz-bar' });
  const sepSeg = h('div', { class: 'pz-seg', role: 'radiogroup', 'aria-label': 'Separation' },
    `<button type="button" role="radio" data-m="vscore">${glyph('vscore')}V-score</button><button type="button" role="radio" data-m="tabs">${glyph('tabs')}Tabs, mouse bites</button>`);
  sepSeg.addEventListener('click', (e) => { const m = e.target.closest('[data-m]')?.dataset.m; if (m) ctx.setMany({ method: m, gap: '' }); });
  const railSeg = h('div', { class: 'pz-seg', role: 'radiogroup', 'aria-label': 'Rails' },
    '<button type="button" role="radio" data-r="two">Rails top + bottom</button><button type="button" role="radio" data-r="four">All four sides</button><button type="button" role="radio" data-r="none">No rails</button>');
  railSeg.addEventListener('click', (e) => { const r = e.target.closest('[data-r]')?.dataset.r; if (r) ctx.set('rails', r); });
  const presets = h('div', { class: 'pz-presets', role: 'group', 'aria-label': 'Panel size presets' });
  presets.innerHTML = '<span>Panel</span>' + PRESETS.map(([w, hh]) => `<button type="button" class="pz-chip" data-p="${w}x${hh}" title="${w} × ${hh} mm">${w}×${hh}${PNAME[`${w}x${hh}`] ? ` <small>${PNAME[`${w}x${hh}`]}</small>` : ''}</button>`).join('');
  presets.addEventListener('click', (e) => { const p = e.target.closest('[data-p]')?.dataset.p; if (p) { const [w, hh] = p.split('x'); ctx.setMany({ pw: w, ph: hh }); } });
  bar.append(sepSeg, railSeg, presets);

  const head = h('div', { class: 'pz-headline', 'aria-live': 'polite' });
  const plan = h('section', { class: 'pz-plan' });
  const pBox = h('div', { class: 'pz-box' });
  const P = svg('pz-svg', 'The panel to scale; drag its edges, the first board corner, the gap and the rail');
  pBox.append(P);
  const tip = h('div', { class: 'pz-tip' }, 'Drag the panel edge or corner, the first board’s corner, the gap and the rail edge · arrow keys on a focused handle (Shift: ×10) · click a dimension to type it');
  plan.append(pBox, tip);

  const orient = h('section', { class: 'pz-card pz-orient' });
  const run = h('section', { class: 'pz-card pz-run' });
  const warn = h('section', { class: 'pz-warn', role: 'status' });
  const side = h('section', { class: 'pz-side' });
  const notes = h('details', { class: 'pz-notes' });
  side.append(ctx.outputs, notes);

  const aside = h('div', { class: 'pz-aside' });
  aside.append(run, orient, warn);
  const grid = h('div', { class: 'pz' });
  grid.append(bar, head, plan, aside, side);
  root.append(grid);

  // ---------------- state ----------------
  let drag = null, pending = null, frozen = null, editing = null, geo = null;
  const setSoon = (obj) => {
    const first = !pending; pending = { ...(pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = pending; pending = null; ctx.setMany(p); });
  };
  const R = () => ctx.result || {};

  // ---------------- headline ----------------
  function drawHead() {
    const res = R(), p = res.plan, v = res.values || [];
    for (const b of sepSeg.children) b.setAttribute('aria-checked', String(b.dataset.m === (ctx.raw.method || 'vscore')));
    for (const b of railSeg.children) b.setAttribute('aria-checked', String(b.dataset.r === (ctx.raw.rails || 'two')));
    const inp = ctx.input;
    for (const b of presets.querySelectorAll('[data-p]')) b.setAttribute('aria-pressed', String(b.dataset.p === `${inp.pw}x${inp.ph}`));
    if (!p) { head.innerHTML = `<div class="pz-n bad"><b>${esc(v[0]?.value ?? '–')}</b><span>boards per panel</span></div>`; return; }
    const tone = p.util >= 0.75 ? 'ok' : p.util >= 0.6 ? 'warn' : 'bad';
    head.innerHTML = `<div class="pz-n"><b>${p.n}</b><span>boards per panel<br>${p.cols} × ${p.rows}${p.rot ? ', turned 90°' : ''}</span></div>`
      + `<div class="pz-n ${tone}"><b>${esc(f(p.util * 100, 3))}<i>%</i></b><span>of the panel<br>is boards</span></div>`
      + `<div class="pz-kv"><span>Waste</span><b>${esc(f(p.waste * 100, 3))} % · ${esc(f(p.wasteArea / 100, 4))} cm²</b>`
      + `<span>Array with rails</span><b>${esc(f(p.aw))} × ${esc(f(p.ah))} mm</b>`
      + `<span>Boards fill the array</span><b>${esc(f(p.arrUtil * 100, 3))} %</b></div>`;
  }

  // ---------------- the plan ----------------
  function niceStep(span, target) {
    const raw = span / target, p10 = 10 ** Math.floor(Math.log10(raw)), m = raw / p10;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p10;
  }
  function drawPlan() {
    const res = R(), L = res.layout, p = res.plan, inp = ctx.input;
    const W = Math.max(300, pBox.clientWidth), H = Math.max(260, pBox.clientHeight);
    P.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!L || !(L.pw > 0 && L.ph > 0)) { P.innerHTML = `<text class="pz-empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">Give the panel and board sizes</text>`; geo = null; return; }
    const RU = 22, narrow = W < 520;
    const mr = narrow ? 30 : 150, mb = 34;
    let k = frozen?.k ?? Math.min((W - RU - 14 - mr) / L.pw, (H - RU - 14 - mb) / L.ph);
    if (narrow && !frozen) {
      k = Math.min((W - RU - 14 - mr) / L.pw, 520 / L.ph);
      const want = Math.round(L.ph * k + RU + 14 + mb + 8);
      if (Math.abs(want - pBox.clientHeight) > 3) { pBox.style.height = `${want}px`; P.setAttribute('viewBox', `0 0 ${W} ${want}`); }
    } else if (!narrow && pBox.style.height) pBox.style.height = '';
    const ox = RU + 12, oy = RU + 12;
    const X = (x) => ox + x * k, Y = (y) => oy + y * k;
    const o = [];
    o.push(`<defs><pattern id="pz-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" class="pz-hl"/></pattern></defs>`);
    // rulers
    const st = niceStep(Math.max(L.pw, L.ph), (W > 700 ? 14 : 7));
    o.push(`<rect class="pz-ruler" x="${ox}" y="0" width="${Math.max(0, Math.min(W, X(L.pw * 1.08) + 4) - ox)}" height="${RU}"/><rect class="pz-ruler" x="0" y="${oy}" width="${RU}" height="${Math.max(0, Math.min(H, Y(L.ph * 1.1) + 4) - oy)}"/>`);
    const rx1 = Math.min(W, X(L.pw * 1.08) + 4), ry1 = Math.min(H, Y(L.ph * 1.1) + 4);
    for (let x = 0; X(x) <= rx1; x += st / 2) {
      const major = Math.abs(x / st - Math.round(x / st)) < 1e-6;
      o.push(`<line class="pz-tick" x1="${X(x)}" x2="${X(x)}" y1="${RU}" y2="${RU - (major ? 8 : 4)}"/>`);
      if (major) o.push(`<text class="pz-rt" x="${X(x) + 2}" y="11">${f(x)}</text>`);
    }
    for (let y = 0; Y(y) <= ry1; y += st / 2) {
      const major = Math.abs(y / st - Math.round(y / st)) < 1e-6;
      o.push(`<line class="pz-tick" y1="${Y(y)}" y2="${Y(y)}" x1="${RU}" x2="${RU - (major ? 8 : 4)}"/>`);
      if (major && y > 0) o.push(`<text class="pz-rt" x="11" y="${Y(y) - 3}" transform="rotate(-90 11 ${Y(y) - 3})" text-anchor="end">${f(y)}</text>`);
    }
    o.push(`<text class="pz-rt" x="3" y="11">mm</text>`);
    // panel and rails
    o.push(`<rect class="pz-panel" x="${X(0)}" y="${Y(0)}" width="${L.pw * k}" height="${L.ph * k}"/>`);
    const rails = [];
    if (L.ry > 0) rails.push([0, 0, L.pw, L.ry], [0, L.ph - L.ry, L.pw, L.ry]);
    if (L.rx > 0) rails.push([0, 0, L.rx, L.ph], [L.pw - L.rx, 0, L.rx, L.ph]);
    for (const [x, y, w, hh] of rails) o.push(`<rect class="pz-rail" x="${X(x)}" y="${Y(y)}" width="${w * k}" height="${hh * k}"/>`);
    // tooling holes (Ø ~3 mm) and fiducials (Ø 1 mm) on the rails
    if (L.ry > 0 && L.ry * k > 7) {
      const r = Math.min(1.5, L.ry * 0.3);
      for (const [x, y] of [[L.ry, L.ry / 2], [L.pw - L.ry, L.ry / 2], [L.ry, L.ph - L.ry / 2], [L.pw - L.ry, L.ph - L.ry / 2]]) o.push(`<circle class="pz-hole" cx="${X(x)}" cy="${Y(y)}" r="${Math.max(2, r * k)}"/>`);
      for (const [x, y] of [[L.ry * 3, L.ry / 2], [L.pw - L.ry * 3, L.ry / 2], [L.ry * 3, L.ph - L.ry / 2]]) if (x * k > 20) o.push(`<circle class="pz-fid" cx="${X(x)}" cy="${Y(y)}" r="${Math.max(1.6, 0.5 * k)}"/>`);
    }
    // unused strips, hatched, with what one more column / row would need
    const aw = L.cols ? L.cols * L.bw + (L.cols - 1) * L.gap : 0, ah = L.rows ? L.rows * L.bh + (L.rows - 1) * L.gap : 0;
    if (p && L.cols && L.rows) {
      const x0 = L.rx + aw, y0 = L.ry + ah;
      if (p.restW > 0.05) {
        o.push(`<rect class="pz-waste" x="${X(x0)}" y="${Y(L.ry)}" width="${p.restW * k}" height="${(L.ph - 2 * L.ry) * k}"/>`);
        if (p.restW * k > 46) {
          const cx = X(x0 + p.restW / 2), cy = Y(L.ry + (L.ph - 2 * L.ry) / 2);
          o.push(`<text class="pz-wt" x="${cx}" y="${cy - 6}" text-anchor="middle">${esc(f(p.restW, 3))} mm</text><text class="pz-wt2" x="${cx}" y="${cy + 8}" text-anchor="middle">unused</text>`);
        }
      }
      if (p.restH > 0.05) {
        o.push(`<rect class="pz-waste" x="${X(L.rx)}" y="${Y(y0)}" width="${aw * k}" height="${p.restH * k}"/>`);
        if (p.restH * k > 16) o.push(`<text class="pz-wt" x="${X(L.rx + aw / 2)}" y="${Y(y0 + p.restH / 2) + 4}" text-anchor="middle">${esc(f(p.restH, 3))} mm unused</text>`);
      }
    }
    // boards
    for (let c = 0; c < L.cols; c++) for (let r = 0; r < L.rows; r++) {
      const x = L.rx + c * (L.bw + L.gap), y = L.ry + r * (L.bh + L.gap);
      o.push(`<rect class="pz-board${c || r ? '' : ' first'}" x="${X(x)}" y="${Y(y)}" width="${L.bw * k}" height="${L.bh * k}"/>`);
    }
    // separation
    if (L.cols && L.rows) {
      if (L.method === 'vscore') {
        for (let c = 0; c <= L.cols; c++) { const x = L.rx + c * (L.bw + L.gap) - (c === L.cols ? L.gap : 0); o.push(`<line class="pz-score" x1="${X(x)}" x2="${X(x)}" y1="${Y(0) - 5}" y2="${Y(L.ph) + 5}"/>`); }
        for (let r = 0; r <= L.rows; r++) { const y = L.ry + r * (L.bh + L.gap) - (r === L.rows ? L.gap : 0); o.push(`<line class="pz-score" x1="${X(0) - 5}" x2="${X(L.pw) + 5}" y1="${Y(y)}" y2="${Y(y)}"/>`); }
      } else if (k * 0.8 > 1.6) {
        const g = Math.max(L.gap, 0.5), dots = [];
        const dot = (x, y) => dots.push(`M${X(x) - 0.01} ${Y(y)}h0.02`);
        for (let c = 0; c < L.cols; c++) for (let r = 0; r <= L.rows; r++) {
          if ((r === 0 || r === L.rows) && L.ry <= 0) continue;
          const x = L.rx + c * (L.bw + L.gap) + L.bw / 2;
          const y = r === 0 ? L.ry - g / 2 : r === L.rows ? L.ry + ah + g / 2 : L.ry + r * (L.bh + L.gap) - L.gap / 2;
          for (let i = -2; i <= 2; i++) dot(x + i * 0.8, y);
        }
        for (let r = 0; r < L.rows; r++) for (let c = 1; c < L.cols; c++) {
          const x = L.rx + c * (L.bw + L.gap) - L.gap / 2, y = L.ry + r * (L.bh + L.gap) + L.bh / 2;
          for (let i = -2; i <= 2; i++) dot(x, y + i * 0.8);
        }
        o.push(`<path class="pz-bites" style="stroke-width:${Math.max(1.8, 0.5 * k)}" d="${dots.join('')}"/>`);
      }
    }
    // dimensions (click to type)
    const dimText = (key, x, y, text, anchor = 'middle', rot = 0) => {
      const w = text.length * 7 + 12;
      const bx = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
      return `<g class="pz-dt" data-edit="${key}" tabindex="0" role="button" aria-label="${esc(`Edit ${text}`)}"${rot ? ` transform="rotate(${rot} ${x} ${y})"` : ''}>`
        + `<rect x="${bx}" y="${y - 12}" width="${w}" height="17" rx="3"/><text x="${bx + 6}" y="${y + 1}">${esc(text)}</text></g>`;
    };
    o.push(`<path class="pz-dim" d="M${X(0)} ${Y(L.ph) + 24}H${X(L.pw)}M${X(0)} ${Y(L.ph) + 19}V${Y(L.ph) + 29}M${X(L.pw)} ${Y(L.ph) + 19}V${Y(L.ph) + 29}"/>`);
    o.push(dimText('pw', X(L.pw * 0.3), Y(L.ph) + 29, `${f(L.pw)} mm`));
    o.push(`<path class="pz-dim" d="M${X(L.pw) + 24} ${Y(0)}V${Y(L.ph)}M${X(L.pw) + 19} ${Y(0)}H${X(L.pw) + 29}M${X(L.pw) + 19} ${Y(L.ph)}H${X(L.pw) + 29}"/>`);
    o.push(dimText('ph', X(L.pw) + 28, Y(L.ph * 0.3), `${f(L.ph)} mm`, 'middle', -90));
    if (L.cols && L.rows) {
      const bx = X(L.rx), by = Y(L.ry), bwp = L.bw * k, bhp = L.bh * k;
      const lab = `${f(L.bw)} × ${f(L.bh)}`;
      if (bwp > lab.length * 7 + 22 && bhp > 26) o.push(dimText('board', bx + 5, by + 17, lab, 'start'));
      else o.push(dimText('board', bx + 2, by - 6 < Y(0) + 4 ? by + bhp + 16 : by - 6, lab, 'start'));
      if (p && p.rot && bhp > 48 && bwp > 110) o.push(`<text class="pz-note" x="${bx + 6}" y="${by + 38}">turned 90°</text>`);
    }
    // what the next column / row needs, beside the panel
    if (p && !narrow) {
      const tx = X(L.pw) + 36, lines = [];
      if (p.moreCol > 0) lines.push([`+${f(p.moreCol, 3)} mm wider`, `→ ${p.cols + 1} columns`]);
      if (p.moreRow > 0) lines.push([`+${f(p.moreRow, 3)} mm taller`, `→ ${p.rows + 1} rows`]);
      lines.forEach(([a, b], i) => { o.push(`<text class="pz-next" x="${tx}" y="${Y(0) + 14 + i * 36}">${esc(a)}</text><text class="pz-next2" x="${tx}" y="${Y(0) + 28 + i * 36}">${esc(b)}</text>`); });
      const gl = L.method === 'vscore' ? 'dashed: V-score lines' : 'dots: mouse-bite tabs';
      o.push(`<text class="pz-next2" x="${tx}" y="${Y(L.ph)}">${esc(gl)}</text>`);
    }

    // ---- handles ----
    const hd = (key, cls, label, val, inner) => `<g class="pz-h ${cls}" data-h="${key}" tabindex="0" role="slider" aria-label="${esc(label)}" aria-valuetext="${esc(val)}">${inner}</g>`;
    const PX = X(L.pw), PY = Y(L.ph);
    o.push(hd('pw', 'ew', 'Panel width', `${f(L.pw)} mm`, `<rect class="hit" x="${PX - 6}" y="${Y(0)}" width="12" height="${L.ph * k}"/><rect class="ring" x="${PX - 7}" y="${Y(L.ph / 2) - 22}" width="14" height="44" rx="4"/><rect class="grip" x="${PX - 3}" y="${Y(L.ph / 2) - 18}" width="6" height="36" rx="3"/>`));
    o.push(hd('ph', 'ns', 'Panel height', `${f(L.ph)} mm`, `<rect class="hit" x="${X(0)}" y="${PY - 6}" width="${L.pw * k}" height="12"/><rect class="ring" x="${X(L.pw / 2) - 22}" y="${PY - 7}" width="44" height="14" rx="4"/><rect class="grip" x="${X(L.pw / 2) - 18}" y="${PY - 3}" width="36" height="6" rx="3"/>`));
    o.push(hd('pc', 'nwse', 'Panel corner: width and height', `${f(L.pw)} by ${f(L.ph)} mm`, `<rect class="hit" x="${PX - 9}" y="${PY - 9}" width="18" height="18"/><rect class="ring" x="${PX - 9}" y="${PY - 9}" width="18" height="18" rx="4"/><rect class="grip sq" x="${PX - 5}" y="${PY - 5}" width="10" height="10" rx="2"/>`));
    if (L.cols && L.rows) {
      const cx = X(L.rx + L.bw), cy = Y(L.ry + L.bh);
      o.push(hd('board', 'nwse', 'First board corner: board size', `${f(L.bw)} by ${f(L.bh)} mm`, `<rect class="hit" x="${cx - 9}" y="${cy - 9}" width="18" height="18"/><rect class="ring" x="${cx - 9}" y="${cy - 9}" width="18" height="18" rx="4"/><circle class="grip board" cx="${cx}" cy="${cy}" r="5.5"/>`));
      // gap: between the first two columns (or rows)
      const gx = L.cols > 1 ? X(L.rx + L.bw + L.gap / 2) : X(L.rx + L.bw / 2);
      const gy = L.cols > 1 ? Y(L.ry + L.bh / 2) : Y(L.ry + L.bh + L.gap / 2);
      if (L.cols > 1 || L.rows > 1) {
        o.push(hd('gap', L.cols > 1 ? 'ew' : 'ns', 'Gap between boards', `${f(L.gap, 3)} mm`, `<rect class="hit" x="${gx - 9}" y="${gy - 9}" width="18" height="18"/><rect class="ring" x="${gx - 9}" y="${gy - 9}" width="18" height="18" rx="4"/><path class="grip gapd" d="M${gx} ${gy - 6}L${gx + 6} ${gy}L${gx} ${gy + 6}L${gx - 6} ${gy}Z"/>`));
        o.push(dimText('gap', gx + (L.cols > 1 ? 0 : 40), gy + (L.cols > 1 ? -16 : 4), `gap ${f(L.gap, 3)}`, L.cols > 1 ? 'middle' : 'start'));
      }
    }
    if (L.ry > 0) {
      const ry = Y(L.ry), rx0 = X(L.pw * 0.72);
      o.push(hd('rail', 'ns', 'Rail width', `${f(L.ry, 3)} mm`, `<rect class="hit" x="${X(L.rx)}" y="${ry - 5}" width="${(L.pw - 2 * L.rx) * k}" height="10"/><rect class="ring" x="${rx0 - 16}" y="${ry - 6}" width="32" height="12" rx="4"/><rect class="grip rail" x="${rx0 - 12}" y="${ry - 2.5}" width="24" height="5" rx="2.5"/>`));
      if (L.ry * k > 12) o.push(dimText('rail', rx0 - 22, Y(L.ry / 2) + 4, `rail ${f(L.ry, 3)}`, 'end'));
      else o.push(dimText('rail', rx0 - 22, Y(0) - 4, `rail ${f(L.ry, 3)}`, 'end'));
    } else if (L.rx > 0) {
      o.push(dimText('rail', X(L.rx) + 4, Y(0) - 6, `rail ${f(L.rx, 3)}`, 'start'));
    }
    const act = document.activeElement, fk = act && P.contains(act) ? (act.dataset.h ? `[data-h="${act.dataset.h}"]` : act.dataset.edit ? `[data-edit="${act.dataset.edit}"]` : null) : null;
    P.innerHTML = o.join('');
    if (drag) P.querySelector(`[data-h="${drag.key}"]`)?.classList.add('on');
    if (fk) P.querySelector(fk)?.focus({ preventScroll: true });
    geo = { k, ox, oy, L };
  }

  // ---------------- orientations ----------------
  function mini(Lx, cols, rows, bw, bh, cls) {
    const Wm = 150, Hm = 104, k = Math.min(Wm / Lx.pw, Hm / Lx.ph);
    const o = [`<svg viewBox="0 0 ${Lx.pw * k + 2} ${Lx.ph * k + 2}" class="pz-mini ${cls}" aria-hidden="true"><rect class="pz-panel" x="1" y="1" width="${Lx.pw * k}" height="${Lx.ph * k}"/>`];
    if (Lx.ry > 0) o.push(`<rect class="pz-rail" x="1" y="1" width="${Lx.pw * k}" height="${Lx.ry * k}"/><rect class="pz-rail" x="1" y="${1 + (Lx.ph - Lx.ry) * k}" width="${Lx.pw * k}" height="${Lx.ry * k}"/>`);
    if (Lx.rx > 0) o.push(`<rect class="pz-rail" x="1" y="1" width="${Lx.rx * k}" height="${Lx.ph * k}"/><rect class="pz-rail" x="${1 + (Lx.pw - Lx.rx) * k}" y="1" width="${Lx.rx * k}" height="${Lx.ph * k}"/>`);
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) o.push(`<rect class="pz-board" x="${1 + (Lx.rx + c * (bw + Lx.gap)) * k}" y="${1 + (Lx.ry + r * (bh + Lx.gap)) * k}" width="${bw * k}" height="${bh * k}"/>`);
    return o.join('') + '</svg>';
  }
  function drawOrient() {
    const res = R(), L = res.layout, p = res.plan;
    if (!L || !p) { orient.innerHTML = '<h2>Orientation</h2>'; return; }
    const cur = { cols: p.cols, rows: p.rows, bw: p.bw, bh: p.bh, n: p.n, util: p.util }, alt = p.alt;
    const asDrawn = p.rot ? alt : cur, turned = p.rot ? cur : alt;
    const cell = (o2, name, used) => `<figure class="pz-or${used ? ' used' : ''}">${mini(L, o2.cols, o2.rows, o2.bw, o2.bh, '')}<figcaption><b>${o2.n}</b> boards · <b>${esc(f(o2.util * 100, 3))}</b> %<br><span>${o2.cols} × ${o2.rows} · ${name}${used ? ' · used' : ''}</span></figcaption></figure>`;
    orient.innerHTML = `<h2>Both orientations</h2><div class="pz-ors">${cell(asDrawn, `${f(ctx.input.bw)} × ${f(ctx.input.bh)} as given`, !p.rot)}${cell(turned, 'turned 90°', p.rot)}</div>`;
  }

  // ---------------- production run ----------------
  function drawRun() {
    const res = R(), p = res.plan, L = res.layout;
    const has = p && p.panels;
    const qIn = run.querySelector('#pz-qty');
    const keep = qIn && document.activeElement === qIn;
    if (!keep) {
      run.innerHTML = `<div class="pz-runhead"><h2>Production run</h2><label for="pz-qty">boards to build</label><input id="pz-qty" class="pz-in" type="text" inputmode="decimal" spellcheck="false"></div><div class="pz-runbody"></div>`;
      const inp = run.querySelector('#pz-qty');
      inp.value = ctx.raw.qty ?? '';
      inp.addEventListener('input', () => ctx.set('qty', inp.value));
      inp.addEventListener('keydown', (e) => {
        const d = { ArrowUp: 1, ArrowDown: -1 }[e.key]; if (!d) return;
        e.preventDefault(); const v = Math.max(0, (ctx.input.qty || 0) + d * (e.shiftKey ? 1000 : 100)); inp.value = String(v); ctx.set('qty', String(v));
      });
    }
    const body = run.querySelector('.pz-runbody');
    if (!has) { body.innerHTML = `<p class="pz-muted">${p ? 'Give a quantity to see how many panels the run needs.' : ''}</p>`; return; }
    const N = p.panels, gap = 4;
    const Wb = Math.max(240, body.clientWidth || 300);
    // one mark per panel while they fit in a few rows, else one mark per 5, 10, 50 ... panels
    let gw = 26, gh = 0, per = 1, perRow = 1, G = N, rowsG = 1;
    for (const pp of [1, 5, 10, 50, 100, 500, 1000]) {
      per = pp; G = Math.ceil(N / per);
      gw = per === 1 ? 26 : 22; gh = Math.max(12, Math.min(26, gw * (L.ph / L.pw)));
      perRow = Math.max(1, Math.floor((Wb + gap) / (gw + gap)));
      rowsG = Math.ceil(G / perRow);
      if (rowsG * (gh + gap) <= 150) break;
    }
    const o = [`<svg class="pz-glyphs" viewBox="0 0 ${perRow * (gw + gap)} ${rowsG * (gh + gap)}" style="max-width:${perRow * (gw + gap)}px" role="img" aria-label="${esc(`${N} panels`)}">`];
    for (let i = 0; i < G; i++) {
      const x = (i % perRow) * (gw + gap), y = Math.floor(i / perRow) * (gh + gap);
      const last = i === G - 1;
      o.push(`<rect class="pz-gp${last && p.spare > 0 && per === 1 ? ' part' : ''}" x="${x}" y="${y}" width="${gw}" height="${gh}" rx="1.5"/>`);
      if (per > 1) {
        const cnt = last ? N - (G - 1) * per : per;
        o.push(`<rect class="pz-gb" x="${x + 2}" y="${y + 2}" width="${gw - 4}" height="${gh - 4}"/><text class="pz-gn" x="${x + gw / 2}" y="${y + gh / 2 + 3.5}" text-anchor="middle">${cnt}</text>`);
      } else if (p.cols * p.rows <= 64) {
        const cw = (gw - 4) / p.cols, ch = (gh - 4) / p.rows;
        let k2 = 0;
        for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++, k2++) {
          const empty = last && k2 >= p.n - p.spare;
          o.push(`<rect class="pz-gb${empty ? ' spare' : ''}" x="${x + 2 + c * cw + 0.3}" y="${y + 2 + r * ch + 0.3}" width="${Math.max(0.5, cw - 0.6)}" height="${Math.max(0.5, ch - 0.6)}"/>`);
        }
      }
    }
    o.push('</svg>');
    body.innerHTML = `<p class="pz-runsum"><b>${N}</b> panels${per > 1 ? ` <span class="pz-muted">(one mark = ${per} panels)</span>` : ''} · ${p.n} boards each · <b>${p.spare}</b> spare board${p.spare === 1 ? '' : 's'}${p.spare > 0 && per === 1 ? ' <span class="pz-muted">(hollow in the last panel)</span>' : ''}</p>` + o.join('');
  }

  function drawWarn() {
    const res = R();
    warn.innerHTML = (res.warnings || []).length ? `<h2>Check</h2>${res.warnings.map((w) => `<div>${esc(w)}</div>`).join('')}` : '<h2>Check</h2><div class="pz-okl">Nothing to flag for this panel.</div>';
    notes.innerHTML = `<summary>Panel rules of thumb (${(res.notes || []).length} notes)</summary>${(res.notes || []).map((n) => `<div>${esc(n)}</div>`).join('')}`;
  }

  // ---------------- interaction ----------------
  const pt = (e) => { const r = P.getBoundingClientRect(); const s = P.viewBox.baseVal.width / r.width; return { x: (e.clientX - r.left) * s, y: (e.clientY - r.top) * s }; };
  P.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || !geo) return;
    const g = e.target.closest('[data-h]');
    if (!g) return;
    e.preventDefault();
    const res = R();
    drag = { key: g.dataset.h, p0: pt(e), inp: ctx.input, L: { ...geo.L }, plan: res.plan ? { ...res.plan } : null };
    frozen = { k: geo.k };
    P.setPointerCapture(e.pointerId);
    g.focus({ preventScroll: true });
    g.classList.add('on');
  });
  P.addEventListener('pointermove', (e) => {
    if (!drag || !geo) return;
    const p = pt(e), k = geo.k, d = drag, L = d.L;
    const mx = (p.x - geo.ox) / k, my = (p.y - geo.oy) / k; // mm from the panel's top-left
    const rot = d.plan?.rot;
    switch (d.key) {
      case 'pw': setSoon({ pw: f(clamp(q(mx, 1), 5, 2000)) }); break;
      case 'ph': setSoon({ ph: f(clamp(q(my, 1), 5, 2000)) }); break;
      case 'pc': setSoon({ pw: f(clamp(q(mx, 1), 5, 2000)), ph: f(clamp(q(my, 1), 5, 2000)) }); break;
      case 'board': {
        const w = clamp(q(mx - L.rx, 0.5), 1, 2000), hh = clamp(q(my - L.ry, 0.5), 1, 2000);
        // the drawn board may be turned 90°: its width on screen is then the board height
        setSoon(rot ? { bw: f(hh), bh: f(w) } : { bw: f(w), bh: f(hh) });
        break;
      }
      case 'gap': {
        const v = L.cols > 1 ? mx - L.rx - L.bw : my - L.ry - L.bh;
        setSoon({ gap: f(clamp(q(v, 0.1), 0, 50), 3) });
        break;
      }
      case 'rail': setSoon({ rail: f(clamp(q(my, 0.5), 0, 50), 3) }); break;
    }
  });
  const end = () => {
    if (!drag) return;
    drag = null; frozen = null;
    requestAnimationFrame(drawAll);
  };
  P.addEventListener('pointerup', end);
  P.addEventListener('pointercancel', end);
  P.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.dataset?.edit && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openEdit(t); return; }
    if (!t.dataset?.h) return;
    const dirs = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dirs[e.key]; if (!d) return;
    e.preventDefault();
    const inp = ctx.input, res = R(), L = res.layout || {}, rot = res.plan?.rot, m = e.shiftKey ? 10 : 1;
    const dx = d[0], dy = d[1];
    switch (t.dataset.h) {
      case 'pw': ctx.set('pw', f(Math.max(5, inp.pw + (dx || -dy) * m))); break;
      case 'ph': ctx.set('ph', f(Math.max(5, inp.ph + (dy || dx) * m))); break;
      case 'pc': ctx.setMany({ pw: f(Math.max(5, inp.pw + dx * m)), ph: f(Math.max(5, inp.ph + dy * m)) }); break;
      case 'board': {
        const st = 0.5 * m;
        const w = Math.max(1, L.bw + dx * st), hh = Math.max(1, L.bh + dy * st);
        ctx.setMany(rot ? { bw: f(hh), bh: f(w) } : { bw: f(w), bh: f(hh) });
        break;
      }
      case 'gap': ctx.set('gap', f(Math.max(0, (L.gap || 0) + (dx || -dy) * 0.1 * m), 3)); break;
      case 'rail': ctx.set('rail', f(Math.max(0, (L.ry || L.rx || 0) + (dy || dx) * 0.5 * m), 3)); break;
    }
  });
  P.addEventListener('click', (e) => { const g = e.target.closest('[data-edit]'); if (g) openEdit(g); });

  // Type a dimension in place.
  function openEdit(g) {
    if (editing) return;
    const key = g.dataset.edit, raw = ctx.raw, res = R();
    const val = key === 'board' ? `${raw.bw} x ${raw.bh}` : key === 'gap' ? String(raw.gap !== '' && raw.gap != null ? raw.gap : f(res.layout?.gap ?? 0, 3)) : String(raw[key] ?? '');
    const r = g.getBoundingClientRect(), br = pBox.getBoundingClientRect();
    const box = h('input', { class: 'pz-in pz-edit', type: 'text', spellcheck: 'false', 'aria-label': { pw: 'Panel width, mm', ph: 'Panel height, mm', board: 'Board width x height, mm', gap: 'Gap between boards, mm', rail: 'Rail width, mm' }[key] });
    box.value = val;
    box.style.left = `${clamp(r.left - br.left - 6, 0, br.width - 120)}px`;
    box.style.top = `${r.top - br.top - 4}px`;
    pBox.append(box);
    editing = box;
    box.focus(); box.select();
    const done = (ok) => {
      if (editing !== box) return;
      editing = null; box.remove();
      if (ok) {
        const v = box.value.trim();
        if (key === 'board') {
          const m = /^\s*([\d.,]+)\s*[x×*\s]\s*([\d.,]+)\s*$/i.exec(v);
          if (m) ctx.setMany({ bw: m[1].replace(',', '.'), bh: m[2].replace(',', '.') });
        } else ctx.set(key, v);
      }
      requestAnimationFrame(() => P.querySelector(`[data-edit="${key}"]`)?.focus({ preventScroll: true }));
    };
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') { e.preventDefault(); done(false); } });
    box.addEventListener('blur', () => done(true));
  }

  function drawAll() { drawHead(); drawPlan(); drawOrient(); drawRun(); drawWarn(); }
  ctx.onResult(() => { if (drag) { drawHead(); drawPlan(); drawRun(); drawWarn(); } else drawAll(); });
  let lastW = 0;
  new ResizeObserver(() => {
    const w = grid.clientWidth;
    if (drag || Math.abs(w - lastW) < 2) return;
    lastW = w;
    requestAnimationFrame(() => { drawPlan(); drawRun(); });
  }).observe(grid);
}
