// LLM Cost Calculator: one workload priced on every model of a price table.
//
// Per call, for a model with prices in, out, cw (cache write), cr (cache
// read), all in $ per million tokens (MTok):
//   prefix   = input x cached share          (the repeated, cacheable part)
//   uncached = input - prefix                 billed at `in`
//   reads    = prefix x hit                   billed at `cr`
//   writes   = prefix x (1 - hit)             billed at `cw`, or `in` when the
//                                             provider charges no write premium
//   output                                    billed at `out`
// A model with no cache-read price has no caching: the whole input is `in`.
// A batch row takes the provider's batch discount on all of it (Anthropic:
// batch and caching discounts stack - docs "Batch processing", "Pricing").
// Caching pays once hit x cr + (1 - hit) x cw < in, i.e. above
//   hit* = (cw - in) / (cw - cr)          (0 when there is no write premium)
// Anthropic 5-minute writes are 1.25 x in, 1-hour writes 2 x in, reads per
// model (docs "Prompt caching" -> Pricing).

import { parseEng, fmtNum } from '../kit/eng.js';

export const PRICES_AS_OF = '2026-09';

const num = (v, dflt = null) => {
  if (v === '' || v == null) return dflt;
  const n = parseEng(String(v).replace(/[$%]/g, ''));
  return n == null ? dflt : n;
};
const yes = (v) => /^(y|yes|true|1|on)$/i.test(String(v ?? '').trim());
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
export const money = (v) => {
  if (!Number.isFinite(v)) return '$0';
  const a = Math.abs(v);
  if (a >= 1e6) return `$${fmtNum(v / 1e6, 3)}M`;
  if (a >= 1e4) return `$${Math.round(v).toLocaleString('en-US')}`;
  if (a >= 100) return `$${v.toFixed(0)}`;
  if (a >= 1) return `$${v.toFixed(2)}`;
  if (a >= 0.01) return `$${v.toFixed(3)}`;
  return a === 0 ? '$0' : `$${v.toPrecision(2)}`;
};

