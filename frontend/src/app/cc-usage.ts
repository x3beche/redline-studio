import { Component, DestroyRef, ElementRef, Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { LANG, T, t } from './i18n';
import { Prefs } from './preferences';
import { money as shown, usdTip } from './money';
import { CcTabWindow, TopBar } from './topbar';
import { TimeChart, TimeData } from './rooms/charts';
import { Skeleton } from './skeleton';
import { CountUp } from './count';

/** The Command Code account's figures (GET /api/llm/commandcode/account,
 *  backend/llm.py cc_account): the plan, the 5-hour and weekly usage
 *  windows, credits and the billing period's requests, and 14 days of the
 *  weekly window for a chart.
 *
 *  Command Code's account endpoints are undocumented ("alpha"), so every
 *  field may be missing, and `shared: false` means none of them answered.
 *  One copy for the whole page (CcUsage), refreshed every two minutes while
 *  anything that shows it is on screen: Settings > LLM settings, the chip
 *  in the top bar and the line in the Chat room. */
export interface CcWindow { used: number | null; cap: number | null; pct: number | null; exceeded: boolean; reset_at: number | null }
export interface CcPoint { t: number; weekly_used: number | null; weekly_cap: number | null; five_used: number | null;
                           monthly_left: number | null; total_credits: number | null }
export interface CcAccount {
  set: boolean; shared: boolean; stale?: boolean; at?: string;
  account?: { name: string | null; user_name: string | null; email?: string | null; org: string | null } | null;
  plan?: { id: string | null; name: string | null; status: string | null; period_start: number | null;
           period_end: number | null; cancel_at_period_end: boolean } | null;
  credits?: { monthly_left: number | null; purchased: number | null; free: number | null;
              threshold: number | null; below_threshold: boolean | null } | null;
  windows?: { five_hour: CcWindow | null; weekly: CcWindow | null; limited: boolean | null; exceeded: boolean | null;
              /** Derived: the period's spent monthly credits of spent + left. */
              monthly?: (CcWindow & { left: number | null; derived: boolean }) | null };
  usage?: { requests: number | null; completed: number | null; failed: number | null; success_pct: number | null;
            cost_total: number | null; cost_avg: number | null; credits: number | null;
            tokens_in: number | null; tokens_out: number | null; tokens: number | null; basis: string | null } | null;
  answers?: Record<string, number | string | null>;
  /** What our own points show about the weekly window (backend cc_window_kind). */
  weekly_kind?: 'fixed' | 'rolling' | 'unknown';
  history?: CcPoint[];
}

const EVERY_MS = 120_000;

@Injectable({ providedIn: 'root' })
export class CcUsage {
  private http = inject(HttpClient);
  data = signal<CcAccount | null>(null);
  loading = signal(false);
  err = signal<string | null>(null);
  /** When the page last heard from the server (ms). */
  loadedAt = signal(0);
  /** A clock for "30 s ago" and "resets in", ticking while shown. */
  now = signal(Date.now());
  private users = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;

  /** Something on screen shows the figures: load them (unless they are
   *  fresh) and keep them fresh until the returned function is called. */
  use(): () => void {
    if (this.users++ === 0) {
      if (Date.now() - this.loadedAt() > 60_000) this.load();
      this.timer = setInterval(() => this.load(), EVERY_MS);
      this.ticker = setInterval(() => this.now.set(Date.now()), 5_000);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--this.users === 0) { clearInterval(this.timer); clearInterval(this.ticker); }
    };
  }

  load(refresh = false) {
    if (this.loading()) return;
    this.loading.set(true);
    this.http.get<CcAccount>('/api/llm/commandcode/account' + (refresh ? '?refresh=1' : '')).subscribe({
      next: d => { this.data.set(d); this.err.set(null); this.loading.set(false); this.loadedAt.set(Date.now()); this.now.set(Date.now()); },
      error: e => { this.err.set(`${t('The account figures did not load')} (${e?.status ?? '?'}).`); this.loading.set(false); },
    });
  }

  /** The weekly window, when Command Code shared one with a cap. */
  weekly = computed(() => { const d = this.data(); const w = d?.shared ? d.windows?.weekly : null; return w?.cap ? w : null; });
  fiveHour = computed(() => { const d = this.data(); const w = d?.shared ? d.windows?.five_hour : null; return w?.cap ? w : null; });
  /** The month: spent of (spent + left), as Command Code reports them. */
  monthly = computed(() => { const d = this.data(); const w = d?.shared ? d.windows?.monthly : null; return w?.used != null ? w : null; });
}

