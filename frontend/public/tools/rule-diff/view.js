// Design Rule Diff: the two rule sets side by side as the texts they are,
// and between them a spine of the rules themselves, each drawn as the
// feature it limits (a track, a gap, a drill, a ring, a board edge), both
// fabs' values overlaid to one scale: A dashed, B solid. Point at a rule and
// its values light up in both texts; click a value in a text and its rule is
// picked in the spine. Drag a drawing sideways (or arrow keys on a focused
// rule) to change B's value; the arrows copy a value across. Every value,
// difference and verdict drawn comes from run()'s result (result.diff); the
// page only rewrites the source text where you change it.

import { fmtNum } from '../kit/eng.js';

const NS = 'http://www.w3.org/2000/svg';
const UNIT_MM = { mm: 1, mil: 0.0254, mils: 0.0254, thou: 0.0254, in: 25.4, inch: 25.4, '"': 25.4, um: 0.001, 'µm': 0.001, cm: 10 };
const STEP = { mm: 0.005, mil: 0.5, mils: 0.5, thou: 0.5, in: 0.0002, inch: 0.0002, '"': 0.0002, um: 1, 'µm': 1, cm: 0.0005 };
const STATE = { changed: 'changed', onlyA: 'only A', onlyB: 'only B', same: 'same' };

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
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const f4 = (v) => fmtNum(v, 4);

