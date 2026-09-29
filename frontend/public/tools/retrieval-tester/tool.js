// Retrieval Tester: which chunks a query retrieves under BM25, and why.
// Pure: no DOM, no fetch. Runs in the browser and in Node 22.
//
// Scoring - Okapi BM25 as written in Robertson & Zaragoza, "The Probabilistic
// Relevance Framework: BM25 and Beyond" (Foundations and Trends in IR 3(4),
// 2009), eq. 3.15, with the non-negative IDF that Lucene's BM25Similarity uses:
//
//   score(D, Q) = sum over distinct query terms t of
//                 IDF(t) * tf(t,D) * (k1 + 1) / (tf(t,D) + k1 * (1 - b + b * |D| / avgdl))
//   IDF(t)      = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
//
// k1 sets how quickly repeated occurrences stop adding (0 = presence only),
// b how much a long chunk is penalised (0 = not at all, 1 = fully by length).
// A term repeated in the query counts once (Lucene sums repeats; with short
// queries the difference is rare and it keeps the bars readable).

import { fmtNum } from '../kit/eng.js';

// ---------------- text ----------------

/** Lower case that keeps Turkish dotted capital I as i (not "i̇"). */
const lower = (s) => s.replace(/İ/g, 'i').toLowerCase().normalize('NFC');

// Common English function words (a short list in the spirit of the classic
// SMART / Lucene EnglishAnalyzer stop sets, written for this tool).
const STOP_EN = new Set(('a an and are as at be been but by can could did do does for from had has have how i if in into is it its '
  + 'me my no not of on or our so such than that the their them then there these they this those to too us was we were what when '
  + 'where which while who why will with would you your yours about after before also any all am just more most other over only '
  + 'own same should some very via every up out off each few both both being because until again further here once nor s t don').split(/\s+/));
// Common Turkish function words (conjunctions, postpositions, pronouns).
const STOP_TR = new Set(('ve ile bir bu şu o da de ki mi mı mu mü için gibi kadar ama fakat ancak veya ya yani çok daha en her hiç '
  + 'ne neden nasıl nerede niye hangi olan olarak ise diye sonra önce göre ben sen biz siz onlar bunu şunu onu bunun onun bana sana '
  + 'var yok değil tüm bazı birkaç şey eğer hem ise ayrıca artık bile sadece yine zaten').split(/\s+/));

const TR_LETTERS = /[çğıöşü]/;

/**
 * A light English suffix stripper, written for this tool (not the Porter
 * or Snowball algorithm): one suffix from a short list, then an undoubled
 * final consonant and a dropped final e, so flash/flashes/flashing/flashed
 * and update/updates/updated/updating meet. It over- and under-stems; it is
 * there so the effect of stemming on ranks can be seen.
 */
export function stemEn(w) {
  if (w.length <= 3 || /\d/.test(w)) return w;
  const rules = [
    ['ational', 'ate'], ['ization', 'ize'], ['fulness', 'ful'], ['ousness', 'ous'], ['iveness', 'ive'],
    ['ations', 'at'], ['ation', 'at'], ['ments', ''], ['ment', ''], ['nesses', ''], ['ness', ''],
    ['ingly', ''], ['edly', ''], ['ings', ''], ['ing', ''], ['ies', 'i'], ['ied', 'i'], ['sses', 'ss'],
    ['shes', 'sh'], ['ches', 'ch'], ['xes', 'x'], ['zes', 'z'], ['ers', ''], ['er', ''], ['ed', ''], ['ly', ''], ['s', ''],
  ];
  let out = w;
  for (const [suf, rep] of rules) {
    if (!out.endsWith(suf)) continue;
    if (suf === 's' && /(ss|us|is)$/.test(out)) break;
    const stem = out.slice(0, -suf.length) + rep;
    // Keep at least three letters and a vowel in what is left.
    if (stem.length >= 3 && /[aeiouy]/.test(stem)) out = stem;
    break;
  }
  if (/([^aeiouls])\1$/.test(out) && out.length > 3) out = out.slice(0, -1);
  if (out.endsWith('e') && out.length > 4) out = out.slice(0, -1);
  if (/[^aeiou]y$/.test(out) && out.length > 3) out = out.slice(0, -1) + 'i';
  return out;
}

