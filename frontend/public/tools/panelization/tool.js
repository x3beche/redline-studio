// Boards in a panel: a plain rectangular grid (what V-scoring needs), tried in
// both orientations.
//
//   usable width   = panel W - left rail - right rail
//   columns        = floor((usable width + gap) / (board w + gap))
//   array width    = columns * board w + (columns - 1) * gap + rails
//   utilisation    = boards * board area / panel area; waste = 1 - utilisation
// Default gaps (rule of thumb, most fabs' capability pages): V-score 0 mm
// (boards touch, the score line is shared); tab-routed with mouse bites 2 mm
// (a 2.0 mm router bit; 1.6-2.4 mm is common).
import { fmtNum } from '../kit/eng.js';

const METHODS = {
  vscore: { name: 'V-score', gap: 0 },
  tabs: { name: 'Tab-routed, mouse bites', gap: 2 },
};

function fit(pw, ph, bw, bh, gap, rx, ry) {
  const uw = pw - 2 * rx, uh = ph - 2 * ry;
  const cols = uw >= bw ? Math.floor((uw + gap + 1e-9) / (bw + gap)) : 0;
  const rows = uh >= bh ? Math.floor((uh + gap + 1e-9) / (bh + gap)) : 0;
  return { cols, rows, n: cols * rows, bw, bh,
    aw: cols ? cols * bw + (cols - 1) * gap + 2 * rx : 0,
    ah: rows ? rows * bh + (rows - 1) * gap + 2 * ry : 0 };
}

