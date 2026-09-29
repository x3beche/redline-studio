// Skill Builder: a Claude Code SKILL.md from its parts, the folder it lives
// in, a lint of both, and a rough trigger tester for the description.
//
// Pure: no DOM, no fetch, no clock. run(input) -> the kit's result plus
// result.skill (the pieces the page draws; agentOmit).
//
// The rules below follow Anthropic's Agent Skills documentation and the
// Claude Code "Skills" page as read in 2026-09. Every one is marked "verify":
// the format is young and the limits change, so check them against
// docs.claude.com before relying on them.
// - SKILL.md = YAML frontmatter between --- lines, then Markdown.
// - name: lowercase letters, digits and hyphens, at most 64 characters, no
//   reserved words ("anthropic", "claude"), no XML tags (verify).
// - description: required, at most 1024 characters, no XML tags; says what the
//   skill does AND when to use it, in the third person - it is what the model
//   reads to decide whether to load the skill (verify).
// - allowed-tools (Claude Code): tools the skill may use without asking while
//   it is active, e.g. Read, Grep, Bash(git status:*) (verify).
// - Body: keep SKILL.md under ~500 lines; put detail in files one level deep
//   (references/, scripts/, assets/) that the body points to; forward slashes,
//   no absolute paths (verify).
// - Where skills live: .claude/skills/<name>/ (project), ~/.claude/skills/<name>/
//   (personal), <plugin>/skills/<name>/ (plugin) (verify).
// The trigger tester is a heuristic (word overlap and quoted phrases), not the
// model's own judgement.

export const AS_OF = '2026-09';
export const LIMITS = { name: 64, description: 1024, bodyLines: 500 };   // verify
export const RESERVED = ['anthropic', 'claude'];                          // verify
export const TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite', 'Agent', 'Task', 'Skill', 'MultiEdit', 'BashOutput', 'KillShell', 'LS', 'ExitPlanMode', 'SlashCommand'];
export const ROOTS = { project: '.claude/skills', personal: '~/.claude/skills', plugin: 'my-plugin/skills' };

const STOP = new Set(('a an the and or but if then of to in on at by for with from into as is are was were be been it its this that these those there here you your we our they their i me my '
  + 'not no do does did have has had can could should would will may might must use used using when what how why which who please can just also so some any all each more most very '
  + 'can\'t don\'t it\'s i\'m let\'s me tell show give get make want need like about up out new one two '
  + 'bu şu o bir ve ile de da mi mı mu mü için ne nasıl gibi ama çok daha en ben sen biz bana beni lütfen şey var yok').split(/\s+/));

