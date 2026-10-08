import {
  AfterViewInit, Component, ElementRef, OnDestroy, computed, effect, input, signal, untracked, viewChild,
} from '@angular/core';
import { T, t } from '../i18n';
import { Icon, Seen } from './files-model';

/** A PDF read in the page, with pdf.js (pdfjs-dist, pinned): the browser's
 *  own viewer is refused in some browsers and on most phones.
 *
 *  Pages are drawn as they scroll into view, with their text over them so it
 *  can be selected, copied and searched; the file is fetched a range at a
 *  time (the server answers Range), so the first page shows before the rest
 *  has arrived. The worker, the character maps and the standard fonts are
 *  served from /pdfjs (angular.json copies them out of node_modules). */

type PdfLib = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Viewer = any;

let lib: Promise<{ pdfjs: PdfLib; web: Viewer }> | null = null;

function load(): Promise<{ pdfjs: PdfLib; web: Viewer }> {
  lib ??= (async () => {
    // The legacy build: the same reader, with what older browsers and phones
    // lack (URL.parse, Promise.withResolvers...) filled in.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // The viewer reads the library from globalThis.pdfjsLib, set by the import above.
    const web = await import('pdfjs-dist/legacy/web/pdf_viewer.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs/pdf.worker.min.mjs', document.baseURI).href;
    if (!document.getElementById('tcv-pdfjs-css')) {
      const css = document.createElement('link');
      css.id = 'tcv-pdfjs-css';
      css.rel = 'stylesheet';
      css.href = new URL('pdfjs/web/pdf_viewer.css', document.baseURI).href;
      document.head.appendChild(css);
    }
    return { pdfjs, web };
  })();
  lib.catch(() => { lib = null; });
  return lib;
}

/** The first page of a PDF as a picture, for the grid: a data URL. Only the
 *  ranges the first page needs are fetched. */
export async function pdfFirstPage(url: string, width: number): Promise<string> {
  const { pdfjs } = await load();
  const base = new URL('pdfjs/', document.baseURI).href;
  const task = pdfjs.getDocument({ url, disableAutoFetch: true, disableStream: true, rangeChunkSize: 65536,
                                   cMapUrl: base + 'cmaps/', cMapPacked: true,
                                   standardFontDataUrl: base + 'standard_fonts/', wasmUrl: base + 'wasm/' });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / vp1.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    task.destroy();
  }
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

