import { ApplicationRef, EnvironmentInjector, Injector, createComponent } from '@angular/core';
import { shareHref } from '../nav-url';
import { LANG, t } from '../i18n';

/** Shared links (backend/shares.py): one model, board or drawing, read-only,
 *  for a while, to someone without an account. What the app's own pages
 *  ask about them; the visitor's page is share-page.ts. */

export type ShareKind = 'model' | 'board' | 'drawing';

/** A share as its space's people see it. The link itself is never in it:
 *  only its hash is kept, so it is shown once, when it is made. */
export interface ShareRow {
  id: string;
  kind: ShareKind;
  target: string;
  title: string;
  state: 'active' | 'expired' | 'revoked';
  expires_at: string;
  downloads: boolean;
  password: boolean;
  version: { pinned: boolean; label: string | null; at: string | null };
  created_at: string;
  created_by: { id: string | null; name: string | null };
  views: number;
  last_viewed_at: string | null;
}

export interface ShareMade { share: ShareRow; token: string; path: string }

/** What is shared: the thing, and what the dialog offers for it. */
export interface ShareTarget {
  kind: ShareKind;
  /** The model's or board's id. */
  id: string;
  title: string;
  /** For a model: whether its drawing is made (a drawing can be shared). */
  drawing?: boolean;
  /** What the dialog starts on: a model's drawing, from the drawing's own Share. */
  start?: ShareKind;
}

export interface ShareIn {
  kind: ShareKind; target: string; version: 'pinned' | 'latest';
  expires: '1d' | '7d' | '30d' | 'custom'; until?: string | null;
  downloads: boolean; password?: string | null; title?: string | null;
}

const HEADERS = { 'Content-Type': 'application/json', 'X-Redline-CSRF': '1' };

async function answer<T>(res: Response): Promise<T> {
  if (res.ok) return res.json() as Promise<T>;
  let why = `${res.status}`;
  try {
    const j = await res.json();
    why = typeof j?.detail === 'string' ? j.detail : why;
  } catch { /* not JSON */ }
  throw new Error(why);
}

export const Shares = {
  list(q: { kind?: ShareKind; target?: string; mine?: boolean; ended?: boolean }): Promise<ShareRow[]> {
    const p = new URLSearchParams();
    if (q.kind) p.set('kind', q.kind);
    if (q.target) p.set('target', q.target);
    if (q.mine) p.set('mine', '1');
    if (q.ended) p.set('ended', '1');
    return fetch(`/api/shares?${p}`, { credentials: 'same-origin' }).then(r => answer<ShareRow[]>(r));
  },
  make(body: ShareIn): Promise<ShareMade> {
    return fetch('/api/shares', { method: 'POST', headers: HEADERS, credentials: 'same-origin',
                                  body: JSON.stringify(body) }).then(r => answer<ShareMade>(r));
  },
  revoke(id: string): Promise<ShareRow> {
    return fetch(`/api/shares/${encodeURIComponent(id)}/revoke`,
                 { method: 'POST', headers: HEADERS, credentials: 'same-origin' }).then(r => answer<ShareRow>(r));
  },
};

/** The whole address of a made link, on this site. */
export function shareUrl(token: string): string {
  return location.origin + shareHref(token);
}

/** Open the Share dialog for `target`, over the whole page. The dialog is
 *  fetched on the first click, so no page pays for it before. */
export async function openShare(target: ShareTarget, injector: Injector): Promise<void> {
  const { ShareDialog } = await import('./share-dialog');
  const app = injector.get(ApplicationRef);
  const ref = createComponent(ShareDialog, { environmentInjector: injector.get(EnvironmentInjector) });
  ref.setInput('target', target);
  app.attachView(ref.hostView);
  document.body.appendChild(ref.location.nativeElement);
  const sub = ref.instance.closed.subscribe(() => {
    sub.unsubscribe();
    app.detachView(ref.hostView);
    ref.destroy();
  });
}

/** A share's day, short (21 Oct 2026), in the page's language. */
export function shareDay(at: string | null | undefined): string {
  if (!at) return '';
  return new Date(at).toLocaleDateString(LANG() === 'tr' ? 'tr-TR' : 'en-GB',
                                         { day: 'numeric', month: 'short', year: 'numeric' });
}

/** What a share shows, in words. */
export function shareWhat(kind: ShareKind): string {
  return t(kind === 'board' ? 'Board' : kind === 'drawing' ? 'Technical drawing' : '3D model');
}
