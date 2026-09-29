// Token Counter & Context Budget.
//
// The prompt is written as labelled parts (=== system ===, === history ×20 ===,
// === retrieved chunks = 40k ===). Each part is estimated with ./estimate.js
// (o200k_base-shaped split, per-piece cost tables fitted to the real
// o200k_base and cl100k_base vocabularies - see that file for the method and
// the measured error). Each model row then says how many tokens it would
// see (the estimate for its tokenizer family times a per-model allowance),
// how much of its window that is, what is left for the answer, and - when
// it does not fit - what to cut first.
//
// Context windows and output limits change: MODELS below is a dated table
// (as of 2026-09), editable on the page, and every row must be checked
// against the provider's model page before a decision rests on it.

import { estimate } from './estimate.js';

export const AS_OF = '2026-09';

// name, ctx (context window, tokens), out (max output tokens), enc (which
// estimate to start from), factor (allowance for a tokenizer we cannot
// run), mode: shared = input + output share the window (Claude, OpenAI);
// separate = input limit and output limit are separate (Gemini).
// Claude rows: context and output from Anthropic's model table as cached
// 2026-09-25; the Claude tokenizer is not public, Anthropic documents only
// that the tokenizer introduced with Opus 4.7 uses ~1.0-1.35x the tokens of
// the earlier one - the factor is an allowance, calibrate it with
// /v1/messages/count_tokens on your own text. Other rows are from the
// providers' model pages as remembered, NOT verified here.
export const MODELS = [
  { name: 'Claude Opus 5.5', ctx: '1000000', out: '128000', enc: 'o200k', factor: '1.3', mode: 'shared' },
  { name: 'Claude Sonnet 5.5', ctx: '1000000', out: '128000', enc: 'o200k', factor: '1.3', mode: 'shared' },
  { name: 'Claude Haiku 4.5', ctx: '200000', out: '64000', enc: 'o200k', factor: '1.2', mode: 'shared' },
  { name: 'GPT-5', ctx: '400000', out: '128000', enc: 'o200k', factor: '1', mode: 'shared' },
  { name: 'GPT-4.1', ctx: '1047576', out: '32768', enc: 'o200k', factor: '1', mode: 'shared' },
  { name: 'GPT-4o', ctx: '128000', out: '16384', enc: 'o200k', factor: '1', mode: 'shared' },
  { name: 'Gemini 2.5 Pro', ctx: '1048576', out: '65536', enc: 'o200k', factor: '1.1', mode: 'separate' },
  { name: 'Gemini 2.5 Flash', ctx: '1048576', out: '65536', enc: 'o200k', factor: '1.1', mode: 'separate' },
  { name: 'Llama 3.3 70B', ctx: '131072', out: '8192', enc: 'cl100k', factor: '1', mode: 'shared' },
  { name: 'DeepSeek V3.x', ctx: '131072', out: '8192', enc: 'cl100k', factor: '1', mode: 'shared' },
  { name: 'Qwen3 235B-A22B', ctx: '262144', out: '32768', enc: 'cl100k', factor: '1', mode: 'shared' },
  { name: 'Mistral Large', ctx: '131072', out: '8192', enc: 'cl100k', factor: '1', mode: 'shared' },
];

// What a part is, from its name; the order is what to cut first and how much
// of it can go before the prompt stops doing its job (a rule of thumb, shown
// as such on the page).
export const KINDS = {
  documents: { re: /doc|file|context|rag|retriev|chunk|source|attach|datasheet|log/i, cut: 0.9, how: 'keep only the relevant passages (fewer or smaller chunks; for a log, the minutes around the failure)' },
  history: { re: /hist|chat|conversation|turn|memory|transcript/i, cut: 0.8, how: 'summarise the oldest turns, keep the last few verbatim' },
  examples: { re: /example|shot|demo/i, cut: 0.7, how: 'fewer few-shot examples, shortest representative ones' },
  tools: { re: /tool|function|schema|api/i, cut: 0.6, how: 'send only the tools this turn can use, shorten descriptions' },
  other: { re: null, cut: 0.5, how: 'trim or move out of the prompt' },
  system: { re: /system|instruction|persona|rules/i, cut: 0.3, how: 'tighten wording; keep the rules that change behaviour' },
  question: { re: /question|query|task|user|ask|request/i, cut: 0, how: 'never cut: it is what the answer is for' },
};
const CUT_ORDER = ['documents', 'history', 'examples', 'tools', 'other', 'system', 'question'];

