import { Component, computed, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Auth } from './auth';
import { T, t } from './i18n';
import { money as shown } from './money';
import type { LlmModel } from './rooms/commandcode';
import { BarList, Row, TimeChart, TimeData, fmt } from './rooms/charts';

/** Preferences > LLM settings: the API keys, and which provider and model
 *  does each of the app's model jobs (backend/llm.py), and what each
 *  provider was used for (LlmUsagePanel, under them).
 *
 *  A key goes one way: typed here, kept on the server, never shown again -
 *  the page only learns whether one is set and its last four characters.
 *  Changing anything is for the workspace's owners and admins.
 */
interface ProviderInfo { name: string; set: boolean; hint: string | null; source: string | null; site: string }
interface JobInfo {
  label: string; about: string; provider: string; model: string;
  default: { provider: string; model: string };
}
interface LlmSettings { providers: Record<string, ProviderInfo>; jobs: Record<string, JobInfo> }

interface UsageRow { name: string; calls: number; input: number; output: number; cost_usd: number | null }
interface LlmUsage {
  provider: string; days: number; step: number;
  totals: { calls: number; input: number; output: number; cost_usd: number | null; unpriced_calls: number };
  calls: TimeData; tokens: TimeData; cost: TimeData;
  by_model: UsageRow[]; by_kind: UsageRow[];
  recent: { at: string | number; kind: string; model: string; input: number; output: number; cost_usd: number | null }[];
  account: null | { label: string; usage: number; limit: number | null; limit_remaining: number | null; is_free_tier: boolean };
}

