// I2C pull-up sizing, after NXP UM10204 section 7.1:
//   Rp(min) = (VDD - VOL(max)) / IOL        - a device must be able to pull it low
//   Rp(max) = tr / (0.8473 * Cb)            - the bus must rise from 0.3 VDD to 0.7 VDD in tr
import { fmtEng, standard, SERIES, parseEng } from '../kit/eng.js';

const MODES = {
  standard: { name: 'Standard-mode', short: 'Sm', f: 100e3, tr: 1000e-9, iol: 3e-3, vol: 0.4, cmax: 400e-12 },
  fast: { name: 'Fast-mode', short: 'Fm', f: 400e3, tr: 300e-9, iol: 3e-3, vol: 0.4, cmax: 400e-12 },
  fastplus: { name: 'Fast-mode Plus', short: 'Fm+', f: 1e6, tr: 120e-9, iol: 20e-3, vol: 0.4, cmax: 550e-12 },
};

// The devices on the bus (name, pin capacitance in pF), as a table or a list.
function readDevices(devices) {
  if (!Array.isArray(devices)) return [];
  return devices.map((d, i) => ({
    name: String(d?.name ?? '').trim() || `Device ${i + 1}`,
    pf: parseEng(d?.pf ?? d?.cpin ?? ''),
  })).filter((d) => d.pf != null && d.pf >= 0);
}

export function run({ vdd, mode, cb, series, devices, pfcm, rp }) {
  const m = MODES[mode] || MODES.fast;
  const warnings = [];
  if (!(vdd > 0)) return { warnings: ['Give the bus supply in volts, e.g. 3.3.'] };
  if (!(cb > 0)) return { warnings: ['Give the bus capacitance in pF, e.g. 100.'] };
  const c = cb * 1e-12;
  const vol = vdd <= 2 ? 0.2 * vdd : m.vol;
  const rmin = (vdd - vol) / m.iol;
  const rmax = m.tr / (0.8473 * c);
  if (c > m.cmax) warnings.push(`${fmtEng(c, 'F')} is over ${m.name}'s ${fmtEng(m.cmax, 'F')} limit: split the bus or add a buffer.`);
  let pick = null;
  if (rmin > rmax) {
    warnings.push(`No resistor works: the bus needs at most ${fmtEng(rmax, 'Ω')} to rise in time, but less than ${fmtEng(rmin, 'Ω')} is more current than a device may sink. Lower the capacitance or the speed.`);
  } else {
    // The largest standard value that still rises in time with some margin:
    // weaker pull-ups waste less current, and 80 % of Rmax leaves room.
    const s = SERIES[series] || SERIES.E24;
    pick = standard(Math.max(rmin, rmax * 0.8), s, 'down');
    if (pick < rmin) pick = standard(rmin, s, 'up');
  }
  const chosen = rp > 0 ? rp : null;
  const values = [
    { label: 'Minimum pull-up', value: fmtEng(rmin, 'Ω'), hint: `sink ${fmtEng(m.iol, 'A')} at VOL ${vol} V` },
    { label: 'Maximum pull-up', value: fmtEng(rmax, 'Ω'), hint: `rise time ${fmtEng(m.tr, 's')}` },
  ];
  if (pick && !chosen) {
    const tr = 0.8473 * pick * c;
    values.push(
      { label: `Suggested (${series})`, value: fmtEng(pick, 'Ω'), tone: 'ok' },
      { label: 'Rise time with it', value: fmtEng(tr, 's'), tone: tr <= m.tr ? 'ok' : 'bad', hint: `limit ${fmtEng(m.tr, 's')}` },
      { label: 'Current when low', value: fmtEng(vdd / pick, 'A'), hint: 'per line' },
    );
  }
  if (chosen) {
    // A pull-up the person chose (dragged on the ruler, or given as rp).
    const tr = 0.8473 * chosen * c;
    if (pick) values.push({ label: `Suggested (${series})`, value: fmtEng(pick, 'Ω'), tone: 'ok' });
    values.push(
      { label: 'Chosen pull-up', value: fmtEng(chosen, 'Ω'), tone: chosen >= rmin && chosen <= rmax ? 'ok' : 'bad' },
      { label: 'Rise time with it', value: fmtEng(tr, 's'), tone: tr <= m.tr ? 'ok' : 'bad', hint: `limit ${fmtEng(m.tr, 's')}` },
      { label: 'Current when low', value: fmtEng(vdd / chosen, 'A'), ...(chosen < rmin ? { tone: 'bad' } : {}), hint: 'per line' },
    );
    if (tr > m.tr) warnings.push(`${fmtEng(chosen, 'Ω')} is too weak: the bus rises in ${fmtEng(tr, 's')}, over ${m.name}'s ${fmtEng(m.tr, 's')}. Use at most ${fmtEng(rmax, 'Ω')}.`);
    if (chosen < rmin) warnings.push(`${fmtEng(chosen, 'Ω')} is too strong: a device pulling low at ${vol} V has to sink ${fmtEng((vdd - vol) / chosen, 'A')}, over the ${fmtEng(m.iol, 'A')} it is specified for. Use at least ${fmtEng(rmin, 'Ω')}.`);
  }
  // What the bus is made of: the devices' pin capacitance, and the rest of
  // the bus capacitance counted as wiring (traces, cable, connectors).
  const devs = readDevices(devices);
  const cdev = devs.reduce((a, d) => a + d.pf, 0);
  const per = pfcm > 0 ? pfcm : 1;
  const wirePf = Math.max(0, cb - cdev);
  const r = chosen || pick;
  const bus = {
    vdd, vol, iol: m.iol, mode: MODES[mode] ? mode : 'fast', modeName: m.name, trMax: m.tr, cmax: m.cmax,
    cb: c, devices: devs, cdev: cdev * 1e-12, cwire: wirePf * 1e-12, pfcm: per, wireCm: wirePf / per,
    rmin, rmax, fits: rmin <= rmax, pick, r, chosen: !!chosen,
    tr: r ? 0.8473 * r * c : null, tau: r ? r * c : null, tauMin: rmin * c, tauMax: rmax * c, trAtRmin: 0.8473 * rmin * c,
    iLow: r ? vdd / r : null, iSink: r ? (vdd - vol) / r : null,
    v30: 0.3 * vdd, v70: 0.7 * vdd,
    modes: Object.entries(MODES).map(([k, x]) => ({ key: k, name: x.name, short: x.short, f: x.f, trMax: x.tr })),
  };
  const caps = [50, 100, 150, 200, 300, 400];
  const notes = ['Rise time is measured from 30 % to 70 % of VDD; 0.8473 = ln(0.7/0.3).',
    'With several pull-ups on one bus, they act in parallel: count them together.'];
  if (cdev > cb) notes.push(`The devices listed add ${fmtEng(cdev * 1e-12, 'F')}, more than the bus capacitance of ${fmtEng(c, 'F')}: raise the bus capacitance to at least that.`);
  return {
    values,
    warnings,
    bus,
    tables: [{
      title: `${m.name}: the range at other bus capacitances`,
      columns: ['Bus capacitance', 'Min pull-up', 'Max pull-up', 'Fits?'],
      rows: caps.map((p) => {
        const hi = m.tr / (0.8473 * p * 1e-12);
        return [`${p} pF`, fmtEng(rmin, 'Ω'), fmtEng(hi, 'Ω'), hi >= rmin ? 'yes' : 'no'];
      }),
    }],
    notes,
  };
}
