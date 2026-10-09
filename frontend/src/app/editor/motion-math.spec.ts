import {
  IDENTITY, apply, cablePath, compose, decompose, invert, localFor, mul, pathLength,
  rotateAbout, samplePath, sweep, tube,
} from './motion-math';

/** The motions' arithmetic (motion-math.ts): rotation about an axis
 *  through a pivot, a child riding on its parent, the local matrix a
 *  three.js group gets, a cable's centre line and its tube. */
const close = (a: number[], b: number[], tol = 1e-9) => {
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => expect(Math.abs(x - b[i])).toBeLessThan(tol));
};

describe('rotateAbout', () => {
  it('turns right-handed about the axis', () => {
    close(apply(rotateAbout([0, 0, 1], [0, 0, 0], 90), [1, 0, 0]), [0, 1, 0]);
    close(apply(rotateAbout([1, 0, 0], [0, 0, 0], 90), [0, 1, 0]), [0, 0, 1]);
  });
  it('leaves the pivot where it is and turns about it', () => {
    const m = rotateAbout([1, 0, 0], [5, 0, 40], 30);
    close(apply(m, [5, 0, 40]), [5, 0, 40]);
    close(apply(m, [9, 0, 40]), [9, 0, 40]);                 // on the axis
    const p = apply(m, [0, 10, 40]);                           // 10 mm off it
    close([p[0], Math.hypot(p[1], p[2] - 40)], [0, 10]);
    close([Math.atan2(p[2] - 40, p[1]) * 180 / Math.PI], [30]);
  });
  it('is the identity at zero and undoes itself', () => {
    close(rotateAbout([0.3, -1, 2], [1, 2, 3], 0), IDENTITY);
    close(mul(rotateAbout([0.3, -1, 2], [1, 2, 3], 40), rotateAbout([0.3, -1, 2], [1, 2, 3], -40)),
          IDENTITY);
  });
});

describe('compose', () => {
  const joints = {
    tilt: { axis: [1, 0, 0], pivot: [0, 0, 40], on: null },
    fan: { axis: [0, 1, 0], pivot: [0, 0, 40], on: 'tilt' },
  };
  it('carries a child with its parent and keeps it turning about its own, tilted axis', () => {
    const t = compose(joints, { tilt: 90, fan: 0 });
    // The fan's centre stays on the hinge; its axis (y) is now z.
    close(apply(t['fan'], [0, 0, 40]), [0, 0, 40]);
    close(apply(t['fan'], [0, 1, 40]), [0, 0, 41]);
    // Spinning it after the tilt turns points about the tilted axis (z here).
    const s = compose(joints, { tilt: 90, fan: 90 });
    const blade = apply(s['fan'], [10, 0, 40]);            // a blade tip, x at rest
    close([blade[2]], [40]);                                // still in the tilted plane
    close([Math.hypot(blade[0], blade[1])], [10]);
  });
  it('is the parent alone when the child is at rest', () => {
    const t = compose(joints, { tilt: 25, fan: 0 });
    close(t['fan'], t['tilt']);
  });
});

describe('localFor', () => {
  it('puts a group where the motion takes it, under a parent that moved too', () => {
    const rest = [...IDENTITY];
    rest[12] = 3; rest[13] = 4; rest[14] = 5;               // the part's world matrix at rest
    const motion = rotateAbout([0, 0, 1], [0, 0, 0], 90);
    const parent = rotateAbout([1, 0, 0], [0, 0, 0], 30);  // its parent's world now
    const local = localFor(motion, IDENTITY, rest, parent);
    close(mul(parent, local), mul(motion, rest), 1e-9);
  });
  it('conjugates by the model frame', () => {
    const frame = [...IDENTITY];
    frame[12] = 100;                                        // the model sits 100 mm along x
    const motion = rotateAbout([0, 0, 1], [0, 0, 0], 180);
    const rest = [...IDENTITY];
    rest[12] = 101;                                         // 1 mm from the model's origin
    const local = localFor(motion, frame, rest, IDENTITY);
    close([local[12], local[13]], [99, 0]);
  });
  it('decomposes back to the same rigid transform', () => {
    const m = mul(rotateAbout([0.2, 1, -0.5], [1, 2, 3], 73), rotateAbout([1, 0, 0], [0, 5, 0], -20));
    const d = decompose(m);
    const [x, y, z, w] = d.quaternion;
    close([Math.hypot(x, y, z, w)], [1]);
    close(d.scale, [1, 1, 1]);
    // Rebuild from the quaternion and compare.
    const r = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
               2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
               2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
               ...d.position, 1];
    close(r, m, 1e-9);
    close(mul(m, invert(m)), IDENTITY, 1e-9);
  });
});

describe('flexible parts', () => {
  it('blends the sampled centre lines point by point and clamps at the ends', () => {
    const values = [-10, 0, 10];
    const points = [[[0, 0, 0], [0, 0, -10]], [[0, 0, 0], [0, 0, 0]], [[0, 0, 0], [0, 0, 10]]];
    close(samplePath(values, points, 5)[1], [0, 0, 5]);
    close(samplePath(values, points, -2.5)[1], [0, 0, -2.5]);
    close(samplePath(values, points, 99)[1], [0, 0, 10]);
    close(samplePath(values, points, -99)[1], [0, 0, -10]);
  });
  it('keeps a cable at its length between its ends, leaving and arriving along its directions', () => {
    const p = cablePath([0, 0, 0], [0, 1, 0], [0, 20, -30], [0, 0, -1], 60);
    expect(Math.abs(pathLength(p) - 60)).toBeLessThan(0.05);
    close(p[0], [0, 0, 0]);
    close(p[p.length - 1], [0, 20, -30]);
    const lead = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    expect(lead[1]).toBeGreaterThan(0);
    expect(Math.abs(lead[2])).toBeLessThan(lead[1] * 0.2);
    // Too short for the gap: drawn straight, not stretched into a knot.
    const q = cablePath([0, 0, 0], [0, 1, 0], [0, 100, 0], [0, 1, 0], 10);
    expect(Math.abs(pathLength(q) - 100)).toBeLessThan(1e-6);
  });
  it('draws a tube of the radius, its faces outward', () => {
    const line = [[0, 0, 0], [0, 0, 10], [0, 5, 15]];
    const t = tube(line, 2, 8);
    expect(t.position.length).toBe((3 * 8 + 2) * 3);
    // Every ring vertex is the radius from its centre.
    for (let i = 0; i < 8; i++) {
      const p = t.position.slice(i * 3, i * 3 + 3);
      close([Math.hypot(p[0], p[1])], [2], 1e-9);
    }
    // A side triangle's winding agrees with its vertices' normals.
    const [a, b, c] = t.index.slice(0, 3);
    const v = (k: number) => t.position.slice(k * 3, k * 3 + 3);
    const e1 = v(b).map((x, i) => x - v(a)[i]), e2 = v(c).map((x, i) => x - v(a)[i]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const vn = t.normal.slice(a * 3, a * 3 + 3);
    expect(n[0] * vn[0] + n[1] * vn[1] + n[2] * vn[2]).toBeGreaterThan(0);
  });
});

describe('sweep', () => {
  it('goes low -> high -> low over the period', () => {
    close([sweep(-18, 18, 0, 4)], [-18]);
    close([sweep(-18, 18, 2, 4)], [18]);
    close([sweep(-18, 18, 4, 4)], [-18]);
    close([sweep(-18, 18, 1, 4)], [0]);
  });
});
