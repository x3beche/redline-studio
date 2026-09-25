// DOM Selector Finder: parses pasted HTML (no DOM, runs in Node), finds the
// element you name, builds candidate CSS selectors from its test ids, id,
// attributes and classes (and from a stable ancestor when it has none),
// checks each for uniqueness with a small Selectors Level 4 matcher, and ranks
// them by how well they survive builds and redesigns - after the locator
// guidance of Playwright ("Locators"), Cypress ("Best Practices: Selecting
// Elements") and Testing Library ("Which query should I use?").
// ---------------- a forgiving HTML parser (no DOM: runs in Node) ----------------
// Enough of the HTML parsing rules for pasted snippets: void elements, raw-text
// elements, implied end tags for p/li/td/tr/option, and stray end tags ignored.
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const CLOSES_P = new Set('address article aside blockquote div dl fieldset footer form h1 h2 h3 h4 h5 h6 header hr main nav ol p pre section table ul'.split(' '));
const IMPLIED = { li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'], option: ['option'] };
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', times: '×', hellip: '…', mdash: '—', ndash: '–' };
const decode = (t) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});

function parseHTML(src) {
  const nl = []; for (let k = 0; k < src.length; k++) if (src[k] === '\n') nl.push(k);
  const lineAt = (pos) => { let lo = 0, hi = nl.length; while (lo < hi) { const m = (lo + hi) >> 1; if (nl[m] < pos) lo = m + 1; else hi = m; } return lo + 1; };
  const root = { type: 'el', tag: '#root', attrs: {}, children: [], parent: null, line: 1 };
  const els = [], problems = [];
  let cur = root, i = 0;
  const text = (t) => { if (t) cur.children.push({ type: 'text', value: decode(t), parent: cur }); };
  const closeTo = (tag) => {
    for (let n = cur; n && n !== root; n = n.parent) if (n.tag === tag) { cur = n.parent; return true; }
    return false;
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { text(src.slice(i)); break; }
    if (lt > i) text(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? src.length : e + 3; continue; }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') { const e = src.indexOf('>', lt); i = e < 0 ? src.length : e + 1; continue; }
    if (src[lt + 1] === '/') {
      const m = /^<\/\s*([a-zA-Z][\w:-]*)\s*>/.exec(src.slice(lt, lt + 120));
      if (!m) { text('<'); i = lt + 1; continue; }
      const tag = m[1].toLowerCase();
      if (!VOID.has(tag) && !closeTo(tag)) problems.push(`line ${lineAt(lt)}: </${tag}> closes nothing that is open - ignored`);
      i = lt + m[0].length; continue;
    }
    const m = /^<([a-zA-Z][\w:-]*)/.exec(src.slice(lt, lt + 120));
    if (!m) { text('<'); i = lt + 1; continue; }
    const tag = m[1].toLowerCase();
    let j = lt + m[0].length, self = false;
    const attrs = {};
    for (;;) {
      while (j < src.length && /\s/.test(src[j])) j++;
      if (j >= src.length) { problems.push(`line ${lineAt(lt)}: <${tag}> is never closed with >`); break; }
      if (src[j] === '>') { j++; break; }
      if (src.startsWith('/>', j)) { self = true; j += 2; break; }
      if (src[j] === '/') { j++; continue; }
      const an = /^[^\s"'>/=]+/.exec(src.slice(j, j + 200));
      if (!an) { j++; continue; }
      const name = an[0].toLowerCase(); j += an[0].length;
      let k = j; while (k < src.length && /\s/.test(src[k])) k++;
      let val = '';
      if (src[k] === '=') {
        k++; while (k < src.length && /\s/.test(src[k])) k++;
        const q = src[k];
        if (q === '"' || q === "'") { const e = src.indexOf(q, k + 1); val = src.slice(k + 1, e < 0 ? src.length : e); j = e < 0 ? src.length : e + 1; }
        else { const u = /^[^\s>]*/.exec(src.slice(k))[0]; val = u; j = k + u.length; }
      }
      if (!(name in attrs)) attrs[name] = decode(val);
    }
    // implied end tags
    if (tag === 'p' || CLOSES_P.has(tag)) { for (let n = cur; n && n !== root; n = n.parent) { if (n.tag === 'p') { cur = n.parent; break; } if (!['span', 'b', 'i', 'em', 'strong', 'a'].includes(n.tag)) break; } }
    if (IMPLIED[tag] && IMPLIED[tag].includes(cur.tag)) cur = cur.parent;
    if (tag === 'tr' && (cur.tag === 'td' || cur.tag === 'th')) { cur = cur.parent; if (cur.tag === 'tr') cur = cur.parent; }
    const el = { type: 'el', tag, attrs, children: [], parent: cur, line: lineAt(lt), pos: lt, idx: els.length };
    cur.children.push(el); els.push(el);
    if (RAW.has(tag) && !self) {
      const re = new RegExp(`</${tag}\\s*>`, 'i'); const rest = src.slice(j); const e = re.exec(rest);
      const body = rest.slice(0, e ? e.index : rest.length);
      if (body) el.children.push({ type: 'text', value: tag === 'script' || tag === 'style' ? body : decode(body), parent: el });
      i = e ? j + e.index + e[0].length : src.length; continue;
    }
    if (!VOID.has(tag) && !self) cur = el;
    i = j;
  }
  const open = []; for (let n = cur; n && n !== root; n = n.parent) open.push(n);
  if (open.length && open.some((n) => !['html', 'body', 'head'].includes(n.tag))) problems.push(`${open.length} element(s) never closed: ${open.slice(0, 5).map((n) => `<${n.tag}> (line ${n.line})`).join(', ')}`);
  return { root, els, problems };
}

const elKids = (el) => el.children.filter((c) => c.type === 'el');
const textOf = (el) => el.children.map((c) => (c.type === 'text' ? c.value : ['script', 'style'].includes(c.tag) ? '' : textOf(c))).join('');
const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const classes = (el) => norm(el.attrs.class).split(' ').filter(Boolean);
const short = (el) => {
  let s = `<${el.tag}`;
  if (el.attrs.id) s += ` id="${el.attrs.id}"`;
  const c = classes(el); if (c.length) s += ` class="${c.slice(0, 2).join(' ')}${c.length > 2 ? ' …' : ''}"`;
  for (const a of ['type', 'name', 'href', 'src', 'role']) if (el.attrs[a] != null && s.length < 60) s += ` ${a}="${String(el.attrs[a]).slice(0, 24)}"`;
  return s + '>';
};

// ---------------- a small CSS selector engine (Selectors Level 4 subset) ----------------
// Compounds of tag, *, #id, .class, [attr], [attr=v], [attr^=v], [attr$=v], [attr*=v],
// :nth-of-type(n), :nth-child(n), :first-child, :last-child; combinators ' ' and '>'.
function parseSelector(sel) {
  const parts = []; let i = 0, comb = null;
  const s = String(sel).trim();
  if (!s) return null;
  while (i < s.length) {
    if (/\s|>/.test(s[i])) {
      let c = ' ';
      while (i < s.length && /\s|>/.test(s[i])) { if (s[i] === '>') c = '>'; i++; }
      comb = c; continue;
    }
    const cp = { tag: null, ids: [], cls: [], attrs: [], pseudo: [] };
    let any = false;
    for (;;) {
      let m;
      const rest = s.slice(i);
      if ((m = /^(\*|[a-zA-Z][\w-]*)/.exec(rest)) && !any) { cp.tag = m[1] === '*' ? null : m[1].toLowerCase(); }
      else if ((m = /^#((?:\\.|[\w-])+)/.exec(rest))) cp.ids.push(m[1].replace(/\\(.)/g, '$1'));
      else if ((m = /^\.((?:\\.|[\w-])+)/.exec(rest))) cp.cls.push(m[1].replace(/\\(.)/g, '$1'));
      else if ((m = /^\[\s*([\w:-]+)\s*(?:([~^$*|]?=)\s*(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\]\s]+))\s*)?\]/.exec(rest))) {
        cp.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, val: (m[3] ?? m[4] ?? m[5] ?? '').replace(/\\(.)/g, '$1') });
      } else if ((m = /^:(nth-of-type|nth-child)\(\s*(\d+)\s*\)/.exec(rest))) cp.pseudo.push({ k: m[1], n: +m[2] });
      else if ((m = /^:(first-child|last-child|first-of-type|last-of-type)/.exec(rest))) cp.pseudo.push({ k: m[1] });
      else break;
      any = true; i += m[0].length;
    }
    if (!any) return null; // something we do not support
    parts.push({ comb: parts.length ? comb || ' ' : null, cp }); comb = null;
  }
  return parts.length ? parts : null;
}
function matchCompound(el, cp) {
  if (el.tag === '#root') return false;
  if (cp.tag && el.tag !== cp.tag) return false;
  for (const id of cp.ids) if (el.attrs.id !== id) return false;
  const cl = classes(el);
  for (const c of cp.cls) if (!cl.includes(c)) return false;
  for (const a of cp.attrs) {
    const v = el.attrs[a.name];
    if (v == null) return false;
    if (!a.op) continue;
    if (a.op === '=' && v !== a.val) return false;
    if (a.op === '^=' && !v.startsWith(a.val)) return false;
    if (a.op === '$=' && !v.endsWith(a.val)) return false;
    if (a.op === '*=' && !v.includes(a.val)) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(a.val)) return false;
    if (a.op === '|=' && !(v === a.val || v.startsWith(a.val + '-'))) return false;
  }
  for (const p of cp.pseudo) {
    const sib = elKids(el.parent);
    const same = sib.filter((x) => x.tag === el.tag);
    if (p.k === 'nth-child' && sib.indexOf(el) + 1 !== p.n) return false;
    if (p.k === 'nth-of-type' && same.indexOf(el) + 1 !== p.n) return false;
    if (p.k === 'first-child' && sib[0] !== el) return false;
    if (p.k === 'last-child' && sib[sib.length - 1] !== el) return false;
    if (p.k === 'first-of-type' && same[0] !== el) return false;
    if (p.k === 'last-of-type' && same[same.length - 1] !== el) return false;
  }
  return true;
}
function matches(el, parts, k = parts.length - 1) {
  if (!matchCompound(el, parts[k].cp)) return false;
  if (k === 0) return true;
  if (parts[k].comb === '>') return !!el.parent && matches(el.parent, parts, k - 1);
  for (let p = el.parent; p && p.tag !== '#root'; p = p.parent) if (matches(p, parts, k - 1)) return true;
  return false;
}
const queryAll = (els, sel) => { const p = parseSelector(sel); return p ? els.filter((e) => matches(e, p)) : null; };

