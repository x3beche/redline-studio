// Silkscreen legibility: text height and stroke (line) width against a fab's
// legend minimums, and the stroke-to-height ratio that keeps characters open.
//
// Fab minimums are from each fab's published capability page (see `src`);
// they change, so the tool says which it used. The ratio rule:
//   height / stroke between 5 and 8 reads well (JLCPCB recommends 1:6;
//   KiCad's default 1.0 mm / 0.15 mm is 1:6.7). Below 4 the counters of
//   'e', 'a', '8' fill in; above 10 the strokes get thin for their size.
// TrueType fonts have no single stroke; their thinnest stem is estimated as
//   regular ≈ 0.10 × height, bold ≈ 0.15 × height (typical sans-serif stem
//   weights, a rule of thumb).
import { fmtNum } from '../kit/eng.js';

const MIL = 0.0254;
// 0.005 mm grace: fabs quote 6 mil as 0.153 mm, and 0.15 mm strokes print the same.
const TOL = 0.005;
const FABS = {
  jlcpcb: { name: 'JLCPCB', stroke: 0.153, height: 1.0, clear: 0.15, src: 'JLCPCB PCB capabilities page: min. legend line width 0.153 mm, min. text height 1.0 mm, pad-to-silkscreen 0.15 mm' },
  pcbway: { name: 'PCBWay', stroke: 0.15, height: 0.8, clear: 0.15, src: 'PCBWay PCB capabilities page: min. character width 0.15 mm, min. character height 0.8 mm' },
  generic: { name: 'Generic (conservative)', stroke: 0.15, height: 1.0, clear: 0.15, src: 'Conservative values most fabs accept for screen-printed or inkjet legend (rule of thumb)' },
  fine: { name: 'Fine inkjet legend', stroke: 0.1, height: 0.6, clear: 0.1, src: 'Typical high-resolution inkjet legend from fabs that offer it (rule of thumb; ask the fab)' },
  custom: { name: 'Custom', stroke: null, height: null, clear: null, src: 'your values' },
};

const SIZES = [[0.6, 0.1], [0.8, 0.12], [0.8, 0.15], [1.0, 0.15], [1.0, 0.18], [1.27, 0.15], [1.5, 0.2], [2.0, 0.25], [2.0, 0.3]];