export const DEFAULT_PARTS = `=== system ===
You are a firmware support engineer for the Redline modem board (STM32F407 + Quectel EG25-G).
Answer from the logs and documents provided. Quote the log line you rely on.
If the documents do not say, say so; do not guess register values or AT command syntax.
Answer in English, short paragraphs, code in fenced blocks.

=== tools ===
[{"name":"read_register","description":"Read a 32-bit peripheral register over SWD and return it in hex.","input_schema":{"type":"object","properties":{"address":{"type":"string","description":"Hex address, e.g. 0x40011000"}},"required":["address"]}},
 {"name":"send_at","description":"Send one AT command to the modem UART and return the reply lines until OK or ERROR.","input_schema":{"type":"object","properties":{"cmd":{"type":"string"},"timeout_ms":{"type":"integer","default":3000}},"required":["cmd"]}},
 {"name":"search_docs","description":"Full-text search over the board's datasheets and app notes; returns the 5 best passages.","input_schema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}]

=== history ×18 ===
User: The modem drops off the bus roughly every 40 minutes; the watchdog then resets the MCU. Log attached below.
Assistant: The reset follows "+QIURC: \\"pdpdeact\\",1" by 212 ms, and the UART RX ring buffer shows an overrun (ORE set in USART3->SR = 0x000000E8) just before it. The PDP deactivation is the carrier's; the reset is ours: the handler blocks in HAL_UART_Transmit while RX overruns. Try moving the URC parser out of the ISR and enable the RX DMA in circular mode.

=== retrieved documents ×56 ===
[EG25-G AT Commands Manual v2.0, §2.21 AT+QCFG="urc/ri/ring"] The RI behaviour when a URC is reported can be configured: "pulse" (default) pulls RI low for 120 ms, "always" keeps it low until the host reads the URC, "auto" returns it high after the URC is read. When the host MCU sleeps, use "pulse" with a GPIO wake-up on the falling edge, otherwise URCs that arrive during a UART baud switch can be lost. The setting is saved to NVM with AT&W and survives a reset. Example: AT+QCFG="urc/ri/other","pulse",120 then AT&W.
[RM0090 §30.6.1 USART_SR] Bit 3 ORE: overrun error. Set by hardware when the word currently being received in the shift register is ready to be transferred into the RDR register while RXNE=1. An interrupt is generated if RXNEIE=1 in USART_CR1. Cleared by a software sequence (a read to USART_SR followed by a read to USART_DR). When ORE is set the RDR content is not lost but the shift register is overwritten.
[Board app note AN-07, UART design] Run the modem UART at 115200 baud 8N1 with hardware flow control (RTS/CTS on PB14/PB13). Do not print debug text from the RX interrupt; a 60-byte printf at 115200 blocks for 5.2 ms, longer than three received characters.

=== modem log uart3_2026-09-28.txt = 110k ===
(attached separately: 41 minutes of URC and debug output, ~110k tokens by tiktoken o200k_base)

=== question ===
Given the log and the documents, why does the watchdog reset follow the PDP deactivation, and what is the smallest firmware change that stops it? Include the register evidence.
`;

const KIND_NAMES = Object.keys(KINDS);
const num = (v, d = 0) => { const n = Number(String(v ?? '').replace(/[_\s,]/g, '').replace(/k$/i, 'e3').replace(/m$/i, 'e6')); return Number.isFinite(n) ? n : d; };
const fmt = (n) => Math.round(n).toLocaleString('en-US');
export const short = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `${Number((n / 1e6).toFixed(a >= 1e7 ? 1 : 2))}M`;
  if (a >= 1e3) return `${Number((n / 1e3).toFixed(a >= 1e5 ? 0 : 1))}K`;
  return String(Math.round(n));
};

/** `=== name ×N ===` or `=== name = 40k ===` headers -> [{name, kind, text, mult, fixed}].
 * A fixed size is in o200k-style tokens (what tiktoken would count) and is
 * scaled by each model's factor like an estimate. */
