/// <reference lib="webworker" />
import { BufferGeometry, Float32BufferAttribute, Mesh } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** The slow half of the Files tab's 3D view (mesh-view.ts), off the page's
 *  thread: reading an STL or OBJ, its normals, and the feature edges. A
 *  60 MB STL is a million triangles - parsed on the page, the whole tab
 *  stopped answering for seconds.
 *
 *  `parse` answers with positions, normals and an index: normals creased at
 *  CREASE, so a cylinder is smooth and a box edge stays sharp, and corners
 *  that share a position and a normal welded into one vertex (a sixth of
 *  the memory on the GPU). `edges` answers with line segments where two
 *  triangles meet at more than EDGE, and along open borders. */

const CREASE = Math.PI / 6;
const EDGE = Math.PI / 7;

export type MeshJob =
  | { op: 'parse'; ext: 'stl' | 'obj'; data: ArrayBuffer }
  | { op: 'edges'; id: number; pos: Float32Array; index: Uint32Array | null };

export type MeshReply =
  | { op: 'parse'; pos: Float32Array; nor: Float32Array; index: Uint32Array }
  | { op: 'edges'; id: number; lines: Float32Array }
  | { op: 'error'; message: string };

addEventListener('message', ({ data }: MessageEvent<MeshJob>) => {
  try {
    if (data.op === 'parse') {
      const geo = data.ext === 'stl' ? new STLLoader().parse(data.data) : objGeometry(data.data);
      const flat = geo.index ? geo.toNonIndexed() : geo;
      flat.deleteAttribute('normal');
      const creased = toCreasedNormals(flat, CREASE);
      const out = weld(creased.getAttribute('position').array as Float32Array,
        creased.getAttribute('normal').array as Float32Array);
      postMessage({ op: 'parse', ...out } satisfies MeshReply, [out.pos.buffer, out.nor.buffer, out.index.buffer]);
    } else {
      const lines = edges(data.pos, data.index);
      postMessage({ op: 'edges', id: data.id, lines } satisfies MeshReply, [lines.buffer]);
    }
  } catch (e) {
    postMessage({ op: 'error', message: String((e as Error)?.message ?? e) } satisfies MeshReply);
  }
});

/** Every face of an OBJ as one geometry: its materials are not shown. */
function objGeometry(data: ArrayBuffer): BufferGeometry {
  const group = new OBJLoader().parse(new TextDecoder().decode(data));
  const parts: Float32Array[] = [];
  group.traverse(o => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
    m.updateMatrixWorld();
    g.applyMatrix4(m.matrixWorld);
    parts.push(g.getAttribute('position').array as Float32Array);
  });
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(all, 3));
  return geo;
}

/** An open-addressing table of integer keys, for welding: Map with string
 *  keys is what made three's own mergeVertices take seconds. */
function table(n: number) {
  let size = 1;
  while (size < n * 2) size <<= 1;
  return { slots: new Int32Array(size).fill(-1), mask: size - 1 };
}

function hash(a: number, b: number, c: number, d = 0, e = 0, f = 0): number {
  let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d);
  h ^= Math.imul(d, 0x27d4eb2f) ^ Math.imul(e, 0x165667b1) ^ Math.imul(f, 0x61c88647);
  h ^= h >>> 15;
  return Math.imul(h, 0x2c1b3c6d) ^ (h >>> 13);
}

/** A step for rounding positions: a millionth of the part's size. */
function grid(pos: Float32Array): number {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pos.length; i++) { const v = pos[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  return Math.max(hi - lo, 1e-9) * 1e-6;
}

/** Corners with the same position and normal become one vertex. */
function weld(pos: Float32Array, nor: Float32Array) {
  const n = pos.length / 3, step = grid(pos);
  const { slots, mask } = table(n);
  const keys = new Int32Array(n * 6);
  const outP = new Float32Array(n * 3), outN = new Float32Array(n * 3);
  const index = new Uint32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const k0 = Math.round(pos[3 * i] / step), k1 = Math.round(pos[3 * i + 1] / step), k2 = Math.round(pos[3 * i + 2] / step);
    const k3 = Math.round(nor[3 * i] * 1e4), k4 = Math.round(nor[3 * i + 1] * 1e4), k5 = Math.round(nor[3 * i + 2] * 1e4);
    let h = hash(k0, k1, k2, k3, k4, k5) & mask;
    for (;;) {
      const j = slots[h];
      if (j < 0) {
        slots[h] = count;
        const o = count * 6, c = count * 3;
        keys[o] = k0; keys[o + 1] = k1; keys[o + 2] = k2; keys[o + 3] = k3; keys[o + 4] = k4; keys[o + 5] = k5;
        outP[c] = pos[3 * i]; outP[c + 1] = pos[3 * i + 1]; outP[c + 2] = pos[3 * i + 2];
        outN[c] = nor[3 * i]; outN[c + 1] = nor[3 * i + 1]; outN[c + 2] = nor[3 * i + 2];
        index[i] = count++;
        break;
      }
      const o = j * 6;
      if (keys[o] === k0 && keys[o + 1] === k1 && keys[o + 2] === k2 && keys[o + 3] === k3 && keys[o + 4] === k4
        && keys[o + 5] === k5) { index[i] = j; break; }
      h = (h + 1) & mask;
    }
  }
  return { pos: outP.slice(0, count * 3), nor: outN.slice(0, count * 3), index };
}

