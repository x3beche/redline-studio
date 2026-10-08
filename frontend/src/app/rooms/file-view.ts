import {
  Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal, untracked, viewChild,
} from '@angular/core';
import type * as Monaco from 'monaco-editor';
import { T, t } from '../i18n';
import { toHtml } from '../markdown';
import { loadMonaco, redlineTheme } from './code-view';
import {
  ArchiveData, FilesApi, Icon, StoredFile, TableData, downloadUrl, iconOf, inlineUrl, languageOf, meshUrl, size,
} from './files-model';
import { MeshView } from './mesh-view';
import { PdfReader } from './pdf-reader';

/** One file, shown in place: the body of the Files tab's preview. What it
 *  is decides how - `preview` comes from the server (files.preview_of). */

const TEXT_MAX = 2 * 1024 * 1024;

export function decodeText(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  return new TextDecoder('utf-8').decode(b);
}

@Component({
  selector: 'app-file-view',
  imports: [T, Icon, PdfReader, MeshView],
  host: { class: 'tcv-fv' },
  template: `
@switch (file().preview) {
  @case ('image') {
    <div #stage class="tcv-fv-img" (wheel)="wheel($event)" (pointerdown)="grab($event)" (dblclick)="toggle1to1($event)"
         [attr.data-zoomed]="zoom() !== null ? 1 : null">
      <img [src]="url()" [alt]="file().name" (load)="loaded($event)" draggable="false"
           [style.transform]="'translate(-50%, -50%) translate(' + tx() + 'px,' + ty() + 'px) scale(' + scale() + ')'">
      @if (!natural()) { <div class="tcv-fm-center"><span class="tcv-fm-spin"></span></div> }
    </div>
    <div class="tcv-fv-zoom" role="toolbar" [attr.aria-label]="'Zoom' | t">
      <button class="tcv-fm-icon-btn" (click)="zoomBy(1 / 1.25)" [title]="'Zoom out' | t" [attr.aria-label]="'Zoom out' | t"><i [fmIcon]="'zoomout'"></i></button>
      <button class="tcv-fv-pct" (click)="fit()" [title]="'Fit to the window' | t">{{ pct() }}%</button>
      <button class="tcv-fm-icon-btn" (click)="zoomBy(1.25)" [title]="'Zoom in' | t" [attr.aria-label]="'Zoom in' | t"><i [fmIcon]="'zoomin'"></i></button>
      <button class="tcv-fv-pct" (click)="actual()" [title]="'Actual size' | t">1:1</button>
    </div>
  }
  @case ('video') {
    <div class="tcv-fv-media"><video [src]="url()" controls playsinline preload="metadata"></video></div>
  }
  @case ('audio') {
    <div class="tcv-fv-audio">
      <i class="tcv-fv-big" [fmIcon]="'audio'"></i>
      <b>{{ file().name }}</b>
      <audio [src]="url()" controls preload="metadata"></audio>
    </div>
  }
  @case ('pdf') { <app-pdf-reader [src]="url()" /> }
  @case ('mesh') { <app-mesh-view [src]="url()" [name]="file().name" /> }
  @case ('step') {
    <app-mesh-view [src]="meshUrl()" [name]="file().name" [step]="true" />
    @if (file().model || canEdit()) {
      <div class="tcv-fv-actions">
        @if (file().model) {
          <button class="tcv-btn tcv-fm-btn" (click)="act.emit('open-model')">{{ 'Open in 3D Drawing' | t }}</button>
        } @else {
          <button class="tcv-btn tcv-fm-btn" (click)="act.emit('add')" [title]="'Copies it into a project folder as a model of its own, and builds it' | t">{{ 'Add to project' | t }}</button>
        }
      </div>
    }
  }
  @case ('table') {
    @if (table(); as tb) {
      <div class="tcv-fv-table-wrap">
        @if (tb.sheets.length > 1) {
          <div class="tcv-fv-sheets" role="tablist">
            @for (s of tb.sheets; track $index) {
              <button role="tab" [attr.aria-selected]="$index === tb.sheet" [attr.data-on]="$index === tb.sheet ? 1 : null"
                      (click)="loadTable($index)">{{ s }}</button>
            }
          </div>
        }
        <div class="tcv-fv-table-scroll">
          <table class="tcv-fv-table">
            @if (tb.rows.length) {
              <thead><tr><th class="tcv-fv-rn"></th>@for (c of tb.rows[0]; track $index) { <th>{{ c }}</th> }</tr></thead>
            }
            <tbody>
              @for (r of tb.rows.slice(1); track $index) {
                <tr><td class="tcv-fv-rn">{{ $index + 2 }}</td>@for (c of r; track $index) { <td>{{ c }}</td> }</tr>
              }
            </tbody>
          </table>
        </div>
        @if (tb.truncated) { <p class="tcv-fv-foot">{{ 'Showing the first' | t }} {{ tb.rows.length }} {{ 'of' | t }} {{ tb.total }} {{ 'rows - download it for the rest.' | t }}</p> }
      </div>
    } @else if (failed()) { <div class="tcv-fm-center tcv-fm-err">{{ failed() }}</div> }
    @else { <div class="tcv-fm-center"><span class="tcv-fm-spin"></span></div> }
  }
  @case ('archive') {
    @if (archive(); as ar) {
      <div class="tcv-fv-table-wrap">
        <p class="tcv-fv-head">{{ ar.total }} {{ 'items' | t }} · {{ fmt(ar.bytes) }} {{ 'unpacked' | t }}</p>
        <div class="tcv-fv-table-scroll">
          <table class="tcv-fv-table tcv-fv-entries">
            <thead><tr><th>{{ 'Name' | t }}</th><th class="tcv-fv-num">{{ 'Size' | t }}</th></tr></thead>
            <tbody>
              @for (e of ar.entries; track $index) {
                <tr [attr.data-dir]="e.dir ? 1 : null"><td>{{ e.name }}</td><td class="tcv-fv-num">{{ e.dir ? '' : fmt(e.bytes) }}</td></tr>
              }
            </tbody>
          </table>
        </div>
        @if (ar.truncated) { <p class="tcv-fv-foot">{{ 'Only the first entries are listed.' | t }}</p> }
      </div>
    } @else if (failed()) { <div class="tcv-fm-center tcv-fm-err">{{ failed() }}</div> }
    @else { <div class="tcv-fm-center"><span class="tcv-fm-spin"></span></div> }
  }
  @case ('markdown') {
    @if (text() !== null) {
      <div class="tcv-fv-mdbar">
        <div class="tcv-fm-seg" role="group">
          <button [attr.data-on]="!source() ? 1 : null" (click)="source.set(false)">{{ 'Rendered' | t }}</button>
          <button [attr.data-on]="source() ? 1 : null" (click)="showSource()">{{ 'Source' | t }}</button>
        </div>
      </div>
      @if (!source()) {
        <div class="tcv-fv-md-scroll"><article class="md tcv-fv-md" [innerHTML]="html()"></article></div>
      } @else {
        <div #code class="tcv-fv-code"></div>
      }
      @if (cut()) { <p class="tcv-fv-foot">{{ 'Showing the first 2 MB - download it for the rest.' | t }}</p> }
    } @else if (failed()) { <div class="tcv-fm-center tcv-fm-err">{{ failed() }}</div> }
    @else { <div class="tcv-fm-center"><span class="tcv-fm-spin"></span></div> }
  }
  @case ('text') {
    @if (text() !== null) {
      <div #code class="tcv-fv-code">@if (plain()) { <pre class="tcv-fv-pre">{{ text() }}</pre> }</div>
      @if (cut()) { <p class="tcv-fv-foot">{{ 'Showing the first 2 MB - download it for the rest.' | t }}</p> }
    } @else if (failed()) { <div class="tcv-fm-center tcv-fm-err">{{ failed() }}</div> }
    @else { <div class="tcv-fm-center"><span class="tcv-fm-spin"></span></div> }
  }
  @default {
    <div class="tcv-fv-none">
      <i class="tcv-fv-big" [fmIcon]="icon()"></i>
      <b>{{ file().name }}</b>
      <p>{{ 'There is no preview for this kind of file.' | t }} {{ fmt(file().bytes) }}</p>
      <a class="tcv-btn tcv-btn-accent tcv-fm-btn" [href]="dl()" [attr.download]="file().name">{{ 'Download' | t }}</a>
    </div>
  }
}`,
})
export class FileView implements OnDestroy {
  file = input.required<StoredFile>();
  canEdit = input(false);
  act = output<'add' | 'open-model'>();
  private api = inject(FilesApi);
  private stage = viewChild<ElementRef<HTMLDivElement>>('stage');
  private code = viewChild<ElementRef<HTMLDivElement>>('code');

