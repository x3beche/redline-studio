// U-Boot environment text: reading `printenv` / `fw_printenv` output, and
// the edits the page makes to it (a variable set, one word of a bootargs
// template changed). Pure: used by tool.js in Node and by view.js.

const NAME = /^([^=\s]+)=(.*)$/;

/**
 * printenv text -> {vars: Map name->value (last wins), order: [names],
 * dups: [names], unread: [{line, text}], sizeLine: {used, total} | null}.
 * U-Boot prompts ("=> printenv"), blank lines and '#' comments are skipped.
 */
export function parseEnv(text) {
  const vars = new Map();
  const order = [];
  const dups = [];
  const unread = [];
  let sizeLine = null;
  String(text ?? '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || /^\s*#/.test(line)) return;
    const sz = /^Environment size:\s*(\d+)\s*\/\s*(\d+)\s*bytes/i.exec(line.trim());
    if (sz) { sizeLine = { used: Number(sz[1]), total: Number(sz[2]) }; return; }
    if (/^\s*(=>|U-Boot\s*>|u-boot=>|\$ |# )/i.test(line) || /^\s*(fw_)?printenv\s*$/.test(line.trim())) return;
    const m = NAME.exec(line);
    if (!m) { unread.push({ line: i + 1, text: line.slice(0, 80) }); return; }
    if (vars.has(m[1])) dups.push(m[1]); else order.push(m[1]);
    vars.set(m[1], m[2]);
  });
  return { vars, order, dups, unread, sizeLine };
}

/** The env text with `name` set to `value` (its line replaced, or appended). null removes it. */
export function setVar(text, name, value) {
  const lines = String(text ?? '').split(/\r?\n/);
  let done = false;
  const out = [];
  for (const l of lines) {
    const m = NAME.exec(l);
    if (m && m[1] === name) {
      if (!done && value != null) out.push(`${name}=${value}`);
      done = true;
      continue;
    }
    out.push(l);
  }
  if (!done && value != null) {
    // before a trailing "Environment size:" line, if there is one
    const at = out.findIndex((l) => /^Environment size:/i.test(l.trim()));
    if (at >= 0) out.splice(at, 0, `${name}=${value}`);
    else { while (out.length && !out[out.length - 1].trim()) out.pop(); out.push(`${name}=${value}`); }
  }
  return out.join('\n');
}

/** Whitespace words of a string, quotes and ${..} kept whole, with their positions. */
export function words(str, from = 0, to = str.length) {
  const out = [];
  let i = from;
  while (i < to) {
    while (i < to && /\s/.test(str[i])) i++;
    if (i >= to) break;
    const start = i;
    while (i < to && !/\s/.test(str[i])) {
      const c = str[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '"' || c === "'") { const j = str.indexOf(c, i + 1); i = j < 0 || j >= to ? to : j + 1; continue; }
      if (c === '$' && str[i + 1] === '{') { const j = str.indexOf('}', i); i = j < 0 || j >= to ? to : j + 1; continue; }
      if (c === ';') break;
      i++;
    }
    if (i === start) { i++; continue; }
    out.push({ start, end: i, text: str.slice(start, i) });
    if (str[i] === ';') break;
  }
  return out;
}

/**
 * Where a variable's value holds the kernel command line: the words after
 * `setenv bootargs` / `env set bootargs` (up to the next unquoted ';'), or,
 * for a variable that is itself a list of arguments (bootargs, mmcroot=
 * "/dev/mmcblk1p2 rootwait rw", optargs), all of its words.
 */
export function argSegment(value) {
  const v = String(value ?? '');
  const m = /(?:^|[;\s])(?:setenv|env\s+set)\s+bootargs(?=\s|$)/.exec(v);
  if (!m) return { start: 0, end: v.length, setenv: false, words: words(v) };
  const start = m.index + m[0].length;
  // the segment ends at the first ';' outside quotes
  let i = start, q = null;
  for (; i < v.length; i++) {
    const c = v[i];
    if (c === '\\') { i++; continue; }
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === ';') break;
  }
  return { start, end: i, setenv: true, words: words(v, start, i) };
}

/** A variable's value with word `index` of its argument segment replaced (null removes it). */
export function replaceWord(value, index, text) {
  const v = String(value ?? '');
  const seg = argSegment(v);
  const w = seg.words[index];
  if (!w) return v;
  if (text == null) {
    let a = w.start, b = w.end;
    while (b < v.length && v[b] === ' ') b++;
    if (b === w.end) while (a > seg.start && v[a - 1] === ' ') a--;
    return v.slice(0, a) + v.slice(b);
  }
  return v.slice(0, w.start) + text + v.slice(w.end);
}

/** A variable's value with `text` appended to its argument segment. */
export function appendWord(value, text) {
  const v = String(value ?? '');
  const seg = argSegment(v);
  const at = seg.words.length ? seg.words[seg.words.length - 1].end : seg.end;
  const sep = at > 0 && !/\s/.test(v[at - 1]) ? ' ' : '';
  return v.slice(0, at) + sep + text + v.slice(at);
}
