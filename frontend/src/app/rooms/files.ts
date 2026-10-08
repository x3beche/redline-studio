import { Component, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpEventType } from '@angular/common/http';
import { Selection } from '../selection';
import { Auth } from '../auth';
import { T, t } from '../i18n';
import { AGENT_ROOMS } from './notes';
import { Catalog, FolderNode } from '../api';

/** Files: anything the work needs that is not a model or a board.
 *
 *  A BOM for a board that came in as bare Gerbers, a pick-and-place file,
 *  a datasheet, a photo of the bench. Drop it here and it is kept as it
 *  came, with who brought it and the board it is for. The kind is read
 *  from the name and a table's header row (backend/files.py), so a BOM is
 *  known as one, and "Send to agent" puts a line in a room's thread that
 *  says what the file is and the command that fetches it.
 */
export interface StoredFile {
  id: string; name: string; bytes: number; kind: string; content_type: string;
  context: { room?: string; model?: string; board?: string };
  by: { name?: string; id?: string }; note: string; created_at: string;
  sent?: { room: string; at: string };
}

const KIND_ICON: Record<string, string> = {
  bom: '☰', 'pick-place': '⌖', gerber: '▦', drill: '◎', step: '⬢', mesh: '◆', image: '▣',
  pdf: '▤', table: '▥', archive: '▧', text: '≡', other: '□',
};
const KIND_LABEL: Record<string, string> = {
  bom: 'BOM', 'pick-place': 'Pick & place', gerber: 'Gerber', drill: 'Drill', step: 'STEP', mesh: '3D mesh',
  image: 'Image', pdf: 'PDF', table: 'Table', archive: 'Archive', text: 'Text', other: 'Other',
};
const ROOM_LABEL: Record<string, string> = {
  cad: '3D Drawing', pcb: 'PCB Design',
};

@Injectable({ providedIn: 'root' })
export class FilesApi {
  private http = inject(HttpClient);
  /** Bumped when a file is added or removed anywhere. */
  changed = signal(0);

  list(q: string, kind: string, board: string) {
    const p = new URLSearchParams({ q, kind, board });
    return this.http.get<StoredFile[]>(`/api/files?${p}`);
  }
  boards() { return this.http.get<{ _id: string; title?: string }[]>('/api/boards'); }
  upload(files: File[], context: object, note: string) {
    const form = new FormData();
    for (const f of files) form.append('upload', f, f.name);
    form.append('context', JSON.stringify(context));
    form.append('note', note);
    return this.http.post<StoredFile[]>('/api/files', form, { reportProgress: true, observe: 'events' });
  }
  update(id: string, patch: { note?: string; board?: string }) {
    return this.http.patch<StoredFile>(`/api/files/${id}`, patch);
  }
  remove(id: string) { return this.http.delete(`/api/files/${id}`); }
  send(id: string, room: string) { return this.http.post(`/api/files/${id}/send`, { room }); }
  /** A STEP or mesh copied into a project folder as a model of its own. */
  toModel(id: string, folder: string, title: string) {
    return this.http.post<{ model: string; title: string }>(`/api/files/${id}/to-model`, { folder, title });
  }
}

