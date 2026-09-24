// Naming convention enforcer: one case rule (plus the rules that go with each
// kind of name) checked over a pasted list of nets, reference designators,
// library parts or file names, with a suggested rename for each failure.
// Sources: reference designator prefixes after IEEE 315-1975 / ASME Y14.44-2008;
// value-in-name style (3V3 rather than 3.3V) after IEC 60062 (RKM code); file-name
// portability from POSIX portable filename characters (IEEE 1003.1, 3.282) and the
// Windows reserved device names (Microsoft "Naming Files, Paths, and Namespaces").
// The case styles themselves are conventions, not a standard.

export const CASES = {
  upper_snake: { name: 'UPPER_SNAKE', re: /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/, join: (w) => w.map((x) => x.toUpperCase()).join('_') },
  lower_snake: { name: 'lower_snake', re: /^[a-z0-9]+(?:_[a-z0-9]+)*$/, join: (w) => w.map((x) => x.toLowerCase()).join('_') },
  kebab: { name: 'kebab-case', re: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, join: (w) => w.map((x) => x.toLowerCase()).join('-') },
  camel: { name: 'camelCase', re: /^[a-z][a-zA-Z0-9]*$/, join: (w) => w.map((x, i) => (i ? cap(x) : x.toLowerCase())).join('') },
  pascal: { name: 'PascalCase', re: /^[A-Z][a-zA-Z0-9]*$/, join: (w) => w.map(cap).join('') },
};
function cap(x) { return /^\d/.test(x) ? x : x.charAt(0).toUpperCase() + x.slice(1).toLowerCase(); }

