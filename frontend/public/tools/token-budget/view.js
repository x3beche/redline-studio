// Token Counter & Context Budget, drawn as the thing itself: one bar per
// model, each to the scale of that model's own window, filled by the prompt's
// parts in colour, then the tokens reserved for the answer, then what is
// left. A prompt that does not fit runs past the window line, hatched red.
//   Drag the reserve handle (the end of the hatched answer block) on any bar
//   to set max_tokens; click a model to plan cuts for it; edit the parts on
//   the left, with their own token counts and shares, and apply a suggested
//   cut to a repeated or sized part in one click.
// Every number drawn comes from run()'s result (result.draw).

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => {
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
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const short = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `${Number((n / 1e6).toFixed(a >= 1e7 ? 1 : 2))}M`;
  if (a >= 1e3) return `${Number((n / 1e3).toFixed(a >= 1e5 ? 0 : 1))}K`;
  return String(Math.round(n));
};
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const COLORS = 6;
const KIND_ORDER = ['system', 'tools', 'examples', 'history', 'documents', 'question', 'other'];

// ---- parts text <-> list (same grammar as tool.js parseParts) ----
function parse(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\s*={3,}\s*(.+?)\s*={3,}\s*$/.exec(line);
    if (m) {
      let name = m[1], size = '';
      const fx = /\s*=\s*([\d.,_]+\s*[kKmM]?)\s*(?:tokens?|tok)?$/.exec(name);
      if (fx) { size = `=${fx[1].replace(/\s/g, '')}`; name = name.slice(0, fx.index); }
      const mx = /\s*[×xX*]\s*(\d+(?:\.\d+)?)$/.exec(name);
      if (!fx && mx) { size = `×${mx[1]}`; name = name.slice(0, mx.index); }
      cur = { name: name.trim(), size, text: '' };
      out.push(cur);
      continue;
    }
    if (!cur) { if (!line.trim()) continue; cur = { name: 'text', size: '', text: '' }; out.push(cur); }
    cur.text += (cur.text ? '\n' : '') + line;
  }
  for (const p of out) p.text = p.text.replace(/\n+$/, '');
  return out;
}
function join(list) {
  return list.map((p) => {
    const sz = String(p.size || '').trim();
    const m = /^=\s*(.+)$/.exec(sz), x = /^[×xX*]\s*(.+)$/.exec(sz);
    const tail = m ? ` = ${m[1]}` : x ? ` ×${x[1]}` : '';
    return `=== ${p.name || 'part'}${tail} ===\n${p.text}`;
  }).join('\n\n') + '\n';
}

