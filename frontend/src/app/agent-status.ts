import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { LANG, t } from './i18n';

/** Whether this space has an agent at work (GET /api/agent/status,
 *  backend/agent_kit.py): its working tokens, the last time one was used,
 *  and connected - used within `window_s`. No names, no tokens. */
export interface AgentStatus {
  tokens: number; last_seen: string | null; seen_s: number | null; connected: boolean;
  window_s: number; seed: string; can_make: boolean;
}

export type SeedOs = 'unix' | 'windows';

/** The one line that starts an agent on someone's own computer, from the
 *  seed's README: clone it, run its start script with this server's address
 *  and the token. Without a token, a placeholder the person fills in. */
export function seedLine(seed: string, api: string, os: SeedOs, token?: string | null): string {
  const tok = token || '<your-token>';
  const dir = seed.replace(/\/+$/, '').split('/').pop() || 'redline-agent-seed';
  return os === 'windows'
    ? `git clone ${seed}; cd ${dir}; powershell -ExecutionPolicy Bypass -File start.ps1 -Api ${api} -Token ${tok}`
    : `git clone ${seed}; cd ${dir} && ./start.sh --api ${api} --token ${tok}`;
}

/** "last seen 40 s ago", "12 min ago", ... */
export function seenAgo(s: number | null): string {
  LANG();
  if (s === null) return t('never');
  if (s < 90) return t('{n} s ago').replace('{n}', String(Math.max(0, Math.round(s))));
  if (s < 5400) return t('{n} min ago').replace('{n}', String(Math.round(s / 60)));
  if (s < 129600) return t('{n} h ago').replace('{n}', String(Math.round(s / 3600)));
  return t('{n} days ago').replace('{n}', String(Math.round(s / 86400)));
}

/** The status, kept fresh while something on screen watches it: `watch()`
 *  starts the polling, the function it returns stops it. */
@Injectable({ providedIn: 'root' })
export class Agents {
  private http = inject(HttpClient);
  status = signal<AgentStatus | null>(null);
  /** When `status` was read, for "last seen" that keeps counting. */
  readAt = signal(0);
  private watchers = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  refresh() {
    this.http.get<AgentStatus>('/api/agent/status').subscribe({
      next: s => { this.status.set(s); this.readAt.set(Date.now()); },
      error: () => { /* signed out, or the server restarting: try again on the next tick */ },
    });
  }

  watch(every = 10000): () => void {
    this.watchers++;
    this.refresh();
    if (!this.timer) this.timer = setInterval(() => this.refresh(), every);
    return () => {
      this.watchers = Math.max(0, this.watchers - 1);
      if (!this.watchers && this.timer) { clearInterval(this.timer); this.timer = null; }
    };
  }
}
