// CLAUDE.md / AGENTS.md Linter: an agent instruction file split into its
// rules, each rule checked, and a tightened copy written back.
//
// Pure: no DOM, no fetch, no clock. run(input) -> the kit's result shape plus
// result.lint (the parsed rows and findings the page draws; agentOmit).
//
// What the checks rest on (read 2026-09; the page says to verify):
// - Anthropic, Claude Code docs "Manage Claude's memory" and "Best practices for
//   agentic coding": be specific ("Use 2-space indentation" rather than "Format
//   code properly"), structure with headings and bullets, keep the file concise
//   and refine it like a prompt, emphasis (IMPORTANT, YOU MUST) for the few rules
//   that need it. The memory page suggests keeping each CLAUDE.md to roughly 200
//   lines - verify against the Claude Code docs.
// - Anthropic, Claude 4 prompting best practices: say why a rule exists (the
//   model generalises from the reason); aggressive capitals can cause overuse.
// - agents.md (open AGENTS.md format) and OpenAI Codex docs: the nearest
//   AGENTS.md to the edited file wins; Codex reads at most project_doc_max_bytes
//   (32 KiB by default) of them - verify against the Codex docs.
// - Secret patterns: the public prefixes of GitHub, AWS, Slack, Google, OpenAI
//   and Anthropic keys, PEM private-key headers, JWTs, user:password@ URLs.
// Token counts are an estimate (a word-piece heuristic), not a tokenizer.

export const AS_OF = '2026-09';
export const GUIDE = {
  lines: 200,          // Claude Code memory docs: target under ~200 lines per file (verify)
  codexBytes: 32768,   // Codex project_doc_max_bytes default (verify)
};

/** Why each check matters and what to do; shown once per check. */
export const ADVICE = {
  contradiction: 'An agent has to pick one and may pick either. Keep one rule, or scope each (which directory, which language, which case).',
  duplicate: 'Every repeat costs tokens in every session and makes the file harder to keep consistent. Keep one.',
  secret: 'The file is read by every agent and usually committed. Remove the value, rotate it, and say where it is kept (a vault, an env var name).',
  'stale-path': 'An agent will go looking for the path and waste turns, or trust an old doc. Fix the path or drop the rule.',
  'absolute-path': 'It only exists on one machine. Use a path relative to the repository root.',
  'unformatted-command': 'Backticks mark exactly what to type; a command in prose is easy to run with a stray word attached.',
  'self-evident': 'The model does this anyway. Replace it with the repo-specific rule behind it, or delete it.',
  vague: 'A rule the agent can check (a command, a number, a pattern) beats one it has to interpret.',
  'no-reason': 'One clause of why lets the agent handle the cases the rule does not name (Anthropic: add context and motivation).',
  shouting: 'When everything is IMPORTANT nothing is, and recent models over-apply shouted rules. Keep capitals for the one rule that must never break.',
  'long-rule': 'Split it, or move the detail into a doc the file points to.',
  'empty-section': 'Fill it or remove the heading.',
  'too-long': 'The whole file is loaded into every session. Move detail into docs the file points to (@docs/x.md, or "see docs/x.md") and keep the rules.',
};

export const TOPICS = [
  { id: 'build', label: 'Build & run', core: true, words: ['build', 'compile', 'cmake', 'make', 'flash', 'bundle', 'vite', 'webpack', 'gradle', 'cargo', 'install', 'dev', 'server', 'run', 'start', 'preset', 'toolchain', 'deploy', 'docker', 'uvicorn', 'firmware'] },
  { id: 'test', label: 'Testing', core: true, words: ['test', 'tests', 'pytest', 'jest', 'vitest', 'ctest', 'coverage', 'unit', 'e2e', 'mock', 'mocks', 'fixture', 'spec', 'assert', 'regression'] },
  { id: 'style', label: 'Code style', core: true, words: ['style', 'format', 'formatting', 'indent', 'indentation', 'spaces', 'tabs', 'lint', 'eslint', 'prettier', 'ruff', 'black', 'clang', 'naming', 'name', 'camelcase', 'snake_case', 'line', 'lines', 'length', 'characters', 'chars', 'readable', 'comment', 'comments', 'static', 'typescript', 'types', 'type'] },
  { id: 'git', label: 'Git & PRs', core: true, words: ['git', 'commit', 'commits', 'branch', 'main', 'master', 'merge', 'rebase', 'push', 'force', 'pr', 'pull', 'request', 'conventional', 'changelog', 'tag'] },
  { id: 'structure', label: 'Layout & architecture', core: true, words: ['lives', 'live', 'directory', 'folder', 'module', 'architecture', 'layer', 'structure', 'located', 'drivers', 'components', 'src', 'docs', 'protocol', 'legacy', 'deprecated', 'flow', 'file', 'files'] },
  { id: 'security', label: 'Security & secrets', core: true, words: ['secret', 'secrets', 'token', 'key', 'keys', 'password', 'credential', 'credentials', 'security', 'auth', 'provisioning', 'env', 'pii', 'log', 'encrypt', 'permission'] },
  { id: 'deps', label: 'Dependencies', core: false, words: ['dependency', 'dependencies', 'package', 'packages', 'lockfile', 'npm', 'pnpm', 'yarn', 'pip', 'uv', 'poetry', 'upgrade', 'version', 'versions'] },
  { id: 'workflow', label: 'Workflow', core: false, words: ['before', 'after', 'plan', 'ask', 'confirm', 'review', 'todo', 'check', 'verify', 'workflow', 'step', 'first', 'every'] },
  { id: 'comms', label: 'Communication', core: false, words: ['answer', 'respond', 'reply', 'explain', 'language', 'concise', 'tone', 'summary', 'summarize', 'turkish', 'english', 'user', 'verbose'] },
];

