// CAN (classic / FD nominal phase) bit timing.
//   tq = prescale·BRP / f_clk         (prescale = 2 on MCP2515 and SJA1000)
//   bit = N·tq,  N = 1 (sync) + TSEG1 + TSEG2,  TSEG1 = PropSeg + PS1
//   sample point = (1 + TSEG1) / N
// Propagation segment: t_prop = 2·(t_bus + t_loop), t_bus = 5 ns/m
// (Bosch, "The Configuration of the CAN Bit Timing", 1999, §4).
// Oscillator tolerance (ISO 11898-1 §11.3.1, Bosch ibid. §5):
//   df ≤ min(PS1, PS2) / (2·(13·N − PS2))   and   df ≤ SJW / (20·N)
// Recommended sample points from CiA 301 (87.5 % up to 800 kbit/s).
import { fmtEng, fmtNum } from '../kit/eng.js';

const CTRL = {
  bxcan: { name: 'STM32 bxCAN', pre: 1, brp: [1, 1024], ts1: [1, 16], ts2: [1, 8], sjw: 4 },
  fdcan: { name: 'STM32 FDCAN / Bosch M_CAN (nominal)', pre: 1, brp: [1, 512], ts1: [2, 256], ts2: [2, 128], sjw: 128 },
  mcp2515: { name: 'MCP2515', pre: 2, brp: [1, 64], ts1: [2, 16], ts2: [2, 8], sjw: 4 },
  sja1000: { name: 'SJA1000', pre: 2, brp: [1, 64], ts1: [1, 16], ts2: [1, 8], sjw: 4 },
  twai: { name: 'ESP32 TWAI', pre: 1, brp: [2, 128], ts1: [1, 16], ts2: [1, 8], sjw: 4, even: true },
  flexcan: { name: 'NXP FlexCAN (CTRL1)', pre: 1, brp: [1, 256], ts1: [2, 16], ts2: [2, 8], sjw: 4 },
};

