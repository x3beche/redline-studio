// Antenna length for a frequency: the starting length before tuning, and the
// keep-out a small PCB antenna needs.
//
//   λ0 = c / f                                   free-space wavelength
//   L  = fraction · λ0 · VF                      fraction 1/4 (monopole), 1/2 (dipole)
//   VF (velocity factor):
//     thin wire in air:  k ≈ 0.95 end-effect shortening (ARRL Antenna Book, ch. 2:
//                        a λ/2 dipole is cut to ~0.95 λ/2 for a thick-ish wire)
//     PCB trace, no ground under it: the laminate loads the trace somewhere between
//                        air (VF ≈ 0.95, a thin board) and εeff ≈ (εr + 1) / 2 (the
//                        coplanar limit for a thick substrate, VF = 1/sqrt(εeff)).
//                        A 1.6 mm board lands in between, so the tool gives that range
//                        and a start length at its long end: trimming a trace shorter
//                        is easy, making it longer is not.
//     custom:            your value
// Keep-out and ground-plane sizes are application-note rules of thumb
// (TI AN043 / DN007 small 2.4 GHz PCB antennas, Johanson/Antenova chip-antenna guides).
import { fmtEng, fmtNum } from '../kit/eng.js';

const C = 299792458;

const TYPES = {
  quarter: { frac: 0.25, name: 'Quarter-wave monopole' },
  half: { frac: 0.5, name: 'Half-wave dipole (tip to tip)' },
  fiveeighths: { frac: 0.625, name: '5/8-wave monopole' },
  loop: { frac: 1, name: 'Full-wave loop (perimeter)' },
};

const BANDS = [
  [13.56e6, 'NFC / RFID (13.56 MHz)'], [27.12e6, 'CB / ISM 27 MHz'], [144e6, '2 m amateur'],
  [315e6, 'ISM 315 MHz'], [433.92e6, 'ISM 433 MHz'], [868e6, 'SRD / LoRa 868 MHz'], [915e6, 'ISM / LoRa 915 MHz'],
  [1575.42e6, 'GPS L1'], [2.44e9, 'Wi-Fi / BLE 2.4 GHz'], [5.5e9, 'Wi-Fi 5 GHz'],
];

