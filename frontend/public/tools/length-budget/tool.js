// Length-matching budget: how much length mismatch a bus can take at a given
// bit rate, as a share of the unit interval (UI), turned into ps, mm and mil.
//
//   UI            = 1 / bit rate                          (NRZ: one bit per UI)
//   skew budget   = share × UI                            (the timing you give to routing)
//   delay per mm  = sqrt(εeff) / c,  c = 0.299792 mm/ps   (TEM propagation)
//   stripline     εeff = εr                               (field fully in the dielectric)
//   microstrip    εeff = (εr+1)/2 + (εr-1)/2 · (1 + 12 h/w)^-1/2   (Hammerstad & Jensen,
//                 w/h ≥ 1; for w/h < 1 add 0.04 (1 - w/h)^2)
//   length budget = skew budget / delay per mm
import { fmtEng, fmtNum } from '../kit/eng.js';

const C_MM_PER_PS = 0.299792458;

const BASIS = {
  intra: { share: 0.05, label: 'P to N within one differential pair (5 % of UI)' },
  lanes: { share: 0.10, label: 'Lane to lane / data to strobe in a source-synchronous bus (10 % of UI)' },
  bus: { share: 0.15, label: 'Slow parallel bus, whole group to its clock (15 % of UI)' },
  custom: { share: null, label: 'Your own share of the UI' },
};

export function effectiveEr(layer, er, wh) {
  if (layer === 'stripline') return er;
  const u = wh > 0 ? wh : 2;
  let e = (er + 1) / 2 + ((er - 1) / 2) * Math.pow(1 + 12 / u, -0.5);
  if (u < 1) e += ((er - 1) / 2) * 0.04 * Math.pow(1 - u, 2);
  return e;
}

export function run({ rate, basis, share, layer, er, wh }) {
  const warnings = [];
  if (!(rate > 0)) return { warnings: ['Give the bit rate per lane in bit/s, e.g. 5G for 5 Gb/s or 3200M for DDR4-3200 (MT/s).'] };
  if (!(er >= 1)) return { warnings: ['Give the dielectric constant εr (FR-4 is about 4.2 at 1 GHz; must be 1 or more).'] };
  const b = BASIS[basis] || BASIS.lanes;
  let frac = b.share;
  if (frac == null) {
    if (!(share > 0)) return { warnings: ['Give the share of the UI you allow for this skew, in %, e.g. 5.'] };
    frac = share / 100;
    if (frac > 0.5) warnings.push(`${fmtNum(share, 3)} % of the UI is more than half a bit: the receiver cannot sample that. Use 5–20 %.`);
  }
  if (er > 12) warnings.push(`εr ${fmtNum(er, 3)} is unusual for a PCB laminate (FR-4 ≈ 4.2, Rogers 3–3.7). Check the value.`);
  if (layer === 'microstrip' && !(wh > 0)) warnings.push('No width/height ratio given: 2 is assumed for the microstrip.');
  if (rate > 64e9) warnings.push('Above 64 Gb/s most links use PAM4 and per-lane deskew; a pure length budget says little there.');

  const ui = 1e12 / rate;                                 // ps
  const eeff = effectiveEr(layer, er, wh);
  const psPerMm = Math.sqrt(eeff) / C_MM_PER_PS;          // ps/mm
  const skew = frac * ui;                                 // ps
  const mm = skew / psPerMm;
  const mil = mm / 0.0254;
  const nyq = rate / 2;

  const values = [
    { label: 'Unit interval', value: fmtEng(ui * 1e-12, 's'), hint: `at ${fmtEng(rate, 'b/s')}` },
    { label: 'Skew budget', value: `${fmtNum(skew, 3)} ps`, hint: `${fmtNum(frac * 100, 3)} % of the UI`, tone: frac > 0.5 ? 'bad' : 'ok' },
    { label: 'Max length mismatch', value: `${fmtNum(mm, 3)} mm`, hint: `${fmtNum(mil, 3)} mil`, tone: frac > 0.5 ? 'bad' : 'ok' },
    { label: 'Propagation delay', value: `${fmtNum(psPerMm, 3)} ps/mm`, hint: `εeff ${fmtNum(eeff, 3)}, ${fmtNum(psPerMm * 25.4, 3)} ps/in` },
    { label: 'Nyquist frequency', value: fmtEng(nyq, 'Hz') },
  ];
  if (basis === 'intra' && mm > 0.127 && rate >= 2.5e9) {
    warnings.push(`The timing budget allows ${fmtNum(mm, 3)} mm P/N mismatch, but above ~2.5 Gb/s intra-pair skew also turns signal into common-mode noise (EMI, crosstalk). Most layout guides still ask for ≤ 0.127 mm (5 mil); match to that.`);
  }
  if (mm < 0.05) warnings.push(`${fmtNum(mm * 1000, 3)} µm is below what routing and glass-weave skew allow: use a tighter-weave laminate, route at an angle to the weave, and rely on the receiver's deskew.`);

  const shares = [1, 2, 5, 10, 15, 20, 25];
  const rows = shares.map((p) => {
    const ps = (p / 100) * ui; const l = ps / psPerMm;
    return [`${p} %`, `${fmtNum(ps, 3)} ps`, `${fmtNum(l, 3)} mm`, `${fmtNum(l / 0.0254, 3)} mil`];
  });
  const rates = [100e6, 480e6, 1e9, 2.5e9, 5e9, 8e9, 10e9, 16e9];
  const rrows = rates.map((r) => {
    const u = 1e12 / r, ps = frac * u, l = ps / psPerMm;
    return [fmtEng(r, 'b/s'), `${fmtNum(u, 4)} ps`, `${fmtNum(ps, 3)} ps`, `${fmtNum(l, 3)} mm`];
  });
  return {
    values,
    warnings,
    tables: [
      { title: `At ${fmtEng(rate, 'b/s')}: mismatch for other shares of the UI`, columns: ['Share of UI', 'Skew', 'Length', 'Length'], rows },
      { title: `At ${fmtNum(frac * 100, 3)} % of the UI: other bit rates`, columns: ['Bit rate', 'UI', 'Skew budget', 'Length'], rows: rrows },
    ],
    notes: [
      `Basis: ${b.share == null ? `${fmtNum(frac * 100, 3)} % of the UI (your value)` : b.label}. These shares are common layout-guide rules of thumb; a real budget splits the UI between driver, receiver, connector and routing.`,
      layer === 'stripline'
        ? 'Stripline: the field is all in the dielectric, so εeff = εr.'
        : 'Microstrip: εeff from Hammerstad & Jensen with the given w/h; solder mask adds a few % more delay.',
      'Match lengths in time, not only in mm, when a net changes layer: a microstrip and a stripline section have different delays per mm.',
      'For DDR, the rate is the transfer rate (MT/s), e.g. 3200M for DDR4-3200.',
    ],
  };
}
