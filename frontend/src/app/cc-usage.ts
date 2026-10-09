import { Component, DestroyRef, ElementRef, Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { LANG, T, t } from './i18n';
import { Prefs } from './preferences';
import { CcTabWindow, TopBar } from './topbar';

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

/** Pinned under the Chat room's list: the windows as small meters, when
 *  they reset and when the plan renews. Opens LLM settings. */
@Component({
  selector: 'app-cc-usage-line',
  imports: [T],
  styles: [`
    :host { display: block; flex: none; }
    .ccl-wrap { padding: 6px 8px 8px; border-top: 1px solid var(--line); }
    .ccl { display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 6px 8px; text-align: left;
      border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--ink); cursor: pointer; }
    .ccl:hover, .ccl:focus-visible { background: var(--hover); outline: none; }
    .ccl-head { display: flex; width: 100%; align-items: baseline; gap: 6px; font-size: 11px; color: var(--ink-dim); min-width: 0; }
    .ccl-head b { color: var(--ink); font-weight: 600; }
    .ccl-head span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ccl-head em { margin-left: auto; font-style: normal; white-space: nowrap; }
    .ccl-row { display: grid; width: 100%; grid-template-columns: 52px minmax(0, 1fr) auto; align-items: center; gap: 6px;
      font: 10.5px 'IBM Plex Mono', ui-monospace, monospace; color: var(--ink-dim); }
    .ccl-row > b { font-weight: 600; color: var(--ink); }
    .ccl-bar { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
    .ccl-bar > i { display: block; height: 100%; background: var(--accent); }
    .ccl-bar[data-tone="warn"] > i { background: var(--warn); }
    .ccl-bar[data-tone="danger"] > i { background: var(--danger); }
    .ccl-row[data-tone="warn"] > b { color: var(--warn); }
    .ccl-row[data-tone="danger"] > b { color: var(--danger); }
    .ccl-sub { font-size: 10px; color: var(--ink-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `],
  template: `
@if (cc.data(); as d) { @if (d.shared && (cc.weekly() || cc.fiveHour() || cc.monthly())) {
  <div class="ccl-wrap"><button class="ccl" type="button" (click)="openSettings()" [title]="tipText()">
    <div class="ccl-head"><b>Command Code</b><span>{{ d.plan?.name || '' }}</span>
      @if (d.plan?.period_end; as end) { <em>{{ (d.plan?.cancel_at_period_end ? 'ends' : 'renews') | t }} {{ inSpan(end, cc.now()) }}</em> }</div>
    @for (r of rows(); track r.id) {
      <div class="ccl-row" [attr.data-tone]="tone(r.w)"><span>{{ r.label | t }}</span>
        <div class="ccl-bar" [attr.data-tone]="tone(r.w)"><i [style.width.%]="pct(r.w)"></i></div>
        <b>{{ r.w.pct != null ? round(r.w.pct) + '%' : num(r.w.used) }}</b></div>
    }
    <div class="ccl-sub">
      @if (cc.fiveHour(); as f) { {{ '5-hour' | t }} {{ 'resets' | t }} {{ inSpan(f.reset_at, cc.now()) }} }
      @if (cc.weekly()) { · {{ 'weekly' | t }} {{ weeklyReset(d) }} }
    </div>
  </button></div>
} }`,
})
export class CcUsageLine {
  cc = polling();
  private prefs = inject(Prefs);
  readonly tone = tone;
  readonly pct = pctOf;
  readonly num = num;
  readonly inSpan = inSpan;
  readonly localTime = localTime;
  readonly weeklyReset = weeklyReset;
  rows = computed(() => [
    { id: 'weekly', label: 'weekly', w: this.cc.weekly() },
    { id: 'five', label: '5-hour', w: this.cc.fiveHour() },
    { id: 'monthly', label: 'monthly', w: this.cc.monthly() },
  ].filter(r => r.w) as { id: string; label: string; w: CcWindow }[]);
  tipText = computed(() => tip(this.cc.data(), this.cc.now()));
  round(v: number) { return Math.round(v); }
  openSettings() { this.prefs.open.set('llm'); }
}
