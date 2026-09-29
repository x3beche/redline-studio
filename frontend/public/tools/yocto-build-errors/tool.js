// Build Error & QA Explainer: reads a BitBake console log or a task log
// (log.do_*), finds the lines that decide each failure with the rule table in
// rules.js, and says per finding what failed, why, and the recipe lines that
// fix it - in the override syntax of the release in the log.
//
// Log shapes read:
//   console:  "ERROR: <pn>-<pv>-<pr> do_<task>: <message>"  (bitbake/lib/bb/build.py
//             prefixes task messages with the recipe's PF and the task)
//             "ERROR: Task (<file.bb>:do_<task>) failed with exit code '1'"
//             "| <line>"  the failed task's log, echoed after "Log data follows:"
//   task log: tmp/work/<arch>/<pn>/<ver>/temp/log.do_<task>.<pid> ("DEBUG: Executing
//             shell function do_compile", compiler output)
// A QA message is "QA Issue: <text> [<check>]" (meta/lib/oe/qa.py handle_error);
// ERROR or WARNING per ERROR_QA / WARN_QA of meta/classes-global/insane.bbclass.
// Pure: no DOM; imports only the sibling rule table.

import { RULES, CONSEQUENCE, CATS, explain } from './rules.js';

// ERROR_QA of insane.bbclass (OE-Core scarthgap/walnascar): a QA message with
// no ERROR/WARNING prefix (inside a task log) takes its level from here.
const ERROR_QA = new Set(('dev-so debug-deps dev-deps debug-files arch pkgconfig la perms dep-cmp pkgvarcheck perm-config perm-line perm-link '
  + 'split-strip packages-list pkgv-undefined var-undefined version-going-backwards expanded-d invalid-chars license-checksum dev-elf '
  + 'file-rdeps configure-unsafe configure-gettext perllocalpod shebang-size already-stripped installed-vs-shipped ldflags '
  + 'compile-host-path install-host-path pn-overrides unknown-configure-option useless-rpaths rpaths staticdev empty-dirs patch-fuzz '
  + 'usrmerge patch-status').split(' '));

// Yocto Project release numbers -> codenames (wiki.yoctoproject.org/wiki/Releases).
const CODENAMES = { '3.1': 'dunfell', '3.2': 'gatesgarth', '3.3': 'hardknott', '3.4': 'honister', '4.0': 'kirkstone', '4.1': 'langdale',
  '4.2': 'mickledore', '4.3': 'nanbield', '5.0': 'scarthgap', '5.1': 'styhead', '5.2': 'walnascar', '5.3': 'whinlatter', '6.0': 'wrynose' };

const MAX_VIEW = 20000;
// Rules that say a step failed but not why: context of a specific finding in the same task.
const GENERIC = new Set(['rootfs-pm', 'fetch-failed', 'compile-error', 'network']);
const LEVEL = /^(ERROR|WARNING|NOTE|DEBUG):\s/;
// PF = PN-PV-PR; PV has no '-', PR starts with r and a digit.
const HEADER = /^(ERROR|WARNING|NOTE): (\S+)-([^\s-]+)-(r\d[^\s]*) (do_[\w]+): /;
const WORKPATH = /\/work\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/temp\/log\.(do_\w+)/;
const TASKFAIL = /Task \((?:[\w-]+:)*([^():]+\.bb(?:append)?):(do_\w+)\) failed/;
const RECIPE_FAIL = /NOTE: recipe (\S+)-([^\s-]+)-(r\d\S*): task (do_\w+): Failed/;
const GCC_EXCERPT = /^\s*\d*\s+\|\s|^\s+\|\s*[\^~]|^In file included from|^\s+from \S+:\d+/;

const clean = (s) => String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r$/, '')
  // CI timestamps in front of the line
  .replace(/^\[?\d{4}-\d\d-\d\d[T ][\d:.]+Z?\]?\s+/, '').replace(/^\[\d\d:\d\d:\d\d(?:\.\d+)?\]\s+/, '');
const bbToPn = (file, virt) => {
  const base = file.split('/').pop().replace(/\.bb(append)?$/, '');
  const pn = base.includes('_') ? base.slice(0, base.lastIndexOf('_')) : base;
  return virt ? `${pn}-${virt}` : pn;
};

