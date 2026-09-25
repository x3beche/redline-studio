// Accessibility Audit Lite: a static read of pasted HTML against the WCAG 2.2
// checks that can be decided from markup alone - text contrast (1.4.3/1.4.6),
// names for fields, buttons, links and images (1.1.1, 1.3.1, 2.4.4, 4.1.2),
// keyboard reach and focus order (2.1.1, 2.4.3, 2.4.7), language, title,
// headings and zoom. Sources: W3C WCAG 2.2, W3C Accessible Name Computation 1.2.
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

// ---------------- colour and contrast (WCAG 2.2, 1.4.3) ----------------
// Relative luminance and contrast ratio: WCAG 2.2 "relative luminance" and
// "contrast ratio" definitions, (L1 + 0.05) / (L2 + 0.05), sRGB linearised.
const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', maroon: '#800000', purple: '#800080', fuchsia: '#ff00ff', lime: '#00ff00', olive: '#808000',
  yellow: '#ffff00', navy: '#000080', teal: '#008080', aqua: '#00ffff', orange: '#ffa500', lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', dimgray: '#696969', gainsboro: '#dcdcdc',
  whitesmoke: '#f5f5f5', pink: '#ffc0cb', gold: '#ffd700', tomato: '#ff6347', crimson: '#dc143c', coral: '#ff7f50',
  darkblue: '#00008b', royalblue: '#4169e1', steelblue: '#4682b4', skyblue: '#87ceeb', lightblue: '#add8e6',
  darkgreen: '#006400', seagreen: '#2e8b57', lightgreen: '#90ee90', darkred: '#8b0000', brown: '#a52a2a',
  beige: '#f5f5dc', ivory: '#fffff0', slategray: '#708090', lightslategray: '#778899', transparent: 'transparent',
};
function parseColor(t) {
  t = String(t || '').trim().toLowerCase().replace(/\s*!important$/, '');
  if (!t) return null;
  if (NAMED[t]) t = NAMED[t];
  if (t === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^#([0-9a-f]{3,8})$/.exec(t);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  m = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(t);
  if (!m) return null;
  const p = m[2].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
  if (p.length < 3) return null;
  const num = (s, full) => (s.endsWith('%') ? (parseFloat(s) / 100) * full : parseFloat(s));
  const a = p[3] != null ? num(p[3], 1) : 1;
  if (m[1].startsWith('rgb')) {
    const [r, g, b] = p.slice(0, 3).map((s) => num(s, 255));
    return [r, g, b, a].every(Number.isFinite) ? { r, g, b, a } : null;
  }
  // hsl -> rgb (CSS Color 4, section 7.1)
  const h = ((parseFloat(p[0]) % 360) + 360) % 360, s = parseFloat(p[1]) / 100, l = parseFloat(p[2]) / 100;
  if (![h, s, l, a].every(Number.isFinite)) return null;
  const f = (n) => { const k = (n + h / 30) % 12; return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
  return { r: f(0), g: f(8), b: f(4), a };
}
const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
const lum = (c) => {
  const ch = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
};
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

// ---------------- a small cascade: inline style and simple <style> rules ----------------
function declarations(text) {
  const out = {};
  for (const d of String(text || '').split(';')) {
    const k = d.indexOf(':'); if (k < 0) continue;
    out[d.slice(0, k).trim().toLowerCase()] = d.slice(k + 1).trim();
  }
  return out;
}
// Rules whose selector is one compound (tag, .class, #id, tag.class...) are
// applied; anything with combinators or pseudo-classes is counted as skipped.
function styleRules(els) {
  const rules = [], skipped = [], outlineOff = [];
  let order = 0;
  for (const el of els.filter((e) => e.tag === 'style')) {
    const css = textOf(el).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decl = declarations(m[2]);
      for (const selRaw of m[1].split(',')) {
        const sel = selRaw.trim(); if (!sel || sel.startsWith('@')) continue;
        if (/:focus/.test(sel) && /^(none|0)\b/.test(decl.outline || decl['outline-style'] || '') && !decl['box-shadow'] && !decl.border) outlineOff.push(sel);
        const c = /^([a-z][\w-]*|\*)?((?:[#.][\w-]+)*)$/i.exec(sel);
        if (!c) { if ('color' in decl || 'background' in decl || 'background-color' in decl || 'font-size' in decl) skipped.push(sel); continue; }
        const tag = c[1] && c[1] !== '*' ? c[1].toLowerCase() : null;
        const ids = [...c[2].matchAll(/#([\w-]+)/g)].map((x) => x[1]);
        const cls = [...c[2].matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
        rules.push({ tag, ids, cls, decl, spec: ids.length * 10000 + cls.length * 100 + (tag ? 1 : 0), order: order++ });
      }
    }
  }
  return { rules, skipped, outlineOff };
}
function ownStyle(el, rules) {
  const hit = rules.filter((r) => (!r.tag || r.tag === el.tag) && r.ids.every((i) => el.attrs.id === i) && r.cls.every((c) => classes(el).includes(c)))
    .sort((a, b) => a.spec - b.spec || a.order - b.order);
  const out = {};
  for (const r of hit) Object.assign(out, r.decl);
  return Object.assign(out, declarations(el.attrs.style));
}
const HEAD_SIZE = { h1: 32, h2: 24, h3: 18.72, h4: 16, h5: 13.28, h6: 10.72 };
function fontPx(v, parentPx) {
  const m = /^([\d.]+)(px|pt|em|rem|%)?$/.exec(String(v || '').trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return { px: n, pt: n * 4 / 3, em: n * parentPx, rem: n * 16, '%': (n / 100) * parentPx }[m[2] || 'px'] ?? null;
}

// ---------------- accessible names (after W3C accname 1.2, simplified) ----------------
function nameOf(el, byId, labelsFor) {
  const a = el.attrs;
  if (a['aria-labelledby']) {
    const t = norm(a['aria-labelledby'].split(/\s+/).map((id) => (byId.get(id)?.[0] ? textOf(byId.get(id)[0]) : '')).join(' '));
    if (t) return { name: t, how: 'aria-labelledby' };
  }
  if (norm(a['aria-label'])) return { name: norm(a['aria-label']), how: 'aria-label' };
  if (['input', 'select', 'textarea'].includes(el.tag)) {
    if (el.tag === 'input' && ['submit', 'reset', 'button'].includes((a.type || '').toLowerCase())) {
      return norm(a.value) ? { name: norm(a.value), how: 'value' } : { name: a.type === 'submit' ? 'Submit' : a.type === 'reset' ? 'Reset' : '', how: 'default' };
    }
    if (el.tag === 'input' && (a.type || '').toLowerCase() === 'image') return norm(a.alt) ? { name: norm(a.alt), how: 'alt' } : { name: '', how: '' };
    const lab = (a.id && labelsFor.get(a.id)) || null;
    if (lab && norm(textContentName(lab))) return { name: norm(textContentName(lab)), how: 'label for' };
    for (let p = el.parent; p; p = p.parent) if (p.tag === 'label') { const t = norm(textContentName(p)); if (t) return { name: t, how: 'wrapping label' }; }
    if (norm(a.title)) return { name: norm(a.title), how: 'title' };
    if (norm(a.placeholder)) return { name: norm(a.placeholder), how: 'placeholder' };
    return { name: '', how: '' };
  }
  if (el.tag === 'img' || (el.tag === 'area')) return a.alt != null ? { name: norm(a.alt), how: 'alt' } : { name: '', how: '' };
  const t = norm(textContentName(el));
  if (t) return { name: t, how: 'content' };
  if (norm(a.title)) return { name: norm(a.title), how: 'title' };
  return { name: '', how: '' };
}
// Text of a subtree as a screen reader reads it: img alt, svg <title>, skipping aria-hidden.
function textContentName(el) {
  return el.children.map((c) => {
    if (c.type === 'text') return c.value;
    if (c.attrs['aria-hidden'] === 'true' || ['script', 'style', 'template'].includes(c.tag)) return '';
    if (c.tag === 'img') return ' ' + (c.attrs['aria-label'] || c.attrs.alt || '') + ' ';
    if (c.tag === 'svg') { if (c.attrs['aria-label']) return c.attrs['aria-label']; const t = c.children.find((k) => k.type === 'el' && k.tag === 'title'); return t ? textOf(t) : ''; }
    if (['input', 'select', 'textarea'].includes(c.tag)) return '';
    return ' ' + (c.attrs['aria-label'] || textContentName(c)) + ' ';
  }).join('');
}

const FOCUSABLE = (el) => {
  const a = el.attrs;
  if ('disabled' in a && ['button', 'input', 'select', 'textarea'].includes(el.tag)) return false;
  if (el.tag === 'a' || el.tag === 'area') return a.href != null || a.tabindex != null;
  if (el.tag === 'input') return (a.type || '').toLowerCase() !== 'hidden';
  if (['button', 'select', 'textarea', 'iframe', 'summary'].includes(el.tag)) return true;
  if (a.contenteditable != null && a.contenteditable !== 'false') return true;
  return a.tabindex != null && Number.isFinite(parseInt(a.tabindex, 10));
};
const VAGUE = /^(click here|here|read more|more|learn more|link|this|details|go)$/i;

export function run({ html, textColor, pageBg, level }) {
  const src = String(html || '');
  if (!src.trim()) return { warnings: ['Paste some HTML: a page, a component or a form.'] };
  const { els, problems } = parseHTML(src);
  if (!els.length) return { warnings: ['No HTML elements found in the pasted text. Paste markup such as <form>…</form>.'] };
  const issues = [];
  const add = (sev, rule, wcag, el, why, fix) => issues.push({ sev, rule, wcag, el, why, fix });
  const byId = new Map();
  for (const el of els) if (el.attrs.id) { if (!byId.has(el.attrs.id)) byId.set(el.attrs.id, []); byId.get(el.attrs.id).push(el); }
  const labelsFor = new Map();
  for (const el of els) if (el.tag === 'label' && el.attrs.for) labelsFor.set(el.attrs.for, el);
  const hiddenAncestor = (el) => { for (let p = el; p; p = p.parent) if (p.attrs && (p.attrs['aria-hidden'] === 'true' || 'hidden' in p.attrs)) return p; return null; };
  const AAA = level === 'AAA';

  // --- document ---
  const htmlEl = els.find((e) => e.tag === 'html');
  if (htmlEl && !norm(htmlEl.attrs.lang)) add('error', 'Page has no language', '3.1.1', htmlEl, 'Screen readers pick the voice and pronunciation from lang.', 'Add lang="en" (or the page\'s language) to <html>.');
  if (htmlEl && !els.some((e) => e.tag === 'title' && norm(textOf(e)))) add('error', 'Page has no title', '2.4.2', htmlEl, 'The title is the first thing announced and names the tab.', 'Add a <title> that says what the page is.');
  const vp = els.find((e) => e.tag === 'meta' && (e.attrs.name || '').toLowerCase() === 'viewport');
  if (vp) {
    const c = (vp.attrs.content || '').toLowerCase().replace(/\s/g, '');
    const max = /maximum-scale=([\d.]+)/.exec(c);
    if (/user-scalable=(no|0)/.test(c) || (max && parseFloat(max[1]) < 2)) add('error', 'Zoom is blocked', '1.4.4', vp, 'People with low vision cannot pinch-zoom the text.', 'Remove user-scalable=no and any maximum-scale below 5.');
  }
  for (const [id, list] of byId) if (list.length > 1) add('error', `Duplicate id "${id}"`, '4.1.1*', list[1], `Used ${list.length} times; labels and aria-labelledby find only the first one.`, 'Make every id unique.');

  // --- headings ---
  const heads = els.filter((e) => /^h[1-6]$/.test(e.tag));
  let prev = 0;
  for (const h of heads) {
    const lv = +h.tag[1];
    if (prev && lv > prev + 1) add('warning', `Heading level skipped (h${prev} to h${lv})`, '1.3.1', h, 'Screen reader users navigate by heading level; a gap looks like missing content.', `Use h${prev + 1}, and style it to look as you want.`);
    if (!norm(textContentName(h))) add('error', 'Empty heading', '2.4.6', h, 'An empty heading is announced as "heading" with nothing after it.', 'Put text in it or remove it.');
    prev = lv;
  }
  if (htmlEl && heads.length && !heads.some((h) => h.tag === 'h1')) add('warning', 'No h1', '1.3.1', heads[0], 'The h1 tells what the page is about.', 'Make the main title an h1.');

  // --- images ---
  for (const el of els.filter((e) => e.tag === 'img')) {
    if (el.attrs.alt == null && el.attrs.role !== 'presentation' && el.attrs['aria-hidden'] !== 'true' && !el.attrs['aria-label']) add('error', 'Image without alt', '1.1.1', el, 'A screen reader reads the file name instead.', 'Add alt="what it shows", or alt="" if it is decoration.');
    else if (el.attrs.alt && /\.(png|jpe?g|gif|svg|webp)$|^(image|img|photo|picture|icon)$/i.test(norm(el.attrs.alt))) add('warning', 'Alt text is a file name or a placeholder', '1.1.1', el, `alt="${el.attrs.alt}" says nothing about the image.`, 'Describe what the image shows or does.');
  }
  for (const el of els.filter((e) => e.tag === 'input' && (e.attrs.type || '').toLowerCase() === 'image' && !norm(e.attrs.alt))) add('error', 'Image button without alt', '1.1.1', el, 'The button has no name.', 'Add alt that says what the button does.');

  // --- form fields ---
  for (const el of els.filter((e) => ['input', 'select', 'textarea'].includes(e.tag))) {
    const type = (el.attrs.type || 'text').toLowerCase();
    if (el.tag === 'input' && ['hidden', 'submit', 'reset', 'button', 'image'].includes(type)) continue;
    if (hiddenAncestor(el)) continue;
    const n = nameOf(el, byId, labelsFor);
    if (!n.name) add('error', `${el.tag === 'input' ? `Input (${type})` : el.tag[0].toUpperCase() + el.tag.slice(1)} without a label`, '1.3.1 / 4.1.2', el, 'A screen reader announces only the field type ("edit text", "checkbox") and the user cannot tell what it is for.', el.attrs.id ? `Add <label for="${el.attrs.id}">…</label>.` : 'Give it an id and a <label for>, or wrap it in <label>, or add aria-label.');
    else if (n.how === 'placeholder') add('warning', 'Placeholder used as the only label', '3.3.2', el, 'The placeholder vanishes as soon as the user types, and is often low contrast.', 'Add a visible <label>.');
    else if (n.how === 'title') add('warning', 'Title used as the only label', '3.3.2', el, 'title is invisible to touch and keyboard users.', 'Add a visible <label>.');
  }
  for (const el of els.filter((e) => e.tag === 'label' && e.attrs.for && !byId.has(e.attrs.for))) add('error', `Label points to a missing id "${el.attrs.for}"`, '1.3.1', el, 'The label is attached to nothing.', 'Fix the for= value or the field\'s id.');
  for (const el of els) for (const at of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
    if (!el.attrs[at]) continue;
    const miss = el.attrs[at].split(/\s+/).filter((id) => id && !byId.has(id));
    if (miss.length) add('error', `${at} points to a missing id`, '4.1.2', el, `No element with id ${miss.map((x) => `"${x}"`).join(', ')}.`, 'Point it at an id that exists.');
  }

  // --- buttons and links ---
  for (const el of els.filter((e) => e.tag === 'button' || e.tag === 'a' || e.attrs.role === 'button' || e.attrs.role === 'link')) {
    if (hiddenAncestor(el)) continue;
    if (el.tag === 'a' && el.attrs.href == null && !el.attrs.role && !el.attrs.tabindex) {
      if (el.attrs.onclick) add('error', 'Link without href', '2.1.1', el, 'An <a> without href cannot be reached with Tab and is not announced as a link.', 'Use <button> for actions, or give it an href.');
      continue;
    }
    const n = nameOf(el, byId, labelsFor);
    const what = el.tag === 'a' || el.attrs.role === 'link' ? 'Link' : 'Button';
    if (!n.name) add('error', `${what} without a name`, '4.1.2 / 2.4.4', el, `Announced as just "${what.toLowerCase()}" - an icon alone has no text.`, 'Add aria-label="what it does", or alt on the icon image, or visually hidden text.');
    else if (what === 'Link' && VAGUE.test(n.name)) add('warning', `Vague link text "${n.name}"`, '2.4.4', el, 'Out of context (a links list) it does not say where it goes.', 'Say where it goes: "Read the pricing details".');
  }

  // --- keyboard and focus order ---
  for (const el of els.filter((e) => (e.attrs.onclick != null) && !['a', 'button', 'input', 'select', 'textarea', 'summary', 'label', 'body', 'form', 'option'].includes(e.tag))) {
    if (!FOCUSABLE(el)) add('error', `Clickable <${el.tag}> not reachable by keyboard`, '2.1.1', el, 'It has onclick but no tabindex and no role, so keyboard and screen reader users cannot use it.', 'Use a <button>, or add role="button" tabindex="0" and handle Enter and Space.');
    else if (!el.attrs.role) add('warning', `Clickable <${el.tag}> has no role`, '4.1.2', el, 'It can be focused but is not announced as a button.', 'Use <button>, or add role="button".');
  }
  for (const el of els.filter((e) => e.attrs.role === 'button' && e.tag !== 'button' && !FOCUSABLE(e))) {
    if (!issues.some((i) => i.el === el)) add('error', 'role="button" without tabindex', '2.1.1', el, 'It is announced as a button but Tab never reaches it.', 'Add tabindex="0" and key handlers, or use <button>.');
  }
  const focusables = els.filter((e) => FOCUSABLE(e) && parseInt(e.attrs.tabindex, 10) !== -1 && !(e.tag === 'input' && (e.attrs.type || '').toLowerCase() === 'hidden'));
  for (const el of focusables) {
    const h = hiddenAncestor(el);
    if (h) add('error', 'Focusable element inside aria-hidden', '4.1.2', el, 'Tab lands on something the screen reader says is not there.', 'Add tabindex="-1" or inert to the hidden part, or unhide it.');
  }
  for (const el of focusables.filter((e) => parseInt(e.attrs.tabindex, 10) > 0)) add('warning', `Positive tabindex (${el.attrs.tabindex})`, '2.4.3', el, 'It jumps ahead of the page order, so focus moves in an order that does not match what is seen.', 'Use tabindex="0" and put the element where it belongs in the source.');
  // Browser order: tabindex > 0 ascending (ties in source order), then 0/native in source order.
  const ordered = [
    ...focusables.filter((e) => parseInt(e.attrs.tabindex, 10) > 0).sort((a, b) => parseInt(a.attrs.tabindex, 10) - parseInt(b.attrs.tabindex, 10) || a.idx - b.idx),
    ...focusables.filter((e) => !(parseInt(e.attrs.tabindex, 10) > 0)),
  ];

  // --- iframes, media ---
  for (const el of els.filter((e) => e.tag === 'iframe' && !norm(e.attrs.title) && !norm(e.attrs['aria-label']))) add('warning', 'Iframe without title', '4.1.2', el, 'It is announced as "frame" with no hint of what is inside.', 'Add title="what it contains".');
  for (const el of els.filter((e) => (e.tag === 'video' || e.tag === 'audio') && 'autoplay' in e.attrs && !('muted' in e.attrs))) add('warning', 'Media plays sound on its own', '1.4.2', el, 'Autoplaying sound talks over the screen reader.', 'Add muted, or do not autoplay.');

  // --- contrast ---
  const { rules, skipped, outlineOff } = styleRules(els);
  for (const sel of outlineOff) add('warning', `Focus outline removed (${sel})`, '2.4.7', null, 'Keyboard users cannot see where the focus is.', 'Keep an outline, or replace it with a visible box-shadow or border in :focus-visible.');
  for (const el of els) if (/outline\s*:\s*(none|0)\b/i.test(el.attrs.style || '') && FOCUSABLE(el)) add('warning', 'Focus outline removed inline', '2.4.7', el, 'Keyboard users cannot see where the focus is.', 'Remove outline:none, or give it a visible :focus-visible style.');
  const baseFg = parseColor(textColor) || { r: 0, g: 0, b: 0, a: 1 };
  const baseBg = parseColor(pageBg) || { r: 255, g: 255, b: 255, a: 1 };
  const warnings = [];
  if (!parseColor(textColor)) warnings.push(`Default text colour "${textColor}" does not read; using black. Write #333, rgb(51,51,51) or a colour name.`);
  if (!parseColor(pageBg)) warnings.push(`Page background "${pageBg}" does not read; using white.`);
  const comp = new Map();
  const unresolved = new Set();
  const compute = (el) => {
    if (comp.has(el)) return comp.get(el);
    const p = el.parent && el.parent.tag !== '#root' ? compute(el.parent) : { fg: baseFg, bg: { ...baseBg, a: 1 }, px: 16, bold: false, fgRaw: null };
    const st = ownStyle(el, rules);
    let bg = p.bg;
    const bgRaw = st['background-color'] ?? (st.background && /^(#|rgb|hsl|[a-z]+$)/i.test(st.background.trim()) ? st.background.trim().split(/\s+/)[0] : undefined);
    if (bgRaw != null) { const c = parseColor(bgRaw); if (c) bg = over(c, p.bg); else unresolved.add(`background ${bgRaw}`); }
    else if (st.background && /gradient|url\(/.test(st.background)) unresolved.add('background images/gradients');
    let fg = p.fg, fgRaw = p.fgRaw;
    if (st.color != null) { const c = parseColor(st.color); if (c) { fg = c; fgRaw = st.color.replace(/\s*!important$/i, '').trim(); } else unresolved.add(`color ${st.color}`); }
    let px = HEAD_SIZE[el.tag] ?? p.px;
    if (el.tag === 'small') px = p.px * 0.833;
    if (st['font-size']) { const v = fontPx(st['font-size'], p.px); if (v) px = v; }
    let bold = p.bold || /^(h[1-6]|b|strong|th)$/.test(el.tag);
    const fw = st['font-weight'];
    if (fw) bold = fw === 'bold' || fw === 'bolder' || parseInt(fw, 10) >= 700;
    const r = { fg, bg, px, bold, fgRaw };
    comp.set(el, r); return r;
  };
  const pairs = [];
  for (const el of els) {
    if (['script', 'style', 'title', 'head', 'template', 'option'].includes(el.tag) || hiddenAncestor(el)) continue;
    const own = norm(el.children.filter((c) => c.type === 'text').map((c) => c.value).join(' '));
    const ph = '';
    if (!own) continue;
    const c = compute(el);
    const fg = over(c.fg, c.bg);
    const r = ratio(fg, c.bg);
    // Large text: 18 pt (24 px) regular or 14 pt (18.66 px) bold - WCAG 2.2 definition.
    const large = c.px >= 24 || (c.bold && c.px >= 18.66);
    const need = AAA ? (large ? 4.5 : 7) : (large ? 3 : 4.5);
    const disabled = 'disabled' in el.attrs || (el.parent && 'disabled' in el.parent.attrs);
    pairs.push({ el, text: own || `placeholder: ${ph}`, fg: hex(fg), bg: hex(c.bg), r, need, large, ok: r >= need || disabled, disabled,
      fgRaw: c.fgRaw, px: c.px, bold: c.bold, fix: r < need && !disabled ? fixColour(fg, c.bg, need) : null });
    if (r < need && !disabled) add(r < need * 0.75 ? 'error' : 'warning', `Low contrast ${r.toFixed(2)}:1 (needs ${need}:1)`, AAA ? '1.4.6' : '1.4.3', el,
      `${hex(fg)} on ${hex(c.bg)}, ${large ? 'large' : 'normal'} text (${Math.round(c.px * 10) / 10} px${c.bold ? ' bold' : ''}): "${(own || ph).slice(0, 40)}".`,
      `Darken the text or lighten the background until the ratio is at least ${need}:1.`);
  }

  const errors = issues.filter((i) => i.sev === 'error').length;
  const warns = issues.length - errors;
  if (skipped.length) warnings.push(`${skipped.length} CSS rule(s) with combinators or pseudo-classes were not applied to the contrast check (e.g. "${skipped[0]}"): contrast there is estimated from the simpler rules and inline styles.`);
  if (unresolved.size) warnings.push(`Could not resolve: ${[...unresolved].slice(0, 4).join(', ')} - var(), gradients and images are not evaluated; check those areas in the browser.`);
  if (problems.length) warnings.push(...problems.slice(0, 3).map((p) => `HTML: ${p}`));
  const sevOrder = { error: 0, warning: 1 };
  issues.sort((a, b) => sevOrder[a.sev] - sevOrder[b.sev] || (a.el?.line ?? 0) - (b.el?.line ?? 0));

  const failing = pairs.filter((p) => !p.ok);
  // For the page's drawing only (manifest agentOmit): the tree as a reader
  // meets it, the issues tied to their elements, the Tab path, the colours.
  const issueIx = new Map();
  issues.forEach((it, k) => { if (it.el) { if (!issueIx.has(it.el)) issueIx.set(it.el, []); issueIx.get(it.el).push(k); } });
  const pairIx = new Map(pairs.map((p, k) => [p.el, k]));
  const tabIx = new Map(ordered.map((e, k) => [e, k + 1]));
  const LAND = { nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', aside: 'complementary', form: 'form', section: 'region', dialog: 'dialog', ul: 'list', ol: 'list', table: 'table', fieldset: 'group' };
  const blocks = [];
  const walk = (node, depth, loose) => {
    let at = node.line;
    for (const c of node.children) {
      if (c.type === 'text') {
        // text lying loose in a landmark (after a checkbox, say) gets its own row
        const t = norm(c.value);
        if (loose && t) blocks.push({ i: null, line: at, tag: '#text', depth, land: null, text: t.slice(0, 80), hidden: !!hiddenAncestor(node),
          type: null, role: null, tabindex: null, name: null, onclick: false, el: '', tab: null, issues: [], pair: pairIx.has(node) ? pairIx.get(node) : null });
        continue;
      }
      const el = c;
      at = el.line;
      if (['head', 'script', 'style', 'template', 'title', 'meta', 'link', 'br', 'option', 'svg'].includes(el.tag)) continue;
      const hid = !!hiddenAncestor(el);
      const own = norm(el.children.filter((k) => k.type === 'text').map((k) => k.value).join(' '));
      const interactive = FOCUSABLE(el) || el.attrs.onclick != null || ['button', 'a', 'input', 'select', 'textarea'].includes(el.tag) || el.attrs.role === 'button';
      const land = LAND[el.tag] || (el.attrs.role && ['navigation', 'main', 'banner', 'contentinfo', 'region', 'dialog', 'group', 'list', 'form'].includes(el.attrs.role) ? el.attrs.role : null);
      const top = el.tag === 'html' || el.tag === 'body';
      const keep = !top && (interactive || land || /^h[1-6]$/.test(el.tag) || ['img', 'iframe', 'video', 'audio', 'label', 'li'].includes(el.tag) || own || issueIx.has(el));
      if (keep) {
        blocks.push({ i: el.idx, line: el.line, tag: el.tag, depth, land, text: land ? '' : own.slice(0, 80), hidden: hid,
          type: (el.attrs.type || '').toLowerCase() || null, role: el.attrs.role || null, tabindex: el.attrs.tabindex ?? null,
          name: interactive || el.tag === 'img' ? nameOf(el, byId, labelsFor).name : null, onclick: el.attrs.onclick != null,
          el: short(el), tab: tabIx.get(el) ?? null, issues: issueIx.get(el) || [], pair: !land && pairIx.has(el) ? pairIx.get(el) : null });
      }
      const nest = keep && (land || interactive || el.tag === 'label' || el.tag === 'li') && elKids(el).length > 0;
      walk(el, nest ? depth + 1 : depth, (keep && !!land) || (top && el.tag === 'body'));
    }
  };
  walk({ children: els.filter((e) => !e.parent || e.parent.tag === '#root'), line: 1 }, 0, false);
  const view = {
    blocks,
    issues: issues.map((it) => ({ sev: it.sev, rule: it.rule, wcag: it.wcag, line: it.el ? it.el.line : null, el: it.el ? it.el.idx : null, what: it.el ? short(it.el) : 'CSS', why: it.why, fix: it.fix })),
    pairs: pairs.map((p) => ({ el: p.el.idx, line: p.el.line, text: p.text.slice(0, 60), fg: p.fg, bg: p.bg, r: p.r, need: p.need, large: p.large, ok: p.ok, disabled: !!p.disabled, fgRaw: p.fgRaw, px: p.px, bold: p.bold, fix: p.fix })),
    order: ordered.map((e) => e.idx),
    level: AAA ? 'AAA' : 'AA', errors, warnings: warns,
    doc: { lang: htmlEl ? norm(htmlEl.attrs.lang) || null : undefined, title: norm(textOf(els.find((e) => e.tag === 'title') || { children: [] })) || null },
  };

  return {
    values: [
      { label: 'Errors', value: errors, tone: errors ? 'bad' : 'ok' },
      { label: 'Warnings', value: warns, tone: warns ? 'warn' : 'ok' },
      { label: 'Elements read', value: els.length },
      { label: 'Text contrast', value: `${pairs.length - failing.length} / ${pairs.length} pass`, tone: failing.length ? 'bad' : 'ok', hint: `WCAG ${AAA ? 'AAA' : 'AA'}` },
      { label: 'Tab stops', value: ordered.length },
    ],
    warnings,
    tables: [
      { title: 'Issues', columns: ['Severity', 'Problem', 'WCAG', 'Line', 'Element', 'Why it matters', 'Fix'],
        rows: issues.length ? issues.map((i) => [i.sev, i.rule, i.wcag, i.el ? i.el.line : '–', i.el ? short(i.el) : 'CSS', i.why, i.fix]) : [['–', 'No issues found by these checks', '', '', '', '', '']] },
      { title: 'Focus order (Tab)', columns: ['#', 'Line', 'Element', 'Accessible name', 'tabindex'],
        rows: ordered.length ? ordered.map((e, k) => [k + 1, e.line, short(e), nameOf(e, byId, labelsFor).name || '(no name)', e.attrs.tabindex ?? '–']) : [['–', '', 'Nothing focusable', '', '']] },
      { title: 'Text contrast', columns: ['Line', 'Text', 'Colours', 'Size', 'Ratio', 'Needs', 'Result'],
        rows: !pairs.length ? [['–', 'No text found', '', '', '', '', '']] : pairs.slice(0, 60).map((p) => [p.el.line, p.text.slice(0, 40), `${p.fg} on ${p.bg}`, p.large ? 'large' : 'normal', `${p.r.toFixed(2)}:1`, `${p.need}:1`, p.disabled ? 'disabled (exempt)' : p.ok ? 'pass' : 'FAIL']) },
    ],
    notes: [
      'This is a static read of the markup, not a rendered page: styles from external stylesheets, JavaScript and layout are not seen. Run axe or Lighthouse on the live page as well.',
      'Contrast: WCAG 2.2 ratio (L1+0.05)/(L2+0.05); AA needs 4.5:1 for normal text and 3:1 for large text (24 px, or 18.66 px bold); AAA needs 7:1 and 4.5:1.',
      'Focus order is the browser\'s: positive tabindex first (ascending), then everything else in source order. CSS reordering (flex order, grid) is not seen.',
      '4.1.1 (Parsing) is obsolete in WCAG 2.2; duplicate ids still break label and ARIA references.',
    ],
    view,
  };
}

// The nearest colour of the same hue that reaches the ratio: the text is
// moved toward black on a light background, toward white on a dark one.
function fixColour(fg, bg, need) {
  const toward = lum(bg) > 0.18 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  for (let t = 0.01; t <= 1.0001; t += 0.01) {
    const c = { r: fg.r + (toward.r - fg.r) * t, g: fg.g + (toward.g - fg.g) * t, b: fg.b + (toward.b - fg.b) * t, a: 1 };
    const h = hex(c), back = parseColor(h);
    if (ratio(back, bg) >= need) return { hex: h, ratio: ratio(back, bg) };
  }
  return null;
}
