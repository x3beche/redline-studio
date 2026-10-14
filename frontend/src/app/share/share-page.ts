import { Component, ElementRef, OnDestroy, computed, effect, signal, untracked, viewChild } from '@angular/core';
import { LANG, Lang, T, setLang, t } from '../i18n';
import { shareToken } from '../nav-url';
import { themeIsLight } from '../../theme';
import { Drawing } from '../rooms/drawing';
import { Board3d } from '../rooms/board3d';
import { ShareKind, shareDay, shareWhat } from './share-api';

/** A shared link's page, /s/<token> (backend/shares.py): one model, board
 *  or technical drawing, read-only, for someone without an account.
 *
 *  Started on its own by main.ts (share/boot.ts) - none of the app is
 *  loaded, and nothing here asks for anything but /api/public/s/<token>:
 *  the title, until when, and the few files the link names. On top one
 *  line: the title, its version and end, the board's views, the downloads
 *  the link allows. Under it the thing itself, the whole window: a model in
 *  the 3D viewer (orbit, the tree, clip - no Model tab, nothing of the
 *  project), a board's drawings and 3D, a drawing's sheet. A password, an
 *  unknown link, an ended one each have a page of their own. */

interface Meta {
  kind: ShareKind;
  title: string;
  expires_at: string;
  version: { pinned: boolean; label: string | null; at: string | null };
  views: string[];
  downloads: string[];
  locked: boolean;
}

type State = 'loading' | 'locked' | 'open' | 'missing' | 'expired' | 'revoked' | 'busy' | 'error';

const VIEW_NAMES: Record<string, string> = {
  'layout.svg': 'Top', 'bottom.svg': 'Bottom', 'schematic.svg': 'Schematic', 'board.glb': '3D',
  'model.json': '3D model', 'sheet.png': 'Sheet',
};
const FILE_NAMES: Record<string, string> = { step: 'STEP', stl: 'STL', pdf: 'PDF' };

@Component({
  selector: 'app-share',
  imports: [T, Drawing, Board3d],
  styleUrl: './share-page.css',
  template: `
<div class="sp">
  <header class="sp-head">
    <div class="sp-id">
      @if (meta(); as m) {
        <b class="sp-title" [title]="m.title">{{ m.title }}</b>
        <span class="sp-kind">{{ what() }}</span>
        <span class="sp-meta">@if (m.version.pinned && m.version.label) { <b>{{ m.version.label }}</b> · }{{ 'until' | t }} {{ day(m.expires_at) }}</span>
      } @else {
        <b class="sp-title">{{ 'Shared link' | t }}</b>
      }
    </div>
    @if (meta(); as m) {
      @if (m.kind === 'board' && m.views.length > 1) {
        <nav class="sp-tabs" [attr.aria-label]="'Views' | t">
          @for (v of m.views; track v) {
            <button type="button" [class.on]="view() === v" [attr.aria-pressed]="view() === v"
                    (click)="view.set(v)">{{ viewName(v) | t }}</button>
          }
        </nav>
      }
    }
    <div class="sp-end">
      @if (meta(); as m) {
        @if (m.downloads.length) {
          <span class="sp-dls">
            @for (d of m.downloads; track d) {
              <a class="tcv-btn sp-dl" [href]="download(d)" download
                 [title]="downloadTip(d)">{{ fileName(d) }}</a>
            }
          </span>
        }
      }
      <span class="sp-via">{{ 'Shared via Workbench' | t }}</span>
      <span class="sp-lang" role="group" [attr.aria-label]="'Language' | t">
        <button type="button" [class.on]="lang() === 'en'" (click)="pick('en')">EN</button>
        <button type="button" [class.on]="lang() === 'tr'" (click)="pick('tr')">TR</button>
      </span>
    </div>
  </header>

  <main class="sp-body">
    @switch (state()) {
      @case ('open') {
        @if (meta()!.kind === 'model') {
          <div #host class="sp-host"></div>
          @if (viewerErr()) { <div class="sp-msg"><h1>{{ 'The 3D view could not start' | t }}</h1><p>{{ viewerErr() }}</p></div> }
        } @else if (view() === 'board.glb') {
          <div class="sp-fill"><app-board-3d [src]="file('board.glb')" /></div>
        } @else if (view()) {
          <div class="sp-fill"><app-drawing [src]="file(view())" /></div>
        }
      }
      @case ('locked') {
        <div class="sp-lock">
          <form (submit)="unlock($event)">
            <h1>{{ 'This link has a password' | t }}</h1>
            <p>{{ 'Ask the person who sent it for the password.' | t }}</p>
            <div class="sp-row">
              <input type="password" name="password" autocomplete="current-password" [attr.aria-label]="'Password' | t"
                     [placeholder]="'Password' | t" [value]="pw()" (input)="pw.set($any($event.target).value)" autofocus>
              <button class="tcv-btn tcv-btn-accent" type="submit" [disabled]="busy() || !pw()">{{ 'Open' | t }}</button>
            </div>
            @if (pwErr()) { <p class="sp-err" role="alert">{{ pwErr() }}</p> }
          </form>
        </div>
      }
      @case ('loading') { }
      @default {
        <div class="sp-msg"><h1>{{ heading() | t }}</h1><p>{{ sub() | t }}</p></div>
      }
    }
  </main>
</div>`,
})
export class SharePage implements OnDestroy {
  readonly token = shareToken(location.pathname) ?? '';
  private base = `/api/public/s/${encodeURIComponent(this.token)}`;

