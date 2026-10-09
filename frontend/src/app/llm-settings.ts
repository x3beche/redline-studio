import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Auth } from './auth';
import { T, t } from './i18n';
import { money as shown } from './money';
import type { LlmModel } from './rooms/commandcode';
import { BarList, Row, TimeChart, TimeData, fmt } from './rooms/charts';
import { CcUsage, day, inSpan, span } from './cc-usage';
import { CcCompact, CcPeriod, OrCompact, OrUsage } from './provider-usage';
import { SuggestConf } from './rooms/suggest';

/** Settings > LLM settings: the API keys, and which provider and model
 *  does each of the app's model jobs (backend/llm.py), and what the
 *  providers were used for (LlmUsagePanel, under them).
 *
 *  A key goes one way: typed here, kept in the database, never shown again -
 *  the page only learns whether one is set and its last four characters.
 *  This is the only place a key comes from: the server never reads one
 *  from .env or the environment.
 *  Changing anything is for the owner and the admins.
 */
interface ProviderInfo { name: string; set: boolean; hint: string | null; source: string | null; site: string }
interface JobInfo {
  label: string; about: string; provider: string; model: string;
  default: { provider: string; model: string };
  /** A job with an on/off of its own (the next-question suggestion): whether
   *  it runs, and the seconds of quiet before it does (backend/llm.py). */
  switch?: boolean; on?: boolean; delay?: number; delay_range?: [number, number];
}
/** The next-question suggestion's waits on offer, in seconds. */
const DELAYS = [15, 30, 60, 120, 300];
/** One provider as the page draws it (backend/llm.py REGISTRY): adding a
 *  provider is an entry there, and an account block below if it has one. */
interface ProviderEntry { id: string; name: string; site: string; priced: boolean; about: string; account: boolean; analysis: boolean }
interface LlmSettings { providers: Record<string, ProviderInfo>; jobs: Record<string, JobInfo>; registry?: ProviderEntry[] }

interface UsageRow { name: string; calls: number; input: number; output: number; cost_usd: number | null }
interface LlmUsage {
  provider: string; days: number; step: number;
  totals: { calls: number; input: number; output: number; cost_usd: number | null; unpriced_calls: number };
  /** Providers that send no prices at all (Command Code): their calls stay unpriced. */
  unpriced_providers: string[];
  calls: TimeData; tokens: TimeData; cost: TimeData;
  by_model: UsageRow[]; by_kind: UsageRow[]; by_provider: UsageRow[];
  /** `job` is the kind named as in "Which model does what". */
  recent: { at: string | number; provider: string; kind: string; job: string; model: string;
            input: number; output: number; cost_usd: number | null }[];
  account: null | { label: string; usage: number; limit: number | null; limit_remaining: number | null; is_free_tier: boolean };
}

const PROVIDERS = ['commandcode', 'openrouter'];
/** The usage panel's switch: both providers together first, so the latest
 *  calls show whichever provider the jobs are on. */
const USAGE_PROVIDERS = ['all', ...PROVIDERS];
const PERIODS = [{ days: 1, label: '24h' }, { days: 7, label: '7d' }, { days: 30, label: '30d' }];

function load<V>(key: string, fallback: V): V {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
}
function keep(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private window */ }
}

/** When a call or a lookup happened, short: "6 Oct 14:22". */
export function when(at: string | number | null | undefined): string {
  if (at == null || at === '') return '–';
  // A time with no zone is the server's UTC.
  const d = typeof at === 'number' ? new Date(at < 1e12 ? at * 1000 : at)
    : new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(at) || !at.includes('T') ? at : at + 'Z');
  if (isNaN(d.getTime())) return String(at);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** What one provider was used for: totals, the account where the provider
 *  tells, calls by job, tokens, spend by model, and the latest calls. */
