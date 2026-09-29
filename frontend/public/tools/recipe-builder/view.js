// Recipe Builder & Linter, drawn as the recipe's anatomy: five blocks in the
// order a recipe reads - Header, Fetch, Build, Install, Packaging.
//   Build mode: every block is the recipe text with the values you choose as
//   slots in it (type straight into SUMMARY = "..."), the source kind and
//   build class as switches on the block, and the lines the choices generate
//   (S, inherit, do_install ...) drawn dim under them. A block lights up in
//   its colour when its required parts are there; the generated .bb is in
//   the output panel beside it.
//   Lint mode: the pasted .bb in an editor, every line tinted by the block it
//   belongs to, with a dot for each finding; the anatomy beside it shows each
//   block's parts and lines with the findings pinned under the line they
//   concern, each with its reason, the rule's source and a Fix button.
// Everything drawn comes from run()'s result.anatomy.

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

const SPDX = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'ISC', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only',
  'GPL-3.0-or-later', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'MPL-2.0', 'Zlib', 'CLOSED'];
const BUILDS = [['cmake', 'CMake'], ['meson', 'Meson'], ['autotools', 'Autotools'], ['setuptools3', 'setuptools'],
  ['go-mod', 'Go'], ['cargo', 'Cargo'], ['module', 'Kernel module'], ['make', 'Makefile']];
const CONFVAR = { cmake: 'EXTRA_OECMAKE', meson: 'EXTRA_OEMESON', autotools: 'EXTRA_OECONF', make: 'EXTRA_OEMAKE' };
const SEV = { error: 'error', warn: 'warning', info: 'note' };
const RELS = [['kirkstone', 'kirkstone 4.0'], ['scarthgap', 'scarthgap 5.0'], ['walnascar', 'walnascar 5.2+']];

