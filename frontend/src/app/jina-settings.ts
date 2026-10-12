import { Component, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Auth } from './auth';
import { T, t } from './i18n';
import { TimeChart, TimeData, fmt } from './rooms/charts';
import { when } from './llm-settings';

/** Settings > Proxy & Data: Jina AI (backend/jina.py). Its Reader reads a
 *  web page in a browser on Jina's side and answers with the page as
 *  Markdown - for the Product Catalog's crawler (the Jina route of its route
 *  order) and the Chat's web_read; its Search
 *  answers the Chat's web_search. One API key for both, kept on the server:
 *  only its last four characters come back. Under it: what the key has
 *  left, from Jina's own dashboard, and Workbench's own count of its calls,
 *  Reader's and Search's apart. */
interface JinaSettings { set: boolean; hint: string | null; set_at?: string | null;
  check?: { valid: boolean | null; how: string; error?: string; empty?: boolean; at: string } | null }
interface Balance { total: number; trial: number | null; regular: number | null }
interface Account { ok: boolean; set: boolean; balance: Balance | null; error?: string | null; at?: string;
  history: { day: string; first: number | null; last: number | null }[] }
interface ApiUsage { requests: number; ok: number; failed: number; success_rate: number | null; tokens: number;
  chars: number; p50_ms: number | null; p95_ms: number | null; by_who: { name: string; n: number }[];
  calls: TimeData; tokens_series: TimeData }
interface Usage { days: number; reader: ApiUsage; search: ApiUsage;
  log: { at: string; api: string; target: string; ok: boolean; status: number | null; ms: number; chars: number;
         tokens: number; who: string; error: string | null }[] }

const ms = (v: number | null | undefined) => v == null ? '–' : v >= 1000 ? (v / 1000).toFixed(1) + ' s' : Math.round(v) + ' ms';

/** A settings card opened or closed by hand, kept in this browser; null when never touched. */
export function foldLoad(key: string): boolean | null {
  try { const v = localStorage.getItem(key); return v == null ? null : v === '1'; } catch { return null; }
}
export function foldKeep(key: string, v: boolean): void {
  try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* private window */ }
}

