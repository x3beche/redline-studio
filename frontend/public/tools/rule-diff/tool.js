// Two design-rule sets side by side.
//
// Reads, per side, whichever of these it finds:
//   JSON        any object, flattened to dotted keys; arrays of objects with a
//               "name" are keyed by it (Redline Rules tab: classes.Default.track;
//               KiCad .kicad_pro: board.design_settings.rules.min_clearance)
//   KiCad DRU   (rule "x" [(condition "...")] (constraint TYPE (min V) (max V)))
//               -> TYPE.min, TYPE.max  (plus the condition when there is one)
//   key/value   key = value, key: value, key value  (Eagle .dru, fab notes)
// Lengths with units (mm, mil, thou, in, um, µm) are turned into mm; a bare
// number stays as written. Everything else is compared as text.
import { fmtNum } from '../kit/eng.js';

const UNIT = { mm: 1, mil: 0.0254, mils: 0.0254, thou: 0.0254, in: 25.4, inch: 25.4, '"': 25.4, um: 0.001, 'µm': 0.001, cm: 10 };
const f = (v) => fmtNum(v, 4);

/** '8mil' -> {mm: 0.2032, text}; '0.2' -> {num: 0.2}; else {text}. */
function value(raw) {
  const text = String(raw).trim().replace(/^["']|["'],?$/g, '');
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(mm|mils?|thou|inch|in|"|um|µm|cm)?$/i.exec(text);
  if (!m) return { text };
  const n = Number(m[1]);
  if (!m[2]) return { num: n, text };
  return { num: n * UNIT[m[2].toLowerCase()], text, unit: true };
}

function flatten(obj, prefix, out) {
  if (Array.isArray(obj) && obj.length && obj.every((v) => v == null || typeof v !== 'object')) {
    out.push([prefix, { text: obj.join(', ') }]);   // a list of names/layers: one value
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => {
      const key = v && typeof v === 'object' && !Array.isArray(v) ? (v.name ?? v.net ?? v.id) : null;
      flatten(v, `${prefix}.${key != null ? key : i}`, out);
    });
    if (!obj.length) out.push([prefix, { text: '[]' }]);
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'name' && prefix) continue;
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (typeof obj === 'number') out.push([prefix, { num: obj, text: String(obj) }]);
  else out.push([prefix, typeof obj === 'string' ? value(obj) : { text: String(obj) }]);
}

export function parse(src) {
  const text = String(src || '').trim();
  const base = String(src || '').indexOf(text);   // value offsets below are into src
  const entries = [], bad = [];
  if (!text) return { entries, bad, format: 'empty' };
  if (/^[{[]/.test(text)) {
    try { flatten(JSON.parse(text), '', entries); return { entries, bad, format: 'JSON' }; } catch (e) { bad.push(`JSON did not parse: ${e.message}`); return { entries, bad, format: 'JSON (broken)' }; }
  }
  if (/\(\s*rule\s/.test(text)) {
    // KiCad custom rules: walk each (rule ...) block by paren depth
    const re = /\(\s*rule\s+("([^"]*)"|\S+)/g;
    let m;
    while ((m = re.exec(text))) {
      let i = m.index, depth = 0, end = i;
      for (; end < text.length; end++) { if (text[end] === '(') depth++; else if (text[end] === ')' && --depth === 0) break; }
      const block = text.slice(i, end + 1);
      const name = m[2] ?? m[1];
      const cond = /\(\s*condition\s+"([^"]*)"\s*\)/.exec(block)?.[1];
      const layer = /\(\s*layer\s+"?([^")\s]+)"?\s*\)/.exec(block)?.[1];
      const cons = [...block.matchAll(/\(\s*constraint\s+(\w+)((?:\s*\(\s*(?:min|opt|max)\s+[^)]+\))*)/g)];
      if (!cons.length) bad.push(`rule "${name}": no constraint with a min/opt/max`);
      for (const c of cons) {
        const tail = i + c.index + c[0].length - c[2].length;   // where c[2] starts in text
        for (const b of c[2].matchAll(/\(\s*(min|opt|max)\s+([^)]+)\)/g)) {
          const where = [cond && `if ${cond}`, layer && `on ${layer}`].filter(Boolean).join(' ');
          const raw = b[2].replace(/\s+$/, '');
          entries.push([`${c[1]}.${b[1]}${where ? ` [${where}]` : ''}`, value(b[2]), name, { at: base + tail + b.index + b[0].indexOf(b[2]), len: raw.length }]);
        }
      }
      re.lastIndex = end;
    }
    return { entries, bad, format: 'KiCad rules' };
  }
  let off = 0;
  for (const line of text.split(/\r?\n/)) {
    const lineAt = base + off;
    off += line.length + 1;
    const l = line.trim();
    if (!l || /^(#|\/\/|;|\[)/.test(l)) continue;
    const m = /^([A-Za-z_][\w.\- ]*?)\s*(?:=|:|\s)\s*(.+)$/.exec(l);
    if (!m) { bad.push(l); continue; }
    const key = m[1].trim(), rest = m[2].trim().replace(/[;,]$/, '');
    const restAt = lineAt + line.indexOf(l) + l.length - m[2].length + (m[2].length - m[2].trimStart().length);
    const parts = rest.split(/\s+/);
    // Eagle packs several values in one line: mdWireWire = 8mil 8mil 8mil
    if (parts.length > 1 && parts.every((p) => value(p).unit)) {
      let from = 0;
      parts.forEach((p, i) => { const k = rest.indexOf(p, from); from = k + p.length; entries.push([`${key}[${i + 1}]`, value(p), undefined, { at: restAt + k, len: p.length }]); });
    } else entries.push([key, value(rest), undefined, { at: restAt, len: rest.length }]);
  }
  return { entries, bad, format: 'key = value' };
}

// Which way is stricter: a bigger minimum / width / gap is stricter; a bigger maximum is looser.
function meaning(key, a, b) {
  const k = key.toLowerCase();
  const down = /(^|[._\-\s])max/.test(k) || /\bmax/.test(k);
  const up = /min|clear|width|track|drill|annular|gap|space|edge|via|hole|ring|dist|wire/.test(k);
  if (!down && !up) return '';
  const tighter = down ? b < a : b > a;
  return tighter ? 'B stricter' : 'B looser';
}

export function run({ a, b, nameA, nameB, tol, only }) {
  const A = parse(a), B = parse(b);
  const la = String(nameA || '').trim() || 'A', lb = String(nameB || '').trim() || 'B';
  const warnings = [];
  const eps = tol >= 0 ? tol : 0.001;
  const mapA = new Map(), mapB = new Map();
  const where = { A: new Map(), B: new Map() };   // key -> {at, len, rule}: where each value sits in its text
  const dupe = (map, e, side) => { let k = e[0]; if (map.has(k)) k = `${k} (${e[2] || 'again'})`; map.set(k, e[1]); if (e[3]) where[side].set(k, { ...e[3], rule: e[2] }); return side; };
  A.entries.forEach((e) => dupe(mapA, e, 'A'));
  B.entries.forEach((e) => dupe(mapB, e, 'B'));
  if (!A.entries.length) warnings.push(`Nothing read from ${la}: paste a rule set (JSON, KiCad .kicad_dru, or key = value lines).`);
  if (!B.entries.length) warnings.push(`Nothing read from ${lb}: paste a rule set (JSON, KiCad .kicad_dru, or key = value lines).`);
  for (const [side, P] of [[la, A], [lb, B]]) if (P.bad.length) warnings.push(`${side}: could not read ${P.bad.length} line(s): ${P.bad.slice(0, 4).map((x) => `"${x.slice(0, 60)}"`).join(', ')}${P.bad.length > 4 ? ' ...' : ''}`);
  if (A.entries.length && B.entries.length && A.format !== B.format) warnings.push(`${la} is ${A.format} and ${lb} is ${B.format}: their keys rarely line up. Compare like with like where you can.`);

  const keys = [...mapA.keys(), ...[...mapB.keys()].filter((k) => !mapA.has(k))];
  const counts = { same: 0, changed: 0, onlyA: 0, onlyB: 0 };
  const rows = [];
  const all = [];   // every rule, structured, for a page that draws them
  const show = (v) => (v == null ? '–' : v.unit ? `${f(v.num)} mm` : v.text);
  const side = (v, w) => (v == null ? null : { text: v.text, num: v.num ?? null, mm: !!v.unit, at: w?.at ?? null, len: w?.len ?? null, rule: w?.rule ?? null });
  for (const k of keys) {
    const va = mapA.get(k), vb = mapB.get(k);
    let state, delta = '', mean = '';
    if (!va) { state = `only ${lb}`; counts.onlyB++; }
    else if (!vb) { state = `only ${la}`; counts.onlyA++; }
    else if (va.num != null && vb.num != null) {
      const d = vb.num - va.num;
      if (Math.abs(d) <= eps) { state = 'same'; counts.same++; }
      else {
        state = 'changed'; counts.changed++;
        delta = `${d > 0 ? '+' : ''}${f(d)}${va.unit || vb.unit ? ' mm' : ''}${va.num ? `, ${d > 0 ? '+' : ''}${f((100 * d) / Math.abs(va.num))} %` : ''}`;
        mean = meaning(k, va.num, vb.num).replace('B', lb);
      }
    } else if (va.text === vb.text) { state = 'same'; counts.same++; }
    else { state = 'changed'; counts.changed++; }
    all.push({ key: k, a: side(va, where.A.get(k)), b: side(vb, where.B.get(k)),
      state: state === 'same' ? 'same' : state === 'changed' ? 'changed' : !va ? 'onlyB' : 'onlyA',
      delta: va?.num != null && vb?.num != null ? vb.num - va.num : null, deltaText: delta, meaning: mean });
    if (only && state === 'same') continue;
    rows.push([k, show(va), show(vb), delta, state, mean]);
  }
  const empty = !A.entries.length || !B.entries.length;
  const diff = counts.changed + counts.onlyA + counts.onlyB;
  const report = rows.filter((r) => r[4] !== 'same').map((r) => `- ${r[0]}: ${r[1]} -> ${r[2]}${r[3] ? ` (${r[3]})` : ''}${r[5] ? `, ${r[5]}` : ''}${r[4].startsWith('only') ? ` [${r[4]}]` : ''}`);
  return {
    values: [
      { label: 'Differences', value: empty ? '–' : diff, tone: empty ? 'bad' : diff ? 'warn' : 'ok' },
      { label: 'Changed', value: counts.changed },
      { label: `Only in ${la}`, value: counts.onlyA },
      { label: `Only in ${lb}`, value: counts.onlyB },
      { label: 'Same', value: counts.same, hint: `within ${f(eps)}` },
      { label: 'Format', value: A.format === B.format ? A.format : 'mixed', hint: A.format === B.format ? 'both sides' : `${A.format} / ${B.format}` },
    ],
    warnings,
    tables: [{ title: only ? 'Differences' : 'All rules', columns: ['Rule', la, lb, 'Δ', 'State', 'Meaning'], rows: rows.length ? rows : [[empty ? '(nothing to compare)' : '(no differences)', '', '', '', '', '']] }],
    texts: [{ title: 'Change list', body: empty ? 'Nothing to compare yet: both sides need a rule set.\n' : report.length ? `${la} -> ${lb}, ${diff} difference(s):\n${report.join('\n')}\n` : `${la} and ${lb} are the same (within ${f(eps)}).\n` }],
    diff: { nameA: la, nameB: lb, formatA: A.format, formatB: B.format, eps, counts, rules: all },
    notes: ['Lengths with a unit are compared in mm; bare numbers are compared as written, so give both sides in the same unit.',
      '"Stricter" means a bigger minimum (or a smaller maximum): fewer boards pass it, and it needs a better fab.'],
  };
}
