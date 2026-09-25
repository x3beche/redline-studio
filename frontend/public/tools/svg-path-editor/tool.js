// SVG path editor: parse a path's `d`, list its nodes, and write it back
// shorter - fewer decimals, relative or absolute per segment, H/V shorthands,
// no repeated command letters and no needless separators.
//
// Grammar and the arc maths follow the SVG specification:
//   SVG 1.1 section 8.3 (path data grammar, implicit commands after M/m),
//   SVG 1.1 appendix F.6.5 (endpoint -> centre arc conversion) and F.6.6
//   (out-of-range radii are scaled up by sqrt(lambda)).
// Rounding is done on absolute coordinates first and relative offsets are
// taken between the rounded points, so relative output never drifts.
import { fmtNum } from '../kit/eng.js';

const ARGC = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Tokenise and parse `d` into absolute segments {c, a: [...], rel} (c upper case). */
export function parsePath(d) {
  const errors = [];
  const segs = [];
  const src = String(d ?? '');
  let i = 0;
  const n = src.length;
  const skip = () => { while (i < n && /[\s,]/.test(src[i])) i++; };
  const num = () => {
    skip();
    const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = () => { skip(); if (src[i] === '0' || src[i] === '1') return Number(src[i++]); return null; };
  let cx = 0, cy = 0, sx = 0, sy = 0, cmd = null;
  skip();
  while (i < n) {
    skip();
    if (i >= n) break;
    const ch = src[i];
    if (/[MLHVCSQTAZmlhvcsqtaz]/.test(ch)) { cmd = ch; i++; }
    else if (!cmd) { errors.push(`Path must start with M or m, found "${src.slice(i, i + 8)}".`); break; }
    else if (!/[-+.\d]/.test(ch)) { errors.push(`Unexpected "${ch}" at character ${i + 1}; stopped there.`); break; }
    if (!segs.length && cmd.toUpperCase() !== 'M') { errors.push('Path must start with M or m (moveto).'); break; }
    const C = cmd.toUpperCase();
    const rel = cmd !== C;
    if (C === 'Z') { segs.push({ c: 'Z', a: [], rel }); cx = sx; cy = sy; cmd = rel ? 'z' : 'Z'; continue; }
    const args = [];
    for (let k = 0; k < ARGC[C]; k++) {
      const v = C === 'A' && (k === 3 || k === 4) ? flag() : num();
      if (v == null) break;
      args.push(v);
    }
    if (args.length < ARGC[C]) {
      if (args.length) errors.push(`${cmd} at character ${i} needs ${ARGC[C]} numbers, got ${args.length}; the rest was ignored.`);
      else if (i < n && !/[MLHVCSQTAZmlhvcsqtaz]/.test(src[i])) errors.push(`Unexpected "${src[i]}" at character ${i + 1}; stopped there.`);
      if (args.length || (i < n && !/[MLHVCSQTAZmlhvcsqtaz]/.test(src[i]))) break;
      continue;
    }
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    let a;
    switch (C) {
      case 'M': case 'L': case 'T': a = [args[0] + ox, args[1] + oy]; break;
      case 'H': a = [args[0] + ox]; break;
      case 'V': a = [args[0] + oy]; break;
      case 'C': a = [args[0] + ox, args[1] + oy, args[2] + ox, args[3] + oy, args[4] + ox, args[5] + oy]; break;
      case 'S': case 'Q': a = [args[0] + ox, args[1] + oy, args[2] + ox, args[3] + oy]; break;
      case 'A': a = [Math.abs(args[0]), Math.abs(args[1]), args[2], args[3], args[4], args[5] + ox, args[6] + oy]; break;
      default: a = [];
    }
    segs.push({ c: C, a, rel });
    if (C === 'H') cx = a[0];
    else if (C === 'V') cy = a[0];
    else { cx = a[a.length - 2]; cy = a[a.length - 1]; }
    if (C === 'M') { sx = cx; sy = cy; cmd = rel ? 'l' : 'L'; } // SVG 8.3.2: extra pairs after M are lineto
  }
  return { segs, errors };
}

/** Walk segments with the pen position: calls fn(seg, from {x,y}, to {x,y}, prevSeg). */
function walk(segs, fn) {
  let x = 0, y = 0, sx = 0, sy = 0, prev = null;
  segs.forEach((s, idx) => {
    let tx = x, ty = y;
    if (s.c === 'Z') { tx = sx; ty = sy; }
    else if (s.c === 'H') tx = s.a[0];
    else if (s.c === 'V') ty = s.a[0];
    else { tx = s.a[s.a.length - 2]; ty = s.a[s.a.length - 1]; }
    fn(s, { x, y }, { x: tx, y: ty }, prev, idx);
    x = tx; y = ty;
    if (s.c === 'M') { sx = x; sy = y; }
    prev = s;
  });
}

// Arc endpoint -> centre parameterisation, SVG 1.1 appendix F.6.5 / F.6.6.
function arcCentre(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return null;
  const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den));
  if (fa === fs) co = -co;
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI;
  if (fs && dt < 0) dt += 2 * Math.PI;
  return { cx, cy, rx, ry, cos, sin, t1, dt };
}