@Component({
  selector: 'app-jina-settings',
  imports: [T, TimeChart],
  styleUrl: './settings.css',
  template: `
<section class="st-card pv" [attr.data-open]="open() ? 1 : null">
  <div class="pv-head">
    <button type="button" class="pv-toggle" (click)="toggle()" [attr.aria-expanded]="open()"
            [attr.aria-label]="(open() ? 'Collapse' : 'Expand') | t">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="open() ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'" /></svg>
      <h3>Jina AI</h3>
    </button>
    @if (s(); as st) {
      @if (st.set) {
        <span class="pv-key-hint" [title]="'API key saved here' | t"><i></i>{{ st.hint }}</span>
        @if (a()?.balance; as b) { <span class="pv-meta">{{ fmt.count(b.total) }} {{ 'tokens left' | t }}</span> }
      } @else { <span class="pv-meta" data-tone="warn">{{ 'no key' | t }}</span> }
    }
    <span class="pv-right"><a class="st-link" href="https://jina.ai/api-dashboard/key-manager" target="_blank" rel="noopener">jina.ai ↗</a></span>
  </div>
  @if (open()) {
  <div class="st-card-body">
    <p class="pv-line">{{ 'Reader reads a web page - its script run on Jina\\'s side - as Markdown; Search searches the web. For the Product Catalog\\'s crawler and the Chat.' | t }}</p>
    @if (s(); as st) {
      <div class="st-tiles tight">
        <div class="st-tile" [attr.data-tone]="st.set ? 'ok' : 'dim'"><span>{{ 'API key' | t }}</span>
          <b class="mono">{{ st.set ? st.hint : ('not set' | t) }}</b>
          <small>{{ st.set ? ('kept on the server' | t) + (st.set_at ? ' · ' + when(st.set_at) : '') : ('paste one below' | t) }}</small></div>
        <div class="st-tile" [attr.data-tone]="checkTone()"><span>{{ 'Key check' | t }}</span>
          <b>{{ checkText() | t }}</b>
          <small [title]="st.check?.error || ''">{{ st.check ? (st.check.error || when(st.check.at)) : ('not checked yet' | t) }}</small></div>
        <div class="st-tile hero" [attr.data-tone]="a()?.balance ? null : 'dim'"
             [title]="'from Jina\\'s own dashboard: the tokens this key has left' | t"><span>{{ 'Tokens left' | t }}</span>
          <b>{{ a()?.balance ? fmt.count(a()!.balance!.total) : (st.set ? (a()?.error ? ('unknown' | t) : '…') : '–') }}</b>
          <small>@if (a()?.balance; as b) { {{ 'free trial' | t }} {{ fmt.count(b.trial ?? 0) }} · {{ 'paid' | t }} {{ fmt.count(b.regular ?? 0) }} }
                 @else { {{ a()?.error || ('Jina\\'s dashboard' | t) }} }</small></div>
        <div class="st-tile" [title]="'the balance\\'s drop over the days Workbench looked at it' | t"><span>{{ 'Used' | t }} · 14d</span>
          <b>{{ spent() == null ? '–' : fmt.count(spent()!) }}</b><small>{{ 'tokens, by the balance' | t }}</small></div>
        <div class="st-tile" [attr.data-tone]="tone(u()?.reader?.success_rate)"><span>Reader · 14d</span>
          <b>{{ fmt.count(u()?.reader?.requests ?? 0) }}</b>
          <small>{{ u()?.reader?.failed ?? 0 }} {{ 'failed' | t }} · {{ fmt.count(u()?.reader?.tokens ?? 0) }} {{ 'Jina tokens' | t }}</small></div>
        <div class="st-tile" [attr.data-tone]="tone(u()?.search?.success_rate)"><span>Search · 14d</span>
          <b>{{ fmt.count(u()?.search?.requests ?? 0) }}</b>
          <small>{{ u()?.search?.failed ?? 0 }} {{ 'failed' | t }} · {{ fmt.count(u()?.search?.tokens ?? 0) }} {{ 'Jina tokens' | t }}</small></div>
      </div>

      @if (canEdit) {
        <div class="st-row">
          <input class="st-in" style="flex: 1 1 320px; min-width: 0" type="password" autocomplete="off" [value]="keyIn()"
                 [placeholder]="(st.set ? 'kept - paste a new key to replace it' : 'jina_… - paste the API key') | t"
                 (input)="keyIn.set($any($event.target).value)" (keydown.enter)="saveKey()">
          <button class="tcv-btn tcv-files-btn" [disabled]="busy() || !keyIn().trim()" (click)="saveKey()">{{ (st.set ? 'Replace' : 'Save') | t }}</button>
          <button class="tcv-btn tcv-files-btn" [disabled]="busy() || !st.set" (click)="check()">{{ checking() ? '…' : ('Check' | t) }}</button>
          <button class="tcv-btn tcv-files-btn" [disabled]="busy() || !st.set" (click)="forget()">{{ 'Forget' | t }}</button>
          @if (msg(); as m) { <p class="st-msg">{{ m }}</p> }
          @if (err(); as e) { <p class="st-err">{{ e }}</p> }
        </div>
      }

      @if (u(); as us) {
        <div class="st-charts">
          @for (api of apis; track api.id) {
            @if (us[api.id]; as x) {
              <section class="st-chart c6"><h4>{{ api.name }} · {{ api.about | t }}<em [title]="whoLine(x)">{{ x.requests }} {{ 'calls' | t }} · {{ whoLine(x) }}</em></h4>
                <div class="st-tiles" style="grid-template-columns: repeat(5, minmax(0, 1fr)); margin-bottom: 6px">
                  <div class="st-tile" [attr.data-tone]="tone(x.success_rate)"><span>{{ 'Success' | t }}</span><b>{{ pct(x.success_rate) }}</b>
                    <small>{{ x.ok }} / {{ x.requests }}</small></div>
                  <div class="st-tile" [attr.data-tone]="x.failed ? 'danger' : null"><span>{{ 'Failed' | t }}</span><b>{{ x.failed }}</b></div>
                  <div class="st-tile"><span>{{ 'Tokens' | t }}</span><b>{{ fmt.count(x.tokens) }}</b></div>
                  <div class="st-tile"><span>{{ 'Characters' | t }}</span><b>{{ fmt.count(x.chars) }}</b></div>
                  <div class="st-tile"><span>{{ 'Median' | t }}</span><b>{{ ms(x.p50_ms) }}</b><small>p95 {{ ms(x.p95_ms) }}</small></div>
                </div>
                <app-time-chart [data]="x.calls" kind="bar" [f]="fmt.count" [height]="120" />
              </section>
            }
          }
        </div>
        <section class="st-chart">
          <h4>{{ 'Latest Jina calls' | t }}<em>{{ us.log.length }}</em></h4>
          <div class="st-table-wrap">
            <table class="st-table">
              <thead><tr><th>{{ 'when' | t }}</th><th>API</th><th>{{ 'target' | t }}</th><th>{{ 'result' | t }}</th>
                <th>{{ 'who' | t }}</th><th class="r">ms</th><th class="r">{{ 'characters' | t }}</th><th class="r">{{ 'Tokens' | t }}</th></tr></thead>
              <tbody>
                @for (r of more() ? us.log : us.log.slice(0, 8); track $index) {
                  <tr [title]="r.error || ''">
                    <td class="dim mono">{{ when(r.at) }}</td>
                    <td><span class="st-tag" [attr.data-tone]="r.api === 'search' ? 'accent' : null">{{ r.api }}</span></td>
                    <td class="mono give" [title]="r.target">{{ r.target }}</td>
                    <td><span class="st-tag" [attr.data-tone]="r.ok ? 'ok' : 'danger'">{{ r.ok ? 'ok' : (r.error || ('error' | t)) }}</span></td>
                    <td class="dim">{{ r.who }}</td>
                    <td class="r mono dim">{{ ms(r.ms) }}</td><td class="r mono">{{ r.chars ? fmt.count(r.chars) : '–' }}</td>
                    <td class="r mono">{{ r.tokens ? fmt.count(r.tokens) : '–' }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="8" class="dim">{{ 'No Jina calls in the last 14 days.' | t }}</td></tr>
                }
              </tbody>
            </table>
          </div>
          @if (us.log.length > 8) { <button class="st-more" (click)="more.set(!more())">{{ (more() ? 'Show fewer' : 'Show all') | t }}</button> }
        </section>
      } @else if (usageErr()) { <p class="st-err">{{ usageErr() }}</p> }

      <p class="st-hint">{{ 'Where it is used: the Jina route in the Product Catalog\\'s route order (above, or a maker\\'s own) reads a web page through it - first, or after a site refuses or a page comes back empty without its script. robots.txt is still read here and obeyed, and only public addresses are sent. The Chat\\'s web_search and web_read use Search and Reader.' | t }}
        {{ 'Tokens are Jina\\'s unit: a page read costs about its length in tokens, a search a fixed amount.' | t }}</p>
    } @else {
      <div class="st-empty">{{ err() || ('Loading…' | t) }}</div>
    }
  </div>
  }
</section>`,
})
export class JinaSettingsPanel {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  readonly canEdit = this.auth.can('settings');
  /** Opened or closed by hand in this browser; otherwise open while a key is set. */
  private opened = signal<boolean | null>(foldLoad('redline.settings.jina.open'));
  open = computed(() => this.opened() ?? !!this.s()?.set);
  toggle() { const v = !this.open(); this.opened.set(v); foldKeep('redline.settings.jina.open', v); }
  readonly fmt = fmt;
  readonly ms = ms;
  readonly when = when;
  readonly apis: { id: 'reader' | 'search'; name: string; about: string }[] = [
    { id: 'reader', name: 'Reader', about: 'web pages read' }, { id: 'search', name: 'Search', about: 'web searches' }];
  s = signal<JinaSettings | null>(null);
  a = signal<Account | null>(null);
  u = signal<Usage | null>(null);
  keyIn = signal('');
  busy = signal(false);
  checking = signal(false);
  more = signal(false);
  msg = signal<string | null>(null);
  err = signal<string | null>(null);
  usageErr = signal<string | null>(null);