@Component({
  selector: 'app-llm-usage',
  imports: [T, TimeChart, BarList],
  styleUrl: './settings.css',
  template: `
<div class="st-card">
  <div class="st-card-head">
    <h3>{{ 'Usage' | t }}</h3>
    <span class="st-sub">{{ 'every call Redline made, from its own journal' | t }}</span>
    <div class="st-right">
      <div class="st-seg">
        @for (p of providers; track p) {
          <button [class.on]="provider() === p" (click)="setProvider(p)">{{ p === 'all' ? ('All' | t) : (names()[p] || p) }}</button>
        }
      </div>
      <div class="st-seg">
        @for (x of periods; track x.days) {
          <button [class.on]="days() === x.days" (click)="setDays(x.days)">{{ x.label }}</button>
        }
      </div>
    </div>
  </div>
  <div class="st-card-body">
    @if (u(); as d) {
      <div class="st-tiles tight">
        <div class="st-tile"><span>{{ 'Calls' | t }}</span><b>{{ f.count(d.totals.calls) }}</b>
          <small>{{ perDay(d.totals.calls) }} {{ 'a day' | t }}</small></div>
        <div class="st-tile"><span>{{ 'Input tokens' | t }}</span><b>{{ f.count(d.totals.input) }}</b>
          <small>{{ d.totals.calls ? perCall(d.totals.input, d.totals.calls) : '–' }} {{ 'per call' | t }}</small></div>
        <div class="st-tile"><span>{{ 'Output tokens' | t }}</span><b>{{ f.count(d.totals.output) }}</b>
          <small>{{ d.totals.calls ? perCall(d.totals.output, d.totals.calls) : '–' }} {{ 'per call' | t }}</small></div>
        @if (d.totals.cost_usd == null) {
          <div class="st-tile" data-tone="dim" style="grid-column: span 2"><span>{{ 'Spend' | t }}</span><b>{{ 'not priced by the provider' | t }}</b>
            <small>{{ d.unpriced_providers.length ? d.unpriced_providers.join(', ') + ' ' + ('sends token counts, no prices' | t) : '–' }}</small></div>
        } @else {
          <div class="st-tile" [style.grid-column]="d.totals.unpriced_calls ? 'span 2' : null"><span>{{ 'Spend' | t }}</span><b>{{ money(d.totals.cost_usd) }}</b>
            <small [title]="d.unpriced_providers.join(', ')">{{ d.totals.unpriced_calls ? d.totals.unpriced_calls + ' ' + ('calls not priced by the provider' | t) + (d.unpriced_providers.length ? ' (' + d.unpriced_providers.join(', ') + ')' : '')
                     : (d.totals.calls ? money(d.totals.cost_usd / d.totals.calls) + ' ' + ('per call' | t) : '–') }}</small></div>
        }
        @if (d.account; as a) {
          <div class="st-tile hero">
            <span>{{ 'OpenRouter account' | t }}@if (a.label) { · <span class="mono">{{ a.label }}</span> }{{ a.is_free_tier ? ' · ' + ('free tier' | t) : '' }}</span>
            <b>{{ money(a.usage) }} <span class="st-dim" style="font-size: 12px">/ {{ a.limit == null ? ('no limit' | t) : money(a.limit) }}</span></b>
            @if (a.limit) {
              <div class="st-meter" [attr.data-tone]="usedPct(a) > 80 ? 'warn' : null"><i [style.width.%]="usedPct(a)"></i></div>
            }
            <small>{{ a.limit_remaining == null ? '' : money(a.limit_remaining) + ' ' + ('left on the key' | t) }}</small>
          </div>
        }
      </div>

      @if (d.totals.calls) {
        <div class="st-charts">
          <section class="st-chart c8"><h4>{{ 'Calls by job' | t }}<em>{{ d.totals.calls }}</em></h4>
            <app-time-chart [data]="d.calls" kind="bar" [f]="f.count" [height]="170" /></section>
          <section class="st-chart c4"><h4>{{ 'By job' | t }}</h4>
            <app-bar-list [rows]="rows(d.by_kind, 'calls')" [f]="f.count" /></section>
          <section class="st-chart c8"><h4>{{ 'Tokens' | t }}<em>{{ f.count(d.totals.input + d.totals.output) }}</em></h4>
            <app-time-chart [data]="d.tokens" kind="area" [f]="f.count" [height]="150" /></section>
          <section class="st-chart c4"><h4>{{ 'By model' | t }}</h4>
            <app-bar-list [rows]="rows(d.by_model, 'calls')" [f]="f.count" /></section>
          @if (provider() === 'all') {
            <section class="st-chart c6"><h4>{{ 'Calls by provider' | t }}</h4>
              <app-bar-list [rows]="rows(d.by_provider, 'calls')" [f]="f.count" /></section>
            <section class="st-chart c6"><h4>{{ 'Tokens by provider' | t }}</h4>
              <app-bar-list [rows]="rows(d.by_provider, 'tokens')" [f]="f.count" /></section>
          }
          @if (priced(d)) {
            <section class="st-chart c8"><h4>{{ 'Spend by model' | t }}<em>{{ money(d.totals.cost_usd) }}</em></h4>
              <app-time-chart [data]="d.cost" kind="bar" [f]="money" [height]="150" /></section>
            <section class="st-chart c4"><h4>{{ 'Spend by job' | t }}</h4>
              <app-bar-list [rows]="rows(d.by_kind, 'cost_usd')" [f]="money" /></section>
          }
          <section class="st-chart"><h4>{{ 'Latest calls' | t }}<em>{{ d.recent.length }}</em></h4>
            <div class="st-table-wrap">
              <table class="st-table">
                <thead><tr><th>{{ 'when' | t }}</th><th>{{ 'job' | t }}</th>
                  @if (provider() === 'all') { <th>{{ 'provider' | t }}</th> }<th>{{ 'model' | t }}</th>
                  <th class="r">{{ 'in' | t }}</th><th class="r">{{ 'out' | t }}</th><th class="r">{{ 'spend' | t }}</th></tr></thead>
                <tbody>
                  @for (r of allRecent() ? d.recent : d.recent.slice(0, 8); track $index) {
                    <tr><td class="dim mono">{{ when(r.at) }}</td><td><span class="st-tag" [title]="r.kind">{{ (r.job || r.kind) | t }}</span></td>
                      @if (provider() === 'all') { <td class="dim">{{ r.provider }}</td> }
                      <td class="mono give" [title]="r.model">{{ r.model }}</td><td class="r mono">{{ f.count(r.input) }}</td>
                      <td class="r mono">{{ f.count(r.output) }}</td>
                      <td class="r mono" [class.dim]="r.cost_usd == null">{{ money(r.cost_usd) }}</td></tr>
                  }
                </tbody>
              </table>
            </div>
            @if (d.recent.length > 8) {
              <button class="st-more" (click)="allRecent.set(!allRecent())">{{ (allRecent() ? 'Show fewer' : 'Show all') | t }}{{ allRecent() ? '' : ' ' + d.recent.length }}</button>
            }
          </section>
        </div>
      } @else {
        <div class="st-empty">{{ (provider() === 'all' ? 'No model calls in this period.' : 'No calls to this provider in this period.') | t }}</div>
      }
    } @else if (err()) {
      <p class="st-err">{{ err() }}</p>
    } @else {
      <div class="st-empty">{{ 'Loading…' | t }}</div>
    }
  </div>
</div>`,
})
export class LlmUsagePanel {
  private http = inject(HttpClient);
  readonly f = fmt;
  readonly when = when;
  readonly providers = USAGE_PROVIDERS;
  readonly periods = PERIODS;
  /** Display names. */
  names = signal<Record<string, string>>({ commandcode: 'Command Code', openrouter: 'OpenRouter' });
  // A new key: the old one remembered OpenRouter for everyone, which hid
  // the calls the jobs now make on Command Code.
  provider = signal<string>(USAGE_PROVIDERS.includes(load('redline.settings.llm.usage', 'all'))
    ? load('redline.settings.llm.usage', 'all') : 'all');
  days = signal<number>(load('redline.settings.llm.days', 30));
  u = signal<LlmUsage | null>(null);
  allRecent = signal(false);
  err = signal<string | null>(null);

