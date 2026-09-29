// License Manifest Viewer: the packages of an image grouped by license
// family, with INCOMPATIBLE_LICENSE applied the way bitbake applies it.
//
// Sources (poky scarthgap 5.0, read on this machine):
//   meta/classes-recipe/license_image.bbclass  write_license_files(): the
//       PACKAGE NAME / PACKAGE VERSION / RECIPE NAME / LICENSE blocks, and the
//       image manifest's RECIPE NAME / VERSION / LICENSE / FILES blocks
//   meta/lib/oe/license.py  license strings: & and | with ( ), & binding
//       tighter (Python's operator order), two names side by side meaning &;
//       names match [a-zA-Z0-9.+_-]+; license_ok() is fnmatch
//   meta/classes-global/license.bbclass  incompatible_pkg_license(): each OR
//       takes the left branch if all its licenses are acceptable, else the
//       right; expand_wildcard_licenses(): only GPL-3.0*, LGPL-3.0*, AGPL-3.0*
//       are allowed wildcards, obsolete names are fatal; canonical_license()
//       through SPDXLICENSEMAP (meta/conf/licenses.conf)
//   SPDX 2.x (JSON, tag-value) and SPDX 3.0 JSON-LD for the SBOM inputs.
// The family of each license is this tool's reading, for triage - not legal advice.

// meta/conf/licenses.conf SPDXLICENSEMAP (scarthgap), obsolete name -> SPDX id
const SPDXMAP = Object.fromEntries(('AGPL-3=AGPL-3.0-only AGPL-3+=AGPL-3.0-or-later AGPLv3=AGPL-3.0-only AGPLv3+=AGPL-3.0-or-later AGPLv3.0=AGPL-3.0-only ' +
  'AGPLv3.0+=AGPL-3.0-or-later AGPL-3.0=AGPL-3.0-only AGPL-3.0+=AGPL-3.0-or-later BSD-0-Clause=0BSD GPL-1=GPL-1.0-only GPL-1+=GPL-1.0-or-later ' +
  'GPLv1=GPL-1.0-only GPLv1+=GPL-1.0-or-later GPLv1.0=GPL-1.0-only GPLv1.0+=GPL-1.0-or-later GPL-1.0=GPL-1.0-only GPL-1.0+=GPL-1.0-or-later ' +
  'GPL-2=GPL-2.0-only GPL-2+=GPL-2.0-or-later GPLv2=GPL-2.0-only GPLv2+=GPL-2.0-or-later GPLv2.0=GPL-2.0-only GPLv2.0+=GPL-2.0-or-later ' +
  'GPL-2.0=GPL-2.0-only GPL-2.0+=GPL-2.0-or-later GPL-3=GPL-3.0-only GPL-3+=GPL-3.0-or-later GPLv3=GPL-3.0-only GPLv3+=GPL-3.0-or-later ' +
  'GPLv3.0=GPL-3.0-only GPLv3.0+=GPL-3.0-or-later GPL-3.0=GPL-3.0-only GPL-3.0+=GPL-3.0-or-later LGPLv2=LGPL-2.0-only LGPLv2+=LGPL-2.0-or-later ' +
  'LGPLv2.0=LGPL-2.0-only LGPLv2.0+=LGPL-2.0-or-later LGPL-2.0=LGPL-2.0-only LGPL-2.0+=LGPL-2.0-or-later LGPL2.1=LGPL-2.1-only ' +
  'LGPL2.1+=LGPL-2.1-or-later LGPLv2.1=LGPL-2.1-only LGPLv2.1+=LGPL-2.1-or-later LGPL-2.1=LGPL-2.1-only LGPL-2.1+=LGPL-2.1-or-later ' +
  'LGPLv3=LGPL-3.0-only LGPLv3+=LGPL-3.0-or-later LGPL-3.0=LGPL-3.0-only LGPL-3.0+=LGPL-3.0-or-later MPL-1=MPL-1.0 MPLv1=MPL-1.0 ' +
  'MPLv1.1=MPL-1.1 MPLv2=MPL-2.0 MIT-X=MIT MIT-style=MIT openssl=OpenSSL PSF=PSF-2.0 PSFv2=PSF-2.0 Python-2=Python-2.0 Apachev2=Apache-2.0 ' +
  'Apache-2=Apache-2.0 Artisticv1=Artistic-1.0 Artistic-1=Artistic-1.0 AFL-2=AFL-2.0 AFL-1=AFL-1.2 AFLv2=AFL-2.0 AFLv1=AFL-1.2 CDDLv1=CDDL-1.0 ' +
  'CDDL-1=CDDL-1.0 EPLv1.0=EPL-1.0 FreeType=FTL Nauman=Naumen tcl=TCL vim=Vim SGIv1=SGI-1').split(' ').map((p) => p.split('=')));
