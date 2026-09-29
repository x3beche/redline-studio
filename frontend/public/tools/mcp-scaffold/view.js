// MCP Server Scaffold, drawn as the thing itself: the client, the transport
// between them and the server, with every tool, resource and prompt as a port
// on the server's edge (a dot for its lint state, its parameters, MIME type
// or arguments, its annotation). Click the transport to switch stdio and
// Streamable HTTP; click a port to edit it beside the drawing, with its
// parameters, its lint findings and the code generated for it; "+" adds one.
// The generated files are the output panel's tabs.
// Everything drawn comes from run()'s result.view.

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
const clip = (t, n) => (t.length > n ? t.slice(0, Math.max(1, n - 1)) + '…' : t);
const TYPES = ['string', 'integer', 'number', 'boolean', 'enum', 'string[]', 'number[]'];
const ANN = [['none', 'none'], ['read-only', 'read-only'], ['idempotent', 'idempotent'], ['destructive', 'destructive'], ['open-world', 'open-world']];
const ANN_TAG = { 'read-only': 'RO', destructive: 'DESTR', idempotent: 'IDEM', 'open-world': 'OPEN' };

export function page(root, ctx) {
  const wrap = h('div', { class: 'ms' });
  root.append(wrap);

  // ---------- toolbar ----------
  const nameIn = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Server name', oninput: (e) => ctx.set('name', e.target.value) });
  const descIn = h('input', { type: 'text', spellcheck: 'false', class: 'wide', 'aria-label': 'Server description', oninput: (e) => ctx.set('description', e.target.value) });
  const seg = (key, opts) => {
    const box = h('div', { class: 'ms-seg', role: 'group' });
    box.draw = (val) => box.replaceChildren(...opts.map(([v, t]) => h('button', { 'aria-pressed': String(val === v), onclick: () => ctx.set(key, v) }, t)));
    return box;
  };
  const langSeg = seg('language', [['python', 'Python'], ['typescript', 'TypeScript']]);
  const sdkSeg = seg('py_sdk', [['v2', 'mcp 2.x'], ['v1', 'mcp 1.x']]);
  const sdkLabel = h('label', {}, 'Python SDK', sdkSeg);
  const bar = h('div', { class: 'ms-bar' },
    h('label', {}, 'Server name', nameIn), h('label', { class: 'grow' }, 'Description (the instructions clients show the model)', descIn),
    h('label', {}, 'Language', langSeg), sdkLabel);

  const svg = s('svg', { class: 'ms-svg', role: 'group', 'aria-label': 'Client, transport and server with its capabilities' });
  const diagSub = h('span', { class: 'ms-sub' });
  const diagCard = h('section', { class: 'ms-card' },
    h('div', { class: 'ms-head' }, h('h2', {}, 'Server'), diagSub), bar, svg,
    h('div', { class: 'ms-help' }, 'Click a port to edit it, the transport to change it, "+" to add. Focused port: ',
      h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' move, ', h('kbd', {}, 'Enter'), ' edit, ', h('kbd', {}, 'Del'), ' remove.'));
  const lintList = h('div', { class: 'ms-lint' });
  const lintSub = h('span', { class: 'ms-sub' });
  const lintCard = h('section', { class: 'ms-card' }, h('div', { class: 'ms-head' }, h('h2', {}, 'Lint'), lintSub), lintList);

  const edTitle = h('h2', {});
  const edSub = h('span', { class: 'ms-sub' });
  const ed = h('div', { class: 'ms-ed' });
  const edFind = h('div', { class: 'ms-edlint' });
  const edCode = h('pre', { class: 'ms-snip', tabindex: '0' });
  const edCard = h('section', { class: 'ms-card' }, h('div', { class: 'ms-head' }, edTitle, edSub), ed, edFind, edCode);
  const warns = h('div', { class: 'ms-warns', role: 'status' });
  const notes = h('details', { class: 'ms-notes' }, h('summary', {}, 'Notes'));
  wrap.append(h('div', { class: 'ms-col' }, warns, diagCard, lintCard), h('div', { class: 'ms-col' }, edCard, ctx.outputs, notes));

  let res = null, sel = { kind: 'tool', row: 0 }, edKey = '', focusId = null;
  const rows = (key) => (ctx.raw[key] || []).map((r) => ({ ...r }));

  // ---------- model changes ----------
  const addCap = (kind) => {
    if (kind === 'tool') {
      const t = rows('tools'); let n = t.length + 1; while (t.some((x) => x.name === `new_tool_${n}`)) n++;
      t.push({ name: `new_tool_${n}`, description: '', annotation: 'none' }); sel = { kind: 'tool', row: t.length - 1 }; edKey = ''; ctx.set('tools', t);
    } else if (kind === 'resource') {
      const r = rows('resources'); r.push({ uri: `data://item${r.length + 1}`, name: `item${r.length + 1}`, description: '', mime: 'text/plain' });
      sel = { kind: 'resource', row: r.length - 1 }; edKey = ''; ctx.set('resources', r);
    } else {
      const p = rows('prompts'); p.push({ name: `new_prompt_${p.length + 1}`, description: '', args: 'topic', text: 'Explain {topic}.' });
      sel = { kind: 'prompt', row: p.length - 1 }; edKey = ''; ctx.set('prompts', p);
    }
  };
  const removeCap = (kind, row) => {
    const key = kind === 'tool' ? 'tools' : kind === 'resource' ? 'resources' : 'prompts';
    const list = rows(key);
    const gone = list[row];
    if (!gone) return;
    list.splice(row, 1);
    const patch = { [key]: list };
    if (kind === 'tool') patch.params = rows('params').filter((p) => String(p.tool ?? '').trim() !== String(gone.name ?? '').trim());
    sel = list.length ? { kind, row: Math.min(row, list.length - 1) } : { kind: 'server' };
    edKey = '';
    ctx.setMany(patch);
  };
  const setTool = (row, patch) => {
    const t = rows('tools'); if (!t[row]) return;
    const old = String(t[row].name ?? '').trim();
    Object.assign(t[row], patch);
    const change = { tools: t };
    if ('name' in patch && old) change.params = rows('params').map((p) => (String(p.tool ?? '').trim() === old ? { ...p, tool: patch.name } : p));
    ctx.setMany(change);
  };
  const setRow = (key, row, patch) => { const l = rows(key); if (!l[row]) return; Object.assign(l[row], patch); ctx.set(key, l); };
  const setParam = (row, patch) => setRow('params', row, patch);

  // ---------- the drawing ----------
  function drawDiagram(v) {
    const W = Math.max(300, Math.round(svg.getBoundingClientRect().width || svg.parentElement.clientWidth || 700));
    const narrow = W < 640;
    svg.replaceChildren();
    const ports = [];
    const groups = [
      { kind: 'tool', title: 'TOOLS', items: v.tools.map((t) => ({ row: t.row, name: t.name || '(no name)', meta: `${t.n} param${t.n === 1 ? '' : 's'}`, tag: ANN_TAG[t.annotation] || '', level: t.level, destr: t.annotation === 'destructive' })) },
      { kind: 'resource', title: 'RESOURCES', items: v.resources.map((r) => ({ row: r.row, name: r.uri || r.name, meta: r.mime || 'no MIME', tag: /\{/.test(r.uri) ? 'TEMPLATE' : '', level: r.level })) },
      { kind: 'prompt', title: 'PROMPTS', items: v.prompts.map((p) => ({ row: p.row, name: p.name || '(no name)', meta: p.args ? `(${p.args})` : 'no args', tag: '', level: p.level })) },
    ];
    const PH = 26, GAP = 5, GH = 22;
    // geometry
    const cli = narrow ? { x: 8, y: 8, w: W - 16, h: 58 } : { x: 10, y: 20, w: Math.min(160, W * 0.19), h: 110 };
    const gap = Math.max(120, Math.min(170, W * 0.16));
    const srvX = narrow ? 8 : cli.x + cli.w + gap;
    const srvW = narrow ? W - 16 : Math.min(190, W * 0.21);
    const pillX = narrow ? 30 : srvX + srvW + 26;
    const pillW = narrow ? W - 38 : W - pillX - 10;
    let y = narrow ? cli.y + cli.h + 70 + 96 : 20;
    const layout = [];
    for (const g of groups) {
      layout.push({ g, y });
      y += GH;
      g.items.forEach((it) => { it.y = y; y += PH + GAP; });
      g.addY = y; y += PH + 12;
    }
    const portsBottom = y;
    const srv = narrow ? { x: srvX, y: cli.y + cli.h + 70, w: srvW, h: 90 } : { x: srvX, y: 20, w: srvW, h: Math.max(160, portsBottom - 32) };
    const H = Math.max(narrow ? portsBottom : portsBottom, srv.y + srv.h + 12, cli.y + cli.h + 20);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);

    // client
    const cg = s('g', { class: 'box' });
    cg.append(s('rect', { x: cli.x, y: cli.y, width: cli.w, height: cli.h, rx: 6, class: 'client' }));
    cg.append(s('text', { x: cli.x + 10, y: cli.y + 20, class: 'big' }, 'MCP client'));
    cg.append(s('text', { x: cli.x + 10, y: cli.y + 37, class: 'soft' }, narrow ? clip('Claude Code · Claude Desktop · any MCP host', Math.floor((cli.w - 20) / 6.9)) : 'Claude Code'));
    if (!narrow) { cg.append(s('text', { x: cli.x + 10, y: cli.y + 52, class: 'soft' }, 'Claude Desktop')); cg.append(s('text', { x: cli.x + 10, y: cli.y + 67, class: 'soft' }, 'any MCP host')); }
    if (!narrow) cg.append(s('text', { x: cli.x + 10, y: cli.y + cli.h - 10, class: 'soft small' }, clip(v.transport === 'http' ? 'connects to the URL' : 'starts the process', Math.floor((cli.w - 16) / 6.3))));
    svg.append(cg);

    // transport link
    const http = v.transport === 'http';
    const tg = s('g', { class: 'sel link', tabindex: '0', role: 'button', 'aria-label': `Transport: ${http ? 'Streamable HTTP' : 'stdio'}. Enter switches.`, 'data-id': 'transport' });
    let lx1, ly1, lx2, ly2, cx, cy;
    if (narrow) { lx1 = lx2 = W / 2; ly1 = cli.y + cli.h; ly2 = srv.y; cx = W / 2; cy = (ly1 + ly2) / 2; }
    else { lx1 = cli.x + cli.w; lx2 = srv.x; ly1 = ly2 = cli.y + 55; cx = (lx1 + lx2) / 2; cy = ly1; }
    tg.append(s('line', { x1: lx1, y1: ly1, x2: lx2, y2: ly2, class: `wire${http ? ' http' : ''}` }));
    tg.append(s('path', { d: narrow ? `M${lx2 - 5},${ly2 - 8} L${lx2},${ly2} L${lx2 + 5},${ly2 - 8}` : `M${lx2 - 8},${ly2 - 5} L${lx2},${ly2} L${lx2 - 8},${ly2 + 5}`, class: 'arrow' }));
    const label = http ? 'Streamable HTTP' : 'stdio';
    const lw = label.length * 7 + 18;
    tg.append(s('rect', { x: cx - lw / 2, y: cy - 12, width: lw, height: 22, rx: 11, class: `chip${sel.kind === 'transport' ? ' on' : ''}` }));
    tg.append(s('text', { x: cx, y: cy + 3.5, 'text-anchor': 'middle', class: 'chiptext' }, label));
    tg.append(s('rect', { x: cx - lw / 2 - 3, y: cy - 15, width: lw + 6, height: 28, rx: 13, class: 'ring' }));
    const subs = http ? ['POST /mcp', v.url.replace(/^http:\/\/|\/mcp$/g, '')] : ['JSON-RPC over', 'stdin / stdout'];
    const fit = narrow ? 40 : Math.floor((gap - 8) / 6.3);
    if (narrow) tg.append(s('text', { x: cx + lw / 2 + 8, y: cy + 4, class: 'soft small' }, clip(subs.join(' '), Math.floor((W / 2 - lw / 2 - 16) / 6.3))));
    else subs.forEach((t, k) => tg.append(s('text', { x: cx, y: cy + 28 + k * 13, 'text-anchor': 'middle', class: 'soft small' }, clip(t, fit))));
    svg.append(tg);
    ports.push(tg);

    // server
    const sg = s('g', { class: 'sel', tabindex: '0', role: 'button', 'aria-label': 'Server settings', 'data-id': 'server' });
    sg.append(s('rect', { x: srv.x, y: srv.y, width: srv.w, height: srv.h, rx: 6, class: `server${sel.kind === 'server' ? ' on' : ''}` }));
    sg.append(s('text', { x: srv.x + 12, y: srv.y + 22, class: 'big' }, clip(v.name || '(no name)', Math.floor((srv.w - 24) / 7.6))));
    sg.append(s('text', { x: srv.x + 12, y: srv.y + 40, class: 'soft' }, clip(v.sdk, Math.floor((srv.w - 24) / 6.6))));
    const nb = v.findings.filter((f) => f.level === 'bad').length, nw = v.findings.filter((f) => f.level === 'warn').length;
    const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const lintTxt = nb || nw ? [nb ? pl(nb, 'error') : null, nw ? pl(nw, 'warning') : null].filter(Boolean).join(', ') : 'lint clean';
    const lines = narrow ? [`${pl(v.tools.length, 'tool')} · ${pl(v.resources.length, 'resource')} · ${pl(v.prompts.length, 'prompt')}`] : [pl(v.tools.length, 'tool'), pl(v.resources.length, 'resource'), pl(v.prompts.length, 'prompt')];
    const fitS = Math.floor((srv.w - 24) / 6.9);
    lines.forEach((t, k) => sg.append(s('text', { x: srv.x + 12, y: srv.y + 62 + k * 16, class: 'soft' }, clip(t, fitS))));
    sg.append(s('text', { x: srv.x + 12, y: srv.y + 62 + lines.length * 16 + 4, class: nb ? 'bad' : nw ? 'warn' : 'ok' }, clip(lintTxt, fitS)));
    sg.append(s('rect', { x: srv.x - 3, y: srv.y - 3, width: srv.w + 6, height: srv.h + 6, rx: 8, class: 'ring' }));
    svg.append(sg);
    ports.push(sg);
    if (narrow) svg.append(s('line', { x1: 18, y1: srv.y + srv.h, x2: 18, y2: portsBottom - 20, class: 'bus' }));

    // ports
    for (const { g, y: gy } of layout) {
      svg.append(s('text', { x: pillX, y: gy + 14, class: 'grp' }, `${g.title} (${g.items.length})`));
      for (const it of g.items) {
        const on = sel.kind === g.kind && sel.row === it.row;
        const pg = s('g', { class: 'sel port', tabindex: '0', role: 'button', 'data-id': `${g.kind}:${it.row}`, 'aria-label': `${g.kind} ${it.name}, ${it.meta}${it.level !== 'ok' ? `, lint ${it.level}` : ''}` });
        const py = it.y + PH / 2;
        const edge = narrow ? 18 : srv.x + srv.w;
        pg.append(s('line', { x1: edge, y1: py, x2: pillX, y2: py, class: 'stub' }));
        pg.append(s('rect', { x: edge - 4, y: py - 4, width: 8, height: 8, class: `sq ${g.kind}` }));
        pg.append(s('rect', { x: pillX, y: it.y, width: pillW, height: PH, rx: 5, class: `pill ${g.kind}${on ? ' on' : ''}${it.destr ? ' destr' : ''}` }));
        pg.append(s('circle', { cx: pillX + 12, cy: py, r: 4, class: `dot ${it.level}` }));
        const tagW = it.tag ? it.tag.length * 6.4 + 10 : 0;
        // the name gets the room first; the meta text takes what is left
        const free = pillW - 30 - tagW - 12;
        const nameW = Math.min(it.name.length * 7.2, Math.max(free * 0.55, free - it.meta.length * 6.3));
        const metaW = Math.max(0, free - nameW);
        const room = Math.floor(nameW / 7.2);
        pg.append(s('text', { x: pillX + 22, y: py + 4, class: 'pname' }, clip(it.name, Math.max(4, room))));
        if (metaW > 30) pg.append(s('text', { x: pillX + pillW - tagW - 8, y: py + 4, 'text-anchor': 'end', class: 'soft small' }, clip(it.meta, Math.floor(metaW / 6.3))));
        if (it.tag) {
          pg.append(s('rect', { x: pillX + pillW - tagW - 4, y: py - 8, width: tagW, height: 16, rx: 3, class: `tag${it.destr ? ' destr' : ''}` }));
          pg.append(s('text', { x: pillX + pillW - tagW / 2 - 4, y: py + 3.5, 'text-anchor': 'middle', class: 'tagtext' }, it.tag));
        }
        pg.append(s('rect', { x: pillX - 3, y: it.y - 3, width: pillW + 6, height: PH + 6, rx: 7, class: 'ring' }));
        svg.append(pg);
        ports.push(pg);
      }
      const ag = s('g', { class: 'sel add', tabindex: '0', role: 'button', 'data-id': `add:${g.kind}`, 'aria-label': `Add a ${g.kind}` });
      ag.append(s('rect', { x: pillX, y: g.addY, width: Math.min(130, pillW), height: PH - 4, rx: 5, class: 'addpill' }));
      ag.append(s('text', { x: pillX + 10, y: g.addY + 15, class: 'soft' }, `+ ${g.kind}`));
      ag.append(s('rect', { x: pillX - 3, y: g.addY - 3, width: Math.min(130, pillW) + 6, height: PH + 2, rx: 7, class: 'ring' }));
      svg.append(ag);
      ports.push(ag);
    }
    for (const p of ports) {
      const id = p.getAttribute('data-id');
      const act = () => activate(id);
      p.addEventListener('click', act);
      p.addEventListener('keydown', (e) => {
        const all = [...svg.querySelectorAll('[data-id]')];
        const i = all.indexOf(p);
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusId = id; act(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); all[Math.min(all.length - 1, i + 1)].focus(); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); all[Math.max(0, i - 1)].focus(); }
        else if ((e.key === 'Delete' || e.key === 'Backspace') && /^(tool|resource|prompt):/.test(id)) {
          e.preventDefault(); const [k, r] = id.split(':'); focusId = id; removeCap(k, Number(r));
        }
      });
      p.addEventListener('focus', () => { focusId = id; });
    }
    if (focusId && svg.contains(document.activeElement) === false && document.activeElement === document.body) {
      svg.querySelector(`[data-id="${focusId}"]`)?.focus();
    }
    diagSub.textContent = `${v.lang === 'python' ? 'Python' : 'TypeScript'} · ${http ? 'Streamable HTTP' : 'stdio'}`;
  }

  function activate(id) {
    if (id === 'transport') {
      if (sel.kind === 'transport') ctx.set('transport', ctx.raw.transport === 'http' ? 'stdio' : 'http');
      else { sel = { kind: 'transport' }; edKey = ''; draw(); }
      return;
    }
    if (id === 'server') { sel = { kind: 'server' }; edKey = ''; draw(); return; }
    if (id.startsWith('add:')) { addCap(id.slice(4)); return; }
    const [k, r] = id.split(':');
    sel = { kind: k, row: Number(r) }; edKey = ''; draw();
    ed.querySelector('input,textarea')?.focus({ preventScroll: true });
  }

  // ---------- the editor ----------
  const field = (label, value, onInput, opts = {}) => {
    const el = opts.area
      ? h('textarea', { rows: opts.rows || 3, spellcheck: 'false', oninput: (e) => onInput(e.target.value) })
      : h('input', { type: 'text', spellcheck: 'false', placeholder: opts.ph || null, oninput: (e) => onInput(e.target.value) });
    el.value = value ?? '';
    return h('label', { class: opts.wide ? 'wide' : null }, label, el);
  };

  function buildEditor(v) {
    ed.replaceChildren();
    const raw = ctx.raw;
    if (sel.kind === 'server') {
      edTitle.textContent = 'Server';
      edSub.textContent = v.sdk;
      ed.append(
        field('Name', raw.name, (x) => ctx.set('name', x)),
        field('Description / instructions', raw.description, (x) => ctx.set('description', x), { area: true, wide: true }),
        h('div', { class: 'wide note' }, 'The name is the key in .mcp.json and the argument of claude mcp add; the description is sent to clients as the server\'s instructions.'));
      return;
    }
    if (sel.kind === 'transport') {
      edTitle.textContent = 'Transport';
      edSub.textContent = 'how the client reaches the server';
      const tseg = h('div', { class: 'ms-seg wide' }, [['stdio', 'stdio (local process)'], ['http', 'Streamable HTTP']].map(([val, t]) =>
        h('button', { 'aria-pressed': String((raw.transport || 'stdio') === val), onclick: () => { edKey = ''; ctx.set('transport', val); } }, t)));
      ed.append(tseg);
      if (raw.transport === 'http') {
        ed.append(field('Port', raw.port, (x) => ctx.set('port', x), { ph: '8000' }),
          h('div', { class: 'wide note' }, 'Listens on 127.0.0.1 at /mcp. Stateless: a fresh server per request (TypeScript) or the SDK\'s session manager (Python). Add authentication before binding to a network address.'));
      } else {
        ed.append(h('div', { class: 'wide note' }, 'The client starts the server as a child process and speaks JSON-RPC over its stdin and stdout. Anything else printed to stdout breaks the session: log to stderr.'));
      }
      return;
    }
    if (sel.kind === 'tool') {
      const t = (raw.tools || [])[sel.row];
      if (!t) { sel = { kind: 'server' }; buildEditor(v); return; }
      const tname = String(t.name ?? '').trim();
      edTitle.textContent = 'Tool';
      edSub.textContent = tname;
      const annSeg = h('div', { class: 'ms-seg wide', role: 'group', 'aria-label': 'Annotation' }, ANN.map(([val, txt]) =>
        h('button', { 'aria-pressed': String((t.annotation || 'none') === val), class: val === 'destructive' ? 'destr' : null, onclick: () => { edKey = ''; setTool(sel.row, { annotation: val }); } }, txt)));
      ed.append(
        field('Name', t.name, (x) => { setTool(sel.row, { name: x }); edSub.textContent = x; }),
        field('Description (what it does, what it returns, when to use it)', t.description, (x) => setTool(sel.row, { description: x }), { area: true, wide: true }),
        h('div', { class: 'wide lbl' }, 'Annotation (a hint to the client)'), annSeg);
      const params = (raw.params || []).map((p, i) => ({ p, i })).filter(({ p }) => String(p.tool ?? '').trim() === tname);
      const table = h('div', { class: 'ms-params wide' },
        h('div', { class: 'ph' }, h('span', {}, 'Parameter'), h('span', {}, 'Type'), h('span', {}, 'Req.'), h('span', {}, 'Description'), h('span', {}, 'Enum values / default'), h('span', {})),
        params.map(({ p, i }) => h('div', { class: 'pr' },
          (() => { const x = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Parameter name', oninput: (e) => setParam(i, { name: e.target.value }) }); x.value = p.name ?? ''; return x; })(),
          h('select', { 'aria-label': 'Type', onchange: (e) => setParam(i, { type: e.target.value }) }, TYPES.map((ty) => h('option', { value: ty, selected: (p.type || 'string') === ty }, ty))),
          h('input', { type: 'checkbox', 'aria-label': 'Required', checked: /^(yes|true|1|y)$/i.test(String(p.required ?? '')), onchange: (e) => setParam(i, { required: e.target.checked ? 'yes' : 'no' }) }),
          (() => { const x = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Parameter description', oninput: (e) => setParam(i, { description: e.target.value }) }); x.value = p.description ?? ''; return x; })(),
          (() => { const x = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Enum values or default', placeholder: p.type === 'enum' ? 'A, B, C' : 'default', oninput: (e) => setParam(i, { values: e.target.value }) }); x.value = p.values ?? ''; return x; })(),
          h('button', { class: 'k-btn k-x', 'aria-label': `Remove parameter ${p.name}`, onclick: () => { const l = rows('params'); l.splice(i, 1); edKey = ''; ctx.set('params', l); } }, '×'))),
        h('div', { class: 'acts' },
          h('button', { class: 'k-btn', onclick: () => { const l = rows('params'); l.push({ tool: String((ctx.raw.tools || [])[sel.row]?.name ?? tname).trim(), name: `arg${params.length + 1}`, type: 'string', required: 'yes', description: '', values: '' }); edKey = ''; ctx.set('params', l); } }, '+ Parameter'),
          h('button', { class: 'k-btn push danger', onclick: () => removeCap('tool', sel.row) }, 'Remove tool')));
      ed.append(table);
      return;
    }
    if (sel.kind === 'resource') {
      const r = (raw.resources || [])[sel.row];
      if (!r) { sel = { kind: 'server' }; buildEditor(v); return; }
      edTitle.textContent = 'Resource';
      edSub.textContent = r.uri;
      ed.append(
        field('URI or template ({var})', r.uri, (x) => { setRow('resources', sel.row, { uri: x }); edSub.textContent = x; }, { ph: 'logs://{run_id}' }),
        field('Name', r.name, (x) => setRow('resources', sel.row, { name: x })),
        field('MIME type', r.mime, (x) => setRow('resources', sel.row, { mime: x }), { ph: 'text/plain' }),
        field('Description', r.description, (x) => setRow('resources', sel.row, { description: x }), { area: true, wide: true, rows: 2 }),
        h('div', { class: 'acts wide' }, h('button', { class: 'k-btn push danger', onclick: () => removeCap('resource', sel.row) }, 'Remove resource')));
      return;
    }
    if (sel.kind === 'prompt') {
      const p = (raw.prompts || [])[sel.row];
      if (!p) { sel = { kind: 'server' }; buildEditor(v); return; }
      edTitle.textContent = 'Prompt';
      edSub.textContent = p.name;
      ed.append(
        field('Name', p.name, (x) => { setRow('prompts', sel.row, { name: x }); edSub.textContent = x; }),
        field('Arguments (a, b? = optional)', p.args, (x) => setRow('prompts', sel.row, { args: x }), { ph: 'log, symptom?' }),
        field('Description', p.description, (x) => setRow('prompts', sel.row, { description: x }), { wide: true }),
        field('Text ({arg} inserts an argument)', p.text, (x) => setRow('prompts', sel.row, { text: x }), { area: true, wide: true, rows: 5 }),
        h('div', { class: 'acts wide' }, h('button', { class: 'k-btn push danger', onclick: () => removeCap('prompt', sel.row) }, 'Remove prompt')));
    }
  }

  function drawEditorLive(v) {
    // findings and code for the selection, refreshed on every result without rebuilding the inputs
    let finds = [], code = '';
    if (sel.kind === 'server') finds = v.findings.filter((f) => f.ref?.kind === 'server');
    else if (sel.kind === 'tool') { finds = v.findings.filter((f) => f.ref?.kind === 'tool' && f.ref.row === sel.row); code = v.tools.find((t) => t.row === sel.row)?.code || ''; }
    else if (sel.kind === 'resource') { finds = v.findings.filter((f) => f.ref?.kind === 'resource' && f.ref.row === sel.row); code = v.resources.find((r) => r.row === sel.row)?.code || ''; }
    else if (sel.kind === 'prompt') { finds = v.findings.filter((f) => f.ref?.kind === 'prompt' && f.ref.row === sel.row); code = v.prompts.find((p) => p.row === sel.row)?.code || ''; }
    edFind.replaceChildren(...finds.map((f) => h('div', { class: f.level }, h('b', {}, f.level === 'bad' ? 'error' : 'warning'), ' ', f.msg)));
    edFind.hidden = !finds.length;
    edCode.textContent = code;
    edCode.hidden = !code;
  }

  function drawLint(v) {
    const f = v.findings;
    lintSub.textContent = f.length ? `${f.filter((x) => x.level === 'bad').length} errors · ${f.filter((x) => x.level === 'warn').length} warnings · click to go there` : 'clean';
    lintList.replaceChildren(...(f.length ? f.map((x) => h('button', { class: `ms-lrow ${x.level}`, onclick: () => {
      const r = x.ref || {};
      if (r.kind === 'tool' || r.kind === 'resource' || r.kind === 'prompt') sel = { kind: r.kind, row: r.row };
      else sel = { kind: 'server' };
      edKey = ''; draw();
    } }, h('i', { class: `dot ${x.level}` }), h('code', {}, x.where), h('span', {}, x.msg))) : [h('div', { class: 'ms-empty' }, 'No findings: names, descriptions and annotations look right.')]));
  }

  function draw() {
    if (!res?.view) return;
    const v = res.view;
    const raw = ctx.raw;
    if (document.activeElement !== nameIn) nameIn.value = raw.name ?? '';
    if (document.activeElement !== descIn) descIn.value = raw.description ?? '';
    langSeg.draw(raw.language || 'python');
    sdkSeg.draw(raw.py_sdk || 'v2');
    sdkLabel.hidden = (raw.language || 'python') !== 'python';
    drawDiagram(v);
    const key = `${sel.kind}:${sel.row ?? ''}:${sel.kind === 'tool' ? (raw.params || []).length : ''}:${raw.transport}`;
    if (key !== edKey) { edKey = key; buildEditor(v); }
    drawEditorLive(v);
    drawLint(v);
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, 'Notes'), ...(res.notes || []).map((n) => h('div', {}, n)));
  }

  let lastW = 0;
  new ResizeObserver(() => { const w = svg.parentElement.clientWidth; if (res && Math.abs(w - lastW) > 1) { lastW = w; drawDiagram(res.view); } }).observe(svg.parentElement);
  // The generated source is what this page is for: show it first unless a tab was picked before.
  let firstTab = true;
  ctx.onResult((r) => {
    res = r; draw();
    if (firstTab) {
      firstTab = false;
      let picked = null;
      try { picked = localStorage.getItem('redline.tool.mcp-scaffold.input.tab'); } catch { /* private window */ }
      if (!picked) [...ctx.outputs.querySelectorAll('.k-tab')][0]?.click();
    }
  });
}
