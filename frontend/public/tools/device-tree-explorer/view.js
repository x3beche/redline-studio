// Device Tree Explorer, drawn as the thing itself: the merged tree on the
// left (disabled nodes greyed, labels as chips, finding counts on the rows),
// the CPU physical address map in the middle (every reg translated through
// its buses' ranges, on a compressed axis with the gaps cut out, overlaps in
// red), and the chosen node on the right with each property, the file that
// set it and what it overrode, and references as links. Below: the source
// files as tabs (paste, edit, jump to a finding's line) with a real dtc check,
// and the outputs. Every fact drawn comes from run()'s result.view.

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
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem('redline.tool.device-tree-explorer.' + k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('redline.tool.device-tree-explorer.' + k, JSON.stringify(v)); } catch { /* private window */ } },
};
const SEV = { error: 'Error', warn: 'Warning', info: 'Note' };
const big = (x) => { try { return BigInt(x); } catch { return 0n; } };

export function page(root, ctx) {
  const st = {
    sel: null,               // selected node path
    tab: 0,                  // 0 = main file, n = files row n-1
    collapsed: new Set(),
    filter: '',
    hideOff: store.get('hideOff', false),
    sevShow: new Set(store.get('sevShow', ['error', 'warn'])),
    mapAll: store.get('mapAll', true),
    focus: null,             // path of the tree row holding the roving tab stop
    firstCollapse: true,
  };
  let res = null, V = null, byPath = new Map();

  const wrap = h('div', { class: 'dte' });
  root.append(wrap);

  // ---------------- findings strip ----------------
  const fCounts = h('span', { class: 'dte-counts' });
  const fList = h('div', { class: 'dte-flist', role: 'list' });
  const findCard = h('section', { class: 'dte-card dte-find' },
    h('div', { class: 'dte-head' }, h('h2', {}, 'Findings'), fCounts,
      h('span', { class: 'dte-sub dte-right' }, 'click one to jump to the node and its line')),
    fList);

  // ---------------- tree ----------------
  const search = h('input', { type: 'search', class: 'dte-search', placeholder: 'Find node, label, compatible', 'aria-label': 'Find node',
    oninput: (e) => { st.filter = e.target.value.trim().toLowerCase(); drawTree(); } });
  const hideBox = h('input', { type: 'checkbox', checked: st.hideOff, onchange: (e) => { st.hideOff = e.target.checked; store.set('hideOff', st.hideOff); drawTree(); } });
  const treeSub = h('span', { class: 'dte-sub' });
  const tree = h('div', { class: 'dte-tree', role: 'tree', 'aria-label': 'Merged device tree' });
  const treeCard = h('section', { class: 'dte-card dte-treecard' },
    h('div', { class: 'dte-head' }, h('h2', {}, 'Merged tree'), treeSub,
      h('span', { class: 'dte-right' },
        h('button', { class: 'k-btn dte-mini', title: 'Expand every node', onclick: () => { st.collapsed.clear(); drawTree(); } }, 'Expand'),
        h('button', { class: 'k-btn dte-mini', title: 'Collapse to the top two levels', onclick: () => { collapseDeep(1); drawTree(); } }, 'Collapse'))),
    h('div', { class: 'dte-bar' }, search, h('label', { class: 'dte-chk' }, hideBox, 'Hide disabled')),
    tree,
    h('div', { class: 'dte-help' }, h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' move, ', h('kbd', {}, '←'), h('kbd', {}, '→'), ' fold, ', h('kbd', {}, 'Enter'), ' inspect'));

  // ---------------- address map ----------------
  const mapSvg = s('svg', { class: 'dte-map', role: 'group', 'aria-label': 'CPU physical address map' });
  const mapSub = h('span', { class: 'dte-sub' });
  const mapAllBox = h('input', { type: 'checkbox', checked: !st.mapAll, onchange: (e) => { st.mapAll = !e.target.checked; store.set('mapAll', st.mapAll); drawMap(); } });
  const mapScroll = h('div', { class: 'dte-mapscroll' }, mapSvg);
  const mapCard = h('section', { class: 'dte-card dte-mapcard' },
    h('div', { class: 'dte-head' }, h('h2', {}, 'CPU address map'), mapSub,
      h('label', { class: 'dte-chk dte-right' }, mapAllBox, 'Enabled only')),
    mapScroll,
    h('div', { class: 'dte-help' }, 'reg translated through each bus\'s ranges; gaps cut out and labelled; red = overlap. Click a block to inspect it.'));

  // ---------------- inspector ----------------
  const insp = h('div', { class: 'dte-insp' });
  const inspCard = h('section', { class: 'dte-card dte-inspcard' }, insp);

  // ---------------- sources ----------------
  const tabs = h('div', { class: 'dte-tabs', role: 'tablist', 'aria-label': 'Source files' });
  const fileBar = h('div', { class: 'dte-filebar' });
  const gutter = h('pre', { class: 'dte-gutter', 'aria-hidden': 'true' });
  const editor = h('textarea', { class: 'dte-editor', spellcheck: 'false', wrap: 'off', 'aria-label': 'File text' });
  const edWrap = h('div', { class: 'dte-edwrap' }, gutter, editor);
  const dtcBtn = h('button', { class: 'k-btn k-primary', title: 'Compile the preprocessed base and each overlay with the real dtc in the tools image' }, 'Check with dtc');
  const dtcOut = h('div', { class: 'dte-dtc', role: 'status', 'aria-live': 'polite' });
  const srcCard = h('section', { class: 'dte-card dte-srccard' },
    h('div', { class: 'dte-head' }, h('h2', {}, 'Sources'), h('span', { class: 'dte-sub' }, 'paste a .dts, its .dtsi files and overlays'), h('span', { class: 'dte-right' }, dtcBtn)),
    tabs, fileBar, edWrap, dtcOut);

  const outCard = h('section', { class: 'dte-outcol' }, ctx.outputs);

  wrap.append(findCard,
    h('div', { class: 'dte-main' }, treeCard, mapCard, inspCard),
    h('div', { class: 'dte-lower' }, srcCard, outCard));

  // ================= helpers =================
  const node = (i) => (V && i != null && i >= 0 ? V.nodes[i] : null);
  const selNode = () => (st.sel != null ? byPath.get(st.sel) : null) || null;
  const short = (n) => (n.labels[0] ? n.labels[0] : n.name);
  const select = (i, opts = {}) => {
    const n = node(i);
    if (!n) return;
    st.sel = n.path;
    for (let p = node(n.parent); p; p = node(p.parent)) st.collapsed.delete(p.path);
    if (opts.focus !== false) st.focus = n.path;
    drawTree(opts.focus === true); drawMap(); drawInsp();
    if (opts.scroll !== false) scrollRowIntoView(n.path);
    if (ctx.raw.node !== n.path) ctx.set('node', n.labels[0] || n.path);
  };
  const collapseDeep = (depth) => {
    st.collapsed.clear();
    for (const n of V.nodes) if (n.depth >= depth && n.kids.length) st.collapsed.add(n.path);
    const sn = selNode();
    for (let p = sn && node(sn.parent); p; p = node(p.parent)) st.collapsed.delete(p.path);
  };
  const locLink = (file, line, cls = 'dte-loc') => h('button', { class: cls, title: `Open ${file} at line ${line}`, onclick: () => openSource(file, line) }, `${file}:${line}`);
  const nodeLink = (i, text) => {
    const n = node(i);
    if (!n) return h('span', { class: 'dte-undef', title: 'no such node or label' }, text);
    return h('button', { class: `dte-nlink${n.eff ? '' : ' off'}`, title: n.path, onclick: () => select(i) }, text ?? short(n));
  };

  // ================= findings =================
  function drawFindings() {
    const f = V.findings;
    const cnt = { error: 0, warn: 0, info: 0 };
    for (const x of f) cnt[x.sev]++;
    fCounts.replaceChildren(...['error', 'warn', 'info'].map((k) => h('button', {
      class: `dte-count ${k}`, 'aria-pressed': String(st.sevShow.has(k)), title: `Show or hide ${SEV[k].toLowerCase()}s`,
      onclick: () => { if (st.sevShow.has(k)) st.sevShow.delete(k); else st.sevShow.add(k); store.set('sevShow', [...st.sevShow]); drawFindings(); },
    }, h('i', {}), `${cnt[k]} ${SEV[k].toLowerCase()}${cnt[k] === 1 ? '' : 's'}`)));
    const shown = f.map((x, i) => [x, i]).filter(([x]) => st.sevShow.has(x.sev));
    if (!f.length) { fList.replaceChildren(h('div', { class: 'dte-none' }, 'No findings: the tree merges cleanly, every reg translates, every reference resolves.')); return; }
    if (!shown.length) { fList.replaceChildren(h('div', { class: 'dte-none' }, 'All findings hidden by the filters above.')); return; }
    const sn = selNode();
    fList.replaceChildren(...shown.map(([x]) => h('div', { class: `dte-frow ${x.sev}${sn && x.nodes.includes(sn.i) ? ' cur' : ''}`, role: 'listitem' },
      h('i', { class: 'dte-dot', title: SEV[x.sev] }),
      x.file ? locLink(x.file, x.line) : h('span', { class: 'dte-loc none' }, ''),
      h('button', { class: 'dte-fmsg', onclick: () => { if (x.nodes.length) select(x.nodes[0]); } }, x.msg),
      h('span', { class: 'dte-fnodes' }, x.nodes.slice(0, 3).map((i) => nodeLink(i))))));
  }

  // ================= tree =================
  function visibleRows() {
    const out = [];
    const f = st.filter;
    let keep = null;
    if (f) {
      keep = new Set();
      for (const n of V.nodes) {
        const hay = `${n.path} ${n.labels.join(' ')} ${n.compat || ''}`.toLowerCase();
        if (hay.includes(f)) for (let p = n; p; p = node(p.parent)) keep.add(p.i);
      }
    }
    const walk = (i) => {
      const n = V.nodes[i];
      if (st.hideOff && !n.eff) return;
      if (keep && !keep.has(i)) return;
      out.push(n);
      if (!f && st.collapsed.has(n.path)) return;
      for (const k of n.kids) walk(k);
    };
    walk(0);
    return out;
  }
  function drawTree(focusRow) {
    if (!V) return;
    const rows = visibleRows();
    const sn = selNode();
    if (!st.focus || !rows.some((r) => r.path === st.focus)) st.focus = sn && rows.some((r) => r.path === sn.path) ? sn.path : rows[0]?.path;
    const hadFocus = tree.contains(document.activeElement);
    const en = V.nodes.filter((n) => n.eff).length;
    treeSub.textContent = `${V.nodes.length} nodes, ${V.nodes.length - en} disabled`;
    tree.replaceChildren(...rows.map((n) => {
      const kids = n.kids.length;
      const open = kids && (st.filter || !st.collapsed.has(n.path));
      const worst = n.finds.map((k) => V.findings[k].sev).sort((a, b) => ['error', 'warn', 'info'].indexOf(a) - ['error', 'warn', 'info'].indexOf(b))[0];
      const [base, unit] = n.name.split('@');
      const row = h('div', {
        class: `dte-row${n.eff ? '' : ' off'}${sn && sn.i === n.i ? ' sel' : ''}`, role: 'treeitem', 'aria-level': n.depth + 1,
        'aria-expanded': kids ? String(!!open) : null, 'aria-selected': String(!!(sn && sn.i === n.i)),
        tabindex: n.path === st.focus ? '0' : '-1', 'data-path': n.path, style: `--d:${n.depth}`,
        onclick: (e) => { if (e.target.closest('.dte-tw')) return; st.focus = n.path; select(n.i, { scroll: false }); },
      },
      h('span', { class: 'dte-tw', 'aria-hidden': 'true', onclick: () => { toggle(n); } }, kids ? (open ? '▾' : '▸') : ''),
      n.labels.map((l) => h('span', { class: 'dte-lab' }, l + ':')),
      h('span', { class: 'dte-nm' }, base || '/', unit != null ? h('span', { class: 'dte-unit' }, '@' + unit) : null),
      n.status && n.status !== 'okay' && n.status !== 'ok' ? h('span', { class: 'dte-st' }, n.status) : null,
      n.status && (n.status === 'okay' || n.status === 'ok') && !n.eff ? h('span', { class: 'dte-st bad', title: 'okay, but a parent is disabled' }, 'okay under disabled') : null,
      worst ? h('span', { class: `dte-badge ${worst}`, title: `${n.finds.length} finding${n.finds.length === 1 ? '' : 's'}` }, String(n.finds.length)) : null,
      n.cpu[0] ? h('span', { class: 'dte-cpu' }, n.cpu[0]) : null);
      return row;
    }));
    if (hadFocus || focusRow) tree.querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
  }
  function toggle(n) {
    if (!n.kids.length) return;
    if (st.collapsed.has(n.path)) st.collapsed.delete(n.path); else st.collapsed.add(n.path);
    st.focus = n.path;
    drawTree(true);
  }
  function scrollRowIntoView(path) {
    const el = tree.querySelector(`[data-path="${CSS.escape(path)}"]`);
    if (!el) return;
    const t = el.offsetTop - tree.offsetTop, b = t + el.offsetHeight;
    if (t < tree.scrollTop) tree.scrollTop = t - 20;
    else if (b > tree.scrollTop + tree.clientHeight) tree.scrollTop = b - tree.clientHeight + 20;
  }
  tree.addEventListener('keydown', (e) => {
    const here = e.target.closest?.('.dte-row');
    if (here) st.focus = here.dataset.path;
    const rows = [...tree.querySelectorAll('.dte-row')];
    const cur = rows.findIndex((r) => r.dataset.path === st.focus);
    const n = byPath.get(st.focus);
    const go = (k) => { const r = rows[Math.max(0, Math.min(rows.length - 1, k))]; if (!r) return; st.focus = r.dataset.path; rows.forEach((x) => x.setAttribute('tabindex', x === r ? '0' : '-1')); r.focus(); scrollRowIntoView(r.dataset.path); };
    if (e.key === 'ArrowDown') { e.preventDefault(); go(cur + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(cur - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(rows.length - 1); }
    else if (e.key === 'ArrowRight' && n) {
      e.preventDefault();
      if (n.kids.length && st.collapsed.has(n.path)) toggle(n); else if (n.kids.length) go(cur + 1);
    } else if (e.key === 'ArrowLeft' && n) {
      e.preventDefault();
      if (n.kids.length && !st.collapsed.has(n.path) && !st.filter) toggle(n);
      else { const p = node(n.parent); if (p) { st.focus = p.path; drawTree(true); scrollRowIntoView(p.path); } }
    } else if ((e.key === 'Enter' || e.key === ' ') && n) { e.preventDefault(); select(n.i, { focus: true }); }
  });

  // ================= address map =================
  function drawMap() {
    if (!V) return;
    mapSvg.replaceChildren();
    const regs = V.map.filter((m) => st.mapAll || m.on).map((m) => ({ ...m, s: big(m.start), e: big(m.end) + 1n }));
    const W = Math.max(280, mapScroll.clientWidth || 420);
    if (!regs.length) {
      mapSvg.setAttribute('viewBox', `0 0 ${W} 70`); mapSvg.setAttribute('height', 70);
      mapSvg.append(s('text', { x: 12, y: 30, class: 'soft' }, 'No memory-mapped reg to draw.'),
        s('text', { x: 12, y: 48, class: 'soft small' }, 'Nodes need reg under buses with ranges up to the root.'));
      mapSub.textContent = '';
      return;
    }
    // boundaries -> compressed y axis
    const pts = [...new Set(regs.flatMap((r) => [r.s, r.e]).map(String))].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const covered = (a, b) => regs.some((r) => r.s <= a && r.e >= b);
    const Y = new Map();
    const gaps = [];
    let y = 8;
    const hex = (v) => '0x' + v.toString(16).padStart(8, '0');
    for (let k = 0; k < pts.length; k++) {
      Y.set(String(pts[k]), y);
      if (k === pts.length - 1) break;
      const a = pts[k], b = pts[k + 1], size = Number(b - a);
      if (covered(a, b)) y += Math.max(18, Math.min(64, 10 + 3.2 * Math.log2(Math.max(1, size / 64))));
      else { gaps.push({ y, size: b - a }); y += 22; }
    }
    const H = y + 10;
    // lanes: an interval goes to the first lane that is free at its start
    const lanes = [];
    const sorted = [...regs].sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0) || (a.e > b.e ? -1 : 1));
    for (const r of sorted) {
      let L = lanes.findIndex((end) => end <= r.s);
      if (L < 0) { L = lanes.length; lanes.push(0n); }
      lanes[L] = r.e; r.lane = L;
    }
    const nL = Math.min(4, lanes.length);
    const axisW = 96, x0 = axisW + 8, laneW = (W - x0 - 6) / nL;
    mapSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    mapSvg.setAttribute('height', H);
    const defs = s('defs');
    const hatch = (id, color, op) => {
      const p = s('pattern', { id, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
      p.append(s('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: color, 'stroke-width': 1.6, 'stroke-opacity': op }));
      defs.append(p);
    };
    hatch('dte-off', 'var(--ink-soft)', 0.35);
    hatch('dte-bad', 'var(--danger)', 0.5);
    mapSvg.append(defs);
    // gaps
    for (const g of gaps) {
      const n = Math.ceil((W - x0) / 8);
      const zig = `M${x0},${g.y + 11} ` + Array.from({ length: n }, (_, k) => `l4,${k % 2 ? 3 : -3}`).join(' ');
      mapSvg.append(s('path', { d: zig, class: 'dte-zig' }));
      const tw = 8 + 6.2 * (`${human(g.size)} not mapped`).length;
      mapSvg.append(s('rect', { x: x0 + 18, y: g.y + 4, width: tw, height: 14, class: 'dte-gapbg' }));
      mapSvg.append(s('text', { x: x0 + 22, y: g.y + 14.5, class: 'soft small' }, `${human(g.size)} not mapped`));
    }
    // start addresses at the left, skipping ones that would collide
    const startsAt = new Set(regs.map((r) => String(r.s)));
    let lastY = -99;
    for (const p of pts) {
      if (!startsAt.has(String(p))) continue;
      const yy = Y.get(String(p));
      if (yy - lastY < 11) continue;
      lastY = yy;
      mapSvg.append(s('line', { x1: axisW + 2, x2: x0, y1: yy, y2: yy, class: 'dte-tick' }));
      mapSvg.append(s('text', { x: axisW, y: yy + 3.5, class: 'addr', 'text-anchor': 'end' }, hex(p)));
    }
    const sn = selNode();
    const items = [];
    for (const r of sorted) {
      const n = node(r.i);
      const y1 = Y.get(String(r.s)), y2 = Y.get(String(r.e));
      const lane = Math.min(r.lane, nL - 1);
      // reach right until a block in a later lane shares these addresses
      let right = nL;
      for (const o of sorted) if (o !== r && o.lane > r.lane && o.s < r.e && o.e > r.s) right = Math.min(right, Math.min(o.lane, nL - 1));
      if (right <= lane) right = lane + 1;
      const x = x0 + lane * laneW, w = (right - lane) * laneW - 4, hh = Math.max(3, y2 - y1 - 1);
      const isSel = sn && sn.i === r.i;
      const g = s('g', { class: `dte-blk${r.on ? '' : ' off'}${r.bad ? ' bad' : ''}${isSel ? ' sel' : ''}`, tabindex: '0', role: 'button',
        'aria-label': `${n.path}, ${r.start} to ${r.end}, ${r.human}${r.on ? '' : ', disabled'}${r.bad ? ', overlaps' : ''}` });
      const tone = n.kids.some((k) => V.map.some((m) => m.i === k)) ? 'bus' : /memory/.test(n.name) || /sram/.test(n.name) ? 'mem' : 'dev';
      g.append(s('rect', { x, y: y1 + 0.5, width: w, height: hh, rx: 2, class: `dte-fill ${tone}` }));
      if (!r.on) g.append(s('rect', { x, y: y1 + 0.5, width: w, height: hh, rx: 2, fill: 'url(#dte-off)' }));
      if (r.bad) g.append(s('rect', { x, y: y1 + 0.5, width: w, height: hh, rx: 2, fill: 'url(#dte-bad)' }));
      g.append(s('rect', { x, y: y1 + 0.5, width: w, height: hh, rx: 2, class: 'ring' }));
      if (hh >= 13) {
        const clip = `dte-c${r.i}-${lane}-${String(r.s)}`;
        const cp = s('clipPath', { id: clip }); cp.append(s('rect', { x: x + 2, y: y1, width: w - 4, height: hh })); defs.append(cp);
        const t = s('text', { x: x + 6, y: y1 + Math.min(hh / 2 + 4, 14), class: 'lbl', 'clip-path': `url(#${clip})` });
        t.append(s('tspan', { class: 'b' }, n.labels[0] ? n.labels[0] : n.name.split('@')[0]));
        t.append(s('tspan', { class: 'soft', dx: 6 }, r.human));
        g.append(t);
        if (hh >= 30 && w > 150) g.append(s('text', { x: x + 6, y: y1 + 27, class: 'soft small', 'clip-path': `url(#${clip})` }, `${r.start} - ${r.end}`));
      }
      g.append(s('title', {}, `${n.path}\n${r.start} - ${r.end} (${r.human})${r.on ? '' : '\ndisabled'}${r.bad ? '\noverlaps another enabled node' : ''}`));
      g.addEventListener('click', () => select(r.i));
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(r.i, { focus: false }); mapSvg.querySelector(`[data-k="${items.indexOf(g)}"]`)?.focus(); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const k = items.indexOf(g) + (e.key === 'ArrowDown' ? 1 : -1);
          items[Math.max(0, Math.min(items.length - 1, k))]?.focus();
        }
      });
      g.setAttribute('data-k', items.length);
      items.push(g);
      mapSvg.append(g);
    }
    const lo = regs.reduce((a, r) => (r.s < a ? r.s : a), regs[0].s), hi = regs.reduce((a, r) => (r.e > a ? r.e : a), regs[0].e);
    const nb = regs.filter((r) => r.bad).length;
    mapSub.replaceChildren(...[`${regs.length} regions, ${hex(lo)} - ${hex(hi - 1n)}`, nb ? h('b', { class: 'bad' }, ` · ${nb} overlapping`) : null].filter(Boolean));
    if (sn) {
      const blk = mapSvg.querySelector('.dte-blk.sel');
      if (blk) {
        const bb = blk.getBBox();
        const sc = mapScroll;
        const ratio = mapSvg.getBoundingClientRect().height / H || 1;
        const top = bb.y * ratio, bot = (bb.y + bb.height) * ratio;
        if (top < sc.scrollTop || bot > sc.scrollTop + sc.clientHeight) sc.scrollTop = Math.max(0, top - 40);
      }
    }
  }
  function human(b) {
    const v = Number(b);
    for (const [u, n] of [[2 ** 30, 'GiB'], [2 ** 20, 'MiB'], [2 ** 10, 'KiB']]) if (v >= u) return `${Number((v / u).toFixed(v % u ? 1 : 0))} ${n}`;
    return `${v} B`;
  }

  // ================= inspector =================
  function drawInsp() {
    const n = selNode();
    if (!V) return;
    if (!n) {
      insp.replaceChildren(h('div', { class: 'dte-head' }, h('h2', {}, 'Node')),
        h('div', { class: 'dte-none' }, 'Click a node in the tree or a block in the map to see its merged properties.'));
      return;
    }
    // breadcrumb
    const chain = [];
    for (let p = n; p; p = node(p.parent)) chain.unshift(p);
    const crumbs = h('div', { class: 'dte-crumbs' }, chain.map((p, k) => [k > 1 ? h('span', { class: 'sep' }, '/') : null,
      k === 0 ? h('button', { class: 'dte-crumb', onclick: () => select(p.i) }, '/') : h('button', { class: `dte-crumb${p === n ? ' cur' : ''}`, onclick: () => select(p.i) }, p.name)]));
    const on = n.on, eff = n.eff;
    const toggleBtn = n.parent >= 0 ? h('button', { class: 'k-btn dte-mini', title: `Append &${n.labels[0] || `{${n.path}}`} { status = "..."; }; to ${targetFile(n)}`,
      onclick: () => setStatus(n, on ? 'disabled' : 'okay') }, on ? 'Disable' : 'Enable') : null;
    const statusPill = h('span', { class: `dte-pill ${eff ? 'ok' : 'off'}` }, eff ? 'enabled' : on ? 'disabled by a parent' : `status "${n.status}"`);
    const head = h('div', { class: 'dte-ihead' },
      h('div', { class: 'dte-ititle' },
        n.labels.map((l) => h('span', { class: 'dte-lab big' }, l + ':')),
        h('h2', {}, n.name || '/'), statusPill, toggleBtn),
      crumbs,
      n.compat ? h('div', { class: 'dte-sub' }, 'compatible ', h('code', {}, n.compat)) : null,
      h('div', { class: 'dte-sub' }, n.defs.length > 1 ? `defined in ${n.defs.length} places: ` : 'defined in ', n.defs.map((d) => locLink(d.file, d.line))));
    const finds = n.finds.map((k) => V.findings[k]);
    const fBox = finds.length ? h('div', { class: 'dte-ifind' }, finds.map((f) => h('div', { class: `dte-frow ${f.sev}` }, h('i', { class: 'dte-dot' }), f.file ? locLink(f.file, f.line) : null, h('span', {}, f.msg)))) : null;
    // properties
    const rows = n.props.map((p) => {
      const val = h('div', { class: 'dte-val' });
      if (p.del) val.append(h('span', { class: 'dte-del' }, 'deleted'));
      else if (p.refs && p.refs.length) {
        // put links where the &refs are in the printed value
        let rest = p.v;
        for (const r of p.refs) {
          const at = rest.indexOf(r.t);
          if (at < 0) continue;
          val.append(rest.slice(0, at), nodeLink(r.i, r.t));
          rest = rest.slice(at + r.t.length);
        }
        val.append(rest);
      } else val.append(p.v === '' ? h('span', { class: 'dte-soft' }, '(present, no value)') : p.v);
      if (p.status) val.classList.add(p.v.includes('okay') || p.v.includes('"ok"') ? 'okay' : 'disabled');
      const extra = [];
      if (p.reg) for (const r of p.reg) {
        extra.push(h('div', { class: `dte-xl${r.cpu ? '' : r.why && /outside/.test(r.why) ? ' bad' : ''}` },
          r.cpu ? [h('span', { class: 'dte-arrow' }, '→ CPU '), h('b', {}, r.cpu), ` +${r.size}`, r.hops.length ? h('span', { class: 'dte-soft' }, `  via ${r.hops.join(', ')}`) : null]
            : [h('span', { class: 'dte-arrow' }, '→ '), `${r.addr} ${r.why || 'not mapped'}`]));
      }
      if (p.spec) extra.push(h('div', { class: 'dte-xl' }, h('span', { class: 'dte-arrow' }, '→ '), p.spec.join(' ; ')));
      if (p.trail) {
        for (const t of p.trail.slice(0, -1)) extra.push(h('div', { class: 'dte-hist' }, t.a === 'delete' ? h('span', {}, 'deleted') : h('s', {}, t.v || '(set)'), ' ', locLink(t.file, t.line, 'dte-loc small')));
      }
      return h('tr', { class: p.del ? 'del' : null },
        h('th', { scope: 'row' }, h('div', { class: 'dte-pn' }, p.name),
          h('div', { class: 'dte-where' }, locLink(p.file, p.line, 'dte-loc small'), p.trail && p.trail.length > 1 ? h('span', { class: 'dte-ovr', title: `set in ${p.trail.length} places; the older values are listed under the value` }, `${p.trail.length}×`) : null)),
        h('td', {}, val, extra));
    });
    const table = h('table', { class: 'dte-props' }, h('thead', {}, h('tr', {}, h('th', {}, 'Property · set in'), h('th', {}, 'Merged value'))), h('tbody', {}, rows));
    const pins = V.pins.filter((p) => p.c === n.i || p.g === n.i);
    const pinBox = pins.length ? h('div', { class: 'dte-block' }, h('div', { class: 'dte-bt' }, 'Pins (default state)'),
      h('div', { class: 'dte-pins' }, pins.map((p) => h('span', { class: `dte-pin${V.findings.some((f) => f.kind === 'pinmux' && f.msg.includes(p.pin)) ? ' bad' : ''}` },
        h('b', {}, p.pin), p.mux != null ? ` m${p.mux}` : '', ' ', p.c !== n.i ? nodeLink(p.c) : nodeLink(p.g))))) : null;
    const kids = n.kids.length ? h('div', { class: 'dte-block' }, h('div', { class: 'dte-bt' }, `Children (${n.kids.length})`), h('div', { class: 'dte-links' }, n.kids.map((k) => nodeLink(k, node(k).name)))) : null;
    const refBy = n.refBy.length ? h('div', { class: 'dte-block' }, h('div', { class: 'dte-bt' }, `Referenced by (${n.refBy.length})`), h('div', { class: 'dte-links' }, n.refBy.map((k) => nodeLink(k)))) : null;
    insp.replaceChildren(...[head, fBox, h('div', { class: 'dte-tablewrap' }, table), pinBox, refBy, kids].filter(Boolean));
    drawFindings();
  }

  // ================= editing: status toggle =================
  function targetFile(n) {
    const ovs = (ctx.raw.files || []).filter((f) => String(f.kind).toLowerCase() === 'overlay').map((f) => f.name);
    // a node an overlay creates can only be changed after that overlay; a base node in the board file
    const first = n.defs[0]?.file;
    return first && ovs.includes(first) ? first : ctx.raw.main_name;
  }
  function setStatus(n, status) {
    const ref = n.labels[0] ? '&' + n.labels[0] : `&{${n.path}}`;
    const block = `${ref} {\n\tstatus = "${status}";\n};\n`;
    const file = targetFile(n);
    const esc = ref.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const tail = new RegExp(`\\n${esc} \\{\\n\\tstatus = "(okay|disabled)";\\n\\};\\n?$`);
    const edit = (text) => {
      const t = String(text ?? '');
      if (tail.test(t)) return t.replace(tail, '\n' + block);
      return t.replace(/\n*$/, '\n\n') + block;
    };
    if (file === ctx.raw.main_name) ctx.set('dts', edit(ctx.raw.dts));
    else {
      const rows = (ctx.raw.files || []).map((r) => ({ ...r }));
      const r = rows.find((x) => x.name === file);
      if (r) { r.text = edit(r.text); ctx.set('files', rows); }
    }
    const tabIndex = file === ctx.raw.main_name ? 0 : 1 + (ctx.raw.files || []).findIndex((x) => x.name === file);
    if (tabIndex === st.tab) { editor.value = currentText(); drawGutter(); }
  }

  // ================= sources =================
  const fileRows = () => ctx.raw.files || [];
  const currentText = () => (st.tab === 0 ? String(ctx.raw.dts ?? '') : String(fileRows()[st.tab - 1]?.text ?? ''));
  const currentName = () => (st.tab === 0 ? String(ctx.raw.main_name || '') : String(fileRows()[st.tab - 1]?.name || ''));
  let typing = null;
  editor.addEventListener('input', () => {
    drawGutter();
    clearTimeout(typing);
    const v = editor.value, tab = st.tab;
    typing = setTimeout(() => {
      if (tab === 0) ctx.set('dts', v);
      else { const rows = fileRows().map((r) => ({ ...r })); if (rows[tab - 1]) { rows[tab - 1].text = v; ctx.set('files', rows); } }
    }, 220);
  });
  editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      // a tab character, as DTS is indented; Esc then Tab leaves the editor
      if (editor.dataset.esc === '1') { editor.dataset.esc = ''; return; }
      e.preventDefault();
      const a = editor.selectionStart, b = editor.selectionEnd;
      editor.setRangeText('\t', a, b, 'end');
      editor.dispatchEvent(new Event('input'));
    } else if (e.key === 'Escape') editor.dataset.esc = '1';
    else editor.dataset.esc = '';
  });
  function drawTabs() {
    const rows = fileRows();
    if (st.tab > rows.length) st.tab = 0;
    const used = new Map((V?.files || []).map((f) => [f.name, f]));
    const tabFor = (k, name, kind) => {
      const bad = V ? V.findings.filter((f) => f.file === name && f.sev === 'error').length : 0;
      const u = used.get(name);
      return h('button', { role: 'tab', class: `dte-tab${u && !u.used ? ' unused' : ''}`, 'aria-selected': String(st.tab === k),
        title: u && !u.used ? 'not included by the main file' : kind, onclick: () => { st.tab = k; drawSources(); } },
      h('span', { class: `dte-kind ${kind}` }, kind === 'main' ? 'dts' : kind === 'overlay' ? 'dtso' : 'dtsi'), name || '(unnamed)',
      bad ? h('span', { class: 'dte-badge error' }, String(bad)) : null);
    };
    tabs.replaceChildren(tabFor(0, ctx.raw.main_name, 'main'),
      ...rows.map((r, k) => tabFor(k + 1, r.name, String(r.kind).toLowerCase() === 'overlay' ? 'overlay' : 'include')),
      h('button', { class: 'k-btn dte-mini', title: 'Add an include file', onclick: () => addFile('include') }, '+ .dtsi'),
      h('button', { class: 'k-btn dte-mini', title: 'Add an overlay, applied after the base in tab order', onclick: () => addFile('overlay') }, '+ overlay'));
  }
  function addFile(kind) {
    const rows = fileRows().map((r) => ({ ...r }));
    const n = rows.filter((r) => String(r.kind).toLowerCase() === kind).length + 1;
    rows.push(kind === 'overlay'
      ? { name: `overlay${n}.dtso`, kind, text: '/dts-v1/;\n/plugin/;\n\n&uart1 {\n\tstatus = "okay";\n};\n' }
      : { name: `extra${n}.dtsi`, kind, text: '/ {\n};\n' });
    st.tab = rows.length;
    ctx.set('files', rows);
    drawSources();
    editor.focus();
  }
  function drawFileBar() {
    const k = st.tab;
    const nameIn = h('input', { type: 'text', class: 'dte-name', spellcheck: 'false', value: currentName(), 'aria-label': 'File name',
      onchange: (e) => {
        const v = e.target.value.trim(); if (!v) return;
        if (k === 0) ctx.set('main_name', v);
        else { const rows = fileRows().map((r) => ({ ...r })); rows[k - 1].name = v; ctx.set('files', rows); }
        drawTabs();
      } });
    const bits = [h('label', {}, 'Name ', nameIn)];
    if (k > 0) {
      const row = fileRows()[k - 1];
      const kindSel = h('select', { 'aria-label': 'Kind', onchange: (e) => { const rows = fileRows().map((r) => ({ ...r })); rows[k - 1].kind = e.target.value; ctx.set('files', rows); drawTabs(); } },
        ['include', 'overlay'].map((o) => h('option', { value: o, selected: String(row.kind).toLowerCase() === o }, o)));
      bits.push(h('label', {}, 'Kind ', kindSel),
        h('button', { class: 'k-btn dte-mini', onclick: () => { const rows = fileRows().map((r) => ({ ...r })); rows.splice(k - 1, 1); st.tab = 0; ctx.set('files', rows); drawSources(); } }, 'Remove file'));
    }
    const lines = currentText().split('\n').length;
    bits.push(h('span', { class: 'dte-sub dte-right' }, `${lines} lines`, k === 0 ? ' · #include "name" finds a tab by name' : String(fileRows()[k - 1]?.kind).toLowerCase() === 'overlay' ? ' · applied after the base, in tab order' : ''));
    fileBar.replaceChildren(...bits);
  }
  function drawGutter() {
    const n = editor.value.split('\n').length;
    const name = currentName();
    const marks = new Map();
    for (const f of V?.findings || []) if (f.file === name && f.line) { const was = marks.get(f.line); if (!was || f.sev === 'error') marks.set(f.line, f.sev); }
    gutter.replaceChildren(...Array.from({ length: n }, (_, k) => {
      const m = marks.get(k + 1);
      return h('span', { class: m ? `m ${m}` : null }, String(k + 1) + '\n');
    }));
    gutter.scrollTop = editor.scrollTop;
  }
  function drawSources() {
    drawTabs(); drawFileBar();
    if (editor.value !== currentText()) editor.value = currentText();
    drawGutter();
  }
  function openSource(file, line) {
    let k = -1;
    if (file === ctx.raw.main_name) k = 0;
    else { const j = fileRows().findIndex((r) => r.name === file); if (j >= 0) k = j + 1; }
    if (k < 0) return;
    st.tab = k; drawSources();
    const lines = editor.value.split('\n');
    const a = lines.slice(0, line - 1).reduce((t, l) => t + l.length + 1, 0);
    const b = a + (lines[line - 1] || '').length;
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(a, b);
    const lh = parseFloat(getComputedStyle(editor).lineHeight) || 18;
    editor.scrollTop = Math.max(0, (line - 4) * lh);
    gutter.scrollTop = editor.scrollTop;
    srcCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ================= dtc check =================
  dtcBtn.addEventListener('click', async () => {
    if (!V) return;
    dtcBtn.disabled = true;
    dtcOut.replaceChildren(h('div', { class: 'dte-soft' }, 'Compiling with dtc…'));
    const out = [];
    try {
      for (const f of V.flats) {
        const body = JSON.stringify({ kind: 'dts', input: f.text, overlay: f.overlay });
        const resp = await fetch('/api/tools/check', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' }, body });
        if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status}`), { status: resp.status });
        const r = await resp.json();
        out.push({ f, r });
      }
      dtcOut.replaceChildren(...out.map(({ f, r }) => {
        const errs = (r.errors || []).filter((e) => !/^FATAL ERROR|Input tree has errors/.test(e.message || ''));
        return h('div', { class: `dte-dtcr ${r.ok ? 'ok' : 'bad'}` },
          h('b', {}, `${f.name}${f.overlay ? ' (overlay)' : ''}: `), r.ok ? `compiles${f.overlay ? ' as an overlay' : ''} with ${(r.notes || [])[0]?.replace('Version: ', '') || 'dtc'}` : 'dtc rejects it',
          errs.map((e) => { const m = mapLine(f, e.message, e.line); return h('div', { class: 'dte-dtce' }, m.file ? locLink(m.file, m.line) : null, ' ', m.msg); }),
          (r.warnings || []).slice(0, 20).map((w) => { const m = mapLine(f, typeof w === 'string' ? w : w.message, w.line); return h('div', { class: 'dte-dtce warn' }, m.file ? locLink(m.file, m.line) : null, ' ', m.msg); }));
      }));
    } catch (e) {
      dtcOut.replaceChildren(h('div', { class: 'dte-dtcr' }, h('b', {}, 'dtc is not reachable here. '),
        [404, 405, 501].includes(e.status) || !e.status
          ? 'The real compile runs inside the Redline app (tools image); opened on its own this page has no server to ask. The findings above come from the built-in parser.'
          : `The check service answered ${e.message}. The findings above come from the built-in parser.`));
    } finally { dtcBtn.disabled = false; }
  });
  function mapLine(f, msg, line) {
    const m = /in\.dts:(\d+)(?:\.\d+)?(?:-(?:\d+\.)?\d+)?:?\s*/.exec(msg || '');
    const ln = m ? Number(m[1]) : line || null;
    let text = String(msg || '').replace(/\S*in\.dts:[\d.-]+:?\s*/g, '');
    if (!ln) return { msg: text };
    let at = 0;
    for (const [file, first, count] of f.origin) {
      if (ln <= at + count) return { file, line: first + (ln - at - 1), msg: text };
      at += count;
    }
    return { msg: text };
  }

  // ================= results =================
  let firstResult = true;
  ctx.onResult((r) => {
    res = r; V = r && r.view;
    if (!V) { tree.replaceChildren(h('div', { class: 'dte-none' }, (r?.warnings || ['Nothing to show.']).join(' '))); return; }
    byPath = new Map(V.nodes.map((n) => [n.path, n]));
    if (V.sel != null) st.sel = V.nodes[V.sel].path;
    else if (!st.sel || !byPath.has(st.sel)) st.sel = null;
    if (firstResult) {
      firstResult = false;
      if (V.nodes.length > 150) collapseDeep(2);
      try {
        const chosen = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`);
        if (!chosen) [...ctx.outputs.querySelectorAll('.k-tab')].find((t) => t.textContent === 'Merged tree')?.click();
      } catch { /* private window */ }
      drawSources();
      requestAnimationFrame(() => { if (st.sel) scrollRowIntoView(st.sel); });
    } else { drawTabs(); drawFileBar(); drawGutter(); }
    drawFindings(); drawTree(); drawMap(); drawInsp();
  });
  let lastW = 0;
  new ResizeObserver(() => { const w = mapScroll.clientWidth; if (w && Math.abs(w - lastW) > 4) { lastW = w; drawMap(); } }).observe(mapScroll);
}
