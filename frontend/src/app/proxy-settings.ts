import { Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Auth } from './auth';
import { T, t } from './i18n';

/** Settings > Proxy: a second way out for EasyEDA's part lookups
 *  (backend/netproxy.py). Only those go through it - the model providers
 *  and everything else stay direct. The password is kept on the server
 *  and never shown again. */
interface ProxySettings {
  enabled: boolean; mode: 'always' | 'fallback'; scheme: string; host: string; port: number | null;
  username: string; password_set: boolean; active: string | null;
}
interface Exit { ok: boolean; ip?: string; country?: string; city?: string; org?: string; error?: string; ms: number }

@Component({
  selector: 'app-proxy-settings',
  imports: [T],
  template: `
@if (data(); as d) {
  <p>{{ 'EasyEDA turns a burst of part lookups away for a while. A proxy gives them another way out. Only the LCSC / EasyEDA lookups use it; the asking stays as polite as before.' | t }}</p>
  @if (!canEdit) { <p class="tcv-files-error">{{ 'Only the workspace\\'s owners and admins can change these.' | t }}</p> }

  <div class="tcv-llm-key">
    <div class="tcv-llm-key-name">
      <b>{{ 'Proxy' | t }}</b>
      @if (d.active) { <span class="tcv-llm-ok">● {{ 'on' | t }} · {{ (d.active === 'always' ? 'every lookup' : 'when EasyEDA refuses') | t }}</span> }
      @else { <span class="tcv-llm-off">○ {{ 'off' | t }}</span> }
    </div>
    <label class="tcv-proxy-check">
      <input type="checkbox" [checked]="d.enabled" [disabled]="!canEdit" (change)="save({ enabled: $any($event.target).checked })">
      {{ 'Use the proxy' | t }}
    </label>
    <div class="tcv-proxy-modes">
      <label><input type="radio" name="pmode" [checked]="d.mode === 'fallback'" [disabled]="!canEdit" (change)="save({ mode: 'fallback' })">
        <b>{{ 'Only when refused' | t }}</b> <span>{{ 'ask directly; a lookup EasyEDA turns away is asked once more through the proxy' | t }}</span></label>
      <label><input type="radio" name="pmode" [checked]="d.mode === 'always'" [disabled]="!canEdit" (change)="save({ mode: 'always' })">
        <b>{{ 'Always' | t }}</b> <span>{{ 'every lookup goes through the proxy' | t }}</span></label>
    </div>
  </div>

  <div class="tcv-prefs-group">{{ 'Connection' | t }}</div>
  <div class="tcv-proxy-grid">
    <label>{{ 'Host' | t }}<input class="tcv-files-note" [value]="host()" [disabled]="!canEdit" placeholder="ap.proxy.2captcha.com"
           (input)="host.set($any($event.target).value)"></label>
    <label>{{ 'Port' | t }}<input class="tcv-files-note" type="number" [value]="port()" [disabled]="!canEdit" placeholder="2334"
           (input)="port.set($any($event.target).value)"></label>
    <label>{{ 'Username' | t }}<input class="tcv-files-note" [value]="user()" [disabled]="!canEdit" autocomplete="off"
           (input)="user.set($any($event.target).value)"></label>
    <label>{{ 'Password' | t }}<input class="tcv-files-note" type="password" [value]="pass()" [disabled]="!canEdit" autocomplete="off"
           [placeholder]="(d.password_set ? 'kept - type to replace' : '') | t" (input)="pass.set($any($event.target).value)"></label>
  </div>
  <p class="tcv-proxy-hint">{{ 'A rotating residential proxy with no country in the username comes out somewhere new in the world on each lookup (2Captcha: the -zone-custom username, no region).' | t }}</p>
  @if (canEdit) {
    <div class="tcv-llm-key-row">
      <button class="tcv-btn tcv-files-btn" [disabled]="busy()" (click)="saveConnection()">{{ 'Save' | t }}</button>
      <button class="tcv-btn tcv-files-btn" [disabled]="testing() || !d.host" (click)="test()">{{ testing() ? '…' : ('Test' | t) }}</button>
    </div>
  }
  @if (exits(); as ex) {
    <div class="tcv-proxy-exits">
      @for (e of ex.exits; track $index) {
        @if (e.ok) { <div class="tcv-llm-ok">✓ {{ e.ip }} · {{ e.country }}{{ e.city ? ', ' + e.city : '' }} · {{ e.org }} · {{ e.ms }} ms</div> }
        @else { <div class="tcv-files-error">✕ {{ e.error }}</div> }
      }
      @if (ex.exits[0]?.ok) { <div class="tcv-llm-off">{{ (ex.rotates ? 'A new address each time.' : 'The same address both times.') | t }}</div> }
    </div>
  }
  @if (msg(); as m) { <p class="tcv-files-flash">{{ m }}</p> }
  @if (err(); as e) { <p class="tcv-files-error">{{ e }}</p> }
} @else {
  <p>{{ err() || ('Loading…' | t) }}</p>
}`,
})
export class ProxySettingsPanel {
  private http = inject(HttpClient);
  private auth = inject(Auth);
  readonly canEdit = this.auth.can('settings');
  data = signal<ProxySettings | null>(null);
  host = signal('');
  port = signal<string | number>('');
  user = signal('');
  pass = signal('');
  busy = signal(false);
  testing = signal(false);
  exits = signal<{ exits: Exit[]; rotates: boolean } | null>(null);
  msg = signal<string | null>(null);
  err = signal<string | null>(null);

  constructor() {
    this.http.get<ProxySettings>('/api/proxy/settings').subscribe({
      next: d => this.take(d), error: e => this.err.set(this.text(e)),
    });
  }

  private take(d: ProxySettings) {
    this.data.set(d);
    this.host.set(d.host);
    this.port.set(d.port ?? '');
    this.user.set(d.username);
    this.pass.set('');
  }

  saveConnection() {
    const body: Record<string, unknown> = { host: this.host().trim(), username: this.user().trim() };
    const port = Number(this.port());
    if (port) body['port'] = port;
    if (this.pass()) body['password'] = this.pass();
    this.save(body);
  }

  save(body: Record<string, unknown>) {
    this.busy.set(true);
    this.err.set(null);
    this.http.put<ProxySettings>('/api/proxy/settings', body).subscribe({
      next: d => {
        this.take(d);
        this.busy.set(false);
        this.msg.set(t('Saved.'));
        setTimeout(() => this.msg.set(null), 3000);
      },
      error: e => { this.busy.set(false); this.err.set(this.text(e)); },
    });
  }

  test() {
    this.testing.set(true);
    this.exits.set(null);
    this.http.post<{ exits: Exit[]; rotates: boolean }>('/api/proxy/test', {}).subscribe({
      next: r => { this.exits.set(r); this.testing.set(false); },
      error: e => { this.err.set(this.text(e)); this.testing.set(false); },
    });
  }

  private text(e: unknown): string {
    const err = e as { error?: { detail?: unknown }; message?: string };
    return typeof err?.error?.detail === 'string' ? err.error.detail : (err?.message ?? t('Something went wrong.'));
  }
}