const fold = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/İ/g, 'i').toLowerCase();
export function toks(t) {
  return fold(t).split(/[^a-z0-9_+#-]+/).map((w) => w.replace(/^-+|-+$/g, '')).filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith('ing') ? w.slice(0, -3) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}
/** Two words match when equal, or when both are long and share a 5-letter
 *  stem (flash / flashing, yükle / yükleme, program / programming). */
const near = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));

export function phrases(desc) {
  return [...String(desc).matchAll(/["“']([^"”']{3,60})["”']/g)].map((m) => m[1].trim()).filter(Boolean);
}

/** The heuristic trigger score, 0..1: how much of the message the description
 *  covers (content words), plus a boost when a quoted trigger phrase appears
 *  in the message. */
export function triggerScore(desc, msg) {
  const D = [...new Set(toks(desc))];
  const M = [...new Set(toks(msg))];
  const matched = M.filter((w) => D.some((d) => near(w, d)));
  const fm = fold(msg);
  const ph = phrases(desc).filter((p) => { const f = fold(p).trim(); return f.length > 2 && fm.includes(f); });
  const denom = Math.max(3, Math.min(M.length, 8));
  const words = Math.min(1, matched.length / denom);
  const score = Math.min(1, 0.75 * words + (ph.length ? 0.45 : 0));
  return { score: Math.round(score * 100) / 100, matched, phrases: ph, words: M.length };
}

const kebab = (t) => fold(t).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const titleOf = (name) => String(name || 'skill').split(/[-\s]+/).filter(Boolean).map((w) => (/\d/.test(w) && w.length <= 6 || /^(pdf|mcu|api|cli|usb|pcb|sql|ci|ui)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');
const yamlStr = (s) => {
  const t = String(s);
  // Plain scalars break on ": ", " #", leading specials; quote those.
  if (!t || /^[\s>|&*!%@`'"{[\],?-]|:\s|\s#|:$|\n/.test(t)) return JSON.stringify(t);
  return t;
};
export function estTokens(t) {
  let n = 0;
  for (const m of String(t).matchAll(/[\p{L}]+|\p{N}+|[^\s\p{L}\p{N}]/gu)) {
    const w = m[0];
    n += /^\p{L}+$/u.test(w) ? (w.length <= 6 ? 1 : Math.ceil(w.length / 4.5)) : /^\p{N}+$/u.test(w) ? Math.ceil(w.length / 3) : 1;
  }
  return n;
}

function parseTools(t) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(t || '')) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === '\n') && !depth) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function run(input) {
  const scope = ROOTS[input.scope] ? input.scope : 'project';
  const rawName = String(input.name ?? '').trim();
  const name = rawName;
  const desc = String(input.description ?? '').replace(/\s+\n/g, '\n').trim();
  const tools = parseTools(input.allowedTools);
  const when = String(input.whenToUse ?? '').trim();
  const stepsRaw = String(input.steps ?? '').trim();
  const notesRaw = String(input.notes ?? '').trim();
  const files = (Array.isArray(input.files) ? input.files : []).map((r) => ({ path: String(r?.path ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, ''), purpose: String(r?.purpose ?? '').trim() })).filter((r) => r.path);
  const thr = Number.isFinite(input.threshold) ? Math.min(0.95, Math.max(0.05, input.threshold)) : 0.35;
  const lint = [];
  const L = (sev, field, rule, msg) => lint.push({ sev, field, rule, msg });

  // ---------- name ----------
  if (!name) L('bad', 'name', 'name-missing', 'The name is empty. It becomes the folder name and the /command.');
  else {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) L('bad', 'name', 'name-format', `"${name}" is not lowercase-kebab (letters, digits, single hyphens). Try "${kebab(name) || 'my-skill'}". (verify)`);
    if (name.length > LIMITS.name) L('bad', 'name', 'name-length', `${name.length} characters; the limit is ${LIMITS.name}. (verify)`);
    const res = RESERVED.find((w) => name.toLowerCase().includes(w));
    if (res) L('warn', 'name', 'name-reserved', `Contains the reserved word "${res}", which the Agent Skills API refuses; Claude Code may accept it but the skill will not upload there. (verify)`);
    if (/^(helper|utils?|tools?|misc|skill|stuff|general)$/.test(name)) L('warn', 'name', 'name-vague', `"${name}" says nothing about what it does; use a verb-noun name (processing-pdfs, flash-firmware).`);
  }

  // ---------- description ----------
  const dl = desc.length;
  const ph = phrases(desc);
  if (!desc) L('bad', 'description', 'desc-missing', 'The description is empty: the model decides whether to load the skill from it alone.');
  else {
    if (dl > LIMITS.description) L('bad', 'description', 'desc-length', `${dl} characters; the limit is ${LIMITS.description}. Cut to what it does, when to use it and the trigger phrases. (verify)`);
    if (/<\/?[a-z][^>]*>/i.test(desc)) L('bad', 'description', 'desc-xml', 'XML-like tags are not allowed in the description. (verify)');
    if (!/\b(use (it |this )?when|use for|use whenever|when the user|when you|triggers? on|use if)\b/i.test(desc)) L('warn', 'description', 'desc-when', 'No "Use when ..." clause. The description has to say when to load the skill, not only what it does.');
    if (dl < 80) L('warn', 'description', 'desc-short', `${dl} characters is thin: name the task, the file types or tools, and the words a user would say.`);
    if (/\b(I can|I will|I'm|you can use|you should|use me)\b/i.test(desc)) L('warn', 'description', 'desc-person', 'Write it in the third person ("Extracts text from PDFs..."): it is injected into the system prompt, and first/second person reads oddly there.');
    if (!ph.length && dl < LIMITS.description - 100) L('info', 'description', 'desc-phrases', 'No quoted trigger phrases. Listing the exact words users say ("flash the board", "karta yükle") helps it trigger, in any language.');
    if (/^(a |an |the )?(skill|tool|helper) (for|to|that)\b/i.test(desc)) L('info', 'description', 'desc-lead', 'Lead with the action ("Builds and flashes..."), not "A skill for...".');
  }

  // ---------- allowed-tools ----------
  const toolInfo = tools.map((t) => {
    const m = /^([A-Za-z_][\w-]*)(?:\((.*)\))?$/.exec(t);
    const base = m ? m[1] : t;
    const known = TOOLS.includes(base) || /^mcp__[\w-]+(__[\w*-]+)?$/.test(base);
    return { text: t, base, arg: m?.[2] ?? null, known };
  });
  for (const t of toolInfo) {
    if (!t.known) L('warn', 'tools', 'tool-unknown', `"${t.text}" is not a Claude Code tool name (case matters: Bash, Read, Grep...). (verify)`);
    if (t.base === 'Bash' && t.arg == null) L('warn', 'tools', 'tool-bash-open', 'Plain Bash lets the skill run any command without asking. Narrow it: Bash(git status:*), Bash(npm test:*).');
    if (t.base === 'Bash' && t.arg != null && /[;&|`$]/.test(t.arg)) L('warn', 'tools', 'tool-bash-meta', `Bash(${t.arg}) has shell operators in it; permission patterns match the command prefix, so keep them to one plain command.`);
  }
  if (!tools.length) L('info', 'tools', 'tools-none', 'No allowed-tools: the skill works, and every tool call asks for permission as usual.');

  // ---------- body ----------
  const steps = stepsRaw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^(\d+[.)]|[-*+])\s+/, ''));
  const whenLines = when.split('\n').map((l) => l.trim()).filter(Boolean);
  const bodyLines = [`# ${titleOf(name)}`, ''];
  if (whenLines.length) bodyLines.push('## When to use', '', ...whenLines.map((l) => (/^[-*+]\s/.test(l) ? l : `- ${l}`)), '');
  if (steps.length) bodyLines.push('## Steps', '', ...steps.map((l, i) => `${i + 1}. ${l}`), '');
  if (files.length) {
    bodyLines.push('## Files', '', ...files.map((f) => `- \`${f.path}\`${f.purpose ? ` - ${f.purpose}` : ''}`), '');
  }
  if (notesRaw) bodyLines.push('## Notes', '', ...notesRaw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => (/^[-*+]\s/.test(l) ? l : `- ${l}`)), '');
  while (bodyLines.length && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
  const fm = ['---', `name: ${yamlStr(name || 'my-skill')}`, `description: ${yamlStr(desc)}`];
  if (tools.length) fm.push(`allowed-tools: ${tools.join(', ')}`);
  fm.push('---', '');
  const skillMd = [...fm, ...bodyLines].join('\n') + '\n';
  const nBody = bodyLines.length;

  if (!whenLines.length) L('warn', 'when', 'when-missing', 'No "When to use" section. The description gets the skill loaded; this tells the model where the skill stops (and what it is not for).');
  else if (!/\b(not for|don't use|do not use|instead|skip)\b/i.test(when)) L('info', 'when', 'when-not', 'Say what it is not for, and which skill or tool to use instead; it stops the skill loading next to a neighbour.');
  if (!steps.length) L('warn', 'steps', 'steps-missing', 'No steps. A skill is a procedure: list what to do, in order, with the exact commands.');
  if (nBody > LIMITS.bodyLines) L('warn', 'steps', 'body-long', `The body is ${nBody} lines (guide: under ${LIMITS.bodyLines}). Move detail into references/*.md and point to it; the files load only when needed. (verify)`);
  const allBody = [when, stepsRaw, notesRaw].join('\n');
  for (const [field, text] of [['when', when], ['steps', stepsRaw], ['notes', notesRaw]]) {
    const abs = [...text.matchAll(/(?<![\w.`-])(\/(?:home|Users|root|opt|mnt|var|tmp|etc)\/[^\s`'")]+|~\/[^\s`'")]+|[A-Z]:\\[^\s`'")]+)/g)].map((m) => m[1]);
    if (abs.length) L('warn', field, 'abs-path', `Absolute path${abs.length > 1 ? 's' : ''} ${abs.slice(0, 3).join(', ')}: they exist on one machine only. Use paths relative to the skill folder or the repo, or an environment variable. (verify)`);
    const back = [...text.replace(/[A-Z]:\\[^\s`'")]+/g, '').matchAll(/\b[\w-]+\\[\w.-]+/g)].map((m) => m[0]).filter((x) => !/^[A-Z]:/.test(x));
    if (back.length) L('warn', field, 'backslash', `Backslash path ${back[0]}: use forward slashes, they work on every OS.`);
  }
  // Files: layout, depth, references both ways.
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f.path)) L('warn', 'files', 'file-dup', `${f.path} is listed twice.`);
    seen.add(f.path);
    const top = f.path.split('/')[0];
    if (f.path.split('/').length > 2 && top === 'references') L('info', 'files', 'file-deep', `${f.path} is two levels deep; keep references one level under the skill folder so the model finds them from SKILL.md.`);
    if (!['scripts', 'references', 'assets', 'templates', 'examples'].includes(top) && f.path.includes('/')) L('info', 'files', 'file-folder', `${f.path}: the usual folders are scripts/, references/ and assets/.`);
    if (/^\/|^~|^[A-Z]:/.test(f.path)) L('bad', 'files', 'file-abs', `${f.path} is absolute; files belong inside the skill folder.`);
    if (/^scripts\//.test(f.path) && !allBody.includes(f.path) && !allBody.includes(f.path.split('/').pop())) L('info', 'steps', 'script-unused', `${f.path} is never mentioned in the steps: say when to run it and with which arguments.`);
    if (f.path.toLowerCase() === 'skill.md') L('bad', 'files', 'file-skillmd', 'SKILL.md is the file being built; do not list it again.');
  }
  for (const m of allBody.matchAll(/(?<![\w/.-])((?:scripts|references|assets)\/[\w./-]+[\w])/g)) {
    if (!files.some((f) => f.path === m[1])) L('warn', 'files', 'file-missing', `The body mentions ${m[1]}, which is not in the folder: add it or fix the path.`);
  }

  // ---------- trigger tests ----------
  const tests = String(input.tests ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^([+-])\s*(.*)$/.exec(l);
    const expect = m ? m[1] === '+' : true;
    const text = (m ? m[2] : l).trim();
    const r = triggerScore(desc, text);
    const fires = r.score >= thr;
    return { text, expect, ...r, fires, pass: fires === expect };
  }).filter((t) => t.text);
  const passN = tests.filter((t) => t.pass).length;
  const misses = tests.filter((t) => !t.pass);

  // ---------- folder ----------
  const folder = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) ? name : kebab(name) || 'my-skill';
  const root = `${ROOTS[scope]}/${folder}`;
  if (folder !== name && name) L('info', 'name', 'folder-name', `The folder is written as ${folder}/ (the name must match the folder).`);
  const tree = [{ path: 'SKILL.md', kind: 'file', purpose: `${nBody + fm.length} lines` }];
  const dirs = [...new Set(files.filter((f) => f.path.includes('/')).map((f) => f.path.split('/').slice(0, -1).join('/')))].sort();
  for (const d of dirs) tree.push({ path: d + '/', kind: 'dir' });
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) tree.push({ path: f.path, kind: 'file', purpose: f.purpose });

  // ---------- shell ----------
  let eof = 'EOF'; while (skillMd.split('\n').includes(eof)) eof += '_';
  const q = (p) => (p.startsWith('~/') ? `"$HOME/${p.slice(2)}"` : `'${p.replace(/'/g, "'\\''")}'`);
  const sh = ['# Create the skill folder' + (scope === 'plugin' ? ' (inside your plugin; rename my-plugin)' : ''),
    `mkdir -p ${[root, ...dirs.map((d) => `${root}/${d}`)].map(q).join(' ')}`,
    `cat > ${q(root + '/SKILL.md')} <<'${eof}'`, skillMd.replace(/\n$/, ''), eof];
  for (const f of files) {
    const p = q(`${root}/${f.path}`);
    if (/\.(sh|bash)$/.test(f.path)) sh.push(`[ -e ${p} ] || printf '#!/usr/bin/env bash\\n# ${f.purpose.replace(/['\\%]/g, '')}\\nset -euo pipefail\\n' > ${p}`, `chmod +x ${p}`);
    else if (/\.py$/.test(f.path)) sh.push(`[ -e ${p} ] || printf '#!/usr/bin/env python3\\n"""${f.purpose.replace(/['\\%"]/g, '')}"""\\n' > ${p}`);
    else if (/\.md$/.test(f.path)) sh.push(`[ -e ${p} ] || printf '# ${f.path.split('/').pop().replace(/\.md$/, '').replace(/['\\%]/g, '')}\\n\\n${f.purpose.replace(/['\\%]/g, '')}\\n' > ${p}`);
    else sh.push(`touch ${p}`);
  }
  const shell = sh.join('\n') + '\n';

  // ---------- result ----------
  const sevN = (s) => lint.filter((x) => x.sev === s).length;
  const dTok = estTokens(`${name}: ${desc}`);
  const values = [
    { label: 'Name', value: name || '(empty)', tone: lint.some((x) => x.field === 'name' && x.sev === 'bad') ? 'bad' : 'ok' },
    { label: 'Description', value: `${dl} / ${LIMITS.description}`, unit: 'chars', hint: `~${dTok} tokens in every session's skill list`, tone: dl > LIMITS.description || !dl ? 'bad' : dl < 80 ? 'warn' : 'ok' },
    { label: 'SKILL.md', value: `${nBody + fm.length} lines`, hint: `body ${nBody} / ${LIMITS.bodyLines}; ~${estTokens(skillMd)} tokens when loaded`, tone: nBody > LIMITS.bodyLines ? 'warn' : 'ok' },
    { label: 'Trigger tests', value: tests.length ? `${passN} / ${tests.length} as expected` : 'none', hint: `threshold ${thr} (heuristic)`, tone: !tests.length ? undefined : misses.length ? 'warn' : 'ok' },
    { label: 'Lint', value: `${sevN('bad')} bad · ${sevN('warn')} warn · ${sevN('info')} info`, tone: sevN('bad') ? 'bad' : sevN('warn') ? 'warn' : 'ok' },
    { label: 'Folder', value: root + '/' },
  ];
  const ord = { bad: 0, warn: 1, info: 2 };
  const tables = [
    { title: 'Lint', columns: ['Severity', 'Part', 'Check', 'Finding'], rows: [...lint].sort((a, b) => ord[a.sev] - ord[b.sev]).map((x) => [x.sev, x.field, x.rule, x.msg]) },
  ];
  if (tests.length) tables.push({ title: 'Trigger tests (heuristic)', columns: ['Expect', 'Score', 'Fires', 'Result', 'Message', 'Matched'], rows: tests.map((t) => [t.expect ? 'load' : 'skip', t.score, t.fires ? 'yes' : 'no', t.pass ? 'ok' : 'MISS', t.text, [...t.phrases.map((p) => `"${p}"`), ...t.matched].join(' ')]) });
  const warnings = lint.filter((x) => x.sev === 'bad').map((x) => `${x.field}: ${x.msg}`);
  for (const t of misses) warnings.push(t.expect ? `"${t.text}" should load the skill but scores ${t.score} (< ${thr}): add its words or a quoted phrase to the description.` : `"${t.text}" should not load the skill but scores ${t.score}: the description is too broad, or say in it what the skill is not for.`);
  const notes = [
    `Frontmatter rules (name format and ${LIMITS.name} characters, description ${LIMITS.description} characters, body under ${LIMITS.bodyLines} lines, reserved words) are from the Agent Skills and Claude Code docs as read ${AS_OF}: verify against docs.claude.com before relying on them.`,
    'The trigger score is a heuristic (word overlap with 5-letter stems, accent-folded, plus quoted phrases). The model decides by meaning; use it to catch descriptions that share no words with what users say, then try the real thing.',
    'Claude Code puts every skill\'s name and description into the session so the model can choose; the body and files load only when the skill is used. Keep the description dense and the body procedural.',
  ];
  return {
    values, tables, warnings, notes,
    texts: [{ title: 'SKILL.md', body: skillMd, lang: 'markdown' }, { title: 'Create folder (sh)', body: shell, lang: 'sh' }],
    skill: { name, desc, phrases: ph, descTokens: dTok, tools: toolInfo, root, tree, lint, tests, threshold: thr, skillMd, fmLines: fm.length, bodyLines: nBody, limits: LIMITS, knownTools: TOOLS, descWords: [...new Set(toks(desc))] },
  };
}
