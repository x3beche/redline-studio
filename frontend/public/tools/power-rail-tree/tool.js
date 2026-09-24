// Power rail tree: currents summed from the leaves up to the sources.
//   load      Iin = its own current, at the parent rail's voltage
//   ldo       Iin = Iout (quiescent current neglected); loss = (Vin - Vout) * Iout
//             (TI SLVA079, linear regulator power dissipation)
//   switcher  Iin = Vout * Iout / (eta * Vin); loss = Vout * Iout * (1/eta - 1)
//             (energy balance, e.g. TI SLVA477)
//   source    delivers the sum of what hangs from it; P = V * I
import { parseEng, fmtEng, fmtNum } from '../kit/eng.js';

const TYPES = ['source', 'switcher', 'ldo', 'load'];
const num = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return parseEng(s.replace(/%$/, ''));
};
const f = (v, u) => (Number.isFinite(v) ? fmtEng(v, u) : '–');

export function run({ rails }) {
  const rows = Array.isArray(rails) ? rails : [];
  const warnings = [];
  if (!rows.length) return { warnings: ['Add at least one source row and the rails or loads that hang from it.'] };

  // ---- read rows ----
  const nodes = [];
  const byName = new Map();
  rows.forEach((r, i) => {
    let name = String(r?.name ?? '').trim();
    if (!name) name = `row ${i + 1}`;
    if (byName.has(name)) { warnings.push(`Two rows are called "${name}": give each a unique name (row ${i + 1} was renamed "${name} #${i + 1}").`); name = `${name} #${i + 1}`; }
    const type = TYPES.includes(r?.type) ? r.type : 'load';
    const n = { name, parent: String(r?.parent ?? '').trim(), type, row: i + 1,
      v: num(r?.v), load: num(r?.load) ?? 0, limit: num(r?.limit), eff: num(r?.eff), kids: [] };
    for (const [k, label] of [['v', 'V out'], ['load', 'Load A'], ['limit', 'Rating A'], ['eff', 'Eff. %']]) {
      if (String(r?.[k] ?? '').trim() && num(r[k]) == null) warnings.push(`"${name}": ${label} "${r[k]}" is not a number; it was ignored.`);
    }
    if (n.load < 0) { warnings.push(`"${name}": a negative load current was set to 0.`); n.load = 0; }
    nodes.push(n); byName.set(name, n);
  });

  // ---- link parents ----
  const roots = [];
  for (const n of nodes) {
    if (n.type === 'source') {
      if (n.parent) warnings.push(`"${n.name}" is a source but has a parent; it is drawn as a root.`);
      roots.push(n); continue;
    }
    const p = byName.get(n.parent);
    if (!n.parent) { warnings.push(`"${n.name}" has no parent: set Parent to the rail that feeds it (it is shown as a root, fed at its own voltage).`); roots.push(n); continue; }
    if (!p) { warnings.push(`"${n.name}": parent "${n.parent}" is not a row name; it is shown as a root.`); roots.push(n); continue; }
    if (p.type === 'load') { warnings.push(`"${n.name}" hangs from "${p.name}", which is a load; make "${p.name}" a regulator or move the row.`); }
    p.kids.push(n); n.p = p;
  }
  // cycles: a node never reached from a root
  const seen = new Set();
  const walk = (n, d) => { if (seen.has(n)) return; seen.add(n); n.depth = d; n.kids.forEach((k) => walk(k, d + 1)); };
  roots.forEach((r) => walk(r, 0));
  const lost = nodes.filter((n) => !seen.has(n));
  if (lost.length) warnings.push(`These rows feed each other in a loop and were left out: ${lost.map((n) => n.name).join(', ')}.`);

  // ---- voltages top-down ----
  const setV = (n, vin) => {
    n.vin = vin;
    if (n.type === 'load') n.vout = vin;
    else if (n.v == null || !(n.v > 0)) {
      if (n.type !== 'load') warnings.push(`"${n.name}": give V out in volts${n.type === 'source' ? '' : '; its parent voltage is used meanwhile'}.`);
      n.vout = vin ?? null;
    } else n.vout = n.v;
    if (n.type === 'source' || !n.p) n.vin = n.vout; // a root is fed at its own voltage
    n.kids.forEach((k) => setV(k, n.vout));
  };
  roots.forEach((r) => setV(r, r.type === 'source' ? r.v : r.v));

  // ---- currents bottom-up ----
  const calc = (n) => {
    n.kids.forEach(calc);
    n.iout = n.load + n.kids.reduce((s, k) => s + (k.iin || 0), 0);
    const vo = n.vout, vi = n.vin;
    n.pout = Number.isFinite(vo) ? vo * n.iout : NaN;
    n.loss = 0;
    if (n.type === 'ldo') {
      n.iin = n.iout;
      n.loss = Number.isFinite(vi) && Number.isFinite(vo) ? Math.max(0, vi - vo) * n.iout : 0;
      if (Number.isFinite(vi) && Number.isFinite(vo) && n.p) {
        if (vi < vo) warnings.push(`"${n.name}": an LDO cannot make ${fmtNum(vo)} V from ${fmtNum(vi)} V; use a boost switcher.`);
        else if (vi - vo < 0.3) warnings.push(`"${n.name}": only ${fmtNum(vi - vo, 3)} V of headroom; check the LDO's dropout voltage at ${f(n.iout, 'A')}.`);
      }
      if (n.loss > 1) warnings.push(`"${n.name}" dissipates ${f(n.loss, 'W')}: check its package's thermal resistance (Copper Area Thermal or Heat Sink Sizing), or use a switcher.`);
    } else if (n.type === 'switcher') {
      let eta = n.eff;
      if (eta == null) { eta = 85; warnings.push(`"${n.name}": no efficiency given; 85 % assumed.`); }
      if (!(eta > 0 && eta <= 100)) { warnings.push(`"${n.name}": efficiency ${fmtNum(eta)} % is not between 0 and 100; 85 % used.`); eta = 85; }
      n.etaUsed = eta;
      n.iin = Number.isFinite(vi) && vi > 0 ? (vo * n.iout) / ((eta / 100) * vi) : n.iout;
      n.loss = Number.isFinite(n.pout) ? n.pout * (100 / eta - 1) : 0;
    } else {
      n.iin = n.iout;
    }
    n.pin = n.type === 'source' ? n.pout : (Number.isFinite(vi) ? vi * n.iin : NaN);
    n.use = n.limit > 0 && n.type !== 'load' ? n.iout / n.limit : null;
    if (n.use != null) {
      if (n.use > 1) warnings.push(`"${n.name}" supplies ${f(n.iout, 'A')}, over its ${f(n.limit, 'A')} rating: use a bigger part or move loads off this branch.`);
      else if (n.use > 0.8) warnings.push(`"${n.name}" runs at ${Math.round(n.use * 100)} % of its rating; 80 % is the usual continuous limit.`);
    }
  };
  roots.forEach(calc);

  // ---- output ----
  const order = [];
  const dfs = (n) => { order.push(n); n.kids.forEach(dfs); };
  roots.forEach(dfs);
  const sources = roots.filter((r) => r.type === 'source');
  const pIn = sources.reduce((s, r) => s + (Number.isFinite(r.pout) ? r.pout : 0), 0);
  const pLoad = order.reduce((s, n) => s + (Number.isFinite(n.vout) ? n.vout * n.load : 0), 0);
  const pLoss = order.reduce((s, n) => s + (n.loss || 0), 0);
  if (!sources.length) warnings.push('No source row: add one (type "source") with its voltage so the input power can be totalled.');

  const tone = (u) => (u == null ? undefined : u > 1 ? 'bad' : u > 0.8 ? 'warn' : 'ok');
  const values = [
    { label: 'Input power', value: sources.some((r) => !Number.isFinite(r.pout)) ? '–' : fmtEng(pIn, 'W'), hint: sources.map((s) => `${s.name} ${f(s.iout, 'A')}`).join(', ') || 'no source' },
    { label: 'Delivered to loads', value: fmtEng(pLoad, 'W') },
    { label: 'Lost in regulators', value: fmtEng(pLoss, 'W'), tone: pLoss > 0.25 * pIn && pIn > 0 ? 'warn' : undefined },
    { label: 'Overall efficiency', value: pIn > 0 ? `${fmtNum((pLoad / pIn) * 100, 3)} %` : '–' },
  ];
  for (const s of sources) {
    values.push({ label: `${s.name} current`, value: f(s.iout, 'A'), tone: tone(s.use), hint: s.limit > 0 ? `rating ${f(s.limit, 'A')}` : 'no rating given' });
  }

  const tree = order.map((n) => ({
    name: n.name, parent: n.p ? n.p.name : '', type: n.type, depth: n.depth,
    vin: Number.isFinite(n.vin) ? n.vin : null, vout: Number.isFinite(n.vout) ? n.vout : null,
    iout: n.iout, iin: n.iin, pout: Number.isFinite(n.pout) ? n.pout : null, loss: n.loss,
    limit: n.limit ?? null, use: n.use, eff: n.type === 'switcher' ? n.etaUsed : null,
  }));

  return {
    values,
    warnings,
    tables: [{
      title: 'Per branch (depth-first; indent = level)',
      columns: ['Node', 'Type', 'V', 'I out', 'I in', 'P out', 'Loss', 'Rating', 'Use'],
      rows: order.map((n) => [
        `${'· '.repeat(n.depth)}${n.name}`, n.type + (n.type === 'switcher' ? ` ${fmtNum(n.etaUsed, 3)} %` : ''),
        Number.isFinite(n.vout) ? `${fmtNum(n.vout, 4)} V` : '–', f(n.iout, 'A'), n.type === 'source' ? '–' : f(n.iin, 'A'),
        Number.isFinite(n.pout) ? f(n.pout, 'W') : '–', n.loss ? f(n.loss, 'W') : '–',
        n.limit > 0 && n.type !== 'load' ? f(n.limit, 'A') : '–', n.use == null ? '–' : `${Math.round(n.use * 100)} %`,
      ]),
    }],
    tree,
    notes: [
      'LDO quiescent and ground-pin currents are neglected; add them as a small Load A on the LDO row when they matter (battery designs).',
      'Switcher efficiency is taken as constant; read it from the datasheet curve at the computed output current.',
      'Currents are steady-state averages: size connectors, fuses and inrush for peaks separately.',
    ],
  };
}