const WILDCARDS = { 'AGPL-3.0*': ['AGPL-3.0-only', 'AGPL-3.0-or-later'], 'GPL-3.0*': ['GPL-3.0-only', 'GPL-3.0-or-later'], 'LGPL-3.0*': ['LGPL-3.0-only', 'LGPL-3.0-or-later'] };

export const FAMILIES = [
  { id: 'permissive', label: 'Permissive', tip: 'notice and licence text only' },
  { id: 'weak', label: 'Weak copyleft', tip: 'source of the library itself (LGPL, MPL, EPL) or a GPL with a runtime/linking exception' },
  { id: 'strong', label: 'Strong copyleft', tip: 'GPL-1.0/2.0: complete corresponding source for the program' },
  { id: 'gplv3', label: 'GPLv3 family', tip: 'GPL/LGPL/AGPL-3.0: source plus Installation Information (anti-tivoization) on consumer products' },
  { id: 'proprietary', label: 'Proprietary / closed', tip: 'CLOSED, Proprietary, firmware blobs, EULAs: check redistribution terms' },
  { id: 'unknown', label: 'Unknown', tip: 'not a license this tool knows: read the recipe\'s LIC_FILES_CHKSUM files' },
];
const RANK = Object.fromEntries(FAMILIES.map((f, i) => [f.id, i]));

const PERMISSIVE = /^(MIT.*|X11.*|0?BSD.*|Apache-.*|ISC|Zlib|zlib|OpenSSL|SSLeay|PSF-2\.0|Python-2\.0|curl|BSL-1\.0|Unlicense|PD|CC0-1\.0|CC-BY-[0-9].*|FTL|bzip2-.*|Libpng|libpng-2\.0|IJG|Artistic-.*|Vim|TCL|ICU|Unicode-.*|NCSA|W3C.*|HPND.*|AFL-.*|WTFPL|Info-ZIP|libtiff|Spencer-.*|Beerware|FSF.*|Ruby|PHP-3.*|Sendmail|SGI-.*|Naumen|Zope-.*|PostgreSQL|OLDAP-.*|blessing|OFL-1\.1|MirOS|Xnet|NTP|Fair|ISC-.*|MIT-0|Latex2e|Sleepycat-free|GPL-2\.0-with-font-exception)$/;
const WEAK = /^(LGPL-2\.[01]-(only|or-later)|MPL-.*|EPL-.*|CDDL-.*|CPL-1\.0|ErlPL-1\.1|CC-BY-SA-.*|LPPL-.*|OFL-1\.0)$/;
const STRONG = /^(GPL-[12]\.0-(only|or-later)|EUPL-.*|OSL-.*|Sleepycat|QPL-.*|RPL-.*)$/;
const GPL3 = /^(A?GPL-3\.0-(only|or-later)|LGPL-3\.0-(only|or-later))$/;
const PROPRIETARY = /^(CLOSED|Proprietary|proprietary|commercial.*|Firmware-.*|.*-EULA|EULA.*|NXP.*|Freescale.*|NVIDIA.*|Qualcomm.*|LicenseRef-Proprietary|Redistributable-binary.*)$/;
// Exceptions that let a GPL library be linked or its output used without copyleft
const LINK_EXC = /(GCC-exception|classpath-exception|Classpath-exception|autoconf-exception|Autoconf-exception|Bison-exception|Linux-syscall-note|LLVM-exception|bison-exception)/;

export function family(id) {
  const x = String(id).replace(/^LicenseRef-/, '');
  const w = /^(.*?)(?:\s+WITH\s+|-with-)(.+)$/.exec(x);
  if (w) {
    const base = family(canonical(w[1]));
    if (LINK_EXC.test(w[2]) && (base === 'strong' || base === 'gplv3' || base === 'weak')) return 'weak';
    return base === 'unknown' && /^GPL|^LGPL/.test(w[1]) ? 'strong' : base;
  }
  if (GPL3.test(x)) return 'gplv3';
  if (STRONG.test(x)) return 'strong';
  if (WEAK.test(x)) return 'weak';
  if (PROPRIETARY.test(x)) return 'proprietary';
  if (PERMISSIVE.test(x)) return 'permissive';
  return 'unknown';
}
const needsSource = (id) => id !== 'UNPARSED' && /GPL|MPL|EPL|CDDL|CPL|EUPL|OSL|Sleepycat|QPL|RPL|CC-BY-SA/.test(id) && !/font-exception/.test(id);
const canonical = (id) => SPDXMAP[id] || id;

