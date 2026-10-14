import { AfterViewInit, Component, Directive, ElementRef, OnDestroy, computed, inject, input, signal } from '@angular/core';
import { LANG, T, t } from '../i18n';
import { Fmt, MiniStack, StackCol, TimeChart, TimeData } from './charts';

/** The charts of a product's detail (manufacturers.ts, stock.ts), drawn with
 *  the Analytics room's own charts (charts.ts) so they look the same:
 *
 *  - `<wb-stock-chart>`: how many were on hand day by day, from a stock
 *    line's log - the count after each change carried to the next, its
 *    minimum as a second line when it has one, and under it what went in
 *    and out each day as small bars; above it what the log says plainly -
 *    used and added in the last 30 days, how long it lasts at that rate.
 *  - `<wb-price-chart>`: the price each time its page was read, carried to
 *    the next reading, the days its seller said "out of stock" marked; one
 *    reading is a line to today with its value, never an empty table.
 *
 *  Both fill the height they are given (a ResizeObserver on the host). */

const DAY = 86400;

/** A day's start, in seconds (local midnight). */
function dayOf(ms: number) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; }
function fmt(text: string, vars: Record<string, string | number>) {
  return t(text).replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
}
/** 12, 2.5, 0.25 - as a count is said. */
function num(v: number) { return String(Math.round(v * 100) / 100); }
function ago(ms: number): string {
  const d = Math.floor((Date.now() - ms) / 864e5);
  return d <= 0 ? t('today') : d === 1 ? t('yesterday') : fmt('{n} days ago', { n: d });
}

/** Buckets from the first moment to today: days, or weeks past four months - two at least, so a line is drawn. */
function span(first: number): { t0: number; step: number; n: number } {
  const today = dayOf(Date.now());
  let t0 = Math.min(dayOf(first), today - DAY);
  const days = Math.round((today - t0) / DAY) + 1;
  if (days <= 120) return { t0, step: DAY, n: days };
  t0 = today - Math.ceil(days / 7) * 7 * DAY + 7 * DAY;
  return { t0, step: 7 * DAY, n: Math.ceil(days / 7) };
}

/** The plot's height, for a chart that fills it. */
@Directive()
abstract class Fills implements AfterViewInit, OnDestroy {
  private el = inject<ElementRef<HTMLElement>>(ElementRef);
  h = signal(0);
  private ro?: ResizeObserver;
  ngAfterViewInit() {
    const box = this.el.nativeElement.querySelector('.pch-plot') as HTMLElement | null;
    if (!box) return;
    this.ro = new ResizeObserver(() => this.h.set(Math.floor(box.clientHeight)));
    this.ro.observe(box);
  }
  ngOnDestroy() { this.ro?.disconnect(); }
}

export interface StockLog { at: string; delta?: number; after?: number }