  constructor() {
    effect(() => {
      const p = this.provider(), d = this.days();
      this.u.set(null);
      this.err.set(null);
      this.http.get<LlmUsage>(`/api/llm/usage?provider=${p}&days=${d}`).subscribe({
        next: r => {
          if (this.provider() !== p || this.days() !== d) return;
          // The calls chart's series are job names, in English from the server.
          r.calls = { ...r.calls, series: r.calls.series.map(s => ({ ...s, name: t(s.name) })) };
          this.u.set(r);
        },
        error: e => this.err.set(t('The usage figures did not load') + ` (${e?.status ?? '?'}).`),
      });
    });
  }

  setProvider(p: string) { this.provider.set(p); keep('redline.settings.llm.usage', p); }
  setDays(d: number) { this.days.set(d); keep('redline.settings.llm.days', d); }
  perCall(n: number, calls: number) { return fmt.count(Math.round(n / calls)); }
  perDay(n: number) { return fmt.count(n / Math.max(1, this.days())); }
  /** Dollars from the server in the display currency, a tiny amount still as a figure. */
  money = (v: number | null | undefined): string => v == null ? '–' : shown(v);
  usedPct(a: NonNullable<LlmUsage['account']>) { return a.limit ? Math.min(100, 100 * a.usage / a.limit) : 0; }
  priced(d: LlmUsage) { return d.totals.cost_usd != null && d.totals.cost_usd > 0; }
  rows(list: UsageRow[], key: 'calls' | 'cost_usd' | 'tokens'): Row[] {
    // Job names come from the server in English, like the job list above.
    return list.map(r => ({ name: t(r.name), value: key === 'tokens' ? r.input + r.output : (r[key] ?? 0) }))
      .filter(r => r.value > 0).sort((a, b) => b.value - a.value);
  }
}

