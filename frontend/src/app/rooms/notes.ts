import {
  Component, ElementRef, Injectable, OnDestroy, computed, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { toHtml } from '../markdown';
import { Selection } from '../selection';
import { Auth } from '../auth';
import { T } from '../i18n';

/** Notes: what you jot down while working, without a form to fill.
 *
 *  Write, press Enter, and it is kept. The first line is the title,
 *  `#words` are tags, `@names` point at models and boards, `- [ ]` lines
 *  are to-dos you can tick. Where you were - the room, the model or board
 *  open there - comes along by itself. Alt+N opens a small box for a note
 *  from anywhere in the app, and you stay where you were. A note can be
 *  handed to a room's agent as a message in its thread. The text is the
 *  note; everything else is read out of it (backend/notes.py).
 */
export interface Note {
  id: string; text: string; title: string; tags: string[]; mentions: string[];
  todo: { open: number; done: number };
  context: { room?: string; model?: string; board?: string; app?: string };
  pinned: boolean; by: { name?: string; id?: string };
  created_at: string; updated_at: string;
  sent?: { room: string; at: string };
}

const ROOM_NAMES: Record<string, string> = {
  cad: '3D Drawing', pcb: 'PCB Design', embedded: 'Embedded', web: 'Web', mobile: 'Mobile',
  notes: 'Notes', tools: 'Tools', analyze: 'Analytics',
};
export const AGENT_ROOMS = ['cad', 'pcb', 'embedded', 'web', 'mobile'];

@Injectable({ providedIn: 'root' })
export class NotesApi {
  private http = inject(HttpClient);
  private picked = inject(Selection);
  /** Bumped whenever a note is written anywhere, so lists read again. */
  changed = signal(0);
  /** The box for a quick note, over whatever room is on screen. */
  quick = signal(false);

  list(q: string, tag: string, only: string) {
    const p = new URLSearchParams({ q, tag, only });
    return this.http.get<Note[]>(`/api/notes?${p}`);
  }
  tags() { return this.http.get<{ tag: string; n: number }[]>('/api/notes/tags'); }
  update(id: string, patch: { text?: string; pinned?: boolean }) {
    return this.http.patch<Note>(`/api/notes/${id}`, patch);
  }
  remove(id: string) { return this.http.delete(`/api/notes/${id}`); }
  send(id: string, room: string) { return this.http.post(`/api/notes/${id}/send`, { room }); }

  /** Where the person is: the room, and what is open in it. */
  context() {
    const room = this.picked.room();
    return {
      room,
      ...(room === 'cad' && this.picked.model() ? { model: this.picked.model()! } : {}),
      ...(room === 'pcb' && this.picked.board() ? { board: this.picked.board()! } : {}),
      ...(['web', 'embedded', 'mobile'].includes(room) && this.picked.app() ? { app: this.picked.app()! } : {}),
    };
  }

  create(text: string, context = this.context()) {
    return this.http.post<Note>('/api/notes', { text, context });
  }
}

/** A note's text as blocks: to-do lines on their own (so they can be
 *  ticked), the rest as markdown. */
type Block = { kind: 'todo'; line: number; done: boolean; html: string } | { kind: 'md'; html: string };

function blocks(text: string): Block[] {
  const out: Block[] = [];
  let buf: string[] = [];
  const flush = () => { if (buf.join('').trim()) out.push({ kind: 'md', html: decorate(toHtml(buf.join('\n'))) }); buf = []; };
  text.split('\n').forEach((l, i) => {
    const m = /^\s*[-*] \[( |x|X)\]\s(.*)$/.exec(l);
    if (m) { flush(); out.push({ kind: 'todo', line: i, done: m[1] !== ' ', html: decorate(toHtml(m[2])) }); }
    else buf.push(l);
  });
  flush();
  return out;
}

/** #tags and @names made visible (and clickable) in rendered text. Only
 *  outside tags, so an attribute or a colour code is left alone. */
function decorate(html: string): string {
  return html.split(/(<[^>]+>)/).map(part => part.startsWith('<') ? part : part
    .replace(/(^|[\s(>])#([^\W\d_][\w-]*)/gu, (m, pre, t) =>
      /^[0-9a-f]{3,8}$/i.test(t) && /\d/.test(t) ? m : `${pre}<span class="tcv-note-tag">#${t}</span>`)
    .replace(/(^|[\s(>])@([\w][\w\-./]*)/gu, '$1<span class="tcv-note-at">@$2</span>')).join('');
}

function when(iso: string): string {
  const d = new Date(iso), now = new Date();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 0) return hm;
  if (days === 1) return `yesterday ${hm}`;
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function group(iso: string): string {
  const d = new Date(iso), now = new Date();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'This week' : days < 31 ? 'This month' : 'Earlier';
}

/** Speech to text, where the browser has it (Chrome, on localhost or
 *  HTTPS). The words land where the caret is. */
class Dictation {
  on = signal(false);
  readonly supported = !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  private rec: any = null;

  toggle(write: (text: string) => void) {
    if (this.on()) { this.rec?.stop(); return; }
    const R = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!R) return;
    this.rec = new R();
    this.rec.lang = navigator.language || 'en-US';
    this.rec.continuous = true;
    this.rec.interimResults = false;
    this.rec.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) write(e.results[i][0].transcript.trim());
      }
    };
    this.rec.onend = () => this.on.set(false);
    this.rec.onerror = () => this.on.set(false);
    this.rec.start();
    this.on.set(true);
  }
}

