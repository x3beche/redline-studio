import { Component, ElementRef, OnDestroy, OnInit, computed, input, output, signal, viewChild } from '@angular/core';
import { LANG, T, t } from '../i18n';
import { BackCloses } from '../nav';
import { Toast } from '../toast';
import { Confirm } from '../confirm';
import { ShareIn, ShareKind, ShareMade, ShareRow, ShareTarget, Shares, shareDay, shareUrl, shareWhat } from './share-api';

/** "Share": a read-only link to a model, a board or a model's technical
 *  drawing, for someone without an account (backend/shares.py).
 *
 *  One small box: what to share (a model, or its drawing when there is
 *  one), which version, for how long, whether files may be taken, and an
 *  optional password, each one line; then Create, which shows the link once
 *  with Copy - only its fingerprint is kept, so it cannot be shown again.
 *  Under it the links open for this thing now, with their views and end,
 *  and Turn off. Opened by share-api.ts openShare(); Back and Esc close it. */

type Span = '1d' | '7d' | '30d' | 'custom';
const SPANS: { id: Span; label: string }[] = [
  { id: '1d', label: '1 day' }, { id: '7d', label: '7 days' }, { id: '30d', label: '30 days' }, { id: 'custom', label: 'Until…' },
];
const MAX_DAYS = 90;

function iso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