/** A provider with no account to read for its key (backend/llm.py
 *  REGISTRY, account None): the card shows what Workbench itself asked of
 *  it, from its own call log (GET /api/llm/providers/<id>/account). */
export interface OwnAccount {
  set: boolean; shared: boolean;
  redline?: { month: { calls: number; input: number; output: number; cost_usd: number | null };
              days30: { calls: number; input: number; output: number; cost_usd: number | null };
              by_model: { name: string; calls: number; tokens?: number; cost_usd: number | null }[] } | null;
}

@Injectable({ providedIn: 'root' })
export class OwnUsage {
  private http = inject(HttpClient);
  data = signal<Record<string, OwnAccount>>({});
  loadedAt = signal<Record<string, number>>({});
  busy = signal<Record<string, boolean>>({});
  loading(p: string) { return !!this.busy()[p]; }
  load(p: string, refresh = false) {
    if (this.busy()[p] || (!refresh && Date.now() - (this.loadedAt()[p] ?? 0) < 60_000)) return;
    this.busy.update(b => ({ ...b, [p]: true }));
    this.http.get<OwnAccount>(`/api/llm/providers/${p}/account` + (refresh ? '?refresh=1' : '')).subscribe({
      next: d => { this.data.update(x => ({ ...x, [p]: d })); this.loadedAt.update(x => ({ ...x, [p]: Date.now() }));
                   this.busy.update(b => ({ ...b, [p]: false })); },
      error: () => this.busy.update(b => ({ ...b, [p]: false })),
    });
  }
}

/** "warn" from 75%, "danger" from 90% or when used up. */
export function tone(w: CcWindow | null | undefined): 'warn' | 'danger' | null {
  if (!w) return null;
  const p = w.pct ?? 0;
  return w.exceeded || p >= 90 ? 'danger' : p >= 75 ? 'warn' : null;
}

export function pctOf(w: CcWindow | null | undefined): number {
  return w?.pct == null ? 0 : Math.max(0, Math.min(100, w.pct));
}

/** A number of credits, short: 812.5, 1.2k, 3.4M. */
export function num(v: number | null | undefined): string {
  if (v == null) return '–';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  if (a >= 100) return Math.round(v).toLocaleString('en-US');
  return String(Math.round(v * 100) / 100);
}

