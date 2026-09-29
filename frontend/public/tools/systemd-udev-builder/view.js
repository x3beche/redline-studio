// systemd Unit & udev Rule Builder, drawn as the things themselves.
//
// Unit mode: the unit's place in the boot, left to right in start order -
// what it comes after, what it pulls in (Wants/Requires/BindsTo) and which
// target pulls it in - above the unit file itself, with each finding marked
// on its line and on the node it is about. Click a node to change how the
// unit relates to it (After, Wants, BindsTo ...), add a unit from the
// palette, flip Type/Restart and the sandbox switches: every change is an
// edit of the file text, and the file is what gets checked.
//
// udev mode: the device and its parents as `udevadm info -a` walks them,
// every key a chip. Click chips to build the rule; parent keys are kept on
// one parent, as udev requires, and the rule is written beside the chain.
// Everything drawn comes from run()'s result.draw.

import { setKey, listAdd, listRemove } from './unitfile.js';

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
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const rc = (el, ...k) => el.replaceChildren(...k.flat().filter((x) => x != null && x !== false));
const clip = (t, n) => (t.length > n ? t.slice(0, Math.max(1, n - 1)) + '…' : t);

const TYPES = ['simple', 'exec', 'forking', 'oneshot', 'notify'];
const RESTARTS = ['no', 'on-failure', 'on-abnormal', 'always'];
const REL = [
  ['After', 'Unit', 'order: start after it'], ['Before', 'Unit', 'order: start before it'],
  ['Wants', 'Unit', 'pull it in, survive its failure'], ['Requires', 'Unit', 'pull it in, stop if it stops'],
  ['BindsTo', 'Unit', 'like Requires, and stop when it goes away'], ['PartOf', 'Unit', 'stop/restart with it'],
  ['Conflicts', 'Unit', 'never run together'],
];
const INSTALL = [['WantedBy', 'Install', 'enable links it into this target'], ['RequiredBy', 'Install', 'enable: target requires it']];
const PALETTE = ['network-online.target', 'time-sync.target', 'local-fs.target', 'remote-fs.target', 'mosquitto.service', 'dbus.service',
  'systemd-udev-settle.service', 'dev-ttyUSB0.device', 'sys-subsystem-net-devices-can0.device'];
const EDGE = {
  order: { cls: 'e-order', label: '' },
  wants: { cls: 'e-wants', label: 'Wants' }, requires: { cls: 'e-req', label: 'Requires' }, requisite: { cls: 'e-req', label: 'Requisite' },
  bindsto: { cls: 'e-binds', label: 'BindsTo' }, partof: { cls: 'e-part', label: 'PartOf' }, upholds: { cls: 'e-wants', label: 'Upholds' },
  conflicts: { cls: 'e-conf', label: 'Conflicts' },
};