// ---------------- what makes a selector stable ----------------
// Rules of thumb from the Playwright, Cypress and Testing Library guides: test
// ids and semantic attributes survive redesigns; generated class names and ids
// change with every build; position (nth-of-type) breaks when content moves.
const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-e2e', 'data-automation-id'];
function tokenRisk(tok) {
  if (/^:r[\w]*:$|^radix-|^headlessui-|^react-select-\d|^(ember|ext-gen|yui_|gwt-uid-|mat-input-|mat-select-|downshift-)\d*/i.test(tok)) return 'generated by a framework at run time';
  if (/^(css|sc|jsx|emotion|svelte|styled|tw)-[\w]+$/i.test(tok) && /\d|[A-Z]/.test(tok.slice(3))) return 'a CSS-in-JS hash that changes with the build';
  if (/__[\w-]{5,}$/.test(tok) && /\d/.test(tok.split('__').pop())) return 'a CSS-modules hash that changes with the build';
  if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(tok) || /\d{4,}/.test(tok)) return 'contains a generated number';
  const last = tok.split(/[-_]/).pop();
  if (tok.length >= 6 && last.length >= 5 && /\d/.test(last) && /[a-z]/i.test(last)) return 'looks like a random hash';
  return null;
}
const tokenSoft = (tok) => {
  if (/^(is-|has-)?(active|selected|open|opened|closed|disabled|hover|focus|focused|checked|visible|hidden|current|loading|expanded|collapsed|error|valid|invalid)$/i.test(tok)) return { pen: 35, why: 'a state class: it comes and goes' };
  if (/^-?(m|p)[trblxyse]?-|^(flex|grid|block|inline|hidden|w-|h-|min-|max-|text-|bg-|font-|rounded|shadow|border|items-|justify-|gap-|space-|col-|row-|leading-|tracking-|opacity-|z-|top-|left-|right-|bottom-|absolute|relative|fixed|sticky)/.test(tok)) return { pen: 25, why: 'a utility (styling) class: it changes with the design' };
  if (/[-_]\d+$/.test(tok)) return { pen: 20, why: 'numbered: may shift when items are added' };
  return { pen: 0, why: '' };
};
const IDENT = /^-?[a-zA-Z_][\w-]*$/;
const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const idSel = (id) => (IDENT.test(id) ? `#${id}` : `[id=${q(id)}]`);

