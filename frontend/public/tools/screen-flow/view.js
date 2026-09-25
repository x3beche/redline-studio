// Screen Flow Mapper: the page is the app's navigation map.
//   Map        - one lane per step from the start screen, each screen drawn
//                as a small phone (its wireframe guessed from its name), the
//                transitions as arrows with their action on a pill; back
//                transitions (to the same or an earlier step) arc underneath,
//                dashed. Click a screen to select it and show the shortest
//                route to it; drag from one screen onto another to add a
//                transition (onto empty space: a new screen). Unreachable
//                screens sit in a red lane; dead ends get an amber stop bar.
//   Health     - chips for unreachable screens, dead ends and loops light
//                those screens up on the map.
//   Route      - the shortest path to the selected screen, step by step.
//   Inspector  - the selected screen (rename, start, end mark, delete, its
//                ways in and out, add a transition) or transition (label).
//   Source     - the transition text itself; every edit on the map is written
//                back into it, so it stays the one thing agents and people read.
// Depths, statuses, loops and the route all come from run()'s result.
import { parseFlow } from './tool.js';

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
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};
const trunc = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

// ---------- editing the transition text ----------
const ARROW_SPLIT = /(\s*(?:<->|<-->|-->|->|=>|→|⇒|↔)\s*)/;
const COMMENT = /(^|\s)(#|\/\/)/;
const clean = (t) => t.trim().replace(/!$/, '').trim().replace(/^["']|["']$/g, '').trim();
// Split one line into [code parts..., tail] keeping everything but the names untouched.
function splitLine(raw) {
  const cm = COMMENT.exec(raw);
  const code = cm ? raw.slice(0, cm.index + cm[1].length) : raw;
  const comment = cm ? raw.slice(cm.index + cm[1].length) : '';
  let rest = code, tail = '';
  const br = /\[([^\]]*)\]\s*$/.exec(rest);
  if (br) { tail = rest.slice(br.index); rest = rest.slice(0, br.index); } else {
    const c = rest.lastIndexOf(':');
    const lastArrow = Math.max(...['->', '=>', '→', '⇒', '↔'].map((a) => rest.lastIndexOf(a)));
    if (c > lastArrow && lastArrow >= 0) { tail = rest.slice(c); rest = rest.slice(0, c); }
  }
  return { parts: rest.split(ARROW_SPLIT), tail, comment };
}
// Replace name tokens on every line: fn(token, name) -> new token.
function mapNames(text, fn) {
  return String(text).split('\n').map((raw) => {
    if (!raw.trim() || /^\s*(#|\/\/)/.test(raw)) return raw;
    const { parts, tail, comment } = splitLine(raw);
    for (let i = 0; i < parts.length; i += 2) {
      const tok = parts[i];
      const lead = tok.match(/^\s*/)[0], trail = tok.match(/\s*$/)[0];
      const core = tok.trim();
      const nt = fn(core, clean(core));
      if (nt !== core) parts[i] = lead + nt + trail;
    }
    return parts.join('') + tail + comment;
  }).join('\n');
}
const labelPart = (label) => (!label ? '' : /[:\]]/.test(label) ? ` [${label.replace(/\]/g, ')')}]` : ` : ${label}`);
const edgeLine = (from, to, label, ends) => `${from}${ends.has(from) ? '!' : ''} -> ${to}${ends.has(to) ? '!' : ''}${labelPart(label)}`;

// Rewrite the line that holds one transition as one line per transition it
// defined, applying fn(edge) -> edge | null to each (null drops it).
function rewriteLineOf(text, edge, fn) {
  const { nodes, edges } = parseFlow(text);
  const ends = new Set([...nodes.values()].filter((n) => n.end).map((n) => n.name));
  const hit = edges.find((e) => e.from === edge.from && e.to === edge.to && e.label === edge.label)
    || edges.find((e) => e.from === edge.from && e.to === edge.to);
  if (!hit) return text;
  const lines = String(text).split('\n');
  const onLine = edges.filter((e) => e.line === hit.line);
  const out = [];
  for (const e of onLine) {
    const r = e === hit ? fn({ ...e }) : e;
    if (r) out.push(edgeLine(r.from, r.to, r.label, ends));
  }
  const raw = lines[hit.line - 1];
  const cm = COMMENT.exec(raw);
  if (cm && out.length) out[0] += ' ' + raw.slice(cm.index + cm[1].length);
  lines.splice(hit.line - 1, 1, ...out);
  return lines.join('\n');
}

// A guess at what the screen looks like, from its name: a wireframe to tell
// screens apart at a glance.
function kindOf(name) {
  const n = name.toLowerCase();
  if (/splash|launch|loading/.test(n)) return 'splash';
  if (/log ?in|sign ?(in|up)|register|password|otp|verify|auth/.test(n)) return 'form';
  if (/done|success|complete|thank|confirm/.test(n)) return 'done';
  if (/cart|basket|checkout|pay|order|bag/.test(n)) return 'cart';
  if (/setting|preference|profile|account/.test(n)) return 'settings';
  if (/product|detail|item|article|post|share/.test(n)) return 'detail';
  if (/onboard|welcome|intro|tour|promo|banner/.test(n)) return 'onboard';
  if (/search|result/.test(n)) return 'search';
  return 'list';
}

const NW = 78, NH = 116;

export function page(root, ctx) {
  const state = { sel: null, hl: null, link: null, focus: null };
  const history = [];

  // ---------- skeleton ----------
  const chips = h('div', { class: 'sf-head', role: 'group', 'aria-label': 'Flow health' });
  const svg = sv('svg', { class: 'sf-svg', role: 'group', 'aria-label': 'Screen flow map' });
  const box = h('div', { class: 'sf-box' }, svg);
  const route = h('div', { class: 'sf-route', 'aria-live': 'polite' });
  const map = h('section', { class: 'sf-card sf-map' }, chips, box, route);

  const insp = h('div', { class: 'sf-ib' });
  const inspCard = h('aside', { class: 'sf-card sf-insp' }, h('div', { class: 'sf-head' }, h('h2', {}, 'Selected'), h('span', { class: 'sf-grow' }),
    h('button', { class: 'k-btn', type: 'button', id: 'sf-undo', title: 'Undo the last change made on the map (Ctrl+Z)', onclick: () => undo() }, 'Undo')), insp);

  const ta = h('textarea', { spellcheck: 'false', 'aria-label': 'Transitions, one per line', rows: '12' });
  ta.addEventListener('input', () => ctx.set('flow', ta.value));
  const pkgIn = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Package for nav_graph.xml' });
  pkgIn.addEventListener('input', () => ctx.set('pkg', pkgIn.value));
  const src = h('section', { class: 'sf-card sf-src' },
    h('div', { class: 'sf-head' }, h('h2', {}, 'Source'), h('span', { class: 'sf-soft', title: 'A -> B : label (or [label]); A -> B -> C chains; A <-> B both ways; a name alone declares a screen; Name! marks an end screen; # comments' }, 'A -> B : label · A <-> B · Name! = end'),
      h('span', { class: 'sf-grow' }), h('label', { class: 'sf-f' }, h('span', {}, 'package'), pkgIn)), ta);
  const msgs = h('div', { class: 'sf-msgs' });
  const bottom = h('div', { class: 'sf-bottom' }, src, ctx.outputs, msgs);
  root.append(h('div', { class: 'sf' }, map, inspCard, bottom));

  // ---------- data ----------
  const G = () => ctx.result?.graph || null;
  const nodeOf = (n) => G()?.nodes.find((x) => x.name === n) || null;
  const tableRows = (prefix) => (ctx.result?.tables || []).find((t) => t.title.startsWith(prefix))?.rows || [];
  const loops = () => tableRows('Loops').map((r) => String(r[1]).split(', '));
  const edit = (text, sel) => {
    history.push({ flow: ctx.raw.flow, start: ctx.raw.start, goal: ctx.raw.goal });
    if (history.length > 60) history.shift();
    if (sel !== undefined) state.sel = sel;
    const patch = { flow: text };
    if (sel && sel.type === 'node') patch.goal = sel.name;
    ctx.setMany(patch);
  };
  const undo = () => {
    const last = history.pop(); if (!last) return;
    ctx.setMany(last);
  };
  const uniqueName = (base) => {
    const names = new Set((G()?.nodes || []).map((n) => n.name));
    if (!names.has(base)) return base;
    let i = 2; while (names.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  };

  const ops = {
    addEdge(from, to, label = '') {
      const t = String(ctx.raw.flow ?? '').replace(/\s*$/, '');
      edit(`${t}\n${from} -> ${to}${labelPart(label)}`, { type: 'node', name: to });
    },
    deleteEdge(e) {
      let t = rewriteLineOf(ctx.raw.flow, e, () => null);
      // keep screens that no longer appear anywhere, as declarations
      const left = parseFlow(t).nodes;
      for (const n of [e.from, e.to]) if (!left.has(n)) t = t.replace(/\s*$/, '') + `\n${n}`;
      edit(t, { type: 'node', name: e.from });
    },
    relabel(e, label) {
      edit(rewriteLineOf(ctx.raw.flow, e, (x) => ({ ...x, label: label.trim() })), { type: 'edge', from: e.from, to: e.to, label: label.trim() });
    },
    rename(old, nu) {
      nu = clean(nu);
      if (!nu || nu === old || /->|<-|=>|→|[\[\]:#]/.test(nu)) return false;
      if ((G()?.nodes || []).some((n) => n.name === nu)) return false;
      const t = mapNames(ctx.raw.flow, (tok, name) => (name === old ? tok.replace(name, nu) : tok));
      const patch = {};
      if (clean(String(ctx.raw.start ?? '')) === old) patch.start = nu;
      history.push({ flow: ctx.raw.flow, start: ctx.raw.start, goal: ctx.raw.goal });
      state.sel = { type: 'node', name: nu };
      ctx.setMany({ ...patch, flow: t, goal: nu });
      return true;
    },
    toggleEnd(name, isEnd) {
      let done = false;
      const t = mapNames(ctx.raw.flow, (tok, n) => {
        if (n !== name) return tok;
        if (isEnd) return tok.replace(/\s*!$/, '');
        if (done) return tok;
        done = true; return tok + '!';
      });
      edit(t, { type: 'node', name });
    },
    deleteNode(name) {
      const { nodes, edges } = parseFlow(ctx.raw.flow);
      const ends = new Set([...nodes.values()].filter((n) => n.end).map((n) => n.name));
      const lines = String(ctx.raw.flow).split('\n');
      const byLine = new Map();
      for (const e of edges) { if (!byLine.has(e.line)) byLine.set(e.line, []); byLine.get(e.line).push(e); }
      const out = [];
      lines.forEach((raw, i) => {
        const es = byLine.get(i + 1);
        if (!es) {
          // a declaration line or a comment
          const code = raw.replace(/(^|\s)(#|\/\/).*$/, '').trim();
          if (code && clean(code) === name) return;
          out.push(raw); return;
        }
        if (!es.some((e) => e.from === name || e.to === name)) { out.push(raw); return; }
        for (const e of es) if (e.from !== name && e.to !== name) out.push(edgeLine(e.from, e.to, e.label, ends));
      });
      let t = out.join('\n');
      const left = parseFlow(t).nodes;
      for (const e of edges) for (const n of [e.from, e.to]) if (n !== name && !left.has(n) && !t.split('\n').includes(n)) t = t.replace(/\s*$/, '') + `\n${n}`;
      const patch = {};
      if (clean(String(ctx.raw.start ?? '')) === name) patch.start = '';
      history.push({ flow: ctx.raw.flow, start: ctx.raw.start, goal: ctx.raw.goal });
      state.sel = null;
      ctx.setMany({ ...patch, flow: t, goal: '' });
    },
  };

  const selectNode = (name, focus = false) => {
    state.sel = { type: 'node', name };
    if (focus) state.focus = name;
    if (clean(String(ctx.raw.goal ?? '')) !== name) ctx.set('goal', name); else drawAll();
  };
  const selectEdge = (e) => { state.sel = { type: 'edge', from: e.from, to: e.to, label: e.label }; drawAll(); };

  // ---------- layout ----------
  let geo = null;
  function layout() {
    const g = G(); if (!g) return null;
    const layers = g.layers.map((L) => L || []);
    const nL = layers.length;
    const maxPer = Math.max(1, ...layers.map((L) => L.length));
    const bw = Math.max(300, box.clientWidth - 2), bh = Math.max(300, box.clientHeight - 2);
    const rowH = NH + 50;
    const top = 44;
    const needH = top + maxPer * rowH + 46;
    const needW = 20 + (NW + 92) * nL;
    // zoom to fit the box, but never below 0.62: past that the map scrolls
    const scale = Math.max(0.62, Math.min(1, bw / needW, bh / needH));
    const width = Math.max(bw / scale, needW), height = Math.max(bh / scale, needH);
    const colW = Math.min(260, (width - 20) / nL);
    const pos = new Map();
    layers.forEach((L, li) => L.forEach((n, i) => {
      const off = ((maxPer - L.length) * rowH) / 2 + Math.max(0, (height - needH) / 2);
      pos.set(n, { x: 10 + li * colW + (colW - NW) / 2, y: top + 10 + off + i * rowH, li, i });
    }));
    return { layers, nL, colW, rowH, top, width, height, pos, scale };
  }

  // ---------- drawing ----------
  function drawMap() {
    const g = G();
    svg.replaceChildren();
    if (!g) {
      svg.setAttribute('width', box.clientWidth); svg.setAttribute('height', 200);
      svg.append(sv('text', { x: 20, y: 40, class: 'lane-t' }, (ctx.result?.warnings || ['Write transitions in the source'])[0]));
      geo = null; return;
    }
    const L = layout(); geo = L;
    svg.setAttribute('width', Math.floor(L.width * L.scale)); svg.setAttribute('height', Math.floor(L.height * L.scale));
    svg.setAttribute('viewBox', `0 0 ${L.width} ${L.height}`);
    const defs = sv('defs');
    for (const [id, col] of [['sf-ah', 'var(--tool-edge)'], ['sf-ah-r', 'var(--tool-route)'], ['sf-ah-s', 'var(--accent)']]) {
      const mk = sv('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' });
      mk.append(sv('path', { d: 'M0,0 L10,5 L0,10 z', style: `fill:${col}` }));
      defs.append(mk);
    }
    svg.append(defs);

    // lanes
    const unrLayer = g.nodes.some((n) => n.depth == null) ? L.nL - 1 : -1;
    L.layers.forEach((layer, li) => {
      const x = 10 + li * L.colW;
      const unr = li === unrLayer;
      svg.append(sv('rect', { x: x + 3, y: 6, width: L.colW - 6, height: L.height - 12, rx: 6, class: `lane${li % 2 ? ' alt' : ''}${unr ? ' unr' : ''}` }));
      const t = unr ? 'unreachable' : li === 0 ? 'start' : `${li} step${li > 1 ? 's' : ''}`;
      svg.append(sv('text', { x: x + 12, y: 24, class: `lane-t${unr ? ' unr' : ''}` }, t));
      svg.append(sv('text', { x: x + L.colW - 12, y: 24, 'text-anchor': 'end', class: 'lane-n' }, `${layer.length}`));
    });

    const sel = state.sel;
    const path = g.path || [];
    const onRoute = new Set(path);
    const hlSet = new Set(state.hl === 'unreachable' ? g.nodes.filter((n) => n.status === 'unreachable').map((n) => n.name)
      : state.hl === 'dead' ? g.nodes.filter((n) => n.status === 'dead end').map((n) => n.name)
        : state.hl === 'loops' ? loops().flat() : []);
    const focusName = sel?.type === 'node' ? sel.name : null;
    const related = (e) => !focusName || e.from === focusName || e.to === focusName || e.onPath;

    // edges
    const gE = sv('g'), gP = sv('g');
    const placed = [];
    g.edges.forEach((e) => {
      const a = L.pos.get(e.from), b = L.pos.get(e.to);
      if (!a || !b) return;
      let d, mx, my;
      if (e.from === e.to) {
        const x0 = a.x + NW - 12, y0 = a.y;
        d = `M${x0},${y0} C${x0 + 10},${y0 - 34} ${x0 + 40},${y0 - 14} ${a.x + NW},${a.y + 14}`;
        mx = x0 + 22; my = y0 - 22;
      } else if (!e.back) {
        const sx = a.x + NW, sy = a.y + NH / 2, tx = b.x - 2, ty = b.y + NH / 2;
        const dx = Math.max(40, (tx - sx) / 2);
        d = `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
        mx = (sx + tx) / 2; my = (sy + ty) / 2;
      } else if (a.li === b.li) {
        // same step: out of the right side and back in on the right, bulging out
        const sx = a.x + NW, sy = a.y + NH * 0.72, tx = b.x + NW + 2, ty = b.y + NH * 0.28;
        const bulge = 34 + Math.abs(sy - ty) * 0.12;
        d = `M${sx},${sy} C${sx + bulge},${sy} ${tx + bulge},${ty} ${tx},${ty}`;
        mx = Math.max(sx, tx) + bulge * 0.75; my = (sy + ty) / 2;
      } else {
        // back to an earlier step: out of the left side low, into the right side low
        const sx = a.x - 2, sy = a.y + NH * 0.78, tx = b.x + NW + 2, ty = b.y + NH * 0.78;
        const dx = Math.max(30, (sx - tx) / 2.2);
        d = `M${sx},${sy} C${sx - dx},${sy + 18} ${tx + dx},${ty + 18} ${tx},${ty}`;
        mx = (sx + tx) / 2; my = (sy + ty) / 2 + 13;
      }
      const isSel = sel?.type === 'edge' && sel.from === e.from && sel.to === e.to && sel.label === e.label;
      const cls = `edge${e.back ? ' back' : ''}${e.onPath ? ' route' : ''}${isSel ? ' sel' : ''}${related(e) ? '' : ' dim'}`;
      const mk = isSel ? 'sf-ah-s' : e.onPath ? 'sf-ah-r' : 'sf-ah';
      gE.append(sv('path', { d, class: cls, 'marker-end': `url(#${mk})` }));
      const hit = sv('path', { d, class: 'ehit' });
      hit.addEventListener('click', (ev) => { ev.stopPropagation(); selectEdge(e); });
      gE.append(hit);
      const text = trunc(e.label || '', 18);
      if (text) {
        const w = text.length * 5.9 + 12;
        // step a pill down while it would sit on one already placed
        for (let guard = 0; guard < 6 && placed.some((q) => Math.abs(q.x - mx) < (q.w + w) / 2 + 2 && Math.abs(q.y - my) < 17); guard++) my += 17;
        placed.push({ x: mx, y: my, w });
        const pill = sv('g', { class: `epill${e.onPath ? ' route' : ''}${isSel ? ' sel' : ''}${related(e) ? '' : ' dim'}`, tabindex: '0', role: 'button',
          'aria-label': `Transition ${e.from} to ${e.to}: ${e.label}` });
        pill.append(sv('rect', { x: mx - w / 2, y: my - 8, width: w, height: 16, rx: 8 }), sv('text', { x: mx, y: my + 3.5, 'text-anchor': 'middle' }, text),
          sv('title', {}, `${e.from} → ${e.to}: ${e.label}`));
        pill.addEventListener('click', (ev) => { ev.stopPropagation(); selectEdge(e); });
        pill.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectEdge(e); } });
        gP.append(pill);
      }
    });
    svg.append(gE);

    // screens
    const gN = sv('g');
    const pathIndex = new Map(path.map((n, i) => [n, i]));
    for (const n of g.nodes) {
      const p = L.pos.get(n.name); if (!p) continue;
      const cls = ['node'];
      if (n.status === 'unreachable') cls.push('unr');
      if (onRoute.has(n.name)) cls.push('route');
      if (focusName === n.name) cls.push('sel');
      if (hlSet.has(n.name)) cls.push('hl');
      if (state.hl && hlSet.size && !hlSet.has(n.name)) cls.push('dim');
      const gg = sv('g', { class: cls.join(' '), tabindex: '0', role: 'button', 'data-name': n.name,
        'aria-label': `${n.name}: ${n.depth == null ? 'unreachable' : `${n.depth} steps from the start`}, ${n.in} in, ${n.out} out${n.status ? `, ${n.status}` : ''}` });
      gg.append(sv('rect', { x: p.x - 4, y: p.y - 4, width: NW + 8, height: NH + 8, rx: 14, class: 'ring' }));
      gg.append(sv('rect', { x: p.x, y: p.y, width: NW, height: NH, rx: 11, class: 'frame' }));
      gg.append(sv('rect', { x: p.x + 3, y: p.y + 3, width: NW - 6, height: NH - 6, rx: 8.5, class: 'scr' }));
      gg.append(sv('rect', { x: p.x + NW / 2 - 11, y: p.y + 6, width: 22, height: 5, rx: 2.5, class: 'frame' }));
      // app bar with the name (two lines)
      gg.append(sv('rect', { x: p.x + 3, y: p.y + 14, width: NW - 6, height: 30, class: 'bar' }));
      const words = n.name.split(/\s+/); let l1 = '', l2 = '';
      for (const w of words) { if (!l2 && (l1 + ' ' + w).trim().length <= 12) l1 = (l1 + ' ' + w).trim(); else l2 = (l2 + ' ' + w).trim(); }
      if (!l1) { l1 = n.name.slice(0, 12); l2 = n.name.slice(12); }
      gg.append(sv('text', { x: p.x + NW / 2, y: p.y + (l2 ? 26 : 33), 'text-anchor': 'middle', class: 'nm' }, trunc(l1, 13)));
      if (l2) gg.append(sv('text', { x: p.x + NW / 2, y: p.y + 39, 'text-anchor': 'middle', class: 'nm' }, trunc(l2, 13)));
      wire(gg, kindOf(n.name), p.x + 8, p.y + 50, NW - 16, NH - 64);
      gg.append(sv('rect', { x: p.x + NW / 2 - 14, y: p.y + NH - 8, width: 28, height: 2.5, rx: 1.2, class: 'w' }));
      // stop bar / end bar
      if (n.status === 'dead end') gg.append(sv('rect', { x: p.x + 3, y: p.y + NH - 14, width: NW - 6, height: 6, class: 'stop' }));
      if (n.status === 'end') gg.append(sv('rect', { x: p.x + 3, y: p.y + NH - 14, width: NW - 6, height: 6, class: 'endbar' }));
      // step badge
      const bi = pathIndex.has(n.name) && path.length > 1;
      const badge = sv('g', { class: `badge${bi ? ' route' : ''}` });
      badge.append(sv('circle', { cx: p.x, cy: p.y, r: 10 }), sv('text', { x: p.x, y: p.y + 3.8, 'text-anchor': 'middle' }, bi ? pathIndex.get(n.name) + 1 : (n.depth ?? '–')));
      badge.append(sv('title', {}, bi ? `step ${pathIndex.get(n.name)} of the route` : n.depth == null ? 'unreachable' : `${n.depth} steps from the start`));
      gg.append(badge);
      // status tag and in/out under the phone
      const tag = n.status === 'start' ? ['START', 'start'] : n.status === 'end' ? ['END SCREEN', 'end'] : n.status === 'dead end' ? ['NO WAY OUT', 'dead'] : n.status === 'unreachable' ? ['UNREACHABLE', 'unr'] : null;
      if (tag) gg.append(sv('text', { x: p.x + NW / 2, y: p.y + NH + 15, 'text-anchor': 'middle', class: `tag ${tag[1]}` }, tag[0]));
      gg.append(sv('text', { x: p.x + NW / 2, y: p.y + NH + (tag ? 28 : 15), 'text-anchor': 'middle', class: 'deg' }, `${n.in} in · ${n.out} out`));
      // out port: drag from here (or anywhere on the phone) to connect
      gg.append(sv('circle', { cx: p.x + NW + 1, cy: p.y + NH / 2, r: 6, class: 'port' }));
      gg.append(sv('path', { d: `M${p.x + NW - 2},${p.y + NH / 2} h6 M${p.x + NW + 1},${p.y + NH / 2 - 3} v6`, class: 'port-p' }));
      gg.append(sv('title', {}, `${n.name} · click to select and route here · drag onto another screen to add a transition`));
      gg.addEventListener('keydown', (ev) => nodeKey(ev, n.name));
      gN.append(gg);
    }
    svg.append(gN, gP);
    const rub = sv('path', { class: 'rubber', style: 'display:none' });
    const rubT = sv('text', { class: 'rubber-t', style: 'display:none' });
    svg.append(rub, rubT);
    if (state.focus) { svg.querySelector(`.node[data-name="${CSS.escape(state.focus)}"]`)?.focus(); state.focus = null; }
  }

  function wire(g, kind, x, y, w, hh) {
    const r = (a) => g.append(sv('rect', a));
    const line = (yy, frac, cls = 'w') => r({ x, y: yy, width: w * frac, height: 4, rx: 2, class: cls });
    if (kind === 'splash') { g.append(sv('circle', { cx: x + w / 2, cy: y + hh / 2 - 6, r: 13, class: 'w' })); line(y + hh / 2 + 14, 0.6); return; }
    if (kind === 'form') { for (let i = 0; i < 2; i++) r({ x, y: y + 2 + i * 14, width: w, height: 10, rx: 3, class: 'ws' }); r({ x, y: y + 31, width: w, height: 11, rx: 5.5, class: 'btn' }); line(y + 47, 0.5, 'w2'); return; }
    if (kind === 'done') { g.append(sv('circle', { cx: x + w / 2, cy: y + 20, r: 14, class: 'ws' })); g.append(sv('path', { d: `M${x + w / 2 - 7},${y + 20} l5,5 l9,-10`, class: 'ws' })); line(y + 42, 0.8); r({ x, y: y + hh - 14, width: w, height: 12, rx: 6, class: 'btn' }); return; }
    if (kind === 'cart') { for (let i = 0; i < 3; i++) { r({ x, y: y + i * 14, width: 10, height: 10, rx: 2, class: 'w' }); r({ x: x + 14, y: y + 3 + i * 14, width: w - 30, height: 4, rx: 2, class: 'w' }); r({ x: x + w - 12, y: y + 3 + i * 14, width: 12, height: 4, rx: 2, class: 'w2' }); } r({ x, y: y + hh - 14, width: w, height: 12, rx: 6, class: 'btn' }); return; }
    if (kind === 'settings') { for (let i = 0; i < 4; i++) { r({ x, y: y + 2 + i * 13, width: w - 22, height: 4, rx: 2, class: 'w' }); r({ x: x + w - 16, y: y + i * 13, width: 16, height: 8, rx: 4, class: i % 2 ? 'w2' : 'btn' }); } return; }
    if (kind === 'detail') { r({ x, y, width: w, height: 26, rx: 3, class: 'w' }); line(y + 32, 0.8); line(y + 40, 0.55, 'w2'); r({ x, y: y + hh - 14, width: w, height: 12, rx: 6, class: 'btn' }); return; }
    if (kind === 'onboard') { r({ x: x + 8, y, width: w - 16, height: 28, rx: 4, class: 'w' }); line(y + 36, 0.9); line(y + 44, 0.6, 'w2'); for (let i = 0; i < 3; i++) g.append(sv('circle', { cx: x + w / 2 - 8 + i * 8, cy: y + hh - 4, r: 2, class: i ? 'w' : 'btn' })); return; }
    if (kind === 'search') { r({ x, y, width: w, height: 11, rx: 5.5, class: 'ws' }); for (let i = 0; i < 3; i++) line(y + 18 + i * 10, i % 2 ? 0.6 : 0.85); return; }
    for (let i = 0; i < 4; i++) { r({ x, y: y + i * 14, width: 10, height: 10, rx: 5, class: 'w' }); r({ x: x + 14, y: y + 3 + i * 14, width: (w - 14) * (i % 2 ? 0.6 : 0.9), height: 4, rx: 2, class: 'w' }); }
  }

  // ---------- keyboard on the map ----------
  function nodeKey(ev, name) {
    const L = geo; if (!L) return;
    const p = L.pos.get(name);
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectNode(name, true); return; }
    if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); ops.deleteNode(name); return; }
    let target = null;
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') target = L.layers[p.li][p.i + (ev.key === 'ArrowUp' ? -1 : 1)];
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      const li = p.li + (ev.key === 'ArrowLeft' ? -1 : 1);
      const lay = L.layers[li];
      if (lay && lay.length) target = lay.reduce((best, n) => (Math.abs(L.pos.get(n).y - p.y) < Math.abs(L.pos.get(best).y - p.y) ? n : best), lay[0]);
    }
    if (target) { ev.preventDefault(); svg.querySelector(`.node[data-name="${CSS.escape(target)}"]`)?.focus(); }
  }

  // ---------- pointer: click to select, drag to connect ----------
  const toSvg = (e) => {
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  };
  svg.addEventListener('pointerdown', (e) => {
    const nd = e.target.closest('.node');
    if (!nd || e.button > 0) return;
    const p = toSvg(e);
    state.link = { from: nd.dataset.name, x0: p.x, y0: p.y, moved: false, over: null };
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    const lk = state.link; if (!lk || !geo) return;
    const p = toSvg(e);
    if (!lk.moved && Math.hypot(p.x - lk.x0, p.y - lk.y0) < 6) return;
    lk.moved = true;
    const a = geo.pos.get(lk.from);
    const rub = svg.querySelector('.rubber'), rt = svg.querySelector('.rubber-t');
    const sx = a.x + NW, sy = a.y + NH / 2;
    rub.setAttribute('d', `M${sx},${sy} C${sx + 40},${sy} ${p.x - 40},${p.y} ${p.x},${p.y}`);
    rub.style.display = '';
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.node');
    const over = under && under.dataset.name !== lk.from ? under.dataset.name : (under ? lk.from : null);
    for (const el of svg.querySelectorAll('.node.target')) el.classList.remove('target');
    if (under) under.classList.add('target');
    lk.over = over;
    rt.textContent = over ? (over === lk.from ? `${lk.from} → itself` : `${lk.from} → ${over}`) : `${lk.from} → new screen`;
    rt.setAttribute('x', p.x + 10); rt.setAttribute('y', p.y - 8); rt.style.display = '';
  });
  const endLink = (e, cancel) => {
    const lk = state.link; state.link = null;
    if (!lk) return;
    if (!lk.moved) { if (!cancel) selectNode(lk.from, false); return; }
    if (cancel) { drawMap(); return; }
    const to = lk.over || uniqueName('New screen');
    ops.addEdge(lk.from, to);
    if (!lk.over) setTimeout(() => { const i = insp.querySelector('.sf-name'); if (i) { i.focus(); i.select(); } }, 30);
  };
  svg.addEventListener('pointerup', (e) => endLink(e, false));
  svg.addEventListener('pointercancel', (e) => endLink(e, true));
  svg.addEventListener('click', (e) => {
    if (!e.target.closest('.node, .epill, .ehit') && state.sel) { state.sel = null; drawAll(); }
  });
  root.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.target.closest('textarea, input')) { e.preventDefault(); undo(); }
  });

  // ---------- health chips ----------
  function drawChips() {
    const r = ctx.result || {};
    const v = (label) => (r.values || []).find((x) => x.label === label);
    const g = G();
    const chip = (key, label, n, cls) => {
      const b = h('button', { type: 'button', class: `sf-chip ${n ? cls : ''}`, 'aria-pressed': String(state.hl === key), disabled: !n,
        title: n ? `Show the ${label} on the map` : `No ${label}`, onclick: () => { state.hl = state.hl === key ? null : key; drawAll(); } }, h('b', {}, String(n)), label);
      return b;
    };
    const stat = (n, label) => h('span', { class: 'sf-chip static' }, h('b', {}, String(n)), label);
    if (!g) { chips.replaceChildren(h('span', { class: 'sf-soft' }, 'No screens yet')); return; }
    const deep = v('Deepest screen');
    chips.replaceChildren(
      stat(v('Screens')?.value ?? 0, 'screens'), stat(v('Transitions')?.value ?? 0, 'transitions'),
      deep ? h('span', { class: 'sf-chip static', title: deep.hint || '' }, h('b', {}, String(deep.value)), `${deep.unit} deep`) : null,
      h('span', { class: 'sf-grow' }),
      chip('unreachable', 'unreachable', v('Unreachable')?.value ?? 0, 'bad'),
      chip('dead', 'dead ends', v('Dead ends')?.value ?? 0, 'warn'),
      chip('loops', 'loops', v('Loops')?.value ?? 0, 'loop'));
  }

  // ---------- route strip ----------
  function drawRoute() {
    const g = G();
    const goal = clean(String(ctx.raw.goal ?? ''));
    if (!g) { route.replaceChildren(); return; }
    const rows = tableRows('Shortest path');
    if (g.path && g.path.length > 1) {
      const kids = [h('span', { class: 'lbl' }, `Route to ${goal}, ${rows.length} step${rows.length === 1 ? '' : 's'}:`)];
      const st = (n) => h('button', { type: 'button', class: 'st', onclick: () => selectNode(n) }, n);
      kids.push(st(g.path[0]));
      for (const r of rows) kids.push(h('span', { class: 'ar' }, h('i', {}, '→'), r[3] !== '–' ? r[3] : ''), st(r[2]));
      route.replaceChildren(...kids);
    } else if (goal && g.path && g.path.length === 1) {
      route.replaceChildren(h('span', { class: 'lbl' }, `${goal} is the start screen.`), h('span', { class: 'sf-soft' }, 'Click another screen to see the fewest taps to it.'));
    } else if (goal && nodeOf(goal)?.depth == null && nodeOf(goal)) {
      route.replaceChildren(h('span', { class: 'bad' }, `${goal} cannot be reached from ${g.start}.`), h('span', { class: 'sf-soft' }, 'Drag from a reachable screen onto it to add the way in.'));
    } else {
      route.replaceChildren(h('span', { class: 'sf-soft' }, 'Click a screen to show the fewest taps to it · drag from one screen onto another to add a transition · Delete removes the focused screen'));
    }
  }

  // ---------- inspector ----------
  function drawInspector() {
    const g = G();
    const sel = state.sel;
    if (!g) { insp.replaceChildren(h('div', { class: 'sf-empty' }, 'Nothing to select yet.')); return; }
    const undoBtn = inspCard.querySelector('#sf-undo'); undoBtn.disabled = !history.length;
    if (sel?.type === 'edge') {
      const e = g.edges.find((x) => x.from === sel.from && x.to === sel.to && x.label === sel.label) || g.edges.find((x) => x.from === sel.from && x.to === sel.to);
      if (!e) { state.sel = null; return drawInspector(); }
      const lab = h('input', { type: 'text', spellcheck: 'false', value: e.label || '', 'aria-label': 'Action label' });
      const commit = () => { if (lab.value.trim() !== (e.label || '')) ops.relabel(e, lab.value); };
      lab.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(); });
      lab.addEventListener('change', commit);
      insp.replaceChildren(
        h('h3', {}, 'Transition'),
        h('div', { class: 'sf-list' }, h('div', { class: `sf-li${e.onPath ? ' route' : ''}` }, h('span', { class: 'dir' }, '→'),
          h('span', {}, h('button', { class: 'go', type: 'button', onclick: () => selectNode(e.from) }, h('b', {}, e.from)), ' → ',
            h('button', { class: 'go', type: 'button', onclick: () => selectNode(e.to) }, h('b', {}, e.to))), h('span'))),
        h('div', { class: 'sf-status sf-soft' }, e.back ? 'Goes back to the same or an earlier step (drawn dashed, underneath).' : 'Goes one or more steps deeper.'),
        h('label', { class: 'sf-f' }, h('span', {}, 'Action (what the user taps)'), lab),
        h('div', { class: 'sf-btns' },
          h('button', { class: 'k-btn', type: 'button', onclick: () => ops.addEdge(e.to, e.from, e.label ? `back: ${e.label}` : 'back') }, 'Add the way back'),
          h('button', { class: 'k-btn danger', type: 'button', onclick: () => ops.deleteEdge(e) }, 'Delete transition')));
      return;
    }
    const name = sel?.type === 'node' && nodeOf(sel.name) ? sel.name : null;
    if (!name) {
      insp.replaceChildren(
        h('div', { class: 'sf-help' },
          h('div', {}, h('b', {}, 'Click'), ' a screen to select it and see the fewest taps to it.'),
          h('div', {}, h('b', {}, 'Drag'), ' from one screen onto another to add a transition; drop on empty space for a new screen.'),
          h('div', {}, h('b', {}, 'Click'), ' an action pill or arrow to edit or delete that transition.'),
          h('div', {}, 'Keys on a focused screen: ', h('kbd', {}, '← → ↑ ↓'), ' move, ', h('kbd', {}, 'Enter'), ' select, ', h('kbd', {}, 'Del'), ' delete, ', h('kbd', {}, 'Ctrl Z'), ' undo.')),
        h('h3', {}, `Start: ${g.start}`));
      return;
    }
    const n = nodeOf(name);
    const nameIn = h('input', { class: 'sf-name', type: 'text', spellcheck: 'false', value: name, 'aria-label': 'Screen name' });
    const commit = () => { if (nameIn.value.trim() && nameIn.value.trim() !== name) { if (!ops.rename(name, nameIn.value)) nameIn.style.borderColor = 'var(--danger)'; } };
    nameIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(); if (ev.key === 'Escape') { nameIn.value = name; nameIn.blur(); } });
    nameIn.addEventListener('change', commit);
    const status = n.status === 'unreachable' ? h('span', { class: 'bad' }, `Cannot be reached from ${g.start}`)
      : n.status === 'dead end' ? h('span', { class: 'warn' }, `${n.depth} step${n.depth === 1 ? '' : 's'} from ${g.start} · no way out`)
        : n.status === 'start' ? h('span', { class: 'ok' }, 'The start screen')
          : h('span', {}, `${n.depth} step${n.depth === 1 ? '' : 's'} from ${g.start}${n.status === 'end' ? ' · intended end screen' : ''}`);
    const outs = g.edges.filter((e) => e.from === name), ins = g.edges.filter((e) => e.to === name);
    const li = (e, dir) => {
      const other = dir === 'out' ? e.to : e.from;
      return h('div', { class: `sf-li${e.onPath ? ' route' : ''}` }, h('span', { class: 'dir' }, dir === 'out' ? '→' : '←'),
        h('button', { class: 'go', type: 'button', title: `${e.from} → ${e.to}${e.label ? `: ${e.label}` : ''}`, onclick: () => selectEdge(e) }, h('b', {}, other), e.label ? h('span', {}, ` · ${e.label}`) : null),
        h('button', { class: 'sf-x', type: 'button', title: 'Delete this transition', 'aria-label': `Delete ${e.from} to ${e.to}`, onclick: () => ops.deleteEdge(e) }, '×'));
    };
    const tgt = h('select', { 'aria-label': 'Add a transition to' },
      h('option', { value: '' }, 'to…'),
      ...g.nodes.map((x) => h('option', { value: x.name }, x.name)), h('option', { value: '\u0000new' }, 'a new screen'));
    const lab = h('input', { type: 'text', placeholder: 'action', spellcheck: 'false', 'aria-label': 'Action label' });
    const add = h('button', { class: 'k-btn', type: 'button', onclick: () => {
      if (!tgt.value) { tgt.focus(); return; }
      const to = tgt.value === '\u0000new' ? uniqueName('New screen') : tgt.value;
      ops.addEdge(name, to, lab.value.trim());
    } }, 'Add');
    const isStart = n.status === 'start', isEnd = n.status === 'end' || parseFlow(ctx.raw.flow).nodes.get(name)?.end;
    insp.replaceChildren(
      h('h3', {}, 'Screen'), nameIn, h('div', { class: 'sf-status' }, status),
      h('div', { class: 'sf-btns' },
        h('button', { class: 'k-btn', type: 'button', 'aria-pressed': String(isStart), disabled: isStart, onclick: () => { history.push({ flow: ctx.raw.flow, start: ctx.raw.start, goal: ctx.raw.goal }); ctx.set('start', name); } }, isStart ? 'Start screen' : 'Make start'),
        h('button', { class: 'k-btn', type: 'button', 'aria-pressed': String(!!isEnd), title: 'An end screen is allowed to have no way out (written Name! in the source)', onclick: () => ops.toggleEnd(name, !!isEnd) }, isEnd ? 'End screen ✓' : 'Mark as end'),
        h('button', { class: 'k-btn danger', type: 'button', onclick: () => ops.deleteNode(name) }, 'Delete')),
      h('h3', {}, `Leads to (${outs.length})`),
      h('div', { class: 'sf-list' }, outs.length ? outs.map((e) => li(e, 'out')) : h('div', { class: 'sf-empty' }, n.status === 'end' ? 'None: marked as an end screen.' : 'None: the user is stuck here.')),
      h('div', { class: 'sf-add' }, tgt, lab, add),
      h('h3', {}, `Comes from (${ins.length})`),
      h('div', { class: 'sf-list' }, ins.length ? ins.map((e) => li(e, 'in')) : h('div', { class: 'sf-empty' }, isStart ? 'Nothing: it is where the app opens.' : 'Nothing leads here.')));
  }

  function drawSource() {
    if (document.activeElement !== ta && ta.value !== (ctx.raw.flow ?? '')) ta.value = ctx.raw.flow ?? '';
    if (document.activeElement !== pkgIn) pkgIn.value = ctx.raw.pkg ?? '';
    const r = ctx.result || {};
    msgs.replaceChildren(...(r.warnings?.length ? [h('div', { class: 'k-warns' }, r.warnings.map((w) => h('div', {}, w)))] : []));
  }

  function drawAll() { drawChips(); drawMap(); drawRoute(); drawInspector(); drawSource(); }

  const ro = new ResizeObserver(() => { if (!state.link) drawMap(); });
  ro.observe(box);
  let first = true;
  ctx.onResult(() => {
    const g = G();
    if (first && g) {
      first = false;
      const goal = clean(String(ctx.raw.goal ?? ''));
      if (goal && nodeOf(goal)) state.sel = { type: 'node', name: goal };
    }
    const goal = clean(String(ctx.raw.goal ?? ''));
    if (state.sel?.type !== 'edge' && goal && nodeOf(goal)) state.sel = { type: 'node', name: goal };
    if (state.sel?.type === 'node' && !nodeOf(state.sel.name)) state.sel = null;
    drawAll();
  });
}
