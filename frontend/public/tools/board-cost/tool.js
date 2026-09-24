// Bare-board fabrication cost, a parametric estimate (rule of thumb).
//
//   cost = region × lead time × [ setup(layers) + option setups
//            + area × rate(layers) × small-order factor × Π option multipliers ]
//   small-order factor = 1 + 2 / (1 + area / 0.2 m²)
//     (online fabs price small areas at up to 3× their volume rate)
//
// Rates are calibrated by hand to 2024-2025 public price calculators of large
// Asian prototype/volume fabs, without promotional prices or shipping:
// e.g. 2-layer 100 × 100 mm: ~13 USD for 10, ~46 USD for 100, ~320 USD for 1000.
// Expect ±50 %; get a quote before committing.
import { fmtNum } from '../kit/eng.js';

// USD per m² of board at volume, and per-order setup (engineering, tooling, test)
const LAYERS = {
  1: { rate: 20, setup: 5 }, 2: { rate: 30, setup: 6 }, 4: { rate: 65, setup: 25 }, 6: { rate: 110, setup: 60 },
  8: { rate: 160, setup: 100 }, 10: { rate: 220, setup: 150 }, 12: { rate: 280, setup: 200 },
};
const THICK = { '0.4': 1.2, '0.6': 1.1, '0.8': 1, '1.0': 1, '1.2': 1, '1.6': 1, '2.0': 1.15, '2.4': 1.3, '3.2': 1.5 };
const COPPER = { 1: 1, 2: 1.3, 3: 1.6 };
const FINISH = {
  hasl: { name: 'HASL (leaded)', k: 1, add: 0 },
  haslf: { name: 'HASL lead-free', k: 1.03, add: 0 },
  osp: { name: 'OSP', k: 1, add: 0 },
  enig: { name: 'ENIG', k: 1.15, add: 10 },
  silver: { name: 'Immersion silver', k: 1.1, add: 10 },
  hardgold: { name: 'Hard gold', k: 1.5, add: 40 },
};
const TRACE = { '6': 1, '5': 1.05, '4': 1.15, '3': 1.4 };
const DRILL = { '0.3': 1, '0.25': 1.05, '0.2': 1.12, '0.15': 1.25 };
const LEAD = { standard: { name: 'Standard (5-7 days)', k: 1 }, quick: { name: 'Quick (2-3 days)', k: 1.4 }, express: { name: 'Express (24 h)', k: 2 } };
const REGION = { asia: { name: 'Asian online fab', k: 1 }, local: { name: 'US / EU quick-turn fab', k: 3 } };
const OPTIONS = [
  ['impedance', 'Impedance control', 1.05, 15],
  ['viainpad', 'Via-in-pad (filled, capped)', 1.25, 30],
  ['blind', 'Blind / buried vias', 1.8, 150],
  ['castellated', 'Castellated holes', 1.1, 10],
  ['fingers', 'Gold fingers, bevelled', 1.05, 15],
];

function estimate(p, qty) {
  const L = LAYERS[p.layers] || LAYERS[2];
  const area = (qty * p.w * p.h) / 1e6; // m²
  const small = 1 + 2 / (1 + area / 0.2);
  const lines = [];
  let mult = 1, setup = L.setup;
  const f = FINISH[p.finish] || FINISH.hasl;
  const parts = [
    ['Thickness', THICK[p.thick] ?? 1, 0], ['Copper', COPPER[p.copper] ?? 1, 0], [`Finish: ${f.name}`, f.k, f.add],
    ['Mask colour', p.color === 'green' ? 1 : 1.03, 0], ['Trace/space', TRACE[p.trace] ?? 1, 0], ['Smallest drill', DRILL[p.drill] ?? 1, 0],
    ...OPTIONS.filter((o) => p[o[0]]).map((o) => [o[1], o[2], o[3]]),
  ];
  for (const [, k, add] of parts) { mult *= k; setup += add; }
  const base = area * L.rate * small;
  const areaCost = base * mult;
  const factor = (LEAD[p.lead] || LEAD.standard).k * (REGION[p.region] || REGION.asia).k;
  const total = (setup + areaCost) * factor;
  lines.push(['Setup, tooling, test', setup * factor], ['Board area', base * factor], ['Options on area', (areaCost - base) * factor]);
  return { total, per: total / qty, area, small, base, mult, setup, factor, parts, lines };
}