/** Points along the whole path (for bbox, length and the drawing). */
function sample(segs, per = 24) {
  const pts = [];
  let length = 0;
  walk(segs, (s, p, q, prev) => {
    let f = null;
    if (s.c === 'C' || s.c === 'S') {
      let c1x, c1y;
      if (s.c === 'C') { c1x = s.a[0]; c1y = s.a[1]; } else {
        // S: first control is the reflection of the previous C/S second control (SVG 8.3.6)
        if (prev && (prev.c === 'C' || prev.c === 'S')) { const k = prev.a.length; c1x = 2 * p.x - prev.a[k - 4]; c1y = 2 * p.y - prev.a[k - 3]; } else { c1x = p.x; c1y = p.y; }
      }
      const k = s.a.length, c2x = s.a[k - 4], c2y = s.a[k - 3];
      f = (t) => { const u = 1 - t; return [u * u * u * p.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * q.x, u * u * u * p.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * q.y]; };
    } else if (s.c === 'Q' || s.c === 'T') {
      const [c1x, c1y] = s.c === 'Q' ? s.a : quadCtrl(s, p, prev);
      f = (t) => { const u = 1 - t; return [u * u * p.x + 2 * u * t * c1x + t * t * q.x, u * u * p.y + 2 * u * t * c1y + t * t * q.y]; };
    } else if (s.c === 'A') {
      const e = arcCentre(p.x, p.y, s.a[0], s.a[1], s.a[2], s.a[3], s.a[4], q.x, q.y);
      if (e) f = (t) => { const th = e.t1 + e.dt * t, ex = e.rx * Math.cos(th), ey = e.ry * Math.sin(th); return [e.cos * ex - e.sin * ey + e.cx, e.sin * ex + e.cos * ey + e.cy]; };
    }
    if (s.c === 'M') { pts.push([q.x, q.y]); return; }
    const k = f ? per : 1;
    let lx = p.x, ly = p.y;
    for (let j = 1; j <= k; j++) {
      const [x, y] = f ? f(j / k) : [q.x, q.y];
      length += Math.hypot(x - lx, y - ly); lx = x; ly = y;
      pts.push([x, y]);
    }
  });
  return { pts, length };
}

// T: the control is the reflection of the previous Q/T control (SVG 8.3.7).
// Track it by replaying from the start: cheap enough for editor-size paths.
const tCache = new WeakMap();
function quadCtrl(s, p, prev) {
  if (prev && prev.c === 'Q') return [2 * p.x - prev.a[0], 2 * p.y - prev.a[1]];
  if (prev && prev.c === 'T') { const c = tCache.get(prev); if (c) { const r = [2 * p.x - c[0], 2 * p.y - c[1]]; tCache.set(s, r); return r; } }
  tCache.set(s, [p.x, p.y]);
  return [p.x, p.y];
}
function primeT(segs) {
  walk(segs, (s, p, q, prev) => { if (s.c === 'T') { const c = quadCtrl(s, p, prev); tCache.set(s, c); } });
}

