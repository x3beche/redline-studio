// FMEA Lite: failure modes scored 1-10 for severity (S), occurrence (O) and
// detection (D) and put in risk order.
//   RPN = S x O x D   (1..1000)      AIAG FMEA 4th ed. (2008); IEC 60812:2018 annex on RPN
//   Criticality = S x O (1..100)     IEC 60812 / MIL-STD-1629A-style criticality without detection
// Ranking ties are broken by S, then O (a severe mode outranks a frequent one at equal score).
// High severity is actioned whatever its score (AIAG: S 9-10 = safety / regulatory).
// Pareto: how many modes make up 80 % of the total score (Juran's vital few).
import { fmtNum } from '../kit/eng.js';

const int10 = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

export function run({ modes, method, rpnMin, soMin, sevMin }) {
  const warnings = [], notes = [];
  const rows = Array.isArray(modes) ? modes : [];
  const useD = method !== 'so';
  const limit = useD ? (rpnMin > 0 ? rpnMin : 100) : (soMin > 0 ? soMin : 30);
  const sevLimit = sevMin > 0 ? sevMin : 9;
  if (useD && !(rpnMin > 0)) warnings.push('RPN action threshold must be above 0; 100 was used.');
  if (!useD && !(soMin > 0)) warnings.push('S×O action threshold must be above 0; 30 was used.');
  if (useD && limit > 1000) warnings.push(`An RPN threshold of ${limit} is above the maximum 1000: nothing is actioned by score.`);
  if (!useD && limit > 100) warnings.push(`An S×O threshold of ${limit} is above the maximum 100: nothing is actioned by score.`);

  const items = [];
  const bad = [];
  rows.forEach((r, i) => {
    const label = String(r?.item ?? '').trim(), mode = String(r?.mode ?? '').trim();
    if (!label && !mode) return;
    const s = int10(r?.s), o = int10(r?.o), d = int10(r?.d);
    const need = useD ? [['S', s, r.s], ['O', o, r.o], ['D', d, r.d]] : [['S', s, r.s], ['O', o, r.o]];
    const wrong = need.filter(([, v]) => v == null || !Number.isInteger(v) || v < 1 || v > 10);
    if (wrong.length) { bad.push(`row ${i + 1} (${label || mode}): ${wrong.map(([k, v, raw]) => `${k} ${v == null ? 'missing' : `"${raw}"`}`).join(', ')}`); return; }
    const score = useD ? s * o * d : s * o;
    items.push({ row: i + 1, label: label || '–', mode: mode || '–', effect: String(r?.effect ?? '').trim(), cause: String(r?.cause ?? '').trim(), s, o, d: useD ? d : null, score, action: String(r?.action ?? '').trim() });
  });
  if (bad.length) warnings.push(`Skipped, scores must be whole numbers 1 to 10: ${bad.join('; ')}.`);
  if (!items.length) return { warnings: [...warnings, 'Add failure modes with S, O' + (useD ? ' and D' : '') + ' scored 1-10.'] };

  items.sort((a, b) => b.score - a.score || b.s - a.s || b.o - a.o);
  const total = items.reduce((t, x) => t + x.score, 0);
  let run = 0, vital = 0;
  for (const x of items) { if (run < 0.8 * total) { run += x.score; vital++; } }
  for (const x of items) {
    const why = [];
    if (x.score >= limit) why.push(`${useD ? 'RPN' : 'S×O'} ≥ ${limit}`);
    if (x.s >= sevLimit) why.push(`S ≥ ${sevLimit}`);
    x.why = why;
  }
  const act = items.filter((x) => x.why.length);
  const noPlan = act.filter((x) => !x.action);
  const hidden = items.filter((x) => x.s >= sevLimit && x.score < limit);
  const top = items[0];

  const values = [
    { label: 'Failure modes', value: items.length },
    { label: 'Need action', value: act.length, tone: act.length ? 'warn' : 'ok', hint: `${useD ? 'RPN' : 'S×O'} ≥ ${limit} or S ≥ ${sevLimit}` },
    { label: 'Without a planned action', value: noPlan.length, tone: noPlan.length ? 'bad' : 'ok' },
    { label: `Highest ${useD ? 'RPN' : 'S×O'}`, value: top.score, hint: `${top.label}: ${top.mode}` },
    { label: '80 % of the risk in', value: `${vital} of ${items.length}`, hint: 'Pareto: fix these first' },
    { label: `Mean ${useD ? 'RPN' : 'S×O'}`, value: fmtNum(total / items.length, 3) },
  ];
  if (hidden.length) notes.push(`${hidden.map((x) => x.mode).join(', ')}: severity ${sevLimit}+ but a low ${useD ? 'RPN' : 'score'}. A product score hides rare catastrophic failures, which is why severity is actioned on its own.`);
  if (noPlan.length) warnings.push(`${noPlan.length} mode${noPlan.length > 1 ? 's need' : ' needs'} action but ${noPlan.length > 1 ? 'have' : 'has'} none planned: ${noPlan.map((x) => x.mode).join(', ')}. Add a design change that lowers S or O, or a test that raises detection.`);
  const counts = new Map();
  for (const x of items) counts.set(x.score, (counts.get(x.score) || 0) + 1);
  const ties = [...counts].filter(([, n]) => n > 1).length;
  if (ties) notes.push(`${ties} score${ties > 1 ? 's are' : ' is'} shared by several modes; ties are ordered by severity, then occurrence.`);
  notes.push(useD
    ? 'RPN = S × O × D, each 1-10 (detection 10 = cannot be detected). AIAG-VDA 2019 replaces RPN with Action Priority tables; RPN is still the IEC 60812 / AIAG 4th edition method.'
    : 'Criticality = S × O, detection not scored. Use it early in design, before test coverage is known.');

  const cols = useD ? ['#', 'Item', 'Failure mode', 'Effect', 'S', 'O', 'D', 'RPN', 'Share', 'Action?'] : ['#', 'Item', 'Failure mode', 'Effect', 'S', 'O', 'S×O', 'Share', 'Action?'];
  const tables = [{
    title: 'Risk order',
    columns: cols,
    rows: items.map((x, i) => [i + 1, x.label, x.mode, x.effect || '–', x.s, x.o, ...(useD ? [x.d] : []), x.score, `${fmtNum((100 * x.score) / total, 3)} %`, x.why.length ? `yes (${x.why.join(', ')})` : 'no']),
  }];
  const charts = [{ title: `${useD ? 'RPN' : 'S×O'} per failure mode, highest first`, type: 'bars', x: items.map((x, i) => `${i + 1}`), series: [{ name: useD ? 'RPN' : 'S×O', y: items.map((x) => x.score) }] }];
  const list = act.map((x, i) => `${i + 1}. ${x.label} - ${x.mode} (S${x.s} O${x.o}${useD ? ` D${x.d}` : ''} = ${x.score}; ${x.why.join(', ')})${x.cause ? `\n   Cause: ${x.cause}` : ''}${x.effect ? `\n   Effect: ${x.effect}` : ''}\n   Action: ${x.action || 'OPEN - none planned'}`).join('\n');
  return { values, tables, charts, warnings, notes,
    texts: [{ title: 'Action list', body: act.length ? `Failure modes needing action (${act.length}):\n\n${list}\n` : 'No failure mode is over the thresholds.\n', lang: 'text' }] };
}
