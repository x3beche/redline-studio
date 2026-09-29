// DT Overlay Builder, drawn as the thing itself: the base tree on the left
// (click a node to make it the target, toggle a node's status for an extra
// fragment), the target node before and after the overlay side by side in
// DTS form, where the person edits the "after" side directly - the status
// switch, property values in place, new properties, and child nodes added
// from templates and edited in their cards. The overlay source and the line
// that loads it sit beside it, with a real dtc compile on request.
// Everything drawn comes from run()'s result.view; edits go back through
// ctx.set / ctx.setMany.

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

const TEMPLATES = {
  i2c: { name: 'tmp102', compatible: 'ti,tmp102', addr: '0x48', param: '', ref: '', extra: '' },
  spi: { name: 'flash', compatible: 'jedec,spi-nor', addr: '0', param: '20000000', ref: '', extra: '' },
  'gpio-led': { name: 'status', compatible: '', addr: '17', param: 'heartbeat', ref: 'gpio', extra: '' },
  'pwm-led': { name: 'dimmer', compatible: '', addr: '0', param: '1000000', ref: 'pwm', extra: '' },
  uart: { name: 'gnss', compatible: 'u-blox,neo-m8', addr: '', param: '9600', ref: '', extra: '' },
  custom: { name: 'node', compatible: 'vendor,device', addr: '', param: '', ref: '', extra: '' },
};
const FIELDS = { // which card fields each kind uses
  i2c: ['name', 'compatible', 'addr', 'extra'],
  spi: ['name', 'compatible', 'addr', 'param', 'extra'],
  'gpio-led': ['name', 'addr', 'param', 'ref', 'extra'],
  'pwm-led': ['name', 'addr', 'param', 'ref', 'extra'],
  uart: ['name', 'compatible', 'param', 'extra'],
  custom: ['name', 'compatible', 'addr', 'extra'],
};
const DEFAULT_TAB = 'Overlay (&label form)';