@Component({
  selector: 'wb-stock-chart',
  imports: [T, TimeChart, MiniStack],
  host: { class: 'pch' },
  styleUrls: ['./product-charts.css'],
  template: `
<dl class="pch-figs">
  <div><dt>{{ 'Used, 30 days' | t }}</dt><dd>{{ used30() ? num(used30()) + ' ' + unit() : '–' }}</dd></div>
  <div><dt>{{ 'Added, 30 days' | t }}</dt><dd>{{ added30() ? num(added30()) + ' ' + unit() : '–' }}</dd></div>
  <div [title]="'At the rate it was used in the last 30 days' | t"><dt>{{ 'Lasts' | t }}</dt>
    <dd [attr.data-warn]="lasts() != null && lasts()! < 14 ? 1 : null">{{ lasts() == null ? '–' : lasts()! < 1 ? ('under a day' | t) : fmt('~{n} days', { n: lasts()! }) }}</dd></div>
  <div><dt>{{ 'Last change' | t }}</dt><dd>{{ lastAt() ? ago(lastAt()!) : '–' }}</dd></div>
</dl>
<div class="pch-plot">
  @if (h() > 40 && data(); as d) {
    <app-time-chart [data]="d" kind="line" [stacked]="false" [legend]="false" [sums]="false" [height]="h() - (moves().length ? 30 : 0)" [f]="f()" />
    @if (moves().length) { <app-mini-stack class="pch-moves" [data]="moves()" [height]="24" [f]="f()" /> }
  }
</div>`,
})
export class StockChart extends Fills {
  readonly log = input<StockLog[]>([]);
  readonly quantity = input(0);
  readonly min = input<number | null>(null);
  readonly unit = input('pcs');
  num = num; ago = ago; fmt = fmt;
  f = computed<Fmt>(() => { const u = this.unit(); return (v: number) => num(v) + ' ' + u; });
  private rows = computed(() => [...this.log()].filter(l => l.at).map(l => ({ ...l, ms: Date.parse(l.at) }))
    .filter(l => !isNaN(l.ms)).sort((a, b) => a.ms - b.ms));
  private plan = computed(() => { const r = this.rows(); return r.length ? span(r[0].ms) : null; });
  data = computed((): TimeData | null => {
    const p = this.plan(), r = this.rows();
    if (!p) return null;
    const on: (number | null)[] = [];
    let k = 0, cur: number | null = null;
    for (let i = 0; i < p.n; i++) {
      const end = (p.t0 + (i + 1) * p.step) * 1000;
      while (k < r.length && r[k].ms < end) { if (r[k].after != null) cur = r[k].after!; k++; }
      on.push(cur);
    }
    on[on.length - 1] = this.quantity();
    const series = [{ name: t('On hand'), values: on }];
    const m = this.min();
    if (m != null) series.push({ name: t('Minimum'), values: on.map(() => m) });
    return { ...p, series };
  });
  /** What went in (up) and out (down) each bucket, as the stacked bars under the line. */
  moves = computed((): StackCol[] => {
    const p = this.plan(), r = this.rows();
    // Its bars only where there are days enough for them to read as days.
    if (!p || p.n < 7 || !r.some(l => l.delta)) return [];
    const cols = Array.from({ length: p.n }, (_, i) => ({ i, inn: 0, out: 0 }));
    for (const l of r) {
      const i = Math.floor((dayOf(l.ms) - p.t0) / p.step);
      if (i < 0 || i >= p.n || !l.delta) continue;
      if (l.delta > 0) cols[i].inn += l.delta; else cols[i].out -= l.delta;
    }
    const loc = LANG() === 'tr' ? 'tr-TR' : 'en-GB';
    return cols.map(c => ({ label: new Date((p.t0 + c.i * p.step) * 1000).toLocaleDateString(loc, { day: 'numeric', month: 'short' }),
      parts: [{ name: t('Added'), n: c.inn, color: 'var(--ok)' }, { name: t('Taken'), n: c.out, color: 'var(--danger)' }] }));
  });
  private since30 = () => Date.now() - 30 * 864e5;
  used30 = computed(() => this.rows().filter(l => l.ms >= this.since30() && (l.delta ?? 0) < 0).reduce((a, l) => a - l.delta!, 0));
  added30 = computed(() => this.rows().filter(l => l.ms >= this.since30() && (l.delta ?? 0) > 0).reduce((a, l) => a + l.delta!, 0));
  /** Days it lasts at the last 30 days' rate of use; none without use. */
  lasts = computed(() => { const u = this.used30(); return u > 0 ? Math.floor(this.quantity() / (u / 30)) : null; });
  lastAt = computed(() => { const r = this.rows(); return r.length ? r[r.length - 1].ms : null; });
}

export interface PriceReading { at: string; amount?: number | null; currency?: string | null; stock?: string | null; qty?: number | null }

