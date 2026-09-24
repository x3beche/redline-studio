import { Component, computed, input } from '@angular/core';

/** Small charts for a tab 300 px wide: bars, a trend line, columns.
 *
 *  Each is one measure in the room's one accent colour - a magnitude or a
 *  change over time, never identity - so nothing here asks the eye to
 *  tell two hues apart; what a mark is, its label says. Labels and values
 *  wear the text colours, never the mark's. Every mark carries its exact
 *  figure on hover, and the hover target is the whole row or column, not
 *  the few pixels of the mark.
 */

export interface MiniRow { label: string; value: number; tip?: string }

/** Horizontal bars, largest first: how much of each. */
@Component({
  selector: 'app-mini-bars',
  template: `
@for (r of rows(); track r.label) {
  <div class="tcv-mbar" [title]="r.tip ?? (r.label + ': ' + fmt()(r.value))">
    <span class="tcv-mbar-label">{{ r.label }}</span>
    <span class="tcv-mbar-track">
      <span class="tcv-mbar-fill" [style.width.%]="pct(r.value)"></span>
    </span>
    <span class="tcv-mbar-value mono">{{ fmt()(r.value) }}</span>
  </div>
} @empty {
  <div class="tcv-mchart-empty">{{ empty() }}</div>
}`,
})
export class MiniBars {
  rows = input.required<MiniRow[]>();
  fmt = input<(v: number) => string>(v => String(v));
  empty = input('nothing yet');
  private max = computed(() => Math.max(1, ...this.rows().map(r => r.value)));
  /** Never a zero-width sliver for a real value: a bar that exists shows. */
  pct(v: number): number { return v > 0 ? Math.max(2, 100 * v / this.max()) : 0; }
}

/** Columns over ordered bins: how the values spread. */
@Component({
  selector: 'app-mini-columns',
  template: `
<div class="tcv-mcols">
  @for (r of rows(); track r.label) {
    <div class="tcv-mcol" [title]="r.tip ?? (r.label + ': ' + r.value)">
      <span class="tcv-mcol-value mono">{{ r.value }}</span>
      <span class="tcv-mcol-well">
        <span class="tcv-mcol-fill" [style.height.%]="pct(r.value)"></span>
      </span>
      <span class="tcv-mcol-label mono">{{ r.label }}</span>
    </div>
  }
</div>`,
})
export class MiniColumns {
  rows = input.required<MiniRow[]>();
  private max = computed(() => Math.max(1, ...this.rows().map(r => r.value)));
  pct(v: number): number { return v > 0 ? Math.max(3, 100 * v / this.max()) : 0; }
}

/** One measure over time, as a line with its latest value and how far it
 *  has moved since the first reading. Its own scale: two measures are two
 *  of these, never one chart with two axes. */
@Component({
  selector: 'app-mini-trend',
  template: `
<div class="tcv-mtrend" [title]="tip()">
  <span class="tcv-mbar-label">{{ label() }}</span>
  <svg class="tcv-mtrend-plot" [attr.viewBox]="'0 0 ' + W + ' ' + H" preserveAspectRatio="none">
    @if (line(); as l) {
      <polyline [attr.points]="l" class="tcv-mtrend-line" vector-effect="non-scaling-stroke" />
    }
    @for (p of dots(); track $index) {
      <rect [attr.x]="p.x - p.w / 2" y="0" [attr.width]="p.w" [attr.height]="H" class="tcv-mtrend-hit">
        <title>{{ p.tip }}</title>
      </rect>
    }
  </svg>
  <span class="tcv-mbar-value mono">
    {{ last() ?? '–' }}
    @if (delta(); as d) {
      <b [style.color]="better()(d) ? 'var(--ok)' : 'var(--warn)'">{{ d > 0 ? '+' : '' }}{{ round(d) }}</b>
    }
  </span>
</div>`,
})
export class MiniTrend {
  label = input.required<string>();
  values = input.required<(number | null)[]>();
  times = input<string[]>([]);
  /** Which way is good: fewer unrouted is better, so `d < 0`. */
  better = input<(d: number) => boolean>(d => d < 0);
  readonly W = 100;
  readonly H = 16;

  private pts = computed(() => this.values()
    .map((v, i) => ({ v, i })).filter(p => p.v !== null) as { v: number; i: number }[]);

  last = computed(() => {
    const p = this.pts();
    return p.length ? this.round(p[p.length - 1].v) : null;
  });

  delta = computed(() => {
    const p = this.pts();
    return p.length > 1 ? p[p.length - 1].v - p[0].v : null;
  });

  private scale = computed(() => {
    const p = this.pts();
    const lo = Math.min(...p.map(q => q.v)), hi = Math.max(...p.map(q => q.v));
    const n = Math.max(1, this.values().length - 1);
    return (q: { v: number; i: number }) => ({
      x: this.values().length > 1 ? q.i / n * this.W : this.W / 2,
      // 2 px inside top and bottom so a 2 px line is never clipped.
      y: hi === lo ? this.H / 2 : 2 + (this.H - 4) * (1 - (q.v - lo) / (hi - lo)),
    });
  });

  line = computed(() => {
    const p = this.pts();
    if (p.length < 2) return null;
    const at = this.scale();
    return p.map(q => { const { x, y } = at(q); return `${x.toFixed(1)},${y.toFixed(1)}`; }).join(' ');
  });

  dots = computed(() => {
    const p = this.pts(), at = this.scale();
    const w = this.W / Math.max(1, p.length);
    return p.map(q => ({ x: at(q).x, w,
                         tip: `${this.label()}: ${this.round(q.v)}`
                              + (this.times()[q.i] ? ` · ${this.times()[q.i].slice(11, 16)}` : '') }));
  });

  tip = computed(() => {
    const p = this.pts();
    if (p.length < 2) return `${this.label()}: one reading so far`;
    return `${this.label()}: ${this.round(p[0].v)} → ${this.round(p[p.length - 1].v)} over ${p.length} readings`;
  });

  round(v: number): number { return Math.round(v * 100) / 100; }
}
