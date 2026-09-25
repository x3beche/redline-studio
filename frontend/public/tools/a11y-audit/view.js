// Accessibility Audit page: the markup and the page it makes, side by side.
// Left, the HTML itself with every problem marked on its line; middle, the
// page as a keyboard and screen-reader user meets it - each element with its
// role, its accessible name, its text in its own colours, and the Tab path
// drawn as arcs between the stops (step through it with Tab / Shift+Tab);
// right, the selected element's problems with the fixes that can be applied
// to the markup in one click. Every number comes from run().

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, html) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LH = 19; // editor line height, px

// What a screen reader calls each kind of element.
function roleOf(b) {
  if (b.tag === '#text') return 'text';
  if (b.land) return b.land;
  if (b.role) return b.role === 'button' ? 'button' : b.role;
  if (/^h[1-6]$/.test(b.tag)) return `heading ${b.tag[1]}`;
  if (b.tag === 'a') return 'link';
  if (b.tag === 'button') return 'button';
  if (b.tag === 'img') return 'image';
  if (b.tag === 'select') return 'combo box';
  if (b.tag === 'textarea') return 'edit text';
  if (b.tag === 'label') return 'label';
  if (b.tag === 'li') return 'list item';
  if (b.tag === 'input') {
    const t = b.type || 'text';
    return { checkbox: 'checkbox', radio: 'radio button', password: 'password edit', number: 'spin button', range: 'slider', submit: 'button', button: 'button', reset: 'button', search: 'search edit', file: 'file button' }[t] || 'edit text';
  }
  if (b.onclick) return 'clickable ' + b.tag;
  return 'text';
}
const said = (b) => {
  const r = roleOf(b);
  const n = b.name != null ? b.name : b.text;
  return `${n ? `“${n}”` : '(no name)'}, ${r}${r === 'checkbox' ? ', not checked' : ''}`;
};