export function run(input) {
  const warnings = [];
  const notes = [];
  const days = num(input.days, 30) > 0 ? num(input.days, 30) : 30;
  if (!(num(input.days, 30) > 0)) warnings.push('Days per month must be above 0; 30 is used.');
  let hitPct = num(input.hit, 90);
  if (hitPct == null || hitPct < 0 || hitPct > 100) { warnings.push(`Cache hit rate ${input.hit} is outside 0-100 %; it is clamped.`); hitPct = Math.min(100, Math.max(0, hitPct ?? 90)); }
  const hit = hitPct / 100;
  let sc = num(input.scale_calls, 1); if (!(sc > 0)) { warnings.push('Calls/day multiplier must be above 0; 1 is used.'); sc = 1; }
  let so = num(input.scale_out, 1); if (!(so >= 0)) { warnings.push('Output multiplier must be 0 or more; 1 is used.'); so = 1; }

  // ---- workload ----
  const work = [];
  (Array.isArray(input.workload) ? input.workload : []).forEach((r, i) => {
    const name = String(r?.name || `Job ${i + 1}`).trim();
    const calls = num(r?.calls), inp = num(r?.input), out = num(r?.output);
    let cached = num(r?.cached, 0);
    const bad = [];
    const ok = (v) => v != null && v >= 0;
    if (!ok(calls)) bad.push('calls/day');
    if (!ok(inp)) bad.push('input tokens');
    if (!ok(out)) bad.push('output tokens');
    if (bad.length) { warnings.push(`Workload "${name}": ${bad.join(', ')} not a number - the row is left out. Write e.g. 4000 or 4k.`); return; }
    if (cached < 0 || cached > 100) { warnings.push(`Workload "${name}": cached share ${cached} % is outside 0-100; clamped.`); cached = Math.min(100, Math.max(0, cached)); }
    work.push({ name, calls: calls * sc, input: inp, output: out * so, cached: cached / 100, batch: yes(r?.batch) });
  });
  if (!work.length) warnings.push('No workload rows could be read: add a row with calls/day, input and output tokens.');

  // ---- prices ----
  const models = [];
  const seen = new Set();
  (Array.isArray(input.prices) ? input.prices : []).forEach((r, i) => {
    const id = String(r?.model || '').trim() || `model ${i + 1}`;
    const pin = num(r?.in), pout = num(r?.out);
    if (pin == null || pout == null || pin < 0 || pout < 0) { warnings.push(`Price row "${id}": input and output prices must be numbers ($/MTok) - left out.`); return; }
    if (seen.has(id)) { warnings.push(`Price row "${id}" appears twice; the second is left out.`); return; }
    seen.add(id);
    const cr = num(r?.cr), cw = num(r?.cw);
    let batch = num(r?.batch, 0);
    if (batch < 0 || batch > 100) { warnings.push(`Price row "${id}": batch discount ${batch} % outside 0-100; 0 is used.`); batch = 0; }
    if (cr != null && cr > pin) warnings.push(`Price row "${id}": cache read ($${cr}) costs more than input ($${pin}) - check the row.`);
    models.push({ id, provider: String(r?.provider || '').trim() || 'Other', in: pin, out: pout,
      cw: cw != null && cw >= 0 ? cw : null, cr: cr != null && cr >= 0 ? cr : null, batch, on: r?.on == null ? true : yes(r.on) });
  });
  const cmp = models.filter((m) => m.on);
  if (!cmp.length) warnings.push('No model has Compare = yes in the price table.');

  // ---- cost ----
  function cost(m, w) {
    const perM = (tok, price) => (tok * price) / 1e6;
    let cin, ccw = 0, ccr = 0;
    if (m.cr != null && w.cached > 0) {
      const prefix = w.input * w.cached;
      cin = perM(w.input - prefix, m.in);
      ccr = perM(prefix * hit, m.cr);
      // A miss writes the cache: at the write price where there is one,
      // otherwise it is plain input (OpenAI, Gemini implicit, DeepSeek).
      if (m.cw != null) ccw = perM(prefix * (1 - hit), m.cw);
      else cin += perM(prefix * (1 - hit), m.in);
    } else cin = perM(w.input, m.in);
    const cout = perM(w.output, m.out);
    const k = w.batch && m.batch > 0 ? 1 - m.batch / 100 : 1;
    const month = w.calls * days;
    const noCache = (perM(w.input, m.in) + cout) * k * month;
    return { in: cin * k * month, out: cout * k * month, cw: ccw * k * month, cr: ccr * k * month, noCache, calls: month };
  }
  const rows = cmp.map((m) => {
    const per = work.map((w) => ({ w, c: cost(m, w) }));
    const sum = (k) => per.reduce((a, p) => a + p.c[k], 0);
    const t = { in: sum('in'), out: sum('out'), cw: sum('cw'), cr: sum('cr') };
    const total = t.in + t.out + t.cw + t.cr;
    const calls = sum('calls');
    const noCache = sum('noCache');
    const hasCache = m.cr != null;
    const premium = hasCache && m.cw != null && m.cw > m.in;
    const breakEven = !hasCache ? null : premium ? (m.cw - m.in) / (m.cw - m.cr) : 0;
    return { m, per, t, total, calls, perCall: calls ? total / calls : 0, noCache, saving: noCache - total, hasCache, breakEven };
  }).sort((a, b) => a.total - b.total);
  const cheapest = rows[0];
  const dear = rows[rows.length - 1];

  // Warnings that belong to the workload and the table, said once.
  const cachedWork = work.filter((w) => w.cached > 0);
  const noCacheModels = rows.filter((r) => !r.hasCache && cachedWork.length).map((r) => r.m.id);
  if (noCacheModels.length) notes.push(`No cache price for ${noCacheModels.join(', ')}: their cached share is billed as plain input.`);
  const batchWork = work.filter((w) => w.batch);
  const noBatch = rows.filter((r) => !(r.m.batch > 0) && batchWork.length).map((r) => r.m.id);
  if (noBatch.length) notes.push(`No batch discount in the table for ${noBatch.join(', ')}: batch rows are priced at the normal rate there.`);
  for (const r of rows) {
    if (r.breakEven != null && r.breakEven > 0 && hit < r.breakEven && cachedWork.length) {
      warnings.push(`${r.m.id}: at ${hitPct} % hits caching costs more than it saves (it pays above ${Math.ceil(r.breakEven * 100)} %). Keep the prefix warm (calls < 5 min apart) or do not mark it for caching.`);
    }
  }
  if (cheapest && dear && dear.total > 0 && cheapest.total > 0 && dear.total / cheapest.total > 50) notes.push(`The spread is ${fmtNum(dear.total / cheapest.total, 3)}x: compare quality on your own eval before choosing on price.`);
  notes.push(`Prices are a snapshot as of ${PRICES_AS_OF}: verify each row on the provider's pricing page (Anthropic rows from the Claude API reference of 2026-09-25; the other providers' rows were entered from memory and are unverified). OpenRouter prices vary by upstream provider.`);
  notes.push('Token counts are what you enter; different models tokenize the same text differently (up to ~1.35x), so a fixed text costs more tokens on some models. Long-context surcharges (above 200k tokens on some models), Gemini cache storage per hour, and 1-hour cache writes (2x input) are not modelled - use the Prompt Caching Planner for those.');

  // ---- focus ----
  const focusId = String(input.focus || '').trim();
  const focus = rows.find((r) => r.m.id === focusId) || cheapest;
  if (focusId && !rows.find((r) => r.m.id === focusId)) notes.push(`Model in focus "${focusId}" is not among the compared models; showing ${focus ? focus.m.id : 'none'}.`);

  const callsMonth = work.reduce((a, w) => a + w.calls * days, 0);
  const values = [];
  if (cheapest) {
    values.push({ label: 'Cheapest', value: money(cheapest.total), unit: '/month', hint: cheapest.m.id, tone: 'ok' });
    values.push({ label: 'Most expensive', value: money(dear.total), unit: '/month', hint: dear.m.id });
  }
  if (focus) {
    values.push({ label: `Focus: ${focus.m.id}`, value: money(focus.total), unit: '/month', hint: `${money(focus.perCall)} per call` });
    if (focus.hasCache && cachedWork.length) values.push({ label: 'Caching saves (focus)', value: money(focus.saving), unit: '/month', hint: focus.breakEven > 0 ? `pays above ${Math.ceil(focus.breakEven * 100)} % hits` : 'no write premium: always pays', tone: focus.saving >= 0 ? 'ok' : 'bad' });
  }
  values.push({ label: 'Calls per month', value: Math.round(callsMonth) });

  const tables = [];
  if (rows.length) tables.push({ title: `Monthly cost per model (${Math.round(callsMonth).toLocaleString('en-US')} calls)`, columns: ['#', 'Model', 'Provider', 'Input $', 'Output $', 'Cache write $', 'Cache read $', 'Total $/month', '$ per call', 'x cheapest', 'Caching pays above'],
    rows: rows.map((r, i) => [i + 1, r.m.id, r.m.provider, r2(r.t.in), r2(r.t.out), r2(r.t.cw), r2(r.t.cr), r2(r.total), r4(r.perCall),
      cheapest.total > 0 ? Number((r.total / cheapest.total).toFixed(2)) : 1,
      r.breakEven == null ? 'no cache' : r.breakEven > 0 ? `${Math.ceil(r.breakEven * 100)} % hits` : 'always']) });
  if (focus) tables.push({ title: `${focus.m.id}: per workload`, columns: ['Workload', 'Calls/month', 'Input $', 'Output $', 'Cache write $', 'Cache read $', 'Total $/month', '$ per call'],
    rows: focus.per.map((p) => { const t = p.c.in + p.c.out + p.c.cw + p.c.cr; return [p.w.name + (p.w.batch ? ' (batch)' : ''), Math.round(p.c.calls), r2(p.c.in), r2(p.c.out), r2(p.c.cw), r2(p.c.cr), r2(t), r4(p.c.calls ? t / p.c.calls : 0)]; }) });

  const csv = ['model,provider,input_usd,output_usd,cache_write_usd,cache_read_usd,total_usd_month,usd_per_call,calls_month',
    ...rows.map((r) => [r.m.id, r.m.provider, r.t.in.toFixed(2), r.t.out.toFixed(2), r.t.cw.toFixed(2), r.t.cr.toFixed(2), r.total.toFixed(2), r.perCall.toFixed(6), Math.round(r.calls)].map((c) => (/[,"]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(','))].join('\n') + '\n';

  let summary = 'Nothing to price.';
  if (cheapest && focus) {
    const wl = work.map((w) => `${w.name} (${Math.round(w.calls).toLocaleString('en-US')}/day, ${Math.round(w.input).toLocaleString('en-US')} in / ${Math.round(w.output).toLocaleString('en-US')} out tokens${w.cached ? `, ${Math.round(w.cached * 100)} % cached` : ''}${w.batch ? ', batch' : ''})`).join('; ');
    const outShare = focus.total > 0 ? Math.round((focus.t.out / focus.total) * 100) : 0;
    summary = `The workload - ${wl} - is about ${Math.round(callsMonth).toLocaleString('en-US')} calls a month over ${days} days. `
      + `On ${focus.m.id} it costs ${money(focus.total)} a month (${money(focus.perCall)} per call; output is ${outShare} % of it)`
      + (focus.hasCache && cachedWork.length ? `, of which caching at ${hitPct} % hits saves ${money(focus.saving)}` : '') + '. '
      + `The cheapest compared model is ${cheapest.m.id} at ${money(cheapest.total)}, the most expensive ${dear.m.id} at ${money(dear.total)}. `
      + `Prices as of ${PRICES_AS_OF}, to be verified at each provider's pricing page.`;
  }

  // Drawing data for the page (not sent to agents).
  const plot = {
    hit: hitPct, scale_calls: sc, scale_out: so, days, focus: focus ? focus.m.id : '', max: dear ? dear.total : 0, cheapest: cheapest ? cheapest.total : 0,
    models: rows.map((r) => ({ id: r.m.id, provider: r.m.provider, in: r.t.in, out: r.t.out, cw: r.t.cw, cr: r.t.cr, total: r.total, perCall: r.perCall,
      noCache: r.noCache, breakEven: r.breakEven, hasCache: r.hasCache, losing: r.breakEven != null && r.breakEven > hit && cachedWork.length > 0,
      per: r.per.map((p) => ({ name: p.w.name, total: p.c.in + p.c.out + p.c.cw + p.c.cr })) })),
    work: work.map((w) => ({ name: w.name, calls: w.calls, input: w.input, output: w.output, cached: w.cached, batch: w.batch })),
  };
  return { values, tables, texts: [{ title: 'CSV', body: csv, lang: 'csv' }, { title: 'Summary', body: summary + '\n' }], warnings, notes, plot };
}
