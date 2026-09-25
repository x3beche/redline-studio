// Net Naming Linter page: the design's net names are the interface.
//   - the net map: every name as a chip, split into its parts (sheet path,
//     name, active-low mark, voltage, pair suffix, bus index) and grouped the
//     way a reviewer reads a design: power, pairs (P and N side by side, a
//     missing half drawn as a ghost), buses, signal families, unnamed nets;
//     the offending characters are marked in place, names that spell one net
//     two ways are bracketed together;
//   - click a chip (or arrow keys + Enter) to inspect it and rename it in the
//     list; "Apply all" takes every suggested rename;
//   - the convention bar shows how the design votes (its own habit counts)
//     and lets you pick the rule;
//   - the source list on the left, with a gutter marking the flagged lines.
// Every check and suggestion comes from tool.js run() (result.drawing).

const el = (tag, attrs = {}, html) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CODE = {
  space: ['spaces', 'bad'], chars: ['characters', 'bad'], brackets: ['brackets', 'bad'], volt: ['voltage style', 'warn'],
  sep: ['separator', 'warn'], case: ['case', 'warn'], al: ['active-low style', 'warn'], half: ['missing pair half', 'bad'],
  pairstyle: ['pair suffix', 'warn'], len: ['too long', 'warn'], bus: ['bus index style', 'warn'], dup: ['same net twice', 'bad'],
};
const OPTS = {
  convention: [['auto', 'Majority'], ['upper', 'UPPER_SNAKE', 'upper'], ['lower', 'lower_snake', 'lower']],
  activeLowStyle: [['auto', 'Majority'], ['n', 'nRESET', 'n'], ['_N', 'RESET_N', '_N'], ['#', 'RESET#', '#'], ['~{}', '~{RESET}', '~{}']],
  voltageStyle: [['auto', 'Majority'], ['V', '3V3', 'V'], ['dot', '3.3V', 'dot']],
};

