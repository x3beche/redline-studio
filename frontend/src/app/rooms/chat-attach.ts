import { Component, computed, input, signal } from '@angular/core';
import { HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { T, t } from '../i18n';
import { FilesApi, inlineUrl, thumbUrl } from './files-model';

/** Pictures (and other files) sent straight from a chat composer - pasted
 *  (Ctrl+V), dropped on the composer or the thread, or picked with the
 *  paperclip - in a room's agent thread and in an AI conversation alike.
 *
 *  Each one is uploaded through the Files tab's own upload (FilesApi.upload,
 *  into its "Chat" folder, bytes as they came) and then rides on the line
 *  as a file mention, exactly as an `@` mention of it would: the model, the
 *  room's agent (tools/revisions.py chat prints its id and the command that
 *  fetches it), the history and the search all take it from there. */

export const PAPERCLIP = 'M20.5 11.2l-8.3 8.3a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9';
/** The Files tab's limit (backend/files.py MAX_BYTES, REDLINE_FILE_MAX_MB); the server says again if it is set lower. */
const MAX_MB = 200;
const FOLDER = 'Chat';
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?|heic)$/i;

export interface Pending {
  key: string; name: string; bytes: number; image: boolean;
  /** A local picture of it, until it is sent. */
  url: string | null;
  state: 'wait' | 'up' | 'done' | 'error';
  pct: number; id?: string; error?: string;
}

/** A mention that is a picture: shown as one, not as a chip. */
export function isPicture(m: { kind: string; label?: string; image?: boolean; sub?: string }): boolean {
  return m.kind === 'file' && (!!m.image || /^image\b/.test(m.sub ?? '') || IMAGE_NAME.test(m.label ?? ''));
}

/** One composer's attachments: what waits to go with the next line. */
export class ChatAttach {
  items = signal<Pending[]>([]);
  /** A file is being dragged over the composer or the thread. */
  over = signal(false);
  error = signal<string | null>(null);
  busy = computed(() => this.items().some(p => p.state === 'wait' || p.state === 'up'));
  /** The uploaded ones, ready to go as mentions. */
  ready = computed(() => this.items().filter(p => p.state === 'done' && p.id));
  pictures = computed(() => this.items().some(p => p.image && p.state !== 'error'));
  private subs = new Map<string, Subscription>();
  private files = new Map<string, File>();
  private seq = 0;

  /** `room` goes with the upload as its context; `left` is how many more the line may carry. */
  constructor(private api: FilesApi, private room: () => string, private left: () => number = () => 8) {}

  add(list: File[]) {
    this.error.set(null);
    let room = this.left() - this.items().filter(p => p.state !== 'error').length;
    for (const raw of list) {
      if (room <= 0) { this.error.set(t('At most 8 attachments go with one message.')); break; }
      const f = this.named(raw);
      const key = 'a' + (++this.seq);
      const image = /^image\//.test(f.type) || IMAGE_NAME.test(f.name);
      const p: Pending = { key, name: f.name, bytes: f.size, image, url: image ? URL.createObjectURL(f) : null,
                           state: 'wait', pct: 0 };
      if (f.size > MAX_MB * 1024 * 1024) {
        p.state = 'error'; p.error = `${t('Too big')} - ${t('at most')} ${MAX_MB} MB`;
        this.error.set(`${f.name}: ${p.error}`);
      } else {
        this.files.set(key, f);
        room--;
      }
      this.items.update(l => [...l, p]);
    }
    this.next();
  }

  /** One at a time: they share one "Chat" folder, made by the first. */
  private next() {
    if (this.items().some(p => p.state === 'up')) return;
    const p = this.items().find(x => x.state === 'wait');
    if (!p) return;
    const f = this.files.get(p.key)!;
    this.patch(p.key, { state: 'up', pct: 0 });
    const sub = this.api.upload([f], { room: this.room() }, '', '', FOLDER).subscribe({
      next: ev => {
        if (ev.type === HttpEventType.UploadProgress && ev.total) {
          this.patch(p.key, { pct: Math.round(100 * ev.loaded / ev.total) });
        } else if (ev.type === HttpEventType.Response) {
          const got = ev.body?.[0];
          this.patch(p.key, got ? { state: 'done', pct: 100, id: got.id, image: p.image || got.kind === 'image' }
                                : { state: 'error', error: t('The upload failed.') });
          this.done(p.key);
          this.api.bump();
        }
      },
      error: (err: HttpErrorResponse) => {
        const why = typeof err.error?.detail === 'string' ? err.error.detail
          : err.status === 413 ? t('Too big') : t('The upload failed.');
        this.patch(p.key, { state: 'error', error: why });
        this.error.set(`${p.name}: ${why}`);
        this.done(p.key);
      },
    });
    this.subs.set(p.key, sub);
  }

  private done(key: string) {
    this.subs.delete(key);
    this.files.delete(key);
    this.next();
  }

  /** Taken off before it was sent: an upload stopped, or the file just
   *  kept taken out of Files again - it was only there for this line. */
  remove(key: string) {
    const p = this.items().find(x => x.key === key);
    if (!p) return;
    this.subs.get(key)?.unsubscribe();
    this.subs.delete(key);
    this.files.delete(key);
    if (p.id) this.api.remove(p.id).subscribe({ next: () => this.api.bump(), error: () => {} });
    if (p.url) URL.revokeObjectURL(p.url);
    this.items.update(l => l.filter(x => x.key !== key));
    if (!this.items().some(x => x.state === 'error')) this.error.set(null);
    this.next();
  }

