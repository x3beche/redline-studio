// PCB assembly (PCBA) cost, a parametric estimate (rule of thumb).
//
//   per order  = sides × (setup + stencil) + unique parts × line/feeder fee
//                + extended (non-stock) parts × loading fee
//   per board  = SMT joints × joint rate  or  placements × placement rate
//                + THT joints × hand-solder rate + fine-pitch parts × inspection rate
//   total      = per order + qty × per board  (+ parts, with attrition)
//
// Two price structures, from public fee schedules (2024-2025):
//   online (JLC-style): charged per solder joint, a fee per unique "extended"
//     part not kept on the line's feeders, low setup;
//   contract manufacturer (US / EU prototype-to-mid volume): charged per
//     placement, per BOM line (kitting and feeder setup), higher NRE.
// Expect ±50 %; get a quote before committing.
import { fmtNum } from '../kit/eng.js';

const HOUSES = {
  econ: { name: 'Online, economic line', setup: 8, stencil: 1.5, joint: 0.0017, place: 0, unique: 0, extended: 3, tht: 0.0173, fine: 0.3 },
  std: { name: 'Online, standard line', setup: 25, stencil: 7.86, joint: 0.0017, place: 0, unique: 0, extended: 3, tht: 0.0173, fine: 0.3 },
  cm: { name: 'Contract manufacturer (US / EU)', setup: 250, stencil: 150, joint: 0, place: 0.035, unique: 3, extended: 0, tht: 0.1, fine: 0.5 },
};

function estimate(p, qty) {
  const H = HOUSES[p.house] || HOUSES.std;
  const sides = p.sides === 'two' ? 2 : 1;
  const joints = p.place * p.pads;
  const order = [
    ['Setup / programming', sides * H.setup],
    ['Stencil', sides * H.stencil],
    ['BOM lines (kitting, feeders)', p.unique * H.unique],
    ['Extended-part loading fees', p.extended * H.extended],
  ];
  const board = [
    [H.joint ? 'SMT solder joints' : 'SMT placements', H.joint ? joints * H.joint : p.place * H.place],
    ['THT hand soldering', p.thtJoints * H.tht],
    ['Fine-pitch / X-ray inspection', p.fine * H.fine],
  ];
  const perOrder = order.reduce((a, [, v]) => a + v, 0);
  const perBoard = board.reduce((a, [, v]) => a + v, 0);
  const assembly = perOrder + qty * perBoard;
  const parts = qty * p.bom * (1 + p.attrition);
  return { H, sides, joints, order, board, perOrder, perBoard, assembly, parts, total: assembly + parts };
}