@Component({
  selector: 'app-room-files',
  imports: [T],
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 gap-1 p-1">
  <!-- LEFT: find a file -->
  <aside class="tcv-notes-side">
    <div class="tcv-notes-find">
      <input class="tcv-notes-search" [placeholder]="'Search files' | t" [value]="q()"
             (input)="q.set($any($event.target).value)" (keydown.escape)="q.set('')">
    </div>
    <div class="tcv-notes-filters">
      <button class="tcv-notes-chip" [attr.data-on]="!kind() ? 1 : null" (click)="kind.set('')">
        {{ 'All' | t }} <em>{{ all().length }}</em></button>
      @for (k of kinds(); track k.kind) {
        <button class="tcv-notes-chip" [attr.data-on]="kind() === k.kind ? 1 : null"
                (click)="kind.set(kind() === k.kind ? '' : k.kind)">
          {{ kindLabel(k.kind) | t }} <em>{{ k.n }}</em></button>
      }
    </div>
    @if (boardsUsed().length) {
      <div class="tcv-notes-group">{{ 'Boards' | t }}</div>
      <div class="tcv-notes-filters">
        @for (b of boardsUsed(); track b) {
          <button class="tcv-notes-chip" [attr.data-on]="board() === b ? 1 : null"
                  (click)="board.set(board() === b ? '' : b)">&#64;{{ b }}</button>
        }
      </div>
    }
    <p class="tcv-files-help">{{ 'A BOM linked to a board can be sent to the PCB room: its agent fetches it and converts the board with it.' | t }}</p>
  </aside>

  <!-- RIGHT: drop, and the list -->
  <section class="tcv-notes-main">
    @if (auth.can('draw')) {
      <label class="tcv-files-drop" [attr.data-over]="over() ? 1 : null"
             (dragover)="$event.preventDefault(); over.set(true)" (dragleave)="over.set(false)"
             (drop)="drop($event)">
        <input type="file" multiple hidden (change)="pick($event)">
        @if (progress() === null) {
          <b>{{ 'Drop files here, or click to choose' | t }}</b>
          <span>{{ 'BOM, pick and place, datasheets, photos, STEP - up to 200 MB each' | t }}</span>
        } @else {
          <b>{{ 'Uploading…' | t }} {{ progress() }}%</b>
          <span class="tcv-files-bar"><i [style.width.%]="progress()"></i></span>
        }
      </label>
      <div class="tcv-files-opts">
        <span>{{ 'Link to' | t }}</span>
        <select class="tcv-files-select" [value]="linkTo()" (change)="linkTo.set($any($event.target).value)">
          <option value="">{{ '(no board)' | t }}</option>
          @for (b of boards(); track b._id) {
            <option [value]="b._id" [selected]="b._id === linkTo()">{{ b.title || b._id }}</option>
          }
        </select>
        <input class="tcv-files-note" [placeholder]="'A line about it (optional)' | t" [value]="note()"
               (input)="note.set($any($event.target).value)">
      </div>
      @if (error(); as e) { <p class="tcv-files-error">{{ e }}</p> }
    }

    <div class="tcv-files-list">
      @for (f of shown(); track f.id) {
        <div class="tcv-files-row" [attr.data-on]="picked.file()?.id === f.id ? 1 : null" (click)="pickFile(f, $event)">
          <span class="tcv-files-icon" [attr.data-kind]="f.kind" [title]="kindLabel(f.kind) | t">{{ icon(f.kind) }}</span>
          <div class="tcv-files-body">
            <div class="tcv-files-top">
              <a class="tcv-files-name" [href]="'/api/files/' + f.id" [attr.download]="f.name" [title]="'Download' | t">{{ f.name }}</a>
              <span class="tcv-files-kind" [attr.data-kind]="f.kind">{{ kindLabel(f.kind) | t }}</span>
            </div>
            <div class="tcv-files-meta">
              <span>{{ size(f.bytes) }}</span>
              <span>{{ f.by.name || ('someone' | t) }} · {{ when(f.created_at) }}</span>
              @if (f.context.board) { <span class="tcv-files-at">&#64;{{ f.context.board }}</span> }
              @else if (f.context.model) { <span class="tcv-files-at">&#64;{{ f.context.model }}</span> }
              @if (f.sent) { <span [title]="'Sent to the agent' | t">→ {{ roomLabel(f.sent.room) | t }}</span> }
            </div>
            @if (f.note) { <div class="tcv-files-notetext">{{ f.note }}</div> }
          </div>
          <div class="tcv-files-actions">
            @if (viewable(f)) {
              <a class="tcv-btn tcv-files-btn" [href]="'/api/files/' + f.id + '?inline=true'" target="_blank" rel="noopener">{{ 'Open' | t }}</a>
            }
            <a class="tcv-btn tcv-files-btn" [href]="'/api/files/' + f.id" [attr.download]="f.name">{{ 'Download' | t }}</a>
            @if (auth.can('edit') && (f.kind === 'step' || f.kind === 'mesh')) {
              <button class="tcv-btn tcv-files-btn" (click)="startAdd(f)"
                      [title]="'Copy it into a project folder as a 3D model - it stays there even if this file is deleted' | t">{{ 'Add to project' | t }}</button>
            }
            @if (auth.can('draw')) {
              <select class="tcv-files-select tcv-files-send" (change)="send(f, $any($event.target)); "
                      [title]="'Put a line in a room\\'s thread: what the file is and how to fetch it' | t">
                <option value="">{{ 'Send to agent…' | t }}</option>
                @for (r of rooms; track r) {
                  <option [value]="r">{{ roomLabel(r) | t }}{{ r === suggest(f) ? ' ★' : '' }}</option>
                }
              </select>
              <button class="tcv-btn tcv-files-btn tcv-files-del" (click)="remove(f)" [title]="'Delete' | t">✕</button>
            }
          </div>
          @if (adding()?.id === f.id) {
              <div class="tcv-files-add">
                <label>{{ 'Folder' | t }}
                  <select class="tcv-files-select" [value]="adding()!.folder" (change)="setAdd('folder', $any($event.target).value)">
                    @for (p of folders(); track p) { <option [value]="p" [selected]="p === adding()!.folder">{{ p }}</option> }
                  </select></label>
                <label>{{ 'Name' | t }}
                  <input class="tcv-files-input" [value]="adding()!.title" (input)="setAdd('title', $any($event.target).value)"></label>
                <span class="tcv-files-add-acts">
                  <button class="tcv-btn tcv-files-btn" (click)="adding.set(null)">{{ 'Cancel' | t }}</button>
                  <button class="tcv-btn tcv-btn-accent tcv-files-btn" [disabled]="busyAdd() || !adding()!.folder" (click)="add(f)">{{ busyAdd() ? '…' : ('Add' | t) }}</button>
                </span>
              </div>
            }
        </div>
      } @empty {
        <p class="tcv-notes-empty">{{ q() || kind() || board() ? ('Nothing matches.' | t) : ('No files yet - drop the first one above.' | t) }}</p>
      }
    </div>
    @if (flash(); as m) { <p class="tcv-files-flash">{{ m }}</p> }
  </section>
</div>`,
})
export class RoomFiles {
  private api = inject(FilesApi);
  picked = inject(Selection);
  auth = inject(Auth);

  /** A row clicked (not on its links or buttons) is the file the command
   *  palette offers to ask Command Code about. */
  pickFile(f: StoredFile, e: Event) {
    if ((e.target as HTMLElement).closest('a, button, select, input')) return;
    this.picked.file.set(this.picked.file()?.id === f.id ? null : { id: f.id, label: f.name });
  }

  readonly rooms = AGENT_ROOMS;
  private catalog = inject(Catalog);
  /** The "Add to project" form open under a file: where, under what name. */
  adding = signal<{ id: string; folder: string; title: string } | null>(null);
  busyAdd = signal(false);
  folders = signal<string[]>([]);
  q = signal('');
  kind = signal('');
  board = signal('');
  note = signal('');
  over = signal(false);
  progress = signal<number | null>(null);
  error = signal<string | null>(null);
  flash = signal<string | null>(null);
  all = signal<StoredFile[]>([]);
  boards = signal<{ _id: string; title?: string }[]>([]);
  /** Which board a new file goes with: the one last open in the PCB room. */
  linkTo = signal<string>(this.picked.board() ?? '');

  kinds = computed(() => {
    const n = new Map<string, number>();
    for (const f of this.all()) n.set(f.kind, (n.get(f.kind) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([kind, c]) => ({ kind, n: c }));
  });
  boardsUsed = computed(() => [...new Set(this.all().map(f => f.context.board).filter((b): b is string => !!b))].sort());
  shown = computed(() => {
    const q = this.q().trim().toLowerCase(), k = this.kind(), b = this.board();
    return this.all().filter(f => (!k || f.kind === k) && (!b || f.context.board === b)
      && (!q || f.name.toLowerCase().includes(q) || (f.note || '').toLowerCase().includes(q)));
  });

  constructor() {
    effect(() => {
      this.api.changed();
      untracked(() => this.load());
    });
    this.api.boards().subscribe({ next: b => this.boards.set(b), error: () => {} });
  }

  load() {
    this.api.list('', '', '').subscribe({ next: rows => this.all.set(rows), error: () => {} });
  }

  drop(e: DragEvent) {
    e.preventDefault();
    this.over.set(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) this.upload(files);
  }

  pick(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) this.upload(files);
  }

  upload(files: File[]) {
    if (this.progress() !== null) return;
    this.error.set(null);
    this.progress.set(0);
    const ctx = { room: this.linkTo() ? 'pcb' : 'files', ...(this.linkTo() ? { board: this.linkTo() } : {}) };
    this.api.upload(files, ctx, this.note().trim()).subscribe({
      next: ev => {
        if (ev.type === HttpEventType.UploadProgress && ev.total) {
          this.progress.set(Math.round(100 * ev.loaded / ev.total));
        } else if (ev.type === HttpEventType.Response) {
          this.progress.set(null);
          this.note.set('');
          const got = ev.body ?? [];
          this.say(`${t('Kept')}: ${got.map(f => `${f.name} (${t(this.kindLabel(f.kind))})`).join(', ')}`);
          this.api.changed.update(v => v + 1);
        }
      },
      error: err => {
        this.progress.set(null);
        this.error.set(typeof err?.error?.detail === 'string' ? err.error.detail : t('The upload failed.'));
      },
    });
  }

  send(f: StoredFile, el: HTMLSelectElement) {
    const room = el.value;
    el.value = '';
    if (!room) return;
    this.api.send(f.id, room).subscribe({
      next: () => { this.say(`${t('Sent to')} ${t(this.roomLabel(room))}: ${f.name}`); this.load(); },
      error: err => this.error.set(typeof err?.error?.detail === 'string' ? err.error.detail : t('Could not send it.')),
    });
  }

  startAdd(f: StoredFile) {
    const title = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
    this.adding.set({ id: f.id, folder: '', title });
    this.catalog.tree().subscribe({
      next: tree => {
        const out: string[] = [];
        const walk = (n: FolderNode) => { if (n.path) out.push(n.path); n.folders.forEach(walk); };
        walk(tree);
        this.folders.set(out);
        // A purchased part most likely; else the first folder.
        const pick = out.find(p => /purchased$/.test(p)) ?? out[0] ?? '';
        this.adding.update(a => a && !a.folder ? { ...a, folder: pick } : a);
      },
      error: () => this.error.set(t('The folders did not load.')),
    });
  }
  setAdd(k: 'folder' | 'title', v: string) { this.adding.update(a => a ? { ...a, [k]: v } : a); }
  add(f: StoredFile) {
    const a = this.adding();
    if (!a) return;
    this.busyAdd.set(true);
    this.api.toModel(f.id, a.folder, a.title).subscribe({
      next: r => {
        this.busyAdd.set(false);
        this.adding.set(null);
        this.say(`${t('Added to')} ${a.folder}: ${r.title} - ${t('building it now')}`);
        this.picked.room.set('cad');
        this.picked.ask('model', r.model);
      },
      error: err => {
        this.busyAdd.set(false);
        this.error.set(typeof err?.error?.detail === 'string' ? err.error.detail : t('Could not add it.'));
      },
    });
  }

  remove(f: StoredFile) {
    if (!confirm(`${t('Delete')} ${f.name}?`)) return;
    this.api.remove(f.id).subscribe({
      next: () => this.api.changed.update(v => v + 1),
      error: err => this.error.set(typeof err?.error?.detail === 'string' ? err.error.detail : t('Could not delete it.')),
    });
  }

  /** The room whose agent this file is most likely for. */
  suggest(f: StoredFile): string {
    if (f.context.board || ['bom', 'pick-place', 'gerber', 'drill'].includes(f.kind)) return 'pcb';
    if (f.context.model || ['step', 'mesh'].includes(f.kind)) return 'cad';
    return f.context.room && AGENT_ROOMS.includes(f.context.room) ? f.context.room : '';
  }

  viewable(f: StoredFile) { return ['image', 'pdf', 'text'].includes(f.kind) || f.content_type.startsWith('image/'); }
  icon(k: string) { return KIND_ICON[k] ?? KIND_ICON['other']; }
  kindLabel(k: string) { return KIND_LABEL[k] ?? k; }
  roomLabel(r: string) { return ROOM_LABEL[r] ?? r; }

  size(b: number) {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} kB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  }

  when(iso: string) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return t('just now');
    if (s < 3600) return `${Math.floor(s / 60)} ${t('min ago')}`;
    if (s < 86400) return `${Math.floor(s / 3600)} ${t('h ago')}`;
    return new Date(iso).toLocaleDateString();
  }

  private say(m: string) {
    this.flash.set(m);
    setTimeout(() => this.flash.set(null), 5000);
  }
}
