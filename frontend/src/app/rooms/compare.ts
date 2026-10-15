import { AfterViewInit, Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CHART_BUSY } from '../chart-load';
import { LANG, T, t } from '../i18n';
import { Fmt, fmt } from './charts';
import { csvText, saveFile } from './dash';

/** Analytics' comparison (GET /api/insights/compare, backend/insights_compare.py):
 *  this month, this week, the last 7 or 30 days or chosen days, against the
 *  period before it of the same length. One row of choices; under it a
 *  table of every figure with both values and the change, and beside it
 *  the drawable ones as charts with the period before laid over, dimmed. */

type Period = 'month' | 'week' | '7d' | '30d' | 'custom';
type Key = 'llm_usd' | 'llm_calls' | 'tokens' | 'tokens_input' | 'tokens_output' | 'tokens_cache_read' | 'cpu_s' | 'jobs'
  | 'failed' | 'wh' | 'cost_usd' | 'notes' | 'runs' | 'questions';
interface Side { since: string; until: string; t0: number; totals: Record<Key, number | null>; series: Record<string, number[]> }
export interface Comparison { period: Period; step: number; n: number; now: Side; before: Side }

const PERIODS: { id: Period; label: string }[] = [
  { id: 'month', label: 'This month' }, { id: 'week', label: 'This week' }, { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' }, { id: 'custom', label: 'Days…' }];
const ROWS: { key: Key; label: string; f: Fmt; sub?: boolean }[] = [
  { key: 'llm_usd', label: 'LLM spend', f: fmt.money },
  { key: 'llm_calls', label: 'LLM calls', f: fmt.count },
  { key: 'tokens', label: 'Tokens', f: fmt.count },
  { key: 'tokens_input', label: 'input', f: fmt.count, sub: true },
  { key: 'tokens_output', label: 'output', f: fmt.count, sub: true },
  { key: 'tokens_cache_read', label: 'cache reads', f: fmt.count, sub: true },
  { key: 'cost_usd', label: 'Running cost', f: fmt.money },
  { key: 'cpu_s', label: 'Compute time', f: fmt.secs },
  { key: 'jobs', label: 'Jobs', f: fmt.count },
  { key: 'failed', label: 'failed', f: fmt.count, sub: true },
  { key: 'wh', label: 'Energy', f: fmt.wh },
  { key: 'notes', label: 'Notes', f: fmt.count },
  { key: 'runs', label: 'Runs', f: fmt.count },
  { key: 'questions', label: 'Agent questions', f: fmt.count },
];
const CHARTS: { key: string; label: string; f: Fmt }[] = [
  { key: 'llm_usd', label: 'LLM spend', f: fmt.money }, { key: 'tokens', label: 'Tokens', f: fmt.count },
  { key: 'cpu_s', label: 'Compute time', f: fmt.secs }, { key: 'jobs', label: 'Jobs', f: fmt.count }];

const KEY = 'redline.analytics.compare';

/** Two periods' buckets on one axis: the period now as a line over a light
 *  area, the one before as a thinner line of the same hue, dimmed; a
 *  crosshair reads both. */
@Component({
  selector: 'app-compare-chart',
  imports: [T],
  host: { class: 'block' },
  template: `
<div class="cmp-ch-head"><b>{{ title() | t }}</b>
  <span class="cmp-key"><i class="now"></i>{{ fmtF()(sum(now())) }}</span>
  <span class="cmp-key dim"><i class="was"></i>{{ fmtF()(sum(was())) }}</span></div>
<div #box class="relative" [class.tcv-ch-busy]="busy()" [style.height.px]="H" (mousemove)="hover($event)" (mouseleave)="at.set(null)">
  @if (busy()) { <div class="tcv-ch-loader" role="status"><span class="tcv-ch-spin" aria-hidden="true"></span></div> }
  @if (w() > 0) {
    <svg [attr.width]="w()" [attr.height]="H" class="block">
      @for (y of grid(); track $index) { <line [attr.x1]="0" [attr.x2]="w()" [attr.y1]="y" [attr.y2]="y" class="tcv-ch-grid" /> }
      <path [attr.d]="area()" class="cmp-area" />
      <path [attr.d]="line(was())" class="cmp-was" />
      <path [attr.d]="line(now())" class="cmp-now" />
      @if (at(); as a) { <line [attr.x1]="a.x" [attr.x2]="a.x" y1="0" [attr.y2]="H" class="tcv-ch-cross" /> }
    </svg>
    @if (at(); as a) {
      <div class="tcv-ch-tip" [style.left.px]="a.x > w() / 2 ? null : a.x + 10" [style.right.px]="a.x > w() / 2 ? w() - a.x + 10 : null">
        <div class="flex items-center gap-1.5"><span class="tcv-ch-dot cmp-dot-now"></span>
          <span class="min-w-0 flex-1 truncate">{{ when(t0(), a.i) }}</span><span class="mono">{{ fmtF()(now()[a.i] ?? 0) }}</span></div>
        <div class="flex items-center gap-1.5"><span class="tcv-ch-dot cmp-dot-was"></span>
          <span class="min-w-0 flex-1 truncate">{{ when(t0b(), a.i) }}</span><span class="mono">{{ fmtF()(was()[a.i] ?? 0) }}</span></div>
      </div>
    }
  }
</div>`,
  styles: [`
    .cmp-ch-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; font-size: 11.5px; }
    .cmp-ch-head b { flex: 1; min-width: 0; font-weight: 600; color: var(--ink); }
    .cmp-key { display: inline-flex; align-items: center; gap: 5px; font: 11px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink); }
    .cmp-key.dim { color: var(--ink-dim); }
    .cmp-key i { display: inline-block; width: 12px; height: 0; border-top: 2px solid var(--series-1); }
    .cmp-key i.was { opacity: .45; border-top-style: dashed; }
    .cmp-area { fill: var(--series-1); opacity: .1; }
    .cmp-now { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
    .cmp-was { fill: none; stroke: var(--series-1); stroke-width: 1.5; stroke-dasharray: 4 3; opacity: .45; }
    .cmp-dot-now { background: var(--series-1); }
    .cmp-dot-was { background: var(--series-1); opacity: .45; }
  `],
})
export class CompareChart implements AfterViewInit, OnDestroy {
  title = input.required<string>();
  now = input.required<number[]>();
  was = input.required<number[]>();
  t0 = input.required<number>();
  t0b = input.required<number>();
  step = input.required<number>();
  fmtF = input<Fmt>(fmt.count, { alias: 'f' });
  readonly H = 138;
  readonly busy = computed(() => CHART_BUSY() > 0);
  private box = viewChild.required<ElementRef<HTMLDivElement>>('box');
  private ro?: ResizeObserver;
  w = signal(0);
  at = signal<{ x: number; i: number } | null>(null);
  /** New figures: the crosshair of the old ones goes. */
  private reset = effect(() => { this.now(); this.was(); untracked(() => this.at.set(null)); });

  ngAfterViewInit() {
    this.ro = new ResizeObserver(() => this.w.set(this.box().nativeElement.clientWidth));
    this.ro.observe(this.box().nativeElement);
  }
  ngOnDestroy() { this.ro?.disconnect(); }

  sum(v: number[]) { return v.reduce((a, x) => a + (x || 0), 0); }
  private n = computed(() => Math.max(this.now().length, this.was().length));
  private max = computed(() => Math.max(1e-9, ...this.now(), ...this.was()) * 1.08);
  private x(i: number) { const n = this.n(); return n > 1 ? (this.w() - 2) * i / (n - 1) + 1 : this.w() / 2; }
  private y(v: number) { return this.H - 2 - (this.H - 6) * (v || 0) / this.max(); }
  grid = computed(() => [0.25, 0.5, 0.75].map(k => Math.round(this.H * k) + 0.5));
  line(v: number[]) { return v.map((x, i) => (i ? 'L' : 'M') + this.x(i).toFixed(1) + ',' + this.y(x).toFixed(1)).join(''); }
  area = computed(() => {
    const v = this.now();
    if (!v.length) return '';
    return this.line(v) + `L${this.x(v.length - 1).toFixed(1)},${this.H}L${this.x(0).toFixed(1)},${this.H}Z`;
  });
  hover(ev: MouseEvent) {
    const r = this.box().nativeElement.getBoundingClientRect(), n = this.n();
    if (!n) return;
    const i = Math.max(0, Math.min(n - 1, Math.round((ev.clientX - r.left - 1) / Math.max(1, this.w() - 2) * (n - 1))));
    this.at.set({ x: this.x(i), i });
  }
  when(t0: number, i: number) { return bucketLabel(t0 + i * this.step(), this.step()); }
}

function bucketLabel(secs: number, step: number): string {
  const d = new Date(secs * 1000), loc = LANG() === 'tr' ? 'tr-TR' : 'en-GB';
  return step < 86400
    ? d.toLocaleString(loc, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
    : d.toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

@Component({
  selector: 'app-compare',
  imports: [T, CompareChart],
  host: { class: 'block' },
  template: `
<div class="cmp-bar">
  <span class="cmp-seg" role="radiogroup" [attr.aria-label]="'Compare' | t">
    @for (p of periods; track p.id) {
      <button role="radio" [attr.aria-checked]="period() === p.id" [attr.data-on]="period() === p.id ? 1 : null" (click)="pick(p.id)">{{ p.label | t }}</button>
    }
  </span>
  @if (period() === 'custom') {
    <input type="date" class="cmp-date" [value]="from()" [max]="today" (change)="setDay('from', $any($event.target).value)" [attr.aria-label]="'First day' | t">
    <span class="cmp-dim">–</span>
    <input type="date" class="cmp-date" [value]="to()" [max]="today" (change)="setDay('to', $any($event.target).value)" [attr.aria-label]="'Last day' | t">
  }
  @if (data(); as d) {
    <span class="cmp-when"><b>{{ span(d.now) }}</b><span class="cmp-dim"> {{ 'against' | t }} </span>{{ span(d.before) }}<span
      class="cmp-dim"> · UTC · {{ (d.step < 86400 ? 'hourly' : 'daily') | t }}</span></span>
  } @else { <span class="cmp-when cmp-dim">{{ (error() || 'Reading…') | t }}</span> }
  <button class="tcv-dl" (click)="csv()" [disabled]="!data()">CSV</button>
</div>
@if (data(); as d) {
  <div class="cmp-body">
    <table class="cmp-table">
      <thead><tr><th>{{ 'Figure' | t }}</th><th class="r">{{ 'This period' | t }}</th><th class="r">{{ 'Previous' | t }}</th>
        <th class="r">{{ 'Change' | t }}</th><th class="r">%</th></tr></thead>
      <tbody>
        @for (r of rows; track r.key) {
          <tr [class.sub]="r.sub">
            <td>{{ r.label | t }}</td>
            <td class="r mono">{{ val(r, d.now.totals[r.key]) }}</td>
            <td class="r mono cmp-dim">{{ val(r, d.before.totals[r.key]) }}</td>
            <td class="r mono">{{ diff(r, d.now.totals[r.key], d.before.totals[r.key]) }}</td>
            <td class="r mono">{{ pct(d.now.totals[r.key], d.before.totals[r.key]) }}</td>
          </tr>
        }
      </tbody>
    </table>
    <div class="cmp-charts">
      @for (c of charts; track c.key) {
        <app-compare-chart [title]="c.label" [now]="d.now.series[c.key] ?? []" [was]="d.before.series[c.key] ?? []"
                           [t0]="d.now.t0" [t0b]="d.before.t0" [step]="d.step" [f]="c.f" />
      }
    </div>
  </div>
}`,
  styles: [`
    .cmp-bar { display: flex; align-items: center; gap: 10px; min-height: 28px; padding: 8px 0 6px; font-size: 11.5px; white-space: nowrap; }
    .cmp-seg { display: inline-flex; gap: 2px; }
    .cmp-seg button { padding: 2px 8px; font-size: 11.5px; color: var(--ink-dim); background: none; border: 0; cursor: pointer; }
    .cmp-seg button:hover { color: var(--ink); }
    .cmp-seg button[data-on] { color: var(--ink-bright); font-weight: 600; }
    .cmp-date { padding: 1px 6px; font: 11px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink);
      background: var(--surface-2); border: 1px solid var(--line); border-radius: 4px; color-scheme: dark light; }
    .cmp-when { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--ink); }
    .cmp-when b { font-weight: 600; }
    .cmp-dim { color: var(--ink-dim); }
    .cmp-body { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 0 20px; padding: 2px 0 6px; }
    .cmp-table { width: 100%; border-collapse: collapse; font-size: 11.5px; table-layout: fixed; }
    .cmp-table th { padding: 3px 6px; text-align: left; font-weight: 500; color: var(--ink-dim); border-bottom: 1px solid var(--line);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cmp-table td { padding: 3px 6px; border-bottom: 1px solid var(--line); color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cmp-table th:first-child, .cmp-table td:first-child { width: 28%; }
    .cmp-table tr.sub td:first-child { padding-left: 18px; color: var(--ink-dim); }
    .cmp-table .r { text-align: right; }
    .cmp-charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 20px; align-content: start; }
    @media (max-width: 1100px) { .cmp-body { grid-template-columns: minmax(0, 1fr); gap: 12px; } }
    @media (max-width: 700px) { .cmp-charts { grid-template-columns: minmax(0, 1fr); } .cmp-bar { flex-wrap: wrap; } }
  `],
})
export class Compare {
  private http = inject(HttpClient);
  readonly periods = PERIODS;
  readonly rows = ROWS;
  readonly charts = CHARTS;
  readonly today = new Date().toISOString().slice(0, 10);
  period = signal<Period>('month');
  from = signal('');
  to = signal('');
  data = signal<Comparison | null>(null);
  error = signal<string | null>(null);
  private seq = 0;

  constructor() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || '{}');
      if (PERIODS.some(p => p.id === s.period)) this.period.set(s.period);
      if (typeof s.from === 'string') this.from.set(s.from);
      if (typeof s.to === 'string') this.to.set(s.to);
    } catch { /* private window */ }
    if (!this.from()) {
      const d = new Date(); d.setUTCDate(d.getUTCDate() - 13);
      this.from.set(d.toISOString().slice(0, 10)); this.to.set(this.today);
    }
    this.load();
  }

  pick(p: Period) { this.period.set(p); this.keep(); this.load(); }
  setDay(which: 'from' | 'to', v: string) {
    if (!v) return;
    (which === 'from' ? this.from : this.to).set(v);
    if (this.from() > this.to()) (which === 'from' ? this.to : this.from).set(v);
    this.keep(); this.load();
  }
  private keep() {
    try { localStorage.setItem(KEY, JSON.stringify({ period: this.period(), from: this.from(), to: this.to() })); } catch { /* private window */ }
  }
  load() {
    const p = this.period(), mine = ++this.seq;
    const q = p === 'custom' ? `&from=${this.from()}&to=${this.to()}` : '';
    this.error.set(null);
    this.http.get<Comparison>(`/api/insights/compare?period=${p}${q}`).subscribe({
      next: d => { if (mine === this.seq) this.data.set(d); },
      error: e => { if (mine === this.seq) { this.data.set(null); this.error.set(e?.error?.detail || 'Could not read the comparison'); } },
    });
  }

  /** "1 Oct – 15 Oct" (the end is exclusive: the last whole day before it). */
  span(s: Side) {
    const loc = LANG() === 'tr' ? 'tr-TR' : 'en-GB', o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: 'UTC' };
    const a = new Date(s.since), b = new Date(new Date(s.until).getTime() - 1);
    const same = a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
    return same ? a.toLocaleDateString(loc, o) : a.toLocaleDateString(loc, o) + ' – ' + b.toLocaleDateString(loc, o);
  }
  val(r: { f: Fmt }, v: number | null | undefined) { return v == null ? '–' : r.f(v); }
  diff(r: { f: Fmt }, a: number | null | undefined, b: number | null | undefined) {
    if (a == null || b == null) return '–';
    const d = a - b;
    return d === 0 ? '0' : (d > 0 ? '+' : '−') + r.f(Math.abs(d));
  }
  pct(a: number | null | undefined, b: number | null | undefined) {
    if (a == null || b == null) return '–';
    if (!b) return a ? t('new') : '0%';
    const p = (a - b) / b * 100;
    return (p > 0 ? '+' : p < 0 ? '−' : '') + Math.abs(p).toFixed(Math.abs(p) < 10 ? 1 : 0) + '%';
  }
  csv() {
    const d = this.data();
    if (!d) return;
    const rows = ROWS.map(r => ({ figure: r.label, now: d.now.totals[r.key], before: d.before.totals[r.key],
                                  change: d.now.totals[r.key] != null && d.before.totals[r.key] != null ? d.now.totals[r.key]! - d.before.totals[r.key]! : null }));
    saveFile(`compare-${d.period}-${d.now.since.slice(0, 10)}.csv`, csvText(rows), 'text/csv');
  }
}
