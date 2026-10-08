import { Component, DestroyRef, Injectable, computed, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { LANG, T, t } from './i18n';
import { money as shown } from './money';
import { BarList, Row, TimeChart, TimeData, fmt } from './rooms/charts';
import { CcUsage, CcWindow, day, inSpan, num, pctOf, tone, weeklyReset } from './cc-usage';

/** Each provider's account, compact, inside its card in Settings > LLM
 *  settings (llm-settings.ts draws the card and its header line): a few
 *  meters, a row of tiles, the period's spend per day and who used it -
 *  everything shown, nothing folded. Every figure says whose it is - the provider's own, or
 *  Redline's call log.
 *
 *  The figures live in root services (CcUsage in cc-usage.ts, CcPeriod and
 *  OrUsage here) so the card's header line can show them too. */

// ---------------- Command Code: the billing period ----------------

export interface CcDay { date: string; start: number; credits: number | null; requests: number | null;
                         tokens_in: number | null; tokens_out: number | null; partial: boolean }
export interface CcShareRow { name: string; requests: number; tokens_in: number; tokens_out: number }
export interface CcAnalysis {
  set: boolean; shared: boolean; at?: string;
  period?: { start: number; end: number | null; days_total: number | null; days_left: number | null };
  days?: CcDay[]; days_source?: 'command-code' | 'snapshots' | 'none'; tracked_since?: number | null;
  week?: { credits: number; requests: number | null; per_day: number; source: string } | null;
  projection?: { burn_per_day: number; spent: number; left: number | null; allowance: number | null; days_left: number | null;
                 at_end: number | null; at_end_pct: number | null; runs_out_at: number | null } | null;
  weekly?: (CcWindow & { full_weeks_left: number | null }) | null;
  account_totals?: { requests: number | null; tokens_in: number | null; tokens_out: number | null; credits: number | null };
  redline?: { requests: number; tokens_in: number; tokens_out: number; by_model: CcShareRow[]; by_job: CcShareRow[] } | null;
  others?: { requests: number; tokens_in: number; tokens_out: number } | null;
}

@Injectable({ providedIn: 'root' })
export class CcPeriod {
  private http = inject(HttpClient);
  data = signal<CcAnalysis | null>(null);
  loading = signal(false);
  private at = 0;
  load(refresh = false) {
    if (this.loading() || (!refresh && Date.now() - this.at < 300_000 && this.data())) return;
    this.loading.set(true);
    this.http.get<CcAnalysis>('/api/llm/commandcode/analysis' + (refresh ? '?refresh=1' : '')).subscribe({
      next: d => { this.data.set(d); this.at = Date.now(); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }
}

// ---------------- OpenRouter ----------------

export interface OrAccount {
  set: boolean; shared: boolean; at?: string;
  key?: { label: string | null; usage: number | null; limit: number | null; limit_remaining: number | null;
          limit_reset: string | null; is_free_tier: boolean | null; usage_daily: number | null; usage_weekly: number | null;
          usage_monthly: number | null; rate_limit: { requests: number | null; interval: string | null } | null } | null;
  credits?: { total: number | null; used: number | null; left: number | null } | null;
  answers?: Record<string, number | string | null>;
  redline?: { month: { calls: number; input: number; output: number; cost_usd: number | null };
              days30: { calls: number; input: number; output: number; cost_usd: number | null };
              by_model: { name: string; calls: number; cost_usd: number | null }[] } | null;
}

@Injectable({ providedIn: 'root' })
export class OrUsage {
  private http = inject(HttpClient);
  data = signal<OrAccount | null>(null);
  loading = signal(false);
  err = signal<string | null>(null);
  loadedAt = signal(0);
  private users = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  use(): () => void {
    if (this.users++ === 0) {
      if (Date.now() - this.loadedAt() > 60_000) this.load();
      this.timer = setInterval(() => this.load(), 120_000);
    }
    let done = false;
    return () => { if (!done && --this.users === 0) clearInterval(this.timer); done = true; };
  }
  load(refresh = false) {
    if (this.loading()) return;
    this.loading.set(true);
    this.http.get<OrAccount>('/api/llm/providers/openrouter/account' + (refresh ? '?refresh=1' : '')).subscribe({
      next: d => { this.data.set(d); this.err.set(null); this.loading.set(false); this.loadedAt.set(Date.now()); },
      error: e => { this.err.set(`${t('The account figures did not load')} (${e?.status ?? '?'}).`); this.loading.set(false); },
    });
  }
}

/** A meter row: label · bar · used / cap · % · note. */
export interface MeterRow { id: string; label: string; usedA: string; usedB: string; pct: number | null; bar: number;
                            tone: string | null; note: string; title?: string }

const count = (v: number | null | undefined) => v == null ? '–' : fmt.count(v);
const money = (v: number | null | undefined) => v == null ? '–' : shown(v);

/** The meters as readable blocks, side by side on a wide screen. */
@Component({
  selector: 'app-pv-meters',
  imports: [T],
  styleUrl: './settings.css',
  template: `
<div class="cc-meters">
  @for (m of rows(); track m.id) {
    <div class="cc-meter" [attr.data-tone]="m.tone" [title]="m.title || ''">
      <span>{{ m.label | t }}</span>
      <b>{{ m.usedA }} <span class="st-dim">/ {{ m.usedB }}</span><em>{{ m.pct == null ? '' : m.pct + '%' }}</em></b>
      <div class="st-meter" [attr.data-tone]="m.tone"><i [style.width.%]="m.bar"></i></div>
      <small>{{ m.note }}</small>
    </div>
  }
</div>`,
})
export class PvMeters {
  rows = input.required<MeterRow[]>();
}

/** Command Code, inside its card: the windows, a row of tiles, spend per day and who used it. */
@Component({
  selector: 'app-cc-compact',
  imports: [T, PvMeters, TimeChart, BarList],
  styleUrl: './settings.css',
  template: `
@if (cc.data(); as d) {
  @if (!d.shared) {
    <p class="pv-line">{{ 'Command Code didn\\'t share usage' | t }} - {{ 'its account endpoints are undocumented and did not answer for this key' | t }}</p>
  } @else {
    @if (d.stale) { <p class="pv-line" data-tone="warn">{{ 'Command Code did not answer - these are the last figures it gave' | t }}</p> }
    <app-pv-meters [rows]="meters()" />
    <div class="st-tiles tight">
      @for (x of tiles(); track x.label) {
        <div class="st-tile" [attr.data-tone]="x.tone ?? null" [title]="x.title ?? ''"><span>{{ x.label | t }}</span><b>{{ x.value }}</b><small>{{ x.sub }}</small></div>
      }
    </div>
    @if (p.data(); as a) {
      <div class="st-charts">
        @if (chart(); as c) {
          <section class="st-chart c8"><h4>{{ 'Spend per day' | t }}<em>{{ num(a.projection?.spent ?? null) }}</em></h4>
            <app-time-chart [data]="c" kind="bar" [f]="numF" [height]="170" [legend]="false" />
            <p class="pv-src">{{ daysNote(a) }}</p>
          </section>
        }
        <section class="st-chart c4"><h4>{{ 'Requests this period' | t }}<em>{{ count(a.account_totals?.requests) }}</em></h4>
          <app-bar-list [rows]="shareRows(a)" [f]="count" />
        </section>
        @if (a.redline; as r) {
          <section class="st-chart"><h4>{{ 'Who used the account' | t }}</h4>
            <div class="st-table-wrap"><table class="st-table">
              <thead><tr><th></th><th class="r">{{ 'requests' | t }}</th><th class="r">{{ 'tokens in' | t }}</th><th class="r">{{ 'tokens out' | t }}</th></tr></thead>
              <tbody>
                <tr><td><b>{{ 'Command Code, all' | t }}</b></td><td class="r mono">{{ count(a.account_totals?.requests) }}</td>
                  <td class="r mono">{{ count(a.account_totals?.tokens_in) }}</td><td class="r mono">{{ count(a.account_totals?.tokens_out) }}</td></tr>
                <tr><td [title]="jobsText(r)">Redline</td><td class="r mono">{{ count(r.requests) }}</td><td class="r mono">{{ count(r.tokens_in) }}</td>
                  <td class="r mono">{{ count(r.tokens_out) }}</td></tr>
                @if (a.others; as o) {
                  <tr><td>{{ 'Other clients (Claude Code CLI, agents)' | t }}</td><td class="r mono">{{ count(o.requests) }}</td>
                    <td class="r mono">{{ count(o.tokens_in) }}</td><td class="r mono">{{ count(o.tokens_out) }}</td></tr>
                }
              </tbody>
            </table></div>
            <p class="pv-src">{{ 'Command Code, all: its own totals. Redline: its own call log, by model and job. Other clients: the difference. Command Code does not say which model spent what.' | t }}</p>
          </section>
        }
      </div>
    }
  }
} @else if (cc.err()) {
  <p class="st-err">{{ cc.err() }}</p>
} @else {
  <div class="cc-skel" aria-busy="true">
    @for (i of [1, 2, 3]; track i) { <span class="sk"></span> }
    <span class="sk" style="width: 70%"></span>
    <span class="sk sk-chart" style="height: 90px"></span>
  </div>
}`,
})
export class CcCompact {
  cc = inject(CcUsage);
  p = inject(CcPeriod);
  readonly count = count;
  readonly weeklyReset = weeklyReset;
  constructor() {
    inject(DestroyRef).onDestroy(this.cc.use());
    this.p.load();
  }
  meters = computed<MeterRow[]>(() => {
    const d = this.cc.data(), now = this.cc.now();
    const row = (id: string, label: string, w: CcWindow | null | undefined, note: string, title = ''): MeterRow | null =>
      w ? { id, label, usedA: num(w.used), usedB: w.cap == null ? '?' : num(w.cap),
            pct: w.pct == null ? null : Math.round(w.pct), bar: pctOf(w), tone: tone(w), note, title } : null;
    const f = d?.windows?.five_hour, w = d?.windows?.weekly, m = d?.windows?.monthly;
    return [
      row('five', '5-hour window', f, f?.reset_at ? `${t('resets')} ${inSpan(f.reset_at, now)}` : ''),
      row('week', 'Weekly window', w, w?.reset_at ? weeklyReset(d) : ''),
      row('month', 'Month (billing period)', m, d?.plan?.period_end ? `${d.plan.cancel_at_period_end ? t('ends') : t('renews')} ${day(d.plan.period_end)}` : '',
          t('Spent this period of the monthly credits, against spent + what Command Code says is left - as Command Code reports')),
    ].filter((x): x is MeterRow => !!x);
  });
  readonly num = num;
  readonly numF = (v: number) => num(v);
  tiles = computed(() => {
    const d = this.cc.data(), a = this.p.data(), u = d?.usage, pr = a?.projection, tr = LANG() === 'tr';
    const out: { label: string; value: string; sub: string; tone?: string | null; title?: string }[] = [
      { label: 'Spent this period', value: num(u?.credits), sub: t('credits, as Command Code reports') },
      { label: 'Left', value: num(d?.credits?.monthly_left), sub: t('monthly credits'), tone: d?.credits?.below_threshold ? 'warn' : null },
      { label: 'Requests', value: u?.requests == null ? '–' : u.requests.toLocaleString('en-US'),
        sub: u?.success_pct == null ? '' : `${u.success_pct}% ${t('succeeded')}` },
      { label: 'Tokens in', value: count(u?.tokens_in), sub: `${t('out')} ${count(u?.tokens_out)} · ${num(u?.cost_avg)} ${t('per request')}` },
    ];
    if (pr) {
      const end = a?.period?.end;
      const pct = pr.at_end_pct != null ? Math.round(pr.at_end_pct) : null;
      out.push({ label: 'Burn rate', value: `${num(pr.burn_per_day)} / ${t('day')}`, title: t('Credits spent in the last 7 days, divided by 7'),
                 tone: pr.runs_out_at ? 'danger' : (pct ?? 0) >= 90 ? 'warn' : null,
                 sub: pr.runs_out_at ? `${t('runs out')} ${day(pr.runs_out_at)}`
                   : tr ? `${end ? day(end) + ' itibarıyla ' : ''}~%${pct ?? '?'}` : `~${pct ?? '?'}%${end ? ' by ' + day(end) : ''}` });
    }
    return out;
  });
  /** The days as bars, one a day from the period's first. */
  chart = computed<TimeData | null>(() => {
    const days = this.p.data()?.days ?? [];
    if (!days.length) return null;
    return { t0: Math.floor(days[0].start / 1000), step: 86400, n: days.length,
             series: [{ name: t('credits'), values: days.map(d => d.credits) }] };
  });
  jobsText(r: NonNullable<CcAnalysis['redline']>) { return r.by_job.map(j => `${t(j.name)}: ${j.requests}`).join('\n'); }
  daysNote(a: CcAnalysis): string {
    const src = a.days_source === 'command-code' ? t('Command Code\'s own totals, a day at a time (Istanbul days); today so far.')
      : a.days_source === 'snapshots' ? t('From Redline\'s own readings of the account - tracked since') + ' ' + day(a.tracked_since)
      : t('Command Code shared no day-by-day figures.');
    return src;
  }
  shareRows(a: CcAnalysis): Row[] {
    const rows: Row[] = (a.redline?.by_model ?? []).map(m => ({ name: 'Redline · ' + m.name, value: m.requests }));
    if (a.others) rows.push({ name: t('Other clients (Claude Code CLI, agents)'), value: a.others.requests });
    return rows.filter(r => r.value > 0).sort((x, y) => y.value - x.value);
  }
}

/** OpenRouter, inside its card: credits and the key as meters, a row of tiles, Redline's calls by model. */
@Component({
  selector: 'app-or-compact',
  imports: [T, PvMeters, BarList],
  styleUrl: './settings.css',
  template: `
@if (o.data(); as d) {
  @if (!d.shared) {
    <p class="pv-line">{{ 'OpenRouter did not share the account' | t }}@if (d.answers; as a) { ({{ a['key'] }}) }</p>
  } @else {
    <app-pv-meters [rows]="meters()" />
    <div class="st-tiles tight">
      @for (x of tiles(); track x.label) {
        <div class="st-tile" [attr.data-tone]="x.tone ?? null"><span>{{ x.label | t }}</span><b>{{ x.value }}</b><small>{{ x.sub }}</small></div>
      }
    </div>
    <section class="st-chart"><h4>{{ 'Redline\\'s calls by model, 30 days' | t }}<em>{{ money(o.data()?.redline?.days30?.cost_usd) }}</em></h4>
      @if (modelRows().length) { <app-bar-list [rows]="modelRows()" [f]="money" /> }
      @else { <p class="pv-src">{{ 'No calls by Redline in 30 days.' | t }}</p> }
      <p class="pv-src">{{ 'Credits and the key: as OpenRouter reports (GET /key, /credits). Redline: its own call log - OpenRouter prices every call.' | t }}</p>
    </section>
  }
} @else if (o.err()) {
  <p class="st-err">{{ o.err() }}</p>
} @else {
  <div class="cc-skel" aria-busy="true"><span class="sk"></span><span class="sk"></span><span class="sk" style="width: 70%"></span></div>
}`,
})
export class OrCompact {
  o = inject(OrUsage);
  readonly money = money;
  constructor() { inject(DestroyRef).onDestroy(this.o.use()); }
  meters = computed<MeterRow[]>(() => {
    const d = this.o.data(), out: MeterRow[] = [];
    const pc = (u: number | null | undefined, c: number | null | undefined) => u == null || !c ? null : Math.round(100 * u / c);
    const tn = (p: number | null) => p == null ? null : p >= 90 ? 'danger' : p >= 75 ? 'warn' : null;
    const c = d?.credits;
    if (c) {
      const p = pc(c.used, c.total);
      out.push({ id: 'credits', label: 'Account credits', usedA: money(c.used), usedB: money(c.total), pct: p, bar: Math.min(100, p ?? 0),
                 tone: tn(p), note: `${money(c.left)} ${t('left')}`, title: t('bought in total, as OpenRouter reports') });
    }
    const k = d?.key;
    if (k) {
      const p = pc(k.usage, k.limit);
      out.push({ id: 'key', label: 'This key', usedA: money(k.usage), usedB: k.limit == null ? t('no limit') : money(k.limit),
                 pct: p, bar: Math.min(100, p ?? 0), tone: tn(p),
                 note: k.limit_remaining != null ? `${money(k.limit_remaining)} ${t('left')}${k.limit_reset ? ' · ' + t('resets') + ' ' + t(k.limit_reset) : ''}` : '' });
    }
    return out;
  });
  tiles = computed(() => {
    const d = this.o.data(), k = d?.key, r = d?.redline, rl = k?.rate_limit;
    const out: { label: string; value: string; sub: string; tone?: string | null }[] = [];
    if (k) {
      out.push({ label: 'Key, today', value: money(k.usage_daily), sub: t('as OpenRouter reports') });
      out.push({ label: 'Key, this month', value: money(k.usage_monthly), sub: `${money(k.usage_weekly)} ${t('this week')}` });
    }
    if (r) {
      out.push({ label: 'Redline, this month', value: money(r.month.cost_usd), sub: `${r.month.calls} ${t('calls')} · ${t('its own call log')}` });
      out.push({ label: 'Redline, 30 days', value: money(r.days30.cost_usd), sub: `${r.days30.calls} ${t('calls')} · ${count(r.days30.input + r.days30.output)} ${t('tokens')}` });
    }
    if (rl) out.push({ label: 'Rate limit', value: rl.requests == null || rl.requests < 0 ? t('none') : String(rl.requests),
                       sub: `${t('per')} ${rl.interval || '–'}`, tone: 'dim' });
    return out;
  });
  modelRows = computed<Row[]>(() => (this.o.data()?.redline?.by_model ?? [])
    .map(m => ({ name: m.name, value: m.cost_usd ?? 0, sub: m.calls + ' ' + t('calls') })).filter(r => r.value > 0));
}

