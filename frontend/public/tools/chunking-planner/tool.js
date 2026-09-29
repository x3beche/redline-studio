// Chunking Planner: a document split into chunks for embedding / retrieval,
// by fixed token windows, a recursive separator splitter, Markdown headings,
// sentences or code definitions, with the size limit and overlap applied, each
// chunk's place in the text, header path and token estimate, the problems a
// retriever will trip on, the chunks as JSONL and an embedding cost estimate.
//
// Pure: no DOM. The page draws everything from run()'s result (view is agentOmit).
//
// Token counts are ESTIMATES, not a real tokenizer: the text is pre-split the
// way BPE tokenizers pre-split (words with their leading space, runs of up to
// 3 digits, punctuation runs, whitespace runs - the pattern documented for
// OpenAI's cl100k_base in the tiktoken source), and each piece is costed:
// a word of up to 8 letters = 1 token, longer words 1 per ~5 letters, a
// digit run = 1, punctuation 1 per 3 characters, a newline run 0.5, any
// non-ASCII character 1. Calibrated against exact cl100k_base counts (BPE over
// the published rank file) on Markdown, code, JSON and CSS samples: mean
// absolute error about 5%, worst about 15% on 600-character pieces.
//
// Strategies (described in their own terms; the behaviour follows the public
// documentation of LangChain's text splitters, rewritten here):
//   tokens     fixed windows of `size` tokens; the next window starts `overlap` tokens back.
//   recursive  split on the first separator present, recurse into pieces still too big with the
//              next separators, then merge neighbours up to `size`, carrying `overlap` of whole
//              pieces into the next chunk (RecursiveCharacterTextSplitter semantics).
//   headings   one chunk per Markdown ATX heading section (CommonMark §4.2), header path kept as
//              metadata; sections over `size` are split recursively inside the section.
//   sentences  sentences packed up to `size`, code blocks and tables kept whole, overlap in whole sentences.
//   code       top-level definitions (def/class/function/fn/struct/...) packed up to `size`.

const DEF_TEXT = `# Bootloader update guide

This guide covers updating the field bootloader on the SB-40 sensor bridge. Read it completely before touching a unit in the field: a failed bootloader write leaves the board unable to start, and recovery needs the SWD header, which is under the potting on revision C boards.

## Before you start

You need a USB-C cable, the \`sbtool\` CLI version 2.4 or newer, and a charged battery (above 3.7 V). The update takes about 40 seconds. Do not update while the unit is logging; stop the logger first with \`sbtool log stop\`.

Check the current version with \`sbtool info\`. Units shipped before March 2025 run bootloader 1.x and must go to 2.0 first; skipping straight to 2.2 is refused by the image header check.

## Update procedure

### 1. Put the unit in DFU mode

Hold the SET button, then plug in USB. The status LED blinks amber twice per second when the bootloader is waiting. If it stays solid green, the application started instead: unplug and try again, holding SET longer.

### 2. Write the new image

\`\`\`sh
sbtool dfu list
sbtool dfu write --slot boot --verify sb40-boot-2.2.0.bin
sbtool dfu reset
\`\`\`

The write erases sector 0 first. If power drops between the erase and the end of the write, the unit will not boot. The \`--verify\` flag reads the image back and compares its CRC-32 before the reset.

### 3. Confirm

After the reset the LED blinks green once. Run \`sbtool info\` again and check that the bootloader field reads 2.2.0 and the image CRC matches the release notes.

## Error codes

| Code | Meaning | What to do |
|------|---------|------------|
| E10 | Image header invalid | Download the image again; check the SHA-256 |
| E11 | Version step not allowed | Update to 2.0 first |
| E20 | Flash erase failed | Retry once; if it repeats, return the unit |
| E21 | Verify mismatch | Retry the write; do not reset |
| E30 | Battery too low | Charge above 3.7 V |

## Recovery over SWD

When the unit no longer enumerates over USB, the bootloader is damaged. Remove the potting over the SWD header (revision C) or use the test pads (revision D). Connect a probe and write the factory image:

\`\`\`sh
openocd -f interface/stlink.cfg -f target/stm32l4x.cfg \\
  -c "program sb40-factory-2.2.0.hex verify reset exit"
\`\`\`

After recovery the unit has factory calibration only. Run the calibration step from the service manual before returning it to the field.
`;