const roundTo = (v, dec) => (dec == null ? v : Math.round(v * 10 ** dec) / 10 ** dec + 0);

/** One number as short as it can be written. */
function fmt(v, dec, compact) {
  let r = roundTo(v, dec);
  if (Object.is(r, -0) || Math.abs(r) < 1e-12) r = 0;
  let t = dec == null ? String(Number(r.toPrecision(12))) : String(Number(r.toFixed(dec)));
  if (/e/.test(t)) t = r.toFixed(Math.min(20, dec ?? 10)).replace(/\.?0+$/, '');
  if (compact) t = t.replace(/^(-?)0\./, '$1.');
  return t;
}

/** Join numbers with as few separators as the grammar allows. */
function joinNums(parts, compact) {
  if (!compact) return parts.join(' ');
  let out = '', prev = '';
  for (const t of parts) {
    if (!out) out = t;
    else if (t[0] === '-') out += t; // a minus sign starts a new number
    else if (t[0] === '.' && prev.includes('.')) out += t; // "1.5.5" reads as 1.5, .5
    else out += ' ' + t;
    prev = t;
  }
  return out;
}

/**
 * Serialise segments. opts: {mode: 'absolute'|'relative'|'shortest', dec, compact, shorthand, tx, ty, scale}.
 * Returns {d, rounded} where rounded are the absolute segments after rounding.
 */
export function serialize(segs, opts = {}) {
  const { mode = 'shortest', dec = 2, compact = true, shorthand = true, tx = 0, ty = 0, scale = 1 } = opts;
  const X = (v) => roundTo(v * scale + tx, dec), Y = (v) => roundTo(v * scale + ty, dec), R = (v) => roundTo(v * Math.abs(scale), dec);
  // 1. transform and round in absolute space
  const rs = segs.map((s) => {
    const a = s.a;
    switch (s.c) {
      case 'H': return { c: 'H', a: [X(a[0])] };
      case 'V': return { c: 'V', a: [Y(a[0])] };
      case 'A': return { c: 'A', a: [R(a[0]), R(a[1]), roundTo(a[2], dec), a[3] ? 1 : 0, a[4] ? 1 : 0, X(a[5]), Y(a[6])] };
      case 'Z': return { c: 'Z', a: [] };
      default: return { c: s.c, a: a.map((v, k) => (k % 2 ? Y(v) : X(v))) };
    }
  });
  // 2. write each segment absolute or relative, with shorthands
  let out = '';
  let prevLetter = '';
  const pieces = []; // what each segment added to the string, for the page's tape
  walk(rs, (s, p, q, prev, idx) => {
    let c = s.c, a = s.a;
    if (shorthand && c === 'L') {
      if (a[1] === p.y && a[0] !== p.x) { c = 'H'; a = [a[0]]; } else if (a[0] === p.x && a[1] !== p.y) { c = 'V'; a = [a[1]]; }
    }
    const relArgs = () => {
      switch (c) {
        case 'H': return [a[0] - p.x];
        case 'V': return [a[0] - p.y];
        case 'A': return [a[0], a[1], a[2], a[3], a[4], a[5] - p.x, a[6] - p.y];
        case 'Z': return [];
        default: return a.map((v, k) => v - (k % 2 ? p.y : p.x));
      }
    };
    const fmtArgs = (args) => args.map((v, k) => (c === 'A' && (k === 3 || k === 4) ? String(v) : fmt(v, dec, compact)));
    const abs = { L: c, t: fmtArgs(a) };
    const rel = { L: c.toLowerCase(), t: fmtArgs(relArgs()) };
    const write = (o) => {
      // A repeated command letter can be dropped; after M the implicit command is L (m -> l).
      const implicit = (prevLetter === o.L && o.L !== 'M' && o.L !== 'm' && o.L !== 'Z' && o.L !== 'z')
        || (prevLetter === 'M' && o.L === 'L') || (prevLetter === 'm' && o.L === 'l');
      const body = c === 'A' && compact ? o.t.join(' ') : joinNums(o.t, compact);
      if (implicit && compact) {
        const sep = body[0] === '-' || (body[0] === '.' && /\.\d*$/.test(out)) ? '' : ' ';
        return sep + body;
      }
      return (out && !compact ? ' ' : '') + o.L + (body ? (compact ? '' : ' ') + body : '');
    };
    let chosen;
    if (idx === 0) chosen = abs; // the first moveto is absolute either way (SVG 8.3.3)
    else if (mode === 'absolute') chosen = abs;
    else if (mode === 'relative') chosen = rel;
    else chosen = write(rel).length < write(abs).length ? rel : abs;
    const piece = write(chosen);
    pieces.push({ seg: idx, text: piece, rel: chosen.L !== chosen.L.toUpperCase(), c: chosen.L });
    out += piece;
    prevLetter = chosen.L === 'M' ? 'M' : chosen.L === 'm' ? 'm' : chosen.L;
    // after an explicit M the next implicit letter is L, so remember M/m specially
  });
  return { d: out, rounded: rs, pieces };
}

