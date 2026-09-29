// License Manifest Viewer, drawn as the image itself: every package a chip,
// grouped under its license, the licenses grouped into families from
// permissive to proprietary. The family bar on top is the image's make-up.
//   Click a license's head to add it to INCOMPATIBLE_LICENSE (or take it out):
//   the packages bitbake would drop are struck through at once. Click a
//   package for its LICENSE expression as a tree, the branch taken, and to let
//   it in with INCOMPATIBLE_LICENSE_EXCEPTIONS. Type to find a package.
// Everything drawn comes from run()'s result.view.

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
const WILD = { 'GPL-3.0*': ['GPL-3.0-only', 'GPL-3.0-or-later'], 'LGPL-3.0*': ['LGPL-3.0-only', 'LGPL-3.0-or-later'], 'AGPL-3.0*': ['AGPL-3.0-only', 'AGPL-3.0-or-later'] };
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private */ } } };

export function page(root, ctx) {
  const wrap = h('div', { class: 'lic' });
  root.append(wrap);
  let res = null, selName = null, famFilter = store.get('redline.license-manifest.fam'), query = '';

  // ---------- toolbar ----------
  const incIn = h('input', { type: 'text', spellcheck: 'false', class: 'wide', 'aria-label': 'INCOMPATIBLE_LICENSE', oninput: (e) => ctx.set('incompatible', e.target.value) });
  const exIn = h('input', { type: 'text', spellcheck: 'false', class: 'wide', placeholder: 'pkg:license …', 'aria-label': 'INCOMPATIBLE_LICENSE_EXCEPTIONS', oninput: (e) => ctx.set('exceptions', e.target.value) });
  const gpl3Btn = h('button', { class: 'k-btn', type: 'button', 'aria-pressed': 'false', title: 'GPL-3.0* LGPL-3.0* AGPL-3.0*', onclick: () => {
    const words = incWords();
    const on = ['GPL-3.0*', 'LGPL-3.0*', 'AGPL-3.0*'].every((w) => words.includes(w));
    const next = on ? words.filter((w) => !WILD[w]) : [...new Set([...words, 'GPL-3.0*', 'LGPL-3.0*', 'AGPL-3.0*'])];
    ctx.set('incompatible', next.join(' '));
  } }, 'No GPLv3');
  const find = h('input', { type: 'search', spellcheck: 'false', placeholder: 'find package, recipe, license', 'aria-label': 'Find', oninput: (e) => { query = e.target.value.trim().toLowerCase(); drawBlocks(); } });
  const bar = h('div', { class: 'lic-bar' },
    h('label', { class: 'grow' }, 'INCOMPATIBLE_LICENSE', h('span', { class: 'lic-row' }, incIn, gpl3Btn)),
    h('label', { class: 'grow' }, 'INCOMPATIBLE_LICENSE_EXCEPTIONS', exIn),
    h('label', {}, 'Find', find));

  // ---------- the image ----------
  const famBar = h('div', { class: 'lic-fambar', role: 'group', 'aria-label': 'License families' });
  const blocks = h('div', { class: 'lic-blocks' });
  const sub = h('span', { class: 'lic-sub' });
  const mainCard = h('section', { class: 'lic-card' },
    h('div', { class: 'lic-head' }, h('h2', {}, 'Image'), sub), bar, famBar, blocks,
    h('div', { class: 'lic-help' }, 'Click a license head to add it to INCOMPATIBLE_LICENSE or take it out; excluded packages are struck through. Click a package for its expression. A family in the bar filters to it. ',
      h('span', { class: 'key' }, h('i', { class: 'mk dual' }, '|'), ' dual/choice'), ' ', h('span', { class: 'key' }, h('i', { class: 'mk old' }, '*'), ' obsolete name')));

  // ---------- detail, input ----------
  const detTitle = h('h2', {}, 'Package'), detSub = h('span', { class: 'lic-sub' });
  const det = h('div', { class: 'lic-det' });
  const detCard = h('section', { class: 'lic-card' }, h('div', { class: 'lic-head' }, detTitle, detSub), det);
  const warns = h('div', { class: 'lic-warns', role: 'status', 'aria-live': 'polite' });
  const srcTa = h('textarea', { class: 'lic-src', rows: 8, spellcheck: 'false', 'aria-label': 'license.manifest or SPDX', oninput: (e) => ctx.set('manifest', e.target.value) });
  const srcSub = h('span', { class: 'lic-sub' });
  const srcCard = h('section', { class: 'lic-card' }, h('div', { class: 'lic-head' }, h('h2', {}, 'Input'), srcSub), srcTa);
  const notes = h('details', { class: 'lic-notes' }, h('summary', {}, 'Notes'));
  wrap.append(h('div', { class: 'lic-col' }, mainCard), h('div', { class: 'lic-col' }, warns, detCard, ctx.outputs, srcCard, notes));

  const incWords = () => String(ctx.raw.incompatible || '').split(/\s+/).filter(Boolean);
  const exWords = () => String(ctx.raw.exceptions || '').split(/\s+/).filter(Boolean);
  const isBad = (id) => (res ? res.view.bad : []).some((w) => new RegExp('^' + w.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(id));
  function toggleLicense(id) {
    let words = incWords();
    if (isBad(id)) {
      // take it out: drop the exact word, or split a wildcard into the rest of its set
      const next = [];
      for (const w of words) {
        if (w === id) continue;
        if (WILD[w] && WILD[w].includes(id)) { next.push(...WILD[w].filter((x) => x !== id)); continue; }
        next.push(w);
      }
      words = next;
    } else words = [...words, id];
    // fold a complete pair back into its wildcard
    for (const [w, set] of Object.entries(WILD)) if (set.every((x) => words.includes(x))) words = [...words.filter((x) => !set.includes(x)), w];
    ctx.set('incompatible', [...new Set(words)].join(' '));
  }

  // ---------- drawing ----------
  function drawFamBar() {
    const v = res.view;
    const total = Math.max(1, v.pkgs.length);
    famBar.replaceChildren(...v.families.filter((f) => f.count).map((f) => h('button', {
      type: 'button', class: `seg f-${f.id}`, style: `flex-grow:${f.count}`, 'aria-pressed': String(famFilter === f.id), title: `${f.label}: ${f.tip}. Click to show only this family.`,
      onclick: () => { famFilter = famFilter === f.id ? null : f.id; store.set('redline.license-manifest.fam', famFilter); drawFamBar(); drawBlocks(); },
    }, h('b', {}, f.count), h('span', {}, ` ${f.label}`), h('em', {}, ` ${Math.round((f.count / total) * 100)} %`))));
  }
  function drawBlocks() {
    const v = res.view;
    const byLic = new Map();
    for (const p of v.pkgs) for (const id of p.ids) { if (!byLic.has(id)) byLic.set(id, []); byLic.get(id).push(p); }
    const match = (p) => !query || [p.name, p.recipe, p.license].some((x) => String(x).toLowerCase().includes(query));
    const fams = v.families.filter((f) => f.count && (!famFilter || famFilter === f.id));
    blocks.replaceChildren(...fams.map((f) => {
      const lics = v.lics.filter((l) => l.family === f.id);
      return h('section', { class: `fam f-${f.id}` },
        h('div', { class: 'fam-head' }, h('i', { class: 'sw' }), h('b', {}, f.label), h('span', {}, `${f.count} package${f.count === 1 ? '' : 's'} · ${f.tip}`)),
        h('div', { class: 'fam-body' }, lics.map((l) => {
          const pk = (byLic.get(l.id) || []).slice().sort((a, b) => a.name.localeCompare(b.name));
          const bad = isBad(l.id);
          const hits = pk.filter(match).length;
          return h('div', { class: `grp${bad ? ' bad' : ''}${query && !hits ? ' dim' : ''}` },
            h('button', { type: 'button', class: 'grp-head', 'data-lic': l.id, 'aria-pressed': String(bad),
              title: bad ? `${l.id} is in INCOMPATIBLE_LICENSE: click to take it out` : `Click to add ${l.id} to INCOMPATIBLE_LICENSE`,
              onclick: () => toggleLicense(l.id) },
            h('span', { class: 'id' }, l.id), h('span', { class: 'n' }, String(l.n)), bad ? h('span', { class: 'x' }, l.excluded ? `${l.excluded} out` : 'set') : null),
            h('div', { class: 'chips' }, pk.map((p) => chip(p, match(p)))));
        })));
    }));
    if (!fams.length) blocks.append(h('div', { class: 'empty' }, v.pkgs.length ? 'No packages in this family.' : 'No packages read: paste a license.manifest or SPDX file in Input.'));
  }
  function chip(p, hit) {
    const cls = ['chip', `f-${p.family}`, p.excluded ? 'out' : '', p.allowed ? 'exc' : '', p.name === selName ? 'sel' : '', hit ? '' : 'dim'].filter(Boolean).join(' ');
    return h('button', { type: 'button', class: cls, 'data-name': p.name, 'aria-pressed': String(p.name === selName),
      title: `${p.name} ${p.version} (${p.recipe})\nLICENSE: ${p.license}${p.excluded ? `\nexcluded: ${p.incompatible.join(' ')}` : ''}${p.allowed ? '\nallowed by INCOMPATIBLE_LICENSE_EXCEPTIONS' : ''}`,
      onclick: () => { selName = p.name; drawBlocks(); drawDetail(); blocks.querySelector(`[data-name="${CSS.escape(p.name)}"]`)?.focus({ preventScroll: true }); } },
    p.name, p.dual ? h('i', { class: 'mk dual' }, '|') : null, p.legacy.length ? h('i', { class: 'mk old' }, '*') : null);
  }

  // an expression as nested boxes; the OR branch bitbake takes is marked
  function tree(node, p, choice) {
    if (typeof node === 'string') {
      const id = canonicalOf(node);
      const fam = famOf(id);
      const bad = p.incompatible.includes(id);
      return h('span', { class: `leaf f-${fam}${bad ? ' bad' : ''}`, title: `${fam}${node !== id ? ` (obsolete name, read as ${id})` : ''}` }, node, node !== id ? h('small', {}, ` → ${id}`) : null);
    }
    const [op, ...args] = node;
    if (op === '&') return h('span', { class: 'and' }, args.flatMap((a, i) => (i ? [h('span', { class: 'op' }, '&'), tree(a, p, choice)] : [tree(a, p, choice)])));
    return h('span', { class: 'or' }, args.flatMap((a, i) => {
      const box = h('span', { class: `br${choice(a) ? ' on' : ''}` }, tree(a, p, choice));
      return i ? [h('span', { class: 'op' }, 'OR'), box] : [box];
    }));
  }
  let famMap = new Map(), canMap = new Map();
  const famOf = (id) => famMap.get(id) || 'unknown';
  const canonicalOf = (x) => canMap.get(x) || x;
  const leaves = (n) => (typeof n === 'string' ? [n] : n.slice(1).flatMap(leaves));

  function drawDetail() {
    const v = res.view;
    const p = v.pkgs.find((q) => q.name === selName) || v.pkgs.find((q) => q.excluded) || v.pkgs[0];
    det.replaceChildren();
    if (!p) { detTitle.textContent = 'Package'; detSub.textContent = ''; return; }
    selName = p.name;
    detTitle.textContent = p.name;
    detSub.replaceChildren(`${p.version} · recipe `, h('b', {}, p.recipe));
    // the branch the distributor keeps: all its leaves among p.ids (or bitbake's pick when excluded)
    const keep = new Set(p.excluded ? p.incompatible : p.ids);
    const choice = (branch) => leaves(branch).map(canonicalOf).every((x) => keep.has(x) || p.ids.includes(x));
    const state = p.excluded ? h('div', { class: 'st bad' }, `Excluded: ${p.incompatible.join(', ')} ${p.incompatible.length > 1 ? 'are' : 'is'} in INCOMPATIBLE_LICENSE and no OR branch avoids it.`)
      : p.allowed ? h('div', { class: 'st warn' }, `Let in by INCOMPATIBLE_LICENSE_EXCEPTIONS despite ${p.incompatible.join(', ')} (bitbake logs a license-incompatible QA warning).`)
        : h('div', { class: 'st ok' }, 'Allowed.');
    const exceptionsNow = exWords();
    const exBtns = [...new Set([...p.incompatible])].map((id) => {
      const pair = `${p.name}:${id}`;
      const on = exceptionsNow.includes(pair);
      return h('button', { class: 'k-btn', type: 'button', 'aria-pressed': String(on), onclick: () => ctx.set('exceptions', (on ? exceptionsNow.filter((x) => x !== pair) : [...exceptionsNow, pair]).join(' ')) },
        on ? `Remove exception ${pair}` : `Allow: add ${pair}`);
    });
    det.append(
      h('div', { class: 'expr' }, h('div', { class: 'lab' }, 'LICENSE'), h('code', {}, p.license)),
      h('div', { class: 'tree' }, tree(p.tree, p, choice)),
      h('dl', {},
        h('dt', {}, 'Family'), h('dd', {}, h('span', { class: `pill f-${p.family}` }, v.families.find((f) => f.id === p.family)?.label || p.family)),
        h('dt', {}, 'Counts as'), h('dd', {}, p.ids.join(' & ') || '–'),
        p.dual ? [h('dt', {}, 'Choice'), h('dd', {}, 'OR: placed by the lightest branch you may choose; INCOMPATIBLE_LICENSE takes the first acceptable one.')] : null,
        p.legacy.length ? [h('dt', {}, 'Obsolete'), h('dd', {}, p.legacy.join(', '))] : null,
        h('dt', {}, 'Source offer'), h('dd', {}, p.excluded ? 'not shipped' : p.source ? 'yes: ship or offer the corresponding source (and patches) of ' + p.recipe : 'no')),
      state, exBtns.length ? h('div', { class: 'acts' }, exBtns) : null);
  }

  // ---------- result ----------
  ctx.onResult((r) => {
    res = r;
    if (!r.view) return;
    famMap = new Map(); canMap = new Map();
    for (const [k, fam] of Object.entries(r.view.leafFamily || {})) famMap.set(k, fam);
    for (const [k, c] of Object.entries(r.view.canonical || {})) canMap.set(k, c);
    if (document.activeElement !== incIn) incIn.value = ctx.raw.incompatible ?? '';
    if (document.activeElement !== exIn) exIn.value = ctx.raw.exceptions ?? '';
    if (document.activeElement !== srcTa) srcTa.value = ctx.raw.manifest ?? '';
    const words = incWords();
    gpl3Btn.setAttribute('aria-pressed', String(['GPL-3.0*', 'LGPL-3.0*', 'AGPL-3.0*'].every((w) => words.includes(w))));
    srcSub.textContent = `read as ${r.view.kind} · ${r.view.pkgs.length} packages`;
    const out = r.view.pkgs.filter((p) => p.excluded).length;
    sub.replaceChildren(h('b', {}, String(r.view.pkgs.length)), ' packages · ', h('b', {}, String(r.view.lics.length)), ' licenses',
      ...(out ? [' · ', h('b', { class: 'bad' }, String(out)), ' excluded'] : []));
    warns.replaceChildren(...(r.warnings || []).map((w) => h('div', {}, w)));
    notes.replaceChildren(h('summary', {}, `Notes (${(r.notes || []).length})`), ...(r.notes || []).map((n) => h('div', {}, n)));
    const ae = document.activeElement;
    const hadName = blocks.contains(ae) ? ae.getAttribute('data-name') : null;
    const hadLic = blocks.contains(ae) ? ae.getAttribute('data-lic') : null;
    drawFamBar(); drawBlocks(); drawDetail();
    if (hadName) blocks.querySelector(`[data-name="${CSS.escape(hadName)}"]`)?.focus({ preventScroll: true });
    if (hadLic) blocks.querySelector(`[data-lic="${CSS.escape(hadLic)}"]`)?.focus({ preventScroll: true });
  });
}