export function page(root, ctx) {
  const wrap = h('div', { class: 'tb' });
  root.append(wrap);
  let res = null, list = parse(ctx.raw.parts), lastText = ctx.raw.parts, timer = 0, dragging = false, focusKey = null;

  // ---------- parts editor ----------
  const partsBox = h('div', { class: 'tb-parts' });
  const totalLine = h('span', { class: 'tb-sub' });
  const addSel = h('select', { class: 'tb-add', 'aria-label': 'Add a part', onchange: (e) => {
    const k = e.target.value; e.target.value = '';
    if (!k) return;
    const names = { system: 'system', tools: 'tools', examples: 'examples ×3', history: 'history ×10', documents: 'documents', question: 'question', other: 'notes', sized: 'attachment = 20k' };
    const p = parse(`=== ${names[k]} ===\n`)[0] || { name: k, size: '', text: '' };
    const qi = list.findIndex((x) => /question|query|task/i.test(x.name));
    if (qi >= 0 && k !== 'question') list.splice(qi, 0, p); else list.push(p);
    commit(true);
  } }, h('option', { value: '' }, '+ Add part…'), ...['system', 'tools', 'examples', 'history', 'documents', 'question', 'other'].map((k) => h('option', { value: k }, k)), h('option', { value: 'sized' }, 'part of known size (no text)'));
  const partsCard = h('section', { class: 'tb-card tb-partcard' },
    h('div', { class: 'tb-head' }, h('h2', {}, 'Prompt parts'), totalLine, h('span', { class: 'tb-right' }, addSel)),
    partsBox,
    h('div', { class: 'tb-help' }, 'Size: blank = the text once, ', h('code', {}, '×18'), ' = the text 18 times (turns, chunks), ', h('code', {}, '=110k'), ' = a part of known size without pasting it. Paste a whole prompt into one part and split it with lines like ', h('code', {}, '=== history ==='), '.'));

  const commit = (redraw) => {
    const text = join(list);
    lastText = text;
    clearTimeout(timer);
    if (redraw) { drawParts(); ctx.set('parts', text); }
    else timer = setTimeout(() => ctx.set('parts', text), 250);
  };

  const drawParts = () => {
    partsBox.replaceChildren(...list.map((p, i) => {
      const row = h('div', { class: 'tb-part', 'data-i': i });
      const sw = h('i', { class: `tb-sw tb-c${i % COLORS}` });
      const name = h('input', { type: 'text', class: 'tb-name', value: p.name, 'aria-label': `Part ${i + 1} name`, spellcheck: 'false',
        oninput: (e) => { p.name = e.target.value; commit(); } });
      const size = h('input', { type: 'text', class: 'tb-size', value: p.size, placeholder: '×1', 'aria-label': `Part ${i + 1} size (×N or =tokens)`, spellcheck: 'false',
        oninput: (e) => { p.size = e.target.value.replace(/^x/i, '×'); commit(); } });
      const kind = h('span', { class: 'tb-kind' });
      const tok = h('b', { class: 'tb-tok' });
      const share = h('span', { class: 'tb-share' }, h('i', { class: `tb-c${i % COLORS}` }));
      const up = h('button', { class: 'k-btn tb-mini', title: 'Move up', 'aria-label': `Move part ${i + 1} up`, disabled: i === 0 || null, onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; commit(true); } }, '↑');
      const down = h('button', { class: 'k-btn tb-mini', title: 'Move down', 'aria-label': `Move part ${i + 1} down`, disabled: i === list.length - 1 || null, onclick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; commit(true); } }, '↓');
      const del = h('button', { class: 'k-btn tb-mini', title: 'Remove part', 'aria-label': `Remove part ${i + 1}`, onclick: () => { list.splice(i, 1); commit(true); } }, '×');
      const sized = /^=/.test(String(p.size).trim());
      const ta = h('textarea', { class: 'tb-ta', rows: sized ? 1 : Math.min(8, Math.max(2, p.text.split('\n').length)), spellcheck: 'false', 'aria-label': `Part ${i + 1} text`,
        placeholder: sized ? 'optional note (not counted: the size is given)' : 'paste the text of this part',
        oninput: (e) => { p.text = e.target.value; commit(); } });
      ta.value = p.text;
      row.append(h('div', { class: 'tb-prow' }, sw, name, size, kind, tok, h('span', { class: 'tb-btns' }, up, down, del)), share, ta);
      row._set = (pp, tot) => {
        kind.textContent = pp ? pp.kind : '';
        tok.textContent = pp ? short(pp.o200k) : '';
        tok.title = pp ? `${fmt(pp.o200k)} tokens (o200k est.), ${fmt(pp.cl100k)} (cl100k est.)${pp.band ? `, ±${Math.round(pp.band * 100)} %` : ''} · ${pp.script}${pp.msgs ? ` · ${pp.msgs} messages framed` : ''}` : '';
        share.firstChild.style.width = `${tot ? Math.max(0.5, (pp.o200k / tot) * 100) : 0}%`;
        share.title = pp && tot ? `${((pp.o200k / tot) * 100).toFixed(1)} % of the prompt` : '';
      };
      return row;
    }));
    if (res) fillParts();
  };
  const fillParts = () => {
    const d = res.draw;
    [...partsBox.children].forEach((row, i) => row._set && row._set(d.parts[i], d.totO));
    totalLine.innerHTML = '';
    totalLine.append('≈ ', h('b', {}, fmt(d.totO)), ` tokens (o200k est. ±${Math.round(d.bandO * 100)} %) · `, h('b', {}, fmt(d.totC)), ' cl100k');
  };

  // ---------- bars ----------
  const reserveIn = h('input', { type: 'text', class: 'tb-num', inputmode: 'numeric', 'aria-label': 'Reserved for the answer (tokens)',
    onchange: (e) => { const v = ctx.parseEng(e.target.value); if (v != null && v >= 0) ctx.set('reserve', Math.round(v)); } });
  const basisSel = h('select', { 'aria-label': 'Fit on', onchange: (e) => ctx.set('basis', e.target.value) },
    h('option', { value: 'high' }, 'high end of estimate'), h('option', { value: 'estimate' }, 'the estimate'));
  const barsSub = h('span', { class: 'tb-sub' });
  const svg = s('svg', { class: 'tb-svg', role: 'group', 'aria-label': 'Context budget per model' });
  const legend = h('div', { class: 'tb-legend' });
  const barsCard = h('section', { class: 'tb-card' },
    h('div', { class: 'tb-head' }, h('h2', {}, 'Context windows'), barsSub),
    h('div', { class: 'tb-bar' },
      h('label', {}, 'Reserved for the answer', reserveIn),
      h('label', {}, 'Fit on', basisSel),
      h('span', { class: 'tb-right tb-sub' }, 'each bar is to its own model\'s scale')),
    svg, legend,
    h('div', { class: 'tb-help' }, 'Drag the handle at the end of the hatched answer block to set the reserve (', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' 1K, ', h('kbd', {}, 'Shift'), ' 8K, ', h('kbd', {}, 'Home'), ' 0). Click a model, or focus it and press ', h('kbd', {}, 'Enter'), ', to plan cuts for it.'));

  // ---------- cuts ----------
  const cutsTitle = h('h2', {});
  const cutsBody = h('div', { class: 'tb-cuts' });
  const cutsCard = h('section', { class: 'tb-card' }, h('div', { class: 'tb-head' }, cutsTitle), cutsBody);

  // ---------- models editor ----------
  const modelsBody = h('div', { class: 'tb-medit' });
  const modelsCard = h('details', { class: 'tb-card tb-models' }, h('summary', {}, 'Model table (as of 2026-09 — check each row against the provider\'s page)'), modelsBody);

  const warns = h('div', { class: 'tb-warns', role: 'status', 'aria-live': 'polite' });
  const notes = h('details', { class: 'tb-notes' }, h('summary', {}, 'Method and notes'));

  barsCard.classList.add('tb-o1'); warns.classList.add('tb-o2'); modelsCard.classList.add('tb-o5'); notes.classList.add('tb-o6');
  wrap.append(
    h('div', { class: 'tb-col tb-left tb-o3' }, partsCard),
    h('div', { class: 'tb-col tb-main' }, barsCard, warns, h('div', { class: 'tb-duo tb-o4' }, cutsCard, ctx.outputs), modelsCard, notes));
  // The output panel opens on the budget table the first time.
  let firstTab = true;
  try { firstTab = !localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`); } catch { /* private window */ }

  // ---- bars drawing ----
  const setReserve = (v) => ctx.set('reserve', Math.max(0, Math.round(v / 256) * 256));
  const drawBars = () => {
    const d = res.draw;
    const W = Math.max(300, svg.parentNode.clientWidth - 2);
    const narrow = W < 560;
    const LW = narrow ? 0 : 172, RW = narrow ? 0 : 128, RH = narrow ? 44 : 30, TOP = 6;
    const X0 = narrow ? 8 : LW, X1 = W - (narrow ? 8 : RW) - 4;
    const H = TOP + d.models.length * RH + 8;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);
    const hadFocus = svg.contains(document.activeElement);
    svg.replaceChildren();
    const defs = s('defs');
    const pat = (id, cls) => { const p = s('pattern', { id, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }); p.append(s('rect', { width: 6, height: 6, class: `${cls}-bg` }), s('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: `${cls}-ln` })); defs.append(p); };
    pat('tb-hatch-res', 'tb-res'); pat('tb-hatch-over', 'tb-over');
    svg.append(defs);
    d.models.forEach((m, r) => {
      const y = TOP + r * RH + (narrow ? 16 : 4), bh = narrow ? 18 : 20;
      const shared = m.mode === 'shared';
      const used = m.input + (shared ? m.reserve : 0);
      const dom = Math.max(m.ctx, used) * 1.0;
      const sx = (t) => X0 + (Math.min(t, dom) / dom) * (X1 - X0);
      const g = s('g', { class: `tb-row${d.target === m.idx ? ' tb-target' : ''}`, tabindex: 0, role: 'button',
        'aria-label': `${m.name}: ${fmt(m.input)} of ${fmt(m.ctx)} tokens, ${m.fits ? `fits, ${fmt(m.room)} left for the answer` : `over by ${fmt(m.over)}`}. Press Enter to plan cuts for it.`, 'data-k': `row${m.idx}` });
      g.addEventListener('click', (e) => { if (e.target.closest('.tb-hdl')) return; ctx.set('target', m.name); });
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusKey = `row${m.idx}`; ctx.set('target', m.name); } });
      g.append(s('rect', { x: 0, y: y - (narrow ? 16 : 4), width: W, height: RH, class: 'tb-rowbg' }));
      // label
      if (narrow) g.append(s('text', { x: X0, y: y - 4, class: 'tb-name' }, `${m.name} · ${short(m.ctx)}`));
      else {
        g.append(s('text', { x: 8, y: y + 10, class: 'tb-name' }, m.name));
        g.append(s('text', { x: 8, y: y + 20, class: 'tb-small soft' }, `${short(m.ctx)} · ${m.out ? short(m.out) : '–'} out${m.factor !== 1 ? ` · ×${m.factor}` : ''}`));
      }
      // track (the window)
      g.append(s('rect', { x: X0, y, width: sx(m.ctx) - X0, height: bh, rx: 2, class: 'tb-track' }));
      // parts
      let acc = 0;
      for (const sg of m.segs) {
        if (sg.t <= 0) continue;
        const x = sx(acc), w = Math.max(0.5, sx(acc + sg.t) - x);
        const p = d.parts[sg.i];
        const rct = s('rect', { x, y, width: w, height: bh, class: `tb-seg tb-c${sg.i % COLORS}` });
        rct.append(s('title', {}, `${p.name}: ${fmt(sg.t)} tokens on ${m.name}`));
        g.append(rct);
        acc += sg.t;
      }
      // estimate band whisker (est .. hi)
      if (m.hi > m.lo) {
        const a = sx(m.lo), b = sx(m.hi), yy = y + bh + 3;
        g.append(s('line', { x1: a, x2: b, y1: yy, y2: yy, class: 'tb-band' }), s('line', { x1: sx(m.est), x2: sx(m.est), y1: yy - 2.5, y2: yy + 2.5, class: 'tb-band' }));
      }
      // reserve
      if (shared && m.reserve > 0) {
        const x = sx(m.input), w = Math.max(1, sx(m.input + m.reserve) - x);
        const rr = s('rect', { x, y, width: w, height: bh, class: 'tb-resv' });
        rr.append(s('title', {}, `reserved for the answer: ${fmt(m.reserve)}${m.capped ? ' (capped at max output)' : ''}`));
        g.append(rr);
      }
      // over the window
      if (used > m.ctx) {
        const x = sx(m.ctx);
        g.append(s('rect', { x, y: y - 2, width: Math.max(1, X1 - x), height: bh + 4, class: 'tb-overz' }));
      }
      // window line
      g.append(s('line', { x1: sx(m.ctx), x2: sx(m.ctx), y1: y - 4, y2: y + bh + 4, class: `tb-win${m.fits ? '' : ' bad'}` }));
      // reserve handle
      if (shared) {
        const hx = sx(m.input + m.reserve);
        const hd = s('g', { class: 'tb-hdl', tabindex: 0, role: 'slider', 'aria-label': `Reserved output on ${m.name}`, 'aria-valuemin': 0, 'aria-valuemax': m.out || m.ctx, 'aria-valuenow': m.reserve, 'data-k': `hdl${m.idx}` });
        hd.append(s('rect', { x: hx - 5, y: y - 5, width: 10, height: bh + 10, rx: 2, class: 'tb-hdl-hit' }), s('rect', { x: hx - 1.5, y: y - 3, width: 3, height: bh + 6, rx: 1, class: 'tb-hdl-bar ring' }));
        hd.addEventListener('pointerdown', (e) => {
          e.preventDefault(); e.stopPropagation();
          focusKey = `hdl${m.idx}`;
          dragging = true;
          const rect = svg.getBoundingClientRect();
          const scale = W / rect.width;
          let pend = null, raf = 0;
          const move = (ev) => {
            const x = (ev.clientX - rect.left) * scale;
            const t = ((Math.max(X0, Math.min(X1, x)) - X0) / (X1 - X0)) * dom - m.input;
            pend = Math.max(0, Math.min(m.out || m.ctx, t));
            if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (pend != null) setReserve(pend); });
          };
          const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); dragging = false; if (pend != null) setReserve(pend); };
          window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
        });
        hd.addEventListener('keydown', (e) => {
          const step = e.shiftKey ? 8192 : 1024;
          let v = null;
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = d.reserve + step;
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = Math.max(0, d.reserve - step);
          else if (e.key === 'Home') v = 0;
          if (v != null) { e.preventDefault(); e.stopPropagation(); focusKey = `hdl${m.idx}`; setReserve(v); }
        });
        hd.addEventListener('click', (e) => e.stopPropagation());
        g.append(hd);
      }
      // status
      const st = m.fits ? `${short(m.room)} left` : `over ${short(m.over)}`;
      const pct = `${Math.round(m.share * 100)} %`;
      if (narrow) g.append(s('text', { x: X1, y: y - 4, 'text-anchor': 'end', class: `tb-stat ${m.fits ? 'ok' : 'bad'}` }, `${pct} · ${st}`));
      else {
        g.append(s('text', { x: W - 8, y: y + 10, 'text-anchor': 'end', class: `tb-stat ${m.fits ? 'ok' : 'bad'}` }, m.fits ? 'fits' : `over ${short(m.over)}`));
        g.append(s('text', { x: W - 8, y: y + 20, 'text-anchor': 'end', class: 'tb-small soft' }, m.fits ? `${pct} · ${short(m.room)} left` : `${pct} of window`));
      }
      if (!shared) g.append(s('text', { x: Math.min(sx(m.input) + 6, X1 - 4), y: y + bh - 6, class: 'tb-small soft', 'text-anchor': sx(m.input) + 120 > X1 ? 'end' : 'start' }, `output limit separate (${m.out ? short(m.out) : '–'})`));
      else if (m.capped) g.append(s('text', { x: sx(m.input + m.reserve) + 7, y: y + bh - 6, class: 'tb-small warn' }, 'capped'));
      svg.append(g);
    });
    legend.replaceChildren(...d.parts.map((p, i) => h('span', {}, h('i', { class: `tb-c${i % COLORS}` }), `${p.name} ${short(p.o200k)}`)),
      h('span', {}, h('i', { class: 'tb-lres' }), `answer ${short(d.reserve)}`), h('span', {}, h('i', { class: 'tb-lover' }), 'over the window'),
      h('span', {}, h('i', { class: 'tb-lband' }), 'estimate → high end'));
    const fits = d.models.filter((m) => m.fits).length;
    barsSub.innerHTML = '';
    barsSub.append(h('b', { class: fits === d.models.length ? 'ok' : 'bad' }, `fits ${fits} of ${d.models.length}`), ` · prompt ≈ ${short(d.totO)} (o200k est.)`);
    if (focusKey && hadFocus) { const el = svg.querySelector(`[data-k="${focusKey}"]`); if (el && document.activeElement !== el) el.focus({ preventScroll: true }); }
  };

  // ---- cuts ----
  const drawCuts = () => {
    const d = res.draw;
    const t = d.models.find((m) => m.idx === d.target);
    cutsBody.replaceChildren();
    if (!t) { cutsTitle.textContent = 'What to cut first'; cutsBody.append(h('p', { class: 'tb-sub' }, 'No model rows.')); return; }
    cutsTitle.textContent = `What to cut first · ${t.name}`;
    if (t.fits) {
      cutsBody.append(h('p', { class: 'tb-ok' }, `Fits ${t.name}: ${fmt(t.input)} of ${fmt(t.ctx)} (${(t.share * 100).toFixed(1)} %), ${fmt(t.room)} left for the answer. Nothing to cut.`));
    } else {
      cutsBody.append(h('p', { class: 'tb-bad' }, `${fmt(t.over)} tokens over. Cut in this order (the usual priority: documents, history, examples, tools, system; never the question):`));
      const ol = h('ol', { class: 'tb-cutlist' });
      for (const c of d.cuts) {
        const p = c.i >= 0 ? list[c.i] : null;
        const canApply = p && /^\s*[=×xX*]/.test(String(p.size || ''));
        const li = h('li', {},
          h('div', { class: 'tb-cutrow' }, c.i >= 0 ? h('i', { class: `tb-sw tb-c${c.i % COLORS}` }) : null, h('b', {}, c.part),
            h('span', { class: 'tb-sub' }, c.of ? `−${short(c.cut)} of ${short(c.of)} (${c.pct} %)` : `${short(c.cut)} still over`),
            canApply ? h('button', { class: 'k-btn tb-mini tb-apply', title: 'Shrink this part\'s size by that share', onclick: () => {
              const sz = String(p.size).trim();
              const f = 1 - Math.min(0.95, c.cut / c.of + 0.01);
              if (/^=/.test(sz)) { const v = ctx.parseEng(sz.slice(1).replace(/k$/i, 'k')); if (v != null) p.size = `=${short(Math.floor((v * f) / 100) * 100).replace('K', 'k')}`; }
              else { const n = Number(sz.slice(1)); if (n > 0) p.size = `×${Math.max(1, Math.floor(n * f))}`; }
              commit(true);
            } }, 'Apply') : null),
          c.of ? h('div', { class: 'tb-cutbar' }, h('i', { style: `width:${100 - c.pct}%` }), h('i', { class: 'cut', style: `width:${c.pct}%` })) : null,
          h('div', { class: 'tb-how' }, c.how));
        ol.append(li);
      }
      cutsBody.append(ol);
    }
  };

  // ---- models editor ----
  const drawModels = () => {
    const rows = (ctx.raw.models || []).map((r) => ({ ...r }));
    const cols = [['name', 'Model', 'text'], ['ctx', 'Window', 'text'], ['out', 'Max out', 'text'], ['enc', 'Estimate', ['o200k', 'cl100k']], ['factor', 'Factor', 'text'], ['mode', 'Window use', ['shared', 'separate']]];
    const setRows = () => ctx.set('models', rows.map((r) => ({ ...r })));
    const tbl = h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c[1])), h('th', {}, ''))),
      h('tbody', {}, rows.map((r, i) => h('tr', {}, cols.map(([k, label, type]) => h('td', {}, Array.isArray(type)
        ? h('select', { 'aria-label': `${label}, row ${i + 1}`, onchange: (e) => { r[k] = e.target.value; setRows(); } }, type.map((o) => h('option', { value: o, selected: String(r[k]) === o || null }, o)))
        : (() => { const el = h('input', { type: 'text', 'aria-label': `${label}, row ${i + 1}`, spellcheck: 'false', class: k === 'name' ? 'w' : null, onchange: (e) => { r[k] = e.target.value; setRows(); } }); el.value = r[k] ?? ''; return el; })())),
      h('td', {}, h('button', { class: 'k-btn tb-mini', 'aria-label': `Remove ${r.name}`, onclick: () => { rows.splice(i, 1); setRows(); drawModels(); } }, '×'))))));
    modelsBody.replaceChildren(h('div', { class: 'tb-mwrap' }, tbl),
      h('div', { class: 'tb-macts' },
        h('button', { class: 'k-btn', onclick: () => { rows.push({ name: 'My model', ctx: '128000', out: '8192', enc: 'o200k', factor: '1', mode: 'shared' }); setRows(); drawModels(); } }, '+ Model'),
        h('button', { class: 'k-btn', onclick: () => { const def = ctx.manifest.inputs.find((d) => d.key === 'models').default; ctx.set('models', structuredClone(def)); drawModels(); } }, 'Reset to the 2026-09 table'),
        h('span', { class: 'tb-sub' }, 'Factor: tokens this model counts per o200k/cl100k-estimated token (an allowance where the tokenizer is not public; measure it with the provider\'s count endpoint on your own text).')));
  };

  // ---- results ----
  ctx.onResult((r) => {
    res = r;
    if (!r.draw) return;
    if (ctx.raw.parts !== lastText) { list = parse(ctx.raw.parts); lastText = ctx.raw.parts; drawParts(); drawModels(); }
    fillParts();
    if (document.activeElement !== reserveIn) reserveIn.value = String(ctx.raw.reserve ?? '');
    basisSel.value = ctx.raw.basis || 'high';
    drawBars();
    drawCuts();
    warns.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'Method and notes'), ...(r.notes || []).map((n) => h('div', {}, n)));
    if (firstTab) { firstTab = false; setTimeout(() => [...ctx.outputs.querySelectorAll('.k-tab')].find((b) => b.textContent === 'Budget table')?.click(), 0); }
  });
  drawParts();
  drawModels();
  let lastW = 0;
  new ResizeObserver(() => { const w = svg.parentNode.clientWidth; if (res && Math.abs(w - lastW) > 2 && !dragging) { lastW = w; drawBars(); } }).observe(barsCard);
}
