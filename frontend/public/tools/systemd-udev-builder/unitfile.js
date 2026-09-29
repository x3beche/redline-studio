// Reading and editing a systemd unit file as text, for the tool and its page.
// Pure: no DOM. Written from systemd.syntax(7) and systemd.unit(5): sections
// in [brackets], "Key=value" lines, # and ; start comments, a line ending in
// a backslash continues on the next one, a key may repeat (list settings
// append, an empty assignment resets the list).

const SECTION_ORDER = ['Unit', 'Service', 'Socket', 'Timer', 'Path', 'Mount', 'Install'];

/** text -> { entries: [{section, key, value, line, end}], sections: [{name, line}], junk: [{line, text}] } */
export function parseUnit(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const entries = [], sections = [], junk = [];
  let section = null;
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let raw = lines[i];
    const t = raw.trim();
    if (!t || t.startsWith('#') || t.startsWith(';')) continue;
    const sec = /^\[([^\]]+)\]\s*$/.exec(t);
    if (sec) { section = sec[1]; sections.push({ name: section, line: i + 1 }); continue; }
    // continuation lines
    let joined = t;
    while (/\\$/.test(joined) && i + 1 < lines.length) {
      joined = joined.slice(0, -1) + ' ' + lines[++i].trim();
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(joined);
    if (!kv) { junk.push({ line: start + 1, text: raw.slice(0, 100), section }); continue; }
    entries.push({ section, key: kv[1], value: kv[2].trim(), line: start + 1, end: i + 1 });
  }
  return { entries, sections, junk, lineCount: lines.length };
}

/** All values of a key in a section, list settings split on spaces (an empty assignment resets). */
export function listOf(parsed, section, key) {
  let out = [];
  for (const e of parsed.entries) {
    if (e.section !== section || e.key !== key) continue;
    if (!e.value) { out = []; continue; }
    out.push(...e.value.split(/\s+/).filter(Boolean));
  }
  return out;
}
export function lastOf(parsed, section, key) {
  let v = null;
  for (const e of parsed.entries) if (e.section === section && e.key === key) v = e.value;
  return v;
}

function splitLines(text) { return String(text ?? '').replace(/\r\n?/g, '\n').split('\n'); }

/** Where a section's last content line is (0-based), creating the section when it is missing. */
function sectionEnd(lines, name) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s*\[([^\]]+)\]\s*$/.exec(lines[i])?.[1] === name) { start = i; break; }
  if (start < 0) {
    // insert the section before the first section that comes after it in the usual order
    const rank = SECTION_ORDER.indexOf(name);
    let at = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i]);
      if (m && SECTION_ORDER.indexOf(m[1]) > rank && rank >= 0) { at = i; break; }
    }
    while (at > 0 && lines[at - 1].trim() === '' && at === lines.length) at--;
    const block = [`[${name}]`];
    const before = at > 0 && lines[at - 1].trim() !== '' ? [''] : [];
    const after = at < lines.length ? [''] : [];
    lines.splice(at, 0, ...before, ...block, ...after);
    return at + before.length;
  }
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break;
    if (lines[i].trim() !== '') end = i;
  }
  return end;
}

/** Set a single-valued key (value null removes every line of it). */
export function setKey(text, section, key, value) {
  const lines = splitLines(text);
  const p = parseUnit(lines.join('\n'));
  const mine = p.entries.filter((e) => e.section === section && e.key === key);
  if (value == null) {
    for (const e of [...mine].reverse()) lines.splice(e.line - 1, e.end - e.line + 1);
    return lines.join('\n');
  }
  if (mine.length) {
    const first = mine[0];
    lines.splice(first.line - 1, first.end - first.line + 1, `${key}=${value}`);
    // drop later duplicates (they would override the first)
    const again = parseUnit(lines.join('\n')).entries.filter((e) => e.section === section && e.key === key).slice(1);
    for (const e of again.reverse()) lines.splice(e.line - 1, e.end - e.line + 1);
    return lines.join('\n');
  }
  const end = sectionEnd(lines, section);
  lines.splice(end + 1, 0, `${key}=${value}`);
  return lines.join('\n');
}

/** Add one item to a list key (After=, Wants=, WantedBy= ...). */
export function listAdd(text, section, key, item) {
  const lines = splitLines(text);
  const p = parseUnit(lines.join('\n'));
  const mine = p.entries.filter((e) => e.section === section && e.key === key);
  if (mine.some((e) => e.value.split(/\s+/).includes(item))) return lines.join('\n');
  const last = [...mine].reverse().find((e) => e.value);
  if (last && last.line === last.end) {
    lines[last.line - 1] = `${key}=${last.value} ${item}`;
    return lines.join('\n');
  }
  const end = sectionEnd(lines, section);
  lines.splice(end + 1, 0, `${key}=${item}`);
  return lines.join('\n');
}

/** Remove one item from a list key; a line left empty goes. */
export function listRemove(text, section, key, item) {
  const lines = splitLines(text);
  const p = parseUnit(lines.join('\n'));
  const mine = p.entries.filter((e) => e.section === section && e.key === key && e.value.split(/\s+/).includes(item));
  for (const e of [...mine].reverse()) {
    const rest = e.value.split(/\s+/).filter((x) => x && x !== item);
    if (rest.length) lines.splice(e.line - 1, e.end - e.line + 1, `${key}=${rest.join(' ')}`);
    else lines.splice(e.line - 1, e.end - e.line + 1);
  }
  return lines.join('\n');
}

/** systemd-escape --path: /dev/serial/gps -> dev-serial-gps (systemd.unit(5), "String Escaping for Inclusion in Unit Names"). */
export function escapePath(path) {
  const p = String(path || '').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  if (!p) return '-';
  return p.split('/').map((seg) => [...seg].map((c, i) => (/[A-Za-z0-9:_]/.test(c) || (c === '.' && i > 0)
    ? c : [...new TextEncoder().encode(c)].map((b) => '\\x' + b.toString(16).padStart(2, '0')).join(''))).join('')).join('-');
}
