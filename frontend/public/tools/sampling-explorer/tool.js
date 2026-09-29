// Sampling Parameters Explorer: how penalties, temperature, top-k, top-p and
// min-p reshape one next-token distribution, and what a seeded sampler then
// draws from it. Pure: no DOM, no clock, no Math.random.
//
// The maths, each step with its source:
//   softmax            p_i = exp(z_i) / sum_j exp(z_j), computed with the max
//                      subtracted first (same result, no overflow).
//   repetition penalty CTRL, Keskar et al. 2019, sec. 4.1; HF transformers
//                      RepetitionPenaltyLogitsProcessor: a token already in
//                      the context has its logit divided by r when positive,
//                      multiplied by r when negative.
//   presence/frequency OpenAI API reference, "frequency_penalty" /
//                      "presence_penalty" and the Text generation guide:
//                      mu_j -= c_j * alpha_frequency + [c_j > 0] * alpha_presence
//                      (c_j = times token j already appeared).
//   temperature        z_i / T before the softmax (Ackley, Hinton, Sejnowski
//                      1985 Boltzmann form); T -> 0 is greedy decoding.
//   top-k              keep the k most likely tokens (Fan, Lewis, Dauphin 2018).
//   top-p (nucleus)    keep the smallest set of most likely tokens whose
//                      probability sums to at least p (Holtzman et al. 2020).
//   min-p              keep tokens with p >= min_p * p_max (Nguyen et al. 2024,
//                      "Turning Up the Heat: Min-p Sampling").
//   entropy            H = -sum p log2 p; 2^H is the perplexity of the
//                      distribution: how many equally likely choices it is worth.
//   RNG                mulberry32 (Tommy Ettinger, public domain), seeded from
//                      the input, so the same seed draws the same samples.

// ---------------- built-in example distributions ----------------
// Illustrative logits shaped like a real model's next-token output for each
// prompt (a sharp head and a long tail for facts and code, a flatter spread
// for prose). They were written by hand, not captured from a model.
export const PRESETS = {
  factual: {
    title: 'Factual answer',
    prompt: 'Q: Is Sydney the capital of Australia?\nA: No. The capital of Australia is',
    history: 'Q: Is Sydney the capital of Australia?\nA: No. The capital of Australia is',
    logits: [[' Canberra', 21.4], [' actually', 16.2], [' Sydney', 15.8], [' not', 15.1], [' the', 14.6], [' located', 13.9],
      [' officially', 13.5], [' Melbourne', 13.2], [' a', 12.8], [' in', 12.0], [' called', 11.6], [' often', 11.1],
      [' Canber', 10.4], [' one', 10.1], [' Perth', 9.7], [' known', 9.3], [' also', 9.0], [' Brisbane', 8.6],
      [' Adelaide', 8.1], [' home', 7.8], [' ACT', 7.5], [' Darwin', 6.9], [' Hobart', 6.4]],
  },
  creative: {
    title: 'Creative word',
    prompt: 'The letter had been in the drawer for years, and it still smelled faintly of',
    history: 'The rain had not stopped for days. She sat by the window, smoke curling from her cigarette, and listened to the rain.\nThe letter had been in the drawer for years, and it still smelled faintly of',
    logits: [[' smoke', 17.8], [' lavender', 17.6], [' rain', 17.1], [' her', 16.9], [' perfume', 16.7], [' tobacco', 16.5],
      [' roses', 16.0], [' dust', 15.9], [' cedar', 15.3], [' the', 15.2], [' old', 14.9], [' salt', 14.2], [' vanilla', 14.1],
      [' ink', 14.0], [' cinnamon', 13.6], [' mothballs', 13.4], [' something', 13.2], [' oranges', 12.5], [' cologne', 12.4],
      [' pine', 11.9], [' coffee', 11.7], [' sandalwood', 11.5], [' regret', 10.8], [' home', 10.6], [' whiskey', 10.2], [' jasmine', 9.8]],
  },
  code: {
    title: 'Code token',
    prompt: 'int sum(const int *a, int n) {\n    int s = 0;\n    for (int i = 0; i <',
    history: 'int sum(const int *a, int n) {\n    int s = 0;\n    for (int i = 0; i <',
    logits: [[' n', 22.3], [' len', 16.4], [' N', 15.9], [' count', 15.1], [' size', 14.8], [' 10', 14.0], [' sizeof', 13.2],
      [' num', 12.6], [' length', 12.1], [' (', 11.4], [' a', 11.0], [' MAX', 10.7], [' strlen', 10.1], [' s', 9.8], [' cnt', 9.4],
      [' 100', 9.0], [' nmemb', 8.3], [' n_elems', 7.9], [' i', 7.2], [' 0', 6.8]],
  },
};