/** The box a note is written in - the room's, and the quick one. Enter
 *  keeps it (Shift+Enter for a new line), and the box is ready again. */
@Component({
  selector: 'app-note-compose',
  imports: [T],
  template: `
<div class="tcv-note-compose" [attr.data-focus]="focused() ? 1 : null">
  <textarea #box rows="1" [value]="text()" [placeholder]="placeholder | t"
            (input)="text.set($any($event.target).value); grow()"
            (focus)="focused.set(true)" (blur)="focused.set(false)"
            (keydown)="key($event)"></textarea>
  <div class="tcv-note-compose-bar">
    <span class="tcv-note-hint">{{ hint() | t }}</span>
    <span class="grow"></span>
    @if (dict.supported) {
      <button class="tcv-note-icon" [attr.data-on]="dict.on() ? 1 : null" (click)="dictate()"
              [title]="dict.on() ? 'Stop listening' : 'Speak the note'" aria-label="Dictate">🎙</button>
    }
    <button class="tcv-btn tcv-note-keep" [disabled]="!text().trim() || busy()" (click)="keep()">
      {{ busy() ? '…' : ('Keep' | t) }} <kbd>↵</kbd></button>
  </div>
</div>`,
})
export class NoteCompose {
  private api = inject(NotesApi);
  private box = viewChild.required<ElementRef<HTMLTextAreaElement>>('box');
  text = signal('');
  busy = signal(false);
  focused = signal(false);
  dict = new Dictation();
  /** Set by the owner: called with the note once it is kept. */
  kept: (n: Note) => void = () => {};
  readonly placeholder = 'Just write. First line is the title - #tags, @controller, - [ ] to-dos…';

  hint = computed(() => {
    const c = this.api.context();
    const at = c.model ?? c.board ?? c.app;
    return at ? `kept with ${at} (${ROOM_NAMES[c.room] ?? c.room})` : `Enter keeps it · Shift+Enter new line`;
  });

  focus() { setTimeout(() => this.box().nativeElement.focus()); }

