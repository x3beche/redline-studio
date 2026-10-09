import { fmtStep, parseStep, stepValue } from './clip-wheel';

/** The Clip tab's mouse wheel (clip-wheel.ts): one notch is one step,
 *  never past the slider's ends, at the number box's three decimals. */
describe('stepValue', () => {
  it('moves up and down by the step', () => {
    expect(stepValue(10, 1, 1, -180, 180)).toBe(11);
    expect(stepValue(10, -1, 5, -180, 180)).toBe(5);
  });
  it('stops at the ends', () => {
    expect(stepValue(179.5, 1, 1, -180, 180)).toBe(180);
    expect(stepValue(-179.5, -1, 10, -180, 180)).toBe(-180);
    expect(stepValue(180, 1, 1, -180, 180)).toBe(180);
  });
  it('does not drift in floating point', () => {
    let v = 0;
    for (let i = 0; i < 30; i++) v = stepValue(v, 1, 0.1, -180, 180);
    expect(v).toBe(3);
  });
  it('starts from zero when the box holds no number', () => {
    expect(stepValue(NaN, 1, 0.5, -10, 10)).toBe(0.5);
  });
});

describe('parseStep', () => {
  it('reads a step, with a decimal comma too', () => {
    expect(parseStep('2.5')).toBe(2.5);
    expect(parseStep('2,5')).toBe(2.5);
    expect(parseStep(' 10 ')).toBe(10);
  });
  it('refuses what is not a step', () => {
    expect(parseStep('')).toBeNull();
    expect(parseStep('abc')).toBeNull();
    expect(parseStep('0')).toBeNull();
    expect(parseStep('-1')).toBeNull();
    expect(parseStep(null)).toBeNull();
  });
  it('keeps to the viewer resolution and a sane top', () => {
    expect(parseStep('0.0001')).toBe(0.001);
    expect(parseStep('5000')).toBe(1000);
  });
  it('is written without trailing zeros', () => {
    expect(fmtStep(0.1)).toBe('0.1');
    expect(fmtStep(10)).toBe('10');
  });
});