// Turkish inflectional suffixes (plural, case, possessive, a few verb
// endings), longest first. Light stripping, not a morphological analyser
// such as Zemberek or the Snowball Turkish stemmer: roots with sound
// changes (kitabı -> kitap) are not restored.
const TR_SUFFIXES = [
  'larından', 'lerinden', 'larında', 'lerinde', 'larını', 'lerini', 'lardan', 'lerden', 'ların', 'lerin', 'ları', 'leri',
  'larda', 'lerde', 'lara', 'lere', 'lar', 'ler',
  'ıyorsa', 'iyorsa', 'uyorsa', 'üyorsa', 'ıyor', 'iyor', 'uyor', 'üyor', 'ysa', 'yse', 'sa', 'se', 'ken', 'mak', 'mek', 'mış', 'miş', 'muş', 'müş', 'yor',
  'ndan', 'nden', 'dan', 'den', 'tan', 'ten', 'nda', 'nde', 'da', 'de', 'ta', 'te',
  'ının', 'inin', 'unun', 'ünün', 'sını', 'sini', 'ını', 'ini', 'nın', 'nin', 'nun', 'nün', 'yla', 'yle', 'sı', 'si', 'su', 'sü', 'yı', 'yi', 'yu', 'yü', 'ya', 'ye',
  'ın', 'in', 'un', 'ün', 'ı', 'i', 'u', 'ü', 'a', 'e',
];
export function stemTr(w) {
  if (/\d/.test(w)) return w;
  let out = w;
  for (let pass = 0; pass < 3; pass++) {
    const suf = TR_SUFFIXES.find((s) => out.endsWith(s) && out.length - s.length >= 3);
    if (!suf) break;
    out = out.slice(0, -suf.length);
  }
  return out;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}_]*(?:[.\-][\p{L}\p{N}_]+)*/gu;

/**
 * Tokens of a text with their character spans: [{s, e, word, key}], key
 * being the indexed form (stemmed) or null for a stopword. A Turkish
 * apostrophe suffix (STM32'nin) is dropped with the apostrophe; dotted and
 * hyphenated words (v2.4.1, dfu-util) are also split into their parts.
 */