  grow() {
    const t = this.box().nativeElement;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 320) + 'px';
  }

  key(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.keep(); }
  }

  dictate() {
    this.dict.toggle(words => {
      const cur = this.text();
      this.text.set(cur ? `${cur}${/\s$/.test(cur) ? '' : ' '}${words}` : words);
      this.box().nativeElement.value = this.text();
      this.grow();
    });
  }

  keep() {
    const text = this.text().trim();
    if (!text || this.busy()) return;
    this.busy.set(true);
    this.api.create(text).subscribe({
      next: n => {
        this.busy.set(false);
        this.text.set('');
        this.box().nativeElement.value = '';
        this.grow();
        this.api.changed.update(v => v + 1);
        this.kept(n);
      },
      error: () => this.busy.set(false),
    });
  }
}

/** Alt+N, anywhere: a small box over the room, and back to work. */
@Component({
  selector: 'app-quick-note',
  imports: [NoteCompose, T],
  template: `
@if (api.quick()) {
  <div class="tcv-quick-back" (click)="api.quick.set(false)">
    <div class="tcv-quick" (click)="$event.stopPropagation()" role="dialog" aria-label="Quick note">
      <div class="tcv-quick-head"><b>{{ 'Quick note' | t }}</b><span>{{ 'Esc to close · it is kept in Notes' | t }}</span></div>
      <app-note-compose #c />
      @if (last(); as l) { <p class="tcv-quick-kept">Kept: {{ l }}</p> }
    </div>
  </div>
}`,
})
export class QuickNote {
  api = inject(NotesApi);
  private auth = inject(Auth);
  private compose = viewChild<NoteCompose>('c');
  last = signal<string | null>(null);

  constructor() {
    effect(() => {
      const c = this.compose();
      if (!c) return;
      c.kept = n => { this.last.set(n.title || n.text.slice(0, 60)); setTimeout(() => this.api.quick.set(false), 700); };
      untracked(() => c.focus());
    });
    // Before the code editor or any room can take it.
    window.addEventListener('keydown', e => this.key(e), true);
  }

  key(e: KeyboardEvent) {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'n' || e.key === 'N' || e.code === 'KeyN')) {
      if (!this.auth.signedIn() || !this.auth.can('draw')) return;
      e.preventDefault();
      this.last.set(null);
      this.api.quick.set(!this.api.quick());
    } else if (e.key === 'Escape' && this.api.quick()) {
      this.api.quick.set(false);
    }
  }
}

