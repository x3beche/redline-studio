// ESD / TVS selection criteria by interface.
//
// The three numbers that pick a TVS for a signal line:
//   VRWM  (reverse stand-off) >= the highest voltage the line normally sees,
//         so the diode does not conduct in normal use;
//   C     (line capacitance)   <= what the signal tolerates at its speed;
//   Vclamp at the test current <= what the protected pin survives.
// Capacitance limits are the usual guidance in the TI "ESD protection layout
// guide" (SLVA680), Nexperia and Semtech interface guides, rounded; they are
// per line, to ground. The IEC 61000-4-2 contact-discharge first-peak current
// is 3.75 A per kV (7.5 / 15 / 22.5 / 30 A at levels 1-4).
import { fmtNum } from '../kit/eng.js';

// id, name, speed, line V (max normal), VRWM min, C max pF, polarity, notes, example parts
const IF = [
  ['gpio', 'GPIO, button, LED, reset', '< 1 MHz', 3.3, 3.6, 100, 'uni or bi', 'Capacitance hardly matters; a series resistor after the TVS helps.', 'TPD1E10B06 (bi, 12 pF)'],
  ['i2c', 'I2C / SMBus', '≤ 1 MHz', 3.3, 3.6, 15, 'uni or bi', 'Every pF adds to the 400 pF bus budget and slows the rise.', 'TPD1E10B06, TPD2E2U06'],
  ['uart', 'UART, SPI, low-speed digital', '≤ 20 MHz', 3.3, 3.6, 15, 'uni or bi', 'Above ~20 MHz treat it as high speed.', 'TPD2E2U06, TPD4E05U06'],
  ['rs232', 'RS-232', '≤ 1 Mb/s', 15, 15, 100, 'bidirectional', 'Lines swing ±5...±15 V; drivers survive ±25 V.', '15 V bidirectional TVS (e.g. SMF15CA)'],
  ['rs485', 'RS-485 / RS-422', '≤ 50 Mb/s', 12, 12, 75, 'asymmetric bi', 'Common-mode range -7...+12 V: use an asymmetric part.', 'SM712'],
  ['can', 'CAN (classic)', '≤ 1 Mb/s', 24, 24, 30, 'bidirectional', 'Must survive a short to the 12/24 V battery (±27 V or more).', 'NUP2105L, PESD2CAN'],
  ['canfd', 'CAN FD', '≤ 8 Mb/s', 24, 24, 15, 'bidirectional', 'Lower capacitance and matched lines keep the bit symmetry.', 'low-C 24 V CAN FD TVS (e.g. Nexperia PESD2CANFD series)'],
  ['lin', 'LIN', '≤ 20 kb/s', 18, 24, 100, 'bidirectional', 'Automotive battery line: jump-start and load dump.', 'PESD1LIN'],
  ['usb2fs', 'USB 2.0 low / full speed D+/D-', '1.5 / 12 Mb/s', 3.6, 5.5, 10, 'uni (to GND)', 'Rate VRWM at 5.5 V so a D+/VBUS short does not burn it.', 'TPD2E2U06, TPD4E05U06'],
  ['usb2hs', 'USB 2.0 high speed D+/D-', '480 Mb/s', 3.6, 5.5, 2, 'uni (to GND)', 'Flow-through package, on the connector, matched on both lines.', 'TPD2E2U06 (1.5 pF), TPD4E05U06 (0.5 pF)'],
  ['usb3', 'USB 3.x SuperSpeed TX/RX', '5-20 Gb/s', 1.2, 3.6, 0.3, 'uni (to GND)', 'Gen 1 tolerates ~0.5 pF, Gen 2 and up ~0.3 pF or less.', 'TPD4E05U06 (Gen 1); sub-0.3 pF single-line parts'],
  ['usbccc', 'USB-C CC / SBU', '≤ 1 MHz (CC)', 5.5, 22, 30, 'uni', 'CC and SBU sit next to VBUS: they must survive a 20 V short.', 'TPD8S300, TPD6S300 (port protectors)'],
  ['vbus5', 'USB VBUS 5 V', 'DC', 5.25, 5, 10000, 'unidirectional', 'Surge and hot-plug ringing; VRWM 5 V, breakdown just above 5.5 V.', 'SMF5.0A, SMAJ5.0A'],
  ['vbuspd', 'USB PD VBUS up to 20 V', 'DC', 21, 22, 10000, 'unidirectional', 'Must not conduct at 20 V + 5 %.', 'SMAJ22A, SMBJ22A'],
  ['hdmi14', 'HDMI 1.4 TMDS', '≤ 3.4 Gb/s per lane', 3.3, 3.6, 0.8, 'uni (to GND)', 'Flow-through routing; keep the pairs\' impedance under the pads.', 'TPD4E05U06, TPD13S523'],
  ['hdmi20', 'HDMI 2.x / DisplayPort HBR2-3', '6-8 Gb/s per lane', 3.3, 3.6, 0.3, 'uni (to GND)', 'Every 0.1 pF shows in the eye: use the lowest you can get.', 'sub-0.3 pF single-line parts'],
  ['lvds', 'LVDS / MIPI D-PHY', '≤ 2.5 Gb/s', 1.8, 3.6, 1, 'uni (to GND)', 'Mostly internal cables: protect only what leaves the box.', 'TPD4E05U06'],
  ['eth100', 'Ethernet 10/100BASE-T (PHY side)', '100 Mb/s', 2.5, 3.6, 5, 'rail clamp', 'The magnetics give 1.5 kV isolation; the TVS goes between them and the PHY.', 'TPD4E05U06, Semtech RClamp arrays'],
  ['eth1g', 'Ethernet 1000BASE-T (PHY side)', '1 Gb/s (4 pairs)', 2.5, 3.6, 3, 'rail clamp', 'Four pairs; low capacitance matters more than at 100 Mb/s.', 'TPD4E05U06'],
  ['sd', 'SD card (UHS-I)', '≤ 208 MHz', 3.3, 3.6, 5, 'uni (to GND)', 'CLK is the fastest line; keep capacitance matched.', 'TPD4E05U06 (x2)'],
  ['sim', 'SIM card', '≤ 5 MHz', 3.0, 5.5, 20, 'uni (to GND)', 'Required by most carrier certifications on the SIM socket.', 'multi-line SIM ESD arrays'],
  ['audio', 'Analog audio / microphone', '< 100 kHz', 2, 5, 100, 'bidirectional', 'Signals swing both ways around 0 V: bidirectional part.', 'TPD1E10B06 (bi)'],
  ['rf', 'Antenna / RF feed', 'sub-6 GHz', 1, 3.6, 0.2, 'bidirectional', 'Better still: a DC path to ground (shunt inductor) at the feed.', 'TPD1E0B04, Infineon ESD0P2RF'],
  ['dc12', '12 V DC input', 'DC', 13.8, 15, 100000, 'unidirectional', 'Also sized for surge (IEC 61000-4-5), not only ESD: 400-600 W parts.', 'SMBJ15A, SMAJ15A'],
  ['dc24', '24 V industrial DC input', 'DC', 28.8, 30, 100000, 'unidirectional', '24 V +20 %; surge per IEC 61000-4-5.', 'SMBJ30A, SMCJ33A'],
];
const LEVEL = { 1: 2, 2: 4, 3: 6, 4: 8 };
const f = (v, d = 3) => fmtNum(v, d);
const cap = (c) => (c >= 1000 ? 'not critical' : `≤ ${f(c)} pF`);

