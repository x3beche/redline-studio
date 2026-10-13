import { Component, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Auth } from './auth';
import { T, t } from './i18n';
import { when } from './llm-settings';
import { foldKeep, foldLoad } from './jina-settings';

/** Settings > Proxy & Data: McMaster-Carr's API (backend/mcmaster.py). Its
 *  access is given out on approval and is pending, so nothing calls it yet:
 *  until then parts are found through a web search and their STEPs
 *  downloaded from each part's page (Catalog > McMaster-Carr). The user
 *  name, the password and the client certificate McMaster issues are kept
 *  on the server like the proxy's password - only whether each is set comes
 *  back. "Test connection" is a stub and says so. */
interface McmSettings { username: string; password_set: boolean; cert: { name: string; bytes: number; at: string } | null;
  cert_password_set: boolean; auto_step: boolean; filled: boolean; connected: boolean; wired: boolean; set_at?: string | null }

@Component({
  selector: 'app-mcmaster-settings',
  imports: [T],
  styleUrl: './settings.css',
  template: `
<section class="st-card pv" [attr.data-open]="open() ? 1 : null">
  <div class="pv-head">
    <button type="button" class="pv-toggle" (click)="toggle()" [attr.aria-expanded]="open()"
            [attr.aria-label]="(open() ? 'Collapse' : 'Expand') | t">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="open() ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'" /></svg>
      <h3>McMaster-Carr</h3>
    </button>
    @if (s(); as st) {
      <span class="pv-meta" [attr.data-tone]="st.filled ? null : 'warn'">{{ (st.filled ? 'filled in · not connected: the API is not wired in yet' : 'API access pending · not connected') | t }}</span>
    }
    <span class="pv-right"><a class="st-link" href="https://www.mcmaster.com/help/api/" target="_blank" rel="noopener">mcmaster.com/help/api ↗</a></span>
  </div>
  @if (open()) {
  <div class="st-card-body">
    <p class="pv-line">{{ 'McMaster-Carr\\'s API is given out on approval. Until it is connected, parts are found through a web search (never by reading mcmaster.com) and their STEPs downloaded from each part\\'s page: CAD → 3-D STEP → Save.' | t }}</p>
    @if (s(); as st) {
      <div class="st-tiles tight wb-in">
        <div class="st-tile" [attr.data-tone]="st.username ? 'ok' : 'dim'"><span>{{ 'User name' | t }}</span><b class="mono">{{ st.username || ('not set' | t) }}</b>
          <small>{{ (st.password_set ? 'password kept on the server' : 'no password') | t }}</small></div>
        <div class="st-tile" [attr.data-tone]="st.cert ? 'ok' : 'dim'"><span>{{ 'Client certificate' | t }}</span><b class="mono">{{ st.cert?.name || ('none' | t) }}</b>
          <small>{{ st.cert ? when(st.cert.at) + ' · ' + ((st.cert_password_set ? 'with its password' : 'no password for it') | t) : ('McMaster issues it with access' | t) }}</small></div>
        <div class="st-tile" data-tone="dim"><span>{{ 'Connection' | t }}</span><b>{{ 'not connected' | t }}</b>
          <small>{{ 'nothing calls the API yet' | t }}</small></div>
        <div class="st-tile" [attr.data-tone]="st.auto_step ? null : 'dim'"><span>{{ 'STEP of a saved part' | t }}</span>
          <b>{{ (st.auto_step ? 'fetched by itself' : 'downloaded by hand') | t }}</b><small>{{ 'once the API is connected' | t }}</small></div>
      </div>
      @if (canEdit) {
        <div class="st-row">
          <input class="st-in" style="flex: 1 1 200px; min-width: 0" autocomplete="off" [value]="user()" [placeholder]="'API user name' | t"
                 (input)="user.set($any($event.target).value)" [attr.aria-label]="'API user name' | t">
          <input class="st-in" style="flex: 1 1 200px; min-width: 0" type="password" autocomplete="new-password" [value]="pw()"
                 [placeholder]="(st.password_set ? 'kept - type a new one to replace it' : 'API password') | t"
                 (input)="pw.set($any($event.target).value)" [attr.aria-label]="'API password' | t">
          <input class="st-in" style="flex: 1 1 200px; min-width: 0" type="password" autocomplete="new-password" [value]="certPw()"
                 [placeholder]="(st.cert_password_set ? 'kept - type a new one to replace it' : 'certificate password') | t"
                 (input)="certPw.set($any($event.target).value)" [attr.aria-label]="'certificate password' | t">
          <button class="tcv-btn tcv-files-btn" [disabled]="busy() || !dirty()" (click)="save()">{{ 'Save' | t }}</button>
        </div>
        <div class="st-row">
          <button class="tcv-btn tcv-files-btn" [disabled]="busy()" (click)="certIn.click()">{{ (st.cert ? 'Replace the certificate…' : 'Upload the client certificate…') | t }}</button>
          <input #certIn type="file" accept=".pfx,.p12,.pem,.crt,.cer" hidden (change)="upload($any($event.target))">
          @if (st.cert) { <button class="tcv-btn tcv-files-btn" [disabled]="busy()" (click)="dropCert()">{{ 'Forget the certificate' | t }}</button> }
          <button type="button" class="tcv-btn tcv-files-btn" role="switch" [attr.aria-checked]="st.auto_step" [disabled]="busy()" (click)="autoStep(!st.auto_step)">
            <span class="tcv-switch" [attr.data-on]="st.auto_step ? 1 : null" aria-hidden="true"></span>{{ 'Fetch a saved part\\'s STEP by itself' | t }}</button>
          <button class="tcv-btn tcv-files-btn" [disabled]="busy() || !st.filled" (click)="test()" [title]="'A stub: it says the API is not wired in yet' | t">{{ 'Test connection' | t }}</button>
          @if (forget()) { <button class="tcv-btn tcv-files-btn" [disabled]="busy()" (click)="clearAll()">{{ 'Forget the user name and passwords' | t }}</button> }
        </div>
        @if (note(); as n) { <p class="st-hint">{{ n }}</p> }
        @if (err(); as e) { <p class="st-err">{{ e }}</p> }
      }
    } @else if (err()) { <div class="st-empty">{{ err() }}</div> }
  </div>
  }
</section>`,
})
export class McMasterSettingsPanel {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  readonly canEdit = this.auth.can('settings');
  readonly when = when;
  private opened = signal<boolean | null>(foldLoad('redline.settings.mcmaster.open'));
  open = computed(() => this.opened() ?? false);
  toggle() { const v = !this.open(); this.opened.set(v); foldKeep('redline.settings.mcmaster.open', v); }
  s = signal<McmSettings | null>(null);
  user = signal('');
  pw = signal('');
  certPw = signal('');
  busy = signal(false);
  note = signal('');
  err = signal('');
  dirty = computed(() => this.user().trim() !== (this.s()?.username ?? '') || !!this.pw() || !!this.certPw());
  forget = computed(() => { const s = this.s(); return !!s && (!!s.username || s.password_set || s.cert_password_set); });