/** Nodes for the table and the drawing: endpoints and control points. */
export function nodesOf(segs) {
  const nodes = [];
  primeT(segs);
  walk(segs, (s, p, q, prev, idx) => {
    if (s.c === 'Z') return;
    const k = s.a.length;
    if (s.c === 'C') { nodes.push({ seg: idx, slot: 0, kind: 'ctrl', x: s.a[0], y: s.a[1], ax: p.x, ay: p.y }); nodes.push({ seg: idx, slot: 2, kind: 'ctrl', x: s.a[2], y: s.a[3], ax: q.x, ay: q.y }); }
    if (s.c === 'S') nodes.push({ seg: idx, slot: 0, kind: 'ctrl', x: s.a[0], y: s.a[1], ax: q.x, ay: q.y });
    if (s.c === 'Q') nodes.push({ seg: idx, slot: 0, kind: 'ctrl', x: s.a[0], y: s.a[1], ax: p.x, ay: p.y, bx: q.x, by: q.y });
    const slot = s.c === 'H' || s.c === 'V' ? 0 : k - 2;
    nodes.push({ seg: idx, slot, kind: 'end', x: q.x, y: q.y, c: s.c });
  });
  return nodes;
}

/** Move one node; H keeps its y and V its x (their endpoints are constrained). */
export function moveNode(segs, seg, slot, x, y) {
  const out = segs.map((s) => ({ c: s.c, a: [...s.a] }));
  const s = out[seg];
  if (!s) return out;
  if (s.c === 'H') s.a[0] = x;
  else if (s.c === 'V') s.a[0] = y;
  else { s.a[slot] = x; s.a[slot + 1] = y; }
  return out;
}

/** Each segment on its own as an absolute path (S -> C, T -> Q, H/V/Z -> L), for highlighting. */
function segPaths(segs) {
  const out = [];
  primeT(segs);
  walk(segs, (s, p, q, prev) => {
    const P = (x, y) => `${+x.toFixed(6)} ${+y.toFixed(6)}`;
    let d = `M${P(p.x, p.y)}`;
    if (s.c === 'M') d = `M${P(q.x, q.y)}`;
    else if (s.c === 'C') d += `C${P(s.a[0], s.a[1])} ${P(s.a[2], s.a[3])} ${P(q.x, q.y)}`;
    else if (s.c === 'S') {
      let c1x = p.x, c1y = p.y;
      if (prev && (prev.c === 'C' || prev.c === 'S')) { const k = prev.a.length; c1x = 2 * p.x - prev.a[k - 4]; c1y = 2 * p.y - prev.a[k - 3]; }
      d += `C${P(c1x, c1y)} ${P(s.a[0], s.a[1])} ${P(q.x, q.y)}`;
    } else if (s.c === 'Q') d += `Q${P(s.a[0], s.a[1])} ${P(q.x, q.y)}`;
    else if (s.c === 'T') { const c = tCache.get(s) || [p.x, p.y]; d += `Q${P(c[0], c[1])} ${P(q.x, q.y)}`; }
    else if (s.c === 'A') d += `A${s.a[0]} ${s.a[1]} ${s.a[2]} ${s.a[3]} ${s.a[4]} ${P(q.x, q.y)}`;
    else d += `L${P(q.x, q.y)}`;
    out.push(d);
  });
  return out;
}

