import { xTickPlan } from './charts';

/** The x labels of a TimeChart (charts.ts xTickPlan): evenly spaced, never
 *  on top of each other, and never cut off at the ends - on the Proxy
 *  page's narrow latency chart they piled up ("30 13 16…"). */
describe('xTickPlan', () => {
  const CHAR = 6.1;
  const day = (i: number) => ['30 Sept', '1 Oct', '2 Oct', '3 Oct', '4 Oct', '5 Oct', '6 Oct', '7 Oct'][i] ?? `${i} Oct`;
  const hour = (i: number) => `${String(i % 24).padStart(2, '0')}:00`;

  function plan(n: number, w: number, kind: 'bar' | 'line', label: (i: number) => string) {
    const L = 46, R = 8, slot = (w - L - R) / n;
    const at = (i: number) => kind === 'bar' ? L + slot * (i + 0.5) : L + (w - L - R) * (n > 1 ? i / (n - 1) : 0.5);
    return { ticks: xTickPlan(n, w, L, R, at, label), wide: Math.max(label(0).length, label(n - 1).length) * CHAR };
  }

  for (const w of [200, 360, 560, 900]) {
    for (const [n, kind, label] of [[8, 'bar', day], [8, 'line', day], [24, 'line', hour], [30, 'bar', day],
                                    [2, 'line', hour], [3, 'line', day], [1, 'bar', hour]] as const) {
      it(`keeps ${n} ${kind} labels apart and inside ${w} px`, () => {
        const { ticks, wide } = plan(n, w, kind, label);
        expect(ticks.length).toBeGreaterThan(0);
        for (let k = 1; k < ticks.length; k++) {
          expect(ticks[k].x - ticks[k - 1].x).toBeGreaterThanOrEqual(wide);
          // the same stride all the way along
          expect(ticks[k].i - ticks[k - 1].i).toBe(ticks[1].i - ticks[0].i);
        }
        for (const t of ticks) {
          const lo = t.a === 'start' ? t.x : t.a === 'end' ? t.x - wide : t.x - wide / 2;
          expect(lo).toBeGreaterThanOrEqual(0);
          expect(lo + wide).toBeLessThanOrEqual(w);
        }
      });
    }
  }

  it('says nothing before the chart has a width', () => {
    expect(plan(8, 0, 'bar', day).ticks).toEqual([]);
  });
});
