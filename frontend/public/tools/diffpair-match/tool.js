// Differential-pair matching reference: impedance and length-match tolerances
// that layout guides give for common interfaces, and a check of measured P/N
// lengths against them.
//
// Tolerances are the usual layout-guide numbers (TI SPRAAR7 "High-Speed
// Interface Layout Guidelines", Intel/NXP/Microchip board design guides, the
// interface specs' impedance targets). They are routing targets, not spec
// limits: the spec budgets skew in ps at the connector; guides turn that into
// mils with margin.
//
// Converting a length into time:  t = L · sqrt(εeff) / c,  c = 0.299792 mm/ps.
//   stripline  εeff = εr;  microstrip εeff (Hammerstad & Jensen, w/h = 2 assumed)
//   = (εr+1)/2 + (εr-1)/2 · (1 + 12 h/w)^-1/2
import { fmtNum } from '../kit/eng.js';

const C_MM_PER_PS = 0.299792458;
const MIL = 0.0254;

// intra / inter in mm; null = no tight requirement (text in *Text).
const IFACES = [
  { id: 'usb2', name: 'USB 2.0 High-Speed (480 Mb/s)', z: '90 Ω ±15 %', intra: 1.27, inter: null, interText: '– (one pair)', rate: 480e6,
    note: 'D+/D-. Keep stubs and test points off the pair; common-mode choke footprint optional.' },
  { id: 'usb3', name: 'USB 3.2 Gen 1 (5 Gb/s)', z: '90 Ω ±10 %', intra: 0.127, inter: null, interText: 'not required (TX and RX independent)', rate: 5e9,
    note: 'AC-coupling caps (100 nF) on TX, placed symmetrically near the connector or the driver.' },
  { id: 'usb32g2', name: 'USB 3.2 Gen 2 (10 Gb/s)', z: '90 Ω ±10 %', intra: 0.127, inter: null, interText: 'not required', rate: 10e9,
    note: 'Minimise vias; backdrill or use blind vias on thick boards.' },
  { id: 'usb4', name: 'USB4 / Thunderbolt (20 Gb/s per lane)', z: '85 Ω ±10 %', intra: 0.1, inter: null, interText: 'not required (lanes deskewed)', rate: 20e9,
    note: 'Follow the retimer vendor guide; glass-weave skew matters at this rate.' },
  { id: 'pcie12', name: 'PCI Express Gen 1/2 (2.5/5 GT/s)', z: '85 Ω ±15 % (100 Ω also used)', intra: 0.127, inter: null, interText: 'no tight rule (receiver deskews lanes)', rate: 5e9,
    note: 'Match P/N segment by segment, compensating near the mismatch (near bends or breakouts).' },
  { id: 'pcie34', name: 'PCI Express Gen 3/4 (8/16 GT/s)', z: '85 Ω ±10 %', intra: 0.127, inter: null, interText: 'no tight rule (receiver deskews lanes)', rate: 16e9,
    note: 'REFCLK pair: 100 Ω, intra-pair 0.127 mm as well.' },
  { id: 'sata', name: 'SATA (1.5–6 Gb/s)', z: '100 Ω ±15 %', intra: 0.127, inter: null, interText: 'not required', rate: 6e9,
    note: 'AC-coupling caps on both TX and RX pairs.' },
  { id: 'eth100', name: 'Ethernet 10/100BASE-TX (MDI)', z: '100 Ω ±10 %', intra: 1.27, inter: null, interText: 'not critical', rate: 125e6,
    note: 'Between PHY and magnetics; keep pairs over solid ground and away from the chassis-isolation gap.' },
  { id: 'eth1000', name: 'Ethernet 1000BASE-T (MDI)', z: '100 Ω ±10 %', intra: 1.27, inter: null, interText: 'not critical (PHY DSP absorbs pair skew)', rate: 125e6,
    note: 'Four pairs; keep them the same length within a few cm anyway.' },
  { id: 'sgmii', name: 'SGMII / SerDes (1.25 Gb/s)', z: '100 Ω ±10 %', intra: 0.127, inter: null, interText: 'not required', rate: 1.25e9,
    note: 'AC-coupled; caps near the receiver.' },
  { id: 'hdmi14', name: 'HDMI 1.4 TMDS (up to 3.4 Gb/s per lane)', z: '100 Ω ±10 %', intra: 0.127, inter: 2.54, interText: '', rate: 3.4e9,
    note: 'Inter-pair: the three data pairs and the clock pair. The spec allows far more; 2.54 mm is the usual guide value.' },
  { id: 'hdmi20', name: 'HDMI 2.0 TMDS (6 Gb/s per lane)', z: '100 Ω ±10 %', intra: 0.127, inter: 2.54, interText: '', rate: 6e9,
    note: 'Use the ESD/redriver vendor guide; keep the ESD part at the connector with no stubs.' },
  { id: 'dp', name: 'DisplayPort main link (HBR2/HBR3)', z: '100 Ω ±10 %', intra: 0.127, inter: 2.54, interText: '', rate: 8.1e9,
    note: 'AUX channel: 100 Ω, loose matching. AC-coupling caps on main link.' },
  { id: 'mipi', name: 'MIPI D-PHY (CSI-2 / DSI, ≤ 2.5 Gb/s)', z: '100 Ω ±10 %', intra: 0.127, inter: 1.27, interText: '', rate: 2.5e9,
    note: 'Inter-pair: each data lane against the clock lane.' },
  { id: 'lvds', name: 'LVDS (display / ADC, ≤ 1 Gb/s)', z: '100 Ω ±10 %', intra: 0.254, inter: 2.54, interText: '', rate: 1e9,
    note: 'Inter-pair: data pairs against the clock pair. 100 Ω termination at the receiver.' },
  { id: 'ddr_ck', name: 'DDR3/DDR4 CK and DQS pairs', z: '80–100 Ω (per controller guide)', intra: 0.127, inter: null, interText: 'per memory-controller guide (DQS to DQ in the byte lane)', rate: 3.2e9,
    note: 'Byte-lane matching is in ps and set by the controller; use Length Matching Budget for it.' },
  { id: 'can', name: 'CAN / CAN FD', z: '120 Ω', intra: null, inter: null, interText: '–', rate: 5e6,
    note: 'Twisted-pair bus; on the board keep CANH/CANL together, a few mm mismatch is harmless. 120 Ω at both ends of the bus.' },
  { id: 'rs485', name: 'RS-485 / RS-422', z: '120 Ω', intra: null, inter: null, interText: '–', rate: 10e6,
    note: 'Keep A/B together; mismatch of several mm is harmless at these rates.' },
];