export function run({ bw, bh, pw, ph, method, gap, rails, rail, qty }) {
  const warnings = [];
  if (!(bw > 0 && bh > 0)) return { warnings: ['Give the board width and height in mm, e.g. 50 × 30.'] };
  if (!(pw > 0 && ph > 0)) return { warnings: ['Give the panel width and height in mm, e.g. 100 × 100 for a small delivery panel or 457 × 610 (18 × 24 in) for a production panel.'] };
  const m = METHODS[method] || METHODS.vscore;
  const g = gap >= 0 && gap !== null ? gap : m.gap;
  const r = rail >= 0 && rail !== null ? rail : 5;
  const rx = rails === 'four' ? r : 0;
  const ry = rails === 'none' ? 0 : r;
  if (method === 'vscore' && g > 0) warnings.push(`V-scored boards normally touch (gap 0): a ${fmtNum(g, 3)} mm gap needs routing as well.`);
  if (method === 'tabs' && g < 1.6) warnings.push(`A ${fmtNum(g, 3)} mm routing gap is below the usual 1.6-2.4 mm router bit: ask the fab, or use 2 mm.`);
  if (method === 'vscore' && Math.min(bw, bh) < 10) warnings.push('Boards under about 10 mm are hard to snap along a V-score cleanly: consider tab routing.');

  const a = fit(pw, ph, bw, bh, g, rx, ry);
  const b = fit(pw, ph, bh, bw, g, rx, ry); // rotated 90°
  const best = b.n > a.n ? { ...b, rot: true } : { ...a, rot: false };
  const boardArea = bw * bh, panelArea = pw * ph;
  if (!best.n) {
    return { warnings: [...warnings, `A ${fmtNum(bw, 4)} × ${fmtNum(bh, 4)} mm board does not fit a ${fmtNum(pw, 4)} × ${fmtNum(ph, 4)} mm panel with ${fmtNum(r, 3)} mm rails: use a bigger panel or narrower rails.`],
      values: [{ label: 'Boards per panel', value: 0, tone: 'bad' }], layout: { pw, ph, rx, ry, gap: g, cols: 0, rows: 0, bw, bh, method } };
  }
  const util = (best.n * boardArea) / panelArea;
  const arrUtil = (best.n * boardArea) / (best.aw * best.ah);
  if (util < 0.6) warnings.push(`Only ${fmtNum(util * 100, 3)} % of the panel is boards: try the other orientation, a panel size closer to a multiple of the board, or thinner rails.`);
  const values = [
    { label: 'Boards per panel', value: best.n, tone: 'ok', hint: `${best.cols} columns × ${best.rows} rows${best.rot ? ', rotated 90°' : ''}` },
    { label: 'Panel used by boards', value: fmtNum(util * 100, 3), unit: '%', tone: util >= 0.75 ? 'ok' : util >= 0.6 ? 'warn' : 'bad' },
    { label: 'Waste', value: fmtNum((1 - util) * 100, 3), unit: '%', hint: `${fmtNum((panelArea - best.n * boardArea) / 100, 4)} cm²` },
    { label: 'Array outline (rails included)', value: `${fmtNum(best.aw, 4)} × ${fmtNum(best.ah, 4)} mm`, hint: `boards fill ${fmtNum(arrUtil * 100, 3)} % of it` },
    { label: 'Gap between boards', value: fmtNum(g, 3), unit: 'mm', hint: m.name },
  ];
  // result.plan: the same figures as plain numbers for the page (and agents), with
  // what the leftover strips are and how much more panel the next column or row needs.
  const other = best.rot ? a : b;
  const plan = {
    n: best.n, cols: best.cols, rows: best.rows, rot: best.rot, bw: best.bw, bh: best.bh, gap: g, rx, ry,
    util, waste: 1 - util, wasteArea: panelArea - best.n * boardArea, aw: best.aw, ah: best.ah, arrUtil,
    restW: pw - best.aw, restH: ph - best.ah,
    moreCol: (best.cols + 1) * best.bw + best.cols * g + 2 * rx - pw,
    moreRow: (best.rows + 1) * best.bh + best.rows * g + 2 * ry - ph,
    alt: { cols: other.cols, rows: other.rows, n: other.n, bw: other.bw, bh: other.bh, util: (other.n * boardArea) / panelArea, aw: other.aw, ah: other.ah },
    qty: qty > 0 ? qty : null, panels: null, spare: null,
  };
  if (qty > 0) {
    const panels = Math.ceil(qty / best.n);
    plan.panels = panels; plan.spare = panels * best.n - qty;
    values.push({ label: `Panels for ${fmtNum(qty, 6)} boards`, value: panels, hint: `${panels * best.n - qty} spare boards` });
  }
  const rows = [
    ['As drawn', a.cols, a.rows, a.n, a.n ? fmtNum((a.n * boardArea * 100) / panelArea, 3) : '0', a.n ? `${fmtNum(a.aw, 4)} × ${fmtNum(a.ah, 4)}` : '–'],
    ['Rotated 90°', b.cols, b.rows, b.n, b.n ? fmtNum((b.n * boardArea * 100) / panelArea, 3) : '0', b.n ? `${fmtNum(b.aw, 4)} × ${fmtNum(b.ah, 4)}` : '–'],
  ];
  const notes = [
    `Rails: ${rails === 'four' ? 'on all four sides' : rails === 'none' ? 'none' : 'top and bottom (the conveyor edges)'}, ${fmtNum(r, 3)} mm wide. Assembly lines usually want 5 mm rails with tooling holes and fiducials.`,
    'V-scoring cuts straight across the whole panel, so every board edge on a score line must be straight and no copper or parts within ~0.5 mm of it.',
    'Mouse bites: 5 holes of 0.5 mm at 0.75-0.8 mm pitch per tab, tabs every 50-75 mm along an edge; keep parts 2-3 mm from tabs.',
    'Only a regular grid of identical boards is counted; mixed or nested outlines need a CAM tool.',
  ];
  return {
    values,
    warnings,
    tables: [{ title: 'Both orientations', columns: ['Orientation', 'Columns', 'Rows', 'Boards', 'Used %', 'Array mm'], rows }],
    layout: { pw, ph, rx, ry, gap: g, cols: best.cols, rows: best.rows, bw: best.bw, bh: best.bh, method: method in METHODS ? method : 'vscore' },
    plan,
    notes,
  };
}