// ---------------- provider defaults (data that changes) ----------------
// As of 2026-09, from each provider's documentation as remembered when this
// tool was written. NOT verified live: check the provider's page before
// relying on a number. `null` = the parameter does not exist there.
export const PROVIDERS_ASOF = '2026-09';
export const PROVIDERS = [
  { id: 'openai', name: 'OpenAI Chat Completions', order: 'temp-first',
    set: { temperature: 1, topK: null, topP: 1, minP: null, presence: 0, frequency: 0, repetition: null },
    ranges: 'temperature 0-2, top_p 0-1, presence/frequency -2..2',
    note: 'No top_k, min_p or repetition penalty. OpenAI advises changing temperature or top_p, not both. Reasoning models reject or ignore temperature/top_p. Sampler order is not documented.' },
  { id: 'anthropic', name: 'Anthropic Messages', order: 'temp-first',
    set: { temperature: 1, topK: 0, topP: 1, minP: null, presence: null, frequency: null, repetition: null },
    ranges: 'temperature 0-1, top_p 0-1, top_k >= 1 (unset = off)',
    note: 'No penalties or min_p. Recent models refuse temperature and top_p together; extended thinking restricts temperature and top_k. Sampler order is not documented.' },
  { id: 'vllm', name: 'vLLM SamplingParams', order: 'temp-first',
    set: { temperature: 1, topK: 0, topP: 1, minP: 0, presence: 0, frequency: 0, repetition: 1 },
    ranges: 'top_k 0 or -1 = off, min_p 0-1, repetition_penalty > 0',
    note: 'Its OpenAI-compatible server may take defaults from the model\'s generation_config.json instead (--generation-config).' },
  { id: 'llamacpp', name: 'llama.cpp (llama-cli / llama-server)', order: 'temp-last',
    set: { temperature: 0.8, topK: 40, topP: 0.95, minP: 0.05, presence: 0, frequency: 0, repetition: 1 },
    ranges: '--repeat-last-n 64 is the penalty window',
    note: 'Default chain: penalties;dry;top_n_sigma;top_k;typ_p;top_p;min_p;xtc;temperature - temperature last. Older builds used repeat_penalty 1.1.' },
  { id: 'hf', name: 'HF transformers generate()', order: 'temp-first',
    set: { temperature: 1, topK: 50, topP: 1, minP: 0, presence: null, frequency: null, repetition: 1 },
    ranges: 'do_sample=False (greedy) unless the model\'s generation_config says otherwise',
    note: 'Warper order: temperature, top_k, top_p, min_p after the logits processors (repetition penalty).' },
];

export const ORDERS = {
  'temp-first': ['penalties', 'temperature', 'top-k', 'top-p', 'min-p'],
  'temp-last': ['penalties', 'top-k', 'top-p', 'min-p', 'temperature'],
};

// ---------------- parsing ----------------
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const unspace = (t) => t.replace(/␣/g, ' ');

/** Logits or logprobs as lines ("token": 12.3 / token<TAB>12.3 / ␣token: 1.2)
 *  or JSON (an object token -> value, an array of {token, logprob|logit},
 *  or an OpenAI logprobs block with top_logprobs). */