  checkText = computed(() => {
    const c = this.s()?.check;
    if (!this.s()?.set) return 'no key';
    if (!c) return 'not checked';
    return c.valid === true ? (c.empty ? 'valid, no balance' : 'valid') : c.valid === false ? 'not accepted' : 'unknown';
  });
  checkTone = computed(() => {
    const c = this.s()?.check;
    return !c ? 'dim' : c.valid === true ? (c.empty ? 'warn' : 'ok') : c.valid === false ? 'danger' : 'warn';
  });
  /** Tokens the balance dropped by over the days it was read (top-ups left out). */
  spent = computed(() => {
    const h = this.a()?.history ?? [];
    if (!h.length) return null;
    let used = 0;
    let prev: number | null = null;
    for (const d of h) {
      for (const v of [d.first, d.last]) {
        if (v == null) continue;
        if (prev != null && v < prev) used += prev - v;
        prev = v;
      }
    }
    return used;
  });

  constructor() { this.load(); }

  private load() {
    this.http.get<JinaSettings>('/api/jina/settings').subscribe({
      next: s => { this.s.set(s); if (s.set) this.account(false); else this.a.set(null); },
      error: e => this.err.set(this.text(e)),
    });
    this.http.get<Usage>('/api/jina/usage?days=14').subscribe({
      next: u => this.u.set(u), error: e => this.usageErr.set(t('The usage figures did not load') + ` (${e?.status ?? '?'}).`),
    });
  }
  private account(refresh: boolean) {
    this.http.get<Account>(`/api/jina/account${refresh ? '?refresh=true' : ''}`).subscribe({
      next: a => this.a.set(a), error: () => this.a.set(null),
    });
  }