export function run({ fab, units, height, stroke, font, minStroke, minHeight, clearance }) {
  const warnings = [];
  const k = units === 'mil' ? MIL : 1;          // input -> mm
  const u = units === 'mil' ? 'mil' : 'mm';
  const out = (mm) => `${fmtNum(mm / k, 3)} ${u}`;
  const F = { ...(FABS[fab] || FABS.jlcpcb) };
  if (fab === 'custom') {
    if (!(minStroke > 0) || !(minHeight > 0)) return { warnings: [`For a custom fab give its minimum legend line width and text height in ${u}.`] };
    F.stroke = minStroke * k; F.height = minHeight * k; F.clear = clearance > 0 ? clearance * k : null;
  }
  if (!(height > 0)) return { warnings: [`Give the text height in ${u}, e.g. ${units === 'mil' ? '40' : '1.0'}.`] };
  const h = height * k;
  let w;
  if (font === 'ttf') w = 0.10 * h;
  else if (font === 'ttfbold') w = 0.15 * h;
  else {
    if (!(stroke > 0)) return { warnings: [`Give the stroke (line) width in ${u}, e.g. ${units === 'mil' ? '6' : '0.15'}.`] };
    w = stroke * k;
  }
  if (h > 10) warnings.push(`${out(h)} is logo-sized; check that ${u} is the unit you meant.`);

  const ratio = h / w;
  const hOk = h >= F.height - TOL;
  const wOk = w >= F.stroke - TOL;
  const rOk = ratio >= 4 && ratio <= 10;
  const good = ratio >= 5 && ratio <= 8;
  // Smallest text this fab prints legibly: its min height, or 5 strokes of its min line, whichever is larger.
  const minLegible = Math.max(F.height, 5 * F.stroke);
  const suggestStroke = Math.max(F.stroke, h / 6);

  if (!hOk) warnings.push(`Text height ${out(h)} is under ${F.name}'s ${out(F.height)} minimum: raise it to at least ${out(F.height)} or move the text to the assembly drawing.`);
  if (!wOk) warnings.push(`${font === 'stroke' ? 'Stroke' : 'Estimated stem'} width ${out(w)} is under ${F.name}'s ${out(F.stroke)} minimum line: the legend may break up or vanish. Use ${out(suggestStroke)}${font === 'stroke' ? '' : ' (a bold or stroke font)'}.`);
  if (ratio < 4) warnings.push(`Height/stroke ${fmtNum(ratio, 3)}:1 is too heavy: 'e', 'a' and '8' fill in. Use a stroke near ${out(h / 6)} or taller text.`);
  if (ratio > 10) warnings.push(`Height/stroke ${fmtNum(ratio, 3)}:1 is very light for its size: a stroke of ${out(suggestStroke)} reads better.`);

  const pass = hOk && wOk && rOk;
  const values = [
    { label: 'Verdict', value: pass ? (good ? 'Legible' : 'Passes, ratio not ideal') : 'Below minimum', tone: pass ? (good ? 'ok' : 'warn') : 'bad' },
    { label: 'Text height', value: out(h), hint: `min ${out(F.height)} at ${F.name}`, tone: hOk ? 'ok' : 'bad' },
    { label: font === 'stroke' ? 'Stroke width' : 'Stem width (estimated)', value: out(w), hint: `min ${out(F.stroke)}`, tone: wOk ? 'ok' : 'bad' },
    { label: 'Height : stroke', value: `${fmtNum(ratio, 3)} : 1`, hint: 'aim for 5–8 : 1', tone: good ? 'ok' : rOk ? 'warn' : 'bad' },
    { label: 'Smallest legible text here', value: out(minLegible), hint: `with ${out(F.stroke)} stroke` },
    { label: 'Suggested stroke for this height', value: out(suggestStroke) },
  ];
  if (F.clear) values.push({ label: 'Keep legend off pads by', value: `≥ ${out(F.clear)}`, hint: 'fab clips legend on copper' });

  const rows = SIZES.map(([sh, sw]) => {
    const r = sh / sw;
    const ok = sh >= F.height - TOL && sw >= F.stroke - TOL && r >= 4 && r <= 10;
    return [out(sh), out(sw), `${fmtNum(r, 3)} : 1`, ok ? 'yes' : 'no'];
  });
  // The same numbers in mm, for the page's drawing (and agents that want numbers, not text).
  const legend = {
    h, w, ratio, pass, good, hOk, wOk, rOk, font: font === 'ttf' || font === 'ttfbold' ? font : 'stroke',
    fab: { id: fab in FABS ? fab : 'jlcpcb', name: F.name, stroke: F.stroke, height: F.height, clear: F.clear },
    minLegible, suggestStroke,
    sizes: SIZES.map(([sh, sw]) => ({ h: sh, w: sw, ok: sh >= F.height - TOL && sw >= F.stroke - TOL && sh / sw >= 4 && sh / sw <= 10 })),
  };
  return {
    values,
    warnings,
    legend,
    tables: [{ title: `Common sizes at ${F.name}`, columns: ['Height', 'Stroke', 'Ratio', 'Prints legibly?'], rows }],
    notes: [
      `Fab limits: ${F.src}. Fabs update these pages; check the current one before ordering. Values within 0.005 mm of a limit count as meeting it (6 mil = 0.1524 mm rounding).`,
      'Ratio rule: height/stroke 5–8 reads well; JLCPCB recommends 1:6 and KiCad\'s default (1.0 mm / 0.15 mm) is 1:6.7.',
      font === 'stroke' ? 'Stroke font: the stroke width is the line width you set.' : 'TrueType: stem width estimated as 0.10 × height (regular) or 0.15 × height (bold).',
      'Text wider than about 0.8 × its height keeps characters distinct; very narrow text blurs first.',
    ],
  };
}