// ---------------------------------------------------------------- tokens (estimate)
const PRE = /'(?:s|t|re|ve|m|ll|d)\b| ?[A-Za-z]+| ?\d{1,3}| ?[^\sA-Za-z\d]+|\s+(?!\S)|\s+/g;

function pieceTokens(p) {
  let t = 0;
  let ascii = '';
  for (const ch of p) { if (ch.charCodeAt(0) > 127) t += 1; else ascii += ch; }
  const a = ascii.replace(/^ /, '');
  if (!a) return Math.max(t, ascii ? 1 : 0);
  if (/^[A-Za-z]+$/.test(a)) return t + (a.length <= 8 ? 1 : Math.ceil(a.length / 5));
  if (/^\d+$/.test(a)) return t + 1;
  if (/^\s+$/.test(a)) return t + (/\n/.test(a) ? 0.5 : Math.ceil(a.length / 8));
  if (/^'/.test(a)) return t + 1;
  return t + Math.ceil(a.length / 3);
}

/** Pieces with their offsets and estimated token counts. */
export function pieces(text, base = 0) {
  const out = [];
  PRE.lastIndex = 0;
  let m;
  while ((m = PRE.exec(text))) {
    if (!m[0]) { PRE.lastIndex++; continue; }
    out.push({ s: base + m.index, e: base + m.index + m[0].length, t: pieceTokens(m[0]) });
  }
  return out;
}
export const estimateTokens = (text) => Math.round(pieces(text).reduce((a, p) => a + p.t, 0));

// ---------------------------------------------------------------- structure
function structure(text) {
  const lines = [];
  let pos = 0;
  for (const l of text.split('\n')) { lines.push({ s: pos, e: pos + l.length, text: l }); pos += l.length + 1; }
  const fences = [], tables = [], headings = [];
  let inFence = null;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(L.text);
    if (inFence) {
      if (f && f[1][0] === inFence.ch && f[1].length >= inFence.len && !/\S/.test(L.text.slice(f[0].length))) { fences.push({ s: inFence.s, e: L.e, line: inFence.line }); inFence = null; }
      continue;
    }
    if (f) { inFence = { s: L.s, ch: f[1][0], len: f[1].length, line: i + 1 }; continue; }
    const hm = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(L.text);
    if (hm) { headings.push({ s: L.s, e: L.e, level: hm[1].length, title: hm[2].trim(), line: i + 1 }); continue; }
    if (/^\s*\|.*\|\s*$/.test(L.text)) {
      let j = i;
      while (j + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[j + 1].text)) j++;
      if (j > i) tables.push({ s: L.s, e: lines[j].e, line: i + 1 });
      i = j;
    }
  }
  if (inFence) fences.push({ s: inFence.s, e: text.length, line: inFence.line, open: true });
  return { lines, fences, tables, headings };
}

function headerPath(headings, pos) {
  const stack = [];
  for (const h of headings) {
    if (h.s > pos) break;
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push(h);
  }
  return stack.map((h) => h.title);
}

// ---------------------------------------------------------------- splitters
function makeMeasure(text, unit) {
  if (unit === 'chars') return (s, e) => e - s;
  const cache = new Map();
  return (s, e) => {
    const k = s * 1e7 + e;
    if (!cache.has(k)) cache.set(k, estimateTokens(text.slice(s, e)));
    return cache.get(k);
  };
}