  tone(v: number | null | undefined) { return v == null ? 'dim' : v >= 0.9 ? 'ok' : v >= 0.5 ? 'warn' : 'danger'; }
  pct(v: number | null | undefined) { return v == null ? '–' : (100 * v).toFixed(v === 1 ? 0 : 1) + '%'; }
  whoLine(x: ApiUsage) { return x.by_who.map(w => `${w.name} ${w.n}`).join(' · ') || '–'; }

  saveKey() {
    const k = this.keyIn().trim();
    if (!k) return;
    this.put(k, t('Saved.'), true);
  }
  forget() { this.put('', t('The key is forgotten.'), false); }
  private put(key: string, done: string, thenCheck: boolean) {
    this.busy.set(true);
    this.err.set(null);
    this.http.put<JinaSettings>('/api/jina/settings', { key }).subscribe({
      next: s => {
        this.s.set(s);
        this.keyIn.set('');
        this.busy.set(false);
        this.say(done);
        if (thenCheck && s.set) this.check(); else this.a.set(null);
      },
      error: e => { this.busy.set(false); this.err.set(this.text(e)); },
    });
  }
  check() {
    this.checking.set(true);
    this.err.set(null);
    this.http.post<NonNullable<JinaSettings['check']>>('/api/jina/test', {}).subscribe({
      next: c => {
        this.checking.set(false);
        const s = this.s();
        if (s) this.s.set({ ...s, check: c });
        this.account(true);
      },
      error: e => { this.checking.set(false); this.err.set(this.text(e)); },
    });
  }
  private say(m: string) { this.msg.set(m); setTimeout(() => this.msg.set(null), 3000); }
  private text(e: unknown): string {
    const err = e as { error?: { detail?: unknown }; message?: string };
    return typeof err?.error?.detail === 'string' ? err.error.detail : (err?.message ?? t('Something went wrong.'));
  }
}