@Component({
  selector: 'app-pdf-reader',
  imports: [T, Icon, Seen],
  host: { class: 'tcv-fv-host' },
  template: `
<div class="tcv-pdf">
  <div class="tcv-pdf-bar" role="toolbar" [attr.aria-label]="'PDF' | t">
    <button class="tcv-fm-icon-btn" [attr.data-on]="thumbsOpen() ? 1 : null" (click)="thumbsOpen.set(!thumbsOpen())"
            [title]="'Pages' | t" [attr.aria-label]="'Pages' | t" [attr.aria-pressed]="thumbsOpen()"><i [fmIcon]="'pages'"></i></button>
    <span class="tcv-pdf-sep"></span>
    <button class="tcv-fm-icon-btn" (click)="go(page() - 1)" [disabled]="page() <= 1"
            [title]="'Previous page' | t" [attr.aria-label]="'Previous page' | t"><i [fmIcon]="'up'"></i></button>
    <span class="tcv-pdf-page">
      <input class="tcv-pdf-num" inputmode="numeric" [value]="page()" [attr.aria-label]="'Page' | t"
             (keydown.enter)="go(+$any($event.target).value)" (blur)="$any($event.target).value = page()">
      <span>/ {{ pages() || '…' }}</span>
    </span>
    <button class="tcv-fm-icon-btn" (click)="go(page() + 1)" [disabled]="page() >= pages()"
            [title]="'Next page' | t" [attr.aria-label]="'Next page' | t"><i [fmIcon]="'down'"></i></button>
    <span class="tcv-pdf-sep"></span>
    <button class="tcv-fm-icon-btn" (click)="zoomBy(-1)" [title]="'Zoom out' | t" [attr.aria-label]="'Zoom out' | t"><i [fmIcon]="'zoomout'"></i></button>
    <select class="tcv-fm-select tcv-pdf-zoom" [value]="zoomKey()" (change)="zoom($any($event.target).value)" [attr.aria-label]="'Zoom' | t">
      <option value="page-width">{{ 'Fit width' | t }}</option>
      <option value="page-fit">{{ 'Fit page' | t }}</option>
      @for (z of zooms; track z) { <option [value]="'' + z">{{ z * 100 }}%</option> }
      @if (custom(); as c) { <option [value]="c">{{ pct() }}%</option> }
    </select>
    <button class="tcv-fm-icon-btn" (click)="zoomBy(1)" [title]="'Zoom in' | t" [attr.aria-label]="'Zoom in' | t"><i [fmIcon]="'zoomin'"></i></button>
    <button class="tcv-fm-icon-btn" (click)="rotate()" [title]="'Rotate' | t" [attr.aria-label]="'Rotate' | t"><i [fmIcon]="'rotate'"></i></button>
    <span class="tcv-pdf-find">
      <i class="tcv-pdf-find-ico" [fmIcon]="'search'"></i>
      <input class="tcv-pdf-q" type="search" [placeholder]="'Find in document' | t" [value]="q()"
             (input)="find($any($event.target).value, false)" (keydown.enter)="again($any($event).shiftKey)"
             (keydown.escape)="find('', false)">
      @if (q()) {
        <span class="tcv-pdf-count">{{ matches().total ? matches().current + ' / ' + matches().total : ('No matches' | t) }}</span>
        <button class="tcv-fm-icon-btn" (click)="again(true)" [title]="'Previous match' | t" [attr.aria-label]="'Previous match' | t"><i [fmIcon]="'up'"></i></button>
        <button class="tcv-fm-icon-btn" (click)="again(false)" [title]="'Next match' | t" [attr.aria-label]="'Next match' | t"><i [fmIcon]="'down'"></i></button>
      }
    </span>
  </div>
  <div class="tcv-pdf-body">
    @if (thumbsOpen() && pages()) {
      <nav class="tcv-pdf-thumbs" [attr.aria-label]="'Pages' | t">
        @for (n of pageList(); track n) {
          <button class="tcv-pdf-thumb" [attr.data-on]="n === page() ? 1 : null" (click)="go(n)" (fmSeen)="drawThumb(n)">
            @if (thumbs()[n]; as src) { <img [src]="src" alt=""> } @else { <span class="tcv-pdf-thumb-blank"></span> }
            <span>{{ n }}</span>
          </button>
        }
      </nav>
    }
    <div class="tcv-pdf-stage">
      <div #box class="tcv-pdf-scroll" tabindex="0"><div class="pdfViewer"></div></div>
      @if (state() === 'loading') { <div class="tcv-fm-center"><span class="tcv-fm-spin"></span>{{ 'Opening the PDF…' | t }}</div> }
      @if (state() === 'failed') { <div class="tcv-fm-center tcv-fm-err">{{ error() }}</div> }
    </div>
  </div>
</div>`,
})
export class PdfReader implements AfterViewInit, OnDestroy {
  src = input.required<string>();
  private box = viewChild.required<ElementRef<HTMLDivElement>>('box');

  readonly zooms = ZOOMS;
  state = signal<'loading' | 'ready' | 'failed'>('loading');
  error = signal('');
  page = signal(1);
  pages = signal(0);
  scale = signal(1);
  zoomKey = signal('page-width');
  q = signal('');
  matches = signal({ current: 0, total: 0 });
  thumbsOpen = signal(typeof innerWidth === 'number' ? innerWidth > 900 : true);
  thumbs = signal<Record<number, string>>({});
  pageList = computed(() => Array.from({ length: this.pages() }, (_, i) => i + 1));
  pct = computed(() => Math.round(this.scale() * 100));
  custom = computed(() => ['page-width', 'page-fit'].includes(this.zoomKey()) || ZOOMS.includes(+this.zoomKey())
    ? null : this.zoomKey());

  private viewer: Viewer = null;
  private bus: Viewer = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private doc: any = null;
  private task: { destroy(): unknown } | null = null;
  private dead = false;

  constructor() {
    effect(() => {
      const url = this.src();
      untracked(() => { if (this.viewer) void this.open(url); });
    });
  }

  ngAfterViewInit() { void this.open(this.src()); }