export function tokenize(text, opt) {
  const out = [];
  const src = String(text);
  WORD.lastIndex = 0;
  let m;
  while ((m = WORD.exec(src))) {
    const s = m.index, word = lower(m[0]);
    // An apostrophe right after the word: skip the suffix that follows it.
    if (/['’]/.test(src[s + m[0].length] || '')) {
      const rest = /^['’][\p{L}]+/u.exec(src.slice(s + m[0].length));
      if (rest) WORD.lastIndex = s + m[0].length + rest[0].length;
    }
    // wi-fi is also indexed as wifi and as wi, fi; dfu-util as dfuutil, dfu, util.
    const parts = /[.\-]/.test(word)
      ? [...new Set([word, ...(word.includes('-') ? [word.replace(/-/g, '')] : []), ...word.split(/[.\-]/).filter((p) => p.length > 1)])] : [word];
    for (const p of parts) out.push({ s, e: s + m[0].length, word: p, key: keyOf(p, opt) });
  }
  return out;
}

function keyOf(word, opt) {
  if (opt.stop && (STOP_EN.has(word) || STOP_TR.has(word))) return null;
  if (word.length === 1 && !/\d/.test(word)) return null;
  switch (opt.stem) {
    case 'en': return stemEn(word);
    case 'tr': return stemTr(word);
    case 'en+tr': return TR_LETTERS.test(word) ? stemTr(word) : stemEn(word);
    default: return word;
  }
}

// ---------------- documents ----------------
const slug = (s) => lower(s).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'chunk';

/**
 * Chunks from what was pasted: JSONL or a JSON array of objects (id / chunk_id,
 * text / content / chunk / page_content, optional title / heading), else
 * Markdown split at headings (#, ##, ###; id = the heading's slug or an
 * explicit {#id}), else paragraphs split at blank lines.
 */
export function parseDocs(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const problems = [];
  const trimmed = src.trim();
  if (!trimmed) return { chunks: [], format: 'empty', problems };
  const fromObj = (o, i) => {
    if (!o || typeof o !== 'object') return null;
    const body = o.text ?? o.content ?? o.chunk ?? o.page_content ?? o.body;
    if (typeof body !== 'string') return null;
    const id = String(o.id ?? o.chunk_id ?? o._id ?? o.metadata?.id ?? `c${i + 1}`);
    const title = String(o.title ?? o.heading ?? o.metadata?.title ?? o.source ?? '');
    return { id, title, text: body };
  };
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        const chunks = [];
        arr.forEach((o, i) => { const c = fromObj(o, i); if (c) chunks.push(c); else problems.push(`JSON item ${i + 1} has no text/content string; skipped`); });
        return { chunks, format: 'JSON array', problems };
      }
    } catch (e) { problems.push(`Looks like a JSON array but does not parse (${e.message}); read as text instead`); }
  }
  const lines = src.split('\n');
  const jsonish = lines.filter((l) => l.trim().startsWith('{'));
  if (jsonish.length && jsonish.length >= lines.filter((l) => l.trim()).length * 0.8) {
    const chunks = [];
    lines.forEach((l, i) => {
      const t = l.trim();
      if (!t) return;
      try {
        const c = fromObj(JSON.parse(t), chunks.length);
        if (c) chunks.push(c); else problems.push(`Line ${i + 1}: no text/content field; skipped`);
      } catch { problems.push(`Line ${i + 1}: not JSON; skipped`); }
    });
    return { chunks, format: 'JSONL', problems };
  }
  const heads = lines.map((l, i) => [i, /^(#{1,3})\s+(.+?)\s*$/.exec(l)]).filter(([, m]) => m);
  if (heads.length) {
    const chunks = [];
    const pre = lines.slice(0, heads[0][0]).join('\n').trim();
    if (pre) chunks.push({ id: 'intro', title: '', text: pre });
    heads.forEach(([li, m], k) => {
      const end = k + 1 < heads.length ? heads[k + 1][0] : lines.length;
      let title = m[2];
      let id = null;
      const idm = /\s*\{#([\w.\-:]+)\}$/.exec(title);
      if (idm) { id = idm[1]; title = title.slice(0, idm.index).trim(); }
      const body = lines.slice(li + 1, end).join('\n').trim();
      if (!body) { problems.push(`Heading "${title}" (line ${li + 1}) has no text under it; skipped`); return; }
      chunks.push({ id: id || slug(title), title, text: `${title}\n${body}` });
    });
    return { chunks, format: 'Markdown headings', problems };
  }
  const paras = src.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return { chunks: paras.map((p, i) => ({ id: `p${i + 1}`, title: '', text: p })), format: 'paragraphs', problems };
}

/** Queries, one per line: `text => id1, id2` gives the expected chunk ids. # starts a comment. */
export function parseQueries(text) {
  const out = [];
  String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((l) => {
    const t = l.trim();
    if (!t || t.startsWith('#')) return;
    const [q, exp] = t.split(/\s*=>\s*/, 2);
    if (!q.trim()) return;
    out.push({ text: q.trim(), expected: exp ? exp.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) : [] });
  });
  return out;
}

// ---------------- BM25 ----------------
const num = (v, d, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function run(input) {
  const warnings = [], notes = [];
  const k1 = num(input.k1, 1.2, 0, 10);
  const b = num(input.b, 0.75, 0, 1);
  const topk = Math.round(num(input.topk, 5, 1, 50));
  const stem = ['none', 'en', 'tr', 'en+tr'].includes(input.stem) ? input.stem : 'en';
  const opt = { stem, stop: input.stopwords !== false };
  if (input.k1 != null && input.k1 !== k1) warnings.push(`k1 ${input.k1} is outside 0-10; ${k1} used.`);
  if (input.topk != null && Math.round(input.topk) !== topk) warnings.push(`k ${input.topk} for recall@k is outside 1-50; ${topk} used.`);
  if (input.b != null && input.b !== b) warnings.push(`b ${input.b} is outside 0-1; ${b} used.`);

  const docs = parseDocs(input.docs);
  warnings.push(...docs.problems.slice(0, 8));
  if (docs.problems.length > 8) warnings.push(`${docs.problems.length - 8} more lines could not be read.`);
  // Ids must be unique for expected ids to mean anything.
  const seen = new Map();
  for (const c of docs.chunks) {
    const n = (seen.get(c.id) || 0) + 1; seen.set(c.id, n);
    if (n > 1) { const old = c.id; c.id = `${c.id}~${n}`; warnings.push(`Chunk id "${old}" repeats; the copy is renamed "${c.id}". Give chunks unique ids.`); }
  }
  const chunks = docs.chunks.map((c) => {
    const toks = tokenize(c.text, opt);
    const tf = new Map();
    for (const t of toks) if (t.key) tf.set(t.key, (tf.get(t.key) || 0) + 1);
    const len = toks.filter((t) => t.key).length;
    return { ...c, toks, tf, len };
  });
  const N = chunks.length;
  const queries = parseQueries(input.queries);
  if (!N) {
    return { values: [{ label: 'Chunks', value: 0, tone: 'bad' }], warnings: [...warnings, 'No chunks: paste documents (Markdown with headings, paragraphs, or JSONL with id and text).'],
      notes: [], tables: [{ title: 'Chunks', columns: ['id', 'tokens'], rows: [] }], bm25: { chunks: [], queries: [], params: { k1, b, topk, stem, stop: opt.stop } } };
  }
  if (!queries.length) warnings.push('No queries: write one per line, optionally `query => expected-id`.');

  const df = new Map();
  for (const c of chunks) for (const k of c.tf.keys()) df.set(k, (df.get(k) || 0) + 1);
  const avgdl = chunks.reduce((s, c) => s + c.len, 0) / N || 1;
  const idf = (k) => Math.log(1 + (N - (df.get(k) || 0) + 0.5) / ((df.get(k) || 0) + 0.5));

  const tiny = chunks.filter((c) => c.len < 5);
  if (tiny.length) warnings.push(`${tiny.length} chunk(s) have under 5 indexed words (${tiny.slice(0, 4).map((c) => c.id).join(', ')}): they score high on any match because they are short. Merge them with a neighbour.`);
  const huge = chunks.filter((c) => c.len > avgdl * 4 && N > 3);
  if (huge.length) warnings.push(`${huge.length} chunk(s) are over 4x the average length (${huge.slice(0, 4).map((c) => c.id).join(', ')}): with b = ${fmtNum(b, 2)} they are held back; split them if they cover several topics.`);

  const ids = new Set(chunks.map((c) => c.id));
  const allKeys = new Map(); // query term key -> index for colours
  const qOut = queries.map((q, qi) => {
    const qt = tokenize(q.text, opt).filter((t) => t.key);
    const terms = [];
    for (const t of qt) if (!terms.some((x) => x.key === t.key)) terms.push({ word: t.word, key: t.key });
    for (const t of terms) { if (!allKeys.has(t.key)) allKeys.set(t.key, allKeys.size); t.df = df.get(t.key) || 0; t.idf = idf(t.key); t.g = allKeys.get(t.key); }
    const scored = chunks.map((c, ci) => {
      const parts = terms.map((t) => {
        const f = c.tf.get(t.key) || 0;
        return f ? t.idf * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.len) / avgdl)) : 0;
      });
      return { c: ci, score: parts.reduce((s, x) => s + x, 0), parts };
    }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score || x.c - y.c);
    const rank = new Array(N).fill(0);
    scored.forEach((x, i) => { rank[x.c] = i + 1; });
    const expected = q.expected;
    const missingIds = expected.filter((id) => !ids.has(id));
    if (missingIds.length) warnings.push(`Query ${qi + 1}: expected id(s) ${missingIds.join(', ')} are not chunk ids.`);
    const expIdx = expected.map((id) => chunks.findIndex((c) => c.id === id)).filter((i) => i >= 0);
    const firstRank = expIdx.map((i) => rank[i]).filter((r) => r > 0).reduce((a, r) => Math.min(a, r), Infinity);
    const hitsAtK = expIdx.filter((i) => rank[i] > 0 && rank[i] <= topk).length;
    const recall = expIdx.length ? hitsAtK / expIdx.length : null;
    const rr = expIdx.length ? (Number.isFinite(firstRank) ? 1 / firstRank : 0) : null;
    if (!terms.length) warnings.push(`Query ${qi + 1} "${q.text}" has no indexable words (all stopwords or single letters).`);
    else if (!scored.length) warnings.push(`Query ${qi + 1} "${q.text}" matches no chunk: none of its words (${terms.map((t) => t.key).join(', ')}) occur. A keyword index cannot bridge synonyms; try the words the documents use, or a hybrid with embeddings.`);
    const unknown = terms.filter((t) => !t.df).map((t) => t.word);
    if (unknown.length && scored.length) notes.push(`Query ${qi + 1}: ${unknown.join(', ')} ${unknown.length > 1 ? 'occur' : 'occurs'} in no chunk and adds nothing.`);
    return { text: q.text, expected, terms, ranked: scored.slice(0, Math.max(topk, 20)), rank, recall, rr,
      firstRank: Number.isFinite(firstRank) ? firstRank : 0, retrieved: scored.length };
  });

  // Highlight spans: only words that are some query's term.
  const drawChunks = chunks.map((c) => {
    const text = c.text.length > 4000 ? c.text.slice(0, 4000) + ' …' : c.text;
    const spans = [];
    for (const t of c.toks) if (t.key && allKeys.has(t.key) && t.e <= text.length && !spans.some((s) => s[0] === t.s)) spans.push([t.s, t.e, allKeys.get(t.key)]);
    return { id: c.id, title: c.title, text, len: c.len, spans };
  });

  const withExp = qOut.filter((q) => q.recall != null);
  const meanRecall = withExp.length ? withExp.reduce((s, q) => s + q.recall, 0) / withExp.length : null;
  const mrr = withExp.length ? withExp.reduce((s, q) => s + q.rr, 0) / withExp.length : null;
  const misses = withExp.filter((q) => q.recall === 0).length;

  const values = [
    { label: 'Chunks', value: N, hint: docs.format },
    { label: 'Average length', value: Number(avgdl.toFixed(1)), unit: 'terms' },
    { label: 'Vocabulary', value: df.size, unit: 'terms' },
    { label: 'Queries', value: queries.length, hint: withExp.length ? `${withExp.length} with expected ids` : 'no expected ids given' },
  ];
  if (withExp.length) {
    values.push({ label: `Recall@${topk}`, value: Number(meanRecall.toFixed(3)), tone: meanRecall >= 0.9 ? 'ok' : meanRecall >= 0.6 ? 'warn' : 'bad', hint: 'mean over queries with expected ids' });
    values.push({ label: 'MRR', value: Number(mrr.toFixed(3)), tone: mrr >= 0.8 ? 'ok' : mrr >= 0.5 ? 'warn' : 'bad', hint: 'mean of 1 / rank of the first expected chunk' });
    if (misses) values.push({ label: `Missed in top ${topk}`, value: misses, unit: 'queries', tone: 'bad' });
  }

  const tables = [{
    title: `Top ${topk} per query (BM25 k1 = ${fmtNum(k1, 3)}, b = ${fmtNum(b, 3)})`,
    columns: ['#', 'query', 'ranked chunks (score)', 'expected', 'first expected rank', `recall@${topk}`],
    rows: qOut.map((q, i) => [i + 1, q.text,
      q.ranked.slice(0, topk).map((x) => `${chunks[x.c].id} (${x.score.toFixed(2)})`).join(', ') || '(none)',
      q.expected.join(', ') || '-', q.expected.length ? (q.firstRank || 'not retrieved') : '-',
      q.recall == null ? '-' : Number(q.recall.toFixed(2))]),
  }];

  const jsonl = qOut.map((q) => JSON.stringify({ query: q.text, expected: q.expected,
    results: q.ranked.slice(0, topk).map((x) => ({ id: chunks[x.c].id, score: Number(x.score.toFixed(4)) })) })).join('\n');

  notes.push(`BM25 (Robertson & Zaragoza 2009) with IDF = ln(1 + (N - df + 0.5)/(df + 0.5)) as in Lucene; N = ${N}, avgdl = ${avgdl.toFixed(1)} indexed terms.`,
    `Tokens: lower-cased words of letters and digits; ${opt.stop ? 'English and Turkish stopwords removed' : 'no stopwords removed'}; stemming: ${{ none: 'none', en: 'light English suffix stripping', tr: 'light Turkish suffix stripping', 'en+tr': 'Turkish stripping for words with Turkish letters, English for the rest' }[stem]} (a simple stripper written for this tool, not Porter/Snowball or a Turkish morphological analyser).`,
    'Embeddings are not computed here (that needs a model). A dense retriever would also find chunks that share meaning but no words; a hybrid (for example reciprocal rank fusion of BM25 and vector ranks) usually beats either alone. Queries this tool shows as missed for lack of shared words are the ones a hybrid would rescue.');

  return {
    values, tables,
    texts: [{ title: 'Rankings JSONL', body: jsonl, lang: 'json' }],
    warnings, notes,
    bm25: {
      params: { k1, b, topk, stem, stop: opt.stop, N, avgdl: Number(avgdl.toFixed(3)), format: docs.format },
      chunks: drawChunks,
      terms: [...allKeys.keys()],
      queries: qOut.map((q) => ({ ...q, terms: q.terms.map((t) => ({ ...t, idf: Number(t.idf.toFixed(4)) })),
        ranked: q.ranked.map((x) => ({ c: x.c, score: Number(x.score.toFixed(4)), parts: x.parts.map((p) => Number(p.toFixed(4))) })) })),
      meanRecall, mrr,
    },
  };
}