export function page(root, ctx) {
  const wrap = h('div', { class: 'sub' });
  root.append(wrap);
  let res = null, sel = null, typing = null, notice = '', focusChip = null;

  // ---------- top bar: the mode ----------
  const modeSeg = h('span', { class: 'seg big', role: 'group', 'aria-label': 'Mode' },
    [['unit', 'systemd unit'], ['udev', 'udev rule']].map(([v, t]) => h('button', { type: 'button', 'data-v': v, onclick: () => { if (ctx.raw.mode !== v) ctx.set('mode', v); } }, t)));
  const nameIn = h('input', { type: 'text', spellcheck: 'false', class: 'mono', 'aria-label': 'Unit file name',
    oninput: (e) => { clearTimeout(typing); const v = e.target.value; typing = setTimeout(() => ctx.set('unitName', v), 250); } });
  const top = h('div', { class: 'sub-top' }, modeSeg, h('label', { class: 'nm u-only' }, 'File', nameIn));

  // ================= UNIT =================
  const graphSvg = s('svg', { class: 'sub-graph', role: 'group', 'aria-label': 'Boot order and dependencies' });
  const graphHead = h('div', { class: 'sub-head' });
  const insp = h('div', { class: 'sub-insp' });
  const addIn = h('input', { type: 'text', spellcheck: 'false', class: 'mono add', placeholder: 'unit name, e.g. redis.service', 'aria-label': 'Add a dependency',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addUnit(addIn.value.trim()); addIn.value = ''; } } });
  const palette = h('div', { class: 'sub-pal' });
  const graphCard = h('section', { class: 'sub-card' }, graphHead, h('div', { class: 'sub-graphwrap' }, graphSvg), insp,
    h('div', { class: 'sub-addrow' }, h('span', { class: 'lab' }, 'Add'), addIn, palette),
    h('div', { class: 'sub-legend' },
      h('span', {}, h('i', { class: 'ln e-order' }), 'starts after (order)'), h('span', {}, h('i', { class: 'ln e-wants' }), 'Wants'),
      h('span', {}, h('i', { class: 'ln e-req' }), 'Requires'), h('span', {}, h('i', { class: 'ln e-binds' }), 'BindsTo'),
      h('span', {}, h('i', { class: 'ln e-conf' }), 'Conflicts'), h('span', {}, h('i', { class: 'ln e-imp' }), 'implicit'),
      h('span', { class: 'keys' }, 'Click a unit (or Tab to it, Enter) to change how this unit relates to it; the file below follows.')));

  const quick = h('div', { class: 'sub-quick' });
  const hardBox = h('div', { class: 'sub-hard', role: 'group', 'aria-label': 'Sandboxing' });
  const gutter = h('div', { class: 'gut', 'aria-hidden': 'true' });
  const ta = h('textarea', { class: 'code', spellcheck: 'false', wrap: 'off', 'aria-label': 'Unit file',
    oninput: (e) => { clearTimeout(typing); const v = e.target.value; drawGutter(); typing = setTimeout(() => ctx.set('unit', v), 300); } });
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
  const editorCard = h('section', { class: 'sub-card' },
    h('div', { class: 'sub-head' }, h('h2', {}, 'Unit file'), h('span', { class: 'sub-sub' }, 'edit here or with the switches; markers show findings on their line')),
    quick, hardBox, h('div', { class: 'sub-editor' }, gutter, ta));
  const findBox = h('section', { class: 'sub-card find' });
  const unitMain = h('div', { class: 'sub-col main u-only' }, graphCard, editorCard);

  // ================= UDEV =================
  const chain = h('div', { class: 'sub-chain', role: 'grid', 'aria-label': 'Device chain; Space picks a key' });
  const chainHead = h('div', { class: 'sub-head' });
  const infoTa = h('textarea', { class: 'code small', spellcheck: 'false', wrap: 'off', rows: 8, 'aria-label': 'udevadm info -a output',
    placeholder: "udevadm info -a -n /dev/ttyUSB0",
    oninput: (e) => { clearTimeout(typing); const v = e.target.value; typing = setTimeout(() => ctx.set('udevInfo', v), 300); } });
  infoTa.addEventListener('dragover', (e) => e.preventDefault());
  infoTa.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) f.text().then((t) => { infoTa.value = t; ctx.set('udevInfo', t); }); });
  const infoDet = h('details', { class: 'sub-paste' }, h('summary', {}, 'Paste ', h('code', {}, 'udevadm info -a -n /dev/…'), ' output'), infoTa);
  const chainCard = h('section', { class: 'sub-card' }, chainHead, infoDet, chain,
    h('div', { class: 'sub-legend' }, h('span', {}, h('i', { class: 'ch pick' }), 'in the rule'), h('span', {}, h('i', { class: 'ch good' }), 'stable id'),
      h('span', {}, h('i', { class: 'ch vol' }), 'changes on replug'),
      h('span', { class: 'keys' }, 'Click a key to match on it. Keys of the device itself (KERNEL, SUBSYSTEM, ATTR) and keys of ONE parent (KERNELS, SUBSYSTEMS, DRIVERS, ATTRS) can be combined. ',
        h('kbd', {}, '←'), h('kbd', {}, '→'), h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' move, ', h('kbd', {}, 'Space'), ' picks.')));
  const ruleBox = h('div', { class: 'sub-rule', 'aria-live': 'polite' });
  const fields = {};
  const fld = (key, label, ph, cls) => {
    const el = h('input', { type: 'text', spellcheck: 'false', class: `mono ${cls || ''}`, placeholder: ph || '',
      oninput: (e) => { clearTimeout(typing); const v = e.target.value; typing = setTimeout(() => ctx.set(key, v), 250); } });
    fields[key] = el;
    return h('label', {}, label, el);
  };
  const chk = (key, label) => {
    const el = h('input', { type: 'checkbox', onchange: (e) => ctx.set(key, e.target.checked) });
    fields[key] = el;
    return h('label', { class: 'chk' }, el, label);
  };
  const assignCard = h('section', { class: 'sub-card' }, h('div', { class: 'sub-head' }, h('h2', {}, 'Rule')), ruleBox,
    h('div', { class: 'sub-assign' },
      fld('symlink', 'SYMLINK+=', 'gps'), fld('perm', 'MODE=', '0660', 'short'), fld('group', 'GROUP=', 'dialout'), fld('owner', 'OWNER=', ''),
      fld('wants', 'ENV{SYSTEMD_WANTS}+=', 'my.service', 'wide'), fld('ruleFile', 'Rules file', '99-local.rules', 'wide'),
      chk('tagSystemd', 'TAG+="systemd"'), chk('actionAdd', 'only ACTION=="add"')));
  const udevMain = h('div', { class: 'sub-col main d-only' }, chainCard);

  const warnBox = h('div', { class: 'sub-warns', role: 'status', 'aria-live': 'polite' });
  const side = h('div', { class: 'sub-col side' }, h('div', { class: 'd-only' }, assignCard), findBox, warnBox, ctx.outputs);
  wrap.append(top, h('div', { class: 'sub-grid' }, unitMain, udevMain, side));

  // ================= unit: editing =================
  const edit = (fn) => { const t = fn(ctx.raw.unit ?? ''); ta.value = t; ctx.set('unit', t); };
  function toggleRel(unit, key, section, on) {
    edit((t) => (on ? listAdd(t, section, key, unit) : listRemove(t, section, key, unit)));
  }
  function addUnit(u) {
    if (!u || !/^[\w@:.\\-]+\.(service|target|socket|device|mount|path|timer|slice|scope|swap|automount)$/.test(u)) {
      notice = u ? `"${u}" is not a unit name (it needs a suffix like .service or .target).` : ''; drawInspector(); return;
    }
    const isTarget = /\.target$/.test(u);
    edit((t) => {
      let x = t;
      if (!(isTarget && /^(network|time-sync|nss-lookup|time-set)\b/.test(u) && u !== 'network-online.target')) x = listAdd(x, 'Unit', 'Wants', u);
      return listAdd(x, 'Unit', 'After', u);
    });
    sel = u; notice = '';
  }

  function drawQuick(d) {
    const seg = (label, opts, cur, key, dflt) => h('span', { class: 'q' }, h('span', { class: 'lab' }, label),
      h('span', { class: 'seg', role: 'group', 'aria-label': label }, opts.map((o) => h('button', { type: 'button', 'aria-pressed': String(cur === o),
        onclick: () => edit((t) => setKey(t, 'Service', key, o === dflt && key === 'Type' ? o : o)) }, o))));
    const rs = h('input', { type: 'text', class: 'mono short', value: '', 'aria-label': 'RestartSec', placeholder: '100ms',
      onchange: (e) => edit((t) => setKey(t, 'Service', 'RestartSec', e.target.value.trim() || null)) });
    const user = h('input', { type: 'text', class: 'mono', 'aria-label': 'User', placeholder: 'root',
      onchange: (e) => edit((t) => setKey(t, 'Service', 'User', e.target.value.trim() || null)) });
    const cur = (k) => { const m = new RegExp(`^\\s*${k}\\s*=\\s*(.*)$`, 'm').exec(ctx.raw.unit || ''); return m ? m[1].trim() : ''; };
    rs.value = cur('RestartSec'); user.value = cur('User');
    rc(quick, seg('Type', TYPES.includes(d.type) ? TYPES : [...TYPES, d.type], d.type, 'Type', 'simple'),
      seg('Restart', RESTARTS.includes(d.restart) ? RESTARTS : [...RESTARTS, d.restart], d.restart, 'Restart', 'no'),
      h('label', { class: 'q' }, h('span', { class: 'lab' }, 'RestartSec'), rs), h('label', { class: 'q' }, h('span', { class: 'lab' }, 'User'), user));
    const on = d.hard.filter((x) => x.on).length;
    rc(hardBox, h('span', { class: 'hh' }, 'Sandbox ', h('b', {}, `${on}/${d.hard.length}`)),
      ...d.hard.map((x) => h('button', { type: 'button', class: 'hsw', 'aria-pressed': String(x.on), title: `${x.key}=${x.want}: ${x.what}${x.value && !x.on ? ` (now ${x.value})` : ''}`,
        onclick: () => edit((t) => setKey(t, 'Service', x.key, x.on ? null : x.want)) }, h('i', {}), x.key)));
  }

  function drawGutter() {
    const d = res?.draw;
    const n = (ta.value.match(/\n/g) || []).length + 1;
    const by = {};
    for (const f of d?.findings || []) if (f.line) (by[f.line] ||= []).push(f);
    const rows = [];
    for (let i = 1; i <= n; i++) {
      const fs = by[i] || [];
      const sev = fs.some((f) => f.sev === 'error') ? 'error' : fs.some((f) => f.sev === 'warn') ? 'warn' : fs.length ? 'note' : '';
      rows.push(h('div', { class: `gl ${sev}`, title: fs.map((f) => f.msg).join('\n') || null }, h('span', { class: 'mk' }), String(i)));
    }
    rc(gutter, ...rows);
    gutter.scrollTop = ta.scrollTop;
  }
  function gotoLine(line) {
    if (!line) return;
    const lines = ta.value.split('\n');
    let a = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) a += lines[i].length + 1;
    ta.focus();
    ta.setSelectionRange(a, a + (lines[line - 1] || '').length);
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 17;
    ta.scrollTop = Math.max(0, (line - 4) * lh);
  }

  // ---------- the graph ----------
  function drawGraph(d) {
    const g = d.graph;
    const hadFocus = graphSvg.contains(document.activeElement) ? document.activeElement.getAttribute('data-id') : null;
    rc(graphSvg, );
    const W = Math.max(300, Math.floor(graphSvg.parentNode.clientWidth || 800));
    // wide: boot order runs left to right, one column per step; narrow: top
    // to bottom, one row per step
    const vert = W < 600;
    const layers = [...new Set(g.nodes.map((n) => n.layer))].sort((a, b) => a - b);
    const cols = layers.map((l) => g.nodes.filter((n) => n.layer === l).sort((a, b) => (a.self ? -1 : b.self ? 1 : a.id < b.id ? -1 : 1)));
    const nodeH = 34, gapY = 30, padTop = vert ? 22 : 30;
    const maxRows = Math.max(...cols.map((c) => c.length), 1);
    let nodeW, H;
    const pos = {};
    if (!vert) {
      nodeW = Math.min(190, Math.max(96, (W - 30) / Math.max(1, layers.length) - 30));
      H = padTop + maxRows * nodeH + (maxRows - 1) * gapY + 44;
      const colX = (i) => 12 + (layers.length <= 1 ? (W - 24 - nodeW) / 2 : (i * (W - 24 - nodeW)) / (layers.length - 1));
      cols.forEach((col, ci) => {
        const total = col.length * nodeH + (col.length - 1) * gapY;
        const y0 = padTop + (maxRows * nodeH + (maxRows - 1) * gapY - total) / 2;
        col.forEach((n, ri) => { pos[n.id] = { x: colX(ci), y: y0 + ri * (nodeH + gapY), w: nodeW, n }; });
      });
    } else {
      const gx = 10, rowGap = 40, side = 34;
      nodeW = 0;
      H = padTop + layers.length * nodeH + (layers.length - 1) * rowGap + 24;
      cols.forEach((row, ri) => {
        const w = Math.min(200, (W - 2 * side - (row.length - 1) * gx) / row.length);
        const total = row.length * w + (row.length - 1) * gx;
        const x0 = (W - total) / 2;
        row.forEach((n, ci) => { pos[n.id] = { x: x0 + ci * (w + gx), y: padTop + ri * (nodeH + rowGap), w, n }; });
      });
    }
    graphSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    graphSvg.setAttribute('height', H);
    // boot-time axis
    if (!vert) {
      graphSvg.append(s('line', { x1: 12, x2: W - 12, y1: H - 16, y2: H - 16, class: 'axis' }));
      graphSvg.append(s('path', { d: `M${W - 18},${H - 20} L${W - 12},${H - 16} L${W - 18},${H - 12}`, class: 'axis' }));
      graphSvg.append(s('text', { x: 14, y: H - 4, class: 'soft small' }, 'earlier in boot'));
      graphSvg.append(s('text', { x: W - 14, y: H - 4, class: 'soft small', 'text-anchor': 'end' }, 'later'));
    } else {
      graphSvg.append(s('line', { x1: 8, x2: 8, y1: 14, y2: H - 8, class: 'axis' }));
      graphSvg.append(s('path', { d: `M4,${H - 14} L8,${H - 8} L12,${H - 14}`, class: 'axis' }));
      graphSvg.append(s('text', { x: 14, y: 12, class: 'soft small' }, 'earlier in boot'));
    }
    const defs = s('defs');
    for (const k of ['order', 'wants', 'req', 'binds', 'conf', 'part', 'imp']) {
      const m = s('marker', { id: `ar-${k}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      m.append(s('path', { d: 'M0,0 L8,4 L0,8 z', class: `mk-${k}` }));
      defs.append(m);
    }
    graphSvg.append(defs);
    // edges
    const pairs = {};
    for (const e of g.edges) {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) continue;
      const k = [e.from, e.to].sort().join('|');
      const idx = (pairs[k] = (pairs[k] ?? -1) + 1);
      const info = EDGE[e.kind] || EDGE.order;
      let x1, y1, x2, y2, dpath, lx, ly;
      const span = Math.abs(a.n.layer - b.n.layer) > 1;
      if (vert) {
        const down = b.y > a.y + 1, sameRow = Math.abs(b.y - a.y) < 1;
        const off = idx ? (idx % 2 ? -10 : 10) : 0;
        if (sameRow) {
          x1 = a.x + a.w / 2; y1 = a.y + nodeH; x2 = b.x + b.w / 2; y2 = b.y + nodeH;
          const bulge = 20 + idx * 10;
          dpath = `M${x1},${y1} C${x1},${y1 + bulge} ${x2},${y2 + bulge} ${x2},${y2}`;
          lx = (x1 + x2) / 2; ly = y1 + bulge * 0.75 + 8;
        } else {
          x1 = a.x + a.w / 2 + off; y1 = down ? a.y + nodeH : a.y;
          x2 = b.x + b.w / 2 + off; y2 = down ? b.y : b.y + nodeH;
          const push = span ? ((a.w + 10) / 2 + 4) / 0.75 * (a.x + a.w / 2 > W / 2 ? 1 : -1) : e.kind === 'order' ? 0 : (down ? 1 : -1) * (16 + idx * 10);
          const my = (y1 + y2) / 2;
          dpath = `M${x1},${y1} C${x1 + push},${my} ${x2 + push},${my} ${x2},${y2}`;
          lx = (x1 + x2) / 2 + push * 0.75; ly = my + 3;
        }
      } else {
        const fwd = b.x > a.x + 1;
        const same = Math.abs(b.x - a.x) < 1;
        if (same) {
          x1 = a.x + a.w; y1 = a.y + nodeH / 2; x2 = b.x + b.w; y2 = b.y + nodeH / 2;
          const bulge = 26 + idx * 12;
          dpath = `M${x1},${y1} C${x1 + bulge},${y1} ${x2 + bulge},${y2} ${x2},${y2}`;
          lx = Math.max(x1, x2) + bulge * 0.75; ly = (y1 + y2) / 2;
        } else {
          x1 = fwd ? a.x + a.w : a.x; y1 = a.y + nodeH / 2 + (idx ? (idx % 2 ? -8 : 8) : 0);
          x2 = fwd ? b.x : b.x + b.w; y2 = b.y + nodeH / 2 + (idx ? (idx % 2 ? -8 : 8) : 0);
          // an edge that skips a column bows through the gap between rows so
          // it does not run under the nodes in between
          const lift = span ? -((nodeH + gapY) / 2 + 2) / 0.75 - idx * 8
            : e.kind === 'order' ? 0 : (fwd ? -1 : 1) * (18 + idx * 10);
          const mx = (x1 + x2) / 2;
          dpath = `M${x1},${y1} C${mx},${y1 + lift} ${mx},${y2 + lift} ${x2},${y2}`;
          lx = mx; ly = (y1 + y2) / 2 + lift * 0.75;
        }
      }
      const cls = `edge ${info.cls}${e.implicit ? ' imp' : ''}`;
      const mk = e.implicit ? 'imp' : info.cls.replace('e-', '');
      graphSvg.append(s('path', { d: dpath, class: cls, 'marker-end': `url(#ar-${mk})` }));
      if (info.label) {
        const t = s('text', { x: Math.max(26, Math.min(W - 26, lx)), y: ly - 3, class: `elab ${info.cls}${e.implicit ? ' imp' : ''}`, 'text-anchor': 'middle' }, e.implicit ? info.label.toLowerCase() : info.label);
        graphSvg.append(t);
      }
    }
    // nodes
    const errs = (id) => d.findings.filter((f) => f.sev !== 'note' && f.msg.includes(id));
    for (const { x, y, w: nodeW, n } of Object.values(pos)) {
      const implicitOnly = n.how.length && n.how.every((w) => w === 'default' || w === 'dbus');
      const grp = s('g', { class: `node${n.self ? ' self' : ''}${sel === n.id ? ' sel' : ''}${implicitOnly ? ' imp' : ''}`, tabindex: '0', role: 'button', 'data-id': n.id,
        'aria-label': n.self ? `${n.id}: this unit` : `${n.id}: ${n.how.join(', ') || 'boot chain'}` });
      grp.append(s('rect', { x, y, width: nodeW, height: nodeH, rx: n.type === 'target' ? 14 : 5, class: 'nb' }));
      grp.append(s('rect', { x: x - 3, y: y - 3, width: nodeW + 6, height: nodeH + 6, rx: n.type === 'target' ? 16 : 7, class: 'ring' }));
      const label = clip(n.id, Math.floor((nodeW - 14) / 6.6));
      grp.append(s('text', { x: x + nodeW / 2, y: y + (n.self ? 14 : 15), 'text-anchor': 'middle', class: n.self ? 'nt big' : 'nt' }, label));
      const sub = n.self ? `${d.type}${d.restart !== 'no' ? ' · restart ' + d.restart : ''}${d.user ? ' · ' + d.user : ''}` : (n.how.filter((w) => w !== 'default').join(' · ') || (implicitOnly ? 'implicit' : 'boot chain'));
      grp.append(s('text', { x: x + nodeW / 2, y: y + (n.self ? 27 : 28), 'text-anchor': 'middle', class: 'ns' }, clip(n.self ? sub : (implicitOnly ? 'implicit (DefaultDependencies)' : sub), Math.floor((nodeW - 8) / 5.6))));
      const bad = n.self ? d.findings.filter((f) => f.sev !== 'note') : errs(n.id);
      if (bad.length) {
        const sev = bad.some((f) => f.sev === 'error') ? 'error' : 'warn';
        grp.append(s('circle', { cx: x + nodeW - 2, cy: y + 2, r: 8, class: `badge ${sev}` }));
        grp.append(s('text', { x: x + nodeW - 2, y: y + 5.5, 'text-anchor': 'middle', class: 'bt' }, String(bad.length)));
      }
      const tt = s('title'); tt.textContent = [n.id, ...bad.map((f) => f.msg)].join('\n'); grp.append(tt);
      grp.addEventListener('click', () => { sel = n.id; notice = ''; drawGraph(d); drawInspector(); });
      grp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sel = n.id; drawGraph(d); drawInspector(); insp.querySelector('button')?.focus(); } });
      graphSvg.append(grp);
    }
    if (hadFocus) graphSvg.querySelector(`[data-id="${CSS.escape(hadFocus)}"]`)?.focus({ preventScroll: true });
    rc(graphHead, h('h2', {}, 'Boot order and dependencies'),
      h('span', { class: 'sub-sub' }, `${g.nodes.length - 1} related unit${g.nodes.length === 2 ? '' : 's'} · `,
        d.rel.WantedBy.length || d.rel.RequiredBy.length ? h('span', {}, 'started by ', h('b', {}, [...d.rel.WantedBy, ...d.rel.RequiredBy].join(', '))) : h('b', { class: 'c-warn' }, 'nothing starts it at boot')));
  }

  function drawInspector() {
    const d = res?.draw;
    if (!d || d.mode !== 'unit') return;
    const n = d.graph.nodes.find((x) => x.id === sel);
    if (!n) {
      rc(insp, h('span', { class: 'hint' }, notice || 'Select a unit in the graph to set its relation to ', h('b', {}, d.name), '.'));
      return;
    }
    if (n.self) {
      rc(insp, h('b', { class: 'mono' }, n.id), h('span', { class: 'hint' }, ' this unit. Pick another node to change a relation, or add one below.'));
      return;
    }
    const on = (k) => (d.rel[k] || []).includes(n.id);
    const btn = ([k, sec, tip]) => h('button', { type: 'button', class: 'rel', 'aria-pressed': String(on(k)), title: `${k}=${n.id}: ${tip}`,
      onclick: () => { toggleRel(n.id, k, sec, !on(k)); } }, k);
    const isTarget = n.type === 'target';
    const implicit = n.how.every((w) => w === 'default' || w === 'dbus');
    rc(insp, 
      h('b', { class: 'mono' }, n.id),
      implicit ? h('span', { class: 'hint' }, ' implicit: DefaultDependencies=yes adds it. ') : null,
      h('span', { class: 'rels', role: 'group', 'aria-label': `Relations to ${n.id}` }, REL.map(btn)),
      isTarget ? h('span', { class: 'rels', role: 'group', 'aria-label': '[Install]' }, h('span', { class: 'lab' }, '[Install]'), INSTALL.map(btn)) : null,
      (n.how.length && !implicit) ? h('button', { type: 'button', class: 'k-btn', onclick: () => {
        edit((t) => { let x = t; for (const [k, sec] of [...REL, ...INSTALL]) x = listRemove(x, sec, k, n.id); return x; });
        sel = null;
      } }, 'Remove') : null,
      notice ? h('span', { class: 'hint warn' }, notice) : null);
  }

  function drawPalette(d) {
    const have = new Set(d.graph.nodes.map((n) => n.id));
    rc(palette, ...PALETTE.filter((u) => !have.has(u)).slice(0, 6).map((u) => h('button', { type: 'button', class: 'pchip', title: `Add Wants= and After=${u}`, onclick: () => addUnit(u) }, '+ ', u)));
  }

  function drawFindings(list, withLines) {
    const c = { error: 0, warn: 0, note: 0 };
    for (const f of list) c[f.sev]++;
    rc(findBox, 
      h('div', { class: 'sub-head' }, h('h2', {}, 'Findings'),
        h('span', { class: 'sub-sub' }, h('b', { class: 'c-bad' }, `${c.error} error${c.error === 1 ? '' : 's'}`), ' · ', h('b', { class: 'c-warn' }, `${c.warn} warning${c.warn === 1 ? '' : 's'}`), ` · ${c.note} note${c.note === 1 ? '' : 's'}`)),
      list.length ? h('ol', { class: 'flist' }, list.map((f) => h('li', { class: f.sev },
        withLines && f.line ? h('button', { type: 'button', class: 'ln', title: 'Show this line', onclick: () => gotoLine(f.line) }, `L${f.line}`) : h('span', { class: 'ln none' }, withLines ? '–' : ''),
        h('span', { class: 'sv' }, f.sev === 'error' ? 'error' : f.sev === 'warn' ? 'warning' : 'note'), h('span', { class: 'fm' }, f.msg))))
        : h('div', { class: 'ok' }, 'Nothing to report.'));
  }

  // ================= udev =================
  const picksList = () => String(ctx.raw.udevPick || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const tokenOf = (k) => `${k.key}=="${k.value}"`;
  function togglePick(level, k, d) {
    let list = picksList();
    const tok = tokenOf(k);
    notice = '';
    if (list.includes(tok)) list = list.filter((x) => x !== tok);
    else {
      if (level > 0) {
        // udev: all parent keys of one rule match on the same parent
        const others = d.picks.filter((p) => p.parentKey && !p.levels.includes(level));
        if (others.length) {
          const drop = new Set(others.map((p) => `${p.key}${p.op}"${p.value}"`));
          list = list.filter((x) => !drop.has(x));
          notice = `Moved the parent match to #${level}: ${others.map((p) => p.key).join(', ')} came from another parent, and udev matches parent keys on one parent only.`;
        }
      }
      list.push(tok);
    }
    focusChip = `${level}|${k.key}`;
    ctx.set('udevPick', list.join('\n'));
  }

  function drawChain(d) {
    const hadFocus = chain.contains(document.activeElement);
    rc(chain, );
    const picked = new Set(d.picks.map((p) => `${p.key}|${p.value}`));
    const pickedAt = (b, k) => picked.has(`${k.key}|${k.value}`) && d.picks.some((p) => p.key === k.key && p.value === k.value && p.levels.includes(b.level));
    const lastPick = Math.max(0, ...d.picks.flatMap((p) => p.levels));
    d.blocks.forEach((b) => {
      const kern = b.keys.find((k) => /^KERNELS?$/.test(k.key))?.value || '';
      const subs = b.keys.find((k) => /^SUBSYSTEMS?$/.test(k.key))?.value || '';
      const drv = b.keys.find((k) => /^DRIVERS?$/.test(k.key))?.value || '';
      const nPick = b.keys.filter((k) => pickedAt(b, k)).length;
      const isParent = d.parentLevel === b.level && b.level > 0;
      const stray = b.level > 0 && nPick && d.parentLevel !== b.level;
      const far = b.level > Math.max(lastPick, 3) + 1 && !nPick;
      const blk = h('div', { class: `blk${b.level === 0 ? ' dev' : ''}${isParent ? ' matched' : ''}${stray ? ' stray' : ''}${far ? ' far' : ''}` },
        h('div', { class: 'bh' },
          h('span', { class: 'lv' }, `#${b.level}`),
          h('b', { class: 'mono' }, kern || (b.env ? 'properties' : '?')),
          subs ? h('span', { class: 'sb' }, subs) : null,
          drv ? h('span', { class: 'dr' }, `driver ${drv}`) : null,
          b.level === 0 ? h('span', { class: 'tagx' }, 'the device') : null,
          isParent ? h('span', { class: 'tagx ok' }, 'parent keys match here') : null,
          stray ? h('span', { class: 'tagx bad' }, 'second parent: rule never fires') : null,
          h('span', { class: 'path mono', title: b.path }, clip(b.path.split('/').slice(-2).join('/'), 44))),
        h('div', { class: 'keys' }, b.keys.map((k) => {
          const on = pickedAt(b, k);
          const empty = k.value === '' || k.value === '(null)' || k.value === '(not readable)';
          return h('button', { type: 'button', class: `kc${on ? ' pick' : ''}${k.volatile ? ' vol' : ''}${k.good ? ' good' : ''}${empty ? ' blank' : ''}`, tabindex: '-1',
            'data-chip': `${b.level}|${k.key}`, 'aria-pressed': String(on),
            title: `${k.key}=="${k.value}"${k.volatile ? '\nchanges on replug or reboot - avoid' : ''}${k.good ? '\nstable identifier' : ''}`,
            onclick: () => togglePick(b.level, k, d) },
          h('span', { class: 'kk' }, k.key.replace(/^(ATTRS?|ENV)\{(.*)\}$/, (m, a, b) => (a === 'ENV' ? `ENV ${b}` : b))),
          h('span', { class: 'kv' }, k.value === '' ? '""' : clip(k.value, 34)));
        })));
      if (far) blk.addEventListener('click', () => blk.classList.remove('far'), { once: true });
      chain.append(blk);
    });
    if (!d.blocks.length) chain.append(h('div', { class: 'empty' }, 'Paste the output of ', h('code', {}, 'udevadm info -a -n /dev/ttyUSB0'), ' above.'));
    const chips = [...chain.querySelectorAll('.kc')];
    const target = (focusChip && chain.querySelector(`[data-chip="${CSS.escape(focusChip)}"]`)) || chain.querySelector('.kc.pick') || chips[0];
    if (target) target.tabIndex = 0;
    if (hadFocus && target) target.focus({ preventScroll: true });
    const dev = d.blocks[0];
    rc(chainHead, h('h2', {}, 'Device chain'),
      h('span', { class: 'sub-sub' }, dev ? [h('b', { class: 'mono' }, `/dev/${dev.keys.find((k) => k.key === 'KERNEL')?.value || '?'}`), ` and ${d.blocks.length - 1} parent${d.blocks.length === 2 ? '' : 's'}`] : 'nothing read',
        d.unread ? h('b', { class: 'c-warn' }, ` · ${d.unread} lines unread`) : null));
  }
  chain.addEventListener('keydown', (e) => {
    const chips = [...chain.querySelectorAll('.kc')];
    const i = chips.indexOf(document.activeElement);
    if (i < 0) return;
    const go = (j) => { e.preventDefault(); const t = chips[Math.max(0, Math.min(chips.length - 1, j))]; for (const c of chips) c.tabIndex = -1; t.tabIndex = 0; t.focus(); t.closest('.blk')?.classList.remove('far'); };
    const r0 = chips[i].getBoundingClientRect();
    const vert = (dir) => {
      // the nearest chip on the next row in that direction
      let best = null, bd = Infinity;
      for (const [j, c] of chips.entries()) {
        const r = c.getBoundingClientRect();
        if (dir > 0 ? r.top <= r0.top + 2 : r.top >= r0.top - 2) continue;
        const dy = Math.abs(r.top - r0.top), dx = Math.abs(r.left - r0.left);
        const score = dy * 4 + dx;
        if (score < bd) { bd = score; best = j; }
      }
      if (best != null) go(best);
    };
    if (e.key === 'ArrowRight') go(i + 1);
    else if (e.key === 'ArrowLeft') go(i - 1);
    else if (e.key === 'ArrowDown') vert(1);
    else if (e.key === 'ArrowUp') vert(-1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(chips.length - 1);
  });

  function drawRule(d) {
    const picks = picksList();
    rc(ruleBox, 
      h('div', { class: 'file mono' }, `/etc/udev/rules.d/${d.file}`),
      h('div', { class: 'toks' }, d.tokens.length ? d.tokens.map((t, i) => h('span', { class: `tok ${t.kind}${t.ok === false ? ' bad' : ''}` },
        t.t, i < d.tokens.length - 1 ? ',' : '',
        t.kind !== 'assign' && t.key ? h('button', { type: 'button', class: 'x', title: 'Remove this match', 'aria-label': `Remove ${t.t}`,
          onclick: () => ctx.set('udevPick', picks.filter((p) => p.replace(/\s/g, '') !== t.t.replace(/\s/g, '')).join('\n')) }, '×') : null))
        : h('span', { class: 'hint' }, 'Pick keys in the chain to start the rule.')),
      d.unitName ? h('div', { class: 'unitn' }, 'systemd sees it as ', h('b', { class: 'mono' }, d.unitName), ctx.raw.tagSystemd ? '' : ' (with TAG+="systemd")') : null,
      notice ? h('div', { class: 'hint warn' }, notice) : null);
  }

  // ================= sync & draw =================
  function syncFields() {
    const r = ctx.raw;
    const unitMode = r.mode !== 'udev';
    wrap.classList.toggle('m-unit', unitMode);
    wrap.classList.toggle('m-udev', !unitMode);
    for (const b of modeSeg.children) b.setAttribute('aria-pressed', String(b.dataset.v === (unitMode ? 'unit' : 'udev')));
    if (document.activeElement !== nameIn) nameIn.value = r.unitName ?? '';
    if (document.activeElement !== ta && ta.value !== (r.unit ?? '')) ta.value = r.unit ?? '';
    if (document.activeElement !== infoTa && infoTa.value !== (r.udevInfo ?? '')) infoTa.value = r.udevInfo ?? '';
    for (const [k, el] of Object.entries(fields)) {
      if (el.type === 'checkbox') el.checked = !!r[k];
      else if (document.activeElement !== el) el.value = r[k] ?? '';
    }
  }

  let firstTab = false;
  try { firstTab = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`) == null; } catch { /* ignore */ }
  let lastMode = null;
  ctx.onResult((r) => {
    res = r;
    syncFields();
    const d = r.draw;
    if (!d) return;
    if (d.mode === 'unit') {
      if (sel && !d.graph.nodes.some((n) => n.id === sel)) sel = null;
      drawGraph(d); drawInspector(); drawPalette(d); drawQuick(d); drawGutter();
      drawFindings(d.findings, true);
    } else {
      drawChain(d); drawRule(d);
      drawFindings(d.findings, false);
    }
    rc(warnBox, );
    if ((firstTab || lastMode !== d.mode) && lastMode !== null) ctx.outputs.querySelector('.k-tab')?.click();
    if (firstTab) { firstTab = false; ctx.outputs.querySelector('.k-tab')?.click(); }
    lastMode = d.mode;
  });
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (res?.draw?.mode === 'unit') drawGraph(res.draw); }, 120); });
}
