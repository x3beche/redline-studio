// Minimum draft angle for a wall to release from its mould.
//
// Injection moulding (thermoplastics): a base draft by surface finish, after
// the common SPI-finish guidance (Protolabs / Xometry design guides:
// polished 0.5 deg, matte 1-1.5 deg), plus the Mold-Tech / Standex texture
// rule: 1.5 deg for every 0.001 in (25.4 um) of texture depth. Protolabs'
// depth rule (at least 1 deg per inch of cavity depth) is taken as a floor.
//
// Die casting: NADCA Product Specification Standards, section 4A (draft):
//   D = sqrt(L) / C          (inch)   D = draft distance, L = wall depth
// with C by alloy and wall type (inside wall, outside wall, cored hole; for a
// hole D is the total draft on the diameter, so each side gets D / 2).
//   angle = atan(D / L)      (walls)   atan(D / 2L)   (holes, per side)
//
// Other processes: rules of thumb from the usual design guides.
import { fmtNum } from '../kit/eng.js';

const DEG = Math.PI / 180;
const IN = 25.4;

// NADCA draft constants C (inch formula): inside wall, outside wall, hole (total).
const NADCA = {
  al: { name: 'aluminium', inside: 30, outside: 60, hole: 20 },
  zn: { name: 'zinc', inside: 50, outside: 100, hole: 34 },
  mg: { name: 'magnesium', inside: 35, outside: 70, hole: 24 },
  cu: { name: 'copper (brass)', inside: 25, outside: 50, hole: 17 },
};

// Injection-moulding base draft by finish (degrees per side).
const FINISH = {
  'spi-a': { name: 'SPI A, diamond polish', base: 0.5 },
  'spi-b': { name: 'SPI B, paper polish', base: 0.5 },
  'spi-c': { name: 'SPI C, stone finish', base: 1.0 },
  'spi-d': { name: 'SPI D, bead blast', base: 1.5 },
  texture: { name: 'Texture (etched)', base: 1.0 },
};

// Rules of thumb for the other processes: [min, recommended] degrees per side.
const OTHER = {
  sand: { name: 'Sand casting', min: 1, rec: 2, note: 'Sand casting patterns: 1 deg minimum, 2-3 deg on deep or hand-rammed patterns.' },
  investment: { name: 'Investment casting', min: 0, rec: 0.5, note: 'Investment casting can be made with no draft; 0.5 deg eases wax-pattern release and costs nothing.' },
  silicone: { name: 'Urethane casting in silicone', min: 0, rec: 1, note: 'The silicone mould flexes, so zero draft is possible on shallow walls; 1 deg makes demoulding and mould life better.' },
  'vac-male': { name: 'Vacuum forming, male (plug) mould', min: 3, rec: 5, note: 'The sheet shrinks onto a male mould: 3 deg minimum, 5 deg or more for deep draws.' },
  'vac-female': { name: 'Vacuum forming, female (cavity) mould', min: 1, rec: 2, note: 'The sheet shrinks away from a female mould, so it needs less: 1-2 deg.' },
  compression: { name: 'Rubber / compression moulding', min: 1, rec: 2, note: 'Compression moulded thermosets and rubber: 1-2 deg; soft rubber can strip with less.' },
};