const DECS = { keep: null, 0: 0, 1: 1, 2: 2, 3: 3, 4: 4 };

export function run({ d, decimals, mode, compact, shorthand, tx, ty, scale }) {
  const warnings = [];
  const text = String(d ?? '').trim();
  if (!text) return { warnings: ['Paste a path: the value of a <path d="..."> attribute, e.g. M10 10 L90 10 L50 80 Z.'] };
  // Accept a whole <path .../> element or an attribute and take the d value from it.
  const m = /\bd\s*=\s*(["'])([\s\S]*?)\1/.exec(text);
  const { segs, errors } = parsePath(m ? m[2] : text);
  warnings.push(...errors);
  if (!segs.length) return { warnings: warnings.length ? warnings : ['No path commands found.'] };
  const dec = DECS[decimals] === undefined ? 2 : DECS[decimals];
  const sc = scale == null ? 1 : scale;
  if (sc === 0) warnings.push('Scale is 0: every point collapses to one. Use 1 for no scaling.');
  const opts = { mode, dec, compact: !!compact, shorthand: !!shorthand, tx: tx || 0, ty: ty || 0, scale: sc || 1 };
  const { d: outD, rounded, pieces } = serialize(segs, opts);
  const plain = serialize(segs, { ...opts, dec: null, mode: 'absolute', compact: false, shorthand: false });

  primeT(segs); primeT(rounded);
  const { pts, length } = sample(segs);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  // Largest shift rounding caused, in output units, over all nodes.
  const n0 = nodesOf(segs), n1 = nodesOf(rounded);
  let shift = 0;
  n0.forEach((a, k) => { const b = n1[k]; if (b) shift = Math.max(shift, Math.hypot(b.x - (a.x * opts.scale + opts.tx), b.y - (a.y * opts.scale + opts.ty))); });
  const size = Math.max(box.w, box.h) * Math.abs(opts.scale);
  if (size > 0 && shift > size * 0.01) warnings.push(`Rounding moves a node by ${fmtNum(shift, 3)} units, over 1 % of the ${fmtNum(size, 3)}-unit drawing: keep more decimals.`);
  const before = text.length, after = outD.length;
  // The same path at every precision: characters and the largest node shift.
  const n0t = n0.map((a) => [a.x * opts.scale + opts.tx, a.y * opts.scale + opts.ty]);
  const ladder = ['0', '1', '2', '3', '4', 'keep'].map((key) => {
    const dk = DECS[key];
    const r = serialize(segs, { ...opts, dec: dk });
    primeT(r.rounded);
    let sh = 0;
    nodesOf(r.rounded).forEach((b, k) => { const a = n0t[k]; if (a) sh = Math.max(sh, Math.hypot(b.x - a[0], b.y - a[1])); });
    return { decimals: key, chars: r.d.length, shift: Number(sh.toPrecision(4)), over: size > 0 && sh > size * 0.01 };
  });
  const subpaths = segs.filter((s) => s.c === 'M').length;
  const cmdName = { M: 'move', L: 'line', H: 'horizontal', V: 'vertical', C: 'cubic', S: 'smooth cubic', Q: 'quadratic', T: 'smooth quad', A: 'arc', Z: 'close' };
  const rows = [];
  walk(segs, (s, p, q, prev, idx) => {
    const k = s.a.length;
    const ctrl = s.c === 'C' ? `(${fmtNum(s.a[0], 6)}, ${fmtNum(s.a[1], 6)}) (${fmtNum(s.a[2], 6)}, ${fmtNum(s.a[3], 6)})`
      : s.c === 'S' || s.c === 'Q' ? `(${fmtNum(s.a[0], 6)}, ${fmtNum(s.a[1], 6)})`
        : s.c === 'A' ? `r ${fmtNum(s.a[0], 6)}×${fmtNum(s.a[1], 6)}, rot ${fmtNum(s.a[2], 4)}°, large ${s.a[3]}, sweep ${s.a[4]}` : '';
    rows.push([idx, `${s.rel ? s.c.toLowerCase() : s.c} (${cmdName[s.c]})`, fmtNum(q.x, 6), fmtNum(q.y, 6), ctrl || '–']);
    void k;
  });
  const MAXROWS = 400;
  if (rows.length > MAXROWS) warnings.push(`The node table shows the first ${MAXROWS} of ${rows.length} segments.`);
  return {
    values: [
      { label: 'Characters', value: `${before} → ${after}`, hint: `${fmtNum((1 - after / before) * 100, 3)} % shorter`, tone: after <= before ? 'ok' : 'warn' },
      { label: 'Segments', value: segs.length, hint: `${subpaths} subpath${subpaths === 1 ? '' : 's'}` },
      { label: 'Bounding box', value: `${fmtNum(box.x, 5)}, ${fmtNum(box.y, 5)}  ${fmtNum(box.w, 5)} × ${fmtNum(box.h, 5)}`, hint: 'x, y  width × height, before transform' },
      { label: 'Path length', value: fmtNum(length, 5), hint: 'sampled, units of the path' },
      { label: 'Largest rounding shift', value: fmtNum(shift, 3), hint: dec == null ? 'no rounding' : `${dec} decimal${dec === 1 ? '' : 's'}`, tone: size > 0 && shift > size * 0.01 ? 'warn' : 'ok' },
    ],
    texts: [
      { title: 'Path', body: outD, lang: 'svg' },
      { title: 'Element', body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(box.x * opts.scale + opts.tx - 1, dec ?? 3, false)} ${fmt(box.y * opts.scale + opts.ty - 1, dec ?? 3, false)} ${fmt(box.w * Math.abs(opts.scale) + 2, dec ?? 3, false)} ${fmt(box.h * Math.abs(opts.scale) + 2, dec ?? 3, false)}">\n  <path d="${outD}"/>\n</svg>`, lang: 'svg' },
      { title: 'Absolute, full precision', body: plain.d, lang: 'svg' },
    ],
    tables: [{ title: 'Nodes (absolute, before transform)', columns: ['#', 'Command', 'End x', 'End y', 'Controls / arc'], rows: rows.slice(0, MAXROWS) }],
    warnings,
    notes: [
      'Relative offsets are taken between already-rounded points, so rounding error does not add up along the path.',
      'Bounding box and length are sampled from the curves (24 points per curve), not taken from the control points.',
      'Drag a node in the drawing to move it; H keeps its y and V its x. The edited path replaces the input.',
    ],
    // For the drawing and for agents: absolute segments of the input (before translate/scale).
    segments: segs.map((s) => ({ c: s.c, a: s.a })),
    box,
    ladder,
    // Only for the page's drawing (agentOmit): nodes before and after rounding
    // in output units, and what each segment wrote into the output string.
    drawing: {
      nodes: n0.map((a, k) => {
        const b = n1[k] || a;
        const o = { seg: a.seg, slot: a.slot, kind: a.kind, x: a.x, y: a.y,
          ox: a.x * opts.scale + opts.tx, oy: a.y * opts.scale + opts.ty, rx: b.x, ry: b.y };
        if (a.ax != null) { o.ax = a.ax * opts.scale + opts.tx; o.ay = a.ay * opts.scale + opts.ty; }
        if (a.bx != null) { o.bx = a.bx * opts.scale + opts.tx; o.by = a.by * opts.scale + opts.ty; }
        o.shift = Math.hypot(o.rx - o.ox, o.ry - o.oy);
        return o;
      }),
      pieces,
      cmds: segs.map((s) => s.c),
      segD: segPaths(segs),
      outBox: { x: box.x * opts.scale + opts.tx, y: box.y * opts.scale + opts.ty, w: box.w * Math.abs(opts.scale), h: box.h * Math.abs(opts.scale) },
      fullD: plain.d,
      size, shift, before, after, dec,
      transform: { tx: opts.tx, ty: opts.ty, scale: opts.scale },
    },
    options: { mode: opts.mode, dec, compact: opts.compact, shorthand: opts.shorthand },
  };
}