// The name split into display parts, with the characters a check objects to marked.
function anatomy(n, D) {
  const b = n.base, cls = new Array(b.length).fill('core'), mark = new Array(b.length).fill(false);
  const set = (i, j, c) => { for (let k = Math.max(0, i); k < Math.min(b.length, j); k++) cls[k] = c; };
  let m;
  if (n.voltage && (m = /\d+V\d+|\d+\.\d+V/i.exec(b))) set(m.index, m.index + m[0].length, 'volt');
  if (/^[+-]/.test(b) && n.kind === 'power') set(0, 1, 'volt');
  if (n.activeLow === 'n') set(0, 1, 'al');
  else if (n.activeLow === '_N') set(b.length - 2, b.length, 'al');
  else if (n.activeLow === '#') set(b.length - 1, b.length, 'al');
  else if (n.activeLow === '~{}') { set(0, 2, 'al'); set(b.length - 1, b.length, 'al'); }
  if (n.pair) {
    const re = n.pair.style === '_P/_N' ? /_[PN]$/i : n.pair.style === '_DP/_DM' ? /_D[PMN]$/i : /[+-]$/;
    if ((m = re.exec(b))) set(m.index, b.length, 'pair');
  }
  if (n.kind === 'bus' && (m = /(\[\d+\]|_\d+|\d+)$/.exec(b))) set(m.index, b.length, 'idx');
  const c = new Set(n.codes);
  for (let i = 0; i < b.length; i++) {
    const ch = b[i];
    if (c.has('space') && /\s/.test(ch)) mark[i] = true;
    if (c.has('chars') && /[,;:'"()<>{}|\\*?]/.test(ch) && cls[i] !== 'al') mark[i] = true;
    if (c.has('sep') && /[-.]/.test(ch) && cls[i] !== 'volt' && cls[i] !== 'pair') mark[i] = true;
    if (c.has('case') && /[a-z]/i.test(ch) && cls[i] !== 'al' && cls[i] !== 'volt'
      && (D.conv === 'upper' ? ch !== ch.toUpperCase() : ch !== ch.toLowerCase())) mark[i] = true;
    if (c.has('len') && i >= D.limit) mark[i] = true;
  }
  if (c.has('al')) for (let i = 0; i < b.length; i++) if (cls[i] === 'al') mark[i] = true;
  if (c.has('pairstyle')) for (let i = 0; i < b.length; i++) if (cls[i] === 'pair') mark[i] = true;
  if (c.has('bus')) for (let i = 0; i < b.length; i++) if (cls[i] === 'idx') mark[i] = true;
  if (c.has('volt')) for (let i = 0; i < b.length; i++) if (cls[i] === 'volt') mark[i] = true;
  let html = n.pre ? `<span class="p-pre">${esc(n.pre)}</span>` : '';
  for (let i = 0; i < b.length;) {
    let j = i + 1;
    while (j < b.length && cls[j] === cls[i] && mark[j] === mark[i]) j++;
    const txt = b.slice(i, j).replace(/ /g, '␣');
    html += `<span class="p-${cls[i]}${mark[i] ? ' mk' : ''}">${esc(txt)}</span>`;
    i = j;
  }
  return html;
}

// Rename one net in the pasted text: a KiCad netlist's (name "...") or a list line's first column.
function renameIn(text, from, to) {
  if (/\(net\s+\(code/.test(text)) return text.split(`(name "${from}")`).join(`(name "${to}")`);
  return text.split(/(\r?\n)/).map((line) => {
    if (/^\r?\n$/.test(line)) return line;
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) return line;
    let name = t;
    if (t.includes('\t')) name = t.split('\t')[0].trim();
    else if (/^"[^"]*"\s*,/.test(t)) name = t.match(/^"([^"]*)"/)[1];
    else if (t.includes(',') && !/[[(]/.test(t)) name = t.split(',')[0].trim();
    name = name.replace(/^"(.*)"$/, '$1');
    if (name !== from) return line;
    const i = line.indexOf(from);
    return line.slice(0, i) + to + line.slice(i + from.length);
  }).join('');
}

// After a rename two lines can name the same net: keep the first (the names fold together).
function dedupe(text, name) {
  if (/\(net\s+\(code/.test(text)) return text;
  let seen = false;
  return text.split(/\r?\n/).filter((line) => {
    const t = line.trim().split('\t')[0].trim().replace(/^"(.*)"$/, '$1');
    if (t !== name) return true;
    if (seen) return false;
    seen = true; return true;
  }).join('\n');
}

// old -> new with the changed middle highlighted
function diffHtml(a, b) {
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const mid = (x) => x.slice(p, x.length - s);
  return {
    from: `${esc(a.slice(0, p))}<del>${esc(mid(a).replace(/ /g, '␣'))}</del>${esc(a.slice(a.length - s))}`,
    to: `${esc(b.slice(0, p))}<ins>${esc(mid(b))}</ins>${esc(b.slice(b.length - s))}`,
  };
}

export function page(root, ctx) {
  // ---------------- DOM ----------------
  const conv = el('section', { class: 'nl-card nl-conv', 'aria-label': 'Naming convention' });
  const health = el('div', { class: 'nl-health' });
  const pickers = {};
  const convRow = el('div', { class: 'nl-convrow' });
  for (const [key, label] of [['convention', 'Case'], ['activeLowStyle', 'Active low'], ['voltageStyle', 'Voltage']]) {
    const g = el('div', { class: 'nl-pick', role: 'radiogroup', 'aria-label': label });
    g.append(el('span', { class: 'nl-pl' }, esc(label)));
    for (const [v, t] of OPTS[key]) {
      const b = el('button', { role: 'radio', 'data-v': v }, `<span class="t">${esc(t)}</span><span class="n"></span>`);
      b.addEventListener('click', () => ctx.set(key, v));
      b.addEventListener('keydown', (e) => {
        const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (!d) return;
        e.preventDefault();
        const i = OPTS[key].findIndex((o) => o[0] === v), n = OPTS[key][(i + d + OPTS[key].length) % OPTS[key].length][0];
        ctx.set(key, n);
        requestAnimationFrame(() => g.querySelector(`[data-v="${CSS.escape(n)}"]`)?.focus());
      });
      g.append(b);
    }
    pickers[key] = g;
    convRow.append(g);
  }
  const pairInfo = el('div', { class: 'nl-pick nl-info' });
  const lenBox = el('label', { class: 'nl-len' }, '<span class="nl-pl">Max length</span>');
  const lenIn = el('input', { type: 'text', inputmode: 'numeric', spellcheck: 'false', 'aria-label': 'Maximum name length' });
  lenIn.addEventListener('input', () => ctx.set('maxLen', lenIn.value));
  lenIn.addEventListener('keydown', (e) => {
    const d = { ArrowUp: 1, ArrowDown: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    ctx.set('maxLen', String(Math.max(4, (ctx.input.maxLen || 32) + d)));
  });
  lenBox.append(lenIn);
  convRow.append(pairInfo, lenBox);
  conv.append(health, convRow);

  const src = el('section', { class: 'nl-card nl-src' });
  const srcHead = el('div', { class: 'nl-head' }, '<h2>Net list</h2><span class="nl-hint">one per line, or a KiCad .net</span>');
  const srcWrap = el('div', { class: 'nl-srcwrap' });
  const gutter = el('div', { class: 'nl-gutter', 'aria-hidden': 'true' });
  const ta = el('textarea', { spellcheck: 'false', 'aria-label': 'Net names, one per line, or a KiCad netlist', wrap: 'off' });
  ta.addEventListener('input', () => ctx.set('nets', ta.value));
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
  srcWrap.append(gutter, ta);
  const srcFoot = el('div', { class: 'nl-foot' });
  src.append(srcHead, srcWrap, srcFoot);

  const map = el('section', { class: 'nl-card nl-map' });
  const mapHead = el('div', { class: 'nl-head' });
  const legend = el('div', { class: 'nl-legend' },
    '<span class="p-pre">/sheet/</span><span class="p-core">name</span><span class="p-al">active-low</span><span class="p-volt">voltage</span><span class="p-pair">pair</span><span class="p-idx">index</span><span class="mk">problem</span>');
  mapHead.append(el('h2', {}, 'Net map'), el('span', { class: 'nl-hint' }, 'click a net to inspect it · arrow keys move'), legend);
  const board = el('div', { class: 'nl-board', role: 'listbox', 'aria-label': 'Nets grouped by family' });
  map.append(mapHead, board);

  const side = el('aside', { class: 'nl-side' });
  const insp = el('section', { class: 'nl-card nl-insp', 'aria-live': 'polite' });
  const warnsEl = el('div', { class: 'nl-warns', role: 'status' });
  const notesEl = el('details', { class: 'nl-notes' });
  side.append(insp, warnsEl, ctx.outputs, notesEl);

  const grid = el('div', { class: 'nl' });
  grid.append(conv, src, map, side);
  root.append(grid);

  // ---------------- state ----------------
  let selected = null;
  let lastGood = null;
  const D = () => ctx.result?.drawing || lastGood;

  function apply(from, to) {
    ctx.set('nets', dedupe(renameIn(ctx.raw.nets || '', from, to), to));
    selected = to;
  }
  function applyAll() {
    const d = D();
    if (!d) return;
    let t = ctx.raw.nets || '';
    for (const n of d.nets) if (n.fix && !n.codes.includes('dup')) t = renameIn(t, n.name, n.fix);
    // same-net spellings: rename to the fix when one exists
    for (const n of d.nets) if (n.fix && n.codes.includes('dup')) t = renameIn(t, n.name, n.fix);
    for (const n of d.nets) if (n.fix) t = dedupe(t, n.fix);
    ctx.set('nets', t);
  }

  // ---------------- convention bar ----------------
  function drawConv() {
    const d = D(), raw = ctx.raw;
    if (!d) { health.innerHTML = ''; return; }
    const c = d.counts, named = Math.max(1, c.read);
    health.innerHTML = `<div class="nl-hbar"><i class="ok" style="width:${(c.clean / named) * 100}%"></i><i class="bad" style="width:${(c.bad / named) * 100}%"></i><i class="auto" style="width:${(c.unnamed / named) * 100}%"></i></div>`
      + `<div class="nl-hnum"><b>${c.read}</b> nets <span class="ok">${c.clean} consistent</span> <span class="bad">${c.bad} with issues</span> <span class="auto">${c.unnamed} unnamed</span> <span class="src">· ${esc(d.source)}</span></div>`;
    const habit = { convention: d.habits.case, activeLowStyle: d.habits.activeLow, voltageStyle: d.habits.voltage };
    const eff = { convention: d.conv, activeLowStyle: d.alPref, voltageStyle: d.vPref };
    for (const [key, g] of Object.entries(pickers)) {
      for (const b of g.querySelectorAll('button')) {
        const v = b.dataset.v, opt = OPTS[key].find((o) => o[0] === v);
        const on = String(raw[key] || 'auto') === v;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
        b.classList.toggle('eff', v === eff[key]);
        const n = opt[2] ? habit[key][opt[2]] || 0 : null;
        b.querySelector('.n').textContent = n == null ? `→ ${OPTS[key].find((o) => o[0] === eff[key])?.[1] || ''}` : String(n);
        b.title = n == null ? 'Follow the design’s own majority habit' : `${n} net(s) in the design use this style`;
      }
    }
    const pc = d.habits.pairs;
    pairInfo.innerHTML = `<span class="nl-pl">Pairs</span>${Object.keys(pc).length ? Object.entries(pc).map(([k, n]) => `<span class="nl-tag${k === d.dPref ? ' eff' : ''}">${esc(k)} <b>${n}</b></span>`).join('') : '<span class="nl-tag">none</span>'}`;
    pairInfo.title = 'Pair suffix style: the design’s majority is the rule';
    if (document.activeElement !== lenIn) lenIn.value = raw.maxLen ?? '';
  }

  // ---------------- source + gutter ----------------
  function drawSrc() {
    const d = D();
    if (document.activeElement !== ta && ta.value !== (ctx.raw.nets || '')) ta.value = ctx.raw.nets || '';
    const lines = (ctx.raw.nets || '').split(/\r?\n/);
    const byName = new Map((d?.nets || []).map((n) => [n.name, n]));
    const kicad = d?.source === 'KiCad netlist';
    gutter.innerHTML = lines.map((l, i) => {
      if (kicad) return `<div>${i + 1}</div>`;
      let t = l.trim();
      if (t.includes('\t')) t = t.split('\t')[0].trim();
      const n = byName.get(t.replace(/^"(.*)"$/, '$1'));
      const st = !n ? '' : n.kind === 'auto' ? 'auto' : n.codes.length ? 'bad' : 'ok';
      return `<div class="${st}${n && n.name === selected ? ' sel' : ''}">${i + 1}</div>`;
    }).join('') + '<div>&nbsp;</div>';
    gutter.scrollTop = ta.scrollTop;
    srcFoot.textContent = d ? `${lines.filter((l) => l.trim()).length} lines · ${d.counts.bad} flagged` : '';
  }

  // ---------------- net map ----------------
  function chip(n, d, extra = '') {
    const st = n.kind === 'auto' ? 'auto' : n.codes.length ? 'bad' : 'ok';
    const flag = n.fix ? '<span class="fx" aria-hidden="true">→</span>' : n.codes.length ? '<span class="fx w" aria-hidden="true">!</span>' : '';
    const label = `${n.name}${n.codes.length ? `, ${n.codes.map((c) => CODE[c]?.[0] || c).join(', ')}` : n.kind === 'auto' ? ', auto-named' : ', consistent'}`;
    return `<button class="nl-chip ${st}${n.name === selected ? ' sel' : ''}${extra}" role="option" aria-selected="${n.name === selected}" data-n="${esc(n.name)}" aria-label="${esc(label)}">${anatomy(n, d)}${flag}</button>`;
  }
  function drawMap() {
    const d = D();
    if (!d) { board.innerHTML = `<div class="nl-empty">${esc((ctx.result?.warnings || [])[0] || 'Paste net names.')}</div>`; return; }
    const nets = d.nets;
    const groups = [];
    const add = (key, title, sub, list, cls = '') => { if (list.length) groups.push({ key, title, sub, list, cls }); };
    const power = nets.filter((n) => n.kind === 'power');
    const pairs = nets.filter((n) => n.kind === 'pair');
    const busMap = {};
    for (const n of nets.filter((x) => x.kind === 'bus')) (busMap[n.bus] ||= []).push(n);
    const famMap = {};
    const other = [];
    for (const n of nets.filter((x) => x.kind === 'signal')) (n.family ? (famMap[n.family] ||= []) : other).push(n);
    for (const [k, list] of Object.entries(busMap)) if (list.length < 2) { other.push(...list); delete busMap[k]; }
    for (const [k, list] of Object.entries(famMap)) if (list.length < 2) { other.push(...list); delete famMap[k]; }
    add('power', 'Power and ground', 'rails', power, 'g-power');
    add('pairs', 'Differential pairs', 'names', pairs, 'g-pair');
    for (const [k, list] of Object.entries(busMap)) add(`bus-${k}`, `Bus ${k}`, 'bits', list, 'g-bus');
    for (const [k, list] of Object.entries(famMap).sort((a, b) => b[1].length - a[1].length)) add(`fam-${k}`, k, 'signals', list, 'g-fam');
    add('other', 'Other signals', '', other, 'g-fam');
    add('auto', 'Auto-named', 'give these a name', nets.filter((n) => n.kind === 'auto'), 'g-auto');

    const html = groups.map((g) => {
      const bad = g.list.filter((n) => n.codes.length).length;
      let body = '';
      if (g.key === 'pairs') {
        const byCore = {};
        for (const n of g.list) (byCore[n.pair.core.toUpperCase()] ||= []).push(n);
        body = Object.values(byCore).map((list) => {
          const p = list.find((n) => n.pair.pn === 'P'), nn = list.find((n) => n.pair.pn === 'N');
          const ghost = (x) => `<span class="nl-chip ghost" title="Missing half of the pair">${esc(x.advice.find((a) => /^\(add /.test(a))?.slice(5, -1) || 'missing half')}</span>`;
          const miss = list.find((n) => !n.pair.partner);
          return `<div class="nl-pair">${p ? chip(p, d) : ghost(miss)}${nn ? chip(nn, d) : ghost(miss)}<span class="nl-link" aria-hidden="true"></span></div>`;
        }).join('');
      } else {
        // names that spell one net two ways: bracketed together, the rest as they come
        const seen = new Set();
        for (const n of g.list) {
          if (seen.has(n.name)) continue;
          if (n.dup) {
            const twins = nets.filter((x) => x.dup === n.dup);
            twins.forEach((x) => seen.add(x.name));
            const target = twins.find((x) => x.fix)?.fix || twins.find((x) => !x.fix)?.name;
            body += `<div class="nl-dup"><div class="nl-dupl">same net, ${twins.length} spellings${target ? ` → <b>${esc(target)}</b>` : ''}</div><div class="nl-dupc">${twins.map((x) => chip(x, d)).join('')}</div></div>`;
          } else { seen.add(n.name); body += chip(n, d); }
        }
      }
      return `<section class="nl-grp ${g.cls}"><header><b>${esc(g.title)}</b><span>${g.list.length}${g.sub ? ` ${esc(g.sub)}` : ''}</span>${bad ? `<em>${bad} flagged</em>` : '<i>clean</i>'}</header><div class="nl-chips">${body}</div></section>`;
    }).join('');
    const had = document.activeElement?.closest?.('.nl-chip')?.dataset.n;
    board.innerHTML = html;
    if (had) board.querySelector(`.nl-chip[data-n="${CSS.escape(had)}"]`)?.focus({ preventScroll: true });
  }
  board.addEventListener('click', (e) => {
    const c = e.target.closest('.nl-chip[data-n]');
    if (!c) return;
    selected = c.dataset.n;
    drawMap(); drawInsp(); drawSrc();
    board.querySelector(`.nl-chip[data-n="${CSS.escape(selected)}"]`)?.focus({ preventScroll: true });
  });
  board.addEventListener('keydown', (e) => {
    const c = e.target.closest('.nl-chip[data-n]');
    if (!c) return;
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const all = [...board.querySelectorAll('.nl-chip[data-n]')];
    const next = all[Math.max(0, Math.min(all.length - 1, all.indexOf(c) + d))];
    selected = next.dataset.n;
    drawMap(); drawInsp(); drawSrc();
    board.querySelector(`.nl-chip[data-n="${CSS.escape(selected)}"]`)?.focus({ preventScroll: true });
  });

  // ---------------- inspector ----------------
  function drawInsp() {
    const d = D();
    if (!d) { insp.innerHTML = ''; return; }
    let n = d.nets.find((x) => x.name === selected);
    if (!n) { n = d.nets.find((x) => x.codes.length) || d.nets[0]; selected = n?.name ?? null; }
    const fixes = d.nets.filter((x) => x.fix).length;
    if (!n) { insp.innerHTML = ''; return; }
    const kind = n.kind === 'pair' ? `differential pair, ${n.pair.pn} half, ${n.pair.style}${n.pair.partner ? '' : ' · partner missing'}`
      : n.kind === 'power' ? 'power / ground rail' : n.kind === 'bus' ? `bus ${n.bus} member` : n.kind === 'auto' ? 'auto-generated name' : n.family ? `${n.family} signal` : 'signal';
    const probs = n.problems.flatMap((p) => p.split('; '));
    const tags = n.codes.map((c) => `<span class="nl-code ${CODE[c]?.[1] || 'warn'}">${esc(CODE[c]?.[0] || c)}</span>`).join('');
    let fixHtml = '';
    if (n.fix) {
      const df = diffHtml(n.name, n.fix);
      fixHtml = `<div class="nl-fix"><div class="nl-old">${df.from}</div><div class="nl-arrow">↓ suggested</div><div class="nl-new">${df.to}</div></div>`
        + '<button class="nl-btn nl-primary" data-act="one">Rename in the list</button>';
    }
    const advice = n.advice.map((a) => `<div class="nl-adv">${esc(a.replace(/^\(|\)$/g, ''))}</div>`).join('');
    insp.innerHTML = `<div class="nl-lab">${esc(kind)}</div><div class="nl-bigname">${anatomy(n, d)}</div>`
      + (n.codes.length ? `<div class="nl-tags">${tags}</div><ul class="nl-probs">${probs.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
        : n.kind === 'auto' ? '<div class="nl-okline auto">Auto-named: name it if you will probe, test or route it by rule.</div>'
          : '<div class="nl-okline">Consistent with the convention.</div>')
      + fixHtml + advice
      + `<div class="nl-allrow"><button class="nl-btn" data-act="all"${fixes ? '' : ' disabled'}>Apply all ${fixes} renames</button><span>${fixes ? 'the Renames tab lists them' : 'nothing to rename'}</span></div>`;
  }
  insp.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    const d = D();
    if (!a || !d) return;
    if (a === 'one') { const n = d.nets.find((x) => x.name === selected); if (n?.fix) apply(n.name, n.fix); }
    if (a === 'all') applyAll();
  });

  function drawSide() {
    const res = ctx.result || {};
    warnsEl.replaceChildren(...(res.warnings || []).map((w) => el('div', {}, esc(w))));
    notesEl.replaceChildren(el('summary', {}, `How the checks decide (${(res.notes || []).length} notes)`), ...(res.notes || []).map((x) => el('div', {}, esc(x))));
  }

  function drawAll() {
    if (ctx.result?.drawing) lastGood = ctx.result.drawing;
    else lastGood = null;
    drawConv(); drawMap(); drawInsp(); drawSrc(); drawSide();
  }
  ctx.onResult(drawAll);
}
