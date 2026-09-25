// JSON Path Explorer, custom page: the document drawn as an icicle map.
//
//   Map    - depth runs left to right, one column per level; every field is a
//            band as tall as the number of leaf values under it, coloured by
//            type (object, array, string, number, boolean, null). Click a band
//            to pick that field: its path is written in the chosen style.
//            Double-click (or Enter) zooms into a container, the crumbs above
//            the map zoom back out. Arrow keys walk the map: left = parent,
//            right = first child, up/down = the neighbour at the same level.
//            Fields matching the search carry a marker; a container hides the
//            count of matches inside it when its children are too small.
//   Path   - the picked path as a chain of steps: click a step to climb to
//            it, click an index to turn it into [*] (every item: all their
//            bands light up) and back. The style tabs rewrite it.
//   Value  - what is at the path (run()'s "Value at path"), and the
//            document itself, editable.
// Everything drawn comes from run()'s result.tree (parent, key, type, leaf
// count, preview per node; the search matches; the nodes the path reaches).
import { formatPath, STYLES } from './tool.js';

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, text) => {
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
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

const STYLE_TABS = [['js', 'JavaScript'], ['jsonpath', 'JSONPath'], ['jq', 'jq'], ['python', 'Python'], ['pointer', 'Pointer']];
const TYPE_NAMES = ['object', 'array', 'string', 'number', 'boolean', 'null'];
const CH = 7.2; // mono glyph width at 12 px

export function page(root, ctx) {
  const st = { sel: -1, zoom: 0, idxMemory: new Map(), hover: -1, W: 900 };
  let tree = null, kids = [], depthOf = [];

  // ---------------------------------------------------------------- layout
  const tabs = STYLE_TABS.map(([v, t]) => h('button', { class: 'jp-tab', role: 'tab', 'data-v': v, 'aria-selected': 'false',
    onclick: () => (tree?.pickSteps ? ctx.setMany({ style: v, pick: formatPath(tree.pickSteps, v, ctx.raw.rootVar) }) : ctx.set('style', v)) }, t));
  const rootIn = h('input', { type: 'text', class: 'jp-root', spellcheck: 'false', 'aria-label': 'Root variable',
    oninput: (e) => (tree?.pickSteps ? ctx.setMany({ rootVar: e.target.value, pick: formatPath(tree.pickSteps, ctx.raw.style || 'js', e.target.value) }) : ctx.set('rootVar', e.target.value)) });
  const rootWrap = h('label', { class: 'jp-rootwrap', title: 'Root variable' }, 'root ', rootIn);
  const chain = h('div', { class: 'jp-chain', role: 'group', 'aria-label': 'Path steps' });
  const copyBtn = h('button', { class: 'k-btn k-primary jp-copy', onclick: () => copyPath() }, 'Copy path');
  const pickIn = h('input', { type: 'text', id: 'jp-pick', class: 'jp-pick', spellcheck: 'false', placeholder: 'or type a path in any style, e.g. $.orders[*].id',
    oninput: (e) => ctx.set('pick', e.target.value) });
  const pickInfo = h('span', { class: 'jp-pickinfo', 'aria-live': 'polite' });
  const pathBar = h('section', { class: 'jp-panel jp-pathbar' },
    h('div', { class: 'jp-row' }, h('div', { class: 'jp-tabs', role: 'tablist', 'aria-label': 'Path style' }, tabs), rootWrap,
      h('span', { class: 'jp-grow' }), pickInfo),
    h('div', { class: 'jp-row jp-chainrow' }, chain, copyBtn),
    h('div', { class: 'jp-row' }, h('label', { for: 'jp-pick', class: 'jp-h' }, 'Path'), pickIn));

  const findIn = h('input', { type: 'search', id: 'jp-find', class: 'jp-find', spellcheck: 'false', placeholder: 'Find key or value',
    oninput: (e) => ctx.set('filter', e.target.value) });
  const findInfo = h('span', { class: 'jp-soft jp-small', 'aria-live': 'polite' });
  const crumbs = h('div', { class: 'jp-crumbs', role: 'navigation', 'aria-label': 'Zoom' });
  const zoomBtn = h('button', { class: 'k-btn jp-sbtn', title: 'Zoom into the picked container (Enter)', onclick: () => zoomTo(zoomTarget()) }, 'Zoom in');
  const legend = h('div', { class: 'jp-legend' }, TYPE_NAMES.map((t) => h('span', {}, h('i', { class: `jp-t-${t}` }), t)),
    h('span', {}, h('i', { class: 'jp-lg-match' }), 'search match'), h('span', {}, h('i', { class: 'jp-lg-pick' }), 'at the path'));
  const svgWrap = h('div', { class: 'jp-mapwrap', tabindex: '0', role: 'tree', 'aria-label': 'Document map. Arrow keys move, Enter zooms in, Backspace zooms out.' });
  const mapErr = h('div', { class: 'jp-maperr', 'aria-live': 'polite' });
  const status = h('div', { class: 'jp-status jp-soft jp-small', 'aria-live': 'polite' });
  const mapPanel = h('section', { class: 'jp-panel jp-mappanel' },
    h('div', { class: 'jp-row' }, h('span', { class: 'jp-h' }, 'Document map'), crumbs, h('span', { class: 'jp-grow' }), zoomBtn),
    h('div', { class: 'jp-row' }, findIn, findInfo),
    mapErr, svgWrap, status, legend);

  const valHead = h('div', { class: 'jp-valhead' });
  const valPre = h('pre', { class: 'jp-val' });
  const valPanel = h('section', { class: 'jp-panel jp-valpanel' }, h('div', { class: 'jp-row' }, h('span', { class: 'jp-h' }, 'Value at the path'), valHead), valPre);
  const docTa = h('textarea', { id: 'jp-doc', class: 'jp-doc', rows: 14, spellcheck: 'false', wrap: 'off', oninput: (e) => ctx.set('json', e.target.value) });
  const docInfo = h('span', { class: 'jp-soft jp-small' });
  const docPanel = h('section', { class: 'jp-panel jp-docpanel' }, h('div', { class: 'jp-row' }, h('label', { for: 'jp-doc', class: 'jp-h' }, 'Document'), docInfo), docTa);
  const listNote = h('span', { class: 'jp-small jp-warntext' });
  const leavesCb = h('input', { type: 'checkbox', onchange: (e) => ctx.set('leaves', e.target.checked) });
  const wildCb = h('input', { type: 'checkbox', onchange: (e) => ctx.set('wildcard', e.target.checked) });
  const listOpts = h('div', { class: 'jp-listopts' }, h('span', { class: 'jp-h' }, 'Path list'),
    h('label', {}, leavesCb, ' only leaf values'), h('label', {}, wildCb, ' array indices as [*]'),
    h('span', { class: 'jp-soft jp-small' }, 'in the Paths tab below, filtered by the search'), listNote);
  const outWrap = h('div', { class: 'jp-out' }, listOpts, ctx.outputs);
  root.append(h('div', { class: 'jp-page' }, pathBar, mapPanel, h('div', { class: 'jp-side' }, valPanel, docPanel), outWrap));

  // ---------------------------------------------------------------- tree helpers
  const N = (i) => tree.nodes[i];
  const stepsOf = (i) => { const s = []; for (let j = i; j > 0; j = N(j)[0]) s.unshift(N(j)[1]); return s; };
  const isContainer = (i) => (N(i)[2] === 'object' || N(i)[2] === 'array') && kids[i].length > 0;
  const keyLabel = (i) => { const k = N(i)[1]; return i === 0 ? rootName() : typeof k === 'number' ? `[${k}]` : k; };
  const rootName = () => ({ js: ctx.raw.rootVar || 'data', python: ctx.raw.rootVar || 'data', jsonpath: '$', jq: '.', pointer: '/' })[ctx.raw.style] || 'data';
  const ancestorOf = (a, i) => { for (let j = i; j >= 0; j = N(j)[0]) if (j === a) return true; return false; };

  function pickNode(i) {
    if (!tree || i < 0) return;
    st.sel = i;
    ctx.set('pick', formatPath(stepsOf(i), ctx.raw.style || 'js', ctx.raw.rootVar));
  }
  function setSteps(steps) { ctx.set('pick', formatPath(steps, ctx.raw.style || 'js', ctx.raw.rootVar)); }
  function zoomTarget() { if (st.sel < 0) return 0; return isContainer(st.sel) ? st.sel : Math.max(0, N(st.sel)[0]); }
  function zoomTo(i) { st.zoom = Math.max(0, i); drawMap(); }

  async function copyPath() {
    const text = pickIn.value;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { pickIn.select(); try { ok = document.execCommand('copy'); } catch { ok = false; } }
    copyBtn.textContent = ok ? 'Copied' : 'Select and copy';
    setTimeout(() => { copyBtn.textContent = 'Copy path'; }, 1300);
  }

  // ---------------------------------------------------------------- path chain
  function drawChain(res) {
    chain.replaceChildren();
    const style = ctx.raw.style || 'js';
    const S = STYLES[style] || STYLES.js;
    const steps = tree?.pickSteps;
    if (!steps) { chain.append(h('span', { class: 'jp-soft' }, 'Click a field in the map to get its path.')); return; }
    chain.append(h('button', { class: 'jp-step jp-steproot', title: 'The whole document', onclick: () => setSteps([]) }, style === 'jq' ? '.' : style === 'pointer' ? '/' : S.root(ctx.raw.rootVar || 'data')));
    steps.forEach((s, k) => {
      let txt;
      if (s === '*') txt = style === 'pointer' ? '/*' : style === 'jq' ? '[]' : '[*]';
      else if (typeof s === 'number') txt = S.idx(s);
      else txt = S.key(s);
      if (style === 'jq' && k === 0 && txt.startsWith('[')) txt = '.' + txt;
      if (style === 'pointer' && k === 0 && steps.length) { /* the root chip already shows "/" */ txt = txt.slice(1); }
      const isIdx = typeof s === 'number' || s === '*';
      const last = k === steps.length - 1;
      const b = h('button', { class: `jp-step${isIdx ? ' jp-stepidx' : ''}${s === '*' ? ' is-all' : ''}${last ? ' is-last' : ''}`,
        title: isIdx ? (s === '*' ? 'Every item: click for one item' : 'Click to take every item ([*])') : 'Climb to this field',
        onclick: () => {
          if (isIdx) {
            const nx = steps.slice();
            if (s === '*') nx[k] = st.idxMemory.get(k) ?? 0;
            else { st.idxMemory.set(k, s); nx[k] = '*'; }
            setSteps(nx);
          } else setSteps(steps.slice(0, k + 1));
        } }, txt);
      chain.append(b);
    });
    const at = (res.values || []).find((v) => v.label === 'At the path');
    pickInfo.textContent = at ? `${at.value}${tree.pick.length > 1 ? ` · ${tree.pick.length} bands lit` : ''}` : '';
    pickInfo.className = `jp-pickinfo${at && at.tone === 'warn' ? ' is-warn' : ''}`;
  }

  // ---------------------------------------------------------------- the map
  let lastSvg = null;
  function drawMap() {
    if (!tree) return;
    const W = Math.max(300, Math.floor(svgWrap.clientWidth || st.W));
    st.W = W;
    const narrow = W < 620;
    const H = narrow ? 460 : Math.max(420, Math.min(620, Math.round(window.innerHeight - 330)));
    if (st.zoom >= tree.nodes.length) st.zoom = 0;
    // keep the picked field visible: zoom out when it is outside the zoomed part
    if (st.sel >= 0 && !ancestorOf(st.zoom, st.sel)) st.zoom = 0;
    const z = st.zoom;
    const zDepth = depthOf[z];
    // deepest level under the zoom
    let maxD = zDepth;
    const stack = [z];
    while (stack.length) { const i = stack.pop(); if (depthOf[i] > maxD) maxD = depthOf[i]; for (const c of kids[i]) stack.push(c); }
    const minCol = narrow ? 104 : 150;
    const nCols = Math.max(1, Math.min(maxD - zDepth + 1, Math.floor(W / minCol)));
    // the visible window of levels: from the zoom down, shifted so the pick's children show
    let d0 = zDepth;
    if (st.sel >= 0) d0 = Math.max(zDepth, Math.min(depthOf[st.sel] + (isContainer(st.sel) ? 2 : 1) - nCols, maxD - nCols + 1));
    // levels scrolled off to the left: lay out under the pick's ancestor at the level before the window
    let eff = z;
    if (d0 > zDepth && st.sel >= 0) { eff = st.sel; while (depthOf[eff] > d0 - 1) eff = N(eff)[0]; }
    const total = N(eff)[3] || 1;
    // column geometry: a zoomed-into container is a narrow first column, the rest share the width
    const narrowFirst = eff !== 0 && d0 === depthOf[eff] && nCols > 1;
    const c0 = narrowFirst ? Math.min(W / nCols, narrow ? 84 : 140) : W / nCols;
    const cwRest = nCols > 1 ? (W - c0) / (nCols - 1) : W;
    const colX = (d) => (d === d0 ? 0 : c0 + (d - d0 - 1) * cwRest);
    const colW = (d) => (d === d0 ? c0 : cwRest);
    const ky = H / total;
    const pickSet = new Set(tree.pick);
    const matchSet = new Set(tree.match);
    const selPath = new Set();
    for (const p of tree.pick) for (let j = p; j >= 0; j = N(j)[0]) selPath.add(j);

    const svg = sv('svg', { class: 'jp-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'presentation' });
    const pat = sv('pattern', { id: 'jp-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'jp-hatchline' }));
    const defs = sv('defs'); defs.append(pat); svg.append(defs);
    const dense = sv('g'), denseLab = sv('g', { class: 'jp-labels' });
    // hidden-match counts: matches under nodes too small to show them
    const bands = sv('g');
    const labels = sv('g', { class: 'jp-labels' });
    const marks = sv('g');
    let drawn = 0;
    const place = (i, y0) => {
      // lays out node i (at its y0) and its children
      const d = depthOf[i];
      const hgt = N(i)[3] * ky;
      if (hgt < 1.5 && i !== eff) return; // under the hatched run of its parent
      if (d >= d0 && d < d0 + nCols) {
        drawn++;
        const x = colX(d), cw = colW(d);
        const t = N(i)[2];
        const cls = ['jp-band', `jp-b-${t}`];
        if (pickSet.has(i)) cls.push(isContainer(i) ? 'is-pickbox' : 'is-pick');
        else if (selPath.has(i)) cls.push('is-onpath');
        if (i === st.sel) cls.push('is-sel');
        const g = sv('g', { class: cls.join(' '), 'data-i': i });
        const hh = Math.max(0.6, hgt - (hgt > 3 ? 1 : 0));
        // a leaf runs to the right edge: room for its value
        const bw = isContainer(i) ? cw : W - x;
        g.append(sv('rect', { class: 'jp-bg', x: x + 0.5, y: y0 + 0.5, width: Math.max(1, bw - 2), height: hh }));
        g.append(sv('rect', { class: `jp-tick jp-t-${t}`, x: x + 0.5, y: y0 + 0.5, width: 3, height: hh }));
        const tip = sv('title', {}, `${formatPath(stepsOf(i), ctx.raw.style || 'js', ctx.raw.rootVar)}  (${t}${isContainer(i) ? `, ${N(i)[4]} ${t === 'array' ? 'items' : 'keys'}` : ''})`);
        g.append(tip);
        bands.append(g);
        if (hgt >= 14) {
          const room = Math.floor(((isContainer(i) ? cw : W - x) - 16) / CH);
          const key = keyLabel(i);
          let rest = '';
          if (!isContainer(i)) rest = ` ${N(i)[4]}`;
          const cnt = isContainer(i) ? (t === 'array' ? `[${N(i)[4]}]` : `{${N(i)[4]}}`) : '';
          const keyTxt = key.length > room ? key.slice(0, Math.max(1, room - 1)) + '…' : key;
          const leftRoom = room - keyTxt.length - (cnt ? cnt.length + 1 : 0);
          const restTxt = rest && leftRoom > 3 ? (rest.length > leftRoom ? rest.slice(0, leftRoom - 1) + '…' : rest) : '';
          const ty = hgt >= 30 && isContainer(i) ? y0 + 16 : y0 + Math.min(hgt, 40) / 2 + 4.5;
          const tx = sv('text', { x: x + 9, y: ty, class: `jp-lab${pickSet.has(i) && !isContainer(i) ? ' is-pick' : ''}` });
          tx.append(sv('tspan', { class: 'jp-key' }, keyTxt));
          if (restTxt) tx.append(sv('tspan', { class: `jp-pv jp-pv-${t}` }, restTxt));
          labels.append(tx);
          if (cnt && leftRoom >= 0) labels.append(sv('text', { x: x + cw - 8, y: ty, class: 'jp-cnt', 'text-anchor': 'end' }, cnt));
        }
        if (matchSet.has(i)) marks.append(sv('circle', { class: 'jp-match', cx: x + (isContainer(i) ? cw : W - x) - 7, cy: y0 + Math.min(hgt, 14) / 2 + 0.5, r: Math.max(1.5, Math.min(3.5, hgt / 3)) }));
        // matches hidden below the last visible column, or under bands too thin to draw
        const lastCol = d === d0 + nCols - 1;
        if ((lastCol || hgt < 3) && matchSet.size && isContainer(i)) {
          let n = 0; const s2 = [...kids[i]];
          while (s2.length) { const j = s2.pop(); if (matchSet.has(j)) n++; for (const c of kids[j]) s2.push(c); }
          const cw = colW(d);
          if (n && hgt >= 14) labels.append(sv('text', { x: x + cw - 8, y: y0 + Math.min(hgt, 40) / 2 + 4.5 + (hgt >= 30 ? 14 : 0), class: 'jp-hidden', 'text-anchor': 'end' }, `${n} match${n > 1 ? 'es' : ''} inside`));
          else if (n) marks.append(sv('rect', { class: 'jp-match', x: x + cw - 5, y: y0, width: 3, height: Math.max(1, hgt) }));
        }
      }
      if (hgt < 0.35 || d >= d0 + nCols - 1) return;
      if (d >= d0 - 1 && kids[i].length) {
        // children too thin to draw one by one: a hatched run with their count
        const thin = kids[i].filter((c) => N(c)[3] * ky < 1.5).length;
        if (thin * 2 > kids[i].length) {
          const xd = colX(d + 1), wd = W - xd;
          dense.append(sv('rect', { class: 'jp-dense', 'data-parent': i, 'data-y0': y0, 'data-ky': ky, fill: 'url(#jp-hatch)', x: xd + 0.5, y: y0 + 0.5, width: wd - 1, height: Math.max(0.6, hgt - 1) }));
          if (hgt >= 16) {
            const what = N(i)[2] === 'array' ? 'items' : 'keys';
            denseLab.append(sv('text', { class: 'jp-denselab', x: xd + 10, y: y0 + Math.min(hgt, 44) / 2 + 4.5 }, `${kids[i].length} ${what} too thin to draw one by one: click the hatching to pick the one there`));
          }
        }
      }
      let y = y0;
      for (const c of kids[i]) { place(c, y); y += N(c)[3] * ky; }
    };
    place(eff, 0);
    // column rules and the level numbers
    const cols = sv('g', { class: 'jp-cols' });
    for (let c = 1; c < nCols; c++) { const x = colX(d0 + c); cols.append(sv('line', { x1: x, x2: x, y1: 0, y2: H })); }
    svg.append(cols, dense, bands, labels, denseLab, marks);
    if (d0 > zDepth) svg.append(sv('path', { class: 'jp-more', d: `M1,${H / 2 - 14} l-0,28` }));
    svgWrap.replaceChildren(svg);
    lastSvg = svg;
    const hiddenLeft = d0 > zDepth ? 'Narrow view: the levels before are in the path above. ' : '';
    status.textContent = `${hiddenLeft}Depth ${d0}-${d0 + nCols - 1} of ${tree.depth}, ${total} leaf value${total === 1 ? '' : 's'} under ${eff ? keyLabel(eff) : 'the root'}${tree.truncated ? '; the map stops at 60 000 nodes' : ''}.`;
    // crumbs
    crumbs.replaceChildren();
    const chainZ = []; for (let j = eff; j >= 0; j = N(j)[0]) chainZ.unshift(j);
    chainZ.forEach((j, k) => {
      if (k) crumbs.append(h('span', { class: 'jp-soft' }, '›'));
      crumbs.append(h('button', { class: `jp-crumb${j === eff ? ' is-cur' : ''}`, title: j === eff ? 'The map shows this' : 'Zoom out to here and pick it',
        onclick: () => { if (j === eff) return; st.zoom = j; pickNode(j); } }, j === 0 ? 'root' : keyLabel(j)));
    });
    zoomBtn.disabled = zoomTarget() === eff;
  }

  svgWrap.addEventListener('click', (e) => {
    const dz = e.target.closest('.jp-dense');
    if (dz) {
      // the child under the pointer, by its share of the parent's leaves
      const svg = dz.ownerSVGElement, pt = svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const y = pt.matrixTransform(svg.getScreenCTM().inverse()).y;
      const p = Number(dz.dataset.parent), ky = Number(dz.dataset.ky);
      let acc = Number(dz.dataset.y0), pickC = kids[p][kids[p].length - 1];
      for (const c of kids[p]) { acc += N(c)[3] * ky; if (acc >= y) { pickC = c; break; } }
      pickNode(pickC);
      svgWrap.focus({ preventScroll: true });
      return;
    }
    const g = e.target.closest('[data-i]');
    if (!g) return;
    pickNode(Number(g.dataset.i));
    svgWrap.focus({ preventScroll: true });
  });
  svgWrap.addEventListener('dblclick', (e) => {
    const g = e.target.closest('[data-i]');
    if (!g) return;
    const i = Number(g.dataset.i);
    zoomTo(isContainer(i) ? i : Math.max(0, N(i)[0]));
  });
  svgWrap.addEventListener('keydown', (e) => {
    if (!tree) return;
    let i = st.sel >= 0 ? st.sel : 0;
    const p = N(i)[0];
    if (e.key === 'ArrowLeft') { if (p >= 0) i = p; }
    else if (e.key === 'ArrowRight') { if (kids[i]?.length) i = kids[i][0]; }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // the neighbour at the same depth, in document order
      const d = depthOf[i], dir = e.key === 'ArrowUp' ? -1 : 1;
      for (let j = i + dir; j >= 0 && j < tree.nodes.length; j += dir) if (depthOf[j] === d) { i = j; break; }
    } else if (e.key === 'Enter') { e.preventDefault(); zoomTo(zoomTarget()); return; }
    else if (e.key === 'Backspace' || e.key === 'Escape') { e.preventDefault(); zoomTo(Math.max(0, N(st.zoom)[0])); return; }
    else if (e.key === 'Home') i = 0;
    else return;
    e.preventDefault();
    if (i !== st.sel) pickNode(i);
  });

  // ---------------------------------------------------------------- result in
  const sync = (el, v) => { if (document.activeElement !== el && el.value !== v) el.value = v; };
  ctx.onResult((res) => {
    const raw = ctx.raw;
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.v === (raw.style || 'js')));
    rootWrap.hidden = !['js', 'python'].includes(raw.style || 'js');
    sync(rootIn, String(raw.rootVar ?? ''));
    sync(pickIn, String(raw.pick ?? ''));
    sync(findIn, String(raw.filter ?? ''));
    sync(docTa, String(raw.json ?? ''));
    leavesCb.checked = !!ctx.input.leaves; wildCb.checked = !!ctx.input.wildcard;
    const warns = res.warnings || [];
    if (!res.tree) {
      // unreadable JSON: keep the last map, dimmed, with the reason on it
      mapPanel.classList.add('is-stale');
      mapErr.replaceChildren(...warns.map((w) => h('div', {}, w)));
      valHead.textContent = ''; valPre.textContent = '';
      docInfo.textContent = 'not valid JSON';
      docInfo.className = 'jp-bad jp-small';
      return;
    }
    mapPanel.classList.remove('is-stale');
    const newTree = res.tree;
    if (!tree || newTree.nodes.length !== tree.nodes.length || String(raw.json) !== st.json) { st.zoom = 0; }
    st.json = String(raw.json);
    tree = newTree;
    kids = tree.nodes.map(() => []); depthOf = new Array(tree.nodes.length).fill(0);
    tree.nodes.forEach((n, i) => { if (n[0] >= 0) { kids[n[0]].push(i); depthOf[i] = depthOf[n[0]] + 1; } });
    if (!tree.pick.includes(st.sel)) st.sel = tree.pick.length ? tree.pick[0] : -1;
    if (st.sel >= 0) {
      // the pick must be tall enough to read: zoom to its highest ancestor that gives it 16 px
      const need = (N(st.sel)[3] * 560) / 16;
      const tallEnough = (a) => N(a)[3] <= need;
      if (!ancestorOf(st.zoom, st.sel) || !tallEnough(st.zoom)) {
        let a = st.sel;
        while (N(a)[0] >= 0 && tallEnough(N(a)[0])) a = N(a)[0];
        if (!isContainer(a) && N(a)[0] >= 0) a = N(a)[0];
        st.zoom = a;
      }
    }
    const listWarn = (w) => /the table shows/.test(w);
    mapErr.replaceChildren(...warns.filter((w) => !/^Nothing at|^Cannot read the path/.test(w) && !listWarn(w)).map((w) => h('div', {}, w)));
    listNote.textContent = warns.filter(listWarn).join(' ');
    const pathWarn = warns.find((w) => /^Nothing at|^Cannot read the path/.test(w));
    const vals = Object.fromEntries((res.values || []).map((v) => [v.label, v]));
    docInfo.textContent = `${vals.Nodes?.value ?? ''} nodes · ${vals.Nodes?.hint ?? ''} · depth ${vals.Depth?.value ?? ''}`;
    docInfo.className = 'jp-soft jp-small';
    const f = String(raw.filter || '').trim();
    findInfo.textContent = f ? `${vals.Matches?.value ?? 0} path${vals.Matches?.value === 1 ? '' : 's'} match · ${tree.match.length} field${tree.match.length === 1 ? '' : 's'} marked` : '';
    const valText = (res.texts || []).find((t) => t.title === 'Value at path');
    const at = vals['At the path'];
    valHead.replaceChildren(at ? h('span', { class: at.tone === 'warn' ? 'jp-bad' : 'jp-soft' }, at.value) : h('span', { class: 'jp-soft' }, 'no path'));
    valPre.textContent = valText ? valText.body : pathWarn || 'Pick a field in the map.';
    valPre.classList.toggle('is-empty', !valText);
    drawChain(res);
    drawMap();
  });

  let rt = 0;
  new ResizeObserver(() => { cancelAnimationFrame(rt); rt = requestAnimationFrame(() => { if (Math.abs((svgWrap.clientWidth || 0) - st.W) > 2) drawMap(); }); }).observe(svgWrap);
}
