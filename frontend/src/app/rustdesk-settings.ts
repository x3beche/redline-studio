import { Component, OnDestroy, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { T } from './i18n';
import { when } from './llm-settings';

/** Settings > RustDesk (backend/rustdesk.py), for the owner and the admins:
 *  the remote desktop on this machine, turned on and off, and what to type
 *  in RustDesk to reach it - the Tailscale address and the password. It is
 *  reached only over Tailscale; the page says so when that does not hold. */
interface RdState {
  installed: boolean; running: boolean; status?: string; since?: string | null;
  tailscale_ip: string | null; port: number; password?: string | null;
  bound_to?: string[]; tailscale_only?: boolean;
}

@Component({
  selector: 'app-rustdesk-settings',
  imports: [T],
  styleUrls: ['./settings.css'],
  template: `
<div class="st-page">
  <p class="st-lead">{{ 'A small desktop on the server, reached with RustDesk over Tailscale - for the pages only the local network sees, like the modem. Turn it off when nobody is using it.' | t }}</p>
  @if (error(); as e) { <div class="st-banner">{{ e }}</div> }
  @if (s(); as d) {
    @if (!d.installed) {
      <div class="st-banner">{{ 'The rustdesk-desktop container is not on this machine.' | t }}</div>
    } @else {
      @if (!d.tailscale_only) {
        <div class="st-banner">{{ 'Not Tailscale-only yet: the port is open on' | t }} {{ (d.bound_to || []).join(', ') }}.</div>
      }
      <div class="st-tiles">
        <div class="st-tile" [attr.data-tone]="d.running ? 'ok' : 'dim'"><span>{{ 'Status' | t }}</span>
          <b>{{ (d.running ? 'on' : 'off') | t }}</b>
          <small>{{ d.since ? (d.running ? ('started' | t) : ('stopped' | t)) + ' ' + when(d.since) : '' }}</small></div>
        <div class="st-tile" [attr.data-tone]="d.tailscale_ip ? null : 'warn'"><span>{{ 'Tailscale address' | t }}</span>
          <b class="mono">{{ d.tailscale_ip ? d.tailscale_ip + ':' + d.port : ('Tailscale is down' | t) }}</b>
          <small>{{ 'type it in RustDesk\\'s ID box' | t }}</small></div>
        <div class="st-tile"><span>{{ 'Password' | t }}</span>
          <b class="mono">{{ d.password ? (shown() ? d.password : '••••••••••') : ('not set' | t) }}</b>
          <small>{{ 'the permanent password' | t }}</small></div>
        <div class="st-tile" [attr.data-tone]="d.tailscale_only ? 'ok' : 'warn'"><span>{{ 'Reachable from' | t }}</span>
          <b>{{ (d.tailscale_only ? 'Tailscale only' : 'more than Tailscale') | t }}</b>
          <small>{{ 'no public RustDesk ID' | t }}</small></div>
      </div>
      <div class="st-row">
        @if (d.running) {
          <button class="tcv-btn tcv-files-btn" [disabled]="busy()" (click)="turn(false)">{{ busy() ? '…' : ('Turn off' | t) }}</button>
        } @else {
          <button class="tcv-btn tcv-btn-accent" [disabled]="busy()" (click)="turn(true)">{{ busy() ? '…' : ('Turn on' | t) }}</button>
        }
        @if (d.tailscale_ip) {
          <button class="tcv-btn tcv-files-btn" (click)="copy(d.tailscale_ip + ':' + d.port)">{{ copied() === 'ip' ? ('copied' | t) : ('Copy address' | t) }}</button>
        }
        @if (d.password) {
          <button class="tcv-btn tcv-files-btn" (click)="shown.set(!shown())">{{ (shown() ? 'Hide password' : 'Show password') | t }}</button>
          <button class="tcv-btn tcv-files-btn" (click)="copy(d.password, 'pw')">{{ copied() === 'pw' ? ('copied' | t) : ('Copy password' | t) }}</button>
        }
      </div>
      <p class="st-hint">{{ 'Turned off, it stays off after the server restarts. Turned on, it needs Tailscale up on this machine.' | t }}</p>
    }
  } @else if (!error()) { <p class="st-hint">…</p> }
</div>`,
})
export class RustdeskSettings implements OnDestroy {
  private http = inject(HttpClient);
  s = signal<RdState | null>(null);
  busy = signal(false);
  error = signal('');
  shown = signal(false);
  copied = signal<'ip' | 'pw' | null>(null);
  when = when;
  private timer = setInterval(() => this.load(), 10_000);

  constructor() { this.load(); }
  ngOnDestroy() { clearInterval(this.timer); }

  load() {
    this.http.get<RdState>('/api/admin/rustdesk').subscribe({
      next: d => { this.s.set(d); this.error.set(''); },
      error: (e: HttpErrorResponse) => this.error.set(this.why(e)),
    });
  }

  turn(on: boolean) {
    this.busy.set(true);
    this.http.post<RdState>(`/api/admin/rustdesk/${on ? 'start' : 'stop'}`, {}).subscribe({
      next: d => { this.busy.set(false); this.s.set(d); this.error.set(''); },
      error: (e: HttpErrorResponse) => { this.busy.set(false); this.error.set(this.why(e)); },
    });
  }

  copy(text: string, what: 'ip' | 'pw' = 'ip') {
    navigator.clipboard?.writeText(text).then(() => {
      this.copied.set(what);
      setTimeout(() => this.copied.set(null), 1500);
    });
  }

  private why(e: HttpErrorResponse) { return typeof e.error?.detail === 'string' ? e.error.detail : 'that did not work'; }
}