export function run({ freq, type, medium, er, vf }) {
  const warnings = [];
  if (!(freq > 0)) return { warnings: ['Give the frequency in Hz, e.g. 2.44G or 433.92M.'] };
  const t = TYPES[type] || TYPES.quarter;
  let v, basis, vLow = null;
  if (medium === 'pcb') {
    let e = er;
    if (!(e >= 1)) { warnings.push('εr must be 1 or more; 4.4 (FR-4) is used.'); e = 4.4; }
    const eeff = (e + 1) / 2;
    vLow = 1 / Math.sqrt(eeff);
    v = 0.95;
    basis = `PCB trace with no ground under it: resonance falls between the air value (VF 0.95) and the thick-laminate limit εeff ≈ (εr+1)/2 = ${fmtNum(eeff, 3)} (VF ${fmtNum(vLow, 3)}); the start length is the long end, trimmed down after measuring`;
  } else if (medium === 'custom') {
    if (!(vf > 0 && vf <= 1)) return { warnings: ['Give a velocity factor between 0 and 1, e.g. 0.95 for wire or 0.66 for coax.'] };
    v = vf; basis = `your velocity factor ${fmtNum(v, 3)}`;
  } else {
    v = 0.95; basis = 'thin wire in air, 0.95 end-effect shortening';
  }
  if (freq < 1e6) warnings.push(`At ${fmtEng(freq, 'Hz')} a resonant antenna is ${fmtNum(C / freq / 4, 3)} m or more: use a loaded or loop antenna, this formula is only a reference.`);
  if (freq > 10e9) warnings.push('Above 10 GHz the trace width, connector and laminate dominate: design the antenna with an EM solver.');

  const lambda = C / freq;                        // m
  const len = t.frac * lambda * v;                // m
  const mm = len * 1000;
  const keepout = lambda / 20 * 1000;             // mm: copper keep-out around the radiating part (rule of thumb)
  const ground = 0.25 * lambda * 1000;            // mm: ground-plane length a monopole wants (λ/4 counterpoise)
  const values = [
    { label: 'Free-space wavelength', value: `${fmtNum(lambda * 1000, 4)} mm` },
    { label: vLow ? `${t.name}: start length` : `${t.name} length`, value: `${fmtNum(mm, 4)} mm`, hint: vLow ? 'cut here, then trim down while measuring' : `${fmtNum(mm / 25.4, 3)} in; start here, then tune`, tone: 'ok' },
    ...(vLow ? [{ label: 'Expected resonant length', value: `${fmtNum(t.frac * lambda * vLow * 1000, 3)}–${fmtNum(mm, 3)} mm`, hint: 'thick-laminate limit to air' }] : []),
    { label: 'Without shortening', value: `${fmtNum(t.frac * lambda * 1000, 4)} mm`, hint: `${t.frac} λ0` },
    { label: 'Keep-out around antenna', value: `≥ ${fmtNum(keepout, 3)} mm`, hint: 'λ/20: no copper, parts or screws' },
  ];
  if (type === 'quarter' || type === 'fiveeighths') values.push({ label: 'Ground plane wanted', value: `≥ ${fmtNum(ground, 3)} mm`, hint: 'λ/4 along the board, the monopole\'s other half' });
  if (medium === 'pcb' && freq < 300e6) warnings.push(`A ${fmtNum(mm, 3)} mm PCB trace is long for a board: at ${fmtEng(freq, 'Hz')} use a meander, a helical or chip antenna, or a wire whip.`);

  const rows = BANDS.map(([f, name]) => {
    const l = C / f;
    const len = vLow ? `${fmtNum(t.frac * l * vLow * 1000, 3)}–${fmtNum(t.frac * l * v * 1000, 3)} mm` : `${fmtNum(t.frac * l * v * 1000, 4)} mm`;
    return [name, fmtEng(f, 'Hz'), `${fmtNum(l * 1000, 4)} mm`, len, `${fmtNum(l / 20 * 1000, 3)} mm`];
  });
  // Everything the page draws, as numbers (mm, Hz): the element, its trim
  // range, the keep-out, the ground plane and the same antenna at each band.
  const r4 = (x) => (x == null ? null : Number(x.toPrecision(6)));
  const antenna = {
    freq, type: TYPES[type] ? type : 'quarter', medium: medium === 'pcb' || medium === 'custom' ? medium : 'wire', frac: t.frac, vf: v, vfLow: vLow == null ? null : r4(vLow),
    lambda: r4(lambda * 1000), len: r4(mm), lenLow: vLow ? r4(t.frac * lambda * vLow * 1000) : null, lenFree: r4(t.frac * lambda * 1000),
    keepout: r4(keepout), ground: type === 'quarter' || type === 'fiveeighths' ? r4(ground) : null,
    bands: BANDS.map(([f, name]) => ({ f, name, len: r4(t.frac * (C / f) * v * 1000), lenLow: vLow ? r4(t.frac * (C / f) * vLow * 1000) : null })),
  };
  return {
    values,
    warnings,
    antenna,
    tables: [{ title: `${t.name} at common bands (${medium === 'pcb' ? 'PCB trace' : medium === 'custom' ? 'custom VF' : 'wire'})`,
      columns: ['Band', 'Frequency', 'λ0', 'Length', 'Keep-out λ/20'], rows }],
    notes: [
      `Length basis: ${basis}.`,
      'This is the starting length. Nearby plastic, the ground-plane size and the feed shift resonance by 5–15 %: leave room to trim and a π matching network (0 Ω + 2 DNP) at the feed.',
      'Keep-out: no copper on any layer under or around the radiating part, including ground pour; the λ/20 margin and λ/4 ground plane are application-note rules of thumb. A chip or module antenna\'s datasheet keep-out overrides them.',
      'A PCB inverted-F (IFA) is about a quarter wave from its open end to the shorting point.',
    ],
  };
}
