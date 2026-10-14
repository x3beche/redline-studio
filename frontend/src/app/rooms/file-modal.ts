import { HttpClient } from '@angular/common/http';
import { navBoxFollows } from '../nav';
import { Component, ElementRef, OnDestroy, computed, effect, inject, signal, viewChild } from '@angular/core';
import { T, t } from '../i18n';
import { Toast } from '../toast';
import { Selection } from '../selection';
import { FileView } from './file-view';
import { Icon, StoredFile, downloadUrl, iconOf, inlineUrl, size } from './files-model';
import { PdfReader } from './pdf-reader';

/** A file of the Files room shown over the Chat: a PDF the Chat made
 *  (chat_tools/pdf_make.py), a link to a file in an answer, an attached
 *  file's chip. A PDF is read with the Files tab's own reader (pdf.js,
 *  pdf-reader.ts); anything else with its preview (file-view.ts).
 *
 *    FileModal.open({ id, name: 'BOM comparison.pdf', pages: 3 });
 *
 *  What is passed in is shown at once; the rest (size, folder, who made
 *  it) comes from GET /api/files/{id}/info. One at a time; Esc closes.
 *  The box itself is <rl-file-modal />, mounted in the Chat (commandcode.ts). */
export interface FileAsk { id: string; name?: string; pages?: number }

interface FileInfo extends StoredFile { folder_path?: string }

const asked = signal<FileAsk | null>(null);

export class FileModal {
  static open(f: FileAsk) { asked.set({ ...f }); }
  static close() { asked.set(null); }
  static isOpen() { return asked() !== null; }
}

/** The file a link points at, if it is one of the Files room's on this
 *  site: /api/files/<id> (with ?inline=1 or not). */
export function fileIdOf(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, location.href);
    if (u.origin !== location.origin) return null;
    const m = /^\/api\/files\/([A-Za-z0-9]{6,32})$/.exec(u.pathname);
    return m ? m[1] : null;
  } catch { return null; }
}

@Component({
  selector: 'rl-file-modal',
  imports: [T, Icon, PdfReader, FileView],
  template: `
@if (cur(); as f) {
<div class="fm-scrim" animate.leave="tcv-leave" (mousedown)="downOnScrim = $event.target === $event.currentTarget"
     (click)="$event.target === $event.currentTarget && downOnScrim && close()">
  <div #card class="fm-card" role="dialog" aria-modal="true" aria-labelledby="fm-title" (keydown)="$event.stopPropagation()">
    <header class="fm-head">
      <i class="fm-ico" [fmIcon]="icon()"></i>
      <div class="fm-names">
        <h2 id="fm-title" class="fm-title" [title]="name()">{{ name() }}</h2>
        <div class="fm-meta">
          @if (pages()) { <span>{{ pages() }} {{ (pages() === 1 ? 'page' : 'pages') | t }}</span> }
          @if (info(); as i) {
            <span>{{ fmt(i.bytes) }}</span>
            <span class="fm-where">{{ 'Files' | t }} › {{ i.folder_path || ('My files' | t) }}</span>
            @if (i.by.name) { <span>{{ i.by.name }}</span> }
          }
        </div>
      </div>
      <div class="fm-acts">
        <a class="tcv-btn fm-btn" [href]="download()" download>{{ 'Download' | t }}</a>
        <button type="button" class="tcv-btn fm-btn" (click)="toFiles()">{{ 'Open in Files' | t }}</button>
        @if (info()?.ro) {
          <!-- What the app made is kept in its own area of Files: a copy of one's own, on asking -->
          <button type="button" class="tcv-btn fm-btn" (click)="saveMine()" [disabled]="saving()"
                  [title]="'A copy of your own, to rename, move or delete; this one stays' | t">{{ 'Save to My files' | t }}</button>
        }
        <button #closer type="button" class="fm-x" (click)="close()" [title]="('Close' | t) + ' (Esc)'"
                [attr.aria-label]="'Close' | t">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12 M18 6L6 18" /></svg></button>
      </div>
    </header>
    <div class="fm-body">
      @if (failed()) {
        <div class="fm-center">{{ failed() }}</div>
      } @else if (isPdf()) {
        <app-pdf-reader [src]="inline()" />
      } @else if (info(); as i) {
        <app-file-view [file]="i" />
      } @else {
        <div class="fm-center"><span class="tcv-fm-spin"></span></div>
      }
    </div>
  </div>
</div>
}`,
  styles: [`
.fm-scrim { position: fixed; inset: 0; z-index: 9000; display: flex; align-items: center; justify-content: center;
  padding: 24px; background: var(--scrim); }
.fm-card { display: flex; flex-direction: column; width: min(1080px, 100%); height: min(940px, 100%); min-height: 0;
  box-sizing: border-box; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 8px;
  box-shadow: 0 12px 36px var(--shadow-hard); overflow: hidden; }
.fm-head { display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 14px; border-bottom: 1px solid var(--line); }
.fm-ico { flex: none; width: 22px; height: 22px; color: var(--ink-dim); }
.fm-ico ::ng-deep svg { width: 22px; height: 22px; }
.fm-names { flex: 1; min-width: 0; }
.fm-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fm-meta { display: flex; flex-wrap: wrap; gap: 0 12px; margin-top: 1px; font-size: 11.5px; color: var(--ink-dim); }
.fm-where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
.fm-acts { flex: none; display: flex; align-items: center; gap: 6px; }
.fm-btn { height: 28px; padding: 0 12px; font-size: 12.5px; display: inline-flex; align-items: center; text-decoration: none; color: var(--ink); }
.fm-btn:focus-visible, .fm-x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.fm-x { width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 5px;
  background: none; color: var(--ink-dim); cursor: pointer; }
.fm-x:hover { background: var(--hover); color: var(--ink); }
.fm-x svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
.fm-body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--surface-2); }
.fm-center { margin: auto; padding: 24px; font-size: 12.5px; color: var(--ink-dim); }
@media (max-width: 640px) {
  .fm-scrim { padding: 0; }
  .fm-card { width: 100%; height: 100%; border-radius: 0; border: 0; }
  .fm-head { flex-wrap: wrap; }
  .fm-acts { width: 100%; justify-content: flex-end; }
}
`],
})
export class FileModalHost implements OnDestroy {
  private http = inject(HttpClient);
  private sel = inject(Selection);
  cur = asked;
  info = signal<FileInfo | null>(null);
  failed = signal('');
  downOnScrim = false;
  private reader = viewChild(PdfReader);
  private closer = viewChild<ElementRef<HTMLButtonElement>>('closer');
  private back: HTMLElement | null = null;
  private seq = 0;