/** The Notes room. */
@Component({
  selector: 'app-room-notes',
  imports: [NoteCompose, T],
  host: { '(document:keydown)': 'key($event)' },
  template: `
<div class="tcv-room absolute inset-0 flex min-h-0 gap-1 p-1">
  <!-- LEFT: find a note -->
  <aside class="tcv-notes-side">
    <div class="tcv-notes-find">
      <input #search class="tcv-notes-search" [placeholder]="'Search notes   /' | t" [value]="q()"
             (input)="q.set($any($event.target).value)" (keydown.escape)="q.set(''); $any($event.target).blur()">
    </div>
    <div class="tcv-notes-filters">
      @for (f of filters; track f.id) {
        <button class="tcv-notes-chip" [attr.data-on]="only() === f.id ? 1 : null" (click)="only.set(f.id)">
          {{ f.label | t }}</button>
      }
    </div>
    @if (tags().length) {
      <div class="tcv-notes-filters">
        @for (t of tags(); track t.tag) {
          <button class="tcv-notes-chip tcv-notes-tagchip" [attr.data-on]="tag() === t.tag ? 1 : null"
                  (click)="tag.set(tag() === t.tag ? '' : t.tag)">#{{ t.tag }} <em>{{ t.n }}</em></button>
        }
      </div>
    }
    <div class="tcv-notes-list">
      @for (g of groups(); track g.name) {
        <div class="tcv-notes-group">{{ g.name | t }}</div>
        @for (n of g.notes; track n.id) {
          <button class="tcv-notes-item" [attr.data-on]="n.id === openId() ? 1 : null" (click)="openId.set(n.id)">
            <span class="tcv-notes-item-top">
              @if (n.pinned) { <span class="tcv-notes-pin" title="Pinned">●</span> }
              <span class="tcv-notes-item-title">{{ n.title || ('Untitled' | t) }}</span>
              <span class="tcv-notes-item-when">{{ when(n.updated_at) }}</span>
            </span>
            <span class="tcv-notes-item-snip">{{ snippet(n) }}</span>
            <span class="tcv-notes-item-meta">
              @if (n.todo.open + n.todo.done) {
                <span [attr.data-done]="!n.todo.open ? 1 : null">☑ {{ n.todo.done }}/{{ n.todo.open + n.todo.done }}</span>
              }
              @if (n.context.room) { <span>{{ roomName(n.context.room) }}</span> }
              @for (t of n.tags.slice(0, 3); track t) { <span class="tcv-note-tag">#{{ t }}</span> }
              @if (n.sent) { <span title="Sent to the agent">→ agent</span> }
            </span>
          </button>
        }
      } @empty {
        <p class="tcv-notes-empty">{{ q() || tag() || only() ? 'Nothing matches.' : 'No notes yet - write the first one on the right, or press Alt+N anywhere.' }}</p>
      }
    </div>
  </aside>

  <!-- RIGHT: write, and read one -->
  <section class="tcv-notes-main">
    <app-note-compose #compose />

    @if (open(); as n) {
      <article class="tcv-note">
        <header class="tcv-note-head">
          <span class="tcv-note-meta">
            {{ n.by.name || 'someone' }} · {{ when(n.created_at) }}
            @if (n.updated_at !== n.created_at) { · edited {{ when(n.updated_at) }} }
            @if (n.context.room) {
              · <button class="tcv-note-ctx" (click)="goTo(n)" title="Go back to where it was written">
                {{ roomName(n.context.room) }}{{ n.context.model || n.context.board || n.context.app ? ': ' + (n.context.model || n.context.board || n.context.app) : '' }}</button>
            }
            @if (n.sent) { · sent to the {{ roomName(n.sent.room) }} agent }
          </span>
          <span class="grow"></span>
          @if (saving()) { <span class="tcv-note-meta">saving…</span> }
          <button class="tcv-note-icon" [attr.data-on]="n.pinned ? 1 : null" (click)="pin(n)"
                  [title]="n.pinned ? 'Unpin' : 'Pin to the top'">📌</button>
          <button class="tcv-btn tcv-note-btn" (click)="editing() ? done() : edit(n)">{{ (editing() ? 'Done' : 'Edit') | t }}</button>
          <select class="tcv-note-send" (change)="send(n, $any($event.target).value); $any($event.target).value = ''"
                  title="Hand this note to a room's agent">
            <option value="">{{ 'Send to agent…' | t }}</option>
            @for (r of agentRooms; track r) { <option [value]="r">{{ roomName(r) }}</option> }
          </select>
          <button class="tcv-btn tcv-note-btn" (click)="copy(n)">{{ (copied() ? 'Copied' : 'Copy') | t }}</button>
          <button class="tcv-btn tcv-note-btn" (click)="remove(n)">{{ 'Delete' | t }}</button>
        </header>
        @if (flash(); as f) { <p class="tcv-note-flash">{{ f }}</p> }
        @if (editing()) {
          <textarea #editor class="tcv-note-edit" [value]="draft()" (input)="typed($any($event.target).value)"
                    (keydown.escape)="done()" (keydown.control.enter)="done()"></textarea>
          <p class="tcv-note-meta">Saved as you type · Esc or Ctrl+Enter when done</p>
        } @else {
          <div class="tcv-note-body" (dblclick)="edit(n)" (click)="clickBody($event)">
            @for (b of body(); track $index) {
              @if (b.kind === 'todo') {
                <label class="tcv-note-todo" [attr.data-done]="b.done ? 1 : null">
                  <input type="checkbox" [checked]="b.done" (change)="tick(n, b.line)">
                  <span class="md" [innerHTML]="b.html"></span>
                </label>
              } @else {
                <div class="md" [innerHTML]="b.html"></div>
              }
            }
          </div>
        }
      </article>
    } @else {
      <div class="tcv-notes-tips">
        <p><b>Writing a note should take no time.</b> Type and press Enter - no title, folder or form.</p>
        <ul>
          <li><b>Alt+N</b> anywhere in Redline opens a small box; you stay where you are, and the note remembers the room and what was open.</li>
          <li><code>#tag</code> to find it later, <code>&#64;controller</code> to point at a board or model.</li>
          <li><code>- [ ] check the fan clearance</code> becomes a box to tick; <b>To-do</b> collects the open ones.</li>
          <li>🎙 to speak it instead (where the browser can listen).</li>
          <li><b>Send to agent</b> hands a note to a room's agent as a message.</li>
        </ul>
      </div>
    }
  </section>
</div>`,
})
export class RoomNotes implements OnDestroy {
  private api = inject(NotesApi);
  private picked = inject(Selection);
  private compose = viewChild.required<NoteCompose>('compose');
  private search = viewChild.required<ElementRef<HTMLInputElement>>('search');
  private editor = viewChild<ElementRef<HTMLTextAreaElement>>('editor');

