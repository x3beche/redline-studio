// MOSFET gate drive check, gate-charge method (Balogh, TI SLUA618; Vishay AN608A).
//   Rsrc = Vdrv / Isrc,pk,  Rsnk = Vdrv / Isnk,pk          driver output resistance
//   Ig,on  = (Vdrv − Vpl) / (Rsrc + Rg + Rg,int)            gate current at the plateau
//   Ig,off =  Vpl         / (Rsnk + Rg + Rg,int)
//   Qsw    = Qgs2 + Qgd,  Qgs2 = Qgs·(Vpl − Vth)/Vpl       charge while V and I overlap
//   ton = Qsw / Ig,on,  toff = Qsw / Ig,off
//   Psw   = ½·VDS·ID·(ton + toff)·f                         hard-switched inductive load
//   Pcond = ID²·RDS(on)·D
//   Pgate = Qg·Vdrv·f (shared between driver and gate resistors)
//   Miller turn-on (half-bridge): Vgs,ind ≈ Crss·(dv/dt)·(Rsnk + Rg + Rg,int)   (upper bound)
import { fmtEng, fmtNum } from '../kit/eng.js';

export function run(i) {
  const { vbus, id, f, duty, rds, qg, qgs, qgd, vpl, vth, rgi, rg, vdrv, isrc, isnk, crss } = i;
  const warnings = [];
  const need = [[vbus, 'the switched voltage VDS (V)'], [id, 'the drain current (A)'], [f, 'the switching frequency (Hz)'],
    [qg, 'Qg (nC)'], [qgd, 'Qgd (nC)'], [vpl, 'the Miller plateau voltage (V)'], [vdrv, 'the driver supply (V)'],
    [isrc, 'the driver source current (A)'], [isnk, 'the driver sink current (A)']];
  const miss = need.filter(([v]) => !(v > 0)).map(([, n]) => n);
  if (miss.length) return { warnings: [`Give ${miss.join(', ')} - all must be above zero.`] };
  if (!(vdrv > vpl)) return { warnings: [`The driver supply (${fmtNum(vdrv)} V) does not exceed the plateau (${fmtNum(vpl)} V): the MOSFET cannot turn fully on. Raise the drive voltage or pick a logic-level MOSFET.`] };

  const D = duty >= 0 && duty <= 100 ? duty / 100 : 0.5;
  if (!(duty >= 0 && duty <= 100)) warnings.push('Duty must be 0–100 %; 50 % used.');
  const QG = qg * 1e-9, QGS = (qgs > 0 ? qgs : 0) * 1e-9, QGD = qgd * 1e-9;
  const Vth = vth > 0 && vth < vpl ? vth : vpl / 2;
  if (!(vth > 0 && vth < vpl)) warnings.push(`Threshold should be above 0 and below the plateau; ${fmtNum(Vth, 3)} V used.`);
  const Rgi = rgi >= 0 ? rgi : 0, Rg = rg >= 0 ? rg : 0;
  const rSrc = vdrv / isrc, rSnk = vdrv / isnk;
  const rOn = rSrc + Rg + Rgi, rOff = rSnk + Rg + Rgi;
  const igOn = (vdrv - vpl) / rOn, igOff = vpl / rOff;
  const qgs2 = QGS * (vpl - Vth) / vpl;
  const qsw = qgs2 + QGD;
  const tOn = qsw / igOn, tOff = qsw / igOff;
  const T = 1 / f;
  const pSw = 0.5 * vbus * id * (tOn + tOff) * f;
  const pCond = rds > 0 ? id * id * rds * 1e-3 * D : 0;
  const pGate = QG * vdrv * f;
  const pDrv = 0.5 * pGate * (rSrc / rOn) + 0.5 * pGate * (rSnk / rOff); // driver's share of each edge
  const iAvg = QG * f;
  const dvdt = vbus / Math.min(tOn, tOff);
  const share = (tOn + tOff) * f;
  const tFull = QG / igOn; // rough: gate current falls above the plateau, so this is a lower bound
  const vInd = crss > 0 ? crss * 1e-12 * (vbus / tOn) * rOff : null; // the other FET's turn-on edge ≈ this one's

  if (share > 0.1) warnings.push(`The edges take ${fmtNum(share * 100, 3)} % of each period: switching loss dominates. Use a stronger driver, a smaller gate resistor or a MOSFET with less Qgd, or lower the frequency.`);
  if (pSw > 2 * pCond && pCond > 0) warnings.push(`Switching loss (${fmtEng(pSw, 'W')}) is more than twice the conduction loss (${fmtEng(pCond, 'W')}): faster edges (stronger driver, smaller gate resistor, lower-Qgd part) or a lower frequency cut losses more than a lower RDS(on) would.`);
  const minOn = Math.min(D, 1 - D) * T;
  if (D > 0 && D < 1 && tFull > 0.5 * minOn) warnings.push(`Charging the whole gate takes about ${fmtEng(tFull, 's')}, a large part of the shortest ${fmtEng(minOn, 's')} pulse: the MOSFET may never reach its full RDS(on).`);
  if (vdrv > 20) warnings.push(`${fmtNum(vdrv)} V drive exceeds the usual ±20 V VGS rating: check the MOSFET's absolute maximum.`);
  else if (vdrv < vpl + 3) warnings.push(`Only ${fmtNum(vdrv - vpl, 2)} V above the plateau: RDS(on) is probably specified at a higher VGS; check it at ${fmtNum(vdrv)} V.`);
  if (vInd != null && vInd > 0.8 * Vth) warnings.push(`Miller turn-on risk: the other switch's edge (${fmtNum(dvdt / 1e9, 3)} V/ns) can lift this gate by up to ${fmtNum(vInd, 3)} V against a ${fmtNum(Vth, 3)} V threshold. Lower the turn-off resistance (separate Rg,off with a diode), use a Miller clamp or negative gate drive.`);

  const tone = (x, a, b) => (x > b ? 'bad' : x > a ? 'warn' : 'ok');
  const values = [
    { label: 'Gate current, turn-on', value: fmtEng(igOn, 'A'), hint: `R total ${fmtNum(rOn, 3)} Ω` },
    { label: 'Gate current, turn-off', value: fmtEng(igOff, 'A'), hint: `R total ${fmtNum(rOff, 3)} Ω` },
    { label: 'Turn-on transition', value: fmtEng(tOn, 's'), hint: `Qsw ${fmtNum(qsw * 1e9, 3)} nC` },
    { label: 'Turn-off transition', value: fmtEng(tOff, 's') },
    { label: 'Edges share of period', value: `${fmtNum(share * 100, 3)} %`, tone: tone(share, 0.05, 0.1) },
    { label: 'Switching loss', value: fmtEng(pSw, 'W'), tone: pSw > 2 * pCond && pCond > 0 ? 'warn' : undefined },
    { label: 'Conduction loss', value: rds > 0 ? fmtEng(pCond, 'W') : '–', hint: rds > 0 ? `D ${fmtNum(D * 100, 3)} %` : 'no RDS(on) given' },
    { label: 'Total MOSFET loss', value: fmtEng(pSw + pCond, 'W') },
    { label: 'Gate drive power', value: fmtEng(pGate, 'W'), hint: `driver's share ${fmtEng(pDrv, 'W')}` },
    { label: 'Driver average current', value: fmtEng(iAvg, 'A'), hint: 'from its supply, per MOSFET' },
    { label: 'dv/dt', value: fmtNum(dvdt / 1e9, 3), unit: 'V/ns' },
    { label: 'Miller-induced VGS', value: vInd == null ? '–' : fmtNum(vInd, 3), unit: vInd == null ? undefined : 'V',
      tone: vInd == null ? undefined : tone(vInd / Vth, 0.5, 0.8), hint: vInd == null ? 'give Crss' : `threshold ${fmtNum(Vth, 3)} V` },
  ];

  const fs = [20e3, 50e3, 100e3, 200e3, 500e3, 1e6, 2e6];
  const sweep = fs.map((fx) => {
    const ps = 0.5 * vbus * id * (tOn + tOff) * fx;
    return { fx, ps, pg: QG * vdrv * fx, tot: ps + pCond, share: (tOn + tOff) * fx };
  });

  return {
    values,
    warnings,
    charts: [{ title: 'MOSFET loss against frequency', type: 'line', x: fs.map((x) => fmtEng(x, 'Hz')),
      series: [{ name: 'switching W', y: sweep.map((s) => s.ps) }, { name: 'conduction W', y: sweep.map(() => pCond) }, { name: 'total W', y: sweep.map((s) => s.tot) }],
      xLabel: 'switching frequency', yLabel: 'loss, W' }],
    tables: [{ title: 'At other frequencies (same driver and gate resistor)', columns: ['Frequency', 'Switching', 'Conduction', 'Total', 'Gate drive', 'Edges / period'],
      rows: sweep.map((s) => [fmtEng(s.fx, 'Hz'), fmtEng(s.ps, 'W'), fmtEng(pCond, 'W'), fmtEng(s.tot, 'W'), fmtEng(s.pg, 'W'), `${fmtNum(s.share * 100, 3)} %`]) }],
    // Raw numbers for the page's drawing (SI units); the same values as above.
    drawing: {
      vbus, id, f, T, D, vdrv, vpl, vth: Vth, rgi: Rgi, rg: Rg,
      qg: QG, qgs: QGS, qgd: QGD, qgs2, qsw, rSrc, rSnk, rOn, rOff, igOn, igOff,
      tOn, tOff, tOnI: qgs2 / igOn, tOnV: QGD / igOn, tOffV: QGD / igOff, tOffI: qgs2 / igOff,
      eOn: 0.5 * vbus * id * tOn, eOff: 0.5 * vbus * id * tOff,
      pSwOn: 0.5 * vbus * id * tOn * f, pSwOff: 0.5 * vbus * id * tOff * f,
      pSw, pCond, pGate, pDrv, iAvg, dvdt, share, tFull, minOn, vInd, crss: crss > 0 ? crss * 1e-12 : null,
      sweep: sweep.map((s) => ({ f: s.fx, sw: s.ps, cond: pCond, total: s.tot, gate: s.pg, share: s.share })),
    },
    notes: [
      'Plateau gate current is held constant through the transition; real drivers act more like resistors near their rails, so times can be 10–30 % longer.',
      'Not included: reverse-recovery loss of the opposite diode, Coss charge loss (½·Coss·V²·f) and ringing; add them for hard-switched bridges above ~100 kHz.',
      'Qgs2 is taken as the share of Qgs between threshold and plateau, assuming Qgs grows linearly with VGS.',
      'The Miller-induced voltage ignores the Cgs divider, so it is an upper bound; a result above the minimum threshold still calls for a closer look.',
    ],
  };
}
