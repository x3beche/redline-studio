// Deep Link Builder, custom page: the link taken apart.
//
// The main area is the link itself, laid out part by part as you type it -
// scheme, host, path, each query parameter, fragment - with ribbons down to
// the encoded link, so every %20 and %26 sits under the character it came
// from. Parameters are chips: type in them, drag the grip (or use the arrow
// keys on it) to reorder, x to remove, + to add. Below, the two routes the
// link takes on a phone: Android's intent filter and iOS's URL scheme or
// apple-app-site-association, with the parts of the link each one checks in
// the same colours, and the package / bundle / team edited where they are
// used. Pointing at a part lights it everywhere.
//
// The encoded pieces, the link and the matcher fields are run()'s result
// (result.parts); warnings are placed on the part they are about.

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
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
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};

const CSS = `
.dl { --tool-scheme: var(--tool-s0); --tool-host: var(--tool-s1); --tool-path: var(--tool-s2); --tool-query: var(--tool-s3); --tool-frag: #b0457a;
  display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 12px; align-items: start; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .dl { --tool-frag: #e27aab; } }
:root[data-theme="dark"] .dl { --tool-frag: #e27aab; }
.dl [hidden] { display: none !important; }
.dl-anat { grid-column: 1 / -1; }
@media (max-width: 960px) { .dl { grid-template-columns: minmax(0, 1fr); } }
.dl-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; min-width: 0; }
.dl-head { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; padding: 7px 10px; border-bottom: 1px solid var(--line-soft); }
.dl-h { font-weight: 600; font-size: 13px; }
.dl-sub { color: var(--ink-soft); font-size: 12px; }
.dl-right { margin-left: auto; display: inline-flex; gap: 8px; align-items: center; }
.dl-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
.dl-seg button { border: 0; background: transparent; padding: 3px 9px; font-size: 12px; cursor: pointer; color: var(--ink-soft); }
.dl-seg button + button { border-left: 1px solid var(--line); }
.dl-seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.dl-len { font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); }
.dl-len.bad { color: var(--danger); }

/* the typed link */
.dl-body { position: relative; padding: 14px 14px 12px; }
.dl-strip { position: relative; z-index: 1; display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px 0; }
.dl-cell { display: flex; flex-direction: column; align-items: stretch; min-width: 0; padding: 0 1px; }
.dl-cell > .lab { font-size: 10.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--c); font-weight: 600; padding: 0 2px 3px; white-space: nowrap; }
.dl-cell > .lab i { font-style: normal; text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--ink-soft); }
.dl-box { display: flex; align-items: center; border: 1px solid var(--line); border-bottom: 3px solid var(--c); border-radius: 4px 4px 2px 2px; background: var(--sunken); }
.dl-box:focus-within { border-color: var(--c); box-shadow: 0 0 0 1px var(--c); }
.dl-cell.bad .dl-box { border-color: var(--danger); border-bottom-color: var(--danger); }
.dl-box input { border: 0; background: transparent; padding: 5px 8px; font: 17px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); min-width: 3ch; max-width: min(46ch, 78vw); outline: none; }
.dl-box input::placeholder { color: var(--ink-soft); opacity: .6; }
.dl-fixed { padding: 5px 8px; font: 17px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink); }
.dl-eq { font: 17px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); padding: 0 1px; }
.dl-enc { font: 11.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); padding: 3px 2px 0; min-height: 17px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 44ch; }
.dl-enc .pc { color: var(--warn); font-weight: 600; }
.dl-cell .msg { font-size: 11px; color: var(--danger); padding: 1px 2px 0; max-width: 32ch; white-space: normal; }
.dl-sep { font: 600 19px "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); padding: 19px 3px 0; align-self: flex-start; }
.dl-grip { border: 0; background: transparent; cursor: grab; color: var(--ink-soft); padding: 4px 3px; touch-action: none; font: 14px/1 "IBM Plex Mono", monospace; }
.dl-grip:active { cursor: grabbing; }
.dl-x { border: 0; background: transparent; cursor: pointer; color: var(--ink-soft); padding: 4px 6px; font-size: 14px; }
.dl-x:hover { color: var(--danger); }
.dl-add { align-self: flex-start; margin: 22px 0 0 4px; }
.dl-cell.dragging { opacity: .55; }
.dl-cell.drop-before .dl-box { box-shadow: -3px 0 0 var(--accent); }
.dl-cell.drop-after .dl-box { box-shadow: 3px 0 0 var(--accent); }
.dl-cell.lit .dl-box, .dl-final span.lit, .dl-chip.lit { box-shadow: 0 0 0 2px var(--c); }
.dl-ribbons { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0; }
.dl-ribbons path { fill: var(--c); fill-opacity: calc(var(--fill-alpha) * .9); stroke: none; }

/* the encoded link */
.dl-final { position: relative; z-index: 1; margin-top: 46px; padding: 9px 10px; border: 1px solid var(--line); border-radius: 5px; background: var(--sunken);
  font: 16px/1.5 "IBM Plex Mono", ui-monospace, monospace; word-break: break-all; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; }
.dl-final .url { flex: 1 1 auto; min-width: 0; }
.dl-final span[data-part] { color: var(--c); border-radius: 2px; }
.dl-final .dl-d { color: var(--ink-soft); }
.dl-final .pc { text-decoration: underline; text-decoration-color: var(--warn); text-underline-offset: 3px; }
.dl-flabel { position: absolute; top: -18px; left: 2px; font-size: 10.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-soft); font-weight: 600; font-family: "IBM Plex Sans", sans-serif; }
.dl-warns:empty { display: none; }
.dl-warns { margin-top: 10px; border: 1px solid var(--warn); border-left-width: 3px; border-radius: 4px; padding: 5px 9px; font-size: 12px; }
.dl-warns div + div { margin-top: 3px; }
.dl-help { margin-top: 8px; font-size: 11.5px; color: var(--ink-soft); }

/* routes */
.dl-routes { padding: 10px; display: flex; flex-direction: column; gap: 12px; }
.dl-lane { display: grid; grid-template-columns: 92px minmax(0, 1.3fr) 22px minmax(0, 1fr) 22px minmax(0, 1fr); align-items: stretch; gap: 0; }
.dl-os { display: flex; flex-direction: column; justify-content: center; font-weight: 600; font-size: 13px; }
.dl-os small { font-weight: 400; color: var(--ink-soft); font-size: 11px; }
.dl-stage { border: 1px solid var(--line); border-radius: 5px; background: var(--sunken); padding: 6px 8px; min-width: 0; }
.dl-stage .t { font-size: 10.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-soft); font-weight: 600; margin-bottom: 4px; }
.dl-stage code { font: 11.5px/1.7 "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-soft); word-break: break-all; }
.dl-chip { display: inline-block; padding: 0 5px; border-radius: 3px; color: var(--ink); background: var(--surface); border: 1px solid var(--c); font: 11.5px/1.6 "IBM Plex Mono", ui-monospace, monospace; word-break: break-all; }
.dl-arrow { display: flex; align-items: center; justify-content: center; }
.dl-arrow svg { width: 20px; height: 12px; }
.dl-arrow path { fill: none; stroke: var(--ink-soft); stroke-width: 1.5; }
.dl-stage input { width: 100%; min-width: 0; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); font: 12px "IBM Plex Mono", ui-monospace, monospace; }
.dl-stage input + .t { margin-top: 6px; }
.dl-stage input.bad { border-color: var(--danger); }
.dl-out-ok, .dl-out-warn { margin-top: 6px; font-size: 11.5px; padding-left: 8px; border-left: 3px solid var(--ok); color: var(--ink); }
.dl-out-warn { border-left-color: var(--warn); }
@media (max-width: 700px) {
  .dl-lane { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .dl-arrow { transform: rotate(90deg); height: 16px; }
  .dl-box input, .dl-fixed, .dl-eq { font-size: 15px; }
  .dl-final { margin-top: 30px; }
}
.dl-out { min-width: 0; }
.dl-out .k-out { max-height: 420px; }
`;