function highlight(line) {
  // light markup colouring on escaped text: tags, attribute names, values
  return esc(line)
    .replace(/(&lt;\/?)([a-zA-Z][\w:-]*)/g, '$1<b class="t">$2</b>')
    .replace(/([\w:-]+)=(&quot;[^&]*?&quot;|'[^']*?')/g, '<i class="a">$1</i>=<i class="v">$2</i>');
}

export function page(root, ctx) {
  // ---------------- DOM ----------------
  const score = el('div', { class: 'aa-score', 'aria-live': 'polite' });
  const lvl = el('div', { class: 'aa-seg', role: 'group', 'aria-label': 'Contrast level' }, '<button data-l="AA">AA</button><button data-l="AAA">AAA</button>');
  lvl.addEventListener('click', (e) => { const l = e.target.closest('[data-l]')?.dataset.l; if (l) ctx.set('level', l); });
  const colours = el('div', { class: 'aa-cols' });
  const colIn = {};
  for (const [key, label] of [['textColor', 'Text'], ['pageBg', 'Page']]) {
    const w = el('label', { class: 'aa-col', title: key === 'textColor' ? 'Default text colour the page CSS gives body text' : 'Page background' });
    const pick = el('input', { type: 'color', 'aria-label': `${label} colour picker` });
    const txt = el('input', { type: 'text', spellcheck: 'false', 'aria-label': key === 'textColor' ? 'Default text colour' : 'Page background colour' });
    pick.addEventListener('input', () => { txt.value = pick.value; ctx.set(key, pick.value); });
    txt.addEventListener('input', () => ctx.set(key, txt.value));
    w.append(el('span', {}, label), pick, txt);
    colours.append(w);
    colIn[key] = { pick, txt };
  }
  const top = el('div', { class: 'aa-top' });
  top.append(score, el('span', { class: 'aa-sp' }), el('span', { class: 'aa-lab' }, 'Contrast'), lvl, el('span', { class: 'aa-lab' }, 'Defaults'), colours);

  // source
  const srcCard = el('section', { class: 'aa-card aa-src' });
  const srcHead = el('div', { class: 'aa-head' }, '<h2>Markup</h2><span class="aa-dim">paste or type · problems marked on their line</span>');
  const ed = el('div', { class: 'aa-ed' });
  const gut = el('div', { class: 'aa-gut', 'aria-hidden': 'true' });
  const gutIn = el('div', { class: 'aa-gut-in' });
  gut.append(gutIn);
  const code = el('div', { class: 'aa-code' });
  const hl = el('pre', { class: 'aa-hl', 'aria-hidden': 'true' });
  const ta = el('textarea', { class: 'aa-ta', spellcheck: 'false', wrap: 'off', 'aria-label': 'HTML to audit', autocapitalize: 'off', autocomplete: 'off' });
  code.append(hl, ta);
  ed.append(gut, code);
  srcCard.append(srcHead, ed);

  // the page as met
  const treeCard = el('section', { class: 'aa-card aa-treecard' });
  const tabBar = el('div', { class: 'aa-head aa-tabbar' });
  const prevB = el('button', { class: 'aa-btn', title: 'Previous Tab stop (Shift+Tab)' }, '⇤ Shift+Tab');
  const nextB = el('button', { class: 'aa-btn aa-pri', title: 'Next Tab stop (Tab)' }, 'Tab ⇥');
  const stopLab = el('span', { class: 'aa-stop' });
  tabBar.append(el('h2', {}, 'As a keyboard and screen reader meet it'), el('span', { class: 'aa-sp' }), prevB, nextB, stopLab);
  const sayBox = el('div', { class: 'aa-say', 'aria-live': 'polite' });
  const treeWrap = el('div', { class: 'aa-treewrap' });
  const tree = el('div', { class: 'aa-tree', role: 'listbox', 'aria-label': 'Elements in reading order; ←/→ step the Tab stops' , tabindex: '0' });
  const path = document.createElementNS(SVGNS, 'svg');
  path.setAttribute('class', 'aa-path'); path.setAttribute('aria-hidden', 'true');
  treeWrap.append(tree, path);
  const legend = el('div', { class: 'aa-legend' },
    '<span><i class="lg-e"></i>error</span><span><i class="lg-w"></i>warning</span><span><i class="lg-tab">1</i>Tab stop</span><span><i class="lg-arc"></i>Tab path</span><span><i class="lg-back"></i>jumps back up</span><span><i class="lg-aa">Aa</i>text in its colours · ratio</span>');
  treeCard.append(tabBar, sayBox, treeWrap, legend);

  // inspector
  const insp = el('section', { class: 'aa-card aa-insp' });
  const inspBody = el('div', { class: 'aa-inspbody', 'aria-live': 'polite' });
  const listHead = el('div', { class: 'aa-head' }, '<h2>All problems</h2>');
  const list = el('div', { class: 'aa-list' });
  const warns = el('div', { class: 'aa-warns' });
  insp.append(inspBody, listHead, list, warns);

  const outCol = el('div', { class: 'aa-out' });
  const notes = el('details', { class: 'aa-notes' });
  outCol.append(ctx.outputs, notes);

  const grid = el('div', { class: 'aa' });
  grid.append(top, srcCard, treeCard, insp, outCol);
  root.append(grid);

  // ---------------- state ----------------
  let sel = null;      // selected block index (into view.blocks) or {issue: k}
  let selIssue = null; // selected issue index
  let stop = 0;        // current Tab stop (1-based, 0 = none)
  const V = () => ctx.result?.view || null;

  // ---------------- source editor ----------------
  let typing = null;
  ta.addEventListener('input', () => {
    drawSource();
    clearTimeout(typing);
    typing = setTimeout(() => ctx.set('html', ta.value), 160);
  });
  ta.addEventListener('scroll', syncScroll);
  function syncScroll() {
    hl.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    gutIn.style.transform = `translateY(${-ta.scrollTop}px)`;
  }
  ta.addEventListener('click', () => {
    const line = ta.value.slice(0, ta.selectionStart).split('\n').length;
    const v = V(); if (!v) return;
    const bi = v.blocks.findIndex((b) => b.line === line && b.tag !== '#text');
    const ii = v.issues.findIndex((i) => i.line === line);
    if (bi >= 0) selectBlock(bi, false);
    else if (ii >= 0) selectIssue(ii, false);
  });
  function lineMarks() {
    const v = V(), m = new Map();
    if (!v) return m;
    for (const it of v.issues) {
      if (it.line == null) continue;
      const cur = m.get(it.line);
      m.set(it.line, cur === 'e' || it.sev === 'error' ? 'e' : 'w');
    }
    return m;
  }
  function selLines() {
    const v = V(), out = new Set();
    if (!v) return out;
    if (sel != null && v.blocks[sel]) out.add(v.blocks[sel].line);
    if (selIssue != null && v.issues[selIssue]?.line) out.add(v.issues[selIssue].line);
    return out;
  }
  function drawSource() {
    const lines = ta.value.split('\n');
    const marks = lineMarks(), sl = selLines();
    const v = V();
    const counts = new Map();
    if (v) for (const it of v.issues) if (it.line != null) counts.set(it.line, (counts.get(it.line) || 0) + 1);
    hl.innerHTML = lines.map((l, k) => {
      const n = k + 1, m = marks.get(n);
      return `<span class="ln${m ? ` m${m}` : ''}${sl.has(n) ? ' sel' : ''}">${highlight(l) || ' '}</span>`;
    }).join('');
    gutIn.innerHTML = lines.map((_, k) => {
      const n = k + 1, m = marks.get(n), c = counts.get(n);
      return `<div class="g${sl.has(n) ? ' sel' : ''}">${m ? `<i class="d${m}" title="${c} problem${c > 1 ? 's' : ''}">${c > 1 ? c : ''}</i>` : ''}<span>${n}</span></div>`;
    }).join('');
    syncScroll();
  }
  function revealLine(n) {
    const y = (n - 1) * LH;
    if (y < ta.scrollTop + 8 || y > ta.scrollTop + ta.clientHeight - 3 * LH) ta.scrollTop = Math.max(0, y - ta.clientHeight / 3);
    syncScroll();
  }

  // ---------------- the tree ----------------
  function chip(p) {
    if (!p) return '';
    const cls = p.disabled ? 'ex' : p.ok ? 'ok' : p.r < p.need * 0.75 ? 'bad' : 'warn';
    return `<span class="aa-aa ${cls}" title="${esc(p.fg)} on ${esc(p.bg)} · ${p.r.toFixed(2)}:1, needs ${p.need}:1${p.large ? ' (large text)' : ''}"><b style="color:${esc(p.fg)};background:${esc(p.bg)}">Aa</b>${p.r.toFixed(1)}</span>`;
  }
  function drawTree() {
    const v = V();
    if (!v) { tree.innerHTML = `<div class="aa-empty">${esc(ctx.result?.warnings?.[0] || 'Paste some HTML.')}</div>`; path.innerHTML = ''; return; }
    const cur = stop ? v.order[stop - 1] : null;
    tree.innerHTML = v.blocks.map((b, k) => {
      const iss = b.issues.map((i) => v.issues[i]);
      const ne = iss.filter((i) => i.sev === 'error').length, nw = iss.length - ne;
      const p = b.pair != null ? v.pairs[b.pair] : null;
      const role = roleOf(b);
      const interactive = b.name != null;
      let body;
      if (b.land) body = `<span class="aa-land">${esc(b.el)}</span>`;
      else if (interactive && b.tag !== 'label') body = b.name ? `<span class="aa-name">“${esc(b.name)}”</span>` : '<span class="aa-noname">no name</span>';
      else body = p ? `<span class="aa-txt" style="color:${esc(p.fg)};background:${esc(p.bg)}">${esc(b.text)}</span>` : `<span class="aa-plain">${esc(b.text)}</span>`;
      if (interactive && b.text && b.text !== b.name && p) body += ` <span class="aa-txt sm" style="color:${esc(p.fg)};background:${esc(p.bg)}">${esc(b.text)}</span>`;
      const isCur = b.i != null && b.i === cur;
      const unreachable = b.onclick && b.tab == null;
      return `<div class="aa-row${k === sel ? ' sel' : ''}${isCur ? ' cur' : ''}${b.land ? ' land' : ''}${b.hidden ? ' hid' : ''}${ne ? ' re' : nw ? ' rw' : ''}" role="option" aria-selected="${k === sel}" data-b="${k}" style="--d:${b.depth}">
        <span class="aa-tab${b.tab ? '' : ' none'}${b.tabindex > 0 ? ' pos' : ''}${unreachable ? ' unr' : ''}" data-tab="${b.tab || ''}">${b.tab || (unreachable ? '✕' : '')}</span>
        <span class="aa-role${role.startsWith('heading') ? ' h' : ''}">${esc(role)}</span>
        <span class="aa-body">${body}</span>
        ${chip(p)}
        <span class="aa-marks">${ne ? `<i class="me">${ne}</i>` : ''}${nw ? `<i class="mw">${nw}</i>` : ''}</span>
        <span class="aa-line">${b.line}</span></div>`;
    }).join('');
    requestAnimationFrame(drawPath);
  }
  // The Tab path: arcs in the right gutter from each stop to the next.
  function drawPath() {
    const v = V(); if (!v) return;
    const wr = treeWrap.getBoundingClientRect();
    const W = treeWrap.clientWidth, H = tree.scrollHeight;
    path.setAttribute('viewBox', `0 0 ${W} ${H}`);
    path.style.height = `${H}px`;
    const pos = new Map();
    for (const r of tree.querySelectorAll('.aa-row')) {
      const b = v.blocks[+r.dataset.b];
      if (!b.tab) continue;
      const t = r.querySelector('.aa-tab').getBoundingClientRect();
      pos.set(b.tab, { x: t.left - wr.left + t.width / 2, y: t.top - wr.top + tree.scrollTop + t.height / 2, xr: t.left - wr.left });
    }
    const out = [];
    const gx = 10; // arcs swing out to the left of the badges
    for (let k = 1; k < v.order.length; k++) {
      const a = pos.get(k), b = pos.get(k + 1);
      if (!a || !b) continue;
      const back = b.y < a.y;
      const span = Math.abs(b.y - a.y);
      const bulge = Math.min(a.xr - 3, gx + Math.min(44, span * 0.16));
      const cx = a.xr - bulge;
      const on = stop && (k === stop || k + 1 === stop);
      out.push(`<path class="arc${back ? ' back' : ''}${on ? ' on' : ''}" d="M${a.xr} ${a.y}C${cx} ${a.y} ${cx} ${b.y} ${b.xr} ${b.y}" marker-end="url(#aa-ah${back ? 'b' : ''})"/>`);
    }
    path.innerHTML = `<defs><marker id="aa-ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" class="ah"/></marker><marker id="aa-ahb" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" class="ahb"/></marker></defs>${out.join('')}`;
  }
  tree.addEventListener('click', (e) => {
    const r = e.target.closest('.aa-row'); if (!r) return;
    selectBlock(+r.dataset.b, true);
  });
  tree.addEventListener('keydown', (e) => {
    const v = V(); if (!v) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = clampI((sel ?? -1) + (e.key === 'ArrowDown' ? 1 : -1), 0, v.blocks.length - 1);
      selectBlock(n, true);
    }
  });
  const clampI = (x, a, b) => Math.max(a, Math.min(b, x));
  prevB.addEventListener('click', () => step(-1));
  nextB.addEventListener('click', () => step(1));
  function step(d) {
    const v = V(); if (!v || !v.order.length) return;
    stop = stop ? ((stop - 1 + d + v.order.length) % v.order.length) + 1 : d > 0 ? 1 : v.order.length;
    const bi = v.blocks.findIndex((b) => b.i === v.order[stop - 1]);
    selectBlock(bi, true, true);
  }

  function selectBlock(k, reveal, fromTab = false) {
    const v = V(); if (!v || k < 0) return;
    sel = k; selIssue = v.blocks[k].issues[0] ?? null;
    if (!fromTab) { const b = v.blocks[k]; stop = b.tab || stop; }
    redrawSel();
    if (reveal) revealLine(v.blocks[k].line);
    tree.querySelector(`[data-b="${k}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  function selectIssue(i, reveal) {
    const v = V(); if (!v) return;
    selIssue = i;
    const it = v.issues[i];
    const bk = it.el != null ? v.blocks.findIndex((b) => b.i === it.el) : -1;
    sel = bk >= 0 ? bk : null;
    redrawSel();
    if (reveal && it.line) revealLine(it.line);
    if (sel != null) tree.querySelector(`[data-b="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  function redrawSel() { drawSource(); drawTree(); drawInspector(); drawSay(); }

  function drawSay() {
    const v = V();
    const n = v?.order.length || 0;
    stopLab.textContent = n ? (stop ? `stop ${stop} of ${n}` : `${n} stops`) : 'nothing focusable';
    const b = sel != null ? v?.blocks[sel] : null;
    if (!b) { sayBox.innerHTML = '<span class="aa-dim">Press Tab ⇥ to walk the focus order, or click an element.</span>'; return; }
    const r = roleOf(b);
    sayBox.innerHTML = `<span class="aa-dim">Screen reader:</span> <b class="${(b.name === '' || (b.name == null && !b.text)) ? 'bad' : ''}">${esc(said(b))}</b>${b.tab ? ` <span class="aa-dim">· Tab stop ${b.tab}${b.tabindex > 0 ? ` (tabindex ${esc(b.tabindex)} pulls it forward)` : ''}</span>` : b.onclick ? ' <span class="bad">· Tab never reaches it</span>' : ''}${r === 'text' ? '' : ''}`;
  }

  // ---------------- inspector: problems and fixes ----------------
  // Fixes that are a plain edit of the markup, applied to the source text.
  function quickFix(it, v) {
    const src = ctx.raw.html || '';
    const lines = src.split('\n');
    const onLine = (n, re, rep) => {
      if (!n) return null;
      const l = lines[n - 1]; if (l == null || !re.test(l)) return null;
      const nl = [...lines]; nl[n - 1] = l.replace(re, rep); return nl.join('\n');
    };
    if (/^Page has no language/.test(it.rule)) {
      const t = src.replace(/<html(\s|>)/i, (m, c) => `<html lang="en"${c}`);
      return t !== src ? { label: 'Add lang="en"', html: t } : null;
    }
    if (/^Positive tabindex/.test(it.rule)) { const t = onLine(it.line, /tabindex\s*=\s*["']?\d+["']?/i, 'tabindex="0"'); return t ? { label: 'Set tabindex="0"', html: t } : null; }
    if (/^Image without alt/.test(it.rule)) { const t = onLine(it.line, /<img(\s)/i, '<img alt=""$1'); return t ? { label: 'Mark decorative: alt=""', html: t } : null; }
    if (/^Clickable <div> not reachable/.test(it.rule)) { const t = onLine(it.line, /<div(\s)/i, '<div role="button" tabindex="0"$1'); return t ? { label: 'Add role="button" tabindex="0"', html: t } : null; }
    if (/^Low contrast/.test(it.rule)) {
      const p = v.pairs.find((q) => q.el === it.el && !q.ok);
      if (!p || !p.fix) return null;
      if (p.fgRaw) {
        const re = new RegExp(`(color\\s*:\\s*)${reEsc(p.fgRaw)}(?![\\w-])`, 'gi');
        const t = src.replace(re, `$1${p.fix.hex}`);
        return t !== src ? { label: `Use ${p.fix.hex} (${p.fix.ratio.toFixed(2)}:1)`, html: t, swatch: p.fix.hex } : null;
      }
      return { label: `Default text ${p.fix.hex} (${p.fix.ratio.toFixed(2)}:1)`, set: { textColor: p.fix.hex }, swatch: p.fix.hex };
    }
    return null;
  }
  function ratioBar(p) {
    // 1..21 on a log scale, with the AA / AAA needs marked
    const X = (r) => (Math.log(r) / Math.log(21)) * 100;
    const marks = [[3, '3'], [4.5, '4.5'], [7, '7']];
    return `<div class="aa-rbar"><div class="aa-rtrack">${marks.map(([r, t]) => `<i class="mk${r === p.need ? ' need' : ''}" style="left:${X(r)}%"><em>${t}</em></i>`).join('')}<b class="pt ${p.ok ? 'ok' : 'bad'}" style="left:${X(p.r)}%"></b>${p.fix ? `<b class="pt fx" style="left:${X(p.fix.ratio)}%"></b>` : ''}</div><div class="aa-rnum"><span>1</span><span>${p.r.toFixed(2)}:1 · needs ${p.need}:1</span><span>21</span></div></div>`;
  }
  function drawInspector() {
    const v = V();
    if (!v) { inspBody.innerHTML = ''; list.innerHTML = ''; return; }
    const b = sel != null ? v.blocks[sel] : null;
    const its = b ? b.issues : selIssue != null ? [selIssue] : [];
    let html = '';
    if (b) {
      html += `<div class="aa-ihead"><code>${esc(b.el || '(text)')}</code><span>line ${b.line}</span></div>`;
      html += `<dl class="aa-idl"><dt>Role</dt><dd>${esc(roleOf(b))}</dd>${b.name != null ? `<dt>Name</dt><dd>${b.name ? `“${esc(b.name)}”` : '<span class="bad">none</span>'}</dd>` : ''}<dt>Tab</dt><dd>${b.tab ? `stop ${b.tab} of ${v.order.length}` : b.onclick ? '<span class="bad">not reachable</span>' : 'not a stop'}</dd></dl>`;
      const p = b.pair != null ? v.pairs[b.pair] : null;
      if (p) {
        html += `<div class="aa-sw"><div class="aa-swbox" style="color:${esc(p.fg)};background:${esc(p.bg)};${p.large ? 'font-size:20px;' : ''}${p.bold ? 'font-weight:700;' : ''}">${esc(p.text.slice(0, 38))}</div>
          ${p.fix ? `<div class="aa-swbox" style="color:${esc(p.fix.hex)};background:${esc(p.bg)};${p.large ? 'font-size:20px;' : ''}${p.bold ? 'font-weight:700;' : ''}">${esc(p.text.slice(0, 38))}</div>` : ''}
          <div class="aa-swlab"><span>${esc(p.fg)} on ${esc(p.bg)} · ${Math.round(p.px * 10) / 10} px${p.bold ? ' bold' : ''}${p.large ? ' (large)' : ''}</span>${p.fix ? `<span>→ ${esc(p.fix.hex)}</span>` : ''}</div>${ratioBar(p)}</div>`;
      }
    } else if (!its.length) {
      html += `<div class="aa-ihead"><b>${v.errors ? `${v.errors} error${v.errors > 1 ? 's' : ''} and ${v.warnings} warning${v.warnings === 1 ? '' : 's'}` : v.warnings ? `${v.warnings} warning${v.warnings > 1 ? 's' : ''}` : 'No problems found by these checks'}</b></div><p class="aa-dim">Click an element, a marked line or a problem below.</p>`;
    }
    if (its.length) {
      html += its.map((k) => {
        const it = v.issues[k], q = quickFix(it, v);
        return `<div class="aa-iss ${it.sev === 'error' ? 'e' : 'w'}"><div class="aa-irule"><i></i>${esc(it.rule)} <span class="aa-wc">WCAG ${esc(it.wcag)}</span></div><div class="aa-why">${esc(it.why)}</div><div class="aa-fix"><b>Fix:</b> ${esc(it.fix)}</div>${q ? `<button class="aa-apply" data-fix="${k}">${q.swatch ? `<i style="background:${esc(q.swatch)}"></i>` : ''}Apply: ${esc(q.label)}</button>` : ''}</div>`;
      }).join('');
    } else if (b) html += '<div class="aa-okmsg">No problems on this element.</div>';
    inspBody.innerHTML = html;
    listHead.innerHTML = `<h2>All problems</h2><span class="aa-dim">${v.issues.length}</span>`;
    list.innerHTML = v.issues.length ? v.issues.map((it, k) => `<button class="aa-li ${it.sev === 'error' ? 'e' : 'w'}${k === selIssue ? ' sel' : ''}" data-i="${k}"><i></i><span>${esc(it.rule)}</span><em>${it.line ?? 'CSS'}</em></button>`).join('') : '<div class="aa-okmsg">Nothing found. Check the live page with axe as well.</div>';
    const res = ctx.result || {};
    warns.innerHTML = (res.warnings || []).map((w) => `<div>${esc(w)}</div>`).join('');
    notes.innerHTML = `<summary>What this reads and what it cannot (${(res.notes || []).length})</summary>${(res.notes || []).map((n) => `<div>${esc(n)}</div>`).join('')}`;
  }
  inspBody.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fix]'); if (!b) return;
    const v = V(); const it = v.issues[+b.dataset.fix]; const q = quickFix(it, v);
    if (!q) return;
    if (q.set) ctx.setMany(q.set); else { ta.value = q.html; ctx.set('html', q.html); }
  });
  list.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) selectIssue(+b.dataset.i, true); });

  // ---------------- score strip ----------------
  function drawTop() {
    const v = V(), inp = ctx.input, raw = ctx.raw;
    for (const b of lvl.querySelectorAll('[data-l]')) b.setAttribute('aria-pressed', String(b.dataset.l === (inp.level || 'AA')));
    for (const [k, { pick, txt }] of Object.entries(colIn)) {
      if (document.activeElement !== txt) txt.value = raw[k] ?? '';
      const m = /^#([0-9a-f]{6})$/i.exec(String(raw[k] || '').trim()) || /^#([0-9a-f]{3})$/i.exec(String(raw[k] || '').trim());
      if (m) pick.value = m[1].length === 3 ? '#' + [...m[1]].map((c) => c + c).join('') : '#' + m[1];
    }
    if (!v) { score.innerHTML = ''; return; }
    const vals = ctx.result.values || [];
    const pass = vals.find((x) => /contrast/i.test(x.label));
    const failing = v.pairs.filter((p) => !p.ok).length;
    score.innerHTML = `<span class="sc ${v.errors ? 'e' : 'ok'}"><b>${v.errors}</b> errors</span><span class="sc ${v.warnings ? 'w' : 'ok'}"><b>${v.warnings}</b> warnings</span><span class="sc ${failing ? 'e' : 'ok'}"><b>${esc(pass?.value ?? '')}</b> text ${esc(v.level)}</span><span class="sc"><b>${v.order.length}</b> Tab stops</span>`
      + (v.doc.lang === undefined ? '<span class="sc dim">fragment</span>' : `<span class="sc ${v.doc.lang ? '' : 'e'}">lang <b>${esc(v.doc.lang || 'none')}</b></span><span class="sc ${v.doc.title ? '' : 'e'}">title <b>${esc(v.doc.title || 'none')}</b></span>`);
  }

  // ---------------- wiring ----------------
  ctx.onResult(() => {
    const v = V();
    if (document.activeElement !== ta && ta.value !== (ctx.raw.html ?? '')) ta.value = ctx.raw.html ?? '';
    if (v) {
      if (sel != null && sel >= v.blocks.length) sel = null;
      if (selIssue != null && selIssue >= v.issues.length) selIssue = null;
      if (stop > v.order.length) stop = 0;
      if (sel == null && selIssue == null && v.issues.length) {
        // start on the first problem, so the first view shows a fix
        let k = v.issues.findIndex((i) => i.el != null && v.blocks.some((b) => b.i === i.el));
        if (k < 0) k = 0;
        selIssue = k; const bk = v.blocks.findIndex((b) => b.i === v.issues[k].el); sel = bk >= 0 ? bk : null;
      }
    }
    drawTop(); drawSource(); drawTree(); drawInspector(); drawSay();
  });
  new ResizeObserver(() => drawPath()).observe(treeWrap);
}