  readonly filters = [{ id: '', label: 'All' }, { id: 'pinned', label: 'Pinned' },
                      { id: 'todo', label: 'To-do' }, { id: 'mine', label: 'Mine' }];
  readonly agentRooms = AGENT_ROOMS;
  q = signal('');
  tag = signal('');
  only = signal('');
  notes = signal<Note[]>([]);
  tags = signal<{ tag: string; n: number }[]>([]);
  openId = signal<string | null>(null);
  editing = signal(false);
  draft = signal('');
  saving = signal(false);
  copied = signal(false);
  flash = signal<string | null>(null);
  private saveTimer?: ReturnType<typeof setTimeout>;
  /** The note the editor holds - not always the one now open. */
  private editingId: string | null = null;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private poll = setInterval(() => this.read(), 15_000);

  open = computed(() => this.notes().find(n => n.id === this.openId()) ?? null);
  body = computed(() => blocks(this.open()?.text ?? ''));
  groups = computed(() => {
    const out: { name: string; notes: Note[] }[] = [];
    const pinned = this.notes().filter(n => n.pinned);
    if (pinned.length) out.push({ name: 'Pinned', notes: pinned });
    for (const n of this.notes().filter(x => !x.pinned)) {
      const g = group(n.updated_at);
      if (out.at(-1)?.name !== g) out.push({ name: g, notes: [] });
      out.at(-1)!.notes.push(n);
    }
    return out;
  });

