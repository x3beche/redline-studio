// Global fiducials and tooling holes for SMT assembly.
//
// Sizes: IPC-7351B section 3.4 / SMEMA 3.1 - a solid copper dot 1.0-3.0 mm
// across, with a clear area (no copper, mask, silk or parts) of twice the
// dot's radius all round, i.e. a clear-area diameter of at least 3x the dot.
// Placement (rules of thumb every assembler states in some form):
//   - three global fiducials in an L, as far apart as the board allows, so the
//     machine gets X, Y, rotation and scale, and a 180-degree turn is visible;
//   - clear of the ~3 mm band along each edge that the conveyor grips;
//   - tooling holes non-plated, in the corners, with a copper-free ring
//     (here 1 mm) so the pin never touches copper.
// Coordinates: X right, Y up, origin at the bottom-left of the board, or of
// the panel when the marks go on its rails.
import { fmtNum } from '../kit/eng.js';

const CONVEYOR = 3;   // mm the conveyor rails grip along each edge
const HOLE_RING = 1;  // mm copper-free ring around a tooling hole, per side
const n2 = (v) => fmtNum(v, 4);

export function run({ w, h, place, rail, nfid, fd, clear, fe, nhole, hd, he, fine }) {
  const warnings = [];
  if (!(w > 0) || !(h > 0)) return { warnings: ['Give the board width and height in mm, e.g. 80 and 50.'] };
  if (!(fd > 0)) return { warnings: ['Give the fiducial diameter in mm, e.g. 1.'] };
  if (!(clear > 0)) clear = 3 * fd;
  const onRails = place === 'rails';
  const r = onRails ? (rail > 0 ? rail : 5) : 0;
  const W = w, H = h + 2 * r;              // the frame the coordinates are in
  const nF = nfid === '2' ? 2 : 3;
  const nH = nhole === '3' ? 3 : nhole === '0' ? 0 : 2;
  const fEdge = fe > 0 ? fe : 5;
  const hEdge = he > 0 ? he : 4;
  const hDia = hd > 0 ? hd : 3;
  const hKeep = hDia + 2 * HOLE_RING;

  // --- checks on the marks themselves (IPC-7351B / SMEMA 3.1) ---
  if (fd < 1 || fd > 3) warnings.push(`A ${n2(fd)} mm fiducial is outside the 1.0-3.0 mm that IPC-7351B and SMEMA 3.1 allow: use 1.0 mm unless the assembler asks otherwise.`);
  if (clear < 3 * fd - 1e-9) warnings.push(`The clear area (${n2(clear)} mm) is under 3x the fiducial (${n2(3 * fd)} mm): the camera needs one fiducial diameter of empty board all round. Make it at least ${n2(3 * fd)} mm.`);

  // --- where things go, corner by corner ---
  const yLo = onRails ? r / 2 : null, yHi = onRails ? H - r / 2 : null;
  const corner = (c, inset) => {
    const x = c.includes('L') ? inset : W - inset;
    const y = onRails ? (c.includes('B') ? yLo : yHi) : (c.includes('B') ? inset : H - inset);
    return { x, y };
  };
  const holeCorners = nH === 3 ? ['BL', 'BR', 'TL'] : nH === 2 ? ['BL', 'TR'] : [];
  const holes = holeCorners.map((c, i) => ({ ref: `H${i + 1}`, corner: c, ...corner(c, hEdge), d: hDia, keep: hKeep }));
  const fidCorners = nF === 3 ? ['BL', 'BR', 'TL'] : ['BL', 'TR'];
  const fids = fidCorners.map((c, i) => {
    const p = corner(c, fEdge);
    // Slide the fiducial inward along X until its clear area is off every
    // tooling hole's keep-out, in 0.5 mm steps.
    const dir = c.includes('L') ? 1 : -1;
    let moved = 0;
    const hits = () => holes.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < q.keep / 2 + clear / 2 + 0.5);
    while (hits() && moved < W) { p.x += dir * 0.5; moved += 0.5; }
    return { ref: `FID${i + 1}`, corner: c, ...p, d: fd, keep: clear, moved };
  });

  // --- do they fit ---
  const inFrame = (m) => m.x - m.keep / 2 >= -1e-9 && m.x + m.keep / 2 <= W + 1e-9 && m.y - m.keep / 2 >= -1e-9 && m.y + m.keep / 2 <= H + 1e-9;
  for (const m of [...fids, ...holes]) {
    if (!inFrame(m)) warnings.push(`${m.ref} at (${n2(m.x)}, ${n2(m.y)}) mm: its ${n2(m.keep)} mm keep-out runs off the ${onRails ? 'panel' : 'board'}. Move it further in or make it smaller.`);
  }
  const [fa, fb] = [fids[0], fids[fids.length - 1]];
  if (fids.some((f) => f.moved > 0)) {
    const far = fids.filter((f) => (f.corner.includes('L') ? f.x > W / 2 : f.x < W / 2));
    if (far.length) warnings.push(`The ${onRails ? 'rails are' : 'board is'} too short for fiducials and tooling holes side by side: ${far.map((f) => f.ref).join(', ')} ended past the middle. Use fewer or smaller tooling holes, or put the marks on panel rails.`);
  }
  for (let i = 0; i < fids.length; i++) for (let j = i + 1; j < fids.length; j++) {
    if (Math.hypot(fids[i].x - fids[j].x, fids[i].y - fids[j].y) < clear) warnings.push(`${fids[i].ref} and ${fids[j].ref} overlap: the board is too small for separate global fiducials; put them on rails.`);
  }
  if (onRails) {
    if (clear > r + 1e-9) warnings.push(`The ${n2(clear)} mm clear area is wider than the ${n2(r)} mm rail: it runs onto the board or off the edge. Use rails of at least ${n2(Math.max(5, clear + 1))} mm.`);
    if (hKeep > r + 1e-9 && nH) warnings.push(`A ${n2(hDia)} mm tooling hole with its ${HOLE_RING} mm ring (${n2(hKeep)} mm) does not fit a ${n2(r)} mm rail: widen the rail to ${n2(Math.ceil(hKeep + 1))} mm or use a smaller hole.`);
  } else {
    const worst = Math.min(...fids.map((f) => Math.min(f.x, W - f.x, f.y, H - f.y) - f.keep / 2));
    if (worst < CONVEYOR) warnings.push(`A fiducial's clear area comes ${n2(Math.max(0, worst))} mm from the board edge, inside the ~${CONVEYOR} mm the conveyor grips: move it to at least ${n2(CONVEYOR + clear / 2)} mm from the edge, or assemble in a panel with rails.`);
    if (Math.min(w, h) < 2 * (CONVEYOR + clear)) warnings.push(`At ${n2(w)} x ${n2(h)} mm the board is small for handling on its own: most assemblers want it panelized with rails.`);
  }
  if (nF === 2) warnings.push('Two diagonal fiducials cannot tell the board from itself turned 180°: use three, or move one off the diagonal by a few mm.');
  if (!(fine >= 0)) fine = 0;

  const xs = fids.map((f) => f.x), ys = fids.map((f) => f.y);
  const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
  const local = Math.round(fine) * 2;
  const boardY = onRails ? r : 0;

  const values = [
    { label: 'Global fiducials', value: nF, hint: onRails ? 'on the rails' : 'on the board' },
    { label: 'Fiducial span X', value: n2(spanX), unit: 'mm', tone: spanX > W * 0.6 ? 'ok' : 'warn', hint: 'farther apart = better angle accuracy' },
    { label: 'Fiducial span Y', value: n2(spanY), unit: 'mm', tone: nF === 2 || spanY > H * 0.5 ? 'ok' : 'warn' },
    { label: 'Clear area', value: n2(clear), unit: 'mm', tone: clear >= 3 * fd - 1e-9 ? 'ok' : 'bad', hint: `min ${n2(3 * fd)} mm` },
    { label: 'Tooling holes', value: nH, hint: nH ? `${n2(hDia)} mm NPTH, ${n2(hKeep)} mm copper-free` : 'none' },
    { label: 'Local fiducials', value: local, hint: local ? `2 per fine-pitch part x ${Math.round(fine)}` : 'no fine-pitch parts' },
  ];
  const rows = [...fids, ...holes].map((m) => [m.ref, m.ref.startsWith('FID') ? 'fiducial' : 'tooling hole (NPTH)', n2(m.x), n2(m.y), n2(m.d), n2(m.keep)]);
  const lines = [...fids, ...holes].map((m) => `${m.ref}\t${n2(m.x)}\t${n2(m.y)}\t${m.ref.startsWith('FID') ? `fiducial ${n2(m.d)} mm, clear ${n2(m.keep)} mm` : `NPTH ${n2(m.d)} mm, keep-out ${n2(m.keep)} mm`}`);
  return {
    values,
    warnings,
    tables: [{ title: `Marks (origin bottom-left of the ${onRails ? 'panel; board starts at Y = ' + n2(boardY) + ' mm' : 'board'})`,
      columns: ['Ref', 'Kind', 'X mm', 'Y mm', 'Dia mm', 'Keep-out mm'], rows }],
    texts: [{ title: 'Placement list', body: `Ref\tX(mm)\tY(mm)\tWhat\n${lines.join('\n')}\n` }],
    notes: [
      'Fiducial: bare copper dot, mask opening = clear area, no silk or copper inside the clear area. Same finish as the pads.',
      'If the bottom side has SMT parts, it needs its own global fiducials at the same kind of positions.',
      local ? `Local fiducials: two per fine-pitch part (pitch ≤ 0.5 mm, BGA), on the part's diagonal just outside its courtyard, same size and clear area.` : 'No local fiducials needed without fine-pitch parts.',
      'Edge and hole distances here are rules of thumb: the assembler\'s own panel spec wins.',
    ],
    drawing: { W, H, board: { x: 0, y: boardY, w, h }, rails: onRails ? r : 0, fids, holes },
  };
}