export function run({ iface, vline, absmax, level, filter }) {
  const warnings = [];
  const row = IF.find((r) => r[0] === iface) || IF[0];
  const [, name, speed, vl, vrwm0, cmax, pol, note, parts] = row;
  const vmax = vline > 0 ? vline : vl;
  const vrwm = Math.max(vrwm0, vmax);
  const kv = LEVEL[level] || 8;
  const ipk = 3.75 * kv;                 // IEC 61000-4-2 contact, first peak
  const i30 = kv * 2;                    // current at 30 ns: 2 A/kV
  if (vline > 0 && vline > vrwm0) warnings.push(`Your line reaches ${f(vline)} V, above the usual ${f(vrwm0)} V for ${name}: pick VRWM ≥ ${f(vline)} V.`);
  if (absmax > 0) {
    if (absmax <= vrwm) warnings.push(`The pin's ${f(absmax)} V absolute maximum is not above the ${f(vrwm)} V stand-off: no TVS can clamp between them. Add a series resistor (or a protected transceiver) so the pin's own diodes share the current.`);
    else if (absmax - vrwm < 3) warnings.push(`Only ${f(absmax - vrwm, 2)} V between stand-off and the pin's absolute maximum: look for a snap-back (low-clamp) TVS and check its clamping voltage at ${f(i30)} A (TLP), not at the datasheet's 1 A.`);
  }
  const values = [
    { label: 'Line speed', value: speed, hint: name },
    { label: 'Stand-off VRWM', value: `≥ ${f(vrwm)}`, unit: 'V', tone: 'ok', hint: `line up to ${f(vmax)} V` },
    { label: 'Capacitance per line', value: cap(cmax), tone: cmax < 1 ? 'warn' : undefined, hint: 'line to GND' },
    { label: 'Polarity', value: pol },
    { label: `IEC 61000-4-2 level ${LEVEL[level] ? level : 4}`, value: `±${kv} kV`, hint: `contact; first peak ${f(ipk)} A, ${f(i30)} A at 30 ns` },
    { label: 'Clamp at that current', value: absmax > 0 ? `< ${f(absmax)} V` : '< abs. max', hint: 'the protected pin\'s rating' },
  ];
  const q = String(filter || '').trim().toLowerCase();
  const rows = IF.filter((r) => !q || r.slice(1).join(' ').toLowerCase().includes(q))
    .map((r) => [r[0] === row[0] ? `▶ ${r[1]}` : r[1], r[2], `≥\u00a0${f(r[4])}\u00a0V`, cap(r[5]).replace(/ /g, '\u00a0'), r[6], r[8]]);
  if (q && !rows.length) warnings.push(`No interface matches "${filter}". Try a shorter word, e.g. usb, can, eth.`);
  const lvl = LEVEL[level] ? Number(level) : 4;
  const esd = {
    id: row[0], name, speed, vl, vline: vline > 0 ? vline : null, vmax, vrwm0, vrwm, cmax, pol, note, parts,
    absmax: absmax > 0 ? absmax : null, margin: absmax > 0 ? absmax - vrwm : null,
    level: lvl, kv, ipk, i30, i60: kv,
    bidirectional: /bi/.test(pol), rail: /rail/.test(pol),
    levels: Object.entries(LEVEL).map(([l, k]) => ({ level: Number(l), kv: k, ipk: 3.75 * k, i30: 2 * k, i60: k })),
    list: IF.map((r) => ({ id: r[0], vrwm: r[4], cmax: r[5], match: !q || r.slice(1).join(' ').toLowerCase().includes(q) })),
  };
  return {
    values,
    warnings,
    esd,
    tables: [{ title: q ? `Interfaces matching "${filter}"` : 'All interfaces', columns: ['Interface', 'Speed', 'VRWM', 'C per line', 'Polarity', 'Example parts'], rows }],
    notes: [
      `${name}: ${note}`,
      `Example parts: ${parts} - check the current datasheet.`,
      'Place the TVS right at the connector, before anything else, with the shortest possible path to the ground plane; the trace then continues to the IC (flow-through).',
      'Clamping voltage: compare at the TLP / 8 kV current (16 A at 30 ns), not the 1 A figure. A lower dynamic resistance clamps lower.',
      'Capacitance limits are guidance rounded from TI SLVA680 and Nexperia / Semtech interface guides; the part numbers are examples, not endorsements.',
    ],
  };
}