// IEEE 315 / ASME Y14.44 class letters most used on PCBs.
export const REFDES = {
  A: 'assembly / sub-board', BT: 'battery', C: 'capacitor', D: 'diode (LEDs too)', DS: 'display, lamp', E: 'misc. electrical',
  F: 'fuse', FB: 'ferrite bead', FID: 'fiducial', H: 'hardware', J: 'jack, connector (fixed side)', JP: 'jumper', K: 'relay',
  L: 'inductor', LS: 'loudspeaker, buzzer', M: 'motor', MH: 'mounting hole', MK: 'microphone', P: 'plug (moving side)',
  PS: 'power supply', Q: 'transistor', R: 'resistor', RN: 'resistor network', RT: 'thermistor', RV: 'varistor', S: 'switch',
  SW: 'switch', T: 'transformer', TP: 'test point', U: 'integrated circuit', VR: 'variable resistor', W: 'wire, cable',
  X: 'socket', Y: 'crystal, oscillator', Z: 'zener (older use)',
};
const REF_ALIASES = { LED: 'D', IC: 'U', CN: 'J', CON: 'J', XTAL: 'Y', RLY: 'K', BAT: 'BT', TR: 'Q', VR: 'RV' };

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Words of a name: split on separators and on camelCase humps, digits kept with their letters (3V3 stays one word). */
export function words(s) {
  return String(s)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

// "3.3V" -> "3V3", "1.8V" -> "1V8" (IEC 60062 style: the unit letter replaces the point).
const rkm = (s) => s.replace(/(\d+)\.(\d+)\s*([VAvaRrKk])/g, (_, a, b, u) => `${a}${u.toUpperCase()}${b}`);

function guessKind(name) {
  if (/^[A-Za-z]{1,3}\d+[A-Za-z]?$/.test(name) && !/^\d/.test(name)) return 'refdes';
  if (/\.[A-Za-z0-9]{1,6}$/.test(name) && !/^\d+(\.\d+)?$/.test(name)) return 'file';
  return 'net';
}

export function run(input) {
  const kindSel = ['auto', 'net', 'refdes', 'part', 'file'].includes(input.kind) ? input.kind : 'auto';
  const style = CASES[input.style] ? input.style : input.style === 'custom' ? 'custom' : 'upper_snake';
  const maxLen = input.maxlen > 0 ? Math.round(input.maxlen) : 0;
  const warnings = [];
  let custom = null;
  if (style === 'custom') {
    try { custom = new RegExp(String(input.pattern || '').trim() || '^.*$'); } catch (e) {
      warnings.push(`The custom pattern is not a valid regular expression (${e.message}); names are checked only for the kind's own rules.`);
    }
  }
  const prefixes = String(input.prefixes || '').split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
  const caseName = style === 'custom' ? `custom /${input.pattern || ''}/` : CASES[style].name;

  const rows = [], unparsed = [], auto = [];
  const lines = String(input.names || '').split(/\r?\n/);
  lines.forEach((line, i) => {
    let t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) return;
    if (t.length > 200) { unparsed.push([i + 1, t.slice(0, 40) + '…', 'longer than 200 characters']); return; }
    let kind = kindSel;
    const pre = /^(net|ref|refdes|symbol|part|file)\s*:\s*(.*)$/i.exec(t);
    if (pre) { kind = { net: 'net', ref: 'refdes', refdes: 'refdes', symbol: 'refdes', part: 'part', file: 'file' }[pre[1].toLowerCase()]; t = pre[2].trim(); }
    else if (kindSel === 'auto') {
      // A pasted table row: take the first cell (tab, comma or semicolon separated).
      const cell = t.split(/\t|;|,(?=\S)/)[0].trim();
      t = cell; kind = guessKind(t);
    }
    if (!t) { unparsed.push([i + 1, line.trim(), 'nothing after the prefix']); return; }
    rows.push({ line: i + 1, raw: t, kind });
  });

  const results = rows.map((r) => {
    const problems = [];
    let name = r.raw, fix = null, head = '', low = false, spelled = null;
    if (r.kind === 'net') {
      if (/^Net-\(|^unconnected-|^N\$\d+$|^N\d{5,}$/.test(name)) { auto.push(r); return null; }
      // Hierarchical path: /sheet/SDA -> only the last part is the name.
      if (name.includes('/')) name = name.split('/').filter(Boolean).pop() || name;
      if (/^\+/.test(name)) { head = '+'; name = name.slice(1); } // KiCad power nets: +3V3, +5V
      spelled = name;
      if (/[~#!{}]/.test(name)) {
        problems.push('active-low marks (~ # ! {}) do not survive every tool: use an _N suffix');
        low = true; name = name.replace(/[~#!{}]/g, '');
      } else if (/^n[A-Z]{2,}/.test(name)) low = true; // nRESET style: suggest RESET_N
      if (low && /^n[A-Z]{2,}/.test(name)) name = name.slice(1);
      if (/\d\.\d/.test(name)) problems.push('a decimal point in a value: write 3V3, not 3.3V (IEC 60062)');
    }
    if (r.kind === 'refdes') {
      const m = /^([A-Za-z]+)(\d+)([A-Za-z]?)$/.exec(name);
      if (!m) problems.push('not a reference designator: letters then a number (R12, U3)');
      else {
        const p = m[1].toUpperCase();
        if (m[1] !== p) problems.push('reference designators are upper case');
        if (/^0\d/.test(m[2])) problems.push('leading zero in the number');
        if (!REFDES[p]) problems.push(REF_ALIASES[p] ? `${p} is not an IEEE 315 class: use ${REF_ALIASES[p]} (${REFDES[REF_ALIASES[p]]})` : `${p} is not a common IEEE 315 class letter`);
        fix = `${REF_ALIASES[p] || p}${String(Number(m[2]))}${m[3].toUpperCase()}`;
      }
    }
    let ext = '';
    if (r.kind === 'file') {
      const dot = name.lastIndexOf('.');
      if (dot > 0) { ext = name.slice(dot); name = name.slice(0, dot); }
      if (ext !== ext.toLowerCase()) problems.push('upper-case extension: case-sensitive systems treat .PDF and .pdf as different');
      if (/[^A-Za-z0-9._-]/.test(r.raw)) problems.push('characters outside A-Z a-z 0-9 . _ - (not portable, IEEE 1003.1)');
      if (WIN_RESERVED.test(name)) problems.push(`"${name}" is a reserved device name on Windows`);
      if (/^[-.]/.test(name)) problems.push('starts with - or . (hidden or read as an option)');
    }
    if (/\s/.test(r.raw)) problems.push('contains spaces');
    if (r.kind === 'part' && /[^A-Za-z0-9_.+-]/.test(name.replace(/\s/g, ''))) problems.push('characters outside A-Z a-z 0-9 _ . + - break library paths and exports');
    if (r.kind !== 'refdes') {
      const re = style === 'custom' ? custom : CASES[style].re;
      if (re && !re.test(spelled ?? name)) problems.push(`not ${caseName}`);
      if (style !== 'custom') {
        const w = words(rkm(name));
        if (low && !/^n$/i.test(w[w.length - 1] || '')) w.push('N');
        const joined = w.length ? CASES[style].join(w) : name;
        // A reserved Windows name stays reserved in any case: add a word.
        const safe = r.kind === 'file' && WIN_RESERVED.test(joined) ? CASES[style].join([...w, 'file']) : joined;
        fix = head + safe + ext.toLowerCase();
      }
      if (prefixes.length && !prefixes.some((p) => (head + name).startsWith(p))) problems.push(`does not start with an allowed prefix (${prefixes.join(', ')})`);
    }
    const full = r.kind === 'file' ? name + ext : head + name;
    if (maxLen && full.length > maxLen) problems.push(`${full.length} characters, over the ${maxLen} limit`);
    if (fix === r.raw) fix = null;
    return { ...r, problems, fix: problems.length ? fix : null, norm: (r.kind + ':' + words(full).join('').toLowerCase()) };
  }).filter(Boolean);

  // Names that differ only in case or separators: many tools merge them, some do not.
  const groups = new Map();
  for (const r of results) { if (!groups.has(r.norm)) groups.set(r.norm, []); groups.get(r.norm).push(r); }
  const clashes = [...groups.values()].filter((g) => g.length > 1);
  const exact = new Map();
  for (const r of results) exact.set(r.kind + ':' + r.raw, (exact.get(r.kind + ':' + r.raw) || 0) + 1);
  for (const g of clashes) {
    const distinct = [...new Set(g.map((r) => r.raw))];
    for (const r of g) {
      if (distinct.length > 1) r.problems.push(`clashes with ${distinct.filter((x) => x !== r.raw).join(', ')} (same words, different spelling)`);
      else if (r.kind === 'refdes' || r.kind === 'file') r.problems.push('duplicate');
    }
  }

  const bad = results.filter((r) => r.problems.length);
  const ok = results.length - bad.length;
  if (!results.length && !auto.length) warnings.push('No names found: paste one name per line (optionally prefixed net:, ref:, part: or file:).');
  if (unparsed.length) warnings.push(`${unparsed.length} line(s) could not be read - see the table "Not read".`);
  if (clashes.length) warnings.push(`${clashes.length} group(s) of names differ only in case or separators - tools disagree on whether they are the same net or file. Pick one spelling.`);

  const byKind = ['net', 'refdes', 'part', 'file'].map((k) => {
    const all = results.filter((r) => r.kind === k);
    return [k, all.length, all.filter((r) => !r.problems.length).length, all.filter((r) => r.problems.length).length];
  }).filter((r) => r[1]);
  const renames = bad.filter((r) => r.fix && r.fix !== r.raw);
  const pct = results.length ? Math.round((100 * ok) / results.length) : 100;
  return {
    values: [
      { label: 'Names checked', value: results.length },
      { label: 'Pass', value: ok, tone: bad.length ? undefined : 'ok' },
      { label: 'Fail', value: bad.length, tone: bad.length ? 'bad' : 'ok' },
      { label: 'Compliance', value: `${pct} %`, tone: pct === 100 ? 'ok' : pct >= 80 ? 'warn' : 'bad' },
      { label: 'Rule', value: caseName },
      ...(auto.length ? [{ label: 'Auto-named nets', value: auto.length, hint: 'skipped' }] : []),
    ],
    warnings,
    tables: [
      ...(bad.length ? [{ title: 'Failures', columns: ['Line', 'Name', 'Kind', 'Problem', 'Suggested'], rows: bad.map((r) => [r.line, r.raw, r.kind, r.problems.join('; '), r.fix || '–']) }] : []),
      ...(byKind.length ? [{ title: 'By kind', columns: ['Kind', 'Checked', 'Pass', 'Fail'], rows: byKind }] : []),
      ...(unparsed.length ? [{ title: 'Not read', columns: ['Line', 'Text', 'Why'], rows: unparsed }] : []),
      ...(auto.length ? [{ title: 'Auto-named nets (not checked)', columns: ['Line', 'Name'], rows: auto.map((r) => [r.line, r.raw]) }] : []),
    ],
    texts: [{ title: 'Rename map', body: renames.length ? 'old,new\n' + renames.map((r) => `${r.raw},${r.fix}`).join('\n') + '\n' : 'Nothing to rename.\n' }],
    notes: [
      'Kind "auto" guesses per line: R12-like is a reference designator, a name with an extension is a file, the rest are nets. Prefix a line with net:, ref:, part: or file: to say it.',
      'Nets may start with + (KiCad power nets, +3V3); the case rule applies after it. Hierarchical nets (/sheet/SDA) are checked by their last part.',
      'Reference designators ignore the case rule: they follow IEEE 315 (class letters in upper case, then a number).',
      'Suggestions split names into words at separators and camelCase humps and re-join them in the chosen style; check them before a bulk rename.',
    ],
  };
}