@Component({
  selector: 'app-llm-settings',
  imports: [T, LlmUsagePanel, CcCompact, OrCompact],
  styleUrl: './settings.css',
  template: `
@if (data(); as d) {
<div class="st-page">
  <p class="st-lead">{{ 'Which model does what in Redline, and the keys it uses. The keys stay on the server: once saved, only their last four characters are shown.' | t }}</p>
  @if (!canEdit) { <div class="st-banner">{{ 'These are the server\\'s settings: only the owner and the admins can change them.' | t }}</div> }

  <div class="st-tiles">
    <div class="st-tile" [attr.data-tone]="keyCount() === providerIds.length ? 'ok' : 'warn'"><span>{{ 'API keys' | t }}</span>
      <b>{{ keyCount() }} / {{ providerIds.length }}</b><small>{{ 'set' | t }}</small></div>
    <div class="st-tile"><span>{{ 'Jobs' | t }}</span><b>{{ jobIds().length }}</b>
      <small>{{ custom() }} {{ 'changed from the default' | t }}</small></div>
    @for (p of providerIds; track p) {
      <div class="st-tile"><span>{{ d.providers[p].name }}</span><b>{{ jobsOn(p) }}</b>
        <small [title]="visionCount(p) + ' ' + ('read images' | t)">{{ 'jobs on it' | t }} · {{ (models()[p] || []).length }} {{ 'models' | t }} · 🖼 {{ visionCount(p) }}</small></div>
    }
  </div>

  <!-- Each provider on its own card (backend/llm.py REGISTRY): one header
       line, its account as the provider tells it, Details and the key
       folded. A provider with a key is open; one without, one line. -->
  @for (pv of registry(); track pv.id) {
    @if (d.providers[pv.id]; as info) {
      <section class="st-card pv" [attr.data-open]="isOpen(pv.id) ? 1 : null">
        <div class="pv-head">
          <button type="button" class="pv-toggle" (click)="toggle(pv.id)" [attr.aria-expanded]="isOpen(pv.id)"
                  [attr.aria-label]="(isOpen(pv.id) ? 'Collapse' : 'Expand') | t">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="isOpen(pv.id) ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'" /></svg>
            <h3>{{ pv.name }}</h3>
          </button>
          @if (info.set) {
            <span class="pv-key-hint" [title]="'API key saved here' | t"><i></i>{{ info.hint }}</span>
            @switch (pv.id) {
              @case ('commandcode') {
                @if (cc.data()?.plan; as p) {
                  <span class="pv-plan">{{ p.name || p.id }}@if (p.status) { <em [attr.data-tone]="p.status === 'active' ? 'ok' : 'warn'">{{ p.status | t }}</em> }</span>
                  @if (p.period_end) { <span class="pv-meta">{{ (p.cancel_at_period_end ? 'ends' : 'renews') | t }} {{ day(p.period_end) }} ({{ daysTo(p.period_end) }})</span> }
                }
              }
              @case ('openrouter') {
                @if (or.data()?.credits; as c) { <span class="pv-meta">{{ money(c.left) }} {{ 'credits left' | t }}</span> }
                @if (or.data()?.key?.is_free_tier) { <span class="pv-meta">{{ 'free tier' | t }}</span> }
              }
            }
          } @else {
            <span class="pv-meta" data-tone="warn">{{ 'no key' | t }}</span>
          }
          <span class="pv-right">
            @if (info.set) {
              @if (loadedAt(pv.id); as at) { <span class="pv-meta" [title]="('updated' | t) + ' ' + ago(at)">{{ ago(at) }}</span> }
              <button type="button" class="pv-icon" [disabled]="loading(pv.id)" (click)="refresh(pv.id)" [title]="'Ask the provider again' | t"
                      [attr.aria-label]="'Refresh' | t"><svg viewBox="0 0 24 24" aria-hidden="true" [class.pv-spin]="loading(pv.id)"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4.5h-4.5" /></svg></button>
            } @else if (!isOpen(pv.id) && canEdit) {
              <button class="tcv-btn tcv-files-btn" (click)="toggle(pv.id)">{{ 'Add a key' | t }}</button>
            }
            <a class="st-link" [href]="info.site" target="_blank" rel="noopener">{{ 'get a key' | t }} ↗</a>
          </span>
        </div>
        @if (isOpen(pv.id)) {
          <div class="pv-body">
            @if (info.set) {
              @switch (pv.id) {
                @case ('commandcode') { <app-cc-compact /> }
                @case ('openrouter') { <app-or-compact /> }
              }
            } @else {
              <p class="pv-line">{{ pv.about | t }} - {{ 'add a key below and its usage shows here.' | t }}</p>
            }
            <!-- The key and the jobs on this provider, at the foot of its card. -->
            <div class="pv-keysec">
              <div class="pv-keyrow">
                <span class="pv-src">{{ 'API key' | t }}</span>
                <span class="pv-meta">{{ info.set ? ('set' | t) + ' ' + info.hint : ('no key' | t) }} · {{ (models()[pv.id] || []).length }} {{ 'models' | t }} · 🖼 {{ visionCount(pv.id) }}</span>
                @if (canEdit) {
                  <input class="st-in wide" type="password" autocomplete="off" [placeholder]="(info.set ? 'Replace the key' : 'Paste the API key') | t"
                         [value]="draft()[pv.id] || ''" (input)="setDraft(pv.id, $any($event.target).value)" (keydown.enter)="saveKey(pv.id)">
                  <button class="tcv-btn tcv-files-btn" [disabled]="!draft()[pv.id]?.trim() || busy()" (click)="saveKey(pv.id)">{{ 'Save' | t }}</button>
                  @if (info.set) {
                    <button class="tcv-btn tcv-files-btn" [disabled]="busy()" (click)="clearKey(pv.id)"
                            [title]="'Remove this key; the jobs on this provider stop until a new one is saved' | t">{{ 'Remove' | t }}</button>
                  }
                } @else {
                  <span class="pv-src">{{ 'only the owner and the admins can change a key' | t }}</span>
                }
              </div>
              <div class="pv-jobs"><span class="pv-src">{{ 'Used for' | t }}</span>
                @for (j of jobsOf(pv.id); track j) { <span class="st-tag">{{ j | t }}</span> }
                @empty { <span class="pv-src">{{ 'no job yet - pick it under "Which model does what"' | t }}</span> }
              </div>
            </div>
          </div>
        }
      </section>
    }
  }

  <div class="st-card">
    <div class="st-card-head"><h3>{{ 'Which model does what' | t }}</h3>
      <span class="st-sub">{{ 'a provider and a model for each job' | t }}</span></div>
    <div class="st-jobs">
      @for (j of jobIds(); track j) {
        @if (d.jobs[j]; as job) {
          <div class="st-job">
            <div class="st-job-name"><b>{{ job.label | t }}</b><span [title]="job.about | t">{{ job.about | t }}</span></div>
            <div class="st-seg">
              @for (p of providerIds; track p) {
                <button [class.on]="p === prov(j)" [disabled]="!canEdit || p === prov(j)"
                        (click)="setProvider(j, p)">{{ d.providers[p].name }}@if (!d.providers[p].set) { <small>{{ 'no key' | t }}</small> }</button>
              }
            </div>
            <select class="st-in" [disabled]="!canEdit" (change)="setModel(j, $any($event.target).value)">
              @if (pending()[j]) {
                <option value="" selected disabled>{{ 'choose a model' | t }}</option>
              } @else if (!inList(job.provider, job.model)) { <option [value]="job.model" selected>{{ job.model }}</option> }
              @for (m of models()[prov(j)] || []; track m.id) {
                <option [value]="m.id" [selected]="!pending()[j] && m.id === job.model">{{ m.vision ? '🖼 ' : '' }}{{ m.id }}{{ m.anthropic ? ' · Claude' : '' }}</option>
              }
            </select>
            <div class="st-job-acts">
              @if (canEdit) {
                <button class="tcv-btn tcv-files-btn" [disabled]="testing() === j" (click)="test(j)">{{ testing() === j ? '…' : ('Test' | t) }}</button>
                @if (job.provider !== job.default.provider || job.model !== job.default.model) {
                  <button class="tcv-btn tcv-files-btn" (click)="reset(j)" [title]="job.default.provider + ' / ' + job.default.model">{{ 'Default' | t }}</button>
                }
              }
            </div>
            @if (job.switch) {
              <div class="st-job-switch">
                <label class="st-job-on">
                  <button type="button" class="tcv-switch" [attr.data-on]="job.on ? 1 : null" [attr.aria-pressed]="!!job.on"
                          [disabled]="!canEdit || busy()" (click)="setSwitch(j, { on: !job.on })"
                          [attr.aria-label]="job.label | t"></button>
                  <span>{{ (job.on ? 'On' : 'Off') | t }}</span>
                </label>
                <span class="st-job-wait">{{ 'wait after an answer' | t }}</span>
                <div class="st-seg">
                  @for (s of delays; track s) {
                    <button [class.on]="s === job.delay" [disabled]="!canEdit || busy() || s === job.delay"
                            (click)="setSwitch(j, { delay: s })">{{ delayLabel(s) }}</button>
                  }
                </div>
                @if (job.delay != null && !delays.includes(job.delay)) { <span class="st-job-wait">{{ delayLabel(job.delay) }}</span> }
                <span class="st-job-wait">{{ (job.on ? 'one short call per finished answer, only after that quiet' : 'off: no calls, nothing is shown') | t }}</span>
              </div>
            }
            @if (tests()[j]; as r) {
              <div class="st-job-test" [class.st-ok]="r.ok" [class.st-err]="!r.ok">{{ r.ok ? '✓ ' + r.answer + ' · ' + r.ms + ' ms' : '✕ ' + r.error }}</div>
            }
          </div>
        }
      }
    </div>
  </div>
  @if (msg(); as m) { <p class="st-msg">{{ m }}</p> }
  @if (err(); as e) { <p class="st-err">{{ e }}</p> }

  <app-llm-usage />
</div>
} @else {
  <div class="st-page"><p class="st-lead">{{ err() || ('Loading…' | t) }}</p></div>
}`,
})
export class LlmSettingsPanel {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  readonly canEdit = this.auth.can('settings');
  readonly providerIds = PROVIDERS;
  data = signal<LlmSettings | null>(null);
  models = signal<Record<string, LlmModel[]>>({});
  draft = signal<Record<string, string>>({});
  busy = signal(false);
  testing = signal<string | null>(null);
  tests = signal<Record<string, { ok: boolean; answer?: string; error?: string; ms: number }>>({});
  msg = signal<string | null>(null);
  err = signal<string | null>(null);