// ---------------- license expressions ----------------
/** OE or SPDX license text -> tree: {lic} | {op:'&'|'|', args:[..]}; throws on bad syntax. */
export function parseExpr(text) {
  let t = String(text || '').trim()
    .replace(/\s+WITH\s+/g, '__WITH__')
    .replace(/\bAND\b/g, '&').replace(/\bOR\b/g, '|');
  const toks = t.split(/([&|()\s])/).filter((x) => x && x.trim());
  // two names side by side mean & (oe.license LicenseVisitor.get_elements)
  const el = [];
  for (const tk of toks) {
    const isName = !/^[&|()]$/.test(tk);
    if (isName && !/^[A-Za-z0-9.+_\-:]+$/.test(tk.replace(/__WITH__/, '-'))) throw new Error(`"${tk}" is not a license name`);
    if (isName && el.length && !/^[&|(]$/.test(el[el.length - 1])) el.push('&');
    el.push(tk);
  }
  let i = 0;
  const atom = () => {
    const tk = el[i++];
    if (tk === '(') { const e = or(); if (el[i++] !== ')') throw new Error('unbalanced ('); return e; }
    if (tk == null || /^[&|)]$/.test(tk)) throw new Error(`unexpected ${tk == null ? 'end' : `"${tk}"`}`);
    return { lic: tk.replace('__WITH__', ' WITH ') };
  };
  const and = () => { const a = [atom()]; while (el[i] === '&') { i++; a.push(atom()); } return a.length > 1 ? { op: '&', args: a } : a[0]; };
  const or = () => { const a = [and()]; while (el[i] === '|') { i++; a.push(and()); } return a.length > 1 ? { op: '|', args: a } : a[0]; };
  if (!el.length) throw new Error('empty');
  const tree = or();
  if (i < el.length) throw new Error(`unexpected "${el[i]}"`);
  return tree;
}
/** Flatten, picking one branch of each OR with choose(listOfBranchSets). */
function flatten(node, choose) {
  if (node.lic) return [node.lic];
  if (node.op === '&') return node.args.flatMap((a) => flatten(a, choose));
  return choose(node.args.map((a) => flatten(a, choose)));
}
const worst = (ids) => ids.reduce((m, id) => Math.max(m, RANK[family(canonical(id))]), 0);
const compact = (n) => (n.lic ? n.lic : [n.op, ...n.args.map(compact)]);