const PROVIDERS = ['commandcode', 'openrouter'];
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
          <button [class.on]="provider() === p" (click)="setProvider(p)">{{ names()[p] || p }}</button>
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
          <div class="st-tile" data-tone="dim"><span>{{ 'Spend' | t }}</span><b>{{ 'not priced' | t }}</b>
            <small>{{ 'this provider sends no prices' | t }}</small></div>
        } @else {
          <div class="st-tile"><span>{{ 'Spend' | t }}</span><b>{{ money(d.totals.cost_usd) }}</b>
            <small>{{ d.totals.unpriced_calls ? d.totals.unpriced_calls + ' ' + ('calls not priced' | t)
                     : (d.totals.calls ? money(d.totals.cost_usd / d.totals.calls) + ' ' + ('per call' | t) : '–') }}</small></div>
        }
        @if (d.account; as a) {
          <div class="st-tile hero">
            <span>{{ 'OpenRouter account' | t }} · <span class="mono">{{ a.label }}</span>{{ a.is_free_tier ? ' · ' + ('free tier' | t) : '' }}</span>
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
          @if (priced(d)) {
            <section class="st-chart c8"><h4>{{ 'Spend by model' | t }}<em>{{ money(d.totals.cost_usd) }}</em></h4>
              <app-time-chart [data]="d.cost" kind="bar" [f]="money" [height]="150" /></section>
            <section class="st-chart c4"><h4>{{ 'Spend by job' | t }}</h4>
              <app-bar-list [rows]="rows(d.by_kind, 'cost_usd')" [f]="money" /></section>
          }
          <section class="st-chart"><h4>{{ 'Latest calls' | t }}<em>{{ d.recent.length }}</em></h4>
            <div class="st-table-wrap">
              <table class="st-table">
                <thead><tr><th>{{ 'when' | t }}</th><th>{{ 'job' | t }}</th><th>{{ 'model' | t }}</th>
                  <th class="r">{{ 'in' | t }}</th><th class="r">{{ 'out' | t }}</th><th class="r">{{ 'spend' | t }}</th></tr></thead>
                <tbody>
                  @for (r of allRecent() ? d.recent : d.recent.slice(0, 8); track $index) {
                    <tr><td class="dim mono">{{ when(r.at) }}</td><td><span class="st-tag">{{ r.kind }}</span></td>
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
        <div class="st-empty">{{ 'No calls to this provider in this period.' | t }}</div>
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
  readonly providers = PROVIDERS;
  readonly periods = PERIODS;
  /** Display names, from the settings above. */
  names = signal<Record<string, string>>({ commandcode: 'Command Code', openrouter: 'OpenRouter' });
  provider = signal<string>(load('x3.settings.llm.provider', 'openrouter'));
  days = signal<number>(load('x3.settings.llm.days', 30));
  u = signal<LlmUsage | null>(null);
  allRecent = signal(false);
  err = signal<string | null>(null);

  constructor() {
    effect(() => {
      const p = this.provider(), d = this.days();
      this.u.set(null);
      this.err.set(null);
      this.http.get<LlmUsage>(`/api/llm/usage?provider=${p}&days=${d}`).subscribe({
        next: r => { if (this.provider() === p && this.days() === d) this.u.set(r); },
        error: e => this.err.set(t('The usage figures did not load') + ` (${e?.status ?? '?'}).`),
      });
    });
  }

  setProvider(p: string) { this.provider.set(p); keep('x3.settings.llm.provider', p); }
  setDays(d: number) { this.days.set(d); keep('x3.settings.llm.days', d); }
  perCall(n: number, calls: number) { return fmt.count(Math.round(n / calls)); }
  perDay(n: number) { return fmt.count(n / Math.max(1, this.days())); }
  /** Dollars from the server in the display currency, a tiny amount still as a figure. */
  money = (v: number | null | undefined): string => v == null ? '–' : shown(v);
  usedPct(a: NonNullable<LlmUsage['account']>) { return a.limit ? Math.min(100, 100 * a.usage / a.limit) : 0; }
  priced(d: LlmUsage) { return d.totals.cost_usd != null && d.totals.cost_usd > 0; }
  rows(list: UsageRow[], key: 'calls' | 'cost_usd'): Row[] {
    return list.map(r => ({ name: r.name, value: r[key] ?? 0 }))
      .filter(r => r.value > 0).sort((a, b) => b.value - a.value);
  }
}

@Component({
  selector: 'app-llm-settings',
  imports: [T, LlmUsagePanel],
  styleUrl: './settings.css',
  template: `
@if (data(); as d) {
<div class="st-page">
  <p class="st-lead">{{ 'Which model does what in Redline, and the keys it uses. The keys stay on the server: once saved, only their last four characters are shown.' | t }}</p>
  @if (!canEdit) { <div class="st-banner">{{ 'Only the workspace\\'s owners and admins can change these.' | t }}</div> }

  <div class="st-tiles">
    <div class="st-tile" [attr.data-tone]="keyCount() === providerIds.length ? 'ok' : 'warn'"><span>{{ 'API keys' | t }}</span>
      <b>{{ keyCount() }} / {{ providerIds.length }}</b><small>{{ 'set' | t }}</small></div>
    <div class="st-tile"><span>{{ 'Jobs' | t }}</span><b>{{ jobIds().length }}</b>
      <small>{{ custom() }} {{ 'changed from the default' | t }}</small></div>
    @for (p of providerIds; track p) {
      <div class="st-tile"><span>{{ d.providers[p].name }}</span><b>{{ jobsOn(p) }}</b>
        <small>{{ 'jobs on it' | t }} · {{ (models()[p] || []).length }} {{ 'models' | t }}</small></div>
    }
  </div>

  <div class="st-card">
    <div class="st-card-head"><h3>{{ 'API keys' | t }}</h3>
      <span class="st-sub">{{ 'typed once, kept on the server, never shown again' | t }}</span></div>
    <div class="st-card-body">
      <div class="st-keys">
        @for (p of providerIds; track p) {
          @if (d.providers[p]; as info) {
            <div class="st-key">
              <div class="st-key-top">
                <b>{{ info.name }}</b>
                @if (info.set) {
                  <span class="st-badge" data-tone="ok">● {{ 'set' | t }} {{ info.hint }}</span>
                  <span class="st-badge">{{ info.source === '.env' ? '.env' : ('saved here' | t) }}</span>
                } @else {
                  <span class="st-badge" data-tone="warn">○ {{ 'not set' | t }}</span>
                }
                <a class="st-link" [href]="info.site" target="_blank" rel="noopener">{{ 'get a key' | t }} ↗</a>
              </div>
              @if (canEdit) {
                <div class="st-row">
                  <input class="st-in wide" type="password" autocomplete="off" [placeholder]="(info.set ? 'Replace the key' : 'Paste the API key') | t"
                         [value]="draft()[p] || ''" (input)="setDraft(p, $any($event.target).value)" (keydown.enter)="saveKey(p)">
                  <button class="tcv-btn tcv-files-btn" [disabled]="!draft()[p]?.trim() || busy()" (click)="saveKey(p)">{{ 'Save' | t }}</button>
                  @if (info.set) {
                    <button class="tcv-btn tcv-files-btn" [disabled]="busy()" (click)="clearKey(p)"
                            [title]="'Forget this key - the one saved here and the one in .env - until a new one is saved' | t">{{ 'Remove' | t }}</button>
                  }
                </div>
              }
            </div>
          }
        }
      </div>
    </div>
  </div>

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
                <button [class.on]="p === job.provider" [disabled]="!canEdit || p === job.provider"
                        (click)="setProvider(j, p)">{{ d.providers[p].name }}@if (!d.providers[p].set) { <small>{{ 'no key' | t }}</small> }</button>
              }
            </div>
            <select class="st-in" [disabled]="!canEdit" (change)="setModel(j, $any($event.target).value)">
              @if (!inList(job.provider, job.model)) { <option [value]="job.model" selected>{{ job.model }}</option> }
              @for (m of models()[job.provider] || []; track m.id) {
                <option [value]="m.id" [selected]="m.id === job.model">{{ m.id }}{{ m.anthropic ? ' · Claude' : '' }}</option>
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

  setProvider(j: string, provider: string) {
    // A model of the new provider: the first one, unless the job's default is there.
    const job = this.data()!.jobs[j];
    const list = this.models()[provider] ?? [];
    const model = job.default.provider === provider ? job.default.model : (list[0]?.id ?? '');
    if (!model) { this.err.set(t('That provider has no models to choose from - is its key set?')); return; }
    this.put({ jobs: { [j]: { provider, model } } }, t('Saved.'));
  }

  setModel(j: string, model: string) {
    const job = this.data()!.jobs[j];
    this.put({ jobs: { [j]: { provider: job.provider, model } } }, t('Saved.'));
  }

  reset(j: string) {
    const job = this.data()!.jobs[j];
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