function releaseOf(text) {
  const m = /DISTRO_VERSION\s*=\s*"(\d+)\.(\d+)[^"]*"/.exec(text);
  if (!m) return null;
  const v = `${m[1]}.${m[2]}`;
  return { version: /DISTRO_VERSION\s*=\s*"([^"]+)"/.exec(text)[1], series: v, codename: CODENAMES[v] || '', old: Number(m[1]) * 100 + Number(m[2]) < 304 };
}

function syntaxOf(choice, text, rel) {
  if (choice === 'colon' || choice === 'underscore') return { colon: choice === 'colon', how: 'as chosen' };
  if (rel) return { colon: !rel.old, how: `from DISTRO_VERSION ${rel.version}` };
  if (/\b(?:RDEPENDS|RRECOMMENDS|FILES|INSANE_SKIP)_(?:\$\{PN\}|[a-z][\w-]*\?)/.test(text)) return { colon: false, how: 'from RDEPENDS_/FILES_ in the log' };
  if (/\b(?:RDEPENDS|FILES|INSANE_SKIP):[\w${]/.test(text)) return { colon: true, how: 'from RDEPENDS:/FILES: in the log' };
  return { colon: true, how: 'default (Yocto 3.4 honister and later)' };
}

export function run(input) {
  const text = String(input.log ?? '');
  const withWarn = input.warnings !== false;
  const rel = releaseOf(text);
  const syn = syntaxOf(input.syntax, text, rel);
  const O = (v, s) => (syn.colon ? `${v}:${s}` : `${v}_${s}`);
  const oldify = (t) => (syn.colon ? t : t
    .replace(/(\b[A-Za-z_]+):(\$\{PN\}[\w-]*|append|prepend|remove|pn-[\w.+${}-]+|<machine>|class-\w+)/g, '$1_$2')
    .replace(/LICENSE_FLAGS_ACCEPTED/g, 'LICENSE_FLAGS_WHITELIST').replace(/BB_ENV_PASSTHROUGH_ADDITIONS/g, 'BB_ENV_EXTRAWHITE'));

  const src = text.split('\n');
  if (src.length && src[src.length - 1] === '') src.pop();
  const lines = src.map(clean);
  const N = lines.length;
  const meta = lines.map(() => ({ lv: '', role: '', f: 0, piped: false }));

  const found = new Map();   // key -> finding
  const failed = [];         // {recipe, task, line}
  const consumed = new Map(); // line -> finding (a span already read by a rule)
  const orphans = [];        // ERROR lines no rule matched: {i, recipe, task}
  const ctxLines = [];       // consequence lines: {i, recipe, task}
  let st = { recipe: '', task: '' };
  const isConsole = lines.some((l) => HEADER.test(l));
  let last = null, lastLine = -2;

  const add = (key, base) => {
    let f = found.get(key);
    if (!f) { f = { ...base, lines: [], ctx: [], items: [] }; found.set(key, f); }
    return f;
  };

  for (let i = 0; i < N; i++) {
    const raw = lines[i];
    const piped = /^\|(\s|$)/.test(raw);
    const body = piped ? raw.replace(/^\|\s?/, '') : raw;
    const lvm = LEVEL.exec(body);
    const lv = lvm ? lvm[1] : '';
    meta[i].lv = lv === 'ERROR' ? 'e' : lv === 'WARNING' ? 'w' : lv === 'NOTE' ? 'n' : lv === 'DEBUG' ? 'd' : '';
    meta[i].piped = piped;

    // ---- where are we: recipe and task ----
    if (!piped) {
      const hm = HEADER.exec(body);
      if (hm) st = { recipe: hm[2], task: hm[5] };
      // In a console log a BitBake message without a recipe prefix is global ("Nothing PROVIDES").
      else if (isConsole && lv && lv !== 'DEBUG') st = { recipe: '', task: '' };
      const tf = TASKFAIL.exec(body);
      if (tf) {
        const virt = /virtual:(native|nativesdk|cross)/.exec(body);
        const t = { recipe: bbToPn(tf[1], virt && virt[1]), task: tf[2], line: i };
        failed.push(t); st = { recipe: t.recipe, task: t.task };
      }
      const rf = RECIPE_FAIL.exec(body);
      if (rf) failed.push({ recipe: rf[1], task: rf[4], line: i });
    }
    const wp = WORKPATH.exec(body);
    if (wp && (!st.recipe || /Logfile of failure/.test(body))) st = { recipe: wp[1], task: wp[3] };
    const fn = /^(?:DEBUG: )?Executing (?:shell|python) function (do_\w+)/.exec(body);
    if (fn && !HEADER.test(body) && (!st.task || !piped)) st = { ...st, task: fn[1] };
    if (!st.recipe) { const wp2 = /\/work\/[\w.+-]*linux[\w.+-]*\/([^/\s]+)\/[^/\s]+\//.exec(body); if (wp2) st = { ...st, recipe: wp2[1] }; }

    // ---- a line an earlier rule already read ----
    if (consumed.has(i)) { const f = consumed.get(i); f.lines.push(i); meta[i].role = 'dec'; meta[i].f = f; last = f; lastLine = i; continue; }
    // ---- the source excerpt gcc prints under an error ----
    if (last && lastLine === i - 1 && GCC_EXCERPT.test(body)) { last.ctx.push(i); meta[i].role = 'ctx'; meta[i].f = last; lastLine = i; continue; }

    const isConseq = CONSEQUENCE.test(body);
    let hit = null;
    for (const rule of RULES) {
      // "x: not found" and compiler-style rules only on program output, not on BitBake's own messages
      if ((rule.id === 'missing-tool' || rule.cat === 'compile') && lv && lv !== 'ERROR' && !piped) continue;
      const m = rule.re.exec(body);
      if (!m) continue;
      const ctx = { line: body, peek: (k) => (i + k < N ? lines[i + k].replace(/^\|\s?/, '') : null) };
      const r = (rule.take && rule.take(m, ctx)) || {};
      hit = { rule, r };
      break;
    }
    if (hit && !(isConseq && hit.rule.cat !== 'qa' && [...found.values()].some((f) => f.recipe === st.recipe && f.task === st.task && f.sev === 'error'))) {
      const { rule, r } = hit;
      const check = r.check || rule.id;
      if (!withWarn && lv === 'WARNING') { meta[i].role = 'skip'; continue; }
      const sev = lv === 'ERROR' ? 'error' : lv === 'WARNING' ? 'warning'
        : rule.cat === 'qa' ? (ERROR_QA.has(check) ? 'error' : 'warning') : 'error';
      const key = [rule.id, r.key ?? '', st.recipe, rule.cat === 'qa' || rule.cat === 'config' ? '' : st.task].join('|');
      const f = add(key, { rule: rule.id, check, cat: rule.cat, sev, recipe: r.recipe || st.recipe, task: r.recipe ? '' : st.task });
      if (sev === 'error') f.sev = 'error';
      if (!f.task && st.task) f.task = st.task;
      f.lines.push(i); f.items.push(r.item || {});
      meta[i].role = 'dec'; meta[i].f = f;
      for (const k of r.span || []) if (i + k < N && !consumed.has(i + k)) consumed.set(i + k, f);
      last = f; lastLine = i;
      continue;
    }
    if (isConseq) { ctxLines.push({ i, recipe: st.recipe, task: st.task }); meta[i].role = 'ctx'; continue; }
    if (lv === 'ERROR') orphans.push({ i, recipe: st.recipe, task: st.task });
  }

  // ---- attach the consequence lines to their finding ----
  const all = () => [...found.values()];
  const owner = (recipe, task) => all().find((f) => f.recipe === recipe && f.task === task)
    || all().find((f) => recipe && f.recipe === recipe) || null;
  for (const c of ctxLines) {
    const f = owner(c.recipe, c.task);
    if (f) { f.ctx.push(c.i); meta[c.i].f = f; }
  }
  // ---- failed tasks no rule explains, and ERROR lines no rule matched ----
  const leftovers = [];
  for (const o of orphans) {
    const f = o.recipe ? owner(o.recipe, o.task) : null;
    if (f) { f.ctx.push(o.i); meta[o.i].role = 'ctx'; meta[o.i].f = f; } else leftovers.push(o);
  }
  for (const t of failed) {
    if (all().some((f) => f.recipe === t.recipe && (f.task === t.task || !f.task) && f.sev === 'error')) continue;
    const f = add(['unclassified', '', t.recipe, t.task].join('|'), { rule: 'unclassified', check: 'unclassified', cat: 'other', sev: 'error', recipe: t.recipe, task: t.task });
    const own = leftovers.filter((o) => o.recipe === t.recipe && (!o.task || o.task === t.task));
    for (const o of own) { f.lines.push(o.i); meta[o.i].role = 'dec'; meta[o.i].f = f; f.sample ||= lines[o.i].replace(/^ERROR: (\S+ do_\w+: )?/, ''); }
    if (!f.lines.includes(t.line)) { f.ctx.push(t.line); meta[t.line].role = 'ctx'; meta[t.line].f = f; }
    for (const c of ctxLines) if (c.recipe === t.recipe && c.task === t.task && !meta[c.i].f) { f.ctx.push(c.i); meta[c.i].f = f; }
  }
  const stray = leftovers.filter((o) => !meta[o.i].f);
  for (const o of stray) {
    const f = add(['unclassified', '', o.recipe, o.task].join('|'), { rule: 'unclassified', check: 'unclassified', cat: 'other', sev: 'error', recipe: o.recipe, task: o.task });
    f.lines.push(o.i); meta[o.i].role = 'dec'; meta[o.i].f = f; f.sample ||= lines[o.i].replace(/^ERROR: (\S+ do_\w+: )?/, '');
  }

  // ---- a generic finding next to a specific one of the same task is its context ----
  for (const g of all().filter((f) => GENERIC.has(f.rule))) {
    const spec = all().find((f) => f !== g && !GENERIC.has(f.rule) && f.rule !== 'unclassified' && f.recipe === g.recipe && f.task === g.task);
    if (!spec) continue;
    spec.ctx.push(...g.lines, ...g.ctx);
    for (const x of [...g.lines, ...g.ctx]) { meta[x].role = 'ctx'; meta[x].f = spec; }
    for (const [k, v] of found) if (v === g) found.delete(k);
  }

  // ---- number, explain ----
  const findings = all().filter((f) => f.lines.length || f.ctx.length)
    .sort((a, b) => Math.min(...a.lines, ...a.ctx) - Math.min(...b.lines, ...b.ctx));
  findings.forEach((f, k) => { f.id = k + 1; });
  const cards = findings.map((f) => {
    const ex = explain(f, O);
    const lns = [...new Set(f.lines)].sort((a, b) => a - b);
    return {
      id: f.id, sev: f.sev, cat: f.cat, catLabel: CATS[f.cat] || f.cat, check: f.check, recipe: f.recipe || '', task: f.task || '',
      lines: lns.map((x) => x + 1), ctx: [...new Set(f.ctx)].sort((a, b) => a - b).map((x) => x + 1),
      title: ex.title, what: ex.what || '', why: ex.why || '', fix: oldify(ex.fix || ''), doc: ex.doc || '', url: ex.url || '',
      unclassified: f.rule === 'unclassified',
    };
  });

  const errors = cards.filter((c) => c.sev === 'error').length;
  const warns = cards.length - errors;
  const uniqFailed = [...new Map(failed.map((t) => [`${t.recipe}:${t.task}`, t])).values()];
  const recipes = [...new Set(cards.map((c) => c.recipe).filter(Boolean))];
  const unclassified = cards.filter((c) => c.unclassified).length;

  const values = [
    { label: 'Findings', value: cards.length ? `${errors} error${errors === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}` : 'none', tone: errors ? 'bad' : warns ? 'warn' : 'ok' },
    { label: 'Failed tasks', value: uniqFailed.length, tone: uniqFailed.length ? 'bad' : 'ok', hint: uniqFailed.slice(0, 3).map((t) => `${t.recipe}:${t.task}`).join(', ') || undefined },
    { label: 'Recipes involved', value: recipes.length, hint: recipes.slice(0, 4).join(', ') || undefined },
    { label: 'Lines read', value: N },
    { label: 'Release in log', value: rel ? `${rel.version}${rel.codename ? ` (${rel.codename})` : ''}` : 'not stated' },
    { label: 'Fix syntax', value: syn.colon ? 'FILES:${PN}' : 'FILES_${PN}', hint: syn.how },
  ];
  if (unclassified) values.push({ label: 'Unclassified', value: unclassified, tone: 'warn', hint: 'failures no rule recognised' });
  for (const v of values) if (v.hint === undefined) delete v.hint;

  const warnings = [];
  if (!text.trim()) warnings.push('The log is empty: paste the bitbake console output or a tmp/work/.../temp/log.do_<task> file.');
  else if (!cards.length && !/(ERROR|WARNING):/.test(text)) warnings.push('No ERROR or WARNING line and nothing any rule recognises: is this the right log? For a failed task use temp/log.do_<task> or the console output after "Log data follows".');
  if (unclassified) warnings.push(`${unclassified} failure${unclassified === 1 ? '' : 's'} matched no rule (${cards.filter((c) => c.unclassified).map((c) => `#${c.id} ${c.recipe || '?'}${c.task ? ':' + c.task : ''}`).join(', ')}): read the task log named in the Logfile line; the first error above "Task ... failed" is usually the cause.`);
  if (N > MAX_VIEW) warnings.push(`The log has ${N} lines; all were read, the first ${MAX_VIEW} are shown on the page.`);

  const notes = [
    `Fix snippets use the ${syn.colon ? 'colon (honister 3.4+)' : 'underscore (dunfell/hardknott and older)'} override syntax, ${syn.how}.`,
    'A QA message without an ERROR/WARNING prefix takes its level from ERROR_QA in insane.bbclass; a distro or layer may move checks between ERROR_QA and WARN_QA.',
    'Only the first failing task of a recipe is usually real; a later failure in a recipe that depends on it often goes away with the first fix.',
  ];

  const tables = [{
    title: 'Findings',
    columns: ['#', 'Level', 'Kind', 'Recipe', 'Task', 'Line', 'Finding'],
    rows: cards.map((c) => [c.id, c.sev, c.check, c.recipe || '–', c.task || '–', c.lines.slice(0, 4).join(', ') || c.ctx.slice(0, 2).join(', '), c.title]),
  }];
  if (uniqFailed.length) tables.push({ title: 'Failed tasks', columns: ['Recipe', 'Task', 'Line', 'Findings'],
    rows: uniqFailed.map((t) => [t.recipe, t.task, t.line + 1, cards.filter((c) => c.recipe === t.recipe && (c.task === t.task || !c.task)).map((c) => '#' + c.id).join(' ') || '–']) });

  const fixes = cards.map((c) => [
    `## ${c.id}. ${c.title}  [${c.check}] ${c.sev.toUpperCase()}`,
    `Recipe: ${c.recipe || '?'}   Task: ${c.task || '?'}   Log line${c.lines.length === 1 ? '' : 's'}: ${c.lines.join(', ') || c.ctx.join(', ')}`,
    `What: ${c.what}`, `Why: ${c.why}`, 'Fix:', '```', c.fix, '```', c.doc ? `Doc: ${c.doc} - ${c.url}` : '',
  ].filter((x) => x !== '').join('\n')).join('\n\n');
  const decisive = cards.map((c) => `#${c.id} ${c.check}\n` + c.lines.slice(0, 12).map((n) => `${String(n).padStart(5)}  ${lines[n - 1]}`).join('\n')).join('\n\n');
  const texts = cards.length ? [{ title: 'Fixes', body: fixes + '\n' }, { title: 'Decisive lines', body: decisive + '\n' }] : [];

  const view = {
    lines: lines.slice(0, MAX_VIEW).map((t, i) => ({ t, lv: meta[i].lv, role: meta[i].role, f: meta[i].f ? meta[i].f.id || 0 : 0, p: meta[i].piped ? 1 : 0 })),
    cards, failed: uniqFailed.map((t) => ({ recipe: t.recipe, task: t.task, line: t.line + 1 })),
    build: {
      release: rel ? `${rel.version}${rel.codename ? ' ' + rel.codename : ''}` : '',
      machine: (/^MACHINE\s*=\s*"([^"]+)"/m.exec(text) || [])[1] || '',
      target: (/^TARGET_SYS\s*=\s*"([^"]+)"/m.exec(text) || [])[1] || '',
      bb: (/^BB_VERSION\s*=\s*"([^"]+)"/m.exec(text) || [])[1] || '',
    },
    total: N,
  };
  return { values, tables, texts, warnings, notes, view };
}