  meta = signal<Meta | null>(null);
  state = signal<State>('loading');
  view = signal('');
  pw = signal('');
  pwErr = signal('');
  busy = signal(false);
  viewerErr = signal('');
  lang = LANG;
  readonly day = shareDay;

  private host = viewChild<ElementRef<HTMLElement>>('host');
  private viewer: any = null;
  private ro?: ResizeObserver;

  what = computed(() => { const m = this.meta(); return m ? shareWhat(m.kind) : ''; });
  heading = computed(() => ({
    missing: 'There is no such link', expired: 'This link has expired', revoked: 'This link was turned off',
    busy: 'Too many requests', error: 'The link could not be opened',
  } as Record<string, string>)[this.state()] ?? '');
  sub = computed(() => ({
    missing: 'Check that the whole address was copied.', expired: 'Ask the person who sent it for a new one.',
    revoked: 'Ask the person who sent it for a new one.', busy: 'Wait a minute and try again.',
    error: 'Try again in a moment.',
  } as Record<string, string>)[this.state()] ?? '');

  constructor() {
    this.read();
    // The window's title says what is shown, and never who sent it.
    effect(() => {
      const m = this.meta();
      LANG();
      document.title = (m?.title ? m.title + ' · ' : '') + t('Shared via Workbench');
    });
    // The 3D viewer, once its place is on the page.
    effect(() => {
      const h = this.host();
      if (h && !this.viewer) untracked(() => this.startViewer(h.nativeElement));
    });
  }

  ngOnDestroy() { this.ro?.disconnect(); }

  viewName(v: string) { return VIEW_NAMES[v] ?? v; }
  fileName(d: string) { return FILE_NAMES[d] ?? d.toUpperCase(); }
  downloadTip(d: string) { LANG(); return t('Download {f}').replace('{f}', this.fileName(d)); }

  /** A view's address; a board's drawings in light inks on a light theme. */
  file(name: string): string {
    return `${this.base}/view/${name}` + (name.endsWith('.svg') && themeIsLight() ? '?light=1' : '');
  }
  download(name: string): string { return `${this.base}/download/${name}`; }

  pick(l: Lang) { setLang(l); }

  private take(m: Meta) {
    this.meta.set(m);
    this.view.set(m.views[0] ?? '');
    this.state.set(m.views.length ? 'open' : 'error');
  }

  private async read() {
    if (!this.token) { this.state.set('missing'); return; }
    try {
      const res = await fetch(this.base, { credentials: 'same-origin', cache: 'no-store' });
      if (res.ok) {
        const m = await res.json() as Meta;
        if (m.locked) { this.meta.set(null); this.state.set('locked'); } else this.take(m);
        return;
      }
      this.state.set(await this.why(res));
    } catch {
      this.state.set('error');
    }
  }

  private async why(res: Response): Promise<State> {
    if (res.status === 404) return 'missing';
    if (res.status === 429) return 'busy';
    if (res.status === 410) {
      const j = await res.json().catch(() => ({}));
      return /turned off/.test(String(j?.detail ?? '')) ? 'revoked' : 'expired';
    }
    return 'error';
  }

  async unlock(e: Event) {
    e.preventDefault();
    if (this.busy() || !this.pw()) return;
    this.busy.set(true);
    this.pwErr.set('');
    try {
      const res = await fetch(`${this.base}/unlock`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: this.pw() }),
      });
      if (res.ok) { this.pw.set(''); this.take(await res.json() as Meta); return; }
      if (res.status === 403) this.pwErr.set(t('That is not the password.'));
      else if (res.status === 429) this.pwErr.set(t('Too many tries. Wait a while and try again.'));
      else this.state.set(await this.why(res));
    } catch {
      this.pwErr.set(t('The link could not be opened'));
    } finally {
      this.busy.set(false);
    }
  }

  private async startViewer(el: HTMLElement) {
    try {
      const { OcpViewer } = await import('../editor/ocp');
      const v = new OcpViewer(el);
      v.bare = true;
      v.init({ w: Math.max(el.clientWidth, 320), h: Math.max(el.clientHeight, 320) });
      this.viewer = v;
      this.ro = new ResizeObserver(() => v.resize(el.clientWidth, el.clientHeight));
      this.ro.observe(el);
      await v.load(this.file('model.json'));
      v.resize(el.clientWidth, el.clientHeight);
    } catch (e) {
      this.viewerErr.set(String((e as Error)?.message ?? e));
    }
  }
}