  url = computed(() => inlineUrl(this.file().id));
  meshUrl = computed(() => meshUrl(this.file().id));
  dl = computed(() => downloadUrl(this.file().id));
  icon = computed(() => iconOf(this.file()));
  fmt = size;

  // what was read of it
  text = signal<string | null>(null);
  cut = signal(false);
  failed = signal('');
  table = signal<TableData | null>(null);
  archive = signal<ArchiveData | null>(null);
  source = signal(false);
  plain = signal(false);
  html = computed(() => toHtml(this.text() ?? ''));
  private editor?: Monaco.editor.IStandaloneCodeEditor;

  // the picture: null zoom is "fit"
  natural = signal<{ w: number; h: number } | null>(null);
  zoom = signal<number | null>(null);
  tx = signal(0);
  ty = signal(0);
  private box = signal({ w: 1, h: 1 });
  private fitScale = computed(() => {
    const n = this.natural(), b = this.box();
    return n ? Math.min(1, (b.w - 32) / n.w, (b.h - 32) / n.h) : 1;
  });
  scale = computed(() => this.zoom() ?? this.fitScale());
  pct = computed(() => Math.round(this.scale() * 100));
  private resize?: ResizeObserver;

  constructor() {
    effect(() => {
      const f = this.file();
      untracked(() => this.read(f));
    });
    effect(() => {
      const el = this.stage()?.nativeElement;
      this.resize?.disconnect();
      if (!el) return;
      this.resize = new ResizeObserver(() => this.box.set({ w: el.clientWidth, h: el.clientHeight }));
      this.resize.observe(el);
    });
    // Monaco goes into the code box once there is one and text to show.
    effect(() => {
      const el = this.code()?.nativeElement, text = this.text();
      if (!el || text === null) return;
      untracked(() => void this.mount(el, text));
    });
  }