export function parseLogits(text) {
  const out = [], bad = [], dup = [];
  const seen = new Set();
  const add = (tok, v, where) => {
    if (typeof tok !== 'string' || !tok.length || !Number.isFinite(v)) { bad.push(where); return; }
    if (seen.has(tok)) { dup.push(tok); return; }
    seen.add(tok); out.push([tok, v]);
  };
  const t = String(text ?? '').trim();
  if (!t) return { list: out, bad, dup, kind: 'empty' };
  if (/^[[{]/.test(t)) {
    try {
      let j = JSON.parse(t);
      if (j && !Array.isArray(j) && Array.isArray(j.content)) j = j.content[0]?.top_logprobs || [];
      if (j && !Array.isArray(j) && j.logprobs) j = j.logprobs.content?.[0]?.top_logprobs || [];
      if (Array.isArray(j)) {
        j.forEach((e, i) => add(e?.token, Number(e?.logprob ?? e?.logit ?? e?.value), `item ${i + 1}`));
        return { list: out, bad, dup, kind: 'json' };
      }
      if (j && typeof j === 'object') {
        for (const [k, v] of Object.entries(j)) add(k, Number(v), `key ${JSON.stringify(k)}`);
        return { list: out, bad, dup, kind: 'json' };
      }
    } catch { /* fall through to lines */ }
  }
  const re = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(.+?))\s*(?:[:=\t]|\s)\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*,?\s*$/i;
  String(text).split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    const m = re.exec(line);
    if (!m) { bad.push(`line ${i + 1}`); return; }
    let tok;
    if (m[1] != null) { try { tok = JSON.parse(`"${m[1]}"`); } catch { tok = m[1]; } } else tok = unspace(m[2] ?? m[3]);
    add(tok, Number(m[4]), `line ${i + 1}`);
  });
  return { list: out, bad, dup, kind: 'lines' };
}

/** How often each candidate already appears in the context. Real samplers
 *  count token ids; here the context is split into words and single
 *  punctuation marks and compared with each candidate's trimmed text. Lines
 *  "token: N" (and nothing else) give the counts directly. */
export function countHistory(history, tokens) {
  const text = String(history ?? '');
  const counts = Object.fromEntries(tokens.map((t) => [t, 0]));
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const explicit = lines.length && lines.every((l) => /^\s*("[^"]*"|\S+)\s*:\s*\d+\s*$/.test(l));
  if (explicit) {
    for (const l of lines) {
      const m = /^\s*("[^"]*"|\S+)\s*:\s*(\d+)\s*$/.exec(l);
      let k = m[1].startsWith('"') ? m[1].slice(1, -1) : unspace(m[1]);
      for (const t of tokens) if (t === k || t.trim() === k.trim()) counts[t] = Number(m[2]);
    }
    return { counts, mode: 'explicit' };
  }
  const pieces = text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+|[^\sA-Za-z0-9_]/g) || [];
  const tally = new Map();
  for (const p of pieces) tally.set(p, (tally.get(p) || 0) + 1);
  for (const t of tokens) counts[t] = tally.get(t.trim()) || 0;
  return { counts, mode: 'words' };
}

// ---------------- the pipeline ----------------
function softmax(z) {
  let m = -Infinity;
  for (const v of z) if (v > m) m = v;
  if (m === -Infinity) return z.map(() => 0);
  const e = z.map((v) => (v === -Infinity ? 0 : Math.exp(v - m)));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}
const entropyBits = (p) => -p.reduce((a, v) => (v > 0 ? a + v * Math.log2(v) : a), 0);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const show = (t) => JSON.stringify(t);
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

