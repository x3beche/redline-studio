// Net naming linter: checks a list of net names (or a KiCad netlist) against a
// naming convention and lists the inconsistent ones with a suggested rename.
//
// Checks, each a common schematic-review rule:
//   characters   spaces, commas, brackets other than a bus index, dots outside a
//                voltage: break netlist exports, SPICE and CAM tools
//   case         UPPER_SNAKE or lower_snake as chosen (or the design's majority)
//   separators   '-' or '.' between words where the convention uses '_'
//   voltages     one style per design: 3V3 (IEC 60062 R-notation style) or 3.3V
//   active-low   one style per design: nRESET, RESET_N, RESET# or ~{RESET}
//   diff pairs   one suffix style (_P/_N, +/-, _DP/_DM) and both halves present
//   bus index    one style per bus: DATA[0], DATA0 or DATA_0
//   duplicates   names equal after ignoring case, separators and voltage style
//   length       longer than the limit some CAD/CAM tools truncate at
//   unnamed      auto-generated names (Net-(U1-Pad3), N$12, unconnected-...)

const AUTO = /^(Net-\(|N\$\d+|unconnected-|Net\d+$|N\d{5,}$)/i;
const DIFF = [
  { style: '_P/_N', re: /^(.+?)_([PN])$/i, sfx: (pn) => (pn === 'P' ? '_P' : '_N') },
  { style: '_DP/_DM', re: /^(.+?)_D([PMN])$/i, sfx: (pn) => (pn === 'P' ? '_DP' : '_DM') },
  { style: '+/-', re: /^(.+?)([+-])$/, sfx: (pn) => (pn === 'P' ? '+' : '-') },
];
const AL_STYLES = { n: (c) => `n${c}`, _N: (c) => `${c}_N`, '#': (c) => `${c}#`, '~{}': (c) => `~{${c}}` };

function parseNames(text) {
  const t = String(text || '');
  const unread = [];
  // KiCad netlist (.net): (net (code "1") (name "/VCC") ...)
  const kicad = [...t.matchAll(/\(net\s+\(code\s+"?\d+"?\)\s+\(name\s+"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"'));
  if (kicad.length) return { names: kicad, unread, source: 'KiCad netlist' };
  const names = [];
  for (const raw of t.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    if (line.includes('\t')) line = line.split('\t')[0].trim();
    else if (/^"[^"]*"\s*,/.test(line)) line = line.match(/^"([^"]*)"/)[1];
    else if (line.includes(',') && !/[[(]/.test(line)) line = line.split(',')[0].trim();
    line = line.replace(/^"(.*)"$/, '$1');
    if (!line) { unread.push(raw.trim()); continue; }
    names.push(line);
  }
  return { names, unread, source: 'one name per line' };
}

function splitHier(name) {
  if (!name.startsWith('/')) return ['', name];
  const i = name.lastIndexOf('/');
  return [name.slice(0, i + 1), name.slice(i + 1)];
}

function diffOf(base, all) {
  for (const d of DIFF) {
    const m = d.re.exec(base);
    if (!m) continue;
    const pn = /^[P+]$/i.test(m[2]) ? 'P' : 'N';
    // A partner must exist in the same style, or '_N' alone is just active-low.
    const partners = DIFF.map((x) => m[1] + x.sfx(pn === 'P' ? 'N' : 'P'));
    const lowerAll = all;
    const has = partners.some((p) => lowerAll.has(p.toUpperCase()));
    if (!has && pn === 'N' && d.style !== '+/-') return null; // RESET_N, PWR_DN: not a pair half
    if (d.style === '+/-' && /^[+-]?\d/.test(base)) return null;
    return { core: m[1], pn, style: d.style, has };
  }
  return null;
}

function activeLow(base) {
  let m;
  if ((m = /^~\{(.+)\}$/.exec(base))) return { core: m[1], style: '~{}' };
  if ((m = /^n([A-Z0-9].*)$/.exec(base))) return { core: m[1], style: 'n' };
  if ((m = /^(.+)#$/.exec(base))) return { core: m[1], style: '#' };
  if ((m = /^(.+)_N$/i.exec(base))) return { core: m[1], style: '_N' };
  return null;
}

const voltStyle = (s) => (/\d+\.\d+V/i.test(s) ? 'dot' : /\d+V\d+/i.test(s) ? 'V' : null);
const toV = (s) => s.replace(/(\d+)\.(\d+)V/gi, (_, a, b) => `${a}V${b}`);
const toDot = (s) => s.replace(/(\d+)V(\d+)/gi, (_, a, b) => `${a}.${b}V`);

function dupKey(base) {
  const al = activeLow(base);
  let s = (al ? al.core + '!' : base).toUpperCase().replace(/^\+/, '');
  s = toV(s).replace(/(\d)V0\b/g, '$1V');
  return s.replace(/[_\-\s.]/g, '');
}

const majority = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

export function run({ nets, convention, activeLowStyle, voltageStyle, maxLen }) {
  const warnings = [];
  const { names: parsed, unread, source } = parseNames(nets);
  if (!parsed.length) return { warnings: ['Paste net names, one per line, or a KiCad netlist (.net).'] };
  const names = [...new Set(parsed)];
  const repeats = parsed.length - names.length;
  const upperSet = new Set(names.map((n) => splitHier(n)[1].toUpperCase()));

  // First pass: the design's own habits, for 'auto' choices.
  const caseCount = { upper: 0, lower: 0 }, alCount = {}, vCount = {}, dCount = {};
  const info = names.map((full) => {
    const [pre, base] = splitHier(full);
    const auto = AUTO.test(base);
    const d = auto ? null : diffOf(base, upperSet);
    const al = auto || d ? null : activeLow(base);
    const core = d ? d.core : al ? al.core : base;
    if (!auto) {
      const letters = core.replace(/\d+V\d+|\d+\.\d+V/gi, '').replace(/[^A-Za-z]/g, '');
      if (letters && letters === letters.toUpperCase()) caseCount.upper++;
      else if (letters && letters === letters.toLowerCase()) caseCount.lower++;
      if (al) alCount[al.style] = (alCount[al.style] || 0) + 1;
      const vs = voltStyle(core); if (vs) vCount[vs] = (vCount[vs] || 0) + 1;
      if (d) dCount[d.style] = (dCount[d.style] || 0) + 1;
    }
    return { full, pre, base, auto, d, al, core };
  });
  const conv = convention === 'auto' ? (caseCount.lower > caseCount.upper ? 'lower' : 'upper') : convention;
  const alPref = activeLowStyle === 'auto' ? majority(alCount) || 'n' : activeLowStyle;
  const vPref = voltageStyle === 'auto' ? majority(vCount) || 'V' : voltageStyle;
  const dPref = majority(dCount) || '_P/_N';
  const limit = maxLen > 0 ? Math.round(maxLen) : 32;

  const issues = [];
  const renames = [];
  let unnamed = 0;
  const bad = new Set();
  const add = (n, problem, fix) => { issues.push([n, problem, fix]); bad.add(n); };

  for (const x of info) {
    if (x.auto) { unnamed++; continue; }
    const probs = [];
    let core = x.core;
    if (/\s/.test(core)) { probs.push('contains spaces'); core = core.replace(/\s+/g, '_'); }
    if (/[,;:'"()<>{}|\\*?]/.test(core)) { probs.push('has characters CAD/CAM exports reject'); core = core.replace(/[,;:'"()<>{}|\\*?]+/g, '_'); }
    if (/[[\]]/.test(core.replace(/\[\d+\]$/, ''))) { probs.push('brackets that are not a bus index'); core = core.replace(/[[\]]/g, '_'); }
    const vs = voltStyle(core);
    if (vs && ((vPref === 'V' && vs === 'dot') || (vPref === 'dot' && vs === 'V'))) {
      probs.push(`voltage written ${vs === 'dot' ? '3.3V' : '3V3'} style; the design uses ${vPref === 'V' ? '3V3' : '3.3V'}`);
      core = vPref === 'V' ? toV(core) : toDot(core);
    }
    const sign = /^[+-]/.test(core) ? core[0] : '';   // +3V3, -12V keep their sign
    let body = core.slice(sign.length);
    if (/[-.]/.test(body.replace(/\d+\.\d+V/gi, ''))) { probs.push("'-' or '.' as a word separator; use '_'"); body = body.replace(/(\d+\.\d+V)|[-.]/gi, (m, v) => v || '_'); }
    body = body.replace(/_+/g, '_').replace(/^_|_$/g, '') || body;
    core = sign + body;
    const letters = core.replace(/\d+V\d+|\d+\.\d+V/gi, '').replace(/[^A-Za-z]/g, '');
    if (conv === 'upper' && letters !== letters.toUpperCase()) { probs.push('lower-case letters; the convention is UPPER_SNAKE'); core = core.toUpperCase(); }
    if (conv === 'lower' && letters !== letters.toLowerCase()) { probs.push('upper-case letters; the convention is lower_snake'); core = core.toLowerCase(); }
    let fixed = core;
    if (x.al) {
      if (x.al.style !== alPref) probs.push(`active-low written ${x.al.style === '~{}' ? '~{X}' : x.al.style === 'n' ? 'nX' : 'X' + x.al.style}; the design uses ${alPref === '~{}' ? '~{X}' : alPref === 'n' ? 'nX' : 'X' + alPref}`);
      fixed = AL_STYLES[alPref](core);
      if (alPref === '_N' && conv === 'lower') fixed = `${core}_n`;
    }
    if (x.d) {
      if (!x.d.has) probs.push(`differential pair without its ${x.d.pn === 'P' ? 'N' : 'P'} half`);
      if (x.d.style !== dPref) probs.push(`pair suffix ${x.d.style} while most pairs use ${dPref}`);
      const want = DIFF.find((d) => d.style === dPref).sfx(x.d.pn);
      fixed = core + (conv === 'lower' ? want.toLowerCase() : want);
    }
    if (x.base.length > limit) probs.push(`${x.base.length} characters, over the ${limit} limit`);
    if (probs.length) {
      add(x.full, probs.join('; '), fixed !== x.base ? x.pre + fixed : x.base.length > limit ? '(shorten by hand)' : x.d && !x.d.has ? `(add ${x.d.core}${DIFF.find((d) => d.style === x.d.style).sfx(x.d.pn === 'P' ? 'N' : 'P')})` : '–');
      if (fixed !== x.base) renames.push(`${x.full} -> ${x.pre + fixed}`);
    }
  }

  // Bus index styles per bus base name.
  const buses = {};
  for (const x of info) {
    if (x.auto) continue;
    const m = /^(.*?[A-Za-z])(\[(\d+)\]|_(\d+)|(\d+))$/.exec(x.base);
    if (!m || /\d+V\d*$/i.test(x.base)) continue;
    const style = m[2].startsWith('[') ? 'X[0]' : m[2].startsWith('_') ? 'X_0' : 'X0';
    (buses[m[1].toUpperCase()] ||= []).push({ full: x.full, style });
  }
  for (const [b, list] of Object.entries(buses)) {
    const styles = new Set(list.map((l) => l.style));
    if (list.length > 1 && styles.size > 1) {
      const pref = majority(list.reduce((c, l) => ((c[l.style] = (c[l.style] || 0) + 1), c), {}));
      for (const l of list) if (l.style !== pref) add(l.full, `bus ${b} mixes index styles (${[...styles].join(', ')}); most members use ${pref}`, '(match the bus)');
    }
  }

  // Same net spelled more than one way.
  const groups = {};
  for (const x of info) if (!x.auto) (groups[dupKey(x.base)] ||= []).push(x.full);
  for (const list of Object.values(groups)) {
    if (list.length > 1) for (const n of list) add(n, `looks like the same net as ${list.filter((o) => o !== n).join(', ')}: two names split one net in the netlist`, '(merge, or rename one)');
  }

  if (unread.length) warnings.push(`${unread.length} line(s) could not be read as a net name: ${unread.slice(0, 5).join(' | ')}`);
  if (unnamed) warnings.push(`${unnamed} net(s) have auto-generated names. Name any net you will probe, test or route by rule (clocks, power, diff pairs).`);
  if (repeats) warnings.push(`${repeats} repeated line(s) were counted once.`);
  issues.sort((a, b) => a[0].localeCompare(b[0]));

  const named = names.length - unnamed;
  const clean = named - bad.size;
  const values = [
    { label: 'Nets read', value: String(names.length), hint: source },
    { label: 'Consistent', value: String(clean), tone: bad.size ? 'warn' : 'ok' },
    { label: 'With issues', value: String(bad.size), tone: bad.size ? 'bad' : 'ok' },
    { label: 'Auto-named', value: String(unnamed) },
    { label: 'Convention used', value: conv === 'upper' ? 'UPPER_SNAKE' : 'lower_snake', hint: `${vPref === 'V' ? '3V3' : '3.3V'}, active-low ${alPref === 'n' ? 'nX' : alPref === '~{}' ? '~{X}' : 'X' + alPref}, pairs ${dPref}` },
  ];
  return {
    values,
    warnings,
    tables: [{ title: issues.length ? 'Inconsistent nets' : 'No issues found', columns: ['Net', 'Problem', 'Suggested name'], rows: issues }],
    texts: renames.length ? [{ title: 'Renames', body: renames.join('\n') + '\n' }] : [],
    notes: [
      "'Auto' settings follow the design's majority habit, so a single outlier is flagged rather than the whole design.",
      "A name ending in _N counts as a differential-pair half only when its _P partner exists; otherwise it is an active-low signal.",
      'Hierarchical sheet paths (/sheet/NET) are kept and not linted; only the last part is checked.',
    ],
  };
}
