import {
  Component, ElementRef, OnDestroy, computed, input, signal, viewChild, AfterViewInit,
} from '@angular/core';

/** Charts for the Analytics room, drawn as SVG in the app's own colours.
 *
 *  A time series comes from the server already bucketed - a start, a step
 *  and one value per bucket for each series - so drawing it is laying out
 *  what is there, not working anything out. Series take the theme's
 *  series colours in order (PALETTE).
 */
export interface Series { name: string; values: (number | null)[] }
export interface TimeData { t0: number; step: number; n: number; series: Series[] }
export interface Row { name: string; value: number; sub?: string }

/** The theme's series colours, in order - named in full so a search for a
 *  token finds where it is used. */
export const PALETTE = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
                        'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];
export function color(i: number): string { return PALETTE[i % PALETTE.length]; }

export type Fmt = (v: number) => string;
export const fmt = {
  money: (v: number) => v >= 1000 ? `$${Math.round(v).toLocaleString('en-US')}`
    : v >= 1 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toFixed(v < 0.01 ? 4 : 3)}` : '$0',
  count: (v: number) => v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M'
    : v >= 1e4 ? (v / 1e3).toFixed(1) + 'k' : String(Math.round(v * 100) / 100),
  bytes: (v: number) => v >= 1e12 ? (v / 1e12).toFixed(2) + ' TB' : v >= 1e9 ? (v / 1e9).toFixed(2) + ' GB'
    : v >= 1e6 ? (v / 1e6).toFixed(1) + ' MB' : v >= 1e3 ? (v / 1e3).toFixed(0) + ' kB' : v + ' B',
  secs: (v: number) => v >= 86400 ? (v / 86400).toFixed(1) + ' d' : v >= 3600 ? (v / 3600).toFixed(1) + ' h'
    : v >= 60 ? Math.round(v / 60) + ' min' : v.toFixed(0) + ' s',
  pct: (v: number) => v.toFixed(0) + '%',
  hours: (v: number) => v >= 1 ? v.toFixed(1) + ' h' : Math.round(v * 60) + ' min',
  wh: (v: number) => v >= 1000 ? (v / 1000).toFixed(2) + ' kWh' : v.toFixed(1) + ' Wh',
  watts: (v: number) => v.toFixed(0) + ' W',
};

/** A time series: stacked bars, lines or areas, with a crosshair that reads
 *  every series at the bucket under the mouse, and a legend that hides and
 *  shows them. */
@Component({
  selector: 'app-time-chart',
  host: { class: 'block' },
  template: `
