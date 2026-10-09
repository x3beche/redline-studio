/** The arithmetic of a model's motions (motions.ts), apart from three.js
 *  so it can be tested on its own: 4x4 matrices as 16 numbers in
 *  three.js's order (column-major, `Matrix4.elements`), rotations about
 *  an axis through a pivot, how motions compose, a flexible part's centre
 *  line and the tube drawn along it. */

export type V3 = [number, number, number];
export type M4 = number[];

export const IDENTITY: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: M4, b: M4): M4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

export function apply(m: M4, p: number[]): V3 {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
          m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
          m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}

/** A direction: rotation and scale only. */
export function applyDir(m: M4, d: number[]): V3 {
  return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
          m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
          m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
}

export function invert(m: M4): M4 {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return [...IDENTITY];
  const d = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}

const norm = (v: number[]): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const sub = (a: number[], b: number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: number[], b: number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: number[], s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: number[], b: number[]): V3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Rotation by `deg` (right-handed) about `axis` through `pivot`:
 *  translate the pivot to the origin, rotate, translate back. */
export function rotateAbout(axis: number[], pivot: number[], deg: number): M4 {
  const [x, y, z] = norm(axis);
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  // Rodrigues, column-major.
  const r: M4 = [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
  const rp = applyDir(r, pivot);
  r[12] = pivot[0] - rp[0];
  r[13] = pivot[1] - rp[1];
  r[14] = pivot[2] - rp[2];
  return r;
}

/** One motion as composition needs it: its own rotation (degrees from
 *  its rest pose) and the motion it rides on. */
export interface Joint { axis: number[]; pivot: number[]; on: string | null }

/** Each motion's whole transform in the model's frame: the one it rides
 *  on, then its own. Its axis and pivot are given at the default pose, so
 *  its own rotation goes first and the parent's carries the result:
 *  T(child) = T(parent) * R(child). */
export function compose(joints: Record<string, Joint>, angle: Record<string, number>): Record<string, M4> {
  const out: Record<string, M4> = {};
  const get = (n: string, depth = 0): M4 => {
    if (out[n]) return out[n];
    const j = joints[n];
    if (!j || depth > 32) return [...IDENTITY];
    const own = rotateAbout(j.axis, j.pivot, angle[n] ?? 0);
    const m = j.on && joints[j.on] ? mul(get(j.on, depth + 1), own) : own;
    out[n] = m;
    return m;
  };
  for (const n of Object.keys(joints)) get(n);
  return out;
}

/** A group's local matrix that puts it where `motion` takes it in the
 *  model frame: rest world W0 moved by the motion (conjugated into the
 *  world by the model frame's own placement F), under its parent's world
 *  matrix as it is now (P). local = P^-1 * F * M * F^-1 * W0. */
export function localFor(motion: M4, frame: M4, rest: M4, parentWorld: M4): M4 {
  const world = mul(mul(mul(frame, motion), invert(frame)), rest);
  return mul(invert(parentWorld), world);
}

/** Position, quaternion [x, y, z, w] and scale of a matrix (three.js's
 *  Matrix4.decompose). */
export function decompose(m: M4): { position: V3; quaternion: [number, number, number, number]; scale: V3 } {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2])
            + m[8] * (m[1] * m[6] - m[5] * m[2]);
  if (det < 0) sx = -sx;
  const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx;
  const r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy;
  const r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;
  const tr = r00 + r11 + r22;
  let q: [number, number, number, number];
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q = [(r21 - r12) * s, (r02 - r20) * s, (r10 - r01) * s, 0.25 / s];
  } else if (r00 > r11 && r00 > r22) {
    const s = 2 * Math.sqrt(1 + r00 - r11 - r22);
    q = [0.25 * s, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
  } else if (r11 > r22) {
    const s = 2 * Math.sqrt(1 + r11 - r00 - r22);
    q = [(r01 + r10) / s, 0.25 * s, (r12 + r21) / s, (r02 - r20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + r22 - r00 - r11);
    q = [(r02 + r20) / s, (r12 + r21) / s, 0.25 * s, (r10 - r01) / s];
  }
  return { position: [m[12], m[13], m[14]], quaternion: q, scale: [sx, sy, sz] };
}

// ---------------------------------------------------------------- flexible parts

/** The centre line at `value`, blended point by point between the two
 *  sampled paths around it (clamped at the ends). */
export function samplePath(values: number[], points: number[][][], value: number): V3[] {
  const n = values.length;
  if (!n) return [];
  if (value <= values[0]) return points[0].map(p => [p[0], p[1], p[2]] as V3);
  if (value >= values[n - 1]) return points[n - 1].map(p => [p[0], p[1], p[2]] as V3);
  let i = 0;
  while (i < n - 2 && values[i + 1] < value) i++;
  const f = (value - values[i]) / (values[i + 1] - values[i]);
  const a = points[i], b = points[i + 1];
  return a.map((p, k) => [p[0] + (b[k][0] - p[0]) * f, p[1] + (b[k][1] - p[1]) * f,
                          p[2] + (b[k][2] - p[2]) * f] as V3);
}

function bezier(p0: V3, p1: V3, p2: V3, p3: V3, n: number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    out.push([0, 1, 2].map(k => w[0] * p0[k] + w[1] * p1[k] + w[2] * p2[k] + w[3] * p3[k]) as V3);
  }
  return out;
}