export function parseParts(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const parts = [];
  const problems = [];
  let cur = null;
  const head = /^\s*={3,}\s*(.+?)\s*={3,}\s*$/;
  for (const line of lines) {
    const m = head.exec(line);
    if (m) {
      let name = m[1], mult = 1, fixed = null;
      const fx = /\s*=\s*([\d.,_]+\s*[kKmM]?)\s*(?:tokens?|tok)?$/.exec(name);
      if (fx) { fixed = num(fx[1].replace(/\s/g, ''), NaN); name = name.slice(0, fx.index); if (!Number.isFinite(fixed) || fixed < 0) { problems.push(`"${m[1]}": the size after = does not read as a token count; ignored.`); fixed = null; } }
      const mx = /\s*[×xX*]\s*(\d+(?:\.\d+)?)$/.exec(name);
      if (mx) { mult = Number(mx[1]); name = name.slice(0, mx.index); if (!(mult > 0) || mult > 100000) { problems.push(`"${m[1]}": the ×${mx[1]} multiplier is out of range; using ×1.`); mult = 1; } }
      if (/[×]|\s=\s|\s=\S|\sx\s?\S+$/.test(name) && mult === 1 && fixed == null) problems.push(`"${m[1]}": looks like a size but does not read; write ×20 (a count) or = 40k (tokens). Counted once.`);
      name = name.trim() || `part ${parts.length + 1}`;
      cur = { name, text: '', mult, fixed };
      parts.push(cur);
      continue;
    }
    if (!cur) { if (!line.trim()) continue; cur = { name: 'text', text: '', mult: 1, fixed: null }; parts.push(cur); }
    cur.text += (cur.text ? '\n' : '') + line;
  }
  for (const p of parts) {
    p.text = p.text.replace(/\n+$/, '');
    const k = KIND_NAMES.find((k) => KINDS[k].re && KINDS[k].re.test(p.name));
    p.kind = k || 'other';
  }
  return { parts, problems };
}

/** The parts back to text, the inverse of parseParts. */
export function joinParts(parts) {
  return parts.map((p) => `=== ${p.name}${p.fixed != null ? ` = ${p.fixed}` : p.mult !== 1 ? ` ×${p.mult}` : ''} ===\n${p.text}`).join('\n\n') + '\n';
}

// Chat framing: each message costs a few tokens of role markers (OpenAI's
// cookbook counts 3 per message plus 3 for the reply primer; others are
// similar). Lines that start a message ("User:", "Assistant:") add 4.
const MSG = /^(user|assistant|system|human|ai|tool)\s*:/gim;

