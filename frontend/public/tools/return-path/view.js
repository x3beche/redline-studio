// Return Path Checker: the page is the spot on the board where the return
// current has to find its way. A rail of situations on the left (the case
// table, drawn), the spot itself in the middle: a layer change as a board
// section to scale with the signal via, the return via or capacitor you drag
// along the board, the loop they close shaded by how much of Z0 it costs and
// the distance it must stay within as a band; a split or slot as a plan view
// with the return current's detour; a plane edge as a section with the 3h/5h
// bands. Below, the signal edge (drag its top to change the rise time) with
// the knee frequency and the stitching fence it sets. Every number drawn
// comes from run()'s result (result.path); the page only places it.

import { CASES } from './tool.js';
import { fmtEng, fmtNum } from '../kit/eng.js';

const NS = 'http://www.w3.org/2000/svg';
const SHORT = {
  'same-plane': 'One shared plane', 'gnd-gnd': 'GND to GND', 'gnd-pwr': 'GND to PWR', 'pwr-pwr': 'PWR to PWR',
  split: 'Crosses a split', slot: 'Over a slot', edge: 'Near a plane edge', connector: 'Through a connector', 'no-plane': 'No plane under it',
};
const GROUP = {
  'same-plane': 'Layer change', 'gnd-gnd': 'Layer change', 'gnd-pwr': 'Layer change', 'pwr-pwr': 'Layer change',
  split: 'Plane', slot: 'Plane', edge: 'Plane', connector: 'Leaving the board', 'no-plane': 'Plane',
};
const SEV = { low: ['ok', 'fine'], medium: ['warn', 'needs care'], high: ['bad', 'serious'] };
const RISES = [['0.1', '100 ps'], ['0.5', '500 ps'], ['1', '1 ns'], ['2', '2 ns'], ['5', '5 ns']];

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const svgEl = (cls, label) => {
  const e = document.createElementNS(NS, 'svg');
  e.setAttribute('class', cls);
  if (label) { e.setAttribute('role', 'group'); e.setAttribute('aria-label', label); }
  return e;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mm = (v, d = 3) => `${fmtNum(v, d)} mm`;
const trim = (v, d) => String(Number(Number(v).toFixed(d)));

/** a small picture of each case for the rail */
function thumb(k) {
  const pl = (y, cls = 'tp') => `<rect class="${cls}" x="2" y="${y}" width="40" height="2.4"/>`;
  const sig = (x0, x1, y) => `<path class="ts" d="M${x0} ${y}H${x1}"/>`;
  const via = (x, cls = 'tv') => `<rect class="${cls}" x="${x - 1.4}" y="3" width="2.8" height="22"/>`;
  const cap = (x) => `<path class="tc" d="M${x} 11v2.5M${x - 3} 13.5h6M${x - 3} 15.5h6M${x} 15.5V18"/>`;
  switch (k) {
    case 'same-plane': return pl(12.8) + sig(2, 20, 4) + sig(20, 42, 22) + via(20) + '<path class="tr" d="M24 11.5a3 3 0 0 1 0 5"/>';
    case 'gnd-gnd': return pl(9) + pl(17) + sig(2, 16, 4) + sig(16, 42, 24) + via(16) + via(27, 'tg');
    case 'gnd-pwr': return pl(9) + pl(17, 'tw') + sig(2, 16, 4) + sig(16, 42, 24) + via(16) + cap(28);
    case 'pwr-pwr': return pl(9, 'tw') + pl(17, 'tw') + sig(2, 16, 4) + sig(16, 42, 24) + via(16) + cap(28);
    case 'split': return '<rect class="tp" x="2" y="3" width="17" height="22"/><rect class="tp" x="25" y="3" width="17" height="22"/>' + sig(2, 42, 9) + '<path class="tr" d="M26 11v12h-8v-12"/>';
    case 'slot': return '<rect class="tp" x="2" y="3" width="40" height="22"/><rect class="tx" x="17" y="5" width="10" height="16" rx="5"/>' + sig(2, 42, 13);
    case 'edge': return '<rect class="tp" x="14" y="19" width="28" height="3"/>' + '<rect class="ts2" x="16" y="12" width="6" height="2.4"/><path class="tr" d="M19 14.4q-6 1 -8 5"/>';
    case 'connector': return pl(8) + pl(20) + '<rect class="tk" x="14" y="11" width="16" height="6" rx="1"/>' + via(18) + via(26, 'tg');
    default: return sig(4, 40, 8) + '<path class="tr" d="M40 11c0 12 -36 12 -36 0"/>';
  }
}

export function page(root, ctx) {
  // ---------------- DOM ----------------
  const filterIn = h('input', { class: 'rp-filter', type: 'search', placeholder: 'Filter: via, split, capacitor…', 'aria-label': 'Filter the situations', spellcheck: 'false' });
  filterIn.addEventListener('input', () => ctx.set('filter', filterIn.value));
  const list = h('div', { class: 'rp-list', role: 'radiogroup', 'aria-label': 'Situation' });
  const rail = h('aside', { class: 'rp-card rp-rail' }, h('div', { class: 'rp-rail-head' }, h('b', {}, 'Situations'), filterIn), list);

  const stageHead = h('div', { class: 'rp-head' });
  const stageBox = h('div', { class: 'rp-stage-box' });
  const stage = svgEl('rp-stage', 'The spot on the board, drawn; its return via, capacitor, trace and board edges are draggable');
  stageBox.append(stage);
  const strip = h('div', { class: 'rp-strip' });
  const stageCard = h('section', { class: 'rp-card rp-main' }, stageHead, stageBox, strip);

  const edgeSvg = svgEl('rp-edge', 'The signal edge: drag its top to change the rise time');
  const edgeCard = h('section', { class: 'rp-card rp-edgecard' });
  const rises = h('div', { class: 'rp-chips' });
  for (const [v, t] of RISES) rises.append(h('button', { class: 'rp-chip', 'data-tr': v, onclick: () => ctx.set('tr', v) }, t));
  const erIn = h('input', { class: 'rp-in', id: 'rp-er', type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Dielectric constant εr' });
  erIn.addEventListener('input', () => ctx.set('er', erIn.value));
  const trIn = h('input', { class: 'rp-in', id: 'rp-tr', type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Rise time in ns' });
  trIn.addEventListener('input', () => ctx.set('tr', trIn.value));
  const edgeNums = h('div', { class: 'rp-edgenums' });
  edgeCard.append(h('div', { class: 'rp-subhead' }, h('b', {}, 'Signal edge'), h('span', {}, 'drag the top of the edge')),
    edgeSvg,
    h('div', { class: 'rp-edgerow' }, h('label', { for: 'rp-tr' }, 'tr'), trIn, h('span', { class: 'rp-u' }, 'ns'), rises),
    h('div', { class: 'rp-edgerow' }, h('label', { for: 'rp-er' }, 'εr'), erIn, edgeNums));

  const verdict = h('section', { class: 'rp-card rp-verdict', 'aria-live': 'polite' });
  const lower = h('div', { class: 'rp-lower' }, edgeCard, verdict, h('div', { class: 'rp-outs' }, ctx.outputs));
  const main = h('div', { class: 'rp-body' }, stageCard, lower);
  root.append(h('div', { class: 'rp' }, rail, main));

  // ---------------- state ----------------
  let drag = null, pending = null, sGeo = null, eGeo = null, frozen = null;
  let showFix = false;
  const fields = {};

  function setSoon(obj) {
    const first = !pending;
    pending = { ...(pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = pending; pending = null; ctx.setMany(p); });
  }
  const P = () => ctx.result?.path || null;
  const scen = () => (CASES.some((c) => c[0] === ctx.input.scenario) ? ctx.input.scenario : 'gnd-gnd');

  // ---------------- rail ----------------
  function drawRail() {
    const res = ctx.result || {};
    const rows = res.tables?.[1]?.rows || [];
    const shownTitles = new Set(rows.map((r) => String(r[0]).replace(/^▶\s*/, '')));
    const cur = scen();
    const fk = document.activeElement?.closest?.('.rp-case')?.dataset.k;
    list.replaceChildren();
    let lastGroup = null;
    for (const c of CASES) {
      if (rows.length && !shownTitles.has(c[1]) && c[0] !== cur) continue;
      if (GROUP[c[0]] !== lastGroup) { list.append(h('div', { class: 'rp-group' }, GROUP[c[0]])); lastGroup = GROUP[c[0]]; }
      const [tone, word] = SEV[c[4]];
      const b = h('button', { class: `rp-case t-${tone}`, role: 'radio', 'aria-checked': String(c[0] === cur), 'data-k': c[0], title: c[1], tabindex: c[0] === cur ? '0' : '-1' });
      b.innerHTML = `<svg viewBox="0 0 44 28" aria-hidden="true">${thumb(c[0])}</svg><span class="nm">${esc(SHORT[c[0]])}</span><span class="sv">${esc(word)}</span>`;
      b.addEventListener('click', () => { frozen = null; showFix = false; ctx.set('scenario', c[0]); });
      b.addEventListener('keydown', (e) => {
        const all = [...list.querySelectorAll('.rp-case')];
        const i = all.indexOf(b);
        const j = /Down|Right/.test(e.key) ? i + 1 : /Up|Left/.test(e.key) ? i - 1 : null;
        if (j == null) return;
        e.preventDefault();
        const nb = all[(j + all.length) % all.length];
        frozen = null; showFix = false;
        ctx.set('scenario', nb.dataset.k);
        requestAnimationFrame(() => list.querySelector(`[data-k="${nb.dataset.k}"]`)?.focus());
      });
      list.append(b);
    }
    if (rows.length === 1 && /^\(/.test(rows[0][0])) list.append(h('div', { class: 'rp-none' }, 'Nothing else matches the filter.'));
    if (fk) list.querySelector(`[data-k="${fk}"]`)?.focus({ preventScroll: true });
    if (document.activeElement !== filterIn) filterIn.value = ctx.raw.filter || '';
  }

  // ---------------- numeric strip (the keyboard path) ----------------
  const STRIP = [['z0', 'Z0', 'Ω'], ['thick', 'Board', 'mm'], ['drill', 'Drill', 'mm'], ['dist', 'To return', 'mm'], ['nvias', 'Signal vias', ''], ['h', 'Height h', 'mm'], ['clearance', 'To edge', 'mm']];
  for (const [k, lab, u] of STRIP) {
    const inp = h('input', { class: 'rp-in', id: `rp-f-${k}`, type: 'text', inputmode: 'decimal', spellcheck: 'false' });
    inp.addEventListener('input', () => ctx.set(k, inp.value));
    const row = h('div', { class: 'rp-f' }, h('label', { for: `rp-f-${k}` }, lab), h('div', { class: 'rp-frow' }, inp, u ? h('span', { class: 'rp-u' }, u) : null));
    if (k === 'nvias') {
      const dn = h('button', { class: 'rp-step', 'aria-label': 'One signal via fewer', onclick: () => ctx.set('nvias', String(Math.max(1, (ctx.input.nvias || 1) - 1))) }, '−');
      const up = h('button', { class: 'rp-step', 'aria-label': 'One signal via more', onclick: () => ctx.set('nvias', String(Math.min(16, (ctx.input.nvias || 1) + 1))) }, '+');
      row.lastChild.prepend(dn); row.lastChild.append(up);
    }
    strip.append(row);
    fields[k] = { row, inp };
  }
  function drawStrip() {
    const defs = ctx.manifest.inputs;
    const raw = ctx.raw;
    let any = false;
    for (const [k] of STRIP) {
      const d = defs.find((x) => x.key === k);
      const w = d?.when;
      const on = !w || (w.in ? w.in.includes(scen()) : w.equals === scen());
      fields[k].row.hidden = !on;
      any ||= on;
      if (document.activeElement !== fields[k].inp) fields[k].inp.value = raw[k] ?? '';
    }
    strip.hidden = !any;
  }

  // ---------------- the stage ----------------
  function drawStage() {
    const W = Math.max(300, stageBox.clientWidth), H = Math.max(260, stageBox.clientHeight);
    stage.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const p = P(), s = scen();
    const fk = document.activeElement?.closest?.('[data-h]')?.dataset.h;
    let html = '';
    if (!p) html = `<text class="lbl" x="20" y="30">${esc(ctx.result?.warnings?.[0] || '')}</text>`;
    else if (['same-plane', 'gnd-gnd', 'gnd-pwr', 'pwr-pwr', 'connector'].includes(s)) html = section(W, H, p, s);
    else if (s === 'split') html = split(W, H, p);
    else if (s === 'slot') html = slot(W, H, p);
    else if (s === 'edge') html = edge(W, H, p);
    else html = noPlane(W, H, p);
    stage.innerHTML = html;
    if (fk) stage.querySelector(`[data-h="${fk}"]`)?.focus({ preventScroll: true });
    const c = CASES.find((x) => x[0] === s);
    const [tone, word] = SEV[c[4]];
    const hint = {
      section: 'drag the return via along the board · drag the bottom face for thickness · arrow keys on a focused handle',
      split: 'drag the stitching capacitor along the split',
      slot: 'the return current detours around the void',
      edge: 'drag the trace toward the edge · drag its height',
      none: 'the return current finds its own way',
      same: 'drag the bottom face for thickness · the return current wraps through the anti-pad',
      cap: 'drag the capacitor along the board · drag the bottom face for thickness · arrow keys on a focused handle',
    }[s === 'same-plane' ? 'same' : ['gnd-pwr', 'pwr-pwr'].includes(s) ? 'cap' : ['gnd-gnd', 'connector'].includes(s) ? 'section' : s === 'no-plane' ? 'none' : s];
    const fixBtn = s === 'slot' || s === 'no-plane' ? `<button class="rp-fixbtn" aria-pressed="${showFix}">${showFix ? 'Show the problem' : 'Show the fix'}</button>` : '';
    stageHead.innerHTML = `<span class="rp-sev t-${tone}">${esc(word)}</span><b>${esc(c[1])}</b>${fixBtn}<span class="rp-hint">${esc(hint)}</span>`;
    stageHead.querySelector('.rp-fixbtn')?.addEventListener('click', () => { showFix = !showFix; drawStage(); });
  }

  // board section of a layer change, to scale
  function section(W, H, p, s) {
    const inp = ctx.input;
    const thick = inp.thick > 0 ? inp.thick : 1.6, drill = inp.drill > 0 ? inp.drill : 0.3;
    const dist = inp.dist > 0 ? inp.dist : 1;
    const hasRet = p.kind === 'via' || p.kind === 'cap';
    const isCap = p.kind === 'cap';
    const within = p.within != null ? p.within * 1e3 : null;
    const sMin = p.sMin != null ? p.sMin * 1e3 : null;
    // the window in mm, frozen while dragging
    if (!frozen || !drag) {
      const right = Math.max(2.4, (hasRet ? dist : 0) * 1.35 + 0.8, within != null && within < 25 ? within * 1.15 + 0.4 : 0);
      frozen = { left: Math.max(1.2, right * 0.28), right: Math.min(right, 30), thick };
    }
    const f = frozen;
    const narrow = W < 560;
    const mL = narrow ? 8 : 64, mR = narrow ? 58 : 100, mT = 70, mB = isCap ? 136 : 100;
    const x0 = mL, x1 = W - mR;
    const sc = Math.min((x1 - x0 - 24) / (f.left + f.right), (H - mT - mB) / Math.max(thick, f.thick * 0.8), 320);
    const xv = x0 + 12 + f.left * sc;
    const y0 = mT + Math.max(0, (H - mT - mB - thick * sc) / 2), y1 = y0 + thick * sc;
    const X = (d) => xv + d * sc;
    const cu = Math.max(3, 0.035 * sc);
    const pre = Math.max(10, Math.min(thick * sc * 0.16, 0.2 * sc));
    const yA = y0 + pre, yB = y1 - pre - cu; // plane A (under the top trace), plane B (over the bottom trace)
    const xr = X(dist);
    const types = { 'same-plane': ['GND', null], 'gnd-gnd': ['GND', 'GND'], 'gnd-pwr': ['GND', 'PWR'], 'pwr-pwr': ['PWR 3V3', 'PWR 1V8'], connector: ['GND', 'GND'] }[s];
    const cls = (t) => (t && t.startsWith('PWR') ? 'pwr' : 'gnd');
    const tone = !hasRet ? 'ok' : !p.reach ? 'bad' : p.frac <= 0.1 ? 'ok' : p.frac <= 0.2 ? 'warn' : 'bad';
    const o = [];
    const aR = (drill / 2 + 0.25) * sc; // anti-pad radius, drawn
    // dielectric and the board
    o.push(`<rect class="diel" x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}"/>`);
    // planes with anti-pads around the signal via (and around the cap via on the other plane)
    const plane = (y, t, gaps) => {
      let segs = [[x0, x1]];
      for (const [a, b] of gaps) segs = segs.flatMap(([u, v]) => (b <= u || a >= v ? [[u, v]] : [[u, a], [b, v]].filter(([p1, p2]) => p2 - p1 > 0.5)));
      return segs.map(([a, b]) => `<rect class="plane ${cls(t)}" x="${a}" y="${y}" width="${b - a}" height="${cu}"/>`).join('');
    };
    const gapSig = [xv - aR, xv + aR];
    if (s === 'same-plane') {
      o.push(plane((y0 + y1) / 2 - cu / 2, types[0], [gapSig]));
    } else {
      const capA = isCap ? [[xr + 0.5 * sc - aR * 0.8, xr + 0.5 * sc + aR * 0.8]] : [];
      const capB = isCap ? [[xr - 0.5 * sc - aR * 0.8, xr - 0.5 * sc + aR * 0.8]] : [];
      o.push(plane(yA, types[0], [gapSig, ...capA]));
      o.push(plane(yB, types[1], [gapSig, ...capB]));
    }
    // loop between the signal via and the return element
    if (hasRet && s !== 'same-plane') {
      o.push(`<rect class="loop t-${tone}" x="${Math.min(xv, xr)}" y="${yA + cu}" width="${Math.abs(xr - xv)}" height="${yB - yA - cu}"/>`);
    }
    // signal traces and via
    const yOut = s === 'same-plane' ? y1 - pre - cu : y1;
    o.push(`<rect class="sig" x="${x0}" y="${y0 - cu}" width="${xv - x0}" height="${cu}"/>`);
    o.push(`<rect class="sig" x="${xv}" y="${yOut}" width="${x1 - xv}" height="${cu}"/>`);
    const vw = Math.max(4, drill * sc);
    o.push(`<rect class="via" x="${xv - vw / 2}" y="${y0 - cu}" width="${vw}" height="${yOut + cu - y0 + cu}"/>`);
    o.push(`<rect class="pad" x="${xv - vw / 2 - Math.max(3, 0.15 * sc)}" y="${y0 - cu - 1}" width="${vw + 2 * Math.max(3, 0.15 * sc)}" height="${cu + 1}"/>`);
    const n = inp.nvias >= 1 ? Math.round(inp.nvias) : 1;
    if (n > 1) o.push(`<rect class="badge" x="${xv - 17}" y="${y0 - cu - 42}" width="34" height="16" rx="8"/><text class="badget" x="${xv}" y="${y0 - cu - 30}" text-anchor="middle">×${n}</text>`);

    // currents
    const arrow = (x, y, dir, c2) => `<path class="arr ${c2}" d="M${x} ${y}l${-7 * dir} -4v8z"/>`;
    const sigY = y0 - cu - 7;
    o.push(`<path class="icur" d="M${x0 + 20} ${sigY}H${xv - 12}"/>${arrow(xv - 14, sigY, 1, 'is')}`);
    o.push(`<path class="icur" d="M${xv + 14} ${yOut + cu + 7}H${x1 - 14}"/>${arrow(x1 - 16, yOut + cu + 7, 1, 'is')}`);
    let ret = '';
    const rA = yA - 4, rB = yB + cu + 4;
    if (s === 'same-plane') {
      const yp = (y0 + y1) / 2;
      ret = `M${x1 - 14} ${yp + cu / 2 + 4}H${xv + aR + 6}a${cu / 2 + 4} ${cu / 2 + 4} 0 0 1 0 ${-(cu + 8)}H${x0 + 20}`;
    } else if (!hasRet) {
      ret = '';
    } else if (isCap) {
      const ya = y1 + 18;
      ret = `M${x1 - 14} ${rB}H${xr - 0.5 * sc + 4}V${ya - 4}H${xr + 0.5 * sc - 4}V${rA}H${x0 + 20}`;
    } else {
      const xs = xr + (xr > xv ? -Math.max(4, vw / 2 + 3) : Math.max(4, vw / 2 + 3));
      ret = `M${x1 - 14} ${rB}H${xs}V${rA}H${x0 + 20}`;
    }
    if (ret) o.push(`<path class="rcur" d="${ret}"/>${arrow(x0 + 28, s === 'same-plane' ? (y0 + y1) / 2 - cu / 2 - 4 : rA, -1, 'ir')}`);

    // the return element: a via, or a capacitor on the bottom with a via to each plane
    if (hasRet && s !== 'same-plane') {
      if (isCap) {
        const cx = xr, ya = y1 + 6, bw = Math.max(20, 1.0 * sc), bh = Math.max(9, 0.5 * sc);
        const vA = cx + 0.5 * sc, vB = cx - 0.5 * sc, cvw = Math.max(3, 0.2 * sc);
        o.push(`<rect class="cvia" x="${vA - cvw / 2}" y="${yA}" width="${cvw}" height="${y1 - yA + 6}"/>`);
        o.push(`<rect class="cvia" x="${vB - cvw / 2}" y="${yB}" width="${cvw}" height="${y1 - yB + 6}"/>`);
        o.push(`<g class="hret" data-h="dist" tabindex="0" role="slider" aria-label="Capacitor distance from the signal via" aria-valuetext="${esc(mm(dist))}">`
          + `<rect class="hit" x="${cx - bw / 2 - 12}" y="${y0 - 20}" width="${bw + 24}" height="${y1 - y0 + bh + 40}"/>`
          + `<rect class="capbody" x="${cx - bw / 2}" y="${ya}" width="${bw}" height="${bh}" rx="2"/>`
          + `<rect class="capend" x="${cx - bw / 2}" y="${ya}" width="${bw * 0.22}" height="${bh}"/><rect class="capend" x="${cx + bw / 2 - bw * 0.22}" y="${ya}" width="${bw * 0.22}" height="${bh}"/>`
          + `<text class="lbl" x="${cx + bw / 2 + 6}" y="${ya + bh / 2 + 4}">${narrow ? 'cap' : 'decoupling cap 10–100 nF'}</text></g>`);
      } else {
        const rw = vw;
        o.push(`<g class="hret" data-h="dist" tabindex="0" role="slider" aria-label="${s === 'connector' ? 'Ground pin' : 'Return via'} distance from the signal via" aria-valuetext="${esc(mm(dist))}">`
          + `<rect class="hit" x="${xr - rw / 2 - 14}" y="${y0 - 26}" width="${rw + 28}" height="${y1 - y0 + 52}"/>`
          + `<rect class="gvia" x="${xr - rw / 2}" y="${y0 - cu}" width="${rw}" height="${y1 - y0 + 2 * cu}"/>`
          + `<rect class="gpad" x="${xr - rw / 2 - Math.max(3, 0.15 * sc)}" y="${y0 - cu - 1}" width="${rw + 2 * Math.max(3, 0.15 * sc)}" height="${cu + 1}"/>`
          + `<rect class="gpad" x="${xr - rw / 2 - Math.max(3, 0.15 * sc)}" y="${y1}" width="${rw + 2 * Math.max(3, 0.15 * sc)}" height="${cu + 1}"/>`
          + '</g>');
      }
    }

    // dimensions: distance above, thickness on the right, drill at the via
    const yd = y0 - cu - 24;
    if (hasRet && s !== 'same-plane') {
      o.push(`<path class="dim" d="M${xv} ${yd}H${xr}M${xv} ${yd - 4}v8M${xr} ${yd - 4}v8"/>`);
      const lbl = `${s === 'connector' ? 'pin to pin' : isCap ? 'via to cap' : 'via to via'} ${mm(dist)}`;
      const fits = Math.abs(xr - xv) > lbl.length * 6.8 + 10;
      const tx = fits ? clamp((xv + xr) / 2, lbl.length * 3.4 + 4, W - lbl.length * 3.4 - 4) : Math.max(xv, xr) + 8;
      const after = !fits && tx + lbl.length * 6.8 > W - 4;
      o.push(`<text class="dimt halo" x="${after ? Math.min(xv, xr) - 8 : tx}" y="${fits ? yd - 6 : yd + 4}" text-anchor="${fits ? 'middle' : after ? 'end' : 'start'}">${esc(lbl)}</text>`);
    }
    const xt = x1 + 16;
    o.push(`<g class="hthk" data-h="thick" tabindex="0" role="slider" aria-label="Board thickness" aria-valuetext="${esc(mm(thick))}">`
      + `<rect class="hit" x="${xt - 16}" y="${y1 - 12}" width="${mR - 10}" height="24"/>`
      + `<path class="dim" d="M${xt} ${y0}V${y1}M${xt - 4} ${y0}h8M${xt - 4} ${y1}h8"/>`
      + `<rect class="knob" x="${xt - 9}" y="${y1 - 4}" width="18" height="8" rx="3"/></g>`);
    o.push(`<text class="dimt halo" x="${xt + 8}" y="${(y0 + y1) / 2}">${fmtNum(thick, 3)}${narrow ? '' : ' mm'}</text>`);
    if (!narrow) o.push(`<text class="lbl dim" x="${xt + 8}" y="${(y0 + y1) / 2 + 15}">via length</text>`);
    o.push(`<text class="dimt halo" x="${xv}" y="${y1 + cu + 22}" text-anchor="middle">⌀${fmtNum(drill, 3)}</text>`);

    // plane labels
    if (!narrow) {
      if (s === 'same-plane') o.push(`<text class="plbl ${cls(types[0])}" x="${mL - 8}" y="${(y0 + y1) / 2 + 4}" text-anchor="end">L2 ${types[0]}</text>`);
      else {
        o.push(`<text class="plbl ${cls(types[0])}" x="${mL - 8}" y="${yA + 5}" text-anchor="end">L2 ${types[0]}</text>`);
        o.push(`<text class="plbl ${cls(types[1])}" x="${mL - 8}" y="${yB + 5}" text-anchor="end">L${s === 'connector' ? '5' : '3'} ${types[1]}</text>`);
      }
      o.push(`<text class="plbl sg" x="${mL - 8}" y="${y0 - 2}" text-anchor="end">L1 in</text>`);
      o.push(`<text class="plbl sg" x="${mL - 8}" y="${yOut + cu + 4}" text-anchor="end">${s === 'same-plane' ? 'L3' : 'L4'} out</text>`);
    }

    // loop read-out in the loop
    if (hasRet && s !== 'same-plane' && p.loopL != null) {
      const lx = (xv + xr) / 2, ly = (yA + yB) / 2 + 4;
      const txt = `${fmtEng(p.loopL, 'H')} · ${fmtNum(p.x, 3)} Ω · ${fmtNum(p.frac * 100, 2)} % of Z0`;
      const room = Math.abs(xr - xv) > txt.length * 6.6 + 10;
      if (!room && narrow) o.push(`<text class="loopt t-${tone}" x="${xv - 20}" y="${y1 + (isCap ? Math.max(9, 0.5 * sc) + 34 : 34) + 40}">${esc(txt)}</text>`);
      else o.push(`<text class="loopt t-${tone} halo" x="${room ? lx : Math.max(xv, xr) + (isCap ? 0.5 * sc + 10 : vw / 2 + 12)}" y="${ly}" text-anchor="${room ? 'middle' : 'start'}">${esc(txt)}</text>`);
    }

    // the band the return element must sit in
    const yz = y1 + (isCap ? Math.max(9, 0.5 * sc) + 34 : 34);
    if (hasRet && s !== 'same-plane') {
      const endX = within != null ? Math.min(X(within), x1) : xv;
      const minX = sMin != null ? X(sMin) : xv;
      o.push(`<rect class="zone bad" x="${xv}" y="${yz}" width="${x1 - xv}" height="8"/>`);
      if (p.reach) o.push(`<rect class="zone ok" x="${xv}" y="${yz}" width="${endX - xv}" height="8"/>`);
      o.push(`<rect class="zone min" x="${xv}" y="${yz}" width="${Math.max(0, minX - xv)}" height="8"/>`);
      o.push(`<path class="tick" d="M${xr} ${yz - 5}v18"/>`);
      const zt = p.reach
        ? `${isCap ? 'cap' : s === 'connector' ? 'ground pin' : 'return via'} within ${mm(within)}${within * 1e-3 >= p.pitch * 0.999 ? ' (λ/20)' : ''}${X(within) > x1 ? ' →' : ''}`
        : 'not reachable: the via itself is too long for this edge';
      o.push(`<text class="zonet${p.reach ? '' : ' bad'}" x="${xv}" y="${yz + 24}">${esc(zt)}</text>`);
      if (sMin != null && !narrow) o.push(`<text class="zonet dim" x="${xv}" y="${yz + 38}">closest that fits: ${mm(sMin, 2)}</text>`);
    } else if (s === 'same-plane') {
      o.push(`<text class="zonet" x="${xv - 20}" y="${yz + 14}">the return current crosses the plane through the anti-pad: no extra via</text>`);
    }
    sGeo = { kind: 'section', X, xv, sc, y0, y1, thick };
    return o.join('');
  }

  // plan view: the trace crossing a split, with the stitching capacitor
  function split(W, H, p) {
    const inp = ctx.input;
    const dist = inp.dist > 0 ? inp.dist : 1;
    const within = p.within != null ? p.within * 1e3 : null;
    if (!frozen || !drag) frozen = { span: Math.max(4, dist * 1.5, within != null && within < 40 ? within * 1.25 : 0) };
    const narrow = W < 560;
    const mT = 40, mB = 46;
    const yT = mT + 30;              // trace
    const sc = (H - mT - mB - 30 - 40) / frozen.span;
    const Y = (d) => yT + d * sc;
    const gx = W * 0.5, gw = 16;
    const yEnd = H - mB;             // the split ends here (the detour)
    const tone = !p.reach ? 'bad' : p.frac <= 0.1 ? 'ok' : p.frac <= 0.2 ? 'warn' : 'bad';
    const o = [];
    o.push(`<rect class="planep gnd" x="16" y="${mT - 20}" width="${gx - gw / 2 - 16}" height="${yEnd - mT + 34}"/>`);
    o.push(`<rect class="planep pwr2" x="${gx + gw / 2}" y="${mT - 20}" width="${W - 16 - gx - gw / 2}" height="${yEnd - mT + 34}"/>`);
    o.push(`<rect class="planep gnd" x="16" y="${yEnd + 4}" width="${W - 32}" height="10"/>`);
    o.push(`<text class="plbl" x="24" y="${mT - 4}">plane A</text><text class="plbl" x="${W - 24}" y="${mT - 4}" text-anchor="end">plane B</text>`);
    o.push(`<text class="plbl dim" x="${gx}" y="${mT - 26}" text-anchor="middle">split</text>`);
    // the detour: return current around the end of the split
    const dA = `M${W - 40} ${yT + 7}H${gx + gw / 2 + 8}V${yEnd - 2}H${gx - gw / 2 - 8}V${yT + 7}H40`;
    const capY = Y(dist);
    o.push(`<path class="detour" d="M${gx - gw / 2} ${yT + 7}H${gx + gw / 2}V${yEnd}H${gx - gw / 2}Z"/>`);
    o.push(`<path class="rcur faded" d="${dA}"/>`);
    o.push(`<text class="lbl warn" x="${gx + gw / 2 + 14}" y="${yEnd - 10}">without the capacitor: around the end of the split</text>`);
    // short path through the cap
    o.push(`<path class="rcur" d="M${W - 40} ${yT + 7}H${gx + gw / 2 + 4}V${capY}H${gx - gw / 2 - 4}V${yT + 7}H40"/>`);
    o.push(`<rect class="loop t-${tone}" x="${gx - gw / 2 - 4}" y="${yT + 7}" width="${gw + 8}" height="${Math.max(0, capY - yT - 7)}"/>`);
    // trace
    o.push(`<rect class="sig" x="16" y="${yT - 3}" width="${W - 32}" height="6"/>`);
    o.push(`<path class="icur" d="M40 ${yT - 12}H${W - 60}"/><path class="arr is" d="M${W - 54} ${yT - 12}l-7 -4v8z"/>`);
    o.push(`<text class="lbl" x="40" y="${yT - 18}">trace, on the layer above</text>`);
    // the within band along the split
    if (within != null) {
      const yw = Math.min(Y(within), yEnd - 4);
      o.push(`<rect class="zone ok" x="${gx - gw / 2 - 22}" y="${yT}" width="8" height="${yw - yT}"/>`);
      o.push(`<text class="zonet" x="${gx - gw / 2 - 28}" y="${Math.min(yw, yEnd - 20) + 4}" text-anchor="end">within ${mm(within)}${Y(within) > yEnd - 4 ? ' ↓' : ''}</text>`);
    }
    // the capacitor handle
    const cw = 34, ch = 14;
    o.push(`<g class="hret" data-h="dist" tabindex="0" role="slider" aria-label="Stitching capacitor distance from the crossing" aria-valuetext="${esc(mm(dist))}">`
      + `<rect class="hit" x="${gx - cw / 2 - 14}" y="${capY - 20}" width="${cw + 28}" height="40"/>`
      + `<rect class="capbody" x="${gx - cw / 2}" y="${capY - ch / 2}" width="${cw}" height="${ch}" rx="2"/>`
      + `<rect class="capend" x="${gx - cw / 2}" y="${capY - ch / 2}" width="8" height="${ch}"/><rect class="capend" x="${gx + cw / 2 - 8}" y="${capY - ch / 2}" width="8" height="${ch}"/></g>`);
    o.push(`<path class="dim" d="M${gx + cw / 2 + 12} ${yT}V${capY}M${gx + cw / 2 + 8} ${yT}h8M${gx + cw / 2 + 8} ${capY}h8"/>`);
    o.push(`<text class="dimt halo" x="${gx + cw / 2 + 20}" y="${(yT + capY) / 2 + 4}">${mm(dist)}</text>`);
    if (p.loopL != null) {
      o.push(`<text class="loopt t-${tone} halo" x="${gx + cw / 2 + 20}" y="${capY + 22}">${esc(`${fmtEng(p.loopL, 'H')} · ${fmtNum(p.x, 3)} Ω · ${fmtNum(p.frac * 100, 2)} % of Z0`)}</text>`);
    }
    if (!narrow) o.push(`<text class="lbl dim" x="${W - 24}" y="${H - 10}" text-anchor="end">plan view · distances along the split to scale</text>`);
    sGeo = { kind: 'split', Y, sc, yT };
    return o.join('');
  }

  // plan view: a slot of merged anti-pads
  function slot(W, H) {
    const cx = W / 2, cy = H / 2 + 10, r = Math.min(26, H / 12), n = 5;
    const o = [];
    o.push(`<rect class="planep gnd" x="16" y="30" width="${W - 32}" height="${H - 60}"/>`);
    const yTop = cy - (n / 2) * 2 * r * (showFix ? 1.25 : 0.9);
    for (let i = 0; i < n; i++) {
      const y = yTop + r + i * 2 * r * (showFix ? 1.25 : 0.9);
      o.push(`<circle class="void" cx="${cx}" cy="${y}" r="${r}"/><circle class="pin" cx="${cx}" cy="${y}" r="${r * 0.45}"/>`);
    }
    const yEnd = yTop + n * 2 * r * (showFix ? 1.25 : 0.9);
    const yT = cy - r * 0.9;
    o.push(`<rect class="sig" x="16" y="${yT - 3}" width="${W - 32}" height="6"/>`);
    o.push(`<path class="icur" d="M40 ${yT - 12}H${W - 60}"/><path class="arr is" d="M${W - 54} ${yT - 12}l-7 -4v8z"/>`);
    if (showFix) {
      o.push(`<path class="rcur" d="M${W - 40} ${yT + 8}H40"/>`);
      o.push(`<text class="lbl ok" x="${cx + r + 12}" y="${yEnd + 18}">copper webs ≥ 0.15–0.2 mm between anti-pads: the return passes straight under the trace</text>`);
    } else {
      o.push(`<path class="detour" d="M${cx - r - 2} ${yT + 8}H${cx + r + 2}V${yEnd + 6}H${cx - r - 2}Z"/>`);
      o.push(`<path class="rcur" d="M${W - 40} ${yT + 8}H${cx + r + 10}V${yEnd + 10}H${cx - r - 10}V${yT + 8}H40"/>`);
      o.push(`<text class="lbl warn" x="${cx + r + 16}" y="${yEnd + 4}">merged anti-pads make a slot: the return current detours around it</text>`);
    }
    o.push(`<text class="lbl" x="40" y="${yT - 18}">trace, on the layer above</text>`);
    sGeo = null;
    return o.join('');
  }

  // section at a plane edge: 3h and 5h bands
  function edge(W, H, p) {
    const inp = ctx.input;
    const hh = inp.h > 0 ? inp.h : 0.2, cl = inp.clearance >= 0 ? inp.clearance : 0.5;
    if (!frozen || !drag) frozen = { span: Math.max(6.5 * hh, cl * 1.4 + 3 * hh), hh };
    const narrow = W < 560;
    const mL = narrow ? 20 : 60, mR = 30;
    const sc = Math.min((W - mL - mR) / (frozen.span + 1.2 * frozen.hh), (H - 180) / (frozen.hh * 1.7));
    const xe = mL + 1.2 * frozen.hh * sc;  // plane edge
    const X = (d) => xe + d * sc;          // d: mm inward from the plane edge
    const yP = H - 90, tw = Math.max(18, 0.25 * sc), cu = Math.max(3, 0.035 * sc);
    const yTr = yP - hh * sc;
    const k3 = p.keep3, k5 = p.keep5;
    const o = [];
    o.push(`<rect class="diel" x="${mL - 20}" y="${yTr}" width="${W - mL + 20}" height="${yP - yTr + 30}"/>`);
    o.push(`<rect class="outside" x="0" y="${yTr - 40}" width="${mL - 20}" height="${yP - yTr + 80}"/>`);
    o.push(`<text class="lbl dim" x="4" y="${yTr - 46}">${narrow ? '' : 'board edge'}</text>`);
    // bands on the plane
    if (k3 != null) {
      o.push(`<rect class="band bad" x="${xe}" y="${yP + cu + 6}" width="${k3 * sc}" height="10"/>`);
      o.push(`<rect class="band warn" x="${X(k3)}" y="${yP + cu + 6}" width="${(k5 - k3) * sc}" height="10"/>`);
      o.push(`<rect class="band ok" x="${X(k5)}" y="${yP + cu + 6}" width="${W - X(k5)}" height="10"/>`);
      o.push(`<text class="zonet" x="${X(k3)}" y="${yP + cu + 32}" text-anchor="middle">3h ${mm(k3)}</text>`);
      o.push(`<text class="zonet" x="${X(k5)}" y="${yP + cu + 46}" text-anchor="middle">5h ${mm(k5)}</text>`);
    }
    o.push(`<rect class="plane gnd" x="${xe}" y="${yP}" width="${W - xe}" height="${cu}"/>`);
    o.push(`<text class="plbl gnd" x="${W - 8}" y="${yP + cu + 62}" text-anchor="end">reference plane</text>`);
    // the trace: its near edge sits `cl` inside the plane edge
    const xt = X(cl), xm = xt + tw / 2;
    const bad = k3 != null && cl < k3, warn = k5 != null && cl < k5;
    // field lines, some reaching past the plane edge
    const fl = [];
    for (let j = 1; j <= 5; j++) {
      const reach = j * hh * sc * 0.9;
      const end = xt - reach;
      fl.push(`<path class="field${end < xe ? ' lost' : ''}" d="M${xt} ${yTr + cu / 2}Q${xt - reach * 0.7} ${yTr - j * 3} ${Math.max(end, mL - 10)} ${end < xe ? yP - hh * sc * 0.2 : yP}"/>`);
      fl.push(`<path class="field" d="M${xt + tw} ${yTr + cu / 2}Q${xt + tw + reach * 0.7} ${yTr - j * 3} ${xt + tw + reach} ${yP}"/>`);
    }
    o.push(fl.join(''));
    o.push(`<g class="htr" data-h="clearance" tabindex="0" role="slider" aria-label="Trace distance to the plane edge" aria-valuetext="${esc(mm(cl))}">`
      + `<rect class="hit" x="${xt - 10}" y="${yTr - 16}" width="${tw + 20}" height="${cu + 26}"/>`
      + `<rect class="sig${bad ? ' bad' : ''}" x="${xt}" y="${yTr - cu}" width="${tw}" height="${cu}"/></g>`);
    o.push(`<g class="hh" data-h="h" tabindex="0" role="slider" aria-label="Trace height over the plane" aria-valuetext="${esc(mm(hh))}">`
      + `<rect class="hit" x="${W - 120}" y="${yTr - 14}" width="100" height="28"/>`
      + `<rect class="knob" x="${W - 60}" y="${yTr - 5}" width="22" height="10" rx="3"/><text class="lbl" x="${W - 66}" y="${yTr - 10}" text-anchor="end">drag ↕ h</text></g>`);
    // dims
    o.push(`<path class="dim" d="M${xe} ${yTr - 30}H${xt}M${xe} ${yTr - 34}v8M${xt} ${yTr - 34}v8"/><path class="ext" d="M${xe} ${yTr - 30}V${yP}"/>`);
    o.push(`<text class="dimt halo${bad ? ' bad' : warn ? ' warn' : ''}" x="${xt + tw + 8}" y="${yTr - 26}">${mm(cl)} to the plane edge</text>`);
    o.push(`<path class="dim" d="M${xm} ${yTr}V${yP}M${xm - 4} ${yP}h8"/>`);
    o.push(`<text class="dimt halo" x="${xm + 8}" y="${(yTr + yP) / 2 + 4}">h ${mm(hh)}</text>`);
    if (bad) o.push(`<text class="lbl bad" x="${xe + 4}" y="${yTr - 50}">field past the plane edge: impedance rises, the edge radiates</text>`);
    sGeo = { kind: 'edge', X, sc, xe, yP };
    return o.join('');
  }

  // plan view of a two-layer board with no plane
  function noPlane(W, H) {
    const o = [];
    const yT = H * 0.35, x0 = 70, x1 = W - 70;
    o.push(`<rect class="board" x="16" y="20" width="${W - 32}" height="${H - 40}" rx="8"/>`);
    o.push(`<rect class="chip" x="${x0 - 40}" y="${yT - 20}" width="40" height="40" rx="3"/><text class="lbl" x="${x0 - 20}" y="${yT + 36}" text-anchor="middle">driver</text>`);
    o.push(`<rect class="chip" x="${x1}" y="${yT - 20}" width="40" height="40" rx="3"/><text class="lbl" x="${x1 + 20}" y="${yT + 36}" text-anchor="middle">receiver</text>`);
    o.push(`<rect class="sig" x="${x0}" y="${yT - 3}" width="${x1 - x0}" height="6"/>`);
    o.push(`<path class="icur" d="M${x0 + 20} ${yT - 12}H${x1 - 30}"/><path class="arr is" d="M${x1 - 24} ${yT - 12}l-7 -4v8z"/>`);
    if (showFix) {
      o.push(`<rect class="planep gnd" x="${x0 - 30}" y="${yT - 30}" width="${x1 - x0 + 60}" height="60" rx="4"/>`);
      o.push(`<rect class="sig" x="${x0}" y="${yT - 3}" width="${x1 - x0}" height="6"/>`);
      o.push(`<path class="rcur" d="M${x1 - 10} ${yT + 12}H${x0 + 10}"/>`);
      o.push(`<text class="lbl ok" x="${x0}" y="${yT + 56}">ground poured under the trace and stitched: the return runs right beneath it</text>`);
    } else {
      const yR = H - 60;
      o.push(`<path class="detour" d="M${x0} ${yT + 3}H${x1}V${yR}H${x0}Z"/>`);
      o.push(`<path class="rcur" d="M${x1 + 20} ${yT + 20}V${yR}H${x0 - 20}V${yT + 20}"/>`);
      o.push(`<text class="lbl" x="${W / 2}" y="${yR + 18}" text-anchor="middle">ground trace along the board edge: the only way back</text>`);
      o.push(`<text class="lbl warn" x="${W / 2}" y="${(yT + yR) / 2}" text-anchor="middle">uncontrolled loop area</text>`);
    }
    sGeo = null;
    return o.join('');
  }

  // ---------------- the edge ----------------
  function drawEdge() {
    const p = P();
    const W = Math.max(240, edgeSvg.clientWidth || 300), H = 100;
    edgeSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const tr = ctx.input.tr > 0 ? ctx.input.tr : 1;
    // time axis: 0 … 10 ns, log would hide the shape; use a fixed window scaled to tr
    const span = frozenEdge?.span || Math.max(2, tr * 3.2);
    const L = 30, R = 14, T = 12, B = 22;
    const X = (t) => L + (t / span) * (W - L - R);
    const Y = (v) => T + (1 - v) * (H - T - B);
    const t0 = span * 0.18;
    // a 10–90 % ramp: 0 → 1 over 1.25 tr, linear
    const tA = t0 - tr * 0.125, tB = t0 + tr * 1.125;
    const o = [];
    o.push(`<path class="eg" d="M${L} ${Y(0)}H${W - R}M${L} ${Y(1)}H${W - R}M${L} ${Y(0.1)}H${W - R}M${L} ${Y(0.9)}H${W - R}"/>`);
    o.push(`<text class="eax" x="${L - 4}" y="${Y(0.9) + 3}" text-anchor="end">90%</text><text class="eax" x="${L - 4}" y="${Y(0.1) + 3}" text-anchor="end">10%</text>`);
    o.push(`<path class="ewave" d="M${L} ${Y(0)}H${X(tA)}L${X(tB)} ${Y(1)}H${W - R}"/>`);
    const x10 = X(t0), x90 = X(t0 + tr);
    o.push(`<path class="dim" d="M${x10} ${H - 12}H${x90}M${x10} ${H - 16}v8M${x90} ${H - 16}v8"/>`);
    o.push(`<text class="dimt" x="${(x10 + x90) / 2}" y="${H - 1}" text-anchor="middle">tr ${esc(fmtEng(tr * 1e-9, 's'))}</text>`);
    o.push(`<g class="htr2" data-h="tr" tabindex="0" role="slider" aria-label="Rise time" aria-valuetext="${esc(fmtEng(tr * 1e-9, 's'))}">`
      + `<circle class="hit" cx="${x90}" cy="${Y(0.9)}" r="14"/><circle class="knob" cx="${x90}" cy="${Y(0.9)}" r="6"/></g>`);
    if (p) o.push(`<text class="eknee" x="${W - R}" y="${Y(0.5)}" text-anchor="end">knee ${esc(fmtEng(p.fk, 'Hz'))}</text>`);
    const fk = document.activeElement?.closest?.('[data-h]')?.dataset.h;
    edgeSvg.innerHTML = o.join('');
    if (fk === 'tr') edgeSvg.querySelector('[data-h="tr"]')?.focus({ preventScroll: true });
    eGeo = { X, span, t0, W, L, R };
    if (document.activeElement !== trIn) trIn.value = ctx.raw.tr ?? '';
    if (document.activeElement !== erIn) erIn.value = ctx.raw.er ?? '';
    for (const b of rises.children) b.setAttribute('aria-pressed', String(Number(b.dataset.tr) === tr));
    if (p) {
      const pitch = p.pitch * 1e3;
      const nV = 5, fw = 150, step = fw / (nV - 1);
      let fence = '';
      for (let i = 0; i < nV; i++) fence += `<circle cx="${6 + i * step}" cy="9" r="3.4"/>`;
      edgeNums.innerHTML = `<span>λ ${mm(p.lam * 1e3, 3)}</span>`
        + `<span class="fence"><svg viewBox="0 0 ${fw + 12} 26" aria-hidden="true"><path d="M6 9H${fw + 6}"/>${fence}<path class="d" d="M6 20H${6 + step}M6 16v8M${6 + step} 16v8"/></svg><b>${mm(pitch, 3)}</b> stitching pitch λ/20</span>`;
    } else edgeNums.innerHTML = '';
  }
  let frozenEdge = null;

  // ---------------- verdict ----------------
  function drawVerdict() {
    const res = ctx.result || {}, p = res.path;
    const ws = res.warnings || [];
    if (!p) { verdict.innerHTML = `<div class="rp-warns">${ws.map((w) => `<div>${esc(w)}</div>`).join('')}</div>`; return; }
    const [tone, word] = SEV[p.severity];
    let nums = '';
    if (p.loopL != null) {
      const t = !p.reach ? 'bad' : p.frac <= 0.1 ? 'ok' : p.frac <= 0.2 ? 'warn' : 'bad';
      const el = p.kind === 'cap' ? 'capacitor' : ctx.input.scenario === 'connector' ? 'ground pin' : 'return via';
      nums = `<div class="rp-big t-${t}"><b>${p.reach ? fmtNum(p.within * 1e3, 3) : '–'}</b><span>${p.reach ? 'mm' : 'not reachable'}</span></div>
        <div class="rp-bigl">${esc(el)} within, from the signal via</div>
        <dl class="rp-dl">
          <dt>Loop now</dt><dd>${esc(fmtEng(p.loopL, 'H'))}</dd>
          <dt>Reactance at knee</dt><dd class="t-${t}">${fmtNum(p.x, 3)} Ω <small>${fmtNum(p.frac * 100, 2)} % of Z0</small></dd>
          <dt>${p.kind === 'cap' ? 'Capacitors' : 'Return vias'} needed</dt><dd>${p.need} <small>for ${p.n} signal via${p.n > 1 ? 's' : ''}</small></dd>
        </dl>`;
    } else if (p.keep3 != null) {
      const cl = ctx.input.clearance;
      const t = cl < p.keep3 ? 'bad' : cl < p.keep5 ? 'warn' : 'ok';
      nums = `<div class="rp-big t-${t}"><b>${fmtNum(p.keep3, 3)}</b><span>mm</span></div><div class="rp-bigl">keep the trace inside the plane edge (3h; 5h = ${mm(p.keep5)})</div>`;
    }
    const other = ws.filter((w) => !w.startsWith(`${p.title}:`));
    verdict.innerHTML = `<div class="rp-subhead"><b>What happens</b><span class="rp-sev t-${tone}">${esc(word)}</span></div>
      ${nums}
      <p class="rp-what">${esc(p.what)}</p>
      <p class="rp-fix"><b>Fix</b> ${esc(p.fix)}</p>
      ${other.length ? `<div class="rp-warns">${other.map((w) => `<div>${esc(w)}</div>`).join('')}</div>` : ''}
      <details class="rp-notes"><summary>Model (${(res.notes || []).length})</summary>${(res.notes || []).map((n) => `<p>${esc(n)}</p>`).join('')}</details>`;
  }

  function drawAll() { drawRail(); drawStrip(); drawStage(); drawEdge(); drawVerdict(); }

  // ---------------- interaction: stage ----------------
  const pt = (svg, e) => { const r = svg.getBoundingClientRect(); const vb = svg.viewBox.baseVal; return { x: (e.clientX - r.left) * (vb.width / r.width), y: (e.clientY - r.top) * (vb.height / r.height) }; };
  stage.addEventListener('pointerdown', (e) => {
    const hEl = e.target.closest('[data-h]');
    if (!hEl || !sGeo) return;
    e.preventDefault();
    drag = { key: hEl.dataset.h, start: pt(stage, e), v0: ctx.input[hEl.dataset.h] };
    stage.setPointerCapture(e.pointerId);
    hEl.focus({ preventScroll: true });
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || !sGeo) return;
    const q = pt(stage, e);
    const g = sGeo;
    if (drag.key === 'dist') {
      if (g.kind === 'section') {
        const d = (q.x - g.xv) / g.sc;
        const min = (ctx.input.drill > 0 ? ctx.input.drill : 0.3) + 0.05;
        setSoon({ dist: trim(clamp(Math.round(d * 20) / 20, min, 60), 2) });
      } else if (g.kind === 'split') {
        const d = (q.y - g.yT) / g.sc;
        setSoon({ dist: trim(clamp(Math.round(d * 20) / 20, 0.2, 60), 2) });
      }
    } else if (drag.key === 'thick') {
      const t = (q.y - g.y0) / g.sc;
      setSoon({ thick: trim(clamp(Math.round(t * 20) / 20, 0.2, 6), 2) });
    } else if (drag.key === 'clearance') {
      const c = (q.x - g.xe) / g.sc;
      setSoon({ clearance: trim(clamp(Math.round(c * 100) / 100, 0, 50), 2) });
    } else if (drag.key === 'h') {
      const hv = (g.yP - q.y) / g.sc;
      setSoon({ h: trim(clamp(Math.round(hv * 100) / 100, 0.05, 3), 2) });
    }
  });
  const endStage = () => { if (!drag) return; drag = null; frozen = null; drawStage(); };
  stage.addEventListener('pointerup', endStage);
  stage.addEventListener('pointercancel', endStage);
  stage.addEventListener('keydown', (e) => {
    const hEl = e.target.closest?.('[data-h]');
    if (!hEl) return;
    const k = hEl.dataset.h;
    const dir = /Right|Up/.test(e.key) ? 1 : /Left|Down/.test(e.key) ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const big = e.shiftKey ? 10 : 1;
    const v = ctx.input[k];
    if (k === 'dist') ctx.set('dist', trim(clamp((v || 1) + (scen() === 'split' ? -dir : dir) * 0.05 * big, 0.2, 60), 2));
    else if (k === 'thick') ctx.set('thick', trim(clamp((v || 1.6) - dir * 0.05 * big, 0.2, 6), 2));
    else if (k === 'clearance') ctx.set('clearance', trim(clamp((v || 0) + dir * 0.05 * big, 0, 50), 2));
    else if (k === 'h') ctx.set('h', trim(clamp((v || 0.2) + dir * 0.01 * big, 0.05, 3), 2));
  });

  // ---------------- interaction: edge ----------------
  edgeSvg.addEventListener('pointerdown', (e) => {
    const hEl = e.target.closest('[data-h]');
    if (!hEl || !eGeo) return;
    e.preventDefault();
    frozenEdge = { span: eGeo.span };
    drag = { key: 'tr' };
    edgeSvg.setPointerCapture(e.pointerId);
    hEl.focus({ preventScroll: true });
  });
  edgeSvg.addEventListener('pointermove', (e) => {
    if (drag?.key !== 'tr' || !eGeo) return;
    const q = pt(edgeSvg, e);
    const t = ((q.x - eGeo.L) / (eGeo.W - eGeo.L - eGeo.R)) * eGeo.span - eGeo.t0;
    const v = clamp(t, 0.02, 50);
    setSoon({ tr: String(Number(v.toPrecision(v < 1 ? 2 : 2))) });
  });
  const endEdge = () => { if (drag?.key !== 'tr') return; drag = null; frozenEdge = null; drawEdge(); };
  edgeSvg.addEventListener('pointerup', endEdge);
  edgeSvg.addEventListener('pointercancel', endEdge);
  edgeSvg.addEventListener('keydown', (e) => {
    if (!e.target.closest?.('[data-h="tr"]')) return;
    const dir = /Right|Up/.test(e.key) ? 1 : /Left|Down/.test(e.key) ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const v = ctx.input.tr || 1;
    ctx.set('tr', String(Number((v * (dir > 0 ? 1.25 : 0.8)).toPrecision(2))));
    requestAnimationFrame(() => edgeSvg.querySelector('[data-h="tr"]')?.focus());
  });

  ctx.onResult(() => drawAll());
  new ResizeObserver(() => { if (!drag) { drawStage(); drawEdge(); } }).observe(root);
}