// ---------------- inputs ----------------
function parseManifest(text, warn) {
  const src = String(text || '').trim();
  if (!src) return { kind: 'empty', pkgs: [] };
  if (src[0] === '{' || src[0] === '[') {
    let j;
    try { j = JSON.parse(src); } catch (e) { warn.push(`The input starts like JSON but does not parse: ${e.message}. Paste the whole .spdx.json.`); return { kind: 'json?', pkgs: [] }; }
    if (Array.isArray(j['@graph'])) {
      const byId = new Map(j['@graph'].map((e) => [e.spdxId || e['@id'], e]));
      const lic = new Map();
      for (const r of j['@graph']) {
        if (r.type !== 'Relationship' || !/has(Declared|Concluded)License/.test(r.relationshipType || '')) continue;
        const exp = (r.to || []).map((id) => byId.get(id)).map((e) => e && (e.simplelicensing_licenseExpression || e.name)).filter(Boolean).join(' AND ');
        if (!exp) continue;
        const cur = lic.get(r.from);
        if (!cur || /Declared/.test(r.relationshipType)) lic.set(r.from, exp);
      }
      const pkgs = j['@graph'].filter((e) => e.type === 'software_Package').map((e) => ({
        name: e.name, version: e.software_packageVersion || '', recipe: e.name, license: lic.get(e.spdxId) || 'NOASSERTION' }));
      return { kind: 'SPDX 3.0 JSON-LD', pkgs };
    }
    const list = Array.isArray(j) ? j : j.packages || [];
    if (!list.length) warn.push('The JSON has no "packages" array: paste an SPDX 2.x document (the image or recipe .spdx.json).');
    return { kind: `SPDX ${j.spdxVersion || '2.x'} JSON`, pkgs: list.map((p) => ({
      name: p.name, version: p.versionInfo || '', recipe: p.name,
      license: [p.licenseDeclared, p.licenseConcluded].find((l) => l && l !== 'NOASSERTION' && l !== 'NONE') || 'NOASSERTION' })) };
  }
  if (/^\s*(SPDXVersion|PackageName)\s*:/m.test(src)) {
    const pkgs = [];
    let cur = null;
    for (const line of src.split(/\r?\n/)) {
      const m = /^\s*(\w+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      if (m[1] === 'PackageName') { cur = { name: m[2].trim(), version: '', recipe: m[2].trim(), license: 'NOASSERTION', decl: null }; pkgs.push(cur); }
      else if (cur && m[1] === 'PackageVersion') cur.version = m[2].trim();
      else if (cur && m[1] === 'PackageLicenseDeclared' && !/NOASSERTION|NONE/.test(m[2])) cur.license = m[2].trim();
      else if (cur && m[1] === 'PackageLicenseConcluded' && cur.license === 'NOASSERTION' && !/NOASSERTION|NONE/.test(m[2])) cur.license = m[2].trim();
    }
    return { kind: 'SPDX tag-value', pkgs };
  }
  // license.manifest / image_license.manifest
  const pkgs = [];
  const bad = [];
  src.split(/\n\s*\n/).forEach((block, bi) => {
    const f = {};
    for (const line of block.split(/\r?\n/)) {
      const m = /^\s*([A-Z][A-Z ]+?)\s*:\s?(.*)$/.exec(line);
      if (m) f[m[1]] = m[2].trim();
    }
    if (!f.LICENSE) { if (block.trim()) bad.push(bi + 1); return; }
    const name = f['PACKAGE NAME'] || f['RECIPE NAME'];
    if (!name) { bad.push(bi + 1); return; }
    pkgs.push({ name, version: f['PACKAGE VERSION'] || f.VERSION || '', recipe: f['RECIPE NAME'] || name, license: f.LICENSE });
  });
  if (bad.length) warn.push(`Block${bad.length > 1 ? 's' : ''} ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? '…' : ''} ${bad.length > 1 ? 'have' : 'has'} no LICENSE or no PACKAGE/RECIPE NAME line and were skipped.`);
  return { kind: 'license.manifest', pkgs };
}

export function run(input) {
  const warnings = [], notes = [];
  const { kind, pkgs: rawPkgs } = parseManifest(input.manifest, warnings);
  if (!rawPkgs.length) warnings.push('No packages read. Paste tmp/deploy/licenses/<image>/license.manifest, an SPDX 2.x JSON or tag-value file, or an SPDX 3.0 JSON-LD SBOM.');

  // INCOMPATIBLE_LICENSE as expand_wildcard_licenses() reads it
  const words = String(input.incompatible || '').split(/\s+/).filter(Boolean);
  const bad = new Set();
  for (const w of words) {
    if (WILDCARDS[w]) { WILDCARDS[w].forEach((x) => bad.add(x)); continue; }
    if (SPDXMAP[w]) warnings.push(`INCOMPATIBLE_LICENSE "${w}" is an obsolete name: bitbake stops. Write ${SPDXMAP[w]}.`);
    else if (w.includes('*')) warnings.push(`INCOMPATIBLE_LICENSE "${w}": only GPL-3.0*, LGPL-3.0* and AGPL-3.0* may use a wildcard; bitbake stops. Previewed here as a pattern.`);
    bad.add(w);
  }
  const pattern = (w) => new RegExp('^' + w.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  const badRe = [...bad].map((w) => ({ w, re: pattern(w) }));
  const okLic = (id, list) => !list.some((b) => b.re.test(canonical(id)));
  const exceptions = String(input.exceptions || '').split(/\s+/).filter(Boolean).map((e) => e.split(':'));

  const pkgs = [];
  const unparsed = [];
  for (const p of rawPkgs) {
    let tree;
    const lic = String(p.license || '').trim();
    if (!lic || /^NOASSERTION$|^NONE$/.test(lic)) tree = { lic: 'NOASSERTION' };
    else {
      try { tree = parseExpr(lic); } catch (e) { unparsed.push(`${p.name}: "${lic}" (${e.message})`); tree = { lic: 'UNPARSED' }; }
    }
    // what the distributor may choose: the OR branch with the lightest obligations
    const easy = flatten(tree, (sets) => sets.reduce((b, s) => (worst(s) < worst(b) ? s : b)));
    const ids = [...new Set(easy.map(canonical))];
    const fam = FAMILIES[Math.max(0, ...ids.map((x) => RANK[family(x)]))].id;
    // bitbake's choice under INCOMPATIBLE_LICENSE: first acceptable branch, else the last
    const remaining = badRe.filter((b) => !exceptions.some(([pk, l]) => pk === p.name && l === b.w)); // oe.license.apply_pkg_license_exception
    const pick = (list) => (sets) => sets.find((s) => s.every((x) => okLic(x, list))) || sets[sets.length - 1];
    const chosen = flatten(tree, pick(badRe));
    const incompatible = [...new Set(chosen.filter((x) => !okLic(x, badRe)).map(canonical))];
    const chosenEx = flatten(tree, pick(remaining));
    const stillBad = chosenEx.filter((x) => !okLic(x, remaining));
    const legacy = [];
    (function walk(n) { if (n.lic) { if (SPDXMAP[n.lic]) legacy.push(`${n.lic} → ${SPDXMAP[n.lic]}`); } else n.args.forEach(walk); })(tree);
    const allIds = []; (function walk(n) { if (n.lic) allIds.push(canonical(n.lic)); else n.args.forEach(walk); })(tree);
    pkgs.push({
      name: p.name, version: p.version, recipe: p.recipe, license: lic, tree: compact(tree),
      ids, family: fam, dual: /\|/.test(lic) || /\bOR\b/.test(lic),
      legacy, source: ids.some(needsSource),
      excluded: incompatible.length > 0 && stillBad.length > 0, allowed: incompatible.length > 0 && stillBad.length === 0,
      incompatible, all: [...new Set(allIds)],
    });
  }
  if (unparsed.length) warnings.push(`License expressions that do not parse (bitbake would stop on these too): ${unparsed.slice(0, 5).join('; ')}${unparsed.length > 5 ? ` and ${unparsed.length - 5} more` : ''}.`);

  // per license: the ids in the distributor's choice
  const byLic = new Map();
  for (const p of pkgs) for (const id of p.ids) {
    const e = byLic.get(id) || { id, family: family(id), pkgs: [], recipes: new Set(), excluded: 0 };
    e.pkgs.push(p.name); e.recipes.add(p.recipe); if (p.excluded) e.excluded++;
    byLic.set(id, e);
  }
  const lics = [...byLic.values()].sort((a, b) => RANK[a.family] - RANK[b.family] || b.pkgs.length - a.pkgs.length || a.id.localeCompare(b.id));
  const famCount = Object.fromEntries(FAMILIES.map((f) => [f.id, pkgs.filter((p) => p.family === f.id).length]));
  const excluded = pkgs.filter((p) => p.excluded);
  const allowed = pkgs.filter((p) => p.allowed);
  const srcRecipes = new Map();
  for (const p of pkgs) if (p.source && !p.excluded) {
    const r = srcRecipes.get(p.recipe) || { recipe: p.recipe, version: p.version, ids: new Set(), pkgs: [] };
    p.ids.filter(needsSource).forEach((x) => r.ids.add(x)); r.pkgs.push(p.name);
    srcRecipes.set(p.recipe, r);
  }
  const src = [...srcRecipes.values()].sort((a, b) => a.recipe.localeCompare(b.recipe));
  const unknown = lics.filter((l) => l.family === 'unknown');
  const legacyPk = pkgs.filter((p) => p.legacy.length);

  if (famCount.gplv3 && !words.length) warnings.push(`${famCount.gplv3} package${famCount.gplv3 > 1 ? 's' : ''} under GPLv3-family licenses with no INCOMPATIBLE_LICENSE set. On a locked-down consumer device (secure boot, read-only rootfs) GPLv3 requires Installation Information; set INCOMPATIBLE_LICENSE = "GPL-3.0* LGPL-3.0* AGPL-3.0*" to see what would have to go.`);
  if (excluded.length) warnings.push(`INCOMPATIBLE_LICENSE excludes ${excluded.length} package${excluded.length > 1 ? 's' : ''}: ${excluded.slice(0, 8).map((p) => p.name).join(', ')}${excluded.length > 8 ? '…' : ''}. If the image asks for them, bitbake stops ("cannot be installed into the image because it has incompatible license(s)"); remove them from IMAGE_INSTALL, replace them, or list them in INCOMPATIBLE_LICENSE_EXCEPTIONS.`);
  if (unknown.length) warnings.push(`Licenses this tool does not know: ${unknown.map((l) => l.id).join(', ')}. Read their LIC_FILES_CHKSUM text in tmp/deploy/licenses/<recipe>/ before shipping.`);
  if (legacyPk.length) notes.push(`${legacyPk.length} package${legacyPk.length > 1 ? 's use' : ' uses'} obsolete license names (${[...new Set(legacyPk.flatMap((p) => p.legacy))].slice(0, 4).join(', ')}); bitbake maps them through SPDXLICENSEMAP, but new layers should write SPDX ids.`);
  if (famCount.proprietary) notes.push('Proprietary and firmware licenses: check each one allows redistribution in your product, and whether LICENSE_FLAGS (commercial, EULA) had to be accepted with LICENSE_FLAGS_ACCEPTED.');
  if (src.length) notes.push('For GPL/LGPL source, archiver.bbclass can collect it: INHERIT += "archiver", ARCHIVER_MODE[src] = "original", COPYLEFT_LICENSE_INCLUDE = "GPL* LGPL*". Keep the patches and the build configuration with it.');
  notes.push('Packages with an OR are placed by the lightest branch you may choose (e.g. GPL-2.0-or-later | LGPL-3.0-or-later sits under GPL-2.0-or-later); INCOMPATIBLE_LICENSE picks branches bitbake\'s way, the first acceptable one.');
  notes.push('The family of a license is a triage aid, not legal advice.');

  const values = [
    { label: 'Packages', value: pkgs.length, hint: `from ${kind}` },
    { label: 'Recipes', value: new Set(pkgs.map((p) => p.recipe)).size },
    { label: 'Licenses', value: lics.length },
    { label: 'GPLv3 family', value: famCount.gplv3, tone: famCount.gplv3 ? 'warn' : 'ok' },
    { label: 'Excluded by INCOMPATIBLE_LICENSE', value: excluded.length, tone: excluded.length ? 'bad' : 'ok', hint: words.join(' ') || 'not set' },
    { label: 'Recipes needing source', value: src.length, hint: 'GPL/LGPL/MPL/EPL in the chosen licenses' },
    { label: 'Proprietary / unknown', value: famCount.proprietary + famCount.unknown, tone: famCount.unknown ? 'warn' : undefined },
  ];
  const tables = [
    { title: 'Licenses', columns: ['License', 'Family', 'Packages', 'Recipes', 'Excluded'], rows: lics.map((l) => [l.id, l.family, l.pkgs.length, l.recipes.size, l.excluded]) },
  ];
  if (excluded.length || allowed.length) tables.push({ title: 'INCOMPATIBLE_LICENSE preview', columns: ['Package', 'Recipe', 'LICENSE', 'Incompatible', 'Result'],
    rows: [...excluded, ...allowed].map((p) => [p.name, p.recipe, p.license, p.incompatible.join(' '), p.excluded ? 'excluded' : 'allowed by exception']) });
  tables.push({ title: 'Recipes needing a source offer', columns: ['Recipe', 'Version', 'Licenses', 'Packages'], rows: src.map((r) => [r.recipe, r.version, [...r.ids].join(' '), r.pkgs.length]) });

  const offer = src.map((r) => `${r.recipe} ${r.version}  ${[...r.ids].join(' & ')}`).join('\n');
  const texts = [
    { title: 'Source offer', body: offer ? `# Recipes whose packages ship under copyleft licenses (${src.length})\n${offer}\n` : '# No copyleft licenses in the chosen branches.\n' },
  ];
  if (excluded.length) texts.push({ title: 'Excluded', body: excluded.map((p) => `${p.name}\t${p.recipe}\t${p.incompatible.join(' ')}`).join('\n') + '\n' });

  const canonicalMap = {}, leafFamily = {};
  for (const p of pkgs) (function walk(n) {
    if (typeof n === 'string') { const c = canonical(n); if (c !== n) canonicalMap[n] = c; leafFamily[c] = family(c); } else n.slice(1).forEach(walk);
  })(p.tree);

  return {
    values, tables, texts, warnings, notes,
    view: {
      canonical: canonicalMap, leafFamily,
      kind, families: FAMILIES.map((f) => ({ ...f, count: famCount[f.id] })), bad: [...bad],
      lics: lics.map((l) => ({ id: l.id, family: l.family, n: l.pkgs.length, excluded: l.excluded, obsolete: false })),
      pkgs,
    },
  };
}