const STOP = new Set(('a an the and or but if then else of to in on at by for with from into onto as is are was were be been being it its this that these those there here '
  + 'you your we our they them their he she i me my not no do does did done doing have has had can could should would will shall may might must '
  + 'always never dont don\'t avoid use using used prefer only also just any all each every some more most less than so such very too via per etc eg ie '
  + 'when where which who whom what how why while until unless about over under up down out off again once both either neither nor own same other '
  + 'important critical').split(/\s+/));

const NEG = /\b(never|don['’]?t|do not|must not|mustn['’]?t|should not|shouldn['’]?t|avoid|forbidden|not allowed|no longer|stop|cannot|can['’]?t)\b|^\s*no\s/i;
const REASON = /\b(because|since|so that|so the|otherwise|to avoid|to keep|to prevent|in order to|as it|as they|which|reason|breaks?|would|causes?|leads? to|or else|due to|else)\b|[—–(:]|\s-\s/i;

const VAGUE = [
  [/\bproperly\b/i, 'properly', 'say what "properly" means here: the command, the limit or the pattern'],
  [/\bas needed\b|\bif needed\b|\bwhen needed\b|\bif necessary\b|\bwhere necessary\b/i, 'as needed', 'name the condition that makes it needed'],
  [/\bwhen appropriate\b|\bwhere appropriate\b|\bappropriate(ly)?\b/i, 'appropriate', 'say which cases qualify'],
  [/\bbe careful\b|\bcarefully\b|\btake care\b/i, 'be careful', 'say what to check or what breaks'],
  [/\breasonable\b|\bsensible\b/i, 'reasonable', 'give the number or the rule'],
  [/\bgood\b|\bnice\b|\bclean\b|\bbetter\b/i, 'good / clean', 'say what makes it good in this repo'],
  [/\bbest practices?\b/i, 'best practices', 'name the practice'],
  [/\betc\.?(?=\s|$)|\band so on\b/i, 'etc.', 'list the cases or drop the tail'],
  [/\btry to\b|\bideally\b|\bif possible\b/i, 'try to', 'make it a rule or drop it'],
  [/\bfragile\b|\btricky\b|\bweird\b/i, 'fragile', 'say what goes wrong and how to avoid it'],
  [/\bsome\b|\bvarious\b|\bcertain\b/i, 'some', 'name them'],
];
const SELF_EVIDENT = /\b(write (clean|good|readable|maintainable|high[- ]quality) code|follow (the )?best practices|be helpful|write bug[- ]free|don['’]?t write bugs|make sure (it|the code) works|use meaningful names|keep (the )?code clean|be (a )?senior)\b/i;
const EMPH = new Set(['IMPORTANT', 'MUST', 'NEVER', 'ALWAYS', 'CRITICAL', 'NOT', 'ALL', 'ANY', 'NO', 'DO', 'DON\'T', 'ONLY', 'REQUIRED', 'WARNING', 'YOU', 'SHOULD']);

const CLI = 'npm|pnpm|yarn|npx|bunx|bun|make|cmake|ctest|cargo|go|python3?|pip3?|pytest|uv|uvx|poetry|node|git|docker|kubectl|terraform|west|idf\\.py|gradle|\\./gradlew|mvn|dotnet|ruff|black|eslint|prettier|tsc|jest|vitest|openocd|pio|platformio|flutter|dart|xcodebuild|swift|rake|bundle|composer|deno|just';
// Tool names that are also English words: a command only with a known
// sub-command, a flag, or "run" before it ("go through", "make sure").
const AMBIG = { go: /^(build|test|run|mod|vet|generate|install|get|fmt|work)$/, make: /^(?!sure$|it$|the$|a$|an$|them$|changes?$|things?$|this$|that$|use$|no$|any$|small$|each$)[a-z][\w-]*$/, just: /^[a-z][\w-]*$/ , bundle: /^(install|exec|update)$/, black: /^[\w./-]+\.py$|^\.$/, swift: /^(build|test|run|package)$/, dart: /^(run|test|pub|format|analyze)$/, node: /^[\w./-]+\.(m?js|cjs|ts)$/, bun: /^(install|run|test|add|x)$/, rake: /^[a-z][\w:-]*$/, deno: /^(run|test|task|fmt|lint)$/ };
const ARGSTOP = new Set(['before', 'after', 'for', 'to', 'in', 'inside', 'then', 'and', 'with', 'when', 'on', 'every', 'from', 'the', 'a', 'an', 'if', 'or', 'first', 'once', 'as', 'is', 'are', 'it', 'not', 'only', 'at', 'of', 'this', 'that', 'so', 'but', 'while', 'until', 'instead', 'lockfile', 'locally', 'you', 'we', 'always', 'never']);
const CHOICE = [
  { id: 'package manager', alts: { npm: /\bnpm\b(?!\s*run\b)/i, pnpm: /\bpnpm\b/i, yarn: /\byarn\b/i, bun: /\bbun\b/i } },
  { id: 'Python tooling', alts: { pip: /\bpip3?\b/i, uv: /\buv\b/i, poetry: /\bpoetry\b/i, pipenv: /\bpipenv\b/i } },
  { id: 'test runner', alts: { jest: /\bjest\b/i, vitest: /\bvitest\b/i, mocha: /\bmocha\b/i } },
  { id: 'indentation', alts: { '2 spaces': /\b(2|two)[- ]spaces?\b/i, '4 spaces': /\b(4|four)[- ]spaces?\b/i, tabs: /\b(hard )?tabs\b(?! (?:to|and|or|for))/i } },
  { id: 'quotes', alts: { single: /\bsingle[- ]quotes?\b/i, double: /\bdouble[- ]quotes?\b/i } },
];
const COND = /\b(when|whenever|if|unless|except|only (for|in|when)|in the case of)\b/i;
const QUAL = /\b(c\+\+|c|python|py|ts|typescript|js|javascript|go|rust|kotlin|swift|java|yaml|json|markdown|makefiles?|html|css|scss|shell|bash|frontend|backend|firmware|web|server|tests?|headers?)\b/gi;

const SECRETS = [
  [/\bghp_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|\bgh[ousr]_[A-Za-z0-9]{30,}\b/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/, 'Anthropic API key'],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/, 'OpenAI-style API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/, 'JWT'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/i, 'password in a URL'],
  [/\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[A-Za-z0-9_\-+/]{12,}/i, 'assigned secret'],
];

// ---------------- helpers ----------------
/** A word-piece estimate of tokens: long words split into ~4-character
 *  pieces, numbers in groups of 3, each symbol one. Not a real tokenizer. */
export function estTokens(text) {
  let n = 0;
  for (const m of String(text).matchAll(/[\p{L}]+|\p{N}+|[^\s\p{L}\p{N}]/gu)) {
    const w = m[0];
    if (/^\p{L}+$/u.test(w)) n += w.length <= 6 ? 1 : Math.ceil(w.length / 4.5);
    else if (/^\p{N}+$/u.test(w)) n += Math.ceil(w.length / 3);
    else n += 1;
  }
  return n;
}
const SYN = { char: 'character', col: 'column', pkg: 'package', repo: 'repository', dir: 'directory', folder: 'directory', func: 'function', fn: 'function', deps: 'dependency', dep: 'dependency', config: 'configuration', cfg: 'configuration' };
const stem = (w) => {
  let x = w;
  if (x.length > 4 && x.endsWith('ies')) x = x.slice(0, -3) + 'y';
  else if (x.length > 3 && x.endsWith('s') && !x.endsWith('ss') && !x.endsWith('us')) x = x.slice(0, -1);
  if (x.length > 6 && x.endsWith('ing')) x = x.slice(0, -3);
  return SYN[x] || x;
};
export function words(text) {
  return String(text).toLowerCase().replace(/`[^`]*`/g, (m) => ' ' + m.slice(1, -1) + ' ')
    .split(/[^\p{L}\p{N}_+#.-]+/u).map((w) => w.replace(/^[.-]+|[.-]+$/g, '')).filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);
}
const jaccard = (a, b) => {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let k = 0; for (const x of A) if (B.has(x)) k++;
  return k / (A.size + B.size - k);
};
const shared = (a, b) => { const B = new Set(b); return [...new Set(a)].filter((x) => B.has(x)); };
const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
const short = (t, n = 70) => { const s = String(t).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
/** Ranges of `code` in a line, so checks can tell prose from code. */
function codeRanges(t) {
  const out = []; const re = /`+[^`]*`+/g; let m;
  while ((m = re.exec(t))) out.push([m.index, m.index + m[0].length]);
  return out;
}
const inRanges = (rs, s, e) => rs.some(([a, b]) => s >= a && e <= b);
/** Capitalised emphasis words back to normal case; sentence starts keep a capital. */
export function calm(t) {
  return String(t).replace(/^(\s*(?:[-*+]|\d+[.)])?\s*)(?:IMPORTANT|CRITICAL|NOTE|WARNING)\s*[:!-]\s*/i, '$1')
    .replace(/\b[A-Z][A-Z']{1,}\b/g, (w) => (EMPH.has(w) ? w.toLowerCase() : w))
    .replace(/(^\s*(?:[-*+]|\d+[.)])?\s*|[.!?:]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

// ---------------- parse ----------------
/** Rows: heading, rule (a bullet or a sentence line, with its continuation
 *  lines), text (a paragraph that is not a rule), code (a fenced block),
 *  import (an @path line), blank. */
export function parse(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const rows = [];
  let fence = null, section = '', level = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (fence) {
      fence.end = i; fence.text += '\n' + l;
      if (/^\s*(```|~~~)/.test(l)) fence = null;
      continue;
    }
    if (/^\s*(```|~~~)/.test(l)) { fence = { kind: 'code', line: i, end: i, text: l, section }; rows.push(fence); continue; }
    if (!l.trim()) { rows.push({ kind: 'blank', line: i, end: i, text: '' }); continue; }
    const hm = /^(#{1,6})\s+(.*)$/.exec(l);
    if (hm) { section = hm[2].trim(); level = hm[1].length; rows.push({ kind: 'heading', line: i, end: i, text: l, title: section, level }); continue; }
    if (/^\s*@\S+\s*$/.test(l)) { rows.push({ kind: 'import', line: i, end: i, text: l, section }); continue; }
    const bm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (bm) {
      const row = { kind: 'rule', line: i, end: i, text: l, body: bm[3], prefix: bm[1] + bm[2] + ' ', indent: bm[1].length, section };
      // Continuation: indented lines that are not bullets, headings or fences.
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1]) && !/^\s*(```|~~~)/.test(lines[i + 1])) {
        i++; row.end = i; row.text += '\n' + lines[i]; row.body += ' ' + lines[i].trim();
      }
      rows.push(row); continue;
    }
    // A prose line: a rule when it tells the reader to do something.
    const imperative = /^\s*(always|never|do|don['’]?t|use|run|prefer|keep|avoid|make|put|write|add|call|check|ask|answer|respond|reply|important|you must|must|note)\b/i.test(l) || NEG.test(l);
    rows.push({ kind: imperative ? 'rule' : 'text', line: i, end: i, text: l, body: l.trim(), prefix: '', indent: 0, section });
  }
  return { lines, rows, openFence: fence ? fence.line + 1 : 0 };
}

// ---------------- checks ----------------
function commandsIn(body) {
  const code = codeRanges(body);
  const out = [];
  const re = new RegExp(`(?<![\\w\`/.-])(?:${CLI})(?![\\w-])`, 'g');
  let m;
  while ((m = re.exec(body))) {
    const s = m.index;
    if (inRanges(code, s, s + 1)) continue;
    // Extend over arguments: flags, sub-commands, paths, && chains.
    const rest = body.slice(s + m[0].length);
    const toks = [...rest.matchAll(/\s+(\S+)/gy)];
    let len = m[0].length, args = 0;
    for (const t of toks) {
      const w = t[1].replace(/[.,;!?)]+$/, '');
      if (!w || ARGSTOP.has(w.toLowerCase()) || /^[A-Z][a-z]/.test(w) || /[`"]/.test(w)) break;
      if (!/^(--?[\w-]+(=\S+)?|&&|\|\||\||[\w./:@=+-]+)$/.test(w)) break;
      len += t[0].length - (t[1].length - w.length); args++;
      if (w !== t[1]) break;
    }
    const before = body.slice(Math.max(0, s - 12), s).toLowerCase();
    const verb = /\b(run|runs|execute|call|type|invoke)\s+$/.test(before);
    const tool = m[0].toLowerCase(), first = (toks[0]?.[1] || '').replace(/[.,;!?)]+$/, '');
    const english = AMBIG[tool];
    const ok = english ? verb || /^-/.test(first) || english.test(first) : args > 0 || verb;
    if (ok) out.push({ s, e: s + len, cmd: body.slice(s, s + len) });
    re.lastIndex = s + len;
  }
  return out;
}

const PATH_RE = /(?<![\w:/.@-])@?(?:~\/|\.{1,2}\/|\/)?(?:[\w.-]+\/)+[\w.-]*|(?<![\w/.@-])@?[\w-]+(?:\.[\w-]+)*\.(?:md|mdx|ts|tsx|js|jsx|mjs|cjs|py|c|h|cc|cpp|hpp|rs|go|kt|java|swift|json|ya?ml|toml|cfg|ini|sh|txt|lock|ld|dts|dtsi|cmake|env)\b/g;
const NOT_PATH = /^(and\/or|input\/output|n\/a|i\/o|tcp\/ip|km\/h|m\/s|read\/write|on\/off|yes\/no|true\/false|client\/server)$/i;
function pathsIn(body) {
  const out = [];
  for (const m of body.matchAll(PATH_RE)) {
    let p = m[0].replace(/[.,;:]+$/, '');
    if (!p || NOT_PATH.test(p) || /^\d/.test(p) || /:\/\//.test(body.slice(Math.max(0, m.index - 8), m.index + 3))) continue;
    if (!p.includes('/') && !/\.[a-z]+$/i.test(p)) continue;
    if (/^[\w-]+\/[\w-]+$/.test(p) && !/[._]/.test(p) && !/^(src|docs|test|tests|lib|web|app|server|firmware|scripts|tools)\//.test(p)) continue; // "feat/fix", "A/B"
    out.push({ s: m.index, e: m.index + p.length, path: p });
  }
  return out;
}

function choicesIn(body) {
  const res = [];
  for (const g of CHOICE) {
    const pos = new Set(), neg = new Set();
    for (const [alt, re] of Object.entries(g.alts)) {
      const r = new RegExp(re.source, 'gi');
      for (const m of body.matchAll(r)) {
        const before = body.slice(Math.max(0, m.index - 28), m.index).toLowerCase();
        if (/\b(not|never|no|don['’]?t|instead of|rather than|avoid|without|except|over)\s+(use\s+|run\s+|with\s+)?$/.test(before)
          || (NEG.test(body) && !/\b(use|prefer|always)\b/i.test(body))) neg.add(alt);
        else pos.add(alt);
      }
    }
    if (pos.size || neg.size) res.push({ group: g.id, pos: [...pos], neg: [...neg] });
  }
  return res;
}
const quals = (body) => new Set([...String(body).matchAll(QUAL)].map((m) => m[0].toLowerCase().replace(/^typescript$/, 'ts').replace(/^javascript$/, 'js').replace(/^python$/, 'py').replace(/s$/, '')));

function limitsIn(body) {
  const out = [];
  for (const m of body.matchAll(/\b(\d{1,4})\s*[- ]?\s*(characters?|chars?|columns?|cols?|lines?|words?)\b/gi)) {
    let unit = m[2].toLowerCase();
    unit = /^c(har|ol)/.test(unit) ? 'characters' : unit.startsWith('line') ? 'lines' : 'words';
    out.push({ n: Number(m[1]), unit });
  }
  return out;
}

function topicOf(row) {
  const ws = words(row.body || row.title || '');
  const sw = words(row.section || '');
  let best = null, score = 0;
  for (const t of TOPICS) {
    let sc = 0;
    for (const w of ws) if (t.words.includes(w)) sc += 1;
    for (const w of sw) if (t.words.includes(w) || t.label.toLowerCase().includes(w)) sc += 1.5;
    if (sc > score) { score = sc; best = t.id; }
  }
  return best || 'other';
}

function existsIn(list, p, base) {
  const clean = (x) => x.replace(/^@/, '').replace(/^\.\//, '').replace(/\/+$/, '');
  const cands = [clean(p)];
  if (base) cands.push(clean(base + '/' + clean(p)));
  for (const c of cands) {
    if (!c) return true;
    if (list.has(c)) return true;
    for (const f of list) if (f.startsWith(c + '/')) return true;
  }
  return false;
}

// ---------------- run ----------------
export function run(input) {
  const fileA = String(input.file ?? '');
  const fileB = String(input.second ?? '');
  const nameA = String(input.nameA || 'CLAUDE.md').trim() || 'CLAUDE.md';
  const nameB = String(input.nameB || 'nested/CLAUDE.md').trim() || 'nested/CLAUDE.md';
  const maxLines = Number.isFinite(input.maxLines) && input.maxLines > 0 ? Math.round(input.maxLines) : GUIDE.lines;
  const ignore = new Set(String(input.ignore || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean));
  const listText = String(input.paths || '');
  const pathList = new Set(listText.split(/\n+/).map((x) => x.trim().replace(/^\.\//, '').replace(/\/+$/, '')).filter((x) => x && !x.startsWith('#')));
  const warnings = [], notes = [];

  const files = [];
  const srcs = [[fileA, nameA], [fileB, nameB]].filter(([t], i) => i === 0 || t.trim());
  for (const [text, name] of srcs) {
    const p = parse(text);
    const base = name.includes('/') ? name.split('/').slice(0, -1).join('/') : '';
    files.push({ name, base, text, lines: p.lines, rows: p.rows });
    if (p.openFence) warnings.push(`${name}: the code fence opened on line ${p.openFence} is never closed, so everything after it reads as code and is not checked. Close it with \`\`\`.`);
  }

  const findings = [];
  const add = (fi, ri, sev, rule, msg, extra = {}) => {
    const row = files[fi].rows[ri];
    const key = `${rule}:${slug(row.body || row.text)}`;
    if (ignore.has(key) || ignore.has(rule)) return null;
    const f = { id: findings.length, file: fi, row: ri, line: row.line + 1, sev, rule, key, msg, ...extra };
    findings.push(f);
    return f;
  };

  // Per-row checks.
  const allRules = [];
  files.forEach((F, fi) => {
    F.rows.forEach((row, ri) => {
      row.tokens = estTokens(row.text);
      row.spans = [];
      if (row.kind === 'heading') { row.topic = topicOf({ title: row.title }); return; }
      if (row.kind === 'blank') return;
      const body = row.body ?? row.text;
      // Secrets anywhere, code blocks included.
      for (const [re, what] of SECRETS) {
        const m = re.exec(row.text);
        if (!m) continue;
        const redacted = row.text.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), (s) => (what === 'private key' ? s : `<${what.toUpperCase().replace(/[^A-Z]+/g, '_')}>`));
        const lineOff = row.text.indexOf(m[0]);
        const bodyOff = body.indexOf(m[0]);
        if (bodyOff >= 0) row.spans.push({ s: bodyOff, e: bodyOff + m[0].length, kind: 'secret' });
        add(fi, ri, 'bad', 'secret', `${what} in the file (${m[0].slice(0, 8)}…): remove it and rotate it.`,
          { fix: row.kind === 'code' || row.end > row.line ? null : { file: fi, line: row.line, text: redacted.split('\n')[0] }, at: lineOff });
        break;
      }
      if (row.kind === 'code' || row.kind === 'text' && !body) return;
      if (row.kind === 'import') {
        const p = body.trim().slice(1);
        row.spans.push({ s: 0, e: body.length, kind: 'path' });
        row.paths = [{ path: p, s: 1, e: body.trim().length }];
      }
      if (row.kind !== 'rule' && row.kind !== 'text' && row.kind !== 'import') return;
      row.topic = topicOf(row);
      // Paths.
      const ps = row.paths || pathsIn(body);
      row.paths = ps;
      for (const p of ps) {
        const st = /^\/|^~\//.test(p.path) ? 'abs' : pathList.size ? (existsIn(pathList, p.path, F.base) ? 'ok' : 'stale') : 'unchecked';
        p.state = st;
        if (row.kind !== 'import') row.spans.push({ s: p.s, e: p.e, kind: `path-${st}` });
        else row.spans[0].kind = `path-${st}`;
        if (st === 'stale') add(fi, ri, 'warn', 'stale-path', `${p.path} is not in the file list.`, { path: p.path });
        if (st === 'abs') add(fi, ri, 'info', 'absolute-path', `${p.path} is absolute: it exists on one machine only.`, { path: p.path });
      }
      if (row.kind === 'import') return;
      if (row.kind === 'text') return;
      allRules.push({ fi, ri, row, ws: words(body), neg: NEG.test(body), choices: choicesIn(body), limits: limitsIn(body), quals: quals(body) });

      // Commands without code formatting.
      const cmds = commandsIn(body);
      if (cmds.length) {
        for (const c of cmds) row.spans.push({ s: c.s, e: c.e, kind: 'cmd' });
        let fixed = body;
        for (const c of [...cmds].reverse()) fixed = fixed.slice(0, c.s) + '`' + c.cmd + '`' + fixed.slice(c.e);
        add(fi, ri, 'warn', 'unformatted-command', `Not in backticks: ${cmds.map((c) => c.cmd).join(', ')}.`,
          { fix: row.end === row.line ? { file: fi, line: row.line, text: row.prefix + fixed } : null });
      }
      // Self-evident filler, then vague words.
      const se = SELF_EVIDENT.exec(body);
      if (se) {
        row.spans.push({ s: se.index, e: se.index + se[0].length, kind: 'bloat' });
        add(fi, ri, 'warn', 'self-evident', `"${se[0]}" says nothing specific to this repo.`,
          { fix: { file: fi, line: row.line, end: row.end, text: null } });
      }
      const code = codeRanges(body);
      const vague = [];
      for (const [re, word, hint] of VAGUE) {
        const m = new RegExp(re.source, 'i').exec(body);
        if (!m || inRanges(code, m.index, m.index + m[0].length)) continue;
        if (se && m.index >= se.index && m.index < se.index + se[0].length) continue;
        row.spans.push({ s: m.index, e: m.index + m[0].length, kind: 'vague' });
        vague.push(`"${m[0]}" (${hint})`);
        void word;
      }
      if (vague.length) add(fi, ri, 'warn', 'vague', `Vague: ${vague.join('; ')}.`);
      // Shouting.
      const caps = [...body.matchAll(/\b[A-Z][A-Z']{1,}\b/g)].filter((m) => EMPH.has(m[0]));
      if (caps.length) {
        for (const m of caps) row.spans.push({ s: m.index, e: m.index + m[0].length, kind: 'caps' });
        row.caps = caps.length;
      }
      // Missing reason.
      const wc = body.split(/\s+/).filter(Boolean).length;
      if (row.caps == null && NEG.test(body) && !REASON.test(body.replace(/`[^`]*`/g, '')) && wc <= 16) {
        add(fi, ri, 'info', 'no-reason', 'A prohibition with no reason given.');
      }
      if (wc > 45) add(fi, ri, 'info', 'long-rule', `${wc} words in one rule.`);
    });
    // Headings with nothing under them.
    F.rows.forEach((row, ri) => {
      if (row.kind !== 'heading') return;
      let k = ri + 1, has = false;
      while (k < F.rows.length && !(F.rows[k].kind === 'heading' && F.rows[k].level <= row.level)) { if (!['blank', 'heading'].includes(F.rows[k].kind)) { has = true; break; } k++; }
      if (!has) add(fi, ri, 'info', 'empty-section', `"${row.title}" has no rules under it.`, { fix: { file: fi, line: row.line, end: row.end, text: null } });
    });
  });

  // Shouting overall.
  const shouted = allRules.filter((r) => r.row.caps);
  const capsWords = shouted.reduce((n, r) => n + r.row.caps, 0);
  if (shouted.length) {
    const many = shouted.length > 3 || shouted.some((r) => r.row.caps >= 3);
    for (const r of shouted) {
      const calmed = calm(r.row.body);
      add(r.fi, r.ri, many || r.row.caps >= 3 ? 'warn' : 'info', 'shouting',
        `${r.row.caps} capitalised emphasis word${r.row.caps > 1 ? 's' : ''}${shouted.length > 1 ? ` (${shouted.length} shouted rules in the files)` : ''}.`,
        { fix: r.row.end === r.row.line ? { file: r.fi, line: r.row.line, text: r.row.prefix + calmed } : null });
    }
  }

  // Choices (npm / pnpm / yarn, 2 / 4 spaces...): every rule that picks a
  // different option in one group, when their scopes overlap, is one clash.
  const where = (X) => `${files[X.fi].name}:${X.row.line + 1}`;
  const scopeOk = (X, Y) => !(X.quals.size && Y.quals.size && ![...X.quals].some((q) => Y.quals.has(q)));
  for (const g of CHOICE) {
    const picks = [];
    for (const R of allRules) {
      const c = R.choices.find((x) => x.group === g.id);
      if (!c) continue;
      const pos = c.pos.filter((x) => !c.neg.includes(x));
      picks.push({ R, pos, neg: c.neg });
    }
    for (const P of picks) {
      const against = picks.filter((Q) => Q !== P && scopeOk(P.R, Q.R) && (
        (P.pos.length === 1 && Q.pos.length === 1 && P.pos[0] !== Q.pos[0]) || P.pos.some((x) => Q.neg.includes(x)) || Q.pos.some((x) => P.neg.includes(x))));
      if (!against.length) continue;
      const mine = P.pos.length ? P.pos.join('/') : `not ${P.neg.join('/')}`;
      const others = against.map((Q) => `${Q.pos.length ? Q.pos.join('/') : 'not ' + Q.neg.join('/')} at ${where(Q.R)}`).join(', ');
      add(P.R.fi, P.R.ri, 'bad', 'contradiction', `${g.id}: ${mine} here; ${others}.`,
        { related: against.map((Q) => ({ file: Q.R.fi, line: Q.R.row.line + 1 })) });
    }
  }

  // Pairs: duplicates and contradictions (within and across files).
  const pairSeen = new Set();
  for (let a = 0; a < allRules.length; a++) {
    for (let b = a + 1; b < allRules.length; b++) {
      const A = allRules[a], B = allRules[b];
      const cross = A.fi !== B.fi;
      const normA = A.row.body.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), normB = B.row.body.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const j = jaccard(A.ws, B.ws);
      // Duplicates.
      if (normA === normB || (j >= 0.75 && A.neg === B.neg && A.ws.length >= 2)) {
        add(B.fi, B.ri, cross ? 'info' : 'warn', 'duplicate', cross
          ? `Repeats ${where(A)}; the nested file is read together with it.`
          : `Same as line ${A.row.line + 1}: "${short(A.row.body, 50)}".`,
          { related: [{ file: A.fi, line: A.row.line + 1 }], fix: { file: B.fi, line: B.row.line, end: B.row.end, text: null } });
        continue;
      }
      let clash = null;   // [text seen from A, text seen from B]
      // Same numeric limit, different numbers.
      for (const la of A.limits) {
        const lb = B.limits.find((x) => x.unit === la.unit && x.n !== la.n);
        if (!lb || !scopeOk(A, B)) continue;
        if (!shared(A.ws, B.ws).some((w) => la.unit === 'characters' || !/^(character|column|word|line)$/.test(w))) continue;
        const U = { characters: 'character limit', lines: 'line-count limit', words: 'word limit' }[la.unit];
        clash = [`${U}: ${la.n} here, ${lb.n} at ${where(B)}`, `${U}: ${lb.n} here, ${la.n} at ${where(A)}`]; break;
      }
      // Opposite polarity on the same thing.
      if (!clash && A.neg !== B.neg) {
        const sh = shared(A.ws, B.ws);
        if (sh.length >= 2 && j >= 0.34) {
          const t = `opposite rules about ${sh.slice(0, 3).join(', ')}`;
          clash = [`${t}: "${short(B.row.body, 60)}" at ${where(B)}`, `${t}: "${short(A.row.body, 60)}" at ${where(A)}`];
        }
      }
      if (clash) {
        const pk = `${A.fi}.${A.ri}-${B.fi}.${B.ri}`;
        if (pairSeen.has(pk)) continue; pairSeen.add(pk);
        const cond = COND.test(A.row.body) || COND.test(B.row.body);
        const pre = cond ? 'Possible conflict, one rule is conditional (make the exception explicit): ' : '';
        const sev = cond ? 'warn' : 'bad';
        const f1 = add(A.fi, A.ri, sev, 'contradiction', `${pre}${clash[0]}.`, { related: [{ file: B.fi, line: B.row.line + 1 }] });
        const f2 = add(B.fi, B.ri, sev, 'contradiction', `${pre}${clash[1]}.`, { related: [{ file: A.fi, line: A.row.line + 1 }] });
        if (f1 && f2) { f1.pair = f2.id; f2.pair = f1.id; }
      }
    }
  }

  // Size.
  const sizes = files.map((F) => ({
    name: F.name,
    lines: F.lines.length - (F.lines[F.lines.length - 1] === '' ? 1 : 0),
    tokens: estTokens(F.text),
    bytes: new TextEncoder().encode(F.text).length,
    rules: F.rows.filter((r) => r.kind === 'rule').length,
  }));
  sizes.forEach((s, fi) => {
    if (s.lines > maxLines) {
      const r0 = files[fi].rows.findIndex((r) => r.kind !== 'blank');
      if (r0 >= 0) add(fi, r0, 'warn', 'too-long', `${s.lines} lines against a target of ${maxLines}.`);
    }
    if (s.bytes > GUIDE.codexBytes && /agents\.md$/i.test(s.name)) warnings.push(`${s.name} is ${s.bytes} bytes; Codex reads at most 32 KiB of AGENTS.md by default (project_doc_max_bytes, verify) - the rest is silently cut.`);
  });

  // Topics.
  const topics = [...TOPICS.map((t) => ({ id: t.id, label: t.label, core: t.core })), { id: 'other', label: 'Other', core: false }].map((t) => {
    const rs = [];
    files.forEach((F, fi) => F.rows.forEach((r, ri) => { if ((r.kind === 'rule') && r.topic === t.id) rs.push([fi, ri]); }));
    const tokens = rs.reduce((n, [fi, ri]) => n + files[fi].rows[ri].tokens, 0);
    return { ...t, count: rs.length, tokens, rows: rs, gap: t.core && !rs.length };
  });
  const gaps = topics.filter((t) => t.gap).map((t) => t.label);

  // Link finding ids to rows.
  for (const f of findings) (files[f.file].rows[f.row].finds ||= []).push(f.id);

  // ---------- tightened copy ----------
  const tightened = files.map((F, fi) => tighten(F, fi, findings));

  // ---------- result ----------
  const sevN = (s) => findings.filter((f) => f.sev === s).length;
  const totalTok = sizes.reduce((n, s) => n + s.tokens, 0);
  const values = [
    { label: `${sizes[0].name} length`, value: `${sizes[0].lines} lines`, hint: `target ≤ ${maxLines} (verify)`, tone: sizes[0].lines > maxLines ? 'warn' : 'ok' },
    { label: 'Tokens (estimate)', value: totalTok, unit: 'tok', hint: files.length > 1 ? sizes.map((s) => `${s.name} ${s.tokens}`).join(' + ') : 'word-piece estimate, ±15%' },
    { label: 'Rules', value: sizes.reduce((n, s) => n + s.rules, 0), hint: `${files.length} file${files.length > 1 ? 's' : ''}` },
    { label: 'Rules in conflict', value: findings.filter((f) => f.rule === 'contradiction').length, tone: findings.some((f) => f.rule === 'contradiction') ? 'bad' : 'ok' },
    { label: 'Findings', value: `${sevN('bad')} bad · ${sevN('warn')} warn · ${sevN('info')} info`, tone: sevN('bad') ? 'bad' : sevN('warn') ? 'warn' : 'ok' },
    { label: 'Topic gaps', value: gaps.length ? gaps.join(', ') : 'none', tone: gaps.length ? 'warn' : 'ok' },
    { label: 'Tightened', value: `${tightened[0].tokens} tok`, hint: `${sizes[0].tokens - tightened[0].tokens >= 0 ? `${sizes[0].tokens - tightened[0].tokens} fewer` : `${tightened[0].tokens - sizes[0].tokens} more`} than ${sizes[0].name}${tightened[0].conflicts ? `; ${tightened[0].conflicts} conflicts marked` : ''}` },
  ];
  const ord = { bad: 0, warn: 1, info: 2 };
  const sorted = [...findings].sort((x, y) => ord[x.sev] - ord[y.sev] || x.file - y.file || x.line - y.line);
  const tables = [
    { title: 'Findings', columns: ['Severity', 'File:line', 'Check', 'Finding'], rows: sorted.slice(0, 40).map((f) => [f.sev, `${files[f.file].name}:${f.line}`, f.rule, f.msg]) },
    { title: 'Topic coverage', columns: ['Topic', 'Rules', 'Tokens', 'Status'], rows: topics.filter((t) => t.count || t.core).map((t) => [t.label, t.count, t.tokens, t.gap ? 'gap' : t.core ? 'covered' : 'extra']) },
  ];
  if (sorted.length > 40) notes.push(`${sorted.length - 40} more findings are on the page (the table shows the first 40 by severity).`);
  const bad = findings.filter((f) => f.sev === 'bad');
  if (bad.length) warnings.push(...bad.slice(0, 6).map((f) => `${files[f.file].name}:${f.line} ${f.rule === 'contradiction' ? 'contradiction' : f.rule}: ${f.msg} ${f === bad.find((x) => x.rule === f.rule) ? ADVICE[f.rule] : ''}`.trim()));
  if (gaps.length) warnings.push(`No rules about ${gaps.join(', ')}. If the agent has to guess these (the test command, where code goes), add one concrete line each.`);
  if (!fileA.trim()) warnings.push('The file is empty: paste a CLAUDE.md or AGENTS.md.');
  if (listText.trim() && !pathList.size) warnings.push('The file list has no usable lines: paste one path per line (git ls-files output works).');
  if (!pathList.size) notes.push('Paths were not checked for existence: paste a file list (git ls-files, or find . -type f) to find stale ones.');
  notes.push(`Guidance as of ${AS_OF} from the Claude Code memory and best-practice docs and the agents.md / Codex docs; the ${maxLines}-line target and the 32 KiB Codex limit must be checked against those pages.`);
  notes.push('Tokens are a word-piece estimate (roughly ±15%), not an exact tokenizer. Contradiction and vagueness checks are heuristics: read each finding before acting on it.');

  const texts = [
    { title: `Tightened ${files[0].name}`, body: tightened[0].text, lang: 'markdown' },
    ...(files[1] ? [{ title: `Tightened ${files[1].name}`, body: tightened[1].text, lang: 'markdown' }] : []),
    { title: 'Findings', body: sorted.length ? sorted.map((f) => `- [${f.sev}] ${files[f.file].name}:${f.line} ${f.rule}: ${f.msg}`).join('\n')
      + '\n\nWhy these matter:\n' + [...new Set(sorted.map((f) => f.rule))].map((r) => `- ${r}: ${ADVICE[r] || ''}`).join('\n') + '\n' : 'No findings.\n', lang: 'markdown' },
  ];

  const lint = {
    files: files.map((F, fi) => ({ name: F.name, base: F.base, ...sizes[fi], text: F.text,
      rows: F.rows.map((r) => ({ kind: r.kind, line: r.line, end: r.end, text: r.text, body: r.body ?? null, prefix: r.prefix ?? '', title: r.title ?? null, level: r.level ?? 0,
        section: r.section ?? '', topic: r.topic ?? null, tokens: r.tokens || 0, spans: (r.spans || []).sort((a, b) => a.s - b.s), finds: r.finds || [], paths: r.paths || [] })) })),
    findings, topics, maxLines, advice: ADVICE, tightened: tightened.map((t) => ({ tokens: t.tokens, lines: t.lines })), pathsChecked: pathList.size,
  };
  return { values, tables, texts, warnings, notes, lint };
}

/** The file again with each mechanical fix applied, duplicates and filler
 *  dropped, headings of the same name merged, and blank lines normalised.
 *  Contradictions stay (a person has to choose) with a comment beside them. */
function tighten(F, fi, findings) {
  const edits = new Map();   // line -> text | null
  const drop = new Set();
  const conflict = new Map();
  for (const f of findings) {
    if (f.file !== fi) continue;
    if (f.rule === 'contradiction') {
      const L = F.rows[f.row].line, list = conflict.get(L) || [];
      for (const r of f.related || []) { const t = r.file !== fi ? `${r.file ? 'nested' : 'root'} file line ${r.line}` : `line ${r.line}`; if (!list.includes(t)) list.push(t); }
      conflict.set(L, list); continue;
    }
    if (!f.fix || f.rule === 'too-long') continue;
    if (f.fix.text === null) { for (let l = f.fix.line; l <= (f.fix.end ?? f.fix.line); l++) drop.add(l); continue; }
    // Several fixes on one line: apply them in turn to the fixed text.
    const cur = edits.get(f.fix.line);
    if (cur == null) edits.set(f.fix.line, f.fix.text);
    else if (f.rule === 'shouting') edits.set(f.fix.line, calm(cur));
    else if (f.rule === 'unformatted-command') {
      let t = cur; const row = F.rows[f.row];
      for (const c of commandsIn(t.slice(row.prefix.length)).reverse()) { const s = c.s + row.prefix.length; t = t.slice(0, s) + '`' + c.cmd + '`' + t.slice(c.e + row.prefix.length); }
      edits.set(f.fix.line, t);
    }
  }
  // Group rows into sections; merge sections with the same heading text.
  const sections = [];
  let cur = { head: null, key: '', body: [] };
  sections.push(cur);
  for (const r of F.rows) {
    if (r.kind === 'heading') {
      if (drop.has(r.line)) continue;
      const key = `${r.level}:${r.title.toLowerCase()}`;
      const found = sections.find((s) => s.key === key);
      if (found) { cur = found; continue; }
      cur = { head: r.text.replace(/\s+$/, ''), key, body: [] }; sections.push(cur); continue;
    }
    if (r.kind === 'blank') { cur.body.push(''); continue; }
    if (drop.has(r.line)) continue;
    const out = [];
    for (let l = r.line; l <= r.end; l++) {
      if (drop.has(l)) continue;
      let t = edits.has(l) ? edits.get(l) : F.lines[l];
      if (r.kind !== 'code') t = t.replace(/\s+$/, '');
      out.push(t);
    }
    if (conflict.has(r.line)) out[out.length - 1] += ` <!-- conflict: ${conflict.get(r.line).join(', ')} -->`;
    cur.body.push(...out);
  }
  const lines = [];
  for (const s of sections) {
    const body = [];
    for (const l of s.body) { if (l === '' && (body.length === 0 || body[body.length - 1] === '')) continue; body.push(l); }
    // No blank lines between bullets of one list.
    const tight = body.filter((l, i) => !(l === '' && /^\s*([-*+]|\d+[.)])\s/.test(body[i - 1] || '') && /^\s*([-*+]|\d+[.)])\s/.test(body[i + 1] || '')));
    while (tight.length && tight[tight.length - 1] === '') tight.pop();
    if (!s.head && !tight.length) continue;
    if (lines.length) lines.push('');
    if (s.head) { lines.push(s.head); if (tight.length) lines.push(''); }
    lines.push(...tight);
  }
  const text = lines.join('\n') + '\n';
  return { text, tokens: estTokens(text.replace(/ <!-- conflict: [^>]*-->/g, '')), lines: lines.length, conflicts: conflict.size };
}

/** Apply one finding's fix to a file's text; the page uses it. */
export function applyFix(text, fix) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (!fix || fix.line == null || fix.line >= lines.length) return text;
  if (fix.text === null) lines.splice(fix.line, (fix.end ?? fix.line) - fix.line + 1);
  else lines[fix.line] = fix.text;
  return lines.join('\n');
}
