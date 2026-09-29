// Tool / Function Schema Builder, custom page.
//   Tree     - the parameters as a tree: type chip, name, required star,
//              constraints, description; lint (amber) and example-call errors
//              (red) on the node they concern. Click to select; drag the grip
//              to reorder among siblings. Keys on the tree: Up/Down select,
//              Alt+Up/Down move, Enter edits, Space toggles required,
//              Insert (or A) adds below, + adds a child, Delete removes.
//   Editor   - the selected parameter's fields (name, type, required,
//              description, enum, default, ranges, pattern, format, items).
//   Example  - an arguments JSON checked live against the schema.
//   Outputs  - the Anthropic, OpenAI and MCP definitions side by side.
// Every edit rewrites the JSON Schema input; everything drawn comes from
// run()'s result.tree and result.texts.

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
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object'];
const FORMATS = ['', 'date-time', 'date', 'time', 'email', 'uri', 'uuid', 'hostname', 'ipv4', 'ipv6'];
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.append(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  const was = btn.textContent; btn.textContent = ok ? 'Copied' : 'Select and copy'; setTimeout(() => { btn.textContent = was; }, 1300);
}

export function page(root, ctx) {
  let res = null, T = null, selId = null, jsonMode = false;
  const wrap = h('div', { class: 'ts' });
  root.append(wrap);

  // ---------- tool header ----------
  const nameIn = h('input', { class: 'ts-tname', type: 'text', spellcheck: 'false', 'aria-label': 'Tool name', placeholder: 'verb_object' });
  const descIn = h('textarea', { class: 'ts-tdesc', rows: '2', spellcheck: 'true', 'aria-label': 'Tool description', placeholder: 'What it does, when to use it (and when not), what it returns.' });
  const strictBox = h('input', { type: 'checkbox', 'aria-label': 'Strict mode' });
  debounce(nameIn, 'input', 300, () => ctx.set('name', nameIn.value));
  debounce(descIn, 'input', 400, () => ctx.set('description', descIn.value));
  strictBox.addEventListener('change', () => ctx.set('strict', strictBox.checked));
  const toolLint = h('div', { class: 'ts-tlint' });
  const impKind = h('select', { class: 'ts-sel', 'aria-label': 'Import from' }, [['schema', 'JSON Schema or a tool definition'], ['typescript', 'TypeScript signature'], ['python', 'Python signature']].map(([v, t]) => h('option', { value: v }, t)));
  const impTa = h('textarea', { class: 'ts-code', rows: '8', spellcheck: 'false', 'aria-label': 'Text to import', placeholder: 'Paste a JSON Schema, an Anthropic/OpenAI/MCP tool definition, a TypeScript function or interface, or a Python def with type hints.' });
  const imp = h('details', { class: 'ts-imp' }, h('summary', {}, 'Import'),
    h('div', { class: 'ts-impbody' }, impKind, impTa,
      h('div', { class: 'ts-row' }, h('button', { class: 'k-btn k-primary', onclick: () => {
        const k = impKind.value, t = impTa.value.trim(); if (!t) return;
        selId = '';
        if (k === 'schema') ctx.setMany({ source: 'schema', schema: t }); else ctx.setMany({ source: k, signature: t });
        imp.open = false;
      } }, 'Build the tree'), h('span', { class: 'ts-soft' }, 'Replaces the current parameters.'))));
  const srcBanner = h('div', { class: 'ts-banner', hidden: true });
  const head = h('section', { class: 'ts-card ts-tool' },
    h('div', { class: 'ts-thead' },
      h('label', { class: 'ts-lab' }, 'Tool', nameIn),
      h('label', { class: 'ts-strict', title: 'Anthropic strict: true / OpenAI strict: true - arguments always match the schema' }, strictBox, 'Strict mode'),
      imp),
    descIn, toolLint, srcBanner);

  // ---------- tree ----------
  const treeEl = h('div', { class: 'ts-tree', role: 'tree', 'aria-label': 'Parameters', tabindex: '0' });
  const rawTa = h('textarea', { class: 'ts-code ts-raw', rows: '18', spellcheck: 'false', 'aria-label': 'Parameters as JSON Schema', hidden: true });
  debounce(rawTa, 'input', 450, () => ctx.setMany({ source: 'schema', schema: rawTa.value }));
  const rawErr = h('div', { class: 'ts-err', hidden: true });
  const jsonBtn = h('button', { class: 'k-btn', 'aria-pressed': 'false', onclick: () => setJson(!jsonMode) }, 'JSON');
  const treeSub = h('span', { class: 'ts-soft' });
  const treeCard = h('section', { class: 'ts-card ts-treecard' },
    h('div', { class: 'ts-head' }, h('h2', {}, 'Parameters'), treeSub,
      h('div', { class: 'ts-hbtn' }, h('button', { class: 'k-btn', onclick: () => addChild(T?.nodes[0]) }, '+ Parameter'), jsonBtn)),
    treeEl, rawErr, rawTa,
    h('div', { class: 'ts-help' }, 'Click a row to edit it; drag the grip to reorder. Keys: ', kbd('↑'), kbd('↓'), ' select, ', kbd('Alt+↑↓'), ' move, ', kbd('Enter'), ' edit, ', kbd('Space'), ' required, ', kbd('A'), ' add below, ', kbd('+'), ' add child, ', kbd('Del'), ' remove.'));
  function kbd(t) { return h('kbd', {}, t); }
  function setJson(on) {
    jsonMode = on; jsonBtn.setAttribute('aria-pressed', String(on));
    treeEl.hidden = on; rawTa.hidden = !on;
    if (on) rawTa.value = ctx.raw.source === 'schema' ? ctx.raw.schema || '' : JSON.stringify(T?.schema || {}, null, 2);
  }

  // ---------- editor ----------
  const edBody = h('div', { class: 'ts-ed' });
  const edTitle = h('span', { class: 'ts-soft ts-path' });
  const edCard = h('section', { class: 'ts-card ts-edcard' }, h('div', { class: 'ts-head' }, h('h2', {}, 'Selected'), edTitle), edBody);

  // ---------- example ----------
  const exTa = h('textarea', { class: 'ts-code', rows: '7', spellcheck: 'false', 'aria-label': 'Example call arguments JSON' });
  debounce(exTa, 'input', 350, () => ctx.set('example', exTa.value));
  const exOut = h('div', { class: 'ts-exout', 'aria-live': 'polite' });
  const exCard = h('section', { class: 'ts-card ts-excard' },
    h('div', { class: 'ts-head' }, h('h2', {}, 'Example call'), h('span', { class: 'ts-soft' }, 'arguments a model might send'),
      h('div', { class: 'ts-hbtn' }, h('button', { class: 'k-btn', title: 'Required fields, defaults and first enum values', onclick: () => { if (T) { exTa.value = T.sample; ctx.set('example', T.sample); } } }, 'Fill a valid call'))),
    exTa, exOut);

  // ---------- outputs ----------
  const panes = h('div', { class: 'ts-panes' });
  const outCard = h('section', { class: 'ts-card ts-outcard' }, h('div', { class: 'ts-head' }, h('h2', {}, 'Definitions'), h('span', { class: 'ts-soft', id: 'ts-outsub' })), panes);
  const notes = h('details', { class: 'ts-notes' }, h('summary', {}, 'Notes'));
  const lintCard = h('section', { class: 'ts-card ts-lintcard' }, h('div', { class: 'ts-head' }, h('h2', {}, 'Lint'), h('span', { class: 'ts-soft', id: 'ts-lintsub' })), h('div', { class: 'ts-lints', role: 'list' }));

  wrap.append(head,
    h('div', { class: 'ts-main' }, treeCard, h('div', { class: 'ts-side' }, edCard, exCard, lintCard)),
    outCard, notes, h('div', { class: 'ts-kout' }, ctx.outputs));

  // ---------- schema edits ----------
  const S = () => JSON.parse(JSON.stringify(T.schema));
  const at = (s, ptr) => ptr.reduce((o, k) => (o == null ? o : o[k]), s);
  const node = (id) => T?.nodes.find((n) => n.id === id);
  function commit(s, keepId) {
    if (keepId != null) selId = keepId;
    ctx.setMany({ source: 'schema', schema: JSON.stringify(s, null, 2) });
  }
  const parentObj = (s, n) => at(s, n.ptr.slice(0, -2));
  function reorder(obj, keys) { const p = obj.properties; obj.properties = Object.fromEntries(keys.map((k) => [k, p[k]])); }
  function uniq(obj, base) { let k = base, i = 2; while (obj.properties && k in obj.properties) k = `${base}_${i++}`; return k; }
  const childId = (pid, k) => (pid ? `${pid}.${k}` : k);
  function addChild(n) {
    if (!T || !n) return;
    const s = S();
    let target = at(s, n.ptr), tid = n.id;
    if (n.main === 'array') { if (!isObj(target.items) || (target.items.type && target.items.type !== 'object')) target.items = { type: 'object', properties: {} }; target = target.items; tid = `${n.id}[]`; }
    if (!isObj(target.properties)) { target.type = 'object'; target.properties = {}; }
    const k = uniq(target, 'new_param');
    target.properties[k] = { type: 'string', description: '' };
    commit(s, childId(tid, k));
    focusEditor();
  }
  function addBelow(n) {
    if (!T || !n) return;
    if (n.kind !== 'prop') { addChild(n); return; }
    const s = S(); const obj = parentObj(s, n);
    const keys = Object.keys(obj.properties);
    const k = uniq(obj, 'new_param');
    obj.properties[k] = { type: 'string', description: '' };
    keys.splice(keys.indexOf(n.name) + 1, 0, k);
    reorder(obj, keys);
    commit(s, childId(n.parent, k));
    focusEditor();
  }
  function remove(n) {
    if (!T || !n || n.kind !== 'prop') return;
    const s = S(); const obj = parentObj(s, n);
    const keys = Object.keys(obj.properties); const i = keys.indexOf(n.name);
    delete obj.properties[n.name];
    if (Array.isArray(obj.required)) { obj.required = obj.required.filter((k) => k !== n.name); if (!obj.required.length) delete obj.required; }
    const rest = Object.keys(obj.properties);
    commit(s, rest.length ? childId(n.parent, rest[Math.min(i, rest.length - 1)]) : (n.parent ?? ''));
    requestAnimationFrame(() => treeEl.focus());
  }
  function moveTo(n, to) {
    if (!T || !n || n.kind !== 'prop') return;
    const s = S(); const obj = parentObj(s, n);
    const keys = Object.keys(obj.properties); const i = keys.indexOf(n.name);
    to = clamp(to, 0, keys.length - 1); if (to === i) return;
    keys.splice(i, 1); keys.splice(to, 0, n.name);
    reorder(obj, keys);
    commit(s, n.id);
  }
  function toggleReq(n) {
    if (!T || !n || n.kind !== 'prop') return;
    const s = S(); const obj = parentObj(s, n);
    const req = new Set(Array.isArray(obj.required) ? obj.required : []);
    if (req.has(n.name)) req.delete(n.name); else req.add(n.name);
    const order = Object.keys(obj.properties).filter((k) => req.has(k));
    if (order.length) obj.required = order; else delete obj.required;
    commit(s, n.id);
  }
  function rename(n, name) {
    name = name.trim();
    if (!name || name === n.name || n.kind !== 'prop') return;
    const s = S(); const obj = parentObj(s, n);
    if (name in obj.properties) { flash(`"${name}" already exists here.`); return; }
    obj.properties = Object.fromEntries(Object.entries(obj.properties).map(([k, v]) => [k === n.name ? name : k, v]));
    if (Array.isArray(obj.required)) obj.required = obj.required.map((k) => (k === n.name ? name : k));
    commit(s, childId(n.parent, name));
  }
  function setField(n, key, value) {
    const s = S(); const x = at(s, n.ptr);
    if (value === '' || value == null) delete x[key]; else x[key] = value;
    commit(s, n.id);
  }
  function setType(n, t) {
    const s = S(); const x = at(s, n.ptr);
    const nullable = Array.isArray(x.type) && x.type.includes('null');
    x.type = nullable ? [t, 'null'] : t;
    if (t !== 'object') { delete x.properties; delete x.required; delete x.additionalProperties; }
    if (t !== 'array') { delete x.items; delete x.minItems; delete x.maxItems; }
    if (t !== 'string') { delete x.minLength; delete x.maxLength; delete x.pattern; delete x.format; }
    if (t !== 'number' && t !== 'integer') { for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) delete x[k]; }
    if (t === 'object' && !isObj(x.properties)) x.properties = {};
    if (t === 'array' && !isObj(x.items)) x.items = { type: 'string' };
    if (Array.isArray(x.enum)) { if (t === 'string') x.enum = x.enum.map(String); else if (t === 'number' || t === 'integer') { x.enum = x.enum.map(Number).filter(Number.isFinite); } else delete x.enum; }
    if (x.default !== undefined) { const d = x.default; const ok = (t === 'string' && typeof d === 'string') || ((t === 'number' || t === 'integer') && typeof d === 'number') || (t === 'boolean' && typeof d === 'boolean'); if (!ok) delete x.default; }
    commit(s, n.id);
  }
  let flashT = null;
  function flash(msg) { toolLint.dataset.flash = msg; drawToolLint(); clearTimeout(flashT); flashT = setTimeout(() => { delete toolLint.dataset.flash; drawToolLint(); }, 2500); }

  // ---------- tree drawing ----------
  function drawTree() {
    const N = T.nodes;
    treeSub.textContent = `${N[0].children} parameter${N[0].children === 1 ? '' : 's'} · ${N.filter((n) => n.kind === 'prop').length} fields`;
    treeEl.replaceChildren(...N.map((n) => {
      const isSel = n.id === selId;
      const req = n.kind === 'prop'
        ? h('button', { class: `ts-req${n.required ? ' on' : ''}`, tabindex: '-1', title: n.required ? 'Required - click to make optional' : 'Optional - click to make required', 'aria-label': n.required ? 'required' : 'optional',
          onclick: (e) => { e.stopPropagation(); selId = n.id; toggleReq(n); } }, n.required ? '*' : '○') : h('span', { class: 'ts-req none' });
      const grip = n.kind === 'prop' ? h('span', { class: 'ts-grip', title: 'Drag to reorder', onpointerdown: (e) => startDrag(e, n) }, h('i'), h('i'), h('i')) : h('span', { class: 'ts-grip none' });
      const tags = [];
      if (n.enum) tags.push(h('span', { class: 'ts-tag' }, `enum ${n.enum.length}`));
      if (n.cons) tags.push(h('span', { class: 'ts-tag' }, n.cons));
      if (n.def) tags.push(h('span', { class: 'ts-tag' }, `= ${n.def}`));
      const marks = [];
      if (n.errors.length) marks.push(h('span', { class: 'ts-badge bad', title: n.errors.join('\n') }, `${n.errors.length} error${n.errors.length > 1 ? 's' : ''}`));
      const lints = n.lints.filter((l) => !/^optional:/.test(l));
      if (lints.length && n.kind !== 'root') marks.push(h('span', { class: 'ts-badge warn', title: lints.join('\n') }, `${lints.length}`));
      if (n.lints.some((l) => /^optional:/.test(l))) marks.push(h('span', { class: 'ts-badge soft', title: n.lints.find((l) => /^optional:/.test(l)) }, 'nullable in OpenAI'));
      const row = h('div', { class: `ts-node${isSel ? ' sel' : ''}${n.errors.length ? ' has-err' : ''}${lints.length && n.kind !== 'root' ? ' has-lint' : ''} k-${n.kind}`, role: 'treeitem', 'aria-selected': String(isSel),
        'aria-level': String(n.depth + 1), 'data-id': n.id, style: `--d:${n.depth}`,
        onclick: () => { selId = n.id; drawTree(); drawEditor(); treeEl.focus({ preventScroll: true }); } },
        grip, h('span', { class: 'ts-ind' }), req,
        h('span', { class: `ts-type t-${n.main || 'any'}` }, n.kind === 'root' ? 'object' : n.type.replace('|null', '?')),
        h('span', { class: 'ts-nm' }, n.kind === 'root' ? (T.name || 'tool') + ' (arguments)' : n.name),
        ...tags,
        h('span', { class: 'ts-desc' }, n.kind === 'root' ? '' : n.desc || (n.kind === 'items' ? 'each element' : 'no description')),
        ...marks,
        isSel && n.kind !== 'root' ? h('span', { class: 'ts-acts' },
          (n.main === 'object' || n.main === 'array') ? h('button', { class: 'k-btn', title: 'Add a child (+)', onclick: (e) => { e.stopPropagation(); addChild(n); } }, '+ child') : null,
          n.kind === 'prop' ? h('button', { class: 'k-btn', title: 'Add below (A)', onclick: (e) => { e.stopPropagation(); addBelow(n); } }, '+ below') : null,
          n.kind === 'prop' ? h('button', { class: 'k-btn', title: 'Move up (Alt+Up)', 'aria-label': 'Move up', onclick: (e) => { e.stopPropagation(); moveTo(n, n.index - 1); } }, '↑') : null,
          n.kind === 'prop' ? h('button', { class: 'k-btn', title: 'Move down (Alt+Down)', 'aria-label': 'Move down', onclick: (e) => { e.stopPropagation(); moveTo(n, n.index + 1); } }, '↓') : null,
          n.kind === 'prop' ? h('button', { class: 'k-btn k-x', title: 'Remove (Delete)', 'aria-label': 'Remove', onclick: (e) => { e.stopPropagation(); remove(n); } }, '×') : null) : null);
      return row;
    }));
    treeEl.setAttribute('aria-activedescendant', '');
    treeEl.querySelector('.ts-node.sel')?.scrollIntoView({ block: 'nearest' });
  }
  treeEl.addEventListener('keydown', (e) => {
    if (!T || e.target !== treeEl) return;
    const N = T.nodes; const i = Math.max(0, N.findIndex((n) => n.id === selId)); const n = N[i];
    const go = (j) => { selId = N[clamp(j, 0, N.length - 1)].id; drawTree(); drawEditor(); };
    if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); moveTo(n, n.index + 1); }
    else if (e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); moveTo(n, n.index - 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(N.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); focusEditor(); }
    else if (e.key === ' ') { e.preventDefault(); toggleReq(n); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(n); }
    else if (e.key === 'Insert' || e.key === 'a' || e.key === 'A') { e.preventDefault(); addBelow(n); }
    else if (e.key === '+') { e.preventDefault(); addChild(n); }
  });
  function focusEditor() { requestAnimationFrame(() => requestAnimationFrame(() => { const el = edBody.querySelector('[data-f="name"]') || edBody.querySelector('input,textarea,select'); el?.focus(); el?.select?.(); })); }
  function startDrag(e, n) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    selId = n.id;
    const rows = [...treeEl.querySelectorAll('.ts-node')].filter((r) => { const m = T.nodes.find((x) => x.id === r.dataset.id); return m && m.parent === n.parent && m.kind === 'prop'; });
    const me = rows.find((r) => r.dataset.id === n.id);
    const grip = e.currentTarget;
    const y0 = e.clientY;
    const ind = h('div', { class: 'ts-dropind' });
    let to = n.index;
    me.classList.add('dragging');
    try { grip.setPointerCapture(e.pointerId); } catch { /* ended pointer */ }
    const mv = (ev) => {
      me.style.transform = `translateY(${ev.clientY - y0}px)`;
      const others = rows.filter((r) => r !== me);
      to = others.filter((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2 < ev.clientY; }).length;
      const ref = others[to];
      if (ref) treeEl.insertBefore(ind, ref); else { const last = others[others.length - 1]; if (last) { let end = last; const lid = last.dataset.id; for (let x = last.nextElementSibling; x && x.dataset.id && (x.dataset.id.startsWith(`${lid}.`) || x.dataset.id.startsWith(`${lid}[`)); x = x.nextElementSibling) end = x; end.after(ind); } }
    };
    const up = () => {
      grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
      me.style.transform = ''; me.classList.remove('dragging'); ind.remove();
      if (to !== n.index) moveTo(n, to); else { drawTree(); drawEditor(); }
    };
    grip.addEventListener('pointermove', mv); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  }

  // ---------- editor drawing ----------
  let edFor = null;
  function drawEditor() {
    const n = node(selId) || T.nodes[0];
    selId = n.id;
    edTitle.textContent = n.kind === 'root' ? 'the arguments object' : n.id;
    const focused = edBody.contains(document.activeElement);
    if (focused && edFor === n.id + '|' + n.type) { drawEdMsgs(n); return; }
    edFor = n.id + '|' + n.type;
    const s = at(T.schema, n.ptr) || {};
    const fields = [];
    const field = (label, ctl, cls = '') => h('label', { class: `ts-f ${cls}` }, h('span', {}, label), ctl);
    const inp = (key, value, parse, ph = '') => {
      const el = h('input', { type: 'text', spellcheck: 'false', 'data-f': key, placeholder: ph });
      el.value = value ?? '';
      el.addEventListener('change', () => { const v = el.value.trim(); if (v === '') setField(n, key, ''); else { const p = parse(v); if (p === undefined) { el.classList.add('bad'); return; } setField(n, key, p); } });
      return el;
    };
    const num = (v) => { const x = ctx.parseEng(v); return x == null ? undefined : x; };
    const intv = (v) => { const x = ctx.parseEng(v); return x == null || x < 0 ? undefined : Math.round(x); };
    if (n.kind === 'root') {
      fields.push(h('p', { class: 'ts-soft' }, 'The object the model fills in. Add parameters here or with + child on a row.'),
        h('div', { class: 'ts-row' }, h('button', { class: 'k-btn k-primary', onclick: () => addChild(n) }, '+ Parameter')));
    } else {
      if (n.kind === 'prop') {
        const nm = h('input', { type: 'text', spellcheck: 'false', 'data-f': 'name', class: 'ts-mono' }); nm.value = n.name;
        nm.addEventListener('change', () => rename(n, nm.value));
        nm.addEventListener('keydown', (e) => { if (e.key === 'Escape') { nm.value = n.name; treeEl.focus(); } });
        const rq = h('input', { type: 'checkbox', checked: !!n.required, 'data-f': 'required' }); rq.addEventListener('change', () => toggleReq(n));
        fields.push(h('div', { class: 'ts-frow' }, field('Name', nm, 'grow'), h('label', { class: 'ts-f ts-chk' }, rq, h('span', {}, 'Required'))));
      }
      const ty = h('select', { 'data-f': 'type' }, TYPES.map((t) => h('option', { value: t, selected: t === n.main }, t)));
      ty.addEventListener('change', () => setType(n, ty.value));
      fields.push(field('Type', ty));
      const d = h('textarea', { rows: '3', 'data-f': 'description', spellcheck: 'true', placeholder: 'What it is, unit, format, and what each enum value means.' }); d.value = n.desc;
      debounce(d, 'input', 500, () => setField(n, 'description', d.value));
      fields.push(field('Description', d, 'wide'));
      if (['string', 'number', 'integer'].includes(n.main)) {
        const en = h('textarea', { rows: '3', 'data-f': 'enum', spellcheck: 'false', placeholder: 'one value per line (leave empty for any)' });
        en.value = (n.enum || []).join('\n');
        en.addEventListener('change', () => {
          const vals = en.value.split('\n').map((v) => v.trim()).filter(Boolean);
          setField(n, 'enum', vals.length ? (n.main === 'string' ? vals : vals.map(Number).filter(Number.isFinite)) : '');
        });
        fields.push(field('Allowed values (enum)', en, 'wide'));
      }
      const defParse = (v) => { if (n.main === 'string') return v.replace(/^"(.*)"$/, '$1'); try { return JSON.parse(v); } catch { return undefined; } };
      if (n.main !== 'object' && n.main !== 'array') fields.push(field('Default', inp('default', n.def && n.main === 'string' ? JSON.parse(n.def) : n.def, defParse, n.main === 'boolean' ? 'true / false' : '')));
      if (n.main === 'number' || n.main === 'integer') fields.push(h('div', { class: 'ts-frow' }, field('Minimum', inp('minimum', s.minimum, num)), field('Maximum', inp('maximum', s.maximum, num))));
      if (n.main === 'string') {
        const fm = h('select', { 'data-f': 'format' }, FORMATS.map((f) => h('option', { value: f, selected: (s.format || '') === f }, f || '(none)')));
        fm.addEventListener('change', () => setField(n, 'format', fm.value));
        fields.push(h('div', { class: 'ts-frow' }, field('Min length', inp('minLength', s.minLength, intv)), field('Max length', inp('maxLength', s.maxLength, intv))),
          h('div', { class: 'ts-frow' }, field('Pattern', inp('pattern', s.pattern, (v) => v, '^[A-Z0-9-]+$'), 'grow'), field('Format', fm)));
      }
      if (n.main === 'array') {
        const it = h('select', { 'data-f': 'items' }, TYPES.map((t) => h('option', { value: t, selected: t === ((s.items && (Array.isArray(s.items.type) ? s.items.type[0] : s.items.type)) || 'string') }, t)));
        it.addEventListener('change', () => { const sc = S(); const x = at(sc, n.ptr); x.items = it.value === 'object' ? { type: 'object', properties: {} } : it.value === 'array' ? { type: 'array', items: { type: 'string' } } : { type: it.value, ...(x.items?.description ? { description: x.items.description } : {}) }; commit(sc, n.id); });
        fields.push(h('div', { class: 'ts-frow' }, field('Element type', it), field('Min items', inp('minItems', s.minItems, intv)), field('Max items', inp('maxItems', s.maxItems, intv))));
      }
    }
    const msgs = h('div', { class: 'ts-edmsgs' });
    edBody.replaceChildren(...fields, msgs);
    drawEdMsgs(n);
  }
  function drawEdMsgs(n) {
    const box = edBody.querySelector('.ts-edmsgs'); if (!box) return;
    box.replaceChildren(...n.errors.map((m) => h('div', { class: 'bad' }, `Example: ${m}`)), ...n.lints.filter((l) => n.kind !== 'root').map((m) => h('div', { class: /^optional:/.test(m) ? 'soft' : 'warn' }, m)));
  }

  // ---------- other panels ----------
  function drawToolLint() {
    const root0 = T?.nodes[0];
    const msgs = [...(toolLint.dataset.flash ? [toolLint.dataset.flash] : []), ...(root0 ? root0.lints.filter((m) => !/optional parameter/.test(m)) : [])];
    toolLint.replaceChildren(...msgs.map((m) => h('div', {}, m)));
    toolLint.hidden = !msgs.length;
  }
  function drawExample() {
    if (document.activeElement !== exTa) exTa.value = ctx.raw.example ?? '';
    const errs = T.exErrors || [];
    if (T.parseError) { exOut.replaceChildren(h('div', { class: 'ts-soft' }, 'Not checked while the schema does not parse.')); return; }
    if (T.exParse) { exOut.replaceChildren(h('div', { class: 'bad' }, `Not JSON: ${T.exParse}`)); return; }
    if (!String(ctx.raw.example || '').trim()) { exOut.replaceChildren(h('div', { class: 'ts-soft' }, 'Paste arguments to check them, or fill a valid call.')); return; }
    if (!errs.length) { exOut.replaceChildren(h('div', { class: 'ok' }, 'Valid against the schema.')); return; }
    exOut.replaceChildren(...errs.map((e) => h('button', { class: 'ts-exerr', onclick: () => { if (node(e.node)) { selId = e.node; drawTree(); drawEditor(); } } }, h('code', {}, e.path), ` ${e.msg}`)));
  }
  function drawLint() {
    const list = lintCard.querySelector('.ts-lints');
    const items = [];
    for (const n of T.nodes) for (const m of n.lints) if (!/^optional:/.test(m) && n.kind !== 'root') items.push([n, m]);
    const rootL = T.nodes[0].lints.filter((m) => /optional parameter/.test(m));
    lintCard.querySelector('#ts-lintsub').textContent = items.length + rootL.length ? `${items.length + rootL.length} finding${items.length + rootL.length > 1 ? 's' : ''}` : 'nothing to fix';
    list.replaceChildren(...items.map(([n, m]) => h('button', { class: 'ts-lint', role: 'listitem', onclick: () => { selId = n.id; drawTree(); drawEditor(); } }, h('code', {}, n.id), ' ', m.replace(/^"[^"]+"(:| is| has)\s*/, (x, g) => (g === ':' ? '' : g.trim() + ' ')))),
      ...rootL.map((m) => h('div', { class: 'ts-lint soft' }, m)));
    lintCard.hidden = false;
  }
  function drawPanes() {
    const texts = res.texts || [];
    const label = { Anthropic: 'Anthropic · tools[] entry', OpenAI: 'OpenAI · function tool', MCP: 'MCP · tools/list entry' };
    panes.replaceChildren(...texts.map((t) => {
      const btn = h('button', { class: 'k-btn', onclick: () => copyText(t.body, btn) }, 'Copy');
      return h('div', { class: 'ts-pane' }, h('div', { class: 'ts-phead' }, h('b', {}, label[t.title] || t.title), btn), h('pre', { class: 'ts-pre', tabindex: '0' }, t.body));
    }));
    root.querySelector('#ts-outsub').textContent = T.strict ? 'strict: rewritten per provider' : 'strict off: the same schema in all three';
  }
  function drawHead() {
    if (document.activeElement !== nameIn) nameIn.value = ctx.raw.name ?? '';
    if (document.activeElement !== descIn) descIn.value = ctx.raw.description ?? '';
    strictBox.checked = !!ctx.raw.strict;
    drawToolLint();
    const src = ctx.raw.source;
    srcBanner.hidden = src === 'schema';
    if (src !== 'schema') srcBanner.textContent = `The tree was built from the ${src === 'typescript' ? 'TypeScript' : 'Python'} signature${T.importedName ? ` (${T.importedName})` : ''}. Editing it switches the input to JSON Schema.`;
  }

  function draw() {
    if (!res || !T) return;
    if (!node(selId)) selId = T.nodes[1]?.id ?? '';
    drawHead();
    if (T.parseError) {
      if (!jsonMode) setJson(true);
      rawErr.hidden = false;
      rawErr.textContent = `Not valid JSON${T.parseError.line ? ` at line ${T.parseError.line}, column ${T.parseError.col}` : ''}: ${T.parseError.msg}. Fix it here; the tree comes back when it parses.`;
    } else rawErr.hidden = true;
    if (jsonMode && document.activeElement !== rawTa) rawTa.value = ctx.raw.source === 'schema' ? ctx.raw.schema || '' : JSON.stringify(T.schema, null, 2);
    drawTree(); drawEditor(); drawExample(); drawLint(); drawPanes();
    notes.replaceChildren(h('summary', {}, 'Notes'), ...(res.notes || []).map((t) => h('p', {}, t)));
  }
  ctx.onResult((r) => { res = r; T = r.tree || null; draw(); });
}

function debounce(el, ev, ms, fn) { let t = null; el.addEventListener(ev, () => { clearTimeout(t); t = setTimeout(fn, ms); }); }
