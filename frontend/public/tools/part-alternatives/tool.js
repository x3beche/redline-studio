// Part alternative finder: ranks candidate parts (from an LCSC search, fetched by
// view.js in the app, or pasted/typed rows) against the part you have, by
// footprint fit, stock for the order, JLCPCB assembly class and order cost.
// Cost model (JLCPCB assembly pricing, as published on jlcpcb.com/parts):
//   order cost = quantity x unit price + loading fee   (fee only for Extended parts,
//   charged once per unique part per order; Basic and Preferred parts have none in
//   economic assembly). The fee is an input because it changes.
// Package fit: families compared after normalising names (SOT-223-3, SOT-223-3L ->
// SOT-223) - a rule of thumb; the pinout still has to be checked on the datasheet.

import { fmtNum } from '../kit/eng.js';

const CLASSES = ['basic', 'preferred', 'extended', 'unknown'];

/** Package family for comparison: upper case, no spaces, lead-count suffixes and
 *  size notes in brackets dropped (SOT-223-3L -> SOT-223, SOIC-8_150mil -> SOIC-8). */
export function family(pkg) {
  const p = String(pkg || '').toUpperCase().replace(/\s+/g, '').replace(/\(.*?\)/g, '').replace(/_.*$/, '');
  // Chip sizes: "0603", "R0603", "C0603" all mean 0603 (imperial).
  const chip = /^[RCL]?(0201|0402|0603|0805|1206|1210|1812|2010|2512)$/.exec(p);
  if (chip) return chip[1];
  const t = /^(SOT|TO|SC|SOD)-?(\d+[A-Z]?)(?:-(\d+)L?)?$/.exec(p);
  if (t) {
    const base = `${t[1]}-${t[2]}`;
    // SOT-23 and SC-70 come in 3, 5 and 6 leads: the count matters (plain SOT-23 = 3).
    if (base === 'SOT-23' || base === 'SC-70') return `${base}-${t[3] || 3}`;
    // Tab packages (SOT-223, SOT-89, TO-252...): "-3", "-3L", "-4" name the same body.
    return base;
  }
  // LCSC's "SOP-8" is the 150 mil SOIC-8 body.
  return p.replace(/^(SOP|SOIC|TSSOP|MSOP|QFN|DFN|LQFP|TQFP|SSOP|ESOP|HSOP)-?(\d+)(-.*)?$/, '$1-$2').replace(/^SOP-/, 'SOIC-');
}

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.eE+-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const money = (v) => (v == null || !Number.isFinite(v) ? '–' : `$${v < 1 ? fmtNum(v, 3) : v.toFixed(2)}`);