export function run(input) {
  const warnings = [], notes = [];
  const { parts, problems } = parseParts(input.parts);
  warnings.push(...problems);
  if (!parts.length) warnings.push('No text to count. Paste a prompt, or split it into parts with lines like "=== system ===".');

  const reserve = Math.max(0, Math.round(num(input.reserve, 0)));
  const basis = input.basis === 'estimate' ? 'estimate' : 'high';

  // ---- parts ----
  const P = parts.map((p, i) => {
    const e = estimate(p.text);
    const msgs = (p.text.match(MSG) || []).length;
    const each = { o200k: e.o200k + 4 * msgs, cl100k: e.cl100k + 4 * msgs };
    const o = p.fixed != null ? p.fixed : each.o200k * p.mult;
    const c = p.fixed != null ? p.fixed : each.cl100k * p.mult;
    return { i, name: p.name, kind: p.kind, mult: p.mult, fixed: p.fixed, chars: e.chars, o200k: Math.round(o), cl100k: Math.round(c),
      band: p.fixed != null ? 0 : e.band, script: p.fixed != null ? 'fixed size' : e.script, msgs, each: each.o200k };
  });
  const sum = (k) => P.reduce((a, p) => a + p[k], 0);
  const totO = sum('o200k'), totC = sum('cl100k');
  const bandO = totO ? P.reduce((a, p) => a + p.o200k * p.band, 0) / totO : 0;

  // ---- models ----
  const rows = Array.isArray(input.models) ? input.models : [];
  const bad = [];
  const M = rows.map((r, idx) => {
    const name = String(r.name || `model ${idx + 1}`).trim();
    const ctx = num(r.ctx, NaN), out = num(r.out, NaN), factor = num(r.factor, 1);
    if (!(ctx > 0)) { bad.push(`${name}: context window "${r.ctx ?? ''}" is not a number, row skipped`); return null; }
    const enc = r.enc === 'cl100k' ? 'cl100k' : 'o200k';
    const mode = r.mode === 'separate' ? 'separate' : 'shared';
    const f = factor > 0 && factor < 5 ? factor : 1;
    if (f !== factor) bad.push(`${name}: factor "${r.factor}" is outside 0-5; using 1`);
    const band = Math.min(0.6, bandO + (Math.abs(f - 1) > 1e-9 ? 0.1 : 0));
    const est = (enc === 'o200k' ? totO : totC) * f;
    const hi = est * (1 + band), lo = est * (1 - band);
    const input = basis === 'high' ? hi : est;
    const outMax = out > 0 ? out : Infinity;
    const res = Math.min(reserve, outMax);
    const inLimit = mode === 'shared' ? ctx - res : ctx;
    const over = Math.max(0, input - inLimit);
    const room = mode === 'shared' ? Math.max(0, Math.min(outMax, ctx - input)) : (input <= ctx ? outMax : 0);
    const segs = P.map((p) => ({ i: p.i, t: Math.round((enc === 'o200k' ? p.o200k : p.cl100k) * f * (basis === 'high' ? 1 + band : 1)) }));
    return { idx, name, ctx, out: out > 0 ? out : null, enc, factor: f, mode, est: Math.round(est), lo: Math.round(lo), hi: Math.round(hi),
      input: Math.round(input), reserve: res, capped: reserve > res, over: Math.round(over), room: Math.round(room),
      used: Math.round(mode === 'shared' ? input + res : input), fits: over <= 0, share: input / ctx, segs };
  }).filter(Boolean);
  if (bad.length) warnings.push(`Model table: ${bad.join('; ')}.`);

  // ---- target and what to cut ----
  const tq = String(input.target || '').trim().toLowerCase();
  const target = M.find((m) => m.name.toLowerCase() === tq) || M.find((m) => tq && m.name.toLowerCase().includes(tq))
    || M.find((m) => !m.fits) || M[0] || null;
  const cuts = [];
  if (target && target.over > 0) {
    let need = target.over;
    const scale = target.input / Math.max(1, target.enc === 'o200k' ? totO : totC);
    for (const kind of CUT_ORDER) {
      if (need <= 0) break;
      for (const p of P.filter((q) => q.kind === kind).sort((a, b) => b.o200k - a.o200k)) {
        if (need <= 0) break;
        const have = (target.enc === 'o200k' ? p.o200k : p.cl100k) * scale;
        const can = have * KINDS[kind].cut;
        if (can < 1) continue;
        const take = Math.min(can, need);
        need -= take;
        cuts.push({ part: p.name, i: p.i, kind, cut: Math.round(take), of: Math.round(have), pct: Math.round((take / have) * 100), how: KINDS[kind].how });
      }
    }
    if (need > 0) cuts.push({ part: '(still over)', i: -1, kind: 'none', cut: Math.round(need), of: 0, pct: 0, how: `even after the usual cuts it is ${fmt(need)} over: lower the reserved output, or pick a model with a larger window` });
  }

  // ---- warnings ----
  const over = M.filter((m) => !m.fits);
  if (over.length) warnings.push(`Over the window for ${over.length} of ${M.length} models (${basis === 'high' ? 'using the high end of the estimate' : 'using the estimate'}): ${over.map((m) => `${m.name} by ${short(m.over)}`).join(', ')}.${target && !target.fits ? ` For ${target.name}, cut in the order shown under "What to cut first".` : ''}`);
  const capped = M.filter((m) => m.capped);
  if (capped.length) warnings.push(`Reserved output ${fmt(reserve)} is more than the max output of ${capped.map((m) => `${m.name} (${short(m.out)})`).join(', ')}; the bar uses their limit.`);
  const tight = M.filter((m) => m.fits && m.mode === 'shared' && m.room < reserve * 1.0 && m.room < 4096);
  if (tight.length) warnings.push(`Little room for the answer on ${tight.map((m) => `${m.name} (${short(m.room)})`).join(', ')}: a long answer will be cut off (stop reason max_tokens / length).`);
  if (P.some((p) => p.script.startsWith('other script'))) warnings.push('Part of the text is in a script the estimator was not calibrated on (Arabic, Devanagari, Thai...): its count can be off by up to half. Count it with the provider\'s tokenizer before relying on a tight fit.');
  const q = P.find((p) => p.kind === 'question');
  if (P.length > 1 && q && q.i !== P.length - 1) notes.push('The question is not the last part. Most providers recommend long documents first and the question at the end; it also keeps a cacheable prefix stable.');
  const docs = P.filter((p) => p.kind === 'documents').reduce((a, p) => a + p.o200k, 0);
  if (totO && docs / totO > 0.6 && totO > 50000) notes.push(`Documents are ${Math.round((docs / totO) * 100)} % of the prompt. Put them before the instructions' final restatement and consider prompt caching for the stable prefix.`);

  notes.push(`Token counts are ESTIMATES (method in estimate.js): the text is split like o200k_base and each piece costed from tables fitted to the real o200k_base and cl100k_base vocabularies; measured error ±7 % on English and logs, ±13 % on code, ±18 % on other languages. The bars use ${basis === 'high' ? 'the high end of that band' : 'the estimate itself'}.`);
  notes.push('Claude, Gemini and Llama-family tokenizers are not run here: their rows start from the o200k or cl100k estimate times an allowance (factor). For an exact count use the provider\'s counter: Anthropic /v1/messages/count_tokens, OpenAI tiktoken, Gemini countTokens.');
  notes.push(`Model limits are a table as of ${AS_OF}, edited on the page; check each row against the provider's model page (Anthropic's Models API returns max_input_tokens and max_tokens). Rows other than Claude's are not verified here.`);
  notes.push('"shared" means input + output must fit the window together (Claude, OpenAI); "separate" means the input limit and the output limit are separate (Gemini).');

  // ---- tables and text ----
  const partRows = P.map((p) => [p.name, p.kind, p.fixed != null ? `= ${fmt(p.fixed)}` : p.mult !== 1 ? `×${p.mult}` : '', p.o200k, p.cl100k,
    totO ? `${((p.o200k / totO) * 100).toFixed(1)} %` : '0 %', p.band ? `±${Math.round(p.band * 100)} %` : 'exact', p.script]);
  const modelRows = M.map((m) => [m.name, m.ctx, m.out ?? '–', `${m.enc}×${m.factor}`, m.input, m.reserve, m.fits ? 'fits' : `over ${fmt(m.over)}`, m.room, `${(m.share * 100).toFixed(1)} %`]);
  const md = [
    `Context budget (estimates; limits as of ${AS_OF}, verify with the provider)`,
    '',
    `Prompt: ~${fmt(totO)} tokens (o200k est., ±${Math.round(bandO * 100)} %), ~${fmt(totC)} (cl100k est.). Reserved for the answer: ${fmt(reserve)}.`,
    '',
    '| Part | Kind | Tokens (o200k) | Share |', '|---|---|---:|---:|',
    ...P.map((p) => `| ${p.name}${p.mult !== 1 ? ` ×${p.mult}` : ''} | ${p.kind} | ${fmt(p.o200k)} | ${totO ? ((p.o200k / totO) * 100).toFixed(1) : 0} % |`),
    '',
    `| Model | Window | Max out | Input (${basis === 'high' ? 'high est.' : 'est.'}) | Reserve | Fit | Room for answer |`, '|---|---:|---:|---:|---:|---|---:|',
    ...M.map((m) => `| ${m.name} | ${fmt(m.ctx)} | ${m.out ? fmt(m.out) : '–'} | ${fmt(m.input)} | ${fmt(m.reserve)} | ${m.fits ? 'fits' : `over by ${fmt(m.over)}`} | ${fmt(m.room)} |`),
    ...(cuts.length ? ['', `What to cut first for ${target.name} (over by ${fmt(target.over)}):`, ...cuts.map((c, k) => `${k + 1}. ${c.part}: cut ~${fmt(c.cut)}${c.of ? ` of ${fmt(c.of)} (${c.pct} %)` : ''} - ${c.how}`)] : []),
  ].join('\n');

  const fitsN = M.filter((m) => m.fits).length;
  return {
    values: [
      { label: 'Prompt, o200k estimate', value: totO, unit: 'tokens', hint: `±${Math.round(bandO * 100)} % (${fmt(totO * (1 - bandO))}–${fmt(totO * (1 + bandO))})` },
      { label: 'Prompt, cl100k estimate', value: totC, unit: 'tokens' },
      { label: 'Characters', value: sum('chars') },
      { label: 'Reserved output', value: reserve, unit: 'tokens' },
      { label: 'Models it fits', value: `${fitsN} of ${M.length}`, tone: fitsN === M.length ? 'ok' : fitsN ? 'warn' : 'bad' },
      ...(target ? [{ label: `Room for the answer on ${target.name}`, value: target.room, unit: 'tokens', tone: target.fits ? (target.room >= reserve ? 'ok' : 'warn') : 'bad' }] : []),
    ],
    tables: [
      { title: 'Parts', columns: ['Part', 'Kind', 'Size', 'o200k est.', 'cl100k est.', 'Share', 'Band', 'Text'], rows: partRows },
      { title: `Models (limits as of ${AS_OF}, verify)`, columns: ['Model', 'Window', 'Max out', 'Basis', 'Input', 'Reserve', 'Fit', 'Room for answer', 'Window used'], rows: modelRows },
      ...(cuts.length ? [{ title: `What to cut first for ${target.name}`, columns: ['Part', 'Kind', 'Cut', 'Of', 'Share cut', 'How'], rows: cuts.map((c) => [c.part, c.kind, c.cut, c.of, `${c.pct} %`, c.how]) }] : []),
    ],
    texts: [{ title: 'Budget table', body: md + '\n' }],
    warnings,
    notes,
    draw: { parts: P, models: M, target: target ? target.idx : -1, cuts, reserve, basis, bandO, totO, totC },
  };
}
