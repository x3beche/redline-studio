import { Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Auth } from './auth';
import { T, t } from './i18n';
import type { LlmModel } from './rooms/commandcode';

/** Preferences > LLM settings: the API keys, and which provider and model
 *  does each of the app's model jobs (backend/llm.py).
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

@Component({
  selector: 'app-llm-settings',
  imports: [T],
  template: `
@if (data(); as d) {
  <p>{{ 'Which model does what in Redline, and the keys it uses. The keys stay on the server: once saved, only their last four characters are shown.' | t }}</p>
  @if (!canEdit) { <p class="tcv-files-error">{{ 'Only the workspace\\'s owners and admins can change these.' | t }}</p> }

  <div class="tcv-prefs-group">{{ 'API keys' | t }}</div>
  @for (p of providerIds; track p) {
    @if (d.providers[p]; as info) {
      <div class="tcv-llm-key">
        <div class="tcv-llm-key-name">
          <b>{{ info.name }}</b>
          @if (info.set) {
            <span class="tcv-llm-ok">● {{ 'set' | t }} {{ info.hint }} · {{ info.source === '.env' ? '.env' : ('saved here' | t) }}</span>
          } @else {
            <span class="tcv-llm-off">○ {{ 'not set' | t }}</span>
          }
          <a [href]="info.site" target="_blank" rel="noopener">{{ 'get a key' | t }} ↗</a>
        </div>
        @if (canEdit) {
          <div class="tcv-llm-key-row">
            <input class="tcv-files-note" type="password" autocomplete="off" [placeholder]="(info.set ? 'Replace the key' : 'Paste the API key') | t"
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

  <div class="tcv-prefs-group">{{ 'Which model does what' | t }}</div>
  @for (j of jobIds(); track j) {
    @if (d.jobs[j]; as job) {
      <div class="tcv-llm-job">
        <div class="tcv-llm-job-name"><b>{{ job.label | t }}</b><span>{{ job.about | t }}</span></div>
        <div class="tcv-llm-job-row">
          <select class="tcv-files-select" [disabled]="!canEdit" (change)="setProvider(j, $any($event.target).value)">
            @for (p of providerIds; track p) {
              <option [value]="p" [selected]="p === job.provider">{{ d.providers[p].name }}{{ d.providers[p].set ? '' : ' (' + ('no key' | t) + ')' }}</option>
            }
          </select>
          <select class="tcv-files-select tcv-llm-model" [disabled]="!canEdit" (change)="setModel(j, $any($event.target).value)">
            @if (!inList(job.provider, job.model)) { <option [value]="job.model" selected>{{ job.model }}</option> }
            @for (m of models()[job.provider] || []; track m.id) {
              <option [value]="m.id" [selected]="m.id === job.model">{{ m.id }}{{ m.anthropic ? ' · Claude' : '' }}</option>
            }
          </select>
          @if (canEdit) {
            <button class="tcv-btn tcv-files-btn" [disabled]="testing() === j" (click)="test(j)">{{ testing() === j ? '…' : ('Test' | t) }}</button>
            @if (job.provider !== job.default.provider || job.model !== job.default.model) {
              <button class="tcv-btn tcv-files-btn" (click)="reset(j)" [title]="job.default.provider + ' / ' + job.default.model">{{ 'Default' | t }}</button>
            }
          }
        </div>
        @if (tests()[j]; as r) {
          <div [class]="r.ok ? 'tcv-llm-ok' : 'tcv-files-error'">{{ r.ok ? '✓ ' + r.answer + ' · ' + r.ms + ' ms' : '✕ ' + r.error }}</div>
        }
      </div>
    }
  }
  @if (msg(); as m) { <p class="tcv-files-flash">{{ m }}</p> }
  @if (err(); as e) { <p class="tcv-files-error">{{ e }}</p> }
} @else {
  <p>{{ err() || ('Loading…' | t) }}</p>
}`,
})
export class LlmSettingsPanel {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  readonly canEdit = this.auth.can('settings');
  readonly providerIds = ['commandcode', 'openrouter'];
  data = signal<LlmSettings | null>(null);
  models = signal<Record<string, LlmModel[]>>({});
  draft = signal<Record<string, string>>({});
  busy = signal(false);
  testing = signal<string | null>(null);
  tests = signal<Record<string, { ok: boolean; answer?: string; error?: string; ms: number }>>({});
  msg = signal<string | null>(null);
  err = signal<string | null>(null);

  jobIds = () => Object.keys(this.data()?.jobs ?? {});

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
