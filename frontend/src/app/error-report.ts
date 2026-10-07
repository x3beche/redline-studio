import { ErrorHandler, Injectable } from '@angular/core';

/** Every error the page does not catch - a template that throws, a promise
 *  nobody waited on - still goes to the console, and is also told to the
 *  server (backend/client_errors.py), so a panel half drawn on someone's
 *  screen leaves a trace where it can be read. The same message twice
 *  within a minute is sent once; the send itself never throws. */
const sent = new Map<string, number>();

export function reportError(err: unknown, kind = 'error') {
  try {
    const e = err as { message?: string; stack?: string; rejection?: unknown } | null;
    const inner = (e?.rejection ?? err) as { message?: string; stack?: string } | string | null;
    const message = typeof inner === 'string' ? inner : inner?.message ?? String(inner);
    const stack = typeof inner === 'string' ? '' : inner?.stack ?? '';
    const key = message.slice(0, 200);
    const now = Date.now();
    if ((sent.get(key) ?? 0) > now - 60_000) return;
    sent.set(key, now);
    fetch('/api/client-errors', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' },
      body: JSON.stringify({ kind, message: message.slice(0, 4000), stack: stack.slice(0, 16000),
                             url: location.pathname + location.search, agent: navigator.userAgent.slice(0, 400) }),
    }).catch(() => {});
  } catch { /* reporting must never be the next error */ }
}

@Injectable()
export class ReportingErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    console.error(error);
    reportError(error);
  }
}
