// Board Cost Estimator page: the board on the bench, priced part by part.
// The plan view is the board to scale - drag its edges to resize it - with
// the priced features drawn on it (gold fingers, castellations, via-in-pad,
// the controlled-impedance pair) that you click to add or remove. Under it,
// the board's edge in section: layers, thickness, copper, the smallest drill
// and trace. Click any part and the inspector lists its options, each with
// what it would do to the price per board. The quote slip on the right and
// the quantity curve (drag the dot) are run()'s result; every "+12 %" is
// run() again with that one choice changed.
import { run } from './tool.js';

const NS = 'http://www.w3.org/2000/svg';
const NICE = [1, 2, 3, 5, 8, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 120, 150, 200, 250, 300, 400, 500, 600, 750, 1000,
  1200, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7500, 10000, 15000, 20000, 25000, 50000];
const FINISH_COL = { hasl: 'var(--tool-hasl)', haslf: 'var(--tool-hasl)', osp: 'var(--tool-osp)', enig: 'var(--tool-enig)',
  silver: 'var(--tool-silver)', hardgold: 'var(--tool-hardgold)' };
const SHORT = {
  trace: { 6: '≥ 6 mil', 5: '5 mil', 4: '4 mil', 3: '3 mil' },
  drill: { '0.3': '≥ 0.3 mm', '0.25': '0.25 mm', '0.2': '0.2 mm', '0.15': '0.15 mm' },
  lead: { standard: 'Standard', quick: 'Quick 2-3 d', express: 'Express 24 h' },
  region: { asia: 'Asian online', local: 'US / EU quick-turn' },
  color: { green: 'Green', other: 'Other colour' },
};
const PARTS = {
  size: { title: 'Board outline', note: 'Drag the right edge, the bottom edge or the corner on the drawing; arrow keys on a focused handle (Shift for 10 mm).' },
  color: { key: 'color', title: 'Solder mask', note: 'Green is the base price; other colours run a little slower.' },
  finish: { key: 'finish', title: 'Surface finish', note: 'What the exposed copper is plated with: drawn on the pads.' },
  layers: { key: 'layers', title: 'Copper layers', note: 'The biggest lever on price: every step adds setup and raises the per-area rate.' },
  thick: { key: 'thick', title: 'Board thickness', note: '0.8-1.6 mm is standard; thinner and thicker boards cost extra.' },
  copper: { key: 'copper', title: 'Outer copper weight', note: 'Heavier copper carries more current but etches slower; priced on area.' },
  trace: { key: 'trace', title: 'Smallest trace / space', note: 'Below 6 mil the yield drops and the price rises.' },
  drill: { key: 'drill', title: 'Smallest mechanical drill', note: 'Small drills break more often and drill slower.' },
  impedance: { key: 'impedance', bool: true, title: 'Impedance control', note: 'The fab adjusts widths to hit your impedance and tests a coupon (±10 %).' },
  viainpad: { key: 'viainpad', bool: true, title: 'Via-in-pad, filled and capped', note: 'Vias inside the BGA pads, filled and plated over so they can be soldered.' },
  blind: { key: 'blind', bool: true, title: 'Blind / buried vias', note: 'Vias that stop at an inner layer: extra drilling and lamination. Needs 4 or more layers.' },
  castellated: { key: 'castellated', bool: true, title: 'Castellated holes', note: 'Plated half-holes on the edge, for a module soldered onto another board.' },
  fingers: { key: 'fingers', bool: true, title: 'Gold fingers, bevelled', note: 'Hard-gold edge contacts with a bevelled edge, for a card-edge connector.' },
};
const PRESETS = [[50, 50], [100, 80], [100, 100], [160, 100], [200, 150]];

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const svgEl = (cls, label) => { const s = document.createElementNS(NS, 'svg'); if (cls) s.setAttribute('class', cls); s.setAttribute('role', 'group'); if (label) s.setAttribute('aria-label', label); return s; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = (s) => { const n = parseFloat(String(s ?? '').replace(/[^0-9.eE+-]/g, '')); return Number.isFinite(n) ? n : null; };
const r1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const money = (v) => (v == null ? '–' : v >= 1000 ? Math.round(v).toLocaleString('en-US') : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const pctTxt = (p) => (p == null ? '' : Math.abs(p) < 0.5 ? '±0 %' : `${p > 0 ? '+' : '−'}${Math.abs(p) < 10 ? Math.abs(p).toFixed(1) : Math.round(Math.abs(p))} %`);

export function page(root, ctx) {
  let sel = 'layers', drag = null, qdrag = false;

  const optsOf = (key) => (ctx.manifest.inputs.find((d) => d.key === key)?.options || []).map((o) => (Array.isArray(o) ? o : [String(o), String(o)]));
  const perOf = (res) => num(res?.values?.find((v) => v.label === 'Per board')?.value);
  const val = (res, lab) => res?.values?.find((v) => v.label.startsWith(lab));
  // what one change would do to the price per board: run() with that change
  const perWith = (patch) => { try { return perOf(run({ ...ctx.input, ...patch })); } catch { return null; } };
  const pctWith = (patch) => { const now = perOf(ctx.result), p = perWith(patch); return now && p != null ? (p / now - 1) * 100 : null; };
  const warnFlags = (ws = []) => ({
    outline: ws.some((w) => /500 mm|Under 10 mm/.test(w)),
    blind: ws.some((w) => /Blind\/buried/.test(w)),
    single: ws.some((w) => /Single-sided/.test(w)),
    trace: ws.some((w) => /3 mil/.test(w)),
  });

  // ---------------- skeleton ----------------
  const plan = svgEl('', 'Board, top view'), sect = svgEl('', 'Board edge in section');
  const planBox = el('div', { class: 'bc-plan' }, plan, el('div', { class: 'bc-cap' }, 'Top view · to scale'));
  const sectBox = el('div', { class: 'bc-sect' }, sect, el('div', { class: 'bc-cap' }, 'Edge in section · thickness exaggerated'));
  const insp = el('div', { class: 'bc-insp', 'aria-live': 'polite' });
  const bench = el('section', { class: 'bc-panel bc-bench' },
    el('div', { class: 'bc-hint' }, 'Drag the board edges to resize it. Click a part of the board or its section - the mask, the pads, a feature, a layer - to see its options and what each does to the price.'),
    planBox, sectBox, insp);

  const slip = el('div', { class: 'bc-panel bc-slip' });
  const qsvg = svgEl('', 'Price per board against quantity');
  const qIn = el('input', { inputmode: 'numeric', spellcheck: 'false', 'aria-label': 'Quantity' });
  qIn.addEventListener('change', () => ctx.set('qty', qIn.value.trim()));
  const qCap = el('span', {});
  const qty = el('div', { class: 'bc-panel bc-qty' }, el('div', { class: 'bc-qty-h' }, el('b', {}, 'Quantity'), qIn, el('span', { class: 'grow' }), qCap), qsvg);
  const warns = el('div', { class: 'bc-warns', 'aria-live': 'polite' });
  const notes = el('details', { class: 'bc-notes' });
  const quote = el('aside', { class: 'bc-quote' }, slip, qty, warns, ctx.outputs, notes);
  root.append(el('div', { class: 'bc' }, bench, quote));

  // ---------------- plan view ----------------
  function planGeom(W, H, w, h) {
    const narrow = W < 520;
    const ml = narrow ? 12 : 26, mr = narrow ? 44 : 64, mt = narrow ? 56 : 50, mb = 30;
    const aw = W - ml - mr, ah = H - mt - mb;
    const s = Math.max(0.05, Math.min(aw / Math.max(w, 20), ah / Math.max(h, 20)));
    return { s, bx: ml + (aw - w * s) / 2, by: mt + (ah - h * s) / 2, narrow, maxX: W - mr + 30, maxY: H - 8 };
  }

  function renderPlan() {
    const W = planBox.clientWidth, H = planBox.clientHeight;
    if (!W || !H) return;
    const inp = ctx.input, res = ctx.result || {};
    const w = inp.w > 0 ? inp.w : 100, h = inp.h > 0 ? inp.h : 80;
    const G = drag ? { ...drag.G } : planGeom(W, H, w, h);
    const { s } = G, bx = G.bx, by = G.by, bw = w * s, bh = h * s, u = Math.min(bw, bh);
    const wf = warnFlags(res.warnings);
    const green = inp.color !== 'other';
    const mask = green ? 'var(--tool-mask)' : 'var(--tool-mask-alt)', edge = green ? 'var(--tool-mask-edge)' : 'var(--tool-mask-alt-edge)';
    const tr = green ? 'var(--tool-mask-trace)' : 'var(--tool-mask-alt-trace)';
    const fin = FINISH_COL[inp.finish] || 'var(--tool-hasl)';
    const o = [];
    const hot = (part, label, inner, box) => `<g class="hot${sel === part ? ' sel' : ''}" data-part="${part}" tabindex="0" role="button" aria-label="${esc(label)}">`
      + (box ? `<rect class="ring" x="${box[0] - 4}" y="${box[1] - 4}" width="${box[2] + 8}" height="${box[3] + 8}" rx="4"/>` : '') + inner + `<title>${esc(label)}</title></g>`;
    // labels on the board read like its silkscreen legend
    const tag = (x, y, text, on, anchor = 'start', cls = '') => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="11" fill="${cls === 'bad' ? 'var(--tool-bad-silk)' : 'var(--tool-silk)'}" ${on || cls === 'bad' ? 'font-weight="600"' : 'opacity=".78"'} pointer-events="none">${esc(text)}</text>`;
    const featPct = (key) => { const on = !!inp[key]; const p = on ? pctWith({ [key]: false }) : pctWith({ [key]: true }); return p == null ? '' : on ? pctTxt(-p / (1 + p / 100)) : pctTxt(p); };

    // body: the mask
    o.push(hot('color', `Solder mask: ${green ? 'green' : 'other colour'}`,
      `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${Math.min(4, u * 0.03)}" fill="${mask}" stroke="${wf.outline ? 'var(--danger)' : edge}" stroke-width="${wf.outline ? 2.5 : 1.5}"/>`, [bx, by, bw, bh]));
    // copper under the mask: a few routed traces
    const T = (fx, fy) => `${(bx + fx * bw).toFixed(1)},${(by + fy * bh).toFixed(1)}`;
    const traces = [[[0.08, 0.2], [0.2, 0.2], [0.24, 0.26]], [[0.52, 0.16], [0.6, 0.16], [0.63, 0.24]], [[0.08, 0.72], [0.3, 0.72], [0.36, 0.64]],
      [[0.82, 0.62], [0.9, 0.62], [0.9, 0.78]], [[0.44, 0.58], [0.44, 0.7], [0.62, 0.7]], [[0.12, 0.44], [0.19, 0.44]]];
    o.push(`<g pointer-events="none" stroke="${tr}" stroke-width="${clamp(u * 0.012, 1.2, 3)}" fill="none" stroke-linejoin="round">${traces.map((t) => `<polyline points="${t.map((p) => T(...p)).join(' ')}"/>`).join('')}</g>`);
    // mounting holes (plated, finish on the ring)
    const hr = clamp(u * 0.035, 2.5, 9), hi = clamp(u * 0.075, 6, 26);
    for (const [x, y] of [[bx + hi, by + hi], [bx + bw - hi, by + hi], [bx + hi, by + bh - hi], [bx + bw - hi, by + bh - hi]]) {
      o.push(`<circle cx="${x}" cy="${y}" r="${hr * 1.6}" fill="${fin}" pointer-events="none"/><circle cx="${x}" cy="${y}" r="${hr}" fill="var(--tool-hole)" pointer-events="none"/>`);
    }

    // BGA: via-in-pad, or dog-bone vias beside the pads
    {
      const n = 5, sz = u * 0.26, cx = bx + bw * 0.28, cy = by + bh * 0.42, p = sz / (n - 1), pr = clamp(p * 0.28, 1.2, 7);
      const on = !!inp.viainpad, bad = on && wf.single;
      let g = `<rect x="${cx - sz / 2 - p * 0.6}" y="${cy - sz / 2 - p * 0.6}" width="${sz + p * 1.2}" height="${sz + p * 1.2}" fill="none" stroke="var(--tool-silk)" stroke-width="1" opacity=".85"/>`;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const x = cx - sz / 2 + i * p, y = cy - sz / 2 + j * p;
        if (!on) g += `<line x1="${x}" y1="${y}" x2="${x + p / 2}" y2="${y + p / 2}" stroke="${tr}" stroke-width="${Math.max(1, pr * 0.5)}"/><circle cx="${x + p / 2}" cy="${y + p / 2}" r="${pr * 0.62}" fill="${tr}" stroke="${edge}" stroke-width=".6"/>`;
        g += `<circle cx="${x}" cy="${y}" r="${pr}" fill="${fin}"/>`;
        if (on) g += `<circle cx="${x}" cy="${y}" r="${pr * 0.42}" fill="none" stroke="${bad ? 'var(--danger)' : 'rgba(0,0,0,.45)'}" stroke-width="${Math.max(0.8, pr * 0.2)}"/>`;
      }
      o.push(hot('viainpad', `Via-in-pad: ${on ? 'on' : 'off'} (Enter toggles)`, g, [cx - sz / 2 - p * 0.6, cy - sz / 2 - p * 0.6, sz + p * 1.2, sz + p * 1.2]));
      o.push(tag(cx - sz / 2 - p * 0.6, cy - sz / 2 - p * 0.6 - 6, `${on ? '' : '+ '}via-in-pad ${featPct('viainpad')}`, on, 'start', bad ? 'bad' : ''));
    }
    // QFP: the pads show the finish
    {
      const sz = u * 0.26, cx = bx + bw * 0.7, cy = by + bh * 0.42, n = 8, pl = sz * 0.2, pw = (sz * 0.75) / n * 0.55;
      let g = `<rect x="${cx - sz / 2}" y="${cy - sz / 2}" width="${sz}" height="${sz}" fill="none" stroke="var(--tool-silk)" stroke-width="1" opacity=".85"/>`
        + `<circle cx="${cx - sz / 2 + sz * 0.12}" cy="${cy - sz / 2 + sz * 0.12}" r="${Math.max(1.2, sz * 0.03)}" fill="var(--tool-silk)"/>`;
      for (let i = 0; i < n; i++) {
        const t = -sz * 0.375 + (i + 0.5) * (sz * 0.75) / n;
        g += `<rect x="${cx + t - pw / 2}" y="${cy - sz / 2 - pl}" width="${pw}" height="${pl}" fill="${fin}"/><rect x="${cx + t - pw / 2}" y="${cy + sz / 2}" width="${pw}" height="${pl}" fill="${fin}"/>`
          + `<rect x="${cx - sz / 2 - pl}" y="${cy + t - pw / 2}" width="${pl}" height="${pw}" fill="${fin}"/><rect x="${cx + sz / 2}" y="${cy + t - pw / 2}" width="${pl}" height="${pw}" fill="${fin}"/>`;
      }
      const fl = optsOf('finish').find(([v]) => v === inp.finish)?.[1] || inp.finish;
      o.push(hot('finish', `Surface finish: ${fl}`, g, [cx - sz / 2 - pl, cy - sz / 2 - pl, sz + 2 * pl, sz + 2 * pl]));
      o.push(tag(cx, cy + sz / 2 + pl + 14, fl, false, 'middle'));
    }
    // the pair between them: controlled impedance
    {
      const on = !!inp.impedance, bad = on && wf.single;
      const x1 = bx + bw * 0.28 + u * 0.13 + u * 0.05, x2 = bx + bw * 0.7 - u * 0.13 - u * 0.07, y = by + bh * 0.42, d = clamp(u * 0.018, 1.6, 4);
      const col = bad ? 'var(--danger)' : on ? 'var(--tool-cu)' : tr;
      const path = (dy) => `M${x1},${y + dy}L${x1 + (x2 - x1) * 0.25},${y + dy}L${x1 + (x2 - x1) * 0.35},${y + dy - u * 0.08}L${x1 + (x2 - x1) * 0.65},${y + dy - u * 0.08}L${x1 + (x2 - x1) * 0.75},${y + dy}L${x2},${y + dy}`;
      const g = `<rect x="${x1}" y="${y - u * 0.13}" width="${Math.max(4, x2 - x1)}" height="${u * 0.18}" fill="transparent"/>`
        + `<path d="${path(-d)}" stroke="${col}" stroke-width="${d * 0.8}" fill="none"/><path d="${path(d)}" stroke="${col}" stroke-width="${d * 0.8}" fill="none"/>`;
      o.push(hot('impedance', `Impedance control: ${on ? 'on' : 'off'} (Enter toggles)`, g, [x1, y - u * 0.13, Math.max(4, x2 - x1), u * 0.18]));
      const long = `${on ? 'impedance ±10 %' : '+ impedance'} ${featPct('impedance')}`, short = `${on ? 'Z0 ±10 %' : '+ Z0'} ${featPct('impedance')}`;
      const lab = long.length * 6.7 < x2 - x1 + 10 ? long : short;
      if (x2 - x1 > 30) o.push(tag((x1 + x2) / 2, y + d + 14, lab, on, 'middle', bad ? 'bad' : ''));
    }
    // gold fingers on the bottom edge
    {
      const on = !!inp.fingers, x0 = bx + bw * 0.3, x1 = bx + bw * 0.72, fh = clamp(u * 0.13, 6, 40), n = clamp(Math.round((x1 - x0) / clamp(u * 0.035, 5, 14)), 4, 24);
      const fw = (x1 - x0) / n;
      let g = `<rect x="${x0}" y="${by + bh - fh - 3}" width="${x1 - x0}" height="${fh + 3}" fill="transparent"/>`;
      for (let i = 0; i < n; i++) {
        g += on ? `<rect x="${x0 + i * fw + fw * 0.18}" y="${by + bh - fh}" width="${fw * 0.64}" height="${fh - 1}" fill="var(--tool-hardgold)"/>`
          : `<rect x="${x0 + i * fw + fw * 0.18}" y="${by + bh - fh}" width="${fw * 0.64}" height="${fh - 1}" fill="none" stroke="var(--tool-silk)" stroke-width=".8" stroke-dasharray="2 2" opacity=".7"/>`;
      }
      if (on) g += `<path d="M${x0},${by + bh - 1.5}L${x1},${by + bh - 1.5}" stroke="var(--tool-hardgold)" stroke-width="1.5" stroke-dasharray="3 2"/>`;
      o.push(hot('fingers', `Gold fingers: ${on ? 'on' : 'off'} (Enter toggles)`, g, [x0, by + bh - fh - 3, x1 - x0, fh + 3]));
      o.push(tag((x0 + x1) / 2, by + bh - fh - 8, `${on ? '' : '+ '}gold fingers ${featPct('fingers')}`, on, 'middle'));
    }
    // castellations on the right edge
    {
      const on = !!inp.castellated, y0 = by + bh * 0.24, y1 = by + bh * 0.66, cr = clamp(u * 0.028, 2.5, 8);
      const n = clamp(Math.floor((y1 - y0) / (cr * 3.2)), 3, 12), step = (y1 - y0) / (n - 1), x = bx + bw;
      let g = `<rect x="${x - cr * 3}" y="${y0 - cr * 2}" width="${cr * 4}" height="${y1 - y0 + cr * 4}" fill="transparent"/>`;
      for (let i = 0; i < n; i++) {
        const y = y0 + i * step;
        g += on ? `<path d="M${x},${y - cr * 1.7}A${cr * 1.7},${cr * 1.7} 0 0 0 ${x},${y + cr * 1.7}Z" fill="${fin}"/><path d="M${x},${y - cr}A${cr},${cr} 0 0 0 ${x},${y + cr}Z" fill="var(--tool-hole)"/>`
          : `<circle cx="${x - cr * 1.9}" cy="${y}" r="${cr}" fill="none" stroke="var(--tool-silk)" stroke-width=".8" stroke-dasharray="2 2" opacity=".7"/>`;
      }
      o.push(hot('castellated', `Castellated holes: ${on ? 'on' : 'off'} (Enter toggles)`, g, [x - cr * 3, y0 - cr * 2, cr * 4, y1 - y0 + cr * 4]));
      o.push(`<text transform="translate(${x - cr * 3.4},${(y0 + y1) / 2}) rotate(-90)" text-anchor="middle" font-size="11" fill="var(--tool-silk)" ${on ? 'font-weight="600"' : 'opacity=".78"'} pointer-events="none">${on ? '' : '+ '}castellated ${esc(featPct('castellated'))}</text>`);
    }

    // dimensions and the resize handles
    const dy = by - 20, dx = bx + bw + 18;
    const perCm2 = val(res, 'Per cm²')?.value;
    o.push(`<g pointer-events="none" stroke="var(--ink-soft)" stroke-width=".8">`
      + `<line x1="${bx}" y1="${by - 4}" x2="${bx}" y2="${dy - 6}"/><line x1="${bx + bw}" y1="${by - 4}" x2="${bx + bw}" y2="${dy - 6}"/><line x1="${bx}" y1="${dy}" x2="${bx + bw}" y2="${dy}"/>`
      + `<line x1="${bx + bw + 4}" y1="${by}" x2="${dx + 6}" y2="${by}"/><line x1="${bx + bw + 4}" y1="${by + bh}" x2="${dx + 6}" y2="${by + bh}"/><line x1="${dx}" y1="${by}" x2="${dx}" y2="${by + bh}"/></g>`);
    o.push(`<text x="${bx + bw / 2}" y="${dy - 5}" text-anchor="middle" font-size="12.5" font-weight="600" class="halo" fill="${wf.outline ? 'var(--danger)' : 'var(--ink)'}">${r1(w)} mm</text>`);
    o.push(`<text transform="translate(${dx + 14},${by + bh / 2}) rotate(-90)" text-anchor="middle" font-size="12.5" font-weight="600" class="halo" fill="${wf.outline ? 'var(--danger)' : 'var(--ink)'}">${r1(h)} mm</text>`);
    const outlineMsg = wf.outline ? ((res.warnings || []).find((x) => /500 mm|Under 10 mm/.test(x)) || '').split(':')[0] : '';
    o.push(`<text x="${bx}" y="${Math.min(H - 8, by + bh + 20)}" font-size="11" ${outlineMsg ? 'font-weight="600" class="halo" fill="var(--danger)"' : 'fill="var(--ink-soft)"'}>${outlineMsg ? esc(outlineMsg) : `${r1(w * h / 100)} cm² a board${perCm2 ? ` · ${esc(perCm2)} USD/cm²` : ''}`}</text>`);
    const knob = (k, x, y, shape, label, now) => `<g class="hdl" data-k="${k}" tabindex="0" role="slider" aria-label="${label}" aria-valuenow="${now}">`
      + `<rect x="${x - 12}" y="${y - 12}" width="24" height="24" fill="transparent"/>${shape}<title>${label}</title></g>`;
    o.push(knob('w', bx + bw, by + bh / 2, `<rect class="kc" x="${bx + bw - 4}" y="${by + bh / 2 - 13}" width="8" height="26" rx="3" fill="var(--accent)" stroke="var(--surface)" stroke-width="1.5"/>`, 'Board width, drag or arrow keys', r1(w)));
    o.push(knob('h', bx + bw / 2, by + bh, `<rect class="kc" x="${bx + bw / 2 - 13}" y="${by + bh - 4}" width="26" height="8" rx="3" fill="var(--accent)" stroke="var(--surface)" stroke-width="1.5"/>`, 'Board height, drag or arrow keys', r1(h)));
    o.push(knob('wh', bx + bw, by + bh, `<circle class="kc" cx="${bx + bw}" cy="${by + bh}" r="7" fill="var(--surface)" stroke="var(--accent)" stroke-width="2.5"/>`, 'Board width and height, drag', `${r1(w)} × ${r1(h)}`));
    // scale bar
    const sb = [5, 10, 20, 50, 100, 200].find((m) => m * s >= 50) || 200;
    o.push(`<g pointer-events="none"><line x1="${W - 14 - sb * s}" y1="14" x2="${W - 14}" y2="14" stroke="var(--ink-soft)" stroke-width="1.2"/><line x1="${W - 14 - sb * s}" y1="10" x2="${W - 14 - sb * s}" y2="18" stroke="var(--ink-soft)"/><line x1="${W - 14}" y1="10" x2="${W - 14}" y2="18" stroke="var(--ink-soft)"/><text x="${W - 14 - sb * s / 2}" y="30" text-anchor="middle" font-size="10.5" fill="var(--ink-soft)">${sb} mm</text></g>`);
    plan.setAttribute('viewBox', `0 0 ${W} ${H}`);
    plan.innerHTML = o.join('');
  }

  // ---------------- section ----------------
  function renderSect() {
    const W = sectBox.clientWidth, H = sectBox.clientHeight;
    if (!W || !H) return;
    const inp = ctx.input, res = ctx.result || {}, wf = warnFlags(res.warnings);
    const narrow = W < 520;
    const n = Number(inp.layers) || 2, th = Number(inp.thick) || 1.6, oz = Number(inp.copper) || 1;
    const x0 = narrow ? 64 : 104, x1 = W - (narrow ? 64 : 92), L = x1 - x0;
    const Ht = 22 + th * 26, top = (narrow ? 40 : 30) + Math.max(0, (H - (narrow ? 54 : 44) - Ht) / 2), bot = top + Ht;
    const ry = (row) => top - (1.6 + oz * 1.6) - 3 - 7 - (narrow ? row * 12 : 0); // label rows, staggered when narrow
    const co = 1.6 + oz * 1.6, ci = 2, mk = 3;
    const green = inp.color !== 'other';
    const mask = green ? 'var(--tool-mask)' : 'var(--tool-mask-alt)';
    const fin = FINISH_COL[inp.finish] || 'var(--tool-hasl)';
    const ly = (i) => (n === 1 ? top : top + (i * Ht) / (n - 1));
    const X = (f) => x0 + f * L;
    const drill = Number(inp.drill) || 0.3, dp = Math.max(4, drill * 34);
    const mil = Number(inp.trace) || 6, tw = mil * 1.3;
    const vx = X(0.6), bxv = X(0.8), txp = X(0.3);
    const o = [];
    const ring = (x, y, w, h) => `<rect class="ring" x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${h + 8}" rx="3"/>`;
    const hot = (part, label, inner) => `<g class="hot${sel === part ? ' sel' : ''}" data-part="${part}" tabindex="0" role="button" aria-label="${esc(label)}">${inner}<title>${esc(label)}</title></g>`;

    // laminate (click: layer count)
    let lam = ring(x0, top, L, Ht) + `<rect x="${x0}" y="${top}" width="${L}" height="${Ht}" fill="var(--tool-fr4)" stroke="var(--tool-fr4-edge)" stroke-width=".8"/>`;
    for (let i = 1; i < n - 1; i++) {
      const y = ly(i);
      lam += `<rect x="${x0}" y="${y - ci / 2}" width="${vx - dp / 2 - 5 - x0}" height="${ci}" fill="var(--tool-cu)"/><rect x="${vx + dp / 2 + 5}" y="${y - ci / 2}" width="${x1 - vx - dp / 2 - 5}" height="${ci}" fill="var(--tool-cu)"/>`;
    }
    o.push(hot('layers', `${n} copper layers`, lam));
    // bottom copper plane + weight (click: copper)
    if (n > 1) {
      o.push(hot('copper', `Outer copper ${oz} oz`, ring(x0, bot, L, co) + `<rect x="${x0}" y="${bot}" width="${vx - dp / 2 - 5 - x0}" height="${co}" fill="var(--tool-cu)"/><rect x="${vx + dp / 2 + 5}" y="${bot}" width="${x1 - vx - dp / 2 - 5}" height="${co}" fill="var(--tool-cu)"/>`));
    }
    // mask top and bottom with openings (click: mask)
    const openT = [[X(0.08), X(0.18)], [vx - dp / 2 - 7, vx + dp / 2 + 7]];
    let m = '';
    let cur = x0;
    for (const [a, b] of openT) { m += `<rect x="${cur}" y="${top - co - mk}" width="${a - cur}" height="${mk}" fill="${mask}"/>`; cur = b; }
    m += `<rect x="${cur}" y="${top - co - mk}" width="${x1 - cur}" height="${mk}" fill="${mask}"/>`;
    if (n > 1) m += `<rect x="${x0}" y="${bot + co}" width="${vx - dp / 2 - 7 - x0}" height="${mk}" fill="${mask}"/><rect x="${vx + dp / 2 + 7}" y="${bot + co}" width="${x1 - vx - dp / 2 - 7}" height="${mk}" fill="${mask}"/>`;
    o.push(hot('color', `Solder mask: ${green ? 'green' : 'other colour'}`, `<rect class="ring" x="${x0 - 4}" y="${top - co - mk - 4}" width="${L + 8}" height="${mk + 8}" rx="3"/>` + m));
    // pads with finish (click: finish)
    o.push(hot('finish', 'Surface finish on the pads', ring(X(0.08), top - co - 3, X(0.18) - X(0.08), co + 3)
      + `<rect x="${X(0.08)}" y="${top - co}" width="${X(0.18) - X(0.08)}" height="${co}" fill="var(--tool-cu)"/><rect x="${X(0.08)}" y="${top - co - 2.5}" width="${X(0.18) - X(0.08)}" height="2.5" fill="${fin}"/>`));
    // traces at the finest trace/space (click: trace)
    {
      const bad = wf.trace, col = bad ? 'var(--danger)' : 'var(--tool-cu)';
      const g = ring(txp - tw * 1.5, top - co - mk, tw * 3, co + mk)
        + `<rect x="${txp - tw * 1.5}" y="${top - co}" width="${tw}" height="${co}" fill="${col}"/><rect x="${txp + tw * 0.5}" y="${top - co}" width="${tw}" height="${co}" fill="${col}"/>`;
      o.push(hot('trace', `Smallest trace and space ${mil} mil`, g));
      o.push(`<text x="${txp}" y="${ry(0)}" text-anchor="middle" font-size="10.5" class="halo" fill="${bad ? 'var(--danger)' : 'var(--ink)'}" pointer-events="none">${mil}/${mil} mil</text>`);
    }
    // through via at the smallest drill (click: drill)
    {
      const g = ring(vx - dp / 2 - 6, top - co, dp + 12, Ht + 2 * co)
        + `<rect x="${vx - dp / 2 - 6}" y="${top - co}" width="${dp + 12}" height="${co}" fill="var(--tool-cu)"/>`
        + (n > 1 ? `<rect x="${vx - dp / 2 - 6}" y="${bot}" width="${dp + 12}" height="${co}" fill="var(--tool-cu)"/>` : '')
        + `<rect x="${vx - dp / 2 - 1.5}" y="${top - co}" width="${dp + 3}" height="${(n > 1 ? Ht + 2 * co : Ht + co)}" fill="var(--tool-cu)"/>`
        + `<rect x="${vx - dp / 2}" y="${top - co - 1}" width="${dp}" height="${(n > 1 ? Ht + 2 * co : Ht + co) + 2}" fill="var(--tool-hole)"/>`
        + `<rect x="${vx - dp / 2 - 6}" y="${top - co - 2.5}" width="${dp + 12}" height="2.5" fill="${fin}"/>`;
      o.push(hot('drill', `Smallest drill ${drill} mm`, g));
      o.push(`<text x="${vx}" y="${ry(0)}" text-anchor="middle" font-size="10.5" class="halo" fill="var(--ink)" pointer-events="none">⌀${drill}</text>`);
    }
    // blind via (click: toggle)
    {
      const on = !!inp.blind, ok = n >= 4, bad = wf.blind;
      const yb = ok ? ly(1) : top + Ht * 0.4, bw = Math.max(4, dp * 0.7);
      const col = bad ? 'var(--danger)' : 'var(--tool-cu)';
      const g = ring(bxv - bw / 2 - 5, top - co, bw + 10, yb - top + co + 2)
        + (on ? `<path d="M${bxv - bw / 2 - 5},${top - co}h${bw + 10}v${co}h-${3.5}L${bxv + bw / 2 - 1.5},${yb}h-${bw - 3}L${bxv - bw / 2 - 1.5},${top}h-3.5Z" fill="${col}"/><path d="M${bxv - bw / 2},${top - co - 1}h${bw}L${bxv + bw / 2 - 2},${yb - 1.5}h-${bw - 4}Z" fill="var(--tool-hole)"/>`
          : `<rect x="${bxv - bw / 2}" y="${top - co}" width="${bw}" height="${yb - top + co}" fill="none" stroke="var(--ink-soft)" stroke-width="1" stroke-dasharray="3 2"/>`);
      o.push(hot('blind', `Blind / buried vias: ${on ? 'on' : 'off'} (Enter toggles)`, g));
      const p = pctWith({ blind: !on });
      const txt = on ? (ok ? `blind${narrow ? '' : ' via'} ${pctTxt(p == null ? null : -p / (1 + p / 100))}` : 'blind: needs 4+ layers') : `+ blind${narrow ? '' : ' via'} ${ok ? pctTxt(p) : ''}`;
      o.push(`<text x="${bxv}" y="${ry(1)}" text-anchor="middle" font-size="10.5" class="halo" fill="${bad ? 'var(--danger)' : on ? 'var(--ink)' : 'var(--ink-soft)'}" ${on ? 'font-weight="600"' : ''} pointer-events="none">${esc(txt)}</text>`);
    }
    // top copper weight label (click: copper)
    o.push(hot('copper', `Outer copper ${oz} oz`, `<rect class="ring" x="${X(0.4) - 4}" y="${top - co - 4}" width="${X(0.5) - X(0.4) + 8}" height="${co + 8}" rx="3"/><rect x="${X(0.4)}" y="${top - co}" width="${X(0.5) - X(0.4)}" height="${co}" fill="var(--tool-cu)"/>`
      + `<text x="${X(0.45)}" y="${ry(1)}" text-anchor="middle" font-size="10.5" class="halo" fill="var(--ink)">${oz} oz</text>`));

    // left: layer count with steppers
    const lopts = optsOf('layers').map(([v]) => v), li = lopts.indexOf(String(inp.layers));
    const cy = (top + bot) / 2;
    o.push(`<text x="${narrow ? 32 : 50}" y="${cy + 2}" text-anchor="middle" font-size="${narrow ? 20 : 24}" font-weight="600" fill="var(--ink)" font-family="IBM Plex Mono, monospace">${n}</text>`
      + `<text x="${narrow ? 32 : 50}" y="${cy + 18}" text-anchor="middle" font-size="10.5" fill="var(--ink-soft)">layer${n > 1 ? 's' : ''}</text>`);
    const step = (d, y) => `<g class="hot" data-step="${d}" tabindex="0" role="button" aria-label="${d > 0 ? 'More' : 'Fewer'} layers"><rect class="ring" x="${(narrow ? 32 : 50) - 12}" y="${y - 10}" width="24" height="18" rx="4" style="stroke:var(--line);fill:var(--surface)"/>`
      + `<text x="${narrow ? 32 : 50}" y="${y + 3.5}" text-anchor="middle" font-size="13" fill="${(d > 0 ? li < lopts.length - 1 : li > 0) ? 'var(--ink)' : 'var(--line)'}">${d > 0 ? '+' : '−'}</text></g>`;
    o.push(step(1, cy - 28), step(-1, cy + 36));
    // right: thickness dimension (click: thickness)
    {
      const x = x1 + 16, yT = top - co - mk, yB = n > 1 ? bot + co + mk : bot;
      o.push(hot('thick', `Board thickness ${th} mm`, ring(x - 6, yT, narrow ? 50 : 70, yB - yT)
        + `<line x1="${x1 + 3}" y1="${yT}" x2="${x + 6}" y2="${yT}" stroke="var(--ink-soft)" stroke-width=".7"/><line x1="${x1 + 3}" y1="${yB}" x2="${x + 6}" y2="${yB}" stroke="var(--ink-soft)" stroke-width=".7"/>`
        + `<line x1="${x}" y1="${yT}" x2="${x}" y2="${yB}" stroke="var(--ink-soft)" stroke-width="1"/>`
        + `<text x="${x + 6}" y="${(yT + yB) / 2 + 4}" font-size="12" font-weight="600" fill="var(--ink)">${th}</text><text x="${x + 6}" y="${(yT + yB) / 2 + 17}" font-size="10" fill="var(--ink-soft)">mm</text>`));
    }
    sect.setAttribute('viewBox', `0 0 ${W} ${H}`);
    sect.innerHTML = o.join('');
  }

  // ---------------- inspector ----------------
  function renderInsp() {
    const P = PARTS[sel] || PARTS.layers, inp = ctx.input, raw = ctx.raw;
    const head = el('div', { class: 'bc-insp-h' }, el('b', {}, P.title), el('span', {}, P.note));
    const opt = (label, patch, pressed, sw) => {
      const p = pressed ? null : pctWith(patch);
      return el('button', { class: 'bc-opt', 'aria-pressed': String(!!pressed), onclick: () => ctx.setMany(patch) },
        el('span', { class: 't' }, sw ? el('i', { class: 'bc-sw', style: `background:${sw}` }) : null, label),
        el('span', { class: `d${p == null ? '' : p > 0.5 ? ' up' : p < -0.5 ? ' down' : ''}` }, pressed ? 'now' : pctTxt(p)));
    };
    let body;
    if (sel === 'size') {
      const wIn = el('input', { inputmode: 'decimal', 'aria-label': 'Board width in mm' }); wIn.value = raw.w ?? '';
      const hIn = el('input', { inputmode: 'decimal', 'aria-label': 'Board height in mm' }); hIn.value = raw.h ?? '';
      wIn.addEventListener('change', () => ctx.set('w', wIn.value.trim()));
      hIn.addEventListener('change', () => ctx.set('h', hIn.value.trim()));
      body = el('div', { class: 'bc-opts' }, el('div', { class: 'bc-dims' }, el('label', {}, 'W ', wIn, ' mm'), el('label', {}, 'H ', hIn, ' mm')),
        ...PRESETS.map(([a, b]) => opt(`${a} × ${b}`, { w: String(a), h: String(b) }, inp.w === a && inp.h === b)));
    } else if (P.bool) {
      body = el('div', { class: 'bc-opts' }, opt('Off', { [P.key]: false }, !inp[P.key]), opt('On', { [P.key]: true }, !!inp[P.key]));
    } else {
      body = el('div', { class: 'bc-opts' }, ...optsOf(P.key).map(([v, t]) => opt(
        SHORT[P.key]?.[v] || (P.key === 'layers' ? `${v} layer${v === '1' ? '' : 's'}` : t),
        { [P.key]: v }, String(raw[P.key]) === String(v),
        P.key === 'finish' ? FINISH_COL[v] : P.key === 'color' ? (v === 'green' ? 'var(--tool-mask)' : 'var(--tool-mask-alt)') : null)));
    }
    // quick jumps to the parts that are not drawn as clickable on this width
    const jumps = el('div', { class: 'bc-opts', style: 'margin-top:2px' }, ...Object.entries(PARTS).filter(([k]) => k !== sel)
      .map(([k, p]) => el('button', { class: 'bc-chip', onclick: () => { sel = k; renderAllViews(); } }, p.title.split(',')[0])));
    const det = el('details', {}, el('summary', { style: 'font-size:11.5px;color:var(--ink-soft);cursor:pointer' }, 'Every part'), jumps);
    insp.replaceChildren(head, body, det);
  }

  // ---------------- quote slip ----------------
  function renderQuote() {
    const res = ctx.result || {}, inp = ctx.input, raw = ctx.raw;
    const per = perOf(res), tot = res.values?.[0];
    const q = Math.round(inp.qty) || 0;
    const seg = (key, lab) => el('div', { class: 'bc-seg', role: 'group', 'aria-label': lab }, ...optsOf(key).map(([v]) => {
      const on = String(raw[key]) === v, p = on ? null : pctWith({ [key]: v });
      return el('button', { 'aria-pressed': String(on), title: optsOf(key).find((o) => o[0] === v)[1], onclick: () => ctx.set(key, v) },
        el('span', { class: 't' }, SHORT[key][v]), el('span', { class: `d${p > 0.5 ? ' up' : ''}` }, on ? 'now' : pctTxt(p)));
    }));
    const kids = [];
    kids.push(el('div', { class: 'bc-price' },
      el('div', { class: 'big' }, val(res, 'Per board')?.value ?? '–', el('small', {}, 'USD / board')),
      el('div', { class: 'tot' }, `total for ${q || '–'}`, el('b', {}, tot ? `${tot.value} USD` : '–')),
      el('div', { class: 'rng' }, tot?.hint ? `Estimate ${tot.hint}. Compare choices with it; get a quote before ordering.` : '')));
    kids.push(el('div', { class: 'bc-terms' }, el('span', {}, 'Fab'), seg('region', 'Fab'), el('span', {}, 'Lead time'), seg('lead', 'Lead time')));
    const t = res.tables?.[0];
    if (t) {
      const parts = t.rows.slice(0, 3).map(([k, v]) => [k, num(v) || 0]);
      const sum = parts.reduce((a, [, v]) => a + v, 0) || 1;
      const cols = ['var(--tool-money-setup)', 'var(--tool-money-area)', 'var(--tool-money-opt)'];
      const short = ['Setup, tooling, test', 'Board area', 'Options on area'];
      kids.push(el('div', { class: 'bc-money' },
        el('div', { style: 'font-size:11.5px;color:var(--ink-soft);margin-bottom:4px' }, `Where the ${tot ? tot.value : money(sum)} USD goes`),
        el('div', { style: 'display:flex;height:14px;border-radius:3px;overflow:hidden;background:var(--sunken)' },
          ...parts.map(([k, v], i) => el('div', { title: `${k}: ${v} USD`, style: `width:${(100 * v) / sum}%;background:${cols[i]}` }))),
        el('div', { style: 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;margin-top:4px;font-size:11px;color:var(--ink-soft)' },
          ...parts.map(([k, v], i) => el('div', {}, el('i', { class: 'bc-sw', style: `background:${cols[i]};margin-right:4px;vertical-align:-1px` }), short[i] || k,
            el('b', { style: 'display:block;font:500 12.5px IBM Plex Mono,monospace;color:var(--ink)' }, String(t.rows[i][1])))))));
      const mults = t.rows.slice(3).filter(([, v]) => String(v) !== '×1');
      if (mults.length) kids.push(el('div', { class: 'bc-mults' }, ...mults.map(([k, v]) => el('span', {}, `${String(k).trim()} `, el('b', {}, v)))));
    }
    const fact = (lab, v) => el('div', {}, lab, el('b', {}, v?.value != null ? `${v.value} ${v.unit || ''}` : '–'));
    const area = val(res, 'Board area'), share = val(res, 'Setup share');
    kids.push(el('div', { class: 'bc-facts' }, fact('Per cm²', val(res, 'Per cm²')),
      el('div', { title: area?.hint || '' }, 'Area ordered', el('b', {}, area ? `${area.value} m²` : '–'), area?.hint ? el('span', {}, area.hint) : null),
      fact('Setup share', share)));
    slip.replaceChildren(...kids);
    warns.replaceChildren(...(res.warnings || []).map((w) => el('div', {}, w)));
    notes.replaceChildren(el('summary', {}, `Model and limits (${(res.notes || []).length} notes)`), ...(res.notes || []).map((n) => el('div', {}, n)));
  }

  // ---------------- quantity curve ----------------
  function qGeom(W, H, rows, q) {
    const qs = rows.map((r) => r[0]);
    const lo = Math.log10(Math.min(qs[0], Math.max(1, q || qs[0]))), hi = Math.log10(Math.max(qs[qs.length - 1], q || 1));
    const ymax = Math.max(...rows.map((r) => num(r[2]) || 0)) * 1.08 || 1;
    const L = 44, R = 14, T = 16, B = 26;
    return { X: (v) => L + ((Math.log10(v) - lo) / (hi - lo)) * (W - L - R), Q: (x) => 10 ** (lo + ((x - L) / (W - L - R)) * (hi - lo)),
      Y: (v) => T + (H - T - B) * (1 - v / ymax), L, R, T, B, ymax, lo, hi };
  }
  function renderQty() {
    const W = qsvg.clientWidth || 360, H = qsvg.clientHeight || 190;
    const res = ctx.result || {}, inp = ctx.input;
    if (document.activeElement !== qIn) qIn.value = ctx.raw.qty ?? '';
    const t = res.tables?.find((x) => x.title === 'At other quantities');
    if (!t) { qsvg.innerHTML = ''; qCap.textContent = ''; return; }
    const q = Math.round(inp.qty), per = perOf(res);
    const G = qGeom(W, H, t.rows, q);
    const o = [];
    for (let k = 0; k <= 4; k++) {
      const v = (G.ymax * k) / 4;
      o.push(`<line x1="${G.L}" x2="${W - G.R}" y1="${G.Y(v)}" y2="${G.Y(v)}" stroke="var(--line-soft)"/><text x="${G.L - 6}" y="${G.Y(v) + 3.5}" text-anchor="end" font-size="10" fill="var(--ink-soft)">${money(v)}</text>`);
    }
    for (const r of t.rows) o.push(`<text x="${G.X(r[0])}" y="${H - 9}" text-anchor="middle" font-size="10" fill="var(--ink-soft)">${r[0] >= 1000 ? `${r[0] / 1000}k` : r[0]}</text>`);
    const pts = t.rows.map((r) => [G.X(r[0]), G.Y(num(r[2]))]);
    o.push(`<path d="M${pts[0][0]},${G.Y(0)}L${pts.map((p) => p.join(',')).join('L')}L${pts[pts.length - 1][0]},${G.Y(0)}Z" fill="var(--accent)" fill-opacity=".08"/>`);
    o.push(`<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>`);
    for (const p of pts) o.push(`<circle cx="${p[0]}" cy="${p[1]}" r="2.3" fill="var(--accent)"/>`);
    if (q > 0 && per != null) {
      const x = G.X(q), y = G.Y(per);
      o.push(`<line x1="${x}" y1="${G.T - 6}" x2="${x}" y2="${H - G.B}" stroke="var(--ink-soft)" stroke-dasharray="3 3"/>`);
      const lab = `${q} × ${val(res, 'Per board').value} = ${res.values[0].value} USD`;
      const lw = lab.length * 6.7, lx = clamp(x + 8, G.L + 4, W - G.R - lw);
      o.push(`<text x="${lx}" y="${G.T + 4}" text-anchor="start" font-size="11" font-weight="600" class="halo" fill="var(--ink)">${lab}</text>`);
      o.push(`<g class="qdot" tabindex="0" role="slider" aria-label="Quantity, drag or arrow keys" aria-valuenow="${q}"><circle cx="${x}" cy="${y}" r="13" fill="transparent"/><circle class="kc" cx="${x}" cy="${y}" r="6.5" fill="var(--surface)" stroke="var(--accent)" stroke-width="2.5"/><title>Drag along the curve to change the quantity</title></g>`);
    }
    o.push(`<rect class="qhit" x="${G.L}" y="${G.T}" width="${W - G.L - G.R}" height="${H - G.T - G.B}" fill="transparent" style="cursor:ew-resize"/>`);
    qsvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    qsvg.innerHTML = o.join('');
    // move the dot above the hit area so it gets focus and pointer first
    const dot = qsvg.querySelector('.qdot'); if (dot) qsvg.append(dot);
    qCap.textContent = 'USD per board · drag the dot';
  }

  const snapQ = (v) => NICE.reduce((b, n) => (Math.abs(Math.log(n / v)) < Math.abs(Math.log(b / v)) ? n : b), NICE[0]);
  const qFromX = (clientX) => {
    const t = ctx.result?.tables?.find((x) => x.title === 'At other quantities');
    if (!t) return null;
    const r = qsvg.getBoundingClientRect(), W = qsvg.clientWidth || 360, H = qsvg.clientHeight || 190;
    const G = qGeom(W, H, t.rows, Math.round(ctx.input.qty));
    return snapQ(clamp(G.Q(((clientX - r.left) / r.width) * W), 1, 50000));
  };
  qsvg.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.qdot, .qhit')) return;
    qdrag = true; qsvg.setPointerCapture(e.pointerId); qsvg.classList.add('dragging');
    const q = qFromX(e.clientX); if (q && q !== Math.round(ctx.input.qty)) ctx.set('qty', String(q));
    e.preventDefault();
  });
  qsvg.addEventListener('pointermove', (e) => {
    if (!qdrag) return;
    const q = qFromX(e.clientX); if (q && q !== Math.round(ctx.input.qty)) ctx.set('qty', String(q));
  });
  const qEnd = () => { if (!qdrag) return; qdrag = false; qsvg.classList.remove('dragging'); requestAnimationFrame(() => qsvg.querySelector('.qdot')?.focus({ preventScroll: true })); };
  qsvg.addEventListener('pointerup', qEnd); qsvg.addEventListener('pointercancel', qEnd);
  qsvg.addEventListener('keydown', (e) => {
    if (!e.target.closest('.qdot')) return;
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 3, PageDown: -3 }[e.key];
    if (!d) return;
    e.preventDefault();
    let q = Math.round(ctx.input.qty) || 1;
    for (let k = 0; k < Math.abs(d); k++) {
      q = d > 0 ? (NICE.find((n) => n > q) ?? NICE[NICE.length - 1]) : ([...NICE].reverse().find((n) => n < q) ?? NICE[0]);
    }
    ctx.set('qty', String(q));
    requestAnimationFrame(() => qsvg.querySelector('.qdot')?.focus({ preventScroll: true }));
  });

  // ---------------- interaction on the board ----------------
  const stepOpt = (key, d) => {
    const list = optsOf(key).map(([v]) => v), i = list.indexOf(String(ctx.raw[key]));
    const j = clamp((i < 0 ? 0 : i) + d, 0, list.length - 1);
    if (j !== i) ctx.set(key, list[j]);
  };
  const activate = (g) => {
    if (g.dataset.step) { stepOpt('layers', Number(g.dataset.step)); sel = 'layers'; return 'step:' + g.dataset.step; }
    const part = g.dataset.part, P = PARTS[part];
    if (!P) return null;
    sel = part;
    if (P.bool) ctx.set(P.key, !ctx.input[P.key]);
    else renderAllViews();
    return part;
  };
  const refocus = (svg, k) => requestAnimationFrame(() => {
    const [kind, v] = k.split(':');
    svg.querySelector(kind === 'step' ? `[data-step="${v}"]` : kind === 'hdl' ? `.hdl[data-k="${v}"]` : `[data-part="${k}"]`)?.focus({ preventScroll: true });
  });
  for (const svg of [plan, sect]) {
    svg.addEventListener('click', (e) => {
      if (drag) return;
      const g = e.target.closest('.hot'); if (!g) return;
      const k = activate(g); if (k) refocus(svg, k);
    });
    svg.addEventListener('keydown', (e) => {
      const g = e.target.closest('.hot, .hdl'); if (!g) return;
      if (g.classList.contains('hdl')) {
        const k = g.dataset.k, st = e.shiftKey ? 10 : 1;
        const dw = { ArrowRight: st, ArrowLeft: -st }[e.key] || 0, dh = { ArrowDown: st, ArrowUp: -st }[e.key] || 0;
        if (!dw && !dh) return;
        e.preventDefault();
        const inp = ctx.input, patch = {};
        if (k !== 'h' && dw) patch.w = String(clamp(Math.round((inp.w || 100) + dw), 5, 600));
        if (k !== 'w' && dh) patch.h = String(clamp(Math.round((inp.h || 80) + dh), 5, 600));
        if (k === 'w' && dh && !dw) patch.w = String(clamp(Math.round((inp.w || 100) - dh), 5, 600));
        if (k === 'h' && dw && !dh) patch.h = String(clamp(Math.round((inp.h || 80) + dw), 5, 600));
        sel = 'size';
        if (Object.keys(patch).length) ctx.setMany(patch);
        refocus(svg, 'hdl:' + k);
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const k = activate(g); if (k) refocus(svg, k); return; }
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      const P = PARTS[g.dataset.part];
      if (d && P && P.key && !P.bool) { e.preventDefault(); sel = g.dataset.part; stepOpt(P.key, d); refocus(svg, g.dataset.part); }
    });
  }
  plan.addEventListener('pointerdown', (e) => {
    const k = e.target.closest('.hdl')?.dataset.k; if (!k) return;
    const W = planBox.clientWidth, H = planBox.clientHeight, inp = ctx.input;
    const G = planGeom(W, H, inp.w > 0 ? inp.w : 100, inp.h > 0 ? inp.h : 80);
    drag = { k, G }; sel = 'size';
    plan.setPointerCapture(e.pointerId); plan.classList.add('dragging');
    e.preventDefault();
  });
  plan.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = plan.getBoundingClientRect(), W = planBox.clientWidth, H = planBox.clientHeight;
    const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
    const { G, k } = drag, patch = {};
    if (k !== 'h') patch.w = String(clamp(Math.round((Math.min(x, G.maxX) - G.bx) / G.s), 5, 600));
    if (k !== 'w') patch.h = String(clamp(Math.round((Math.min(y, G.maxY) - G.by) / G.s), 5, 600));
    if (Object.entries(patch).some(([kk, v]) => String(ctx.raw[kk]) !== v)) ctx.setMany(patch);
  });
  const endDrag = () => {
    if (!drag) return;
    const k = drag.k;
    setTimeout(() => { drag = null; plan.classList.remove('dragging'); renderAllViews(); refocus(plan, 'hdl:' + k); }, 0);
  };
  plan.addEventListener('pointerup', endDrag); plan.addEventListener('pointercancel', endDrag);

  function renderAllViews() { renderPlan(); renderSect(); renderInsp(); }
  ctx.onResult(() => { renderAllViews(); renderQuote(); renderQty(); });
  new ResizeObserver(() => { if (!drag) { renderPlan(); renderSect(); } }).observe(planBox);
  new ResizeObserver(() => renderSect()).observe(sectBox);
  new ResizeObserver(() => { if (!qdrag) renderQty(); }).observe(qsvg);
}
