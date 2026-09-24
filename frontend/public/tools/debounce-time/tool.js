// Firmware debounce sizing.
//   window = worst-case bounce × margin
//   N      = ceil(window / Ts), at least 2    (N equal samples in a row accept a change)
//   debounce time = N · Ts
//   worst-case response from the first contact = bounce + N · Ts (the last bounce, then N stable samples)
//   a glitch is always rejected if shorter than (N - 1) · Ts
// RC + Schmitt alternative (Ganssle, 'A Guide to Debouncing'): the cap discharges through R
// from Vdd to the Schmitt low threshold: R = -t / (C ln(Vth / Vdd)), Vth ≈ Vdd / 3 assumed.
import { fmtEng, fmtNum, standard, E12 } from '../kit/eng.js';

// Typical and worst-case bounce in seconds. Rule of thumb from datasheets and Ganssle's measurements.
const SWITCHES = {
  tact: { name: 'Tactile switch', typ: 1e-3, max: 5e-3, src: 'Omron B3F: 5 ms max' },
  panel: { name: 'Panel pushbutton', typ: 3e-3, max: 10e-3, src: 'rule of thumb' },
  toggle: { name: 'Toggle switch', typ: 2e-3, max: 20e-3, src: 'Ganssle measured some toggles over 10 ms' },
  slide: { name: 'Slide switch', typ: 2e-3, max: 10e-3, src: 'rule of thumb' },
  micro: { name: 'Snap-action microswitch', typ: 0.5e-3, max: 5e-3, src: 'rule of thumb' },
  encoder: { name: 'Mechanical rotary encoder', typ: 1e-3, max: 5e-3, src: 'Alps EC11-class chattering, a few ms' },
  membrane: { name: 'Membrane keypad', typ: 5e-3, max: 10e-3, src: 'rule of thumb' },
  reed: { name: 'Reed switch', typ: 0.3e-3, max: 1e-3, src: 'typical reed datasheets, < 1 ms' },
  relay: { name: 'Relay contact', typ: 2e-3, max: 10e-3, src: 'typical signal/power relay datasheets' },
};