  name = computed(() => this.info()?.name || this.cur()?.name || t('File'));
  /** pdf.js's count once the file is open; until then what the step said. */
  pages = computed(() => this.reader()?.pages() || this.cur()?.pages || 0);
  isPdf = computed(() => {
    const i = this.info();
    if (i) return i.preview === 'pdf';
    return /\.pdf$/i.test(this.cur()?.name ?? '') || !!this.cur()?.pages;
  });
  icon = computed(() => this.info() ? iconOf(this.info()!) : this.isPdf() ? 'pdf' : 'file');
  inline = computed(() => inlineUrl(this.cur()?.id ?? ''));
  download = computed(() => downloadUrl(this.cur()?.id ?? ''));

  constructor() {
    effect(() => {
      const f = this.cur();
      const n = ++this.seq;
      this.info.set(null);
      this.failed.set('');
      if (!f) return;
      if (!this.back) this.back = document.activeElement as HTMLElement | null;
      setTimeout(() => this.closer()?.nativeElement.focus());
      this.http.get<FileInfo>(`/api/files/${encodeURIComponent(f.id)}/info`).subscribe({
        next: i => { if (n === this.seq) this.info.set(i); },
        error: e => {
          if (n !== this.seq) return;
          this.failed.set(e?.status === 404 ? t('This file is no longer in Files.') : t('The file could not be opened.'));
        },
      });
    });
    window.addEventListener('keydown', this.key, true);
    // Open, it has a history entry of its own: Back closes it (nav.ts).
    navBoxFollows(this.cur, () => this.close());
  }

  ngOnDestroy() {
    window.removeEventListener('keydown', this.key, true);
    asked.set(null);
  }

  close() {
    asked.set(null);
    const back = this.back;
    this.back = null;
    if (back?.isConnected) back.focus();
  }

  saving = signal(false);
  saveMine() {
    const id = this.cur()?.id;
    if (!id) return;
    this.saving.set(true);
    this.http.post<StoredFile>(`/api/files/${encodeURIComponent(id)}/copy`, {}).subscribe({
      next: c => { this.saving.set(false); Toast.show(`${t('Saved to My files')}: ${c.name}`, { tone: 'ok' }); },
      error: () => { this.saving.set(false); Toast.show(t('Could not save it to My files.'), { tone: 'danger' }); },
    });
  }

  toFiles() {
    const id = this.cur()?.id;
    if (!id) return;
    this.close();
    this.sel.room.set('files');
    this.sel.ask('file', id);
  }

  fmt(b: number) { return size(b); }

  /** Esc closes the viewer - and only that: the Chat's own Esc (stop the
   *  answer, close the list) is not reached while it is open. */
  private key = (e: KeyboardEvent) => {
    if (!this.cur() || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.close();
  };
}
