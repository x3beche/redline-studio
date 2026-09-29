// Layer & Release Map, drawn as the two things themselves:
//   Releases - the Yocto release line on a time axis: each release a bar from
//              its release month to its end of life, LTS bars on their own
//              lanes, today's line, the target outlined and, on every bar, how
//              many of your layers declare it. Click a bar (or focus it and use
//              arrows / Enter) to make it the target; "auto" follows the core.
//   Stack    - your BBLAYERS as a stack by BBFILE_PRIORITY, highest on top.
//              Left gutter: LAYERDEPENDS arrows (all faint, the selected
//              layer's bold; missing dependencies end in a dashed red ghost
//              row). Priority badge: drag it up/down or use arrows to change
//              BBFILE_PRIORITY (written into that layer.conf). The box at the
//              row's start leaves the layer out (what-if). Right: the
//              LAYERSERIES_COMPAT matrix, the target and core columns marked.
//   Layer    - the selected layer's findings, dependencies and its layer.conf,
//              editable in place.
// Everything drawn comes from run()'s result.map; the page only writes inputs.

const NS = 'http://www.w3.org/2000/svg';
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
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const title = (el, t) => { el.append(s('title', {}, t)); return el; };
const mon = (x) => { const m = /^(\d{4})-(\d{2})$/.exec(x || ''); return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : 0; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monText = (x) => { const m = /^(\d{4})-(\d{2})$/.exec(x || ''); return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : x; };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

export function page(root, ctx) {
  const wrap = h('div', { class: 'lrm' });
  root.append(wrap);

  // ---------- releases ----------
  const targetSel = h('select', { 'aria-label': 'Target release', onchange: (e) => ctx.set('target', e.target.value) },
    (ctx.manifest.inputs.find((d) => d.key === 'target').options).map(([v, t]) => h('option', { value: v }, t)));
  const relSub = h('span', { class: 'lrm-sub' });
  const relSvg = s('svg', { class: 'lrm-svg', role: 'group', 'aria-label': 'Yocto release timeline' });
  const relScroll = h('div', { class: 'lrm-scroll' }, relSvg);
  const relCard = h('section', { class: 'lrm-card lrm-rel' },
    h('div', { class: 'lrm-head' }, h('h2', {}, 'Yocto releases'), relSub,
      h('label', { class: 'lrm-right lrm-field' }, 'Target', targetSel)),
    relScroll,
    h('div', { class: 'lrm-help' }, 'Click a release to check the stack against it; ', h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' on a focused bar. The number on a bar is how many of your layers declare it in LAYERSERIES_COMPAT. Dashed = planned; estimated end dates use the 7-month stable window - verify at wiki.yoctoproject.org/wiki/Releases.'));

  // ---------- stack ----------
  const stackSub = h('div', { class: 'lrm-sums' });
  const stackSvg = s('svg', { class: 'lrm-svg', role: 'group', 'aria-label': 'Layer stack by priority' });
  const stackScroll = h('div', { class: 'lrm-scroll' }, stackSvg);
  const stackCard = h('section', { class: 'lrm-card' },
    h('div', { class: 'lrm-head' }, h('h2', {}, 'Layer stack'), h('span', { class: 'lrm-sub' }, 'BBFILE_PRIORITY, highest on top')),
    stackSub, stackScroll,
    h('div', { class: 'lrm-help' }, 'Click a layer for its findings and layer.conf. Drag a priority badge up or down (or ', h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' on it) to change BBFILE_PRIORITY. The box leaves a layer out of BBLAYERS to see what breaks. Arrows on the left: LAYERDEPENDS.'));

  // ---------- sources ----------
  const bbArea = h('textarea', { spellcheck: 'false', rows: 12, 'aria-label': 'bblayers.conf', oninput: (e) => ctx.set('bblayers', e.target.value) });
  const lcArea = h('textarea', { spellcheck: 'false', rows: 12, 'aria-label': 'layer.conf files', oninput: (e) => ctx.set('layerconfs', e.target.value) });
  const srcCard = h('details', { class: 'lrm-card lrm-src' },
    h('summary', {}, h('b', {}, 'Paste: bblayers.conf and layer.conf files'), h('span', { class: 'lrm-sub' }, ' - headers like ==> layers/meta-oe/conf/layer.conf <== (tail -n +1 */conf/layer.conf)')),
    h('div', { class: 'lrm-srcgrid' },
      h('label', {}, 'build/conf/bblayers.conf', bbArea),
      h('label', {}, 'layer.conf files, each after its ==> path <== line', lcArea)));
  if (store.get('lrm.src') !== 'closed') srcCard.open = true;
  srcCard.addEventListener('toggle', () => store.set('lrm.src', srcCard.open ? 'open' : 'closed'));

  // ---------- selected layer ----------
  const selHead = h('div', { class: 'lrm-head' });
  const selBody = h('div', { class: 'lrm-sel' });
  const confArea = h('textarea', { spellcheck: 'false', rows: 10, 'aria-label': 'This layer.conf', class: 'lrm-conf' });
  const selCard = h('section', { class: 'lrm-card' }, selHead, selBody);
  const warns = h('div', { class: 'lrm-warns', role: 'status', 'aria-live': 'polite' });
  const notes = h('details', { class: 'lrm-notes' }, h('summary', {}, 'Notes'));

  wrap.append(relCard,
    h('div', { class: 'lrm-main' },
      h('div', { class: 'lrm-col' }, stackCard, srcCard),
      h('div', { class: 'lrm-col' }, selCard, warns, notes, ctx.outputs)));

  let res = null, selected = store.get('lrm.sel') || null, focusId = null, dragging = null;
  const M = () => res && res.map;
  const track = (el, id) => {
    el.setAttribute('data-id', id);
    el.addEventListener('focus', () => { focusId = id; });
  };
  const refocus = (svg) => { if (focusId) svg.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true }); };

  // ---------- input edits ----------
  const offList = () => String(ctx.raw.off || '').split(/[\s,]+/).filter(Boolean);
  const toggleOff = (name) => {
    const list = offList();
    const i = list.indexOf(name);
    if (i >= 0) list.splice(i, 1); else list.push(name);
    ctx.set('off', list.join(', '));
  };
  const blockLines = (idx) => {
    const b = M().blocks[idx];
    const lines = String(ctx.raw.layerconfs || '').replace(/\r\n?/g, '\n').split('\n');
    return { b, lines };
  };
  const setPriority = (item, p) => {
    if (item.block < 0 || item.block == null || !item.collection) return;
    const { b, lines } = blockLines(item.block);
    if (!b) return;
    const re = new RegExp(`^(\\s*BBFILE_PRIORITY_${item.collection.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\s*\\??=\\s*)["'][^"']*["']`);
    let done = false;
    for (let i = b.start; i <= b.end && i < lines.length; i++) {
      if (re.test(lines[i])) { lines[i] = lines[i].replace(re, `$1"${p}"`); done = true; break; }
    }
    if (!done) lines.splice(b.end + 1, 0, `BBFILE_PRIORITY_${item.collection} = "${p}"`);
    ctx.set('layerconfs', lines.join('\n'));
  };
  confArea.addEventListener('input', () => {
    const it = M() && M().stack.find((x) => x.id === selected);
    if (!it || it.block < 0) return;
    const { b, lines } = blockLines(it.block);
    const header = b.path ? 1 : 0;
    lines.splice(b.start + header, b.end - b.start + 1 - header, ...confArea.value.split('\n'));
    ctx.set('layerconfs', lines.join('\n'));
  });

  // ---------- releases drawing ----------
  function drawReleases() {
    const m = M();
    relSvg.replaceChildren();
    const W = Math.max(700, relScroll.clientWidth || 900);
    const t0 = mon('2020-01'), t1 = mon('2031-01');
    const L = 10, R = 10;
    const X = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
    const rels = m.releases.filter((r) => mon(r.rel) >= t0);
    // Lanes: LTS on their own, stable ones below; greedy by release month.
    const lanes = { lts: [], st: [] };
    const place = (r) => {
      const ls = lanes[r.lts ? 'lts' : 'st'];
      const x0 = X(mon(r.rel)), x1 = Math.max(X(mon(r.eol)), x0 + `${r.name} ${r.ver}`.length * 7.2 + 34) + 6;
      let i = ls.findIndex((end) => end <= x0);
      if (i < 0) { ls.push(0); i = ls.length - 1; }
      ls[i] = x1;
      return i;
    };
    const laneOf = new Map(rels.map((r) => [r.name, { kind: r.lts ? 'lts' : 'st', i: place(r) }]));
    const LH = 26, top = 22;
    const ltsN = lanes.lts.length, stN = lanes.st.length;
    const Y = (r) => { const l = laneOf.get(r.name); return top + (l.kind === 'lts' ? l.i : ltsN + l.i) * LH + (l.kind === 'st' ? 8 : 0); };
    const H = top + (ltsN + stN) * LH + 8 + 22;
    relSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    relSvg.setAttribute('width', W); relSvg.setAttribute('height', H);
    // Years.
    for (let y = 2020; y <= 2031; y++) {
      const x = X(y * 12);
      relSvg.append(s('line', { x1: x, x2: x, y1: top - 6, y2: H - 18, class: 'grid' }));
      if (y < 2031) relSvg.append(s('text', { x: x + 3, y: H - 6, class: 'soft small' }, String(y)));
    }
    relSvg.append(s('text', { x: L, y: 12, class: 'soft small' }, 'LTS'));
        // Today.
    const xt = X(mon(m.asOf));
    relSvg.append(s('line', { x1: xt, x2: xt, y1: 6, y2: H - 18, class: 'today' }));
    relSvg.append(s('text', { x: xt + 4, y: 12, class: 'small todayt' }, `today ${monText(m.asOf)}`));
    const total = m.stack.filter((i) => !i.excluded && i.collection).length;
    rels.forEach((r, idx) => {
      const x0 = X(mon(r.rel)), x1 = Math.max(X(mon(r.eol)), x0 + 4), y = Y(r);
      const isT = r.name === m.target, isCore = m.coreSeries.includes(r.name);
      const g = s('g', { class: `rel ${r.lts ? 'lts' : 'st'} ${r.status}${isT ? ' target' : ''}`, tabindex: 0, role: 'button',
        'aria-pressed': String(isT), 'aria-label': `${r.name} ${r.ver}${r.lts ? ' LTS' : ''}, ${monText(r.rel)} to ${monText(r.eol)}, ${r.status}` });
      track(g, `rel:${r.name}`);
      g.append(s('rect', { x: x0, y: y, width: x1 - x0, height: LH - 8, rx: 3, class: 'bar' }));
      if (isT) g.append(s('rect', { x: x0 - 2, y: y - 2, width: x1 - x0 + 4, height: LH - 4, rx: 4, class: 'ring' }));
      else g.append(s('rect', { x: x0 - 2, y: y - 2, width: x1 - x0 + 4, height: LH - 4, rx: 4, class: 'ring focusonly' }));
      const label = `${r.name} ${r.ver}`;
      const lt = s('text', { x: x0 + 4, y: y + LH / 2 - 0.5, class: `blabel${r.lts ? ' big' : ''}` }, r.name);
      lt.append(s('tspan', { class: 'ver', dx: 5 }, r.ver));
      g.append(lt);
      const lw = label.length * 7.2 + 6;
      if (r.declared) {
        const cx = Math.max(x0 + lw + 10, x1 - 12);
        const tone = r.declared >= total ? 'ok' : 'part';
        g.append(title(s('circle', { cx, cy: y + (LH - 8) / 2, r: 8.5, class: `cnt ${tone}` }), `${r.declared} of ${total} layers declare ${r.name}`));
        g.append(s('text', { x: cx, y: y + (LH - 8) / 2 + 3.5, 'text-anchor': 'middle', class: 'cntt small' }, String(r.declared)));
      }
      if (isCore) g.append(s('text', { x: x0, y: y - 3, class: 'small coret' }, 'core'));
      title(g, `${r.name} ${r.ver}${r.lts ? ' (LTS)' : ''}\nreleased ${monText(r.rel)}${r.src === 'plan' ? ' (planned)' : ''}\nsupport until ${monText(r.eol)}${r.eolSrc === 'rule' ? ' (estimated)' : ''}\n${r.status}${r.note ? `\n${r.note}` : ''}\n${r.declared}/${total} layers declare it`);
      const pick = () => { focusId = `rel:${r.name}`; ctx.set('target', r.name); };
      g.addEventListener('click', pick);
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const n = rels[idx + (e.key === 'ArrowRight' ? 1 : -1)];
          if (n) { focusId = `rel:${n.name}`; ctx.set('target', n.name); }
        }
      });
      relSvg.append(g);
    });
    refocus(relSvg);
    const tr = rels.find((r) => r.name === m.target);
    if (tr && relScroll.clientWidth < W && !relScroll.dataset.scrolled) { relScroll.scrollLeft = Math.max(0, X(mon(tr.rel)) - 40); relScroll.dataset.scrolled = '1'; }
  }

  // ---------- stack drawing ----------
  function drawStack() {
    const m = M();
    stackSvg.replaceChildren();
    const rows = m.stack;
    const miss = m.missing;
    // Matrix columns: every release from dunfell on that a layer declares, plus target and core.
    const want = new Set([m.target, ...m.coreSeries]);
    for (const r of rows) for (const c of r.compat) want.add(c);
    const cols = m.releases.filter((r) => want.has(r.name));
    const avail = Math.max(640, stackScroll.clientWidth || 800);
    const RH = 30, GAP = 3, HEAD = 64;
    const deps = [];
    const idx = new Map(rows.map((r, i) => [r.collection || r.id, i]));
    const missIdx = new Map(miss.map((x, i) => [x.name, rows.length + i]));
    rows.forEach((r, i) => { if (!r.excluded) for (const d of r.deps) deps.push({ from: i, to: idx.has(d.name) && !rows[idx.get(d.name)].excluded ? idx.get(d.name) : missIdx.get(d.name), state: d.state, name: d.name }); });
    const G = Math.min(120, 26 + Math.max(0, ...deps.filter((d) => d.to != null).map((d) => Math.abs(d.to - d.from))) * 5);
    const CW = 30;
    const nameW = Math.max(230, Math.min(360, avail - G - 56 - cols.length * CW - 70));
    const W = G + 56 + nameW + cols.length * CW + 56;
    const x0 = G, xb = G + 8, xn = G + 56, xm = G + 56 + nameW;
    const n = rows.length + miss.length;
    const H = HEAD + n * (RH + GAP) + 8;
    stackSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    stackSvg.setAttribute('width', W); stackSvg.setAttribute('height', H);
    const Yr = (i) => HEAD + i * (RH + GAP);
    // Matrix header and the target/core column bands.
    cols.forEach((c, j) => {
      const cx = xm + j * CW + CW / 2;
      const isT = c.name === m.target, isCore = m.coreSeries.includes(c.name);
      if (isT) stackSvg.append(s('rect', { x: xm + j * CW + 1, y: HEAD - 58, width: CW - 2, height: H - HEAD + 58 - 4, rx: 3, class: 'tband' }));
      else if (isCore) stackSvg.append(s('rect', { x: xm + j * CW + 1, y: HEAD - 58, width: CW - 2, height: H - HEAD + 58 - 4, rx: 3, class: 'cband' }));
      const t = s('text', { x: cx + 3, y: HEAD - 8, class: `small ${isT ? 'tt' : c.status === 'eol' ? 'soft' : ''}`, transform: `rotate(-50 ${cx + 3} ${HEAD - 8})` }, c.name);
      stackSvg.append(title(t, `${c.name} ${c.ver}${c.lts ? ' LTS' : ''} - ${c.status}`));
    });
    stackSvg.append(s('text', { x: xb, y: HEAD - 8, class: 'soft small' }, 'prio'));
    stackSvg.append(s('text', { x: xn + 22, y: HEAD - 8, class: 'soft small' }, 'layer · collection'));
    const sel = selected;
    const selRow = rows.findIndex((r) => r.id === sel);
    const selMiss = miss.findIndex((x) => `missing:${x.name}` === sel);
    // Priority ties: a bracket beside the badges of equal priority.
    for (const t of m.ties) {
      const is = t.ids.map((id) => rows.findIndex((r) => r.id === id)).filter((i) => i >= 0).sort((a, b) => a - b);
      if (is.length < 2) continue;
      const ya = Yr(is[0]) + 6, yb = Yr(is[is.length - 1]) + RH - 6;
      stackSvg.append(title(s('path', { d: `M${xb - 2},${ya} h-4 V${yb} h4`, class: 'tie' }), `priority ${t.priority} shared by ${t.ids.join(', ')}`));
    }
    // Dependency arcs.
    const arcs = s('g', { class: 'arcs' });
    for (const d of deps) {
      if (d.to == null) continue;
      const y1 = Yr(d.from) + RH / 2, y2 = Yr(d.to) + RH / 2;
      const dx = Math.min(G - 8, 10 + Math.abs(d.to - d.from) * 5);
      const hot = d.from === selRow || d.to === selRow || (selMiss >= 0 && d.to === rows.length + selMiss);
      const cls = `arc ${d.state !== 'ok' ? 'bad' : ''} ${hot ? (d.from === selRow ? 'out' : 'in') : ''}`;
      arcs.append(title(s('path', { d: `M${x0 - 2},${y1 - 3} C${x0 - dx},${y1 - 3} ${x0 - dx},${y2 + 3} ${x0 - 4},${y2 + 3}`, class: cls, 'marker-end': hot || d.state !== 'ok' ? 'url(#lrm-arrow)' : null }),
        `${rows[d.from].collection} depends on ${d.name}${d.state === 'ok' ? '' : ` (${d.state})`}`));
    }
    const defs = s('defs');
    const mk = s('marker', { id: 'lrm-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    mk.append(s('path', { d: 'M0,0 L8,4 L0,8 z', class: 'arrowhead' }));
    defs.append(mk);
    stackSvg.append(defs, arcs);

    rows.forEach((r, i) => {
      const y = Yr(i);
      const g = s('g', { class: `row st-${r.status.replace(' ', '-')}${r.id === sel ? ' sel' : ''}${r.excluded ? ' off' : ''}`, tabindex: 0, role: 'button',
        'aria-label': `${r.name}, ${r.collection || 'no layer.conf'}, priority ${r.priority ?? 'unknown'}, ${r.status}` });
      track(g, `row:${r.id}`);
      g.append(s('rect', { x: x0, y, width: xm + cols.length * CW + 6 - x0, height: RH, rx: 4, class: 'rowbg' }));
      g.append(s('rect', { x: x0, y, width: 4, height: RH, rx: 2, class: 'stripe' }));
      g.append(s('rect', { x: x0, y, width: xm + cols.length * CW + 6 - x0, height: RH, rx: 4, class: 'ring' }));
      // Name and collection.
      const errs = r.issues.filter((x) => x.level === 'error').length, wrn = r.issues.filter((x) => x.level === 'warn').length;
      g.append(s('text', { x: xn + 22, y: y + 13, class: 'name' }, r.name));
      g.append(s('text', { x: xn + 22, y: y + 25, class: 'soft small' }, r.collection || (r.excluded ? 'excluded' : 'no layer.conf pasted')));
      if (errs || wrn || r.status === 'not ready') {
        const tag = errs ? `${errs} error${errs > 1 ? 's' : ''}` : wrn ? `${wrn} warning${wrn > 1 ? 's' : ''}` : `no ${m.target}`;
        g.append(s('text', { x: xm - 8, y: y + 19, 'text-anchor': 'end', class: `small ${errs ? 'bad' : 'warn'}` }, tag));
      }
      // Compat cells.
      cols.forEach((c, j) => {
        const has = r.compat.includes(c.name);
        const cx = xm + j * CW + 5;
        if (has) g.append(s('rect', { x: cx, y: y + 8, width: CW - 10, height: RH - 16, rx: 2, class: `cell ${c.name === m.target ? 'hit' : ''}` }));
        else if (c.name === m.target && r.collection && !r.excluded) g.append(s('rect', { x: cx + 0.5, y: y + 8.5, width: CW - 11, height: RH - 17, rx: 2, class: 'cell miss' }));
      });
      const choose = () => { selected = r.id; focusId = `row:${r.id}`; store.set('lrm.sel', selected); drawStack(); drawSel(); };
      g.addEventListener('click', choose);
      g.addEventListener('keydown', (e) => {
        if (e.target !== g) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const nb = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
          if (nb) stackSvg.querySelector(`[data-id="${CSS.escape(`row:${nb.id}`)}"]`)?.focus();
        }
      });
      stackSvg.append(g);
      // Include box (what-if).
      const box = s('g', { class: `chk${r.excluded ? '' : ' on'}`, tabindex: 0, role: 'checkbox', 'aria-checked': String(!r.excluded), 'aria-label': `Include ${r.name} in BBLAYERS` });
      track(box, `chk:${r.id}`);
      box.append(s('rect', { x: xn + 2, y: y + 8, width: 14, height: 14, rx: 3, class: 'box' }));
      if (!r.excluded) box.append(s('path', { d: `M${xn + 5},${y + 15} l3,3 l6,-7`, class: 'tick' }));
      title(box, r.excluded ? 'Excluded - click to put it back in BBLAYERS' : 'In BBLAYERS - click to leave it out (what-if)');
      const tog = (e) => { e.stopPropagation(); focusId = `chk:${r.id}`; toggleOff(r.name); };
      box.addEventListener('click', tog);
      box.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); tog(e); } });
      stackSvg.append(box);
      // Priority badge (drag / arrows).
      if (r.priority != null && !r.excluded) {
        const b = s('g', { class: `prio${r.prioritySet ? '' : ' computed'}`, tabindex: r.block >= 0 ? 0 : null, role: 'spinbutton',
          'aria-valuenow': r.priority, 'aria-label': `BBFILE_PRIORITY of ${r.collection}` });
        track(b, `prio:${r.id}`);
        b.append(s('rect', { x: xb, y: y + 4, width: 40, height: RH - 8, rx: 4, class: 'pbg' }));
        b.append(s('rect', { x: xb - 1, y: y + 3, width: 42, height: RH - 6, rx: 5, class: 'ring' }));
        const tx = s('text', { x: xb + 20, y: y + RH / 2 + 4.5, 'text-anchor': 'middle', class: 'pnum' }, String(r.priority));
        b.append(tx);
        title(b, r.prioritySet ? `BBFILE_PRIORITY_${r.collection} = "${r.priority}" - drag up/down or use arrow keys` : `computed by BitBake (highest dependency + 1); drag or arrows write BBFILE_PRIORITY_${r.collection}`);
        if (r.block >= 0) {
          b.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); focusId = `prio:${r.id}`; setPriority(r, r.priority + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 5 : 1)); }
          });
          b.addEventListener('pointerdown', (e) => {
            e.preventDefault(); e.stopPropagation();
            b.focus({ preventScroll: true });
            const sy = e.clientY, p0 = r.priority;
            const scale = stackSvg.getBoundingClientRect().height / H || 1;
            let p = p0;
            dragging = true;
            const mv = (ev) => { p = Math.max(1, p0 + Math.round((sy - ev.clientY) / (10 * scale))); tx.textContent = String(p); b.classList.add('drag'); };
            const up = () => {
              window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
              dragging = false; b.classList.remove('drag');
              focusId = `prio:${r.id}`;
              if (p !== p0) setPriority(r, p);
            };
            window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
          });
          b.addEventListener('click', (e) => e.stopPropagation());
        }
        stackSvg.append(b);
      }
    });
    // Missing dependencies: ghost rows.
    miss.forEach((x, k) => {
      const y = Yr(rows.length + k);
      const id = `missing:${x.name}`;
      const g = s('g', { class: `row ghost${sel === id ? ' sel' : ''}`, tabindex: 0, role: 'button', 'aria-label': `${x.name} missing, needed by ${x.by.join(', ')}` });
      track(g, `row:${id}`);
      g.append(s('rect', { x: x0, y, width: xm + cols.length * CW + 6 - x0, height: RH, rx: 4, class: 'rowbg' }));
      g.append(s('rect', { x: x0, y, width: xm + cols.length * CW + 6 - x0, height: RH, rx: 4, class: 'ring' }));
      g.append(s('text', { x: xb + 20, y: y + RH / 2 + 4, 'text-anchor': 'middle', class: 'bad' }, '?'));
      g.append(s('text', { x: xn + 22, y: y + 13, class: 'name bad' }, x.name));
      g.append(s('text', { x: xn + 22, y: y + 25, class: 'soft small' }, `not in BBLAYERS - needed by ${x.by.join(', ')}`));
      const choose = () => { selected = id; focusId = `row:${id}`; store.set('lrm.sel', selected); drawStack(); drawSel(); };
      g.addEventListener('click', choose);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
      stackSvg.append(g);
    });
    refocus(stackSvg);
  }

  // ---------- selected panel ----------
  function drawSel() {
    const m = M();
    let it = m.stack.find((x) => x.id === selected);
    const ms = m.missing.find((x) => `missing:${x.name}` === selected);
    if (!it && !ms) it = m.stack.find((x) => x.status === 'error') || m.stack.find((x) => x.status === 'warn') || m.stack[0];
    if (it) selected = it.id;
    if (ms) {
      selHead.replaceChildren(h('h2', { class: 'bad' }, ms.name), h('span', { class: 'lrm-sub' }, 'missing dependency'));
      const lines = [`Needed by ${ms.by.join(', ')} (LAYERDEPENDS), but no layer in BBLAYERS sets BBFILE_COLLECTIONS += "${ms.name}".`,
        'Clone the layer that provides it on the same release branch as the rest, then add its path to BBLAYERS, or drop the dependency if the layer really does not need it.'];
      const snippet = `bitbake-layers add-layer ../layers/<the layer providing ${ms.name}>`;
      selBody.replaceChildren(...lines.map((t) => h('p', {}, t)), h('pre', { class: 'lrm-snip' }, snippet));
      return;
    }
    if (!it) { selHead.replaceChildren(h('h2', {}, 'No layers')); selBody.replaceChildren(h('p', {}, 'Paste bblayers.conf below.')); return; }
    const needs = m.stack.filter((x) => x.deps.some((d) => d.name === it.collection));
    selHead.replaceChildren(h('h2', {}, it.name), h('span', { class: 'lrm-sub' }, it.collection ? `${it.collection} · priority ${it.priority ?? '?'}${it.prioritySet ? '' : ' (computed)'}${it.version ? ` · LAYERVERSION ${it.version}` : ''}` : 'no layer.conf'),
      h('span', { class: `lrm-pill ${it.status.replace(' ', '-')}` }, it.status));
    const iss = it.issues.length ? h('ul', { class: 'lrm-iss' }, it.issues.map((x) => h('li', { class: x.level }, h('b', {}, x.level === 'migrate' ? 'move' : x.level), ' ', x.text)))
      : h('p', { class: 'lrm-ok' }, 'No findings: BitBake reads this layer as it is.');
    const chips = (list, cls) => h('span', { class: 'lrm-chips' }, list.length ? list : h('span', { class: 'lrm-sub' }, 'none'));
    const depChips = chips(it.deps.map((d) => h('button', { class: `lrm-chip ${d.state}`, title: d.text || 'enabled', onclick: () => {
      const tgt = m.stack.find((x) => x.collection === d.name);
      selected = tgt ? tgt.id : `missing:${d.name}`; store.set('lrm.sel', selected); drawStack(); drawSel();
    } }, d.name, d.ops.length ? ` ${d.ops.join(' ')}` : '')));
    const needChips = chips(needs.map((x) => h('button', { class: 'lrm-chip', onclick: () => { selected = x.id; store.set('lrm.sel', selected); drawStack(); drawSel(); } }, x.collection)));
    const serChips = chips(it.compat.map((c) => h('span', { class: `lrm-chip ser${c === m.target ? ' ok' : ''}` }, c)));
    const kids = [iss,
      h('div', { class: 'lrm-kv' }, h('span', {}, 'path'), h('code', {}, it.path),
        h('span', {}, 'declares'), serChips, h('span', {}, 'depends on'), depChips, h('span', {}, 'needed by'), needChips)];
    if (it.block >= 0) {
      const b = m.blocks[it.block];
      const lines = String(ctx.raw.layerconfs || '').replace(/\r\n?/g, '\n').split('\n');
      const body = lines.slice(b.start + (b.path ? 1 : 0), b.end + 1).join('\n');
      if (document.activeElement !== confArea) confArea.value = body;
      kids.push(h('label', { class: 'lrm-conflabel' }, `${b.path || 'layer.conf'} - edit here`, confArea));
    }
    selBody.replaceChildren(...kids);
  }

  function drawText(res) {
    const m = res.map;
    const v = (label) => (res.values || []).find((x) => x.label === label || x.label.startsWith(label));
    const t = v('Target release'), e = v('BitBake errors'), d = v('Declare'), end = v('Support ends');
    relSub.textContent = `as of ${monText(m.asOf)} · target ${t ? t.value : '?'}${m.explicit ? '' : ' (from core)'}, support until ${end ? end.value : '?'}`;
    stackSub.replaceChildren(
      h('span', { class: `sum ${t && t.tone}` }, h('small', {}, 'target'), h('b', {}, t ? t.value : '–'), h('em', {}, t ? t.hint : '')),
      h('span', { class: 'sum' }, h('small', {}, 'core series'), h('b', {}, m.coreSeries.join(' ') || '–')),
      h('span', { class: `sum ${d && d.tone}` }, h('small', {}, d ? d.label.toLowerCase() : ''), h('b', {}, d ? d.value : '–')),
      h('span', { class: `sum ${e && e.tone}` }, h('small', {}, 'BitBake errors'), h('b', {}, e ? e.value : '–'), h('em', {}, e ? e.hint : '')),
      ...(offList().length ? [h('span', { class: 'sum' }, h('small', {}, 'excluded'), h('b', {}, offList().join(', ')),
        h('button', { class: 'k-btn', onclick: () => ctx.set('off', '') }, 'Put back'))] : []));
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, `Notes (${(res.notes || []).length})`), ...(res.notes || []).map((w) => h('div', {}, w)));
  }

  ctx.onResult((r) => {
    res = r;
    if (document.activeElement !== bbArea) bbArea.value = ctx.raw.bblayers ?? '';
    if (document.activeElement !== lcArea) lcArea.value = ctx.raw.layerconfs ?? '';
    targetSel.value = ctx.raw.target || 'auto';
    if (!r || !r.map) { warns.replaceChildren(...(r && r.warnings || []).map((w) => h('div', {}, w))); return; }
    if (dragging) return;
    drawText(r); drawReleases(); drawStack(); drawSel();
  });
  let rw = 0;
  new ResizeObserver(() => {
    const w = wrap.clientWidth;
    if (res && res.map && Math.abs(w - rw) > 4) { rw = w; drawReleases(); drawStack(); }
  }).observe(wrap);
}
