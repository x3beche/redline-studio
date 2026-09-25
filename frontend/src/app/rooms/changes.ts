import {
  Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal, untracked, viewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type * as Monaco from 'monaco-editor';
import { loadMonaco, redlineTheme } from './code-view';
import { T } from '../i18n';

/** What an agent's work on a note changed (backend/changes.py): each file
 *  before and after, side by side in VS Code's diff view, and the picture
 *  the note was drawn on against the one taken after - side by side, with
 *  a slider, or with the pixels that changed lit up. The record is the
 *  note's for good, so it can be looked at again at any time.
 */
interface ChangedFile {
  kind: 'model' | 'board'; id: string; added: number; removed: number;
  before_text: string; after_text: string;
}
interface Detail {
  recorded: boolean; since?: string; at?: string; files: ChangedFile[];
  pictures: { before: boolean; after: boolean };
}
type PicMode = 'side' | 'slider' | 'diff';

@Component({
  selector: 'app-changes',
  imports: [T],
  template: `
<div class="tcv-tokens-back" (click)="closed.emit()">
  <div class="tcv-changes" (click)="$event.stopPropagation()" role="dialog" aria-label="What this note changed">
    <header class="tcv-changes-head">
      <b>{{ 'What this note changed' | t }}</b>
      <span class="tcv-code-sub">{{ title() }}</span>
      <span class="grow"></span>
      @if (detail(); as d) {
        <span class="tcv-code-sub">{{ d.files.length }} file{{ d.files.length === 1 ? '' : 's' }}
          · <span class="tcv-diff-add">+{{ total().added }}</span> <span class="tcv-diff-del">−{{ total().removed }}</span></span>
      }
      @if (pick() !== 'pictures') {
        <button class="tcv-btn tcv-code-btn" (click)="side.set(!side())">{{ (side() ? 'Inline' : 'Side by side') | t }}</button>
      }
      <button class="tcv-btn tcv-code-btn" (click)="closed.emit()" title="Close">✕</button>
    </header>
    <div class="tcv-changes-main">
      <nav class="tcv-code-tree" aria-label="Changed files">
        <div class="tcv-code-tree-head">{{ 'Changed' | t }}</div>
        @for (f of detail()?.files ?? []; track f.kind + f.id; let i = $index) {
          <button class="tcv-code-node tcv-code-file" [attr.data-on]="pick() === i ? 1 : null" (click)="pick.set(i)"
                  [title]="f.id">
            <span class="tcv-code-ext" [attr.data-kind]="f.kind">{{ f.kind === 'board' ? 'ato' : 'py' }}</span>
            <span class="tcv-code-label">{{ name(f) }}</span>
            <span class="tcv-diff-counts"><span class="tcv-diff-add">+{{ f.added }}</span> <span class="tcv-diff-del">−{{ f.removed }}</span></span>
          </button>
        }
        @if (detail(); as d) {
          @if (!d.recorded) {
            <p class="tcv-code-tree-empty">This note was worked before Redline kept what a note changes - the pictures
              are all there is.</p>
          } @else if (!d.files.length) {
            <p class="tcv-code-tree-empty">No source changed.</p>
          }
          @if (d.pictures.before || d.pictures.after) {
            <button class="tcv-code-node tcv-code-file" [attr.data-on]="pick() === 'pictures' ? 1 : null"
                    (click)="pick.set('pictures')">
              <span class="tcv-code-ext">img</span><span class="tcv-code-label">{{ 'Before and after' | t }}</span></button>
          }
        }
      </nav>
      <div class="tcv-changes-pane">
        <div #diffHost class="tcv-code-editor" [hidden]="pick() === 'pictures'"></div>
        @if (pick() === 'pictures') {
          <div class="tcv-pics-bar">
            @for (m of modes; track m.id) {
              <button class="tcv-notes-chip" [attr.data-on]="mode() === m.id ? 1 : null" (click)="mode.set(m.id)">{{ m.label | t }}</button>
            }
            @if (mode() === 'diff') { <span class="tcv-code-sub">{{ diffNote() }}</span> }
          </div>
          @if (!detail()?.pictures?.after) {
            <p class="tcv-code-empty">No picture was taken after the work - only the one the note was drawn on.</p>
          }
          <div class="tcv-pics" [attr.data-mode]="mode()">
            @if (mode() === 'side') {
              <figure><img [src]="beforeUrl()" alt="Before"><figcaption>Before - as the note was drawn</figcaption></figure>
              @if (detail()?.pictures?.after) {
                <figure><img [src]="afterUrl()" alt="After"><figcaption>After the work</figcaption></figure>
              }
            } @else if (mode() === 'slider') {
              <div class="tcv-pics-slide" (pointermove)="slideAt($event)" (pointerdown)="slideAt($event)">
                <img [src]="afterUrl()" alt="After">
                <img class="tcv-pics-top" [src]="beforeUrl()" alt="Before" [style.clip-path]="'inset(0 ' + (100 - slide()) + '% 0 0)'">
                <span class="tcv-pics-rule" [style.left.%]="slide()"></span>
                <span class="tcv-pics-tag tcv-pics-l">before</span><span class="tcv-pics-tag tcv-pics-r">after</span>
              </div>
            } @else {
              <canvas #diffCanvas class="tcv-pics-canvas"></canvas>
            }
          </div>
        }
      </div>
    </div>
  </div>
</div>`,
})
export class Changes implements OnDestroy {
  private http = inject(HttpClient);
  rid = input.required<string>();
  title = input('');
  closed = output<void>();

  private diffHost = viewChild.required<ElementRef<HTMLDivElement>>('diffHost');
  private diffCanvas = viewChild<ElementRef<HTMLCanvasElement>>('diffCanvas');
  private m: typeof Monaco | null = null;
  private diff: Monaco.editor.IStandaloneDiffEditor | null = null;
  private models: Monaco.editor.ITextModel[] = [];

  readonly modes: { id: PicMode; label: string }[] = [
    { id: 'side', label: 'Side by side' }, { id: 'slider', label: 'Slider' }, { id: 'diff', label: 'What changed' }];
  detail = signal<Detail | null>(null);
  pick = signal<number | 'pictures'>(0);
  side = signal(true);
  mode = signal<PicMode>('slider');
  slide = signal(50);
  diffNote = signal('');
  total = computed(() => (this.detail()?.files ?? []).reduce(
    (t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 }));
  beforeUrl = () => `/api/revisions/${this.rid()}/image`;
  afterUrl = () => `/api/revisions/${this.rid()}/image?which=after`;

  constructor() {
    effect(() => {
      const id = this.rid();
      untracked(() => this.http.get<Detail>(`/api/revisions/${id}/changes`).subscribe(d => {
        this.detail.set(d);
        this.pick.set(d.files.length ? 0 : 'pictures');
      }));
    });
    // The picked file into the diff view.
    effect(() => {
      const d = this.detail(), p = this.pick(), side = this.side();
      if (!d || p === 'pictures') return;
      const f = d.files[p];
      if (f) untracked(() => void this.show(f, side));
    });
    // The difference picture, drawn when asked for.
    effect(() => {
      if (this.pick() === 'pictures' && this.mode() === 'diff' && this.diffCanvas()) untracked(() => this.drawDiff());
    });
  }

  name(f: ChangedFile) { return `${f.id.split('/').pop()}.${f.kind === 'board' ? 'ato' : 'py'}`; }

  private async show(f: ChangedFile, side: boolean) {
    const m = this.m ??= await loadMonaco();
    if (!this.diff) {
      this.diff = m.editor.createDiffEditor(this.diffHost().nativeElement, {
        theme: redlineTheme(m), readOnly: true, automaticLayout: true, renderSideBySide: side,
        fontSize: 13, scrollBeyondLastLine: false, originalEditable: false,
        fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
      });
    }
    this.diff.updateOptions({ renderSideBySide: side });
    const lang = f.kind === 'board' ? 'atopile' : 'python';
    const before = m.editor.createModel(f.before_text, lang);
    const after = m.editor.createModel(f.after_text, lang);
    this.diff.setModel({ original: before, modified: after });
    for (const old of this.models) old.dispose();
    this.models = [before, after];
  }

  slideAt(e: PointerEvent) {
    if (e.type === 'pointermove' && !(e.buttons & 1)) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.slide.set(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
  }

  /** The after picture, faded, with every pixel that differs from the
   *  before one painted in the accent colour. */
  private async drawDiff() {
    const load = (src: string) => new Promise<HTMLImageElement>((ok, fail) => {
      const img = new Image(); img.onload = () => ok(img); img.onerror = fail; img.src = src;
    });
    try {
      const [a, b] = await Promise.all([load(this.beforeUrl()), load(this.afterUrl())]);
      const c = this.diffCanvas()!.nativeElement;
      const w = c.width = b.naturalWidth, h = c.height = b.naturalHeight;
      const x = c.getContext('2d')!;
      x.drawImage(a, 0, 0, w, h);
      const pa = x.getImageData(0, 0, w, h);
      x.clearRect(0, 0, w, h);
      x.drawImage(b, 0, 0, w, h);
      const pb = x.getImageData(0, 0, w, h);
      const hot = getComputedStyle(c).getPropertyValue('color').match(/\d+/g)!.map(Number);
      let changed = 0;
      for (let i = 0; i < pb.data.length; i += 4) {
        const d = Math.abs(pa.data[i] - pb.data[i]) + Math.abs(pa.data[i + 1] - pb.data[i + 1])
                + Math.abs(pa.data[i + 2] - pb.data[i + 2]);
        if (d > 60) {
          changed++;
          pb.data[i] = hot[0]; pb.data[i + 1] = hot[1]; pb.data[i + 2] = hot[2];
        } else {
          // Everything else faded, so the change is what the eye finds.
          pb.data[i] = pb.data[i] * 0.35 + 160; pb.data[i + 1] = pb.data[i + 1] * 0.35 + 160;
          pb.data[i + 2] = pb.data[i + 2] * 0.35 + 160;
        }
      }
      x.putImageData(pb, 0, 0);
      this.diffNote.set(`${((changed / (w * h)) * 100).toFixed(1)}% of the picture changed`);
    } catch {
      this.diffNote.set('both pictures are needed for this');
    }
  }

  ngOnDestroy() {
    for (const md of this.models) md.dispose();
    this.diff?.dispose();
  }
}
