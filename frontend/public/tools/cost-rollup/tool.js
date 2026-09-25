// Total Cost Roll-Up: per-unit cost of a built product at an order quantity.
//   built units   = ceil(good units / yield)                      (build extra to cover fallout)
//   BOM line      = max(ceil(qty/unit × built × (1 + attrition)), MOQ) × unit price
//                   (attrition = setup and machine loss, typical 1-5 % for SMT reels; MOQ = minimum buy)
//   assembly      = placements × price per placement + hand work, per built unit, + setup per order
//   per good unit = (variable per built unit × built + BOM lines + one-time costs) / good units
// One-time (NRE) costs are spread over this order when "amortize" is on (the usual quote basis).
// This is standard cost roll-up arithmetic (e.g. Ulrich & Eppinger, Product Design and Development,
// ch. 13 "Design for manufacturing": unit cost = components + assembly + overhead).
import { fmtNum } from '../kit/eng.js';

const num = (v) => {
  const s = String(v ?? '').trim().replace(',', '.').replace(/^[$€£¥₺]/, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

function rollup(qty, p, bom) {
  const built = Math.ceil(qty / p.yieldF - 1e-9);
  const lines = bom.map((b) => {
    const need = b.per * built * (1 + b.attr);
    const buy = Math.max(Math.ceil(need - 1e-9), b.moq);
    return { ...b, need, buy, cost: buy * b.price, used: b.per * built, excess: Math.max(0, buy - b.per * built) * b.price };
  });
  const bomCost = lines.reduce((t, l) => t + l.cost, 0);
  const cat = [
    ['PCB', p.pcbUnit * built, p.pcbNre],
    ['BOM parts', bomCost, 0],
    ['Assembly', (p.places * p.perPlace + p.hand) * built, p.asmSetup],
    ['Enclosure', p.encUnit * built, p.encTool],
    ['Cables', p.cableUnit * built, 0],
    ['Test and packing', p.testUnit * built, 0],
    ['Freight and duty', 0, p.freight],
  ].map(([name, variable, once]) => ({ name, variable, once, total: variable + once }));
  const variable = cat.reduce((t, c) => t + c.variable, 0);
  const once = cat.reduce((t, c) => t + c.once, 0);
  return { built, lines, cat, variable, once, total: variable + once, perUnit: (variable + once) / qty, perUnitVar: variable / qty };
}

export function run(input) {
  const warnings = [], notes = [];
  const cur = String(input.currency ?? '').trim() || 'USD';
  const money = (v) => (Number.isFinite(v) ? `${v < 0.1 && v > 0 ? fmtNum(v, 3) : v.toFixed(2)} ${cur}` : '–');
  const big = (v) => (Number.isFinite(v) ? `${Math.round(v).toLocaleString('en-US')} ${cur}` : '–');
  let qty = input.qty;
  if (!(qty > 0)) return { warnings: ['Give the number of good units to deliver, e.g. 500.'] };
  if (!Number.isInteger(qty)) { warnings.push(`Quantity ${qty} rounded up to ${Math.ceil(qty)} units.`); qty = Math.ceil(qty); }
  const nonneg = (k, label) => {
    const v = input[k];
    if (v == null) return 0;
    if (v < 0) { warnings.push(`${label} cannot be negative; 0 was used.`); return 0; }
    return v;
  };
  let y = input.yieldPct == null ? 100 : input.yieldPct;
  if (!(y > 0 && y <= 100)) { warnings.push('Yield must be between 0 and 100 %; 100 % was used.'); y = 100; }
  else if (y < 80) warnings.push(`A ${y} % yield means building ${fmtNum(100 / y, 3)}× the units: fix the process or the test before ordering at this volume.`);
  const p = {
    yieldF: y / 100,
    pcbUnit: nonneg('pcbUnit', 'PCB price'), pcbNre: nonneg('pcbNre', 'PCB one-time cost'),
    places: nonneg('places', 'Placements'), perPlace: nonneg('perPlace', 'Price per placement'), hand: nonneg('hand', 'Hand work'), asmSetup: nonneg('asmSetup', 'Assembly setup'),
    encUnit: nonneg('encUnit', 'Enclosure price'), encTool: nonneg('encTool', 'Enclosure tooling'),
    cableUnit: nonneg('cableUnit', 'Cable cost'), testUnit: nonneg('testUnit', 'Test and packing'), freight: nonneg('freight', 'Freight'),
  };

  // ---- BOM ----
  const bom = [];
  (Array.isArray(input.bom) ? input.bom : []).forEach((r, i) => {
    const part = String(r?.part ?? '').trim() || `line ${i + 1}`;
    const per = num(r?.per), price = num(r?.price), moq = num(r?.moq), attr = num(r?.attr);
    if (per == null && price == null) return;
    const bad = [['qty per unit', per], ['unit price', price], ['MOQ', moq], ['attrition %', attr]].filter(([, v]) => Number.isNaN(v) || v < 0);
    if (bad.length) { warnings.push(`BOM "${part}": ${bad.map(([k]) => k).join(', ')} is not a number ≥ 0; the line was skipped.`); return; }
    if (per == null || price == null) { warnings.push(`BOM "${part}" needs both qty per unit and unit price; skipped.`); return; }
    if (attr != null && attr > 50) warnings.push(`BOM "${part}": ${attr} % attrition is unusual (1-5 % is typical); check it is a percentage.`);
    bom.push({ part, per, price, moq: moq ?? 0, attr: (attr ?? 0) / 100, row: i });
  });

  const R = rollup(qty, p, bom);
  const amort = input.amortize !== false;
  const shown = amort ? R.perUnit : R.perUnitVar;
  const excess = R.lines.reduce((t, l) => t + l.excess, 0);
  const bomTotal = R.cat[1].total;
  if (bomTotal > 0 && excess > 0.15 * bomTotal) {
    const worst = [...R.lines].sort((a, b) => b.excess - a.excess).slice(0, 3).filter((l) => l.excess > 0);
    warnings.push(`${big(excess)} of the BOM spend (${Math.round((100 * excess) / bomTotal)} %) is left-over stock from MOQs and attrition, mostly ${worst.map((l) => l.part).join(', ')}. Ask for cut tape, a lower MOQ, or reuse the reels on the next order.`);
  }
  if (R.once > 0 && amort && R.once / R.total > 0.3) notes.push(`One-time costs are ${Math.round((100 * R.once) / R.total)} % of this order: the unit price falls fast with volume (see the quantity table).`);

  const values = [
    { label: amort ? 'Cost per unit' : 'Cost per unit (no NRE)', value: money(shown), tone: 'ok' },
    { label: 'Order total', value: big(R.total), hint: `${qty} good units` },
    { label: 'Units to build', value: R.built, hint: y < 100 ? `${y} % yield` : null },
    { label: 'One-time (NRE)', value: big(R.once), hint: amort ? `${money(R.once / qty)} per unit` : 'not in the unit cost' },
    { label: 'BOM per unit', value: money(bomTotal / qty) },
    { label: 'MOQ / attrition excess', value: big(excess), tone: excess > 0.15 * bomTotal && bomTotal > 0 ? 'warn' : null },
  ];

  const per = (c) => (amort ? c.total : c.variable) / qty;
  const base = amort ? R.total : R.variable;
  const m2 = (v) => money(v).replace(` ${cur}`, '');
  const b2 = (v) => big(v).replace(` ${cur}`, '');
  const tables = [
    { title: 'Breakdown per good unit', columns: ['Category', `Per unit, ${cur}`, `Of which one-time`, `Order total, ${cur}`, 'Share'],
      rows: [...R.cat.filter((c) => c.total > 0).map((c) => [c.name, m2(per(c)), amort && c.once ? m2(c.once / qty) : '–', b2(c.total), `${fmtNum((100 * (amort ? c.total : c.variable)) / (base || 1), 3)} %`]),
        ['Total', m2(shown), amort ? m2(R.once / qty) : '–', b2(R.total), '100 %']] },
  ];
  if (R.lines.length) tables.push({ title: `BOM lines for ${R.built} built units`, columns: ['Part', 'Qty per unit', 'Needed', 'Buy', `Unit price, ${cur}`, `Line cost, ${cur}`, `Per good unit, ${cur}`, `Excess, ${cur}`],
    rows: R.lines.map((l) => [l.part, l.per, Math.ceil(l.need - 1e-9), l.buy, m2(l.price), b2(l.cost), m2(l.cost / qty), l.excess > 0 ? b2(l.excess) : '–']) });
  const qs = [...new Set([Math.max(1, Math.round(qty / 10)), Math.max(1, Math.round(qty / 2)), qty, qty * 2, qty * 5, qty * 10])];
  const sweep = qs.map((q) => { const r = rollup(q, p, bom); return { q, r }; });
  tables.push({ title: 'Other quantities (same unit prices)', columns: ['Good units', `Per unit, ${cur}`, `NRE per unit, ${cur}`, `Order total, ${cur}`],
    rows: sweep.map(({ q, r }) => [q, m2(amort ? r.perUnit : r.perUnitVar), m2(r.once / q), b2(r.total)]) });
  const charts = [{ title: 'Cost per unit by category', type: 'bars', x: R.cat.filter((c) => c.total > 0).map((c) => c.name),
    series: [{ name: `${cur} per unit`, y: R.cat.filter((c) => c.total > 0).map((c) => +per(c).toFixed(4)) }] }];
  notes.push('Unit prices are held fixed across quantities; real quotes drop at price breaks, so the other-quantity rows are an upper bound above this order and a lower bound below it.');
  notes.push('Not included: overhead, margin, certification, warranty reserve and currency risk.');
  // For the page's drawing only (manifest agentOmit): the categories and BOM
  // lines at this order, and the per-unit stack on a log grid of quantities.
  const KEYS = ['pcb', 'bom', 'asm', 'enc', 'cable', 'test', 'freight'];
  const grid = [];
  for (let e = 0; e <= 72; e++) grid.push(Math.round(10 ** (e / 12)));
  const qsCurve = [...new Set([...grid, qty])].sort((a, b) => a - b);
  const cost = {
    cur, qty, built: R.built, yieldPct: y, amortize: amort, perUnit: shown, total: R.total, once: R.once, variable: R.variable,
    bomTotal, excess,
    cats: R.cat.map((c, i) => ({ key: KEYS[i], name: c.name, variable: c.variable, once: c.once, total: c.total,
      perUnit: per(c), perUnitOnce: amort ? c.once / qty : 0, share: (amort ? c.total : c.variable) / (base || 1) })),
    lines: R.lines.map((l) => ({ row: l.row, part: l.part, per: l.per, price: l.price, moq: l.moq, attrPct: l.attr * 100,
      used: l.used, need: Math.ceil(l.need - 1e-9), buy: l.buy, cost: l.cost, excess: l.excess, perUnit: l.cost / qty })),
    curve: qsCurve.map((q) => {
      const r = rollup(q, p, bom);
      return { q, perUnit: amort ? r.perUnit : r.perUnitVar, v: r.cat.map((c) => c.variable / q), o: r.cat.map((c) => (amort ? c.once / q : 0)) };
    }),
  };
  return { values, tables, charts, warnings, notes, cost };
}
