// Mounting Hole Planner page: the hole in the board is the interface.
//   - a drill plate across the top: every screw's clearance hole to scale;
//     click one (or arrow keys) to pick the screw;
//   - the board corner, top view to scale: drag the hole to place it (the
//     minimum edge distance is the shaded strip it must stay out of), drag the
//     knobs on the copper and part keep-out rings to set their margins;
//   - the section through the joint, to scale: pick the head and standoff,
//     click the washer on or off, drag the board's bottom face (thickness) and
//     the standoff's side (its size).
// Every number shown comes from tool.js run() (result.drawing / values).

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, html) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  if (html != null) e.innerHTML = html;
  return e;
};
const svgEl = (cls, label) => {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('class', cls); s.setAttribute('role', 'group'); s.setAttribute('aria-label', label);
  return s;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const f3 = (v) => String(Number(Number(v).toPrecision(3)));
const mm = (v) => String(Math.round(v * 100) / 100);
function niceStep(span, target) {
  const raw = span / target, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
const hexPts = (cx, cy, rAC) => Array.from({ length: 6 }, (_, i) => {
  const a = (Math.PI / 3) * i;
  return `${(cx + rAC * Math.cos(a)).toFixed(1)},${(cy + rAC * Math.sin(a)).toFixed(1)}`;
}).join(' ');

const HEADS = [['pan', 'Pan'], ['socket', 'Socket'], ['button', 'Button'], ['none', 'None']];
const STANDOFFS = [['hex', 'Hex'], ['round', 'Round'], ['none', 'None']];
const FITS = [['fine', 'Close'], ['medium', 'Normal'], ['coarse', 'Loose']];

// small silhouettes for the choosers
const headIcon = (k) => {
  const body = k === 'pan' ? '<path d="M5 13 Q5 5 17 5 Q29 5 29 13 Z"/>'
    : k === 'socket' ? '<rect x="9" y="3" width="16" height="10" rx="1"/><rect class="cut" x="14" y="3" width="6" height="4"/>'
      : k === 'button' ? '<path d="M4 13 Q8 7 17 7 Q26 7 30 13 Z"/>' : '<path class="none" d="M8 13H26" />';
  return `<svg viewBox="0 0 34 26" aria-hidden="true">${body}<rect x="14" y="13" width="6" height="11"/></svg>`;
};
const soIcon = (k) => {
  const body = k === 'hex' ? '<rect x="8" y="10" width="18" height="14"/><path class="ln" d="M13 10V24M21 10V24"/>'
    : k === 'round' ? '<rect x="8" y="10" width="18" height="14" rx="2"/>' : '<path class="none" d="M8 17H26"/>';
  return `<svg viewBox="0 0 34 26" aria-hidden="true"><rect class="brd" x="1" y="6" width="32" height="4"/>${body}</svg>`;
};

export function page(root, ctx) {
  // ---------------- DOM ----------------
  const seg = (name, items, key, iconFn) => {
    const g = el('div', { class: 'mh-seg', role: 'radiogroup', 'aria-label': name });
    for (const [v, t] of items) {
      const b = el('button', { role: 'radio', 'data-v': v, title: `${name}: ${t}` }, `${iconFn ? iconFn(v) : ''}<span>${esc(t)}</span>`);
      b.addEventListener('click', () => ctx.set(key, v));
      b.addEventListener('keydown', (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!d) return;
        e.preventDefault();
        const i = items.findIndex((x) => x[0] === v), n = items[(i + d + items.length) % items.length][0];
        ctx.set(key, n);
        g.querySelector(`[data-v="${n}"]`).focus();
      });
      g.append(b);
    }
    g.sync = (cur) => { for (const b of g.children) { const on = b.dataset.v === cur; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; } };
    return g;
  };

  // drill plate
  const plate = el('section', { class: 'mh-card mh-plate' });
  const plHead = el('div', { class: 'mh-head' });
  const fitSeg = seg('Clearance', FITS, 'fit');
  const platSeg = seg('Hole', [['npth', 'NPTH'], ['pth', 'Plated']], 'plated');
  plHead.append(el('h2', {}, 'Screw'), el('span', { class: 'mh-hint' }, 'clearance holes to scale · click one'), el('span', { class: 'mh-sp' }),
    el('span', { class: 'mh-lbl' }, 'Clearance'), fitSeg, el('span', { class: 'mh-lbl' }, 'Hole'), platSeg);
  const plBox = el('div', { class: 'mh-box mh-plate-box' });
  const psv = svgEl('mh-svg', 'Screw sizes: clearance holes to scale');
  psv.setAttribute('role', 'radiogroup');
  plBox.append(psv); plate.append(plHead, plBox);

  // board corner
  const top = el('section', { class: 'mh-card mh-top' });
  const tHead = el('div', { class: 'mh-head' });
  const clearBtn = el('button', { class: 'mh-btn', hidden: true }, 'Unplace');
  clearBtn.addEventListener('click', () => ctx.setMany({ ex: '', ey: '' }));
  tHead.append(el('h2', {}, 'Board corner, top view'), el('span', { class: 'mh-hint' }, 'drag the hole or a ring knob · arrow keys when focused'), el('span', { class: 'mh-sp' }), clearBtn);
  const tBox = el('div', { class: 'mh-box mh-top-box' });
  const tsv = svgEl('mh-svg', 'Board corner with the hole and its keep-out rings, to scale');
  tBox.append(tsv); top.append(tHead, tBox);

  // section
  const sec = el('section', { class: 'mh-card mh-sec' });
  const sHead = el('div', { class: 'mh-head' });
  sHead.append(el('h2', {}, 'Section through the joint'), el('span', { class: 'mh-hint' }, 'click the washer · drag the board face or standoff side'));
  const headSeg = seg('Head', HEADS, 'head', headIcon);
  const soSeg = seg('Standoff', STANDOFFS, 'standoff', soIcon);
  const hRow = el('div', { class: 'mh-row' }); hRow.append(el('span', { class: 'mh-lbl' }, 'Head'), headSeg);
  const sRow = el('div', { class: 'mh-row' }); sRow.append(el('span', { class: 'mh-lbl' }, 'Standoff'), soSeg);
  const sBox = el('div', { class: 'mh-box mh-sec-box' });
  const ssv = svgEl('mh-svg', 'Section through head, washer, board and standoff, to scale');
  sBox.append(ssv); sec.append(sHead, hRow, sBox, sRow);

  // side
  const side = el('aside', { class: 'mh-side' });
  const fp = el('section', { class: 'mh-card mh-fp', 'aria-live': 'polite' });
  const warnsEl = el('div', { class: 'mh-warns', role: 'status' });
  const all = el('details', { class: 'mh-card mh-all' });
  all.append(el('summary', {}, 'All inputs as fields'), ctx.form);
  const notesEl = el('details', { class: 'mh-notes' });
  side.append(fp, warnsEl, all, ctx.outputs, notesEl);

  const grid = el('div', { class: 'mh' });
  grid.append(plate, top, sec, side);
  root.append(grid);

  // ---------------- state ----------------
  let drag = null, pending = null, view = null, lastGood = null;
  const geo = {};
  const D = () => ctx.result?.drawing || lastGood;
  function setSoon(obj) {
    const first = !pending;
    pending = { ...(pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = pending; pending = null; ctx.setMany(p); });
  }
  const toSvg = (svg, e) => {
    const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    return { x: (e.clientX - r.left) * (vb.width / r.width), y: (e.clientY - r.top) * (vb.height / r.height) };
  };
  const keepFocus = (svg, html) => {
    const a = document.activeElement;
    const k = a && svg.contains(a) ? a.dataset.h : null;
    svg.innerHTML = html;
    if (drag?.svg === svg) svg.querySelector(`[data-h="${drag.h}"]`)?.classList.add('on');
    if (k) svg.querySelector(`[data-h="${k}"]`)?.focus({ preventScroll: true });
  };
  const handle = (key, cls, label, now, inner, role = 'slider') =>
    `<g class="mh-h ${cls}" data-h="${key}" tabindex="0" role="${role}" aria-label="${esc(label)}"${now != null ? ` aria-valuetext="${esc(now)}"` : ''}>${inner}</g>`;
  const wmark = (x, y, text) => `<g class="wmark"><title>${esc(text)}</title><circle cx="${x}" cy="${y}" r="7.5"/><text x="${x}" y="${y + 4}" text-anchor="middle">!</text></g>`;
  const warnAbout = (re) => (ctx.result?.warnings || []).filter((w) => re.test(w)).join(' ');

  // ================= drill plate =================
  function drawPlate() {
    const d = D(), inp = ctx.input;
    const Wp = Math.max(300, plBox.clientWidth), Hp = Math.max(84, plBox.clientHeight);
    psv.setAttribute('viewBox', `0 0 ${Wp} ${Hp}`);
    if (!d) { psv.innerHTML = ''; return; }
    const list = d.screws, n = list.length;
    const pitch = (Wp - 20) / n;
    const maxD = Math.max(...list.map((s) => s.drill));
    const k = Math.min((Hp - 40) / maxD, (pitch - 12) / maxD, 9);
    const o = [];
    o.push(`<rect class="plate" x="4" y="4" width="${Wp - 8}" height="${Hp - 8}" rx="6"/>`);
    const cy = 8 + (maxD * k) / 2 + 4;
    list.forEach((s, i) => {
      const cx = 10 + pitch * (i + 0.5);
      const on = s.screw === d.screw;
      const inch = s.screw.startsWith('#');
      o.push(handle(`scr-${i}`, `pick${on ? ' sel' : ''}`, `Screw ${s.screw}, clearance hole ${f3(s.drill)} mm`, null,
        `<rect class="hit" x="${cx - pitch / 2 + 2}" y="6" width="${pitch - 4}" height="${Hp - 12}" rx="4"/>`
        + `<rect class="ring" x="${cx - pitch / 2 + 3}" y="7" width="${pitch - 6}" height="${Hp - 14}" rx="4"/>`
        + `<circle class="hole" cx="${cx}" cy="${cy}" r="${(s.drill * k) / 2}"/>`
        + `<circle class="thr" cx="${cx}" cy="${cy}" r="${(s.nominal * k) / 2}"/>`
        + `<text class="nm${inch ? ' inch' : ''}${pitch < 48 ? ' tight' : ''}" x="${cx}" y="${Hp - 22}" text-anchor="middle">${esc(s.screw)}</text>`
        + (pitch >= 48 || on ? `<text class="dr" x="${cx}" y="${Hp - 10}" text-anchor="middle">Ø${esc(f3(s.drill))}</text>` : ''), 'radio').replace('role="radio"', `role="radio" aria-checked="${on}"`));
    });
    keepFocus(psv, o.join(''));
    void inp;
  }
  psv.addEventListener('click', (e) => {
    const h = e.target.closest('[data-h^="scr-"]');
    const d = D();
    if (h && d) ctx.set('screw', d.screws[Number(h.dataset.h.slice(4))].screw);
  });
  psv.addEventListener('keydown', (e) => {
    const h = e.target.closest('[data-h^="scr-"]'), d = D();
    if (!h || !d) return;
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.set('screw', d.screws[Number(h.dataset.h.slice(4))].screw); return; }
    if (!dir) return;
    e.preventDefault();
    const i = clamp(d.screws.findIndex((s) => s.screw === d.screw) + dir, 0, d.screws.length - 1);
    ctx.set('screw', d.screws[i].screw);
    requestAnimationFrame(() => psv.querySelector(`[data-h="scr-${i}"]`)?.focus());
  });

  // ================= board corner =================
  function drawTop() {
    const d = D(), raw = ctx.raw;
    const Wp = Math.max(280, tBox.clientWidth), Hp = Math.max(260, tBox.clientHeight);
    tsv.setAttribute('viewBox', `0 0 ${Wp} ${Hp}`);
    if (!d) { tsv.innerHTML = ''; return; }
    const placed = d.ex != null || d.ey != null;
    const hx = d.ex ?? d.edge, hy = d.ey ?? d.edge;
    const narrow = Wp < 520;
    const calW = narrow ? 0 : Math.min(210, Wp * 0.34); // callout column
    // mm window: from -m (off board) to the hole plus its part keep-out
    if (!drag || drag.svg !== tsv || !view) {
      const reach = Math.max(hx, hy) + d.partKeep / 2 + Math.max(3.5, d.partKeep * 0.6);
      const m = Math.max(1.5, reach * 0.1, d.partKeep / 2 - Math.min(hx, hy) + 1);
      const span = reach + m;
      const k = Math.min((Wp - calW - 16) / span, (Hp - 16) / span);
      view = { m, k, x0: 10 + m * k, y0: 10 + m * k };
    }
    const { k, x0, y0 } = view;
    const X = (v) => x0 + v * k, Y = (v) => y0 + v * k;
    const cx = X(hx), cy = Y(hy);
    const r = (dia) => (dia / 2) * k;
    const o = [];
    const bad = d.tooClose;
    // off-board, board, copper pour with its keep-out cut
    o.push(`<rect class="off" x="0" y="0" width="${Wp}" height="${Hp}"/>`);
    o.push(`<rect class="board" x="${X(0)}" y="${Y(0)}" width="${Wp}" height="${Hp}"/>`);
    const pi = 0.3 * k; // pour pulled back from the board edge
    o.push(`<path class="pour" fill-rule="evenodd" d="M${X(0) + pi} ${Y(0) + pi}H${Wp}V${Hp}H${X(0) + pi}Z M${cx + r(d.cuKeep)} ${cy}a${r(d.cuKeep)} ${r(d.cuKeep)} 0 1 0 ${-2 * r(d.cuKeep)} 0a${r(d.cuKeep)} ${r(d.cuKeep)} 0 1 0 ${2 * r(d.cuKeep)} 0Z"/>`);
    // mm grid on the board
    const gs = niceStep(Wp / k, 8);
    const g = [];
    for (let v = gs; X(v) < Wp; v += gs) g.push(`M${X(v)} ${Y(0)}V${Hp}`);
    for (let v = gs; Y(v) < Hp; v += gs) g.push(`M${X(0)} ${Y(v)}H${Wp}`);
    o.push(`<path class="grid" d="${g.join('')}"/>`);
    // no-go strip: closer to an edge than the minimum distance
    const e = d.edge * k;
    o.push(`<defs><pattern id="mh-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" class="nogo-bg"/><line x1="0" y1="0" x2="0" y2="7" class="nogo-ln"/></pattern></defs>`);
    o.push(`<path class="nogo" fill="url(#mh-hatch)" d="M${X(0)} ${Y(0)}H${Wp}V${Y(0) + e}H${X(0) + e}V${Hp}H${X(0)}Z"/>`);
    o.push(`<path class="nogol" d="M${X(0) + e} ${Hp}V${Y(0) + e}H${Wp}"/>`);
    o.push(`<text class="lbl warnt halo" x="${X(0) + e + 6}" y="${Hp - 34}">◂ min. edge distance ${esc(f3(d.edge))} mm</text>`);
    // board edges
    o.push(`<path class="edge" d="M${X(0)} ${Hp}V${Y(0)}H${Wp}"/>`);
    o.push(`<text class="lbl soft" x="${X(0) + 4}" y="${Y(0) - 5}">board edge</text>`);
    // rings
    o.push(`<circle class="partk${bad ? ' bad' : ''}" cx="${cx}" cy="${cy}" r="${r(d.partKeep)}"/>`);
    o.push(`<circle class="cuk" cx="${cx}" cy="${cy}" r="${r(d.cuKeep)}"/>`);
    if (d.standoff > 0) {
      o.push(d.standoffShape === 'hex' ? `<polygon class="metal under" points="${hexPts(cx, cy, r(d.standoff))}"/>` : `<circle class="metal under" cx="${cx}" cy="${cy}" r="${r(d.standoff)}"/>`);
    }
    if (d.plated) o.push(`<circle class="pad" cx="${cx}" cy="${cy}" r="${r(d.pad)}"/>`);
    if (d.headD > 0) o.push(`<circle class="metal" cx="${cx}" cy="${cy}" r="${r(d.headD)}"/>`);
    o.push(`<circle class="drill" cx="${cx}" cy="${cy}" r="${r(d.drill)}"/>`);
    // dimensions from the edges
    const dimH = (y, x1, x2, txt, cls) => `<path class="dim ${cls}" d="M${x1} ${y}H${x2}M${x1} ${y - 4}V${y + 4}M${x2 - 5} ${y - 3}L${x2} ${y}L${x2 - 5} ${y + 3}"/>`
      + `<text class="dimt halo ${cls}" x="${(x1 + x2) / 2}" y="${y - 5}" text-anchor="middle">${esc(txt)}</text>`;
    const dimV = (x, y1, y2, txt, cls) => `<path class="dim ${cls}" d="M${x} ${y1}V${y2}M${x - 4} ${y1}H${x + 4}M${x - 3} ${y2 - 5}L${x} ${y2}L${x + 3} ${y2 - 5}"/>`
      + `<text class="dimt halo ${cls}" x="${x + 6}" y="${(y1 + y2) / 2 + 4}">${esc(txt)}</text>`;
    const xBad = d.ex != null && d.ex < d.edge - 1e-9, yBad = d.ey != null && d.ey < d.edge - 1e-9;
    o.push(dimH(cy + Math.max(r(d.partKeep), 14) + 14, X(0), cx, `${mm(hx)} mm`, xBad ? 'bad' : ''));
    o.push(dimV(cx + Math.max(r(d.partKeep), 14) + 14, Y(0), cy, `${mm(hy)} mm`, yBad ? 'bad' : ''));
    if (xBad) o.push(wmark(X(0) + 12, cy - r(d.partKeep) - 12, warnAbout(/closer than/)));
    if (yBad) o.push(wmark(cx - r(d.partKeep) - 12, Y(0) + 12, warnAbout(/closer than/)));
    // callouts
    const rings = [
      [d.partKeep, 'Part keep-out', 'partk-t', 'courtyard, both sides'],
      [d.cuKeep, 'Copper keep-out', 'cuk-t', 'all layers'],
      d.plated ? [d.pad, 'Pad', 'pad-t', 'plated, to GND'] : null,
      d.headD > 0 ? [d.headD, d.washer ? 'Washer' : 'Head', 'metal-t', 'top side'] : null,
      d.standoff > 0 ? [d.standoff, d.standoffShape === 'hex' ? 'Standoff AC' : 'Standoff', 'metal-t', 'bottom side'] : null,
      [d.drill, 'Drill', 'drill-t', d.plated ? 'finished' : 'non-plated'],
    ].filter(Boolean);
    if (!narrow) {
      const xc = Wp - calW + 14;
      const y1 = Math.max(24, cy - rings.length * 19), step = 38;
      rings.forEach(([dia, name, cls, hint], i) => {
        const y = clamp(y1 + i * step, 22, Hp - 20);
        const a = -0.9 + i * 0.32;
        const rx = cx + r(dia) * Math.cos(a), ry = cy + r(dia) * Math.sin(a);
        o.push(`<path class="leader" d="M${rx} ${ry}L${xc - 8} ${y - 4}H${xc - 3}"/><circle class="ldot" cx="${rx}" cy="${ry}" r="2"/>`);
        o.push(`<text class="cname ${cls}" x="${xc}" y="${y}">${esc(name)} <tspan class="cval">Ø ${esc(f3(dia))}</tspan></text><text class="chint" x="${xc}" y="${y + 13}">${esc(hint)}</text>`);
      });
    }
    // handles: the ring knobs and the hole
    const knob = (key, dia, ang, label, now) => {
      const kx = cx + r(dia) * Math.cos(ang), ky = cy + r(dia) * Math.sin(ang);
      return handle(key, 'rad', label, now, `<circle class="hit" cx="${kx}" cy="${ky}" r="11"/><circle class="ring" cx="${kx}" cy="${ky}" r="9"/><circle class="knob" cx="${kx}" cy="${ky}" r="5"/>`);
    };
    o.push(knob('tool', d.partKeep, Math.PI * 0.25, 'Part keep-out: tool and part margin, mm', `${raw.tool} mm margin`));
    o.push(knob('cu', d.cuKeep, Math.PI * 0.62, 'Copper keep-out: clearance to other copper, mm', `${raw.cu} mm clearance`));
    const hr = Math.max(r(d.drill), 9);
    o.push(handle('hole', 'xy', 'Hole position from the two board edges, mm', `${mm(hx)} by ${mm(hy)} mm`,
      `<circle class="hit" cx="${cx}" cy="${cy}" r="${hr + 4}"/><circle class="ring" cx="${cx}" cy="${cy}" r="${hr + 2}"/><path class="cross" d="M${cx - hr - 5} ${cy}H${cx + hr + 5}M${cx} ${cy - hr - 5}V${cy + hr + 5}"/>`));
    if (!placed) o.push(`<text class="lbl hintt halo" x="${cx}" y="${cy + r(d.partKeep) + 44}" text-anchor="middle">at the minimum distance · drag to place it</text>`);
    // scale bar
    const sb = niceStep(60 / k, 1);
    o.push(`<path class="scale" d="M${Wp - calW - 14 - sb * k} ${Hp - 12}h${sb * k}M${Wp - calW - 14 - sb * k} ${Hp - 16}v8M${Wp - calW - 14} ${Hp - 16}v8"/><text class="lbl" x="${Wp - calW - 18 - sb * k}" y="${Hp - 8}" text-anchor="end">${sb} mm · to scale</text>`);
    keepFocus(tsv, o.join(''));
    geo.top = { k, x0, y0, cx, cy };
    clearBtn.hidden = !placed;
  }

  // ================= section =================
  function drawSec() {
    const d = D(), raw = ctx.raw;
    const Wp = Math.max(260, sBox.clientWidth), Hp = Math.max(240, sBox.clientHeight);
    ssv.setAttribute('viewBox', `0 0 ${Wp} ${Hp}`);
    if (!d) { ssv.innerHTML = ''; return; }
    const nd = d.d;
    const hh = d.head === 'socket' ? nd : d.head === 'button' ? 0.55 * nd : d.head === 'pan' ? 0.62 * nd : 0;
    const wt = d.washer ? Math.max(0.3, 0.17 * nd) : 0;
    const soH = d.standoffShape !== 'none' ? Math.max(3 * nd, 6) : 0;
    const shankBelow = soH ? soH * 0.75 : 2.2 * nd;
    const stackH = hh + wt + d.t + Math.max(soH, shankBelow);
    const widest = Math.max(d.partKeep, d.standoff, d.headD);
    if (!drag || drag.svg !== ssv || !geo.secK) geo.secK = Math.min((Wp - 60) / (widest * (Wp < 420 ? 1.5 : 1.25)), (Hp - 120) / (stackH + 1));
    const k = geo.secK;
    const cx = Wp / 2;
    const yTop = 76; // room for the stacked dimensions above
    const yH = yTop + (d.head === 'none' ? 0 : 0);
    const yW = yH + hh * k;               // washer top / under the head
    const yB = yW + wt * k;               // board top
    const yB2 = yB + d.t * k;             // board bottom
    const yS2 = yB2 + soH * k;            // standoff bottom
    const W = (v) => (v / 2) * k;
    const o = [];
    // keep-out bands on both faces of the board
    const band = (dia, cls) => `<rect class="${cls}" x="${cx - W(dia)}" y="${yB - 5}" width="${2 * W(dia)}" height="5"/><rect class="${cls}" x="${cx - W(dia)}" y="${yB2}" width="${2 * W(dia)}" height="5"/>`;
    // board, cut: hatched, with the clearance hole
    const bx0 = 8, bx1 = Wp - 8;
    o.push(`<rect class="bsec" x="${bx0}" y="${yB}" width="${cx - W(d.drill) - bx0}" height="${yB2 - yB}"/><rect class="bsec" x="${cx + W(d.drill)}" y="${yB}" width="${bx1 - cx - W(d.drill)}" height="${yB2 - yB}"/>`);
    o.push(band(d.partKeep, 'kb-part'), band(d.cuKeep, 'kb-cu'));
    // copper layers outside the keep-out; pad and barrel when plated
    const cuT = Math.max(1.5, 0.035 * k);
    o.push(`<rect class="cu" x="${bx0}" y="${yB - cuT}" width="${cx - W(d.cuKeep) - bx0}" height="${cuT}"/><rect class="cu" x="${cx + W(d.cuKeep)}" y="${yB - cuT}" width="${bx1 - cx - W(d.cuKeep)}" height="${cuT}"/>`);
    o.push(`<rect class="cu" x="${bx0}" y="${yB2}" width="${cx - W(d.cuKeep) - bx0}" height="${cuT}"/><rect class="cu" x="${cx + W(d.cuKeep)}" y="${yB2}" width="${bx1 - cx - W(d.cuKeep)}" height="${cuT}"/>`);
    if (d.plated) {
      o.push(`<rect class="cu pad" x="${cx - W(d.pad)}" y="${yB - cuT}" width="${2 * W(d.pad)}" height="${cuT}"/><rect class="cu pad" x="${cx - W(d.pad)}" y="${yB2}" width="${2 * W(d.pad)}" height="${cuT}"/>`);
      o.push(`<rect class="cu pad" x="${cx - W(d.drill) - cuT}" y="${yB}" width="${cuT}" height="${yB2 - yB}"/><rect class="cu pad" x="${cx + W(d.drill)}" y="${yB}" width="${cuT}" height="${yB2 - yB}"/>`);
    }
    // standoff
    if (soH) {
      const sw = W(d.standoff);
      o.push(`<rect class="steel" x="${cx - sw}" y="${yB2 + (d.plated ? cuT : 0)}" width="${2 * sw}" height="${soH * k}" ${d.standoffShape === 'round' ? 'rx="2"' : ''}/>`);
      if (d.standoffShape === 'hex') o.push(`<path class="hexln" d="M${cx - sw / 2} ${yB2}V${yS2}M${cx + sw / 2} ${yB2}V${yS2}"/>`);
      o.push(`<rect class="bore" x="${cx - W(nd)}" y="${yB2}" width="${2 * W(nd)}" height="${soH * k * 0.8}"/>`);
      o.push(`<path class="brk" d="M${cx - sw - 6} ${yS2 + 4}l8 -6l8 8l8 -8l8 8l8 -6"/>`);
    }
    // screw shank
    const shankEnd = soH ? yB2 + soH * k * 0.75 : yB2 + shankBelow * k;
    o.push(`<rect class="steel shank" x="${cx - W(nd)}" y="${yW}" width="${2 * W(nd)}" height="${shankEnd - yW}"/>`);
    const th = [];
    for (let y = yB2 + 3; y < shankEnd - 2; y += Math.max(3, 0.5 * k)) th.push(`M${cx - W(nd)} ${y}l${2 * W(nd)} 2`);
    o.push(`<path class="thread" d="${th.join('')}"/>`);
    // head
    if (d.head !== 'none') {
      const hw = W(d.headOnly), yh0 = yW - hh * k;
      if (d.head === 'pan') o.push(`<path class="steel" d="M${cx - hw} ${yW}V${yh0 + hh * k * 0.45}Q${cx - hw} ${yh0} ${cx - hw * 0.55} ${yh0}H${cx + hw * 0.55}Q${cx + hw} ${yh0} ${cx + hw} ${yh0 + hh * k * 0.45}V${yW}Z"/>`);
      else if (d.head === 'socket') o.push(`<rect class="steel" x="${cx - hw}" y="${yh0}" width="${2 * hw}" height="${hh * k}" rx="2"/><rect class="bore" x="${cx - hw * 0.45}" y="${yh0}" width="${hw * 0.9}" height="${hh * k * 0.55}"/>`);
      else o.push(`<path class="steel" d="M${cx - hw} ${yW}Q${cx - hw * 0.8} ${yh0} ${cx} ${yh0}Q${cx + hw * 0.8} ${yh0} ${cx + hw} ${yW}Z"/>`);
    } else {
      o.push(`<text class="lbl soft" x="${cx}" y="${yW - 8}" text-anchor="middle">no head on this side</text>`);
    }
    // washer: click to toggle (ghost when off)
    const wsh = d.washer || 0;
    const ghostW = W(Math.max(d.headOnly || nd * 2, nd * 2) * 1.2);
    o.push(handle('washer', 'tog', d.washer ? 'Washer under the head: on (click to remove)' : 'Washer under the head: off (click to add)', null,
      d.washer
        ? `<rect class="steel wsh" x="${cx - W(wsh)}" y="${yW}" width="${2 * W(wsh)}" height="${wt * k}"/><rect class="ring" x="${cx - W(wsh) - 3}" y="${yW - 3}" width="${2 * W(wsh) + 6}" height="${wt * k + 6}" rx="2"/>`
        : `<rect class="ghost" x="${cx - ghostW}" y="${yB - 9}" width="${2 * ghostW}" height="8" rx="1"/><rect class="ring" x="${cx - ghostW - 3}" y="${yB - 12}" width="${2 * ghostW + 6}" height="14" rx="2"/><text class="gtxt" x="${cx + ghostW + 6}" y="${yB - 2}">+ washer</text>`, 'button'));
    // stacked dimensions above: part keep-out, copper keep-out, head/washer
    const dimAbove = (dia, y, txt, cls) => {
      const a = cx - W(dia), b = cx + W(dia);
      return `<path class="ext" d="M${a} ${y + 4}V${yB - 6}M${b} ${y + 4}V${yB - 6}"/><path class="dim ${cls}" d="M${a} ${y}H${b}M${a} ${y - 4}V${y + 4}M${b} ${y - 4}V${y + 4}"/><text class="dimt halo ${cls}" x="${cx}" y="${y - 5}" text-anchor="middle">${esc(txt)}</text>`;
    };
    o.push(dimAbove(d.partKeep, 20, `part keep-out Ø ${f3(d.partKeep)}`, 'pk'));
    o.push(dimAbove(d.cuKeep, 42, `copper keep-out Ø ${f3(d.cuKeep)}`, 'ck'));
    if (d.headD > 0) o.push(dimAbove(d.headD, 64, `${d.washer ? 'washer' : 'head'} Ø ${f3(d.headD)}`, ''));
    // side dims: board thickness and drill, standoff
    const xr = Math.min(Wp - 50, cx + W(Math.max(d.partKeep, d.standoff)) + 16);
    o.push(`<path class="dim" d="M${xr} ${yB}V${yB2}M${xr - 4} ${yB}H${xr + 4}M${xr - 4} ${yB2}H${xr + 4}"/><text class="dimt" x="${xr + 6}" y="${(yB + yB2) / 2 + 4}">t ${esc(f3(d.t))}</text>`);
    const yDr = yB2 + (soH ? soH * k + 14 : shankBelow * k + 12);
    o.push(`<path class="dim" d="M${cx - W(d.drill)} ${yDr}H${cx + W(d.drill)}M${cx - W(d.drill)} ${yDr - 4}V${yDr + 4}M${cx + W(d.drill)} ${yDr - 4}V${yDr + 4}"/><text class="dimt" x="${cx}" y="${yDr + 17}" text-anchor="middle">drill Ø ${esc(f3(d.drill))} · ${esc(d.screw)} ${esc(d.fit)}</text>`);
    if (soH) {
      const st = d.standoffShape === 'hex' ? `AF ${f3(d.standoffAF)} · AC ${f3(d.standoff)}` : `Ø ${f3(d.standoff)}`;
      const fitsR = cx + W(d.standoff) + 8 + st.length * 7 < Wp;
      o.push(`<text class="dimt halo" x="${fitsR ? cx + W(d.standoff) + 6 : cx}" y="${yB2 + soH * k * (fitsR ? 0.55 : 0.97)}" text-anchor="${fitsR ? 'start' : 'middle'}">${esc(st)}</text>`);
    }
    // labels
    o.push(`<text class="lbl soft" x="${bx1 - 4}" y="${yB2 + 16}" text-anchor="end">board, section</text>`);
    // handles: board bottom face (t), standoff side (size)
    o.push(handle('t', 'ns', 'Board thickness, mm', `${raw.t} mm`,
      `<rect class="hit" x="${bx0}" y="${yB2 - 5}" width="${cx - W(d.cuKeep) - bx0 - 4}" height="10"/><rect class="ring" x="${bx0 + 12}" y="${yB2 - 6}" width="44" height="12" rx="3"/><rect class="grip" x="${bx0 + 16}" y="${yB2 - 2}" width="36" height="4" rx="2"/>`));
    if (soH) {
      const sx = cx - W(d.standoff);
      o.push(handle('sd', 'ew', 'Standoff size (across flats or diameter), mm', `${raw.sd || f3(d.standoffAF)} mm`,
        `<rect class="hit" x="${sx - 6}" y="${yB2 + 4}" width="12" height="${soH * k - 8}"/><rect class="ring" x="${sx - 5}" y="${yB2 + 6}" width="10" height="${soH * k - 12}" rx="3"/><rect class="grip" x="${sx - 1.5}" y="${yB2 + soH * k * 0.3}" width="3" height="${soH * k * 0.4}" rx="1.5"/>`));
    }
    if (/standoff is not bigger/.test(warnAbout(/./))) o.push(wmark(cx - W(d.standoff) - 14, yB2 + 14, warnAbout(/standoff is not bigger/)));
    if (/annular ring/.test(warnAbout(/./))) o.push(wmark(cx + W(d.pad) + 12, yB - 12, warnAbout(/annular ring/)));
    keepFocus(ssv, o.join(''));
    geo.sec = { k, cx, yB };
  }

  // ================= footprint card =================
  function drawFp() {
    const res = ctx.result || {}, d = D();
    const vals = res.values || [];
    const by = (re) => vals.find((v) => re.test(v.label));
    const row = (lab, v, cls = '') => (v ? `<dt>${lab}</dt><dd class="${cls}">${esc(v.value)}${v.unit ? ` <small>${esc(v.unit)}</small>` : ''}${v.hint ? `<em>${esc(v.hint)}</em>` : ''}</dd>` : '');
    const dr = by(/^Drill/), plc = by(/^Placed/);
    const fpText = (res.texts || [])[0]?.body || '';
    const name = /Footprint: (\S+)/.exec(fpText)?.[1] || '';
    fp.innerHTML = !ctx.result?.drawing ? '<div class="mh-lab">Footprint</div><div class="mh-big">–</div>'
      : `<div class="mh-lab">Footprint · drill</div><div class="mh-big">Ø ${esc(dr?.value || '–')}<small> mm</small></div><div class="mh-name">${esc(name)}</div>`
      + `<dl class="mh-dl">${row('Pad', by(/^Pad/))}${row('Copper keep-out', by(/^Copper keep-out/), 'ck')}${row('Part keep-out', by(/^Part keep-out/), 'pk')}`
      + `${row('Centre to edge', by(/^Hole centre to board edge/))}${plc ? row('Placed', plc, plc.tone === 'bad' ? 't-bad' : 't-ok') : ''}`
      + `${row(d?.washer ? 'Head / washer' : 'Head', by(/^Head/))}${row('Standoff', by(/^Standoff/))}</dl>`;
    warnsEl.replaceChildren(...(res.warnings || []).map((w) => el('div', {}, esc(w))));
    notesEl.replaceChildren(el('summary', {}, `Sizes and assumptions (${(res.notes || []).length} notes)`), ...(res.notes || []).map((n) => el('div', {}, esc(n))));
  }

  // ================= interaction =================
  function start(svg, e) {
    const h = e.target.closest('[data-h]');
    if (!h || e.button > 0) return;
    if (h.dataset.h === 'washer' || h.dataset.h.startsWith('scr-')) return; // clicks
    e.preventDefault();
    drag = { svg, h: h.dataset.h, inp: ctx.input, p0: toSvg(svg, e), d: D() };
    try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    h.focus({ preventScroll: true });
    h.classList.add('on');
  }
  function move(svg, e) {
    if (!drag || drag.svg !== svg) return;
    const p = toSvg(svg, e), dd = drag.d;
    if (svg === tsv && geo.top) {
      const { k, x0, y0, cx, cy } = geo.top;
      if (drag.h === 'hole') {
        const x = Math.max(0.5, Math.round(((p.x - x0) / k) * 10) / 10), y = Math.max(0.5, Math.round(((p.y - y0) / k) * 10) / 10);
        setSoon({ ex: String(x), ey: String(y) });
      } else {
        const rr = Math.hypot(p.x - cx, p.y - cy) / k; // mm radius
        const v = clamp(Math.round((rr - dd.metal / 2) * 20) / 20, 0, 20);
        setSoon({ [drag.h]: String(v) });
      }
    } else if (svg === ssv && geo.sec) {
      const { k, cx } = geo.sec;
      if (drag.h === 't') {
        const t = clamp(Math.round((drag.inp.t + (p.y - drag.p0.y) / k) * 10) / 10, 0.4, 6);
        setSoon({ t: String(t) });
      } else if (drag.h === 'sd') {
        const half = Math.abs(cx - p.x) / k;
        const ac = 2 * half, af = dd.standoffShape === 'hex' ? ac * Math.sqrt(3) / 2 : ac;
        setSoon({ sd: String(clamp(Math.round(af * 10) / 10, 1, 30)) });
      }
    }
  }
  function end() { if (!drag) return; drag = null; requestAnimationFrame(drawAll); }
  for (const s of [tsv, ssv]) {
    s.addEventListener('pointerdown', (e) => start(s, e));
    s.addEventListener('pointermove', (e) => move(s, e));
    s.addEventListener('pointerup', end);
    s.addEventListener('pointercancel', end);
    s.addEventListener('keydown', onKey);
  }
  ssv.addEventListener('click', (e) => { if (e.target.closest('[data-h="washer"]')) ctx.set('washer', !ctx.input.washer); });
  function onKey(e) {
    const h = e.target.closest?.('[data-h]');
    if (!h) return;
    const k = h.dataset.h, i = ctx.input, d = D();
    if (k === 'washer' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ctx.set('washer', !i.washer); return; }
    const mv = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
    if (!mv || !d) return;
    e.preventDefault();
    const st = e.shiftKey ? 1 : 0.1;
    const r1 = (v) => String(Math.round(v * 100) / 100);
    if (k === 'hole') {
      const hx = d.ex ?? d.edge, hy = d.ey ?? d.edge;
      ctx.setMany({ ex: r1(Math.max(0.5, hx + mv[0] * st)), ey: r1(Math.max(0.5, hy + mv[1] * st)) });
    } else if (k === 'cu' || k === 'tool') {
      const dir = mv[0] || -mv[1];
      ctx.set(k, r1(clamp((i[k] || 0) + dir * (e.shiftKey ? 0.5 : 0.05), 0, 20)));
    } else if (k === 't') ctx.set('t', r1(clamp(i.t + mv[1] * (e.shiftKey ? 0.4 : 0.1), 0.4, 6)));
    else if (k === 'sd') {
      const dir = mv[0] || -mv[1];
      ctx.set('sd', r1(clamp((i.sd > 0 ? i.sd : d.standoffAF) + dir * (e.shiftKey ? 1 : 0.1), 1, 30)));
    }
  }

  function drawAll() {
    const d = ctx.result?.drawing;
    if (d) lastGood = d;
    grid.classList.toggle('stale', !d);
    const inp = ctx.input;
    fitSeg.sync(inp.fit); platSeg.sync(inp.plated); headSeg.sync(inp.head); soSeg.sync(inp.standoff);
    drawPlate(); drawTop(); drawSec(); drawFp();
  }
  ctx.onResult(drawAll);
  new ResizeObserver(() => { if (!drag) { view = null; geo.secK = null; drawAll(); } }).observe(grid);
}