  private async open(url: string) {
    this.state.set('loading');
    this.thumbs.set({});
    this.pages.set(0);
    try {
      const { pdfjs, web } = await load();
      if (this.dead) return;
      if (!this.viewer) {
        const container = this.box().nativeElement;
        this.bus = new web.EventBus();
        const link = new web.PDFLinkService({ eventBus: this.bus });
        const finder = new web.PDFFindController({ eventBus: this.bus, linkService: link });
        this.viewer = new web.PDFViewer({ container, viewer: container.firstElementChild, eventBus: this.bus,
                                          linkService: link, findController: finder });
        link.setViewer(this.viewer);
        this.bus.on('pagesinit', () => { this.viewer.currentScaleValue = this.zoomKey(); });
        this.bus.on('pagechanging', (e: { pageNumber: number }) => this.page.set(e.pageNumber));
        this.bus.on('scalechanging', (e: { scale: number; presetValue?: string }) => {
          this.scale.set(e.scale);
          this.zoomKey.set(e.presetValue ?? String(Math.round(e.scale * 100) / 100));
        });
        const count = (e: { matchesCount?: { current: number; total: number } }) => {
          if (e.matchesCount) this.matches.set(e.matchesCount);
        };
        this.bus.on('updatefindmatchescount', count);
        this.bus.on('updatefindcontrolstate', count);
        (this.viewer as { _link?: unknown })._link = link;
      }
      this.task?.destroy();
      const base = new URL('pdfjs/', document.baseURI).href;
      const task = pdfjs.getDocument({ url, disableAutoFetch: true, rangeChunkSize: 262144,
                                       cMapUrl: base + 'cmaps/', cMapPacked: true,
                                       standardFontDataUrl: base + 'standard_fonts/', wasmUrl: base + 'wasm/',
                                       iccUrl: base + 'iccs/' });
      this.task = task;
      this.doc = await task.promise;
      if (this.dead) return;
      this.viewer.setDocument(this.doc);
      this.viewer._link.setDocument(this.doc, null);
      this.pages.set(this.doc.numPages);
      this.page.set(1);
      this.state.set('ready');
    } catch (e) {
      if (this.dead) return;
      console.warn('pdf.js:', e);
      this.state.set('failed');
      const msg = (e as { name?: string })?.name === 'PasswordException'
        ? t('This PDF is protected by a password - download it to open it.')
        : t('The PDF could not be read - download it to open it elsewhere.');
      this.error.set(msg);
    }
  }

  go(n: number) {
    if (!this.viewer || !n) return;
    const p = Math.max(1, Math.min(this.pages(), Math.round(n)));
    this.viewer.currentPageNumber = p;
    this.page.set(p);
  }

  zoom(v: string) {
    if (!this.viewer) return;
    this.zoomKey.set(v);
    this.viewer.currentScaleValue = v;
  }

  zoomBy(dir: number) {
    if (!this.viewer) return;
    const now = this.scale();
    const next = dir > 0 ? ZOOMS.find(z => z > now + 0.01) ?? ZOOMS[ZOOMS.length - 1]
                         : [...ZOOMS].reverse().find(z => z < now - 0.01) ?? ZOOMS[0];
    this.zoom(String(next));
  }

  rotate() {
    if (!this.viewer) return;
    this.viewer.pagesRotation = (this.viewer.pagesRotation + 90) % 360;
    this.thumbs.set({});
  }

  find(query: string, previous: boolean) {
    this.q.set(query);
    if (!this.bus) return;
    if (!query) this.matches.set({ current: 0, total: 0 });
    this.bus.dispatch('find', { source: this, type: '', query, caseSensitive: false, entireWord: false,
                                highlightAll: true, findPrevious: previous, matchDiacritics: false });
  }

  again(previous: boolean) {
    if (!this.bus || !this.q()) return;
    this.bus.dispatch('find', { source: this, type: 'again', query: this.q(), caseSensitive: false, entireWord: false,
                                highlightAll: true, findPrevious: previous, matchDiacritics: false });
  }

  async drawThumb(n: number) {
    if (!this.doc || this.thumbs()[n]) return;
    try {
      const page = await this.doc.getPage(n);
      const rot = this.viewer?.pagesRotation ?? 0;
      const vp1 = page.getViewport({ scale: 1, rotation: page.rotate + rot });
      const vp = page.getViewport({ scale: 240 / vp1.width, rotation: page.rotate + rot });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
      const url = canvas.toDataURL('image/jpeg', 0.8);
      this.thumbs.update(m => ({ ...m, [n]: url }));
    } catch { /* a page that will not draw keeps its blank */ }
  }

  ngOnDestroy() {
    this.dead = true;
    try { this.viewer?.cleanup(); } catch { /* gone already */ }
    this.task?.destroy();
  }
}