export function page(root, ctx) {
  const wrap = h('div', { class: 'dob' });
  root.append(wrap);
  let res = null;
  const collapsed = new Set();
  let autoCollapsed = false;
  let focusKey = null;

  // ---------- tree ----------
  const treeList = h('div', { class: 'dob-tree', role: 'tree', 'aria-label': 'Base tree' });
  const treeSub = h('span', { class: 'dob-sub' });
  const baseArea = h('textarea', { class: 'dob-src', rows: 16, spellcheck: 'false', 'data-k': 'base', 'aria-label': 'Base tree source',
    oninput: (e) => ctx.set('base', e.target.value) });
  const baseErrs = h('div', { class: 'dob-errs' });
  const treeCard = h('section', { class: 'dob-card dob-treecard' },
    h('div', { class: 'dob-head' }, h('h2', {}, 'Base tree'), treeSub),
    treeList,
    h('details', { class: 'dob-base' }, h('summary', {}, 'Base source (paste the board\'s DTS)'), baseArea, baseErrs),
    h('div', { class: 'dob-help' }, 'Click a node to target it. ', h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' move, ',
      h('kbd', {}, 'Enter'), ' target, ', h('kbd', {}, '←'), h('kbd', {}, '→'), ' fold, ', h('kbd', {}, 'D'), ' toggle status in an extra fragment. Each node keeps its own edits while you switch.'));

  // ---------- target node ----------
  const targetIn = h('input', { type: 'text', class: 'dob-target', spellcheck: 'false', 'data-k': 'target', 'aria-label': 'Target',
    oninput: (e) => ctx.set('target', e.target.value) });
  const targetPath = h('span', { class: 'dob-sub' });
  const beforeBox = h('div', { class: 'dob-code dob-before' });
  const afterBox = h('div', { class: 'dob-code dob-after' });
  const addBar = h('div', { class: 'dob-add' });
  const nodeCard = h('section', { class: 'dob-card dob-nodecard' },
    h('div', { class: 'dob-head' }, h('h2', {}, 'Target'), targetIn, targetPath),
    h('div', { class: 'dob-pair' },
      h('div', { class: 'dob-col' }, h('div', { class: 'dob-colhead' }, 'Base'), beforeBox),
      h('div', { class: 'dob-col' }, h('div', { class: 'dob-colhead' }, 'With the overlay applied', h('span', { class: 'dob-legend' },
        h('i', { class: 'lg-new' }), 'added ', h('i', { class: 'lg-chg' }), 'changed')), afterBox, addBar)));

  // ---------- side ----------
  const warns = h('div', { class: 'dob-warns', role: 'status', 'aria-live': 'polite' });
  const frags = h('ol', { class: 'dob-frags' });
  const setIn = (key, label, ph) => h('label', {}, label, h('input', { type: 'text', spellcheck: 'false', 'data-k': key, placeholder: ph || '',
    oninput: (e) => ctx.set(key, e.target.value) }));
  const loaderSel = h('select', { 'data-k': 'loader', onchange: (e) => { ctx.set('loader', e.target.value); pickTab('Load it'); } },
    [['rpi', 'Raspberry Pi config.txt'], ['uboot', 'U-Boot fdt apply'], ['extlinux', 'extlinux.conf fdtoverlays'], ['yocto', 'Yocto recipe']].map(([v, t]) => h('option', { value: v }, t)));
  const checkBtn = h('button', { class: 'k-btn k-primary', onclick: () => check() }, 'Check with dtc');
  const checkOut = h('div', { class: 'dob-check', 'aria-live': 'polite' });
  const settings = h('div', { class: 'dob-set' },
    setIn('name', 'Overlay name'), setIn('compat', 'Root compatible', 'brcm,bcm2711'),
    h('label', {}, 'Loaded by', loaderSel),
    setIn('alsoDisable', 'Also disable', 'spidev0'), setIn('alsoEnable', 'Also enable', 'pwm'));
  const side = h('div', { class: 'dob-side' },
    warns,
    h('section', { class: 'dob-card' }, h('div', { class: 'dob-head' }, h('h2', {}, 'Overlay'), h('span', { class: 'dob-right' }, checkBtn)),
      frags, settings, checkOut),
    ctx.outputs);
  const notes = h('details', { class: 'dob-notes' }, h('summary', {}, 'Notes'));

  wrap.append(treeCard, h('div', { class: 'dob-mid' }, nodeCard, notes), side);

  // ---------- helpers ----------
  const raw = () => ctx.raw;
  const labelsIn = (key) => String(raw()[key] || '').split(/[\s,]+/).map((s) => s.replace(/^&/, '')).filter(Boolean);
  const toggleExtra = (label, status) => {
    // status is what the node is now; the extra fragment flips it
    const dis = labelsIn('alsoDisable'), en = labelsIn('alsoEnable');
    const inDis = dis.includes(label), inEn = en.includes(label);
    if (inDis || inEn) ctx.setMany({ alsoDisable: dis.filter((l) => l !== label).join(', '), alsoEnable: en.filter((l) => l !== label).join(', ') });
    else if (status === 'disabled') ctx.set('alsoEnable', [...en, label].join(', '));
    else ctx.set('alsoDisable', [...dis, label].join(', '));
  };
  const pickTab = (name) => [...ctx.outputs.querySelectorAll('.k-tab')].find((t) => t.textContent === name)?.click();
  const track = (el, key) => { el.setAttribute('data-k', key); return el; };
  // a value field as wide as its text, so the line still reads as DTS
  const fit = (el) => { const w = () => { el.style.width = `${Math.max(4, Math.min(34, (el.value || el.placeholder || "").length))}ch`; }; w(); el.addEventListener('input', w); return el; };

  // ---------- draw: tree ----------
  function drawTree() {
    const v = res.view;
    const tree = v.tree;
    if (!autoCollapsed) {
      autoCollapsed = true;
      // fold pin-group lists (a node whose 3+ children are all leaves), unless the target is inside
      tree.forEach((n, k) => {
        const kids = []; for (let j = k + 1; j < tree.length && tree[j].depth > n.depth; j++) if (tree[j].depth === n.depth + 1) kids.push(tree[j]);
        if (kids.length >= 3 && kids.every((c) => !c.kids) && !kids.some((c) => c.target)) collapsed.add(n.path);
      });
    }
    treeSub.textContent = `${tree.length} node${tree.length === 1 ? '' : 's'}`;
    const rows = [];
    let hideBelow = Infinity;
    for (const n of tree) {
      if (n.depth > hideBelow) continue;
      hideBelow = collapsed.has(n.path) ? n.depth : Infinity;
      const st = n.pending || (n.off ? 'disabled' : 'okay');
      const canToggle = !!n.label && !n.target && (n.status || n.pending);
      const caret = n.kids ? h('span', { class: 'dob-caret', 'aria-hidden': 'true' }, collapsed.has(n.path) ? '▸' : '▾') : h('span', { class: 'dob-caret' });
      const row = h('div', {
        class: `dob-row${n.target ? ' is-target' : ''}${n.off && !n.pending ? ' is-off' : ''}${n.pending ? ' is-pending' : ''}`,
        role: 'treeitem', tabindex: '-1', 'aria-selected': String(n.target), 'aria-expanded': n.kids ? String(!collapsed.has(n.path)) : null,
        style: `padding-left:${6 + n.depth * 13}px`, title: [n.path, n.compat].filter(Boolean).join('\n'),
        onclick: (e) => {
          if (e.target.closest('.dob-caret') && n.kids) { fold(n.path); return; }
          if (e.target.closest('.dob-tog')) return;
          select(n);
        },
        onkeydown: (e) => keys(e, n),
      },
      caret,
      h('i', { class: `dob-dot st-${n.status ? (st === 'okay' ? 'ok' : 'off') : n.off ? 'off' : 'none'}${n.pending ? ` st-${n.pending === 'okay' ? 'ok' : 'off'}` : ''}` }),
      n.label ? h('span', { class: 'dob-label' }, n.label + ':') : null,
      h('span', { class: 'dob-name' }, n.name),
      n.pending ? h('span', { class: `dob-pend ${n.pending === 'okay' ? 'p-ok' : 'p-off'}` }, `→ ${n.pending}`) : null,
      n.adds ? h('span', { class: 'dob-pend p-ok' }, `+${n.adds}`) : null,
      canToggle ? h('button', { class: 'dob-tog', tabindex: '-1', title: `Add a fragment setting &${n.label} ${n.status === 'disabled' && !n.pending ? 'okay' : 'disabled'}`,
        onclick: () => toggleExtra(n.label, n.status) }, n.pending ? 'undo' : n.status === 'disabled' ? 'enable' : 'disable') : null);
      row.dataset.path = n.path;
      rows.push(row);
    }
    const had = treeList.contains(document.activeElement) ? document.activeElement.dataset.path : null;
    treeList.replaceChildren(...rows);
    const cur = rows.find((r) => r.dataset.path === had) || rows.find((r) => r.classList.contains('is-target')) || rows[0];
    if (cur) cur.tabIndex = 0;
    if (had && cur) cur.focus({ preventScroll: true });
  }
  // Picking another node starts that node's edits; the ones made on the
  // node left behind are kept for this session and come back with it.
  const stash = new Map();
  function select(n) {
    const t = n.path === '/' ? '&{/}' : n.label ? `&${n.label}` : `&{${n.path}}`;
    const r = raw();
    if (t === r.target) return;
    stash.set(r.target, { status: r.status, props: r.props, children: r.children });
    const back = stash.get(t) || { status: n.status === 'disabled' || n.off ? 'okay' : 'keep', props: [], children: [] };
    ctx.setMany({ target: t, ...back });
  }
  function fold(path) { if (collapsed.has(path)) collapsed.delete(path); else collapsed.add(path); drawTree(); }
  function keys(e, n) {
    const rows = [...treeList.querySelectorAll('.dob-row')];
    const i = rows.indexOf(e.currentTarget);
    const go = (j) => { const r = rows[Math.max(0, Math.min(rows.length - 1, j))]; rows.forEach((x) => { x.tabIndex = -1; }); r.tabIndex = 0; r.focus(); };
    if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(rows.length - 1); }
    else if (e.key === 'ArrowRight' && n.kids && collapsed.has(n.path)) { e.preventDefault(); fold(n.path); }
    else if (e.key === 'ArrowLeft' && n.kids && !collapsed.has(n.path)) { e.preventDefault(); fold(n.path); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(n); }
    else if ((e.key === 'd' || e.key === 'D') && n.label && !n.target) { e.preventDefault(); toggleExtra(n.label, n.status); }
  }

  // ---------- draw: before / after ----------
  const valueSpan = (v) => h('span', { class: 'dob-v' }, v);
  const nodeHead = (t) => h('div', { class: 'dob-line dob-nodehead' },
    t.label ? h('span', { class: 'dob-label' }, t.label + ':') : null, ' ', h('span', { class: 'dob-name' }, t.nodeName || '?'), ' {');

  function drawBefore(t) {
    if (!t.found) { beforeBox.replaceChildren(h('div', { class: 'dob-miss' }, `${t.name || '(no target)'} is not in the base tree. Pick a node on the left.`)); return; }
    const lines = [nodeHead(t)];
    for (const p of t.before) lines.push(h('div', { class: `dob-line dob-prop${p.name === 'status' && /disabled/.test(p.value) ? ' is-offval' : ''}` },
      h('span', { class: 'dob-k' }, p.name), p.value === '' ? ';' : [' = ', valueSpan(p.value), ';']));
    for (const k of t.baseKids) lines.push(h('div', { class: `dob-line dob-kid${k.off ? ' is-off' : ''}` }, k.label ? h('span', { class: 'dob-label' }, k.label + ':') : null, ` ${k.name} { … };`));
    lines.push(h('div', { class: 'dob-line' }, '};'));
    beforeBox.replaceChildren(...lines);
  }

  function statusSwitch(t) {
    const cur = raw().status || 'keep';
    const baseSt = t.off ? 'disabled' : 'okay';
    const sw = h('span', { class: 'dob-switch', role: 'radiogroup', 'aria-label': 'Target status' },
      [['keep', `keep (${baseSt})`], ['okay', 'okay'], ['disabled', 'disabled']].map(([v, txt]) => h('button', {
        role: 'radio', 'aria-checked': String(cur === v), class: v === 'okay' ? 'sw-ok' : v === 'disabled' ? 'sw-off' : null, 'data-k': `status-${v}`,
        onclick: () => ctx.set('status', v),
        onkeydown: (e) => {
          const order = ['keep', 'okay', 'disabled']; const j = order.indexOf(cur);
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const nx = order[(j + (e.key === 'ArrowRight' ? 1 : 2)) % 3]; focusKey = `status-${nx}`; ctx.set('status', nx); }
        },
      }, txt)));
    return sw;
  }

  function drawAfter(t) {
    const r = raw();
    const props = (r.props || []).map((p) => ({ ...p }));
    const setProps = (rows) => ctx.set('props', rows);
    const idxOf = (name) => props.findIndex((p) => String(p.name).trim() === name);
    const lines = [];
    const head = nodeHead(t);
    head.append(' ', statusSwitch(t));
    lines.push(head);
    for (const p of t.after) {
      if (p.name === 'status') {
        lines.push(h('div', { class: `dob-line dob-prop ch-${p.change}` }, h('span', { class: 'dob-k' }, 'status'), ' = ', valueSpan(p.value), ';',
          p.change === 'changed' ? h('span', { class: 'dob-was' }, `was ${p.was}`) : null));
        continue;
      }
      const k = idxOf(p.name);
      if (p.change === 'new' && k >= 0) continue; // drawn below as an editable name + value row
      const input = track(h('input', { type: 'text', class: 'dob-in', spellcheck: 'false', 'aria-label': `${p.name} value`, value: p.value,
        onchange: (e) => {
          const v = e.target.value.trim();
          const rows = props.map((q) => ({ ...q }));
          const j = rows.findIndex((q) => String(q.name).trim() === p.name);
          const baseVal = t.before.find((b) => b.name === p.name)?.value;
          if (baseVal != null && v.replace(/\s+/g, ' ') === baseVal.replace(/\s+/g, ' ')) { if (j >= 0) rows.splice(j, 1); }
          else if (j >= 0) rows[j].value = v; else rows.push({ name: p.name, value: v });
          setProps(rows);
        } }), `pv-${p.name}`);
      fit(input);
      const line = h('div', { class: `dob-line dob-prop ch-${p.change}` }, h('span', { class: 'dob-k' }, p.name), p.value === '' && p.change === 'same' ? ';' : [' = ', input, ';']);
      if (p.src === 'auto') line.append(h('span', { class: 'dob-was' }, 'added: children carry reg'));
      else if (p.change === 'changed') line.append(h('span', { class: 'dob-was' }, `was ${p.was}`), h('button', { class: 'dob-x', title: 'Back to the base value', 'aria-label': `Reset ${p.name}`,
        onclick: () => { const rows = props.filter((_, j) => j !== k); setProps(rows); } }, '↺'));
      else if (p.change === 'new' && k >= 0) line.append(h('button', { class: 'dob-x', title: 'Remove', 'aria-label': `Remove ${p.name}`, onclick: () => setProps(props.filter((_, j) => j !== k)) }, '×'));
      lines.push(line);
    }
    // rows still being typed (no name yet, or a name the result dropped)
    props.forEach((p, k) => {
      const nm = String(p.name).trim();
      if (nm && t.before.some((a) => a.name === nm)) return;
      lines.push(h('div', { class: 'dob-line dob-prop ch-new' },
        fit(track(h('input', { type: 'text', class: 'dob-in dob-kin', spellcheck: 'false', placeholder: 'property', 'aria-label': 'New property name', value: p.name,
          oninput: (e) => { const rows = props.map((q) => ({ ...q })); rows[k].name = e.target.value; setProps(rows); } }), `pn-${k}`)),
        ' = ',
        fit(track(h('input', { type: 'text', class: 'dob-in', spellcheck: 'false', placeholder: '<value>', 'aria-label': 'New property value', value: p.value,
          oninput: (e) => { const rows = props.map((q) => ({ ...q })); rows[k].value = e.target.value; setProps(rows); } }), `pd-${k}`)),
        ';', h('button', { class: 'dob-x', title: 'Remove', 'aria-label': 'Remove property', onclick: () => setProps(props.filter((_, j) => j !== k)) }, '×')));
    });
    lines.push(h('div', { class: 'dob-line' }, h('button', { class: 'dob-addprop', 'data-k': 'addprop', onclick: () => {
      focusKey = `pn-${props.length}`; setProps([...props, { name: '', value: '' }]);
    } }, '+ property')));
    // the base's children
    const dis = labelsIn('alsoDisable');
    for (const k of t.baseKids) {
      lines.push(h('div', { class: `dob-line dob-kid${k.off ? ' is-off' : ''}${k.disabling ? ' is-struck' : ''}` },
        k.label ? h('span', { class: 'dob-label' }, k.label + ':') : null, ` ${k.name} { … };`,
        k.disabling ? h('span', { class: 'dob-was' }, 'disabled by a fragment') : null,
        k.label ? h('button', { class: 'dob-mini', 'data-k': `kd-${k.label}`, title: dis.includes(k.label) ? 'Keep it' : `Add a fragment disabling &${k.label}`,
          onclick: () => toggleExtra(k.label, 'okay') }, dis.includes(k.label) ? 'keep' : 'disable') : null));
    }
    // the new children, as cards
    const kids = (r.children || []).map((c) => ({ ...c }));
    t.newKids.forEach((nk) => {
      const c = kids[nk.index];
      if (!c) return;
      const setKid = (patch) => { const rows = kids.map((q) => ({ ...q })); Object.assign(rows[nk.index], patch); ctx.set('children', rows); };
      const meta = res.view.kinds[nk.kind] || {};
      const labelFor = { name: 'Name', compatible: 'compatible', addr: meta.addr || 'Address', param: meta.param || 'Parameter', ref: meta.ref || 'Controller', extra: 'Extra properties (k = v; flag)' };
      const bad = nk.issues.some((x) => x.level === 'bad');
      const card = h('div', { class: `dob-kidcard${bad ? ' has-bad' : nk.issues.length ? ' has-warn' : ''}` },
        h('div', { class: 'dob-kidhead' }, h('span', { class: 'dob-kind' }, meta.title || nk.kind), h('b', {}, nk.name),
          h('button', { class: 'dob-x', title: 'Remove this node', 'aria-label': `Remove ${nk.name}`, onclick: () => ctx.set('children', kids.filter((_, j) => j !== nk.index)) }, '×')),
        h('div', { class: 'dob-kidfields' }, FIELDS[nk.kind].map((f) => h('label', { class: f === 'extra' ? 'wide' : null }, labelFor[f],
          track(h('input', { type: 'text', spellcheck: 'false', value: c[f] ?? '', oninput: (e) => setKid({ [f]: e.target.value }) }), `c${nk.index}-${f}`)))),
        h('pre', { class: 'dob-kidsrc' }, nk.lines.map((l) => '\t' + l).join('\n')),
        nk.issues.length ? h('div', { class: 'dob-issues' }, nk.issues.map((x) => h('div', { class: `is-${x.level}` }, x.text,
          x.fix && x.fix.disable ? h('button', { class: 'dob-mini', onclick: () => toggleExtra(x.fix.disable, 'okay') }, `Disable ${x.fix.disable}`) : null))) : null);
      lines.push(card);
    });
    lines.push(h('div', { class: 'dob-line' }, '};'));
    afterBox.replaceChildren(...lines);
    addBar.replaceChildren(h('span', { class: 'dob-sub' }, 'Add a child:'), ...Object.entries(TEMPLATES).map(([kind, tpl]) => h('button', { class: 'k-btn', 'data-k': `add-${kind}`,
      onclick: () => {
        const row = { kind, ...tpl };
        // next free address / chip select on this bus
        if (kind === 'spi' || kind === 'i2c') {
          const used = new Set([...t.baseKids.filter((b) => !b.off).map((b) => parseInt(b.name.split('@')[1], 16)), ...kids.filter((q) => q.kind === kind).map((q) => parseInt(q.addr, kind === 'i2c' ? 16 : 10))]);
          let a = kind === 'i2c' ? 0x48 : 0; while (used.has(a)) a++;
          row.addr = kind === 'i2c' ? '0x' + a.toString(16) : String(a);
        }
        focusKey = `c${kids.length}-name`;
        ctx.set('children', [...kids, row]);
      } }, `+ ${res.view.kinds[kind].title}`)));
  }

  // ---------- draw: side ----------
  function drawSide(r) {
    warns.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    frags.replaceChildren(...(r.view.fragments.length ? r.view.fragments.map((f) => h('li', {}, h('code', {}, `fragment@${f.n}`), ' → ', h('b', {}, f.name), h('span', {}, f.what || 'nothing yet')))
      : [h('li', { class: 'dob-sub' }, 'No fragments yet.')]));
    notes.replaceChildren(h('summary', {}, `Notes (${(r.notes || []).length})`), ...(r.notes || []).map((n) => h('div', {}, n)));
    const e = r.view.parseErrors;
    baseErrs.replaceChildren(...e.map((x) => h('div', {}, `line ${x.line}: ${x.message}`)));
  }
  function syncInputs() {
    const r = raw();
    for (const el of wrap.querySelectorAll('input[data-k], textarea[data-k], select[data-k]')) {
      const k = el.dataset.k;
      if (k in r && typeof r[k] === 'string' && el !== document.activeElement && el.value !== r[k]) el.value = r[k];
    }
  }

  // ---------- dtc ----------
  async function check() {
    if (!res) return;
    const body = res.texts[0].body;
    checkBtn.disabled = true;
    checkOut.replaceChildren(h('div', { class: 'dob-sub' }, 'Compiling with dtc…'));
    try {
      const resp = await fetch('/api/tools/check', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' },
        body: JSON.stringify({ kind: 'dts', input: body, overlay: true }) });
      if (!resp.ok) throw new Error([404, 405, 501].includes(resp.status) ? 'no-api' : `HTTP ${resp.status}`);
      const o = await resp.json();
      const list = [...(o.errors || []).map((x) => h('div', { class: 'is-bad' }, x.line ? `line ${x.line}: ${x.message}` : x.message)),
        ...(o.warnings || []).map((x) => h('div', { class: 'is-warn' }, typeof x === 'string' ? x : x.line ? `line ${x.line}: ${x.message}` : x.message))];
      checkOut.replaceChildren(h('div', { class: o.ok ? 'is-ok' : 'is-bad' }, o.ok ? `dtc compiled the overlay${(o.notes || [])[0] ? ` (${o.notes[0].replace('Version: ', '')})` : ''}: no errors.` : 'dtc refused the overlay:'),
        ...list, o.output ? h('details', {}, h('summary', {}, 'What dtc built (decompiled)'), h('pre', {}, o.output)) : null);
    } catch (err) {
      checkOut.replaceChildren(h('div', { class: 'dob-sub' }, String(err.message) === 'no-api' || /Failed to fetch|NetworkError|JSON/.test(String(err.message))
        ? 'The dtc check runs inside the Redline app; this page is served without its API. The overlay above is what it would compile.'
        : `The check did not run (${err.message}).`));
    } finally { checkBtn.disabled = false; }
  }

  // ---------- redraw ----------
  let firstTab = true;
  ctx.onResult((r) => {
    res = r;
    if (!r || !r.view) { warns.replaceChildren(...(r?.warnings || ['No result']).map((w) => h('div', {}, w))); return; }
    const act = document.activeElement;
    const key = focusKey || (act && wrap.contains(act) ? act.getAttribute('data-k') : null);
    const sel = act && 'selectionStart' in act ? [act.selectionStart, act.selectionEnd] : null;
    focusKey = null;
    drawTree();
    const t = r.view.target;
    targetPath.textContent = t.found ? t.path : 'not found';
    targetPath.className = `dob-sub${t.found ? '' : ' is-bad'}`;
    targetIn.classList.toggle('bad', !t.found);
    drawBefore(t);
    drawAfter(t);
    drawSide(r);
    syncInputs();
    if (key) {
      const el = wrap.querySelector(`[data-k="${CSS.escape(key)}"]`);
      if (el && el !== document.activeElement) {
        el.focus({ preventScroll: true });
        if (sel && el.setSelectionRange && el.value != null) { try { el.setSelectionRange(Math.min(sel[0], el.value.length), Math.min(sel[1], el.value.length)); } catch { /* not a text field */ } }
      }
    }
    if (firstTab) {
      firstTab = false;
      let chosen = null;
      try { chosen = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`); } catch { chosen = null; }
      if (!chosen) pickTab(DEFAULT_TAB);
    }
  });
}