@Component({
  selector: 'app-share-dialog',
  imports: [T],
  styleUrl: './share.css',
  template: `
<div class="sh-wrap" [class.tcv-leave]="leaving()" (keydown.escape)="close()">
  <div class="tcv-m-veil sh-veil" (click)="close()"></div>
  <section class="tcv-m-box sh-box" role="dialog" aria-modal="true" [attr.aria-label]="'Share' | t" #box tabindex="-1">
    <header class="sh-head">
      <h2><span>{{ 'Share' | t }}</span> <b [title]="target().id">{{ target().title }}</b></h2>
      <button class="sh-x" type="button" (click)="close()" [title]="'Close' | t" [attr.aria-label]="'Close' | t">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
    </header>

    <div class="sh-form">
      @if (target().kind !== 'board') {
        <div class="sh-row"><span class="sh-lab">{{ 'What' | t }}</span>
          <div class="sh-seg" role="radiogroup" [attr.aria-label]="'What' | t">
            <button type="button" role="radio" [attr.aria-checked]="kind() === 'model'" [class.on]="kind() === 'model'"
                    (click)="kind.set('model')">{{ '3D model' | t }}</button>
            <button type="button" role="radio" [attr.aria-checked]="kind() === 'drawing'" [class.on]="kind() === 'drawing'"
                    [disabled]="!drawingOk()" (click)="kind.set('drawing')"
                    [title]="(drawingOk() ? 'The sheet as a picture, and its PDF when downloads are on' : 'Make the drawing first, in the Model tab') | t">
              {{ 'Technical drawing' | t }}</button>
          </div>
        </div>
      }
      <div class="sh-row"><span class="sh-lab">{{ 'Version' | t }}</span>
        <div class="sh-seg" role="radiogroup" [attr.aria-label]="'Version' | t">
          <button type="button" role="radio" [attr.aria-checked]="version() === 'pinned'" [class.on]="version() === 'pinned'"
                  (click)="version.set('pinned')" [title]="'What is built now, kept as it is: a later build does not change it' | t">
            {{ 'This version' | t }}</button>
          <button type="button" role="radio" [attr.aria-checked]="version() === 'latest'" [class.on]="version() === 'latest'"
                  (click)="version.set('latest')" [title]="'Whatever is built when the link is opened' | t">
            {{ 'Always the latest' | t }}</button>
        </div>
      </div>
      <div class="sh-row"><span class="sh-lab">{{ 'Expires' | t }}</span>
        <div class="sh-seg" role="radiogroup" [attr.aria-label]="'Expires' | t">
          @for (s of spans; track s.id) {
            <button type="button" role="radio" [attr.aria-checked]="span() === s.id" [class.on]="span() === s.id"
                    (click)="span.set(s.id)">{{ s.label | t }}</button>
          }
          @if (span() === 'custom') {
            <input class="sh-in sh-date" type="date" [min]="minDay" [max]="maxDay" [value]="until()"
                   (input)="until.set($any($event.target).value)" [attr.aria-label]="'Last day' | t">
          }
        </div>
      </div>
      <div class="sh-row"><span class="sh-lab">{{ 'Files' | t }}</span>
        <label class="tcv-check-row sh-check"><input type="checkbox" class="tcv-check" [checked]="downloads()"
               (change)="downloads.set(!downloads())"> {{ 'Allow downloads' | t }}
          <span class="sh-dim">{{ fileKinds() }}</span></label>
      </div>
      <div class="sh-row"><span class="sh-lab">{{ 'Password' | t }}</span>
        <input class="sh-in sh-pw" type="password" autocomplete="new-password" [placeholder]="'optional' | t"
               [value]="password()" (input)="password.set($any($event.target).value)" (keydown.enter)="make()">
      </div>
      <div class="sh-row sh-go">
        <span class="sh-dim">{{ 'Read-only. No account is needed to open it.' | t }}</span>
        <button class="tcv-btn tcv-btn-accent" type="button" (click)="make()" [disabled]="busy()">
          {{ (busy() ? 'Creating…' : 'Create link') | t }}</button>
      </div>
      @if (err()) { <p class="sh-err" role="alert">{{ err() }}</p> }
    </div>

    @if (made(); as m) {
      <div class="sh-made">
        <input class="sh-in sh-url" readonly [value]="url()" (focus)="$any($event.target).select()" [attr.aria-label]="'The link' | t">
        <button class="tcv-btn" type="button" (click)="copy()">{{ (copied() ? 'Copied' : 'Copy') | t }}</button>
      </div>
      <p class="sh-dim sh-once">{{ onceNote() }}</p>
    }

    <div class="sh-list-head"><span>{{ 'Active links' | t }}</span>@if (rows().length) { <b>{{ rows().length }}</b> }</div>
    <div class="sh-list">
      @for (r of rows(); track r.id) {
        <div class="sh-li">
          <span class="sh-li-what">{{ what(r.kind) }}<i>{{ r.version.pinned ? r.version.label : ('latest' | t) }}</i></span>
          <span>{{ 'until' | t }} {{ day(r.expires_at) }}</span>
          <span>{{ views(r.views) }}</span>
          <span class="sh-dim">{{ flags(r) }}</span>
          <button class="sh-off" type="button" (click)="revoke(r)">{{ 'Turn off' | t }}</button>
        </div>
      } @empty {
        @if (loaded()) { <p class="sh-dim sh-none">{{ 'No active links for this yet.' | t }}</p> }
      }
    </div>
  </section>
</div>`,
})
export class ShareDialog implements OnInit, OnDestroy {
  target = input.required<ShareTarget>();
  closed = output<void>();

  private box = viewChild<ElementRef<HTMLElement>>('box');
  readonly spans = SPANS;
  readonly day = shareDay;
  readonly what = shareWhat;

  kind = signal<ShareKind>('model');
  version = signal<'pinned' | 'latest'>('pinned');
  span = signal<Span>('7d');
  readonly minDay = iso(new Date(Date.now() + 86400000));
  readonly maxDay = iso(new Date(Date.now() + MAX_DAYS * 86400000));
  until = signal(iso(new Date(Date.now() + 14 * 86400000)));
  downloads = signal(false);
  password = signal('');

  busy = signal(false);
  err = signal('');
  made = signal<ShareMade | null>(null);
  copied = signal(false);
  rows = signal<ShareRow[]>([]);
  loaded = signal(false);
  leaving = signal(false);
  /** Whether the model's drawing is made, so it can be shared. */
  drawingOk = signal(false);