export function run(input) {
  const warnings = [];
  const qty = Math.round(input.qty);
  if (!(qty >= 1)) return { warnings: ['Give how many boards to assemble, e.g. 50.'] };
  if (input.place === 0 || input.place == null) warnings.push('No SMT placements given: only through-hole and order charges are counted.');
  if (input.place != null && !(input.place >= 0)) return { warnings: ['Give the SMT placements per board (parts, not BOM lines), e.g. 150.'] };
  const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  const p = {
    house: input.house, sides: input.sides,
    place: num(input.place, 0), pads: num(input.pads, 3), unique: Math.round(num(input.unique, 0)), extended: Math.round(num(input.extended, 0)),
    thtJoints: num(input.tht, 0) * num(input.thtpins, 0), fine: num(input.fine, 0), bom: num(input.bom, 0), attrition: num(input.attrition, 2) / 100,
  };
  if (p.extended > p.unique) warnings.push(`${p.extended} extended parts but only ${p.unique} unique parts: extended parts are a subset of the BOM lines; check both.`);
  if (p.unique > p.place + num(input.tht, 0)) warnings.push('More unique parts than parts placed per board: unique parts are BOM lines, placements count every part.');
  if (input.house === 'econ' && p.fine > 0) warnings.push('Economic lines usually do not take BGAs or other X-ray-inspected parts: choose the standard line.');
  if (input.house === 'econ' && input.sides === 'two') warnings.push('Economic lines often place one side only; check, or choose the standard line.');
  if (!(p.pads >= 2) && p.place > 0) warnings.push('Fewer than 2 pads per part on average is unlikely; 2 for passives, 3-4 with transistors and ICs mixed in.');
  const e = estimate(p, qty);
  const values = [
    { label: `Assembly for ${qty} boards`, value: fmtNum(e.assembly, 4), unit: 'USD', tone: 'ok', hint: `${e.H.name}, ±50 %` },
    { label: 'Assembly per board', value: fmtNum(e.assembly / qty, 3), unit: 'USD' },
    { label: 'One-off order charges', value: fmtNum(e.perOrder, 4), unit: 'USD', hint: `${fmtNum((100 * e.perOrder) / e.assembly, 3)} % of assembly` },
    { label: 'Recurring per board', value: fmtNum(e.perBoard, 3), unit: 'USD', hint: e.H.joint ? `${fmtNum(e.joints, 5)} SMT joints` : `${fmtNum(p.place, 5)} placements` },
  ];
  if (p.bom > 0) {
    values.push(
      { label: 'Parts incl. attrition', value: fmtNum(e.parts, 4), unit: 'USD', hint: `${fmtNum(p.attrition * 100, 3)} % extra` },
      { label: 'Assembled board, per unit', value: fmtNum(e.total / qty, 3), unit: 'USD', hint: 'assembly + parts, no bare board' },
    );
  }
  if (e.perOrder / e.assembly > 0.6) warnings.push(`${fmtNum((100 * e.perOrder) / e.assembly, 3)} % of the assembly cost is one-off charges: at this quantity, cut unique and extended parts (use the line's stock parts) before anything else.`);
  const rows = [
    ...e.order.filter(([, v]) => v > 0).map(([k, v]) => [`${k} (per order)`, fmtNum(v, 4)]),
    ...e.board.filter(([, v]) => v > 0).map(([k, v]) => [`${k} (× ${qty})`, fmtNum(v * qty, 4)]),
  ];
  if (p.bom > 0) rows.push(['Parts incl. attrition', fmtNum(e.parts, 4)]);
  const H = e.H;
  const rates = [
    ['Setup per side', H.setup], ['Stencil per side', H.stencil], ['Per SMT joint', H.joint || '–'], ['Per SMT placement', H.place || '–'],
    ['Per BOM line', H.unique || '–'], ['Per extended part', H.extended || '–'], ['Per THT joint', H.tht], ['Per fine-pitch part', H.fine],
  ];
  const qs = [5, 10, 25, 50, 100, 250, 500, 1000, 5000];
  // Everything the page draws, as numbers (USD): the order and per-board
  // charges with the counts and rates behind them, and the per-board cost
  // of each charge against quantity (one-off charges spread over the run).
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  const KEYS = ['setup', 'stencil', 'lines', 'ext'], BKEYS = ['smt', 'tht', 'fine'];
  const curveQ = [...new Set([...Array.from({ length: 41 }, (_, i) => Math.round(10 ** (i / 10))), qty])].sort((x, y) => x - y);
  const cost = {
    qty, house: HOUSES[input.house] ? input.house : 'std', houseName: H.name, sides: e.sides,
    unique: p.unique, extended: p.extended, place: p.place, pads: p.pads, joints: e.joints, tht: num(input.tht, 0), thtpins: num(input.thtpins, 0),
    thtJoints: p.thtJoints, fine: p.fine, bom: p.bom, attrition: p.attrition,
    rates: { ...H },
    order: e.order.map(([label, v], i) => ({ key: KEYS[i], label, amount: r6(v) })),
    board: e.board.map(([label, v], i) => ({ key: BKEYS[i], label, amount: r6(v) })),
    perOrder: r6(e.perOrder), perBoard: r6(e.perBoard), assembly: r6(e.assembly), parts: r6(e.parts), total: r6(e.total),
    partsPerBoard: r6(p.bom * (1 + p.attrition)),
    oneOffPerBoard: r6(e.perOrder / qty), assemblyPerBoard: r6(e.assembly / qty), totalPerBoard: r6(e.total / qty), recurring: r6(qty * e.perBoard),
    curve: { q: curveQ, assemblyPerBoard: curveQ.map((n) => r6(estimate(p, n).assembly / n)) },
  };
  return {
    values,
    warnings,
    cost,
    charts: [{ title: 'Assembly cost per board against quantity', type: 'bars', x: qs.map(String),
      series: [{ name: 'USD per board', y: qs.map((n) => Number(fmtNum(estimate(p, n).assembly / n, 3))) }], xLabel: 'quantity', yLabel: 'USD per board' }],
    tables: [
      { title: 'Breakdown (USD)', columns: ['Item', 'Amount'], rows },
      { title: `Rates used: ${H.name} (USD)`, columns: ['Rate', 'USD'], rows: rates },
    ],
    notes: [
      'Online assemblers count solder joints (a 0402 resistor is 2, an SOIC-8 is 8); contract manufacturers count placements and BOM lines.',
      'Extended parts: parts the line does not keep loaded; each unique one costs a loading fee per order, whatever the quantity.',
      'Not included: the bare board, shipping, tariffs, conformal coating, programming/testing, or parts the assembler must source with minimum order quantities.',
    ],
  };
}