export function run(input) {
  const warnings = [], notes = [];
  const boards = input.boards > 0 ? Math.round(input.boards) : 1;
  const per = input.per_board > 0 ? Math.round(input.per_board) : 1;
  const qty = boards * per;
  const fee = input.fee >= 0 ? input.fee : 3;
  const assume = input.assume === 'basic' ? 'basic' : 'extended';
  const origClass = CLASSES.includes(input.orig_class) ? input.orig_class : 'unknown';
  const origFam = family(input.orig_package);
  const origMpn = String(input.orig_mpn || '').trim().toUpperCase();
  const origLcsc = String(input.orig_lcsc || '').trim().toUpperCase();
  const feeFor = (cls) => ((cls === 'unknown' ? assume : cls) === 'extended' ? fee : 0);
  const origPrice = input.orig_price > 0 ? input.orig_price : null;
  const origCost = origPrice != null ? qty * origPrice + feeFor(origClass) : null;

  const rows = (Array.isArray(input.candidates) ? input.candidates : []).map((r, i) => ({
    i, lcsc: String(r.lcsc || '').trim(), mpn: String(r.mpn || '').trim(), pkg: String(r.package || '').trim(),
    maker: String(r.maker || '').trim(), stock: num(r.stock), price: num(r.price),
    cls: CLASSES.includes(String(r.class || '').toLowerCase()) ? String(r.class).toLowerCase() : 'unknown',
  })).filter((r) => r.lcsc || r.mpn);
  const skipped = (input.candidates || []).length - rows.length;

  const scored = rows.filter((r) => !(origLcsc && r.lcsc.toUpperCase() === origLcsc)).map((r) => {
    const fam = family(r.pkg);
    const pkgFit = !origFam ? 'unknown' : fam === origFam ? (r.pkg.toUpperCase().replace(/\s/g, '') === String(input.orig_package).toUpperCase().replace(/\s/g, '') ? 'same' : 'same family') : 'different';
    const sameMpn = origMpn && r.mpn.toUpperCase() === origMpn;
    const inStock = r.stock != null && r.stock >= qty;
    const cost = r.price != null ? qty * r.price + feeFor(r.cls) : null;
    const eff = r.cls === 'unknown' ? `${assume}?` : r.cls;
    // Rank: in stock, footprint fits, same part number, no loading fee, cheapest.
    const key = [inStock ? 0 : 1, pkgFit === 'different' ? 1 : 0, sameMpn ? 0 : 1, feeFor(r.cls) ? 1 : 0, cost ?? 1e12];
    const verdict = !inStock ? 'not enough stock' : pkgFit === 'different' ? 'footprint change' : sameMpn ? 'second source' : 'check datasheet';
    return { ...r, fam, pkgFit, sameMpn, inStock, cost, eff, key, verdict };
  }).sort((a, b) => { for (let k = 0; k < a.key.length; k++) if (a.key[k] !== b.key[k]) return a.key[k] - b.key[k]; return a.i - b.i; });

  const best = scored.find((r) => r.inStock && r.pkgFit !== 'different');
  if (!rows.length) warnings.push('No candidates yet: press "Search LCSC" in the app, or add rows by hand (LCSC number, MPN, package, stock, price, class).');
  else if (!best) warnings.push(`No candidate has ${qty} in stock in a ${origFam || 'matching'} package: widen the search (other maker, other package) or cut the quantity.`);
  if (skipped > 0) notes.push(`${skipped} row(s) without an LCSC number or MPN were left out.`);
  if (!origFam) warnings.push('Give the original package so footprints can be compared.');
  if (input.orig_stock != null && input.orig_stock !== '' && Number.isFinite(input.orig_stock) && input.orig_stock < qty) {
    warnings.push(`The original has ${input.orig_stock} in stock, fewer than the ${qty} needed: an alternative is required for this order.`);
  }
  if (rows.some((r) => r.cls === 'unknown')) notes.push(`Class unknown for some rows: counted as ${assume}${assume === 'extended' ? ` (worst case, $${fee} fee)` : ''}. Check the class on jlcpcb.com/parts and set it in the table.`);

  const values = [
    { label: 'Needed', value: qty, unit: 'pcs', hint: `${boards} boards × ${per}` },
    { label: 'Candidates', value: scored.length, hint: `${scored.filter((r) => r.inStock).length} with enough stock` },
    { label: 'Footprint fits', value: scored.filter((r) => r.pkgFit !== 'different').length, hint: origFam ? `family ${origFam}` : 'no original package' },
  ];
  if (origCost != null) values.push({ label: 'Original order cost', value: money(origCost), hint: `${origClass}${feeFor(origClass) ? ` + $${fee} fee` : ''}` });
  if (best) {
    values.push({ label: 'Best alternative', value: best.lcsc || best.mpn, tone: 'ok', hint: `${best.maker || '?'} · ${best.pkg} · ${best.verdict}` });
    values.push({ label: 'Its order cost', value: money(best.cost), hint: `${best.eff}${feeFor(best.cls) ? ` incl. $${fee} fee` : ''}`,
      tone: origCost != null && best.cost != null ? (best.cost <= origCost ? 'ok' : 'warn') : undefined });
    if (origCost != null && best.cost != null) values.push({ label: 'Difference', value: `${best.cost >= origCost ? '+' : '−'}${money(Math.abs(best.cost - origCost))}`, hint: 'vs original, per order' });
  } else values.push({ label: 'Best alternative', value: '–', tone: 'bad' });

  const top = scored.slice(0, 12);
  // The same ranking as numbers, for a drawing: nothing here is computed twice.
  const ranked = scored.map((r, k) => ({ rank: k + 1, i: r.i, lcsc: r.lcsc, mpn: r.mpn, maker: r.maker, pkg: r.pkg, fam: r.fam,
    pkgFit: r.pkgFit, sameMpn: !!r.sameMpn, inStock: r.inStock, stock: r.stock, price: r.price, cls: r.cls, eff: r.eff,
    fee: feeFor(r.cls), cost: r.cost, verdict: r.verdict, best: r === best }));
  const order = { qty, boards, per, fee, assume, origClass, origFam, origPrice, origFee: feeFor(origClass), origCost,
    origLcsc: String(input.orig_lcsc || '').trim(), origMpn: String(input.orig_mpn || '').trim(), origPackage: String(input.orig_package || '').trim(),
    origStock: Number.isFinite(input.orig_stock) ? input.orig_stock : null };
  return {
    ranked, order,
    values, warnings, notes: [...notes,
      'Rank: enough stock, then footprint fit, then the same MPN (a true second source), then no loading fee, then order cost.',
      '"same family" means the package names differ only in suffix (SOT-223 vs SOT-223-3L): check tab and pin order on both datasheets.',
      'A different maker\'s part with the same MPN is usually a clone: check dropout, quiescent current and stability capacitors, not only the pinout.'],
    tables: scored.length ? [{
      title: 'Candidates, best first',
      columns: ['#', 'LCSC', 'MPN', 'Maker', 'Package', 'Fit', 'Stock', 'Unit price', 'Class', 'Order cost', 'Verdict'],
      rows: scored.map((r, k) => [k + 1, r.lcsc || '–', r.mpn || '–', r.maker || '–', r.pkg || '–', r.pkgFit, r.stock ?? '–',
        r.price != null ? money(r.price) : '–', r.eff, money(r.cost), r.verdict]),
    }] : [],
    charts: top.some((r) => r.cost != null) ? [{
      title: `Order cost for ${qty} pcs (incl. loading fee)`, type: 'bars',
      x: [...(origCost != null ? ['original'] : []), ...top.map((r) => r.lcsc || r.mpn)],
      series: [{ name: 'order cost $', y: [...(origCost != null ? [origCost] : []), ...top.map((r) => r.cost ?? null)] }],
      yLabel: 'US$ per order',
    }] : [],
  };
}
