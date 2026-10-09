import { DEFAULT_NORMALS, flipped, isReversed } from './clip-reverse';

/** The Clip tab's reverse switch (clip-reverse.ts): a plane turned round
 *  faces the other way, and the switch knows which way a plane faces. */
describe('flipped', () => {
  it('negates each default normal without a -0', () => {
    expect(flipped(DEFAULT_NORMALS[0])).toEqual([1, 0, 0]);
    expect(flipped(DEFAULT_NORMALS[1])).toEqual([0, 1, 0]);
    expect(flipped(DEFAULT_NORMALS[2])).toEqual([0, 0, 1]);
    expect(Object.is(flipped([-1, 0, 0])[1], 0)).toBeTrue();
  });
  it('turns back to where it started', () => {
    expect(flipped(flipped([0.6, -0.8, 0]))).toEqual([0.6, -0.8, 0]);
  });
});

describe('isReversed', () => {
  it('is off on the viewer defaults, on when they are negated', () => {
    for (let i = 0; i < 3; i++) {
      expect(isReversed(i, DEFAULT_NORMALS[i])).toBeFalse();
      expect(isReversed(i, flipped(DEFAULT_NORMALS[i]))).toBeTrue();
    }
  });
  it('judges a camera-set normal by the half it points into', () => {
    expect(isReversed(0, [0.7, 0.7, 0])).toBeTrue();
    expect(isReversed(0, [-0.2, 0.9, 0.4])).toBeFalse();
    expect(isReversed(0, [0, 1, 0])).toBeFalse();
  });
  it('is off when there is no normal', () => {
    expect(isReversed(0, null)).toBeFalse();
    expect(isReversed(5, [1, 0, 0])).toBeFalse();
  });
});