@Component({
  selector: 'wb-price-chart',
  imports: [T, TimeChart],
  host: { class: 'pch', '[attr.data-compact]': 'compact() ? 1 : null' },
  styleUrls: ['./product-charts.css'],
  template: `
<dl class="pch-figs">
  <div><dt>{{ 'Now' | t }}</dt><dd class="pch-now">{{ last() != null ? f()(last()!) : '–' }}</dd></div>
  <div><dt>{{ 'Last change' | t }}</dt><dd [attr.data-up]="change() > 0 ? 1 : null" [attr.data-down]="change() < 0 ? 1 : null">
    {{ change() ? (change() > 0 ? '+' : '') + change().toFixed(1) + '%' : (rows().length > 1 ? ('none' | t) : '–') }}</dd></div>
  <div><dt>{{ 'Lowest' | t }}</dt><dd>{{ lo() != null ? f()(lo()!) : '–' }}</dd></div>
  <div><dt>{{ 'Highest' | t }}</dt><dd>{{ hi() != null ? f()(hi()!) : '–' }}</dd></div>
  <div><dt>{{ 'Readings' | t }}</dt><dd>{{ rows().length }}@if (outs()) { <span class="pch-out"> · {{ fmt('{n} out of stock', { n: outs() }) }}</span> }</dd></div>
</dl>
<div class="pch-plot">
  @if (h() > 40 && data(); as d) {
    <app-time-chart [data]="d" kind="line" [stacked]="false" [legend]="false" [sums]="false" [height]="h()" [f]="f()" [marks]="marks()" />
  }
</div>
@if (rows().length && outs()) { <p class="pch-key"><i></i>{{ 'its seller said out of stock' | t }}</p> }`,
})
export class PriceChart extends Fills {
  readonly history = input<PriceReading[]>([]);
  readonly currency = input('');
  /** How a price is written (the page's money formatting). */
  readonly f = input<Fmt>(v => v.toFixed(2));
  fmt = fmt;
  /** One or two readings: a short line to today with its value, not a chart filling the column. */
  compact = computed(() => this.rows().length < 3);
  rows = computed(() => this.history().map(h => ({ ...h, ms: Date.parse(h.at) }))
    .filter(h => !isNaN(h.ms) && h.amount != null && (!this.currency() || !h.currency || h.currency === this.currency()))
    .sort((a, b) => a.ms - b.ms));
  private plan = computed(() => { const r = this.rows(); return r.length ? span(r[0].ms) : null; });
  /** Each bucket: the price and the seller's word read last by its end. */
  private walk = computed(() => {
    const p = this.plan(), r = this.rows();
    if (!p) return null;
    const v: (number | null)[] = [], out: number[] = [];
    let k = 0, cur: number | null = null, s: string | null | undefined = null;
    for (let i = 0; i < p.n; i++) {
      const end = (p.t0 + (i + 1) * p.step) * 1000;
      while (k < r.length && r[k].ms < end) { cur = r[k].amount!; s = r[k].stock; k++; }
      v.push(cur);
      if (cur != null && s === 'out') out.push(i);
    }
    return { p, v, out };
  });
  data = computed((): TimeData | null => { const w = this.walk(); return w ? { ...w.p, series: [{ name: t('Price'), values: w.v }] } : null; });
  marks = computed(() => this.walk()?.out ?? []);
  last = computed(() => { const r = this.rows(); return r.length ? r[r.length - 1].amount! : null; });
  change = computed(() => { const r = this.rows(); if (r.length < 2) return 0; const a = r[r.length - 2].amount!, b = r[r.length - 1].amount!; return a ? (b - a) / a * 100 : 0; });
  lo = computed(() => { const r = this.rows(); return r.length ? Math.min(...r.map(x => x.amount!)) : null; });
  hi = computed(() => { const r = this.rows(); return r.length ? Math.max(...r.map(x => x.amount!)) : null; });
  outs = computed(() => this.rows().filter(r => r.stock === 'out').length);
}