export function pathLength(pts: number[][]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0],
    pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  return s;
}

/** A cable between two ends when no sampled paths are given: a cubic
 *  that leaves `a` along `da` and arrives at `b` along `db` (both the way
 *  the cable runs), its handles as long as it takes for the curve to be
 *  `length` long - it sags or loops rather than stretching. Too short a
 *  cable for the gap is drawn straight. */
export function cablePath(a: V3, da: V3, b: V3, db: V3, length: number, n = 48): V3[] {
  const ua = norm(da), ub = norm(db);
  const at = (h: number) => bezier(a, add(a, scale(ua, h)), sub(b, scale(ub, h)), b, n);
  let lo = 0, hi = Math.max(length, 1);
  if (pathLength(at(lo)) >= length) return at(lo);
  for (let i = 0; i < 40 && pathLength(at(hi)) < length; i++) hi *= 1.6;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (pathLength(at(mid)) < length) lo = mid; else hi = mid;
  }
  return at((lo + hi) / 2);
}

/** A tube of radius `r` along `pts`: rings carried along the line without
 *  twisting (parallel transport), `sides` vertices a ring, capped at both
 *  ends. Positions, normals and triangle indices. */
export function tube(pts: number[][], r: number, sides = 12):
    { position: number[]; normal: number[]; index: number[] } {
  const P: V3[] = [];
  for (const p of pts) {
    const q: V3 = [p[0], p[1], p[2]];
    if (!P.length || Math.hypot(...sub(q, P[P.length - 1])) > 1e-6) P.push(q);
  }
  const position: number[] = [], normal: number[] = [], index: number[] = [];
  if (P.length < 2) return { position, normal, index };
  const T = P.map((_, i) => norm(sub(P[Math.min(i + 1, P.length - 1)], P[Math.max(i - 1, 0)])));
  const t0 = T[0];
  let nrm = norm(cross(t0, Math.abs(t0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  for (let i = 0; i < P.length; i++) {
    if (i) {
      // Carry the last normal over to this tangent.
      const v = cross(T[i - 1], T[i]);
      const s = Math.hypot(...v);
      if (s > 1e-9) {
        const c = dot(T[i - 1], T[i]);
        const k = norm(v), ang = Math.atan2(s, c);
        nrm = applyDir(rotateAbout(k, [0, 0, 0], (ang * 180) / Math.PI), nrm);
      }
      nrm = norm(sub(nrm, scale(T[i], dot(nrm, T[i]))));
    }
    const bin = cross(T[i], nrm);
    for (let j = 0; j < sides; j++) {
      const a = (2 * Math.PI * j) / sides;
      const d = add(scale(nrm, Math.cos(a)), scale(bin, Math.sin(a)));
      position.push(...add(P[i], scale(d, r)));
      normal.push(...d);
    }
  }
  for (let i = 0; i < P.length - 1; i++)
    for (let j = 0; j < sides; j++) {
      const a = i * sides + j, b = i * sides + ((j + 1) % sides);
      const c = a + sides, d = b + sides;
      index.push(a, b, c, b, d, c);
    }
  // End caps: a centre vertex facing out of each end.
  for (const [end, dir] of [[0, scale(T[0], -1)], [P.length - 1, T[P.length - 1]]] as [number, V3][]) {
    const centre = position.length / 3;
    position.push(...P[end]);
    normal.push(...dir);
    const ring = end * sides;
    for (let j = 0; j < sides; j++) {
      const a = ring + j, b = ring + ((j + 1) % sides);
      if (end === 0) index.push(centre, b, a); else index.push(centre, a, b);
    }
  }
  return { position, normal, index };
}

/** A range motion's value while it sweeps back and forth by itself:
 *  `t` seconds in, `period` seconds for low -> high -> low. */
export function sweep(lo: number, hi: number, t: number, period: number): number {
  const f = ((t / period) % 1 + 1) % 1;
  const tri = f < 0.5 ? f * 2 : 2 - f * 2;
  return lo + (hi - lo) * (0.5 - 0.5 * Math.cos(Math.PI * tri));
}