/** Feature edges: where the faces on either side turn by more than EDGE,
 *  and where a face has no neighbour. */
function edges(pos: Float32Array, index: Uint32Array | null): Float32Array {
  const corners = index ? index.length : pos.length / 3;
  const corner = (i: number) => (index ? index[i] : i);
  // positions first: a crease splits a vertex in two, and both halves are
  // still the same point of the edge
  const verts = pos.length / 3, step = grid(pos);
  const { slots, mask } = table(verts);
  const keys = new Int32Array(verts * 3);
  const same = new Uint32Array(verts);
  let count = 0;
  for (let v = 0; v < verts; v++) {
    const k0 = Math.round(pos[3 * v] / step), k1 = Math.round(pos[3 * v + 1] / step), k2 = Math.round(pos[3 * v + 2] / step);
    let h = hash(k0, k1, k2) & mask;
    for (;;) {
      const j = slots[h];
      if (j < 0) {
        slots[h] = count; keys[count * 3] = k0; keys[count * 3 + 1] = k1; keys[count * 3 + 2] = k2;
        same[v] = count++;
        break;
      }
      if (keys[j * 3] === k0 && keys[j * 3 + 1] === k1 && keys[j * 3 + 2] === k2) { same[v] = j; break; }
      h = (h + 1) & mask;
    }
  }
  const tris = corners / 3;
  const normals = new Float32Array(tris * 3);
  for (let t = 0; t < tris; t++) {
    const a = corner(3 * t) * 3, b = corner(3 * t + 1) * 3, c = corner(3 * t + 2) * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    normals[3 * t] = nx / l; normals[3 * t + 1] = ny / l; normals[3 * t + 2] = nz / l;
  }
  // each edge once, by its two welded ends: the first face seen, then
  // whether a second one turned away from it
  const e = table(corners);
  const ends = new Int32Array(corners * 2), face = new Int32Array(corners), seen = new Uint8Array(corners);
  const corner0 = new Uint32Array(corners * 2);
  let edgesN = 0;
  const cos = Math.cos(EDGE);
  for (let t = 0; t < tris; t++) {
    for (let s = 0; s < 3; s++) {
      const ca = corner(3 * t + s), cb = corner(3 * t + (s + 1) % 3);
      let p = same[ca], q = same[cb];
      if (p === q) continue;
      if (p > q) [p, q] = [q, p];
      let h = hash(p, q, 0) & e.mask;
      for (;;) {
        const j = e.slots[h];
        if (j < 0) {
          e.slots[h] = edgesN; ends[2 * edgesN] = p; ends[2 * edgesN + 1] = q; face[edgesN] = t;
          corner0[2 * edgesN] = ca; corner0[2 * edgesN + 1] = cb; seen[edgesN] = 1; edgesN++;
          break;
        }
        if (ends[2 * j] === p && ends[2 * j + 1] === q) {
          const f = face[j];
          const d = normals[3 * f] * normals[3 * t] + normals[3 * f + 1] * normals[3 * t + 1] + normals[3 * f + 2] * normals[3 * t + 2];
          // 2: a sharp edge; 3: smooth, drawn no more
          seen[j] = d < cos ? 2 : (seen[j] === 2 ? 2 : 3);
          break;
        }
        h = (h + 1) & e.mask;
      }
    }
  }
  let keep = 0;
  for (let j = 0; j < edgesN; j++) if (seen[j] !== 3) keep++;
  const lines = new Float32Array(keep * 6);
  let o = 0;
  for (let j = 0; j < edgesN; j++) {
    if (seen[j] === 3) continue;
    const a = corner0[2 * j] * 3, b = corner0[2 * j + 1] * 3;
    lines[o++] = pos[a]; lines[o++] = pos[a + 1]; lines[o++] = pos[a + 2];
    lines[o++] = pos[b]; lines[o++] = pos[b + 1]; lines[o++] = pos[b + 2];
  }
  return lines;
}