  url = computed(() => { const m = this.made(); return m ? shareUrl(m.path.slice(3)) : ''; });
  fileKinds = computed(() => {
    const k = this.target().kind === 'board' ? 'board' : this.kind();
    return k === 'board' ? 'STEP, STL' : k === 'drawing' ? 'PDF' : 'STEP, STL, PDF';
  });
  onceNote = computed(() => t('Copy it now: it is shown once. Anyone with it can look until {d}.')
    .replace('{d}', shareDay(this.made()?.share.expires_at)));

  private back = new BackCloses(() => this.close());

  ngOnInit() {
    const tg = this.target();
    this.kind.set(tg.kind === 'board' ? 'board' : tg.start === 'drawing' && tg.drawing ? 'drawing' : 'model');
    this.drawingOk.set(!!tg.drawing);
    // Opened from the tree, where nobody asked: whether the drawing is made.
    if (tg.kind === 'model' && tg.drawing === undefined) {
      fetch(`/api/models/${tg.id}/drawing/status`, { credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : null).then(st => this.drawingOk.set(!!st?.made)).catch(() => {});
    }
    this.back.opened();
    this.load();
    setTimeout(() => this.box()?.nativeElement.focus());
  }

  ngOnDestroy() { this.back.closed(); }

  close() {
    if (this.leaving()) return;
    this.leaving.set(true);
    this.back.closed();
    const quiet = matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => this.closed.emit(), quiet ? 0 : 90);
  }

  views(n: number): string {
    return n === 1 ? t('1 view') : t('{n} views').replace('{n}', String(n));
  }

  flags(r: ShareRow): string {
    return [r.password ? t('password') : '', r.downloads ? t('downloads') : t('view only')].filter(Boolean).join(' · ');
  }

  private async load() {
    const tg = this.target();
    try {
      const rows = await Shares.list({ target: tg.id });
      // A model's links and its drawing's; a board's.
      this.rows.set(rows.filter(r => tg.kind === 'board' ? r.kind === 'board' : r.kind !== 'board'));
    } catch { /* the list is a convenience; making a link still works */ }
    this.loaded.set(true);
  }

  async make() {
    if (this.busy()) return;
    this.err.set('');
    const body: ShareIn = {
      kind: this.kind(), target: this.target().id, version: this.version(), expires: this.span(),
      downloads: this.downloads(), password: this.password() || null,
    };
    if (this.span() === 'custom') {
      const [y, m, d] = this.until().split('-').map(Number);
      if (!y || !m || !d) { this.err.set(t('Choose the last day.')); return; }
      body.until = new Date(y, m - 1, d, 23, 59, 59).toISOString();
    }
    this.busy.set(true);
    try {
      const made = await Shares.make(body);
      this.made.set(made);
      this.copied.set(false);
      this.password.set('');
      this.rows.update(rs => [made.share, ...rs]);
    } catch (e) {
      this.err.set(t('Could not create the link: {e}').replace('{e}', (e as Error).message));
    } finally {
      this.busy.set(false);
    }
  }

  async copy() {
    const text = this.url();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = this.box()?.nativeElement.querySelector<HTMLInputElement>('.sh-url');
      el?.select();
      document.execCommand('copy');
    }
    this.copied.set(true);
  }

  async revoke(r: ShareRow) {
    if (!await Confirm.ask({ title: t('Turn this link off?'), ok: t('Turn off'), danger: true,
                             text: t('Anyone who opens it from now on is told it was turned off. This cannot be undone.') })) return;
    try {
      await Shares.revoke(r.id);
      this.rows.update(rs => rs.filter(x => x.id !== r.id));
      if (this.made()?.share.id === r.id) this.made.set(null);
      Toast.show(t('Link turned off.'));
    } catch (e) {
      Toast.show(t('Could not turn it off: {e}').replace('{e}', (e as Error).message), { tone: 'danger' });
    }
  }
}