export function run(input) {
  const { w, h, qty } = input;
  const warnings = [];
  if (!(w > 0 && h > 0)) return { warnings: ['Give the board width and height in mm, e.g. 100 × 80.'] };
  if (!(qty >= 1)) return { warnings: ['Give how many boards, e.g. 10.'] };
  const q = Math.round(qty);
  const layers = Number(input.layers) || 2;
  if (Math.max(w, h) > 500) warnings.push('Longer than 500 mm: beyond most fabs\' standard panel; expect a special quote.');
  if (Math.min(w, h) < 10) warnings.push('Under 10 mm: fabs charge a minimum size or ask for a panel; order it panelized.');
  if (layers < 4 && input.blind) warnings.push('Blind/buried vias need 4 or more layers: the option is ignored for this layer count.');
  if (layers === 1 && (input.viainpad || input.impedance)) warnings.push('Single-sided boards have no plated vias or reference plane: via-in-pad and impedance control make no sense here.');
  if (input.trace === '3' && layers < 4) warnings.push('3 mil trace/space on a 2-layer board is at the edge of most online fabs: check they offer it.');
  const p = { ...input, layers, blind: input.blind && layers >= 4 };
  const e = estimate(p, q);
  const perCm2 = e.per / ((w * h) / 100);
  const values = [
    { label: `Estimated total for ${q}`, value: fmtNum(e.total, 4), unit: 'USD', tone: 'ok', hint: '±50 %, before shipping and tax' },
    { label: 'Per board', value: fmtNum(e.per, 3), unit: 'USD' },
    { label: 'Per cm² of board', value: fmtNum(perCm2, 3), unit: 'USD' },
    { label: 'Board area ordered', value: fmtNum(e.area, 3), unit: 'm²', hint: `small-order factor ${fmtNum(e.small, 3)}×` },
    { label: 'Setup share', value: fmtNum((100 * e.setup * e.factor) / e.total, 3), unit: '%', hint: 'falls with quantity' },
  ];
  const rows = [
    ...e.lines.map(([k, v]) => [k, fmtNum(v, 4)]),
    ...e.parts.filter(([, k, add]) => k !== 1 || add).map(([n, k, add]) => [`  ${n}`, `×${fmtNum(k, 3)}${add ? ` + ${add} setup` : ''}`]),
    ['Lead time', `×${(LEAD[input.lead] || LEAD.standard).k}`],
    ['Region', `×${(REGION[input.region] || REGION.asia).k}`],
  ];
  const qs = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  const curve = qs.map((n) => estimate(p, n));
  return {
    values,
    warnings,
    charts: [{ title: 'Cost per board against quantity', type: 'bars', x: qs.map(String), series: [{ name: 'USD per board', y: curve.map((c) => Number(fmtNum(c.per, 3))) }], xLabel: 'quantity', yLabel: 'USD per board' }],
    tables: [
      { title: 'Where the money goes (USD)', columns: ['Item', 'Amount'], rows },
      { title: 'At other quantities', columns: ['Quantity', 'Total USD', 'Per board USD'], rows: qs.map((n, i) => [n, fmtNum(curve[i].total, 4), fmtNum(curve[i].per, 3)]) },
    ],
    notes: [
      'A parametric estimate, not a quote: rates are fitted by hand to public calculators of large online fabs (2024-2025), without promotional prices, shipping or tax.',
      'FR-4, standard Tg, 1 oz outer copper, green mask, white silkscreen, electrical test included are the base.',
      'Panel waste is folded into the per-area rate; odd outlines, slots and tight tolerances add cost not modelled here.',
    ],
  };
}