/** Greedy merge of consecutive atoms [s,e) up to size, the next chunk starting with trailing atoms worth <= overlap. */
function merge(atoms, size, overlap, measure) {
  const chunks = [];
  let i = 0;
  while (i < atoms.length) {
    let j = i;
    let e = atoms[i].e;
    while (j + 1 < atoms.length && measure(atoms[i].s, atoms[j + 1].e) <= size) { j++; e = atoms[j].e; }
    chunks.push({ s: atoms[i].s, e });
    if (j + 1 >= atoms.length) break;
    // step back over whole atoms while the carried-over part stays within the overlap
    let k = j + 1;
    if (overlap > 0) while (k - 1 > i && measure(atoms[k - 1].s, atoms[j].e) <= overlap) k--;
    i = k;
  }
  return chunks;
}

/** Hard windows over the token pieces (or characters). */
function windows(text, s0, e0, size, overlap, unit) {
  const out = [];
  if (unit === 'chars') {
    const step = Math.max(1, size - overlap);
    for (let s = s0; s < e0; s += step) { out.push({ s, e: Math.min(e0, s + size) }); if (s + size >= e0) break; }
    return out;
  }
  // a single piece longer than the window (a 300-letter hash, a base64 blob) is cut by characters
  const ps = [];
  for (const p of pieces(text.slice(s0, e0), s0)) {
    if (p.t <= size) { ps.push(p); continue; }
    const per = Math.max(1, Math.floor(((p.e - p.s) * size) / p.t));
    for (let a = p.s; a < p.e; a += per) { const e = Math.min(p.e, a + per); ps.push({ s: a, e, t: (p.t * (e - a)) / (p.e - p.s) }); }
  }
  let i = 0;
  while (i < ps.length) {
    let t = 0, j = i;
    while (j < ps.length && (t + ps[j].t <= size || j === i)) { t += ps[j].t; j++; }
    out.push({ s: ps[i].s, e: ps[j - 1].e });
    if (j >= ps.length) break;
    let back = 0, k = j;
    while (k - 1 > i && back + ps[k - 1].t <= overlap) { back += ps[k - 1].t; k--; }
    i = k;
  }
  return out;
}

/** Atoms no bigger than size: split on the first separator present, recurse with the rest. */
function atomsOf(text, s, e, seps, size, measure, unit) {
  if (measure(s, e) <= size) return [{ s, e }];
  const k = seps.findIndex((sep) => sep && text.slice(s, e).includes(sep));
  if (k < 0) return windows(text, s, e, size, 0, unit);
  const sep = seps[k];
  const rest = seps.slice(k + 1);
  const parts = [];
  let a = s;
  for (;;) {
    const at = text.indexOf(sep, a);
    if (at < 0 || at >= e) { if (a < e) parts.push({ s: a, e }); break; }
    parts.push({ s: a, e: at + sep.length }); // the separator stays with the piece before it
    a = at + sep.length;
  }
  const out = [];
  for (const p of parts) {
    if (measure(p.s, p.e) <= size) out.push(p);
    else out.push(...atomsOf(text, p.s, p.e, rest, size, measure, unit));
  }
  return out;
}