  constructor() {
    // Read again when the search, the filters or any note changes.
    effect(() => {
      this.q(); this.tag(); this.only(); this.api.changed();
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => untracked(() => this.read()), 150);
    });
    effect(() => {
      const c = this.compose();
      c.kept = n => this.openId.set(n.id);
      untracked(() => c.focus());
    });
    // A note picked in the command palette.
    effect(() => {
      const w = this.picked.want();
      if (w?.what === 'note' && w.arg) untracked(() => {
        this.picked.want.set(null);
        this.q.set(''); this.tag.set(''); this.only.set(''); this.openId.set(w.arg!);
      });
    });
    // Leaving a note mid-edit keeps what was typed.
    effect(() => { this.openId(); untracked(() => this.done()); });
  }

  private read() {
    this.api.list(this.q(), this.tag(), this.only()).subscribe(ns => {
      // A note being edited here keeps the text typed into it.
      const ed = this.editing() ? this.editingId : null;
      this.notes.set(ed ? ns.map(n => n.id === ed ? { ...n, text: this.draft() } : n) : ns);
      if (!this.openId() && ns.length && !this.q()) this.openId.set(ns[0].id);
    });
    this.api.tags().subscribe(t => this.tags.set(t));
  }

  when = when;
  roomName(r: string) { return ROOM_NAMES[r] ?? r; }
  snippet(n: Note) {
    const rest = n.text.split('\n').slice(1).join(' ').replace(/[-*] \[[ xX]\]|[#>*_`]/g, ' ').replace(/\s+/g, ' ').trim();
    return rest.slice(0, 110);
  }

  edit(n: Note) {
    this.editingId = n.id;
    this.draft.set(n.text);
    this.editing.set(true);
    setTimeout(() => {
      const t = this.editor()?.nativeElement;
      if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
    });
  }

  typed(text: string) {
    this.draft.set(text);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveDraft(), 700);
  }

  private saveDraft(then?: () => void) {
    const id = this.editingId, text = this.draft();
    const cur = this.notes().find(n => n.id === id);
    if (!id || !cur || !text.trim() || text === cur.text) { then?.(); return; }
    this.saving.set(true);
    this.api.update(id, { text }).subscribe({
      next: n => { this.saving.set(false); this.replace(n); then?.(); },
      error: () => { this.saving.set(false); then?.(); },
    });
  }

  done() {
    if (!this.editing()) return;
    clearTimeout(this.saveTimer);
    this.saveDraft(() => this.api.tags().subscribe(t => this.tags.set(t)));
    this.editing.set(false);
    this.editingId = null;
  }

  private replace(n: Note) { this.notes.set(this.notes().map(x => x.id === n.id ? n : x)); }

  /** Ticking a box rewrites that one line of the text. */
  tick(n: Note, line: number) {
    const lines = n.text.split('\n');
    lines[line] = lines[line].replace(/\[( |x|X)\]/, m => m === '[ ]' ? '[x]' : '[ ]');
    const text = lines.join('\n');
    this.replace({ ...n, text });
    this.api.update(n.id, { text }).subscribe(r => this.replace(r));
  }

  pin(n: Note) { this.api.update(n.id, { pinned: !n.pinned }).subscribe(() => this.read()); }

  send(n: Note, room: string) {
    if (!room) return;
    this.api.send(n.id, room).subscribe({
      next: () => { this.say(`Sent to the ${this.roomName(room)} agent - it is in that room's thread.`); this.read(); },
      error: (e: HttpErrorResponse) => this.say(typeof e.error?.detail === 'string' ? e.error.detail : 'could not send it'),
    });
  }

  copy(n: Note) {
    navigator.clipboard?.writeText(n.text).then(() => { this.copied.set(true); setTimeout(() => this.copied.set(false), 1500); });
  }

  remove(n: Note) {
    if (!confirm(`Delete "${n.title || 'this note'}"?`)) return;
    this.api.remove(n.id).subscribe({
      next: () => { this.openId.set(null); this.read(); },
      error: (e: HttpErrorResponse) => this.say(typeof e.error?.detail === 'string' ? e.error.detail : 'could not delete it'),
    });
  }

  /** A #tag in the text filters by it. */
  clickBody(e: MouseEvent) {
    const el = e.target as HTMLElement;
    if (el.classList.contains('tcv-note-tag')) this.tag.set(el.textContent!.replace('#', '').toLowerCase());
  }

  /** Back to the room (and board) the note was written in. */
  goTo(n: Note) {
    const r = n.context.room as any;
    if (!r) return;
    if (r === 'pcb' && n.context.board) this.picked.openBoard(n.context.board);
    else this.picked.room.set(r);
  }

  private say(msg: string) { this.flash.set(msg); setTimeout(() => this.flash.set(null), 4000); }

  key(e: KeyboardEvent) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); this.search().nativeElement.focus(); }
    if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const list = this.notes(), i = list.findIndex(n => n.id === this.openId());
      const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { e.preventDefault(); this.openId.set(next.id); }
    }
  }

  ngOnDestroy() { clearInterval(this.poll); clearTimeout(this.saveTimer); this.done(); }
}