export function run({ process, finish, texture, alloy, wall, depth, draft }) {
  const warnings = [];
  const notes = [];
  if (!(depth > 0)) return { warnings: ['Give the depth of the wall (its height in the pull direction) in mm, e.g. 20.'] };
  let min, rec, basis;

  if (process === 'injection') {
    const f = FINISH[finish] || FINISH['spi-c'];
    let tex = 0;
    if (finish === 'texture') {
      if (!(texture > 0)) warnings.push('Give the texture depth in µm (e.g. 25 for a light texture); without it only the 1 deg base is used.');
      else tex = 1.5 * (texture / IN); // Mold-Tech: 1.5 deg per 0.001 in of texture depth
      if (texture > 150) warnings.push('Texture deeper than 150 µm is unusual: check the draft with the texture supplier.');
    }
    const depthRule = depth / IN; // Protolabs: 1 deg per inch of depth
    min = f.base + tex;
    rec = Math.max(min + 0.5, depthRule);
    basis = `${f.name}: ${f.base}°${tex ? ` + ${fmtNum(tex, 3)}° for ${fmtNum(texture, 3)} µm texture` : ''}; depth rule ${fmtNum(depthRule, 3)}°`;
    notes.push('Faces that must stay parallel (a snap window, a sealing face) can go to 0.25-0.5 deg only on a polished steel tool with good ejection; plan them with the moulder.',
      'The core side (inside walls) grips the part as it shrinks and needs the most draft; outside walls on the cavity side can take less.');
  } else if (process === 'die') {
    const a = NADCA[alloy] || NADCA.al;
    const w = wall === 'outside' || wall === 'hole' ? wall : 'inside';
    const L = depth / IN;
    const D = Math.sqrt(L) / a[w]; // NADCA 4A, inch
    const side = w === 'hole' ? D / 2 : D;
    min = Math.atan(side / L) / DEG;
    rec = min;
    basis = `NADCA: D = √L / ${a[w]} for ${a.name}, ${w === 'hole' ? 'cored hole (total draft)' : `${w} wall`}; D = ${fmtNum(D * IN, 3)} mm at ${fmtNum(depth, 4)} mm deep`;
    notes.push('NADCA draft falls with depth: shallow walls need a steeper angle, deep walls a smaller one (the draft distance grows as the square root of depth).',
      'This is NADCA standard tolerance; "precision" draft (tighter) is possible at extra tooling cost.');
    if (depth < 1) warnings.push('NADCA draft is not meant for walls under about 1 mm deep: the formula gives a very steep angle there.');
  } else {
    const o = OTHER[process] || OTHER.sand;
    min = o.min; rec = o.rec;
    basis = `${o.name}: rule of thumb`;
    notes.push(o.note);
  }

  const offset = (deg) => depth * Math.tan(deg * DEG); // wall moves this much over its depth
  const values = [
    { label: 'Minimum draft', value: fmtNum(min, 3), unit: '° per side', hint: basis },
    { label: 'Recommended draft', value: fmtNum(rec, 3), unit: '° per side', tone: 'ok' },
    { label: 'Wall offset at recommended', value: fmtNum(offset(rec), 3), unit: 'mm', hint: `over ${fmtNum(depth, 4)} mm depth, per side` },
  ];
  if (draft != null && Number.isFinite(draft)) {
    if (draft < 0 || draft >= 45) warnings.push('Your draft should be between 0 and 45 degrees.');
    else {
      const ok = draft >= min - 1e-9;
      values.push(
        { label: 'Your draft', value: fmtNum(draft, 3), unit: '°', tone: ok ? (draft >= rec - 1e-9 ? 'ok' : 'warn') : 'bad',
          hint: ok ? (draft >= rec - 1e-9 ? 'meets the recommendation' : 'above minimum, below recommended') : 'below the minimum: the part may stick or scuff' },
        { label: 'Your wall offset', value: fmtNum(offset(draft), 3), unit: 'mm', hint: 'per side over the depth' },
        { label: 'Width change, both sides', value: fmtNum(2 * offset(draft), 3), unit: 'mm', hint: 'a slot or boss changes this much top to bottom' },
      );
      if (!ok) warnings.push(`${fmtNum(draft, 3)}° is below the ${fmtNum(min, 3)}° minimum: raise the draft, polish the face, or reduce the texture.`);
    }
  }

  const angles = [0.25, 0.5, 1, 1.5, 2, 3, 5];
  const hasDraft = draft != null && Number.isFinite(draft) && draft >= 0 && draft < 45;
  // Everything the page draws, as numbers (degrees per side, mm).
  const draw = {
    process, min, rec, depth, draft: hasDraft ? draft : null,
    offsetMin: offset(min), offsetRec: offset(rec), offsetDraft: hasDraft ? offset(draft) : null, widthDraft: hasDraft ? 2 * offset(draft) : null, widthRec: 2 * offset(rec),
    basis,
    verdict: hasDraft ? (draft >= rec - 1e-9 ? 'ok' : draft >= min - 1e-9 ? 'warn' : 'bad') : null,
    ladder: angles.map((a) => ({ angle: a, offset: offset(a), enough: a >= min - 1e-9 ? (a >= rec - 1e-9 ? 'yes' : 'minimum') : 'no' })),
  };
  return {
    draw,
    values,
    warnings,
    tables: [{
      title: `Wall offset per side over ${fmtNum(depth, 4)} mm depth`,
      columns: ['Draft', 'Offset per side', 'Width change (2 sides)', 'Enough?'],
      rows: angles.map((a) => [`${a}°`, `${fmtNum(offset(a), 3)} mm`, `${fmtNum(2 * offset(a), 3)} mm`, a >= min - 1e-9 ? (a >= rec - 1e-9 ? 'yes' : 'minimum') : 'no']),
    }],
    notes: [...notes, 'Draft is measured per side from the pull direction. Offset = depth × tan(draft).'],
  };
}