  jobIds = () => Object.keys(this.data()?.jobs ?? {});
  keyCount = computed(() => PROVIDERS.filter(p => this.data()?.providers[p]?.set).length);
  custom = computed(() => Object.values(this.data()?.jobs ?? {})
    .filter(j => j.provider !== j.default.provider || j.model !== j.default.model).length);
  jobsOn(p: string) { return Object.values(this.data()?.jobs ?? {}).filter(j => j.provider === p).length; }
  readonly cc = inject(CcUsage);
  readonly or = inject(OrUsage);
  private period = inject(CcPeriod);
  readonly day = day;
  /** The header line's figures, kept fresh while the page is open. */
  private polls = (() => { const d = inject(DestroyRef); d.onDestroy(this.cc.use()); d.onDestroy(this.or.use()); return true; })();
  money = (v: number | null | undefined): string => v == null ? '–' : shown(v);
  daysTo(at: number) { return inSpan(at, this.cc.now()).replace(/^in /, ''); }
  loadedAt(p: string) { return p === 'commandcode' ? this.cc.loadedAt() : p === 'openrouter' ? this.or.loadedAt() : 0; }
  loading(p: string) { return p === 'commandcode' ? this.cc.loading() || this.period.loading() : p === 'openrouter' ? this.or.loading() : false; }
  ago(at: number) { const ms = this.cc.now() - at; return ms < 10_000 ? t('just now') : span(ms) + ' ' + t('ago'); }
  refresh(p: string) {
    if (p === 'commandcode') { this.cc.load(true); this.period.load(true); }
    else if (p === 'openrouter') this.or.load(true);
  }
  jobsOf(p: string) { return Object.values(this.data()?.jobs ?? {}).filter(j => j.provider === p).map(j => j.label); }
  /** The providers in the server's order; the page's own list if it is an older server. */
  registry = computed<ProviderEntry[]>(() => this.data()?.registry
    ?? PROVIDERS.map(id => ({ id, name: this.data()?.providers[id]?.name ?? id, site: this.data()?.providers[id]?.site ?? '',
                              priced: id === 'openrouter', about: '', account: true, analysis: id === 'commandcode' })));
  /** Opened or closed by hand, per provider, in this browser; otherwise open when a key is set. */
  private opened = signal<Record<string, boolean>>(load('redline.settings.llm.open', {}));
  isOpen(p: string) { const o = this.opened()[p]; return o ?? !!this.data()?.providers[p]?.set; }
  toggle(p: string) {
    const next = { ...this.opened(), [p]: !this.isOpen(p) };
    this.opened.set(next);
    keep('redline.settings.llm.open', next);
  }