<div #box class="relative" [style.height.px]="height()"
     (mousemove)="hover($event)" (mouseleave)="at.set(null)">
  @if (w() > 0) {
    <svg [attr.width]="w()" [attr.height]="height()" class="block">
      @for (t of yTicks(); track t.v) {
        <line [attr.x1]="L" [attr.x2]="w() - R" [attr.y1]="t.y" [attr.y2]="t.y" class="tcv-ch-grid" />
        <text [attr.x]="L - 6" [attr.y]="t.y + 3" text-anchor="end" class="tcv-ch-tick">{{ t.label }}</text>
      }
      @for (t of xTicks(); track t.i) {
        <text [attr.x]="t.x" [attr.y]="height() - 4" text-anchor="middle" class="tcv-ch-tick">{{ t.label }}</text>
      }
      @if (kind() === 'bar') {
        @for (b of bars(); track $index) {
          <rect [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h" [attr.fill]="b.c" rx="1" />
        }
      } @else {
        @for (p of paths(); track p.name) {
          @if (kind() === 'area') {
            <path [attr.d]="p.area" [attr.fill]="p.c" class="tcv-ch-area" />
          }
          <path [attr.d]="p.line" [attr.stroke]="p.c" class="tcv-ch-line" />
          <!-- A reading with nothing either side of it is a point, not a
               line: without a dot it would not show at all. -->
          @for (d of p.dots; track $index) {
            <circle [attr.cx]="d[0]" [attr.cy]="d[1]" r="2.6" [attr.fill]="p.c" />
          }
        }
      }
      <!-- Buckets marked as unusual: a band behind them and a notch on top. -->
      @for (i of marks(); track i) {
        <rect [attr.x]="markX(i) - slot() / 2" [attr.y]="T" [attr.width]="slot()" [attr.height]="height() - B - T"
              class="tcv-ch-mark" />
        <path [attr.d]="'M' + (markX(i) - 4) + ',' + T + 'L' + (markX(i) + 4) + ',' + T + 'L' + markX(i) + ',' + (T + 6) + 'Z'"
              class="tcv-ch-notch" />
      }
      @if (at(); as a) {
        <line [attr.x1]="a.x" [attr.x2]="a.x" [attr.y1]="T" [attr.y2]="height() - B" class="tcv-ch-cross" />
      }
    </svg>
    @if (at(); as a) {
      <div class="tcv-ch-tip" [style.left.px]="a.x > w() / 2 ? null : a.x + 10"
           [style.right.px]="a.x > w() / 2 ? w() - a.x + 10 : null">
        <div class="tcv-ch-tip-head">{{ when(a.i) }}</div>
        @for (r of a.rows; track r.name) {
          <div class="flex items-center gap-1.5">
            <span class="tcv-ch-dot" [style.background]="r.c"></span>
            <span class="min-w-0 flex-1 truncate">{{ r.name }}</span>
            <span class="mono">{{ r.v == null ? '–' : f()(r.v) }}</span>
          </div>
        }
        @if (stacked() && a.rows.length > 1) {
          <div class="tcv-ch-tip-total flex"><span class="flex-1">total</span>
            <span class="mono">{{ f()(a.total) }}</span></div>
        }
      </div>
    }
  }
  @if (empty()) {
    <div class="tcv-ch-empty">no data in this range</div>
  }
</div>
@if (legend() && data().series.length > 1) {
  <div class="tcv-ch-legend">
    @for (s of data().series; track s.name; let i = $index) {
      <button (click)="toggle(s.name)" [class.tcv-ch-off]="hidden().has(s.name)">
        <span class="tcv-ch-dot" [style.background]="colorOf(i)"></span>{{ s.name }}
        <span class="mono tcv-ch-sum">{{ f()(sum(s)) }}</span>
      </button>
    }
  </div>
}`,
})
export class TimeChart implements AfterViewInit, OnDestroy {
  data = input.required<TimeData>();
  kind = input<'bar' | 'line' | 'area'>('bar');
  stacked = input(true);
  height = input(180);
  f = input<Fmt>(fmt.count);
  legend = input(true);
  /** Legend totals make no sense for averages (percent, watts). */
  sums = input(true);
  /** Buckets to mark as unusual. */
  marks = input<number[]>([]);

  readonly L = 46; readonly R = 8; readonly T = 8; readonly B = 18;
  private box = viewChild.required<ElementRef<HTMLDivElement>>('box');
  private ro?: ResizeObserver;
  w = signal(0);
  hidden = signal<Set<string>>(new Set());
  at = signal<{ x: number; i: number; rows: { name: string; v: number | null; c: string }[];
                total: number } | null>(null);

  ngAfterViewInit() {
    this.ro = new ResizeObserver(() => this.w.set(this.box().nativeElement.clientWidth));
    this.ro.observe(this.box().nativeElement);
  }
  ngOnDestroy() { this.ro?.disconnect(); }

  colorOf(i: number) { return color(i); }
  private shown = computed(() => this.data().series
    .map((s, i) => ({ ...s, c: color(i) })).filter(s => !this.hidden().has(s.name)));
  empty = computed(() => !this.data().series.some(s => s.values.some(v => v)));

  toggle(name: string) {
    const h = new Set(this.hidden());
    if (h.has(name)) h.delete(name); else h.add(name);
    this.hidden.set(h);
  }
  sum(s: Series): number { return this.sums() ? s.values.reduce<number>((a, v) => a + (v ?? 0), 0) : Math.max(...s.values.map(v => v ?? 0)); }

  private max = computed(() => {
    const n = this.data().n, shown = this.shown();
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (this.stacked() && this.kind() !== 'line') {
        m = Math.max(m, shown.reduce((a, s) => a + (s.values[i] ?? 0), 0));
      } else {
        for (const s of shown) m = Math.max(m, s.values[i] ?? 0);
      }
    }
    return nice(m || 1);
  });
  private x(i: number) {
    const n = this.data().n;
    return this.L + (this.w() - this.L - this.R) * (n > 1 ? i / (n - 1) : 0.5);
  }
  slot() { return (this.w() - this.L - this.R) / Math.max(1, this.data().n); }
  markX(i: number) { return this.kind() === 'bar' ? this.L + this.slot() * (i + 0.5) : this.x(i); }
  private y(v: number) { return this.height() - this.B - (this.height() - this.B - this.T) * v / this.max(); }

  yTicks = computed(() => [0, 0.25, 0.5, 0.75, 1].map(k => {
    const v = this.max() * k;
    return { v, y: this.y(v), label: this.f()(v) };
  }));
  xTicks = computed(() => {
    const n = this.data().n, count = Math.min(6, n);
    const out = [];
    for (let k = 0; k < count; k++) {
      const i = Math.round(k * (n - 1) / Math.max(1, count - 1));
      out.push({ i, x: this.kind() === 'bar' ? this.L + this.slot() * (i + 0.5) : this.x(i), label: this.label(i) });
    }
    return out;
  });
  bars = computed(() => {
    const out: { x: number; y: number; w: number; h: number; c: string }[] = [];
    const slot = this.slot(), bw = Math.max(1, slot * 0.72), shown = this.shown();
    for (let i = 0; i < this.data().n; i++) {
      let base = 0;
      shown.forEach((s, k) => {
        const v = s.values[i] ?? 0;
        if (!v) return;
        if (this.stacked()) {
          const y1 = this.y(base + v), y0 = this.y(base);
          out.push({ x: this.L + slot * i + (slot - bw) / 2, y: y1, w: bw, h: Math.max(0.5, y0 - y1), c: s.c });
          base += v;
        } else {
          const sw = bw / shown.length;
          out.push({ x: this.L + slot * i + (slot - bw) / 2 + k * sw, y: this.y(v), w: sw, h: Math.max(0.5, this.y(0) - this.y(v)), c: s.c });
        }
      });
    }
    return out;
  });
  paths = computed(() => {
    const shown = this.shown(), n = this.data().n;
    const base = new Array(n).fill(0);
    return shown.map(s => {
      const pts: [number, number][] = [];
      const low: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v == null && !this.stacked()) continue;
        const b = this.stacked() && this.kind() === 'area' ? base[i] : 0;
        pts.push([this.x(i), this.y(b + (v ?? 0))]);
        low.push([this.x(i), this.y(b)]);
        if (this.stacked() && this.kind() === 'area') base[i] += v ?? 0;
      }
      const line = pts.map((p, k) => (k ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
      const dots: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        if (s.values[i] != null && s.values[i - 1] == null && s.values[i + 1] == null) {
          dots.push([this.x(i), this.y(s.values[i]!)]);
        }
      }
      const area = line + low.reverse().map(p => 'L' + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('') + 'Z';
      return { name: s.name, c: s.c, line, area, dots };
    });
  });

  hover(ev: MouseEvent) {
    const r = this.box().nativeElement.getBoundingClientRect();
    const px = ev.clientX - r.left, n = this.data().n;
    if (px < this.L || px > this.w() - this.R || !n) { this.at.set(null); return; }
    const i = this.kind() === 'bar'
      ? Math.min(n - 1, Math.floor((px - this.L) / this.slot()))
      : Math.round((px - this.L) / (this.w() - this.L - this.R) * (n - 1));
    const rows = this.shown().map(s => ({ name: s.name, v: s.values[i], c: s.c }))
      .filter(r => r.v !== 0 || this.kind() !== 'bar');
    const total = rows.reduce((a, r) => a + (r.v ?? 0), 0);
    const x = this.kind() === 'bar' ? this.L + this.slot() * (i + 0.5) : this.x(i);
    this.at.set({ x, i, rows, total });
  }

  private label(i: number): string {
    const d = new Date((this.data().t0 + i * this.data().step) * 1000);
    const step = this.data().step;
    return step < 86400
      ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  when(i: number): string {
    const d = new Date((this.data().t0 + i * this.data().step) * 1000);
    return this.data().step < 86400
      ? d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }
}

/** A round number just above the largest value, so the axis reads well. */
function nice(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

/** Ranked horizontal bars: name, bar, value. */
@Component({
  selector: 'app-bar-list',
  host: { class: 'block' },
  template: `
@for (r of rows(); track r.name; let i = $index) {
  <div class="tcv-bl-row" [title]="r.name + ': ' + f()(r.value) + (r.sub ? ' · ' + r.sub : '')">
    <span class="tcv-bl-name">{{ r.name }}</span>
    <span class="tcv-bl-track"><span class="tcv-bl-bar" [style.width.%]="pct(r.value)"
          [style.background]="colorOf(i)"></span></span>
    <span class="tcv-bl-val mono">{{ f()(r.value) }}</span>
  </div>
} @empty {
  <div class="tcv-ch-empty static">nothing yet</div>
}`,
})
export class BarList {
  rows = input.required<Row[]>();
  f = input<Fmt>(fmt.count);
  /** One colour for every bar, or a colour each. */
  mono = input(false);
  colorOf(i: number) { return this.mono() ? color(0) : color(i); }
  pct(v: number) { const m = Math.max(...this.rows().map(r => r.value), 0); return m ? 100 * v / m : 0; }
}

/** A donut with its legend: shares of a whole. */
@Component({
  selector: 'app-donut',
  host: { class: 'block' },
  template: `
<div class="flex items-center gap-4">
  <svg viewBox="0 0 42 42" class="h-[120px] w-[120px] shrink-0 -rotate-90">
    <circle cx="21" cy="21" r="15.9" fill="none" class="tcv-dn-track" stroke-width="6" />
    @for (a of arcs(); track a.name) {
      <circle cx="21" cy="21" r="15.9" fill="none" [attr.stroke]="a.c" stroke-width="6"
              [attr.stroke-dasharray]="a.len + ' ' + (100 - a.len)" [attr.stroke-dashoffset]="-a.off">
        <title>{{ a.name }}: {{ f()(a.v) }} ({{ a.len.toFixed(1) }}%)</title>
      </circle>
    }
  </svg>
  <div class="min-w-0 flex-1 text-[11.5px]">
    @for (a of arcs(); track a.name) {
      <div class="flex items-center gap-1.5 leading-relaxed">
        <span class="tcv-ch-dot" [style.background]="a.c"></span>
        <span class="min-w-0 flex-1 truncate">{{ a.name }}</span>
        <span class="mono" style="color: var(--ink-dim)">{{ a.len.toFixed(0) }}%</span>
        <span class="mono w-[4.5rem] text-right">{{ f()(a.v) }}</span>
      </div>
    } @empty {
      <div class="tcv-ch-empty static">nothing yet</div>
    }
  </div>
</div>`,
})
export class Donut {
  rows = input.required<Row[]>();
  f = input<Fmt>(fmt.count);
  arcs = computed(() => {
    const rows = this.rows().filter(r => r.value > 0);
    const total = rows.reduce((a, r) => a + r.value, 0) || 1;
    let off = 0;
    return rows.map((r, i) => {
      const len = 100 * r.value / total, a = { name: r.name, v: r.value, c: color(i), len, off };
      off += len;
      return a;
    });
  });
}

/** A small line of values - an item's history at a glance. */
@Component({
  selector: 'app-spark',
  host: { class: 'inline-block align-middle' },
  template: `
<svg [attr.width]="width()" [attr.height]="height()" class="block overflow-visible">
  @if (d(); as p) {
    <path [attr.d]="p.line" class="tcv-spark" />
    <circle [attr.cx]="p.last[0]" [attr.cy]="p.last[1]" r="2.2" class="tcv-spark-dot" />
  }
</svg>`,
})
export class Spark {
  values = input.required<(number | null)[]>();
  width = input(90);
  height = input(22);
  d = computed(() => {
    const v = this.values().filter((x): x is number => x != null);
    if (v.length < 2) return null;
    const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
    const pts = v.map((x, i) => [i * this.width() / (v.length - 1),
                                 this.height() - 2 - (x - lo) / span * (this.height() - 4)]);
    return { line: pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(''),
             last: pts[pts.length - 1] };
  });
}