/** what feature a rule limits, from its key */
function kindOf(key) {
  const k = key.toLowerCase().replace(/\s*\[.*$/, '');
  if (/thick|height|layers|count/.test(k)) return 'bar';
  if (/annular|ring/.test(k)) return 'ring';
  if (/edge|board|outline|copper_edge/.test(k)) return 'edge';
  if (/hole|drill/.test(k)) return 'drill';
  if (/via/.test(k) && /diam|size|dia|^via/.test(k)) return 'via';
  if (/clear|space|gap|isolat|wirewire|dist/.test(k)) return 'gap';
  if (/track|width|wire|line/.test(k)) return 'track';
  if (/silk|mask|paste/.test(k)) return 'gap';
  return 'bar';
}
const KIND_WORD = { ring: 'annular ring', edge: 'to board edge', drill: 'drill', via: 'via pad', gap: 'gap', track: 'track', bar: 'number' };

/** a token's number and unit as written: '6mil' -> {n: 6, unit: 'mil', sp: ''} */
function token(text) {
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(\s*)(mm|mils?|thou|inch|in|"|um|µm|cm)?$/i.exec(String(text).trim());
  if (!m) return null;
  return { n: Number(m[1]), sp: m[2], unit: m[3] || '', digits: (m[1].split('.')[1] || '').length };
}
/** mm written in the unit (and style) of an existing token */
function writeLike(mmVal, tok) {
  const u = (tok?.unit || 'mm').toLowerCase();
  const per = UNIT_MM[u] || 1;
  const v = mmVal / per;
  const dp = u.startsWith('mil') || u === 'thou' ? 1 : u === 'um' || u === 'µm' ? 0 : u === 'in' || u === 'inch' || u === '"' ? 4 : 3;
  const s = String(Number(v.toFixed(dp)));
  return `${s}${tok?.sp || ''}${tok?.unit || (tok ? '' : 'mm')}`;
}

export function page(root, ctx) {
  // ---------------- DOM ----------------
  const nameA = h('input', { class: 'rd-name a', 'aria-label': 'Name of rule set A', spellcheck: 'false' });
  const nameB = h('input', { class: 'rd-name b', 'aria-label': 'Name of rule set B', spellcheck: 'false' });
  nameA.addEventListener('input', () => ctx.set('nameA', nameA.value));
  nameB.addEventListener('input', () => ctx.set('nameB', nameB.value));
  const tally = h('div', { class: 'rd-tally', role: 'group', 'aria-label': 'Counts; click Same to show or hide the rules that match' });
  const tolIn = h('input', { class: 'rd-tol', id: 'rd-tol', type: 'text', inputmode: 'decimal', spellcheck: 'false' });
  tolIn.addEventListener('input', () => ctx.set('tol', tolIn.value));
  const onlyBtn = h('button', { class: 'rd-toggle', 'aria-pressed': 'true', onclick: () => ctx.set('only', !ctx.input.only) }, 'Only differences');
  const scaleEl = h('span', { class: 'rd-scale' });
  const top = h('div', { class: 'rd-card rd-top' },
    h('div', { class: 'rd-names' }, h('i', { class: 'sw a' }), nameA, h('span', { class: 'vs' }, 'against'), h('i', { class: 'sw b' }), nameB),
    tally,
    h('div', { class: 'rd-opts' }, h('label', { for: 'rd-tol' }, 'equal within'), tolIn, h('span', { class: 'u' }, 'mm'), onlyBtn, scaleEl));

  const mkEditor = (key) => {
    const head = h('div', { class: 'rd-ehead' });
    const back = h('div', { class: 'rd-back', 'aria-hidden': 'true' });
    const ta = h('textarea', { class: 'rd-ta', spellcheck: 'false', 'aria-label': `Rule set ${key.toUpperCase()}`, wrap: 'off' });
    ta.addEventListener('input', () => { paintBack(key); ctx.set(key, ta.value); });
    ta.addEventListener('scroll', () => { back.scrollTop = ta.scrollTop; back.scrollLeft = ta.scrollLeft; });
    const pick = () => pickAt(key, ta.selectionStart);
    ta.addEventListener('click', pick);
    ta.addEventListener('keyup', (e) => { if (/Arrow|Home|End|Page/.test(e.key)) pick(); });
    const box = h('div', { class: 'rd-ebox' }, back, ta);
    const card = h('section', { class: `rd-card rd-editor ${key}` }, head, box);
    return { head, back, ta, card };
  };
  const ed = { a: mkEditor('a'), b: mkEditor('b') };

  const spineHead = h('div', { class: 'rd-shead' });
  const spine = h('div', { class: 'rd-spine', role: 'list', 'aria-label': 'The rules, drawn to one scale' });
  const warnsEl = h('div', { class: 'rd-warns', role: 'status' });
  const mid = h('section', { class: 'rd-card rd-mid' }, spineHead, spine, warnsEl);

  root.append(h('div', { class: 'rd' }, top, h('div', { class: 'rd-grid' }, ed.a.card, mid, ed.b.card), h('div', { class: 'rd-outs' }, ctx.outputs)));

  // ---------------- state ----------------
  let sel = null;          // selected rule key
  let hover = null;        // hovered rule key
  let drag = null;
  let pending = null;
  let geo = { sc: 100 };
  let fit = true;          // each rule fitted to its drawing, or all to one scale

  const D = () => ctx.result?.diff || null;
  const rules = () => {
    const d = D(); if (!d) return [];
    return ctx.input.only ? d.rules.filter((r) => r.state !== 'same') : d.rules;
  };
  function setSoon(obj) {
    const first = !pending;
    pending = { ...(pending || {}), ...obj };
    if (first) requestAnimationFrame(() => { const p = pending; pending = null; ctx.setMany(p); });
  }

  // ---------------- editors: token highlights ----------------
  function paintBack(key) {
    const d = D(), src = ed[key].ta.value;
    const marks = [];
    if (d) for (const r of d.rules) {
      const v = r[key];
      if (!v || v.at == null) continue;
      if (src.slice(v.at, v.at + v.len) !== String(ctx.raw[key] ?? '').slice(v.at, v.at + v.len)) continue;
      marks.push({ at: v.at, len: v.len, cls: `${r.state}${r.key === sel ? ' sel' : ''}${r.key === hover ? ' hov' : ''}` });
    }
    marks.sort((x, y) => x.at - y.at);
    let html = '', i = 0;
    for (const m of marks) {
      if (m.at < i) continue;
      html += esc(src.slice(i, m.at)) + `<mark class="${m.cls}">${esc(src.slice(m.at, m.at + m.len))}</mark>`;
      i = m.at + m.len;
    }
    html += esc(src.slice(i)) + '\n';
    ed[key].back.innerHTML = html;
    ed[key].back.scrollTop = ed[key].ta.scrollTop;
  }
  function revealIn(key, rule) {
    const v = rule?.[key];
    const ta = ed[key].ta;
    if (!v || v.at == null) return;
    const line = ta.value.slice(0, v.at).split('\n').length - 1;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    const want = line * lh - ta.clientHeight / 2 + lh;
    if (line * lh < ta.scrollTop || line * lh > ta.scrollTop + ta.clientHeight - lh * 2) ta.scrollTop = Math.max(0, want);
    ed[key].back.scrollTop = ta.scrollTop;
  }
  function pickAt(key, pos) {
    const d = D(); if (!d) return;
    const r = d.rules.find((x) => x[key] && x[key].at != null && pos >= x[key].at && pos <= x[key].at + x[key].len);
    if (!r) return;
    select(r.key, { from: key });
  }
  function select(key, { from = null, focus = false } = {}) {
    sel = key;
    const r = D()?.rules.find((x) => x.key === key);
    if (r && ctx.input.only && r.state === 'same') ctx.set('only', false);
    for (const k of ['a', 'b']) { paintBack(k); if (k !== from) revealIn(k, r); }
    for (const row of spine.children) row.classList?.toggle('sel', row.dataset.key === key);
    const row = [...spine.children].find((x) => x.dataset.key === key);
    if (row) {
      if (focus) row.focus({ preventScroll: true });
      const rr = row.getBoundingClientRect(), sr = spine.getBoundingClientRect();
      if (rr.top < sr.top || rr.bottom > sr.bottom) row.scrollIntoView({ block: 'nearest' });
    }
  }

  // ---------------- the spine: the rules, drawn ----------------
  function scaleFor(list) {
    const lens = [];
    for (const r of list) for (const s of [r.a, r.b]) if (s?.mm && s.num > 0 && s.num <= 1.5) lens.push(kindOf(r.key) === 'ring' ? s.num * 2 + 0.3 : s.num);
    const max = lens.length ? Math.max(...lens) : 0.5;
    return clamp(46 / max, 30, 600);
  }
  function glyph(r, sc, Gw) {
    const G = 56, cy = G / 2;
    const kind = kindOf(r.key);
    const a = r.a?.num, b = r.b?.num;
    const lenRule = (r.a?.mm || !r.a) && (r.b?.mm || !r.b) && (a != null || b != null) && (r.a?.mm || r.b?.mm);
    const o = [];
    const warn = r.state === 'changed' || r.state === 'onlyA' || r.state === 'onlyB';
    if (!lenRule) {
      if (a != null && b != null && !r.a.mm && !r.b.mm) {
        const m = Math.max(Math.abs(a), Math.abs(b)) || 1, W0 = Gw - 20;
        o.push(`<rect class="gb" x="10" y="${cy + 3}" width="${Math.max(1, (Math.abs(b) / m) * W0)}" height="10" rx="2"/>`);
        o.push(`<rect class="ga" x="10" y="${cy - 13}" width="${Math.max(1, (Math.abs(a) / m) * W0)}" height="10" rx="2"/>`);
        o.push(`<text class="gt" x="${Gw - 8}" y="${G - 4}" text-anchor="end">as written, no unit</text>`);
      } else {
        const ta = r.a ? r.a.text : '–', tb = r.b ? r.b.text : '–';
        o.push(`<text class="chip a" x="${Gw / 2 - 12}" y="${cy + 4}" text-anchor="end">${esc(ta.slice(0, 18))}</text><text class="arrow" x="${Gw / 2}" y="${cy + 4}" text-anchor="middle">→</text><text class="chip b" x="${Gw / 2 + 12}" y="${cy + 4}">${esc(tb.slice(0, 18))}</text>`);
      }
      return { svg: o.join(''), G, scaled: false };
    }
    const big = (v) => v != null && v > 1.5;
    const mx = Math.max(a || 0, b || 0) || 1;
    const fitS = kind === 'gap' ? (Gw * 0.42) / mx : kind === 'edge' ? (Gw * 0.5) / mx : kind === 'ring' ? 23 / (mx + 0.15) : kind === 'bar' ? (Gw - 20) / mx : 46 / mx;
    const s = fit ? fitS : big(a) || big(b) ? Math.min(sc, 46 / mx) : sc;
    const px = (v) => v * s;
    const cx = Gw / 2;
    if (kind === 'track') {
      if (b != null) o.push(`<rect class="cu b" x="10" y="${cy - px(b) / 2}" width="${Gw - 20}" height="${Math.max(1, px(b))}"/>`);
      if (a != null) o.push(`<rect class="out a" x="10" y="${cy - px(a) / 2}" width="${Gw - 20}" height="${Math.max(1, px(a))}"/>`);
    } else if (kind === 'gap' || kind === 'edge') {
      const x0 = kind === 'edge' ? 26 : null;
      if (kind === 'edge') {
        o.push(`<rect class="edgeb" x="6" y="4" width="${x0 - 6}" height="${G - 8}"/><line class="edgel" x1="${x0}" x2="${x0}" y1="4" y2="${G - 4}"/>`);
        if (b != null) o.push(`<rect class="cu b" x="${x0 + px(b)}" y="10" width="${Gw - 8 - x0 - px(b)}" height="${G - 20}"/>`);
        if (a != null) o.push(`<line class="out a" x1="${x0 + px(a)}" x2="${x0 + px(a)}" y1="4" y2="${G - 4}"/>`);
      } else {
        if (b != null) o.push(`<rect class="cu b" x="8" y="10" width="${cx - px(b) / 2 - 8}" height="${G - 20}"/><rect class="cu b" x="${cx + px(b) / 2}" y="10" width="${Gw - 8 - cx - px(b) / 2}" height="${G - 20}"/>`);
        if (a != null) o.push(`<line class="out a" x1="${cx - px(a) / 2}" x2="${cx - px(a) / 2}" y1="4" y2="${G - 4}"/><line class="out a" x1="${cx + px(a) / 2}" x2="${cx + px(a) / 2}" y1="4" y2="${G - 4}"/>`);
      }
    } else if (kind === 'drill' || kind === 'via') {
      if (b != null) o.push(`<circle class="${kind === 'drill' ? 'hole' : 'cu'} b" cx="${cx}" cy="${cy}" r="${Math.max(1, px(b) / 2)}"/>`);
      if (kind === 'via' && b != null) o.push(`<circle class="holein" cx="${cx}" cy="${cy}" r="${Math.max(1, px(b) / 4.5)}"/>`);
      if (a != null) o.push(`<circle class="out a" cx="${cx}" cy="${cy}" r="${Math.max(1, px(a) / 2)}"/>`);
    } else if (kind === 'ring') {
      const r0 = px(0.15);
      if (b != null) o.push(`<circle class="cu b" cx="${cx}" cy="${cy}" r="${r0 + px(b)}"/>`);
      o.push(`<circle class="holein" cx="${cx}" cy="${cy}" r="${r0}"/>`);
      if (a != null) o.push(`<circle class="out a" cx="${cx}" cy="${cy}" r="${r0 + px(a)}"/>`);
    } else {
      const W0 = Gw - 20;
      if (b != null) o.push(`<rect class="cu b" x="10" y="${cy + 2}" width="${Math.min(W0, px(b))}" height="10"/>`);
      if (a != null) o.push(`<rect class="out a" x="10" y="${cy - 12}" width="${Math.min(W0, px(a))}" height="10"/>`);
    }
    if (!fit && s !== sc) o.push(`<text class="gt" x="${Gw - 6}" y="12" text-anchor="end">×${fmtNum(s / sc, 2)} scale</text>`);
    if (fit) { const bar = 0.1 * s; if (bar > 3 && bar < Gw * 0.6) o.push(`<path class="sbar" d="M${Gw - 6 - bar} ${G - 3}h${bar}M${Gw - 6 - bar} ${G - 6}v6M${Gw - 6} ${G - 6}v6"/>`); }
    void warn;
    return { svg: o.join(''), G, scaled: s !== sc, kind };
  }

  function drawSpine() {
    const d = D();
    const list = rules();
    const sc = scaleFor(list);
    const Gw = clamp(spine.clientWidth - 360, 130, 300);
    geo = { sc, Gw };
    const fk = document.activeElement?.closest?.('.rd-rule')?.dataset.key;
    spine.replaceChildren();
    if (!d) return;
    if (!list.length) spine.append(h('div', { class: 'rd-empty' }, d.rules.length ? `${d.nameA} and ${d.nameB} agree on all ${d.rules.length} rules (within ${f4(d.eps)} mm).` : 'Paste a rule set on each side.'));
    for (const r of list) {
      const g = glyph(r, sc, Gw);
      const [base, cond] = r.key.split(/\s*\[(.*)\]\s*$/).filter((x, i) => i < 2);
      const la = r.a ? (r.a.mm ? `${f4(r.a.num)} mm` : r.a.text) : '–';
      const lb = r.b ? (r.b.mm ? `${f4(r.b.num)} mm` : r.b.text) : '–';
      const canEditB = !!(r.b && r.b.at != null && r.b.mm && token(r.b.text));
      const canTo = (dir) => {
        const from = dir === 'b' ? r.a : r.b, to = dir === 'b' ? r.b : r.a;
        const fmt = dir === 'b' ? d.formatB : d.formatA;
        if (!from) return false;
        if (to) return to.at != null && (from.mm ? !!token(to.text) || !to.mm : true);
        return /KiCad|key/.test(fmt) || fmt === 'empty';
      };
      const row = h('div', { class: `rd-rule s-${r.state}${r.key === sel ? ' sel' : ''}`, role: 'listitem', tabindex: '0', 'data-key': r.key,
        'aria-label': `${r.key}: ${d.nameA} ${la}, ${d.nameB} ${lb}, ${STATE[r.state]}${r.meaning ? `, ${r.meaning}` : ''}${canEditB ? '. Left and right arrows change ' + d.nameB : ''}` });
      row.innerHTML = `
        <div class="rd-l1"><span class="st">${esc(STATE[r.state])}</span><b class="k">${esc(base)}</b>${cond ? `<span class="cond">${esc(cond)}</span>` : ''}
          <span class="kind">${esc(KIND_WORD[kindOf(r.key)] || '')}</span>
          ${r.meaning ? `<span class="mean ${/stricter/.test(r.meaning) ? 'up' : 'down'}">${esc(r.meaning)}</span>` : ''}</div>
        <div class="rd-l2">
          <span class="va a${r.a ? '' : ' none'}" title="${esc(r.a?.text || 'not in ' + d.nameA)}">${esc(la)}</span>
          <svg class="rd-g${canEditB ? ' ed' : ''}" viewBox="0 0 ${Gw} ${g.G}" width="${Gw}" height="${g.G}" aria-hidden="true">${g.svg}</svg>
          <span class="va b${r.b ? '' : ' none'}" title="${esc(r.b?.text || 'not in ' + d.nameB)}">${esc(lb)}</span>
          <span class="dl">${esc(r.deltaText || (r.state === 'onlyA' ? `only in ${d.nameA}` : r.state === 'onlyB' ? `only in ${d.nameB}` : r.state === 'same' ? 'same' : 'differs'))}</span>
          <span class="mg">
            <button class="rd-mv" data-to="a" title="Copy ${esc(d.nameB)}'s value into ${esc(d.nameA)}" aria-label="Copy ${esc(d.nameB)}'s value into ${esc(d.nameA)}"${r.state === 'same' || !canTo('a') ? ' disabled' : ''}>←</button>
            <button class="rd-mv" data-to="b" title="Copy ${esc(d.nameA)}'s value into ${esc(d.nameB)}" aria-label="Copy ${esc(d.nameA)}'s value into ${esc(d.nameB)}"${r.state === 'same' || !canTo('b') ? ' disabled' : ''}>→</button>
          </span>
        </div>`;
      row.addEventListener('pointerenter', () => { hover = r.key; paintBack('a'); paintBack('b'); });
      row.addEventListener('pointerleave', () => { if (hover === r.key) { hover = null; paintBack('a'); paintBack('b'); } });
      row.addEventListener('focus', () => { if (sel !== r.key) select(r.key); });
      spine.append(row);
    }
    if (fk) [...spine.children].find((x) => x.dataset.key === fk)?.focus({ preventScroll: true });
    // scale legend
    const bar = 0.1 * sc;
    scaleEl.hidden = fit;
    scaleEl.innerHTML = `<svg viewBox="0 0 ${bar + 8} 10" width="${bar + 8}" height="10" aria-hidden="true"><path d="M1 5H${bar + 1}M1 1v8M${bar + 1} 1v8"/></svg>0.1 mm`;
    spineHead.innerHTML = `<span><i class="lg a"></i>${esc(d.nameA)} dashed</span><span><i class="lg b"></i>${esc(d.nameB)} solid</span>`
      + `<span class="rd-seg" role="group" aria-label="Drawing scale"><button data-fit="1" aria-pressed="${fit}">each fitted</button><button data-fit="0" aria-pressed="${!fit}">one scale</button></span>`
      + `<span class="hint">drag a drawing sideways to change ${esc(d.nameB)} · ← → copy a value across · click a value in a text to find its rule</span>`;
  }

  // ---------------- edits ----------------
  function rewrite(key, at, len, text) {
    const src = String(ctx.raw[key] ?? '');
    return src.slice(0, at) + text + src.slice(at + len);
  }
  function setB(r, mmVal) {
    const tok = token(r.b.text);
    if (!tok) return;
    ctx.set('b', rewrite('b', r.b.at, r.b.len, writeLike(Math.max(0, mmVal), tok)));
  }
  function copyTo(dir, r) {
    const d = D();
    const from = dir === 'b' ? r.a : r.b, to = dir === 'b' ? r.b : r.a;
    const key = dir;
    if (!from) return;
    let text;
    if (to && to.at != null) {
      const tok = token(to.text);
      text = from.mm && tok ? writeLike(from.num, tok) : from.text;
      ctx.set(key, rewrite(key, to.at, to.len, text));
      return;
    }
    // the rule is missing on that side: add it in that side's format
    const fmt = dir === 'b' ? d.formatB : d.formatA;
    const src = String(ctx.raw[key] ?? '').replace(/\s*$/, '');
    const m = /^([\w.]+?)\.(min|max|opt)(?:\s*\[(.*)\])?$/.exec(r.key);
    let line;
    if (/KiCad/.test(fmt) && m) {
      const cond = m[3] && /^if /.test(m[3]) ? m[3].replace(/^if\s+/, '').replace(/\s+on\s+\S+$/, '') : null;
      const name = from.rule || m[1];
      line = `(rule "${name}"${cond ? ` (condition "${cond}")` : ''} (constraint ${m[1]} (${m[2]} ${from.text})))`;
    } else line = `${r.key} = ${from.text}`;
    ctx.set(key, `${src}${src ? '\n' : ''}${line}`);
  }

  spineHead.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fit]');
    if (!b) return;
    fit = b.dataset.fit === '1';
    drawSpine();
  });
  spine.addEventListener('click', (e) => {
    const b = e.target.closest('.rd-mv');
    const row = e.target.closest('.rd-rule');
    if (!row) return;
    const r = D()?.rules.find((x) => x.key === row.dataset.key);
    if (!r) return;
    if (b && !b.disabled) { select(r.key); copyTo(b.dataset.to, r); return; }
    select(r.key);
  });
  spine.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.rd-g.ed');
    if (!g) return;
    const row = g.closest('.rd-rule');
    const r = D()?.rules.find((x) => x.key === row.dataset.key);
    if (!r?.b?.mm) return;
    e.preventDefault();
    select(r.key);
    const mx = Math.max(r.a?.num || 0, r.b.num || 0) || 1, kind = kindOf(r.key), Gw = geo.Gw;
    const rs = !fit ? geo.sc : kind === 'gap' ? (Gw * 0.42) / mx : kind === 'edge' ? (Gw * 0.5) / mx : kind === 'ring' ? 23 / (mx + 0.15) : 46 / mx;
    const box = g.getBoundingClientRect();
    drag = { key: r.key, x0: e.clientX, v0: r.b.num, sc: rs * (box.width / Gw) };
    spine.setPointerCapture(e.pointerId);
    row.focus({ preventScroll: true });
  });
  spine.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = D()?.rules.find((x) => x.key === drag.key);
    if (!r?.b || r.b.at == null) return;
    const tok = token(r.b.text); if (!tok) return;
    const u = (tok.unit || 'mm').toLowerCase(), per = UNIT_MM[u] || 1, st = (STEP[u] || 0.005) * per;
    const kind = kindOf(r.key);
    const k = kind === 'gap' || kind === 'drill' || kind === 'via' ? 2 : 1;   // symmetric drawings grow both ways
    const mmVal = Math.max(0, Math.round((drag.v0 + (k * (e.clientX - drag.x0)) / drag.sc) / st) * st);
    const text = writeLike(mmVal, tok);
    if (text !== r.b.text) setSoon({ b: rewrite('b', r.b.at, r.b.len, text) });
  });
  const endDrag = () => { drag = null; };
  spine.addEventListener('pointerup', endDrag);
  spine.addEventListener('pointercancel', endDrag);
  spine.addEventListener('keydown', (e) => {
    const row = e.target.closest?.('.rd-rule');
    if (!row || e.target !== row) return;
    if (sel !== row.dataset.key) select(row.dataset.key);
    const rows = [...spine.querySelectorAll('.rd-rule')];
    const i = rows.indexOf(row);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1)];
      if (n) { n.focus(); select(n.dataset.key); }
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const r = D()?.rules.find((x) => x.key === row.dataset.key);
      if (!r?.b?.mm || r.b.at == null) return;
      const tok = token(r.b.text); if (!tok) return;
      e.preventDefault();
      const u = (tok.unit || 'mm').toLowerCase(), per = UNIT_MM[u] || 1;
      const st = (STEP[u] || 0.005) * per * (e.shiftKey ? 10 : 1);
      setB(r, r.b.num + (e.key === 'ArrowRight' ? st : -st));
    }
  });

  // ---------------- top ----------------
  function drawTop() {
    const d = D();
    if (document.activeElement !== nameA) nameA.value = ctx.raw.nameA ?? '';
    if (document.activeElement !== nameB) nameB.value = ctx.raw.nameB ?? '';
    if (document.activeElement !== tolIn) tolIn.value = ctx.raw.tol ?? '';
    onlyBtn.setAttribute('aria-pressed', String(!!ctx.input.only));
    if (!d) { tally.innerHTML = ''; return; }
    const c = d.counts, tot = c.changed + c.onlyA + c.onlyB + c.same || 1;
    const seg = (k, n, label) => `<button class="seg s-${k}" data-seg="${k}" style="flex:${Math.max(n, 0.0001)} 1 0" ${n ? '' : 'hidden'} title="${n} ${esc(label)}"></button>`;
    tally.innerHTML = `<div class="rd-bar">${seg('changed', c.changed, 'changed')}${seg('onlyA', c.onlyA, `only in ${d.nameA}`)}${seg('onlyB', c.onlyB, `only in ${d.nameB}`)}${seg('same', c.same, 'the same')}</div>
      <div class="rd-counts"><span class="s-changed"><b>${c.changed}</b> changed</span><span class="s-onlyA"><b>${c.onlyA}</b> only ${esc(d.nameA)}</span><span class="s-onlyB"><b>${c.onlyB}</b> only ${esc(d.nameB)}</span><span class="s-same"><b>${c.same}</b> same${ctx.input.only && c.same ? ' (hidden)' : ''}</span></div>`;
    void tot;
    tally.querySelector('[data-seg="same"]')?.addEventListener('click', () => ctx.set('only', !ctx.input.only));
    for (const k of ['a', 'b']) {
      const fmt = k === 'a' ? d.formatA : d.formatB;
      const n = d.rules.filter((r) => r[k]).length;
      ed[k].head.innerHTML = `<i class="sw ${k}"></i><b>${esc(k === 'a' ? d.nameA : d.nameB)}</b><span class="fmt">${esc(fmt)}</span><span class="n">${n} rule${n === 1 ? '' : 's'} read</span>`;
    }
  }

  function drawAll() {
    drawTop();
    for (const k of ['a', 'b']) if (document.activeElement !== ed[k].ta && ed[k].ta.value !== String(ctx.raw[k] ?? '')) ed[k].ta.value = String(ctx.raw[k] ?? '');
    if (sel && !D()?.rules.some((r) => r.key === sel)) sel = null;
    drawSpine();
    paintBack('a'); paintBack('b');
    const ws = ctx.result?.warnings || [];
    warnsEl.replaceChildren(...ws.map((w) => h('div', {}, w)));
    warnsEl.hidden = !ws.length;
  }

  ctx.onResult(() => drawAll());
  let lastW = 0;
  new ResizeObserver(() => { const w = spine.clientWidth; if (!drag && Math.abs(w - lastW) > 4) { lastW = w; drawSpine(); } }).observe(spine);
}