const PART_VAR = { scheme: '--tool-scheme', host: '--tool-host', path: '--tool-path', query: '--tool-query', frag: '--tool-frag' };
const cvar = (kind) => `var(${PART_VAR[kind]})`;
// "%20" etc. marked in an encoded piece
const encNodes = (enc) => {
  const out = [];
  const re = /%[0-9A-F]{2}/gi;
  let i = 0, m;
  while ((m = re.exec(enc))) { if (m.index > i) out.push(enc.slice(i, m.index)); out.push(h('span', { class: 'pc' }, m[0])); i = m.index + m[0].length; }
  if (i < enc.length) out.push(enc.slice(i));
  return out;
};

export function page(root, ctx) {
  root.append(h('style', {}, CSS));
  const st = { drag: null };

  const kindSeg = h('span', { class: 'dl-seg', role: 'group', 'aria-label': 'Link type' },
    h('button', { 'data-v': 'scheme', onclick: () => ctx.set('kind', 'scheme') }, 'Custom scheme'),
    h('button', { 'data-v': 'https', onclick: () => ctx.set('kind', 'https') }, 'https App Link'));
  const lenOut = h('span', { class: 'dl-len' });
  const copyBtn = h('button', { class: 'k-btn k-primary', onclick: async () => {
    const u = ctx.result?.parts?.url; if (!u) return;
    let ok = false; try { await navigator.clipboard.writeText(u); ok = true; } catch { ok = false; }
    copyBtn.textContent = ok ? 'Copied' : 'Select it'; setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1200);
  } }, 'Copy link');
  const strip = h('div', { class: 'dl-strip' });
  const ribbons = sv('svg', { class: 'dl-ribbons', 'aria-hidden': 'true' });
  const finalUrl = h('span', { class: 'url' });
  const final = h('div', { class: 'dl-final', 'aria-label': 'The encoded link' }, h('span', { class: 'dl-flabel' }, 'encoded link'), finalUrl);
  const warns = h('div', { class: 'dl-warns', 'aria-live': 'polite' });
  const body = h('div', { class: 'dl-body' }, ribbons, strip, final, warns,
    h('div', { class: 'dl-help' }, 'Type raw text in the parts: the encoding is done for you. Drag a parameter by its grip, or focus the grip and use the arrow keys, to reorder it.'));
  const anat = h('section', { class: 'dl-panel dl-anat' },
    h('div', { class: 'dl-head' }, h('span', { class: 'dl-h' }, 'The link, part by part'), kindSeg,
      h('span', { class: 'dl-right' }, lenOut, copyBtn)), body);

  const routes = h('div', { class: 'dl-routes' });
  const routesPanel = h('section', { class: 'dl-panel' },
    h('div', { class: 'dl-head' }, h('span', { class: 'dl-h' }, 'Where it lands'), h('span', { class: 'dl-sub' }, 'what each platform checks, in the colours of the parts above')), routes);
  root.append(h('div', { class: 'dl' }, anat, routesPanel, h('div', { class: 'dl-out' }, ctx.outputs)));

  // ------------------------------------------------------------ editing
  const params = () => (Array.isArray(ctx.raw.params) ? ctx.raw.params.map((r) => ({ ...r })) : []);
  const setParam = (i, field, v) => { const rows = params(); if (!rows[i]) return; rows[i][field] = v; ctx.set('params', rows); };
  const moveParam = (from, to) => {
    const rows = params(); if (to < 0 || to >= rows.length || from === to) return;
    const [r] = rows.splice(from, 1); rows.splice(to, 0, r); ctx.set('params', rows);
  };
  const input = (id, value, placeholder, label, onInput) => {
    const el = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', 'data-id': id, placeholder, 'aria-label': label,
      oninput: (e) => { size(e.target); onInput(e.target.value); } });
    el.value = value ?? '';
    size(el);
    return el;
  };
  function size(el) { el.style.width = `calc(${Math.max(2, Math.min(42, (el.value || el.placeholder || '').length + 0.6))}ch + 16px)`; }

  // ------------------------------------------------------------ warnings -> parts
  function placeWarnings(res) {
    const at = {};
    const add = (id, w) => { (at[id] ||= []).push(w); };
    for (const w of res.warnings || []) {
      let m;
      if ((m = /^Parameter "([^"]*)"/.exec(w))) { const i = params().findIndex((r) => String(r.key).trim() === m[1]); add(i >= 0 ? `p${i}` : 'query', 'looks like a secret'); }
      else if (/^Host "/.test(w) || /needs a host/.test(w)) add('host', 'not a valid host');
      else if (/^Scheme "|scheme/i.test(w) && !/package/.test(w)) add('scheme', /capitals/.test(w) ? 'use lower case' : 'not usable');
      else if (/value but no name/.test(w)) params().forEach((r, i) => { if (!String(r.key ?? '').trim() && String(r.value ?? '').trim()) add(`p${i}`, 'needs a name'); });
    }
    return at;
  }

  // ------------------------------------------------------------ the strip
  function drawStrip(res) {
    const a = document.activeElement;
    const keep = a && a.dataset && a.dataset.id && strip.contains(a) ? { id: a.dataset.id, s: a.selectionStart, e: a.selectionEnd } : null;
    const P = res.parts;
    const raw = ctx.raw;
    const https = raw.kind === 'https';
    const bad = placeWarnings(res);
    strip.replaceChildren();
    const cell = (kind, id, label, boxKids, enc, extra) => {
      const c = h('div', { class: `dl-cell${bad[id] ? ' bad' : ''}`, style: `--c: ${cvar(kind)}`, 'data-part': id },
        h('div', { class: 'lab' }, label), h('div', { class: 'dl-box' }, boxKids),
        h('div', { class: 'dl-enc' }, enc != null ? encNodes(enc) : ''),
        bad[id] ? h('div', { class: 'msg' }, bad[id].join('; ')) : null, extra);
      c.addEventListener('mouseenter', () => light(id)); c.addEventListener('mouseleave', () => light(null));
      strip.append(c);
      return c;
    };
    const sep = (t) => strip.append(h('span', { class: 'dl-sep', 'aria-hidden': 'true' }, t));
    const differs = (t, e) => (e != null && e !== t ? e : null);

    // scheme
    if (https) cell('scheme', 'scheme', 'scheme', h('span', { class: 'dl-fixed' }, 'https'), null);
    else cell('scheme', 'scheme', 'scheme', input('scheme', raw.scheme, 'myapp', 'Scheme', (v) => ctx.set('scheme', v)), P && differs(String(raw.scheme || '').trim(), P.scheme));
    sep('://');
    // host
    const hostLabel = P && P.hostFromPath ? h('span', {}, 'host ', h('i', {}, `(none: "${P.authority}" is read as host)`)) : 'host';
    cell('host', 'host', hostLabel, input('host', raw.host, https ? 'shop.example.com' : 'optional', 'Host', (v) => ctx.set('host', v)),
      P && P.host ? differs(String(raw.host || '').trim(), P.host) : null);
    // path
    const typedPath = String(raw.path || '').trim();
    cell('path', 'path', 'path', input('path', raw.path, '/screen/42', 'Path', (v) => ctx.set('path', v)),
      P ? differs(typedPath.startsWith('/') || !typedPath ? typedPath : '/' + typedPath, P.hostFromPath ? P.pathEnc : P.pathEnc) : null);
    // query
    const rows = params();
    let j = 0;
    rows.forEach((r, i) => {
      sep(i === 0 ? '?' : '&');
      const q = String(r.key ?? '').trim() && P ? P.query[j++] : null;
      const grip = h('button', { class: 'dl-grip', 'data-id': `g${i}`, title: 'Drag to reorder; arrow keys move it', 'aria-label': `Move parameter ${i + 1}; arrow keys` }, '⋮⋮');
      grip.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); st.refocus = `g${i - 1}`; moveParam(i, i - 1); }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); st.refocus = `g${i + 1}`; moveParam(i, i + 1); }
      });
      grip.addEventListener('pointerdown', (e) => startDrag(e, i));
      const enc = q ? `${q.keyEnc}=${q.valueEnc}` : null;
      const typed = `${String(r.key ?? '').trim()}=${r.value ?? ''}`;
      cell('query', `p${i}`, `parameter ${i + 1}`, [grip,
        input(`k${i}`, r.key, 'name', `Parameter ${i + 1} name`, (v) => setParam(i, 'key', v)),
        h('span', { class: 'dl-eq' }, '='),
        input(`v${i}`, r.value, 'value', `Parameter ${i + 1} value`, (v) => setParam(i, 'value', v)),
        h('button', { class: 'dl-x', title: 'Remove this parameter', 'aria-label': `Remove parameter ${i + 1}`, onclick: () => { const x = params(); x.splice(i, 1); ctx.set('params', x); } }, '×')],
      enc && enc !== typed ? enc : null);
    });
    strip.append(h('button', { class: 'k-btn dl-add', onclick: () => { const x = params(); x.push({ key: '', value: '' }); st.refocus = `k${x.length - 1}`; ctx.set('params', x); } }, rows.length ? '+ parameter' : '? + parameter'));
    // fragment
    sep('#');
    const fr = String(raw.fragment || '').trim().replace(/^#/, '');
    cell('frag', 'frag', 'fragment', input('fragment', raw.fragment, 'optional', 'Fragment', (v) => ctx.set('fragment', v)), P && P.fragment ? differs(fr, P.fragment.enc) : null);

    const want = st.refocus || (keep && keep.id);
    st.refocus = null;
    if (want) {
      const el = strip.querySelector(`[data-id="${want}"]`);
      if (el) { el.focus({ preventScroll: true }); if (keep && keep.id === want && el.setSelectionRange && keep.s != null) try { el.setSelectionRange(keep.s, keep.e); } catch { /* not a text field */ } }
    }
  }

  // drag a parameter chip along the strip
  function startDrag(e, i) {
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const cells = [...strip.querySelectorAll('.dl-cell[data-part^="p"]')];
    cells[i].classList.add('dragging');
    st.drag = { i, to: i };
    const move = (ev) => {
      // the chip whose centre is nearest the pointer takes the dragged one's place
      let to = i, best = Infinity;
      cells.forEach((c, k) => {
        const r = c.getBoundingClientRect();
        const dd = Math.hypot(ev.clientX - (r.left + r.width / 2), (ev.clientY - (r.top + r.height / 2)) * 2);
        if (dd < best) { best = dd; to = k; }
      });
      st.drag.to = to;
      cells.forEach((c, k) => { c.classList.toggle('drop-before', k === to && to < i); c.classList.toggle('drop-after', k === to && to > i); });
    };
    const up = () => {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
      const { to } = st.drag; st.drag = null;
      cells.forEach((c) => c.classList.remove('dragging', 'drop-before', 'drop-after'));
      if (to !== i) { st.refocus = `g${to}`; moveParam(i, to); }
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  }

  // ------------------------------------------------------------ encoded link
  function drawFinal(res) {
    const P = res.parts;
    finalUrl.replaceChildren();
    if (!P) { finalUrl.append(h('span', { class: 'dl-d' }, 'fix the part marked above to see the link')); return; }
    const sp = (kind, id, text) => h('span', { 'data-part': id, style: `--c: ${cvar(kind)}` }, encNodes(text));
    const d = (t) => h('span', { class: 'dl-d' }, t);
    finalUrl.append(sp('scheme', 'scheme', P.scheme), d('://'));
    if (P.authorityEnc) finalUrl.append(sp(P.hostFromPath ? 'path' : 'host', P.hostFromPath ? 'path' : 'host', P.authorityEnc));
    if (P.pathEnc) finalUrl.append(sp('path', 'path', P.pathEnc));
    // map encoded query entries back to their raw rows
    const rows = params();
    let j = 0;
    rows.forEach((r, i) => {
      if (!String(r.key ?? '').trim()) return;
      const q = P.query[j++]; if (!q) return;
      finalUrl.append(d(j === 1 ? '?' : '&'), sp('query', `p${i}`, `${q.keyEnc}=${q.valueEnc}`));
    });
    if (P.fragment) finalUrl.append(d('#'), sp('frag', 'frag', P.fragment.enc));
    for (const s of finalUrl.querySelectorAll('[data-part]')) { s.addEventListener('mouseenter', () => light(s.dataset.part)); s.addEventListener('mouseleave', () => light(null)); }
  }

  // ribbons from each typed part down to its piece of the encoded link
  function drawRibbons() {
    ribbons.replaceChildren();
    const br = body.getBoundingClientRect();
    ribbons.setAttribute('viewBox', `0 0 ${br.width} ${br.height}`);
    const cells = [...strip.querySelectorAll('.dl-cell[data-part]')];
    if (!cells.length || br.width < 640) return;
    const tops = new Set(cells.map((c) => Math.round(c.getBoundingClientRect().top)));
    if (tops.size > 1) return; // the parts wrapped: ribbons would cross
    for (const c of cells) {
      const id = c.dataset.part;
      const s = finalUrl.querySelector(`[data-part="${id}"]`);
      if (!s) continue;
      const box = c.querySelector('.dl-box').getBoundingClientRect();
      const rs = s.getClientRects()[0]; if (!rs) continue;
      const x1 = box.left - br.left, x2 = box.right - br.left, y1 = box.bottom - br.top;
      const x3 = rs.left - br.left, x4 = rs.right - br.left, y2 = rs.top - br.top - 1;
      const ym = (y1 + y2) / 2;
      ribbons.append(sv('path', { style: `--c: ${getComputedStyle(c).getPropertyValue('--c')}`, 'data-part': id,
        d: `M${x1} ${y1} C${x1} ${ym} ${x3} ${ym} ${x3} ${y2} L${x4} ${y2} C${x4} ${ym} ${x2} ${ym} ${x2} ${y1} Z` }));
    }
  }
  new ResizeObserver(() => drawRibbons()).observe(body);

  function light(id) {
    for (const el of root.querySelectorAll('.dl-cell[data-part], .dl-final [data-part], .dl-chip[data-part]')) el.classList.toggle('lit', id != null && el.dataset.part === id);
    for (const p of ribbons.querySelectorAll('path')) p.style.fillOpacity = id == null ? '' : p.dataset.part === id ? '0.5' : '0.08';
  }

  // ------------------------------------------------------------ routes
  function drawRoutes(res) {
    const P = res.parts;
    const a = document.activeElement;
    const keep = a && a.dataset && a.dataset.id && routes.contains(a) ? { id: a.dataset.id, s: a.selectionStart, e: a.selectionEnd } : null;
    routes.replaceChildren();
    if (!P) { routes.append(h('div', { class: 'dl-sub' }, (res.warnings || []).join(' '))); return; }
    const chip = (kind, id, text) => {
      const c = h('span', { class: 'dl-chip', 'data-part': id, style: `--c: ${cvar(kind)}` }, text);
      c.addEventListener('mouseenter', () => light(id)); c.addEventListener('mouseleave', () => light(null));
      return c;
    };
    const arrow = () => h('div', { class: 'dl-arrow', 'aria-hidden': 'true' }, (() => { const s = sv('svg', { viewBox: '0 0 20 12' }); s.append(sv('path', { d: 'M1 6H18M13 1L18 6L13 11' })); return s; })());
    const code = (...kids) => h('code', {}, kids.flat(Infinity));
    const pkgBad = (res.warnings || []).some((w) => /Android package name/.test(w));
    const pkgIn = h('input', { type: 'text', spellcheck: 'false', 'data-id': 'pkg', 'aria-label': 'Android package', placeholder: 'com.example.shop', class: pkgBad ? 'bad' : null, oninput: (e) => ctx.set('pkg', e.target.value) });
    pkgIn.value = ctx.raw.pkg ?? '';
    const bundleIn = h('input', { type: 'text', spellcheck: 'false', 'data-id': 'bundle', 'aria-label': 'iOS bundle id', placeholder: P.pkg || 'com.example.shop', oninput: (e) => ctx.set('bundle', e.target.value) });
    bundleIn.value = ctx.raw.bundle ?? '';
    const teamIn = h('input', { type: 'text', spellcheck: 'false', 'data-id': 'team', 'aria-label': 'Apple Team ID', placeholder: 'ABCDE12345', oninput: (e) => ctx.set('team', e.target.value) });
    teamIn.value = ctx.raw.team ?? '';
    const f = P.filter;
    const hostKind = P.hostFromPath ? 'path' : 'host';

    const android = h('div', { class: 'dl-lane' },
      h('div', { class: 'dl-os' }, 'Android', h('small', {}, f.autoVerify ? 'App Link' : 'deep link')),
      h('div', { class: 'dl-stage' }, h('div', { class: 't' }, `intent-filter${f.autoVerify ? ' autoVerify' : ''}`),
        code('<data scheme=', chip('scheme', 'scheme', f.scheme),
          f.host ? [' host=', chip(hostKind, hostKind, f.host)] : '',
          f.pathPrefix ? [' pathPrefix=', chip('path', 'path', f.pathPrefix)] : '', ' />'),
        h('div', { class: f.autoVerify ? 'dl-out-ok' : 'dl-out-warn' }, f.autoVerify
          ? `Verified against https://${P.host}/.well-known/assetlinks.json`
          : 'Not verified: any app may claim this scheme, and Android shows a chooser.')),
      arrow(),
      h('div', { class: 'dl-stage' }, h('div', { class: 't' }, 'package'), pkgIn,
        h('div', { class: 'dl-out-ok', style: P.pkg ? '' : 'border-left-color: var(--warn)' }, P.pkg ? 'adb am start targets this app' : 'none: Android picks the app')),
      arrow(),
      h('div', { class: 'dl-stage' }, h('div', { class: 't' }, 'the app gets'),
        code('intent.data = ', h('br'), chip('scheme', 'scheme', P.url.length > 46 ? P.url.slice(0, 44) + '…' : P.url))));

    const ios = h('div', { class: 'dl-lane' },
      h('div', { class: 'dl-os' }, 'iOS', h('small', {}, P.https ? 'Universal Link' : 'URL scheme')),
      P.https
        ? h('div', { class: 'dl-stage' }, h('div', { class: 't' }, 'apple-app-site-association'),
          code('on ', chip('host', 'host', P.host), h('br'), 'appIDs ', h('span', { class: 'dl-chip', style: '--c: var(--line)' }, P.ios.appID), h('br'), 'components ', chip('path', 'path', P.ios.components)),
          h('div', { class: P.ios.teamSet ? 'dl-out-ok' : 'dl-out-warn' }, P.ios.teamSet ? `Associated Domains: applinks:${P.host}` : 'Set the Team ID: TEAMID1234 is a placeholder.'))
        : h('div', { class: 'dl-stage' }, h('div', { class: 't' }, 'Info.plist CFBundleURLSchemes'),
          code('<string>', chip('scheme', 'scheme', P.ios.urlScheme), '</string>'),
          h('div', { class: 'dl-out-warn' }, 'Any app can register the same scheme; iOS picks one.')),
      arrow(),
      h('div', { class: 'dl-stage' }, h('div', { class: 't' }, 'bundle id'), bundleIn,
        P.https ? [h('div', { class: 't' }, 'team id'), teamIn] : null),
      arrow(),
      h('div', { class: 'dl-stage' }, h('div', { class: 't' }, 'the app gets'),
        code(P.https ? 'scene(_:continue:) userActivity.webpageURL' : 'scene(_:openURLContexts:) url', ' =', h('br'), chip('scheme', 'scheme', P.url.length > 46 ? P.url.slice(0, 44) + '…' : P.url))));
    routes.append(android, ios);
    if (keep) { const el = routes.querySelector(`[data-id="${keep.id}"]`); if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(keep.s, keep.e); } catch { /* ok */ } } }
  }

  // ------------------------------------------------------------ sync
  ctx.onResult((res) => {
    res = res || {};
    for (const b of kindSeg.children) b.setAttribute('aria-pressed', String(b.dataset.v === (ctx.raw.kind || 'scheme')));
    const P = res.parts;
    lenOut.textContent = P ? `${P.url.length} chars` : '';
    lenOut.classList.toggle('bad', !!P && P.url.length > 2000);
    copyBtn.disabled = !P;
    drawStrip(res);
    drawFinal(res);
    warns.replaceChildren(...(res.warnings || []).map((w) => h('div', {}, w)));
    drawRoutes(res);
    requestAnimationFrame(drawRibbons);
  });
}