  constructor() {
    this.http.get<LlmSettings>('/api/llm/settings').subscribe({
      next: d => { this.data.set(d); this.loadModels(); },
      error: e => this.err.set(this.text(e)),
    });
  }

  loadModels() {
    for (const p of this.providerIds) {
      this.http.get<LlmModel[]>(`/api/llm/models?provider=${p}`).subscribe({
        next: m => this.models.update(all => ({ ...all, [p]: m })),
        error: () => this.models.update(all => ({ ...all, [p]: [] })),
      });
    }
  }

  /** How many of a provider's models read images (the 🖼 in the pickers). */
  visionCount(p: string) { return (this.models()[p] ?? []).filter(m => m.vision).length; }
  inList(p: string, m: string) { return (this.models()[p] ?? []).some(x => x.id === m); }
  setDraft(p: string, v: string) { this.draft.update(d => ({ ...d, [p]: v })); }

  saveKey(p: string) {
    const v = this.draft()[p]?.trim();
    if (!v) return;
    this.put({ keys: { [p]: v } }, t('Key saved.'), () => { this.setDraft(p, ''); this.loadModels(); });
  }

  clearKey(p: string) {
    if (!confirm(t('Forget this key? Jobs that use this provider stop until a new key is saved.'))) return;
    this.put({ keys: { [p]: null } }, t('Key removed.'));
  }