function ownCandidates(el) {
  const out = [];
  const a = el.attrs, t = el.tag;
  for (const k of TEST_ATTRS) if (a[k]) out.push({ sel: `[${k}=${q(a[k])}]`, kind: `test id (${k})`, score: 100 });
  if (a.id) {
    const r = tokenRisk(a.id);
    if (r) out.push({ sel: idSel(a.id), kind: 'id', score: 5, why: `id ${r}` });
    else { const s = tokenSoft(a.id); out.push({ sel: idSel(a.id), kind: 'id', score: 92 - s.pen, why: s.why }); }
  }
  if (a.name) out.push({ sel: `${t}[name=${q(a.name)}]`, kind: 'name', score: 86 });
  if (t === 'label' && a.for && !tokenRisk(a.for)) out.push({ sel: `label[for=${q(a.for)}]`, kind: 'label for', score: 80 });
  if (a['aria-label']) out.push({ sel: `${t}[aria-label=${q(a['aria-label'])}]`, kind: 'aria-label', score: 76, why: 'changes if the copy is translated' });
  if (a.placeholder) out.push({ sel: `${t}[placeholder=${q(a.placeholder)}]`, kind: 'placeholder', score: 66, why: 'changes with the copy' });
  if (t === 'img' && a.alt) out.push({ sel: `img[alt=${q(a.alt)}]`, kind: 'alt', score: 68 });
  if (t === 'a' && a.href && a.href.length < 70 && !/[?#].*=|sid=|token=/i.test(a.href)) out.push({ sel: `a[href=${q(a.href)}]`, kind: 'href', score: 70 });
  if (a.type && ['input', 'button'].includes(t)) out.push({ sel: `${t}[type=${q(a.type)}]`, kind: 'type', score: 62 });
  if (a.role) out.push({ sel: `[role=${q(a.role)}]`, kind: 'role', score: 58 });
  if (a.title) out.push({ sel: `${t}[title=${q(a.title)}]`, kind: 'title', score: 60, why: 'changes with the copy' });
  if (a.href && t !== 'a') { /* link-like elements rarely */ }
  const good = [], bad = [];
  for (const c of classes(el)) {
    const r = tokenRisk(c);
    if (r) { bad.push({ c, r }); continue; }
    const s = tokenSoft(c);
    good.push({ c, pen: s.pen, why: s.why });
  }
  for (const g of good) {
    if (!IDENT.test(g.c)) continue;
    out.push({ sel: `.${g.c}`, kind: 'class', score: 56 - g.pen, why: g.why });
    out.push({ sel: `${t}.${g.c}`, kind: 'tag + class', score: 55 - g.pen, why: g.why });
  }
  const plain = good.filter((g) => !g.pen && IDENT.test(g.c));
  for (let x = 0; x < plain.length; x++) for (let y = x + 1; y < plain.length; y++) out.push({ sel: `.${plain[x].c}.${plain[y].c}`, kind: 'two classes', score: 50 });
  for (const b of bad) out.push({ sel: IDENT.test(b.c) ? `.${b.c}` : `[class~=${q(b.c)}]`, kind: 'class', score: 4, why: `class ${b.r}` });
  out.push({ sel: t, kind: 'tag', score: 40 });
  return out;
}

// ---------------- names and roles, for role-based locators ----------------
function implicitRole(el) {
  const a = el.attrs, t = el.tag, ty = (a.type || 'text').toLowerCase();
  if (a.role) return a.role;
  if (t === 'button') return 'button';
  if (t === 'a' && a.href != null) return 'link';
  if (t === 'input') return { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', range: 'slider', number: 'spinbutton', search: 'searchbox', text: 'textbox', email: 'textbox', tel: 'textbox', url: 'textbox' }[ty] || null;
  if (t === 'textarea') return 'textbox';
  if (t === 'select') return a.multiple != null || +a.size > 1 ? 'listbox' : 'combobox';
  if (/^h[1-6]$/.test(t)) return 'heading';
  if (t === 'img' && a.alt) return 'img';
  return { nav: 'navigation', main: 'main', ul: 'list', ol: 'list', li: 'listitem', table: 'table', form: a['aria-label'] || a.name ? 'form' : null, dialog: 'dialog', option: 'option' }[t] || null;
}
function accName(el, els) {
  const a = el.attrs;
  if (a['aria-labelledby']) { const t = norm(a['aria-labelledby'].split(/\s+/).map((id) => { const x = els.find((e) => e.attrs.id === id); return x ? textOf(x) : ''; }).join(' ')); if (t) return t; }
  if (norm(a['aria-label'])) return norm(a['aria-label']);
  if (['input', 'select', 'textarea'].includes(el.tag)) {
    if (['submit', 'button', 'reset'].includes((a.type || '').toLowerCase())) return norm(a.value);
    const lab = a.id && els.find((e) => e.tag === 'label' && e.attrs.for === a.id);
    if (lab) return norm(textOf(lab));
    for (let p = el.parent; p; p = p.parent) if (p.tag === 'label') return norm(textOf(p));
    return norm(a.title || a.placeholder);
  }
  if (el.tag === 'img') return norm(a.alt);
  return norm(textOf(el)) || norm(a.title);
}
const js = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function run({ html, find, query, nth }) {
  const src = String(html || '');
  if (!src.trim()) return { warnings: ['Paste the HTML that contains the element (copy it from DevTools: right-click the parent, Copy > Copy outerHTML).'] };
  const { els, problems } = parseHTML(src);
  if (!els.length) return { warnings: ['No HTML elements found in the pasted text.'] };
  const Q = norm(query);
  if (!Q) return { warnings: ['Say which element: its visible text, an attribute (name=email), a selector, or a line number.'] };
  let found = [];
  if (find === 'text') {
    const low = Q.toLowerCase();
    const hit = (e) => [textOf(e), e.attrs['aria-label'], e.attrs.value, e.attrs.placeholder, e.attrs.alt, e.attrs.title].some((v) => norm(v).toLowerCase().includes(low));
    const all = els.filter((e) => !['script', 'style', 'head', 'html', 'body', 'title'].includes(e.tag) && hit(e));
    // the deepest element holding the text: none of its children holds it too
    found = all.filter((e) => !all.some((o) => o !== e && isAncestor(e, o)));
    // prefer an interactive ancestor of a text span (a <span> inside a <button>)
    found = found.map((e) => { for (let p = e; p && p.tag !== '#root'; p = p.parent) if (['button', 'a', 'label', 'option'].includes(p.tag) || p.attrs.role) return p; return e; });
    found = [...new Set(found)];
    const exact = found.filter((e) => norm(textOf(e)).toLowerCase() === low || [e.attrs['aria-label'], e.attrs.value].some((v) => norm(v).toLowerCase() === low));
    if (exact.length) found = [...exact, ...found.filter((e) => !exact.includes(e))];
  } else if (find === 'attr') {
    const m = /^([\w:-]+)\s*=\s*["']?(.*?)["']?$/.exec(Q);
    found = m ? els.filter((e) => e.attrs[m[1].toLowerCase()] === m[2]) : els.filter((e) => Object.values(e.attrs).some((v) => v === Q));
    if (!found.length && m) found = els.filter((e) => (e.attrs[m[1].toLowerCase()] || '').includes(m[2]));
  } else if (find === 'selector') {
    const r = queryAll(els, Q);
    if (r == null) return { warnings: [`"${Q}" uses selector syntax this tool does not evaluate (supported: tag, #id, .class, [attr=v], :nth-of-type(n), descendant and > combinators).`] };
    found = r;
  } else if (find === 'line') {
    const ln = parseInt(Q, 10);
    found = els.filter((e) => e.line === ln && !['html', 'head', 'body'].includes(e.tag));
    if (!Number.isFinite(ln)) return { warnings: ['Give a line number, e.g. 12.'] };
  }
  if (!found.length) return { warnings: [`Nothing matches ${find} "${Q}". Check the spelling, or search by another way (text, attribute, line).`] };
  const k = Math.max(1, Math.round(nth || 1));
  const warnings = [];
  if (k > found.length) warnings.push(`Only ${found.length} element(s) match; showing the last one.`);
  const target = found[Math.min(k, found.length) - 1];
  if (found.length > 1) warnings.push(`${found.length} elements match ${find} "${Q}"; this is number ${Math.min(k, found.length)} (${short(target)}, line ${target.line}). Change "Which match" to pick another.`);

  // score every candidate on the target itself, then anchored ones
  const count = (sel) => { const r = queryAll(els, sel); return r ? r.length : 0; };
  const uniq = (sel) => { const r = queryAll(els, sel); return r && r.length === 1 && r[0] === target; };
  const cands = [];
  const seen = new Set();
  const push = (c) => { if (seen.has(c.sel)) return; seen.add(c.sel); const n = count(c.sel); cands.push({ ...c, n, unique: n === 1 && uniq(c.sel) }); };
  const own = ownCandidates(target);
  own.forEach(push);
  // anchored: a stable, unique ancestor + a short part for the target
  if (!cands.some((c) => c.unique && c.score >= 50)) {
    for (let p = target.parent, depth = 1; p && p.tag !== '#root' && depth <= 6; p = p.parent, depth++) {
      const anchors = ownCandidates(p).filter((c) => c.score >= 50 && c.kind !== 'tag' && uniq2(els, c.sel, p));
      for (const A of anchors.slice(0, 3)) {
        for (const D of own.filter((c) => c.score >= 40).slice(0, 8)) {
          for (const comb of depth === 1 ? [' > ', ' '] : [' ']) {
            const sel = `${A.sel}${comb}${D.sel}`;
            push({ sel, kind: `inside ${A.kind}`, score: Math.min(A.score, D.score) - 8 - depth, why: [A.why, D.why].filter(Boolean).join('; ') });
          }
        }
        // position inside the anchor, for siblings that look the same
        const same = elKids(target.parent).filter((x) => x.tag === target.tag);
        if (same.length > 1) push({ sel: `${A.sel} ${target.tag}:nth-of-type(${same.indexOf(target) + 1})`, kind: 'position in anchor', score: 30 - depth, why: 'breaks when items are added or reordered' });
      }
    }
  }
  // last resort: the full position path
  const path = [];
  for (let p = target; p && p.tag !== '#root'; p = p.parent) {
    const same = elKids(p.parent).filter((x) => x.tag === p.tag);
    path.unshift(same.length > 1 ? `${p.tag}:nth-of-type(${same.indexOf(p) + 1})` : p.tag);
    if (uniq2(els, path.join(' > '), target) && path.length > 1) break;
  }
  push({ sel: path.join(' > '), kind: 'position path', score: 10, why: 'breaks when the page structure changes' });

  // rank: unique first, then stability, then length (shorter is easier to read and to keep)
  const rank = (c) => (c.unique ? 1000 : 0) + c.score - c.sel.length / 25;
  cands.sort((a, b) => rank(b) - rank(a));
  const best = cands.find((c) => c.unique);
  if (!best) warnings.push('No unique selector could be built. Add a data-testid to the element.');
  else if (best.score < 50) warnings.push(`The best selector (${best.sel}) is fragile: ${best.why || 'it depends on position or generated names'}. Add data-testid="…" to the element and select on that.`);
  const role = implicitRole(target), name = accName(target, els);
  // How many elements share this role and name: getByRole then needs .nth().
  const twins = role && name ? els.filter((e) => implicitRole(e) === role && accName(e, els) === name) : [];
  const nthSuffix = twins.length > 1 ? `.nth(${twins.indexOf(target)})` : '';
  // Repeated cards: the nearest repeated ancestor with a text of its own that
  // tells it apart (the Playwright filter({ hasText }) pattern).
  let scoped = null;
  if (!best || best.score < 50) {
    for (let p = target.parent, d = 0; p && p.tag !== '#root' && d < 5 && !scoped; p = p.parent, d++) {
      for (const c of ownCandidates(p).filter((c) => c.score >= 40 && c.kind !== 'tag' || c.kind === 'tag')) {
        const group = queryAll(els, c.sel) || [];
        if (group.length < 2 || !group.includes(p)) continue;
        const mine = textOf(p).split(/\n|(?<=[.!?])\s/).map(norm).filter((t) => t && t.length <= 60 && !(name && t === name));
        const key = [...elKids(p).map((k) => norm(textOf(k))), ...mine].filter((t) => t && t !== name && t.length <= 60)
          .find((t) => group.filter((g) => norm(textOf(g)).includes(t)).length === 1);
        if (key) { scoped = { sel: c.sel, text: key }; break; }
      }
    }
  }
  const lines = [];
  if (best) {
    lines.push(`// CSS`, `document.querySelector(${js(best.sel)})`, '',
      `// Playwright`, `page.locator(${js(best.sel)})`);
    if (scoped) lines.push(`page.locator(${js(scoped.sel)}).filter({ hasText: ${js(scoped.text)} })${role && name ? `.getByRole(${js(role)}, { name: ${js(name.slice(0, 60))} })` : `.locator(${js(target.tag)})`}   // the card that says ${scoped.text}`);
    if (role && name) lines.push(`page.getByRole(${js(role)}, { name: ${js(name.slice(0, 60))} })${nthSuffix}   // role + name: Playwright's first choice${nthSuffix ? ` (${twins.length} share this name)` : ''}`);
    else if (name && ['input', 'select', 'textarea'].includes(target.tag)) lines.push(`page.getByLabel(${js(name.slice(0, 60))})`);
    lines.push('', `// Cypress`, `cy.get(${js(best.sel)})`);
    if (scoped) lines.push(`cy.contains(${js(scoped.sel)}, ${js(scoped.text)}).find(${js(own.find((c) => c.score >= 40 && c.kind !== 'tag')?.sel || target.tag)})`);
    if (name && !['input', 'select', 'textarea'].includes(target.tag)) lines.push(`cy.contains(${js(target.tag)}, ${js(name.slice(0, 60))})`);
    lines.push('', `// Selenium (Java)`, `driver.findElement(By.cssSelector(${JSON.stringify(best.sel)}))`,
      '', '// Testing Library', role && name ? (nthSuffix ? `screen.getAllByRole(${js(role)}, { name: ${js(name.slice(0, 60))} })[${twins.indexOf(target)}]` : `screen.getByRole(${js(role)}, { name: ${js(name.slice(0, 60))} })`)
        : name && ['input', 'select', 'textarea'].includes(target.tag) ? `screen.getByLabelText(${js(name.slice(0, 60))})`
          : name ? `screen.getByText(${js(name.slice(0, 60))})` : '// no accessible name: add a label or data-testid');
  }
  if (problems.length) warnings.push(...problems.slice(0, 2).map((p) => `HTML: ${p}`));

  // For the page only (manifest agentOmit): the parsed tree, every candidate's
  // matches and each token's stability, so the page can draw what run() found.
  const MAXN = 600;
  const depthOf = (e) => { let d = 0; for (let p = e.parent; p && p.tag !== '#root'; p = p.parent) d++; return d; };
  const lineIdx = new Map();
  const onLine = (e) => {
    if (['html', 'head', 'body'].includes(e.tag)) return 0;
    const k = e.line; const n = (lineIdx.get(k) || 0) + 1; lineIdx.set(k, n); return n;
  };
  const tokKind = (t) => (tokenRisk(t) ? 'bad' : tokenSoft(t).pen ? 'soft' : 'ok');
  const tokWhy = (t) => tokenRisk(t) || tokenSoft(t).why || '';
  const SHOW = [...TEST_ATTRS, 'name', 'type', 'for', 'role', 'aria-label', 'placeholder', 'href', 'alt', 'title'];
  const dom = {
    nodes: els.slice(0, MAXN).map((e) => ({
      tag: e.tag, depth: depthOf(e), parent: e.parent && e.parent.tag !== '#root' ? e.parent.idx : -1, line: e.line, nth: onLine(e),
      id: e.attrs.id != null ? { v: e.attrs.id, k: tokKind(e.attrs.id), why: tokWhy(e.attrs.id) } : null,
      cls: classes(e).map((c) => ({ v: c, k: tokKind(c), why: tokWhy(c) })),
      attrs: SHOW.filter((a) => e.attrs[a] != null).map((a) => [a, String(e.attrs[a]).slice(0, 40), TEST_ATTRS.includes(a) ? 'test' : '']),
      text: norm(e.children.filter((c) => c.type === 'text').map((c) => c.value).join(' ')).slice(0, 48),
    })),
    total: els.length,
    target: target.idx,
    found: found.map((e) => e.idx),
    nth: Math.min(k, found.length),
    best: best ? best.sel : null,
    cands: cands.slice(0, 24).map((c) => ({ sel: c.sel, kind: c.kind, n: c.n, unique: c.unique, score: Math.max(0, Math.min(100, Math.round(c.score))), why: c.why || '',
      hits: (queryAll(els, c.sel) || []).slice(0, 80).map((e) => e.idx) })),
    role, name: name ? name.slice(0, 60) : '',
  };
  return {
    dom,
    values: [
      { label: 'Best selector', value: best ? best.sel : '–', tone: best ? (best.score >= 50 ? 'ok' : 'warn') : 'bad' },
      { label: 'Stability', value: best ? `${Math.max(0, Math.min(100, Math.round(best.score)))} / 100` : '–', hint: best ? best.kind : '' },
      { label: 'Element', value: short(target), hint: `line ${target.line}` },
      { label: 'Role and name', value: role ? `${role}${name ? ` "${name.slice(0, 40)}"` : ''}` : '–' },
      { label: 'Matches for the search', value: found.length },
      ...(scoped ? [{ label: 'Scoped by text', value: `${scoped.sel} with "${scoped.text.slice(0, 30)}"`, hint: 'more stable than position' }] : []),
    ],
    warnings,
    tables: [
      { title: 'Candidates (best first)', columns: ['Selector', 'Kind', 'Matches', 'Unique', 'Stability', 'Note'],
        rows: cands.slice(0, 24).map((c) => [c.sel, c.kind, c.n, c.unique ? 'yes' : 'no', Math.max(0, Math.min(100, Math.round(c.score))), c.why || '']) },
      { title: 'Path to the element', columns: ['Depth', 'Element', 'Line'],
        rows: (() => { const r = []; for (let p = target; p && p.tag !== '#root'; p = p.parent) r.unshift(p); return r.map((p, i) => [i, short(p), p.line]); })() },
    ],
    texts: lines.length ? [{ title: 'Code', body: lines.join('\n') + '\n', lang: 'js' }] : [],
    notes: [
      'Stability ranks: test ids (data-testid, data-cy...) 100, a hand-written id 92, name 86, label/href/aria-label/alt 66-80, type 62, plain class 55, tag 40, position 10-30. Generated ids and hashed classes (css-1x2y3, Foo__a8f3k, :r1:) score near zero.',
      'Uniqueness is checked against the pasted HTML only; on the full page a selector may match more. Paste the largest stable container you can.',
      'Role and name locators (getByRole) are what Playwright and Testing Library recommend first: they follow what the user sees.',
    ],
  };
}
function isAncestor(a, b) { for (let p = b.parent; p; p = p.parent) if (p === a) return true; return false; }
function uniq2(els, sel, el) { const r = queryAll(els, sel); return !!r && r.length === 1 && r[0] === el; }