/** A span, short: "2 h 10 min", "3 d 4 h", "45 s". */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} ${t('s')}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} ${t('min')}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${t('h')}${m % 60 ? ' ' + (m % 60) + ' ' + t('min') : ''}`;
  const d = Math.floor(h / 24);
  return `${d} ${t('d')}${h % 24 ? ' ' + (h % 24) + ' ' + t('h') : ''}`;
}

/** "in 2 h 10 min", or "now" once past. */
export function inSpan(at: number | null | undefined, now: number): string {
  if (!at) return '–';
  if (at <= now) return t('now');
  return LANG() === 'tr' ? `${span(at - now)} sonra` : `in ${span(at - now)}`;
}

/** A moment in this browser's time: "Mon 13 Oct 14:00". */
export function localTime(at: number | null | undefined, withDay = true): string {
  if (!at) return '–';
  const loc = LANG() === 'tr' ? 'tr-TR' : 'en-GB';
  return new Date(at).toLocaleString(loc, withDay
    ? { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' });
}

export function day(at: number | null | undefined): string {
  if (!at) return '–';
  return new Date(at).toLocaleDateString(LANG() === 'tr' ? 'tr-TR' : 'en-GB', { day: 'numeric', month: 'short' });
}

/** When the weekly window frees up, as honestly as it is known: Command
 *  Code's own resetAt; "frees up from" once our points show the window
 *  rolling (resetAt moving on while the usage stays). */
export function weeklyReset(d: CcAccount | null): string {
  const w = d?.windows?.weekly;
  if (!w?.reset_at) return '';
  return (d?.weekly_kind === 'rolling' ? t('oldest use frees up') : t('resets')) + ' ' + localTime(w.reset_at);
}

/** Both windows and the credits, in a few lines, for a tooltip. */
export function tip(d: CcAccount | null, now: number): string {
  if (!d?.shared) return t('Command Code didn\'t share usage');
  const lines: string[] = [];
  const plan = d.plan?.name;
  lines.push('Command Code' + (plan ? ' · ' + plan : ''));
  const w = d.windows?.weekly, f = d.windows?.five_hour;
  if (w) lines.push(`${t('Weekly window')}: ${num(w.used)} / ${num(w.cap)} (${w.pct ?? '–'}%) · ${weeklyReset(d)}`);
  if (f) lines.push(`${t('5-hour window')}: ${num(f.used)} / ${num(f.cap)} (${f.pct ?? '–'}%) · ${t('resets')} ${inSpan(f.reset_at, now)}`);
  const m = d.windows?.monthly;
  if (m) lines.push(`${t('Month')}: ${num(m.used)} ${t('spent')}, ${num(m.left)} ${t('left')}${m.pct != null ? ' (' + m.pct + '%)' : ''}`
    + (d.plan?.period_end ? ` · ${d.plan.cancel_at_period_end ? t('ends') : t('renews')} ${day(d.plan.period_end)}` : '')
    + ` - ${t('as Command Code reports')}`);
  if (!m && d.credits?.monthly_left != null) lines.push(`${t('Monthly credits left')}: ${num(d.credits.monthly_left)}`);
  if (!m && d.plan?.period_end) lines.push(`${d.plan.cancel_at_period_end ? t('Ends') : t('Renews')} ${day(d.plan.period_end)}`);
  if (d.stale) lines.push(t('Command Code did not answer - these are the last figures it gave.'));
  return lines.join('\n');
}

/** Keeps CcUsage polling while the component is on screen. */
function polling(): CcUsage {
  const cc = inject(CcUsage);
  inject(DestroyRef).onDestroy(cc.use());
  return cc;
}

/** The windows a setting names, in order, with their short names. */
export function picked(cc: CcUsage, which: CcTabWindow): { id: string; label: string; w: CcWindow }[] {
  const all = [{ id: 'weekly', label: 'W', w: cc.weekly() }, { id: 'five', label: '5h', w: cc.fiveHour() },
               { id: 'monthly', label: 'M', w: cc.monthly() }];
  return all.filter(x => x.w && (which === 'all' || x.id === which)) as { id: string; label: string; w: CcWindow }[];
}

/** Inside the Chat tab (app.ts, and its row under More): the usage, flat -
 *  a tiny bar, the percent, or both (Settings > Top bar chooses, and which
 *  window). Clicking it opens LLM settings; the rest of the tab opens Chat. */
@Component({
  selector: 'app-cc-tab-usage',
  host: { class: 'tb-cc-host' },
  styles: [`
    :host { display: inline-flex; vertical-align: middle; }
    .tb-cc { display: inline-flex; align-items: center; gap: 6px; margin-left: 6px; cursor: pointer;
      font: 500 10.5px/1 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); white-space: nowrap; }
    .tb-cc-one { display: inline-flex; align-items: center; gap: 3px; }
    .tb-cc-k { opacity: .75; }
    .tb-cc-bar { width: 22px; height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
    .tb-cc-bar > i { display: block; height: 100%; background: var(--accent); }
    .tb-cc-one[data-tone="warn"] .tb-cc-bar > i { background: var(--warn); }
    .tb-cc-one[data-tone="warn"] .tb-cc-v { color: var(--warn); }
    .tb-cc-one[data-tone="danger"] .tb-cc-bar > i { background: var(--danger); }
    .tb-cc-one[data-tone="danger"] .tb-cc-v { color: var(--danger); }
    @media (max-width: 768px) { .tb-cc-bar { width: 14px; } .tb-cc { gap: 4px; margin-left: 4px; } }
  `],
  template: `
@if (shown().length) {
  <span class="tb-cc" [title]="tipText()">
    @for (x of shown(); track x.id) {
      <span class="tb-cc-one" [attr.data-tone]="tone(x.w)">
        @if (shown().length > 1) { <span class="tb-cc-k">{{ x.label }}</span> }
        @if (style() !== 'pct' && x.w.pct != null) { <span class="tb-cc-bar" aria-hidden="true"><i [style.width.%]="pct(x.w)"></i></span> }
        @if (style() !== 'bar' || x.w.pct == null) { <span class="tb-cc-v">{{ x.w.pct != null ? round(x.w.pct) + '%' : num(x.w.used) }}</span> }
      </span>
    }
  </span>
}`,
})
export class CcTabUsage implements OnDestroy {
  cc = polling();
  private bar = inject(TopBar);
  private el = inject(ElementRef).nativeElement as HTMLElement;
  readonly tone = tone;
  readonly pct = pctOf;
  readonly num = num;
  style = this.bar.ccStyle;
  shown = computed(() => this.style() === 'off' ? [] : picked(this.cc, this.bar.ccWindow()));
  tipText = computed(() => tip(this.cc.data(), this.cc.now()));
  // Its width is the Chat tab's: the bar measures the tabs again when it changes.
  private ro = new ResizeObserver(() => this.bar.extraW.set(Math.ceil(this.el.getBoundingClientRect().width)));
  constructor() { this.ro.observe(this.el); }
  ngOnDestroy() { this.ro.disconnect(); }
  round(v: number) { return Math.round(v); }

}

/** Every provider together (GET /api/llm/summary, backend/llm_api.py): this
 *  month, today, the last days by day, and how the Chat room's answers came. */
export interface LlmSummary {
  days: number; t0: number; step: number;
  month: { calls: number; input: number; output: number; tokens: number; cost_usd: number | null;
           unpriced_calls: number; providers: number };
  today: { calls: number; tokens: number; cost_usd: number | null; answers: number };
  answers: { n: number; tps_median: number | null; ttft_ms_median: number | null };
  by_day: { day: string; calls: number; tokens: number; cost_usd: number | null }[];
}

/** A provider's quota window, for the one warning the card may show. */
interface Quota { provider: string; label: string; w: CcWindow; reset: string }

const MODELS_ICON = 'M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM10 10h4v4h-4z';
const CHEVRON_R = 'M10 7l5 5-5 5';

/** Pinned under the Chat room's list: one card for the models, whichever
 *  provider answered - this month's tokens, calls and money, the last 14
 *  days as small bars, today's answers and their median speed, and a
 *  single warning when a provider's quota is nearly used up. Opens LLM
 *  settings, where each provider has its own figures. What it is given
 *  (the Tools card) goes under it, in the same frame. */
@Component({
  selector: 'app-cc-usage-line',
  imports: [CountUp, Skeleton, T, TimeChart],
  styles: [`
    :host { display: block; flex: none; }
    .ccl-wrap { padding: 6px 8px 8px; border-top: 1px solid var(--line); }
    /* One frame: the models, then the Tools card - split by a hairline. */
    .ccl-card { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); }
    .ccl-card > :first-child, :host ::ng-deep .ccl-card > :first-child > button { border-radius: 4px 4px 0 0; }
    :host ::ng-deep .ccl-card > :last-child, :host ::ng-deep .ccl-card > :last-child > button { border-radius: 0 0 4px 4px; }
    :host ::ng-deep .ccl-card > * + * { border-top: 1px solid var(--line); }
    .ccl { display: flex; flex-direction: column; gap: 5px; width: 100%; padding: 7px 8px 8px; text-align: left;
      border: 0; background: none; color: var(--ink); cursor: pointer; font: inherit; }
    .ccl:hover, .ccl:focus-visible { background: var(--hover); outline: none; }
    .ccl-head { display: flex; width: 100%; align-items: center; gap: 6px; font-size: 11px; color: var(--ink-dim); min-width: 0; }
    .ccl-head b { color: var(--ink); font-weight: 600; }
    .ccl-head em { margin-left: auto; font-style: normal; white-space: nowrap; }
    .ccl-head svg { flex: none; width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.7;
      stroke-linecap: round; stroke-linejoin: round; }
    .ccl-head svg:last-child { width: 12px; height: 12px; }
    .ccl-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; width: 100%;
      font: 10.5px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); }
    .ccl-stats > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ccl-stats > span:last-child:not(:first-child) { text-align: right; }
    .ccl-stats b, .ccl-sub b { color: var(--ink); font-weight: 600; }
    .ccl-chart { width: 100%; }
    .ccl-sub { width: 100%; font-size: 10.5px; color: var(--ink-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ccl-warn { display: flex; align-items: center; gap: 6px; width: 100%; font-size: 10.5px; color: var(--warn); min-width: 0; }
    .ccl-warn[data-tone="danger"] { color: var(--danger); }
    .ccl-warn span { flex: none; white-space: nowrap; }
    .ccl-warn i { flex: none; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .ccl-warn em { margin-left: auto; min-width: 0; font-style: normal; color: var(--ink-dim); white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    @media (max-width: 768px) { .ccl { padding: 9px 10px 10px; } }
  `],
  template: `
<div class="ccl-wrap"><div class="ccl-card">
  <button class="ccl" type="button" (click)="openSettings()" [title]="tipText()">
    <div class="ccl-head">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon" /></svg>
      <b>{{ 'Models' | t }}</b><em>{{ 'this month' | t }}</em>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="chevron" /></svg>
    </div>
    @if (sum(); as s) {
      <div class="ccl-stats">
        <span><b [wbCount]="num(s.month.tokens)"></b> tok</span>
        <span><b [wbCount]="s.month.calls.toLocaleString('en-US')"></b> {{ 'calls' | t }}</span>
        <!-- The money only when most calls were priced: a subscription's calls carry none, and a
             sum of the few priced ones would read as the month's cost. -->
        @if (s.month.cost_usd != null && s.month.unpriced_calls * 2 < s.month.calls) { <span><b [wbCount]="shown(s.month.cost_usd)"></b></span> }
        @else { <span><b>{{ s.month.providers }}</b> {{ 'providers' | t }}</span> }
      </div>
      <app-time-chart class="ccl-chart" [data]="chart()!" [bare]="true" [height]="30" [legend]="false" [f]="tokFmt" />
      <div class="ccl-sub">{{ 'Today' | t }} <b>{{ s.today.answers }}</b> {{ 'answers' | t }}
        @if (s.answers.tps_median != null) { · <b>{{ s.answers.tps_median }}</b> tok/s }
        @if (s.answers.ttft_ms_median != null) { · {{ 'first token' | t }} <b>{{ secs(s.answers.ttft_ms_median) }}</b> }
      </div>
    } @else {
      @if (err()) { <div class="ccl-sub">{{ 'The usage did not load' | t }}</div> } @else { <wb-skel kind="mini" /> }
    }
    @if (warn(); as q) {
      <div class="ccl-warn" [attr.data-tone]="tone(q.w)"><i></i>
        <span>{{ q.provider }} · {{ q.label | t }} <b>{{ round(q.w.pct!) }}%</b></span>
        @if (q.reset) { <em>{{ q.reset }}</em> }</div>
    }
  </button>
<ng-content /></div></div>`,
})
export class CcUsageLine implements OnDestroy {
  cc = polling();
  private prefs = inject(Prefs);
  private http = inject(HttpClient);
  sum = signal<LlmSummary | null>(null);
  err = signal(false);
  private timer = (() => { const go = () => this.load(); go(); return setInterval(go, EVERY_MS); })();
  ngOnDestroy() { clearInterval(this.timer); }
  private load() {
    this.http.get<LlmSummary>('/api/llm/summary', { params: { days: 14 } }).subscribe({
      next: s => { this.sum.set(s); this.err.set(false); },
      error: () => this.err.set(true),
    });
  }
  readonly icon = MODELS_ICON;
  readonly chevron = CHEVRON_R;
  readonly tone = tone;
  readonly num = num;
  readonly shown = shown;
  readonly tokFmt = (v: number) => num(v) + ' tok';
  /** Tokens a day, every provider together. */
  chart = computed<TimeData | null>(() => {
    const s = this.sum();
    return s ? { t0: s.t0, step: s.step, n: s.by_day.length, series: [{ name: t('Tokens'), values: s.by_day.map(d => d.tokens) }] } : null;
  });
  /** Every quota a provider shares, fullest first (Command Code's for now). */
  private quotas = computed<Quota[]>(() => {
    const d = this.cc.data(), now = this.cc.now();
    const f = this.cc.fiveHour(), w = this.cc.weekly();
    const at = (x: CcWindow | null) => x?.reset_at ? `${t('resets')} ${inSpan(x.reset_at, now)}` : '';
    const all: Quota[] = [
      { provider: 'Command Code', label: 'weekly', w: w!, reset: d?.weekly_kind === 'rolling' ? weeklyReset(d) : at(w) },
      { provider: 'Command Code', label: '5-hour', w: f!, reset: at(f) },
      { provider: 'Command Code', label: 'monthly', w: this.cc.monthly()!, reset: '' },
    ];
    return all.filter(q => q.w && q.w.pct != null).sort((a, b) => (b.w.pct ?? 0) - (a.w.pct ?? 0));
  });
  /** The tightest quota, when it is 75% used or more. */
  warn = computed(() => { const q = this.quotas()[0]; return q && tone(q.w) ? q : null; });
  tipText = computed(() => {
    const s = this.sum(), lines: string[] = [];
    if (s) {
      const m = s.month;
      lines.push(`${t('All providers, this month')}: ${m.calls.toLocaleString('en-US')} ${t('calls')}, `
        + `${m.tokens.toLocaleString('en-US')} tok (${num(m.input)} ${t('in')}, ${num(m.output)} ${t('out')})`
        + (m.cost_usd != null ? `, ${shown(m.cost_usd)}${usdTip(m.cost_usd) ? ` (${usdTip(m.cost_usd)})` : ''}` : ''));
      if (m.unpriced_calls) lines.push(`${m.unpriced_calls} ${t('calls without a price - the provider does not say')}`);
      lines.push(`${t('Today')}: ${s.today.calls} ${t('calls')}, ${num(s.today.tokens)} tok, ${s.today.answers} ${t('answers')}`);
      if (s.answers.n) lines.push(`${t('Answers in the last 14 days')}: ${s.answers.n}`
        + (s.answers.tps_median != null ? ` · ${t('median')} ${s.answers.tps_median} tok/s` : '')
        + (s.answers.ttft_ms_median != null ? ` · ${t('first token')} ${this.secs(s.answers.ttft_ms_median)}` : ''));
    }
    for (const q of this.quotas()) lines.push(`${q.provider} ${t(q.label)}: ${Math.round(q.w.pct!)}%${q.reset ? ' · ' + q.reset : ''}`);
    lines.push(t('Each provider in LLM settings'));
    return lines.join('\n');
  });
  round(v: number) { return Math.round(v); }
  secs(ms: number) { return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`; }
  openSettings() { this.prefs.open.set('llm'); }
}