export function run(input) {
  const warnings = [], notes = [];
  const preset = PRESETS[input.preset] ? input.preset : (input.preset === 'custom' ? 'custom' : 'creative');
  let list, parsed = null;
  if (preset === 'custom') {
    parsed = parseLogits(input.logits);
    list = parsed.list;
    if (parsed.bad.length) warnings.push(`Could not read ${parsed.bad.length} entr${parsed.bad.length === 1 ? 'y' : 'ies'} (${parsed.bad.slice(0, 6).join(', ')}${parsed.bad.length > 6 ? ', ...' : ''}): write one per line as "token": 12.3, or paste a JSON logprobs block.`);
    if (parsed.dup.length) warnings.push(`Repeated token${parsed.dup.length > 1 ? 's' : ''} ${parsed.dup.slice(0, 5).map(show).join(', ')} - the first value was used.`);
    if (list.length < 2) {
      warnings.push('Fewer than two tokens could be read, so there is no distribution to shape. Using the creative example instead; paste at least two "token": value lines.');
      list = PRESETS.creative.logits.slice();
    }
  } else list = PRESETS[preset].logits.slice();
  if (list.length > 200) { warnings.push(`${list.length} tokens given; only the 200 highest are drawn and used.`); list = list.sort((a, b) => b[1] - a[1]).slice(0, 200); }

  const history = preset === 'custom' || String(input.history ?? '').trim() ? String(input.history ?? '') : PRESETS[preset].history;
  let T = num(input.temperature, 1);
  let K = Math.round(num(input.topK, 0));
  let P = num(input.topP, 1);
  let MP = num(input.minP, 0);
  const pres = num(input.presence, 0), freq = num(input.frequency, 0);
  let rep = num(input.repetition, 1);
  const order = ORDERS[input.order] ? input.order : 'temp-first';
  let N = Math.round(num(input.samples, 200));
  const seed = Math.round(num(input.seed, 42));

  if (T < 0) { warnings.push(`Temperature ${T} is negative; no API accepts that. Using 0 (greedy).`); T = 0; }
  if (T > 2) warnings.push(`Temperature ${T} is above the usual 0-2 range (OpenAI's maximum is 2, Anthropic's 1); expect near-uniform noise.`);
  if (K < 0) K = 0;
  if (!(P > 0 && P <= 1)) { warnings.push(`top-p ${P} is outside (0, 1]; using 1 (off).`); P = 1; }
  if (!(MP >= 0 && MP < 1)) { warnings.push(`min-p ${MP} is outside [0, 1); using 0 (off).`); MP = 0; }
  if (!(rep > 0)) { warnings.push(`Repetition penalty ${rep} must be above 0 (1 = off); using 1.`); rep = 1; }
  if (Math.abs(pres) > 2 || Math.abs(freq) > 2) warnings.push('OpenAI limits presence and frequency penalties to -2..2; larger values are drawn but no API would accept them.');
  if (!(N >= 0)) N = 0;
  if (N > 20000) { warnings.push(`${N} samples is more than needed to see the shape; capped at 20000.`); N = 20000; }

  const tokens = list.map((x) => x[0]);
  const logits = list.map((x) => x[1]);
  const hist = countHistory(history, tokens);
  const counts = tokens.map((t) => hist.counts[t] || 0);

  // Step 1 - penalties (repetition first, then frequency/presence: the order
  // of HF transformers' processors, vLLM and llama.cpp's penalties sampler).
  const pen = logits.map((l, i) => {
    let v = l;
    const c = counts[i];
    if (c > 0 && rep !== 1) v = v > 0 ? v / rep : v * rep;
    v -= c * freq + (c > 0 ? pres : 0);
    return v;
  });
  const idx = tokens.map((_, i) => i).sort((a, b) => pen[b] - pen[a] || a - b);
  const pModel = softmax(logits);
  const pPen = softmax(pen);
  const greedy = T < 1e-3;
  const tFirst = order === 'temp-first';

  // The distribution the filters see: after temperature (temp-first) or at T = 1 (temp-last).
  const zSeen = tFirst && !greedy ? pen.map((v) => v / T) : pen.slice();
  const pSeen = softmax(zSeen);
  const alive = tokens.map(() => true);
  const cutBy = tokens.map(() => '');
  const stages = [{ stage: 'input', kept: tokens.length }];
  stages.push({ stage: 'penalties', kept: tokens.length, changed: counts.filter((c) => c > 0).length });
  if (tFirst) stages.push({ stage: 'temperature', kept: tokens.length, greedy });

  // top-k on the sorted order.
  if (K > 0 && K < tokens.length) idx.forEach((i, r) => { if (r >= K && alive[i]) { alive[i] = false; cutBy[i] = 'top-k'; } });
  stages.push({ stage: 'top-k', kept: alive.filter(Boolean).length, off: !(K > 0 && K < tokens.length) });

  // top-p on the renormalised survivors, most likely first; the token that
  // crosses p is kept, so at least one token always survives.
  const renorm = () => { const s = idx.reduce((a, i) => a + (alive[i] ? pSeen[i] : 0), 0) || 1; return (i) => (alive[i] ? pSeen[i] / s : 0); };
  const q = renorm();
  const cumTopP = {};
  let cum = 0, crossed = false;
  for (const i of idx) {
    if (!alive[i]) continue;
    const before = cum;
    cum += q(i);
    cumTopP[i] = cum;
    if (P < 1 && crossed) { alive[i] = false; cutBy[i] = 'top-p'; }
    if (before < P - 1e-12 && cum >= P - 1e-12) crossed = true;
  }
  stages.push({ stage: 'top-p', kept: alive.filter(Boolean).length, off: P >= 1 });

  // min-p: relative to the most likely surviving token (a ratio, so the
  // renormalisation after the earlier cuts does not change it).
  const pmax = Math.max(...idx.filter((i) => alive[i]).map((i) => pSeen[i]));
  const minPAbs = MP * pmax;
  if (MP > 0) for (const i of idx) if (alive[i] && pSeen[i] < minPAbs) { alive[i] = false; cutBy[i] = 'min-p'; }
  stages.push({ stage: 'min-p', kept: alive.filter(Boolean).length, off: !(MP > 0) });
  if (!tFirst) stages.push({ stage: 'temperature', kept: alive.filter(Boolean).length, greedy });

  // Final distribution: survivors renormalised (temp-last: temperature applied now).
  let pFinal;
  if (greedy) {
    const top = idx.find((i) => alive[i]);
    pFinal = tokens.map((_, i) => (i === top ? 1 : 0));
    idx.forEach((i) => { if (alive[i] && i !== top) { cutBy[i] = 'greedy'; } });
  } else {
    const z = pen.map((v, i) => (alive[i] ? v / T : -Infinity));
    pFinal = softmax(z);
  }
  stages.push({ stage: 'sample', kept: pFinal.filter((p) => p > 0).length });

  // Seeded sampler.
  const rnd = mulberry32(seed);
  const cdf = [];
  let acc = 0;
  for (const i of idx) { acc += pFinal[i]; cdf.push([acc, i]); }
  const drawn = tokens.map(() => 0);
  const seq = [];
  for (let n = 0; n < N; n++) {
    const u = rnd() * acc;
    const hit = (cdf.find(([c]) => u < c) || cdf[cdf.length - 1])[1];
    drawn[hit]++;
    if (seq.length < 60) seq.push(hit);
  }

  const Hm = entropyBits(pModel), Hf = entropyBits(pFinal);
  const kept = pFinal.filter((p) => p > 0).length;
  const massRemoved = 1 - idx.reduce((a, i) => a + (cutBy[i] && cutBy[i] !== 'greedy' ? 0 : pSeen[i]), 0);
  const topFinal = idx.reduce((b, i) => (pFinal[i] > pFinal[b] ? i : b), idx[0]);
  const topModel = logits.indexOf(Math.max(...logits));
  const distinct = drawn.filter((c) => c > 0).length;

  // Findings a person should act on.
  if (topFinal !== topModel && !greedy) {
    warnings.push(`Penalties demoted the model's first choice ${show(tokens[topModel])} (it appears ${counts[topModel]}x in the context) below ${show(tokens[topFinal])}. That is what penalties are for in prose, but where repetition is correct (variable names in code, names in an answer) it changes the answer: keep them near 0 there.`);
  } else if (greedy && idx[0] !== topModel) {
    warnings.push(`At T = 0 the pick is ${show(tokens[idx[0]])}, not the model's first choice ${show(tokens[topModel])}: the penalties changed the answer.`);
  }
  if (!greedy && kept === 1) warnings.push('Only one token survives the filters, so sampling is deterministic here - the same as greedy decoding.');
  if (!greedy && P < 1 && T !== 1) notes.push('OpenAI recommends changing temperature or top_p, not both; Anthropic\'s recent models refuse both at once (as of 2026-09, verify).');
  if (pModel[topModel] > 0.9 && T > 1.3 && !greedy) warnings.push(`The model is ${(pModel[topModel] * 100).toFixed(0)} % sure of ${show(tokens[topModel])}, yet at T = ${T} it gets only ${(pFinal[topModel] * 100).toFixed(1)} %; high temperature turns a confident answer into noise.`);
  if (preset === 'custom' && parsed && parsed.list.length && parsed.list.every((x) => x[1] <= 0)) notes.push('The values are all <= 0, read as log-probabilities. Softmax does not care whether they are logits or logprobs, but top_logprobs lists only the top 20 or so, so the tail mass is missing and the shares are renormalised over what was given.');

  notes.push(`Order used: ${ORDERS[order].join(' -> ')} -> sample. ${tFirst ? 'HF transformers and vLLM scale by temperature before the cuts' : 'llama.cpp\'s default chain applies temperature last, so the cuts see the T = 1 distribution'}; hosted APIs do not document their order.`);
  notes.push(`Penalty counts come from the context text split into words and punctuation (${hist.mode === 'explicit' ? 'here given as token: count lines' : 'real samplers count token ids over a window, e.g. llama.cpp\'s last 64'}).`);
  notes.push(preset === 'custom' ? 'Your own logits are used as given.' : 'The built-in logits are illustrative, shaped like a real model\'s output but written by hand.');
  notes.push(`Provider defaults are as of ${PROVIDERS_ASOF} and not verified live; check each provider's API reference.`);

  // Rows for the page and the table, most likely (after penalties) first.
  const rows = idx.map((i, r) => ({
    i, rank: r + 1, token: tokens[i], logit: r4(logits[i]), pen: r4(pen[i]), count: counts[i],
    pModel: r6(pModel[i]), pPen: r6(pPen[i]), pSeen: r6(pSeen[i]), cum: r6(cumTopP[i] ?? 0),
    pFinal: r6(pFinal[i]), cut: cutBy[i], drawn: drawn[i],
  }));

  const settings = { temperature: T, topK: K, topP: P, minP: MP, presence: pres, frequency: freq, repetition: rep };
  const fmt = (v) => String(Math.round(v * 1000) / 1000);
  const oa = { temperature: T, top_p: P, presence_penalty: pres, frequency_penalty: freq };
  const an = { temperature: Math.min(T, 1), ...(P < 1 ? { top_p: P } : {}), ...(K > 0 ? { top_k: K } : {}) };
  const dropped = (names) => (names.length ? `  // not supported here, dropped: ${names.join(', ')}` : '');
  const req = [
    `# The current settings written for each API (defaults as of ${PROVIDERS_ASOF}; verify).`,
    '',
    '# OpenAI Chat Completions (request body fields)',
    JSON.stringify(oa) + dropped([K > 0 && `top_k ${K}`, MP > 0 && `min_p ${MP}`, rep !== 1 && `repetition_penalty ${rep}`].filter(Boolean)),
    '',
    '# Anthropic Messages (request body fields)',
    JSON.stringify(an) + dropped([T > 1 && `temperature ${T} (max 1)`, pres && 'presence_penalty', freq && 'frequency_penalty', MP > 0 && 'min_p', rep !== 1 && 'repetition_penalty'].filter(Boolean)),
    '',
    '# vLLM SamplingParams / OpenAI-compatible extra body',
    JSON.stringify({ temperature: T, top_p: P, top_k: K > 0 ? K : -1, min_p: MP, presence_penalty: pres, frequency_penalty: freq, repetition_penalty: rep, seed }),
    '',
    '# llama.cpp (llama-cli / llama-server flags)',
    `--temp ${fmt(T)} --top-k ${K} --top-p ${fmt(P)} --min-p ${fmt(MP)} --repeat-penalty ${fmt(rep)} --presence-penalty ${fmt(pres)} --frequency-penalty ${fmt(freq)} --seed ${seed} --samplers "${tFirst ? 'penalties;temperature;top_k;top_p;min_p' : 'penalties;top_k;top_p;min_p;temperature'}"  # sampler names as of ${PROVIDERS_ASOF}, verify with --help`,
    '',
    '# HF transformers model.generate(...)',
    `do_sample=${greedy ? 'False' : 'True'}, temperature=${fmt(greedy ? 1 : T)}, top_k=${K}, top_p=${fmt(P)}, min_p=${MP > 0 ? fmt(MP) : 'None'}, repetition_penalty=${fmt(rep)}`,
  ].join('\n');

  const dist = ['token\tlogit\tpenalized\tcount\tp_model\tp_final\tcut_by\tdrawn',
    ...rows.map((x) => [JSON.stringify(x.token), x.logit, x.pen, x.count, x.pModel, x.pFinal, x.cut || '-', x.drawn].join('\t'))].join('\n');

  return {
    values: [
      { label: 'Tokens that can be drawn', value: `${kept} of ${tokens.length}`, tone: kept === 1 && !greedy ? 'warn' : undefined },
      { label: 'Most likely now', value: `${show(tokens[topFinal])} ${(pFinal[topFinal] * 100).toFixed(1)} %`, hint: `model alone: ${(pModel[topFinal] * 100).toFixed(1)} %` },
      { label: 'Entropy after sampling settings', value: Number(Hf.toFixed(3)), unit: 'bits', hint: `${(2 ** Hf).toFixed(2)} effective choices` },
      { label: 'Entropy of the model alone', value: Number(Hm.toFixed(3)), unit: 'bits', hint: `${(2 ** Hm).toFixed(2)} effective choices` },
      { label: 'Probability mass cut by filters', value: Number((massRemoved * 100).toFixed(2)), unit: '%' },
      { label: `Distinct tokens in ${N} draws`, value: distinct, hint: `seed ${seed}` },
    ].map((v) => (v.tone === undefined ? (({ tone, ...rest }) => rest)(v) : v)),
    tables: [{
      title: 'Tokens, most likely first (after penalties)',
      columns: ['#', 'token', 'logit', 'penalized', 'in context', 'p model %', 'p final %', 'cut by', 'drawn'],
      rows: rows.slice(0, 30).map((x) => [x.rank, show(x.token), x.logit, x.pen, x.count, Number((x.pModel * 100).toFixed(2)), Number((x.pFinal * 100).toFixed(2)), x.cut || '-', x.drawn]),
    }],
    texts: [{ title: 'API settings', body: req }, { title: 'Distribution TSV', body: dist }],
    warnings, notes,
    draw: {
      preset, prompt: preset === 'custom' ? '' : PRESETS[preset].prompt, order, stages, rows, settings, greedy,
      minPAbs: r6(minPAbs), pmaxSeen: r6(Math.max(...pSeen)), seq: seq.map((i) => tokens[i]), N, seed,
      H: { model: r4(Hm), final: r4(Hf) }, historyMode: hist.mode, providers: PROVIDERS, asof: PROVIDERS_ASOF,
    },
  };
}