const hex = (v, n = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(n, '0');

function registers(c, key, r) {
  const { brp, ts1, ts2, sjw, prop, ps1 } = r;
  if (key === 'bxcan') return [['CAN_BTR', hex(((sjw - 1) << 24) | ((ts2 - 1) << 20) | ((ts1 - 1) << 16) | (brp - 1)), 'SJW[25:24] TS2[22:20] TS1[19:16] BRP[9:0]'],
    ['HAL', `Prescaler=${brp}, SyncJumpWidth=CAN_SJW_${sjw}TQ, TimeSeg1=CAN_BS1_${ts1}TQ, TimeSeg2=CAN_BS2_${ts2}TQ`, '']];
  if (key === 'fdcan') return [['FDCAN_NBTP', hex((((sjw - 1) << 25) | ((brp - 1) << 16) | ((ts1 - 1) << 8) | (ts2 - 1)) >>> 0), 'NSJW[31:25] NBRP[24:16] NTSEG1[15:8] NTSEG2[6:0]'],
    ['HAL', `NominalPrescaler=${brp}, NominalSyncJumpWidth=${sjw}, NominalTimeSeg1=${ts1}, NominalTimeSeg2=${ts2}`, '']];
  if (key === 'mcp2515') return [['CNF1', hex(((sjw - 1) << 6) | (brp - 1), 2), 'SJW[7:6] BRP[5:0]'],
    ['CNF2', hex(0x80 | ((ps1 - 1) << 3) | (prop - 1), 2), 'BTLMODE=1, SAM=0, PHSEG1[5:3], PRSEG[2:0]'],
    ['CNF3', hex(ts2 - 1, 2), 'PHSEG2[2:0]']];
  if (key === 'sja1000') return [['BTR0', hex(((sjw - 1) << 6) | (brp - 1), 2), 'SJW[7:6] BRP[5:0]'],
    ['BTR1', hex(((ts2 - 1) << 4) | (ts1 - 1), 2), 'SAM=0, TSEG2[6:4] TSEG1[3:0]']];
  if (key === 'twai') return [['twai_timing_config_t', `{ .brp = ${brp}, .tseg_1 = ${ts1}, .tseg_2 = ${ts2}, .sjw = ${sjw}, .triple_sampling = false }`, 'ESP-IDF']];
  // FlexCAN CTRL1: PRESDIV[31:24] RJW[23:22] PSEG1[21:19] PSEG2[18:16] PROPSEG[2:0]
  const fp1 = Math.min(8, ts1 - 1), fprop = ts1 - fp1;
  if (fprop > 8 || fprop < 1) return [['CTRL1', '–', 'TSEG1 does not split into PROPSEG ≤ 8 + PSEG1 ≤ 8']];
  return [['CAN_CTRL1', hex((((brp - 1) << 24) | ((Math.min(sjw, 4) - 1) << 22) | ((fp1 - 1) << 19) | ((ts2 - 1) << 16) | (fprop - 1)) >>> 0), 'PRESDIV, RJW, PSEG1, PSEG2, PROPSEG']];
}

// The same registers as bit fields, for the register card: [{name, bits, fields:
// [{name, hi, lo, value}]}]; fixed bits are fields too. value = field contents.
function regFields(key, r) {
  const { brp, ts1, ts2, sjw, prop, ps1 } = r;
  const F = (name, hi, lo, value) => ({ name, hi, lo, value });
  if (key === 'bxcan') return [{ name: 'CAN_BTR', bits: 32, fields: [F('SJW', 25, 24, sjw - 1), F('TS2', 22, 20, ts2 - 1), F('TS1', 19, 16, ts1 - 1), F('BRP', 9, 0, brp - 1)] }];
  if (key === 'fdcan') return [{ name: 'FDCAN_NBTP', bits: 32, fields: [F('NSJW', 31, 25, sjw - 1), F('NBRP', 24, 16, brp - 1), F('NTSEG1', 15, 8, ts1 - 1), F('NTSEG2', 6, 0, ts2 - 1)] }];
  if (key === 'mcp2515') return [{ name: 'CNF1', bits: 8, fields: [F('SJW', 7, 6, sjw - 1), F('BRP', 5, 0, brp - 1)] },
    { name: 'CNF2', bits: 8, fields: [F('BTLMODE', 7, 7, 1), F('SAM', 6, 6, 0), F('PHSEG1', 5, 3, ps1 - 1), F('PRSEG', 2, 0, prop - 1)] },
    { name: 'CNF3', bits: 8, fields: [F('PHSEG2', 2, 0, ts2 - 1)] }];
  if (key === 'sja1000') return [{ name: 'BTR0', bits: 8, fields: [F('SJW', 7, 6, sjw - 1), F('BRP', 5, 0, brp - 1)] },
    { name: 'BTR1', bits: 8, fields: [F('SAM', 7, 7, 0), F('TSEG2', 6, 4, ts2 - 1), F('TSEG1', 3, 0, ts1 - 1)] }];
  if (key === 'twai') return [];
  const fp1 = Math.min(8, ts1 - 1), fprop = ts1 - fp1;
  if (fprop > 8 || fprop < 1) return [];
  return [{ name: 'CAN_CTRL1', bits: 32, fields: [F('PRESDIV', 31, 24, brp - 1), F('RJW', 23, 22, Math.min(sjw, 4) - 1), F('PSEG1', 21, 19, fp1 - 1), F('PSEG2', 18, 16, ts2 - 1), F('PROPSEG', 2, 0, fprop - 1)] }];
}

export function run({ controller, fclk, bitrate, sp, busLen, loopDelay, tolErr, brp: pinBrp }) {
  const key = CTRL[controller] ? controller : 'bxcan';
  const c = CTRL[key];
  const warnings = [], notes = [];
  if (!(fclk > 0)) return { warnings: ['Give the CAN clock in Hz, e.g. 36M (the controller\'s input clock, not the core clock).'] };
  if (!(bitrate > 0)) return { warnings: ['Give the bit rate in bit/s, e.g. 500k.'] };
  if (bitrate > 1e6) warnings.push('Classic CAN and the FD arbitration phase stop at 1 Mbit/s; for an FD data phase use the data-phase timing registers.');
  let target = sp > 0 ? sp / 100 : bitrate > 800e3 ? 0.75 : bitrate > 500e3 ? 0.8 : 0.875;
  if (target < 0.5 || target > 0.95) { warnings.push('A sample point outside 50–95 % is not usable; 87.5 % is used.'); target = 0.875; }
  const maxErr = (tolErr >= 0 ? tolErr : 0.5) / 100;
  const nMin = 1 + c.ts1[0] + c.ts2[0], nMax = 1 + c.ts1[1] + c.ts2[1];

  const cands = [];
  for (let brp = c.brp[0]; brp <= c.brp[1]; brp++) {
    if (c.even && brp % 2) continue;
    const tq = (c.pre * brp) / fclk;
    const nf = 1 / (tq * bitrate);
    for (const n of new Set([Math.floor(nf), Math.ceil(nf)])) {
      if (n < nMin || n > nMax) continue;
      const rate = 1 / (n * tq);
      let err = (rate - bitrate) / bitrate;
      if (Math.abs(err) < 1e-9) err = 0;
      if (Math.abs(err) > maxErr + 1e-12) continue;
      // Every legal TSEG1/TSEG2 split: a long bus may need a later sample
      // point than the target, and the ranking below picks the best one.
      for (let ts1 = Math.max(c.ts1[0], n - 1 - c.ts2[1]); ts1 <= Math.min(c.ts1[1], n - 1 - c.ts2[0]); ts1++) {
        const ts2 = n - 1 - ts1;
        cands.push({ brp, n, ts1, ts2, tq, rate, err, sp: (1 + ts1) / n });
      }
    }
  }
  if (!cands.length) {
    return { warnings: [...warnings, `No ${c.name} setting gives ${fmtEng(bitrate, 'bit/s')} from ${fmtEng(fclk, 'Hz')} within ±${fmtNum(maxErr * 100, 3)} %. The clock must be a multiple of the bit rate times ${nMin}–${nMax} quanta${c.pre > 1 ? ' times 2' : ''}: change the clock (e.g. 8, 16, 24, 36, 40, 48 or 80 MHz) or allow a larger rate error.`] };
  }
  // Propagation segment in quanta, then PS1 = TSEG1 − Prop.
  const L = busLen >= 0 ? busLen : 0, tl = loopDelay >= 0 ? loopDelay * 1e-9 : 150e-9;
  const tProp = 2 * (L * 5e-9 + tl);
  const finish = (r) => {
    const need = Math.ceil(tProp / r.tq - 1e-9);
    let prop = need;
    // MCP2515 has its own PRSEG (1-8) and PHSEG1 (1-8) fields.
    if (key === 'mcp2515') prop = Math.min(8, Math.max(1, need, r.ts1 - 8));
    const ps1 = r.ts1 - prop;
    const sjw = Math.max(1, Math.min(c.sjw, r.ts2 - (key === 'mcp2515' ? 1 : 0), Math.max(1, ps1)));
    const nbt = r.n;
    const df = ps1 >= 1 ? Math.min(Math.min(ps1, r.ts2) / (2 * (13 * nbt - r.ts2)), sjw / (20 * nbt)) : 0;
    return { ...r, need, prop, ps1, sjw, df };
  };
  // Why a setting cannot be used, or null. A setting is only offered when the
  // propagation segment covers the round trip, a phase segment 1 is left, and
  // every register field holds its value.
  const problem = (r) => {
    if (r.prop < r.need) return `the propagation delay needs ${r.need} tq of PROP_SEG but the ${c.name} holds at most ${r.prop}`;
    if (r.ps1 < 1) return `the propagation delay needs ${r.need} tq of TSEG1's ${r.ts1}, leaving no phase segment 1`;
    if (key === 'mcp2515') {
      if (r.ps1 > 8) return `PHSEG1 would be ${r.ps1} tq (MCP2515 max 8)`;
      if (r.ts1 < r.ts2) return 'PRSEG + PHSEG1 would be shorter than PHSEG2';
    }
    for (const g of regFields(key, r)) {
      for (const fl of g.fields) {
        if (!(fl.value >= 0 && fl.value < 2 ** (fl.hi - fl.lo + 1))) return `${g.name}.${fl.name} = ${fl.value} does not fit its ${fl.hi - fl.lo + 1}-bit field`;
      }
    }
    if (key === 'flexcan' && !regFields(key, r).length) return 'TSEG1 does not split into PROPSEG ≤ 8 + PSEG1 ≤ 8';
    return null;
  };
  // Rank (an engineering choice, see the note):
  //   1. the lowest rate error;
  //   2. a sample point within ±SP_TOL of the target counts as on target;
  //   3. then quanta per bit in CiA's recommended 16-25 (closest to it otherwise),
  //      for fine resynchronisation (larger PS2 and SJW) without a tiny tq;
  //   4. then the sample point nearest the target;
  //   5. then more quanta.
  const SP_TOL = 0.015;
  const rank = (r) => {
    const dsp = Math.abs(r.sp - target);
    return [Math.round(Math.abs(r.err) * 1e9), dsp <= SP_TOL + 1e-9 ? 0 : 1, r.n < 16 ? 16 - r.n : r.n > 25 ? r.n - 25 : 0, Math.round(dsp * 1e6), -r.n];
  };
  const cmp = (x, y) => { const a = x.key, b2 = y.key; for (let i = 0; i < a.length; i++) if (a[i] !== b2[i]) return a[i] - b2[i]; return x.brp - y.brp; };
  const seen = new Set();
  const all = cands.map((r) => { const f = finish(r); f.key = rank(f); return f; }).sort(cmp)
    .filter((r) => { const k = `${r.brp}/${r.ts1}/${r.ts2}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const uniq = all.filter((r) => !problem(r));

  const drawing = (b, pinned, list) => ({ sync: 1, prop: Math.min(b.prop, b.ts1), ps1: Math.max(0, b.ps1), ps2: b.ts2, sp: b.sp, tq: b.tq, sjw: b.sjw,
    // For the interactive page: the chosen setting, the propagation budget,
    // the controller's limits, every prescaler that works and the registers as fields.
    controller: key, brp: b.brp, n: b.n, ts1: b.ts1, ts2: b.ts2, propNeed: b.need, rate: b.rate, err: b.err, df: b.df,
    target, pinned: !!pinned, tProp, tBus: L * 5e-9, tLoop: tl, busLen: L,
    maxLen: Math.max(0, ((Math.min(b.ts1 - 1, key === 'mcp2515' ? 8 : Infinity)) * b.tq / 2 - tl) / 5e-9),
    limits: { brp: c.brp, ts1: c.ts1, ts2: c.ts2, sjw: c.sjw, pre: c.pre, even: !!c.even },
    candidates: list.filter((r, i, a) => a.findIndex((x) => x.brp === r.brp) === i)
      .sort((x, y) => x.brp - y.brp)
      .map((r) => ({ brp: r.brp, n: r.n, ts1: r.ts1, ts2: r.ts2, prop: r.prop, ps1: r.ps1, sjw: r.sjw, sp: r.sp, err: r.err, df: r.df, rate: r.rate })),
    registers: list.length ? regFields(key, b) : [],
    invalid: list.length ? null : problem(b) });

  const propNote = (b) => `Propagation: 2·(bus ${fmtNum(L, 3)} m × 5 ns/m + loop ${fmtEng(tl, 's')}) = ${fmtEng(tProp, 's')} → ${b.need} tq. Controllers without a separate PropSeg field put it inside TSEG1.`;
  notes.push(`${c.name}: tq = ${c.pre > 1 ? '2·' : ''}BRP / f_clk; BRP ${c.brp[0]}–${c.brp[1]}${c.even ? ' (even)' : ''}, TSEG1 ${c.ts1[0]}–${c.ts1[1]}, TSEG2 ${c.ts2[0]}–${c.ts2[1]}, SJW ≤ ${c.sjw}. Register fields hold value − 1.`);
  if (!uniq.length) {
    // Settings give the bit rate, but none is legal: say why for the best of them.
    const w = all[0];
    warnings.push(`No legal ${c.name} setting for ${fmtEng(bitrate, 'bit/s')} from ${fmtEng(fclk, 'Hz')} with a ${fmtNum(L, 3)} m bus: at best (BRP ${w.brp}, ${w.n} tq) ${problem(w)}. Shorten the bus, lower the bit rate, use a transceiver with a shorter loop delay, or change the clock.`);
    notes.push(propNote(w));
    return { warnings, notes, drawing: drawing(w, false, []) };
  }
  // A prescaler the person picked (a clicked candidate) wins over the ranking.
  const pinned = pinBrp > 0 ? uniq.find((r) => r.brp === Math.round(pinBrp)) : null;
  if (pinBrp > 0 && !pinned) warnings.push(`Prescaler ${fmtNum(pinBrp, 4)} gives no legal ${c.name} setting for ${fmtEng(bitrate, 'bit/s')}; the best prescaler (${uniq[0].brp}) is used instead.`);
  const b = pinned || uniq[0];

  if (Math.abs(b.err) > 0) warnings.push(`The bit rate is off by ${fmtNum(b.err * 100, 3)} %. Every node's oscillator error adds to this; keep the total under the ${fmtNum(b.df * 100, 3)} % tolerance.`);
  if (Math.abs(b.sp - target) > 0.02) warnings.push(`The nearest sample point is ${fmtNum(b.sp * 100, 3)} %, ${fmtNum(Math.abs(b.sp - target) * 100, 2)} points from the ${fmtNum(target * 100, 3)} % target. All nodes on the bus should sample within a few percent of each other.`);
  if (b.df > 0 && b.df < 0.001) warnings.push(`Oscillator tolerance ±${fmtNum(b.df * 100, 3)} % is tight: use a crystal (±0.005 %), not an RC oscillator.`);
  if (b.n < 8) warnings.push(`Only ${b.n} quanta per bit: PS2 and SJW are ${b.ts2} and ${b.sjw} tq, so resynchronisation is coarse. A setting with more quanta (a smaller prescaler) resynchronises more finely.`);

  const values = [
    { label: 'Prescaler (BRP)', value: b.brp, tone: 'ok' },
    { label: 'Quanta per bit', value: b.n, hint: `tq = ${fmtEng(b.tq, 's')}` },
    { label: 'TSEG1 (Prop + PS1)', value: b.ts1, hint: `Prop ${b.prop} + PS1 ${b.ps1}` },
    { label: 'TSEG2 (PS2)', value: b.ts2 },
    { label: 'SJW', value: b.sjw },
    { label: 'Sample point', value: fmtNum(b.sp * 100, 4), unit: '%', tone: Math.abs(b.sp - target) <= 0.02 ? 'ok' : 'warn', hint: `target ${fmtNum(target * 100, 3)} %` },
    { label: 'Actual bit rate', value: fmtEng(b.rate, 'bit/s'), tone: b.err === 0 ? 'ok' : 'warn', hint: b.err === 0 ? 'exact' : `${fmtNum(b.err * 100, 3)} %` },
    { label: 'Oscillator tolerance', value: `±${fmtNum(b.df * 100, 3)}`, unit: '%', tone: b.df >= 0.001 ? 'ok' : 'warn', hint: 'per node, ISO 11898-1' },
  ];
  const regs = registers(c, key, b);
  notes.push(propNote(b));
  notes.push(`Choice: exact rate first; sample points within ±${SP_TOL * 100} point of the target count as equal, and among those 16–25 quanta per bit (CiA recommendation) win over a closer sample point with fewer quanta, because more quanta give finer resynchronisation steps and room for a PS2 and SJW of several quanta. Then the nearest sample point, then more quanta.`);
  notes.push('CiA 301 sample points: 87.5 % up to 500 kbit/s, 80 % at 800 kbit/s, 75 % at 1 Mbit/s. Every node should use about the same.');

  return {
    values,
    warnings,
    tables: [
      { title: 'Registers', columns: ['Register', 'Value', 'Fields'], rows: regs },
      { title: 'Other settings', columns: ['BRP', 'Quanta', 'TSEG1', 'TSEG2', 'Sample point', 'Rate error', 'Osc. tolerance'],
        rows: uniq.slice(0, 10).map((r) => [r.brp, r.n, r.ts1, r.ts2, `${fmtNum(r.sp * 100, 4)} %`, `${fmtNum(r.err * 100, 3)} %`, `±${fmtNum(r.df * 100, 3)} %`]) },
    ],
    drawing: drawing(b, pinned, uniq),
    notes,
  };
}