  /** A provider picked for a job whose model is still to be chosen. */
  pending = signal<Record<string, string>>({});
  prov(j: string) { return this.pending()[j] ?? this.data()!.jobs[j].provider; }

  setProvider(j: string, provider: string) {
    // Only a cheap model is picked unasked: the job's default when it is on
    // this provider, else the cheap one if this provider has it. Otherwise
    // the provider waits for a model to be chosen - never the first in the
    // list, which may be the dearest.
    const job = this.data()!.jobs[j];
    const list = this.models()[provider] ?? [];
    if (!list.length && job.default.provider !== provider) {
      this.err.set(t('That provider has no models to choose from - is its key set?')); return;
    }
    const model = job.default.provider === provider ? job.default.model : (list.find(m => m.cheap)?.id ?? '');
    if (!model) {
      this.pending.update(x => ({ ...x, [j]: provider }));
      this.msg.set(t('Choose a model for it - nothing is saved until you do.'));
      return;
    }
    this.pending.update(({ [j]: _, ...rest }) => rest);
    this.put({ jobs: { [j]: { provider, model } } }, t('Saved.'));
  }

  setModel(j: string, model: string) {
    if (!model) return;
    const provider = this.prov(j);
    this.pending.update(({ [j]: _, ...rest }) => rest);
    this.put({ jobs: { [j]: { provider, model } } }, t('Saved.'));
  }