  constructor() {
    this.http.get<McmSettings>('/api/mcmaster/settings').subscribe({
      next: s => this.took(s), error: e => this.err.set(this.text(e)),
    });
  }
  private took(s: McmSettings) { this.s.set(s); this.user.set(s.username); this.pw.set(''); this.certPw.set(''); }
  private put(body: Record<string, unknown>) {
    this.busy.set(true); this.err.set(''); this.note.set('');
    this.http.put<McmSettings>('/api/mcmaster/settings', body).subscribe({
      next: s => { this.took(s); this.busy.set(false); },
      error: e => { this.err.set(this.text(e)); this.busy.set(false); },
    });
  }
  save() {
    const body: Record<string, unknown> = {};
    if (this.user().trim() !== (this.s()?.username ?? '')) body['username'] = this.user().trim();
    if (this.pw()) body['password'] = this.pw();
    if (this.certPw()) body['cert_password'] = this.certPw();
    this.put(body);
  }
  autoStep(v: boolean) { this.put({ auto_step: v }); }
  clearAll() { this.put({ username: '', password: '', cert_password: '' }); }
  upload(el: HTMLInputElement) {
    const f = el.files?.[0];
    el.value = '';
    if (!f) return;
    const body = new FormData();
    body.append('upload', f, f.name);
    this.busy.set(true); this.err.set('');
    this.http.post<McmSettings>('/api/mcmaster/settings/cert', body).subscribe({
      next: s => { this.took(s); this.busy.set(false); },
      error: e => { this.err.set(this.text(e)); this.busy.set(false); },
    });
  }
  dropCert() {
    this.busy.set(true);
    this.http.delete<McmSettings>('/api/mcmaster/settings/cert').subscribe({
      next: s => { this.took(s); this.busy.set(false); }, error: e => { this.err.set(this.text(e)); this.busy.set(false); },
    });
  }
  test() {
    this.busy.set(true); this.note.set(''); this.err.set('');
    this.http.post<{ ok: boolean; implemented: boolean; message?: string }>('/api/mcmaster/test', {}).subscribe({
      next: r => { this.note.set(r.implemented ? t('Connected.') : t('Not implemented yet: the McMaster-Carr API is not wired in (access is pending).')); this.busy.set(false); },
      error: e => { this.err.set(this.text(e)); this.busy.set(false); },
    });
  }
  private text(e: HttpErrorResponse) { return typeof e?.error?.detail === 'string' ? e.error.detail : t('Could not save it.'); }
}