export function page(root, ctx) {
  let res = null;
  let shape = '';
  let selLine = 0;
  const slots = {};

  // ---------- top bar ----------
  const seg = (items, key, cls = '') => h('div', { class: `rb-seg ${cls}`, role: 'group' }, items.map(([v, t]) =>
    h('button', { type: 'button', 'data-v': v, 'aria-pressed': String(String(ctx.raw[key]) === v), onclick: () => ctx.set(key, v) }, t)));
  const modeSeg = h('div', { class: 'rb-seg rb-mode', role: 'tablist' });
  const relSeg = h('div', { class: 'rb-seg', role: 'group', 'aria-label': 'Yocto release' });
  const counts = h('div', { class: 'rb-counts' });
  const fixAll = h('button', { class: 'k-btn k-primary', type: 'button', onclick: () => {
    if (res && res.anatomy.fixedCount) ctx.set('bb', res.anatomy.fixed);
  } }, 'Apply all fixes');
  const toLint = h('button', { class: 'k-btn', type: 'button', title: 'Carry this recipe to the linter as text and edit it there',
    onclick: () => { if (res) ctx.setMany({ mode: 'lint', bb: res.anatomy.text, bbname: res.anatomy.fileName }); } }, 'Edit as text');
  const top = h('div', { class: 'rb-top' }, modeSeg, h('div', { class: 'rb-rel' }, h('span', {}, 'Rules for'), relSeg), counts, h('div', { class: 'rb-acts' }, fixAll, toLint));

  const grid = h('div', { class: 'rb-grid' });
  const left = h('div', { class: 'rb-left' });
  const right = h('div', { class: 'rb-right' });
  grid.append(left, right);
  const notes = h('div', { class: 'rb-notes' });
  root.append(h('div', { class: 'rb' }, top, grid, notes));

  // ---------- helpers ----------
  const slot = (key, opts = {}) => {
    const el = h('input', { type: 'text', class: `rb-slot${opts.cls ? ' ' + opts.cls : ''}`, spellcheck: 'false', 'aria-label': opts.label || key,
      placeholder: opts.ph || '', list: opts.list || null, size: 4,
      oninput: (e) => { fit(e.target); ctx.set(key, e.target.value); } });
    el.value = ctx.raw[key] ?? '';
    fit(el);
    slots[key] = el;
    return el;
  };
  function fit(el) { el.style.width = `${Math.max(el.value.length, (el.placeholder || '').length, 4) + (el.getAttribute('list') ? 4 : 1.5)}ch`; }
  const code = (...parts) => h('span', { class: 'rb-code' }, parts.map((p) => (typeof p === 'string' ? h('span', { class: 'rb-lit' }, p) : p)));

  // ---------- build mode: the anatomy with slots ----------
  function buildRows(b) {
    const r = ctx.raw;
    const row = (vars, ...parts) => ({ vars, el: h('div', { class: 'rb-row' }, code(...parts)) });
    const rows = [];
    if (b === 'header') {
      rows.push(row(['SUMMARY', 'DESCRIPTION'], 'SUMMARY = "', slot('summary', { label: 'SUMMARY', ph: 'one line on what it is' }), '"'));
      rows.push(row(['HOMEPAGE'], 'HOMEPAGE = "', slot('homepage', { label: 'HOMEPAGE', ph: 'https://' }), '"'));
      rows.push(row(['LICENSE'], 'LICENSE = "', slot('license', { label: 'LICENSE', list: 'rb-spdx' }), '"'));
      if (String(r.license).trim() !== 'CLOSED') rows.push(row(['LIC_FILES_CHKSUM'], 'LIC_FILES_CHKSUM = "file://', slot('licfile', { label: 'licence file', ph: '(common)' }),
        ';md5=', slot('licmd5', { label: 'md5', ph: '32 hex digits', cls: 'mono-sm' }), '"'));
    } else if (b === 'fetch') {
      if (r.source === 'git') {
        rows.push(row(['SRC_URI', 'GO_IMPORT'], 'SRC_URI = "', slot('url', { label: 'repository URL', ph: 'https://host/org/repo.git' }), ' ;branch=', slot('branch', { label: 'branch', ph: '(none)' }), '"'));
        rows.push(row(['SRCREV', 'PV'], 'SRCREV = "', slot('srcrev', { label: 'SRCREV', ph: '40-hex commit', cls: 'mono-sm' }), '"',
          h('button', { class: 'rb-mini', type: 'button', title: 'Follow the branch head (development only)', onclick: () => { ctx.set('srcrev', '${AUTOREV}'); } }, 'AUTOREV')));
      } else if (r.source === 'tarball') {
        rows.push(row(['SRC_URI'], 'SRC_URI = "', slot('url', { label: 'tarball URL', ph: 'https://.../name-1.0.tar.gz' }), '"'));
        rows.push(row(['SRC_URI'], 'SRC_URI[sha256sum] = "', slot('sha256', { label: 'sha256', ph: 'sha256sum of the tarball', cls: 'mono-sm' }), '"'));
      } else {
        rows.push(row(['SRC_URI'], 'SRC_URI = "file://', slot('files', { label: 'local files', ph: 'main.c Makefile' }), '"'));
      }
    } else if (b === 'build') {
      rows.push(row(['DEPENDS'], 'DEPENDS = "', slot('depends', { label: 'DEPENDS', ph: 'build-time recipes' }), '"'));
      if (CONFVAR[r.buildsys]) rows.push(row([CONFVAR[r.buildsys]], `${CONFVAR[r.buildsys]} ${r.buildsys === 'make' ? '+' : ''}= "`, slot('confargs', { label: 'configure arguments', ph: 'arguments' }), '"'));
    } else if (b === 'install') {
      if (r.buildsys === 'make') rows.push(row([], h('span', { class: 'rb-lbl' }, 'programs from ${B}: '), slot('binaries', { label: 'programs', ph: ctx.raw.pn || 'myapp' })));
    } else if (b === 'package') {
      rows.push(row(['SYSTEMD_SERVICE'], 'SYSTEMD_SERVICE:${PN} = "', slot('service', { label: 'systemd unit', ph: '(no service)' }), '"'));
      rows.push(row(['CONFFILES'], h('span', { class: 'rb-lbl' }, 'config for ${sysconfdir}:\u00a0'), 'file://', slot('conffile', { label: 'config file', ph: '(none)' })));
      rows.push(row(['RDEPENDS'], 'RDEPENDS:${PN} += "', slot('rdepends', { label: 'RDEPENDS', ph: 'run-time packages' }), '"'));
    }
    return rows;
  }
  function blockHeadExtra(b) {
    const r = ctx.raw;
    if (b === 'fetch') return seg([['git', 'git'], ['tarball', 'tarball'], ['local', 'layer files']], 'source');
    if (b === 'build') return h('div', { class: 'rb-hx' }, seg(BUILDS, 'buildsys', 'wrap'),
      ['cmake', 'meson', 'autotools'].includes(r.buildsys) ? h('label', { class: 'rb-chk' },
        h('input', { type: 'checkbox', checked: !!r.pkgconfig, onchange: (e) => ctx.set('pkgconfig', e.target.checked) }), 'pkgconfig') : null);
    return null;
  }

  // Build the block frames once per shape (mode, source, build class); a
  // new result only refreshes the lit state, the parts, the dim lines and the pins.
  let frames = {};
  function frame(b, withRows) {
    const rail = h('div', { class: 'rb-rail' });
    const dot = h('i', { class: 'rb-dot' });
    const partsEl = h('div', { class: 'rb-parts' });
    const rows = withRows ? buildRows(b.id) : [];
    const rowsEl = h('div', { class: 'rb-rows' }, rows.map((r) => [r.el, r.pin = h('div', { class: 'rb-pins' })]));
    const gen = h('div', { class: 'rb-gen' });
    const pins = h('div', { class: 'rb-pins' });
    const el = h('section', { class: `rb-block b-${b.id}`, 'data-block': b.id }, rail,
      h('div', { class: 'rb-bbody' },
        h('div', { class: 'rb-bhead' }, dot, h('h2', {}, b.title), h('span', { class: 'rb-what' }, b.what), withRows ? blockHeadExtra(b.id) : null),
        partsEl, rowsEl, gen, pins));
    return { el, partsEl, rows, gen, pins, dot };
  }

  // ---------- lint mode: the editor ----------
  const ta = h('textarea', { class: 'rb-ta', spellcheck: 'false', wrap: 'off', 'aria-label': 'Recipe text',
    oninput: (e) => { ctx.set('bb', e.target.value); sizeEditor(); } });
  const gut = h('div', { class: 'rb-gut', 'aria-hidden': 'true' });
  const hl = h('div', { class: 'rb-hl', 'aria-hidden': 'true' });
  const nameIn = h('input', { type: 'text', class: 'rb-name', spellcheck: 'false', 'aria-label': 'File name',
    oninput: (e) => ctx.set('bbname', e.target.value) });
  const edScroll = h('div', { class: 'rb-edscroll' }, h('div', { class: 'rb-ed' }, gut, h('div', { class: 'rb-edwrap' }, hl, ta)));
  ta.addEventListener('scroll', () => { hl.style.transform = `translateX(${-ta.scrollLeft}px)`; });
  ta.addEventListener('click', () => pickCaretLine());
  ta.addEventListener('keyup', (e) => { if (/Arrow|Page|Home|End/.test(e.key)) pickCaretLine(); });
  const editor = h('section', { class: 'rb-panel rb-editor' },
    h('div', { class: 'rb-phead' }, h('h2', {}, 'Recipe'), nameIn,
      h('button', { class: 'k-btn', type: 'button', title: 'Load the example with the classic mistakes', onclick: () => {
        const d = ctx.manifest.inputs.find((i) => i.key === 'bb').default;
        ctx.setMany({ bb: d, bbname: 'gpio-monitor_1.0.bb' });
      } }, 'Example')),
    edScroll);
  function sizeEditor() {
    const n = ta.value.split('\n').length;
    ta.style.height = `${n * 19 + 20}px`;
  }
  function pickCaretLine() {
    const n = ta.value.slice(0, ta.selectionStart).split('\n').length;
    if (n !== selLine) { selLine = n; paintEditor(); markSelected(); }
  }
  function gotoLine(n) {
    selLine = n;
    if (ctx.raw.mode === 'lint') {
      const lines = ta.value.split('\n');
      const pos = lines.slice(0, n - 1).reduce((s, l) => s + l.length + 1, 0);
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(pos, pos + (lines[n - 1] || '').length);
      const y = (n - 1) * 19;
      if (y < edScroll.scrollTop || y > edScroll.scrollTop + edScroll.clientHeight - 40) edScroll.scrollTop = Math.max(0, y - 80);
      paintEditor();
    }
    markSelected();
  }
  function lineBlocks() {
    const map = {};
    for (const b of res.anatomy.blocks) for (const [a, z] of b.lines) for (let i = a; i <= z; i++) map[i] = b.id;
    return map;
  }
  function paintEditor() {
    if (!res) return;
    const lines = ta.value.split('\n');
    const lb = lineBlocks();
    const worst = {};
    for (const f of res.anatomy.findings) {
      const o = { error: 0, warn: 1, info: 2 }[f.sev];
      if (worst[f.line] == null || o < worst[f.line]) worst[f.line] = o;
    }
    const sevName = ['error', 'warn', 'info'];
    gut.replaceChildren(...lines.map((_, i) => {
      const n = i + 1;
      return h('div', { class: `g${lb[n] ? ' b-' + lb[n] : ''}${n === selLine ? ' sel' : ''}` },
        worst[n] != null ? h('i', { class: `sv ${sevName[worst[n]]}` }) : null, String(n));
    }));
    hl.replaceChildren(...lines.map((l, i) => {
      const n = i + 1;
      return h('span', { class: `ln${worst[n] != null ? ' f-' + sevName[worst[n]] : ''}${n === selLine ? ' sel' : ''}` }, l || ' ');
    }));
  }

  // ---------- a finding, pinned ----------
  function pin(f, i) {
    const fix = f.fix && f.fix.ops && f.fix.ops.length && ctx.raw.mode === 'lint'
      ? h('button', { class: 'k-btn rb-fix', type: 'button', onclick: () => {
        const r = applyOps(ta.value, f.fix.ops);
        ctx.set('bb', r);
      } }, f.fix.label) : null;
    return h('div', { class: `rb-pin ${f.sev}`, 'data-line': f.line, 'data-i': i },
      h('div', { class: 'rb-pmain' },
        h('i', { class: `sv ${f.sev}`, title: SEV[f.sev] }),
        h('button', { class: 'rb-ln', type: 'button', title: 'Show this line', onclick: () => gotoLine(f.line) }, `L${f.line}`),
        h('span', { class: 'rb-msg' }, f.msg), fix),
      h('div', { class: 'rb-why' }, f.why, h('span', { class: 'rb-src' }, ` ${f.check} · ${f.source}`)));
  }
  function applyOps(text, ops) {
    const lines = text.split('\n');
    for (const op of [...ops].sort((a, b) => b.at - a.at)) lines.splice(op.at - 1, op.del, ...op.ins);
    return lines.join('\n');
  }
  function markSelected() {
    for (const el of root.querySelectorAll('.rb-cl')) {
      const a = +el.dataset.a, z = +el.dataset.z;
      el.classList.toggle('sel', selLine >= a && selLine <= z);
    }
    for (const el of root.querySelectorAll('.rb-pin')) el.classList.toggle('sel', +el.dataset.line === selLine);
  }

  // ---------- parts chips ----------
  function drawParts(el, parts) {
    el.replaceChildren(...parts.map((p) => h('span', { class: `rb-part ${p.state}`, title: p.value || p.state },
      h('i'), h('b', {}, p.name), p.value ? h('em', {}, p.value) : p.state === 'missing' ? h('em', {}, 'missing') : null)));
  }

  // ---------- the whole page for a result ----------
  function layout() {
    const r = ctx.raw;
    const mode = r.mode === 'lint' ? 'lint' : 'build';
    const key = `${mode}|${r.source}|${r.buildsys}|${String(r.license).trim() === 'CLOSED'}`;
    // top bar
    modeSeg.replaceChildren(...[['build', 'Build from choices'], ['lint', 'Lint a .bb']].map(([v, t]) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(mode === v), 'aria-pressed': String(mode === v), onclick: () => ctx.set('mode', v) }, t)));
    relSeg.replaceChildren(...RELS.map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(r.release === v), onclick: () => ctx.set('release', v) }, t)));
    fixAll.style.display = mode === 'lint' ? '' : 'none';
    toLint.style.display = mode === 'build' ? '' : 'none';
    grid.dataset.mode = mode;
    if (key === shape) return;
    shape = key;
    for (const k of Object.keys(slots)) delete slots[k];
    frames = {};
    const blocks = ctx.manifest && res ? res.anatomy.blocks : [];
    const defs = [
      { id: 'header', title: 'Header', what: 'what it is, under which licence' },
      { id: 'fetch', title: 'Fetch', what: 'where the source comes from, where it lands' },
      { id: 'build', title: 'Build', what: 'the class that builds it, and with what' },
      { id: 'install', title: 'Install', what: 'what lands in ${D}' },
      { id: 'package', title: 'Packaging', what: 'which package ships what; run-time needs' },
      { id: 'other', title: 'Other', what: 'lines that fit none of the above' },
    ];
    void blocks;
    const anat = h('div', { class: 'rb-anat' });
    if (mode === 'build') {
      const file = h('div', { class: 'rb-file' }, h('span', { class: 'rb-lbl' }, 'recipes-*/', ), slot('pn', { label: 'recipe name', ph: 'name' }),
        h('span', { class: 'rb-lit' }, '/'), h('span', { class: 'rb-fname' }), h('span', { class: 'rb-lbl rb-fhint' }, 'the file name gives PN and PV'),
        h('span', { class: 'rb-pv' }, h('span', { class: 'rb-lbl' }, 'PV '), slot('pv', { label: 'version', ph: '1.0' })));
      anat.append(file);
    }
    for (const d of defs) {
      if (d.id === 'other' && mode === 'build') continue;
      const fr = frame(d, mode === 'build');
      frames[d.id] = fr;
      anat.append(fr.el);
    }
    anat.append(h('datalist', { id: 'rb-spdx' }, SPDX.map((s) => h('option', { value: s }))));
    if (mode === 'build') {
      left.replaceChildren(anat);
      right.replaceChildren(ctx.outputs);
    } else {
      left.replaceChildren(editor);
      right.replaceChildren(anat, ctx.outputs);
    }
  }

  function refresh() {
    if (!res || !res.anatomy) return;
    layout();
    const r = ctx.raw;
    const A = res.anatomy;
    const mode = r.mode === 'lint' ? 'lint' : 'build';
    // counts
    const n = (s) => A.findings.filter((f) => f.sev === s).length;
    counts.replaceChildren(
      h('span', { class: n('error') ? 'c-error' : 'c-ok' }, h('b', {}, String(n('error'))), n('error') === 1 ? ' error' : ' errors'),
      h('span', { class: n('warn') ? 'c-warn' : 'c-ok' }, h('b', {}, String(n('warn'))), n('warn') === 1 ? ' warning' : ' warnings'),
      h('span', { class: 'c-info' }, h('b', {}, String(n('info'))), ' notes'),
      ...(mode === 'lint' ? [h('span', {}, h('b', {}, String(A.findings.filter((f) => f.fix && f.fix.ops.length).length)), ' fixable')] : []));
    fixAll.disabled = !A.fixedCount;
    fixAll.textContent = A.fixedCount ? `Apply all fixes (${A.fixedCount})` : 'Nothing to fix';
    // sync inputs that are not being typed in
    for (const [k, el] of Object.entries(slots)) if (el.value !== String(r[k] ?? '')) { el.value = r[k] ?? ''; fit(el); }
    if (mode === 'lint') {
      // Typing leaves the two equal; a fix or an example changes the text under the caret.
      if (ta.value !== String(r.bb ?? '')) { const p = ta.selectionStart; ta.value = r.bb ?? ''; ta.setSelectionRange(p, p); }
      if (document.activeElement !== nameIn) nameIn.value = r.bbname ?? '';
      sizeEditor();
      paintEditor();
    } else {
      const fn = root.querySelector('.rb-fname');
      if (fn) fn.textContent = A.fileName;
    }
    // blocks
    const lines = A.lines;
    for (const b of A.blocks) {
      const fr = frames[b.id];
      if (!fr) continue;
      fr.el.dataset.state = b.state;
      fr.dot.className = `rb-dot ${b.state}`;
      fr.dot.title = { ok: 'complete', warn: 'has warnings', bad: 'missing parts or errors', empty: 'nothing here yet' }[b.state];
      if (mode === 'lint') drawParts(fr.partsEl, b.parts); else fr.partsEl.replaceChildren();
      for (const row of fr.rows) row.el.classList.toggle('filled', [...row.el.querySelectorAll('.rb-slot')].every((x) => x.value.trim()));
      const fs = b.findings.map((i) => [A.findings[i], i]);
      for (const row of fr.rows) row.pin.replaceChildren();
      fr.pins.replaceChildren();
      const stmtVar = (a) => ((lines[a - 1] || '').match(/^\s*(?:export\s+)?([A-Za-z0-9_${}.:-]+)/) || [])[1] || '';
      if (mode === 'build') {
        // dim generated lines not covered by a slot row
        const covered = new Set(fr.rows.flatMap((rw) => rw.vars));
        const genEls = [];
        for (const [a, z] of b.lines) {
          const v = stmtVar(a).split(/[:[]/)[0];
          if (covered.has(v)) continue;
          genEls.push(h('div', { class: 'rb-cl gen', 'data-a': a, 'data-z': z }, lines.slice(a - 1, z).join('\n')));
        }
        fr.gen.replaceChildren(...(genEls.length ? [h('div', { class: 'rb-genh' }, 'written for you'), ...genEls] : []));
        for (const [f, i] of fs) {
          const range = b.lines.find(([a, z]) => f.line >= a && f.line <= z);
          const v = range ? stmtVar(range[0]).split(/[:[]/)[0] : '';
          const row = fr.rows.find((rw) => rw.vars.includes(v));
          (row ? row.pin : fr.pins).append(pin(f, i));
        }
      } else {
        const items = [];
        const pinned = new Set();
        for (const [a, z] of b.lines) {
          items.push(h('div', { class: 'rb-cl', 'data-a': a, 'data-z': z, tabindex: '0', role: 'button', title: 'Show in the editor',
            onclick: () => gotoLine(a), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); gotoLine(a); } } },
          h('span', { class: 'rb-n' }, String(a)), h('span', { class: 'rb-t' }, lines.slice(a - 1, z).join('\n'))));
          for (const [f, i] of fs) if (f.line >= a && f.line <= z && !pinned.has(i)) { pinned.add(i); items.push(pin(f, i)); }
        }
        fr.gen.replaceChildren(...items);
        for (const [f, i] of fs) if (!pinned.has(i)) fr.pins.append(pin(f, i));
      }
    }
    for (const id of Object.keys(frames)) if (!A.blocks.find((b) => b.id === id)) frames[id].el.hidden = true; else frames[id].el.hidden = false;
    notes.replaceChildren(...(res.notes || []).map((t) => h('div', {}, t)), ...(res.warnings || []).filter((w) => /^Could not read|^File name/.test(w)).map((t) => h('div', { class: 'c-warn' }, t)));
    markSelected();
  }

  let first = true;
  ctx.onResult((r) => {
    res = r; refresh();
    if (first) {
      first = false;
      // Open on the recipe itself rather than the prompt, unless a tab was chosen before.
      let chosen = null;
      try { chosen = localStorage.getItem(`redline.tool.${ctx.manifest.id}.input.tab`); } catch { /* private window */ }
      if (!chosen) { const t = ctx.outputs.querySelector('.k-tab'); if (t && !/Prompt|JSON/.test(t.textContent)) t.click(); }
    }
  });
}
