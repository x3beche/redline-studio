import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { T, t } from './i18n';
import { when } from './llm-settings';

/** Settings > RustDesk (backend/rustdesk.py), for the owner and the admins:
 *  the remote desktop on this machine, turned on and off, and what to type
 *  in RustDesk to reach it - the Tailscale address and the password. It is
 *  reached only over Tailscale; a banner says what is open besides, if
 *  anything. */
interface RdState {
  installed: boolean; running: boolean; status?: string; since?: string | null;
  tailscale_ip: string | null; port: number; password?: string | null;
  bound_to?: string[]; tailscale_only?: boolean;
}

@Component({
  selector: 'app-rustdesk-settings',
  imports: [T],
  styleUrls: ['./settings.css', './rustdesk-settings.css'],
  template: `
<div class="st-page rd">
  @if (error(); as e) { <div class="st-banner">{{ e }}</div> }
  @if (s(); as d) {
    @if (!d.installed) {
      <div class="st-banner">{{ 'The rustdesk-desktop container is not on this machine.' | t }}</div>
    } @else {
      @if (!d.tailscale_only) {
        <div class="st-banner">{{ 'Open on more than the Tailscale address' | t }}: <span class="mono">{{ (d.bound_to || []).join(', ') }}:{{ d.port }}</span></div>
      }
      <!-- ---------------- on / off ---------------- -->
      <div class="st-card rd-power" [attr.data-on]="d.running ? 1 : null">
        <div class="rd-power-main">
          <span class="rd-dot" aria-hidden="true"></span>
          <div class="rd-power-text">
            <b>{{ busy() ? ((busy() === 'on' ? 'Starting…' : 'Stopping…') | t) : ((d.running ? 'RustDesk is on' : 'RustDesk is off') | t) }}</b>
            <span>
              @if (d.running && d.since) { {{ 'since' | t }} {{ when(d.since) }} · {{ 'up' | t }} {{ uptime() }} }
              @else if (d.since) { {{ 'stopped' | t }} {{ when(d.since) }} }
            </span>
          </div>
        </div>
        <button type="button" class="tcv-switch rd-switch" [attr.data-on]="d.running ? 1 : null" [attr.aria-pressed]="d.running"
                [attr.aria-label]="(d.running ? 'Turn off' : 'Turn on') | t" [disabled]="!!busy()" (click)="turn(!d.running)"></button>
      </div>

      <!-- ---------------- connect ---------------- -->
      <div class="st-card">
        <div class="st-card-head"><h3>{{ 'Connect' | t }}</h3>
          <span class="st-sub">{{ 'from a computer or phone on your Tailscale' | t }}</span></div>
        <ol class="rd-steps" [attr.data-off]="d.running ? null : 1">
          <li>
            <span class="rd-n">1</span>
            <div class="rd-step">
              <b>{{ 'Turn Tailscale on, on your device' | t }}</b>
              <span class="st-sub">{{ d.tailscale_ip ? ('This server is on your tailnet.' | t) : ('Tailscale is down on this server.' | t) }}</span>
            </div>
          </li>
          <li>
            <span class="rd-n">2</span>
            <div class="rd-step">
              <b>{{ 'In RustDesk, type this in the ID box' | t }}</b>
              <div class="rd-field">
                <code>{{ address() || '—' }}</code>
                <button type="button" class="rd-ico" [disabled]="!address()" (click)="copy(address()!, 'ip')"
                        [title]="'Copy address' | t">@if (copied() === 'ip') { <svg viewBox="0 0 24 24"><path d="M5 12l5 5L19 7"/></svg> } @else { <svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg> }</button>
              </div>
            </div>
          </li>
          <li>
            <span class="rd-n">3</span>
            <div class="rd-step">
              <b>{{ 'Then the password' | t }}</b>
              <div class="rd-field">
                <code [class.rd-mask]="!shown()">{{ d.password ? (shown() ? d.password : '••••••••••••') : ('not set' | t) }}</code>
                @if (d.password) {
                  <button type="button" class="rd-ico" (click)="shown.set(!shown())"
                          [title]="(shown() ? 'Hide password' : 'Show password') | t">@if (shown()) { <svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg> } @else { <svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg> }</button>
                  <button type="button" class="rd-ico" (click)="copy(d.password, 'pw')"
                          [title]="'Copy password' | t">@if (copied() === 'pw') { <svg viewBox="0 0 24 24"><path d="M5 12l5 5L19 7"/></svg> } @else { <svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg> }</button>
                }
              </div>
            </div>
          </li>
        </ol>
        @if (!d.running) { <p class="st-hint rd-foot">{{ 'Turn it on above first.' | t }}</p> }
      </div>

    }
  } @else if (!error()) { <p class="st-hint">…</p> }
</div>`,
})
export class RustdeskSettings implements OnDestroy {
  private http = inject(HttpClient);
  s = signal<RdState | null>(null);
  busy = signal<'on' | 'off' | null>(null);
  error = signal('');
  shown = signal(false);
  copied = signal<'ip' | 'pw' | null>(null);
  private now = signal(Date.now());
  when = when;
  private timer = setInterval(() => { this.now.set(Date.now()); this.load(); }, 10_000);

  address = computed(() => { const d = this.s(); return d?.tailscale_ip ? `${d.tailscale_ip}:${d.port}` : null; });
  /** How long it has been on: "2 h 14 min", "6 min". */
  uptime = computed(() => {
    const since = this.s()?.since;
    if (!since) return '';
    const min = Math.max(0, Math.round((this.now() - new Date(since).getTime()) / 60_000));
    if (min < 60) return `${min} ${t('min')}`;
    const h = Math.floor(min / 60);
    return h < 48 ? `${h} h ${min % 60} ${t('min')}` : `${Math.floor(h / 24)} ${t('days')}`;
  });

  constructor() { this.load(); }
  ngOnDestroy() { clearInterval(this.timer); }

  load() {
    this.http.get<RdState>('/api/admin/rustdesk').subscribe({
      next: d => { this.s.set(d); this.error.set(''); },
      error: (e: HttpErrorResponse) => this.error.set(this.why(e)),
    });
  }

  turn(on: boolean) {
    this.busy.set(on ? 'on' : 'off');
    this.http.post<RdState>(`/api/admin/rustdesk/${on ? 'start' : 'stop'}`, {}).subscribe({
      next: d => { this.busy.set(null); this.now.set(Date.now()); this.s.set(d); this.error.set(''); },
      error: (e: HttpErrorResponse) => { this.busy.set(null); this.error.set(this.why(e)); },
    });
  }

  copy(text: string, what: 'ip' | 'pw') {
    navigator.clipboard?.writeText(text).then(() => {
      this.copied.set(what);
      setTimeout(() => this.copied.set(null), 1500);
    });
  }

  private why(e: HttpErrorResponse) { return typeof e.error?.detail === 'string' ? e.error.detail : 'that did not work'; }
}