  readonly delays = DELAYS;
  private suggestConf = inject(SuggestConf);
  delayLabel(s: number) { return s % 60 === 0 ? (s / 60) + ' ' + t('min') : s + ' ' + t('s'); }

  /** The switched job's on/off or its wait, saved with its provider and model. */
  setSwitch(j: string, change: { on?: boolean; delay?: number }) {
    const job = this.data()!.jobs[j];
    const msg = change.on === undefined ? t('Saved.') : change.on ? t('Turned on.') : t('Turned off.');
    this.put({ jobs: { [j]: { provider: job.provider, model: job.model, ...change } } }, msg);
  }

  reset(j: string) {
    const job = this.data()!.jobs[j];
    this.pending.update(({ [j]: _, ...rest }) => rest);
    this.put({ jobs: { [j]: job.default } }, t('Back to the default.'));
  }

  test(j: string) {
    const job = this.data()!.jobs[j];
    this.testing.set(j);
    this.http.post<{ ok: boolean; answer?: string; error?: string; ms: number }>('/api/llm/test',
      { provider: job.provider, model: job.model }).subscribe({
      next: r => { this.tests.update(x => ({ ...x, [j]: r })); this.testing.set(null); },
      error: e => { this.tests.update(x => ({ ...x, [j]: { ok: false, error: this.text(e), ms: 0 } })); this.testing.set(null); },
    });
  }

  private put(body: object, ok: string, after?: () => void) {
    this.busy.set(true);
    this.err.set(null);
    this.http.put<LlmSettings>('/api/llm/settings', body).subscribe({
      next: d => {
        this.data.set(d);
        // The composers follow a change of the suggestion's switch or wait at once.
        const sg = d.jobs['suggest'];
        if (sg?.switch) this.suggestConf.set({ on: sg.on, delay: sg.delay });
        this.busy.set(false);
        this.msg.set(ok);
        setTimeout(() => this.msg.set(null), 3000);
        after?.();
      },
      error: e => { this.busy.set(false); this.err.set(this.text(e)); },
    });
  }

  private text(e: unknown): string {
    const err = e as { error?: { detail?: unknown }; message?: string };
    return typeof err?.error?.detail === 'string' ? err.error.detail : (err?.message ?? t('Something went wrong.'));
  }
}