export function run({ type, bounce, ts, margin, vdd }) {
  const warnings = [];
  let sw = SWITCHES[type];
  if (type === 'custom') {
    if (!(bounce > 0)) return { warnings: ['Give the worst-case bounce in seconds, e.g. 5m.'] };
    sw = { name: 'Custom switch', typ: bounce / 2, max: bounce, src: 'your figure' };
  }
  if (!sw) sw = SWITCHES.tact;
  if (!(ts > 0)) return { warnings: ['Give the sampling period in seconds, e.g. 1m.'] };
  let m = margin;
  if (!(margin >= 1)) { m = 1.5; warnings.push('The margin must be at least 1 (×): 1.5 used.'); }
  const win = sw.max * m;
  const nRaw = Math.ceil(win / ts - 1e-9);
  const N = Math.max(2, nRaw);
  const tDeb = N * ts;
  const resp = sw.max + tDeb;
  const glitch = (N - 1) * ts;
  if (nRaw < 2) warnings.push(`Sampling every ${fmtEng(ts, 's')} is slower than the ${fmtEng(win, 's')} window: 2 equal samples are still required so a single noisy read cannot change the state.`);
  if (resp > 50e-3) warnings.push(`A press is seen up to ${fmtEng(resp, 's')} after the contact closes: over about 50 ms users feel the lag. Sample faster or use a smaller margin.`);
  if (tDeb > 30e-3) warnings.push(`A ${fmtEng(tDeb, 's')} stable window can miss very quick taps (about 30–50 ms): shorten it if the button is tapped fast.`);
  if (N > 32) warnings.push(`${N} samples do not fit a 32-bit shift register: use a counter, or sample slower (a ${fmtEng(win / 8, 's')} period gives 8).`);
  if (ts < 50e-6) warnings.push(`Sampling every ${fmtEng(ts, 's')} spends a lot of CPU on a button: 1 … 5 ms is plenty.`);
  const regBits = N <= 8 ? 8 : N <= 16 ? 16 : N <= 32 ? 32 : null;

  // RC alternative with 100 nF, Schmitt low threshold at Vdd/3.
  const C = 100e-9;
  const rc = win / (C * Math.log(3));
  const rStd = standard(rc, E12, 'up');
  const vOk = vdd > 0;

  const values = [
    { label: 'Worst-case bounce', value: fmtEng(sw.max, 's'), hint: `${sw.name}; typical ${fmtEng(sw.typ, 's')}` },
    { label: 'Stable window wanted', value: fmtEng(win, 's'), hint: `bounce × ${fmtNum(m, 3)}` },
    { label: 'Samples in a row N', value: String(N), tone: 'ok', hint: `at ${fmtEng(ts, 's')}` },
    { label: 'Debounce time', value: fmtEng(tDeb, 's'), hint: 'N × sampling period' },
    { label: 'Worst-case response', value: fmtEng(resp, 's'), tone: resp <= 50e-3 ? 'ok' : 'warn', hint: 'from first contact' },
    { label: 'Glitch always rejected below', value: fmtEng(glitch, 's') },
    { label: 'Shift register', value: regBits ? `uint${regBits}_t` : 'counter', hint: regBits ? `${N} of ${regBits} bits used` : 'N > 32' },
    { label: 'RC + Schmitt option', value: rStd ? `${fmtEng(rStd, 'Ω')} + 100 nF` : '–', hint: vOk ? `τ·ln3 ≥ ${fmtEng(win, 's')}, Vth- ≈ ${fmtNum(vdd / 3, 3)} V` : 'Vth- ≈ Vdd/3' },
  ];
  const rows = Object.entries(SWITCHES).map(([k, s]) => {
    const n = Math.max(2, Math.ceil((s.max * m) / ts - 1e-9));
    return [s.name + (k === type ? '  ←' : ''), fmtEng(s.typ, 's'), fmtEng(s.max, 's'), String(n), fmtEng(n * ts, 's'), fmtEng(s.max + n * ts, 's'), s.src];
  });
  const mask = N >= 32 ? '0xFFFFFFFFu' : `0x${(2 ** N - 1).toString(16).toUpperCase()}u`;
  const code = [
    `// Debounce: ${N} equal samples at ${fmtEng(ts, 's')} = ${fmtEng(tDeb, 's')} (${sw.name}, bounce ≤ ${fmtEng(sw.max, 's')} × ${fmtNum(m, 3)})`,
    `#define DEB_N  ${N}`,
    '',
    '// Counter form: call every sampling period with the raw pin level.',
    `static uint8_t deb_state;`,
    `static ${N > 255 ? 'uint16_t' : 'uint8_t'} deb_count;`,
    'uint8_t debounce(uint8_t raw)',
    '{',
    '    if (raw == deb_state) { deb_count = 0; return deb_state; }',
    '    if (++deb_count >= DEB_N) { deb_state = raw; deb_count = 0; }',
    '    return deb_state;',
    '}',
    ...(regBits ? ['',
      `// Shift-register form: ${N} samples in a uint${regBits}_t.`,
      `static uint${regBits}_t deb_hist;`,
      `#define DEB_MASK ${mask}`,
      'uint8_t debounce_sr(uint8_t raw, uint8_t prev)',
      '{',
      `    deb_hist = (uint${regBits}_t)((deb_hist << 1) | (raw & 1u));`,
      '    if ((deb_hist & DEB_MASK) == DEB_MASK) return 1;',
      '    if ((deb_hist & DEB_MASK) == 0) return 0;',
      '    return prev;   /* still bouncing: keep the last state */',
      '}'] : []),
  ].join('\n');
  return {
    values,
    warnings,
    tables: [{ title: 'Every switch type at this sampling period and margin',
      columns: ['Switch', 'Typical bounce', 'Worst bounce', 'N', 'Debounce', 'Response', 'Basis'], rows }],
    texts: [{ title: 'C code', body: code, lang: 'c' }],
    notes: [
      'A change is accepted after N consecutive equal reads; any differing read restarts the count.',
      'Bounce grows as contacts wear and in the cold; the margin covers that. Break (release) bounce is usually shorter than make bounce but is debounced the same way here.',
      'Do not debounce from a pin-change interrupt alone: bounce fires it many times. Sample from a timer, or use the interrupt only to wake up and start sampling.',
      'The RC option needs a Schmitt-trigger input; the cap discharges through R to about Vdd/3.',
    ],
  };
}
