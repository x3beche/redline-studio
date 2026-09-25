// SMD Code Decoder: the page is the part in your tweezers.
//   Tape   - every marking you gave, as parts in the pockets of a carrier
//            tape, each with its value under it. Click a pocket to put that
//            part under the magnifier, x to take it off the tape, type a new
//            marking into the empty pocket.
//   Stage  - the chosen part, magnified: its body, end caps and the printed
//            marking. Each printed character is a wheel: the arrows above and
//            below it, the mouse wheel, a vertical drag or the arrow keys turn
//            it (103 -> 104), typing replaces it. Under the part, brackets
//            group the characters by what they mean (significant digits,
//            multiplier, decimal point, EIA-96 index, EIA-198 letter), with
//            the value they make beside the part.
//   Below  - how it was read, its tolerance, the other markings of the same
//            value (click one to add it to the tape), and the outputs.
// Every value and reading drawn comes from run()'s result.parts.
import { WHEELS } from './tool.js';

const NS = 'http://www.w3.org/2000/svg';
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
const sv = (parent, tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};

const ROLE = {
  sig: ['significant digits', 'sig'],
  mult: ['multiplier', 'mult'],
  point: ['decimal point', 'point'],
  index: ['EIA-96 index', 'index'],
  mant: ['EIA-198 value letter', 'mant'],
  zero: ['zero-ohm', 'zero'],
  bad: ['not read', 'bad'],
};
// multiplier letters in rising order; R, S, H are aliases of Y, X, B
const EIA96_UP = 'ZYXABCDEF', ALIAS = { R: 'Y', S: 'X', H: 'B' };
const split = (s) => String(s || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

export function page(root, ctx) {
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href }));
  const KEY = `redline.tool.${ctx.manifest.id}.sel`;
  let sel = store.get(KEY) || 0;
  let res = null;
  let focusPos = null;     // character to focus after a redraw
  let scrub = null;

  const codes = () => split(ctx.raw.codes);
  const isCap = () => ctx.raw.kind === 'capacitor';
  const setCodes = (list, newSel) => {
    if (newSel != null) { sel = newSel; store.set(KEY, sel); }
    ctx.set('codes', list.join(', '));
  };

  // ---------- bar ----------
  const kindSeg = h('div', { class: 'sc-seg', role: 'radiogroup', 'aria-label': 'Part' });
  const kinds = [['resistor', 'Resistor'], ['capacitor', 'Capacitor']];
  for (const [v, t] of kinds) {
    kindSeg.append(h('button', { type: 'button', role: 'radio', 'data-v': v, onclick: () => ctx.set('kind', v),
      onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!d) return;
        e.preventDefault();
        const n = kinds[clamp(kinds.findIndex((k) => k[0] === v) + d, 0, 1)][0];
        ctx.set('kind', n); requestAnimationFrame(() => kindSeg.querySelector(`[data-v="${n}"]`)?.focus());
      } }, t));
  }
  const count = h('span', { class: 'sc-count' });
  const pasteIn = h('input', { type: 'text', class: 'sc-in sc-all', spellcheck: 'false', 'aria-label': 'All markings, separated by spaces or commas',
    oninput: (e) => ctx.set('codes', e.target.value) });
  const bar = h('div', { class: 'sc-bar' },
    h('span', { class: 'sc-cap' }, 'Parts on the tape'), kindSeg, count,
    h('label', { class: 'sc-allwrap' }, h('span', { class: 'sc-cap' }, 'All markings'), pasteIn));

  // ---------- tape ----------
  const pockets = h('div', { class: 'sc-pockets', role: 'listbox', 'aria-label': 'Parts on the tape; choose one to magnify' });
  const holes = sv(null, 'svg', { class: 'sc-holes', 'aria-hidden': 'true', preserveAspectRatio: 'none' });
  const tape = h('section', { class: 'sc-tape' }, holes, pockets);
  (() => {
    const id = `schole${Math.random().toString(36).slice(2, 7)}`;
    const defs = sv(holes, 'defs');
    const pat = sv(defs, 'pattern', { id, width: 32, height: 12, patternUnits: 'userSpaceOnUse' });
    sv(pat, 'circle', { cx: 16, cy: 6, r: 3.2, class: 'sc-hole' });
    sv(holes, 'rect', { x: 0, y: 0, width: '100%', height: 12, fill: `url(#${id})` });
  })();

  // ---------- stage ----------
  const markIn = h('input', { type: 'text', class: 'sc-in sc-mark', spellcheck: 'false', 'aria-label': 'Marking of the part under the magnifier',
    oninput: (e) => { const l = codes(); l[clamp(sel, 0, l.length)] = e.target.value.replace(/[\s,;]/g, ''); setCodes(l.filter(Boolean)); } });
  const stageSvg = sv(null, 'svg', { class: 'sc-stage-svg', role: 'group', 'aria-label': 'The part magnified; each printed character is a wheel you can turn' });
  const stage = h('section', { class: 'sc-card sc-stage' },
    h('div', { class: 'sc-stage-head' }, h('label', { class: 'sc-cap', for: 'sc-mark' }, 'Marking'), markIn,
      h('span', { class: 'sc-tip' }, 'Turn a character: arrows above and below it, mouse wheel, drag up or down, or arrow keys · type to replace')),
    h('div', { class: 'sc-box' }, stageSvg));
  markIn.id = 'sc-mark';

  // ---------- below ----------
  const reading = h('div', { class: 'sc-card sc-reading' });
  const alsoBox = h('div', { class: 'sc-card sc-also' });
  const below = h('div', { class: 'sc-below' }, reading, alsoBox, ctx.outputs);

  root.append(h('div', { class: 'sc' }, bar, tape, stage, below));

  // ---------- mini part (for pockets and chips) ----------
  function miniPart(code, cap, ok) {
    const s = sv(null, 'svg', { viewBox: '0 0 84 40', class: `sc-mini${cap ? ' cap' : ''}${ok ? '' : ' bad'}`, 'aria-hidden': 'true' });
    sv(s, 'rect', { x: 2, y: 4, width: 80, height: 32, rx: 3, class: 'sc-mbody' });
    sv(s, 'rect', { x: 2, y: 4, width: 11, height: 32, rx: 2, class: 'sc-mcap' });
    sv(s, 'rect', { x: 71, y: 4, width: 11, height: 32, rx: 2, class: 'sc-mcap' });
    const fs = code.length > 4 ? 13 : 17;
    sv(s, 'text', { x: 42, y: 20 + fs * 0.36, 'text-anchor': 'middle', class: 'sc-mprint', 'font-size': fs }, code);
    return s;
  }

  // ---------- tape ----------
  function drawTape() {
    const list = codes(), parts = res?.parts || [];
    pockets.replaceChildren();
    list.forEach((c, i) => {
      const p = parts[i];
      const ok = !!p?.ok;
      const pocket = h('div', { class: `sc-pocket${i === sel ? ' on' : ''}${ok ? '' : ' bad'}` });
      const btn = h('button', { type: 'button', class: 'sc-pick', role: 'option', 'aria-selected': String(i === sel),
        'aria-label': `${c}: ${ok ? p.text : 'not read'}`, onclick: () => { sel = i; store.set(KEY, sel); render(); },
        onkeydown: (e) => {
          const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
          if (d) { e.preventDefault(); sel = clamp(i + d, 0, list.length - 1); store.set(KEY, sel); render(); pockets.querySelectorAll('.sc-pick')[sel]?.focus(); }
          if (e.key === 'Delete') { e.preventDefault(); remove(i); }
        } },
      miniPart(c, isCap(), ok || !p), h('b', { class: 'sc-pval' }, p ? (ok ? p.text : 'not read') : ''));
      const x = h('button', { type: 'button', class: 'sc-x', title: `Take ${c} off the tape`, 'aria-label': `Remove ${c}`, onclick: () => remove(i) }, '×');
      pocket.append(btn, x);
      pockets.append(pocket);
    });
    const add = h('input', { type: 'text', class: 'sc-in sc-addin', spellcheck: 'false', placeholder: isCap() ? '104' : '4R7', 'aria-label': 'Add a marking to the tape',
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        const v = split(add.value);
        if (!v.length) return;
        e.preventDefault();
        const l = codes();
        setCodes([...l, ...v], l.length);
        requestAnimationFrame(() => pockets.querySelector('.sc-addin')?.focus());
      } });
    pockets.append(h('div', { class: 'sc-pocket sc-empty' }, h('span', { class: 'sc-cap' }, 'Add a marking'), add, h('small', {}, 'Enter')));
    if (list.length > 50) count.textContent = `${list.length} parts, first 50 read`;
    else count.textContent = `${parts.filter((p) => p.ok).length} of ${list.length} read`;
  }
  function remove(i) {
    const l = codes();
    l.splice(i, 1);
    setCodes(l, clamp(sel > i ? sel - 1 : sel, 0, Math.max(0, l.length - 1)));
  }

  // ---------- wheels ----------
  function wheelFor(ch, role) {
    if (/\d/.test(ch)) return WHEELS.digit;
    if (role === 'mult') return EIA96_UP;
    if (role === 'mant') return WHEELS.eia198;
    if (role === 'point') return isCap() ? (ch === 'R' || ch === 'r' ? 'Rnu' : 'pnu') : 'mRkM';
    return null;
  }
  function turn(pos, dir) {
    const l = codes(), c = l[sel];
    if (c == null) return;
    const p = res?.parts?.[sel];
    let role = 'bad', at = 0;
    for (const g of p?.groups || []) { if (pos < at + g.chars.length) { role = g.role; break; } at += g.chars.length; }
    const ch = c[pos];
    const wheel = wheelFor(ch, role);
    if (!wheel) return;
    // an EIA-96 index turns as one number, 01..96
    if (role === 'index') {
      const n = ((Number(c.slice(0, 2)) - 1 + dir + 96) % 96) + 1;
      l[sel] = String(n).padStart(2, '0') + c.slice(2);
    } else {
      const cur = wheel.indexOf(ALIAS[ch] && wheel === EIA96_UP ? ALIAS[ch] : ch);
      const next = wheel[((cur < 0 ? 0 : cur + dir) + wheel.length) % wheel.length];
      l[sel] = c.slice(0, pos) + next + c.slice(pos + 1);
    }
    focusPos = pos;
    setCodes(l);
  }
  function typeAt(pos, key) {
    const l = codes(), c = l[sel];
    if (c == null) return;
    l[sel] = c.slice(0, pos) + key + c.slice(pos + 1);
    focusPos = Math.min(pos + 1, l[sel].length - 1);
    setCodes(l);
  }

  // ---------- stage ----------
  function drawStage() {
    stageSvg.replaceChildren();
    const list = codes();
    const code = list[sel];
    const p = res?.parts?.[sel];
    const box = stageSvg.getBoundingClientRect();
    const W = Math.max(300, box.width), H = Math.max(240, box.height);
    stageSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (code == null || !p) {
      sv(stageSvg, 'text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'sc-empty-t' }, 'Add a marking to the tape to read it here');
      return;
    }
    const narrow = W < 620;
    const cap = isCap();
    const n = code.length;
    // sizes: the print fills most of the body; the body keeps a chip's 2:1 look
    const valueW = narrow ? 0 : Math.min(360, W * 0.34);
    const avail = W - valueW - (narrow ? 32 : 80);
    const fs = clamp(Math.min(avail / (n * 0.62 + 1.6), (H - (narrow ? 210 : 150)) / 1.9), 26, 132);
    const cw = fs * 0.62;
    const capW = fs * 0.55, padX = fs * 0.35;
    const bodyW = Math.max(n * cw + 2 * padX + 2 * capW, fs * 2.6), bodyH = fs * 1.35;
    const bx = narrow ? (W - bodyW) / 2 : Math.max(24, (W - valueW - bodyW) / 2 - 10);
    const by = narrow ? 34 : Math.max(34, (H - bodyH - 120) / 2);
    const tx0 = bx + (bodyW - n * cw) / 2;
    // body
    const part = sv(stageSvg, 'g', { class: `sc-part${cap ? ' cap' : ''}` });
    sv(part, 'rect', { x: bx + 4, y: by + 6, width: bodyW, height: bodyH, rx: 6, class: 'sc-shadow' });
    sv(part, 'rect', { x: bx, y: by, width: bodyW, height: bodyH, rx: 6, class: 'sc-body' });
    sv(part, 'rect', { x: bx, y: by, width: capW, height: bodyH, rx: 5, class: 'sc-endcap' });
    sv(part, 'rect', { x: bx + bodyW - capW, y: by, width: capW, height: bodyH, rx: 5, class: 'sc-endcap' });
    sv(part, 'line', { x1: bx + capW, x2: bx + capW, y1: by, y2: by + bodyH, class: 'sc-seam' });
    sv(part, 'line', { x1: bx + bodyW - capW, x2: bx + bodyW - capW, y1: by, y2: by + bodyH, class: 'sc-seam' });
    // groups -> per-character role
    const roles = [];
    for (const g of p.groups) for (let k = 0; k < g.chars.length; k++) roles.push(g.role);
    const baseY = by + bodyH / 2 + fs * 0.36;
    for (let i = 0; i < n; i++) {
      const ch = code[i], role = roles[i] || 'bad';
      const wheel = wheelFor(ch, role) || (role === 'index' ? WHEELS.digit : null);
      const cx = tx0 + i * cw + cw / 2;
      const g = sv(stageSvg, 'g', { class: `sc-ch r-${ROLE[role]?.[1] || 'bad'}${wheel ? '' : ' fixed'}`, tabindex: 0, role: 'spinbutton', 'data-pos': i,
        'aria-label': `Character ${i + 1}, ${ROLE[role]?.[0] || ''}`, 'aria-valuetext': ch });
      sv(g, 'rect', { x: cx - cw / 2 + 2, y: by + bodyH * 0.14, width: cw - 4, height: bodyH * 0.72, rx: 4, class: 'sc-chbox' });
      sv(g, 'text', { x: cx, y: baseY, 'text-anchor': 'middle', class: 'sc-print', 'font-size': fs }, ch);
      if (wheel) {
        const up = sv(g, 'g', { class: 'sc-step', 'data-dir': 1 });
        sv(up, 'rect', { x: cx - cw / 2 + 2, y: by - 26, width: cw - 4, height: 22, rx: 4, class: 'sc-stepbg' });
        sv(up, 'path', { d: `M${cx - 7},${by - 10} L${cx},${by - 18} L${cx + 7},${by - 10}`, class: 'sc-arrow' });
        const dn = sv(g, 'g', { class: 'sc-step', 'data-dir': -1 });
        sv(dn, 'rect', { x: cx - cw / 2 + 2, y: by + bodyH + 4, width: cw - 4, height: 22, rx: 4, class: 'sc-stepbg' });
        sv(dn, 'path', { d: `M${cx - 7},${by + bodyH + 12} L${cx},${by + bodyH + 20} L${cx + 7},${by + bodyH + 12}`, class: 'sc-arrow' });
      }
    }
    // brackets under the part: each group, what it means
    const yb = by + bodyH + 40;
    let at = 0;
    const labels = [];
    for (const gr of p.ok ? p.groups : []) {
      const x0 = tx0 + at * cw + 3, x1 = tx0 + (at + gr.chars.length) * cw - 3;
      at += gr.chars.length;
      const cls = `r-${ROLE[gr.role]?.[1] || 'bad'}`;
      const g = sv(stageSvg, 'g', { class: `sc-brk ${cls}` });
      sv(g, 'path', { d: `M${x0},${yb} L${x0},${yb + 7} L${x1},${yb + 7} L${x1},${yb}`, class: 'sc-brkline' });
      labels.push({ g, cx: (x0 + x1) / 2, x0, x1, gr });
    }
    // labels: stagger when they would overlap
    let lastEnd = -Infinity, row = 0;
    for (const L of labels) {
      const wLab = Math.max(L.gr.meaning.length * 7.6, ROLE[L.gr.role][0].length * 6.2) + 10;
      row = L.cx - wLab / 2 < lastEnd ? row + 1 : 0;
      const y = yb + 26 + row * 34;
      if (row) sv(L.g, 'line', { x1: L.cx, x2: L.cx, y1: yb + 8, y2: y - 13, class: 'sc-brkline' });
      sv(L.g, 'text', { x: L.cx, y, 'text-anchor': 'middle', class: 'sc-mean' }, L.gr.meaning);
      sv(L.g, 'text', { x: L.cx, y: y + 14, 'text-anchor': 'middle', class: 'sc-role' }, ROLE[L.gr.role][0]);
      lastEnd = L.cx + wLab / 2;
    }
    // the value
    const vx = narrow ? W / 2 : bx + bodyW + 44, vy = narrow ? (p.ok ? yb + 26 + (row + 1) * 34 + 26 : yb + 22) : by + bodyH / 2;
    const anchor = narrow ? 'middle' : 'start';
    if (p.ok) {
      sv(stageSvg, 'text', { x: vx, y: vy - (narrow ? 0 : 18), 'text-anchor': anchor, class: 'sc-eq' }, '=');
      sv(stageSvg, 'text', { x: narrow ? vx : vx + 30, y: vy + (narrow ? 0 : 0) - (narrow ? 0 : 18) + (narrow ? 0 : 0), 'text-anchor': anchor, class: 'sc-value', 'font-size': narrow ? 34 : clamp(fs * 0.5, 30, 54), dx: narrow ? 14 : 0 }, p.text);
      sv(stageSvg, 'text', { x: vx, y: vy + (narrow ? 24 : 16), 'text-anchor': anchor, class: 'sc-vsub' }, `${p.base} · ${p.tol.split(/[,;(]/)[0].trim()}`);
      sv(stageSvg, 'text', { x: vx, y: vy + (narrow ? 42 : 34), 'text-anchor': anchor, class: 'sc-vsub2' }, p.format);
      if (p.note) {
        const nt = sv(stageSvg, 'g', { class: 'sc-noteflag' });
        sv(nt, 'circle', { cx: narrow ? 20 : vx + 7, cy: vy + (narrow ? 62 : 56), r: 7 });
        sv(nt, 'text', { x: narrow ? 20 : vx + 7, y: vy + (narrow ? 66 : 60), 'text-anchor': 'middle' }, '!');
        sv(stageSvg, 'text', { x: narrow ? 32 : vx + 20, y: vy + (narrow ? 66 : 60), class: 'sc-warn-t' }, p.note.length > 60 && !narrow ? p.note.slice(0, 58) + '…' : p.note);
      }
    } else {
      sv(stageSvg, 'text', { x: vx, y: vy - 10, 'text-anchor': anchor, class: 'sc-value bad', 'font-size': narrow ? 26 : 36 }, 'not read');
      const words = p.error.split(' ');
      let line = '', ly = vy + 16;
      const maxC = narrow ? 42 : Math.max(24, Math.floor((W - vx - 16) / 7.2));
      for (const w of words) {
        if ((line + ' ' + w).trim().length > maxC) { sv(stageSvg, 'text', { x: vx, y: ly, 'text-anchor': anchor, class: 'sc-warn-t' }, line.trim()); line = w; ly += 16; }
        else line += ' ' + w;
      }
      if (line.trim()) sv(stageSvg, 'text', { x: vx, y: ly, 'text-anchor': anchor, class: 'sc-warn-t' }, line.trim());
    }
    if (focusPos != null) {
      const f = stageSvg.querySelector(`.sc-ch[data-pos="${clamp(focusPos, 0, n - 1)}"]`);
      focusPos = null;
      f?.focus({ preventScroll: true });
    }
  }

  // ---------- reading and alternatives ----------
  function drawBelow() {
    const p = res?.parts?.[sel];
    reading.replaceChildren(h('div', { class: 'sc-h' }, 'How it reads'));
    if (!p) { reading.append(h('p', { class: 'sc-soft' }, 'No part chosen.')); alsoBox.replaceChildren(); return; }
    const dl = h('dl', { class: 'sc-dl' });
    const row = (k, v, cls) => dl.append(h('dt', {}, k), h('dd', { class: cls || null }, v));
    row('Marking', p.code);
    if (p.ok) {
      row('Value', p.text);
      row('In base units', p.base);
      row('Read as', p.format);
      row('Tolerance', p.tol);
      if (p.note) row('Check', p.note, 'warn');
    } else row('Problem', p.error, 'bad');
    reading.append(dl);
    const others = (res?.warnings || []).filter((w) => !w.startsWith(`${p.code}:`));
    if (others.length) reading.append(h('div', { class: 'sc-others' }, h('b', {}, `Other parts on the tape: ${others.length} to check`), ...others.map((w) => h('div', {}, w))));
    reading.append(h('details', { class: 'sc-notes' }, h('summary', {}, 'Code rules'), ...(res?.notes || []).map((t) => h('div', {}, t))));

    alsoBox.replaceChildren(h('div', { class: 'sc-h' }, p.ok ? `${p.text} is also marked` : 'Also marked'));
    if (!p.ok || !p.also?.length) { alsoBox.append(h('p', { class: 'sc-soft' }, p.ok ? 'No other standard marking for this value.' : 'Fix the marking to see its other forms.')); return; }
    const chips = h('div', { class: 'sc-chips' });
    for (const a of p.also) {
      chips.append(h('button', { type: 'button', class: 'sc-chip', title: `Add ${a} to the tape`,
        onclick: () => { const l = codes(); setCodes([...l, a], l.length); } }, miniPart(a, isCap(), true), h('span', {}, a)));
    }
    alsoBox.append(chips, h('p', { class: 'sc-soft' }, 'Click one to put it on the tape.'));
  }

  function render() {
    const list = codes();
    sel = clamp(sel, 0, Math.max(0, list.length - 1));
    for (const b of kindSeg.children) { const on = b.dataset.v === (isCap() ? 'capacitor' : 'resistor'); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    if (document.activeElement !== pasteIn) pasteIn.value = ctx.raw.codes ?? '';
    if (document.activeElement !== markIn) markIn.value = list[sel] ?? '';
    const active = document.activeElement;
    const refocusPick = active?.classList?.contains('sc-pick');
    drawTape();
    if (refocusPick) pockets.querySelectorAll('.sc-pick')[sel]?.focus({ preventScroll: true });
    const on = pockets.children[sel];
    if (on) {
      const l = on.offsetLeft, r = l + on.offsetWidth;
      if (l < pockets.scrollLeft) pockets.scrollLeft = l - 8;
      else if (r > pockets.scrollLeft + pockets.clientWidth) pockets.scrollLeft = r - pockets.clientWidth + 8;
    }
    drawStage();
    drawBelow();
  }
  ctx.onResult((r) => { res = r; render(); });

  // ---------- interaction on the stage ----------
  stageSvg.addEventListener('click', (e) => {
    const st = e.target.closest('.sc-step');
    if (!st) return;
    const ch = st.closest('.sc-ch');
    turn(Number(ch.dataset.pos), Number(st.dataset.dir));
  });
  stageSvg.addEventListener('wheel', (e) => {
    const ch = e.target.closest('.sc-ch');
    if (!ch || ch.classList.contains('fixed')) return;
    e.preventDefault();
    turn(Number(ch.dataset.pos), e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  stageSvg.addEventListener('pointerdown', (e) => {
    const ch = e.target.closest('.sc-ch');
    if (!ch || e.target.closest('.sc-step') || ch.classList.contains('fixed')) return;
    e.preventDefault();
    ch.focus({ preventScroll: true });
    stageSvg.setPointerCapture(e.pointerId);
    scrub = { pos: Number(ch.dataset.pos), y: e.clientY };
    stageSvg.classList.add('scrubbing');
  });
  stageSvg.addEventListener('pointermove', (e) => {
    if (!scrub) return;
    const steps = Math.trunc((scrub.y - e.clientY) / 22);
    if (steps) { scrub.y -= steps * 22; turn(scrub.pos, Math.sign(steps)); }
  });
  const endScrub = () => { scrub = null; stageSvg.classList.remove('scrubbing'); };
  stageSvg.addEventListener('pointerup', endScrub);
  stageSvg.addEventListener('pointercancel', endScrub);
  stageSvg.addEventListener('keydown', (e) => {
    const ch = e.target.closest?.('.sc-ch');
    if (!ch) return;
    const pos = Number(ch.dataset.pos), n = (codes()[sel] || '').length;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); turn(pos, e.key === 'ArrowUp' ? 1 : -1); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      stageSvg.querySelector(`.sc-ch[data-pos="${clamp(pos + (e.key === 'ArrowRight' ? 1 : -1), 0, n - 1)}"]`)?.focus();
      return;
    }
    if (e.key.length === 1 && /[0-9A-Za-zµ]/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeAt(pos, e.key); }
  });

  let rz = 0;
  new ResizeObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(drawStage); }).observe(stageSvg.parentElement);
}