const SENT_ABBR = /\b(?:e\.g|i\.e|etc|vs|Fig|fig|No|Rev|rev|approx|Dr|Mr|Ms|Inc|Ltd|cf|al)\.$/;
function sentenceAtoms(text, s0, e0, st) {
  // whole code blocks and tables are single atoms; the rest splits at sentence ends and blank lines
  const blocks = [...st.fences, ...st.tables].filter((b) => b.e > s0 && b.s < e0).sort((a, b) => a.s - b.s);
  const atoms = [];
  const prose = (a, b) => {
    const re = /[.!?](?=["')\]]*\s+(?:[A-Z0-9"'(`[]|$))|\n\s*\n|\n(?=\s*(?:[-*+]|\d+\.)\s)/g;
    re.lastIndex = a;
    let start = a, m;
    const seg = text.slice(0, b);
    while ((m = re.exec(seg))) {
      const end = m.index + m[0].length;
      if (m[0] === '.' && SENT_ABBR.test(text.slice(Math.max(start, m.index - 8), m.index + 1))) continue;
      if (m[0] === '.' && /\d$/.test(text.slice(m.index - 1, m.index)) && /^\d/.test(text.slice(end, end + 1))) continue;
      let stop = end;
      while (stop < b && /[ \t"')\]]/.test(text[stop])) stop++;
      if (stop > start) atoms.push({ s: start, e: stop });
      start = stop;
    }
    if (start < b) atoms.push({ s: start, e: b });
  };
  let at = s0;
  for (const bl of blocks) {
    if (bl.s > at) prose(at, bl.s);
    atoms.push({ s: Math.max(bl.s, s0), e: Math.min(bl.e, e0), block: true });
    at = Math.min(bl.e, e0);
  }
  if (at < e0) prose(at, e0);
  return atoms.filter((x) => /\S/.test(text.slice(x.s, x.e)));
}

const DEF_LINE = /^(?:@\w|(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:def|class|function|interface|enum|struct|type|impl|trait|module|func|fn)\b|pub(?:\([^)]*\))?\s+(?:fn|struct|enum|trait|mod|const|static)\b|(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?\(|(?:static\s+|inline\s+|extern\s+)*(?:const\s+)?(?:void|int|unsigned|uint\d+_t|int\d+_t|bool|char|float|double|size_t|[A-Z]\w*_t|struct\s+\w+\s*\*?)\s*\**\s*\w+\s*\(|#define\s+\w+\()/;
function codeAtoms(text, st) {
  const starts = [0];
  const L = st.lines;
  for (let i = 1; i < L.length; i++) {
    if (!DEF_LINE.test(L[i].text)) continue;
    // take the comment / decorator lines right above with the definition
    let k = i;
    while (k - 1 > 0 && /^(?:\s*(?:\/\/|#(?!define|include)|\*|\/\*|@)|\s*$)/.test(L[k - 1].text) && !/^\s*$/.test(L[k - 1].text)) k--;
    if (L[k].s > starts[starts.length - 1]) starts.push(L[k].s);
  }
  const atoms = starts.map((s, i) => ({ s, e: i + 1 < starts.length ? starts[i + 1] : text.length }));
  return { atoms, defs: starts.length - 1 };
}

function trimRange(text, c) {
  let { s, e } = c;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return { ...c, s, e };
}

// ---------------------------------------------------------------- run
const decodeSep = (x) => x.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\s|␠/g, ' ');
export function parseSeparators(raw) {
  const src = String(raw ?? '');
  if (!src.trim()) return ['\n\n', '\n', '. ', ' '];
  return src.split('|').map(decodeSep).filter((x) => x !== '');
}
const showSep = (x) => JSON.stringify(x);

export function run(input = {}) {
  const text = String(input.text ?? DEF_TEXT).replace(/\r\n?/g, '\n');
  const strategy = ['tokens', 'recursive', 'headings', 'sentences', 'code'].includes(input.strategy) ? input.strategy : 'recursive';
  const unit = input.unit === 'chars' ? 'chars' : 'tokens';
  const warnings = [], notes = [];
  let size = Number.isFinite(input.size) ? Math.round(input.size) : 200;
  let overlap = Number.isFinite(input.overlap) ? Math.round(input.overlap) : 0;
  if (size < 1) { warnings.push(`Chunk size ${size} is not usable; 1 is used. Pick the size your embedding model and retriever want (a few hundred tokens is common).`); size = 1; }
  if (overlap < 0) { warnings.push('Overlap below 0; 0 is used.'); overlap = 0; }
  if (overlap >= size) { warnings.push(`Overlap ${overlap} is not smaller than the size ${size}: every chunk would repeat the one before. It is capped at half the size (${Math.floor(size / 2)}).`); overlap = Math.floor(size / 2); }
  else if (overlap > size / 2) warnings.push(`Overlap ${overlap} is more than half the size ${size}: most of each chunk is repeated in the next, so the index grows and results repeat. 10-20% of the size is the usual range.`);
  const price = Number.isFinite(input.price) && input.price >= 0 ? input.price : 0;
  const seps = parseSeparators(input.separators);
  const measure = makeMeasure(text, unit);
  const st = structure(text);
  const docTokens = estimateTokens(text);

  if (!text.trim()) {
    return { values: [{ label: 'Chunks', value: 0 }], warnings: ['The document is empty: paste the text to chunk.'], notes: [],
      view: { chunks: [], fences: [], tables: [], headings: [], size, overlap, unit, strategy, seps, docTokens: 0, textLen: 0 } };
  }

  // 1. the chunks
  let raw = [];
  let codeDefs = 0;
  if (strategy === 'tokens') raw = windows(text, 0, text.length, size, overlap, unit);
  else if (strategy === 'recursive') raw = merge(atomsOf(text, 0, text.length, seps, size, measure, unit), size, overlap, measure);
  else if (strategy === 'sentences') {
    const atoms = [];
    for (const a of sentenceAtoms(text, 0, text.length, st)) {
      if (measure(a.s, a.e) > size && !a.block) atoms.push(...atomsOf(text, a.s, a.e, [', ', ' '], size, measure, unit));
      else atoms.push(a);
    }
    raw = merge(atoms, size, overlap, measure);
  } else if (strategy === 'headings') {
    const cuts = [0, ...st.headings.map((h) => h.s).filter((x) => x > 0), text.length];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const s = cuts[i], e = cuts[i + 1];
      if (!/\S/.test(text.slice(s, e))) continue;
      if (measure(s, e) <= size) raw.push({ s, e });
      else raw.push(...merge(atomsOf(text, s, e, seps, size, measure, unit), size, overlap, measure));
    }
  } else {
    const { atoms, defs } = codeAtoms(text, st);
    codeDefs = defs;
    const small = [];
    for (const a of atoms) small.push(...(measure(a.s, a.e) <= size ? [a] : atomsOf(text, a.s, a.e, ['\n\n', '\n'], size, measure, unit)));
    raw = merge(small, size, overlap, measure);
    if (!defs) warnings.push('No top-level definitions (def, class, function, fn, struct…) were found: the code strategy fell back to blank lines. Is this code?');
  }
  let chunks = raw.map((c) => trimRange(text, c)).filter((c) => c.e > c.s);
  // drop exact repeats (a window that only re-covers overlap)
  chunks = chunks.filter((c, i) => i === 0 || !(c.s >= chunks[i - 1].s && c.e <= chunks[i - 1].e));
  if (chunks.length > 5000) { warnings.push(`${chunks.length} chunks: only the first 5000 are kept. Raise the size.`); chunks = chunks.slice(0, 5000); }

  // 2. per chunk
  const lineOf = (pos) => { let lo = 0, hi = st.lines.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (st.lines[m].s <= pos) lo = m; else hi = m - 1; } return lo + 1; };
  const keep = !!input.keep_headers;
  const out = chunks.map((c, i) => {
    const body = text.slice(c.s, c.e);
    const tokens = estimateTokens(body);
    const path = headerPath(st.headings, c.s);
    const prefix = keep && path.length ? path.join(' > ') + '\n\n' : '';
    const w = [];
    for (const [list, what] of [[st.fences, 'code block'], [st.tables, 'table']]) {
      for (const b of list) {
        if (b.s < c.s && c.s < b.e) w.push({ kind: 'cut', what, at: c.s, msg: `starts inside the ${what} at line ${b.line}` });
        if (b.s < c.e && c.e < b.e) w.push({ kind: 'cut', what, at: c.e, msg: `ends inside the ${what} at line ${b.line}` });
      }
    }
    const nonHeading = body.split('\n').filter((l) => /\S/.test(l) && !/^ {0,3}#{1,6}\s/.test(l));
    if (!nonHeading.length) w.push({ kind: 'heading', msg: 'holds only a heading: nothing to retrieve' });
    const m = measure(c.s, c.e);
    if (m > size * 1.02) w.push({ kind: 'over', msg: `is ${m} ${unit}, over the size ${size}: one piece (a sentence, code block, table or unbroken run) could not be split further` });
    return { i: i + 1, s: c.s, e: c.e, line: lineOf(c.s), endLine: lineOf(Math.max(c.s, c.e - 1)), tokens, chars: c.e - c.s, m, path, prefixTokens: prefix ? estimateTokens(prefix) : 0, warn: w };
  });
  if (out.length > 1) {
    const last = out[out.length - 1];
    if (last.m < size * 0.25) last.warn.push({ kind: 'tail', msg: `is a tiny tail (${last.m} ${unit}, under 25% of the size): merge it into the previous chunk or lower the size` });
  }
  for (let k = 1; k < out.length; k++) {
    const prev = out[k - 1], cur = out[k];
    cur.ov = cur.s < prev.e ? prev.e - cur.s : 0;
  }
  out[0].ov = 0;

  // 3. totals
  const embedded = out.reduce((a, c) => a + c.tokens + c.prefixTokens, 0);
  const sizes = out.map((c) => c.m);
  const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const cost = (embedded * price) / 1e6;
  const overhead = docTokens ? (embedded - docTokens) / docTokens * 100 : 0;
  const cuts = out.filter((c) => c.warn.some((w) => w.kind === 'cut'));
  const heads = out.filter((c) => c.warn.some((w) => w.kind === 'heading'));
  const overs = out.filter((c) => c.warn.some((w) => w.kind === 'over'));
  if (cuts.length) warnings.push(`${cuts.length} chunk${cuts.length > 1 ? 's' : ''} (${cuts.slice(0, 6).map((c) => '#' + c.i).join(', ')}) cut through a code block or a table: the halves lose their meaning. Use the headings or sentences strategy, or raise the size above the block.`);
  if (heads.length) warnings.push(`${heads.length} heading-only chunk${heads.length > 1 ? 's' : ''} (${heads.slice(0, 6).map((c) => '#' + c.i).join(', ')}): nothing to retrieve. Merge a heading with its section (a larger size, or the headings strategy).`);
  if (overs.length) warnings.push(`${overs.length} chunk${overs.length > 1 ? 's are' : ' is'} over the size limit (${overs.slice(0, 6).map((c) => '#' + c.i).join(', ')}): a piece that the strategy keeps whole is bigger than the size. Raise the size, add a separator, or use fixed token windows.`);
  const tail = out.length > 1 && out[out.length - 1].warn.find((w) => w.kind === 'tail');
  if (tail) warnings.push(`The last chunk #${out.length} ${tail.msg}.`);
  if (size < 16 && unit === 'tokens') warnings.push(`Chunks of ${size} tokens carry almost no meaning each; 100-500 tokens is the common range for retrieval.`);
  notes.push(`Token counts are estimates (BPE-style pre-split, costed per piece), about 5% off exact cl100k counts on average, up to ~15% on a short piece, and other tokenizers differ further; run the real tokenizer before budgeting tightly.`);
  notes.push(`Embedding price ${price} $ per million tokens is what you entered (the default is an example as of 2026-09); check the provider's price page.`);
  if (strategy === 'recursive') notes.push(`Separators, in order: ${seps.map(showSep).join(', ')}.`);
  if (strategy === 'code') notes.push(`${codeDefs} top-level definitions found; each chunk holds whole definitions where they fit.`);
  if (keep) notes.push('Header paths are prepended to each chunk\'s embed_text ("A > B" and a blank line), and counted in the cost.');

  // 4. histogram (shared with the page's ruler)
  const top = Math.max(size, ...sizes);
  const nb = Math.min(12, Math.max(4, Math.ceil(Math.sqrt(out.length)) + 2));
  const bw = Math.max(1, Math.ceil(top / nb));
  const bins = Array.from({ length: Math.ceil((top + 1) / bw) }, (_, k) => ({ lo: k * bw, hi: (k + 1) * bw, n: 0 }));
  for (const v of sizes) bins[Math.min(bins.length - 1, Math.floor(v / bw))].n++;

  const jsonl = out.map((c) => JSON.stringify({
    id: c.i, text: text.slice(c.s, c.e), start: c.s, end: c.e, lines: [c.line, c.endLine], tokens_est: c.tokens,
    header_path: c.path, strategy, ...(keep && c.path.length ? { embed_text: c.path.join(' > ') + '\n\n' + text.slice(c.s, c.e) } : {}),
  })).join('\n') + '\n';

  const fmt$ = (v) => (v <= 0 ? '0' : v >= 1 ? v.toFixed(2) : v.toFixed(Math.min(12, 2 - Math.floor(Math.log10(v)))));
  return {
    values: [
      { label: 'Chunks', value: out.length, hint: `${strategy}, size ${size} ${unit}, overlap ${overlap}` },
      { label: `Size (${unit})`, value: `${Math.min(...sizes)} / ${Math.round(mean)} / ${Math.max(...sizes)}`, hint: 'min / mean / max' },
      { label: 'Document', value: docTokens, unit: 'tokens (est.)', hint: `${text.length} characters` },
      { label: 'Embedded', value: embedded, unit: 'tokens (est.)', hint: overhead >= 0.5 ? `overlap${keep ? ' and header paths' : ''} add ${overhead.toFixed(1)}%` : 'no repeated text', tone: overhead > 40 ? 'warn' : undefined },
      { label: 'Embedding cost', value: `$${fmt$(cost)}`, hint: `at $${price}/MTok; $${fmt$(cost * 1000)} per 1000 such documents` },
      { label: 'Findings', value: cuts.length + heads.length + overs.length + (tail ? 1 : 0), tone: cuts.length || heads.length || overs.length ? 'warn' : tail ? 'warn' : 'ok', hint: 'cut blocks, heading-only, oversize, tail' },
    ].map((v) => (v.tone === undefined ? (delete v.tone, v) : v)),
    charts: [{ title: `Chunk sizes (${unit})`, type: 'bars', x: bins.map((b) => `${b.lo}-${b.hi - 1}`), series: [{ name: 'chunks', y: bins.map((b) => b.n) }], xLabel: `size, ${unit}`, yLabel: 'chunks' }],
    tables: [{ title: 'Chunks', columns: ['#', 'Lines', `Size (${unit})`, 'Tokens (est.)', 'Overlap chars', 'Header path', 'Findings'],
      rows: out.slice(0, 300).map((c) => [c.i, `${c.line}-${c.endLine}`, c.m, c.tokens, c.ov, c.path.join(' > ') || '–', c.warn.map((w) => w.msg).join('; ') || '']) }],
    texts: [{ title: 'Chunks JSONL', body: jsonl, lang: 'json' }],
    warnings, notes,
    view: {
      chunks: out.map((c) => ({ i: c.i, s: c.s, e: c.e, line: c.line, endLine: c.endLine, tokens: c.tokens, m: c.m, chars: c.chars, ov: c.ov, path: c.path, warn: c.warn })),
      fences: st.fences, tables: st.tables, headings: st.headings.map((h) => ({ s: h.s, level: h.level, title: h.title })),
      size, overlap, unit, strategy, seps, docTokens, embedded, cost, price, bins, textLen: text.length,
    },
  };
}
