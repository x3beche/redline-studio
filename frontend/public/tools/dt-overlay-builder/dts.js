// A small device tree source reader for the overlay builder: enough of the
// dtc grammar (Documentation/devicetree/bindings/dts-format.txt, dtc's
// dtc-parser.y) to rebuild a base tree and find a target in it.
//   - /dts-v1/; /plugin/; /memreserve/ a b;       read and skipped
//   - label: name@unit { ... };                    nodes, several labels allowed
//   - name = <cells>, "strings", [bytes], <&ref>;  property values kept as written
//   - name;                                        boolean property
//   - &label { ... };  &{/path} { ... };           merged into the node they name
//   - /delete-node/ name;  /delete-node/ &label;  /delete-property/ name;
//   - #include / #define / #if... lines            recorded, not expanded (a warning)
// Pure: no DOM. Node objects: {name, labels, props: Map(name -> raw value or ''),
// children: [], parent}.

const NAME = /[A-Za-z0-9,._+*#?@-]/;
const PREPROC = /^#\s*(include|define|undef|ifdef|ifndef|if|elif|else|endif|error|pragma)\b/;

export function newNode(name, parent = null) {
  return { name, labels: [], props: new Map(), children: [], parent };
}

export function pathOf(node) {
  if (!node.parent) return '/';
  const up = pathOf(node.parent);
  return (up === '/' ? '' : up) + '/' + node.name;
}

export function findPath(root, path) {
  const parts = String(path).split('/').filter(Boolean);
  let n = root;
  for (const p of parts) {
    // A path may leave out the unit address when it is unambiguous (dtc does the same).
    const hit = n.children.find((c) => c.name === p) || n.children.filter((c) => c.name.split('@')[0] === p).at(0);
    if (!hit) return null;
    n = hit;
  }
  return n;
}

export function parseDts(src) {
  const text = String(src ?? '');
  const errors = [], includes = [], defines = [];
  const labels = new Map();
  const root = newNode('');
  const lineStarts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === '\n') lineStarts.push(k + 1);
  const lineAt = (idx) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  let i = 0;
  const n = text.length;
  const err = (msg, at = i) => errors.push({ line: lineAt(at), message: msg });

  function skip() {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text.startsWith('//', i)) { while (i < n && text[i] !== '\n') i++; continue; }
      if (text.startsWith('/*', i)) {
        const e = text.indexOf('*/', i + 2);
        if (e < 0) { err('unterminated /* comment'); i = n; return; }
        i = e + 2; continue;
      }
      // a preprocessor line: only where a line starts (#address-cells is a property)
      if (text[i] === '#') {
        const ls = text.lastIndexOf('\n', i - 1) + 1;
        const lead = text.slice(ls, i).trim() === '';
        const rest = text.slice(i, text.indexOf('\n', i) < 0 ? n : text.indexOf('\n', i));
        const m = PREPROC.exec(rest);
        if (lead && m) {
          if (m[1] === 'include') includes.push({ line: lineAt(i), file: rest.replace(/^#\s*include\s*/, '').trim() });
          else if (m[1] === 'define') {
            const d = /^#\s*define\s+([A-Za-z_]\w*)\s+(.*)$/.exec(rest);
            if (d) defines.push({ name: d[1], value: d[2].trim() });
          }
          i += rest.length; continue;
        }
      }
      return;
    }
  }
  function word() {
    const s0 = i;
    while (i < n && NAME.test(text[i])) i++;
    return text.slice(s0, i);
  }
  // A property value as written, up to its ';' (strings, <>, [] and comments respected).
  function value() {
    let out = '', depth = 0;
    const s0 = i;
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        let j = i + 1;
        while (j < n && text[j] !== '"') { if (text[j] === '\\') j++; j++; }
        out += text.slice(i, j + 1); i = j + 1; continue;
      }
      if (text.startsWith('//', i)) { while (i < n && text[i] !== '\n') i++; continue; }
      if (text.startsWith('/*', i)) { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      if (c === '<' || c === '[' || c === '(') depth++;
      if (c === '>' || c === ']' || c === ')') depth--;
      if (depth <= 0 && (c === ';' || c === '}')) break;
      out += c; i++;
    }
    if (text[i] !== ';') err('property value without a closing ;', s0);
    else i++;
    return out.replace(/\s+/g, ' ').trim();
  }
  function expect(ch) {
    skip();
    if (text[i] === ch) { i++; return true; }
    err(`expected '${ch}' but found ${i < n ? `'${text[i]}'` : 'the end'}`);
    return false;
  }
  function refTarget() {
    // after '&': a label or {/path}
    if (text[i] === '{') {
      const e = text.indexOf('}', i);
      const p = text.slice(i + 1, e < 0 ? n : e);
      i = e < 0 ? n : e + 1;
      return { path: p.trim() };
    }
    const s0 = i;
    while (i < n && /[A-Za-z0-9_]/.test(text[i])) i++;
    return { label: text.slice(s0, i) };
  }
  const resolve = (ref) => (ref.path != null ? findPath(root, ref.path) : labels.get(ref.label) || null);
  const refName = (ref) => (ref.path != null ? `&{${ref.path}}` : `&${ref.label}`);

  function body(node) {
    for (;;) {
      skip();
      if (i >= n) { err(`node ${pathOf(node)} is not closed with }`); return; }
      if (text[i] === '}') { i++; skip(); if (text[i] === ';') i++; else err('missing ; after }'); return; }
      const at = i;
      if (text.startsWith('/delete-node/', i)) {
        i += 13; skip();
        if (text[i] === '&') { i++; const r = refTarget(); const t = resolve(r); if (t && t.parent) t.parent.children.splice(t.parent.children.indexOf(t), 1); else err(`/delete-node/ ${refName(r)}: not found`, at); }
        else {
          const nm = word();
          const k = node.children.findIndex((c) => c.name === nm);
          if (k >= 0) node.children.splice(k, 1); else err(`/delete-node/ ${nm}: no such child`, at);
        }
        expect(';'); continue;
      }
      if (text.startsWith('/delete-property/', i)) {
        i += 17; skip(); const nm = word();
        if (!node.props.delete(nm)) err(`/delete-property/ ${nm}: not set`, at);
        expect(';'); continue;
      }
      const labs = [];
      let nm = '';
      for (;;) {
        skip();
        const s0 = i;
        const w = word();
        if (!w) break;
        if (text[i] === ':' && /^[A-Za-z_]\w*$/.test(w)) { i++; labs.push(w); continue; }
        nm = w; void s0; break;
      }
      if (!nm) { err(`cannot read '${text.slice(i, i + 12).split('\n')[0]}'`); recover(); continue; }
      skip();
      if (text[i] === '{') {
        i++;
        let child = node.children.find((c) => c.name === nm);
        if (!child) { child = newNode(nm, node); node.children.push(child); }
        for (const l of labs) { if (!child.labels.includes(l)) child.labels.push(l); labels.set(l, child); }
        body(child);
      } else if (text[i] === '=') {
        i++; skip();
        node.props.set(nm, value());
      } else if (text[i] === ';') {
        i++; node.props.set(nm, '');
      } else { err(`'${nm}' is neither a property nor a node`, at); recover(); }
    }
  }
  function recover() {
    while (i < n && text[i] !== ';' && text[i] !== '}') i++;
    if (text[i] === ';') i++;
  }

  while (i < n) {
    skip();
    if (i >= n) break;
    const at = i;
    if (text.startsWith('/dts-v1/', i) || text.startsWith('/plugin/', i)) { i += 8; expect(';'); continue; }
    if (text.startsWith('/memreserve/', i)) { i += 12; value(); continue; }
    if (text.startsWith('/include/', i)) {
      i += 9; skip(); const m = /^"([^"]*)"/.exec(text.slice(i));
      includes.push({ line: lineAt(at), file: m ? `"${m[1]}"` : '?' }); i += m ? m[0].length : 0; continue;
    }
    if (text.startsWith('/delete-node/', i)) {
      i += 13; skip();
      if (text[i] === '&') { i++; const r = refTarget(); const t = resolve(r); if (t && t.parent) t.parent.children.splice(t.parent.children.indexOf(t), 1); else err(`/delete-node/ ${refName(r)}: not found`, at); }
      expect(';'); continue;
    }
    // labels on the root node
    const labs = [];
    while (/[A-Za-z_]/.test(text[i] || '')) {
      const s0 = i; const w = word();
      if (text[i] === ':') { i++; labs.push(w); skip(); } else { i = s0; break; }
    }
    if (text[i] === '/') {
      i++; skip();
      if (!expect('{')) { recover(); continue; }
      for (const l of labs) { root.labels.push(l); labels.set(l, root); }
      body(root); continue;
    }
    if (text[i] === '&') {
      i++;
      const r = refTarget();
      skip();
      const t = resolve(r);
      if (text[i] !== '{') { err(`expected '{' after ${refName(r)}`); recover(); continue; }
      i++;
      if (!t) {
        err(`${refName(r)} is not defined above this point`, at);
        body(newNode('(lost)'));
      } else body(t);
      continue;
    }
    err(`cannot read '${text.slice(i, i + 16).split('\n')[0]}' at the top level`);
    recover();
  }
  return { root, labels, errors, includes, defines };
}

/** The numbers in a <cells> value; null when it is not a plain cell list. */
export function cells(raw) {
  const m = /^<([^>]*)>$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const out = [];
  for (const t of m[1].trim().split(/\s+/).filter(Boolean)) {
    const v = /^(0x[0-9a-f]+|\d+)$/i.test(t) ? Number(t) : NaN;
    out.push(Number.isFinite(v) ? v : t);
  }
  return out;
}

/** The first string of a "string" property, or null. */
export function str(raw) {
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(String(raw ?? '').trim());
  return m ? m[1] : null;
}

/** The phandle labels referenced in a value: <&gpio 17 0> -> ['gpio']. */
export function refs(raw) {
  return [...String(raw ?? '').matchAll(/&([A-Za-z_]\w*)/g)].map((m) => m[1]);
}