  /** Sent: the chips go (the files stay in Files, mentioned by the line). */
  clear() {
    for (const s of this.subs.values()) s.unsubscribe();
    this.subs.clear();
    this.files.clear();
    // The local pictures stay valid a moment longer for the line drawn from them.
    const urls = this.items().map(p => p.url).filter((u): u is string => !!u);
    setTimeout(() => urls.forEach(u => URL.revokeObjectURL(u)), 60_000);
    this.items.set([]);
    this.error.set(null);
  }

  /** Put back after a send that failed. */
  restore(items: Pending[]) { if (!this.items().length) this.items.set(items); }

  // ---- where files come from

  /** Ctrl+V: files on the clipboard are attached; text pastes as text. */
  paste(e: ClipboardEvent) {
    const got = [...(e.clipboardData?.files ?? [])];
    if (!got.length) {
      for (const it of [...(e.clipboardData?.items ?? [])]) {
        const f = it.kind === 'file' ? it.getAsFile() : null;
        if (f) got.push(f);
      }
    }
    if (!got.length) return;
    e.preventDefault();
    this.add(got);
  }

  dragOver(e: DragEvent) {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    this.over.set(true);
  }
  dragLeave(e: DragEvent) {
    const to = e.relatedTarget as Node | null;
    if (!to || !(e.currentTarget as HTMLElement).contains(to)) this.over.set(false);
  }
  drop(e: DragEvent) {
    this.over.set(false);
    const got = [...(e.dataTransfer?.files ?? [])];
    if (!got.length) return;
    e.preventDefault();
    this.add(got);
  }
  pick(e: Event) {
    const input = e.target as HTMLInputElement;
    const got = [...(input.files ?? [])];
    input.value = '';
    if (got.length) this.add(got);
  }

  private patch(key: string, v: Partial<Pending>) {
    this.items.update(l => l.map(p => p.key === key ? { ...p, ...v } : p));
  }

  /** A pasted screenshot comes as "image.png": named after when it was taken, so Files can tell them apart. */
  private named(f: File): File {
    if (!/^image\.\w+$/i.test(f.name) && f.name) return f;
    const d = new Date(), z = (n: number) => String(n).padStart(2, '0');
    const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\W.*$/, '');
    const stamp = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
    return new File([f], `chat-${stamp}-${this.seq + 1}.${ext}`, { type: f.type, lastModified: f.lastModified });
  }
}

/** The pending attachments as chips in the composer: a thumbnail, the
 *  name, the upload going, an x. */
@Component({
  selector: 'rl-attach-chips',
  imports: [T],
  template: `
@for (p of att().items(); track p.key) {
  <!-- A picture is a tile of itself; another file a chip with its name. The x
       sits on the top-right corner of either, over its edge. -->
  <span class="tcv-att-chip" [class.tcv-att-tile]="!!p.url" [attr.data-state]="p.state" [title]="p.error || p.name">
    @if (p.url) { <img class="tcv-att-thumb" [src]="p.url" [alt]="p.name" /> }
    @else {
      <svg class="tcv-cc-ico tcv-att-file" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="CLIP" /></svg>
      <span class="tcv-att-name">{{ p.name }}</span>
    }
    @if (p.state === 'up' || p.state === 'wait') {
      <span class="tcv-att-bar" role="progressbar" [attr.aria-valuenow]="p.pct" [attr.aria-label]="'Uploading…' | t"><i [style.width.%]="p.pct"></i></span>
    } @else if (p.state === 'error') { <span class="tcv-att-err">!</span> }
    <button type="button" class="tcv-att-x" (click)="att().remove(p.key)" [title]="'Remove' | t"
            [attr.aria-label]="('Remove' | t) + ': ' + p.name">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10 M17 7L7 17" /></svg></button>
  </span>
}
@if (att().error(); as e) { <span class="tcv-att-msg" role="alert">{{ e }}</span> }
`,
  host: { style: 'display: contents' },
})
export class AttachChips {
  att = input.required<ChatAttach>();
  readonly CLIP = PAPERCLIP;
}

/** A line's pictures, as pictures: a click opens the full one in a new tab. */
@Component({
  selector: 'rl-mention-pics',
  template: `
<div class="tcv-att-pics">
  @for (m of pics(); track m.id) {
    <a class="tcv-att-pic" [href]="full(m.id)" target="_blank" rel="noopener" [title]="m.label">
      <img [src]="small(m.id)" [alt]="m.label" loading="lazy" (error)="fallback($event, m.id)" />
    </a>
  }
</div>
`,
  host: { style: 'display: contents' },
})
export class MentionPics {
  mentions = input<{ kind: string; id: string; label: string; image?: boolean; sub?: string }[] | undefined>([]);
  pics = computed(() => (this.mentions() ?? []).filter(isPicture));
  full = inlineUrl;
  small = thumbUrl;
  /** No small picture (an SVG, or one too large to make one of): the picture itself. */
  fallback(e: Event, id: string) {
    const img = e.target as HTMLImageElement;
    if (!img.dataset['full']) { img.dataset['full'] = '1'; img.src = inlineUrl(id); }
  }
}
