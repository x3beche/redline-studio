import { Component, ElementRef, Injectable, OnDestroy, computed, inject, input, signal } from '@angular/core';
import { FILE_THUMBS } from '../files-thumbs-pref';
import { Icon, StoredFile, extOf } from './files-model';

/** The small picture at the start of a row in the Files lists (and in
 *  Deleted files): a picture's, a PDF's first page, an STL's or a STEP's
 *  model, made by the server the first time it is asked for and kept by
 *  the file's content (backend/file_minis.py, `GET /api/files/{id}/mini`).
 *
 *  Until it is there - and for every other kind, a file too large, or one
 *  that cannot be read - the row shows the kind's icon in the same box, so
 *  the row never moves. Only rows that come into view ask, at most a few
 *  at once; one being made is asked again after the server's Retry-After.
 *  Settings > Appearance > Files turns them off (files-thumbs-pref.ts). */

const MB = 2 ** 20;
// As the server's file_minis.MAX_BYTES: larger is not asked for.
const MAX_BYTES: Record<string, number> = { image: 60 * MB, pdf: 60 * MB, stl: 80 * MB, glb: 60 * MB, step: 40 * MB };
const AT_ONCE = 3;
// A file still being made (a STEP's mesh first) is asked again for this long.
const RETRY_FOR_MS = 15 * 60_000;

/** What a picture is made of, or '' for a file that keeps its icon. */
export function miniKind(f: StoredFile): string {
  const ext = extOf(f.name);
  const k = f.preview === 'image' && ext !== 'svg' ? 'image'
    : f.preview === 'pdf' ? 'pdf'
    : f.preview === 'step' ? 'step'
    : f.preview === 'mesh' && (ext === 'stl' || ext === 'glb') ? ext : '';
  return k && f.bytes <= (MAX_BYTES[k] ?? 0) ? k : '';
}

/** The content a picture is of: copies of the same bytes share one. */
const keyOf = (f: StoredFile) => f.sha256 || `${f.id}.${f.bytes}.${f.created_at ?? ''}`;

type Job = { file: StoredFile; key: string; since: number; tries: number };

@Injectable({ providedIn: 'root' })
export class FileMinis {
  /** By content: an object URL, or null for a file that keeps its icon. */
  readonly got = signal<Record<string, string | null>>({});
  private asked = new Set<string>();
  private waiting: Job[] = [];
  private running = 0;

  url(f: StoredFile): string | null | undefined { return this.got()[keyOf(f)]; }

  /** A row came into view. Asked once per content while the page is open. */
  want(f: StoredFile) {
    if (!FILE_THUMBS() || !miniKind(f)) return;
    const key = keyOf(f);
    if (this.asked.has(key)) return;
    this.asked.add(key);
    this.waiting.push({ file: f, key, since: Date.now(), tries: 0 });
    this.pump();
  }

  /** The picture would not show: the icon, from now on. */
  failed(f: StoredFile) { this.set(keyOf(f), null); }

  private pump() {
    while (this.running < AT_ONCE && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.running++;
      this.ask(job).catch(() => this.set(job.key, null)).finally(() => { this.running--; this.pump(); });
    }
  }

  private async ask(job: Job) {
    const f = job.file;
    // The content in the address: the browser keeps the answer for good.
    const v = encodeURIComponent(f.sha256 ? f.sha256.slice(0, 16) : `${f.bytes}.${f.created_at ?? ''}`);
    const r = await fetch(`/api/files/${encodeURIComponent(f.id)}/mini?v=${v}`, { credentials: 'same-origin' });
    if (r.status === 200) {
      this.set(job.key, URL.createObjectURL(await r.blob()));
    } else if (r.status === 202 && Date.now() - job.since < RETRY_FOR_MS) {
      const after = Math.max(2, Number(r.headers.get('Retry-After')) || 2) * 1000;
      const wait = Math.min(after * 1.5 ** Math.min(job.tries, 5), 60_000);
      setTimeout(() => { this.waiting.push({ ...job, tries: job.tries + 1 }); this.pump(); }, wait);
    } else {
      this.set(job.key, null);
    }
  }

  private set(key: string, url: string | null) { this.got.update(g => ({ ...g, [key]: url })); }
}

@Component({
  selector: 'wb-fm-mini',
  imports: [Icon],
  host: { class: 'wb-fm-mini' },
  template: `@if (url(); as u) {
      <img [src]="u" alt="" [class.tcv-fm-solid]="solid()" [attr.data-kind]="kind()" (error)="minis.failed(file())">
    } @else { <i class="tcv-fm-kind-ico" [attr.data-ico]="icon()" [fmIcon]="icon()"></i> }`,
  styles: [`
    :host { display: inline-grid; flex: none; place-items: center; width: var(--tcv-fm-mini, 26px); height: var(--tcv-fm-mini, 26px); }
    img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; animation: wb-fm-mini-in .15s ease-out; }
    img[data-kind="pdf"], img[data-kind="image"] { border-radius: 2px; box-shadow: 0 0 0 1px var(--line); }
    @keyframes wb-fm-mini-in { from { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { img { animation: none; } }
  `],
})
export class FileMini implements OnDestroy {
  file = input.required<StoredFile>();
  icon = input.required<string>();
  minis = inject(FileMinis);
  kind = computed(() => miniKind(this.file()));
  solid = computed(() => ['step', 'stl', 'glb'].includes(this.kind()));
  url = computed(() => FILE_THUMBS() && this.kind() ? this.minis.url(this.file()) : null);
  private io?: IntersectionObserver;

  constructor() {
    const el = inject(ElementRef).nativeElement as HTMLElement;
    const ask = () => this.minis.want(this.file());
    if (typeof IntersectionObserver === 'undefined') { queueMicrotask(ask); return; }
    this.io = new IntersectionObserver(es => {
      // off, nothing is asked; the room is made again when Settings turns them on
      if (FILE_THUMBS() && es.some(e => e.isIntersecting)) { this.io?.disconnect(); ask(); }
    }, { rootMargin: '200px' });
    this.io.observe(el);
  }
  ngOnDestroy() { this.io?.disconnect(); }
}