function effectiveEr(layer, er) {
  if (layer === 'stripline') return er;
  const wh = 2;
  return (er + 1) / 2 + ((er - 1) / 2) * Math.pow(1 + 12 / wh, -0.5);
}

const mmText = (mm) => (mm == null ? 'not critical' : `${fmtNum(mm, 3)} mm (${fmtNum(mm / MIL, 3)} mil)`);

export function run({ iface, filter, layer, er, lenP, lenN }) {
  const warnings = [];
  let epsr = er;
  if (!(epsr >= 1)) { warnings.push('εr must be 1 or more; 4.2 (FR-4) is used.'); epsr = 4.2; }
  const psPerMm = Math.sqrt(effectiveEr(layer, epsr)) / C_MM_PER_PS;
  const f = String(filter || '').trim().toLowerCase();
  let list = iface && iface !== 'all' ? IFACES.filter((x) => x.id === iface) : IFACES;
  if (f) list = list.filter((x) => `${x.name} ${x.z} ${x.note} ${x.id}`.toLowerCase().includes(f));
  if (!list.length) warnings.push(`Nothing matches "${filter}". Clear the filter or pick "All interfaces".`);

  const ps = (mm) => (mm == null ? '–' : `${fmtNum(mm * psPerMm, 3)} ps`);
  const table = {
    title: 'Matching targets',
    columns: ['Interface', 'Differential Z', 'Intra-pair (P/N)', 'Intra-pair time', 'Inter-pair', 'Notes'],
    rows: list.map((x) => [x.name, x.z, mmText(x.intra), ps(x.intra), x.inter == null ? x.interText : `${mmText(x.inter)}, ${ps(x.inter)}`, x.note]),
  };

  const values = [];
  const one = list.length === 1 ? list[0] : null;
  if (one) {
    values.push(
      { label: 'Differential impedance', value: one.z },
      { label: 'Intra-pair tolerance', value: one.intra == null ? 'not critical' : `${fmtNum(one.intra, 3)} mm`, hint: one.intra == null ? '' : `${fmtNum(one.intra / MIL, 3)} mil, ${ps(one.intra)}` },
      { label: 'Inter-pair tolerance', value: one.inter == null ? one.interText.split(' (')[0] : `${fmtNum(one.inter, 3)} mm`, hint: one.inter == null ? (one.interText.match(/\((.*)\)/) || ['', ''])[1] : `${fmtNum(one.inter / MIL, 3)} mil, ${ps(one.inter)}` },
    );
    const hasP = lenP != null && Number.isFinite(lenP), hasN = lenN != null && Number.isFinite(lenN);
    if (hasP && hasN) {
      if (lenP < 0 || lenN < 0) warnings.push('Lengths cannot be negative.');
      else {
        const d = Math.abs(lenP - lenN);
        const ok = one.intra == null || d <= one.intra;
        values.push({ label: 'Your P/N mismatch', value: `${fmtNum(d, 3)} mm`, hint: `${fmtNum(d * psPerMm, 3)} ps`, tone: ok ? 'ok' : 'bad' });
        if (!ok) warnings.push(`P/N mismatch ${fmtNum(d, 3)} mm is over the ${fmtNum(one.intra, 3)} mm target for ${one.name}: add ${fmtNum(d, 3)} mm of small serpentine to the ${lenP < lenN ? 'P' : 'N'} line, close to where the mismatch arises.`);
        const ui = 1e12 / one.rate;
        values.push({ label: 'Mismatch as share of UI', value: `${fmtNum((100 * d * psPerMm) / ui, 3)} %`, hint: `UI ${fmtNum(ui, 4)} ps` });
      }
    } else if (hasP !== hasN) {
      warnings.push('Give both the P and the N length to check the mismatch.');
    }
  } else if (list.length > 1) {
    values.push({ label: 'Interfaces listed', value: String(list.length), hint: 'pick one to check your P/N lengths' });
  }
  values.push({ label: 'Delay used', value: `${fmtNum(psPerMm, 3)} ps/mm`, hint: layer === 'stripline' ? `stripline, εr ${fmtNum(epsr, 3)}` : `microstrip, εr ${fmtNum(epsr, 3)}, w/h 2` });

  return {
    values,
    warnings,
    tables: [table],
    notes: [
      'Tolerances are typical layout-guide targets with margin, not spec limits; when a chip vendor gives its own number, use theirs.',
      'Match P and N where the mismatch arises (at bends and breakouts), not all at the end of the route.',
      'Impedance values are the interface specs\' targets; the stackup sets the trace width and gap for them.',
    ],
  };
}
