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

export function run({ controller, fclk, bitrate, sp, busLen, loopDelay, tolErr }) {
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
      for (const s1 of new Set([Math.floor(target * n) - 1, Math.ceil(target * n) - 1])) {
        const ts1 = Math.min(c.ts1[1], Math.max(c.ts1[0], s1)), ts2 = n - 1 - ts1;
        if (ts2 < c.ts2[0] || ts2 > c.ts2[1]) continue;
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
    let prop = Math.ceil(tProp / r.tq - 1e-9);
    if (key === 'mcp2515') prop = Math.min(8, Math.max(1, prop, r.ts1 - 8));
    const ps1 = r.ts1 - prop;
    const sjw = Math.max(1, Math.min(c.sjw, r.ts2 - (key === 'mcp2515' ? 1 : 0), Math.max(1, ps1)));
    const nbt = r.n;
    const df = ps1 >= 1 ? Math.min(Math.min(ps1, r.ts2) / (2 * (13 * nbt - r.ts2)), sjw / (20 * nbt)) : 0;
    return { ...r, prop, ps1, sjw, df };
  };
  // Rank: exact rate first, then a sample point that leaves room after the
  // propagation segment, then sample-point error, then more quanta (finer
  // resynchronisation; fewer than 10 quanta leave PS2 and SJW at 1-2 tq).
  const score = (r) => Math.abs(r.err) * 100 + (r.ps1 < 1 ? 1 : 0) + Math.abs(r.sp - target)
    + (r.n < 8 ? 0.05 : r.n < 10 ? 0.02 : 0) + (r.n > 25 ? 0.01 : 0) - r.n * 5e-4;
  const seen = new Set();
  const uniq = cands.map(finish).sort((x, y) => score(x) - score(y))
    .filter((r) => { const k = `${r.brp}/${r.ts1}/${r.ts2}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const b = uniq[0];

  if (b.ps1 < 1) warnings.push(`The propagation delay ${fmtEng(tProp, 's')} (${fmtNum(L, 3)} m bus, ${fmtEng(tl, 's')} loop) needs ${b.prop} tq of TSEG1's ${b.ts1}, leaving no phase segment 1: the sample point comes before the signal from the far node settles. Shorten the bus, lower the bit rate, or raise the sample point.`);
  else if (key === 'mcp2515' && b.ps1 > 8) warnings.push('MCP2515: PHSEG1 would exceed 8 tq; choose a lower sample point or more quanta.');
  if (Math.abs(b.err) > 0) warnings.push(`The bit rate is off by ${fmtNum(b.err * 100, 3)} %. Every node's oscillator error adds to this; keep the total under the ${fmtNum(b.df * 100, 3)} % tolerance.`);
  if (Math.abs(b.sp - target) > 0.02) warnings.push(`The nearest sample point is ${fmtNum(b.sp * 100, 3)} %, ${fmtNum(Math.abs(b.sp - target) * 100, 2)} points from the ${fmtNum(target * 100, 3)} % target. All nodes on the bus should sample within a few percent of each other.`);
  if (b.df > 0 && b.df < 0.001) warnings.push(`Oscillator tolerance ±${fmtNum(b.df * 100, 3)} % is tight: use a crystal (±0.005 %), not an RC oscillator.`);

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
  notes.push(`${c.name}: tq = ${c.pre > 1 ? '2·' : ''}BRP / f_clk; BRP ${c.brp[0]}–${c.brp[1]}${c.even ? ' (even)' : ''}, TSEG1 ${c.ts1[0]}–${c.ts1[1]}, TSEG2 ${c.ts2[0]}–${c.ts2[1]}, SJW ≤ ${c.sjw}. Register fields hold value − 1.`);
  notes.push(`Propagation: 2·(bus ${fmtNum(L, 3)} m × 5 ns/m + loop ${fmtEng(tl, 's')}) = ${fmtEng(tProp, 's')} → ${b.prop} tq. Controllers without a separate PropSeg field put it inside TSEG1.`);
  notes.push('CiA 301 sample points: 87.5 % up to 500 kbit/s, 80 % at 800 kbit/s, 75 % at 1 Mbit/s. Every node should use about the same.');

  return {
    values,
    warnings,
    tables: [
      { title: 'Registers', columns: ['Register', 'Value', 'Fields'], rows: regs },
      { title: 'Other settings', columns: ['BRP', 'Quanta', 'TSEG1', 'TSEG2', 'Sample point', 'Rate error', 'Osc. tolerance'],
        rows: uniq.slice(0, 10).map((r) => [r.brp, r.n, r.ts1, r.ts2, `${fmtNum(r.sp * 100, 4)} %`, `${fmtNum(r.err * 100, 3)} %`, r.df > 0 ? `±${fmtNum(r.df * 100, 3)} %` : 'too short']) },
    ],
    drawing: { sync: 1, prop: Math.min(b.prop, b.ts1), ps1: Math.max(0, b.ps1), ps2: b.ts2, sp: b.sp, tq: b.tq, sjw: b.sjw },
    notes,
  };
}
