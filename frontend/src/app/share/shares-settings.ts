import { Component, OnInit, computed, signal } from '@angular/core';
import { LANG, T, t } from '../i18n';
import { Confirm } from '../confirm';
import { Toast } from '../toast';
import { ShareRow, Shares, shareDay, shareWhat } from './share-api';

/** Settings > Shared links: the read-only links one sent (backend/shares.py),
 *  one line each - what, which version, until when, how often opened - and
 *  Turn off. A link itself is never listed: it was shown once, when made. */
@Component({
  selector: 'app-shares-settings',
  imports: [T],
  styleUrls: ['../settings.css'],
  styles: [`
    .shs-bar { display: flex; align-items: center; gap: 16px; padding: 4px 0 8px; border-bottom: 1px solid var(--line);
               font-size: 12px; color: var(--ink-dim); }
    .shs-bar b { color: var(--ink); font-weight: 600; }
    .shs-bar label { margin-left: auto; }
    .shs-row { display: grid; align-items: center; gap: 16px; min-height: 34px; font-size: 12.5px;
               grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) auto auto minmax(0, 1fr) minmax(0, 1fr) 72px;
               border-bottom: 1px solid var(--line); }
    .shs-row > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-dim); }
    .shs-row > .shs-title { color: var(--ink); }
    .shs-title b { font-weight: 600; color: var(--ink-bright); }
    .shs-title i { font-style: normal; margin-left: 8px; color: var(--ink-dim); }
    .shs-mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 11.5px; }
    .shs-head > span { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .shs-row[data-state="expired"] .shs-title, .shs-row[data-state="revoked"] .shs-title { opacity: .6; }
    .shs-off { justify-self: end; border: 0; background: none; padding: 4px 0; font: inherit; color: var(--ink-dim); cursor: pointer; }
    .shs-off:hover { color: var(--danger); }
    .shs-off:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
    .shs-none { padding: 14px 0; color: var(--ink-dim); font-size: 12.5px; }
    @media (prefers-reduced-motion: no-preference) { .shs-off { transition: color var(--tcv-t-hover, .1s); } }
    @media (max-width: 768px) {
      .shs-head { display: none; }
      .shs-row { grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 6px 0; }
      .shs-row > span:not(.shs-title) { grid-column: 1; }
      .shs-off { grid-row: 1; grid-column: 2; min-height: 36px; }
    }
  `],
  template: `
<div class="st-page">
  <p class="st-lead">{{ 'Read-only links to a model, a board or a technical drawing, for someone without an account. Make one with Share on the model\\'s Model tab, the board\\'s toolbar, or a right click in the tree. A link is shown once, when it is made; here they can be turned off.' | t }}</p>
  <div class="shs-bar">
    <span><b>{{ active().length }}</b> {{ 'open' | t }}</span>
    <span><b>{{ seen() }}</b> {{ 'views' | t }}</span>
    <label class="tcv-check-row"><input type="checkbox" class="tcv-check" [checked]="ended()" (change)="toggleEnded()">
      {{ 'Show ended links' | t }}</label>
  </div>
  @if (rows().length) {
    <div class="shs-row shs-head"><span>{{ 'Shared' | t }}</span><span>{{ 'Version' | t }}</span><span>{{ 'Until' | t }}</span>
      <span>{{ 'Times opened' | t }}</span><span>{{ 'Last opened' | t }}</span><span>{{ 'Access' | t }}</span><span></span></div>
  }
  @for (r of rows(); track r.id) {
    <div class="shs-row" [attr.data-state]="r.state">
      <span class="shs-title" [title]="r.target"><b>{{ r.title }}</b><i>{{ what(r.kind) }}</i></span>
      <span class="shs-mono">{{ r.version.pinned ? r.version.label : ('latest' | t) }}</span>
      <span>{{ r.state === 'revoked' ? ('turned off' | t) : day(r.expires_at) }}</span>
      <span class="shs-mono">{{ r.views }}</span>
      <span>{{ r.last_viewed_at ? day(r.last_viewed_at) : ('never' | t) }}</span>
      <span>{{ flags(r) }}</span>
      @if (r.state === 'active') {
        <button class="shs-off" type="button" (click)="revoke(r)">{{ 'Turn off' | t }}</button>
      } @else { <span class="shs-off">{{ (r.state === 'expired' ? 'expired' : '') | t }}</span> }
    </div>
  } @empty {
    @if (loaded()) { <p class="shs-none">{{ 'You have no open shared links.' | t }}</p> }
  }
</div>`,
})
export class SharesSettings implements OnInit {
  rows = signal<ShareRow[]>([]);
  loaded = signal(false);
  ended = signal(false);
  readonly day = shareDay;
  readonly what = shareWhat;
  active = computed(() => this.rows().filter(r => r.state === 'active'));
  seen = computed(() => this.rows().reduce((n, r) => n + (r.views || 0), 0));

  ngOnInit() { this.load(); }

  toggleEnded() { this.ended.set(!this.ended()); this.load(); }

  flags(r: ShareRow): string {
    LANG();
    return [r.password ? t('password') : '', r.downloads ? t('downloads') : t('view only')].filter(Boolean).join(' · ');
  }

  private async load() {
    try {
      const rows = await Shares.list({ mine: true, ...(this.ended() ? { ended: true } : {}) });
      this.rows.set(rows);
    } catch { /* shown empty */ }
    this.loaded.set(true);
  }

  async revoke(r: ShareRow) {
    if (!await Confirm.ask({ title: t('Turn this link off?'), ok: t('Turn off'), danger: true,
                             text: t('Anyone who opens it from now on is told it was turned off. This cannot be undone.') })) return;
    try {
      const got = await Shares.revoke(r.id);
      this.rows.update(rs => this.ended() ? rs.map(x => x.id === r.id ? got : x) : rs.filter(x => x.id !== r.id));
      Toast.show(t('Link turned off.'));
    } catch (e) {
      Toast.show(t('Could not turn it off: {e}').replace('{e}', (e as Error).message), { tone: 'danger' });
    }
  }
}