  private read(f: StoredFile) {
    this.text.set(null);
    this.cut.set(false);
    this.failed.set('');
    this.table.set(null);
    this.archive.set(null);
    this.source.set(false);
    this.plain.set(false);
    this.natural.set(null);
    this.zoom.set(null);
    this.tx.set(0);
    this.ty.set(0);
    this.editor?.dispose();
    this.editor = undefined;
    const why = (e: { error?: { detail?: unknown } }, fallback: string) =>
      this.failed.set(typeof e?.error?.detail === 'string' ? e.error.detail : t(fallback));
    if (f.preview === 'text' || f.preview === 'markdown') {
      this.api.head(f.id, TEXT_MAX).subscribe({
        next: buf => {
          if (this.file().id !== f.id) return;
          this.cut.set(f.bytes > TEXT_MAX);
          this.text.set(decodeText(buf));
        },
        error: () => this.failed.set(t('The file could not be read.')),
      });
    } else if (f.preview === 'table') {
      this.loadTable(0);
    } else if (f.preview === 'archive') {
      this.api.entries(f.id).subscribe({
        next: a => { if (this.file().id === f.id) this.archive.set(a); },
        error: e => why(e, 'The archive could not be read.'),
      });
    }
  }

  loadTable(sheet: number) {
    const id = this.file().id;
    this.api.table(id, sheet).subscribe({
      next: tb => { if (this.file().id === id) this.table.set(tb); },
      error: e => this.failed.set(typeof e?.error?.detail === 'string' ? e.error.detail : t('The table could not be read.')),
    });
  }

  showSource() { this.source.set(true); }

  private async mount(el: HTMLElement, text: string) {
    try {
      const m = await loadMonaco();
      if (!el.isConnected || this.text() !== text) return;
      this.editor?.dispose();
      el.replaceChildren();
      this.editor = m.editor.create(el, {
        value: text, language: this.file().preview === 'markdown' ? 'markdown' : languageOf(this.file().name),
        readOnly: true, domReadOnly: true, theme: redlineTheme(m), automaticLayout: true,
        minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 12.5, lineNumbersMinChars: 4,
        renderLineHighlight: 'none', contextmenu: false, wordWrap: 'off', folding: true,
      });
    } catch {
      this.plain.set(true);
    }
  }

  // ---- the picture
  loaded(e: Event) {
    const img = e.target as HTMLImageElement;
    this.natural.set({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    const el = this.stage()?.nativeElement;
    if (el) this.box.set({ w: el.clientWidth, h: el.clientHeight });
  }
  fit() { this.zoom.set(null); this.tx.set(0); this.ty.set(0); }
  actual() { this.zoom.set(1); this.tx.set(0); this.ty.set(0); }
  zoomBy(f: number, at?: { x: number; y: number }) {
    const old = this.scale();
    const next = Math.max(0.05, Math.min(16, old * f));
    if (at) {
      // keep the point under the cursor where it is
      this.tx.set(at.x - (at.x - this.tx()) * next / old);
      this.ty.set(at.y - (at.y - this.ty()) * next / old);
    } else {
      this.tx.set(this.tx() * next / old);
      this.ty.set(this.ty() * next / old);
    }
    this.zoom.set(next);
  }
  wheel(e: WheelEvent) {
    e.preventDefault();
    const el = this.stage()!.nativeElement.getBoundingClientRect();
    this.zoomBy(Math.exp(-e.deltaY * 0.0015), { x: e.clientX - el.left - el.width / 2, y: e.clientY - el.top - el.height / 2 });
  }
  toggle1to1(e: MouseEvent) {
    if (this.zoom() === null) {
      const el = this.stage()!.nativeElement.getBoundingClientRect();
      this.zoomBy(1 / this.scale(), { x: e.clientX - el.left - el.width / 2, y: e.clientY - el.top - el.height / 2 });
    } else this.fit();
  }
  grab(e: PointerEvent) {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const x0 = e.clientX - this.tx(), y0 = e.clientY - this.ty();
    el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => { this.tx.set(m.clientX - x0); this.ty.set(m.clientY - y0); if (this.zoom() === null) this.zoom.set(this.scale()); };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }

  ngOnDestroy() {
    this.resize?.disconnect();
    this.editor?.dispose();
  }
}
