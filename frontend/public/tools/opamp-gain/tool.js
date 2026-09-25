// Op-amp gain stage, voltage-feedback, single-pole model.
//   Non-inverting G = 1 + Rf/Rg,  inverting G = −Rf/Rg,  noise gain NG = 1 + Rf/Rg   (ADI MT-033)
//   f−3dB = GBW / NG;  |G(f)| = |G| / √(1 + (f/f−3dB)²),  phase lag = atan(f/f−3dB)
//   Output offset (ADI MT-037, MT-038), bias currents Ib± = Ib ± Ios/2 into the inputs:
//     Vout,os = NG·Vos + Ib·(Rf − NG·Rp) + ½·Ios·(Rf + NG·Rp),  Rp = resistance at + input
//   Full-power bandwidth = SR / (2π·Vout,peak)   (TI SLOA011)
import { fmtEng, fmtNum, standard, SERIES } from '../kit/eng.js';

const db = (x) => 20 * Math.log10(Math.abs(x));

export function run(i) {
  const { cfg, rf, rg, target, series, gbw, sr, vos, ib, ios, rp, vin, fsig, vpos, vneg, swing } = i;
  const warnings = [];
  const inv = cfg === 'inv';
  if (!(rf >= 0) || !(rg > 0)) return { warnings: ['Give Rf (0 or more) and Rg (above 0) in ohms.'] };
  const G = inv ? -rf / rg : 1 + rf / rg;
  const NG = 1 + rf / rg;
  const Rp = rp > 0 ? rp : 0;
  // result.stage: the same numbers as plain values, for the page's drawing (and agents).
  const stage = { cfg: inv ? 'inv' : 'noninv', G, NG, gainDb: db(G), rf, rg, rp: Rp, gbw: gbw > 0 ? gbw : null, bw: null, fsig: fsig > 0 ? fsig : null };
  const values = [
    { label: 'Signal gain', value: fmtNum(G, 4), unit: 'V/V', tone: 'ok', hint: `${fmtNum(db(G), 3)} dB${inv ? ', inverted' : ''}` },
    { label: 'Noise gain', value: fmtNum(NG, 4), unit: 'V/V', hint: 'sets bandwidth and offset' },
  ];

  let bw = null;
  if (gbw > 0) {
    bw = gbw / NG;
    stage.bw = bw;
    values.push({ label: 'Bandwidth (−3 dB)', value: fmtEng(bw, 'Hz'), hint: `GBW ${fmtEng(gbw, 'Hz')} / ${fmtNum(NG, 3)}` });
    if (fsig > 0) {
      const r = 1 / Math.sqrt(1 + (fsig / bw) ** 2);
      const errPct = (1 - r) * 100;
      const ph = (Math.atan(fsig / bw) * 180) / Math.PI;
      Object.assign(stage, { atF: r, errPct, phase: ph });
      values.push({ label: `Gain error at ${fmtEng(fsig, 'Hz')}`, value: `${fmtNum(errPct, 3)} %`, tone: errPct > 10 ? 'bad' : errPct > 1 ? 'warn' : 'ok', hint: `phase lag ${fmtNum(ph, 3)}°` });
      if (fsig > bw) warnings.push(`The signal (${fmtEng(fsig, 'Hz')}) is above the stage's ${fmtEng(bw, 'Hz')} bandwidth: pick an op-amp with GBW above ${fmtEng(fsig * NG * 10, 'Hz')} (10× margin) or split the gain over two stages.`);
      else if (errPct > 1) warnings.push(`Gain drops ${fmtNum(errPct, 2)} % at ${fmtEng(fsig, 'Hz')}: for 1 % accuracy the GBW should be about 7× NG·f = ${fmtEng(7 * NG * fsig, 'Hz')}.`);
    }
  } else warnings.push('No GBW given: bandwidth is not computed.');

  // offset
  const vosV = vos > 0 ? vos * 1e-6 : 0, ibA = ib ? ib * 1e-9 : 0, iosA = ios > 0 ? ios * 1e-9 : 0;
  const oVos = NG * vosV;
  const oIb = Math.abs(ibA * (rf - NG * Rp));
  const oIos = 0.5 * iosA * (rf + NG * Rp);
  const oTot = oVos + oIb + oIos;
  const rpBest = (rf * rg) / (rf + rg);
  stage.offset = { vos: oVos, ib: oIb, ios: oIos, total: oTot, inputReferred: oTot / Math.abs(G || 1), rpBest, rpBestE24: standard(rpBest, SERIES.E24) };
  stage.rin = inv ? rg : null;
  values.push(
    { label: 'Output offset (worst)', value: fmtEng(oTot, 'V'), hint: `input-referred ${fmtEng(oTot / Math.abs(G || 1), 'V')}` },
    { label: '… from Vos', value: fmtEng(oVos, 'V') },
    { label: '… from bias current', value: fmtEng(oIb + oIos, 'V'), hint: Rp ? `Rp ${fmtEng(Rp, 'Ω')}` : `Rp = ${fmtEng(rpBest, 'Ω')} would cancel Ib` },
  );
  if (oIb > oVos && ibA > 0) warnings.push(`Bias current adds more offset (${fmtEng(oIb, 'V')}) than Vos: put ${fmtEng(standard(rpBest, SERIES.E24), 'Ω')} (≈ Rf‖Rg) in series with the + input, or use lower resistor values or a CMOS/JFET op-amp.`);
  values.push({ label: 'Input impedance', value: inv ? fmtEng(rg, 'Ω') : 'very high', hint: inv ? 'Rg, seen by the source' : 'the op-amp input' });

  // output swing and slew
  const vop = Math.abs(G) * (vin > 0 ? vin : 0);
  if (vin > 0) {
    const hr = swing >= 0 ? swing : 0;
    const hi = (vpos ?? 0) - hr, lo = (vneg ?? 0) + hr;
    const mid = (vpos != null && vneg != null && vneg >= 0) ? ((vpos + vneg) / 2) : 0;
    const clips = vpos != null && vneg != null && (mid + vop > hi || mid - vop < lo);
    stage.swing = { vin, vop, hi, lo, mid, clips, vpos, vneg, headroom: hr };
    values.push({ label: 'Output peak', value: fmtEng(vop, 'V'), tone: clips ? 'bad' : 'ok',
      hint: `swing ${fmtNum(lo, 3)} … ${fmtNum(hi, 3)} V${mid ? `, centred at ${fmtNum(mid, 3)} V` : ''}` });
    if (clips) warnings.push(`The output (±${fmtEng(vop, 'V')} around ${fmtNum(mid, 3)} V) clips against the ${fmtNum(lo, 3)} … ${fmtNum(hi, 3)} V swing: lower the gain or the input, or widen the supply.`);
    if (sr > 0 && vop > 0) {
      const fpbw = (sr * 1e6) / (2 * Math.PI * vop);
      stage.slew = { sr, fpbw, need: fsig > 0 ? (2 * Math.PI * fsig * vop) / 1e6 : null, limited: fsig > fpbw };
      values.push({ label: 'Full-power bandwidth', value: fmtEng(fpbw, 'Hz'), tone: fsig > fpbw ? 'bad' : 'ok', hint: `slew limit at ±${fmtEng(vop, 'V')}` });
      if (fsig > fpbw) warnings.push(`At ${fmtEng(fsig, 'Hz')} and ${fmtEng(vop, 'V')} peak the output needs ${fmtNum((2 * Math.PI * fsig * vop) / 1e6, 3)} V/µs but the op-amp slews ${fmtNum(sr, 3)} V/µs: it will distort into triangles. Use a faster op-amp or less output swing.`);
    }
  }
  if (vneg != null && vpos != null && vneg >= 0 && inv) warnings.push('Inverting stage on a single supply: bias the + input to mid-rail (and AC-couple the input) or the output tries to go below ground.');
  if (rf > 1e6 || rg > 1e6) warnings.push('Resistors above 1 MΩ make bias-current offset, noise and stray-capacitance peaking worse; scale both down.');
  if (rf > 0 && rf < 1e3 && rg < 1e3) warnings.push('Both resistors under 1 kΩ load the op-amp output heavily; check its output current.');

  // target gain
  const tables = [];
  if (target != null && Number.isFinite(target) && target !== 0) {
    const s = SERIES[series] || SERIES.E96;
    let need;
    if (inv) {
      if (target > 0) warnings.push('An inverting stage gives a negative gain; the target\'s magnitude was used.');
      need = Math.abs(target) * rg;
    } else {
      if (target < 1) warnings.push('A non-inverting stage cannot have a gain below 1; use a divider in front or an inverting stage.');
      need = (Math.max(target, 1) - 1) * rg;
    }
    const cands = need > 0 ? [standard(need, s, 'down'), standard(need, s), standard(need, s, 'up')].filter((v, k, a) => v && a.indexOf(v) === k) : [0];
    stage.target = { gain: target, rfNeeded: need, series: series || 'E96',
      options: cands.map((v) => { const g = inv ? -v / rg : 1 + v / rg; return { rf: v, gain: g, errPct: (g / (inv ? -Math.abs(target) : Math.max(target, 1)) - 1) * 100, bw: gbw > 0 ? gbw / (1 + v / rg) : null }; }) };
    tables.push({
      title: `Rf for a gain of ${fmtNum(target, 4)} with Rg = ${fmtEng(rg, 'Ω')} (${series || 'E96'})`,
      columns: ['Rf', 'Gain', 'Error', 'Bandwidth'],
      rows: cands.map((v) => {
        const g = inv ? -v / rg : 1 + v / rg;
        return [v === 0 ? '0 Ω (short)' : fmtEng(v, 'Ω'), fmtNum(g, 5), `${fmtNum((g / (inv ? -Math.abs(target) : Math.max(target, 1)) - 1) * 100, 3)} %`, gbw > 0 ? fmtEng(gbw / (1 + v / rg), 'Hz') : '–'];
      }),
    });
  }

  let charts = [];
  if (bw) {
    const N = 41, f0 = bw / 1000, xs = [], ys = [];
    for (let k = 0; k < N; k++) {
      const fx = f0 * Math.pow(10, (5 * k) / (N - 1));
      xs.push(fmtEng(fx, 'Hz'));
      ys.push(Number(db(Math.abs(G) / Math.sqrt(1 + (fx / bw) ** 2)).toFixed(2)));
    }
    charts = [{ title: 'Closed-loop gain (single-pole model)', type: 'line', x: xs, series: [{ name: 'gain dB', y: ys }], xLabel: 'frequency (log steps)', yLabel: 'gain, dB' }];
  }

  // Bode data: closed-loop |G(f)| and the open-loop GBW/f line (capped at 100 dB,
  // a typical DC open-loop gain), over a range that holds the signal and the GBW.
  if (bw) {
    const lo = Math.min(bw / 300, fsig > 0 ? fsig / 10 : Infinity, 10);
    const hi = Math.max(gbw * 10, fsig > 0 ? fsig * 10 : 0);
    const N = 97, f = [], cl = [], ol = [];
    for (let k = 0; k < N; k++) {
      const fx = lo * Math.pow(hi / lo, k / (N - 1));
      f.push(Number(fx.toPrecision(5)));
      cl.push(Number(db(Math.abs(G) / Math.sqrt(1 + (fx / bw) ** 2)).toFixed(3)));
      ol.push(Number(Math.min(100, db(gbw / fx)).toFixed(3)));
    }
    stage.bode = { f, closed: cl, open: ol, noiseGainDb: db(NG) };
  }

  return {
    values,
    stage,
    warnings: warnings.filter(Boolean),
    charts,
    tables,
    notes: [
      'Single-pole model: real op-amps add a second pole near the unity-gain frequency, so a stage at a noise gain of 1–2 may peak; check the datasheet\'s stable-gain and phase-margin figures.',
      'An inverting stage at gain −1 has a noise gain of 2: half the bandwidth and twice the Vos of a follower.',
      'Offsets are worst case (maximum Vos and currents adding); typical parts are 3–5× better. Resistor tolerance adds gain error: two 1 % resistors give up to about 2 %.',
    ],
  };
}
