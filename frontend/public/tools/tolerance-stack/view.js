// Tolerance Stack-Up: the page is the loop. Each dimension is a vector laid
// end to end from the datum, + to the right and − to the left, with its
// tolerance band at its head (bands enlarged by one common factor so they can
// be seen and dragged). The last row is the gap: its worst-case and RSS bands
// are those bands summed. Below, the gap's spread against the limits, which
// are dragged too. Every number drawn comes from run()'s result (result.draw).

const NS = 'http://www.w3.org/2000/svg';
const UNITS = ['mm', 'in', 'µm'];

function h(tag, attrs = {}, ...kids) {
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
}
function sv(parent, tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const g = (v, d = 4) => (v == null || !Number.isFinite(v) ? '–' : String(Number(Number(v).toPrecision(d))));
const f = (v) => (v == null || !Number.isFinite(v) ? '–' : String(Math.round(v * 1e6) / 1e6));
const nice = (raw) => {
  const p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
};
const snap = (v, step) => {
  const d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return (Math.round(v / step) * step).toFixed(d).replace(/\.?0+$/, (m) => (m.includes('.') ? '' : m)) || '0';
};
const ppm = (p) => (p < 1e-6 ? '< 1 ppm' : p < 0.01 ? `${g(p * 1e6, 3)} ppm` : `${g(p * 100, 3)} %`);

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  let D = null, res = null;
  let lock = null;       // the scales held still while something is dragged

  const dims = () => structuredClone(ctx.raw.dims || []);
  const setDim = (i, key, v) => { const d = dims(); if (!d[i]) return; d[i][key] = v; ctx.set('dims', d); };

  // ---------- the chain ----------
  const unitSeg = h('span', { class: 'ts-seg', role: 'group', 'aria-label': 'Unit' },
    UNITS.map((u) => h('button', { type: 'button', 'data-u': u, onclick: () => ctx.set('unit', u) }, u)));
  const addBtn = h('button', { type: 'button', class: 'ts-btn', onclick: () => {
    const d = dims(); d.push({ name: `Part ${d.length + 1}`, nominal: '10', plus: '0.1', minus: '0.1', dir: '-' }); ctx.set('dims', d);
    requestAnimationFrame(() => rowsBox.querySelector('.ts-row:not(.hd):not(.res):last-of-type .ts-name input')?.focus());
  } }, '+ Add dimension');
  const rowsBox = h('div', { class: 'ts-rows' });
  const loopFoot = h('div', { class: 'ts-foot' });
  const loop = h('section', { class: 'ts-card ts-loop' },
    h('div', { class: 'ts-head' }, h('span', { class: 'ts-cap grow' }, 'The loop, walked from the datum: + adds to the gap, − takes from it'), unitSeg, addBtn),
    rowsBox, loopFoot);

  // ---------- distribution ----------
  const limIn = (key, label) => {
    const inp = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': label, placeholder: 'none',
      oninput: (e) => ctx.set(key, e.target.value) });
    const w = h('label', { class: 'ts-lf' }, label, inp);
    w.sync = (v) => { if (document.activeElement !== inp) inp.value = v ?? ''; };
    return w;
  };
  const lslF = limIn('lsl', 'at least'), uslF = limIn('usl', 'at most');
  const distSvg = sv(null, 'svg', { role: 'group', 'aria-label': 'Spread of the result against its limits' });
  const distBox = h('div', { class: 'ts-box' }, distSvg);
  const dist = h('section', { class: 'ts-card ts-dist' },
    h('div', { class: 'ts-head' }, h('span', { class: 'ts-cap grow' }, 'The result: RSS spread (normal, band = ±3σ) and ranges · drag the red limits'), lslF, uslF),
    distBox);

  // ---------- side ----------
  const read = h('div', { class: 'ts-card ts-read' });
  const warns = h('div', { class: 'ts-warns', 'aria-live': 'polite' });
  root.append(h('div', { class: 'ts' }, loop, dist, h('aside', { class: 'ts-side' }, read, warns, ctx.outputs)));

  // ---------- rows (kept while the count is the same, so typing is not interrupted) ----------
  let rowEls = [];
  let resRow = null;
  const hdRow = h('div', { class: 'ts-row hd' }, h('span', {}, 'Dir'), h('span', {}, 'Dimension'), h('span', {}, ''),
    h('span', {}, 'Nominal'), h('span', {}, '+ tol'), h('span', {}, '− tol'), h('span', { style: 'text-align:left' }, 'Share of RSS'), h('span', {}, ''));
  function buildRows(n) {
    rowEls = Array.from({ length: n }, (_, i) => {
      const dir = h('button', { type: 'button', class: 'ts-dir', title: 'Direction: click to flip',
        onclick: () => { const d = dims(); d[i].dir = String(d[i].dir).trim().startsWith('-') ? '+' : '-'; ctx.set('dims', d); } });
      const inp = (key, cls, label) => h('input', { type: 'text', spellcheck: 'false', class: cls, 'aria-label': label,
        inputmode: cls ? 'decimal' : null, oninput: (e) => setDim(i, key, e.target.value) });
      const name = inp('name', '', 'Dimension name');
      const nom = inp('nominal', 'num', 'Nominal'), plus = inp('plus', 'num', '+ tolerance'), minus = inp('minus', 'num', '− tolerance');
      const svg = sv(null, 'svg', { 'data-row': i, role: 'group', 'aria-label': 'Vector of this dimension' });
      const share = h('div', { class: 'ts-share' });
      const del = h('button', { type: 'button', class: 'ts-del', title: 'Remove', 'aria-label': 'Remove this dimension',
        onclick: () => { const d = dims(); d.splice(i, 1); ctx.set('dims', d); } }, '×');
      const el = h('div', { class: 'ts-row' }, dir, h('div', { class: 'ts-name' }, name), h('div', { class: 'ts-track' }, svg),
        h('label', { class: 'ts-nom' }, h('span', { class: 'nl' }, 'nominal'), nom), h('label', { class: 'ts-plus' }, h('span', { class: 'nl' }, '+ tol'), plus),
        h('label', { class: 'ts-minus' }, h('span', { class: 'nl' }, '− tol'), minus), share, del);
      return { el, dir, name, nom, plus, minus, svg, share };
    });
    const rsvg = sv(null, 'svg', { role: 'img', 'aria-label': 'The result vector with its summed bands' });
    const rval = h('div', { class: 'ts-resval' });
    resRow = { el: h('div', { class: 'ts-row res' }, h('div', { class: 'ts-resname' }, 'Result (gap)'), h('div', { class: 'ts-track' }, rsvg), rval), svg: rsvg, val: rval };
    rowsBox.replaceChildren(hdRow, ...rowEls.map((r) => r.el), resRow.el);
  }

  // shared scales of the chain: position → px, and px per unit of tolerance
  function scales() {
    if (lock) return lock;
    const W = Math.max(120, rowEls[0]?.svg.clientWidth || resRow?.svg.clientWidth || 400);
    const xs = [0, ...D.rows.flatMap((r) => [r.start, r.end])];
    let lo = Math.min(...xs), hi = Math.max(...xs);
    const span = hi - lo || 1;
    const padL = 46, padR = 46;
    const mx = (W - padL - padR);
    // tolerance magnification: the result's worst-case band gets about a quarter of the track
    const k = D.wc > 0 ? Math.min((mx * 0.26) / (2 * D.wc), 1e9) : 1;
    // leave room at both ends for the widest band
    const bandPx = Math.max(...D.rows.map((r) => Math.max(r.a, r.b) * k), D.wc * k, 8) + 6;
    const pl = padL + bandPx * (Math.min(...D.rows.map((r) => r.end)) <= lo + 1e-9 ? 1 : 0.3);
    const pr = padR + bandPx;
    const X = (v) => pl + ((v - lo) / span) * (W - pl - pr);
    return { W, lo, hi, span, X, k, ppu: (W - pl - pr) / span, inv: (px) => lo + ((px - pl) / (W - pl - pr)) * span };
  }

  function drawTrack(row, r, S) {
    const svg = row.svg; svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${S.W} 44`);
    const y = 22;
    sv(svg, 'line', { x1: S.X(0), x2: S.X(0), y1: 2, y2: 42, class: 'ts-datum' });
    sv(svg, 'line', { x1: S.X(D.nominal), x2: S.X(D.nominal), y1: 2, y2: 42, class: 'ts-guide' });
    if (!r) { sv(svg, 'text', { x: S.X(0) + 6, y: y + 4, class: 'ts-t' }, 'incomplete: give nominal, + and − tolerance'); return; }
    const c = r.s > 0 ? 'p' : 'm';
    const x0 = S.X(r.start), x1 = S.X(r.end);
    // the band at the head: + makes the dimension longer (further along its direction)
    const xp = x1 + r.s * r.a * S.k, xm = x1 - r.s * r.b * S.k;
    sv(svg, 'rect', { x: Math.min(xp, xm), y: y - 8, width: Math.max(1, Math.abs(xp - xm)), height: 16, rx: 2, class: `ts-band ${c}` });
    sv(svg, 'line', { x1: x0, x2: x1 - r.s * 7, y1: y, y2: y, class: `ts-arrow ${c}` });
    sv(svg, 'path', { d: `M${x1},${y} l${-r.s * 9},-5 v10 z`, class: `ts-ah ${c}` });
    sv(svg, 'line', { x1: x0, x2: x0, y1: y - 6, y2: y + 6, class: `ts-arrow ${c}` });
    // length label on the vector
    const mid = (x0 + x1) / 2;
    if (Math.abs(x1 - x0) > 40) sv(svg, 'text', { x: mid, y: y - 6, 'text-anchor': 'middle', class: 'ts-t' }, `${r.s > 0 ? '+' : '−'}${g(r.N, 6)}`);
    // head handle (nominal) and the two tabs (tolerances)
    const hh = sv(svg, 'g', { class: 'ts-head-h', tabindex: 0, role: 'slider', 'data-h': `n${r.i}`, 'aria-label': `${r.name} nominal`, 'aria-valuenow': r.N });
    sv(hh, 'circle', { cx: x1, cy: y, r: 9 });
    const tab = (kind, x, yy, val) => {
      const t = sv(svg, 'g', { class: `ts-tab ${c}`, tabindex: 0, role: 'slider', 'data-h': `${kind}${r.i}`,
        'aria-label': `${r.name} ${kind === 'p' ? 'plus' : 'minus'} tolerance`, 'aria-valuenow': val });
      sv(t, 'rect', { x: x - 7, y: yy - 7, width: 14, height: 14, fill: 'transparent' });
      sv(t, 'rect', { x: x - 2.5, y: yy - 5, width: 5, height: 10, rx: 1.5, class: 'v' });
      return t;
    };
    tab('p', xp, y - 13, r.a);
    tab('m', xm, y + 13, r.b);
    // tolerance texts beside the band
    const right = r.s > 0;
    const tx = right ? Math.max(xp, xm) + 6 : Math.min(xp, xm) - 6;
    sv(svg, 'text', { x: tx, y: y - 2, 'text-anchor': right ? 'start' : 'end', class: 'ts-t' }, `+${g(r.a)}`);
    sv(svg, 'text', { x: tx, y: y + 10, 'text-anchor': right ? 'start' : 'end', class: 'ts-t' }, `−${g(r.b)}`);
  }

  function drawResult(S) {
    const svg = resRow.svg; svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${S.W} 44`);
    const y = 22;
    const x0 = S.X(0), x1 = S.X(D.nominal);
    sv(svg, 'line', { x1: x0, x2: x0, y1: 2, y2: 42, class: 'ts-datum' });
    // the summed bands around the head, same enlargement as the rows
    const at = (v) => x1 + (v - D.nominal) * S.k;
    sv(svg, 'rect', { x: at(D.mean - D.wc), y: y - 9, width: Math.max(1, 2 * D.wc * S.k), height: 18, rx: 2, class: 'ts-wc' });
    sv(svg, 'rect', { x: at(D.mean - D.rss), y: y - 9, width: Math.max(1, 2 * D.rss * S.k), height: 18, rx: 2, class: 'ts-rss' });
    const dir = D.nominal >= 0 ? 1 : -1;
    if (Math.abs(x1 - x0) > 10) sv(svg, 'line', { x1: x0, x2: x1 - dir * 8, y1: y, y2: y, class: 'ts-arrow r' });
    sv(svg, 'path', { d: `M${x1},${y} l${-dir * 10},-6 v12 z`, class: 'ts-ah r' });
    const wr = at(D.mean + D.wc), wl = at(D.mean - D.wc);
    const lr = S.W - wr > 70;
    sv(svg, 'text', { x: lr ? wr + 6 : wl - 6, y: y + 4, 'text-anchor': lr ? 'start' : 'end', class: 'ts-tb' }, `gap ${g(D.nominal, 5)}`);
    for (const [v, t] of [[D.lsl, 'min'], [D.usl, 'max']]) {
      if (v == null) continue;
      const x = clamp(at(v), 2, S.W - 2);
      sv(svg, 'line', { x1: x, x2: x, y1: 4, y2: 40, class: 'ts-lim' });
      let sd = t === 'min' ? -1 : 1;
      if (x + sd * 30 < 0 || x + sd * 30 > S.W) sd = -sd;
      sv(svg, 'text', { x: x + sd * 4, y: 10, 'text-anchor': sd < 0 ? 'end' : 'start', class: 'ts-lim-t' }, t);
    }
  }

  function drawChain() {
    const n = (ctx.raw.dims || []).length;
    if (rowEls.length !== n || !resRow) buildRows(n);
    const raw = ctx.raw.dims || [];
    rowEls.forEach((row, i) => {
      const d = raw[i] || {};
      const minus = String(d.dir || '+').trim().startsWith('-') || String(d.dir).trim().startsWith('−');
      row.dir.textContent = minus ? '−' : '+';
      row.dir.className = `ts-dir ${minus ? 'm' : 'p'}`;
      row.dir.setAttribute('aria-label', `Direction ${minus ? 'minus' : 'plus'}: click to flip`);
      for (const [el, key] of [[row.name, 'name'], [row.nom, 'nominal'], [row.plus, 'plus'], [row.minus, 'minus']]) {
        if (document.activeElement !== el) el.value = d[key] ?? '';
      }
    });
    if (!D) return;
    const S = scales();
    const top = D.rows.reduce((b, r) => (r.rssShare > (b?.rssShare ?? -1) ? r : b), null);
    rowEls.forEach((row, i) => {
      const r = D.rows.find((x) => x.i === i);
      for (const el of [row.nom, row.plus, row.minus]) el.classList.toggle('bad', !r && String(el.value).trim() === '');
      drawTrack(row, r, S);
      row.share.className = `ts-share${r && r === top ? ' top' : ''}`;
      row.share.replaceChildren(...(r ? [
        h('div', { class: 'ts-bar', title: `RSS share ${g(r.rssShare, 3)} %, worst-case share ${g(r.wcShare, 3)} %` },
          h('i', { style: `width:${clamp(r.rssShare, 0, 100)}%` }), h('u', { style: `left:${clamp(r.wcShare, 0, 100)}%` })),
        h('small', {}, `${g(r.rssShare, 2)} % · wc ${g(r.wcShare, 2)} %`)] : []));
    });
    drawResult(S);
    resRow.val.replaceChildren(h('b', {}, g(D.mean, 6)), ` mean · ±${g(D.wc)} wc · ±${g(D.rss)} rss`);
    loopFoot.replaceChildren(
      h('span', {}, `Lengths to scale · tolerance bands drawn ×${g(S.k / S.ppu, 3)}`),
      h('span', {}, 'Drag an arrow head for the nominal, the small tabs for + and − tolerance · click + / − to flip'),
      h('span', {}, 'Share bar: RSS share, tick = worst-case share'));
  }

  // pointer: heads and tabs
  rowsBox.addEventListener('pointerdown', (e) => {
    const svg = e.target.closest?.('svg[data-row]');
    if (!svg || !D) return;
    const i = Number(svg.dataset.row);
    const r = D.rows.find((x) => x.i === i);
    if (!r) return;
    const tabEl = e.target.closest('.ts-tab'), headEl = e.target.closest('.ts-head-h');
    if (!tabEl && !headEl) return;
    lock = scales();
    const S = lock, rect = svg.getBoundingClientRect(), fx = S.W / rect.width;
    const x1 = S.X(r.end);
    const stepN = nice((S.span / S.W) * 3), stepT = nice(3 / S.k);
    const kind = tabEl ? (tabEl.dataset.h.startsWith('p') ? 'plus' : 'minus') : 'nominal';
    capture(svg, e); e.preventDefault();
    const move = (ev) => {
      const px = (ev.clientX - rect.left) * fx;
      if (kind === 'nominal') {
        const N = r.s * (S.inv(px) - r.start);
        setDim(i, 'nominal', snap(Math.max(stepN, N), stepN));
      } else {
        const t = (kind === 'plus' ? r.s : -r.s) * (px - x1) / S.k;
        setDim(i, kind, snap(Math.max(0, t), stepT));
      }
    };
    const up = () => {
      lock = null; drawChain();
      svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); svg.removeEventListener('pointercancel', up);
    };
    svg.addEventListener('pointermove', move); svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
  });
  rowsBox.addEventListener('keydown', (e) => {
    const hEl = e.target.closest?.('[data-h]');
    if (!hEl || !D) return;
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const key = hEl.dataset.h, i = Number(key.slice(1)), r = D.rows.find((x) => x.i === i);
    if (!r) return;
    const S = scales();
    if (key[0] === 'n') {
      const st = nice((S.span / S.W) * 3) * (e.shiftKey ? 10 : 1);
      setDim(i, 'nominal', snap(Math.max(st, r.N + d * r.s * st), st));
    } else {
      const st = nice(3 / S.k) * (e.shiftKey ? 10 : 1);
      const k = key[0] === 'p' ? 'plus' : 'minus', cur = key[0] === 'p' ? r.a : r.b;
      const dd = key[0] === 'p' ? d * r.s : -d * r.s;
      setDim(i, k, snap(Math.max(0, cur + dd * st), st));
    }
  });

  // ---------- distribution ----------
  let dGeo = null;
  function drawDist() {
    const svg = distSvg; svg.replaceChildren();
    const W = Math.max(280, distBox.clientWidth || 600), H = Math.max(160, distBox.clientHeight || 220);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!D) return;
    const narrow = W < 520;
    const [xlo, xhi] = lock?.dRange || D.xRange;
    const mL = 14, mR = 14, top = 22, barsH = narrow ? 50 : 54, axisY = H - barsH - 18;
    const X = (v) => mL + ((v - xlo) / (xhi - xlo)) * (W - mL - mR);
    dGeo = { X, inv: (px) => xlo + ((px - mL) / (W - mL - mR)) * (xhi - xlo), range: [xlo, xhi], W };
    const step = nice((xhi - xlo) / (narrow ? 4 : 8));
    for (let v = Math.ceil(xlo / step) * step; v <= xhi + 1e-12; v += step) {
      sv(svg, 'line', { x1: X(v), x2: X(v), y1: top, y2: axisY, class: 'ts-grid' });
      sv(svg, 'text', { x: X(v), y: axisY + 13, 'text-anchor': 'middle', class: 'ts-t' }, g(v, 4));
    }
    sv(svg, 'line', { x1: mL, x2: W - mR, y1: axisY, y2: axisY, class: 'ts-axis' });
    sv(svg, 'text', { x: W - mR, y: top - 8, 'text-anchor': 'end', class: 'ts-t' }, `result, ${D.unit}`);
    // curve with the tails out of spec shaded
    if (D.curve) {
      const pmax = Math.max(...D.curve.map((p) => p[1]));
      const Yc = (p) => axisY - (p / pmax) * (axisY - top - 14);
      const path = (pts) => pts.map((p, k) => `${k ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Yc(p[1]).toFixed(1)}`).join(' ');
      sv(svg, 'path', { d: `${path(D.curve)} L${X(D.curve.at(-1)[0])},${axisY} L${X(D.curve[0][0])},${axisY} Z`, class: 'ts-curve' });
      const tail = (pts) => { if (pts.length > 1) sv(svg, 'path', { d: `${path(pts)} L${X(pts.at(-1)[0])},${axisY} L${X(pts[0][0])},${axisY} Z`, class: 'ts-outfill' }); };
      if (D.lsl != null) tail(D.curve.filter((p) => p[0] <= D.lsl));
      if (D.usl != null) tail(D.curve.filter((p) => p[0] >= D.usl));
      sv(svg, 'line', { x1: X(D.mean), x2: X(D.mean), y1: Yc(pmax) - 4, y2: axisY, class: 'ts-mark' });
      sv(svg, 'text', { x: X(D.mean), y: Yc(pmax) - 8, 'text-anchor': 'middle', class: 'ts-tb' }, `mean ${g(D.mean, 5)}`);
    }
    // ranges as bars under the axis
    const bars = [['wc', 'worst case', D.wc, D.lim?.wcOk], ['mrss', 'mod. RSS', D.mrss, null], ['rss', 'RSS ±3σ', D.rss, D.lim?.rsOk]];
    bars.forEach(([cls, label, half, ok], k) => {
      const y = axisY + 20 + k * (narrow ? 11 : 12);
      const a = X(D.mean - half), b = X(D.mean + half);
      sv(svg, 'rect', { x: a, y, width: Math.max(1, b - a), height: 8, rx: 2, class: `ts-rbar ${cls}${ok === false ? ' bad' : ''}` });
      const txt = narrow ? label : `${label} ${g(D.mean - half, 4)} … ${g(D.mean + half, 4)}`;
      const tw = txt.length * 6.5 + 8;
      const [tx, ta] = W - mR - b > tw ? [b + 6, 'start'] : a - mL > tw ? [a - 6, 'end'] : [W - mR, 'end'];
      sv(svg, 'text', { x: tx, y: y + 8, 'text-anchor': ta, class: 'ts-t' }, txt);
    });
    // nominal
    sv(svg, 'path', { d: `M${X(D.nominal)},${axisY} l-4,6 h8 z`, class: 'ts-ah r' });
    // limits, dragged
    for (const [key, v, name] of [['lsl', D.lsl, 'min'], ['usl', D.usl, 'max']]) {
      if (v == null) continue;
      const x = X(v);
      const gEl = sv(svg, 'g', { class: 'ts-limh', tabindex: 0, role: 'slider', 'data-h': key, 'aria-label': `Result must be ${name === 'min' ? 'at least' : 'at most'}`, 'aria-valuenow': v });
      sv(gEl, 'rect', { x: x - 9, y: top - 6, width: 18, height: axisY - top + 10, class: 'hit' });
      sv(gEl, 'line', { x1: x, x2: x, y1: top, y2: axisY + 4, class: 'ts-lim' });
      sv(gEl, 'path', { d: `M${x},${top + 2} l-6,-9 h12 z`, class: 'grip' });
      let side = name === 'min' ? -1 : 1;
      if (x + side * 90 < 0 || x + side * 90 > W) side = -side;
      const out = name === 'min' ? D.lim?.outLo : D.lim?.outHi;
      sv(svg, 'text', { x: x + side * 8, y: top + 10, 'text-anchor': side < 0 ? 'end' : 'start', class: 'ts-lim-t' }, `${name} ${g(v, 5)}`);
      if (out != null) sv(svg, 'text', { x: x + side * 8, y: top + 24, 'text-anchor': side < 0 ? 'end' : 'start', class: 'ts-lim-t' }, `out ${ppm(out)}`);
    }
  }
  distSvg.addEventListener('pointerdown', (e) => {
    const gEl = e.target.closest?.('.ts-limh');
    if (!gEl || !dGeo) return;
    const key = gEl.dataset.h;
    const rect = distSvg.getBoundingClientRect(), fx = dGeo.W / rect.width;
    const G = { ...dGeo };
    lock = { ...(lock || {}), dRange: G.range };
    const st = nice((G.range[1] - G.range[0]) / 200);
    capture(distSvg, e); e.preventDefault();
    const move = (ev) => {
      const v = snap(G.inv((ev.clientX - rect.left) * fx), st);
      if (v !== String(ctx.raw[key])) ctx.set(key, v);
    };
    const up = () => {
      lock = null; drawAll();
      distSvg.removeEventListener('pointermove', move); distSvg.removeEventListener('pointerup', up); distSvg.removeEventListener('pointercancel', up);
    };
    distSvg.addEventListener('pointermove', move); distSvg.addEventListener('pointerup', up); distSvg.addEventListener('pointercancel', up);
  });
  distSvg.addEventListener('keydown', (e) => {
    const gEl = e.target.closest?.('.ts-limh');
    if (!gEl || !D || !dGeo) return;
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const st = nice((dGeo.range[1] - dGeo.range[0]) / 100) * (e.shiftKey ? 10 : 1);
    const key = gEl.dataset.h;
    ctx.set(key, snap(D[key] + d * st, st));
  });

  // ---------- side ----------
  function drawSide() {
    read.replaceChildren();
    if (!D) return;
    const L = D.lim;
    const tag = (ok, t) => h('span', { class: `ts-tag ${ok ? 'ok' : 'bad'}` }, t ?? (ok ? 'passes' : 'fails'));
    const row = (k, v, extra) => [h('dt', {}, k), h('dd', {}, v, extra || null)];
    read.append(
      h('div', { class: 'ts-cap' }, 'Result, worst case'),
      h('div', { class: 'ts-big' }, `${g(D.mean, 5)}`, h('small', {}, `± ${g(D.wc)} ${D.unit}`)),
      h('div', { class: 'ts-sub' }, `${g(D.mean - D.wc, 5)} … ${g(D.mean + D.wc, 5)} ${D.unit} · nominal ${g(D.nominal, 6)}`),
      h('dl', { class: 'ts-dl' },
        row('Worst case', `${g(D.mean - D.wc, 5)} … ${g(D.mean + D.wc, 5)}`, L ? tag(L.wcOk) : null),
        row('RSS ±3σ', `${g(D.mean - D.rss, 5)} … ${g(D.mean + D.rss, 5)}`, L ? tag(L.rsOk) : null),
        row('Modified RSS', `${g(D.mean - D.mrss, 5)} … ${g(D.mean + D.mrss, 5)}`),
        ...(L ? [row('Limits', `${D.lsl != null ? g(D.lsl, 5) : '−∞'} … ${D.usl != null ? g(D.usl, 5) : '+∞'}`),
          row('Out of spec', ppm(L.out), h('span', { class: `ts-tag ${L.out < 0.00135 ? 'ok' : L.out < 0.01 ? 'warn' : 'bad'}` }, L.out < 0.00135 ? 'ok' : 'high'))] : []),
        row('σ', `${g(D.sigma, 3)} ${D.unit}`)));
  }

  function drawAll() {
    const fk = document.activeElement?.dataset?.h;
    drawChain(); drawDist(); drawSide();
    warns.replaceChildren(...(res?.warnings || []).map((w) => h('div', {}, w)));
    if (fk) root.querySelector(`[data-h="${fk}"]`)?.focus();
  }
  ctx.onResult((r) => {
    res = r; D = r?.draw || null;
    const raw = ctx.raw;
    lslF.sync(raw.lsl); uslF.sync(raw.usl);
    unitSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.u === (raw.unit || 'mm'))));
    drawAll();
  });
  let rt = 0;
  new ResizeObserver(() => { cancelAnimationFrame(rt); rt = requestAnimationFrame(drawAll); }).observe(root);
}
